export interface LoginAlertObservation {
    hostname: string
    alertText: string
    postKmsi: boolean
    consecutiveObservations: number
}

/**
 * A role=alert node can briefly survive the KMSI transition while the
 * login.live.com page is navigating. Only a non-empty alert that remains
 * visible across two observations should abort that transition.
 */
export function shouldTreatLoginAlertAsFatal(observation: LoginAlertObservation): boolean {
    if (observation.hostname !== 'login.live.com') return false
    if (!observation.alertText.trim()) return false
    if (observation.postKmsi && observation.consecutiveObservations < 2) return false
    return true
}

// Full or masked (*, x or •) email addresses and phone numbers, in any page language
const EMAIL_PROOF = /[\w.+*•-]+@[\w.*•-]+\.[a-z]{2,}/i
const PHONE_PROOF = /(?:\+?\d|[*xX•])(?:[\d\s().*xX•-]{4,})(?:\d|[*xX•])/

/**
 * Whether sign-in text names an email address or phone number. On a "Get a
 * code" page that means its button sends a code there, which the bot cannot
 * read; an Authenticator or method-choice page names neither.
 */
export function mentionsProof(text: string): boolean {
    return EMAIL_PROOF.test(text) || PHONE_PROOF.test(text)
}

// Steps that make no progress when repeated: each pass can send another code
// or push, or means the page offers nothing the bot can use.
const CYCLE_STATES = new Set([
    'PASSWORDLESS_SEND_CODE',
    'OTP_CODE_ENTRY',
    'FOOTER_ACTION',
    'SIGN_IN_METHOD_PICKER',
    'EMAIL_VERIFICATION_INPUT',
    'PASSKEY_VIDEO',
    'PASSKEY_ERROR',
    'UNKNOWN'
])

/** A login that reaches one of those steps a third time is going in circles. */
export function shouldStopLoginCycle(state: string, visits: number): boolean {
    return CYCLE_STATES.has(state) && visits >= 3
}

export type ManualLoginReason = 'email-code-only' | 'no-supported-method' | 'email-verification' | 'stuck'

/**
 * The line the control API watches for (parseManualLoginMarker in
 * scripts/api/manualLoginManager.js): this account needs a person to sign in.
 */
export function manualLoginMarker(email: string, reason: ManualLoginReason): string {
    return `MANUAL_LOGIN_REQUIRED | email=${email} | reason=${reason}`
}
