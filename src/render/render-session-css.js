import { SESSION_VIEWER_BASE_CSS } from "../browser/shared-css-tokens.js";
import { SESSION_VIEWER_RULES } from "./render-session-rules.js";

/**
 * Print / PDF. The design tokens already switch to light for print; these
 * rules only drop interactive chrome and open every chapter so the paper
 * copy holds the whole story.
 */
const SESSION_VIEWER_PRINT_RULES = `
@media print {
  @page { margin: 14mm 12mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { background: #fff; font-size: 11px; }
  #app { max-width: none; padding: 0; }
  .header-back, .header-actions, .filter-bar, .expand-toggle, .chapter-tooltip, .chapter-permalink,
  .hf-modal-overlay, .waveform-tooltip, .waveform-cursor, .cost-chart-tooltip, .activity-timeline-tooltip,
  .error-dot, .error-timeline, .minimap, .minimap-tooltip, .tool-perf-sort { display: none !important; }
  .sv-section { margin-top: 18px; break-inside: avoid-page; }
  .sv-overview, .error-summary, .activity-timeline, .waveform-wrap, .cost-chart, .tool-flow, .tool-perf, .file-hotspot, .git-timeline {
    box-shadow: 0 0 0 1px #ddd; background: #fff;
  }
  .chapter { break-inside: avoid; box-shadow: inset 0 -1px 0 #e5e5e5; background: #fff !important; }
  .chapter.filter-hidden { display: block !important; }
  .chapter-detail { display: flex !important; }
  .chapter-prompt-text { display: block !important; -webkit-line-clamp: unset !important; }
  .tool-perf-body, .file-hotspot-body { display: block !important; }
  .chapter-output, .chapter-diff-del, .chapter-diff-add, .chapter-agent-prompt, .chapter-thinking-block, .chapter-mcp-output, .chapter-web-preview {
    max-height: none !important; overflow: visible !important;
  }
  .waveform-canvas, .cost-chart-canvas, .activity-timeline-canvas { max-width: 100%; }
  .file-hotspot-list { max-height: none; }
}
`;

export { SESSION_VIEWER_RULES } from "./render-session-rules.js";

export const SESSION_VIEWER_CSS =
  SESSION_VIEWER_BASE_CSS +
  SESSION_VIEWER_RULES +
  SESSION_VIEWER_PRINT_RULES;
