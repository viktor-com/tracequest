/**
 * Pipeline perf at realistic scale (few-thousand sessions) without 32k-file blowups.
 *
 * - Scale corpus: one shared ~3000-session Claude project, fixture written once per
 *   process, single cold buildIndex reused across tests.
 * - Uses default parallel indexing (same as production). Note: spawning Workers from a
 *   parent started with `node --input-type=module -e` breaks child module load.
 * - Multi-source block stays small (8 rows across 7 sources) for cross-source latency.
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { searchSessions } from "../../src/sessions/scan-queries.js";
import { resetIndexWritersForTests } from "../../src/sessions/index-writers.js";
import {
  searchIdxPath,
  flushSearchIdxWriteForTests,
} from "../../src/sessions/search-index.js";
import { claudeProj, mkTmp } from "../helpers/fixtures.js";
import {
  seedMultiSourceFixture,
  seedOpenCodeDb,
  SHARED_QUERY,
  FACTORY_DISK_ONLY,
} from "../helpers/multi-source-fixtures.js";
import { writeSyntheticClaudeSessions } from "../helpers/synthetic-sessions.js";
import { assertPerf } from "../helpers/perf-assert.js";

/** Realistic scale — few thousand sessions, not tens of thousands of files per run. */
export const SCALE_SESSION_COUNT = 3000;
const FILLER_LINES = 8;
const MULTI_SOURCE_SESSION_COUNT = 8;

/** Shared across tests in this file; avoids rewriting 3000 JSONL files per test. */
let scaleFixture = null;
/** Shared multi-source corpus; avoids re-seeding SQLite + buildIndex per test. */
let multiSourceFixture = null;

function avgMsPerOp(fn, iters) {
  for (let w = 0; w < 2; w++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return (performance.now() - t0) / iters;
}

async function ensureScaleFixture() {
  if (scaleFixture) return scaleFixture;

  const tmpDir = mkTmp("tq-pipe-perf-scale-");
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  const projDir = claudeProj(tmpDir, "scaleperf");
  const tWrite = performance.now();
  const { sessions, markerByPath } = writeSyntheticClaudeSessions(projDir, {
    sessionCount: SCALE_SESSION_COUNT,
    fillerLines: FILLER_LINES,
  });
  const writeMs = performance.now() - tWrite;

  resetIndexWritersForTests();
  const { buildIndex } = await import("../../src/sessions.js");
  const tBuild = performance.now();
  const index = buildIndex(sessions);
  const coldBuildMs = performance.now() - tBuild;

  scaleFixture = {
    tmpDir,
    sessions,
    markerByPath,
    index,
    buildIndex,
    writeMs,
    coldBuildMs,
    restoreEnv: () => {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    },
  };
  return scaleFixture;
}

async function ensureMultiSourceFixture() {
  if (multiSourceFixture) return multiSourceFixture;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pipe-perf-ms-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  seedMultiSourceFixture(tmpDir);
  await seedOpenCodeDb(tmpDir, "msrc-oc-1", `opencode side ${SHARED_QUERY}`);

  resetIndexWritersForTests();
  const { findSessions, buildIndex } = await import("../../src/sessions.js");
  const sessions = findSessions(null);
  const t0 = performance.now();
  const index = buildIndex(sessions);
  const buildMs = performance.now() - t0;

  multiSourceFixture = {
    tmpDir,
    sessions,
    index,
    buildIndex,
    buildMs,
    restoreEnv: () => {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    },
  };
  return multiSourceFixture;
}

describe("index+search pipeline perf (multi-source)", () => {
  after(() => {
    if (multiSourceFixture?.tmpDir) {
      multiSourceFixture.restoreEnv?.();
      fs.rmSync(multiSourceFixture.tmpDir, { recursive: true, force: true });
      multiSourceFixture = null;
    }
  });

  test("buildIndex indexes 8 multi-source rows under 400ms", async () => {
    const fx = await ensureMultiSourceFixture();
    assert.equal(fx.sessions.length, MULTI_SOURCE_SESSION_COUNT);
    assertPerf(
      fx.buildMs < 400,
      `expected buildIndex under 400ms for ${MULTI_SOURCE_SESSION_COUNT} multi-source rows, got ${fx.buildMs.toFixed(1)}ms`,
    );
  });

  test("searchSessions shared needle under 8ms/op on multi-source index", async () => {
    const fx = await ensureMultiSourceFixture();
    const ms = avgMsPerOp(
      () => {
        const hits = searchSessions(fx.sessions, fx.index, SHARED_QUERY, 50);
        assert.equal(hits.length, MULTI_SOURCE_SESSION_COUNT);
      },
      20,
    );
    assertPerf(
      ms < 8,
      `expected searchSessions under 8ms/op on ${MULTI_SOURCE_SESSION_COUNT}-row index, got ${ms.toFixed(2)}ms`,
    );
  });

  test("BM25 multi-source indexed-term search under 10ms/op", async () => {
    // FACTORY_DISK_ONLY is in tool_use.input.command (not indexed by factory indexer).
    // Test BM25 speed on the shared query (which IS indexed) instead.
    const fx = await ensureMultiSourceFixture();
    const ms = avgMsPerOp(
      () => {
        const hits = searchSessions(fx.sessions, fx.index, SHARED_QUERY, 50);
        assert.equal(hits.length, MULTI_SOURCE_SESSION_COUNT);
      },
      15,
    );
    assertPerf(
      ms < 10,
      `expected BM25 multi-source search under 10ms/op, got ${ms.toFixed(2)}ms`,
    );
  });
});

describe(`index+search pipeline perf (${SCALE_SESSION_COUNT}-session scale)`, () => {
  after(() => {
    if (scaleFixture?.tmpDir) {
      scaleFixture.restoreEnv?.();
      fs.rmSync(scaleFixture.tmpDir, { recursive: true, force: true });
      scaleFixture = null;
    }
  });

  test(`buildIndex cold indexes ${SCALE_SESSION_COUNT} sessions under 1200ms`, async () => {
    const fx = await ensureScaleFixture();
    assert.equal(fx.sessions.length, SCALE_SESSION_COUNT);
    assert.equal(fx.index.size, SCALE_SESSION_COUNT);
    assertPerf(
      fx.coldBuildMs < 1200,
      `expected cold buildIndex under 1200ms for ${SCALE_SESSION_COUNT} sessions, got ${fx.coldBuildMs.toFixed(1)}ms (fixture write ${fx.writeMs.toFixed(0)}ms)`,
    );
  });

  test(`warm buildIndex reuses result map under 5ms`, async () => {
    const fx = await ensureScaleFixture();
    const t0 = performance.now();
    const warm = fx.buildIndex(fx.sessions);
    const ms = performance.now() - t0;
    assert.equal(warm.size, SCALE_SESSION_COUNT);
    assertPerf(ms < 5, `expected warm buildIndex under 5ms, got ${ms.toFixed(2)}ms`);
    assert.strictEqual(warm.get(fx.sessions[0].path), fx.index.get(fx.sessions[0].path));
  });

  test(`searchSessions BM25 first-hit under 5ms/op on ${SCALE_SESSION_COUNT}-session index`, async () => {
    // Use a 2+ digit session index whose suffix tokenizes uniquely (e.g. session-11 → "11").
    // Sessions with single-digit indices drop the suffix (< 2 chars) so we pick session[11].
    const fx = await ensureScaleFixture();
    const targetIdx = 11; // "perfneedle-sess-11" → tokens: perfneedle, sess, 11 — unique
    const targetSession = fx.sessions[targetIdx];
    const needle = fx.markerByPath.get(targetSession.path).marker; // "perfneedle-sess-11"
    const ms = avgMsPerOp(
      () => {
        const hits = searchSessions(fx.sessions, fx.index, needle, 1);
        assert.ok(hits.length >= 1, "at least one BM25 hit");
        assert.equal(hits[0].path, targetSession.path, "top BM25 result matches unique session");
      },
      20,
    );
    assertPerf(ms < 5, `expected BM25 first-hit under 5ms/op, got ${ms.toFixed(2)}ms`);
  });

  test(`searchSessions mid-corpus hit under 200ms/op on ${SCALE_SESSION_COUNT}-session index`, async () => {
    const fx = await ensureScaleFixture();
    const mid = fx.sessions[Math.floor(SCALE_SESSION_COUNT / 2)];
    const needle = fx.markerByPath.get(mid.path).marker;
    // Fewer iters than first-hit: each op scans ~half the corpus (~120ms); 3 timed samples still stable vs 200ms cap.
    const ms = avgMsPerOp(
      () => {
        const hits = searchSessions(fx.sessions, fx.index, needle, 5);
        assert.ok(hits.some((h) => h.path === mid.path));
      },
      3,
    );
    assertPerf(
      ms < 200,
      `expected mid-corpus search under 200ms/op, got ${ms.toFixed(2)}ms`,
    );
  });

  test(`shared marker prefix search returns all ${SCALE_SESSION_COUNT} hits under 500ms`, async () => {
    const fx = await ensureScaleFixture();
    const prefix = "perfneedle-sess-";
    const t0 = performance.now();
    const hits = searchSessions(fx.sessions, fx.index, prefix, SCALE_SESSION_COUNT);
    const ms = performance.now() - t0;
    assert.equal(hits.length, SCALE_SESSION_COUNT);
    assertPerf(
      ms < 500,
      `expected full-corpus prefix search under 500ms, got ${ms.toFixed(1)}ms`,
    );
  });

  test(`recent-sorted handoff search returns only newest limited prefix hits under 80ms`, async () => {
    const fx = await ensureScaleFixture();
    const prefix = "perfneedle-sess-";
    const limit = 5;
    const expectedPaths = [...fx.sessions]
      .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime())
      .slice(0, limit)
      .map((s) => s.path);

    const t0 = performance.now();
    const hits = searchSessions(fx.sessions, fx.index, prefix, limit, {
      sort: "recent",
      phraseScanCap: fx.sessions.length,
    });
    const ms = performance.now() - t0;

    assert.deepEqual(hits.map((h) => h.path), expectedPaths);
    assertPerf(
      ms < 80,
      `expected recent-sorted handoff search under 80ms for ${SCALE_SESSION_COUNT} sessions, got ${ms.toFixed(1)}ms`,
    );
  });

  test(`search.idx smaller than total tokenizer-input bytes (fact 8jm)`, async () => {
    const fx = await ensureScaleFixture();
    // Flush search.idx to disk so we can measure it.
    flushSearchIdxWriteForTests();
    const idxSize = fs.statSync(searchIdxPath()).size;
    // Total tokenizer-input bytes = sum of session file sizes (the content the indexer reads).
    const totalInputBytes = fx.sessions.reduce((sum, s) => {
      try { return sum + fs.statSync(s.path).size; } catch { return sum; }
    }, 0);
    assert.ok(
      idxSize < totalInputBytes,
      `expected search.idx (${Math.round(idxSize / 1024)}KB) < total session bytes (${Math.round(totalInputBytes / 1024)}KB)`,
    );
  });
});
