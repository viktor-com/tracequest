/**
 * Chat-as-default: GET / is the /run chat surface (rail + conversation +
 * composer), not the previous Runs inventory table.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chatHomePage, liveSessionPage, runPage } from "../../src/browser/run-page.js";
import { browserPageHTML } from "../../src/browser/browser-page-build.js";
import { ROUTE_MAP } from "../../src/routes.js";
import { handleIndex, handleSessions } from "../../src/routes/route-handlers-pages.js";

function assertChatSurface(html, label) {
  assert.match(html, /class="tq-shell"/, `${label}: tq-shell`);
  assert.match(html, /<aside class="agent-rail" aria-label="Sessions">/, `${label}: session rail`);
  assert.match(html, /class="chat-app"/, `${label}: conversation column`);
  assert.match(html, /class="chat-composer"/, `${label}: composer`);
  assert.match(html, /class="chat-scroll" id="chatScroll"/, `${label}: conversation scroller`);
  assert.match(html, /id="usageRow"/, `${label}: harness usage row`);
  assert.doesNotMatch(html, /class="runs-inventory"/, `${label}: not the inventory table`);
  assert.doesNotMatch(html, /<h1 class="runs-title">Runs<\/h1>/, `${label}: not the Runs heading`);
  assert.doesNotMatch(html, /<title>Runs · tracequest<\/title>/, `${label}: not the Runs document title`);
}

describe("chat-home: / is the chat surface", () => {
  test("chat-home: / is the chat surface — empty home, run page, and session page share the /run shell", () => {
    const home = chatHomePage({ defaultCwd: "/tmp" });
    const run = runPage({
      run: {
        id: "@1",
        agent: "claude",
        cwd: "/tmp",
        startedAt: "2026-08-18T12:00:00.000Z",
        status: "running",
      },
    });
    const session = liveSessionPage({
      session: {
        hash: "abcd1234",
        path: "/tmp/session.jsonl",
        source: "claude",
        project: "tmp",
        live: false,
      },
    });
    for (const [label, html] of [["empty home", home], ["run page", run], ["session page", session]]) {
      assertChatSurface(html, label);
    }
    assert.match(home, /data-chat-home="1"/);
    assert.match(home, /No session open/);
    assert.match(home, /Start a new run/);
    assert.match(home, /id="homeComposer"/);
    assert.match(home, /<a class="rail-all" href="\/sessions">All sessions &rarr;<\/a>/);
  });

  test("chat-home: / route is handleIndex and /sessions keeps the inventory", () => {
    assert.equal(ROUTE_MAP["/"], handleIndex);
    assert.equal(ROUTE_MAP["/sessions"], handleSessions);
    const inventory = browserPageHTML(JSON.stringify({
      sessions: [],
      total: 0,
      page: 1,
      pageSize: 50,
      stats: {},
      liveSessions: [],
    }), "");
    assert.match(inventory, /class="runs-inventory"/);
    assert.match(inventory, /<title>Runs · tracequest<\/title>/);
  });
});

describe("chat-home: empty corpus", () => {
  test("chat-home: empty home is a chat shell with a new-run composer, not a table", () => {
    const html = chatHomePage({ defaultCwd: "/Users/dev" });
    assertChatSurface(html, "empty corpus");
    assert.match(html, /placeholder="Start a new run"/);
    assert.match(html, /id="newRunBtn"/);
    assert.match(html, /id="launchOverlay"/);
    assert.ok(html.includes('var _INIT_DATA = { defaultCwd: "/Users/dev" }'));
  });
});

describe("chat-home: inventory stays off the default", () => {
  test("chat-home: inventory remains a /sessions surface, not the product default", () => {
    assert.equal(ROUTE_MAP["/sessions"], handleSessions);
    assert.notEqual(ROUTE_MAP["/"], handleSessions);
    const html = chatHomePage({});
    assert.match(html, /href="\/sessions"/);
  });
});

function railPages() {
  return [
    ["empty home", chatHomePage({ defaultCwd: "/tmp" })],
    ["run page", runPage({
      run: {
        id: "@1",
        agent: "claude",
        cwd: "/tmp",
        startedAt: "2026-08-18T12:00:00.000Z",
        status: "running",
      },
    })],
    ["session page", liveSessionPage({
      session: {
        hash: "abcd1234",
        path: "/tmp/session.jsonl",
        source: "claude",
        project: "tmp",
        live: false,
      },
    })],
  ];
}

describe("chat-home: session rail first-paints as a rail, not an inventory dashboard", () => {
  test("chat-home: session rail first-paints as Sessions head + list, inventory chrome collapsed", () => {
    for (const [label, html] of railPages()) {
      assert.match(html, /<aside class="agent-rail" aria-label="Sessions">/, `${label}: rail`);
      assert.doesNotMatch(html, /<aside class="agent-rail[^"]*filters-open/, `${label}: extra filters closed on first paint`);
      assert.match(html, /id="filterBar"/, `${label}: search block present`);
      assert.match(html, /id="filterInput"/, `${label}: query visible`);
      const headIdx = html.indexOf('<div class="rail-head">Sessions');
      const filtersIdx = html.indexOf('id="railFilters"');
      const extraIdx = html.indexOf('class="rail-filters-extra"');
      const listIdx = html.indexOf('id="railList"');
      const overviewIdx = html.indexOf('id="railOverview"');
      const queryIdx = html.indexOf('id="filterInput"');
      assert.ok(headIdx >= 0 && headIdx < listIdx, `${label}: Sessions head precedes the list`);
      assert.ok(filtersIdx > headIdx && filtersIdx < listIdx, `${label}: filter stack sits between head and list`);
      assert.ok(queryIdx > filtersIdx && queryIdx < extraIdx, `${label}: query is outside the collapsed extra stack`);
      assert.ok(overviewIdx > extraIdx && overviewIdx < listIdx, `${label}: overview lives inside the collapsed extra stack`);
      assert.match(html, /var railFiltersOpen = false/, `${label}: disclosure starts closed`);
      assert.match(html, /var filtersOpen = false/, `${label}: chip pickers start closed`);
      assert.match(html, /<div class="qf-bar" id="qfBar" hidden>/, `${label}: chips hidden`);
      assert.match(html, /id="filtersToggle"[^>]*aria-expanded="false"/, `${label}: Filters not expanded`);
      assert.match(html, /<a class="rail-all" href="\/sessions">All sessions &rarr;<\/a>/, `${label}: All sessions foot`);
    }
  });
});

describe("chat-home: rail filter disclosure keeps previous-home options available", () => {
  test("chat-home: rail filter disclosure opens the previous-home filter stack", () => {
    for (const [label, html] of railPages()) {
      assert.match(html, /id="railFilterToggle"/, `${label}: #railFilterToggle`);
      assert.match(html, /aria-controls="railFilters"/, `${label}: toggle controls #railFilters`);
      assert.match(html, /function setRailFiltersOpen\(/, `${label}: setRailFiltersOpen`);
      assert.match(html, /setRailFiltersOpen\(!railFiltersOpen\)/, `${label}: toggle flips the disclosure`);
      assert.match(html, /id="workspaceSearch"/, `${label}: always-visible workspace search`);
      assert.match(html, /data-hotkey="s,\/"/, `${label}: slash focuses workspace search`);
      assert.match(html, /if \(_railExpr \|\| qfHasAny\(\) \|\| \(_railSort && _railSort !== "recent"\)\) setRailFiltersOpen\(true\)/, `${label}: active filters reopen the stack`);
      assert.match(html, /<div class="rail-filters" id="railFilters">/, `${label}: previous-home stack remains`);
      assert.match(html, /id="filterInput"/, `${label}: query`);
      assert.match(html, /id="ageBtn"/, `${label}: time`);
      assert.match(html, /id="sourceBtn"/, `${label}: source`);
      assert.match(html, /id="filtersToggle"/, `${label}: filters`);
      assert.match(html, /id="displayToggle"/, `${label}: display`);
      assert.match(html, /id="railOverview"/, `${label}: overview`);
      assert.match(html, /id="qfBar"/, `${label}: chips`);
    }
  });
});
