import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { APP_SHELL_JS } from "./app-chrome.js";
import { esc } from "../server/server-html-helpers.js";
import { COMPARE_PAGE_CSS } from "./compare-page-css.js";
import {
  COMMAND_PALETTE_CSS,
  COMMAND_PALETTE_HTML,
  COMMAND_PALETTE_CLIENT_JS,
} from "./command-palette.js";
import {
  summarizeCompareSession,
  buildCompareMetricRows,
  buildCompareToolRows,
  buildMetricTableHtml,
  buildToolComparisonHtml,
  buildOutcomeSideHtml,
  compareViewUrl,
  buildSessionCardHtml,
  buildColHeadersHtml,
  buildCompareVerdictHtml,
} from "../chapters/compare-metrics.js";

function compareDocument(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tracequest — compare</title>
<style>
${STANDALONE_BASE_CSS}
${COMPARE_PAGE_CSS}
${COMMAND_PALETTE_CSS}
</style>
</head>
<body>
<div class="container">
  <div class="cmp-header">
    <a class="cmp-title" href="/sessions">tracequest</a>
    <div class="cmp-subtitle">session comparison</div>
    <div class="cmp-header-actions">
      <a class="cmp-back" id="cmpSwap" href="#" title="Swap sides (s)" hidden>&#8646; swap A and B</a>
      <a class="cmp-back" href="/sessions">&larr; back to sessions</a>
    </div>
  </div>

  ${bodyHtml}
</div>
${COMMAND_PALETTE_HTML}
<script>
${COMMAND_PALETTE_CLIENT_JS}
${APP_SHELL_JS}
(function () {
  var q = new URLSearchParams(location.search);
  var swap = document.getElementById("cmpSwap");
  if (!swap || !q.get("a") || !q.get("b")) return;
  var a = q.get("a"); q.set("a", q.get("b")); q.set("b", a);
  swap.href = "?" + q.toString();
  swap.hidden = false;
  document.addEventListener("keydown", function (e) {
    if (e.key !== "s" || e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    location.href = swap.href;
  });
})();
</script>
</body>
</html>`;
}

/**
 * @param {import("../parse.js").ParsedSession} sessionA
 * @param {import("../parse.js").ParsedSession} sessionB
 */
export function comparePage(sessionA, sessionB) {
  const a = summarizeCompareSession(sessionA);
  const b = summarizeCompareSession(sessionB);
  const metricRows = buildCompareMetricRows(a, b);
  const toolRows = buildCompareToolRows(a, b);
  const metricRowsHtml = buildMetricTableHtml(metricRows);
  const toolRowsHtml = buildToolComparisonHtml(toolRows);
  const viewUrlA = compareViewUrl(sessionA, a);
  const viewUrlB = compareViewUrl(sessionB, b);

  return compareDocument(`
  ${buildCompareVerdictHtml(a, b)}
  <div class="cmp-sessions">
    ${buildSessionCardHtml(a, sessionA, viewUrlA, "session-a")}
    ${buildSessionCardHtml(b, sessionB, viewUrlB, "session-b")}
  </div>

  <div class="cmp-section">
    <div class="cmp-section-title">Metrics</div>
    ${buildColHeadersHtml(a.id, b.id)}
    <table class="cmp-table">
      ${metricRowsHtml}
    </table>
  </div>

  <div class="cmp-section">
    <div class="cmp-section-title">Tool usage</div>
    ${buildColHeadersHtml(a.id, b.id)}
    ${toolRowsHtml}
  </div>

  <div class="cmp-section">
    <div class="cmp-section-title">Chapter quality</div>
    <div class="cmp-outcome">
      ${buildOutcomeSideHtml(a)}
      ${buildOutcomeSideHtml(b)}
    </div>
  </div>
`);
}

export function compareLoadErrorPage({ side = "session", handle = "", status = 500, message = "Unable to load session" } = {}) {
  const displayHandle = handle || "(missing)";
  return compareDocument(`
  <div class="cmp-error" role="alert" data-compare-state="error">
    <div class="cmp-error-title">Could not load ${esc(side)}</div>
    <div class="cmp-error-status">HTTP ${esc(status)}</div>
    <div class="cmp-error-handle">${esc(displayHandle)}</div>
    <div class="cmp-error-message">${esc(message || "Unable to load session")}</div>
    <a class="cmp-error-link" href="/sessions">&larr; back to sessions</a>
  </div>
`);
}
