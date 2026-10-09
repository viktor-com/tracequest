import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { THEME_BOOT_SCRIPT, appTopHtml, APP_TOP_CSS, APP_SHELL_JS } from "./app-chrome.js";
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

/** Compare lives under Runs: same shell, nav on Runs, exits back to the list. */
function compareDocument(bodyHtml, { swappable = false } = {}) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tracequest — compare</title>
${THEME_BOOT_SCRIPT}
<style>
${STANDALONE_BASE_CSS}
${APP_TOP_CSS}
${COMPARE_PAGE_CSS}
${COMMAND_PALETTE_CSS}
</style>
</head>
<body>
${appTopHtml({ crumbHtml: '<span class="app-crumb">Compare</span>', nav: "runs" })}
<div class="container">
  <div class="cmp-header">
    <a class="cmp-back" href="/sessions">&larr; Back to Runs</a>
    <div class="cmp-title-row">
      <h1 class="cmp-title">Compare runs</h1>
      ${swappable ? '<a class="cmp-swap" id="cmpSwap" href="#" title="Swap sides (s)" hidden><span aria-hidden="true">&#8646;</span> Swap A and B</a>' : ""}
    </div>
  </div>

  ${bodyHtml}
</div>
${COMMAND_PALETTE_HTML}
<script>
${COMMAND_PALETTE_CLIENT_JS}
${APP_SHELL_JS}
(function () {
  var nr = document.getElementById("newRunBtn");
  if (nr) nr.addEventListener("click", function () { location.href = "/?launch=1"; });
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

  <section class="cmp-section">
    <h2 class="cmp-section-title">Metrics</h2>
    <table class="cmp-table">
      ${buildColHeadersHtml(a.id, b.id)}
      <tbody>
      ${metricRowsHtml}
      </tbody>
    </table>
  </section>

  <div class="cmp-grid">
    <section class="cmp-section">
      <h2 class="cmp-section-title">Tool usage</h2>
      <div class="tool-cmp-head"><span><span class="cmp-side">A</span>${esc(a.id)}</span><span></span><span><span class="cmp-side">B</span>${esc(b.id)}</span></div>
      ${toolRowsHtml || '<div class="cmp-empty">Neither run called a tool.</div>'}
    </section>

    <section class="cmp-section">
      <h2 class="cmp-section-title">Chapter quality</h2>
      <div class="cmp-outcome">
        ${buildOutcomeSideHtml(a)}
        ${buildOutcomeSideHtml(b)}
      </div>
    </section>
  </div>
`, { swappable: true });
}

export function compareLoadErrorPage({ side = "session", handle = "", status = 500, message = "Unable to load session" } = {}) {
  const displayHandle = handle || "(missing)";
  return compareDocument(`
  <div class="cmp-error" role="alert" data-compare-state="error">
    <div class="cmp-error-status">HTTP ${esc(status)}</div>
    <div class="cmp-error-title">Could not load ${esc(side)}</div>
    <div class="cmp-error-message">${esc(message || "Unable to load session")}</div>
    <div class="cmp-error-handle">${esc(displayHandle)}</div>
    <div class="cmp-error-actions"><a class="cmp-error-link" href="/sessions">&larr; Back to Runs</a></div>
  </div>
`);
}
