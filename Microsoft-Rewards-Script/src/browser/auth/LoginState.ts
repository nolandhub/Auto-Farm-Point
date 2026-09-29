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
