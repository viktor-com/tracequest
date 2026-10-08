import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  getModelRates,
  computeGrade,
  estimateCost,
  estimateChapterTokenCost,
  fmtTokens,
  fmtCost,
  formatDuration,
  fmtMcpName,
  fmtPct,
  fmtCacheHitPct,
  shortModel,
  sortSessionList,
} from "../src/filter/filter-formats.js";

describe("filter-formats fmtMcpName", () => {
  test("formats mcp__server__tool_name", () => {
    assert.equal(fmtMcpName("mcp__my_server__do_thing"), "my server: do thing");
  });

  test("passes through non-mcp names", () => {
    assert.equal(fmtMcpName("Bash"), "Bash");
    assert.equal(fmtMcpName("mcp__incomplete"), "incomplete");
  });

  test("non-string input returned unchanged", () => {
    assert.equal(fmtMcpName(null), null);
    assert.equal(fmtMcpName(42), 42);
  });
});

describe("filter-formats shortModel", () => {
  test("strips claude- prefix and date suffix", () => {
    assert.equal(shortModel("claude-sonnet-4-6-20250514"), "sonnet-4-6");
    assert.equal(shortModel("claude-opus-4"), "opus-4");
  });

  test("falsy returns empty string", () => {
    assert.equal(shortModel(""), "");
    assert.equal(shortModel(null), "");
    assert.equal(shortModel(undefined), "");
  });

  test("non-claude model names only strip trailing date suffix", () => {
    assert.equal(shortModel("sonnet-4-6-20250514"), "sonnet-4-6");
    assert.equal(shortModel("gpt-4o"), "gpt-4o");
  });
});

describe("filter-formats fmtTokens", () => {
  test("formats millions and thousands", () => {
    assert.equal(fmtTokens(1_500_000), "1.5M");
    assert.equal(fmtTokens(42_000), "42K");
    assert.equal(fmtTokens(999), "999");
  });

  test("falsy returns empty string by default", () => {
    assert.equal(fmtTokens(0), "");
    assert.equal(fmtTokens(null), "");
    assert.equal(fmtTokens(undefined), "");
  });

  test("zeroLabel option for compare-style display", () => {
    assert.equal(fmtTokens(0, { zeroLabel: "0" }), "0");
    assert.equal(fmtTokens(null, { zeroLabel: "0" }), "0");
  });
});

describe("filter-formats fmtPct", () => {
  test("formats rounded percent", () => {
    assert.equal(fmtPct(42.4), "42%");
    assert.equal(fmtPct(100), "100%");
  });

  test("hideZero and zeroLabel for dashboard cache", () => {
    assert.equal(fmtPct(0, { hideZero: true }), "--");
    assert.equal(fmtPct(33.6, { hideZero: true }), "34%");
  });

  test("falsy returns zeroLabel", () => {
    assert.equal(fmtPct(null), "--");
    assert.equal(fmtPct(NaN, { zeroLabel: "n/a" }), "n/a");
  });
});

describe("filter-formats fmtCacheHitPct", () => {
  test("compare-style dash when no cache read", () => {
    assert.equal(fmtCacheHitPct(0, 1000), "—");
    assert.equal(fmtCacheHitPct(null, 1000), "—");
  });

  test("integer percent from hit/input", () => {
    assert.equal(fmtCacheHitPct(250, 1000), "25%");
    assert.equal(fmtCacheHitPct(999, 1000), "100%");
  });
});

describe("filter-formats fmtCost", () => {
  test("default ~$ with 2 or 3 decimals", () => {
    assert.equal(fmtCost(1.5), "~$1.50");
    assert.equal(fmtCost(0.042), "~$0.042");
  });

  test("below min returns empty by default", () => {
    assert.equal(fmtCost(0.005), "");
    assert.equal(fmtCost(0), "");
  });

  test("compare-style dash below 0.001", () => {
    assert.equal(fmtCost(0, { min: 0.001, zeroLabel: "—" }), "—");
    assert.equal(fmtCost(0.0005, { min: 0.001, zeroLabel: "—" }), "—");
    assert.equal(fmtCost(0.002, { min: 0.001, zeroLabel: "—" }), "~$0.002");
  });

  test("dashboard-style $ prefix with $0 floor", () => {
    assert.equal(fmtCost(0, { prefix: "$", zeroLabel: "$0" }), "$0");
    assert.equal(fmtCost(0.005, { prefix: "$", zeroLabel: "$0" }), "$0");
    assert.equal(fmtCost(1.2, { prefix: "$", zeroLabel: "$0" }), "$1.20");
  });

  test("chart tooltip fine decimals and tiny label", () => {
    assert.equal(
      fmtCost(0.005, {
        prefix: "$",
        min: 0.001,
        fine: true,
        tinyMin: 0.001,
        tinyLabel: "<$0.001",
        zeroLabel: "<$0.001",
      }),
      "$0.0050",
    );
    assert.equal(
      fmtCost(0.0005, {
        prefix: "$",
        min: 0.001,
        fine: true,
        tinyMin: 0.001,
        tinyLabel: "<$0.001",
        zeroLabel: "<$0.001",
      }),
      "<$0.001",
    );
  });

  test("null and NaN return zeroLabel", () => {
    assert.equal(fmtCost(null), "");
    assert.equal(fmtCost(NaN), "");
    assert.equal(fmtCost(null, { zeroLabel: "n/a" }), "n/a");
    assert.equal(fmtCost(NaN, { zeroLabel: "n/a" }), "n/a");
  });

  test("cost exactly at default min displays", () => {
    assert.equal(fmtCost(0.01), "~$0.010");
    assert.equal(fmtCost(0.00999), "");
  });

  test("negative cost below min returns zeroLabel", () => {
    assert.equal(fmtCost(-0.5), "");
    assert.equal(fmtCost(-1, { zeroLabel: "—" }), "—");
  });

  test("explicit decimals override auto precision", () => {
    assert.equal(fmtCost(2.5, { decimals: 1 }), "~$2.5");
    assert.equal(fmtCost(0.05, { prefix: "$", min: 0.001, decimals: 2 }), "$0.05");
  });

  test("zero with custom zeroLabel only (no prefix)", () => {
    assert.equal(fmtCost(0, { zeroLabel: "free" }), "free");
    assert.equal(fmtCost(0.005, { zeroLabel: "free", min: 0.01 }), "free");
  });
});

describe("filter-formats formatDuration", () => {
  test("browser-style seconds and hours", () => {
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(90_000), "1m");
    assert.equal(formatDuration(3_600_000), "1h");
    assert.equal(formatDuration(5_400_000), "1h 30m");
  });

  test("falsy returns empty by default", () => {
    assert.equal(formatDuration(0), "");
    assert.equal(formatDuration(null), "");
  });

  test("zeroLabel for compare-style display", () => {
    assert.equal(formatDuration(0, { zeroLabel: "—" }), "—");
    assert.equal(formatDuration(null, { zeroLabel: "—" }), "—");
  });

  test("markdown-style floor and sub-second label", () => {
    assert.equal(
      formatDuration(500, {
        floorSeconds: true,
        includeSeconds: true,
        alwaysShowMinutes: true,
        subSecondLabel: "< 1s",
        zeroLabel: "< 1s",
      }),
      "< 1s",
    );
    assert.equal(
      formatDuration(125_000, {
        floorSeconds: true,
        includeSeconds: true,
        alwaysShowMinutes: true,
        subSecondLabel: "< 1s",
      }),
      "2m 5s",
    );
  });
});

describe("filter-formats getModelRates", () => {
  test("Sonnet vs Opus per-million-token USD rates", () => {
    assert.deepEqual(getModelRates("claude-3-sonnet"), {
      inRate: 3,
      outRate: 15,
      cacheReadRate: 0.3,
    });
    assert.deepEqual(getModelRates("claude-opus-4"), {
      inRate: 15,
      outRate: 75,
      cacheReadRate: 1.5,
    });
  });

  test("null/empty model defaults to Sonnet pricing", () => {
    assert.deepEqual(getModelRates(null), getModelRates("claude-3-sonnet"));
    assert.deepEqual(getModelRates(""), getModelRates("claude-3-sonnet"));
  });

  test("opus match is case-insensitive", () => {
    assert.deepEqual(getModelRates("Claude-OPUS-latest"), getModelRates("claude-opus-4"));
  });
});

describe("filter-formats estimateChapterTokenCost", () => {
  test("subtracts cache hits from input billing", () => {
    const cost = estimateChapterTokenCost("claude-3-sonnet", {
      input: 1000,
      cacheHit: 400,
      output: 200,
    });
    const expected = (600 * 3 + 400 * 0.3 + 200 * 15) / 1e6;
    assert.ok(Math.abs(cost - expected) < 1e-12);
  });

  test("clamps uncached input when cacheHit exceeds input", () => {
    const cost = estimateChapterTokenCost("claude-3-sonnet", {
      input: 100,
      cacheHit: 500,
      output: 50,
    });
    const expected = (0 * 3 + 500 * 0.3 + 50 * 15) / 1e6;
    assert.ok(Math.abs(cost - expected) < 1e-12);
  });
});

describe("filter-formats estimateCost", () => {
  test("applies Sonnet rates to input, cache read, and output tokens", () => {
    const session = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      model: "claude-3-sonnet",
    };
    const expected = (1000 * 3 + 200 * 0.3 + 500 * 15) / 1e6;
    assert.ok(Math.abs(estimateCost(session) - expected) < 1e-12);
  });

  test("uses Opus rates when model name includes opus", () => {
    const session = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      model: "claude-opus-4",
    };
    const expected = (1000 * 15 + 200 * 1.5 + 500 * 75) / 1e6;
    assert.ok(Math.abs(estimateCost(session) - expected) < 1e-12);
  });

  test("returns 0 when session has no token counts", () => {
    assert.equal(estimateCost({ model: "claude-3-sonnet" }), 0);
    assert.equal(estimateCost({ inputTokens: 0, outputTokens: 0 }), 0);
  });

  test("caches result on session._costCache", () => {
    const session = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 200,
      model: "claude-3-sonnet",
    };
    const r1 = estimateCost(session);
    const r2 = estimateCost(session);
    assert.equal(r1, r2);
    assert.equal(session._costCache, r1);
  });

  test("bills output-only sessions when outputTokens present", () => {
    const cost = estimateCost({ outputTokens: 1_000_000, model: "claude-3-sonnet" });
    assert.ok(Math.abs(cost - 15) < 1e-12);
  });

  test("returns 0 when only cacheReadTokens are set", () => {
    assert.equal(
      estimateCost({ cacheReadTokens: 1_000_000, model: "claude-3-sonnet" }),
      0,
    );
  });

  test("missing model defaults to Sonnet rates", () => {
    const cost = estimateCost({ inputTokens: 1_000_000 });
    assert.ok(Math.abs(cost - 3) < 1e-12);
  });

  test("opus in model name uses Opus rates", () => {
    const session = { inputTokens: 1_000_000, outputTokens: 0, model: "Claude-OPUS-4" };
    assert.ok(Math.abs(estimateCost(session) - 15) < 1e-12);
  });

  test("returns _costCache without recomputing when preset", () => {
    const session = { inputTokens: 999, outputTokens: 1, _costCache: 42 };
    assert.equal(estimateCost(session), 42);
  });

  test("input-only session bills uncached input at inRate", () => {
    const cost = estimateCost({ inputTokens: 1_000_000, model: "claude-3-sonnet" });
    assert.ok(Math.abs(cost - 3) < 1e-12);
  });

  test("cache read plus input sums both line items", () => {
    const session = {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      model: "claude-3-sonnet",
    };
    const expected = (1_000_000 * 3 + 1_000_000 * 0.3) / 1e6;
    assert.ok(Math.abs(estimateCost(session) - expected) < 1e-12);
  });
});

describe("filter-formats computeGrade", () => {
  test("error ratio sums all toolCount values not just distinct tool keys", () => {
    const base = {
      chapters: 10,
      errors: 1,
      inputTokens: 50_000,
      cacheReadTokens: 40_000,
    };
    const spread = computeGrade({ ...base, toolCounts: { Bash: 1, Read: 1, Grep: 1 } });
    const consolidated = computeGrade({ ...base, toolCounts: { Bash: 3 } });
    assert.deepEqual(
      spread,
      consolidated,
      "same total tool calls across keys should yield identical grade",
    );
    assert.equal(spread.score, 54);
  });

  test("zero chapters yields placeholder grade", () => {
    assert.deepEqual(computeGrade({ chapters: 0 }), {
      score: 0,
      letter: "-",
      cls: "",
    });
  });

  test("weighted score maps to letter bands", () => {
    const perfect = {
      chapters: 10,
      errors: 0,
      inputTokens: 50000,
      cacheReadTokens: 40000,
      toolCounts: { Bash: 5 },
    };
    const g = computeGrade(perfect);
    assert.equal(g.letter, "A");
    assert.equal(g.cls, "grade-a");
    assert.ok(g.score >= 90);

    const poor = {
      chapters: 2,
      errors: 10,
      inputTokens: 100,
      cacheReadTokens: 0,
      toolCounts: { Bash: 2, Read: 3 },
    };
    const p = computeGrade(poor);
    assert.equal(p.letter, "F");
    assert.equal(p.cls, "grade-f");
    assert.ok(p.score < 60);
  });

  test("caches result on session._gradeCache", () => {
    const session = {
      chapters: 5,
      errors: 2,
      inputTokens: 1000,
      cacheReadTokens: 500,
      model: "claude-3-sonnet",
      toolCounts: { Bash: 3, Read: 2 },
    };
    const r1 = computeGrade(session);
    const r2 = computeGrade(session);
    assert.deepEqual(r1, r2);
    assert.deepEqual(session._gradeCache, r1);
  });

  test("undefined chapters treated as zero (placeholder grade)", () => {
    assert.deepEqual(computeGrade({}), {
      score: 0,
      letter: "-",
      cls: "",
    });
  });

  test("score 59 maps to F, score 60 maps to D", () => {
    const f = computeGrade({
      chapters: 1,
      errors: 1,
      inputTokens: 100,
      cacheReadTokens: 0,
      toolCounts: { Bash: 4 },
    });
    assert.equal(f.score, 59);
    assert.equal(f.letter, "F");
    assert.equal(f.cls, "grade-f");

    const d = computeGrade({
      chapters: 1,
      errors: 3,
      inputTokens: 100,
      cacheReadTokens: 0,
      toolCounts: { Bash: 17 },
    });
    assert.equal(d.score, 60);
    assert.equal(d.letter, "D");
    assert.equal(d.cls, "grade-d");
  });

  test("score 70 maps to C, score 80 maps to B", () => {
    const c = computeGrade({
      chapters: 3,
      errors: 2,
      inputTokens: 0,
      cacheReadTokens: 0,
      toolCounts: { Bash: 10 },
    });
    assert.equal(c.score, 70);
    assert.equal(c.letter, "C");
    assert.equal(c.cls, "grade-c");

    const b = computeGrade({
      chapters: 1,
      errors: 0,
      inputTokens: 15_000,
      cacheReadTokens: 0,
      toolCounts: { Bash: 10 },
    });
    assert.equal(b.score, 80);
    assert.equal(b.letter, "B");
    assert.equal(b.cls, "grade-b");
  });

  test("score 88 is B, score 90 is A (A band boundary)", () => {
    const b = computeGrade({
      chapters: 1,
      errors: 0,
      inputTokens: 10_000,
      cacheReadTokens: 5_000,
      toolCounts: { Bash: 20 },
    });
    assert.equal(b.score, 88);
    assert.equal(b.letter, "B");
    assert.equal(b.cls, "grade-b");

    const a = computeGrade({
      chapters: 1,
      errors: 0,
      inputTokens: 10_000,
      cacheReadTokens: 7_000,
      toolCounts: { Bash: 20 },
    });
    assert.equal(a.score, 90);
    assert.equal(a.letter, "A");
    assert.equal(a.cls, "grade-a");
  });

  test("empty toolCounts skips error-ratio penalty", () => {
    const g = computeGrade({
      chapters: 2,
      errors: 5,
      inputTokens: 500,
      cacheReadTokens: 0,
      toolCounts: {},
    });
    assert.ok(g.score >= 60);
    assert.notEqual(g.letter, "F");
  });

  test("returns _gradeCache without recomputing when preset", () => {
    const cached = { score: 55, letter: "F", cls: "grade-f" };
    const session = { chapters: 10, _gradeCache: cached };
    assert.deepEqual(computeGrade(session), cached);
  });

  test("totalInput under 10k uses fixed cacheScore 75 (not ratio)", () => {
    const lowCache = computeGrade({
      chapters: 5,
      errors: 0,
      inputTokens: 5000,
      cacheReadTokens: 0,
      toolCounts: { Bash: 1 },
    });
    assert.equal(lowCache.score, 95);
    assert.equal(lowCache.letter, "A");

    const noCacheHit = computeGrade({
      chapters: 5,
      errors: 0,
      inputTokens: 10_000,
      cacheReadTokens: 0,
      toolCounts: { Bash: 1 },
    });
    assert.equal(noCacheHit.score, 80);
    assert.equal(noCacheHit.letter, "B");
  });

  test("errors per chapter at 2+ drops qualityScore to 20", () => {
    const g = computeGrade({
      chapters: 2,
      errors: 4,
      inputTokens: 50_000,
      cacheReadTokens: 40_000,
      toolCounts: { Bash: 1 },
    });
    assert.equal(g.score, 36);
    assert.equal(g.letter, "F");
  });

  test("one error per two chapters uses qualityScore 80 band", () => {
    const g = computeGrade({
      chapters: 2,
      errors: 1,
      inputTokens: 50_000,
      cacheReadTokens: 40_000,
      toolCounts: { Bash: 1 },
    });
    assert.equal(g.score, 48);
    assert.equal(g.letter, "F");
  });

  test("error ratio against tool calls can zero errorScore", () => {
    const g = computeGrade({
      chapters: 1,
      errors: 10,
      inputTokens: 50_000,
      cacheReadTokens: 40_000,
      toolCounts: { Bash: 10 },
    });
    assert.equal(g.score, 36);
    assert.equal(g.letter, "F");
  });

  test("rounded score stays within 0–100", () => {
    const g = computeGrade({
      chapters: 1,
      errors: 0,
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      toolCounts: {},
    });
    assert.ok(g.score >= 0 && g.score <= 100);
    assert.equal(g.letter, "A");
  });
});

describe("filter-formats sortSessionList", () => {
  const base = (overrides) => ({
    mtime: 1000,
    durationMs: 0,
    totalTokens: 0,
    errors: 0,
    files: 0,
    commits: 0,
    chapters: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  });

  test("default sort orders by mtime descending", () => {
    const arr = [base({ mtime: 1 }), base({ mtime: 3 }), base({ mtime: 2 })];
    sortSessionList(arr, "recent");
    assert.deepEqual(arr.map((s) => s.mtime), [3, 2, 1]);
  });

  test("date sort alias matches recent (mtime descending)", () => {
    const arr = [base({ mtime: 1 }), base({ mtime: 3 }), base({ mtime: 2 })];
    sortSessionList(arr, "date");
    assert.deepEqual(arr.map((s) => s.mtime), [3, 2, 1]);
  });

  test("default sort handles Date mtimes like findSessions", () => {
    const arr = [
      base({ mtime: new Date(1000) }),
      base({ mtime: new Date(3000) }),
      base({ mtime: new Date(2000) }),
    ];
    sortSessionList(arr, "recent");
    assert.deepEqual(
      arr.map((s) => s.mtime.getTime()),
      [3000, 2000, 1000]
    );
  });

  test("cost sort uses estimateCost", () => {
    const arr = [
      base({ inputTokens: 100, outputTokens: 0, model: "claude-3-sonnet" }),
      base({ inputTokens: 10_000, outputTokens: 0, model: "claude-3-sonnet" }),
    ];
    sortSessionList(arr, "cost");
    assert.ok(estimateCost(arr[0]) >= estimateCost(arr[1]));
  });

  test("grade sort uses computeGrade score", () => {
    const arr = [
      base({ chapters: 1, errors: 20, toolCounts: { Bash: 1 } }),
      base({ chapters: 10, errors: 0, inputTokens: 50_000, cacheReadTokens: 40_000, toolCounts: { Bash: 5 } }),
    ];
    sortSessionList(arr, "grade");
    assert.ok(computeGrade(arr[0]).score >= computeGrade(arr[1]).score);
  });

  test("duration sort orders by durationMs descending", () => {
    const arr = [
      base({ durationMs: 1000 }),
      base({ durationMs: 9000 }),
      base({}),
      base({ durationMs: 3000 }),
    ];
    sortSessionList(arr, "duration");
    assert.deepEqual(arr.map((s) => s.durationMs ?? 0), [9000, 3000, 1000, 0]);
  });

  test("tokens sort orders by totalTokens descending", () => {
    const arr = [
      base({ totalTokens: 100 }),
      base({ totalTokens: 50_000 }),
      base({}),
      base({ totalTokens: 5000 }),
    ];
    sortSessionList(arr, "tokens");
    assert.deepEqual(arr.map((s) => s.totalTokens ?? 0), [50_000, 5000, 100, 0]);
  });

  test("errors sort orders by errors descending", () => {
    const arr = [
      base({ errors: 1 }),
      base({ errors: 9 }),
      base({}),
      base({ errors: 3 }),
    ];
    sortSessionList(arr, "errors");
    assert.deepEqual(arr.map((s) => s.errors ?? 0), [9, 3, 1, 0]);
  });

  test("chapters sort orders by chapters descending", () => {
    const arr = [
      base({ chapters: 2 }),
      base({ chapters: 12 }),
      base({}),
      base({ chapters: 7 }),
    ];
    sortSessionList(arr, "chapters");
    assert.deepEqual(arr.map((s) => s.chapters ?? 0), [12, 7, 2, 0]);
  });

  test("files sort orders by files descending", () => {
    const arr = [
      base({ files: 4 }),
      base({ files: 22 }),
      base({}),
      base({ files: 9 }),
    ];
    sortSessionList(arr, "files");
    assert.deepEqual(arr.map((s) => s.files ?? 0), [22, 9, 4, 0]);
  });

  test("commits sort orders by commits descending", () => {
    const arr = [
      base({ commits: 1 }),
      base({ commits: 6 }),
      base({}),
      base({ commits: 2 }),
    ];
    sortSessionList(arr, "commits");
    assert.deepEqual(arr.map((s) => s.commits ?? 0), [6, 2, 1, 0]);
  });
});