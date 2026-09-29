import test from "node:test";
import assert from "node:assert/strict";
import {
  dateKey,
  searchesDone,
  remaining,
  hasMetTarget,
  estimatePoints,
  buildPlan,
  recordProgress,
  pruneHistory,
} from "../src/core/quota.js";
import { QUOTA } from "../src/core/constants.js";

test("dateKey uses local calendar days, not UTC", () => {
  // 2026-09-26 23:30 local, whatever the host timezone is.
  const d = new Date(2026, 8, 26, 23, 30, 0);
  assert.equal(dateKey(d), "2026-09-26");
});

test("dateKey rolls over at local midnight", () => {
  assert.equal(dateKey(new Date(2026, 8, 26, 23, 59, 59)), "2026-09-26");
  assert.equal(dateKey(new Date(2026, 8, 27, 0, 0, 0)), "2026-09-27");
});

test("dateKey zero-pads single digit months and days", () => {
  assert.equal(dateKey(new Date(2026, 0, 5, 12, 0, 0)), "2026-01-05");
});

test("searchesDone reads zero for an unseen day or mode", () => {
  assert.equal(searchesDone({}, "2026-09-26", "pc"), 0);
  assert.equal(searchesDone({ "2026-09-26": { mobile: 20 } }, "2026-09-26", "pc"), 0);
});

test("remaining never goes negative when the target is overshot", () => {
  const history = { "2026-09-26": { pc: 34 } };
  assert.equal(remaining(history, "2026-09-26", "pc", 30), 0);
});

test("remaining reports the shortfall for a partial day", () => {
  const history = { "2026-09-26": { pc: 12 } };
  assert.equal(remaining(history, "2026-09-26", "pc", 30), 18);
});

test("hasMetTarget is true only once the target is reached", () => {
  const history = { "2026-09-26": { pc: 29 } };
  assert.equal(hasMetTarget(history, "2026-09-26", "pc", 30), false);
  assert.equal(hasMetTarget({ "2026-09-26": { pc: 30 } }, "2026-09-26", "pc", 30), true);
});

test("estimatePoints credits only searches inside the earning cap", () => {
  assert.equal(estimatePoints({ pc: 30, mobile: 0 }), 30 * QUOTA.pointsPerSearch);
  // Beyond the cap earns nothing extra.
  assert.equal(estimatePoints({ pc: 100, mobile: 0 }), QUOTA.pc.cap * QUOTA.pointsPerSearch);
});

test("buildPlan skips a mode that already met its target today", () => {
  const history = { "2026-09-26": { pc: 30 } };
  const plan = buildPlan({
    modes: ["pc", "mobile"],
    counts: { pc: 30, mobile: 20 },
    history,
    day: "2026-09-26",
  });
  assert.deepEqual(plan, [{ mode: "mobile", total: 20 }]);
});

test("buildPlan asks only for the remaining searches of a partial mode", () => {
  const history = { "2026-09-26": { pc: 12 } };
  const plan = buildPlan({
    modes: ["pc"],
    counts: { pc: 30 },
    history,
    day: "2026-09-26",
  });
  assert.deepEqual(plan, [{ mode: "pc", total: 18 }]);
});

test("buildPlan takes counts read off the account as already net of today", () => {
  // The account says 2 searches are left; this device's 30 must not come off again.
  const history = { "2026-09-26": { pc: 30, mobile: 5 } };
  const plan = buildPlan({
    modes: ["pc", "mobile"],
    counts: { pc: 2, mobile: 20 },
    history,
    day: "2026-09-26",
    net: ["pc"],
  });
  assert.deepEqual(plan, [
    { mode: "pc", total: 2 },
    { mode: "mobile", total: 15 },
  ]);
});

test("buildPlan still drops a net mode with nothing left", () => {
  const plan = buildPlan({ modes: ["pc"], counts: { pc: 0 }, history: {}, day: "2026-09-26", net: ["pc"] });
  assert.deepEqual(plan, []);
});

test("buildPlan returns empty when everything is already done", () => {
  const history = { "2026-09-26": { pc: 30, mobile: 20 } };
  const plan = buildPlan({
    modes: ["pc", "mobile"],
    counts: { pc: 30, mobile: 20 },
    history,
    day: "2026-09-26",
  });
  assert.deepEqual(plan, []);
});

test("buildPlan keeps pc before mobile regardless of the input order", () => {
  const plan = buildPlan({
    modes: ["mobile", "pc"],
    counts: { pc: 5, mobile: 5 },
    history: {},
    day: "2026-09-26",
  });
  assert.deepEqual(plan.map((l) => l.mode), ["pc", "mobile"]);
});

test("recordProgress accumulates without mutating the input", () => {
  const history = Object.freeze({ "2026-09-26": Object.freeze({ pc: 5 }) });
  const next = recordProgress(history, "2026-09-26", "pc", 3);
  assert.equal(next["2026-09-26"].pc, 8);
  assert.equal(history["2026-09-26"].pc, 5);
});

test("recordProgress starts a fresh day without touching earlier ones", () => {
  const next = recordProgress({ "2026-09-25": { pc: 30 } }, "2026-09-26", "mobile", 1);
  assert.equal(next["2026-09-26"].mobile, 1);
  assert.equal(next["2026-09-25"].pc, 30);
});

test("pruneHistory keeps the retention window and drops older days", () => {
  const history = {
    "2026-09-26": { pc: 1 },
    "2026-09-20": { pc: 1 },
    "2026-08-01": { pc: 1 },
  };
  const kept = pruneHistory(history, "2026-09-26", 14);
  assert.ok("2026-09-26" in kept);
  assert.ok("2026-09-20" in kept);
  assert.ok(!("2026-08-01" in kept));
});
