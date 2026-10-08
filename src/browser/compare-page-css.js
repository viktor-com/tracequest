/** Compare standalone page layout (embed after STANDALONE_BASE_CSS). */
export const COMPARE_PAGE_CSS = `
.container { max-width: 860px; margin: 0 auto; padding: 40px 24px; }

.cmp-header {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 20px;
}
.cmp-title { font-size: 16px; font-weight: 600; }
.cmp-subtitle { font-size: 13px; color: var(--fg3); }
.cmp-back {
  font-size: 12px;
  color: var(--fg3);
  text-decoration: none;
  font-family: var(--mono);
  margin-left: auto;
  transition: color 0.12s;
}
.cmp-back:hover { color: var(--fg2); }

.cmp-sessions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  margin-bottom: 20px;
}
.cmp-session {
  background: var(--surface);
  border-radius: 10px;
  padding: 16px 20px;
  border-top: 3px solid var(--accent);
  min-width: 0;
  overflow: hidden;
}
.cmp-session.session-b { border-top-color: var(--orange); }
.cmp-session-label {
  font-size: 10px;
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 1px;
  color: var(--fg3);
  margin-bottom: 6px;
}
.cmp-session-id {
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 2px;
}
.cmp-session-model { font-size: 12px; color: var(--fg2); font-family: var(--mono); }
.cmp-session-prompt {
  font-size: 12px;
  color: var(--fg3);
  margin-top: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cmp-session-link {
  display: inline-block;
  margin-top: 8px;
  font-size: 11px;
  color: var(--accent);
  text-decoration: none;
  font-family: var(--mono);
}
.cmp-session-link:hover { text-decoration: underline; }

.cmp-section {
  background: var(--surface);
  border-radius: 10px;
  padding: 20px 24px;
  margin-bottom: 12px;
}
.cmp-error {
  background: var(--surface);
  border-radius: 10px;
  border-left: 3px solid var(--red);
  padding: 18px 20px;
  max-width: 560px;
}
.cmp-error-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 8px;
}
.cmp-error-status {
  font-size: 12px;
  color: var(--red);
  font-family: var(--mono);
  margin-bottom: 8px;
}
.cmp-error-handle {
  font-size: 12px;
  color: var(--fg2);
  font-family: var(--mono);
  overflow-wrap: anywhere;
  margin-bottom: 10px;
}
.cmp-error-message {
  font-size: 13px;
  color: var(--fg2);
  margin-bottom: 14px;
}
.cmp-error-link {
  font-size: 11px;
  color: var(--accent);
  text-decoration: none;
  font-family: var(--mono);
}
.cmp-error-link:hover { text-decoration: underline; }
.cmp-section-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--fg3);
  margin-bottom: 14px;
}

.cmp-table {
  width: 100%;
  border-collapse: collapse;
}
.cmp-table tr { border-bottom: 1px solid var(--border); }
.cmp-table tr:last-child { border-bottom: none; }
.cmp-table td { padding: 7px 0; vertical-align: middle; }
.cmp-label {
  text-align: center;
  font-size: 12px;
  color: var(--fg2);
  font-family: var(--mono);
  white-space: nowrap;
  padding: 7px 12px;
  width: 160px;
}
.cmp-val {
  font-family: var(--mono);
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  padding: 7px 8px;
}
.cmp-val:first-child { text-align: right; color: var(--fg); }
.cmp-val:last-child { text-align: left; color: var(--fg); }
.cmp-val.delta-good { color: var(--green); }
.cmp-val.delta-bad { color: var(--red); }

.cmp-col-headers {
  display: grid;
  grid-template-columns: 1fr 160px 1fr;
  margin-bottom: 6px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.cmp-col-a { text-align: right; padding-right: 8px; color: var(--accent); }
.cmp-col-label { text-align: center; }
.cmp-col-b { text-align: left; padding-left: 8px; color: var(--orange); }

/* Tool comparison */
.tool-cmp-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}
.tool-cmp-name {
  font-size: 12px;
  font-family: var(--mono);
  font-weight: 500;
  text-align: center;
  white-space: nowrap;
  min-width: 80px;
  max-width: 180px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-cmp-bar-wrap {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 18px;
}
.tool-cmp-left { flex-direction: row-reverse; }
.tool-cmp-bar {
  height: 14px;
  border-radius: 3px;
  min-width: 2px;
  opacity: 0.7;
  transition: opacity 0.12s;
}
.tool-cmp-row:hover .tool-cmp-bar { opacity: 1; }
.tool-cmp-count {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  font-variant-numeric: tabular-nums;
  min-width: 24px;
}
.tool-cmp-left .tool-cmp-count { text-align: right; }
.tool-cmp-right .tool-cmp-count { text-align: left; }

/* Outcome bars */
.cmp-outcome {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-top: 8px;
}
.cmp-outcome-side { }
.cmp-outcome-bar {
  display: flex;
  height: 20px;
  border-radius: 5px;
  overflow: hidden;
  margin-bottom: 6px;
}
.cmp-outcome-seg { transition: width 0.3s; }
.cmp-outcome-seg.clean { background: var(--green); opacity: 0.7; }
.cmp-outcome-seg.corrected { background: var(--orange); opacity: 0.7; }
.cmp-outcome-seg.struggling { background: var(--red); opacity: 0.7; }
.cmp-outcome-legend {
  display: flex;
  gap: 10px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
}
.cmp-outcome-legend-item { display: flex; align-items: center; gap: 4px; }
.cmp-outcome-dot {
  width: 8px; height: 8px; border-radius: 50%;
}
.cmp-outcome-dot.clean { background: var(--green); }
.cmp-outcome-dot.corrected { background: var(--orange); }
.cmp-outcome-dot.struggling { background: var(--red); }

.cmp-source-badge {
  display: inline-block;
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 1px 6px;
  border-radius: 4px;
  color: #111;
  margin-left: 6px;
}

@media (max-width: 600px) {
  .container { padding: 24px 12px; }
  .cmp-sessions { grid-template-columns: 1fr; }
  .cmp-label { width: 100px; font-size: 11px; padding: 5px 6px; }
  .cmp-val { font-size: 12px; }
  .cmp-col-headers { grid-template-columns: 1fr 100px 1fr; }
  .tool-cmp-row { grid-template-columns: 1fr auto 1fr; }
  .tool-cmp-name { max-width: 96px; }
  .cmp-outcome { grid-template-columns: 1fr; }
}
`;
