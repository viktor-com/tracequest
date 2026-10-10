/**
 * Sidebar filters: the chat-home session rail carries the previous
 * home page's filter options (query, time/source/filters/display,
 * overview, quick-filter chips) without turning / back into a table.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { chatHomePage, liveSessionPage, runPage } from "../../src/browser/run-page.js";

function pages() {
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

describe("sidebar-filters: query", () => {
  test("sidebar-filters: query box lives in the session rail", () => {
    for (const [label, html] of pages()) {
      assert.match(html, /<aside class="agent-rail" aria-label="Sessions">/, `${label}: rail`);
      assert.match(html, /<div class="rail-filters" id="railFilters">/, `${label}: rail-filters`);
      assert.match(html, /<div class="filter-bar" id="filterBar">/, `${label}: filterBar`);
      assert.match(html, /id="filterInput"/, `${label}: filterInput`);
      assert.match(html, /placeholder="Filter — e.g. foo AND \(tool:Read OR tool:Edit\)"/, `${label}: previous-home placeholder`);
      assert.match(html, /id="workspaceSearch"/, `${label}: site-wide / search bar`);
      const railIdx = html.indexOf('class="agent-rail"');
      const filterIdx = html.indexOf('id="filterInput"');
      const listIdx = html.indexOf('id="railList"');
      assert.ok(railIdx >= 0 && filterIdx > railIdx && filterIdx < listIdx, `${label}: query is inside the rail above the list`);
    }
  });
});

describe("sidebar-filters: toolbar", () => {
  test("sidebar-filters: toolbar exposes time-range, Source, Filters, Display", () => {
    for (const [label, html] of pages()) {
      assert.match(html, /id="ageBtn"[^>]*>All time</, `${label}: All time`);
      assert.match(html, /id="ageMenu"/, `${label}: age menu`);
      assert.match(html, /data-age="&lt;1d"/, `${label}: past 24 hours`);
      assert.match(html, /data-age="&lt;7d"/, `${label}: past 7 days`);
      assert.match(html, /data-age="&lt;30d"/, `${label}: past 30 days`);
      assert.match(html, /id="sourceBtn"[^>]*>Source</, `${label}: Source`);
      assert.match(html, /id="sourceMenu"/, `${label}: source menu`);
      assert.match(html, /id="filtersToggle"[^>]*>Filters</, `${label}: Filters`);
      assert.match(html, /id="displayToggle"[^>]*>Display</, `${label}: Display`);
      assert.match(html, /id="sortBar"/, `${label}: Display sort bar`);
      assert.match(html, /data-sort="recent"/, `${label}: sort recent`);
      assert.match(html, /data-sort="duration"/, `${label}: sort duration`);
      assert.match(html, /data-sort="grade"/, `${label}: sort grade`);
      const railIdx = html.indexOf('class="agent-rail"');
      const toolbarIdx = html.indexOf('id="runsToolbar"');
      const listIdx = html.indexOf('id="railList"');
      assert.ok(railIdx >= 0 && toolbarIdx > railIdx && toolbarIdx < listIdx, `${label}: toolbar sits in the rail`);
    }
  });
});

describe("sidebar-filters: overview", () => {
  test("sidebar-filters: overview stats sit in the rail", () => {
    for (const [label, html] of pages()) {
      assert.match(html, /id="railOverview"/, `${label}: #railOverview`);
      assert.match(html, /<span class="dashboard-title">Overview<\/span>/, `${label}: Overview title`);
      assert.match(html, /id="railOverviewStats"/, `${label}: stats slot`);
      assert.match(html, /dashStat\([\s\S]*?, "running"\)/, `${label}: running`);
      assert.doesNotMatch(
        html,
        /dashStat\('<span class="dash-live-n"[^']*>' \+ liveCount \+ "<\/span>", "live"\)/,
        `${label}: overview count is not live`,
      );
      assert.match(html, /dashStat\([\s\S]*?, "runs"\)/, `${label}: runs`);
      assert.match(html, /dashStat\([\s\S]*?, "cost"\)/, `${label}: cost`);
      assert.match(html, /dashStat\([\s\S]*?, "tokens"\)/, `${label}: tokens`);
      assert.match(html, /dashStat\([\s\S]*?, "cache"\)/, `${label}: cache`);
      assert.match(html, /dashStat\([\s\S]*?, "duration"\)/, `${label}: duration`);
      assert.match(html, /dashStat\([\s\S]*?, "errors"\)/, `${label}: errors`);
      assert.match(html, /dashStat\([\s\S]*?, "commits"\)/, `${label}: commits`);
      assert.match(html, /dashStat\([\s\S]*?, "files"\)/, `${label}: files`);
      assert.match(html, /dashStat\([\s\S]*?, "chapters"\)/, `${label}: chapters`);
      const railIdx = html.indexOf('class="agent-rail"');
      const overviewIdx = html.indexOf('id="railOverview"');
      const listIdx = html.indexOf('id="railList"');
      assert.ok(overviewIdx > railIdx && overviewIdx < listIdx, `${label}: overview is in the rail above the list`);
    }
  });
});

describe("sidebar-filters: chips", () => {
  test("sidebar-filters: Filters reveals grade/source/model/errors chips", () => {
    for (const [label, html] of pages()) {
      assert.match(html, /<div class="qf-bar" id="qfBar" hidden>/, `${label}: #qfBar`);
      assert.match(html, /aria-controls="qfBar"/, `${label}: Filters controls qfBar`);
      assert.match(html, /qf-section-label">grade/, `${label}: grade chips`);
      assert.match(html, /qf-section-label">source/, `${label}: source chips`);
      assert.match(html, /qf-section-label">model/, `${label}: model chips`);
      assert.match(html, /with errors/, `${label}: errors chip`);
      assert.match(html, /data-grade="/, `${label}: grade buttons`);
    }
  });
});

describe("sidebar-filters: apply", () => {
  test("sidebar-filters: apply sends expr and sort to /api/sessions and filters the rail list", () => {
    for (const [label, html] of pages()) {
      assert.match(html, /\/api\/sessions\?pageSize=50/, `${label}: sessions fetch`);
      assert.match(html, /<nav class="rail-list" id="railList">/, `${label}: list remains`);
    }
  });
});

describe("sidebar-filters: chat-surface", () => {
  test("sidebar-filters: chat-surface stays the main pane", () => {
    for (const [label, html] of pages()) {
      assert.match(html, /class="tq-shell"/, `${label}: shell`);
      assert.match(html, /class="chat-app"/, `${label}: conversation`);
      assert.match(html, /class="chat-composer"/, `${label}: composer`);
      assert.doesNotMatch(html, /class="runs-inventory"/, `${label}: not the table`);
      assert.doesNotMatch(html, /<h1 class="runs-title">Runs<\/h1>/, `${label}: not the Runs heading`);
      assert.match(html, /<aside class="agent-rail"/, `${label}: rail still lists sessions`);
      assert.match(html, /<div class="rail-head">Sessions/, `${label}: Sessions head`);
    }
  });
});
