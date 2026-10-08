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
        var fill = Math.max(0, Math.min(100, Number(amounts.used) || 0));
        meters =
          '<span class="usage-bar" aria-hidden="true"><i style="width:' + fill + '%"></i></span>' +
          '<span class="usage-meter"><span class="usage-meter-val">' + amounts.used + '%</span><span class="usage-meter-label">used</span></span>' +
          '<span class="usage-meter usage-meter-left"><span class="usage-meter-val">' + amounts.left + '%</span><span class="usage-meter-label">left</span></span>';
      }
      body +=
        '<div class="usage-window' + (limiting ? " is-limiting" : "") + (amounts && amounts.used >= 80 ? " is-high" : "") + '">' +
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
          ' style="--chip-hue:' + color + '"' +
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
export const APP_NAV_CSS = `
.theme-toggle {
  display: inline-flex; align-items: center; justify-content: center; align-self: center;
  width: 28px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 999px;
  background: transparent; color: var(--fg3); cursor: pointer; transition: color 0.15s ease, border-color 0.15s ease;
}
.theme-toggle svg { width: 14px; height: 14px; }
/* keep the toggle beside ⌘K, after the search field the palette mounts */
.app-top > .theme-toggle, .app-top > .cmdk-trigger, .app-top > .new-run-btn { order: 1; }
.theme-toggle:hover { color: var(--fg); }
.theme-toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.app-nav { display: inline-flex; align-items: center; gap: 2px; align-self: center; margin-left: 8px; }
.app-nav-item {
  font-size: 13px; color: var(--fg3); text-decoration: none;
  padding: 4px 10px; border-radius: 999px; transition: color 0.15s ease, background 0.15s ease;
}
.app-nav-item:hover { color: var(--fg); background: var(--surface2); }
.app-nav-item[aria-current="page"] { color: var(--fg); background: var(--surface2); }
.app-nav-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
@media (max-width: 600px) { .app-nav-item { padding: 4px 7px; } }
`;

export function appNavHtml(current) {
  const item = (key, href, label, kbd) =>
    `<a class="app-nav-item" href="${href}" data-nav="${key}" title="${label} (g then ${kbd})"` +
    (current === key ? ' aria-current="page"' : "") + `>${label}</a>`;
  return `<nav class="app-nav" aria-label="Sections">${item("chat", "/", "Chat", "c")}${item("runs", "/sessions", "Runs", "r")}${item("insights", "/insights", "Insights", "i")}</nav>`;
}

/**
 * App shell behaviour shared by every served page: the remembered theme
 * (system by default, then light or dark from the top-bar toggle). Section
 * jumps stay with the CommandPalette's g-chords (g c, g r, g i).
 */
export const APP_SHELL_JS = `(function () {
  var root = document.documentElement;
  function stored() { try { return localStorage.getItem("tq-theme"); } catch (_) { return null; } }
  function effective() {
    var t = stored();
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function apply() {
    var t = stored();
    if (t === "light" || t === "dark") root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
    var btn = document.getElementById("themeToggle");
    if (btn) {
      var next = effective() === "light" ? "dark" : "light";
      btn.setAttribute("aria-label", "Switch to " + next + " theme");
      btn.title = "Switch to " + next + " theme";
    }
  }
  apply();
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("#themeToggle") : null;
    if (!btn) return;
    var next = effective() === "light" ? "dark" : "light";
    try { localStorage.setItem("tq-theme", next); } catch (_) {}
    apply();
  });
})();`;

export function appTopHtml({ crumbHtml, extraHtml = "", nav = "" } = {}) {
  return `<header class="app-top">
    <a class="app-wordmark" href="/">tracequest</a>
    <span class="app-crumb-sep">/</span>
    ${crumbHtml}
    ${appNavHtml(nav)}
    <span class="app-live" id="appLive" hidden></span>
    <span class="app-limits" id="appLimits" hidden></span>${extraHtml}
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Switch theme" title="Switch theme"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.75a6.25 6.25 0 0 1 0 12.5z" fill="currentColor"/></svg></button>
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
/* Section nav replaces the static crumb visually; the crumb stays for screen readers. */
.app-top:has(.app-nav) > .app-crumb-sep,
.app-top:has(.app-nav) > .app-crumb {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
${APP_NAV_CSS}
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
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-family: var(--mono);
  line-height: 1.2;
  padding: 2px 8px;
  border-radius: 999px;
  color: var(--fg2);
  box-shadow: inset 0 0 0 1px var(--border);
  white-space: nowrap;
}
.app-limit-chip::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--chip-hue, var(--fg3));
}
.app-limit-chip.is-unauth { color: var(--fg3); }
.app-limit-chip.is-unauth::before { background: transparent; box-shadow: inset 0 0 0 1px var(--fg3); }
@media (max-width: 720px) {
  .app-limits { max-width: 42vw; }
}
/* Plan windows: one quiet scrollable line, not a wall of uppercase. */
.usage-row {
  display: flex;
  flex: none;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0;
  width: 100%;
  box-sizing: border-box;
  padding: 0 12px;
  min-height: 34px;
  overflow-x: auto;
  scrollbar-width: none;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  font-family: var(--mono);
  font-size: 11px;
}
.usage-row::-webkit-scrollbar { display: none; }
.usage-row[hidden] { display: none; }
.usage-widget {
  display: flex;
  flex: none;
  align-items: center;
  gap: 10px;
  padding: 6px 14px 6px 8px;
  border-left: 0;
  white-space: nowrap;
}
.usage-widget + .usage-widget { box-shadow: inset 1px 0 0 var(--border); padding-left: 14px; }
.usage-widget.is-unauth { opacity: 0.7; }
.usage-widget-head { display: inline-flex; align-items: center; gap: 6px; }
.usage-widget-id { color: var(--fg); display: inline-flex; align-items: center; gap: 6px; }
.usage-widget-id::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%;
  background: var(--usage-accent, var(--fg3));
}
.usage-widget.is-unauth .usage-widget-id::before { background: transparent; box-shadow: inset 0 0 0 1px var(--fg3); }
.usage-widget-plan {
  color: var(--fg3);
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.usage-window { display: inline-flex; align-items: center; gap: 6px; }
.usage-window-name, .usage-meter-label, .usage-window-reset { color: var(--fg3); }
.usage-window.is-limiting .usage-window-name { color: var(--fg2); }
.usage-meter { display: inline-flex; align-items: baseline; gap: 3px; }
.usage-meter-left {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.usage-meter-val { color: var(--fg); font-variant-numeric: tabular-nums; }
.usage-bar {
  position: relative; display: inline-block; width: 36px; height: 4px;
  border-radius: 999px; background: var(--surface2); overflow: hidden;
}
.usage-bar > i {
  position: absolute; inset: 0 auto 0 0; border-radius: inherit;
  background: var(--fg2); transition: width 0.3s ease;
}
.usage-window.is-high .usage-bar > i { background: var(--orange); }
.usage-window.is-high .usage-meter-val { color: var(--orange); }
.usage-window-reset::before { content: '\u00b7 '; }
.usage-widget-hint { margin: 0; color: var(--fg2); font-size: 11px; }
@media (max-width: 600px) {
  .usage-row { padding: 0 8px; }
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
  box-shadow: inset 0 0 0 999px var(--chip-tint, rgba(17, 17, 19, 0.78));
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
.session-stat { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
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
