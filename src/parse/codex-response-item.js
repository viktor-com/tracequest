import { extractToolResultText } from "./parse-enrich.js";

/** Codex `response_item.payload` types handled by parseCodex and index accumulation. */
export function visitCodexResponseItemPayload(payload, handlers) {
  const p = payload || {};
  const ptype = p.type;
  if (ptype === "function_call") {
    if (p.name) handlers.onFunctionCall?.(p);
    return;
  }
  if (ptype === "function_call_output") {
    handlers.onFunctionCallOutput?.(p);
    return;
  }
  if (ptype === "custom_tool_call") {
    if (p.name) handlers.onCustomToolCall?.(p);
    return;
  }
  if (ptype === "custom_tool_call_output") {
    handlers.onCustomToolCallOutput?.(p);
    return;
  }
  if (ptype === "web_search_call") {
    handlers.onWebSearchCall?.(p);
  }
}

export function isCodexToolOutputError(output) {
  if (Array.isArray(output)) return output.some(isCodexToolOutputError);
  if (output && typeof output === "object") {
    if (isCodexToolStatusError(output)) return true;
    if (isCodexToolStatusSuccess(output)) return false;
    if (output.output != null && isCodexToolOutputError(output.output)) return true;
  }
  const text = extractToolResultText(output) || "";
  // Command status belongs to the envelope before stdout, never to printed examples.
  const exit = text.match(/^(?:Chunk ID:[^\n]*\n)?(?:Wall time:[^\n]*\n)?Process exited with code (-?\d+)\b/i);
  if (exit) return Number(exit[1]) !== 0;
  if (/^(?:Script failed\b|apply_patch verification failed:|Failed to (?:find expected lines|apply patch)|(?:command|execution|tool|js execution) timed out\b|Error (?:parsing function call|executing tool)\b)/i.test(text)) return true;
  // Orchestration tools emit serialized results, sometimes below printed labels.
  // Embedded JSON must have the command-result envelope, not just a status example.
  if (text.trimStart().startsWith("{")) {
    try { return isCodexToolStatusError(JSON.parse(text)); } catch { /* Not a result object. */ }
  }
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("{")) continue;
    let result;
    try { result = JSON.parse(line); } catch { continue; }
    if (typeof result?.chunk_id === "string" && typeof result?.wall_time_seconds === "number" &&
        typeof result?.output === "string" && isCodexToolStatusError(result)) return true;
  }
  return false;
}

export function isCodexToolStatusError(payload) {
  const code = payload?.exit_code;
  return (code != null && /^-?\d+$/.test(String(code)) && Number(code) !== 0) ||
    payload?.is_error === true || payload?.isError === true || payload?.success === false ||
    (payload?.error != null && payload.error !== false && payload.error !== "");
}

function isCodexToolStatusSuccess(payload) {
  return payload?.exit_code === 0 || payload?.exit_code === "0" || payload?.success === true;
}

/** Shared status/output interpretation for transcript and metadata index. */
export function isCodexToolPayloadError(payload) {
  if (isCodexToolStatusError(payload)) return true;
  if (isCodexToolStatusSuccess(payload)) return false;
  return [payload?.output, payload?.aggregated_output, payload?.stdout, payload?.stderr].some(isCodexToolOutputError);
}
