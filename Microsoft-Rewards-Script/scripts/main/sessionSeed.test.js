import assert from 'node:assert/strict'
import test from 'node:test'

import { signInCookies } from './sessionSeed.js'

const cookie = (domain, name) => ({ domain, name, value: 'x', path: '/', expires: -1 })

// The domains and names a saved mobile session held after a manual sign-in (2026-09-29)
const MOBILE_SESSION = [
    cookie('.account.live.com', 'RPSMaybe'),
    cookie('.bing.com', 'MUID'),
    cookie('.bing.com', '_EDGE_S'),
    cookie('.live.com', 'MUID'),
    cookie('.live.com', 'fptctx2'),
    cookie('.live.com', 'MSPAuth'),
    cookie('.live.com', 'MSPProf'),
    cookie('.live.com', 'WLSSC'),
    cookie('.login.live.com', 'MSPOK'),
    cookie('login.live.com', '__Host-MSAAUTHP'),
    cookie('.login.microsoftonline.com', 'esctx'),
    cookie('login.microsoft.com', 'fpc'),
    cookie('login.windows.net', 'stsservicecookie'),
    cookie('.microsoft.com', 'MC1'),
    cookie('rewards.bing.com', '_C_Auth')
]

test('keeps the Microsoft account sign-in', () => {
    const kept = signInCookies(MOBILE_SESSION).map(c => `${c.domain} ${c.name}`)
    assert.deepEqual(kept, [
        '.account.live.com RPSMaybe',
        '.live.com MSPAuth',
        '.live.com MSPProf',
        '.live.com WLSSC',
        '.login.live.com MSPOK',
        'login.live.com __Host-MSAAUTHP',
        '.login.microsoftonline.com esctx',
        'login.microsoft.com fpc',
        'login.windows.net stsservicecookie'
    ])
})

test('leaves device identity and Bing to each platform', () => {
    const names = signInCookies(MOBILE_SESSION).map(c => `${c.domain} ${c.name}`)
    for (const dropped of [
        '.bing.com MUID',
        '.bing.com _EDGE_S',
        '.live.com MUID',
        '.live.com fptctx2',
        '.microsoft.com MC1',
        'rewards.bing.com _C_Auth'
    ]) {
        assert.ok(!names.includes(dropped), dropped)
    }
})

test('no session, nothing to reuse', () => {
    assert.deepEqual(signInCookies(undefined), [])
    assert.deepEqual(signInCookies([]), [])
})
