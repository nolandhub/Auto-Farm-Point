import { STORAGE_KEYS } from "../src/core/constants.js";
import { resolveLang, t } from "../src/core/i18n.js";
import { openManualLogin } from "../src/core/manual-login.js";
import {
  createClient,
  cronFromTime,
  getConnection,
  lastRunFailed,
  loginPrompt,
  saveConnection,
  timeFromCron,
} from "../src/core/netsky.js";

/**
 * The full control page for TheNetsky: connection, runs, accounts, schedule,
 * which jobs to do, the live log, and past runs. Everything goes through the
 * bot's control API; nothing here touches Bing itself.
 */

/** Run state and the log are re-read this often. */
const POLL_MS = 2_000;
/** Accounts, sessions, schedule, config and history: this often, and after every change. */
const SLOW_MS = 10_000;
const LOG_KEEP = 400;
const DEFAULT_RUN_TIME = { hour: 7, minute: 0 };

/** The config switches offered, as [section, key]; labels are `job_<key>`. */
const JOBS = [
  ["workers", "doDailySet"],
  ["workers", "doMorePromotions"],
  ["workers", "doPunchCards"],
  ["workers", "doDesktopSearch"],
  ["workers", "doMobileSearch"],
  ["workers", "doDailyCheckIn"],
  ["workers", "doReadToEarn"],
  ["workers", "doAppPromotions"],
  ["workers", "doClaimBonusPoints"],
  ["workers", "doActivateSearchPerk"],
  ["workers", "doBonusSearches"],
  ["workers", "doVisualSearch"],
  ["experimental", "edgeBrowsing"],
];

const el = (id) => document.getElementById(id);

let lang = "en";
let api = null;
let pollTimer = null;
/** offline | needsToken | badToken | ready */
let phase = "offline";
let status = null;
let accounts = [];
let sessions = [];
let schedule = null;
let config = null;
let history = [];
let logs = [];
let lastLogId = 0;
let slowAt = 0;
let editing = null;

// ------------------------------------------------------------------ helpers

const fmt = (n) => Number(n ?? 0).toLocaleString(lang === "vi" ? "vi-VN" : "en-US");
const locale = () => (lang === "vi" ? "vi-VN" : "en-US");
const pad = (n) => String(n).padStart(2, "0");

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${pad(minutes % 60)}`;
}

function setStatus(id, text, tone = "") {
  const node = el(id);
  node.dataset.tone = tone;
  node.textContent = text;
}

const failure = (error) => t(lang, "actionFailed", { message: error?.message ?? String(error) });
const running = () => phase === "ready" && status?.state !== "idle";

function button(label, className, onClick) {
  const node = document.createElement("button");
  node.type = "button";
  node.className = className;
  node.textContent = label;
  node.addEventListener("click", onClick);
  return node;
}

function applyLanguage() {
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(lang, node.dataset.i18n);
  document.documentElement.lang = lang;
  document.title = t(lang, "manageTitle");
}

async function loadLookAndLanguage() {
  let saved = {};
  try {
    saved = (await chrome.storage.local.get(STORAGE_KEYS.settings))?.[STORAGE_KEYS.settings] ?? {};
  } catch {
    /* defaults */
  }
  lang = resolveLang(saved.lang ?? "auto", chrome.i18n.getUILanguage());
  if (saved.theme === "light" || saved.theme === "dark") document.documentElement.dataset.theme = saved.theme;
  applyLanguage();
}

// ---------------------------------------------------------------- rendering

const PILL_KEYS = {
  offline: "pillOffline",
  idle: "pillIdle",
  starting: "pillStarting",
  running: "pillRunning",
  stopping: "pillStopping",
};

function renderConnection() {
  const state = phase === "ready" ? status?.state ?? "idle" : "offline";
  el("statePill").dataset.state = state;
  el("stateText").textContent = t(lang, PILL_KEYS[state] ?? "pillIdle");

  const line = el("connLine");
  const messages = {
    ready: ["connectionOk", "ok"],
    offline: ["botOffline", "muted"],
    needsToken: ["botNeedsToken", "muted"],
    badToken: ["botBadToken", "error"],
  };
  const [key, tone] = messages[phase];
  line.dataset.tone = tone;
  line.textContent = t(lang, key, { version: status?.version ?? "" });
  el("dockerHelp").hidden = phase !== "offline";
}

function renderRun() {
  const isRunning = running();
  const line = el("runLine");
  line.dataset.tone = "";
  if (phase !== "ready") {
    line.textContent = "";
  } else if (isRunning) {
    const account = status.run?.live?.currentAccount;
    line.textContent = account ? t(lang, "botRunning", { account }) : t(lang, "botRunningStart");
  } else if (lastRunFailed(status)) {
    line.dataset.tone = "error";
    const exit = status.lastExit;
    line.textContent = t(lang, "botLastFailed", { message: exit.error ?? `exit ${exit.code}` });
  } else {
    line.dataset.tone = "muted";
    line.textContent = accounts.length ? t(lang, "runIdle") : t(lang, "botNoAccounts");
  }

  el("runAllBtn").disabled = phase !== "ready" || isRunning || accounts.length === 0;
  el("stopBtn").disabled = !isRunning || status?.state === "stopping";
  el("killBtn").disabled = !isRunning;

  const prompt = isRunning ? loginPrompt(logs) : null;
  el("approve").hidden = !prompt;
  if (prompt) {
    el("approveNumber").textContent = prompt.number ?? "";
    el("approveTitle").textContent = t(lang, "approveTitle", { account: prompt.user ?? "" });
    el("approveText").textContent = prompt.number
      ? t(lang, "approveNumber", { number: prompt.number })
      : t(lang, "approveNoNumber");
  }
}

function signInMethod(account) {
  if (account.hasPassword && account.hasTotp) return t(lang, "methodTotp");
  if (account.hasPassword) return t(lang, "methodPassword");
  return t(lang, "methodAuthenticator");
}

function sessionText(email) {
  const times = sessions
    .filter((s) => s.email?.toLowerCase() === email.toLowerCase() && s.hasStorageState !== false)
    .map((s) => Date.parse(s.updatedAt))
    .filter(Number.isFinite);
  if (!times.length) return { text: t(lang, "sessionNone"), tone: "" };
  return { text: t(lang, "sessionSaved", { time: formatWhen(Math.max(...times)) }), tone: "ok" };
}

function renderAccounts() {
  const list = el("accountList");
  list.textContent = "";
  if (phase !== "ready") return;
  if (!accounts.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = t(lang, "noAccounts");
    list.append(empty);
    return;
  }

  const current = running() ? status?.run?.live?.currentAccount : null;
  const busy = running();
  for (const account of accounts) {
    const item = document.createElement("li");
    item.className = "account";
    item.dataset.current = String(account.email === current);

    const main = document.createElement("div");
    main.className = "account-main";
    const email = document.createElement("span");
    email.className = "account-email";
    email.textContent = account.email;
    email.title = account.email;

    const meta = document.createElement("span");
    meta.className = "account-meta";
    const method = document.createElement("span");
    method.textContent = signInMethod(account);
    const session = sessionText(account.email);
    const signed = document.createElement("span");
    signed.textContent = session.text;
    signed.dataset.tone = session.tone;
    meta.append(method, signed);
    if (account.lastSuccess === true) {
      const last = document.createElement("span");
      last.dataset.tone = "ok";
      last.textContent = t(lang, "lastRunOk", { points: fmt(account.lastCollected ?? 0) });
      meta.append(last);
    } else if (account.lastSuccess === false) {
      const last = document.createElement("span");
      last.dataset.tone = "error";
      last.textContent = t(lang, "lastRunError");
      if (account.lastError) last.title = account.lastError;
      meta.append(last);
    }
    main.append(email, meta);

    const actions = document.createElement("div");
    actions.className = "account-actions";
    const run = button(t(lang, "runThis"), "secondary", () => runAccount(account));
    const edit = button(t(lang, "edit"), "secondary", () => openEdit(account));
    const reset = button(t(lang, "resetSession"), "secondary", () => resetSession(account));
    const signIn = button(t(lang, "manualLogin"), "secondary", () => signInByHand(account));
    const remove = button(t(lang, "remove"), "danger-btn", () => removeAccount(account));
    for (const node of [run, edit, reset, signIn, remove]) node.disabled = busy;
    actions.append(run, edit, reset, signIn, remove);

    item.append(main, actions);
    list.append(item);
  }
}

function renderSchedule() {
  const on = el("schedOn");
  const time = el("schedTime");
  const info = el("schedInfo");
  const writable = phase === "ready" && schedule?.writable;
  on.disabled = time.disabled = !writable;
  if (!schedule) {
    info.textContent = "";
    return;
  }
  const daily = timeFromCron(schedule.cron);
  if (document.activeElement !== on && document.activeElement !== time) {
    on.checked = Boolean(schedule.enabled && schedule.cron);
    const shown = daily ?? DEFAULT_RUN_TIME;
    time.value = `${pad(shown.hour)}:${pad(shown.minute)}`;
  }
  const notes = [t(lang, "scheduleTz", { tz: schedule.timezone ?? "UTC" })];
  if (schedule.cron && !daily) notes.push(t(lang, "scheduleCustom", { cron: schedule.cron }));
  info.textContent = notes.join(" · ");
}

function renderJobs() {
  const box = el("jobs");
  if (!box.childElementCount) {
    for (const [section, key] of JOBS) {
      const label = document.createElement("label");
      label.className = "switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.setAttribute("role", "switch");
      input.dataset.section = section;
      input.dataset.key = key;
      input.addEventListener("change", () => saveJob(input));
      const text = document.createElement("span");
      text.dataset.i18n = `job_${key}`;
      text.textContent = t(lang, `job_${key}`);
      label.append(input, text);
      box.append(label);
    }
  }
  for (const input of box.querySelectorAll("input")) {
    const value = config?.[input.dataset.section]?.[input.dataset.key];
    input.disabled = phase !== "ready" || typeof value !== "boolean";
    if (document.activeElement !== input) input.checked = value === true;
  }
}

function renderLog() {
  const box = el("log");
  const warnOnly = el("warnOnly").checked;
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
  box.textContent = "";
  const shown = logs.filter((entry) => !warnOnly || entry.level === "warn" || entry.level === "error");
  if (!shown.length) {
    const empty = document.createElement("li");
    empty.textContent = t(lang, "logEmpty");
    empty.dataset.level = "debug";
    box.append(empty);
    return;
  }
  for (const entry of shown) {
    const item = document.createElement("li");
    item.dataset.level = entry.level ?? "info";
    const time = document.createElement("span");
    time.className = "log-time";
    const at = new Date(entry.receivedAt);
    time.textContent = Number.isNaN(at.getTime()) ? "" : `${at.toLocaleTimeString(locale())} `;
    // The bot's output is shown as text, never as markup.
    const text = entry.parsed ? [entry.user && `[${entry.user}]`, entry.platform, entry.title && `[${entry.title}]`, entry.message] : [entry.raw ?? entry.message];
    item.append(time, text.filter(Boolean).join(" "));
    box.append(item);
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function renderHistory() {
  const list = el("history");
  list.textContent = "";
  if (!history.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = t(lang, "historyEmpty");
    list.append(empty);
    return;
  }
  for (const run of history) {
    const item = document.createElement("li");
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = formatWhen(run.startedAt);
    const detail = document.createElement("span");
    detail.className = "detail";
    detail.textContent = t(lang, "historyRow", {
      points: fmt(run.collected ?? 0),
      duration: formatDuration(Date.parse(run.endedAt) - Date.parse(run.startedAt)),
    });
    item.append(when, detail);
    for (const account of run.accounts ?? []) {
      const part = document.createElement("span");
      part.className = "detail";
      if (account.success === false) part.dataset.tone = "error";
      part.textContent = `${account.email}: +${fmt(account.collected ?? 0)}`;
      if (account.error) part.title = account.error;
      item.append(part);
    }
    list.append(item);
  }
}

function renderAll() {
  renderConnection();
  renderRun();
  renderAccounts();
  renderSchedule();
  renderJobs();
  renderLog();
  renderHistory();
}

// -------------------------------------------------------------------- data

async function readSlow() {
  const [acc, sess, sched, conf, hist] = await Promise.all([
    api.accounts(),
    api.sessions().catch(() => ({ sessions: [] })),
    api.schedule(),
    api.config().catch(() => ({ config: null })),
    api.history(),
  ]);
  accounts = acc.accounts ?? [];
  sessions = sess.sessions ?? [];
  schedule = sched;
  config = conf.config;
  history = [...(hist.runs ?? [])].reverse();
  slowAt = Date.now();
}

async function poll({ slow = false } = {}) {
  const connection = await getConnection();
  if (!connection.token) {
    phase = "needsToken";
    renderAll();
    return;
  }
  api = createClient(connection);
  try {
    const next = await api.status();
    if ((next.latestLogId ?? 0) < lastLogId) {
      logs = [];
      lastLogId = 0;
    }
    const fresh = await api.logs(lastLogId ? { afterId: lastLogId } : { limit: LOG_KEEP });
    logs = [...logs, ...(fresh.logs ?? [])].slice(-LOG_KEEP);
    lastLogId = fresh.latestLogId ?? lastLogId;
    // A run that just ended changes history and sign-in state.
    const ended = status && status.state !== "idle" && next.state === "idle";
    status = next;
    if (slow || ended || phase !== "ready" || Date.now() - slowAt > SLOW_MS) await readSlow();
    phase = "ready";
  } catch (error) {
    phase = error?.code === "UNAUTHORIZED" ? "badToken" : "offline";
  }
  renderAll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    if (!document.hidden) await poll();
    schedulePoll();
  }, POLL_MS);
}

// ------------------------------------------------------------------ actions

async function act(statusId, work, okText) {
  try {
    await work();
    if (okText) setStatus(statusId, okText, "ok");
  } catch (error) {
    setStatus(statusId, error?.code === "RUN_ACTIVE" ? t(lang, "busyRunning") : failure(error), "error");
  }
  await poll({ slow: true });
  void chrome.runtime.sendMessage({ action: "refreshBadge" }).catch(() => {});
}

const runAccount = (account) =>
  act("accStatus", () => api.start({ accountIndex: Number(account.index) }), t(lang, "botStarted"));

async function resetSession(account) {
  if (!confirm(t(lang, "confirmReset", { email: account.email }))) return;
  await act("accStatus", () => api.deleteSession(account.email), t(lang, "saved"));
}

async function signInByHand(account) {
  const { url } = await getConnection();
  await act(
    "accStatus",
    async () => {
      await openManualLogin({ api, connectionUrl: url, email: account.email });
      // The worker follows it from here and closes the page once the sign-in is saved.
      void chrome.runtime.sendMessage({ action: "watchManualLogin" }).catch(() => {});
    },
    t(lang, "manualLoginOpened")
  );
}

async function removeAccount(account) {
  if (!confirm(t(lang, "confirmRemove", { email: account.email }))) return;
  await act(
    "accStatus",
    async () => {
      await api.removeAccount(account.index);
      // Its saved cookies are sign-in material; they go with the account.
      await api.deleteSession(account.email).catch((error) => {
        if (error?.status !== 404) throw error;
      });
    },
    t(lang, "saved")
  );
}

function openEdit(account) {
  editing = account;
  const form = el("editForm");
  form.reset();
  form.elements.geoLocale.value = account.geoLocale ?? "auto";
  form.elements.langCode.value = account.langCode ?? "";
  el("editTitle").textContent = t(lang, "editTitle", { email: account.email });
  setStatus("editStatus", "");
  el("editDialog").showModal();
}

el("editForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  const patch = {};
  if (form.password.value) patch.password = form.password.value;
  if (form.clearTotp.checked) patch.totpSecret = "";
  else if (form.totpSecret.value.trim()) patch.totpSecret = form.totpSecret.value.trim();
  const geo = form.geoLocale.value.trim();
  const code = form.langCode.value.trim();
  if (geo && geo !== editing.geoLocale) patch.geoLocale = geo;
  if (code && code !== editing.langCode) patch.langCode = code;
  if (!Object.keys(patch).length) {
    el("editDialog").close();
    return;
  }
  try {
    await api.updateAccount(editing.index, patch);
    el("editDialog").close();
    setStatus("accStatus", t(lang, "saved"), "ok");
    await poll({ slow: true });
  } catch (error) {
    setStatus("editStatus", error?.code === "RUN_ACTIVE" ? t(lang, "busyRunning") : failure(error), "error");
  }
});
el("editCancel").addEventListener("click", () => el("editDialog").close());

// Add account
function toggleAdd(open) {
  el("addForm").hidden = !open;
  el("addToggle").setAttribute("aria-expanded", String(open));
  if (open) el("addForm").elements.email.focus();
}
el("addToggle").addEventListener("click", () => toggleAdd(el("addForm").hidden));
el("addCancel").addEventListener("click", () => toggleAdd(false));

el("addForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target.elements;
  const fields = { email: form.email.value.trim() };
  for (const name of ["password", "totpSecret", "recoveryEmail", "geoLocale", "langCode"]) {
    const value = name === "password" ? form[name].value : form[name].value.trim();
    if (value) fields[name] = value;
  }
  try {
    await api.addAccount(fields);
    event.target.reset();
    toggleAdd(false);
    setStatus("addStatus", "");
    setStatus("accStatus", t(lang, "saved"), "ok");
    await poll({ slow: true });
  } catch (error) {
    setStatus("addStatus", error?.code === "RUN_ACTIVE" ? t(lang, "busyRunning") : failure(error), "error");
  }
});

// Run controls
el("runAllBtn").addEventListener("click", () => act("runStatus", () => api.start(), t(lang, "botStarted")));
el("stopBtn").addEventListener("click", () => act("runStatus", () => api.stop(), t(lang, "botStopRequested")));
el("killBtn").addEventListener("click", () => act("runStatus", () => api.stop({ force: true })));

// Schedule
async function saveSchedule() {
  const [hour, minute] = el("schedTime").value.split(":").map(Number);
  const time = Number.isFinite(hour) ? { hour, minute: Number.isFinite(minute) ? minute : 0 } : DEFAULT_RUN_TIME;
  await act(
    "schedStatus",
    () => api.patchSchedule({ enabled: el("schedOn").checked, cron: cronFromTime(time.hour, time.minute) }),
    t(lang, "saved")
  );
}
el("schedOn").addEventListener("change", saveSchedule);
el("schedTime").addEventListener("change", saveSchedule);

// Jobs
async function saveJob(input) {
  const { section, key } = input.dataset;
  await act("jobsStatus", () => api.patchConfig({ [section]: { [key]: input.checked } }), t(lang, "saved"));
}

el("warnOnly").addEventListener("change", renderLog);

// Connection
el("connForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await saveConnection({ url: el("urlInput").value, token: el("tokenInput").value });
    lastLogId = 0;
    logs = [];
    await poll({ slow: true });
  } catch (error) {
    phase = "offline";
    setStatus("connLine", failure(error), "error");
  }
});

// ---------------------------------------------------------------------- boot

window.addEventListener("unload", () => clearTimeout(pollTimer));

await loadLookAndLanguage();
{
  const connection = await getConnection();
  el("urlInput").value = connection.url;
  el("tokenInput").value = connection.token;
}
renderAll();
await poll({ slow: true });
schedulePoll();
