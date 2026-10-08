import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeFetchError, percentToFraction, toIso } from "../../src/usage/http.js";

test("sanitize fetch errors strip Bearer tokens", () => {
  const err = new Error("GET failed Authorization: Bearer super-secret-token-value");
  const msg = sanitizeFetchError(err, "https://example.test/usage");
  assert.doesNotMatch(msg, /super-secret-token-value/);
  assert.match(msg, /\[redacted\]/);
});

test("percentToFraction and toIso", () => {
  assert.equal(percentToFraction(25), 0.25);
  assert.equal(toIso("2026-09-20T21:00:00.000Z"), "2026-09-20T21:00:00.000Z");
  assert.equal(toIso(1789938000), new Date(1789938000 * 1000).toISOString());
});
