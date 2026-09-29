import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";
import { MOBILE_RULE_ID } from "../src/core/constants.js";
import { applyMobile, buildMobileIdentity } from "../src/core/identity.js";

/**
 * The mobile identity is only as good as its least consistent header. A probe
 * of a real run showed the old rule claiming Chrome 140 in sec-ch-ua while the
 * browser's own sec-ch-ua-full-version-list said 154, sec-ch-ua-arch "x86" on
 * an "Android" phone, and sendBeacon pings leaving with the desktop identity.
 */

const CHROME_154 = {
  brands: [
    { brand: "Chromium", version: "154" },
    { brand: "Google Chrome", version: "154" },
    { brand: "Not A(Brand", version: "99" },
  ],
  fullVersionList: [
    { brand: "Chromium", version: "154.0.8037.57" },
    { brand: "Google Chrome", version: "154.0.8037.57" },
    { brand: "Not A(Brand", version: "99.0.0.0" },
  ],
  uaFullVersion: "154.0.8037.57",
};

const EDGE_153 = {
  brands: [
    { brand: "Microsoft Edge", version: "153" },
    { brand: "Chromium", version: "153" },
    { brand: "Not A(Brand", version: "99" },
  ],
  fullVersionList: [
    { brand: "Microsoft Edge", version: "153.0.3600.12" },
    { brand: "Chromium", version: "153.0.8010.52" },
    { brand: "Not A(Brand", version: "99.0.0.0" },
  ],
  uaFullVersion: "153.0.8010.52",
};

const header = (identity, name) =>
  identity.headers.find((h) => h.header === name)?.value;

test("the phone claims the same browser version the machine really runs", () => {
  const id = buildMobileIdentity(CHROME_154);
  assert.match(id.userAgent, /Chrome\/154\.0\.0\.0 Mobile Safari\/537\.36$/);
  assert.equal(
    header(id, "sec-ch-ua"),
    '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"'
  );
  assert.equal(
    header(id, "sec-ch-ua-full-version-list"),
    '"Chromium";v="154.0.8037.57", "Google Chrome";v="154.0.8037.57", "Not A(Brand";v="99.0.0.0"'
  );
  assert.equal(header(id, "sec-ch-ua-full-version"), '"154.0.8037.57"');
});

test("every hint Bing asks for describes a phone", () => {
  const id = buildMobileIdentity(CHROME_154);
  assert.match(id.userAgent, /\(Linux; Android 10; K\)/, "Chrome's reduced Android UA");
  assert.equal(header(id, "sec-ch-ua-mobile"), "?1");
  assert.equal(header(id, "sec-ch-ua-platform"), '"Android"');
  assert.equal(header(id, "sec-ch-ua-arch"), '""', "phones report no arch");
  assert.equal(header(id, "sec-ch-ua-bitness"), '""');
  assert.notEqual(header(id, "sec-ch-ua-model"), '""', "phones report a model");
  assert.match(header(id, "sec-ch-ua-platform-version"), /^"\d+\.\d+\.\d+"$/);
});

test("on Edge the phone is Chrome for Android, with nothing of Edge left", () => {
  // Desktop Edge stamps its own markers on every bing.com request; a phone
  // carrying them is a phone that says it is desktop Edge.
  const id = buildMobileIdentity(EDGE_153);
  assert.match(id.userAgent, /Chrome\/153\.0\.0\.0 Mobile Safari\/537\.36$/, "no EdgA token");
  assert.doesNotMatch(header(id, "sec-ch-ua"), /Edge/);
  assert.match(header(id, "sec-ch-ua"), /"Google Chrome";v="153"/);
  assert.equal(
    header(id, "sec-ch-ua-full-version-list"),
    '"Google Chrome";v="153.0.8010.52", "Chromium";v="153.0.8010.52", "Not A(Brand";v="99.0.0.0"',
    "Chrome's version is Chromium's, never Edge's"
  );
  assert.equal(header(id, "sec-ch-ua-full-version"), '"153.0.8010.52"');
});

test("the headers only desktop Edge sends are stripped from the phone", () => {
  const id = buildMobileIdentity(EDGE_153);
  const removed = id.headers.filter((h) => h.operation === "remove").map((h) => h.header);
  for (const name of ["sec-ms-gec", "sec-ms-gec-version", "x-edge-shopping-flag", "x-client-data"]) {
    assert.ok(removed.includes(name), `${name} would say "desktop Edge"`);
  }
});

test("without userAgentData the identity still hangs together", () => {
  const id = buildMobileIdentity(null);
  const major = id.userAgent.match(/Chrome\/(\d+)\./)[1];
  assert.match(header(id, "sec-ch-ua"), new RegExp(`v="${major}"`));
  assert.match(header(id, "sec-ch-ua-full-version-list"), new RegExp(`v="${major}\\.`));
});

test("the rule rewrites beacons too, not just page loads", async () => {
  globalThis.chrome = makeChrome();
  await applyMobile(42);
  const rule = globalThis.chrome.sessionRules.get(MOBILE_RULE_ID);
  assert.deepEqual(rule.condition.tabIds, [42]);
  for (const type of ["main_frame", "sub_frame", "xmlhttprequest", "ping", "media", "websocket"]) {
    assert.ok(rule.condition.resourceTypes.includes(type), `${type} would leak the desktop identity`);
  }
  const names = rule.action.requestHeaders.map((h) => h.header);
  assert.ok(names.includes("sec-ch-ua-arch"));
  assert.ok(names.includes("sec-ch-ua-full-version-list"));
});
