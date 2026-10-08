import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { fnSrc } from "../../src/utils/fn-src.js";
import { joinBundleParts } from "../../src/render/join-bundle.js";
import {
  getModelRates,
  fmtTokens,
  fmtCost,
  fmtPct,
  formatDuration,
  fmtMcpName,
  estimateParsedStatsCost,
  estimateChapterTokenCost,
} from "../../src/filter/filter-formats.js";
import { shortToolPath, parseWebSearchLinks } from "../../src/parse/parse-utils.js";
import { detectGitOp } from "../../src/utils/git-op.js";
import {
  newChapter,
  buildChapterEventMaps,
  accumulateAssistantToolCall,
} from "../../src/chapters/chapter-accumulate.js";
import {
  markUserPromptCorrections,
  countSelfCorrections,
  isSameTarget,
  isSimilarInput,
} from "../../src/chapters/chapter-patterns.js";
import {
  detectChapterRetries,
  classifyChapterOutcome,
  computeChapterEfficiency,
  enrichChaptersEfficiency,
} from "../../src/chapters/chapter-quality.js";
import { enrichChaptersForRender } from "../../src/chapters/chapter-render-enrich.js";
import { buildSessionChapters } from "../../src/chapters/session-chapters.js";
import {
  CHAPTERS_BUNDLE_PARTS,
  RENDER_BUNDLE_PARTS,
} from "../../src/render/render-assemble.js";

function fnWithSource(source) {
  return { toString: () => source };
}

describe("fnSrc", () => {
  test("strips a single leading export prefix from function source", () => {
    const src = fnSrc(
      fnWithSource("export function demo() { return 1; }")
    );
    assert.equal(src, "function demo() { return 1; }");
    assert.ok(!src.startsWith("export "));
  });

  test("strips export prefix from export async function", () => {
    const src = fnSrc(
      fnWithSource("export async function run() { await 0; }")
    );
    assert.equal(src, "async function run() { await 0; }");
  });

  test("leaves source unchanged when no export prefix", () => {
    const body = "function plain(x) { return x; }";
    assert.equal(fnSrc(fnWithSource(body)), body);
  });

  test("does not strip export tokens after the first line", () => {
    const body = "function f() { return 'export '; }";
    assert.equal(fnSrc(fnWithSource(body)), body);
  });

  test("only removes one leading export prefix", () => {
    const weird = "export export function g() {}";
    assert.equal(fnSrc(fnWithSource(weird)), "export function g() {}");
  });

  test("imported module functions serialize without export and match fnSrc", () => {
    const src = fnSrc(fmtTokens);
    assert.ok(src.startsWith("function fmtTokens"));
    assert.ok(!src.includes("export function"));
  });
});

const VM_CTX = { Object, Array, String, Math, Date, Set };

const FORMAT_PART_IDS = [
  "includesLower",
  "getModelRates",
  "estimateParsedStatsCost",
  "estimateChapterTokenCost",
  "fmtTokens",
  "fmtCost",
  "fmtPct",
  "formatDuration",
  "fmtMcpName",
];

const CHAPTER_HELPER_IDS = [
  "shortToolPath",
  "parseWebSearchLinks",
  "detectGitOp",
  "buildChapterEventMaps",
  "accumulateAssistantToolCall",
  "newChapter",
  "compareToolTargets",
  "isSameTarget",
  "isSimilarInput",
  "isSameCallTarget",
  "isSimilarCallEntry",
  "markUserPromptCorrections",
  "countSelfCorrections",
  "detectChapterRetries",
  "classifyChapterOutcome",
  "computeChapterEfficiency",
  "enrichChaptersEfficiency",
  "buildSessionChapters",
  "enrichChaptersForRender",
];

function bundleParts(parts, ids) {
  return joinBundleParts(parts.filter((p) => ids.includes(p.id)));
}

function runVm(bundle, tail, ctx = VM_CTX) {
  return new Script(`${bundle}\n${tail}`).runInNewContext(ctx);
}

describe("fnSrc browser bundle helpers (observable VM parity)", () => {
  test("RENDER_BUNDLE_PARTS format segments are present and export-free", () => {
    for (const id of FORMAT_PART_IDS) {
      const part = RENDER_BUNDLE_PARTS.find((p) => p.id === id);
      assert.ok(part, `missing RENDER_BUNDLE_PARTS entry for ${id}`);
      assert.ok(part.source.length > 20, `${id} should have substantial source`);
      assert.ok(!part.source.startsWith("export "), `${id} must not retain export`);
    }
  });

  test("injected format helpers produce same outputs as module exports in VM", () => {
    const model = "claude-3-sonnet";
    const stats = {
      totalInputTokens: 1000,
      totalCacheHit: 400,
      totalOutputTokens: 200,
    };
    const tokens = { input: 1000, cacheHit: 400, output: 200 };
    const bundle = bundleParts(RENDER_BUNDLE_PARTS, FORMAT_PART_IDS);

    const vm = runVm(
      bundle,
      `({
        tokens: fmtTokens(1_500_000),
        tokensZero: fmtTokens(0, { zeroLabel: "0" }),
        cost: fmtCost(0.0123),
        pct: fmtPct(42.4),
        duration: formatDuration(90_000),
        mcp: fmtMcpName("mcp__my_server__do_thing"),
        parsedCost: estimateParsedStatsCost(${JSON.stringify(model)}, ${JSON.stringify(stats)}),
        chapterCost: estimateChapterTokenCost(${JSON.stringify(model)}, ${JSON.stringify(tokens)}),
        rates: getModelRates(${JSON.stringify(model)}),
      });`,
    );

    assert.equal(vm.tokens, fmtTokens(1_500_000));
    assert.equal(vm.tokensZero, fmtTokens(0, { zeroLabel: "0" }));
    assert.equal(vm.cost, fmtCost(0.0123));
    assert.equal(vm.pct, fmtPct(42.4));
    assert.equal(vm.duration, formatDuration(90_000));
    assert.equal(vm.mcp, fmtMcpName("mcp__my_server__do_thing"));
    assert.ok(Math.abs(vm.parsedCost - estimateParsedStatsCost(model, stats)) < 1e-9);
    assert.ok(Math.abs(vm.chapterCost - estimateChapterTokenCost(model, tokens)) < 1e-9);
    const rates = getModelRates(model);
    assert.equal(vm.rates.inRate, rates.inRate);
    assert.equal(vm.rates.outRate, rates.outRate);
    assert.equal(vm.rates.cacheReadRate, rates.cacheReadRate);
  });

  test("CHAPTERS_BUNDLE_PARTS chapter segments are present and export-free", () => {
    for (const id of CHAPTER_HELPER_IDS) {
      const part = CHAPTERS_BUNDLE_PARTS.find((p) => p.id === id);
      assert.ok(part, `missing CHAPTERS_BUNDLE_PARTS entry for ${id}`);
      assert.ok(part.source.length > 20, `${id} should have substantial source`);
      assert.ok(!part.source.startsWith("export "), `${id} must not retain export`);
    }
  });

  test("injected detectGitOp parses commit -m like module export in VM", () => {
    const bundle = bundleParts(CHAPTERS_BUNDLE_PARTS, [
      "safeSlice",
      "extractCommitMessageFromMFlag",
      "detectGitOp",
    ]);
    const cases = [
      { cmd: 'git commit -m "docs: update README"', message: "docs: update README" },
      { cmd: "git commit -m 'hotfix: null guard'", message: "hotfix: null guard" },
      { cmd: "git commit -m chore/deps-bump", message: "chore/deps-bump" },
      {
        cmd: 'npm test && git commit -m "green suite"',
        message: "green suite",
        output: "[main deadbeef0123456] green suite\n",
      },
    ];

    for (const { cmd, message, output } of cases) {
      const args = output == null ? [cmd] : [cmd, output];
      const vm = runVm(
        bundle,
        `detectGitOp(${JSON.stringify(cmd)}${output == null ? "" : `, ${JSON.stringify(output)}`});`,
      );
      const node = detectGitOp(...args);
      assert.equal(vm.type, "commit", `${cmd}: type`);
      assert.equal(vm.message, message, `${cmd}: message`);
      assert.equal(vm.message, node.message, `${cmd}: VM vs module message`);
      assert.equal(vm.type, node.type, `${cmd}: VM vs module type`);
    }
  });

  test("injected chapter helpers match module behavior in VM", () => {
    const bundle = bundleParts(CHAPTERS_BUNDLE_PARTS, [
      ...CHAPTER_HELPER_IDS,
      "correctionHintRe",
    ]);
    const pathInput = "/home/user/proj/src/auth.js";
    const gitCmd = "cd /tmp && git push origin main";

    const vm = runVm(
      bundle,
      `({
        path: shortToolPath(${JSON.stringify(pathInput)}),
        gitType: detectGitOp(${JSON.stringify(gitCmd)}).type,
        gitRemote: detectGitOp(${JSON.stringify(gitCmd)}).remote,
        sameTarget: isSameTarget(
          "/proj/src/auth.js",
          "/other/proj/src/auth.js",
          "Edit",
        ),
        similarInput: isSimilarInput("edit auth module", "fix auth module", "Grep"),
        priorCorrected: (() => {
          const ch = [
            { prompt: "fix the bug", corrected: false },
            { prompt: "No, undo that", corrected: false },
          ];
          markUserPromptCorrections(ch);
          return ch[0].corrected;
        })(),
        selfCorrections: countSelfCorrections([
          { name: "Edit", input: "/proj/src/foo.js", isError: true },
          { name: "Edit", input: "/proj/src/foo.js", isError: false },
        ]),
      });`,
    );

    const git = detectGitOp(gitCmd);
    const toolSeq = [
      { name: "Edit", input: "/proj/src/foo.js", isError: true },
      { name: "Edit", input: "/proj/src/foo.js", isError: false },
    ];
    assert.equal(vm.path, shortToolPath(pathInput));
    assert.equal(vm.gitType, git.type);
    assert.equal(vm.gitRemote, git.remote);
    assert.equal(vm.sameTarget, isSameTarget("/proj/src/auth.js", "/other/proj/src/auth.js", "Edit"));
    assert.equal(vm.similarInput, isSimilarInput("edit auth module", "fix auth module", "Grep"));
    assert.equal(vm.priorCorrected, true);
    assert.equal(vm.selfCorrections, countSelfCorrections(toolSeq));
  });

  test("injected chapter pipeline builds enriched chapters from events", () => {
    const events = [
      { type: "user", text: "Fix auth module", timestamp: "2026-01-01T00:00:00.000Z" },
      {
        type: "assistant",
        text: "Reading auth file",
        timestamp: "2026-01-01T00:00:01.000Z",
        toolCalls: [{ id: "tc1", name: "Read", input: "/proj/src/auth.js" }],
      },
      { type: "tool_result", toolUseId: "tc1", text: "ok", timestamp: "2026-01-01T00:00:02.000Z" },
    ];
    const bundle = joinBundleParts(CHAPTERS_BUNDLE_PARTS);

    const vm = runVm(
      bundle,
      `(() => {
        const session = { startTime: "2026-01-01T00:00:00.000Z" };
        let chapters = buildSessionChapters({ events, startTime: session.startTime });
        enrichChaptersEfficiency(chapters);
        enrichChaptersForRender(chapters);
        const ch = chapters[0];
        return {
          len: chapters.length,
          prompt: ch.prompt,
          promptLower: ch._promptLower,
          fileKeys: ch._fileKeys,
          outcome: ch.outcome,
          hasEfficiency: ch.efficiency != null,
        };
      })();`,
      { ...VM_CTX, events },
    );

    const session = { startTime: "2026-01-01T00:00:00.000Z", events };
    let chapters = buildSessionChapters(session);
    enrichChaptersEfficiency(chapters);
    enrichChaptersForRender(chapters);
    const ch = chapters[0];

    assert.equal(vm.len, 1);
    assert.equal(vm.prompt, ch.prompt);
    assert.equal(vm.promptLower, ch._promptLower);
    assert.deepEqual(vm.fileKeys, ch._fileKeys);
    assert.equal(vm.outcome, ch.outcome);
    assert.equal(vm.hasEfficiency, ch.efficiency != null);
  });

  test("every fnSrc-backed chapter part is injectable as a function declaration", () => {
    for (const { id, source } of CHAPTERS_BUNDLE_PARTS) {
      if (id === "correctionHintRe" || id === "firstPromptMaxLen") continue;
      assert.match(
        source,
        /^function |^async function /,
        `${id} should begin with a function declaration`,
      );
    }
  });
});