/**
 * Launch feature serve-boot integration — real bin/tracequest.js serve
 * process, isolated HOME, ephemeral port, private tmux socket.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKIP_NO_TMUX, TMUX } from "../helpers/tmux-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";
import { cursorMainRecording, cursorTranscriptsDir } from "../../src/sessions/session-layout.js";

/**
 * Write a USER's own cursor session in the REAL CLI layout (dashless project
 * slug + agent-transcripts/<uuid>/<uuid>.jsonl, cursor {"role":...} rows) —
 * the decoy every attribution scenario needs to be honest about. A decoy
 * written in a layout the CLI never uses proves nothing.
 */
function writeCursorUserSession(home, cwd, id, rows) {
  const path = cursorMainRecording(cursorTranscriptsDir(home, realpathSync(cwd)), id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return path;
}

/** cursor {"role":"user"|"assistant"} row in the real CLI line shape. */
function cursorRow(role, text) {
  return { role, message: { content: [{ type: "text", text }] } };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const SOCKET = `tq-test-launch-${process.pid}`;
const SESSION = `tq-launch-${process.pid}`;

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];
/** @type {string[]} */
const pendingHomes = [];

afterEach(async () => {
  while (serveChildren.length) {
    await stopServe(serveChildren.pop());
  }
  await new Promise((r) => setTimeout(r, 100));
  while (pendingHomes.length) {
    const home = pendingHomes.pop();
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // best-effort
    }
  }
});

after(() => {
  // ALWAYS tear down the private tmux server for this socket.
  if (TMUX) {
    try {
      spawnSync(TMUX.bin, ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
  }
});

function listenOnEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

async function allocEphemeralPort() {
  const { server, port } = await listenOnEphemeralPort();
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, { expectedStatus = 200, timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === expectedStatus) return res;
      lastErr = new Error(`HTTP ${res.status} for ${reqPath}, expected ${expectedStatus}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastErr ?? new Error(`timed out waiting for ${reqPath}`);
}

function spawnServe(port, home, extraEnv = {}) {
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_LR_WATCH: "1",
      ...extraEnv,
    },
  });
  child.stdoutText = "";
  child.stdout.on("data", (chunk) => {
    child.stdoutText += String(chunk);
  });
  serveChildren.push(child);
  return child;
}

async function stopServe(child) {
  if (child.exitCode == null && !child.killed) {
    child.kill("SIGKILL");
  }
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function mkHome(prefix) {
  const home = mkdtempSync(join(tmpdir(), prefix));
  pendingHomes.push(home);
  return home;
}

function rawTmux(args) {
  return spawnSync(TMUX.bin, ["-L", SOCKET, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function httpPost(port, reqPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function pollUntil(predicate, { timeoutMs = 10_000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Shared stub argv prologue: the launcher now spawns claude as
 * `claude --session-id <uuid> -- <prompt>`, so every stub extracts SID
 * (the spawn-assigned session uuid) and PROMPT (the argv element behind
 * the end-of-options "--") instead of assuming fixed positions — exactly
 * like the real CLI's parser.
 */
const STUB_ARGV_PROLOGUE = [
  'echo "tq-stub:$@"',
  'SID=""; PROMPT=""; prev=""',
  'for arg in "$@"; do',
  '  case "$prev" in',
  '    --session-id) SID="$arg";;',
  '    --) PROMPT="$arg";;',
  "  esac",
  '  prev="$arg"',
  "done",
];

/**
 * Default stub agent standing in for the real `claude` CLI: prints its
 * FULL argv via "$@" (so the --session-id uuid, the end-of-options "--"
 * and the prompt are all observable in capture-pane), exits immediately
 * when the prompt is "exit-fast", prints SGR-colored output (then a late
 * second line, so snapshot freshness is observable) for "color",
 * otherwise stays running. Detection resolves via PATH, so callers
 * prepend the stub dir to the serve child's PATH.
 */
const DEFAULT_STUB_SCRIPT = [
  "#!/bin/sh",
  ...STUB_ARGV_PROLOGUE,
  'if [ "$PROMPT" = "exit-fast" ]; then exit 0; fi',
  'if [ "$PROMPT" = "color" ]; then',
  "  printf '\\033[31mRED-MARKER\\033[0m <plain> & done\\n'",
  "  sleep 1",
  "  printf 'SECOND-LINE\\n'",
  "fi",
  "sleep 30",
  "",
].join("\n");

/**
 * Interactive stub agent for input tests: echoes every stdin line back as
 * "GOT:<line>" and stays in the read loop until EOF or a signal (sh's
 * default SIGINT action kills it, which is the C-c scenario).
 */
const ECHO_STUB_SCRIPT = [
  "#!/bin/sh",
  'echo "tq-stub:$@"',
  "while read line; do",
  '  echo "GOT:$line"',
  "done",
  "",
].join("\n");

/**
 * Session-writing stub agent for the run↔session lane, modeling the REAL
 * claude CLI's recording behavior (verified against a live claude
 * session): it honors the spawn-assigned --session-id by naming its
 * recording <uuid>.jsonl, and it NEVER holds the recording open — every
 * write is open/append/close (`cat >>`), so zero fds reference the file
 * between writes and pid attribution can never see a holder. The serve
 * HOME is baked into the script (the persistent tmux server keeps the
 * FIRST scenario's env, so $HOME inside a pane is unreliable across
 * scenarios); the project slug comes from the pane's own $PWD, which is
 * the REALPATH of the launch cwd — exactly the literal-vs-realpath
 * mismatch the link resolver must absorb. Prompt branches:
 *   no-session — never writes a recording (pending-link scenario)
 *   chat-exit  — writes 2 events, exits (exited-run scenario)
 *   chat-live  — writes 2 events, appends 2 more after ~1s, stays running
 *   user-race* — sleeps ~2s BEFORE writing (a user session file appears
 *                in the same cwd meanwhile), then writes and stays running
 */
function sessionStubScript(home) {
  return [
    "#!/bin/sh",
    ...STUB_ARGV_PROLOGUE,
    'if [ "$PROMPT" = "no-session" ]; then sleep 30; exit 0; fi',
    'case "$PROMPT" in user-race*) sleep 2;; esac',
    "proj=\"$(pwd | tr '/' '-')\"",
    `dir="${home}/.claude/projects/$proj"`,
    'mkdir -p "$dir"',
    'f="$dir/$SID.jsonl"',
    'cat > "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-11T10:00:00.000Z","uuid":"u-1","isMeta":false,"message":{"content":[{"type":"text","text":"first user prompt"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T10:00:05.000Z","uuid":"a-1","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"FIRST-REPLY"}],"usage":{"input_tokens":10,"output_tokens":20}}}',
    "EOF",
    'if [ "$PROMPT" = "chat-exit" ]; then exit 0; fi',
    "sleep 1",
    'cat >> "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-11T10:00:10.000Z","uuid":"u-2","isMeta":false,"message":{"content":[{"type":"text","text":"second user prompt"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T10:00:15.000Z","uuid":"a-2","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"SECOND-REPLY"}],"usage":{"input_tokens":12,"output_tokens":22}}}',
    "EOF",
    "sleep 30",
    "",
  ].join("\n");
}

/**
 * Racing stub agent for the attribution lane, modeling the REAL claude
 * behavior the round-2 critic reproduced: the recording is named by the
 * spawn-assigned --session-id uuid, written open/append/close, and NO fd
 * is EVER held on it — `lsof` on the file finds zero holders at any
 * probe, so fd-based identity can never fire and only spawn identity can
 * attribute it. A "race-slow-*" prompt sleeps first — the round-1 mislink
 * trigger (trust prompt / MCP handshake / hung start). The prompt is
 * embedded in the transcript so tests can prove WHOSE conversation a run
 * serves.
 */
function raceStubScript(home) {
  return [
    "#!/bin/sh",
    ...STUB_ARGV_PROLOGUE,
    'case "$PROMPT" in race-slow*) sleep 4;; esac',
    "proj=\"$(pwd | tr '/' '-')\"",
    `dir="${home}/.claude/projects/$proj"`,
    'mkdir -p "$dir"',
    'f="$dir/$SID.jsonl"',
    'cat > "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-11T10:00:00.000Z","uuid":"u-$SID","isMeta":false,"message":{"content":[{"type":"text","text":"prompt of $PROMPT"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T10:00:05.000Z","uuid":"a-$SID","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"REPLY-FROM-$PROMPT"}],"usage":{"input_tokens":1,"output_tokens":2}}}',
    "EOF",
    "sleep 30",
    "",
  ].join("\n");
}

/**
 * Resume-modeling stub agent for the continue-resume lane, modeling the
 * REAL claude CLI's documented fork-resume semantics: invoked as
 * `claude --resume <srcId> --fork-session --session-id <newUuid>` it reads
 * the referenced recording (<srcId>.jsonl under the cwd's project slug),
 * writes a NEW recording named by the fork uuid whose content BEGINS with
 * the prior conversation (sessionId rewritten to the fork's — what a real
 * fork does), then continues appending new turns to the fork — never
 * touching the source and never holding either file open. Without
 * --resume it just runs (fresh-launch fallback).
 */
function resumeStubScript(home) {
  return [
    "#!/bin/sh",
    'echo "tq-stub:$@"',
    'SID=""; PROMPT=""; RESUME=""; prev=""',
    'for arg in "$@"; do',
    '  case "$prev" in',
    '    --session-id) SID="$arg";;',
    '    --resume) RESUME="$arg";;',
    '    --) PROMPT="$arg";;',
    "  esac",
    '  prev="$arg"',
    "done",
    "proj=\"$(pwd | tr '/' '-')\"",
    `dir="${home}/.claude/projects/$proj"`,
    'mkdir -p "$dir"',
    'if [ -n "$RESUME" ]; then',
    '  src="$dir/$RESUME.jsonl"',
    '  f="$dir/$SID.jsonl"',
    '  sed "s/$RESUME/$SID/g" "$src" > "$f"',
    "  sleep 0.5",
    '  cat >> "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-11T11:00:00.000Z","uuid":"u-resume","isMeta":false,"message":{"content":[{"type":"text","text":"CONTINUED-FOLLOW-UP"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T11:00:05.000Z","uuid":"a-resume","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"RESUMED-REPLY: picking up where we left off"}],"usage":{"input_tokens":5,"output_tokens":9}}}',
    "EOF",
    "fi",
    "sleep 30",
    "",
  ].join("\n");
}

function mkStubAgentDir(script = DEFAULT_STUB_SCRIPT, binary = "claude") {
  const dir = mkdtempSync(join(tmpdir(), "tq-stub-agent-"));
  pendingHomes.push(dir);
  const path = join(dir, binary);
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return dir;
}

/**
 * sh fragment computing the REAL Cursor CLI recording path for the current
 * pane's $PWD — the round-7 stub-realism fix. The CLI writes
 *   ~/.cursor/projects/<DASHLESS slug of cwd>/agent-transcripts/<uuid>/<uuid>.jsonl
 * (verified on a real machine: 917 recordings, all at that nesting, zero at
 * project-dir root, every project dir dashless). Five rounds of stubs wrote
 * root-level files under a LEADING-DASH slug instead, which is precisely why
 * five rounds of green integration runs never noticed that attribution could
 * not see a single real cursor recording. Sets: $dir (project dir), $SID
 * (session uuid), $f (the transcript, its parent dir created).
 */
const CURSOR_LAYOUT_SH = (home) => [
  "proj=\"$(pwd | sed 's|^/||' | tr '/' '-')\"",
  `dir="${home}/.cursor/projects/$proj"`,
  'SID="00000000-0000-4000-8000-$(printf %012d $$)"',
  'mkdir -p "$dir/agent-transcripts/$SID"',
  'f="$dir/agent-transcripts/$SID/$SID.jsonl"',
];

/**
 * NON-IDENTITY stub agent standing in for `cursor-agent` — one of the 5
 * registry agents WITHOUT a --session-id mechanism, so attribution can only
 * come from the probe/prompt/heuristic tiers. Models the real CLI
 * faithfully: names its own recording (<uuid>.jsonl inside the run's uuid
 * dir under .cursor/projects/<dashless-slug>/agent-transcripts — see
 * CURSOR_LAYOUT_SH), writes it open/append/close (never holds an fd), and
 * embeds the launch prompt as the transcript's FIRST user message (cursor
 * {"role":...} dialect).
 * Branches:
 *   slow-* prompt — sleeps 4s BEFORE writing (the laundering victim)
 *   any other prompt — writes immediately, stays running
 *   NO prompt (bare) — sleeps 6s, then writes a recording whose first user
 *                      message is interactively-typed text, stays running
 */
function cursorStubScript(home) {
  return [
    "#!/bin/sh",
    'echo "tq-stub:$@"',
    'PROMPT=""; prev=""',
    'for arg in "$@"; do',
    '  case "$prev" in --) PROMPT="$arg";; esac',
    '  prev="$arg"',
    "done",
    'case "$PROMPT" in slow-*) sleep 4;; esac',
    'if [ -z "$PROMPT" ]; then sleep 6; fi',
    ...CURSOR_LAYOUT_SH(home),
    'FIRST="$PROMPT"',
    'if [ -z "$FIRST" ]; then FIRST="typed-interactively-by-user"; fi',
    'cat > "$f" <<EOF',
    '{"role":"user","message":{"content":[{"type":"text","text":"$FIRST"}]}}',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"REPLY-FROM:$FIRST"}]}}',
    "EOF",
    "sleep 30",
    "",
  ].join("\n");
}

const MUX_ENV = {
  TRACEQUEST_TMUX_SOCKET: SOCKET,
  TRACEQUEST_TMUX_SESSION: SESSION,
};

/**
 * The serve child's PATH is the stub dir plus bare system dirs (which, sh,
 * tmux tooling, /usr/sbin for the lsof behind pid attribution) — NOT the
 * developer's full PATH, so agent detection sees exactly one agent
 * ("claude" = the stub) no matter what is installed on the machine running
 * the tests. tmux is pinned by absolute path.
 */
function stubEnv(stubDir) {
  const whichTmux = spawnSync("which", [TMUX.bin], { encoding: "utf8" });
  const tmuxBin = TMUX.bin.startsWith("/")
    ? TMUX.bin
    : String(whichTmux.stdout || "").trim() || TMUX.bin;
  return {
    ...MUX_ENV,
    TRACEQUEST_TMUX_BIN: tmuxBin,
    PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
}

async function bootServeWithStub(extraEnv = {}, { stubScript = DEFAULT_STUB_SCRIPT } = {}) {
  const home = mkHome("tq-launch-runs-");
  const stubDir = mkStubAgentDir(stubScript);
  const workDir = mkHome("tq-launch-cwd-");
  const port = await allocEphemeralPort();
  spawnServe(port, home, { ...stubEnv(stubDir), ...extraEnv });
  await waitForHttp(port, "/api/agents");
  return { home, stubDir, workDir, port };
}

/**
 * Kill every tq-run window so scenarios stay independent — and clear the
 * session-level run state (tombstones + ledger) those kills would
 * otherwise synthesize stale tombstones from on the next scenario's polls.
 */
function killRunWindows() {
  const out = rawTmux([
    "list-windows",
    "-t",
    `=${SESSION}`,
    "-F",
    "#{window_id}\t#{@tq_agent}",
  ]);
  for (const line of String(out.stdout || "").split("\n")) {
    const [id, agent] = line.split("\t");
    if (id && agent) rawTmux(["kill-window", "-t", id]);
  }
  rawTmux(["set-option", "-t", `=${SESSION}:`, "-u", "@tq_tombstones"]);
  rawTmux(["set-option", "-t", `=${SESSION}:`, "-u", "@tq_run_ledger"]);
}

describe("launch integration — serve boot mux", () => {
  test("serve ensures the tmux session at boot", SKIP_NO_TMUX, async () => {
    const home = mkHome("tq-launch-boot-");
    const muxEnv = {
      TRACEQUEST_TMUX_SOCKET: SOCKET,
      TRACEQUEST_TMUX_SESSION: SESSION,
    };

    const port = await allocEphemeralPort();
    const child = spawnServe(port, home, muxEnv);
    const res = await waitForHttp(port, "/api/agents");
    const data = JSON.parse(res.body);
    assert.equal(data.mux.available, true);
    assert.equal(data.mux.session, SESSION);
    assert.ok(Array.isArray(data.agents));

    assert.equal(
      rawTmux(["has-session", "-t", `=${SESSION}`]).status,
      0,
      "boot must create the tmux session detached",
    );
    assert.ok(
      child.stdoutText.includes(SESSION),
      `boot stdout must name the tmux session (got: ${JSON.stringify(child.stdoutText)})`,
    );

    // Second serve on the same socket/session reuses the session untouched.
    const windowsBefore = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    const port2 = await allocEphemeralPort();
    const child2 = spawnServe(port2, home, muxEnv);
    await waitForHttp(port2, "/api/agents");
    assert.ok(child2.stdoutText.includes(SESSION));
    const sessions = String(rawTmux(["list-sessions", "-F", "#{session_name}"]).stdout || "")
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(sessions, [SESSION], "reboot must not create a second session");
    const windowsAfter = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    assert.equal(windowsAfter, windowsBefore, "existing session reused untouched");
  });

  test("serve boots without tmux and reports mux unavailable", async () => {
    const home = mkHome("tq-launch-notmux-");
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home, {
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_TMUX_SOCKET: SOCKET,
      TRACEQUEST_TMUX_SESSION: SESSION,
    });

    const agentsRes = await waitForHttp(port, "/api/agents");
    const data = JSON.parse(agentsRes.body);
    assert.equal(data.mux.available, false);
    assert.equal(data.mux.session, SESSION);
    assert.ok(Array.isArray(data.agents));

    const sessionsRes = await httpGet(port, "/api/sessions");
    assert.equal(sessionsRes.status, 200, "pre-existing routes serve unchanged without tmux");
    assert.ok(Array.isArray(JSON.parse(sessionsRes.body).sessions));

    assert.equal(
      child.stdoutText.includes("tmux session"),
      false,
      "no mux boot line without tmux",
    );
  });
});

describe("launch integration — create + list runs", () => {
  afterEach(() => {
    if (TMUX) killRunWindows();
  });

  test("POST /api/runs starts a run in a tmux window", SKIP_NO_TMUX, async () => {
    const { stubDir, workDir, port } = await bootServeWithStub();

    const res = await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "hello" });
    assert.equal(res.status, 200, `POST /api/runs failed: ${res.body}`);
    const { id } = JSON.parse(res.body);
    assert.match(id, /^@\d+$/, "run id IS the tmux window id");

    const listed = rawTmux([
      "list-windows",
      "-t",
      `=${SESSION}`,
      "-F",
      "#{window_id}\t#{@tq_agent}\t#{@tq_cwd}\t#{@tq_started}\t#{remain-on-exit}",
    ]);
    const row = String(listed.stdout || "")
      .split("\n")
      .find((line) => line.startsWith(`${id}\t`));
    assert.ok(row, `window ${id} must exist in tmux list-windows (got: ${listed.stdout})`);
    const [, tqAgent, tqCwd, tqStarted, remainOnExit] = row.split("\t");
    assert.equal(tqAgent, "claude", "@tq_agent user option");
    assert.equal(tqCwd, workDir, "@tq_cwd user option");
    assert.ok(!Number.isNaN(Date.parse(tqStarted)), "@tq_started is an ISO time");
    assert.equal(remainOnExit, "on", "remain-on-exit is switched on");

    // The stub echoes its full argv — the spawn-assigned session uuid
    // travelled as `--session-id <uuid>`, the prompt as a discrete argv
    // element BEHIND the end-of-options "--" (MUX-002: dash-leading
    // prompts can never be parsed as agent CLI options) and the
    // absolute-path resolution found the stub on serve's PATH.
    const argvEcho = await pollUntil(
      () => {
        const captured = String(rawTmux(["capture-pane", "-p", "-t", id]).stdout || "");
        return captured.includes("-- hello") ? captured : null;
      },
      { label: "stub agent output with -- and prompt in capture-pane" },
    );
    const sid = String(rawTmux(["display-message", "-p", "-t", id, "#{@tq_session_id}"]).stdout || "").trim();
    assert.match(sid, /^[0-9a-f-]{36}$/i, "@tq_session_id persisted as a uuid");
    assert.ok(
      argvEcho.includes(`--session-id ${sid}`),
      `the agent received the SAME uuid tmux persists (got: ${JSON.stringify(argvEcho)})`,
    );
    void stubDir;
  });

  test("GET /api/runs lists runs with live status", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootServeWithStub();

    const running = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "stay-alive" })).body,
    );
    const exiting = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "exit-fast" })).body,
    );
    assert.notEqual(running.id, exiting.id);

    // A window a human opened by hand in the same session is NOT a run.
    rawTmux(["new-window", "-d", "-t", `=${SESSION}:`, "-n", "human-window"]);

    const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
    const runningRun = runs.find((r) => r.id === running.id);
    assert.ok(runningRun, "long-lived run is listed");
    assert.equal(runningRun.agent, "claude");
    assert.equal(runningRun.cwd, workDir);
    assert.ok(!Number.isNaN(Date.parse(runningRun.startedAt)), "startedAt is an ISO time");
    assert.equal(runningRun.status, "running");
    assert.equal(
      runs.length,
      2,
      `hand-opened windows must not appear as runs (got: ${JSON.stringify(runs)})`,
    );

    // The fast-exiting stub flips to exited (remain-on-exit keeps it listed).
    await pollUntil(
      async () => {
        const polled = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
        return (polled.find((r) => r.id === exiting.id) || {}).status === "exited";
      },
      { label: "fast-exiting run reported as exited" },
    );
  });

  test("runs survive a serve restart", SKIP_NO_TMUX, async () => {
    const { home, stubDir, workDir, port } = await bootServeWithStub();

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "survive-me" })).body,
    );

    // SIGKILL the serve process — run state lives in tmux, not in serve.
    await stopServe(serveChildren.pop());

    const port2 = await allocEphemeralPort();
    spawnServe(port2, home, stubEnv(stubDir));
    const runs = JSON.parse((await waitForHttp(port2, "/api/runs")).body).runs;
    const survived = runs.find((r) => r.id === id);
    assert.ok(survived, "a fresh serve process lists the same run with the same id");
    assert.equal(survived.agent, "claude");
    assert.equal(survived.cwd, workDir);
    assert.equal(survived.status, "running");
  });

  test("unknown agents are rejected with 400", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootServeWithStub();

    const windowsBefore = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    for (const agent of ["not-an-agent", "codex" /* registry entry NOT on stub PATH */]) {
      const res = await httpPost(port, "/api/runs", { agent, cwd: workDir });
      assert.equal(res.status, 400, `agent ${agent} must answer 400`);
      assert.match(JSON.parse(res.body).error, /agent/);
    }
    const windowsAfter = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    assert.equal(windowsAfter, windowsBefore, "no window may be created for a rejected agent");
  });

  test("missing cwd is rejected with 400", SKIP_NO_TMUX, async () => {
    const { port } = await bootServeWithStub();

    const windowsBefore = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    const res = await httpPost(port, "/api/runs", {
      agent: "claude",
      cwd: join(tmpdir(), `tq-launch-no-such-dir-${process.pid}`),
      prompt: "hello",
    });
    assert.equal(res.status, 400);
    assert.match(JSON.parse(res.body).error, /cwd/);
    const windowsAfter = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    assert.equal(windowsAfter, windowsBefore, "no window may be created for a rejected cwd");
  });
});

describe("launch integration — snapshot + kill", () => {
  afterEach(() => {
    if (TMUX) killRunWindows();
  });

  async function snapshot(port, id) {
    const res = await httpGet(port, `/api/runs/snapshot?id=${encodeURIComponent(id)}`);
    return { ...res, data: res.status === 200 ? JSON.parse(res.body) : JSON.parse(res.body) };
  }

  test("snapshot returns the captured screen as html", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootServeWithStub();

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "color" })).body,
    );

    // The stub prints an SGR-red marker plus HTML-dangerous text.
    const snap = await pollUntil(
      async () => {
        const s = await snapshot(port, id);
        return s.status === 200 && s.data.html.includes("RED-MARKER") ? s : null;
      },
      { label: "colored stub output in snapshot html" },
    );
    assert.equal(snap.data.status, "running");
    assert.ok(
      snap.data.html.includes('<span class="ansi-fg-1">RED-MARKER</span>'),
      `red SGR must become a red-classed span (got: ${JSON.stringify(snap.data.html)})`,
    );
    assert.ok(snap.data.html.includes("&lt;plain&gt;"), "terminal text is HTML-escaped");
    assert.ok(snap.data.html.includes("&amp; done"), "ampersands are HTML-escaped");
    assert.ok(!snap.data.html.includes("\u001b"), "no raw escape byte in html");

    // Fresh capture every poll (no route cache): the stub's late second
    // line must appear in a subsequent snapshot of the SAME run.
    const fresh = await pollUntil(
      async () => {
        const s = await snapshot(port, id);
        return s.status === 200 && s.data.html.includes("SECOND-LINE") ? s : null;
      },
      { label: "late stub output in a later snapshot poll" },
    );
    assert.equal(fresh.data.status, "running");
  });

  test("snapshot of an exited run reports exited with the final output", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootServeWithStub();

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "exit-fast" })).body,
    );
    const snap = await pollUntil(
      async () => {
        const s = await snapshot(port, id);
        return s.status === 200 && s.data.status === "exited" ? s : null;
      },
      { label: "snapshot reporting exited" },
    );
    assert.ok(
      snap.data.html.includes("-- exit-fast"),
      `final output must stay visible after exit (got: ${JSON.stringify(snap.data.html)})`,
    );
  });

  test("snapshot rejects malformed and unknown ids", SKIP_NO_TMUX, async () => {
    const { port } = await bootServeWithStub();

    for (const id of ["bogus", "5", "@x", ""]) {
      const res = await httpGet(port, `/api/runs/snapshot?id=${encodeURIComponent(id)}`);
      assert.equal(res.status, 400, `id ${JSON.stringify(id)} must answer 400`);
    }
    const unknown = await httpGet(port, "/api/runs/snapshot?id=%4099999");
    assert.equal(unknown.status, 404, "unknown run id must answer 404, not an empty screen");
    assert.match(JSON.parse(unknown.body).error, /@99999/);
  });

  test("kill removes the run window", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootServeWithStub();

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "stay-alive" })).body,
    );
    const windowIds = () =>
      String(rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "")
        .split("\n")
        .filter(Boolean);
    assert.ok(windowIds().includes(id), "run window exists before the kill");

    const killRes = await httpPost(port, "/api/runs/kill", { id });
    assert.equal(killRes.status, 200, `kill failed: ${killRes.body}`);
    assert.deepEqual(JSON.parse(killRes.body), { ok: true });

    assert.ok(!windowIds().includes(id), "window gone from tmux list-windows");
    const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
    assert.ok(!runs.some((r) => r.id === id), "killed run no longer listed");
    const snapRes = await httpGet(port, `/api/runs/snapshot?id=${encodeURIComponent(id)}`);
    assert.equal(snapRes.status, 404, "snapshot of a killed run answers 404");
    const again = await httpPost(port, "/api/runs/kill", { id });
    assert.equal(again.status, 404, "killing an already-killed run answers 404");

    // An exited (remain-on-exit) run is dismissed the same way.
    const exited = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "exit-fast" })).body,
    );
    await pollUntil(
      async () => {
        const polled = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
        return (polled.find((r) => r.id === exited.id) || {}).status === "exited";
      },
      { label: "run reported exited before the kill" },
    );
    const killExited = await httpPost(port, "/api/runs/kill", { id: exited.id });
    assert.equal(killExited.status, 200, "killing an exited run works");
    assert.ok(!windowIds().includes(exited.id), "exited run window gone after kill");
  });

  test("runs list and snapshot survive a C-locale serve environment (no LANG/LC_*)", SKIP_NO_TMUX, async () => {
    // Regression: serve started by launchd/cron has no LANG/LC_*; a
    // C-locale tmux client mangles control bytes in list-windows output,
    // which used to collapse run parsing into an empty /api/runs answer.
    const localeScrub = {};
    for (const key of Object.keys(process.env)) {
      if (key === "LANG" || key.startsWith("LC_")) localeScrub[key] = undefined;
    }
    const { workDir, port } = await bootServeWithStub(localeScrub);

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "stay-alive" })).body,
    );
    const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
    const run = runs.find((r) => r.id === id);
    assert.ok(run, `run must be listed under a C-locale serve (got: ${JSON.stringify(runs)})`);
    assert.equal(run.agent, "claude");
    assert.equal(run.cwd, workDir);
    assert.equal(run.status, "running");
    assert.ok(!Number.isNaN(Date.parse(run.startedAt)), "startedAt survives locale scrubbing");

    const snap = await pollUntil(
      async () => {
        const res = await httpGet(port, `/api/runs/snapshot?id=${encodeURIComponent(id)}`);
        if (res.status !== 200) return null;
        const data = JSON.parse(res.body);
        return data.html.includes("-- stay-alive") ? data : null;
      },
      { label: "snapshot html under C-locale serve" },
    );
    assert.equal(snap.status, "running");
  });
});

describe("launch integration — run session (live unified representation)", () => {
  afterEach(() => {
    if (TMUX) killRunWindows();
  });

  /** Boot serve with the session-writing stub — its HOME is baked into the stub. */
  async function bootSessionStub() {
    const home = mkHome("tq-chatlive-home-");
    const stubDir = mkStubAgentDir(sessionStubScript(home));
    const workDir = mkHome("tq-chatlive-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");
    return { home, stubDir, workDir, port };
  }

  async function runSession(port, id, etag) {
    const query = `id=${encodeURIComponent(id)}${etag ? `&etag=${encodeURIComponent(etag)}` : ""}`;
    const res = await httpGet(port, `/api/runs/session?${query}`);
    return { status: res.status, data: JSON.parse(res.body) };
  }

  /** The spawn-assigned session uuid tmux persists for run window `id`. */
  function tqSessionIdOf(id) {
    return String(rawTmux(["display-message", "-p", "-t", id, "#{@tq_session_id}"]).stdout || "").trim();
  }

  test("run session serves the growing unified session for a linked run", SKIP_NO_TMUX, async () => {
    const { home, workDir, port } = await bootSessionStub();

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "chat-live" })).body,
    );

    // The agent process starts and writes its recording — the run links and
    // the unified session appears within the poll interval.
    const linked = await pollUntil(
      async () => {
        const s = await runSession(port, id);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "run session linked with a parsed session" },
    );
    assert.equal(linked.data.state, "running");
    assert.equal(linked.data.run.status, "running");
    assert.ok(
      linked.data.sessionPath.includes("/.claude/projects/"),
      `sessionPath must be the agent's own recording (got: ${linked.data.sessionPath})`,
    );
    assert.ok(linked.data.sessionPath.startsWith(home) || linked.data.sessionPath.includes(home.replace(/^\/private/, "")),
      `sessionPath must live under the serve HOME (got: ${linked.data.sessionPath})`);
    assert.equal(linked.data.session.source, "claude");
    // The recording is NAMED by the spawn-assigned uuid — attribution was
    // determined at launch, no fd evidence involved (the stub never holds
    // its recording open, like the real claude CLI).
    const sid = tqSessionIdOf(id);
    assert.match(sid, /^[0-9a-f-]{36}$/i, "@tq_session_id persisted as a uuid");
    assert.ok(
      linked.data.sessionPath.endsWith(`/${sid}.jsonl`),
      `recording must be named by the spawn uuid (got: ${linked.data.sessionPath})`,
    );
    assert.equal(linked.data.session.sessionId, sid);
    assert.equal(linked.data.attribution, "sid", "spawn identity, not fd-probe or guess");
    assert.ok(linked.data.session.eventCount >= 2, "initial events parsed");
    assert.equal(linked.data.session.events[0].type, "user");
    assert.equal(linked.data.session.events[0].text, "first user prompt");
    assert.ok(linked.data.session.stats.assistantTurns >= 1, "stats computed");
    assert.ok(Array.isArray(linked.data.chapters) && linked.data.chapters.length >= 1, "chapters attached");
    assert.match(linked.data.etag, /^\d+-\d+$/);

    // The stub appends two more events ~1s in — successive polls of the SAME
    // endpoint reflect them (the Cursor-style "messages appear live" bar).
    const grown = await pollUntil(
      async () => {
        const s = await runSession(port, id);
        return s.status === 200 && s.data.session && s.data.session.eventCount >= 4 ? s : null;
      },
      { label: "appended events reflected in a later poll" },
    );
    assert.ok(grown.data.session.events.some((e) => e.text === "second user prompt"));
    assert.equal(grown.data.chapters.length, 2, "new user prompt opens a second chapter");
    assert.notEqual(grown.data.etag, linked.data.etag, "etag moves when the recording grows");

    // Poll economy: repeating the current etag answers unchanged without a body.
    const unchanged = await runSession(port, id, grown.data.etag);
    assert.equal(unchanged.data.unchanged, true);
    assert.equal(unchanged.data.session, null);
    assert.equal(unchanged.data.link, "linked");

    // The runs list carries the same link state for the dashboard.
    const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
    const listed = runs.find((r) => r.id === id);
    assert.equal(listed.link, "linked");
    assert.equal(listed.state, "running");
    assert.equal(listed.status, "running");
    assert.equal(listed.sessionPath, grown.data.sessionPath);
  });

  test("run session link survives a serve restart", SKIP_NO_TMUX, async () => {
    const { home, stubDir, workDir, port } = await bootSessionStub();

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "chat-live" })).body,
    );
    const linked = await pollUntil(
      async () => {
        const s = await runSession(port, id);
        return s.status === 200 && s.data.link === "linked" ? s : null;
      },
      { label: "run session linked before the restart" },
    );

    // SIGKILL serve mid-run — the link lives in tmux (@tq_session), not in serve.
    await stopServe(serveChildren.pop());
    const port2 = await allocEphemeralPort();
    spawnServe(port2, home, stubEnv(stubDir));
    await waitForHttp(port2, "/api/agents");

    const after = await runSession(port2, id);
    assert.equal(after.status, 200);
    assert.equal(after.data.link, "linked", "a fresh serve answers the SAME link from persisted tmux state");
    assert.equal(after.data.sessionPath, linked.data.sessionPath);
    assert.ok(after.data.session.eventCount >= 2, "the unified session is served after the restart");
  });

  test("run session of an exited run stays served with state exited", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootSessionStub();

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "chat-exit" })).body,
    );
    const s = await pollUntil(
      async () => {
        const got = await runSession(port, id);
        return got.status === 200 && got.data.run.status === "exited" && got.data.link === "linked" ? got : null;
      },
      { label: "exited run with a linked session" },
    );
    assert.equal(s.data.state, "exited");
    assert.ok(s.data.session.eventCount >= 2, "the final conversation stays served after exit");
    assert.equal(s.data.session.events[0].text, "first user prompt");
  });

  test("two NON-HOLDING runs in one cwd (<2s stagger): both link their own transcript via spawn identity", SKIP_NO_TMUX, async () => {
    // Round-2 regression: two concurrent runs in one cwd whose agents —
    // like the real claude CLI — write their recordings open/append/close
    // and NEVER hold an fd on them. Under fd-based identity this scenario
    // deadlocked: both files contested, both runs pending FOREVER while
    // their recordings sat on disk. Spawn identity (--session-id uuid →
    // <uuid>.jsonl) makes attribution deterministic with ZERO fd evidence.
    // The 700ms stagger is inside the 2s birth-gate slack — the worst case
    // the r2 critic reproduced (both runs' gates admit both files).
    const home = mkHome("tq-race-home-");
    const stubDir = mkStubAgentDir(raceStubScript(home));
    const workDir = mkHome("tq-race-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");

    const a = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "race-slow-a" })).body,
    ).id;
    await new Promise((r) => setTimeout(r, 700));
    const b = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "race-fast-b" })).body,
    ).id;
    assert.notEqual(a, b);
    const sidOf = { [a]: tqSessionIdOf(a), [b]: tqSessionIdOf(b) };
    assert.match(sidOf[a], /^[0-9a-f-]{36}$/i);
    assert.match(sidOf[b], /^[0-9a-f-]{36}$/i);
    assert.notEqual(sidOf[a], sidOf[b], "each run mints its own session uuid");

    // Poll BOTH runs until each is linked. THE invariant, checked at every
    // single observation: a run only ever reports the recording NAMED by
    // its own spawn uuid — never the other run's.
    const assertOwn = (id, s) => {
      if (s.sessionPath == null) return;
      assert.ok(
        s.sessionPath.endsWith(`/${sidOf[id]}.jsonl`),
        `run ${id} answered a recording that is not its own uuid: ${s.sessionPath}`,
      );
    };
    let sawBLinkedWhileAPending = false;
    const linked = { [a]: null, [b]: null };
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(linked[a] && linked[b])) {
      for (const id of [a, b]) {
        const s = await runSession(port, id);
        assert.equal(s.status, 200);
        assertOwn(id, s.data);
        if (s.data.link === "linked") linked[id] = s.data;
      }
      if (linked[b] && !linked[a]) sawBLinkedWhileAPending = true;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.ok(linked[b], "fast run B must link (the r2 deadlock left it pending forever)");
    assert.ok(linked[a], "slow run A must link once its agent finally writes");
    assert.ok(
      sawBLinkedWhileAPending,
      "B links promptly while A is still pending (A never borrows B's transcript to fake progress)",
    );
    assert.equal(linked[a].session.events[0].text, "prompt of race-slow-a");
    assert.equal(linked[b].session.events[0].text, "prompt of race-fast-b");
    assert.equal(linked[a].attribution, "sid", "spawn identity — no fd evidence exists to confirm");
    assert.equal(linked[b].attribution, "sid", "spawn identity — no fd evidence exists to confirm");

    // Prove the premise: NOTHING holds either recording open (the real
    // claude behavior the r2 critic verified with lsof exiting 1).
    for (const id of [a, b]) {
      const lsof = spawnSync("/usr/sbin/lsof", ["--", linked[id].sessionPath], { encoding: "utf8" });
      assert.notEqual(lsof.status, 0, `no process may hold ${linked[id].sessionPath} open`);
    }

    // The persisted tmux state carries the SAME correct attribution (this is
    // what survives serve restarts — nothing sticky-poisons).
    const opts = rawTmux([
      "list-windows", "-t", `=${SESSION}`, "-F",
      "#{window_id}\t#{@tq_session_attr}\t#{@tq_session}",
    ]);
    const rows = new Map(
      String(opts.stdout || "").split("\n").filter(Boolean).map((l) => {
        const [id, attr, path] = l.split("\t");
        return [id, { attr, path }];
      }),
    );
    assert.equal(rows.get(a)?.attr, "sid");
    assert.ok(rows.get(a)?.path.endsWith(`${sidOf[a]}.jsonl`));
    assert.equal(rows.get(b)?.attr, "sid");
    assert.ok(rows.get(b)?.path.endsWith(`${sidOf[b]}.jsonl`));
  });

  test("a user's own session in the run cwd is NEVER served — the run pends until ITS uuid recording appears", SKIP_NO_TMUX, async () => {
    // Round-2 scenario (b): the user opens their own claude chat in the
    // same directory right after a run starts. The run's agent (non-
    // holding, like real claude) is slow to write. The heuristic layer
    // used to link the USER'S session to the run and serve their private
    // conversation permanently. Spawn identity forbids it: the run's only
    // possible recording is <its-uuid>.jsonl.
    const home = mkHome("tq-usersteal-home-");
    const stubDir = mkStubAgentDir(sessionStubScript(home));
    const workDir = mkHome("tq-usersteal-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "user-race" })).body,
    );
    const sid = tqSessionIdOf(id);
    assert.match(sid, /^[0-9a-f-]{36}$/i);

    // The user's own session appears in the SAME cwd, born after the run's
    // start — inside the birth gate, exactly the r2 mislink bait.
    const slug = "-" + realpathSync(workDir).replace(/^\//, "").replace(/\//g, "-");
    const userDir = join(home, ".claude", "projects", slug);
    mkdirSync(userDir, { recursive: true });
    const userFile = join(userDir, "aaaaaaaa-0000-4000-8000-000000000000.jsonl");
    writeFileSync(userFile, [
      '{"type":"user","sessionId":"users-own","cwd":"/w","timestamp":"2026-08-11T10:00:00.000Z","uuid":"u-user","isMeta":false,"message":{"content":[{"type":"text","text":"USERS-PRIVATE-QUESTION"}]}}',
      '{"type":"assistant","sessionId":"users-own","timestamp":"2026-08-11T10:00:05.000Z","uuid":"a-user","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"USERS-PRIVATE-ANSWER"}],"usage":{"input_tokens":1,"output_tokens":2}}}',
      "",
    ].join("\n"));

    // At EVERY poll: pending or the run's own uuid file — the user's
    // conversation must never leak into the run's chat.
    let sawPending = false;
    let final = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !final) {
      const s = await runSession(port, id);
      assert.equal(s.status, 200);
      if (s.data.sessionPath != null) {
        assert.ok(
          s.data.sessionPath.endsWith(`/${sid}.jsonl`),
          `run served a foreign recording (the user's?): ${s.data.sessionPath}`,
        );
        final = s.data;
      } else {
        sawPending = true;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(sawPending, "the run honestly pends while only the user's session exists");
    assert.ok(final, "the run links its OWN recording once its agent writes it");
    assert.equal(final.attribution, "sid");
    assert.ok(!JSON.stringify(final.session).includes("USERS-PRIVATE"), "user transcript never served");
  });

  test("a poisoned pre-upgrade claim on an identified run heals across a serve restart", SKIP_NO_TMUX, async () => {
    // Round-2 scenario (b), restart flavor: a heuristic mislink to the
    // user's session persisted in tmux (as an older tracequest would have)
    // used to survive serve restarts and be served forever. On an
    // identified run any non-sid claim is dropped and CLEARED on the first
    // poll — the run answers pending, never the user's transcript.
    const home = mkHome("tq-heal-home-");
    const stubDir = mkStubAgentDir(sessionStubScript(home));
    const workDir = mkHome("tq-heal-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");

    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "no-session" })).body,
    );

    // Plant the user's session and the poisoned legacy claim in tmux.
    const slug = "-" + realpathSync(workDir).replace(/^\//, "").replace(/\//g, "-");
    const userDir = join(home, ".claude", "projects", slug);
    mkdirSync(userDir, { recursive: true });
    const userFile = join(userDir, "users-own-chat.jsonl");
    writeFileSync(userFile, '{"type":"user","sessionId":"users-own","message":{"content":[{"type":"text","text":"USERS-PRIVATE-QUESTION"}]}}\n');
    rawTmux(["set-option", "-w", "-t", id, "@tq_session", userFile]);
    rawTmux(["set-option", "-w", "-t", id, "@tq_session_attr", "heur"]);

    // Restart serve — the poisoned link now arrives from persisted tmux
    // state, exactly as it would after a real upgrade.
    await stopServe(serveChildren.pop());
    const port2 = await allocEphemeralPort();
    spawnServe(port2, home, stubEnv(stubDir));
    await waitForHttp(port2, "/api/agents");

    const healed = await httpGet(port2, `/api/runs/session?id=${encodeURIComponent(id)}`);
    assert.equal(healed.status, 200);
    const data = JSON.parse(healed.body);
    assert.equal(data.link, "pending", "the poisoned claim is dropped, not served");
    assert.equal(data.sessionPath, null);
    assert.equal(data.session, null, "the user's transcript is never served");
    // And the claim is CLEARED from tmux, not just masked.
    const cleared = String(rawTmux(["display-message", "-p", "-t", id, "#{@tq_session}"]).stdout || "").trim();
    assert.equal(cleared, "", "@tq_session cleared so the poison cannot resurface");
  });

  test("run session rejects malformed and unknown ids and answers pending before any recording exists", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootSessionStub();

    for (const id of ["bogus", "5", "@x", ""]) {
      const res = await httpGet(port, `/api/runs/session?id=${encodeURIComponent(id)}`);
      assert.equal(res.status, 400, `id ${JSON.stringify(id)} must answer 400`);
    }
    const unknown = await httpGet(port, "/api/runs/session?id=%4099999");
    assert.equal(unknown.status, 404, "unknown run id must answer 404");
    assert.match(JSON.parse(unknown.body).error, /@99999/);

    // A run whose agent never writes a recording answers the pending shape.
    const { id } = JSON.parse(
      (await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "no-session" })).body,
    );
    const pending = await runSession(port, id);
    assert.equal(pending.status, 200);
    assert.equal(pending.data.link, "pending");
    assert.equal(pending.data.state, "running");
    assert.equal(pending.data.run.status, "running");
    assert.equal(pending.data.session, null);
    assert.equal(pending.data.sessionPath, null);
  });
});

describe("launch integration — non-identity attribution (tombstones + prompt corroboration, the r3 kill-launder fix)", () => {
  afterEach(() => {
    if (TMUX) {
      killRunWindows();
      // Tombstones are session-level state — clear them so scenarios stay
      // independent (a real kill-window leaves them behind by design).
      rawTmux(["set-option", "-t", `=${SESSION}:`, "-u", "@tq_tombstones"]);
    }
  });

  /** Boot serve with the NON-identity cursor-agent stub (or a custom one). */
  async function bootCursorStub(script = null) {
    const home = mkHome("tq-nonid-home-");
    const stubDir = mkStubAgentDir(script ? script(home) : cursorStubScript(home), "cursor-agent");
    const workDir = mkHome("tq-nonid-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");
    return { home, stubDir, workDir, port };
  }

  async function runSession(port, id, etag) {
    const query = `id=${encodeURIComponent(id)}${etag ? `&etag=${encodeURIComponent(etag)}` : ""}`;
    const res = await httpGet(port, `/api/runs/session?${query}`);
    return { status: res.status, data: JSON.parse(res.body) };
  }

  async function createRun(port, workDir, prompt) {
    const body = { agent: "cursor-agent", cwd: workDir };
    if (prompt) body.prompt = prompt;
    const res = await httpPost(port, "/api/runs", body);
    assert.equal(res.status, 200, `POST /api/runs failed: ${res.body}`);
    return JSON.parse(res.body).id;
  }

  test("kill-laundering (r3): dismissing the fast rival NEVER hands its transcript to the slow survivor — before or after a serve restart", SKIP_NO_TMUX, async () => {
    const { home, stubDir, workDir, port } = await bootCursorStub();

    // The critic's exact repro: A "slow-alpha" writes at t+4s, B
    // "fast-beta" writes immediately, one cwd, NO --session-id mechanism.
    const idA = await createRun(port, workDir, "slow-alpha");
    const idB = await createRun(port, workDir, "fast-beta");

    // B's recording is contested by birth time, but its first user message
    // IS B's prompt and nobody else's: content identity links it to B
    // while BOTH runs live — no more contested-forever.
    const bLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idB);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "run B linked to its own recording while contested" },
    );
    assert.equal(bLinked.data.attribution, "prompt", "content corroboration, not a birth-time guess");
    assert.ok(JSON.stringify(bLinked.data.session.events).includes("fast-beta"));
    const bPath = bLinked.data.sessionPath;

    // A meanwhile: pending — B's file is foreign to it at every poll.
    const aBefore = await runSession(port, idA);
    assert.equal(aBefore.data.link, "pending", "the slow run must not claim the fast run's file");

    // Dismiss B (the documented dismissal action). Its claim must outlive
    // the window via the session-level tombstone.
    const killRes = await httpPost(port, "/api/runs/kill", { id: idB });
    assert.equal(killRes.status, 200, `kill failed: ${killRes.body}`);

    // The r3 failure fired HERE: with B's window gone, A deterministically
    // linked B's file. Now: A must stay pending — poll for a while and
    // assert B's transcript is never served for A.
    for (let i = 0; i < 6; i++) {
      const s = await runSession(port, idA);
      assert.equal(s.status, 200);
      assert.notEqual(s.data.sessionPath, bPath, "the survivor NEVER links the dismissed run's file");
      if (s.data.session) {
        assert.ok(!JSON.stringify(s.data.session.events).includes("fast-beta"),
          "the dismissed run's conversation must never appear in the survivor's chat");
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    // A's OWN recording lands (t+4s) — A links it, content-corroborated.
    const aLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "run A linked to its own late recording", timeoutMs: 15_000 },
    );
    assert.equal(aLinked.data.attribution, "prompt");
    assert.notEqual(aLinked.data.sessionPath, bPath);
    const aEvents = JSON.stringify(aLinked.data.session.events);
    assert.ok(aEvents.includes("slow-alpha"), "A serves ITS conversation");
    assert.ok(!aEvents.includes("fast-beta"));

    // Restart serve: the tombstone (tmux session option) and the link
    // (window option) both survive — A still serves its own conversation.
    await stopServe(serveChildren.pop());
    const port2 = await allocEphemeralPort();
    spawnServe(port2, home, stubEnv(stubDir));
    await waitForHttp(port2, "/api/agents");
    const after = await runSession(port2, idA);
    assert.equal(after.data.link, "linked");
    assert.equal(after.data.sessionPath, aLinked.data.sessionPath);
    assert.equal(after.data.attribution, "prompt");
    assert.ok(JSON.stringify(after.data.session.events).includes("slow-alpha"));
  });

  test("two live prompted runs, one cwd: prompt corroboration disambiguates — each links its OWN transcript with both alive", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootCursorStub();
    const idA = await createRun(port, workDir, "slow-alpha-two");
    const idB = await createRun(port, workDir, "fast-beta-two");

    const bLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idB);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "run B linked while its rival lives" },
    );
    const aLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "run A linked while its rival lives", timeoutMs: 15_000 },
    );
    assert.equal(aLinked.data.attribution, "prompt");
    assert.equal(bLinked.data.attribution, "prompt");
    assert.notEqual(aLinked.data.sessionPath, bLinked.data.sessionPath);
    assert.ok(JSON.stringify(aLinked.data.session.events).includes("slow-alpha-two"));
    assert.ok(!JSON.stringify(aLinked.data.session.events).includes("fast-beta-two"));
    assert.ok(JSON.stringify(bLinked.data.session.events).includes("fast-beta-two"));
    assert.ok(!JSON.stringify(bLinked.data.session.events).includes("slow-alpha-two"));
    // Both runs stay RUNNING throughout — disambiguation needed no dismissal.
    const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
    assert.equal(runs.filter((r) => r.status !== "exited").length, 2);
  });

  test("BARE survivor: a dismissed prompted rival stays out of its chat across a restart; its own late recording links heuristically", SKIP_NO_TMUX, async () => {
    const { home, stubDir, workDir, port } = await bootCursorStub();
    // A: bare launch (no prompt — no content identity of its own; writes
    // "typed-interactively" text at t+6s). B: prompted, writes at once.
    const idA = await createRun(port, workDir, null);
    const idB = await createRun(port, workDir, "fast-beta-bare");

    const bLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idB);
        return s.status === 200 && s.data.link === "linked" ? s : null;
      },
      { label: "run B linked before its dismissal" },
    );
    const bPath = bLinked.data.sessionPath;

    // Dismiss B, then RESTART serve — the only claim keeping B's file out
    // of bare A's candidate space is now the persisted tombstone.
    assert.equal((await httpPost(port, "/api/runs/kill", { id: idB })).status, 200);
    await stopServe(serveChildren.pop());
    const port2 = await allocEphemeralPort();
    spawnServe(port2, home, stubEnv(stubDir));
    await waitForHttp(port2, "/api/agents");

    for (let i = 0; i < 5; i++) {
      const s = await runSession(port2, idA);
      assert.equal(s.status, 200);
      assert.notEqual(s.data.sessionPath, bPath,
        "a restart must not launder the dismissed run's file into the bare survivor");
      await new Promise((r) => setTimeout(r, 200));
    }

    const aLinked = await pollUntil(
      async () => {
        const s = await runSession(port2, idA);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "bare run A linked to its own late recording", timeoutMs: 15_000 },
    );
    assert.notEqual(aLinked.data.sessionPath, bPath);
    assert.equal(aLinked.data.attribution, "heuristic",
      "a bare run's link is an honest guess, not fabricated content identity");
    const aEvents = JSON.stringify(aLinked.data.session.events);
    assert.ok(aEvents.includes("typed-interactively-by-user"));
    assert.ok(!aEvents.includes("fast-beta-bare"));
  });

  test("r5 regression: a promptless run DEMOTES its guess when its own recording lands beside the user's session — pending, cleared, never finalized at exit", SKIP_NO_TMUX, async () => {
    const { home, workDir, port } = await bootCursorStub();

    // Bare launch: the stub agent sleeps 6s before writing its recording —
    // the window in which the r5 critic's "ordinary user behavior" fired.
    const idA = await createRun(port, workDir, null);

    // The user opens their OWN session in the same cwd while the agent is
    // still starting up — written in the REAL cursor layout, the same
    // candidate space the stub agent writes into.
    const userFile = writeCursorUserSession(home, workDir, "aaaaaaaa-1111-4000-8000-user0session", [
      cursorRow("user", "USERS-PRIVATE-CHAT do not show this in a run"),
      cursorRow("assistant", "private reply"),
    ]);

    // Sole-candidate phase: the guess may serve (the information to refuse
    // it does not exist yet) — but it must be labeled a heuristic.
    const guessed = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.link === "linked" ? s : null;
      },
      { label: "bare run guessed the sole candidate" },
    );
    assert.equal(guessed.data.attribution, "heuristic");
    assert.equal(guessed.data.sessionPath, userFile);

    // The run's OWN recording lands (t+6s): the r5 gap fired HERE — the
    // persisted guess was KEPT ("wins while eligible") and the user's
    // private chat stayed the run's transcript forever. Now: a second
    // eligible candidate demotes the guess to pending.
    const demoted = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.link === "pending" ? s : null;
      },
      { label: "guess demoted to pending once the own recording appeared", timeoutMs: 15_000 },
    );
    assert.equal(demoted.data.sessionPath, null);
    assert.equal(demoted.data.attribution, null);

    // The demotion is durable — the user's chat never comes back.
    for (let i = 0; i < 5; i++) {
      const s = await runSession(port, idA);
      assert.equal(s.data.link, "pending", "two indistinguishable recordings: pending beats wrong");
      await new Promise((r) => setTimeout(r, 150));
    }

    // Exit the run (C-c). An exited run must NOT finalize a guess that was
    // ambiguous at death — pre-fix the user's session became the final
    // answer forever here.
    const stop = await httpPost(port, "/api/runs/input", { id: idA, key: "C-c" });
    assert.equal(stop.status, 200, `C-c failed: ${stop.body}`);
    const exited = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.state === "exited" ? s : null;
      },
      { label: "run exited after C-c", timeoutMs: 15_000 },
    );
    assert.equal(exited.data.link, "pending", "ambiguous at death: never finalized");
    assert.equal(exited.data.sessionPath, null);
    for (let i = 0; i < 3; i++) {
      const s = await runSession(port, idA);
      assert.equal(s.data.link, "pending");
      assert.equal(s.data.state, "exited");
      await new Promise((r) => setTimeout(r, 150));
    }
  });

  test("r7 regression: a promptless run that CRASHES before writing anything never binds the user's session born in its window", SKIP_NO_TMUX, async () => {
    // Zero affirmative evidence anywhere: no spawn uuid (cursor-agent has
    // none), no prompt, no fd holder, and nothing the run itself wrote.
    // Pre-fix the sole-eligible-at-death rule finalized the user's private
    // chat as this run's transcript, permanently. The honest answer is
    // "pending" — a run that died in 200ms proved nothing.
    const crashStub = () => '#!/bin/sh\necho "tq-stub-crash:$@"\nexit 1\n';
    const { home, workDir, port } = await bootCursorStub(crashStub);
    const idA = await createRun(port, workDir, null);
    const userFile = writeCursorUserSession(home, workDir, "dddddddd-4444-4000-8000-crashwindow0", [
      cursorRow("user", "USERS-PRIVATE-CHAT never attributable to a crashed run"),
      cursorRow("assistant", "private reply"),
    ]);

    const exited = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.state === "exited" ? s : null;
      },
      { label: "the crashing run was observed dead", timeoutMs: 15_000 },
    );
    assert.equal(exited.data.link, "pending");

    // …and it stays pending on every later poll (no late finalization once
    // the file ages past any probation window).
    for (let i = 0; i < 12; i++) {
      const s = await runSession(port, idA);
      assert.equal(s.data.link, "pending", "a run that wrote nothing must never own a stranger's recording");
      assert.notEqual(s.data.sessionPath, userFile);
      await new Promise((r) => setTimeout(r, 400));
    }
  });
});

/**
 * TWIN stub agent for the r4 contest-memory lane (cursor-agent shaped,
 * non-identity): "twin-*" prompts model the critic's dismissed-twin vector
 * — the FIRST twin instance (marker absent) writes its recording at once,
 * every later one sleeps 8s first, so two runs with the IDENTICAL prompt
 * split into a fast twin and a slow survivor. "cycle-*" prompts never
 * write at all — pure create+kill fodder for the dismissal flood.
 */
function twinStubScript(home) {
  return [
    "#!/bin/sh",
    'echo "tq-stub:$@"',
    'PROMPT=""; prev=""',
    'for arg in "$@"; do',
    '  case "$prev" in --) PROMPT="$arg";; esac',
    '  prev="$arg"',
    "done",
    'case "$PROMPT" in cycle-*) sleep 30; exit 0;; esac',
    ...CURSOR_LAYOUT_SH(home),
    'case "$PROMPT" in',
    "  twin-*)",
    '    marker="$dir/.twin-marker"',
    '    if [ ! -e "$marker" ]; then : > "$marker"; else sleep 8; fi',
    "    ;;",
    "esac",
    'cat > "$f" <<EOF',
    '{"role":"user","message":{"content":[{"type":"text","text":"$PROMPT"}]}}',
    '{"role":"assistant","message":{"content":[{"type":"text","text":"REPLY-FROM:$PROMPT"}]}}',
    "EOF",
    "sleep 30",
    "",
  ].join("\n");
}

describe("launch integration — contest memory outlives dismissal floods and tmux-direct kills (the r4 fix)", () => {
  afterEach(() => {
    if (TMUX) killRunWindows();
  });

  async function bootStub(script, home) {
    const stubDir = mkStubAgentDir(script, "cursor-agent");
    const workDir = mkHome("tq-r4-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");
    return { stubDir, workDir, port };
  }

  async function runSession(port, id) {
    const res = await httpGet(port, `/api/runs/session?id=${encodeURIComponent(id)}`);
    return { status: res.status, data: JSON.parse(res.body) };
  }

  async function createRun(port, workDir, prompt) {
    const body = { agent: "cursor-agent", cwd: workDir };
    if (prompt) body.prompt = prompt;
    const res = await httpPost(port, "/api/runs", body);
    assert.equal(res.status, 200, `POST /api/runs failed: ${res.body}`);
    return JSON.parse(res.body).id;
  }

  function sessionFilesUnder(home) {
    // Real layout: recordings live at agent-transcripts/<uuid>/<uuid>.jsonl.
    const out = spawnSync("find", [join(home, ".cursor", "projects"), "-name", "*.jsonl"], {
      encoding: "utf8",
    });
    return String(out.stdout || "").split("\n").filter(Boolean);
  }

  function readTombstones() {
    const out = rawTmux(["show-options", "-v", "-t", `=${SESSION}:`, "@tq_tombstones"]);
    try {
      return JSON.parse(Buffer.from(String(out.stdout || "").trim(), "base64").toString("utf8"));
    } catch {
      return [];
    }
  }

  test("r4 vector 1: 32+ routine dismissals never evict the stone keeping the dismissed twin's contest honest", SKIP_NO_TMUX, async () => {
    const home = mkHome("tq-r4-flood-home-");
    const { workDir, port } = await bootStub(twinStubScript(home), home);

    // The critic's exact repro: two runs with the IDENTICAL prompt (honest
    // pending while both live), the fast twin dismissed, then a flood of
    // pure create+kill cycles pushing a tombstone each.
    const idB = await createRun(port, workDir, "twin-secret-fast-task");
    // Let the twin's shell claim the first-writer marker before its twin spawns.
    await pollUntil(async () => sessionFilesUnder(home).length === 1, { label: "twin B's recording" });
    const [bPath] = sessionFilesUnder(home);
    const idA = await createRun(port, workDir, "twin-secret-fast-task");

    // Identical prompts prove nothing: both honest-pending while both live.
    const a0 = await runSession(port, idA);
    assert.equal(a0.data.link, "pending");

    // Dismiss the twin, then flood: 40 routine create+kill dismissals.
    assert.equal((await httpPost(port, "/api/runs/kill", { id: idB })).status, 200);
    for (let i = 0; i < 40; i++) {
      const cid = await createRun(port, workDir, `cycle-${i}`);
      assert.equal((await httpPost(port, "/api/runs/kill", { id: cid })).status, 200, `cycle ${i} kill`);
    }
    const stones = readTombstones();
    assert.ok(stones.length <= 64, `tombstones stay bounded (got ${stones.length})`);

    // Pre-fix, the 33rd dismissal evicted the twin's stone and A linked the
    // dismissed twin's recording attr "prompt". Now: A must NEVER serve it.
    for (let i = 0; i < 6; i++) {
      const s = await runSession(port, idA);
      assert.equal(s.status, 200);
      assert.notEqual(s.data.sessionPath, bPath,
        "the survivor NEVER links the dismissed twin's recording — however many dismissals followed");
      await new Promise((r) => setTimeout(r, 200));
    }

    // A's OWN recording (written at t+8s, after every stone's death) links,
    // content-corroborated — coverage stayed, only precision folded.
    const aLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "survivor linked to its own late recording", timeoutMs: 20_000 },
    );
    assert.notEqual(aLinked.data.sessionPath, bPath);
    assert.equal(aLinked.data.attribution, "prompt");
  });

  test("r4 vector 2: a run window killed DIRECTLY in tmux (kill-window, no API) still leaves a tombstone — synthesized from the run ledger, even across a serve restart", SKIP_NO_TMUX, async () => {
    const home = mkHome("tq-r4-tmux-home-");
    const { stubDir, workDir, port } = await bootStub(cursorStubScript(home), home);

    // Bare survivor A (no prompt — no self-recognition to fall back on;
    // writes "typed-interactively" at t+6s) + prompted fast B.
    const idA = await createRun(port, workDir, null);
    const idB = await createRun(port, workDir, "secret-fast-task-e");

    const bLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idB);
        return s.status === 200 && s.data.link === "linked" ? s : null;
      },
      { label: "run B linked before the tmux-direct kill" },
    );
    const bPath = bLinked.data.sessionPath;
    // One more poll so the persisted ledger carries B's claim.
    await httpGet(port, "/api/runs");

    // Kill B DIRECTLY in tmux — the prefix-& path that never touches
    // POST /api/runs/kill — and do it while serve is DOWN, so only the
    // persisted ledger knows B ever existed.
    await stopServe(serveChildren.pop());
    rawTmux(["kill-window", "-t", idB]);
    const port2 = await allocEphemeralPort();
    spawnServe(port2, home, stubEnv(stubDir));
    await waitForHttp(port2, "/api/agents");

    // Pre-fix, A linked B's recording heuristically and served the dead
    // run's transcript forever. Now: the first poll synthesizes B's
    // tombstone from the ledger diff and A stays honest.
    for (let i = 0; i < 6; i++) {
      const s = await runSession(port2, idA);
      assert.equal(s.status, 200);
      assert.notEqual(s.data.sessionPath, bPath,
        "the survivor NEVER serves the tmux-killed run's transcript");
      if (s.data.session) {
        assert.ok(!JSON.stringify(s.data.session.events).includes("secret-fast-task-e"),
          "the dead run's conversation must never appear in the survivor's chat");
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    const stones = readTombstones();
    assert.ok(stones.some((t) => t.id === idB && t.session === bPath),
      "B's synthesized tombstone carries its claim");

    // A's own recording (t+6s) links; B's file sits untouched beside it.
    const aLinked = await pollUntil(
      async () => {
        const s = await runSession(port2, idA);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "bare survivor linked to its own recording", timeoutMs: 20_000 },
    );
    assert.notEqual(aLinked.data.sessionPath, bPath);
    const aEvents = JSON.stringify(aLinked.data.session.events);
    assert.ok(aEvents.includes("typed-interactively-by-user"));
    assert.ok(!aEvents.includes("secret-fast-task-e"));
  });

  test("r4 vector 3: a user session opening with the run's exact prompt is dropped (ambiguous, pending) once the run's own recording lands", SKIP_NO_TMUX, async () => {
    const home = mkHome("tq-r4-collide-home-");
    const { workDir, port } = await bootStub(cursorStubScript(home), home);

    // The run writes its recording at t+4s ("slow-*" branch). Meanwhile the
    // USER's own session — first message EQUAL to the launch prompt —
    // appears in the same cwd.
    const idA = await createRun(port, workDir, "slow-collide-task");
    const userPath = writeCursorUserSession(home, workDir, "bbbbbbbb-2222-4000-8000-collide00000", [
      cursorRow("user", "slow-collide-task"),
      cursorRow("assistant", "USERS-OWN-CONVERSATION"),
    ]);

    // Until the run's own recording exists, the user session is
    // indistinguishable from it — it may serve transiently. The contract
    // under test: the moment equality exists TWICE, the claim is dropped.
    const twoFiles = await pollUntil(
      async () => sessionFilesUnder(home).length === 2,
      { label: "the run's own recording landed", timeoutMs: 15_000 },
    );
    assert.ok(twoFiles);
    const settled = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.sessionPath !== userPath ? s : null;
      },
      { label: "the user's session dropped from the run", timeoutMs: 10_000 },
    );
    // Ambiguity resolves to PENDING — never to the wrong transcript.
    assert.equal(settled.data.link, "pending", "equal-prompt collision is ambiguous: prefer pending over wrong");
    for (let i = 0; i < 5; i++) {
      const s = await runSession(port, idA);
      assert.notEqual(s.data.sessionPath, userPath, "the user's transcript is never served again");
      assert.equal(s.data.link, "pending");
      await new Promise((r) => setTimeout(r, 200));
    }

    // The collision disappearing (user deletes their session) restores
    // unique corroboration: the run links its OWN recording.
    rmSync(userPath);
    const aLinked = await pollUntil(
      async () => {
        const s = await runSession(port, idA);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "run linked its own recording after the collision cleared", timeoutMs: 10_000 },
    );
    assert.equal(aLinked.data.attribution, "prompt");
    assert.notEqual(aLinked.data.sessionPath, userPath);
    assert.ok(!JSON.stringify(aLinked.data.session.events).includes("USERS-OWN-CONVERSATION"));
  });
});

describe("launch integration — input to a run", () => {
  afterEach(() => {
    if (TMUX) killRunWindows();
  });

  async function bootEchoRun() {
    const { workDir, port } = await bootServeWithStub({}, { stubScript: ECHO_STUB_SCRIPT });
    const created = await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt: "echo-me" });
    assert.equal(created.status, 200, `run create failed: ${created.body}`);
    const { id } = JSON.parse(created.body);
    // The stub's banner proves the read loop is up before input is sent.
    await pollUntil(
      async () => {
        const res = await httpGet(port, `/api/runs/snapshot?id=${encodeURIComponent(id)}`);
        return res.status === 200 && JSON.parse(res.body).html.includes("-- echo-me");
      },
      { label: "echo stub banner in snapshot" },
    );
    return { port, id };
  }

  async function snapshotHtml(port, id) {
    const res = await httpGet(port, `/api/runs/snapshot?id=${encodeURIComponent(id)}`);
    return res.status === 200 ? JSON.parse(res.body).html : "";
  }

  test("input sends text and Enter to a run", SKIP_NO_TMUX, async () => {
    const { port, id } = await bootEchoRun();

    // {text, key:"Enter"} in ONE request: type a line, then submit it.
    const res = await httpPost(port, "/api/runs/input", {
      id,
      text: "hello-input",
      key: "Enter",
    });
    assert.equal(res.status, 200, `input failed: ${res.body}`);
    assert.deepEqual(JSON.parse(res.body), { ok: true });
    await pollUntil(
      async () => (await snapshotHtml(port, id)).includes("GOT:hello-input"),
      { label: "echoed input line in snapshot" },
    );

    // Literal-text edge: "Enter;-l" must arrive VERBATIM — never parsed as
    // the Enter key name, a send-keys flag, or a tmux command separator.
    const literal = await httpPost(port, "/api/runs/input", {
      id,
      text: "Enter;-l",
      key: "Enter",
    });
    assert.equal(literal.status, 200, `literal input failed: ${literal.body}`);
    await pollUntil(
      async () => (await snapshotHtml(port, id)).includes("GOT:Enter;-l"),
      { label: "literal text echoed verbatim in snapshot" },
    );
  });

  test("input rejects an unknown key name", SKIP_NO_TMUX, async () => {
    const { port, id } = await bootEchoRun();

    const before = await snapshotHtml(port, id);
    const res = await httpPost(port, "/api/runs/input", { id, key: "C-d" });
    assert.equal(res.status, 400, "a key outside the allowlist must answer 400");
    const error = JSON.parse(res.body).error;
    for (const allowed of ["Enter", "C-c", "Escape", "Up", "Down", "Tab"]) {
      assert.ok(error.includes(allowed), `error must name allowed key ${allowed} (got: ${error})`);
    }
    // Nothing was sent: the pane content is unchanged and the run still runs.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await snapshotHtml(port, id), before, "rejected key must send nothing to the pane");
    const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
    assert.equal(runs.find((r) => r.id === id)?.status, "running");
  });

  test("input C-c interrupts a running run to exited", SKIP_NO_TMUX, async () => {
    const { port, id } = await bootEchoRun();

    const res = await httpPost(port, "/api/runs/input", { id, key: "C-c" });
    assert.equal(res.status, 200, `C-c failed: ${res.body}`);
    await pollUntil(
      async () => {
        const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
        return (runs.find((r) => r.id === id) || {}).status === "exited";
      },
      { label: "run exited after C-c (stub dies on SIGINT)" },
    );

    // Input to the now-exited run is refused with the documented 409.
    const refused = await httpPost(port, "/api/runs/input", { id, text: "too-late", key: "Enter" });
    assert.equal(refused.status, 409, "input to an exited run must answer 409");
    assert.match(JSON.parse(refused.body).error, /exited/);
  });
});

describe("launch integration — continue-resume (any session becomes a steerable run)", () => {
  afterEach(() => {
    if (TMUX) killRunWindows();
  });

  const ORIG_ID = "cccccccc-1111-4222-8333-444455556666";

  /**
   * Boot serve with the resume-modeling stub and plant an EXTERNAL claude
   * session (NOT started by tracequest — no run window exists for it)
   * recorded in workDir. Returns the source path serve will discover.
   */
  async function bootWithExternalSession() {
    const home = mkHome("tq-continue-home-");
    const stubDir = mkStubAgentDir(resumeStubScript(home));
    const workDir = mkHome("tq-continue-cwd-");
    const realCwd = realpathSync(workDir);
    const slug = "-" + realCwd.replace(/^\//, "").replace(/\//g, "-");
    const dir = join(home, ".claude", "projects", slug);
    mkdirSync(dir, { recursive: true });
    const srcPath = join(dir, `${ORIG_ID}.jsonl`);
    writeFileSync(srcPath, [
      JSON.stringify({ type: "user", sessionId: ORIG_ID, cwd: realCwd, timestamp: "2026-08-11T09:00:00.000Z", uuid: "u-ext", isMeta: false, message: { content: [{ type: "text", text: "EXTERNAL-PRIOR-QUESTION about the retry helper" }] } }),
      JSON.stringify({ type: "assistant", sessionId: ORIG_ID, timestamp: "2026-08-11T09:00:05.000Z", uuid: "a-ext", message: { model: "claude-sonnet-4-20250514", content: [{ type: "text", text: "EXTERNAL-PRIOR-ANSWER: added the wrapper" }], usage: { input_tokens: 3, output_tokens: 4 } } }),
      "",
    ].join("\n"));
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");
    return { home, realCwd, port, srcPath };
  }

  async function runSession(port, id) {
    const res = await httpGet(port, `/api/runs/session?id=${encodeURIComponent(id)}`);
    return { status: res.status, data: JSON.parse(res.body) };
  }

  test("continuing an external session launches a fork run that carries the prior context", SKIP_NO_TMUX, async () => {
    const { realCwd, port, srcPath } = await bootWithExternalSession();
    const srcHash = sessionHash(srcPath);

    // Continue by hash — no agent, no cwd: both derive from the source.
    const res = await httpPost(port, "/api/runs", { resumeSession: srcHash });
    assert.equal(res.status, 200, `resume failed: ${res.body}`);
    const { id, resumedFrom } = JSON.parse(res.body);
    assert.match(id, /^@\d+$/);
    assert.equal(resumedFrom, srcHash, "the response names the continued session");

    // tmux carries provenance + a FRESH fork identity, and the agent argv
    // is the documented claude fork-resume shape.
    const opts = String(
      rawTmux(["display-message", "-p", "-t", id, "#{@tq_resumed_from}\t#{@tq_session_id}\t#{@tq_cwd}"]).stdout || "",
    ).trim().split("\t");
    assert.equal(opts[0], srcHash, "@tq_resumed_from persisted in tmux");
    const forkSid = opts[1];
    assert.match(forkSid, /^[0-9a-f-]{36}$/i, "@tq_session_id is a fresh fork uuid");
    assert.notEqual(forkSid, ORIG_ID, "the fork NEVER reuses the source uuid");
    assert.equal(opts[2], realCwd, "cwd defaulted to the source session's recorded cwd");
    // The pane hard-wraps long argv lines, so match on the unwrapped text.
    const argvEcho = await pollUntil(
      () => {
        const captured = String(rawTmux(["capture-pane", "-p", "-t", id]).stdout || "").replace(/\n/g, "");
        return captured.includes("tq-stub:") ? captured : null;
      },
      { label: "resume stub argv echo" },
    );
    assert.ok(
      argvEcho.includes(`--resume ${ORIG_ID} --fork-session --session-id ${forkSid}`),
      `agent must receive the fork-resume argv (got: ${JSON.stringify(argvEcho)})`,
    );

    // The run links its OWN fork recording (tier-0 spawn identity), whose
    // transcript BEGINS with the source conversation — context carried —
    // and then grows with the new turns.
    const linked = await pollUntil(
      async () => {
        const s = await runSession(port, id);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "resumed run linked with a parsed session" },
    );
    assert.equal(linked.data.attribution, "sid", "fork identity, not a guess");
    assert.ok(linked.data.sessionPath.endsWith(`/${forkSid}.jsonl`), "the FORK recording, not the source");
    assert.equal(linked.data.run.resumedFrom, srcHash, "/api/runs/session exposes provenance");
    assert.equal(
      linked.data.session.events[0].text,
      "EXTERNAL-PRIOR-QUESTION about the retry helper",
      "the fork begins with the source conversation",
    );
    const grown = await pollUntil(
      async () => {
        const s = await runSession(port, id);
        return s.status === 200 && s.data.session &&
          JSON.stringify(s.data.session.events).includes("RESUMED-REPLY") ? s : null;
      },
      { label: "new turns appended to the fork" },
    );
    assert.ok(
      grown.data.session.events.some((e) => e.text && e.text.includes("EXTERNAL-PRIOR-ANSWER")),
      "prior assistant turn still in the continued transcript",
    );

    // The source recording is untouched — the fork is a NEW recording.
    assert.ok(!String(srcPath).endsWith(`${forkSid}.jsonl`));
    const runs = JSON.parse((await httpGet(port, "/api/runs")).body).runs;
    const listed = runs.find((r) => r.id === id);
    assert.equal(listed.resumedFrom, srcHash, "GET /api/runs carries provenance for the dashboard");
    assert.equal(listed.status, "running", "the continued run is fully steerable (running window)");
  });

  test("resume guards: unknown session 404, agent without a resume mechanism 400 — no window either way", SKIP_NO_TMUX, async () => {
    const { port, srcPath } = await bootWithExternalSession();

    const windowsBefore = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    const unknown = await httpPost(port, "/api/runs", { resumeSession: "0123abcd" });
    assert.equal(unknown.status, 404, `unknown session hash must answer 404 (got ${unknown.status}: ${unknown.body})`);
    assert.match(unknown.headers["content-type"], /application\/json/);
    assert.match(JSON.parse(unknown.body).error, /not found/i);

    const noMechanism = await httpPost(port, "/api/runs", {
      resumeSession: sessionHash(srcPath),
      agent: "gemini",
    });
    assert.equal(noMechanism.status, 400);
    assert.match(
      JSON.parse(noMechanism.body).error,
      /gemini.*no resume mechanism/,
      "the 400 honestly names the missing mechanism",
    );

    const windowsAfter = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    assert.equal(windowsAfter, windowsBefore, "no window may be created for a rejected resume");
  });
});

describe("launch integration — prompt validation hardening", () => {
  afterEach(() => {
    if (TMUX) killRunWindows();
  });

  test("oversized and control-character prompts are rejected with 400 JSON", SKIP_NO_TMUX, async () => {
    // Bugbash F1/F3: prompts in the ~16.3KB..64KB band made tmux
    // respawn-window fail ("command too long") and a NUL made execFileSync
    // throw — both surfaced as plaintext 500s. They must answer 400 JSON
    // before any tmux call.
    const { workDir, port } = await bootServeWithStub();

    const windowsBefore = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    const big = await httpPost(port, "/api/runs", {
      agent: "claude",
      cwd: workDir,
      prompt: "A".repeat(10 * 1024),
    });
    assert.equal(big.status, 400, `10KB prompt must answer 400 (got ${big.status}: ${big.body})`);
    assert.match(big.headers["content-type"], /application\/json/);
    assert.equal(JSON.parse(big.body).error, "prompt too long (max 8192 bytes)");

    const nul = await httpPost(port, "/api/runs", {
      agent: "claude",
      cwd: workDir,
      prompt: "a\u0000b",
    });
    assert.equal(nul.status, 400, `NUL prompt must answer 400 (got ${nul.status}: ${nul.body})`);
    assert.match(nul.headers["content-type"], /application\/json/);
    assert.match(JSON.parse(nul.body).error, /prompt/);

    const windowsAfter = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    );
    assert.equal(windowsAfter, windowsBefore, "no window may be created for a rejected prompt");
  });
});

/**
 * r8 — the CODEX dialect end-to-end (the r7 defect class: dialect drift).
 *
 * Real codex rollouts (verified against all 757 on a live machine) open with
 * the injected instruction context as the FIRST user response_item — a
 * "# AGENTS.md instructions for <path>" markdown block beside XML-wrapped
 * blocks — and carry the TRUE prompt later, as an event_msg user_message plus
 * its own user response_item. Until r8 the stubs in this file were
 * claude/cursor-shaped only, extraction served the injection as firstPrompt,
 * promptCorroborates failed against the launch prompt, and every prompted (or
 * resumed) codex run pended forever while its rollout sat on disk.
 */
describe("launch integration — codex dialect attribution (r8: AGENTS.md injection)", () => {
  afterEach(() => {
    if (TMUX) {
      killRunWindows();
      rawTmux(["set-option", "-t", `=${SESSION}:`, "-u", "@tq_tombstones"]);
    }
  });

  const CODEX_INJECTED_ITEM =
    '{"timestamp":"2026-08-12T13:00:00.100Z","type":"response_item","payload":{"type":"message","role":"user","content":['
    + '{"type":"input_text","text":"<recommended_plugins>\\nplugins…\\n</recommended_plugins>"},'
    + '{"type":"input_text","text":"# AGENTS.md instructions for /w\\n\\n<INSTRUCTIONS>injected, identical in EVERY rollout</INSTRUCTIONS>"},'
    + '{"type":"input_text","text":"<environment_context>\\n  <cwd>/w</cwd>\\n</environment_context>"}]}}';

  /**
   * NON-identity stub `codex` writing the REAL rollout dialect into the REAL
   * dated layout (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl), written
   * open/append/close — no fd held. Fresh launch (`codex -- <prompt>`)
   * writes injection-first + the true prompt; resume
   * (`codex resume <id> -- <prompt>`) writes a NEW fork rollout REPLAYING
   * the source conversation (injection first, then the source's opener),
   * then the follow-up — the source file is never touched.
   */
  function codexStubScript(home) {
    return [
      "#!/bin/sh",
      'echo "tq-stub:$@"',
      'PROMPT=""; RESUME=""; prev=""',
      'for arg in "$@"; do',
      '  case "$prev" in --) PROMPT="$arg";; resume) RESUME="$arg";; esac',
      '  prev="$arg"',
      "done",
      `d="${home}/.codex/sessions/2026/08/12"`,
      'mkdir -p "$d"',
      'f="$d/rollout-2026-08-12T13-00-00-stub-$$.jsonl"',
      "sleep 1",
      'if [ -n "$RESUME" ]; then',
      // Fork rollout: injection, replayed source opener, then the follow-up.
      '  cat > "$f" <<EOF',
      '{"timestamp":"2026-08-12T13:00:00.000Z","type":"session_meta","payload":{"id":"fork-$$","cwd":"$PWD","model_provider":"openai"}}',
      CODEX_INJECTED_ITEM,
      '{"timestamp":"2026-08-12T13:00:00.200Z","type":"event_msg","payload":{"type":"user_message","message":"codex-resume-source-opener"}}',
      '{"timestamp":"2026-08-12T13:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex-resume-source-opener"}]}}',
      '{"timestamp":"2026-08-12T13:00:00.400Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"REPLAYED-SOURCE-REPLY"}]}}',
      '{"timestamp":"2026-08-12T13:00:01.000Z","type":"event_msg","payload":{"type":"user_message","message":"$PROMPT"}}',
      '{"timestamp":"2026-08-12T13:00:01.100Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"$PROMPT"}]}}',
      '{"timestamp":"2026-08-12T13:00:05.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"RESUMED-REPLY to $PROMPT"}]}}',
      "EOF",
      "else",
      '  cat > "$f" <<EOF',
      '{"timestamp":"2026-08-12T13:00:00.000Z","type":"session_meta","payload":{"id":"fresh-$$","cwd":"$PWD","model_provider":"openai"}}',
      CODEX_INJECTED_ITEM,
      '{"timestamp":"2026-08-12T13:00:00.200Z","type":"event_msg","payload":{"type":"user_message","message":"$PROMPT"}}',
      '{"timestamp":"2026-08-12T13:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"$PROMPT"}]}}',
      '{"timestamp":"2026-08-12T13:00:05.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"REPLY to $PROMPT"}]}}',
      "EOF",
      "fi",
      "sleep 30",
      "",
    ].join("\n");
  }

  /** Seed a SOURCE rollout (real dialect) predating the run, for resume. */
  function seedSourceRollout(home) {
    const dir = join(home, ".codex", "sessions", "2026", "08", "10");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "rollout-2026-08-10T09-00-00-source-01.jsonl");
    writeFileSync(path, [
      '{"timestamp":"2026-08-10T09:00:00.000Z","type":"session_meta","payload":{"id":"src-source-01","cwd":"/w","model_provider":"openai"}}',
      CODEX_INJECTED_ITEM,
      '{"timestamp":"2026-08-10T09:00:00.200Z","type":"event_msg","payload":{"type":"user_message","message":"codex-resume-source-opener"}}',
      '{"timestamp":"2026-08-10T09:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"codex-resume-source-opener"}]}}',
      '{"timestamp":"2026-08-10T09:00:05.000Z","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"SOURCE-REPLY"}]}}',
      "",
    ].join("\n"));
    // A real resume's source is an OLD recording nobody is appending to —
    // backdate it so the clrs source-mtime fallback stays honestly idle.
    const old = new Date(Date.now() - 48 * 3600 * 1000);
    utimesSync(path, old, old);
    return path;
  }

  async function bootCodexStub() {
    const home = mkHome("tq-codex-dialect-home-");
    const stubDir = mkStubAgentDir(codexStubScript(home), "codex");
    const workDir = mkHome("tq-codex-dialect-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");
    return { home, stubDir, workDir, port };
  }

  async function runSession(port, id) {
    const res = await httpGet(port, `/api/runs/session?id=${encodeURIComponent(id)}`);
    return { status: res.status, data: JSON.parse(res.body) };
  }

  test("a prompted codex run links its OWN rollout despite the AGENTS.md injection (r7 regression: recording exists, must be served)", SKIP_NO_TMUX, async () => {
    const { workDir, port } = await bootCodexStub();
    const prompt = "codex-r8-fix the flaky auth test";
    const res = await httpPost(port, "/api/runs", { agent: "codex", cwd: workDir, prompt });
    assert.equal(res.status, 200, `POST /api/runs failed: ${res.body}`);
    const id = JSON.parse(res.body).id;

    const linked = await pollUntil(
      async () => {
        const s = await runSession(port, id);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "prompted codex run linked to its real-dialect rollout", timeoutMs: 15_000 },
    );
    assert.equal(linked.data.attribution, "prompt",
      "content corroboration must see the TRUE prompt through the AGENTS.md injection");
    const events = linked.data.session.events;
    const userTexts = events.filter((e) => e.type === "user").map((e) => e.text);
    assert.ok(userTexts.some((t) => t.includes(prompt)), "the chat serves the true prompt");
    assert.ok(!userTexts.some((t) => t.includes("AGENTS.md instructions")),
      "the injected instruction block is never a user bubble");
  });

  test("a RESUMED codex run links its fork rollout via the source's true first prompt — beside a concurrent decoy rollout", SKIP_NO_TMUX, async () => {
    const { home, workDir, port } = await bootCodexStub();
    const srcPath = seedSourceRollout(home);

    const res = await httpPost(port, "/api/runs", {
      resumeSession: srcPath,
      cwd: workDir,
      prompt: "codex-r8-follow-up question",
    });
    assert.equal(res.status, 200, `resume failed: ${res.body}`);
    const id = JSON.parse(res.body).id;

    // A concurrent unrelated codex session born in the resume's window —
    // before r8 EVERY rollout answered the identical AGENTS.md text as its
    // first prompt, so any second candidate was an equal-prompt collision
    // and resumed codex was dead. Distinct REAL prompts must disambiguate.
    const decoyDir = join(home, ".codex", "sessions", "2026", "08", "12");
    mkdirSync(decoyDir, { recursive: true });
    writeFileSync(join(decoyDir, "rollout-2026-08-12T13-00-00-decoy-01.jsonl"), [
      '{"timestamp":"2026-08-12T13:00:00.000Z","type":"session_meta","payload":{"id":"decoy-01","cwd":"/elsewhere","model_provider":"openai"}}',
      CODEX_INJECTED_ITEM,
      '{"timestamp":"2026-08-12T13:00:00.200Z","type":"event_msg","payload":{"type":"user_message","message":"unrelated user conversation"}}',
      '{"timestamp":"2026-08-12T13:00:00.300Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"unrelated user conversation"}]}}',
      "",
    ].join("\n"));

    const linked = await pollUntil(
      async () => {
        const s = await runSession(port, id);
        return s.status === 200 && s.data.link === "linked" && s.data.session ? s : null;
      },
      { label: "resumed codex run linked to its fork rollout", timeoutMs: 15_000 },
    );
    assert.equal(linked.data.attribution, "prompt",
      "tq_fork_prompt (the source's REAL opener) recognizes the fork rollout");
    assert.notEqual(linked.data.sessionPath, srcPath, "the fork, not the source, is the run's recording");
    assert.ok(!linked.data.sessionPath.includes("decoy"), "never the decoy");
    const all = JSON.stringify(linked.data.session.events);
    assert.ok(all.includes("codex-resume-source-opener"), "the fork replays the source conversation");
    assert.ok(all.includes("codex-r8-follow-up question"), "…and carries the follow-up");
    assert.ok(!all.includes("unrelated user conversation"));
  });
});
