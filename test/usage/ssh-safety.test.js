import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SSH_IMPORT_SOURCES } from "../../src/import/ssh-import.js";

test("SSH_IMPORT_SOURCES stays session trees", () => {
  const ids = SSH_IMPORT_SOURCES.map((s) => s.id);
  assert.deepEqual(ids, ["claude", "cursor", "codex", "factory", "grok", "opencode"]);
  const blob = JSON.stringify(SSH_IMPORT_SOURCES);
  assert.doesNotMatch(blob, /credentials\.json/);
  assert.doesNotMatch(blob, /auth\.json/);
  assert.doesNotMatch(blob, /state\.vscdb/);
  const src = readFileSync(new URL("../../src/import/ssh-import.js", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("SSH_IMPORT_SOURCES"), src.indexOf(";", src.indexOf("SSH_IMPORT_SOURCES")));
  assert.doesNotMatch(block, /credentials\.json|auth\.json|state\.vscdb/);
});
