import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseFilterExpr, evalFilterExpr } from "../../src/filter/filter.js";
import { sessionToApiObject } from "../../src/server/server-helpers.js";
import { searchSessions } from "../../src/sessions/scan-queries.js";
import {
  flushDeferredIndexWriteForTests,
  flushDeferredSearchIdxWriteForTests,
  resetIndexWritersForTests,
} from "../../src/sessions/index-writers.js";
import {
  FIXED_NOW,
  SHARED_QUERY,
  FACTORY_DISK_ONLY,
  GROK_DISK_ONLY,
} from "../helpers/multi-source-fixtures.js";
import { withMultiSourceHarness } from "../helpers/multi-source-harness.js";

/**
 * Mirrors handleApiSessions expr narrowing + dashboard search (scan-queries).
 */
function searchWithExprFilter(sessions, index, query, opts = {}) {
  const { expr = null, maxResults = 50, now = FIXED_NOW } = opts;
  let scoped = sessions;
  if (expr?.trim()) {
    const ast = parseFilterExpr(expr);
    if (ast) {
      scoped = scoped.filter((s) => {
        const meta = index.get(s.path) || {};
        const api = sessionToApiObject(s, meta);
        api.live = false;
        return evalFilterExpr(api, ast, now);
      });
    }
  }
  return searchSessions(scoped, index, query, maxResults);
}

describe("multi-source index + search integration", () => {
  test("findSessions discovers claude, cursor, cursor-cloud, codex, factory, grok, and opencode rows", async () => {
    await withMultiSourceHarness(async ({ sessions }) => {
      assert.equal(sessions.length, 8);
      const sources = new Set(sessions.map((s) => s.source));
      assert.deepEqual(sources, new Set(["claude", "cursor", "cursor-cloud", "codex", "factory", "grok", "opencode"]));
      assert.equal(sessions.filter((s) => s.source === "factory").length, 2);
    });
  });

  test("buildIndex keys every discovered path with indexed termFreqs or firstPrompt", async () => {
    await withMultiSourceHarness(async ({ sessions, index }) => {
      for (const s of sessions) {
        assert.ok(index.has(s.path), `missing index for ${s.path}`);
        const meta = index.get(s.path);
        assert.ok(meta.firstPrompt === null || typeof meta.firstPrompt === "string");
      }
      const grokMeta = index.get(
        sessions.find((s) => s.source === "grok").path
      );
      assert.equal(grokMeta.model, "grok-3");

      const cursorMeta = index.get(
        sessions.find((s) => s.source === "cursor").path
      );
      assert.equal(cursorMeta.firstPrompt, "cursor indexed prompt");

      const factoryMeta = index.get(
        sessions.find((s) => s.source === "factory" && s.file === "run.jsonl").path
      );
      assert.ok(factoryMeta.tools.includes("Bash"));
    });
  });

  test("unfiltered search returns all eight rows matching shared query across seven sources", async () => {
    await withMultiSourceHarness(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY);
      assert.equal(hits.length, 8);
      const sources = new Set(hits.map((h) => h.source));
      assert.deepEqual(sources, new Set(["claude", "cursor", "cursor-cloud", "codex", "factory", "grok", "opencode"]));
      assert.ok(hits.every((h) => h.matches.length > 0));
    });
  });

  test("expr source:cursor returns only the Cursor Claude-family row", async () => {
    // Exact source equality: cursor-cloud must not match source:cursor (fact ccfl).
    await withMultiSourceHarness(async ({ sessions, index, paths }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:cursor",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].source, "cursor");
      assert.equal(hits[0].path, paths.cursorPath);
    });
  });

  test("expr source:cursor-cloud returns only the imported cloud-agent row", async () => {
    await withMultiSourceHarness(async ({ sessions, index, paths }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:cursor-cloud",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].source, "cursor-cloud");
      assert.equal(hits[0].path, paths.cursorCloudPath);
    });
  });

  test("expr source:factory keeps both factory jsonl sessions", async () => {
    await withMultiSourceHarness(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:factory",
      });
      assert.equal(hits.length, 2);
      assert.ok(hits.every((h) => h.source === "factory"));
    });
  });

  test("expr source:grok returns only grok session directory row", async () => {
    await withMultiSourceHarness(async ({ sessions, index, paths }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:grok",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].source, "grok");
      assert.equal(hits[0].path, paths.grokSessDir);
    });
  });

  test("expr source:opencode returns virtual opencode URI session", async () => {
    await withMultiSourceHarness(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:opencode",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].source, "opencode");
      assert.match(hits[0].path, /^opencode:\/\//);
    });
  });

  test("expr tool:Bash matches claude, factory, and grok indexed bash tools", async () => {
    await withMultiSourceHarness(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "tool:Bash",
      });
      assert.equal(hits.length, 3);
      const sources = new Set(hits.map((h) => h.source));
      assert.ok(sources.has("claude"));
      assert.ok(sources.has("factory"));
      assert.ok(sources.has("grok"));
      for (const h of hits) {
        assert.ok(index.get(h.path).tools.includes("Bash"));
      }
    });
  });

  test("expr errors:>0 returns factory error session only", async () => {
    await withMultiSourceHarness(async ({ sessions, index, paths }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "errors:>0",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].path, paths.factoryErrPath);
      assert.ok((index.get(paths.factoryErrPath).errors || 0) > 0);
    });
  });

  test("expr project:msrc-factory limits factory workspace before text scan", async () => {
    await withMultiSourceHarness(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "project:msrc-factory",
      });
      assert.equal(hits.length, 2);
      assert.ok(hits.every((h) => h.project.includes("msrc-factory")));
    });
  });

  test("factory tool_use command needle (unindexed) returns 0 BM25 hits", async () => {
    // FACTORY_DISK_ONLY is in tool_use.input.command — not pushed to termFreqs by the factory indexer.
    // BM25 cannot find content that was never indexed.
    await withMultiSourceHarness(async ({ sessions, index, paths }) => {
      const factorySession = sessions.find((s) => s.path === paths.factoryPath);
      const meta = index.get(paths.factoryPath);
      meta.firstPrompt = "";

      const hits = searchSessions([factorySession], index, FACTORY_DISK_ONLY, 5);
      assert.equal(hits.length, 0, "unindexed tool_use command not found by BM25");
    });
  });

  test("grok BM25 search finds indexed content", async () => {
    await withMultiSourceHarness(async ({ sessions, index, paths }) => {
      const grokSession = sessions.find((s) => s.path === paths.grokSessDir);
      const meta = index.get(paths.grokSessDir);
      meta.firstPrompt = "";

      const hits = searchSessions([grokSession], index, GROK_DISK_ONLY, 5);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].matches.some((m) => m.snippet.includes(GROK_DISK_ONLY)));
    });
  });

  test("persisted disk index cache still serves search after rebuild", async () => {
    await withMultiSourceHarness(async ({ sessions, buildIndex, findSessions }) => {
      flushDeferredIndexWriteForTests();
      flushDeferredSearchIdxWriteForTests();
      resetIndexWritersForTests();

      const index2 = buildIndex(findSessions(null));
      const hits = searchWithExprFilter(sessions, index2, SHARED_QUERY, {
        expr: "source:codex",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].source, "codex");
      assert.ok(hits[0].matches.length > 0);
    });
  });

  test("findSessions project prefix shrinks pool before multi-source search", async () => {
    await withMultiSourceHarness(async ({ findSessions, buildIndex }) => {
      const scoped = findSessions("msrc-alpha");
      assert.equal(scoped.length, 1);
      assert.equal(scoped[0].source, "claude");
      const index = buildIndex(scoped);
      const hits = searchWithExprFilter(scoped, index, SHARED_QUERY);
      assert.equal(hits.length, 1);
      assert.match(hits[0].path, /alpha\.jsonl$/);
    });
  });
});
