import {
  ALARMS,
  BUILD,
  MODES,
  PACING,
  QUOTA,
  STORAGE_KEYS,
  THROTTLE,
  WATCHDOG_PERIOD_MINUTES,
  buildSearchUrl,
} from "./constants.js";
import {
  REPORT_PAGE_URL,
  buildReportPayload,
  isSafeOffer,
  selectActivities,
} from "./activities.js";
import { isCounterComplete, readDashboard, remainingSearches } from "./dashboard.js";
import { applyMobile, clearIdentity } from "./identity.js";
import { earnedToday, trackBalance } from "./ledger.js";
import { EARN_URL, questOffers, readQuests } from "./quests.js";
import { log } from "./log.js";
import {
  dailyJitterMs,
  dwellMs,
  makeRng,
  nextBreakAfter,
  nextDelay,
  throttledDelay,
} from "./pacing.js";
import { prepare } from "./queries.js";
import {
  buildPlan,
  dateKey,
  estimatePoints,
  pruneHistory,
  recordProgress,
  searchesDone,
} from "./quota.js";
import { fetchTopics } from "./sources.js";
import {
  advanceLeg,
  createIdleState,
  createRun,
  currentLeg,
  currentTarget,
  isActive,
  isDue,
  markError,
  legKind,
  markFailure,
  migrate,
  recordMiss,
  recordSearch,
  scheduleNext,
} from "./state.js";
import * as workerWindow from "./worker-window.js";

const MAX_CONSECUTIVE_FAILURES = 5;
/**
 * Quests live on rewards.bing.com pages (hundreds of KB each), so they are
 * re-read at most this often; the flyout counters refresh far more often.
 */
const QUEST_TTL_MS = 10 * 60 * 1000;
const RETRY_DELAY_MS = 30_000;
/** A run older than this was interrupted by a long shutdown; start fresh. */
const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

const rng = makeRng();

/** Waits the credit check uses; tests set them to 0. */
export const tuning = {
  creditSettleMs: THROTTLE.settleMs,
  creditRecheckMs: THROTTLE.recheckMs,
  // rewards.bing.com's sign-in hops through a few redirects after "complete".
  signInSettleMs: 4_000,
  // Reading a results page before choosing (null: dwellMs), and how long a
  // clicked result is read before coming back.
  serpDwellMs: null,
  readMinMs: 10_000,
  readMaxMs: 25_000,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Only ever guards against the setTimeout and the watchdog firing at once
 * inside one worker instance. If the worker dies mid-step it resets to false,
 * which is exactly what should happen — the watchdog then retries the step.
 */
let inFlight = false;
let stepTimer = null;
let appliedMode = null;
let appliedTabId = null;

const ports = new Set();

/**
 * There is no mode or count to choose: every run covers both devices and works
 * out for itself how many searches are left. `modes`/`counts` saved by older
 * versions are ignored.
 */
export const DEFAULT_SETTINGS = {
  lang: "auto",
  theme: "auto",
  daily: { enabled: false, hour: 9, minute: 0 },
  activities: { enabled: true, maxPerDay: 12 },
  useDashboard: true,
  lastDailyRun: null,
};

// ---------------------------------------------------------------- persistence

export async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const saved = stored?.[STORAGE_KEYS.settings] ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    daily: { ...DEFAULT_SETTINGS.daily, ...(saved.daily ?? {}) },
    activities: { ...DEFAULT_SETTINGS.activities, ...(saved.activities ?? {}) },
  };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  if (patch.daily) await armDaily(next);
  await broadcast();
  return next;
}

async function getRun() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.run);
  return migrate(stored?.[STORAGE_KEYS.run]);
}

async function putRun(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.run]: state });
  return state;
}

const DASHBOARD_CACHE_KEY = "dashboard.v3";

async function getCachedDashboard() {
  const stored = await chrome.storage.local.get(DASHBOARD_CACHE_KEY);
  return stored?.[DASHBOARD_CACHE_KEY] ?? null;
}

/** Everything still worth points, flagged by whether the run will do it. */
/** Today's flyout tasks, finished or not, with whether a run can do them. */
function toTasks(tasks) {
  return (tasks ?? []).map((task) => ({
    id: task.id,
    title: task.title,
    points: task.points,
    done: task.done,
    state: task.done ? "done" : isSafeOffer(task) ? "auto" : "manual",
    url: task.url,
    hash: task.hash,
    activityType: task.activityType,
  }));
}

const TASK_ORDER = { auto: 0, manual: 1, locked: 2, app: 3, done: 4 };

/**
 * The one list the popup shows: today's tasks and the quests, open ones first
 * (what the run will do, then what is left for the user), finished ones last,
 * with the totals for the progress bar.
 */
function taskList(dash, questCache) {
  const tasks = [...(dash?.tasks ?? [])];
  for (const quest of questCache?.quests ?? []) {
    const done = quest.total > 0 && quest.done >= quest.total;
    const open = quest.children.some((c) => !c.isCompleted && !c.isLocked);
    tasks.push({
      id: quest.id,
      title: quest.title,
      points: quest.points,
      done,
      quest: { done: quest.done, total: quest.total, expiresAt: quest.expiresAt },
      state: done ? "done" : quest.appOnly ? "app" : open ? "auto" : "locked",
      // For app-only quests: "desktop" (the Windows app) or "mobile".
      app: quest.appKind ?? null,
    });
  }
  tasks.sort((a, b) => TASK_ORDER[a.state] - TASK_ORDER[b.state] || b.points - a.points);
  return {
    items: tasks,
    done: tasks.filter((t) => t.done).length,
    total: tasks.length,
    pointsLeft: tasks.filter((t) => !t.done).reduce((sum, t) => sum + t.points, 0),
  };
}

const QUESTS_CACHE_KEY = "quests.v3";

async function getCachedQuests() {
  const stored = await chrome.storage.local.get(QUESTS_CACHE_KEY);
  return stored?.[QUESTS_CACHE_KEY] ?? null;
}

/**
 * Re-reads the quests when the cached copy is stale (or `force`). A read that
 * fails outright keeps the previous quests rather than emptying the list.
 */
async function refreshQuests({ force = false } = {}) {
  const cached = await getCachedQuests();
  const fresh =
    cached?.readAt &&
    Date.now() - cached.readAt < QUEST_TTL_MS &&
    dateKey(new Date(cached.readAt)) === dateKey();
  if (fresh && !force) return cached;

  const result = await readQuests();
  const next =
    result.signedIn === null && cached
      ? { ...cached, readAt: Date.now() }
      : { signedIn: result.signedIn, quests: result.quests, readAt: Date.now() };
  await chrome.storage.local.set({ [QUESTS_CACHE_KEY]: next });
  return next;
}

async function invalidateQuests() {
  const cached = await getCachedQuests();
  if (cached) await chrome.storage.local.set({ [QUESTS_CACHE_KEY]: { ...cached, readAt: 0 } });
}

/**
 * A failed read keeps the last good numbers and only marks the failure: the
 * popup refreshes live, and one dropped request must not blank it.
 */
async function putCachedDashboard(dash) {
  if (!dash) {
    const previous = await getCachedDashboard();
    if (previous) {
      await chrome.storage.local.set({
        [DASHBOARD_CACHE_KEY]: { ...previous, failedAt: Date.now() },
      });
    }
    return;
  }
  const day = dateKey();
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const stored = await chrome.storage.local.get(STORAGE_KEYS.balance);
  const ledger = trackBalance(stored?.[STORAGE_KEYS.balance] ?? null, {
    balance: dash.availablePoints,
    day,
    previousDay: dateKey(yesterday),
  });
  await chrome.storage.local.set({
    [STORAGE_KEYS.balance]: ledger,
    [DASHBOARD_CACHE_KEY]: {
      level: dash.level,
      availablePoints: dash.availablePoints,
      todayPoints: dash.todayPoints,
      // From the balance, so app points count; see ledger.js.
      earnedToday: earnedToday(ledger, day),
      earnedExact: ledger?.day === day && ledger.exact,
      counters: dash.counters,
      tasks: toTasks(dash.tasks),
      userId: dash.userId,
      source: dash.source,
      readAt: Date.now(),
    },
  });
}

/**
 * Reads the dashboard and caches what the popup needs. The quests follow when
 * their copy is stale, after the counters are already on screen; a background
 * balance check skips them.
 */
export async function refreshDashboard({ quests = true } = {}) {
  const dash = await readDashboard();
  await putCachedDashboard(dash);
  await broadcast();
  if (!quests) return dash;
  const before = (await getCachedQuests())?.readAt;
  const after = (await refreshQuests()).readAt;
  if (after !== before) await broadcast();
  return dash;
}

export async function getHistory() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.history);
  return stored?.[STORAGE_KEYS.history] ?? {};
}

async function putHistory(history) {
  await chrome.storage.local.set({ [STORAGE_KEYS.history]: history });
}

// ------------------------------------------------------------------ scheduling

function clearStepTimer() {
  if (stepTimer !== null) {
    clearTimeout(stepTimer);
    stepTimer = null;
  }
}

/**
 * Short gaps run on a timer because chrome.alarms floors at 30s — v2.4 asked
 * for 3–15s gaps through alarms and silently got 30s+ every time. Long gaps
 * run on an alarm so the worker may sleep. Either way nextActionAt is on disk,
 * so the watchdog can recover the step if this worker dies first.
 */
function armStep(delayMs) {
  clearStepTimer();
  if (delayMs <= PACING.alarmFloorMs) {
    void chrome.alarms.clear(ALARMS.step);
    stepTimer = setTimeout(() => void step(), Math.max(0, delayMs));
  } else {
    // create() replaces an alarm of the same name, so no clear is needed.
    chrome.alarms.create(ALARMS.step, { when: Date.now() + delayMs });
  }
}

export function ensureWatchdog() {
  chrome.alarms.create(ALARMS.watchdog, {
    periodInMinutes: WATCHDOG_PERIOD_MINUTES,
    delayInMinutes: WATCHDOG_PERIOD_MINUTES,
  });
}

/** The recovery path. Resumes anything overdue and keeps the daily alarm armed. */
export async function watchdog() {
  const state = await getRun();
  if (isActive(state)) {
    if (isDue(state, Date.now())) {
      log.debug("watchdog resuming an overdue step");
      await step();
    }
    return;
  }

  void chrome.alarms.clear(ALARMS.step);
  await ensureDaily(await getSettings());
}

// ------------------------------------------------------------------- identity

async function ensureIdentity(mode) {
  if (mode === "pc") {
    if (appliedMode === "pc") return;
    await clearIdentity();
    appliedMode = "pc";
    appliedTabId = null;
    return;
  }

  // The session rule is keyed by tab id, so the tab has to exist before the
  // rule is added — and the rule has to exist before the search request goes.
  const tabId = workerWindow.currentTabId();
  if (appliedMode === "mobile" && tabId !== null && appliedTabId === tabId) return;

  const { tabId: id } = await workerWindow.open("about:blank");
  await applyMobile(id);
  appliedMode = "mobile";
  appliedTabId = id;
}

// ----------------------------------------------------------------- in-page work

/**
 * Injected into the results page. Bounded by both a step count and a deadline,
 * and it clears its own interval — v2.4's version recursed forever and kept the
 * renderer's main thread busy for as long as the page stayed open.
 */
function scrollResults(durationMs) {
  const started = Date.now();
  const stepMs = 450;
  const maxSteps = Math.ceil(durationMs / stepMs);
  let steps = 0;
  const timer = setInterval(() => {
    steps += 1;
    const amount = 120 + Math.random() * 260;
    window.scrollBy({ top: steps % 5 === 0 ? -amount : amount, behavior: "smooth" });
    if (steps >= maxSteps || Date.now() - started >= durationMs) clearInterval(timer);
  }, stepMs);
  return true;
}

/**
 * Injected into a results page: opens one of the top organic results the way
 * a person does, weighted toward the first. Ads are never touched. The link is
 * kept in this tab (target stripped) so the run can come back to the results.
 * Desktop titles are `h2 a` through Bing's click tracker; mobile ones carry
 * Bing's `h` attribute and are tracked by its own click handler.
 */
function clickResult() {
  const links = [...document.querySelectorAll("#b_results > li.b_algo")]
    .map((li) => li.querySelector("h2 a[href]") ?? li.querySelector("a[href][h]:not(.tilk)"))
    .filter((a) => a && /^https:\/\//.test(a.href));
  if (links.length === 0) return { ok: false };

  const top = links.slice(0, 3);
  const link = top[Math.floor(Math.random() ** 2 * top.length)];
  link.removeAttribute("target");
  link.scrollIntoView({ block: "center" });

  const box = link.getBoundingClientRect();
  const at = {
    bubbles: true,
    cancelable: true,
    view: window,
    button: 0,
    clientX: box.left + Math.min(box.width - 1, 8 + Math.random() * box.width * 0.5),
    clientY: box.top + box.height / 2,
  };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup"]) {
    const Kind = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    link.dispatchEvent(new Kind(type, at));
  }
  link.click();
  return { ok: true, href: link.href.slice(0, 200) };
}

/**
 * A person skims the results, opens one, reads it for a while, and comes back.
 * Every mobile search does this, and a share of PC ones.
 */
async function readResults(mode) {
  await sleep(tuning.serpDwellMs ?? dwellMs(rng));
  if (mode !== "mobile" && rng() >= PACING.pcReadChance) return;
  const readMs = tuning.readMinMs + Math.round(rng() * (tuning.readMaxMs - tuning.readMinMs));
  const read = await workerWindow.followResult(clickResult, readMs);
  if (read.ok) log.info("read a result", { mode, href: read.href, seconds: Math.round(readMs / 1000) });
  else log.debug("no result to read on this page", { mode });
}

/**
 * Injected into a www.bing.com page. This is the request Bing's own Rewards
 * flyout sends when an offer is clicked, and the one that credits it: the
 * flyout only navigates to the offer after this succeeds. Relative URL, so it
 * can only ever reach the page's own origin.
 */
function reportActivityInPage(payload) {
  if (location.hostname !== "www.bing.com") {
    return { ok: false, status: 0, error: `not on bing.com: ${location.hostname}` };
  }
  // Bing answers 200 even when nothing is credited; PointsEarned is the truth.
  return fetch("/msrewards/api/v1/reportactivity", {
    method: "POST",
    body: JSON.stringify(payload),
    credentials: "include",
  })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      return {
        ok: response.ok,
        status: response.status,
        rewardsUser: body.IsRewardsUser ?? null,
        pointsEarned: body.PointsEarned ?? null,
        balance: body.Balance ?? null,
      };
    })
    .catch((error) => ({ ok: false, status: 0, error: String(error) }));
}

async function reportActivity(offer) {
  await workerWindow.open(REPORT_PAGE_URL);
  const result = await workerWindow.runInTab(reportActivityInPage, [buildReportPayload(offer)]);
  const detail = {
    offer: offer.title,
    status: result?.status ?? null,
    pointsEarned: result?.pointsEarned ?? null,
    balance: result?.balance ?? null,
    rewardsUser: result?.rewardsUser ?? null,
    error: result?.error,
  };
  if (result?.pointsEarned > 0) log.info("activity credited by rewards", detail);
  else log.warn("rewards credited nothing for this activity", detail);
  return result;
}

/**
 * What a click on a task in the popup opens, and what it reports: an open
 * task is opened and reported as the Rewards page does on a click; a quest
 * opens its unlocked activity, or its quest page when none is open; a
 * finished task is only opened again.
 */
async function resolveTask(id) {
  const dash = await getCachedDashboard();
  const task = dash?.tasks?.find((t) => t.id === id);
  if (task) {
    const report =
      !task.done && task.hash
        ? { id: task.id, title: task.title, hash: task.hash, activityType: task.activityType, userId: dash.userId }
        : null;
    return { title: task.title, url: task.url, report };
  }

  const quest = (await getCachedQuests())?.quests?.find((q) => q.id === id);
  if (!quest) return null;
  const open = quest.appOnly ? null : quest.children.find((c) => !c.isCompleted && !c.isLocked);
  if (!open) return { title: quest.title, url: `${EARN_URL}/quest/${quest.id}`, report: null };
  return {
    title: open.title,
    url: open.href,
    report: { id: open.offerId, title: open.title, hash: open.hash, activityType: "urlreward", userId: dash?.userId, quest: quest.id },
  };
}

/** The popup's "click to collect" on one task. */
export async function doTask(id) {
  const target = await resolveTask(id);
  if (!target?.url) return { ok: false, reason: "unknown" };

  // The page first, so the popup (which closes as the tab takes focus) never
  // leaves the user waiting on the report.
  await workerWindow.openForUser(target.url);
  log.info("task opened for the user", { task: target.title });

  // The report needs the hidden window; a run in progress owns it, and will
  // do automatic tasks itself.
  if (!target.report || !isSafeOffer({ kind: "urlreward", url: target.url }) || isActive(await getRun())) {
    return { ok: true, reported: false };
  }
  let result = null;
  try {
    result = await reportActivity(target.report);
  } finally {
    await workerWindow.close();
  }
  if (target.report.quest) await invalidateQuests();
  void refreshDashboard();
  return { ok: true, reported: true, pointsEarned: result?.pointsEarned ?? null };
}

/**
 * Injected into a mobile results page, in the MAIN world for the page's _G.IG.
 *
 * A search is credited by POST /rewardsapp/reportActivity, which the desktop
 * results page sends itself (Bing's sj_rra). The mobile page does not ship
 * that code, so nothing was ever reported for mobile searches: this is sj_rra,
 * sent from the phone tab so the request carries the phone identity. Bing
 * answers with a model saying whether it saw a mobile client, which is
 * returned for the log. Its DailySearchPoints fields describe the PC counter
 * whatever the client, so they are left out: the dashboard recheck is the
 * number to trust.
 */
function reportSearchInPage() {
  if (location.hostname !== "www.bing.com" || location.pathname !== "/search") {
    return { status: 0, error: `not a results page: ${location.hostname}${location.pathname}` };
  }
  const ig = window._G?.IG;
  const iid = window.data_iid;
  const query = location.search.substring(1);
  const params = [ig ? `IG=${ig}` : "", iid ? `IID=${iid}` : "", query].filter(Boolean).join("&");
  return fetch(`/rewardsapp/reportActivity?${params}`, {
    method: "POST",
    headers: { "Content-type": "application/x-www-form-urlencoded" },
    body: `url=${escape(document.URL)}&V=web`,
    credentials: "include",
  })
    .then(async (response) => {
      const text = await response.text();
      const pick = (key) => {
        const match = text.match(new RegExp(`"${key}":(true|false|-?\\d+)`));
        return match ? JSON.parse(match[1]) : null;
      };
      return {
        status: response.status,
        mobileClient: pick("IsMobileClient"),
        rewardsUser: pick("IsRewardUser"),
        balance: pick("Balance"),
      };
    })
    .catch((error) => ({ status: 0, error: String(error) }));
}

async function reportMobileSearch() {
  const result = await workerWindow.runInTab(reportSearchInPage, [], "MAIN");
  const detail = { ...result };
  if (result?.mobileClient === false) {
    log.warn("rewards did not see this search as mobile", detail);
  } else if (result?.status === 200) {
    log.info("mobile search reported to rewards", detail);
  } else {
    log.warn("mobile search report failed", detail);
  }
}

// ----------------------------------------------------------------------- run

/**
 * Starts a run over both devices. `modes` and `counts` are optional ceilings
 * (for tests and scripted use); the popup and the daily trigger pass neither,
 * and the run then takes everything the account still pays for.
 */
export async function start({ modes, counts } = {}) {
  const settings = await getSettings();
  const wantModes = (modes ?? MODES).filter((m) => MODES.includes(m));

  const day = dateKey();
  const history = await getHistory();

  await putRun({ ...createIdleState(), status: "preparing" });
  await broadcast();

  // The real counters outrank our own tally and our hard-coded caps: they are
  // the only numbers that decide whether another search earns anything.
  const dash = settings.useDashboard ? await readDashboard() : null;
  await putCachedDashboard(dash);

  const plan = buildPlan({ modes: wantModes, ...planCounts(counts, dash?.counters), history, day });

  // Quest activities unlocked today go through the same filter and click as
  // the dashboard's offers; quests themselves are re-read for the run.
  let questCache = settings.activities.enabled && dash ? await refreshQuests({ force: true }) : null;
  if (questCache?.signedIn === false) {
    // rewards.bing.com has its own sign-in, renewed by a redirect flow that
    // only a real page load completes: open the Earn page hidden, as a person
    // opening their dashboard would, then read again.
    try {
      await workerWindow.open(EARN_URL);
      await sleep(tuning.signInSettleMs);
      questCache = await refreshQuests({ force: true });
    } catch (error) {
      log.debug("could not open the Earn page to sign in", { error: String(error) });
    }
  }
  const quests = questCache?.quests ?? [];
  const pool = [...(dash?.offers ?? []), ...questOffers(quests)].filter(
    (offer, i, all) => all.findIndex((o) => o.id === offer.id) === i
  );
  const chosenOffers =
    settings.activities.enabled && dash
      ? selectActivities(pool, {
          maxPerDay: settings.activities.maxPerDay,
          doneToday: searchesDone(history, day, "activity"),
          rng,
        }).map((offer) => ({ ...offer, userId: dash.userId }))
      : [];

  // Activities first: a person opens the dashboard, clears the dailies, then
  // browses. It also banks the streak before anything can interrupt the run.
  if (chosenOffers.length > 0) {
    plan.unshift({ kind: "activity", total: chosenOffers.length });
  }

  if (plan.length === 0) {
    log.info("nothing left to earn today", { dashboardRead: Boolean(dash) });
    await putRun({ ...createIdleState(), status: "done", finishedAt: Date.now() });
    await broadcast();
    return { started: false, reason: "allDone", dashboard: Boolean(dash) };
  }

  const searchLegs = plan.filter((leg) => legKind(leg) === "search");
  const searchTotal = searchLegs.reduce((sum, leg) => sum + leg.total, 0);
  // Searches Bing refuses do not count toward a leg, so keep spare terms for
  // them; a leg gives up after THROTTLE.maxMisses refusals in a row.
  const spare = dash ? THROTTLE.maxMisses * searchLegs.length : 0;
  const { topics, source } = searchTotal > 0
    ? await fetchTopics(searchTotal + spare)
    : { topics: [], source: "none" };
  const queries = searchTotal > 0 ? prepare(topics, searchTotal + spare, rng) : [];

  const state = createRun({
    plan,
    queries,
    offers: chosenOffers,
    now: Date.now(),
    breakAfter: nextBreakAfter(rng),
    counters: dash?.counters ?? null,
  });
  await putRun(state);

  log.info("run started", { plan, searchTotal, offers: chosenOffers.length, source });
  ensureWatchdog();
  armStep(0);
  await broadcast();
  return { started: true, searchTotal, offers: chosenOffers.length, source };
}

/**
 * How many searches each device still needs, worked out rather than asked.
 *
 * With the account's counter: exactly the searches its missing points are
 * worth. That number is already net of today, so `net` tells buildPlan not to
 * take this device's tally off again. Without it: the default target, which
 * buildPlan then tops up against what this device did today.
 * `ceilings`, when given, caps either answer.
 */
function planCounts(ceilings, counters) {
  const counts = {};
  const net = [];
  for (const mode of MODES) {
    const ceiling = ceilings?.[mode] ?? QUOTA.hardMax;
    const counter = counters?.[mode];
    if (counter) {
      net.push(mode);
      const left = isCounterComplete(counter) ? 0 : remainingSearches(counter, QUOTA.pointsPerSearch);
      counts[mode] = Math.min(ceiling, left);
    } else {
      counts[mode] = Math.min(ceiling, QUOTA[mode].target);
    }
  }
  return { counts, net };
}

/**
 * Did Bing pay for the search just made? Judged against the counter as it
 * stood before it (state.counters), after giving the credit a moment to land.
 * "unknown" whenever the counters are not in use or cannot be read: the run
 * then carries on at its normal pace, exactly as it would without them.
 */
async function creditVerdict(mode, state) {
  const before = state.counters?.[mode];
  if (!before) return { kind: "unknown" };

  let dash = null;
  for (const wait of [tuning.creditSettleMs, tuning.creditRecheckMs]) {
    await sleep(wait);
    dash = await readDashboard();
    const now = dash?.counters?.[mode];
    if (!now || now.current > before.current) break;
  }
  const after = dash?.counters?.[mode];
  if (!after) return { kind: "unknown" };

  await putCachedDashboard(dash);
  await broadcast();
  return {
    kind: after.current > before.current ? "credited" : "missed",
    counters: dash.counters,
    counter: `${after.current}/${after.max}`,
    complete: isCounterComplete(after),
  };
}

export async function stop(reason = "user") {
  clearStepTimer();
  await chrome.alarms.clear(ALARMS.step);
  await putRun({ ...(await getRun()), status: "idle", nextActionAt: 0 });
  await teardown();
  log.info("run stopped", { reason });
  await broadcast();
}

async function teardown() {
  appliedMode = null;
  appliedTabId = null;
  // Window first: a page keeps sending (images, unload beacons) until it is
  // gone, and anything sent after the rule is removed leaves as a desktop.
  await workerWindow.close();
  await clearIdentity();
}

async function finishRun(state) {
  clearStepTimer();
  await chrome.alarms.clear(ALARMS.step);
  await putRun(state);
  await teardown();
  log.info("run finished", { totalDone: state.totalDone });
  await broadcast();
}

/**
 * Books a finished search against the leg by what Bing did with it. A refused
 * search spends a query but not the leg, and puts the leg on the slow pace; a
 * full counter ends the leg; too many refusals in a row give the leg up.
 */
function applyVerdict(state, leg, verdict, now) {
  const mode = leg.mode ?? "activity";
  let next;
  if (verdict.kind === "missed") {
    next = recordMiss(state, now);
    log.warn("rewards credited nothing for this search", {
      mode,
      counter: verdict.counter,
      misses: next.misses,
    });
  } else {
    next = recordSearch(state, now);
    if (verdict.kind === "credited") {
      // While limited, each credit makes Bing's next wait longer.
      next = { ...next, misses: 0, credits: next.throttled ? (next.credits ?? 0) + 1 : 0 };
      log.info("rewards credited this search", { mode, counter: verdict.counter });
    }
  }
  if (verdict.counters) next = { ...next, counters: verdict.counters };

  if (verdict.complete) {
    log.info("counter is full, ending the leg", { mode });
    return { ...next, doneInLeg: leg.total };
  }
  if ((next.misses ?? 0) >= THROTTLE.maxMisses) {
    log.warn("rewards keeps refusing this device, giving up for this run", {
      mode,
      misses: next.misses,
    });
    return { ...next, doneInLeg: leg.total };
  }
  return next;
}

/** One search, then decide what happens next. Every path persists the state. */
export async function step() {
  if (inFlight) return;
  inFlight = true;
  try {
    let state = await getRun();
    if (!isActive(state)) {
      await teardown();
      return;
    }

    const now = Date.now();
    if (!isDue(state, now)) {
      armStep(state.nextActionAt - now);
      return;
    }

    // Rewards counters reset each day; a run carried past midnight would judge
    // the new day's searches against yesterday's counters. Today's run (the
    // daily trigger, or the user) starts afresh instead.
    if (dateKey(new Date(state.startedAt)) !== dateKey(new Date(now))) {
      log.info("the day ended with the run still going, stopping it");
      await finishRun({ ...state, status: "done", finishedAt: now });
      return;
    }

    const leg = currentLeg(state);
    const target = currentTarget(state);
    if (!leg || target === null) {
      await finishRun(advanceLeg(state));
      return;
    }

    const activity = legKind(leg) === "activity";

    // Read the counter right before searching. Points earned elsewhere since
    // the last read (a hand search on the phone) must not be booked as this
    // search's credit, and a counter filled elsewhere needs no more searches.
    if (!activity && state.counters) {
      const latest = await readDashboard();
      const counter = latest?.counters?.[leg.mode];
      if (counter) {
        state = { ...state, counters: latest.counters };
        await putCachedDashboard(latest);
        if (isCounterComplete(counter)) {
          log.info("counter is full, ending the leg", { mode: leg.mode });
          state = advanceLeg({ ...state, doneInLeg: leg.total });
          if (!isActive(state)) {
            await finishRun(state);
            return;
          }
          await putRun(state);
          armStep(0);
          await broadcast();
          return;
        }
      }
    }

    try {
      await ensureIdentity(activity ? "pc" : leg.mode);

      const url = activity ? target.url : buildSearchUrl(target, leg.mode);
      if (activity && target.hash) await reportActivity(target);
      const { outcome } = await workerWindow.open(url);
      log.info(activity ? "activity opened" : "searched", {
        mode: activity ? "activity" : leg.mode,
        target: activity ? target.title : target,
        outcome,
      });
      if (!activity && leg.mode === "mobile") await reportMobileSearch();
      if (activity && target.quest) await invalidateQuests();

      // Credited as soon as the request has gone out; whether the page finished
      // painting in a minimized window is irrelevant to Rewards.
      const day = dateKey();
      const history = recordProgress(
        await getHistory(),
        day,
        activity ? "activity" : leg.mode,
        1
      );
      await putHistory(pruneHistory(history, day));

      void workerWindow.runInTab(scrollResults, [dwellMs(rng)]);
      if (!activity) await readResults(leg.mode);
    } catch (error) {
      state = markFailure(state, error?.message ?? error);
      log.warn("step failed", { failures: state.failures, error: String(error) });

      if (state.failures >= MAX_CONSECUTIVE_FAILURES) {
        await finishRun(markError(state, state.lastError, Date.now()));
        return;
      }
      // Drop the window so the retry starts from a clean tab.
      appliedMode = null;
      appliedTabId = null;
      await workerWindow.close();
      await putRun(scheduleNext(state, Date.now(), RETRY_DELAY_MS, false));
      armStep(RETRY_DELAY_MS);
      await broadcast();
      return;
    }

    const searchedAt = Date.now();
    const verdict = activity ? { kind: "unknown" } : await creditVerdict(leg.mode, state);
    state = applyVerdict(state, leg, verdict, searchedAt);

    state = advanceLeg(state);
    if (!isActive(state)) {
      await finishRun(state);
      return;
    }

    let delayMs;
    let isBreak;
    if (state.throttled) {
      // Bing's limiter: one search per (escalating) gap, and nothing in between.
      delayMs = throttledDelay(
        { credits: state.credits, misses: state.misses, lastWasCredit: verdict.kind === "credited" },
        rng
      );
      isBreak = true;
      log.info("rewards is limiting this device, next search later", {
        mode: currentLeg(state)?.mode,
        at: new Date(searchedAt + delayMs).toISOString(),
        misses: state.misses,
        credits: state.credits,
      });
      delayMs = Math.max(0, searchedAt + delayMs - Date.now());
    } else {
      ({ delayMs, isBreak } = nextDelay({
        sinceBreak: state.sinceBreak,
        breakAfter: state.breakAfter,
        rng,
      }));
      // The credit check already used part of the gap.
      delayMs = Math.max(0, delayMs - (Date.now() - searchedAt));
    }

    if (delayMs > PACING.idleCloseThresholdMs) {
      // Nothing to do for a while: give the memory back.
      appliedMode = null;
      appliedTabId = null;
      await workerWindow.close();
    }

    state = scheduleNext(state, Date.now(), delayMs, isBreak);
    if (isBreak) state = { ...state, breakAfter: nextBreakAfter(rng) };

    await putRun(state);
    armStep(delayMs);
    await broadcast();
  } catch (error) {
    log.error("step crashed", { error: String(error) });
  } finally {
    inFlight = false;
  }
}

// --------------------------------------------------------------------- daily

export function nextDailyTime(settings, now = Date.now(), jitter = dailyJitterMs(rng)) {
  const base = new Date(now);
  base.setHours(settings.daily.hour, settings.daily.minute, 0, 0);
  let when = base.getTime() + jitter;
  // Once today's run is done, today's slot is spent even if still ahead.
  if (when <= now || settings.lastDailyRun === dateKey(new Date(now))) {
    base.setDate(base.getDate() + 1);
    when = base.getTime() + jitter;
  }
  return when;
}

/** Today's chosen daily time has passed and today's run has not happened. */
function dailyMissedToday(settings, now = Date.now()) {
  if (settings.lastDailyRun === dateKey(new Date(now))) return false;
  const today = new Date(now);
  today.setHours(settings.daily.hour, settings.daily.minute, 0, 0);
  return now >= today.getTime();
}

/**
 * Arms the daily alarm only if one is not already pending. Called at every
 * worker and browser start, which is also where a missed day is noticed: a
 * browser opened after the chosen time, with no alarm surviving the restart,
 * would otherwise be pushed to tomorrow and skip today altogether.
 */
export async function ensureDaily(settings) {
  if (!settings.daily.enabled) {
    await chrome.alarms.clear(ALARMS.daily);
    return null;
  }
  const existing = await chrome.alarms.get(ALARMS.daily);
  if (existing) return existing.scheduledTime;

  if (dailyMissedToday(settings) && !isActive(await getRun())) {
    const when = Date.now() + PACING.dailyCatchUpMs + Math.round(rng() * PACING.dailyCatchUpMs);
    chrome.alarms.create(ALARMS.daily, { when });
    ensureWatchdog();
    log.info("daily run missed today, catching up", { when: new Date(when).toISOString() });
    return when;
  }
  return armDaily(settings);
}

export async function armDaily(settings) {
  await chrome.alarms.clear(ALARMS.daily);
  if (!settings.daily.enabled) return null;
  const when = nextDailyTime(settings);
  chrome.alarms.create(ALARMS.daily, { when });
  ensureWatchdog();
  log.info("daily run armed", { when: new Date(when).toISOString() });
  return when;
}

export async function runDaily() {
  const settings = await getSettings();
  const day = dateKey();

  if (settings.lastDailyRun === day) {
    log.info("daily trigger skipped, already ran today");
  } else if (isActive(await getRun())) {
    // A run the user started is doing today's work; restarting would lose it.
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: { ...settings, lastDailyRun: day },
    });
    log.info("daily trigger found a run in progress, leaving it be");
  } else {
    const result = await start();
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: { ...settings, lastDailyRun: day },
    });
    log.info("daily trigger fired", result);
  }
  // Re-read: today is now marked as run, so the next slot is tomorrow's.
  await armDaily(await getSettings());
}

// -------------------------------------------------------------------- restore

/** Called on worker start-up and browser start-up. */
export async function restore() {
  ensureWatchdog();
  await ensureDaily(await getSettings());

  const state = await getRun();
  if (!isActive(state)) return;

  if (Date.now() - state.startedAt > RESUME_WINDOW_MS) {
    log.info("discarding a stale run from a previous session");
    await putRun(createIdleState());
    await teardown();
    return;
  }

  log.info("resuming an interrupted run", { totalDone: state.totalDone });
  armStep(Math.max(0, state.nextActionAt - Date.now()));
}

/**
 * TheNetsky does the farming now (see netsky.js). This worker keeps reading
 * the dashboard and opening tasks, but must never search on its own again:
 * two farmers on one account double the searches Bing sees. Clears every
 * alarm that could start or resume a run, and ends one left running.
 */
export async function retire() {
  clearStepTimer();
  await Promise.all([ALARMS.step, ALARMS.daily, ALARMS.watchdog].map((name) => chrome.alarms.clear(name)));
  if (isActive(await getRun())) await stop("handed over to TheNetsky");
}

// ------------------------------------------------------------------- snapshot

export async function snapshot() {
  const [state, settings, history] = await Promise.all([
    getRun(),
    getSettings(),
    getHistory(),
  ]);
  const day = dateKey();
  const today = Object.fromEntries(
    [...MODES, "activity"].map((mode) => [mode, searchesDone(history, day, mode)])
  );
  const leg = currentLeg(state);
  const daily = await chrome.alarms.get(ALARMS.daily).catch(() => null);
  const cached = await getCachedDashboard();

  // What Start would do now, from the same rules start() uses, so the popup
  // never promises a different run than the one it gets. A reading from
  // another day says nothing about today's counters.
  const fresh = cached?.readAt && dateKey(new Date(cached.readAt)) === day ? cached : null;
  const legs = buildPlan({ modes: MODES, ...planCounts(undefined, fresh?.counters), history, day });
  const quests = await getCachedQuests();
  const tasks = taskList(fresh, quests?.readAt && dateKey(new Date(quests.readAt)) === day ? quests : null);
  const activityBudget = Math.max(0, settings.activities.maxPerDay - today.activity);
  const nextPlan = {
    pc: legs.find((l) => l.mode === "pc")?.total ?? 0,
    mobile: legs.find((l) => l.mode === "mobile")?.total ?? 0,
    activities: settings.activities.enabled
      ? Math.min(tasks.items.filter((t) => t.state === "auto").length, activityBudget)
      : 0,
  };

  return {
    build: BUILD,
    status: state.status,
    mode: legKind(leg) === "activity" ? "activity" : leg?.mode ?? null,
    // Bing is limiting the current leg; the long wait is its, not ours.
    throttled: isActive(state) && Boolean(state.throttled),
    doneInLeg: state.doneInLeg,
    legTotal: leg?.total ?? 0,
    totalDone: state.totalDone,
    planTotal: state.plan.reduce((sum, l) => sum + l.total, 0),
    nextActionAt: state.nextActionAt,
    lastError: state.lastError,
    today,
    targets: { pc: QUOTA.pc.target, mobile: QUOTA.mobile.target },
    nextPlan,
    pointsToday: estimatePoints(today),
    settings,
    nextDailyAt: daily?.scheduledTime ?? null,
    ranToday: settings.lastDailyRun === day,
    dashboard: cached,
    tasks,
  };
}

// ---------------------------------------------------------------------- ports

export function attachPort(port) {
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  void snapshot().then((data) => safePost(port, data));
}

function safePost(port, data) {
  try {
    port.postMessage(data);
  } catch {
    ports.delete(port);
  }
}

export async function broadcast() {
  if (ports.size === 0) return;
  const data = await snapshot();
  for (const port of ports) safePost(port, data);
}
