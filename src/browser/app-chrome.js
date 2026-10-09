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
  claude: "var(--hue-claude)",
  codex: "var(--hue-codex)",
  factory: "var(--hue-factory)",
  cursor: "var(--hue-cursor)",
  "cursor-cloud": "var(--hue-cursor-cloud)",
  opencode: "var(--hue-opencode)",
  grok: "var(--hue-grok)",
};

/** Pill color for a source/agent name. */
export function sourceColor(source) {
  return SOURCE_COLORS[source] || "var(--hue-other)";
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
  var color = (typeof SOURCE_COLORS !== "undefined" && SOURCE_COLORS[harness.id]) || "var(--hue-other)";
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
          '<span class="usage-bar' + (fill >= 80 ? " is-high" : "") + '" aria-hidden="true"><i style="width:' + fill + '%"></i></span>' +
          '<span class="usage-meter"><span class="usage-meter-val">' + amounts.used + '%</span><span class="usage-meter-label">used</span></span>' +
          '<span class="usage-meter usage-meter-left"><span class="usage-meter-val">' + amounts.left + '%</span><span class="usage-meter-label">left</span></span>';
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
    ' style="--hue:' + color + '" title="' + esc(title) + '">' +
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
      var color = (typeof SOURCE_COLORS !== "undefined" && SOURCE_COLORS[h.id]) || "var(--hue-other)";
      var label = usageChipLabel(h, host);
      var title = usageChipTitle(h, { host: host, collectedAt: snapshot.collectedAt, now: new Date() });
      var unauth = h.status === "unauthenticated";
      chips.push(
        '<span class="app-limit-chip' + (unauth ? " is-unauth" : "") + '"' +
          ' style="--hue:' + color + '"' +
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
  var btn = document.getElementById("appLimitsBtn");
  if (!el) return;
  if (!chips.length) {
    el.hidden = true;
    el.innerHTML = "";
    if (btn) btn.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = chips.join("");
  if (btn) {
    btn.hidden = false;
    btn.setAttribute("data-more", chips.length > 3 ? "+" + (chips.length - 3) : "");
  }
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

/** The tracequest mark: two offset strokes, a trace and its echo. */
const MARK_SVG = '<svg class="app-mark" width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true"><rect x="1.25" y="1.25" width="15.5" height="15.5" rx="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M5 11.5h2.5l1.5-5 1.5 5H13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const ICON_THEME = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor"/></svg>';
const ICON_PLUS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';

/**
 * Section nav, the same three names everywhere: Chat (/), Runs (/sessions),
 * Insights (/insights). `current` marks the page with aria-current.
 */
export function appNavHtml(current) {
  const item = (key, href, label, kbd) =>
    `<a class="app-nav-item" href="${href}" data-nav="${key}" title="${label} — g then ${kbd}"` +
    (current === key ? ' aria-current="page"' : "") + `>${label}</a>`;
  return `<nav class="app-nav" aria-label="Sections">${item("chat", "/", "Chat", "c")}${item("runs", "/sessions", "Runs", "r")}${item("insights", "/insights", "Insights", "i")}</nav>`;
}

/**
 * Sets html[data-theme] before first paint from the remembered choice, so a
 * page never flashes the wrong theme. Embedded in every served page's head.
 */
export const THEME_BOOT_SCRIPT = `<script>(function(){try{var t=localStorage.getItem("tq-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();</script>`;

/**
 * Shell behaviour shared by every served page: the theme toggle (system by
 * default, remembered once chosen) and the plan-limits popover.
 */
export const APP_SHELL_JS = `(function () {
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;
  var root = document.documentElement;
  function stored() { try { return localStorage.getItem("tq-theme"); } catch (_) { return null; } }
  function effective() {
    var t = stored();
    if (t === "light" || t === "dark") return t;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  function paintToggle() {
    var btn = document.getElementById("themeToggle");
    if (!btn) return;
    var next = effective() === "light" ? "dark" : "light";
    btn.setAttribute("aria-label", "Switch to " + next + " theme");
    btn.title = "Switch to " + next + " theme";
  }
  paintToggle();
  function setLimitsOpen(open) {
    var btn = document.getElementById("appLimitsBtn");
    var panel = document.getElementById("usageRow");
    if (!btn || !panel) return;
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    panel.classList.toggle("is-open", !!open);
  }
  document.addEventListener("click", function (e) {
    var t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest("#themeToggle")) {
      var next = effective() === "light" ? "dark" : "light";
      try { localStorage.setItem("tq-theme", next); } catch (_) {}
      root.setAttribute("data-theme", next);
      root.classList.add("theme-switching");
      setTimeout(function () { root.classList.remove("theme-switching"); }, 260);
      paintToggle();
      return;
    }
    if (t.closest("#appLimitsBtn")) {
      var b = document.getElementById("appLimitsBtn");
      setLimitsOpen(b.getAttribute("aria-expanded") !== "true");
      return;
    }
    if (!t.closest("#usageRow")) setLimitsOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") setLimitsOpen(false);
  });
})();`;

/**
 * The app top bar for every app page: mark and wordmark, section nav with
 * the live count, then search (mounted by the palette), plan limits, theme,
 * ⌘K and the primary "New run" action. The page crumb stays for screen
 * readers; the nav carries the visible location.
 */
export function appTopHtml({ crumbHtml, extraHtml = "", nav = "" } = {}) {
  return `<header class="app-top">
    <a class="app-wordmark" href="/" aria-label="tracequest — Chat">${MARK_SVG}<span>tracequest</span></a>
    <span class="app-crumb-sep">/</span>
    ${crumbHtml}
    ${appNavHtml(nav)}
    <span class="app-live" id="appLive" hidden></span>${extraHtml}
    <button class="app-limits-btn" id="appLimitsBtn" type="button" aria-haspopup="dialog" aria-expanded="false" aria-controls="usageRow" title="Plan limits" hidden><span class="app-limits" id="appLimits" hidden></span></button>
    <button class="theme-toggle" id="themeToggle" type="button" aria-label="Switch theme" title="Switch theme">${ICON_THEME}</button>
    <button class="cmdk-trigger" id="cmdkTrigger" type="button" aria-label="Open command menu" title="Command menu">
      <kbd class="cmdk-trigger-kbd">⌘K</kbd>
    </button>
    <button class="new-run-btn" id="newRunBtn" type="button" title="Start an agent run — g then n">${ICON_PLUS}<span>New run</span></button>
  </header>
  <div class="usage-row" id="usageRow" hidden role="dialog" aria-label="Plan limits"></div>`;
}

/**
 * The same top bar for script-free pages (Insights, which is served to the
 * hub and never ships a script): wordmark, section nav and a New run link.
 * Theme follows the system there.
 */
export function appTopStaticHtml(nav) {
  return `<header class="app-top">
    <a class="app-wordmark" href="/" aria-label="tracequest — Chat">${MARK_SVG}<span>tracequest</span></a>
    ${appNavHtml(nav)}
    <a class="new-run-btn app-top-push" href="/?launch=1" title="Start an agent run">${ICON_PLUS}<span>New run</span></a>
  </header>`;
}

export const APP_TOP_CSS = `
/* ---- app shell: top bar ---- */
.app-top {
  position: sticky; top: 0; z-index: var(--z-sticky);
  display: flex; align-items: center; gap: var(--space-2);
  height: var(--shell-top); padding: 0 var(--space-4) 0 var(--space-5);
  background: color-mix(in oklab, var(--bg) 88%, transparent);
  backdrop-filter: saturate(1.4) blur(12px); -webkit-backdrop-filter: saturate(1.4) blur(12px);
  box-shadow: inset 0 -1px 0 var(--line-1);
  flex: none;
}
.app-wordmark {
  display: inline-flex; align-items: center; gap: 8px; margin-right: var(--space-4);
  font-size: 15px; font-weight: var(--weight-medium); letter-spacing: -0.02em; color: var(--text);
  transition: opacity var(--dur-2) var(--ease-out);
}
.app-wordmark:hover { opacity: 0.8; }
.app-mark { color: var(--text); flex: none; }
.app-crumb-sep, .app-crumb {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.app-nav { display: inline-flex; align-items: center; gap: 2px; }
.app-nav-item {
  position: relative; display: inline-flex; align-items: center; height: var(--control-md); padding: 0 12px;
  border-radius: var(--radius-pill); font-size: var(--text-md); color: var(--text-2);
  transition: color var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.app-nav-item:hover { color: var(--text); background: var(--hover); }
.app-nav-item[aria-current="page"] { color: var(--text); background: var(--surface-2); }
.app-live {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px 0 8px; margin-left: var(--space-1);
  border-radius: var(--radius-pill); font-size: var(--text-xs); color: var(--ok); background: var(--ok-soft);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.app-live::before {
  content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok);
  animation: ui-pulse 2.2s var(--ease-out) infinite;
}
.app-live[hidden] { display: none; }
/* right cluster, in reading order: search, limits, theme, ⌘K, New run */
.app-top > .tq-search { order: 1; margin-left: auto; }
.app-top > .app-limits-btn { order: 2; }
.app-top > .theme-toggle { order: 3; }
.app-top > .cmdk-trigger { order: 4; }
.app-top > .new-run-btn { order: 5; }
.app-top > .app-top-push { margin-left: auto; }
.app-limits-btn {
  display: inline-flex; align-items: center; gap: 6px; height: var(--control-md); padding: 0 10px;
  border-radius: var(--radius-pill); color: var(--text-2); transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.app-limits-btn:hover, .app-limits-btn[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.app-limits-btn[data-more]:not([data-more=""])::after { content: attr(data-more); font-size: var(--text-xs); color: var(--text-3); }
.app-limits { display: inline-flex; align-items: center; gap: 10px; }
.app-limits[hidden] { display: none; }
.app-limit-chip {
  display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-xs); white-space: nowrap;
  font-variant-numeric: tabular-nums; color: inherit;
}
.app-limit-chip:nth-child(n+4) { display: none; }
.app-limit-chip::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--text-4)); }
.app-limit-chip.is-unauth { color: var(--text-3); }
.app-limit-chip.is-unauth::before { background: transparent; box-shadow: inset 0 0 0 1px var(--text-3); }
.theme-toggle {
  display: inline-grid; place-items: center; width: var(--control-md); height: var(--control-md);
  border-radius: var(--radius-pill); color: var(--text-3);
  transition: color var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.theme-toggle:hover { color: var(--text); background: var(--hover); }
.new-run-btn {
  display: inline-flex; align-items: center; gap: 6px; height: var(--control-md); padding: 0 14px 0 11px; margin-left: var(--space-1);
  border-radius: var(--radius-pill); background: var(--ink); color: var(--paper);
  font-size: var(--text-sm); white-space: nowrap;
  transition: background var(--dur-2) var(--ease-out), transform var(--dur-1) var(--ease-out);
}
.new-run-btn:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.new-run-btn:active { transform: translateY(0.5px); }
html.theme-switching, html.theme-switching * { transition: background-color var(--dur-3) var(--ease-out), color var(--dur-3) var(--ease-out), box-shadow var(--dur-3) var(--ease-out) !important; }

/* ---- plan limits popover ---- */
.usage-row {
  position: fixed; top: calc(var(--shell-top) - 4px); right: var(--space-4); z-index: var(--z-popover);
  width: min(460px, calc(100vw - 32px)); max-height: min(70vh, 560px); overflow: auto;
  display: none; flex-direction: column; gap: 2px; padding: var(--space-2);
  background: var(--surface-pop); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop);
  font-size: var(--text-sm);
}
.usage-row.is-open:not([hidden]) { display: flex; animation: ui-pop-in var(--dur-2) var(--ease-out); }
.usage-widget { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); }
.usage-widget + .usage-widget { box-shadow: inset 0 1px 0 var(--line-1); border-radius: 0; }
.usage-widget-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.usage-widget-id { display: inline-flex; align-items: center; gap: 7px; color: var(--text); font-size: var(--text-sm); }
.usage-widget-id::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--text-4)); }
.usage-widget.is-unauth .usage-widget-id::before { background: transparent; box-shadow: inset 0 0 0 1px var(--text-3); }
.usage-widget-plan { margin-left: auto; font-size: var(--text-xs); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 200px; }
.usage-window { display: grid; grid-template-columns: 88px 1fr auto auto; align-items: center; gap: 10px; font-size: var(--text-xs); color: var(--text-3); }
.usage-window.is-limiting .usage-window-name { color: var(--text-2); }
.usage-window-name { white-space: nowrap; }
.usage-bar { position: relative; height: 4px; border-radius: 999px; background: var(--surface-4); overflow: hidden; }
.usage-bar > i { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--text-2); transition: width var(--dur-4) var(--ease-out); }
.usage-bar.is-high > i { background: var(--accent); }
.usage-meter { display: inline-flex; align-items: baseline; gap: 3px; }
.usage-meter-val { color: var(--text); font-variant-numeric: tabular-nums; }
.usage-meter-left { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.usage-window-reset { white-space: nowrap; text-align: right; min-width: 92px; }
.usage-widget-hint { margin: 0; font-size: var(--text-xs); color: var(--text-3); }

@media (max-width: 900px) {
  .app-top .cmdk-trigger { display: none; }
  .app-top .app-limit-chip:nth-child(n+2) { display: none; }
  .app-top .app-limits-btn[data-more]:not([data-more=""])::after { content: none; }
}
@media (max-width: 640px) {
  .app-top { padding: 0 var(--space-3); gap: var(--space-1); }
  .app-top .app-wordmark { margin-right: var(--space-1); }
  .app-top .app-wordmark span { display: none; }
  .app-top .app-nav-item { padding: 0 7px; font-size: var(--text-sm); }
  .app-top .app-live { display: none; }
  .app-top .app-limits-btn { padding: 0 6px; max-width: 22vw; overflow: hidden; }
  .app-top .app-limit-chip { overflow: hidden; text-overflow: ellipsis; }
  .app-top .tq-search-input { width: 32px; padding: 0 0 0 30px; }
  .app-top .tq-search-input:focus { width: 160px; }
  .app-top .tq-search-kbd { display: none; }
  .app-top .new-run-btn span { display: none; }
  .app-top .new-run-btn { padding: 0 9px; margin-left: 0; }
}
@media (max-width: 480px) {
  .app-top .theme-toggle { display: none; }
}
@media print { .app-top, .usage-row { display: none !important; } }
`;

/**
 * The identity row a session record wears EVERYWHERE — list card and chat
 * header alike: state badge, source pill, session id, model, project chip,
 * grade badge, stat chips. One stylesheet chunk, interpolated into both
 * pages, so the record cannot look like two objects.
 */
export const IDENTITY_ROW_CSS = `
/* ---- identity: the same record wears the same marks everywhere ---- */
.session-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
.session-id { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
.session-model { font-size: var(--text-xs); color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.session-model[hidden] { display: none; }
.session-project { font-size: var(--text-xs); color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
.session-source {
  display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--text-2); white-space: nowrap;
}
.session-source::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--hue-other)); flex: none; }
.run-state-badge {
  display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
  font-size: var(--text-xs); color: var(--text-3); white-space: nowrap;
}
.run-state-badge::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--text-4); flex: none; }
.run-state-badge[data-status="running"] { color: var(--ok); }
.run-state-badge[data-status="running"]::before { background: var(--ok); animation: ui-pulse 2.2s var(--ease-out) infinite; }
.run-state-badge[data-status="idle"] { color: var(--text-3); }
.run-state-badge[data-status="idle"]::before { background: var(--warn); }
.run-state-badge[data-status="exited"]::before { background: var(--text-4); }
.run-state-badge[data-status="gone"] { color: var(--bad); }
.run-state-badge[data-status="gone"]::before { background: var(--bad); }
.run-origin {
  display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-3); box-shadow: inset 0 0 0 1px var(--line-2); flex-shrink: 0; white-space: nowrap;
}
.session-stats {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
  font-size: var(--text-xs); color: var(--text-3); font-variant-numeric: tabular-nums;
}
.session-stat { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
.session-stat.errors { color: var(--bad); }
.session-stat.commits { color: var(--ok); }
.session-stat.duration { color: var(--text-2); }
.session-stat.cost { color: var(--text-2); }
.session-grade-badge {
  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 5px;
  border-radius: var(--radius-xs); font-family: var(--font-mono); font-size: 11px; font-weight: var(--weight-medium);
  color: var(--text-2); background: var(--surface-3); white-space: nowrap; cursor: default;
}
.session-grade-badge[hidden] { display: none; }
.session-grade-badge.grade-a { color: var(--ok); background: var(--ok-soft); }
.session-grade-badge.grade-b { color: var(--ok); background: color-mix(in srgb, var(--ok) 9%, transparent); }
.session-grade-badge.grade-c { color: var(--warn); background: var(--warn-soft); }
.session-grade-badge.grade-d { color: var(--warn); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.session-grade-badge.grade-f { color: var(--bad); background: var(--bad-soft); }
`;
