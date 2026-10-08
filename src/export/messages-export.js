/**
 * Convert a parsed Session into OpenAI or Anthropic-compatible message arrays.
 *
 * Works from the session.events produced by parseSession — the same structure
 * used by all other exporters (markdown, HTML).  Tool call inputs are the
 * summarized strings that enrichToolEvent produces (not the raw JSON objects),
 * so this is a lossy but useful representation suitable for replays, evals, or
 * LLM context re-injection.
 *
 * Because enrichToolEvent summarizes the input (e.g. Read → "/src/app.js"),
 * we reconstruct an API-compatible shape:
 *   - Anthropic `tool_use.input` must be a JSON object → wrap string as { value: "..." }
 *   - OpenAI `function.arguments` must be a JSON string → JSON.stringify({ value: "..." })
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Ensure tool input is an object (Anthropic API requires tool_use.input to be an object). */
function normalizeToolInput(input) {
  if (input && typeof input === "object") return input;
  if (typeof input === "string" && input.length > 0) return { value: input };
  return {};
}

// ---------------------------------------------------------------------------
// Anthropic format helpers
// ---------------------------------------------------------------------------

/** Placeholder content for tool_use blocks that have no recorded tool_result. */
const NO_OUTPUT_STUB = "(no output recorded)";

/**
 * Collect the set of toolUseIds that have a recorded tool_result event.
 * Null/undefined ids (session-level synthetic errors) are excluded — they can
 * never satisfy a tool_use pairing.
 */
function collectResolvedToolUseIds(events) {
  const resolved = new Set();
  for (const ev of events) {
    if (ev.type === "tool_result" && ev.toolUseId != null) resolved.add(ev.toolUseId);
  }
  return resolved;
}

/** Merge consecutive events of the same role into a single message. */
function buildAnthropicMessages(events) {
  const messages = [];
  let pending = null; // { role, content[] }
  // tool_use ids that will be paired by a real tool_result event later in the
  // stream. Any tool_use outside this set (Cursor's format records no tool
  // outputs; generated ids never match) gets a stub tool_result so the
  // exported sequence is API-replay-valid: the Anthropic API rejects an
  // assistant tool_use with no matching tool_result in the next user message.
  const resolvedIds = collectResolvedToolUseIds(events);

  function flush() {
    if (pending) {
      messages.push(pending);
      pending = null;
    }
  }

  for (const ev of events) {
    if (ev.type === "user") {
      // User text message → role "user"
      if (!ev.text) continue;
      if (pending && pending.role === "user") {
        pending.content.push({ type: "text", text: ev.text });
      } else {
        flush();
        pending = { role: "user", content: [{ type: "text", text: ev.text }] };
      }
    } else if (ev.type === "assistant") {
      flush();
      const content = [];
      const unresolvedIds = [];
      if (ev.text) content.push({ type: "text", text: ev.text });
      for (const tc of ev.toolCalls || []) {
        const id = tc.id || `toolu_${Math.random().toString(36).slice(2, 10)}`;
        content.push({
          type: "tool_use",
          id,
          name: tc.name || "unknown",
          input: normalizeToolInput(tc.input),
        });
        if (!resolvedIds.has(id)) unresolvedIds.push(id);
      }
      if (content.length === 0) continue;
      pending = { role: "assistant", content };
      // Stub-pair any tool_use with no recorded result so no tool_use is ever
      // left unpaired. Real tool_result events for sibling tool calls merge
      // into this same user message via the pending-user branch below.
      if (unresolvedIds.length > 0) {
        flush();
        pending = {
          role: "user",
          content: unresolvedIds.map((id) => ({
            type: "tool_result",
            tool_use_id: id,
            content: NO_OUTPUT_STUB,
          })),
        };
      }
    } else if (ev.type === "tool_result" && ev.toolUseId == null) {
      // Session-level synthetic error (e.g. Cursor turn_ended): a tool_result
      // with a null tool_use_id references nothing and is API-invalid, so
      // emit it as plain text in a user message instead.
      const text = ev.text ? `[session error] ${ev.text}` : "[session error]";
      if (pending && pending.role === "user") {
        pending.content.push({ type: "text", text });
      } else {
        flush();
        pending = { role: "user", content: [{ type: "text", text }] };
      }
    } else if (ev.type === "tool_result") {
      // tool_result goes into a user turn with tool_result content blocks.
      // If the previous pending message is already a user turn we merge into
      // it (Anthropic API requires tool_result in a user message).
      if (pending && pending.role === "user") {
        pending.content.push({
          type: "tool_result",
          tool_use_id: ev.toolUseId,
          content: ev.text || "",
          ...(ev.isError ? { is_error: true } : {}),
        });
      } else {
        flush();
        pending = {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: ev.toolUseId,
            content: ev.text || "",
            ...(ev.isError ? { is_error: true } : {}),
          }],
        };
      }
    }
    // Skip other event types (e.g. thinking-only assistants with no content)
  }
  flush();
  return messages;
}

// ---------------------------------------------------------------------------
// OpenAI format helpers
// ---------------------------------------------------------------------------

function buildOpenAIMessages(events, systemPrompt) {
  const messages = [];
  // OpenAI format: system prompt is a role: "system" message at the start.
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  // Same pairing invariant as the Anthropic builder: every tool call must be
  // answered by a role:"tool" message, and no tool message may carry a
  // null/missing tool_call_id.
  const resolvedIds = collectResolvedToolUseIds(events);

  for (const ev of events) {
    if (ev.type === "user") {
      if (!ev.text) continue;
      messages.push({ role: "user", content: ev.text });
    } else if (ev.type === "assistant") {
      const msg = { role: "assistant" };
      if (ev.text) msg.content = ev.text;
      else msg.content = null;

      const toolCalls = [];
      for (const tc of ev.toolCalls || []) {
        const id = tc.id || `call_${Math.random().toString(36).slice(2, 10)}`;
        const inputObj = normalizeToolInput(tc.input);
        toolCalls.push({
          id,
          type: "function",
          function: {
            name: tc.name || "unknown",
            arguments: JSON.stringify(inputObj),
          },
        });
      }
      if (toolCalls.length > 0) msg.tool_calls = toolCalls;

      // Skip assistant messages with no text and no tool calls
      if (!msg.content && !msg.tool_calls) continue;
      messages.push(msg);
      // Stub-pair tool calls that have no recorded result (see Anthropic builder).
      for (const tc of toolCalls) {
        if (!resolvedIds.has(tc.id)) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: NO_OUTPUT_STUB });
        }
      }
    } else if (ev.type === "tool_result" && ev.toolUseId == null) {
      // Session-level synthetic error: never emit a tool message with a
      // null tool_call_id — surface it as plain user text instead.
      messages.push({
        role: "user",
        content: ev.text ? `[session error] ${ev.text}` : "[session error]",
      });
    } else if (ev.type === "tool_result") {
      messages.push({
        role: "tool",
        tool_call_id: ev.toolUseId,
        content: ev.text || "",
      });
    }
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a parsed Session into a messages array.
 *
 * System prompt handling:
 *   - If session.systemPrompt is set, it is included in the output.
 *   - Anthropic format: top-level `system` field (string), per the API spec.
 *   - OpenAI format: `role: "system"` message prepended to the messages array.
 *   - Current parsers (Claude, Codex, Factory, Grok, OpenCode) do not extract
 *     system prompts from session files because the logs do not contain them.
 *     This support is forward-compatible for when/if that data becomes available.
 *
 * @param {object} session  A session object returned by parseSession
 * @param {object} [opts]
 * @param {string} [opts.format="anthropic"]  "anthropic" or "openai"
 * @returns {{ messages: object[], system?: string, model?: string, session_id?: string }}
 */
export function exportMessages(session, { format = "anthropic" } = {}) {
  const events = session.events || [];
  const systemPrompt = session.systemPrompt || "";

  const messages = format === "openai"
    ? buildOpenAIMessages(events, systemPrompt)
    : buildAnthropicMessages(events);

  const result = { messages };
  // Anthropic API: system prompt is a top-level field, not in the messages array.
  if (format !== "openai" && systemPrompt) {
    result.system = systemPrompt;
  }
  if (session.model) result.model = session.model;
  if (session.sessionId) result.session_id = session.sessionId;
  return result;
}
