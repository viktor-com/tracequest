import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { applyExprToApiObjects } from "../../src/filter/filter.js";
import { sessionToApiObject } from "../../src/server/server-helpers.js";
import { searchSessions } from "../../src/sessions/scan-queries.js";
import { resetIndexWritersForTests } from "../../src/sessions/index-writers.js";
import { claudeProj, writeJsonl } from "../helpers/fixtures.js";

const SHARED_QUERY = "sq-shared-needle";

/**
 * Mirrors handleApiSearch expr narrowing + dashboard search (scan-queries).
 * applyExprToApiObjects builds the SearchIndex-backed filter context.
 */
function searchWithExprFilter(sessions, index, query, opts = {}) {
  const { expr = null, maxResults = 50 } = opts;
  let scoped = sessions;
  if (expr?.trim()) {
    const apiObjects = sessions.map((s) => {
      const meta = index.get(s.path) || {};
      const api = sessionToApiObject(s, meta);
      api.live = false;
      api._origSession = s;
      return api;
    });
    scoped = applyExprToApiObjects(apiObjects, expr, "recent").map((obj) => obj._origSession);
  }
  return searchSessions(scoped, index, query, maxResults);
}

function claudeRows({
  prompt = "bootstrap",
  bodyPhrase,
  model = "claude-sonnet-4-20250514",
  withBash = false,
  withError = false,
}) {
  const phrase = bodyPhrase || prompt;
  const rows = [
    { type: "user", message: { content: [{ type: "text", text: prompt }] } },
    { type: "user", message: { content: [{ type: "text", text: "follow-up turn" }] } },
    { type: "user", message: { content: [{ type: "text", text: "third user turn" }] } },
  ];
  const assistantBits = [{ type: "text", text: `${phrase} ${SHARED_QUERY}` }];
  if (withBash) {
    assistantBits.push({
      type: "tool_use",
      name: "Bash",
      input: { command: `grep ${SHARED_QUERY} src/` },
    });
  }
  rows.push({
    type: "assistant",
    message: {
      model,
      content: assistantBits,
      usage: { input_tokens: 40, output_tokens: 12 },
    },
    timestamp: "2026-06-03T10:00:00Z",
  });
  if (withError) {
    rows.push({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            content: [{ type: "text", text: "Error: command failed with exit code 2" }],
            is_error: true,
          },
        ],
      },
    });
  }
  return rows;
}

function seedSearchFixture(tmpDir) {
  const alphaDir = claudeProj(tmpDir, "ssearch-alpha");
  const betaDir = claudeProj(tmpDir, "ssearch-beta");
  const errDir = claudeProj(tmpDir, "ssearch-errors");

  const alphaPath = path.join(alphaDir, "alpha.jsonl");
  const betaPath = path.join(betaDir, "beta.jsonl");
  const errPath = path.join(errDir, "err.jsonl");

  writeJsonl(
    alphaPath,
    claudeRows({
      prompt: "alpha deploy-marker prompt",
      bodyPhrase: "alpha body-only-marker",
      model: "claude-sonnet-4-20250514",
      withBash: true,
    })
  );
  writeJsonl(
    betaPath,
    claudeRows({
      prompt: "beta plain prompt",
      bodyPhrase: "beta indexed body",
      model: "claude-opus-4-20250514",
      withBash: false,
    })
  );
  writeJsonl(
    errPath,
    claudeRows({
      prompt: "error session prompt",
      bodyPhrase: "error indexed body",
      model: "claude-opus-4-20250514",
      withError: true,
    })
  );

  const codexDir = path.join(tmpDir, ".codex", "sessions", "2026", "06", "03");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexPath = path.join(codexDir, "rollout-codex.jsonl");
  writeJsonl(codexPath, [
    {
      type: "session_meta",
      payload: { cwd: "/home/dev/ssearch-codex-proj", model_provider: "openai" },
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `codex side ${SHARED_QUERY}`,
      },
    },
    { type: "turn_context", payload: { model: "gpt-5-codex" } },
  ]);

  const recent = new Date(Date.now() - 2 * 3600000);
  for (const p of [alphaPath, betaPath, errPath, codexPath]) {
    fs.utimesSync(p, recent, recent);
  }

  return { alphaPath, betaPath, errPath, codexPath, alphaDir, betaDir };
}

async function withIndexedSearch(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-search-sessions-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  seedSearchFixture(tmpDir);
  try {
    resetIndexWritersForTests();

    const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
    const { findSessions, buildIndex } = await import(modUrl.href);
    const sessions = findSessions(null);
    const index = buildIndex(sessions);
    await fn({ tmpDir, sessions, index, findSessions, buildIndex });
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("search-sessions buildIndex + expr filter integration", () => {
  test("discovers four sessions and buildIndex keys every path", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      assert.equal(sessions.length, 4);
      for (const s of sessions) {
        assert.ok(index.has(s.path), `missing index for ${s.path}`);
        assert.ok(index.get(s.path).firstPrompt !== undefined, `missing firstPrompt for ${s.path}`);
      }
    });
  });

  test("unfiltered search returns all sessions matching shared query", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY);
      assert.equal(hits.length, 4);
      const sources = new Set(hits.map((h) => h.source));
      assert.ok(sources.has("claude"));
      assert.ok(sources.has("codex"));
    });
  });

  test("expr source:claude excludes codex rollout from hits", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:claude",
      });
      assert.equal(hits.length, 3);
      assert.ok(hits.every((h) => h.source === "claude"));
    });
  });

  test("expr source:codex returns only codex-indexed session", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:codex",
      });
      assert.equal(hits.length, 1);
      assert.equal(hits[0].source, "codex");
      assert.match(hits[0].file, /^rollout-/);
    });
  });

  test("expr model:sonnet keeps alpha claude session only", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "model:sonnet",
      });
      assert.equal(hits.length, 1);
      assert.match(hits[0].path, /alpha\.jsonl$/);
      assert.ok(hits[0].model.toLowerCase().includes("sonnet"));
    });
  });

  test("expr tool:Bash narrows to bash-tool session from real index metadata", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "tool:Bash",
      });
      assert.equal(hits.length, 1);
      assert.match(hits[0].path, /alpha\.jsonl$/);
      const meta = index.get(hits[0].path);
      assert.ok(meta.tools.includes("Bash"));
    });
  });

  test("expr errors:>0 returns only error-indexed session", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "errors:>0",
      });
      assert.equal(hits.length, 1);
      assert.match(hits[0].path, /err\.jsonl$/);
      assert.ok((index.get(hits[0].path).errors || 0) > 0);
    });
  });

  test("expr project:ssearch-alpha limits to alpha project rows", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "project:ssearch-alpha",
      });
      assert.equal(hits.length, 1);
      assert.ok(hits[0].project.includes("ssearch-alpha"));
    });
  });

  test("expr bare body-only-marker matches SearchIndex term sets before query scan", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "body-only-marker",
      });
      assert.equal(hits.length, 1);
      assert.match(hits[0].path, /alpha\.jsonl$/);
    });
  });

  test("expr OR combines alpha project and codex source", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "project:ssearch-alpha OR source:codex",
      });
      assert.equal(hits.length, 2);
      const paths = hits.map((h) => h.path).sort();
      assert.ok(paths.some((p) => p.includes("alpha.jsonl")));
      assert.ok(paths.some((p) => p.includes("rollout-codex")));
    });
  });

  test("expr NOT source:codex removes codex while keeping three claude hits", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "NOT source:codex",
      });
      assert.equal(hits.length, 3);
      assert.ok(hits.every((h) => h.source !== "codex"));
    });
  });

  test("expr project:ssearch-alpha AND tool:Bash intersects filters", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "project:ssearch-alpha AND tool:Bash",
      });
      assert.equal(hits.length, 1);
      assert.match(hits[0].path, /alpha\.jsonl$/);
    });
  });

  test("maxResults caps hits after expr narrowing", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "source:claude",
        maxResults: 2,
      });
      assert.equal(hits.length, 2);
    });
  });

  test("expr age:<7d keeps recently touched fixture sessions", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "age:<7d",
      });
      assert.equal(hits.length, 4);
    });
  });

  test("whitespace-only query returns no results even with expr", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, "   ", {
        expr: "source:claude",
      });
      assert.deepEqual(hits, []);
    });
  });

  test("expr mismatch yields zero hits though query would match globally", async () => {
    await withIndexedSearch(async ({ sessions, index }) => {
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY, {
        expr: "model:nonexistent-model-xyz",
      });
      assert.equal(hits.length, 0);
    });
  });

  test("findSessions project prefix shrinks pool before buildIndex and expr", async () => {
    await withIndexedSearch(async ({ findSessions, buildIndex }) => {
      const scoped = findSessions("ssearch-beta");
      assert.equal(scoped.length, 1);
      const index = buildIndex(scoped);
      const hits = searchWithExprFilter(scoped, index, SHARED_QUERY, {
        expr: "source:claude",
      });
      assert.equal(hits.length, 1);
      assert.match(hits[0].path, /beta\.jsonl$/);
    });
  });
});
