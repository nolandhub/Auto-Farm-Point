import assert from 'node:assert/strict'
import test from 'node:test'

import { cookieHeader, pageUrl, RewardsReader } from './rewardsReader.js'

const NOW_MS = Date.UTC(2026, 8, 30, 3, 0, 0)
const cookie = (name, domain, extra = {}) => ({ name, value: `${name}-v`, domain, path: '/', expires: -1, ...extra })
const SESSION = {
    storageState: {
        cookies: [
            cookie('_U', '.bing.com'),
            cookie('MUID', 'www.bing.com'),
            cookie('rwd', 'rewards.bing.com'),
            cookie('MSPAuth', '.live.com'),
            cookie('old', '.bing.com', { expires: NOW_MS / 1000 - 60 })
        ]
    },
    fingerprint: { fingerprint: { navigator: { userAgent: 'UA-from-fingerprint' } } }
}

function response(status, { body = '', location } = {}) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => (name.toLowerCase() === 'location' ? (location ?? null) : null) },
        text: async () => body
    }
}

function setup({ session = SESSION, reply = () => response(200, { body: '{"ok":1}' }) } = {}) {
    const calls = []
    let now = NOW_MS
    const reader = new RewardsReader({
        loadSession: () => session,
        fetch: async (url, init) => {
            calls.push({ url, init })
            return reply(url, calls.length)
        },
        now: () => now
    })
    return { reader, calls, advance: ms => (now += ms) }
}

test('only the flyout, the earn page and quest pages can be read', () => {
    assert.equal(
        pageUrl('flyout'),
        'https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards'
    )
    assert.equal(pageUrl('earn'), 'https://rewards.bing.com/earn')
    assert.equal(
        pageUrl('quest', 'ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard'),
        'https://rewards.bing.com/earn/quest/ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard'
    )
    for (const [page, id] of [['search'], ['quest'], ['quest', '../../account'], ['quest', 'a/b'], [undefined]]) {
        assert.throws(() => pageUrl(page, id), { code: 'BAD_REQUEST' })
    }
})

test('sends only the cookies of the host it calls, and none that expired', () => {
    const cookies = SESSION.storageState.cookies
    assert.equal(cookieHeader(cookies, 'https://www.bing.com/rewards/x', NOW_MS / 1000), '_U=_U-v; MUID=MUID-v')
    assert.equal(cookieHeader(cookies, 'https://rewards.bing.com/earn', NOW_MS / 1000), '_U=_U-v; rwd=rwd-v')
    assert.equal(cookieHeader(cookies, 'https://login.live.com/login.srf', NOW_MS / 1000), 'MSPAuth=MSPAuth-v')
})

test('reads a page with the account session and its fingerprint user agent', async () => {
    const { reader, calls } = setup()
    const page = await reader.read('me@example.com', 'flyout')
    assert.deepEqual(page, {
        ok: true,
        status: 200,
        url: 'https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards',
        body: '{"ok":1}'
    })
    assert.equal(calls[0].init.headers.cookie, '_U=_U-v; MUID=MUID-v')
    assert.equal(calls[0].init.headers['user-agent'], 'UA-from-fingerprint')
    assert.equal(calls[0].init.redirect, 'manual')
})

test('follows redirects itself, with the cookies of each new host', async () => {
    const { reader, calls } = setup({
        reply: (url, n) =>
            n === 1
                ? response(302, { location: 'https://login.live.com/login.srf?x=1' })
                : response(200, { body: 'login' })
    })
    const page = await reader.read('me@example.com', 'earn')
    assert.equal(page.url, 'https://login.live.com/login.srf?x=1')
    assert.equal(calls[1].init.headers.cookie, 'MSPAuth=MSPAuth-v')
})

test('gives up after five redirects', async () => {
    const { reader } = setup({ reply: () => response(302, { location: '/earn' }) })
    await assert.rejects(reader.read('me@example.com', 'earn'), { code: 'UPSTREAM' })
})

test('an account without a saved session says so', async () => {
    const { reader, calls } = setup({ session: null })
    await assert.rejects(reader.read('me@example.com', 'flyout'), { code: 'NO_SESSION' })
    assert.equal(calls.length, 0)
})

test('a page read in the last minute comes from the cache; the earn page keeps five minutes', async () => {
    const { reader, calls, advance } = setup()
    await reader.read('me@example.com', 'flyout')
    await reader.read('me@example.com', 'earn')
    advance(59_000)
    await reader.read('me@example.com', 'flyout')
    assert.equal(calls.length, 2)
    advance(2_000)
    await reader.read('me@example.com', 'flyout')
    await reader.read('me@example.com', 'earn')
    assert.equal(calls.length, 3)
    await reader.read('other@example.com', 'flyout')
    assert.equal(calls.length, 4)
})

test('a failed read is not cached', async () => {
    const { reader, calls } = setup({ reply: (url, n) => response(n === 1 ? 500 : 200) })
    assert.equal((await reader.read('me@example.com', 'flyout')).ok, false)
    assert.equal((await reader.read('me@example.com', 'flyout')).ok, true)
    assert.equal(calls.length, 2)
})
