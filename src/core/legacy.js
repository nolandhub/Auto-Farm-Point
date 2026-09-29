import { ALARMS, STORAGE_KEYS } from "./constants.js";
import { log } from "./log.js";

/**
 * This folder is loaded unpacked, so a reload upgrades an already-running v2.4
 * in place rather than installing fresh. Its alarms and storage keys survive
 * that reload: "intervalSearch", "backupCheck" and "continueSearch" would keep
 * waking this worker forever with names nothing handles any more.
 */
const LEGACY_KEYS = [
  "app.log",
  "intervalMode",
  "intervalAlarmName",
  "intervalStartTime",
  "intervalDelayMinutes",
  "intervalSearchActive",
  "intervalCount",
  "currentQueries",
  "currentIndex",
  "activeTabId",
  "workingWindowId",
  "downloadReady",
];

const KNOWN_ALARMS = new Set(Object.values(ALARMS));

export async function cleanupLegacy() {
  const alarms = await chrome.alarms.getAll();
  const stale = alarms.filter((alarm) => !KNOWN_ALARMS.has(alarm.name));
  for (const alarm of stale) await chrome.alarms.clear(alarm.name);

  const stored = await chrome.storage.local.get(LEGACY_KEYS);
  const present = Object.keys(stored);
  if (present.length > 0) await chrome.storage.local.remove(present);

  if (stale.length || present.length) {
    log.info("removed leftovers from the previous version", {
      alarms: stale.map((a) => a.name),
      keys: present,
    });
  }
  return { alarms: stale.map((a) => a.name), keys: present };
}

/** Everything this build owns, for the cleanup test to assert against. */
export const OWNED_STORAGE_KEYS = Object.values(STORAGE_KEYS);
