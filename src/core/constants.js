/**
 * Every tunable in one place. Nothing here reads Chrome APIs, so the whole
 * file is importable from tests.
 */

export const SCHEMA_VERSION = 3;

/**
 * Bump on every change to the worker or popup. Edge keeps an unpacked
 * extension's service-worker code until it is reloaded, while popup files load
 * fresh from disk; the popup compares this with the worker's copy and asks for
 * a reload when they differ.
 */
export const BUILD = "2026-09-29.5";

export const STORAGE_KEYS = {
  run: "run.v3",
  settings: "settings.v3",
  history: "history.v3",
  log: "log.v3",
  window: "window.v3",
  // Where TheNetsky's control API listens, and its token.
  netsky: "netsky.v1",
  // Today's baseline balance; see ledger.js.
  balance: "balance.v1",
  // Which manual sign-ins were opened, the page's tab, and accounts to rerun.
  manualLogin: "manualLogin.v1",
};

/**
 * Microsoft grants 3 points per search and stops crediting past a daily cap.
 * `target` is what we aim for; `cap` is where points stop, and asking for more
 * than that is the loudest bot signal there is, so we warn above it.
 */
export const QUOTA = {
  pointsPerSearch: 3,
  hardMax: 300,
  retentionDays: 14,
  pc: { target: 30, cap: 34 },
  mobile: { target: 20, cap: 22 },
};

export const MODES = ["pc", "mobile"];

export const PACING = {
  // Right-skewed gap between searches. Median sits at exp(logMedianMs).
  logMedianMs: Math.log(12_000),
  logSigma: 0.45,
  minDelayMs: 6_000,
  maxDelayMs: 40_000,

  // A "put the phone down and read" pause, every few searches.
  breakEveryMin: 4,
  breakEveryMax: 10,
  breakMinMs: 45_000,
  breakMaxMs: 120_000,

  // Time spent on a results page before moving on.
  dwellMinMs: 1_800,
  dwellMaxMs: 5_000,

  // Close the hidden window when the next action is further away than this.
  // Set to maxDelayMs so the split is exact: an ordinary gap never closes the
  // window, and every break (>= breakMinMs) always does.
  idleCloseThresholdMs: 40_000,

  // chrome.alarms floors at 30s, so anything shorter runs on a timer instead.
  alarmFloorMs: 35_000,

  // Share of PC searches that open a result before moving on. Mobile searches
  // always do: searches that click through to a result were seen to earn
  // where bare ones did not.
  pcReadChance: 0.4,

  // The daily run starts up to this long after the chosen time, never before.
  dailyJitterMs: 30 * 60 * 1000,
  // A daily run found missed at browser start begins this soon (plus jitter).
  dailyCatchUpMs: 2 * 60 * 1000,
};

/**
 * Bing's search limiter, as measured on a real account on 2026-09-28 (mobile).
 * Each day opens with ~4 searches credited back to back. After that, credits
 * come one at a time, each only after a longer wait since the previous credit
 * than the last: measured 20, 29, 51, then between 43 and 98 minutes, about
 * ×1.6 each time. Searches in between earned nothing, and making them did not
 * move the next credit either (it came on time after two refusals).
 *
 * So once a search goes uncredited, the leg waits gapMs × growth^credits after
 * each credit (credits = those earned while limited), and retryMs × refusals
 * after a refusal, searching once per wait and never in between.
 */
export const THROTTLE = {
  gapMs: 20 * 60 * 1000,
  growth: 1.6,
  maxGapMs: 3 * 60 * 60 * 1000,
  retryMs: 20 * 60 * 1000,
  maxRetryMs: 60 * 60 * 1000,
  jitterMs: 3 * 60 * 1000,
  // Refusals in a row before the leg is given up for this run.
  maxMisses: 8,
  // How long a credited search takes to show on the counter, and a recheck.
  settleMs: 8_000,
  recheckMs: 6_000,
};

export const ALARMS = {
  watchdog: "watchdog",
  step: "step",
  daily: "daily",
  netsky: "netsky",
  balance: "balance",
};

export const WATCHDOG_PERIOD_MINUTES = 1;

/** How long to wait for a results page before giving up and moving on. */
export const NAVIGATION_TIMEOUT_MS = 25_000;

/**
 * The phone the worker tab pretends to be. The browser version is not listed:
 * it is read from the real browser at run time, because Chrome still sends its
 * true full version in sec-ch-ua-full-version-list, and a phone that disagrees
 * with itself about which Chrome it runs is worse than no disguise at all.
 */
export const MOBILE_DEVICE = {
  model: "Pixel 8",
  platformVersion: "14.0.0",
  // What navigator.platform reads on 64-bit Android Chrome.
  platform: "Linux armv8l",
};

/** Used only where navigator.userAgentData is unavailable. */
export const FALLBACK_BROWSER = {
  brands: [
    { brand: "Chromium", version: "140" },
    { brand: "Not=A?Brand", version: "24" },
    { brand: "Google Chrome", version: "140" },
  ],
  fullVersionList: [
    { brand: "Chromium", version: "140.0.7339.128" },
    { brand: "Not=A?Brand", version: "24.0.0.0" },
    { brand: "Google Chrome", version: "140.0.7339.128" },
  ],
  uaFullVersion: "140.0.7339.128",
};

/** Session-rule id for the mobile header override. */
export const MOBILE_RULE_ID = 1001;

/**
 * `form` mirrors what Bing itself appends when a search comes from the browser
 * chrome, so a direct navigation is indistinguishable from a typed one.
 */
export function buildSearchUrl(query, mode) {
  const form = mode === "mobile" ? "MOSBSB" : "QBLH";
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}&form=${form}`;
}
