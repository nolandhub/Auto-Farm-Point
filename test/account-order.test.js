import test from "node:test";
import assert from "node:assert/strict";
import { dropIndex, moveTo } from "../src/core/account-order.js";

test("moves one account to a new position and keeps the others in order", () => {
  const list = ["a", "b", "c", "d"];
  assert.deepEqual(moveTo(list, 2, 0), ["c", "a", "b", "d"]);
  assert.deepEqual(moveTo(list, 0, 3), ["b", "c", "d", "a"]);
  assert.deepEqual(moveTo(list, 1, 1), list);
  assert.deepEqual(list, ["a", "b", "c", "d"]); // the original is left alone
});

test("a position past either end stays at that end", () => {
  assert.deepEqual(moveTo(["a", "b", "c"], 1, -4), ["b", "a", "c"]);
  assert.deepEqual(moveTo(["a", "b", "c"], 1, 9), ["a", "c", "b"]);
});

// Rows 40px tall from y=0: 0-40, 40-80, 80-120, 120-160 (middles 20, 60, 100, 140).
const boxes = [0, 40, 80, 120].map((top) => ({ top, bottom: top + 40 }));

test("a dragged row passes another once its leading edge crosses that row's middle", () => {
  // Row 2 moved up 50px: its top (30) is past row 1's middle (60), not row 0's (20).
  assert.equal(dropIndex(boxes, 2, -50), 1);
  assert.equal(dropIndex(boxes, 2, -75), 0);
  // Row 0 moved down 70px: its bottom (110) is past rows 1 and 2.
  assert.equal(dropIndex(boxes, 0, 70), 2);
  assert.equal(dropIndex(boxes, 0, 400), 3);
  // A small move either way keeps it in place.
  assert.equal(dropIndex(boxes, 1, 10), 1);
  assert.equal(dropIndex(boxes, 1, -10), 1);
});

test("a row held at the top or bottom of the list lands there", () => {
  // Kept within the list, row 2 can rise by exactly 80px, or sink by 40px.
  assert.equal(dropIndex(boxes, 2, -80), 0);
  assert.equal(dropIndex(boxes, 2, 40), 3);
});
