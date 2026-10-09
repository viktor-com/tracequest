/**
 * Chat (/, /run?id=, /run?session=) — the live surface. A quiet session
 * rail on the left, one reading column for the conversation, and the
 * composer docked at the bottom. Rules that encode behaviour (exclusive
 * live-tail vs archive slots, parked events, measured output bodies) keep
 * their exact semantics; everything visual is the design system.
 */

/** Rail + chat frame (shared by every chat document). */
export const CHAT_SHELL_CSS = `
.tq-shell { display: flex; flex-direction: column; height: 100%; }
.shell-main { display: flex; flex: 1; min-height: 0; }

/* ---- session rail ---- */
.agent-rail {
  width: 304px; flex: none; display: flex; flex-direction: column; min-height: 0;
  box-shadow: inset -1px 0 0 var(--line-1); background: var(--bg);
}
.rail-head {
  display: flex; align-items: center; gap: 8px; flex: none;
  padding: 14px 12px 10px 18px; font-size: var(--text-xs); color: var(--text-3);
}
.rail-count { color: var(--ok); font-variant-numeric: tabular-nums; }
.rail-filter-toggle {
  margin-left: auto; flex: none; width: 26px; height: 26px; display: inline-grid; place-items: center;
  border: 0; border-radius: var(--radius-pill); background: none; color: var(--text-3); cursor: pointer;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.rail-filter-toggle:hover { background: var(--hover); color: var(--text); }
.rail-filter-toggle.has-value { background: var(--surface-3); color: var(--text); }
.rail-filter-toggle svg { width: 14px; height: 14px; display: block; }
.agent-rail:not(.filters-open) .rail-filters-extra { display: none; }
.rail-list { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 2px 8px 10px; display: flex; flex-direction: column; gap: 1px; }
.rail-row {
  display: flex; align-items: flex-start; gap: 10px; padding: 9px 10px; border-radius: var(--radius-md); min-width: 0;
  color: var(--text); text-decoration: none; cursor: pointer;
  transition: background var(--dur-1) var(--ease-out);
}
.rail-row:hover { background: var(--hover); }
.rail-row[aria-current="page"] { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-1); }
.rail-glyph {
  flex: none; width: 14px; height: 14px; margin-top: 3px; display: inline-grid; place-items: center;
  border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--line-3); color: var(--text-3); font-size: 9px;
}
.rail-glyph[data-status="running"] { box-shadow: none; }
.rail-glyph[data-status="running"]::before {
  content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok);
  animation: ui-pulse 2.2s var(--ease-out) infinite;
}
@keyframes rail-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.rail-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.rail-title {
  font-size: var(--text-sm); line-height: 1.4; color: var(--text); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.rail-sub { font-size: var(--text-xs); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-sub .rail-agent { display: inline-flex; align-items: center; gap: 5px; font-weight: var(--weight-regular); color: var(--text-2) !important; }
.rail-sub .rail-agent::before { content: ""; width: 6px; height: 6px; border-radius: 2px; background: var(--hue, currentColor); }
.rail-side { flex: none; display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.rail-time { font-size: 11px; color: var(--text-3); white-space: nowrap; font-variant-numeric: tabular-nums; }
.rail-grade { font-size: 10.5px; min-width: 18px; height: 16px; padding: 0 4px; }
.rail-empty { padding: var(--space-6) var(--space-3); font-size: var(--text-sm); color: var(--text-3); text-align: center; }
.rail-all {
  flex: none; display: flex; align-items: center; gap: 6px; padding: 12px 18px;
  box-shadow: inset 0 1px 0 var(--line-1); font-size: var(--text-xs); color: var(--text-3); text-decoration: none;
  transition: color var(--dur-2) var(--ease-out);
}
.rail-all:hover { color: var(--text); }

/* rail filters reuse the Runs filter vocabulary at rail scale */
.rail-filters {
  flex: none; display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px;
  box-shadow: inset 0 -1px 0 var(--line-1); max-height: 46%; overflow-x: hidden; overflow-y: auto;
}
.rail-filter-wrap { position: relative; }
.rail-filters .filter-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: var(--control-md); padding: 2px 10px;
  border-radius: var(--radius-pill); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2);
  transition: box-shadow var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.rail-filters .filter-bar:focus-within { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--focus); }
.rail-filters .filter-input { flex: 1; min-width: 0; height: 26px; border: 0; outline: none; background: none; color: var(--text); font-size: var(--text-xs); }
.rail-filters .filter-input::placeholder { color: var(--text-3); }
.rail-filters .filter-hint { display: none; }
.rail-toolbar { position: relative; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
.rail-filters .toolbar-pop { position: relative; }
.rail-filters .toolbar-btn {
  width: 100%; height: 28px; padding: 0 10px; border-radius: var(--radius-pill); border: 0; cursor: pointer;
  font-size: var(--text-xs); color: var(--text-2); background: var(--surface-1); text-align: left;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.rail-filters .toolbar-btn:hover { background: var(--surface-2); color: var(--text); }
.rail-filters .toolbar-btn.active, .rail-filters .toolbar-btn.has-value { background: var(--surface-3); color: var(--text); }
.rail-filters .toolbar-menu {
  position: absolute; left: 0; top: calc(100% + 6px); z-index: var(--z-popover); min-width: 200px; padding: 4px;
  display: flex; flex-direction: column; border-radius: var(--radius-lg); background: var(--surface-pop); box-shadow: var(--shadow-pop);
}
.rail-filters .toolbar-menu[hidden] { display: none; }
.rail-filters .toolbar-option {
  display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 10px; border-radius: var(--radius-sm);
  border: 0; background: none; cursor: pointer; font-size: var(--text-xs); color: var(--text-2); text-align: left;
}
.rail-filters .toolbar-option:hover { background: var(--surface-3); color: var(--text); }
.rail-filters .toolbar-option.active { color: var(--text); background: var(--surface-3); }
.rail-filters .toolbar-option-count { margin-left: auto; color: var(--text-3); font-variant-numeric: tabular-nums; }
.rail-filters .sort-bar { padding: 4px; }
.rail-filters .sort-label { padding: 4px 8px; font-size: 11px; color: var(--text-3); }
.rail-filters .sort-btn {
  display: flex; align-items: center; height: 26px; padding: 0 10px; border-radius: var(--radius-sm); border: 0; background: none;
  cursor: pointer; font-size: var(--text-xs); color: var(--text-2); text-transform: capitalize; text-align: left;
}
.rail-filters .sort-btn:hover { background: var(--surface-3); color: var(--text); }
.rail-filters .sort-btn.active { background: var(--surface-3); color: var(--text); }
.rail-overview { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-1); }
.rail-overview .dashboard-header { display: flex; align-items: baseline; gap: 6px; }
.rail-overview .dashboard-title { font-size: 11px; color: var(--text-3); }
.rail-overview .dashboard-scope { font-size: 11px; color: var(--text-3); }
.rail-overview .dashboard-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 10px; }
.rail-overview .dashboard-stat { display: flex; align-items: baseline; gap: 5px; min-width: 0; flex-wrap: nowrap; }
.rail-overview .dashboard-stat-val { font-size: var(--text-sm); line-height: 1.2; color: var(--text); overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.rail-overview .dashboard-stat-label { font-size: 11px; color: var(--text-3); white-space: nowrap; }
.rail-overview .dashboard-tools { box-shadow: inset 0 1px 0 var(--line-1); padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.rail-overview.collapsed .dashboard-tools { display: none; }
.rail-overview .dashboard-tools-title { margin-bottom: 2px; font-size: 11px; color: var(--text-3); }
.rail-overview .dashboard-tools-list { display: flex; flex-wrap: wrap; gap: 3px; }
.rail-overview .dashboard-tool-chip { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: var(--radius-pill); font-size: 11px; background: var(--surface-2); }
.rail-overview .dashboard-tool-count { color: var(--text-3); }
.rail-overview .dashboard-toggle { align-self: flex-start; height: 22px; padding: 0 8px; border: 0; border-radius: var(--radius-pill); background: none; cursor: pointer; font-size: 11px; color: var(--text-3); }
.rail-overview .dashboard-toggle:hover { background: var(--hover); color: var(--text); }
.rail-filters .qf-bar { display: flex; flex-direction: column; gap: 6px; }
.rail-filters .qf-bar[hidden], .rail-filters .qf-pickers[hidden] { display: none; }
.rail-filters .qf-pickers { display: flex; flex-direction: column; gap: 6px; }
.rail-filters .qf-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.rail-filters .qf-section { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.rail-filters .qf-section-label { font-size: 11px; color: var(--text-3); margin-right: 2px; text-transform: capitalize; }
.rail-filters .qf-chip, .rail-filters .qf-error-toggle {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border: 0; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-2); background: var(--surface-2); cursor: pointer;
}
.rail-filters .qf-chip:hover, .rail-filters .qf-error-toggle:hover { background: var(--surface-3); color: var(--text); }
.rail-filters .qf-chip.qf-active, .rail-filters .qf-error-toggle.qf-active { background: var(--ink); color: var(--paper); }
.rail-filters .qf-chip-count { color: var(--text-3); }
.rail-filters .qf-grade {
  width: 22px; height: 22px; border: 0; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 11px;
  color: var(--text-2); background: var(--surface-2); cursor: pointer;
}
.rail-filters .qf-grade:hover { background: var(--surface-3); color: var(--text); }
.rail-filters .qf-grade.qf-active { background: var(--ink); color: var(--paper); }
.rail-filters .qf-grade.qf-disabled { opacity: 0.35; cursor: default; }
.rail-filters .applied-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.rail-filters .chip {
  display: inline-flex; align-items: center; gap: 3px; height: 22px; padding: 0 3px 0 8px; border-radius: var(--radius-pill);
  background: var(--surface-3); font-size: 11px; max-width: 100%;
}
.rail-filters .chip-key { color: var(--text-3); }
.rail-filters .chip-op { color: var(--text-3); }
.rail-filters .chip-value { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.rail-filters .chip-remove { width: 16px; height: 16px; border: 0; border-radius: 50%; background: none; color: var(--text-3); cursor: pointer; font-size: 12px; line-height: 1; }
.rail-filters .chip-remove:hover { background: var(--surface-4); color: var(--text); }
.rail-filters .qf-clear { height: 22px; padding: 0 8px; border: 0; border-radius: var(--radius-pill); background: none; cursor: pointer; font-size: 11px; color: var(--text-3); }
.rail-filters .qf-clear:hover { color: var(--text); background: var(--hover); }
.rail-filters .qf-clear.qf-visible { display: inline-flex; align-items: center; }
.rail-filters .applied-match { font-size: 11px; color: var(--text-3); }

.chat-app { flex: 1; min-width: 0; min-height: 0; }

/* chat header wears the record's identity row */
.chat-top-spacer { flex: 1; }
.chat-identity { min-width: 0; }
.chat-identity .session-id { white-space: nowrap; }
.chat-head-stats { margin-top: 2px; }
.chat-head-stats[hidden] { display: none; }

/* the rail is the way back on wide screens; the text link only appears without it */
@media (min-width: 881px) { .run-back { display: none; } }
@media (max-width: 880px) { .agent-rail { display: none; } }
`;

/** Conversation, tool cards, output pane and composer. */
export const CHAT_PAGE_CSS = `
html, body { height: 100%; }
body { overflow: hidden; }
.chat-app { display: flex; flex-direction: column; height: 100%; }

/* ---- header ---- */
.chat-top {
  display: flex; flex-direction: column; gap: 4px; flex: none; min-width: 0;
  padding: 12px 24px; box-shadow: inset 0 -1px 0 var(--line-1);
}
.chat-top .session-top { gap: 8px 12px; }
.run-started { font-size: var(--text-xs); color: var(--text-3); white-space: nowrap; }
.run-back { color: var(--text-2); font-size: var(--text-sm); white-space: nowrap; }
.run-back:hover { color: var(--text); }
.run-view-link, .run-analytics-toggle {
  display: inline-flex; align-items: center; height: 26px; padding: 0 11px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text-2); background: none; border: 0; box-shadow: inset 0 0 0 1px var(--line-2);
  white-space: nowrap; cursor: pointer; text-decoration: none; font-family: var(--font-sans);
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.run-view-link:hover, .run-analytics-toggle:hover, .run-analytics-toggle[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.run-view-link[hidden] { display: none; }
.run-continued-from {
  display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 8px; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-3); box-shadow: inset 0 0 0 1px var(--line-2); white-space: nowrap; text-decoration: none;
}
.run-continued-from:hover { color: var(--text); }

/* ---- conversation column + optional output pane ---- */
.chat-body { flex: 1; display: flex; flex-direction: row; min-height: 0; min-width: 0; }
.chat-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.chat-scroll { flex: 1; overflow-y: auto; overflow-x: hidden; }
.chat-col { max-width: 760px; margin: 0 auto; padding: 20px 28px 28px; }
.chat-output-pane[hidden] { display: none !important; }
.chat-app[data-has-output="1"] .chat-output-pane {
  display: flex; flex-direction: column; flex: 1 1 62%; min-width: 700px; max-width: 72%; min-height: 0;
  box-shadow: inset 1px 0 0 var(--line-1); background: var(--bg-sunken); overflow: auto;
}
@media (max-width: 1200px) {
  .chat-app[data-has-output="1"] .chat-output-pane { min-width: 360px; max-width: 56%; flex-basis: 48%; }
}
.chat-output-pane > .chat-card.chat-output { flex: none; margin: 0; border: none; border-radius: 0; background: transparent; box-shadow: none; min-width: 0; }
.chat-output-pane .chat-tool-body { white-space: pre; }

.chat-user {
  margin: 14px 0 10px; padding: 11px 15px; border-radius: var(--radius-lg);
  background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-1);
  font-size: var(--text-md); line-height: 1.55; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere;
}
.chat-thread > .chat-user:first-child { margin-top: 2px; }
.chat-assistant {
  position: relative; margin: 6px 2px 12px; font-size: var(--text-md); line-height: 1.65; color: var(--text); overflow-wrap: break-word;
}
.chat-assistant[data-contained="parked"],
.chat-card.chat-output[data-contained="parked"],
.chat-thought[data-contained="parked"],
.chat-marker[data-contained="parked"] {
  max-height: 0 !important; height: 0 !important; min-height: 0 !important; overflow: hidden !important;
  margin: 0 !important; padding: 0 !important; border: none !important;
}
.chat-assistant + .tool-card { margin-top: 10px; }
.tool-card + .tool-card { margin-top: 6px; }
.chat-assistant p { margin: 6px 0; white-space: pre-wrap; }
.chat-assistant code { font-family: var(--font-mono); font-size: 12.5px; background: var(--surface-2); border-radius: var(--radius-xs); padding: 1px 5px; }
.chat-h { font-weight: var(--weight-medium); margin: 16px 0 6px; letter-spacing: var(--track-tight); }
.chat-code {
  margin: 10px 0; padding: 12px 14px; border-radius: var(--radius-md); overflow-x: auto;
  background: var(--bg-sunken); box-shadow: inset 0 0 0 1px var(--line-1);
}
.chat-code code { font-family: var(--font-mono); font-size: 12.5px; line-height: 1.55; background: none; padding: 0; white-space: pre; }
.chat-list { margin: 6px 0 6px 4px; padding-left: 18px; }
.chat-list li { margin: 4px 0; }
.chat-check { list-style: none; position: relative; padding-left: 4px; }
.chat-check::before { content: "\\25CB"; color: var(--text-3); position: absolute; left: -16px; }
.chat-check[data-done="true"]::before { content: "\\2713"; color: var(--ok); }
.chat-marker { font-size: var(--text-sm); margin: 14px 2px 8px; }
.chat-marker .m1 { color: var(--text-2); }
.chat-marker .m2 { color: var(--text-3); }
.chat-thought { margin: 14px 2px 8px; }
.chat-thought-toggle { background: none; border: none; padding: 0; font: inherit; font-size: var(--text-sm); cursor: pointer; color: var(--text-2); }
.chat-thought-toggle .m2 { color: var(--text-3); }
.chat-thought-toggle:hover .m1 { color: var(--text); }
.chat-thinking {
  margin: 8px 0 8px 2px; padding: 4px 0 4px 14px; box-shadow: inset 2px 0 0 var(--line-2);
  color: var(--text-2); font-size: var(--text-sm); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-sans);
}

/* ---- tool cards ---- */
.chat-card {
  display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0;
  margin: 6px 0; padding: 9px 14px; border-radius: var(--radius-md);
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1); font-size: var(--text-sm);
}
.chat-card-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.chat-card .card-icon { flex: none; color: var(--text-3); }
.chat-card .card-title { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.chat-card .card-title.mono { font-family: var(--font-mono); font-size: 12.5px; }
.chat-card .card-bins { color: var(--text-3); flex: none; }
.chat-card .card-err { flex: none; margin-left: auto; color: var(--bad); font-size: 11px; }
.chat-card.err { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bad) 38%, transparent); }
.chat-card.running .card-title { color: var(--text); }
.chat-card.file .file-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-card.file .plus { color: var(--ok); font-family: var(--font-mono); font-size: 12px; flex: none; }
.chat-card.file .minus { color: var(--bad); font-family: var(--font-mono); font-size: 12px; flex: none; }
.chat-toolline { font-size: var(--text-sm); margin: 8px 2px; }
.chat-toolline-head { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chat-toolline .tl1 { color: var(--text-2); }
.chat-toolline .tl2 { color: var(--text-3); }

/* named output: a closed file object (header + line-snapped body) */
.chat-card.chat-output { padding: 0 0 12px; gap: 0; overflow: visible; cursor: pointer; }
.chat-output-head { padding: 9px 14px; }
.chat-output-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.chat-output-meta { color: var(--text-3); font-size: 11.5px; font-family: var(--font-mono); flex: none; margin-left: auto; }
.chat-card.chat-output[data-shown="1"] { box-shadow: inset 0 0 0 1px var(--line-3); }
.chat-tool-body {
  margin: 0; padding: 9px 12px; max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.55; color: var(--text-2);
  background: var(--bg-sunken); border-radius: var(--radius-sm);
}
.chat-card.chat-output .chat-tool-body {
  overflow: auto; overflow-x: auto; overflow-y: scroll; white-space: pre; border-radius: 0;
  background: var(--bg-sunken); box-shadow: inset 0 1px 0 var(--line-1); padding: 9px 14px 0;
  font-size: 11.5px; line-height: 1.4; scrollbar-gutter: stable; scrollbar-width: thin;
}
.chat-card.chat-output .chat-tool-body::-webkit-scrollbar { width: 8px; }
.chat-card.chat-output .chat-tool-body::-webkit-scrollbar-thumb { background: var(--line-3); border-radius: 4px; }
.chat-errnote {
  margin: 10px 0; padding: 8px 12px; border-radius: var(--radius-sm); background: var(--bad-soft);
  color: var(--text); font-size: var(--text-sm); white-space: pre-wrap; overflow-wrap: anywhere;
}

/* ---- in-progress activity ---- */
.chat-activity { min-height: 26px; margin: 6px 2px 0; font-size: var(--text-sm); }
.shimmer {
  display: inline-block; background: linear-gradient(90deg, var(--text-3) 20%, var(--text) 50%, var(--text-3) 80%);
  background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: chat-shimmer 1.8s linear infinite;
}
@keyframes chat-shimmer { from { background-position: 200% 0; } to { background-position: 0% 0; } }
.spinner { flex: none; width: 11px; height: 11px; border: 1.5px solid var(--text-3); border-top-color: transparent; border-radius: 50%; animation: chat-spin 0.8s linear infinite; }
@keyframes chat-spin { to { transform: rotate(360deg); } }
.chat-activity-sub { color: var(--text-3); font-size: var(--text-xs); margin-top: 4px; }
.chat-empty { color: var(--text-3); font-size: var(--text-sm); margin: 12px 2px; }

.run-banner {
  margin-top: 16px; padding: 8px 14px; border-radius: var(--radius-md); font-size: var(--text-xs);
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2);
}
.run-banner[data-kind="exited"] { color: var(--warn); background: var(--warn-soft); box-shadow: none; }
.run-banner[data-kind="gone"] { color: var(--bad); background: var(--bad-soft); box-shadow: none; }
.run-banner[hidden] { display: none; }
.chat-terminal { margin-top: 18px; }
.chat-terminal summary { cursor: pointer; font-size: var(--text-xs); color: var(--text-3); user-select: none; list-style: none; }
.chat-terminal summary::-webkit-details-marker { display: none; }
.chat-terminal summary::before { content: "\\203A  "; }
.chat-terminal[open] summary::before { content: "\\2304  "; }
.chat-terminal summary:hover { color: var(--text); }
.run-terminal {
  --ansi-fg: #d7d6d5; --ansi-bg: #100e08;
  margin-top: 8px; padding: 12px 14px; overflow-x: auto; border-radius: var(--radius-md);
  background: var(--ansi-bg); box-shadow: inset 0 0 0 1px var(--line-1);
}
.run-screen { font-family: var(--font-mono); font-size: 12px; line-height: 1.45; white-space: pre; min-width: 80ch; color: var(--ansi-fg); }
.run-terminal[data-status="exited"] .run-screen, .run-terminal[data-status="gone"] .run-screen { opacity: 0.55; }

/* ---- composer ---- */
.chat-composer { flex: none; background: linear-gradient(to bottom, transparent, var(--bg) 22px); }
.chat-composer-inner { max-width: 760px; margin: 0 auto; padding: 0 28px 18px; }
.composer-status { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 2px 6px 8px; font-size: var(--text-xs); color: var(--text-2); }
.status-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: ui-pulse 2.2s var(--ease-out) infinite; }
@keyframes composer-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
.composer-status[data-state="exited"] .status-dot { background: var(--warn); animation: none; }
.composer-status[data-state="gone"] .status-dot { background: var(--bad); animation: none; }
.composer-status[data-state="idle"] .status-dot { background: var(--text-4); animation: none; }
.status-text { color: var(--text-2); }
.status-spacer { flex: 1; }
.status-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 12px; border: 0; border-radius: var(--radius-pill);
  font: inherit; font-size: var(--text-xs); color: var(--text); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-2); cursor: pointer;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.status-btn:hover { background: var(--surface-3); }
.status-btn:active { transform: translateY(0.5px); }
.status-btn .kbd { box-shadow: none; background: none; padding: 0; min-width: 0; color: var(--text-3); }
.status-btn:hover .kbd { color: var(--text-2); }
.status-btn.danger { color: var(--bad); background: var(--bad-soft); box-shadow: none; }
.status-btn.danger:hover { background: color-mix(in srgb, var(--bad) 24%, transparent); }
.status-btn:disabled { opacity: 0.4; cursor: default; }
.status-btn[hidden] { display: none; }
.status-btn.continue { color: var(--paper); background: var(--ink); box-shadow: none; }
.status-btn.continue:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.kbd {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px;
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); border-radius: var(--radius-xs);
  background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-2);
}

.composer-card {
  display: block; padding: 12px 12px 10px 14px; border-radius: var(--radius-xl);
  background: var(--surface-pop); box-shadow: var(--shadow-pop);
  transition: box-shadow var(--dur-2) var(--ease-out);
}
.composer-card:focus-within { box-shadow: var(--shadow-pop), 0 0 0 1px var(--focus); }
.composer-card[hidden] { display: none; }
.composer-context { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.ctx-at {
  flex: none; width: 22px; height: 22px; display: inline-grid; place-items: center; border: 0; border-radius: var(--radius-sm);
  background: var(--surface-2); color: var(--text-3); font: inherit; font-size: 12px; cursor: pointer;
}
.ctx-at:hover { color: var(--text); background: var(--surface-3); }
.ctx-chip {
  display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: var(--radius-sm);
  background: var(--surface-2); font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ctx-chip svg { flex: none; color: var(--text-3); }
.run-input {
  display: block; width: 100%; padding: 2px 2px 12px; background: none; border: none; outline: none;
  color: var(--text); font-family: var(--font-sans); font-size: var(--text-md); line-height: 1.55;
}
.run-input::placeholder { color: var(--text-3); }
.composer-row { display: flex; align-items: center; gap: 4px; }
.chip-wrap { position: relative; display: flex; min-width: 0; }
.keys-overlay, .run-overlay { position: fixed; inset: 0; background: var(--scrim); z-index: var(--z-dialog); }
.keys-overlay[hidden], .run-overlay[hidden] { display: none; }
.chip-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; min-width: 0; border: none; border-radius: var(--radius-pill);
  background: none; font: inherit; font-size: var(--text-xs); color: var(--text-2); cursor: pointer;
  transition: color var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.chip-btn:hover, .chip-btn[aria-expanded="true"] { color: var(--text); background: var(--hover); }
.chip-btn .caret { flex: none; color: var(--text-3); transition: transform var(--dur-2) var(--ease-out); }
.chip-btn[aria-expanded="true"] .caret { transform: rotate(180deg); }
.chip-btn[hidden] { display: none; }
.mode-chip { background: var(--surface-3); color: var(--text); padding: 0 10px; }
.mode-chip:hover, .mode-chip[aria-expanded="true"] { background: var(--surface-4); color: var(--text); }
.mode-chip svg { color: var(--text-2); }
.chip-kbd { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); }
.model-chip .model-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-menu, .keys-menu {
  position: absolute; bottom: 36px; z-index: 10; padding: 6px; border-radius: var(--radius-lg);
  background: var(--surface-pop); box-shadow: var(--shadow-pop); animation: ui-pop-in var(--dur-2) var(--ease-out);
}
.run-menu { left: 0; width: 360px; max-width: 72vw; }
.run-menu[hidden], .keys-menu[hidden] { display: none; }
.run-menu-grid { display: grid; grid-template-columns: 84px 1fr; gap: 6px 12px; padding: 6px 8px 8px; font-size: var(--text-xs); }
.rm-k { color: var(--text-3); }
.rm-v { color: var(--text); overflow-wrap: anywhere; }
.rm-v.mono { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); }
.rm-v a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.run-menu-note { box-shadow: inset 0 1px 0 var(--line-1); margin-top: 2px; padding: 8px 8px 4px; font-size: 11.5px; line-height: 1.55; color: var(--text-3); }
.composer-spacer { flex: 1; }
.keys-wrap { position: relative; display: flex; }
.keys-btn { color: var(--text-2); }
.keys-menu { right: 0; min-width: 180px; }
.keys-title { font-size: 11px; color: var(--text-3); padding: 4px 8px 6px; }
.run-key-btn {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 30px; padding: 0 8px; border: none; border-radius: var(--radius-sm);
  background: none; font: inherit; font-size: var(--text-xs); color: var(--text-2); text-align: left; cursor: pointer;
}
.run-key-btn:hover { background: var(--surface-3); color: var(--text); }
.run-key-btn .kbd { margin-left: auto; }
.run-send-btn {
  flex: none; width: 30px; height: 30px; display: inline-grid; place-items: center; border: none; border-radius: 50%;
  background: var(--ink); color: var(--paper); cursor: pointer;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out), transform var(--dur-1) var(--ease-out);
}
.run-send-btn:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.run-send-btn:active { transform: scale(0.94); }
.composer-card[data-empty="true"] .run-send-btn { background: var(--surface-3); color: var(--text-3); }
.composer-card[data-empty="true"] .run-send-btn:hover { background: var(--surface-4); color: var(--text-2); }
.run-send-btn .icon-stop { display: none; }
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn { background: var(--ink); color: var(--paper); }
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn .icon-send { display: none; }
.composer-card[data-busy="true"][data-empty="true"] .run-send-btn .icon-stop { display: block; }
.status-dots { display: none; letter-spacing: 1px; margin-left: -6px; }
.composer-status[data-busy="true"] .status-dots { display: inline; }
.status-dots i { font-style: normal; animation: status-dot-pulse 1.2s ease-in-out infinite; }
.status-dots i:nth-child(2) { animation-delay: 0.2s; }
.status-dots i:nth-child(3) { animation-delay: 0.4s; }
@keyframes status-dot-pulse { 0%, 100% { opacity: 0.15; } 50% { opacity: 1; } }

/* client-held follow-up queue */
.composer-queue { padding: 0 6px 4px; }
.composer-queue[hidden] { display: none; }
.queue-head {
  display: inline-flex; align-items: center; gap: 7px; height: 24px; padding: 0 8px; border: none; border-radius: var(--radius-pill);
  background: none; font: inherit; font-size: var(--text-xs); color: var(--text-2); cursor: pointer;
}
.queue-head:hover { color: var(--text); background: var(--hover); }
.queue-head .caret { flex: none; color: var(--text-3); transition: transform var(--dur-2) var(--ease-out); }
.queue-head[aria-expanded="false"] .caret { transform: rotate(-90deg); }
.queue-list { padding: 2px 0 4px; }
.queue-list[hidden] { display: none; }
.queue-item { display: flex; align-items: center; gap: 10px; padding: 5px 8px; border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--text); }
.queue-item:hover { background: var(--hover); }
.queue-item[data-sending="true"] { opacity: 0.55; }
.queue-ring { flex: none; width: 12px; height: 12px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--text-3); }
.queue-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
.queue-act {
  flex: none; height: 22px; padding: 0 8px; border: none; border-radius: var(--radius-pill); background: none; font: inherit;
  font-size: 11.5px; color: var(--text-3); cursor: pointer; opacity: 0; white-space: nowrap;
  transition: opacity var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.queue-item:hover .queue-act, .queue-act:focus-visible { opacity: 1; }
.queue-act:hover { color: var(--text); background: var(--surface-3); }
.queue-note { font-size: 11px; color: var(--warn); padding: 1px 8px 4px; }
.queue-note[hidden] { display: none; }
.run-input-error { color: var(--bad); font-size: var(--text-xs); overflow-wrap: anywhere; margin-top: 6px; }
.run-input-error[hidden] { display: none; }

/* continue mode: the finished thread keeps a live composer */
.composer-card[data-mode="continue"] .keys-wrap { display: none; }
.ctx-continue { color: var(--text); background: var(--surface-3); }
.ctx-continue[hidden] { display: none; }
.continue-cwd { display: flex; align-items: center; gap: 8px; margin: 0 2px 10px; }
.continue-cwd[hidden] { display: none; }
.continue-cwd-label { flex: none; font-size: 11px; color: var(--warn); }
.continue-cwd-input {
  flex: 1; min-width: 0; height: 28px; padding: 0 10px; border: 0; border-radius: var(--radius-sm); outline: none;
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--warn); color: var(--text); font-family: var(--font-mono); font-size: 12px;
}
.chat-user-pending { box-shadow: inset 0 0 0 1px var(--line-3); opacity: 0.85; }
.observer-card + .composer-card { margin-top: 10px; }

/* read-only observer of an external session */
.readonly-chip { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: var(--radius-pill); font-size: 11px; color: var(--text-3); box-shadow: inset 0 0 0 1px var(--line-2); white-space: nowrap; }
.observer-card { padding: 14px 16px; border-radius: var(--radius-xl); background: var(--surface-pop); box-shadow: var(--shadow-pop); }
.observer-title { display: flex; align-items: center; gap: 8px; font-size: var(--text-sm); color: var(--text); }
.observer-title svg { flex: none; color: var(--text-3); }
.observer-note { margin-top: 6px; font-size: var(--text-xs); line-height: 1.6; color: var(--text-2); }
.observer-actions { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.observer-btn {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 0; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text-2); background: var(--surface-2); text-decoration: none;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.observer-btn:hover { color: var(--text); background: var(--surface-3); }
.observer-btn.accent { color: var(--paper); background: var(--ink); }
button.observer-btn { font: inherit; font-size: var(--text-xs); cursor: pointer; }
button.observer-btn:disabled { opacity: 0.5; cursor: default; }

/* Exclusive footer slots: a live recording ends on ONE slim generating
   composer (#liveTailForm); the archive ending is a separate slot. */
body[data-live-tail="1"] #archiveEnding,
body[data-live-tail="1"] .observer-card,
body[data-live-tail="1"] .readonly-chip,
body[data-live-tail="1"] .composer-status,
body[data-live-tail="1"] #continueForm { display: none; }
body[data-live-tail="1"] .chat-activity { min-height: 72px; }
body[data-live-tail="1"] .chat-col { padding-bottom: 56px; }
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .observer-card,
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .composer-status,
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .readonly-chip,
body[data-watch="session"][data-run-state="idle"]:not([data-live-tail="1"]) .chat-activity { display: none; }
body[data-watch="session"][data-run-state="idle"] .chat-col { padding-bottom: 4px; }
body[data-leftover-reading="1"] .chat-main { justify-content: flex-start; }
body[data-leftover-reading="1"] #chatScroll { flex: 1; min-height: 0; margin-top: 0; }
body[data-leftover-reading="1"][data-watch="session"][data-run-state="idle"] .chat-col { padding-top: 20px; padding-bottom: 4px; }
.chat-history { display: none; flex: none; }
.chat-history[data-split="1"] {
  display: block; position: absolute; left: -9999px; top: 0; width: 760px; height: auto; overflow: visible; flex: none; pointer-events: none;
}
body[data-watch="session"][data-run-state="idle"] .chat-composer-inner { padding-top: 0; padding-bottom: 18px; }
body[data-watch="session"][data-run-state="idle"] #continueForm,
.composer-card.live-tail-card {
  display: flex; align-items: center; gap: 8px; margin-top: 0; padding: 7px 7px 7px 18px; border-radius: 24px;
}
body[data-watch="session"][data-run-state="idle"] #continueForm[hidden] { display: none; }
body[data-watch="session"][data-run-state="idle"] #continueForm .composer-context { display: none; }
body[data-watch="session"][data-run-state="idle"] #continueForm .run-input,
.live-tail-card .run-input { flex: 1; min-width: 0; padding: 4px 4px 4px 0; }
body[data-watch="session"][data-run-state="idle"] #continueForm .composer-row,
.live-tail-card .composer-row { flex: none; }
.live-tail-card .run-send-btn { background: var(--ink); color: var(--paper); }
.live-tail-card .run-send-btn .icon-send { display: none; }
.live-tail-card .run-send-btn .icon-stop { display: block; }
.live-tail-card[data-empty="false"][data-continuable="true"] .run-send-btn { background: var(--ink); color: var(--paper); }
.live-tail-card[data-empty="false"][data-continuable="true"] .run-send-btn .icon-send { display: block; }
.live-tail-card[data-empty="false"][data-continuable="true"] .run-send-btn .icon-stop { display: none; }
.live-tail-card[hidden] { display: none; }
.archive-ending[hidden] { display: none; }

/* chat home (no session open) */
.chat-empty-state { max-width: 560px; margin: 16vh auto 0; padding: 0 28px; display: flex; flex-direction: column; gap: 8px; text-align: center; align-items: center; }
`;
