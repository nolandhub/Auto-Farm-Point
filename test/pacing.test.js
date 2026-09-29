import test from "node:test";
import assert from "node:assert/strict";
import {
  makeRng,
  nextBreakAfter,
  nextDelay,
  dailyJitterMs,
  throttledDelay,
  dwellMs,
} from "../src/core/pacing.js";
import { PACING, THROTTLE } from "../src/core/constants.js";

// Deterministic rng so distribution assertions cannot flake.
const rng = makeRng(20260926);

function sample(n, fn) {
  return Array.from({ length: n }, fn);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

test("nextDelay stays inside the clamp on every draw", () => {
  const delays = sample(5000, () => nextDelay({ sinceBreak: 0, breakAfter: 7, rng }).delayMs);
  assert.ok(Math.min(...delays) >= PACING.minDelayMs, `min ${Math.min(...delays)}`);
  assert.ok(Math.max(...delays) <= PACING.maxDelayMs, `max ${Math.max(...delays)}`);
});

test("nextDelay clusters around the target median", () => {
  const delays = sample(5000, () => nextDelay({ sinceBreak: 0, breakAfter: 7, rng }).delayMs);
  const m = median(delays);
  assert.ok(m > 9000 && m < 16000, `median was ${m}`);
});

test("nextDelay is right-skewed, not uniform", () => {
  const delays = sample(5000, () => nextDelay({ sinceBreak: 0, breakAfter: 7, rng }).delayMs);
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  // A right-skewed distribution pulls the mean above the median.
  assert.ok(mean > median(delays), `mean ${mean} vs median ${median(delays)}`);
  assert.ok(new Set(delays).size > 1000, "delays should not repeat");
});

test("nextDelay returns a long break once the counter reaches the threshold", () => {
  const r = nextDelay({ sinceBreak: 7, breakAfter: 7, rng });
  assert.equal(r.isBreak, true);
  assert.ok(r.delayMs >= PACING.breakMinMs && r.delayMs <= PACING.breakMaxMs, `${r.delayMs}`);
});

test("nextDelay does not break before the threshold", () => {
  for (let i = 0; i < 7; i++) {
    assert.equal(nextDelay({ sinceBreak: i, breakAfter: 8, rng }).isBreak, false);
  }
});

test("breaks are long enough to trigger the window-close policy", () => {
  assert.ok(PACING.breakMinMs > PACING.idleCloseThresholdMs);
});

test("nextBreakAfter spans 4..10 inclusive and varies", () => {
  const counts = sample(2000, () => nextBreakAfter(rng));
  assert.ok(Math.min(...counts) >= 4, `min ${Math.min(...counts)}`);
  assert.ok(Math.max(...counts) <= 10, `max ${Math.max(...counts)}`);
  assert.ok(new Set(counts).size >= 5, "should not collapse to one value");
});

test("dailyJitterMs only ever delays the daily run, by up to 30 minutes", () => {
  // A run set for 09:00 must not start at 08:15, before the user expects it.
  const js = sample(2000, () => dailyJitterMs(rng));
  assert.ok(Math.min(...js) >= 0, `earliest ${Math.min(...js)}`);
  assert.ok(Math.max(...js) <= 30 * 60 * 1000, `latest ${Math.max(...js)}`);
  assert.ok(new Set(js).size > 100, "still varies day to day");
});

test("dwellMs is a short bounded read, never zero", () => {
  const ds = sample(2000, () => dwellMs(rng));
  assert.ok(Math.min(...ds) >= PACING.dwellMinMs);
  assert.ok(Math.max(...ds) <= PACING.dwellMaxMs);
});

test("makeRng is reproducible and stays in [0,1)", () => {
  const r1 = makeRng(7);
  const r2 = makeRng(7);
  const a = sample(200, () => r1());
  const b = sample(200, () => r2());
  assert.deepEqual(a, b);
  assert.ok(a.every((x) => x >= 0 && x < 1));
  assert.ok(new Set(a).size > 150, "successive draws must differ");
});

// ----------------------------------------------------- Bing's escalating lock

const MIN = 60_000;
const noJitter = () => 0;

test("after each credit while limited, the wait grows like Bing's lock did", () => {
  // Measured gaps between credited mobile searches: 20, 29, 51, then 43..98 min.
  const waits = [0, 1, 2, 3].map((credits) =>
    throttledDelay({ credits, misses: 0, lastWasCredit: credits > 0 }, noJitter) / MIN
  );
  assert.deepEqual(waits.map(Math.round), [20, 32, 51, 82]);
});

test("a refusal retries sooner than the next credit wait, stretching with each one", () => {
  const retries = [1, 2, 3, 4, 5].map((misses) =>
    throttledDelay({ credits: 3, misses, lastWasCredit: false }, noJitter) / MIN
  );
  assert.deepEqual(retries, [20, 40, 60, 60, 60]);
});

test("the credit wait is capped, and jitter only ever adds", () => {
  const capped = throttledDelay({ credits: 20, misses: 0, lastWasCredit: true }, noJitter);
  assert.equal(capped, THROTTLE.maxGapMs);
  const jittered = throttledDelay({ credits: 1, misses: 0, lastWasCredit: true }, () => 0.999);
  assert.ok(jittered > THROTTLE.gapMs * THROTTLE.growth);
  assert.ok(jittered <= THROTTLE.gapMs * THROTTLE.growth + THROTTLE.jitterMs);
});
