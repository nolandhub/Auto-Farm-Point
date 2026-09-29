import assert from 'node:assert/strict'
import test from 'node:test'

import {
    manualLoginMarker,
    mentionsProof,
    shouldStopLoginCycle,
    shouldTreatLoginAlertAsFatal
} from '../Microsoft-Rewards-Script/src/browser/auth/LoginState.ts'

test('the manual-login marker names the account and the reason', () => {
    assert.equal(
        manualLoginMarker('me@example.com', 'email-code-only'),
        'MANUAL_LOGIN_REQUIRED | email=me@example.com | reason=email-code-only'
    )
    assert.equal(manualLoginMarker('me@example.com', 'stuck'), 'MANUAL_LOGIN_REQUIRED | email=me@example.com | reason=stuck')
})

test('a page that names an email or phone would send a code there', () => {
    // The subtitle Microsoft showed for a passwordless account (2026-09-29)
    assert.equal(mentionsProof("We'll send a code to dotrang290418@gmail.com to sign you in."), true)
    assert.equal(mentionsProof('We sent a code to do*****@gmail.com'), true)
    assert.equal(mentionsProof('Chúng tôi sẽ gửi mã tới do•••••@gmail.com'), true)
    assert.equal(mentionsProof('Text a code to ********89'), true)
    assert.equal(mentionsProof('Send a code to +84 ••• ••• 489'), true)
})

test('an Authenticator or method page names no email or phone', () => {
    assert.equal(mentionsProof('Open your Authenticator app, and enter the number shown to sign in.'), false)
    assert.equal(mentionsProof('We will send a notification to your Microsoft Authenticator app on Pixel 7'), false)
    assert.equal(mentionsProof('Use your face, fingerprint, PIN, or security key'), false)
    assert.equal(mentionsProof('Other ways to sign in'), false)
    assert.equal(mentionsProof(''), false)
})

test('a sign-in going round the same page stops on the third visit', () => {
    for (const state of ['PASSWORDLESS_SEND_CODE', 'OTP_CODE_ENTRY', 'FOOTER_ACTION', 'PASSKEY_VIDEO', 'UNKNOWN']) {
        assert.equal(shouldStopLoginCycle(state, 2), false, state)
        assert.equal(shouldStopLoginCycle(state, 3), true, state)
    }
})

test('ordinary steps keep the page-reload recovery instead', () => {
    assert.equal(shouldStopLoginCycle('PASSWORD_INPUT', 5), false)
    assert.equal(shouldStopLoginCycle('EMAIL_INPUT', 5), false)
    assert.equal(shouldStopLoginCycle('KMSI_PROMPT', 5), false)
})

test('defers the first non-empty login alert after KMSI', () => {
    assert.equal(
        shouldTreatLoginAlertAsFatal({
            hostname: 'login.live.com',
            alertText: 'Please wait',
            postKmsi: true,
            consecutiveObservations: 1
        }),
        false
    )
})

test('treats a stable post-KMSI login alert as fatal', () => {
    assert.equal(
        shouldTreatLoginAlertAsFatal({
            hostname: 'login.live.com',
            alertText: 'We could not sign you in',
            postKmsi: true,
            consecutiveObservations: 2
        }),
        true
    )
})

test('does not treat empty or non-login alerts as fatal', () => {
    assert.equal(
        shouldTreatLoginAlertAsFatal({
            hostname: 'login.live.com',
            alertText: '',
            postKmsi: false,
            consecutiveObservations: 1
        }),
        false
    )
    assert.equal(
        shouldTreatLoginAlertAsFatal({
            hostname: 'account.microsoft.com',
            alertText: 'A transient page alert',
            postKmsi: false,
            consecutiveObservations: 3
        }),
        false
    )
})
