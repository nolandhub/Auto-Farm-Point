import test from "node:test";
import assert from "node:assert/strict";
import { selectActivities, isSafeOffer, SKIPPED_KINDS } from "../src/core/activities.js";
import { makeRng } from "../src/core/pacing.js";

const rng = makeRng(31337);

const offer = (over = {}) => ({
  id: "o1",
  title: "Read an article",
  url: "https://www.bing.com/search?q=x",
  points: 5,
  kind: "urlreward",
  ...over,
});

test("a plain click-through offer is safe to automate", () => {
  assert.equal(isSafeOffer(offer()), true);
});

test("offers that need real answers are skipped", () => {
  for (const kind of SKIPPED_KINDS) {
    assert.equal(isSafeOffer(offer({ kind })), false, `${kind} should be skipped`);
  }
});

test("offers pointing off Microsoft's own domains are skipped", () => {
  assert.equal(isSafeOffer(offer({ url: "https://example.com/promo" })), false);
  assert.equal(isSafeOffer(offer({ url: "https://rewards.bing.com/x" })), true);
  assert.equal(isSafeOffer(offer({ url: "https://www.microsoft.com/x" })), true);
});

test("malformed offers are skipped rather than crashing the selector", () => {
  assert.equal(isSafeOffer(null), false);
  assert.equal(isSafeOffer(offer({ url: "not a url" })), false);
  assert.equal(isSafeOffer(offer({ url: "javascript:alert(1)" })), false);
});

test("selectActivities keeps only the safe offers", () => {
  const chosen = selectActivities(
    [offer({ id: "a" }), offer({ id: "b", kind: "quiz" }), offer({ id: "c" })],
    { maxPerDay: 10, doneToday: 0, rng }
  );
  assert.deepEqual(chosen.map((o) => o.id).sort(), ["a", "c"]);
});

test("selectActivities honours the daily ceiling", () => {
  const many = Array.from({ length: 30 }, (_, i) => offer({ id: `o${i}` }));
  assert.equal(selectActivities(many, { maxPerDay: 8, doneToday: 0, rng }).length, 8);
});

test("the ceiling counts what was already done today", () => {
  const many = Array.from({ length: 30 }, (_, i) => offer({ id: `o${i}` }));
  assert.equal(selectActivities(many, { maxPerDay: 8, doneToday: 6, rng }).length, 2);
  assert.equal(selectActivities(many, { maxPerDay: 8, doneToday: 8, rng }).length, 0);
  assert.equal(selectActivities(many, { maxPerDay: 8, doneToday: 99, rng }).length, 0);
});

test("selectActivities returns nothing when disabled or given nothing", () => {
  assert.deepEqual(selectActivities([], { maxPerDay: 10, doneToday: 0, rng }), []);
  assert.deepEqual(selectActivities(null, { maxPerDay: 10, doneToday: 0, rng }), []);
  assert.deepEqual(selectActivities([offer()], { maxPerDay: 0, doneToday: 0, rng }), []);
});

test("the order varies between runs so the sequence is not a fingerprint", () => {
  const many = Array.from({ length: 12 }, (_, i) => offer({ id: `o${i}` }));
  const a = selectActivities(many, { maxPerDay: 12, doneToday: 0, rng: makeRng(1) });
  const b = selectActivities(many, { maxPerDay: 12, doneToday: 0, rng: makeRng(2) });
  assert.notDeepEqual(a.map((o) => o.id), b.map((o) => o.id));
});

test("selection never duplicates an offer", () => {
  const many = Array.from({ length: 12 }, (_, i) => offer({ id: `o${i}` }));
  const chosen = selectActivities(many, { maxPerDay: 12, doneToday: 0, rng });
  assert.equal(new Set(chosen.map((o) => o.id)).size, chosen.length);
});

test("higher-value offers are not starved when the ceiling bites", () => {
  const low = Array.from({ length: 10 }, (_, i) => offer({ id: `low${i}`, points: 1 }));
  const high = offer({ id: "high", points: 50 });
  const chosen = selectActivities([...low, high], { maxPerDay: 3, doneToday: 0, rng });
  assert.ok(chosen.some((o) => o.id === "high"), "the 50-point offer must survive the cut");
});
