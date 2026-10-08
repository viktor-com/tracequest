import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { parseClaude } from "../../src/parse/parse-claude.js";
import { rollupClaudeUsage } from "../../src/parse/parse-utils.js";
import { indexClaudeJsonl } from "../../src/sessions/session-index-jsonl.js";

const COMBINED_USAGE = {
  input_tokens: 100,
  output_tokens: 40,
  cache_read_input_tokens: 30,
  cache_creation_input_tokens: 20,
};

function writeAssistantSession(
  file,
  usage,
  { uuid = "a-parity", timestamp = "2026-06-03T12:00:00.000Z", content = [{ type: "text", text: "ok" }] } = {},
) {
  writeFileSync(
    file,
    `${JSON.stringify({
      type: "assistant",
      timestamp,
      uuid,
      message: { model: "claude-sonnet", usage, content },
    })}\n`,
    "utf8",
  );
}

function withSession(fn) {
  const tmpDir = mkdtempSync(join(os.tmpdir(), "tq-claude-rollup-"));
  const file = join(tmpDir, "session.jsonl");
  try {
    return fn(file);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Assert rollupClaudeUsage, parse-claude event tokens, and index-claude fields stay aligned. */
function assertTokenParity(file, usage, {
  rolled,
  indexInput,
  indexCacheRead,
  indexOutput,
  indexTotal,
  parseTotalInput,
  parseTotalOutput,
  parseTotalCacheHit,
}) {
  assert.deepEqual(rollupClaudeUsage(usage), rolled);

  const parsed = parseClaude(file);
  const ev = parsed.events.find((e) => e.type === "assistant");
  assert.ok(ev, "assistant event");
  assert.deepEqual(ev.tokens, rolled);
  assert.equal(parsed.stats.totalInputTokens, parseTotalInput);
  assert.equal(parsed.stats.totalOutputTokens, parseTotalOutput);
  assert.equal(parsed.stats.totalCacheHit, parseTotalCacheHit);

  const meta = indexClaudeJsonl(file);
  assert.equal(meta.inputTokens, indexInput);
  assert.equal(meta.cacheReadTokens, indexCacheRead);
  assert.equal(meta.outputTokens, indexOutput);
  assert.equal(meta.totalTokens, indexTotal);
  assert.equal(meta.inputTokens + meta.cacheReadTokens, parsed.stats.totalInputTokens);
  assert.equal(meta.cacheReadTokens, parsed.stats.totalCacheHit);
}

describe("Claude token rollup parity (parse-claude × index-claude)", () => {
  describe("rollupClaudeUsage shapes", () => {
    test("combined base + cache read + cache creation", () => {
      assert.deepEqual(rollupClaudeUsage(COMBINED_USAGE), {
        input: 150,
        output: 40,
        cacheHit: 30,
        cacheWrite: 20,
      });
    });

    test("cache read only (no base input, no creation)", () => {
      assert.deepEqual(
        rollupClaudeUsage({ output_tokens: 12, cache_read_input_tokens: 900 }),
        { input: 900, output: 12, cacheHit: 900, cacheWrite: 0 },
      );
    });

    test("cache creation only (no cache read)", () => {
      assert.deepEqual(
        rollupClaudeUsage({ input_tokens: 50, output_tokens: 8, cache_creation_input_tokens: 75 }),
        { input: 125, output: 8, cacheHit: 0, cacheWrite: 75 },
      );
    });

    test("base input only when cache fields absent", () => {
      assert.deepEqual(
        rollupClaudeUsage({ input_tokens: 512, output_tokens: 64 }),
        { input: 512, output: 64, cacheHit: 0, cacheWrite: 0 },
      );
    });

    test("cache read + creation with zero base input_tokens", () => {
      assert.deepEqual(
        rollupClaudeUsage({
          cache_read_input_tokens: 400,
          cache_creation_input_tokens: 60,
          output_tokens: 3,
        }),
        { input: 460, output: 3, cacheHit: 400, cacheWrite: 60 },
      );
    });

    test("empty or omitted usage object rolls up to zeros", () => {
      const zeros = { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 };
      assert.deepEqual(rollupClaudeUsage(), zeros);
      assert.deepEqual(rollupClaudeUsage({}), zeros);
    });

    test("explicit zero cache fields do not inflate input rollup", () => {
      assert.deepEqual(
        rollupClaudeUsage({
          input_tokens: 0,
          output_tokens: 9,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        }),
        { input: 0, output: 9, cacheHit: 0, cacheWrite: 0 },
      );
    });
  });

  describe("parse-claude × index-claude parity per usage shape", () => {
    test("combined usage matches rollup on event and session stats", () => {
      withSession((file) => {
        writeAssistantSession(file, COMBINED_USAGE);
        assertTokenParity(file, COMBINED_USAGE, {
          rolled: { input: 150, output: 40, cacheHit: 30, cacheWrite: 20 },
          indexInput: 120,
          indexCacheRead: 30,
          indexOutput: 40,
          indexTotal: 190,
          parseTotalInput: 150,
          parseTotalOutput: 40,
          parseTotalCacheHit: 30,
        });
      });
    });

    test("cache read only: index inputTokens excludes cache read bucket", () => {
      withSession((file) => {
        const usage = { input_tokens: 0, output_tokens: 12, cache_read_input_tokens: 900 };
        writeAssistantSession(file, usage);
        assertTokenParity(file, usage, {
          rolled: { input: 900, output: 12, cacheHit: 900, cacheWrite: 0 },
          indexInput: 0,
          indexCacheRead: 900,
          indexOutput: 12,
          indexTotal: 912,
          parseTotalInput: 900,
          parseTotalOutput: 12,
          parseTotalCacheHit: 900,
        });
      });
    });

    test("cache creation only: creation bills into index inputTokens", () => {
      withSession((file) => {
        const usage = { input_tokens: 50, output_tokens: 8, cache_creation_input_tokens: 75 };
        writeAssistantSession(file, usage);
        assertTokenParity(file, usage, {
          rolled: { input: 125, output: 8, cacheHit: 0, cacheWrite: 75 },
          indexInput: 125,
          indexCacheRead: 0,
          indexOutput: 8,
          indexTotal: 133,
          parseTotalInput: 125,
          parseTotalOutput: 8,
          parseTotalCacheHit: 0,
        });
      });
    });

    test("base input only: no cache split fields on index", () => {
      withSession((file) => {
        const usage = { input_tokens: 200, output_tokens: 25 };
        writeAssistantSession(file, usage);
        assertTokenParity(file, usage, {
          rolled: { input: 200, output: 25, cacheHit: 0, cacheWrite: 0 },
          indexInput: 200,
          indexCacheRead: 0,
          indexOutput: 25,
          indexTotal: 225,
          parseTotalInput: 200,
          parseTotalOutput: 25,
          parseTotalCacheHit: 0,
        });
      });
    });

    test("output-only usage (no input or cache) stays aligned", () => {
      withSession((file) => {
        const usage = { input_tokens: 0, output_tokens: 16 };
        writeAssistantSession(file, usage, { content: [] });
        assertTokenParity(file, usage, {
          rolled: { input: 0, output: 16, cacheHit: 0, cacheWrite: 0 },
          indexInput: 0,
          indexCacheRead: 0,
          indexOutput: 16,
          indexTotal: 16,
          parseTotalInput: 0,
          parseTotalOutput: 16,
          parseTotalCacheHit: 0,
        });
      });
    });

    test("solo empty usage {}: parse output floor estimate; index reports zero", () => {
      withSession((file) => {
        writeAssistantSession(file, {}, { content: [] });
        const parsed = parseClaude(file);
        const ev = parsed.events.find((e) => e.type === "assistant");
        assert.deepEqual(ev.tokens, {
          input: 0,
          output: 1,
          cacheHit: 0,
          cacheWrite: 0,
          estimated: true,
        });
        assert.equal(parsed.stats.totalOutputTokens, 1);
        assert.equal(parsed.stats.tokensEstimated, true);

        const meta = indexClaudeJsonl(file);
        assert.equal(meta.outputTokens, 0);
        assert.equal(meta.totalTokens, 0);
      });
    });

    test("user and tool_result lines between assistants do not affect token totals", () => {
      withSession((file) => {
        const u1 = { input_tokens: 11, output_tokens: 4 };
        const u2 = { input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 88 };
        writeFileSync(
          file,
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:00.000Z",
              uuid: "a1",
              message: { model: "claude-sonnet", usage: u1, content: [] },
            }),
            JSON.stringify({
              type: "user",
              timestamp: "2026-06-03T12:00:02.000Z",
              uuid: "u-mid",
              message: {
                content: [
                  { type: "tool_result", tool_use_id: "t1", content: "ok result" },
                ],
              },
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:05.000Z",
              uuid: "a2",
              message: { model: "claude-sonnet", usage: u2, content: [] },
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        const r1 = rollupClaudeUsage(u1);
        const r2 = rollupClaudeUsage(u2);
        const parsed = parseClaude(file);
        assert.equal(parsed.stats.totalInputTokens, r1.input + r2.input);
        assert.equal(parsed.stats.totalOutputTokens, r1.output + r2.output);
        assert.equal(parsed.stats.totalCacheHit, r1.cacheHit + r2.cacheHit);

        const meta = indexClaudeJsonl(file);
        assert.equal(meta.inputTokens, 11);
        assert.equal(meta.cacheReadTokens, 88);
        assert.equal(meta.outputTokens, 11);
        assert.equal(meta.inputTokens + meta.cacheReadTokens, parsed.stats.totalInputTokens);
      });
    });

    test("later assistant with empty usage does not re-estimate when earlier turn had output", () => {
      withSession((file) => {
        const billed = { input_tokens: 30, output_tokens: 6 };
        writeFileSync(
          file,
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:00.000Z",
              uuid: "billed",
              message: { model: "claude-sonnet", usage: billed, content: [] },
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:03.000Z",
              uuid: "empty-usage",
              message: { model: "claude-sonnet", usage: {}, content: [{ type: "text", text: "would estimate if alone" }] },
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        const parsed = parseClaude(file);
        const assistants = parsed.events.filter((e) => e.type === "assistant");
        assert.deepEqual(assistants[0].tokens, rollupClaudeUsage(billed));
        assert.deepEqual(assistants[1].tokens, { input: 0, output: 0, cacheHit: 0, cacheWrite: 0 });
        assert.equal(assistants[1].tokens.estimated, undefined);
        assert.equal(parsed.stats.totalOutputTokens, 6);

        const meta = indexClaudeJsonl(file);
        assert.equal(meta.outputTokens, 6);
        assert.equal(meta.inputTokens, 30);
      });
    });
  });

  describe("multi-turn accumulation", () => {
    test("two assistants sum parse stats and index totals consistently", () => {
      withSession((file) => {
        const u1 = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40 };
        const u2 = { input_tokens: 20, output_tokens: 8, cache_creation_input_tokens: 12 };
        writeFileSync(
          file,
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:00.000Z",
              uuid: "a1",
              message: { model: "claude-sonnet", usage: u1, content: [] },
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:05.000Z",
              uuid: "a2",
              message: { model: "claude-sonnet", usage: u2, content: [] },
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        const r1 = rollupClaudeUsage(u1);
        const r2 = rollupClaudeUsage(u2);
        const parsed = parseClaude(file);
        assert.equal(parsed.stats.totalInputTokens, r1.input + r2.input);
        assert.equal(parsed.stats.totalOutputTokens, r1.output + r2.output);
        assert.equal(parsed.stats.totalCacheHit, r1.cacheHit + r2.cacheHit);

        const meta = indexClaudeJsonl(file);
        assert.equal(meta.inputTokens, 10 + 20 + 12);
        assert.equal(meta.cacheReadTokens, 40);
        assert.equal(meta.outputTokens, 13);
        assert.equal(meta.inputTokens + meta.cacheReadTokens, parsed.stats.totalInputTokens);
        assert.equal(meta.totalTokens, 10 + 5 + 40 + 20 + 8 + 12);
      });
    });

    test("cache-hit-heavy then cache-write-heavy turns preserve per-event tokens", () => {
      withSession((file) => {
        const hitOnly = { input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: 1 };
        const writeOnly = { input_tokens: 5, cache_creation_input_tokens: 200, output_tokens: 2 };
        writeFileSync(
          file,
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:00.000Z",
              uuid: "hit",
              message: { model: "claude-sonnet", usage: hitOnly, content: [] },
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:01.000Z",
              uuid: "write",
              message: { model: "claude-sonnet", usage: writeOnly, content: [] },
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        const parsed = parseClaude(file);
        const assistants = parsed.events.filter((e) => e.type === "assistant");
        assert.deepEqual(assistants[0].tokens, rollupClaudeUsage(hitOnly));
        assert.deepEqual(assistants[1].tokens, rollupClaudeUsage(writeOnly));
        assert.equal(parsed.stats.totalCacheHit, 1000);

        const meta = indexClaudeJsonl(file);
        assert.equal(meta.cacheReadTokens, 1000);
        assert.equal(meta.inputTokens, 5 + 200);
      });
    });

    test("three heterogeneous turns sum parse stats and index buckets", () => {
      withSession((file) => {
        const baseOnly = { input_tokens: 100, output_tokens: 10 };
        const readOnly = { input_tokens: 0, output_tokens: 2, cache_read_input_tokens: 300 };
        const combined = {
          input_tokens: 5,
          output_tokens: 3,
          cache_read_input_tokens: 15,
          cache_creation_input_tokens: 25,
        };
        writeFileSync(
          file,
          [
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:00.000Z",
              uuid: "t1",
              message: { model: "claude-sonnet", usage: baseOnly, content: [] },
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:01.000Z",
              uuid: "t2",
              message: { model: "claude-sonnet", usage: readOnly, content: [] },
            }),
            JSON.stringify({
              type: "assistant",
              timestamp: "2026-06-03T12:00:02.000Z",
              uuid: "t3",
              message: { model: "claude-sonnet", usage: combined, content: [] },
            }),
          ].join("\n") + "\n",
          "utf8",
        );

        const rolls = [baseOnly, readOnly, combined].map(rollupClaudeUsage);
        const parsed = parseClaude(file);
        assert.equal(
          parsed.stats.totalInputTokens,
          rolls.reduce((n, r) => n + r.input, 0),
        );
        assert.equal(
          parsed.stats.totalOutputTokens,
          rolls.reduce((n, r) => n + r.output, 0),
        );
        assert.equal(
          parsed.stats.totalCacheHit,
          rolls.reduce((n, r) => n + r.cacheHit, 0),
        );

        const meta = indexClaudeJsonl(file);
        assert.equal(meta.inputTokens, 100 + 5 + 25);
        assert.equal(meta.cacheReadTokens, 300 + 15);
        assert.equal(meta.outputTokens, 15);
        assert.equal(meta.totalTokens, 100 + 10 + 300 + 2 + 5 + 3 + 15 + 25);
        assert.equal(meta.inputTokens + meta.cacheReadTokens, parsed.stats.totalInputTokens);
      });
    });
  });
});