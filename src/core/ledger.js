/**
 * Points earned today, worked out from the balance.
 *
 * Rewards' own "today" counter (DailyPoint in the flyout) leaves out what the
 * Bing app pays: check-in, read to earn, app offers. The bot farms those too,
 * so the only complete record is the balance: today's earnings are the
 * balance over the last reading of yesterday.
 *
 * Ledger: { day, baseline, last, exact }. `baseline` is the balance today's
 * earnings are counted from, `last` the latest reading, and `exact` whether
 * the baseline is yesterday's last reading rather than today's first one.
 */

const isBalance = (value) => typeof value === "number" && Number.isFinite(value);

/** The ledger after one more reading of the balance on `day`. */
export function trackBalance(ledger, { balance, day, previousDay }) {
  if (!isBalance(balance)) return ledger;

  if (!ledger || ledger.day !== day) {
    // Yesterday's last reading is where today began; anything older is not.
    const fromYesterday = Boolean(ledger) && ledger.day === previousDay;
    return { day, baseline: fromYesterday ? ledger.last : balance, last: balance, exact: fromYesterday };
  }

  // A drop is points spent on a reward, not negative earnings.
  const spent = Math.max(0, ledger.last - balance);
  return { ...ledger, baseline: ledger.baseline - spent, last: balance };
}

/** Points earned on `day`, or null when the ledger does not cover it. */
export function earnedToday(ledger, day) {
  if (!ledger || ledger.day !== day) return null;
  return Math.max(0, ledger.last - ledger.baseline);
}

/**
 * The figure the popup shows as today's points. A ledger that starts from
 * yesterday's last reading counts every point from the real balance, so it
 * is the answer. Otherwise every source is partial, and the largest is the
 * closest: the ledger misses what came before its first reading, Rewards'
 * counter misses app points, the bot misses what it did not earn itself.
 */
export function pickToday({ earned = null, exact = false, dailyPoint = null, bot = null } = {}) {
  if (exact && Number.isFinite(earned)) return earned;
  const views = [earned, dailyPoint, bot].filter(Number.isFinite);
  return views.length ? Math.max(...views) : null;
}
