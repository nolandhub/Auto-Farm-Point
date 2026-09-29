import { ALARMS } from "./src/core/constants.js";
import { cleanupLegacy } from "./src/core/legacy.js";
import { clear as clearLogs, flush, getText, load as loadLogs, log } from "./src/core/log.js";
import { checkManualLogin } from "./src/core/manual-login.js";
import { refreshBadge } from "./src/core/netsky.js";
import * as runner from "./src/core/runner.js";

/**
 * Router only. All behaviour lives in src/core/*; this file exists to wire
 * Chrome's events to it, so there is exactly one place to look for lifecycle
 * bugs and none of the logic depends on the worker staying alive.
 *
 * The searching is TheNetsky's (Microsoft Rewards Script, in Docker). This
 * extension reads the Rewards dashboard, opens tasks, and steers the bot
 * through its control API; it never starts a search of its own.
 */

/** How often the toolbar badge re-reads TheNetsky while the popup is closed. */
const BADGE_PERIOD_MINUTES = 1;
/**
 * How often the balance is read with the popup closed, so the last reading of
 * each day is close to midnight: it is where the next day's earnings start.
 */
const BALANCE_PERIOD_MINUTES = 15;

const HANDLERS = {
  getSnapshot: () => runner.snapshot(),
  refreshDashboard: async () => {
    const dash = await runner.refreshDashboard();
    if (!dash) return { ok: false };
    return {
      ok: true,
      level: dash.level,
      availablePoints: dash.availablePoints,
      todayPoints: dash.todayPoints,
      counters: dash.counters,
      offers: dash.offers.length,
      source: dash.source,
    };
  },
  saveSettings: (message) => runner.saveSettings(message.payload ?? {}),
  doTask: (message) => runner.doTask(message.payload?.id),
  getLogs: async () => {
    await loadLogs();
    await flush();
    return { text: getText() };
  },
  clearLogs: async () => {
    await clearLogs();
    return { ok: true };
  },
  refreshBadge: () => refreshBadge(),
};

// Deliberately not an async function: an async listener returns a Promise,
// which Chrome reads as "responding synchronously" and the reply is lost.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = HANDLERS[message?.action];
  if (!handler) return false;

  Promise.resolve(handler(message))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => {
      log.error("message handler failed", { action: message.action, error: String(error) });
      sendResponse({ ok: false, error: String(error?.message ?? error) });
    });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === "popup") runner.attachPort(port);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARMS.netsky) {
    void refreshBadge();
    void checkManualLogin();
  }
  if (alarm.name === ALARMS.balance) void runner.refreshDashboard({ quests: false });
});

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await loadLogs();
    log.info("installed or updated");
    await cleanupLegacy();
  })();
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    await loadLogs();
    log.info("browser started");
  })();
});

/**
 * Creating an alarm that exists restarts its countdown, and this worker cold
 * starts every minute: a 15-minute alarm recreated each time would never fire.
 */
async function ensureAlarm(name, periodInMinutes) {
  const existing = await chrome.alarms.get(name);
  if (existing?.periodInMinutes !== periodInMinutes) chrome.alarms.create(name, { periodInMinutes });
}

// Every cold start of the worker. Alarms from before the hand-over to
// TheNetsky would otherwise wake the old search loop.
void (async () => {
  await loadLogs();
  await runner.retire();
  await ensureAlarm(ALARMS.netsky, BADGE_PERIOD_MINUTES);
  await ensureAlarm(ALARMS.balance, BALANCE_PERIOD_MINUTES);
  await refreshBadge();
  await checkManualLogin();
})();
