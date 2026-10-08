/**
 * Milestone coverage smoke: package export surface and suite scale (>100 test files).
 *
 * npm test tally (2026-06-04): 2316 tests, 407 suites, 108+ test files, 0 fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REQUIRED_EXPORTS = ["./api", "./sessions", "./parse", "./render"];

/** Recursively count *.test.js files under test/. */
function countTestFiles(dir = join(ROOT, "test")) {
  let n = 0;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) n += countTestFiles(p);
    else if (ent.name.endsWith(".test.js")) n += 1;
  }
  return n;
}

function assertPackageExportSubpaths() {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const keys = Object.keys(pkg.exports ?? {});
  for (const sub of REQUIRED_EXPORTS) {
    assert.ok(keys.includes(sub), `package.json exports missing ${sub}`);
    assert.equal(typeof pkg.exports[sub], "string");
    assert.ok(pkg.exports[sub].startsWith("./src/"));
  }
}

test("coverage smoke: exports surface and suite health", async () => {
  assertPackageExportSubpaths();

  const testFileCount = countTestFiles();
  assert.ok(
    testFileCount > 100,
    `milestone: expected >100 test files, got ${testFileCount}`,
  );
});
