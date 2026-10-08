/**
 * indexCursorCloudJsonl: imported Cursor cloud-agent sessions — local-cursor
 * message rows behind a session_meta first line (facts ccix, ccmf, ccpp).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  indexCursorCloudJsonl,
  indexCursorJsonl,
} from "../../src/sessions/session-index-jsonl.js";
import { cursorFileTimeBounds } from "../../src/parse/claude-jsonl-index.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const CREATED_AT = "2026-07-01T10:00:00.000Z";
const UPDATED_AT = "2026-07-01T11:30:00.000Z";
const META_DURATION_MS = Date.parse(UPDATED_AT) - Date.parse(CREATED_AT);

function sessionMeta(overrides = {}) {
  return {
    type: "session_meta",
    bcId: "bc-11112222-3333-4444-5555-666677778888",
    name: "Fix the login flow",
    status: "FINISHED",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    repository: "https://github.com/org/repo",
    model: "gpt-5-cursor",
    ...overrides,
  };
}

function messageRows() {
  return [
    { role: "user", message: { content: [{ type: "text", text: "cloud user prompt needle" }] } },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "cloud assistant reply body" },
          { type: "tool_use", name: "Read", input: { path: "/repo/src/login.js" } },
        ],
      },
    },
    { type: "turn_ended", status: "success" },
  ];
}

function writeCloudSession(dir, name, rows) {
  const filePath = path.join(dir, name);
  writeJsonl(filePath, rows);
  return filePath;
}

describe("indexCursorCloudJsonl", () => {
  test("cursor-cloud session_meta supplies real timestamps and durationMs", () => {
    const tmpDir = mkTmp("tq-cc-index-times-");
    try {
      const filePath = writeCloudSession(tmpDir, "bc-times.jsonl", [sessionMeta(), ...messageRows()]);
      // Push file times a day into the past: if the indexer consulted file
      // birthtime/mtime the duration could not equal the meta span.
      const past = new Date(Date.now() - 24 * 3600 * 1000);
      fs.utimesSync(filePath, past, past);

      const meta = indexCursorCloudJsonl(filePath);
      assert.equal(meta.durationMs, META_DURATION_MS);
      assert.equal(meta.model, "gpt-5-cursor");
      assert.equal(meta.firstPrompt, "cloud user prompt needle");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("session_meta without updatedAt yields durationMs 0", () => {
    const tmpDir = mkTmp("tq-cc-index-noupd-");
    try {
      const filePath = writeCloudSession(tmpDir, "bc-noupd.jsonl", [
        sessionMeta({ updatedAt: undefined }),
        ...messageRows(),
      ]);
      assert.equal(indexCursorCloudJsonl(filePath).durationMs, 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor-cloud indexer reuses cursor message-row indexing", () => {
    const tmpDir = mkTmp("tq-cc-index-reuse-");
    try {
      const cloudPath = writeCloudSession(tmpDir, "bc-reuse.jsonl", [sessionMeta(), ...messageRows()]);
      const cursorPath = writeCloudSession(tmpDir, "local-cursor.jsonl", messageRows());

      const cloudMeta = indexCursorCloudJsonl(cloudPath);
      const cursorMeta = indexCursorJsonl(cursorPath);

      // Message-row extraction is identical to the local-cursor indexer
      // (fact ccmr); only the session_meta deltas differ (model, durationMs).
      assert.equal(cloudMeta.firstPrompt, cursorMeta.firstPrompt);
      assert.equal(cloudMeta.chapters, cursorMeta.chapters);
      assert.deepEqual(cloudMeta.tools, cursorMeta.tools);
      assert.deepEqual(cloudMeta.toolCounts, cursorMeta.toolCounts);
      assert.equal(cloudMeta.files, cursorMeta.files);
      assert.equal(cloudMeta.totalTokens, cursorMeta.totalTokens);
      assert.deepEqual([...cloudMeta.termFreqs.entries()], [...cursorMeta.termFreqs.entries()]);
      for (const term of ["cloud", "user", "prompt", "needle", "assistant", "reply", "body"]) {
        assert.ok(cloudMeta.termFreqs.has(term), `expected term ${term}`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor-cloud indexer falls back to model cursor-cloud when meta has no model", () => {
    const tmpDir = mkTmp("tq-cc-index-model-");
    try {
      const filePath = writeCloudSession(tmpDir, "bc-nomodel.jsonl", [
        sessionMeta({ model: undefined }),
        ...messageRows(),
      ]);
      // The literal "cursor-cloud", never "cursor": cloud sessions with unknown
      // model must not conflate with local cursor sessions (fact ccmf).
      assert.equal(indexCursorCloudJsonl(filePath).model, "cursor-cloud");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("firstPrompt falls back to session_meta.name when the transcript has no user message", () => {
    const tmpDir = mkTmp("tq-cc-index-name-");
    try {
      const filePath = writeCloudSession(tmpDir, "bc-name.jsonl", [
        sessionMeta(),
        {
          role: "assistant",
          message: { content: [{ type: "text", text: "assistant-only transcript" }] },
        },
      ]);
      assert.equal(indexCursorCloudJsonl(filePath).firstPrompt, "Fix the login flow");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor-cloud file without session_meta falls back to cursor file-time behavior", () => {
    const tmpDir = mkTmp("tq-cc-index-degraded-");
    try {
      const filePath = writeCloudSession(tmpDir, "bc-degraded.jsonl", messageRows());
      const meta = indexCursorCloudJsonl(filePath);
      assert.equal(meta.durationMs, cursorFileTimeBounds(filePath)?.durationMs ?? 0);
      assert.equal(meta.model, "cursor-cloud");
      assert.equal(meta.firstPrompt, "cloud user prompt needle");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
