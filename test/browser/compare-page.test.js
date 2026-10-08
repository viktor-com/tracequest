import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { comparePage } from "../../src/browser/compare-page.js";
import { STANDALONE_BASE_CSS } from "../../src/render/render-css.js";
import {
  COMPARE_METRIC_LABELS,
  GRADE_COLUMN_LABELS,
} from "../../src/chapters/compare-metrics.js";
import { emptyCompareSession } from "../helpers/minimal-session.js";

describe("comparePage document shell", () => {
  test("embeds shared base CSS once and compare-specific rules", () => {
    const html = comparePage(emptyCompareSession(), emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    assert.equal((html.match(/:root\s*\{/g) || []).length, 1);
    assert.ok(html.includes(STANDALONE_BASE_CSS.trim().slice(0, 40)));
    assert.match(html, /\.cmp-session/);
    assert.match(html, /session comparison/);
    assert.match(html, /cmp-col-b/);
    assert.match(html, /bbbbbbbb/);
  });

  test("renders session A and session B cards with labels", () => {
    const html = comparePage(emptyCompareSession(), emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    assert.match(html, /session-a/);
    assert.match(html, /session-b/);
    assert.match(html, /session A/);
    assert.match(html, /session B/);
    assert.match(html, /view full session/);
  });

  test("escapes HTML in session prompts", () => {
    const html = comparePage(
      emptyCompareSession({ events: [{ type: "user", text: "<script>alert(1)</script>" }] }),
      emptyCompareSession({ sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", _path: "/tmp/b.jsonl" }),
    );
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  });
});

describe("comparePage metrics table", () => {
  test("includes all compare metric row labels", () => {
    const html = comparePage(emptyCompareSession(), emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    for (const label of COMPARE_METRIC_LABELS) {
      assert.match(html, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });

  test("grade columns (clean, corrected, struggling) appear in metrics table", () => {
    const html = comparePage(emptyCompareSession(), emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    for (const label of GRADE_COLUMN_LABELS) {
      assert.match(html, new RegExp(`cmp-label">${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}<`));
    }
  });

  test("metric deltas highlight better side when values differ", () => {
    const html = comparePage(
      emptyCompareSession({
        stats: { errors: 0, totalInputTokens: 100, toolCounts: { Bash: 10, Read: 1 } },
        durationMs: 1000,
        events: [{ type: "user", text: "fix the compare page extraction please" }],
      }),
      emptyCompareSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        stats: { errors: 5, totalInputTokens: 500, toolCounts: { Bash: 2, Grep: 8 } },
        durationMs: 9000,
        _path: "/tmp/b.jsonl",
      }),
    );
    assert.match(html, /delta-good/);
    assert.match(html, /delta-bad/);
    assert.match(html, />0</);
    assert.match(html, />5</);
    assert.match(html, /compare page/);
  });

  test("equal numeric metrics omit delta-good and delta-bad on that row", () => {
    const same = emptyCompareSession({
      stats: { errors: 2, totalInputTokens: 100, totalOutputTokens: 50, toolCounts: { Read: 1 } },
      durationMs: 5000,
    });
    const html = comparePage(same, { ...same, sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", _path: "/tmp/b.jsonl" });
    const errorsRow = html.match(/cmp-val[^>]*>2<\/td>\s*<td class="cmp-label">Errors<\/td>\s*<td class="cmp-val[^>]*>2<\/td>/);
    assert.ok(errorsRow, "Errors row should show matching values");
    const rowSnippet = html.slice(html.indexOf('cmp-label">Errors'), html.indexOf('cmp-label">Errors') + 200);
    assert.doesNotMatch(rowSnippet, /delta-good/);
    assert.doesNotMatch(rowSnippet, /delta-bad/);
  });

  test("zero chapters show 0 in Chapters metric with empty outcome bars", () => {
    const html = comparePage(emptyCompareSession(), emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    assert.match(html, /cmp-label">Chapters<\/td>/);
    assert.match(html, /0 chapters\)/);
    assert.doesNotMatch(html, /cmp-outcome-seg clean" style="width:/);
    assert.doesNotMatch(html, /cmp-outcome-seg corrected" style="width:/);
    assert.doesNotMatch(html, /cmp-outcome-seg struggling" style="width:/);
  });
});

describe("comparePage tool usage", () => {
  test("tool comparison rows and bar markup render for mixed tools", () => {
    const html = comparePage(
      emptyCompareSession({ stats: { toolCounts: { Bash: 10, Read: 1 } } }),
      emptyCompareSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        stats: { toolCounts: { Bash: 2, Grep: 8 } },
        _path: "/tmp/b.jsonl",
      }),
    );
    assert.match(html, /tool-cmp-row/);
    assert.match(html, /tool-cmp-bar/);
    assert.match(html, /Bash/);
    assert.match(html, /Grep/);
    assert.match(html, /Tool usage/);
  });

  test("formats mcp__ tool names for display", () => {
    const html = comparePage(
      emptyCompareSession({ stats: { toolCounts: { "mcp__my_srv__search": 3 } } }),
      emptyCompareSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        stats: { toolCounts: {} },
        _path: "/tmp/b.jsonl",
      }),
    );
    assert.match(html, /tool-cmp-name/);
    assert.doesNotMatch(html, /mcp__my_srv__search/);
  });

  test("empty tool counts still render tool usage section without data rows", () => {
    const html = comparePage(emptyCompareSession(), emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    assert.match(html, /Tool usage/);
    assert.equal((html.match(/class="tool-cmp-row"/g) || []).length, 0);
  });
});

describe("comparePage chapter quality", () => {
  test("chapter quality segments render when chapters exist", () => {
    const session = emptyCompareSession({
      source: "grok",
      model: "grok-build",
      durationMs: 5000,
      events: [
        { type: "user", text: "one", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "assistant", text: "ok", timestamp: "2026-01-01T00:00:10.000Z", toolCalls: [] },
        { type: "user", text: "two", timestamp: "2026-01-01T00:01:00.000Z" },
        { type: "assistant", text: "done", timestamp: "2026-01-01T00:01:10.000Z", toolCalls: [] },
      ],
      stats: {
        assistantTurns: 2,
        toolCounts: { Bash: 1 },
        totalInputTokens: 100,
        totalOutputTokens: 50,
        errors: 0,
      },
    });
    const html = comparePage(session, emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    assert.match(html, /cmp-outcome-seg/);
    assert.match(html, /chapter quality/i);
    assert.match(html, / clean</);
    assert.match(html, / corrected</);
    assert.match(html, / struggling</);
  });

  test("grade column values reflect outcome counts in metrics", () => {
    const struggling = emptyCompareSession({
      events: [
        { type: "user", text: "run tests", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          text: "trying",
          timestamp: "2026-01-01T00:00:05.000Z",
          toolCalls: [
            { id: "b1", name: "Bash", input: "false" },
            { id: "b2", name: "Bash", input: "false" },
            { id: "b3", name: "Bash", input: "false" },
          ],
        },
        { type: "tool_result", toolUseId: "b1", text: "e1", isError: true, timestamp: "2026-01-01T00:00:01.000Z" },
        { type: "tool_result", toolUseId: "b2", text: "e2", isError: true, timestamp: "2026-01-01T00:00:02.000Z" },
        { type: "tool_result", toolUseId: "b3", text: "e3", isError: true, timestamp: "2026-01-01T00:00:03.000Z" },
      ],
      stats: { assistantTurns: 1, errors: 3, toolCounts: { Bash: 3 } },
    });
    const clean = emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      events: [
        { type: "user", text: "ok", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "assistant", text: "done", timestamp: "2026-01-01T00:00:01.000Z", toolCalls: [] },
      ],
      stats: { assistantTurns: 1, errors: 0, toolCounts: {} },
      _path: "/tmp/b.jsonl",
    });
    const html = comparePage(struggling, clean);
    const strugglingRow = html.match(
      /cmp-val[^>]*>(\d+)<\/td>\s*<td class="cmp-label">Struggling chapters<\/td>\s*<td class="cmp-val[^>]*>(\d+)<\/td>/,
    );
    assert.ok(strugglingRow);
    assert.equal(Number(strugglingRow[1]), 1);
    assert.equal(Number(strugglingRow[2]), 0);
    const cleanRow = html.match(
      /cmp-val[^>]*>(\d+)<\/td>\s*<td class="cmp-label">Clean chapters<\/td>\s*<td class="cmp-val[^>]*>(\d+)<\/td>/,
    );
    assert.ok(cleanRow);
    assert.equal(Number(cleanRow[1]), 0);
    assert.equal(Number(cleanRow[2]), 1);
  });

  test("higher clean count marks session A delta-good on Clean chapters row", () => {
    const manyClean = emptyCompareSession({
      events: [
        { type: "user", text: "a", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "assistant", text: "1", timestamp: "2026-01-01T00:00:01.000Z", toolCalls: [] },
        { type: "user", text: "b", timestamp: "2026-01-01T00:01:00.000Z" },
        { type: "assistant", text: "2", timestamp: "2026-01-01T00:01:01.000Z", toolCalls: [] },
      ],
      stats: { assistantTurns: 2, toolCounts: {} },
    });
    const oneClean = emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      events: [
        { type: "user", text: "only", timestamp: "2026-01-01T00:00:00.000Z" },
        { type: "assistant", text: "x", timestamp: "2026-01-01T00:00:01.000Z", toolCalls: [] },
      ],
      stats: { assistantTurns: 1, toolCounts: {} },
      _path: "/tmp/b.jsonl",
    });
    const html = comparePage(manyClean, oneClean);
    const idx = html.indexOf('cmp-label">Clean chapters');
    const row = html.slice(idx - 80, idx + 120);
    assert.match(row, /delta-good/);
  });
});

describe("comparePage navigation", () => {
  test("view links encode session path and non-claude source", () => {
    const html = comparePage(
      emptyCompareSession({ _path: "/data/sess a.jsonl", source: "codex" }),
      emptyCompareSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        _path: "/tmp/b.jsonl",
        source: "claude",
      }),
    );
    assert.match(html, /href="\/view\?path=%2Fdata%2Fsess%20a\.jsonl&source=codex"/);
    assert.match(html, /href="\/view\?path=%2Ftmp%2Fb\.jsonl"/);
    assert.doesNotMatch(html, /href="[^"]*source=claude/);
  });

  test("source badge uses palette color for cursor", () => {
    const html = comparePage(
      emptyCompareSession({ source: "cursor", events: [{ type: "user", text: "hi" }] }),
      emptyCompareSession({ sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", _path: "/tmp/b.jsonl" }),
    );
    assert.match(html, /#c4e86b/);
    assert.match(html, />cursor</);
  });
});
