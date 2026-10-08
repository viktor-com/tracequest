/**
 * JS buildIndex (no sidecar) × Rust tracequest-sidecar buildIndex search parity.
 * Same sessions, same queries — searchSessions must return equivalent hits.
 * Skips when no built ELF sidecar is present (npm run build:sidecar).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resetIndexWritersForTests,
  INDEX_VERSION,
} from "../src/sessions/index-writers.js";
import { SIDECAR_PATH_ENV, SIDECAR_SKIP_ENV } from "./helpers/sidecar-mock.js";
import {
  SHARED_QUERY,
  FACTORY_DISK_ONLY,
  GROK_DISK_ONLY,
  seedMultiSourceFixture,
  seedOpenCodeDb,
} from "./helpers/multi-source-fixtures.js";
import {
  SIDECAR_BIN,
  SKIP_NO_SIDECAR,
  assertIndexSearchParity,
  clearDiskIndexCache,
  runParitySearch,
  useJsPipeline,
  useSidecarPipeline,
} from "./helpers/sidecar-parity-helpers.js";

async function buildJsIndex(sessions) {
  useJsPipeline();
  resetIndexWritersForTests();
  const modUrl = new URL("../src/sessions.js?" + Date.now(), import.meta.url);
  const { buildIndex } = await import(modUrl.href);
  return buildIndex(sessions);
}

async function buildSidecarIndex(sessions) {
  useSidecarPipeline();
  resetIndexWritersForTests();
  const modUrl = new URL("../src/sessions.js?" + Date.now(), import.meta.url);
  const { buildIndex } = await import(modUrl.href);
  return buildIndex(sessions);
}

async function withDualIndexHarness(fn, { seedOpenCode = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-sidecar-search-parity-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];
  const originalSidecarPath = process.env[SIDECAR_PATH_ENV];
  process.env.HOME = tmpDir;

  const paths = seedMultiSourceFixture(tmpDir);
  if (seedOpenCode) {
    await seedOpenCodeDb(tmpDir, "msrc-oc-1", `opencode side ${SHARED_QUERY}`);
  }

  try {
    resetIndexWritersForTests();
    // Pin discovery to the freshly built sidecar under test (SIDECAR_BIN).
    // Without this, findSessions runs with ambient env and detectSidecar
    // prefers a staged sidecar/bin/<platform>/ binary — which may be stale
    // and silently drop sessions from sources it predates (e.g. cursor-cloud).
    useSidecarPipeline();
    const modUrl = new URL("../src/sessions.js?" + Date.now(), import.meta.url);
    const { findSessions } = await import(modUrl.href);
    const sessions = findSessions(null);

    const jsIndex = await buildJsIndex(sessions);
    clearDiskIndexCache();
    const sidecarIndex = await buildSidecarIndex(sessions);

    await fn({ tmpDir, sessions, jsIndex, sidecarIndex, paths });
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];
    else process.env[SIDECAR_SKIP_ENV.NO_SIDECAR] = originalNoSidecar;
    if (originalSidecarPath === undefined) delete process.env[SIDECAR_PATH_ENV];
    else process.env[SIDECAR_PATH_ENV] = originalSidecarPath;
    resetIndexWritersForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("sidecar × JS index search parity (multi-source)", () => {
  test(
    "search-relevant index fields match for every discovered session",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        assert.equal(sessions.length, 8);
        for (const s of sessions) {
          assert.ok(jsIndex.has(s.path), `js index missing ${s.path}`);
          assert.ok(sidecarIndex.has(s.path), `sidecar index missing ${s.path}`);
          assertIndexSearchParity(jsIndex.get(s.path), sidecarIndex.get(s.path), s.path);
        }
        assert.equal(typeof INDEX_VERSION, "number");
      });
    },
  );

  test(
    "shared needle: eight hits with identical paths, seven sources, and snippets",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY);
        assert.equal(jsHits.length, 8);
        const sources = new Set(jsHits.map((h) => h.source));
        assert.deepEqual(sources, new Set(["claude", "cursor", "cursor-cloud", "codex", "factory", "grok", "opencode"]));
        assert.ok(jsHits.every((h) => h.matches.length > 0));
      });
    },
  );

  test(
    "expr source:cursor: single Cursor Claude-family row",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex, paths }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY, {
          expr: "source:cursor",
        });
        assert.equal(jsHits.length, 1);
        assert.equal(jsHits[0].source, "cursor");
        assert.equal(jsHits[0].path, paths.cursorPath);
      });
    },
  );

  test(
    "expr source:factory: both indexes narrow to two factory jsonl rows",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY, {
          expr: "source:factory",
        });
        assert.equal(jsHits.length, 2);
        assert.ok(jsHits.every((h) => h.source === "factory"));
      });
    },
  );

  test(
    "expr source:grok: single grok session directory hit",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex, paths }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY, {
          expr: "source:grok",
        });
        assert.equal(jsHits.length, 1);
        assert.equal(jsHits[0].path, paths.grokSessDir);
      });
    },
  );

  test(
    "expr source:opencode: virtual opencode URI row",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY, {
          expr: "source:opencode",
        });
        assert.equal(jsHits.length, 1);
        assert.equal(jsHits[0].source, "opencode");
        assert.match(jsHits[0].path, /^opencode:\/\//);
      });
    },
  );

  test(
    "expr tool:Bash: claude, factory, and grok bash-tool sessions",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY, {
          expr: "tool:Bash",
        });
        assert.equal(jsHits.length, 3);
        const sources = new Set(jsHits.map((h) => h.source));
        assert.deepEqual(sources, new Set(["claude", "factory", "grok"]));
      });
    },
  );

  test(
    "expr errors:>0: factory error session only",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex, paths }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY, {
          expr: "errors:>0",
        });
        assert.equal(jsHits.length, 1);
        assert.equal(jsHits[0].path, paths.factoryErrPath);
      });
    },
  );

  test(
    "expr project:msrc-factory: two factory workspace sessions",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY, {
          expr: "project:msrc-factory",
        });
        assert.equal(jsHits.length, 2);
        assert.ok(jsHits.every((h) => h.project.includes("msrc-factory")));
      });
    },
  );

  test(
    "claude-only deploy-marker prompt: single alpha hit",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex, paths }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, "alpha deploy-marker");
        assert.equal(jsHits.length, 1);
        assert.equal(jsHits[0].path, paths.alphaPath);
      });
    },
  );

  test(
    "codex-only rollout message: single codex hit",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex, paths }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, "codex side");
        assert.equal(jsHits.length, 1);
        assert.equal(jsHits[0].path, paths.codexPath);
      });
    },
  );

  test(
    "factory tool_use commands are not in BM25 index (disk-only); searchSessions returns empty",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        // FACTORY_DISK_ONLY is a tool_use command not indexed by the factory indexer.
        // BM25 searchSessions only searches the indexed vocabulary — disk-only content
        // is not findable via searchSessions (scanSessionForQuery is the on-demand path).
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, FACTORY_DISK_ONLY);
        assert.equal(jsHits.length, 0, "factory tool_use cmds not in BM25 index");
      });
    },
  );

  test(
    "grok chat-only phrase indexed in SearchIndex: disk-only user line",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex, paths }) => {
        const { jsHits } = runParitySearch(sessions, jsIndex, sidecarIndex, GROK_DISK_ONLY);
        assert.equal(jsHits.length, 1);
        assert.equal(jsHits[0].path, paths.grokSessDir);
      });
    },
  );

  test(
    "non-matching query: both pipelines return empty",
    SKIP_NO_SIDECAR,
    async () => {
      await withDualIndexHarness(async ({ sessions, jsIndex, sidecarIndex }) => {
        runParitySearch(sessions, jsIndex, sidecarIndex, "zzzz-no-match-needle-zzzz");
      });
    },
  );
});
