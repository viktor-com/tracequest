import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyGrokToolCountsFromChat } from "../../src/sessions/session-index-jsonl.js";
import { createIndexState } from "../../src/sessions/session-meta.js";

function chatRaw(lines) {
  return lines
    .map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
    .join("\n");
}

function applyCounts(chatLines, toolOutcomes = []) {
  const state = createIndexState();
  applyGrokToolCountsFromChat(chatRaw(chatLines), toolOutcomes, state);
  return {
    toolCounts: state.toolCounts,
    tools: state.toolsList.slice().sort(),
  };
}

describe("applyGrokToolCountsFromChat", () => {
  test("empty chat leaves toolCounts and tools empty", () => {
    const { toolCounts, tools } = applyCounts([]);
    assert.deepEqual(toolCounts, {});
    assert.deepEqual(tools, []);
  });

  test("skips system lines without counting tools", () => {
    const { toolCounts, tools } = applyCounts([
      { type: "system", content: "boot" },
      { type: "user", content: "hi" },
    ]);
    assert.deepEqual(toolCounts, {});
    assert.deepEqual(tools, []);
  });

  test("counts assistant tool_calls via normalizeToolName", () => {
    const { toolCounts, tools } = applyCounts([
      { type: "user", content: "run" },
      {
        type: "assistant",
        content: "go",
        tool_calls: [
          { name: "bash", arguments: "{}" },
          { name: "read_file", arguments: "{}" },
          { name: "web_search", arguments: "{}" },
        ],
      },
    ]);
    assert.deepEqual(toolCounts, { Bash: 1, Read: 1, WebSearch: 1 });
    assert.deepEqual(tools, ["Bash", "Read", "WebSearch"]);
  });

  test("assistant tool_calls with following tool_results do not double-count or consume outcomes", () => {
    const outcomes = [{ name: "Bash" }, { name: "Read" }];
    const { toolCounts } = applyCounts(
      [
        { type: "user", content: "dc" },
        {
          type: "assistant",
          tool_calls: [
            { id: "1", name: "bash", arguments: "{}" },
            { id: "2", name: "read", arguments: "{}" },
          ],
        },
        { type: "tool_result", tool_call_id: "1", content: "ok" },
        { type: "tool_result", tool_call_id: "2", content: "ok" },
      ],
      outcomes,
    );
    assert.deepEqual(toolCounts, { Bash: 1, Read: 1 });
  });

  test("assistant without tool_calls uses sequential toolOutcomes for tool_results", () => {
    const outcomes = [{ name: "Grep" }, { name: "Bash" }];
    const { toolCounts } = applyCounts(
      [
        { type: "user", content: "outcomes" },
        { type: "assistant", content: "implicit tools" },
        { type: "tool_result", tool_call_id: "a", content: "ok" },
        { type: "tool", tool_call_id: "b", content: "done" },
      ],
      outcomes,
    );
    assert.deepEqual(toolCounts, { Grep: 1, Bash: 1 });
  });

  test("missing toolOutcomes after assistant without tool_calls count as unknown", () => {
    const { toolCounts } = applyCounts(
      [
        { type: "user", content: "gap" },
        { type: "assistant", content: "no calls" },
        { type: "tool_result", content: "err" },
        { type: "tool_result", content: "err2" },
      ],
      [{ name: "Read" }],
    );
    assert.deepEqual(toolCounts, { Read: 1, unknown: 1 });
  });

  test("orphan tool_results before user/assistant use toolOutcomes only", () => {
    const outcomes = [{ name: "Bash" }, { name: "Read" }];
    const { toolCounts } = applyCounts(
      [
        { type: "tool_result", content: "pre" },
        { type: "tool", content: "pre2" },
        { type: "user", content: "later" },
      ],
      outcomes,
    );
    assert.deepEqual(toolCounts, { Bash: 1, Read: 1 });
  });

  test("orphan tool_results without outcomes count as unknown", () => {
    const { toolCounts } = applyCounts([{ type: "tool_result", content: "solo" }]);
    assert.deepEqual(toolCounts, { unknown: 1 });
  });

  test("multiple assistant turns accumulate repeated tool names", () => {
    const { toolCounts } = applyCounts([
      { type: "user", content: "multi" },
      {
        type: "assistant",
        tool_calls: [{ name: "bash", arguments: "{}" }],
      },
      { type: "tool_result", content: "ok" },
      { type: "assistant", content: "again" },
      {
        type: "assistant",
        tool_calls: [
          { name: "bash", arguments: "{}" },
          { name: "grep", arguments: "{}" },
        ],
      },
    ]);
    assert.deepEqual(toolCounts, { Bash: 2, Grep: 1 });
  });

  test("malformed JSONL lines are skipped without throwing", () => {
    const { toolCounts } = applyCounts([
      "{not valid json",
      { type: "user", content: "recover" },
      { type: "assistant", tool_calls: [{ name: "read", arguments: "{}" }] },
    ]);
    assert.deepEqual(toolCounts, { Read: 1 });
  });

  test("preserves mcp__ tool names without alias normalization", () => {
    const { toolCounts } = applyCounts([
      { type: "user", content: "mcp" },
      {
        type: "assistant",
        tool_calls: [{ name: "mcp__srv__lookup", arguments: "{}" }],
      },
    ]);
    assert.deepEqual(toolCounts, { "mcp__srv__lookup": 1 });
  });

  test("does not count tool_results after assistant once user/assistant was seen earlier in orphan phase", () => {
    const outcomes = [{ name: "Bash" }];
    const { toolCounts } = applyCounts(
      [
        { type: "tool_result", content: "orphan" },
        { type: "user", content: "hello" },
        { type: "assistant", content: "no embedded calls" },
        { type: "tool_result", content: "post" },
      ],
      outcomes,
    );
    assert.deepEqual(toolCounts, { Bash: 1, unknown: 1 });
  });

  test("unparseable lines between assistant and tool_results preserve outcome sequencing", () => {
    const outcomes = [{ name: "Bash" }, { name: "Read" }];
    const { toolCounts } = applyCounts(
      [
        { type: "user", content: "gap" },
        { type: "assistant", content: "implicit tools" },
        "{not valid json",
        "also bad",
        { type: "tool_result", content: "1" },
        { type: "tool", content: "2" },
      ],
      outcomes,
    );
    assert.deepEqual(toolCounts, { Bash: 1, Read: 1 });
  });

  test("assistant tool_calls without name are skipped; named siblings still count", () => {
    const { toolCounts, tools } = applyCounts([
      { type: "user", content: "partial" },
      {
        type: "assistant",
        tool_calls: [
          { arguments: "{}" },
          { name: "", arguments: "{}" },
          { name: "grep", arguments: "{}" },
        ],
      },
    ]);
    assert.deepEqual(toolCounts, { Grep: 1 });
    assert.deepEqual(tools, ["Grep"]);
  });

  test("nameless-only tool_calls block outcome pairing on following tool_results", () => {
    const outcomes = [{ name: "Bash" }];
    const { toolCounts } = applyCounts(
      [
        { type: "user", content: "nameless array" },
        {
          type: "assistant",
          tool_calls: [{ arguments: "{}" }, { name: null, arguments: "{}" }],
        },
        { type: "tool_result", content: "orphaned by empty calls array semantics" },
      ],
      outcomes,
    );
    assert.deepEqual(toolCounts, {});
  });

  test("user between assistant tool_results stops outcome pairing for later results", () => {
    const outcomes = [{ name: "Bash" }, { name: "Read" }];
    const { toolCounts } = applyCounts(
      [
        { type: "user", content: "interrupt" },
        { type: "assistant", content: "two results" },
        { type: "tool_result", content: "first" },
        { type: "user", content: "break chain" },
        { type: "tool_result", content: "second" },
      ],
      outcomes,
    );
    assert.deepEqual(toolCounts, { Bash: 1 });
  });
});