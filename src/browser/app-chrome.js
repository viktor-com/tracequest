/**
 * Shared app chrome — ONE identity across surfaces.
 *
 * The dashboard list page and the chat watch pages (/run, /run?session=)
 * are the same app showing the same records, so they share:
 *
 *  - the app top bar (wordmark + "sessions" crumb region + origin-agnostic
 *    live counter + the "+ New run" launcher button) — built by appTopHtml
 *    so both surfaces render byte-identical chrome;
 *  - the identity-row CSS (state badge, source pill, session id, model,
 *    project chip, grade badge, stat chips) — the exact classes the
 *    dashboard's session/run rows use, reused verbatim by the chat header
 *    so drilling into a record reads as the SAME row expanding, not a
 *    second app with its own naming scheme;
 *  - the stat-chip builder (sessionStatChipsHtml/sessionStatsHtml),
 *    embedded via toString into both client bundles so the chat header's
 *    stat line and the list card's stat line can never drift;
 *  - runIsLive()/liveNow(), the origin-agnostic generating predicate and
 *    live count painted into #appLive on both the dashboard and the
 *    chat-page rail (same toString embed); tmux status running is never
 *    sufficient;
 *  - SOURCE_COLORS, the one source→pill-color map.
 *
 * ONE noun on the home surface: the inventory is "Runs" (app crumb, heading,
 * count, overview, filter, flyout kicker). "session" stays the recording
 * identity in APIs and /view; "run" is also the launch/steer verb
 * ("+ New run", "Kill run").
 */
import { fmtTokens, fmtCost, estimateCost, formatDuration } from "../filter/filter-formats.js";
import {
  formatPercent,
  limitingWindow,
  relativeReset,
  usageAmounts,
  usageChipLabel,
  usageChipTitle,
  usageWindowLabel,
} from "../usage/format.js";

/** The one source→pill-color map (dashboard rows, rail rows, chat header). */
export const SOURCE_COLORS = {
  claude: "#a78bfa",
  codex: "#59d4a0",
  factory: "#e0c45e",
  cursor: "#c4e86b",
  "cursor-cloud": "#4dd0e1",
  opencode: "#6ba4e8",
  grok: "#f07070",
};

/** Pill color for a source/agent name. */
export function sourceColor(source) {
  return SOURCE_COLORS[source] || "#7a7a85";
}

/* Client-bundle formatter contract: the functions below are embedded via
   toString into client bundles that define fmtDuration/fmtTokens/
   estimateCost/fmtCost in scope. This module-level wrapper keeps them
   callable server-side too. */
function fmtDuration(ms) {
  return formatDuration(ms, { subSecondLabel: "" });
}

/**
 * The stat CHIPS a session record shows — duration, chapters, tokens, cost,
 * files, errors, commits. One builder for the dashboard list card AND the
 * chat header stat line (embedded via toString into both bundles).
 */
export function sessionStatChipsHtml(s) {
  var stats = [];
  var dur = fmtDuration(s.durationMs);
  if (dur) stats.push('<span class="session-stat duration">' + dur + '</span>');
  if (s.chapters) stats.push('<span class="session-stat">' + s.chapters + ' ch</span>');
  if (s.totalTokens) stats.push('<span class="session-stat tokens">' + fmtTokens(s.totalTokens) + ' tok</span>');
  var cost = estimateCost(s);
  var costStr = fmtCost(cost);
  if (costStr) stats.push('<span class="session-stat cost">' + costStr + '</span>');
  if (s.files) stats.push('<span class="session-stat files-stat">' + s.files + ' files</span>');
  if (s.errors) stats.push('<span class="session-stat errors">' + s.errors + ' err</span>');
  if (s.commits) stats.push('<span class="session-stat commits">' + s.commits + ' commit' + (s.commits !== 1 ? 's' : '') + '</span>');
  return stats.join('');
}

/** The list card's stat row (wrapper around the shared chips). */
export function sessionStatsHtml(s) {
  var chips = sessionStatChipsHtml(s);
  return chips ? '<div class="session-stats">' + chips + '</div>' : '';
}

/**
 * Launched-run RUNNING predicate: the generating word from
 * runGeneratingStatus / GET /api/runs status. Never tmux pane_dead, and
 * never a second _liveSessions snapshot — status "running" is generating
 * (pending first recording or a linked generating turn), "idle" is a
 * settled attached pane (G1), "exited"/"gone" are pane death.
 */
export function runIsLive(r) {
  return !!(r && r.status === "running");
}

/**
 * Launched-run identity-badge word: generating → running, settled pane →
 * idle, pane death → exited/gone. Same bit as runIsLive / detectLiveSessions,
 * never tmux status running alone.
 */
export function runIdentityStatus(r) {
  if (!r) return "idle";
  if (r.status === "exited" || r.status === "gone") return r.status;
  return runIsLive(r) ? "running" : "idle";
}

/**
 * The ONE origin-agnostic is-live definition, shared by every live counter.
 * An agent is live when it is generating NOW — a launched run that runIsLive
 * accepts (never tmux status running alone) OR an externally detected live
 * session with s.live === true. Deduped by recording path so a run and its
 * own recording never count twice. Exited and idle-launched runs never
 * occupy a path. Filters never change this sum.
 * `_runs` and `_liveSessions` are free variables in the client bundles.
 */
export function liveNow() {
  var n = 0;
  var seen = {};
  for (var i = 0; i < _runs.length; i++) {
    if (!runIsLive(_runs[i])) continue;
    n++;
    if (_runs[i].sessionPath) seen[_runs[i].sessionPath] = true;
  }
  for (var j = 0; j < _liveSessions.length; j++) {
    if (_liveSessions[j].live !== true) continue;
    if (!seen[_liveSessions[j].path]) n++;
  }
  return n;
}

/** toString-embeddable sources for client bundles. */
export const SESSION_STAT_CHIPS_HTML_SRC = sessionStatChipsHtml.toString().replace(/^export /, "");
export const SESSION_STATS_HTML_SRC = sessionStatsHtml.toString().replace(/^export /, "");
export const RUN_IS_LIVE_SRC = runIsLive.toString().replace(/^export /, "");
export const RUN_IDENTITY_STATUS_SRC = runIdentityStatus.toString().replace(/^export /, "");
export const LIVE_NOW_SRC = RUN_IS_LIVE_SRC + "\n" + liveNow.toString().replace(/^export /, "");

const LIMITING_WINDOW_SRC = limitingWindow.toString().replace(/^export /, "");
const FORMAT_PERCENT_SRC = formatPercent.toString().replace(/^export /, "");
const RELATIVE_RESET_SRC = relativeReset.toString().replace(/^export /, "");
const USAGE_CHIP_LABEL_SRC = usageChipLabel.toString().replace(/^export /, "");
const USAGE_CHIP_TITLE_SRC = usageChipTitle.toString().replace(/^export /, "");
const USAGE_AMOUNTS_SRC = usageAmounts.toString().replace(/^export /, "");
const USAGE_WINDOW_LABEL_SRC = usageWindowLabel.toString().replace(/^export /, "");

function usageWidgetHtml(harness, host, snapshot) {
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
  var color = (typeof SOURCE_COLORS !== "undefined" && SOURCE_COLORS[harness.id]) || "#7a7a85";
  var id = host ? harness.id + "@" + host : harness.id;
  var unauth = harness.status === "unauthenticated";
  var plan = unauth ? "sign-in" : (harness.plan || "");
  var title = usageChipTitle(harness, { host: host, collectedAt: snapshot && snapshot.collectedAt, now: new Date() });
  var body = "";
  if (unauth) {
    body = '<p class="usage-widget-hint">' + esc(harness.message || "sign in") + "</p>";
  } else {
    var windows = harness.windows || [];
    var limit = limitingWindow(harness);
    for (var i = 0; i < windows.length; i++) {
      var w = windows[i];
      var amounts = usageAmounts(w.utilization);
      var limiting = !!(limit && w.id === limit.id);
      var reset = relativeReset(w.resetsAt, new Date());
      var meters = "";
      if (amounts) {
        meters =
          '<span class="usage-meter"><span class="usage-meter-val">' + amounts.used + '%</span><span class="usage-meter-label">used</span></span>' +
          '<span class="usage-meter"><span class="usage-meter-val">' + amounts.left + '%</span><span class="usage-meter-label">left</span></span>';
      }
      body +=
        '<div class="usage-window' + (limiting ? " is-limiting" : "") + '">' +
        '<span class="usage-window-name">' + esc(usageWindowLabel(w.id)) + "</span>" +
        meters +
        (reset ? '<span class="usage-window-reset">' + esc(reset) + "</span>" : "") +
        "</div>";
    }
  }
  var hostAttr = host ? ' data-host="' + esc(host) + '"' : "";
  return (
    '<article class="usage-widget' + (unauth ? " is-unauth" : "") + '" data-harness="' + esc(harness.id) + '"' + hostAttr +
    ' style="--usage-accent:' + color + '" title="' + esc(title) + '">' +
    '<header class="usage-widget-head"><span class="usage-widget-id">' + esc(id) + "</span>" +
    (plan ? '<span class="usage-widget-plan">' + esc(plan) + "</span>" : "") +
    "</header>" + body + "</article>"
  );
}

function paintUsageLimits(data) {
  var chips = [];
  var widgets = [];
  function pushVisible(snapshot, host) {
    if (!snapshot || !snapshot.harnesses) return;
    for (var i = 0; i < snapshot.harnesses.length; i++) {
      var h = snapshot.harnesses[i];
      if (h.status !== "ok" && h.status !== "unauthenticated") continue;
      var color = (typeof SOURCE_COLORS !== "undefined" && SOURCE_COLORS[h.id]) || "#7a7a85";
      var label = usageChipLabel(h, host);
      var title = usageChipTitle(h, { host: host, collectedAt: snapshot.collectedAt, now: new Date() });
      var unauth = h.status === "unauthenticated";
      chips.push(
        '<span class="app-limit-chip' + (unauth ? " is-unauth" : "") + '"' +
          (unauth ? "" : ' style="background:' + color + '"') +
          ' title="' +
          String(title).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;") +
          '">' +
          String(label).replace(/&/g, "&amp;").replace(/</g, "&lt;") +
          "</span>",
      );
      widgets.push(usageWidgetHtml(h, host, snapshot));
    }
  }
  if (data && data.local) pushVisible(data.local, null);
  var hosts = (data && data.hosts) || [];
  for (var j = 0; j < hosts.length; j++) pushVisible(hosts[j], hosts[j].host);
  var row = document.getElementById("usageRow");
  if (row) {
    if (!widgets.length) {
      row.hidden = true;
      row.innerHTML = "";
    } else {
      row.hidden = false;
      row.innerHTML = widgets.join("");
    }
  }
  var el = document.getElementById("appLimits");
  if (!el) return;
  if (!chips.length) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  el.hidden = false;
  el.innerHTML = chips.join("");
}

function startUsageLimitsPolling(intervalMs) {
  if (typeof fetch !== "function") return;
  var ms = intervalMs || 60000;
  function load() {
    fetch("/api/usage-limits")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data) paintUsageLimits(data); })
      .catch(function () { /* meters stay hidden */ });
  }
  if (typeof window !== "undefined") window.paintUsageLimits = paintUsageLimits;
  load();
  setInterval(load, ms);
}

export const USAGE_LIMITS_CLIENT_SRC =
  LIMITING_WINDOW_SRC + "\n" +
  FORMAT_PERCENT_SRC + "\n" +
  RELATIVE_RESET_SRC + "\n" +
  USAGE_CHIP_LABEL_SRC + "\n" +
  USAGE_CHIP_TITLE_SRC + "\n" +
  USAGE_AMOUNTS_SRC + "\n" +
  USAGE_WINDOW_LABEL_SRC + "\n" +
  usageWidgetHtml.toString().replace(/^export /, "") + "\n" +
  paintUsageLimits.toString().replace(/^export /, "") + "\n" +
  startUsageLimitsPolling.toString().replace(/^export /, "");

/**
 * The app top bar, shared by the dashboard and the chat watch pages:
 * wordmark linking home, "/" separator, a caller-supplied crumb (the
 * dashboard mounts the Runs crumb there; chat pages still say
 * "sessions"), the origin-agnostic live counter (#appLive, client-filled),
 * optional extra elements, and the "+ New run" launcher button.
 */
export function appTopHtml({ crumbHtml, extraHtml = "" } = {}) {
  return `<header class="app-top">
    <a class="app-wordmark" href="/">tracequest</a>
    <span class="app-crumb-sep">/</span>
    ${crumbHtml}
    <span class="app-live" id="appLive" hidden></span>
    <span class="app-limits" id="appLimits" hidden></span>${extraHtml}
    <button class="cmdk-trigger" id="cmdkTrigger" type="button" aria-label="Open command menu" title="Command menu">
      <kbd class="cmdk-trigger-kbd">⌘K</kbd>
    </button>
    <button class="new-run-btn" id="newRunBtn" type="button" title="Start an agent run">+ New run</button>
  </header>
  <div class="usage-row" id="usageRow" hidden aria-label="Harness usage"></div>`;
}

export const APP_TOP_CSS = `
/* ---- shared app top bar (dashboard + chat watch pages) ---- */
.app-top {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  flex: none;
  background: var(--bg);
}
.app-wordmark { font-size: 16px; font-weight: 500; letter-spacing: -0.01em; color: var(--fg); text-decoration: none; line-height: 1.2; }
.app-wordmark:hover { color: var(--fg2); }
.app-crumb-sep { font-size: 12px; color: var(--fg3); }
.app-crumb { font-size: 13px; color: var(--fg3); }
.app-live {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--green);
  align-self: center;
}
.app-live[hidden] { display: none; }
.app-limits {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  overflow: hidden;
  min-width: 0;
  max-width: min(52vw, 420px);
  align-self: center;
}
.app-limits[hidden] { display: none; }
.app-limit-chip {
  flex: none;
  font-size: 10px;
  font-family: var(--mono);
  line-height: 1.2;
  padding: 2px 6px;
  border-radius: 999px;
  color: #111;
  white-space: nowrap;
}
.app-limit-chip.is-unauth {
  color: var(--fg2);
  box-shadow: inset 0 0 0 1px var(--border);
}
@media (max-width: 720px) {
  .app-limits { max-width: 42vw; }
}
.usage-row {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 10px 18px;
  width: 100%;
  box-sizing: border-box;
  padding: 6px 16px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  font-family: var(--mono);
}
.usage-row[hidden] { display: none; }
.usage-widget {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  max-width: 100%;
  padding-left: 8px;
  border-left: 2px solid var(--usage-accent, var(--border));
}
.usage-widget.is-unauth { border-left-color: var(--border); }
.usage-widget-head {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.usage-widget-id {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--fg);
}
.usage-widget-plan {
  font-size: 10px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: var(--fg3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-window {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
}
.usage-window.is-limiting .usage-window-name { color: var(--fg); }
.usage-window-name,
.usage-meter-label,
.usage-window-reset {
  font-size: 10px;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  color: var(--fg3);
}
.usage-meter {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.usage-meter-val {
  font-size: 14px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  line-height: 1.2;
}
.usage-widget-hint {
  margin: 0;
  font-size: 11px;
  color: var(--fg2);
  font-family: var(--mono);
}
@media (max-width: 600px) {
  .usage-row { gap: 8px 12px; padding: 6px 12px 8px; }
  .usage-meter-val { font-size: 13px; }
}
`;

/**
 * The identity row a session record wears EVERYWHERE — list card and chat
 * header alike: state badge, source pill, session id, model, project chip,
 * grade badge, stat chips. One stylesheet chunk, interpolated into both
 * pages, so the record cannot look like two objects.
 */
export const IDENTITY_ROW_CSS = `
/* ---- shared identity row: the same record, the same chips, everywhere ---- */
.session-top { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.session-id { font-family: var(--mono); font-size: 13px; color: var(--fg); font-weight: 500; }
.session-model { font-size: 11px; color: var(--fg3); font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 140px; }
.session-model[hidden] { display: none; }
.session-project {
  font-size: 11px; color: var(--fg3); font-family: var(--mono);
  background: rgba(255,255,255,0.04); padding: 1px 6px; border-radius: 4px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;
}
.session-source {
  font-size: 11px; font-family: var(--mono); font-weight: 500;
  padding: 1px 8px; border-radius: 999px; color: var(--fg);
  /* the inline source hue becomes a quiet tint instead of a solid fill */
  box-shadow: inset 0 0 0 999px rgba(17, 17, 19, 0.78);
}
@keyframes live-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.run-state-badge {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 11px; font-family: var(--mono); font-weight: 500;
}
.run-state-badge::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
}
.run-state-badge[data-status="running"] { color: var(--green); }
.run-state-badge[data-status="running"]::before {
  background: var(--green); animation: live-pulse 2s ease-in-out infinite;
}
.run-state-badge[data-status="exited"] { color: var(--fg3); }
.run-state-badge[data-status="exited"]::before { background: var(--fg3); }
.run-state-badge[data-status="idle"] { color: var(--fg3); }
.run-state-badge[data-status="idle"]::before { background: var(--fg3); animation: none; }
.run-state-badge[data-status="gone"] { color: var(--red); }
.run-state-badge[data-status="gone"]::before { background: var(--red); }
.run-origin {
  font-size: 10px; font-family: var(--mono); font-weight: 500;
  color: var(--fg3);
  border: 1px solid var(--border); border-radius: 999px; padding: 0 7px;
  flex-shrink: 0;
}
.session-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 5px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  font-variant-numeric: tabular-nums;
}
.session-stat { display: inline-flex; align-items: center; gap: 3px; }
.session-stat-icon { font-size: 10px; }
.session-stat.errors { color: var(--red); }
.session-stat.tokens { color: var(--fg3); }
.session-stat.commits { color: var(--green); }
.session-stat.files-stat { color: var(--fg3); }
.session-stat.duration { color: var(--fg2); }
.session-stat.cost { color: var(--orange); }
.session-grade-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-family: var(--mono);
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
}
.session-grade-badge[hidden] { display: none; }
.session-grade-badge.grade-a { color: var(--green); background: rgba(74,222,128,0.10); }
.session-grade-badge.grade-b { color: var(--green); background: rgba(74,222,128,0.07); opacity: 0.85; }
.session-grade-badge.grade-c { color: var(--orange); background: rgba(232,164,76,0.10); }
.session-grade-badge.grade-d { color: #d97740; background: rgba(217,119,64,0.10); }
.session-grade-badge.grade-f { color: var(--red); background: rgba(240,112,112,0.10); }
`;
