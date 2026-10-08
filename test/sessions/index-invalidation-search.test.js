/**
 * Incremental index invalidation end-to-end: cache mtime bumps, partial stale
 * re-index, and search correctness after on-disk session edits.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseFilterExpr, evalFilterExpr } from "../../src/filter/filter.js";
import { sessionToApiObject } from "../../src/server/server-helpers.js";
import { searchSessions } from "../../src/sessions/scan-queries.js";
import {
  flushDeferredIndexWriteForTests,
  flushDeferredSearchIdxWriteForTests,
  resetIndexWritersForTests,
  indexPath,
} from "../../src/sessions/index-writers.js";
import { bumpFileMtime, claudeProj, writeJsonl } from "../helpers/fixtures.js";

const FIXED_NOW = Date.parse("2026-06-03T12:00:00Z");
const SHARED_QUERY = "inv-shared-needle";
const ALPHA_ONLY = "inv-alpha-only-marker";
const BETA_ONLY = "inv-beta-only-marker";
const CODEX_ONLY = "inv-codex-only-marker";
const POST_EDIT_ALPHA = "inv-alpha-post-edit-marker";
const POST_EDIT_BETA = "inv-beta-post-edit-marker";

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

function claudeRows({
  prompt,
  bodyPhrase,
  uniqueMarker = "",
  model = "claude-sonnet-4-20250514",
  withBash = false,
  withError = false,
}) {
  const phrase = bodyPhrase || prompt;
  const bodyText = [phrase, SHARED_QUERY, uniqueMarker].filter(Boolean).join(" ");
  const rows = [
    { type: "user", message: { content: [{ type: "text", text: prompt }] } },
    { type: "user", message: { content: [{ type: "text", text: "follow-up turn" }] } },
  ];
  const assistantBits = [{ type: "text", text: bodyText }];
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

function seedInvalidationFixture(tmpDir) {
  const alphaDir = claudeProj(tmpDir, "inv-alpha");
  const betaDir = claudeProj(tmpDir, "inv-beta");
  const errDir = claudeProj(tmpDir, "inv-errors");

  const alphaPath = path.join(alphaDir, "alpha.jsonl");
  const betaPath = path.join(betaDir, "beta.jsonl");
  const errPath = path.join(errDir, "err.jsonl");

  writeJsonl(
    alphaPath,
    claudeRows({
      prompt: "alpha deploy-marker prompt",
      bodyPhrase: "alpha indexed body",
      uniqueMarker: ALPHA_ONLY,
      withBash: true,
    })
  );
  writeJsonl(
    betaPath,
    claudeRows({
      prompt: "beta plain prompt",
      bodyPhrase: "beta indexed body",
      uniqueMarker: BETA_ONLY,
      model: "claude-opus-4-20250514",
      withBash: false,
    })
  );
  writeJsonl(
    errPath,
    claudeRows({
      prompt: "error session prompt",
      bodyPhrase: "error indexed body",
      withError: true,
    })
  );

  const codexDir = path.join(tmpDir, ".codex", "sessions", "2026", "06", "03");
  fs.mkdirSync(codexDir, { recursive: true });
  const codexPath = path.join(codexDir, "rollout-inv.jsonl");
  writeJsonl(codexPath, [
    {
      type: "session_meta",
      payload: { cwd: "/home/dev/inv-codex-proj", model_provider: "openai" },
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: `codex side ${SHARED_QUERY} ${CODEX_ONLY}`,
      },
    },
    { type: "turn_context", payload: { model: "gpt-5-codex" } },
  ]);

  const recent = new Date(FIXED_NOW - 2 * 3600000);
  for (const p of [alphaPath, betaPath, errPath, codexPath]) {
    fs.utimesSync(p, recent, recent);
  }

  return { alphaPath, betaPath, errPath, codexPath, alphaDir, betaDir };
}

async function withInvalidationHarness(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-inv-search-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  const paths = seedInvalidationFixture(tmpDir);

  try {
    resetIndexWritersForTests();
    const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
    const { findSessions, buildIndex } = await import(modUrl.href);
    await fn({ tmpDir, paths, findSessions, buildIndex });
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("index invalidation + search integration", () => {
  test("baseline search hits all four sessions before any edits", async () => {
    await withInvalidationHarness(async ({ findSessions, buildIndex }) => {
      const sessions = findSessions(null);
      const index = buildIndex(sessions);
      const hits = searchWithExprFilter(sessions, index, SHARED_QUERY);
      assert.equal(hits.length, 4);
      assert.ok(hits.some((h) => h.path.endsWith("alpha.jsonl")));
      assert.ok(hits.some((h) => h.path.endsWith("beta.jsonl")));
      assert.ok(hits.some((h) => h.path.endsWith("err.jsonl")));
      assert.ok(hits.some((h) => h.path.includes("rollout-inv")));
    });
  });

  test("session file edit + mtime bump re-indexes only changed row and updates search", async () => {
    await withInvalidationHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      const index1 = buildIndex(sessions1);
      flushDeferredIndexWriteForTests();

      assert.equal(searchSessions(sessions1, index1, ALPHA_ONLY).length, 1);
      assert.equal(searchSessions(sessions1, index1, POST_EDIT_ALPHA).length, 0);

      writeJsonl(
        paths.alphaPath,
        claudeRows({
          prompt: "alpha edited prompt",
          bodyPhrase: "alpha edited body",
          uniqueMarker: POST_EDIT_ALPHA,
          withBash: true,
        })
      );
      bumpFileMtime(paths.alphaPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      assert.equal(searchSessions(sessions2, index2, ALPHA_ONLY).length, 0);
      const postHits = searchSessions(sessions2, index2, POST_EDIT_ALPHA);
      assert.equal(postHits.length, 1);
      assert.equal(postHits[0].path, paths.alphaPath);
      assert.ok(postHits[0].matches.length > 0);

      const sharedHits = searchWithExprFilter(sessions2, index2, SHARED_QUERY);
      assert.equal(sharedHits.length, 4, "unchanged sessions still match shared query");
    });
  });

  test("partial stale re-index preserves cached meta object identity for untouched sessions", async () => {
    await withInvalidationHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      const index1 = buildIndex(sessions1);
      flushDeferredIndexWriteForTests();

      const betaMetaBefore = index1.get(paths.betaPath);
      const codexMetaBefore = index1.get(paths.codexPath);
      const errMetaBefore = index1.get(paths.errPath);

      writeJsonl(
        paths.alphaPath,
        claudeRows({
          prompt: "alpha partial-edit prompt",
          bodyPhrase: "alpha partial-edit body",
          uniqueMarker: POST_EDIT_ALPHA,
          withBash: true,
        })
      );
      bumpFileMtime(paths.alphaPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      assert.notEqual(index2.get(paths.alphaPath), index1.get(paths.alphaPath));
      assert.equal(index2.get(paths.betaPath), betaMetaBefore);
      assert.equal(index2.get(paths.codexPath), codexMetaBefore);
      assert.equal(index2.get(paths.errPath), errMetaBefore);

      assert.equal(searchSessions(sessions2, index2, BETA_ONLY).length, 1);
      assert.equal(searchSessions(sessions2, index2, CODEX_ONLY).length, 1);
      assert.equal(searchSessions(sessions2, index2, POST_EDIT_ALPHA).length, 1);
    });
  });

  test("expr filters reflect metadata after partial re-index", async () => {
    await withInvalidationHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      const index1 = buildIndex(sessions1);

      const bashBefore = searchWithExprFilter(sessions1, index1, SHARED_QUERY, {
        expr: "tool:Bash",
      });
      assert.equal(bashBefore.length, 1);
      assert.match(bashBefore[0].path, /alpha\.jsonl$/);

      writeJsonl(
        paths.betaPath,
        claudeRows({
          prompt: "beta now has bash",
          bodyPhrase: "beta bash body",
          uniqueMarker: POST_EDIT_BETA,
          withBash: true,
        })
      );
      bumpFileMtime(paths.betaPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      const bashAfter = searchWithExprFilter(sessions2, index2, SHARED_QUERY, {
        expr: "tool:Bash",
      });
      assert.equal(bashAfter.length, 2);
      const bashPaths = bashAfter.map((h) => h.path).sort();
      assert.ok(bashPaths.some((p) => p.endsWith("alpha.jsonl")));
      assert.ok(bashPaths.some((p) => p.endsWith("beta.jsonl")));

      const betaOnlyHits = searchSessions(sessions2, index2, POST_EDIT_BETA);
      assert.equal(betaOnlyHits.length, 1);
      assert.equal(betaOnlyHits[0].path, paths.betaPath);
    });
  });

  test("index.json disk mtime bump invalidates result map cache but search stays correct", async () => {
    await withInvalidationHarness(async ({ findSessions, buildIndex }) => {
      const sessions = findSessions(null);
      const map1 = buildIndex(sessions);
      const map2 = buildIndex(sessions);
      assert.equal(map1, map2, "precondition: stable inputs hit result map cache before disk touch");

      flushDeferredIndexWriteForTests();
      const diskIndex = indexPath();
      const bumped = Date.now() + 120_000;
      fs.utimesSync(diskIndex, bumped / 1000, bumped / 1000);

      const map3 = buildIndex(sessions);
      assert.notEqual(map2, map3, "index disk mtime bump must invalidate result map cache");

      const hits = searchWithExprFilter(sessions, map3, SHARED_QUERY);
      assert.equal(hits.length, 4);
      assert.ok(hits.every((h) => h.matches.length > 0));
    });
  });

  test("persisted disk cache + module reset partial re-indexes edited session for search", async () => {
    await withInvalidationHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      const index1 = buildIndex(sessions1);
      flushDeferredIndexWriteForTests();
      flushDeferredSearchIdxWriteForTests();
      assert.equal(searchSessions(sessions1, index1, ALPHA_ONLY).length, 1);

      resetIndexWritersForTests();

      writeJsonl(
        paths.alphaPath,
        claudeRows({
          prompt: "alpha disk-cache edit",
          bodyPhrase: "alpha disk-cache body",
          uniqueMarker: POST_EDIT_ALPHA,
          withBash: true,
        })
      );
      bumpFileMtime(paths.alphaPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      assert.equal(searchSessions(sessions2, index2, ALPHA_ONLY).length, 0);
      assert.equal(searchSessions(sessions2, index2, POST_EDIT_ALPHA).length, 1);
      assert.equal(searchSessions(sessions2, index2, BETA_ONLY).length, 1);
      assert.equal(searchSessions(sessions2, index2, CODEX_ONLY).length, 1);
    });
  });

  test("removing unique needle from edited session drops it from targeted search", async () => {
    await withInvalidationHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      const index1 = buildIndex(sessions1);
      assert.equal(searchSessions(sessions1, index1, BETA_ONLY).length, 1);

      writeJsonl(
        paths.betaPath,
        claudeRows({
          prompt: "beta stripped marker",
          bodyPhrase: "beta stripped body",
          uniqueMarker: "",
          withBash: false,
        })
      );
      bumpFileMtime(paths.betaPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      assert.equal(searchSessions(sessions2, index2, BETA_ONLY).length, 0);
      const sharedHits = searchSessions(sessions2, index2, SHARED_QUERY);
      assert.equal(sharedHits.length, 4);
      assert.ok(sharedHits.some((h) => h.path === paths.betaPath));
    });
  });

  test("second buildIndex after edit reuses result map when inputs unchanged", async () => {
    await withInvalidationHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      buildIndex(sessions1);

      writeJsonl(
        paths.alphaPath,
        claudeRows({
          prompt: "alpha cache-stable edit",
          bodyPhrase: "alpha cache-stable body",
          uniqueMarker: POST_EDIT_ALPHA,
          withBash: true,
        })
      );
      bumpFileMtime(paths.alphaPath);

      const sessions2 = findSessions(null);
      const mapA = buildIndex(sessions2);
      const mapB = buildIndex(sessions2);

      assert.equal(mapA, mapB, "unchanged sessions after re-index must hit result map cache");
      assert.equal(searchSessions(sessions2, mapB, POST_EDIT_ALPHA).length, 1);
      assert.equal(searchSessions(sessions2, mapB, ALPHA_ONLY).length, 0);
    });
  });
});