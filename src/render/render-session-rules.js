/** Session HTML viewer screen/layout rules (embedded by render-session-css.js). */
export const SESSION_VIEWER_RULES = `
#app { max-width: 960px; margin: 0 auto; padding: 40px 24px; }

.header {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 24px 28px;
  margin-bottom: 12px;
}
.header-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  letter-spacing: -0.2px;
  margin-bottom: 16px;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.header-title span {
  color: var(--fg3);
  font-weight: 400;
  font-size: 13px;
  font-family: var(--mono);
}
.header-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}
.header-top .header-title { margin-bottom: 0; min-width: 0; }
.export-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  font-size: 12px;
  font-family: var(--mono);
  padding: 5px 10px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.12s;
  white-space: nowrap;
  flex-shrink: 0;
}
.export-btn:hover {
  color: var(--fg);
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(139, 124, 246, 0.08);
}
.md-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  font-size: 12px;
  font-family: var(--mono);
  padding: 5px 10px;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.12s;
  white-space: nowrap;
  flex-shrink: 0;
}
.md-btn:hover {
  color: var(--fg);
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(139, 124, 246, 0.08);
}
.export-btn svg, .print-btn svg, .md-btn svg, .hf-btn svg {
  width: 12px;
  height: 12px;
  stroke: currentColor;
  fill: none;
  stroke-width: 2;
}
.print-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  font-size: 12px;
  font-family: var(--mono);
  padding: 5px 10px;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
  flex-shrink: 0;
}
.print-btn:hover {
  color: var(--fg);
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(139, 124, 246, 0.08);
}
.hf-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  font-size: 12px;
  font-family: var(--mono);
  padding: 5px 10px;
  cursor: pointer;
  transition: all 0.12s;
  white-space: nowrap;
  flex-shrink: 0;
}
.hf-btn:hover {
  color: var(--fg);
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(139, 124, 246, 0.08);
}
.hf-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.hf-modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: 400px;
  max-width: 90vw;
}
.hf-modal-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--fg);
  margin-bottom: 16px;
}
.hf-modal-label {
  display: block;
  font-size: 12px;
  color: var(--fg2);
  margin-bottom: 4px;
  margin-top: 12px;
}
.hf-modal-input {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  font-family: var(--mono);
  font-size: 13px;
  padding: 8px 10px;
}
.hf-modal-input:focus {
  outline: none;
  border-color: rgba(139, 124, 246, 0.5);
}
.hf-modal-hint {
  font-size: 11px;
  color: var(--fg3);
  margin-top: 4px;
}
.hf-modal-status {
  font-size: 12px;
  color: var(--fg2);
  margin-top: 12px;
  min-height: 18px;
  word-break: break-all;
}
.hf-modal-status.hf-error { color: var(--red, #f07070); }
.hf-modal-status.hf-success { color: var(--green, #59d4a0); }
.hf-modal-status a { color: inherit; text-decoration: underline; }
.hf-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 16px;
}
.hf-modal-share, .hf-modal-cancel {
  font-family: var(--mono);
  font-size: 12px;
  padding: 6px 16px;
  border-radius: 6px;
  cursor: pointer;
  border: 1px solid var(--border);
  transition: all 0.12s;
}
.hf-modal-cancel {
  background: var(--surface2);
  color: var(--fg2);
}
.hf-modal-share {
  background: rgba(139, 124, 246, 0.15);
  color: var(--fg);
  border-color: rgba(139, 124, 246, 0.3);
}
.hf-modal-share:hover { background: rgba(139, 124, 246, 0.25); }
.hf-modal-share:disabled { opacity: 0.5; cursor: default; }
.header-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.meta-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 20px;
}
.meta-item { display: flex; gap: 6px; align-items: baseline; }
.meta-label { color: var(--fg3); font-size: 12px; font-weight: 500; }
.meta-value {
  color: var(--fg2);
  font-size: 12px;
  font-family: var(--mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.stats-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0;
  margin-bottom: 12px;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 0;
}
.stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 12px;
  border-right: 1px solid var(--border);
}
.stat:last-child { border-right: none; }
.stats-note {
  width: 100%;
  text-align: center;
  font-size: 11px;
  color: var(--fg3);
  padding-top: 10px;
  border-top: 1px solid var(--border);
  margin-top: 10px;
}
.stat-value {
  font-size: 22px;
  font-weight: 600;
  color: var(--fg);
  letter-spacing: -0.5px;
  font-variant-numeric: tabular-nums;
}
.stat-value.red { color: var(--red); }
.stat-value.green { color: var(--green); }
.stat-label {
  font-size: 11px;
  color: var(--fg3);
  margin-top: 4px;
  letter-spacing: 0.3px;
}

.chapters { display: flex; flex-direction: column; gap: 2px; }

.chapter {
  background: var(--surface);
  border-radius: var(--radius);
  overflow: hidden;
  cursor: pointer;
  transition: background 0.15s;
}
.chapter:hover { background: var(--surface2); }
.chapter.expanded { background: var(--surface2); }

.chapter-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 20px;
}
.chapter-num {
  font-size: 12px;
  color: var(--fg3);
  min-width: 20px;
  padding-top: 2px;
  font-variant-numeric: tabular-nums;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.chapter-outcome-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}
.chapter-outcome-dot.dot-clean { background: var(--green); opacity: 0.6; }
.chapter-outcome-dot.dot-corrected { background: var(--orange); opacity: 0.8; }
.chapter-outcome-dot.dot-struggling { background: var(--red); opacity: 0.9; }
.chapter-body { flex: 1; min-width: 0; }

.chapter-prompt {
  font-size: 14px;
  color: var(--fg);
  line-height: 1.5;
  margin-bottom: 8px;
}
.chapter-prompt-text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chapter.expanded .chapter-prompt-text {
  display: block;
  -webkit-line-clamp: unset;
}

.chapter-meta {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.chapter-tools {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ch-tool {
  padding: 2px 7px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  font-family: var(--mono);
  background: rgba(255, 255, 255, 0.04);
  color: var(--fg2);
}

.chapter-outcome {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 5px;
}
.chapter-outcome.clean { background: var(--green-dim); color: var(--green); }
.chapter-outcome.error { background: var(--red-dim); color: var(--red); }
.chapter-outcome.corrected { background: var(--orange-dim); color: var(--orange); }

.chapter-patterns {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}
.chapter-pattern-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--mono);
}
.chapter-pattern-badge.retry {
  background: var(--red-dim);
  color: var(--red);
}
.chapter-pattern-badge.correction {
  background: var(--green-dim);
  color: var(--green);
}

.chapter-right {
  text-align: right;
  white-space: nowrap;
  flex-shrink: 0;
  padding-top: 2px;
}
.chapter-time {
  font-size: 12px;
  color: var(--fg3);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
}
.chapter-turns { font-size: 11px; color: var(--fg3); margin-top: 2px; }
.chapter-tokens {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}
.chapter-thinking-badge {
  font-size: 10px;
  color: var(--accent);
  font-family: var(--mono);
  opacity: 0.8;
  margin-top: 1px;
}
.chapter-token-detail { margin-bottom: 10px; }
.chapter-token-breakdown {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
  padding: 2px 0;
  font-variant-numeric: tabular-nums;
}
.chapter-token-cost {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--accent);
  margin-top: 2px;
}

.chapter-thinking {
  margin-bottom: 10px;
  border-left: 2px solid rgba(167, 139, 250, 0.3);
  padding-left: 10px;
}
.chapter-thinking-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.chapter-thinking-icon {
  font-size: 13px;
  line-height: 1;
}
.chapter-thinking-count {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--fg3);
  margin-left: auto;
  font-variant-numeric: tabular-nums;
}
.chapter-thinking-block {
  font-size: 11px;
  font-family: var(--mono);
  font-style: italic;
  color: var(--fg3);
  background: rgba(167, 139, 250, 0.04);
  border-radius: 4px;
  padding: 6px 8px;
  margin-bottom: 4px;
  max-height: 72px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.4;
  position: relative;
}
.chapter-thinking-block.expanded {
  max-height: none;
  overflow: visible;
}
.chapter-thinking-more {
  font-size: 10px;
  color: var(--fg3);
  font-style: italic;
  padding: 2px 0;
}

.chapter-permalink {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  color: var(--fg3);
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
  cursor: pointer;
  font-size: 12px;
  margin-top: 2px;
  appearance: none;
  border: 0;
  background: transparent;
  font-family: inherit;
  padding: 0;
}
.chapter:hover .chapter-permalink,
.chapter.expanded .chapter-permalink { opacity: 1; }
.chapter-permalink:hover,
.chapter-permalink:focus-visible {
  background: rgba(139, 124, 246, 0.12);
  color: var(--accent);
  outline: none;
}
.chapter-permalink.copied {
  opacity: 1;
  color: var(--green);
}

.chapter-detail {
  padding: 0 20px 16px 52px;
  display: none;
}
.chapter.expanded .chapter-detail { display: block; }

.chapter-quality {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--surface);
  border-left: 3px solid var(--fg3);
}
.chapter-quality-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
}
.chapter-quality-label.corrected { color: var(--orange); border-color: var(--orange); }
.chapter-quality-label.struggling { color: var(--red); border-color: var(--red); }
.chapter-quality-label.clean { color: var(--green); }
.chapter-quality .chapter-quality-label.corrected ~ * { border-color: var(--orange); }
.chapter-quality:has(.chapter-quality-label.corrected) { border-left-color: var(--orange); }
.chapter-quality:has(.chapter-quality-label.struggling) { border-left-color: var(--red); }
.chapter-quality-retries {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.chapter-retry-chip {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  background: rgba(240, 112, 112, 0.06);
  padding: 2px 7px;
  border-radius: 4px;
}
.chapter-quality-corrections {
  font-size: 11px;
  color: var(--green);
  margin-top: 4px;
}

.chapter-waste-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--mono);
  background: var(--orange-dim);
  color: var(--orange);
}
.chapter-efficiency {
  margin-bottom: 12px;
  padding: 8px 12px;
  border-radius: 6px;
  background: var(--surface);
  border-left: 3px solid var(--orange);
}
.chapter-efficiency-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.chapter-efficiency-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  color: var(--orange);
}
.chapter-efficiency-score {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  margin-left: auto;
}
.chapter-efficiency-bar-wrap {
  height: 4px;
  background: rgba(255,255,255,0.06);
  border-radius: 2px;
  margin-bottom: 8px;
}
.chapter-efficiency-bar {
  height: 100%;
  border-radius: 2px;
  transition: width 0.3s;
}
.chapter-efficiency-bar.eff-good { background: var(--green); }
.chapter-efficiency-bar.eff-ok { background: var(--orange); }
.chapter-efficiency-bar.eff-bad { background: var(--red); }
.chapter-efficiency-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.chapter-efficiency-metric {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
}
.chapter-efficiency-metric-value {
  font-weight: 600;
  color: var(--fg);
}
.chapter-efficiency-metric-value.val-good { color: var(--green); }
.chapter-efficiency-metric-value.val-bad { color: var(--red); }
.chapter-efficiency-reasons {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.chapter-efficiency-reason {
  font-size: 10px;
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(232,164,76,0.08);
  color: var(--orange);
}

.chapter-files { margin-bottom: 10px; }
.chapter-files-label {
  font-size: 11px;
  color: var(--fg3);
  font-weight: 500;
  margin-bottom: 4px;
}
.chapter-file {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
  padding: 2px 0;
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.chapter-file-ops {
  font-size: 10px;
  color: var(--fg3);
}

.chapter-response {
  font-size: 13px;
  color: var(--fg3);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  border-top: 1px solid var(--border);
  padding-top: 10px;
  margin-top: 10px;
}

.chapter-commands { margin-bottom: 10px; }
.chapter-cmd {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
  padding: 2px 0;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.chapter-cmd-status { font-size: 11px; }
.chapter-cmd-status.ok { color: var(--green); }
.chapter-cmd-status.fail { color: var(--red); }

.chapter-output {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  padding: 4px 8px;
  margin: 2px 0 6px 18px;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  max-height: 80px;
  overflow: hidden;
  border-left: 2px solid rgba(255, 255, 255, 0.06);
  position: relative;
}
.chapter-output.expanded, .chapter-diff-del.expanded,
.chapter-diff-add.expanded, .chapter-agent-prompt.expanded,
.chapter-mcp-output.expanded,
.chapter-thinking-block.expanded {
  max-height: none;
  overflow: visible;
}
.expand-toggle {
  display: block;
  font-size: 10px;
  font-family: var(--mono);
  color: var(--accent);
  cursor: pointer;
  padding: 2px 8px;
  margin: -2px 0 6px 18px;
  user-select: none;
  opacity: 0.8;
  transition: opacity 0.15s;
  appearance: none;
  border: 0;
  background: transparent;
  text-align: left;
}
.expand-toggle:hover,
.expand-toggle:focus-visible {
  opacity: 1;
  outline: none;
  background: rgba(139, 124, 246, 0.08);
  border-radius: 4px;
}
.expand-toggle.in-diff {
  margin: -2px 0 2px 0;
  padding: 2px 8px;
}
.chapter-search-count {
  font-size: 10px;
  color: var(--fg3);
  margin-left: 8px;
  white-space: nowrap;
}

.chapter-web { margin-bottom: 10px; }
.chapter-web-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--fg3);
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 5px;
}
.chapter-web-label::before {
  content: '\\1F310';
  font-size: 12px;
}
.chapter-web-op {
  font-size: 12px;
  color: var(--fg2);
  padding: 6px 8px;
  margin-bottom: 6px;
  background: var(--surface2);
  border-radius: 6px;
  border-left: 3px solid #6ba4e8;
}
.chapter-web-op.error { border-left-color: var(--red); }
.chapter-web-type {
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 600;
  text-transform: uppercase;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 6px;
}
.chapter-web-type.fetch {
  color: #6ba4e8;
  background: rgba(107, 164, 232, 0.12);
}
.chapter-web-type.search {
  color: #a78bfa;
  background: rgba(167, 139, 250, 0.12);
}
.chapter-web-url {
  font-family: var(--mono);
  font-size: 11px;
  color: #6ba4e8;
  text-decoration: none;
  word-break: break-all;
}
.chapter-web-url:hover { text-decoration: underline; }
.chapter-web-query {
  font-weight: 500;
  color: var(--fg);
}
.chapter-web-prompt {
  font-size: 11px;
  color: var(--fg3);
  margin-top: 3px;
  font-style: italic;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.chapter-web-preview {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  margin-top: 4px;
  padding: 4px 6px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  max-height: 48px;
  overflow: hidden;
  white-space: pre-wrap;
  position: relative;
}
.chapter-web-results {
  margin-top: 4px;
  padding-left: 4px;
}
.chapter-web-result {
  font-size: 11px;
  padding: 1px 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.chapter-web-result-title {
  color: var(--fg);
  font-weight: 400;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 300px;
}
.chapter-web-result-url {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--fg3);
  text-decoration: none;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.chapter-web-result-url:hover { color: #6ba4e8; }
.chapter-web-count {
  font-size: 10px;
  color: var(--fg3);
  margin-left: auto;
  white-space: nowrap;
}
.chapter-web-title {
  font-size: 11px;
  color: var(--fg);
  font-weight: 500;
  margin-top: 2px;
}

.chapter-agents { margin-bottom: 10px; }
.chapter-agent {
  font-size: 12px;
  color: var(--fg2);
  padding: 2px 0;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.chapter-agent-status { font-size: 11px; }
.chapter-agent-status.ok { color: var(--green); }
.chapter-agent-status.fail { color: var(--red); }
.chapter-agent-status.pending { color: var(--fg3); }
.chapter-agent-desc {
  font-size: 12px;
  color: var(--fg);
  font-weight: 500;
}
.chapter-agent-type {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(167, 139, 250, 0.12);
  color: var(--accent);
  font-family: var(--mono);
}
.chapter-agent-prompt {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  padding: 3px 8px;
  margin: 2px 0 4px 18px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  border-left: 2px solid rgba(167, 139, 250, 0.2);
  max-height: 60px;
  overflow: hidden;
  position: relative;
}

.chapter-mcp { margin-bottom: 10px; }
.chapter-mcp-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--fg3);
  margin-bottom: 6px;
}
.chapter-mcp-label::before {
  content: '\\2699 ';
  font-size: 12px;
}
.chapter-mcp-op {
  font-size: 12px;
  padding: 6px 8px;
  margin-bottom: 4px;
  background: var(--surface2);
  border-radius: 6px;
  border-left: 3px solid #5dadec;
}
.chapter-mcp-op.mcp-error { border-left-color: var(--red); }
.chapter-mcp-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
}
.chapter-mcp-server {
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 600;
  color: #5dadec;
  background: rgba(93, 173, 236, 0.12);
  padding: 1px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.chapter-mcp-tool {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg);
  font-weight: 500;
}
.chapter-mcp-status {
  font-size: 11px;
  margin-left: auto;
}
.chapter-mcp-status.ok { color: var(--green); }
.chapter-mcp-status.fail { color: var(--red); }
.chapter-mcp-params {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 4px;
  font-size: 11px;
}
.chapter-mcp-param-key {
  color: var(--fg3);
  font-family: var(--mono);
}
.chapter-mcp-param-val {
  color: var(--fg2);
  font-family: var(--mono);
  word-break: break-all;
}
.chapter-mcp-output {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg3);
  background: rgba(255,255,255,0.02);
  border-radius: 4px;
  padding: 4px 6px;
  margin-top: 4px;
  max-height: 48px;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
  position: relative;
}
.chapter-mcp-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-family: var(--mono);
  color: #5dadec;
  background: rgba(93, 173, 236, 0.08);
  border-radius: 4px;
  padding: 1px 6px;
  margin-left: 4px;
  white-space: nowrap;
}

.chapter-diffs { margin-bottom: 10px; }
.chapter-diff-header {
  display: flex;
  gap: 8px;
  align-items: baseline;
  margin-top: 6px;
  margin-bottom: 2px;
}
.chapter-diff-path {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
}
.chapter-diff-op {
  font-size: 10px;
  color: var(--fg3);
}
.chapter-diff-block {
  font-size: 11px;
  font-family: var(--mono);
  border-radius: 4px;
  overflow: hidden;
  margin: 2px 0 6px 0;
  border: 1px solid var(--border);
  line-height: 1.5;
}
.chapter-diff-del {
  background: var(--red-dim);
  color: var(--red);
  padding: 4px 8px;
  white-space: pre-wrap;
  word-break: break-all;
  border-left: 3px solid var(--red);
  max-height: 60px;
  overflow: hidden;
  position: relative;
}
.chapter-diff-add {
  background: var(--green-dim);
  color: var(--green);
  padding: 4px 8px;
  white-space: pre-wrap;
  word-break: break-all;
  border-left: 3px solid var(--green);
  max-height: 60px;
  overflow: hidden;
  position: relative;
}

.waveform-wrap {
  margin-bottom: 12px;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px 12px;
  position: relative;
}
.waveform-label {
  font-size: 11px;
  color: var(--fg3);
  margin-bottom: 8px;
  font-weight: 500;
}
.waveform-canvas {
  width: 100%;
  border-radius: 6px;
  cursor: pointer;
  display: block;
}
.waveform-canvas:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.waveform-tooltip {
  position: absolute;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--fg);
  pointer-events: none;
  z-index: 20;
  white-space: nowrap;
  display: none;
  line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.waveform-legend {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  flex-wrap: wrap;
}
.legend-item {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fg3);
}
.legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.waveform-axis {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--fg3);
  margin-top: 4px;
}

html { scroll-behavior: smooth; }

.waveform-cursor {
  position: absolute;
  width: 1px;
  background: rgba(255,255,255,0.25);
  pointer-events: none;
  z-index: 10;
  display: none;
}

.chapter.highlight {
  animation: ch-flash 1.5s ease-out;
}
@keyframes ch-flash {
  0% { background: rgba(139, 124, 246, 0.15); }
  100% { background: var(--surface); }
}

.chapter.wf-hover {
  background: var(--surface2);
  transition: background 0.1s;
}

.filter-bar {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 12px 16px;
  margin-bottom: 12px;
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.filter-tools {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.filter-chip {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 500;
  font-family: var(--mono);
  background: rgba(255, 255, 255, 0.04);
  color: var(--fg3);
  cursor: pointer;
  user-select: none;
  transition: background 0.12s, color 0.12s;
  border: 1px solid transparent;
  appearance: none;
  text-align: center;
}
.filter-chip:hover,
.filter-chip:focus-visible {
  background: rgba(255, 255, 255, 0.08);
  color: var(--fg2);
  outline: none;
}
.filter-chip.active {
  background: rgba(139, 124, 246, 0.15);
  color: var(--accent);
  border-color: rgba(139, 124, 246, 0.3);
}
.filter-search {
  flex: 1;
  min-width: 140px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 5px 10px;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg);
  outline: none;
  transition: border-color 0.15s;
}
.filter-search::placeholder { color: var(--fg3); }
.filter-search:focus { border-color: rgba(139, 124, 246, 0.4); }
.filter-count {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  white-space: nowrap;
}
.chapter.filter-hidden { display: none; }

.chapter.kb-focused {
  outline: none;
  border-left: 2px solid rgba(139, 124, 246, 0.5);
  background: rgba(139, 124, 246, 0.04);
}
.chapter.kb-focused.expanded {
  border-left: 2px solid rgba(139, 124, 246, 0.5);
  background: var(--surface2);
}

.error-summary {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 12px;
  border-left: 3px solid var(--red);
}
.error-summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.error-summary-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--red);
  letter-spacing: 0.2px;
}
.error-summary-count {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
}
.error-summary-body {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
  align-items: flex-start;
}
.error-tools-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.error-tool-chip {
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 5px;
  background: var(--red-dim);
  color: var(--red);
  font-weight: 500;
}
.error-streaks {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.error-streak-badge {
  font-size: 11px;
  font-family: var(--mono);
  padding: 2px 8px;
  border-radius: 5px;
  border: 0;
  background: var(--orange-dim);
  color: var(--orange);
  cursor: pointer;
  transition: background 0.12s;
  appearance: none;
}
.error-streak-badge:hover,
.error-streak-badge:focus-visible {
  background: rgba(232, 164, 76, 0.2);
}
.error-streak-badge:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.error-timeline {
  display: flex;
  gap: 2px;
  align-items: center;
  margin-top: 8px;
}
.error-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  border: 0;
  padding: 0;
  cursor: pointer;
  transition: transform 0.12s, box-shadow 0.12s;
  flex-shrink: 0;
  appearance: none;
}
.error-dot:hover,
.error-dot:focus-visible {
  transform: scale(1.5);
  box-shadow: 0 0 6px var(--red);
}
.error-dot:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.error-dot.has-error {
  background: var(--red);
}
.error-dot.no-error {
  background: rgba(255, 255, 255, 0.06);
}
.error-dot.streak {
  background: var(--orange);
  box-shadow: 0 0 4px rgba(232, 164, 76, 0.4);
}
.chapter.error-streak-hl {
  border-left: 2px solid var(--orange);
}

/* Tool flow visualization */
.tool-flow {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 12px;
}
.tool-flow-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg2);
  margin-bottom: 12px;
  letter-spacing: 0.2px;
}
.tool-flow-sequence {
  display: flex;
  flex-wrap: wrap;
  gap: 1px;
  margin-bottom: 14px;
  border-radius: 4px;
  overflow: hidden;
}
.tool-flow-cell {
  width: 6px;
  height: 18px;
  flex-shrink: 0;
  opacity: 0.85;
  transition: opacity 0.1s, transform 0.1s;
  cursor: default;
}
.tool-flow-cell:hover {
  opacity: 1;
  transform: scaleY(1.4);
  z-index: 2;
  position: relative;
}
.tool-flow-divider {
  width: 2px;
  height: 18px;
  flex-shrink: 0;
  background: var(--border);
  margin: 0 1px;
}
.tool-flow-summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
  margin-bottom: 12px;
}
.tool-flow-stat {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
}
.tool-flow-stat-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}
.tool-flow-stat-name {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
  flex: 1;
}
.tool-flow-stat-count {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.tool-flow-stat-avg {
  font-size: 10px;
  color: var(--fg3);
  font-family: var(--mono);
}
.tool-flow-transitions {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}
.tool-flow-transitions-label {
  font-size: 11px;
  color: var(--fg3);
  font-weight: 500;
  margin-bottom: 8px;
}
.tool-flow-transition-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tool-flow-transition {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  padding: 3px 8px;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid var(--border);
}
.tool-flow-transition-arrow {
  color: var(--fg3);
  font-size: 10px;
}
.tool-flow-transition-count {
  color: var(--fg3);
  font-size: 10px;
  margin-left: 2px;
}

/* Tool performance metrics */
.tool-perf {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 12px;
}
.tool-perf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  user-select: none;
  font: inherit;
  text-align: left;
  appearance: none;
}
.tool-perf-header:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.tool-perf-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg2);
  letter-spacing: 0.2px;
}
.tool-perf-toggle {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
}
.tool-perf-body {
  display: none;
  margin-top: 14px;
}
.tool-perf.expanded .tool-perf-body { display: block; }
.tool-perf-sort {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.tool-perf-sort-btn {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--fg3);
  background: none;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 2px 8px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}
.tool-perf-sort-btn:hover { color: var(--fg2); border-color: var(--fg3); }
.tool-perf-sort-btn.active { color: var(--accent); border-color: var(--accent); }
.tool-perf-table {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tool-perf-row {
  display: grid;
  grid-template-columns: 10px 90px 50px 1fr 50px 50px;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  border: 0;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.15s;
  appearance: none;
}
.tool-perf-row:hover { background: rgba(255, 255, 255, 0.05); }
.tool-perf-row:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tool-perf-row.active { background: rgba(139, 124, 246, 0.08); outline: 1px solid rgba(139, 124, 246, 0.3); }
.tool-perf-dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex-shrink: 0;
}
.tool-perf-name {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tool-perf-calls {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg);
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.tool-perf-bar-wrap {
  height: 14px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  overflow: hidden;
  display: flex;
}
.tool-perf-bar-ok {
  height: 100%;
  background: var(--green);
  opacity: 0.7;
  transition: width 0.3s;
}
.tool-perf-bar-err {
  height: 100%;
  background: var(--red);
  opacity: 0.7;
  transition: width 0.3s;
}
.tool-perf-rate {
  font-size: 11px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
.tool-perf-rate.perfect { color: var(--green); }
.tool-perf-rate.good { color: var(--fg2); }
.tool-perf-rate.warn { color: var(--orange); }
.tool-perf-rate.bad { color: var(--red); }
.tool-perf-errs {
  font-size: 11px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--fg3);
  text-align: right;
}
.tool-perf-errs.has-errors { color: var(--red); }
.tool-perf-retries {
  font-size: 10px;
  font-family: var(--mono);
  color: var(--fg3);
  margin-top: 2px;
  grid-column: 3 / -1;
}

/* Cost chart */
.cost-chart {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px 12px;
  margin-bottom: 12px;
  position: relative;
}
.cost-chart-header {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg2);
  margin-bottom: 4px;
  letter-spacing: 0.2px;
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.cost-chart-total {
  font-size: 11px;
  color: var(--orange);
  font-weight: 500;
}
.cost-chart-canvas {
  width: 100%;
  height: 100px;
  border-radius: 6px;
  cursor: crosshair;
  display: block;
}
.cost-chart-canvas:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.cost-chart-tooltip {
  position: absolute;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--fg);
  pointer-events: none;
  z-index: 20;
  white-space: nowrap;
  display: none;
  line-height: 1.4;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}
.cost-chart-axis {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--fg3);
  margin-top: 4px;
}

/* File hotspot visualization */
.file-hotspot {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 12px;
}
.file-hotspot-header {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  user-select: none;
  font: inherit;
  text-align: left;
  appearance: none;
}
.file-hotspot-header:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.file-hotspot-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--fg2);
  letter-spacing: 0.2px;
}
.file-hotspot-toggle {
  font-size: 10px;
  color: var(--fg3);
  font-family: var(--mono);
}
.file-hotspot-count {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  margin-left: auto;
}
.file-hotspot-body {
  margin-top: 12px;
  display: none;
}
.file-hotspot.expanded .file-hotspot-body {
  display: block;
}
.file-hotspot-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 360px;
  overflow-y: auto;
}
.file-hotspot-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s;
  border: 1px solid transparent;
  appearance: none;
}
.file-hotspot-item:hover {
  background: rgba(255, 255, 255, 0.05);
}
.file-hotspot-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.file-hotspot-item.active {
  background: rgba(139, 124, 246, 0.08);
  border-color: rgba(139, 124, 246, 0.25);
}
.file-hotspot-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: width 0.15s, height 0.15s;
}
.file-hotspot-path {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-hotspot-ops {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}
.file-hotspot-op {
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 500;
}
.file-hotspot-op.read { background: rgba(107, 164, 232, 0.12); color: #6ba4e8; }
.file-hotspot-op.edit { background: rgba(224, 196, 94, 0.12); color: #e0c45e; }
.file-hotspot-op.write { background: rgba(216, 150, 96, 0.12); color: #d89660; }
.file-hotspot-touch {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
  font-variant-numeric: tabular-nums;
  min-width: 24px;
  text-align: right;
  flex-shrink: 0;
}
.file-hotspot-chapters {
  font-size: 10px;
  color: var(--fg3);
  font-family: var(--mono);
  flex-shrink: 0;
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-hotspot-bar {
  height: 3px;
  border-radius: 2px;
  margin-top: 8px;
  display: flex;
  gap: 1px;
  overflow: hidden;
}
.file-hotspot-bar-seg {
  height: 100%;
  flex-shrink: 0;
}

/* Git timeline panel */
.git-timeline {
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px;
  margin-bottom: 12px;
  border-left: 3px solid var(--orange);
}
.git-timeline-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.git-timeline-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--orange);
  letter-spacing: 0.2px;
}
.git-timeline-count {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg3);
}
.git-timeline-ops {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.git-op {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.02);
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
}
.git-op-icon {
  font-size: 13px;
  flex-shrink: 0;
  width: 18px;
  text-align: center;
}
.git-op-icon.commit { color: var(--green); }
.git-op-icon.branch { color: var(--accent); }
.git-op-icon.push { color: var(--orange); }
.git-op-icon.merge { color: #c88abd; }
.git-op-icon.other { color: var(--fg3); }
.git-op-detail {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.git-op-hash {
  color: var(--orange);
  font-size: 11px;
  margin-right: 6px;
}
.git-op-msg {
  color: var(--fg);
  font-size: 12px;
}
.git-op-branch-name {
  color: var(--accent);
  font-weight: 500;
}
.git-op-chapter {
  font-size: 10px;
  color: var(--fg3);
  flex-shrink: 0;
  background: none;
  border: 0;
  padding: 0;
  font-family: var(--mono);
  cursor: pointer;
  appearance: none;
}
.git-op-chapter:hover {
  color: var(--accent);
}
.git-op-chapter:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

/* Git badge in chapter header */
.chapter-git-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  font-family: var(--mono);
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--orange-dim);
  color: var(--orange);
  font-weight: 500;
}

/* Git section in chapter detail */
.chapter-git-ops { margin-bottom: 10px; }
.chapter-git-op {
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg2);
  padding: 3px 0;
  display: flex;
  gap: 6px;
  align-items: baseline;
}
.chapter-git-op-icon { font-size: 11px; }
.chapter-git-op-icon.commit { color: var(--green); }
.chapter-git-op-icon.branch { color: var(--accent); }
.chapter-git-op-icon.push { color: var(--orange); }
.chapter-git-op-icon.merge { color: #c88abd; }

.session-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
  margin-bottom: 12px;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 14px 20px;
  align-items: center;
}
.session-summary-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  color: var(--fg2);
}
.session-summary-item .ss-label {
  font-size: 11px;
  color: var(--fg3);
  font-weight: 500;
}
.session-summary-item .ss-value {
  font-weight: 600;
  color: var(--fg);
}
.session-summary-item.ss-cost .ss-value { color: var(--orange); }
.session-summary-item.ss-errors .ss-value { color: var(--red); }
.session-summary-item.ss-commits .ss-value { color: var(--green); }
.session-summary-item.ss-duration .ss-value { color: var(--accent); }
.session-summary-item.ss-quality-mixed .ss-value { color: var(--orange); }
.session-summary-item.ss-waste .ss-value { color: var(--orange); }
.session-summary-sep {
  width: 1px;
  height: 18px;
  background: var(--border);
  flex-shrink: 0;
}

.session-grade {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-right: 6px;
}
.session-grade-letter {
  font-family: var(--mono);
  font-size: 28px;
  font-weight: 700;
  line-height: 1;
  min-width: 32px;
  text-align: center;
}
.session-grade-letter.grade-a { color: var(--green); }
.session-grade-letter.grade-b { color: var(--green); opacity: 0.8; }
.session-grade-letter.grade-c { color: var(--orange); }
.session-grade-letter.grade-d { color: #d97740; }
.session-grade-letter.grade-f { color: var(--red); }
.session-grade-detail {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.session-grade-score {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg3);
  font-variant-numeric: tabular-nums;
}
.session-grade-breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
}
.session-grade-factor {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--fg3);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.session-grade-factor-bar {
  display: inline-block;
  width: 28px;
  height: 4px;
  border-radius: 2px;
  background: var(--border);
  position: relative;
  overflow: hidden;
}
.session-grade-factor-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: 2px;
}
.session-grade-factor-fill.fill-good { background: var(--green); }
.session-grade-factor-fill.fill-ok { background: var(--orange); }
.session-grade-factor-fill.fill-bad { background: var(--red); }
.session-grade-note {
  font-size: 11px;
  color: var(--fg3);
  font-style: italic;
  margin-top: 1px;
}

.activity-timeline {
  margin-bottom: 12px;
  background: var(--surface);
  border-radius: var(--radius);
  padding: 16px 20px 12px;
  position: relative;
  z-index: 10;
}
.activity-timeline-label {
  font-size: 11px;
  color: var(--fg3);
  margin-bottom: 8px;
  font-weight: 500;
}
.activity-timeline-canvas {
  width: 100%;
  border-radius: 6px;
  display: block;
  cursor: crosshair;
}
.activity-timeline-canvas:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.activity-timeline-times {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 10px;
  font-family: var(--mono);
  color: var(--fg3);
}
.activity-timeline-legend {
  display: flex;
  gap: 14px;
  margin-top: 8px;
  font-size: 10px;
  color: var(--fg3);
}
.activity-timeline-legend-item {
  display: flex;
  align-items: center;
  gap: 4px;
}
.activity-timeline-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}
.activity-timeline-tooltip {
  position: absolute;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--fg);
  pointer-events: none;
  z-index: 20;
  white-space: nowrap;
  display: none;
  line-height: 1.5;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}

/* Chapter hover tooltip */
.chapter-tooltip {
  position: fixed;
  z-index: 9999;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px 14px;
  min-width: 220px;
  max-width: 340px;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.15s;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  font-size: 12px;
  line-height: 1.5;
}
.chapter-tooltip.visible { opacity: 1; }
.chapter-tooltip-prompt {
  color: var(--fg);
  font-weight: 500;
  margin-bottom: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 310px;
}
.chapter-tooltip-tools {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.chapter-tooltip-tool {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.chapter-tooltip-row {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--fg2);
  margin-bottom: 3px;
}
.chapter-tooltip-row:last-child { margin-bottom: 0; }
.chapter-tooltip-label {
  color: var(--fg3);
  min-width: 48px;
}
.chapter-tooltip-value {
  color: var(--fg);
  font-family: var(--mono);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chapter-tooltip-value.errors { color: var(--red); }
.chapter-tooltip-value.clean { color: var(--green); }
.chapter-tooltip-value.corrected { color: var(--orange); }
.chapter-tooltip-value.struggling { color: var(--red); }
.chapter-tooltip-files {
  color: var(--fg2);
  font-family: var(--mono);
  font-size: 11px;
  margin-top: 2px;
}
.chapter-tooltip-file {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 300px;
}

/* Session mini-map / navigation sidebar */
.minimap {
  position: fixed;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  z-index: 500;
  display: flex;
  flex-direction: column;
  gap: 1px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 3px;
  max-height: 80vh;
  overflow: hidden;
  opacity: 0.6;
  transition: opacity 0.2s;
}
.minimap:hover { opacity: 1; }
.minimap-block {
  width: 22px;
  border-radius: 2px;
  border: 0;
  padding: 0;
  cursor: pointer;
  position: relative;
  transition: outline 0.15s;
  outline: 1.5px solid transparent;
  flex-shrink: 0;
  appearance: none;
}
.minimap-block:hover { outline-color: var(--fg3); }
.minimap-block:focus-visible { outline-color: var(--accent); outline-width: 2px; }
.minimap-block.mm-clean { background: var(--green); opacity: 0.45; }
.minimap-block.mm-corrected { background: var(--orange); opacity: 0.6; }
.minimap-block.mm-struggling { background: var(--red); opacity: 0.65; }
.minimap-block.mm-visible {
  outline-color: var(--accent);
  outline-width: 2px;
  opacity: 1;
}
.minimap-marker {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  right: -1px;
}
.minimap-marker.mm-error { background: var(--red); top: 1px; }
.minimap-marker.mm-commit { background: var(--green); bottom: 1px; }
.minimap-tooltip {
  position: fixed;
  pointer-events: none;
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg);
  white-space: nowrap;
  z-index: 9999;
  opacity: 0;
  transition: opacity 0.12s;
}
.minimap-tooltip.visible { opacity: 1; }
.minimap-viewport {
  position: absolute;
  left: 0;
  width: 100%;
  border: 1.5px solid var(--accent);
  border-radius: 3px;
  background: rgba(139, 124, 246, 0.08);
  pointer-events: none;
  transition: top 0.1s ease-out, height 0.1s ease-out;
  z-index: 1;
}

/* Chapter dependency / relationship indicators */
.chapter-dep-badge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: var(--mono);
  background: rgba(139, 124, 246, 0.1);
  color: var(--accent);
  cursor: pointer;
  transition: background 0.12s;
}
.chapter-dep-badge:hover {
  background: rgba(139, 124, 246, 0.2);
}
.chapter-dep-badge.dep-fix {
  background: rgba(74, 222, 128, 0.1);
  color: var(--green);
}
.chapter-dep-badge.dep-fix:hover {
  background: rgba(74, 222, 128, 0.18);
}
.chapter-dep-connector {
  position: absolute;
  left: 27px;
  width: 2px;
  background: rgba(139, 124, 246, 0.15);
  z-index: 0;
  pointer-events: none;
}
.chapter { position: relative; }
.chapter-dep-section {
  padding: 8px 14px;
  margin-bottom: 8px;
  border-left: 2px solid rgba(139, 124, 246, 0.25);
  background: rgba(139, 124, 246, 0.03);
  border-radius: 0 6px 6px 0;
  font-size: 12px;
  color: var(--fg2);
}
.chapter-dep-section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--fg3);
  margin-bottom: 4px;
}
.chapter-dep-link {
  display: inline-block;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  margin-right: 8px;
  padding: 1px 5px;
  border-radius: 3px;
  transition: background 0.12s;
  appearance: none;
  border: 0;
  background: transparent;
}
.chapter-dep-link:hover,
.chapter-dep-link:focus-visible {
  background: rgba(139, 124, 246, 0.12);
  outline: none;
}
.chapter-dep-shared-files {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--fg3);
  margin-left: 4px;
}
@media (max-width: 768px) {
  #app { padding: 16px 12px; }
  .stats-bar { flex-wrap: wrap; }
  .stat { min-width: 33%; border-right: none; padding: 8px 12px; }
  .filter-bar { flex-direction: column; align-items: stretch; }
  .filter-search { min-width: 100%; }
  .tool-flow-summary { grid-template-columns: 1fr; }
  .tool-flow-cell { width: 4px; height: 14px; }
  .tool-perf-row { grid-template-columns: 10px 70px 40px 1fr 40px 40px; gap: 4px; padding: 4px 6px; }
  .tool-perf-name { font-size: 11px; }
  .tool-perf-retries { display: none; }
  .file-hotspot-ops { display: none; }
  .file-hotspot-chapters { display: none; }
  .session-summary { gap: 4px 12px; }
  .session-summary-sep { display: none; }
  .session-grade-letter { font-size: 22px; }
  .session-grade-breakdown { display: none; }
  .activity-timeline-legend { flex-wrap: wrap; gap: 8px; }
  .activity-timeline-times { font-size: 9px; }
  .chapter-tooltip { display: none; }
  .minimap { display: none; }
  .minimap-tooltip { display: none; }
}

/* Flyout embed: hide standalone identity/actions so the Runs panel header is the identity */
body.embed-view { margin: 0; }
body.embed-view #app { max-width: none; padding: 12px 16px 28px; }
body.embed-view .header { padding: 10px 16px; margin-bottom: 10px; }
body.embed-view .header-top,
body.embed-view .header-title,
body.embed-view .header-actions,
body.embed-view .view-run-chip,
body.embed-view .view-continue-chip,
body.embed-view #cmdkOverlay,
body.embed-view .cmdk-trigger { display: none !important; }
`;
