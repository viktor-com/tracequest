import { FAVICON_LINKS } from "../ui/brand.js";
/**
 * /run watch page — Cursor-style live chat transcript for one Run.
 *
 * Server-generated single-string HTML the browser-page way (doctype +
 * inline <style> + body + inline <script>, no client framework). The
 * conversation surface is the page: the client polls
 * /api/runs/session?id=@N[&etag=…] roughly every second and renders the
 * run's unified Session as a chat — user bubbles, assistant prose
 * (markdown-lite), collapsed thought rows, and tool calls folded Cursor-style
 * (chat-tool-groups.js): consecutive calls of one kind become one summary
 * row ("Read 4 files", "Ran 3 commands", "Edited app.ts +12 −3") that opens
 * in place to compact rows and then to a call's full input and output, long
 * output cut behind "show more". Failed calls stay marked while collapsed;
 * Expand all / Collapse all (remembered in localStorage), a find box and
 * #tool-<id> / #event-<n> links open the rows they point at. A
 * shimmering in-progress marker ("Thinking" / "Planning next moves")
 * while the run is generating (detectLiveSessions / runIsLive — never a
 * tmux-alive linked pane alone). The etag flow means unchanged polls cost nothing
 * and the thread is patched incrementally (existing message/tool-group
 * nodes keep their element identity) when the recording actually grew;
 * the scroller sticks to the bottom unless the user scrolled up. The
 * page stays loaded: SSE data-update kicks a session poll via
 * window._refreshData, and window._stayLoaded suppresses location.reload.
 *
 * The raw terminal stays available as a collapsed <details> block below
 * the transcript: it keeps the original ~600ms /api/runs/snapshot polling
 * (SGR-classed html swapped into the viewport) so the tmux pane remains
 * inspectable and input echo verifiable. Lifecycle: the exited state stops
 * both pollers (final transcript + final screen stay visible under an
 * EXITED banner); a 404/kill flips the page to the gone state without a
 * reload.
 *
 * The composer is a Cursor-style input card: a status strip directly above
 * it carries the run state (pulsing dot + "Running" while generating,
 * "Idle" for a settled attached pane, "Agent exited" / gone reason) with
 * right-aligned Stop ^C (interrupt, generating only) and Kill run
 * controls rendered as real bordered pill buttons — the destructive Kill
 * run carries a rest-state red danger tint (text + border + fill) so the
 * interrupt/destroy distinction is visible before reading; the card
 * itself holds a context row (an @ button that inserts an @-mention into
 * the input + cwd chip), a borderless text input, and a bottom control
 * row of caret-marked disclosure chips: the agent chip (infinity glyph +
 * agent name + visible Cmd/Ctrl-I shortcut) and the model chip (fed live
 * from the linked session's reported model, hidden until known) both
 * open the run-details popover — agent/model/run-id/directory/recording
 * rows plus an honest note that agent & model are fixed at launch and
 * what Stop vs Kill run actually do — while the labeled "Send key ⌄"
 * chip opens the special-keys popover (the six allowed /api/runs/input
 * keys with kbd glyphs). The round arrow send button visibly stands down
 * (muted circle, faint arrow) while the input is empty (an empty submit
 * still sends a bare Enter — the way TUI permission prompts get
 * confirmed). Exited/gone hides the card and retires the stop/kill
 * controls, leaving the status strip as the run's epitaph.
 *
 * The composer is state-aware while the run is generating (in-composer run
 * feedback): the strip text becomes the run's LIVE activity, derived
 * client-side from the same polled unified session the transcript renders
 * (unresolved tool call → the humanized action, user/tool_result tail or a
 * recording that grew within the ~4s quiet window → "Generating" with an
 * animated ellipsis, quiet complete turn → plain "Running"); the send
 * button morphs to a stop control over an empty input while busy (click =
 * ^C, never a submit) and to a queue-labeled send over text; and a
 * non-empty submit while busy is HELD on the page as a visible follow-up
 * queue ("N in queue" above the strip — tracequest has NO server-side
 * queue, so the queue is honest client state: rows are editable
 * (click-to-edit), cancelable (×), force-sendable ("send now"), persisted
 * per-run in sessionStorage, guarded by beforeunload, and auto-delivered
 * IN ORDER via /api/runs/input only when the agent looks ready; a run
 * that ends first keeps undelivered rows under an honest note).
 */
import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { CHAT_SHELL_CSS, CHAT_PAGE_CSS } from "./chat-page-css.js";
import { ansiPaletteCss } from "../render/ansi-html.js";
import { RUN_UNLINKED_RUNNING_MS } from "../sessions/run-generating-status.js";
import { esc } from "../server/server-html-helpers.js";
import { fnSrc } from "../utils/fn-src.js";
import {
  computeGrade,
  prettyProject,
  shortModel,
  estimateCost,
  getModelRates,
  fmtTokens,
  fmtCost,
  formatDuration,
  fmtPct,
  fmtMcpName,
} from "../filter/filter-formats.js";
import { sumToolCounts, includesLower } from "../parse/parse-utils.js";
import {
  LAUNCHER_MODAL_CSS,
  LAUNCHER_MODAL_HTML,
  LAUNCHER_CLIENT_JS,
} from "./launch-page.js";
import { OVERLAY_FOCUS_SRC } from "./overlay-focus.js";
import { FORM_FIELD_GUARD_SRC } from "./is-form-field.js";
import {
  COMMAND_PALETTE_CSS,
  COMMAND_PALETTE_HTML,
  COMMAND_PALETTE_CLIENT_JS,
} from "./command-palette.js";
import {
  appTopHtml,
  APP_SHELL_JS,
  THEME_BOOT_SCRIPT,
  APP_TOP_CSS,
  IDENTITY_ROW_CSS,
  SOURCE_COLORS,
  sourceColor,
  SESSION_STAT_CHIPS_HTML_SRC,
  LIVE_NOW_SRC,
  RUN_IDENTITY_STATUS_SRC,
  USAGE_LIMITS_CLIENT_SRC,
  runIdentityStatus,
} from "./app-chrome.js";
import { applyThreadItems } from "./chat-thread-apply.js";
import {
  toolKind,
  inputField,
  patchSummary,
  toolTarget,
  toolVerb,
  diffCounts,
  toolRow,
  groupToolBlocks,
  baseName,
  groupSummary,
  groupDetail,
  textMatches,
  rowMatches,
  isOpen,
  parseDeepLink,
  deepLinkKeys,
  outputPreview,
  groupOpenState,
} from "./chat-tool-groups.js";
import {
  ANALYTICS_PANEL_CSS,
  ANALYTICS_PANEL_HTML,
  ANALYTICS_PANEL_JS,
  ANALYTICS_TOGGLE_HTML,
  analyticsPanelHtml,
} from "./run-analytics-panel.js";

const APPLY_THREAD_ITEMS_SRC = applyThreadItems.toString().replace(/^export /, "");
/** The activity slot before the first poll paints: never a blank column. */
const CHAT_LOADING_HTML = '<div class="chat-marker chat-loading"><span class="shimmer">Loading conversation</span></div>';
/** Find box + Expand all above the thread; hidden until the transcript has tool calls to fold. */
const CHAT_FIND_BAR_HTML = `<div class="chat-find-bar" id="chatFindBar" hidden>
    <div class="chat-find-inner">
      <input class="chat-find-input" id="chatFind" type="search" placeholder="Find in this conversation" aria-label="Find in this conversation" autocomplete="off" spellcheck="false">
      <span class="chat-find-count" id="chatFindCount" role="status" aria-live="polite"></span>
      <button class="chat-expand-btn" id="chatToggleAll" type="button" aria-pressed="false">Expand all</button>
    </div>
  </div>`;
// The tool-grouping helpers run in the page too, in dependency-free form.
const TOOL_GROUPS_SRC = [
  toolKind, inputField, patchSummary, toolTarget, toolVerb, diffCounts, toolRow, groupToolBlocks,
  baseName, groupSummary, groupDetail, textMatches, rowMatches, isOpen, parseDeepLink, deepLinkKeys,
  outputPreview, groupOpenState,
].map(fnSrc).join("\n");

/** Snapshot poll cadence in ms for the raw terminal block. */
export const RUN_POLL_MS = 600;

/** Unified-session poll cadence in ms for the chat transcript. */
export const SESSION_POLL_MS = 1000;

/**
 * Poll cadence in ms of a watched session (/run?session=) that is not
 * running. A change to its recording still polls at once: the data-update
 * SSE calls window._refreshData.
 */
export const IDLE_SESSION_POLL_MS = 5000;

/** Agent-rail poll cadence in ms (runs; sessions refresh every 3rd tick). */
export const RAIL_POLL_MS = 3000;

/* ------------------------------------------------------------------ */
/* App shell — the run/watch chat lives INSIDE tracequest: the SAME    */
/* app bar the dashboard renders (wordmark / sessions crumb / live     */
/* counter / "+ New run" launcher) and a persistent session rail       */
/* listing runs, live sessions, and recent sessions beside the chat    */
/* pane, so entering a run never leaves the app. ONE noun everywhere:  */
/* the records are sessions (crumb, rail head, rail foot, dashboard    */
/* heading alike). Shared by runPage and liveSessionPage.              */
/* ------------------------------------------------------------------ */

const APP_SHELL_CSS = `
${APP_TOP_CSS}
${IDENTITY_ROW_CSS}
${CHAT_SHELL_CSS}
${ANALYTICS_PANEL_CSS}
`;

/** The shared app bar (same builder the dashboard uses) — ONE noun: sessions. */
const APP_TOP_HTML = appTopHtml({ crumbHtml: '<span class="app-crumb">sessions</span>', nav: 'chat' });

/** The persistent session rail (client-rendered rows) — same noun as the dashboard. */
const AGENT_RAIL_HTML = `<aside class="agent-rail" aria-label="Sessions">
      <div class="rail-head">Sessions <span class="rail-count" id="railCount"></span><button type="button" class="rail-filter-toggle" id="railFilterToggle" aria-expanded="false" aria-controls="railFilters" aria-label="Filter sessions" title="Filter sessions"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6.5" cy="6.5" r="4.25" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M9.6 9.6 L13.2 13.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button></div>
      <div class="rail-filters" id="railFilters">
        <div class="filter-wrap rail-filter-wrap">
          <div class="filter-bar" id="filterBar">
            <input class="filter-input" id="filterInput" type="text" aria-label="Filter runs" placeholder="Filter — e.g. foo AND (tool:Read OR tool:Edit)" autocomplete="off" spellcheck="false">
          </div>
        </div>
        <div class="rail-filters-extra">
        <div class="runs-toolbar-actions rail-toolbar" id="runsToolbar">
          <div class="toolbar-pop" id="agePop">
            <button type="button" class="toolbar-btn" id="ageBtn" aria-haspopup="listbox" aria-expanded="false" aria-controls="ageMenu" aria-label="Time range">All time</button>
            <div class="toolbar-menu" id="ageMenu" role="listbox" hidden tabindex="-1">
              <button type="button" class="toolbar-option active" data-age="" role="option" aria-selected="true">All time</button>
              <button type="button" class="toolbar-option" data-age="&lt;1d" role="option" aria-selected="false">Past 24 hours</button>
              <button type="button" class="toolbar-option" data-age="&lt;7d" role="option" aria-selected="false">Past 7 days</button>
              <button type="button" class="toolbar-option" data-age="&lt;30d" role="option" aria-selected="false">Past 30 days</button>
            </div>
          </div>
          <div class="toolbar-pop" id="sourcePop">
            <button type="button" class="toolbar-btn" id="sourceBtn" aria-haspopup="listbox" aria-expanded="false" aria-controls="sourceMenu" aria-label="Source">Source</button>
            <div class="toolbar-menu" id="sourceMenu" role="listbox" hidden tabindex="-1"></div>
          </div>
          <button type="button" class="toolbar-btn" id="filtersToggle" aria-expanded="false" aria-controls="qfBar" aria-label="Filters">Filters</button>
          <div class="toolbar-pop" id="displayPop">
            <button type="button" class="toolbar-btn" id="displayToggle" aria-haspopup="true" aria-expanded="false" aria-controls="sortBar" aria-label="Display">Display</button>
            <div class="sort-bar toolbar-menu" id="sortBar" hidden tabindex="-1">
              <span class="sort-label">sort</span>
              <button type="button" class="sort-btn active" data-sort="recent" aria-pressed="true">recent</button>
              <button type="button" class="sort-btn" data-sort="duration" aria-pressed="false">duration</button>
              <button type="button" class="sort-btn" data-sort="cost" aria-pressed="false">cost</button>
              <button type="button" class="sort-btn" data-sort="tokens" aria-pressed="false">tokens</button>
              <button type="button" class="sort-btn" data-sort="errors" aria-pressed="false">errors</button>
              <button type="button" class="sort-btn" data-sort="files" aria-pressed="false">files</button>
              <button type="button" class="sort-btn" data-sort="commits" aria-pressed="false">commits</button>
              <button type="button" class="sort-btn" data-sort="chapters" aria-pressed="false">chapters</button>
              <button type="button" class="sort-btn" data-sort="grade" aria-pressed="false">grade</button>
            </div>
          </div>
        </div>
        <div class="dashboard rail-overview collapsed" id="railOverview">
          <div class="dashboard-header">
            <span class="dashboard-title">Overview</span>
            <span class="dashboard-scope" id="railOverviewScope"></span>
          </div>
          <div class="dashboard-stats" id="railOverviewStats"></div>
        </div>
        <div class="qf-bar" id="qfBar" hidden></div>
        </div>
      </div>
      <nav class="rail-list" id="railList"><div class="rail-empty">loading&hellip;</div></nav>
      <a class="rail-all" href="/sessions">All sessions &rarr;</a>
    </aside>`;

const COMPUTE_GRADE_SRC = computeGrade.toString();
const PRETTY_PROJECT_SRC = prettyProject.toString();
const SUM_TOOL_COUNTS_SRC = sumToolCounts.toString().replace(/^export /, "");
const SHORT_MODEL_SRC = shortModel.toString().replace(/^export /, "");
const INCLUDES_LOWER_SRC = includesLower.toString().replace(/^export /, "");
const GET_MODEL_RATES_SRC = getModelRates.toString();
const ESTIMATE_COST_SRC = estimateCost.toString();
const FMT_TOKENS_SRC = fmtTokens.toString().replace(/^export /, "");
const FMT_COST_SRC = fmtCost.toString().replace(/^export /, "");
const FORMAT_DURATION_SRC = formatDuration.toString().replace(/^export /, "");
const FMT_PCT_SRC = fmtPct.toString().replace(/^export /, "");
const FMT_MCP_NAME_SRC = fmtMcpName.toString().replace(/^export /, "");

/**
 * The shell client script: polls /api/runs (~3s) and /api/sessions
 * (every 3rd tick) to keep the session rail, the live counter, and the
 * chat header's identity chips truthful — session id, model, grade badge,
 * and the list card's stat chips (via the shared sessionStatChipsHtml
 * builder) plus the relative started time; then wires the same launcher
 * modal the dashboard uses. `current` identifies the open chat
 * ({ type: "run"|"session", id }) so its rail row is highlighted;
 * `defaultCwd` prefills the launcher.
 */
function shellClientScript({ current, defaultCwd }) {
  return `
(function () {
  ${FORM_FIELD_GUARD_SRC}
  ${OVERLAY_FOCUS_SRC}
  var RAIL_CURRENT = ${JSON.stringify(current)};
  var RAIL_POLL_MS = ${RAIL_POLL_MS};
  var SOURCE_COLORS = ${JSON.stringify(SOURCE_COLORS)};
${SUM_TOOL_COUNTS_SRC}
${COMPUTE_GRADE_SRC}
${PRETTY_PROJECT_SRC}
${SHORT_MODEL_SRC}
${INCLUDES_LOWER_SRC}
${GET_MODEL_RATES_SRC}
${ESTIMATE_COST_SRC}
${FMT_TOKENS_SRC}
${FMT_COST_SRC}
${FORMAT_DURATION_SRC}
${FMT_PCT_SRC}
${FMT_MCP_NAME_SRC}
  function fmtDuration(ms) { return formatDuration(ms, { subSecondLabel: "" }); }
${SESSION_STAT_CHIPS_HTML_SRC}
  function railEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function shortAgo(ts) {
    var ms = Date.now() - ts;
    if (!isFinite(ms) || ms < 0) ms = 0;
    var m = Math.floor(ms / 60000);
    if (m < 1) return "now";
    if (m < 60) return m + "m";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }
  var railList = document.getElementById("railList");
  var railCount = document.getElementById("railCount");
  var appLive = document.getElementById("appLive");
${USAGE_LIMITS_CLIENT_SRC}
  startUsageLimitsPolling(60000);
  ${APP_SHELL_JS}
  var gradeBadge = document.getElementById("runGrade");
  var headIdEl = document.getElementById("chatSessionId");
  var headModelEl = document.getElementById("chatModel");
  var headStatsEl = document.getElementById("chatStats");
  var startedEl = document.querySelector(".run-started[data-started]");
  var _runs = [];
  var _sessions = [];
  var _liveSessions = [];
${LIVE_NOW_SRC}
${RUN_IDENTITY_STATUS_SRC}
  function currentRunIdentityStatus() {
    if (!RAIL_CURRENT || RAIL_CURRENT.type !== "run") return null;
    for (var i = 0; i < _runs.length; i++) {
      if (_runs[i].id === RAIL_CURRENT.id) return runIdentityStatus(_runs[i]);
    }
    return null;
  }
  var _stats = {};
  var _serverTotal = 0;
  var _lastRailHtml = null;
  var _railExpr = "";
  var _railSort = "recent";
  var _filteredPaths = {};
  var _filteredIds = {};
  var qfState = { grade: null, model: null, source: null, errorsOnly: false, age: null };
  var filtersOpen = false;
  var railFiltersOpen = false;
  var toolsOpen = false;
  var AGE_OPTIONS = { "": "All time", "<1d": "Past 24 hours", "<7d": "Past 7 days", "<30d": "Past 30 days" };
  var TOOL_COLORS = {
    Bash: "var(--hue-bash)", Edit: "var(--hue-edit)", Write: "var(--hue-edit)", Read: "var(--hue-read)",
    Agent: "var(--hue-agent)", Grep: "var(--hue-grep)", Glob: "var(--hue-grep)", Skill: "var(--hue-agent)",
    WebFetch: "var(--hue-web)", WebSearch: "var(--hue-web)", ToolSearch: "var(--hue-grep)",
    SemanticSearch: "var(--hue-grep)", Delete: "var(--bad)", Await: "var(--hue-other)",
    Ask: "var(--hue-web)", CallMcpTool: "var(--hue-web)"
  };
  var filterInput = document.getElementById("filterInput");
  var qfBarEl = document.getElementById("qfBar");
  var _filterTimer = null;

  function agentBit(name, project) {
    var color = SOURCE_COLORS[name] || "var(--hue-other)";
    var html = '<span class="rail-agent" style="--hue:' + color + '">' + railEsc(name) + "</span>";
    if (project) html += " &middot; " + railEsc(prettyProject(project));
    return html;
  }
  function gradeHtml(s) {
    var g = computeGrade(s);
    if (!g.cls) return "";
    return '<span class="session-grade-badge rail-grade ' + g.cls + '">' + g.letter + "</span>";
  }
  function ageLabel(value) {
    return AGE_OPTIONS[value || ""] || "All time";
  }
  function qfTermFromExpr(expr, key) {
    var m = String(expr || "").match(new RegExp("\\\\b" + key + ':(?:"([^"]*)"|(\\\\S+))', "i"));
    return m ? (m[1] || m[2] || "") : null;
  }
  function syncQfStateFromExpr() {
    var expr = (filterInput && filterInput.value) || _railExpr || "";
    qfState.grade = qfTermFromExpr(expr, "grade");
    qfState.source = qfTermFromExpr(expr, "source");
    qfState.model = qfTermFromExpr(expr, "model");
    qfState.errorsOnly = qfTermFromExpr(expr, "errors") === ">0";
    qfState.age = qfTermFromExpr(expr, "age");
  }
  function qfHasAny() {
    return !!(qfState.grade || qfState.model || qfState.source || qfState.errorsOnly || qfState.age);
  }
  function setRailFiltersOpen(open) {
    railFiltersOpen = !!open;
    var rail = document.querySelector(".agent-rail");
    if (rail) rail.classList.toggle("filters-open", railFiltersOpen);
    var btn = document.getElementById("railFilterToggle");
    if (btn) {
      btn.setAttribute("aria-expanded", railFiltersOpen ? "true" : "false");
      btn.classList.toggle("has-value", !!(qfHasAny() || _railExpr));
    }
  }
  function setQfFilterTerm(key, value) {
    if (!filterInput) return;
    var current = (filterInput.value || "").trim();
    var re = new RegExp("\\\\b" + key + ':(?:"[^"]*"|\\\\S+)', "gi");
    current = current.replace(re, "").replace(/\\s+/g, " ").trim();
    if (value) {
      var needsQuote = value.indexOf(" ") >= 0 || value.indexOf(":") >= 0;
      current = current ? current + " " + key + ":" + (needsQuote ? '"' + value + '"' : value) : key + ":" + (needsQuote ? '"' + value + '"' : value);
    }
    filterInput.value = current;
    _railExpr = current;
  }
  function sessionsQueryUrl() {
    var q = "/api/sessions?pageSize=50";
    if (_railExpr) q += "&expr=" + encodeURIComponent(_railExpr);
    if (_railSort && _railSort !== "recent") q += "&sort=" + encodeURIComponent(_railSort);
    return q;
  }
  function persistRailFilterUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (_railExpr) params.set("expr", _railExpr);
      else params.delete("expr");
      if (_railSort && _railSort !== "recent") params.set("sort", _railSort);
      else params.delete("sort");
      var qs = params.toString();
      history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
    } catch (e) { /* ignore */ }
  }
  function rebuildFilteredIndex() {
    _filteredPaths = {};
    _filteredIds = {};
    for (var i = 0; i < _sessions.length; i++) {
      if (_sessions[i].path) _filteredPaths[_sessions[i].path] = true;
      if (_sessions[i].id) _filteredIds[_sessions[i].id] = true;
    }
  }
  function isCurrentRow(kind, id) {
    return RAIL_CURRENT && RAIL_CURRENT.type === kind && RAIL_CURRENT.id === id;
  }
  function matchesRailFilter(item, kind) {
    if (!_railExpr && !qfHasAny()) return true;
    if (kind === "run" && isCurrentRow("run", item.id)) return true;
    if (kind === "session" && isCurrentRow("session", item.id)) return true;
    if (kind === "live" && isCurrentRow("session", item.id)) return true;
    if (qfState.source) {
      var src = kind === "run" ? item.agent : item.source;
      if (src && src !== qfState.source) return false;
    }
    var path = item.sessionPath || item.path;
    if (path && _filteredPaths[path]) return true;
    if (item.id && _filteredIds[item.id]) return true;
    if (kind === "session") return true;
    if (!_railExpr && qfState.source && !qfState.grade && !qfState.model && !qfState.errorsOnly && !qfState.age) {
      return true;
    }
    return false;
  }
  function closeToolbarMenus(except) {
    closeToolbarMenuOverlays(except);
  }
  function syncToolbarLabels() {
    var ageBtn = document.getElementById("ageBtn");
    if (ageBtn) {
      ageBtn.textContent = ageLabel(qfState.age);
      ageBtn.classList.toggle("has-value", !!qfState.age);
      ageBtn.classList.toggle("active", !!qfState.age);
    }
    document.querySelectorAll("#ageMenu .toolbar-option").forEach(function (opt) {
      var on = (opt.getAttribute("data-age") || "") === (qfState.age || "");
      opt.classList.toggle("active", on);
      opt.setAttribute("aria-selected", on ? "true" : "false");
    });
    var sourceBtn = document.getElementById("sourceBtn");
    if (sourceBtn) {
      sourceBtn.textContent = qfState.source || "Source";
      sourceBtn.classList.toggle("has-value", !!qfState.source);
      sourceBtn.classList.toggle("active", !!qfState.source);
    }
    var filtersToggle = document.getElementById("filtersToggle");
    if (filtersToggle) {
      filtersToggle.classList.toggle("active", !!(filtersOpen || qfHasAny()));
      filtersToggle.setAttribute("aria-expanded", filtersOpen ? "true" : "false");
    }
    var displayToggle = document.getElementById("displayToggle");
    if (displayToggle) {
      displayToggle.classList.toggle("has-value", _railSort && _railSort !== "recent");
      displayToggle.classList.toggle("active", _railSort && _railSort !== "recent");
    }
    document.querySelectorAll("#sortBar .sort-btn").forEach(function (b) {
      var on = b.getAttribute("data-sort") === _railSort;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }
  function renderSourceMenu() {
    var menu = document.getElementById("sourceMenu");
    if (!menu) return;
    var sourceSet = _stats.sourceCounts || {};
    var entries = [];
    for (var k in sourceSet) {
      if (sourceSet.hasOwnProperty(k)) entries.push([k, sourceSet[k]]);
    }
    entries.sort(function (a, b) { return b[1] - a[1]; });
    var html = '<button type="button" class="toolbar-option' + (!qfState.source ? " active" : "") + '" data-source="" role="option" aria-selected="' + (!qfState.source ? "true" : "false") + '">All sources</button>';
    for (var i = 0; i < entries.length; i++) {
      var sn = entries[i][0];
      var sc = entries[i][1];
      var active = qfState.source === sn;
      html += '<button type="button" class="toolbar-option' + (active ? " active" : "") + '" data-source="' + railEsc(sn) + '" role="option" aria-selected="' + (active ? "true" : "false") + '">'
        + railEsc(sn) + '<span class="toolbar-option-count">' + sc + "</span></button>";
    }
    menu.innerHTML = html;
  }
  function appliedChipHtml(key, op, value, removeKey) {
    return '<span class="chip" data-chip="' + removeKey + '">'
      + '<span class="chip-key">' + railEsc(key) + "</span>"
      + '<span class="chip-op">' + railEsc(op) + "</span>"
      + '<span class="chip-value">' + railEsc(value) + "</span>"
      + '<button type="button" class="chip-remove" data-remove="' + removeKey + '" aria-label="Remove ' + railEsc(key) + ' filter">&times;</button>'
      + "</span>";
  }
  function appliedChipsHtml() {
    var chips = "";
    if (qfState.age) chips += appliedChipHtml("Age", "is", ageLabel(qfState.age), "age");
    if (qfState.source) chips += appliedChipHtml("Source", "is", qfState.source, "source");
    if (qfState.grade) chips += appliedChipHtml("Grade", "is", qfState.grade, "grade");
    if (qfState.model) chips += appliedChipHtml("Model", "is", qfState.model, "model");
    if (qfState.errorsOnly) chips += appliedChipHtml("Errors", ">", "0", "errors");
    if (!chips) return "";
    return '<div class="applied-chips" id="appliedChips">' + chips
      + '<button type="button" class="qf-clear qf-visible" id="qfClear">clear filters</button>'
      + "</div>";
  }
  function buildQfBar() {
    if (!qfBarEl) return;
    var modelSet = _stats.modelCounts || {};
    var sourceSet = _stats.sourceCounts || {};
    var gradeDist = _stats.gradeDist || { A: 0, B: 0, C: 0, D: 0, F: 0 };
    var errCount = _stats.errorSessionCount || 0;
    var html = appliedChipsHtml();
    html += '<div class="qf-pickers" id="qfPickers"' + (filtersOpen ? "" : " hidden") + ">";
    html += '<div class="qf-row">';
    html += '<span class="qf-section">';
    html += '<span class="qf-section-label">grade</span>';
    var grades = ["A", "B", "C", "D", "F"];
    for (var gi = 0; gi < grades.length; gi++) {
      var gl = grades[gi].toLowerCase();
      var gc = gradeDist[grades[gi]] || 0;
      var disabledCls = gc === 0 ? " qf-disabled" : "";
      html += '<button type="button" class="qf-grade qf-g-' + gl + disabledCls + '" data-grade="' + grades[gi] + '" aria-label="Filter grade ' + grades[gi] + '" aria-pressed="false" title="' + gc + " run" + (gc !== 1 ? "s" : "") + " with grade " + grades[gi] + '"' + (gc === 0 ? " disabled" : "") + ">" + grades[gi] + "</button>";
    }
    html += "</span>";
    html += '<button type="button" class="qf-error-toggle" id="qfErrorToggle" aria-pressed="false" title="Show only runs with errors">' + errCount + " with errors</button>";
    html += "</div>";
    var sourceEntries = [];
    for (var sk in sourceSet) {
      if (sourceSet.hasOwnProperty(sk)) sourceEntries.push([sk, sourceSet[sk]]);
    }
    sourceEntries.sort(function (a, b) { return b[1] - a[1]; });
    if (sourceEntries.length) {
      html += '<div class="qf-row"><span class="qf-section"><span class="qf-section-label">source</span>';
      for (var si = 0; si < sourceEntries.length; si++) {
        var sn = sourceEntries[si][0];
        var sc = sourceEntries[si][1];
        html += '<button type="button" class="qf-chip qf-chip--source" data-source="' + railEsc(sn) + '" aria-pressed="false" style="--hue:' + (SOURCE_COLORS[sn] || "var(--hue-other)") + '">' + railEsc(sn) + ' <span class="qf-chip-count">' + sc + "</span></button>";
      }
      html += "</span></div>";
    }
    var modelEntries = [];
    for (var mk in modelSet) {
      if (modelSet.hasOwnProperty(mk)) modelEntries.push([mk, modelSet[mk]]);
    }
    modelEntries.sort(function (a, b) { return b[1] - a[1]; });
    if (modelEntries.length) {
      html += '<div class="qf-row"><span class="qf-section"><span class="qf-section-label">model</span>';
      var maxModels = Math.min(modelEntries.length, 6);
      for (var mi = 0; mi < maxModels; mi++) {
        var mn = modelEntries[mi][0];
        var mc = modelEntries[mi][1];
        html += '<button type="button" class="qf-chip" data-model="' + railEsc(mn) + '" aria-pressed="false">' + railEsc(mn) + ' <span class="qf-chip-count">' + mc + "</span></button>";
      }
      html += "</span></div>";
    }
    html += "</div>";
    qfBarEl.innerHTML = html;
    qfBarEl.hidden = !filtersOpen && !qfHasAny();
    renderSourceMenu();
    syncToolbarLabels();
    attachQfListeners();
  }
  function attachQfListeners() {
    if (!qfBarEl) return;
    function setQfPressed(btn, pressed) {
      if (btn) btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
    qfBarEl.querySelectorAll(".qf-grade").forEach(function (btn) {
      var active = !!(qfState.grade && btn.dataset.grade === qfState.grade);
      btn.classList.toggle("qf-active", active);
      setQfPressed(btn, active);
      btn.addEventListener("click", function () {
        if (btn.classList.contains("qf-disabled")) return;
        qfState.grade = qfState.grade === btn.dataset.grade ? null : btn.dataset.grade;
        setQfFilterTerm("grade", qfState.grade);
        applyRailFilters();
      });
    });
    qfBarEl.querySelectorAll(".qf-chip[data-source]").forEach(function (btn) {
      var active = !!(qfState.source && btn.dataset.source === qfState.source);
      btn.classList.toggle("qf-active", active);
      setQfPressed(btn, active);
      btn.addEventListener("click", function () {
        qfState.source = qfState.source === btn.dataset.source ? null : btn.dataset.source;
        setQfFilterTerm("source", qfState.source);
        applyRailFilters();
      });
    });
    qfBarEl.querySelectorAll(".qf-chip[data-model]").forEach(function (btn) {
      var active = !!(qfState.model && btn.dataset.model === qfState.model);
      btn.classList.toggle("qf-active", active);
      setQfPressed(btn, active);
      btn.addEventListener("click", function () {
        qfState.model = qfState.model === btn.dataset.model ? null : btn.dataset.model;
        setQfFilterTerm("model", qfState.model);
        applyRailFilters();
      });
    });
    var errorToggle = document.getElementById("qfErrorToggle");
    if (errorToggle) {
      errorToggle.classList.toggle("qf-active", !!qfState.errorsOnly);
      setQfPressed(errorToggle, !!qfState.errorsOnly);
      errorToggle.addEventListener("click", function () {
        qfState.errorsOnly = !qfState.errorsOnly;
        setQfFilterTerm("errors", qfState.errorsOnly ? ">0" : null);
        applyRailFilters();
      });
    }
    var clearEl = document.getElementById("qfClear");
    if (clearEl) {
      clearEl.addEventListener("click", function () {
        qfState.grade = null;
        qfState.model = null;
        qfState.source = null;
        qfState.errorsOnly = false;
        qfState.age = null;
        if (filterInput) {
          var cur = (filterInput.value || "").trim();
          cur = cur.replace(/\\b(grade|source|model|errors|age):(?:"[^"]*"|\\S+)/gi, "").replace(/\\s+/g, " ").trim();
          filterInput.value = cur;
          _railExpr = cur;
        }
        applyRailFilters();
      });
    }
    qfBarEl.querySelectorAll(".chip-remove").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var key = btn.getAttribute("data-remove");
        if (key === "age") qfState.age = null;
        else if (key === "source") qfState.source = null;
        else if (key === "grade") qfState.grade = null;
        else if (key === "model") qfState.model = null;
        else if (key === "errors") qfState.errorsOnly = false;
        setQfFilterTerm(key === "errors" ? "errors" : key, key === "errors" ? null : qfState[key]);
        applyRailFilters();
      });
    });
  }
  function renderOverview(liveCount) {
    var el = document.getElementById("railOverviewStats");
    var scope = document.getElementById("railOverviewScope");
    var box = document.getElementById("railOverview");
    if (!el || !box) return;
    var totalSessions = _stats.totalSessions || _serverTotal || 0;
    if (scope) {
      scope.textContent = totalSessions
        ? totalSessions + " run" + (totalSessions !== 1 ? "s" : "") + (_railExpr ? " (filtered)" : "")
        : "";
    }
    if (!totalSessions && !liveCount) {
      el.innerHTML = "";
      return;
    }
    var totalInputTok = _stats.totalInputTokens || 0;
    var totalOutputTok = _stats.totalOutputTokens || 0;
    var totalCacheRead = _stats.totalCacheReadTokens || 0;
    var cacheHitPct = (totalInputTok + totalCacheRead) > 0 ? ((totalCacheRead / (totalInputTok + totalCacheRead)) * 100) : 0;
    function dashStat(val, label) {
      return '<span class="dashboard-stat"><span class="dashboard-stat-val">' + val + '</span><span class="dashboard-stat-label">' + label + "</span></span>";
    }
    var html = "";
    if (liveCount) html += dashStat('<span class="dash-live-n" style="color:var(--ok)">' + liveCount + "</span>", "running");
    html += dashStat(totalSessions || "0", "runs");
    html += dashStat(fmtCost(_stats.totalCost || 0, { prefix: "$", zeroLabel: "$0" }), "cost");
    html += dashStat(fmtTokens(totalInputTok + totalOutputTok + totalCacheRead) || "--", "tokens");
    html += dashStat(fmtPct(cacheHitPct, { hideZero: true }), "cache");
    var durMs = _stats.totalDurationMs || 0;
    var durLabel = "--";
    if (durMs > 0) {
      var durH = Math.round(durMs / 3600000);
      durLabel = durH >= 48 ? Math.round(durH / 24) + "d" : (fmtDuration(durMs) || "--");
    }
    html += dashStat(durLabel, "duration");
    html += dashStat(_stats.totalErrors || 0, "errors");
    html += dashStat(_stats.totalCommits || 0, "commits");
    html += dashStat(_stats.totalFiles || 0, "files");
    html += dashStat(_stats.totalChapters || 0, "chapters");
    el.innerHTML = html;
    var toolAgg = _stats.toolAgg || {};
    var toolEntries = [];
    for (var tk in toolAgg) {
      if (toolAgg.hasOwnProperty(tk)) toolEntries.push([tk, toolAgg[tk]]);
    }
    toolEntries.sort(function (a, b) { return b[1] - a[1]; });
    var existingToggle = box.querySelector(".dashboard-toggle");
    var existingTools = box.querySelector(".dashboard-tools");
    if (existingToggle) existingToggle.remove();
    if (existingTools) existingTools.remove();
    if (toolEntries.length) {
      var toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "dashboard-toggle";
      toggle.id = "dashToggle";
      toggle.textContent = toolsOpen ? "hide tools" : "tools";
      toggle.setAttribute("aria-expanded", toolsOpen ? "true" : "false");
      toggle.addEventListener("click", function () {
        toolsOpen = !toolsOpen;
        box.classList.toggle("collapsed", !toolsOpen);
        toggle.textContent = toolsOpen ? "hide tools" : "tools";
        toggle.setAttribute("aria-expanded", toolsOpen ? "true" : "false");
      });
      var tools = document.createElement("div");
      tools.className = "dashboard-tools";
      var tHtml = '<div class="dashboard-tools-title">most-used tools (runs using)</div><div class="dashboard-tools-list">';
      var top = toolEntries.slice(0, 8);
      for (var ti = 0; ti < top.length; ti++) {
        var tName = top[ti][0];
        var tCount = top[ti][1];
        var tColor = TOOL_COLORS[tName] || (String(tName).indexOf("mcp__") === 0 ? "var(--hue-web)" : "var(--hue-other)");
        tHtml += '<span class="dashboard-tool-chip" style="color:' + tColor + '">' + railEsc(fmtMcpName(tName)) + ' <span class="dashboard-tool-count">' + tCount + "</span></span>";
      }
      tHtml += "</div>";
      tools.innerHTML = tHtml;
      box.appendChild(toggle);
      box.appendChild(tools);
    }
    box.classList.toggle("collapsed", !toolsOpen);
  }
  function applyRailFilters() {
    if (filterInput) _railExpr = (filterInput.value || "").trim();
    syncQfStateFromExpr();
    persistRailFilterUrl();
    syncToolbarLabels();
    setRailFiltersOpen(railFiltersOpen);
    railPoll(true);
  }
  function railRowHtml(opts) {
    return '<a class="rail-row"' + (opts.current ? ' aria-current="page"' : "")
      + ' href="' + railEsc(opts.href) + '" title="' + railEsc(opts.title) + '">'
      + '<span class="rail-glyph" data-status="' + opts.status + '">' + (opts.status === "running" ? "" : "&#10003;") + "</span>"
      + '<span class="rail-main"><span class="rail-title">' + railEsc(opts.title) + "</span>"
      + '<span class="rail-sub">' + opts.subHtml + "</span></span>"
      + '<span class="rail-side">' + (opts.time ? '<span class="rail-time">' + opts.time + "</span>" : "")
      + (opts.gradeHtml || "") + "</span></a>";
  }

  function renderRail() {
    var bySessionPath = {};
    for (var i = 0; i < _runs.length; i++) {
      if (_runs[i].sessionPath) bySessionPath[_runs[i].sessionPath] = _runs[i];
    }
    var indexedByPath = {};
    for (var s = 0; s < _sessions.length; s++) indexedByPath[_sessions[s].path] = _sessions[s];
    var rows = [];
    var runs = _runs.slice().sort(function (a, b) {
      if (a.status !== b.status) return a.status === "running" ? -1 : 1;
      return Date.parse(b.startedAt) - Date.parse(a.startedAt);
    });
    rebuildFilteredIndex();
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      if (!matchesRailFilter(run, "run")) continue;
      var indexed = run.sessionPath ? indexedByPath[run.sessionPath] : null;
      var project = String(run.cwd || "").split("/").filter(Boolean).pop() || "";
      var generating = runIsLive(run);
      var sub = generating
        ? railEsc(run.activity || (run.sessionPath ? "Working\\u2026" : "Waiting for the agent session\\u2026"))
        : agentBit(run.agent, project);
      rows.push(railRowHtml({
        current: RAIL_CURRENT.type === "run" && run.id === RAIL_CURRENT.id,
        href: "/run?id=" + encodeURIComponent(run.id),
        title: run.prompt || run.agent + " run " + run.id,
        status: generating ? "running" : (run.status === "exited" || run.status === "gone" ? "done" : "idle"),
        subHtml: sub,
        time: isNaN(Date.parse(run.startedAt)) ? "" : shortAgo(Date.parse(run.startedAt)),
        gradeHtml: indexed ? gradeHtml(indexed) : "",
      }));
    }
    var livePaths = {};
    for (var l = 0; l < _liveSessions.length; l++) {
      var ls = _liveSessions[l];
      // Same detectLiveSessions bit as dashboard liveNow(): membership of
      // _liveSessions is not live; only s.live === true is RUNNING.
      if (ls.live !== true) continue;
      if (bySessionPath[ls.path]) continue;
      if (!matchesRailFilter(ls, "live")) continue;
      livePaths[ls.path] = true;
      rows.push(railRowHtml({
        current: RAIL_CURRENT.type === "session" && ls.id === RAIL_CURRENT.id,
        href: "/run?session=" + encodeURIComponent(ls.id),
        title: ls.prompt || ls.source + " " + ls.id,
        status: ls.live === true ? "running" : "idle",
        // Same live treatment a running run row gets: the server-derived
        // activity line leads; origin stays an honest suffix, not a caste.
        subHtml: (ls.activity ? railEsc(ls.activity) : agentBit(ls.source, ls.project)) + " &middot; external",
        time: ls.mtime ? shortAgo(ls.mtime) : "",
        gradeHtml: gradeHtml(ls),
      }));
    }
    for (var k = 0; k < _sessions.length && rows.length < 30; k++) {
      var sess = _sessions[k];
      if (bySessionPath[sess.path] || livePaths[sess.path]) continue;
      if (!matchesRailFilter(sess, "session")) continue;
      rows.push(railRowHtml({
        current: RAIL_CURRENT.type === "session" && sess.id === RAIL_CURRENT.id,
        href: "/run?session=" + encodeURIComponent(sess.id),
        title: sess.prompt || sess.id,
        status: "done",
        subHtml: agentBit(sess.source, sess.project),
        time: sess.mtime ? shortAgo(sess.mtime) : "",
        gradeHtml: gradeHtml(sess),
      }));
    }
    var html = rows.join("") || '<div class="rail-empty">' + (_railExpr ? "no matching runs or sessions" : "no runs or sessions yet") + "</div>";
    if (html !== _lastRailHtml) {
      _lastRailHtml = html;
      railList.innerHTML = html;
    }
    // #appLive / railCount / overview running stat are the origin-agnostic
    // liveNow() sum (runIsLive + s.live === true), never tmux status
    // running, a rail-filter, or exited-run occupancy.
    var liveN = liveNow();
    railCount.textContent = liveN ? liveN + " running" : "";
    if (appLive) {
      appLive.hidden = !liveN;
      appLive.textContent = liveN + " running";
    }
    renderOverview(liveN);
    updateHeaderIdentity();
  }

  /**
   * Chat header identity: fill the SAME chips the dashboard list card shows
   * for this record — #runStatus from runIsLive / poll status (never tmux
   * running alone; session and snapshot polls share that generating word),
   * session id, model, grade badge, stat chips — from the exact same polled
   * objects the list renders (indexed session first, the live-detected
   * recording as the pre-index fallback), so entering the chat is the list
   * row expanding, never a re-badged second object.
   */
  function updateHeaderIdentity() {
    if (startedEl) {
      var t = Date.parse(startedEl.getAttribute("data-started"));
      if (!isNaN(t)) {
        startedEl.textContent = "started " + shortAgo(t) + (shortAgo(t) === "now" ? "" : " ago");
        startedEl.title = startedEl.getAttribute("data-started");
      }
    }
    var runStatusEl = document.getElementById("runStatus");
    if (RAIL_CURRENT.type === "run" && runStatusEl) {
      var cur = runStatusEl.getAttribute("data-status");
      if (cur !== "exited" && cur !== "gone") {
        var word = currentRunIdentityStatus();
        if (word) {
          runStatusEl.textContent = word;
          runStatusEl.setAttribute("data-status", word);
        }
      }
    }
    var indexed = null;
    var live = null;
    if (RAIL_CURRENT.type === "run") {
      for (var i = 0; i < _runs.length; i++) {
        if (_runs[i].id === RAIL_CURRENT.id && _runs[i].sessionPath) {
          for (var s = 0; s < _sessions.length; s++) {
            if (_sessions[s].path === _runs[i].sessionPath) { indexed = _sessions[s]; break; }
          }
          for (var l = 0; l < _liveSessions.length; l++) {
            if (_liveSessions[l].path === _runs[i].sessionPath) { live = _liveSessions[l]; break; }
          }
        }
      }
    } else {
      for (var k = 0; k < _sessions.length; k++) {
        if (_sessions[k].id === RAIL_CURRENT.id) { indexed = _sessions[k]; break; }
      }
      for (var m = 0; m < _liveSessions.length; m++) {
        if (_liveSessions[m].id === RAIL_CURRENT.id) { live = _liveSessions[m]; break; }
      }
    }
    var identity = indexed || live;
    if (!identity) return;
    if (headIdEl && identity.id) headIdEl.textContent = identity.id;
    var model = shortModel((indexed && indexed.model) || (live && live.model) || "");
    if (headModelEl && model) {
      headModelEl.textContent = model;
      headModelEl.hidden = false;
    }
    if (headStatsEl) {
      var chips = sessionStatChipsHtml(identity);
      if (chips) {
        headStatsEl.innerHTML = chips;
        headStatsEl.hidden = false;
      }
    }
    // Grade exactly as the list grades this record: indexed rows always,
    // live-detected sessions on the session watch page (the external row
    // computes its grade from the live object the same way).
    var graded = indexed || (RAIL_CURRENT.type === "session" ? live : null);
    if (!gradeBadge || !graded) return;
    var g = computeGrade(graded);
    if (!g.cls) return;
    gradeBadge.className = "session-grade-badge run-grade " + g.cls;
    gradeBadge.textContent = g.letter;
    gradeBadge.title = "session grade " + g.letter + " (" + g.score + ")";
    gradeBadge.hidden = false;
  }

  var _tick = 0;
  if (typeof window !== "undefined") window._currentRunIdentityStatus = currentRunIdentityStatus;
  async function railPoll(forceSessions) {
    if (document.hidden && !forceSessions) return;
    try {
      var jobs = [fetch("/api/runs").then(function (r) { return r.ok ? r.json() : null; })];
      if (forceSessions || _tick % 3 === 0) {
        jobs.push(fetch(sessionsQueryUrl()).then(function (r) { return r.ok ? r.json() : null; }));
      }
      var out = await Promise.all(jobs);
      if (out[0] && Array.isArray(out[0].runs)) _runs = out[0].runs;
      if (out[1]) {
        _sessions = out[1].sessions || [];
        _liveSessions = out[1].liveSessions || [];
        _stats = out[1].stats || {};
        _serverTotal = out[1].total || 0;
        buildQfBar();
      }
      renderRail();
    } catch (e) { /* transient — next tick retries */ }
    _tick++;
  }
  window._refreshRail = railPoll;
  (function restoreRailFiltersFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      var sort = params.get("sort");
      if (sort) _railSort = sort;
      var expr = params.get("expr");
      if (expr && filterInput) {
        filterInput.value = expr;
        _railExpr = expr;
      }
      var grade = params.get("grade");
      if (grade) { qfState.grade = grade; setQfFilterTerm("grade", grade); }
      if (params.get("errorsOnly") === "1") { qfState.errorsOnly = true; setQfFilterTerm("errors", ">0"); }
      var source = params.get("source");
      if (source) { qfState.source = source; setQfFilterTerm("source", source); }
      var model = params.get("model");
      if (model) { qfState.model = model; setQfFilterTerm("model", model); }
      var age = params.get("age");
      if (age) { qfState.age = age; setQfFilterTerm("age", age); }
      syncQfStateFromExpr();
      syncToolbarLabels();
      if (_railExpr || qfHasAny() || (_railSort && _railSort !== "recent")) setRailFiltersOpen(true);
    } catch (e) { /* ignore */ }
  })();
  (function bindRailFilters() {
    var ageBtn = document.getElementById("ageBtn");
    var ageMenu = document.getElementById("ageMenu");
    var sourceBtn = document.getElementById("sourceBtn");
    var sourceMenu = document.getElementById("sourceMenu");
    var filtersToggle = document.getElementById("filtersToggle");
    var displayToggle = document.getElementById("displayToggle");
    var sortBar = document.getElementById("sortBar");
    var railFilterToggle = document.getElementById("railFilterToggle");
    if (railFilterToggle) {
      railFilterToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        setRailFiltersOpen(!railFiltersOpen);
        if (railFiltersOpen && filterInput) filterInput.focus();
      });
    }
    if (ageBtn && ageMenu) {
      ageBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = ageMenu.hidden;
        if (open) {
          closeToolbarMenus("ageMenu");
          openToolbarMenuOverlay(ageMenu);
        } else {
          closeToolbarMenus();
        }
      });
      ageMenu.addEventListener("click", function (e) {
        var opt = e.target.closest(".toolbar-option");
        if (!opt) return;
        qfState.age = opt.getAttribute("data-age") || null;
        setQfFilterTerm("age", qfState.age);
        closeToolbarMenus();
        applyRailFilters();
      });
    }
    if (sourceBtn && sourceMenu) {
      sourceBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = sourceMenu.hidden;
        if (open) {
          closeToolbarMenus("sourceMenu");
          openToolbarMenuOverlay(sourceMenu);
        } else {
          closeToolbarMenus();
        }
      });
      sourceMenu.addEventListener("click", function (e) {
        var opt = e.target.closest(".toolbar-option");
        if (!opt) return;
        qfState.source = opt.getAttribute("data-source") || null;
        setQfFilterTerm("source", qfState.source);
        closeToolbarMenus();
        applyRailFilters();
      });
    }
    if (filtersToggle) {
      filtersToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        closeToolbarMenus();
        filtersOpen = !filtersOpen;
        buildQfBar();
      });
    }
    if (displayToggle && sortBar) {
      displayToggle.addEventListener("click", function (e) {
        e.stopPropagation();
        var open = sortBar.hidden;
        if (open) {
          closeToolbarMenus("sortBar");
          openToolbarMenuOverlay(sortBar);
        } else {
          closeToolbarMenus();
        }
      });
      sortBar.addEventListener("click", function (e) {
        var btn = e.target.closest(".sort-btn");
        if (!btn) return;
        var sort = btn.dataset.sort;
        if (sort === _railSort) { closeToolbarMenus(); return; }
        _railSort = sort;
        closeToolbarMenus();
        applyRailFilters();
      });
    }
    if (filterInput) {
      filterInput.addEventListener("input", function () {
        clearTimeout(_filterTimer);
        _filterTimer = setTimeout(function () {
          _railExpr = (filterInput.value || "").trim();
          applyRailFilters();
        }, 250);
      });
      filterInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          clearTimeout(_filterTimer);
          _railExpr = (filterInput.value || "").trim();
          applyRailFilters();
        }
      });
    }
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".rail-toolbar") && !e.target.closest("#qfBar")) {
        closeToolbarMenus();
      }
    });
    bindToolbarMenuOverlayKeys();
  })();
  railPoll(true);
  setInterval(railPoll, RAIL_POLL_MS);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) railPoll(); });
})();

/* launcher modal compat: same script the dashboard embeds */
var _INIT_DATA = { defaultCwd: ${JSON.stringify(defaultCwd || "")} };
function escH(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
${LAUNCHER_CLIENT_JS}
${COMMAND_PALETTE_CLIENT_JS}`;
}

const RUN_PAGE_CSS = `
${CHAT_PAGE_CSS}
${ansiPaletteCss()}
`;

/**
 * Shared chat-transcript client code — the conversation renderer used by
 * BOTH the run watch page and the read-only live-session watch page, so a
 * live session opened by hash gets the IDENTICAL transcript treatment as a
 * tracequest-launched run. The chunk assumes its embedding page declared:
 * runCwd, chatScroll/chatThread/chatActivity, lastBlocks,
 * lastSession, lastState, lastThreadHtml, lastActivityHtml, stopped, and a
 * mode-specific activityHtml() (hoisting makes declaration order moot).
 */
const CHAT_TRANSCRIPT_JS = `  /* ================= helpers ================= */

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function relPath(p) {
    p = String(p || "");
    if (runCwd && p.indexOf(runCwd + "/") === 0) return p.slice(runCwd.length + 1);
    if (runCwd && p === runCwd) return ".";
    return p;
  }

  /* ---- markdown-lite (assistant prose): escape FIRST, then decorate ---- */
  function inlineMd(s) {
    s = s.replace(/\`([^\`]+)\`/g, "<code>$1</code>");
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>");
    return s;
  }
  function mdText(txt) {
    var lines = String(txt).split("\\n");
    var html = "";
    var para = [];
    var inList = false;
    function flushPara() {
      if (para.length) {
        html += "<p>" + para.map(function (ln) { return inlineMd(escHtml(ln)); }).join("<br>") + "</p>";
        para = [];
      }
    }
    function closeList() {
      if (inList) { html += "</ul>"; inList = false; }
    }
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var h = /^(#{1,4})\\s+(.*)/.exec(ln);
      var b = /^\\s*[-*]\\s+(.*)/.exec(ln);
      var n = /^\\s*\\d+[.)]\\s+(.*)/.exec(ln);
      if (h) { flushPara(); closeList(); html += '<div class="chat-h">' + inlineMd(escHtml(h[2])) + "</div>"; }
      else if (b || n) {
        flushPara();
        if (!inList) { html += '<ul class="chat-list">'; inList = true; }
        var item = (b || n)[1];
        var chk = /^\\[([ xX])\\]\\s+(.*)/.exec(item);
        if (chk) html += '<li class="chat-check" data-done="' + (chk[1] !== " ") + '">' + inlineMd(escHtml(chk[2])) + "</li>";
        else html += "<li>" + inlineMd(escHtml(item)) + "</li>";
      } else if (/^\\s*$/.test(ln)) { flushPara(); closeList(); }
      else { closeList(); para.push(ln); }
    }
    flushPara();
    closeList();
    return html;
  }
  function md(src) {
    var parts = String(src).split("\`\`\`");
    var out = "";
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        var code = parts[i];
        var nl = code.indexOf("\\n");
        var body = nl >= 0 ? code.slice(nl + 1) : code;
        out += '<pre class="chat-code"><code>' + escHtml(body.replace(/\\n$/, "")) + "</code></pre>";
      } else {
        out += mdText(parts[i]);
      }
    }
    return out;
  }

  /* ---- tool groups: Cursor-style collapsed rows ----
     Consecutive calls of one kind read as one summary row; a click opens a
     group to one compact line per call, and a call to its full input and
     output. The grouping and the open/closed rules live in
     chat-tool-groups.js (unit-tested); this is the markup and the clicks. */
  function iconSvg(inner) {
    return '<svg class="card-icon" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' + inner + "</svg>";
  }
  var ICON_FILE = iconSvg('<path d="M4 1.5h5.5L13 5v9.5H4z" stroke="currentColor" stroke-linejoin="round"/><path d="M9.5 1.5V5H13" stroke="currentColor" stroke-linejoin="round"/>');
  var KIND_ICON = {
    read: ICON_FILE,
    edit: iconSvg('<path d="M10.5 2.5l3 3L6 13H3v-3z" stroke="currentColor" stroke-linejoin="round"/>'),
    command: iconSvg('<rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor"/><path d="M4.5 6l2 2-2 2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 10.5h3" stroke="currentColor" stroke-linecap="round"/>'),
    search: iconSvg('<circle cx="7" cy="7" r="4.5" stroke="currentColor"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-linecap="round"/>'),
    web: iconSvg('<circle cx="8" cy="8" r="6" stroke="currentColor"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor"/>'),
    wait: iconSvg('<circle cx="8" cy="8" r="6" stroke="currentColor"/><path d="M8 4.5V8l2.5 1.5" stroke="currentColor" stroke-linecap="round"/>'),
    agent: iconSvg('<circle cx="8" cy="5" r="2.5" stroke="currentColor"/><path d="M3 14c0-3 2-4.5 5-4.5s5 1.5 5 4.5" stroke="currentColor" stroke-linecap="round"/>'),
    other: iconSvg('<circle cx="3.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor"/>')
  };
  var ICON_CARET = '<span class="tg-caret" aria-hidden="true"></span>';
  var ICON_CHECK = '<span class="tg-ok" role="img" aria-label="done"></span>';
  var TOOL_MODE_KEY = "tq-chat-tool-mode";
  var FIND_HIT_BUDGET = 400;
  var OUTPUT_PREVIEW_LINES = 12;
  var OUTPUT_FULL_CHARS = 300000;
  function readToolMode() {
    try {
      var v = window.localStorage.getItem(TOOL_MODE_KEY);
      return v === "all" || v === "none" ? v : "auto";
    } catch (e) { return "auto"; }
  }
  /* mode: "auto" | "all" | "none" (Expand all / Collapse all); overrides: the
     reader's own clicks; forced: what a #tool- / #event- link opened; more:
     rows whose long output is shown in full; query: the find text. */
  var toolState = { mode: readToolMode(), overrides: {}, forced: {}, more: {}, query: "" };
  var itemBuilders = {};
  var lastEntries = [];

  function spinnerHtml() { return '<span class="spinner"></span>'; }
  function failedBadge(n) {
    return '<span class="tg-err">' + (n > 1 ? n + " failed" : "failed") + "</span>";
  }
  function threadItem(key, role, className, inner, eventIndex) {
    var item = { key: key, role: role, className: className, innerHTML: inner };
    if (typeof eventIndex === "number") item.eventIndex = eventIndex;
    return item;
  }
  function prePart(text, cls, key) {
    var more = !!toolState.more[key];
    var shown = text;
    var hidden = 0;
    if (!more) {
      var pv = outputPreview(text, OUTPUT_PREVIEW_LINES);
      shown = pv.text;
      hidden = pv.hidden;
    } else if (shown.length > OUTPUT_FULL_CHARS) {
      shown = shown.slice(0, OUTPUT_FULL_CHARS) + "\\n\u2026 (" + (text.length - OUTPUT_FULL_CHARS) + " more characters not shown)";
    }
    return '<pre class="tg-pre' + (cls ? " " + cls : "") + '">' + escHtml(shown) + "</pre>" +
      (hidden || more && text.split("\\n").length > OUTPUT_PREVIEW_LINES
        ? '<button class="tg-more" type="button" data-more="' + escHtml(key) + '">' + (more ? "show less" : "show more (" + hidden + " more line" + (hidden === 1 ? "" : "s") + ")") + "</button>"
        : "");
  }
  function sectionHtml(label, inner) {
    return '<div class="tg-sec"><div class="tg-label">' + escHtml(label) + "</div>" + inner + "</div>";
  }
  function rowBodyHtml(it) {
    var r = it.row;
    var tc = it.block.tc;
    var html = '<div class="tg-body">';
    if (r.kind === "edit" && tc.diffInfo) {
      var di = tc.diffInfo;
      if (di.oldStr) html += sectionHtml("Removed", prePart(String(di.oldStr), "del", "old:" + it.key));
      var added = di.newStr || di.content;
      if (added) html += sectionHtml(r.verb === "Wrote" ? "Written" : "Added", prePart(String(added), "add", "new:" + it.key));
    } else if (r.kind !== "read" && r.input && r.input.trim() !== r.target) {
      html += sectionHtml("Input", prePart(r.input, "", "in:" + it.key));
    }
    if (r.output) html += sectionHtml(r.error ? "Error" : "Output", prePart(r.output, r.error ? "err" : "", "out:" + it.key));
    else if (r.running) html += '<div class="tg-none">Running…</div>';
    else html += '<div class="tg-none">No output recorded</div>';
    if (tc.id) html += '<a class="tg-link" href="#tool-' + encodeURIComponent(tc.id) + '" title="Link to this call">link</a>';
    return html + "</div>";
  }
  function rowHeadInner(r, withIcon) {
    var status = r.running ? spinnerHtml() : r.error ? failedBadge(1) : r.done ? ICON_CHECK : "";
    var diff = r.added || r.removed
      ? '<span class="tg-diff"><span class="plus">+' + r.added + '</span><span class="minus">−' + r.removed + "</span></span>"
      : "";
    return (withIcon ? KIND_ICON[r.kind] : "") + '<span class="tg-verb' + (r.running ? " shimmer" : "") + '">' + escHtml(r.verb) + "</span>" +
      '<span class="tg-target' + (r.kind === "command" ? " mono" : "") + '">' + escHtml(r.target) + "</span>" + diff + status;
  }
  function rowHtml(it, open, withIcon) {
    var r = it.row;
    var id = it.block.tc && it.block.tc.id;
    return '<div class="tg-row' + (r.error ? " err" : "") + (r.running ? " running" : "") + (open ? " open" : "") + '" data-row="' + escHtml(it.key) + '"' + (id ? ' data-tool-id="' + escHtml(id) + '"' : "") + ">" +
      '<button class="tg-row-head" type="button" data-tg="' + escHtml(it.key) + '" aria-expanded="' + open + '">' + rowHeadInner(r, withIcon) + ICON_CARET + "</button>" +
      (open ? rowBodyHtml(it) : "") + "</div>";
  }
  function thoughtHtml(b, key, open) {
    return '<button class="chat-thought-toggle" type="button" data-tg="' + escHtml(key) + '" aria-expanded="' + open + '">' +
      '<span class="m1">Thought</span> <span class="m2">' + (b.dur ? "for " + escHtml(b.dur) : "briefly") + "</span></button>" +
      (open ? '<div class="chat-thinking">' + escHtml(b.text) + "</div>" : "");
  }
  function groupItem(g) {
    var st = groupOpenState(g, toolState, toolState.query);
    var el = g.items[0];
    // A lone call is its own row: its head already says what the group would.
    if (g.items.length === 1) {
      return threadItem(g.key, "tools", "chat-tools tg-single", rowHtml(el, st.items[el.key], true), g.eventIndex);
    }
    var detail = groupDetail(g);
    var status = g.running ? spinnerHtml() : g.failed ? failedBadge(g.failed) : "";
    var head = '<button class="tg-head" type="button" data-tg="' + escHtml(g.key) + '" aria-expanded="' + st.group + '">' +
      KIND_ICON[g.kind] + '<span class="tg-sum' + (g.running ? " shimmer" : "") + '">' + escHtml(groupSummary(g)) + "</span>" +
      (detail ? '<span class="tg-detail">' + escHtml(detail) + "</span>" : "") + status + ICON_CARET + "</button>";
    var body = "";
    if (st.group) {
      body = '<div class="tg-rows">';
      for (var i = 0; i < g.items.length; i++) {
        var it = g.items[i];
        body += it.type === "row" ? rowHtml(it, st.items[it.key], false) : '<div class="chat-thought">' + thoughtHtml(it.block, it.key, st.items[it.key]) + "</div>";
      }
      body += "</div>";
    }
    return threadItem(g.key, "tools", "chat-tools" + (g.failed ? " has-err" : "") + (st.group ? " open" : ""), head + body, g.eventIndex);
  }
  function outputPaneHtml(o) {
    var text = o.text;
    return '<div class="chat-card chat-output">' +
      '<div class="chat-card-head chat-output-head">' +
        ICON_FILE +
        '<span class="chat-output-name">' + escHtml(o.name) + "</span>" +
        '<span class="chat-output-meta">' + escHtml(o.meta) + "</span>" +
        (o.err ? '<span class="card-err">error</span>' : "") +
      "</div>" +
      '<pre class="chat-tool-body" tabindex="0">' + escHtml(text) + "</pre>" +
      "</div>";
  }
  function syncOutputPane(items) {
    var pane = document.getElementById("chatOutputPane");
    var app = document.querySelector("main.chat-app") || document.querySelector(".chat-app");
    if (!pane) return;
    var last = null;
    var i;
    for (i = 0; i < items.length; i++) {
      if (items[i] && items[i].output) last = items[i];
    }
    if (pane._tqKey) {
      for (i = 0; i < items.length; i++) {
        if (items[i] && items[i].key === pane._tqKey && items[i].output) {
          last = items[i];
          break;
        }
      }
    }
    // Keep the pane closed on first idle paint so the conversation
    // column stays full-width. Click sets _tqOpen and fills the pane.
    if (!last || !pane._tqOpen) {
      if (pane._tqHtml) {
        pane.innerHTML = "";
        pane._tqHtml = "";
      }
      pane.hidden = true;
      if (app) app.removeAttribute("data-has-output");
      return;
    }
    var html = outputPaneHtml(last.output);
    if (pane._tqHtml !== html) {
      pane.innerHTML = html;
      pane._tqHtml = html;
    }
    pane._tqKey = last.key;
    pane.hidden = false;
    if (app) app.setAttribute("data-has-output", "1");
    var cards = chatThread.querySelectorAll(".chat-card.chat-output");
    for (i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute("data-block-key") === last.key) cards[i].setAttribute("data-shown", "1");
      else cards[i].removeAttribute("data-shown");
    }
  }

  /* ---- session -> blocks ---- */
  function buildBlocks(session, state) {
    var events = (session && session.events) || [];
    var results = {};
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === "tool_result" && e.toolUseId) {
        var r = results[e.toolUseId] || (results[e.toolUseId] = { isError: false, text: "" });
        if (e.isError) r.isError = true;
        if (e.text) r.text = e.text;
      }
    }
    var blocks = [];
    var prevTs = null;
    for (i = 0; i < events.length; i++) {
      e = events[i];
      if (e.type === "user") {
        blocks.push({ kind: "user", text: e.text || "", eventIndex: i });
      } else if (e.type === "assistant") {
        if (e.thinking && e.thinking.length) {
          var dur = null;
          if (prevTs && e.timestamp) {
            var d = new Date(e.timestamp) - new Date(prevTs);
            if (d >= 1500) dur = Math.round(d / 1000) + "s";
          }
          blocks.push({ kind: "thought", dur: dur, text: e.thinking.join("\\n\\n"), eventIndex: i });
        }
        if (e.text) blocks.push({ kind: "text", text: e.text, eventIndex: i });
        var tcs = e.toolCalls || [];
        for (var j = 0; j < tcs.length; j++) {
          blocks.push({ kind: "tool", tc: tcs[j], res: tcs[j].id ? results[tcs[j].id] : null, eventIndex: i });
        }
      } else if (e.type === "tool_result" && e.isError && !e.toolUseId) {
        blocks.push({ kind: "errnote", text: e.text || "error", eventIndex: i });
      }
      if (e.timestamp) prevTs = e.timestamp;
    }
    // Trailing tool calls without results read as running while generating.
    if (state === "running") {
      for (var k = blocks.length - 1; k >= 0; k--) {
        var b = blocks[k];
        if (b.kind === "tool") {
          if (b.res) break;
          b.running = true;
        } else break;
      }
    }
    return blocks;
  }

  /* Recording-growth live tail: a file whose etag (mtimeMs-size) just
     moved, or whose newest assistant turn still has a tool_use with no
     result, is in progress even when detectLiveSessions reports idle. */
  function hasUnresolvedToolUse(session) {
    var events = (session && session.events) || [];
    var resolved = {};
    var i;
    for (i = 0; i < events.length; i++) {
      if (events[i].type === "tool_result" && events[i].toolUseId) resolved[events[i].toolUseId] = true;
    }
    for (i = events.length - 1; i >= 0; i--) {
      var e = events[i];
      if (e.type === "assistant") {
        var calls = e.toolCalls || [];
        for (var j = calls.length - 1; j >= 0; j--) {
          if (calls[j].id && !resolved[calls[j].id]) return true;
        }
        return false;
      }
      if (e.type === "user") return false;
    }
    return false;
  }
  function recordingGrewRecently() {
    var quiet = typeof QUIET_MS === "number" ? QUIET_MS : 4000;
    if (typeof lastGrowthAt === "number" && lastGrowthAt > 0 && Date.now() - lastGrowthAt < quiet) return true;
    return false;
  }

  function markerHtml(m1, m2) {
    return '<div class="chat-marker"><span class="m1">' + escHtml(m1) + '</span> <span class="m2">' + escHtml(m2) + "</span></div>";
  }
  function blockItem(b, idx) {
    var key = b.kind + ":" + idx;
    var ev = b.eventIndex;
    var item;
    if (b.kind === "user") item = threadItem(key, "user", "chat-user chat-message", escHtml(b.text), ev);
    else if (b.kind === "text") {
      item = threadItem(key, "assistant", "chat-assistant chat-message", md(b.text), ev);
      item.sourceText = b.text;
    } else if (b.kind === "thought") {
      item = threadItem(key, "thought", "chat-thought",
        thoughtHtml(b, key, isOpen(key, toolState, textMatches(b.text, toolState.query), false)), ev);
    } else {
      item = threadItem(key, "error", "chat-errnote chat-message", escHtml(b.text), ev);
    }
    return item;
  }
  /* Blocks to thread items: tool calls become groups, everything else stays a
     message. itemBuilders lets a click rebuild just the item it opened. */
  function renderItems(blocks) {
    var entries = groupToolBlocks(blocks, relPath);
    var items = [];
    itemBuilders = {};
    lastEntries = entries;
    entries.forEach(function (entry) {
      var build = entry.type === "group"
        ? function () { return groupItem(entry); }
        : function () { return blockItem(entry.block, entry.index); };
      var item = build();
      itemBuilders[item.key] = build;
      items.push(item);
    });
    return items;
  }
  function renderBlocks(blocks) {
    return itemsHtml(renderItems(blocks));
  }
  function itemsHtml(items) {
    var html = "";
    for (var r = 0; r < items.length; r++) {
      var it = items[r];
      html += '<div class="' + it.className + '" data-role="' + it.role + '" data-block-key="' + escHtml(it.key) + '">' + it.innerHTML + "</div>";
    }
    return html;
  }
  ${APPLY_THREAD_ITEMS_SRC}
  ${TOOL_GROUPS_SRC}

  /* ---- sticky scroll: live sticks to the generating trail; a
     completed idle turn frames the last user bubble so the prompt
     and the whole assistant sit in the viewport as one reading block.

     followTail remembers that the user is at the conversation end
     (idle leftover-snap frame counts). Sample it BEFORE live chrome
     CSS (activity min-height + col padding) changes scrollHeight —
     otherwise isAtBottom() goes false and Planning next moves sits below
     the fold. ---- */
  var followTail = true;
  var pinningTail = false;
  function isAtBottom() {
    if (!chatScroll) return true;
    return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 60;
  }
  function scrollBottom() {
    if (!chatScroll) return;
    pinningTail = true;
    chatScroll.scrollTop = chatScroll.scrollHeight;
    pinningTail = false;
    followTail = true;
  }
  function pinLiveTail() {
    scrollBottom();
    requestAnimationFrame(function () {
      if (followTail) scrollBottom();
    });
  }
  if (chatScroll) {
    chatScroll.addEventListener("scroll", function () {
      if (pinningTail) return;
      followTail = isAtBottom();
    }, { passive: true });
  }
  function frameCompletedTurn() {
    if (!chatScroll || !chatThread) return;
    var users = chatThread.querySelectorAll(".chat-user");
    var target = users.length ? users[users.length - 1] : null;
    if (!target) {
      chatScroll.scrollTop = 0;
      return;
    }
    var tr = target.getBoundingClientRect();
    var sr = chatScroll.getBoundingClientRect();
    chatScroll.scrollTop = Math.max(0, chatScroll.scrollTop + (tr.top - sr.top) - 10);
  }
  function historyRoot() { return document.getElementById("chatHistory"); }
  function historyCol() { return document.getElementById("chatHistoryCol"); }
  function lastThreadEl(sel) {
    var nodes = [];
    var hist = historyCol();
    if (hist) {
      var a = hist.querySelectorAll(sel);
      var i;
      for (i = 0; i < a.length; i++) nodes.push(a[i]);
    }
    if (chatThread) {
      var b = chatThread.querySelectorAll(sel);
      var j;
      for (j = 0; j < b.length; j++) nodes.push(b[j]);
    }
    return nodes.length ? nodes[nodes.length - 1] : null;
  }
  function nodeFollows(earlier, later) {
    if (!earlier || !later) return false;
    return !!(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
  }
  // After growth, leftover-snap of the first dump's named card spends
  // leftover on that card so the newest completed turn shears onto
  // the continue pill. Stale = a follow-up user after the first
  // named output starts a new turn (use lastBlocks so moving that
  // file after newest prose does not flip the flag).
  // Same-turn tool-then-prose (G1 opening + shell output + closing)
  // is the completed named column, not after-growth — leftover-snap
  // that named file occupying leftover, do not park it under the
  // last caption (lastAsst > firstOut is G1's real turn shape).
  function leftoverSnapIsStale() {
    var blocks = lastBlocks || [];
    var firstOut = -1;
    var lastAsst = -1;
    var lastUser = -1;
    var i;
    for (i = 0; i < blocks.length; i++) {
      if (blocks[i].kind === "user") lastUser = i;
      if (blocks[i].kind === "tool" && blocks[i].res) {
        if (firstOut < 0) firstOut = i;
      }
      if (blocks[i].kind === "text") lastAsst = i;
    }
    if (firstOut >= 0 && lastUser > firstOut && lastAsst > lastUser) return true;
    if (firstOut >= 0 && lastUser > firstOut) {
      return nodeFollows(lastThreadEl(".chat-card.chat-output"), lastThreadEl(".chat-user"));
    }
    return false;
  }
  // Frame the last user only for first-turn leftover-snap, or when a
  // follow-up user after the first named-output starts a new turn.
  // File-less same-user growth must not re-frame the first dump
  // (r5 leftover-snapped that dump in place at scrollTop=0).
  function shouldFrameCompletedTurn() {
    if (!leftoverSnapIsStale()) return true;
    return nodeFollows(lastThreadEl(".chat-card.chat-output"), lastThreadEl(".chat-user"));
  }
  // Newest completed turn whole above the slim continue pill.
  // Does not change leftover-snap line math.
  function keepNewestTurnAbovePill() {
    if (!chatScroll) return;
    var el = lastThreadEl(".chat-assistant");
    var composer = document.querySelector(".chat-composer");
    if (!el || !composer) return;
    var er = el.getBoundingClientRect();
    var cr = composer.getBoundingClientRect();
    if (er.bottom > cr.top - 4) {
      chatScroll.scrollTop += (er.bottom - cr.top) + 8;
    }
    followTail = true;
  }
  // After growth a newest turn that owns a file is the reading block.
  // A new user after the first named-output starts that turn; otherwise
  // the last .chat-assistant is the reading start — not the first-dump user.
  // Pinning only the last box left BAR_NEW_TURN_MARKER as a 39px caption under an uncapped prior file object.
  // Framing the last user after parking the dump left a two-line island over unused leftover (r2).
  // r3 stapled the previous dump's fixture under the marker.
  // r5 leftover-snapped the first dump's fixture in place so leftover
  // still framed user + L001–L023 + ev=1 at scrollTop=0.
  // r6 height-0'd the first dump and claimed leftover with margin-top
  // spacer on the 39px caption (black void + caption glued to the pill).
  function newestTurnAnchor() {
    var user = lastThreadEl(".chat-user");
    var firstOut = chatThread ? chatThread.querySelector(".chat-card.chat-output") : null;
    if (user && firstOut && nodeFollows(firstOut, user)) return user;
    return lastThreadEl(".chat-assistant");
  }
  function restoreLeftoverViewport() {
    if (chatScroll) {
      chatScroll.style.height = "";
      chatScroll.style.minHeight = "";
      chatScroll.style.flex = "";
      chatScroll.style.marginTop = "";
    }
    if (chatThread) chatThread.style.paddingBottom = "";
    document.body.removeAttribute("data-leftover-pocket");
    document.body.removeAttribute("data-leftover-owned");
    document.body.removeAttribute("data-leftover-reading");
  }
  function restoreThreadFromHistory() {
    var col = historyCol();
    var root = historyRoot();
    if (!col || !chatThread) return;
    while (col.firstChild) chatThread.insertBefore(col.firstChild, chatThread.firstChild);
    if (root) {
      root.hidden = true;
      root.removeAttribute("data-split");
    }
  }
  function clearLeftoverScrollPad() {
    restoreThreadFromHistory();
    restoreLeftoverViewport();
  }
  // File-less leftover occupies leftover as the newest turn's reading
  // block: leftover (#chatScroll) fills leftover (flex:1). r9 sized
  // leftover to a 55px pocket and pinned it with flex-end so leftover
  // ceded to unused chat-main. r7 leftoverScrollPadForNewest set
  // #chatThread padding-bottom hoisting a 39px caption to leftover top
  // over unused leftover. r6 leftover is not a black void above a
  // caption glued to the pill. r8 leftover history painted the dump
  // on leftover.
  function occupyLeftoverAsNewestReading(el) {
    if (!chatScroll || !el) return;
    document.body.removeAttribute("data-leftover-pocket");
    document.body.setAttribute("data-leftover-owned", "newest");
    document.body.setAttribute("data-leftover-reading", "1");
    chatScroll.style.height = "";
    chatScroll.style.minHeight = "";
    chatScroll.style.flex = "";
    chatScroll.style.marginTop = "";
    if (chatThread) chatThread.style.paddingBottom = "";
  }
  // File-less newest: leftover-owned pixels are that turn occupying
  // leftover (prose at leftover top + honest absence + close). Earlier
  // turns stay in flow above it, scrolled off the top. Do not stretch the
  // caption (r4), do not pin it with margin-top (r6), do not
  // pad-bottom hoist (r7), do not shrink leftover to a 55px pocket
  // that cedes leftover to unused chat-main (r9).
  function frameNewestTurnAtLeftoverTop() {
    if (!chatScroll) return;
    var newest = lastThreadEl(".chat-assistant");
    if (!newest) return;
    clearNewestProseLeftover(newest);
    occupyLeftoverAsNewestReading(newest);
    var tr = newest.getBoundingClientRect();
    var sr = chatScroll.getBoundingClientRect();
    chatScroll.scrollTop = Math.max(0, chatScroll.scrollTop + (tr.top - sr.top) - 4);
    keepNewestTurnAbovePill();
    followTail = true;
  }
  function leftoverSnapNewestTurn() {
    if (!chatScroll) return;
    if (!newestTurnOwnFile()) {
      frameNewestTurnAtLeftoverTop();
      return;
    }
    clearLeftoverScrollPad();
    var target = newestTurnAnchor();
    if (!target) return;
    var tr = target.getBoundingClientRect();
    var sr = chatScroll.getBoundingClientRect();
    chatScroll.scrollTop = Math.max(0, chatScroll.scrollTop + (tr.top - sr.top) - 10);
    // Size the file where the frame put it, not where it sat before.
    if (lastState !== "running") leftoverSnapNewestTurnReading();
    keepNewestTurnAbovePill();
  }
  // That turn's own file: same data-event-index as the last assistant.
  // The last .chat-card.chat-output is the prior dump's fixture after
  // a file-less measure append — do not staple it under BAR_NEW_TURN_MARKER.
  function newestTurnOwnFile() {
    if (!chatThread) return null;
    var newest = lastThreadEl(".chat-assistant");
    if (!newest) return null;
    var ev = parseInt(newest.getAttribute("data-event-index"), 10);
    if (isNaN(ev)) return null;
    var cards = chatThread.querySelectorAll(".chat-card.chat-output");
    var own = null;
    var i;
    for (i = 0; i < cards.length; i++) {
      var ce = parseInt(cards[i].getAttribute("data-event-index"), 10);
      if (ce === ev) own = cards[i];
    }
    return own;
  }
  function clearNewestProseLeftover(el) {
    if (!el) return;
    el.style.minHeight = "";
    el.style.paddingBottom = "";
    el.style.marginBottom = "";
    el.style.marginTop = "";
    if (el.getAttribute("data-contained") === "leftover") el.removeAttribute("data-contained");
  }
  // r4 stretched a 39px caption with min-height — leftover was 701px
  // of air, not leftover-snap. Honest absence: do not fake a file and
  // do not stretch the caption.
  // Newest turn with its own file: leftover-snap that turn
  // (prose + file card + close).
  function leftoverSnapNewestTurnReading() {
    var newest = lastThreadEl(".chat-assistant");
    var own = newestTurnOwnFile();
    if (!own) return;
    clearNewestProseLeftover(newest);
    unparkNode(own);
    snapNamedOutputCard(own, true);
  }
  // After a file-less append leftover closes above a reserved slot for
  // the newest prose (composer.top − newest height), not newest.top
  // after an uncapped 475px file — that leftover room equals the file
  // itself and leftover-snap never snaps (r1).
  function leftoverCloseTop(card, composer) {
    var close = composer.getBoundingClientRect().top;
    if (!leftoverSnapIsStale() || newestTurnOwnFile()) return close;
    var newest = lastThreadEl(".chat-assistant");
    if (newest && card && nodeFollows(card, newest)) {
      var nh = Math.ceil(newest.getBoundingClientRect().height) || 39;
      return close - nh - 8;
    }
    return close;
  }
  function clearOutputCap(card) {
    if (!card) return;
    card.style.maxHeight = "";
    card.style.height = "";
    card.removeAttribute("data-contained");
    var body = card.querySelector(".chat-tool-body");
    if (body) {
      body.style.maxHeight = "";
      body.style.height = "";
      body.style.padding = "";
      body.style.overflow = "";
      body.style.border = "";
      body.style.margin = "";
    }
  }
  function unparkNode(el) {
    if (!el) return;
    el.style.maxHeight = "";
    el.style.height = "";
    el.style.minHeight = "";
    el.style.overflow = "";
    el.style.marginTop = "";
    el.style.marginBottom = "";
    el.style.paddingTop = "";
    el.style.paddingBottom = "";
    el.style.borderWidth = "";
    el.removeAttribute("data-contained");
    el.removeAttribute("data-trail");
    var body = el.querySelector(".chat-tool-body");
    if (body) {
      body.style.maxHeight = "";
      body.style.height = "";
      body.style.padding = "";
      body.style.overflow = "";
      body.style.border = "";
      body.style.margin = "";
    }
  }
  function unparkAll() {
    clearLeftoverScrollPad();
    if (!chatThread) return;
    var parked = chatThread.querySelectorAll("[data-contained=parked], [data-contained=leftover]");
    var i;
    for (i = 0; i < parked.length; i++) unparkNode(parked[i]);
  }
  // Natural empty air is leftover #chatScroll under a short
  // prompt-anchored trail. Do not manufacture a fold-filling
  // #chatActivity min-height — that spacer turns pin-to-tail into
  // leftover-snap stubs over void.
  function sizeLiveAir() {
    if (!chatActivity) return;
    chatActivity.style.minHeight = "";
  }
  // Prompt-anchored live trail: if the last user bubble plus this
  // turn's tools plus Planning fit, pin the prompt to the top of
  // #chatScroll (Cursor conversation-01–04). A trail that overflows
  // still pinLiveTails so Planning does not sit below the fold.
  function frameLiveTrail() {
    if (!chatScroll || !chatThread) {
      pinLiveTail();
      return;
    }
    var users = chatThread.querySelectorAll(".chat-user");
    var target = users.length ? users[users.length - 1] : null;
    if (!target) {
      pinLiveTail();
      return;
    }
    var tr = target.getBoundingClientRect();
    var trailBottom = chatActivity
      ? chatActivity.getBoundingClientRect().top + 28
      : chatThread.getBoundingClientRect().bottom;
    if (trailBottom - tr.top <= chatScroll.clientHeight - 8) {
      frameCompletedTurn();
      followTail = true;
      return;
    }
    pinLiveTail();
  }
  // Measure each pre line box via Range so the file-object viewport
  // can close on a complete line (not a theoretical line-height).
  function measurePreLines(pre) {
    var node = pre.firstChild;
    while (node && node.nodeType !== 3) node = node.nextSibling;
    if (!node) return [];
    var raw = node.nodeValue || "";
    var range = document.createRange();
    var out = [];
    var start = 0;
    var i;
    for (i = 0; i <= raw.length; i++) {
      if (i !== raw.length && raw.charCodeAt(i) !== 10) continue;
      try {
        if (i > start) {
          range.setStart(node, start);
          range.setEnd(node, i);
        } else {
          range.setStart(node, start);
          range.setEnd(node, start);
        }
        var r = range.getBoundingClientRect();
        if (r.height > 0) {
          out.push({ top: r.top, bottom: r.bottom, start: start, end: i });
        } else if (out.length) {
          var prev = out[out.length - 1];
          var lh = Math.max(12, prev.bottom - prev.top);
          out.push({ top: prev.bottom, bottom: prev.bottom + lh, start: start, end: i });
        }
      } catch (err) { /* range bounds */ }
      start = i + 1;
    }
    return out;
  }
  // Snap the body viewport so it closes at the next line's top: the
  // last painted Range is whole, the following glyph is not in the
  // box, and the card's padding-bottom is empty interior pad
  // (last Range.bottom ≤ card.bottom).
  function snapBodyToWholeLines(body, card, maxH) {
    var lines = measurePreLines(body);
    var br = body.getBoundingClientRect();
    if (!lines.length) {
      var fallback = Math.max(0, Math.floor(maxH));
      body.style.height = fallback + "px";
      body.style.maxHeight = fallback + "px";
      return;
    }
    function closeAt(idx) {
      if (idx + 1 < lines.length && lines[idx + 1].top > lines[idx].bottom) {
        return lines[idx + 1].top;
      }
      return lines[idx].bottom;
    }
    var last = -1;
    var i;
    for (i = 0; i < lines.length; i++) {
      if (closeAt(i) - br.top <= maxH + 0.5) last = i;
      else break;
    }
    if (last < 0) last = 0;
    var snapped = Math.min(Math.floor(maxH), Math.floor(closeAt(last) - br.top - 0.5));
    while (last > 0 && lines[last].bottom > br.top + snapped + 0.5) {
      last--;
      snapped = Math.min(Math.floor(maxH), Math.floor(closeAt(last) - br.top - 0.5));
    }
    if (snapped < 1) snapped = Math.max(1, Math.floor(lines[0].bottom - br.top));
    body.style.height = snapped + "px";
    body.style.maxHeight = snapped + "px";
    body.style.overflow = "auto";
    var after = card.getBoundingClientRect();
    var lastLine = lines[last];
    if (lastLine && lastLine.bottom > after.bottom + 0.5 && last > 0) {
      last--;
      snapped = Math.min(Math.floor(maxH), Math.floor(closeAt(last) - br.top - 0.5));
      body.style.height = snapped + "px";
      body.style.maxHeight = snapped + "px";
    }
  }
  function snapNamedOutputCard(card, fillLeftover) {
    if (!card) return;
    var body = card.querySelector(".chat-tool-body");
    if (!body) return;
    var composer = document.querySelector(".chat-composer");
    if (!composer) return;
    // Answer-first leftover snap: never yield/clip .chat-assistant.
    // The file object takes only room between the unclipped prose and
    // the composer, cutting preferred file-object lines first.
    clearOutputCap(card);
    var head = card.querySelector(".chat-output-head");
    var headH = head ? Math.ceil(head.getBoundingClientRect().height) : 0;
    var lines = measurePreLines(body);
    var cs = window.getComputedStyle(body);
    var padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var borderY = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    var avgLh = parseFloat(cs.lineHeight);
    if (!avgLh || !isFinite(avgLh)) {
      var fs = parseFloat(cs.fontSize) || 11.5;
      avgLh = fs * 1.4;
    }
    if (lines.length >= 2) {
      avgLh = (lines[lines.length - 1].bottom - lines[0].top) / lines.length;
    } else if (lines.length === 1) {
      avgLh = Math.max(12, lines[0].bottom - lines[0].top);
    }
    var FILE_OBJECT_MAX = 12;
    var preferredLines = Math.max(1, Math.min(lines.length || FILE_OBJECT_MAX, FILE_OBJECT_MAX));
    var preferredBody = Math.ceil(preferredLines * avgLh + padY + borderY);
    var cardPadB = 12;
    var closeTop = leftoverCloseTop(card, composer);
    var cr = card.getBoundingClientRect();
    var leftover = Math.floor(closeTop - cr.top - 8);
    var leftoverBody = leftover - headH - cardPadB;
    // fillLeftover (G1 first-turn named column, after-growth own file)
    // leftover-snaps leftover room so the named card occupies leftover.
    // Otherwise the 12-line preferred ceiling still applies.
    var bodyRoom = fillLeftover ? leftoverBody : Math.min(preferredBody, leftoverBody);
    var naturalBody = body.scrollHeight;
    if (bodyRoom < 1 || naturalBody <= bodyRoom + 1) {
      card.setAttribute("data-contained", "1");
      return;
    }
    snapBodyToWholeLines(body, card, bodyRoom);
    card.setAttribute("data-contained", "1");
    cr = card.getBoundingClientRect();
    if (cr.bottom > closeTop - 4) {
      var tighter = Math.max(1, bodyRoom - Math.ceil(cr.bottom - (closeTop - 4)));
      snapBodyToWholeLines(body, card, tighter);
    }
  }
  // First-turn leftover occupancy: leftover is the flex:1 leftover
  // viewport (leftover.bottom is composer.top of leftover.clientHeight
  // leftover viewport, leftover = composer.top − leftover.top =
  // leftover.clientHeight). leftover-owned pixels occupying leftover
  // are BAR's named shell-output column — opening prose + named card (Lines 1–6) + closing prose — not user + prior dumps.
  // leftoverAir is leftover − leftoverOwned (BAR leftover has leftover air under closing). leftover occupancy of leftover-owned content is not leftover occupancy of leftover. unparkAll restores
  // live-parked nodes; earlier blocks (user, lsof/ps, thoughts) stay
  // in flow above the opening, scrolled off the top. The named card
  // fillLeftover-snaps in place — not a 12-line island under the user
  // prompt, not data-contained=parked, not split into #chatHistory.
  function leftoverOccupyingNamedCard() {
    if (!chatThread) return null;
    var cards = chatThread.querySelectorAll(".chat-card.chat-output");
    return cards.length ? cards[cards.length - 1] : null;
  }
  // Earlier blocks stay in flow at their natural height so scrolling up
  // reaches them; the column is framed by scrolling it to the top.
  function leftoverSnapNamedColumn() {
    var named = leftoverOccupyingNamedCard();
    if (!named || !chatThread || !chatScroll || lastState === "running") return;
    var opening = named.previousElementSibling;
    var top = opening && opening.classList.contains("chat-assistant") ? opening : named;
    clearOutputCap(named);
    var tr = top.getBoundingClientRect();
    var sr = chatScroll.getBoundingClientRect();
    chatScroll.scrollTop = Math.max(0, chatScroll.scrollTop + (tr.top - sr.top) - 20);
    document.body.setAttribute("data-leftover-owned", "named-column");
    snapNamedOutputCard(named, true);
  }
  function containNamedOutput() {
    if (!chatScroll || !chatThread) return;
    if (lastState === "running") {
      // Every earlier item of the turn stays in the thread at its natural
      // height, so the conversation scrolls from the first prompt to the
      // live tail. Collapsing them left only the prompt with nothing to scroll.
      unparkAll();
      clearNewestProseLeftover(lastThreadEl(".chat-assistant"));
      sizeLiveAir();
      return;
    }
    if (leftoverSnapIsStale()) {
      // Earlier turns stay in flow; leftoverSnapNewestTurn frames the
      // newest turn by scrolling and sizes its own file there.
      unparkAll();
      if (!newestTurnOwnFile()) occupyLeftoverAsNewestReading(lastThreadEl(".chat-assistant"));
      clearNewestProseLeftover(lastThreadEl(".chat-assistant"));
      sizeLiveAir();
      return;
    }
    unparkAll();
    sizeLiveAir();
  }

  /* ---- tool-row interaction: open/close, Expand all, find, deep links ---- */
  function findHitMarks() { return chatThread ? chatThread.querySelectorAll("mark.chat-hit") : []; }
  function clearFindMarks(root) {
    var marks = root.querySelectorAll("mark.chat-hit");
    for (var i = 0; i < marks.length; i++) {
      var parent = marks[i].parentNode;
      parent.replaceChild(document.createTextNode(marks[i].textContent), marks[i]);
      parent.normalize();
    }
  }
  /* Highlight every occurrence of the find text in a rendered subtree. Rows
     that hold a hit are already open (groupOpenState), so the hit is in the DOM. */
  function applyFindMarks(root) {
    clearFindMarks(root);
    var q = toolState.query.toLowerCase();
    if (!q) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    var budget = FIND_HIT_BUDGET;
    for (var i = 0; i < nodes.length && budget > 0; i++) {
      var node = nodes[i];
      var text = node.nodeValue;
      var lower = text.toLowerCase();
      var at = lower.indexOf(q);
      if (at < 0) continue;
      var frag = document.createDocumentFragment();
      var from = 0;
      while (at >= 0 && budget-- > 0) {
        if (at > from) frag.appendChild(document.createTextNode(text.slice(from, at)));
        var mark = document.createElement("mark");
        mark.className = "chat-hit";
        mark.textContent = text.slice(at, at + q.length);
        frag.appendChild(mark);
        from = at + q.length;
        at = lower.indexOf(q, from);
      }
      if (from < text.length) frag.appendChild(document.createTextNode(text.slice(from)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  var currentHit = -1;
  function syncFindCount() {
    var el = document.getElementById("chatFindCount");
    if (!el) return;
    var n = findHitMarks().length;
    el.textContent = toolState.query ? (n ? (currentHit >= 0 ? currentHit + 1 + " / " : "") + n + (n >= FIND_HIT_BUDGET ? "+" : "") : "no matches") : "";
  }
  function stepHit(dir) {
    var marks = findHitMarks();
    if (!marks.length) return;
    var prev = chatThread.querySelector("mark.chat-hit.current");
    if (prev) prev.classList.remove("current");
    currentHit = (currentHit + dir + marks.length) % marks.length;
    marks[currentHit].classList.add("current");
    marks[currentHit].scrollIntoView({ block: "center" });
    followTail = false;
    syncFindCount();
  }
  function syncToolbar() {
    var bar = document.getElementById("chatFindBar");
    if (!bar) return;
    var any = lastEntries.some(function (e) { return e.type === "group" || e.block.kind === "thought"; });
    bar.hidden = !any && !toolState.query;
    var btn = document.getElementById("chatToggleAll");
    if (btn) {
      btn.textContent = toolState.mode === "all" ? "Collapse all" : "Expand all";
      btn.setAttribute("aria-pressed", toolState.mode === "all" ? "true" : "false");
    }
    syncFindCount();
  }
  /* Keep what the reader is looking at in place while rows above it change height. */
  function withScrollAnchor(fn) {
    var anchor = null;
    var offset = 0;
    if (chatScroll && chatThread) {
      var top = chatScroll.getBoundingClientRect().top;
      for (var i = 0; i < chatThread.children.length; i++) {
        var r = chatThread.children[i].getBoundingClientRect();
        if (r.bottom > top + 1) { anchor = chatThread.children[i]; offset = r.top - top; break; }
      }
    }
    fn();
    if (anchor && anchor.isConnected) {
      chatScroll.scrollTop += anchor.getBoundingClientRect().top - chatScroll.getBoundingClientRect().top - offset;
    }
  }
  /* Rebuild the whole thread from the blocks already in hand (no framing,
     no scroll jump): Expand all, the find text, a deep link. */
  function repaintThread() {
    if (!lastSession) return;
    withScrollAnchor(function () {
      var items = renderItems(lastBlocks);
      lastItems = items;
      lastThreadHtml = itemsHtml(items);
      applyThreadItems(chatThread, items);
    });
    syncOutputPane(lastItems);
    afterThreadPatch(true);
  }
  /* Rebuild only the item a click touched, and keep keyboard focus on its button. */
  function patchToolItem(from) {
    var el = from.closest("[data-block-key]");
    var build = el && itemBuilders[el.getAttribute("data-block-key")];
    if (!build) return;
    var attr = from.hasAttribute("data-more") ? "data-more" : "data-tg";
    var focusKey = from.getAttribute(attr);
    var item = build();
    el.className = item.className;
    el.innerHTML = item.innerHTML;
    el._tqHtml = item.innerHTML;
    for (var i = 0; i < lastItems.length; i++) {
      if (lastItems[i].key === item.key) { lastItems[i] = item; break; }
    }
    lastThreadHtml = itemsHtml(lastItems);
    if (toolState.query) applyFindMarks(el);
    var again = el.querySelectorAll("[" + attr + "]");
    for (var j = 0; j < again.length; j++) {
      if (again[j].getAttribute(attr) === focusKey) { again[j].focus(); break; }
    }
    syncFindCount();
  }
  function setToolMode(mode) {
    toolState.mode = mode;
    toolState.overrides = {};
    toolState.forced = {};
    toolState.more = {};
    try { window.localStorage.setItem(TOOL_MODE_KEY, mode); } catch (e) { /* private mode */ }
    repaintThread();
  }
  var deepLink = parseDeepLink(window.location.hash);
  /* A #tool-<id> / #event-<n> link opens its row and scrolls to it. The
     transcript may not carry it yet (a live run), so try again on each patch. */
  function applyDeepLink() {
    if (!deepLink) return;
    var keys = deepLinkKeys(lastEntries, deepLink);
    var rowKeys = Object.keys(keys).filter(function (k) { return k.indexOf("group:") !== 0; });
    if (!rowKeys.length) return;
    deepLink = null;
    toolState.forced = keys;
    repaintThread();
    var rows = chatThread.querySelectorAll(".tg-row");
    var target = null;
    for (var i = 0; i < rows.length && !target; i++) {
      if (rowKeys.indexOf(rows[i].getAttribute("data-row")) >= 0) target = rows[i];
    }
    if (!target) return;
    target.classList.add("flash");
    followTail = false;
    var show = function () { target.scrollIntoView({ block: "center" }); };
    show();
    requestAnimationFrame(function () { requestAnimationFrame(show); });
    setTimeout(show, 120);
    setTimeout(function () { target.classList.remove("flash"); }, 2400);
  }
  function afterThreadPatch(changed) {
    if (changed && (toolState.query || findHitMarks().length)) applyFindMarks(chatThread);
    syncToolbar();
    applyDeepLink();
  }
  window.addEventListener("hashchange", function () {
    deepLink = parseDeepLink(window.location.hash);
    applyDeepLink();
  });
  (function bindToolbar() {
    var toggle = document.getElementById("chatToggleAll");
    var input = document.getElementById("chatFind");
    if (toggle) toggle.addEventListener("click", function () { setToolMode(toolState.mode === "all" ? "none" : "all"); });
    if (!input) return;
    try { toolState.query = (new URLSearchParams(window.location.search).get("q") || "").trim(); } catch (e) { /* no query */ }
    input.value = toolState.query;
    var timer = null;
    input.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        toolState.query = input.value.trim();
        currentHit = -1;
        try {
          var params = new URLSearchParams(window.location.search);
          if (toolState.query) params.set("q", toolState.query); else params.delete("q");
          var qs = params.toString();
          history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : "") + window.location.hash);
        } catch (e) { /* ignore */ }
        repaintThread();
      }, 150);
    });
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter") { ev.preventDefault(); stepHit(ev.shiftKey ? -1 : 1); }
      else if (ev.key === "Escape" && input.value) { input.value = ""; input.dispatchEvent(new Event("input")); }
    });
  })();

  var lastItems = [];
  var framedTurnKey = "";
  // Live-trail framing is identity generating, or in-flight unmatched
  // tool_use. QUIET_MS on a completed idle turn is not a live trail.
  function watchFramesLiveTrail() {
    if (lastState !== "running") return false;
    if (typeof watchIdentityWord === "function" && watchIdentityWord() !== "running") {
      return typeof hasUnresolvedToolUse === "function" && hasUnresolvedToolUse(lastSession);
    }
    return true;
  }
  function rerender() {
    lastBlocks = lastSession ? buildBlocks(lastSession, lastState) : [];
    var items = renderItems(lastBlocks);
    lastItems = items;
    // The thread's HTML from the items just built, not a second render pass.
    var threadHtml = itemsHtml(items);
    var stick = followTail || isAtBottom();
    var threadChanged = threadHtml !== lastThreadHtml;
    if (threadChanged) {
      restoreThreadFromHistory();
      restoreLeftoverViewport();
      applyThreadItems(chatThread, items);
      lastThreadHtml = threadHtml;
    }
    syncOutputPane(items);
    afterThreadPatch(threadChanged);
    var aHtml = activityHtml();
    if (aHtml !== lastActivityHtml) {
      chatActivity.innerHTML = aHtml;
      lastActivityHtml = aHtml;
    }
    var turnKey = "";
    var lastAsstKey = "";
    for (var u = 0; u < items.length; u++) {
      if (!items[u]) continue;
      if (items[u].role === "user") turnKey = items[u].key;
      if (items[u].role === "assistant") lastAsstKey = items[u].key;
    }
    var frameKey = turnKey + "\0" + lastAsstKey;
    if (watchFramesLiveTrail()) {
      framedTurnKey = "";
      containNamedOutput();
      if (stick) frameLiveTrail();
      requestAnimationFrame(function () {
        containNamedOutput();
        if (stick && followTail) frameLiveTrail();
      });
    } else if (frameKey && frameKey !== framedTurnKey) {
      framedTurnKey = frameKey;
      if (shouldFrameCompletedTurn()) frameCompletedTurn();
      containNamedOutput();
      if (leftoverSnapIsStale()) leftoverSnapNewestTurn();
      else leftoverSnapNamedColumn();
      requestAnimationFrame(function () {
        if (shouldFrameCompletedTurn()) frameCompletedTurn();
        containNamedOutput();
        if (leftoverSnapIsStale()) leftoverSnapNewestTurn();
        else leftoverSnapNamedColumn();
      });
    } else {
      containNamedOutput();
    }
    // Identity word (detectLiveSessions / apiLive on /run?session=), not
    // the growth lastState overlay (quiet window / unmatched tool_use).
    document.body.setAttribute("data-run-state", typeof watchIdentityWord === "function" ? watchIdentityWord() : lastState);
  }

  window._stayLoaded = true;
  window._refreshData = function () {
    if (stopped) return;
    if (typeof sessStopped !== "undefined" && sessStopped) return;
    if (typeof window._refreshRail === "function") window._refreshRail();
    if (sessTimer) { clearTimeout(sessTimer); sessTimer = null; }
    if (typeof pollSession === "function") pollSession();
  };

  chatThread.addEventListener("click", function (ev) {
    var t = ev.target && ev.target.closest ? ev.target.closest("[data-tg], [data-more]") : null;
    if (t) {
      var moreKey = t.getAttribute("data-more");
      if (moreKey) toolState.more[moreKey] = !toolState.more[moreKey];
      else toolState.overrides[t.getAttribute("data-tg")] = t.getAttribute("aria-expanded") !== "true";
      patchToolItem(t);
      return;
    }
    var card = ev.target && ev.target.closest ? ev.target.closest(".chat-card.chat-output") : null;
    if (!card) return;
    var pane = document.getElementById("chatOutputPane");
    if (!pane) return;
    pane._tqKey = card.getAttribute("data-block-key") || "";
    pane._tqOpen = true;
    syncOutputPane(lastItems);
  });
  window.addEventListener("resize", function () {
    containNamedOutput();
    if (watchFramesLiveTrail() && followTail) frameLiveTrail();
    else if (!watchFramesLiveTrail() && leftoverSnapIsStale() && followTail) leftoverSnapNewestTurn();
    else if (!watchFramesLiveTrail() && followTail) {
      if (leftoverOccupyingNamedCard()) leftoverSnapNamedColumn();
      else { frameCompletedTurn(); keepNewestTurnAbovePill(); }
    }
  });
`;

/**
 * Build the /run watch page for one run.
 * @param {{ run: { id: string, agent: string, cwd: string, startedAt: string,
 *   status: "running"|"idle"|"exited", resumedFrom?: string|null,
 *   canResume?: boolean, prompt?: string|null, sessionPath?: string|null,
 *   live?: boolean } }} data
 * `resumedFrom` (a session hash) renders the "continued from <id>" header
 * provenance linking back to the source session; `canResume` gates the
 * finished-run CONTINUE COMPOSER (the same input card stays live once the
 * run ends and typing IS the continue — submit forks the recorded session
 * into a new run with the follow-up delivered; only agents with a verified
 * resume mechanism get it, honest absence otherwise); `prompt` (the
 * tq_prompt snippet) feeds a resumed run's pending follow-up bubble.
 */
export function runPage({ run } = {}) {
  const { id, agent, cwd, startedAt, status } = run;
  const resumedFrom = run.resumedFrom || null;
  const canResume = Boolean(run.canResume);
  const exited = status === "exited";
  const identityStatus = runIdentityStatus(run);
  const generating = identityStatus === "running";
  // An unlinked run is "pending" only while it may still be starting up; an
  // orphaned one (idle, fact hlorph) is not running and waits for nothing.
  const chatState = exited
    ? "exited"
    : (generating ? (run.sessionPath ? "running" : "pending") : "idle");
  const composerState = exited ? "exited" : (generating ? "running" : "idle");
  const composerText = exited ? "Agent exited" : (generating ? "Running" : "Idle");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINKS}
<title>tracequest — run ${esc(id)}</title>
${THEME_BOOT_SCRIPT}
<style>
${STANDALONE_BASE_CSS}
${RUN_PAGE_CSS}
${APP_SHELL_CSS}
${LAUNCHER_MODAL_CSS}
${COMMAND_PALETTE_CSS}
</style>
</head>
<body data-polling="0" data-chat-polling="0" data-run-state="${esc(chatState)}">
<div class="tq-shell">
${APP_TOP_HTML}
  <div class="shell-main">
    ${AGENT_RAIL_HTML}
    <main class="chat-app">
  <header class="chat-top">
    <div class="session-top chat-identity">
      <span class="run-state-badge" id="runStatus" data-status="${esc(identityStatus)}">${esc(identityStatus)}</span>
      <span class="session-source" style="--hue:${sourceColor(agent)}">${esc(agent)}</span>
      <span class="session-id" id="chatSessionId" title="run ${esc(id)}">${esc(id)}</span>
      <span class="session-model" id="chatModel" hidden></span>
      <span class="session-project" title="${esc(cwd)}">${esc(cwd.split("/").filter(Boolean).pop() || cwd || "cwd")}</span>
      <span class="session-grade-badge run-grade" id="runGrade" hidden></span>${resumedFrom ? `
      <a class="run-continued-from" id="continuedFrom" href="/view?id=${encodeURIComponent(resumedFrom)}" title="This run continues session ${esc(resumedFrom)} — open the original recording">&#8635;&#xFE0E; continued from ${esc(resumedFrom)}</a>` : ""}
      <span class="chat-top-spacer"></span>
      <span class="run-started" data-started="${esc(startedAt)}">started ${esc(startedAt)}</span>
    </div>
    <div class="chat-top-actions">
      ${ANALYTICS_TOGGLE_HTML}
      <a class="run-back" href="/sessions">&larr; sessions</a>
    </div>
    <div class="session-stats chat-head-stats" id="chatStats" hidden></div>
  </header>
  <div class="chat-body">
  <div class="chat-main">
${CHAT_FIND_BAR_HTML}
  <div class="chat-history" id="chatHistory" hidden>
    <div class="chat-col" id="chatHistoryCol"></div>
  </div>
  <div class="chat-scroll" id="chatScroll">
    <div class="chat-col">
      <div class="chat-thread" id="chatThread"></div>
      <div class="chat-activity" id="chatActivity">${CHAT_LOADING_HTML}</div>
      <div class="run-banner" id="runBanner" hidden></div>
      <details class="chat-terminal" id="terminalDetails">
        <summary>raw terminal</summary>
        <div class="run-terminal" id="runTerminal" data-status="${exited ? "exited" : "running"}">
          <pre class="run-screen" id="runScreen"></pre>
        </div>
      </details>
    </div>
  </div>
  <footer class="chat-composer">
    <div class="chat-composer-inner">
      <div class="composer-queue" id="composerQueue" hidden>
        <button class="queue-head" id="queueHead" type="button" aria-expanded="true" aria-controls="queueList" title="Follow-ups held by this page &mdash; there is no server-side queue: each one is typed into the agent's terminal, in order, when the agent finishes its current step">
          <svg class="caret" width="9" height="9" viewBox="0 0 16 16" fill="none"><path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span id="queueCount">0 in queue</span>
        </button>
        <div class="queue-list" id="queueList"></div>
        <div class="queue-note" id="queueNote" hidden></div>
      </div>
      <div class="composer-status" id="composerStatus" data-state="${composerState}">
        <span class="status-dot"></span>
        <span class="status-text" id="statusText">${composerText}</span><span class="status-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>
        <span class="status-spacer"></span>
        <button class="status-btn" id="stopBtn" type="button" title="Interrupt the current task; the run stays attached"${generating ? "" : " hidden"}>Stop</button>
        <button class="status-btn danger" id="killBtn" type="button" title="End the run — kills its tmux window; the transcript is preserved"${exited ? " hidden" : ""}>Kill run</button>
      </div>
      <form class="composer-card" id="inputRow" data-empty="true"${exited ? " hidden" : ""}>
        <div class="composer-context">
          <button class="ctx-at" id="ctxAtBtn" type="button" title="Reference a file — inserts @ so you can type a path in your follow-up">@</button>
          <span class="ctx-chip" title="${esc(cwd)}">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none"><path d="M1.5 3.5h4.2l1.6 2h7.2v7h-13z" stroke="currentColor" stroke-linejoin="round"/></svg>
            ${esc(cwd.split("/").filter(Boolean).pop() || cwd || "cwd")}
          </span>
          <span class="ctx-chip ctx-continue" id="ctxContinueChip" title="The agent exited, but the conversation is not over: follow-ups continue it as a NEW tracequest run — ${esc(agent)} forks the recorded session in a fresh tmux window; this transcript stays untouched" hidden>&#8635;&#xFE0E; continues as a new run</span>
        </div>
        <input class="run-input" id="inputText" type="text" placeholder="Send a follow-up" autocomplete="off" spellcheck="false">
        <div class="continue-cwd" id="continueCwdRow" hidden>
          <span class="continue-cwd-label">directory</span>
          <input class="continue-cwd-input" id="continueCwdInput" type="text" placeholder="/path/to/project" autocomplete="off" spellcheck="false" aria-label="Directory for the continued run">
        </div>
        <div class="composer-row">
          <div class="chip-wrap">
            <button class="chip-btn mode-chip" id="agentChip" type="button" title="Run details — agent, model, directory, recording" aria-haspopup="true" aria-expanded="false" aria-controls="runMenu">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M4.4 5.4c-1.8 0-2.9 1.1-2.9 2.6s1.1 2.6 2.9 2.6c2.6 0 4.6-5.2 7.2-5.2 1.8 0 2.9 1.1 2.9 2.6s-1.1 2.6-2.9 2.6c-2.6 0-4.6-5.2-7.2-5.2z" stroke="currentColor" stroke-width="1.2"/></svg>
              ${esc(agent)}
              <span class="chip-kbd" id="agentChipKbd">&#8984;I</span>
              <svg class="caret" width="9" height="9" viewBox="0 0 16 16" fill="none"><path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <button class="chip-btn model-chip" id="modelChip" type="button" title="Model reported by the session recording — run details" aria-haspopup="true" aria-expanded="false" aria-controls="runMenu" hidden>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="4" y="4" width="8" height="8" rx="1.5" stroke="currentColor"/><rect x="6.5" y="6.5" width="3" height="3" rx="0.5" stroke="currentColor"/><path d="M6 1.5v2M10 1.5v2M6 12.5v2M10 12.5v2M1.5 6h2M1.5 10h2M12.5 6h2M12.5 10h2" stroke="currentColor" stroke-linecap="round"/></svg>
            <span class="model-name" id="modelName"></span>
            <svg class="caret" width="9" height="9" viewBox="0 0 16 16" fill="none"><path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <span class="composer-spacer"></span>
          <div class="keys-wrap">
            <button class="chip-btn keys-btn" id="keysBtn" type="button" title="Send a special key to the agent's terminal" aria-haspopup="true" aria-expanded="false" aria-controls="keysMenu">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="4" width="13" height="8.5" rx="1.6" stroke="currentColor"/><path d="M4 6.6h.01M6.6 6.6h.01M9.2 6.6h.01M11.8 6.6h.01M4 9h.01M11.8 9h.01M5.8 10.4h4.4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>
              Send key
              <svg class="caret" width="9" height="9" viewBox="0 0 16 16" fill="none"><path d="M3.5 6 8 10.5 12.5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
          <button class="run-send-btn" id="sendBtn" type="submit" aria-label="Send" title="Send (Enter) — an empty submit sends a bare Enter keypress">
            <svg class="icon-send" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg class="icon-stop" width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>
          </button>
        </div>
      </form>
      <div class="run-input-error" id="inputError" role="alert" hidden></div>
    </div>
  </footer>
  </div>
  <aside class="chat-output-pane" id="chatOutputPane" hidden></aside>
  </div>
    </main>
    ${ANALYTICS_PANEL_HTML}
  </div>
</div>
${LAUNCHER_MODAL_HTML}
${COMMAND_PALETTE_HTML}
<div class="keys-overlay" id="keysOverlay" hidden>
  <div class="keys-menu" id="keysMenu" role="dialog" aria-modal="true" aria-labelledby="keysMenuTitle" hidden tabindex="-1">
    <div class="keys-title" id="keysMenuTitle">Send key</div>
    <button class="run-key-btn" type="button" data-key="Enter">Enter <span class="kbd">&crarr;</span></button>
    <button class="run-key-btn" type="button" data-key="Escape">Escape <span class="kbd">esc</span></button>
    <button class="run-key-btn" type="button" data-key="C-c">Interrupt <span class="kbd">^C</span></button>
    <button class="run-key-btn" type="button" data-key="Up">Arrow up <span class="kbd">&uarr;</span></button>
    <button class="run-key-btn" type="button" data-key="Down">Arrow down <span class="kbd">&darr;</span></button>
    <button class="run-key-btn" type="button" data-key="Tab">Tab <span class="kbd">&#8677;</span></button>
  </div>
</div>
<div class="run-overlay" id="runOverlay" hidden>
  <div class="run-menu" id="runMenu" role="dialog" aria-modal="true" aria-labelledby="runMenuTitle" hidden tabindex="-1">
    <div class="keys-title" id="runMenuTitle">This run</div>
    <div class="run-menu-grid">
      <span class="rm-k">Agent</span><span class="rm-v">${esc(agent)}</span>
      <span class="rm-k">Model</span><span class="rm-v" id="menuModel">detecting&hellip;</span>
      <span class="rm-k">Run</span><span class="rm-v mono">${esc(id)} &middot; tmux window</span>
      <span class="rm-k">Directory</span><span class="rm-v mono">${esc(cwd)}</span>
      <span class="rm-k">Recording</span><span class="rm-v" id="menuRecording">not linked yet</span>
    </div>
    <div class="run-menu-note">Agent &amp; model are fixed at launch &mdash; steer the run with follow-ups and keys. Stop interrupts the current task; Kill run ends its tmux window. The transcript is preserved either way.</div>
  </div>
</div>
<script>
${shellClientScript({ current: { type: "run", id }, defaultCwd: cwd || "" })}
</script>
<script>
(function () {
  ${OVERLAY_FOCUS_SRC}
  var runId = ${JSON.stringify(id)};
  var runCwd = ${JSON.stringify(cwd || "")};
  var canResume = ${JSON.stringify(canResume)};
  var resumedFromHash = ${JSON.stringify(resumedFrom)};
  var runPromptSnippet = ${JSON.stringify(run.prompt || null)};
  var runStartedMs = Date.parse(${JSON.stringify(startedAt || "")});
  var RUN_UNLINKED_RUNNING_MS = ${RUN_UNLINKED_RUNNING_MS};
  /* A pane that has linked no recording RUN_UNLINKED_RUNNING_MS after it
     started is idle, not starting up: the rule GET /api/runs applies (fact
     hlorph), applied here to the run's own polls, which report such a pane
     as running. */
  var runLinked = ${JSON.stringify(Boolean(run.sessionPath))};
  function unlinkedIdle(linked) {
    return !linked && Number.isFinite(runStartedMs) && Date.now() - runStartedMs > RUN_UNLINKED_RUNNING_MS;
  }
  var POLL_MS = ${RUN_POLL_MS};
  var SESSION_POLL_MS = ${SESSION_POLL_MS};
  var screen = document.getElementById("runScreen");
  var terminal = document.getElementById("runTerminal");
  var statusEl = document.getElementById("runStatus");
  var banner = document.getElementById("runBanner");
  var killBtn = document.getElementById("killBtn");
  var stopBtn = document.getElementById("stopBtn");
  var ctxContinueChip = document.getElementById("ctxContinueChip");
  var continueCwdRow = document.getElementById("continueCwdRow");
  var continueCwdInput = document.getElementById("continueCwdInput");
  var sendBtn = document.getElementById("sendBtn");
  var composerStatus = document.getElementById("composerStatus");
  var statusText = document.getElementById("statusText");
  var keysBtn = document.getElementById("keysBtn");
  var keysMenu = document.getElementById("keysMenu");
  var keysOverlay = document.getElementById("keysOverlay");
  var agentChip = document.getElementById("agentChip");
  var agentChipKbd = document.getElementById("agentChipKbd");
  var modelChip = document.getElementById("modelChip");
  var modelName = document.getElementById("modelName");
  var runMenu = document.getElementById("runMenu");
  var runOverlay = document.getElementById("runOverlay");
  var menuModel = document.getElementById("menuModel");
  var menuRecording = document.getElementById("menuRecording");
  var inputRow = document.getElementById("inputRow");
  var inputText = document.getElementById("inputText");
  var ctxAtBtn = document.getElementById("ctxAtBtn");
  var inputError = document.getElementById("inputError");
  var viewSessionLink = document.getElementById("viewSessionLink");
  var chatScroll = document.getElementById("chatScroll");
  var chatThread = document.getElementById("chatThread");
  var chatActivity = document.getElementById("chatActivity");
  var composerQueue = document.getElementById("composerQueue");
  var queueHead = document.getElementById("queueHead");
  var queueCount = document.getElementById("queueCount");
  var queueList = document.getElementById("queueList");
  var queueNote = document.getElementById("queueNote");
  var timer = null;
  var sessTimer = null;
  var stopped = false;      // page-wide stop (gone/killed)
  var snapStopped = false;  // terminal snapshot loop stopped (exited)
  var sessStopped = false;  // session loop stopped
  var sessFinalDone = false;
  var lastEtag = null;
  var lastSession = null;
  var lastSessionPath = null;
  var lastState = ${JSON.stringify(chatState)};
  var lastBlocks = [];
  var lastThreadHtml = "";
  var lastActivityHtml = null;
  var continueMode = false;
  var continueBusy = false;
  var lastGrowthAt = Date.now(); // last poll where the recording actually grew
  var QUIET_MS = 4000;           // recording quiet this long + complete turn => ready

  /* A resumed run's follow-up, shown as an honest pending bubble until the
     fork recording links and the transcript carries the message for real.
     Full text comes from the continuing page via sessionStorage; the
     server-persisted tq_prompt snippet is the reload-safe fallback. */
  var followupText = null;
  if (resumedFromHash) {
    try { followupText = sessionStorage.getItem("tq-followup:" + runId); } catch (e) {}
    if (!followupText) followupText = runPromptSnippet;
  }
  function followupDelivered() {
    if (!followupText) return true;
    var m = followupText;
    if (m.slice(-1) === "\\u2026") m = m.slice(0, -1); // snippet truncation
    if (!m) return true;
    for (var i = 0; i < lastBlocks.length; i++) {
      if (lastBlocks[i].kind === "user" && String(lastBlocks[i].text || "").indexOf(m) !== -1) {
        try { sessionStorage.removeItem("tq-followup:" + runId); } catch (e) {}
        return true;
      }
    }
    return false;
  }

${CHAT_TRANSCRIPT_JS}
  function pendingFollowupHtml(sub) {
    var html = "";
    if (followupText) html += '<div class="chat-user chat-user-pending" id="pendingFollowup">' + escHtml(followupText) + "</div>";
    html += '<div class="chat-marker"><span class="shimmer">' +
      (followupText ? "Delivering your follow-up" : "Continuing the conversation") + "</span></div>";
    if (sub) html += '<div class="chat-activity-sub">' + sub + "</div>";
    return html;
  }
  function activityHtml() {
    if (stopped) return "";
    if (lastState === "exited") return markerHtml("Agent exited", "transcript preserved");
    if (lastState === "pending") {
      if (resumedFromHash) {
        return pendingFollowupHtml("continuing session " + escHtml(resumedFromHash) + " \\u2014 waiting for the fork recording to link");
      }
      return '<div class="chat-marker"><span class="shimmer">Waiting for the agent session</span></div>' +
        '<div class="chat-activity-sub">run launched \\u2014 no session recording linked yet</div>';
    }
    if (lastState === "idle") return markerHtml("Not running", "transcript preserved");
    if (resumedFromHash && followupText && !followupDelivered()) {
      // Linked (prior context visible) but the follow-up has not landed in
      // the recording yet — keep the pending bubble honest.
      return pendingFollowupHtml(null);
    }
    var last = lastBlocks.length ? lastBlocks[lastBlocks.length - 1] : null;
    var label = !last || last.kind === "user" ? "Thinking" : "Planning next moves";
    return '<div class="chat-marker"><span class="shimmer">' + label + "</span></div>";
  }

  /* ================= lifecycle ================= */

  function setPollingFlag(on) {
    document.body.setAttribute("data-polling", on ? "1" : "0");
  }
  function setChatPollingFlag(on) {
    document.body.setAttribute("data-chat-polling", on ? "1" : "0");
  }
  function pollGeneratingStatus(data) {
    var word = data && (data.status || data.state || (data.run && data.run.status));
    if (word === "live" || word === "pending") word = "running";
    return word;
  }
  function setStatus(status) {
    if (status === "running" || status === "idle") {
      terminal.setAttribute("data-status", "running");
      statusEl.textContent = status;
      statusEl.setAttribute("data-status", status);
      return;
    }
    statusEl.textContent = status;
    statusEl.setAttribute("data-status", status);
    if (status === "exited" || status === "gone") terminal.setAttribute("data-status", status);
  }
  /** Composer status strip: generating keeps Stop, attached keeps Kill, exited/gone retire them. */
  function setComposerState(state, text) {
    composerStatus.setAttribute("data-state", state);
    statusText.textContent = text;
    var generating = state === "running";
    var attached = state === "running" || state === "idle";
    stopBtn.hidden = !generating;
    killBtn.hidden = !attached;
    if (!attached) {
      closeKeysMenu();
      closeRunMenu();
    }
  }
  function showBanner(kind, text) {
    banner.textContent = text;
    banner.setAttribute("data-kind", kind);
    banner.hidden = false;
  }
  function stopSnapshotLoop() {
    snapStopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    setPollingFlag(false);
  }
  function stopSessionLoop() {
    sessStopped = true;
    if (sessTimer) { clearTimeout(sessTimer); sessTimer = null; }
    setChatPollingFlag(false);
  }
  function stopPolling() {
    stopped = true;
    stopSnapshotLoop();
    stopSessionLoop();
  }
  /**
   * Continue composer: a finished (exited or killed) run whose recording is
   * linked keeps a LIVE composer — the same input card, re-armed so typing
   * IS the continue (submit forks the recorded session into a NEW run with
   * the follow-up delivered; empty submit continues without a message).
   * Only agents with a verified resume mechanism get it (canResume) —
   * honest absence otherwise: the composer retires with the run.
   */
  function runDone() {
    return lastState === "exited" || lastState === "gone" ||
      statusEl.getAttribute("data-status") === "exited" ||
      statusEl.getAttribute("data-status") === "gone";
  }
  function updateContinueComposer() {
    var offer = canResume && !!lastSessionPath && runDone();
    continueMode = offer;
    if (offer) {
      inputRow.hidden = false;
      inputRow.setAttribute("data-mode", "continue");
      ctxContinueChip.hidden = false;
      inputText.placeholder = "Send a follow-up \\u2014 continues in a new run";
      sendBtn.title = "Continue (Enter) \\u2014 sends your follow-up into a new run; an empty submit continues without a message";
      sendBtn.setAttribute("aria-label", "Send follow-up \\u2014 continues as a new run");
      if (statusText.textContent.indexOf("follow-ups continue") === -1) {
        statusText.textContent += " \\u2014 follow-ups continue in a new run";
      }
    } else {
      inputRow.removeAttribute("data-mode");
      ctxContinueChip.hidden = true;
      continueCwdRow.hidden = true;
      if (runDone()) inputRow.hidden = true;
    }
  }
  function markExited() {
    setStatus("exited");
    showBanner("exited", "exited — final output preserved");
    setComposerState("exited", "Agent exited");
    killBtn.hidden = true;
    inputRow.hidden = true;
    lastState = "exited";
    rerender();
    stopSnapshotLoop();
    updateContinueComposer();
    syncRunFeedback();
  }
  function markGone(message) {
    // Never overwrite an existing gone reason: after a kill flips the page
    // to "run killed", a late 404 poll must not repaint the generic banner.
    if (!banner.hidden && banner.getAttribute("data-kind") === "gone") return;
    setStatus("gone");
    showBanner("gone", message || "run is gone — its window no longer exists");
    setComposerState("gone", message || "Run gone — its window no longer exists");
    killBtn.hidden = true;
    inputRow.hidden = true;
    stopPolling();
    rerender();
    updateContinueComposer();
    syncRunFeedback();
  }

  /* ---- terminal snapshot loop (~600ms) ---- */
  function schedule() {
    if (stopped || snapStopped) return;
    if (document.hidden) { setPollingFlag(false); return; }
    setPollingFlag(true);
    timer = setTimeout(poll, POLL_MS);
  }
  async function poll() {
    timer = null;
    if (stopped || snapStopped) return;
    try {
      var res = await fetch("/api/runs/snapshot?id=" + encodeURIComponent(runId));
      // Re-check after EVERY await: a kill can stop the page while this
      // poll was in flight, and a resolved late poll must not repaint the
      // pre-kill screen or flip the status back to running.
      if (stopped || snapStopped) return;
      if (res.status === 404) { markGone(); return; }
      if (res.ok) {
        var data = await res.json();
        if (stopped || snapStopped) return;
        screen.innerHTML = data.html;
        if (data.status === "exited") { markExited(); return; }
        if (data.status === "running" && unlinkedIdle(runLinked)) data.status = "idle";
        setStatus(data.status === "idle" ? "idle" : "running");
      }
    } catch (e) {
      // transient network error — keep polling
    }
    schedule();
  }

  /* ---- session loop (~1s, etag flow) ---- */
  function scheduleSession() {
    if (stopped || sessStopped) return;
    if (document.hidden) { setChatPollingFlag(false); return; }
    setChatPollingFlag(true);
    sessTimer = setTimeout(pollSession, SESSION_POLL_MS);
  }
  function applySession(data) {
    var word = pollGeneratingStatus(data);
    runLinked = data.link !== "pending";
    if (word === "running" && unlinkedIdle(runLinked)) word = "idle";
    if (word === "running") followTail = followTail || isAtBottom();
    lastState = data.link === "pending" && word === "running"
      ? "pending"
      : word;
    if (!stopped && word !== "exited") {
      if (word === "running") {
        setComposerState("running", "Running");
        setStatus("running");
      } else if (word === "idle") {
        setComposerState("idle", "Idle");
        setStatus("idle");
      }
    }
    if (data.sessionPath) {
      lastSessionPath = data.sessionPath;
      // Cross-link: the run's recording is a normal session — /view shows it.
      var viewHref = "/view?path=" + encodeURIComponent(data.sessionPath) +
        "&from=" + encodeURIComponent("/run?id=" + runId);
      viewSessionLink.href = viewHref;
      var recLink = menuRecording.querySelector("a");
      if (!recLink) {
        recLink = document.createElement("a");
        recLink.textContent = "view session";
        menuRecording.textContent = "";
        menuRecording.appendChild(recLink);
      }
      recLink.href = viewHref;
      if (typeof window._tqAnalyticsSetView === "function") window._tqAnalyticsSetView(viewHref, runId);
    }
    if (data.link === "pending") {
      lastSession = null;
      lastEtag = null;
    } else if (!data.unchanged && data.session) {
      lastSession = data.session;
      lastEtag = data.etag;
      lastGrowthAt = Date.now(); // the recording actually grew this poll
    }
    if (lastSession && lastSession.model) setModel(lastSession.model);
    rerender();
    updateContinueComposer();
    syncRunFeedback();
  }
  async function pollSession() {
    sessTimer = null;
    if (stopped || sessStopped) return;
    try {
      var url = "/api/runs/session?id=" + encodeURIComponent(runId);
      if (lastEtag) url += "&etag=" + encodeURIComponent(lastEtag);
      var res = await fetch(url);
      if (stopped || sessStopped) return;
      if (res.status === 404) { markGone(); return; }
      if (res.ok) {
        var data = await res.json();
        if (stopped || sessStopped) return;
        applySession(data);
        if (pollGeneratingStatus(data) === "exited") {
          // One delayed final poll catches a recording flushed at exit,
          // then the chat loop stops for good.
          if (sessFinalDone) { stopSessionLoop(); return; }
          sessFinalDone = true;
          setChatPollingFlag(true);
          sessTimer = setTimeout(pollSession, 800);
          return;
        }
      }
    } catch (e) {
      // transient network error — keep polling
    }
    scheduleSession();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (timer) { clearTimeout(timer); timer = null; }
      if (sessTimer) { clearTimeout(sessTimer); sessTimer = null; }
      setPollingFlag(false);
      setChatPollingFlag(false);
    } else {
      if (!stopped && !snapStopped && !timer) poll();
      if (!stopped && !sessStopped && !sessTimer) pollSession();
    }
  });

  /* ================= composer ================= */
  var keysPrevFocus = null;
  var runPrevFocus = null;
  function placeAnchoredMenu(menu, anchor, align) {
    if (!menu || !anchor || typeof anchor.getBoundingClientRect !== "function") return;
    var r = anchor.getBoundingClientRect();
    var mh = menu.offsetHeight || 0;
    var mw = menu.offsetWidth || 0;
    var vw = (typeof window !== "undefined" && window.innerWidth) || 0;
    var vh = (typeof window !== "undefined" && window.innerHeight) || 0;
    var gap = 6;
    var top = r.top - mh - gap;
    if (top < 8) {
      top = r.bottom + gap;
      if (vh && top + mh > vh - 8) top = Math.max(8, vh - mh - 8);
    }
    menu.style.position = "fixed";
    menu.style.bottom = "auto";
    menu.style.top = Math.round(top) + "px";
    if (align === "right") {
      menu.style.left = "auto";
      menu.style.right = Math.round(vw ? Math.max(8, vw - r.right) : 8) + "px";
    } else {
      var left = Math.max(8, r.left);
      if (vw && left + mw > vw - 8) left = Math.max(8, vw - mw - 8);
      menu.style.right = "auto";
      menu.style.left = Math.round(left) + "px";
    }
  }
  function openKeysMenu() {
    closeRunMenu();
    if (keysMenu.hidden) {
      keysPrevFocus = overlayPrevFocus(keysMenu);
      if (!keysPrevFocus) keysPrevFocus = document.activeElement;
    }
    if (keysOverlay) keysOverlay.hidden = false;
    keysMenu.hidden = false;
    keysBtn.setAttribute("aria-expanded", "true");
    placeAnchoredMenu(keysMenu, keysBtn, "right");
    pushOverlay(keysMenu);
    focusOverlay(keysMenu, keysMenu.querySelector(".run-key-btn"));
  }
  function closeKeysMenu() {
    if (keysMenu.hidden) return;
    keysMenu.hidden = true;
    if (keysOverlay) keysOverlay.hidden = true;
    keysBtn.setAttribute("aria-expanded", "false");
    popOverlay(keysMenu);
    restoreOverlayFocus(keysPrevFocus, keysMenu);
    keysPrevFocus = null;
  }
  function openRunMenu() {
    closeKeysMenu();
    if (runMenu.hidden) {
      runPrevFocus = overlayPrevFocus(runMenu);
      if (!runPrevFocus) runPrevFocus = document.activeElement;
    }
    if (runOverlay) runOverlay.hidden = false;
    runMenu.hidden = false;
    agentChip.setAttribute("aria-expanded", "true");
    modelChip.setAttribute("aria-expanded", "true");
    placeAnchoredMenu(runMenu, agentChip, "left");
    pushOverlay(runMenu);
    focusOverlay(runMenu, runMenu);
  }
  function closeRunMenu() {
    if (runMenu.hidden) return;
    runMenu.hidden = true;
    if (runOverlay) runOverlay.hidden = true;
    agentChip.setAttribute("aria-expanded", "false");
    modelChip.setAttribute("aria-expanded", "false");
    popOverlay(runMenu);
    restoreOverlayFocus(runPrevFocus, runMenu);
    runPrevFocus = null;
  }
  function toggleRunMenu() {
    if (runMenu.hidden) openRunMenu();
    else closeRunMenu();
  }
  keysBtn.addEventListener("click", function (event) {
    event.stopPropagation();
    if (keysMenu.hidden) openKeysMenu();
    else closeKeysMenu();
  });
  agentChip.addEventListener("click", function (event) {
    event.stopPropagation();
    toggleRunMenu();
  });
  modelChip.addEventListener("click", function (event) {
    event.stopPropagation();
    toggleRunMenu();
  });
  if (keysOverlay) {
    keysOverlay.addEventListener("click", function (event) {
      if (event.target === keysOverlay) closeKeysMenu();
    });
  }
  if (runOverlay) {
    runOverlay.addEventListener("click", function (event) {
      if (event.target === runOverlay) closeRunMenu();
    });
  }
  document.addEventListener("click", function (event) {
    var t = event.target;
    var within = t && t.closest ? t.closest(".keys-wrap, .chip-wrap, .model-chip, .keys-overlay, .run-overlay") : null;
    if (within) return;
    closeKeysMenu();
    closeRunMenu();
  });
  document.addEventListener("keydown", function (event) {
    if (!keysMenu.hidden || !runMenu.hidden) {
      var menuRoot = keysMenu.hidden ? runMenu : keysMenu;
      if (isTopOverlay(menuRoot)) {
        if (event.key === "Tab") {
          trapOverlayTab(event, menuRoot);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          if (!keysMenu.hidden) closeKeysMenu();
          if (!runMenu.hidden) closeRunMenu();
          return;
        }
      }
    }
    // The agent chip's visible shortcut: Cmd/Ctrl-I toggles run details.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.key === "i" || event.key === "I")) {
      if (inputRow.hidden) return;
      event.preventDefault();
      toggleRunMenu();
    }
  }, true);
  // Honest shortcut label: the mac glyph only where it means something.
  if (!/Mac|iPhone|iPad/.test(navigator.platform || "")) agentChipKbd.textContent = "Ctrl+I";
  /** Model chip: fed by the live session recording, never a guess. */
  function shortModel(m) {
    return String(m).replace("claude-", "").replace(/-\\d{8}$/, "");
  }
  function setModel(model) {
    if (!model) return;
    modelName.textContent = shortModel(model);
    menuModel.textContent = model;
    modelChip.hidden = false;
  }
  function syncEmpty() {
    inputRow.setAttribute("data-empty", inputText.value.length ? "false" : "true");
    // keystrokes flip the send affordance (queue-send vs stop) live
    syncRunFeedback();
  }
  inputText.addEventListener("input", syncEmpty);
  // The @ affordance is a real control: it starts a file reference in the
  // follow-up (agents resolve @path mentions themselves) and hands focus
  // to the input, rather than sitting as a decorative circle.
  ctxAtBtn.addEventListener("click", function () {
    var v = inputText.value;
    inputText.value = v + (v.length && !/\\s$/.test(v) ? " @" : "@");
    syncEmpty();
    inputText.focus();
    inputText.setSelectionRange(inputText.value.length, inputText.value.length);
  });
  function showInputError(message) {
    inputError.textContent = message;
    inputError.hidden = false;
  }
  function clearInputError() {
    inputError.hidden = true;
    inputError.textContent = "";
  }
  async function readError(res) {
    try {
      var data = await res.json();
      if (data && data.error) return data.error;
    } catch (e) {}
    return "HTTP " + res.status;
  }
  async function sendInput(payload) {
    clearInputError();
    try {
      var res = await fetch("/api/runs/input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ id: runId }, payload)),
      });
      if (!res.ok) { showInputError(await readError(res)); return false; }
      return true;
    } catch (e) {
      showInputError(String(e));
      return false;
    }
  }

  /* ================= in-composer run feedback =================
   * The strip renders the run INSIDE the composer: a live activity line
   * derived client-side from the SAME polled unified session the
   * transcript renders (never invented), a state-aware send button, and a
   * client-held queue of follow-ups typed mid-generation. Honesty rules:
   * tracequest delivers input via tmux send-keys — there is NO server-side
   * queue, so the queue lives on THIS page, visible, editable, cancelable,
   * and delivered in order only when the agent looks ready. */
  function actBasename(p) {
    var parts = String(p).split("/");
    return parts[parts.length - 1] || String(p);
  }
  /** Client port of the server's describeToolCall (route-handlers-launch). */
  function describeAction(tc) {
    var input = String(tc.input || "").trim();
    switch (tc.name) {
      case "Bash": {
        var cmd = input.split("\\n")[0].trim();
        return cmd ? "Running " + cmd : "Running a command";
      }
      case "Edit": return input ? "Editing " + actBasename(input) : "Editing a file";
      case "Write": return input ? "Writing " + actBasename(input) : "Writing a file";
      case "Read": return input ? "Reading " + actBasename(input) : "Reading a file";
      case "Grep":
      case "Glob": return input ? "Searching " + input : "Searching the codebase";
      default: return "Running " + tc.name;
    }
  }
  function actSnippet(s) {
    s = String(s).split("\\n")[0];
    return s.length > 64 ? s.slice(0, 63) + "\\u2026" : s;
  }
  /**
   * What the agent is doing NOW: an unresolved tool call in the newest
   * assistant turn is that in-progress action; a session whose last event
   * is a user message or tool result — or whose recording grew within the
   * quiet window — is generating; a quiet, complete-looking turn reads as
   * ready. Null while no linked live session (pending keeps plain copy).
   */
  function runActivity() {
    if (lastState !== "running" || !lastSession) return null;
    var events = lastSession.events || [];
    if (!events.length) return { busy: true, label: "Generating" };
    var resolved = {};
    var i;
    for (i = 0; i < events.length; i++) {
      var ev = events[i];
      if (ev.type === "tool_result" && ev.toolUseId) resolved[ev.toolUseId] = true;
    }
    for (i = events.length - 1; i >= 0; i--) {
      var e = events[i];
      if (e.type === "assistant") {
        var calls = e.toolCalls || [];
        for (var j = calls.length - 1; j >= 0; j--) {
          if (calls[j].id && !resolved[calls[j].id]) {
            return { busy: true, label: actSnippet(describeAction(calls[j])) };
          }
        }
        break;
      }
      if (e.type === "user") break;
    }
    var last = events[events.length - 1];
    if (last.type === "user" || last.type === "tool_result") return { busy: true, label: "Generating" };
    if (Date.now() - lastGrowthAt < QUIET_MS) return { busy: true, label: "Generating" };
    return { busy: false, label: "Running" };
  }
  function agentBusyNow() {
    var act = runActivity();
    return Boolean(act && act.busy);
  }
  /** Sync the strip text, data-busy flags, placeholder, and send affordance. */
  function syncRunFeedback() {
    if (stopped || continueMode || runDone()) {
      composerStatus.removeAttribute("data-busy");
      inputRow.removeAttribute("data-busy");
      renderQueue();
      return;
    }
    var act = runActivity();
    var busy = Boolean(act && act.busy);
    composerStatus.setAttribute("data-busy", busy ? "true" : "false");
    inputRow.setAttribute("data-busy", busy ? "true" : "false");
    if (composerStatus.getAttribute("data-state") === "running") {
      var label = act ? act.label : "Running";
      if (statusText.textContent !== label) statusText.textContent = label;
    }
    if (busy) {
      inputText.placeholder = "Queue a follow-up \\u2014 sends when the agent is ready";
      if (inputText.value.length) {
        sendBtn.title = "Queue follow-up (Enter) \\u2014 held on this page, typed into the agent's terminal in order when it finishes its current step";
        sendBtn.setAttribute("aria-label", "Queue follow-up");
      } else {
        sendBtn.title = "Stop generating \\u2014 interrupts the current task (Enter in the input still sends a bare Enter)";
        sendBtn.setAttribute("aria-label", "Stop generating");
      }
    } else {
      inputText.placeholder = "Send a follow-up";
      sendBtn.title = "Send (Enter) \\u2014 an empty submit sends a bare Enter keypress";
      sendBtn.setAttribute("aria-label", "Send");
    }
    maybeDeliver();
  }

  /* ---- client-held follow-up queue ---- */
  var queue = [];
  var queueSeq = 0;
  var queueDelivering = false;
  var lastDeliveryAt = 0;
  var QUEUE_KEY = "tq-queue:" + runId;
  try {
    var savedQueue = JSON.parse(sessionStorage.getItem(QUEUE_KEY) || "[]");
    for (var sq = 0; sq < savedQueue.length; sq++) {
      if (typeof savedQueue[sq] === "string" && savedQueue[sq]) queue.push({ id: ++queueSeq, text: savedQueue[sq] });
    }
  } catch (e) {}
  function persistQueue() {
    try {
      if (queue.length) {
        sessionStorage.setItem(QUEUE_KEY, JSON.stringify(queue.map(function (q) { return q.text; })));
      } else {
        sessionStorage.removeItem(QUEUE_KEY);
      }
    } catch (e) {}
  }
  function renderQueue() {
    composerQueue.hidden = !queue.length;
    queueCount.textContent = queue.length + " in queue";
    var html = "";
    for (var i = 0; i < queue.length; i++) {
      var q = queue[i];
      html += '<div class="queue-item" data-qid="' + q.id + '"' + (q.sending ? ' data-sending="true"' : "") + '>' +
        '<span class="queue-ring"></span>' +
        '<button class="queue-text" type="button" title="Edit \\u2014 moves this follow-up back into the input">' + escHtml(q.text) + "</button>" +
        '<button class="queue-act queue-send-now" type="button" title="Send now \\u2014 type it into the agent\\u2019s terminal immediately">\\u2191 send now</button>' +
        '<button class="queue-act queue-x" type="button" title="Remove from queue" aria-label="Remove from queue">\\u00d7</button>' +
        "</div>";
    }
    if (queueList.innerHTML !== html) queueList.innerHTML = html;
    var ended = runDone() && queue.length > 0;
    queueNote.hidden = !ended;
    if (ended) {
      queueNote.textContent = "The run ended before these were sent \\u2014 nothing was delivered. Click one to edit it" +
        (canResume ? " \\u2014 sending continues the conversation as a new run." : ".");
    }
    persistQueue();
  }
  function enqueue(text) {
    queue.push({ id: ++queueSeq, text: text });
    renderQueue();
    syncRunFeedback();
  }
  function removeFromQueue(qid) {
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id === qid) { queue.splice(i, 1); break; }
    }
    renderQueue();
    syncRunFeedback();
  }
  async function deliverItem(q) {
    if (queueDelivering || q.sending) return;
    queueDelivering = true;
    q.sending = true;
    renderQueue();
    var ok = await sendInput({ text: q.text, key: "Enter" });
    queueDelivering = false;
    lastDeliveryAt = Date.now();
    if (ok) {
      removeFromQueue(q.id);
    } else {
      q.sending = false;
      renderQueue();
    }
  }
  /**
   * In-order auto-delivery: only while the run is LIVE and the agent looks
   * ready, one item in flight at a time — and the previous delivery must
   * show up in the recording (poll growth) or 8s must pass first, so two
   * queued messages never race into the same turn.
   */
  function maybeDeliver() {
    if (!queue.length || queueDelivering || continueMode || stopped || runDone()) return;
    if (lastState !== "running" && lastState !== "idle") return;
    if (agentBusyNow()) return;
    if (lastDeliveryAt && lastGrowthAt <= lastDeliveryAt && Date.now() - lastDeliveryAt < 8000) return;
    deliverItem(queue[0]);
  }
  queueHead.addEventListener("click", function () {
    var open = queueHead.getAttribute("aria-expanded") !== "false";
    queueHead.setAttribute("aria-expanded", open ? "false" : "true");
    queueList.hidden = open;
  });
  queueList.addEventListener("click", function (ev) {
    var item = ev.target && ev.target.closest ? ev.target.closest(".queue-item") : null;
    if (!item) return;
    var qid = Number(item.getAttribute("data-qid"));
    var q = null;
    for (var i = 0; i < queue.length; i++) {
      if (queue[i].id === qid) q = queue[i];
    }
    if (!q || q.sending) return;
    if (ev.target.closest(".queue-x")) { removeFromQueue(qid); return; }
    if (ev.target.closest(".queue-send-now")) { deliverItem(q); return; }
    if (ev.target.closest(".queue-text")) {
      removeFromQueue(qid);
      inputText.value = q.text;
      syncEmpty();
      inputText.focus();
    }
  });
  // Held follow-ups exist only on this page — closing it would drop them.
  window.addEventListener("beforeunload", function (ev) {
    if (queue.length && !runDone() && !stopped) {
      ev.preventDefault();
      ev.returnValue = "";
    }
  });
  /**
   * Continue submit: typing IS the continue. POST /api/runs
   * {resumeSession, prompt} forks the recorded session into a NEW run and
   * lands there with the follow-up already delivered (the new page shows it
   * as a pending bubble until the fork recording links). A needs:"cwd" 400
   * (the source directory vanished) reveals an inline directory prompt and
   * the next submit retries with the explicit cwd.
   */
  async function continueSubmit() {
    if (!lastSessionPath || continueBusy) return;
    var text = inputText.value;
    var body = { resumeSession: lastSessionPath };
    if (text.length) body.prompt = text;
    if (!continueCwdRow.hidden && continueCwdInput.value) body.cwd = continueCwdInput.value;
    continueBusy = true;
    sendBtn.disabled = true;
    clearInputError();
    try {
      var res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (res.ok && data.id) {
        if (body.prompt) {
          try { sessionStorage.setItem("tq-followup:" + data.id, body.prompt); } catch (e) {}
        }
        window.location.href = "/run?id=" + encodeURIComponent(data.id);
        return;
      }
      if (data && data.needs === "cwd") {
        // Vanished-cwd recovery: the follow-up stays typed; pick a
        // directory inline and resubmit.
        continueCwdRow.hidden = false;
        if (!continueCwdInput.value) continueCwdInput.value = runCwd || "";
        showInputError((data && data.error) || "pick a directory for the new run");
        continueBusy = false;
        sendBtn.disabled = false;
        continueCwdInput.focus();
        return;
      }
      showInputError((data && data.error) || "continue failed");
      continueBusy = false;
      sendBtn.disabled = false;
    } catch (e) {
      showInputError(String(e));
      continueBusy = false;
      sendBtn.disabled = false;
    }
  }
  // send-morphs-to-stop: while the agent is generating and the input is
  // empty, the round button is a STOP control — the click interrupts (^C)
  // and never submits the form. (Enter in the empty input still submits a
  // bare Enter — the way TUI permission prompts get confirmed.)
  sendBtn.addEventListener("click", function (event) {
    if (continueMode || inputText.value.length) return;
    if (inputRow.getAttribute("data-busy") !== "true") return;
    // Enter in the empty INPUT arrives here as an implicit form submission
    // (a synthetic detail-0 click on the default button) — that keeps the
    // bare-Enter contract. Only really activating the BUTTON stops.
    if (event.detail === 0 && document.activeElement !== sendBtn) return;
    event.preventDefault();
    sendInput({ action: "stop" });
  });
  inputRow.addEventListener("submit", async function (event) {
    event.preventDefault();
    if (continueMode) { continueSubmit(); return; }
    var text = inputText.value;
    if (text.length && (agentBusyNow() || queue.length)) {
      // Mid-generation (or behind already-queued messages): the follow-up
      // is HELD on this page as a visible queue row — nothing is sent yet.
      enqueue(text);
      inputText.value = "";
      syncEmpty();
      inputText.focus();
      return;
    }
    var payload = text.length ? { text: text, key: "Enter" } : { key: "Enter" };
    var ok = await sendInput(payload);
    if (ok) { inputText.value = ""; syncEmpty(); }
    inputText.focus();
  });
  var keyButtons = keysMenu.querySelectorAll(".run-key-btn");
  for (var i = 0; i < keyButtons.length; i++) {
    (function (btn) {
      btn.addEventListener("click", async function () {
        closeKeysMenu();
        await sendInput({ key: btn.getAttribute("data-key") });
        inputText.focus();
      });
    })(keyButtons[i]);
  }
  stopBtn.addEventListener("click", async function () {
    // Stop uses the agent's interrupt action; raw keys remain separate.
    stopBtn.disabled = true;
    await sendInput({ action: "stop" });
    stopBtn.disabled = false;
  });
  killBtn.addEventListener("click", async function () {
    killBtn.disabled = true;
    clearInputError();
    try {
      var res = await fetch("/api/runs/kill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runId }),
      });
      if (res.ok) { markGone("run killed"); return; }
      showInputError(await readError(res));
      killBtn.disabled = false;
    } catch (e) {
      showInputError(String(e));
      killBtn.disabled = false;
    }
  });
  rerender();
  renderQueue();      // restore any sessionStorage-held follow-ups
  syncRunFeedback();
  poll();
  pollSession();
})();
</script>
<script>
${ANALYTICS_PANEL_JS}
</script>
</body>
</html>`;
}

/**
 * Build the read-only watch page for a LIVE SESSION tracequest did not
 * launch — the unified-live counterpart of runPage. Any live session
 * (detected via live-session probes, keyed by session hash) gets the
 * IDENTICAL chat transcript treatment as a launched run: the client polls
 * GET /api/sessions/live?id=<hash>[&etag=…] at the same ~1s cadence with
 * the same etag flow and renders through the shared CHAT_TRANSCRIPT_JS
 * chunk. What differs is honesty about control: the session is driven
 * OUTSIDE tracequest (its own terminal owns stdin). While the recording
 * is growing or the process is live, the conversation column ends on
 * exclusive footer slots: the archive ending (status strip, observer
 * card, takeover continue form) leaves, and the only chrome is
 * #liveTailForm — a slim Send a follow-up composer whose right control
 * is Stop — under shimmering Thinking / Planning next moves and empty
 * air. The archive ending returns only when identity is idle. A
 * newest assistant turn with unmatched tool_use may still spin
 * in-thread tools when detectLiveSessions reports idle — growth chrome
 * only, never a second RUNNING identity. A completed idle G1 poll
 * whose etag is inside QUIET_MS follows identity for growth lastState
 * too (leftover-snap, no Planning-next-moves shimmer). Exclusive
 * #liveTailForm (Stop) and data-live-tail follow detectLiveSessions /
 * poll state, so idle G1 inside QUIET_MS keeps the Send a follow-up
 * composer (no Stop). #runStatus, data-run-state, title, and
 * "Watching a running session" follow that same identity word.
 * Liveness lapsing does NOT stop polling (an idle agent can resume);
 * only the recording vanishing (404) flips the page to the gone state.
 *
 * @param {{ session: { hash: string, path: string, source: string,
 *   project?: string|null, live: boolean,
 *   run?: { id: string, status: string }|null,
 *   continuable?: boolean, agent?: string|null } }} data
 * `continuable` (the source's mapped agent is detected with a verified
 * resume mechanism, mux available) gates the observer CONTINUE COMPOSER —
 * a live input card under the observer note whose typing IS the continue:
 * submit POSTs /api/runs {resumeSession, prompt} and lands in the NEW
 * run's steerable chat with the follow-up already delivered. Absent
 * capability means absent composer: honest absence. `agent` names the
 * mapped agent on the composer chip.
 */
export function liveSessionPage({ session, readOnly = false } = {}) {
  const { hash, path, source, live } = session;
  const project = session.project || "";
  const run = session.run || null;
  const continuable = Boolean(session.continuable);
  const agent = session.agent || null;
  // The full page links back here (from=), so leaving the chat is reversible.
  const viewHref = `/view?path=${encodeURIComponent(path)}&from=${encodeURIComponent(`/run?session=${hash}`)}`;
  const mdHref = `/markdown?path=${encodeURIComponent(path)}`;
  const statusWord = live ? "running" : "idle";
  const observerHeading = live ? "Watching a running session" : "Watching an idle session";
  const observerTail = live
    ? "The transcript updates as the agent works; to steer it, use the terminal where it is running."
    : "The agent is not generating right now; to steer it, use the terminal where it is running.";
  const stripText = "Not running right now — transcript preserved, still watching";
  const liveTailAttrs = live ? ' data-busy="true"' : " hidden";
  const continuePlaceholder = "Send a follow-up";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINKS}
<title>tracequest — ${esc(statusWord)} session ${esc(hash)}</title>
${THEME_BOOT_SCRIPT}
<style>
${STANDALONE_BASE_CSS}
${RUN_PAGE_CSS}
${APP_SHELL_CSS}
${LAUNCHER_MODAL_CSS}
${COMMAND_PALETTE_CSS}
</style>
</head>
<body data-chat-polling="0" data-run-state="${live ? "running" : "idle"}" data-watch="session" data-live-tail="${live ? "1" : "0"}">
<div class="tq-shell">
${APP_TOP_HTML}
  <div class="shell-main">
    ${AGENT_RAIL_HTML}
    <main class="chat-app">
  <header class="chat-top">
    <div class="session-top chat-identity">
      <span class="run-state-badge" id="runStatus" data-status="${esc(statusWord)}">${esc(statusWord)}</span>
      <span class="session-source" style="--hue:${sourceColor(source)}">${esc(source)}</span>
      <span class="session-id" id="chatSessionId">${esc(hash)}</span>
      <span class="session-model" id="chatModel" hidden></span>
      <span class="session-project" title="${esc(path)}">${esc(prettyProject(project) || path.split("/").filter(Boolean).pop() || path)}</span>
      <span class="session-grade-badge run-grade" id="runGrade" hidden></span>
      <span class="run-origin" title="This session was started outside tracequest — its own terminal drives it">external</span>
    </div>
    <div class="chat-top-actions">
      ${ANALYTICS_TOGGLE_HTML}
      <a class="run-back" href="/sessions">&larr; sessions</a>
    </div>
    <div class="session-stats chat-head-stats" id="chatStats" hidden></div>
  </header>
  <div class="chat-body">
  <div class="chat-main">
${CHAT_FIND_BAR_HTML}
  <div class="chat-history" id="chatHistory" hidden>
    <div class="chat-col" id="chatHistoryCol"></div>
  </div>
  <div class="chat-scroll" id="chatScroll">
    <div class="chat-col">
      <div class="chat-thread" id="chatThread"></div>
      <div class="chat-activity" id="chatActivity">${CHAT_LOADING_HTML}</div>
      <div class="run-banner" id="runBanner" hidden></div>
    </div>
  </div>
  <footer class="chat-composer">
    <div class="chat-composer-inner">
      <div class="archive-ending" id="archiveEnding"${live ? " hidden" : ""}>
      <div class="composer-status" id="composerStatus" data-state="${live ? "running" : "idle"}">
        <span class="status-dot"></span>
        <span class="status-text" id="statusText">${esc(stripText)}</span>
        <span class="status-spacer"></span>
        <span class="readonly-chip" id="readonlyChip" title="tracequest is observing this session, not driving it — input happens in the terminal that started it">watch-only</span>
      </div>
      <div class="observer-card" id="observerCard">
        <div class="observer-title">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" stroke="currentColor" stroke-linejoin="round"/><circle cx="8" cy="8" r="2" stroke="currentColor"/></svg>
          <span id="observerTitle">${esc(observerHeading)}</span>
        </div>
        <div class="observer-note">${continuable
          ? `This ${esc(source)} agent was started outside tracequest &mdash; its own terminal drives it, so this transcript is watch-only. To take over from here, type a follow-up below: it continues the conversation as a NEW tracequest run with a fully steerable chat, and this recording stays untouched.`
          : `This ${esc(source)} agent was started outside tracequest &mdash; its own terminal drives it, so there is no composer here. <span id="observerNoteTail">${esc(observerTail)}</span>`}</div>
        <div class="observer-actions">
          <a class="observer-btn" href="${esc(viewHref)}">Open full session view</a>
          <a class="observer-btn" href="${esc(mdHref)}">Export markdown</a>${run ? `
          <a class="observer-btn accent" href="/run?id=${encodeURIComponent(run.id)}" title="This recording belongs to a tracequest run — its chat has a composer">Open run chat ${esc(run.id)}</a>` : ""}
        </div>
      </div>${continuable ? `
      <form class="composer-card" id="continueForm" data-empty="true" data-mode="continue">
        <div class="composer-context">
          <span class="ctx-chip ctx-continue" title="Follow-ups continue this conversation as a NEW tracequest run &mdash; ${esc(agent || source)} forks the recorded session in a fresh tmux window; this recording stays untouched">&#8635;&#xFE0E; continues as a new run</span>${agent ? `
          <span class="ctx-chip" title="The agent that resumes this session">${esc(agent)}</span>` : ""}
        </div>
        <input class="run-input" id="continueInput" type="text" placeholder="${continuePlaceholder}" autocomplete="off" spellcheck="false" aria-label="Send a follow-up">
        <div class="continue-cwd" id="continueCwdRow" hidden>
          <span class="continue-cwd-label">directory</span>
          <input class="continue-cwd-input" id="continueCwdInput" type="text" placeholder="/path/to/project" autocomplete="off" spellcheck="false" aria-label="Directory for the continued run">
        </div>
        <div class="composer-row">
          <span class="composer-spacer"></span>
          <button class="run-send-btn" id="continueSendBtn" type="submit" aria-label="Send follow-up — continues as a new run" title="Continue (Enter) &mdash; sends your follow-up into a new tracequest run; an empty submit continues without a message">
            <svg class="icon-send" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </form>` : ""}
      </div>
      <form class="composer-card live-tail-card" id="liveTailForm" data-empty="true" data-mode="live-tail"${continuable ? ' data-continuable="true"' : ""}${liveTailAttrs}>
${readOnly ? `
        <input class="run-input" id="liveTailInput" type="text" disabled placeholder="Read-only hub — steer this session in its own terminal" aria-label="Read-only hub: steer this session in its own terminal">` : `
        <input class="run-input" id="liveTailInput" type="text" placeholder="Send a follow-up" autocomplete="off" spellcheck="false" aria-label="Send a follow-up">
        <div class="composer-row">
          <button class="run-send-btn" id="liveTailStop" type="button" aria-label="Stop" title="Stop — this session is driven outside tracequest; interrupt it in its own terminal">
            <svg class="icon-send" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg class="icon-stop" width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>
          </button>
        </div>`}
      </form>
      <div class="run-input-error" id="continueError" role="alert" hidden></div>
    </div>
  </footer>
  </div>
  <aside class="chat-output-pane" id="chatOutputPane" hidden></aside>
  </div>
    </main>
    ${analyticsPanelHtml({ viewHref, label: hash })}
  </div>
</div>
${LAUNCHER_MODAL_HTML}
${COMMAND_PALETTE_HTML}
<script>
${shellClientScript({ current: { type: "session", id: hash }, defaultCwd: "" })}
</script>
<script>
(function () {
  var sessionHandle = ${JSON.stringify(hash)};
  var SESSION_POLL_MS = ${SESSION_POLL_MS};
  var IDLE_SESSION_POLL_MS = ${IDLE_SESSION_POLL_MS};
  var statusEl = document.getElementById("runStatus");
  var banner = document.getElementById("runBanner");
  var composerStatus = document.getElementById("composerStatus");
  var statusText = document.getElementById("statusText");
  var observerCard = document.getElementById("observerCard");
  var observerTitle = document.getElementById("observerTitle");
  var observerNoteTail = document.getElementById("observerNoteTail");
  var readonlyChip = document.getElementById("readonlyChip");
  var archiveEnding = document.getElementById("archiveEnding");
  var liveTailForm = document.getElementById("liveTailForm");
  var liveTailInput = document.getElementById("liveTailInput");
  var liveTailStop = document.getElementById("liveTailStop");
  var chatScroll = document.getElementById("chatScroll");
  var chatThread = document.getElementById("chatThread");
  var chatActivity = document.getElementById("chatActivity");
  var runCwd = "";
  var sessTimer = null;
  var stopped = false;
  var lastEtag = null;
  var lastSession = null;
  var lastState = ${JSON.stringify(live ? "running" : "idle")};
  var lastBlocks = [];
  var lastThreadHtml = "";
  var lastActivityHtml = null;
  var lastGrowthAt = 0;
  var QUIET_MS = 4000;
  var apiLive = ${JSON.stringify(!!live)};
${CHAT_TRANSCRIPT_JS}
  /* watch-page activity marker: live shimmer, honest idle line */
  function activityHtml() {
    if (stopped) return "";
    // Nothing fetched yet: say so, rather than "Not running" over an empty column.
    if (!lastSession) return ${JSON.stringify(CHAT_LOADING_HTML)};
    if (lastState === "idle") {
      return markerHtml("Not running", "transcript preserved \\u2014 still watching for changes");
    }
    var last = lastBlocks.length ? lastBlocks[lastBlocks.length - 1] : null;
    if (!last) {
      return markerHtml("No transcript yet", "the agent process is running but this recording has no turns");
    }
    var label = last.kind === "user" ? "Thinking" : "Planning next moves";
    return '<div class="chat-marker"><span class="shimmer">' + label + "</span></div>";
  }

  /* ================= lifecycle ================= */
  function setChatPollingFlag(on) {
    document.body.setAttribute("data-chat-polling", on ? "1" : "0");
  }
  /** Growth lastState: identity generating, or unmatched tool_use.
   *  Completed idle G1 inside QUIET_MS follows identity — recent etag
   *  is leftover of turn_ended, not a generating trail. */
  function deriveWatchLive() {
    if (apiLive) return true;
    if (hasUnresolvedToolUse(lastSession)) return true;
    return false;
  }
  function sessionLooksGenerating() {
    if (hasUnresolvedToolUse(lastSession)) return true;
    if (!apiLive) return false;
    var events = (lastSession && lastSession.events) || [];
    if (!events.length) return false;
    var last = events[events.length - 1];
    return last.type === "user" || last.type === "tool_result";
  }
  /** Identity chrome: detectLiveSessions / poll state, never the growth overlay. */
  function watchIdentityWord() {
    return apiLive ? "running" : "idle";
  }
  /** Growth lastState follows identity for a completed idle turn;
   *  unmatched tool_use may still spin in-thread tools. */
  function setWatchState(state) {
    // Sample follow-tail BEFORE live chrome CSS grows the column
    // (chat-activity min-height + chat-col padding-bottom) or
    // leftover-snap parking. Leftover-snap's idle frame is the
    // conversation end; after those rules, isAtBottom() is false
    // and the generating trail never pins.
    if (state === "running") followTail = followTail || isAtBottom();
    lastState = state;
    paintWatchChrome();
  }
  function paintWatchChrome() {
    if (lastState === "gone") return;
    var word = watchIdentityWord();
    // Exclusive Stop / data-live-tail is identity generating, never
    // deriveWatchLive QUIET_MS. Completed idle lastState follows identity.
    var liveNow = word === "running";
    statusEl.textContent = word;
    statusEl.setAttribute("data-status", word);
    composerStatus.setAttribute("data-state", word);
    document.body.setAttribute("data-live-tail", liveNow ? "1" : "0");
    document.body.setAttribute("data-run-state", word);
    document.title = "tracequest — " + word + " session " + sessionHandle;
    if (observerTitle) observerTitle.textContent = word === "running" ? "Watching a running session" : "Watching an idle session";
    if (observerNoteTail) observerNoteTail.textContent = word === "running"
      ? "The transcript updates as the agent works; to steer it, use the terminal where it is running."
      : "The agent is not generating right now; to steer it, use the terminal where it is running.";
    // Exclusive slots: archive ending (strip + observer + takeover) vs
    // the slim generating composer. Never restyle #continueForm into the tail.
    if (archiveEnding) archiveEnding.hidden = liveNow;
    observerCard.hidden = liveNow;
    if (readonlyChip) readonlyChip.hidden = liveNow;
    if (liveTailForm) {
      liveTailForm.hidden = !liveNow;
      if (liveNow) liveTailForm.setAttribute("data-busy", "true");
      else liveTailForm.removeAttribute("data-busy");
    }
    var contForm = document.getElementById("continueForm");
    if (contForm) {
      contForm.setAttribute("data-mode", "continue");
      contForm.removeAttribute("data-busy");
    }
    statusText.textContent = "Not running right now \\u2014 transcript preserved, still watching";
    composerStatus.removeAttribute("data-busy");
  }
  function markGone(message) {
    stopped = true;
    if (sessTimer) { clearTimeout(sessTimer); sessTimer = null; }
    setChatPollingFlag(false);
    statusEl.textContent = "gone";
    statusEl.setAttribute("data-status", "gone");
    composerStatus.setAttribute("data-state", "gone");
    statusText.textContent = message || "Session gone \\u2014 its recording no longer exists";
    banner.textContent = message || "session gone \\u2014 its recording no longer exists";
    banner.setAttribute("data-kind", "gone");
    banner.hidden = false;
    if (archiveEnding) archiveEnding.hidden = true;
    observerCard.hidden = true;
    if (readonlyChip) readonlyChip.hidden = true;
    if (liveTailForm) liveTailForm.hidden = true;
    document.body.setAttribute("data-live-tail", "0");
    // Nothing left to resume: the continue composer retires with the recording.
    var goneContinueForm = document.getElementById("continueForm");
    if (goneContinueForm) goneContinueForm.hidden = true;
    lastState = "gone";
    rerender();
    document.body.setAttribute("data-run-state", "gone");
  }

  /* ---- session loop (etag flow — never stops while the page lives):
     ~1s while the session is running, IDLE_SESSION_POLL_MS while it is
     not; a data-update (window._refreshData) polls at once either way ---- */
  function scheduleSession() {
    if (stopped) return;
    if (document.hidden) { setChatPollingFlag(false); return; }
    setChatPollingFlag(true);
    sessTimer = setTimeout(pollSession, apiLive || lastState === "running" ? SESSION_POLL_MS : IDLE_SESSION_POLL_MS);
  }
  function applySession(data) {
    var wasLive = apiLive;
    var grew = false;
    apiLive = data.state === "running";
    if (!data.unchanged && data.session) {
      if (data.etag && data.etag !== lastEtag) {
        var mt = parseInt(String(data.etag).split("-")[0], 10);
        lastGrowthAt = mt > 0 ? mt : Date.now();
      }
      lastSession = data.session;
      lastEtag = data.etag;
      if (lastSession.cwd) runCwd = lastSession.cwd;
      grew = true;
    }
    // The transcript and its chrome are a function of the session and the
    // state alone: an unchanged answer in the same state has nothing to
    // repaint, and rebuilding a long thread on every poll stalls scrolling.
    if (!grew && apiLive === wasLive && (deriveWatchLive() ? "running" : "idle") === lastState) return;
    setWatchState(deriveWatchLive() ? "running" : "idle");
    rerender();
  }
  // One session request at a time: a data-update arriving while a poll is
  // in flight asks for one more poll after it (with the etag it answered)
  // instead of starting a second poll loop beside the first.
  var sessInFlight = false;
  var sessAgain = false;
  async function pollSession() {
    if (sessInFlight) { sessAgain = true; return; }
    sessInFlight = true;
    try {
      await pollSessionOnce();
    } finally {
      sessInFlight = false;
    }
    if (sessAgain && !stopped) {
      sessAgain = false;
      if (sessTimer) { clearTimeout(sessTimer); sessTimer = null; }
      pollSession();
    }
  }
  async function pollSessionOnce() {
    sessTimer = null;
    if (stopped) return;
    try {
      var url = "/api/sessions/live?id=" + encodeURIComponent(sessionHandle);
      if (lastEtag) url += "&etag=" + encodeURIComponent(lastEtag);
      var res = await fetch(url);
      if (stopped) return;
      if (res.status === 404) { markGone(); return; }
      if (res.ok) {
        var data = await res.json();
        if (stopped) return;
        applySession(data);
      }
    } catch (e) {
      // transient network error — keep polling
    }
    scheduleSession();
  }

  document.addEventListener("visibilitychange", function () {
    if (document.hidden) {
      if (sessTimer) { clearTimeout(sessTimer); sessTimer = null; }
      setChatPollingFlag(false);
    } else if (!stopped && !sessTimer) {
      pollSession();
    }
  });

  /* Continue composer lives only in the archive ending. The live tail
     is a separate #liveTailForm whose empty right control is Stop; typed
     text on a continuable session reuses this same resume POST. */
  var continueForm = document.getElementById("continueForm");
  var continueError = document.getElementById("continueError");
  var continueInput = document.getElementById("continueInput");
  var continueSendBtn = document.getElementById("continueSendBtn");
  var contCwdRow = document.getElementById("continueCwdRow");
  var contCwdInput = document.getElementById("continueCwdInput");
  var canContinue = ${JSON.stringify(continuable)};
  var contBusy = false;
  function continueFail(text) {
    if (continueError) {
      continueError.textContent = text;
      continueError.hidden = false;
    }
    contBusy = false;
    if (continueSendBtn) continueSendBtn.disabled = false;
    if (liveTailStop) liveTailStop.disabled = false;
  }
  async function startContinueRun(prompt) {
    if (contBusy) return;
    var body = { resumeSession: sessionHandle };
    if (prompt) body.prompt = prompt;
    if (contCwdRow && !contCwdRow.hidden && contCwdInput && contCwdInput.value) body.cwd = contCwdInput.value;
    contBusy = true;
    if (continueSendBtn) continueSendBtn.disabled = true;
    if (liveTailStop) liveTailStop.disabled = true;
    if (continueError) continueError.hidden = true;
    try {
      var res = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (res.ok && data.id) {
        if (body.prompt) {
          try { sessionStorage.setItem("tq-followup:" + data.id, body.prompt); } catch (e) {}
        }
        window.location.href = "/run?id=" + encodeURIComponent(data.id);
        return;
      }
      if (data && data.needs === "cwd") {
        if (archiveEnding) archiveEnding.hidden = false;
        document.body.setAttribute("data-live-tail", "0");
        if (contCwdRow) contCwdRow.hidden = false;
        if (contCwdInput && !contCwdInput.value && runCwd) contCwdInput.value = runCwd;
        continueFail((data && data.error) || "pick a directory for the new run");
        if (contCwdInput) contCwdInput.focus();
        return;
      }
      continueFail((data && data.error) || "continue failed");
    } catch (e) {
      continueFail(String(e));
    }
  }
  if (continueForm && continueInput) {
    continueInput.addEventListener("input", function () {
      continueForm.setAttribute("data-empty", continueInput.value.length ? "false" : "true");
    });
    continueForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      startContinueRun(continueInput.value);
    });
  }
  if (liveTailForm && liveTailInput && liveTailStop) {
    function syncLiveTailAffordance() {
      var typed = liveTailInput.value.length > 0;
      liveTailForm.setAttribute("data-empty", typed ? "false" : "true");
      if (typed && canContinue) {
        liveTailStop.setAttribute("aria-label", "Send follow-up \\u2014 continues as a new run");
        liveTailStop.title = "Continue (Enter) \\u2014 sends your follow-up into a new tracequest run";
      } else {
        liveTailStop.setAttribute("aria-label", "Stop");
        liveTailStop.title = "Stop \\u2014 this session is driven outside tracequest; interrupt it in its own terminal";
      }
    }
    liveTailInput.addEventListener("input", syncLiveTailAffordance);
    liveTailForm.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (liveTailInput.value.length && canContinue) startContinueRun(liveTailInput.value);
    });
    liveTailStop.addEventListener("click", function () {
      if (liveTailInput.value.length && canContinue) {
        startContinueRun(liveTailInput.value);
        return;
      }
      // Stop on an externally driven session is honest: we cannot interrupt
      // the other terminal. The control stays so the ending matches Cursor.
    });
  }

  rerender();
  pollSession();
})();
</script>
<script>
${ANALYTICS_PANEL_JS}
</script>
</body>
</html>`;
}

/**
 * Empty chat home — the /run shell with no session opened yet.
 * Used when GET / (or /run) has nothing to open.
 */
export function chatHomePage({ defaultCwd } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${FAVICON_LINKS}
<title>tracequest</title>
${THEME_BOOT_SCRIPT}
<style>
${STANDALONE_BASE_CSS}
${RUN_PAGE_CSS}
${APP_SHELL_CSS}
${LAUNCHER_MODAL_CSS}
${COMMAND_PALETTE_CSS}
.chat-empty {
  max-width: 520px; margin: 0 auto; padding: 18vh 28px 24px;
  color: var(--text-3); font-size: var(--text-md); line-height: var(--lh-md); text-align: center;
}
.chat-empty-title {
  color: var(--text); font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: var(--weight-regular);
  letter-spacing: var(--track-display); margin-bottom: 8px;
}
</style>
</head>
<body data-chat-home="1">
<div class="tq-shell">
${APP_TOP_HTML}
  <div class="shell-main">
    ${AGENT_RAIL_HTML}
    <main class="chat-app">
  <header class="chat-top">
    <div class="session-top chat-identity">
      <span class="chat-top-spacer"></span>
    </div>
  </header>
  <div class="chat-body">
  <div class="chat-main">
  <div class="chat-scroll" id="chatScroll">
    <div class="chat-col">
      <div class="chat-empty">
        <div class="chat-empty-title">No session open</div>
        Pick a session from the rail or start a new run.
      </div>
    </div>
  </div>
  <footer class="chat-composer">
    <div class="chat-composer-inner">
      <form class="composer-card" id="homeComposer" data-empty="true">
        <input class="run-input" id="homePrompt" type="text" placeholder="Start a new run" autocomplete="off" spellcheck="false" aria-label="Start a new run">
        <div class="composer-row">
          <span class="composer-spacer"></span>
          <button class="run-send-btn" id="homeSend" type="submit" aria-label="New run" title="Start a new run">
            <svg class="icon-send" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </form>
    </div>
  </footer>
  </div>
  </div>
    </main>
  </div>
</div>
${LAUNCHER_MODAL_HTML}
${COMMAND_PALETTE_HTML}
<script>
${shellClientScript({ current: { type: "home", id: "" }, defaultCwd: defaultCwd || "" })}
</script>
<script>
(function () {
  var form = document.getElementById("homeComposer");
  var input = document.getElementById("homePrompt");
  if (!form || !input) return;
  function syncEmpty() {
    form.setAttribute("data-empty", input.value ? "false" : "true");
  }
  input.addEventListener("input", syncEmpty);
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var prompt = input.value;
    var overlay = document.getElementById("launchOverlay");
    var promptInput = document.getElementById("promptInput");
    if (typeof window.openLauncher === "function") window.openLauncher();
    else if (overlay) overlay.hidden = false;
    if (promptInput && prompt) {
      promptInput.value = prompt;
      try { promptInput.dispatchEvent(new Event("input")); } catch (e) {}
    }
  });
})();
</script>
</body>
</html>`;
}
