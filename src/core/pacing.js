import { PACING, THROTTLE } from "./constants.js";

/**
 * Seedable PRNG (mulberry32). Tests need reproducible draws; production just
 * seeds it from the clock.
 */
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const defaultRng = makeRng();

function gaussian(rng) {
  // Box-Muller. u must be non-zero for the log.
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function uniformInt(rng, min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * How many searches until the next long break. Humans are irregular, so this
 * is re-rolled after every break rather than fixed.
 */
export function nextBreakAfter(rng = defaultRng) {
  return uniformInt(rng, PACING.breakEveryMin, PACING.breakEveryMax);
}

/**
 * The gap before the next search. Log-normal, so most gaps sit near the median
 * with an occasional long one — the shape real browsing produces, and nothing
 * like the fixed 5-searches/15-minutes cadence v2.4 emitted.
 */
export function nextDelay({ sinceBreak, breakAfter, rng = defaultRng }) {
  if (sinceBreak >= breakAfter) {
    return {
      delayMs: uniformInt(rng, PACING.breakMinMs, PACING.breakMaxMs),
      isBreak: true,
    };
  }
  const raw = Math.exp(PACING.logMedianMs + PACING.logSigma * gaussian(rng));
  return {
    delayMs: Math.round(clamp(raw, PACING.minDelayMs, PACING.maxDelayMs)),
    isBreak: false,
  };
}

/** Time to linger on a results page before the next navigation. */
export function dwellMs(rng = defaultRng) {
  return uniformInt(rng, PACING.dwellMinMs, PACING.dwellMaxMs);
}

/**
 * Offset applied to the daily schedule so it never fires on the same second.
 * Only ever a delay: a run set for 09:00 must not start before 09:00.
 */
export function dailyJitterMs(rng = defaultRng) {
  return Math.round(rng() * PACING.dailyJitterMs);
}

/**
 * The wait before the next single search once Bing is limiting a leg. After a
 * credit it follows Bing's escalating lock (gap × growth^credits); after a
 * refusal it retries sooner, stretching with each refusal in a row. Capped,
 * and jitter only ever adds.
 */
export function throttledDelay({ credits = 0, misses = 0, lastWasCredit = false }, rng = defaultRng) {
  const base = lastWasCredit
    ? Math.min(THROTTLE.maxGapMs, THROTTLE.gapMs * THROTTLE.growth ** credits)
    : Math.min(THROTTLE.maxRetryMs, THROTTLE.retryMs * Math.max(1, misses));
  return Math.round(base + rng() * THROTTLE.jitterMs);
}
