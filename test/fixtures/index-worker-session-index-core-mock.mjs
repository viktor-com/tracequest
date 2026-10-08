/** Lightweight stand-in for session-index-core when testing index-worker spawn. */
export function indexSession(session) {
  return {
    firstPrompt: `mock-${pathBasename(session.path)}`,
    model: null,
    tools: [],
    toolCounts: {},
    chapters: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    durationMs: 0,
    errors: 0,
    files: 0,
    commits: 0,
  };
}

function pathBasename(p) {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}