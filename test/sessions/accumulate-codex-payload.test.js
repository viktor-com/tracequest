import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  accumulateCodexContentFunctionCall,
  accumulateCodexEventMsgPayload,
  accumulateCodexResponseItemPayload,
  accumulateCodexTokenCount,
} from "../../src/sessions/accumulate-codex-payload.js";
import { createIndexState } from "../../src/sessions/session-meta.js";

const FILE = "/tmp/codex-rollout.jsonl";

function run(payload, state = createIndexState()) {
  accumulateCodexResponseItemPayload(payload, FILE, state);
  return state;
}

describe("accumulateCodexResponseItemPayload", () => {
  test("function_call registers normalized tool name and increments toolCounts", () => {
    const state = run({
      type: "function_call",
      name: "read_file",
      arguments: "{}",
    });
    assert.ok(state.tools.has("Read"));
    assert.equal(state.toolCounts.Read, 1);
  });

  test("function_call adds file_path from parsed arguments to files set", () => {
    const state = run({
      type: "function_call",
      name: "Read",
      arguments: JSON.stringify({ file_path: "/proj/src/app.js" }),
    });
    assert.equal(state.files.size, 1);
    assert.ok(state.files.has("/proj/src/app.js"));
  });

  test("function_call falls back to path when file_path is absent", () => {
    const state = run({
      type: "function_call",
      name: "read",
      arguments: JSON.stringify({ path: "/repo/README.md" }),
    });
    assert.ok(state.files.has("/repo/README.md"));
  });

  test("function_call Bash with git commit in command increments commits", () => {
    const state = run({
      type: "function_call",
      name: "bash",
      arguments: JSON.stringify({ command: "git commit -m 'anneal tests'" }),
    });
    assert.ok(state.tools.has("Bash"));
    assert.equal(state.commits, 1);
  });

  test("function_call without name does not register a tool", () => {
    const state = run({
      type: "function_call",
      arguments: JSON.stringify({ file_path: "/ignored.js" }),
    });
    assert.equal(state.tools.size, 0);
    assert.equal(state.files.size, 0);
  });

  test("function_call_output Error: text alone does not increment errors", () => {
    const state = run({
      type: "function_call_output",
      output: "Error: permission denied",
    });
    assert.equal(state.errors, 0);
  });

  test("function_call_output exit code text alone does not increment errors", () => {
    const state = run({
      type: "function_call_output",
      output: "exit code 2\nstderr: boom",
    });
    assert.equal(state.errors, 0);
  });

  test("function_call_output command failed and ENOENT text alone do not increment errors", () => {
    const failed = run({ type: "function_call_output", output: "command failed: npm test" });
    assert.equal(failed.errors, 0);
    const enoent = run({ type: "function_call_output", output: "ENOENT: no such file" });
    assert.equal(enoent.errors, 0);
  });

  test("function_call_output exception text alone does not increment errors", () => {
    for (const output of [
      "SyntaxError: unexpected token",
      "TypeError: Cannot read property",
      "ReferenceError: x is not defined",
      "EACCES: permission denied, open '/etc/passwd'",
    ]) {
      const state = run({ type: "function_call_output", output });
      assert.equal(state.errors, 0, `expected success for: ${output}`);
    }
  });

  test("function_call_output with benign stdout does not increment errors", () => {
    const state = run({
      type: "function_call_output",
      output: "ok\n42 files listed",
    });
    assert.equal(state.errors, 0);
  });

  test("custom_tool_call registers MCP tool name as-is when name is present", () => {
    const state = run({ type: "custom_tool_call", name: "mcp__github__search_code" });
    assert.ok(state.tools.has("mcp__github__search_code"));
    assert.equal(state.toolCounts["mcp__github__search_code"], 1);
  });

  test("custom_tool_call without name is ignored", () => {
    const state = run({ type: "custom_tool_call", input: "noop" });
    assert.equal(state.tools.size, 0);
  });

  test("web_search_call adds WebSearch tool and count", () => {
    const state = run({ type: "web_search_call" });
    assert.ok(state.tools.has("WebSearch"));
    assert.equal(state.toolCounts.WebSearch, 1);
  });

  test("unknown payload type is a no-op", () => {
    const state = run({ type: "reasoning", summary: "thinking" });
    assert.equal(state.tools.size, 0);
    assert.equal(state.errors, 0);
    assert.equal(state.commits, 0);
  });

  test("accumulateCodexContentFunctionCall mirrors payload-level function_call rules", () => {
    const state = createIndexState();
    accumulateCodexContentFunctionCall(
      {
        type: "function_call",
        name: "bash",
        arguments: JSON.stringify({ command: "git commit -m x", file_path: "/z.js" }),
      },
      FILE,
      state,
    );
    assert.ok(state.tools.has("Bash"));
    assert.ok(state.files.has("/z.js"));
    assert.equal(state.commits, 1);
  });

  test("repeated function_call stacks toolCounts for the same tool", () => {
    const state = createIndexState();
    const payload = {
      type: "function_call",
      name: "grep",
      arguments: JSON.stringify({ pattern: "foo" }),
    };
    accumulateCodexResponseItemPayload(payload, FILE, state);
    accumulateCodexResponseItemPayload(payload, FILE, state);
    assert.equal(state.toolCounts.Grep, 2);
  });

  test("null and empty payloads are no-ops", () => {
    const state = createIndexState();
    accumulateCodexResponseItemPayload(null, FILE, state);
    accumulateCodexResponseItemPayload(undefined, FILE, state);
    accumulateCodexResponseItemPayload({}, FILE, state);
    assert.equal(state.tools.size, 0);
    assert.equal(state.errors, 0);
    assert.equal(state.commits, 0);
  });

  test("custom_tool_call_output increments errors without adding a tool", () => {
    const state = run({ type: "custom_tool_call_output", output: "apply_patch verification failed: missing lines" });
    assert.equal(state.errors, 1);
    assert.equal(state.tools.size, 0);
  });

  test("Bash without git commit does not increment commits", () => {
    const state = run({
      type: "function_call",
      name: "bash",
      arguments: JSON.stringify({ command: "ls -la /tmp" }),
    });
    assert.equal(state.commits, 0);
    assert.equal(state.toolCounts.Bash, 1);
  });

  test("malformed function_call arguments still count tool but skip files", () => {
    const state = run({
      type: "function_call",
      name: "read",
      arguments: "{not-json",
    });
    assert.equal(state.toolCounts.Read, 1);
    assert.equal(state.files.size, 0);
  });

  test("file_path wins over path when both are present", () => {
    const state = run({
      type: "function_call",
      name: "read",
      arguments: JSON.stringify({
        file_path: "/preferred.js",
        path: "/ignored.md",
      }),
    });
    assert.ok(state.files.has("/preferred.js"));
    assert.equal(state.files.size, 1);
  });

  test("multiple function_call_output errors accumulate errors count", () => {
    const state = createIndexState();
    for (const output of [{ isError: true }, { exit_code: 1 }, { error: "unavailable" }]) {
      accumulateCodexResponseItemPayload({ type: "function_call_output", output }, FILE, state);
    }
    assert.equal(state.errors, 3);
  });

  test("repeated web_search_call stacks WebSearch toolCounts", () => {
    const state = createIndexState();
    accumulateCodexResponseItemPayload({ type: "web_search_call" }, FILE, state);
    accumulateCodexResponseItemPayload({ type: "web_search_call" }, FILE, state);
    assert.equal(state.toolCounts.WebSearch, 2);
  });

  test("accumulateCodexContentFunctionCall ignores wrong type and nameless calls", () => {
    const state = createIndexState();
    accumulateCodexContentFunctionCall({ type: "reasoning", summary: "x" }, FILE, state);
    accumulateCodexContentFunctionCall({ type: "function_call", arguments: "{}" }, FILE, state);
    assert.equal(state.tools.size, 0);
  });

  test("custom_tool_call normalizes non-MCP aliases like function_call", () => {
    const state = run({ type: "custom_tool_call", name: "read_file" });
    assert.ok(state.tools.has("Read"));
    assert.equal(state.toolCounts.Read, 1);
  });
});

describe("accumulateCodexEventMsgPayload", () => {
  function runEvent(payload, state = createIndexState()) {
    accumulateCodexEventMsgPayload(payload, state);
    return state;
  }

  test("patch_apply_end registers Edit and optional path file", () => {
    const state = runEvent({ type: "patch_apply_end", path: "/app/main.js" });
    assert.ok(state.tools.has("Edit"));
    assert.equal(state.toolCounts.Edit, 1);
    assert.ok(state.files.has("/app/main.js"));
  });

  test("exec_command_end registers Bash, errors, and git commits", () => {
    const state = runEvent({
      type: "exec_command_end",
      exit_code: 1,
      command: "git commit -m 'anneal'",
    });
    assert.ok(state.tools.has("Bash"));
    assert.equal(state.toolCounts.Bash, 1);
    assert.equal(state.errors, 1);
    assert.equal(state.commits, 1);
  });

  test("web_search_end registers WebSearch", () => {
    const state = runEvent({ type: "web_search_end", query: "docs" });
    assert.ok(state.tools.has("WebSearch"));
    assert.equal(state.toolCounts.WebSearch, 1);
  });

  test("user_message is a no-op for index accumulation", () => {
    const state = runEvent({ type: "user_message", message: "hello" });
    assert.equal(state.tools.size, 0);
    assert.equal(state.chapters, 0);
  });

  test("token_count with total_token_usage sets latest session token totals", () => {
    const state = createIndexState();
    accumulateCodexEventMsgPayload(
      {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 100, output_tokens: 40, cached_input_tokens: 12 } },
      },
      state,
    );
    assert.equal(state.inputTokens, 100);
    assert.equal(state.outputTokens, 40);
    assert.equal(state.cacheReadTokens, 12);
    assert.equal(state.totalTokens, 140);

    accumulateCodexEventMsgPayload(
      {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 200, output_tokens: 60, cached_input_tokens: 0 } },
      },
      state,
    );
    assert.equal(state.inputTokens, 200);
    assert.equal(state.outputTokens, 60);
    assert.equal(state.totalTokens, 260);
  });

  test("token_count falls back to last_token_usage when total_token_usage is absent", () => {
    const state = createIndexState();
    accumulateCodexTokenCount({ last_token_usage: { input_tokens: 9, output_tokens: 3 } }, state);
    assert.equal(state.inputTokens, 9);
    assert.equal(state.outputTokens, 3);
    assert.equal(state.totalTokens, 12);
    assert.equal(state.sawTokenCountTotal, true);
  });
});