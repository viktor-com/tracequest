import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { parseCodex } from "../../src/parse/parse-codex.js";
import { assertPerf } from "../helpers/perf-assert.js";

const SESSION = "codex-sess-edge";
const CWD = "/home/dev/tracequest";
const TS = "2026-06-03T12:00:00.000Z";
const TS1 = "2026-06-03T12:00:05.000Z";
const TS2 = "2026-06-03T12:00:10.000Z";

function writeCodexJsonl(lines, suffix = "edge") {
  const dir = mkdtempSync(join(os.tmpdir(), `parse-codex-${suffix}-`));
  const file = join(dir, "rollout.jsonl");
  const body = lines
    .map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
    .join("\n");
  writeFileSync(file, body ? body + "\n" : "", "utf8");
  return { dir, file };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

describe("parseCodex rollout events", () => {
  test("session_meta captures sessionId cwd model_provider and git branch", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "session_meta",
        payload: {
          id: SESSION,
          cwd: CWD,
          model_provider: "openai",
          git: { branch: "anneal/parse-codex" },
        },
      },
      {
        type: "event_msg",
        timestamp: TS,
        payload: { type: "user_message", message: "ping codex" },
      },
    ]);
    try {
      const sess = parseCodex(file);
      assert.equal(sess.source, "codex");
      assert.equal(sess.sessionId, SESSION);
      assert.equal(sess.cwd, CWD);
      assert.equal(sess.model, "openai");
      assert.equal(sess.gitBranch, "anneal/parse-codex");
      assert.equal(sess.stats.userMessages, 1);
    } finally {
      cleanup(dir);
    }
  });

  test("turn_context backfills model cwd and git_branch when session_meta omits them", () => {
    const { dir, file } = writeCodexJsonl([
      { type: "turn_context", payload: { model: "gpt-5-codex", cwd: CWD, git_branch: "main" } },
      {
        type: "event_msg",
        timestamp: TS,
        payload: { type: "user_message", message: "turn context only" },
      },
    ]);
    try {
      const sess = parseCodex(file);
      assert.equal(sess.model, "gpt-5-codex");
      assert.equal(sess.cwd, CWD);
      assert.equal(sess.gitBranch, "main");
    } finally {
      cleanup(dir);
    }
  });

  test("event_msg user_message emits user events; XML-tagged and injected AGENTS.md prompts are skipped", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "event_msg",
        timestamp: TS,
        payload: { type: "user_message", message: "fix rollout parser" },
      },
      {
        type: "event_msg",
        timestamp: TS1,
        payload: { type: "user_message", message: "<system>hidden</system>" },
      },
      {
        type: "event_msg",
        timestamp: TS2,
        payload: { type: "user_message", message: "" },
      },
      {
        type: "event_msg",
        timestamp: TS2,
        payload: { type: "user_message", message: "# AGENTS.md instructions for /proj\n\ninjected, never a user bubble" },
      },
    ]);
    try {
      const users = parseCodex(file).events.filter((e) => e.type === "user");
      assert.equal(users.length, 1);
      assert.equal(users[0].text, "fix rollout parser");
      assert.equal(users[0].timestamp, TS);
    } finally {
      cleanup(dir);
    }
  });

  test("token_count last_token_usage attaches to next assistant response_item", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "event_msg",
        timestamp: TS,
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 120,
              output_tokens: 45,
              cached_input_tokens: 30,
            },
          },
        },
      },
      {
        type: "response_item",
        timestamp: TS1,
        payload: {
          role: "assistant",
          content: [{ type: "output_text", text: "tokens attached" }],
        },
      },
    ]);
    try {
      const ev = parseCodex(file).events.find((e) => e.type === "assistant");
      assert.equal(ev.tokens.input, 120);
      assert.equal(ev.tokens.output, 45);
      assert.equal(ev.tokens.cacheHit, 30);
      assert.equal(ev.tokens.cacheWrite, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("exec_command_end becomes Bash tool with error on non-zero exit", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "event_msg",
        timestamp: TS,
        payload: {
          type: "exec_command_end",
          call_id: "bash-ok",
          parsed_cmd: [{ cmd: "npm test" }],
          aggregated_output: "ok",
          exit_code: 0,
        },
      },
      {
        type: "event_msg",
        timestamp: TS1,
        payload: {
          type: "exec_command_end",
          call_id: "bash-fail",
          command: ["bash", "-lc", "false"],
          stderr: "Error: command failed",
          exit_code: 1,
        },
      },
      {
        type: "response_item",
        timestamp: TS2,
        payload: { role: "assistant", content: [{ type: "output_text", text: "done" }] },
      },
    ]);
    try {
      const sess = parseCodex(file);
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls.length, 2);
      assert.equal(asst.toolCalls[0].name, "Bash");
      assert.equal(asst.toolCalls[0].input, "npm test");
      const results = sess.events.filter((e) => e.type === "tool_result");
      assert.equal(results.length, 2);
      assert.equal(results[0].isError, false);
      assert.equal(results[1].isError, true);
      assert.equal(sess.stats.toolCounts.Bash, 2);
    } finally {
      cleanup(dir);
    }
  });

  test("patch_apply_end becomes Edit tool with file summary input", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "event_msg",
        timestamp: TS,
        payload: {
          type: "patch_apply_end",
          call_id: "edit-1",
          success: true,
          changes: { "/proj/src/foo.js": {}, "/proj/src/bar.js": {} },
          stdout: "applied",
        },
      },
      {
        type: "response_item",
        timestamp: TS1,
        payload: { role: "assistant", content: [] },
      },
    ]);
    try {
      const asst = parseCodex(file).events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls[0].name, "Edit");
      assert.equal(asst.toolCalls[0].input, "foo.js, bar.js");
      assert.equal(asst.stopReason, "tool_use");
    } finally {
      cleanup(dir);
    }
  });

  test("web_search_end event_msg and web_search_call response_item both map to WebSearch", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "event_msg",
        timestamp: TS,
        payload: { type: "web_search_end", call_id: "ws-end", query: "tracequest codex parser" },
      },
      {
        type: "response_item",
        timestamp: TS1,
        payload: {
          type: "web_search_call",
          id: "ws-call",
          action: { url: "https://example.com/docs" },
        },
      },
      {
        type: "response_item",
        timestamp: TS2,
        payload: { role: "assistant", content: [{ type: "output_text", text: "searched" }] },
      },
    ]);
    try {
      const sess = parseCodex(file);
      const asst = sess.events.find((e) => e.type === "assistant");
      const names = asst.toolCalls.map((t) => t.name);
      assert.ok(names.includes("WebSearch"));
      assert.ok(asst.toolCalls.some((t) => t.input === "tracequest codex parser"));
      assert.ok(asst.toolCalls.some((t) => t.input === "https://example.com/docs"));
      assert.equal(sess.stats.toolCounts.WebSearch, 2);
    } finally {
      cleanup(dir);
    }
  });

  test("payload-level function_call and function_call_output pair on assistant turn", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "response_item",
        timestamp: TS,
        payload: {
          type: "function_call",
          call_id: "fc-1",
          name: "read_file",
          arguments: '{"file_path":"/tmp/a.txt"}',
        },
      },
      {
        type: "response_item",
        timestamp: TS1,
        payload: {
          type: "function_call_output",
          call_id: "fc-1",
          output: "file contents here",
        },
      },
      {
        type: "response_item",
        timestamp: TS2,
        payload: {
          role: "assistant",
          content: [{ type: "output_text", text: "read complete" }],
        },
      },
    ]);
    try {
      const sess = parseCodex(file);
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls[0].name, "Read");
      assert.equal(asst.toolCalls[0].input, "/tmp/a.txt");
      const tr = sess.events.find((e) => e.type === "tool_result");
      assert.equal(tr.toolUseId, "fc-1");
      assert.equal(tr.text, "file contents here");
      assert.equal(tr.isError, false);
    } finally {
      cleanup(dir);
    }
  });

  test("custom_tool_call_output input_text blocks flatten to tool_result text", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "response_item",
        timestamp: TS,
        payload: { type: "custom_tool_call", call_id: "ex-1", name: "exec", input: "const r = await tools.exec_command({cmd:\"ls\"})" },
      },
      {
        type: "response_item",
        timestamp: TS1,
        payload: {
          type: "custom_tool_call_output",
          call_id: "ex-1",
          output: [
            { type: "input_text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
            { type: "input_text", text: "package.json\nREADME.md\n" },
          ],
        },
      },
      {
        type: "response_item",
        timestamp: TS2,
        payload: { role: "assistant", content: [] },
      },
    ]);
    try {
      const sess = parseCodex(file);
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls[0].name, "Exec");
      const tr = sess.events.find((e) => e.type === "tool_result");
      assert.equal(tr.toolUseId, "ex-1");
      assert.match(tr.text, /Script completed/);
      assert.match(tr.text, /package\.json/);
      assert.doesNotMatch(tr.text, /\[object Object\]/);
    } finally {
      cleanup(dir);
    }
  });

  test("custom_tool_call and custom_tool_call_output attach to assistant flush", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "response_item",
        timestamp: TS,
        payload: { type: "custom_tool_call", call_id: "ct-1", name: "apply_patch", input: "patch body" },
      },
      {
        type: "response_item",
        timestamp: TS1,
        payload: { type: "custom_tool_call_output", call_id: "ct-1", output: "apply_patch verification failed: missing lines" },
      },
      {
        type: "response_item",
        timestamp: TS2,
        payload: { role: "assistant", content: [] },
      },
    ]);
    try {
      const sess = parseCodex(file);
      const asst = sess.events.find((e) => e.type === "assistant");
      assert.equal(asst.toolCalls[0].name, "Edit");
      const tr = sess.events.find((e) => e.type === "tool_result");
      assert.equal(tr.isError, true);
    } finally {
      cleanup(dir);
    }
  });

  test("assistant content blocks with output_text and inline function_call", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "response_item",
        timestamp: TS,
        payload: {
          role: "assistant",
          content: [
            { type: "output_text", text: "I'll grep the tree." },
            {
              type: "function_call",
              call_id: "inline-grep",
              name: "grep",
              arguments: '{"pattern":"parseCodex","path":"test"}',
            },
          ],
        },
      },
    ]);
    try {
      const ev = parseCodex(file).events[0];
      assert.equal(ev.type, "assistant");
      assert.equal(ev.text, "I'll grep the tree.");
      assert.equal(ev.toolCalls[0].name, "Grep");
      assert.match(ev.toolCalls[0].input, /parseCodex/);
      assert.equal(ev.stopReason, "tool_use");
    } finally {
      cleanup(dir);
    }
  });

  test("legacy user role function_call_output in content emits standalone tool_result", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "response_item",
        timestamp: TS,
        payload: {
          role: "user",
          content: [
            { type: "function_call_output", call_id: "legacy-out", output: "legacy result payload" },
          ],
        },
      },
    ]);
    try {
      const tr = parseCodex(file).events.find((e) => e.type === "tool_result");
      assert.equal(tr.toolUseId, "legacy-out");
      assert.equal(tr.text, "legacy result payload");
    } finally {
      cleanup(dir);
    }
  });

  test("orphan pending tool calls flush as standalone assistant turn without prior assistant", () => {
    const { dir, file } = writeCodexJsonl([
      {
        type: "response_item",
        timestamp: TS,
        payload: {
          type: "function_call",
          call_id: "orphan-fc",
          name: "bash",
          arguments: '{"command":"echo orphan"}',
        },
      },
    ]);
    try {
      const sess = parseCodex(file);
      const asst = sess.events.filter((e) => e.type === "assistant");
      assert.equal(asst.length, 1);
      assert.equal(asst[0].text, "");
      assert.equal(asst[0].toolCalls[0].name, "Bash");
      assert.equal(asst[0].stopReason, "tool_use");
    } finally {
      cleanup(dir);
    }
  });

  test("malformed JSONL lines are skipped without crashing", () => {
    const { dir, file } = writeCodexJsonl([
      "",
      "{not json",
      JSON.stringify({
        type: "event_msg",
        timestamp: TS,
        payload: { type: "user_message", message: "after garbage" },
      }),
    ]);
    try {
      const sess = parseCodex(file);
      assert.equal(sess.events.length, 1);
      assert.equal(sess.events[0].text, "after garbage");
    } finally {
      cleanup(dir);
    }
  });

  test("empty rollout jsonl yields codex session with zero events", () => {
    const { dir, file } = writeCodexJsonl([], "empty");
    try {
      const sess = parseCodex(file);
      assert.equal(sess.source, "codex");
      assert.equal(sess.eventCount, 0);
      assert.equal(sess.stats.userMessages, 0);
      assert.equal(sess.stats.assistantTurns, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("streams large sessions without readFileSync and skips filler stream_chunk JSON.parse (perf)", () => {
    const src = readFileSync("src/parse/parse-codex.js", "utf8");
    assert.match(src, /forEachJsonlLineFromFile\s*\(\s*filePath/);
    assert.match(src, /isCodexIndexSkippableLine/);
    assert.match(src, /isCodexIndexedJsonlLine/);
    assert.doesNotMatch(src, /forEachParsedJsonlLine/);
    assert.doesNotMatch(src, /readFileSync\s*\(\s*filePath/);

    const dir = mkdtempSync(join(os.tmpdir(), "parse-codex-perf-"));
    const file = join(dir, "rollout.jsonl");
    const lines = [
      JSON.stringify({
        type: "session_meta",
        payload: { id: SESSION, cwd: CWD, model_provider: "openai" },
      }),
    ];
    for (let i = 0; i < 8000; i++) {
      lines.push(JSON.stringify({ type: "stream_chunk", payload: { text: "x".repeat(400) } }));
      if (i % 5 === 0) {
        lines.push(
          JSON.stringify({
            type: "event_msg",
            timestamp: TS,
            payload: { type: "user_message", message: `codex prompt ${i}` },
          }),
        );
      }
    }
    writeFileSync(file, lines.join("\n") + "\n", "utf8");
    try {
      const ITERS = 10;
      for (let w = 0; w < 2; w++) parseCodex(file);
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const sess = parseCodex(file);
        assert.ok(sess.events.length > 0);
        assert.equal(sess.model, "openai");
      }
      const ms = (performance.now() - t0) / ITERS;
      // ~1.5× headroom for CI/load variance (observed ~10.4ms); still catches readFileSync regressions.
      assertPerf(
        ms < 15,
        `expected parseCodex under 15ms/op for 8k stream_chunk filler session, got ${ms.toFixed(2)}ms`,
      );
    } finally {
      cleanup(dir);
    }
  });
});