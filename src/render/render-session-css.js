import {
  SESSION_VIEWER_BASE_CSS,
  CSS_PRINT_ROOT_MARKER,
  CSS_PRINT_ROOT_VARS,
} from "../browser/shared-css-tokens.js";
import { SESSION_VIEWER_RULES } from "./render-session-rules.js";

/** Print / PDF-friendly rules (composed into SESSION_VIEWER_CSS). */
const SESSION_VIEWER_PRINT_RULES = `
/* Print / PDF-friendly stylesheet */
@media print {
  :root {
${CSS_PRINT_ROOT_MARKER}
  }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body {
    background: #fff;
    color: #111;
    font-size: 11px;
    line-height: 1.5;
  }
  #app {
    max-width: 100%;
    padding: 0;
    margin: 0;
  }
  @page {
    margin: 1.5cm 1.2cm;
    size: auto;
  }

  /* Remove interactive / decorative elements */
  .filter-bar,
  .filter-chip,
  .filter-search,
  .filter-count,
  .expand-toggle,
  .chapter-tooltip,
  .chapter-permalink,
  .export-btn,
  .print-btn,
  .md-btn,
  .hf-btn,
  .hf-modal-overlay,
  .waveform-tooltip,
  .waveform-cursor,
  .cost-chart-tooltip,
  .activity-timeline-tooltip,
  .error-streak-badge,
  .error-dot,
  .minimap,
  .minimap-tooltip { display: none !important; }

  /* Remove hover/transition effects */
  .chapter { transition: none; }
  .chapter:hover { background: var(--surface); }

  /* Expand all chapters — show all detail */
  .chapter-detail { display: block !important; }
  .chapter-prompt-text {
    display: block !important;
    -webkit-line-clamp: unset !important;
  }
  .chapter.filter-hidden { display: block !important; }

  /* Remove max-height constraints on all content blocks */
  .chapter-output,
  .chapter-diff-del,
  .chapter-diff-add,
  .chapter-agent-prompt,
  .chapter-thinking-block,
  .chapter-mcp-output {
    max-height: none !important;
    overflow: visible !important;
  }

  /* Keep canvas visualizations visible */
  .waveform-canvas,
  .cost-chart-canvas,
  .activity-timeline-canvas {
    max-width: 100%;
  }

  /* Panel backgrounds — light borders instead of colored surfaces */
  .header,
  .stats-bar,
  .session-summary,
  .activity-timeline,
  .error-summary,
  .waveform-wrap,
  .tool-flow,
  .tool-perf,
  .cost-chart,
  .file-hotspot,
  .git-timeline,
  .chapter {
    background: #fff;
    border: 1px solid #ddd;
    box-shadow: none;
  }

  /* Avoid page breaks inside chapters */
  .chapter {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* Also avoid breaks inside key panels */
  .session-summary,
  .stats-bar,
  .git-timeline,
  .error-summary {
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* Reduce spacing for print density */
  .chapters { gap: 4px; }
  .header { padding: 16px 20px; margin-bottom: 8px; }
  .stats-bar { margin-bottom: 8px; }
  .session-summary { margin-bottom: 8px; }

  /* Sensible font sizes */
  .stat-value { font-size: 18px; }
  .stat-label { font-size: 10px; }
  .chapter-prompt { font-size: 12px; }
  .chapter-response { font-size: 11px; }
  .chapter-cmd { font-size: 11px; }
  .chapter-output { font-size: 10px; }
  .chapter-file { font-size: 11px; }

  /* Remove decorative colored left borders — use thin gray */
  .error-summary { border-left-color: #aaa; }
  .git-timeline { border-left-color: #aaa; }
  .chapter-quality { border-left-color: #aaa; }
  .chapter-efficiency { border-left-color: #aaa; }
  .chapter-thinking { border-left-color: #aaa; }

  /* Tool performance — expand body for print */
  .tool-perf-body { display: block !important; }
  .tool-perf-toggle { display: none; }
  .tool-perf-sort { display: none; }
  .tool-perf-row { cursor: default; }

  /* File hotspot — expand body for print */
  .file-hotspot-body { display: block !important; }
  .file-hotspot-list { max-height: none !important; overflow: visible !important; }
  .file-hotspot-toggle { display: none; }

  /* Keyboard focus indicator — not relevant in print */
  .chapter.kb-focused { border-left: none; background: #fff; }

  /* Links — show URL for context */
  a[href] { color: var(--accent); text-decoration: underline; }

  /* Tool flow cells — slightly larger for print legibility */
  .tool-flow-cell { width: 8px; height: 20px; }
}
`;

export { SESSION_VIEWER_RULES } from "./render-session-rules.js";

export const SESSION_VIEWER_CSS =
  SESSION_VIEWER_BASE_CSS +
  SESSION_VIEWER_RULES +
  SESSION_VIEWER_PRINT_RULES.replace(CSS_PRINT_ROOT_MARKER, CSS_PRINT_ROOT_VARS.trimEnd());
