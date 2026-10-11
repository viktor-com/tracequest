/**
 * Command palette search — type-to-search sessions via /api/search,
 * identity, snippets, recent, open-by-hash, pickable /view destinations.
 * Fact anchors: cpsq cpidn cpsn cpre cpho cppi cpns cpro.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_PALETTE_CSS,
  COMMAND_PALETTE_CLIENT_JS,
  parsePaletteQuery,
  isPaletteSessionHash,
  sessionViewHref,
  firstSnippet,
  highlightSnippet,
  pickSearchSnippet,
  searchHitToItem,
  searchPaletteCatalog,
  scorePaletteCatalogSession,
  catalogMatchSnippet,
  openSessionItem,
  packSearchCatalog,
  unpackSearchCatalog,
  injectSearchCatalog,
} from "../../src/browser/command-palette.js";

describe("command palette search helpers", () => {
  test("parsePaletteQuery strips s/session/run prefixes and leaves plain queries intact", () => {
    assert.deepEqual(parsePaletteQuery("  redesign  "), { raw: "  redesign  ", q: "redesign", prefix: "" });
    assert.equal(parsePaletteQuery("s backend").q, "backend");
    assert.equal(parsePaletteQuery("s backend").prefix, "session");
    assert.equal(parsePaletteQuery("session  login").q, "login");
    assert.equal(parsePaletteQuery("r ").q, "");
    assert.equal(parsePaletteQuery("r ").prefix, "session");
    assert.equal(parsePaletteQuery("r").prefix, "");
    assert.equal(parsePaletteQuery("run hashme").prefix, "session");
    assert.equal(parsePaletteQuery("").q, "");
    assert.equal(parsePaletteQuery("g compare").prefix, "goto");
    assert.equal(parsePaletteQuery("g compare").q, "compare");
    assert.equal(parsePaletteQuery("go runs").prefix, "goto");
    assert.equal(parsePaletteQuery("goto  view").q, "view");
    assert.equal(parsePaletteQuery("go").prefix, "");
  });

  test("isPaletteSessionHash accepts 8-character hex ids", () => {
    assert.equal(isPaletteSessionHash("a13f9c82"), true);
    assert.equal(isPaletteSessionHash("A13F9C82"), true);
    assert.equal(isPaletteSessionHash("  b74c21e0  "), true);
    assert.equal(isPaletteSessionHash("zzzzzxxy"), false);
    assert.equal(isPaletteSessionHash("a13f9c8"), false);
    assert.equal(isPaletteSessionHash(""), false);
  });

  test("sessionViewHref builds /view?id= and adds non-claude source", () => {
    assert.equal(sessionViewHref({ id: "a13f9c82", source: "claude" }), "/view?id=a13f9c82");
    assert.equal(
      sessionViewHref({ sessionHash: "b74c21e0", source: "codex" }),
      "/view?id=b74c21e0&source=codex",
    );
  });

  test("highlightSnippet wraps the matched query term", () => {
    const html = highlightSnippet("...Linear will change the status...", "change", 15, 6);
    assert.match(html, /<mark class="cmdk-mark">change<\/mark>/);
    assert.ok(!html.includes("<script"));
    const fallback = highlightSnippet("hello cmdk-search-needle-alpha world", "cmdk-search-needle-alpha");
    assert.match(fallback, /<mark class="cmdk-mark">cmdk-search-needle-alpha<\/mark>/);
    const tokenized = highlightSnippet("Document cmdk-search-needle-alpha for the menu", "cmdk-search-needle-alpha");
    assert.match(tokenized, /<mark class="cmdk-mark">/);
  });

  test("searchHitToItem shows source, short session id, and prompt excerpt so the result is pickable", () => {
    const item = searchHitToItem({
      id: "a13f9c82",
      source: "claude",
      prompt: "Document session browser examples",
      project: "tracequest",
      matches: [{ type: "text", snippet: "...browser examples with filters...", matchStart: 3, matchLen: 7 }],
    }, "browser");
    assert.equal(item.kind, "session");
    assert.equal(item.ranked, true);
    assert.equal(item.group, "Sessions");
    assert.equal(item.identity.source, "claude");
    assert.equal(item.identity.id, "a13f9c82");
    assert.equal(item.title, "Document session browser examples");
    assert.equal(item.href, "/view?id=a13f9c82");
    assert.match(item.snippetHtml || item.titleHtml, /<mark class="cmdk-mark">/);
    const cleaned = pickSearchSnippet({
      prompt: "Document session browser examples",
      matches: [{ snippet: '...","sessionHash":"a13f9c82","source":"claude","projectRaw":"p"' }],
    }, "a13f9c82");
    assert.equal(cleaned.text, "Document session browser examples");
  });

  test("catalog ranking matches tool names and Read yields pickable hits", () => {
    const sessions = [
      {
        id: "a13f9c82",
        source: "claude",
        prompt: "Investigate the failing dashboard query",
        model: "opus",
        project: "tracequest",
        tools: ["Read", "Bash", "Grep"],
      },
      {
        id: "b74c21e0",
        source: "grok",
        prompt: "Write a Readme for the CLI",
        model: "grok",
        project: "docs",
        tools: ["Edit"],
      },
      {
        id: "c0ffee00",
        source: "codex",
        prompt: "Unrelated logging change",
        model: "codex",
        project: "other",
        tools: ["WebSearch"],
      },
    ];
    const hits = searchPaletteCatalog(sessions, "Read", 8);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0].id, "a13f9c82");
    assert.equal(hits[0].source, "claude");
    assert.equal(hits[0].prompt, "Investigate the failing dashboard query");
    const item = searchHitToItem(hits[0], "Read");
    assert.equal(item.identity.source, "claude");
    assert.equal(item.identity.id, "a13f9c82");
    assert.match(item.snippetHtml || item.titleHtml, /<mark class="cmdk-mark">/i);
    assert.ok(scorePaletteCatalogSession(sessions[0], ["read"]) > scorePaletteCatalogSession(sessions[1], ["read"]));
    assert.match(catalogMatchSnippet(sessions[0], "Read"), /Read/i);
    const promptHits = searchPaletteCatalog(sessions, "dashboard", 8);
    assert.equal(promptHits[0].id, "a13f9c82");
  });

  test("unpackSearchCatalog restores pickable identity", () => {
    const sessions = [
      {
        id: "a13f9c82",
        source: "claude",
        prompt: "Investigate the failing dashboard query",
        model: "opus",
        project: "tracequest",
        tools: ["Read", "Bash", "Grep"],
      },
      {
        id: "b74c21e0",
        source: "grok",
        prompt: "Write a Readme for the CLI",
        model: "grok",
        project: "docs",
        tools: ["Edit"],
      },
    ];
    const packed = packSearchCatalog(sessions);
    assert.ok(Array.isArray(packed.t));
    assert.ok(packed.t.includes("Read"));
    assert.ok(Array.isArray(packed.s));
    const restored = unpackSearchCatalog(packed);
    assert.equal(restored.length, 2);
    assert.equal(restored[0].id, "a13f9c82");
    assert.equal(restored[0].source, "claude");
    assert.equal(restored[0].prompt, "Investigate the failing dashboard query");
    assert.deepEqual(restored[0].tools, ["Read", "Bash", "Grep"]);
    const hits = searchPaletteCatalog(restored, "Read", 8);
    assert.equal(hits[0].id, "a13f9c82");
    assert.equal(hits[0].source, "claude");
    assert.equal(hits[0].prompt, "Investigate the failing dashboard query");
    const fromApiShape = unpackSearchCatalog({ sessions });
    assert.equal(fromApiShape[0].id, "a13f9c82");
  });

  test("injectSearchCatalog embeds the identity catalog before palette boot", () => {
    const html = injectSearchCatalog(
      "<!DOCTYPE html><html><body><div>page</div></body></html>",
      [{ id: "a13f9c82", source: "claude", prompt: "Ship the catalog", model: "opus", project: "tq", tools: ["Read"] }],
    );
    assert.match(html, /id="tq-cmdk-catalog"/);
    assert.match(html, /type="application\/json"/);
    const catalogAt = html.indexOf('id="tq-cmdk-catalog"');
    const bodyAt = html.indexOf("<body>");
    assert.ok(catalogAt > bodyAt);
    const m = html.match(/<script type="application\/json" id="tq-cmdk-catalog">([^<]*)<\/script>/);
    assert.ok(m);
    const restored = unpackSearchCatalog(JSON.parse(m[1]));
    assert.equal(restored[0].id, "a13f9c82");
    assert.equal(restored[0].source, "claude");
    assert.equal(restored[0].prompt, "Ship the catalog");
    assert.ok(restored[0].tools.includes("Read"));
    const twice = injectSearchCatalog(html, []);
    assert.equal(twice.split('id="tq-cmdk-catalog"').length, 2);
  });

  test("firstSnippet and openSessionItem keep identity pickable for hash queries", () => {
    assert.deepEqual(firstSnippet([{ snippet: "abc", matchStart: 0, matchLen: 3 }]), {
      text: "abc",
      matchStart: 0,
      matchLen: 3,
    });
    const open = openSessionItem("A13F9C82");
    assert.equal(open.title, "Open session");
    assert.equal(open.identity.id, "a13f9c82");
    assert.equal(open.href, "/view?id=a13f9c82");
    assert.equal(open.kind, "session");
  });
});

describe("command palette search client", () => {
  test("a non-empty query fetches GET /api/search?q= and lists ranked session hits; empty query does not call /api/search", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /\/api\/search\?q=/);
    const fetchSearchAt = js.indexOf("/api/search?q=");
    const emptyBranchAt = js.indexOf("if (!parsed.q)");
    assert.ok(emptyBranchAt > 0 && fetchSearchAt > 0);
    assert.match(js, /data\.results/);
  });

  test("each session hit shows source, short session id, and prompt excerpt", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    const css = COMMAND_PALETTE_CSS;
    assert.match(js, /cmdk-src/);
    assert.match(js, /cmdk-sid/);
    assert.match(js, /cmdk-item-idline/);
    assert.match(js, /data-session-id/);
    assert.match(js, /data-kind/);
    assert.match(js, /identity\.source/);
    assert.match(js, /identity\.id/);
    assert.match(css, /\.cmdk-src/);
    assert.match(css, /\.cmdk-sid/);
  });

  test("session hits include a content snippet with the matched query term highlighted", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    const css = COMMAND_PALETTE_CSS;
    assert.match(js, /snippetHtml/);
    assert.match(js, /cmdk-mark/);
    assert.match(css, /\.cmdk-mark/);
    assert.match(js, /it\.snippetHtml/);
  });

  test("empty query shows a Recent group of sessions from GET /api/sessions", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /\/api\/sessions\?page=1&pageSize=8&sort=recent/);
    assert.match(js, /group: "Recent"/);
    assert.match(js, /groupPriority: 70/);
    assert.match(js, /liveSessions/);
    assert.match(js, /Recent searches/);
    assert.ok(js.includes("/api/sessions?page=1"));
    assert.ok(!/if \(!parsed\.q\)[\s\S]{0,200}\/api\/search/.test(js), "empty branch must not hit /api/search");
  });

  test("typing or pasting an 8-character session hash offers an Open session item that goes to /view?id=", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /Open session/);
    assert.match(js, /\/view\?id=/);
  });

  test("activating a session hit navigates to /view?id= of that session", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /href: sessionViewHref/);
    assert.match(js, /location\.href = item\.href/);
    assert.match(js, /item\.kind === "session"/);
  });

  test("a query that matches neither commands nor indexed sessions still shows the Search sessions fallback", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /No results found/);
    assert.match(js, /Search sessions/);
    assert.match(js, /kind: "search"/);
    assert.match(js, /\/sessions\?filter=/);
  });

  test("session hits keep /api/search rank order inside a Sessions group above the Search fallback", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /group: "Sessions"/);
    assert.match(js, /groupPriority: 80/);
    assert.match(js, /groupPriority: 10/);
    assert.match(js, /it\.ranked \|\| it\.kind === "session"/);
  });

  test("palette preloads the search catalog and ranks typed session hits locally", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /\/api\/search\?catalog=1/);
    assert.match(js, /catalogCache\.sessions/);
    assert.match(js, /requestIdleCallback/);
    const catalogAt = js.indexOf("/api/search?catalog=1");
    const debounceAt = js.indexOf("function debounceSearch");
    const localAt = js.indexOf("searchPaletteCatalog(catalogCache.sessions");
    assert.ok(catalogAt > 0 && localAt > 0 && debounceAt > 0);
  });

  test("seeds catalogCache from #tq-cmdk-catalog and skips catalog HTTP when present", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /catalogCache\.sessions = sessions/);
    const seedAt = js.indexOf("function seedCatalogFromPage");
    const idleAt = js.indexOf("if (!pageCatalogReady)");
    const catalogHttpAt = js.indexOf("/api/search?catalog=1");
    assert.ok(seedAt > 0 && idleAt > seedAt, "boot seeds from the page before idle catalog HTTP");
    assert.ok(catalogHttpAt > 0, "catalog=1 remains a fallback when the page catalog is missing");
  });

  test("palette search uses limit=8 and snippets=0", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /\/api\/search\?q=/);
    assert.match(js, /limit=8/);
    assert.match(js, /snippets=0/);
    assert.match(js, /limit=8&snippets=0/);
  });

  test("typing does not wait for /api/search before listing commands", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /p\.id !== "sessions"/);
    const refreshAt = js.indexOf("function refresh()");
    const searchFetchAt = js.indexOf("/api/search?q=");
    assert.ok(refreshAt > 0 && searchFetchAt > 0);
  });
});
