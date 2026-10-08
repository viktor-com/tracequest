/**
 * tmux multiplexer adapter — the ONLY tracequest module that talks to tmux.
 *
 * Every invocation shells out via execFileSync/spawnSync with an argv ARRAY,
 * never exec/execSync and never a shell string, so request-derived values
 * (cwd, prompt, input text) can only ever travel as discrete argv elements.
 *
 * Env:
 * - TRACEQUEST_TMUX_BIN     tmux binary to run (default "tmux")
 * - TRACEQUEST_TMUX_SOCKET  when set, prepends `-L <socket>` to every
 *                           invocation so tests and callers get a private
 *                           tmux server
 * - TRACEQUEST_TMUX_SESSION session name (default "tracequest")
 * - TRACEQUEST_SKIP_TMUX    when "1", tracequest behaves as if tmux were
 *                           unavailable (test/CI isolation — spawned serve
 *                           processes must not touch a real tmux server)
 */
import { execFileSync, spawnSync } from "node:child_process";

/** Effective tmux binary after env override. */
export function tmuxBin() {
  return process.env.TRACEQUEST_TMUX_BIN || "tmux";
}

/** Effective tmux session name after env override. */
export function tmuxSession() {
  return process.env.TRACEQUEST_TMUX_SESSION || "tracequest";
}

/** Socket args prepended to every invocation (private server isolation). */
function socketArgs() {
  const socket = process.env.TRACEQUEST_TMUX_SOCKET;
  return socket ? ["-L", socket] : [];
}

/**
 * Generous stdout ceiling: a dead pane's full-history capture (-S -) can
 * far exceed Node's 1MB execFileSync default (ENOBUFS throw) at tmux's
 * default history-limit once the output is SGR-dense — capture-pane -e
 * re-emits an escape sequence per style change.
 */
const TMUX_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Per-invocation timeout so a wedged tmux server can never hang a request. */
const TMUX_TIMEOUT_MS = 10_000;

/** Tighter timeout for the availability probe — it gates serve boot. */
const TMUX_AVAILABLE_TIMEOUT_MS = 3_000;

/** Run tmux and return trimmed stdout; throws when tmux exits non-zero. */
function tmuxExec(args) {
  return execFileSync(tmuxBin(), [...socketArgs(), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: TMUX_MAX_BUFFER_BYTES,
    timeout: TMUX_TIMEOUT_MS,
  });
}

/** Run tmux where a non-zero exit is an expected answer, not an error. */
function tmuxProbe(args, { timeout = TMUX_TIMEOUT_MS } = {}) {
  return spawnSync(tmuxBin(), [...socketArgs(), ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: TMUX_MAX_BUFFER_BYTES,
    timeout,
  });
}

/** True when the tmux binary actually runs. Never throws. */
export function available() {
  if (process.env.TRACEQUEST_SKIP_TMUX === "1") return false;
  try {
    return tmuxProbe(["-V"], { timeout: TMUX_AVAILABLE_TIMEOUT_MS }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Ensure `session` exists on the effective server — create it detached when
 * absent, reuse it untouched when present. Returns the session name.
 */
export function ensureSession(session = tmuxSession()) {
  const has = tmuxProbe(["has-session", "-t", `=${session}`]);
  if (has.status !== 0) {
    tmuxExec(["new-session", "-d", "-s", session]);
  }
  return session;
}

/**
 * Run metadata lives in tmux window USER options (tmux's "@"-prefixed
 * namespace) so run state survives tracequest restarts — tmux is the only
 * run table. These are the option names (without the "@" prefix).
 */
export const RUN_OPTION_NAMES = ["tq_agent", "tq_cwd", "tq_started", "tq_ended", "tq_session", "tq_session_attr", "tq_session_id", "tq_resumed_from", "tq_resumed_path", "tq_fork_prompt"];

/**
 * List windows of `session` as [{ id, name, dead, panePid, options }] where
 * `options` maps each RUN_OPTION_NAMES entry to its window user-option
 * value ("" when unset) and `panePid` is the window pane's root process id
 * (`#{pane_pid}` — the run's process tree starts there; "" when unknown).
 * Returns [] when the session (or server) does not exist.
 *
 * Locale-proof parsing: a tmux CLIENT running under the C/POSIX locale
 * (serve started by launchd/cron without LANG/LC_*) replaces EVERY
 * control byte in list-windows output with "_" — a 0x1f or tab field
 * separator is destroyed before Node ever sees it. So the formats use
 * only printable structure: space-separated space-free fields with the
 * one arbitrary-content field (tq_cwd, resp. window_name) placed LAST
 * so it may contain anything, split across two id-keyed queries.
 */
export function listWindows(session = tmuxSession()) {
  // tq_agent is a registry id, tq_started/tq_ended ISO timestamps, pane_pid
  // a number, tq_session_attr a closed token ("sid"/"pid"/"prompt"/"heur"),
  // tq_session_id a UUID and tq_resumed_from an 8-hex session hash — all
  // space-free by construction. tq_cwd is arbitrary, hence last.
  const fields = tmuxProbe([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    "#{window_id} #{pane_dead} #{pane_pid} #{@tq_agent} #{@tq_started} #{@tq_session_attr} #{@tq_session_id} #{@tq_resumed_from} #{@tq_ended} #{@tq_cwd}",
  ]);
  if (fields.status !== 0) return [];
  const nameById = idKeyedQuery(session, "#{window_name}");
  // tq_session is an arbitrary filesystem path (may contain spaces), so like
  // window_name it gets its own id-keyed query with the value LAST.
  const sessionById = idKeyedQuery(session, "#{@tq_session}");
  // tq_prompt is arbitrary user text (stored single-line at creation), so it
  // also travels as an id-keyed query with the value LAST.
  const promptById = idKeyedQuery(session, "#{@tq_prompt}");
  // tq_resumed_path (source recording path) and tq_fork_prompt (the source
  // conversation's first user message) are arbitrary too — id-keyed each.
  const resumedPathById = idKeyedQuery(session, "#{@tq_resumed_path}");
  const forkPromptById = idKeyedQuery(session, "#{@tq_fork_prompt}");
  const windows = [];
  for (const line of String(fields.stdout || "").split("\n")) {
    const m = line.match(/^(@\d+) ([01]?) (\d*) (\S*) (\S*) (\S*) (\S*) (\S*) (\S*)(?: (.*))?$/);
    if (!m) continue;
    const [, id, dead, panePid, tqAgent, tqStarted, tqSessionAttr, tqSessionId, tqResumedFrom, tqEnded, tqCwd] = m;
    windows.push({
      id,
      name: nameById.get(id) ?? "",
      dead: dead === "1",
      panePid: panePid ?? "",
      options: {
        tq_agent: tqAgent,
        tq_cwd: tqCwd ?? "",
        tq_started: tqStarted,
        tq_ended: tqEnded ?? "",
        tq_session: sessionById.get(id) ?? "",
        tq_session_attr: tqSessionAttr ?? "",
        tq_session_id: tqSessionId ?? "",
        tq_resumed_from: tqResumedFrom ?? "",
        tq_resumed_path: resumedPathById.get(id) ?? "",
        tq_prompt: promptById.get(id) ?? "",
        tq_fork_prompt: forkPromptById.get(id) ?? "",
      },
    });
  }
  return windows;
}

/** One list-windows query mapping window_id → an arbitrary-content format value. */
function idKeyedQuery(session, format) {
  const out = tmuxProbe([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    `#{window_id} ${format}`,
  ]);
  const byId = new Map();
  for (const line of String(out.stdout || "").split("\n")) {
    const sep = line.indexOf(" ");
    if (sep > 0) byId.set(line.slice(0, sep), line.slice(sep + 1));
  }
  return byId;
}

/**
 * Set one "@"-prefixed window user option on window `id` (e.g. the
 * tq_session run↔session link persisted after resolution so it survives
 * tracequest restarts — tmux is the only run table).
 */
export function setWindowOption(id, name, value) {
  tmuxExec(["set-option", "-w", "-t", id, `@${name}`, String(value)]);
}

/**
 * SESSION-level "@"-prefixed user options — state that must outlive
 * individual run windows (e.g. tq_tombstones, the dismissed-run claims that
 * keep a killed rival's recording out of a survivor's chat). Stored on the
 * tracequest tmux session itself, so it survives serve restarts exactly
 * like window options and dies only with the session — tmux stays the only
 * run table, no state files. The "=name:" target is the exact-match
 * session spelling set-option/show-options accept (verified on tmux 3.7b;
 * bare "=name" is rejected there).
 */
export function setSessionOption(name, value, session = tmuxSession()) {
  tmuxExec(["set-option", "-t", `=${session}:`, `@${name}`, String(value)]);
}

/**
 * Read one session-level user option; "" when unset (tmux answers "invalid
 * option" non-zero for an unset user option) or when the session/server is
 * absent. Values are expected to be locale-proof single-line tokens
 * (tq_tombstones is base64) — never raw user text.
 */
export function getSessionOption(name, session = tmuxSession()) {
  const out = tmuxProbe(["show-options", "-v", "-t", `=${session}:`, `@${name}`]);
  if (out.status !== 0) return "";
  return String(out.stdout || "").replace(/\n$/, "");
}

/**
 * Spawn `argv` (a command argv array, exec'd directly — no shell) in a new
 * detached window of `session`, with remain-on-exit on so finished runs stay
 * viewable. `userOptions` ({name: value}) are stored as "@"-prefixed window
 * user options before the command starts, so metadata can never race a
 * fast-exiting command. Returns the tmux window id (e.g. "@3").
 */
export function newWindow({
  argv,
  cwd = null,
  name = null,
  userOptions = null,
  session = tmuxSession(),
} = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("newWindow: argv must be a non-empty array");
  }
  const createArgs = ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", `=${session}:`];
  if (name) createArgs.push("-n", name);
  const windowId = tmuxExec(createArgs).trim();
  try {
    // The window starts as an idle default shell so remain-on-exit is in
    // effect BEFORE the real command runs — a fast-exiting command must not
    // race the option and vanish.
    tmuxExec(["set-option", "-w", "-t", windowId, "remain-on-exit", "on"]);
    for (const [optionName, value] of Object.entries(userOptions || {})) {
      tmuxExec(["set-option", "-w", "-t", windowId, `@${optionName}`, String(value)]);
    }
    const respawnArgs = ["respawn-window", "-k", "-t", windowId];
    if (cwd) respawnArgs.push("-c", cwd);
    respawnArgs.push("--", ...argv);
    tmuxExec(respawnArgs);
  } catch (err) {
    try {
      tmuxExec(["kill-window", "-t", windowId]);
    } catch {
      // best-effort cleanup of the half-created window
    }
    throw err;
  }
  return windowId;
}

/**
 * Capture the pane of window `id` with escape sequences (`-e`) preserved.
 * `withHistory` starts the capture at the beginning of scrollback (`-S -`) —
 * needed to see output a dead pane's exit banner scrolled off screen.
 */
export function capturePane(id, { withHistory = false } = {}) {
  const args = ["capture-pane", "-e", "-p"];
  if (withHistory) args.push("-S", "-");
  args.push("-t", id);
  return tmuxExec(args);
}

/** Kill window `id`. */
export function killWindow(id) {
  tmuxExec(["kill-window", "-t", id]);
}

/**
 * Send keys to window `id`. `keys` is an array of tmux key names (Enter,
 * C-c, ...) or, with `literal: true`, raw text sent as-is (`-l`).
 *
 * Two tmux CLI quirks are neutralized here (verified against tmux 3.7b):
 * - "--" always ends option parsing, so text starting with "-" (e.g. "-l")
 *   can never be read as a send-keys flag.
 * - tmux splits command sequences on an argument's trailing unescaped ";"
 *   (silently dropping it); escaping it as "\;" delivers the ";" verbatim
 *   and tmux drops exactly that one backslash. Literal text gets that
 *   escape; key names come from closed sets that never end in ";".
 */
export function sendKeys(id, keys, { literal = false } = {}) {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error("sendKeys: keys must be a non-empty array");
  }
  const args = ["send-keys", "-t", id];
  if (literal) args.push("-l");
  args.push("--");
  const send = literal ? keys.map((key) => String(key).replace(/;$/, "\\;")) : keys;
  args.push(...send);
  tmuxExec(args);
}
