import { defaultRng } from "./pacing.js";

/**
 * Chooses which Rewards activities are worth automating, and — more to the
 * point — which are not.
 *
 * The safety posture here is deliberately conservative. Clicking through a
 * link-reward offer looks like a person reading the dashboard. Machine-answering
 * a quiz correctly, instantly, every day, does not; those are left for the user
 * to do by hand. Anything pointing off Microsoft's own domains is skipped
 * outright, since a dashboard offer should never send us elsewhere.
 */

/** Offer types that need real answers, or multi-step interaction. */
export const SKIPPED_KINDS = ["quiz", "urlrewardquiz", "thisorthat", "poll", "overlay"];

const ALLOWED_HOSTS = [
  "rewards.bing.com",
  "www.bing.com",
  "bing.com",
  "www.microsoft.com",
  "microsoft.com",
];

export function isSafeOffer(offer) {
  if (!offer || typeof offer !== "object") return false;
  if (SKIPPED_KINDS.includes(String(offer.kind).toLowerCase())) return false;

  let url;
  try {
    url = new URL(offer.url);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return ALLOWED_HOSTS.includes(url.hostname.toLowerCase());
}

/**
 * The page Bing's Rewards flyout runs in. Reporting from here makes the
 * request same-origin with the same referrer as a click in the real flyout.
 */
export const REPORT_PAGE_URL =
  "https://www.bing.com/rewards/panelflyout?channel=BingFlyout&partnerId=BingRewards";

/** The body Bing's flyout posts to /msrewards/api/v1/reportactivity on a click. */
export function buildReportPayload(offer) {
  return {
    ActivityType: offer.activityType ?? null,
    ActivitySubType: "",
    OfferId: offer.id,
    Channel: "BingFlyout",
    PartnerId: "BingRewards",
    UserId: offer.userId ?? "",
    AuthKey: offer.hash,
    ActivityCount: 1,
  };
}

function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Returns the offers to run now: safe ones only, shuffled so the order is not
 * a daily fingerprint, and trimmed to what is left of the daily ceiling. The
 * highest-value offer is kept regardless of the shuffle, so a tight ceiling
 * never costs the big one.
 */
export function selectActivities(offers, { maxPerDay, doneToday, rng = defaultRng }) {
  const budget = Math.max(0, (maxPerDay ?? 0) - (doneToday ?? 0));
  if (budget === 0) return [];

  const safe = (offers ?? []).filter(isSafeOffer);
  if (safe.length === 0) return [];
  if (safe.length <= budget) return shuffle(safe, rng);

  const best = safe.reduce((a, b) => (b.points > a.points ? b : a));
  const rest = shuffle(
    safe.filter((o) => o !== best),
    rng
  ).slice(0, budget - 1);
  return shuffle([best, ...rest], rng);
}
