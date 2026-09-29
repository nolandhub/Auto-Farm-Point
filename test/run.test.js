import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";

/**
 * Drives a whole run against a stubbed Chrome. The point of this file is the
 * bug the user reported: the extension must never touch a tab outside its own
 * hidden window, and the hidden window must never be focused.
 */

let chromeStub;
let runner;

async function loadFresh() {
  chromeStub = makeChrome();
  globalThis.chrome = chromeStub;
  globalThis.fetch = () => Promise.reject(new Error("offline in tests"));
  // Fresh module registry per run so module-level state does not leak.
  runner = await import(`../src/core/runner.js?v=${Math.random()}`);
  // Reading a clicked result takes seconds for real; tests need not wait.
  Object.assign(runner.tuning, { readMinMs: 0, readMaxMs: 0, serpDwellMs: 0 });
}

/** Pulls the scheduled wait forward so the machine can be stepped in-process. */
async function forceDue() {
  const key = "run.v3";
  const stored = await chromeStub.storage.local.get(key);
  await chromeStub.storage.local.set({ [key]: { ...stored[key], nextActionAt: 0 } });
}

async function drive(maxSteps = 40) {
  for (let i = 0; i < maxSteps; i++) {
    const { "run.v3": state } = await chromeStub.storage.local.get("run.v3");
    if (state.status === "done" || state.status === "error" || state.status === "idle") return state;
    await forceDue();
    await runner.step();
  }
  throw new Error("run did not finish within the step budget");
}

test("the hidden window is created unfocused and minimized", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  await drive();

  const creates = chromeStub.calls.filter((c) => c.api === "windows.create");
  assert.ok(creates.length >= 1, "a window should have been created");
  for (const call of creates) {
    assert.equal(call.args[0].focused, false, "window must never be focused");
    assert.equal(call.args[0].state, "minimized", "window must be born minimized");
  }
  await runner.stop("test");
});

test("no tab outside the hidden window is ever touched", async () => {
  await loadFresh();
  // A tab the user is reading, in their own window.
  const userTab = chromeStub.addForeignTab();
  await runner.start({ modes: ["pc"], counts: { pc: 4 } });
  await drive();

  const touched = chromeStub.calls
    .filter((c) => c.api === "tabs.update")
    .map((c) => c.args[0]);
  assert.ok(touched.length > 0, "the worker tab should have been navigated");
  assert.ok(!touched.includes(userTab.id), `user tab ${userTab.id} was navigated`);
  await runner.stop("test");
});

test("nothing ever asks for a tab to be activated or focused", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  await drive();

  const activated = chromeStub.calls.filter(
    (c) => c.api === "tabs.update" && c.args[1]?.active === true
  );
  assert.equal(activated.length, 0, "v2.4 activated the search tab on every cycle");

  const focused = chromeStub.calls.filter(
    (c) => c.api === "windows.update" && c.args[1]?.focused === true
  );
  assert.equal(focused.length, 0, "the hidden window must never be raised");
  await runner.stop("test");
});

test("the run never borrows the window the user is working in", async () => {
  await loadFresh();
  const userWindowId = chromeStub.userWindowId;
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  await drive();

  const navigated = chromeStub.calls.filter((c) => c.api === "tabs.update");
  assert.ok(navigated.length > 0);
  for (const call of navigated) {
    assert.notEqual(call.windowId, userWindowId, "searched inside the user's window");
  }
  await runner.stop("test");
});

test("a full run performs exactly the planned number of searches", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 5 } });
  const final = await drive();

  assert.equal(final.status, "done");
  assert.equal(final.totalDone, 5);

  const searches = chromeStub.calls.filter(
    (c) => c.api === "tabs.update" && String(c.args[1].url).includes("/search?q=")
  );
  assert.equal(searches.length, 5);
  await runner.stop("test");
});

test("each search uses a different query", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 8 } });
  await drive();

  const queries = chromeStub.calls
    .filter((c) => c.api === "tabs.update" && String(c.args[1].url).includes("/search?q="))
    .map((c) => new URL(c.args[1].url).searchParams.get("q"));
  assert.equal(new Set(queries).size, queries.length, `repeats in: ${queries.join(" | ")}`);
  assert.ok(queries.every((q) => !/\s\d+$/.test(q)), "no numeric-suffix queries");
  await runner.stop("test");
});

test("today's history records every completed search", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 4 } });
  await drive();

  const history = await runner.getHistory();
  const today = Object.values(history)[0];
  assert.equal(today.pc, 4);
  await runner.stop("test");
});

test("the hidden window is closed when the run finishes", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  await drive();

  assert.ok(
    chromeStub.calls.some((c) => c.api === "windows.remove"),
    "finishing must free the window, not leave a rewards tab parked"
  );
  assert.equal(chromeStub.openWindows().length, 1, "only the user's window should remain");
  await runner.stop("test");
});

test("mobile mode installs the header override before the first search", async () => {
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 3 } });
  await drive();

  const ruleCalls = chromeStub.calls.filter((c) => c.api === "dnr.updateSessionRules");
  const applied = ruleCalls.find((c) => c.args[0].addRules?.length);
  assert.ok(applied, "no mobile session rule was added");

  const headers = applied.args[0].addRules[0].action.requestHeaders.map((h) => h.header);
  assert.deepEqual(
    headers.sort(),
    [
      "sec-ch-ua",
      "sec-ch-ua-arch",
      "sec-ch-ua-bitness",
      "sec-ch-ua-form-factors",
      "sec-ch-ua-full-version",
      "sec-ch-ua-full-version-list",
      "sec-ch-ua-mobile",
      "sec-ch-ua-model",
      "sec-ch-ua-platform",
      "sec-ch-ua-platform-version",
      "sec-ch-ua-wow64",
      "sec-ms-gec",
      "sec-ms-gec-version",
      "user-agent",
      "x-client-data",
      "x-edge-shopping-flag",
    ],
    "UA and every client hint Bing asks for must move together, and Edge's own markers go"
  );

  const ruleIndex = chromeStub.calls.indexOf(applied);
  const firstSearch = chromeStub.calls.findIndex(
    (c) => c.api === "tabs.update" && String(c.args[1].url).includes("/search?q=")
  );
  assert.ok(ruleIndex < firstSearch, "the rule must exist before the request goes out");
  await runner.stop("test");
});

test("the mobile rule is scoped to the worker tab alone", async () => {
  await loadFresh();
  const userTab = chromeStub.addForeignTab();
  await runner.start({ modes: ["mobile"], counts: { mobile: 2 } });
  await drive();

  const applied = chromeStub.calls.find(
    (c) => c.api === "dnr.updateSessionRules" && c.args[0].addRules?.length
  );
  const tabIds = applied.args[0].addRules[0].condition.tabIds;
  assert.equal(tabIds.length, 1);
  assert.notEqual(tabIds[0], userTab.id, "the user's tab must not be spoofed");
  await runner.stop("test");
});

test("the mobile identity is removed once the run ends", async () => {
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 2 } });
  await drive();

  const removals = chromeStub.calls.filter(
    (c) => c.api === "dnr.updateSessionRules" && c.args[0].removeRuleIds?.length
  );
  assert.ok(removals.length > 0, "the session rule must be torn down");
  assert.equal(chromeStub.sessionRules.size, 0, "no rule may survive the run");
  await runner.stop("test");
});

test("the mobile page is closed before its identity is dropped", async () => {
  // Pages keep sending (images, unload beacons) until their window is gone; any
  // request after the rule is removed leaves the "phone" as a desktop.
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 2 } });
  await drive();

  const lastClose = chromeStub.calls.findLastIndex((c) => c.api === "windows.remove");
  const lastClear = chromeStub.calls.findLastIndex(
    (c) => c.api === "dnr.updateSessionRules" && !c.args[0].addRules
  );
  assert.ok(lastClose >= 0 && lastClear >= 0);
  assert.ok(lastClose < lastClear, "the rule was removed while the mobile page was still open");
  await runner.stop("test");
});

const searchReports = () =>
  chromeStub.calls.filter(
    (c) => c.api === "scripting.executeScript" && c.args[1]?.func === "reportSearchInPage"
  );

test("each mobile search is reported to Rewards from the phone tab", async () => {
  // Bing's mobile results page never sends /rewardsapp/reportActivity, which
  // is the call that credits a search; the desktop page sends it itself.
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 3 } });
  await drive();

  const reports = searchReports();
  assert.equal(reports.length, 3, "one report per mobile search");
  for (const call of reports) {
    assert.equal(call.args[1].world, "MAIN", "it needs the page's own _G.IG");
    assert.notEqual(call.args[0], chromeStub.userWindowId);
  }

  // Each report must go out while the phone identity is still on that tab.
  const rules = chromeStub.calls.filter((c) => c.api === "dnr.updateSessionRules");
  const lastClear = chromeStub.calls.lastIndexOf(rules.filter((c) => !c.args[0].addRules).at(-1));
  assert.ok(chromeStub.calls.lastIndexOf(reports.at(-1)) < lastClear);
  await runner.stop("test");
});

test("desktop searches are left to the results page's own report", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  await drive();
  assert.equal(searchReports().length, 0);
  await runner.stop("test");
});

test("the page is unloaded before its window closes", async () => {
  // Beacons from a closing window lose their tab id and escape the tab-scoped
  // rule; unloading first sends them while the tab still exists.
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 1 } });
  await drive();

  const closeAt = chromeStub.calls.findLastIndex((c) => c.api === "windows.remove");
  const before = chromeStub.calls.slice(0, closeAt).filter((c) => c.api === "tabs.update");
  assert.equal(before.at(-1).args[1].url, "about:blank");
  await runner.stop("test");
});

test("a both-modes run switches identity and does each leg in full", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc", "mobile"], counts: { pc: 3, mobile: 2 } });
  const final = await drive();

  assert.equal(final.status, "done");
  assert.equal(final.totalDone, 5);

  const searches = chromeStub.calls
    .filter((c) => c.api === "tabs.update" && String(c.args[1].url).includes("/search?q="))
    .map((c) => new URL(c.args[1].url).searchParams.get("form"));
  assert.deepEqual(searches, ["QBLH", "QBLH", "QBLH", "MOSBSB", "MOSBSB"]);

  const history = await runner.getHistory();
  assert.deepEqual(Object.values(history)[0], { pc: 3, mobile: 2 });
  await runner.stop("test");
});

test("offline, a bare start runs both devices up to the default targets", async () => {
  await loadFresh();
  await runner.start();
  const final = await drive(80);
  assert.equal(final.status, "done");
  const history = await runner.getHistory();
  assert.deepEqual(Object.values(history)[0], { pc: 30, mobile: 20 });
  await runner.stop("test");
});

test("the daily run covers both devices", async () => {
  await loadFresh();
  await runner.runDaily();
  const { "run.v3": state } = await chromeStub.storage.local.get("run.v3");
  assert.deepEqual(
    state.plan.map((leg) => leg.mode),
    ["pc", "mobile"]
  );
  await runner.stop("test");
});

/** Daily settings whose time of day passed a few minutes ago. */
function dailyJustPassed(lastDailyRun = null) {
  const past = new Date(Date.now() - 5 * 60_000);
  return { daily: { enabled: true, hour: past.getHours(), minute: past.getMinutes() }, lastDailyRun };
}
const crossesMidnight = () => new Date(Date.now() - 5 * 60_000).getDate() !== new Date().getDate();

test("a daily run missed while the browser was closed is caught up the same day", async (t) => {
  if (crossesMidnight()) return t.skip("the scheduled time falls on yesterday");
  await loadFresh();
  await chromeStub.storage.local.set({ "settings.v3": dailyJustPassed() });
  await runner.restore(); // browser start: no daily alarm survived

  const alarm = await chromeStub.alarms.get("daily");
  assert.ok(alarm, "a daily alarm must be armed");
  assert.ok(alarm.scheduledTime - Date.now() < 10 * 60_000, "today's run is caught up within minutes");
});

test("a daily run already done today is not caught up again", async (t) => {
  if (crossesMidnight()) return t.skip("the scheduled time falls on yesterday");
  await loadFresh();
  const { dateKey } = await import("../src/core/quota.js");
  await chromeStub.storage.local.set({ "settings.v3": dailyJustPassed(dateKey()) });
  await runner.restore();

  const alarm = await chromeStub.alarms.get("daily");
  assert.ok(alarm.scheduledTime - Date.now() > 20 * 3600_000, "next run is tomorrow");
});

test("after the daily run fires, the next one is tomorrow, not later today", async (t) => {
  if (crossesMidnight()) return t.skip("the scheduled time falls on yesterday");
  await loadFresh();
  // Today's slot plus its jitter can still be ahead; it must not be reused.
  await chromeStub.storage.local.set({ "settings.v3": dailyJustPassed() });
  await runner.runDaily();

  const alarm = await chromeStub.alarms.get("daily");
  assert.ok(alarm.scheduledTime - Date.now() > 20 * 3600_000, "next run is tomorrow");
  await runner.stop("test");
});

test("the daily trigger never tramples a run already in progress", async () => {
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 3 } });
  const { "run.v3": before } = await chromeStub.storage.local.get("run.v3");

  await runner.runDaily();
  const { "run.v3": after } = await chromeStub.storage.local.get("run.v3");
  assert.equal(after.startedAt, before.startedAt, "the running run must be left alone");
  assert.deepEqual(after.plan, before.plan);
  await runner.stop("test");
});

test("a run still going when the day ends stops instead of carrying into the new day", async () => {
  // Rewards counters reset daily; yesterday's baseline would read every
  // search of the new day as refused.
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 5 } });
  const { "run.v3": state } = await chromeStub.storage.local.get("run.v3");
  const yesterday = Date.now() - 24 * 3600_000;
  await chromeStub.storage.local.set({ "run.v3": { ...state, startedAt: yesterday, nextActionAt: 0 } });

  await runner.step();
  const { "run.v3": after } = await chromeStub.storage.local.get("run.v3");
  assert.equal(after.status, "done");
  const searches = chromeStub.calls.filter((c) => c.api === "tabs.update" && String(c.args[1].url).includes("/search?q="));
  assert.equal(searches.length, 0, "no search is made on the new day by the old run");
  await runner.stop("test");
});

test("re-running the same day tops up instead of starting over", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  await drive();

  const second = await runner.start({ modes: ["pc"], counts: { pc: 5 } });
  assert.equal(second.started, true);
  await drive();

  const history = await runner.getHistory();
  assert.equal(Object.values(history)[0].pc, 5, "should top up to 5, not run 5 more");
  await runner.stop("test");
});

test("starting when the target is already met does nothing", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  await drive();

  const again = await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  assert.equal(again.started, false);
  assert.equal(again.reason, "allDone");
  await runner.stop("test");
});

test("a closed hidden window is recreated and the run continues", async () => {
  await loadFresh();
  await runner.start({ modes: ["pc"], counts: { pc: 4 } });

  await forceDue();
  await runner.step();
  chromeStub.closeWorkerWindow(); // the user closes it by hand
  const final = await drive();

  assert.equal(final.status, "done");
  assert.equal(final.totalDone, 4);
  await runner.stop("test");
});

test("a run survives transient navigation failures", async () => {
  await loadFresh();
  chromeStub.failNextUpdates(2);
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  const final = await drive();

  assert.equal(final.status, "done", `ended as ${final.status}: ${final.lastError}`);
  assert.equal(final.totalDone, 3);
  await runner.stop("test");
});

test("a persistently broken browser stops the run instead of looping forever", async () => {
  await loadFresh();
  chromeStub.failNextUpdates(999);
  await runner.start({ modes: ["pc"], counts: { pc: 3 } });
  const final = await drive();

  assert.equal(final.status, "error");
  assert.ok(final.failures >= 5);
  assert.equal(chromeStub.openWindows().length, 1, "must not leak a window on failure");
  await runner.stop("test");
});

test("stopping mid-run closes the window and clears the identity", async () => {
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 10 } });
  await forceDue();
  await runner.step();

  await runner.stop("user");
  const { "run.v3": state } = await chromeStub.storage.local.get("run.v3");
  assert.equal(state.status, "idle");
  assert.equal(chromeStub.openWindows().length, 1);
  assert.equal(chromeStub.sessionRules.size, 0);
});

test("the offline fallback still produces a full run", async () => {
  await loadFresh(); // fetch is already stubbed to reject
  await runner.start({ modes: ["pc"], counts: { pc: 6 } });
  const final = await drive();
  assert.equal(final.totalDone, 6, "local topics must carry a run with no network");
  await runner.stop("test");
});

test("the snapshot names the worker's build, so a popup can spot a stale worker", async () => {
  // Edge keeps an unpacked extension's service worker code until Reload, while
  // popup files load fresh: after an update the two can disagree.
  await loadFresh();
  const { BUILD } = await import("../src/core/constants.js");
  const snap = await runner.snapshot();
  assert.equal(snap.build, BUILD);
  assert.match(BUILD, /\S/);
});


// ---------------------------------------------------------- reading results

const clicks = () =>
  chromeStub.calls.filter((c) => c.api === "scripting.executeScript" && c.args[1]?.func === "clickResult");
const backs = () => chromeStub.calls.filter((c) => c.api === "tabs.goBack");

test("each mobile search opens a result, reads it, and comes back, like a person", async () => {
  // The user noticed searches that click through to a result get credited.
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 2 } });
  await drive();

  assert.equal(clicks().length, 2, "one result opened per search");
  assert.equal(backs().length, 2, "and back to the results each time");
  const worker = clicks()[0].args[0];
  assert.ok([...clicks(), ...backs()].every((c) => c.args[0] === worker), "only in the hidden tab");
  assert.notEqual(worker, chromeStub.userWindowId);

  // Search, open a result, come back: in that order for each search.
  const order = chromeStub.calls
    .filter((c) => (c.api === "tabs.update" && String(c.args[1].url).includes("/search?q=")) || c.api === "tabs.goBack" || c.args?.[1]?.func === "clickResult")
    .map((c) => (c.api === "tabs.update" ? "search" : c.api === "tabs.goBack" ? "back" : "open"));
  assert.deepEqual(order, ["search", "open", "back", "search", "open", "back"]);
  await runner.stop("test");
});

test("a results page with nothing to click is simply left", async () => {
  await loadFresh();
  chromeStub.resultsClickable = false;
  await runner.start({ modes: ["mobile"], counts: { mobile: 1 } });
  const final = await drive();
  assert.equal(final.totalDone, 1);
  assert.equal(backs().length, 0, "no back without a visit");
  await runner.stop("test");
});

test("the hidden tab is muted, since opened results can play sound", async () => {
  await loadFresh();
  await runner.start({ modes: ["mobile"], counts: { mobile: 1 } });
  await drive();
  const muted = chromeStub.calls.filter((c) => c.api === "tabs.update" && c.args[1]?.muted === true);
  assert.ok(muted.length >= 1);
  await runner.stop("test");
});

test("handing over to TheNetsky ends a run and leaves nothing that could start one", async () => {
  await loadFresh();
  await runner.saveSettings({ daily: { enabled: true, hour: 9, minute: 0 } });
  await runner.start({ modes: ["pc"], counts: { pc: 5 } });
  runner.ensureWatchdog();

  await runner.retire();

  const { "run.v3": state } = await chromeStub.storage.local.get("run.v3");
  assert.equal(state.status, "idle");
  for (const name of ["step", "daily", "watchdog"]) {
    assert.equal(await chromeStub.alarms.get(name), undefined, `${name} alarm left armed`);
  }
  assert.equal(chromeStub.openWindows().length, 1, "only the user's window remains");
});
