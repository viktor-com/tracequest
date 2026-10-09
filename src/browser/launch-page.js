import { OVERLAY_FOCUS_SRC } from "./overlay-focus.js";

/**
 * Launcher fragments — starting a Run is native to the dashboard.
 *
 * /launch is no longer a standalone page (the route 302-redirects to
 * /?launch=1). This module exports the pieces the dashboard page embeds:
 * the launcher modal markup (agent dropdown, cwd input, optional prompt,
 * Start button, inline error, no-agents and missing-multiplexer states),
 * its CSS, and the client script that drives it — fetching /api/agents on
 * open, guarding double-submit while POST /api/runs is in flight, and
 * navigating straight into the run's chat at /run?id=<id> on success.
 * A ?launch=1 query on the dashboard auto-opens the launcher.
 */

export const LAUNCHER_MODAL_CSS = `
/* ---- New run launcher (the run "settings": agent, folder, prompt) ---- */
.launch-overlay {
  position: fixed; inset: 0; z-index: var(--z-dialog);
  display: flex; align-items: flex-start; justify-content: center; padding: 12vh 16px 16px;
  background: var(--scrim); backdrop-filter: blur(3px);
  animation: ui-fade-in var(--dur-2) var(--ease-out);
}
.launch-overlay[hidden] { display: none; }
.launch-modal {
  width: min(560px, 100%); background: var(--surface-pop); border-radius: var(--radius-xl);
  box-shadow: var(--shadow-pop); overflow: hidden; animation: ui-pop-in var(--dur-3) var(--ease-out);
}
.launch-modal-head { display: flex; align-items: flex-start; gap: var(--space-3); padding: 22px 22px 6px; }
.launch-modal-title { font-size: var(--text-xl); line-height: var(--lh-xl); letter-spacing: var(--track-tight); }
.launch-modal-sub { font-size: var(--text-sm); color: var(--text-3); margin-top: 2px; }
.launch-close {
  margin-left: auto; width: var(--control-md); height: var(--control-md); border-radius: var(--radius-pill);
  display: grid; place-items: center; color: var(--text-3); font-size: 18px; line-height: 1;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.launch-close:hover { background: var(--hover); color: var(--text); }
#launchForm { display: flex; flex-direction: column; gap: var(--space-4); padding: 14px 22px 0; }
.launch-row { display: grid; grid-template-columns: 180px 1fr; gap: var(--space-3); }
.launch-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.launch-label { font-size: var(--text-xs); color: var(--text-2); }
.launch-select, .launch-input, .launch-textarea {
  width: 100%; border: 0; outline: none; color: var(--text); font-size: var(--text-sm);
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2);
  transition: box-shadow var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.launch-select, .launch-input { height: var(--control-lg); padding: 0 12px; border-radius: var(--radius-md); }
.launch-select {
  -webkit-appearance: none; appearance: none; padding-right: 30px; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m4.5 6.5 3.5 3.5 3.5-3.5'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 10px center; background-size: 14px;
}
.launch-input { font-family: var(--font-mono); font-size: 12.5px; }
.launch-textarea {
  min-height: 112px; padding: 12px; border-radius: var(--radius-md); resize: vertical;
  font-family: var(--font-sans); line-height: var(--lh-sm);
}
.launch-select:hover, .launch-input:hover, .launch-textarea:hover { box-shadow: inset 0 0 0 1px var(--line-3); }
.launch-select:focus, .launch-input:focus, .launch-textarea:focus { box-shadow: inset 0 0 0 1px var(--focus); background-color: var(--surface-2); }
.launch-select::placeholder, .launch-input::placeholder, .launch-textarea::placeholder { color: var(--text-3); }
.launch-agents-empty { font-size: var(--text-xs); color: var(--warn); }
.launch-actions {
  display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;
  margin: 6px -22px 0; padding: 14px 22px; box-shadow: inset 0 1px 0 var(--line-1); background: var(--surface-1);
}
.launch-hint { font-size: var(--text-xs); color: var(--text-3); display: inline-flex; align-items: center; gap: 6px; }
.launch-hint kbd {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: var(--radius-xs); font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-2);
}
.launch-start {
  order: 3; margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
  height: var(--control-md); padding: 0 16px; border-radius: var(--radius-pill);
  background: var(--ink); color: var(--paper); font-size: var(--text-sm);
  transition: background var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out);
}
.launch-start:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.launch-start:disabled { opacity: 0.45; cursor: default; }
.launch-error { flex-basis: 100%; order: 4; font-size: var(--text-xs); color: var(--bad); }
.launch-error[hidden] { display: none; }
.launch-nomux { margin: 14px 22px 22px; padding: 14px 16px; border-radius: var(--radius-md); background: var(--warn-soft); }
.launch-nomux[hidden] { display: none; }
.launch-nomux-title { font-size: var(--text-sm); color: var(--text); margin-bottom: 4px; }
.launch-nomux-message { font-size: var(--text-xs); color: var(--text-2); line-height: var(--lh-xs); }
.launch-mono { font-family: var(--font-mono); }
@media (max-width: 560px) { .launch-row { grid-template-columns: 1fr; } }
`;

/**
 * The launcher modal markup, embedded once in the dashboard page. All
 * dynamic content (agents, mux state, default cwd) is filled client-side
 * from /api/agents and the init payload, so the markup itself is static.
 */
export const LAUNCHER_MODAL_HTML = `<div class="launch-overlay" id="launchOverlay" hidden>
  <div class="launch-modal" role="dialog" aria-modal="true" aria-labelledby="launchTitle">
    <div class="launch-modal-head">
      <div>
        <div class="launch-modal-title" id="launchTitle">Start a run</div>
        <div class="launch-modal-sub">Starts the agent in a terminal tracequest manages, then opens its chat.</div>
      </div>
      <button class="launch-close" id="launchClose" type="button" aria-label="Close launcher">&times;</button>
    </div>
    <form id="launchForm" data-launch-state="form">
      <div class="launch-row">
        <div class="launch-field">
          <label class="launch-label" for="agentSelect">Agent</label>
          <select class="launch-select" id="agentSelect"></select>
          <div class="launch-agents-empty" id="agentsEmpty" hidden>no agents detected on PATH</div>
        </div>
        <div class="launch-field">
          <label class="launch-label" for="cwdInput">Folder</label>
          <input class="launch-input" id="cwdInput" type="text" placeholder="/path/to/project" spellcheck="false">
        </div>
      </div>
      <div class="launch-field">
        <label class="launch-label" for="promptInput">Prompt</label>
        <textarea class="launch-textarea" id="promptInput" rows="4" placeholder="optional initial prompt — what should the agent do?" spellcheck="false"></textarea>
      </div>
      <div class="launch-actions">
        <div class="launch-hint"><kbd>⌘</kbd><kbd>↵</kbd> to start · <kbd>esc</kbd> to close</div>
        <button class="launch-start" id="startBtn" type="submit">Start</button>
        <div class="launch-error" id="launchError" role="alert" hidden></div>
      </div>
    </form>
    <div class="launch-nomux" role="alert" data-launch-state="no-mux" id="launchNoMux" hidden>
      <div class="launch-nomux-title">Multiplexer unavailable</div>
      <div class="launch-nomux-message">tmux was not found on this system. Install tmux and restart <span class="launch-mono">tracequest serve</span> to start and manage runs.</div>
    </div>
  </div>
</div>`;

/**
 * Client script for the launcher modal (a dashboard bundle part; runs
 * after the init head, so _INIT_DATA is in scope for defaultCwd).
 */
export const LAUNCHER_CLIENT_JS = `
/* --- launcher modal: start a run without leaving the dashboard --- */
(function () {
  ${OVERLAY_FOCUS_SRC}
  var launchOverlay = document.getElementById('launchOverlay');
  var newRunBtn = document.getElementById('newRunBtn');
  if (!launchOverlay || !newRunBtn) return;
  var launchPrevFocus = null;
  var launchFormEl = document.getElementById('launchForm');
  var launchNoMux = document.getElementById('launchNoMux');
  var agentSelect = document.getElementById('agentSelect');
  var agentsEmpty = document.getElementById('agentsEmpty');
  var cwdInput = document.getElementById('cwdInput');
  var promptInput = document.getElementById('promptInput');
  var startBtn = document.getElementById('startBtn');
  var launchError = document.getElementById('launchError');
  var launchClose = document.getElementById('launchClose');

  function showLaunchError(message) {
    launchError.textContent = message;
    launchError.hidden = false;
  }
  function clearLaunchError() {
    launchError.hidden = true;
    launchError.textContent = '';
  }
  async function readLaunchError(res) {
    try {
      var data = await res.json();
      if (data && data.error) return data.error;
    } catch (e) {}
    return 'HTTP ' + res.status;
  }

  /** Refresh mux state + detected agents each time the launcher opens. */
  async function loadLauncher() {
    try {
      var res = await fetch('/api/agents');
      if (!res.ok) { showLaunchError(await readLaunchError(res)); return; }
      var data = await res.json();
      if (!data.mux || !data.mux.available) {
        launchFormEl.hidden = true;
        launchNoMux.hidden = false;
        return;
      }
      launchFormEl.hidden = false;
      launchNoMux.hidden = true;
      var agents = data.agents || [];
      var current = agentSelect.value;
      agentSelect.innerHTML = agents.map(function (a) {
        return '<option value="' + escH(a.id) + '">' + escH(a.id) + '</option>';
      }).join('');
      if (agents.some(function (a) { return a.id === current; })) agentSelect.value = current;
      agentSelect.disabled = !agents.length;
      startBtn.disabled = !agents.length;
      agentsEmpty.hidden = !!agents.length;
    } catch (e) {
      showLaunchError(String(e));
    }
  }

  function openLauncher() {
    if (!launchOverlay.hidden) {
      focusOverlay(launchOverlay, launchFormEl.hidden ? launchClose : promptInput);
      return;
    }
    launchPrevFocus = overlayPrevFocus(launchOverlay);
    if (!launchPrevFocus) launchPrevFocus = document.activeElement;
    launchOverlay.hidden = false;
    pushOverlay(launchOverlay);
    clearLaunchError();
    if (!cwdInput.value) {
      var remembered = null;
      try { remembered = localStorage.getItem('tq-launch-cwd'); } catch (e) {}
      cwdInput.value = remembered || _INIT_DATA.defaultCwd || '';
    }
    focusOverlay(launchOverlay, promptInput);
    loadLauncher().then(function () {
      if (launchOverlay.hidden) return;
      if (!launchFormEl.hidden) focusOverlay(launchOverlay, promptInput);
      else focusOverlay(launchOverlay, launchClose);
    });
  }
  function closeLauncher() {
    if (launchOverlay.hidden) return;
    launchOverlay.hidden = true;
    popOverlay(launchOverlay);
    restoreOverlayFocus(launchPrevFocus, launchOverlay);
    launchPrevFocus = null;
  }
  newRunBtn.addEventListener('click', openLauncher);
  launchClose.addEventListener('click', closeLauncher);
  launchOverlay.addEventListener('click', function (e) {
    if (e.target === launchOverlay) closeLauncher();
  });
  document.addEventListener('keydown', function (e) {
    if (launchOverlay.hidden || !isTopOverlay(launchOverlay)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      closeLauncher();
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      var go = document.getElementById('startBtn');
      if (go && !go.disabled) go.click();
      return;
    }
    if (e.key === 'Tab') trapOverlayTab(e, launchOverlay);
  }, true);
  window.openLauncher = openLauncher;

  // In-flight guard: while POST /api/runs is pending the Start button is
  // disabled and re-entry suppressed, so double-clicking (or Enter spam)
  // can never start duplicate runs.
  var startInFlight = false;
  launchFormEl.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (startInFlight) return;
    startInFlight = true;
    startBtn.disabled = true;
    clearLaunchError();
    var body = { agent: agentSelect.value, cwd: cwdInput.value.trim() };
    var prompt = promptInput.value;
    if (prompt) body.prompt = prompt;
    try {
      var res = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) { showLaunchError(await readLaunchError(res)); return; }
      var data = await res.json();
      try { localStorage.setItem('tq-launch-cwd', body.cwd); } catch (e) {}
      // Straight into the run's chat — launching IS opening a conversation.
      window.location.href = '/run?id=' + encodeURIComponent(data.id);
    } catch (e) {
      showLaunchError(String(e));
    } finally {
      startInFlight = false;
      startBtn.disabled = false;
    }
  });

  // Deep link: /?launch=1 (the /launch redirect target) auto-opens.
  if (new URLSearchParams(window.location.search).get('launch') === '1') openLauncher();
})();
`;
