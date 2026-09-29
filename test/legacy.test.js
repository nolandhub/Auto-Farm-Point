import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";

/**
 * This folder is loaded unpacked into a live browser, so "install" means
 * "upgrade over a running v2.4". Its leftovers must not survive.
 */
async function withStub(seed) {
  const stub = makeChrome();
  globalThis.chrome = stub;
  await seed(stub);
  const { cleanupLegacy } = await import(`../src/core/legacy.js?v=${Math.random()}`);
  const result = await cleanupLegacy();
  return { stub, result };
}

test("v2.4 alarms are cleared so they stop waking the worker", async () => {
  const { stub, result } = await withStub(async (s) => {
    s.alarms.create("intervalSearch", { when: Date.now() + 1000 });
    s.alarms.create("backupCheck", { periodInMinutes: 5 });
    s.alarms.create("continueSearch", { when: Date.now() + 1000 });
  });
  assert.deepEqual(result.alarms.sort(), ["backupCheck", "continueSearch", "intervalSearch"]);
  assert.equal(await stub.alarms.get("intervalSearch"), undefined);
});

test("this build's own alarms are left alone", async () => {
  const { stub, result } = await withStub(async (s) => {
    s.alarms.create("watchdog", { periodInMinutes: 1 });
    s.alarms.create("daily", { when: Date.now() + 60_000 });
    s.alarms.create("step", { when: Date.now() + 10_000 });
    s.alarms.create("intervalSearch", { when: Date.now() + 1000 });
  });
  assert.deepEqual(result.alarms, ["intervalSearch"]);
  assert.ok(await stub.alarms.get("watchdog"));
  assert.ok(await stub.alarms.get("daily"));
  assert.ok(await stub.alarms.get("step"));
});

test("v2.4 storage keys are removed", async () => {
  const { stub, result } = await withStub(async (s) => {
    await s.storage.local.set({
      "app.log": "old log text",
      intervalMode: true,
      currentQueries: ["a", "b"],
      workingWindowId: 42,
      activeTabId: 7,
    });
  });
  assert.deepEqual(
    result.keys.sort(),
    ["activeTabId", "app.log", "currentQueries", "intervalMode", "workingWindowId"]
  );
  assert.deepEqual(await stub.storage.local.get("app.log"), {});
});

test("this build's own storage is untouched", async () => {
  const { stub } = await withStub(async (s) => {
    await s.storage.local.set({
      "history.v3": { "2026-09-26": { pc: 26 } },
      "settings.v3": { lang: "vi" },
      "app.log": "old",
    });
  });
  const kept = await stub.storage.local.get(["history.v3", "settings.v3"]);
  assert.deepEqual(kept["history.v3"], { "2026-09-26": { pc: 26 } });
  assert.deepEqual(kept["settings.v3"], { lang: "vi" });
});

test("cleanup on a clean profile reports nothing and throws nothing", async () => {
  const { result } = await withStub(async () => {});
  assert.deepEqual(result, { alarms: [], keys: [] });
});
