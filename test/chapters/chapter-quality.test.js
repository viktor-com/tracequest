import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import {
  detectChapterRetries,
  classifyChapterOutcome,
  computeChapterEfficiency,
  enrichChaptersEfficiency,
  enrichChaptersQuality,
  summarizeChapterQuality,
} from "../../src/chapters/chapter-quality.js";
import {
  newChapter,
  buildChapterEventMaps,
  accumulateAssistantToolCall,
} from "../../src/chapters/chapter-accumulate.js";
import { buildSessionChapters } from "../../src/chapters/session-chapters.js";
import { CHAPTERS_JS } from "../../src/render/render-chapters.js";
import { CHAPTERS_HELPERS_JS } from "../../src/render/render-assemble.js";
import { assertPerf } from "../helpers/perf-assert.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, "../../src");
const ENRICH_EXPORT_RE = /export\s+(?:async\s+)?function\s+enrichChaptersQuality\b/;
const ENRICH_REEXPORT_RE = /export\s*\{[^}]*\benrichChaptersQuality\b/;

/** Collect paths under src/ whose file source matches a pattern. */
function srcFilesMatching(re) {
  const hits = [];
  function walk(dir) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".js") && re.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  }
  walk(SRC_ROOT);
  return hits;
}

function baseChapter(overrides = {}) {
  return {
    errors: 0,
    retries: 0,
    retryGroups: [],
    corrected: false,
    turns: 1,
    tokens: { input: 1000, output: 500, cacheHit: 0, cacheWrite: 0 },
    _fileKeys: ["a.js"],
    gitOps: [],
    toolCounts: { Read: 2 },
    commands: [],
    agents: [],
    thinking: [],
    ...overrides,
  };
}

function enrichOne(ch, avgTok = 1000) {
  detectChapterRetries(ch);
  classifyChapterOutcome(ch);
  delete ch._callSeq;
  computeChapterEfficiency(ch, avgTok);
  return ch;
}

describe("chapter-quality", () => {
  test("detectChapterRetries is no-op when _callSeq is missing or too short", () => {
    const missing = baseChapter();
    delete missing._callSeq;
    detectChapterRetries(missing);
    assert.equal(missing.retries, 0);
    assert.deepEqual(missing.retryGroups, []);

    const single = baseChapter({ _callSeq: [{ name: "Read", input: "/a.js" }] });
    detectChapterRetries(single);
    assert.equal(single.retries, 0);
  });

  test("detectChapterRetries groups similar consecutive Bash calls", () => {
    const ch = baseChapter({
      _callSeq: [
        { name: "Bash", input: "npm test" },
        { name: "Bash", input: "npm test --watch" },
      ],
    });
    detectChapterRetries(ch);
    assert.equal(ch.retries, 1);
    assert.equal(ch.retryGroups.length, 1);
    assert.equal(ch.retryGroups[0].tool, "Bash");
    assert.equal(ch.retryGroups[0].count, 2);
  });

  test("classifyChapterOutcome marks clean when no errors or retries", () => {
    const ch = baseChapter({ _callSeq: [] });
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    assert.equal(ch.outcome, "clean");
  });

  test("classifyChapterOutcome honors corrected flag over error count", () => {
    const ch = baseChapter({
      errors: 4,
      corrected: true,
      _callSeq: [{ name: "Bash", input: "x", isError: true }],
    });
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    assert.equal(ch.outcome, "corrected");
  });

  test("classifyChapterOutcome marks struggling at exactly three errors", () => {
    const ch = baseChapter({
      errors: 3,
      _callSeq: [
        { name: "Bash", input: "a", isError: true },
        { name: "Bash", input: "b", isError: true },
        { name: "Bash", input: "c", isError: true },
      ],
    });
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    assert.equal(ch.outcome, "struggling");
  });

  test("classifyChapterOutcome marks corrected for single error with multiple turns", () => {
    const ch = baseChapter({
      errors: 1,
      turns: 2,
      _callSeq: [{ name: "Edit", input: "/x.js", isError: true }],
    });
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    assert.equal(ch.outcome, "corrected");
  });

  test("classifyChapterOutcome marks struggling on many errors without correction", () => {
    const ch = baseChapter({
      errors: 4,
      _callSeq: [{ name: "Bash", input: "x", isError: true }],
    });
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    assert.equal(ch.outcome, "struggling");
  });

  test("computeChapterEfficiency flags wasteful high-token idle chapter", () => {
    const ch = baseChapter({
      _fileKeys: [],
      toolCounts: {},
      tokens: { input: 5000, output: 5000, cacheHit: 0, cacheWrite: 0 },
    });
    computeChapterEfficiency(ch, 1000);
    assert.equal(ch.efficiency.isWasteful, true);
    assert.ok(ch.efficiency.wasteReasons.length > 0);
  });

  test("computeChapterEfficiency treats zero session average as non-high-token", () => {
    const ch = baseChapter({
      _fileKeys: [],
      toolCounts: {},
      tokens: { input: 9000, output: 9000, cacheHit: 0, cacheWrite: 0 },
    });
    computeChapterEfficiency(ch, 0);
    assert.equal(
      ch.efficiency.wasteReasons.some((r) => r.includes("high tokens")),
      false
    );
  });

  test("computeChapterEfficiency boundary: at 1.5× average tokens idle chapter is not high-token", () => {
    const ch = baseChapter({
      _fileKeys: [],
      toolCounts: {},
      tokens: { input: 750, output: 750, cacheHit: 0, cacheWrite: 0 },
    });
    computeChapterEfficiency(ch, 1000);
    assert.equal(
      ch.efficiency.wasteReasons.some((r) => r.includes("high tokens")),
      false
    );
  });

  test("computeChapterEfficiency boundary: just above 1.5× average with no productivity is wasteful", () => {
    const ch = baseChapter({
      _fileKeys: [],
      toolCounts: { Read: 1 },
      commands: [],
      gitOps: [],
      tokens: { input: 751, output: 750, cacheHit: 0, cacheWrite: 0 },
    });
    computeChapterEfficiency(ch, 1000);
    assert.ok(ch.efficiency.wasteReasons.some((r) => r.includes("high tokens")));
  });

  test("computeChapterEfficiency flags heavy reading with no edits when tokens are high", () => {
    const ch = baseChapter({
      _fileKeys: ["a.js", "b.js"],
      toolCounts: { Read: 6 },
      tokens: { input: 4000, output: 2000, cacheHit: 0, cacheWrite: 0 },
      gitOps: [],
    });
    computeChapterEfficiency(ch, 1000);
    assert.ok(ch.efficiency.wasteReasons.some((r) => r.includes("heavy reading")));
  });

  test("computeChapterEfficiency flags reasoning-only chapters", () => {
    const ch = baseChapter({
      thinking: ["planning next step"],
      toolCounts: {},
      _fileKeys: [],
    });
    computeChapterEfficiency(ch, 500);
    assert.ok(ch.efficiency.wasteReasons.some((r) => r.includes("reasoning with no tool")));
  });

  test("enrichChaptersQuality handles empty chapter list", () => {
    const chapters = [];
    enrichChaptersQuality(chapters);
    assert.deepEqual(chapters, []);
    assert.doesNotThrow(() => summarizeChapterQuality(chapters));
  });

  test("enrichChaptersQuality removes _callSeq and sets efficiency from session average", () => {
    const chapters = [
      baseChapter({
        tokens: { input: 100, output: 100, cacheHit: 0, cacheWrite: 0 },
        _callSeq: [{ name: "Read", input: "/a.js" }],
      }),
      baseChapter({
        tokens: { input: 9000, output: 9000, cacheHit: 0, cacheWrite: 0 },
        _fileKeys: [],
        toolCounts: {},
        _callSeq: [{ name: "Read", input: "/b.js" }],
      }),
    ];
    enrichChaptersQuality(chapters);
    assert.equal(chapters[0]._callSeq, undefined);
    assert.equal(chapters[1]._callSeq, undefined);
    assert.ok(chapters[0].efficiency);
    assert.ok(chapters[1].efficiency);
    assert.equal(typeof chapters[0].efficiency.score, "number");
    assert.ok(chapters[1].efficiency.isWasteful);
  });
});

describe("summarizeChapterQuality", () => {
  test("empty list returns zeroed totals", () => {
    assert.deepEqual(summarizeChapterQuality([]), {
      chapters: 0,
      retries: 0,
      clean: 0,
      corrected: 0,
      struggling: 0,
      files: 0,
      commits: 0,
    });
  });

  test("chapters reflects array length", () => {
    const chapters = [baseChapter(), baseChapter(), baseChapter()];
    assert.equal(summarizeChapterQuality(chapters).chapters, 3);
  });

  test("sums retries and treats missing retries as zero", () => {
    const chapters = [
      baseChapter({ retries: 2 }),
      baseChapter({ retries: 3 }),
      baseChapter(),
    ];
    delete chapters[2].retries;
    assert.equal(summarizeChapterQuality(chapters).retries, 5);
  });

  test("counts clean, corrected, and struggling outcomes", () => {
    const chapters = [
      baseChapter({ outcome: "clean" }),
      baseChapter({ outcome: "clean" }),
      baseChapter({ outcome: "corrected" }),
      baseChapter({ outcome: "struggling" }),
    ];
    const q = summarizeChapterQuality(chapters);
    assert.equal(q.clean, 2);
    assert.equal(q.corrected, 1);
    assert.equal(q.struggling, 1);
    assert.equal(q.clean + q.corrected + q.struggling, chapters.length);
  });

  test("deduplicates _fileKeys across chapters for files total", () => {
    const chapters = [
      baseChapter({ _fileKeys: ["a.js", "b.js"] }),
      baseChapter({ _fileKeys: ["b.js", "c.js"] }),
      baseChapter({ _fileKeys: ["a.js"] }),
    ];
    assert.equal(summarizeChapterQuality(chapters).files, 3);
  });

  test("sums only commit gitOps across chapters", () => {
    const chapters = [
      baseChapter({
        gitOps: [
          { type: "commit", hash: "abc" },
          { type: "status", clean: true },
        ],
      }),
      baseChapter({
        gitOps: [
          { type: "commit", hash: "def" },
          { type: "commit", hash: "ghi" },
        ],
      }),
      baseChapter({ gitOps: [{ type: "diff", files: 1 }] }),
    ];
    assert.equal(summarizeChapterQuality(chapters).commits, 3);
  });

  test("unknown or missing outcome does not increment outcome buckets", () => {
    const chapters = [
      baseChapter({ outcome: "clean" }),
      baseChapter({ outcome: "mystery" }),
      baseChapter({}),
    ];
    const q = summarizeChapterQuality(chapters);
    assert.equal(q.clean, 1);
    assert.equal(q.corrected, 0);
    assert.equal(q.struggling, 0);
    assert.equal(q.chapters, 3);
  });

  test("mixed chapters produce full aggregate snapshot", () => {
    const chapters = [
      baseChapter({
        retries: 1,
        outcome: "corrected",
        _fileKeys: ["x.js"],
        gitOps: [{ type: "commit", hash: "1" }],
      }),
      baseChapter({
        retries: 2,
        outcome: "struggling",
        _fileKeys: ["x.js", "y.js"],
        gitOps: [],
      }),
      baseChapter({
        outcome: "clean",
        _fileKeys: [],
        gitOps: [{ type: "commit", hash: "2" }, { type: "commit", hash: "3" }],
      }),
    ];
    assert.deepEqual(summarizeChapterQuality(chapters), {
      chapters: 3,
      retries: 3,
      clean: 1,
      corrected: 1,
      struggling: 1,
      files: 2,
      commits: 3,
    });
  });
});

function buildChaptersWithCallSeq(chapterCount, callsPerChapter) {
  const events = [];
  for (let i = 0; i < chapterCount; i++) {
    events.push({ type: "user", text: "task " + i, timestamp: "2026-01-01T00:00:00.000Z" });
    const toolCalls = Array.from({ length: callsPerChapter }, (_, j) => ({
      id: "t" + i + "_" + j,
      name: j % 3 === 0 ? "Bash" : j % 2 ? "Read" : "Edit",
      input:
        j % 3 === 0
          ? "npm test --watch " + j
          : "/proj/src/deep/file" + (i % 8) + "_" + j + ".js",
    }));
    events.push({
      type: "assistant",
      text: "working",
      toolCalls,
      tokens: { input: 2000, output: 800 },
      timestamp: "2026-01-01T00:00:01.000Z",
    });
    for (const tc of toolCalls) {
      events.push({
        type: "tool_result",
        toolUseId: tc.id,
        text: "ok",
        isError: false,
        timestamp: "2026-01-01T00:00:02.000Z",
      });
    }
  }
  const { resultMap } = buildChapterEventMaps(events);
  const chapters = [];
  let current = null;
  for (const e of events) {
    if (e.type === "user" && e.text) {
      if (current) chapters.push(current);
      current = newChapter(e.text, e.timestamp);
      continue;
    }
    if (!current) continue;
    if (e.type === "assistant") {
      for (const tc of e.toolCalls || []) {
        accumulateAssistantToolCall(current, tc, resultMap, { trackCallSeq: true });
      }
    }
  }
  if (current) chapters.push(current);
  return chapters;
}

describe("enrichChaptersQuality performance", () => {
  test("precomputed _callSeq keys keep retry/outcome scan fast on large sessions (perf)", () => {
    const accumulateSrc = readFileSync(join(SRC_ROOT, "chapters/chapter-accumulate.js"), "utf8");
    const patternsSrc = readFileSync(join(SRC_ROOT, "chapters/chapter-patterns.js"), "utf8");
    const qualitySrc = readFileSync(join(SRC_ROOT, "chapters/chapter-quality.js"), "utf8");
    assert.ok(accumulateSrc.includes("entry._path = filePath"));
    assert.ok(patternsSrc.includes("isSimilarCallEntry"));
    assert.ok(qualitySrc.includes("ch.selfCorrections = selfCorrections"));
    assert.ok(!qualitySrc.includes("chapters.reduce"));

    const chapters = buildChaptersWithCallSeq(500, 15);
    const editEntry = chapters[0]._callSeq.find((e) => e.name === "Edit");
    assert.ok(editEntry && editEntry._path, "accumulate should reuse shortToolPath on _callSeq entries");

    const ITERS = 100;
    for (let w = 0; w < 3; w++) {
      for (const ch of chapters) {
        detectChapterRetries(ch);
        classifyChapterOutcome(ch);
        ch.retries = 0;
        ch.retryGroups = [];
        delete ch.selfCorrections;
        delete ch.outcome;
      }
    }
    const t0 = performance.now();
    for (let n = 0; n < ITERS; n++) {
      for (const ch of chapters) {
        detectChapterRetries(ch);
        classifyChapterOutcome(ch);
        assert.ok(ch.outcome);
      }
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 2,
      `expected detect+classify under 2ms/op on 500×15-call chapters (merged _callSeq scan), got ${ms.toFixed(3)}ms`,
    );
  });
});

describe("enrichChaptersQuality export surface", () => {
  test("chapter-quality module exports enrichChaptersQuality", async () => {
    const mod = await import("../../src/chapters/chapter-quality.js");
    assert.equal(typeof mod.enrichChaptersQuality, "function");
  });

  test("session-chapters and render-enrich do not re-export enrichChaptersQuality", async () => {
    const session = await import("../../src/chapters/session-chapters.js");
    const renderEnrich = await import("../../src/chapters/chapter-render-enrich.js");
    assert.equal(session.enrichChaptersQuality, undefined);
    assert.equal(renderEnrich.enrichChaptersQuality, undefined);
  });

  test("only chapter-quality.js defines enrichChaptersQuality as an ESM export", () => {
    const owners = srcFilesMatching(ENRICH_EXPORT_RE);
    assert.equal(owners.length, 1);
    assert.ok(owners[0].replace(/\\/g, "/").endsWith("src/chapters/chapter-quality.js"));
    assert.deepEqual(srcFilesMatching(ENRICH_REEXPORT_RE), []);
  });

  test("session-chapters source calls enrichChaptersQualityCore without re-exporting it", () => {
    const src = readFileSync(join(SRC_ROOT, "chapters/session-chapters.js"), "utf8");
    assert.doesNotMatch(src, /enrichChaptersEfficiency\s*\(/);
    assert.doesNotMatch(src, ENRICH_REEXPORT_RE);
    assert.doesNotMatch(src, ENRICH_EXPORT_RE);
  });
});

describe("chapter-quality session edges", () => {
  test("empty session yields no chapters and zeroed quality summary", () => {
    const chapters = buildSessionChapters({ startTime: "2026-01-01T00:00:00.000Z", events: [] });
    const q = summarizeChapterQuality(chapters);
    assert.deepEqual(chapters, []);
    assert.deepEqual(q, {
      chapters: 0,
      retries: 0,
      clean: 0,
      corrected: 0,
      struggling: 0,
      files: 0,
      commits: 0,
    });
  });

  test("duplicate chapter titles enrich independently", () => {
    const session = {
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "fix the bug", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          toolCalls: [{ id: "r1", name: "Read", input: "/a.js" }],
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        { type: "tool_result", toolUseId: "r1", text: "ok", timestamp: "2026-01-01T00:00:02.000Z" },
        { type: "user", text: "fix the bug", timestamp: "2026-01-01T00:00:03.000Z" },
        {
          type: "assistant",
          toolCalls: [
            { id: "b1", name: "Bash", input: "npm test" },
            { id: "b2", name: "Bash", input: "npm test" },
          ],
          timestamp: "2026-01-01T00:00:04.000Z",
        },
        { type: "tool_result", toolUseId: "b1", text: "fail", isError: true, timestamp: "2026-01-01T00:00:05.000Z" },
        { type: "tool_result", toolUseId: "b2", text: "ok", timestamp: "2026-01-01T00:00:06.000Z" },
      ],
    };
    const chapters = buildSessionChapters(session);
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].prompt, chapters[1].prompt);
    assert.equal(chapters[0].outcome, "clean");
    assert.ok(chapters[1].retries >= 1);
    assert.notEqual(chapters[0].outcome, chapters[1].outcome);
  });

  test("all-tool chapter accumulates every tool family with quality enrichment", () => {
    const session = {
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "do everything", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          tokens: { input: 200, output: 100, cacheHit: 0, cacheWrite: 0 },
          toolCalls: [
            { id: "r1", name: "Read", input: "/proj/a.js" },
            { id: "e1", name: "Edit", input: "/proj/a.js" },
            { id: "w1", name: "Write", input: "/proj/b.js" },
            { id: "b1", name: "Bash", input: "git status" },
            { id: "g1", name: "Grep", input: "pattern" },
            {
              id: "wf1",
              name: "WebFetch",
              input: "https://example.com",
              webInfo: { type: "fetch", url: "https://example.com" },
            },
            {
              id: "ws1",
              name: "WebSearch",
              input: "query",
              webInfo: { type: "search", query: "query" },
            },
            {
              id: "ag1",
              name: "Task",
              agentInfo: { description: "sub", subagentType: "explore" },
            },
            {
              id: "m1",
              name: "mcp_tool",
              mcpInfo: { server: "srv", tool: "ping", rawName: "mcp_tool" },
            },
          ],
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        { type: "tool_result", toolUseId: "r1", text: "file", timestamp: "2026-01-01T00:00:02.000Z" },
        { type: "tool_result", toolUseId: "e1", text: "edited", timestamp: "2026-01-01T00:00:03.000Z" },
        { type: "tool_result", toolUseId: "w1", text: "written", timestamp: "2026-01-01T00:00:04.000Z" },
        { type: "tool_result", toolUseId: "b1", text: "clean", timestamp: "2026-01-01T00:00:05.000Z" },
        { type: "tool_result", toolUseId: "g1", text: "line\n", timestamp: "2026-01-01T00:00:06.000Z" },
        {
          type: "tool_result",
          toolUseId: "wf1",
          text: "# Page Title\nbody",
          timestamp: "2026-01-01T00:00:07.000Z",
        },
        {
          type: "tool_result",
          toolUseId: "ws1",
          text: '{"results":[{"title":"Hit","url":"https://hit"}]}',
          timestamp: "2026-01-01T00:00:08.000Z",
        },
        { type: "tool_result", toolUseId: "ag1", text: "done", timestamp: "2026-01-01T00:00:09.000Z" },
        { type: "tool_result", toolUseId: "m1", text: "pong", timestamp: "2026-01-01T00:00:10.000Z" },
      ],
    };
    const chapters = buildSessionChapters(session);
    enrichChaptersEfficiency(chapters);
    assert.equal(chapters.length, 1);
    const ch = chapters[0];
    assert.ok(ch.toolCounts.Read >= 1);
    assert.ok(ch.toolCounts.Edit >= 1);
    assert.ok(ch.toolCounts.Write >= 1);
    assert.ok(ch.toolCounts.Bash >= 1);
    assert.ok(ch.toolCounts.Grep >= 1);
    assert.ok(ch.searches.length >= 1);
    assert.ok(ch.webOps.length >= 2);
    assert.ok(ch.agents.length >= 1);
    assert.ok(ch.mcpOps.length >= 1);
    assert.ok(ch.efficiency);
    assert.ok(["clean", "corrected", "struggling"].includes(ch.outcome));
  });

  test("error-only chapter marks struggling with failed-retry waste", () => {
    const session = {
      startTime: "2026-01-01T00:00:00.000Z",
      events: [
        { type: "user", text: "keep failing", timestamp: "2026-01-01T00:00:00.000Z" },
        {
          type: "assistant",
          toolCalls: [
            { id: "b1", name: "Bash", input: "npm test" },
            { id: "b2", name: "Bash", input: "npm test" },
            { id: "b3", name: "Bash", input: "npm test" },
            { id: "b4", name: "Bash", input: "npm test" },
          ],
          timestamp: "2026-01-01T00:00:01.000Z",
        },
        { type: "tool_result", toolUseId: "b1", text: "e1", isError: true, timestamp: "2026-01-01T00:00:02.000Z" },
        { type: "tool_result", toolUseId: "b2", text: "e2", isError: true, timestamp: "2026-01-01T00:00:03.000Z" },
        { type: "tool_result", toolUseId: "b3", text: "e3", isError: true, timestamp: "2026-01-01T00:00:04.000Z" },
        { type: "tool_result", toolUseId: "b4", text: "e4", isError: true, timestamp: "2026-01-01T00:00:05.000Z" },
      ],
    };
    const chapters = buildSessionChapters(session);
    enrichChaptersEfficiency(chapters);
    const ch = chapters[0];
    assert.equal(ch.errors, 4);
    assert.equal(ch.outcome, "struggling");
    assert.ok(ch.retries >= 3);
    assert.ok(
      ch.efficiency.wasteReasons.some(
        (r) => r.includes("errors") || r.includes("failed retries")
      )
    );
  });

  test("single-chapter session uses its own tokens as average (no false high-token)", () => {
    const ch = enrichOne(
      baseChapter({
        tokens: { input: 2000, output: 2000, cacheHit: 0, cacheWrite: 0 },
        _fileKeys: ["only.js"],
        toolCounts: { Edit: 1 },
        _callSeq: [],
      }),
      4000
    );
    assert.equal(ch.efficiency.wasteReasons.some((r) => r.includes("high tokens")), false);
  });
});

describe("chapter-quality scoring edges", () => {
  test("computeChapterEfficiency floors effScore at 10 under max penalties", () => {
    const ch = baseChapter({
      errors: 10,
      retries: 10,
      selfCorrections: 0,
      _fileKeys: [],
      toolCounts: { Read: 10 },
      tokens: { input: 6000, output: 6000, cacheHit: 0, cacheWrite: 0 },
    });
    computeChapterEfficiency(ch, 1000);
    assert.equal(ch.efficiency.score, 10);
    assert.equal(ch.efficiency.isWasteful, true);
    assert.ok(ch.efficiency.wasteTokens > 0);
  });

  test("computeChapterEfficiency self-correction bonus raises score when retries are equal", () => {
    const withBonus = baseChapter({
      errors: 2,
      retries: 1,
      selfCorrections: 2,
      toolCounts: { Edit: 4 },
    });
    const withoutBonus = baseChapter({
      errors: 2,
      retries: 1,
      selfCorrections: 0,
      toolCounts: { Edit: 4 },
    });
    computeChapterEfficiency(withBonus, 1000);
    computeChapterEfficiency(withoutBonus, 1000);
    assert.equal(withBonus.efficiency.score - withoutBonus.efficiency.score, 10);
  });

  test("computeChapterEfficiency derives tokPerFile, tokPerCommit, and errorTokens", () => {
    const ch = baseChapter({
      tokens: { input: 3000, output: 1000, cacheHit: 0, cacheWrite: 0 },
      _fileKeys: ["a.js", "b.js"],
      toolCounts: { Read: 2, Bash: 2 },
      gitOps: [{ type: "commit", hash: "abc" }],
      errors: 1,
    });
    computeChapterEfficiency(ch, 10000);
    assert.equal(ch.efficiency.tokPerFile, 2000);
    assert.equal(ch.efficiency.tokPerCommit, 4000);
    assert.equal(ch.efficiency.errorTokens, 1000);
    assert.equal(ch.efficiency.isWasteful, false);
    assert.equal(ch.efficiency.wasteTokens, 0);
  });

  test("computeChapterEfficiency flags exactly three failed retries without self-correction", () => {
    const ch = baseChapter({
      retries: 3,
      selfCorrections: 0,
      retryGroups: [{ tool: "Bash", count: 4, input: "npm test" }],
      toolCounts: { Bash: 4 },
      _callSeq: [
        { name: "Bash", input: "npm test" },
        { name: "Bash", input: "npm test" },
        { name: "Bash", input: "npm test" },
        { name: "Bash", input: "npm test" },
      ],
    });
    enrichOne(ch, 1000);
    assert.ok(
      ch.efficiency.wasteReasons.some((r) => r.includes("failed retries without resolution"))
    );
  });

  test("classifyChapterOutcome marks corrected for two retries without hitting struggling threshold", () => {
    const ch = baseChapter({
      errors: 0,
      retries: 2,
      _callSeq: [
        { name: "Bash", input: "npm test" },
        { name: "Bash", input: "npm test" },
        { name: "Bash", input: "npm test" },
      ],
    });
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    assert.equal(ch.retries, 2);
    assert.equal(ch.outcome, "corrected");
  });

  test("classifyChapterOutcome prefers corrected when selfCorrections meet half of errors", () => {
    const ch = baseChapter({
      errors: 4,
      _callSeq: [
        { name: "Edit", input: "/x.js", isError: true },
        { name: "Edit", input: "/x.js", isError: false },
        { name: "Edit", input: "/y.js", isError: true },
        { name: "Edit", input: "/y.js", isError: false },
      ],
    });
    detectChapterRetries(ch);
    classifyChapterOutcome(ch);
    assert.ok(ch.selfCorrections >= 2);
    assert.equal(ch.outcome, "corrected");
  });

  test("computeChapterEfficiency ok commands count toward productivity and avoid tokRatio penalty", () => {
    const productive = baseChapter({
      tokens: { input: 5000, output: 5000, cacheHit: 0, cacheWrite: 0 },
      _fileKeys: ["a.js"],
      toolCounts: { Bash: 2 },
      commands: [{ cmd: "make", ok: true }, { cmd: "test", ok: true }],
      errors: 0,
      retries: 0,
    });
    const idle = baseChapter({
      tokens: { input: 5000, output: 5000, cacheHit: 0, cacheWrite: 0 },
      _fileKeys: [],
      toolCounts: { Read: 2 },
      commands: [],
      errors: 0,
      retries: 0,
    });
    enrichOne(productive, 1000);
    enrichOne(idle, 1000);
    assert.ok(productive.efficiency.score >= idle.efficiency.score);
    assert.equal(
      idle.efficiency.wasteReasons.some((r) => r.includes("high tokens")),
      true
    );
  });
});

describe("chapter-quality browser injection", () => {
  test("buildChapters sets retries, outcome, and efficiency via injected helpers", () => {
    const events = [
      { type: "user", text: "run tests", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        type: "assistant",
        toolCalls: [
          { id: "b1", name: "Bash", input: "npm test" },
          { id: "b2", name: "Bash", input: "npm test" },
        ],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      { type: "tool_result", toolUseId: "b1", text: "fail", isError: true, timestamp: "2026-01-01T00:00:02.000Z" },
      { type: "tool_result", toolUseId: "b2", text: "ok", timestamp: "2026-01-01T00:00:03.000Z" },
    ];
    const script = new Script(`
      const session = { startTime: '2026-01-01T00:00:00.000Z' };
      ${CHAPTERS_HELPERS_JS}
      ${CHAPTERS_JS}
      buildChapters();
    `);
    const chapters = script.runInNewContext({ events, Object, Array, String, Math, Date, Set });
    assert.equal(chapters.length, 1);
    assert.ok(chapters[0].retries >= 1);
    assert.ok(chapters[0].efficiency);
    assert.ok(["clean", "corrected", "struggling"].includes(chapters[0].outcome));
  });
});