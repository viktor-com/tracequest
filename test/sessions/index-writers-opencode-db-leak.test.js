/**
 * Resource-safety half of the unknown-source fail-closed contract (facts 80i, z9k).
 *
 * `buildIndex`'s serial indexing loop opens a read-only OpenCode SQLite handle
 * lazily and closed it *after* the loop. That was safe only while `_indexSession`
 * could never throw. Failing closed on an unrecognised source made the loop
 * throw, so a batch shaped [opencode session, unknown-source session] skipped
 * `opencodeDb.db.close()` entirely and leaked the handle — once per call, in a
 * long-lived `tracequest serve` process where every /api/sessions request can
 * retry the same failing batch.
 *
 * The close now runs in a `finally`, matching `withOpenCodeDb`'s existing
 * convention (src/sessions/session-discovery-paths.js:43).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { indexSession } from "../../src/sessions/session-index-core.js";
import { sessionListChecksum } from "../../src/sessions/session-list.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";

// Clearly-fake canary: "cursor-cloud" was the canary until it became a real source (fact cccn).
const UNKNOWN_SOURCE = "no-such-source";
const OPENCODE_SESSION_ID = "leak-oc-1";

/** Directory listing every fd this process holds open. */
const FD_DIR = process.platform === "darwin" ? "/dev/fd" : "/proc/self/fd";

function openFdCount() {
  return fs.readdirSync(FD_DIR).length;
}

function saveEnv(key) {
  const had = Object.hasOwn(process.env, key);
  const prev = process.env[key];
  return {
    restore() {
      if (had) process.env[key] = prev;
      else delete process.env[key];
    },
  };
}

describe("buildIndex closes the OpenCode db when the batch fails closed", () => {
  test("a leaked read-only SQLite handle does not accumulate across refused batches", async (t) => {
    if (!fs.existsSync(FD_DIR)) {
      t.skip(`no fd directory at ${FD_DIR} on ${process.platform}`);
      return;
    }

    const tmpDir = mkTmp("tq-ocleak-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });

    const envHome = saveEnv("HOME");
    const envNoSidecar = saveEnv("TRACEQUEST_NO_SIDECAR");
    const envSidecarPath = saveEnv("TRACEQUEST_SIDECAR_PATH");
    const envThreshold = saveEnv("TRACEQUEST_TEST_PARALLEL_THRESHOLD");
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    delete process.env.TRACEQUEST_SIDECAR_PATH;
    // Force the serial branch; the parallel branch has no OpenCode handle.
    process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD = "1000";

    // A real OpenCode db under the isolated HOME so the serial loop truly opens it.
    const seeded = await seedOpenCodeIndexDb(tmpDir, [
      {
        id: OPENCODE_SESSION_ID,
        title: "leak fixture",
        messages: [{ role: "user", parts: [{ type: "text", text: "hello opencode" }] }],
      },
    ]);
    seeded.db?.close?.();

    // A claude-shaped file, so a catch-all fallback would have "succeeded" on it.
    const unknownPath = path.join(tmpDir, "unknown.jsonl");
    writeJsonl(unknownPath, [
      { type: "user", message: { content: "unknown source" }, timestamp: "2026-05-01T00:00:00Z" },
    ]);

    // Order matters: the OpenCode row must open the db BEFORE the unknown row throws.
    const sessions = [
      {
        path: `opencode://${OPENCODE_SESSION_ID}`,
        project: "ocproj",
        file: OPENCODE_SESSION_ID,
        size: 1024,
        mtime: new Date(1_715_731_205_000),
        source: "opencode",
        title: "leak fixture",
      },
      {
        path: unknownPath,
        project: "unknown",
        file: "unknown.jsonl",
        size: 128,
        mtime: new Date(1_715_731_206_000),
        source: UNKNOWN_SOURCE,
      },
    ];

    const modUrl = new URL(
      `../../src/sessions/index-writers.js?${Date.now()}-${Math.random()}`,
      import.meta.url,
    );
    try {
      const iw = await import(modUrl.href);
      iw.initIndexWriters({ indexSession, sessionListChecksum });
      iw.resetIndexWritersForTests();

      const refuseOnce = () => {
        // Each call must re-index: reset clears the mtime/result caches so the
        // serial loop (and the db open) runs again rather than short-circuiting.
        iw.resetIndexWritersForTests();
        let thrown = null;
        try {
          iw.buildIndex(sessions);
        } catch (err) {
          thrown = err;
        }
        assert.ok(thrown, "buildIndex must abort the batch on an unrecognised source");
        assert.equal(
          thrown.name,
          "UnknownSessionSourceError",
          `expected UnknownSessionSourceError, got ${thrown.name}: ${thrown.message}`,
        );
      };

      // Warm up so first-call lazy allocations (module init, search index load)
      // are not counted as the leak.
      refuseOnce();
      refuseOnce();

      const before = openFdCount();
      const ITERATIONS = 12;
      for (let i = 0; i < ITERATIONS; i++) refuseOnce();
      const after = openFdCount();

      const growth = after - before;
      assert.ok(
        growth < ITERATIONS / 2,
        `buildIndex leaked an OpenCode SQLite handle per refused batch: ` +
          `${ITERATIONS} refused batches grew open fds by ${growth} ` +
          `(${before} -> ${after}); expected no per-batch growth`,
      );
    } finally {
      try {
        const iw = await import(modUrl.href);
        iw.resetIndexWritersForTests();
      } catch {
        /* import failed; nothing to reset */
      }
      envHome.restore();
      envNoSidecar.restore();
      envSidecarPath.restore();
      envThreshold.restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
