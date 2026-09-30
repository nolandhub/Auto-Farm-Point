import { log } from "./log.js";

/**
 * Reads the Quests ("punch cards") on rewards.bing.com/earn. Neither the
 * bing.com flyout nor the old getuserinfo api carries them any more, so the
 * only source is the Earn page itself: it links each quest, and a quest page
 * renders its header as HTML and its activities as React Server Component data
 * inside a JS string, each activity with the offerId and hash that reporting
 * it needs.
 *
 * A quest pays once, when all its activities are done, and unlocks the next
 * activity 24 hours after the previous one: so on any given day there is at
 * most one activity per quest to do. Quests that must be done in the Rewards
 * app are listed for the user but never automated.
 *
 * All of this reads markup that is not a contract. Every parser degrades to
 * "nothing found" instead of throwing, so a redesign costs the quests, not the
 * run.
 */

export const EARN_URL = "https://rewards.bing.com/earn";
const TIMEOUT_MS = 12_000;
/** More than a handful of quests at once has never been seen; cap the fetches. */
const MAX_QUESTS = 6;

const decodeEntities = (text) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

export function parseQuestIds(html) {
  if (typeof html !== "string") return [];
  const ids = [...html.matchAll(/\/earn\/quest\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
  return [...new Set(ids)];
}

/** The flat object around one `"offerId":"…"` in the (unescaped) RSC data. */
function objectAround(text, index) {
  const start = text.lastIndexOf("{", index);
  const end = text.indexOf("}", index);
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseChildren(rsc) {
  const children = [];
  const seen = new Set();
  for (const m of rsc.matchAll(/"offerId":"/g)) {
    const raw = objectAround(rsc, m.index);
    if (!raw?.offerId || !raw.hash || !raw.href || seen.has(raw.offerId)) continue;
    seen.add(raw.offerId);
    // ariaLabel reads "<link text>, <activity title>".
    const label = String(raw.ariaLabel ?? "");
    const comma = label.indexOf(", ");
    children.push({
      offerId: String(raw.offerId),
      hash: String(raw.hash),
      href: String(raw.href),
      title: comma === -1 ? String(raw.linkText ?? label) : label.slice(comma + 2),
      isCompleted: raw.isCompleted === true,
      isLocked: raw.isLocked === true,
    });
  }
  return children;
}

/** One quest page, or null if the page is not a quest (a login page, say). */
export function parseQuestPage(html, id) {
  if (typeof html !== "string") return null;
  const title = html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1];
  if (!title) return null;

  const plain = html.replace(/<!-- -->/g, "");
  const progress = plain.match(/(\d+)\s*\/\s*(\d+)\s*tasks/);
  const rsc = html.replace(/\\"/g, '"');
  const appOnly = /must complete the activities in the (?:Desktop )?Rewards app|Rewards App exclusive/i.test(plain);

  return {
    id,
    title: decodeEntities(title.trim()),
    // Quests for the Windows Rewards app show no "+N" badge; their reward is
    // only in the description, which ends "…in the Desktop Rewards app.(0/70)".
    points: Number(plain.match(/\+(\d+)<\/p>/)?.[1] ?? plain.match(/\((\d+)\s*\/\s*(\d+)\)/)?.[2] ?? 0),
    done: progress ? Number(progress[1]) : 0,
    total: progress ? Number(progress[2]) : 0,
    expiresAt: rsc.match(/"expiresAt":"\$D([^"]+)"/)?.[1] ?? null,
    appOnly,
    // Which Rewards app: the Windows one is called "Desktop Rewards app".
    appKind: appOnly ? (/Desktop Rewards app/i.test(plain) ? "desktop" : "mobile") : null,
    children: parseChildren(rsc),
  };
}

/**
 * The quest activities a run can do now: unlocked, not yet done, and outside
 * the app. Shaped like dashboard offers, so they go through the same safety
 * filter and the same report-then-open click.
 */
export function questOffers(quests) {
  return (quests ?? []).flatMap((quest) =>
    quest.appOnly
      ? []
      : quest.children
          .filter((c) => !c.isCompleted && !c.isLocked)
          .map((c) => ({
            id: c.offerId,
            title: c.title,
            url: c.href,
            points: 0, // a quest pays when its last activity is done
            kind: "urlreward",
            activityType: "urlreward",
            hash: c.hash,
            quest: quest.id,
          }))
  );
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    return { ok: response.ok, url: response.url || url, text: await response.text() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * { signedIn, quests }. signedIn is false when rewards.bing.com sends us to a
 * login page (it has its own sign-in, separate from bing.com's), null when the
 * page could not be read at all. Never throws. `fetchPage` reads a page
 * ({ ok, url, text }); another account's pages come through the bot's API.
 */
export async function readQuests({ fetchPage: read = fetchPage } = {}) {
  try {
    const earn = await read(EARN_URL);
    const landed = new URL(earn.url);
    if (!earn.ok || landed.host !== "rewards.bing.com" || !landed.pathname.startsWith("/earn")) {
      log.info("rewards.bing.com is not signed in, quests skipped");
      return { signedIn: false, quests: [] };
    }

    const quests = [];
    for (const id of parseQuestIds(earn.text).slice(0, MAX_QUESTS)) {
      try {
        const page = await read(`${EARN_URL}/quest/${id}`);
        const quest = page.ok ? parseQuestPage(page.text, id) : null;
        if (quest) quests.push(quest);
      } catch (error) {
        log.debug("quest page unavailable", { id, error: String(error) });
      }
    }
    log.info("quests read", {
      quests: quests.map((q) => `${q.done}/${q.total}${q.appOnly ? " app" : ""}`),
      doable: questOffers(quests).length,
    });
    return { signedIn: true, quests };
  } catch (error) {
    log.debug("quests unavailable", { error: String(error) });
    return { signedIn: null, quests: [] };
  }
}
