import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readRoot(rel) {
  return readFileSync(join(ROOT, rel), "utf-8");
}

/** Lowest node version the package claims to support, as [major, minor]. */
function enginesFloor() {
  const range = JSON.parse(readRoot("package.json")).engines?.node;
  assert.ok(range, "package.json must declare engines.node");
  const m = range.match(/(\d+)\.(\d+)/);
  assert.ok(m, `engines.node must pin a concrete floor, got ${range}`);
  return [Number(m[1]), Number(m[2])];
}

/** Node major versions each CI/release workflow runs on. */
function workflowMajors() {
  const out = [];
  for (const wf of ["ci.yml", "release.yml"]) {
    const rel = join(".github", "workflows", wf);
    if (!existsSync(join(ROOT, rel))) continue;
    for (const m of readRoot(rel).matchAll(/node-version:\s*['"]?(\d+)/g)) {
      out.push({ workflow: wf, major: Number(m[1]) });
    }
  }
  return out;
}

describe("node engine contract", () => {
  test("the supported node version is declared in version control", () => {
    const [major, minor] = enginesFloor();
    assert.ok(major >= 22 || (major === 22 && minor >= 5), `engines.node floor should be >= 22.5, got ${major}.${minor}`);
    assert.ok(existsSync(join(ROOT, ".nvmrc")), ".nvmrc must exist so contributors get the right runtime");
  });

  test(".nvmrc matches the engines floor", () => {
    const [major] = enginesFloor();
    const nvmrc = Number(readRoot(".nvmrc").trim().replace(/^v/, "").split(".")[0]);
    assert.equal(nvmrc, major, `.nvmrc (${nvmrc}) must match the engines.node major (${major})`);
  });

  test("every CI and release workflow runs at or above the engines floor", () => {
    const [major] = enginesFloor();
    const majors = workflowMajors();
    assert.ok(majors.length > 0, "expected at least one workflow to pin node-version");
    for (const { workflow, major: wfMajor } of majors) {
      assert.ok(
        wfMajor >= major,
        `${workflow} runs node ${wfMajor} but package.json requires >= ${major} — CI would not exercise the supported runtime`,
      );
    }
  });

  test("the engines floor is high enough that recursive fs.watch always exists", () => {
    // src/server/fs-watch.js has no non-recursive fallback: recursive watching is
    // assumed. It landed on linux in node 20.13. If this floor ever drops below
    // that, live-reload dies silently on linux and the fallback must come back.
    const [major, minor] = enginesFloor();
    const ok = major > 20 || (major === 20 && minor >= 13);
    assert.ok(ok, `engines.node floor ${major}.${minor} is below 20.13 — restore the fs-watch fallback`);
    assert.doesNotMatch(
      readRoot("src/server/fs-watch.js"),
      /watchTreeFallback/,
      "fallback removal and the engines floor must stay consistent",
    );
  });

  test("the running interpreter satisfies the declared floor", () => {
    const [major, minor] = enginesFloor();
    const [runMajor, runMinor] = process.versions.node.split(".").map(Number);
    assert.ok(
      runMajor > major || (runMajor === major && runMinor >= minor),
      `tests are running on node ${process.versions.node}, below the declared floor ${major}.${minor}`,
    );
  });
});
