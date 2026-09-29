import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitize,
  dedupe,
  naturalize,
  prepare,
  LOCAL_POOL,
} from "../src/core/queries.js";
import { makeRng } from "../src/core/pacing.js";

const rng = makeRng(424242);

test("sanitize trims and collapses runs of whitespace", () => {
  assert.equal(sanitize("  hello   world \n"), "hello world");
});

test("sanitize strips Wikipedia disambiguation parentheticals", () => {
  assert.equal(sanitize("Mercury (planet)"), "Mercury");
  assert.equal(sanitize("Pluto (disambiguation)"), "Pluto");
});

test("sanitize keeps a parenthetical that is the whole title", () => {
  // Nothing left after stripping means the strip was wrong; keep the original.
  assert.equal(sanitize("(hello)"), "(hello)");
});

test("sanitize rejects titles that are pure noise", () => {
  assert.equal(sanitize(""), null);
  assert.equal(sanitize("   "), null);
  assert.equal(sanitize("a"), null, "too short to be a real search");
  assert.equal(sanitize("x".repeat(200)), null, "too long to be human");
  assert.equal(sanitize("12345"), null, "bare numbers are a bot tell");
});

test("sanitize rejects Wikipedia namespace and meta pages", () => {
  assert.equal(sanitize("List of highest mountains"), null);
  assert.equal(sanitize("Category:Physics"), null);
  assert.equal(sanitize("Template:Infobox"), null);
  assert.equal(sanitize("2013 in Norwegian football"), null, "year-prefixed stubs read as scraped");
});

test("sanitize accepts an ordinary article title unchanged", () => {
  assert.equal(sanitize("Photosynthesis"), "Photosynthesis");
  assert.equal(sanitize("Ludwig van Beethoven"), "Ludwig van Beethoven");
});

test("sanitize never emits a trailing numeric suffix", () => {
  // The v2.4 backup generator produced "Technology 473"; that pattern must not survive.
  assert.equal(sanitize("Technology 473"), null);
});

test("dedupe is case-insensitive and keeps first occurrence order", () => {
  assert.deepEqual(dedupe(["Cats", "cats", "Dogs", "CATS", "dogs"]), ["Cats", "Dogs"]);
});

test("naturalize sometimes wraps and sometimes leaves the term alone", () => {
  const out = Array.from({ length: 500 }, () => naturalize("photosynthesis", rng));
  const bare = out.filter((q) => q === "photosynthesis").length;
  assert.ok(bare > 0 && bare < 500, `wrapped ${500 - bare}/500`);
  assert.ok(out.every((q) => q.toLowerCase().includes("photosynthesis")));
});

test("naturalize never produces a trailing number", () => {
  const out = Array.from({ length: 500 }, () => naturalize("photosynthesis", rng));
  assert.ok(out.every((q) => !/\s\d+$/.test(q)));
});

test("prepare returns exactly the requested count", () => {
  const raw = Array.from({ length: 200 }, (_, i) => `Article title number ${i} alpha`);
  assert.equal(prepare(raw, 30, rng).length, 30);
});

test("prepare tops up from the local pool when the source is short", () => {
  const out = prepare(["Photosynthesis", "Mitochondria"], 25, rng);
  assert.equal(out.length, 25);
});

test("prepare tops up when the source is entirely garbage", () => {
  const out = prepare(["", "  ", "Category:Junk", "12345", "a"], 10, rng);
  assert.equal(out.length, 10);
});

test("prepare emits no duplicates", () => {
  const out = prepare([], 40, rng);
  const lowered = out.map((q) => q.toLowerCase());
  assert.equal(new Set(lowered).size, out.length);
});

test("prepare never emits the v2.4 numeric-suffix tell", () => {
  const out = prepare([], 60, rng);
  assert.ok(out.every((q) => !/\s\d+$/.test(q)), out.filter((q) => /\s\d+$/.test(q)).join(", "));
});

test("prepare survives a request larger than the local pool", () => {
  const out = prepare([], LOCAL_POOL.length + 40, rng);
  assert.equal(out.length, LOCAL_POOL.length + 40);
});

test("the local pool itself carries no bot tells", () => {
  assert.ok(LOCAL_POOL.every((q) => !/\d/.test(q)), "no digits in the fallback pool");
  assert.ok(LOCAL_POOL.every((q) => sanitize(q) !== null), "every fallback must pass sanitize");
  assert.equal(new Set(LOCAL_POOL.map((q) => q.toLowerCase())).size, LOCAL_POOL.length);
});
