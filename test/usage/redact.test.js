import { test } from "node:test";
import assert from "node:assert/strict";
import { assertNoSecrets, collectSecrets, looksLikeSecretBlob, redactSecrets } from "../../src/usage/redact.js";

test("assertNoSecrets rejects leaked tokens", () => {
  const secrets = collectSecrets(["sk-ant-secret-token-value"]);
  assert.throws(() => assertNoSecrets("got sk-ant-secret-token-value", secrets));
  assert.equal(assertNoSecrets("ok default_claude_max_20x", secrets), true);
});

test("redactSecrets strips loaded secrets", () => {
  assert.equal(redactSecrets("Bearer abcdefghij", ["abcdefghij"]), "Bearer [redacted]");
});

test("looksLikeSecretBlob catches JWT and sk- prefixes", () => {
  assert.equal(looksLikeSecretBlob("plan default_claude_max_20x"), false);
  assert.equal(looksLikeSecretBlob("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaabbbbcc.signaturexx"), true);
  assert.equal(looksLikeSecretBlob("sk-ant-api03-abcdefgh"), true);
});
