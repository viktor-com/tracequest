/**
 * JS indexClaudeJsonl × Rust tracequest-sidecar index parity on the same minimal JSONL.
 * Skips when no built ELF sidecar is present (npm run build:sidecar).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { indexClaudeJsonl, indexGrokJsonl } from "../src/sessions/session-index-jsonl.js";
import {
  SIDECAR_BIN,
  SKIP_NO_SIDECAR,
  indexViaSidecar,
  assertIndexParity,
  assertGrokToolCountsParity,
  withGrokSession,
  withMinimalSession,
} from "./helpers/sidecar-parity-helpers.js";

const GROK_TS = "2026-06-03T10:00:00.000Z";

/** events tool_started + chat tool_calls: counts must come from chat only (no double count). */
const GROK_NO_DOUBLE_COUNT = {
  events: [
    { type: "turn_started", session_id: "grok-dc", ts: GROK_TS, model_id: "grok-2" },
    { type: "tool_started", tool_name: "bash", ts: GROK_TS },
    { type: "tool_completed", tool_name: "bash", outcome: "success", ts: GROK_TS },
    { type: "tool_started", tool_name: "read", ts: GROK_TS },
    { type: "tool_completed", tool_name: "read", outcome: "success", ts: GROK_TS },
  ],
  chat: [
    { type: "user", content: "grok sidecar toolcounts parity" },
    {
      type: "assistant",
      content: "tools",
      tool_calls: [
        { id: "g-bash", name: "bash", arguments: "{}" },
        { id: "g-read", name: "read_file", arguments: "{}" },
      ],
    },
    { type: "tool_result", tool_call_id: "g-bash", content: "ok" },
    { type: "tool_result", tool_call_id: "g-read", content: "ok" },
  ],
  expectedToolCounts: { Bash: 1, Read: 1 },
};

/** chat_history tool_calls only (events has turn_started, no tool_started). */
const GROK_CHAT_TOOL_CALLS = {
  events: [{ type: "turn_started", session_id: "grok-tools", ts: GROK_TS }],
  chat: [
    { type: "user", content: "grok toolcounts parity" },
    {
      type: "assistant",
      content: "running tools",
      tool_calls: [
        { id: "g-bash", name: "bash", arguments: '{"command":"echo"}' },
        { id: "g-read", name: "read_file", arguments: '{"file_path":"/c.js"}' },
        { id: "g-mcp", name: "mcp__x__y", arguments: "{}" },
      ],
    },
  ],
  expectedToolCounts: { Bash: 1, Read: 1, "mcp__x__y": 1 },
};

describe("sidecar × JS index parity (indexClaudeJsonl)", () => {
  test(
    "same minimal jsonl: key index fields match sidecar normalize/index",
    SKIP_NO_SIDECAR,
    () => {
      withMinimalSession((filePath, session) => {
        const jsMeta = indexClaudeJsonl(filePath);
        const sidecarMeta = indexViaSidecar(SIDECAR_BIN, session);
        assertIndexParity(jsMeta, sidecarMeta);
      });
    },
  );

  test(
    "tool name normalization: bash → Bash in tools and toolCounts",
    SKIP_NO_SIDECAR,
    () => {
      withMinimalSession((filePath, session) => {
        const jsMeta = indexClaudeJsonl(filePath);
        const sidecarMeta = indexViaSidecar(SIDECAR_BIN, session);
        assert.ok(jsMeta.tools.includes("Bash"));
        assert.equal(jsMeta.toolCounts.Bash, 1);
        assert.deepEqual(jsMeta.tools, sidecarMeta.tools);
        assert.deepEqual(jsMeta.toolCounts, sidecarMeta.toolCounts);
      });
    },
  );
});

describe("sidecar × JS index parity (indexGrokJsonl toolCounts)", () => {
  test(
    "events tool_started + chat tool_calls: no double count vs sidecar",
    SKIP_NO_SIDECAR,
    () => {
      withGrokSession(
        { ...GROK_NO_DOUBLE_COUNT, dirName: "grok-sess-dc" },
        (sessionDir, session) => {
          const jsMeta = indexGrokJsonl(sessionDir);
          const sidecarMeta = indexViaSidecar(SIDECAR_BIN, session);
          assert.deepEqual(jsMeta.toolCounts, GROK_NO_DOUBLE_COUNT.expectedToolCounts);
          assertGrokToolCountsParity(jsMeta, sidecarMeta, "no-double-count");
        },
      );
    },
  );

  test(
    "chat_history tool_calls: normalized tools and toolCounts match sidecar",
    SKIP_NO_SIDECAR,
    () => {
      withGrokSession(
        { ...GROK_CHAT_TOOL_CALLS, dirName: "grok-sess-tools" },
        (sessionDir, session) => {
          const jsMeta = indexGrokJsonl(sessionDir);
          const sidecarMeta = indexViaSidecar(SIDECAR_BIN, session);
          assert.deepEqual(jsMeta.toolCounts, GROK_CHAT_TOOL_CALLS.expectedToolCounts);
          assertGrokToolCountsParity(jsMeta, sidecarMeta, "chat-tool-calls");
        },
      );
    },
  );
});