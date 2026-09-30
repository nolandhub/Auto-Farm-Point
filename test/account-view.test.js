import test from "node:test";
import assert from "node:assert/strict";
import { nextView, pageFor, readAccountView } from "../src/core/account-view.js";
import { EARN_URL } from "../src/core/quests.js";
import { dateKey } from "../src/core/quota.js";
import { MONTHLY, child, questHtml } from "./quest-fixture.js";

const NOW = new Date("2026-09-30T03:00:00Z");
const DAY = "09/30/2026";

function flyout({ signedIn = true, balance = 1470 } = {}) {
  return {
    isRewardsUser: signedIn,
    userId: "user-bot",
    userInfo: { isRewardsUser: signedIn, balance },
    flyoutResult: {
      userStatus: {
        isRewardsUser: signedIn,
        availablePoints: balance,
        counters: {
          PCSearch: [{ offerId: "WW_pc", pointProgress: 63, pointProgressMax: 90 }],
          MobileSearch: [{ offerId: "WW_mobile", pointProgress: 60, pointProgressMax: 60 }],
          DailyPoint: [{ offerId: "", pointProgress: 242, pointProgressMax: 1320 }],
        },
      },
      dailyCheckInPromotion: { attributes: { markettimeoffset: "+07:00" } },
      dailySetPromotions: {
        [DAY]: [
          {
            offerId: "Global_DailySet_20260930_Child1",
            title: "Read today's story",
            complete: true,
            isRewardable: true,
            pointProgress: 10,
            pointProgressMax: 10,
            destinationUrl: "https://www.bing.com/search?q=story",
            promotionType: "urlreward",
            hash: "hash-a",
          },
        ],
      },
      morePromotions: [],
    },
  };
}

/** The bot API as the worker sees it: one account's pages by name. */
function fakeApi({ flyoutBody = flyout(), earnUrl = EARN_URL } = {}) {
  const calls = [];
  const pages = {
    flyout: { ok: true, status: 200, url: "https://www.bing.com/rewards/panelflyout/getuserinfo", body: JSON.stringify(flyoutBody) },
    earn: { ok: true, status: 200, url: earnUrl, body: `<a class="card" href="/earn/quest/${MONTHLY}">` },
    quest: { ok: true, status: 200, url: `${EARN_URL}/quest/${MONTHLY}`, body: questHtml({ children: [child(1, { done: true }), child(2)] }) },
  };
  return {
    calls,
    accountRewards: async (index, page, id) => {
      calls.push([index, page, id]);
      return pages[page];
    },
  };
}

test("maps the pages the quest reader asks for to the bot API's page names", () => {
  assert.deepEqual(pageFor(EARN_URL), { page: "earn" });
  assert.deepEqual(pageFor(`${EARN_URL}/quest/${MONTHLY}`), { page: "quest", id: MONTHLY });
  assert.equal(pageFor("https://example.com/earn"), null);
});

test("reads an account's dashboard and quests through the bot API, in the popup's shape", async () => {
  const api = fakeApi();
  const { dashboard, tasks } = await readAccountView({ api, index: 3, now: NOW });

  assert.equal(dashboard.availablePoints, 1470);
  assert.equal(dashboard.todayPoints, 242);
  assert.deepEqual(dashboard.counters.pc, { current: 63, max: 90, complete: false });
  assert.equal(dashboard.userId, "user-bot");
  assert.equal(dashboard.source, "bot");
  assert.equal(dashboard.readAt, NOW.getTime());

  assert.deepEqual(
    tasks.items.map((t) => [t.id, t.state]),
    [
      [MONTHLY, "auto"],
      ["Global_DailySet_20260930_Child1", "done"],
    ]
  );
  assert.deepEqual(api.calls, [
    [3, "flyout", undefined],
    [3, "earn", undefined],
    [3, "quest", MONTHLY],
  ]);
});

test("counts today's points from that account's balance, like the Edge ledger", async () => {
  const yesterday = new Date(NOW);
  yesterday.setDate(yesterday.getDate() - 1);
  const ledger = { day: dateKey(yesterday), baseline: 1300, last: 1400, exact: false };

  const first = await readAccountView({ api: fakeApi(), index: 1, now: NOW });
  assert.equal(first.dashboard.earnedToday, 0);
  assert.equal(first.dashboard.earnedExact, false);

  const next = await readAccountView({ api: fakeApi(), index: 1, ledger, now: NOW });
  assert.equal(next.dashboard.earnedToday, 70);
  assert.equal(next.dashboard.earnedExact, true);
  assert.deepEqual(next.ledger, { day: dateKey(NOW), baseline: 1400, last: 1470, exact: true });
});

test("an account the flyout reports as signed out is an error, not an empty dashboard", async () => {
  await assert.rejects(readAccountView({ api: fakeApi({ flyoutBody: flyout({ signedIn: false }) }), index: 1, now: NOW }), {
    code: "SIGNED_OUT",
  });
});

test("without a rewards.bing.com sign-in the flyout's tasks still show, with no quests", async () => {
  const api = fakeApi({ earnUrl: "https://login.live.com/login.srf" });
  const { tasks } = await readAccountView({ api, index: 1, now: NOW });
  assert.deepEqual(
    tasks.items.map((t) => t.id),
    ["Global_DailySet_20260930_Child1"]
  );
});

test("the view follows the account the bot moves to, and otherwise stays where the user put it", () => {
  // The bot starts a.
  assert.deepEqual(nextView({ view: "edge", followed: null, running: "a@x" }), { view: "a@x", followed: "a@x" });
  // The user looks at b while a is still running: stay on b.
  assert.deepEqual(nextView({ view: "b@x", followed: "a@x", running: "a@x" }), { view: "b@x", followed: "a@x" });
  // The bot moves on to c: follow it.
  assert.deepEqual(nextView({ view: "b@x", followed: "a@x", running: "c@x" }), { view: "c@x", followed: "c@x" });
  // The run ends: stay on c.
  assert.deepEqual(nextView({ view: "c@x", followed: "c@x", running: null }), { view: "c@x", followed: null });
});
