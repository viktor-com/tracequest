import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, REDACTED } from "../../src/insights/redact.js";

test("redactText removes secret-shaped values and keeps the rest readable", () => {
  const cases = [
    ["export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234 && run", "sk-proj-abcdefghijklmnopqrstuvwx1234"],
    ['curl -H "Authorization: Bearer abcdefghijklmnop1234567890" https://x', "abcdefghijklmnop1234567890"],
    ["postgres://admin:hunter2secret@db.internal:5432/x", "hunter2secret"],
    ['{"password": "correcthorsebattery"}', "correcthorsebattery"],
    ['NEON_API_KEY: \\"napi_abcdefgh12345678\\"', "napi_abcdefgh12345678"],
    ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----", "b3BlbnNzaC1rZXk"],
  ];
  for (const [text, secret] of cases) {
    const out = redactText(text);
    assert.ok(!out.includes(secret), `secret survived in: ${out}`);
    assert.ok(out.includes(REDACTED), out);
  }
  assert.match(redactText("postgres://admin:hunter2secret@db.internal:5432/x"), /^postgres:\/\/admin:\[REDACTED\]@db\.internal/);
});

test("redactText leaves ordinary text and page scripts untouched", () => {
  const plain = [
    "plain text about tokens, passwords and api keys",
    "var tokenCount=fmtTokens(row.totalTokens); const TOKEN_RE = /abc/;",
    '<a class="ins-example" href="/view?path=%2Fhome%2Fu%2F.claude%2Fprojects%2Fx.jsonl&source=claude">',
    "Exit code 1\ncat: /nope: No such file or directory",
  ];
  for (const text of plain) assert.equal(redactText(text), text);
  assert.equal(redactText(""), "");
  assert.equal(redactText(null), null);
});
