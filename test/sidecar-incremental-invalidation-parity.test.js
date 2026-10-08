/**
 * JS (no sidecar) × Rust sidecar incremental index invalidation parity.
 * Mirrors test/sessions/index-invalidation-search.test.js: mtime bumps, partial
 * stale re-index, disk cache invalidation — search hits must match at every step.
 * Skips when no built ELF sidecar is present (npm run build:sidecar).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  flushDeferredIndexWriteForTests,
  flushDeferredSearchIdxWriteForTests,
  resetIndexWritersForTests,
  indexPath,
} from "../src/sessions/index-writers.js";
import { SIDECAR_PATH_ENV, SIDECAR_SKIP_ENV } from "./helpers/sidecar-mock.js";
import { claudeProj, writeJsonl } from "./helpers/fixtures.js";
import { FIXED_NOW } from "./helpers/multi-source-fixtures.js";
import {
  SKIP_NO_SIDECAR,
  assertIndexSearchParity,
  bumpFileMtime,
  clearDiskIndexCache,
  runParitySearch,
  useJsPipeline,
  useSidecarPipeline,
} from "./helpers/sidecar-parity-helpers.js";
const SHARED_QUERY = "inv-shared-needle";
const ALPHA_ONLY = "inv-alpha-only-marker";
const BETA_ONLY = "inv-beta-only-marker";
const CODEX_ONLY = "inv-codex-only-marker";
const POST_EDIT_ALPHA = "inv-alpha-post-edit-marker";
const POST_EDIT_BETA = "inv-beta-post-edit-marker";

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
    }),
  );
  writeJsonl(
    betaPath,
    claudeRows({
      prompt: "beta plain prompt",
      bodyPhrase: "beta indexed body",
      uniqueMarker: BETA_ONLY,
      model: "claude-opus-4-20250514",
      withBash: false,
    }),
  );
  writeJsonl(
    errPath,
    claudeRows({
      prompt: "error session prompt",
      bodyPhrase: "error indexed body",
      uniqueMarker: "inv-err-only-marker",
      withError: false,
    }),
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

async function withInvalidationParityHarness(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-sidecar-inv-parity-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];
  const originalSidecarPath = process.env[SIDECAR_PATH_ENV];
  process.env.HOME = tmpDir;

  const paths = seedInvalidationFixture(tmpDir);

  try {
    resetIndexWritersForTests();
    const modUrl = new URL("../src/sessions.js?" + Date.now(), import.meta.url);
    const { findSessions, buildIndex } = await import(modUrl.href);

    const api = {
      paths,
      findSessions,
      buildIndex,
      bumpFileMtime,

      freshParityIndexes(sessions) {
        clearDiskIndexCache();
        useJsPipeline();
        const jsIndex = buildIndex(sessions);
        clearDiskIndexCache();
        useSidecarPipeline();
        const sidecarIndex = buildIndex(sessions);
        useJsPipeline();
        return { jsIndex, sidecarIndex };
      },

      jsIndex(sessions) {
        useJsPipeline();
        return buildIndex(sessions);
      },

      sidecarIndexAfterJs(sessions) {
        flushDeferredIndexWriteForTests();
        flushDeferredSearchIdxWriteForTests();
        resetIndexWritersForTests();
        useSidecarPipeline();
        const idx = buildIndex(sessions);
        useJsPipeline();
        return idx;
      },

      runParitySearch,
      assertIndexSearchParity,
    };

    await fn(api);
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

describe("sidecar × JS incremental invalidation search parity", () => {
  test(
    "baseline search: four identical hits before any edits",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions = h.findSessions(null);
        const { jsIndex, sidecarIndex } = h.freshParityIndexes(sessions);
        const { jsHits } = h.runParitySearch(sessions, jsIndex, sidecarIndex, SHARED_QUERY);
        assert.equal(jsHits.length, 4);
        assert.ok(jsHits.some((hit) => hit.path.endsWith("alpha.jsonl")));
        assert.ok(jsHits.some((hit) => hit.path.endsWith("beta.jsonl")));
        assert.ok(jsHits.some((hit) => hit.path.endsWith("err.jsonl")));
        assert.ok(jsHits.some((hit) => hit.path.includes("rollout-inv")));
      });
    },
  );

  test(
    "session edit + mtime bump: both pipelines drop old needle and surface new marker",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        h.jsIndex(sessions1);
        flushDeferredIndexWriteForTests();

        writeJsonl(
          h.paths.alphaPath,
          claudeRows({
            prompt: "alpha edited prompt",
            bodyPhrase: "alpha edited body",
            uniqueMarker: POST_EDIT_ALPHA,
            withBash: true,
          }),
        );
        h.bumpFileMtime(h.paths.alphaPath);

        const sessions2 = h.findSessions(null);
        const jsIndex2 = h.jsIndex(sessions2);
        const sidecarIndex2 = h.sidecarIndexAfterJs(sessions2);

        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, ALPHA_ONLY);
        const { jsHits: postHits } = h.runParitySearch(
          sessions2,
          jsIndex2,
          sidecarIndex2,
          POST_EDIT_ALPHA,
        );
        assert.equal(postHits.length, 1);
        assert.equal(postHits[0].path, h.paths.alphaPath);
        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, SHARED_QUERY);
      });
    },
  );

  test(
    "partial stale re-index: untouched session index fields match across pipelines",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        const jsIndex1 = h.jsIndex(sessions1);
        flushDeferredIndexWriteForTests();

        writeJsonl(
          h.paths.alphaPath,
          claudeRows({
            prompt: "alpha partial-edit prompt",
            bodyPhrase: "alpha partial-edit body",
            uniqueMarker: POST_EDIT_ALPHA,
            withBash: true,
          }),
        );
        h.bumpFileMtime(h.paths.alphaPath);

        const sessions2 = h.findSessions(null);
        const jsIndex2 = h.jsIndex(sessions2);
        const sidecarIndex2 = h.sidecarIndexAfterJs(sessions2);

        for (const untouched of [h.paths.betaPath, h.paths.codexPath, h.paths.errPath]) {
          h.assertIndexSearchParity(
            jsIndex2.get(untouched),
            sidecarIndex2.get(untouched),
            untouched,
          );
        }
        assert.notEqual(jsIndex2.get(h.paths.alphaPath), jsIndex1.get(h.paths.alphaPath));

        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, BETA_ONLY);
        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, CODEX_ONLY);
        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, POST_EDIT_ALPHA);
      });
    },
  );

  test(
    "expr tool:Bash after beta edit: both pipelines see two bash sessions",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        const jsIndex1 = h.jsIndex(sessions1);
        const sidecarIndex1 = h.sidecarIndexAfterJs(sessions1);

        const { jsHits: bashBefore } = h.runParitySearch(sessions1, jsIndex1, sidecarIndex1, SHARED_QUERY, {
          expr: "tool:Bash",
        });
        assert.equal(bashBefore.length, 1);
        assert.match(bashBefore[0].path, /alpha\.jsonl$/);

        writeJsonl(
          h.paths.betaPath,
          claudeRows({
            prompt: "beta now has bash",
            bodyPhrase: "beta bash body",
            uniqueMarker: POST_EDIT_BETA,
            withBash: true,
          }),
        );
        h.bumpFileMtime(h.paths.betaPath);

        const sessions2 = h.findSessions(null);
        const jsIndex2 = h.jsIndex(sessions2);
        const sidecarIndex2 = h.sidecarIndexAfterJs(sessions2);

        const { jsHits: bashAfter } = h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, SHARED_QUERY, {
          expr: "tool:Bash",
        });
        assert.equal(bashAfter.length, 2);
        const bashPaths = bashAfter.map((hit) => hit.path).sort();
        assert.ok(bashPaths.some((p) => p.endsWith("alpha.jsonl")));
        assert.ok(bashPaths.some((p) => p.endsWith("beta.jsonl")));

        const { jsHits: betaOnly } = h.runParitySearch(
          sessions2,
          jsIndex2,
          sidecarIndex2,
          POST_EDIT_BETA,
        );
        assert.equal(betaOnly.length, 1);
        assert.equal(betaOnly[0].path, h.paths.betaPath);
      });
    },
  );

  test(
    "index.json disk mtime bump: both pipelines stay correct after cache invalidation",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions = h.findSessions(null);
        const { jsIndex: js1, sidecarIndex: sc1 } = h.freshParityIndexes(sessions);
        h.runParitySearch(sessions, js1, sc1, SHARED_QUERY);

        flushDeferredIndexWriteForTests();
        const diskIndex = indexPath();
        const bumped = Date.now() + 120_000;
        fs.utimesSync(diskIndex, bumped / 1000, bumped / 1000);

        const jsIndex2 = h.jsIndex(sessions);
        const sidecarIndex2 = h.sidecarIndexAfterJs(sessions);

        const { jsHits } = h.runParitySearch(sessions, jsIndex2, sidecarIndex2, SHARED_QUERY);
        assert.equal(jsHits.length, 4);
        assert.ok(jsHits.every((hit) => hit.matches.length > 0));
      });
    },
  );

  test(
    "persisted disk cache + module reset: both pipelines re-index edited session",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        h.jsIndex(sessions1);
        flushDeferredIndexWriteForTests();
        resetIndexWritersForTests();

        writeJsonl(
          h.paths.alphaPath,
          claudeRows({
            prompt: "alpha disk-cache edit",
            bodyPhrase: "alpha disk-cache body",
            uniqueMarker: POST_EDIT_ALPHA,
            withBash: true,
          }),
        );
        h.bumpFileMtime(h.paths.alphaPath);

        const sessions2 = h.findSessions(null);
        const jsIndex2 = h.jsIndex(sessions2);
        const sidecarIndex2 = h.sidecarIndexAfterJs(sessions2);

        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, ALPHA_ONLY);
        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, POST_EDIT_ALPHA);
        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, BETA_ONLY);
        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, CODEX_ONLY);
      });
    },
  );

  test(
    "removing unique needle: both pipelines drop targeted hit but keep shared query",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        const jsIndex1 = h.jsIndex(sessions1);
        const sidecarIndex1 = h.sidecarIndexAfterJs(sessions1);
        const { jsHits: betaBefore } = h.runParitySearch(
          sessions1,
          jsIndex1,
          sidecarIndex1,
          BETA_ONLY,
        );
        assert.equal(betaBefore.length, 1);

        writeJsonl(
          h.paths.betaPath,
          claudeRows({
            prompt: "beta stripped marker",
            bodyPhrase: "beta stripped body",
            uniqueMarker: "",
            withBash: false,
          }),
        );
        h.bumpFileMtime(h.paths.betaPath);

        const sessions2 = h.findSessions(null);
        const jsIndex2 = h.jsIndex(sessions2);
        const sidecarIndex2 = h.sidecarIndexAfterJs(sessions2);

        h.runParitySearch(sessions2, jsIndex2, sidecarIndex2, BETA_ONLY);
        const { jsHits: sharedHits } = h.runParitySearch(
          sessions2,
          jsIndex2,
          sidecarIndex2,
          SHARED_QUERY,
        );
        assert.equal(sharedHits.length, 4);
        assert.ok(sharedHits.some((hit) => hit.path === h.paths.betaPath));
      });
    },
  );

  test(
    "second buildIndex after edit: JS result-map cache and sidecar search stay aligned",
    SKIP_NO_SIDECAR,
    async () => {
      await withInvalidationParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        h.jsIndex(sessions1);

        writeJsonl(
          h.paths.alphaPath,
          claudeRows({
            prompt: "alpha cache-stable edit",
            bodyPhrase: "alpha cache-stable body",
            uniqueMarker: POST_EDIT_ALPHA,
            withBash: true,
          }),
        );
        h.bumpFileMtime(h.paths.alphaPath);

        const sessions2 = h.findSessions(null);
        const jsMapA = h.jsIndex(sessions2);
        const jsMapB = h.jsIndex(sessions2);
        assert.equal(jsMapA, jsMapB, "JS result map cache must reuse object identity");

        const sidecarIndex = h.sidecarIndexAfterJs(sessions2);
        h.runParitySearch(sessions2, jsMapB, sidecarIndex, POST_EDIT_ALPHA);
        h.runParitySearch(sessions2, jsMapB, sidecarIndex, ALPHA_ONLY);
      });
    },
  );
});