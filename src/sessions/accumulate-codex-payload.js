import { normalizeToolName } from "../parse/parse-enrich.js";
import { visitCodexEventMsgPayload } from "../parse/codex-event-msg.js";
import { isCodexToolPayloadError, visitCodexResponseItemPayload } from "../parse/codex-response-item.js";
import { parseToolArgs } from "../parse/parse-utils.js";
import { trackIndexTool } from "./session-meta.js";

const GIT_COMMIT_RE = /\bgit\b.*\bcommit\b/i;

function accumulateCodexFunctionCall(name, argumentsRaw, filePath, state) {
  const tn = normalizeToolName(name);
  trackIndexTool(state, tn);
  state.toolCounts[tn] = (state.toolCounts[tn] || 0) + 1;
  const args = parseToolArgs(argumentsRaw, `indexCodex ${filePath}`);
  const fp = args?.file_path || args?.path;
  if (fp) state.files.add(fp);
  if (tn === "Bash" && GIT_COMMIT_RE.test(args?.command || "")) state.commits++;
}

/** Index stats for assistant `content[]` function_call blocks (same rules as payload-level calls). */
export function accumulateCodexContentFunctionCall(block, filePath, state) {
  if (block?.type !== "function_call" || !block.name) return;
  accumulateCodexFunctionCall(block.name, block.arguments, filePath, state);
}

/** Set index token totals from latest Codex session usage (not per-turn turn_context sums). */
export function accumulateCodexTokenCount(info, state) {
  const u = info?.total_token_usage || info?.last_token_usage;
  if (!u) return;
  const inTok = u.input_tokens || 0;
  const outTok = u.output_tokens || 0;
  const cache = u.cached_input_tokens || 0;
  state.inputTokens = inTok;
  state.outputTokens = outTok;
  state.cacheReadTokens = cache;
  state.totalTokens = inTok + outTok;
  state.sawTokenCountTotal = true;
}

export function accumulateCodexEventMsgPayload(payload, state) {
  visitCodexEventMsgPayload(payload, {
    onTokenCount(p) {
      accumulateCodexTokenCount(p.info, state);
    },
    onPatchApplyEnd(p) {
      trackIndexTool(state, "Edit");
      state.toolCounts["Edit"] = (state.toolCounts["Edit"] || 0) + 1;
      if (p.path) state.files.add(p.path);
      if (isCodexToolPayloadError(p)) state.errors++;
    },
    onExecCommandEnd(p) {
      trackIndexTool(state, "Bash");
      state.toolCounts["Bash"] = (state.toolCounts["Bash"] || 0) + 1;
      if (isCodexToolPayloadError(p)) state.errors++;
      if (GIT_COMMIT_RE.test(p.command || "")) state.commits++;
    },
    onWebSearchEnd() {
      trackIndexTool(state, "WebSearch");
      state.toolCounts["WebSearch"] = (state.toolCounts["WebSearch"] || 0) + 1;
    },
  });
}

export function accumulateCodexResponseItemPayload(p, filePath, state) {
  visitCodexResponseItemPayload(p, {
    onFunctionCall(payload) {
      accumulateCodexFunctionCall(payload.name, payload.arguments, filePath, state);
    },
    onFunctionCallOutput(payload) {
      if (isCodexToolPayloadError(payload)) state.errors++;
    },
    onCustomToolCallOutput(payload) {
      if (isCodexToolPayloadError(payload)) state.errors++;
    },
    onCustomToolCall(payload) {
      const tn = normalizeToolName(payload.name);
      trackIndexTool(state, tn);
      state.toolCounts[tn] = (state.toolCounts[tn] || 0) + 1;
    },
    onWebSearchCall() {
      trackIndexTool(state, "WebSearch");
      state.toolCounts["WebSearch"] = (state.toolCounts["WebSearch"] || 0) + 1;
    },
  });
}