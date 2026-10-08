import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildShareMetadata } from "../../src/share/metadata.js";
import { minimalSession } from "../helpers/minimal-session.js";
import { INDEX_VERSION } from "../../src/sessions/index-writers.js";
import { SearchIndex } from "../../src/sessions/search-index.js";
import { sessionListChecksum } from "../../src/sessions/session-list.js";

const PATH_A = "/tmp/tq-meta-prune-a.jsonl";
const PATH_B = "/tmp/tq-meta-prune-b.jsonl";
const MTIME_A = 1_700_000_000_000;
const MTIME_B = MTIME_A + 1000;

function defaultCachedIndexEntry(mtime, overrides = {}) {
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
    ...overrides,
  };
}

async function withIndexHarness(fn) {
  const tmpDir = fs.mkdtempSync("/tmp/metadata-index-prune-");
  const cacheDir = path.join(tmpDir, ".cache", "tracequest");
  fs.mkdirSync(cacheDir, { recursive: true });
  const indexPath = path.join(cacheDir, "index.json");

  const diskEntries = {
    [PATH_A]: defaultCachedIndexEntry(MTIME_A, { firstPrompt: "session-a" }),
    [PATH_B]: defaultCachedIndexEntry(MTIME_B, { firstPrompt: "session-b" }),
  };
  fs.writeFileSync(indexPath, JSON.stringify({ _v: INDEX_VERSION, ...diskEntries }));

  const warmSI = new SearchIndex();
  for (const p of Object.keys(diskEntries)) {
    warmSI.upsert(p, new Map([["__warm__", 1]]));
  }
  fs.writeFileSync(path.join(cacheDir, "search.idx"), warmSI.serialize());

  const originalHome = process.env.HOME;
  const hadNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  try {
    const modUrl = new URL("../../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
    const {
      buildIndex,
      flushDeferredIndexWriteForTests,
      flushDeferredSearchIdxWriteForTests,
      initIndexWriters,
      resetIndexWritersForTests,
    } = await import(modUrl.href);

    const indexSessionCalls = { n: 0 };
    initIndexWriters({
      indexSession: () => {
        indexSessionCalls.n++;
        return { firstPrompt: "fresh-index" };
      },
      sessionListChecksum,
    });
    resetIndexWritersForTests();

    await fn({
      tmpDir,
      indexPath,
      buildIndex,
      flushDeferredIndexWriteForTests,
      flushDeferredSearchIdxWriteForTests,
      indexSessionCalls,
    });
  } finally {
    process.env.HOME = originalHome;
    if (hadNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = hadNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("share metadata index prune regression", () => {
  test("buildShareMetadata does not prune unrelated sessions from index.json or search.idx", async () => {
    await withIndexHarness(async ({
      indexPath,
      buildIndex,
      flushDeferredIndexWriteForTests,
      flushDeferredSearchIdxWriteForTests,
      indexSessionCalls,
    }) => {
      const sessionA = { path: PATH_A, mtime: new Date(MTIME_A), source: "claude", size: 1, project: "proj-a" };
      const sessionB = { path: PATH_B, mtime: new Date(MTIME_B), source: "claude", size: 1, project: "proj-b" };

      buildIndex([sessionA, sessionB]);
      flushDeferredIndexWriteForTests();
      flushDeferredSearchIdxWriteForTests();
      indexSessionCalls.n = 0;

      const session = minimalSession({ sessionId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
      buildShareMetadata(session, { discovery: sessionB });

      flushDeferredIndexWriteForTests();
      flushDeferredSearchIdxWriteForTests();

      const written = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
      assert.ok(written[PATH_A], "index.json must retain session A after buildShareMetadata");
      assert.ok(written[PATH_B], "index.json must retain session B after buildShareMetadata");

      const result = buildIndex([sessionA, sessionB]);
      assert.equal(result.has(PATH_A), true);
      assert.equal(result.has(PATH_B), true);
      assert.equal(indexSessionCalls.n, 0, "subsequent buildIndex should be all-cache hit (0 stale)");
    });
  });
});