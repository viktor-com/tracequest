import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Script } from "node:vm";
import { enrichChaptersForRender } from "../../src/chapters/chapter-render-enrich.js";
import { joinBundleParts } from "../../src/render/join-bundle.js";
import {
  CHAPTERS_BUNDLE_PARTS,
  CHAPTERS_HELPERS_JS,
} from "../../src/render/render-assemble.js";
import { CHAPTERS_JS } from "../../src/render/render-chapters.js";
import { assertPerf } from "../helpers/perf-assert.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Packed bigram key matching enrichChaptersForRender _tokenBigrams storage. */
function tokenKey(q) {
  return (q.charCodeAt(0) << 16) | q.charCodeAt(1);
}

function hasChapterToken(ch, q) {
  if (q.length === 1) {
    const c = q.charCodeAt(0);
    if (c < 256) return !!(ch._charBits[c >>> 5] & (1 << (c & 31)));
    return ch._extraChars.has(q);
  }
  return ch._tokenBigrams.has(tokenKey(q));
}

function renderChapter(overrides = {}) {
  return {
    prompt: "",
    lastAssistantText: "",
    errors: 0,
    outcome: "clean",
    files: {},
    commands: [],
    searches: [],
    agents: [],
    diffs: [],
    gitOps: [],
    webOps: [],
    thinking: [],
    mcpOps: [],
    ...overrides,
  };
}

function chaptersWithFileKeys(specs) {
  return specs.map((spec) => {
    const ch = renderChapter(spec);
    ch._fileKeys = spec._fileKeys ?? Object.keys(ch.files);
    return ch;
  });
}

describe("enrichChaptersForRender deps", () => {
  test("initializes empty deps on every chapter", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["a.js"] },
      { _fileKeys: [] },
    ]);
    enrichChaptersForRender(chapters);
    for (const ch of chapters) {
      assert.deepEqual(ch.deps, {
        continuesFrom: [],
        fixesFrom: [],
        sharedFiles: {},
      });
    }
  });

  test("skips lookback when chapter has no files and zero errors", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["shared.js"], outcome: "clean" },
      { _fileKeys: [], errors: 0 },
    ]);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters[1].deps.continuesFrom, []);
    assert.deepEqual(chapters[1].deps.fixesFrom, []);
    assert.deepEqual(chapters[1].deps.sharedFiles, {});
  });

  test("still scans lookback when errors > 0 without files", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["only.js"], errors: 0 },
      { _fileKeys: [], errors: 1 },
    ]);
    enrichChaptersForRender(chapters);
    assert.ok(chapters[1].deps);
    assert.deepEqual(chapters[1].deps.continuesFrom, []);
  });

  test("continuesFrom when at least two files overlap", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["a.js", "b.js"] },
      { _fileKeys: ["a.js", "b.js", "c.js"] },
    ]);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters[1].deps.continuesFrom, [0]);
    assert.deepEqual(chapters[1].deps.sharedFiles[0], ["a.js", "b.js"]);
  });

  test("continuesFrom when shared files reach 50% of current chapter files", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["x.js", "y.js"] },
      { _fileKeys: ["x.js", "z.js"] },
    ]);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters[1].deps.continuesFrom, [0]);
    assert.deepEqual(chapters[1].deps.sharedFiles[0], ["x.js"]);
  });

  test("does not continuesFrom with a single overlap on three-file chapters", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["a.js", "b.js", "c.js"] },
      { _fileKeys: ["a.js", "d.js", "e.js"] },
    ]);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters[1].deps.continuesFrom, []);
    assert.deepEqual(chapters[1].deps.sharedFiles[0], ["a.js"]);
  });

  test("fixesFrom when prior chapter was struggling and removes continuesFrom", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["fix.js", "other.js"], outcome: "struggling" },
      { _fileKeys: ["fix.js", "other.js"] },
    ]);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters[1].deps.fixesFrom, [0]);
    assert.deepEqual(chapters[1].deps.continuesFrom, []);
    assert.deepEqual(chapters[1].deps.sharedFiles[0], ["fix.js", "other.js"]);
  });

  test("fixesFrom when prior chapter has two or more errors", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["err.js"], errors: 2, outcome: "corrected" },
      { _fileKeys: ["err.js", "new.js"] },
    ]);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters[1].deps.fixesFrom, [0]);
    assert.deepEqual(chapters[1].deps.continuesFrom, []);
  });

  test("lookback window is at most ten prior chapters", () => {
    const specs = Array.from({ length: 12 }, (_, i) => {
      if (i === 0) return { _fileKeys: ["only-ch0.js"], outcome: "clean" };
      if (i === 11) return { _fileKeys: ["only-ch0.js", "tail.js"], outcome: "clean" };
      return { _fileKeys: ["unrelated.js"], outcome: "clean" };
    });
    const chapters = chaptersWithFileKeys(specs);
    enrichChaptersForRender(chapters);
    const last = chapters[11];
    assert.deepEqual(last.deps.continuesFrom, []);
    assert.deepEqual(last.deps.fixesFrom, []);
    assert.equal(Object.keys(last.deps.sharedFiles).length, 0);
  });

  test("merges transitive chapters into one workflow chain for _depSummary", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["chain.js"] },
      { _fileKeys: ["chain.js", "extra.js"] },
      { _fileKeys: ["chain.js", "extra.js", "more.js"] },
    ]);
    enrichChaptersForRender(chapters);
    assert.deepEqual(chapters._depSummary, { chains: 1, chaptersInChains: 3 });
  });

  test("omits _depSummary when chapters array is empty", () => {
    const chapters = [];
    enrichChaptersForRender(chapters);
    assert.equal(chapters._depSummary, undefined);
  });
});

describe("enrichChaptersForRender filter cache", () => {
  test("lowercases prompt, assistant text, and file keys", () => {
    const chapters = chaptersWithFileKeys([
      {
        prompt: "Fix Foo",
        lastAssistantText: "Done BAR",
        _fileKeys: ["Src/File.JS"],
      },
    ]);
    enrichChaptersForRender(chapters);
    const ch = chapters[0];
    assert.equal(ch._promptLower, "fix foo");
    assert.equal(ch._lastAssistantTextLower, "done bar");
    assert.deepEqual(ch._fileKeysLower, ["src/file.js"]);
  });

  test("lowercases nested tool, diff, git, web, agent, and mcp fields", () => {
    const chapters = chaptersWithFileKeys([
      {
        _fileKeys: [],
        commands: [{ cmd: "ECHO Hi", output: "OUT Put" }],
        searches: [{ query: "Find ME" }],
        agents: [{ description: "Agent DESC", prompt: "Agent PROMPT" }],
        diffs: [
          {
            path: "Path/TO.js",
            diffInfo: { oldStr: "OLD", newStr: "NEW", content: "BODY" },
          },
        ],
        gitOps: [
          {
            message: "MSG",
            branch: "MAIN",
            hash: "AbCd",
            cmd: "GIT Status",
          },
        ],
        webOps: [
          {
            url: "HTTPS://Ex.com",
            query: "Web Q",
            pageTitle: "Page TITLE",
            results: [{ title: "Res TITLE", url: "HTTPS://Res.com" }],
          },
        ],
        mcpOps: [
          {
            server: "MCP Server",
            tool: "MCP Tool",
            rawName: "mcp_tool",
            params: { key: "Param VAL" },
          },
        ],
        thinking: ["Think MIXED"],
      },
    ]);
    enrichChaptersForRender(chapters);
    const ch = chapters[0];
    assert.equal(ch.commands[0]._cmdLower, "echo hi");
    assert.equal(ch.commands[0]._outputLower, "out put");
    assert.equal(ch.searches[0]._queryLower, "find me");
    assert.equal(ch.agents[0]._descriptionLower, "agent desc");
    assert.equal(ch.diffs[0].diffInfo._contentLower, "body");
    assert.equal(ch.gitOps[0]._branchLower, "main");
    assert.equal(ch.webOps[0].results[0]._titleLower, "res title");
    assert.deepEqual(ch.mcpOps[0]._paramValsLower, ["param val"]);
    assert.deepEqual(ch._thinkingLower, ["think mixed"]);
  });

  test("treats missing optional strings as empty lowercase fields", () => {
    const chapters = chaptersWithFileKeys([
      {
        prompt: undefined,
        lastAssistantText: null,
        _fileKeys: [],
        commands: [{ cmd: undefined, output: null }],
        diffs: [{ path: undefined, diffInfo: null }],
        gitOps: [{ message: undefined }],
        webOps: [{ url: undefined, results: undefined }],
        mcpOps: [{ server: undefined, params: {} }],
      },
    ]);
    enrichChaptersForRender(chapters);
    const ch = chapters[0];
    assert.equal(ch._promptLower, "");
    assert.equal(ch.commands[0]._cmdLower, "");
    assert.equal(ch.diffs[0]._pathLower, "");
    assert.equal(ch.diffs[0].diffInfo, null);
    assert.equal(ch.webOps[0]._urlLower, "");
  });

  test("builds _charBits and _tokenBigrams with single- and double-character substrings", () => {
    const chapters = chaptersWithFileKeys([
      {
        prompt: "ab",
        _fileKeys: ["xy.js"],
        commands: [],
      },
    ]);
    enrichChaptersForRender(chapters);
    const ch = chapters[0];
    assert.ok(ch._charBits instanceof Uint32Array);
    assert.ok(ch._tokenBigrams instanceof Set);
    assert.ok(hasChapterToken(ch, "a"));
    assert.ok(hasChapterToken(ch, "ab"));
    assert.ok(hasChapterToken(ch, "x"));
    assert.ok(hasChapterToken(ch, "xy"));
    assert.ok(hasChapterToken(ch, ".j"));
  });

  test("reuses EMPTY_DEPS sentinel for chapters with no files and zero errors", () => {
    const chapters = chaptersWithFileKeys([
      { _fileKeys: ["a.js"] },
      { _fileKeys: [], errors: 0 },
      { _fileKeys: [], errors: 0 },
    ]);
    enrichChaptersForRender(chapters);
    assert.equal(chapters[1].deps, chapters[2].deps);
    assert.deepEqual(chapters[1].deps, {
      continuesFrom: [],
      fixesFrom: [],
      sharedFiles: {},
    });
  });
});

const VM_CTX = { Object, Array, String, Math, Date, Set, Uint32Array };

function enrichSnapshot(chapters) {
  return JSON.parse(
    JSON.stringify({
      depSummary: chapters._depSummary,
      chapters: chapters.map((ch) => {
        const row = {
          deps: ch.deps,
          promptLower: ch._promptLower,
          lastAssistantLower: ch._lastAssistantTextLower,
          fileKeysLower: ch._fileKeysLower,
          tokenBigramSize: ch._tokenBigrams?.size ?? 0,
        };
        const cmdLower = ch.commands[0]?._cmdLower;
        const searchQueryLower = ch.searches[0]?._queryLower;
        if (cmdLower !== undefined) row.cmdLower = cmdLower;
        if (searchQueryLower !== undefined) row.searchQueryLower = searchQueryLower;
        return row;
      }),
    }),
  );
}

function runInjectedEnrich(bundle, chapters) {
  return new Script(`${bundle}\nenrichChaptersForRender(chapters);\nchapters;`).runInNewContext({
    ...VM_CTX,
    chapters,
  });
}

describe("chapter-render-enrich browser injection", () => {
  test("enrichChaptersForRender bundle part is present and export-free", () => {
    const part = CHAPTERS_BUNDLE_PARTS.find((p) => p.id === "enrichChaptersForRender");
    assert.ok(part, "CHAPTERS_BUNDLE_PARTS should include enrichChaptersForRender");
    assert.ok(part.source.length > 20, "enrichChaptersForRender should have substantial source");
    assert.ok(!part.source.startsWith("export "), "injected source must not retain export");
    assert.match(part.source, /^function enrichChaptersForRender/);
  });

  test("injected enrichChaptersForRender matches module enrich output in VM", () => {
    const specs = [
      {
        _fileKeys: ["chain.js", "extra.js"],
        prompt: "Start CHAIN",
        lastAssistantText: "Working",
        outcome: "clean",
      },
      {
        _fileKeys: ["chain.js", "extra.js", "more.js"],
        prompt: "Continue CHAIN",
        outcome: "clean",
      },
      {
        _fileKeys: ["fix.js", "other.js"],
        prompt: "Fix FAIL",
        outcome: "struggling",
        errors: 2,
      },
      {
        _fileKeys: ["fix.js", "new.js"],
        prompt: "Retry FIX",
        commands: [{ cmd: "RUN Test", output: "OK Done" }],
        searches: [{ query: "Find BUG" }],
      },
    ];
    const makeChapters = () => chaptersWithFileKeys(specs);
    const moduleChapters = makeChapters();
    enrichChaptersForRender(moduleChapters);

    const bundle = joinBundleParts(
      CHAPTERS_BUNDLE_PARTS.filter((p) =>
        p.id === "enrichChaptersForRender" || p.id === "chapterFileKeys"),
    );
    const vmChapters = makeChapters();
    runInjectedEnrich(bundle, vmChapters);

    assert.deepEqual(enrichSnapshot(vmChapters), enrichSnapshot(moduleChapters));
    assert.ok(hasChapterToken(vmChapters[3], "ru"));
    assert.ok(hasChapterToken(vmChapters[3], "fi"));
    assert.equal(vmChapters[1].deps.continuesFrom[0], 0);
    assert.equal(vmChapters[3].deps.fixesFrom[0], 2);
    assert.equal(vmChapters[3].deps.continuesFrom.length, 0);
    assert.equal(vmChapters._depSummary.chains, 2);
    assert.equal(vmChapters._depSummary.chaptersInChains, 4);
  });

  test("render-assemble imports chapter-render-enrich module", () => {
    const src = readFileSync(
      join(__dirname, "../../src/render/render-assemble.js"),
      "utf8"
    );
    assert.ok(src.includes("enrichChaptersForRender"));
  });

  test("mcp param enrichment uses for-in not Object.values(m.params)", () => {
    const src = readFileSync(
      join(__dirname, "../../src/chapters/chapter-render-enrich.js"),
      "utf8"
    );
    assert.ok(!src.match(/Object\.values\(m\.params\)/));
    assert.ok(src.includes("_paramValsLower"));
  });

  test("merged lower+token pass avoids second nested-array walk (perf)", () => {
    const src = readFileSync(
      join(__dirname, "../../src/chapters/chapter-render-enrich.js"),
      "utf8"
    );

    const specs = Array.from({ length: 500 }, (_, i) => ({
      prompt: "Fix authentication module issue number " + i,
      lastAssistantText: "I will help you fix the MixedCase problem " + i,
      errors: i % 5 === 0 ? 2 : 0,
      outcome: i % 7 === 0 ? "struggling" : "clean",
      _fileKeys: ["src/shared/file" + (i % 3) + ".js", "src/other" + i + ".js"],
      commands: Array.from({ length: 8 }, (_, j) => ({
        cmd: "npm run test-" + j + " UPPER",
        output: "Output line " + j + " with SOME text content here",
      })),
      searches: [{ query: "Find Pattern " + i }],
      agents: [{ description: "Agent DESC " + i, prompt: "Agent PROMPT " + i }],
      diffs: Array.from({ length: 4 }, (_, j) => ({
        path: "src/module/file" + j + ".ts",
        diffInfo: { oldStr: "OLD str " + j, newStr: "NEW str " + j, content: "BODY " + j },
      })),
      gitOps: [{ message: "MSG", branch: "MAIN", hash: "AbCd", cmd: "git status" }],
      webOps: [
        {
          url: "https://ex.com",
          query: "Web Q",
          pageTitle: "Title",
          results: [{ title: "Res", url: "https://r.com" }],
        },
      ],
      thinking: ["Think about " + i],
      mcpOps: [{ server: "MCP", tool: "Tool", rawName: "mcp_tool", params: { key: "VAL" } }],
    }));
    const ITERS = 40;
    for (let w = 0; w < 3; w++) {
      enrichChaptersForRender(chaptersWithFileKeys(specs));
    }
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) {
      const chapters = chaptersWithFileKeys(specs);
      enrichChaptersForRender(chapters);
      assert.ok(hasChapterToken(chapters[0], "fi"));
      assert.equal(chapters[0]._promptLower, "fix authentication module issue number 0");
    }
    const ms = (performance.now() - t0) / ITERS;
    assertPerf(
      ms < 20,
      `expected enrichChaptersForRender under 20ms/op on 500 chapters, got ${ms.toFixed(2)}ms`,
    );
  });

  test("injected helpers run enrichChaptersForRender after buildSessionChapters in VM", () => {
    const events = [
      { type: "user", text: "edit shared", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        type: "assistant",
        toolCalls: [{ id: "e1", name: "Edit", input: "/proj/src/shared.js" }],
        timestamp: "2026-01-01T00:00:01.000Z",
      },
      { type: "tool_result", toolUseId: "e1", text: "fail", isError: true, timestamp: "2026-01-01T00:00:02.000Z" },
      { type: "user", text: "retry shared", timestamp: "2026-01-01T00:00:03.000Z" },
      {
        type: "assistant",
        toolCalls: [{ id: "e2", name: "Edit", input: "/proj/src/shared.js" }],
        timestamp: "2026-01-01T00:00:04.000Z",
      },
      { type: "tool_result", toolUseId: "e2", text: "ok", timestamp: "2026-01-01T00:00:05.000Z" },
    ];
    const script = new Script(`
      const session = { startTime: '2026-01-01T00:00:00.000Z' };
      ${CHAPTERS_HELPERS_JS}
      ${CHAPTERS_JS}
      buildChapters();
    `);
    const chapters = script.runInNewContext({
      events,
      Object,
      Array,
      String,
      Math,
      Date,
      Set,
      Uint32Array,
    });
    assert.equal(chapters.length, 2);
    assert.ok(chapters[0].deps);
    assert.ok(chapters[1]._charBits instanceof Uint32Array);
    assert.ok(chapters[1]._tokenBigrams instanceof Set);
    assert.equal(chapters[1]._promptLower, "retry shared");
    assert.ok(chapters._depSummary);
  });

  test("injected enrichChaptersForRender can be called directly on stub chapters", () => {
    const script = new Script(`
      ${CHAPTERS_HELPERS_JS}
      const chapters = [
        { prompt: 'A', lastAssistantText: '', errors: 0, outcome: 'clean', files: {}, commands: [], searches: [], agents: [], diffs: [], gitOps: [], webOps: [], thinking: [], mcpOps: [], _fileKeys: ['z.js'] },
        { prompt: 'B', lastAssistantText: '', errors: 0, outcome: 'clean', files: {}, commands: [], searches: [], agents: [], diffs: [], gitOps: [], webOps: [], thinking: [], mcpOps: [], _fileKeys: ['z.js'] },
      ];
      enrichChaptersForRender(chapters);
      chapters;
    `);
    const chapters = script.runInNewContext({ Object, Array, String, Math, Set, Uint32Array });
    assert.equal(chapters[1].deps.continuesFrom.length, 1);
    assert.equal(chapters[1].deps.continuesFrom[0], 0);
    assert.equal(chapters[1]._promptLower, "b");
    assert.ok(hasChapterToken(chapters[1], "b"));
  });
});