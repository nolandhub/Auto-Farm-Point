import { BUILD, QUOTA } from "../src/core/constants.js";
import { resolveLang, t } from "../src/core/i18n.js";
import {
  createClient,
  getConnection,
  lastRunFailed,
  loginPrompt,
  saveConnection,
  timeFromCron,
} from "../src/core/netsky.js";
import { pickToday } from "../src/core/ledger.js";
import { dateKey } from "../src/core/quota.js";

const THEME_CYCLE = ["auto", "light", "dark"];
const THEME_ICONS = { auto: "#i-auto", light: "#i-sun", dark: "#i-moon" };
const THEME_LABELS = { auto: "themeAuto", light: "themeLight", dark: "themeDark" };
/** The header pill shows TheNetsky's state; it does the farming now. */
const PILL_KEYS = {
  offline: "pillOffline",
  idle: "pillIdle",
  starting: "pillStarting",
  running: "pillRunning",
  stopping: "pillStopping",
};

/** While the popup is open, Rewards is re-read this often. */
const LIVE_REFRESH_MS = 1_500;
/** Opening within this long of the last read shows it without re-reading. */
const FRESH_ENOUGH_MS = 10_000;
const TASKS_COLLAPSED = 4;
/** 2πr for the ring's r="27" in popup.html. */
const RING_CIRCUMFERENCE = 169.65;
const COUNT_UP_MS = 450;
/** TheNetsky is re-read this often while the popup is open. */
const BOT_POLL_MS = 2_000;
/** Accounts and the schedule change rarely; they are re-read this often. */
const BOT_SLOW_MS = 15_000;
const BOT_LOG_KEEP = 60;
const BOT_LOG_SHOWN = 3;
const BOT_ACCOUNTS_SHOWN = 4;
const SVG_NS = "http://www.w3.org/2000/svg";

const el = (id) => document.getElementById(id);
const port = chrome.runtime.connect({ name: "popup" });
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

let snap = null;
let lang = "en";
let clock = null;
let liveTimer = null;
let started = false;
let reading = false;
/** A read the user asked for; background polls do not flash the live line. */
let refreshing = false;
let tasksExpanded = false;

/**
 * What the popup knows about TheNetsky. phase: loading | offline |
 * needsToken | badToken | ready.
 */
const bot = { phase: "loading", status: null, accounts: null, schedule: null, history: [], logs: [], lastLogId: 0, slowAt: 0 };
let api = null;
let botTimer = null;
/** A start or stop is on its way; the button waits for it. */
let acting = false;

// ------------------------------------------------------------------ helpers

function send(action, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, (response) => {
      void chrome.runtime.lastError;
      resolve(response?.result ?? null);
    });
  });
}

const fmt = (n) => Number(n ?? 0).toLocaleString(lang === "vi" ? "vi-VN" : "en-US");

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString(lang === "vi" ? "vi-VN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function relativeTime(ts) {
  const seconds = Math.round((Date.now() - ts) / 1000);
  if (seconds < 5) return t(lang, "justNow");
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  if (seconds < 60) return rtf.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  return formatClock(ts);
}

function icon(id) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "ic");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", id);
  svg.append(use);
  return svg;
}

/**
 * Counts a number up to its new value, so a live change is noticed. The first
 * value, and every value under reduced motion, is shown as-is.
 */
const shownNumbers = new WeakMap();
function setNumber(node, value, format = fmt) {
  const from = shownNumbers.get(node);
  shownNumbers.set(node, value);
  if (from === undefined || from === value || reduceMotion.matches) {
    node.textContent = format(value);
    return;
  }
  const start = performance.now();
  const frame = (now) => {
    if (shownNumbers.get(node) !== value) return; // a newer value took over
    const p = Math.min(1, (now - start) / COUNT_UP_MS);
    const eased = 1 - (1 - p) ** 3;
    node.textContent = format(Math.round(from + (value - from) * eased));
    if (p < 1) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** Rewards resets daily, so a reading from yesterday says nothing about today. */
function todaysDashboard() {
  const dash = snap.dashboard;
  if (!dash?.readAt || dateKey(new Date(dash.readAt)) !== dateKey()) return null;
  return dash;
}

function setTheme(theme) {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  el("themeUse").setAttribute("href", THEME_ICONS[theme]);
  const label = `${t(lang, "theme")}: ${t(lang, THEME_LABELS[theme])}`;
  el("themeBtn").title = label;
  el("themeBtn").setAttribute("aria-label", label);
}

function applyLanguage() {
  for (const node of document.querySelectorAll("[data-i18n]")) {
    node.textContent = t(lang, node.dataset.i18n);
  }
  el("langBtn").textContent = lang.toUpperCase();
  el("langBtn").setAttribute("aria-label", `${t(lang, "language")}: ${lang.toUpperCase()}`);
  el("refreshBtn").title = t(lang, "refreshNow");
  el("refreshBtn").setAttribute("aria-label", t(lang, "refreshNow"));
  el("manageIconBtn").title = t(lang, "manage");
  el("manageIconBtn").setAttribute("aria-label", t(lang, "manage"));
  document.documentElement.lang = lang;
}

// ------------------------------------------------------------------ render

/**
 * What the bot collected today, from its finished runs. A live run is left
 * out: until it ends, the bot counts each search twice. Only with a single
 * account: with several, the popup cannot tell which one is signed in to Edge.
 */
function botEarnedToday() {
  if (bot.phase !== "ready" || bot.accounts?.length !== 1) return null;
  const today = dateKey();
  let total = 0;
  for (const run of bot.history) {
    if (dateKey(new Date(run.startedAt)) === today) total += run.collected ?? 0;
  }
  return total;
}

/** Today's points, the balance, and the ring for search points across devices. */
function renderHero(dash) {
  const today = pickToday({
    earned: dash?.earnedToday,
    exact: dash?.earnedExact,
    dailyPoint: dash?.todayPoints,
    bot: botEarnedToday(),
  });
  if (today !== null) setNumber(el("todayPoints"), today);
  else {
    // The bot's searches are not counted here; without Rewards there is no number.
    shownNumbers.delete(el("todayPoints"));
    el("todayPoints").textContent = "–";
  }

  const balance = el("balanceText");
  balance.textContent = "";
  const hasBalance = dash?.availablePoints !== null && dash?.availablePoints !== undefined;
  el("balance").querySelector(".ic-coin").style.display = hasBalance ? "" : "none";
  if (hasBalance) {
    const strong = document.createElement("b");
    strong.textContent = fmt(dash.availablePoints);
    balance.append(`${t(lang, "balanceLabel")} `, strong);
  } else {
    balance.textContent = t(lang, "estimateNote");
  }

  let current = 0;
  let max = 0;
  for (const mode of ["pc", "mobile"]) {
    const counter = dash?.counters?.[mode];
    if (counter) {
      current += Math.min(counter.current, counter.max);
      max += counter.max;
    }
  }
  const share = max > 0 ? current / max : 0;
  el("ringFill").style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - share));
  el("ringPct").textContent = `${Math.round(share * 100)}%`;
  el("ring").dataset.met = String(max > 0 && current >= max);
  el("ring").setAttribute("aria-label", t(lang, "ringAria", { current: fmt(current), max: fmt(max) }));
}

function renderTile(mode, dash) {
  const counter = dash?.counters?.[mode];
  let current;
  let max;
  let met;
  let note;
  if (counter) {
    current = counter.current;
    max = counter.max;
    const left = Math.max(0, max - current);
    met = counter.complete || left === 0;
    note = met
      ? t(lang, "counterDone")
      : t(lang, "ptsLeft", { points: fmt(left), searches: Math.ceil(left / QUOTA.pointsPerSearch) });
  } else {
    // Unknown until Rewards is read: say so rather than show a made-up 0.
    shownNumbers.delete(el(`count-${mode}`));
    el(`count-${mode}`).textContent = "–";
    el(`max-${mode}`).textContent = "";
    el(`fill-${mode}`).style.transform = "scaleX(0)";
    el(`left-${mode}`).textContent = t(lang, "localSearches");
    el(`tile-${mode}`).dataset.met = "false";
    return;
  }
  setNumber(el(`count-${mode}`), current);
  el(`max-${mode}`).textContent = `/${fmt(max)}`;
  el(`fill-${mode}`).style.transform = `scaleX(${max > 0 ? Math.min(1, current / max) : 0})`;
  el(`left-${mode}`).textContent = note;
  el(`tile-${mode}`).dataset.met = String(met);
}

const TASK_STATE = {
  auto: { icon: "#i-zap", label: "stateAuto" },
  manual: { icon: "#i-user", label: "stateManual" },
  locked: { icon: "#i-lock", label: "stateLocked" },
  app: { icon: "#i-app", label: "stateApp" },
  done: { icon: "#i-check", label: "stateDone" },
};

const APP_LABELS = { desktop: "stateAppDesktop", mobile: "stateAppMobile" };

/** Icon and a word for each state: the colour alone never carries it. */
function taskRow(task) {
  const state = TASK_STATE[task.state] ?? TASK_STATE.manual;
  const item = document.createElement("li");
  item.className = "task";
  item.dataset.state = task.state;

  const badge = document.createElement("span");
  badge.className = "task-icon";
  badge.append(icon(state.icon));

  // Titles come from Microsoft's payload, so they are only ever set as text.
  const body = document.createElement("span");
  body.className = "task-body";
  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title;
  title.title = task.title;
  const meta = document.createElement("span");
  meta.className = "task-meta";
  // An app-only quest names the app: the Windows one is not the phone one.
  const label = task.state === "app" && APP_LABELS[task.app] ? APP_LABELS[task.app] : state.label;
  const status = t(lang, label);
  meta.textContent = task.quest
    ? `${t(lang, "questProgress", { done: task.quest.done, total: task.quest.total })} · ${status}`
    : status;
  body.append(title, meta);

  const points = document.createElement("span");
  points.className = "task-points";
  points.textContent = task.points > 0 ? `+${fmt(task.points)}` : "";
  points.hidden = !(task.points > 0);

  const open = icon("#i-external");
  open.classList.add("task-open");

  // One button per row: open the task, and collect it if it is still open.
  const link = document.createElement("button");
  link.type = "button";
  link.className = "task-link";
  link.title = t(lang, task.state === "done" || task.state === "locked" || task.state === "app" ? "taskOpen" : "taskOpenCollect");
  link.append(badge, body, points, open);
  link.addEventListener("click", () => openTask(task, link));

  item.append(link);
  return item;
}

async function openTask(task, link) {
  link.setAttribute("aria-busy", "true");
  // The worker opens a tab, which usually closes this popup; it carries on.
  const result = await send("doTask", { id: task.id });
  link.removeAttribute("aria-busy");
  setStatus(
    result?.ok
      ? result.pointsEarned > 0
        ? t(lang, "taskCollected", { points: result.pointsEarned, title: task.title })
        : t(lang, "taskOpened", { title: task.title })
      : t(lang, "taskOpenFailed"),
    result?.ok ? "ok" : "error"
  );
}

function setStatus(text, tone = "") {
  const status = el("status");
  status.dataset.tone = tone;
  status.textContent = text;
}

/**
 * Today's tasks: a done/total bar, what is left in points, then the list with
 * open tasks first. Four rows, the rest behind "show more".
 */
function renderTasks() {
  const box = el("tasks");
  const list = el("taskList");
  const toggle = el("tasksToggle");
  list.textContent = "";

  const { items = [], done = 0, total = 0, pointsLeft = 0 } = snap.tasks ?? {};
  const allDone = total > 0 && done === total;
  box.dataset.allDone = String(allDone);
  el("tasksCount").textContent = total > 0 ? t(lang, "tasksProgress", { done, total }) : "";

  const bar = el("tasksBar");
  bar.hidden = total === 0;
  bar.setAttribute("aria-valuemax", String(total));
  bar.setAttribute("aria-valuenow", String(done));
  bar.setAttribute("aria-label", t(lang, "tasksProgress", { done, total }));
  el("tasksBarFill").style.transform = `scaleX(${total > 0 ? done / total : 0})`;

  const auto = items.filter((task) => task.state === "auto").length;
  el("tasksCaption").textContent =
    total === 0
      ? t(lang, todaysDashboard() ? "tasksNoneToday" : "tasksEmpty")
      : allDone
        ? t(lang, "tasksAllDone")
        : auto > 0
          ? t(lang, "tasksCaption", { points: fmt(pointsLeft), auto })
          : t(lang, "tasksPointsLeft", { points: fmt(pointsLeft) });

  const visible = tasksExpanded ? items : items.slice(0, TASKS_COLLAPSED);
  for (const task of visible) list.append(taskRow(task));

  const hidden = items.length - TASKS_COLLAPSED;
  toggle.hidden = hidden <= 0;
  toggle.setAttribute("aria-expanded", String(tasksExpanded));
  el("tasksToggleText").textContent = tasksExpanded
    ? t(lang, "tasksShowLess")
    : t(lang, "tasksShowMore", { count: hidden });
}

/** The freshness line under the hero. Runs every second for the "ago" text. */
function renderLive() {
  if (!snap) return;
  const live = el("live");
  const text = el("liveText");
  const dash = snap.dashboard;
  let state;
  if (refreshing) {
    state = "refreshing";
    text.textContent = t(lang, "liveRefreshing");
  } else if (!dash?.readAt) {
    state = "none";
    text.textContent = t(lang, "liveNone");
  } else if (dash.failedAt && dash.failedAt > dash.readAt) {
    state = "failed";
    text.textContent = t(lang, "liveFailed", { time: formatClock(dash.readAt) });
  } else {
    state = "ok";
    text.textContent = t(lang, "liveOk", { ago: relativeTime(dash.readAt) });
  }
  live.dataset.state = state;
  text.title = text.textContent; // the line ellipsizes; the full text stays reachable
}

function render() {
  if (!snap) return;
  lang = resolveLang(snap.settings.lang, chrome.i18n.getUILanguage());
  applyLanguage();
  setTheme(snap.settings.theme);

  // Edge keeps the old worker code until the extension is reloaded; a worker
  // from another build does not speak this popup's language.
  el("updateBanner").hidden = snap.build === BUILD;

  const dash = todaysDashboard();
  renderHero(dash);
  renderTile("pc", dash);
  renderTile("mobile", dash);
  renderTasks();
  renderLive();
  renderBot();
}

// ---------------------------------------------------------------------- bot

const botState = () => (bot.phase === "ready" ? bot.status?.state ?? "idle" : "offline");

/** The one line under the bot's title: what it is doing, or what it needs. */
function renderBotLine() {
  const line = el("botLine");
  line.dataset.tone = "";
  const phaseText = {
    loading: "",
    offline: "botOffline",
    needsToken: "botNeedsToken",
    badToken: "botBadToken",
  }[bot.phase];
  if (phaseText !== undefined) {
    line.dataset.tone = bot.phase === "badToken" ? "error" : "muted";
    line.textContent = phaseText ? t(lang, phaseText) : "";
    return;
  }

  const { status, schedule } = bot;
  const run = status.run;
  if (status.state !== "idle") {
    const account = run?.live?.currentAccount;
    const parts = [account ? t(lang, "botRunning", { account }) : t(lang, "botRunningStart")];
    if (run?.collected > 0) parts.push(t(lang, "botGained", { points: fmt(run.collected) }));
    line.textContent = parts.join(" · ");
    return;
  }
  if (!bot.accounts?.length) {
    line.dataset.tone = "muted";
    line.textContent = t(lang, "botNoAccounts");
    return;
  }
  if (lastRunFailed(status)) {
    line.dataset.tone = "error";
    const exit = status.lastExit;
    line.textContent = t(lang, "botLastFailed", { message: exit.error ?? `exit ${exit.code}` });
    return;
  }
  const time = schedule?.enabled ? timeFromCron(schedule.cron) : null;
  const count = bot.accounts.length;
  const accounts = count === 1 ? t(lang, "accountsOne") : t(lang, "accountsMany", { count });
  line.textContent = time
    ? t(lang, "botIdleScheduled", {
        accounts,
        time: `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(2, "0")}`,
      })
    : t(lang, "botIdleUnscheduled", { accounts });
}

/** Microsoft is waiting on a tap in Authenticator: the number, large. */
function renderApprove() {
  const prompt = bot.phase === "ready" && bot.status?.state !== "idle" ? loginPrompt(bot.logs) : null;
  el("approve").hidden = !prompt;
  if (!prompt) return;
  el("approveNumber").textContent = prompt.number ?? "";
  el("approveTitle").textContent = t(lang, "approveTitle", { account: prompt.user ?? "" });
  el("approveText").textContent = prompt.number
    ? t(lang, "approveNumber", { number: prompt.number })
    : t(lang, "approveNoNumber");
}

/** Each account with what this run (or the last) earned it. */
function renderBotAccounts() {
  const list = el("botAccounts");
  list.textContent = "";
  if (bot.phase !== "ready" || !bot.accounts?.length) return;

  const live = new Map((bot.status?.run?.accounts ?? []).map((a) => [a.email, a]));
  const current = bot.status?.state !== "idle" ? bot.status?.run?.live?.currentAccount : null;
  for (const account of bot.accounts.slice(0, BOT_ACCOUNTS_SHOWN)) {
    const item = document.createElement("li");
    item.className = "bot-account";
    const email = document.createElement("span");
    email.className = "bot-account-email";
    email.textContent = account.email;
    email.title = account.email;
    const points = document.createElement("span");
    points.className = "bot-account-points";

    const run = live.get(account.email);
    const gained = run?.collectedPoints ?? run?.live?.gained ?? account.lastCollected;
    const failed = run?.success === false || (!run && account.lastSuccess === false);
    points.textContent = failed ? t(lang, "lastRunError") : gained != null ? `+${fmt(gained)}` : "";
    item.dataset.current = String(account.email === current);
    item.dataset.error = String(failed);
    item.append(email, points);
    list.append(item);
  }
}

function renderBotLog() {
  const list = el("botLog");
  list.textContent = "";
  const lines = bot.phase === "ready" ? bot.logs.filter((l) => l.message).slice(-BOT_LOG_SHOWN) : [];
  list.hidden = lines.length === 0;
  list.setAttribute("aria-label", t(lang, "activityLabel"));
  for (const entry of lines) {
    const item = document.createElement("li");
    item.dataset.level = entry.level ?? "info";
    // Log text comes from the bot's output: text only, never markup.
    item.textContent = entry.title ? `${entry.title} ${entry.message}` : entry.message;
    item.title = item.textContent;
    list.append(item);
  }
}

function renderBot() {
  const state = botState();
  if (snap) renderHero(todaysDashboard());
  el("bot").dataset.state = bot.phase;
  el("statePill").dataset.state = state;
  el("stateText").textContent = t(lang, PILL_KEYS[state] ?? "pillIdle");
  el("connectForm").hidden = !(bot.phase === "needsToken" || bot.phase === "badToken");

  renderBotLine();
  renderApprove();
  renderBotAccounts();
  renderBotLog();

  const running = bot.phase === "ready" && state !== "idle";
  const runBtn = el("runBtn");
  runBtn.dataset.running = String(running);
  el("runText").textContent = t(lang, running ? "stop" : "botStart");
  el("runIcon").setAttribute("href", running ? "#i-stop" : "#i-play");
  runBtn.disabled =
    acting || bot.phase !== "ready" || state === "stopping" || (!running && !bot.accounts?.length);
}

/**
 * One read of TheNetsky. The log is followed by id, and started over when
 * the API has restarted and its ids begin again from zero.
 */
async function pollBot() {
  const connection = await getConnection();
  if (!connection.token) {
    bot.phase = "needsToken";
    renderBot();
    return;
  }
  api = createClient(connection);
  try {
    const status = await api.status();
    if ((status.latestLogId ?? 0) < bot.lastLogId) {
      bot.logs = [];
      bot.lastLogId = 0;
    }
    const fresh = await api.logs(bot.lastLogId ? { afterId: bot.lastLogId } : { limit: BOT_LOG_KEEP });
    bot.logs = [...bot.logs, ...(fresh.logs ?? [])].slice(-BOT_LOG_KEEP);
    bot.lastLogId = fresh.latestLogId ?? bot.lastLogId;
    if (!bot.accounts || Date.now() - bot.slowAt > BOT_SLOW_MS) {
      const [{ accounts }, schedule, { runs }] = await Promise.all([api.accounts(), api.schedule(), api.history()]);
      bot.accounts = accounts;
      bot.schedule = schedule;
      bot.history = runs ?? [];
      bot.slowAt = Date.now();
    }
    bot.status = status;
    bot.phase = "ready";
  } catch (error) {
    bot.phase = error?.code === "UNAUTHORIZED" ? "badToken" : "offline";
  }
  renderBot();
}

function scheduleBot() {
  clearTimeout(botTimer);
  botTimer = setTimeout(async () => {
    if (!document.hidden) await pollBot();
    scheduleBot();
  }, BOT_POLL_MS);
}

// --------------------------------------------------------------------- live

/** One read at a time; the result arrives as a fresh snapshot on the port. */
async function refreshNow({ silent = false } = {}) {
  if (reading || !snap) return;
  reading = true;
  refreshing = !silent;
  renderLive();
  try {
    await send("refreshDashboard");
  } finally {
    reading = refreshing = false;
    renderLive();
  }
}

function scheduleLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    if (!document.hidden) await refreshNow({ silent: true });
    scheduleLive();
  }, LIVE_REFRESH_MS);
}

/** The first snapshot starts the clock, the live loop, and a read if needed. */
function startLive() {
  if (started) return;
  started = true;
  clock = setInterval(() => {
    if (snap) renderLive();
  }, 1000);
  const age = Date.now() - (snap.dashboard?.readAt ?? 0);
  if (age > FRESH_ENOUGH_MS) void refreshNow();
  scheduleLive();
  void pollBot();
  scheduleBot();
}

// ------------------------------------------------------------------- events

port.onMessage.addListener((data) => {
  snap = data;
  render();
  startLive();
});

el("reloadBtn").addEventListener("click", () => chrome.runtime.reload());

el("refreshBtn").addEventListener("click", () => {
  void refreshNow();
  scheduleLive();
});

el("tasksToggle").addEventListener("click", () => {
  tasksExpanded = !tasksExpanded;
  renderTasks();
});

el("themeBtn").addEventListener("click", async () => {
  if (!snap) return;
  const next = THEME_CYCLE[(THEME_CYCLE.indexOf(snap.settings.theme) + 1) % THEME_CYCLE.length];
  setTheme(next);
  snap.settings.theme = next;
  await send("saveSettings", { theme: next });
});

el("langBtn").addEventListener("click", async () => {
  if (!snap) return;
  const next = lang === "en" ? "vi" : "en";
  snap.settings.lang = next;
  render();
  await send("saveSettings", { lang: next });
});

el("runBtn").addEventListener("click", async () => {
  if (!api || acting || bot.phase !== "ready") return;
  const running = bot.status?.state !== "idle";
  acting = true;
  renderBot();
  try {
    if (running) {
      await api.stop();
      setStatus(t(lang, "botStopRequested"));
    } else {
      await api.start();
      setStatus(t(lang, "botStarted"), "ok");
    }
  } catch (error) {
    setStatus(t(lang, "actionFailed", { message: error?.message ?? String(error) }), "error");
  } finally {
    acting = false;
  }
  await pollBot();
  void send("refreshBadge");
});

el("connectForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = el("tokenInput").value.trim();
  if (!token) return;
  const { url } = await getConnection();
  await saveConnection({ url, token });
  el("tokenInput").value = "";
  await pollBot();
  void send("refreshBadge");
});

const openManager = () => chrome.runtime.openOptionsPage();
el("manageBtn").addEventListener("click", openManager);
el("manageIconBtn").addEventListener("click", openManager);

window.addEventListener("unload", () => {
  clearInterval(clock);
  clearTimeout(liveTimer);
  clearTimeout(botTimer);
});
