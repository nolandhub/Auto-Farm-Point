import { NAVIGATION_TIMEOUT_MS, STORAGE_KEYS } from "./constants.js";
import { log } from "./log.js";

/**
 * The ONLY module in this extension permitted to call chrome.tabs.* or
 * chrome.windows.*. Everything the user complained about — the extension
 * grabbing whatever tab they were reading — came from those calls being
 * scattered through the search loop with `active: true` attached.
 *
 * Invariants enforced here:
 *   1. The window is born hidden: focused:false + minimized, from the outset.
 *      We never adopt the user's window, so there is nothing to steal.
 *   2. Only the worker tab is ever addressed; assertWorkerTab() refuses others.
 *   3. If the user closes the window, the ids are dropped and the next step
 *      recreates it silently.
 *   4. Nothing is ever pinned or marked autoDiscardable:false, so Chrome can
 *      reclaim the tab under memory pressure.
 */

let windowId = null;
let tabId = null;
let restored = false;

async function restoreIds() {
  if (restored) return;
  restored = true;
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.window);
    const saved = stored?.[STORAGE_KEYS.window];
    if (saved) {
      windowId = saved.windowId ?? null;
      tabId = saved.tabId ?? null;
    }
  } catch {
    /* start clean */
  }
}

async function persistIds() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.window]: { windowId, tabId } });
  } catch {
    /* ignore */
  }
}

function forget() {
  windowId = null;
  tabId = null;
  void persistIds();
}

export function isWorkerTab(id) {
  return tabId !== null && id === tabId;
}

function assertWorkerTab(id) {
  if (!isWorkerTab(id)) {
    throw new Error(`refusing to operate on tab ${id}: not the worker tab`);
  }
}

async function isAlive() {
  if (windowId === null || tabId === null) return false;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.windowId !== windowId) return false;
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

async function createHidden(url) {
  let win;
  try {
    win = await chrome.windows.create({
      url,
      focused: false,
      state: "minimized",
      type: "normal",
    });
  } catch (error) {
    // A few platforms reject `state` at creation; fall back and minimise after.
    log.warn("minimized create rejected, retrying", { error: String(error) });
    win = await chrome.windows.create({ url, focused: false, type: "normal" });
    try {
      await chrome.windows.update(win.id, { state: "minimized" });
    } catch {
      /* best effort */
    }
  }

  windowId = win.id;
  tabId = win.tabs?.[0]?.id ?? null;
  if (tabId === null) {
    const [tab] = await chrome.tabs.query({ windowId });
    tabId = tab?.id ?? null;
  }
  await persistIds();
  // Opened results can be any site, some with sound; the user must never hear
  // a window they cannot see.
  if (tabId !== null) await chrome.tabs.update(tabId, { muted: true }).catch(() => {});
  log.info("hidden worker window created", { windowId, tabId });
  return tabId;
}

/**
 * Loads `url` in the hidden window, creating it if needed, and resolves once
 * the page settles. Resolves on timeout too: the request has already reached
 * Bing by then, which is the part that counts.
 */
export async function open(url) {
  await restoreIds();

  if (!(await isAlive())) {
    forget();
    // Born blank, then navigated. Creating straight at the target url would
    // race: the load can finish before the listener is attached, and we would
    // then sit out the full navigation timeout for a page already rendered.
    const created = await createHidden("about:blank");
    if (created === null) throw new Error("could not create the hidden worker tab");
  }

  assertWorkerTab(tabId);
  const settled = waitForSettle(tabId);
  await chrome.tabs.update(tabId, { url });
  return { tabId, outcome: await settled };
}

function waitForSettle(id, timeoutMs = NAVIGATION_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;

    // v2.4 added this listener per navigation and only removed it on success,
    // leaking one listener per failed load for the life of the worker.
    const done = (outcome) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
      resolve(outcome);
    };

    const onUpdated = (updatedId, info) => {
      if (updatedId === id && info.status === "complete") done("complete");
    };
    const onRemoved = (removedId) => {
      if (removedId === id) {
        forget();
        done("removed");
      }
    };

    const timer = setTimeout(() => done("timeout"), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * Clicks through to a result from the results page in the worker tab, stays
 * on it for `readMs`, then goes back, as a person reading a result would.
 * `clickFunc` runs in the page and returns { ok, href } once it has clicked.
 */
export async function followResult(clickFunc, readMs) {
  if (tabId === null) return { ok: false };
  assertWorkerTab(tabId);
  const id = tabId;

  // Listen before clicking: the navigation can finish before the script returns.
  const arrived = waitForSettle(id);
  const clicked = await runInTab(clickFunc);
  if (!clicked?.ok) return { ok: false };
  const outcome = await arrived;
  if (outcome === "removed") return { ok: false };

  await new Promise((resolve) => setTimeout(resolve, readMs));
  if (!isWorkerTab(id)) return { ok: false };

  const returned = waitForSettle(id);
  try {
    await chrome.tabs.goBack(id);
  } catch {
    return { ok: true, href: clicked.href, returned: false };
  }
  await returned;
  return { ok: true, href: clicked.href, returned: true };
}

/** Runs a function inside the worker tab. Refuses any other tab. */
export async function runInTab(func, args = [], world = "ISOLATED") {
  if (tabId === null) return null;
  assertWorkerTab(tabId);
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func,
      args,
      world,
    });
    return results?.[0]?.result ?? null;
  } catch (error) {
    log.debug("in-tab script failed", { error: String(error) });
    return null;
  }
}

export function currentTabId() {
  return tabId;
}

/**
 * Opens a page for the user, in a new foreground tab of their own window.
 * The single exception to "never touch the user's tabs": it only ever runs
 * because the user clicked a task in the popup, and it creates a tab rather
 * than taking over one.
 */
export async function openForUser(url) {
  if (!/^https:\/\//.test(String(url))) throw new Error(`refusing to open ${url}`);
  await chrome.tabs.create({ url, active: true });
}

/** Long enough for a results page's unload beacons to leave. */
const UNLOAD_TIMEOUT_MS = 3_000;

/** Closes the hidden window. Called on every break, so idle RAM is zero. */
export async function close() {
  await restoreIds();
  const id = windowId;
  const tab = tabId;
  forget();
  if (id === null) return;

  // Unload the page while its tab still exists. Beacons sent from a closing
  // window lose their tab id, so the tab-scoped mobile rule no longer matched
  // them and they left with the desktop identity.
  if (tab !== null) {
    try {
      const unloaded = waitForSettle(tab, UNLOAD_TIMEOUT_MS);
      await chrome.tabs.update(tab, { url: "about:blank" });
      await unloaded;
    } catch {
      // Already gone; nothing left to unload.
    }
  }

  try {
    await chrome.windows.remove(id);
    log.info("hidden worker window closed", { windowId: id });
  } catch {
    // Already gone.
  }
}

// If the user closes the hidden window by hand, drop the ids so the next step
// recreates it instead of failing against a dead handle.
chrome.windows.onRemoved.addListener((id) => {
  if (id === windowId) {
    log.info("hidden worker window disappeared, will recreate on next step");
    forget();
  }
});
