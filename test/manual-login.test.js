import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";

globalThis.chrome = makeChrome();
const ml = await import("../src/core/manual-login.js");

const CONNECTION_URL = "http://127.0.0.1:3010";
const PAGE = { webPort: 6080, path: "/vnc.html?autoconnect=1&resize=scale" };
const REQUEST = { email: "me@example.com", reason: "email-code-only", at: "2026-09-29T12:00:00.000Z" };

function fakeTabs() {
  const created = [];
  const removed = [];
  return {
    created,
    removed,
    async create(info) {
      created.push(info);
      return { id: 42 };
    },
    async remove(id) {
      removed.push(id);
    },
  };
}

function fakeStorage() {
  const map = new Map();
  return {
    async get(key) {
      return map.has(key) ? { [key]: structuredClone(map.get(key)) } : {};
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) map.set(key, structuredClone(value));
    },
  };
}

function fakeApi({ manual, bot = { state: "idle" }, accounts = [] }) {
  const calls = [];
  return {
    calls,
    manual,
    async manualLoginStatus() {
      if (this.manual instanceof Error) throw this.manual;
      return this.manual;
    },
    async startManualLogin(email) {
      calls.push(["startManualLogin", email]);
      this.manual = { ...this.manual, ...PAGE, state: "running", email, requests: [] };
      return this.manual;
    },
    async status() {
      return bot;
    },
    async accounts() {
      return { accounts };
    },
    async start(options) {
      calls.push(["start", options]);
    },
  };
}

test("the page URL is the API host on the noVNC port", () => {
  assert.equal(ml.pageUrl(CONNECTION_URL, PAGE), "http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale");
});

test("a request is opened once, oldest first", () => {
  const older = { ...REQUEST, email: "a@example.com", at: "2026-09-29T11:00:00.000Z" };
  const status = { requests: [REQUEST, older] };
  assert.equal(ml.nextRequest(status, []).email, "a@example.com");
  assert.equal(ml.nextRequest(status, [ml.requestKey(older)]).email, "me@example.com");
  assert.equal(ml.nextRequest(status, [ml.requestKey(older), ml.requestKey(REQUEST)]), null);
});

test("a new request starts a manual login and opens its page, once", async () => {
  const api = fakeApi({ manual: { ...PAGE, state: "idle", requests: [REQUEST] } });
  const tabs = fakeTabs();
  const storage = fakeStorage();
  assert.equal(await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage }), "opened");
  assert.deepEqual(api.calls, [["startManualLogin", "me@example.com"]]);
  assert.equal(tabs.created[0].url, "http://127.0.0.1:6080/vnc.html?autoconnect=1&resize=scale");

  api.manual = { ...PAGE, state: "failed", email: "me@example.com", requests: [REQUEST] };
  assert.equal(await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage }), null);
  assert.equal(api.calls.length, 1, "the same request is not reopened");
  assert.deepEqual(tabs.removed, [42], "the page closes when the sign-in ends");
});

test("a saved sign-in closes the page and reruns the account", async () => {
  const api = fakeApi({
    manual: { ...PAGE, state: "idle", requests: [REQUEST] },
    accounts: [{ index: 4, email: "me@example.com" }],
  });
  const tabs = fakeTabs();
  const storage = fakeStorage();
  await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage });

  api.manual = { ...PAGE, state: "succeeded", email: "me@example.com", requests: [] };
  assert.equal(await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage }), "rerun");
  assert.deepEqual(tabs.removed, [42]);
  assert.deepEqual(api.calls.at(-1), ["start", { accountIndex: 4 }]);
});

test("the rerun waits while the bot is busy", async () => {
  const bot = { state: "running" };
  const api = fakeApi({
    manual: { ...PAGE, state: "idle", requests: [REQUEST] },
    bot,
    accounts: [{ index: 4, email: "me@example.com" }],
  });
  const tabs = fakeTabs();
  const storage = fakeStorage();
  await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage });
  api.manual = { ...PAGE, state: "succeeded", email: "me@example.com", requests: [] };
  assert.equal(await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage }), null);
  assert.equal(api.calls.filter(([name]) => name === "start").length, 0);

  bot.state = "idle";
  assert.equal(await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage }), "rerun");
});

test("an API without manual login is left alone", async () => {
  const api = fakeApi({ manual: new Error("Not found") });
  const tabs = fakeTabs();
  assert.equal(await ml.tickManualLogin({ api, connectionUrl: CONNECTION_URL, tabs, storage: fakeStorage() }), null);
  assert.equal(tabs.created.length, 0);
});
