import { MODES, QUOTA } from "./constants.js";

/**
 * Local calendar day. Rewards resets on Microsoft's clock, but the user's own
 * midnight is the closest approximation we can make without a timezone table,
 * and it is what they will compare against.
 */
export function dateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function searchesDone(history, day, mode) {
  return history?.[day]?.[mode] ?? 0;
}

export function remaining(history, day, mode, target) {
  return Math.max(0, target - searchesDone(history, day, mode));
}

export function hasMetTarget(history, day, mode, target) {
  return searchesDone(history, day, mode) >= target;
}

/** Points the given search counts would actually earn, capped per mode. */
export function estimatePoints(counts) {
  return MODES.reduce((sum, mode) => {
    const n = Math.min(counts?.[mode] ?? 0, QUOTA[mode].cap);
    return sum + n * QUOTA.pointsPerSearch;
  }, 0);
}

/**
 * Turns "what the user asked for" plus "what today already has" into the legs
 * still worth running. A mode already at target is dropped entirely, so
 * re-running mid-day tops up instead of starting over.
 *
 * Modes listed in `net` carry a count read off the account, which is already
 * what is left today. This device's own tally is in that number, so taking it
 * off again would drop legs that still earn points.
 */
export function buildPlan({ modes, counts, history, day, net = [] }) {
  return MODES.filter((mode) => modes.includes(mode))
    .map((mode) => {
      const count = counts?.[mode] ?? QUOTA[mode].target;
      const total = net.includes(mode) ? Math.max(0, count) : remaining(history, day, mode, count);
      return { mode, total };
    })
    .filter((leg) => leg.total > 0);
}

export function recordProgress(history, day, mode, delta) {
  const dayEntry = { ...(history?.[day] ?? {}) };
  dayEntry[mode] = (dayEntry[mode] ?? 0) + delta;
  return { ...(history ?? {}), [day]: dayEntry };
}

/** Drops days outside the retention window so storage cannot grow forever. */
export function pruneHistory(history, day, retentionDays = QUOTA.retentionDays) {
  const cutoff = new Date(`${day}T00:00:00`);
  cutoff.setDate(cutoff.getDate() - retentionDays);
  const cutoffKey = dateKey(cutoff);
  return Object.fromEntries(
    Object.entries(history ?? {}).filter(([key]) => key >= cutoffKey)
  );
}
