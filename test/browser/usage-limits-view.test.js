import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("view HTML omits usage limits", () => {
  for (const rel of [
    "src/render/render-core-shell.js",
    "src/render/render-core.js",
    "src/render/render-assemble.js",
    "src/render/render-main.js",
  ]) {
    const src = readFileSync(join(ROOT, rel), "utf8");
    assert.doesNotMatch(src, /appLimits/);
    assert.doesNotMatch(src, /\/api\/usage-limits/);
  }
});
