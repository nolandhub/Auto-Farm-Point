/**
 * Reads the Rewards pages the extension's dashboard shows, for any configured
 * account, with the browser session the bot saved for it. So the dashboard
 * can show the account the bot is running, not only the one signed in to
 * Edge. Only these pages, never an arbitrary URL: the flyout, the earn page
 * and a quest page.
 */

const PAGES = {
    flyout: () => 'https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards',
    earn: () => 'https://rewards.bing.com/earn',
    quest: id => `https://rewards.bing.com/earn/quest/${id}`
}
const QUEST_ID = /^[A-Za-z0-9_-]{1,200}$/
// The popup reads every minute while it is open; quests change slowly
const TTL_MS = { flyout: 60_000, earn: 5 * 60_000, quest: 5 * 60_000 }
const MAX_REDIRECTS = 5
const TIMEOUT_MS = 15_000

function codedError(message, code) {
    return Object.assign(new Error(message), { code })
}

export function pageUrl(page, id) {
    if (!Object.hasOwn(PAGES, page ?? '')) {
        throw codedError('page must be flyout, earn or quest', 'BAD_REQUEST')
    }
    if (page === 'quest' && !QUEST_ID.test(id ?? '')) {
        throw codedError('quest needs an id made of letters, digits, _ and -', 'BAD_REQUEST')
    }
    return PAGES[page](id)
}

/** The Cookie header a browser would send to `url`. */
export function cookieHeader(cookies, url, nowSeconds) {
    const { hostname, pathname, protocol } = new URL(url)
    return cookies
        .filter(cookie => {
            const domain = String(cookie.domain ?? '')
                .replace(/^\./, '')
                .toLowerCase()
            if (!domain || (hostname !== domain && !hostname.endsWith(`.${domain}`))) return false
            if (!pathname.startsWith(cookie.path || '/')) return false
            if (cookie.secure && protocol !== 'https:') return false
            return cookie.expires == null || cookie.expires < 0 || cookie.expires > nowSeconds
        })
        .map(cookie => `${cookie.name}=${cookie.value}`)
        .join('; ')
}

export class RewardsReader {
    constructor({ loadSession, fetch: fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = TIMEOUT_MS }) {
        this.loadSession = loadSession
        this.fetch = fetchImpl
        this.now = now
        this.timeoutMs = timeoutMs
        this.cache = new Map()
    }

    /** { ok, status, url, body }; `url` is where the redirects ended. */
    read(email, page, id) {
        const url = pageUrl(page, id)
        const key = `${email.toLowerCase()}|${url}`
        const hit = this.cache.get(key)
        if (hit && this.now() - hit.at < TTL_MS[page]) return hit.promise

        const promise = this.fetchPage(email, url)
        this.cache.set(key, { at: this.now(), promise })
        // Only a good read is kept; a failure is retried on the next call
        const forget = () => {
            if (this.cache.get(key)?.promise === promise) this.cache.delete(key)
        }
        promise.then(result => result.ok || forget(), forget)
        return promise
    }

    async fetchPage(email, startUrl) {
        const session = this.loadSession(email)
        const cookies = session?.storageState?.cookies
        if (!cookies?.length) throw codedError(`No saved session for ${email}`, 'NO_SESSION')
        const userAgent = session.fingerprint?.fingerprint?.navigator?.userAgent

        // Redirects are followed here, not by fetch, so each host gets its own cookies
        let url = startUrl
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const response = await this.fetch(url, {
                redirect: 'manual',
                signal: AbortSignal.timeout(this.timeoutMs),
                headers: {
                    cookie: cookieHeader(cookies, url, this.now() / 1000),
                    'accept-language': 'en-US,en;q=0.9',
                    ...(userAgent ? { 'user-agent': userAgent } : {})
                }
            })
            const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null
            if (!location) return { ok: response.ok, status: response.status, url, body: await response.text() }
            url = new URL(location, url).href
        }
        throw codedError(`More than ${MAX_REDIRECTS} redirects reading ${startUrl}`, 'UPSTREAM')
    }
}
