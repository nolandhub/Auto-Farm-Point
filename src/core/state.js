import { SCHEMA_VERSION } from "./constants.js";

export { SCHEMA_VERSION };

/**
 * The run state is a plain, serialisable object and every transition here is a
 * pure function of (state, now). That is what lets the watchdog resume a run
 * after the service worker dies: the state in storage is the whole truth, and
 * nothing depends on module globals surviving.
 *
 * status: idle -> running <-> waiting -> done | error
 */

export function createIdleState() {
  return {
    schema: SCHEMA_VERSION,
    status: "idle",
    plan: [],
    legIndex: 0,
    doneInLeg: 0,
    totalDone: 0,
    queries: [],
    queryIndex: 0,
    offers: [],
    offerIndex: 0,
    sinceBreak: 0,
    breakAfter: 0,
    nextActionAt: 0,
    startedAt: 0,
    finishedAt: 0,
    failures: 0,
    lastError: null,
    // The account's counters as last read, the baseline each search's credit
    // is judged against; null when the dashboard is not in use.
    counters: null,
    // Set once Bing refuses a search in the current leg (see THROTTLE);
    // misses = refusals in a row, credits = credits earned while limited.
    throttled: false,
    misses: 0,
    credits: 0,
  };
}

export function createRun({ plan, queries, offers = [], now, breakAfter = 7, counters = null }) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("createRun requires a non-empty plan");
  }
  return {
    ...createIdleState(),
    status: "running",
    plan,
    queries,
    offers,
    breakAfter,
    counters,
    nextActionAt: now,
    startedAt: now,
  };
}

export function currentLeg(state) {
  return state.plan[state.legIndex] ?? null;
}

/** A leg without an explicit kind is a search leg, as earlier runs wrote them. */
export function legKind(leg) {
  return leg?.kind ?? "search";
}

export function currentQuery(state) {
  return state.queries[state.queryIndex] ?? null;
}

export function currentOffer(state) {
  return state.offers[state.offerIndex] ?? null;
}

/** Whatever the current leg consumes next: a search term or an offer. */
export function currentTarget(state) {
  const leg = currentLeg(state);
  if (!leg) return null;
  return legKind(leg) === "activity" ? currentOffer(state) : currentQuery(state);
}

export function isActive(state) {
  return state?.status === "running" || state?.status === "waiting";
}

export function isDue(state, now) {
  return isActive(state) && now >= state.nextActionAt;
}

/** One unit of work happened. Advances the cursor the current leg consumes. */
export function recordSearch(state, now) {
  const activity = legKind(currentLeg(state)) === "activity";
  return {
    ...state,
    status: "running",
    doneInLeg: state.doneInLeg + 1,
    totalDone: state.totalDone + 1,
    queryIndex: activity ? state.queryIndex : state.queryIndex + 1,
    offerIndex: activity ? state.offerIndex + 1 : state.offerIndex,
    sinceBreak: state.sinceBreak + 1,
    failures: 0,
    nextActionAt: now,
  };
}

/**
 * A search Bing did not credit. It spends a query, but not the leg: the leg is
 * sized in searches Bing still pays for, and this one was not paid. It also
 * puts the leg on Bing's slow pace for the rest of the leg.
 */
export function recordMiss(state, now) {
  return {
    ...state,
    status: "running",
    totalDone: state.totalDone + 1,
    queryIndex: state.queryIndex + 1,
    sinceBreak: state.sinceBreak + 1,
    failures: 0,
    throttled: true,
    misses: (state.misses ?? 0) + 1,
    nextActionAt: now,
  };
}

/** Parks the run until `now + delayMs`. A break also resets the counter. */
export function scheduleNext(state, now, delayMs, isBreak) {
  return {
    ...state,
    status: "waiting",
    nextActionAt: now + delayMs,
    sinceBreak: isBreak ? 0 : state.sinceBreak,
  };
}

/**
 * Called after each search. Moves to the next leg once the current one is
 * full, and ends the run when the plan or the query list is exhausted.
 * The query cursor deliberately carries over so a mode switch never replays
 * terms already searched this run.
 */
export function advanceLeg(state) {
  const leg = currentLeg(state);
  if (!leg) return finish(state);
  if (state.doneInLeg < leg.total) {
    if (currentTarget(state) === null) return finish(state);
    return state;
  }

  const legIndex = state.legIndex + 1;
  if (legIndex >= state.plan.length) return finish(state);

  // Bing limiting one device says nothing about the next one.
  const next = {
    ...state,
    status: "running",
    legIndex,
    doneInLeg: 0,
    throttled: false,
    misses: 0,
    credits: 0,
  };
  return currentTarget(next) === null ? finish(state) : next;
}

function finish(state) {
  return {
    ...state,
    status: "done",
    finishedAt: state.nextActionAt || Date.now(),
  };
}

/**
 * A step blew up. The run is not abandoned — a flaky network or a page that
 * would not load should cost one retry, not the whole session. Only a run of
 * consecutive failures gives up.
 */
export function markFailure(state, message) {
  return { ...state, failures: state.failures + 1, lastError: String(message) };
}

export function markError(state, message, now) {
  return { ...state, status: "error", lastError: String(message), finishedAt: now };
}

/**
 * Anything written by an older build, or corrupted, is discarded rather than
 * patched — a half-migrated run is worse than a clean start.
 */
export function migrate(stored) {
  if (!stored || typeof stored !== "object") return createIdleState();
  if (stored.schema !== SCHEMA_VERSION) return createIdleState();
  return stored;
}
