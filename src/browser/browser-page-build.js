import { browserClientScript } from "./browser-client.js";
import { LAUNCHER_MODAL_CSS, LAUNCHER_MODAL_HTML } from "./launch-page.js";
import { appTopHtml, APP_TOP_CSS, IDENTITY_ROW_CSS } from "./app-chrome.js";
import { COMMAND_PALETTE_CSS, COMMAND_PALETTE_HTML } from "./command-palette.js";
import { STANDALONE_BASE_CSS } from "../render/render-css.js";


const HTML_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Runs · tracequest</title>
<style>
${STANDALONE_BASE_CSS}
${APP_TOP_CSS}
/* the inventory scrolls — keep the shared app bar as the persistent frame */
.app-top { position: sticky; top: 0; z-index: 150; }
/* Runs home is a full-width inventory, not a 720px landing card feed */
.container.runs-home {
  --runs-check: 28px;
  --runs-cols: 56px 72px 88px minmax(0, 1.6fr) minmax(0, 0.6fr) minmax(0, 0.5fr) 72px 56px 64px 56px 36px 56px 28px;
  max-width: none;
  width: 100%;
  margin: 0;
  padding: 10px 16px 56px;
  box-sizing: border-box;
}
.runs-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin: 2px 0 10px;
}
.runs-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  letter-spacing: -0.02em;
  line-height: 1.2;
  color: var(--fg);
}
.runs-count {
  font-size: 13px;
  color: var(--fg3);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.runs-chrome { margin-bottom: 8px; display: flex; flex-direction: column; gap: 8px; }
.runs-toolbar {
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.runs-toolbar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding-top: 1px;
}
.toolbar-pop { position: relative; }
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--fg2);
  font-size: 12px;
  font-family: var(--sans);
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.12s, color 0.12s, background 0.12s;
}
.toolbar-btn:hover { color: var(--fg); border-color: rgba(255,255,255,0.14); }
.toolbar-btn[aria-expanded="true"],
.toolbar-btn.active {
  color: var(--fg);
  border-color: var(--accent);
  background: rgba(139,124,246,0.08);
}
.toolbar-btn.has-value { color: var(--fg); }
.toolbar-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 176px;
  max-height: 280px;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 4px;
  z-index: 120;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.toolbar-menu[hidden] { display: none; }
.toolbar-option {
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
.toolbar-option:hover { background: var(--surface2); color: var(--fg); }
.toolbar-option.active { color: var(--fg); background: rgba(139,124,246,0.08); }
.toolbar-option-count { font-size: 11px; color: var(--fg3); font-family: var(--mono); }
.runs-inventory {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  overflow: hidden;
}
.runs-table-head,
.session-row-wrap {
  display: grid;
  grid-template-columns: var(--runs-check) minmax(0, 1fr);
  align-items: center;
  column-gap: 4px;
}
.runs-table-head {
  padding: 0 10px;
  min-height: 30px;
  border-bottom: 1px solid var(--border);
  background: rgba(255,255,255,0.02);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--fg3);
}
.runs-table-cols,
.session-row {
  display: grid;
  grid-template-columns: var(--runs-cols);
  align-items: center;
  column-gap: 8px;
  min-width: 0;
  overflow: hidden;
}
.runs-table-cols > *,
.session-row > * { min-width: 0; }
.runs-col-check { width: var(--runs-check); flex-shrink: 0; }
.runs-table-cols > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.live-indicator, .run-state-badge, .run-state-slot { grid-column: 1; }
.session-source { grid-column: 2; justify-self: start; }
.session-id { grid-column: 3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-primary { grid-column: 4; min-width: 0; max-width: 100%; width: 100%; overflow: hidden; align-items: flex-start; }
.run-origin { align-self: flex-start; }
.session-project { grid-column: 5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; justify-self: start; width: auto; }
.session-model { grid-column: 6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: none; }
.session-time { grid-column: 7; }
.session-stat.duration { grid-column: 8; }
.session-stat.tokens { grid-column: 9; }
.session-stat.cost { grid-column: 10; }
.session-grade-badge { grid-column: 11; }
.session-tools { grid-column: 12; }
.session-actions { grid-column: 13; justify-self: end; display: inline-flex; align-items: center; gap: 4px; }
.session-badge { display: none; }
.runs-inventory .empty, .runs-inventory .fetch-error { padding: 36px 16px; }
.refresh-status {
  min-width: 76px;
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.refresh-status[hidden] { display: inline-block; visibility: hidden; }
.refresh-status[data-state="pending"] { color: var(--fg2); }
.refresh-status[data-state="stale"] { color: var(--orange); }
.refresh-status[data-state="error"] { color: var(--red); }
.header-link {
  color: var(--fg3);
  font-size: 11px;
  font-family: var(--mono);
  text-decoration: none;
  transition: color 0.12s;
}
.header-link:hover { color: var(--accent); }

.filter-wrap { position: relative; margin-bottom: 0; flex: 1; min-width: 0; }
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 3px 8px;
  cursor: text;
  transition: border-color 0.15s;
}
.filter-bar:focus-within { border-color: rgba(255,255,255,0.14); }
.filter-input {
  flex: 1;
  min-width: 120px;
  background: none;
  border: none;
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  outline: none;
  padding: 4px 0;
}
.filter-input::placeholder { color: var(--fg3); }
.filter-hint {
  color: var(--fg3);
  font-size: 11px;
  font-family: var(--mono);
  background: var(--surface2);
  padding: 1px 6px;
  border-radius: 4px;
  pointer-events: none;
  opacity: 0.7;
  flex-shrink: 0;
}
.filter-bar:focus-within .filter-hint { display: none; }

.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 6px 3px 8px;
  font-size: 12px;
  font-family: var(--sans);
  white-space: nowrap;
  max-width: 280px;
  user-select: none;
}
.chip.negated { background: rgba(240, 112, 112, 0.06); border-color: rgba(240, 112, 112, 0.2); }
.chip-key { color: var(--fg2); margin-right: 0; font-weight: 500; }
.chip-op { color: var(--fg3); font-size: 11px; }
.chip-value { color: var(--fg); overflow: hidden; text-overflow: ellipsis; font-family: var(--mono); font-size: 11px; }
.chip-remove {
  background: none;
  border: none;
  color: var(--fg3);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
  margin-left: 0;
  border-radius: 3px;
  opacity: 0.7;
  transition: opacity 0.1s, color 0.1s;
}
.chip:hover .chip-remove { opacity: 1; }
.chip-remove:hover { color: var(--red); }
.applied-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-height: 28px;
}
.applied-match {
  margin-left: auto;
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  white-space: nowrap;
}

.suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  margin-top: 4px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  max-height: 280px;
  overflow-y: auto;
  z-index: 100;
  display: none;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.suggestions.open { display: block; }
.suggestion-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  font-size: 13px;
  font-family: var(--mono);
  color: var(--fg2);
  transition: background 0.08s;
}
.suggestion-item:first-child { border-radius: 8px 8px 0 0; }
.suggestion-item:last-child { border-radius: 0 0 8px 8px; }
.suggestion-item:hover, .suggestion-item.hl { background: var(--surface2); color: var(--fg); }
.suggestion-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.suggestion-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.suggestion-count { font-size: 11px; color: var(--fg3); flex-shrink: 0; }

.session-row-wrap {
  margin: 0;
  padding: 0 10px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.session-row-wrap:last-child { border-bottom: none; }
.session-row-wrap .compare-cb {
  margin: 0;
  justify-self: center;
}
.session-row {
  flex: 1;
  min-width: 0;
  padding: 7px 0;
  background: transparent;
  border-radius: 0;
  text-decoration: none;
  color: var(--fg);
  transition: background 0.12s;
}
.session-row-wrap:hover { background: var(--surface2); }
.session-row-wrap.is-selected {
  background: rgba(139,124,246,0.08);
  box-shadow: inset 2px 0 0 var(--accent);
}
.session-row-wrap.is-selected:hover { background: rgba(139,124,246,0.11); }
.session-row:hover { background: transparent; }
${IDENTITY_ROW_CSS}
.session-stats { display: contents; }
.session-spacer { display: none; }
.session-time { font-size: 11px; color: var(--fg2); white-space: nowrap; font-variant-numeric: tabular-nums; }
.session-size { display: none; }
.session-primary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  min-width: 0;
}
.session-prompt {
  font-size: 13px; color: var(--fg);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.3;
  margin: 0; max-width: 100%; width: 100%;
}
.run-activity, .run-activity-text { max-width: 100%; }
.session-stat { display: none; font-variant-numeric: tabular-nums; font-size: 11px; font-family: var(--mono); color: var(--fg2); }
.session-stat.duration, .session-stat.tokens, .session-stat.cost { display: inline-flex; }
.session-stat.cost { color: var(--orange); }
.session-tools {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  min-width: 0;
  overflow: hidden;
}
.session-tools .session-tool { display: none; }
.live-indicator {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  font-size: 9px; font-family: var(--mono); font-weight: 700; color: var(--green);
  text-transform: uppercase; letter-spacing: 0.5px;
}
.live-indicator::before {
  content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--green);
  animation: live-pulse 2s ease-in-out infinite;
}
/* live rows: ONE first-class row per live agent in the main session list —
   launched runs and externally-detected live sessions share the treatment */
.run-row-wrap .runs-col-check { width: var(--runs-check); }
.session-row.run-row { cursor: pointer; }
.session-row.run-row:focus-visible { background: var(--surface2); outline: none; }
.session-row.run-row[data-run-status="running"] { border-left: 2px solid rgba(74,222,128,0.5); }
.run-activity {
  display: flex; align-items: center; gap: 6px; margin-top: 0;
  font-size: 11px; color: var(--fg2); font-family: var(--mono);
  white-space: nowrap; overflow: hidden;
}
.run-activity[data-status="exited"] { color: var(--fg3); }
.run-activity-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--green);
  flex-shrink: 0; animation: live-pulse 1.2s ease-in-out infinite;
}
.run-activity-text { overflow: hidden; text-overflow: ellipsis; }
.run-dismiss {
  background: none; border: none; color: var(--fg3); align-self: center;
  font-size: 14px; line-height: 1; padding: 0 4px; border-radius: 4px;
  cursor: pointer; transition: color 0.12s; flex-shrink: 0;
}
.run-dismiss:hover { color: var(--red); }
/* Continue: resume the row's session as a NEW tracequest run */
.session-continue {
  display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
  background: none; border: 1px solid var(--border); border-radius: 999px;
  padding: 1px 8px; font-size: 10px; font-family: var(--mono);
  color: var(--fg3); cursor: pointer;
  transition: color 0.12s, border-color 0.12s;
}
.session-continue:hover { color: var(--accent); border-color: var(--accent); }
.session-continue:disabled { opacity: 0.5; cursor: default; }
.session-continue.failed { color: var(--red); border-color: var(--red); }
/* Inline continue composer: opens IN the row — typing is the continue */
.session-continue-form {
  display: flex; flex-direction: column; gap: 4px;
  grid-column: 1 / -1;
  margin: 0 10px 8px 38px; padding: 7px 10px;
  background: var(--bg); border: 1px solid rgba(139, 124, 246, 0.35);
  border-radius: 10px;
}
.session-continue-form:focus-within { border-color: rgba(139, 124, 246, 0.7); }
.session-continue-form[data-mode="cwd"] { border-color: rgba(240, 160, 112, 0.5); }
.session-continue-msg { font-size: 11px; color: #f0a070; overflow-wrap: anywhere; }
.session-continue-msg[hidden] { display: none; }
.session-continue-row { display: flex; align-items: center; gap: 8px; }
.session-continue-glyph { flex-shrink: 0; color: var(--accent); font-size: 11px; }
.session-continue-form[data-mode="cwd"] .session-continue-glyph { color: #f0a070; }
.session-continue-input {
  flex: 1; min-width: 0; background: none; border: none; outline: none;
  color: var(--fg); font-size: 12.5px; font-family: var(--sans, inherit);
}
.session-continue-input::placeholder { color: var(--fg3); }
.session-continue-send {
  flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px;
  background: rgba(139, 124, 246, 0.08); border: 1px solid rgba(139, 124, 246, 0.5);
  border-radius: 999px; padding: 2px 10px; font-size: 11px; font-family: var(--mono);
  color: var(--accent); cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
}
.session-continue-send:hover { background: rgba(139, 124, 246, 0.16); border-color: var(--accent); }
.session-continue-send:disabled { opacity: 0.5; cursor: default; }
.session-tool {
  font-size: 10px; font-family: var(--mono);
  padding: 1px 5px; border-radius: 3px; background: rgba(255,255,255,0.04);
}
.tool-sparkline {
  display: inline-flex; height: 8px; width: 56px; border-radius: 4px;
  overflow: hidden; background: rgba(255,255,255,0.04); flex-shrink: 0;
  vertical-align: middle;
}
.tool-spark-seg {
  height: 100%; min-width: 1px; position: relative;
}
.tool-spark-seg:hover { opacity: 0.8; }
.tool-spark-seg .tool-spark-tip {
  display: none; position: absolute; bottom: 12px; left: 50%;
  transform: translateX(-50%); white-space: nowrap; font-size: 10px;
  font-family: var(--mono); padding: 2px 6px; border-radius: 3px;
  background: var(--surface2); border: 1px solid var(--border);
  color: var(--fg); z-index: 10; pointer-events: none;
}
.tool-spark-seg:hover .tool-spark-tip { display: block; }
.filter-legend {
  font-size: 11px; color: var(--fg3); margin-top: 4px; line-height: 1.6;
  font-family: var(--mono);
  display: none;
}
.filter-legend span { color: var(--fg2); }
.empty { color: var(--fg3); text-align: center; padding: 48px 0; font-size: 13px; }
.fetch-error { color: var(--red); text-align: center; padding: 48px 16px; font-size: 13px; }
#load-more { height: 1px; }

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  margin-top: 16px;
  padding: 10px 0;
  font-family: var(--mono);
  font-size: 12px;
  user-select: none;
}
.pagination.hidden { display: none; }
.page-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 28px;
  padding: 0 8px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
  transition: all 0.15s;
}
.page-btn:hover { color: var(--fg); border-color: rgba(255,255,255,0.18); background: rgba(255,255,255,0.06); }
.page-btn.active { color: var(--accent); border-color: var(--accent); background: rgba(139,124,246,0.08); cursor: default; }
.page-btn:disabled { opacity: 0.35; cursor: default; pointer-events: none; }
.page-info {
  color: var(--fg3);
  font-size: 11px;
  padding: 0 4px;
  white-space: nowrap;
}
.page-info strong { color: var(--fg2); }
.page-size-wrap {
  margin-left: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--fg3);
  font-size: 11px;
}
.page-size-select {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg2);
  font-family: var(--mono);
  font-size: 11px;
  padding: 2px 4px;
  cursor: pointer;
}
@media (max-width: 600px) {
  .pagination { gap: 4px; flex-wrap: wrap; }
  .page-btn { min-width: 28px; height: 26px; font-size: 10px; }
  .page-size-wrap { display: none; }
}

.sort-bar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  margin-bottom: 0;
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  min-width: 168px;
  max-height: none;
  overflow: visible;
}
.sort-label {
  margin: 2px 8px 4px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.sort-btn {
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--fg3);
  font-size: 12px;
  font-family: var(--sans);
  padding: 6px 8px;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
  text-align: left;
}
.sort-btn:hover { color: var(--fg); background: var(--surface2); }
.sort-btn.active { color: var(--fg); background: rgba(139,124,246,0.08); }

.session-row.has-errors { border-left: 2px solid rgba(240,112,112,0.4); }
.session-row.has-commits { border-left: 2px solid rgba(74,222,128,0.4); }
.session-row.expensive { border-left: 2px solid rgba(232,164,76,0.4); }
.session-row.has-errors.has-commits { border-left: 2px solid rgba(240,112,112,0.4); }
.session-row.has-errors.expensive { border-left: 2px solid rgba(240,112,112,0.4); }

.session-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
  white-space: nowrap;
}
.session-badge.error-badge { color: var(--red); background: rgba(240,112,112,0.08); }
.session-badge.commit-badge { color: var(--green); background: rgba(74,222,128,0.08); }
.session-badge.cost-badge { color: var(--orange); background: rgba(232,164,76,0.08); }
.runs-home .session-badge { display: none; }
.session-actions .session-continue { opacity: 0; }
.session-row-wrap:hover .session-continue,
.session-row-wrap:focus-within .session-continue { opacity: 1; }
.session-model { justify-self: start; max-width: 100%; }

/* --- Dashboard: always-visible scan strip on the Runs inventory --- */
.dashboard {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  padding: 4px 2px 8px;
  margin-bottom: 0;
}
.dashboard-header {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 0;
  flex: 0 0 auto;
}
.dashboard-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--fg3);
}
.dashboard-scope {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
}
.dashboard-stats {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 20px;
  font-family: var(--mono);
  color: var(--fg2);
  margin-bottom: 0;
  flex: 1 1 auto;
}
.dashboard-stat {
  display: inline-flex;
  flex-direction: row;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.dashboard-stat-val {
  font-weight: 600;
  color: var(--fg);
  font-variant-numeric: tabular-nums;
  font-size: 14px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dashboard-stat-label {
  color: var(--fg3);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.dashboard-stat-growth {
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.dashboard-stat-growth.up { color: var(--green); }
.dashboard-stat-growth.down { color: var(--red); }
.dashboard-stat-sep {
  display: none;
}

.dashboard-tools {
  margin-top: 0;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  flex: 1 1 100%;
}
.dashboard-tools-title {
  font-size: 11px;
  color: var(--fg3);
  margin-bottom: 6px;
  font-family: var(--mono);
}
.dashboard-tools-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dashboard-tool-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255,255,255,0.03);
  border: 1px solid var(--border);
}
.dashboard-tool-count {
  font-variant-numeric: tabular-nums;
  opacity: 0.7;
}


.dashboard.collapsed .dashboard-tools { display: none; }
.dashboard-toggle {
  background: none;
  border: none;
  color: var(--fg3);
  font-size: 11px;
  font-family: var(--mono);
  cursor: pointer;
  margin-left: auto;
  padding: 0 4px;
  transition: color 0.12s;
}
.dashboard-toggle:hover { color: var(--fg2); }

/* --- Quick Filter Bar: Linear-style chips + dimension pickers --- */
.qf-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 0;
  padding: 0 2px 2px;
  background: transparent;
  border: none;
  border-radius: 0;
}
.qf-bar[hidden] { display: none; }
.qf-pickers {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
}
.qf-pickers[hidden] { display: none; }
.qf-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.qf-section {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.qf-section-label {
  font-size: 10px;
  color: var(--fg3);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-right: 2px;
  white-space: nowrap;
}
.qf-sep {
  display: none;
}
.qf-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: none;
  color: var(--fg3);
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
  user-select: none;
}
.qf-chip:hover { color: var(--fg2); border-color: rgba(255,255,255,0.14); background: var(--surface2); }
.qf-chip.qf-active { color: var(--fg); border-color: var(--accent); background: var(--accent-dim); }
.qf-chip .qf-chip-count {
  font-size: 10px;
  opacity: 0.6;
}
.qf-grade {
  font-weight: 700;
  font-size: 12px;
  width: 24px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: none;
  cursor: pointer;
  transition: all 0.12s;
  padding: 0;
  font-family: var(--mono);
}
.qf-grade:hover { border-color: rgba(255,255,255,0.14); }
.qf-grade.qf-active { border-width: 2px; }
.qf-grade.qf-g-a { color: var(--green); }
.qf-grade.qf-g-a.qf-active { border-color: var(--green); background: rgba(74,222,128,0.10); }
.qf-grade.qf-g-b { color: var(--green); opacity: 0.8; }
.qf-grade.qf-g-b.qf-active { border-color: var(--green); background: rgba(74,222,128,0.07); opacity: 1; }
.qf-grade.qf-g-c { color: var(--orange); }
.qf-grade.qf-g-c.qf-active { border-color: var(--orange); background: rgba(232,164,76,0.10); }
.qf-grade.qf-g-d { color: #d97740; }
.qf-grade.qf-g-d.qf-active { border-color: #d97740; background: rgba(217,119,64,0.10); }
.qf-grade.qf-g-f { color: var(--red); }
.qf-grade.qf-g-f.qf-active { border-color: var(--red); background: rgba(240,112,112,0.10); }
.qf-grade.qf-disabled { opacity: 0.25; cursor: default; }
.qf-error-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: none;
  color: var(--fg3);
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
}
.qf-error-toggle:hover { color: var(--red); border-color: rgba(240,112,112,0.3); }
.qf-error-toggle.qf-active { color: var(--red); border-color: var(--red); background: rgba(240,112,112,0.08); }
.qf-clear {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--fg3);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  transition: color 0.12s;
  margin-left: auto;
  display: none;
  white-space: nowrap;
}
.qf-clear:hover { color: var(--accent); }
.qf-clear.qf-visible { display: inline-block; }

@media (max-width: 1100px) {
  .container.runs-home {
    --runs-cols: 52px 64px 80px minmax(140px, 1.4fr) minmax(64px, 0.6fr) 64px 56px 52px 36px auto;
  }
  .runs-col-model, .session-model, .runs-col-tools, .session-tools { display: none; }
}
@media (max-width: 900px) {
  .session-top { gap: 6px; }
  .session-model { max-width: 100px; }
  .session-project { max-width: 120px; }
  .session-badge { font-size: 9px; padding: 0 4px; }
  .session-stats { gap: 2px 6px; }
}
@media (max-width: 600px) {
  .container.runs-home { padding: 10px 12px 48px; }
  .session-model, .session-project, .runs-col-project, .runs-col-duration, .session-stat.duration { display: none; }
  .session-badge { display: none; }
  .sort-bar { flex-wrap: wrap; }
  .runs-toolbar { flex-direction: column; }
  .runs-toolbar-actions { flex-wrap: wrap; }
  .dashboard-stats { gap: 8px 12px; }
  .dashboard-stat-val { font-size: 13px; }
  .qf-bar { gap: 6px; }
  .qf-section-label { display: none; }
  .applied-match { display: none; }

}

.compare-cb {
  position: relative;
  width: 16px; height: 16px;
  flex-shrink: 0;
  appearance: none; -webkit-appearance: none;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.12s;
  margin-right: 4px;
}
.compare-cb:hover { border-color: rgba(255,255,255,0.18); }
.compare-cb:checked {
  background: var(--accent);
  border-color: var(--accent);
}
.compare-cb:checked::after {
  content: '';
  position: absolute;
  left: 4px; top: 1px;
  width: 5px; height: 9px;
  border: solid #111; border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.compare-bar {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  background: var(--surface);
  border-top: 1px solid var(--border);
  padding: 10px 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  z-index: 200;
  transform: translateY(100%);
  transition: transform 0.2s ease;
  box-shadow: 0 -4px 20px rgba(0,0,0,0.4);
}
.compare-bar.visible { transform: translateY(0); }
.compare-bar-info {
  font-size: 13px;
  color: var(--fg2);
  font-family: var(--mono);
}
.compare-bar-info strong { color: var(--fg); font-weight: 500; }
.compare-btn {
  background: var(--accent);
  color: #111;
  border: none;
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 13px;
  font-family: var(--sans);
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
}
.compare-btn:hover { opacity: 0.85; }
.compare-btn:disabled { opacity: 0.4; cursor: default; }
.compare-clear {
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg3);
  padding: 6px 12px;
  font-size: 12px;
  font-family: var(--mono);
  cursor: pointer;
  transition: all 0.12s;
}
.compare-clear:hover { color: var(--fg2); border-color: rgba(255,255,255,0.14); }

/* --- Run analytics flyout (RHS inspector; inventory stays) --- */
html { --session-flyout-width: min(760px, 56vw); --app-top-h: 44px; }
.session-flyout {
  position: fixed;
  top: var(--app-top-h); right: 0; bottom: 0;
  width: var(--session-flyout-width);
  z-index: 155;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: -16px 0 40px rgba(0,0,0,0.32);
}
.session-flyout[hidden] { display: none !important; }
.session-flyout-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  box-shadow: inset 2px 0 0 var(--accent);
  flex-shrink: 0;
}
.session-flyout-ident { min-width: 0; }
.session-flyout-kicker {
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 600;
  letter-spacing: 0.45px;
  text-transform: uppercase;
  color: var(--fg3);
}
.session-flyout-title {
  margin: 2px 0 0;
  font-size: 14px;
  font-weight: 600;
  font-family: var(--mono);
  color: var(--fg);
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-flyout-sub {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--fg2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 28rem;
}
.session-flyout-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.session-flyout-open {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  text-decoration: none;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: nowrap;
}
.session-flyout-open:hover { color: var(--fg); border-color: rgba(255,255,255,0.14); }
.session-flyout-nav,
.session-flyout-close {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.session-flyout-nav:hover, .session-flyout-close:hover { color: var(--fg); background: var(--surface2); }
.session-flyout-nav:disabled { opacity: 0.35; cursor: default; }
.session-flyout-status {
  padding: 16px 18px;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg3);
}
.session-flyout-status[hidden] { display: none; }
.session-flyout-frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: var(--bg);
  min-height: 0;
}
.session-flyout-frame[hidden] { display: none; }
body.session-peek-open .container.runs-home {
  width: calc(100% - var(--session-flyout-width));
  max-width: calc(100% - var(--session-flyout-width));
  --runs-cols: 48px 56px 72px minmax(160px, 1fr) 56px 52px 28px;
}
body.session-peek-open .runs-col-project,
body.session-peek-open .session-project,
body.session-peek-open .runs-col-model,
body.session-peek-open .session-model,
body.session-peek-open .runs-col-tools,
body.session-peek-open .session-tools,
body.session-peek-open .runs-col-duration,
body.session-peek-open .session-stat.duration,
body.session-peek-open .runs-col-tokens,
body.session-peek-open .session-stat.tokens { display: none; }
body.session-peek-open .compare-bar { right: var(--session-flyout-width); }

/* --- Global Search --- */
${LAUNCHER_MODAL_CSS}
${COMMAND_PALETTE_CSS}
</style>
</head>
<body>
${appTopHtml({
  crumbHtml: '<span class="app-crumb">Runs</span>',
  extraHtml: '\n    <div class="refresh-status" id="refreshStatus" aria-live="polite" data-state="idle" hidden></div>',
})}
<div class="container runs-home">
  <div class="runs-head">
    <h1 class="runs-title">Runs</h1>
    <span class="runs-count" id="count"></span>
  </div>
  <div class="runs-chrome">
  <div class="runs-toolbar" id="runsToolbar">
  <div class="filter-wrap">
    <div class="filter-bar" id="filterBar">
      <input class="filter-input" id="filterInput" type="text" aria-label="Filter runs" aria-controls="suggestions" aria-autocomplete="list" placeholder="Filter — e.g. foo AND (tool:Read OR tool:Edit)" value="`;
const HTML_MIDDLE = `">
    </div>
    <div class="suggestions" id="suggestions" role="listbox" aria-label="Filter suggestions"></div>
    <div class="filter-legend">
      <span>project:</span> <span>source:</span> <span>host:</span> <span>tool:</span> <span>model:</span> <span>size:&gt;N</span> <span>age:&lt;Nd</span> &middot; AND &middot; OR &middot; NOT &middot; (parens) &middot; bare words = AND &middot; <span>-</span>prefix = NOT
    </div>
  </div>
    <div class="runs-toolbar-actions">
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
          <button class="sort-btn active" data-sort="recent" aria-pressed="true">recent</button>
          <button class="sort-btn" data-sort="duration" aria-pressed="false">duration</button>
          <button class="sort-btn" data-sort="cost" aria-pressed="false">cost</button>
          <button class="sort-btn" data-sort="tokens" aria-pressed="false">tokens</button>
          <button class="sort-btn" data-sort="errors" aria-pressed="false">errors</button>
          <button class="sort-btn" data-sort="files" aria-pressed="false">files</button>
          <button class="sort-btn" data-sort="commits" aria-pressed="false">commits</button>
          <button class="sort-btn" data-sort="chapters" aria-pressed="false">chapters</button>
          <button class="sort-btn" data-sort="grade" aria-pressed="false">grade</button>
        </div>
      </div>
    </div>
  </div>
  <div class="dashboard" id="dashboard"></div>
  <div class="qf-bar" id="qfBar" hidden></div>
  </div>
  <div class="runs-inventory">
    <div class="runs-table-head" aria-hidden="true">
      <span class="runs-col-check"></span>
      <div class="runs-table-cols">
        <span class="runs-col-state">State</span>
        <span class="runs-col-source">Source</span>
        <span class="runs-col-id">ID</span>
        <span class="runs-col-run">Run</span>
        <span class="runs-col-project">Project</span>
        <span class="runs-col-model">Model</span>
        <span class="runs-col-time">Time</span>
        <span class="runs-col-duration">Duration</span>
        <span class="runs-col-tokens">Tokens</span>
        <span class="runs-col-cost">Cost</span>
        <span class="runs-col-grade">Grade</span>
        <span class="runs-col-tools">Tools</span>
        <span class="runs-col-actions"></span>
      </div>
    </div>
    <div id="sessions"></div>
  </div>
  <div class="pagination hidden" id="pagination"></div>
</div>
<div class="compare-bar" id="compareBar" role="region" aria-label="Compare selection">
  <span class="compare-bar-info" id="compareInfo" aria-live="polite">Select 2 runs to compare</span>
  <button class="compare-btn" id="compareBtn" disabled>Compare</button>
  <button class="compare-clear" id="compareClear">Clear</button>
</div>
<aside id="sessionFlyout" class="session-flyout" hidden aria-hidden="true" role="dialog" aria-modal="true" aria-label="Run analytics" tabindex="-1">
  <header class="session-flyout-head">
    <div class="session-flyout-ident">
      <span class="session-flyout-kicker">Run</span>
      <h2 class="session-flyout-title" id="sessionFlyoutTitle"></h2>
      <p class="session-flyout-sub" id="sessionFlyoutSub"></p>
    </div>
    <div class="session-flyout-actions">
      <a class="session-flyout-open" id="sessionFlyoutOpen" href="/view">Open full page</a>
      <button type="button" class="session-flyout-nav" id="sessionFlyoutPrev" aria-label="Previous run" title="Previous run (K)" data-hotkey="k,K,ArrowUp">&#8593;</button>
      <button type="button" class="session-flyout-nav" id="sessionFlyoutNext" aria-label="Next run" title="Next run (J)" data-hotkey="j,J,ArrowDown">&#8595;</button>
      <button type="button" class="session-flyout-close" id="sessionFlyoutClose" aria-label="Close run analytics">&#215;</button>
    </div>
  </header>
  <div class="session-flyout-status" id="sessionFlyoutStatus" hidden>Loading analytics&#8230;</div>
  <iframe class="session-flyout-frame" id="sessionFlyoutFrame" title="Run analytics" tabindex="-1" hidden></iframe>
</aside>
${LAUNCHER_MODAL_HTML}
${COMMAND_PALETTE_HTML}
<script>
`;
const HTML_TAIL = `
</script>
</body>
</html>`;

export function browserPageHTML(data, filterVal) {
  return HTML_HEAD + filterVal + HTML_MIDDLE + browserClientScript(data) + HTML_TAIL;
}
