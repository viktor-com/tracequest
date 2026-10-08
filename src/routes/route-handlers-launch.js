/**
 * Launch feature routes — multiplexer status, launchable agents, runs.
 * Never route-cached: mux/PATH/run state must be answered live.
 *
 * Mutating endpoints share one guard chain in deterministic order:
 *   1. method  — POST only, otherwise 405 (no side effects)
 *   2. Host    — localhost/127.0.0.1/[::1] only, otherwise 403 (DNS-rebinding
 *                guard: these routes start and control local processes)
 *   3. body    — JSON object under BODY_LIMIT_BYTES, otherwise 400/413
 *   4. payload — allowlisted detected agent + existing cwd dir, otherwise 400
 */
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { send } from "../server/server-http.js";
import {
  available,
  capturePane,
  ensureSession,
  killWindow,
  listWindows,
  newWindow,
  sendKeys,
  tmuxSession,
} from "../mux/tmux.js";
import {
  agentForSource,
  agentSupportsResume,
  agentSupportsSessionId,
  buildLaunchArgv,
  buildResumeArgv,
  detectAgents,
  resolveAgentBinary,
} from "../agents/agent-detect.js";
import { ansiToHtml } from "../render/ansi-html.js";
import {
  linkRunSession,
  readRunTombstones,
  recordRunTombstone,
  sessionFreshnessPath,
  syncRunLedger,
} from "../sessions/run-session-link.js";
import { parseSession } from "../parse/index.js";
import { peekSession } from "../sessions/session-peek.js";
import { buildSessionChapters } from "../chapters/session-chapters.js";
import { resolveSessionPathForRequest } from "../server/server-helpers.js";
import { sourceForSessionPath } from "../server/server-session-path.js";
import { isImportedHostSession } from "../sessions/session-discovery-paths.js";
import { detectLiveSessions } from "../sessions/live-sessions.js";
import { launchedRunGenerating, runGeneratingStatus } from "../sessions/run-generating-status.js";
import { sessionHash } from "../sessions/session-hash.js";
import { hotModules } from "../server/server-state.js";

/** A run id IS a tmux window id — "@" + digits, nothing else. */
const RUN_ID_RE = /^@\d+$/;

/** Request bodies larger than this are rejected before parsing. */
export const BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Prompts larger than this (UTF-8 bytes) are rejected with 400 BEFORE any
 * tmux call — tmux respawn-window rejects command lines much over ~16KB
 * ("command too long"), which the 64KB body cap alone would admit.
 */
export const PROMPT_LIMIT_BYTES = 8192;

/**
 * C0 control characters that may never travel to a spawn: everything
 * below 0x20 except \t (0x09) and \n (0x0a). A NUL would make
 * execFileSync throw (ERR_INVALID_ARG_VALUE) and the rest have no
 * legitimate place in a prompt or input text.
 */
const FORBIDDEN_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f]/;

/**
 * JSON error response helper — every launch error body is {error}.
 * `extra` merges additional machine-readable fields into the body (e.g.
 * {needs: "cwd"} so UI surfaces can offer targeted recovery instead of
 * parsing prose).
 */
function sendError(res, status, message, extra = null) {
  send(res, status, JSON.stringify({ error: message, ...(extra || {}) }), "application/json; charset=utf-8");
}

/** JSON success response helper. */
function sendJson(res, data) {
  send(res, 200, JSON.stringify(data), "application/json; charset=utf-8");
}

/**
 * True when the request's Host header names localhost, 127.0.0.1, or [::1]
 * (an optional :port is ignored). A missing or foreign hostname fails — the
 * DNS-rebinding/CSRF guard for endpoints that start local processes.
 */
export function hostIsLocal(req) {
  const host = req?.headers?.host;
  if (typeof host !== "string" || host.length === 0) return false;
  let hostname;
  try {
    // URL applies the bracket/port grammar for us ([::1]:7777, localhost:7777).
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return false;
  }
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Read and parse the request body as a JSON object, capped at
 * BODY_LIMIT_BYTES. Returns {body} on success or {errorStatus, errorMessage}
 * — the repo's first JSON request-body reader, shared by every mutating
 * launch endpoint.
 */
export async function readJsonBody(req, { limitBytes = BODY_LIMIT_BYTES } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > limitBytes) {
      return { errorStatus: 413, errorMessage: "request body too large" };
    }
    chunks.push(buf);
  }
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return { errorStatus: 400, errorMessage: "request body must be valid JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { errorStatus: 400, errorMessage: "request body must be a JSON object" };
  }
  return { body: parsed };
}

/**
 * Shared guard prologue for mutating launch endpoints: 405 on non-POST,
 * 403 on non-localhost Host, then the JSON body (400/413 on bad body).
 * Answers the response itself and returns null when a guard fails.
 */
async function guardMutating(req, res) {
  if (req?.method !== "POST") {
    sendError(res, 405, "method not allowed — use POST");
    return null;
  }
  if (!hostIsLocal(req)) {
    sendError(res, 403, "forbidden — launch endpoints accept localhost requests only");
    return null;
  }
  const { body, errorStatus, errorMessage } = await readJsonBody(req);
  if (!body) {
    sendError(res, errorStatus, errorMessage);
    return null;
  }
  return body;
}

/** Activity/outcome lines are clipped to one glanceable row. */
const ACTIVITY_MAX = 140;

/** Collapse text to a single clipped line (null when empty). */
function activitySnippet(text) {
  const line = String(text || "").replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > ACTIVITY_MAX ? `${line.slice(0, ACTIVITY_MAX - 1)}…` : line;
}

/** Last path segment for activity lines ("/a/b/c.js" -> "c.js"). */
function activityBasename(p) {
  return String(p || "").split("/").filter(Boolean).pop() || "";
}

/**
 * One human line for an in-progress tool call ("Running npm test",
 * "Editing docs.js"). The unified session summarizes tc.input to a STRING
 * (command for Bash, file path for Read/Edit/Write, "pattern path" for
 * Grep) — see summarizeInput in parse-enrich.
 */
function describeToolCall(tc) {
  const input = String(tc.input || "").trim();
  switch (tc.name) {
    case "Bash": {
      const cmd = input.split("\n")[0].trim();
      return cmd ? `Running ${cmd}` : "Running a command";
    }
    case "Edit":
      return input ? `Editing ${activityBasename(input)}` : "Editing a file";
    case "Write":
      return input ? `Writing ${activityBasename(input)}` : "Writing a file";
    case "Read":
      return input ? `Reading ${activityBasename(input)}` : "Reading a file";
    case "Grep":
    case "Glob":
      return input ? `Searching ${input}` : "Searching the codebase";
    default:
      return `Running ${tc.name}`;
  }
}

/**
 * The run's "what it's doing now" line, derived from its unified session:
 * a live run whose newest assistant turn has a tool call without a result
 * reads as that in-progress action ("Running npm test", "Editing docs.js");
 * otherwise (and always for exited runs) the last assistant text becomes the
 * outcome snippet — the same glanceable line Cursor shows per agent row.
 * Null when the session has no assistant activity yet.
 */
export function runActivityLine(session, dead) {
  const events = session?.events || [];
  if (!events.length) return null;
  if (!dead) {
    const resolved = new Set();
    for (const e of events) {
      if (e.type === "tool_result" && e.toolUseId) resolved.add(e.toolUseId);
    }
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "assistant") {
        const calls = e.toolCalls || [];
        for (let j = calls.length - 1; j >= 0; j--) {
          const tc = calls[j];
          if (tc.id && !resolved.has(tc.id)) return activitySnippet(describeToolCall(tc));
        }
        break;
      }
      if (e.type === "user") break;
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "assistant" && e.text) return activitySnippet(e.text);
  }
  return null;
}

/**
 * Activity line for a linked run, through the parsed-session memo (one stat
 * per poll while the recording is idle). Any failure degrades to null —
 * the list must answer even when a recording vanishes mid-request.
 */
function runActivityFor(linkedPath, dead, deps, source) {
  if (!linkedPath) return null;
  const statImpl = deps.statSync || statSync;
  try {
    const st = statImpl(sessionFreshnessPath(linkedPath));
    const etag = `${Math.floor(st.mtimeMs)}-${st.size}`;
    return runActivityLine(parsedRunSession(linkedPath, etag, deps, source).session, dead);
  } catch {
    return null;
  }
}

/**
 * Origin-agnostic "what it's doing now" line for ANY live session recording
 * — the EXACT derivation a launched run's row gets (runActivityLine over the
 * parsed unified session, through the same etag-keyed parse memo, one stat
 * per call while the recording is idle). /api/sessions annotates every
 * detected live session with this, so an externally started agent renders
 * the identical activity line a tracequest-launched run does — origin never
 * decides the anatomy. The session's discovered source picks the parser;
 * any failure degrades to null exactly like a run's line.
 */
export function liveSessionActivity(path, source, deps = {}) {
  return runActivityFor(path, false, deps, source);
}

/**
 * Dismissed-run tombstones for this request — read ONCE per request and
 * handed to every linkRunSession call, so a poll's window loop costs one
 * tmux read. Any failure degrades to [] (links then lean on window rivalry
 * alone, exactly the pre-tombstone behavior).
 *
 * When the caller hands in the window list it already fetched, the run
 * LEDGER is reconciled first (syncRunLedger): run windows that vanished
 * WITHOUT passing through POST /api/runs/kill (tmux kill-window/prefix-&)
 * get their tombstones SYNTHESIZED from the ledger diff before this poll
 * links anything — a window's death outside the API can never launder its
 * recording into a survivor. Callers that stub the tmux layer (tests) opt
 * in via deps.syncRunLedger — syncing stubbed windows into a real tmux
 * server would corrupt real run state.
 */
function syncLedgerBestEffort(deps, windows = null) {
  try {
    const sync =
      deps.syncRunLedger ??
      (deps.listWindows || deps.readRunTombstones || deps.getSessionOption ? null : syncRunLedger);
    if (!sync) return;
    sync(windows ?? (deps.listWindows || listWindows)(), deps);
  } catch {
    // ledger trouble must never break the request
  }
}

function runTombstonesFor(deps, windows = null) {
  if (windows) syncLedgerBestEffort(deps, windows);
  try {
    return (deps.readRunTombstones || readRunTombstones)(deps);
  } catch {
    return [];
  }
}

/** Link a window to its session recording; a resolver failure degrades to pending. */
function linkedSessionFor(win, windows, deps, tombstones = undefined) {
  const link = deps.linkRunSession || linkRunSession;
  try {
    return link(win, windows, { tombstones });
  } catch (err) {
    console.error(`run session link failed for ${win.id}:`, err.message);
    return { path: null, link: "pending", attribution: null };
  }
}

/**
 * Map tmux windows to runs: only windows carrying tq_agent count. Each run
 * carries its run↔session link state (sessionPath/link/state), the launch
 * prompt (tq_prompt, so a pending run has identity before any recording
 * exists), and its live activity/outcome line — everything the dashboard
 * needs to render the run as one first-class session-list row.
 */
function runsFromWindows(windows, deps = {}) {
  const tombstones = runTombstonesFor(deps, windows);
  const staged = [];
  for (const w of windows) {
    if (!w.options || !w.options.tq_agent) continue;
    staged.push({ w, linked: linkedSessionFor(w, windows, deps, tombstones) });
  }
  const runs = [];
  for (const { w, linked } of staged) {
    const generating = launchedRunGenerating(
      w.options.tq_agent,
      linked.path,
      { pid: w.panePid },
      deps,
    );
    const status = runGeneratingStatus(w.dead, linked.path, generating);
    runs.push({
      id: w.id,
      agent: w.options.tq_agent,
      cwd: w.options.tq_cwd,
      prompt: w.options.tq_prompt || null,
      startedAt: w.options.tq_started,
      status,
      resumedFrom: w.options.tq_resumed_from || null,
      sessionPath: linked.path,
      link: linked.link,
      attribution: linked.attribution ?? null,
      state: status,
      activity: runActivityFor(linked.path, w.dead, deps),
    });
  }
  return runs;
}

/**
 * /api/runs — method-dispatched (the route map never inspects methods):
 * GET lists runs, POST creates one, anything else answers 405.
 */
export async function handleApiRuns(req, res, url, _deps = null) {
  if (req?.method === "GET") return handleApiRunsList(req, res, url, _deps);
  return handleApiRunsCreate(req, res, url, _deps);
}

/**
 * GET /api/runs → { runs: [{id, agent, cwd, startedAt, status, state}] }.
 * status/state is the generating word (running|idle|exited), never
 * tmux-alive as running. All run identity lives in tmux (windows + @tq_*
 * user options), so the list survives serve restarts and answers [] when
 * tmux/session is absent.
 */
async function handleApiRunsList(_req, res, _url, _deps = null) {
  const deps = _deps || {};
  const windows = (deps.listWindows || listWindows)();
  sendJson(res, { runs: runsFromWindows(windows, deps) });
}

/**
 * POST /api/runs {agent, cwd, prompt?} → { id } (the tmux window id).
 * Launches the detected agent's registry argv in a new window of the
 * tracequest session with remain-on-exit and @tq_* metadata. The agent
 * binary is resolved to an ABSOLUTE path in this process because the tmux
 * server does not share serve's PATH.
 */
async function handleApiRunsCreate(req, res, _url, _deps = null) {
  const deps = _deps || {};
  const body = await guardMutating(req, res);
  if (!body) return;

  const muxAvailable = (deps.muxAvailable || available)();
  if (!muxAvailable) {
    return sendError(res, 503, "multiplexer unavailable — tmux is not installed");
  }

  // Resume mode: a body carrying resumeSession continues an EXISTING
  // session as a NEW run instead of starting a fresh conversation.
  if (body.resumeSession !== undefined) {
    return createResumedRun(res, body, deps);
  }

  const { agent, cwd } = body;
  const prompt = typeof body.prompt === "string" && body.prompt.length > 0 ? body.prompt : null;
  const detected = (deps.detectAgents || detectAgents)();
  if (typeof agent !== "string" || !detected.some((a) => a.id === agent)) {
    return sendError(res, 400, "agent must be a detected launchable agent");
  }
  if (typeof cwd !== "string" || cwd.includes("\u0000") || !isDirectory(cwd, deps)) {
    return sendError(res, 400, "cwd must be an existing directory");
  }
  if (prompt && Buffer.byteLength(prompt, "utf8") > PROMPT_LIMIT_BYTES) {
    return sendError(res, 400, "prompt too long (max 8192 bytes)");
  }
  if (prompt && FORBIDDEN_CONTROL_RE.test(prompt)) {
    return sendError(res, 400, "prompt must not contain control characters (newline and tab excepted)");
  }

  // Spawn-time session identity: for agents whose CLI accepts a session
  // UUID (claude/grok --session-id), generate one HERE and hand it to the
  // agent — it names its recording after the uuid, so run↔session
  // attribution is deterministic before the first byte is written. The
  // uuid is persisted as @tq_session_id below; the linker then only ever
  // serves that recording for this run.
  const sessionId = agentSupportsSessionId(agent) ? (deps.randomUUID || randomUUID)() : null;
  const argv = buildLaunchArgv(agent, prompt, { sessionId });
  const binary = (deps.resolveAgentBinary || resolveAgentBinary)(argv[0]);
  if (!binary) {
    return sendError(res, 400, "agent binary is no longer resolvable on PATH");
  }
  argv[0] = binary;

  // The tmux transport can still fail (e.g. a wedged server); a spawn
  // failure must answer the uniform 500 JSON {error}, never the generic
  // plaintext handler-error path.
  let id;
  try {
    (deps.ensureSession || ensureSession)();
    id = (deps.newWindow || newWindow)({
      argv,
      cwd,
      name: agent,
      userOptions: {
        tq_agent: agent,
        tq_cwd: cwd,
        tq_started: new Date().toISOString(),
        // The spawn-assigned session uuid — the run's recording identity,
        // persisted in tmux so it survives serve restarts.
        ...(sessionId ? { tq_session_id: sessionId } : {}),
        // Single-line display copy so a run row has identity from second
        // zero, before the agent writes any recording. tmux list parsing is
        // line-based, so newlines/tabs are collapsed here at the source.
        ...(prompt ? { tq_prompt: activitySnippet(prompt) } : {}),
      },
    });
  } catch (err) {
    return sendError(res, 500, `failed to start run: ${errorMessage(err)}`);
  }
  // Enter the new run into the persisted ledger NOW — a window killed
  // directly in tmux before the first poll must still leave a tombstone.
  syncLedgerBestEffort(deps);
  sendJson(res, { id });
}

/** One-line message for an unexpected tmux failure. */
function errorMessage(err) {
  return String((err && err.message) || err).split("\n")[0];
}

/** Prompt validation shared by create and resume modes (null = fine). */
function promptProblem(prompt) {
  if (!prompt) return null;
  if (Buffer.byteLength(prompt, "utf8") > PROMPT_LIMIT_BYTES) {
    return "prompt too long (max 8192 bytes)";
  }
  if (FORBIDDEN_CONTROL_RE.test(prompt)) {
    return "prompt must not contain control characters (newline and tab excepted)";
  }
  return null;
}

/** Minimal response shim capturing what resolveSessionPathForRequest sends. */
function captureResponse() {
  return {
    status: 500,
    body: "",
    sent: false,
    writeHead(s) {
      this.status = s;
    },
    end(b) {
      this.body = b == null ? "" : String(b);
      this.sent = true;
    },
  };
}

/**
 * POST /api/runs resume mode — {resumeSession: <hash|path>, agent?, cwd?,
 * prompt?} → { id, resumedFrom }. Continues an EXISTING session as a NEW
 * run: the handle resolves with the exact read-endpoint semantics
 * (resolveSessionPathForRequest — 400 missing, 403 non-session path, 404
 * unknown hash, 409 ambiguous) re-emitted as launch-style JSON {error}
 * bodies; the agent defaults to the source's mapped registry agent and must
 * own a resume mechanism (checked BEFORE PATH detection so the 400 honestly
 * names the missing mechanism, not the missing binary); the source session
 * is parsed for its native sessionId (the value the agent's resume flag
 * takes — 400 when it exposes none); cwd defaults to the source session's
 * recorded cwd (explicit body cwd overrides). claude/grok resumes mint a
 * fresh fork uuid (--session-id, persisted as @tq_session_id) so the
 * resumed run's recording identity is deterministic by construction; other
 * agents fall to the existing probe/heuristic attribution tiers. The source
 * hash is persisted as @tq_resumed_from — provenance for "continued from"
 * displays, surviving serve restarts like every run option.
 */
async function createResumedRun(res, body, deps) {
  const handle = body.resumeSession;
  if (typeof handle !== "string" || handle.length === 0) {
    return sendError(res, 400, "resumeSession must be a session hash or path");
  }
  // Session discovery/parsing come from the hot module registry when the
  // caller did not inject them (tests inject; serve resolves live).
  let mods = deps;
  if (!mods.findSessions || !mods.parseSession) mods = { ...(await hotModules()), ...deps };

  const capture = captureResponse();
  const path = resolveSessionPathForRequest(handle, capture, mods.findSessions);
  if (!path) {
    return sendError(
      res,
      capture.sent ? capture.status : 500,
      capture.sent ? capture.body : "unable to resolve the session to continue",
    );
  }
  const sessions = mods.findSessions ? mods.findSessions(null) : [];
  const discovered = sessions.find((x) => x.path === path);
  if (isImportedHostSession(discovered || path)) {
    return sendError(
      res,
      400,
      "imported sessions cannot be continued — they are recordings from another machine",
    );
  }
  // A path discovery has not indexed yet (a recording written seconds ago,
  // or one under a root the current index run missed) must NOT default to
  // the claude dialect: sourceForSessionPath derives the source from the
  // agent root the recording lives under, exactly like GET
  // /api/sessions/live (fact clsc). Resuming a fresh .cursor recording
  // would otherwise pick claude's resume mechanism and 400.
  const source = discovered?.source || sourceForSessionPath(path);

  let agent = body.agent;
  if (agent !== undefined && typeof agent !== "string") {
    return sendError(res, 400, "agent must be a registry agent id");
  }
  if (!agent) {
    agent = agentForSource(source);
    if (!agent) {
      return sendError(
        res,
        400,
        `sessions from source "${source}" cannot be continued — no agent has a resume mechanism for them`,
      );
    }
  }
  if (!agentSupportsResume(agent)) {
    return sendError(
      res,
      400,
      `agent "${agent}" has no resume mechanism — this session cannot be continued`,
    );
  }
  const detected = (deps.detectAgents || detectAgents)();
  if (!detected.some((a) => a.id === agent)) {
    return sendError(res, 400, "agent must be a detected launchable agent");
  }

  let parsed;
  try {
    parsed = await mods.parseSession(path, source);
  } catch (err) {
    return sendError(res, 500, `failed to parse source session: ${errorMessage(err)}`);
  }
  const resumeId = parsed?.sessionId;
  if (typeof resumeId !== "string" || resumeId.length === 0) {
    return sendError(res, 400, "source session exposes no session id — it cannot be resumed");
  }

  let cwd = body.cwd;
  if (cwd !== undefined) {
    if (typeof cwd !== "string" || cwd.includes("\u0000") || !isDirectory(cwd, deps)) {
      return sendError(res, 400, "cwd must be an existing directory", { needs: "cwd" });
    }
  } else {
    cwd = typeof parsed?.cwd === "string" ? parsed.cwd : "";
    if (!cwd || !isDirectory(cwd, deps)) {
      // needs:"cwd" lets continue affordances offer an inline directory
      // prompt (vanished-cwd recovery) instead of a dead error — the API
      // accepts an explicit cwd either way.
      return sendError(res, 400, "cwd could not be derived from the source session — pass cwd explicitly", {
        needs: "cwd",
      });
    }
  }

  const prompt = typeof body.prompt === "string" && body.prompt.length > 0 ? body.prompt : null;
  const promptErr = promptProblem(prompt);
  if (promptErr) return sendError(res, 400, promptErr);

  const sessionId = agentSupportsSessionId(agent) ? (deps.randomUUID || randomUUID)() : null;
  const argv = buildResumeArgv(agent, resumeId, { sessionId, prompt });
  const binary = (deps.resolveAgentBinary || resolveAgentBinary)(argv[0]);
  if (!binary) {
    return sendError(res, 400, "agent binary is no longer resolvable on PATH");
  }
  argv[0] = binary;

  const resumedFrom = sessionHash(path);
  // The resumed run's CONTENT identity: its fork recording opens with the
  // SOURCE conversation's first user message, so that message (persisted
  // as tq_fork_prompt, same single-line clipping as tq_prompt) lets the
  // linker recognize the fork — and disown it from rivals — for agents
  // without a spawn-identity mechanism. Best-effort: a source that yields
  // no first prompt simply leaves the option unset (the linker then leans
  // on the tq_resumed_path source fallback alone).
  let forkPrompt = null;
  try {
    const peek = deps.peekSession || peekSession;
    forkPrompt = activitySnippet(peek({ path, size: null, source })?.firstPrompt ?? null);
  } catch {
    forkPrompt = null;
  }
  let id;
  try {
    (deps.ensureSession || ensureSession)();
    id = (deps.newWindow || newWindow)({
      argv,
      cwd,
      name: agent,
      userOptions: {
        tq_agent: agent,
        tq_cwd: cwd,
        tq_started: new Date().toISOString(),
        // Provenance: the continued session's hash, persisted in tmux so
        // the run's chat can show "continued from <id>" across restarts.
        tq_resumed_from: resumedFrom,
        // The source recording PATH — attribution evidence: a resumed run
        // whose agent continues IN the source recording links it once its
        // freshness moves inside the run's lifetime (source fallback).
        tq_resumed_path: path,
        ...(forkPrompt ? { tq_fork_prompt: forkPrompt } : {}),
        ...(sessionId ? { tq_session_id: sessionId } : {}),
        ...(prompt ? { tq_prompt: activitySnippet(prompt) } : {}),
      },
    });
  } catch (err) {
    return sendError(res, 500, `failed to start run: ${errorMessage(err)}`);
  }
  // Enter the fork run into the persisted ledger NOW — a window killed
  // directly in tmux before the first poll must still leave a tombstone.
  syncLedgerBestEffort(deps);
  sendJson(res, { id, resumedFrom });
}

/** Find the run window for `id` — only windows carrying tq_agent count. */
function findRunWindow(id, deps) {
  const windows = (deps.listWindows || listWindows)();
  return windows.find((w) => w.id === id && w.options?.tq_agent) || null;
}

/**
 * GET /api/runs/snapshot?id=@N → { status: "running"|"idle"|"exited", html }.
 * A plain GET route (never route-cached — every ~600ms poll captures the
 * pane live). The html is the SGR-to-HTML conversion of capture-pane -e:
 * the visible viewport for a live pane, full history for a dead one so
 * the final output (and tmux's dead-pane state) stays readable. status is
 * the generating word (same as GET /api/runs), never tmux-alive as running.
 * A malformed id answers 400; an id naming no run window answers 404.
 */
export async function handleApiRunsSnapshot(_req, res, url, _deps = null) {
  const deps = _deps || {};
  const id = url?.searchParams?.get("id") || "";
  if (!RUN_ID_RE.test(id)) {
    return sendError(res, 400, "id must be a tmux window id like @1");
  }
  const windows = (deps.listWindows || listWindows)();
  const run = windows.find((w) => w.id === id && w.options?.tq_agent) || null;
  if (!run) {
    return sendError(res, 404, `no run with id ${id}`);
  }
  const raw = (deps.capturePane || capturePane)(id, { withHistory: run.dead });
  let sessionPath = null;
  if (!run.dead) {
    try {
      sessionPath = linkedSessionFor(run, windows, deps, runTombstonesFor(deps, windows)).path;
    } catch {
      sessionPath = null;
    }
  }
  const generating = sessionPath
    ? launchedRunGenerating(run.options.tq_agent, sessionPath, { pid: run.panePid }, deps)
    : false;
  sendJson(res, {
    status: runGeneratingStatus(run.dead, sessionPath, generating),
    html: ansiToHtml(raw),
  });
}

/**
 * Parsed-session memo for /api/runs/session: reparse only when the etag
 * (mtimeMs-size) moved, so ~1s polls of an idle run cost one stat. Keyed by
 * path with a small LRU cap — serve may follow a handful of runs at once.
 */
const _runSessionMemo = new Map();
const RUN_SESSION_MEMO_MAX = 16;

/** Reset the parsed-session memo (tests only). */
export function clearRunSessionMemo() {
  _runSessionMemo.clear();
}

function parsedRunSession(path, etag, deps, source) {
  const hit = _runSessionMemo.get(path);
  if (hit && hit.etag === etag) return hit;
  const parse = deps.parseSession || parseSession;
  const chaptersOf = deps.buildSessionChapters || buildSessionChapters;
  // Live/run chat shows turn bodies in full (fact clft): the default
  // parse caps assistant at 500 and tool_result at 1000.
  const session = parse(path, source, { full: true });
  const entry = { etag, session, chapters: chaptersOf(session) };
  _runSessionMemo.delete(path);
  _runSessionMemo.set(path, entry);
  if (_runSessionMemo.size > RUN_SESSION_MEMO_MAX) {
    _runSessionMemo.delete(_runSessionMemo.keys().next().value);
  }
  return entry;
}

/**
 * GET /api/runs/session?id=@N[&etag=<etag>] → the run's live unified
 * session. A plain GET route, never route-cached — every poll re-links and
 * re-stats so a chat page sees new events within one poll interval.
 *
 * Body: { run, state, link, attribution, sessionPath, etag, session,
 * chapters } where
 * - run    is the same {id, agent, cwd, startedAt, status} as GET /api/runs
 *          (status is the generating word, never tmux-alive as running)
 * - link   is "pending" (agent has not written a recording yet, or none is
 *          attributable) or "linked"
 * - attribution is "sid" (spawn identity: the run's launcher-generated
 *          session uuid named the recording — deterministic, sticky), "pid"
 *          (the recording is held open by THIS run's own process tree —
 *          identity, sticky), "prompt" (content identity: the recording's
 *          first user message is THIS run's persisted launch prompt and no
 *          other run's — dead or alive; re-validated every poll) or
 *          "heuristic" (an uncontested birth-time match, re-validated
 *          every poll while the run lives), null while pending
 * - state  equals run.status: "running" | "idle" | "exited" (running only
 *          while generating — never merely because sessionPath exists, and
 *          never a sidecar live vs running split)
 * - etag   is the recording's freshness marker (mtimeMs-size); a request
 *          repeating the current etag answers {unchanged: true} without a
 *          session body, so pollers pay for parsing only when the file grew
 * - session/chapters are tracequest's unified representation — the parsed
 *   Session (events/stats) of the file the agent process itself writes,
 *   plus its chapter structure
 * A malformed id answers 400; an id naming no run window answers 404; the
 * linked recording vanishing mid-request degrades to link "pending".
 */
export async function handleApiRunsSession(_req, res, url, _deps = null) {
  const deps = _deps || {};
  const id = url?.searchParams?.get("id") || "";
  if (!RUN_ID_RE.test(id)) {
    return sendError(res, 400, "id must be a tmux window id like @1");
  }
  const windows = (deps.listWindows || listWindows)();
  const win = windows.find((w) => w.id === id && w.options?.tq_agent) || null;
  if (!win) {
    return sendError(res, 404, `no run with id ${id}`);
  }
  const runBase = {
    id: win.id,
    agent: win.options.tq_agent,
    cwd: win.options.tq_cwd,
    startedAt: win.options.tq_started,
    resumedFrom: win.options.tq_resumed_from || null,
  };

  const linked = linkedSessionFor(win, windows, deps, runTombstonesFor(deps, windows));
  const pendingBody = () => {
    const status = runGeneratingStatus(win.dead, null);
    return {
      run: { ...runBase, status },
      state: status,
      link: "pending",
      attribution: null,
      sessionPath: null,
      etag: null,
      session: null,
      chapters: null,
    };
  };
  if (!linked.path) return sendJson(res, pendingBody());

  const statImpl = deps.statSync || statSync;
  let st;
  try {
    st = statImpl(sessionFreshnessPath(linked.path));
  } catch {
    // Recording vanished between link and stat — answer pending, not 500.
    return sendJson(res, pendingBody());
  }
  const etag = `${Math.floor(st.mtimeMs)}-${st.size}`;
  const generating = launchedRunGenerating(
    win.options.tq_agent,
    linked.path,
    { pid: win.panePid },
    deps,
  );
  const status = runGeneratingStatus(win.dead, linked.path, generating);
  const run = { ...runBase, status };
  if (url.searchParams.get("etag") === etag) {
    return sendJson(res, {
      run,
      state: status,
      link: "linked",
      attribution: linked.attribution ?? null,
      sessionPath: linked.path,
      etag,
      unchanged: true,
      session: null,
      chapters: null,
    });
  }
  let entry;
  try {
    entry = parsedRunSession(linked.path, etag, deps);
  } catch (err) {
    return sendError(res, 500, `failed to parse run session: ${errorMessage(err)}`);
  }
  sendJson(res, {
    run,
    state: status,
    link: "linked",
    attribution: linked.attribution ?? null,
    sessionPath: linked.path,
    etag,
    session: entry.session,
    chapters: entry.chapters,
  });
}

/**
 * POST /api/runs/kill {id} → { ok: true }. Guard chain shared with the
 * other mutating endpoints (405/403/400/413), then: malformed id 400,
 * unknown id 404 WITHOUT touching tmux state, otherwise the run's window
 * is killed — for running and exited runs alike (killing is also how a
 * finished remain-on-exit window is dismissed). BEFORE the window dies its
 * attribution facts are tombstoned at the tmux session level
 * (recordRunTombstone), so the dismissed run's claim on its recording
 * outlives the window — a surviving rival can never inherit the dismissed
 * run's transcript just because its contest evidence was dismissed.
 */
export async function handleApiRunsKill(req, res, _url, _deps = null) {
  const deps = _deps || {};
  const body = await guardMutating(req, res);
  if (!body) return;
  const id = typeof body.id === "string" ? body.id : "";
  if (!RUN_ID_RE.test(id)) {
    return sendError(res, 400, "id must be a tmux window id like @1");
  }
  const windows = (deps.listWindows || listWindows)();
  const run = windows.find((w) => w.id === id && w.options?.tq_agent) || null;
  if (!run) {
    return sendError(res, 404, `no run with id ${id}`);
  }
  // Tombstone first — once the window is gone there is nothing left to
  // read. Best-effort: a failed tombstone must not block the user's
  // dismissal (the kill itself would fail on the same wedged tmux anyway).
  // The window list feeds relevance-based compaction: a routine dismissal
  // must never evict a stone another run's contest still leans on.
  try {
    (deps.recordRunTombstone || recordRunTombstone)(run, deps, { windows });
  } catch (err) {
    console.error(`run tombstone failed for ${id}:`, err.message);
  }
  // TOCTOU guard: the window can vanish between the check and the kill —
  // re-check in the catch so a vanished window answers 404 JSON and any
  // other tmux failure answers 500 JSON, never the plaintext 500.
  try {
    (deps.killWindow || killWindow)(id);
  } catch (err) {
    if (!findRunWindow(id, deps)) {
      return sendError(res, 404, `no run with id ${id}`);
    }
    return sendError(res, 500, `failed to kill run: ${errorMessage(err)}`);
  }
  sendJson(res, { ok: true });
}

/**
 * The ONLY special keys /api/runs/input forwards — a server-side allowlist,
 * never a passthrough of arbitrary tmux key syntax.
 */
export const INPUT_KEYS = ["Enter", "C-c", "Escape", "Up", "Down", "Tab"];

/**
 * POST /api/runs/input {id, text?, key?} → { ok: true }. Forwards input
 * into a running run via tmux send-keys. Guard chain shared with the other
 * mutating endpoints (405/403/400/413), then in order: malformed id 400;
 * payload 400 (at least one of text/key required; text, when present, a
 * non-empty string; key, when present, from the INPUT_KEYS closed set) —
 * all before touching tmux, so a rejected payload sends NOTHING; unknown
 * id 404; exited run 409. Text is sent literally (send-keys -l — tmux
 * never interprets it as key names); the key is a separate non-literal
 * send AFTER the text, so {text, key:"Enter"} types a line and submits it
 * in one request.
 */
export async function handleApiRunsInput(req, res, _url, _deps = null) {
  const deps = _deps || {};
  const body = await guardMutating(req, res);
  if (!body) return;
  const id = typeof body.id === "string" ? body.id : "";
  if (!RUN_ID_RE.test(id)) {
    return sendError(res, 400, "id must be a tmux window id like @1");
  }
  const hasText = body.text !== undefined;
  const hasKey = body.key !== undefined;
  if (!hasText && !hasKey) {
    return sendError(res, 400, "at least one of text or key is required");
  }
  if (hasText && (typeof body.text !== "string" || body.text.length === 0)) {
    return sendError(res, 400, "text must be a non-empty string");
  }
  if (hasText && FORBIDDEN_CONTROL_RE.test(body.text)) {
    return sendError(res, 400, "text must not contain control characters (newline and tab excepted)");
  }
  if (hasKey && !INPUT_KEYS.includes(body.key)) {
    return sendError(res, 400, `key must be one of ${INPUT_KEYS.join(", ")}`);
  }
  const run = findRunWindow(id, deps);
  if (!run) {
    return sendError(res, 404, `no run with id ${id}`);
  }
  if (run.dead) {
    return sendError(res, 409, `run ${id} has exited — input can only be sent to a running run`);
  }
  // TOCTOU guard: the window can vanish between the check and the send —
  // re-check in the catch so a vanished window answers 404 JSON and any
  // other tmux failure answers 500 JSON, never the plaintext 500.
  const sendKeysImpl = deps.sendKeys || sendKeys;
  try {
    if (hasText) sendKeysImpl(id, [body.text], { literal: true });
    if (hasKey) sendKeysImpl(id, [body.key]);
  } catch (err) {
    if (!findRunWindow(id, deps)) {
      return sendError(res, 404, `no run with id ${id}`);
    }
    return sendError(res, 500, `failed to send input: ${errorMessage(err)}`);
  }
  sendJson(res, { ok: true });
}

/** True when `path` exists and is a directory. */
function isDirectory(path, deps = {}) {
  const statImpl = deps.statSync || statSync;
  try {
    return statImpl(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The run window (if any) whose linked recording IS `path` — read-only
 * resolution (never persists a link from an observer request), best-effort:
 * any mux/link failure just answers null.
 */
function runForSessionPath(path, deps, generating) {
  try {
    if (!(deps.muxAvailable || available)()) return null;
    const windows = (deps.listWindows || listWindows)();
    const link = deps.linkRunSession || linkRunSession;
    const tombstones = runTombstonesFor(deps, windows);
    for (const win of windows) {
      if (!win.options || !win.options.tq_agent) continue;
      let linked;
      try {
        linked = link(win, windows, { persist: false, tombstones });
      } catch {
        continue;
      }
      if (linked && linked.path === path) {
        const gen = generating === undefined
          ? launchedRunGenerating(win.options.tq_agent, path, { pid: win.panePid }, deps)
          : generating;
        return { id: win.id, status: runGeneratingStatus(win.dead, path, gen) };
      }
    }
  } catch {
    // tmux hiccup — the live-session answer works fine without the run link
  }
  return null;
}

/**
 * GET /api/sessions/live?id=<hash|path>[&etag=<etag>] — the SESSION-KEYED
 * live parsed-session endpoint: the same etag-memoized incremental-parse
 * machinery /api/runs/session uses, generalized to ANY session (launched by
 * tracequest or detected external), so a live session is observable through
 * the same chat surface regardless of origin. A plain GET route, never
 * route-cached; read-only (no Host guard, per the read-endpoint posture),
 * with the id validated by the exact resolveSessionPathForRequest semantics
 * every read endpoint shares (400 missing, 403 non-session path, 404
 * unknown hash, 409 ambiguous — paths outside the agent session roots can
 * never resolve).
 *
 * Body: { sessionHash, sessionPath, source, project, live, state, run,
 * etag, session, chapters } where
 * - live   is detectLiveSessions membership (generating, not process/fd
 *          or tmux-alive — the same bit that feeds the dashboard)
 * - state  is the generating word: "running" | "idle" (running iff live;
 *          idle is not an error — the transcript stays served and
 *          liveness can return). Same word as nested run.status when the
 *          recording belongs to a generating or idle launched run.
 * - run    is {id, status} when the recording belongs to a tracequest run
 *          (status is the generating word running|idle|exited, never
 *          tmux-alive as running), else null
 * - etag/session/chapters follow the /api/runs/session contract exactly: a
 *   request repeating the current etag answers {unchanged: true} without a
 *   session body, and the parse is memoized per path behind the etag
 * A recording that vanishes answers 404 (there is no run window to pend
 * on — the session itself is the subject).
 */
export async function handleApiSessionsLive(_req, res, url, _deps = null) {
  const deps = _deps || await hotModules();
  const handle = url?.searchParams?.get("id") || url?.searchParams?.get("path") || "";
  const findSessions = deps.findSessions || null;
  // One scan per request, shared by hash resolution and liveness (fact oiw).
  // This endpoint is deliberately never route-cached and the live page polls it
  // once a second, so resolving a hash used to walk every discovery root twice
  // per poll: once inside resolveSessionPathForRequest and once here.
  let sessions = null;
  const scanOnce = findSessions
    ? () => {
        if (sessions === null) sessions = findSessions(null);
        return sessions;
      }
    : null;
  const path = resolveSessionPathForRequest(handle, res, scanOnce);
  if (!path) return; // 400/403/404/409 already answered
  if (sessions === null) sessions = scanOnce ? scanOnce() : [];
  const s = sessions.find((x) => x.path === path) || null;
  const livePaths = (deps.detectLiveSessions || detectLiveSessions)(sessions);
  const live = livePaths.includes(path);
  // Source correctness: a recording discovery hasn't indexed yet (or an
  // entry without a source) falls back to the PATH-derived source, so a
  // .cursor/projects recording is never labeled — or parsed as — "claude".
  const source = s?.source || sourceForSessionPath(path);
  const meta = {
    sessionHash: sessionHash(path),
    sessionPath: path,
    source,
    project: s?.project ?? null,
    live,
    state: live ? "running" : "idle",
    run: runForSessionPath(path, deps, live),
  };
  const statImpl = deps.statSync || statSync;
  let st;
  try {
    st = statImpl(sessionFreshnessPath(path));
  } catch {
    return sendError(res, 404, "session recording not found");
  }
  const etag = `${Math.floor(st.mtimeMs)}-${st.size}`;
  if (url.searchParams.get("etag") === etag) {
    return sendJson(res, { ...meta, etag, unchanged: true, session: null, chapters: null });
  }
  let entry;
  try {
    entry = parsedRunSession(path, etag, deps, source);
  } catch (err) {
    return sendError(res, 500, `failed to parse session: ${errorMessage(err)}`);
  }
  sendJson(res, { ...meta, etag, session: entry.session, chapters: entry.chapters });
}

/**
 * GET /api/agents → { mux: { available, session }, agents }.
 * Answers 200 with mux.available:false when tmux is absent so the UI can
 * render the missing-multiplexer state from this one endpoint.
 */
export async function handleApiAgents(_req, res, _url, _deps = null) {
  const deps = _deps || {};
  const muxAvailable = (deps.muxAvailable || available)();
  const agents = (deps.detectAgents || detectAgents)();
  const body = JSON.stringify({
    mux: { available: muxAvailable, session: tmuxSession() },
    agents,
  });
  send(res, 200, body, "application/json; charset=utf-8");
}
