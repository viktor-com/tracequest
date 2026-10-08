import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { parseFactory } from "../../src/parse/parse-factory.js";
import { assertPerf } from "../helpers/perf-assert.js";

const SESSION = "factory-sess-edge";
const CWD = "/home/dev/tracequest";
const TS = "2026-06-03T12:00:00.000Z";
const TS1 = "2026-06-03T12:00:05.000Z";
const TS2 = "2026-06-03T12:00:10.000Z";

function writeFactoryJsonl(lines, suffix = "edge") {
  const dir = mkdtempSync(join(os.tmpdir(), `parse-factory-${suffix}-`));
  const file = join(dir, "run.jsonl");
  const body = lines
    .map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
    .join("\n");
  writeFileSync(file, body ? body + "\n" : "", "utf8");
  return { dir, file };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

describe("parseFactory session metadata", () => {
  test("session_start captures model and gitBranch when present", () => {
    const { dir, file } = writeFactoryJsonl([
      {
        type: "session_start",
        id: SESSION,
        cwd: CWD,
        model: "claude-opus-4",
        gitBranch: "anneal/factory-meta",
      },
      {
        type: "message",
        id: "m-user",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text: "factory meta" }] },
      },
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.model, "claude-opus-4");
      assert.equal(sess.gitBranch, "anneal/factory-meta");
    } finally {
      cleanup(dir);
    }
  });

  test("assistant message.model overrides default when session_start omits model", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "m-a",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-haiku-3",
          content: [{ type: "text", text: "factory assistant" }],
        },
      },
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.model, "claude-haiku-3");
      assert.equal(sess.stats.assistantTurns, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("session_start captures sessionId cwd and default model", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "m-user",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text: "factory hello" }] },
      },
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.source, "factory");
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.cwd, CWD);
      assert.equal(sess.model, "claude (factory)");
      assert.equal(sess.gitBranch, null);
      assert.equal(sess.stats.userMessages, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("empty jsonl yields factory session with zero events", () => {
    const { dir, file } = writeFactoryJsonl([], "empty");
    try {
      const sess = parseFactory(file);
      assert.equal(sess.source, "factory");
      assert.equal(sess.eventCount, 0);
      assert.equal(sess.stats.userMessages, 0);
      assert.equal(sess.stats.assistantTurns, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("session_start model is sticky; assistant message.model does not override", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD, model: "claude-opus-4" },
      {
        type: "message",
        id: "m-a",
        timestamp: TS,
        message: {
          role: "assistant",
          model: "claude-haiku-3",
          content: [{ type: "text", text: "still opus" }],
        },
      },
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.model, "claude-opus-4");
      assert.equal(sess.stats.assistantTurns, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("gitBranch on non-session_start line when session_start omits gitBranch", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "heartbeat", gitBranch: "anneal/from-heartbeat" },
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "m-user",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text: "branch from heartbeat" }] },
      },
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.gitBranch, "anneal/from-heartbeat");
      assert.equal(sess.stats.userMessages, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("later session_start overwrites sessionId cwd and model", () => {
    const otherCwd = "/tmp/other-factory-ws";
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: "factory-first", cwd: CWD, model: "claude-old" },
      { type: "session_start", id: SESSION, cwd: otherCwd, model: "claude-new", gitBranch: "anneal/restart" },
      {
        type: "message",
        id: "m-user",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text: "after restart" }] },
      },
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.cwd, otherCwd);
      assert.equal(sess.model, "claude-new");
      assert.equal(sess.gitBranch, "anneal/restart");
    } finally {
      cleanup(dir);
    }
  });

});

describe("parseFactory user messages", () => {
  test("concatenates multiple text blocks into one user event", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "u-multi",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "text", text: "line one" },
            { type: "text", text: "line two" },
          ],
        },
      },
    ]);
    try {
      const ev = parseFactory(file).events.find((e) => e.type === "user");
      assert.equal(ev.text, "line one\nline two");
      assert.equal(ev.uuid, "u-multi");
    } finally {
      cleanup(dir);
    }
  });

  test("message.role user ignores nested type assistant content blocks", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "u-nested-assistant",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "assistant", text: "embedded assistant block must not win" },
            { type: "text", text: "Real factory prompt" },
          ],
        },
      },
    ]);
    try {
      const users = parseFactory(file).events.filter((e) => e.type === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].text, "Real factory prompt");
      assert.equal(users[0].uuid, "u-nested-assistant");
    } finally {
      cleanup(dir);
    }
  });

  test("skips XML-tagged text blocks and prompts starting with angle brackets", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            { type: "text", text: "<system>hidden directive</system>" },
            { type: "text", text: "visible factory prompt" },
          ],
        },
      },
      {
        type: "message",
        timestamp: TS1,
        message: {
          role: "user",
          content: [{ type: "text", text: "<local-command>only xml</local-command>" }],
        },
      },
    ]);
    try {
      const users = parseFactory(file).events.filter((e) => e.type === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].text, "visible factory prompt");
    } finally {
      cleanup(dir);
    }
  });

  test("user text longer than 500 chars is truncated via safeSlice", () => {
    const long = "x".repeat(600);
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text: long }] },
      },
    ]);
    try {
      const ev = parseFactory(file).events[0];
      assert.ok(ev.text.startsWith("x".repeat(500)));
      assert.match(ev.text, /\[truncated 100 chars\]$/);
    } finally {
      cleanup(dir);
    }
  });
});

describe("parseFactory tool_result in user turns", () => {
  test("tool_result blocks: array content, string content, is_error, and errorPattern", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        timestamp: TS,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tr-ok",
              content: [{ type: "text", text: "stdout line" }],
            },
            {
              type: "tool_result",
              tool_use_id: "tr-str",
              content: "plain string output",
            },
            {
              type: "tool_result",
              tool_use_id: "tr-flag",
              content: "minor",
              is_error: true,
            },
            {
              type: "tool_result",
              tool_use_id: "tr-pattern",
              content: "Error: tool blew up",
            },
          ],
        },
      },
    ]);
    try {
      const sess = parseFactory(file);
      const results = sess.events.filter((e) => e.type === "tool_result");
      assert.equal(results.length, 4);
      assert.equal(results[0].text, "stdout line");
      assert.equal(results[0].isError, false);
      assert.equal(results[1].text, "plain string output");
      assert.equal(results[2].isError, true);
      assert.equal(results[3].isError, true);
      assert.equal(sess.stats.errors, 2);
      assert.ok(results[0].uuid.startsWith("factory-result-"));
    } finally {
      cleanup(dir);
    }
  });

  test("tool_result text longer than 1000 chars is truncated", () => {
    const huge = "z".repeat(1500);
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        timestamp: TS,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "big", content: huge }],
        },
      },
    ]);
    try {
      const tr = parseFactory(file).events[0];
      assert.ok(tr.text.startsWith("z".repeat(1000)));
      assert.match(tr.text, /\[truncated 500 chars\]$/);
    } finally {
      cleanup(dir);
    }
  });
});

describe("parseFactory assistant turns", () => {
  test("assistant text and multiple tool_use blocks with enrichment", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "a-tools",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Running factory tools." },
            { type: "tool_use", id: "t-bash", name: "bash", input: { command: "npm test" } },
            { type: "tool_use", id: "t-read", name: "Read", input: { file_path: "/proj/a.js" } },
            {
              type: "tool_use",
              id: "t-edit",
              name: "Edit",
              input: { path: "b.js", old_string: "x", new_string: "y" },
            },
          ],
        },
      },
    ]);
    try {
      const sess = parseFactory(file);
      const asst = sess.events.find((e) => e.uuid === "a-tools");
      assert.equal(asst.text, "Running factory tools.");
      assert.equal(asst.stopReason, "tool_use");
      assert.equal(asst.toolCalls.length, 3);
      assert.equal(asst.toolCalls[0].name, "Bash");
      assert.equal(asst.toolCalls[1].name, "Read");
      assert.equal(asst.toolCalls[2].name, "Edit");
      assert.ok(asst.toolCalls[2].diffInfo);
      assert.equal(asst.tokens.input, 0);
      assert.equal(asst.tokens.cacheHit, 0);
      assert.equal(asst.tokens.cacheWrite, 0);
      assert.ok(asst.tokens.estimated, "factory has no usage; buildSession estimates output tokens");
      assert.equal(sess.stats.toolCounts.Bash, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("MCP tool_use retains mcp__ name and mcpInfo", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        timestamp: TS,
        message: {
          role: "assistant",
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
      const tc = parseFactory(file).events[0].toolCalls[0];
      assert.equal(tc.name, "mcp__github__search_issues");
      assert.equal(tc.mcpInfo.server, "github");
      assert.equal(tc.mcpInfo.tool, "search_issues");
      assert.equal(tc.mcpInfo.params.query, "tracequest");
    } finally {
      cleanup(dir);
    }
  });

  test("assistant with only tool_use has empty text and stopReason tool_use", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "only", name: "bash", input: { command: "echo hi" } }],
        },
      },
    ]);
    try {
      const ev = parseFactory(file).events[0];
      assert.equal(ev.text, "");
      assert.equal(ev.toolCalls.length, 1);
      assert.equal(ev.stopReason, "tool_use");
    } finally {
      cleanup(dir);
    }
  });

  test("assistant end_turn when no tool calls", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "a-end",
        timestamp: TS,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done without tools" }],
        },
      },
    ]);
    try {
      const ev = parseFactory(file).events[0];
      assert.equal(ev.stopReason, "end_turn");
      assert.deepEqual(ev.toolCalls, []);
    } finally {
      cleanup(dir);
    }
  });
});

describe("parseFactory robustness", () => {
  test("malformed JSONL lines are skipped without crashing", () => {
    const { dir, file } = writeFactoryJsonl([
      "",
      "{not json",
      JSON.stringify({ type: "session_start", id: SESSION, cwd: CWD }),
      JSON.stringify({
        type: "message",
        timestamp: TS,
        id: "u-ok",
        message: { role: "user", content: [{ type: "text", text: "after garbage" }] },
      }),
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.events.length, 1);
      assert.equal(sess.events[0].text, "after garbage");
    } finally {
      cleanup(dir);
    }
  });

  test("non-message types and malformed message shapes are ignored", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      { type: "heartbeat", ts: TS },
      { type: "message", timestamp: TS, message: { role: "system", content: "ignored" } },
      { type: "message", timestamp: TS1, message: { role: "user" } },
      {
        type: "message",
        timestamp: TS2,
        message: { role: "assistant", content: "not-an-array" },
      },
    ]);
    try {
      const sess = parseFactory(file);
      assert.equal(sess.events.length, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("full turn sequence: user, assistant tools, tool results preserve event order", () => {
    const { dir, file } = writeFactoryJsonl([
      { type: "session_start", id: SESSION, cwd: CWD },
      {
        type: "message",
        id: "turn-u",
        timestamp: TS,
        message: { role: "user", content: [{ type: "text", text: "grep the tree" }] },
      },
      {
        type: "message",
        id: "turn-a",
        timestamp: TS1,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "grep-1", name: "Grep", input: { pattern: "parseFactory", path: "test" } },
          ],
        },
      },
      {
        type: "message",
        timestamp: TS2,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "grep-1",
              content: [{ type: "text", text: "test/parse/parse-factory.test.js:1" }],
            },
          ],
        },
      },
    ]);
    try {
      const sess = parseFactory(file);
      const types = sess.events.map((e) => e.type);
      assert.deepEqual(types, ["user", "assistant", "tool_result"]);
      assert.equal(sess.stats.userMessages, 1);
      assert.equal(sess.stats.assistantTurns, 1);
      assert.equal(sess.stats.toolCounts.Grep, 1);
      assert.ok(sess.durationMs >= 0);
      assert.ok(sess.startTime.includes("2026-06-03"));
    } finally {
      cleanup(dir);
    }
  });
});

describe("parseFactory performance", () => {
  test("streams large sessions without readFileSync and skips filler tool_result JSON.parse (perf)", () => {
    const src = readFileSync("src/parse/parse-factory.js", "utf8");
    assert.match(src, /forEachJsonlLineFromFile\s*\(\s*filePath/);
    assert.match(src, /isFactoryParsedLine/);
    assert.doesNotMatch(src, /readFileSync/);
    assert.doesNotMatch(src, /forEachParsedJsonlLine/);

    const dir = mkdtempSync(join(os.tmpdir(), "parse-factory-perf-"));
    const file = join(dir, "large.jsonl");
    const lines = [
      JSON.stringify({ type: "session_start", id: SESSION, cwd: CWD, model: "claude (factory)" }),
    ];
    for (let i = 0; i < 5000; i++) {
      lines.push(
        JSON.stringify({ type: "tool_result", tool_use_id: `t${i}`, content: "x".repeat(200) }),
      );
      if (i % 3 === 0) {
        lines.push(
          JSON.stringify({
            type: "message",
            timestamp: TS,
            message: { role: "user", content: [{ type: "text", text: `factory prompt ${i}` }] },
          }),
        );
      }
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    try {
      const ITERS = 10;
      for (let w = 0; w < 2; w++) parseFactory(file);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const sess = parseFactory(file);
        assert.ok(sess.events.length > 0);
        assert.equal(sess.model, "claude (factory)");
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 15,
        `expected parseFactory under 15ms/op for 5k filler tool_result session, got ${ms.toFixed(2)}ms`,
      );
    } finally {
      cleanup(dir);
    }
  });
});