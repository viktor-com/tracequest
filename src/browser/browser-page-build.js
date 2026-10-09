import { browserClientScript } from "./browser-client.js";
import { LAUNCHER_MODAL_CSS, LAUNCHER_MODAL_HTML } from "./launch-page.js";
import { appTopHtml, APP_TOP_CSS, IDENTITY_ROW_CSS, THEME_BOOT_SCRIPT } from "./app-chrome.js";
import { COMMAND_PALETTE_CSS, COMMAND_PALETTE_HTML } from "./command-palette.js";
import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { RUNS_PAGE_CSS } from "./runs-page-css.js";


const HTML_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Runs · tracequest</title>
${THEME_BOOT_SCRIPT}
<style>
${STANDALONE_BASE_CSS}
${APP_TOP_CSS}
${IDENTITY_ROW_CSS}
${RUNS_PAGE_CSS}
${LAUNCHER_MODAL_CSS}
${COMMAND_PALETTE_CSS}
</style>
</head>
<body>
${appTopHtml({
  crumbHtml: '<span class="app-crumb">Runs</span>',
  nav: 'runs',
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
      <input class="filter-input" id="filterInput" type="text" aria-label="Filter runs" aria-controls="suggestions" aria-autocomplete="list" placeholder="Filter runs — words, project:api, errors:>0, tool:Edit, age:<7d" value="`;
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
        <span class="runs-col-run">Run</span>
        <span class="runs-col-time">When</span>
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
