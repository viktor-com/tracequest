/**
 * Compare (/compare?a=…&b=…) — answer first (verdict), then the two runs,
 * then one metrics table (label · A · B · B vs A), tools and chapter quality.
 * Side A is ink, side B is the accent, everywhere a side is named.
 */
export const COMPARE_PAGE_CSS = `
.container { max-width: 1040px; margin: 0 auto; padding: var(--space-6) var(--space-8) 120px; min-width: 0; }
.cmp-verdict, .cmp-session-prompt { overflow-wrap: anywhere; }

.cmp-header { display: flex; flex-direction: column; gap: var(--space-2); margin-bottom: var(--space-5); }
.cmp-back { align-self: flex-start; font-size: var(--text-sm); color: var(--text-3); transition: color var(--dur-2) var(--ease-out); }
.cmp-back:hover { color: var(--text); }
.cmp-title-row { display: flex; align-items: center; gap: var(--space-4); }
.cmp-title { font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: var(--weight-regular); letter-spacing: var(--track-display); }
.cmp-swap {
  margin-left: auto; display: inline-flex; align-items: center; gap: 6px; height: var(--control-md); padding: 0 14px;
  border-radius: var(--radius-pill); font-size: var(--text-sm); color: var(--text-2); box-shadow: inset 0 0 0 1px var(--line-2);
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.cmp-swap:hover { background: var(--hover); color: var(--text); }
.cmp-swap[hidden] { display: none; }

.cmp-side {
  display: inline-grid; place-items: center; width: 18px; height: 18px; margin-right: 8px; border-radius: 5px;
  font-size: 11px; font-weight: var(--weight-medium); color: var(--paper); background: var(--ink); vertical-align: 1px;
}
.session-b .cmp-side, .cmp-col-b .cmp-side, .tool-cmp-head > span:last-child .cmp-side { background: var(--surface-4); color: var(--text); }
.cmp-side { background: var(--surface-4); color: var(--text); }

.cmp-verdict {
  margin: 0 0 var(--space-6); font-size: var(--text-xl); line-height: 1.45; letter-spacing: var(--track-tight); color: var(--text); max-width: 860px;
}
.cmp-verdict-side { color: var(--text-2); }

.cmp-sessions { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); margin-bottom: var(--space-8); }
.cmp-session {
  display: flex; flex-direction: column; gap: var(--space-3); min-width: 0; padding: var(--space-5);
  border-radius: var(--radius-lg); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1);
}

.cmp-session-label { display: flex; align-items: center; font-size: var(--text-xs); color: var(--text-3); }
.cmp-session-prompt {
  font-size: var(--text-md); line-height: var(--lh-md); color: var(--text); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: calc(var(--lh-md) * 2);
}
.cmp-muted { color: var(--text-3); }
.cmp-session-id { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; font-size: var(--text-xs); color: var(--text-3); min-width: 0; }
.cmp-source-badge { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); font-size: var(--text-xs); }
.cmp-source-badge::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--hue-other)); }
.cmp-session-model { color: var(--text-3); }
.cmp-session-hash { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.cmp-session-link { align-self: flex-start; font-size: var(--text-sm); color: var(--text-2); transition: color var(--dur-2) var(--ease-out); }
.cmp-session-link:hover { color: var(--text); }

.cmp-section { display: flex; flex-direction: column; gap: var(--space-3); margin-bottom: var(--space-8); min-width: 0; }
.cmp-section-title { font-size: var(--text-lg); font-weight: var(--weight-regular); letter-spacing: var(--track-tight); color: var(--text); }
.cmp-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: var(--space-8); }
.cmp-empty { font-size: var(--text-sm); color: var(--text-3); padding: var(--space-3) 0; }

.cmp-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--text-sm); }
.cmp-table thead th {
  text-align: right; font-weight: var(--weight-regular); font-size: var(--text-xs); color: var(--text-3);
  padding: 0 var(--space-3) 10px; box-shadow: inset 0 -1px 0 var(--line-2); white-space: nowrap;
}
.cmp-table thead th.cmp-col-label { text-align: left; }
.cmp-col-a, .cmp-col-b { font-family: var(--font-mono); font-size: 11.5px; }
.cmp-col-delta { width: 1%; }
.cmp-table td { padding: 9px var(--space-3); box-shadow: inset 0 -1px 0 var(--line-1); vertical-align: middle; }
.cmp-table tbody tr { transition: background var(--dur-1) var(--ease-out); }
.cmp-table tbody tr:hover { background: var(--hover); }
.cmp-table tbody tr:last-child td { box-shadow: none; }
.cmp-label { color: var(--text-2); white-space: nowrap; }
.cmp-val { text-align: right; color: var(--text); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cmp-val.delta-good { color: var(--text); }
.cmp-val.delta-bad { color: var(--bad); }
.cmp-delta-cell { text-align: right; white-space: nowrap; }
.cmp-delta {
  display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-2); background: var(--surface-2); font-variant-numeric: tabular-nums;
}

.tool-cmp-head { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); padding-bottom: 6px; box-shadow: inset 0 -1px 0 var(--line-2); }
.tool-cmp-head > span:first-child { text-align: right; }
.tool-cmp-row { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; padding: 5px 0; }
.tool-cmp-bar-wrap { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tool-cmp-left { flex-direction: row-reverse; }
.tool-cmp-bar { height: 6px; border-radius: 999px; min-width: 2px; opacity: 0.85; transition: opacity var(--dur-2) var(--ease-out); }
.tool-cmp-row:hover .tool-cmp-bar { opacity: 1; }
.tool-cmp-count { font-size: var(--text-xs); color: var(--text-3); font-variant-numeric: tabular-nums; min-width: 22px; }
.tool-cmp-left .tool-cmp-count { text-align: right; }
.tool-cmp-right .tool-cmp-count { text-align: left; }
.tool-cmp-name {
  display: inline-flex; align-items: center; gap: 6px; justify-content: center; font-size: var(--text-xs); color: var(--text-2);
  max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tool-cmp-name::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--hue-other)); flex: none; }

.cmp-outcome { display: grid; grid-template-columns: 1fr; gap: var(--space-5); }
.cmp-outcome-side { display: flex; flex-direction: column; gap: 8px; }
.cmp-outcome-id { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.cmp-outcome-bar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; gap: 2px; background: var(--surface-3); }
.cmp-outcome-seg { height: 100%; }
.cmp-outcome-seg.clean { background: var(--ok); }
.cmp-outcome-seg.corrected { background: var(--warn); }
.cmp-outcome-seg.struggling { background: var(--bad); }
.cmp-outcome-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--text-xs); color: var(--text-3); }
.cmp-outcome-legend-item { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; }
.cmp-outcome-dot { width: 7px; height: 7px; border-radius: 50%; }
.cmp-outcome-dot.clean { background: var(--ok); }
.cmp-outcome-dot.corrected { background: var(--warn); }
.cmp-outcome-dot.struggling { background: var(--bad); }

.cmp-error { max-width: 560px; margin: 12vh auto 0; display: flex; flex-direction: column; gap: var(--space-3); }
.cmp-error-status { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-3); }
.cmp-error-title { font-size: var(--text-2xl); line-height: var(--lh-2xl); letter-spacing: var(--track-display); }
.cmp-error-message { font-size: var(--text-md); color: var(--text-2); }
.cmp-error-handle {
  font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-2); overflow-wrap: anywhere;
  padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1);
}
.cmp-error-actions { margin-top: var(--space-2); }
.cmp-error-link {
  display: inline-flex; align-items: center; height: var(--control-md); padding: 0 16px; border-radius: var(--radius-pill);
  background: var(--ink); color: var(--paper); font-size: var(--text-sm);
}

@media (max-width: 600px) {
  .container { padding: 24px 12px; }
  .cmp-sessions { grid-template-columns: 1fr; }
  .cmp-grid { grid-template-columns: 1fr; gap: var(--space-4); }
  .cmp-outcome { grid-template-columns: 1fr; }
  .cmp-verdict { font-size: var(--text-lg); }
  .cmp-table { table-layout: fixed; }
  .cmp-table td, .cmp-table thead th { padding-left: 6px; padding-right: 6px; overflow: hidden; text-overflow: ellipsis; }
  .cmp-col-delta, .cmp-delta-cell { display: none; }
  .cmp-label { white-space: normal; }
  .cmp-col-a, .cmp-col-b { white-space: nowrap; }
  .cmp-session-id { gap: 4px 8px; }
  .cmp-title-row { flex-wrap: wrap; }
  .cmp-swap { margin-left: 0; }
  .tool-cmp-head { font-size: 10.5px; }
  .tool-cmp-head > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmp-label { font-size: 12px; }
  .cmp-val { font-size: 12px; }
  .tool-cmp-row { grid-template-columns: 1fr auto 1fr; }
  .tool-cmp-name { max-width: 96px; }
}
`;
