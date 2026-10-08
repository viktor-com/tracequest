import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("security reporting and author metadata use public repository identity", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const owner = pkg.repository.url.match(/github\.com\/([^/]+)\//)[1];
  assert.equal(pkg.author, owner);
  const policy = readFileSync(new URL("../SECURITY.md", import.meta.url), "utf8");
  assert.match(policy, /security\/advisories\/new/);
  assert.doesNotMatch(policy, /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/i);
});
