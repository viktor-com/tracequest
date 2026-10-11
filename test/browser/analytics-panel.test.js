/**
 * Analytics panel on the chat/run surface: an opened run can show
 * existing /view analytics in a right-hand panel while the conversation
 * and session rail stay on screen.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chatHomePage, liveSessionPage, runPage } from "../../src/browser/run-page.js";
import { ANALYTICS_PANEL_JS } from "../../src/browser/run-analytics-panel.js";

function openedPages() {
  return [
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

function assertChatAndRail(html, label) {
  assert.match(html, /class="tq-shell"/, `${label}: tq-shell`);
  assert.match(html, /<aside class="agent-rail" aria-label="Sessions">/, `${label}: session rail`);
  assert.match(html, /class="chat-app"/, `${label}: conversation column`);
  assert.match(html, /class="chat-composer"/, `${label}: composer`);
  assert.match(html, /class="chat-scroll" id="chatScroll"/, `${label}: conversation scroller`);
  assert.doesNotMatch(html, /class="runs-inventory"/, `${label}: not the inventory table`);
}

describe("analytics-panel: markup", () => {
  test("analytics-panel: markup — opened run/session chat includes RHS panel + toggle", () => {
    for (const [label, html] of openedPages()) {
      assert.match(html, /<aside id="runAnalytics" class="run-analytics"/, `${label}: #runAnalytics`);
      assert.match(html, /id="runAnalytics"[^>]*hidden/, `${label}: panel starts closed`);
      assert.match(html, /id="analyticsToggle"/, `${label}: #analyticsToggle`);
      assert.match(html, /id="analyticsToggle"[^>]*>analytics</, `${label}: toggle label`);
      assert.match(html, /id="runAnalyticsFrame"/, `${label}: iframe`);
      assert.match(html, /id="runAnalyticsClose"/, `${label}: close`);
      assert.match(html, /id="runAnalyticsOpen"[^>]*>Open full page</, `${label}: full page`);
      const railIdx = html.indexOf('class="agent-rail"');
      const chatIdx = html.indexOf('class="chat-app"');
      const panelIdx = html.indexOf('id="runAnalytics"');
      assert.ok(railIdx >= 0 && chatIdx > railIdx, `${label}: rail before chat`);
      assert.ok(panelIdx > chatIdx, `${label}: analytics panel after chat (RHS)`);
      assertChatAndRail(html, label);
    }
  });
});

describe("analytics-panel: empty-home", () => {
  test("analytics-panel: empty-home — no panel when no run is open", () => {
    const html = chatHomePage({ defaultCwd: "/tmp" });
    assert.doesNotMatch(html, /id="runAnalytics"/, "empty home has no analytics panel");
    assert.doesNotMatch(html, /id="analyticsToggle"/, "empty home has no analytics toggle");
    assertChatAndRail(html, "empty home");
  });
});

describe("analytics-panel: embed", () => {
  test("analytics-panel: embed — panel loads /view?embed=1 and view-session opens it", () => {
    assert.match(ANALYTICS_PANEL_JS, /runAnalyticsFrame/);
    assert.match(ANALYTICS_PANEL_JS, /viewSessionLink/);
    assert.match(ANALYTICS_PANEL_JS, /analytics-open/);
    const session = liveSessionPage({
      session: {
        hash: "abcd1234",
        path: "/tmp/session.jsonl",
        source: "claude",
        project: "tmp",
        live: false,
      },
    });
    assert.match(session, /id="viewSessionLink"[^>]*href="\/view\?path=/);
    assert.ok(session.includes(ANALYTICS_PANEL_JS.slice(0, 40)), "live session embeds panel script");
    const run = runPage({
      run: {
        id: "@1",
        agent: "claude",
        cwd: "/tmp",
        startedAt: "2026-08-18T12:00:00.000Z",
        status: "running",
      },
    });
    assert.ok(run.includes("_tqAnalyticsSetView"), "run page feeds the linked recording into the panel");
    assert.ok(run.includes('var viewHref = "/view?path=" + encodeURIComponent(data.sessionPath)'), "run still builds /view href");
  });
});

describe("analytics-panel: chat-surface", () => {
  test("analytics-panel: chat-surface — chat + rail remain when the panel is present", () => {
    for (const [label, html] of openedPages()) {
      assertChatAndRail(html, label);
      assert.match(html, /id="runAnalytics"/, `${label}: panel is on the chat surface`);
      assert.match(html, /\.run-analytics\s*\{/, `${label}: panel CSS`);
      assert.match(html, /--run-analytics-width/, `${label}: docks as a RHS column`);
      assert.match(html, /body\.analytics-open \.chat-output-pane/, `${label}: output pane yields to analytics`);
    }
    const home = chatHomePage({ defaultCwd: "/tmp" });
    assertChatAndRail(home, "empty home");
    assert.doesNotMatch(home, /class="runs-inventory"/);
  });
});

describe("analytics-panel: close", () => {
  test("analytics-panel: close — Close control and Escape hide the panel", () => {
    assert.match(ANALYTICS_PANEL_JS, /runAnalyticsClose/);
    assert.match(ANALYTICS_PANEL_JS, /e\.key !== "Escape"/);
    assert.match(ANALYTICS_PANEL_JS, /tq-flyout/);
    assert.match(ANALYTICS_PANEL_JS, /action === "close"/);
    for (const [label, html] of openedPages()) {
      assert.match(html, /id="runAnalyticsClose"[^>]*aria-label="Close analytics"/, `${label}: close control`);
      assert.match(html, /id="runAnalytics"[^>]*hidden/, `${label}: closed by default`);
    }
  });
});
