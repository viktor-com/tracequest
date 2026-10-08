import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import { browserPage as _browserPage } from "../browser/browser-page.js";
import { compareLoadErrorPage, comparePage } from "../browser/compare-page.js";
import { chatHomePage as _chatHomePage, liveSessionPage as _liveSessionPage, runPage as _runPage } from "../browser/run-page.js";
import { available as _muxAvailable, listWindows as _listWindows } from "../mux/tmux.js";
import { agentForSource, agentSupportsResume, detectAgents as _detectAgents } from "../agents/agent-detect.js";
import { linkRunSession, readRunTombstones } from "../sessions/run-session-link.js";
import { detectLiveSessions } from "../sessions/live-sessions.js";
import { launchedRunGenerating, livePathSetFor, runGeneratingStatus } from "../sessions/run-generating-status.js";
import { sessionHash } from "../sessions/session-hash.js";
import { sessionMtimeMs } from "../sessions/session-list.js";
import { generateMarkdown } from "../export/markdown-export.js";
import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { fetchSession } from "../server/server-helpers.js";
import { send } from "../server/server-http.js";
import { isSessionPath } from "../server/server-session-path.js";
import { isImportedHostSession } from "../sessions/session-discovery-paths.js";
import { resolveSessionPathForRequest } from "../server/server-helpers.js";
import { esc, withLiveReload } from "../server/server-html-helpers.js";
import { hotModules, getInitialFilter, modVersion } from "../server/server-state.js";
import { injectCommandPalette, injectSearchCatalog } from "../browser/command-palette.js";
import { APP_SHELL_JS } from "../browser/app-chrome.js";
import { resolveSessionsAndIndex } from "./route-cache.js";
import { buildSearchCatalog, getSearchCatalog } from "./route-handlers-api.js";

async function injectLivePalette(html) {
  const href = new URL("../browser/command-palette.js", import.meta.url).href + "?v=" + modVersion();
  try {
    const mod = await import(href);
    return (mod.injectCommandPalette || injectCommandPalette)(html);
  } catch (e) {
    return injectCommandPalette(html);
  }
}

function withPaletteCatalog(html, deps, opts = {}) {
  try {
    const catalog = opts.catalog
      || (opts.sessions && opts.index ? buildSearchCatalog(opts.sessions, opts.index) : getSearchCatalog(deps, opts));
    if (!catalog) return withLiveReload(html);
    return withLiveReload(injectSearchCatalog(html, catalog));
  } catch {
    return withLiveReload(html);
  }
}

function createCaptureResponse() {
  let status = 500;
  let body = "";
  let sent = false;
  return {
    writeHead(s) {
      status = s;
    },
    end(b) {
      body = b == null ? "" : String(b);
      sent = true;
    },
    get status() {
      return status;
    },
    get body() {
      return body;
    },
    get sent() {
      return sent;
    },
  };
}

async function fetchCompareSession(url, mods, pathParam, sourceParam) {
  const handle = url.searchParams.get(pathParam);
  if (!handle) {
    return {
      error: {
        status: 400,
        message: `Missing compare parameter "${pathParam}"`,
        handle: "",
      },
    };
  }
  const capture = createCaptureResponse();
  const session = await fetchSession(url, mods.parseSession, capture, pathParam, sourceParam, mods.findSessions);
  if (session) return { session };
  return {
    error: {
      status: capture.sent ? capture.status : 500,
      message: capture.sent ? capture.body : "Unable to load session",
      handle,
    },
  };
}

function sendCompareLoadError(res, side, error) {
  const status = error.status || 500;
  send(
    res,
    status,
    withLiveReload(compareLoadErrorPage({
      side,
      handle: error.handle,
      status,
      message: error.message,
    })),
    "text/html; charset=utf-8",
  );
}

function viewLoadErrorPage({ handle = "", status = 500, message = "Unable to load session" } = {}) {
  const displayHandle = handle || "(missing)";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tracequest - session unavailable</title>
<style>
${STANDALONE_BASE_CSS}
.container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
.route-error {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 2px solid var(--red);
  border-radius: 8px;
  padding: 18px 20px;
}
.route-error-kicker {
  color: var(--fg3);
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.route-error-title {
  margin-top: 8px;
  color: var(--fg);
  font-size: 16px;
  font-weight: 600;
}
.route-error-status {
  margin-top: 10px;
  color: var(--red);
  font-family: var(--mono);
  font-size: 12px;
}
.route-error-handle {
  margin-top: 8px;
  color: var(--fg2);
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.route-error-message {
  margin-top: 10px;
  color: var(--fg2);
  font-size: 13px;
  line-height: 1.5;
}
.route-error-link {
  display: inline-block;
  margin-top: 16px;
  color: var(--accent);
  font-size: 13px;
  text-decoration: none;
}
.route-error-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="container">
  <div class="route-error" role="alert" data-view-state="error">
    <div class="route-error-kicker">session view</div>
    <div class="route-error-title">Could not load session</div>
    <div class="route-error-status">HTTP ${esc(status)}</div>
    <div class="route-error-handle">${esc(displayHandle)}</div>
    <div class="route-error-message">${esc(message || "Unable to load session")}</div>
    <a class="route-error-link" href="/">&larr; back to sessions</a>
  </div>
</div>
</body>
</html>`;
}

async function sendViewLoadError(res, url, error) {
  const status = error.status || 500;
  const handle = url.searchParams.get("path") || url.searchParams.get("id") || "";
  const html = await injectLivePalette(viewLoadErrorPage({
    handle,
    status,
    message: error.message,
  }));
  send(
    res,
    status,
    withLiveReload(html),
    "text/html; charset=utf-8",
  );
}

/**
 * GET /sessions — the previous Runs inventory (filters, table, flyout).
 * The product default is the chat surface at /; this keeps the inventory
 * reachable from the rail's "All sessions" link.
 */
export async function handleSessions(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const browserPage = mods.browserPage || _browserPage;
  const filter = url.searchParams.get("filter") || getInitialFilter() || null;
  const { sessions, index, allSessions } = resolveSessionsAndIndex(filter, mods);
  const sessionsForLive = allSessions ?? sessions;

  send(
    res,
    200,
    withPaletteCatalog(browserPage(sessions, index, filter, sessionsForLive), mods, { sessions, index }),
    "text/html; charset=utf-8",
  );
}

/**
 * Pick the chat to open on the product default: a live launched run first,
 * then an exited run still in tmux, then a live external session, then the
 * newest indexed session. Returns { type, id } or null when the corpus is empty.
 */
export function pickDefaultChatTarget(mods) {
  try {
    const muxOk = (mods.muxAvailable || _muxAvailable)();
    if (muxOk) {
      const windows = (mods.listWindows || _listWindows)() || [];
      const runs = windows.filter((w) => w.options?.tq_agent);
      runs.sort((a, b) => {
        const ar = a.dead ? 1 : 0;
        const br = b.dead ? 1 : 0;
        if (ar !== br) return ar - br;
        return Date.parse(b.options?.tq_started || 0) - Date.parse(a.options?.tq_started || 0);
      });
      if (runs[0]) return { type: "run", id: runs[0].id };
    }
  } catch {
    // mux unavailable — fall through to indexed sessions
  }

  if (typeof mods.findSessions !== "function") return null;
  const { sessions, allSessions } = resolveSessionsAndIndex(null, mods);
  const list = allSessions ?? sessions ?? [];
  let livePaths = [];
  try {
    livePaths = (mods.detectLiveSessions || detectLiveSessions)(list) || [];
  } catch {
    livePaths = [];
  }
  if (livePaths.length) {
    const liveSet = new Set(livePaths);
    const live = list.filter((s) => liveSet.has(s.path))
      .sort((a, b) => sessionMtimeMs(b) - sessionMtimeMs(a));
    if (live[0]?.path) return { type: "session", id: sessionHash(live[0].path) };
  }
  if (list[0]?.path) return { type: "session", id: sessionHash(list[0].path) };
  return null;
}

async function serveChatHome(_req, res, url, mods) {
  const id = url?.searchParams?.get("id") || "";
  const sessionHandle = url?.searchParams?.get("session") || "";
  if (sessionHandle && !id) {
    return handleRunLiveSession(res, url, mods, sessionHandle);
  }
  if (id) {
    return serveRunById(res, mods, id);
  }
  const target = pickDefaultChatTarget(mods);
  if (target?.type === "run") {
    return serveRunById(res, mods, target.id);
  }
  if (target?.type === "session") {
    return handleRunLiveSession(res, url, mods, target.id);
  }
  const chatHomePage = mods.chatHomePage || _chatHomePage;
  send(
    res,
    200,
    withPaletteCatalog(chatHomePage({ defaultCwd: mods.defaultCwd || homedir() }), mods),
    "text/html; charset=utf-8",
  );
}

/**
 * GET / — the product default is the /run chat surface (rail + conversation
 * + composer), with a session or run already opened when one exists.
 */
export async function handleIndex(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  return serveChatHome(_req, res, url, mods);
}

/**
 * GET /launch — no longer a standalone page. Launching lives in the
 * dashboard's launcher modal, so this route 302-redirects to /?launch=1
 * (which auto-opens the launcher); the route stays registered so old
 * links and bookmarks keep working.
 */
export async function handleLaunch(_req, res, _url, _deps = null) {
  send(res, 302, "", "text/html; charset=utf-8", { Location: "/?launch=1" });
}

/** A run id IS a tmux window id — "@" + digits, nothing else (see launch routes). */
const RUN_ID_RE = /^@\d+$/;

/** Error page for /run — same shape as the session view error page. */
function runLoadErrorPage({ id = "", status = 404, message = "", kicker = "run watch", title = "Could not load run" } = {}) {
  const displayId = id || "(missing)";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tracequest - run unavailable</title>
<style>
${STANDALONE_BASE_CSS}
.container { max-width: 720px; margin: 0 auto; padding: 60px 24px; }
.route-error {
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 2px solid var(--red);
  border-radius: 8px;
  padding: 18px 20px;
}
.route-error-kicker {
  color: var(--fg3);
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.route-error-title {
  margin-top: 8px;
  color: var(--fg);
  font-size: 16px;
  font-weight: 600;
}
.route-error-status {
  margin-top: 10px;
  color: var(--red);
  font-family: var(--mono);
  font-size: 12px;
}
.route-error-handle {
  margin-top: 8px;
  color: var(--fg2);
  font-family: var(--mono);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.route-error-message {
  margin-top: 10px;
  color: var(--fg2);
  font-size: 13px;
  line-height: 1.5;
}
.route-error-link {
  display: inline-block;
  margin-top: 16px;
  color: var(--accent);
  font-size: 13px;
  text-decoration: none;
}
.route-error-link:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="container">
  <div class="route-error" role="alert" data-run-state="error">
    <div class="route-error-kicker">${esc(kicker)}</div>
    <div class="route-error-title">${esc(title)}</div>
    <div class="route-error-status">HTTP ${esc(status)}</div>
    <div class="route-error-handle">${esc(displayId)}</div>
    <div class="route-error-message">${esc(message || "Unable to load run")}</div>
    <a class="route-error-link" href="/">&larr; back to sessions</a>
  </div>
</div>
</body>
</html>`;
}

/** Linked recording + detectLiveSessions bit for /run?id= SSR identity. */
function launchedRunGeneratingBit(win, windows, mods) {
  let sessionPath = null;
  try {
    const link = mods.linkRunSession || linkRunSession;
    let tombstones = [];
    try {
      tombstones = (mods.readRunTombstones || readRunTombstones)(mods);
    } catch {
      // degrade to window rivalry alone
    }
    const linked = link(win, windows, { persist: false, tombstones });
    sessionPath = linked && linked.path ? linked.path : null;
  } catch {
    sessionPath = null;
  }
  const live = sessionPath
    ? launchedRunGenerating(win.options.tq_agent, sessionPath, { pid: win.panePid }, mods)
    : false;
  return { sessionPath, live };
}

function serveRunById(res, mods, id) {
  if (!RUN_ID_RE.test(id)) {
    send(
      res,
      400,
      withLiveReload(runLoadErrorPage({ id, status: 400, message: "id must be a tmux window id like @1" })),
      "text/html; charset=utf-8",
    );
    return;
  }
  const runPage = mods.runPage || _runPage;
  const windows = (mods.listWindows || _listWindows)();
  const win = windows.find((w) => w.id === id && w.options?.tq_agent);
  if (!win) {
    send(
      res,
      404,
      withLiveReload(runLoadErrorPage({ id, status: 404, message: `no run with id ${id}` })),
      "text/html; charset=utf-8",
    );
    return;
  }
  const { sessionPath, live } = launchedRunGeneratingBit(win, windows, mods);
  const run = {
    id: win.id,
    agent: win.options.tq_agent,
    cwd: win.options.tq_cwd,
    startedAt: win.options.tq_started,
    status: runGeneratingStatus(win.dead, sessionPath, live),
    // Provenance for the "continued from <id>" header (empty when the run
    // was not started as a resume).
    resumedFrom: win.options.tq_resumed_from || null,
    // Continue gating for the exited state: only agents with a verified
    // resume mechanism ever show the affordance — honest absence otherwise.
    canResume: agentSupportsResume(win.options.tq_agent),
    // The launch/resume prompt snippet (tq_prompt): a resumed run's page
    // renders it as the pending follow-up bubble until the fork recording
    // links and delivers it for real.
    prompt: win.options.tq_prompt || null,
    sessionPath,
    live,
  };
  send(res, 200, withPaletteCatalog(runPage({ run }), mods), "text/html; charset=utf-8");
}

/**
 * GET /run?id=@N — the live watch page for one run. The id is validated
 * against the run-id grammar (400 page) and resolved against tmux windows
 * live at request time (404 page when no run window carries the id) — the
 * page itself then keeps polling /api/runs/session (chat transcript, etag
 * flow) and /api/runs/snapshot (collapsed raw terminal). The run's
 * metadata (agent, cwd, startedAt, status) is embedded server-side.
 *
 * GET /run with no id/session is the same chat home as GET /: open the
 * best available record, or the empty chat shell.
 */
export async function handleRun(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  return serveChatHome(_req, res, url, mods);
}

/**
 * The run window (if any) whose linked recording IS `sessionPath` —
 * read-only resolution (never persists a link from a page view),
 * best-effort: any mux/link failure just answers null.
 */
function runWindowForSession(sessionPath, mods) {
  if (!sessionPath) return null;
  try {
    if (!(mods.muxAvailable || _muxAvailable)()) return null;
    const windows = (mods.listWindows || _listWindows)();
    const link = mods.linkRunSession || linkRunSession;
    let tombstones = [];
    try {
      tombstones = (mods.readRunTombstones || readRunTombstones)(mods);
    } catch {
      // degrade to window rivalry alone
    }
    for (const win of windows) {
      if (!win.options || !win.options.tq_agent) continue;
      let linked;
      try {
        linked = link(win, windows, { persist: false, tombstones });
      } catch {
        continue;
      }
      if (linked && linked.path === sessionPath) return win;
    }
  } catch {
    // tmux hiccup — callers render fine without the run link
  }
  return null;
}

/**
 * True when a session of `source` can be CONTINUED as a tracequest run:
 * mux available, the source maps to a registry agent with a verified
 * resume mechanism, and that agent is detected on PATH. Best-effort —
 * any probe failure just means no Continue affordance.
 */
function sessionContinuable(source, mods) {
  try {
    if (!(mods.muxAvailable || _muxAvailable)()) return false;
    const agent = agentForSource(source);
    if (!agent || !agentSupportsResume(agent)) return false;
    return (mods.detectAgents || _detectAgents)().some((a) => a.id === agent);
  } catch {
    return false;
  }
}

/**
 * GET /run?session=<hash|path> — the read-only live watch page for a
 * session tracequest did NOT launch: the same chat transcript as a run's
 * watch page (the page polls the session-keyed /api/sessions/live), with
 * the composer replaced by an honest watch-only state. The handle shares
 * resolveSessionPathForRequest semantics with every read endpoint (400
 * missing, 403 non-session path, 404 unknown hash — answered as the run
 * error page). A session that IS some run's linked recording renders the
 * observer page too, with a cross-link into the steerable run chat.
 */
async function handleRunLiveSession(res, url, mods, handle) {
  const liveSessionPage = mods.liveSessionPage || _liveSessionPage;
  const capture = createCaptureResponse();
  const path = resolveSessionPathForRequest(handle, capture, mods.findSessions);
  if (!path) {
    const status = capture.sent ? capture.status : 500;
    send(
      res,
      status,
      withLiveReload(runLoadErrorPage({
        id: handle,
        status,
        message: capture.sent ? capture.body : "Unable to load session",
        kicker: "session watch",
        title: "Could not load session",
      })),
      "text/html; charset=utf-8",
    );
    return;
  }
  const sessions = mods.findSessions ? mods.findSessions(null) : [];
  const s = sessions.find((x) => x.path === path) || null;
  const live = livePathSetFor([path], mods).has(path);
  const runWin = runWindowForSession(path, mods);
  const page = liveSessionPage({
    session: {
      hash: sessionHash(path),
      path,
      source: s?.source || "claude",
      project: s?.project ?? null,
      live,
      run: runWin ? { id: runWin.id, status: runGeneratingStatus(runWin.dead, path, live) } : null,
      continuable: sessionContinuable(s?.source || "claude", mods),
      // The mapped agent that would resume this session — identity for the
      // continue composer's chip (null when not continuable).
      agent: agentForSource(s?.source || "claude") || null,
    },
  });
  send(res, 200, withPaletteCatalog(page, mods), "text/html; charset=utf-8");
}

/**
 * Cross-link chip for /view: when the viewed session file IS some run's
 * linked recording, a floating "open chat" chip navigates to /run?id=<id>.
 * Best-effort — any mux/link failure just means no chip.
 */
function liveRunChipFor(sessionPath, mods) {
  const win = runWindowForSession(sessionPath, mods);
  if (!win) return "";
  const generating = launchedRunGenerating(
    win.options.tq_agent,
    sessionPath,
    { pid: win.panePid },
    mods,
  );
  return viewRunChipHtml(win, runGeneratingStatus(win.dead, sessionPath, generating));
}

const VIEW_RUN_CHIP_CSS = `<style>
.view-run-chip {
  position: fixed; right: 18px; bottom: 18px; z-index: 300;
  display: inline-flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 999px;
  background: var(--surface, #1a1a1e); border: 1px solid rgba(74,222,128,0.35);
  color: var(--fg, #e8e8ea); font-family: var(--mono, monospace); font-size: 12px;
  text-decoration: none; box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  transition: border-color 0.12s;
}
.view-run-chip:hover { border-color: rgba(74,222,128,0.7); }
.view-run-chip .chip-dot {
  width: 7px; height: 7px; border-radius: 50%; background: #4ade80;
  animation: chip-pulse 2s ease-in-out infinite;
}
.view-run-chip .chip-dot[data-status="exited"],
.view-run-chip .chip-dot[data-status="idle"] { background: #8b8b92; animation: none; }
.view-run-chip[data-status="exited"],
.view-run-chip[data-status="idle"] { border-color: rgba(255,255,255,0.14); }
@keyframes chip-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
</style>
`;

/** Standalone CSS for the /view continue composer (never mentions the run chip). */
const VIEW_CONTINUE_CHIP_CSS = `<style>
.view-continue-chip {
  position: fixed; right: 18px; bottom: 18px; z-index: 300;
  display: flex; flex-direction: column; gap: 6px;
  width: 340px; max-width: calc(100vw - 36px);
  padding: 9px 10px 9px 14px; border-radius: 22px;
  background: var(--surface, #1a1a1e); border: 1px solid var(--border, rgba(255,255,255,0.12));
  color: var(--fg, #e8e8ea); font-family: var(--sans, sans-serif); font-size: 13px;
  box-shadow: 0 6px 24px rgba(0,0,0,0.35);
  transition: border-color 0.12s;
}
.view-continue-chip:focus-within { border-color: rgba(255,255,255,0.28); }
.view-continue-chip[data-busy="true"] { opacity: 0.7; }
.vc-msg { font-size: 11px; line-height: 1.45; color: #f0a070; overflow-wrap: anywhere; }
.vc-msg[hidden] { display: none; }
.vc-row { display: flex; align-items: center; gap: 8px; }
.vc-glyph { flex: none; color: var(--fg3, #6e6e76); font-size: 11px; }
.view-continue-input {
  flex: 1; min-width: 0; background: none; border: none; outline: none;
  color: var(--fg, #e8e8ea); font-family: inherit; font-size: 13px;
}
.view-continue-input::placeholder { color: var(--fg3, rgba(232,232,234,0.45)); }
.vc-send {
  flex: none; width: 24px; height: 24px; display: inline-flex;
  align-items: center; justify-content: center; border: none; border-radius: 50%;
  background: var(--fg, #e4e4e7); color: var(--bg, #111113); cursor: pointer;
}
.vc-send:hover { opacity: 0.85; }
.vc-send:disabled { opacity: 0.5; cursor: default; }
.view-continue-chip[data-mode="cwd"] { border-color: rgba(240,160,112,0.6); }
.view-continue-chip[data-mode="cwd"] .vc-glyph { color: rgba(240,160,112,0.9); }
</style>
`;

/** One generating word for both /view chips: running | idle | exited, never live. */
function viewChipStatus(status, fallback = "running") {
  return status === "exited" || status === "idle" ? status : fallback;
}

function viewChipLabel(kind, status) {
  if (status === "exited") return `${kind} exited &middot; open chat`;
  if (status === "idle") return `idle ${kind} &middot; open chat`;
  return `running ${kind} &middot; open chat`;
}

function viewCrossLinkChip({ href, extraAttrs, status, kind }) {
  const word = viewChipStatus(status);
  const statusAttr = ` data-status="${word}"`;
  return `${VIEW_RUN_CHIP_CSS}<a class="view-run-chip"${extraAttrs}${statusAttr} href="${href}"><span class="chip-dot"${statusAttr}></span>${viewChipLabel(kind, word)}</a>`;
}

function viewRunChipHtml(win, status) {
  const word = viewChipStatus(status, win.dead ? "exited" : "running");
  return viewCrossLinkChip({
    href: `/run?id=${encodeURIComponent(win.id)}`,
    extraAttrs: ` data-run-id="${esc(win.id)}"`,
    status: word,
    kind: "run",
  });
}

/**
 * Cross-link chip for /view of an EXTERNAL generating session (no run window):
 * the same floating chip and generating words as the run chip, navigating
 * to the read-only watch chat at /run?session=<hash>.
 * Best-effort: any detection failure just means no chip.
 */
function liveWatchChipFor(sessionPath, mods) {
  if (!sessionPath || !mods.findSessions) return "";
  try {
    if (!livePathSetFor([sessionPath], mods).has(sessionPath)) return "";
    const hash = sessionHash(sessionPath);
    return viewCrossLinkChip({
      href: `/run?session=${encodeURIComponent(hash)}`,
      extraAttrs: ` data-live-session="${esc(hash)}"`,
      status: "running",
      kind: "session",
    });
  } catch {
    return "";
  }
}

/**
 * Continue composer for /view: a floating mini composer whose typing IS
 * the continue — submit resumes the viewed session as a NEW tracequest run
 * (POST /api/runs {resumeSession, prompt}) and lands in the new run's chat
 * with the follow-up already delivered; an empty submit continues without
 * a message. A needs:"cwd" 400 (source directory vanished) flips the input
 * into directory-entry mode and retries with the explicit cwd. Rendered
 * ONLY when the session can actually be continued (mapped agent detected
 * with a resume mechanism, session exposes a native sessionId, mux
 * available) — honest absence otherwise. `stacked` lifts the composer
 * above a coexisting live-run/watch chip.
 */
function continueChipHtml(session, mods, { stacked = false } = {}) {
  if (!session?.sessionId || !session?.path) return "";
  if (isImportedHostSession(session)) return "";
  const source = session.source || "claude";
  if (!sessionContinuable(source, mods)) return "";
  const agent = agentForSource(source);
  const style = stacked ? ' style="bottom: 64px"' : "";
  return `${VIEW_CONTINUE_CHIP_CSS}<form class="view-continue-chip" id="continueSessionChip" data-mode="prompt" data-continue-session="${esc(session.sessionHash || "")}"${style} title="Continue this conversation as a new tracequest run (${esc(agent)} resumes it in tmux)">
  <div class="vc-msg" id="viewContinueMsg" hidden></div>
  <div class="vc-row">
    <span class="vc-glyph" id="viewContinueGlyph">&#8635;&#xFE0E;</span>
    <input class="view-continue-input" id="viewContinueInput" type="text" placeholder="Send a follow-up &mdash; continues as a new run" autocomplete="off" spellcheck="false" aria-label="Follow-up message — continues this session as a new run">
    <button class="vc-send" type="submit" id="viewContinueSend" aria-label="Continue session as a new run" title="Continue (Enter) &mdash; an empty submit continues without a message"><svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
</form>
<script>
(function () {
  var form = document.getElementById("continueSessionChip");
  if (!form) return;
  var input = document.getElementById("viewContinueInput");
  var msg = document.getElementById("viewContinueMsg");
  var sendBtn = document.getElementById("viewContinueSend");
  var pendingPrompt = "";
  function fail(text) {
    msg.textContent = text;
    msg.hidden = false;
    form.setAttribute("data-busy", "false");
    sendBtn.disabled = false;
    input.disabled = false;
  }
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (sendBtn.disabled) return;
    var body = { resumeSession: ${JSON.stringify(session.path)} };
    if (form.getAttribute("data-mode") === "cwd") {
      if (!input.value) { fail("enter an existing directory for the new run"); return; }
      body.cwd = input.value;
      if (pendingPrompt) body.prompt = pendingPrompt;
    } else if (input.value) {
      body.prompt = input.value;
    }
    sendBtn.disabled = true;
    input.disabled = true;
    form.setAttribute("data-busy", "true");
    fetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (out) {
        if (out.ok && out.d.id) {
          if (body.prompt) {
            try { sessionStorage.setItem("tq-followup:" + out.d.id, body.prompt); } catch (e) {}
          }
          window.location.href = "/run?id=" + encodeURIComponent(out.d.id);
          return;
        }
        if (out.d && out.d.needs === "cwd") {
          // Vanished-cwd recovery: keep the typed follow-up, ask for a
          // directory, retry with the explicit cwd.
          if (form.getAttribute("data-mode") !== "cwd") pendingPrompt = input.value;
          form.setAttribute("data-mode", "cwd");
          input.value = "";
          input.placeholder = "directory for the new run (the recorded one is gone)";
          fail((out.d && out.d.error) || "pick a directory for the new run");
          input.focus();
          return;
        }
        fail((out.d && out.d.error) || "continue failed");
      })
      .catch(function (e) { fail(String(e)); });
  });
})();
</script>`;
}

/** Compact the standalone /view document so it can sit inside the Runs flyout. */
export function applyViewEmbedMode(html) {
  if (!html) return html;
  let out = String(html);
  out = out.replace(/<body(\s[^>]*)?>/i, (m, attrs = "") => {
    if (/\bclass\s*=/.test(attrs)) {
      return m.replace(/class\s*=\s*(["'])([^"']*)\1/i, (_, q, cls) => {
        if (/\bembed-view\b/.test(cls)) return `class=${q}${cls}${q}`;
        return `class=${q}${cls} embed-view${q}`;
      });
    }
    return `<body class="embed-view"${attrs}>`;
  });
  const css = `<style id="embed-view-css">
body.embed-view { margin: 0; }
body.embed-view #app { max-width: none; padding: 12px 16px 28px; }
body.embed-view .header { padding: 10px 16px; margin-bottom: 10px; }
body.embed-view .header-top,
body.embed-view .header-title,
body.embed-view .header-back,
body.embed-view .header-actions,
body.embed-view .view-run-chip,
body.embed-view .view-continue-chip,
body.embed-view #cmdkOverlay,
body.embed-view .cmdk-trigger { display: none !important; }
</style>`;
  if (out.includes('id="embed-view-css"')) {
    out = out.replace(/<style id="embed-view-css">[\s\S]*?<\/style>/, css);
  } else if (out.includes("</head>")) {
    out = out.replace("</head>", `${css}\n</head>`);
  } else {
    out = css + out;
  }
  return out;
}

export async function handleView(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const capture = createCaptureResponse();
  const session = await fetchSession(url, mods.parseSession, capture, "path", "source", mods.findSessions);
  if (!session) {
    await sendViewLoadError(res, url, {
      status: capture.sent ? capture.status : 500,
      message: capture.sent ? capture.body : "Unable to load session",
    });
    return;
  }
  let html = mods.renderHTML(session);
  const embed = url.searchParams.get("embed") === "1";
  if (embed) {
    html = applyViewEmbedMode(html);
  } else {
    const liveChip = liveRunChipFor(session.path, mods) || liveWatchChipFor(session.path, mods);
    const chip = liveChip + continueChipHtml(session, mods, { stacked: Boolean(liveChip) });
    if (chip) {
      const at = html.lastIndexOf("</body>");
      html = at >= 0 ? html.slice(0, at) + chip + "\n" + html.slice(at) : html + chip;
    }
    html = await injectLivePalette(html);
    // Marks the in-app viewer (vs an exported or shared file) so it shows "← Runs".
    html = html.replace(/<html\b/, "<html data-tq-served");
    const tail = html.lastIndexOf("</body>");
    if (tail >= 0) html = html.slice(0, tail) + "<script>" + APP_SHELL_JS + "</script>\n" + html.slice(tail);
  }
  send(
    res,
    200,
    embed ? withLiveReload(html) : withPaletteCatalog(html, mods),
    "text/html; charset=utf-8",
  );
}

export async function handleExport(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const session = await fetchSession(url, mods.parseSession, res, "path", "source", mods.findSessions);
  if (!session) return;
  const html = mods.renderHTML(session);
  const id = session.sessionHash || session.sessionId?.slice(0, 8) || "session";
  const filename = `tracequest-${id}.html`;
  send(res, 200, html, "text/html; charset=utf-8", {
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

export async function handleMarkdown(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const session = await fetchSession(url, mods.parseSession, res, "path", "source", mods.findSessions);
  if (!session) return;
  const md = generateMarkdown(session);
  const id = session.sessionHash || session.sessionId?.slice(0, 8) || "session";
  const filename = `tracequest-${id}.md`;
  send(res, 200, md, "text/markdown; charset=utf-8", {
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

export async function handleRaw(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const handle = url.searchParams.get("path") || url.searchParams.get("id");
  const p = resolveSessionPathForRequest(handle, res, mods.findSessions);
  if (!p) return;
  if (p.startsWith("opencode://")) { send(res, 403, "Raw export is only available for file-backed sessions"); return; }
  if (!isSessionPath(p)) { send(res, 403, "Forbidden"); return; }
  const resolved = resolve(p);
  const filename = basename(resolved);
  const content = readFileSync(resolved);
  send(res, 200, content, "application/jsonl; charset=utf-8", {
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

export async function handleCompare(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const loadedA = await fetchCompareSession(url, mods, "a", "sa");
  if (!loadedA.session) {
    sendCompareLoadError(res, "session A", loadedA.error);
    return;
  }
  const loadedB = await fetchCompareSession(url, mods, "b", "sb");
  if (!loadedB.session) {
    sendCompareLoadError(res, "session B", loadedB.error);
    return;
  }
  const sessionA = loadedA.session;
  const sessionB = loadedB.session;
  sessionA._path = url.searchParams.get("a");
  sessionB._path = url.searchParams.get("b");
  send(res, 200, withPaletteCatalog(comparePage(sessionA, sessionB), mods), "text/html; charset=utf-8");
}
