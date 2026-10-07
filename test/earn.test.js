import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";
import { THROTTLE } from "../src/core/constants.js";
import { APP_WEEKLY, EARN_HTML, MONTHLY, child, questHtml } from "./quest-fixture.js";

/**
 * End-to-end behaviour of the "farm everything, safely" additions: the real
 * dashboard decides when to stop, and activities are click-throughs on
 * Microsoft's own pages, never anything more aggressive.
 */

let stub;
let runner;

/**
 * A bing.com flyout payload served to the extension's fetch(), shaped after
 * the one behind the Rewards icon in Bing's header.
 */
function dashboardPayload({ pc = [0, 90], mobile = [0, 60], offers = [] } = {}) {
  return {
    isRewardsUser: true,
    userId: "user-1",
    userInfo: {
      isRewardsUser: true,
      promotions: [{ name: "level_benefits", attributes: { activeLevel: "newLevel2" } }],
    },
    flyoutResult: {
      userStatus: {
        availablePoints: 5000,
        counters: {
          PCSearch: [{ offerId: "pc", pointProgress: pc[0], pointProgressMax: pc[1] }],
          MobileSearch: [{ offerId: "mobile", pointProgress: mobile[0], pointProgressMax: mobile[1] }],
          DailyPoint: [{ pointProgress: 42, pointProgressMax: 0 }],
        },
      },
      dailySetPromotions: {},
      morePromotions: offers,
    },
  };
}

function offer(id, over = {}) {
  return {
    offerId: id,
    title: id,
    complete: false,
    isRewardable: true,
    pointProgress: 0,
    pointProgressMax: 10,
    destinationUrl: `https://www.bing.com/search?q=${id}`,
    promotionType: "urlreward",
    activityType: "urlreward",
    hash: `hash-${id}`,
    ...over,
  };
}

/** Searches the worker tab made so far, in order, as "pc" / "mobile". */
function searchesMade() {
  return stub.calls
    .filter((c) => c.api === "tabs.update" && /\/search\?q=.*&form=/.test(String(c.args[1].url)))
    .map((c) => (String(c.args[1].url).includes("form=MOSBSB") ? "mobile" : "pc"));
}

/**
 * Serves `payload` as Bing would: each search the credit policy accepts adds
 * 3 points to its device's counter, capped at the max. By default every
 * search is credited, as on an account Bing is not limiting.
 */
async function boot(payload, { fetchFails = false, credit = () => true, quests = null, elsewhere = null } = {}) {
  stub = makeChrome();
  globalThis.chrome = stub;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (quests && u.startsWith("https://rewards.bing.com/earn")) {
      const id = u.split("/earn/quest/")[1];
      const text = id ? quests[id] : EARN_HTML;
      return { ok: Boolean(text), status: text ? 200 : 404, url: u, text: async () => text ?? "" };
    }
    if (String(url).includes("/rewards/panelflyout/getuserinfo")) {
      if (fetchFails) throw new Error("signed out");
      const live = structuredClone(payload);
      const counters = live?.flyoutResult?.userStatus?.counters;
      const seen = { pc: 0, mobile: 0 };
      for (const mode of searchesMade()) {
        const index = seen[mode]++;
        const entry = counters?.[mode === "pc" ? "PCSearch" : "MobileSearch"]?.[0];
        if (entry && credit(mode, index)) {
          entry.pointProgress = Math.min(entry.pointProgressMax, entry.pointProgress + 3);
        }
      }
      // Points earned outside the run, e.g. searching by hand on a real phone.
      for (const [mode, points] of Object.entries(elsewhere ?? {})) {
        const entry = counters?.[mode === "pc" ? "PCSearch" : "MobileSearch"]?.[0];
        if (entry) entry.pointProgress = Math.min(entry.pointProgressMax, entry.pointProgress + points);
      }
      return { ok: true, status: 200, json: async () => live };
    }
    throw new Error("offline"); // legacy api and topic sources
  };
  runner = await import(`../src/core/runner.js?v=${Math.random()}`);
  // Credit shows up in seconds on the real counter; tests need not wait.
  runner.tuning.creditSettleMs = 0;
  runner.tuning.creditRecheckMs = 0;
  runner.tuning.signInSettleMs = 0;
  Object.assign(runner.tuning, { readMinMs: 0, readMaxMs: 0, serpDwellMs: 0 });
}

async function drive(maxSteps = 60) {
  for (let i = 0; i < maxSteps; i++) {
    const { "run.v3": state } = await stub.storage.local.get("run.v3");
    if (["done", "error", "idle"].includes(state.status)) return state;
    await stub.storage.local.set({ "run.v3": { ...state, nextActionAt: 0 } });
    await runner.step();
  }
  throw new Error("run did not finish");
}

const searchUrls = () =>
  stub.calls
    .filter((c) => c.api === "tabs.update" && String(c.args[1].url).includes("/search?q="))
    .map((c) => c.args[1].url);

// ------------------------------------------------------------ cap enforcement

test("the real counter caps the run below what the user asked for", async () => {
  // 63 of 90 points used => 9 searches left, not the 30 requested.
  await boot(dashboardPayload({ pc: [63, 90] }));
  await runner.start({ modes: ["pc"], counts: { pc: 30 } });
  const final = await drive();
  assert.equal(final.totalDone, 9);
});

/** Pretends this device already ran `searches` PC searches today. */
async function seedToday(searches) {
  const { dateKey } = await import("../src/core/quota.js");
  await stub.storage.local.set({ "history.v3": { [dateKey()]: { pc: searches } } });
}

test("points still left on the account are farmed even after earlier runs today", async () => {
  // The reported bug: 84/90 left 2 searches, but 30 earlier searches on this
  // device were subtracted from those 2 and the run claimed all was done.
  await boot(dashboardPayload({ pc: [84, 90] }));
  await seedToday(30);
  const result = await runner.start({ modes: ["pc"], counts: { pc: 34 } });
  assert.equal(result.started, true, "6 points were still on the table");
  const final = await drive();
  assert.equal(final.totalDone, 2);
});

test("a bare start farms everything the account has left, on both devices", async () => {
  await boot(dashboardPayload({ pc: [84, 90], mobile: [6, 60] }));
  await seedToday(30);
  const result = await runner.start();
  assert.equal(result.started, true);
  const final = await drive();
  assert.deepEqual(
    final.plan.map((leg) => [leg.mode, leg.total]),
    [
      ["pc", 2],
      ["mobile", 18],
    ]
  );
  assert.equal(final.totalDone, 20);
});

test("a bare start ignores the modes and counts older versions saved", async () => {
  await boot(dashboardPayload({ pc: [80, 90], mobile: [54, 60] }));
  await stub.storage.local.set({ "settings.v3": { modes: ["pc"], counts: { pc: 1, mobile: 1 } } });
  await runner.start();
  const final = await drive();
  assert.equal(final.totalDone, 6, "4 PC + 2 mobile, whatever was saved");
});

test("the popup is told what the next run will do", async () => {
  await boot(
    dashboardPayload({
      pc: [84, 90],
      mobile: [60, 60],
      offers: [offer("a"), offer("q", { promotionType: "quiz" })],
    })
  );
  await runner.refreshDashboard();
  const snap = await runner.snapshot();
  assert.deepEqual(snap.nextPlan, { pc: 2, mobile: 0, activities: 1 });
});

test("searches already credited are not subtracted a second time", async () => {
  // 30/90 means 20 searches left; the 10 this device did are already in the 30.
  await boot(dashboardPayload({ pc: [30, 90] }));
  await seedToday(10);
  await runner.start({ modes: ["pc"], counts: { pc: 30 } });
  const final = await drive();
  assert.equal(final.totalDone, 20);
});

test("a counter already full means the run does not start at all", async () => {
  await boot(dashboardPayload({ pc: [90, 90] }));
  const result = await runner.start({ modes: ["pc"], counts: { pc: 30 } });
  assert.equal(result.started, false);
  assert.equal(result.reason, "allDone");
});

test("the dashboard never inflates a smaller request", async () => {
  await boot(dashboardPayload({ pc: [0, 90] }));
  await runner.start({ modes: ["pc"], counts: { pc: 5 } });
  const final = await drive();
  assert.equal(final.totalDone, 5, "30 were available but 5 were asked for");
});

test("an unreadable dashboard falls back to the configured count", async () => {
  await boot(null, { fetchFails: true });
  await runner.start({ modes: ["pc"], counts: { pc: 4 } });
  const final = await drive();
  assert.equal(final.totalDone, 4);
});

test("turning the dashboard off skips the network entirely", async () => {
  await boot(dashboardPayload({ pc: [90, 90] }));
  await runner.saveSettings({ useDashboard: false });
  const result = await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  assert.equal(result.started, true, "a full counter must not block when disabled");
  await drive();
  await runner.stop("test");
});

// ---------------------------------------------------------------- activities

test("available activities run before any search", async () => {
  await boot(dashboardPayload({ pc: [0, 90], offers: [offer("act1"), offer("act2")] }));
  await runner.start({ modes: ["pc"], counts: { pc: 2 } });
  await drive();

  const urls = stub.calls
    .filter((c) => c.api === "tabs.update" && c.args[1].url && c.args[1].url !== "about:blank")
    .map((c) => c.args[1].url);
  const firstSearch = urls.findIndex((u) => u.includes("form="));
  const lastActivity = urls.map((u) => /q=act\d/.test(u)).lastIndexOf(true);
  assert.ok(lastActivity >= 0, "activities should have run");
  assert.ok(lastActivity < firstSearch, "activities must come before searches");
});

test("activity progress is tracked separately from searches", async () => {
  await boot(dashboardPayload({ offers: [offer("a"), offer("b"), offer("c")] }));
  await runner.start({ modes: ["pc"], counts: { pc: 2 } });
  await drive();

  const today = Object.values(await runner.getHistory())[0];
  assert.equal(today.activity, 3);
  assert.equal(today.pc, 2);
});

test("quizzes and polls are left for the user to do by hand", async () => {
  await boot(
    dashboardPayload({
      offers: [
        offer("safe"),
        offer("quizzy", { promotionType: "quiz" }),
        offer("thisorthat", { promotionType: "thisorthat" }),
      ],
    })
  );
  await runner.start({ modes: ["pc"], counts: { pc: 1 } });
  await drive();

  const urls = searchUrls().join(" ");
  assert.ok(urls.includes("q=safe"));
  assert.ok(!urls.includes("q=quizzy"), "quiz was automated");
  assert.ok(!urls.includes("q=thisorthat"), "this-or-that was automated");
});

test("offers pointing off Microsoft's domains are never opened", async () => {
  await boot(
    dashboardPayload({
      offers: [offer("evil", { destinationUrl: "https://attacker.example/steal" })],
    })
  );
  await runner.start({ modes: ["pc"], counts: { pc: 1 } });
  await drive();

  const urls = stub.calls.filter((c) => c.api === "tabs.update" && c.args[1].url).map((c) => c.args[1].url);
  assert.ok(!urls.some((u) => u.includes("attacker.example")));
});

test("the daily activity ceiling is respected", async () => {
  const many = Array.from({ length: 25 }, (_, i) => offer(`a${i}`));
  await boot(dashboardPayload({ offers: many }));
  await runner.saveSettings({ activities: { enabled: true, maxPerDay: 4 } });
  await runner.start({ modes: ["pc"], counts: { pc: 1 } });
  await drive();

  const today = Object.values(await runner.getHistory())[0];
  assert.equal(today.activity, 4);
});

test("activities can be switched off entirely", async () => {
  await boot(dashboardPayload({ offers: [offer("a"), offer("b")] }));
  await runner.saveSettings({ activities: { enabled: false, maxPerDay: 12 } });
  await runner.start({ modes: ["pc"], counts: { pc: 2 } });
  const final = await drive();

  assert.equal(final.totalDone, 2, "searches only");
  const today = Object.values(await runner.getHistory())[0];
  assert.equal(today.activity, undefined);
});

test("a day with only activities left still runs", async () => {
  await boot(dashboardPayload({ pc: [90, 90], mobile: [60, 60], offers: [offer("a")] }));
  const result = await runner.start({ modes: ["pc", "mobile"], counts: { pc: 30, mobile: 20 } });
  assert.equal(result.started, true);
  const final = await drive();
  assert.equal(final.totalDone, 1);
  await runner.stop("test");
});

// -------------------------------------------------------------- still hidden

test("activities obey the same hidden-window rules as searches", async () => {
  await boot(dashboardPayload({ offers: [offer("a"), offer("b")] }));
  const userTab = stub.addForeignTab();
  await runner.start({ modes: ["pc"], counts: { pc: 1 } });
  await drive();

  const updates = stub.calls.filter((c) => c.api === "tabs.update");
  assert.ok(!updates.some((c) => c.args[0] === userTab.id));
  assert.ok(!updates.some((c) => c.args[1]?.active === true));
  assert.ok(!updates.some((c) => c.windowId === stub.userWindowId));
});

test("the popup snapshot exposes the real point balance", async () => {
  await boot(dashboardPayload({ pc: [30, 90] }));
  await runner.start({ modes: ["pc"], counts: { pc: 2 } });
  await drive();

  const snap = await runner.snapshot();
  assert.equal(snap.dashboard.availablePoints, 5000);
  assert.equal(snap.dashboard.counters.pc.current, 36, "the live counter, two credited searches on");
  assert.equal(snap.dashboard.level, "newLevel2");
  assert.equal(snap.dashboard.rank.key, "newLevel2", "the rank the popup shows rides along");
  assert.equal(snap.dashboard.todayPoints, 42);
  await runner.stop("test");
});

test("a failed live refresh keeps the last good numbers on screen", async () => {
  await boot(dashboardPayload({ pc: [12, 90] }));
  await runner.refreshDashboard();
  globalThis.fetch = async () => {
    throw new Error("offline for a moment");
  };
  await runner.refreshDashboard();

  const snap = await runner.snapshot();
  assert.equal(snap.dashboard.counters.pc.current, 12, "the popup must not go blank");
  assert.ok(snap.dashboard.failedAt >= snap.dashboard.readAt, "the failure is still visible");
});

test("a newer reading clears the failure mark", async () => {
  await boot(dashboardPayload({ pc: [12, 90] }));
  const ok = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline for a moment");
  };
  await runner.refreshDashboard();
  globalThis.fetch = ok;
  await runner.refreshDashboard();

  const snap = await runner.snapshot();
  assert.equal(snap.dashboard.failedAt ?? null, null);
  assert.equal(snap.dashboard.counters.pc.current, 12);
});

// ------------------------------------------------------------ reporting to Bing

const reports = () =>
  stub.calls.filter(
    (c) => c.api === "scripting.executeScript" && c.args[1]?.func === "reportActivityInPage"
  );

test("an activity is reported to Bing before its page opens, like a real click", async () => {
  await boot(dashboardPayload({ pc: [90, 90], mobile: [60, 60], offers: [offer("a")] }));
  await runner.start({ modes: ["pc"], counts: { pc: 1 } });
  await drive();

  const [report] = reports();
  assert.ok(report, "Bing's reportactivity call was never made");
  assert.deepEqual(report.args[1].args[0], {
    ActivityType: "urlreward",
    ActivitySubType: "",
    OfferId: "a",
    Channel: "BingFlyout",
    PartnerId: "BingRewards",
    UserId: "user-1",
    AuthKey: "hash-a",
    ActivityCount: 1,
  });

  const reportAt = stub.calls.indexOf(report);
  const openAt = stub.calls.findIndex(
    (c) => c.api === "tabs.update" && c.args[1].url === "https://www.bing.com/search?q=a"
  );
  const flyoutAt = stub.calls.findIndex(
    (c) => c.api === "tabs.update" && String(c.args[1].url).includes("/rewards/panelflyout")
  );
  assert.ok(flyoutAt >= 0 && flyoutAt < reportAt, "the report must come from a bing.com page");
  assert.ok(reportAt < openAt, "Bing reports the click, then navigates");
});

test("an offer without an auth key is only opened", async () => {
  await boot(
    dashboardPayload({ pc: [90, 90], mobile: [60, 60], offers: [offer("a", { hash: null })] })
  );
  await runner.start({ modes: ["pc"], counts: { pc: 1 } });
  await drive();

  assert.equal(reports().length, 0);
  assert.ok(searchUrls().some((u) => u.includes("q=a")));
});

test("the popup lists every task with its state, open ones first", async () => {
  await boot(
    dashboardPayload({
      pc: [12, 90],
      offers: [
        offer("link", { pointProgressMax: 10 }),
        offer("quizzy", { promotionType: "quiz", pointProgressMax: 30 }),
        offer("finished", { complete: true, pointProgress: 5, pointProgressMax: 5 }),
      ],
    })
  );
  await runner.refreshDashboard();
  const { tasks } = await runner.snapshot();

  assert.deepEqual(
    tasks.items.map(({ title, points, state }) => ({ title, points, state })),
    [
      { title: "link", points: 10, state: "auto" },
      { title: "quizzy", points: 30, state: "manual" },
      { title: "finished", points: 5, state: "done" },
    ]
  );
  assert.equal(tasks.done, 1);
  assert.equal(tasks.total, 3);
  assert.equal(tasks.pointsLeft, 40);
});

// ------------------------------------------------------ Bing's search limiter

/**
 * Measured on a real account on 2026-09-28: after a first few credited
 * searches, Bing credits a mobile search only when nothing was searched in
 * the ~7 minutes before it and the last credited one is ~20+ minutes old.
 * Searching harder in between earned nothing and seemed to extend the lock.
 */

/** Steps the run until `count` searches have gone out; returns the state. */
async function stepUntilSearches(count, maxSteps = 80) {
  for (let i = 0; i < maxSteps; i++) {
    if (searchesMade().length >= count) break;
    const { "run.v3": state } = await stub.storage.local.get("run.v3");
    if (["done", "error", "idle"].includes(state.status)) break;
    await stub.storage.local.set({ "run.v3": { ...state, nextActionAt: 0 } });
    await runner.step();
  }
  return (await stub.storage.local.get("run.v3"))["run.v3"];
}

test("the first search Bing refuses switches the leg to one search every ~21 minutes", async () => {
  await boot(dashboardPayload({ mobile: [0, 60] }), { credit: (mode, i) => i < 2 });
  await runner.start({ modes: ["mobile"], counts: { mobile: 5 } });

  const before = Date.now();
  const state = await stepUntilSearches(3);
  assert.equal(state.throttled, true);
  assert.equal(state.doneInLeg, 2, "a search that earned nothing does not count");
  const wait = state.nextActionAt - before;
  assert.ok(wait >= THROTTLE.gapMs, `waits ${Math.round(wait / 60000)} min`);
  assert.ok(wait <= THROTTLE.gapMs + THROTTLE.jitterMs + 5000);

  const snap = await runner.snapshot();
  assert.equal(snap.throttled, true, "the popup is told why it waits so long");
  await runner.stop("test");
});

test("searches Bing refused do not use up the leg", async () => {
  // Credited, credited, refused, refused, then credited again.
  await boot(dashboardPayload({ mobile: [0, 60] }), { credit: (mode, i) => i !== 2 && i !== 3 });
  await runner.start({ modes: ["mobile"], counts: { mobile: 4 } });
  const final = await drive();

  assert.equal(final.status, "done");
  assert.equal(searchesMade().length, 6, "4 credited searches took 6 tries");
  const snap = await runner.snapshot();
  assert.equal(snap.dashboard.counters.mobile.current, 12);
});

test("a credit while limited keeps the slow pace rather than bursting", async () => {
  // Every search after a credit went uncredited in the measurements.
  await boot(dashboardPayload({ mobile: [0, 60] }), { credit: (mode, i) => i !== 1 });
  await runner.start({ modes: ["mobile"], counts: { mobile: 5 } });

  const before = Date.now();
  const state = await stepUntilSearches(3); // credited, refused, credited
  assert.equal(state.throttled, true);
  assert.ok(state.nextActionAt - before >= THROTTLE.gapMs);
  await runner.stop("test");
});

test("each credit while limited lengthens the next wait, as Bing's lock escalates", async () => {
  // credited (burst), refused (limited from here), credited, credited
  await boot(dashboardPayload({ mobile: [0, 60] }), { credit: (mode, i) => i !== 1 });
  await runner.start({ modes: ["mobile"], counts: { mobile: 6 } });

  const waits = [];
  for (const n of [3, 4]) {
    const before = Date.now();
    const state = await stepUntilSearches(n);
    waits.push(state.nextActionAt - before);
  }
  const growth = THROTTLE.gapMs * THROTTLE.growth;
  assert.ok(waits[0] >= growth, "after the first credit while limited: gap × growth");
  assert.ok(waits[1] >= growth * THROTTLE.growth, "after the second: one more step of growth");
  assert.ok(waits[1] > waits[0]);
  await runner.stop("test");
});

test("each refusal in a row stretches the wait, up to a ceiling", async () => {
  await boot(dashboardPayload({ mobile: [0, 60] }), { credit: () => false });
  await runner.start({ modes: ["mobile"], counts: { mobile: 5 } });

  const waits = [];
  for (let n = 1; n <= THROTTLE.maxMisses - 1; n++) {
    const before = Date.now();
    const state = await stepUntilSearches(n);
    waits.push(state.nextActionAt - before);
  }
  for (let i = 1; i < waits.length; i++) {
    assert.ok(waits[i] + THROTTLE.jitterMs >= waits[i - 1], "never shrinks");
  }
  assert.ok(Math.max(...waits) <= THROTTLE.maxGapMs + THROTTLE.jitterMs + 5000);
  assert.ok(waits.at(-1) > waits[0], "it does stretch");
  await runner.stop("test");
});

test("a leg Bing keeps refusing gives up instead of searching forever", async () => {
  await boot(dashboardPayload({ mobile: [0, 60] }), { credit: () => false });
  await runner.start({ modes: ["mobile"], counts: { mobile: 5 } });
  const final = await drive();

  assert.equal(final.status, "done");
  assert.equal(searchesMade().length, THROTTLE.maxMisses);
});

test("a limited mobile leg does not slow the PC leg", async () => {
  await boot(dashboardPayload({ pc: [0, 90], mobile: [0, 60] }), {
    credit: (mode, i) => mode === "pc" || i === 0,
  });
  await runner.start({ modes: ["pc", "mobile"], counts: { pc: 3, mobile: 2 } });

  // The PC leg runs first and is credited throughout: normal short gaps.
  for (let n = 1; n <= 3; n++) {
    const before = Date.now();
    const state = await stepUntilSearches(n);
    assert.equal(state.throttled ?? false, false);
    assert.ok(state.nextActionAt - before < THROTTLE.gapMs);
  }
  await runner.stop("test");
});

// -------------------------------------------------------------------- quests

test("a quest activity unlocked today is done like any offer: reported, then opened", async () => {
  await boot(dashboardPayload({ pc: [90, 90], mobile: [60, 60] }), {
    quests: {
      [MONTHLY]: questHtml({ children: [child(2, { locked: false }), child(3, { locked: true })] }),
      [APP_WEEKLY]: questHtml({ title: "Rewards App weekly Exclusive Quest", description: "you must complete the activities in the Desktop Rewards app", children: [child(5)] }),
    },
  });
  const result = await runner.start();
  assert.equal(result.started, true);
  await drive();

  const reports = stub.calls.filter((c) => c.api === "scripting.executeScript" && c.args[1]?.func === "reportActivityInPage");
  assert.deepEqual(reports.map((c) => c.args[1].args[0].OfferId), ["ENWW_pcchild2_urlreward_FY27_BingMonthlyPC_Sep_punchcard"]);
  assert.equal(reports[0].args[1].args[0].AuthKey.length, 64);
  const opened = stub.calls.filter((c) => c.api === "tabs.update" && c.args[1].url).map((c) => c.args[1].url);
  assert.ok(opened.some((u) => u.includes("NFL+Schedule+2026")), "the activity's own page is opened");
});

test("quests appear in the task list with their progress and state", async () => {
  await boot(dashboardPayload({ offers: [offer("link")] }), {
    quests: {
      [MONTHLY]: questHtml({ progress: "1/4", children: [child(2, { locked: true })] }),
      [APP_WEEKLY]: questHtml({ title: "Rewards App weekly Exclusive Quest", progress: "1/8", points: null, description: "you must complete the activities in the Desktop Rewards app.(0/70)", children: [child(5, { locked: true })] }),
    },
  });
  await runner.refreshDashboard();
  const { tasks, nextPlan } = await runner.snapshot();

  const monthly = tasks.items.find((t) => t.id === MONTHLY);
  assert.deepEqual(monthly.quest, { done: 1, total: 4, expiresAt: "2026-10-01T07:00:00.000Z" });
  assert.equal(monthly.state, "locked", "its next activity unlocks tomorrow");
  const app = tasks.items.find((t) => t.id === APP_WEEKLY);
  assert.equal(app.state, "app");
  assert.equal(app.app, "desktop", "the popup can say it is the Windows app");
  assert.equal(app.points, 70);
  assert.equal(nextPlan.activities, 1, "only the dashboard offer can run now");
});

test("a lapsed rewards.bing.com sign-in is renewed by opening the Earn page, then quests are read", async () => {
  // The site signs in through a redirect flow only a real page load finishes.
  let visited = false;
  await boot(dashboardPayload({ pc: [90, 90], mobile: [60, 60] }), {
    quests: { [MONTHLY]: questHtml({ children: [child(2, { locked: false })] }) },
  });
  const served = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://rewards.bing.com/") && !visited) {
      visited = stub.calls.some((c) => c.api === "tabs.update" && String(c.args[1].url).startsWith("https://rewards.bing.com/earn"));
      if (!visited) return { ok: true, status: 200, url: "https://login.live.com/oauth20_authorize.srf", text: async () => "login" };
    }
    return served(url);
  };

  const result = await runner.start();
  assert.equal(result.started, true, "the quest activity found after signing in is run");
  const opened = stub.calls.filter((c) => c.api === "tabs.update" && c.args[1].url).map((c) => c.args[1].url);
  assert.ok(opened.some((u) => u.startsWith("https://rewards.bing.com/earn")), "the Earn page was opened hidden");
  await runner.stop("test");
});

// ---------------------------------------------------------- click to collect

const created = () => stub.calls.filter((c) => c.api === "tabs.create").map((c) => c.args[0]);
const reported = () =>
  stub.calls
    .filter((c) => c.api === "scripting.executeScript" && c.args[1]?.func === "reportActivityInPage")
    .map((c) => c.args[1].args[0]);

test("clicking an open task opens it for the user and reports it, like the Rewards page", async () => {
  await boot(dashboardPayload({ offers: [offer("link")] }));
  await runner.refreshDashboard();
  const result = await runner.doTask("link");

  assert.equal(result.ok, true);
  assert.deepEqual(created(), [{ url: "https://www.bing.com/search?q=link", active: true }]);
  assert.equal(reported().length, 1);
  assert.equal(reported()[0].OfferId, "link");
  assert.equal(reported()[0].AuthKey, "hash-link");
  assert.equal(reported()[0].UserId, "user-1");
});

test("clicking a finished task only opens it", async () => {
  await boot(dashboardPayload({ offers: [offer("old", { complete: true, pointProgress: 10 })] }));
  await runner.refreshDashboard();
  await runner.doTask("old");
  assert.equal(created().length, 1);
  assert.equal(reported().length, 0);
});

test("clicking a quest does its unlocked activity", async () => {
  await boot(dashboardPayload({}), { quests: { [MONTHLY]: questHtml({ children: [child(2, { locked: false })] }) } });
  await runner.refreshDashboard();
  await runner.doTask(MONTHLY);
  assert.match(created()[0].url, /NFL\+Schedule\+2026/);
  assert.equal(reported()[0].OfferId, "ENWW_pcchild2_urlreward_FY27_BingMonthlyPC_Sep_punchcard");
});

test("clicking a locked or app-only quest opens its quest page", async () => {
  await boot(dashboardPayload({}), { quests: { [MONTHLY]: questHtml({ children: [child(2, { locked: true })] }) } });
  await runner.refreshDashboard();
  await runner.doTask(MONTHLY);
  assert.deepEqual(created(), [{ url: `https://rewards.bing.com/earn/quest/${MONTHLY}`, active: true }]);
  assert.equal(reported().length, 0);
});

test("while a run is going, a click only opens the link and leaves the hidden window alone", async () => {
  await boot(dashboardPayload({ pc: [0, 90], offers: [offer("link")] }));
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  const before = reported().length;
  await runner.doTask("link");
  assert.equal(created().length, 1);
  assert.equal(reported().length, before, "no report squeezed into the running window");
  await runner.stop("test");
});

test("an unknown task opens nothing", async () => {
  await boot(dashboardPayload({}));
  await runner.refreshDashboard();
  const result = await runner.doTask("nope");
  assert.equal(result.ok, false);
  assert.equal(created().length, 0);
});

// ------------------------------------------------- points earned elsewhere

test("points earned elsewhere between searches are never credited to the run", async () => {
  // Seen for real: a hand search on the phone at 18:07 was booked as the
  // run's own credit at 18:24, against a baseline read at 18:04.
  const elsewhere = { mobile: 0 };
  await boot(dashboardPayload({ mobile: [0, 60] }), { credit: (mode, i) => i === 0, elsewhere });
  await runner.start({ modes: ["mobile"], counts: { mobile: 5 } });

  await stepUntilSearches(1); // credited
  elsewhere.mobile = 3; // the phone earns a search's worth by hand
  const state = await stepUntilSearches(2); // Bing refuses the run's own search

  assert.equal(state.throttled, true, "the run's search was refused, whatever the phone did");
  assert.equal(state.misses, 1);
  assert.equal(state.doneInLeg, 1);
  await runner.stop("test");
});

test("a counter filled elsewhere ends the leg without another search", async () => {
  const elsewhere = { mobile: 0 };
  await boot(dashboardPayload({ mobile: [0, 60] }), { elsewhere });
  await runner.start({ modes: ["mobile"], counts: { mobile: 5 } });

  await stepUntilSearches(1);
  elsewhere.mobile = 60; // finished by hand on the phone
  const final = await drive();
  assert.equal(final.status, "done");
  assert.equal(searchesMade().length, 1, "no search once the counter is full");
});

test("today's points come from the balance, so app points the counter misses are included", async () => {
  await boot(dashboardPayload({ pc: [90, 90] })); // balance 5000; DailyPoint says 42
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const { dateKey } = await import("../src/core/quota.js");
  await stub.storage.local.set({
    "balance.v1": { day: dateKey(yesterday), baseline: 4700, last: 4800, exact: true },
  });

  await runner.refreshDashboard({ quests: false });

  const { dashboard } = await runner.snapshot();
  assert.equal(dashboard.todayPoints, 42, "Rewards' own counter, unchanged");
  assert.equal(dashboard.earnedToday, 200, "5000 now over 4800 at yesterday's last reading");
  assert.equal(dashboard.earnedExact, true);
});
