import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

describe("dead code sweep (iteration 171)", () => {
  test("parse-shared barrel file removed", () => {
    assert.equal(existsSync("src/parse/parse-shared.js"), false);
  });

  test("render-analytics shim removed", () => {
    assert.equal(existsSync("src/render/render-analytics.js"), false);
    const assemble = readFileSync("src/render/render-assemble.js", "utf8");
  });

  test("BROWSER_CLIENT_BUNDLE_FUNCTION_NAMES export removed", () => {
    const src = readFileSync("src/browser/browser-client.js", "utf8");
    assert.doesNotMatch(src, /BROWSER_CLIENT_BUNDLE_FUNCTION_NAMES/);
  });

  test("render compose shims removed (ui-compose, chapters-bundle)", () => {
    assert.equal(existsSync("src/render/render-ui-compose.js"), false);
    assert.equal(existsSync("src/render/render-chapters-bundle.js"), false);
    const src = readFileSync("src/render/render-assemble.js", "utf8");
  });

  test("compare-page keeps only comparePage as public export", async () => {
    const mod = await import("../src/browser/compare-page.js");
    assert.equal(typeof mod.comparePage, "function");
    assert.equal(mod.buildComparePageHtml, undefined);
    assert.equal(mod.summarizeCompareSession, undefined);
    assert.equal(mod.SOURCE_COLORS, undefined);
  });

  test("compare-metrics owns session summary and metric row builders", async () => {
    const mod = await import("../src/chapters/compare-metrics.js");
    assert.equal(typeof mod.summarizeCompareSession, "function");
    assert.equal(typeof mod.buildCompareMetricRows, "function");
    assert.ok(Array.isArray(mod.COMPARE_METRIC_LABELS));
    assert.ok(mod.COMPARE_METRIC_LABELS.includes("Clean chapters"));
  });
});

describe("dead code sweep (iteration 235)", () => {
  test("browser-page does not re-export browserPageHTML", async () => {
    const mod = await import("../src/browser/browser-page.js");
    assert.equal(typeof mod.browserPage, "function");
    assert.equal(mod.browserPageHTML, undefined);
  });

  test("buildPageCacheKey removed — handleIndex uses route-cache only", async () => {
    const mod = await import("../src/browser/browser-page.js");
    assert.equal(mod.buildPageCacheKey, undefined);
    const pages = readFileSync("src/routes/route-handlers-pages.js", "utf8");
    assert.match(pages, /resolveSessionsAndIndex/);
    assert.doesNotMatch(pages, /buildPageCacheKey/);
  });

  test("compare-metrics owns compare HTML builders", async () => {
    const mod = await import("../src/chapters/compare-metrics.js");
    assert.equal(typeof mod.buildCompareToolRows, "function");
    assert.equal(typeof mod.buildMetricTableHtml, "function");
    assert.equal(typeof mod.buildToolComparisonHtml, "function");
    assert.equal(typeof mod.buildOutcomeSideHtml, "function");
    assert.equal(typeof mod.buildSessionCardHtml, "function");
    const page = await import("../src/browser/compare-page.js");
    assert.equal(page.buildCompareToolRows, undefined);
    assert.equal(page.buildMetricTableHtml, undefined);
    assert.equal(page.SOURCE_COLORS, undefined);
  });

  test("session-index-jsonl hides internal index helpers", async () => {
    const mod = await import("../src/sessions/session-index-jsonl.js");
    assert.equal(typeof mod.indexClaudeJsonl, "function");
    assert.equal(typeof mod.emptyIndexMeta, "function");
    assert.equal(mod.MAX_FALLBACK_STRINGS, undefined);
    assert.equal(mod.extractTextFromMessage, undefined);
    assert.equal(mod.indexClaudeFamilyJsonl, undefined);
  });

  test("parse barrel exposes only parseSession", () => {
    const src = readFileSync("src/parse.js", "utf8");
    assert.match(src, /export\s*\{\s*parseSession\s*\}/);
    assert.doesNotMatch(src, /forEachJsonlLine/);
    assert.doesNotMatch(src, /collectParsedJsonlLines/);
    assert.doesNotMatch(src, /readPartialJsonlLines/);
    assert.doesNotMatch(src, /parseToolArgs/);
    assert.doesNotMatch(src, /forEachPartialParsedJsonlLine/);
  });

  test("session-chapters does not re-export summarizeChapterQuality", async () => {
    const mod = await import("../src/chapters/session-chapters.js");
    assert.equal(typeof mod.buildSessionChapters, "function");
    assert.equal(mod.summarizeChapterQuality, undefined);
  });

  test("session-chapters does not re-export enrichChaptersQuality", async () => {
    const mod = await import("../src/chapters/session-chapters.js");
    assert.equal(typeof mod.buildSessionChapters, "function");
    assert.equal(mod.enrichChaptersQuality, undefined);
  });

  test("duplicate root session-index-jsonl test removed after reorg", () => {
    assert.equal(existsSync("test/session-index-jsonl.test.js"), false);
  });
});

describe("dead code sweep (iteration 277 — route-handlers barrel)", () => {
  test("route-handlers keeps page handlers and livereload only", async () => {
    const mod = await import("../src/routes/route-handlers.js");
    assert.equal(typeof mod.handleIndex, "function");
    assert.equal(typeof mod.handleView, "function");
    assert.equal(typeof mod.handleExport, "function");
    assert.equal(typeof mod.handleMarkdown, "function");
    assert.equal(typeof mod.handleCompare, "function");
    assert.equal(typeof mod.handleLivereload, "function");
    assert.equal(mod.DATA_ROOTS, undefined);
    assert.equal(mod.getDataRoots, undefined);
    assert.equal(mod.buildRouteCacheKey, undefined);
    assert.equal(mod.clearRouteCache, undefined);
    assert.equal(mod.peekRouteCache, undefined);
    assert.equal(mod.storeRouteCache, undefined);
    assert.equal(mod.resolveSessionsAndIndex, undefined);
    assert.equal(mod.isRouteCacheTopMtimesValid, undefined);
    assert.equal(mod.handleApiSessions, undefined);
    assert.equal(mod.handleApiSearch, undefined);
    assert.equal(mod.getSessionsAndIndex, undefined);
    assert.equal(mod.computeStats, undefined);
  });

  test("route-handlers.test.js removed (DATA_ROOTS covered in route-cache.test.js)", () => {
    assert.equal(existsSync("test/route-handlers.test.js"), false);
  });
});

describe("dead code sweep (iteration 278 — session-meta internals)", () => {
  test("session-meta hides durationMsFromState (internal to buildIndexMetaFromState)", async () => {
    const mod = await import("../src/sessions/session-meta.js");
    assert.equal(typeof mod.buildIndexMetaFromState, "function");
    assert.equal(typeof mod.emptyIndexMeta, "function");
    assert.equal(mod.durationMsFromState, undefined);
  });
});

describe("dead code sweep (iteration 279 — printSessionStats)", () => {
  test("cli-commands hides printSessionStats (internal to parseAndRender)", async () => {
    const mod = await import("../src/cli/cli-commands.js");
    assert.equal(typeof mod.parseAndRender, "function");
    assert.equal(mod.printSessionStats, undefined);
  });
});

describe("dead code sweep (iteration 276 — test layout)", () => {
  const removedRootDuplicates = [
    "test/agent-history.test.js",
    "test/browser-client.test.js",
    "test/cli-commands.test.js",
    "test/render-chapters-client.test.js",
    "test/render-interactions-nav.test.js",
    "test/render.test.js",
    "test/routes.test.js",
    "test/scan-queries.test.js",
    "test/session-index-opencode.test.js",
  ];

  for (const rel of removedRootDuplicates) {
    test(`${rel} removed (canonical copy under test/<area>/)`, () => {
      assert.equal(existsSync(rel), false);
    });
  }
});