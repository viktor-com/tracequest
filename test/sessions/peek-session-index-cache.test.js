/**
 * peekSession (partial prefix read) vs full indexSession/buildIndex,
 * and getSessionMeta index-hit vs peek fallback when buildIndex is warm.
 */
import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { peekSession } from "../../src/sessions/session-peek.js";
import { indexSession } from "../../src/sessions/session-index-core.js";
import { indexCodexJsonl } from "../../src/sessions/session-index-jsonl.js";
import { INDEX_VERSION, resetIndexWritersForTests } from "../../src/sessions/index-writers.js";
import { SearchIndex } from "../../src/sessions/search-index.js";

/** Same logic as server-helpers.getSessionMeta (avoid importing server-http → server-state). */
function getSessionMeta(index, session, peekSession) {
  return index.get(session.path) || (peekSession ? peekSession(session) : {});
}
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

function padJsonlUntil(filePath, minBytes, filler = { type: "padding", payload: "x" }) {
  const fillerLine = JSON.stringify(filler) + "\n";
  const lineCount = Math.ceil(minBytes / Buffer.byteLength(fillerLine, "utf-8"));
  fs.appendFileSync(filePath, fillerLine.repeat(lineCount));
}

async function importSessionsModule() {
  const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

async function withTmpHome(fn) {
  const tmpDir = mkTmp("tq-peek-idx-cache-");
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  // Reset the shared index-writers module state so SI/mtime caches from
  // prior tests don't bleed into this one (sessions.js re-import shares
  // the same index-writers.js module instance across test runs).
  resetIndexWritersForTests();
  try {
    const mod = await importSessionsModule();
    return await fn(tmpDir, mod);
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    resetIndexWritersForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("peekSession fast path vs full indexSession", () => {
  test("peekSession returns sparse meta; indexSession includes chapters and tokens", () => {
    const tmpDir = mkTmp("tq-peek-vs-full-shape-");
    const filePath = path.join(tmpDir, "session.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: { content: [{ type: "text", text: "Shape parity prompt" }] },
        timestamp: "2026-05-01T00:00:00Z",
      },
      {
        type: "assistant",
        message: {
          model: "claude-sonnet-4",
          usage: { input_tokens: 40, output_tokens: 12 },
          content: [{ type: "text", text: "indexed reply" }],
        },
        timestamp: "2026-05-01T00:01:00Z",
      },
      {
        type: "user",
        message: { content: [{ type: "text", text: "second chapter turn" }] },
        timestamp: "2026-05-01T00:02:00Z",
      },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const session = { path: filePath, size, source: "claude" };
      const peek = peekSession(session);
      const full = indexSession(session);

      assert.equal(peek.firstPrompt, full.firstPrompt);
      assert.equal(peek.firstPrompt, "Shape parity prompt");
      assert.equal(peek.model, full.model);
      assert.equal(peek.chapters, undefined);
      assert.equal(peek.totalTokens, undefined);
      assert.equal(full.chapters, 2);
      assert.equal(full.totalTokens, 52);
      assert.ok(full.termFreqs instanceof Map && full.termFreqs.has("indexed") && full.termFreqs.has("reply"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("codex peekSession firstPrompt matches indexCodexJsonl", () => {
    const tmpDir = mkTmp("tq-peek-codex-parity-");
    const filePath = path.join(tmpDir, "rollout.jsonl");
    writeJsonl(filePath, [
      { type: "session_meta", payload: { model_provider: "openai-codex" } },
      {
        type: "response_item",
        payload: {
          role: "user",
          content: [{ type: "input_text", text: "Codex cache parity probe" }],
        },
      },
      { type: "event_msg", payload: { type: "exec_command_end" } },
    ]);
    try {
      const size = fs.statSync(filePath).size;
      const session = { path: filePath, size, source: "codex" };
      const peek = peekSession(session);
      const index = indexCodexJsonl(filePath);
      assert.equal(peek.firstPrompt, index.firstPrompt);
      assert.equal(index.firstPrompt, "Codex cache parity probe");
      assert.ok(peek.tools.includes("Bash"));
      assert.equal(index.chapters, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekSession misses late prompt beyond 512KiB prefix; full index still indexes it", () => {
    const tmpDir = mkTmp("tq-peek-partial-vs-full-");
    const filePath = path.join(tmpDir, "late-prompt.jsonl");
    padJsonlUntil(filePath, 600_000);
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "text", text: "Late prompt only in full index" }] },
        timestamp: "2026-06-04T00:00:00Z",
      }) + "\n"
    );
    try {
      const size = fs.statSync(filePath).size;
      const session = { path: filePath, size, source: "claude" };
      const peek = peekSession(session);
      const full = indexSession(session);

      assert.equal(peek.firstPrompt, null);
      assert.equal(full.firstPrompt, "Late prompt only in full index");
      assert.ok(full.termFreqs instanceof Map && full.termFreqs.has("late") && full.termFreqs.has("prompt") && full.termFreqs.has("full") && full.termFreqs.has("index"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("peekSession and indexSession agree on early prompt inside partial prefix", () => {
    const tmpDir = mkTmp("tq-peek-early-parity-");
    const filePath = path.join(tmpDir, "early.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: { content: [{ type: "text", text: "Early shared prompt" }] },
        timestamp: "2026-05-01T00:00:00Z",
      },
    ]);
    padJsonlUntil(filePath, 600_000);
    try {
      const size = fs.statSync(filePath).size;
      const session = { path: filePath, size, source: "claude" };
      assert.equal(peekSession(session).firstPrompt, indexSession(session).firstPrompt);
      assert.equal(peekSession(session).firstPrompt, "Early shared prompt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("buildIndex cache vs peekSession on-disk read", () => {
  test("warm buildIndex Map reuse returns same instance without re-indexing", async () => {
    await withTmpHome(async (_tmpDir, { buildIndex }) => {
      const tmpDir = mkTmp("tq-bi-map-reuse-");
      const filePath = path.join(tmpDir, "cached.jsonl");
      writeJsonl(filePath, [
        {
          type: "user",
          message: { content: [{ type: "text", text: "Cached index prompt" }] },
          timestamp: "2026-05-01T00:00:00Z",
        },
      ]);
      try {
        const stat = fs.statSync(filePath);
        const session = {
          path: filePath,
          mtime: stat.mtime,
          size: stat.size,
          source: "claude",
        };
        const map1 = buildIndex([session]);
        const map2 = buildIndex([session]);
        assert.strictEqual(map1, map2, "second buildIndex must reuse cached Map");
        assert.equal(map1.get(filePath).firstPrompt, "Cached index prompt");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  test("buildIndex keeps in-memory entry when session mtime unchanged but file content changes", async () => {
    await withTmpHome(async (_tmpDir, { buildIndex }) => {
      const tmpDir = mkTmp("tq-bi-mtime-cache-");
      const filePath = path.join(tmpDir, "mutate.jsonl");
      writeJsonl(filePath, [
        {
          type: "user",
          message: { content: [{ type: "text", text: "Index version A" }] },
          timestamp: "2026-05-01T00:00:00Z",
        },
      ]);
      try {
        const stat = fs.statSync(filePath);
        const session = {
          path: filePath,
          mtime: stat.mtime,
          size: stat.size,
          source: "claude",
        };
        const map1 = buildIndex([session]);
        assert.equal(map1.get(filePath).firstPrompt, "Index version A");

        writeJsonl(filePath, [
          {
            type: "user",
            message: { content: [{ type: "text", text: "Peek sees version B" }] },
            timestamp: "2026-05-01T00:01:00Z",
          },
        ]);
        const newStat = fs.statSync(filePath);
        fs.utimesSync(filePath, stat.atime, stat.mtime);

        const sessionSameMtime = {
          ...session,
          size: newStat.size,
          mtime: stat.mtime,
        };
        const map2 = buildIndex([sessionSameMtime]);
        assert.equal(map2.get(filePath).firstPrompt, "Index version A");

        const peek = peekSession(sessionSameMtime);
        assert.equal(peek.firstPrompt, "Peek sees version B");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  test("buildIndex loads matching disk cache entry and skips full re-index when mtime matches", async () => {
    await withTmpHome(async (home, { buildIndex }) => {
      const filePath = path.join(home, "disk-cached.jsonl");
      const mtimeMs = 1_715_731_200_000;
      writeJsonl(filePath, [
        {
          type: "user",
          message: { content: [{ type: "text", text: "Should not be read from disk" }] },
          timestamp: "2026-05-01T00:00:00Z",
        },
      ]);
      fs.utimesSync(filePath, mtimeMs / 1000, mtimeMs / 1000);

      const cacheDir = path.join(home, ".cache", "tracequest");
      fs.mkdirSync(cacheDir, { recursive: true });
      fs.writeFileSync(
        path.join(cacheDir, "index.json"),
        JSON.stringify({
          _v: INDEX_VERSION,
          [filePath]: {
            mtime: mtimeMs,
            firstPrompt: "From disk cache",
            model: "claude-3",
            tools: [],
            toolCounts: {},
            chapters: 3,
            totalTokens: 99,
            inputTokens: 60,
            outputTokens: 39,
            cacheReadTokens: 0,
            durationMs: 1000,
            errors: 0,
            files: 0,
            commits: 0,
          },
        })
      );
      // Write a warm search.idx so the mtime-matched session is found in SI
      // and not force-re-indexed (fact msg: re-tokenize only when absent from SI).
      const warmSI = new SearchIndex();
      warmSI.upsert(filePath, new Map([["__warm__", 1]]));
      fs.writeFileSync(path.join(cacheDir, "search.idx"), warmSI.serialize());

      const session = {
        path: filePath,
        mtime: new Date(mtimeMs),
        size: fs.statSync(filePath).size,
        source: "claude",
      };
      const map = buildIndex([session]);
      const meta = map.get(filePath);
      assert.equal(meta.firstPrompt, "From disk cache");
      assert.equal(meta.chapters, 3);
      assert.equal(meta.totalTokens, 99);
      assert.equal(peekSession(session).firstPrompt, "Should not be read from disk");
    });
  });
});

describe("getSessionMeta index hit vs peekSession fallback", () => {
  test("uses buildIndex entry without calling peekSession when path is indexed", async () => {
    await withTmpHome(async (_tmpDir, { buildIndex }) => {
      const tmpDir = mkTmp("tq-meta-index-hit-");
      const filePath = path.join(tmpDir, "indexed.jsonl");
      writeJsonl(filePath, [
        {
          type: "user",
          message: { content: [{ type: "text", text: "Indexed meta wins" }] },
          timestamp: "2026-05-01T00:00:00Z",
        },
      ]);
      try {
        const stat = fs.statSync(filePath);
        const session = {
          path: filePath,
          mtime: stat.mtime,
          size: stat.size,
          source: "claude",
        };
        const index = buildIndex([session]);
        const peekSpy = mock.fn(() => ({ firstPrompt: "should not run" }));
        const meta = getSessionMeta(index, session, peekSpy);
        assert.equal(meta.firstPrompt, "Indexed meta wins");
        assert.equal(peekSpy.mock.calls.length, 0);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  test("falls back to peekSession when buildIndex Map has no entry for path", () => {
    const tmpDir = mkTmp("tq-meta-peek-fallback-");
    const filePath = path.join(tmpDir, "unindexed.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: { content: [{ type: "text", text: "Peek fallback prompt" }] },
        timestamp: "2026-05-01T00:00:00Z",
      },
    ]);
    try {
      const stat = fs.statSync(filePath);
      const session = {
        path: filePath,
        mtime: stat.mtime,
        size: stat.size,
        source: "claude",
      };
      const index = new Map();
      const peekSpy = mock.fn((s) => peekSession(s));
      const meta = getSessionMeta(index, session, peekSpy);
      assert.equal(peekSpy.mock.calls.length, 1);
      assert.strictEqual(peekSpy.mock.calls[0].arguments[0], session);
      assert.equal(meta.firstPrompt, "Peek fallback prompt");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("partial buildIndex only peeks paths missing from the Map", async () => {
    await withTmpHome(async (_tmpDir, { buildIndex }) => {
      const tmpDir = mkTmp("tq-meta-partial-index-");
      const indexedPath = path.join(tmpDir, "has-index.jsonl");
      const peekPath = path.join(tmpDir, "needs-peek.jsonl");
      writeJsonl(indexedPath, [
        {
          type: "user",
          message: { content: [{ type: "text", text: "Full index row" }] },
          timestamp: "2026-05-01T00:00:00Z",
        },
      ]);
      writeJsonl(peekPath, [
        {
          type: "user",
          message: { content: [{ type: "text", text: "Peek-only row" }] },
          timestamp: "2026-05-01T00:00:00Z",
        },
      ]);
      try {
        const indexedStat = fs.statSync(indexedPath);
        const peekStat = fs.statSync(peekPath);
        const indexedSession = {
          path: indexedPath,
          mtime: indexedStat.mtime,
          size: indexedStat.size,
          source: "claude",
        };
        const peekSessionRow = {
          path: peekPath,
          mtime: peekStat.mtime,
          size: peekStat.size,
          source: "claude",
        };
        const fullIndex = buildIndex([indexedSession]);
        const peekSpy = mock.fn((s) => peekSession(s));

        const metaIndexed = getSessionMeta(fullIndex, indexedSession, peekSpy);
        const metaPeeked = getSessionMeta(fullIndex, peekSessionRow, peekSpy);

        assert.equal(metaIndexed.firstPrompt, "Full index row");
        assert.equal(metaPeeked.firstPrompt, "Peek-only row");
        assert.equal(peekSpy.mock.calls.length, 1);
        assert.strictEqual(peekSpy.mock.calls[0].arguments[0], peekSessionRow);
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});