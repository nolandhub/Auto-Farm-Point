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

/** One pass; the worker runs it every minute. */
export async function tickManualLogin({ api, connectionUrl, tabs = chrome.tabs, storage = chrome.storage.local }) {
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

/** The worker's entry point: the saved connection, one tick, failures logged. */
export async function checkManualLogin() {
  try {
    const connection = await getConnection();
    if (!connection.token) return null;
    return await tickManualLogin({ api: createClient(connection), connectionUrl: connection.url });
  } catch (error) {
    log.warn("manual login check failed", { error: String(error?.message ?? error) });
    return null;
  }
}
