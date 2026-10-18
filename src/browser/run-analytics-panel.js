/**
 * Right-hand analytics panel for an opened chat/run.
 *
 * The /run conversation (and its session rail) stay on screen; this
 * inspector docks on the right and embeds the existing /view evidence
 * (grade, timeline, tiles, errors, charts, chapters) via ?embed=1.
 */

import { FORM_FIELD_GUARD_SRC } from "./is-form-field.js";

const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const ANALYTICS_PANEL_CSS = `
/* --- Run analytics panel (right-hand inspector; chat + rail stay) --- */
html { --run-analytics-width: min(640px, 46vw); }
.run-analytics {
  width: var(--run-analytics-width); flex: 0 0 var(--run-analytics-width); min-width: 0; min-height: 0;
  display: flex; flex-direction: column; background: var(--bg);
  box-shadow: inset 1px 0 0 var(--line-1); animation: ui-fade-in var(--dur-2) var(--ease-out);
}
.run-analytics[hidden] { display: none !important; }
.run-analytics-head {
  display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-shrink: 0;
  padding: 12px 14px 12px 20px; box-shadow: inset 0 -1px 0 var(--line-1);
}
.run-analytics-ident { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.run-analytics-kicker { font-size: var(--text-xs); color: var(--text-3); }
.run-analytics-title {
  margin: 0; font-size: var(--text-sm); font-weight: var(--weight-regular); font-family: var(--font-mono); color: var(--text);
  line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.run-analytics-actions { display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
.run-analytics-open {
  display: inline-flex; align-items: center; height: var(--control-sm); padding: 0 12px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text); background: var(--surface-3); text-decoration: none; white-space: nowrap;
}
.run-analytics-open:hover { background: var(--surface-4); }
.run-analytics-close {
  min-width: 28px; height: 28px; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 0 6px;
  border: 0; border-radius: var(--radius-pill); background: none; color: var(--text-3); cursor: pointer;
  font: inherit; font-size: 15px; line-height: 1; white-space: nowrap;
}
.run-analytics-close:hover { color: var(--text); background: var(--hover); }
.run-analytics-close:focus-visible, .run-analytics-open:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.run-analytics-back { display: none; font-size: var(--text-sm); }
.run-analytics-status, .run-analytics-empty { padding: var(--space-6) var(--space-5); font-size: var(--text-sm); color: var(--text-3); line-height: var(--lh-sm); }
.run-analytics-status::before {
  content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 8px; vertical-align: 1px;
  border-radius: 50%; background: var(--text-3); animation: ui-pulse 1.4s var(--ease-out) infinite;
}
.run-analytics-status[hidden], .run-analytics-empty[hidden] { display: none; }
.run-analytics-frame { flex: 1; width: 100%; border: 0; background: var(--bg); min-height: 0; }
.run-analytics-frame[hidden] { display: none; }
body.analytics-open .chat-output-pane { display: none !important; }
@media (max-width: 1100px) {
  html { --run-analytics-width: min(460px, 48vw); }
}
/* Narrow: two columns do not fit, so analytics covers the chat and its
   close control becomes the way back to it. */
@media (max-width: 760px) {
  body.analytics-open .chat-app { display: none; }
  html { --run-analytics-width: 100%; }
  .run-analytics { flex: 1 1 auto; box-shadow: none; }
  .run-analytics-head { padding: 10px 12px; justify-content: flex-start; }
  .run-analytics-actions { display: contents; }
  .run-analytics-close { order: -1; color: var(--text-2); padding: 0 10px 0 6px; }
  .run-analytics-ident { flex: 1; }
  .run-analytics-close-x { display: none; }
  .run-analytics-back { display: inline; }
}
`;

/**
 * The panel; viewHref is the recording's full /view page (with from= so that
 * page links back to this run view) and label names it in the panel head.
 */
export function analyticsPanelHtml({ viewHref = "/view", label = "" } = {}) {
  return `<aside id="runAnalytics" class="run-analytics" hidden aria-hidden="true" aria-label="Run analytics">
  <header class="run-analytics-head">
    <div class="run-analytics-ident">
      <span class="run-analytics-kicker">Analytics</span>
      <h2 class="run-analytics-title" id="runAnalyticsTitle">this run</h2>
    </div>
    <div class="run-analytics-actions">
      <a class="run-analytics-open" id="viewSessionLink" href="${esc(viewHref)}"${label ? ` data-analytics-label="${esc(label)}"` : ""} title="Open this run's analytics as a full page">Open full page</a>
      <button type="button" class="run-analytics-close" id="runAnalyticsClose" aria-label="Close analytics" title="Close analytics (Esc)"><span class="run-analytics-close-x" aria-hidden="true">&#215;</span><span class="run-analytics-back">&larr; Chat</span></button>
    </div>
  </header>
  <div class="run-analytics-status" id="runAnalyticsStatus" hidden>Loading analytics&#8230;</div>
  <div class="run-analytics-empty" id="runAnalyticsEmpty" hidden>Recording not linked yet — analytics appear once this run has a session.</div>
  <iframe class="run-analytics-frame" id="runAnalyticsFrame" title="Run analytics" hidden></iframe>
</aside>`;
}

export const ANALYTICS_PANEL_HTML = analyticsPanelHtml();

/** The run view's one way into analytics: toggles the panel; A from the keyboard. */
export const ANALYTICS_TOGGLE_HTML = `<button type="button" class="run-analytics-toggle" id="analyticsToggle" aria-expanded="false" aria-controls="runAnalytics" aria-keyshortcuts="a" data-hotkey="a" title="Show or hide analytics for this run (A)"><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2.5 13.5h11M4.5 11V7.5M8 11V3.5M11.5 11V6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>Analytics</button>`;

/**
 * Client script: open/close the RHS /view embed without leaving chat.
 *
 * Opening by click or A pushes one ?analytics=1 history entry, so browser
 * Back closes the panel and stays on the run view; the close control,
 * Escape and the toggle step back through that same entry. A page loaded
 * with ?analytics=1 opens the panel in place, without a new entry.
 */
export const ANALYTICS_PANEL_JS = `
(function bindRunAnalytics() {
  ${FORM_FIELD_GUARD_SRC}
  var panel = document.getElementById("runAnalytics");
  var frame = document.getElementById("runAnalyticsFrame");
  var status = document.getElementById("runAnalyticsStatus");
  var empty = document.getElementById("runAnalyticsEmpty");
  var closeBtn = document.getElementById("runAnalyticsClose");
  var toggle = document.getElementById("analyticsToggle");
  var viewLink = document.getElementById("viewSessionLink");
  var title = document.getElementById("runAnalyticsTitle");
  if (!panel || !frame) return;
  var _src = "";
  var _open = false;

  function embedUrl(href) {
    if (!href) return "";
    try {
      var u = new URL(href, location.origin);
      if (!u.pathname || u.pathname.indexOf("/view") !== 0) return "";
      u.searchParams.delete("from");
      u.searchParams.set("embed", "1");
      return u.pathname + u.search;
    } catch (e) { return ""; }
  }

  function urlWithPanel(open) {
    var params = new URLSearchParams(location.search);
    if (open) params.set("analytics", "1");
    else params.delete("analytics");
    var qs = params.toString();
    return location.pathname + (qs ? "?" + qs : "") + location.hash;
  }

  function urlSaysOpen() {
    try { return new URLSearchParams(location.search).get("analytics") === "1"; } catch (e) { return false; }
  }

  function setView(href, label) {
    _src = href || "";
    if (viewLink && _src) viewLink.href = _src;
    if (title) {
      var idEl = document.getElementById("chatSessionId");
      title.textContent = label || (idEl && idEl.textContent) || "this run";
    }
    if (_open) loadFrame();
  }

  function loadFrame() {
    var url = embedUrl(_src);
    if (!url) {
      if (status) status.hidden = true;
      if (empty) empty.hidden = false;
      frame.hidden = true;
      frame.removeAttribute("src");
      return;
    }
    if (empty) empty.hidden = true;
    var same = frame.getAttribute("src") === url;
    if (!same) {
      if (status) {
        status.hidden = false;
        status.textContent = "Loading analytics…";
      }
      frame.hidden = true;
      frame.src = url;
    } else {
      if (status) status.hidden = true;
      frame.hidden = false;
    }
  }

  function showPanel() {
    _open = true;
    document.body.classList.add("analytics-open");
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    if (!_src && viewLink && viewLink.getAttribute("href") && viewLink.getAttribute("href") !== "/view") {
      setView(viewLink.href, viewLink.getAttribute("data-analytics-label") || "");
    }
    loadFrame();
  }

  function hidePanel() {
    var hadFocus = panel.contains(document.activeElement);
    _open = false;
    document.body.classList.remove("analytics-open");
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    return hadFocus;
  }

  function openPanel() {
    if (_open) return;
    showPanel();
    if (!urlSaysOpen()) {
      try { history.pushState({ tqAnalytics: 1 }, "", urlWithPanel(true)); } catch (e) { /* ignore */ }
    }
  }

  function closePanel() {
    if (!_open) return;
    hidePanel();
    if (toggle && typeof toggle.focus === "function") toggle.focus();
    if (history.state && history.state.tqAnalytics) {
      // Step back over the entry openPanel added, so Back after a close
      // leaves the run view instead of reopening analytics.
      history.back();
      return;
    }
    try { history.replaceState(history.state, "", urlWithPanel(false)); } catch (e) { /* ignore */ }
  }

  window._tqAnalyticsSetView = setView;
  window._tqAnalyticsOpen = openPanel;
  window._tqAnalyticsClose = closePanel;

  if (toggle) {
    toggle.addEventListener("click", function () {
      if (_open) closePanel();
      else openPanel();
    });
  }
  if (closeBtn) closeBtn.addEventListener("click", function () { closePanel(); });
  // Browser Back / Forward: the URL says whether analytics is open.
  window.addEventListener("popstate", function () {
    var want = urlSaysOpen();
    if (want && !_open) showPanel();
    else if (!want && _open && hidePanel() && toggle && typeof toggle.focus === "function") toggle.focus();
  });
  frame.addEventListener("load", function () {
    if (!_open) return;
    if (status) status.hidden = true;
    if (frame.getAttribute("src")) frame.hidden = false;
  });
  window.addEventListener("message", function (e) {
    if (e.origin !== location.origin) return;
    if (!e.data || e.data.type !== "tq-flyout") return;
    if (e.data.action === "close") closePanel();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || !_open) return;
    if (isFormField(e.target)) return;
    if (document.querySelector(".keys-menu:not([hidden]), .run-menu:not([hidden])")) return;
    closePanel();
  });
  if (urlSaysOpen()) showPanel();
})();
`;
