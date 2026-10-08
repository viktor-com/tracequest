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
/* --- New run button (dashboard header) --- */
.new-run-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--accent);
  color: #111;
  border: none;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  font-family: var(--sans);
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
  white-space: nowrap;
}
.new-run-btn:hover { opacity: 0.85; }

/* --- Launcher modal --- */
.launch-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  z-index: 400;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 12vh 16px 16px;
}
.launch-overlay[hidden] { display: none; }
.launch-modal {
  width: 100%;
  max-width: 460px;
  background: var(--surface);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  padding: 14px 18px 16px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
}
.launch-modal-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.launch-modal-title {
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--fg3);
}
.launch-close {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--fg3);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 5px;
  transition: color 0.12s, background 0.12s;
}
.launch-close:hover { color: var(--fg); background: var(--surface2); }
.launch-mono { font-family: var(--mono); }

.launch-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.launch-label {
  font-size: 11px;
  color: var(--fg3);
  font-family: var(--mono);
  text-transform: uppercase;
  letter-spacing: 0.3px;
}
.launch-select, .launch-input, .launch-textarea {
  background: var(--surface2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--fg);
  font-family: var(--mono);
  font-size: 12px;
  padding: 6px 8px;
  outline: none;
  transition: border-color 0.15s;
}
.launch-select:focus, .launch-input:focus, .launch-textarea:focus { border-color: var(--accent); }
.launch-select:disabled { opacity: 0.4; }
.launch-textarea { font-family: var(--sans); font-size: 13px; resize: vertical; }
.launch-agents-empty { font-size: 11px; color: var(--orange); font-family: var(--mono); }
.launch-agents-empty[hidden] { display: none; }
.launch-actions { display: flex; align-items: center; gap: 10px; }
.launch-start {
  background: var(--accent);
  color: #111;
  border: none;
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 13px;
  font-family: var(--sans);
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.12s;
}
.launch-start:hover { opacity: 0.85; }
.launch-start:disabled { opacity: 0.4; cursor: default; }
.launch-hint { font-size: 11px; color: var(--fg3); }
.launch-error { color: var(--red); font-size: 12px; font-family: var(--mono); overflow-wrap: anywhere; }
.launch-error[hidden] { display: none; }

.launch-nomux {
  border-left: 2px solid var(--orange);
  padding: 4px 12px;
}
.launch-nomux[hidden] { display: none; }
.launch-nomux-title { color: var(--fg); font-size: 14px; font-weight: 600; }
.launch-nomux-message { margin-top: 8px; color: var(--fg2); font-size: 13px; line-height: 1.5; }
`;

/**
 * The launcher modal markup, embedded once in the dashboard page. All
 * dynamic content (agents, mux state, default cwd) is filled client-side
 * from /api/agents and the init payload, so the markup itself is static.
 */
export const LAUNCHER_MODAL_HTML = `<div class="launch-overlay" id="launchOverlay" hidden>
  <div class="launch-modal" role="dialog" aria-modal="true" aria-labelledby="launchTitle">
    <div class="launch-modal-head">
      <div class="launch-modal-title" id="launchTitle">Start a run</div>
      <button class="launch-close" id="launchClose" type="button" aria-label="Close launcher">&times;</button>
    </div>
    <form id="launchForm" data-launch-state="form">
      <div class="launch-field">
        <label class="launch-label" for="agentSelect">agent</label>
        <select class="launch-select" id="agentSelect"></select>
        <div class="launch-agents-empty" id="agentsEmpty" hidden>no agents detected on PATH</div>
      </div>
      <div class="launch-field">
        <label class="launch-label" for="cwdInput">cwd</label>
        <input class="launch-input" id="cwdInput" type="text" placeholder="/path/to/project" spellcheck="false">
      </div>
      <div class="launch-field">
        <label class="launch-label" for="promptInput">prompt</label>
        <textarea class="launch-textarea" id="promptInput" rows="3" placeholder="optional initial prompt" spellcheck="false"></textarea>
      </div>
      <div class="launch-actions">
        <button class="launch-start" id="startBtn" type="submit">Start</button>
        <div class="launch-hint">opens the run chat</div>
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
