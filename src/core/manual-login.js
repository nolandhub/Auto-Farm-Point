import { STORAGE_KEYS } from "./constants.js";
import { log } from "./log.js";
import { createClient, getConnection } from "./netsky.js";

/**
 * Opens the bot's own browser (noVNC) when an account needs a person to sign
 * in: an emailed code, a passkey, anything the bot cannot do alone. The control
 * API spots those accounts in the bot's log; this module opens the page once
 * per request, closes it when the sign-in ends, and reruns the account.
 */

const KEEP_HANDLED = 50;
const EMPTY = { handled: [], tabId: null, email: null, rerun: [] };

export const requestKey = (request) => `${request.email}|${request.at}`;

/** The oldest request not opened yet, or null. */
export function nextRequest(status, handled) {
  const seen = new Set(handled);
  const open = (status?.requests ?? []).filter((request) => !seen.has(requestKey(request)));
  open.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return open[0] ?? null;
}

/** The noVNC page: the API's host, on the port the API reports. */
export function pageUrl(connectionUrl, status) {
  const { protocol, hostname } = new URL(connectionUrl);
  return `${protocol}//${hostname}:${status.webPort}${status.path}`;
}

async function load(storage) {
  const stored = await storage.get(STORAGE_KEYS.manualLogin);
  return { ...EMPTY, ...(stored?.[STORAGE_KEYS.manualLogin] ?? {}) };
}

const save = (storage, state) => storage.set({ [STORAGE_KEYS.manualLogin]: state });

/** Starts a manual sign-in and opens its page; the manager's button uses it too. */
export async function openManualLogin({ api, connectionUrl, email, tabs = chrome.tabs, storage = chrome.storage.local }) {
  const status = await api.startManualLogin(email);
  const tab = await tabs.create({ url: pageUrl(connectionUrl, status), active: true });
  await save(storage, { ...(await load(storage)), tabId: tab?.id ?? null, email });
  return status;
}

// The minute alarm and a running watch can both tick: one at a time, so a page
// is closed and an account rerun once.
let queue = Promise.resolve();

/** One pass; the worker runs it every minute, and the watch below when a sign-in ends. */
export function tickManualLogin(options) {
  const next = queue.then(() => tick(options));
  queue = next.catch(() => {});
  return next;
}

async function tick({ api, connectionUrl, tabs = chrome.tabs, storage = chrome.storage.local }) {
  let status;
  try {
    status = await api.manualLoginStatus();
  } catch {
    return null; // an API without manual login, or with it turned off
  }
  let state = await load(storage);
  const running = status.state === "running";

  // A sign-in opened from here has ended: close its page, rerun on success.
  if (state.email && !running) {
    if (state.tabId != null) await tabs.remove(state.tabId).catch(() => {});
    const saved = status.state === "succeeded" && status.email === state.email;
    const rerun = saved && !state.rerun.includes(state.email) ? [...state.rerun, state.email] : state.rerun;
    state = { ...state, tabId: null, email: null, rerun };
    await save(storage, state);
  }
  if (running) return null;

  const request = nextRequest(status, state.handled);
  if (request) {
    await save(storage, { ...state, handled: [...state.handled, requestKey(request)].slice(-KEEP_HANDLED) });
    await openManualLogin({ api, connectionUrl, email: request.email, tabs, storage });
    return "opened";
  }

  if (state.rerun.length && (await api.status()).state === "idle") {
    const [email, ...rest] = state.rerun;
    await save(storage, { ...state, rerun: rest });
    const { accounts = [] } = await api.accounts();
    const account = accounts.find((candidate) => candidate.email === email);
    if (account) await api.start({ accountIndex: Number(account.index) });
    return "rerun";
  }
  return null;
}

const WATCH_INTERVAL_MS = 3_000;
// The API gives a sign-in 15 minutes; a little longer covers its last status.
const WATCH_LIMIT_MS = 16 * 60 * 1000;

/**
 * Follows a sign-in opened from here every few seconds, so its page closes and
 * the account reruns right after the session is saved, not at the next
 * minute's check. That check stays the fallback when the worker is stopped.
 */
export async function watchManualLogin({
  api,
  connectionUrl,
  tabs = chrome.tabs,
  storage = chrome.storage.local,
  intervalMs = WATCH_INTERVAL_MS,
  limitMs = WATCH_LIMIT_MS,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const until = now() + limitMs;
  while (now() < until) {
    // A storage read each pass is also an extension API call, which keeps the worker alive.
    if (!(await load(storage)).email) return null;
    const status = await api.manualLoginStatus().catch(() => null); // the API may be restarting
    if (status && status.state !== "running") return tickManualLogin({ api, connectionUrl, tabs, storage });
    await sleep(intervalMs);
  }
  return null;
}

let watching = false;

/** The worker's entry point: the saved connection, one tick, then the watch; failures logged. */
export async function checkManualLogin() {
  try {
    const connection = await getConnection();
    if (!connection.token) return null;
    const api = createClient(connection);
    const result = await tickManualLogin({ api, connectionUrl: connection.url });
    if (!watching) {
      watching = true;
      try {
        await watchManualLogin({ api, connectionUrl: connection.url });
      } finally {
        watching = false;
      }
    }
    return result;
  } catch (error) {
    log.warn("manual login check failed", { error: String(error?.message ?? error) });
    return null;
  }
}
