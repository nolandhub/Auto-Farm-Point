import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldTreatLoginAlertAsFatal } from '../Microsoft-Rewards-Script/src/browser/auth/LoginState.ts'

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
