import assert from 'node:assert/strict'
import test from 'node:test'

import { mapFlyoutToDashboard } from '../Microsoft-Rewards-Script/src/browser/FlyoutDashboard.ts'

const counter = (offerId: string, pointProgress: number, pointProgressMax: number) => ({
    offerId,
    pointProgress,
    pointProgressMax
})

function flyout(counters: Record<string, unknown[]>) {
    return {
        userInfo: { isRewardsUser: true, balance: 1452, profile: { attributes: {} } },
        flyoutResult: { userStatus: { isRewardsUser: true, availablePoints: 1452, counters } }
    } as never
}

// What the flyout returned on 2026-09-30: every search counter listed twice.
test('a search counter the flyout lists twice is kept once', () => {
    const { dashboard } = mapFlyoutToDashboard(
        flyout({
            PCSearch: [
                counter('WW_searchsrhptsexp2_global_level2_PC', 51, 90),
                counter('WW_searchsrhptsexp2_global_level2_PC', 51, 90)
            ],
            MobileSearch: [
                counter('WW_searchsrhptsexp2_global_mobile', 60, 60),
                counter('WW_searchsrhptsexp2_global_mobile', 60, 60)
            ],
            DailyPoint: [counter('', 242, 1320)]
        })
    )
    const counters = dashboard.userStatus.counters
    assert.deepEqual(
        counters.pcSearch.map(c => c.pointProgressMax),
        [90]
    )
    assert.deepEqual(
        counters.mobileSearch.map(c => c.pointProgressMax),
        [60]
    )
    assert.equal(counters.dailyPoint.length, 1)
})

test('different counters in one list are all kept', () => {
    const { dashboard } = mapFlyoutToDashboard(
        flyout({
            PCSearch: [
                counter('WW_searchsrhptsexp2_global_level2_PC', 51, 90),
                counter('ENUS_EdgeBonus_PCSearch', 0, 20)
            ]
        })
    )
    assert.equal(dashboard.userStatus.counters.pcSearch.length, 2)
})
