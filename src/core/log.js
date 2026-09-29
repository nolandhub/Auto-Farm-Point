import { STORAGE_KEYS } from "./constants.js";

const MAX_ENTRIES = 300;
const FLUSH_DELAY_MS = 2_000;

let entries = [];
let loaded = false;
let flushTimer = null;
let dirty = false;

/**
 * v2.4 re-serialised all 500 entries and wrote them to storage on *every*
 * single log call. This keeps the same ring buffer but coalesces writes.
 */
function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

export async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!dirty) return;
  dirty = false;
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.log]: entries });
  } catch {
    // Logging must never break a run.
  }
}

export async function load() {
  if (loaded) return;
  loaded = true;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.log);
    const saved = stored?.[STORAGE_KEYS.log];
    if (Array.isArray(saved)) entries = saved.slice(-MAX_ENTRIES);
  } catch {
    entries = [];
  }
}

function write(level, message, data) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const suffix = data === undefined ? "" : ` | ${safeJson(data)}`;
  entries.push(`[${stamp}] ${level} ${message}${suffix}`);
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  scheduleFlush();
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  info: (message, data) => write("INFO ", message, data),
  warn: (message, data) => write("WARN ", message, data),
  error: (message, data) => write("ERROR", message, data),
  debug: (message, data) => write("DEBUG", message, data),
};

export function getText() {
  return entries.join("\n");
}

export async function clear() {
  entries = [];
  dirty = false;
  clearTimeout(flushTimer);
  flushTimer = null;
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.log);
  } catch {
    /* ignore */
  }
}
