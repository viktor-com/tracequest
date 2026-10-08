/**
 * parse* stats.toolCounts × index*Jsonl toolCounts must agree on the same fixture
 * (canonical keys via normalizeToolName).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseClaude } from "../../src/parse/parse-claude.js";
import { parseFactory } from "../../src/parse/parse-factory.js";
import { parseCodex } from "../../src/parse/parse-codex.js";
import { parseGrok } from "../../src/parse/parse-grok.js";
import {
  indexClaudeJsonl,
  indexFactoryJsonl,
  indexCodexJsonl,
  indexGrokJsonl,
} from "../../src/sessions/session-index-jsonl.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const TS = "2026-06-03T12:00:00.000Z";

/** Assistant tool_use aliases → canonical normalizeToolName keys. */
const CLAUDE_TOOL_ALIAS_LINES = [
  { type: "user", message: { content: "toolcounts parity probe" }, timestamp: TS },
  {
    type: "assistant",
    message: {
      model: "claude-parity",
      content: [
        { type: "tool_use", name: "bash", input: { command: "echo parity" } },
        { type: "tool_use", name: "read_file", input: { file_path: "/proj/a.js" } },
        { type: "tool_use", name: "grep", input: { pattern: "x", path: "." } },
        { type: "tool_use", name: "mcp__srv__lookup", input: { q: "tracequest" } },
        { type: "tool_use", name: "web_search", input: { query: "docs" } },
        { type: "tool_use", name: "unknowncmd", input: {} },
      ],
    },
    timestamp: "2026-06-03T12:01:00.000Z",
  },
];

const FACTORY_TOOL_ALIAS_LINES = [
  { type: "session_start", id: "factory-tool-parity", cwd: "/proj" },
  {
    type: "message",
    message: { role: "user", content: [{ type: "text", text: "factory toolcounts parity" }] },
    timestamp: TS,
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "tool_use", name: "shell", input: { command: "ls" } },
        { type: "tool_use", name: "ripgrep", input: { pattern: "y" } },
        { type: "tool_use", name: "mcp__org__tool", input: {} },
        { type: "tool_use", name: "websearch", input: { query: "z" } },
      ],
    },
    timestamp: "2026-06-03T12:01:00.000Z",
  },
];

const CODEX_TOOL_ALIAS_LINES = [
  {
    type: "response_item",
    timestamp: TS,
    payload: {
      role: "assistant",
      content: [
        { type: "output_text", text: "codex tool parity" },
        { type: "function_call", name: "bash", call_id: "c-bash", arguments: '{"command":"true"}' },
        { type: "function_call", name: "read_file", call_id: "c-read", arguments: '{"path":"/b.js"}' },
        { type: "function_call", name: "web_search", call_id: "c-ws", arguments: '{"query":"q"}' },
      ],
    },
  },
];

function assertToolCountsParity(parsed, indexed, label) {
  assert.deepEqual(
    parsed.stats.toolCounts,
    indexed.toolCounts,
    `${label}: parse stats.toolCounts keys/counts must match index toolCounts`,
  );
  for (const key of Object.keys(parsed.stats.toolCounts)) {
    assert.ok(
      indexed.tools.includes(key),
      `${label}: index tools must include toolCounts key ${key}`,
    );
  }
}

describe("parse × index toolCounts parity (normalizeToolName)", () => {
  test("parseClaude × indexClaudeJsonl on alias fixture", () => {
    const tmpDir = mkTmp("tq-parse-index-toolcounts-claude-");
    const filePath = path.join(tmpDir, "session.jsonl");
    writeJsonl(filePath, CLAUDE_TOOL_ALIAS_LINES);
    try {
      const parsed = parseClaude(filePath);
      const indexed = indexClaudeJsonl(filePath);
      assertToolCountsParity(parsed, indexed, "claude");
      assert.deepEqual(parsed.stats.toolCounts, {
        Bash: 1,
        Read: 1,
        Grep: 1,
        "mcp__srv__lookup": 1,
        WebSearch: 1,
        Unknowncmd: 1,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parseFactory × indexFactoryJsonl on alias fixture", () => {
    const tmpDir = mkTmp("tq-parse-index-toolcounts-factory-");
    const filePath = path.join(tmpDir, "factory.jsonl");
    writeJsonl(filePath, FACTORY_TOOL_ALIAS_LINES);
    try {
      const parsed = parseFactory(filePath);
      const indexed = indexFactoryJsonl(filePath);
      assertToolCountsParity(parsed, indexed, "factory");
      assert.deepEqual(parsed.stats.toolCounts, {
        Bash: 1,
        Grep: 1,
        "mcp__org__tool": 1,
        WebSearch: 1,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parseCodex × indexCodexJsonl on response_item function_call fixture", () => {
    const tmpDir = mkTmp("tq-parse-index-toolcounts-codex-");
    const filePath = path.join(tmpDir, "rollout.jsonl");
    writeJsonl(filePath, CODEX_TOOL_ALIAS_LINES);
    try {
      const parsed = parseCodex(filePath);
      const indexed = indexCodexJsonl(filePath);
      assertToolCountsParity(parsed, indexed, "codex");
      assert.deepEqual(parsed.stats.toolCounts, {
        Bash: 1,
        Read: 1,
        WebSearch: 1,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parseCodex × indexCodexJsonl on event_msg patch/exec/web_search fixture", () => {
    const tmpDir = mkTmp("tq-parse-index-toolcounts-codex-events-");
    const filePath = path.join(tmpDir, "rollout-events.jsonl");
    writeJsonl(filePath, [
      {
        type: "event_msg",
        timestamp: TS,
        payload: {
          type: "patch_apply_end",
          call_id: "e-edit",
          success: true,
          changes: { "/proj/a.js": {} },
        },
      },
      {
        type: "event_msg",
        timestamp: TS,
        payload: {
          type: "exec_command_end",
          call_id: "e-bash",
          parsed_cmd: [{ cmd: "git commit -m parity" }],
          exit_code: 0,
        },
      },
      {
        type: "event_msg",
        timestamp: TS,
        payload: { type: "web_search_end", call_id: "e-ws", query: "parity" },
      },
      {
        type: "response_item",
        timestamp: "2026-06-03T12:01:00.000Z",
        payload: { role: "assistant", content: [{ type: "output_text", text: "done" }] },
      },
    ]);
    try {
      const parsed = parseCodex(filePath);
      const indexed = indexCodexJsonl(filePath);
      assertToolCountsParity(parsed, indexed, "codex-event_msg");
      assert.deepEqual(parsed.stats.toolCounts, {
        Edit: 1,
        Bash: 1,
        WebSearch: 1,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parseGrok × indexGrokJsonl with events tool_started and chat tool_calls (no double count)", () => {
    const tmpDir = mkTmp("tq-parse-index-toolcounts-grok-dc-");
    const sessionDir = path.join(tmpDir, "grok-sess-dc");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "turn_started", session_id: "grok-dc", ts: TS },
      { type: "tool_started", tool_name: "bash", ts: TS },
      { type: "tool_completed", tool_name: "bash", outcome: "success", ts: TS },
      { type: "tool_started", tool_name: "read", ts: TS },
      { type: "tool_completed", tool_name: "read", outcome: "success", ts: TS },
    ]);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "grok dc parity" },
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
    ]);
    try {
      const parsed = parseGrok(sessionDir);
      const indexed = indexGrokJsonl(sessionDir);
      assertToolCountsParity(parsed, indexed, "grok-dc");
      assert.deepEqual(parsed.stats.toolCounts, { Bash: 1, Read: 1 });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("parseGrok × indexGrokJsonl on chat_history tool_calls fixture", () => {
    const tmpDir = mkTmp("tq-parse-index-toolcounts-grok-");
    const sessionDir = path.join(tmpDir, "grok-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "turn_started", session_id: "grok-tool-parity", ts: TS },
    ]);
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
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
    ]);
    try {
      const parsed = parseGrok(sessionDir);
      const indexed = indexGrokJsonl(sessionDir);
      assertToolCountsParity(parsed, indexed, "grok");
      assert.deepEqual(parsed.stats.toolCounts, {
        Bash: 1,
        Read: 1,
        "mcp__x__y": 1,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});