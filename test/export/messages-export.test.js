import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { exportMessages } from "../../src/export/messages-export.js";

// ---------------------------------------------------------------------------
// Test helpers — minimal session objects
// ---------------------------------------------------------------------------

function sessionWith(events, overrides = {}) {
  return {
    sessionId: "test-session-001",
    model: "claude-sonnet-4-20250514",
    events,
    ...overrides,
  };
}

/**
 * Assert the Anthropic API pairing rule on an exported messages array:
 * every tool_use in an assistant message is answered by a tool_result with
 * the same id in the immediately following user message, and no tool_result
 * carries a null/missing or unknown tool_use_id.
 */
function assertAnthropicPairingInvariant(messages) {
  const seenToolUseIds = new Set();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    assert.ok(Array.isArray(msg.content), `message ${i} content must be an array`);
    for (const block of msg.content) {
      if (block.type === "tool_use") {
        assert.equal(msg.role, "assistant", `tool_use must be in an assistant message (msg ${i})`);
        seenToolUseIds.add(block.id);
      } else if (block.type === "tool_result") {
        assert.equal(msg.role, "user", `tool_result must be in a user message (msg ${i})`);
        assert.ok(
          typeof block.tool_use_id === "string" && block.tool_use_id.length > 0,
          `tool_result must have a non-null tool_use_id (msg ${i})`,
        );
        assert.ok(
          seenToolUseIds.has(block.tool_use_id),
          `tool_result ${block.tool_use_id} must reference a prior tool_use (msg ${i})`,
        );
      }
    }
    if (msg.role !== "assistant") continue;
    const toolUseIds = msg.content.filter((b) => b.type === "tool_use").map((b) => b.id);
    if (toolUseIds.length === 0) continue;
    const next = messages[i + 1];
    assert.ok(next, `assistant message ${i} with tool_use must not be last`);
    assert.equal(next.role, "user", `message after tool_use (msg ${i}) must be role user`);
    const resultIds = next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id);
    for (const id of toolUseIds) {
      assert.equal(
        resultIds.filter((r) => r === id).length,
        1,
        `tool_use ${id} (msg ${i}) must have exactly one tool_result in the next user message`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic format tests
// ---------------------------------------------------------------------------

describe("exportMessages anthropic format", () => {
  it("converts a simple user/assistant exchange", () => {
    const session = sessionWith([
      { type: "user", text: "hello world" },
      { type: "assistant", text: "greetings" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    assert.ok(Array.isArray(result.messages));
    assert.equal(result.messages.length, 2);

    const user = result.messages[0];
    assert.equal(user.role, "user");
    assert.ok(Array.isArray(user.content));
    assert.equal(user.content[0].type, "text");
    assert.equal(user.content[0].text, "hello world");

    const assistant = result.messages[1];
    assert.equal(assistant.role, "assistant");
    assert.ok(Array.isArray(assistant.content));
    assert.equal(assistant.content[0].type, "text");
    assert.equal(assistant.content[0].text, "greetings");
  });

  it("preserves tool_use blocks on assistant messages", () => {
    const session = sessionWith([
      { type: "user", text: "read the file" },
      {
        type: "assistant",
        text: "reading",
        toolCalls: [
          { id: "toolu_123", name: "Read", input: "/src/app.js" },
        ],
      },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    const assistant = result.messages[1];
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.content.length, 2);
    assert.equal(assistant.content[0].type, "text");
    assert.equal(assistant.content[0].text, "reading");
    assert.equal(assistant.content[1].type, "tool_use");
    assert.equal(assistant.content[1].id, "toolu_123");
    assert.equal(assistant.content[1].name, "Read");
    assert.deepEqual(assistant.content[1].input, { value: "/src/app.js" });
  });

  it("places tool_result blocks in user messages", () => {
    const session = sessionWith([
      { type: "user", text: "read it" },
      {
        type: "assistant",
        text: "ok",
        toolCalls: [{ id: "toolu_abc", name: "Read", input: "/file" }],
      },
      { type: "tool_result", toolUseId: "toolu_abc", text: "file contents" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    // tool_result should be in a user message
    const toolResultMsg = result.messages[2];
    assert.equal(toolResultMsg.role, "user");
    assert.equal(toolResultMsg.content[0].type, "tool_result");
    assert.equal(toolResultMsg.content[0].tool_use_id, "toolu_abc");
    assert.equal(toolResultMsg.content[0].content, "file contents");
  });

  it("marks error tool_results with is_error: true", () => {
    const session = sessionWith([
      { type: "user", text: "run command" },
      {
        type: "assistant",
        text: "running",
        toolCalls: [{ id: "toolu_err", name: "Bash", input: "false" }],
      },
      { type: "tool_result", toolUseId: "toolu_err", text: "exit code 1", isError: true },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    const toolResultMsg = result.messages[2];
    assert.equal(toolResultMsg.role, "user");
    const block = toolResultMsg.content[0];
    assert.equal(block.type, "tool_result");
    assert.equal(block.is_error, true);
  });

  it("merges consecutive same-role user messages", () => {
    const session = sessionWith([
      { type: "user", text: "first" },
      { type: "user", text: "second" },
      { type: "assistant", text: "reply" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    // Two consecutive user messages should be merged into one
    assert.equal(result.messages.length, 2);
    const user = result.messages[0];
    assert.equal(user.role, "user");
    assert.equal(user.content.length, 2);
    assert.equal(user.content[0].text, "first");
    assert.equal(user.content[1].text, "second");
  });

  it("merges tool_result into preceding user message", () => {
    const session = sessionWith([
      { type: "user", text: "fix it" },
      {
        type: "assistant",
        text: "fixing",
        toolCalls: [
          { id: "toolu_a", name: "Read", input: "/a" },
          { id: "toolu_b", name: "Edit", input: "/b" },
        ],
      },
      { type: "tool_result", toolUseId: "toolu_a", text: "content a" },
      { type: "tool_result", toolUseId: "toolu_b", text: "edited b" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    // The two tool_results should merge into a single user message
    const toolMsg = result.messages[2];
    assert.equal(toolMsg.role, "user");
    assert.equal(toolMsg.content.length, 2);
    assert.equal(toolMsg.content[0].type, "tool_result");
    assert.equal(toolMsg.content[0].tool_use_id, "toolu_a");
    assert.equal(toolMsg.content[1].type, "tool_result");
    assert.equal(toolMsg.content[1].tool_use_id, "toolu_b");
  });

  it("handles multiple tool_use blocks on a single assistant message", () => {
    const session = sessionWith([
      { type: "user", text: "do multiple things" },
      {
        type: "assistant",
        text: "doing them",
        toolCalls: [
          { id: "toolu_1", name: "Read", input: "/a" },
          { id: "toolu_2", name: "Bash", input: "ls" },
          { id: "toolu_3", name: "Edit", input: "/b" },
        ],
      },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    const assistant = result.messages[1];
    assert.equal(assistant.content.length, 4); // 1 text + 3 tool_use
    assert.equal(assistant.content[0].type, "text");
    assert.equal(assistant.content[1].type, "tool_use");
    assert.equal(assistant.content[2].type, "tool_use");
    assert.equal(assistant.content[3].type, "tool_use");
  });

  it("generates synthetic IDs for tool_use blocks missing id", () => {
    const session = sessionWith([
      { type: "user", text: "test" },
      {
        type: "assistant",
        text: "testing",
        toolCalls: [{ name: "Read", input: "/file" }], // no id
      },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    const assistant = result.messages[1];
    const toolUse = assistant.content[1];
    assert.equal(toolUse.type, "tool_use");
    assert.ok(toolUse.id.startsWith("toolu_"), "should generate synthetic ID");
  });

  it("skips user events with no text", () => {
    const session = sessionWith([
      { type: "user", text: "" },
      { type: "user", text: null },
      { type: "user", text: "actual message" },
      { type: "assistant", text: "reply" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    // Only the non-empty user message and the assistant message
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].content[0].text, "actual message");
  });

  it("skips assistant events with no text and no tool calls", () => {
    const session = sessionWith([
      { type: "user", text: "hello" },
      { type: "assistant", text: "" }, // no text, no toolCalls
      { type: "assistant", text: "real reply" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    // The empty assistant should be skipped
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1].content[0].text, "real reply");
  });

  it("handles assistant with only tool calls (no text)", () => {
    const session = sessionWith([
      { type: "user", text: "do it" },
      {
        type: "assistant",
        text: "",
        toolCalls: [{ id: "toolu_x", name: "Bash", input: "echo hi" }],
      },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    const assistant = result.messages[1];
    assert.equal(assistant.role, "assistant");
    // Should have only the tool_use block (no empty text block)
    assert.equal(assistant.content.length, 1);
    assert.equal(assistant.content[0].type, "tool_use");
  });

  it("non-error tool_result omits is_error field", () => {
    const session = sessionWith([
      { type: "user", text: "check" },
      {
        type: "assistant",
        text: "checking",
        toolCalls: [{ id: "toolu_ok", name: "Read", input: "/f" }],
      },
      { type: "tool_result", toolUseId: "toolu_ok", text: "good" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    const toolResult = result.messages[2].content[0];
    assert.equal(toolResult.type, "tool_result");
    assert.ok(!("is_error" in toolResult), "non-error should not have is_error field");
  });
});

// ---------------------------------------------------------------------------
// Cursor pairing tests (fact xab): every tool_use gets a matching tool_result,
// null-id synthetic errors become plain text, claude output is unchanged.
// ---------------------------------------------------------------------------

describe("exportMessages tool_use/tool_result pairing (cursor)", () => {
  // Shape produced by parseCursor: tool calls with id null, session-level
  // turn_ended error as tool_result with toolUseId null.
  function cursorSession() {
    return sessionWith(
      [
        { type: "user", text: "fix the bug", timestamp: null },
        {
          type: "assistant",
          text: "looking",
          timestamp: null,
          toolCalls: [
            { id: null, name: "Read", input: "/src/app.js" },
            { id: null, name: "Shell", input: "ls" },
          ],
        },
        { type: "assistant", text: "done", timestamp: null, toolCalls: [] },
        { type: "tool_result", timestamp: null, toolUseId: null, text: "Turn ended with error", isError: true },
      ],
      { sessionId: "cursor-uuid-1", model: "cursor", source: "cursor" },
    );
  }

  it("anthropic: every cursor tool_use has exactly one matching stub tool_result", () => {
    const result = exportMessages(cursorSession(), { format: "anthropic" });
    assertAnthropicPairingInvariant(result.messages);

    const toolUses = result.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_use"));
    const toolResults = result.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
    assert.equal(toolUses.length, 2);
    assert.equal(toolResults.length, 2);
    for (const tr of toolResults) {
      assert.equal(tr.content, "(no output recorded)");
      assert.ok(typeof tr.tool_use_id === "string" && tr.tool_use_id.length > 0);
    }
  });

  it("anthropic: session-level error is plain text, never a tool_result", () => {
    const result = exportMessages(cursorSession(), { format: "anthropic" });
    const allBlocks = result.messages.flatMap((m) => m.content);
    const errText = allBlocks.find((b) => b.type === "text" && b.text.includes("Turn ended with error"));
    assert.ok(errText, "error text must appear as a plain text block");
    assert.ok(errText.text.startsWith("[session error]"));
    // No tool_result anywhere with null/missing tool_use_id
    for (const b of allBlocks) {
      if (b.type === "tool_result") {
        assert.ok(b.tool_use_id != null, "no tool_result may have a null tool_use_id");
      }
    }
    // The error's text block lives in a user message
    const errMsg = result.messages.find((m) => m.content.includes(errText));
    assert.equal(errMsg.role, "user");
  });

  it("openai: stub tool messages pair every tool_call; error becomes user text", () => {
    const result = exportMessages(cursorSession(), { format: "openai" });
    const callIds = result.messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id));
    assert.equal(callIds.length, 2);
    const toolMsgs = result.messages.filter((m) => m.role === "tool");
    assert.equal(toolMsgs.length, 2);
    for (const id of callIds) {
      const matches = toolMsgs.filter((t) => t.tool_call_id === id);
      assert.equal(matches.length, 1, `tool call ${id} must have exactly one tool message`);
      assert.equal(matches[0].content, "(no output recorded)");
    }
    // Error is a plain user message, and no tool message has a null id
    assert.ok(result.messages.some((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[session error]")));
    for (const t of toolMsgs) assert.ok(t.tool_call_id != null);
  });

  it("stubs an unpaired tool_use in a claude-shaped (broken) transcript too", () => {
    const session = sessionWith([
      { type: "user", text: "go" },
      {
        type: "assistant",
        text: "working",
        toolCalls: [
          { id: "toolu_ok", name: "Read", input: "/a" },
          { id: "toolu_lost", name: "Bash", input: "ls" },
        ],
      },
      { type: "tool_result", toolUseId: "toolu_ok", text: "contents" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    assertAnthropicPairingInvariant(result.messages);
    const results = result.messages.flatMap((m) => m.content.filter((b) => b.type === "tool_result"));
    const lost = results.find((r) => r.tool_use_id === "toolu_lost");
    assert.ok(lost, "unpaired tool_use must get a stub tool_result");
    assert.equal(lost.content, "(no output recorded)");
    const ok = results.find((r) => r.tool_use_id === "toolu_ok");
    assert.equal(ok.content, "contents");
  });

  it("claude session with fully paired tools is byte-identical to pre-stub output", () => {
    const session = sessionWith([
      { type: "user", text: "step 1" },
      {
        type: "assistant",
        text: "reading",
        toolCalls: [
          { id: "toolu_a", name: "Read", input: "/a" },
          { id: "toolu_b", name: "Edit", input: "/b" },
        ],
      },
      { type: "tool_result", toolUseId: "toolu_a", text: "content a" },
      { type: "tool_result", toolUseId: "toolu_b", text: "edited b", isError: true },
      { type: "assistant", text: "all done" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    assertAnthropicPairingInvariant(result.messages);
    // Structural snapshot of the pre-change output shape
    assert.deepStrictEqual(result.messages, [
      { role: "user", content: [{ type: "text", text: "step 1" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool_use", id: "toolu_a", name: "Read", input: { value: "/a" } },
          { type: "tool_use", id: "toolu_b", name: "Edit", input: { value: "/b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_a", content: "content a" },
          { type: "tool_result", tool_use_id: "toolu_b", content: "edited b", is_error: true },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "all done" }] },
    ]);
    // No stub content anywhere in a fully paired session
    const json = JSON.stringify(result);
    assert.ok(!json.includes("(no output recorded)"));
    assert.ok(!json.includes("[session error]"));
  });

  it("pairing invariant holds for a mixed multi-turn session in both formats", () => {
    const events = [];
    for (let i = 0; i < 6; i++) {
      events.push({ type: "user", text: `prompt ${i}` });
      events.push({
        type: "assistant",
        text: `reply ${i}`,
        toolCalls: [{ id: i % 2 === 0 ? `t${i}` : null, name: "Bash", input: `cmd${i}` }],
      });
      if (i % 2 === 0) events.push({ type: "tool_result", toolUseId: `t${i}`, text: `result ${i}` });
    }
    const session = sessionWith(events);
    const anthropic = exportMessages(session, { format: "anthropic" });
    assertAnthropicPairingInvariant(anthropic.messages);

    const openai = exportMessages(session, { format: "openai" });
    const callIds = openai.messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id));
    for (const id of callIds) {
      assert.equal(openai.messages.filter((m) => m.role === "tool" && m.tool_call_id === id).length, 1);
    }
    for (const m of openai.messages) {
      if (m.role === "tool") assert.ok(m.tool_call_id != null);
    }
  });
});

// ---------------------------------------------------------------------------
// OpenAI format tests
// ---------------------------------------------------------------------------

describe("exportMessages openai format", () => {
  it("converts a simple user/assistant exchange", () => {
    const session = sessionWith([
      { type: "user", text: "hello" },
      { type: "assistant", text: "hi there" },
    ]);
    const result = exportMessages(session, { format: "openai" });
    assert.equal(result.messages.length, 2);

    const user = result.messages[0];
    assert.equal(user.role, "user");
    assert.equal(user.content, "hello");

    const assistant = result.messages[1];
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.content, "hi there");
  });

  it("puts tool_calls array on assistant messages", () => {
    const session = sessionWith([
      { type: "user", text: "read the file" },
      {
        type: "assistant",
        text: "reading",
        toolCalls: [
          { id: "call_123", name: "Read", input: "/src/app.js" },
        ],
      },
    ]);
    const result = exportMessages(session, { format: "openai" });
    const assistant = result.messages[1];
    assert.equal(assistant.role, "assistant");
    assert.equal(assistant.content, "reading");
    assert.ok(Array.isArray(assistant.tool_calls));
    assert.equal(assistant.tool_calls.length, 1);
    assert.equal(assistant.tool_calls[0].type, "function");
    assert.equal(assistant.tool_calls[0].function.name, "Read");
    assert.equal(typeof assistant.tool_calls[0].function.arguments, "string");
  });

  it("creates separate tool role messages for tool results", () => {
    const session = sessionWith([
      { type: "user", text: "read" },
      {
        type: "assistant",
        text: "ok",
        toolCalls: [{ id: "call_abc", name: "Read", input: "/f" }],
      },
      { type: "tool_result", toolUseId: "call_abc", text: "file contents" },
    ]);
    const result = exportMessages(session, { format: "openai" });
    const toolMsg = result.messages[2];
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "call_abc");
    assert.equal(toolMsg.content, "file contents");
  });

  it("does not merge consecutive user messages (unlike Anthropic)", () => {
    const session = sessionWith([
      { type: "user", text: "first" },
      { type: "user", text: "second" },
      { type: "assistant", text: "reply" },
    ]);
    const result = exportMessages(session, { format: "openai" });
    // OpenAI format: each user message is separate
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].content, "first");
    assert.equal(result.messages[1].content, "second");
  });

  it("serializes non-string tool input as JSON in arguments field", () => {
    const session = sessionWith([
      { type: "user", text: "edit" },
      {
        type: "assistant",
        text: "editing",
        toolCalls: [
          { id: "call_obj", name: "Edit", input: { file_path: "/a.js", new_string: "hello" } },
        ],
      },
    ]);
    const result = exportMessages(session, { format: "openai" });
    const args = result.messages[1].tool_calls[0].function.arguments;
    // Should be a JSON string since input is an object
    const parsed = JSON.parse(args);
    assert.equal(parsed.file_path, "/a.js");
    assert.equal(parsed.new_string, "hello");
  });

  it("wraps string tool input in JSON object for arguments field", () => {
    const session = sessionWith([
      { type: "user", text: "run" },
      {
        type: "assistant",
        text: "running",
        toolCalls: [
          { id: "call_str", name: "Bash", input: "echo hello" },
        ],
      },
    ]);
    const result = exportMessages(session, { format: "openai" });
    const args = result.messages[1].tool_calls[0].function.arguments;
    // arguments must be a valid JSON string, even for summarized string inputs
    const parsed = JSON.parse(args);
    assert.equal(parsed.value, "echo hello");
  });

  it("sets content to null for assistant with only tool calls", () => {
    const session = sessionWith([
      { type: "user", text: "do it" },
      {
        type: "assistant",
        text: "",
        toolCalls: [{ id: "call_x", name: "Bash", input: "ls" }],
      },
    ]);
    const result = exportMessages(session, { format: "openai" });
    const assistant = result.messages[1];
    assert.equal(assistant.content, null);
    assert.ok(Array.isArray(assistant.tool_calls));
  });

  it("skips assistant messages with no text and no tool calls", () => {
    const session = sessionWith([
      { type: "user", text: "hello" },
      { type: "assistant", text: "" },
      { type: "assistant", text: "real" },
    ]);
    const result = exportMessages(session, { format: "openai" });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1].content, "real");
  });

  it("generates synthetic IDs for tool_calls missing id", () => {
    const session = sessionWith([
      { type: "user", text: "test" },
      {
        type: "assistant",
        text: "ok",
        toolCalls: [{ name: "Read", input: "/f" }],
      },
    ]);
    const result = exportMessages(session, { format: "openai" });
    const toolCall = result.messages[1].tool_calls[0];
    assert.ok(toolCall.id.startsWith("call_"), "should generate synthetic ID");
  });

  it("handles multiple tool_calls on a single assistant message", () => {
    const session = sessionWith([
      { type: "user", text: "multi" },
      {
        type: "assistant",
        text: "doing both",
        toolCalls: [
          { id: "call_1", name: "Read", input: "/a" },
          { id: "call_2", name: "Bash", input: "ls" },
        ],
      },
    ]);
    const result = exportMessages(session, { format: "openai" });
    const assistant = result.messages[1];
    assert.equal(assistant.tool_calls.length, 2);
    assert.equal(assistant.tool_calls[0].function.name, "Read");
    assert.equal(assistant.tool_calls[1].function.name, "Bash");
  });
});

// ---------------------------------------------------------------------------
// Edge cases and metadata
// ---------------------------------------------------------------------------

describe("exportMessages edge cases", () => {
  it("returns empty messages array for empty session", () => {
    const session = sessionWith([]);
    const result = exportMessages(session, { format: "anthropic" });
    assert.deepStrictEqual(result.messages, []);
  });

  it("returns empty messages for session with undefined events", () => {
    const session = { sessionId: "no-events", model: "test" };
    const result = exportMessages(session, { format: "anthropic" });
    assert.deepStrictEqual(result.messages, []);
  });

  it("handles session with only text (no tool calls)", () => {
    const session = sessionWith([
      { type: "user", text: "tell me a joke" },
      { type: "assistant", text: "why did the chicken cross the road?" },
      { type: "user", text: "why?" },
      { type: "assistant", text: "to get to the other side" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    assert.equal(result.messages.length, 4);
    assert.ok(result.messages.every((m) => m.role === "user" || m.role === "assistant"));
  });

  it("includes model in result when session has model", () => {
    const session = sessionWith([], { model: "claude-opus-4-20250514" });
    const result = exportMessages(session);
    assert.equal(result.model, "claude-opus-4-20250514");
  });

  it("omits model from result when session has no model", () => {
    const session = sessionWith([], { model: undefined });
    const result = exportMessages(session);
    assert.ok(!("model" in result));
  });

  it("includes session_id in result when session has sessionId", () => {
    const session = sessionWith([], { sessionId: "sess-42" });
    const result = exportMessages(session);
    assert.equal(result.session_id, "sess-42");
  });

  it("omits session_id from result when session has no sessionId", () => {
    const session = sessionWith([], { sessionId: undefined });
    const result = exportMessages(session);
    assert.ok(!("session_id" in result));
  });

  it("defaults to anthropic format when format is omitted", () => {
    const session = sessionWith([
      { type: "user", text: "hi" },
      { type: "assistant", text: "hello" },
    ]);
    const result = exportMessages(session);
    // Anthropic format: content is an array of blocks
    assert.ok(Array.isArray(result.messages[0].content));
  });

  it("skips unknown event types gracefully", () => {
    const session = sessionWith([
      { type: "user", text: "hello" },
      { type: "thinking", text: "hmm" }, // not user/assistant/tool_result
      { type: "system", text: "system prompt" },
      { type: "assistant", text: "reply" },
    ]);
    const result = exportMessages(session, { format: "anthropic" });
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, "user");
    assert.equal(result.messages[1].role, "assistant");
  });

  it("handles tool_result with empty text", () => {
    const session = sessionWith([
      { type: "user", text: "do it" },
      {
        type: "assistant",
        text: "ok",
        toolCalls: [{ id: "toolu_empty", name: "Bash", input: "true" }],
      },
      { type: "tool_result", toolUseId: "toolu_empty", text: "" },
    ]);
    const anthropic = exportMessages(session, { format: "anthropic" });
    assert.equal(anthropic.messages[2].content[0].content, "");

    const openai = exportMessages(session, { format: "openai" });
    assert.equal(openai.messages[2].content, "");
  });

  it("handles tool_result with null text", () => {
    const session = sessionWith([
      { type: "user", text: "do it" },
      {
        type: "assistant",
        text: "ok",
        toolCalls: [{ id: "toolu_null", name: "Bash", input: "true" }],
      },
      { type: "tool_result", toolUseId: "toolu_null", text: null },
    ]);
    const anthropic = exportMessages(session, { format: "anthropic" });
    assert.equal(anthropic.messages[2].content[0].content, "");

    const openai = exportMessages(session, { format: "openai" });
    assert.equal(openai.messages[2].content, "");
  });

  it("full conversation round-trip preserves message count and order", () => {
    const session = sessionWith([
      { type: "user", text: "step 1" },
      {
        type: "assistant",
        text: "doing step 1",
        toolCalls: [{ id: "t1", name: "Read", input: "/a" }],
      },
      { type: "tool_result", toolUseId: "t1", text: "file a" },
      {
        type: "assistant",
        text: "now editing",
        toolCalls: [{ id: "t2", name: "Edit", input: "/a" }],
      },
      { type: "tool_result", toolUseId: "t2", text: "edited" },
      { type: "assistant", text: "done with step 1" },
      { type: "user", text: "step 2" },
      { type: "assistant", text: "doing step 2" },
    ]);

    const anthropic = exportMessages(session, { format: "anthropic" });
    // Verify role alternation pattern is valid
    let lastRole = null;
    for (const msg of anthropic.messages) {
      if (lastRole === "assistant") {
        assert.equal(msg.role, "user", "after assistant, expect user (tool_result or new user)");
      }
      lastRole = msg.role;
    }

    const openai = exportMessages(session, { format: "openai" });
    // OpenAI format should have more messages (tool results are separate)
    assert.ok(openai.messages.length >= 6);
    // Verify roles are valid OpenAI roles
    for (const msg of openai.messages) {
      assert.ok(["user", "assistant", "tool"].includes(msg.role), `unexpected role: ${msg.role}`);
    }
  });

  it("anthropic format puts systemPrompt in top-level system field", () => {
    const session = sessionWith(
      [
        { type: "user", text: "hi" },
        { type: "assistant", text: "hello" },
      ],
      { systemPrompt: "You are a helpful assistant." },
    );
    const result = exportMessages(session, { format: "anthropic" });
    assert.equal(result.system, "You are a helpful assistant.");
    // System prompt should NOT appear as a message
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, "user");
    assert.equal(result.messages[1].role, "assistant");
  });

  it("openai format puts systemPrompt as first role:system message", () => {
    const session = sessionWith(
      [
        { type: "user", text: "hi" },
        { type: "assistant", text: "hello" },
      ],
      { systemPrompt: "You are a helpful assistant." },
    );
    const result = exportMessages(session, { format: "openai" });
    // Should NOT have top-level system field
    assert.ok(!("system" in result));
    // First message should be system role
    assert.equal(result.messages.length, 3);
    assert.equal(result.messages[0].role, "system");
    assert.equal(result.messages[0].content, "You are a helpful assistant.");
    assert.equal(result.messages[1].role, "user");
    assert.equal(result.messages[2].role, "assistant");
  });

  it("omits system field when systemPrompt is empty or absent", () => {
    const noPrompt = sessionWith([{ type: "user", text: "hi" }]);
    const anthro = exportMessages(noPrompt, { format: "anthropic" });
    assert.ok(!("system" in anthro));

    const emptyPrompt = sessionWith([{ type: "user", text: "hi" }], { systemPrompt: "" });
    const anthro2 = exportMessages(emptyPrompt, { format: "anthropic" });
    assert.ok(!("system" in anthro2));

    const openai = exportMessages(noPrompt, { format: "openai" });
    // No system message prepended
    assert.equal(openai.messages.length, 1);
    assert.equal(openai.messages[0].role, "user");
  });

  it("both formats produce valid output for a large multi-turn session", () => {
    const events = [];
    for (let i = 0; i < 10; i++) {
      events.push({ type: "user", text: `prompt ${i}` });
      events.push({
        type: "assistant",
        text: `reply ${i}`,
        toolCalls: i % 2 === 0 ? [{ id: `t${i}`, name: "Bash", input: `cmd${i}` }] : [],
      });
      if (i % 2 === 0) {
        events.push({ type: "tool_result", toolUseId: `t${i}`, text: `result ${i}` });
      }
    }
    const session = sessionWith(events);

    const anthropic = exportMessages(session, { format: "anthropic" });
    assert.ok(anthropic.messages.length > 10);
    for (const msg of anthropic.messages) {
      assert.ok(["user", "assistant"].includes(msg.role));
      assert.ok(Array.isArray(msg.content));
    }

    const openai = exportMessages(session, { format: "openai" });
    assert.ok(openai.messages.length > 10);
    for (const msg of openai.messages) {
      assert.ok(["user", "assistant", "tool"].includes(msg.role));
    }
  });
});
