import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { parseClaude } from "../../src/parse/parse-claude.js";
import {
  isClaudeFallbackSearchLine,
  isClaudeIndexedJsonlLine,
  isClaudeIndexSkippableLine,
  isClaudeProgressFillerLine,
  isClaudeToolResultStderrLine,
} from "../../src/parse/claude-jsonl-index.js";
import { CLAUDE_FIXTURE_CWD, mkClaudeJsonlTmp } from "../helpers/fixtures.js";
import { assertPerf } from "../helpers/perf-assert.js";

const SESSION = "sess-parse-claude-edge";
const CWD = CLAUDE_FIXTURE_CWD;
const TS = "2026-06-03T12:00:00.000Z";
const TS1 = "2026-06-03T12:00:05.000Z";
const TS2 = "2026-06-03T12:00:10.000Z";

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

describe("isClaudeProgressFillerLine", () => {
  test("detects progress rows via prefix; rejects user and tool_result rows", () => {
    assert.equal(isClaudeProgressFillerLine(JSON.stringify({ type: "progress", data: "x".repeat(200) })), true);
    assert.equal(isClaudeProgressFillerLine(JSON.stringify({ type: "user", message: { content: "hi" } })), false);
    assert.equal(isClaudeProgressFillerLine(JSON.stringify({ type: "tool_result", stderr: "err" })), false);
    assert.equal(isClaudeProgressFillerLine(""), false);
  });
});

describe("isClaudeIndexedJsonlLine", () => {
  test("accepts user/assistant rows and session metadata keys; rejects progress filler", () => {
    assert.equal(isClaudeIndexedJsonlLine(JSON.stringify({ type: "user", message: { content: "hi" } })), true);
    assert.equal(isClaudeIndexedJsonlLine(JSON.stringify({ type: "assistant", message: { content: [] } })), true);
    assert.equal(isClaudeIndexedJsonlLine(JSON.stringify({ sessionId: "s1", type: "system" })), true);
    assert.equal(isClaudeIndexedJsonlLine(JSON.stringify({ type: "progress", data: "x".repeat(200) })), false);
    assert.equal(isClaudeIndexedJsonlLine(""), false);
  });
});

describe("isClaudeToolResultStderrLine", () => {
  test("detects stderr-only tool_result rows; rejects content filler", () => {
    assert.equal(
      isClaudeToolResultStderrLine(JSON.stringify({ type: "tool_result", stderr: "Error: boom" })),
      true,
    );
    assert.equal(
      isClaudeToolResultStderrLine(JSON.stringify({ type: "tool_result", content: "ok" })),
      false,
    );
    assert.equal(isClaudeToolResultStderrLine(JSON.stringify({ type: "user", message: { content: "hi" } })), false);
  });
});

describe("isClaudeFallbackSearchLine", () => {
  test("includes indexed rows and stderr tool_result; rejects content filler", () => {
    assert.equal(isClaudeFallbackSearchLine(JSON.stringify({ type: "user", message: { content: "hi" } })), true);
    assert.equal(
      isClaudeFallbackSearchLine(JSON.stringify({ type: "tool_result", stderr: "Error: boom" })),
      true,
    );
    assert.equal(
      isClaudeFallbackSearchLine(JSON.stringify({ type: "tool_result", content: [{ type: "text", text: "x".repeat(80) }] })),
      false,
    );
  });
});

describe("isClaudeIndexSkippableLine", () => {
  test("skips progress/system/content tool_result filler; keeps user, metadata, stderr tool_result", () => {
    assert.equal(isClaudeIndexSkippableLine(JSON.stringify({ type: "progress", data: "x".repeat(200) })), true);
    assert.equal(isClaudeIndexSkippableLine(JSON.stringify({ type: "system", subtype: "init", data: "x" })), true);
    assert.equal(isClaudeIndexSkippableLine(JSON.stringify({ type: "queue", data: "x" })), true);
    assert.equal(isClaudeIndexSkippableLine(JSON.stringify({ type: "user", message: { content: "hi" } })), false);
    assert.equal(isClaudeIndexSkippableLine(JSON.stringify({ sessionId: "s1", type: "system" })), false);
    assert.equal(isClaudeIndexSkippableLine(JSON.stringify({ type: "tool_result", content: "ok" })), true);
    assert.equal(
      isClaudeIndexSkippableLine(JSON.stringify({ type: "tool_result", stderr: "Error: boom" })),
      false,
    );
    assert.equal(isClaudeIndexSkippableLine(""), false);
    const systemLine = JSON.stringify({ type: "system", subtype: "init", data: "x".repeat(40) });
    const buf = `prefix\n${systemLine}\nsuffix`;
    const start = buf.indexOf(systemLine);
    const end = start + systemLine.length;
    assert.equal(isClaudeIndexSkippableLine(buf, start, end), true);
  });
});

describe("parseClaude edge cases", () => {
  test("extracts multiple tool_use blocks with normalized tool names (index parity)", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "assistant",
        sessionId: SESSION,
        timestamp: TS,
        uuid: "a-tools",
        message: {
          model: "claude-test",
          stop_reason: "tool_use",
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: "text", text: "Running tools." },
            { type: "tool_use", id: "t-bash", name: "bash", input: { command: "git status" } },
            { type: "tool_use", id: "t-read", name: "Read", input: { file_path: "/proj/a.js" } },
            { type: "tool_use", id: "t-edit", name: "Edit", input: { path: "b.js", old_string: "x", new_string: "y" } },
          ],
        },
      },
    ]);
    try {
      const sess = parseClaude(file);
      const asst = sess.events.find((e) => e.uuid === "a-tools");
      assert.equal(asst.toolCalls.length, 3);
      assert.equal(asst.toolCalls[0].name, "Bash");
      assert.equal(asst.toolCalls[1].name, "Read");
      assert.equal(asst.toolCalls[2].name, "Edit");
      assert.equal(asst.toolCalls[0].id, "t-bash");
      assert.ok(asst.toolCalls[2].diffInfo);
      assert.equal(sess.stats.toolCounts.Bash, 1);
      assert.equal(sess.stats.toolCounts.Read, 1);
      assert.equal(sess.stats.toolCounts.Edit, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("tool_use MCP blocks retain mcp__ name and mcpInfo enrichment", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "assistant",
        timestamp: TS,
        uuid: "a-mcp",
        message: {
          model: "m",
          content: [
            {
              type: "tool_use",
              id: "mcp-1",
              name: "mcp__github__search_issues",
              input: { query: "tracequest", owner: "av" },
            },
          ],
        },
      },
    ]);
    try {
      const tc = parseClaude(file).events[0].toolCalls[0];
      assert.equal(tc.name, "mcp__github__search_issues");
      assert.equal(tc.mcpInfo.server, "github");
      assert.equal(tc.mcpInfo.tool, "search_issues");
      assert.equal(tc.mcpInfo.params.query, "tracequest");
    } finally {
      cleanup(dir);
    }
  });

  test("tool_use Agent / spawn_subagent blocks attach agentInfo (subagent dispatch)", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "assistant",
        timestamp: TS,
        uuid: "a-agent",
        message: {
          model: "m",
          content: [
            {
              type: "tool_use",
              id: "ag-1",
              name: "Agent",
              input: { description: "explore repo", prompt: "find parse tests", subagent_type: "explore" },
            },
            {
              type: "tool_use",
              id: "ag-2",
              name: "spawn_subagent",
              input: { description: "lint", type: "Bash", prompt: "npm run lint" },
            },
          ],
        },
      },
    ]);
    try {
      const calls = parseClaude(file).events[0].toolCalls;
      assert.equal(calls[0].agentInfo.description, "explore repo");
      assert.equal(calls[0].agentInfo.subagentType, "explore");
      assert.equal(calls[1].agentInfo.description, "lint");
      assert.equal(calls[1].agentInfo.subagentType, "Bash");
    } finally {
      cleanup(dir);
    }
  });

  test("assistant thinking blocks are collected and truncated at 2000 chars", () => {
    const long = "z".repeat(2500);
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "assistant",
        timestamp: TS,
        uuid: "a-think",
        message: {
          model: "m",
          content: [
            { type: "thinking", thinking: "short plan" },
            { type: "thinking", thinking: long },
            { type: "thinking" },
            { type: "text", text: "visible reply" },
          ],
        },
      },
    ]);
    try {
      const ev = parseClaude(file).events[0];
      assert.equal(ev.thinking[0], "short plan");
      // Truncation is now visible: cut to 2000 chars + a marker reporting the drop.
      assert.ok(ev.thinking[1].startsWith("z".repeat(2000)));
      assert.match(ev.thinking[1], /\[truncated 500 chars\]$/);
      assert.equal(ev.text, "visible reply");
    } finally {
      cleanup(dir);
    }
  });

  test("malformed assistant message shapes still emit assistant events", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      { type: "assistant", timestamp: TS, uuid: "a-null-msg" },
      { type: "assistant", timestamp: TS1, uuid: "a-no-content", message: { model: "m", stop_reason: "end_turn" } },
      {
        type: "assistant",
        timestamp: TS2,
        uuid: "a-bad-content",
        message: { model: "m", content: "not-an-array", stop_reason: "end_turn" },
      },
    ]);
    try {
      const events = parseClaude(file).events.filter((e) => e.type === "assistant");
      assert.equal(events.length, 3);
      for (const ev of events) {
        assert.equal(ev.text, "");
        assert.deepEqual(ev.toolCalls, []);
        assert.equal(ev.tokens.input, 0);
        assert.equal(ev.tokens.cacheHit, 0);
        assert.equal(ev.tokens.cacheWrite, 0);
      }
      assert.equal(events[1].stopReason, "end_turn");
      assert.ok(
        events.some((e) => e.tokens.estimated),
        "missing usage should trigger token estimation",
      );
    } finally {
      cleanup(dir);
    }
  });

  test("malformed JSONL lines are skipped without crashing", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      "",
      "{not json",
      JSON.stringify({
        type: "user",
        sessionId: SESSION,
        cwd: CWD,
        isMeta: false,
        timestamp: TS,
        uuid: "u-ok",
        message: { content: "hello after garbage" },
      }),
    ]);
    try {
      const sess = parseClaude(file);
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.events.length, 1);
      assert.equal(sess.events[0].text, "hello after garbage");
    } finally {
      cleanup(dir);
    }
  });

  test("user prompts starting with < are skipped; isMeta user lines skipped for text", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "user",
        sessionId: SESSION,
        isMeta: true,
        timestamp: TS,
        uuid: "u-meta",
        message: { content: "meta should not count" },
      },
      {
        type: "user",
        isMeta: false,
        timestamp: TS1,
        uuid: "u-xml",
        message: { content: "<local-command-caveat>hidden</local-command-caveat>" },
      },
      {
        type: "user",
        isMeta: false,
        timestamp: TS2,
        uuid: "u-real",
        message: { content: [{ type: "text", text: "real user prompt" }] },
      },
    ]);
    try {
      const sess = parseClaude(file);
      const users = sess.events.filter((e) => e.type === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].text, "real user prompt");
      assert.equal(sess.stats.userMessages, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("tool_result blocks: array text, string content, is_error flag, and errorPattern inference", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "user",
        timestamp: TS,
        uuid: "tr-1",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "id-ok",
              content: [{ type: "text", text: "line one\nline two" }],
            },
            {
              type: "tool_result",
              tool_use_id: "id-str",
              content: "plain string result",
            },
            {
              type: "tool_result",
              tool_use_id: "id-flag",
              content: "minor",
              is_error: true,
            },
            {
              type: "tool_result",
              tool_use_id: "id-pattern",
              content: "Error: something broke",
            },
          ],
        },
      },
    ]);
    try {
      const sess = parseClaude(file);
      const results = sess.events.filter((e) => e.type === "tool_result");
      assert.equal(results.length, 4);
      assert.equal(results[0].text, "line one\nline two");
      assert.equal(results[0].isError, false);
      assert.equal(results[1].text, "plain string result");
      assert.equal(results[2].isError, true);
      assert.equal(results[3].isError, true);
      assert.equal(sess.stats.errors, 2);
    } finally {
      cleanup(dir);
    }
  });

  test("token rollup sums input, cache read, and cache creation tokens", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "assistant",
        timestamp: TS,
        uuid: "a-tok",
        message: {
          model: "claude-sonnet",
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_read_input_tokens: 30,
            cache_creation_input_tokens: 20,
          },
          content: [{ type: "text", text: "ok" }],
        },
      },
    ]);
    try {
      const ev = parseClaude(file).events[0];
      assert.equal(ev.tokens.input, 150);
      assert.equal(ev.tokens.output, 40);
      assert.equal(ev.tokens.cacheHit, 30);
      assert.equal(ev.tokens.cacheWrite, 20);
    } finally {
      cleanup(dir);
    }
  });

  test("subagent sidecar-style jsonl parses standalone (minimal agent session log)", () => {
    const { dir, file } = mkClaudeJsonlTmp(
      [
        {
          type: "user",
          sessionId: "subagent-explore-1",
          cwd: CWD,
          timestamp: TS,
          uuid: "sub-u0",
          isMeta: false,
          message: { content: [{ type: "text", text: "Search for parse-claude tests" }] },
        },
        {
          type: "assistant",
          timestamp: TS1,
          uuid: "sub-a0",
          message: {
            model: "claude-haiku",
            stop_reason: "tool_use",
            usage: { input_tokens: 50, output_tokens: 10 },
            content: [
              { type: "thinking", thinking: "scan test tree" },
              {
                type: "tool_use",
                id: "sub-grep",
                name: "Grep",
                input: { pattern: "parseClaude", path: "test" },
              },
            ],
          },
        },
        {
          type: "user",
          timestamp: TS2,
          uuid: "sub-tr0",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "sub-grep",
                content: [{ type: "text", text: "test/parse/parse-claude.test.js:1" }],
              },
            ],
          },
        },
      ],
      "sidecar",
    );
    try {
      const sess = parseClaude(file);
      assert.equal(sess.source, "claude");
      assert.equal(sess.sessionId, "subagent-explore-1");
      assert.equal(sess.model, "claude-haiku");
      assert.ok(sess.events.some((e) => e.type === "assistant" && e.thinking?.[0] === "scan test tree"));
      const grep = sess.events.find((e) => e.type === "assistant")?.toolCalls[0];
      assert.equal(grep.name, "Grep");
      assert.ok(sess.events.some((e) => e.type === "tool_result" && e.text.includes("parse-claude.test.js")));
    } finally {
      cleanup(dir);
    }
  });

  test("assistant turn with only tool_use and no text still records tool calls", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "assistant",
        timestamp: TS,
        uuid: "a-tool-only",
        message: {
          model: "m",
          stop_reason: "tool_use",
          usage: { input_tokens: 1, output_tokens: 1 },
          content: [
            { type: "tool_use", id: "only", name: "bash", input: { command: "echo hi" } },
          ],
        },
      },
    ]);
    try {
      const ev = parseClaude(file).events[0];
      assert.equal(ev.text, "");
      assert.equal(ev.toolCalls.length, 1);
      assert.equal(ev.stopReason, "tool_use");
    } finally {
      cleanup(dir);
    }
  });

  test("empty jsonl yields claude session with zero events", () => {
    const { dir, file } = mkClaudeJsonlTmp([], "empty");
    try {
      const sess = parseClaude(file);
      assert.equal(sess.source, "claude");
      assert.equal(sess.eventCount, 0);
      assert.equal(sess.events.length, 0);
      assert.equal(sess.stats.userMessages, 0);
      assert.equal(sess.stats.assistantTurns, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("streams large sessions without readFileSync or collectParsedJsonlLines (perf)", () => {
    const src = readFileSync("src/parse/parse-claude.js", "utf8");
    assert.match(src, /forEachJsonlLineFromFile\s*\(\s*filePath/);
    assert.match(src, /isClaudeIndexedJsonlLine\s*\(\s*rawLine\s*\)/);
    assert.doesNotMatch(src, /readFileSync/);
    assert.doesNotMatch(src, /collectParsedJsonlLines/);

    const dir = mkdtempSync(join(tmpdir(), "parse-claude-perf-"));
    const file = join(dir, "large.jsonl");
    const lines = [];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "progress", data: "x".repeat(800) }));
      if (i % 3 === 0) {
        lines.push(
          JSON.stringify({
            type: "user",
            message: { content: `claude prompt ${i}` },
            timestamp: TS,
            uuid: `u-${i}`,
          }),
        );
      }
    }
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: { model: "claude-sonnet-4-6", content: [{ type: "text", text: "done" }] },
        timestamp: TS1,
        uuid: "a-perf",
      }),
    );
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    try {
      const ITERS = 8;
      for (let w = 0; w < 2; w++) parseClaude(file);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const sess = parseClaude(file);
        assert.ok(sess.events.length > 0);
        assert.equal(sess.model, "claude-sonnet-4-6");
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 35,
        `expected parseClaude under 35ms/op for 8k progress-filler session, got ${ms.toFixed(1)}ms`,
      );
    } finally {
      cleanup(dir);
    }
  });

  test("session metadata captured from first line with sessionId cwd gitBranch model", () => {
    const { dir, file } = mkClaudeJsonlTmp([
      {
        type: "user",
        sessionId: SESSION,
        cwd: CWD,
        gitBranch: "anneal/parse-claude",
        timestamp: TS,
        uuid: "meta-u",
        isMeta: false,
        message: { content: "ping" },
      },
      {
        type: "assistant",
        timestamp: TS1,
        uuid: "meta-a",
        message: { model: "claude-opus-4", content: [{ type: "text", text: "pong" }] },
      },
    ]);
    try {
      const sess = parseClaude(file);
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.cwd, CWD);
      assert.equal(sess.gitBranch, "anneal/parse-claude");
      assert.equal(sess.model, "claude-opus-4");
    } finally {
      cleanup(dir);
    }
  });
});