import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildSession } from "../../src/parse/parse-session-build.js";
import { rollupClaudeUsage } from "../../src/parse/parse-utils.js";

const BASE = {
  sessionId: "sess-build",
  cwd: "/proj",
  model: "test-model",
  gitBranch: "main",
  source: "claude",
};

function session(events, overrides = {}) {
  return buildSession({ ...BASE, events, ...overrides });
}

describe("buildSession timing", () => {
  test("computes duration from earliest to latest valid timestamp", () => {
    const s = session([
      { type: "user", timestamp: "2026-01-01T10:00:00Z" },
      { type: "assistant", timestamp: "2026-01-01T10:01:00Z", text: "a", toolCalls: [] },
      { type: "tool_result", timestamp: "2026-01-01T10:01:05Z", isError: false },
    ]);
    assert.equal(s.durationMs, 65000);
    assert.equal(s.startTime, "2026-01-01T10:00:00.000Z");
    assert.equal(s.endTime, "2026-01-01T10:01:05.000Z");
  });

  test("uses min and max across out-of-order timestamps", () => {
    const s = session([
      { type: "user", timestamp: "2026-06-03T15:00:00.000Z" },
      { type: "assistant", timestamp: "2026-06-03T12:00:00.000Z", text: "x", toolCalls: [] },
      { type: "user", timestamp: "2026-06-03T18:00:00.000Z" },
    ]);
    assert.equal(s.startTime, "2026-06-03T12:00:00.000Z");
    assert.equal(s.endTime, "2026-06-03T18:00:00.000Z");
    assert.equal(s.durationMs, 6 * 60 * 60 * 1000);
  });

  test("ignores invalid timestamps for duration bounds", () => {
    const s = session([
      { type: "user", timestamp: "not-a-date", text: "x" },
      { type: "assistant", timestamp: "2026-01-01T12:00:00Z", text: "y", toolCalls: [] },
    ]);
    assert.equal(s.startTime, s.endTime);
    assert.equal(s.durationMs, 0);
  });

  test("empty events yield null start/end and zero duration", () => {
    const s = session([]);
    assert.equal(s.eventCount, 0);
    assert.equal(s.durationMs, 0);
    assert.equal(s.startTime, null);
    assert.equal(s.endTime, null);
  });

  test("events without timestamp do not affect timing", () => {
    const s = session([
      { type: "user", text: "no ts" },
      { type: "assistant", timestamp: "2026-06-03T12:00:00.000Z", text: "ok", toolCalls: [] },
    ]);
    assert.equal(s.startTime, s.endTime);
    assert.equal(s.durationMs, 0);
  });
});

describe("buildSession metadata", () => {
  test("copies sessionId, source, cwd, model, and gitBranch", () => {
    const s = session([{ type: "user", timestamp: "2026-06-03T12:00:00.000Z" }], {
      sessionId: "abc",
      cwd: "/x",
      model: "m",
      gitBranch: "dev",
      source: "grok",
    });
    assert.equal(s.sessionId, "abc");
    assert.equal(s.cwd, "/x");
    assert.equal(s.model, "m");
    assert.equal(s.gitBranch, "dev");
    assert.equal(s.source, "grok");
  });

  test("returns same events array reference and eventCount", () => {
    const events = [{ type: "user", timestamp: "2026-06-03T12:00:00.000Z" }];
    const s = session(events);
    assert.strictEqual(s.events, events);
    assert.equal(s.eventCount, 1);
  });
});

describe("buildSession token estimation", () => {
  test("estimates output tokens from text and toolCalls when all outputs are zero", () => {
    const events = [
      {
        type: "assistant",
        timestamp: "2026-06-03T12:00:00.000Z",
        text: "hello world",
        toolCalls: [{ id: "1", name: "Read", input: "/f" }],
        tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
      },
    ];
    const s = session(events);
    assert.ok(s.events[0].tokens.output > 0);
    assert.equal(s.events[0].tokens.estimated, true);
    assert.equal(s.stats.tokensEstimated, true);
  });

  test("estimates input tokens from matching tool_result text", () => {
    const events = [
      {
        type: "assistant",
        timestamp: "2026-06-03T12:00:00.000Z",
        text: "",
        toolCalls: [{ id: "tc-1", name: "Bash", input: "ls" }],
        tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
      },
      {
        type: "tool_result",
        timestamp: "2026-06-03T12:00:01.000Z",
        toolUseId: "tc-1",
        text: "x".repeat(40),
        isError: false,
      },
    ];
    const s = session(events);
    assert.equal(s.events[0].tokens.input, 10);
  });

  test("does not estimate when any assistant has positive output tokens", () => {
    const events = [
      {
        type: "assistant",
        timestamp: "2026-06-03T12:00:00.000Z",
        text: "has usage",
        toolCalls: [],
        tokens: { input: 5, output: 3, cacheHit: 0, cacheWrite: 0 },
      },
      {
        type: "assistant",
        timestamp: "2026-06-03T12:00:05.000Z",
        text: "no usage row",
        toolCalls: [],
        tokens: { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 },
      },
    ];
    const s = session(events);
    assert.equal(s.events[1].tokens.estimated, undefined);
    assert.equal(s.stats.tokensEstimated, false);
  });

  test("creates tokens object on assistant missing tokens", () => {
    const events = [
      {
        type: "assistant",
        timestamp: "2026-06-03T12:00:00.000Z",
        text: "x",
        toolCalls: [],
      },
    ];
    const s = session(events);
    assert.deepEqual(s.events[0].tokens, {
      input: 0,
      output: 1,
      cacheHit: 0,
      cacheWrite: 0,
      estimated: true,
    });
  });

  test("skips estimation when no assistant events exist", () => {
    const s = session([
      { type: "user", timestamp: "2026-06-03T12:00:00.000Z", text: "hi" },
    ]);
    assert.equal(s.stats.tokensEstimated, false);
    assert.equal(s.stats.assistantTurns, 0);
  });
});

describe("buildSession stats", () => {
  test("aggregates user messages, assistant turns, and tool counts", () => {
    const s = session([
      { type: "user", timestamp: "2026-06-03T12:00:00.000Z" },
      { type: "user", timestamp: "2026-06-03T12:00:01.000Z" },
      {
        type: "assistant",
        timestamp: "2026-06-03T12:00:02.000Z",
        toolCalls: [
          { id: "a", name: "Read", input: "" },
          { id: "b", name: "Bash", input: "" },
          { id: "c", name: "Read", input: "" },
        ],
        tokens: { input: 1, output: 2, cacheHit: 0, cacheWrite: 0 },
      },
    ]);
    assert.equal(s.stats.userMessages, 2);
    assert.equal(s.stats.assistantTurns, 1);
    assert.deepEqual(s.stats.toolCounts, { Read: 2, Bash: 1 });
  });

  test("sums token fields and cache hit across assistants", () => {
    const t1 = rollupClaudeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 });
    const t2 = rollupClaudeUsage({ input_tokens: 20, output_tokens: 8, cache_read_input_tokens: 3 });
    const s = session([
      { type: "assistant", timestamp: "2026-06-03T12:00:00.000Z", toolCalls: [], tokens: t1 },
      { type: "assistant", timestamp: "2026-06-03T12:00:05.000Z", toolCalls: [], tokens: t2 },
    ]);
    assert.equal(s.stats.totalInputTokens, 35);
    assert.equal(s.stats.totalOutputTokens, 13);
    assert.equal(s.stats.totalCacheHit, 5);
  });

  test("counts tool_result errors only when isError is true", () => {
    const s = session([
      { type: "tool_result", timestamp: "2026-06-03T12:00:00.000Z", isError: true },
      { type: "tool_result", timestamp: "2026-06-03T12:00:01.000Z", isError: false },
      { type: "tool_result", timestamp: "2026-06-03T12:00:02.000Z", isError: true },
    ]);
    assert.equal(s.stats.errors, 2);
  });

  test("assistant without toolCalls does not throw and yields empty toolCounts", () => {
    const s = session([
      { type: "assistant", timestamp: "2026-06-03T12:00:00.000Z", tokens: { input: 0, output: 1, cacheHit: 0, cacheWrite: 0 } },
    ]);
    assert.deepEqual(s.stats.toolCounts, {});
  });
});