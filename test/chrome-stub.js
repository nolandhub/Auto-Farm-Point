/**
 * Minimal in-memory Chrome extension API, enough to drive a real run.
 * Every call is recorded so tests can assert on what the extension asked the
 * browser to do — which is exactly where the tab-stealing bug lived.
 */
export function makeChrome() {
  const calls = [];
  const store = new Map();
  const alarms = new Map();
  const sessionRules = new Map();
  const tabs = new Map();
  const windows = new Map();

  let nextId = 1;
  let updateFailures = 0;

  const listeners = {
    tabsUpdated: new Set(),
    tabsRemoved: new Set(),
    windowsRemoved: new Set(),
    committed: new Set(),
  };

  // windowId is captured at call time: by the time a test inspects the log the
  // worker window is usually closed and its tabs are gone.
  const record = (api, ...args) =>
    calls.push({ api, args, windowId: tabs.get(args[0])?.windowId });

  // The user's own window, with the tab they are reading.
  const userWindowId = nextId++;
  windows.set(userWindowId, { id: userWindowId, focused: true, state: "normal" });
  const userTabId = nextId++;
  tabs.set(userTabId, { id: userTabId, windowId: userWindowId, url: "https://example.com" });

  function emitComplete(tabId) {
    setTimeout(() => {
      for (const fn of listeners.tabsUpdated) fn(tabId, { status: "complete" }, tabs.get(tabId));
    }, 1);
  }

  const chrome = {
    calls,
    sessionRules,
    userWindowId,
    // Whether a results page offers a result to click (tests may turn it off).
    resultsClickable: true,

    storage: {
      local: {
        async get(keys) {
          const list = keys === undefined ? [...store.keys()] : [].concat(keys);
          return Object.fromEntries(
            list.filter((k) => store.has(k)).map((k) => [k, structuredClone(store.get(k))])
          );
        },
        async set(items) {
          for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
        },
        async remove(keys) {
          for (const k of [].concat(keys)) store.delete(k);
        },
        async clear() {
          store.clear();
        },
      },
    },

    alarms: {
      create(name, info) {
        record("alarms.create", name, info);
        alarms.set(name, { name, scheduledTime: info.when ?? Date.now() + 60_000 });
      },
      async get(name) {
        return alarms.get(name) ?? undefined;
      },
      async clear(name) {
        return alarms.delete(name);
      },
      async clearAll() {
        alarms.clear();
      },
      async getAll() {
        return [...alarms.values()];
      },
      onAlarm: { addListener() {} },
    },

    runtime: {
      onMessage: { addListener() {} },
      onConnect: { addListener() {} },
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      lastError: null,
    },

    windows: {
      async create(info) {
        record("windows.create", info);
        const id = nextId++;
        windows.set(id, { id, focused: info.focused ?? true, state: info.state ?? "normal" });
        const tabId = nextId++;
        tabs.set(tabId, { id: tabId, windowId: id, url: info.url ?? "about:blank" });
        return { id, tabs: [{ id: tabId }] };
      },
      async get(id) {
        record("windows.get", id);
        if (!windows.has(id)) throw new Error(`no window ${id}`);
        return windows.get(id);
      },
      async update(id, info) {
        record("windows.update", id, info);
        Object.assign(windows.get(id) ?? {}, info);
      },
      async remove(id) {
        record("windows.remove", id);
        if (!windows.has(id)) throw new Error(`no window ${id}`);
        windows.delete(id);
        for (const [tid, tab] of tabs) if (tab.windowId === id) tabs.delete(tid);
        for (const fn of listeners.windowsRemoved) fn(id);
      },
      onRemoved: { addListener: (fn) => listeners.windowsRemoved.add(fn) },
    },

    scripting: {
      async executeScript({ target, func, args, world }) {
        record("scripting.executeScript", target.tabId, { func: func?.name, args, world });
        if (!tabs.has(target.tabId)) throw new Error(`no tab ${target.tabId}`);
        if (func?.name === "clickResult") {
          // A result was clicked: the tab navigates to it.
          if (!chrome.resultsClickable) return [{ result: { ok: false } }];
          emitComplete(target.tabId);
          return [{ result: { ok: true, href: "https://en.wikipedia.org/wiki/Example" } }];
        }
        return [{ result: true }];
      },
    },

    declarativeNetRequest: {
      async updateSessionRules(update) {
        record("dnr.updateSessionRules", update);
        for (const id of update.removeRuleIds ?? []) sessionRules.delete(id);
        for (const rule of update.addRules ?? []) sessionRules.set(rule.id, rule);
      },
    },

    webNavigation: {
      onCommitted: {
        addListener: (fn) => listeners.committed.add(fn),
        removeListener: (fn) => listeners.committed.delete(fn),
      },
    },

    i18n: { getUILanguage: () => "en-US" },

    action: {
      badge: { text: "", color: null },
      async setBadgeText({ text }) {
        chrome.action.badge.text = text;
      },
      async setBadgeBackgroundColor({ color }) {
        chrome.action.badge.color = color;
      },
    },

    // -------------------------------------------------------- test controls
    addForeignTab() {
      const id = nextId++;
      const tab = { id, windowId: userWindowId, url: "https://news.example" };
      tabs.set(id, tab);
      return tab;
    },
    openWindows() {
      return [...windows.values()];
    },
    closeWorkerWindow() {
      for (const [id] of windows) {
        if (id !== userWindowId) {
          windows.delete(id);
          for (const [tid, tab] of tabs) if (tab.windowId === id) tabs.delete(tid);
          for (const fn of listeners.windowsRemoved) fn(id);
        }
      }
    },
    failNextUpdates(n) {
      updateFailures = n;
    },
  };

  chrome.tabs = {
    async get(id) {
      if (!tabs.has(id)) throw new Error(`no tab ${id}`);
      return tabs.get(id);
    },
    async query({ windowId }) {
      return [...tabs.values()].filter((t) => t.windowId === windowId);
    },
    async update(id, info) {
      record("tabs.update", id, info);
      if (updateFailures > 0) {
        updateFailures -= 1;
        throw new Error("simulated navigation failure");
      }
      if (!tabs.has(id)) throw new Error(`no tab ${id}`);
      Object.assign(tabs.get(id), info);
      emitComplete(id);
      return tabs.get(id);
    },
    async goBack(id) {
      record("tabs.goBack", id);
      if (!tabs.has(id)) throw new Error(`no tab ${id}`);
      emitComplete(id);
    },
    async create(info) {
      record("tabs.create", info);
      const id = nextId++;
      tabs.set(id, { id, windowId: info.windowId ?? userWindowId, url: info.url });
      emitComplete(id);
      return tabs.get(id);
    },
    onUpdated: {
      addListener: (fn) => listeners.tabsUpdated.add(fn),
      removeListener: (fn) => listeners.tabsUpdated.delete(fn),
    },
    onRemoved: {
      addListener: (fn) => listeners.tabsRemoved.add(fn),
      removeListener: (fn) => listeners.tabsRemoved.delete(fn),
    },
  };

  chrome.tabsMap = tabs;
  return chrome;
}
