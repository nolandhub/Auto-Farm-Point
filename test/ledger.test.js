import test from "node:test";
import assert from "node:assert/strict";
import { earnedToday, pickToday, trackBalance } from "../src/core/ledger.js";

const MON = "2026-09-28";
const TUE = "2026-09-29";
const THU = "2026-10-01";

const read = (ledger, balance, day, previousDay) => trackBalance(ledger, { balance, day, previousDay });

test("points earned today are the balance over yesterday's last reading", () => {
  let ledger = read(null, 900, MON, "2026-09-27");
  ledger = read(ledger, 951, MON, "2026-09-27"); // Monday evening
  ledger = read(ledger, 964, TUE, MON); // Tuesday's first reading
  ledger = read(ledger, 1104, TUE, MON);
  assert.equal(earnedToday(ledger, TUE), 1104 - 951);
});

test("app points count too: nothing but the balance is looked at", () => {
  let ledger = read(null, 951, MON, "2026-09-27");
  ledger = read(ledger, 1101, TUE, MON); // check-in, read to earn, app offers
  assert.equal(earnedToday(ledger, TUE), 150);
});

test("spending points on a reward is not negative earning", () => {
  let ledger = read(null, 1000, MON, "2026-09-27");
  ledger = read(ledger, 1030, TUE, MON);
  ledger = read(ledger, 30, TUE, MON); // redeemed 1000
  ledger = read(ledger, 45, TUE, MON);
  assert.equal(earnedToday(ledger, TUE), 45);
});

test("with no reading from yesterday, today starts from its first reading", () => {
  let ledger = read(null, 1000, MON, "2026-09-27");
  ledger = read(ledger, 1200, THU, "2026-09-30"); // Edge was closed Tuesday and Wednesday
  ledger = read(ledger, 1215, THU, "2026-09-30");
  assert.equal(earnedToday(ledger, THU), 15);
  assert.equal(ledger.exact, false, "points before the first reading are unknown");
});

test("the very first reading knows nothing about earlier today", () => {
  const ledger = read(null, 1104, TUE, MON);
  assert.equal(earnedToday(ledger, TUE), 0);
  assert.equal(ledger.exact, false);
});

test("a ledger from another day says nothing about today", () => {
  const ledger = read(null, 951, MON, "2026-09-27");
  assert.equal(earnedToday(ledger, TUE), null);
  assert.equal(earnedToday(null, TUE), null);
});

test("a day that starts from yesterday's reading is exact", () => {
  let ledger = read(null, 951, MON, "2026-09-27");
  ledger = read(ledger, 960, TUE, MON);
  assert.equal(ledger.exact, true);
});

test("readings without a balance change nothing", () => {
  const ledger = read(null, 951, MON, "2026-09-27");
  assert.deepEqual(read(ledger, null, MON, "2026-09-27"), ledger);
  assert.deepEqual(read(ledger, Number.NaN, MON, "2026-09-27"), ledger);
});

// ------------------------------------------------------ what "today" shows

test("a ledger that starts from yesterday is the answer, whatever else says", () => {
  // The bot's live tally counts each search twice until its run ends.
  assert.equal(pickToday({ earned: 144, exact: true, dailyPoint: 52, bot: 282 }), 144);
});

test("without yesterday's reading, the best partial view wins", () => {
  assert.equal(pickToday({ earned: 149, exact: false, dailyPoint: 52, bot: 307 }), 307);
  assert.equal(pickToday({ earned: 0, exact: false, dailyPoint: 52, bot: null }), 52);
});

test("nothing known shows nothing", () => {
  assert.equal(pickToday({ earned: null, exact: false, dailyPoint: null, bot: null }), null);
  assert.equal(pickToday({}), null);
});
