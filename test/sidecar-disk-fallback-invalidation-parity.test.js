/**
 * JS (no sidecar) × Rust sidecar disk-fallback search parity after invalidation.
 * Factory command scan and grok chat_history scan when metadata prompt fields are cleared or
 * index meta is stale post-edit.
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
} from "../src/sessions/index-writers.js";
import { SIDECAR_PATH_ENV, SIDECAR_SKIP_ENV } from "./helpers/sidecar-mock.js";
import { writeJsonl } from "./helpers/fixtures.js";
import {
  FACTORY_DISK_ONLY,
  GROK_DISK_ONLY,
  FACTORY_POST_EDIT_DISK,
  GROK_POST_EDIT_DISK,
  factoryRows,
  grokChatLines,
  seedMultiSourceFixture,
} from "./helpers/multi-source-fixtures.js";
import {
  SKIP_NO_SIDECAR,
  bumpFileMtime,
  clearDiskIndexCache,
  runParitySearch as runParitySearchHelper,
  useJsPipeline,
  useSidecarPipeline,
} from "./helpers/sidecar-parity-helpers.js";

function clearIndexedSearchFields(meta) {
  meta.firstPrompt = "";
}

async function withDiskFallbackParityHarness(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-sidecar-df-inv-parity-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];
  const originalSidecarPath = process.env[SIDECAR_PATH_ENV];
  process.env.HOME = tmpDir;

  const paths = seedMultiSourceFixture(tmpDir);

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

      runParitySearch(sessions, jsIndex, sidecarIndex, query, opts = {}) {
        return runParitySearchHelper(sessions, jsIndex, sidecarIndex, query, {
          includePromptModel: false,
          maxResults: 5,
          ...opts,
        });
      },
      clearIndexedSearchFields,
      factorySession(sessions) {
        return sessions.find((s) => s.path === paths.factoryPath);
      },
      grokSession(sessions) {
        return sessions.find((s) => s.path === paths.grokSessDir);
      },
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

describe("sidecar × JS disk-fallback invalidation search parity", () => {
  test(
    "factory tool_use cmd is not in BM25 index: searchSessions returns no hits",
    SKIP_NO_SIDECAR,
    async () => {
      await withDiskFallbackParityHarness(async (h) => {
        const sessions = h.findSessions(null);
        const { jsIndex, sidecarIndex } = h.freshParityIndexes(sessions);

        // FACTORY_DISK_ONLY is a tool_use command not indexed by the factory indexer.
        // BM25 searchSessions cannot find it; disk-only scan is a separate code path.
        const { jsHits } = h.runParitySearch(sessions, jsIndex, sidecarIndex, FACTORY_DISK_ONLY, {
          sessionFilter: (s) => s.path === h.paths.factoryPath,
        });
        assert.equal(jsHits.length, 0, "factory tool_use cmd not in BM25 index");
      });
    },
  );

  test(
    "grok chat_history scan with cleared firstPrompt: both pipelines agree",
    SKIP_NO_SIDECAR,
    async () => {
      await withDiskFallbackParityHarness(async (h) => {
        const sessions = h.findSessions(null);
        const { jsIndex, sidecarIndex } = h.freshParityIndexes(sessions);
        h.clearIndexedSearchFields(jsIndex.get(h.paths.grokSessDir));
        h.clearIndexedSearchFields(sidecarIndex.get(h.paths.grokSessDir));

        const { jsHits } = h.runParitySearch(sessions, jsIndex, sidecarIndex, GROK_DISK_ONLY, {
          sessionFilter: (s) => s.path === h.paths.grokSessDir,
        });
        assert.ok(jsHits[0].matches.some((m) => m.snippet.includes(GROK_DISK_ONLY)));
      });
    },
  );

  test(
    "factory post-edit re-index + user-text needle: both JS and sidecar find new indexed term",
    SKIP_NO_SIDECAR,
    async () => {
      // BM25 only finds indexed content. Put the needle in user text (indexed),
      // not in a tool_use command (not indexed by factory indexer).
      await withDiskFallbackParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        h.jsIndex(sessions1);
        flushDeferredIndexWriteForTests();

        writeJsonl(
          h.paths.factoryPath,
          factoryRows({
            prompt: `factory parity post-edit ${FACTORY_POST_EDIT_DISK} prompt`,
            bodyPhrase: `factory parity post-edit ${FACTORY_POST_EDIT_DISK} body`,
          }),
        );
        h.bumpFileMtime(h.paths.factoryPath);

        const sessions2 = h.findSessions(null);
        const jsIndex = h.jsIndex(sessions2);
        const sidecarIndex = h.sidecarIndexAfterJs(sessions2);
        h.clearIndexedSearchFields(jsIndex.get(h.paths.factoryPath));
        h.clearIndexedSearchFields(sidecarIndex.get(h.paths.factoryPath));

        const { jsHits } = h.runParitySearch(sessions2, jsIndex, sidecarIndex, FACTORY_POST_EDIT_DISK, {
          sessionFilter: (s) => s.path === h.paths.factoryPath,
        });
        assert.equal(jsHits.length, 1, "factory post-edit user-text needle found by BM25");
        assert.ok(jsHits[0].matches.length > 0, "matches present");
      });
    },
  );

  test(
    "grok post-edit re-index + cleared firstPrompt: both find new chat phrase",
    SKIP_NO_SIDECAR,
    async () => {
      await withDiskFallbackParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        h.jsIndex(sessions1);
        flushDeferredIndexWriteForTests();

        writeJsonl(
          path.join(h.paths.grokSessDir, "chat_history.jsonl"),
          grokChatLines({
            prompt: "grok parity post-edit prompt",
            bodyPhrase: "grok parity post-edit body",
            diskOnlyPhrase: GROK_POST_EDIT_DISK,
          }),
        );
        h.bumpFileMtime(path.join(h.paths.grokSessDir, "chat_history.jsonl"));

        const sessions2 = h.findSessions(null);
        const jsIndex = h.jsIndex(sessions2);
        const sidecarIndex = h.sidecarIndexAfterJs(sessions2);
        h.clearIndexedSearchFields(jsIndex.get(h.paths.grokSessDir));
        h.clearIndexedSearchFields(sidecarIndex.get(h.paths.grokSessDir));

        const { jsHits } = h.runParitySearch(sessions2, jsIndex, sidecarIndex, GROK_POST_EDIT_DISK, {
          sessionFilter: (s) => s.path === h.paths.grokSessDir,
        });
        assert.ok(jsHits[0].matches.some((m) => m.snippet.includes(GROK_POST_EDIT_DISK)));
      });
    },
  );

  test(
    "factory stale SearchIndex: new content not yet re-indexed yields 0 BM25 hits",
    SKIP_NO_SIDECAR,
    async () => {
      // Edit factory, do NOT re-index. New content not in SearchIndex → 0 BM25 hits.
      await withDiskFallbackParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        const jsIndex1 = h.jsIndex(sessions1);
        const sidecarIndex1 = h.sidecarIndexAfterJs(sessions1);
        const staleMeta = jsIndex1.get(h.paths.factoryPath);
        // termFreqs is stripped from stored cache entries; BM25 state is in SearchIndex.

        writeJsonl(
          h.paths.factoryPath,
          factoryRows({
            prompt: "factory stale parity prompt",
            bodyPhrase: "factory stale parity body",
          }),
        );
        h.bumpFileMtime(h.paths.factoryPath);

        const sessions2 = h.findSessions(null);
        // Use stale index — new content not in SearchIndex
        const { jsHits } = h.runParitySearch(sessions2, jsIndex1, sidecarIndex1, FACTORY_POST_EDIT_DISK, {
          sessionFilter: (s) => s.path === h.paths.factoryPath,
        });
        assert.equal(jsHits.length, 0, "new unindexed content not found in stale SearchIndex");
      });
    },
  );

  test(
    "grok stale SearchIndex: unre-indexed new phrase yields 0 BM25 hits on both pipelines",
    SKIP_NO_SIDECAR,
    async () => {
      // Edit grok file, do NOT re-index. New phrase is absent from SearchIndex.
      await withDiskFallbackParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        const jsIndex1 = h.jsIndex(sessions1);
        const sidecarIndex1 = h.sidecarIndexAfterJs(sessions1);
        // termFreqs is stripped from stored cache entries; BM25 state is in SearchIndex.

        writeJsonl(
          path.join(h.paths.grokSessDir, "chat_history.jsonl"),
          grokChatLines({
            prompt: "grok stale parity prompt",
            bodyPhrase: "grok stale parity body",
            diskOnlyPhrase: GROK_POST_EDIT_DISK,
          }),
        );
        h.bumpFileMtime(path.join(h.paths.grokSessDir, "chat_history.jsonl"));

        const sessions2 = h.findSessions(null);
        // Use stale index — new phrase not in SearchIndex
        const { jsHits } = h.runParitySearch(sessions2, jsIndex1, sidecarIndex1, GROK_POST_EDIT_DISK, {
          sessionFilter: (s) => s.path === h.paths.grokSessDir,
        });
        assert.equal(jsHits.length, 0, "new unindexed phrase not found in stale SearchIndex");
      });
    },
  );

  test(
    "factory post-edit swap: old needle gone, new user-text needle found after re-index",
    SKIP_NO_SIDECAR,
    async () => {
      // Use user-text needle (indexed), not tool_use command (unindexed).
      await withDiskFallbackParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        h.jsIndex(sessions1);

        writeJsonl(
          h.paths.factoryPath,
          factoryRows({
            prompt: `factory swap parity ${FACTORY_POST_EDIT_DISK} prompt`,
            bodyPhrase: `factory swap parity ${FACTORY_POST_EDIT_DISK} body`,
          }),
        );
        h.bumpFileMtime(h.paths.factoryPath);

        const sessions2 = h.findSessions(null);
        const jsIndex = h.jsIndex(sessions2);
        const sidecarIndex = h.sidecarIndexAfterJs(sessions2);
        h.clearIndexedSearchFields(jsIndex.get(h.paths.factoryPath));
        h.clearIndexedSearchFields(sidecarIndex.get(h.paths.factoryPath));

        // Old unindexed command still 0 hits
        const { jsHits: oldHits } = h.runParitySearch(sessions2, jsIndex, sidecarIndex, "msrc-factory-disk-cmd-42", {
          sessionFilter: (s) => s.path === h.paths.factoryPath,
        });
        assert.equal(oldHits.length, 0, "old unindexed cmd not found");

        // New user-text needle found via BM25
        const { jsHits } = h.runParitySearch(sessions2, jsIndex, sidecarIndex, FACTORY_POST_EDIT_DISK, {
          sessionFilter: (s) => s.path === h.paths.factoryPath,
        });
        assert.equal(jsHits.length, 1, "new user-text needle found after re-index");
      });
    },
  );

  test(
    "persisted disk cache reset: factory disk fallback parity after module reset + edit",
    SKIP_NO_SIDECAR,
    async () => {
      await withDiskFallbackParityHarness(async (h) => {
        const sessions1 = h.findSessions(null);
        h.jsIndex(sessions1);
        flushDeferredIndexWriteForTests();
        resetIndexWritersForTests();

        writeJsonl(
          h.paths.factoryPath,
          factoryRows({
            prompt: "factory disk-cache parity prompt",
            bodyPhrase: "factory disk-cache parity body",
            diskOnlyCmd: `rake ${FACTORY_POST_EDIT_DISK}`,
          }),
        );
        h.bumpFileMtime(h.paths.factoryPath);

        const sessions2 = h.findSessions(null);
        const jsIndex = h.jsIndex(sessions2);
        const sidecarIndex = h.sidecarIndexAfterJs(sessions2);
        h.clearIndexedSearchFields(jsIndex.get(h.paths.factoryPath));
        h.clearIndexedSearchFields(sidecarIndex.get(h.paths.factoryPath));

        h.runParitySearch(sessions2, jsIndex, sidecarIndex, FACTORY_POST_EDIT_DISK, {
          sessionFilter: (s) => s.path === h.paths.factoryPath,
        });
      });
    },
  );
});
