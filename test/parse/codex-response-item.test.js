import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  isCodexToolOutputError,
  visitCodexResponseItemPayload,
} from "../../src/parse/codex-response-item.js";

describe("visitCodexResponseItemPayload", () => {
  test("dispatches each payload.type to the matching handler once", () => {
    const seen = [];
    visitCodexResponseItemPayload(
      { type: "function_call", name: "read", arguments: "{}" },
      { onFunctionCall: () => seen.push("function_call") },
    );
    visitCodexResponseItemPayload(
      { type: "function_call_output", output: "ok" },
      { onFunctionCallOutput: () => seen.push("function_call_output") },
    );
    visitCodexResponseItemPayload(
      { type: "custom_tool_call", name: "mcp__x" },
      { onCustomToolCall: () => seen.push("custom_tool_call") },
    );
    visitCodexResponseItemPayload(
      { type: "custom_tool_call_output", output: "done" },
      { onCustomToolCallOutput: () => seen.push("custom_tool_call_output") },
    );
    visitCodexResponseItemPayload(
      { type: "web_search_call", action: { url: "https://x" } },
      { onWebSearchCall: () => seen.push("web_search_call") },
    );
    assert.deepEqual(seen, [
      "function_call",
      "function_call_output",
      "custom_tool_call",
      "custom_tool_call_output",
      "web_search_call",
    ]);
  });

  test("skips function_call and custom_tool_call without name", () => {
    let calls = 0;
    visitCodexResponseItemPayload({ type: "function_call", arguments: "{}" }, {
      onFunctionCall: () => calls++,
    });
    visitCodexResponseItemPayload({ type: "custom_tool_call", input: "x" }, {
      onCustomToolCall: () => calls++,
    });
    assert.equal(calls, 0);
  });
});

describe("isCodexToolOutputError", () => {
  test("does not infer failure from unstructured returned error text", () => {
    for (const output of ["Error: x", "exit code 2", "ENOENT: nope", "ok\nfine"]) {
      assert.equal(isCodexToolOutputError(output), false);
    }
  });
});
