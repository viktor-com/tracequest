import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  COMPARE_METRIC_LABELS,
  GRADE_COLUMN_LABELS,
  summarizeCompareSession,
  buildCompareMetricRows,
  buildCompareToolRows,
  buildSessionCardHtml,
  buildMetricTableHtml,
  buildToolComparisonHtml,
  compareViewUrl,
} from "../../src/chapters/compare-metrics.js";
import { buildSessionChapters } from "../../src/chapters/session-chapters.js";
import { summarizeChapterQuality } from "../../src/chapters/chapter-quality.js";
import { estimateParsedStatsCost } from "../../src/filter/filter-formats.js";
import { emptyCompareSession } from "../helpers/minimal-session.js";

function mockQuality(overrides = {}) {
  return {
    chapters: 0,
    retries: 0,
    clean: 0,
    corrected: 0,
    struggling: 0,
    files: 0,
    commits: 0,
    ...overrides,
  };
}

/** Minimal summarizeCompareSession-shaped object for row builder tests. */
function mockSummary(overrides = {}) {
  const quality = mockQuality(overrides.quality);
  const { quality: _q, ...rest } = overrides;
  return {
    id: "aaaaaaaa",
    source: "claude",
    model: "",
    durationMs: 0,
    turns: 0,
    totalToolCalls: 0,
    toolCounts: {},
    inputTokens: 0,
    outputTokens: 0,
    cacheHit: 0,
    totalTokens: 0,
    errors: 0,
    cost: 0,
    quality,
    chapters: quality.chapters,
    retries: quality.retries,
    clean: quality.clean,
    corrected: quality.corrected,
    struggling: quality.struggling,
    files: quality.files,
    commits: quality.commits,
    ...rest,
  };
}

function rowByLabel(rows, label) {
  const row = rows.find((r) => r[0] === label);
  assert.ok(row, `missing row: ${label}`);
  return row;
}

/** Mirrors compare-page delta winner logic (lower/higher pref, skip ties). */
function deltaWinner(row) {
  const [, , , pref, rawA, rawB] = row;
  if (pref === "none" || rawA == null || rawB == null || rawA === rawB) {
    return null;
  }
  const aWins = pref === "lower" ? rawA < rawB : rawA > rawB;
  return aWins ? "a" : "b";
}

describe("compare-metrics constants", () => {
  test("COMPARE_METRIC_LABELS includes all grade columns", () => {
    for (const label of GRADE_COLUMN_LABELS) {
      assert.ok(COMPARE_METRIC_LABELS.includes(label));
    }
    assert.equal(COMPARE_METRIC_LABELS.length, 16);
  });

  test("GRADE_COLUMN_LABELS are exactly the last three quality metrics", () => {
    const tail = COMPARE_METRIC_LABELS.slice(-3);
    assert.deepEqual(tail, [...GRADE_COLUMN_LABELS]);
  });

  test("row labels match COMPARE_METRIC_LABELS with no duplicates", () => {
    const rows = buildCompareMetricRows(mockSummary(), mockSummary({ id: "bbbbbbbb" }));
    const labels = rows.map((r) => r[0]);
    assert.deepEqual(labels, COMPARE_METRIC_LABELS);
    assert.equal(new Set(labels).size, labels.length);
  });

  test("every COMPARE_METRIC_LABEL appears exactly once in built rows", () => {
    const rows = buildCompareMetricRows(mockSummary({ turns: 1 }), mockSummary({ turns: 2 }));
    for (const label of COMPARE_METRIC_LABELS) {
      assert.equal(rows.filter((r) => r[0] === label).length, 1, label);
    }
  });

  test("GRADE_COLUMN_LABELS are only clean/corrected/struggling keys", () => {
    assert.deepEqual(GRADE_COLUMN_LABELS, [
      "Clean chapters",
      "Corrected chapters",
      "Struggling chapters",
    ]);
    const nonGrade = COMPARE_METRIC_LABELS.filter((l) => !GRADE_COLUMN_LABELS.includes(l));
    assert.ok(nonGrade.includes("Retries"));
    assert.ok(nonGrade.includes("Files touched"));
    assert.ok(nonGrade.includes("Commits"));
  });
});

describe("summarizeCompareSession", () => {
  test("empty session applies defaults for id, source, counters, and prompt", () => {
    const summary = summarizeCompareSession(emptyCompareSession());

    assert.equal(summary.id, "aaaaaaaa");
    assert.equal(summary.source, "claude");
    assert.equal(summary.model, "");
    assert.equal(summary.durationMs, 0);
    assert.equal(summary.turns, 0);
    assert.equal(summary.totalToolCalls, 0);
    assert.deepEqual(summary.toolCounts, {});
    assert.equal(summary.inputTokens, 0);
    assert.equal(summary.outputTokens, 0);
    assert.equal(summary.cacheHit, 0);
    assert.equal(summary.totalTokens, 0);
    assert.equal(summary.errors, 0);
    assert.equal(summary.cost, 0);
    assert.equal(summary.cwd, "/tmp/test");
    assert.equal(summary.prompt, "");
    assert.deepEqual(summary.quality, mockQuality());
  });

  test("missing sessionId yields id session", () => {
    const summary = summarizeCompareSession(emptyCompareSession({ sessionId: undefined }));
    assert.equal(summary.id, "session");
  });

  test("passes through source, model, cwd, and durationMs", () => {
    const summary = summarizeCompareSession(
      emptyCompareSession({
        source: "codex",
        model: "gpt-4.1",
        cwd: "/tmp/proj",
        durationMs: 42_000,
      }),
    );
    assert.equal(summary.source, "codex");
    assert.equal(summary.model, "gpt-4.1");
    assert.equal(summary.cwd, "/tmp/proj");
    assert.equal(summary.durationMs, 42_000);
  });

  test("sums toolCounts into totalToolCalls", () => {
    const summary = summarizeCompareSession(
      emptyCompareSession({
        stats: { toolCounts: { Bash: 3, Read: 2, Edit: 1 } },
      }),
    );
    assert.equal(summary.totalToolCalls, 6);
    assert.deepEqual(summary.toolCounts, { Bash: 3, Read: 2, Edit: 1 });
  });

  test("maps stats token fields and totalTokens", () => {
    const summary = summarizeCompareSession(
      emptyCompareSession({
        stats: {
          assistantTurns: 4,
          errors: 2,
          totalInputTokens: 10_000,
          totalOutputTokens: 2_500,
          totalCacheHit: 1_200,
        },
      }),
    );
    assert.equal(summary.turns, 4);
    assert.equal(summary.errors, 2);
    assert.equal(summary.inputTokens, 10_000);
    assert.equal(summary.outputTokens, 2_500);
    assert.equal(summary.cacheHit, 1_200);
    assert.equal(summary.totalTokens, 12_500);
  });

  test("cost matches estimateParsedStatsCost for model and stats", () => {
    const session = emptyCompareSession({
      model: "claude-3-sonnet",
      stats: {
        totalInputTokens: 1000,
        totalCacheHit: 400,
        totalOutputTokens: 200,
      },
    });
    const summary = summarizeCompareSession(session);
    const expected = estimateParsedStatsCost(session.model, session.stats);
    assert.ok(Math.abs(summary.cost - expected) < 1e-9);
    assert.ok(summary.cost > 0);
  });

  test("prompt uses first user event text", () => {
    const summary = summarizeCompareSession(
      emptyCompareSession({
        events: [
          { type: "assistant", text: "ignored preamble", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "user", text: "fix the failing test", timestamp: "2026-01-01T00:00:01.000Z" },
        ],
      }),
    );
    assert.equal(summary.prompt, "fix the failing test");
  });

  test("prompt falls back to assistant text when no user message", () => {
    const long = "x".repeat(30);
    const summary = summarizeCompareSession(
      emptyCompareSession({
        events: [
          { type: "assistant", text: "hi", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "assistant", text: long, timestamp: "2026-01-01T00:00:01.000Z" },
        ],
      }),
    );
    assert.equal(summary.prompt, long);
  });

  test("prompt truncates user text to 120 chars via safeSlice", () => {
    const text = "u".repeat(200);
    const summary = summarizeCompareSession(
      emptyCompareSession({ events: [{ type: "user", text, timestamp: "2026-01-01T00:00:00.000Z" }] }),
    );
    assert.equal(summary.prompt.length, 120);
    assert.equal(summary.prompt, text.slice(0, 120));
  });

  test("prompt empty when events missing or no qualifying messages", () => {
    assert.equal(summarizeCompareSession(emptyCompareSession({ events: undefined })).prompt, "");
    assert.equal(
      summarizeCompareSession(
        emptyCompareSession({
          events: [
            { type: "assistant", text: "short", timestamp: "2026-01-01T00:00:00.000Z" },
            { type: "user", text: "", timestamp: "2026-01-01T00:00:01.000Z" },
          ],
        }),
      ).prompt,
      "",
    );
  });

  test("quality matches summarizeChapterQuality and spreads top-level keys", () => {
    const session = emptyCompareSession({
      events: [
        { type: "user", text: "run tests", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          toolCalls: [
            { id: "b1", name: "Bash", input: "npm test" },
            { id: "b2", name: "Bash", input: "npm test" },
          ],
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        {
          type: "tool_result",
          toolUseId: "b1",
          text: "fail",
          isError: true,
          timestamp: "2026-01-01T00:00:02.000Z",
        },
        { type: "tool_result", toolUseId: "b2", text: "ok", timestamp: "2026-01-01T00:00:03.000Z" },
      ],
      stats: { assistantTurns: 1, errors: 1, toolCounts: { Bash: 2 } },
    });
    const chapters = buildSessionChapters(session);
    const expected = summarizeChapterQuality(chapters);
    const summary = summarizeCompareSession(session);

    assert.deepEqual(summary.quality, expected);
    assert.equal(summary.chapters, expected.chapters);
    assert.equal(summary.retries, expected.retries);
    assert.equal(summary.clean, expected.clean);
    assert.equal(summary.corrected, expected.corrected);
    assert.equal(summary.struggling, expected.struggling);
    assert.equal(summary.files, expected.files);
    assert.equal(summary.commits, expected.commits);
  });
});

describe("buildCompareMetricRows structure", () => {
  test("returns rows in COMPARE_METRIC_LABELS order", () => {
    const rows = buildCompareMetricRows(mockSummary(), mockSummary({ id: "bbbbbbbb" }));
    assert.deepEqual(
      rows.map((r) => r[0]),
      COMPARE_METRIC_LABELS,
    );
  });

  test("Model row has pref none and no raw numeric slots", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ model: "claude-sonnet-4-20250514" }),
        mockSummary({ model: "" }),
      ),
      "Model",
    );
    assert.equal(row[3], "none");
    assert.equal(row.length, 4);
    assert.equal(row[1], "sonnet-4");
    assert.equal(row[2], "—");
  });

  test("numeric session rows include raw values at indices 4 and 5", () => {
    const rows = buildCompareMetricRows(
      mockSummary({ turns: 3, errors: 1, durationMs: 100, cost: 0.5, inputTokens: 10 }),
      mockSummary({ turns: 7, errors: 4, durationMs: 200, cost: 0.9, inputTokens: 20 }),
    );
    for (const label of ["Duration", "Turns", "Errors", "Cost", "Input tokens", "Cache hit"]) {
      const row = rowByLabel(rows, label);
      assert.equal(row.length, 6, `${label} should carry raw nums`);
      assert.equal(typeof row[4], "number");
      assert.equal(typeof row[5], "number");
    }
  });

  test("duration, token, and cost rows carry null raw slots when value is zero", () => {
    const rows = buildCompareMetricRows(mockSummary(), mockSummary({ id: "bbbbbbbb" }));
    for (const label of ["Duration", "Cost", "Input tokens", "Output tokens"]) {
      const row = rowByLabel(rows, label);
      assert.equal(row[1], "—", label);
      assert.equal(row[2], "—", label);
      assert.equal(row[4], null, label);
      assert.equal(row[5], null, label);
      assert.equal(deltaWinner(row), null, label);
    }
  });

  test("Chapters and Tool calls use pref none", () => {
    const rows = buildCompareMetricRows(
      mockSummary({ quality: { chapters: 2 } }),
      mockSummary({ quality: { chapters: 5 }, totalToolCalls: 9 }),
    );
    assert.equal(rowByLabel(rows, "Chapters")[3], "none");
    assert.equal(rowByLabel(rows, "Tool calls")[3], "none");
    assert.equal(rowByLabel(rows, "Output tokens")[3], "none");
  });
});

describe("buildCompareMetricRows deltas", () => {
  test("lower-pref Duration: shorter A wins", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary({ durationMs: 1000 }), mockSummary({ durationMs: 9000 })),
      "Duration",
    );
    assert.equal(row[3], "lower");
    assert.equal(deltaWinner(row), "a");
  });

  test("lower-pref Turns: fewer B wins", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary({ turns: 10 }), mockSummary({ turns: 2 })),
      "Turns",
    );
    assert.equal(deltaWinner(row), "b");
  });

  test("lower-pref Errors: zero A wins over positive B", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary({ errors: 0 }), mockSummary({ errors: 5 })),
      "Errors",
    );
    assert.equal(deltaWinner(row), "a");
    assert.equal(row[4], 0);
    assert.equal(row[5], 5);
  });

  test("lower-pref Cost: cheaper session wins on raw cost", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary({ cost: 0.05 }), mockSummary({ cost: 1.2 })),
      "Cost",
    );
    assert.equal(deltaWinner(row), "a");
    assert.match(row[1], /\$/);
    assert.match(row[2], /\$/);
  });

  test("higher-pref Cache hit: more cache reads per input wins", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ cacheHit: 800, inputTokens: 1000 }),
        mockSummary({ cacheHit: 100, inputTokens: 1000 }),
      ),
      "Cache hit",
    );
    assert.equal(row[3], "higher");
    assert.equal(deltaWinner(row), "a");
    const expectedRatioA = 800 / 1000;
    const expectedRatioB = 100 / 1000;
    assert.ok(Math.abs(row[4] - expectedRatioA) < 1e-9);
    assert.ok(Math.abs(row[5] - expectedRatioB) < 1e-9);
  });

  test("lower-pref Retries: fewer retries wins", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ quality: { retries: 0 } }),
        mockSummary({ quality: { retries: 3 } }),
      ),
      "Retries",
    );
    assert.equal(row[3], "lower");
    assert.equal(deltaWinner(row), "a");
  });
});

describe("buildCompareMetricRows ties", () => {
  test("equal Duration raw values produce no delta winner", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary({ durationMs: 5000 }), mockSummary({ durationMs: 5000 })),
      "Duration",
    );
    assert.equal(row[4], row[5]);
    assert.equal(deltaWinner(row), null);
  });

  test("equal Errors omit winner even when display strings match", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary({ errors: 2 }), mockSummary({ errors: 2 })),
      "Errors",
    );
    assert.equal(row[1], "2");
    assert.equal(row[2], "2");
    assert.equal(deltaWinner(row), null);
  });

  test("equal Input tokens tie on raw counts", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ inputTokens: 1200 }),
        mockSummary({ inputTokens: 1200 }),
      ),
      "Input tokens",
    );
    assert.equal(deltaWinner(row), null);
  });

  test("pref none rows never produce a delta winner", () => {
    const rows = buildCompareMetricRows(
      mockSummary({ totalToolCalls: 1, outputTokens: 50, quality: { files: 3, commits: 2 } }),
      mockSummary({ totalToolCalls: 9, outputTokens: 500, quality: { files: 1, commits: 8 } }),
    );
    for (const label of ["Chapters", "Tool calls", "Output tokens", "Files touched", "Commits"]) {
      assert.equal(deltaWinner(rowByLabel(rows, label)), null);
    }
  });
});

describe("buildCompareMetricRows grade columns", () => {
  test("grade rows read from quality object not top-level spread alone", () => {
    const a = mockSummary({
      clean: 99,
      quality: { clean: 2, corrected: 0, struggling: 0, chapters: 2 },
    });
    const b = mockSummary({
      clean: 0,
      quality: { clean: 0, corrected: 1, struggling: 0, chapters: 1 },
    });
    const rows = buildCompareMetricRows(a, b);
    const clean = rowByLabel(rows, "Clean chapters");
    assert.equal(clean[4], 2);
    assert.equal(clean[5], 0);
    assert.equal(clean[1], "2");
    assert.equal(clean[2], "0");
  });

  test("Clean chapters uses higher pref and A wins with more clean", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ quality: { clean: 3, chapters: 3 } }),
        mockSummary({ quality: { clean: 1, chapters: 2 } }),
      ),
      "Clean chapters",
    );
    assert.equal(row[3], "higher");
    assert.equal(deltaWinner(row), "a");
  });

  test("Corrected chapters uses lower pref and B wins with fewer corrected", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ quality: { corrected: 4, chapters: 5 } }),
        mockSummary({ quality: { corrected: 1, chapters: 3 } }),
      ),
      "Corrected chapters",
    );
    assert.equal(row[3], "lower");
    assert.equal(deltaWinner(row), "b");
  });

  test("Struggling chapters uses lower pref and A wins with fewer struggling", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ quality: { struggling: 0, chapters: 2 } }),
        mockSummary({ quality: { struggling: 2, chapters: 2 } }),
      ),
      "Struggling chapters",
    );
    assert.equal(row[3], "lower");
    assert.equal(deltaWinner(row), "a");
  });

  test("tied grade counts produce no delta winner", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ quality: { clean: 2, corrected: 1, struggling: 0, chapters: 3 } }),
        mockSummary({ quality: { clean: 2, corrected: 1, struggling: 0, chapters: 4 } }),
      ),
      "Clean chapters",
    );
    assert.equal(row[4], row[5]);
    assert.equal(deltaWinner(row), null);
  });

  test("integration: real sessions populate all three grade rows", () => {
    const a = summarizeCompareSession(
      emptyCompareSession({
        events: [
          { type: "user", text: "a", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "assistant", text: "1", timestamp: "2026-01-01T00:00:01.000Z", toolCalls: [] },
          { type: "user", text: "b", timestamp: "2026-01-01T00:01:00.000Z" },
          { type: "assistant", text: "2", timestamp: "2026-01-01T00:01:01.000Z", toolCalls: [] },
        ],
        stats: { assistantTurns: 2, toolCounts: {} },
      }),
    );
    const b = summarizeCompareSession(
      emptyCompareSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        events: [
          { type: "user", text: "only", timestamp: "2026-01-01T00:00:00.000Z" },
          { type: "assistant", text: "x", timestamp: "2026-01-01T00:00:01.000Z", toolCalls: [] },
        ],
        stats: { assistantTurns: 1, toolCounts: {} },
      }),
    );
    const rows = buildCompareMetricRows(a, b);
    for (const label of GRADE_COLUMN_LABELS) {
      const row = rowByLabel(rows, label);
      const key = label === "Clean chapters" ? "clean" : label === "Corrected chapters" ? "corrected" : "struggling";
      assert.equal(row[4], a.quality[key]);
      assert.equal(row[5], b.quality[key]);
      assert.equal(Number(row[1]), a.quality[key]);
      assert.equal(Number(row[2]), b.quality[key]);
    }
    assert.equal(deltaWinner(rowByLabel(rows, "Clean chapters")), "a");
  });
});

describe("buildCompareMetricRows display formatting", () => {
  test("zero duration and cost render em dash labels", () => {
    const rows = buildCompareMetricRows(mockSummary(), mockSummary());
    assert.equal(rowByLabel(rows, "Duration")[1], "—");
    assert.equal(rowByLabel(rows, "Cost")[1], "—");
  });

  test("large token counts use compact K/M suffixes", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ inputTokens: 1_500_000 }),
        mockSummary({ inputTokens: 42_000 }),
      ),
      "Input tokens",
    );
    assert.equal(row[1], "1.5M");
    assert.equal(row[2], "42K");
  });

  test("zero input tokens display em dash and cache hit stays em dash", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary(), mockSummary()),
      "Cache hit",
    );
    assert.equal(rowByLabel(buildCompareMetricRows(mockSummary(), mockSummary()), "Input tokens")[1], "—");
    assert.equal(row[1], "—");
    assert.equal(row[2], "—");
  });
});

const PREF_NONE_METRIC_LABELS = [
  "Model",
  "Chapters",
  "Tool calls",
  "Output tokens",
  "Files touched",
  "Commits",
];

describe("buildCompareMetricRows edges", () => {
  test("pref-none labels stay none with no delta when raw values diverge", () => {
    const rows = buildCompareMetricRows(
      mockSummary({
        model: "claude-opus-4-20250514",
        quality: { chapters: 1, files: 8, commits: 2 },
        totalToolCalls: 3,
        outputTokens: 12,
      }),
      mockSummary({
        model: "",
        quality: { chapters: 6, files: 0, commits: 9 },
        totalToolCalls: 40,
        outputTokens: 4_200,
      }),
    );
    for (const label of PREF_NONE_METRIC_LABELS) {
      const row = rowByLabel(rows, label);
      assert.equal(row[3], "none", label);
      assert.equal(deltaWinner(row), null, label);
    }
  });

  test("Model row is 4-tuple with em dash when both models blank", () => {
    const row = rowByLabel(buildCompareMetricRows(mockSummary(), mockSummary()), "Model");
    assert.equal(row[3], "none");
    assert.equal(row.length, 4);
    assert.equal(row[1], "—");
    assert.equal(row[2], "—");
  });

  test("Chapters pref none still exposes raw chapter counts", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ quality: { chapters: 0 } }),
        mockSummary({ quality: { chapters: 4 } }),
      ),
      "Chapters",
    );
    assert.equal(row[3], "none");
    assert.equal(row[1], "0");
    assert.equal(row[2], "4");
    assert.equal(row[4], 0);
    assert.equal(row[5], 4);
    assert.equal(deltaWinner(row), null);
  });

  test("Files touched and Commits pref none with unequal quality counts", () => {
    const rows = buildCompareMetricRows(
      mockSummary({ quality: { files: 0, commits: 5 } }),
      mockSummary({ quality: { files: 12, commits: 0 } }),
    );
    const files = rowByLabel(rows, "Files touched");
    const commits = rowByLabel(rows, "Commits");
    assert.equal(files[3], "none");
    assert.equal(commits[3], "none");
    assert.equal(files[4], 0);
    assert.equal(files[5], 12);
    assert.equal(commits[4], 5);
    assert.equal(commits[5], 0);
    assert.equal(deltaWinner(files), null);
    assert.equal(deltaWinner(commits), null);
  });

  test("Tool calls zero vs large count stays pref none", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ totalToolCalls: 0 }),
        mockSummary({ totalToolCalls: 99 }),
      ),
      "Tool calls",
    );
    assert.equal(row[1], "0");
    assert.equal(row[2], "99");
    assert.equal(row[3], "none");
    assert.equal(deltaWinner(row), null);
  });

  test("Output tokens zero vs compact K uses none pref and no-data dash", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ outputTokens: 0 }),
        mockSummary({ outputTokens: 2_500 }),
      ),
      "Output tokens",
    );
    assert.equal(row[1], "—");
    assert.equal(row[2], "3K");
    assert.equal(row[3], "none");
    assert.equal(row[4], null);
    assert.equal(row[5], 2_500);
    assert.equal(deltaWinner(row), null);
  });

  test("zero duration on A only shows em dash and null raw on A column", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ durationMs: 0 }),
        mockSummary({ durationMs: 125_000 }),
      ),
      "Duration",
    );
    assert.equal(row[1], "—");
    assert.equal(row[2], "2m");
    assert.equal(row[4], null);
    assert.equal(row[5], 125_000);
    assert.equal(deltaWinner(row), null);
  });

  test("zero cost on both sides renders em dash with null raw slots", () => {
    const row = rowByLabel(
      buildCompareMetricRows(mockSummary({ cost: 0 }), mockSummary({ cost: 0 })),
      "Cost",
    );
    assert.equal(row[1], "—");
    assert.equal(row[2], "—");
    assert.equal(row[4], null);
    assert.equal(row[5], null);
    assert.equal(deltaWinner(row), null);
  });

  test("sub-minimum cost on A renders em dash while B shows dollars", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ cost: 0.0004 }),
        mockSummary({ cost: 0.05 }),
      ),
      "Cost",
    );
    assert.equal(row[1], "—");
    assert.match(row[2], /\$/);
    assert.equal(row[4], 0.0004);
    assert.equal(row[5], 0.05);
  });

  test("cache hit em dash on zero cacheHit side with nonzero input", () => {
    const row = rowByLabel(
      buildCompareMetricRows(
        mockSummary({ cacheHit: 0, inputTokens: 10_000 }),
        mockSummary({ cacheHit: 5_000, inputTokens: 10_000 }),
      ),
      "Cache hit",
    );
    assert.equal(row[1], "—");
    assert.equal(row[2], "50%");
    assert.equal(deltaWinner(row), "b");
  });
});

describe("buildCompareToolRows", () => {
  test("empty toolCounts yields no rows", () => {
    assert.deepEqual(buildCompareToolRows(mockSummary(), mockSummary()), []);
  });

  test("union of tools from both sessions", () => {
    const rows = buildCompareToolRows(
      mockSummary({ toolCounts: { Bash: 2, Read: 1 } }),
      mockSummary({ toolCounts: { Grep: 5, Read: 3 } }),
    );
    assert.deepEqual(
      rows.map((r) => r[0]).sort(),
      ["Bash", "Grep", "Read"],
    );
    const read = rows.find((r) => r[0] === "Read");
    assert.deepEqual(read, ["Read", 1, 3]);
  });

  test("sorts by combined count descending", () => {
    const rows = buildCompareToolRows(
      mockSummary({ toolCounts: { Bash: 1, Read: 10 } }),
      mockSummary({ toolCounts: { Bash: 9, Grep: 2 } }),
    );
    assert.equal(rows[0][0], "Bash");
    assert.equal(rows[0][1] + rows[0][2], 10);
    assert.equal(rows[1][0], "Read");
    assert.equal(rows[2][0], "Grep");
  });

  test("missing tool on one side counts as zero", () => {
    const rows = buildCompareToolRows(
      mockSummary({ toolCounts: { Edit: 4 } }),
      mockSummary({ toolCounts: {} }),
    );
    assert.deepEqual(rows, [["Edit", 4, 0]]);
  });

  test("single tool only on session B", () => {
    const rows = buildCompareToolRows(
      mockSummary({ toolCounts: {} }),
      mockSummary({ toolCounts: { Write: 2 } }),
    );
    assert.deepEqual(rows, [["Write", 0, 2]]);
  });

  test("single shared tool on both sessions is one row", () => {
    const rows = buildCompareToolRows(
      mockSummary({ toolCounts: { Bash: 7 } }),
      mockSummary({ toolCounts: { Bash: 3 } }),
    );
    assert.deepEqual(rows, [["Bash", 7, 3]]);
    assert.equal(rows.length, 1);
  });

  test("zero-valued tool key still emits a row", () => {
    const rows = buildCompareToolRows(
      mockSummary({ toolCounts: { Read: 0 } }),
      mockSummary({ toolCounts: { Read: 5 } }),
    );
    assert.deepEqual(rows, [["Read", 0, 5]]);
  });

  test("summarizeCompareSession empty toolCounts yields no compare rows", () => {
    const empty = summarizeCompareSession(emptyCompareSession());
    const withTools = summarizeCompareSession(
      emptyCompareSession({
        stats: { toolCounts: { Bash: 1 } },
      }),
    );
    assert.deepEqual(buildCompareToolRows(empty, empty), []);
    assert.deepEqual(buildCompareToolRows(withTools, empty), [["Bash", 1, 0]]);
    assert.deepEqual(buildCompareToolRows(empty, withTools), [["Bash", 0, 1]]);
  });
});

describe("buildToolComparisonHtml", () => {
  test("default limit 12 caps rendered tool rows", () => {
    const rows = Array.from({ length: 15 }, (_, i) => [`Tool${i}`, i + 1, 0]);
    const html = buildToolComparisonHtml(rows);
    assert.equal((html.match(/tool-cmp-row/g) || []).length, 12);
    assert.match(html, />Tool0</);
    assert.match(html, />Tool11</);
    assert.doesNotMatch(html, />Tool12</);
  });

  test("custom limit caps rendered tools", () => {
    const rows = [
      ["Bash", 10, 2],
      ["Read", 5, 5],
      ["Grep", 1, 1],
    ];
    const html = buildToolComparisonHtml(rows, 2);
    assert.equal((html.match(/tool-cmp-row/g) || []).length, 2);
    assert.match(html, />Bash</);
    assert.match(html, />Read</);
    assert.doesNotMatch(html, />Grep</);
  });

  test("escapes tool display names and formats mcp tools", () => {
    const html = buildToolComparisonHtml([["<x>", 1, 2], ["mcp__srv__tool", 3, 4]], 2);
    assert.doesNotMatch(html, /<x>/);
    assert.match(html, /&lt;x&gt;/);
    assert.match(html, />srv: tool</);
  });
});

describe("buildMetricTableHtml", () => {
  test("escapes cell values and labels", () => {
    const html = buildMetricTableHtml([
      ["<script>", "<a>", "&b", "none"],
    ]);
    assert.match(html, /&lt;a&gt;/);
    assert.match(html, /&amp;b/);
    assert.match(html, /cmp-label">&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  test("applies delta-good and delta-bad on lower-pref winner", () => {
    const html = buildMetricTableHtml([
      ["Errors", "0", "5", "lower", 0, 5],
    ]);
    assert.match(html, /cmp-val delta-good">0/);
    assert.match(html, /cmp-val delta-bad">5/);
  });

  test("ties and pref none omit delta classes", () => {
    const html = buildMetricTableHtml([
      ["Chapters", "2", "2", "none", 2, 2],
      ["Turns", "1", "3", "lower", 1, 1],
    ]);
    const chapters = html.match(/cmp-label">Chapters<[\s\S]*?<\/tr>/)?.[0] || "";
    assert.doesNotMatch(chapters, /delta-good/);
    assert.doesNotMatch(chapters, /delta-bad/);
    const turns = html.match(/cmp-label">Turns<[\s\S]*?<\/tr>/)?.[0] || "";
    assert.doesNotMatch(turns, /delta-good/);
    assert.doesNotMatch(turns, /delta-bad/);
  });
});

describe("estimated metrics vs measured (facts gqy, jc6)", () => {
  /** Cursor-shaped summary: zero input tokens, estimated output tokens/cost/duration. */
  function cursorSummary(overrides = {}) {
    return mockSummary({
      id: "cursorrr",
      source: "cursor",
      model: "cursor",
      inputTokens: 0,
      outputTokens: 3_000,
      cost: 0.02,
      durationMs: 60_000,
      tokensEstimated: true,
      timesEstimated: true,
      ...overrides,
    });
  }

  /** Claude-shaped summary: real measured metrics. */
  function claudeSummary(overrides = {}) {
    return mockSummary({
      id: "claudeee",
      source: "claude",
      model: "claude-sonnet-4-20250514",
      inputTokens: 250_000,
      outputTokens: 12_000,
      cost: 1.5,
      durationMs: 300_000,
      tokensEstimated: false,
      timesEstimated: false,
      ...overrides,
    });
  }

  test("cursor zero input tokens never wins against claude's real count", () => {
    const rows = buildCompareMetricRows(cursorSummary(), claudeSummary());
    const row = rowByLabel(rows, "Input tokens");
    assert.equal(row[1], "—");
    assert.equal(row[4], null);
    assert.equal(deltaWinner(row), null);
    const html = buildMetricTableHtml([row]);
    assert.doesNotMatch(html, /delta-good/);
    assert.doesNotMatch(html, /delta-bad/);
  });

  test("estimated cursor cells carry '~' prefix; measured claude cells do not", () => {
    const rows = buildCompareMetricRows(cursorSummary(), claudeSummary());
    assert.equal(rowByLabel(rows, "Output tokens")[1], "~3K");
    assert.equal(rowByLabel(rows, "Output tokens")[2], "12K");
    // Cost is always an estimate: fmtCost renders the universal "~$" prefix
    // on both sides, so the cursor side is never presented as measured.
    assert.match(rowByLabel(rows, "Cost")[1], /^~\$/);
    assert.match(rowByLabel(rows, "Cost")[2], /^~\$/);
    assert.doesNotMatch(rowByLabel(rows, "Cost")[1], /^~~/);
    assert.equal(rowByLabel(rows, "Duration")[1], "~1m");
    assert.equal(rowByLabel(rows, "Duration")[2], "5m");
  });

  test("timesEstimated does not leak '~' into token rows and vice versa", () => {
    const rows = buildCompareMetricRows(
      cursorSummary({ tokensEstimated: false, timesEstimated: true }),
      claudeSummary(),
    );
    assert.equal(rowByLabel(rows, "Output tokens")[1], "3K");
    assert.equal(rowByLabel(rows, "Duration")[1], "~1m");
    const rows2 = buildCompareMetricRows(
      cursorSummary({ tokensEstimated: true, timesEstimated: false }),
      claudeSummary(),
    );
    assert.equal(rowByLabel(rows2, "Duration")[1], "1m");
    assert.equal(rowByLabel(rows2, "Output tokens")[1], "~3K");
  });

  test("claude-vs-claude with real nonzero values keeps winner highlighting", () => {
    const rows = buildCompareMetricRows(
      claudeSummary({ inputTokens: 100_000, cost: 0.5, durationMs: 60_000 }),
      claudeSummary({ id: "claude22", inputTokens: 250_000, cost: 1.5, durationMs: 300_000 }),
    );
    for (const label of ["Input tokens", "Cost", "Duration"]) {
      const row = rowByLabel(rows, label);
      assert.equal(deltaWinner(row), "a", label);
    }
    assert.doesNotMatch(rowByLabel(rows, "Input tokens")[1], /~/);
    assert.doesNotMatch(rowByLabel(rows, "Duration")[1], /~/);
    const html = buildMetricTableHtml([rowByLabel(rows, "Input tokens")]);
    assert.match(html, /delta-good/);
    assert.match(html, /delta-bad/);
  });

  test("errors row keeps zero-is-meaningful winner semantics", () => {
    const rows = buildCompareMetricRows(
      cursorSummary({ errors: 0 }),
      claudeSummary({ errors: 2 }),
    );
    const row = rowByLabel(rows, "Errors");
    assert.equal(deltaWinner(row), "a");
    const html = buildMetricTableHtml([row]);
    assert.match(html, /cmp-val delta-good">0/);
    assert.match(html, /cmp-val delta-bad">2/);
  });

  test("files and chapters rows keep zero raw slots (no null coercion)", () => {
    const rows = buildCompareMetricRows(
      mockSummary({ quality: { files: 0, chapters: 0 } }),
      mockSummary({ quality: { files: 3, chapters: 2 } }),
    );
    assert.equal(rowByLabel(rows, "Files touched")[4], 0);
    assert.equal(rowByLabel(rows, "Chapters")[4], 0);
  });

  test("summarizeCompareSession exposes tokensEstimated and timesEstimated", () => {
    const est = summarizeCompareSession(
      emptyCompareSession({
        source: "cursor",
        timesEstimated: true,
        stats: { tokensEstimated: true, totalOutputTokens: 400 },
      }),
    );
    assert.equal(est.tokensEstimated, true);
    assert.equal(est.timesEstimated, true);
    const measured = summarizeCompareSession(emptyCompareSession());
    assert.equal(measured.tokensEstimated, false);
    assert.equal(measured.timesEstimated, false);
  });

  test("buildMetricTableHtml skips winner classes when one raw slot is null", () => {
    const html = buildMetricTableHtml([
      ["Input tokens", "—", "250K", "lower", null, 250_000],
    ]);
    assert.doesNotMatch(html, /delta-good/);
    assert.doesNotMatch(html, /delta-bad/);
  });
});

describe("buildSessionCardHtml", () => {
  test("source badge uses Cursor palette color", () => {
    const summary = mockSummary({ source: "cursor" });
    const html = buildSessionCardHtml(summary, {}, "/view?path=x&source=cursor", "session-a");
    assert.match(html, /cmp-source-badge/);
    assert.match(html, /--hue:#c4e86b/);
    assert.match(html, />cursor</);
  });
});

describe("compareViewUrl", () => {
  test("encodes path and omits source when claude", () => {
    const session = emptyCompareSession({ _path: "/tmp/sess a.jsonl", source: "claude" });
    const summary = summarizeCompareSession(session);
    assert.equal(compareViewUrl(session, summary), "/view?path=%2Ftmp%2Fsess%20a.jsonl");
  });

  test("appends source query for non-claude sessions", () => {
    const session = emptyCompareSession({ _path: "/data/x.jsonl", source: "codex" });
    const summary = summarizeCompareSession(session);
    assert.equal(
      compareViewUrl(session, summary),
      "/view?path=%2Fdata%2Fx.jsonl&source=codex",
    );
  });
});
