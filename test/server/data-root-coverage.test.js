/**
 * Every root discovery scans is a root the server watches (fact dyr).
 *
 * These two lists drifted apart once before for cursor, and again for the two
 * tracequest-owned import roots: cursor-cloud and the ssh-imported hosts tree.
 * A scanned-but-unwatched root means an imported session is real on disk and
 * invisible in the dashboard until something unrelated invalidates the cache.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { defaultDataRoots } from "../../src/server/server-live-reload.js";
import {
  resolveCursorCloudRoot,
  resolveHostsRoot,
  resolveOpenCodeDbPath,
} from "../../src/sessions/session-discovery-paths.js";

/** discoveryRoots() reads $HOME at call time, so import it under the temp home. */
async function discoveryRootsFor(home) {
  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const mod = await import(
      new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url).href
    );
    return mod.discoveryRoots();
  } finally {
    process.env.HOME = originalHome;
  }
}

/** A root is covered when it is watched directly or sits under a watched tree. */
function isCovered(root, watched) {
  return watched.some((w) => root === w || root.startsWith(w + path.sep));
}

describe("watched data roots cover discovery roots", () => {
  test("every discovery root is watched, with the opencode db watched as a file", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-rootcover-"));
    try {
      const roots = await discoveryRootsFor(home);
      const watched = defaultDataRoots(home);
      const dbPath = resolveOpenCodeDbPath(home);

      const uncovered = roots.filter((r) => r !== dbPath && !isCovered(r, watched));
      assert.deepEqual(uncovered, [], `these discovery roots raise no fs events: ${uncovered.join(", ")}`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test("the cursor-cloud import root is watched", () => {
    const home = "/tmp/tq-fake-home";
    assert.ok(
      isCovered(resolveCursorCloudRoot(home), defaultDataRoots(home)),
      "cursor-cloud imports must raise data-update ticks",
    );
  });

  test("an ssh-imported host tree is watched, including hosts imported after startup", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-rootcover-host-"));
    try {
      // The host directory is created by a LATER import, so covering it means
      // watching the hosts root itself rather than the hosts present at boot.
      const watched = defaultDataRoots(home);
      const hostHome = path.join(resolveHostsRoot(home), "laterhost");
      fs.mkdirSync(path.join(hostHome, ".claude", "projects", "p"), { recursive: true });

      const roots = await discoveryRootsFor(home);
      const hostRoots = roots.filter((r) => r.startsWith(resolveHostsRoot(home)));
      assert.ok(hostRoots.length > 0, "the imported host contributes discovery roots");
      for (const r of hostRoots) {
        assert.ok(isCovered(r, watched), `imported host root not watched: ${r}`);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
