import assert from "node:assert/strict";

const VALID_ROLES = new Set(["user", "assistant"]);

/**
 * Assert stdout JSON from `tracequest messages` matches Anthropic Messages API shape.
 * @param {unknown} parsed - parsed JSON from messages stdout
 * @param {{ minMessages?: number, expectMarker?: string }} [opts]
 */
export function assertAnthropicMessagesExport(parsed, { minMessages = 2, expectMarker } = {}) {
  assert.ok(parsed && typeof parsed === "object", "export should be a JSON object");
  assert.ok(Array.isArray(parsed.messages), "export should have messages[]");
  assert.ok(parsed.messages.length >= minMessages, `expected >= ${minMessages} messages`);

  for (const msg of parsed.messages) {
    assert.ok(VALID_ROLES.has(msg.role), `unexpected role: ${msg.role}`);
    assert.ok(Array.isArray(msg.content), `message role=${msg.role} should have content[]`);
    assert.ok(msg.content.length >= 1, `message role=${msg.role} should have content blocks`);
    for (const block of msg.content) {
      assert.equal(typeof block.type, "string", "content block should have string type");
      if (block.type === "text") {
        assert.equal(typeof block.text, "string", "text block should have string text");
      } else if (block.type === "tool_use") {
        assert.equal(typeof block.name, "string", "tool_use should have name");
        assert.ok(block.input != null && typeof block.input === "object", "tool_use.input should be object");
        assert.ok(!Array.isArray(block.input), "tool_use.input should not be array");
      } else if (block.type === "tool_result") {
        assert.equal(typeof block.tool_use_id, "string", "tool_result should have tool_use_id");
      }
    }
  }

  assert.equal(parsed.messages[0].role, "user", "first message should be user");
  assert.equal(parsed.messages[1].role, "assistant", "second message should be assistant");

  if (expectMarker) {
    const userText = parsed.messages[0].content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ");
    assert.ok(userText.includes(expectMarker), `user text should include marker ${expectMarker}`);
  }
}

/**
 * Assert stdout JSON from `tracequest messages --format openai`.
 * @param {unknown} parsed
 * @param {{ minMessages?: number }} [opts]
 */
export function assertOpenAiMessagesExport(parsed, { minMessages = 2 } = {}) {
  assert.ok(parsed && typeof parsed === "object");
  assert.ok(Array.isArray(parsed.messages));
  assert.ok(parsed.messages.length >= minMessages);
  for (const msg of parsed.messages) {
    assert.ok(msg.role === "user" || msg.role === "assistant" || msg.role === "tool");
    if (msg.role === "assistant" && msg.tool_calls) {
      assert.ok(Array.isArray(msg.tool_calls));
      for (const tc of msg.tool_calls) {
        assert.equal(tc.type, "function");
        assert.equal(typeof tc.function?.name, "string");
        assert.equal(typeof tc.function?.arguments, "string");
      }
    }
  }
}