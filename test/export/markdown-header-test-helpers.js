import { buildMarkdownHeader } from "../../src/export/markdown-export.js";

/** Default stats shape for buildMarkdownHeader unit tests (zero tokens unless overridden). */
export function markdownHeaderStats(overrides = {}) {
  return {
    userMessages: 1,
    assistantTurns: 1,
    toolCounts: {},
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheHit: 0,
    errors: 0,
    ...overrides,
  };
}

export function joinMarkdownHeader(session) {
  return buildMarkdownHeader(session).join("\n");
}