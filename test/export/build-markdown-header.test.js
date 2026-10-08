import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildMarkdownHeader } from "../../src/export/markdown-export.js";

const MARKDOWN_EXPORT_JS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../src/export/markdown-export.js"),
  "utf8",
);
import { joinMarkdownHeader, markdownHeaderStats } from "./markdown-header-test-helpers.js";

describe("buildMarkdownHeader", () => {
  test("returns lines array with title, optional meta, summary, and trailing blank", () => {
    const lines = buildMarkdownHeader({
      sessionId: "abcdef12-rest",
      model: "claude-sonnet",
      stats: markdownHeaderStats(),
    });
    assert.ok(Array.isArray(lines));
    assert.equal(lines[0], "# Session abcdef12");
    assert.equal(lines[1], "");
    assert.equal(lines.at(-1), "");
    const md = lines.join("\n");
    const summaryIdx = md.indexOf("## Summary");
    const titleIdx = md.indexOf("# Session");
    assert.ok(titleIdx < summaryIdx);
    assert.match(md, /\*\*Prompts:\*\* 1/);
  });

  test("truncates sessionId to eight characters", () => {
    const md = joinMarkdownHeader({
      sessionId: "019e47cd-151a-75d1-8f42-53efb31db13f",
      stats: markdownHeaderStats(),
    });
    assert.match(md, /^# Session 019e47cd\n/);
    assert.doesNotMatch(md, /019e47cd-151a/);
  });

  test("uses unknown title when sessionId is null, empty, or missing", () => {
    for (const id of [null, undefined, ""]) {
      const md = joinMarkdownHeader({ sessionId: id, stats: markdownHeaderStats() });
      assert.match(md, /^# Session unknown/);
    }
  });

  test("uses unknown title when sessionId property is absent", () => {
    const md = joinMarkdownHeader({ stats: markdownHeaderStats() });
    assert.match(md, /^# Session unknown\n\n## Summary/);
    assert.doesNotMatch(md, /\*\*Model:\*\*/);
  });

  test("null stats renders zeroed summary without throwing", () => {
    const md = joinMarkdownHeader({ sessionId: "nullstat", stats: null });
    assert.match(md, /^# Session nullstat/);
    assert.match(md, /\*\*Prompts:\*\* 0/);
    assert.match(md, /\*\*Turns:\*\* 0/);
    assert.match(md, /\*\*Tool calls:\*\* 0/);
    assert.doesNotMatch(md, /\*\*Tokens:\*\*/);
    assert.doesNotMatch(md, /\*\*Errors:\*\*/);
  });

  test("missing stats property renders zeroed summary without throwing", () => {
    const md = joinMarkdownHeader({ sessionId: "nostats" });
    assert.match(md, /^# Session nostats/);
    assert.match(md, /\*\*Prompts:\*\* 0/);
    assert.match(md, /\*\*Turns:\*\* 0/);
    assert.match(md, /\*\*Tool calls:\*\* 0/);
    assert.doesNotMatch(md, /\*\*Tokens:\*\*/);
  });

  test("renders full metadata row when all optional session fields present", () => {
    const md = joinMarkdownHeader({
      sessionId: "meta0001",
      model: "claude-opus-4",
      source: "claude",
      startTime: "2026-06-01T12:00:00.000Z",
      durationMs: 90_000,
      cwd: "/home/user/proj",
      gitBranch: "feat/export",
      stats: markdownHeaderStats({ totalInputTokens: 10_000, totalOutputTokens: 2_000 }),
    });
    assert.match(md, /\*\*Model:\*\* claude-opus-4/);
    assert.match(md, /\*\*Source:\*\* claude/);
    assert.match(md, /\*\*Date:\*\*/);
    assert.match(md, /\*\*Duration:\*\* 1m 30s/);
    assert.match(md, /\*\*Working directory:\*\* `\/home\/user\/proj`/);
    assert.match(md, /\*\*Branch:\*\* `feat\/export`/);
    assert.match(md, /\*\*Estimated cost:\*\*/);
    assert.match(md, /\*\*Model:\*\*.*  \n\*\*Source:\*\*/);
  });

  test("omits metadata block when no optional session fields", () => {
    const md = joinMarkdownHeader({ stats: markdownHeaderStats() });
    assert.match(md, /^# Session unknown\n\n## Summary/);
    assert.doesNotMatch(md, /\*\*Model:\*\*/);
    assert.doesNotMatch(md, /\*\*Duration:\*\*/);
    assert.doesNotMatch(md, /\*\*Estimated cost:\*\*/);
  });

  test("omits duration for zero or negative durationMs", () => {
    for (const durationMs of [0, -1, undefined]) {
      const md = joinMarkdownHeader({
        sessionId: "nodur",
        model: "claude-sonnet",
        durationMs,
        stats: markdownHeaderStats(),
      });
      assert.doesNotMatch(md, /\*\*Duration:\*\*/);
    }
  });

  test("formats sub-second duration as < 1s", () => {
    const md = joinMarkdownHeader({
      sessionId: "subsec",
      durationMs: 500,
      stats: markdownHeaderStats(),
    });
    assert.match(md, /\*\*Duration:\*\* < 1s/);
  });

  test("formats large token counts and includes in/out breakdown", () => {
    const md = joinMarkdownHeader({
      sessionId: "tokbig",
      stats: markdownHeaderStats({
        totalInputTokens: 2_500_000,
        totalOutputTokens: 42_000,
      }),
    });
    assert.match(md, /\*\*Tokens:\*\* 2\.5M \(2\.5M in, 42K out\)/);
    assert.doesNotMatch(md, /\*\*Cache hit:\*\*/);
  });

  test("omits token line when combined tokens are zero", () => {
    const md = joinMarkdownHeader({
      sessionId: "notok",
      stats: markdownHeaderStats({ totalInputTokens: 0, totalOutputTokens: 0 }),
    });
    assert.doesNotMatch(md, /\*\*Tokens:\*\*/);
  });

  test("cache hit percent is rounded from cache over input tokens", () => {
    const md = joinMarkdownHeader({
      sessionId: "cache1",
      stats: markdownHeaderStats({
        totalInputTokens: 1000,
        totalOutputTokens: 100,
        totalCacheHit: 333,
      }),
    });
    assert.match(md, /\*\*Cache hit:\*\* 33%/);
  });

  test("omits cache hit when cache or input tokens are zero", () => {
    const noCache = joinMarkdownHeader({
      sessionId: "nocache",
      stats: markdownHeaderStats({ totalInputTokens: 1000, totalCacheHit: 0 }),
    });
    assert.doesNotMatch(noCache, /\*\*Cache hit:\*\*/);

    const noInput = joinMarkdownHeader({
      sessionId: "noinput",
      stats: markdownHeaderStats({ totalInputTokens: 0, totalCacheHit: 500 }),
    });
    assert.doesNotMatch(noInput, /\*\*Cache hit:\*\*/);
  });

  test("omits errors line when stats.errors is zero", () => {
    const md = joinMarkdownHeader({
      sessionId: "noerr",
      stats: markdownHeaderStats({ errors: 0 }),
    });
    assert.doesNotMatch(md, /\*\*Errors:\*\*/);
  });

  test("includes errors count when stats.errors is positive", () => {
    const md = joinMarkdownHeader({
      sessionId: "err1",
      stats: markdownHeaderStats({ errors: 3 }),
    });
    assert.match(md, /\*\*Errors:\*\* 3/);
  });

  test("buildMarkdownHeader sorts toolCounts via Object.keys without Object.entries alloc", () => {
    assert.ok(!MARKDOWN_EXPORT_JS.includes("Object.entries(toolCounts)"));
  });

  test("tool calls sum all toolCounts and list tools sorted by count descending", () => {
    const md = joinMarkdownHeader({
      sessionId: "tools1",
      stats: markdownHeaderStats({
        toolCounts: { Read: 1, Bash: 5, Edit: 2 },
      }),
    });
    assert.match(md, /\*\*Tool calls:\*\* 8/);
    const toolsLine = md.match(/\*\*Tools:\*\* (.+)/)?.[1] ?? "";
    assert.ok(toolsLine.startsWith("Bash (5)"));
    assert.ok(toolsLine.indexOf("Edit (2)") < toolsLine.indexOf("Read (1)"));
  });

  test("formats MCP tool names in tools summary via fmtMcpName", () => {
    const md = joinMarkdownHeader({
      sessionId: "mcpfmt",
      stats: markdownHeaderStats({
        toolCounts: { mcp__docs_srv__fetch_page: 2, Bash: 1 },
      }),
    });
    assert.match(md, /\*\*Tools:\*\* docs srv: fetch page \(2\), Bash \(1\)/);
  });

  test("zero prompts, turns, and tool calls without throwing", () => {
    const md = joinMarkdownHeader({
      sessionId: "zeros",
      stats: markdownHeaderStats({ userMessages: 0, assistantTurns: 0, toolCounts: {} }),
    });
    assert.match(md, /\*\*Prompts:\*\* 0/);
    assert.match(md, /\*\*Turns:\*\* 0/);
    assert.match(md, /\*\*Tool calls:\*\* 0/);
    assert.doesNotMatch(md, /\*\*Tools:\*\*/);
    assert.doesNotMatch(md, /\*\*Errors:\*\*/);
  });

  test("estimated cost appears with tokens using default rates when model absent", () => {
    const md = joinMarkdownHeader({
      sessionId: "defcost",
      stats: markdownHeaderStats({ totalInputTokens: 50_000, totalOutputTokens: 10_000 }),
    });
    assert.match(md, /\*\*Estimated cost:\*\* ~\$/);
    assert.doesNotMatch(md, /\*\*Model:\*\*/);
  });

  test("estimated cost omitted when token totals are zero", () => {
    const md = joinMarkdownHeader({
      sessionId: "zerocost",
      model: "claude-sonnet",
      stats: markdownHeaderStats(),
    });
    assert.doesNotMatch(md, /\*\*Estimated cost:\*\*/);
  });
});