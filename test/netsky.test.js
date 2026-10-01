import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";

globalThis.chrome = makeChrome();
const netsky = await import("../src/core/netsky.js");

/** A fetch that answers from a table and records what was asked. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, search } = new URL(url);
    calls.push({ url, path: pathname + search, method: init.method, headers: init.headers, body: init.body });
    const route = routes[`${init.method} ${pathname}`];
    if (!route) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    if (route === "offline") throw new TypeError("Failed to fetch");
    const { status = 200, body = {} } = route;
    return new Response(JSON.stringify(body), { status });
  };
  return { fetchImpl, calls };
}

const connection = { url: "http://127.0.0.1:3010", token: "secret" };

test("every call carries the token", async () => {
  const { fetchImpl, calls } = fakeFetch({ "GET /health": { body: { ok: true, state: "idle" } } });
  const api = netsky.createClient(connection, fetchImpl);
  assert.deepEqual(await api.health(), { ok: true, state: "idle" });
  assert.equal(calls[0].headers.Authorization, "Bearer secret");
});

test("control calls send JSON bodies to the right paths", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "POST /start": { status: 202 },
    "POST /stop": { status: 202 },
    "POST /accounts": { status: 201 },
    "PATCH /accounts/2": {},
    "DELETE /accounts/2": {},
    "DELETE /sessions/me%40example.com": {},
    "PATCH /schedule": {},
  });
  const api = netsky.createClient(connection, fetchImpl);
  await api.start();
  await api.start({ accountIndex: 2 });
  await api.stop({ force: true });
  await api.addAccount({ email: "me@example.com", password: "pw" });
  await api.updateAccount(2, { password: "new" });
  await api.removeAccount(2);
  await api.deleteSession("me@example.com");
  await api.patchSchedule({ enabled: true, cron: "30 7 * * *" });

  assert.deepEqual(
    calls.map((c) => [c.method, c.path, c.body && JSON.parse(c.body)]),
    [
      ["POST", "/start", {}],
      ["POST", "/start", { accountIndex: 2 }],
      ["POST", "/stop", { force: true }],
      ["POST", "/accounts", { email: "me@example.com", password: "pw" }],
      ["PATCH", "/accounts/2", { password: "new" }],
      ["DELETE", "/accounts/2", undefined],
      ["DELETE", "/sessions/me%40example.com", undefined],
      ["PATCH", "/schedule", { enabled: true, cron: "30 7 * * *" }],
    ]
  );
});

test("log queries skip empty parameters", async () => {
  const { fetchImpl, calls } = fakeFetch({ "GET /logs": { body: { logs: [] } } });
  const api = netsky.createClient(connection, fetchImpl);
  await api.logs({ afterId: 41 });
  await api.logs();
  assert.deepEqual(calls.map((c) => c.path), ["/logs?afterId=41", "/logs"]);
});

test("API errors keep their status and code", async () => {
  const { fetchImpl } = fakeFetch({
    "GET /status": { status: 401, body: { error: "Unauthorized" } },
    "POST /accounts": { status: 409, body: { error: "me@example.com is already configured.", code: "ACCOUNT_EXISTS" } },
  });
  const api = netsky.createClient(connection, fetchImpl);
  await assert.rejects(api.status(), { status: 401, code: "UNAUTHORIZED" });
  await assert.rejects(api.addAccount({ email: "me@example.com" }), {
    status: 409,
    code: "ACCOUNT_EXISTS",
    message: "me@example.com is already configured.",
  });
});

test("a stopped container reads as offline, not as an error from the API", async () => {
  const { fetchImpl } = fakeFetch({ "GET /health": "offline" });
  await assert.rejects(netsky.createClient(connection, fetchImpl).health(), { code: "OFFLINE" });
});

test("the token is never sent anywhere but this machine", async () => {
  const { fetchImpl, calls } = fakeFetch({ "GET /health": {} });
  const api = netsky.createClient({ url: "https://example.com", token: "secret" }, fetchImpl);
  await assert.rejects(api.health(), { code: "BAD_URL" });
  assert.equal(calls.length, 0);
  await assert.rejects(netsky.saveConnection({ url: "http://10.0.0.5:3010", token: "x" }), { code: "BAD_URL" });
});

test("the connection is saved trimmed and read back with defaults", async () => {
  assert.deepEqual(await netsky.getConnection(), netsky.DEFAULT_CONNECTION);
  await netsky.saveConnection({ url: " http://localhost:3010/ ", token: " abc " });
  assert.deepEqual(await netsky.getConnection(), { url: "http://localhost:3010", token: "abc" });
});

test("a daily time and its cron convert both ways", () => {
  assert.equal(netsky.cronFromTime(7, 5), "5 7 * * *");
  assert.deepEqual(netsky.timeFromCron("5 7 * * *"), { hour: 7, minute: 5 });
  assert.equal(netsky.timeFromCron("0 7 * * 1-5"), null, "not a plain daily schedule");
  assert.equal(netsky.timeFromCron("0 25 * * *"), null);
  assert.equal(netsky.timeFromCron(null), null);
});

// -------------------------------------------------------------- login prompt

const at = (secondsAgo, now) => new Date(now - secondsAgo * 1000).toISOString();
const line = (user, message, secondsAgo, now, title = "LOGIN-PASSWORDLESS") => ({
  user,
  title,
  message,
  receivedAt: at(secondsAgo, now),
});

test("the Authenticator number waiting for approval is found", () => {
  const now = Date.now();
  const logs = [
    line("me", "Passwordless authentication requested", 20, now),
    line("me", "Please approve login and select number: 42", 15, now),
    line("me", "Waiting for approval... (timeout after 180 seconds)", 14, now),
  ];
  assert.deepEqual(netsky.loginPrompt(logs, now), { user: "me", number: "42" });
});

test("an approved or expired request asks nothing", () => {
  const now = Date.now();
  const approved = [
    line("me", "Please approve login and select number: 42", 30, now),
    line("me", "Login approved successfully", 10, now),
  ];
  assert.equal(netsky.loginPrompt(approved, now), null);
  const expired = [line("me", "Please approve login and select number: 42", 600, now)];
  assert.equal(netsky.loginPrompt(expired, now), null);
});

test("a request without a number still asks for approval", () => {
  const now = Date.now();
  const logs = [line("me", "Please approve login on your authenticator app", 5, now)];
  assert.deepEqual(netsky.loginPrompt(logs, now), { user: "me", number: null });
});

test("another account's approval does not settle this one", () => {
  const now = Date.now();
  const logs = [
    line("a", "Please approve login and select number: 17", 20, now),
    line("b", "Login approved successfully", 10, now),
    line("b", "Searching", 5, now, "SEARCH-BING"),
  ];
  assert.deepEqual(netsky.loginPrompt(logs, now), { user: "a", number: "17" });
});

// --------------------------------------------------------------------- badge

test("the badge shows what needs the user first", () => {
  assert.equal(netsky.badgeFor({ reachable: true, state: "running", prompt: { number: "42" } }).text, "42");
  assert.equal(netsky.badgeFor({ reachable: true, state: "running" }).text, "ON");
  assert.equal(netsky.badgeFor({ reachable: true, state: "idle", failed: true }).text, "!");
  assert.equal(netsky.badgeFor({ reachable: true, state: "idle" }).text, "");
  assert.equal(netsky.badgeFor({ reachable: false }).text, "");
});

test("a run the user stopped is not a failure; a crash or bad exit is", () => {
  assert.equal(netsky.lastRunFailed({ lastExit: null }), false);
  assert.equal(netsky.lastRunFailed({ lastExit: { code: 0, signal: null } }), false);
  assert.equal(netsky.lastRunFailed({ lastExit: { code: null, signal: "SIGTERM" } }), false);
  assert.equal(netsky.lastRunFailed({ lastExit: { code: 1, signal: null } }), true);
  assert.equal(netsky.lastRunFailed({ lastExit: { code: null, signal: null, error: "spawn ENOENT" } }), true);
});

test("manual-login calls use the right paths", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "GET /manual-login": { body: { state: "idle", requests: [] } },
    "POST /manual-login": { status: 202, body: { state: "running" } },
    "DELETE /manual-login": { body: { state: "cancelled" } },
  });
  const api = netsky.createClient(connection, fetchImpl);
  await api.manualLoginStatus();
  await api.startManualLogin("me@example.com");
  await api.cancelManualLogin();
  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ["GET /manual-login", "POST /manual-login", "DELETE /manual-login"]
  );
  assert.deepEqual(JSON.parse(calls[1].body), { email: "me@example.com" });
});

test("an account's Rewards pages are read by account number and page name", async () => {
  const { fetchImpl, calls } = fakeFetch({
    "GET /accounts/3/rewards": { body: { ok: true, status: 200, url: "https://rewards.bing.com/earn", body: "" } },
  });
  const api = netsky.createClient(connection, fetchImpl);
  await api.accountRewards(3, "flyout");
  await api.accountRewards("3", "quest", "ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard");
  assert.deepEqual(
    calls.map((c) => c.path),
    ["/accounts/3/rewards?page=flyout", "/accounts/3/rewards?page=quest&id=ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard"]
  );
});

test("the farming order is saved as the list of emails", async () => {
  const { fetchImpl, calls } = fakeFetch({ "PUT /accounts/order": { body: { reordered: true, order: [] } } });
  const api = netsky.createClient(connection, fetchImpl);
  await api.reorderAccounts(["b@x.com", "a@x.com"]);
  assert.equal(`${calls[0].method} ${calls[0].path}`, "PUT /accounts/order");
  assert.deepEqual(JSON.parse(calls[0].body), { emails: ["b@x.com", "a@x.com"] });
});

test("the badge asks for attention while a manual sign-in is open", () => {
  assert.deepEqual(netsky.badgeFor({ reachable: true, state: "idle", manual: true }), { text: "!", color: "#b45309" });
});

test("the toolbar badge follows TheNetsky", async () => {
  const now = new Date().toISOString();
  await netsky.saveConnection({ url: "http://127.0.0.1:3010", token: "t" });
  const running = fakeFetch({
    "GET /status": { body: { state: "running", lastExit: null } },
    "GET /logs": {
      body: { logs: [{ user: "me", title: "LOGIN-PASSWORDLESS", message: "Please approve login and select number: 7", receivedAt: now }] },
    },
  });
  assert.equal((await netsky.refreshBadge(running.fetchImpl)).text, "7");
  assert.equal(chrome.action.badge.text, "7");

  const offline = fakeFetch({ "GET /status": "offline", "GET /logs": "offline" });
  await netsky.refreshBadge(offline.fetchImpl);
  assert.equal(chrome.action.badge.text, "");
});
