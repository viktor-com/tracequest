/**
 * Right-hand analytics panel for an opened chat/run.
 *
 * The /run conversation (and its session rail) stay on screen; this
 * inspector docks on the right and embeds the existing /view evidence
 * (grade, timeline, tiles, errors, charts, chapters) via ?embed=1.
 */

import { FORM_FIELD_GUARD_SRC } from "./is-form-field.js";

export const ANALYTICS_PANEL_CSS = `
/* --- Run analytics panel (RHS inspector; chat + rail stay) --- */
html { --run-analytics-width: min(620px, 46vw); }
.run-analytics-toggle {
  color: var(--fg3);
  font-size: 12px;
  font-family: var(--mono);
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 3px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.run-analytics-toggle:hover,
.run-analytics-toggle[aria-expanded="true"] {
  color: var(--fg);
  border-color: rgba(255,255,255,0.16);
  background: var(--surface2);
}
.run-analytics {
  width: var(--run-analytics-width);
  flex: 0 0 var(--run-analytics-width);
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  border-left: 1px solid var(--border);
  box-shadow: -16px 0 40px rgba(0,0,0,0.28);
}
.run-analytics[hidden] { display: none !important; }
.run-analytics-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  border-left: 2px solid var(--accent);
  flex-shrink: 0;
}
.run-analytics-ident { min-width: 0; }
.run-analytics-kicker {
  font-size: 10px;
  font-family: var(--mono);
  font-weight: 600;
  letter-spacing: 0.45px;
  text-transform: uppercase;
  color: var(--fg3);
}
.run-analytics-title {
  margin: 2px 0 0;
  font-size: 14px;
  font-weight: 600;
  font-family: var(--mono);
  color: var(--fg);
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-analytics-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.run-analytics-open {
  font-size: 11px;
  font-family: var(--mono);
  color: var(--fg2);
  text-decoration: none;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  white-space: nowrap;
}
.run-analytics-open:hover { color: var(--fg); border-color: rgba(255,255,255,0.14); }
.run-analytics-close {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  background: none;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg2);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
}
.run-analytics-close:hover { color: var(--fg); background: var(--surface2); }
.run-analytics-status,
.run-analytics-empty {
  padding: 16px 18px;
  font-size: 12px;
  font-family: var(--mono);
  color: var(--fg3);
  line-height: 1.45;
}
.run-analytics-status[hidden],
.run-analytics-empty[hidden] { display: none; }
.run-analytics-frame {
  flex: 1;
  width: 100%;
  border: 0;
  background: var(--bg);
  min-height: 0;
}
.run-analytics-frame[hidden] { display: none; }
body.analytics-open .chat-output-pane { display: none !important; }
@media (max-width: 1100px) {
  html { --run-analytics-width: min(460px, 48vw); }
}
`;

export const ANALYTICS_PANEL_HTML = `<aside id="runAnalytics" class="run-analytics" hidden aria-hidden="true" aria-label="Run analytics">
  <header class="run-analytics-head">
    <div class="run-analytics-ident">
      <span class="run-analytics-kicker">Analytics</span>
      <h2 class="run-analytics-title" id="runAnalyticsTitle">this run</h2>
    </div>
    <div class="run-analytics-actions">
      <a class="run-analytics-open" id="runAnalyticsOpen" href="/view">Open full page</a>
      <button type="button" class="run-analytics-close" id="runAnalyticsClose" aria-label="Close analytics">&#215;</button>
    </div>
  </header>
  <div class="run-analytics-status" id="runAnalyticsStatus" hidden>Loading analytics&#8230;</div>
  <div class="run-analytics-empty" id="runAnalyticsEmpty" hidden>Recording not linked yet — analytics appear once this run has a session.</div>
  <iframe class="run-analytics-frame" id="runAnalyticsFrame" title="Run analytics" hidden></iframe>
</aside>`;

export const ANALYTICS_TOGGLE_HTML = `<button type="button" class="run-analytics-toggle" id="analyticsToggle" aria-expanded="false" aria-controls="runAnalytics" title="Show analytics for this run">analytics</button>`;

/** Client script: open/close the RHS /view embed without leaving chat. */
export const ANALYTICS_PANEL_JS = `
(function bindRunAnalytics() {
  ${FORM_FIELD_GUARD_SRC}
  var panel = document.getElementById("runAnalytics");
  var frame = document.getElementById("runAnalyticsFrame");
  var status = document.getElementById("runAnalyticsStatus");
  var empty = document.getElementById("runAnalyticsEmpty");
  var openLink = document.getElementById("runAnalyticsOpen");
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
      u.searchParams.set("embed", "1");
      return u.pathname + u.search;
    } catch (e) { return ""; }
  }

  function persist(open) {
    try {
      var params = new URLSearchParams(location.search);
      if (open) params.set("analytics", "1");
      else params.delete("analytics");
      var qs = params.toString();
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : ""));
    } catch (e) { /* ignore */ }
  }

  function setView(href, label) {
    _src = href || "";
    if (openLink && _src) openLink.href = _src;
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

  function openPanel() {
    _open = true;
    document.body.classList.add("analytics-open");
    panel.hidden = false;
    panel.setAttribute("aria-hidden", "false");
    if (toggle) toggle.setAttribute("aria-expanded", "true");
    if (!_src && viewLink && viewLink.getAttribute("href")) {
      setView(viewLink.href, viewLink.getAttribute("data-analytics-label") || "");
    }
    loadFrame();
    persist(true);
  }

  function closePanel() {
    _open = false;
    document.body.classList.remove("analytics-open");
    panel.hidden = true;
    panel.setAttribute("aria-hidden", "true");
    if (toggle) toggle.setAttribute("aria-expanded", "false");
    persist(false);
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
  if (viewLink) {
    viewLink.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      e.preventDefault();
      if (viewLink.href) setView(viewLink.href);
      openPanel();
    });
  }
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
  try {
    if (new URLSearchParams(location.search).get("analytics") === "1") openPanel();
  } catch (e) { /* ignore */ }
})();
`;
