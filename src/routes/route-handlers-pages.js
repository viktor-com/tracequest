import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename } from "node:path";
import { browserPage as _browserPage, listPageFromParams } from "../browser/browser-page.js";
import { compareLoadErrorPage, comparePage } from "../browser/compare-page.js";
import { chatHomePage as _chatHomePage, liveSessionPage as _liveSessionPage, runPage as _runPage } from "../browser/run-page.js";
import { available as _muxAvailable, listWindows as _listWindows } from "../mux/tmux.js";
import { agentForSource, agentSupportsResume, detectAgents as _detectAgents } from "../agents/agent-detect.js";
import { linkRunSession, readRunTombstones, sessionFreshnessPath } from "../sessions/run-session-link.js";
import { detectLiveSessions } from "../sessions/live-sessions.js";
import { warmLiveSessions } from "../sessions/live-sessions-async.js";
import { launchedRunGenerating, livePathSetFor, runGeneratingStatus } from "../sessions/run-generating-status.js";
import { sessionHash } from "../sessions/session-hash.js";
import { compareLiveRefreshScript, viewLiveRefreshScript } from "../render/render-live-update.js";
import { sessionListChecksum, sessionMtimeMs } from "../sessions/session-list.js";
import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { THEME_BOOT_SCRIPT, appTopHtml, appTopStaticHtml, APP_TOP_CSS, APP_SHELL_JS } from "../browser/app-chrome.js";
import { fetchSession } from "../server/server-helpers.js";
import { openCompareOffThread, openSessionOffThread, usesSessionWorkers } from "../server/session-pool.js";
import { finishSessionBody, sessionBody } from "../server/session-load.js";
import { finishedHtmlBlock, isHubMode, send, sendFile, sendFinished, sendHtmlWithTail } from "../server/server-http.js";
import { isSessionPath } from "../server/server-session-path.js";
import { isImportedHostSession } from "../sessions/session-discovery-paths.js";
import { resolveSessionPathForRequest } from "../server/server-helpers.js";
import { LIVE_RELOAD_SCRIPT, applyAppShell, applyEmbedLayout, esc, withLiveReload } from "../server/server-html-helpers.js";
import { hotModules, getInitialFilter, modVersion } from "../server/server-state.js";
import { commandPaletteServeInject, injectCommandPalette, injectSearchCatalog, mountSearchInAppTop, searchCatalogEmbedScript } from "../browser/command-palette.js";
import { resolveSessionsAndIndexAsync, sessionFinderForHandle } from "./route-cache.js";
import { attachSessionSummary } from "../sessions/session-summary.js";
import { buildSearchCatalog, getSearchCatalogAsync } from "./route-handlers-api.js";
import { launchedRuns, readRunTable, runsActiveAt } from "./route-handlers-launch.js";
import { usageLimitsForPage as _usageLimitsForPage } from "./route-handlers-usage.js";
import { fillUsageStrip } from "../browser/app-chrome.js";

// Applied with the session page in the session worker now; still exported here.
/** The flyout's /view stylesheet: the flyout header is the session's identity (fact f22). */
const VIEW_EMBED_CSS = `<style id="embed-view-css">
body.embed-view { margin: 0; }
body.embed-view #app { max-width: none; padding: 12px 16px 28px; }
body.embed-view .header { padding: 10px 16px; margin-bottom: 10px; }
body.embed-view .header-top,
body.embed-view .header-title,
body.embed-view .header-prompt,
body.embed-view .header-back,
body.embed-view .header-actions,
body.embed-view .view-run-chip,
body.embed-view .view-continue-chip,
body.embed-view #cmdkOverlay,
body.embed-view .cmdk-trigger { display: none !important; }
</style>`;

/** Compact the standalone /view document so it can sit inside the Runs flyout. */
export function applyViewEmbedMode(html) {
  return applyEmbedLayout(html, VIEW_EMBED_CSS);
}

/** Start reading the usage snapshot an app-chrome page is served with (fact hlstrip). */
function pageUsageLimits(mods) {
  return (mods.usageLimitsForPage || _usageLimitsForPage)();
}

/**
 * An app-chrome page as it looks once its scripts ran, so its first paint is
 * its final layout (fact hlstrip): the usage-limits strip filled and the
 * header search bar mounted in the app bar.
 */
async function withUsageStrip(html, mods, pending = null) {
  return mountSearchInAppTop(fillUsageStrip(html, await (pending || pageUsageLimits(mods))));
}

/** The command-palette module as the current src defines it (hot-reloaded in a dev checkout); null when it fails to load. */
async function livePaletteModule() {
  const href = new URL("../browser/command-palette.js", import.meta.url).href + "?v=" + modVersion();
  try {
    return await import(href);
  } catch {
    return null;
  }
}

async function injectLivePalette(html) {
  const mod = await livePaletteModule();
  return (mod?.injectCommandPalette || injectCommandPalette)(html);
}

/** The block injectLivePalette adds before a page's last </body> (the palette snippet and its newline). */
async function livePaletteBlock() {
  const mod = await livePaletteModule();
  return (mod?.commandPaletteServeInject || commandPaletteServeInject)() + "\n";
}

/**
 * The parts of `body` (a string, or a Buffer from a session worker) with
 * `insert` placed at `at`, the index or byte offset finishSessionBody
 * reported (-1: appended), for sendFinished; the body is never scanned here.
 */
function partsWith(body, at, insert) {
  if (at < 0) return [body, insert];
  return typeof body === "string"
    ? [body.slice(0, at), insert, body.slice(at)]
    : [body.subarray(0, at), insert, body.subarray(at)];
}

async function withPaletteCatalog(html, deps, opts = {}) {
  try {
    const catalog = opts.catalog
      || (opts.sessions && opts.index ? buildSearchCatalog(opts.sessions, opts.index) : await getSearchCatalogAsync(deps, opts));
    if (!catalog) return withLiveReload(html);
    // The catalog goes last, after every script (fact hlcatlast).
    return injectSearchCatalog(withLiveReload(html), catalog);
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

/**
 * The current global session list with a live-probe pass already run on it
 * (facts hsa1, hlv1): neither the scan nor the probes block the event loop.
 * null for injected deps without async discovery (tests keep their doubles).
 */
async function currentSessionsWarmed(mods) {
  if (!mods?.findSessions?.async) return null;
  const { sessions } = await resolveSessionsAndIndexAsync(null, mods);
  await warmLiveSessions(sessions);
  return sessions;
}

/** Synchronous finder for the view handle in `url` (path or id), resolved without blocking. */
function finderForUrl(url, mods) {
  const handle = url.searchParams.get("path") || url.searchParams.get("id") || "";
  return sessionFinderForHandle(handle, mods);
}

/**
 * Wait for a session-worker job, cancelling it when the client hangs up
 * first (fact hps3). Resolves to the worker's reply, or null once cancelled.
 */
async function awaitSessionJob(job, res) {
  const onClose = () => {
    if (!res.writableEnded) job.cancel();
  };
  res.once?.("close", onClose);
  try {
    const reply = await job.promise;
    if (reply.failed) throw new Error(`session worker: ${reply.failed}`);
    return reply;
  } catch (err) {
    if (job.isCancelled()) return null;
    return { error: String(err?.message || err) };
  } finally {
    res.off?.("close", onClose);
  }
}

/**
 * Open the recording a request names (path|id, source) and build `op`'s body
 * from it (sessionBody: "html", "data" or "markdown"), with its summary
 * attached. The handle is resolved here, on the event loop; with the server's
 * own modules the parse and the build run in a session worker (facts hps1,
 * hps4). An unknown, forbidden or unparseable recording is answered on `out`
 * as fetchSession does, and null returned (also when `res` hung up first).
 * Returns { session, body, at, palette }: the body finished for the wire by
 * finishSessionBody (hub marking and redaction, the embed layout when
 * `embed`), so the routes send it with sendFinished; from a worker `session`
 * holds only the identity fields (path, sessionId, sessionHash, source, host).
 */
async function openSessionBody(url, mods, out, op, finder, res = out, { embed = false, shell = false } = {}) {
  // The embed layout travels as its stylesheet and a served page's app shell
  // as its pieces, both applied where the body is built.
  const finish = { hub: isHubMode(), embed: embed ? VIEW_EMBED_CSS : null, shell: shell ? viewAppShell() : null };
  if (!usesSessionWorkers(mods)) {
    const session = await fetchSession(url, mods.parseSession, out, "path", "source", finder);
    if (!session) return null;
    attachSessionSummary(session);
    return { session, ...finishSessionBody(op, sessionBody(op, session, mods.renderHTML), finish) };
  }
  const handle = url.searchParams.get("path") || url.searchParams.get("id");
  const source = url.searchParams.get("source") || undefined;
  const p = resolveSessionPathForRequest(handle, out, finder);
  if (!p) return null;
  const reply = await awaitSessionJob(openSessionOffThread(op, p, source, finish), res);
  if (!reply || reply.empty) return null;
  if (reply.error != null) {
    console.error("fetchSession parse error:", p, reply.error);
    send(out, 500, "Error parsing session", "text/plain");
    return null;
  }
  return { session: reply.session, body: reply.body, at: reply.at, palette: reply.palette };
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
  const session = await fetchSession(url, mods.parseSession, capture, pathParam, sourceParam, await sessionFinderForHandle(handle, mods));
  if (session) {
    attachSessionSummary(session);
    return { session };
  }
  return {
    error: {
      status: capture.sent ? capture.status : 500,
      message: capture.sent ? capture.body : "Unable to load session",
      handle,
    },
  };
}

/** Resolve one compare handle on the event loop: { path }, or { error } (status, message, handle) for its error page. */
async function resolveCompareHandle(url, mods, param) {
  const handle = url.searchParams.get(param);
  if (!handle) return { error: { status: 400, message: `Missing compare parameter "${param}"`, handle: "" } };
  const capture = createCaptureResponse();
  const path = resolveSessionPathForRequest(handle, capture, await sessionFinderForHandle(handle, mods));
  if (path) return { path };
  return { error: { status: capture.sent ? capture.status : 500, message: capture.sent ? capture.body : "Unable to load session", handle } };
}

/**
 * /compare with both recordings parsed and the page rendered in a session
 * worker (fact hps1), answering the same errors in the same order as the
 * in-process path: side A's (unresolved, unparseable) before side B's.
 * Resolves to { html }, { side, error }, or null when the client hung up.
 */
async function compareOffThread(url, mods, res) {
  const a = await resolveCompareHandle(url, mods, "a");
  if (a.error) return { side: "session A", error: a.error };
  const b = await resolveCompareHandle(url, mods, "b");
  const sideInput = (r, param, sourceParam) => ({ path: r.path, source: url.searchParams.get(sourceParam) || undefined, label: url.searchParams.get(param) });
  const reply = await awaitSessionJob(openCompareOffThread(sideInput(a, "a", "sa"), b.path ? sideInput(b, "b", "sb") : null), res);
  if (!reply) return null;
  if (reply.needB) return { side: "session B", error: b.error };
  if (reply.body != null) return { html: reply.body };
  const side = reply.side === "b" ? "session B" : "session A";
  const handle = url.searchParams.get(reply.side === "b" ? "b" : "a");
  const path = reply.side === "b" ? b.path : a.path;
  if (reply.empty) return { side, error: { status: 500, message: "Unable to load session", handle } };
  console.error("fetchSession parse error:", path, reply.error);
  return { side, error: { status: 500, message: "Error parsing session", handle } };
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

/**
 * The one route-error shell (session view, run watch): what failed, the
 * status, the handle that failed, the server's message and a way back.
 */
const ROUTE_ERROR_CSS = `
.route-error-page { min-height: calc(100vh - var(--shell-top)); display: grid; place-items: start center; padding: 22vh var(--space-6) var(--space-8); }
.route-error { width: min(480px, 100%); display: flex; flex-direction: column; align-items: center; gap: var(--space-3); text-align: center; }
.route-error-kicker { font-size: var(--text-xs); color: var(--text-3); }
.route-error-kicker::first-letter { text-transform: uppercase; }
.route-error-title { font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: var(--weight-regular); letter-spacing: var(--track-display); color: var(--text); }
.route-error-message { font-size: var(--text-md); color: var(--text-2); line-height: var(--lh-md); }
.route-error-meta { display: inline-flex; gap: 8px; font-size: var(--text-xs); color: var(--text-3); overflow-wrap: anywhere; justify-content: center; flex-wrap: wrap; }
.route-error-status, .route-error-handle { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); }
.route-error-link {
  margin-top: var(--space-3); display: inline-flex; align-items: center; height: var(--control-md); padding: 0 16px;
  border-radius: var(--radius-pill); background: var(--ink); color: var(--paper); font-size: var(--text-sm);
}
.route-error-link:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
`;

function routeErrorDocument({ docTitle, stateAttr, kicker, title, status, handle, message }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle}</title>
${THEME_BOOT_SCRIPT}
<style>
${STANDALONE_BASE_CSS}
${APP_TOP_CSS}
${ROUTE_ERROR_CSS}
</style>
</head>
<body>
${appTopStaticHtml("runs")}
<div class="route-error-page">
  <div class="route-error" role="alert" ${stateAttr}="error">
    <div class="route-error-kicker">${esc(kicker)}</div>
    <div class="route-error-title">${esc(title)}</div>
    <div class="route-error-message">${esc(message)}</div>
    <div class="route-error-meta"><span class="route-error-handle">${esc(handle)}</span><span aria-hidden="true">·</span><span class="route-error-status">HTTP ${esc(status)}</span></div>
    <a class="route-error-link" href="/sessions">&larr; Back to Runs</a>
  </div>
</div>
</body>
</html>`;
}

function viewLoadErrorPage({ handle = "", status = 500, message = "Unable to load session" } = {}) {
  return routeErrorDocument({
    docTitle: "tracequest - session unavailable",
    stateAttr: "data-view-state",
    kicker: "session view",
    title: "Could not load session",
    status,
    handle: handle || "(missing)",
    message: message || "Unable to load session",
  });
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
  // The tmux run table is read while the session list resolves (fact hnr13),
  // and so is the usage snapshot the strip is served with (fact hlstrip).
  const runTable = readRunTable();
  const usage = pageUsageLimits(mods);
  const { sessions, index, allSessions } = await resolveSessionsAndIndexAsync(filter, mods);
  const sessionsForLive = allSessions ?? sessions;
  // Probe live sessions off-thread (fact hlv1), against the current list.
  await warmLiveSessions(sessionsForLive);
  // The runs /api/runs answers now, so the rows pinned above the list are in
  // the first paint, not inserted by the client's first poll (fact hnr13).
  const runs = await launchedRuns(null, sessionsForLive, runTable);
  const page = await withUsageStrip(
    browserPage(sessions, index, filter, sessionsForLive, listPageFromParams(url.searchParams), runs, runsActiveAt(runs)),
    mods,
    usage,
  );

  // The palette's identity catalog is embedded so Cmd+K ranks sessions on the
  // first key (fact hlcat); its script is built once per list snapshot. It
  // follows the page on the wire and in the body: the list goes out first
  // and renders while the catalog is built and sent (facts hlstream,
  // hlcatlast). ?page= / ?pageSize= pick the embedded rows (fact hnr10).
  sendHtmlWithTail(
    res,
    200,
    withLiveReload(page),
    () => catalogEmbedFor(sessions, index),
  );
}

/** sessions array -> { index, sig, tag }: the embedded catalog script per list snapshot. */
const _catalogEmbeds = new WeakMap();

/**
 * The `<script id="tq-cmdk-catalog">` element for this (session list, index)
 * snapshot, built once: identity plus a content check, since a list or index
 * changed in place is a new snapshot.
 */
function catalogEmbedFor(sessions, index) {
  const sig = `${sessions.length}:${sessionListChecksum(sessions)}:${index?.size ?? 0}`;
  const hit = _catalogEmbeds.get(sessions);
  if (hit && hit.index === index && hit.sig === sig) return hit.tag;
  const tag = searchCatalogEmbedScript(buildSearchCatalog(sessions, index));
  _catalogEmbeds.set(sessions, { index, sig, tag });
  return tag;
}

/**
 * Pick the chat to open on the product default: a live launched run first,
 * then an exited run still in tmux, then a live external session, then the
 * newest indexed session. Returns { type, id } or null when the corpus is empty.
 */
export async function pickDefaultChatTarget(mods) {
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
  const { sessions, allSessions } = await resolveSessionsAndIndexAsync(null, mods);
  const list = allSessions ?? sessions ?? [];
  if (mods.findSessions.async && !mods.detectLiveSessions) await warmLiveSessions(list);
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
  const target = await pickDefaultChatTarget(mods);
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
    await withPaletteCatalog(await withUsageStrip(chatHomePage({ defaultCwd: mods.defaultCwd || homedir() }), mods), mods),
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

/** Error page for /run — same shell as the session view error page. */
function runLoadErrorPage({ id = "", status = 404, message = "", kicker = "run watch", title = "Could not load run" } = {}) {
  return routeErrorDocument({
    docTitle: "tracequest - run unavailable",
    stateAttr: "data-run-state",
    kicker,
    title,
    status,
    handle: id || "(missing)",
    message: message || "Unable to load run",
  });
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

async function serveRunById(res, mods, id) {
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
    // An unlinked pane past its start-up window is idle (fact hlorph).
    status: runGeneratingStatus(win.dead, sessionPath, live, win.options.tq_started),
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
  send(res, 200, await withPaletteCatalog(await withUsageStrip(runPage({ run }), mods), mods), "text/html; charset=utf-8");
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
  if (isHubMode()) return false; // hub mode is read-only (fact hubro)
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
  const finder = await sessionFinderForHandle(handle, mods);
  const path = resolveSessionPathForRequest(handle, capture, finder);
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
  const sessions = (await currentSessionsWarmed(mods)) || (finder ? finder(null) : []);
  const s = sessions.find((x) => x.path === path) || null;
  const live = livePathSetFor([path], { ...mods, findSessions: () => sessions }).has(path);
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
    // Hub mode is read-only (fact hubwt): the live tail offers no follow-up or Stop.
    readOnly: isHubMode(),
  });
  // Like /view, a session's watch page embeds no palette catalog: the palette
  // fetches it when it is opened.
  send(res, 200, withLiveReload(await withUsageStrip(page, mods)), "text/html; charset=utf-8");
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
  position: fixed; right: var(--space-5, 20px); bottom: var(--space-5, 20px); z-index: var(--z-popover, 200);
  display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 16px 0 14px;
  border-radius: var(--radius-pill); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  color: var(--text); font-size: var(--text-sm, 13px); text-decoration: none;
  transition: background var(--dur-2, 160ms) var(--ease-out, ease);
}
.view-run-chip:hover { background: var(--surface-3); }
.view-run-chip .chip-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok); animation: ui-pulse 2.2s var(--ease-out, ease) infinite; }
.view-run-chip .chip-dot[data-status="exited"],
.view-run-chip .chip-dot[data-status="idle"] { background: var(--text-4); animation: none; }
@media print { .view-run-chip { display: none !important; } }
</style>
`;

/** Standalone CSS for the /view continue composer (never mentions the run chip). */
const VIEW_CONTINUE_CHIP_CSS = `<style>
.view-continue-chip {
  position: fixed; right: var(--space-5, 20px); bottom: var(--space-5, 20px); z-index: var(--z-popover, 200);
  display: flex; flex-direction: column; gap: 6px; width: 380px; max-width: calc(100vw - 40px);
  padding: 6px 6px 6px 16px; border-radius: var(--radius-xl); background: var(--surface-pop); box-shadow: var(--shadow-pop);
  color: var(--text); font-size: var(--text-sm, 13px);
  transition: box-shadow var(--dur-2, 160ms) var(--ease-out, ease);
}
.view-continue-chip:focus-within { box-shadow: var(--shadow-pop), 0 0 0 1px var(--focus); }
.view-continue-chip[data-busy="true"] { opacity: 0.7; }
.vc-msg { font-size: var(--text-xs, 12px); line-height: 1.45; color: var(--warn); overflow-wrap: anywhere; padding-top: 6px; }
.vc-msg[hidden] { display: none; }
.vc-row { display: flex; align-items: center; gap: 8px; }
.vc-glyph { flex: none; color: var(--text-3); font-size: 11px; }
.view-continue-input { flex: 1; min-width: 0; height: 30px; background: none; border: 0; outline: none; color: var(--text); font: inherit; }
.view-continue-input::placeholder { color: var(--text-3); }
.vc-send {
  flex: none; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center;
  border: 0; border-radius: var(--radius-pill); background: var(--ink); color: var(--paper); cursor: pointer;
}
.vc-send:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.vc-send:disabled { opacity: 0.4; cursor: default; }
.view-continue-chip[data-mode="cwd"] { box-shadow: var(--shadow-pop), 0 0 0 1px var(--warn); }
.view-continue-chip[data-mode="cwd"] .vc-glyph { color: var(--warn); }
@media print { .view-continue-chip { display: none !important; } }
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

/** Freshness etag (mtimeMs-size) of the recording a view handle names; "" when unknown. */
function viewEtagFor(url, finder, param = null) {
  const handle = param
    ? url.searchParams.get(param) || ""
    : url.searchParams.get("path") || url.searchParams.get("id") || "";
  const path = resolveSessionPathForRequest(handle, createCaptureResponse(), finder);
  if (!path) return { path: null, etag: "" };
  try {
    const st = statSync(sessionFreshnessPath(path));
    return { path, etag: `${Math.floor(st.mtimeMs)}-${st.size}` };
  } catch {
    return { path, etag: "" };
  }
}

/**
 * GET /api/view-session?path|id=<handle>[&source=][&etag=] (fact hnr2): the
 * viewer's session data plus the recording's freshness etag, or
 * {etag, unchanged: true} when the caller already has this version.
 */
export async function handleApiViewSession(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const finder = await finderForUrl(url, mods);
  // Stat BEFORE parsing: a write racing the parse leaves the etag older than
  // the data, which only costs one extra refresh, never a missed one.
  const { path, etag } = viewEtagFor(url, finder);
  if (path && etag && url.searchParams.get("etag") === etag) {
    send(res, 200, JSON.stringify({ etag, unchanged: true }), "application/json; charset=utf-8");
    return;
  }
  // check=1: the caller only asks whether the recording changed (compare page).
  if (path && url.searchParams.get("check") === "1") {
    send(res, 200, JSON.stringify({ etag, unchanged: false }), "application/json; charset=utf-8");
    return;
  }
  const capture = createCaptureResponse();
  const opened = await openSessionBody(url, mods, capture, "data", finder, res);
  if (!opened) {
    if (res.destroyed) return;
    send(res, capture.sent ? capture.status : 500, JSON.stringify({ error: capture.sent ? capture.body : "Unable to load session" }), "application/json; charset=utf-8");
    return;
  }
  // The viewer JSON comes serialized (and in hub mode redacted) from the
  // build (fact hps1); this is exactly JSON.stringify({ etag, session }).
  const ct = "application/json; charset=utf-8";
  if (opened.body === undefined) {
    send(res, 200, JSON.stringify({ etag }), ct);
    return;
  }
  sendFinished(res, 200, [`{"etag":${JSON.stringify(etag)},"session":`, opened.body, "}"], ct);
}


/**
 * The served session viewer wears the app shell (top bar, section nav,
 * theme) and is marked data-tq-served so the document shows "← Runs".
 * Exported and shared files are rendered without either.
 */
function viewAppShell() {
  return {
    head: `${THEME_BOOT_SCRIPT}\n<style id="tq-app-shell">${APP_TOP_CSS}\nbody { padding-top: 0; }</style>`,
    top: appTopHtml({ crumbHtml: '<span class="app-crumb">Run</span>', nav: "runs" }),
    // New run here opens the launcher on the Runs page.
    script: `<script>${APP_SHELL_JS}\n(function(){var b=document.getElementById("newRunBtn");if(b)b.addEventListener("click",function(){location.href="/?launch=1";});})();</script>`,
  };
}

export function withViewAppShell(html) {
  return applyAppShell(html, viewAppShell());
}

export async function handleView(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const capture = createCaptureResponse();
  const finder = await finderForUrl(url, mods);
  const { etag } = viewEtagFor(url, finder);
  // Live chips need the current list and a probe pass: both run off-thread
  // while the session parses (facts hsa1, hlv1).
  const embed = url.searchParams.get("embed") === "1";
  const liveList = embed ? null : currentSessionsWarmed(mods).catch(() => null);
  const opened = await openSessionBody(url, mods, capture, "html", finder, res, { embed, shell: !embed });
  if (!opened) {
    if (res.destroyed) return;
    await sendViewLoadError(res, url, {
      status: capture.sent ? capture.status : 500,
      message: capture.sent ? capture.body : "Unable to load session",
    });
    return;
  }
  const { session } = opened;
  // Everything this request adds goes before the page's last </body>, built
  // as one small block: the page itself (finished in the session worker,
  // embed layout included) is never scanned or rewritten here (fact hps1).
  // In-place refresher for this recording (fact hnr3): the page never reloads.
  let block = viewLiveRefreshScript(etag) + "\n";
  if (!embed) {
    // Live chips consult the session list and the process probes: answer both
    // without blocking the event loop (facts hsa1, hlv1). A recording copied
    // from another machine is never generating here: it needs neither.
    let liveChip = "";
    if (!isImportedHostSession(session)) {
      const sessions = await liveList;
      const chipMods = sessions ? { ...mods, findSessions: () => sessions } : mods;
      liveChip = liveRunChipFor(session.path, chipMods) || liveWatchChipFor(session.path, chipMods);
    }
    const chip = liveChip + continueChipHtml(session, mods, { stacked: Boolean(liveChip) });
    if (chip) block += chip + "\n";
    block = finishedHtmlBlock(block);
    if (!opened.palette) block += finishedHtmlBlock(await livePaletteBlock());
  } else {
    block = finishedHtmlBlock(block);
  }
  // No embedded palette catalog: it is an inventory of every session, built by
  // walking the whole tree, and the palette fetches it when it is opened.
  block += finishedHtmlBlock(LIVE_RELOAD_SCRIPT);
  sendFinished(res, 200, partsWith(opened.body, opened.at, block), "text/html; charset=utf-8");
}

export async function handleExport(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const opened = await openSessionBody(url, mods, res, "html", await finderForUrl(url, mods));
  if (!opened) return;
  const { session, body: html } = opened;
  const id = session.sessionHash || session.sessionId?.slice(0, 8) || "session";
  const filename = `tracequest-${id}.html`;
  sendFinished(res, 200, html, "text/html; charset=utf-8", {
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

export async function handleMarkdown(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const opened = await openSessionBody(url, mods, res, "markdown", await finderForUrl(url, mods));
  if (!opened) return;
  const { session, body: md } = opened;
  const id = session.sessionHash || session.sessionId?.slice(0, 8) || "session";
  const filename = `tracequest-${id}.md`;
  sendFinished(res, 200, md, "text/markdown; charset=utf-8", {
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

export async function handleRaw(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  const handle = url.searchParams.get("path") || url.searchParams.get("id");
  const p = resolveSessionPathForRequest(handle, res, await sessionFinderForHandle(handle, mods));
  if (!p) return;
  if (p.startsWith("opencode://")) { send(res, 403, "Raw export is only available for file-backed sessions"); return; }
  if (!isSessionPath(p)) { send(res, 403, "Forbidden"); return; }
  const resolved = resolve(p);
  const filename = basename(resolved);
  // Never read on the event loop: a recording can be hundreds of MB (fact hrd2).
  await sendFile(res, 200, resolved, "application/jsonl; charset=utf-8", {
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
}

export async function handleCompare(_req, res, url, _deps = null) {
  const mods = _deps || await hotModules();
  // Stat both recordings before parsing (see handleApiViewSession).
  const etagA = viewEtagFor(url, await sessionFinderForHandle(url.searchParams.get("a") || "", mods), "a").etag;
  const etagB = viewEtagFor(url, await sessionFinderForHandle(url.searchParams.get("b") || "", mods), "b").etag;
  let html;
  if (usesSessionWorkers(mods)) {
    const compared = await compareOffThread(url, mods, res);
    if (!compared) return;
    if (compared.error) {
      sendCompareLoadError(res, compared.side, compared.error);
      return;
    }
    html = compared.html;
  } else {
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
    html = comparePage(sessionA, sessionB);
  }
  const at = html.lastIndexOf("</body>");
  const refresher = compareLiveRefreshScript(etagA, etagB);
  html = at >= 0 ? html.slice(0, at) + refresher + "\n" + html.slice(at) : html + refresher;
  send(res, 200, await withPaletteCatalog(html, mods), "text/html; charset=utf-8");
}
