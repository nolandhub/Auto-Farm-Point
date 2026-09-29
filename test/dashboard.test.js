import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";
import {
  FLYOUT_URL,
  dailySetKey,
  parseDashboard,
  readDashboard,
  remainingSearches,
  isCounterComplete,
} from "../src/core/dashboard.js";
import * as logger from "../src/core/log.js";

/** Shaped after the legacy rewards.bing.com/api/getuserinfo payload. */
const RAW = {
  userStatus: {
    level: "Level2",
    availablePoints: 12345,
    counters: {
      pcSearch: [
        { name: "PC search", pointProgress: 63, pointProgressMax: 90, complete: false },
        { name: "Edge bonus", pointProgress: 12, pointProgressMax: 12, complete: true },
      ],
      mobileSearch: [
        { name: "Mobile search", pointProgress: 0, pointProgressMax: 60, complete: false },
      ],
    },
  },
  dailySetPromotions: {
    "09/26/2026": [
      {
        offerId: "Gamification_DailySet_Quiz",
        title: "Quiz of the day",
        complete: false,
        pointProgress: 0,
        pointProgressMax: 10,
        destinationUrl: "https://www.bing.com/search?q=quiz&rnd=1",
        promotionType: "quiz",
      },
      {
        offerId: "Gamification_DailySet_Poll",
        title: "Poll",
        complete: true,
        pointProgress: 10,
        pointProgressMax: 10,
        destinationUrl: "https://www.bing.com/search?q=poll",
        promotionType: "urlreward",
      },
    ],
  },
  morePromotions: [
    {
      offerId: "ENUS_readarticle",
      title: "Read an article",
      complete: false,
      pointProgress: 0,
      pointProgressMax: 5,
      destinationUrl: "https://www.bing.com/search?q=article",
      promotionType: "urlreward",
    },
    {
      offerId: "already_done",
      title: "Done one",
      complete: true,
      pointProgressMax: 5,
      destinationUrl: "https://www.bing.com/x",
      promotionType: "urlreward",
    },
  ],
};

test("parseDashboard pulls level and point balance", () => {
  const d = parseDashboard(RAW);
  assert.equal(d.level, "Level2");
  assert.equal(d.availablePoints, 12345);
});

test("parseDashboard picks the search counter, not the Edge bonus beside it", () => {
  const d = parseDashboard(RAW);
  assert.equal(d.counters.pc.current, 63);
  assert.equal(d.counters.pc.max, 90);
  assert.equal(d.counters.pc.complete, false);
});

test("parseDashboard reads the mobile counter", () => {
  const d = parseDashboard(RAW);
  assert.equal(d.counters.mobile.current, 0);
  assert.equal(d.counters.mobile.max, 60);
});

test("parseDashboard flattens today's daily set and drops finished offers", () => {
  const d = parseDashboard(RAW);
  const ids = d.offers.map((o) => o.id);
  assert.ok(ids.includes("Gamification_DailySet_Quiz"));
  assert.ok(!ids.includes("Gamification_DailySet_Poll"), "completed poll must be dropped");
  assert.ok(ids.includes("ENUS_readarticle"));
  assert.ok(!ids.includes("already_done"));
});

test("parsed offers carry what the runner needs to open them", () => {
  const offer = parseDashboard(RAW).offers.find((o) => o.id === "ENUS_readarticle");
  assert.equal(offer.url, "https://www.bing.com/search?q=article");
  assert.equal(offer.points, 5);
  assert.equal(offer.kind, "urlreward");
  assert.equal(offer.title, "Read an article");
});

test("parseDashboard tolerates a payload with nothing in it", () => {
  for (const input of [null, undefined, {}, "nonsense", []]) {
    const d = parseDashboard(input);
    assert.deepEqual(d.offers, []);
    assert.equal(d.counters.pc, null);
    assert.equal(d.availablePoints, null);
  }
});

test("parseDashboard survives a counter shape it does not recognise", () => {
  const d = parseDashboard({ userStatus: { counters: { pcSearch: "unexpected" } } });
  assert.equal(d.counters.pc, null);
});

test("parseDashboard skips offers with no destination", () => {
  const d = parseDashboard({
    morePromotions: [{ offerId: "x", complete: false, pointProgressMax: 5 }],
  });
  assert.deepEqual(d.offers, []);
});

test("remainingSearches converts leftover points into whole searches", () => {
  assert.equal(remainingSearches({ current: 63, max: 90 }, 3), 9);
  assert.equal(remainingSearches({ current: 0, max: 90 }, 3), 30);
});

test("remainingSearches returns zero once the counter is full or over", () => {
  assert.equal(remainingSearches({ current: 90, max: 90 }, 3), 0);
  assert.equal(remainingSearches({ current: 99, max: 90 }, 3), 0);
});

test("remainingSearches rounds up a partial search", () => {
  assert.equal(remainingSearches({ current: 89, max: 90 }, 3), 1);
});

test("remainingSearches returns null when the counter is unknown", () => {
  assert.equal(remainingSearches(null, 3), null);
  assert.equal(remainingSearches(undefined, 3), null);
});

test("isCounterComplete trusts the flag, then falls back to the numbers", () => {
  assert.equal(isCounterComplete({ complete: true, current: 0, max: 90 }), true);
  assert.equal(isCounterComplete({ complete: false, current: 90, max: 90 }), true);
  assert.equal(isCounterComplete({ complete: false, current: 10, max: 90 }), false);
  assert.equal(isCounterComplete(null), false);
});

// ------------------------------------------------------------ bing.com flyout

/**
 * Shaped after www.bing.com/rewards/panelflyout/getuserinfo, the payload the
 * Rewards icon in Bing's own header reads. Field names are the ones Bing's
 * flyout bundle dereferences (flyoutResult.userStatus.counters.PCSearch, ...).
 */
function flyout({ day = "09/28/2026", tomorrow = "09/29/2026", offset = "+07:00" } = {}) {
  return {
    isRewardsUser: true,
    userId: "user-123",
    channel: "BingFlyout",
    partnerId: "BingRewards",
    userInfo: {
      isRewardsUser: true,
      balance: 24630,
      promotions: [{ name: "level_benefits", attributes: { activeLevel: "newLevel2" } }],
    },
    flyoutResult: {
      userStatus: {
        availablePoints: 24630,
        counters: {
          // Bing lists the Edge bonus inside PCSearch and filters it out by
          // this offerId keyword, so it deliberately comes first here.
          PCSearch: [
            { offerId: "ENUS_edgeplusbing_bonus", pointProgress: 0, pointProgressMax: 12 },
            { offerId: "ENUS_PCSearch", pointProgress: 12, pointProgressMax: 90 },
          ],
          MobileSearch: [{ offerId: "ENUS_MobileSearch", pointProgress: 6, pointProgressMax: 60 }],
          DailyPoint: [{ offerId: "", pointProgress: 163, pointProgressMax: 0 }],
        },
      },
      dailyCheckInPromotion: { attributes: { markettimeoffset: offset } },
      dailySetPromotions: {
        [day]: [
          {
            offerId: "Gamification_DailySet_A",
            title: "Read today's story",
            complete: false,
            isRewardable: true,
            pointProgress: 0,
            pointProgressMax: 10,
            destinationUrl: "https://www.bing.com/search?q=story",
            promotionType: "urlreward",
            activityType: "urlreward",
            hash: "hash-a",
          },
          {
            offerId: "Gamification_DailySet_Quiz",
            title: "Daily quiz",
            complete: false,
            isRewardable: true,
            pointProgress: 0,
            pointProgressMax: 10,
            destinationUrl: "https://www.bing.com/search?q=quiz",
            promotionType: "quiz",
            hash: "hash-q",
          },
        ],
        [tomorrow]: [
          {
            offerId: "Gamification_DailySet_Tomorrow",
            title: "Tomorrow",
            complete: false,
            isRewardable: true,
            pointProgressMax: 10,
            destinationUrl: "https://www.bing.com/search?q=tomorrow",
            promotionType: "urlreward",
            hash: "hash-t",
          },
        ],
      },
      morePromotions: [
        {
          offerId: "ENUS_more_1",
          title: "Explore the news",
          complete: false,
          isRewardable: true,
          pointProgress: 0,
          pointProgressMax: 5,
          destinationUrl: "https://www.bing.com/news",
          promotionType: "urlreward",
          activityType: "urlreward",
          hash: "hash-m",
        },
        {
          offerId: "ENUS_locked",
          title: "Locked until Friday",
          complete: false,
          isRewardable: true,
          pointProgressMax: 20,
          destinationUrl: "https://www.bing.com/x",
          promotionType: "urlreward",
          exclusiveLockedFeatureStatus: "locked",
        },
        {
          offerId: "ENUS_info",
          title: "Nothing to earn",
          complete: false,
          isRewardable: false,
          pointProgressMax: 0,
          destinationUrl: "https://www.bing.com/y",
          promotionType: "urlreward",
        },
      ],
    },
  };
}

// Still 09/28 at +07:00, so the fixture's daily set is today's.
const NOON_UTC = new Date("2026-09-28T12:00:00Z");

test("the flyout payload yields the balance and today's points", () => {
  const d = parseDashboard(flyout(), { now: NOON_UTC });
  assert.equal(d.signedIn, true);
  assert.equal(d.availablePoints, 24630);
  assert.equal(d.todayPoints, 163);
  assert.equal(d.level, "newLevel2");
  assert.equal(d.userId, "user-123");
});

test("the flyout PC counter skips the Edge bonus the way Bing's own card does", () => {
  const d = parseDashboard(flyout(), { now: NOON_UTC });
  assert.deepEqual(d.counters.pc, { current: 12, max: 90, complete: false });
  assert.deepEqual(d.counters.mobile, { current: 6, max: 60, complete: false });
});

test("only today's daily set is offered, not tomorrow's preview", () => {
  const ids = parseDashboard(flyout(), { now: NOON_UTC }).offers.map((o) => o.id);
  assert.ok(ids.includes("Gamification_DailySet_A"));
  assert.ok(!ids.includes("Gamification_DailySet_Tomorrow"));
});

test("today is decided on the market's clock, not the machine's", () => {
  // 20:00 UTC is already 09/29 in Vietnam (+07:00).
  const late = new Date("2026-09-28T20:00:00Z");
  const ids = parseDashboard(flyout({ day: "09/29/2026", tomorrow: "09/30/2026" }), { now: late }).offers.map((o) => o.id);
  assert.ok(ids.includes("Gamification_DailySet_A"), "09/29 is today at +07:00");
  assert.equal(dailySetKey(late, "+07:00"), "09/29/2026");
  assert.equal(dailySetKey(late, "-05:00"), "09/28/2026");
});

test("locked and pointless offers are dropped", () => {
  const ids = parseDashboard(flyout(), { now: NOON_UTC }).offers.map((o) => o.id);
  assert.ok(!ids.includes("ENUS_locked"));
  assert.ok(!ids.includes("ENUS_info"));
  assert.ok(ids.includes("ENUS_more_1"));
});

test("offers keep what reporting them to Bing needs", () => {
  const offer = parseDashboard(flyout(), { now: NOON_UTC }).offers.find(
    (o) => o.id === "ENUS_more_1"
  );
  assert.equal(offer.hash, "hash-m");
  assert.equal(offer.activityType, "urlreward");
  assert.equal(offer.points, 5);
});

test("a signed-out flyout is recognised as such", () => {
  const d = parseDashboard(
    { isRewardsUser: false, userInfo: { isRewardsUser: false }, flyoutResult: { userStatus: {} } },
    { now: NOON_UTC }
  );
  assert.equal(d.signedIn, false);
  assert.equal(d.counters.pc, null);
});

// ------------------------------------------------------------- readDashboard

function respond(body) {
  return { ok: true, status: 200, json: async () => body };
}

test("readDashboard prefers the bing.com flyout", async () => {
  globalThis.chrome = makeChrome();
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    if (String(url) === FLYOUT_URL) return respond(flyout());
    throw new Error("unexpected");
  };
  const d = await readDashboard();
  assert.equal(d.source, "flyout");
  assert.equal(d.counters.pc.max, 90);
  assert.equal(asked.length, 1, "no second source needed");
});

test("readDashboard falls back to the legacy api when the flyout fails", async () => {
  globalThis.chrome = makeChrome();
  globalThis.fetch = async (url) => {
    if (String(url) === FLYOUT_URL) throw new Error("network");
    return respond({ dashboard: RAW });
  };
  const d = await readDashboard();
  assert.equal(d.source, "legacy");
  assert.equal(d.counters.pc.current, 63);
});

test("readDashboard returns null when bing.com is signed out and the api is too", async () => {
  globalThis.chrome = makeChrome();
  globalThis.fetch = async (url) => {
    if (String(url) === FLYOUT_URL) {
      return respond({ isRewardsUser: false, userInfo: { isRewardsUser: false } });
    }
    return { ok: false, status: 0, type: "opaqueredirect", json: async () => ({}) };
  };
  assert.equal(await readDashboard(), null);
});

test("readDashboard logs a repeated read once, and again when it changes", async () => {
  globalThis.chrome = makeChrome();
  await logger.clear();
  let body = flyout();
  globalThis.fetch = async () => respond(body);
  await readDashboard();
  await readDashboard();
  const reads = () => logger.getText().split("\n").filter((line) => line.includes("dashboard read"));
  assert.equal(reads().length, 1, "the popup's 1.5s polls do not flood the log");

  body = structuredClone(body);
  body.flyoutResult.userStatus.counters.PCSearch[1].pointProgress += 3;
  await readDashboard();
  assert.equal(reads().length, 2);
});

test("today's task list keeps finished tasks, so progress can be shown", () => {
  const d = parseDashboard(RAW);
  const byId = Object.fromEntries(d.tasks.map((t) => [t.id, t]));
  assert.deepEqual(Object.keys(byId).sort(), [
    "ENUS_readarticle",
    "Gamification_DailySet_Poll",
    "Gamification_DailySet_Quiz",
    "already_done",
  ]);
  assert.equal(byId.Gamification_DailySet_Poll.done, true);
  assert.equal(byId.already_done.done, true);
  assert.equal(byId.ENUS_readarticle.done, false);
  assert.equal(byId.ENUS_readarticle.points, 5);
  assert.equal(byId.Gamification_DailySet_Quiz.kind, "quiz");
});

test("the task list leaves out tomorrow, locked and pointless items", () => {
  const ids = parseDashboard(flyout(), { now: NOON_UTC }).tasks.map((t) => t.id);
  assert.ok(!ids.includes("Gamification_DailySet_Tomorrow"));
  assert.ok(!ids.includes("ENUS_locked"));
  assert.ok(!ids.includes("ENUS_info"));
  assert.ok(ids.includes("Gamification_DailySet_A"));
});
