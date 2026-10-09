/**
 * Execute production chat-page renderRail() against a sessions/liveSessions
 * snapshot so D1 can assert #appLive and the rail overview from the same
 * liveNow() sum the dashboard uses. Optional `_runs` / `railExpr` must not
 * change that chrome count (row filtering stays local to the rail list).
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { liveSessionPage } from "../../src/browser/run-page.js";

function shellRailScript() {
  const page = liveSessionPage({
    session: {
      hash: "watch",
      path: "/tmp/watch.jsonl",
      source: "grok",
      project: "sample-app",
      live: false,
    },
  });
  const start = page.indexOf("var SOURCE_COLORS = ");
  const end = page.indexOf("var _tick = 0");
  assert.ok(start >= 0 && end > start, "chat-page shell includes SOURCE_COLORS..renderRail");
  return { page, src: page.slice(start, end) };
}

/** Production renderRail + renderOverview from a liveSessionPage snapshot. */
export function renderChatRail({
  runs = [],
  sessions = [],
  liveSessions = [],
  stats,
  current = { type: "session", id: "watch" },
  railExpr = "",
} = {}) {
  const { src } = shellRailScript();
  const railList = { innerHTML: "" };
  const railCount = { textContent: "" };
  const appLive = { hidden: true, textContent: "" };
  const overviewStats = { innerHTML: "" };
  const overviewScope = { textContent: "" };
  const overviewBox = {
    querySelector() { return null; },
    classList: { toggle() {} },
    appendChild() {},
  };
  const ctx = {
    RAIL_CURRENT: current,
    Date,
    encodeURIComponent,
    isNaN,
    Math,
    String,
    Number,
    parseInt,
    parseFloat,
    Object,
    Array,
    JSON,
    Boolean,
    document: {
      getElementById(id) {
        if (id === "railList") return railList;
        if (id === "railCount") return railCount;
        if (id === "appLive") return appLive;
        if (id === "railOverviewStats") return overviewStats;
        if (id === "railOverviewScope") return overviewScope;
        if (id === "railOverview") return overviewBox;
        return null;
      },
      querySelector() { return null; },
      createElement() {
        return {
          type: "",
          className: "",
          id: "",
          textContent: "",
          innerHTML: "",
          setAttribute() {},
          addEventListener() {},
        };
      },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(
    `${src}
_runs = ${JSON.stringify(runs)};
_sessions = ${JSON.stringify(sessions)};
_liveSessions = ${JSON.stringify(liveSessions)};
_stats = ${JSON.stringify(stats ?? { totalSessions: sessions.length })};
_serverTotal = ${sessions.length};
_railExpr = ${JSON.stringify(railExpr)};
if (typeof syncQfStateFromExpr === "function") syncQfStateFromExpr();
renderRail();`,
    ctx,
  );
  return {
    html: railList.innerHTML,
    railCount: railCount.textContent,
    appLive,
    overviewHtml: overviewStats.innerHTML,
  };
}

export function assertChatRailLiveCount(shot, expected, msg) {
  const prefix = msg ? `${msg}: ` : "";
  assert.equal(shot.appLive.hidden, expected === 0, `${prefix}#appLive is hidden iff live count is 0`);
  assert.match(shot.appLive.textContent, new RegExp(`${expected} running`), `${prefix}#appLive text is ${expected} running`);
  assert.doesNotMatch(shot.appLive.textContent, /\d+ live\b/, `${prefix}#appLive does not say N live`);
  if (expected) {
    assert.equal(shot.railCount, `${expected} running`, `${prefix}railCount is ${expected} running`);
    assert.match(
      shot.overviewHtml,
      new RegExp(`color:var\\(--ok\\)">${expected}</span></span><span class="dashboard-stat-label">running`),
      `${prefix}overview running stat is ${expected}`,
    );
    assert.doesNotMatch(shot.overviewHtml, /dashboard-stat-label">live/, `${prefix}overview does not say live`);
  } else {
    assert.equal(shot.railCount, "", `${prefix}railCount is empty when nothing is live`);
    assert.doesNotMatch(shot.overviewHtml, /dashboard-stat-label">(?:live|running)/, `${prefix}overview has no running/live stat`);
  }
}
