import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { sessionListChecksum } from "../src/sessions/session-list.js";
import { INDEX_VERSION } from "../src/sessions/index-writers.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  SIDECAR_PATH_ENV,
  SIDECAR_SKIP_ENV,
  withMockSidecarScript,
} from "./helpers/sidecar-mock.js";
import { searchSessions } from "../src/sessions/scan-queries.js";
import {
  SearchIndex,
  getSearchIndex,
  loadSearchIndex,
  resetSearchIndexForTests,
} from "../src/sessions/search-index.js";
import { assertPerf } from "./helpers/perf-assert.js";

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
const INDEX_WRITE_DELAY_MS = 30_000;
const TWO_GB = 2 * 1024 * 1024 * 1024;
const MOCK_WORKER_OK = "../../test/fixtures/index-worker-mock-ok.mjs";
const MOCK_WORKER_ERR = "../../test/fixtures/index-worker-mock-err.mjs";
const MOCK_WORKER_PARTIAL = "../../test/fixtures/index-worker-mock-partial.mjs";

async function importIndexWriters() {
  const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function makeStaleSessions(count, base = "/tmp/tq-iw-parallel-") {
  return Array.from({ length: count }, (_, i) => ({
    path: `${base}${i}.jsonl`,
    mtime: new Date(1_000_000 + i),
    source: "claude",
    size: 1,
  }));
}

/**
 * Write a minimal search.idx to cacheDir containing the given session paths.
 * Required when index.json is pre-seeded so mtime-matched sessions are found
 * in the SearchIndex and not force-re-tokenized (fact msg).
 */
function writeWarmSearchIdx(cacheDir, sessionPaths) {
  const si = new SearchIndex();
  for (const p of sessionPaths) {
    si.upsert(p, new Map([["__warm__", 1]]));
  }
  fs.writeFileSync(path.join(cacheDir, "search.idx"), si.serialize());
}

function defaultCachedIndexEntry(mtime, overrides = {}) {
  return {
    mtime,
    firstPrompt: "cached",
    model: "claude-3",
    tools: [],
    toolCounts: {},
    chapters: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
    errors: 0,
    files: 0,
    commits: 0,
    ...overrides,
  };
}

/** Isolated HOME + index-writers module for buildIndex cache tests. */
async function withBuildIndexCacheHarness(
  { diskEntries = {}, indexSession, sessionListChecksum: checksumFn = sessionListChecksum } = {},
  fn
) {
  const tmpDir = fs.mkdtempSync("/tmp/index-writers-cache-");
  const cacheDir = path.join(tmpDir, ".cache", "tracequest");
  fs.mkdirSync(cacheDir, { recursive: true });
  const indexPath = path.join(cacheDir, "index.json");
  if (Object.keys(diskEntries).length > 0) {
    fs.writeFileSync(indexPath, JSON.stringify({ _v: INDEX_VERSION, ...diskEntries }));
  }

  const originalHome = process.env.HOME;
  const hadNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  const indexSessionCalls = { n: 0 };
  const indexSessionImpl =
    indexSession ??
    (() => {
      indexSessionCalls.n++;
      return { firstPrompt: "fresh-index" };
    });

  try {
    const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
    const {
      buildIndex,
      buildResultMapCacheKey,
      flushDeferredIndexWriteForTests,
      flushDeferredSearchIdxWriteForTests,
      initIndexWriters,
      resetIndexWritersForTests,
    } = await import(modUrl.href);

    initIndexWriters({
      indexSession: indexSessionImpl,
      sessionListChecksum: checksumFn,
    });
    resetIndexWritersForTests();

    // Write a matching search.idx so mtime-matched sessions are found in the SI and
    // not force-re-indexed (fact msg: re-tokenize only when absent from SI or when
    // an existing search.idx fails to load). Sessions in diskEntries are pre-warmed.
    if (Object.keys(diskEntries).length > 0) {
      const warmSI = new SearchIndex();
      for (const p of Object.keys(diskEntries)) {
        if (p !== "_v") warmSI.upsert(p, new Map([["__warm__", 1]]));
      }
      fs.writeFileSync(path.join(cacheDir, "search.idx"), warmSI.serialize());
    }

    await fn({
      tmpDir,
      indexPath,
      buildIndex,
      buildResultMapCacheKey,
      flushDeferredIndexWriteForTests,
      flushDeferredSearchIdxWriteForTests,
      resetIndexWritersForTests,
      indexSessionCalls,
    });
  } finally {
    process.env.HOME = originalHome;
    if (hadNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = hadNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function withParallelTestEnv(workerFixture, fn) {
  const prevWorker = process.env.TRACEQUEST_TEST_INDEX_WORKER;
  const prevThreshold = process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD;
  process.env.TRACEQUEST_TEST_INDEX_WORKER = workerFixture;
  process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD = "2";
  return fn().finally(() => {
    if (prevWorker === undefined) delete process.env.TRACEQUEST_TEST_INDEX_WORKER;
    else process.env.TRACEQUEST_TEST_INDEX_WORKER = prevWorker;
    if (prevThreshold === undefined) delete process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD;
    else process.env.TRACEQUEST_TEST_PARALLEL_THRESHOLD = prevThreshold;
  });
}

describe("index-writers buildIndex status logging", () => {
  const SESSION_PATH = "/tmp/index-status.jsonl";
  const MTIME = 1_700_000_000_000;

  function session(overrides = {}) {
    return {
      path: SESSION_PATH,
      mtime: new Date(MTIME),
      source: "claude",
      size: 1,
      ...overrides,
    };
  }

  function captureIndexStatusLogs(fn) {
    const logs = [];
    const origError = console.error;
    console.error = (...a) => logs.push(a.join(" "));
    return fn(logs).finally(() => {
      console.error = origError;
    });
  }

  test("logs building start and indexed end for stale sessions", async () => {
    await captureIndexStatusLogs(async (logs) => {
      await withBuildIndexCacheHarness({}, async ({ buildIndex }) => {
        buildIndex([session()]);
        assert.ok(logs.some((l) => /tracequest: building index for 1 session \(1 stale\)/.test(l)));
        assert.ok(logs.some((l) => /tracequest: indexed 1 session/.test(l)));
      });
    });
  });

  test("logs up to date when disk cache satisfies all sessions", async () => {
    await captureIndexStatusLogs(async (logs) => {
      await withBuildIndexCacheHarness(
        {
          diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) },
          indexSession: () => {
            throw new Error("indexSession must not run on disk cache hit");
          },
        },
        async ({ buildIndex }) => {
          buildIndex([session()]);
          assert.ok(logs.some((l) => /tracequest: index up to date \(1 session, 1 cached\)/.test(l)));
          assert.ok(!logs.some((l) => /building index/.test(l)));
        },
      );
    });
  });
});

describe("index-writers buildResultMapCacheKey", () => {
  test("cache key changes when session list checksum changes (miss)", async () => {
    const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
    const {
      buildResultMapCacheKey,
      initIndexWriters,
      resetIndexWritersForTests,
    } = await import(modUrl.href);

    const checksum = (sessions) => {
      let c = 0;
      for (const s of sessions) c ^= s.mtime.getTime() ^ (s.size || 0);
      return c;
    };
    initIndexWriters({ indexSession: () => ({}), sessionListChecksum: checksum });
    resetIndexWritersForTests();

    const a = [{ path: "/a", mtime: new Date(1000), size: 1 }];
    const b = [{ path: "/b", mtime: new Date(2000), size: 2 }];
    const keyA = buildResultMapCacheKey(a, 123);
    const keyB = buildResultMapCacheKey(b, 123);
    assert.notEqual(keyA, keyB, "different sessions must produce different cache keys");
    assert.equal(buildResultMapCacheKey(a, 123), keyA, "same inputs must hit cache key (stable)");
  });
});

describe("index-writers parseSidecarIndexStdout", () => {
  test("builds Map from sidecar index JSON without Object.entries", async () => {
    const { parseSidecarIndexStdout } = await importIndexWriters();
    const stdout = JSON.stringify({
      "/a.jsonl": { mtime: 1, firstPrompt: "a" },
      "/b.jsonl": { mtime: 2, firstPrompt: "b" },
    });
    const map = parseSidecarIndexStdout(stdout);
    assert.equal(map.size, 2);
    assert.equal(map.get("/a.jsonl").firstPrompt, "a");
    assert.equal(map.get("/b.jsonl").firstPrompt, "b");
  });
});

describe("index-writers sessionPayloadForSidecarIndex", () => {
  test("emits only sidecar Session fields (no spread of extra session props)", async () => {
    const { sessionPayloadForSidecarIndex } = await importIndexWriters();
    const payload = sessionPayloadForSidecarIndex({
      path: "/p/s.jsonl",
      project: "proj",
      file: "s.jsonl",
      source: "codex",
      size: 42,
      mtime: new Date(1715731200000),
      parentSession: "parent-1",
      title: "My session",
      searchText: "must not leak",
      toolCounts: { Bash: 3 },
    });
    assert.deepEqual(payload, {
      path: "/p/s.jsonl",
      project: "proj",
      file: "s.jsonl",
      source: "codex",
      size: 42,
      mtime: 1715731200000,
      parentSession: "parent-1",
      title: "My session",
    });
    assert.equal(Object.hasOwn(payload, "searchText"), false);
    assert.equal(Object.hasOwn(payload, "toolCounts"), false);
  });

  test("buildIndex sidecar stdin uses slim payloads", async () => {
    const script = `#!/usr/bin/env node
if (process.argv[2] !== "index") process.exit(1);
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  const sessions = Array.isArray(payload) ? payload : payload.sessions;
  if (sessions.length !== 1) process.exit(2);
  const s = sessions[0];
  if (s.searchText || s.toolCounts) process.exit(3);
  if (s.path !== "/tmp/fake.jsonl" || s.mtime !== 1715731200000) process.exit(4);
  console.log(JSON.stringify({ [s.path]: { mtime: s.mtime, firstPrompt: "ok" } }));
  process.exit(0);
});
`;
    await withMockSidecarScript(script, async () => {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const { buildIndex, initIndexWriters, resetIndexWritersForTests } = await import(modUrl.href);
      initIndexWriters({ indexSession: () => ({}), sessionListChecksum });
      resetIndexWritersForTests();
      const map = buildIndex([{
        path: "/tmp/fake.jsonl",
        project: "p",
        file: "fake.jsonl",
        mtime: new Date(1715731200000),
        source: "claude",
        size: 1,
        searchText: "leak-me",
        toolCounts: { Read: 1 },
      }]);
      assert.equal(map.get("/tmp/fake.jsonl").firstPrompt, "ok");
    });
  });
});

describe("index-writers SearchIndex output contract (fact ep7)", () => {
  const SESSION_PATH = "/tmp/tq-iw-legacy-searchtext.jsonl";
  const MTIME = 1_700_000_000_000;

  function session() {
    return {
      path: SESSION_PATH,
      file: "tq-iw-legacy-searchtext.jsonl",
      project: "tq-test",
      mtime: new Date(MTIME),
      source: "claude",
      size: 1,
    };
  }

  test("buildIndex strips legacy searchText from JS metadata and index.json", async () => {
    await withBuildIndexCacheHarness(
      {
        indexSession: () => ({
          firstPrompt: "legacy searchText prompt",
          searchText: "legacy full-text blob must not leak",
          termFreqs: new Map([["legacy", 1], ["searchtext", 1]]),
        }),
      },
      async ({ tmpDir, buildIndex, flushDeferredIndexWriteForTests }) => {
        const index = buildIndex([session()]);
        const meta = index.get(SESSION_PATH);

        assert.equal(meta.firstPrompt, "legacy searchText prompt");
        assert.equal(meta.termFreqs, undefined, "termFreqs must not leak into returned metadata");
        assert.equal(meta.searchText, undefined, "searchText must not leak into returned metadata");

        flushDeferredIndexWriteForTests();
        const written = JSON.parse(
          fs.readFileSync(path.join(tmpDir, ".cache", "tracequest", "index.json"), "utf-8"),
        );
        assert.equal(written[SESSION_PATH].termFreqs, undefined);
        assert.equal(written[SESSION_PATH].searchText, undefined);
      },
    );
  });
});

describe("index-writers loadIndexFile", () => {
  test("returns null without logging when index file is missing", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-missing-");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    const errorSpy = mock.method(console, "error", () => {});

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const {
        loadIndexFile,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await import(modUrl.href);

      initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
      resetIndexWritersForTests();

      const loaded = loadIndexFile(0);
      assert.equal(loaded, null);
      assert.equal(errorSpy.mock.calls.length, 0, "missing index file should not log");
    } finally {
      errorSpy.mock.restore();
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns null and logs on corrupt index file", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-load-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = path.join(cacheDir, "index.json");
    fs.writeFileSync(indexPath, "{not valid json");

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    const warn = mock.method(console, "error", () => {});

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const {
        loadIndexFile,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await import(modUrl.href);

      initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
      resetIndexWritersForTests();

      const mtime = fs.statSync(indexPath).mtime.getTime();
      const loaded = loadIndexFile(mtime);
      assert.equal(loaded, null);
      assert.ok(warn.mock.calls.length >= 1, "corrupt file should log loadIndexFile error");
      assert.match(String(warn.mock.calls[0].arguments[0]), /loadIndexFile/);
    } finally {
      warn.mock.restore();
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns null when index _v is older than INDEX_VERSION (stale format)", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-stale-v-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = path.join(cacheDir, "index.json");
    const staleVersion = INDEX_VERSION - 1;
    assert.ok(staleVersion >= 0, "INDEX_VERSION must be positive for stale-v test");
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        _v: staleVersion,
        "/tmp/old-format.jsonl": { mtime: 1, firstPrompt: "legacy" },
      })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const {
        loadIndexFile,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await import(modUrl.href);

      initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
      resetIndexWritersForTests();

      const diskMtime = fs.statSync(indexPath).mtime.getTime();
      const loaded = loadIndexFile(diskMtime);
      assert.equal(loaded, null, `disk _v=${staleVersion} must be rejected when INDEX_VERSION=${INDEX_VERSION}`);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns null when index _v is newer than INDEX_VERSION (forward incompatible)", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-future-v-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = path.join(cacheDir, "index.json");
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        _v: INDEX_VERSION + 1,
        "/tmp/future.jsonl": { mtime: 1, firstPrompt: "future" },
      })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const {
        loadIndexFile,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await import(modUrl.href);

      initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
      resetIndexWritersForTests();

      const diskMtime = fs.statSync(indexPath).mtime.getTime();
      assert.equal(loadIndexFile(diskMtime), null);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loads valid versioned index from disk", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-valid-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = path.join(cacheDir, "index.json");
    const mtime = 1715731200000;
    fs.writeFileSync(
      indexPath,
      JSON.stringify({
        _v: INDEX_VERSION,
        "/tmp/s.jsonl": { mtime, firstPrompt: "ok" },
      })
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const {
        loadIndexFile,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await import(modUrl.href);

      initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
      resetIndexWritersForTests();

      const diskMtime = fs.statSync(indexPath).mtime.getTime();
      const loaded = loadIndexFile(diskMtime);
      assert.ok(loaded);
      assert.equal(loaded._v, INDEX_VERSION);
      assert.equal(loaded["/tmp/s.jsonl"].firstPrompt, "ok");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reuses in-memory cache on repeat loadIndexFile (no JSON.parse)", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-reuse-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    const indexPath = path.join(cacheDir, "index.json");
    fs.writeFileSync(
      indexPath,
      JSON.stringify({ _v: INDEX_VERSION, "/tmp/s.jsonl": { mtime: 1, firstPrompt: "once" } }),
    );

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const { loadIndexFile, initIndexWriters, resetIndexWritersForTests } = await import(modUrl.href);
      initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
      resetIndexWritersForTests();

      const diskMtime = fs.statSync(indexPath).mtime.getTime();
      const first = loadIndexFile(diskMtime);
      fs.writeFileSync(
        indexPath,
        JSON.stringify({ _v: INDEX_VERSION, "/tmp/s.jsonl": { mtime: 1, firstPrompt: "mutated-on-disk" } }),
      );
      const second = loadIndexFile(diskMtime);
      assert.equal(second, first, "repeat loadIndexFile must reuse parsed cache, not disk");
      assert.equal(second["/tmp/s.jsonl"].firstPrompt, "once");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("index-writers indexWorkerCountForStale", () => {
  test("scales workers by INDEX_WORKER_BATCH up to parallelism cap", async () => {
    const { indexWorkerCountForStale, INDEX_WORKER_BATCH } = await importIndexWriters();
    const { availableParallelism } = await import("node:os");
    // The cap depends on the host core count; derive it the same way the
    // implementation does so this passes on a 4-core CI runner and a 16-core
    // dev box alike (hardcoding 3/7 assumed a many-core host and failed in CI).
    const maxWorkers = Math.min(8, Math.max(2, Math.floor(availableParallelism() / 2)));
    const expected = (stale) => Math.min(maxWorkers, Math.max(2, Math.ceil(stale / INDEX_WORKER_BATCH)));

    assert.equal(indexWorkerCountForStale(1), 2, "floor of 2 workers");
    assert.equal(indexWorkerCountForStale(INDEX_WORKER_BATCH), 2, "one batch stays at the floor");
    // 2 batches + 1 wants 3 workers by ceil, subject to the parallelism cap.
    assert.equal(indexWorkerCountForStale(INDEX_WORKER_BATCH * 2 + 1), expected(INDEX_WORKER_BATCH * 2 + 1));
    // A large stale set wants ceil(200/BATCH) workers, capped by maxWorkers and 8.
    assert.equal(indexWorkerCountForStale(200), expected(200));
  });
});

describe("index-writers workersBrokenExecArgv", () => {
  test("detects node --input-type=module -e parent (workers cannot load ESM)", async () => {
    const { workersBrokenExecArgv } = await importIndexWriters();
    assert.equal(workersBrokenExecArgv([]), false);
    assert.equal(workersBrokenExecArgv(["--input-type", "module", "-e", "1"]), true);
    assert.equal(workersBrokenExecArgv(["--input-type=module", "--eval", "1"]), true);
    assert.equal(workersBrokenExecArgv(["--input-type", "module"]), false);
    assert.equal(workersBrokenExecArgv(["-e", "1"]), false);
  });
});

describe("index-writers storeStaleIndex", () => {
  test("writes mtime, cache entry, and result map entry", async () => {
    const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
    const { storeStaleIndex, initIndexWriters, resetIndexWritersForTests } = await import(modUrl.href);

    initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
    resetIndexWritersForTests();

    const session = { path: "/p/s.jsonl", mtime: new Date(9999) };
    const data = { firstPrompt: "hi" };
    const cache = {};
    const result = new Map();

    storeStaleIndex(session, data, cache, result);

    assert.equal(data.mtime, 9999);
    assert.equal(cache["/p/s.jsonl"], data);
    assert.equal(result.get("/p/s.jsonl"), data);
  });

  test("uses explicit mtimeMs without reading session.mtime", async () => {
    const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
    const { storeStaleIndex, initIndexWriters, resetIndexWritersForTests } = await import(modUrl.href);

    initIndexWriters({ indexSession: () => ({}), sessionListChecksum: () => 0 });
    resetIndexWritersForTests();

    const session = { path: "/p/s.jsonl", mtime: new Date(1) };
    const data = { firstPrompt: "hi" };
    storeStaleIndex(session, data, {}, new Map(), 42_000);

    assert.equal(data.mtime, 42_000);
  });
});

describe("index-writers deferred index write", () => {
  test("flushDeferredIndexWriteForTests persists cache to disk", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-flush-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const indexFile = path.join(cacheDir, "index.json");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const {
        flushDeferredIndexWriteForTests,
        initIndexWriters,
        resetIndexWritersForTests,
        buildIndex,
      } = await import(modUrl.href);

      initIndexWriters({
        indexSession: () => ({ firstPrompt: "fresh" }),
        sessionListChecksum: () => 1,
      });
      resetIndexWritersForTests();

      const session = {
        path: "/tmp/new-session.jsonl",
        mtime: new Date(1715731200001),
        source: "claude",
        size: 10,
      };
      buildIndex([session]);
      flushDeferredIndexWriteForTests();

      assert.ok(fs.existsSync(indexFile), "deferred flush should write index.json");
      const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
      assert.equal(raw._v, INDEX_VERSION);
      assert.equal(raw["/tmp/new-session.jsonl"].firstPrompt, "fresh");
    } finally {
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("index-writers INDEX_VERSION stale disk rebuild", () => {
  const SESSION_PATH = "/tmp/version-mismatch.jsonl";
  const MTIME = 1715731200000;

  function session(overrides = {}) {
    return {
      path: SESSION_PATH,
      mtime: new Date(MTIME),
      source: "claude",
      size: 1,
      ...overrides,
    };
  }

  test("buildIndex re-indexes when disk cache _v is stale (ignores legacy entries)", async () => {
    const staleVersion = INDEX_VERSION - 1;
    assert.ok(staleVersion >= 0, "INDEX_VERSION must be > 0 for stale rebuild test");

    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [SESSION_PATH]: defaultCachedIndexEntry(MTIME, { firstPrompt: "legacy-disk" }),
        },
      },
      async ({ buildIndex, indexSessionCalls, indexPath }) => {
        const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        raw._v = staleVersion;
        fs.writeFileSync(indexPath, JSON.stringify(raw));

        const map = buildIndex([session()]);
        assert.equal(map.get(SESSION_PATH).firstPrompt, "fresh-index");
        assert.equal(indexSessionCalls.n, 1, "stale _v must force full re-index");
        assert.notEqual(
          map.get(SESSION_PATH).firstPrompt,
          "legacy-disk",
          "stale _v must not serve legacy disk entries"
        );
      }
    );
  });

  test("flush after stale rebuild writes INDEX_VERSION to disk", async () => {
    const staleVersion = INDEX_VERSION - 1;
    assert.ok(staleVersion >= 0);

    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [SESSION_PATH]: defaultCachedIndexEntry(MTIME, { firstPrompt: "legacy-disk" }),
        },
      },
      async ({ buildIndex, flushDeferredIndexWriteForTests, indexPath }) => {
        const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        raw._v = staleVersion;
        fs.writeFileSync(indexPath, JSON.stringify(raw));

        buildIndex([session()]);
        flushDeferredIndexWriteForTests();

        const written = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        assert.equal(written._v, INDEX_VERSION);
        assert.equal(written[SESSION_PATH].firstPrompt, "fresh-index");
      }
    );
  });
});

describe("index-writers buildIndex cache invalidation", () => {
  const SESSION_PATH = "/tmp/fake.jsonl";
  const MTIME = 1715731200000;

  function session(overrides = {}) {
    return {
      path: SESSION_PATH,
      mtime: new Date(MTIME),
      source: "claude",
      size: 1,
      ...overrides,
    };
  }

  test("all-cache buildIndex fast path skips sidecar spawn", async () => {
    const script = `#!/usr/bin/env node
console.error("sidecar must not run when disk cache satisfies all sessions");
process.exit(99);
`;
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-sidecar-skip-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "index.json"),
      JSON.stringify({ _v: INDEX_VERSION, [SESSION_PATH]: defaultCachedIndexEntry(MTIME) }),
    );
    writeWarmSearchIdx(cacheDir, [SESSION_PATH]);

    const home = saveEnv("HOME");
    const noSidecar = saveEnv("TRACEQUEST_NO_SIDECAR");
    delete process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;

    await withMockSidecarScript(script, async () => {
      try {
        const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
        const { buildIndex, initIndexWriters, resetIndexWritersForTests } = await import(modUrl.href);
        initIndexWriters({
          indexSession: () => {
            throw new Error("indexSession must not run on all-cache hit");
          },
          sessionListChecksum,
        });
        resetIndexWritersForTests();
        const map = buildIndex([session()]);
        assert.equal(map.get(SESSION_PATH).firstPrompt, "cached");
      } finally {
        home.restore();
        noSidecar.restore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  test("result map cache hit skips sidecar re-spawn when index unchanged", async () => {
    const script = `#!/usr/bin/env node
if (process.argv[2] !== "index") process.exit(1);
const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  const sessions = Array.isArray(payload) ? payload : payload.sessions;
  const out = {};
  for (const s of sessions) {
    out[s.path] = {
      mtime: s.mtime,
      firstPrompt: "sidecar-index",
      model: null,
      tools: [],
      toolCounts: {},
      chapters: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      durationMs: 0,
      errors: 0,
      files: 0,
      commits: 0,
    };
  }
  console.log(JSON.stringify(out));
  process.exit(0);
});
`;
    await withMockSidecarScript(script, async () => {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const { buildIndex, initIndexWriters, resetIndexWritersForTests } = await import(modUrl.href);
      initIndexWriters({ indexSession: () => ({}), sessionListChecksum });
      resetIndexWritersForTests();
      const s = session();
      const map1 = buildIndex([s]);
      const map2 = buildIndex([s]);
      assert.equal(map1, map2, "second buildIndex must reuse sidecar result Map");
      assert.equal(map1.get(SESSION_PATH).firstPrompt, "sidecar-index");
    });
  });

  test("result map cache hit: identical Map when sessions, checksum, and index mtime unchanged", async () => {
    await withBuildIndexCacheHarness(
      {
        diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) },
        indexSession: () => {
          throw new Error("indexSession must not run on disk cache hit");
        },
      },
      async ({ buildIndex }) => {
        const map1 = buildIndex([session()]);
        const map2 = buildIndex([session()]);
        assert.equal(map1, map2, "second buildIndex must return cached Map instance");
        assert.equal(map1.get(SESSION_PATH).firstPrompt, "cached");
      }
    );
  });

  test("all-cache hit avoids shallow-cloning large on-disk index", async () => {
    const COUNT = 20_000;
    const diskEntries = {};
    const sessions = [];
    for (let i = 0; i < COUNT; i++) {
      const p = `/tmp/tq-cow-${i}.jsonl`;
      diskEntries[p] = defaultCachedIndexEntry(1_000_000 + i);
      sessions.push({
        path: p,
        mtime: new Date(1_000_000 + i),
        source: "claude",
        size: 1,
      });
    }
    await withBuildIndexCacheHarness(
      {
        diskEntries,
        indexSession: () => {
          throw new Error("indexSession must not run when every session is cached");
        },
      },
      async ({ buildIndex, indexSessionCalls }) => {
        const t0 = performance.now();
        buildIndex(sessions);
        const ms = performance.now() - t0;
        assert.equal(indexSessionCalls.n, 0);
        assertPerf(
          ms < 300,
          `expected all-cache buildIndex under 300ms for ${COUNT} sessions, got ${ms.toFixed(1)}ms`,
        );
      },
    );
  });

  test("buildIndex pruneIndexCache drops paths removed from session list", async () => {
    const ORPHAN = "/tmp/tq-prune-orphan.jsonl";
    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [SESSION_PATH]: defaultCachedIndexEntry(MTIME),
          [ORPHAN]: defaultCachedIndexEntry(MTIME, { firstPrompt: "orphan" }),
        },
      },
      async ({ buildIndex, flushDeferredIndexWriteForTests, indexPath }) => {
        buildIndex([session({ mtime: new Date(MTIME + 1) })]);
        flushDeferredIndexWriteForTests();
        const written = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        assert.ok(written[SESSION_PATH]);
        assert.equal(written[ORPHAN], undefined, "orphaned cache entry must be pruned");
      },
    );
  });

  test("deleted session pruned on all-cache-hit path (fact 03w regression)", async () => {
    // Regression: when session A is deleted and all remaining sessions (B) are
    // full cache hits (mtime match + SI present), staleSessions is empty and
    // buildIndex took the early return WITHOUT calling pruneIndexCache. A's
    // entries persisted in-memory and were flushed back into index.json and
    // search.idx indefinitely.
    const PATH_A = "/tmp/tq-prune-allhit-a.jsonl";
    const PATH_B = "/tmp/tq-prune-allhit-b.jsonl";
    const MTIME_A = MTIME;
    const MTIME_B = MTIME + 1000;

    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [PATH_A]: defaultCachedIndexEntry(MTIME_A, { firstPrompt: "session-a" }),
          [PATH_B]: defaultCachedIndexEntry(MTIME_B, { firstPrompt: "session-b" }),
        },
      },
      async ({
        buildIndex,
        flushDeferredIndexWriteForTests,
        flushDeferredSearchIdxWriteForTests,
        indexPath,
        tmpDir,
        resetIndexWritersForTests,
      }) => {
        const cacheDir = path.join(tmpDir, ".cache", "tracequest");
        const sessionA = { path: PATH_A, mtime: new Date(MTIME_A), source: "claude", size: 1 };
        const sessionB = { path: PATH_B, mtime: new Date(MTIME_B), source: "claude", size: 1 };

        // Step 1: build with both A+B to populate in-memory caches and search.idx.
        buildIndex([sessionA, sessionB]);
        flushDeferredIndexWriteForTests();
        flushDeferredSearchIdxWriteForTests();

        // Step 2: simulate a fresh process load with only session B on disk.
        // Both caches (index.json + search.idx) still contain A.
        resetIndexWritersForTests();

        // Step 3: buildIndex with only [B]. Both mtime matches — staleSessions=0.
        // Before fix: early return, A's entries persist in memory and on disk.
        const result = buildIndex([sessionB]);

        // A must be absent from the returned result Map.
        assert.equal(result.has(PATH_A), false, "deleted session A must not appear in result map");
        assert.equal(result.has(PATH_B), true, "surviving session B must be in result map");

        // A must be absent from the in-memory SearchIndex.
        const si = getSearchIndex();
        assert.equal(si.has(PATH_A), false, "deleted session A must be removed from SearchIndex");
        assert.equal(si.has(PATH_B), true, "surviving session B must remain in SearchIndex");

        // docCount must reflect only B.
        assert.equal(si.docCount, 1, "docCount must equal 1 after A is pruned");

        // After flush, both cache files must not contain A.
        flushDeferredIndexWriteForTests();
        flushDeferredSearchIdxWriteForTests();

        const written = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
        assert.equal(written[PATH_A], undefined, "index.json must not contain deleted session A");
        assert.ok(written[PATH_B], "index.json must retain surviving session B");

        // Reload search.idx from disk and verify A is absent.
        const { loadSearchIndex, getSearchIndex: getSI, resetSearchIndexForTests: resetSI } =
          await import(new URL("../src/sessions/search-index.js?" + Date.now(), import.meta.url).href);
        loadSearchIndex();
        const diskSI = getSI();
        assert.equal(diskSI.has(PATH_A), false, "flushed search.idx must not contain deleted session A");
        assert.equal(diskSI.has(PATH_B), true, "flushed search.idx must retain surviving session B");
        assert.equal(diskSI.docCount, 1, "flushed search.idx docCount must be 1");
        resetSI();
      },
    );
  });

  test("incremental re-index skips orphan prune when cache path count matches session list", async () => {
    const COUNT = 20_000;
    const diskEntries = {};
    const sessions = [];
    for (let i = 0; i < COUNT; i++) {
      const p = `/tmp/tq-prune-skip-${i}.jsonl`;
      diskEntries[p] = defaultCachedIndexEntry(1_000_000 + i);
      sessions.push({
        path: p,
        mtime: new Date(1_000_000 + i),
        source: "claude",
        size: 1,
      });
    }
    sessions[0] = {
      ...sessions[0],
      mtime: new Date(1_000_000_000),
    };
    await withBuildIndexCacheHarness(
      { diskEntries },
      async ({ buildIndex }) => {
        const t0 = performance.now();
        const map = buildIndex(sessions);
        const ms = performance.now() - t0;
        assert.equal(map.get("/tmp/tq-prune-skip-0.jsonl").firstPrompt, "fresh-index");
        assertPerf(
          ms < 400,
          `expected single-stale buildIndex under 400ms for ${COUNT} sessions, got ${ms.toFixed(1)}ms`,
        );
      },
    );
  });

  test("stale re-index copy-on-writes disk cache preserving cached entry references", async () => {
    const OTHER = "/tmp/tq-cow-other.jsonl";
    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [SESSION_PATH]: defaultCachedIndexEntry(MTIME),
          [OTHER]: defaultCachedIndexEntry(MTIME + 1, { firstPrompt: "other" }),
        },
      },
      async ({ buildIndex }) => {
        const other = { path: OTHER, mtime: new Date(MTIME + 1), source: "claude", size: 2 };
        const map1 = buildIndex([session(), other]);
        const otherMeta = map1.get(OTHER);

        buildIndex([session({ mtime: new Date(MTIME + 5000) }), other]);
        const map2 = buildIndex([session({ mtime: new Date(MTIME + 5000) }), other]);
        assert.equal(map2.get(OTHER), otherMeta, "unchanged cache entries must keep meta object identity");
      },
    );
  });

  test("result map cache miss: new Map when session mtime changes", async () => {
    await withBuildIndexCacheHarness(
      { diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) } },
      async ({ buildIndex, indexSessionCalls }) => {
        const map1 = buildIndex([session()]);
        assert.equal(indexSessionCalls.n, 0, "disk entry should satisfy first call");

        const bumped = session({ mtime: new Date(MTIME + 5000) });
        const map2 = buildIndex([bumped]);
        assert.notEqual(map1, map2, "session mtime change must invalidate result map cache");
        assert.equal(map2.get(SESSION_PATH).firstPrompt, "fresh-index");
        assert.equal(indexSessionCalls.n, 1, "stale disk entry must re-index once");
      }
    );
  });

  test("result map cache miss: new Map when session size changes (checksum)", async () => {
    await withBuildIndexCacheHarness(
      { diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) } },
      async ({ buildIndex, buildResultMapCacheKey, indexPath }) => {
        const sessionsA = [session({ size: 1 })];
        const sessionsB = [session({ size: 99 })];
        const diskMtime = fs.statSync(indexPath).mtime.getTime();
        assert.notEqual(
          buildResultMapCacheKey(sessionsA, diskMtime),
          buildResultMapCacheKey(sessionsB, diskMtime),
          "size change must alter checksum in cache key"
        );

        const map1 = buildIndex(sessionsA);
        const map2 = buildIndex(sessionsB);
        assert.notEqual(map1, map2, "checksum change must invalidate result map cache");
      }
    );
  });

  test("result map cache miss: new Map when session list length changes (checksum)", async () => {
    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [SESSION_PATH]: defaultCachedIndexEntry(MTIME),
          "/tmp/other.jsonl": defaultCachedIndexEntry(MTIME + 1, { firstPrompt: "other" }),
        },
      },
      async ({ buildIndex }) => {
        const map1 = buildIndex([session()]);
        const map2 = buildIndex([
          session(),
          {
            path: "/tmp/other.jsonl",
            mtime: new Date(MTIME + 1),
            source: "claude",
            size: 2,
          },
        ]);
        assert.notEqual(map1, map2, "session count change must invalidate result map cache");
        assert.equal(map2.size, 2);
      }
    );
  });

  test("result map cache miss: new Map when index.json disk mtime changes", async () => {
    await withBuildIndexCacheHarness(
      { diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) } },
      async ({ buildIndex, indexPath }) => {
        const map1 = buildIndex([session()]);
        const map2 = buildIndex([session()]);
        assert.equal(map1, map2, "precondition: stable inputs should hit result cache");

        const bumped = Date.now() + 60_000;
        fs.utimesSync(indexPath, bumped / 1000, bumped / 1000);
        const map3 = buildIndex([session()]);
        assert.notEqual(map2, map3, "index disk mtime bump must invalidate result map cache");
      }
    );
  });

  test("per-session disk cache hit: indexSession not called when entry mtime matches", async () => {
    await withBuildIndexCacheHarness(
      {
        diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) },
        indexSession: () => {
          throw new Error("indexSession must not run when disk cache mtime matches");
        },
      },
      async ({ buildIndex, indexSessionCalls }) => {
        const map = buildIndex([session()]);
        assert.equal(map.get(SESSION_PATH).firstPrompt, "cached");
        assert.equal(indexSessionCalls.n, 0);
      }
    );
  });

  test("per-session disk cache miss: indexSession runs when entry mtime is stale", async () => {
    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [SESSION_PATH]: defaultCachedIndexEntry(MTIME - 1000, { firstPrompt: "stale-disk" }),
        },
      },
      async ({ buildIndex, indexSessionCalls }) => {
        const map = buildIndex([session()]);
        assert.equal(map.get(SESSION_PATH).firstPrompt, "fresh-index");
        assert.equal(indexSessionCalls.n, 1);
      }
    );
  });

  test("resetIndexWritersForTests clears result map cache", async () => {
    await withBuildIndexCacheHarness(
      { diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) } },
      async ({ buildIndex, resetIndexWritersForTests }) => {
        const map1 = buildIndex([session()]);
        const map2 = buildIndex([session()]);
        assert.equal(map1, map2);

        resetIndexWritersForTests();
        const map3 = buildIndex([session()]);
        assert.notEqual(map1, map3, "reset must drop cached result Map");
        assert.equal(map3.get(SESSION_PATH).firstPrompt, "cached");
      }
    );
  });

  test("result map cache hit after stale re-index with same session inputs", async () => {
    await withBuildIndexCacheHarness(
      { diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME - 1) } },
      async ({ buildIndex, indexSessionCalls }) => {
        const s = session();
        const map1 = buildIndex([s]);
        assert.equal(indexSessionCalls.n, 1);
        assert.equal(map1.get(SESSION_PATH).firstPrompt, "fresh-index");

        const map2 = buildIndex([s]);
        assert.equal(map2, map1, "unchanged sessions after re-index must hit result map cache");
        assert.equal(indexSessionCalls.n, 1, "second call must not re-index");
      }
    );
  });

  test("result map cache short-circuits before indexSession on repeat", async () => {
    let prompt = "v1";
    await withBuildIndexCacheHarness(
      {
        diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME - 50) },
        indexSession: () => ({ firstPrompt: prompt }),
      },
      async ({ buildIndex }) => {
        const s = session();
        const map1 = buildIndex([s]);
        assert.equal(map1.get(SESSION_PATH).firstPrompt, "v1");

        prompt = "v2-would-be-ignored";
        const map2 = buildIndex([s]);
        assert.equal(map2, map1);
        assert.equal(map2.get(SESSION_PATH).firstPrompt, "v1");
      }
    );
  });

  test("numeric session mtime matches disk cache entry (sessionMtimeMs)", async () => {
    await withBuildIndexCacheHarness(
      { diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) } },
      async ({ buildIndex, indexSessionCalls }) => {
        const map = buildIndex([{ path: SESSION_PATH, mtime: MTIME, source: "claude", size: 1 }]);
        assert.equal(map.get(SESSION_PATH).firstPrompt, "cached");
        assert.equal(indexSessionCalls.n, 0);
      }
    );
  });
});

describe("index-writers indexDiskMtimeMs", () => {
  test("returns 0 for missing index without logging", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-mtime-");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    const errorSpy = mock.method(console, "error", () => {});

    try {
      const { indexDiskMtimeMs, resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
      assert.equal(indexDiskMtimeMs(), 0);
      assert.equal(errorSpy.mock.calls.length, 0);
    } finally {
      errorSpy.mock.restore();
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns index file mtime ms when index.json exists", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-mtime-hit-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const indexFile = path.join(cacheDir, "index.json");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify({ _v: INDEX_VERSION }));
    const expected = fs.statSync(indexFile).mtime.getTime();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const errorSpy = mock.method(console, "error", () => {});

    try {
      const { indexDiskMtimeMs, resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
      assert.equal(indexDiskMtimeMs(), expected);
      assert.equal(errorSpy.mock.calls.length, 0);
    } finally {
      errorSpy.mock.restore();
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reflects updated mtime after index file is rewritten", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-mtime-touch-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const indexFile = path.join(cacheDir, "index.json");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify({ _v: INDEX_VERSION, "/a": { mtime: 1 } }));

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const { indexDiskMtimeMs, resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
      const first = indexDiskMtimeMs();

      const laterSec = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(indexFile, laterSec, laterSec);
      const second = indexDiskMtimeMs();

      assert.ok(second > first, "indexDiskMtimeMs should track rewritten index.json mtime");
      assert.equal(second, fs.statSync(indexFile).mtime.getTime());
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("logs unexpected stat errors and returns 0", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-mtime-err-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const indexFile = path.join(cacheDir, "index.json");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(indexFile, "{}");
    fs.chmodSync(cacheDir, 0o000);

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    const errorSpy = mock.method(console, "error", () => {});

    try {
      const { indexDiskMtimeMs, resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
      assert.equal(indexDiskMtimeMs(), 0);
      assert.ok(
        errorSpy.mock.calls.some((c) => String(c.arguments[0]).includes("indexDiskMtimeMs")),
        "unexpected stat failure should log"
      );
    } finally {
      fs.chmodSync(cacheDir, 0o700);
      errorSpy.mock.restore();
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("partitionStaleSessionsForWorkers", () => {
  test("balances skewed sizes better than round-robin", async () => {
    const { partitionStaleSessionsForWorkers } = await importIndexWriters();
    const sessions = [
      { path: "/huge.jsonl", size: 500 },
      { path: "/a.jsonl", size: 1 },
      { path: "/b.jsonl", size: 1 },
      { path: "/c.jsonl", size: 1 },
      { path: "/huge2.jsonl", size: 500 },
      { path: "/d.jsonl", size: 1 },
    ];
    const workerCount = 2;
    const roundRobinLoads = [0, 0];
    for (let i = 0; i < sessions.length; i++) {
      const w = i % workerCount;
      roundRobinLoads[w] += sessions[i].size;
    }
    const chunks = partitionStaleSessionsForWorkers(sessions, workerCount);
    const balancedLoads = chunks.map((chunk) =>
      chunk.reduce((sum, s) => sum + (s.size || 0), 0),
    );
    const rrMax = Math.max(...roundRobinLoads);
    const balMax = Math.max(...balancedLoads);
    assert.ok(balMax < rrMax, `balanced max ${balMax} should beat round-robin ${rrMax}`);
    assert.equal(chunks.flat().length, sessions.length);
    const paths = new Set(chunks.flat().map((s) => s.path));
    assert.equal(paths.size, sessions.length);
  });
});

describe("index-writers parallel workers", () => {
  test("logs worker _error and falls back to injected indexSession", async () => {
    await withParallelTestEnv(MOCK_WORKER_ERR, async () => {
      const errorSpy = mock.method(console, "error", () => {});

      try {
        const {
          buildIndex,
          initIndexWriters,
          resetIndexWritersForTests,
        } = await importIndexWriters();

        initIndexWriters({
          indexSession: (s) => ({ firstPrompt: `fallback-${s.path}` }),
          sessionListChecksum: (sessions) => sessions.length,
        });
        resetIndexWritersForTests();

        const sessions = makeStaleSessions(3);
        const map = buildIndex(sessions);

        assert.ok(
          errorSpy.mock.calls.some((c) =>
            String(c.arguments[0]).includes("indexSessionsParallel") &&
            String(c.arguments[1]).includes("mock worker boom")
          ),
          "worker _error should log"
        );
        assert.equal(map.get(sessions[0].path).firstPrompt, `fallback-${sessions[0].path}`);
      } finally {
        errorSpy.mock.restore();
      }
    });
  });

  test("merges parallel worker results into buildIndex map", async () => {
    await withParallelTestEnv(MOCK_WORKER_OK, async () => {
      const {
        buildIndex,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: () => ({ firstPrompt: "main-thread" }),
        sessionListChecksum: (sessions) => sessions.length,
      });
      resetIndexWritersForTests();

      const sessions = makeStaleSessions(3, "/tmp/tq-iw-merge-");
      const map = buildIndex(sessions);

      assert.equal(map.get(sessions[0].path).firstPrompt, "from-worker");
      assert.equal(map.get(sessions[2].path).firstPrompt, "from-worker");
    });
  });

  test("continues merge when a worker returns no message", async () => {
    await withParallelTestEnv(MOCK_WORKER_PARTIAL, async () => {
      const {
        buildIndex,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: (s) => ({ firstPrompt: `fb-${s.path}`, searchText: "" }),
        sessionListChecksum: (sessions) => sessions.length,
      });
      resetIndexWritersForTests();

      const sessions = makeStaleSessions(3, "/tmp/tq-iw-empty-");
      const map = buildIndex(sessions);
      assert.equal(map.get("/tmp/tq-iw-empty-0.jsonl").firstPrompt, "w0");
      assert.equal(map.get("/tmp/tq-iw-empty-2.jsonl").firstPrompt, "fb-/tmp/tq-iw-empty-2.jsonl");
    });
  });
});

describe("index-writers deferred index write (expanded)", () => {
  test("updates in-memory SearchIndex immediately and defers index.json and search.idx writes until debounce", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-v99-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const indexFile = path.join(cacheDir, "index.json");
    const searchIdxFile = path.join(cacheDir, "search.idx");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    mock.timers.enable({ apis: ["setTimeout"] });

    try {
      const {
        buildIndex,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: () => ({
          firstPrompt: "debounced index write",
          termFreqs: new Map([["debounceterm", 3]]),
        }),
        sessionListChecksum: () => 10,
      });
      resetIndexWritersForTests();

      const session = {
        path: "/tmp/debounce-v99.jsonl",
        mtime: new Date(11),
        source: "claude",
        size: 1,
      };
      const index = buildIndex([session]);

      assert.equal(fs.existsSync(indexFile), false, "index.json write must be deferred");
      assert.equal(fs.existsSync(searchIdxFile), false, "search.idx write must be deferred");

      const si = getSearchIndex();
      assert.equal(si.has(session.path), true, "SearchIndex must update before disk debounce fires");
      assert.equal(si.postings.get("debounceterm").get(session.path), 3);

      const hits = searchSessions([session], index, "debounceterm", 5);
      assert.equal(hits.length, 1, "searchSessions must see the in-memory SearchIndex before persistence");

      mock.timers.tick(INDEX_WRITE_DELAY_MS - 1);
      assert.equal(fs.existsSync(indexFile), false, "index.json must wait for the debounce delay");
      assert.equal(fs.existsSync(searchIdxFile), false, "search.idx must wait for the debounce delay");

      mock.timers.tick(1);
      assert.ok(fs.existsSync(indexFile), "index.json must flush when debounce fires");
      assert.ok(fs.existsSync(searchIdxFile), "search.idx must flush when debounce fires");
    } finally {
      mock.timers.reset();
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips disk write when serialized index exceeds 2GB cap", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-cap-");
    const indexFile = path.join(tmpDir, ".cache", "tracequest", "index.json");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    const stringifySpy = mock.method(JSON, "stringify", () => ({ length: TWO_GB + 1 }));
    const warnSpy = mock.method(console, "warn", () => {});
    const writeSpy = mock.method(fs, "writeFileSync", () => {});

    try {
      const {
        buildIndex,
        flushDeferredIndexWriteForTests,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: () => ({ firstPrompt: "big" }),
        sessionListChecksum: () => 1,
      });
      resetIndexWritersForTests();

      buildIndex([
        {
          path: "/tmp/cap.jsonl",
          mtime: new Date(1),
          source: "claude",
          size: 1,
        },
      ]);
      flushDeferredIndexWriteForTests();

      assert.ok(
        warnSpy.mock.calls.some((c) =>
          String(c.arguments[0]).includes("deferred index write skipped") &&
          String(c.arguments[0]).includes("2048MB")
        ),
        "2GB cap should warn and skip write"
      );
      assert.equal(writeSpy.mock.calls.length, 0);
      assert.equal(fs.existsSync(indexFile), false);
    } finally {
      stringifySpy.mock.restore();
      warnSpy.mock.restore();
      writeSpy.mock.restore();
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scheduled deferred write flushes after INDEX_WRITE_DELAY_MS", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-timer-");
    const indexFile = path.join(tmpDir, ".cache", "tracequest", "index.json");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    mock.timers.enable({ apis: ["setTimeout"] });

    try {
      const {
        buildIndex,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: () => ({ firstPrompt: "timer" }),
        sessionListChecksum: () => 2,
      });
      resetIndexWritersForTests();

      buildIndex([
        {
          path: "/tmp/timer.jsonl",
          mtime: new Date(9),
          source: "claude",
          size: 1,
        },
      ]);
      assert.equal(fs.existsSync(indexFile), false);
      mock.timers.tick(INDEX_WRITE_DELAY_MS);
      assert.ok(fs.existsSync(indexFile), "timer should flush index.json");
      const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
      assert.equal(raw["/tmp/timer.jsonl"].firstPrompt, "timer");
    } finally {
      mock.timers.reset();
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scheduled deferred write warns when disk write throws", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-write-err-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    mock.timers.enable({ apis: ["setTimeout"] });
    const warnSpy = mock.method(console, "warn", () => {});

    try {
      const {
        buildIndex,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: () => ({ firstPrompt: "fail" }),
        sessionListChecksum: () => 3,
      });
      resetIndexWritersForTests();

      buildIndex([
        {
          path: "/tmp/write-fail.jsonl",
          mtime: new Date(8),
          source: "claude",
          size: 1,
        },
      ]);
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.chmodSync(cacheDir, 0o555);
      mock.timers.tick(INDEX_WRITE_DELAY_MS);
      assert.ok(
        warnSpy.mock.calls.some((c) =>
          String(c.arguments[0]).includes("deferred index write failed")
        ),
        "write failure on timer should warn"
      );
    } finally {
      try {
        fs.chmodSync(cacheDir, 0o755);
      } catch {
        /* cache dir may not exist */
      }
      warnSpy.mock.restore();
      mock.timers.reset();
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("flushDeferredIndexWriteForTests clears pending timer before writing", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-flush-timer-");
    const indexFile = path.join(tmpDir, ".cache", "tracequest", "index.json");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    mock.timers.enable({ apis: ["setTimeout"] });

    try {
      const {
        buildIndex,
        flushDeferredIndexWriteForTests,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: () => ({ firstPrompt: "flush-now" }),
        sessionListChecksum: () => 4,
      });
      resetIndexWritersForTests();

      buildIndex([
        {
          path: "/tmp/flush-now.jsonl",
          mtime: new Date(7),
          source: "claude",
          size: 1,
        },
      ]);
      flushDeferredIndexWriteForTests();
      assert.ok(fs.existsSync(indexFile));
      mock.timers.tick(INDEX_WRITE_DELAY_MS);
      const raw = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
      assert.equal(raw["/tmp/flush-now.jsonl"].firstPrompt, "flush-now");
    } finally {
      mock.timers.reset();
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("pending write registers signal handlers and flushDeferredIndexWrites removes them", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-flush-all-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const indexFile = path.join(cacheDir, "index.json");
    const searchIdxFile = path.join(cacheDir, "search.idx");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    try {
      const {
        buildIndex,
        flushDeferredIndexWrites,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();

      initIndexWriters({
        indexSession: () => ({
          firstPrompt: "flush all",
          termFreqs: new Map([["flushallterm", 1]]),
        }),
        sessionListChecksum: () => 11,
      });
      resetIndexWritersForTests();

      const sigintBefore = process.listenerCount("SIGINT");
      const sigtermBefore = process.listenerCount("SIGTERM");

      buildIndex([
        {
          path: "/tmp/flush-all.jsonl",
          mtime: new Date(12),
          source: "claude",
          size: 1,
        },
      ]);

      assert.equal(process.listenerCount("SIGINT"), sigintBefore + 1);
      assert.equal(process.listenerCount("SIGTERM"), sigtermBefore + 1);
      assert.equal(fs.existsSync(indexFile), false, "index.json must be pending before flush");
      assert.equal(fs.existsSync(searchIdxFile), false, "search.idx must be pending before flush");

      flushDeferredIndexWrites();

      assert.equal(process.listenerCount("SIGINT"), sigintBefore);
      assert.equal(process.listenerCount("SIGTERM"), sigtermBefore);
      assert.ok(fs.existsSync(indexFile), "flushDeferredIndexWrites must write index.json");
      assert.ok(fs.existsSync(searchIdxFile), "flushDeferredIndexWrites must write search.idx");
    } finally {
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("index-writers buildIndex mtime probe-before-stat", () => {
  test("buildIndex with indexDiskMtimeMs skips redundant stat on warm result-map hit", async () => {
    const SESSION_PATH = "/tmp/tq-probe-mtime.jsonl";
    const MTIME = 1_715_731_200_000;
    await withBuildIndexCacheHarness(
      { diskEntries: { [SESSION_PATH]: defaultCachedIndexEntry(MTIME) } },
      async ({ buildIndex, indexPath }) => {
        const session = {
          path: SESSION_PATH,
          mtime: new Date(MTIME),
          source: "claude",
          size: 1,
        };
        const diskMs = fs.statSync(indexPath).mtime.getTime();
        const map1 = buildIndex([session]);
        const map2 = buildIndex([session], { indexDiskMtimeMs: diskMs });
        assert.equal(map1, map2, "precomputed disk mtime must hit result-map cache");
      },
    );
  });

  test("index disk mtime coalesce shares one stat across route-cache key + buildIndex", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-coalesce-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "index.json"),
      JSON.stringify({ _v: INDEX_VERSION, "/tmp/coalesce.jsonl": defaultCachedIndexEntry(42) }),
    );
    writeWarmSearchIdx(cacheDir, ["/tmp/coalesce.jsonl"]);

    const home = saveEnv("HOME");
    const noSidecar = saveEnv("TRACEQUEST_NO_SIDECAR");
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";

    try {
      const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
      const {
        beginIndexDiskMtimeCoalesce,
        endIndexDiskMtimeCoalesce,
        indexDiskMtimeMs,
        indexDiskMtimeStatCallsForTests,
        buildIndex,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await import(modUrl.href);
      initIndexWriters({
        indexSession: () => {
          throw new Error("indexSession must not run on disk cache hit");
        },
        sessionListChecksum,
      });
      resetIndexWritersForTests();

      const session = { path: "/tmp/coalesce.jsonl", mtime: new Date(42), source: "claude", size: 1 };
      beginIndexDiskMtimeCoalesce();
      const diskMs = indexDiskMtimeMs();
      buildIndex([session], { indexDiskMtimeMs: diskMs });
      endIndexDiskMtimeCoalesce();

      assert.equal(
        indexDiskMtimeStatCallsForTests(),
        1,
        "coalesced route path should stat index.json once",
      );

      resetIndexWritersForTests();
      buildIndex([session]);
      buildIndex([session]);
      assert.equal(
        indexDiskMtimeStatCallsForTests(),
        2,
        "uncoalesced warm buildIndex should stat once per call without precomputed mtime",
      );
    } finally {
      home.restore();
      noSidecar.restore();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("index-writers readIndexDiskMtimeMs (buildIndex parity)", () => {
  test("buildIndex and indexDiskMtimeMs agree when index.json exists on disk", async () => {
    await withBuildIndexCacheHarness(
      { diskEntries: { "/tmp/parity.jsonl": defaultCachedIndexEntry(1_000) } },
      async ({ buildIndex, indexPath }) => {
        const { indexDiskMtimeMs } = await importIndexWriters();
        const sessions = [{ path: "/tmp/parity.jsonl", mtime: new Date(1_000), source: "claude", size: 1 }];
        buildIndex(sessions);
        const diskMs = fs.statSync(indexPath).mtime.getTime();
        assert.equal(indexDiskMtimeMs(), diskMs);
      },
    );
  });
});

describe("index-writers isNativeExecutable", () => {
  test("returns false for missing path without logging ENOENT", async () => {
    const { isNativeExecutable } = await importIndexWriters();
    const warnSpy = mock.method(console, "warn", () => {});
    const missing = path.join(tmpdir(), `tq-elf-missing-${Date.now()}`);

    try {
      assert.equal(isNativeExecutable(missing), false);
      assert.equal(warnSpy.mock.calls.length, 0);
    } finally {
      warnSpy.mock.restore();
    }
  });
});

describe("index-writers detectSidecar path resolution", () => {
  test("TRACEQUEST_SIDECAR_PATH mock is used without ELF check", async () => {
    const script = `#!/usr/bin/env node
if (process.argv[2] === "ping") { console.log("pong"); process.exit(0); }
process.exit(1);
`;
    await withMockSidecarScript(script, async () => {
      const { runSidecar } = await importIndexWriters();
      const out = runSidecar("ping", ["ping"], (r) => r.stdout.trim());
      assert.equal(out, "pong");
    });
  });

  test("TRACEQUEST_SIDECAR_PATH swap applies without resetIndexWritersForTests", async () => {
    const scriptA = `#!/usr/bin/env node
if (process.argv[2] === "ping") { console.log("A"); process.exit(0); }
process.exit(1);
`;
    const scriptB = `#!/usr/bin/env node
if (process.argv[2] === "ping") { console.log("B"); process.exit(0); }
process.exit(1);
`;
    const dir = mkdtempSync(path.join(tmpdir(), "tq-iw-sidecar-swap-"));
    const binA = path.join(dir, "tracequest-sidecar-a");
    const binB = path.join(dir, "tracequest-sidecar-b");
    const pathEnv = saveEnv(SIDECAR_PATH_ENV);
    const noSidecar = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
    delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];

    try {
      writeFileSync(binA, scriptA, { mode: 0o755 });
      writeFileSync(binB, scriptB, { mode: 0o755 });
      process.env[SIDECAR_PATH_ENV] = binA;
      const { runSidecar } = await importIndexWriters();
      assert.equal(runSidecar("ping", ["ping"], (r) => r.stdout.trim()), "A");

      process.env[SIDECAR_PATH_ENV] = binB;
      assert.equal(runSidecar("ping", ["ping"], (r) => r.stdout.trim()), "B");
    } finally {
      pathEnv.restore();
      noSidecar.restore();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      const { resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
    }
  });

  test("cached sidecar path is cleared by resetIndexWritersForTests", async () => {
    const script = `#!/usr/bin/env node
if (process.argv[2] === "ping") { console.log("once"); process.exit(0); }
process.exit(1);
`;
    await withMockSidecarScript(script, async () => {
      const { runSidecar, resetIndexWritersForTests } = await importIndexWriters();
      assert.equal(runSidecar("ping", ["ping"], (r) => r.stdout.trim()), "once");
      resetIndexWritersForTests();
      assert.equal(runSidecar("ping", ["ping"], (r) => r.stdout.trim()), "once");
    });
  });
});

describe("index-writers buildIndex JS path: missing/corrupt search.idx rebuilds SearchIndex (facts msg, fp4)", () => {
  const SESSION_PATH = "/tmp/tq-iw-search-absent.jsonl";
  const CORRUPT_SESSION_PATH = "/tmp/tq-iw-search-corrupt.jsonl";
  const MTIME = 1_700_000_000_000;
  const NEEDLE = "needleabsentidxxyzzy";
  const CORRUPT_NEEDLE = "needlecorruptidxxyzzy";

  function session() {
    return { path: SESSION_PATH, file: "tq-iw-search-absent.jsonl", project: "tq-test", mtime: new Date(MTIME), source: "claude", size: 1 };
  }

  test("searchSessions finds content after search.idx deleted and JS path rebuilds", async () => {
    // indexSession emits termFreqs so the session is findable via BM25.
    let indexSessionCalls = 0;
    const indexSessionImpl = () => {
      indexSessionCalls++;
      return {
        firstPrompt: NEEDLE,
        termFreqs: new Map([[NEEDLE, 3]]),
      };
    };

    await withBuildIndexCacheHarness(
      { indexSession: indexSessionImpl },
      async ({
        tmpDir,
        indexPath,
        buildIndex,
        flushDeferredIndexWriteForTests,
        flushDeferredSearchIdxWriteForTests,
        resetIndexWritersForTests,
      }) => {
        const cacheDir = path.join(tmpDir, ".cache", "tracequest");
        const searchIdx = path.join(cacheDir, "search.idx");

        // Step 1: initial build — index.json + search.idx written.
        buildIndex([session()]);
        flushDeferredIndexWriteForTests();
        flushDeferredSearchIdxWriteForTests();
        assert.equal(indexSessionCalls, 1, "initial build indexes the session once");

        assert.ok(fs.existsSync(indexPath), "index.json must exist after first build");
        assert.ok(fs.existsSync(searchIdx), "search.idx must exist after first build");

        // Step 2: delete only search.idx (index.json remains warm).
        fs.rmSync(searchIdx);

        // Step 3: reset module + SI state to simulate a fresh process load.
        resetIndexWritersForTests();
        resetSearchIndexForTests();

        // Step 4: rebuild via JS-only path (TRACEQUEST_NO_SIDECAR=1 set by harness).
        // mtime matches, but metadata cache cannot restore SearchIndex termFreqs.
        const index = buildIndex([session()]);
        assert.equal(
          indexSessionCalls,
          2,
          "deleted search.idx with warm metadata must re-tokenize the cached session",
        );

        // Step 5: SearchIndex must have the session; searchSessions must find NEEDLE.
        const hits = searchSessions([session()], index, NEEDLE, 5);
        assert.ok(
          hits.length > 0,
          "searchSessions must find NEEDLE after search.idx deleted + JS rebuild (fact msg)",
        );
      },
    );
  });

  test("existing corrupt search.idx forces mtime-matched metadata entries to re-emit termFreqs", async () => {
    let indexSessionCalls = 0;
    const corruptSession = {
      path: CORRUPT_SESSION_PATH,
      file: "tq-iw-search-corrupt.jsonl",
      project: "tq-test",
      mtime: new Date(MTIME),
      source: "claude",
      size: 1,
    };
    const indexSessionImpl = () => {
      indexSessionCalls++;
      return {
        firstPrompt: "fresh corrupt search index prompt",
        termFreqs: new Map([[CORRUPT_NEEDLE, 4]]),
      };
    };

    await withBuildIndexCacheHarness(
      {
        diskEntries: {
          [CORRUPT_SESSION_PATH]: defaultCachedIndexEntry(MTIME, {
            firstPrompt: "metadata-only prompt",
          }),
        },
        indexSession: indexSessionImpl,
      },
      async ({ tmpDir, buildIndex, flushDeferredIndexWriteForTests }) => {
        const cacheDir = path.join(tmpDir, ".cache", "tracequest");
        const searchIdx = path.join(cacheDir, "search.idx");
        fs.writeFileSync(searchIdx, "not a valid search index");

        const index = buildIndex([corruptSession]);
        assert.equal(
          indexSessionCalls,
          1,
          "corrupt existing search.idx must re-tokenize even when index.json mtime matches",
        );

        const meta = index.get(CORRUPT_SESSION_PATH);
        assert.equal(meta.firstPrompt, "fresh corrupt search index prompt");
        assert.equal(meta.termFreqs, undefined, "termFreqs must not leak into returned metadata");
        assert.equal(meta.searchText, undefined, "searchText must not leak into returned metadata");

        const hits = searchSessions([corruptSession], index, CORRUPT_NEEDLE, 5);
        assert.equal(hits.length, 1, "rebuilt in-memory SearchIndex must find corrupt-index needle");

        flushDeferredIndexWriteForTests();
        const written = JSON.parse(fs.readFileSync(path.join(cacheDir, "index.json"), "utf-8"));
        assert.equal(written[CORRUPT_SESSION_PATH].termFreqs, undefined);
        assert.equal(written[CORRUPT_SESSION_PATH].searchText, undefined);
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Bug fix: sidecar merge must not delete SI postings for mtime-cached entries
// (facts wyt, msg)
// ---------------------------------------------------------------------------
describe("index-writers sidecar merge: cached entries without termFreqs survive SI (facts wyt, msg)", () => {
  test("sidecar-emitted termFreqs are stripped from index.json and persisted in search.idx", async () => {
    const SESSION_PATH = "/tmp/tq-sidecar-persist-termfreqs.jsonl";
    const MTIME = 4_000_000_000_000;
    const sidecarScript = `#!/usr/bin/env node
const sessionPath = ${JSON.stringify(SESSION_PATH)};
console.log(JSON.stringify({
  [sessionPath]: {
    mtime: ${MTIME},
    firstPrompt: "sidecar persistence",
    searchText: "legacy sidecar text must not persist",
    termFreqs: { sidecarpersist: 4 }
  },
}));
process.exit(0);
`;

    const tmpDir = fs.mkdtempSync("/tmp/tq-sidecar-persist-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const indexFile = path.join(cacheDir, "index.json");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      await withMockSidecarScript(sidecarScript, async () => {
        const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
        const {
          buildIndex,
          flushDeferredIndexWrites,
          initIndexWriters,
          resetIndexWritersForTests,
        } = await import(modUrl.href);
        initIndexWriters({ indexSession: () => ({}), sessionListChecksum });
        resetIndexWritersForTests();

        const session = {
          path: SESSION_PATH,
          mtime: new Date(MTIME),
          source: "claude",
          size: 1,
        };
        const index = buildIndex([session]);
        const meta = index.get(SESSION_PATH);
        assert.equal(meta.termFreqs, undefined, "termFreqs must not remain in returned metadata");
        assert.equal(meta.searchText, undefined, "searchText must not remain in returned metadata");

        flushDeferredIndexWrites();

        const written = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
        assert.equal(written[SESSION_PATH].termFreqs, undefined);
        assert.equal(written[SESSION_PATH].searchText, undefined);

        resetSearchIndexForTests();
        assert.equal(loadSearchIndex(), true);
        const loadedSI = getSearchIndex();
        assert.equal(loadedSI.has(SESSION_PATH), true, "search.idx must contain the sidecar session");
        assert.equal(loadedSI.postings.get("sidecarpersist").get(SESSION_PATH), 4);
      });
    } finally {
      process.env.HOME = originalHome;
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cached session postings survive when sidecar omits termFreqs for it", async () => {
    // Simulate a sidecar response with two entries:
    //   /fresh.jsonl — has termFreqs (freshly parsed by Rust)
    //   /cached.jsonl — no termFreqs field (mtime-cache reused by Rust)
    // Before fix: upsert(cachedPath, null) deleted SI postings for /cached.jsonl.
    // After fix: SI keeps /cached.jsonl postings untouched.

    const FRESH_PATH = "/tmp/tq-sidecar-wyt-fresh.jsonl";
    const CACHED_PATH = "/tmp/tq-sidecar-wyt-cached.jsonl";
    const MTIME_FRESH = 2_000_000_000_000;
    const MTIME_CACHED = 1_000_000_000_000;

    const sidecarScript = `#!/usr/bin/env node
const freshPath = ${JSON.stringify(FRESH_PATH)};
const cachedPath = ${JSON.stringify(CACHED_PATH)};
console.log(JSON.stringify({
  [freshPath]: { mtime: ${MTIME_FRESH}, firstPrompt: "fresh", termFreqs: { freshterm: 2 } },
  [cachedPath]: { mtime: ${MTIME_CACHED}, firstPrompt: "cached" },
}));
process.exit(0);
`;

    const tmpDir = fs.mkdtempSync("/tmp/tq-sidecar-wyt-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      // Pre-seed SI with /cached.jsonl postings (simulates a warm SI from prior run).
      const preSI = new SearchIndex();
      preSI.upsert(CACHED_PATH, new Map([["cachedterm", 5]]));
      fs.writeFileSync(path.join(cacheDir, "search.idx"), preSI.serialize());

      // Pre-seed index.json so /cached.jsonl is mtime-matched (not stale).
      const { INDEX_VERSION } = await importIndexWriters();
      fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify({
        _v: INDEX_VERSION,
        [CACHED_PATH]: {
          mtime: MTIME_CACHED, firstPrompt: "cached", model: "", tools: [], toolCounts: {},
          chapters: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, durationMs: 0, errors: 0, files: 0, commits: 0,
        },
      }));

      await withMockSidecarScript(sidecarScript, async () => {
        const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
        const { buildIndex, initIndexWriters, resetIndexWritersForTests, flushDeferredSearchIdxWriteForTests } = await import(modUrl.href);
        initIndexWriters({ indexSession: () => ({}), sessionListChecksum });
        resetIndexWritersForTests();

        const sessions = [
          { path: FRESH_PATH, mtime: new Date(MTIME_FRESH), source: "claude", size: 1 },
          { path: CACHED_PATH, mtime: new Date(MTIME_CACHED), source: "claude", size: 1 },
        ];
        buildIndex(sessions);
        flushDeferredSearchIdxWriteForTests();

        // Load the written search.idx and verify both sessions are present.
        const { loadSearchIndex, getSearchIndex: getSI, resetSearchIndexForTests: resetSI } = await import(
          new URL("../src/sessions/search-index.js", import.meta.url).href
        );
        resetSI();
        loadSearchIndex();
        const loadedSI = getSI();

        assert.ok(loadedSI.has(CACHED_PATH), "/cached.jsonl must survive in SI after sidecar merge (fact wyt)");
        assert.ok(loadedSI.has(FRESH_PATH), "/fresh.jsonl must be present in SI after sidecar merge");
        assert.equal(loadedSI.docCount, 2, "docCount must be 2 after sidecar merge with one cached entry");
      });
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("second sidecar pass leaves SI stable — no oscillation (fact wyt)", async () => {
    const FRESH_PATH = "/tmp/tq-sidecar-osc-fresh.jsonl";
    const CACHED_PATH = "/tmp/tq-sidecar-osc-cached.jsonl";
    const MTIME_FRESH = 3_000_000_000_000;
    const MTIME_CACHED = 1_500_000_000_000;

    const sidecarScript = `#!/usr/bin/env node
const freshPath = ${JSON.stringify(FRESH_PATH)};
const cachedPath = ${JSON.stringify(CACHED_PATH)};
console.log(JSON.stringify({
  [freshPath]: { mtime: ${MTIME_FRESH}, firstPrompt: "fresh", termFreqs: { term1: 1 } },
  [cachedPath]: { mtime: ${MTIME_CACHED}, firstPrompt: "cached" },
}));
process.exit(0);
`;

    const tmpDir = fs.mkdtempSync("/tmp/tq-sidecar-osc-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    fs.mkdirSync(cacheDir, { recursive: true });
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;

    try {
      const preSI = new SearchIndex();
      preSI.upsert(CACHED_PATH, new Map([["oscillationterm", 3]]));
      fs.writeFileSync(path.join(cacheDir, "search.idx"), preSI.serialize());

      const { INDEX_VERSION } = await importIndexWriters();
      fs.writeFileSync(path.join(cacheDir, "index.json"), JSON.stringify({
        _v: INDEX_VERSION,
        [CACHED_PATH]: {
          mtime: MTIME_CACHED, firstPrompt: "cached", model: "", tools: [], toolCounts: {},
          chapters: 0, totalTokens: 0, inputTokens: 0, outputTokens: 0,
          cacheReadTokens: 0, durationMs: 0, errors: 0, files: 0, commits: 0,
        },
      }));

      await withMockSidecarScript(sidecarScript, async () => {
        const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
        const { buildIndex, initIndexWriters, resetIndexWritersForTests, flushDeferredSearchIdxWriteForTests } = await import(modUrl.href);
        initIndexWriters({ indexSession: () => ({}), sessionListChecksum });
        resetIndexWritersForTests();

        const sessions = [
          { path: FRESH_PATH, mtime: new Date(MTIME_FRESH), source: "claude", size: 1 },
          { path: CACHED_PATH, mtime: new Date(MTIME_CACHED), source: "claude", size: 1 },
        ];

        // First pass
        buildIndex(sessions);
        flushDeferredSearchIdxWriteForTests();

        // Second pass with same session list — SI must remain stable
        resetIndexWritersForTests();
        buildIndex(sessions);
        flushDeferredSearchIdxWriteForTests();

        const { loadSearchIndex, getSearchIndex: getSI, resetSearchIndexForTests: resetSI } = await import(
          new URL("../src/sessions/search-index.js", import.meta.url).href
        );
        resetSI();
        loadSearchIndex();
        const loadedSI = getSI();

        assert.ok(loadedSI.has(CACHED_PATH), "/cached.jsonl must survive after second sidecar pass (no oscillation)");
        assert.ok(loadedSI.has(FRESH_PATH), "/fresh.jsonl must survive after second sidecar pass");
        assert.equal(loadedSI.docCount, 2, "docCount must remain 2 across sidecar passes");
      });
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
describe("index-writers atomic writes (fact g9o)", () => {
  test("index.json and search.idx writers use same-dir temp files before rename", () => {
    const indexWritersSource = fs.readFileSync(
      fileURLToPath(new URL("../src/sessions/index-writers.js", import.meta.url)),
      "utf-8",
    );
    assert.match(
      indexWritersSource,
      /const tmp = path \+ "\.tmp";[\s\S]*writeFileSync\(tmp, indexJson\);[\s\S]*renameSync\(tmp, path\);/,
      "index.json writer must write a same-directory temp file then rename it",
    );

    const searchIndexSource = fs.readFileSync(
      fileURLToPath(new URL("../src/sessions/search-index.js", import.meta.url)),
      "utf-8",
    );
    assert.match(
      searchIndexSource,
      /const tmp = p \+ "\.tmp";[\s\S]*writeFileSync\(tmp, serialized\);[\s\S]*renameSync\(tmp, p\);/,
      "search.idx writer must write a same-directory temp file then rename it",
    );
  });

  test("no .tmp residue after flush and index.json is valid JSON", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-atomic-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    try {
      const {
        buildIndex,
        flushDeferredIndexWriteForTests,
        flushDeferredSearchIdxWriteForTests,
        initIndexWriters,
        resetIndexWritersForTests,
      } = await importIndexWriters();
      initIndexWriters({
        indexSession: () => ({ firstPrompt: "hello" }),
        sessionListChecksum: () => 1,
      });
      resetIndexWritersForTests();

      buildIndex([{ path: "/tmp/atomic-test.jsonl", mtime: new Date(1), source: "claude", size: 1 }]);
      flushDeferredIndexWriteForTests();
      flushDeferredSearchIdxWriteForTests();

      // No .tmp residue
      const entries = fs.readdirSync(cacheDir);
      const tmpFiles = entries.filter((e) => e.endsWith(".tmp"));
      assert.deepEqual(tmpFiles, [], `unexpected .tmp residue: ${tmpFiles.join(", ")}`);

      // index.json is valid JSON with correct version
      const indexJson = JSON.parse(fs.readFileSync(path.join(cacheDir, "index.json"), "utf-8"));
      assert.equal(indexJson._v, INDEX_VERSION, "index.json must have correct version");

      // search.idx exists
      assert.ok(fs.existsSync(path.join(cacheDir, "search.idx")), "search.idx must exist after flush");
    } finally {
      process.env.HOME = originalHome;
      delete process.env.TRACEQUEST_NO_SIDECAR;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("index-writers signal flush (fact eli)", () => {
  /** Spawn a child that schedules index writes then receives the given signal; assert caches exist. */
  async function runSignalFlushChild(signal, tmpDir) {
    const INDEX_WRITERS_URL = new URL("../src/sessions/index-writers.js", import.meta.url).href;
    const SEARCH_INDEX_URL = new URL("../src/sessions/search-index.js", import.meta.url).href;
    const script = `
import { buildIndex, initIndexWriters, resetIndexWritersForTests } from ${JSON.stringify(INDEX_WRITERS_URL)};
import { scheduleSearchIdxWrite } from ${JSON.stringify(SEARCH_INDEX_URL)};
initIndexWriters({ indexSession: () => ({ firstPrompt: "signal-test" }), sessionListChecksum: () => 1 });
resetIndexWritersForTests();
buildIndex([{ path: "/tmp/signal-test.jsonl", mtime: new Date(1), source: "claude", size: 1 }]);
// Signal to parent we're ready, then block (debounce is 30s, signal should come before)
process.stdout.write("ready\\n");
setInterval(() => {}, 10_000);
`;
    const scriptFile = path.join(tmpDir, `signal-child-${signal}.mjs`);
    fs.writeFileSync(scriptFile, script);

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptFile], {
        env: { ...process.env, HOME: tmpDir, TRACEQUEST_NO_SIDECAR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let settled = false;
      const finish = (code, sig) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, signal: sig });
      };
      child.stdout.on("data", (d) => {
        stdout += d;
        if (stdout.includes("ready")) {
          // Give handlers a tick to register, then send signal
          setTimeout(() => child.kill(signal), 100);
        }
      });
      child.stderr.on("data", () => {});
      child.on("exit", (code, sig) => finish(code, sig));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (!settled) { settled = true; reject(new Error(`signal-flush child timed out`)); }
      }, 5000);
    });
  }

  async function runNormalExitFlushChild(tmpDir) {
    const INDEX_WRITERS_URL = new URL("../src/sessions/index-writers.js", import.meta.url).href;
    const script = `
import { buildIndex, initIndexWriters, resetIndexWritersForTests } from ${JSON.stringify(INDEX_WRITERS_URL)};
initIndexWriters({
  indexSession: () => ({ firstPrompt: "exit-test", termFreqs: new Map([["exitterm", 1]]) }),
  sessionListChecksum: () => 1,
});
resetIndexWritersForTests();
buildIndex([{ path: "/tmp/exit-test.jsonl", mtime: new Date(1), source: "claude", size: 1 }]);
process.exit(0);
`;
    const scriptFile = path.join(tmpDir, "exit-child.mjs");
    fs.writeFileSync(scriptFile, script);

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [scriptFile], {
        env: { ...process.env, HOME: tmpDir, TRACEQUEST_NO_SIDECAR: "1" },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          reject(new Error(`normal-exit child timed out; stderr=${stderr}`));
        }
      }, 5000);
      child.stderr.on("data", (d) => {
        stderr += d;
      });
      child.on("exit", (code, sig) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: code, signal: sig, stderr });
      });
    });
  }

  test("normal process exit flushes pending index.json and search.idx", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-exit-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    try {
      const { exitCode, signal, stderr } = await runNormalExitFlushChild(tmpDir);
      assert.equal(exitCode, 0, `expected child to exit 0; stderr=${stderr}`);
      assert.equal(signal, null);
      assert.ok(fs.existsSync(path.join(cacheDir, "index.json")), "index.json must exist after normal exit");
      const indexJson = JSON.parse(fs.readFileSync(path.join(cacheDir, "index.json"), "utf-8"));
      assert.equal(indexJson._v, INDEX_VERSION, "flushed index.json must have correct version");
      assert.ok(fs.existsSync(path.join(cacheDir, "search.idx")), "search.idx must exist after normal exit");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SIGTERM flushes pending index.json and search.idx (exit code 143)", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-sigterm-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    try {
      const { exitCode, signal } = await runSignalFlushChild("SIGTERM", tmpDir);
      // Node child_process: process killed by signal → exitCode=null, signal=name
      assert.equal(signal, "SIGTERM", `expected child to die with SIGTERM, got exitCode=${exitCode} signal=${signal}`);
      assert.ok(fs.existsSync(path.join(cacheDir, "index.json")), "index.json must exist after SIGTERM flush");
      const indexJson = JSON.parse(fs.readFileSync(path.join(cacheDir, "index.json"), "utf-8"));
      assert.equal(indexJson._v, INDEX_VERSION, "flushed index.json must have correct version");
      assert.ok(fs.existsSync(path.join(cacheDir, "search.idx")), "search.idx must exist after SIGTERM flush");
      // No .tmp residue
      const tmpFiles = fs.readdirSync(cacheDir).filter((e) => e.endsWith(".tmp"));
      assert.deepEqual(tmpFiles, [], `unexpected .tmp residue after SIGTERM: ${tmpFiles.join(", ")}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SIGINT flushes pending index.json and search.idx (exit code 130)", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/index-writers-sigint-");
    const cacheDir = path.join(tmpDir, ".cache", "tracequest");
    try {
      const { exitCode, signal } = await runSignalFlushChild("SIGINT", tmpDir);
      assert.equal(signal, "SIGINT", `expected child to die with SIGINT, got exitCode=${exitCode} signal=${signal}`);
      assert.ok(fs.existsSync(path.join(cacheDir, "index.json")), "index.json must exist after SIGINT flush");
      const indexJson = JSON.parse(fs.readFileSync(path.join(cacheDir, "index.json"), "utf-8"));
      assert.equal(indexJson._v, INDEX_VERSION, "flushed index.json must have correct version");
      assert.ok(fs.existsSync(path.join(cacheDir, "search.idx")), "search.idx must exist after SIGINT flush");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
