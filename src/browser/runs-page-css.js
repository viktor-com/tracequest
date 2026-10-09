/**
 * Runs (/sessions) — the inventory screen. Arranges design-system parts:
 * header, toolbar, overview, quick filters, the run table, pagination,
 * the compare tray and the analytics flyout.
 *
 * Row anatomy (one grid, two lines in the first column):
 *   [☐] [●] [prompt                      ] [when] [duration] [tokens] [cost] [grade] [tools] [⋯]
 *           [agent · project · model · id · 3 errors]
 */
export const RUNS_PAGE_CSS = `
html, body { min-height: 100%; }
.runs-home {
  --runs-pad: var(--space-5);
  --runs-check: 28px;
  --runs-cols: 14px minmax(0, 1fr) 76px 72px 76px 76px 40px 64px 84px;
  max-width: 1440px; margin: 0 auto; padding: var(--space-6) var(--runs-pad) 120px;
}

/* ---- header ---- */
.runs-head { display: flex; align-items: baseline; gap: var(--space-3); margin-bottom: var(--space-5); }
.runs-title { font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: var(--weight-regular); letter-spacing: var(--track-display); }
.runs-count { font-size: var(--text-sm); color: var(--text-3); font-variant-numeric: tabular-nums; }
.refresh-status { font-size: var(--text-xs); color: var(--text-3); min-width: 76px; font-variant-numeric: tabular-nums; }
.refresh-status[hidden] { display: inline-block; visibility: hidden; }
.refresh-status[data-state="pending"] { color: var(--text-3); }
.refresh-status[data-state="stale"] { color: var(--warn); }
.refresh-status[data-state="error"] { color: var(--bad); }

/* ---- toolbar: filter field + menus ---- */
.runs-chrome { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-4); }
.runs-toolbar { display: flex; align-items: flex-start; gap: var(--space-2); }
.filter-wrap { position: relative; flex: 1; min-width: 0; }
.filter-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px; min-height: var(--control-lg);
  padding: 3px 12px 3px 36px; border-radius: var(--radius-pill); cursor: text; position: relative;
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2);
  transition: box-shadow var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.filter-bar::before {
  content: ""; position: absolute; left: 13px; top: 50%; width: 14px; height: 14px; transform: translateY(-50%);
  background: var(--text-3);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round'%3E%3Cpath d='M2.5 4h11M4.5 8h7M6.5 12h3'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round'%3E%3Cpath d='M2.5 4h11M4.5 8h7M6.5 12h3'/%3E%3C/svg%3E") center / contain no-repeat;
}
.filter-bar:hover { box-shadow: inset 0 0 0 1px var(--line-3); }
.filter-bar:focus-within { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--focus); }
.filter-input {
  flex: 1; min-width: 140px; height: 28px; background: none; border: 0; outline: none;
  color: var(--text); font-family: var(--font-sans); font-size: var(--text-sm);
}
.filter-input::placeholder { color: var(--text-3); }
.filter-hint { display: none; }
.filter-legend {
  display: none; position: absolute; left: 0; right: 0; top: calc(100% + 6px); z-index: var(--z-popover);
  padding: 10px 14px; border-radius: var(--radius-md); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  font-size: var(--text-xs); color: var(--text-3); line-height: 1.8;
}
.filter-legend span { font-family: var(--font-mono); color: var(--text-2); }
.filter-wrap:focus-within:has(.filter-input:placeholder-shown) .filter-legend { display: block; }
.filter-wrap:focus-within .suggestions.open ~ .filter-legend { display: none; }
.chip {
  display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 4px 0 9px;
  border-radius: var(--radius-pill); background: var(--surface-3); font-size: var(--text-xs); color: var(--text);
}
.chip-key { color: var(--text-3); }
.chip-op { color: var(--text-3); }
.chip-value { color: var(--text); }
.chip-remove, .chip-x {
  width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%;
  color: var(--text-3); font-size: 13px; line-height: 1;
}
.chip-remove:hover, .chip-x:hover { background: var(--surface-4); color: var(--text); }
.suggestions {
  display: none; position: absolute; left: 0; top: calc(100% + 6px); z-index: calc(var(--z-popover) + 1);
  min-width: 260px; max-width: 420px; max-height: 320px; overflow: auto; padding: 4px;
  border-radius: var(--radius-lg); background: var(--surface-pop); box-shadow: var(--shadow-pop);
}
.suggestions.open { display: block; animation: ui-pop-in var(--dur-2) var(--ease-out); }
.suggestion-item {
  display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 10px; border-radius: var(--radius-sm);
  font-size: var(--text-sm); color: var(--text-2); cursor: pointer;
}
.suggestion-item:hover, .suggestion-item.hl { background: var(--surface-3); color: var(--text); }
.suggestion-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.suggestion-label { font-family: var(--font-mono); font-size: 12.5px; }
.suggestion-count { margin-left: auto; font-size: var(--text-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }

.runs-toolbar-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.toolbar-pop { position: relative; }
.toolbar-btn {
  display: inline-flex; align-items: center; gap: 6px; height: var(--control-lg); padding: 0 14px;
  border-radius: var(--radius-pill); font-size: var(--text-sm); color: var(--text-2); white-space: nowrap;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.toolbar-btn::after {
  content: ""; width: 10px; height: 10px; opacity: 0.6; background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4 6 4 4 4-4'/%3E%3C/svg%3E") center / contain no-repeat;
}
#filtersToggle::after { display: none; }
.toolbar-btn:hover, .toolbar-btn[aria-expanded="true"] { background: var(--hover); color: var(--text); }
.toolbar-btn.active, .toolbar-btn.has-value { background: var(--surface-3); color: var(--text); }
.toolbar-menu {
  position: absolute; right: 0; top: calc(100% + 6px); z-index: var(--z-popover);
  min-width: 200px; padding: 4px; border-radius: var(--radius-lg); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  display: flex; flex-direction: column; animation: ui-pop-in var(--dur-2) var(--ease-out);
}
.toolbar-menu[hidden] { display: none; }
.toolbar-option {
  display: flex; align-items: center; gap: 8px; height: 30px; padding: 0 10px; border-radius: var(--radius-sm);
  font-size: var(--text-sm); color: var(--text-2); text-align: left; white-space: nowrap;
}
.toolbar-option:hover { background: var(--surface-3); color: var(--text); }
.toolbar-option.active { color: var(--text); }
.toolbar-option.active::after {
  content: ""; margin-left: auto; width: 12px; height: 12px; background: var(--text);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 8.5 3 3 6-7'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m3.5 8.5 3 3 6-7'/%3E%3C/svg%3E") center / contain no-repeat;
}
.toolbar-option-count { margin-left: auto; font-size: var(--text-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
.toolbar-option.active .toolbar-option-count { margin-left: auto; }
.sort-bar { padding: 6px; }
.sort-label { padding: 4px 10px 6px; font-size: var(--text-xs); color: var(--text-3); }
.sort-btn {
  display: flex; align-items: center; height: 28px; padding: 0 10px; border-radius: var(--radius-sm);
  font-size: var(--text-sm); color: var(--text-2); text-align: left; text-transform: capitalize;
}
.sort-btn:hover { background: var(--surface-3); color: var(--text); }
.sort-btn.active { color: var(--text); background: var(--surface-3); }

/* ---- overview ---- */
.dashboard { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-2) var(--space-5); padding: 2px 2px 0; }
.dashboard-header { display: inline-flex; align-items: baseline; gap: 8px; }
.dashboard-title { font-size: var(--text-xs); color: var(--text-3); }
.dashboard-scope { font-size: var(--text-xs); color: var(--text-3); }
.dashboard-stats { display: contents; }
.dashboard-stat { display: inline-flex; align-items: baseline; gap: 6px; white-space: nowrap; }
.dashboard-stat-val { font-size: var(--text-md); color: var(--text); font-variant-numeric: tabular-nums; letter-spacing: var(--track-tight); }
.dashboard-stat-label { font-size: var(--text-xs); color: var(--text-3); }
.dashboard-stat-growth { font-size: 11px; }
.dashboard-stat-growth.up { color: var(--ok); }
.dashboard-stat-growth.down { color: var(--bad); }
.dashboard-toggle {
  margin-left: auto; height: var(--control-sm); padding: 0 10px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text-3);
}
.dashboard-toggle:hover { background: var(--hover); color: var(--text); }
.dashboard-tools { flex-basis: 100%; display: flex; flex-direction: column; gap: 8px; padding: 10px 0 2px; }
.dashboard.collapsed .dashboard-tools { display: none; }
.dashboard-tools-title { font-size: var(--text-xs); color: var(--text-3); }
.dashboard-tools-list { display: flex; flex-wrap: wrap; gap: 6px; }
.dashboard-tool-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); background: var(--surface-2);
}
.dashboard-tool-count { color: var(--text-3); font-variant-numeric: tabular-nums; }

/* ---- quick filters + applied chips ---- */
.qf-bar { display: flex; flex-direction: column; gap: 10px; }
.qf-bar[hidden] { display: none; }
.applied-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.applied-match { font-size: var(--text-xs); color: var(--text-3); margin-left: 4px; }
.qf-pickers { display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: var(--radius-lg); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1); }
.qf-pickers[hidden] { display: none; }
.qf-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; }
.qf-section { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.qf-section-label { width: 56px; font-size: var(--text-xs); color: var(--text-3); text-transform: capitalize; }
.qf-grade {
  width: 26px; height: 24px; border-radius: var(--radius-sm); font-family: var(--font-mono); font-size: 11.5px;
  color: var(--text-2); background: var(--surface-2); transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.qf-grade:hover { background: var(--surface-3); color: var(--text); }
.qf-grade.qf-active { background: var(--ink); color: var(--paper); }
.qf-grade.qf-disabled, .qf-grade:disabled { opacity: 0.35; cursor: default; }
.qf-chip, .qf-error-toggle {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text-2); background: var(--surface-2);
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.qf-chip:hover, .qf-error-toggle:hover { background: var(--surface-3); color: var(--text); }
.qf-chip.qf-active, .qf-error-toggle.qf-active { background: var(--ink); color: var(--paper); }
.qf-chip--source::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--hue-other)); }
.qf-chip-count { color: var(--text-3); font-variant-numeric: tabular-nums; }
.qf-chip.qf-active .qf-chip-count { color: inherit; opacity: 0.7; }
.qf-error-toggle::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--bad); }
.qf-clear { height: 24px; padding: 0 10px; border-radius: var(--radius-pill); font-size: var(--text-xs); color: var(--text-3); }
.qf-clear:hover { color: var(--text); background: var(--hover); }

/* ---- the run table ---- */
.runs-inventory { position: relative; }
.runs-inventory::before {
  content: ""; position: absolute; left: 0; right: 0; top: 0; height: 1px; z-index: 2;
  background: linear-gradient(90deg, transparent, var(--text-2), transparent); background-size: 40% 100%; background-repeat: no-repeat;
  opacity: 0; transition: opacity var(--dur-2) var(--ease-out);
}
body.runs-loading .runs-inventory::before { opacity: 1; animation: runs-scan 1.1s var(--ease-in-out) infinite; }
@keyframes runs-scan { from { background-position: -40% 0; } to { background-position: 140% 0; } }
body.runs-loading #sessions { opacity: 0.55; transition: opacity var(--dur-3) var(--ease-out); }
.runs-table-head, .session-row-wrap {
  display: grid; grid-template-columns: var(--runs-check) minmax(0, 1fr); align-items: center; column-gap: 0;
}
.runs-table-head {
  position: sticky; top: var(--shell-top); z-index: 5; height: 34px;
  background: color-mix(in oklab, var(--bg) 92%, transparent); backdrop-filter: blur(8px);
  box-shadow: inset 0 -1px 0 var(--line-2);
  font-size: var(--text-xs); color: var(--text-3);
}
.runs-table-cols, .session-row {
  display: grid; grid-template-columns: var(--runs-cols); align-items: center; column-gap: 14px; min-width: 0;
}
.runs-table-cols > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.runs-col-state { grid-column: 1; }
.runs-col-source, .runs-col-id, .runs-col-project, .runs-col-model { display: none; }
.runs-col-run { grid-column: 2; }
.runs-col-time { grid-column: 3; }
.runs-col-duration { grid-column: 4; text-align: right; }
.runs-col-tokens { grid-column: 5; text-align: right; }
.runs-col-cost { grid-column: 6; text-align: right; }
.runs-col-grade { grid-column: 7; text-align: center; }
.runs-col-tools { grid-column: 8; }
.runs-col-actions { grid-column: 9; }
.runs-col-state { font-size: 0; }

.session-row-wrap {
  position: relative; border-radius: var(--radius-md);
  box-shadow: inset 0 -1px 0 var(--line-1);
  transition: background var(--dur-1) var(--ease-out);
}
.session-row-wrap:hover { background: var(--hover); }
.session-row-wrap.is-selected { background: var(--surface-2); box-shadow: inset 2px 0 0 var(--text); }
.session-row-wrap.is-selected:hover { background: var(--surface-3); }
.session-row-wrap:focus-within { background: var(--hover); }
.compare-cb {
  justify-self: center; width: 15px; height: 15px; margin: 0; cursor: pointer; accent-color: var(--ink);
  opacity: 0; transition: opacity var(--dur-2) var(--ease-out);
}
.session-row-wrap:hover .compare-cb, .compare-cb:checked, .compare-cb:focus-visible { opacity: 1; }
.runs-col-check { display: block; }
.session-row { min-height: 60px; padding: 10px 0; color: var(--text); cursor: pointer; outline: none; }
.session-row.run-row:focus-visible { box-shadow: 0 0 0 2px var(--focus); border-radius: var(--radius-md); }
.session-row > * { min-width: 0; }

/* status column: a dot; the word stays for assistive tech */
.live-indicator, .run-state-slot, .session-row > .run-state-badge { grid-column: 1; justify-self: center; }
.live-indicator { font-size: 0; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); animation: ui-pulse 2.2s var(--ease-out) infinite; }
.session-row > .run-state-badge { font-size: 0; gap: 0; }
.session-row.has-errors > .run-state-slot { width: 6px; height: 6px; border-radius: 50%; background: var(--bad); }

.session-main { grid-column: 2; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.session-primary { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.session-prompt {
  font-size: var(--text-md); line-height: var(--lh-md); color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.session-prompt:empty::before { content: "Untitled run"; color: var(--text-3); }
.session-meta { display: flex; align-items: center; gap: 10px; min-width: 0; overflow: hidden; white-space: nowrap; }
.session-meta > * + *::before { content: none; }
.session-meta .session-project { color: var(--text-2); }
.session-badge { display: inline-flex; align-items: center; height: 18px; padding: 0 7px; border-radius: var(--radius-pill); font-size: 11px; white-space: nowrap; }
.session-badge.error-badge { color: var(--bad); background: none; padding: 0; }
.session-badge.commit-badge { color: var(--text-3); background: none; padding: 0; }
.session-badge.cost-badge { display: none; }
.run-activity { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--text-2); min-width: 0; }
.run-activity-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); flex: none; animation: ui-pulse 2.2s var(--ease-out) infinite; }
.run-activity-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run-activity[data-status="idle"] .run-activity-text { color: var(--text-3); }

.session-time { grid-column: 3; font-size: var(--text-xs); color: var(--text-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.session-size { display: none; }
.session-row .session-stats { display: contents; }
.session-row .session-stat { display: none; font-size: var(--text-xs); }
.session-row .session-stat.duration { display: block; grid-column: 4; text-align: right; color: var(--text-2); }
.session-row .session-stat.tokens { display: block; grid-column: 5; text-align: right; color: var(--text-3); }
.session-row .session-stat.cost { display: block; grid-column: 6; text-align: right; color: var(--text-2); }
.session-row .session-grade-badge { grid-column: 7; justify-self: center; }
.session-tools { grid-column: 8; min-width: 0; }
.tool-sparkline { display: flex; height: 4px; width: 100%; border-radius: 999px; overflow: hidden; gap: 1px; background: var(--surface-3); }
.tool-spark-seg { display: block; height: 100%; min-width: 2px; }
.tool-spark-tip, .session-tool { display: none; }
.session-actions { grid-column: 9; justify-self: end; display: inline-flex; align-items: center; gap: 4px; }

.session-continue {
  height: var(--control-sm); padding: 0 10px; border-radius: var(--radius-pill); font-size: var(--text-xs);
  color: var(--text-2); box-shadow: inset 0 0 0 1px var(--line-2); opacity: 0;
  transition: opacity var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.session-row-wrap:hover .session-continue, .session-row-wrap:focus-within .session-continue { opacity: 1; }
.session-continue:hover { background: var(--hover); color: var(--text); }
.session-continue:disabled { opacity: 0.5; cursor: default; }
.session-continue.failed { color: var(--bad); box-shadow: inset 0 0 0 1px var(--bad); opacity: 1; }
.run-dismiss {
  width: var(--control-sm); height: var(--control-sm); border-radius: var(--radius-pill); display: grid; place-items: center;
  color: var(--text-3); font-size: 15px; line-height: 1;
}
.run-dismiss:hover { background: var(--bad-soft); color: var(--bad); }
.session-continue-form {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%); z-index: 3;
  width: min(460px, 70%); display: flex; flex-direction: column; gap: 6px; padding: 8px 8px 8px 14px;
  border-radius: var(--radius-lg); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  animation: ui-pop-in var(--dur-2) var(--ease-out);
}
.session-continue-form:focus-within { box-shadow: var(--shadow-pop), 0 0 0 1px var(--focus); }
.session-continue-form[data-mode="cwd"] { box-shadow: var(--shadow-pop), 0 0 0 1px var(--warn); }
.session-continue-msg { font-size: var(--text-xs); color: var(--warn); overflow-wrap: anywhere; }
.session-continue-msg[hidden] { display: none; }
.session-continue-row { display: flex; align-items: center; gap: 8px; }
.session-continue-glyph { flex: none; color: var(--text-3); font-size: 11px; }
.session-continue-input { flex: 1; min-width: 0; height: 28px; background: none; border: 0; outline: none; color: var(--text); font-size: var(--text-sm); }
.session-continue-input::placeholder { color: var(--text-3); }
.session-continue-send {
  flex: none; height: 28px; padding: 0 12px; border-radius: var(--radius-pill);
  background: var(--ink); color: var(--paper); font-size: var(--text-xs);
}
.session-continue-send:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.session-continue-send:disabled { opacity: 0.5; cursor: default; }

.runs-inventory .empty, .runs-inventory .fetch-error { padding: 0; }
.runs-inventory:has(#sessions > .empty) .runs-table-head, .runs-inventory:has(#sessions > .fetch-error) .runs-table-head { display: none; }
.runs-inventory .ui-empty { padding-top: 96px; }
.runs-inventory .ui-empty-title { font-size: var(--text-xl); line-height: var(--lh-xl); }
.fetch-error .ui-empty-body { font-family: var(--font-mono); font-size: var(--text-xs); }
#sentinel, .sentinel { height: 1px; }

/* ---- pagination ---- */
.pagination { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-5) 0 0; font-size: var(--text-xs); color: var(--text-3); }
.pagination.hidden { display: none; }
.page-info strong { font-weight: var(--weight-regular); color: var(--text-2); font-variant-numeric: tabular-nums; }
.page-nav { display: inline-flex; align-items: center; gap: 2px; margin: 0 auto; }
.page-btn {
  min-width: 30px; height: 30px; padding: 0 8px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text-2); font-variant-numeric: tabular-nums;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.page-btn:hover { background: var(--hover); color: var(--text); }
.page-btn.active { background: var(--surface-3); color: var(--text); }
.page-btn:disabled { opacity: 0.35; cursor: default; background: none; }
.page-nav .page-info { padding: 0 4px; }
.page-size-wrap { display: inline-flex; align-items: center; gap: 8px; }
.page-size-select {
  height: 28px; padding: 0 26px 0 10px; border-radius: var(--radius-pill); border: 0; cursor: pointer;
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2); color: var(--text-2); font-size: var(--text-xs);
  -webkit-appearance: none; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23888' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4.5 6.5 3.5 3.5 3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 8px center; background-size: 12px;
}

/* ---- compare tray ---- */
.compare-bar {
  position: fixed; left: 50%; bottom: var(--space-6); z-index: var(--z-popover);
  display: flex; align-items: center; gap: var(--space-2); padding: 6px 6px 6px 18px;
  border-radius: var(--radius-pill); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  transform: translate(-50%, calc(100% + var(--space-6) + 8px)); opacity: 0; pointer-events: none;
  transition: transform var(--dur-3) var(--ease-out), opacity var(--dur-2) var(--ease-out);
}
.compare-bar.visible { transform: translate(-50%, 0); opacity: 1; pointer-events: auto; }
.compare-bar-info { font-size: var(--text-sm); color: var(--text-2); margin-right: var(--space-2); white-space: nowrap; }
.compare-btn {
  height: var(--control-md); padding: 0 16px; border-radius: var(--radius-pill);
  background: var(--ink); color: var(--paper); font-size: var(--text-sm);
}
.compare-btn:disabled { opacity: 0.4; cursor: default; }
.compare-btn:not(:disabled):hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.compare-clear { height: var(--control-md); padding: 0 12px; border-radius: var(--radius-pill); font-size: var(--text-sm); color: var(--text-2); }
.compare-clear:hover { background: var(--hover); color: var(--text); }

/* ---- analytics flyout (peek) ---- */
html { --session-flyout-width: min(780px, 58vw); --app-top-h: var(--shell-top); }
.session-flyout {
  position: fixed; top: var(--shell-top); right: 0; bottom: 0; width: var(--session-flyout-width); z-index: calc(var(--z-sticky) + 10);
  display: flex; flex-direction: column; background: var(--bg);
  box-shadow: -1px 0 0 var(--line-2), -24px 0 48px rgba(0, 0, 0, 0.18);
  animation: runs-flyout-in var(--dur-3) var(--ease-out);
}
@keyframes runs-flyout-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.session-flyout[hidden] { display: none !important; }
.session-flyout-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  padding: 12px 14px 12px 20px; box-shadow: inset 0 -1px 0 var(--line-1); flex-shrink: 0;
}
.session-flyout-ident { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.session-flyout-kicker { font-size: var(--text-xs); color: var(--text-3); }
.session-flyout-title { font-size: var(--text-md); font-weight: var(--weight-regular); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-flyout-sub { font-size: var(--text-xs); color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.session-flyout-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.session-flyout-open {
  height: var(--control-md); display: inline-flex; align-items: center; padding: 0 14px; margin-right: 6px; border-radius: var(--radius-pill);
  font-size: var(--text-sm); color: var(--text); background: var(--surface-3);
}
.session-flyout-open:hover { background: var(--surface-4); }
.session-flyout-nav, .session-flyout-close {
  width: var(--control-md); height: var(--control-md); border-radius: var(--radius-pill); display: grid; place-items: center;
  color: var(--text-3); font-size: 14px;
}
.session-flyout-nav:hover, .session-flyout-close:hover { color: var(--text); background: var(--hover); }
.session-flyout-nav:disabled { opacity: 0.35; cursor: default; }
.session-flyout-status { padding: var(--space-8); font-size: var(--text-sm); color: var(--text-3); display: flex; align-items: center; gap: 10px; }
.session-flyout-status::before { content: ""; width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--line-3); border-top-color: var(--text); animation: ui-spin 0.8s linear infinite; }
.session-flyout-status[hidden] { display: none; }
.session-flyout-frame { flex: 1; width: 100%; border: 0; background: var(--bg); }
.session-flyout-frame[hidden] { display: none; }
body.session-peek-open .container.runs-home {
  width: calc(100% - var(--session-flyout-width)); max-width: calc(100% - var(--session-flyout-width)); margin: 0;
  --runs-cols: 14px minmax(0, 1fr) 72px 70px 40px 64px;
}
body.session-peek-open .runs-col-duration, body.session-peek-open .session-row .session-stat.duration,
body.session-peek-open .runs-col-tokens, body.session-peek-open .session-row .session-stat.tokens,
body.session-peek-open .runs-col-tools, body.session-peek-open .session-tools { display: none; }
body.session-peek-open .runs-col-cost, body.session-peek-open .session-row .session-stat.cost { grid-column: 4; }
body.session-peek-open .runs-col-grade, body.session-peek-open .session-row .session-grade-badge { grid-column: 5; }
body.session-peek-open .runs-col-actions, body.session-peek-open .session-actions { grid-column: 6; }
body.session-peek-open .session-meta .session-model, body.session-peek-open .session-meta .session-id { display: none; }
body.session-peek-open .compare-bar { left: calc((100% - var(--session-flyout-width)) / 2); }

@media (max-width: 1100px) {
  .runs-home { --runs-cols: 14px minmax(0, 1fr) 72px 70px 72px 40px 84px; }
  .runs-col-tokens, .session-row .session-stat.tokens, .runs-col-tools, .session-tools { display: none !important; }
  .runs-col-cost, .session-row .session-stat.cost { grid-column: 5 !important; }
  .runs-col-grade, .session-row .session-grade-badge { grid-column: 6 !important; }
  .runs-col-actions, .session-actions { grid-column: 7 !important; }
}
@media (max-width: 760px) {
  .runs-home { --runs-pad: var(--space-3); --runs-cols: 12px minmax(0, 1fr) 60px 40px; }
  .runs-toolbar { flex-wrap: wrap; }
  .runs-toolbar-actions { width: 100%; overflow-x: auto; }
  .runs-col-duration, .session-row .session-stat.duration, .runs-col-cost, .session-row .session-stat.cost,
  .runs-col-actions, .session-actions { display: none !important; }
  .runs-col-grade, .session-row .session-grade-badge { grid-column: 4 !important; }
  .session-meta .session-model, .session-meta .session-id { display: none; }
  html { --session-flyout-width: 100vw; }
  .pagination { flex-wrap: wrap; }
}
@media print { .compare-bar, .session-flyout, .runs-toolbar, .qf-bar { display: none !important; } }
`;
