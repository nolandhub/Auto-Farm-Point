import { STORAGE_KEYS } from "./constants.js";
import { parseDashboard } from "./dashboard.js";
import { earnedToday, trackBalance } from "./ledger.js";
import { createClient, getConnection } from "./netsky.js";
import { EARN_URL, readQuests } from "./quests.js";
import { dateKey } from "./quota.js";
import { taskList, toTasks } from "./tasks.js";

/**
 * The popup's dashboard for one of the bot's accounts, not only the one signed
 * in to Edge. The bot's API reads that account's Rewards pages with the
 * session the bot saved for it; this module turns them into the same shape
 * the popup gets for Edge, so one renderer shows both.
 */

export const EDGE = "edge";

/** The bot API's page name for a page the quest reader asks for, or null. */
export function pageFor(url) {
  if (url === EARN_URL) return { page: "earn" };
  const quest = /^https:\/\/rewards\.bing\.com\/earn\/quest\/([A-Za-z0-9_-]+)$/.exec(url);
  return quest ? { page: "quest", id: quest[1] } : null;
}

/**
 * { dashboard, tasks, ledger }: the account's dashboard as the popup caches
 * Edge's, today's task list with its quests, and the account's balance
 * ledger after this reading.
 */
export async function readAccountView({ api, index, ledger = null, now = new Date() }) {
  const flyout = await api.accountRewards(index, "flyout");
  if (!flyout.ok) throw new Error(`HTTP ${flyout.status}`);
  const dash = parseDashboard(JSON.parse(flyout.body), { now });
  if (!dash.signedIn) throw Object.assign(new Error("The account is not signed in to Rewards"), { code: "SIGNED_OUT" });

  const quests = await readQuests({
    fetchPage: async (url) => {
      const target = pageFor(url);
      if (!target) throw new Error(`Not a Rewards page: ${url}`);
      const page = await api.accountRewards(index, target.page, target.id);
      return { ok: page.ok, url: page.url, text: page.body };
    },
  });

  const day = dateKey(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const next = trackBalance(ledger, { balance: dash.availablePoints, day, previousDay: dateKey(yesterday) });
  const dashboard = {
    level: dash.level,
    availablePoints: dash.availablePoints,
    todayPoints: dash.todayPoints,
    earnedToday: earnedToday(next, day),
    earnedExact: next?.day === day && next.exact,
    counters: dash.counters,
    tasks: toTasks(dash.tasks),
    userId: dash.userId,
    source: "bot",
    readAt: now.getTime(),
  };
  return { dashboard, tasks: taskList(dashboard, quests), ledger: next };
}

/**
 * Which account the dashboard shows next. It follows the bot each time the bot
 * moves to another account; in between, it stays on what the user picked.
 * `followed` is the running account the view last followed.
 */
export function nextView({ view, followed, running }) {
  if (!running) return { view, followed: null };
  if (running !== followed) return { view: running, followed: running };
  return { view, followed };
}

/**
 * The worker's side of the popup's request: one account read through the bot's
 * API, its ledger kept. { ok: true, dashboard, tasks } or { ok: false, code }.
 */
export async function loadAccountView({ email, index }) {
  try {
    const api = createClient(await getConnection());
    const stored = await chrome.storage.local.get(STORAGE_KEYS.accountBalances);
    const ledgers = stored?.[STORAGE_KEYS.accountBalances] ?? {};
    const { dashboard, tasks, ledger } = await readAccountView({ api, index, ledger: ledgers[email] ?? null });
    await chrome.storage.local.set({ [STORAGE_KEYS.accountBalances]: { ...ledgers, [email]: ledger } });
    return { ok: true, dashboard, tasks };
  } catch (error) {
    return { ok: false, code: error?.code ?? null, error: String(error?.message ?? error) };
  }
}
