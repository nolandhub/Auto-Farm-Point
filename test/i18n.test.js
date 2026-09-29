import test from "node:test";
import assert from "node:assert/strict";
import { STRINGS, LANGS, resolveLang, t } from "../src/core/i18n.js";

test("every advertised language has a string table", () => {
  for (const lang of LANGS) assert.ok(STRINGS[lang], `missing table for ${lang}`);
});

test("vi and en define exactly the same keys", () => {
  const en = Object.keys(STRINGS.en).sort();
  const vi = Object.keys(STRINGS.vi).sort();
  assert.deepEqual(vi, en, `vi-only: ${vi.filter((k) => !en.includes(k))} / en-only: ${en.filter((k) => !vi.includes(k))}`);
});

test("no string is left empty in either language", () => {
  for (const lang of LANGS) {
    for (const [key, value] of Object.entries(STRINGS[lang])) {
      assert.equal(typeof value, "string", `${lang}.${key} is not a string`);
      assert.ok(value.trim().length > 0, `${lang}.${key} is empty`);
    }
  }
});

test("translations use the same placeholders as the english source", () => {
  const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort();
  for (const key of Object.keys(STRINGS.en)) {
    assert.deepEqual(
      placeholders(STRINGS.vi[key]),
      placeholders(STRINGS.en[key]),
      `placeholder mismatch on "${key}"`
    );
  }
});

test("resolveLang honours an explicit choice over the browser locale", () => {
  assert.equal(resolveLang("vi", "en-US"), "vi");
  assert.equal(resolveLang("en", "vi-VN"), "en");
});

test("resolveLang follows the browser locale when set to auto", () => {
  assert.equal(resolveLang("auto", "vi-VN"), "vi");
  assert.equal(resolveLang("auto", "vi"), "vi");
  assert.equal(resolveLang("auto", "en-GB"), "en");
});

test("resolveLang falls back to english for unknown input", () => {
  assert.equal(resolveLang("auto", "fr-FR"), "en");
  assert.equal(resolveLang("auto", undefined), "en");
  assert.equal(resolveLang("klingon", "vi-VN"), "vi", "unknown setting is treated as auto");
});

test("t interpolates named variables", () => {
  const out = t("en", "statusSearching", { current: 3, total: 30 });
  assert.ok(out.includes("3") && out.includes("30"), out);
  assert.ok(!out.includes("{"), `unreplaced placeholder in: ${out}`);
});

test("t interpolates the vietnamese table too", () => {
  const out = t("vi", "statusSearching", { current: 3, total: 30 });
  assert.ok(out.includes("3") && out.includes("30"), out);
  assert.ok(!out.includes("{"), `unreplaced placeholder in: ${out}`);
});

test("t returns the key itself when a string is missing", () => {
  assert.equal(t("en", "nope__missing"), "nope__missing");
});
