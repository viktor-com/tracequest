/**
 * /run watch page — Cursor-style live chat transcript for one Run.
 *
 * Server-generated single-string HTML the browser-page way (doctype +
 * inline <style> + body + inline <script>, no client framework). The
 * conversation surface is the page: the client polls
 * /api/runs/session?id=@N[&etag=…] roughly every second and renders the
 * run's unified Session as a chat — user bubbles, assistant prose
 * (markdown-lite), thought markers, tool-call cards with human titles and
 * muted binary names, "Explored N searches" grouping for consecutive
 * search-type calls, edit/write file cards with +N/−N stats, and a
 * shimmering in-progress marker ("Thinking" / "Planning next moves")
 * while the run is generating (detectLiveSessions / runIsLive — never a
 * tmux-alive linked pane alone). The etag flow means unchanged polls cost nothing
 * and the thread is patched incrementally (existing message/tool-card
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
import { ansiPaletteCss } from "../render/ansi-html.js";
import { esc } from "../server/server-html-helpers.js";
import {
  computeGrade,
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
  ANALYTICS_PANEL_CSS,
  ANALYTICS_PANEL_HTML,
  ANALYTICS_PANEL_JS,
  ANALYTICS_TOGGLE_HTML,
} from "./run-analytics-panel.js";

const APPLY_THREAD_ITEMS_SRC = applyThreadItems.toString().replace(/^export /, "");

/** Snapshot poll cadence in ms for the raw terminal block. */
export const RUN_POLL_MS = 600;

/** Unified-session poll cadence in ms for the chat transcript. */
export const SESSION_POLL_MS = 1000;

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
/* ---- app shell: shared app bar + session rail + chat pane ---- */
.tq-shell { display: flex; flex-direction: column; height: 100%; }
${APP_TOP_CSS}
${IDENTITY_ROW_CSS}
.shell-main { display: flex; flex: 1; min-height: 0; }

.agent-rail {
  width: 320px;
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--surface);
}
.rail-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 11px 10px 7px 14px;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg3);
  flex: none;
}
.rail-count { font-family: var(--mono); font-weight: 400; }
.rail-filter-toggle {
  margin-left: auto;
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid transparent;
  border-radius: 6px;
  color: var(--fg3);
  cursor: pointer;
  padding: 0;
}
.rail-filter-toggle:hover { color: var(--fg); background: var(--surface2); }
.rail-filter-toggle[aria-expanded="true"],
.rail-filter-toggle.has-value {
  color: var(--fg);
  border-color: var(--accent);
  background: rgba(139,124,246,0.08);
}
.rail-filter-toggle svg { width: 13px; height: 13px; display: block; }
.agent-rail:not(.filters-open) .rail-filters-extra { display: none; }
.rail-list { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 0 6px 8px; display: flex; flex-direction: column; gap: 2px; }
.rail-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--fg2);
  min-width: 0;
}
.rail-row:hover { background: var(--surface2); }
.rail-row[aria-current="page"] {
  background: var(--surface2);
  box-shadow: inset 0 0 28px 10px rgba(139, 124, 246, 0.14);
}
.rail-glyph {
  flex: none;
  width: 14px;
  height: 14px;
  margin-top: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: var(--fg3);
  border: 1px solid var(--border);
  border-radius: 50%;
}
.rail-glyph[data-status="running"] { border: none; }
.rail-glyph[data-status="running"]::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  animation: rail-pulse 1.6s ease-in-out infinite;
}
@keyframes rail-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.rail-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rail-title {
  font-size: 12px;
  line-height: 1.35;
  color: var(--fg);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.rail-sub {
  font-size: 11px;
  color: var(--fg3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rail-sub .rail-agent { font-weight: 600; }
.rail-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.rail-time { font-size: 10px; color: var(--fg3); font-family: var(--mono); white-space: nowrap; }
.rail-grade { font-size: 10px; padding: 0 4px; }
.rail-empty { padding: 10px 10px; font-size: 11px; color: var(--fg3); }
.rail-all {
  flex: none;
  display: block;
  padding: 9px 14px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  text-decoration: none;
}
.rail-all:hover { color: var(--accent); }

/* ---- previous-home filters, stacked in the session rail ---- */
.rail-filters {
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 8px 8px;
  border-bottom: 1px solid var(--border);
  max-height: 46%;
  overflow-x: hidden;
  overflow-y: auto;
}
.rail-filter-wrap { position: relative; }
.rail-filters .filter-bar {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 30px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 2px 8px;
  cursor: text;
  transition: border-color 0.15s;
}
.rail-filters .filter-bar:focus-within { border-color: rgba(255,255,255,0.14); }
.rail-filters .filter-input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 12px;
  outline: none;
  padding: 4px 0;
}
.rail-filters .filter-input::placeholder { color: var(--fg3); }
.rail-filters .filter-hint {
  color: var(--fg3);
  font-size: 10px;
  font-family: var(--mono);
  background: var(--surface2);
  padding: 1px 5px;
  border-radius: 4px;
  pointer-events: none;
  opacity: 0.7;
  flex-shrink: 0;
}
.rail-filters .filter-bar:focus-within .filter-hint { display: none; }
.rail-toolbar {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 5px;
}
.rail-filters .toolbar-pop { position: static; min-width: 0; }
.rail-filters .toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--fg2);
  font-size: 11px;
  font-family: var(--sans);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.rail-filters .toolbar-btn:hover { color: var(--fg); border-color: rgba(255,255,255,0.14); }
.rail-filters .toolbar-btn[aria-expanded="true"],
.rail-filters .toolbar-btn.active {
  color: var(--fg);
  border-color: var(--accent);
  background: rgba(139,124,246,0.08);
}
.rail-filters .toolbar-btn.has-value { color: var(--fg); }
.rail-filters .toolbar-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  min-width: 0;
  max-height: 240px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 4px;
  z-index: 120;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.rail-filters .toolbar-menu[hidden] { display: none; }
.rail-filters .toolbar-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--fg2);
  font-size: 12px;
  font-family: var(--sans);
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
}
.rail-filters .toolbar-option:hover { background: var(--surface2); color: var(--fg); }
.rail-filters .toolbar-option.active { color: var(--fg); background: rgba(139,124,246,0.08); }
.rail-filters .toolbar-option-count { font-size: 11px; color: var(--fg3); font-family: var(--mono); }
.rail-filters .sort-bar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  min-width: 168px;
}
.rail-filters .sort-label {
  margin: 2px 8px 4px;
  font-size: 10px;
  color: var(--fg3);
  font-family: var(--mono);
}
.rail-filters .sort-btn {
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--fg3);
  font-size: 12px;
  font-family: var(--sans);
  padding: 6px 8px;
  cursor: pointer;
  text-align: left;
}
.rail-filters .sort-btn:hover { color: var(--fg); background: var(--surface2); }
.rail-filters .sort-btn.active { color: var(--fg); background: rgba(139,124,246,0.08); }
.rail-overview {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rail-overview .dashboard-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.rail-overview .dashboard-title {
  font-size: 10px;
  font-weight: 500;
  color: var(--fg3);
}
.rail-overview .dashboard-scope {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
}
.rail-overview .dashboard-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px 10px;
  font-family: var(--mono);
}
.rail-overview .dashboard-stat {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
  flex-wrap: nowrap;
}
.rail-overview .dashboard-stat-val {
  font-weight: 600;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  font-size: 12px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rail-overview .dashboard-stat-label {
  color: var(--fg3);
  font-size: 11px;
}
.rail-overview .dashboard-tools {
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
.rail-overview.collapsed .dashboard-tools { display: none; }
.rail-overview .dashboard-tools-title {
  font-size: 10px;
  color: var(--fg3);
  margin-bottom: 4px;
  font-family: var(--mono);
}
.rail-overview .dashboard-tools-list { display: flex; flex-wrap: wrap; gap: 3px; }
.rail-overview .dashboard-tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
}
.rail-overview .dashboard-tool-count { opacity: 0.7; }
.rail-overview .dashboard-toggle {
  background: none;
  border: none;
  color: var(--fg3);
  font-size: 10px;
  font-family: var(--mono);
  cursor: pointer;
  padding: 0;
  align-self: flex-start;
}
.rail-overview .dashboard-toggle:hover { color: var(--fg2); }
.rail-filters .qf-bar {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.rail-filters .qf-bar[hidden] { display: none; }
.rail-filters .qf-pickers {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.rail-filters .qf-pickers[hidden] { display: none; }
.rail-filters .qf-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.rail-filters .qf-section {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
}
.rail-filters .qf-section-label {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  margin-right: 2px;
}
.rail-filters .qf-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: none;
  color: var(--fg3);
  cursor: pointer;
  white-space: nowrap;
}
.rail-filters .qf-chip:hover { color: var(--fg2); border-color: rgba(255,255,255,0.14); background: var(--surface2); }
.rail-filters .qf-chip.qf-active { color: var(--fg); border-color: var(--accent); background: rgba(139,124,246,0.10); }
.rail-filters .qf-chip-count { font-size: 9px; opacity: 0.6; }
.rail-filters .qf-grade {
  font-weight: 700;
  font-size: 11px;
  width: 22px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: none;
  cursor: pointer;
  padding: 0;
  font-family: var(--mono);
}
.rail-filters .qf-grade:hover { border-color: rgba(255,255,255,0.14); }
.rail-filters .qf-grade.qf-active { border-width: 2px; }
.rail-filters .qf-grade.qf-g-a { color: var(--green); }
.rail-filters .qf-grade.qf-g-a.qf-active { border-color: var(--green); background: rgba(74,222,128,0.10); }
.rail-filters .qf-grade.qf-g-b { color: var(--green); opacity: 0.8; }
.rail-filters .qf-grade.qf-g-b.qf-active { border-color: var(--green); background: rgba(74,222,128,0.07); opacity: 1; }
.rail-filters .qf-grade.qf-g-c { color: var(--orange); }
.rail-filters .qf-grade.qf-g-c.qf-active { border-color: var(--orange); background: rgba(232,164,76,0.10); }
.rail-filters .qf-grade.qf-g-d { color: #d97740; }
.rail-filters .qf-grade.qf-g-d.qf-active { border-color: #d97740; background: rgba(217,119,64,0.10); }
.rail-filters .qf-grade.qf-g-f { color: var(--red); }
.rail-filters .qf-grade.qf-g-f.qf-active { border-color: var(--red); background: rgba(240,112,112,0.10); }
.rail-filters .qf-grade.qf-disabled { opacity: 0.25; cursor: default; }
.rail-filters .qf-error-toggle {
  display: inline-flex;
  align-items: center;
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: none;
  color: var(--fg3);
  cursor: pointer;
}
.rail-filters .qf-error-toggle.qf-active { color: var(--red); border-color: var(--red); background: rgba(240,112,112,0.08); }
.rail-filters .applied-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.rail-filters .chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 5px 2px 6px;
  font-size: 11px;
  max-width: 100%;
}
.rail-filters .chip-key { color: var(--fg2); font-weight: 500; }
.rail-filters .chip-op { color: var(--fg3); font-size: 10px; }
.rail-filters .chip-value { color: var(--fg); font-family: var(--mono); font-size: 10px; overflow: hidden; text-overflow: ellipsis; }
.rail-filters .chip-remove {
  background: none;
  border: none;
  color: var(--fg3);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0 1px;
}
.rail-filters .chip-remove:hover { color: var(--red); }
.rail-filters .qf-clear {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--fg3);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 4px;
}
.rail-filters .qf-clear:hover { color: var(--accent); }
.rail-filters .qf-clear.qf-visible { display: inline-block; }

.chat-app { flex: 1; min-width: 0; min-height: 0; }

/* the chat header wears the record's LIST identity row (shared classes
   from IDENTITY_ROW_CSS) — entering the chat is the same row expanding */
.chat-top-spacer { flex: 1; }
.chat-identity { min-width: 0; }
.chat-identity .session-id { white-space: nowrap; }
.chat-head-stats { margin-top: 3px; }
.chat-head-stats[hidden] { display: none; }

/* the rail is the way back on wide screens; the text escape hatch
   only appears when the rail is hidden */
@media (min-width: 881px) { .run-back { display: none; } }
@media (max-width: 880px) { .agent-rail { display: none; } }
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
    Bash: "#59d4a0", Edit: "#e0c45e", Write: "#d89660", Read: "#6ba4e8",
    Agent: "#a78bfa", Grep: "#7a7a85", Glob: "#7a7a85", Skill: "#c88abd",
    WebFetch: "#6ba4e8", WebSearch: "#6ba4e8", ToolSearch: "#7a7a85",
    SemanticSearch: "#7a7a85", Delete: "#f07070", Await: "#8b8b92",
    Ask: "#6ba4e8", CallMcpTool: "#5dadec"
  };
  var filterInput = document.getElementById("filterInput");
  var qfBarEl = document.getElementById("qfBar");
  var _filterTimer = null;

  function agentBit(name, project) {
    var color = SOURCE_COLORS[name] || "#7a7a85";
    var html = '<span class="rail-agent" style="color:' + color + '">' + railEsc(name) + "</span>";
    if (project) html += " &middot; " + railEsc(project);
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
        var sColor = SOURCE_COLORS[sn] || "#888";
        html += '<button type="button" class="qf-chip" data-source="' + railEsc(sn) + '" aria-pressed="false" style="border-color:' + sColor + '40"><span style="color:' + sColor + '">' + railEsc(sn) + '</span> <span class="qf-chip-count">' + sc + "</span></button>";
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
    if (liveCount) html += dashStat('<span style="color:#4ade80">' + liveCount + "</span>", "running");
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
        var tColor = TOOL_COLORS[tName] || (String(tName).indexOf("mcp__") === 0 ? "#5dadec" : "#7a7a85");
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
html, body { height: 100%; }
body { overflow: hidden; }
.chat-app { display: flex; flex-direction: column; height: 100%; }

/* ---- top bar: the record's LIST identity row + its stat chips ---- */
.chat-top {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 18px 9px;
  border-bottom: 1px solid var(--border);
  flex: none;
  min-width: 0;
}
.run-started { font-size: 11px; color: var(--fg3); font-family: var(--mono); white-space: nowrap; }
.run-back { color: var(--accent); font-size: 12px; text-decoration: none; white-space: nowrap; }
.run-back:hover { text-decoration: underline; }
.run-view-link { color: var(--fg3); font-size: 12px; font-family: var(--mono); text-decoration: none; white-space: nowrap; }
.run-view-link:hover { color: var(--accent); text-decoration: underline; }
.run-view-link[hidden] { display: none; }

/* provenance: this run continues an earlier session */
.run-continued-from {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  text-decoration: none;
  white-space: nowrap;
  padding: 1px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
}
.run-continued-from:hover { color: var(--accent); border-color: var(--accent); }

/* ---- conversation column + optional click-to-inspect output pane ----
   Default completed-turn view keeps the pane closed so chat-col stays
   ~760px and the finished answer (prompt → whole prose → named output)
   is one reading block. The pane is a sibling the user can open. */
.chat-body { flex: 1; display: flex; flex-direction: row; min-height: 0; min-width: 0; }
.chat-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.chat-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; }
.chat-col { max-width: 760px; margin: 0 auto; padding: 14px 26px 24px; }
.chat-output-pane[hidden] { display: none !important; }
.chat-app[data-has-output="1"] .chat-output-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 62%;
  min-width: 700px;
  max-width: 72%;
  min-height: 0;
  border-left: 1px solid var(--border);
  background: var(--bg);
  overflow: auto;
}
@media (max-width: 1200px) {
  .chat-app[data-has-output="1"] .chat-output-pane {
    min-width: 360px;
    max-width: 56%;
    flex-basis: 48%;
  }
}
.chat-output-pane > .chat-card.chat-output {
  flex: none;
  margin: 0;
  border: none;
  border-radius: 0;
  background: transparent;
  min-width: 0;
}
/* Keep advertised lines one-to-one with source lines so Lines 1-N fit
   in the pane viewport (pre-wrap in a narrow pane doubled the height). */
.chat-output-pane .chat-tool-body {
  white-space: pre;
}

.chat-user {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 9px 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg);
  margin: 10px 0 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.chat-thread > .chat-user:first-child { margin-top: 2px; }

.chat-assistant {
  position: relative;
  font-size: 13px;
  line-height: 1.5;
  color: var(--fg);
  margin: 4px 2px 10px;
  overflow-wrap: break-word;
}
/* Live generating: prior assistant events are parked off the fold
   (height 0). Advertised bytes stay in the node so full-text /
   incremental stamps hold — no 22px data-trail costume. */
.chat-assistant[data-contained="parked"],
.chat-card.chat-output[data-contained="parked"],
.chat-thought[data-contained="parked"],
.chat-marker[data-contained="parked"] {
  max-height: 0 !important;
  height: 0 !important;
  min-height: 0 !important;
  overflow: hidden !important;
  margin: 0 !important;
  padding: 0 !important;
  border: none !important;
}
/* assistant prose is one undivided subject; named output follows it */
.chat-assistant + .tool-card { margin-top: 8px; }
.tool-card + .tool-card { margin-top: 6px; }
.chat-assistant p { margin: 4px 0; white-space: pre-wrap; }
.chat-assistant code {
  font-family: var(--mono);
  font-size: 12px;
  background: var(--surface2);
  border-radius: 4px;
  padding: 1px 5px;
}
.chat-h { font-weight: 600; margin: 12px 0 4px; }
.chat-code {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 8px 0;
  overflow-x: auto;
}
.chat-code code {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  background: none;
  padding: 0;
  white-space: pre;
}
.chat-list { margin: 6px 0 6px 4px; padding-left: 16px; }
.chat-list li { margin: 4px 0; }
.chat-check { list-style: none; position: relative; padding-left: 4px; }
.chat-check::before { content: "\\25CB"; color: var(--fg3); position: absolute; left: -14px; }
.chat-check[data-done="true"]::before { content: "\\2713"; color: var(--green); }

/* markers: "Thought briefly", "Explored 4 searches", "Planning next moves" */
.chat-marker { font-size: 13px; margin: 12px 2px 8px; }
.chat-marker .m1 { color: var(--fg2); }
.chat-marker .m2 { color: var(--fg3); }
.chat-thought { margin: 12px 2px 8px; }
.chat-thought-toggle {
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 13px;
  cursor: pointer;
  color: var(--fg2);
}
.chat-thought-toggle .m2 { color: var(--fg3); }
.chat-thought-toggle:hover .m1 { color: var(--fg); }
.chat-thinking {
  margin: 6px 0 6px 2px;
  padding: 8px 12px;
  border-left: 2px solid var(--border);
  color: var(--fg2);
  font-size: 12.5px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--sans);
}

/* tool cards */
.chat-card {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  border: 1px solid var(--border);
  background: var(--surface);
  border-radius: 10px;
  padding: 8px 12px;
  margin: 6px 0;
  font-size: 12.5px;
  min-width: 0;
}
.chat-card-head {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.chat-card .card-icon { flex: none; color: var(--fg3); }
.chat-card .card-title {
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.chat-card .card-title.mono { font-family: var(--mono); font-size: 12px; }
.chat-card .card-bins { color: var(--fg3); flex: none; }
.chat-card .card-err {
  flex: none;
  margin-left: auto;
  color: var(--red);
  font-size: 10px;
  font-family: var(--mono);
}
.chat-card.err { border-color: rgba(240,112,112,0.35); }
.chat-card.running .card-title { color: var(--fg); }

/* edit/write file cards with diffstat */
.chat-card.file .file-name { color: var(--fg); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-card.file .plus { color: var(--green); font-family: var(--mono); font-size: 12px; flex: none; }
.chat-card.file .minus { color: var(--red); font-family: var(--mono); font-size: 12px; flex: none; }

/* plain tool lines (Read) — title stays a single ellipsized row; the body is full */
.chat-toolline { font-size: 13px; margin: 8px 2px; }
.chat-toolline-head { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-toolline .tl1 { color: var(--fg2); }
.chat-toolline .tl2 { color: var(--fg3); }

/* named output card: a closed file object (header + line-snapped body).
   overflow stays visible — leftover overflow:hidden sheared the last
   painted glyph. Interior padding lives on the card (below the
   scroller) so the next line cannot paint into the pad. */
.chat-card.chat-output {
  padding: 0 0 12px;
  gap: 0;
  overflow: visible;
  cursor: pointer;
}
.chat-output-head { padding: 7px 12px; }
.chat-output-name {
  color: var(--fg);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.chat-output-meta {
  color: var(--fg3);
  font-size: 11.5px;
  font-family: var(--mono);
  flex: none;
  margin-left: auto;
}
.chat-card.chat-output[data-shown="1"] { border-color: rgba(255, 255, 255, 0.22); }
.chat-tool-body {
  margin: 0;
  padding: 8px 10px;
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg2);
  background: var(--surface2);
  border-radius: 6px;
}
/* File-object body: containNamedOutput sets an inline height from
   measured line boxes (Range) plus interior padding so the last
   visible line is whole. A leftover-column overflow:hidden clip and
   a fixed 18em cap are both forbidden. overflow:auto + a stable
   gutter keep every advertised line in the DOM and show the scroller. */
.chat-card.chat-output .chat-tool-body {
  overflow: auto;
  overflow-x: auto;
  overflow-y: scroll;
  white-space: pre;
  border-radius: 0;
  background: var(--bg);
  border-top: 1px solid var(--border);
  padding: 8px 12px 0;
  font-size: 11.5px;
  line-height: 1.4;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
}
.chat-card.chat-output .chat-tool-body::-webkit-scrollbar { width: 8px; }
.chat-card.chat-output .chat-tool-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.22);
  border-radius: 4px;
}

.chat-errnote {
  border-left: 2px solid var(--red);
  color: var(--fg2);
  font-size: 12.5px;
  padding: 6px 10px;
  margin: 8px 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* in-progress / pending activity */
.chat-activity { min-height: 26px; margin: 4px 2px 0; font-size: 13px; }
.shimmer {
  display: inline-block;
  background: linear-gradient(90deg, var(--fg3) 20%, var(--fg) 50%, var(--fg3) 80%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: chat-shimmer 1.8s linear infinite;
}
@keyframes chat-shimmer { from { background-position: 200% 0; } to { background-position: 0% 0; } }
.spinner {
  flex: none;
  width: 11px;
  height: 11px;
  border: 1.5px solid var(--fg3);
  border-top-color: transparent;
  border-radius: 50%;
  animation: chat-spin 0.8s linear infinite;
}
@keyframes chat-spin { to { transform: rotate(360deg); } }
.chat-activity-sub { color: var(--fg3); font-size: 12px; margin-top: 4px; }
.chat-empty { color: var(--fg3); font-size: 13px; margin: 10px 2px; }

/* exited/gone banner */
.run-banner {
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  margin-top: 14px;
}
.run-banner[data-kind="exited"] { color: var(--orange); background: rgba(232,164,76,0.08); }
.run-banner[data-kind="gone"] { color: var(--red); background: rgba(240,112,112,0.08); }
.run-banner[hidden] { display: none; }

/* collapsed raw terminal */
.chat-terminal { margin-top: 16px; }
.chat-terminal summary {
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg3);
  user-select: none;
}
.chat-terminal summary:hover { color: var(--fg2); }
.run-terminal {
  --ansi-fg: #d4d4d4;
  --ansi-bg: #101012;
  background: var(--ansi-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  margin-top: 8px;
  overflow-x: auto;
}
.run-screen {
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.45;
  white-space: pre;
  min-width: 80ch;
  color: var(--ansi-fg);
}
.run-terminal[data-status="exited"] .run-screen,
.run-terminal[data-status="gone"] .run-screen { opacity: 0.55; }

/* ---- composer (Cursor-style input card + run-status strip) ---- */
.chat-composer { flex: none; background: var(--bg); }
.chat-composer-inner { max-width: 760px; margin: 0 auto; padding: 0 26px 14px; }

/* status strip directly above the input card: state + stop/kill */
.composer-status {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 32px;
  padding: 2px 6px 6px;
  font-size: 12px;
  color: var(--fg2);
}
.status-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  animation: composer-pulse 1.6s ease-in-out infinite;
}
@keyframes composer-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.composer-status[data-state="exited"] .status-dot { background: var(--orange); animation: none; }
.composer-status[data-state="gone"] .status-dot { background: var(--red); animation: none; }
.status-text { color: var(--fg2); }
.status-spacer { flex: 1; }
/* Stop / Kill run are REAL buttons — bordered pill shapes with a rest-state
   shape (not bare labels), and the destructive kill is red-tinted before you
   read it so the interrupt/destroy distinction is visible at a glance. */
.status-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.14);
  padding: 3px 11px;
  border-radius: 999px;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--fg);
  cursor: pointer;
  transition: color 0.12s, background 0.12s, border-color 0.12s;
}
.status-btn:hover { background: var(--surface2); border-color: rgba(255, 255, 255, 0.28); }
.status-btn:active { background: rgba(255, 255, 255, 0.1); }
/* keycap hint inside a pill button reads as plain muted glyphs (Cursor's
   "Stop ⇧⌘⌫"), not a second nested box */
.status-btn .kbd { border: none; background: none; padding: 0; min-width: 0; color: var(--fg3); }
.status-btn:hover .kbd { color: var(--fg2); }
.status-btn.danger {
  color: var(--red);
  background: rgba(240, 112, 112, 0.08);
  border-color: rgba(240, 112, 112, 0.38);
}
.status-btn.danger:hover { color: var(--red); background: rgba(240, 112, 112, 0.16); border-color: rgba(240, 112, 112, 0.6); }
.status-btn:disabled { opacity: 0.4; cursor: default; }
.status-btn[hidden] { display: none; }
/* Continue: the exited run's primary next step — contained accent pill */
.status-btn.continue {
  color: var(--accent);
  background: rgba(139, 124, 246, 0.07);
  border-color: rgba(139, 124, 246, 0.5);
}
.status-btn.continue:hover { background: rgba(139, 124, 246, 0.15); color: var(--accent); border-color: var(--accent); }

/* kbd glyph chips ("^C", "esc") used in the strip and the keys menu */
.kbd {
  font-family: var(--mono);
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--fg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
  min-width: 17px;
  text-align: center;
  background: rgba(255, 255, 255, 0.03);
}

/* the input card */
.composer-card {
  display: block;
  background: var(--surface);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 14px;
  padding: 10px 12px 9px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
  transition: border-color 0.15s;
}
.composer-card:focus-within { border-color: rgba(255, 255, 255, 0.18); }
.composer-card[hidden] { display: none; }

/* context chip row: @-mention button + run cwd chip */
.composer-context { display: flex; align-items: center; gap: 6px; margin-bottom: 7px; }
.ctx-at {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg3);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.ctx-at:hover { color: var(--fg); border-color: rgba(255, 255, 255, 0.28); background: var(--surface2); }
.ctx-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 2px 8px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg2);
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ctx-chip svg { flex: none; color: var(--fg3); }

.run-input {
  display: block;
  width: 100%;
  background: none;
  border: none;
  outline: none;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 13.5px;
  line-height: 1.5;
  padding: 2px 2px 12px;
}
.run-input::placeholder { color: var(--fg3); }

/* bottom control row: caret-marked disclosure chips (agent+model open the
   run-details popover, Keys opens the key menu) and the round send button */
.composer-row { display: flex; align-items: center; gap: 4px; }
.chip-wrap { position: relative; display: flex; min-width: 0; }
.keys-overlay, .run-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.48);
  z-index: 450;
}
.keys-overlay[hidden], .run-overlay[hidden] { display: none; }
.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: none;
  border: none;
  border-radius: 7px;
  padding: 3px 8px;
  font: inherit;
  font-size: 12px;
  color: var(--fg2);
  cursor: pointer;
  min-width: 0;
  transition: color 0.12s, background 0.12s;
}
.chip-btn:hover, .chip-btn[aria-expanded="true"] { color: var(--fg); background: var(--surface2); }
.chip-btn .caret { flex: none; color: var(--fg3); transition: transform 0.15s; }
.chip-btn[aria-expanded="true"] .caret { transform: rotate(180deg); }
.chip-btn[hidden] { display: none; }
.mode-chip { background: var(--surface2); font-weight: 600; color: var(--fg); padding: 3px 9px; }
.mode-chip:hover, .mode-chip[aria-expanded="true"] { background: rgba(255, 255, 255, 0.12); color: var(--fg); }
.mode-chip svg { color: var(--fg2); }
.chip-kbd { font-family: var(--mono); font-size: 10.5px; font-weight: 400; color: var(--fg3); }
.model-chip .model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* run-details popover: what this run IS (agent/model/dir/recording) and an
   honest note on what can still be steered mid-run */
.run-menu {
  position: absolute;
  left: 0;
  bottom: 34px;
  width: 340px;
  max-width: 72vw;
  background: #1d1d21;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  z-index: 10;
}
.run-menu[hidden] { display: none; }
.run-menu-grid { display: grid; grid-template-columns: 82px 1fr; gap: 5px 10px; padding: 3px 7px 7px; font-size: 12px; }
.rm-k { color: var(--fg3); }
.rm-v { color: var(--fg); overflow-wrap: anywhere; }
.rm-v.mono { font-family: var(--mono); font-size: 11.5px; color: var(--fg2); }
.rm-v a { color: var(--accent); text-decoration: none; }
.rm-v a:hover { text-decoration: underline; }
.run-menu-note {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  margin-top: 2px;
  padding: 7px 7px 4px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--fg3);
}
.composer-spacer { flex: 1; }
.keys-wrap { position: relative; display: flex; }
.keys-btn { color: var(--fg2); }
.keys-menu {
  position: absolute;
  right: 0;
  bottom: 32px;
  min-width: 168px;
  background: #1d1d21;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 5px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
  z-index: 10;
}
.keys-menu[hidden] { display: none; }
.keys-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--fg3);
  padding: 3px 7px 5px;
}
.run-key-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: none;
  padding: 5px 7px;
  border-radius: 6px;
  font: inherit;
  font-size: 12px;
  color: var(--fg2);
  text-align: left;
  cursor: pointer;
}
.run-key-btn:hover { background: var(--surface2); color: var(--fg); }
.run-key-btn .kbd { margin-left: auto; }

.run-send-btn {
  flex: none;
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: #111;
  cursor: pointer;
  transition: opacity 0.12s, transform 0.12s, background 0.15s, color 0.15s;
}
.run-send-btn:hover { opacity: 0.85; }
.run-send-btn:active { transform: scale(0.94); }
/* Empty input: the send arrow visibly stands down (muted circle, faint
   arrow) instead of reading fully active — typing lights it accent. */
.composer-card[data-empty="true"] .run-send-btn { background: rgba(255, 255, 255, 0.07); color: rgba(255, 255, 255, 0.4); }
.composer-card[data-empty="true"] .run-send-btn:hover { opacity: 1; background: rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.6); }
/* send-morphs-to-stop: over an EMPTY input while the agent is generating,
   the round button becomes a high-contrast STOP control (square glyph) —
   clicking it interrupts (^C), it never submits. Two icons live in the
   button; data-busy + data-empty pick which one shows. */
.run-send-btn .icon-stop { display: none; }
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn {
  background: rgba(255, 255, 255, 0.92);
  color: #17171a;
}
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn:hover { opacity: 1; background: #fff; color: #111; }
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn .icon-send { display: none; }
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn .icon-stop { display: block; }

/* live run feedback: while the linked session is generating, the strip text
   IS the run's current activity ("Generating", "Running npm test",
   "Editing fetch.js") with an animated typing ellipsis — never a static
   "Running" lie. The dots are real characters with staggered pulses (no
   content-in-keyframes tricks), shown only under data-busy. */
.status-dots { display: none; letter-spacing: 1px; margin-left: -6px; }
.composer-status[data-busy="true"] .status-dots { display: inline; }
.status-dots i {
  font-style: normal;
  animation: status-dot-pulse 1.2s ease-in-out infinite;
}
.status-dots i:nth-child(2) { animation-delay: 0.2s; }
.status-dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes status-dot-pulse { 0%, 100% { opacity: 0.15; } 50% { opacity: 1; } }

/* ---- client-held follow-up queue (there is NO server-side queue) ----
   Follow-ups submitted mid-generation are held HERE, visible above the
   status strip: "N in queue" collapsible header, rows with a Cursor-style
   ring glyph, click-to-edit text, and send-now / remove controls. */
.composer-queue { padding: 0 6px 2px; }
.composer-queue[hidden] { display: none; }
.queue-head {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: none;
  border: none;
  border-radius: 6px;
  padding: 3px 6px;
  font: inherit;
  font-size: 12px;
  color: var(--fg2);
  cursor: pointer;
}
.queue-head:hover { color: var(--fg); background: var(--surface2); }
.queue-head .caret { flex: none; color: var(--fg3); transition: transform 0.15s; }
.queue-head[aria-expanded="false"] .caret { transform: rotate(-90deg); }
.queue-list { padding: 1px 0 3px; }
.queue-list[hidden] { display: none; }
.queue-item {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 4px 6px;
  border-radius: 7px;
  font-size: 12.5px;
  color: var(--fg);
}
.queue-item:hover { background: var(--surface2); }
.queue-item[data-sending="true"] { opacity: 0.55; }
.queue-ring {
  flex: none;
  width: 12px;
  height: 12px;
  border: 1.5px solid var(--fg3);
  border-radius: 50%;
}
.queue-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.queue-act {
  flex: none;
  background: none;
  border: none;
  border-radius: 5px;
  padding: 1px 6px;
  font: inherit;
  font-size: 11.5px;
  color: var(--fg3);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, color 0.12s, background 0.12s;
  white-space: nowrap;
}
.queue-item:hover .queue-act, .queue-act:focus-visible { opacity: 1; }
.queue-act:hover { color: var(--fg); background: rgba(255, 255, 255, 0.08); }
.queue-note {
  font-size: 11px;
  color: var(--orange);
  padding: 1px 6px 4px;
}
.queue-note[hidden] { display: none; }

.run-input-error {
  color: var(--red);
  font-size: 12px;
  font-family: var(--mono);
  overflow-wrap: anywhere;
  margin-top: 6px;
}
.run-input-error[hidden] { display: none; }

/* ---- continue mode: the finished thread keeps a live composer ----
   The SAME input card the running composer uses, re-armed so typing IS the
   continue: submit forks the recorded session into a NEW run with the
   follow-up delivered. Terminal-only controls (Send key) retire; a chip
   states the fork semantics honestly. */
.composer-card[data-mode="continue"] .keys-wrap { display: none; }
.ctx-continue {
  color: var(--accent);
  border-color: rgba(139, 124, 246, 0.45);
}
.ctx-continue[hidden] { display: none; }
.composer-card[data-mode="continue"] { border-color: rgba(139, 124, 246, 0.28); }
.composer-card[data-mode="continue"]:focus-within { border-color: rgba(139, 124, 246, 0.55); }

/* vanished-cwd recovery: inline directory prompt inside the composer card */
.continue-cwd { display: flex; align-items: center; gap: 8px; margin: 0 2px 10px; }
.continue-cwd[hidden] { display: none; }
.continue-cwd-label {
  flex: none;
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--orange);
}
.continue-cwd-input {
  flex: 1;
  min-width: 0;
  background: none;
  border: 1px solid rgba(240, 160, 112, 0.45);
  border-radius: 7px;
  padding: 4px 9px;
  outline: none;
  color: var(--fg);
  font-family: var(--mono);
  font-size: 12px;
}
.continue-cwd-input:focus { border-color: rgba(240, 160, 112, 0.8); }

/* the follow-up in flight: an honest pending bubble until the fork
   recording links and the transcript carries the message for real */
.chat-user-pending { border-style: dashed; opacity: 0.9; }

/* observer variant: the continue composer sits under the observer card */
.observer-card + .composer-card { margin-top: 10px; }

/* ---- external live-session watch (read-only observer variant) ---- */
.composer-status[data-state="idle"] .status-dot { background: var(--fg3); animation: none; }
.readonly-chip {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--fg3);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  white-space: nowrap;
}
.observer-card {
  background: var(--surface);
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.28);
}
.observer-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--fg);
}
.observer-title svg { flex: none; color: var(--fg3); }
.observer-note {
  margin-top: 6px;
  font-size: 12px;
  line-height: 1.55;
  color: var(--fg2);
}
.observer-actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.observer-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--fg2);
  text-decoration: none;
  transition: color 0.12s, border-color 0.12s;
}
.observer-btn:hover { color: var(--fg); border-color: rgba(255, 255, 255, 0.25); }
.observer-btn.accent { color: var(--accent); }
button.observer-btn { background: none; font: inherit; font-size: 12px; cursor: pointer; }
button.observer-btn:disabled { opacity: 0.5; cursor: default; }

/* Exclusive footer slots. A growing/live recording ends the conversation
   column on ONE slim generating composer (#liveTailForm): Send a follow-up
   + Stop on the round send control. The archive ending (status strip,
   observer card, takeover #continueForm) is a separate slot and leaves
   the column — it is never restyled into the live tail, so Generating/Stop
   cannot stack on a second Send-a-follow-up bar. */
body[data-live-tail="1"] #archiveEnding,
body[data-live-tail="1"] .observer-card,
body[data-live-tail="1"] .readonly-chip,
body[data-live-tail="1"] .composer-status,
body[data-live-tail="1"] #continueForm { display: none; }
body[data-live-tail="1"] .chat-activity { min-height: 72px; }
body[data-live-tail="1"] .chat-col { padding-bottom: 56px; }

/* Identity-idle watch page (detectLiveSessions, not QUIET_MS growth):
   finished answer + one slim follow-up pill. The 350px archive pamphlet
   leaves the default view. Exclusive Stop (#liveTailForm) is
   data-live-tail, which follows identity generating — never the 4s
   quiet window — so these rules cannot hide a generating spinner by
   treating identity idle as "not growing". Idle #continueForm and live
   #liveTailForm share one pill chrome so the idle↔running swap is only
   the right control (send vs Stop). */
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .observer-card,
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .composer-status,
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .readonly-chip,
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .chat-activity {
  display: none;
}
body[data-watch="session"][data-run-state="idle"] .chat-col {
  padding-bottom: 4px;
}
/* File-less after-growth leftover is leftover-owned by the newest
   turn occupying leftover as a reading block (prose + honest absence
   + close). r9 collapsed leftover to a 55px pocket (flex:none +
   justify-content:flex-end) so leftover ceded to unused chat-main.
   Leftover (#chatScroll) fills leftover; newest prose sits at leftover
   top; the first dump is not leftover-owned. */
body[data-leftover-reading="1"] .chat-main {
  justify-content: flex-start;
}
body[data-leftover-reading="1"] #chatScroll {
  flex: 1;
  min-height: 0;
  margin-top: 0;
}
body[data-leftover-reading="1"][data-watch="session"][data-run-state="idle"] .chat-col {
  padding-top: 14px;
  padding-bottom: 4px;
}
/* Prior dump leaves leftover into #chatHistory for incremental stamps
   and full-text innerText, but is not leftover-owned: parked off leftover
   (not a 681px dump-on-fold sibling of leftover). r8 flex:1 leftover
   history painted user + L001–L023 on leftover. */
.chat-history {
  display: none;
  flex: none;
}
.chat-history[data-split="1"] {
  display: block;
  position: absolute;
  left: -9999px;
  top: 0;
  width: 760px;
  height: auto;
  overflow: visible;
  flex: none;
  pointer-events: none;
}
body[data-watch="session"][data-run-state="idle"] .chat-composer-inner {
  padding-top: 0;
  padding-bottom: 14px;
}
body[data-watch="session"][data-run-state="idle"] #continueForm {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 16px;
  border-radius: 22px;
  margin-top: 0;
  border-color: rgba(255, 255, 255, 0.10);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
}
body[data-watch="session"][data-run-state="idle"] #continueForm:focus-within {
  border-color: rgba(255, 255, 255, 0.18);
}
body[data-watch="session"][data-run-state="idle"] #continueForm[hidden] { display: none; }
body[data-watch="session"][data-run-state="idle"] #continueForm .composer-context { display: none; }
body[data-watch="session"][data-run-state="idle"] #continueForm .run-input {
  flex: 1;
  min-width: 0;
  padding: 4px 4px 4px 0;
}
body[data-watch="session"][data-run-state="idle"] #continueForm .composer-row { flex: none; }
.composer-card.live-tail-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 7px 16px;
  border-radius: 22px;
  border-color: rgba(255, 255, 255, 0.10);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
}
.live-tail-card .run-input {
  flex: 1;
  min-width: 0;
  padding: 4px 4px 4px 0;
}
.live-tail-card .composer-row { flex: none; }
.live-tail-card .run-send-btn {
  background: rgba(255, 255, 255, 0.92);
  color: #17171a;
}
.live-tail-card .run-send-btn .icon-send { display: none; }
.live-tail-card .run-send-btn .icon-stop { display: block; }
.live-tail-card[data-empty="false"][data-continuable="true"] .run-send-btn {
  background: var(--accent);
  color: #111;
}
.live-tail-card[data-empty="false"][data-continuable="true"] .run-send-btn .icon-send { display: block; }
.live-tail-card[data-empty="false"][data-continuable="true"] .run-send-btn .icon-stop { display: none; }
.live-tail-card[hidden] { display: none; }
.archive-ending[hidden] { display: none; }
${ansiPaletteCss()}
`;

/**
 * Shared chat-transcript client code — the conversation renderer used by
 * BOTH the run watch page and the read-only live-session watch page, so a
 * live session opened by hash gets the IDENTICAL transcript treatment as a
 * tracequest-launched run. The chunk assumes its embedding page declared:
 * runCwd, chatScroll/chatThread/chatActivity, openThoughts, lastBlocks,
 * lastSession, lastState, lastThreadHtml, lastActivityHtml, stopped, and a
 * mode-specific activityHtml() (hoisting makes declaration order moot).
 */
const CHAT_TRANSCRIPT_JS = `  /* ================= helpers ================= */

  function escHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function truncate(s, n) {
    s = String(s);
    return s.length > n ? s.slice(0, n - 1) + "\\u2026" : s;
  }
  function relPath(p) {
    p = String(p || "");
    if (runCwd && p.indexOf(runCwd + "/") === 0) return p.slice(runCwd.length + 1);
    if (runCwd && p === runCwd) return ".";
    return p;
  }
  function baseName(p) {
    var parts = String(p || "").split("/");
    return parts[parts.length - 1] || p;
  }
  function countLines(s) {
    return s ? String(s).split("\\n").length : 0;
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

  /* ---- tool presentation ---- */
  var ICON_TERM = '<svg class="card-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor"/><path d="M4.5 6l2 2-2 2" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M8.5 10.5h3" stroke="currentColor" stroke-linecap="round"/></svg>';
  var ICON_FILE = '<svg class="card-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1.5h5.5L13 5v9.5H4z" stroke="currentColor" stroke-linejoin="round"/><path d="M9.5 1.5V5H13" stroke="currentColor" stroke-linejoin="round"/></svg>';

  function bashBins(cmd) {
    var segs = String(cmd).split(/\\s*(?:\\|\\|?|&&|;)\\s*/);
    var bins = [];
    for (var i = 0; i < segs.length && bins.length < 3; i++) {
      var tok = segs[i].replace(/^\\s*(?:sudo\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*/, "").split(/\\s+/)[0] || "";
      tok = baseName(tok);
      if (tok && bins.indexOf(tok) < 0) bins.push(tok);
    }
    return bins;
  }
  function workspacePath(p) {
    p = relPath(String(p || "").replace(/^["']|["']$/g, ""));
    if (!p || p === "." || p === "./" || p === "/" || p === "./.") return "";
    return p;
  }
  function bashTitle(cmd) {
    // Verb-object investigation title from the first pipeline segment;
    // muted bins already name the rest ("ls, head" under the object).
    cmd = String(cmd).trim().split(/\\s*\\|\\s*/)[0].trim().replace(/^(?:sudo\\s+)/, "");
    var m;
    if (/^(?:rg|grep)\\b/.test(cmd)) {
      var pattern = "";
      var searchPath = "";
      if ((m = /["']([^"']{1,48})["']/.exec(cmd))) pattern = m[1];
      else if ((m = /^(?:rg|grep)\\s+(?:-\\S+\\s+)*(\\S{1,48})/.exec(cmd))) pattern = m[1];
      if ((m = /["'][^"']+["']\\s+(\\S+)/.exec(cmd))) searchPath = workspacePath(m[1]);
      else {
        var rest = cmd.replace(/^(?:rg|grep)\\s+(?:-\\S+\\s+)*/, "");
        var bits = rest.split(/\\s+/);
        if (!pattern && bits[0]) pattern = bits[0];
        if (bits[1]) searchPath = workspacePath(bits[1]);
      }
      var title = (/^rg\\b/.test(cmd) ? "Ripgrep for " : "Search for ") + (pattern || "strings");
      if (searchPath) title += " in " + searchPath;
      return title;
    }
    if (/^find\\b/.test(cmd)) {
      var name = "";
      var findPath = "";
      if ((m = /(?:-name|-iname)\\s+["']?([^\\s"']+)/.exec(cmd))) {
        name = m[1].replace(/^\\*+|\\*+$/g, "");
      }
      if ((m = /^find\\s+(\\S+)/.exec(cmd))) {
        if (m[1].charAt(0) !== "-") findPath = workspacePath(m[1]);
      }
      if (name && findPath) return "Find " + name + " files under " + findPath;
      if (name) return "Find " + name + " files";
      if (findPath) return "Find all files under " + findPath;
      return "Find all files under workspace";
    }
    if ((m = /^ls\\b\\s*(.*)/.exec(cmd))) {
      var lsArgs = (m[1] || "").replace(/^(?:-\\S+\\s*)+/, "").trim();
      var lsPath = workspacePath((lsArgs.split(/\\s+/)[0]) || "");
      if (!lsPath) return "List workspace root directory";
      return "List " + truncate(lsPath, 40) + " directory";
    }
    if ((m = /^(?:cat|head|tail|less)\\s+(?:-\\S+\\s+)*(\\S+)/.exec(cmd))) return "Read " + baseName(m[1]);
    if ((m = /^git\\s+(\\S+)/.exec(cmd))) return "Git " + m[1];
    if ((m = /^(?:npm|pnpm|yarn|npx)\\s+(.{1,36})/.exec(cmd))) return "Run " + m[1];
    if ((m = /^node\\s+(?:-\\S+\\s+)*(\\S+)/.exec(cmd))) return "Run " + baseName(m[1]);
    if (/^mkdir\\b/.test(cmd)) return "Create directory";
    if (/^(?:cp|rsync)\\b/.test(cmd)) return "Copy files";
    if (/^mv\\b/.test(cmd)) return "Move files";
    if (/^rm\\b/.test(cmd)) return "Remove files";
    if ((m = /^(?:curl|wget)\\b.*?(?:https?:\\/\\/([^\\/\\s"']+))/.exec(cmd))) return "Fetch " + m[1];
    return null;
  }
  var EXPLORE_TOOLS = { Grep: 1, Glob: 1, SemanticSearch: 1, ToolSearch: 1, WebSearch: 1 };
  function isExplore(tc) {
    if (EXPLORE_TOOLS[tc.name]) return true;
    if (tc.name === "Bash") return /^(?:rg|grep|find|ls|fd|head|tail|cat|wc|which|tree)\\b/.test(String(tc.input || "").trim());
    return false;
  }
  function toolTitle(tc) {
    var input = String(tc.input || "").trim();
    switch (tc.name) {
      case "Bash": {
        var t = bashTitle(input);
        if (t) return { title: truncate(t, 64), bins: bashBins(input) };
        return { title: truncate(input || "shell command", 64), bins: [], mono: true };
      }
      case "Grep": {
        var gBits = input.split(/\\s+/);
        var gPat = gBits[0] || "strings";
        var gPath = workspacePath(gBits.slice(1).join(" "));
        var gTitle = "Search for " + gPat + (gPath ? " in " + gPath : "");
        return { title: truncate(gTitle, 64), bins: ["grep"] };
      }
      case "Glob": return { title: truncate("Find files matching " + (input || "pattern"), 64), bins: ["glob"] };
      case "WebSearch": return { title: truncate("Search web for " + input, 64), bins: ["web"] };
      case "WebFetch": return { title: truncate("Fetch " + input, 64), bins: ["web"] };
      case "Agent": return { title: truncate(input || "Run subagent task", 64), bins: ["agent"] };
      case "TodoWrite": return { title: "Update todo list", bins: ["todo"] };
      case "Plan": return { title: "Update plan", bins: ["plan"] };
      case "Skill": return { title: truncate("Run skill " + input, 64), bins: ["skill"] };
      case "Ask": return { title: truncate(input || "Ask a question", 64), bins: ["ask"] };
      default: {
        var mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tc.name);
        if (mcp) return { title: truncate(mcp[2].replace(/_/g, " ") + (input ? " " + input : ""), 64), bins: [mcp[1]] };
        return { title: truncate(tc.name + (input ? " " + input : ""), 64), bins: [] };
      }
    }
  }
  function threadItem(key, role, className, inner, eventIndex) {
    var item = { key: key, role: role, className: className, innerHTML: inner };
    if (typeof eventIndex === "number") item.eventIndex = eventIndex;
    return item;
  }
  function toolResultHtml(b) {
    var text = b.res && b.res.text;
    if (!text) return "";
    return '<pre class="chat-tool-body">' + escHtml(text) + "</pre>";
  }
  function outputLineMeta(text) {
    var n = countLines(String(text).replace(/\\n$/, ""));
    return n <= 1 ? "1 line" : "Lines 1-" + n;
  }
  function outputCardName(tc) {
    var input = String(tc.input || "").trim();
    if (tc.name === "Read" || tc.name === "Edit" || tc.name === "Write") {
      return relPath(input) || tc.name;
    }
    if (tc.name === "Bash") {
      var file = /^(?:sudo\\s+)?(?:cat|head|tail|less|bat|nl)\\s+(?:-\\S+\\s+)*(\\S+)/.exec(input);
      if (file) return relPath(file[1]) || file[1];
      var titled = bashTitle(input);
      return titled || "shell output";
    }
    return tc.name || "output";
  }
  function outputCardItem(b, key) {
    var tc = b.tc;
    var text = b.res.text;
    var err = !!(b.res && b.res.isError);
    var running = b.running ? " running" : "";
    var icon = b.running ? '<span class="spinner"></span>' : ICON_FILE;
    var name = outputCardName(tc);
    var meta = outputLineMeta(text);
    // Named card after the complete assistant prose: header + actual body.
    var item = threadItem(key, "tool", "chat-card chat-output tool-card" + (err ? " err" : "") + running,
      '<div class="chat-card-head chat-output-head">' +
        icon +
        '<span class="chat-output-name">' + escHtml(name) + "</span>" +
        '<span class="chat-output-meta">' + escHtml(meta) + "</span>" +
        (err ? '<span class="card-err">error</span>' : "") +
      "</div>" +
      '<pre class="chat-tool-body">' + escHtml(text) + "</pre>");
    item.output = { name: name, meta: meta, text: text, err: err };
    return item;
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
  function toolBlockItem(b, idx, key) {
    var tc = b.tc;
    var running = b.running ? " running" : "";
    var body = toolResultHtml(b);
    var hasBody = !!(b.res && b.res.text);
    // Long (or any) result body becomes a named output card that paints
    // every advertised line. Edit/Write keep their file +N/-N head.
    if (hasBody && tc.name !== "Edit" && tc.name !== "Write") return outputCardItem(b, key);
    if (tc.name === "Read") {
      var label = b.running ? '<span class="shimmer">Read</span>' : '<span class="tl1">Read</span>';
      return threadItem(key, "tool", "chat-toolline tool-card",
        '<span class="chat-toolline-head">' + label + ' <span class="tl2">' + escHtml(relPath(tc.input)) + "</span></span>" + body);
    }
    if (tc.name === "Edit" || tc.name === "Write") {
      var di = tc.diffInfo || {};
      var added = tc.name === "Write" ? countLines(di.content) : countLines(di.newStr);
      var removed = tc.name === "Write" ? 0 : countLines(di.oldStr);
      var icon = b.running ? '<span class="spinner"></span>' : ICON_FILE;
      return threadItem(key, "tool", "chat-card file tool-card" + running,
        '<div class="chat-card-head">' +
        icon +
        '<span class="file-name">' + escHtml(relPath(tc.input)) + "</span>" +
        '<span class="plus">+' + added + '</span><span class="minus">-' + removed + "</span>" +
        (b.res && b.res.isError ? '<span class="card-err">error</span>' : "") +
        "</div>" + body);
    }
    var t = toolTitle(tc);
    var iconHtml = b.running ? '<span class="spinner"></span>' : ICON_TERM;
    var titleCls = "card-title" + (t.mono ? " mono" : "");
    var titleHtml = b.running
      ? '<span class="' + titleCls + '"><span class="shimmer">' + escHtml(t.title) + "</span></span>"
      : '<span class="' + titleCls + '">' + escHtml(t.title) + "</span>";
    var err = b.res && b.res.isError;
    return threadItem(key, "tool", "chat-card tool-card" + (err ? " err" : "") + running,
      '<div class="chat-card-head">' +
      iconHtml + titleHtml +
      (t.bins.length ? '<span class="card-bins">' + escHtml(t.bins.join(", ")) + "</span>" : "") +
      (err ? '<span class="card-err">error</span>' : "") +
      "</div>" + body);
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
    var key = (b.kind === "tool" && b.tc && b.tc.id) ? "tool:" + b.tc.id : b.kind + ":" + idx;
    var ev = b.eventIndex;
    var item;
    if (b.kind === "user") item = threadItem(key, "user", "chat-user chat-message", escHtml(b.text), ev);
    else if (b.kind === "text") {
      item = threadItem(key, "assistant", "chat-assistant chat-message", md(b.text), ev);
      item.sourceText = b.text;
    } else if (b.kind === "thought") {
      var open = !!openThoughts[idx];
      item = threadItem(key, "thought", "chat-thought",
        '<button class="chat-thought-toggle" type="button" data-ti="' + idx + '">' +
        '<span class="m1">Thought</span> <span class="m2">' + (b.dur ? escHtml(b.dur) : "briefly") + "</span></button>" +
        '<div class="chat-thinking"' + (open ? "" : " hidden") + ">" + escHtml(b.text) + "</div>", ev);
    } else if (b.kind === "errnote") {
      item = threadItem(key, "error", "chat-errnote chat-message", escHtml(b.text), ev);
    } else {
      item = toolBlockItem(b, idx, key);
      if (typeof ev === "number") item.eventIndex = ev;
    }
    return item;
  }
  function renderItems(blocks) {
    var items = [];
    var i = 0;
    while (i < blocks.length) {
      var b = blocks[i];
      if (b.kind === "tool" && isExplore(b.tc)) {
        var j = i;
        while (j < blocks.length && blocks[j].kind === "tool" && isExplore(blocks[j].tc)) j++;
        var n = j - i;
        if (n >= 2) {
          items.push(threadItem("explore:" + i, "marker", "chat-marker",
            '<span class="m1">Explored</span> <span class="m2">' + escHtml(n + " searches") + "</span>",
            blocks[i].eventIndex));
        }
        for (; i < j; i++) items.push(blockItem(blocks[i], i));
        continue;
      }
      items.push(blockItem(b, i));
      i++;
    }
    return items;
  }
  function renderBlocks(blocks) {
    var items = renderItems(blocks);
    var html = "";
    for (var r = 0; r < items.length; r++) {
      var it = items[r];
      html += '<div class="' + it.className + '" data-role="' + it.role + '" data-block-key="' + escHtml(it.key) + '">' + it.innerHTML + "</div>";
    }
    return html;
  }
  ${APPLY_THREAD_ITEMS_SRC}

  /* ---- sticky scroll: live sticks to the generating trail; a
     completed idle turn frames the last user bubble so the prompt
     and the whole assistant sit in the viewport as one reading block.

     followTail remembers that the user is at the conversation end
     (idle leftover-snap frame counts). Sample it BEFORE live chrome
     CSS (activity min-height + col padding) or prior-turn parking
     changes scrollHeight — otherwise isAtBottom() goes false and
     Planning next moves sits below the fold. ---- */
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
  // Prior dump leaves leftover into #chatHistory so leftover-owned
  // pixels are the newest turn. History keeps the same nodes (applyThreadItems
  // restores first so incremental stamps hold; hidden=false so full-text
  // innerText still sees L001–L023) but is not leftover-owned — parked
  // off leftover, not flex:1 leftover. r8 painted user + L001–L023 on leftover.
  function splitPriorOffLeftover() {
    var col = historyCol();
    var root = historyRoot();
    var newest = lastThreadEl(".chat-assistant");
    var own = newestTurnOwnFile();
    if (!col || !root || !newest || !chatThread) return;
    if (root.getAttribute("data-split") === "1" && newest.parentNode === chatThread) {
      return;
    }
    restoreThreadFromHistory();
    newest = lastThreadEl(".chat-assistant");
    own = newestTurnOwnFile();
    if (!newest) return;
    var kids = Array.prototype.slice.call(chatThread.children);
    var i;
    for (i = 0; i < kids.length; i++) {
      if (kids[i] === newest || kids[i] === own) break;
      col.appendChild(kids[i]);
    }
    root.hidden = false;
    root.setAttribute("data-split", "1");
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
  // leftover (prose at leftover top + honest absence + close). First
  // dump is not leftover-owned — it leaves leftover into hidden
  // #chatHistory (not a 681px dump-on-fold). Do not stretch the
  // caption (r4), do not pin it with margin-top (r6), do not
  // pad-bottom hoist (r7), do not shrink leftover to a 55px pocket
  // that cedes leftover to unused chat-main (r9).
  function frameNewestTurnAtLeftoverTop() {
    if (!chatScroll) return;
    var newest = lastThreadEl(".chat-assistant");
    if (!newest) return;
    clearNewestProseLeftover(newest);
    splitPriorOffLeftover();
    newest = lastThreadEl(".chat-assistant");
    if (!newest) return;
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
  function parkNode(el) {
    if (!el) return;
    el.style.maxHeight = "0px";
    el.style.height = "0px";
    el.style.minHeight = "0px";
    el.style.overflow = "hidden";
    el.style.marginTop = "0px";
    el.style.marginBottom = "0px";
    el.style.paddingTop = "0px";
    el.style.paddingBottom = "0px";
    el.style.borderWidth = "0px";
    el.removeAttribute("data-trail");
    el.setAttribute("data-contained", "parked");
    var body = el.querySelector(".chat-tool-body");
    if (body) {
      body.style.height = "0px";
      body.style.maxHeight = "0px";
      body.style.padding = "0";
      body.style.overflow = "hidden";
      body.style.border = "none";
      body.style.margin = "0";
    }
  }
  // This turn starts at the first live-work event after leftover-snap.
  // Later assistant events accumulate on the fold — ls | head stays
  // when find / rg leftover arrive.
  // A completed measure-append with no following assistant/output is
  // a prior event once later tool_use arrives — not this turn. The
  // last completed assistant (dump + named file) parks; this-turn
  // cards grow in place.
  function thisTurnEventIndex() {
    var blocks = lastBlocks || [];
    var lastUser = -1;
    var lastAsst = -1;
    var firstLive = -1;
    var i;
    for (i = 0; i < blocks.length; i++) {
      var b = blocks[i];
      if (b.kind === "user") lastUser = i;
      if (b.kind === "text" || b.kind === "thought" || b.kind === "tool" || b.kind === "errnote") {
        if (typeof b.eventIndex === "number") lastAsst = b.eventIndex;
      }
      if (b.kind === "tool" && b.running && typeof b.eventIndex === "number") {
        if (firstLive < 0) firstLive = b.eventIndex;
      }
    }
    // Skip leftover-snap dump + its completed named-output tools,
    // then tool-less completed assistants. Remaining events are
    // this turn and must stay as later assistants land.
    var i0 = lastUser + 1;
    while (i0 < blocks.length && blocks[i0].kind === "thought") i0++;
    if (i0 < blocks.length && blocks[i0].kind === "text") {
      var dumpEv = blocks[i0].eventIndex;
      i0++;
      var hadOutput = false;
      while (i0 < blocks.length && blocks[i0].eventIndex === dumpEv) {
        if (blocks[i0].kind === "tool" && blocks[i0].res) hadOutput = true;
        i0++;
      }
      if (hadOutput) {
        while (i0 < blocks.length) {
          var ev = blocks[i0].eventIndex;
          if (typeof ev !== "number") break;
          var j = i0;
          var hasTools = false;
          while (j < blocks.length && blocks[j].eventIndex === ev) {
            if (blocks[j].kind === "tool") hasTools = true;
            j++;
          }
          if (hasTools) break;
          if (blocks[i0].kind !== "text" && blocks[i0].kind !== "thought") break;
          i0 = j;
        }
      }
    }
    for (i = i0; i < blocks.length; i++) {
      if (typeof blocks[i].eventIndex === "number") return blocks[i].eventIndex;
    }
    if (firstLive >= 0) return firstLive;
    return lastAsst;
  }
  // Own-file newest turn: park every node before that turn so leftover
  // leftover-snaps prose + that file + close (not a 475px prior uncap).
  function parkFirstDumpOffLeftover() {
    parkPriorCompletedTurn();
    if (!chatThread) return;
    var anchor = newestTurnAnchor();
    var kids = chatThread.children;
    var i;
    for (i = 0; i < kids.length; i++) {
      if (kids[i] === anchor) break;
      parkNode(kids[i]);
    }
  }
  // File-less newest: first dump stays in-flow at natural height so
  // leftover-snap can scroll it off leftover via scrollTop. Prior
  // fixture stays data-contained=parked (honest absence of a file).
  // r6 collapsed user + dump to height:0 and then spacer-pinned the
  // caption — leftover became unused column.
  function parkPriorFixtureOnly() {
    var own = newestTurnOwnFile();
    var anchor = newestTurnAnchor();
    var scopes = [];
    if (historyCol()) scopes.push(historyCol());
    if (chatThread) scopes.push(chatThread);
    var s;
    for (s = 0; s < scopes.length; s++) {
      var kids = scopes[s].children;
      var i;
      for (i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (el === anchor) break;
        if (el.classList.contains("chat-output") && el !== own) parkNode(el);
        else if (el.getAttribute("data-contained") === "parked") unparkNode(el);
      }
    }
  }
  // Live generating: keep this turn's cards under the prompt as they
  // grow. Park every earlier event (dump, named file object, and
  // the last completed assistant) at height 0 — not a 22px costume.
  // Advertised bytes stay in the nodes so full-text / incremental
  // stamps hold. This turn's tools and in-progress prose stay.
  function parkPriorCompletedTurn() {
    if (!chatThread) return;
    var liveEv = thisTurnEventIndex();
    var kids = chatThread.children;
    var lastUser = -1;
    var i;
    for (i = 0; i < kids.length; i++) {
      if (kids[i].classList.contains("chat-user")) lastUser = i;
    }
    var firstLive = -1;
    for (i = lastUser + 1; i < kids.length; i++) {
      var ev = parseInt(kids[i].getAttribute("data-event-index"), 10);
      if (liveEv >= 0 && !isNaN(ev) && ev >= liveEv) {
        firstLive = i;
        break;
      }
    }
    for (i = 0; i < kids.length; i++) {
      var el = kids[i];
      if (i <= lastUser) {
        if (el.getAttribute("data-contained") === "parked") unparkNode(el);
        continue;
      }
      var prior = firstLive >= 0 ? i < firstLive : false;
      if (prior) parkNode(el);
      else if (el.getAttribute("data-contained") === "parked") unparkNode(el);
    }
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
  // live-parked nodes; leftover layout parks leftover-non-owned
  // (user, lsof/ps, thoughts) off leftover so leftover-owned opening
  // + named + closing occupy leftover. The named card fillLeftover-
  // snaps in place — not a 12-line island under the user prompt, not
  // data-contained=parked, not split into #chatHistory.
  function leftoverOccupyingNamedCard() {
    if (!chatThread) return null;
    var cards = chatThread.querySelectorAll(".chat-card.chat-output");
    return cards.length ? cards[cards.length - 1] : null;
  }
  function leftoverSnapNamedColumn() {
    var named = leftoverOccupyingNamedCard();
    if (!named || !chatThread) return;
    var cards = chatThread.querySelectorAll(".chat-card.chat-output");
    var i;
    for (i = 0; i < cards.length; i++) {
      if (cards[i] !== named) parkNode(cards[i]);
    }
    var kids = chatThread.children;
    var start = -1;
    for (i = 0; i < kids.length; i++) {
      if (kids[i] === named) { start = i; break; }
    }
    if (start > 0 && kids[start - 1].classList.contains("chat-assistant")) start--;
    for (i = 0; i < start; i++) parkNode(kids[i]);
    var opening = start >= 0 && kids[start] && kids[start] !== named ? kids[start] : null;
    var closing = null;
    for (i = kids.length - 1; i > start; i--) {
      if (kids[i] !== named && kids[i].classList.contains("chat-assistant")) {
        closing = kids[i];
        break;
      }
    }
    for (i = start; i < kids.length; i++) {
      if (kids[i] === named || kids[i] === opening || kids[i] === closing) continue;
      parkNode(kids[i]);
    }
    if (opening) unparkNode(opening);
    unparkNode(named);
    if (closing) unparkNode(closing);
    document.body.setAttribute("data-leftover-owned", "named-column");
    snapNamedOutputCard(named, true);
  }
  function containNamedOutput() {
    if (!chatScroll || !chatThread) return;
    var cards = chatThread.querySelectorAll(".chat-card.chat-output");
    if (lastState === "running") {
      // Do not leftover-snap-uncap: an expanded previous fixture card
      // or 511px assistant dump spends the fold. Park every prior
      // assistant event off the fold so the first things under the
      // prompt are this turn's tools, not leftover completed prose.
      parkPriorCompletedTurn();
      clearNewestProseLeftover(lastThreadEl(".chat-assistant"));
      clearLeftoverScrollPad();
      sizeLiveAir();
      return;
    }
    if (leftoverSnapIsStale()) {
      // Leftover-owned pixels are the newest completed turn occupying
      // leftover as a reading block. Own-file: park the first dump and
      // leftover-snap prose + that file + close.
      // File-less: leftover (#chatScroll) fills leftover
      // (data-leftover-reading) so leftover-owned is that turn at
      // leftover top + honest absence + close — not a 55px pocket
      // that cedes leftover to unused chat-main (r9).
      // First dump is not leftover-owned — #chatHistory keeps the
      // nodes (full-text innerText) but does not paint leftover
      // (r8 681px dump-on-fold).
      // Prior fixture stays parked; do not leftover-snap the first
      // dump's fixture in place (r5), do not staple it under the
      // marker (r3), do not stretch the 39px caption (r4 701px air),
      // do not uncap the 475px fixture (r1), do not claim leftover
      // with a margin-top spacer (r6), do not pad-bottom hoist (r7
      // padding-bottom hoisting a 39px caption).
      if (newestTurnOwnFile()) {
        clearLeftoverScrollPad();
        parkFirstDumpOffLeftover();
        leftoverSnapNewestTurnReading();
      } else {
        parkPriorFixtureOnly();
        splitPriorOffLeftover();
        occupyLeftoverAsNewestReading(lastThreadEl(".chat-assistant"));
        clearNewestProseLeftover(lastThreadEl(".chat-assistant"));
      }
      sizeLiveAir();
      return;
    }
    unparkAll();
    sizeLiveAir();
    if (!cards.length) return;
    leftoverSnapNamedColumn();
  }

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
    var threadHtml = renderBlocks(lastBlocks);
    var stick = followTail || isAtBottom();
    if (threadHtml !== lastThreadHtml) {
      restoreThreadFromHistory();
      restoreLeftoverViewport();
      applyThreadItems(chatThread, items);
      lastThreadHtml = threadHtml;
    }
    syncOutputPane(items);
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
      requestAnimationFrame(function () {
        if (shouldFrameCompletedTurn()) frameCompletedTurn();
        containNamedOutput();
        if (leftoverSnapIsStale()) leftoverSnapNewestTurn();
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
    var t = ev.target && ev.target.closest ? ev.target.closest(".chat-thought-toggle") : null;
    if (t) {
      var idx = t.getAttribute("data-ti");
      var pre = t.parentNode.querySelector(".chat-thinking");
      if (!pre) return;
      pre.hidden = !pre.hidden;
      if (pre.hidden) delete openThoughts[idx];
      else openThoughts[idx] = true;
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
  const chatState = exited
    ? "exited"
    : (run.sessionPath ? (generating ? "running" : "idle") : "pending");
  const composerState = exited ? "exited" : (generating ? "running" : "idle");
  const composerText = exited ? "Agent exited" : (generating ? "Running" : "Idle");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
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
      <span class="session-source" style="background:${sourceColor(agent)}">${esc(agent)}</span>
      <span class="session-id" id="chatSessionId" title="run ${esc(id)}">${esc(id)}</span>
      <span class="session-model" id="chatModel" hidden></span>
      <span class="session-project" title="${esc(cwd)}">${esc(cwd.split("/").filter(Boolean).pop() || cwd || "cwd")}</span>
      <span class="session-grade-badge run-grade" id="runGrade" hidden></span>${resumedFrom ? `
      <a class="run-continued-from" id="continuedFrom" href="/view?id=${encodeURIComponent(resumedFrom)}" title="This run continues session ${esc(resumedFrom)} — open the original recording">&#8635;&#xFE0E; continued from ${esc(resumedFrom)}</a>` : ""}
      <span class="chat-top-spacer"></span>
      <span class="run-started" data-started="${esc(startedAt)}">started ${esc(startedAt)}</span>
      ${ANALYTICS_TOGGLE_HTML}
      <a class="run-view-link" id="viewSessionLink" title="Show this run's analytics" hidden>view session</a>
      <a class="run-back" href="/sessions">&larr; sessions</a>
    </div>
    <div class="session-stats chat-head-stats" id="chatStats" hidden></div>
  </header>
  <div class="chat-body">
  <div class="chat-main">
  <div class="chat-history" id="chatHistory" hidden>
    <div class="chat-col" id="chatHistoryCol"></div>
  </div>
  <div class="chat-scroll" id="chatScroll">
    <div class="chat-col">
      <div class="chat-thread" id="chatThread"></div>
      <div class="chat-activity" id="chatActivity"></div>
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
        <button class="status-btn" id="stopBtn" type="button" title="Interrupt the agent — sends Ctrl-C to its terminal; the run stays attached"${generating ? "" : " hidden"}>Stop <span class="kbd">^C</span></button>
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
    <div class="run-menu-note">Agent &amp; model are fixed at launch &mdash; steer the run with follow-ups and keys. Stop sends ^C to interrupt the agent; Kill run ends its tmux window. The transcript is preserved either way.</div>
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
  var openThoughts = {};
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
      var viewHref = "/view?path=" + encodeURIComponent(data.sessionPath);
      viewSessionLink.href = viewHref;
      viewSessionLink.hidden = false;
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
        sendBtn.title = "Stop generating \\u2014 sends ^C to the agent's terminal (Enter in the input still sends a bare Enter)";
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
    sendInput({ key: "C-c" });
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
    // Stop = interrupt the agent (Ctrl-C into its tty), not kill the run.
    stopBtn.disabled = true;
    await sendInput({ key: "C-c" });
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
export function liveSessionPage({ session } = {}) {
  const { hash, path, source, live } = session;
  const project = session.project || "";
  const run = session.run || null;
  const continuable = Boolean(session.continuable);
  const agent = session.agent || null;
  const viewHref = `/view?path=${encodeURIComponent(path)}`;
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
      <span class="session-source" style="background:${sourceColor(source)}">${esc(source)}</span>
      <span class="session-id" id="chatSessionId">${esc(hash)}</span>
      <span class="session-model" id="chatModel" hidden></span>
      <span class="session-project" title="${esc(path)}">${esc(project || path.split("/").filter(Boolean).pop() || path)}</span>
      <span class="session-grade-badge run-grade" id="runGrade" hidden></span>
      <span class="run-origin" title="This session was started outside tracequest — its own terminal drives it">external</span>
      <span class="chat-top-spacer"></span>
      ${ANALYTICS_TOGGLE_HTML}
      <a class="run-view-link" id="viewSessionLink" href="${esc(viewHref)}" title="Show this recording's analytics" data-analytics-label="${esc(hash)}">view session</a>
      <a class="run-back" href="/sessions">&larr; sessions</a>
    </div>
    <div class="session-stats chat-head-stats" id="chatStats" hidden></div>
  </header>
  <div class="chat-body">
  <div class="chat-main">
  <div class="chat-history" id="chatHistory" hidden>
    <div class="chat-col" id="chatHistoryCol"></div>
  </div>
  <div class="chat-scroll" id="chatScroll">
    <div class="chat-col">
      <div class="chat-thread" id="chatThread"></div>
      <div class="chat-activity" id="chatActivity"></div>
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
        <input class="run-input" id="liveTailInput" type="text" placeholder="Send a follow-up" autocomplete="off" spellcheck="false" aria-label="Send a follow-up">
        <div class="composer-row">
          <button class="run-send-btn" id="liveTailStop" type="button" aria-label="Stop" title="Stop — this session is driven outside tracequest; interrupt it in its own terminal">
            <svg class="icon-send" width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <svg class="icon-stop" width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="3.5" y="3.5" width="9" height="9" rx="1.6" fill="currentColor"/></svg>
          </button>
        </div>
      </form>
      <div class="run-input-error" id="continueError" role="alert" hidden></div>
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
<script>
${shellClientScript({ current: { type: "session", id: hash }, defaultCwd: "" })}
</script>
<script>
(function () {
  var sessionHandle = ${JSON.stringify(hash)};
  var SESSION_POLL_MS = ${SESSION_POLL_MS};
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
  var openThoughts = {};
  var lastGrowthAt = 0;
  var QUIET_MS = 4000;
  var apiLive = ${JSON.stringify(!!live)};
${CHAT_TRANSCRIPT_JS}
  /* watch-page activity marker: live shimmer, honest idle line */
  function activityHtml() {
    if (stopped) return "";
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

  /* ---- session loop (~1s, etag flow — never stops while the page lives) ---- */
  function scheduleSession() {
    if (stopped) return;
    if (document.hidden) { setChatPollingFlag(false); return; }
    setChatPollingFlag(true);
    sessTimer = setTimeout(pollSession, SESSION_POLL_MS);
  }
  function applySession(data) {
    apiLive = data.state === "running";
    if (!data.unchanged && data.session) {
      if (data.etag && data.etag !== lastEtag) {
        var mt = parseInt(String(data.etag).split("-")[0], 10);
        lastGrowthAt = mt > 0 ? mt : Date.now();
      }
      lastSession = data.session;
      lastEtag = data.etag;
      if (lastSession.cwd) runCwd = lastSession.cwd;
    }
    setWatchState(deriveWatchLive() ? "running" : "idle");
    rerender();
  }
  async function pollSession() {
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
<title>tracequest</title>
${THEME_BOOT_SCRIPT}
<style>
${STANDALONE_BASE_CSS}
${RUN_PAGE_CSS}
${APP_SHELL_CSS}
${LAUNCHER_MODAL_CSS}
${COMMAND_PALETTE_CSS}
.chat-empty {
  max-width: 760px;
  margin: 0 auto;
  padding: 56px 26px 24px;
  color: var(--fg3);
  font-size: 13px;
  line-height: 1.5;
  text-align: center;
}
.chat-empty-title {
  color: var(--fg2);
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 8px;
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
