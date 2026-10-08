/**
 * BM25 search after index invalidation / stale scenarios.
 *
 * The old "disk-fallback" tests verified substring scan of unindexed content.
 * With the BM25 path, searchSessions only finds terms that are in the SearchIndex
 * (built from termFreqs). Content that was never indexed — such as factory tool_use
 * command text (not pushed to termFreqs) — is simply not found.
 *
 * This file has been updated (Batch 2) to reflect BM25 semantics:
 * - BM25 finds indexed terms even when metadata firstPrompt is cleared (it uses SearchIndex)
 * - Content not in the SearchIndex (unindexed disk-only cmds, stale unre-indexed edits) → 0 results
 * - After re-indexing a changed session, new indexed terms ARE found via BM25
 *
 * The GROK_DISK_ONLY phrase (user message) IS indexed via pushIndexSearchChunk,
 * so BM25 finds it even when firstPrompt is cleared.
 * FACTORY_DISK_ONLY (tool_use input.command) is NOT indexed (factory indexer
 * does not push command inputs into termFreqs) — BM25 cannot find it.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { searchSessions } from "../../src/sessions/scan-queries.js";
import {
  flushDeferredIndexWriteForTests,
  resetIndexWritersForTests,
} from "../../src/sessions/index-writers.js";
import { bumpFileMtime, writeJsonl } from "../helpers/fixtures.js";
import {
  SHARED_QUERY,
  GROK_DISK_ONLY,
  FACTORY_POST_EDIT_DISK,
  GROK_POST_EDIT_DISK,
  factoryRows,
  grokChatLines,
} from "../helpers/multi-source-fixtures.js";
import { withMultiSourceHarness } from "../helpers/multi-source-harness.js";

function clearIndexedSearchFields(meta) {
  meta.firstPrompt = "";
}

function factorySession(sessions, factoryPath) {
  const s = sessions.find((row) => row.path === factoryPath);
  assert.ok(s, "factory session missing");
  return s;
}

function grokSession(sessions, grokSessDir) {
  const s = sessions.find((row) => row.path === grokSessDir);
  assert.ok(s, "grok session missing");
  return s;
}

const diskFallbackHarness = (fn) => withMultiSourceHarness(fn, { seedOpenCode: false });

describe("BM25 search after index invalidation (JS pipeline)", () => {
  test("grok indexed user text is found via BM25 even when firstPrompt is cleared", async () => {
    // GROK_DISK_ONLY is a user message pushed to termFreqs at index time.
    // BM25 uses the SearchIndex, so clearing firstPrompt does NOT affect BM25 results.
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions = findSessions(null);
      const index = buildIndex(sessions);
      const meta = index.get(paths.grokSessDir);
      clearIndexedSearchFields(meta);

      const hits = searchSessions([grokSession(sessions, paths.grokSessDir)], index, GROK_DISK_ONLY, 5);
      assert.equal(hits.length, 1, "grok baseline BM25: grok user text found even with cleared firstPrompt");
      assert.ok(hits[0].matches.length > 0, "grok baseline BM25: has match snippets");
    });
  });

  test("factory tool_use command (not indexed) returns 0 BM25 hits", async () => {
    // FACTORY_DISK_ONLY is in tool_use.input.command — not pushed to termFreqs by factory indexer.
    // BM25 cannot find content that was never indexed; result is 0 hits.
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions = findSessions(null);
      const index = buildIndex(sessions);
      const hits = searchSessions([factorySession(sessions, paths.factoryPath)], index, "msrc-factory-disk-cmd-42", 5);
      assert.equal(hits.length, 0, "unindexed command text is not found by BM25");
    });
  });

  test("shared-query indexed term is found via BM25 with or without firstPrompt", async () => {
    // SHARED_QUERY appears in both user and assistant text, so IS indexed.
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions = findSessions(null);
      const index = buildIndex(sessions);
      const meta = index.get(paths.factoryPath);
      clearIndexedSearchFields(meta);

      const hits = searchSessions([factorySession(sessions, paths.factoryPath)], index, SHARED_QUERY, 5);
      assert.equal(hits.length, 1, "indexed shared query found by BM25 after firstPrompt cleared");
    });
  });

  test("factory post-edit re-index: re-indexed user-text term is found by BM25", async () => {
    // After editing the factory file and calling buildIndex (re-indexing), new user-text
    // terms enter the SearchIndex and are found by BM25.
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      buildIndex(sessions1);
      flushDeferredIndexWriteForTests();

      writeJsonl(
        paths.factoryPath,
        factoryRows({
          prompt: `factory post-edit ${FACTORY_POST_EDIT_DISK} prompt`,
          bodyPhrase: `factory post-edit ${FACTORY_POST_EDIT_DISK} body`,
          withBash: false,
        }),
      );
      bumpFileMtime(paths.factoryPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      const hits = searchSessions(
        [factorySession(sessions2, paths.factoryPath)],
        index2,
        FACTORY_POST_EDIT_DISK,
        5,
      );
      assert.equal(hits.length, 1, "factory post-edit user-text is found by BM25 after re-index");
    });
  });

  test("grok post-edit re-index: new user phrase is found by BM25", async () => {
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      buildIndex(sessions1);
      flushDeferredIndexWriteForTests();

      writeJsonl(
        path.join(paths.grokSessDir, "chat_history.jsonl"),
        grokChatLines({
          prompt: "grok post-edit prompt",
          bodyPhrase: "grok post-edit body",
          diskOnlyPhrase: GROK_POST_EDIT_DISK,
        }),
      );
      bumpFileMtime(path.join(paths.grokSessDir, "chat_history.jsonl"));

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      const hits = searchSessions(
        [grokSession(sessions2, paths.grokSessDir)],
        index2,
        GROK_POST_EDIT_DISK,
        5,
      );
      assert.equal(hits.length, 1, "grok post-edit new user phrase is found by BM25 after re-index");
      assert.ok(hits[0].matches.some((m) => m.snippet.includes(GROK_POST_EDIT_DISK)), "snippet present");
    });
  });

  test("stale SearchIndex: new grok user phrase not yet re-indexed yields 0 BM25 hits", async () => {
    // Edit the file but do NOT re-index. The new phrase is not in the old SearchIndex.
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      const index1 = buildIndex(sessions1);

      writeJsonl(
        path.join(paths.grokSessDir, "chat_history.jsonl"),
        grokChatLines({
          prompt: "grok stale prompt",
          bodyPhrase: "grok stale body",
          diskOnlyPhrase: GROK_POST_EDIT_DISK,
        }),
      );
      bumpFileMtime(path.join(paths.grokSessDir, "chat_history.jsonl"));

      const sessions2 = findSessions(null);
      // Do NOT call buildIndex again — stale index scenario
      const hits = searchSessions(
        [grokSession(sessions2, paths.grokSessDir)],
        index1,
        GROK_POST_EDIT_DISK,
        5,
      );
      assert.equal(hits.length, 0, "new unindexed term not found in stale SearchIndex");
    });
  });

  test("factory post-edit swap: old indexed term gone, new indexed term found after re-index", async () => {
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      buildIndex(sessions1);

      writeJsonl(
        paths.factoryPath,
        factoryRows({
          prompt: `factory swapped ${FACTORY_POST_EDIT_DISK} prompt`,
          bodyPhrase: `factory swapped ${FACTORY_POST_EDIT_DISK} body`,
        }),
      );
      bumpFileMtime(paths.factoryPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      // Old unindexed needle was never in index — still 0 hits
      const oldHits = searchSessions(
        [factorySession(sessions2, paths.factoryPath)],
        index2,
        "msrc-factory-disk-cmd-42",
        5,
      );
      assert.equal(oldHits.length, 0, "old unindexed cmd not found after re-index");

      // New user-text needle is indexed after re-index
      const newHits = searchSessions(
        [factorySession(sessions2, paths.factoryPath)],
        index2,
        FACTORY_POST_EDIT_DISK,
        5,
      );
      assert.equal(newHits.length, 1, "new user-text needle found after re-index");
    });
  });

  test("module reset + re-index: new indexed user term found after reset + edit + buildIndex", async () => {
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      buildIndex(sessions1);
      flushDeferredIndexWriteForTests();
      resetIndexWritersForTests();

      writeJsonl(
        paths.factoryPath,
        factoryRows({
          prompt: `factory disk-cache ${FACTORY_POST_EDIT_DISK} prompt`,
          bodyPhrase: `factory disk-cache ${FACTORY_POST_EDIT_DISK} body`,
        }),
      );
      bumpFileMtime(paths.factoryPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);

      const hits = searchSessions(
        [factorySession(sessions2, paths.factoryPath)],
        index2,
        FACTORY_POST_EDIT_DISK,
        5,
      );
      assert.equal(hits.length, 1, "new indexed term found after module reset + re-index");
    });
  });

  test("partial re-index: factory re-indexed, grok unchanged — both searchable via BM25", async () => {
    await diskFallbackHarness(async ({ paths, findSessions, buildIndex }) => {
      const sessions1 = findSessions(null);
      const index1 = buildIndex(sessions1);
      const grokMetaBefore = index1.get(paths.grokSessDir);
      flushDeferredIndexWriteForTests();

      writeJsonl(
        paths.factoryPath,
        factoryRows({
          prompt: `factory partial-stale ${FACTORY_POST_EDIT_DISK} prompt`,
          bodyPhrase: `factory partial-stale ${FACTORY_POST_EDIT_DISK} body`,
        }),
      );
      bumpFileMtime(paths.factoryPath);

      const sessions2 = findSessions(null);
      const index2 = buildIndex(sessions2);
      assert.equal(index2.get(paths.grokSessDir), grokMetaBefore, "grok meta object identity preserved");

      // Factory new indexed term found
      const factoryHits = searchSessions(
        [factorySession(sessions2, paths.factoryPath)],
        index2,
        FACTORY_POST_EDIT_DISK,
        5,
      );
      assert.equal(factoryHits.length, 1, "partial stale factory: new indexed term found");

      // Grok indexed user text still found (not re-indexed, but still in SearchIndex)
      const grokHits = searchSessions(
        [grokSession(sessions2, paths.grokSessDir)],
        index2,
        GROK_DISK_ONLY,
        5,
      );
      assert.equal(grokHits.length, 1, "partial stale grok: existing indexed user text found");
    });
  });
});
