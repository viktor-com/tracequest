/**
 * Test reset/clear contract — single source of truth for module-level caches that
 * suites must clear between cases (or in afterEach) to avoid cross-test pollution.
 *
 * | Export                         | Module                              | Clears |
 * |--------------------------------|-------------------------------------|--------|
 * | resetIndexWritersForTests      | src/sessions/index-writers.js       | index file mtime/cache, result Map cache, deferred write timer, bundled sidecar path memo (TRACEQUEST_SIDECAR_PATH is never memoized) |
 * | flushDeferredIndexWriteForTests| src/sessions/index-writers.js       | pending INDEX_WRITE_DELAY_MS timer; sync-writes _indexFileCache to disk |
 * | clearRouteCache                  | src/routes/route-cache.js           | single-slot route handler cache |
 * | clearLiveSessionsCache           | src/sessions/live-sessions.js       | 5s detectLiveSessions memo |
 * | clearOpenCodeDiscoveryCache      | src/sessions/session-discovery.js   | OpenCode SQLite row cache keyed by DB mtime |
 * | _resetDataUpdateTimerForTests    | src/server/server-live-reload.js    | SSE data-update debounce timer |
 * | _resetWatchersStartedForTests    | src/server/server-live-reload.js    | fs.watch handles + _watchersStarted flag |
 * | _resetModVersionForTests         | src/server/server-live-reload.js    | hot-reload generation counter (_modVersion) |
 * | resetHotModulesCacheForTests     | src/server/server-state.js          | hotModules _lastV / _mods memo |
 *
 * Parallel modVersion suites: installModVersionTestHygiene() in test/helpers/mod-version-hygiene.js
 * (serializes via _acquireModVersionTestIsolation, then restores baseline + caches in afterEach).
 *
 * Introspection (not a reset): _watchersStartedForTests in server-live-reload.js.
 *
 * Hygiene: after swapping TRACEQUEST_SIDECAR_PATH or mock binaries, call
 * resetIndexWritersForTests(). Most suites set TRACEQUEST_NO_SIDECAR=1.
 */
import { describe, test, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { seedOpenCodeDiscoveryDb } from "./helpers/opencode-db-fixtures.js";
import { sessionListChecksum } from "../src/sessions/session-list.js";
import { INDEX_VERSION } from "../src/sessions/index-writers.js";
import { SearchIndex } from "../src/sessions/search-index.js";
import {
  buildRouteCacheKey,
  clearRouteCache,
  peekRouteCache,
  storeRouteCache,
} from "../src/routes/route-cache.js";
import { detectLiveSessions, clearLiveSessionsCache } from "../src/sessions/live-sessions.js";
import {
  triggerDataUpdate,
  lrClients,
  startLiveReloadWatchers,
  DATA_UPDATE_DEBOUNCE_MS,
  _resetDataUpdateTimerForTests,
  _resetWatchersStartedForTests,
  _watchersStartedForTests,
} from "../src/server/server-live-reload.js";

/** Canonical registry — keep in sync with src exports when adding new test resets. */
export const TEST_RESET_HELPERS = [
  {
    name: "resetIndexWritersForTests",
    module: "../src/sessions/index-writers.js",
    kind: "reset",
    clears: "index caches, deferred write timer, bundled sidecar path memo",
  },
  {
    name: "flushDeferredIndexWriteForTests",
    module: "../src/sessions/index-writers.js",
    kind: "flush",
    clears: "pending deferred index write (then persists cache)",
  },
  {
    name: "clearRouteCache",
    module: "../src/routes/route-cache.js",
    kind: "clear",
    clears: "route handler sessions/index slot",
  },
  {
    name: "clearLiveSessionsCache",
    module: "../src/sessions/live-sessions.js",
    kind: "clear",
    clears: "detectLiveSessions 5s TTL memo",
  },
  {
    name: "clearOpenCodeDiscoveryCache",
    module: "../src/sessions/session-discovery.js",
    kind: "clear",
    clears: "OpenCode DB query cache",
  },
  {
    name: "_resetDataUpdateTimerForTests",
    module: "../src/server/server-live-reload.js",
    kind: "reset",
    clears: "SSE data-update debounce timer",
  },
  {
    name: "_resetWatchersStartedForTests",
    module: "../src/server/server-live-reload.js",
    kind: "reset",
    clears: "fs.watch handles and watchers-started flag",
  },
  {
    name: "_resetModVersionForTests",
    module: "../src/server/server-live-reload.js",
    kind: "reset",
    clears: "hot-reload generation counter",
  },
  {
    name: "resetHotModulesCacheForTests",
    module: "../src/server/server-state.js",
    kind: "reset",
    clears: "hotModules version memo and cached export bundle",
  },
];

async function importFresh(moduleRelPath) {
  const url = new URL(moduleRelPath + "?" + Date.now(), import.meta.url);
  return import(url.href);
}

const SESSION_PATH = "/tmp/tq-reset-contract/sess.jsonl";
const MTIME = 1_700_000_000_000;

function defaultCachedIndexEntry(mtime) {
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
  };
}

function session(overrides = {}) {
  return {
    path: SESSION_PATH,
    mtime: new Date(MTIME),
    source: "claude",
    size: 1,
    ...overrides,
  };
}

async function withIndexWritersHarness(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-reset-iw-"));
  const cacheDir = path.join(tmpDir, ".cache", "tracequest");
  fs.mkdirSync(cacheDir, { recursive: true });
  const indexPath = path.join(cacheDir, "index.json");
  fs.writeFileSync(
    indexPath,
    JSON.stringify({ _v: INDEX_VERSION, [SESSION_PATH]: defaultCachedIndexEntry(MTIME) })
  );
  // Write a warm search.idx so mtime-matched sessions are found in SI
  // and not force-re-indexed (fact msg: re-tokenize only when absent from SI).
  const warmSI = new SearchIndex();
  warmSI.upsert(SESSION_PATH, new Map([["__warm__", 1]]));
  fs.writeFileSync(path.join(cacheDir, "search.idx"), warmSI.serialize());

  const originalHome = process.env.HOME;
  const hadNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  try {
    const {
      buildIndex,
      initIndexWriters,
      resetIndexWritersForTests,
      flushDeferredIndexWriteForTests,
    } = await importFresh("../src/sessions/index-writers.js");

    initIndexWriters({
      indexSession: () => ({ firstPrompt: "fresh-index" }),
      sessionListChecksum,
    });
    resetIndexWritersForTests();

    await fn({
      tmpDir,
      indexPath,
      buildIndex,
      resetIndexWritersForTests,
      flushDeferredIndexWriteForTests,
    });
  } finally {
    process.env.HOME = originalHome;
    if (hadNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = hadNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("test reset contract registry", () => {
  test("TEST_RESET_HELPERS lists every documented reset/clear export", async () => {
    assert.ok(TEST_RESET_HELPERS.length >= 7, "registry must cover all test hygiene exports");
    const names = new Set(TEST_RESET_HELPERS.map((h) => h.name));
    assert.equal(names.size, TEST_RESET_HELPERS.length, "no duplicate registry entries");

    for (const entry of TEST_RESET_HELPERS) {
      const mod = await importFresh(entry.module);
      assert.equal(typeof mod[entry.name], "function", `${entry.name} must be exported`);
      assert.ok(entry.clears.length > 0, `${entry.name} must document what it clears`);
    }
  });

  test("registry entries use reset, clear, or flush kinds only", () => {
    const allowed = new Set(["reset", "clear", "flush"]);
    for (const entry of TEST_RESET_HELPERS) {
      assert.ok(allowed.has(entry.kind), `${entry.name} kind must be reset|clear|flush`);
    }
  });
});

describe("resetIndexWritersForTests contract", () => {
  test("drops cached result Map so buildIndex rebuilds", async () => {
    await withIndexWritersHarness(async ({ buildIndex, resetIndexWritersForTests }) => {
      const map1 = buildIndex([session()]);
      const map2 = buildIndex([session()]);
      assert.equal(map1, map2, "cache hit before reset");

      resetIndexWritersForTests();
      const map3 = buildIndex([session()]);
      assert.notEqual(map1, map3, "reset must drop cached result Map");
      assert.equal(map3.get(SESSION_PATH).firstPrompt, "cached");
    });
  });

  test("is idempotent — second call does not throw", async () => {
    await withIndexWritersHarness(async ({ resetIndexWritersForTests }) => {
      assert.doesNotThrow(() => {
        resetIndexWritersForTests();
        resetIndexWritersForTests();
      });
    });
  });
});

describe("flushDeferredIndexWriteForTests contract", () => {
  test("persists in-memory index cache without waiting for debounce", async () => {
    await withIndexWritersHarness(async ({ buildIndex, flushDeferredIndexWriteForTests, indexPath }) => {
      buildIndex([session({ path: "/tmp/tq-reset-contract/new.jsonl", mtime: new Date(MTIME + 1) })]);
      const before = fs.existsSync(indexPath) ? fs.statSync(indexPath).mtimeMs : 0;
      flushDeferredIndexWriteForTests();
      const after = fs.statSync(indexPath).mtimeMs;
      assert.ok(after >= before, "flush must write index.json to disk");
      const raw = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      assert.ok(raw["/tmp/tq-reset-contract/new.jsonl"], "flushed cache must include new session");
    });
  });
});

describe("clearRouteCache contract", () => {
  afterEach(() => clearRouteCache());

  test("evicts stored peekRouteCache entry", () => {
    const key = "reset-contract-route";
    storeRouteCache(key, [{ path: "/fake/x.jsonl", mtime: new Date(), size: 0 }], new Map());
    assert.ok(peekRouteCache(key));
    clearRouteCache();
    assert.equal(peekRouteCache(key), null);
  });

  test("is idempotent", () => {
    clearRouteCache();
    assert.doesNotThrow(() => clearRouteCache());
    assert.equal(peekRouteCache(buildRouteCacheKey("after-double-clear")), null);
  });
});

describe("clearLiveSessionsCache contract", () => {
  afterEach(() => clearLiveSessionsCache());

  test("forces new array reference before TTL expires", () => {
    const first = detectLiveSessions([]);
    clearLiveSessionsCache();
    const second = detectLiveSessions([]);
    assert.notStrictEqual(second, first);
    assert.deepEqual(second, first);
  });

  test("is idempotent", () => {
    detectLiveSessions([]);
    assert.doesNotThrow(() => {
      clearLiveSessionsCache();
      clearLiveSessionsCache();
    });
    assert.doesNotThrow(() => detectLiveSessions([]));
  });

  test("repopulates 5s memo — third call within TTL reuses post-clear snapshot", () => {
    const first = detectLiveSessions([]);
    clearLiveSessionsCache();
    const second = detectLiveSessions([]);
    const third = detectLiveSessions([]);
    assert.notStrictEqual(second, first);
    assert.strictEqual(third, second);
    assert.deepEqual(third, second);
  });
});

describe("clearOpenCodeDiscoveryCache contract", () => {
  test("sees new SQLite rows after in-place DB edit", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-reset-oc-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "first", msgCount: 3 }]);
      const { findOpenCodeSessions, clearOpenCodeDiscoveryCache } = await importFresh(
        "../src/sessions/session-discovery.js"
      );

      const out1 = [];
      findOpenCodeSessions(null, out1);
      assert.equal(out1.length, 1);

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.prepare(
        `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("second", "S2", "/tmp/x", "1", 3000, 3000);
      const m = db.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
      for (let i = 0; i < 3; i++) m.run("second", "user", "m");
      db.close();

      clearOpenCodeDiscoveryCache();
      const out2 = [];
      findOpenCodeSessions(null, out2);
      assert.equal(out2.length, 2);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("server-live-reload test resets contract", () => {
  afterEach(() => {
    _resetDataUpdateTimerForTests();
    _resetWatchersStartedForTests();
    lrClients.clear();
    mock.timers.reset();
  });

  test("_resetDataUpdateTimerForTests allows a second debounced broadcast", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const payloads = [];
    lrClients.add({ write: (p) => payloads.push(p) });

    triggerDataUpdate();
    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);
    assert.equal(payloads.length, 1);

    triggerDataUpdate();
    assert.equal(payloads.length, 1, "timer still armed — second trigger is coalesced");

    _resetDataUpdateTimerForTests();
    triggerDataUpdate();
    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);
    assert.equal(payloads.length, 2, "reset must allow another debounced data-update");
  });

  test("_resetWatchersStartedForTests closes watchers and permits restart", () => {
    const savedSkip = process.env.TRACEQUEST_SKIP_LR_WATCH;
    delete process.env.TRACEQUEST_SKIP_LR_WATCH;
    const tmpDir = mkdtempSync(join(tmpdir(), "tq-reset-lr-"));
    const dataRoot = join(tmpDir, "sessions");
    const srcDir = join(tmpDir, "src");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "");

    try {
      startLiveReloadWatchers({
        srcDir: pathToFileURL(srcDir),
        dataRoots: [dataRoot],
        openCodeDbPath: dbPath,
      });
      assert.equal(_watchersStartedForTests(), true);

      _resetWatchersStartedForTests();
      assert.equal(_watchersStartedForTests(), false);

      startLiveReloadWatchers({
        srcDir: pathToFileURL(srcDir),
        dataRoots: [dataRoot],
        openCodeDbPath: dbPath,
      });
      assert.equal(_watchersStartedForTests(), true);
    } finally {
      _resetWatchersStartedForTests();
      rmSync(tmpDir, { recursive: true, force: true });
      if (savedSkip === undefined) {
        delete process.env.TRACEQUEST_SKIP_LR_WATCH;
      } else {
        process.env.TRACEQUEST_SKIP_LR_WATCH = savedSkip;
      }
    }
  });
});