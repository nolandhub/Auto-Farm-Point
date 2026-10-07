import { log } from "./log.js";

/**
 * Reads the user's real Rewards dashboard so the extension stops guessing.
 *
 * This matters for safety more than for convenience: hard-coded caps (30 PC /
 * 20 mobile) are a guess that varies by country and membership level, and
 * searching past the real cap earns nothing while being the loudest automation
 * signal there is. With the real counters in hand the run stops exactly when
 * Microsoft says it is done.
 *
 * The primary source is the payload behind the Rewards icon in Bing's own
 * header. It rides on the bing.com sign-in, which is the one searches are
 * credited to, so it is signed in exactly when searching earns anything.
 * rewards.bing.com moved to a separate sign-in when it was rebuilt, and its
 * pages no longer embed the old `var dashboard` blob, so it is only a fallback.
 *
 * Everything here is defensive. The payload shape is not a documented contract,
 * so a parse failure degrades to "unknown" and the caller falls back to its own
 * counting rather than breaking the run.
 */

export const FLYOUT_URL =
  "https://www.bing.com/rewards/panelflyout/getuserinfo?channel=BingFlyout&partnerId=BingRewards";
const LEGACY_API_URL = "https://rewards.bing.com/api/getuserinfo?type=1";
const TIMEOUT_MS = 12_000;

/** Bing's flyout drops PCSearch entries whose offerId carries this keyword. */
const EDGE_BONUS_KEYWORD = "edgeplusbing";

/** Counter keys are PascalCase in the flyout and camelCase in the legacy api. */
function findKey(object, name) {
  if (!object || typeof object !== "object") return undefined;
  const key = Object.keys(object).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : object[key];
}

function isEdgeBonus(entry) {
  const id = String(entry?.offerId ?? "").toLowerCase();
  return id.includes(EDGE_BONUS_KEYWORD) || /edge/i.test(String(entry?.name ?? ""));
}

/**
 * Mirrors Bing's own SearchEarningCard: the first entry with a real maximum,
 * skipping the Edge bonus that shares the PCSearch array.
 */
function pickCounter(list, { skipEdgeBonus = false } = {}) {
  if (!Array.isArray(list)) return null;
  const entry = list.find(
    (c) =>
      c &&
      typeof c === "object" &&
      Number(c.pointProgressMax) > 0 &&
      !(skipEdgeBonus && isEdgeBonus(c))
  );
  if (!entry) return null;
  const current = Number(entry.pointProgress);
  const max = Number(entry.pointProgressMax);
  if (!Number.isFinite(current) || !Number.isFinite(max)) return null;
  return { current, max, complete: Boolean(entry.complete) };
}

function toOffer(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.complete) return null;
  // Bing's click handler reports nothing for these, so nothing is earned.
  if (raw.isRewardable === false) return null;
  if (String(raw.exclusiveLockedFeatureStatus ?? "").toLowerCase() === "locked") return null;

  const url = raw.destinationUrl ?? raw.attributes?.destination;
  if (typeof url !== "string" || !url) return null;

  const max = Number(raw.pointProgressMax) || 0;
  const points = max - Math.max(0, Number(raw.pointProgress) || 0);
  if (points <= 0) return null;

  return {
    id: String(raw.offerId ?? raw.name ?? url),
    title: String(raw.title ?? raw.attributes?.title ?? "activity"),
    url,
    points,
    kind: String(raw.promotionType ?? raw.attributes?.type ?? "urlreward").toLowerCase(),
    hash: typeof raw.hash === "string" && raw.hash ? raw.hash : null,
    activityType: raw.activityType ?? null,
  };
}

/**
 * One of today's tasks as the popup lists it, finished or not: the list shows
 * progress, so done tasks stay in it. Anything with nothing to earn (locked,
 * unrewardable, zero points) is left out.
 */
function toTask(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (raw.isRewardable === false) return null;
  if (String(raw.exclusiveLockedFeatureStatus ?? "").toLowerCase() === "locked") return null;
  const max = Number(raw.pointProgressMax) || 0;
  if (max <= 0) return null;
  const url = raw.destinationUrl ?? raw.attributes?.destination;
  return {
    id: String(raw.offerId ?? raw.name ?? url),
    title: String(raw.title ?? raw.attributes?.title ?? "activity"),
    points: max,
    done: Boolean(raw.complete) || Number(raw.pointProgress) >= max,
    kind: String(raw.promotionType ?? raw.attributes?.type ?? "urlreward").toLowerCase(),
    url: typeof url === "string" ? url : "",
    // What reporting a click needs, as the Rewards flyout does on a click.
    hash: typeof raw.hash === "string" && raw.hash ? raw.hash : null,
    activityType: raw.activityType ?? null,
  };
}

/** "+07:00" -> minutes, as Bing's flyout parses its market offset. */
function parseOffset(value) {
  const match = String(value ?? "").trim().match(/^([+-])(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

/** The daily-set key for "today": MM/DD/YYYY on the market's clock if known. */
export function dailySetKey(now = new Date(), marketOffset = null) {
  const offset = parseOffset(marketOffset);
  const date = offset === null ? now : new Date(now.getTime() + offset * 60_000);
  const month = offset === null ? date.getMonth() + 1 : date.getUTCMonth() + 1;
  const day = offset === null ? date.getDate() : date.getUTCDate();
  const year = offset === null ? date.getFullYear() : date.getUTCFullYear();
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}

/**
 * The daily set lists tomorrow's offers as a preview; only today's can earn.
 * A single dated group is taken as today's whatever its key, since the clocks
 * can disagree around midnight.
 */
function todaysDailySet(dailySet, now, marketOffset) {
  const groups = Object.entries(dailySet ?? {});
  const today = groups.find(([key]) => key === dailySetKey(now, marketOffset));
  if (today) return [].concat(today[1] ?? []);
  return groups.length === 1 ? [].concat(groups[0][1] ?? []) : [];
}

/** Bing's medal for each level of the current program, for a payload that leaves levelMedallion out. */
const MEDALS = { newLevel1: "Base", newLevel2: "Silver", newLevel3: "Gold" };
const medalUrl = (name) => `https://bing.com/th?id=OMR.Medals.${name}.png&pid=Rewards&w=104&p=0&qlt=100`;

function promotionAttributes(raw, name) {
  const promotion = (raw.userInfo?.promotions ?? []).find((p) => p?.name === name);
  return promotion?.attributes ?? {};
}

/** The level promotions list one entry per level, ";"-separated, in supportedLevelKeys' order. */
function perLevel(value) {
  return typeof value === "string" ? value.split(";").map((entry) => entry.trim()) : [];
}

/** The popup puts this in an <img>, so only an https address is taken. */
function httpsUrl(value) {
  try {
    return new URL(value).protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

/**
 * The account's Rewards level as { key, title, icon }, or null: Bing's own
 * title ("Gold Member") and medal image for it. The legacy api names an
 * old-program level (Level1/Level2), which has neither.
 */
function rankOf(raw, status) {
  const benefits = promotionAttributes(raw, "level_benefits");
  const info = promotionAttributes(raw, "level_info");
  const key = [status.level, benefits.activeLevel, info.level].find((v) => typeof v === "string" && v);
  if (!key) return null;
  const index = perLevel(benefits.supportedLevelKeys ?? info.level_keys).indexOf(key);
  const pick = (value) => (index < 0 ? "" : (perLevel(value)[index] ?? ""));
  return {
    key,
    title: pick(info.level_values) || key,
    icon: httpsUrl(pick(benefits.levelMedallion)) ?? (MEDALS[key] ? medalUrl(MEDALS[key]) : null),
  };
}

/**
 * Accepts either the flyout payload ({ flyoutResult, userInfo, ... }) or the
 * legacy dashboard object, and returns one normalised shape for both.
 */
export function parseDashboard(raw, { now = new Date() } = {}) {
  const empty = {
    signedIn: false,
    level: null,
    rank: null,
    availablePoints: null,
    todayPoints: null,
    counters: { pc: null, mobile: null },
    offers: [],
    tasks: [],
    userId: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return empty;

  const body = raw.flyoutResult ?? raw;
  const status = body.userStatus ?? {};
  const counters = status.counters ?? {};
  const signedIn =
    raw.isRewardsUser !== false &&
    raw.userInfo?.isRewardsUser !== false &&
    status.isRewardsUser !== false;

  const marketOffset = body.dailyCheckInPromotion?.attributes?.markettimeoffset ?? null;
  const today = [...todaysDailySet(body.dailySetPromotions, now, marketOffset), ...(body.morePromotions ?? [])];
  const offers = today.map(toOffer).filter(Boolean);
  const tasks = today.map(toTask).filter(Boolean);

  const available = Number(status.availablePoints);
  const daily = findKey(counters, "dailyPoint");
  const todayPoints = Array.isArray(daily) ? Number(daily[0]?.pointProgress) : NaN;
  const rank = rankOf(raw, status);

  return {
    signedIn,
    level: rank?.key ?? null,
    rank,
    availablePoints: Number.isFinite(available) && signedIn ? available : null,
    todayPoints: Number.isFinite(todayPoints) && signedIn ? todayPoints : null,
    counters: {
      pc: pickCounter(findKey(counters, "pcSearch"), { skipEdgeBonus: true }),
      mobile: pickCounter(findKey(counters, "mobileSearch")),
    },
    offers,
    tasks,
    userId: typeof raw.userId === "string" && raw.userId ? raw.userId : null,
  };
}

export function isCounterComplete(counter) {
  if (!counter) return false;
  return Boolean(counter.complete) || counter.current >= counter.max;
}

/** Leftover points expressed as whole searches, or null if we cannot tell. */
export function remainingSearches(counter, pointsPerSearch) {
  if (!counter || !pointsPerSearch) return null;
  return Math.max(0, Math.ceil((counter.max - counter.current) / pointsPerSearch));
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { credentials: "include", signal: controller.signal, ...init });
  } finally {
    clearTimeout(timer);
  }
}

async function readFlyout(note) {
  const response = await fetchWithTimeout(FLYOUT_URL);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const parsed = parseDashboard(await response.json());
  if (!parsed.signedIn) {
    note("warn", "bing.com reports no Rewards sign-in; searches will not earn until you sign in");
    return null;
  }
  return parsed;
}

/**
 * The old api answers a missing sign-in with a redirect into an interactive
 * login flow. Not following it keeps a signed-out read to one request.
 */
async function readLegacy() {
  const response = await fetchWithTimeout(LEGACY_API_URL, { redirect: "manual" });
  if (!response.ok) throw new Error(`HTTP ${response.status || response.type}`);
  const json = await response.json();
  const parsed = parseDashboard(json?.dashboard ?? json);
  return parsed.counters.pc || parsed.offers.length ? parsed : null;
}

let lastNotes = "";

/**
 * The open popup re-reads every 1.5s. A read that ends exactly like the one
 * before is not logged again, or polling would push a run's own lines out of
 * the 300-entry log.
 */
function logUnlessRepeated(notes) {
  const key = JSON.stringify(notes);
  if (key === lastNotes) return;
  lastNotes = key;
  for (const [level, message, data] of notes) log[level](message, data);
}

/**
 * Returns a parsed dashboard, or null if the user is signed out or the shape
 * has moved. Never throws: an unreadable dashboard must not stop a run.
 */
export async function readDashboard() {
  const notes = [];
  const note = (level, message, data) => notes.push([level, message, data]);
  let result = null;
  for (const [source, read] of [
    ["flyout", readFlyout],
    ["legacy", readLegacy],
  ]) {
    try {
      const parsed = await read(note);
      if (parsed) {
        note("info", "dashboard read", {
          source,
          points: parsed.availablePoints,
          pc: parsed.counters.pc && `${parsed.counters.pc.current}/${parsed.counters.pc.max}`,
          mobile:
            parsed.counters.mobile && `${parsed.counters.mobile.current}/${parsed.counters.mobile.max}`,
          offers: parsed.offers.length,
        });
        result = { ...parsed, source };
        break;
      }
    } catch (error) {
      note("debug", "dashboard source unavailable", { source, error: String(error) });
    }
  }
  if (!result) note("warn", "could not read the Rewards dashboard, using local counts");
  logUnlessRepeated(notes);
  return result;
}
