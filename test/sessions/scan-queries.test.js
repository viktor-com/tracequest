import { test, describe } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseFilterExpr, evalFilterExpr } from "../../src/filter/filter.js";
import { sessionToApiObject } from "../../src/server/server-helpers.js";
import {
  searchSessions,
  extractSnippets,
  scanSessionForQuery,
  scanGrokForQuery,
  scanOpenCodeForQuery,
} from "../../src/sessions/scan-queries.js";
import { coerceSidecarSessionMtimes } from "../../src/sessions/session-index-core.js";
import { getSearchIndex, resetSearchIndexForTests } from "../../src/sessions/search-index.js";
import { accumulateTermFreqs, TOKENIZER_INPUT_CAP } from "../../src/sessions/search-tokenizer.js";
import { resetIndexWritersForTests } from "../../src/sessions/index-writers.js";
import { writeJsonl } from "../helpers/fixtures.js";
import { withMockSidecarScript } from "../helpers/sidecar-mock.js";
import { assertPerf } from "../helpers/perf-assert.js";

function makeTermFreqs(text) {
  const tf = new Map();
  accumulateTermFreqs(text, tf, [TOKENIZER_INPUT_CAP]);
  return tf;
}

const NOW = Date.parse("2026-06-03T12:00:00Z");

/** Mirrors dashboard search: path-prefix scope, optional expr filter, then scan-queries. */
function runBehavioralSearch(sessions, index, query, opts = {}) {
  const { pathPrefix = null, expr = null, maxResults = 50 } = opts;
  let scoped = sessions;
  if (pathPrefix) {
    scoped = scoped.filter((s) => (s.project || "").includes(pathPrefix));
  }
  if (expr?.trim()) {
    const ast = parseFilterExpr(expr);
    if (ast) {
      scoped = scoped.filter((s) => {
        const meta = index.get(s.path) || {};
        const api = sessionToApiObject(s, meta);
        api.live = false;
        return evalFilterExpr(api, ast, NOW);
      });
    }
  }
  return searchSessions(scoped, index, query, maxResults);
}

function makeSession(path, overrides = {}) {
  return {
    path,
    source: "claude",
    project: "scanproj-a",
    file: path.split("/").pop(),
    mtime: new Date(NOW),
    size: 64,
    ...overrides,
  };
}

function indexFor(paths, metaByPath = {}) {
  const index = new Map();
  for (const p of paths) {
    index.set(p, {
      firstPrompt: "unrelated",
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
      ...metaByPath[p],
    });
  }
  return index;
}

describe("scan-queries behavioral pipeline", () => {
  test("empty index Map yields no hits even when sessions are listed", () => {
    const sessions = [makeSession("/tmp/a.jsonl"), makeSession("/tmp/b.jsonl")];
    const results = runBehavioralSearch(sessions, new Map(), "needle");
    assert.equal(results.length, 0);
  });

  test("sessions without index entries are skipped (missing path key)", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/partial-index.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor(["/other/path.jsonl"]);
    const si = getSearchIndex();
    si.upsert("/other/path.jsonl", makeTermFreqs("needle in haystack"));
    const results = runBehavioralSearch(sessions, index, "needle");
    assert.equal(results.length, 0);
  });

  test("indexed BM25 hit avoids disk scan", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/indexed.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "deploy" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("deploy production ssh pipeline"));
    const results = runBehavioralSearch(sessions, index, "ssh");
    assert.equal(results.length, 1);
    // Snippet may come from firstPrompt fallback since file doesn't exist on disk
    assert.ok(results[0].matches.length > 0);
  });

  test("session in SI returns on-disk snippet when file exists", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-beh-scan-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ command: "grep behavioral-needle src/" }),
        JSON.stringify({ file_path: "/unused" }),
      ].join("\n")
    );
    const stat = fs.statSync(filePath);
    const sessions = [
      {
        path: filePath,
        source: "claude",
        project: "scanproj-a",
        file: "session.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      },
    ];
    const index = indexFor([filePath], { [filePath]: { firstPrompt: "hi" } });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("behavioral-needle grep command"));
    try {
      const results = runBehavioralSearch(sessions, index, "behavioral-needle");
      assert.equal(results.length, 1);
      assert.ok(results[0].matches.some((m) => m.type === "command" && m.snippet.includes("behavioral-needle")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("filter expr source:claude excludes codex-shaped rows from search scope", () => {
    resetSearchIndexForTests();
    const claudePath = "/tmp/claude.jsonl";
    const codexPath = "/tmp/codex.jsonl";
    const sessions = [
      makeSession(claudePath, { source: "claude", project: "p" }),
      makeSession(codexPath, { source: "codex", project: "p" }),
    ];
    const index = indexFor([claudePath, codexPath], {
      [claudePath]: { source: "claude" },
      [codexPath]: { source: "codex" },
    });
    const si = getSearchIndex();
    si.upsert(claudePath, makeTermFreqs("shared-token-alpha"));
    si.upsert(codexPath, makeTermFreqs("shared-token-alpha"));
    const results = runBehavioralSearch(sessions, index, "shared-token", {
      expr: "source:claude",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].source, "claude");
  });

  test("filter expr project:scanproj-a AND errors:>0 narrows before search", () => {
    resetSearchIndexForTests();
    const a = "/tmp/a.jsonl";
    const b = "/tmp/b.jsonl";
    const sessions = [
      makeSession(a, { project: "scanproj-a" }),
      makeSession(b, { project: "scanproj-b" }),
    ];
    const index = indexFor([a, b], {
      [a]: { errors: 3, project: "scanproj-a" },
      [b]: { errors: 0, project: "scanproj-b" },
    });
    const si = getSearchIndex();
    si.upsert(a, makeTermFreqs("errorfix token"));
    si.upsert(b, makeTermFreqs("errorfix token"));
    const results = runBehavioralSearch(sessions, index, "errorfix", {
      expr: "project:scanproj-a AND errors:>0",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].project, "scanproj-a");
  });

  test("path prefix scope limits search to matching project substring", () => {
    resetSearchIndexForTests();
    const a = "/tmp/alpha.jsonl";
    const b = "/tmp/beta.jsonl";
    const sessions = [
      makeSession(a, { project: "scanproj-alpha" }),
      makeSession(b, { project: "scanproj-beta" }),
    ];
    const index = indexFor([a, b]);
    const si = getSearchIndex();
    si.upsert(a, makeTermFreqs("prefixneedle in alpha"));
    si.upsert(b, makeTermFreqs("prefixneedle in beta"));
    const results = runBehavioralSearch(sessions, index, "prefixneedle", {
      pathPrefix: "scanproj-alpha",
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].path, a);
  });

  test("maxResults caps behavioral output across indexed hits", () => {
    resetSearchIndexForTests();
    const sessions = [];
    const index = new Map();
    const si = getSearchIndex();
    for (let i = 0; i < 5; i++) {
      const p = `/tmp/s${i}.jsonl`;
      sessions.push(makeSession(p, { file: `s${i}.jsonl` }));
      index.set(p, { firstPrompt: `p${i}` });
      si.upsert(p, makeTermFreqs("capneedle everywhere"));
    }
    const results = runBehavioralSearch(sessions, index, "capneedle", { maxResults: 2 });
    assert.equal(results.length, 2);
  });

  test("firstPrompt match returns placeholder snippet when session in SI", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/prompt-only.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "unique-prompt-needle here" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("unique-prompt-needle here"));
    const results = runBehavioralSearch(sessions, index, "unique-prompt-needle");
    assert.equal(results.length, 1);
    assert.ok(
      results[0].matches.some(
        (m) => m.type === "text" && (m.snippet.includes("unique-prompt-needle") || m.snippet.includes("match in session"))
      )
    );
  });
});

describe("scan-queries behavioral findSessions integration", () => {
  async function withTmpHome(fn) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-beh-home-"));
    const originalHome = process.env.HOME;
    const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    resetIndexWritersForTests();
    try {
      const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
      const mod = await import(modUrl.href);
      await fn(tmpDir, mod);
    } finally {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  test("JS discovery fallback: findSessions path prefix + buildIndex + search", async () => {
    await withTmpHome(async (tmpDir, { findSessions, buildIndex, searchSessions: modSearch }) => {
      const projDir = path.join(tmpDir, ".claude", "projects", "scanproj-find");
      fs.mkdirSync(projDir, { recursive: true });
      const hit = path.join(projDir, "hit.jsonl");
      const miss = path.join(projDir, "miss.jsonl");
      // Use claude-format JSONL so peekClaude can extract termFreqs for BM25
      fs.writeFileSync(hit, JSON.stringify({ type: "user", message: { content: "findneedle-ok task" } }));
      fs.writeFileSync(miss, JSON.stringify({ type: "user", message: { content: "unrelated other task" } }));

      const sessions = findSessions("scanproj-find");
      assert.equal(sessions.length, 2);
      const index = buildIndex(sessions);
      const results = modSearch(sessions, index, "findneedle", 50);
      assert.equal(results.length, 1);
      assert.equal(results[0].file, "hit.jsonl");
    });
  });

  test("sidecar-shaped scan rows coerce mtime then remain searchable", async () => {
    await withTmpHome(async (_tmpDir, { buildIndex, searchSessions: modSearch }) => {
      const filePath = path.join(_tmpDir, ".claude", "projects", "p", "sidecar.jsonl");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      // Use claude-format JSONL so peekClaude can extract termFreqs for BM25
      fs.writeFileSync(filePath, JSON.stringify({ type: "user", message: { content: "sidecar-needle-run task" } }));
      const stat = fs.statSync(filePath);
      const sidecarJson = [
        {
          path: filePath,
          project: "p",
          file: "sidecar.jsonl",
          size: stat.size,
          mtime: stat.mtime.getTime(),
          source: "claude",
        },
      ];
      const sessions = coerceSidecarSessionMtimes(structuredClone(sidecarJson));
      assert.ok(sessions[0].mtime instanceof Date);
      const index = buildIndex(sessions);
      const results = modSearch(sessions, index, "sidecar-needle", 50);
      assert.equal(results.length, 1);
      assert.ok(results[0].matches.length > 0);
    });
  });

  test("fake sidecar binary scan+index integrates with searchSessions", async () => {
    const mockPath = "/tmp/tq-sidecar-mock.jsonl";
    const mockMtime = NOW;
    const fakeScript = `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === "scan") {
  console.log(JSON.stringify([{
    path: ${JSON.stringify(mockPath)},
    project: "mocksidecar",
    file: "tq-sidecar-mock.jsonl",
    size: 1,
    mtime: ${mockMtime},
    source: "claude"
  }]));
  process.exit(0);
}
if (cmd === "index") {
  let raw = "[]";
  if (process.argv.includes("--sessions-stdin")) {
    raw = require("node:fs").readFileSync(0, "utf8");
  } else {
    const i = process.argv.indexOf("--sessions-json");
    raw = process.argv[i + 1] || "[]";
  }
  const parsed = JSON.parse(raw);
  const sessions = Array.isArray(parsed) ? parsed : parsed.sessions;
  const out = {};
  for (const s of sessions) {
    out[s.path] = {
      mtime: s.mtime,
      firstPrompt: "sidecar indexed",
      termFreqs: { "mock": 1, "sidecar": 1, "needle": 1 },
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
      commits: 0
    };
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}
process.exit(1);
`;

    await withMockSidecarScript(fakeScript, async () => {
      const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
      const { findSessions, buildIndex, searchSessions: modSearch } = await import(modUrl.href);
      const sessions = findSessions(null);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].path, mockPath);
      assert.ok(sessions[0].mtime instanceof Date);

      const index = buildIndex(sessions);
      // Use modSearch (same module chain as buildIndex) so the SearchIndex is consistent
      const results = modSearch(sessions, index, "mock-sidecar-needle");
      assert.equal(results.length, 1);
      // The mock sidecar emits termFreqs for SearchIndex matching; snippet
      // extraction can still fall back to firstPrompt when no file content exists.
      assert.ok(results[0].matches.length > 0);
    });
  });
});

describe("scan-queries searchSessions", () => {
  test("finds matches via BM25 SearchIndex without fs read", () => {
    resetSearchIndexForTests();
    const sessions = [
      {
        path: "/fake/s1.jsonl",
        source: "claude",
        project: "myproj",
        file: "s1.jsonl",
        mtime: new Date("2026-05-01"),
      },
    ];
    const index = new Map();
    index.set("/fake/s1.jsonl", {
      firstPrompt: "list files",
      model: "claude-3",
    });
    const si = getSearchIndex();
    si.upsert("/fake/s1.jsonl", makeTermFreqs("user ran bash ls and edited file.txt with error"));
    const results = searchSessions(sessions, index, "bash", 5);
    assert.ok(results.length >= 1);
    const r = results[0];
    assert.equal(r.path, "/fake/s1.jsonl");
    assert.equal(r.source, "claude");
    assert.ok(r.matches && r.matches.length > 0);
    assert.ok(r.id);
  });

  test("returns BM25 hits with snippet fallback to firstPrompt (file absent)", () => {
    resetSearchIndexForTests();
    const sessions = [
      {
        path: "/fake/s2.jsonl",
        source: "claude",
        project: "myproj",
        file: "s2.jsonl",
        mtime: new Date("2026-05-02"),
      },
    ];
    const index = new Map();
    index.set("/fake/s2.jsonl", {
      firstPrompt: "deploy app",
      model: "claude-3",
    });
    const si = getSearchIndex();
    si.upsert("/fake/s2.jsonl", makeTermFreqs("deploy to production server using ssh command"));

    const results = searchSessions(sessions, index, "ssh", 5);
    assert.equal(results.length, 1);
    // File doesn't exist on disk, so snippet falls back to firstPrompt
    assert.ok(results[0].matches.length > 0);
  });

  test("returns empty for empty or whitespace query", () => {
    assert.equal(searchSessions([], new Map(), "").length, 0);
    assert.equal(searchSessions([], new Map(), "   ").length, 0);
    assert.equal(searchSessions([], new Map(), "\t\n").length, 0);
    assert.deepEqual(searchSessions([], new Map(), null), []);
  });

  test("trims query before match (leading/trailing whitespace still hits)", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/trim-query.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "deploy" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("deploy via ssh tunnel"));
    const results = searchSessions(sessions, index, "  ssh  ");
    assert.equal(results.length, 1);
    assert.ok(results[0].matches.length > 0);
  });

  test("searchSessions is fast with BM25 SI hits (no per-session disk scan)", async () => {
    resetSearchIndexForTests();
    const sessions = [];
    const index = new Map();
    const si = getSearchIndex();
    for (let i = 0; i < 50; i++) {
      const p = `/tmp/tq-search-prompt-skip-${i}.jsonl`;
      sessions.push(makeSession(p, { file: `search-prompt-skip-${i}.jsonl` }));
      index.set(p, { firstPrompt: `prompt-${i} sharedneedle` });
      si.upsert(p, makeTermFreqs("sharedneedle token"));
    }
    const ITERS = 30;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) searchSessions(sessions, index, "sharedneedle", 50);
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 50,
      `expected searchSessions under 50ms/op with 50 BM25 hits, got ${ms.toFixed(2)}ms`,
    );

    const hits = searchSessions(sessions, index, "sharedneedle", 50);
    assert.equal(hits.length, 50);
    assert.ok(hits[0].matches.length > 0);
  });

  test("searchSessions snippets:false skips disk scans", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-search-nosnip-"));
    const filePath = path.join(tmpDir, "s.jsonl");
    try {
      writeJsonl(filePath, [
        { type: "user", message: { content: [{ type: "text", text: "DISKSNIPPETONLY token" }] } },
      ]);
      const sessions = [makeSession(filePath)];
      const index = indexFor([filePath], {
        [filePath]: { firstPrompt: "INDEXPROMPTONLY token" },
      });
      const si = getSearchIndex();
      si.upsert(filePath, makeTermFreqs("token DISKSNIPPETONLY INDEXPROMPTONLY"));

      const noScan = searchSessions(sessions, index, "token", 5, { snippets: false });
      assert.equal(noScan.length, 1);
      assert.equal(noScan[0].prompt, "INDEXPROMPTONLY token");
      const snipText = (noScan[0].matches || []).map((m) => m.snippet).join(" ");
      assert.match(snipText, /INDEXPROMPTONLY/);
      assert.doesNotMatch(snipText, /DISKSNIPPETONLY/);

      const withScan = searchSessions(sessions, index, "token", 5);
      const scanText = (withScan[0].matches || []).map((m) => m.snippet).join(" ");
      assert.match(scanText, /DISKSNIPPETONLY/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("searchSessions matches prompt-only needle when indexed in SI via firstPrompt", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/prompt-only-hit.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "PROMPTONLYMARKER start" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("PROMPTONLYMARKER start"));
    const results = searchSessions(sessions, index, "promptonlymarker");
    assert.equal(results.length, 1);
    assert.ok(results[0].matches.length > 0);
  });

  test("result order follows BM25 score (equal scores preserve input order)", () => {
    resetSearchIndexForTests();
    const first = "/tmp/rank-first.jsonl";
    const second = "/tmp/rank-second.jsonl";
    const third = "/tmp/rank-third.jsonl";
    const sessions = [
      makeSession(first, { file: "rank-first.jsonl" }),
      makeSession(second, { file: "rank-second.jsonl" }),
      makeSession(third, { file: "rank-third.jsonl" }),
    ];
    const index = indexFor([first, second, third], {
      [first]: { firstPrompt: "a" },
      [second]: { firstPrompt: "b" },
      [third]: { firstPrompt: "c" },
    });
    const si = getSearchIndex();
    si.upsert(first, makeTermFreqs("rankneedle alpha"));
    si.upsert(second, makeTermFreqs("rankneedle beta"));
    si.upsert(third, makeTermFreqs("rankneedle gamma"));
    const results = searchSessions(sessions, index, "rankneedle");
    assert.equal(results.length, 3);
    // All three should be returned (order by BM25 score, equal scores possible)
    const files = results.map((r) => r.file);
    assert.ok(files.includes("rank-first.jsonl"));
    assert.ok(files.includes("rank-second.jsonl"));
    assert.ok(files.includes("rank-third.jsonl"));
  });

  test("stops after maxResults and does not include later indexed matches", () => {
    resetSearchIndexForTests();
    const sessions = [];
    const index = new Map();
    const si = getSearchIndex();
    for (let i = 0; i < 6; i++) {
      const p = `/tmp/rank-cap-${i}.jsonl`;
      sessions.push(makeSession(p, { file: `rank-cap-${i}.jsonl` }));
      index.set(p, { firstPrompt: `p${i}` });
      si.upsert(p, makeTermFreqs("rankcapneedle shared"));
    }
    const results = searchSessions(sessions, index, "rankcapneedle", 3);
    assert.equal(results.length, 3);
  });

  test("recent sort materializes only newest maxResults matches", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-search-recent-cap-"));
    const newestPath = path.join(tmpDir, "newest.jsonl");
    const middlePath = path.join(tmpDir, "middle.jsonl");
    const oldPoisonPath = path.join(tmpDir, "old-poison.jsonl");
    try {
      writeJsonl(newestPath, [
        { type: "user", message: { content: [{ type: "text", text: "recentcapneedle newest" }] } },
      ]);
      writeJsonl(middlePath, [
        { type: "user", message: { content: [{ type: "text", text: "recentcapneedle middle" }] } },
      ]);
      fs.mkdirSync(oldPoisonPath);

      const sessions = [
        makeSession(oldPoisonPath, { file: "old-poison.jsonl", mtime: new Date(NOW - 3000) }),
        makeSession(middlePath, { file: "middle.jsonl", mtime: new Date(NOW - 1000) }),
        makeSession(newestPath, { file: "newest.jsonl", mtime: new Date(NOW) }),
      ];
      const index = indexFor([oldPoisonPath, middlePath, newestPath], {
        [oldPoisonPath]: { firstPrompt: "old high relevance" },
        [middlePath]: { firstPrompt: "middle" },
        [newestPath]: { firstPrompt: "newest" },
      });
      const si = getSearchIndex();
      si.upsert(oldPoisonPath, makeTermFreqs(`${"recentcapneedle ".repeat(30)}old`));
      si.upsert(middlePath, makeTermFreqs("recentcapneedle middle"));
      si.upsert(newestPath, makeTermFreqs("recentcapneedle newest"));

      const recent = searchSessions(sessions, index, "recentcapneedle", 2, { sort: "recent" });
      assert.deepEqual(recent.map((r) => r.path), [newestPath, middlePath]);

      const dateAlias = searchSessions(sessions, index, "recentcapneedle", 2, { sort: "date" });
      assert.deepEqual(dateAlias.map((r) => r.path), [newestPath, middlePath]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recent-sorted quoted phrase search respects phraseScanCap", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-search-phrase-cap-"));
    const newestPath = path.join(tmpDir, "newest-nonphrase.jsonl");
    const middlePath = path.join(tmpDir, "middle-nonphrase.jsonl");
    const olderExactPath = path.join(tmpDir, "older-exact.jsonl");
    const phrase = "recent phrase cap";
    const nonPhraseText = "recent phrase scattered cap";
    const exactText = `older exact ${phrase} match`;
    try {
      writeJsonl(newestPath, [
        { type: "user", message: { content: [{ type: "text", text: nonPhraseText }] } },
      ]);
      writeJsonl(middlePath, [
        { type: "user", message: { content: [{ type: "text", text: nonPhraseText }] } },
      ]);
      writeJsonl(olderExactPath, [
        { type: "user", message: { content: [{ type: "text", text: exactText }] } },
      ]);

      const sessions = [
        makeSession(newestPath, { file: "newest-nonphrase.jsonl", mtime: new Date(NOW) }),
        makeSession(middlePath, { file: "middle-nonphrase.jsonl", mtime: new Date(NOW - 1000) }),
        makeSession(olderExactPath, { file: "older-exact.jsonl", mtime: new Date(NOW - 2000) }),
      ];
      const index = indexFor([newestPath, middlePath, olderExactPath], {
        [newestPath]: { firstPrompt: nonPhraseText },
        [middlePath]: { firstPrompt: nonPhraseText },
        [olderExactPath]: { firstPrompt: exactText },
      });
      const si = getSearchIndex();
      si.upsert(newestPath, makeTermFreqs(nonPhraseText));
      si.upsert(middlePath, makeTermFreqs(nonPhraseText));
      si.upsert(olderExactPath, makeTermFreqs(exactText));

      const cappedRecent = searchSessions(sessions, index, `"${phrase}"`, 1, {
        sort: "recent",
        phraseScanCap: 2,
      });
      assert.deepEqual(cappedRecent, []);

      const cappedDate = searchSessions(sessions, index, `"${phrase}"`, 1, {
        sort: "date",
        phraseScanCap: 2,
      });
      assert.deepEqual(cappedDate, []);

      const uncapped = searchSessions(sessions, index, `"${phrase}"`, 1, {
        sort: "recent",
        phraseScanCap: 3,
      });
      assert.deepEqual(uncapped.map((r) => r.path), [olderExactPath]);
      assert.ok(uncapped[0].matches.some((m) => m.snippet.toLowerCase().includes(phrase)));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("default maxResults is 50 (API parity with handleApiSearch)", () => {
    resetSearchIndexForTests();
    const sessions = [];
    const index = new Map();
    const si = getSearchIndex();
    for (let i = 0; i < 55; i++) {
      const p = `/tmp/limit50-${i}.jsonl`;
      sessions.push(makeSession(p, { file: `limit50-${i}.jsonl` }));
      index.set(p, { firstPrompt: `p${i}` });
      si.upsert(p, makeTermFreqs("limit50needle everywhere"));
    }
    const defaultCapped = searchSessions(sessions, index, "limit50needle");
    assert.equal(defaultCapped.length, 50);

    const explicit51 = searchSessions(sessions, index, "limit50needle", 51);
    assert.equal(explicit51.length, 51);
  });

  test("returns empty when no sessions match index or on-disk scan", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-empty-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(filePath, JSON.stringify({ type: "user", message: { content: "hello" } }));
    const stat = fs.statSync(filePath);
    const sessions = [
      { path: filePath, source: "claude", file: "session.jsonl", mtime: stat.mtime, size: stat.size },
    ];
    const index = new Map();
    index.set(filePath, { firstPrompt: "foo" });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("unrelated content"));
    try {
      const results = searchSessions(sessions, index, "nonexistentqueryxyz", 10);
      assert.equal(results.length, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scan-queries searchSessions case-insensitivity (filter.js parity)", () => {
  test("uppercase query matches lowercase indexed BM25 content", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/case-searchtext.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "list files" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("user ran bash ls and edited file.txt"));
    const results = searchSessions(sessions, index, "BASH");
    assert.equal(results.length, 1);
    assert.ok(results[0].matches.length > 0);
  });

  test("mixed-case query matches mixed-case indexed BM25 content", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/case-mixed-searchtext.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "deploy app" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("deploy to Production via SSH tunnel"));
    const results = searchSessions(sessions, index, "SsH");
    assert.equal(results.length, 1);
    assert.ok(results[0].matches.length > 0);
  });

  test("uppercase query matches firstPrompt when indexed in SI", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/case-prompt-only.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "run NPM install for coverage" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("run NPM install for coverage"));
    const results = searchSessions(sessions, index, "NPM");
    assert.equal(results.length, 1);
    assert.ok((results[0].prompt || "").toLowerCase().includes("npm"));
  });

  test("case-variant query misses unrelated indexed text", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/case-miss.jsonl";
    const sessions = [makeSession(filePath)];
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "hello world" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("alpha beta gamma"));
    assert.equal(searchSessions(sessions, index, "DELTA").length, 0);
    assert.equal(searchSessions(sessions, index, "SSH").length, 0);
  });

  test("filter text: and searchSessions agree on case-insensitive needle", () => {
    resetSearchIndexForTests();
    const filePath = "/tmp/case-filter-parity.jsonl";
    const session = makeSession(filePath);
    const index = indexFor([filePath], {
      [filePath]: { firstPrompt: "start" },
    });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("needleXYZ in indexed body"));

    assert.equal(searchSessions([session], index, "NEEDLEXYZ").length, 1);
    assert.equal(searchSessions([session], index, "NOMATCH").length, 0);
  });
});

describe("scan-queries extractSnippets", () => {
  test("extracts multiple context windows from long text", () => {
    const text = "alpha beta gamma UNIQUEWORD1 middle UNIQUEWORD2 end";
    const snippets = extractSnippets(text, "uniqueword", 2);
    assert.equal(snippets.length, 2);
    assert.equal(snippets[0].type, "text");
    assert.ok(snippets.every((s) => s.snippet.toLowerCase().includes("uniqueword")));
  });

  test("collapses newlines inside snippet window", () => {
    const text = "before\nUNIQUE\nmatch\nafter";
    const snippets = extractSnippets(text, "unique", 1);
    assert.equal(snippets.length, 1);
    assert.equal(snippets[0].snippet, "before UNIQUE match after");
    assert.ok(!snippets[0].snippet.includes("\n"));
  });

  test("extractSnippets skips newline replace when window has no newlines", async () => {
    const needle = "needle";
    const text = `${"x".repeat(200)} ${needle} ${"y".repeat(200)} ${needle} ${"z".repeat(200)}`;
    const lower = text.toLowerCase();
    const expected = extractSnippets(text, needle, 3, lower);
    assert.deepEqual(extractSnippets(text, needle, 3, lower), expected);

    const ITERS = 200;
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) extractSnippets(text, needle, 3, lower);
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(ms < 2, `expected extractSnippets under 2ms/op on 600-char text, got ${ms.toFixed(2)}ms`);
  });
});

describe("scan-queries jsonl file scan", () => {
  test("scanSessionForQuery suppresses ENOENT when session file is missing", () => {
    const errors = [];
    const orig = console.error;
    console.error = (...args) => errors.push(args);
    try {
      const hits = scanSessionForQuery(
        { path: "/nonexistent/tracequest-missing.jsonl", source: "claude", file: "missing.jsonl" },
        "needle",
        3,
      );
      assert.deepEqual(hits, []);
      assert.equal(errors.length, 0);
    } finally {
      console.error = orig;
    }
  });

  test("scanSessionForQuery rethrows unexpected scan failures instead of returning []", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-eisdir-"));
    const errors = [];
    const orig = console.error;
    console.error = (...args) => errors.push(args);
    try {
      assert.throws(
        () => scanSessionForQuery({ path: tmpDir, source: "claude", file: "session.jsonl" }, "needle", 3),
        (err) => err.code === "EISDIR",
      );
      assert.equal(errors.length, 1);
      assert.match(String(errors[0][0]), /scanSessionForQuery: failed to scan/);
    } finally {
      console.error = orig;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scanSessionForQuery finds command and file_path in claude jsonl", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-claude-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ command: "npm run test --coverage" }),
        JSON.stringify({ file_path: "/src/scan-queries.js" }),
      ].join("\n")
    );
    const stat = fs.statSync(filePath);
    try {
      const session = {
        path: filePath,
        source: "claude",
        file: "session.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      const cmdHits = scanSessionForQuery(session, "npm", 3);
      assert.ok(cmdHits.some((m) => m.type === "command" && m.snippet.includes("npm")));

      const fileHits = scanSessionForQuery(session, "scan-queries", 3);
      assert.ok(fileHits.some((m) => m.type === "file" && m.snippet.includes("scan-queries")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor snippets scan Claude-family JSONL content", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-cursor-"));
    const filePath = path.join(tmpDir, "cursor.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ command: "npm run cursor-check" }),
        JSON.stringify({ file_path: "/src/cursor-support.js" }),
      ].join("\n")
    );
    const stat = fs.statSync(filePath);
    try {
      const session = {
        path: filePath,
        source: "cursor",
        file: "cursor.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      const cmdHits = scanSessionForQuery(session, "cursor-check", 3);
      assert.ok(cmdHits.some((m) => m.type === "command" && m.snippet.includes("cursor-check")));

      const fileHits = scanSessionForQuery(session, "cursor-support", 3);
      assert.ok(fileHits.some((m) => m.type === "file" && m.snippet.includes("cursor-support")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor-cloud snippets scan message rows and skip the session_meta line", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-cursor-cloud-"));
    const filePath = path.join(tmpDir, "bc-scan.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({
          type: "session_meta",
          bcId: "bc-scan",
          name: "meta-only-needle cloud session",
          status: "FINISHED",
          createdAt: "2026-07-01T00:00:00Z",
          branchName: "cursor/meta-only-needle",
        }),
        JSON.stringify({
          role: "assistant",
          message: {
            content: [
              { type: "text", text: "row-needle appears in an assistant message body" },
              { type: "tool_use", name: "Bash", input: { command: "npm run cloud-check" } },
              // Cursor scan extracts "file_path" fields (RE_FILE_PATH), same as local cursor.
              { type: "tool_use", name: "Read", input: { file_path: "/src/cloud-support.js" } },
            ],
          },
        }),
      ].join("\n")
    );
    const stat = fs.statSync(filePath);
    try {
      const session = {
        path: filePath,
        source: "cursor-cloud",
        file: "bc-scan.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      // Message rows scan like local cursor content.
      const cmdHits = scanSessionForQuery(session, "cloud-check", 3);
      assert.ok(cmdHits.some((m) => m.type === "command" && m.snippet.includes("cloud-check")));
      const fileHits = scanSessionForQuery(session, "cloud-support", 3);
      assert.ok(fileHits.some((m) => m.type === "file" && m.snippet.includes("cloud-support")));
      const textHits = scanSessionForQuery(session, "row-needle", 3);
      assert.ok(textHits.some((m) => m.type === "text" && m.snippet.includes("row-needle")));

      // The session_meta line never yields a snippet (fact ccsc).
      assert.deepEqual(scanSessionForQuery(session, "meta-only-needle", 3), []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scan-queries scanGrokForQuery", () => {
  test("reads chat_history.jsonl for commands, paths, and text fallback", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-grok-"));
    const sessionDir = path.join(tmpDir, "sess-grok");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "assistant", command: "cargo test --all" },
      { type: "tool", path: "/tmp/grok-target.rs" },
      { type: "user", content: "plain grok searchable phrase" },
    ]);

    try {
      const cmd = scanGrokForQuery(sessionDir, "cargo", 3);
      assert.ok(cmd.some((m) => m.type === "command"));

      const fp = scanGrokForQuery(sessionDir, "grok-target", 3);
      assert.ok(fp.some((m) => m.type === "file"));

      const text = scanGrokForQuery(sessionDir, "searchable", 3);
      assert.ok(text.some((m) => m.type === "text" && m.snippet.includes("searchable")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scan-queries scanOpenCodeForQuery", () => {
  test("queries OpenCode SQLite via session-discovery paths", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-opencode-"));
    const dbDir = path.join(tmpDir, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);

    const insMsg = db.prepare(
      `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
    );
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    insMsg.run("m1", "scan-oc-1", JSON.stringify({ role: "user" }), 100);
    insPart.run(
      "p1",
      "m1",
      JSON.stringify({ type: "text", text: "Find the opencode needle in haystack" })
    );
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "scan-oc-1",
        path: "opencode://scan-oc-1",
        mtime: new Date(1000),
      };
      const direct = scanOpenCodeForQuery(session, "needle", 3);
      assert.ok(direct.some((m) => m.type === "text" && m.snippet.includes("needle")));

      resetSearchIndexForTests();
      const index = new Map();
      index.set(session.path, { firstPrompt: "unrelated", model: "gpt" });
      const si = getSearchIndex();
      si.upsert(session.path, makeTermFreqs("Find the opencode needle in haystack"));
      const viaSearch = searchSessions([session], index, "needle", 5);
      assert.equal(viaSearch.length, 1);
      assert.ok(viaSearch[0].matches.some((m) => m.snippet.includes("needle")));
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("SQL prefilter matches content when text is empty (text || content parity)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-oc-prefilter-"));
    const dbDir = path.join(tmpDir, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
    const insMsg = db.prepare(
      `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
    );
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    insMsg.run("m1", "scan-oc-2", JSON.stringify({ role: "user" }), 100);
    insPart.run("p1", "m1", JSON.stringify({ type: "text", text: "", content: "NEEDLE in content field" }));
    insPart.run(
      "p2",
      "m1",
      JSON.stringify({ type: "text", text: "placeholder", content: "NEEDLE ignored when text set" })
    );
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = { source: "opencode", file: "scan-oc-2", path: "opencode://scan-oc-2" };
      const hits = scanOpenCodeForQuery(session, "needle", 5);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].snippet.toLowerCase().includes("content field"));
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scanOpenCodeForQuery derives session id from path when .file is absent", async () => {
    // Regression: session objects without .file (e.g. API objects) caused
    // "Provided value cannot be bound to SQLite parameter 1" — the id must
    // be derived from path as a fallback.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-oc-noid-"));
    const dbDir = path.join(tmpDir, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
    const insMsg = db.prepare(`INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`);
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    const SESSION_ID = "scan-oc-nofile-1";
    insMsg.run("m1", SESSION_ID, JSON.stringify({ role: "user" }), 100);
    insPart.run("p1", "m1", JSON.stringify({ type: "text", text: "pathderived snippet with uniquetoken123" }));
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      // Session with NO .file field — only .path (mirrors what sessionToApiObject produces)
      const sessionWithoutFile = { source: "opencode", path: `opencode://${SESSION_ID}` };
      assert.equal(sessionWithoutFile.file, undefined, "precondition: .file must be absent");

      // Direct call: must not throw, must find the snippet
      const direct = scanOpenCodeForQuery(sessionWithoutFile, "uniquetoken123", 3);
      assert.ok(direct.length > 0, "expected snippet from path-derived session id");
      assert.ok(direct[0].snippet.includes("uniquetoken123"));

      // Via searchSessions: same condition, session object has no .file
      resetSearchIndexForTests();
      const index = new Map();
      index.set(sessionWithoutFile.path, { firstPrompt: "unrelated", model: "gpt" });
      const si = getSearchIndex();
      si.upsert(sessionWithoutFile.path, makeTermFreqs("pathderived snippet with uniquetoken123"));
      const results = searchSessions([sessionWithoutFile], index, "uniquetoken123", 5);
      assert.equal(results.length, 1);
      assert.ok(results[0].matches.some((m) => m.snippet.includes("uniquetoken123")),
        "searchSessions result must carry a real snippet from SQLite, not fall back to firstPrompt");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("reasoning parts are indexed and findable via searchSessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-oc-reasoning-"));
    const dbDir = path.join(tmpDir, ".local", "share", "opencode");
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, "opencode.db");

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER)`);
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
    const insMsg = db.prepare(`INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`);
    const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

    // The distinctive word "dissectinglogic" lives ONLY in a reasoning part, nowhere in text parts.
    insMsg.run("m1", "scan-oc-reason-1", JSON.stringify({ role: "assistant" }), 100);
    insPart.run("p1", "m1", JSON.stringify({ type: "text", text: "Here is my response." }));
    insPart.run("p2", "m1", JSON.stringify({ type: "reasoning", text: "I am dissectinglogic the problem carefully before answering." }));
    insMsg.run("m2", "scan-oc-reason-1", JSON.stringify({ role: "user" }), 200);
    insPart.run("p3", "m2", JSON.stringify({ type: "text", text: "What do you think?" }));
    db.close();

    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const session = {
        source: "opencode",
        file: "scan-oc-reason-1",
        path: "opencode://scan-oc-reason-1",
        mtime: new Date(1000),
      };

      // scanOpenCodeForQuery must find the reasoning part directly
      const direct = scanOpenCodeForQuery(session, "dissectinglogic", 5);
      assert.ok(
        direct.some((m) => m.type === "text" && m.snippet.includes("dissectinglogic")),
        "scanOpenCodeForQuery must find the word in reasoning parts"
      );

      // searchSessions end-to-end: term must be in index and snippet must come from SQLite
      resetSearchIndexForTests();
      const index = new Map();
      index.set(session.path, { firstPrompt: "What do you think?", model: "gpt-4o" });
      const si = getSearchIndex();
      si.upsert(session.path, makeTermFreqs("dissectinglogic problem carefully"));
      const results = searchSessions([session], index, "dissectinglogic", 5);
      assert.equal(results.length, 1, "session must appear in search results");
      assert.ok(
        results[0].matches.some((m) => m.snippet.includes("dissectinglogic")),
        "searchSessions snippet must contain the reasoning-only term"
      );
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scan-queries bounded LRU scan cache", () => {
  test("searchSessions skips redundant disk read when mtime unchanged", async () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-cache-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    const lines = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { content: "run npm install in the project" },
          command: "npm install",
        })
      );
    }
    fs.writeFileSync(filePath, lines.join("\n"));

    try {
      const modUrl = new URL("../../src/sessions/scan-queries.js?" + Date.now(), import.meta.url);
      const { searchSessions: freshSearch } = await import(modUrl.href);

      const sessions = [
        {
          path: filePath,
          source: "claude",
          project: "myproj",
          file: "session.jsonl",
          mtime: fs.statSync(filePath).mtime,
          size: fs.statSync(filePath).size,
        },
      ];
      const index = new Map();
      index.set(filePath, { firstPrompt: " unrelated prompt ", model: "claude-3" });
      // Populate SI so BM25 search finds this session (same singleton as fresh module)
      getSearchIndex().upsert(filePath, makeTermFreqs("npm install run project"));

      assert.equal(freshSearch(sessions, index, "npm", 5).length, 1);

      const origStat = fs.statSync(filePath);
      const noMatch = [];
      for (let i = 0; i < 1000; i++) {
        noMatch.push(JSON.stringify({ type: "user", message: { content: "totally different text" } }));
      }
      fs.writeFileSync(filePath, noMatch.join("\n"));
      fs.utimesSync(filePath, origStat.atime, origStat.mtime);

      const result2 = freshSearch(sessions, index, "npm", 5);
      assert.equal(result2.length, 1);
      assert.ok(result2[0].matches.length > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("invalidates scan cache when session file mtime changes", async () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-mtime-"));
    const filePath = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: "user",
        message: { content: "first version command" },
        command: "first version",
      })
    );

    try {
      const modUrl = new URL("../../src/sessions/scan-queries.js?" + Date.now(), import.meta.url);
      const { searchSessions: freshSearch } = await import(modUrl.href);

      const stat1 = fs.statSync(filePath);
      const sessions1 = [
        {
          path: filePath,
          source: "claude",
          project: "myproj",
          file: "session.jsonl",
          mtime: stat1.mtime,
          size: stat1.size,
        },
      ];
      const index = new Map();
      index.set(filePath, { firstPrompt: " unrelated prompt ", model: "claude-3" });
      // Populate SI so BM25 search finds this session
      getSearchIndex().upsert(filePath, makeTermFreqs("version first second command"));

      const result1 = freshSearch(sessions1, index, "version", 5);
      assert.ok(result1[0].matches.some((m) => m.snippet.includes("first")));

      fs.writeFileSync(
        filePath,
        JSON.stringify({
          type: "user",
          message: { content: "second version command" },
          command: "second version",
        })
      );
      const stat2 = fs.statSync(filePath);
      const sessions2 = [{ ...sessions1[0], mtime: stat2.mtime, size: stat2.size }];

      const result2 = freshSearch(sessions2, index, "version", 5);
      assert.ok(result2[0].matches.some((m) => m.snippet.includes("second")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scan cache is bounded and still returns correct results after eviction", async () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-bound-"));

    try {
      const modUrl = new URL("../../src/sessions/scan-queries.js?" + Date.now(), import.meta.url);
      const { searchSessions: freshSearch } = await import(modUrl.href);

      const sessions = [];
      const si = getSearchIndex();
      for (let i = 0; i < 52; i++) {
        const filePath = path.join(tmpDir, `session-${i}.jsonl`);
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            type: "user",
            message: { content: `command ${i}` },
            command: `command ${i}`,
          })
        );
        const stat = fs.statSync(filePath);
        sessions.push({
          path: filePath,
          source: "claude",
          project: "myproj",
          file: `session-${i}.jsonl`,
          mtime: stat.mtime,
          size: stat.size,
        });
        si.upsert(filePath, makeTermFreqs(`command ${i}`));
      }

      const index = new Map();
      for (let i = 0; i < 52; i++) {
        index.set(sessions[i].path, { firstPrompt: `unrelated ${i}`, model: "claude-3" });
      }
      for (let i = 0; i < 52; i++) {
        assert.equal(freshSearch([sessions[i]], index, `command ${i}`, 5).length, 1);
      }

      const resultFirst = freshSearch([sessions[0]], index, "command 0", 5);
      assert.ok(resultFirst[0].matches.some((m) => m.snippet.includes("command 0")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scan-queries scan performance", () => {
  test("scanGrokForQuery skips system filler on large chat_history (perf)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-grok-filler-perf-"));
    const sessionDir = path.join(tmpDir, "sess-grok-filler");
    fs.mkdirSync(sessionDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "system", content: "x".repeat(400) }));
    }
    lines.push(JSON.stringify({ type: "user", content: "findme grok searchable phrase" }));
    fs.writeFileSync(path.join(sessionDir, "chat_history.jsonl"), lines.join("\n") + "\n");

    try {
      const warmup = scanGrokForQuery(sessionDir, "findme", 3);
      assert.ok(warmup.some((m) => m.type === "text" && m.snippet.includes("findme")));

      const ITERS = 30;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) scanGrokForQuery(sessionDir, "findme", 3);
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 5,
        `expected scanGrokForQuery under 5ms/op with 8k system filler, got ${ms.toFixed(2)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("scanSessionForQuery skips progress filler on large claude jsonl (perf)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-claude-filler-perf-"));
    const filePath = path.join(tmpDir, "progress-heavy.jsonl");
    const lines = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "progress", data: "x".repeat(400) }));
    }
    lines.push(JSON.stringify({ command: "findme npm run deploy" }));
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    const stat = fs.statSync(filePath);

    try {
      const session = {
        path: filePath,
        source: "claude",
        file: "progress-heavy.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      const warmup = scanSessionForQuery(session, "findme", 3);
      assert.ok(warmup.some((m) => m.type === "command" && m.snippet.includes("findme")));

      const ITERS = 30;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) scanSessionForQuery(session, "findme", 3);
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 5,
        `expected scanSessionForQuery under 5ms/op with 8k progress filler, got ${ms.toFixed(2)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("structured-hit scan avoids per-line text toLowerCase on large jsonl", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-perf-"));
    const filePath = path.join(tmpDir, "big.jsonl");
    const lines = [];
    const LINE_COUNT = 5000;
    for (let i = 0; i < LINE_COUNT; i++) {
      lines.push(
        JSON.stringify({ command: `npm run task-${i}`, note: "x".repeat(120) })
      );
    }
    fs.writeFileSync(filePath, lines.join("\n"));
    const stat = fs.statSync(filePath);

    try {
      const session = {
        path: filePath,
        source: "claude",
        file: "big.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      const warmup = scanSessionForQuery(session, "npm", 3);
      assert.ok(warmup.some((m) => m.type === "command"));

      const ITERS = 40;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) scanSessionForQuery(session, "npm", 3);
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 100,
        `expected structured scan under 100ms/op for ${LINE_COUNT} lines, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("LRU cache hit scans line-by-line instead of triple full-text matchAll", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-cache-perf-"));
    const filePath = path.join(tmpDir, "cached-big.jsonl");
    const lines = [];
    const LINE_COUNT = 5000;
    for (let i = 0; i < LINE_COUNT; i++) {
      lines.push(
        JSON.stringify({ command: `npm run task-${i}`, note: "x".repeat(120) })
      );
    }
    fs.writeFileSync(filePath, lines.join("\n"));
    const stat = fs.statSync(filePath);

    try {
      const session = {
        path: filePath,
        source: "claude",
        file: "cached-big.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      const prime = scanSessionForQuery(session, "npm", 3);
      assert.ok(prime.some((m) => m.type === "command"));

      const ITERS = 40;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) scanSessionForQuery(session, "npm", 3);
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 50,
        `expected cached structured scan under 50ms/op for ${LINE_COUNT} lines, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("text fallback still runs when no structured fields match", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-text-fb-"));
    const filePath = path.join(tmpDir, "text-only.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ note: "filler without command keys" }),
        JSON.stringify({ body: "plain searchable phrase here" }),
      ].join("\n")
    );
    const stat = fs.statSync(filePath);
    try {
      const session = {
        path: filePath,
        source: "claude",
        file: "text-only.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      const hits = scanSessionForQuery(session, "searchable", 3);
      assert.ok(hits.some((m) => m.type === "text" && m.snippet.includes("searchable")));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cached text fallback avoids full-file toLowerCase on large jsonl", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-scan-cache-text-perf-"));
    const filePath = path.join(tmpDir, "cached-text.jsonl");
    const lines = [];
    const LINE_COUNT = 5000;
    for (let i = 0; i < LINE_COUNT; i++) {
      lines.push(JSON.stringify({ body: "x".repeat(200) + (i === LINE_COUNT - 1 ? " uniqueneedle" : "") }));
    }
    fs.writeFileSync(filePath, lines.join("\n"));
    const stat = fs.statSync(filePath);

    try {
      const session = {
        path: filePath,
        source: "claude",
        file: "cached-text.jsonl",
        mtime: stat.mtime,
        size: stat.size,
      };
      const prime = scanSessionForQuery(session, "uniqueneedle", 3);
      assert.ok(prime.some((m) => m.type === "text" && m.snippet.includes("uniqueneedle")));

      const ITERS = 30;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) scanSessionForQuery(session, "uniqueneedle", 3);
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 80,
        `expected cached text fallback under 80ms/op for ${LINE_COUNT} lines, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("scan-queries sessions re-export", () => {
  test("sessions.js re-exports searchSessions", async () => {
    const { searchSessions: fromSessions } = await import("../../src/sessions.js");
    const { searchSessions: fromScan } = await import("../../src/sessions/scan-queries.js");
    assert.equal(fromSessions, fromScan);
  });
});

describe("scan-queries snippet JSON unescape (bug h6v)", () => {
  test("text snippet decodes \\n and \\\" escapes from raw JSONL content", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-unescape-"));
    const filePath = path.join(tmpDir, "unescape.jsonl");
    // The match word "tokenizer" appears inside a JSON string with surrounding \n and \" escapes
    const raw = '{"type":"assistant","message":{"content":"first line\\nthe tokenizer\\\"design\\\" here\\nend"}}';
    fs.writeFileSync(filePath, raw);
    const stat = fs.statSync(filePath);
    const session = {
      path: filePath,
      source: "claude",
      file: "unescape.jsonl",
      mtime: stat.mtime,
      size: stat.size,
    };
    try {
      const snippets = scanSessionForQuery(session, "tokenizer", 3);
      assert.ok(snippets.length > 0, "expected at least one snippet");
      const text = snippets.map((s) => s.snippet).join(" ");
      // Must not contain raw two-character escape sequences
      assert.ok(!text.includes("\\n"), `snippet should not contain literal \\n but got: ${text}`);
      assert.ok(!text.includes('\\"'), `snippet should not contain literal \\" but got: ${text}`);
      // Must contain the matched term
      assert.ok(text.includes("tokenizer"), `snippet should contain 'tokenizer' but got: ${text}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("slice boundary: match adjacent to escape sequence does not produce trailing lone backslash", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-boundary-"));
    const filePath = path.join(tmpDir, "boundary.jsonl");
    // The match term "boundary" is followed immediately by a \n escape at the 60-char window edge
    const padding = "x".repeat(58);
    const raw = `{"type":"assistant","message":{"content":"boundary${padding}\\nfoo"}}`;
    fs.writeFileSync(filePath, raw);
    const stat = fs.statSync(filePath);
    const session = {
      path: filePath,
      source: "claude",
      file: "boundary.jsonl",
      mtime: stat.mtime,
      size: stat.size,
    };
    try {
      const snippets = scanSessionForQuery(session, "boundary", 3);
      assert.ok(snippets.length > 0, "expected at least one snippet");
      const text = snippets.map((s) => s.snippet).join(" ");
      // No trailing lone backslash and no raw two-char sequences
      assert.ok(!text.endsWith("\\"), `snippet must not end with lone backslash: ${text}`);
      assert.ok(!text.includes("\\n"), `snippet must not contain \\n: ${text}`);
      assert.ok(text.includes("boundary"), `snippet must include 'boundary': ${text}`);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("phrase query: first snippet contains the verbatim phrase (bug yq2)", () => {
    resetSearchIndexForTests();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-phrase-"));
    const filePath = path.join(tmpDir, "phrase.jsonl");
    // Session contains "type error" as a phrase, not just individual tokens
    fs.writeFileSync(filePath, JSON.stringify({ type: "assistant", message: { content: "encountered a type error in line 42" } }));
    const stat = fs.statSync(filePath);
    const session = {
      path: filePath,
      source: "claude",
      file: "phrase.jsonl",
      mtime: stat.mtime,
      size: stat.size,
    };
    const index = indexFor([filePath], { [filePath]: { firstPrompt: "debug session" } });
    const si = getSearchIndex();
    si.upsert(filePath, makeTermFreqs("type error encountered line 42"));
    try {
      const results = runBehavioralSearch([session], index, '"type error"');
      assert.equal(results.length, 1, "phrase query should match the session");
      assert.ok(results[0].matches.length > 0, "expected at least one snippet");
      // The first snippet must contain the full phrase
      const firstSnippet = results[0].matches[0].snippet;
      assert.ok(
        firstSnippet.toLowerCase().includes("type error"),
        `first snippet should contain 'type error' but got: ${firstSnippet}`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
