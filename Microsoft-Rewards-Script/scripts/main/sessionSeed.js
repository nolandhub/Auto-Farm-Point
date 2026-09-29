/**
 * The Microsoft account sign-in cookies of a saved browser session, for the
 * other platform's browser to reuse instead of signing in again (and costing
 * another emailed code). Device identity stays per platform: Bing's cookies,
 * every MUID and the fingerprint context are left out, so Bing still sees a
 * phone and a PC.
 */

const ACCOUNT_DOMAINS = ['live.com', 'login.microsoftonline.com', 'login.microsoft.com', 'login.windows.net']
const DEVICE_COOKIES = new Set(['MUID', 'MUIDB', '_EDGE_S', '_EDGE_V', 'fptctx2'])

export function signInCookies(cookies) {
    return (cookies ?? []).filter(cookie => {
        const domain = String(cookie.domain ?? '')
            .replace(/^\./, '')
            .toLowerCase()
        const accountDomain = ACCOUNT_DOMAINS.some(base => domain === base || domain.endsWith(`.${base}`))
        return accountDomain && !DEVICE_COOKIES.has(cookie.name)
    })
}
