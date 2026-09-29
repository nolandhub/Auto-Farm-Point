import test from "node:test";
import assert from "node:assert/strict";
import { makeChrome } from "./chrome-stub.js";
import { parseQuestIds, parseQuestPage, questOffers, readQuests } from "../src/core/quests.js";
import { EARN_HTML, child, questHtml } from "./quest-fixture.js";

test("the Earn page yields each quest id once", () => {
  assert.deepEqual(parseQuestIds(EARN_HTML), [
    "WW_pcparent_RewardsApp_weekly_Exclusive_Septw4_2026_punchcard",
    "ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard",
  ]);
});

test("a quest page yields its header: title, points, progress, expiry", () => {
  const q = parseQuestPage(questHtml(), "ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard");
  assert.equal(q.title, "Discover trending September ideas for fashion, sports, travel and online education");
  assert.equal(q.points, 50);
  assert.equal(q.done, 1);
  assert.equal(q.total, 4);
  assert.equal(q.expiresAt, "2026-10-01T07:00:00.000Z");
  assert.equal(q.appOnly, false);
});

test("a quest page yields each activity with what reporting it needs", () => {
  const q = parseQuestPage(
    questHtml({ children: [child(2, { locked: false }), child(3, { locked: true })] }),
    "ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard"
  );
  assert.equal(q.children.length, 2);
  const [a, b] = q.children;
  assert.equal(a.offerId, "ENWW_pcchild2_urlreward_FY27_BingMonthlyPC_Sep_punchcard");
  assert.equal(a.hash.length, 64);
  assert.equal(a.href, "https://www.bing.com/search?q=NFL+Schedule+2026&form=ML2Y1K&OCID=ML2Y1K&PUBL=RewardsDO&CREA=ML2Y1K&rnoreward=1");
  assert.equal(a.title, "Stay ready for NFL season");
  assert.equal(a.isLocked, false);
  assert.equal(b.isLocked, true);
});

test("an activity already done today is not offered again", () => {
  const q = parseQuestPage(questHtml({ children: [child(2, { done: true })] }), "x_punchcard");
  assert.deepEqual(questOffers([q]), []);
});

test("only unlocked, unfinished activities become offers", () => {
  const q = parseQuestPage(
    questHtml({ children: [child(2, { locked: false }), child(3, { locked: true })] }),
    "ENWW_pcparent_FY27_BingMonthlyPC_Sep_punchcard"
  );
  const offers = questOffers([q]);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].id, "ENWW_pcchild2_urlreward_FY27_BingMonthlyPC_Sep_punchcard");
  assert.equal(offers[0].kind, "urlreward");
  assert.equal(offers[0].activityType, "urlreward");
  assert.match(offers[0].url, /^https:\/\/www\.bing\.com\/search\?/);
  assert.ok(offers[0].hash);
});

test("quests that must be done in the Rewards app are never automated", () => {
  const q = parseQuestPage(
    questHtml({
      points: "0",
      description: "To receive the points, you must complete the activities in the Desktop Rewards app.",
      children: [child(2, { locked: false })],
    }),
    "WW_pcparent_RewardsApp_weekly_Exclusive_Septw4_2026_punchcard"
  );
  assert.equal(q.appOnly, true);
  assert.deepEqual(questOffers([q]), []);
});

const WINDOWS_APP_DESCRIPTION =
  "Unlock exclusive Desktop Rewards app activities and earn up to 70 points per week. A new activity is " +
  "available each day. To receive the points, you must complete the activities in the Desktop Rewards app.(0/70)";

test("a Windows app quest states its reward only in its description, and it is still read", () => {
  const q = parseQuestPage(questHtml({ points: null, description: WINDOWS_APP_DESCRIPTION }), "w");
  assert.equal(q.points, 70);
});

test("quests say which Rewards app they need: the Windows one or the phone one", () => {
  const windows = parseQuestPage(questHtml({ description: WINDOWS_APP_DESCRIPTION }), "w");
  const phone = parseQuestPage(
    questHtml({ description: "To receive the points, you must complete the activities in the Rewards app." }),
    "p"
  );
  const web = parseQuestPage(questHtml(), "m");
  assert.equal(windows.appKind, "desktop");
  assert.equal(phone.appKind, "mobile");
  assert.equal(web.appKind, null);
});

test("a +N badge wins over a figure in the description", () => {
  const q = parseQuestPage(questHtml({ points: "50", description: "Do it all.(1/30)" }), "m");
  assert.equal(q.points, 50);
});

test("a page that is not a quest parses to null rather than throwing", () => {
  assert.equal(parseQuestPage("<html>Sign in to continue</html>", "x"), null);
  assert.equal(parseQuestPage("", "x"), null);
});

test("readQuests reports signed out when rewards.bing.com bounces to login", async () => {
  globalThis.chrome = makeChrome();
  globalThis.fetch = async () => ({ ok: true, status: 200, url: "https://login.live.com/oauth20_authorize.srf", text: async () => "<html>login</html>" });
  const result = await readQuests();
  assert.equal(result.signedIn, false);
  assert.deepEqual(result.quests, []);
});

test("readQuests follows each quest link on the Earn page", async () => {
  globalThis.chrome = makeChrome();
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    const u = String(url);
    const body = u.endsWith("/earn") ? EARN_HTML : questHtml({ children: [child(2, { locked: false })] });
    return { ok: true, status: 200, url: u, text: async () => body };
  };
  const result = await readQuests();
  assert.equal(result.signedIn, true);
  assert.equal(result.quests.length, 2);
  assert.equal(asked.length, 3, "the Earn page, then one page per quest");
});

test("readQuests never throws on a network failure", async () => {
  globalThis.chrome = makeChrome();
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  const result = await readQuests();
  assert.deepEqual(result.quests, []);
});
