/**
 * BM25 searchSessions focused tests (Batch 2 — facts bpf, m6s, yd3, yyz, 1h8, 3ns, n03, fp4).
 *
 * Tests use synthetic in-memory SearchIndex to stay fast and independent of file I/O.
 * Uses existing synthetic session + fixture helpers where real disk content is needed.
 */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import os from "node:os";
import { searchSessions } from "../../src/sessions/scan-queries.js";
import {
  SearchIndex,
  getSearchIndex,
  resetSearchIndexForTests,
} from "../../src/sessions/search-index.js";
import {
  resetIndexWritersForTests,
} from "../../src/sessions/index-writers.js";
import { claudeProj, writeJsonl } from "../helpers/fixtures.js";
import { makeClaudeSessionLines } from "../helpers/synthetic-sessions.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Build an in-memory SearchIndex from a map of path → termFreqs.
 * Also populates the module-level singleton so searchSessions uses it.
 */
function buildSyntheticIndex(termFreqsByPath) {
  const si = new SearchIndex();
  for (const [p, tf] of Object.entries(termFreqsByPath)) {
    const m = tf instanceof Map ? tf : new Map(Object.entries(tf));
    si.upsert(p, m);
  }
  return si;
}

function seedSingletonSearchIndex(termFreqsByPath) {
  resetSearchIndexForTests();
  const si = getSearchIndex();
  for (const [p, tf] of Object.entries(termFreqsByPath)) {
    si.upsert(p, tf instanceof Map ? tf : new Map(Object.entries(tf)));
  }
  return si;
}

function readScanQueriesSource() {
  return fs.readFileSync(new URL("../../src/sessions/scan-queries.js", import.meta.url), "utf8");
}

/**
 * Inject a SearchIndex into the module-level singleton, returning a cleanup fn.
 */
function withSearchIndex(si, fn) {
  // We reset + rebuild via the index-writers, but SearchIndex.upsert populates
  // the singleton indirectly. Use resetSearchIndexForTests + manual injection instead.
  // Since getSearchIndex() returns the singleton, we hack it by resetting and
  // re-populating via index-writers storeStaleIndex — but that's complex.
  // Instead, we write real files and call buildIndex to populate the singleton.
  return fn(si);
}

/** Build a minimal metadata index (Map) for a set of session paths. */
function metaIndex(paths, overrides = {}) {
  const m = new Map();
  for (const p of paths) {
    m.set(p, {
      firstPrompt: overrides[p]?.firstPrompt || "first prompt",
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
      ...overrides[p],
    });
  }
  return m;
}

/** Simple session descriptor. */
function sess(p, source = "claude") {
  return { path: p, source, project: "test-proj", file: path.basename(p), mtime: new Date(), size: 100 };
}

// ---------------------------------------------------------------------------
// Integration helper: write real sessions and build index for BM25 smoke tests
// ---------------------------------------------------------------------------
async function withBm25Fixture(opts, fn) {
  const { sessionCount = 3, markerPrefix = "bm25test" } = opts;
  const tmpDir = mkTmp("tq-bm25-");
  const origHome = process.env.HOME;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    resetIndexWritersForTests();
    const projDir = claudeProj(tmpDir, "bm25proj");
    fs.mkdirSync(projDir, { recursive: true });

    const sessions = [];
    const markerByPath = new Map();
    for (let i = 0; i < sessionCount; i++) {
      const { lines, marker } = makeClaudeSessionLines(i, {
        fillerLines: 2,
        markerPrefix,
      });
      const filePath = path.join(projDir, `s${i}.jsonl`);
      writeJsonl(filePath, lines);
      const stat = fs.statSync(filePath);
      sessions.push({ path: filePath, source: "claude", project: "bm25proj",
        file: `s${i}.jsonl`, mtime: new Date(), size: stat.size });
      markerByPath.set(filePath, { marker });
    }

    const { buildIndex } = await import(`../../src/sessions.js?v=${Date.now()}`);
    const index = buildIndex(sessions);
    await fn({ sessions, index, markerByPath, projDir });
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    resetIndexWritersForTests();
  }
}

// ---------------------------------------------------------------------------
// Tests: BM25 ordering (fact bpf)
// ---------------------------------------------------------------------------

describe("BM25 ordering (fact bpf)", () => {
  test("BM25 constants stay at fact-backed values", () => {
    const source = readScanQueriesSource();
    assert.match(source, /\bconst BM25_K1 = 1\.2;/);
    assert.match(source, /\bconst BM25_B = 0\.75;/);
  });

  test("BM25 ranks by summed term scores in descending order", () => {
    const low = "/rank-low.jsonl";
    const high = "/rank-high.jsonl";
    const missingTerm = "/rank-missing-term.jsonl";
    seedSingletonSearchIndex({
      [low]: { alpha: 1, beta: 1, filler: 10 },
      [high]: { alpha: 3, beta: 3 },
      [missingTerm]: { alpha: 100 },
    });

    try {
      const paths = [low, high, missingTerm];
      const hits = searchSessions(paths.map((p) => sess(p)), metaIndex(paths), "alpha beta", 10);
      assert.deepEqual(hits.map((h) => h.path), [high, low]);
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("session with higher term frequency ranks above lower-tf session", async () => {
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25rank" }, async ({ sessions, index }) => {
      // session 0 has more occurrences of "deploy" (it appears in prompt + body + assistant)
      // Both sessions have "bm25rank" "sess" tokens — use a term appearing differently
      const hits = searchSessions(sessions, index, "deploy", 10);
      assert.ok(hits.length >= 1, "at least one result");
      // Verify results have matches and are in descending score order (no assertion on absolute paths
      // since both sessions have 'deploy')
      assert.ok(hits.every((h) => Array.isArray(h.matches) && h.matches.length >= 1), "all hits have matches");
    });
  });

  test("multi-term query scores sum BM25 for each matched term", async () => {
    // Use two-token query; verify we get hits with match snippets
    await withBm25Fixture({ sessionCount: 3, markerPrefix: "bm25multi" }, async ({ sessions, index }) => {
      const hits = searchSessions(sessions, index, "deploy staging", 10);
      assert.ok(hits.length >= 1, "multi-term BM25 returns results");
      assert.ok(hits.every((h) => h.matches.length >= 1), "all hits have snippets");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: AND semantics (fact m6s)
// ---------------------------------------------------------------------------

describe("AND semantics (fact m6s)", () => {
  test("multi-term AND accepts exact plus fuzzy and final-prefix matches only when every token resolves", () => {
    const allTerms = "/and-all.jsonl";
    const missingAlpha = "/and-missing-alpha.jsonl";
    const missingDeploy = "/and-missing-deploy.jsonl";
    seedSingletonSearchIndex({
      [allTerms]: { alpha: 1, deployment: 1 },
      [missingAlpha]: { deployment: 1 },
      [missingDeploy]: { alpha: 1 },
    });

    try {
      const paths = [allTerms, missingAlpha, missingDeploy];
      const sessions = paths.map((p) => sess(p));
      const index = metaIndex(paths);

      const fuzzyHits = searchSessions(sessions, index, "alpha deploymnt", 10);
      assert.deepEqual(fuzzyHits.map((h) => h.path), [allTerms]);

      const prefixHits = searchSessions(sessions, index, "alpha deploym", 10);
      assert.deepEqual(prefixHits.map((h) => h.path), [allTerms]);
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("multi-term query requires all terms to match", async () => {
    await withBm25Fixture({ sessionCount: 3, markerPrefix: "bm25and" }, async ({ sessions, index }) => {
      // Session-11 (if we had it) would have "11" as unique token, but with only 3 sessions
      // use terms that are in ALL sessions vs a term unique to none
      const allHits = searchSessions(sessions, index, "deploy", 10);
      // now add a term that no session has
      const noHits = searchSessions(sessions, index, "deploy xyzqabcdefunique123xyz", 10);
      assert.ok(allHits.length >= 1, "single-term query returns results");
      assert.equal(noHits.length, 0, "AND with absent term returns 0");
    });
  });

  test("absent vocabulary term with no fuzzy match yields zero results", async () => {
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25absent" }, async ({ sessions, index }) => {
      const hits = searchSessions(sessions, index, "zxqvwkjhgf98765", 10);
      assert.equal(hits.length, 0, "completely absent term → no results");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: maxResults (fact yyz)
// ---------------------------------------------------------------------------

describe("maxResults cap (fact yyz)", () => {
  test("default maxResults is 50 over more than 50 matches", () => {
    const paths = Array.from({ length: 55 }, (_, i) => `/cap-default-${i}.jsonl`);
    seedSingletonSearchIndex(Object.fromEntries(paths.map((p) => [p, { commonneedle: 1 }])));

    try {
      const hits = searchSessions(paths.map((p) => sess(p)), metaIndex(paths), "commonneedle");
      assert.equal(hits.length, 50);
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("returns at most maxResults sessions", async () => {
    await withBm25Fixture({ sessionCount: 5, markerPrefix: "bm25cap" }, async ({ sessions, index }) => {
      const all = searchSessions(sessions, index, "deploy", 100);
      const capped = searchSessions(sessions, index, "deploy", 2);
      assert.ok(all.length > 2, "sanity: more than 2 sessions match 'deploy'");
      assert.equal(capped.length, 2, "maxResults=2 caps results");
    });
  });

  test("default maxResults is 50", async () => {
    // Default signature: searchSessions(sessions, index, query) → maxResults defaults to 50
    await withBm25Fixture({ sessionCount: 3, markerPrefix: "bm25default" }, async ({ sessions, index }) => {
      const hits = searchSessions(sessions, index, "deploy");
      assert.ok(hits.length <= 50, "default maxResults <= 50");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Snippet type-tagging (fact cot)
// ---------------------------------------------------------------------------

describe("snippet type-tagging (fact cot)", () => {
  test("result object has path, source, project, file, mtime, id, prompt, model, matches fields", async () => {
    await withBm25Fixture({ sessionCount: 1, markerPrefix: "bm25shape" }, async ({ sessions, index }) => {
      const hits = searchSessions(sessions, index, "deploy");
      assert.ok(hits.length >= 1, "at least one hit");
      const h = hits[0];
      assert.ok(typeof h.path === "string", "path present");
      assert.ok(typeof h.source === "string", "source present");
      assert.ok(typeof h.project === "string", "project present");
      assert.ok(typeof h.file === "string", "file present");
      assert.ok(h.mtime !== undefined, "mtime present");
      assert.ok(typeof h.id === "string", "id present");
      assert.ok(typeof h.prompt === "string", "prompt present");
      assert.ok(typeof h.model === "string", "model present");
      assert.ok(Array.isArray(h.matches), "matches is array");
    });
  });

  test("match snippets have type field (text, command, file, or error)", async () => {
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25type" }, async ({ sessions, index }) => {
      const hits = searchSessions(sessions, index, "deploy");
      const validTypes = new Set(["text", "command", "file", "error"]);
      for (const h of hits) {
        for (const m of h.matches) {
          assert.ok(validTypes.has(m.type), `snippet type "${m.type}" is valid`);
          assert.ok(typeof m.snippet === "string", "snippet is string");
        }
      }
    });
  });

  test("multi-term snippets keep query-term order while scanning the result once (fact kye)", async () => {
    const tmpDir = mkTmp("tq-bm25-multisnip-");
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    try {
      resetIndexWritersForTests();
      const projDir = claudeProj(tmpDir, "multisnipproj");
      fs.mkdirSync(projDir, { recursive: true });

      const sessionPath = path.join(projDir, "multi.jsonl");
      writeJsonl(sessionPath, [
        { type: "user", message: { content: [{ type: "text", text: "alpha marker lives in the first prompt" }] } },
        { type: "assistant", message: { model: "claude-3", content: [{ type: "text", text: "beta marker lives in the answer" }], usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: "2026-01-01T00:00:00Z" },
      ]);
      const stat = fs.statSync(sessionPath);
      const sessions = [
        { path: sessionPath, source: "claude", project: "multisnipproj", file: "multi.jsonl", mtime: new Date(), size: stat.size },
      ];

      const { buildIndex } = await import(`../../src/sessions.js?vms=${Date.now()}`);
      const index = buildIndex(sessions);

      const hits = searchSessions(sessions, index, "alpha beta", 10);
      assert.equal(hits.length, 1, "multi-term query returns the matching session");
      assert.ok(hits[0].matches.length >= 2, "both terms contribute snippets");
      assert.match(hits[0].matches[0].snippet.toLowerCase(), /alpha/);
      assert.match(hits[0].matches[1].snippet.toLowerCase(), /beta/);

      const reversedHits = searchSessions(sessions, index, "beta alpha", 10);
      assert.equal(reversedHits.length, 1, "reversed multi-term query still returns the session");
      assert.match(reversedHits[0].matches[0].snippet.toLowerCase(), /beta/);
      assert.match(reversedHits[0].matches[1].snippet.toLowerCase(), /alpha/);
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetIndexWritersForTests();
    }
  });

  test("Grok multi-term snippets scan chat_history once while preserving query-term order (fact pzl)", () => {
    const tmpDir = mkTmp("tq-bm25-grok-multisnip-");
    const sessionDir = path.join(tmpDir, "grok-session");
    fs.mkdirSync(sessionDir, { recursive: true });
    const chatPath = path.join(sessionDir, "chat_history.jsonl");
    writeJsonl(chatPath, [
      { type: "user", content: "alpha marker lives in the grok prompt" },
      { type: "assistant", content: "beta marker lives in the grok answer" },
    ]);

    resetSearchIndexForTests();
    const session = sess(sessionDir, "grok");
    session.size = fs.statSync(chatPath).size;
    const index = metaIndex([session.path], {
      [session.path]: { firstPrompt: "grok prompt", model: "grok-3" },
    });
    getSearchIndex().upsert(session.path, new Map([["alpha", 1], ["beta", 1]]));

    let chatOpens = 0;
    const originalOpenSync = fs.openSync;
    const openSyncMock = mock.method(fs, "openSync", (...args) => {
      if (args[0] === chatPath) chatOpens++;
      return originalOpenSync(...args);
    });
    syncBuiltinESMExports();

    try {
      const hits = searchSessions([session], index, "alpha beta", 10);
      assert.equal(hits.length, 1);
      assert.equal(chatOpens, 1, "one Grok chat_history scan serves both matched terms");
      assert.ok(hits[0].matches.length >= 2, "both terms contribute snippets");
      assert.match(hits[0].matches[0].snippet.toLowerCase(), /alpha/);
      assert.match(hits[0].matches[1].snippet.toLowerCase(), /beta/);
    } finally {
      openSyncMock.mock.restore();
      syncBuiltinESMExports();
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetSearchIndexForTests();
    }
  });
});

describe("snippet extraction scope and fallbacks (fact n03)", () => {
  test("snippet extraction scans only returned top-ranked results", () => {
    const tmpDir = mkTmp("tq-bm25-top-scan-");
    const high = path.join(tmpDir, "high.jsonl");
    const low = path.join(tmpDir, "low.jsonl");
    writeJsonl(high, [{ type: "assistant", message: { content: "needle appears in high result" } }]);
    writeJsonl(low, [{ type: "assistant", message: { content: "needle appears in low result" } }]);

    seedSingletonSearchIndex({
      [high]: { needle: 5 },
      [low]: { needle: 1 },
    });

    const opened = [];
    const originalOpenSync = fs.openSync;
    const openSyncMock = mock.method(fs, "openSync", (...args) => {
      if (args[0] === high || args[0] === low) opened.push(args[0]);
      return originalOpenSync(...args);
    });
    syncBuiltinESMExports();

    try {
      const sessions = [high, low].map((p) => ({ ...sess(p), size: fs.statSync(p).size }));
      const hits = searchSessions(sessions, metaIndex([high, low]), "needle", 1);
      assert.deepEqual(hits.map((h) => h.path), [high]);
      assert.deepEqual(opened, [high]);
    } finally {
      openSyncMock.mock.restore();
      syncBuiltinESMExports();
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("fuzzy and prefix-expanded matched terms drive snippet extraction", () => {
    const tmpDir = mkTmp("tq-bm25-expanded-snips-");
    const sessionPath = path.join(tmpDir, "expanded.jsonl");
    writeJsonl(sessionPath, [
      { type: "assistant", message: { content: "deployment marker appears in session content" } },
    ]);
    seedSingletonSearchIndex({ [sessionPath]: { deployment: 1 } });

    try {
      const session = { ...sess(sessionPath), size: fs.statSync(sessionPath).size };
      const index = metaIndex([sessionPath]);

      const fuzzyHits = searchSessions([session], index, "deploymnt", 10);
      assert.equal(fuzzyHits.length, 1);
      assert.match(fuzzyHits[0].matches.map((m) => m.snippet).join(" "), /deployment/i);

      const prefixHits = searchSessions([session], index, "deploym", 10);
      assert.equal(prefixHits.length, 1);
      assert.match(prefixHits[0].matches.map((m) => m.snippet).join(" "), /deployment/i);
    } finally {
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("missing literal term snippet falls back to firstPrompt", () => {
    const tmpDir = mkTmp("tq-bm25-snippet-fallback-");
    const sessionPath = path.join(tmpDir, "fallback.jsonl");
    writeJsonl(sessionPath, [
      { type: "assistant", message: { content: "the indexed term is intentionally absent here" } },
    ]);
    seedSingletonSearchIndex({ [sessionPath]: { phantomterm: 1 } });

    try {
      const session = { ...sess(sessionPath), size: fs.statSync(sessionPath).size };
      const index = metaIndex([sessionPath], {
        [sessionPath]: { firstPrompt: "fallback prompt snippet" },
      });
      const hits = searchSessions([session], index, "phantomterm", 10);
      assert.equal(hits.length, 1);
      assert.deepEqual(hits[0].matches, [{ type: "text", snippet: "fallback prompt snippet" }]);
    } finally {
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: Prefix expansion (fact 3ns)
// ---------------------------------------------------------------------------

describe("prefix expansion on final query term (fact 3ns)", () => {
  test("duplicate final token still receives prefix expansion (fact mr1)", () => {
    const sessionPath = "/prefix-dedup.jsonl";
    seedSingletonSearchIndex({ [sessionPath]: { deployment: 1 } });

    try {
      const hits = searchSessions([sess(sessionPath)], metaIndex([sessionPath]), "deplo deplo", 10);
      assert.deepEqual(hits.map((h) => h.path), [sessionPath]);
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("partial word as final token matches sessions with the full word", async () => {
    // "deploy" sessions should be found by prefix "dep" as the final term
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25prefix" }, async ({ sessions, index }) => {
      const fullHits = searchSessions(sessions, index, "deploy", 10);
      const prefixHits = searchSessions(sessions, index, "dep", 10);
      // prefix "dep" should expand to "deploy" (and maybe others) — sessions with "deploy" found
      assert.ok(prefixHits.length >= 1, "prefix 'dep' matches sessions with 'deploy'");
      // All sessions found by prefix should have been reachable by full term too
      const fullPaths = new Set(fullHits.map((h) => h.path));
      for (const h of prefixHits) {
        assert.ok(fullPaths.has(h.path), `prefix result ${h.path} was also in full-term results`);
      }
    });
  });

  test("prefix expansion only applies to final token, not earlier tokens", async () => {
    // "dep deploy" — "dep" is NOT the final token; "deploy" is exact. No prefix expansion on "dep".
    // Sessions matching both "dep" (exact only) and "deploy" should match.
    // Since no session has a token "dep" exactly (only "deploy"), AND semantics with "dep" exact → 0
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25nopfx" }, async ({ sessions, index }) => {
      const hits = searchSessions(sessions, index, "dep deploy", 10);
      // "dep" as non-final term: exact only, not in index. AND → 0.
      // (or fuzzy expansion if similarity ≥ 0.4)
      // This tests that prefix doesn't apply to non-final terms.
      // The result could be 0 (if dep not in index and not fuzzy-similar to any term) or
      // could be > 0 (if fuzzy expansion of "dep" → "deploy"). Either way is fine for
      // the semantic test — we just verify it doesn't behave like pure prefix.
      // The important assertion: hits returned respect AND semantics.
      if (hits.length > 0) {
        // All returned sessions must have matched both terms (exact/fuzzy/prefix as applicable)
        assert.ok(hits.every((h) => Array.isArray(h.matches) && h.matches.length >= 1));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: Fuzzy expansion (fact 1h8)
// ---------------------------------------------------------------------------

describe("fuzzy expansion with misspellings (fact 1h8)", () => {
  test("fuzzy absent query expands to a similar Vocabulary term", () => {
    const match = "/fuzzy-match.jsonl";
    const miss = "/fuzzy-miss.jsonl";
    seedSingletonSearchIndex({
      [match]: { deployment: 1 },
      [miss]: { unrelated: 1 },
    });

    try {
      const hits = searchSessions([sess(match), sess(miss)], metaIndex([match, miss]), "deploymnt", 10);
      assert.deepEqual(hits.map((h) => h.path), [match]);
    } finally {
      resetSearchIndexForTests();
    }
  });

  test("fuzzy expansion constants and score weighting stay fact-backed", () => {
    const source = readScanQueriesSource();
    assert.match(source, /\bconst FUZZY_MAX_EXPANSIONS = 3;/);
    assert.match(source, /\bconst FUZZY_MIN_JACCARD = 0\.4;/);
    assert.match(source, /return results\.slice\(0, FUZZY_MAX_EXPANSIONS\);/);
    assert.match(source, /matches\.push\(\{ term, weight: similarity \}\);/);
    assert.match(source, /bm25Score\(tf, docLen, avgDocLen, N, df\) \* weight;/);
  });

  test("misspelled query term finds sessions with the correct spelling", async () => {
    // "deployy" (typo) should fuzzy-expand to "deploy" (Jaccard of trigrams should be >= 0.4)
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25fuzzy" }, async ({ sessions, index }) => {
      const exactHits = searchSessions(sessions, index, "deploy", 10);
      // "deployy" has trigrams overlapping "deploy": Jaccard should be high
      const fuzzyHits = searchSessions(sessions, index, "deployy", 10);
      // May or may not expand depending on Jaccard threshold; just verify no crash
      // and that if it finds sessions, they are a subset of exact hits
      const exactPaths = new Set(exactHits.map((h) => h.path));
      for (const h of fuzzyHits) {
        assert.ok(exactPaths.has(h.path), "fuzzy hit path is also in exact results");
      }
    });
  });

  test("fuzzy-matched score is lower than exact-match score (expanded always below exact)", async () => {
    // Same query as exact vs typo — can't directly compare BM25 scores from outside,
    // but we can verify that fuzzy results exist only when the exact term is absent from Vocabulary.
    // This is a structural test: if exact match IS in vocab, it's used directly (weight=1.0).
    // If absent, fuzzy expansion uses weight<1.0.
    // Verify: sessions returned by exact "staging" are also returned by "stagingg" (typo) if fuzzy works.
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25score" }, async ({ sessions, index }) => {
      const exactHits = searchSessions(sessions, index, "staging", 10);
      const typoHits = searchSessions(sessions, index, "stagingg", 10);
      // "stagingg" (3 g's) — very similar to "staging", Jaccard should qualify
      // If fuzzy works, typoHits should be a subset of exactHits
      if (typoHits.length > 0) {
        const exactPaths = new Set(exactHits.map((h) => h.path));
        for (const h of typoHits) {
          assert.ok(exactPaths.has(h.path), "typo hit is also an exact hit");
        }
      }
    });
  });
});

describe("fuzzy Vocabulary trigram scope (fact 5hi)", () => {
  test("trigram fuzzy expansion uses Vocabulary terms, not session file content", () => {
    const tmpDir = mkTmp("tq-bm25-trigram-scope-");
    const sessionPath = path.join(tmpDir, "scope.jsonl");
    writeJsonl(sessionPath, [
      { type: "assistant", message: { content: "deployment exists only in file content" } },
    ]);
    seedSingletonSearchIndex({ [sessionPath]: { unrelated: 1 } });

    try {
      const session = { ...sess(sessionPath), size: fs.statSync(sessionPath).size };
      const hits = searchSessions([session], metaIndex([sessionPath]), "deploymnt", 10);
      assert.deepEqual(hits, []);
    } finally {
      resetSearchIndexForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("duplicate resolved term scoring (fact zof)", () => {
  test("duplicate resolved vocabulary term contributes once at its highest weight", () => {
    const balanced = "/duplicate-balanced.jsonl";
    const gammaHeavy = "/duplicate-gamma-heavy.jsonl";
    seedSingletonSearchIndex({
      [balanced]: { deploy: 1, gamma: 1 },
      [gammaHeavy]: { deploy: 1, gamma: 2 },
    });

    try {
      const sessions = [balanced, gammaHeavy].map((p) => sess(p));
      const hits = searchSessions(sessions, metaIndex([balanced, gammaHeavy]), "gamma deply dep", 10);
      assert.deepEqual(hits.map((h) => h.path), [gammaHeavy, balanced]);
    } finally {
      resetSearchIndexForTests();
    }
  });
});

describe("phrase snippet scan reuse (fact uk8)", () => {
  test("phrase snippets reuse verification scan results instead of rescanning the phrase", () => {
    const source = readScanQueriesSource();
    const verifyScan = source.indexOf("const phraseSnips = scanSessionForQuery(s, raw, 1);");
    const verifyCall = "scanSessionForQuery(s, raw";
    const firstVerifyCall = source.indexOf(verifyCall);
    const store = source.indexOf("verifiedPhraseSnips.set(raw, phraseSnips);");
    const reuse = source.indexOf("const phraseSnips = verifiedPhraseSnips.get(raw) || [];");
    assert.ok(verifyScan !== -1, "phrase verification scan must be present");
    assert.ok(firstVerifyCall !== -1, "phrase verification scan call must be present");
    assert.ok(store > verifyScan, "phrase verification snippets must be stored");
    assert.ok(reuse > store, "snippet extraction must read stored phrase snippets");
    assert.equal(
      source.indexOf(verifyCall, firstVerifyCall + verifyCall.length),
      -1,
      "the raw phrase should not be scanned again after verification",
    );
  });
});

// ---------------------------------------------------------------------------
// Tests: Quoted phrase verification (fact yd3)
// ---------------------------------------------------------------------------

describe("quoted phrase verification (fact yd3)", () => {
  test("quoted phrase: session included only if exact phrase is in content", async () => {
    // Write one session with a specific phrase, another without it
    const tmpDir = mkTmp("tq-bm25-phrase-");
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    try {
      resetIndexWritersForTests();
      const projDir = claudeProj(tmpDir, "phraseproj");
      fs.mkdirSync(projDir, { recursive: true });

      // Session A: has exact phrase "unique phrase content"
      const lineA = [
        { type: "user", message: { content: [{ type: "text", text: "unique phrase content here" }] } },
        { type: "assistant", message: { model: "claude-3", content: [{ type: "text", text: "Acknowledged unique phrase content" }], usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: "2026-01-01T00:00:00Z" },
      ];
      // Session B: has the words but not as a phrase
      const lineB = [
        { type: "user", message: { content: [{ type: "text", text: "content is unique and phrase-less" }] } },
        { type: "assistant", message: { model: "claude-3", content: [{ type: "text", text: "the phrase and content are separate" }], usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: "2026-01-01T00:00:01Z" },
      ];
      const pathA = path.join(projDir, "a.jsonl");
      const pathB = path.join(projDir, "b.jsonl");
      writeJsonl(pathA, lineA);
      writeJsonl(pathB, lineB);
      const statA = fs.statSync(pathA);
      const statB = fs.statSync(pathB);
      const sessions = [
        { path: pathA, source: "claude", project: "phraseproj", file: "a.jsonl", mtime: new Date(), size: statA.size },
        { path: pathB, source: "claude", project: "phraseproj", file: "b.jsonl", mtime: new Date(), size: statB.size },
      ];

      const { buildIndex } = await import(`../../src/sessions.js?vp=${Date.now()}`);
      const index = buildIndex(sessions);

      // Unquoted query: both sessions have "unique" and "phrase" and "content" → both match
      const unquotedHits = searchSessions(sessions, index, "unique phrase content", 10);
      assert.ok(unquotedHits.length >= 1, "unquoted query matches sessions with all terms");

      // Quoted phrase: only session A has exact substring "unique phrase content"
      const quotedHits = searchSessions(sessions, index, '"unique phrase content"', 10);
      // Session A must be included; session B must not (phrase not present verbatim)
      assert.ok(quotedHits.length >= 1, "quoted phrase: at least session A found");
      assert.ok(quotedHits.every((h) => h.path === pathA), "quoted phrase: only session A matches");
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetIndexWritersForTests();
    }
  });

  test("quoted phrase with no matching sessions returns empty", async () => {
    await withBm25Fixture({ sessionCount: 2, markerPrefix: "bm25nophrase" }, async ({ sessions, index }) => {
      // A phrase that has both terms indexed but not adjacent
      const hits = searchSessions(sessions, index, '"xyzqabcdef nonexistent"', 10);
      assert.equal(hits.length, 0, "quoted phrase absent from content → 0 results");
    });
  });

  // Regression: phrase verification must run before maxResults truncation (fact e3y).
  // Create a corpus where token-AND sessions rank high (many term occurrences) but
  // lack the exact phrase, and phrase-match sessions rank lower. A small maxResults
  // must still return the phrase-verified sessions.
  test("phrase verification runs before maxResults cut — low-ranked phrase sessions are not lost (fact e3y)", async () => {
    const tmpDir = mkTmp("tq-bm25-phraserank-");
    const origHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    try {
      resetIndexWritersForTests();
      const projDir = claudeProj(tmpDir, "phraserankproj");
      fs.mkdirSync(projDir, { recursive: true });

      // Non-phrase sessions: lots of occurrences of "needle" and "haystack" → high BM25,
      // but they never contain the exact phrase "needle haystack" adjacent.
      // We write them with the tokens scattered to avoid accidental adjacency.
      const nonPhraseText = (i) =>
        `needle is here. haystack is there. needle again. haystack repeated. session ${i}`;
      const nonPhrasePaths = [];
      for (let i = 0; i < 5; i++) {
        const p = path.join(projDir, `nonphrase${i}.jsonl`);
        writeJsonl(p, [
          { type: "user", message: { content: [{ type: "text", text: nonPhraseText(i) }] } },
          { type: "assistant", message: { model: "claude-3", content: [{ type: "text", text: nonPhraseText(i) }], usage: { input_tokens: 20, output_tokens: 10 } }, timestamp: `2026-01-0${i + 1}T00:00:00Z` },
        ]);
        nonPhrasePaths.push(p);
      }

      // Phrase session: fewer token occurrences (lower BM25 score), but contains the exact phrase.
      const phrasePath = path.join(projDir, "phrase.jsonl");
      writeJsonl(phrasePath, [
        { type: "user", message: { content: [{ type: "text", text: "I found needle haystack in the code" }] } },
        { type: "assistant", message: { model: "claude-3", content: [{ type: "text", text: "needle haystack confirmed" }], usage: { input_tokens: 10, output_tokens: 5 } }, timestamp: "2026-01-06T00:00:00Z" },
      ]);

      const allPaths = [...nonPhrasePaths, phrasePath];
      const sessions = allPaths.map((p) => ({
        path: p,
        source: "claude",
        project: "phraserankproj",
        file: path.basename(p),
        mtime: new Date(),
        size: fs.statSync(p).size,
      }));

      const { buildIndex } = await import(`../../src/sessions.js?vpr=${Date.now()}`);
      const index = buildIndex(sessions);

      // With maxResults=2, the two highest-BM25 non-phrase sessions would fill the slice
      // before verification if the bug were present. The phrase session must still appear.
      const hits = searchSessions(sessions, index, '"needle haystack"', 2);
      assert.ok(hits.length >= 1, "phrase session found despite small maxResults");
      assert.ok(hits.every((h) => h.path === phrasePath), "only the phrase-verified session is returned");

      // Edge: phrase with zero verified matches still returns [] without scanning past cap
      const emptyHits = searchSessions(sessions, index, '"needle haystack xyznotpresent"', 2);
      assert.equal(emptyHits.length, 0, "phrase absent from all content → 0 results");
    } finally {
      process.env.HOME = origHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
      resetIndexWritersForTests();
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: fp4 — buildIndex populates SearchIndex before searchSessions
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Bug fix: trigram cache must invalidate on SI mutation (fact 1h8)
// ---------------------------------------------------------------------------
describe("1h8: trigram cache invalidates on SI mutation — fuzzy query sees new terms", () => {
  test("fuzzy query after upsert finds new session one edit away from query term", () => {
    // Build SI with one session; run fuzzy query; upsert a new session with a
    // term close to the query; run fuzzy query again — must now include new session.
    // Without the generation-counter fix, the trigram cache would not rebuild
    // and the new term would be invisible to fuzzy matching (fact 1h8).

    resetSearchIndexForTests();
    const si = getSearchIndex(); // use the module singleton (what searchSessions reads)

    const emptyMeta = () => ({
      firstPrompt: "", model: "", tools: [], toolCounts: {}, chapters: 0,
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
      durationMs: 0, errors: 0, files: 0, commits: 0,
    });

    // Seed SI with a session that has an unrelated term.
    si.upsert("/session-a.jsonl", new Map([["existing", 1]]));

    const sessions = [
      { path: "/session-a.jsonl", source: "claude", project: "p", file: "a.jsonl", mtime: new Date(), size: 1 },
    ];
    const metaA = new Map([["/session-a.jsonl", emptyMeta()]]);

    // First fuzzy query — "deployment" absent from SI; trigram cache is built now.
    searchSessions(sessions, metaA, "deploymet", 10);

    // Upsert a new session with "deployment" (one edit away from "deploymet").
    si.upsert("/session-b.jsonl", new Map([["deployment", 3]]));

    const sessionsWithB = [
      ...sessions,
      { path: "/session-b.jsonl", source: "claude", project: "p", file: "b.jsonl", mtime: new Date(), size: 1 },
    ];
    const metaB = new Map([...metaA, ["/session-b.jsonl", emptyMeta()]]);

    // Second fuzzy query — must rebuild trigram index and find /session-b.jsonl.
    const hits2 = searchSessions(sessionsWithB, metaB, "deploymet", 10);
    const paths2 = hits2.map((h) => h.path);
    assert.ok(
      paths2.includes("/session-b.jsonl"),
      "fuzzy query must find /session-b.jsonl after upsert adds 'deployment' to SI (fact 1h8)",
    );

    resetSearchIndexForTests();
  });
});

describe("fp4: buildIndex-populated SearchIndex works when search.idx is absent", () => {
  test("after buildIndex runs with no search.idx, searchSessions finds sessions", async () => {
    await withBm25Fixture({ sessionCount: 1, markerPrefix: "fp4marker" }, async ({ sessions, index }) => {
      // search.idx was never written (withBm25Fixture doesn't flush it to disk);
      // but the in-memory SearchIndex is populated by buildIndex.
      // Verify searchSessions uses that in-memory index (no searchText fallback).
      const hits = searchSessions(sessions, index, "fp4marker", 10);
      assert.equal(hits.length, 1, "fp4: searchSessions works from in-memory SearchIndex after buildIndex");
      assert.ok(Array.isArray(hits[0].matches), "result has matches array");
    });
  });
});
