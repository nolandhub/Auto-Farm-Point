import test from "node:test";
import assert from "node:assert/strict";
import {
  createIdleState,
  createRun,
  currentLeg,
  currentQuery,
  isActive,
  isDue,
  recordSearch,
  scheduleNext,
  advanceLeg,
  markError,
  markFailure,
  legKind,
  currentTarget,
  migrate,
  SCHEMA_VERSION,
} from "../src/core/state.js";

const PLAN = [
  { mode: "pc", total: 2 },
  { mode: "mobile", total: 1 },
];
const QUERIES = ["alpha", "beta", "gamma", "delta"];

function freshRun(now = 1_000_000) {
  return createRun({ plan: PLAN, queries: QUERIES, now });
}

test("a fresh run starts running, due immediately, at leg zero", () => {
  const s = freshRun();
  assert.equal(s.status, "running");
  assert.equal(s.legIndex, 0);
  assert.equal(s.doneInLeg, 0);
  assert.equal(s.queryIndex, 0);
  assert.equal(isActive(s), true);
  assert.equal(isDue(s, 1_000_000), true);
});

test("createRun refuses an empty plan", () => {
  assert.throws(() => createRun({ plan: [], queries: QUERIES, now: 0 }), /plan/i);
});

test("the idle state is not active and not due", () => {
  const s = createIdleState();
  assert.equal(isActive(s), false);
  assert.equal(isDue(s, Date.now()), false);
  assert.equal(s.schema, SCHEMA_VERSION);
});

test("currentLeg and currentQuery track the cursors", () => {
  const s = freshRun();
  assert.deepEqual(currentLeg(s), { mode: "pc", total: 2 });
  assert.equal(currentQuery(s), "alpha");
});

test("recordSearch advances both cursors and the break counter", () => {
  const s = recordSearch(freshRun(), 1_000_500);
  assert.equal(s.doneInLeg, 1);
  assert.equal(s.queryIndex, 1);
  assert.equal(s.sinceBreak, 1);
  assert.equal(s.totalDone, 1);
  assert.equal(currentQuery(s), "beta");
});

test("recordSearch does not mutate the state handed to it", () => {
  const before = freshRun();
  recordSearch(before, 1_000_500);
  assert.equal(before.doneInLeg, 0);
  assert.equal(before.queryIndex, 0);
});

test("scheduleNext sets the wake time and flips to waiting", () => {
  const s = scheduleNext(freshRun(), 1_000_000, 12_000, false);
  assert.equal(s.status, "waiting");
  assert.equal(s.nextActionAt, 1_012_000);
  assert.equal(isDue(s, 1_011_999), false);
  assert.equal(isDue(s, 1_012_000), true);
});

test("scheduleNext resets the break counter when the wait is a break", () => {
  let s = recordSearch(freshRun(), 1_000_500);
  assert.equal(s.sinceBreak, 1);
  s = scheduleNext(s, 1_000_500, 60_000, true);
  assert.equal(s.sinceBreak, 0);
});

test("scheduleNext leaves the break counter alone for a normal gap", () => {
  let s = recordSearch(freshRun(), 1_000_500);
  s = scheduleNext(s, 1_000_500, 8_000, false);
  assert.equal(s.sinceBreak, 1);
});

test("a leg completes only after its full total", () => {
  let s = freshRun();
  s = recordSearch(s, 1);
  assert.equal(advanceLeg(s).legIndex, 0, "one of two is not done");
  s = recordSearch(s, 2);
  const next = advanceLeg(s);
  assert.equal(next.legIndex, 1);
  assert.equal(next.doneInLeg, 0, "counter resets for the new leg");
  assert.equal(next.status, "running");
});

test("advanceLeg preserves the query cursor across a mode switch", () => {
  let s = freshRun();
  s = recordSearch(s, 1);
  s = recordSearch(s, 2);
  const next = advanceLeg(s);
  assert.equal(next.queryIndex, 2, "must not replay queries in the next mode");
  assert.equal(currentQuery(next), "gamma");
});

test("finishing the last leg ends the run", () => {
  let s = freshRun();
  s = advanceLeg(recordSearch(recordSearch(s, 1), 2)); // pc leg done
  s = advanceLeg(recordSearch(s, 3)); // mobile leg done
  assert.equal(s.status, "done");
  assert.equal(isActive(s), false);
  assert.ok(s.finishedAt > 0);
});

test("running out of queries ends the run rather than searching undefined", () => {
  let s = createRun({ plan: [{ mode: "pc", total: 10 }], queries: ["only"], now: 0 });
  s = recordSearch(s, 1);
  assert.equal(currentQuery(s), null);
  assert.equal(isActive(advanceLeg(s)), false);
});

test("markError stores the message and stops the run", () => {
  const s = markError(freshRun(), "network down", 1_000_900);
  assert.equal(s.status, "error");
  assert.equal(s.lastError, "network down");
  assert.equal(isActive(s), false);
});

test("migrate discards a state written by an older schema", () => {
  const stale = { schema: 1, status: "running", queries: ["x"] };
  assert.equal(migrate(stale).status, "idle");
});

test("migrate passes a current-schema state through untouched", () => {
  const s = freshRun();
  assert.deepEqual(migrate(s), s);
});

test("migrate repairs a missing or corrupt state", () => {
  assert.equal(migrate(null).status, "idle");
  assert.equal(migrate(undefined).status, "idle");
  assert.equal(migrate("nonsense").status, "idle");
});

test("markFailure counts up without ending the run", () => {
  const s = markFailure(freshRun(), "load timeout");
  assert.equal(s.failures, 1);
  assert.equal(s.lastError, "load timeout");
  assert.equal(isActive(s), true, "one failure must not abandon the run");
  assert.equal(markFailure(s, "again").failures, 2);
});

test("a successful search clears the failure streak", () => {
  const s = markFailure(markFailure(freshRun(), "a"), "b");
  assert.equal(s.failures, 2);
  assert.equal(recordSearch(s, 1).failures, 0);
});

// --- mixed activity + search runs -----------------------------------------

const MIXED_PLAN = [
  { kind: "activity", total: 2 },
  { kind: "search", mode: "pc", total: 2 },
];
const OFFERS = [{ id: "a" }, { id: "b" }, { id: "c" }];

function mixedRun() {
  return createRun({ plan: MIXED_PLAN, queries: QUERIES, offers: OFFERS, now: 1 });
}

test("a leg with no kind is still treated as a search leg", () => {
  assert.equal(legKind({ mode: "pc", total: 2 }), "search");
  assert.equal(legKind({ kind: "activity", total: 1 }), "activity");
  assert.equal(legKind(null), "search");
});

test("currentTarget yields an offer on an activity leg and a query on a search leg", () => {
  const s = mixedRun();
  assert.deepEqual(currentTarget(s), { id: "a" });
  const searchLeg = { ...s, legIndex: 1 };
  assert.equal(currentTarget(searchLeg), "alpha");
});

test("an activity step advances the offer cursor and leaves queries alone", () => {
  const s = recordSearch(mixedRun(), 2);
  assert.equal(s.offerIndex, 1);
  assert.equal(s.queryIndex, 0, "activities must not consume search terms");
  assert.deepEqual(currentTarget(s), { id: "b" });
});

test("a mixed run walks activities first, then searches, in full", () => {
  let s = mixedRun();
  s = advanceLeg(recordSearch(s, 1));
  s = advanceLeg(recordSearch(s, 2));
  assert.equal(s.legIndex, 1, "should have moved on to the search leg");
  assert.equal(currentTarget(s), "alpha");

  s = advanceLeg(recordSearch(s, 3));
  s = advanceLeg(recordSearch(s, 4));
  assert.equal(s.status, "done");
  assert.equal(s.totalDone, 4);
});

test("running out of offers ends the run instead of repeating one", () => {
  let s = createRun({
    plan: [{ kind: "activity", total: 5 }],
    queries: QUERIES,
    offers: [{ id: "only" }],
    now: 0,
  });
  s = recordSearch(s, 1);
  assert.equal(currentTarget(s), null);
  assert.equal(isActive(advanceLeg(s)), false);
});

test("an activity leg with no offers at all does not start", () => {
  const s = createRun({
    plan: [{ kind: "activity", total: 1 }],
    queries: [],
    offers: [],
    now: 0,
  });
  assert.equal(currentTarget(s), null);
  assert.equal(isActive(advanceLeg(s)), false);
});
