export function minimalSession(overrides = {}) {
  return {
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    source: "claude",
    cwd: "/tmp/test",
    model: "claude-3-5-sonnet",
    startTime: "2026-01-01T00:00:00.000Z",
    endTime: "2026-01-01T00:01:00.000Z",
    durationMs: 60_000,
    eventCount: 1,
    events: [{ type: "user", text: "hello", timestamp: "2026-01-01T00:00:00.000Z" }],
    stats: {
      toolCounts: {},
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheHit: 0,
      errors: 0,
      userMessages: 1,
      assistantTurns: 0,
      tokensEstimated: false,
    },
    ...overrides,
  };
}

export function emptyCompareSession(overrides = {}) {
  return minimalSession({
    model: "",
    durationMs: 0,
    events: [],
    stats: {},
    _path: "/tmp/a.jsonl",
    ...overrides,
  });
}