/**
 * Session viewer (/view, exports, shares) — screen rules on the design
 * system. Reading order is the job order: who and what (header), how it
 * went (overview), what went wrong, when (timeline), the conversation
 * (chapters), then tools and files.
 */
export const SESSION_VIEWER_RULES = `
#app { max-width: 1040px; margin: 0 auto; padding: var(--space-8) var(--space-8) 140px; }

/* ---- header ---- */
.header { display: flex; flex-direction: column; gap: var(--space-3); padding-bottom: var(--space-6); }
.header-back {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; margin-bottom: var(--space-1);
  font-size: var(--text-sm); color: var(--text-3); transition: color var(--dur-2) var(--ease-out);
}
.header-back:hover { color: var(--text); }
.header-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); min-width: 0; }
.header-title { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 14px; min-width: 0; font-size: var(--text-xs); color: var(--text-3); }
.header-id { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.header-agent { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); font-size: var(--text-xs); }
.header-agent::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--hue-other)); }
.header-project { color: var(--text-2); }
.header-branch { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.header-branch::before { content: "⎇ "; color: var(--text-4); }
.header-prompt {
  font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: var(--weight-regular); letter-spacing: var(--track-display);
  color: var(--text); max-width: 880px; overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
}
.header-prompt.is-empty { color: var(--text-3); }
.header-actions { display: flex; align-items: center; gap: 2px; flex-shrink: 0; }
.export-btn, .md-btn, .print-btn, .hf-btn {
  display: inline-flex; align-items: center; gap: 6px; height: var(--control-md); padding: 0 11px;
  border-radius: var(--radius-pill); font-size: var(--text-sm); color: var(--text-2); background: transparent; border: 0; cursor: pointer;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.export-btn:hover, .md-btn:hover, .print-btn:hover, .hf-btn:hover { background: var(--hover); color: var(--text); }
.export-btn svg, .print-btn svg, .md-btn svg, .hf-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.hf-btn { background: var(--surface-3); color: var(--text); }
.hf-btn:hover { background: var(--surface-4); }
.meta-grid { display: flex; flex-wrap: wrap; gap: 6px 22px; font-size: var(--text-xs); }
.meta-item { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; }
.meta-label { color: var(--text-3); }
.meta-value { color: var(--text-2); font-size: var(--text-xs); overflow-wrap: anywhere; }
.meta-item:nth-child(2) .meta-value { font-family: var(--font-mono); font-size: 11.5px; }

/* ---- overview: grade + headline numbers ---- */
.sv-overview { display: flex; flex-direction: column; gap: 0; border-radius: var(--radius-lg); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1); overflow: hidden; }
.sv-overview > div:empty { display: none; }
.session-summary { display: flex; align-items: center; flex-wrap: wrap; gap: var(--space-4) var(--space-6); padding: var(--space-5) var(--space-5); }
.session-summary-sep { display: none; }
.session-summary-item { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.session-summary-item .ss-label { font-size: var(--text-xs); color: var(--text-3); }
.session-summary-item .ss-value { font-size: var(--text-lg); color: var(--text); letter-spacing: var(--track-tight); font-variant-numeric: tabular-nums; }
.session-summary-item.ss-cost .ss-value { color: var(--text); }
/* the stats strip below already carries tokens and errors */
.sv-overview .session-summary-item.ss-tokens, .sv-overview .session-summary-item.ss-errors { display: none; }
.session-summary-item.ss-errors .ss-value { color: var(--text); }
.session-summary-item.ss-commits .ss-value { color: var(--text); }
.session-summary-item.ss-duration .ss-value { color: var(--text); }
.session-summary-item.ss-quality-mixed .ss-value { color: var(--text); }
.session-summary-item.ss-waste .ss-value { color: var(--text-2); font-size: var(--text-sm); }
.session-grade { display: flex; align-items: center; gap: var(--space-4); padding-right: var(--space-6); margin-right: var(--space-1); box-shadow: inset -1px 0 0 var(--line-2); }
.session-grade-letter {
  width: 52px; height: 52px; border-radius: var(--radius-lg); display: grid; place-items: center;
  font-size: 28px; line-height: 1; letter-spacing: -0.02em; color: var(--text); background: var(--surface-3);
}
.session-grade-letter[class*="grade-"] { background: var(--surface-3) !important; }
.session-grade-letter.grade-a { color: var(--ok); background: var(--ok-soft); }
.session-grade-letter.grade-b { color: var(--ok); background: color-mix(in srgb, var(--ok) 10%, transparent); }
.session-grade-letter.grade-c { color: var(--text); background: var(--warn-soft); }
.session-grade-letter.grade-d { color: var(--bad); background: color-mix(in srgb, var(--bad) 12%, transparent); }
.session-grade-letter.grade-f { color: var(--bad); background: var(--bad-soft); }
.session-grade-detail { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.session-grade-score { font-size: var(--text-sm); color: var(--text); font-variant-numeric: tabular-nums; }
.session-grade-breakdown { display: none; }
.session-grade-factor { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-3); }
.session-grade-factor-bar { position: relative; display: inline-block; width: 36px; height: 3px; border-radius: 999px; background: var(--surface-4); overflow: hidden; }
.session-grade-factor-fill { position: absolute; inset: 0 auto 0 0; border-radius: inherit; }
.session-grade-factor-fill.fill-good { background: var(--ok); }
.session-grade-factor-fill.fill-ok { background: var(--warn); }
.session-grade-factor-fill.fill-bad { background: var(--bad); }
.session-grade-note { font-size: var(--text-xs); color: var(--text-3); }
.stats-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 1px; background: var(--line-1); box-shadow: inset 0 1px 0 var(--line-1); }
.stat { background: var(--surface-1); padding: var(--space-3) var(--space-5); display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.stat-value { font-size: var(--text-lg); color: var(--text); letter-spacing: var(--track-tight); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-value.red { color: var(--bad); }
.stat-value.green { color: var(--text); }
.stat-label { font-size: var(--text-xs); color: var(--text-3); }
.stats-note { grid-column: 1 / -1; background: var(--surface-1); padding: 8px var(--space-5); font-size: var(--text-xs); color: var(--text-3); }

/* ---- sections ---- */
.sv-section { margin-top: var(--space-16); display: flex; flex-direction: column; gap: var(--space-4); }
.sv-section-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; padding: 0 2px; }
.sv-section-title { font-size: var(--text-xl); line-height: var(--lh-xl); font-weight: var(--weight-regular); letter-spacing: var(--track-tight); color: var(--text); }
.sv-section-sub { font-size: var(--text-xs); color: var(--text-3); }
.sv-section > div:empty { display: none; }
.sv-panel, .activity-timeline, .waveform-wrap, .cost-chart, .tool-flow, .tool-perf, .file-hotspot, .git-timeline, .error-summary {
  position: relative; background: var(--surface-1); border-radius: var(--radius-lg); box-shadow: inset 0 0 0 1px var(--line-1);
  padding: var(--space-4) var(--space-5);
}

/* ---- what went wrong ---- */
.error-summary { display: flex; flex-direction: column; gap: var(--space-3); }
.error-summary-header { display: flex; align-items: baseline; gap: 10px; }
.sv-errors .error-summary-title { display: none; }
.sv-errors .error-summary-count { font-size: var(--text-sm); color: var(--text-2); }
.error-summary-title { font-size: var(--text-sm); color: var(--bad); text-transform: capitalize; }
.error-summary-count { font-size: var(--text-xs); color: var(--text-3); }
.error-summary-body { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; }
.error-tools-list, .error-streaks { display: flex; flex-wrap: wrap; gap: 6px; }
.error-tool-chip { display: inline-flex; align-items: center; height: 22px; padding: 0 9px; border-radius: var(--radius-pill); font-size: var(--text-xs); color: var(--bad); background: var(--bad-soft); }
.error-streak-badge { height: 22px; padding: 0 9px; border-radius: var(--radius-pill); font-size: var(--text-xs); color: var(--warn); background: var(--warn-soft); cursor: pointer; }
.error-streak-badge:hover { color: var(--text); }
.error-list { flex-basis: 100%; list-style: none; display: flex; flex-direction: column; margin: 0 -10px; }
.error-list-item {
  display: grid; grid-template-columns: 40px 72px minmax(0, 1fr) auto; gap: 12px; align-items: baseline; width: 100%;
  padding: 9px 10px; border-radius: var(--radius-md); text-align: left; cursor: pointer; color: var(--text-2);
  transition: background var(--dur-1) var(--ease-out);
}
.error-list-item:hover, .error-list-item:focus-visible { background: var(--hover); outline: none; }
.error-list li + li .error-list-item { box-shadow: inset 0 1px 0 var(--line-1); }
.error-list-count { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--bad); text-align: right; }
.error-list-tool { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error-list-text { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.error-list-text code { font-family: var(--font-mono); font-size: 12.5px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error-list-out { font-size: var(--text-xs); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.error-list-ch { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-3); white-space: nowrap; }
.error-list-more { flex-basis: 100%; font-size: var(--text-xs); color: var(--text-3); }
.error-timeline { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; padding-top: 2px; }
.sv-errors .error-timeline { display: none; }
.error-dot { width: 8px; height: 8px; border-radius: 50%; border: 0; padding: 0; cursor: pointer; background: var(--surface-4); transition: transform var(--dur-1) var(--ease-out); }
.error-dot:hover { transform: scale(1.3); }
.error-dot.has-error { background: var(--bad); }
.error-dot.no-error { background: var(--surface-4); }
.error-dot.streak { background: var(--warn); }
.error-dot:focus-visible, .error-streak-badge:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.chapter.error-streak-hl { box-shadow: inset 2px 0 0 var(--warn); }

/* ---- timeline charts ---- */
.activity-timeline-label, .waveform-label { font-size: var(--text-xs); color: var(--text-3); margin-bottom: var(--space-3); }
.activity-timeline-canvas, .waveform-canvas, .cost-chart-canvas { display: block; width: 100%; border-radius: var(--radius-sm); cursor: crosshair; }
.activity-timeline-canvas:focus-visible, .waveform-canvas:focus-visible, .cost-chart-canvas:focus-visible { outline: 2px solid var(--focus); outline-offset: 3px; }
.activity-timeline-times, .waveform-axis, .cost-chart-axis { display: flex; justify-content: space-between; margin-top: 6px; font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); }
.activity-timeline-legend, .waveform-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: var(--space-3); font-size: var(--text-xs); color: var(--text-3); }
.activity-timeline-legend-item, .legend-item { display: inline-flex; align-items: center; gap: 6px; }
.activity-timeline-legend-dot, .legend-dot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.activity-timeline-tooltip, .waveform-tooltip, .cost-chart-tooltip {
  display: none; position: absolute; z-index: var(--z-popover); pointer-events: none; max-width: 320px;
  padding: 8px 10px; border-radius: var(--radius-md); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  font-size: var(--text-xs); color: var(--text-2); line-height: var(--lh-xs); white-space: pre-line;
}
.waveform-wrap { overflow: visible; }
.waveform-cursor { display: none; position: absolute; top: 0; bottom: 0; width: 1px; background: var(--line-3); pointer-events: none; }
.cost-chart-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: var(--space-3); font-size: var(--text-xs); color: var(--text-3); }
.cost-chart-total { color: var(--text); font-size: var(--text-sm); font-variant-numeric: tabular-nums; }

/* ---- chapters: filter bar ---- */
.filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: var(--space-2); }
.filter-tools { display: flex; flex-wrap: wrap; gap: 4px; }
.filter-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text-2); background: var(--surface-2); cursor: pointer;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.filter-chip:hover { background: var(--surface-3); color: var(--text); }
.filter-chip.active { background: var(--ink); color: var(--paper); }
.filter-chip:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.filter-search {
  flex: 1; min-width: 200px; height: var(--control-md); padding: 0 14px; border-radius: var(--radius-pill); border: 0; outline: none;
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2); color: var(--text); font-size: var(--text-sm);
  transition: box-shadow var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.filter-search::placeholder { color: var(--text-3); }
.filter-search:focus { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--focus); }
.filter-count { font-size: var(--text-xs); color: var(--text-3); margin-left: auto; font-variant-numeric: tabular-nums; }

/* ---- chapters: rows ---- */
.chapters { display: flex; flex-direction: column; }
.chapter {
  position: relative; border-radius: var(--radius-md); box-shadow: inset 0 -1px 0 var(--line-1);
  transition: background var(--dur-1) var(--ease-out);
}
.chapter:hover { background: var(--hover); }
.chapter.expanded { background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1); margin: 6px 0; }
.chapter.filter-hidden { display: none; }
.chapter.kb-focused { box-shadow: inset 2px 0 0 var(--text); }
.chapter.kb-focused.expanded { box-shadow: inset 2px 0 0 var(--text), inset 0 0 0 1px var(--line-1); }
.chapter.highlight { animation: ch-flash 1.4s var(--ease-out); }
@keyframes ch-flash { 0% { background: var(--accent-soft); } 100% { background: transparent; } }
.chapter.wf-hover { background: var(--hover); }
.chapter-head { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: var(--space-3); align-items: start; padding: 14px 14px 14px 6px; cursor: pointer; }
.chapter-num {
  position: relative; justify-self: center; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
  min-width: 26px; height: 22px; padding: 0 6px; border-radius: var(--radius-pill);
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3); background: var(--surface-2);
}
.chapter-outcome-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-4); }
.chapter-outcome-dot.dot-clean { background: var(--ok); }
.chapter-outcome-dot.dot-corrected { background: var(--warn); }
.chapter-outcome-dot.dot-struggling { background: var(--bad); }
.chapter-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.chapter-prompt { min-width: 0; }
.chapter-prompt-text {
  font-size: var(--text-md); line-height: var(--lh-md); color: var(--text); overflow-wrap: anywhere;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.chapter.expanded .chapter-prompt-text { -webkit-line-clamp: unset; display: block; white-space: pre-wrap; }
.chapter-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: var(--text-xs); color: var(--text-3); }
.chapter-tools { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.ch-tool {
  display: inline-flex; align-items: center; gap: 5px; height: 20px; padding: 0 7px; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-2); background: var(--surface-2); font-variant-numeric: tabular-nums;
}
.ch-tool::before { content: ""; width: 6px; height: 6px; border-radius: 2px; background: var(--hue-other); }
.ch-tool.Bash::before { background: var(--hue-bash); }
.ch-tool.Read::before { background: var(--hue-read); }
.ch-tool.Edit::before, .ch-tool.Write::before { background: var(--hue-edit); }
.ch-tool.Agent::before { background: var(--hue-agent); }
.chapter-outcome { font-size: var(--text-xs); color: var(--text-3); }
.chapter-outcome.clean { color: var(--ok); }
.chapter-outcome.error { color: var(--bad); }
.chapter-outcome.corrected { color: var(--warn); }
.chapter-patterns { display: inline-flex; gap: 4px; }
.chapter-pattern-badge, .chapter-waste-badge, .chapter-git-badge, .chapter-mcp-badge, .chapter-dep-badge {
  display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 7px; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-2); background: var(--surface-2); white-space: nowrap;
}
.chapter-pattern-badge.retry { color: var(--warn); background: var(--warn-soft); }
.chapter-pattern-badge.correction { color: var(--info); background: var(--info-soft); }
.chapter-waste-badge { color: var(--warn); background: var(--warn-soft); }
.chapter-git-badge { color: var(--ok); background: var(--ok-soft); }
.chapter-dep-badge { cursor: pointer; border: 0; }
.chapter-dep-badge:hover { color: var(--text); background: var(--surface-3); }
.chapter-dep-badge.dep-fix { color: var(--warn); background: var(--warn-soft); }
.chapter-dep-badge.dep-fix:hover { color: var(--text); }
.chapter-dep-connector { position: absolute; left: 25px; width: 1px; background: var(--line-3); pointer-events: none; }
.chapter-right { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; min-width: 120px; font-size: var(--text-xs); color: var(--text-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
.chapter-time { font-family: var(--font-mono); font-size: 11px; }
.chapter-turns, .chapter-tokens { color: var(--text-3); }
.chapter-thinking-badge { color: var(--info); }
.chapter-permalink {
  opacity: 0; height: 20px; padding: 0 6px; border-radius: var(--radius-sm); font-size: 11px; color: var(--text-3); background: none; border: 0; cursor: pointer;
  transition: opacity var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.chapter:hover .chapter-permalink, .chapter.expanded .chapter-permalink, .chapter-permalink:focus-visible { opacity: 1; }
.chapter-permalink:hover { color: var(--text); }
.chapter-permalink.copied { color: var(--ok); opacity: 1; }

/* ---- chapters: detail ---- */
.chapter-detail { display: none; padding: 2px 18px 18px 58px; flex-direction: column; gap: var(--space-4); }
.chapter.expanded .chapter-detail { display: flex; }
.chapter-detail > * { min-width: 0; }
.chapter-files-label, .chapter-web-label, .chapter-mcp-label, .chapter-dep-section-title, .chapter-efficiency-label, .chapter-thinking-header, .chapter-quality-label {
  font-size: var(--text-xs); color: var(--text-3); margin-bottom: 6px; display: flex; align-items: center; gap: 6px;
}
.chapter-web-label::before, .chapter-mcp-label::before { content: none; }
.chapter-quality { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; font-size: var(--text-xs); color: var(--text-3); }
.chapter-quality-label { margin: 0; }
.chapter-quality-label.clean { color: var(--ok); }
.chapter-quality-label.corrected { color: var(--warn); }
.chapter-quality-label.struggling { color: var(--bad); }
.chapter-quality-retries, .chapter-quality-corrections { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.chapter-retry-chip { height: 20px; padding: 0 7px; border-radius: var(--radius-pill); font-family: var(--font-mono); font-size: 11px; color: var(--warn); background: var(--warn-soft); display: inline-flex; align-items: center; }
.chapter-efficiency { display: flex; flex-direction: column; gap: 8px; }
.chapter-efficiency-header { display: flex; align-items: center; gap: 10px; }
.chapter-efficiency-score { font-size: var(--text-xs); color: var(--text-2); font-variant-numeric: tabular-nums; }
.chapter-efficiency-bar-wrap { flex: 1; max-width: 200px; height: 4px; border-radius: 999px; background: var(--surface-4); overflow: hidden; }
.chapter-efficiency-bar { height: 100%; border-radius: inherit; }
.chapter-efficiency-bar.eff-good { background: var(--ok); }
.chapter-efficiency-bar.eff-ok { background: var(--warn); }
.chapter-efficiency-bar.eff-bad { background: var(--bad); }
.chapter-efficiency-metrics { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: var(--text-xs); color: var(--text-3); }
.chapter-efficiency-metric { display: inline-flex; gap: 5px; }
.chapter-efficiency-metric-value { color: var(--text-2); font-variant-numeric: tabular-nums; }
.chapter-efficiency-metric-value.val-good { color: var(--ok); }
.chapter-efficiency-metric-value.val-bad { color: var(--bad); }
.chapter-efficiency-reasons { display: flex; flex-direction: column; gap: 2px; }
.chapter-efficiency-reason { font-size: var(--text-xs); color: var(--warn); }
.chapter-files { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.chapter-files > .chapter-output { max-height: 36px; padding: 0 0 4px 12px; font-size: 11px; }
.chapter-file {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: var(--radius-sm);
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); background: var(--surface-2); max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.chapter-file-ops { color: var(--text-3); font-size: 10.5px; }
.chapter-response {
  font-size: var(--text-sm); line-height: 1.65; color: var(--text-2); white-space: pre-wrap; overflow-wrap: anywhere;
  padding: var(--space-3) var(--space-4); border-radius: var(--radius-md); background: var(--bg); box-shadow: inset 0 0 0 1px var(--line-1);
}
.chapter-commands { display: flex; flex-direction: column; gap: 6px; }
.chapter-cmd {
  display: flex; align-items: baseline; gap: 10px; font-family: var(--font-mono); font-size: 12px; color: var(--text);
  overflow-wrap: anywhere; padding: 8px 12px; border-radius: var(--radius-md); background: var(--bg); box-shadow: inset 0 0 0 1px var(--line-1);
}
.chapter-cmd::before { content: "$"; color: var(--text-4); flex: none; }
.chapter-cmd-status { flex: none; margin-left: auto; font-size: 11px; font-family: var(--font-sans); }
.chapter-cmd-status.ok { color: var(--ok); }
.chapter-cmd-status.fail { color: var(--bad); }
.chapter-output {
  font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; color: var(--text-3); white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 96px; overflow: hidden; padding: 0 12px 0 22px;
}
.expand-toggle {
  align-self: flex-start; height: 22px; padding: 0 8px; margin-left: 22px; border-radius: var(--radius-pill);
  font-size: 11px; color: var(--text-3); background: var(--surface-2); border: 0; cursor: pointer;
}
.expand-toggle:hover { color: var(--text); background: var(--surface-3); }
.expand-toggle:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.expand-toggle.in-diff { margin-left: 0; margin-top: 4px; }
.chapter-search-count { font-size: var(--text-xs); color: var(--text-3); }
.chapter-thinking { display: flex; flex-direction: column; gap: 6px; }
.chapter-thinking-icon { color: var(--info); }
.chapter-thinking-count { color: var(--text-3); }
.chapter-thinking-block {
  font-size: var(--text-xs); line-height: 1.6; color: var(--text-3); font-style: italic; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 72px; overflow: hidden; padding-left: 12px; box-shadow: inset 2px 0 0 var(--info-soft);
}
.chapter-thinking-block.expanded { max-height: none; }
.chapter-thinking-more { font-size: 11px; color: var(--text-3); cursor: pointer; background: none; border: 0; align-self: flex-start; }
.chapter-thinking-more:hover { color: var(--text); }
.chapter-token-detail { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--text-xs); color: var(--text-3); font-variant-numeric: tabular-nums; }
.chapter-token-breakdown { display: inline-flex; gap: 10px; }
.chapter-token-cost { color: var(--text-2); }
.chapter-web, .chapter-agents, .chapter-mcp, .chapter-diffs, .chapter-git-ops { display: flex; flex-direction: column; gap: 6px; }
.chapter-web-op, .chapter-agent, .chapter-mcp-op {
  display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: var(--radius-md);
  background: var(--bg); box-shadow: inset 0 0 0 1px var(--line-1); font-size: var(--text-xs); color: var(--text-2); min-width: 0;
}
.chapter-web-op.error, .chapter-mcp-op.mcp-error { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--bad) 35%, transparent); }
.chapter-web-type { display: inline-flex; align-self: flex-start; height: 18px; padding: 0 7px; border-radius: var(--radius-pill); font-size: 10.5px; color: var(--text-2); background: var(--surface-2); align-items: center; }
.chapter-web-type.fetch { color: var(--hue-web); }
.chapter-web-type.search { color: var(--hue-read); }
.chapter-web-url, .chapter-web-result-url { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2); overflow-wrap: anywhere; text-decoration: none; }
.chapter-web-url:hover, .chapter-web-result-url:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.chapter-web-query, .chapter-web-title, .chapter-web-result-title { color: var(--text); font-size: var(--text-sm); }
.chapter-web-prompt { color: var(--text-3); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.chapter-web-preview { color: var(--text-3); max-height: 48px; overflow: hidden; white-space: pre-wrap; }
.chapter-web-results { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
.chapter-web-result { display: flex; flex-direction: column; gap: 1px; }
.chapter-web-count { color: var(--text-3); }
.chapter-agent-status { font-size: 11px; }
.chapter-agent-status.ok { color: var(--ok); }
.chapter-agent-status.fail { color: var(--bad); }
.chapter-agent-status.pending { color: var(--warn); }
.chapter-agent-desc { color: var(--text); font-size: var(--text-sm); }
.chapter-agent-type { color: var(--text-3); font-family: var(--font-mono); font-size: 11px; }
.chapter-agent-prompt { color: var(--text-3); max-height: 60px; overflow: hidden; white-space: pre-wrap; }
.chapter-mcp-header { display: flex; align-items: center; gap: 8px; }
.chapter-mcp-server { color: var(--text-3); }
.chapter-mcp-tool { color: var(--text); font-family: var(--font-mono); font-size: 11.5px; }
.chapter-mcp-status { margin-left: auto; font-size: 11px; }
.chapter-mcp-status.ok { color: var(--ok); }
.chapter-mcp-status.fail { color: var(--bad); }
.chapter-mcp-params { display: flex; flex-wrap: wrap; gap: 2px 12px; font-family: var(--font-mono); font-size: 11px; }
.chapter-mcp-param-key { color: var(--text-3); }
.chapter-mcp-param-val { color: var(--text-2); overflow-wrap: anywhere; }
.chapter-mcp-output { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); max-height: 48px; overflow: hidden; white-space: pre-wrap; }
.chapter-diff-header { display: flex; align-items: center; gap: 8px; font-size: var(--text-xs); }
.chapter-diff-path { font-family: var(--font-mono); font-size: 11.5px; color: var(--text); overflow-wrap: anywhere; }
.chapter-diff-op { font-size: 10.5px; color: var(--text-3); }
.chapter-diff-block { border-radius: var(--radius-md); overflow: hidden; box-shadow: inset 0 0 0 1px var(--line-1); background: var(--bg); }
.chapter-diff-del, .chapter-diff-add {
  font-family: var(--font-mono); font-size: 11.5px; line-height: 1.6; padding: 6px 12px; white-space: pre-wrap; overflow-wrap: anywhere;
  max-height: 60px; overflow: hidden;
}
.chapter-diff-del { color: var(--bad); background: color-mix(in srgb, var(--bad) 7%, transparent); }
.chapter-diff-add { color: var(--ok); background: color-mix(in srgb, var(--ok) 7%, transparent); }
.chapter-git-op { display: flex; align-items: center; gap: 8px; font-size: var(--text-xs); color: var(--text-2); }
.chapter-git-op-icon { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; background: var(--surface-2); color: var(--text-3); }
.chapter-git-op-icon.commit { color: var(--ok); background: var(--ok-soft); }
.chapter-git-op-icon.branch { color: var(--info); background: var(--info-soft); }
.chapter-git-op-icon.push { color: var(--accent-text); background: var(--accent-soft); }
.chapter-git-op-icon.merge { color: var(--hue-grok); background: var(--surface-2); }
.chapter-dep-section { display: flex; flex-direction: column; gap: 4px; }
.chapter-dep-link { align-self: flex-start; font-size: var(--text-xs); color: var(--text-2); background: none; border: 0; cursor: pointer; padding: 0; text-align: left; }
.chapter-dep-link:hover { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.chapter-dep-link:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.chapter-dep-shared-files { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }

/* ---- tools and files ---- */
.tool-flow-header, .tool-perf-header, .file-hotspot-header, .git-timeline-header {
  display: flex; align-items: center; gap: 10px; font-size: var(--text-sm); color: var(--text); margin-bottom: var(--space-3);
}
.tool-perf-header, .file-hotspot-header { margin-bottom: 0; cursor: pointer; border-radius: var(--radius-sm); }
.tool-perf.expanded .tool-perf-header, .file-hotspot.expanded .file-hotspot-header { margin-bottom: var(--space-3); }
.tool-perf-header:focus-visible, .file-hotspot-header:focus-visible { outline: 2px solid var(--focus); outline-offset: 4px; }
.tool-perf-title, .file-hotspot-title, .git-timeline-title { color: var(--text); }
.tool-perf-toggle, .file-hotspot-toggle { margin-left: auto; color: var(--text-3); font-size: 11px; transition: transform var(--dur-2) var(--ease-out); }
.tool-perf.expanded .tool-perf-toggle, .file-hotspot.expanded .file-hotspot-toggle { transform: rotate(90deg); }
.file-hotspot-count, .git-timeline-count { font-size: var(--text-xs); color: var(--text-3); }
.tool-flow-sequence { display: flex; flex-wrap: wrap; gap: 2px; }
.tool-flow-cell { width: 6px; height: 16px; border-radius: 2px; cursor: pointer; transition: transform var(--dur-1) var(--ease-out); }
.tool-flow-cell:hover { transform: scaleY(1.3); }
.tool-flow-divider { width: 1px; height: 16px; margin: 0 3px; background: var(--line-3); }
.tool-flow-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px; margin-top: var(--space-4); }
.tool-flow-stat { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: var(--radius-md); background: var(--bg); box-shadow: inset 0 0 0 1px var(--line-1); font-size: var(--text-xs); }
.tool-flow-stat-dot { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.tool-flow-stat-name { color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-flow-stat-count { margin-left: auto; color: var(--text); font-variant-numeric: tabular-nums; }
.tool-flow-stat-avg { color: var(--text-3); font-size: 11px; font-variant-numeric: tabular-nums; }
.tool-flow-transitions { margin-top: var(--space-4); display: flex; flex-direction: column; gap: 8px; }
.tool-flow-transitions-label { font-size: var(--text-xs); color: var(--text-3); }
.tool-flow-transition-list { display: flex; flex-wrap: wrap; gap: 6px; }
.tool-flow-transition { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 9px; border-radius: var(--radius-pill); font-size: 11px; background: var(--surface-2); }
.tool-flow-transition-arrow { color: var(--text-4); }
.tool-flow-transition-count { color: var(--text-3); font-variant-numeric: tabular-nums; }
.tool-perf-body, .file-hotspot-body { display: none; }
.tool-perf.expanded .tool-perf-body, .file-hotspot.expanded .file-hotspot-body { display: block; }
.tool-perf-sort { display: flex; gap: 4px; margin-bottom: var(--space-3); }
.tool-perf-sort-btn { height: 24px; padding: 0 10px; border-radius: var(--radius-pill); font-size: 11px; color: var(--text-3); background: none; border: 0; cursor: pointer; }
.tool-perf-sort-btn:hover { color: var(--text); background: var(--hover); }
.tool-perf-sort-btn.active { color: var(--text); background: var(--surface-3); }
.tool-perf-table { display: flex; flex-direction: column; }
.tool-perf-row {
  display: grid; grid-template-columns: 10px minmax(100px, 1fr) 56px minmax(80px, 2fr) 52px 52px; gap: 12px; align-items: center;
  padding: 7px 8px; border-radius: var(--radius-sm); font-size: var(--text-xs); cursor: pointer; font-variant-numeric: tabular-nums;
}
.tool-perf-row:hover { background: var(--hover); }
.tool-perf-row.active { background: var(--surface-3); }
.tool-perf-row:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.tool-perf-dot { width: 7px; height: 7px; border-radius: 2px; }
.tool-perf-name { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tool-perf-calls { color: var(--text-3); text-align: right; }
.tool-perf-bar-wrap { display: flex; height: 4px; border-radius: 999px; overflow: hidden; background: var(--surface-4); }
.tool-perf-bar-ok { background: var(--ok); }
.tool-perf-bar-err { background: var(--bad); }
.tool-perf-rate { text-align: right; color: var(--text-2); }
.tool-perf-rate.perfect, .tool-perf-rate.good { color: var(--ok); }
.tool-perf-rate.warn { color: var(--warn); }
.tool-perf-rate.bad { color: var(--bad); }
.tool-perf-errs { text-align: right; color: var(--text-4); }
.tool-perf-errs.has-errors { color: var(--bad); }
.tool-perf-retries { display: none; }
.file-hotspot-bar { display: flex; height: 6px; border-radius: 999px; overflow: hidden; gap: 1px; margin-bottom: var(--space-3); background: var(--surface-3); }
.file-hotspot-bar-seg { height: 100%; }
.file-hotspot-list { display: flex; flex-direction: column; max-height: 360px; overflow-y: auto; }
.file-hotspot-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--radius-sm); cursor: pointer; font-size: var(--text-xs); }
.file-hotspot-item:hover { background: var(--hover); }
.file-hotspot-item.active { background: var(--surface-3); }
.file-hotspot-item:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.file-hotspot-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; }
.file-hotspot-path { font-family: var(--font-mono); font-size: 11.5px; color: var(--text); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.file-hotspot-ops { display: inline-flex; gap: 4px; }
.file-hotspot-op { font-size: 10.5px; color: var(--text-3); }
.file-hotspot-op.read { color: var(--hue-read); }
.file-hotspot-op.edit { color: var(--hue-edit); }
.file-hotspot-op.write { color: var(--hue-bash); }
.file-hotspot-touch { color: var(--text-3); font-variant-numeric: tabular-nums; }
.file-hotspot-chapters { color: var(--text-4); font-size: 11px; }
.git-timeline-ops { display: flex; flex-direction: column; }
.git-op { display: flex; align-items: center; gap: 10px; padding: 6px 4px; font-size: var(--text-xs); box-shadow: inset 0 -1px 0 var(--line-1); }
.git-op:last-child { box-shadow: none; }
.git-op-icon { width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; flex: none; background: var(--surface-2); color: var(--text-3); }
.git-op-icon.commit { color: var(--ok); background: var(--ok-soft); }
.git-op-icon.branch { color: var(--info); background: var(--info-soft); }
.git-op-icon.push { color: var(--accent-text); background: var(--accent-soft); }
.git-op-icon.merge, .git-op-icon.other { color: var(--text-2); }
.git-op-detail { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1; }
.git-op-hash { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.git-op-msg { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.git-op-branch-name { font-family: var(--font-mono); font-size: 11px; color: var(--text-2); }
.git-op-chapter { margin-left: auto; height: 20px; padding: 0 8px; border-radius: var(--radius-pill); font-size: 11px; color: var(--text-3); background: var(--surface-2); border: 0; cursor: pointer; }
.git-op-chapter:hover { color: var(--text); }
.git-op-chapter:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

/* ---- chapter tooltip + minimap ---- */
.chapter-tooltip {
  display: none; opacity: 0; position: fixed; z-index: var(--z-popover); pointer-events: none; width: 320px;
  padding: 12px 14px; border-radius: var(--radius-lg); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  font-size: var(--text-xs); color: var(--text-2); transition: opacity var(--dur-2) var(--ease-out);
}
.chapter-tooltip.visible { display: block; opacity: 1; }
.chapter-tooltip-prompt { color: var(--text); font-size: var(--text-sm); margin-bottom: 8px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.chapter-tooltip-tools { display: flex; gap: 2px; margin-bottom: 8px; }
.chapter-tooltip-tool { width: 14px; height: 4px; border-radius: 999px; }
.chapter-tooltip-row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; box-shadow: inset 0 -1px 0 var(--line-1); }
.chapter-tooltip-row:last-child { box-shadow: none; }
.chapter-tooltip-label { color: var(--text-3); }
.chapter-tooltip-value { color: var(--text); font-variant-numeric: tabular-nums; text-align: right; }
.chapter-tooltip-value.errors, .chapter-tooltip-value.struggling { color: var(--bad); }
.chapter-tooltip-value.clean { color: var(--ok); }
.chapter-tooltip-value.corrected { color: var(--warn); }
.chapter-tooltip-files { display: flex; flex-direction: column; gap: 1px; margin-top: 6px; }
.chapter-tooltip-file { font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.minimap {
  position: fixed; right: 14px; top: 50%; transform: translateY(-50%); z-index: var(--z-rail); width: 10px; max-height: 80vh;
  display: flex; flex-direction: column; gap: 2px; padding: 4px 2px; border-radius: var(--radius-pill);
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1); opacity: 0.7; transition: opacity var(--dur-2) var(--ease-out), width var(--dur-2) var(--ease-out);
}
.minimap:hover { opacity: 1; width: 14px; }
.minimap-block { position: relative; flex: 1; min-height: 3px; border-radius: 2px; background: var(--surface-4); cursor: pointer; border: 0; padding: 0; }
.minimap-block:hover { background: var(--text-3); }
.minimap-block:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.minimap-block.mm-clean { background: color-mix(in srgb, var(--ok) 55%, transparent); }
.minimap-block.mm-corrected { background: color-mix(in srgb, var(--warn) 60%, transparent); }
.minimap-block.mm-struggling { background: color-mix(in srgb, var(--bad) 65%, transparent); }
.minimap-block.mm-visible { box-shadow: 0 0 0 1px var(--text-2); }
.minimap-marker { position: absolute; right: -4px; width: 4px; height: 4px; border-radius: 50%; }
.minimap-marker.mm-error { background: var(--bad); }
.minimap-marker.mm-commit { background: var(--ok); }
.minimap-tooltip {
  display: none; opacity: 0; position: fixed; z-index: var(--z-popover); pointer-events: none; max-width: 280px;
  padding: 6px 10px; border-radius: var(--radius-md); background: var(--ink); color: var(--paper); font-size: var(--text-xs);
}
.minimap-tooltip.visible { display: block; opacity: 1; }
.minimap-viewport { position: absolute; left: -2px; right: -2px; border-radius: 3px; box-shadow: 0 0 0 1px var(--text-2); pointer-events: none; }

/* ---- share dialog ---- */
.hf-modal-overlay {
  position: fixed; inset: 0; z-index: var(--z-dialog); display: flex; align-items: flex-start; justify-content: center; padding: 14vh 16px 16px;
  background: var(--scrim); backdrop-filter: blur(3px); animation: ui-fade-in var(--dur-2) var(--ease-out);
}
.hf-modal {
  width: min(520px, 100%); display: flex; flex-direction: column; gap: var(--space-3); padding: 22px;
  border-radius: var(--radius-xl); background: var(--surface-pop); box-shadow: var(--shadow-pop); animation: ui-pop-in var(--dur-3) var(--ease-out);
}
.hf-modal-title { font-size: var(--text-xl); letter-spacing: var(--track-tight); margin-bottom: 4px; }
.hf-modal-label { font-size: var(--text-xs); color: var(--text-2); }
.hf-modal-input {
  width: 100%; height: var(--control-lg); padding: 0 12px; border-radius: var(--radius-md); border: 0; outline: none;
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2); color: var(--text); font-family: var(--font-mono); font-size: 12.5px;
}
.hf-modal-input:focus { box-shadow: inset 0 0 0 1px var(--focus); background: var(--surface-2); }
.hf-modal-hint { font-size: var(--text-xs); color: var(--text-3); line-height: var(--lh-xs); }
.hf-modal-status { font-size: var(--text-xs); color: var(--text-2); overflow-wrap: anywhere; }
.hf-modal-status.hf-error { color: var(--bad); }
.hf-modal-status.hf-success { color: var(--ok); }
.hf-modal-status a { color: var(--text); text-decoration: underline; text-underline-offset: 2px; }
.hf-modal-actions { display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2); }
.hf-modal-share, .hf-modal-cancel { height: var(--control-md); padding: 0 16px; border-radius: var(--radius-pill); font-size: var(--text-sm); border: 0; cursor: pointer; }
.hf-modal-cancel { color: var(--text-2); background: transparent; }
.hf-modal-cancel:hover { background: var(--hover); color: var(--text); }
.hf-modal-share { background: var(--ink); color: var(--paper); }
.hf-modal-share:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.hf-modal-share:disabled { opacity: 0.45; cursor: default; }

@media (max-width: 768px) {
  #app { padding: var(--space-5) var(--space-4) 120px; }
  .header-top { flex-direction: column; align-items: flex-start; }
  .header-prompt { font-size: var(--text-xl); line-height: var(--lh-xl); }
  .session-grade { box-shadow: none; padding-right: 0; }
  .chapter-head { grid-template-columns: 32px minmax(0, 1fr); }
  .chapter-right { display: none; }
  .chapter-detail { padding: 2px 12px 16px 12px; }
  .tool-perf-row { grid-template-columns: 10px minmax(80px, 1fr) 44px 52px; }
  .tool-perf-bar-wrap, .tool-perf-errs { display: none; }
  .minimap { display: none; }
  .error-list-item { grid-template-columns: 34px minmax(0, 1fr); }
  .error-list-tool, .error-list-ch { display: none; }
}

/* flyout embed: the Runs flyout already shows identity and actions */
body.embed-view #app { padding: var(--space-5) var(--space-5) 80px; max-width: none; }
body.embed-view .header { padding-bottom: var(--space-4); }
body.embed-view .header-prompt { font-size: var(--text-xl); line-height: var(--lh-xl); }
body.embed-view .minimap { display: none; }
body.embed-view .cmdk-trigger { display: none !important; }
`;
