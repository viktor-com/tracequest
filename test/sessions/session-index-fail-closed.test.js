/**
 * JS half of the unknown-source fail-closed contract (Rust twin: fact z9k).
 *
 * `indexSession` used to dispatch every unrecognised `source` through a catch-all
 * `indexClaudeJsonl(session.path)` fallback. For a source whose `path` is not a
 * Claude JSONL file that produces an all-zero metadata entry which `buildIndex`
 * then persists into index.json with the discovery row's mtime — so the
 * mtime-equality incremental check never re-indexes it. Silent, sticky corruption.
 *
 * The sidecar now fails closed on the same input (exit 2), and `runSidecar`
 * discards sidecar output on a non-zero exit and falls back to this JS indexer
 * (fact 5dl), so this is the live corruption path.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  indexSession,
  KNOWN_SESSION_SOURCES,
  UnknownSessionSourceError,
} from "../../src/sessions/session-index-core.js";
import {
  indexClaudeJsonl,
  indexCodexJsonl,
  indexCursorJsonl,
  indexCursorCloudJsonl,
  indexFactoryJsonl,
  indexGrokJsonl,
} from "../../src/sessions/session-index-jsonl.js";
import { sessionListChecksum } from "../../src/sessions/session-list.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

// Clearly-fake canary: "cursor-cloud" was the canary until it became a real source (fact cccn).
const UNKNOWN_SOURCE = "no-such-source";

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

/** A claude-shaped JSONL file, so a catch-all fallback would "succeed" on it. */
function writeClaudeShaped(dir, name, text) {
  const filePath = path.join(dir, name);
  writeJsonl(filePath, [
    { type: "user", message: { content: text }, timestamp: "2026-05-01T00:00:00Z" },
  ]);
  return filePath;
}

/**
 * Isolated HOME + a private index-writers instance wired to the REAL indexSession,
 * optionally behind a mock sidecar binary.
 */
async function withIndexHarness({ sidecarScript = null, parallelThreshold = null } = {}, fn) {
  const tmpDir = mkTmp("tq-failclosed-");
  const cacheDir = path.join(tmpDir, ".cache", "tracequest");
  fs.mkdirSync(cacheDir, { recursive: true });

  const envHome = saveEnv("HOME");
  const envNoSidecar = saveEnv("TRACEQUEST_NO_SIDECAR");
  const envSidecarPath = saveEnv("TRACEQUEST_SIDECAR_PATH");
  const envThreshold = saveEnv("TRACEQUEST_TEST_PARALLEL_THRESHOLD");
  process.env.HOME = tmpDir;

  let binDir = null;
  if (sidecarScript) {
    binDir = mkTmp("tq-failclosed-sidecar-");
    const bin = path.join(binDir, "tracequest-sidecar");
    fs.writeFileSync(bin, sidecarScript, { mode: 0o755 });
    process.env.TRACEQUEST_SIDECAR_PATH = bin;
    delete process.env.TRACEQUEST_NO_SIDECAR;
  } else {
    delete process.env.TRACEQUEST_SIDECAR_PATH;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
  }
  if (parallelThreshold !== null) {
    process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD = String(parallelThreshold);
  } else {
    delete process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD;
  }

  const modUrl = new URL(
    `../../src/sessions/index-writers.js?${Date.now()}-${Math.random()}`,
    import.meta.url,
  );
  try {
    const iw = await import(modUrl.href);
    iw.initIndexWriters({ indexSession, sessionListChecksum });
    iw.resetIndexWritersForTests();
    return await fn({ tmpDir, cacheDir, indexPath: path.join(cacheDir, "index.json"), iw });
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
    if (binDir) fs.rmSync(binDir, { recursive: true, force: true });
  }
}

function readIndexJson(indexPath) {
  if (!fs.existsSync(indexPath)) return null;
  return JSON.parse(fs.readFileSync(indexPath, "utf8"));
}

/**
 * Run buildIndex over a batch containing `unknownPath` and assert BOTH halves of
 * the contract, persistence first so a regression reports the fabricated entry
 * rather than only "missing expected exception".
 */
function assertBatchRefused(iw, sessions, indexPath, unknownPath) {
  let thrown = null;
  try {
    iw.buildIndex(sessions);
  } catch (err) {
    thrown = err;
  }
  iw.flushDeferredIndexWriteForTests();
  const persisted = readIndexJson(indexPath);
  assert.equal(
    persisted?.[unknownPath],
    undefined,
    `unknown-source entry must never be persisted to index.json, got ${JSON.stringify(persisted?.[unknownPath])}`,
  );
  assert.ok(thrown, "buildIndex must abort the batch on an unrecognised source");
  assert.equal(
    thrown.name,
    "UnknownSessionSourceError",
    `expected UnknownSessionSourceError, got ${thrown.name}: ${thrown.message}`,
  );
  assert.equal(thrown.source, UNKNOWN_SOURCE);
  return thrown;
}

describe("session-index-core fail-closed on an unrecognised source", () => {
  test("indexSession throws UnknownSessionSourceError instead of guessing claude", () => {
    const tmpDir = mkTmp("tq-failclosed-throw-");
    try {
      const filePath = writeClaudeShaped(tmpDir, "s.jsonl", "unknown source must not index");
      const session = { path: filePath, source: UNKNOWN_SOURCE };
      assert.throws(
        () => indexSession(session),
        (err) => {
          assert.ok(
            err instanceof UnknownSessionSourceError,
            `expected UnknownSessionSourceError, got ${err?.name}: ${err?.message}`,
          );
          assert.equal(err.name, "UnknownSessionSourceError");
          assert.equal(err.source, UNKNOWN_SOURCE);
          assert.equal(err.path, filePath);
          assert.match(err.message, /no-such-source/);
          assert.match(err.message, /refus/i);
          return true;
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("indexSession never returns a fabricated entry for a non-existent unknown-source path", () => {
    // The observed corruption: a virtual path that is not readable at all still
    // produced an all-zero IndexEntry via the claude fallback.
    const session = { path: "no-such://bc-abc123", source: UNKNOWN_SOURCE };
    let returned;
    let threw = false;
    try {
      returned = indexSession(session);
    } catch (err) {
      threw = true;
      assert.equal(err.name, "UnknownSessionSourceError");
    }
    assert.ok(
      threw,
      `indexSession must fail closed; it returned ${JSON.stringify(returned)}`,
    );
  });

  test("KNOWN_SESSION_SOURCES is exactly the seven supported sources", () => {
    assert.deepEqual(
      [...KNOWN_SESSION_SOURCES].sort(),
      ["claude", "codex", "cursor", "cursor-cloud", "factory", "grok", "opencode"],
    );
  });

  // ---- positive controls: must pass BEFORE and AFTER the fix ----

  test("control: every file-backed known source still indexes exactly as its own indexer", () => {
    const tmpDir = mkTmp("tq-failclosed-known-");
    try {
      const claudePath = writeClaudeShaped(tmpDir, "claude.jsonl", "claude control needle");
      const cursorPath = path.join(tmpDir, "cursor.jsonl");
      writeJsonl(cursorPath, [
        { role: "user", message: { content: [{ type: "text", text: "cursor control needle" }] } },
      ]);
      const cursorCloudPath = path.join(tmpDir, "bc-control.jsonl");
      writeJsonl(cursorCloudPath, [
        { type: "session_meta", bcId: "bc-control", name: "Control", status: "FINISHED", createdAt: "2026-05-01T00:00:00Z" },
        { role: "user", message: { content: [{ type: "text", text: "cursor-cloud control needle" }] } },
      ]);
      const codexPath = path.join(tmpDir, "rollout.jsonl");
      writeJsonl(codexPath, [
        { type: "session_meta", payload: { model_provider: "openai-codex" } },
        { type: "event_msg", payload: { type: "user_message", message: "codex control needle" } },
      ]);
      const factoryPath = path.join(tmpDir, "factory.jsonl");
      writeJsonl(factoryPath, [
        {
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "factory control needle" }] },
          timestamp: "2026-05-01T00:00:00Z",
        },
      ]);
      const grokDir = path.join(tmpDir, "grok-sess");
      fs.mkdirSync(grokDir, { recursive: true });
      writeJsonl(path.join(grokDir, "chat_history.jsonl"), [
        { type: "user", content: "grok control needle" },
      ]);
      writeJsonl(path.join(grokDir, "events.jsonl"), [
        { type: "turn_started", ts: "2026-05-01T00:00:00Z", model_id: "grok-3" },
      ]);

      assert.deepEqual(indexSession({ path: claudePath, source: "claude" }), indexClaudeJsonl(claudePath));
      assert.deepEqual(indexSession({ path: cursorPath, source: "cursor" }), indexCursorJsonl(cursorPath));
      assert.deepEqual(
        indexSession({ path: cursorCloudPath, source: "cursor-cloud" }),
        indexCursorCloudJsonl(cursorCloudPath),
      );
      assert.deepEqual(indexSession({ path: codexPath, source: "codex" }), indexCodexJsonl(codexPath));
      assert.deepEqual(indexSession({ path: factoryPath, source: "factory" }), indexFactoryJsonl(factoryPath));
      assert.deepEqual(indexSession({ path: grokDir, source: "grok" }), indexGrokJsonl(grokDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("control: a session with no source at all still defaults to the claude indexer", () => {
    const tmpDir = mkTmp("tq-failclosed-default-");
    try {
      const filePath = writeClaudeShaped(tmpDir, "nosource.jsonl", "default claude control");
      assert.deepEqual(indexSession({ path: filePath }), indexClaudeJsonl(filePath));
      assert.deepEqual(indexSession({ path: filePath, source: "" }), indexClaudeJsonl(filePath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("buildIndex fail-closed on an unrecognised source", () => {
  test("buildIndex aborts the batch and writes no index.json entry (JS indexer path)", async () => {
    await withIndexHarness({}, async ({ tmpDir, indexPath, iw }) => {
      const goodPath = writeClaudeShaped(tmpDir, "good.jsonl", "good claude session");
      const sessions = [
        { path: goodPath, project: "p", file: "good.jsonl", source: "claude", size: 10, mtime: new Date(1_700_000_000_000) },
        { path: "no-such://bc-abc123", project: "p", file: "bc-abc123", source: UNKNOWN_SOURCE, size: 10, mtime: new Date(1_750_000_000_000) },
      ];

      assertBatchRefused(iw, sessions, indexPath, "no-such://bc-abc123");
    });
  });

  test("buildIndex surfaces the unknown source as a thrown error on the parallel worker path", async () => {
    await withIndexHarness({ parallelThreshold: 0 }, async ({ tmpDir, indexPath, iw }) => {
      const goodPath = writeClaudeShaped(tmpDir, "good-par.jsonl", "parallel good session");
      const sessions = [
        { path: goodPath, project: "p", file: "good-par.jsonl", source: "claude", size: 4096, mtime: new Date(1_700_000_000_000) },
        { path: "no-such://bc-par", project: "p", file: "bc-par", source: UNKNOWN_SOURCE, size: 4096, mtime: new Date(1_750_000_000_000) },
      ];

      assertBatchRefused(iw, sessions, indexPath, "no-such://bc-par");
    });
  });

  test("control: buildIndex still indexes and persists a batch of known sources", async () => {
    await withIndexHarness({}, async ({ tmpDir, indexPath, iw }) => {
      const goodPath = writeClaudeShaped(tmpDir, "only-good.jsonl", "control persists needle");
      const sessions = [
        { path: goodPath, project: "p", file: "only-good.jsonl", source: "claude", size: 10, mtime: new Date(1_700_000_000_000) },
      ];
      const result = iw.buildIndex(sessions);
      assert.equal(result.size, 1);
      assert.ok(result.get(goodPath));
      iw.flushDeferredIndexWriteForTests();
      const persisted = readIndexJson(indexPath);
      assert.ok(persisted, "index.json must be written for a known-source batch");
      assert.ok(persisted[goodPath], `expected an entry for ${goodPath}, got ${JSON.stringify(persisted)}`);
    });
  });
});

// The real-world route: the sidecar now fails closed too (exit 2), and runSidecar
// discards its output on a non-zero exit and falls back to the JS indexer (5dl).
const SIDECAR_INDEX_FAILS_CLOSED = `#!/usr/bin/env node
if (process.argv[2] === "index") {
  console.error('Error: unrecognised session source "no-such-source" for no-such://bc-sidecar - refusing to index');
  process.exit(2);
}
process.exit(1);
`;

describe("sidecar index failure -> JS fallback keeps failing closed", () => {
  test("unknown source: sidecar exits non-zero, JS fallback refuses and persists nothing", async () => {
    await withIndexHarness({ sidecarScript: SIDECAR_INDEX_FAILS_CLOSED }, async ({ tmpDir, indexPath, iw }) => {
      const goodPath = writeClaudeShaped(tmpDir, "sc-good.jsonl", "sidecar fallback good");
      const sessions = [
        { path: goodPath, project: "p", file: "sc-good.jsonl", source: "claude", size: 10, mtime: new Date(1_700_000_000_000) },
        { path: "no-such://bc-sidecar", project: "p", file: "bc-sidecar", source: UNKNOWN_SOURCE, size: 10, mtime: new Date(1_750_000_000_000) },
      ];

      assertBatchRefused(iw, sessions, indexPath, "no-such://bc-sidecar");
    });
  });

  test("control: known sources still index via the JS fallback when the sidecar exits non-zero", async () => {
    await withIndexHarness({ sidecarScript: SIDECAR_INDEX_FAILS_CLOSED }, async ({ tmpDir, indexPath, iw }) => {
      const goodPath = writeClaudeShaped(tmpDir, "sc-only-good.jsonl", "sidecar fallback control");
      const sessions = [
        { path: goodPath, project: "p", file: "sc-only-good.jsonl", source: "claude", size: 10, mtime: new Date(1_700_000_000_000) },
      ];
      const result = iw.buildIndex(sessions);
      assert.equal(result.size, 1);
      iw.flushDeferredIndexWriteForTests();
      const persisted = readIndexJson(indexPath);
      assert.ok(persisted?.[goodPath], `expected JS-fallback entry for ${goodPath}, got ${JSON.stringify(persisted)}`);
    });
  });
});
