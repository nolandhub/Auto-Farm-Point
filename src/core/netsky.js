import { STORAGE_KEYS } from "./constants.js";

/**
 * Client for the control API of Microsoft Rewards Script (TheNetsky), which
 * now does all the farming: searches on both devices, the app's check-in and
 * read-to-earn, promotions, punch cards. It runs in Docker on this machine;
 * this extension only watches and steers it.
 *
 * The API binds to loopback and wants a token on every call. Requests from
 * here are exempt from CORS through the host permission, so the API can keep
 * its CORS origin locked to this extension against web pages.
 */

export const DEFAULT_CONNECTION = { url: "http://127.0.0.1:3010", token: "" };

const TIMEOUT_MS = 8_000;

/** How long Microsoft waits for an Authenticator approval before giving up. */
const APPROVAL_WINDOW_MS = 3 * 60 * 1000;

export class NetskyError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.name = "NetskyError";
    this.status = status;
    this.code = code;
  }
}

export async function getConnection() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.netsky);
    return { ...DEFAULT_CONNECTION, ...(stored?.[STORAGE_KEYS.netsky] ?? {}) };
  } catch {
    return { ...DEFAULT_CONNECTION };
  }
}

/** Only a loopback address: the token must never leave this machine. */
export function isLocalUrl(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "http:" && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

export async function saveConnection({ url, token }) {
  const next = { url: String(url ?? "").trim().replace(/\/+$/, ""), token: String(token ?? "").trim() };
  if (!isLocalUrl(next.url)) throw new NetskyError("not a local address", { code: "BAD_URL" });
  await chrome.storage.local.set({ [STORAGE_KEYS.netsky]: next });
  return next;
}

export function createClient({ url, token }, fetchImpl = (...args) => globalThis.fetch(...args)) {
  const base = String(url).replace(/\/+$/, "");

  async function call(method, path, body) {
    if (!isLocalUrl(base)) throw new NetskyError("not a local address", { code: "BAD_URL" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        cache: "no-store",
      });
    } catch {
      throw new NetskyError("TheNetsky is not reachable", { code: "OFFLINE" });
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = data.code ?? (response.status === 401 ? "UNAUTHORIZED" : null);
      throw new NetskyError(data.error ?? `HTTP ${response.status}`, { status: response.status, code });
    }
    return data;
  }

  const query = (params) => {
    const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null);
    return entries.length ? `?${new URLSearchParams(entries)}` : "";
  };

  return {
    health: () => call("GET", "/health"),
    status: () => call("GET", "/status"),
    points: () => call("GET", "/points"),
    accounts: () => call("GET", "/accounts"),
    sessions: () => call("GET", "/sessions"),
    logs: ({ afterId, limit, level } = {}) => call("GET", `/logs${query({ afterId, limit, level })}`),
    errors: () => call("GET", "/errors"),
    history: () => call("GET", "/history"),
    schedule: () => call("GET", "/schedule"),
    config: () => call("GET", "/config"),
    start: ({ accountIndex } = {}) => call("POST", "/start", accountIndex ? { accountIndex } : {}),
    stop: ({ force = false } = {}) => call("POST", "/stop", { force }),
    addAccount: (fields) => call("POST", "/accounts", fields),
    updateAccount: (index, fields) => call("PATCH", `/accounts/${Number(index)}`, fields),
    removeAccount: (index) => call("DELETE", `/accounts/${Number(index)}`),
    deleteSession: (email) => call("DELETE", `/sessions/${encodeURIComponent(email)}`),
    patchConfig: (partial) => call("PATCH", "/config", partial),
    patchSchedule: (fields) => call("PATCH", "/schedule", fields),
    manualLoginStatus: () => call("GET", "/manual-login"),
    startManualLogin: (email, platform) => call("POST", "/manual-login", platform ? { email, platform } : { email }),
    cancelManualLogin: () => call("DELETE", "/manual-login"),
  };
}

export async function connect(fetchImpl) {
  return createClient(await getConnection(), fetchImpl);
}

// ------------------------------------------------------------------ schedule

/** A run every day at hour:minute, as the API's five-field cron. */
export function cronFromTime(hour, minute) {
  return `${Number(minute)} ${Number(hour)} * * *`;
}

/** The time of a daily cron, or null for anything the time picker cannot show. */
export function timeFromCron(cron) {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(String(cron ?? "").trim());
  if (!match) return null;
  const minute = Number(match[1]);
  const hour = Number(match[2]);
  return minute < 60 && hour < 24 ? { hour, minute } : null;
}

// --------------------------------------------------------------------- login

const LOGIN_TITLE = "LOGIN-PASSWORDLESS";
const NUMBER_PROMPT = /select number:\s*(\d{1,3})/i;
const WAITING = /please approve login|waiting for approval/i;

/**
 * The Authenticator approval the bot is waiting on, if any: the newest
 * passwordless line for an account is still the request, and it is recent.
 * `{ user, number }`, where number is null when Microsoft showed none.
 */
export function loginPrompt(logs, now = Date.now()) {
  const lines = (logs ?? []).filter((entry) => entry?.title === LOGIN_TITLE);
  const seen = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const { user } = lines[i];
    if (seen.has(user)) continue;
    seen.add(user);
    if (!WAITING.test(String(lines[i].message ?? ""))) continue;
    const at = Date.parse(lines[i].receivedAt);
    if (Number.isFinite(at) && now - at > APPROVAL_WINDOW_MS) continue;

    // "select number: 42" comes first, then "Waiting for approval...": look
    // back through this same request for the number.
    let number = null;
    for (let j = i; j >= 0 && number === null; j--) {
      if (lines[j].user !== user) continue;
      const message = String(lines[j].message ?? "");
      if (!WAITING.test(message)) break;
      number = NUMBER_PROMPT.exec(message)?.[1] ?? null;
    }
    return { user, number };
  }
  return null;
}

// --------------------------------------------------------------------- badge

/** The toolbar badge: what needs the user first, then whether it is working. */
export function badgeFor({ reachable, state, prompt, failed, manual }) {
  if (prompt) return { text: prompt.number ?? "!", color: "#b45309" };
  if (manual) return { text: "!", color: "#b45309" };
  if (!reachable) return { text: "", color: "#6b7280" };
  if (state && state !== "idle") return { text: "ON", color: "#15803d" };
  if (failed) return { text: "!", color: "#b91c1c" };
  return { text: "", color: "#6b7280" };
}

/**
 * Whether the last finished run ended badly: it could not start, or exited
 * non-zero. A run the user stopped ends on a signal, which is not a failure.
 */
export function lastRunFailed(status) {
  const exit = status?.lastExit;
  if (!exit) return false;
  return Boolean(exit.error) || (typeof exit.code === "number" && exit.code !== 0);
}

/**
 * Reads TheNetsky's state and shows it on the toolbar icon, so an
 * Authenticator request is seen without opening the popup.
 */
export async function refreshBadge(fetchImpl) {
  let badge;
  try {
    const api = await connect(fetchImpl);
    const [status, { logs }, manualStatus] = await Promise.all([
      api.status(),
      api.logs({ limit: 60 }),
      // An older API has no manual login; that must not blank the badge.
      api.manualLoginStatus().catch(() => null),
    ]);
    badge = badgeFor({
      reachable: true,
      state: status.state,
      prompt: status.state === "idle" ? null : loginPrompt(logs),
      failed: lastRunFailed(status),
      manual: manualStatus?.state === "running",
    });
  } catch {
    badge = badgeFor({ reachable: false });
  }
  await chrome.action?.setBadgeText({ text: badge.text });
  await chrome.action?.setBadgeBackgroundColor({ color: badge.color });
  return badge;
}
