// ABOUTME: Checks that manifest.json pins the extension ID with a public key,
// ABOUTME: and that the bot allows exactly that ID as its CORS origin.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// Chromium: ID = first 32 hex chars of sha256(public key DER), mapped 0-f -> a-p.
function extensionId(base64Key) {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex");
  return [...hex.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

test("manifest pins the extension ID with a key", () => {
  const { key } = JSON.parse(read("manifest.json"));
  assert.equal(typeof key, "string", "manifest.json needs a \"key\"");
  assert.match(extensionId(key), /^[a-p]{32}$/);
});

for (const file of ["netsky/compose.override.yaml", "Microsoft-Rewards-Script/compose.override.yaml"]) {
  test(`${file} allows the pinned extension ID`, () => {
    const { key } = JSON.parse(read("manifest.json"));
    const origin = read(file).match(/API_CORS_ORIGIN:\s*\x27([^\x27]+)\x27/)?.[1];
    assert.equal(origin, `chrome-extension://${extensionId(key ?? "")}`);
  });
}
