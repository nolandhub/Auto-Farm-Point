import { FALLBACK_BROWSER, MOBILE_DEVICE, MOBILE_RULE_ID } from "./constants.js";
import { log } from "./log.js";

/**
 * Presents the worker tab as a phone so Microsoft credits the mobile search
 * quota. Every header moves together on purpose: Bing reads the client hints
 * before the User-Agent, and asks for the high-entropy ones (arch, model,
 * platform version, full version list) on every response. A phone whose hints
 * say "x86" or name a different Chrome than its own sec-ch-ua is a
 * contradiction no real device produces.
 *
 * Scoped to a single tabId via a session rule, so the user's own browsing is
 * never touched.
 */

let committedListener = null;

/**
 * Every type a page can send. sendBeacon pings in particular carry Bing's
 * search logging, and without "ping" here they left the phone with the
 * desktop identity.
 */
const RESOURCE_TYPES = [
  "main_frame",
  "sub_frame",
  "xmlhttprequest",
  "script",
  "stylesheet",
  "image",
  "font",
  "media",
  "ping",
  "websocket",
  "object",
  "csp_report",
  "other",
];

/**
 * Headers desktop Edge adds to every bing.com request: its anti-abuse token
 * and version, its shopping flag, and its variations id. Chrome sends none of
 * them to Bing, so on the phone they would only say "this is desktop Edge".
 */
const EDGE_ONLY_HEADERS = ["sec-ms-gec", "sec-ms-gec-version", "x-edge-shopping-flag", "x-client-data"];

const brandList = (list) => list.map(({ brand, version }) => `"${brand}";v="${version}"`).join(", ");

/** GREASE brands look like "Not A(Brand"; everything else names a browser. */
const isGrease = (brand) => /^Not.?A.?Brand$/i.test(brand);

/**
 * The phone is always Chrome for Android, the most common mobile client. A
 * vendor brand (Edge, Opera, ...) becomes "Google Chrome" at the Chromium
 * version, since that is the version Chrome itself would report.
 */
function asChrome(list) {
  const chromium = list.find((b) => b.brand === "Chromium")?.version;
  return list.map(({ brand, version }) =>
    brand === "Chromium" || isGrease(brand) || !chromium
      ? { brand, version }
      : { brand: "Google Chrome", version: chromium }
  );
}

/**
 * Builds the phone from the browser that is actually running: same engine
 * version, Chrome's brands, Android device details. Pure, so it can be tested.
 */
export function buildMobileIdentity(browser) {
  const source = browser?.brands?.length ? browser : FALLBACK_BROWSER;
  const brands = asChrome(source.brands);
  const fullVersionList = source.fullVersionList?.length
    ? asChrome(source.fullVersionList)
    : brands.map((b) => ({ brand: b.brand, version: `${b.version}.0.0.0` }));
  const major =
    String(brands.find((b) => b.brand === "Chromium")?.version ?? "").split(".")[0] ||
    FALLBACK_BROWSER.brands[0].version;
  const uaFullVersion =
    fullVersionList.find((b) => b.brand === "Chromium")?.version ||
    source.uaFullVersion ||
    `${major}.0.0.0`;

  // Chrome's reduced Android UA: the real model and OS version go in the hints.
  const userAgent =
    `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Mobile Safari/537.36`;

  const values = {
    "user-agent": userAgent,
    "sec-ch-ua": brandList(brands),
    "sec-ch-ua-mobile": "?1",
    "sec-ch-ua-platform": '"Android"',
    "sec-ch-ua-platform-version": `"${MOBILE_DEVICE.platformVersion}"`,
    "sec-ch-ua-model": `"${MOBILE_DEVICE.model}"`,
    "sec-ch-ua-arch": '""',
    "sec-ch-ua-bitness": '""',
    "sec-ch-ua-wow64": "?0",
    "sec-ch-ua-full-version": `"${uaFullVersion}"`,
    "sec-ch-ua-full-version-list": brandList(fullVersionList),
    "sec-ch-ua-form-factors": '"Mobile"',
  };

  return {
    userAgent,
    platform: MOBILE_DEVICE.platform,
    brands,
    fullVersionList,
    uaFullVersion,
    model: MOBILE_DEVICE.model,
    platformVersion: MOBILE_DEVICE.platformVersion,
    headers: [
      ...Object.entries(values).map(([header, value]) => ({ header, operation: "set", value })),
      ...EDGE_ONLY_HEADERS.map((header) => ({ header, operation: "remove" })),
    ],
  };
}

/** The running browser's brands and versions, from the worker's navigator. */
async function readBrowser() {
  const data = globalThis.navigator?.userAgentData;
  if (!data?.brands?.length) return null;
  try {
    const high = await data.getHighEntropyValues(["fullVersionList", "uaFullVersion"]);
    return { brands: data.brands, fullVersionList: high.fullVersionList, uaFullVersion: high.uaFullVersion };
  } catch {
    return { brands: data.brands };
  }
}

/**
 * Patches the renderer's view of itself to match the headers. Runs in the MAIN
 * world at navigation-commit time, before the page's own scripts read
 * navigator, so client-side telemetry agrees with what the server was told.
 */
function patchNavigator(identity) {
  const define = (object, prop, value) => {
    try {
      Object.defineProperty(object, prop, { get: () => value, configurable: true });
    } catch {
      /* some properties are locked down; headers still carry the signal */
    }
  };
  define(navigator, "userAgent", identity.userAgent);
  define(navigator, "appVersion", identity.userAgent.replace(/^Mozilla\//, ""));
  define(navigator, "platform", identity.platform);
  define(navigator, "maxTouchPoints", 5);
  if (navigator.userAgentData) {
    const high = {
      architecture: "",
      bitness: "",
      brands: identity.brands,
      formFactors: ["Mobile"],
      fullVersionList: identity.fullVersionList,
      mobile: true,
      model: identity.model,
      platform: "Android",
      platformVersion: identity.platformVersion,
      uaFullVersion: identity.uaFullVersion,
      wow64: false,
    };
    const low = { brands: identity.brands, mobile: true, platform: "Android" };
    define(navigator, "userAgentData", {
      ...low,
      getHighEntropyValues: (hints) =>
        Promise.resolve({
          ...low,
          ...Object.fromEntries((hints ?? []).filter((h) => h in high).map((h) => [h, high[h]])),
        }),
      toJSON: () => low,
    });
  }
}

export async function applyMobile(tabId) {
  const identity = buildMobileIdentity(await readBrowser());

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [MOBILE_RULE_ID],
    addRules: [
      {
        id: MOBILE_RULE_ID,
        priority: 1,
        condition: { tabIds: [tabId], resourceTypes: RESOURCE_TYPES },
        action: { type: "modifyHeaders", requestHeaders: identity.headers },
      },
    ],
  });

  attachNavigatorPatch(tabId, identity);
  log.info("mobile identity applied", { tabId, userAgent: identity.userAgent });
}

function attachNavigatorPatch(tabId, identity) {
  detachNavigatorPatch();
  if (!chrome.webNavigation?.onCommitted) return;

  const { headers, ...pageIdentity } = identity;
  committedListener = (details) => {
    if (details.tabId !== tabId || details.frameId !== 0) return;
    chrome.scripting
      .executeScript({
        target: { tabId },
        world: "MAIN",
        injectImmediately: true,
        func: patchNavigator,
        args: [pageIdentity],
      })
      .catch(() => {
        /* the header override is the load-bearing half; this is a refinement */
      });
  };
  chrome.webNavigation.onCommitted.addListener(committedListener);
}

function detachNavigatorPatch() {
  if (committedListener && chrome.webNavigation?.onCommitted) {
    chrome.webNavigation.onCommitted.removeListener(committedListener);
  }
  committedListener = null;
}

/** Back to this machine's real identity. Always called when a run ends. */
export async function clearIdentity() {
  detachNavigatorPatch();
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [MOBILE_RULE_ID],
    });
  } catch {
    /* nothing to remove */
  }
}
