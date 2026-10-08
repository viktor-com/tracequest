import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { formatCliError } from "../../src/cli/cli-die.js";
import { indexPath } from "../../src/sessions/index-writers.js";
import { searchIdxPath } from "../../src/sessions/search-index.js";
import { SESSION_HASH_RE } from "../../src/sessions/session-hash.js";
import {
  writeFakeStandupProbePath,
  writeStandupProfiles,
} from "../helpers/standup-handoff-fixtures.js";
import {
  cmdRender,
  cmdLatest,
  cmdList,
  cmdFind,
  cmdSearch,
  cmdHandoff,
  cmdStandup,
  cmdMessages,
  cmdServe,
  cmdShare,
  resolveCliSessionInput,
  showHelp,
} from "../../src/cli/cli-commands.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import { setColorEnabled } from "../../src/cli/cli-color.js";

// Color is now NO_COLOR/TTY-gated. This file asserts the colored die()/status
// format, so pin color ON for deterministic ANSI regardless of the test stream's
// TTY state. (Gating behavior itself is covered by cli-color.test.js.)
setColorEnabled(true);

const STDERR_PREFIX = "\x1b[31mError: ";
const STDERR_SUFFIX = "\x1b[0m";
const LATEST_HASH_RE = new RegExp(`Latest: ${SESSION_HASH_RE.source.slice(1, -1)} `);

function assertProbePreflight(stderr) {
  assert.match(stderr, /TraceQuest standup agent probe:/);
  assert.match(stderr, /synthetic sentinel prompts only/);
  assert.match(stderr, /No sessions are discovered/);
  assert.match(stderr, /no raw JSONL, real prompts, assistant replies, tool outputs, or absolute session paths are sent/);
  assert.match(stderr, /JSON probe report will be written to stdout/);
}

function dieStderrMessage(errors) {
  assert.equal(errors.length, 1, `expected one stderr line, got: ${JSON.stringify(errors)}`);
  const line = errors[0];
  assert.ok(line.startsWith(STDERR_PREFIX) && line.endsWith(STDERR_SUFFIX), line);
  return line.slice(STDERR_PREFIX.length, -STDERR_SUFFIX.length);
}

/** Assert die() wrote a single stderr line with Error: prefix. */
function assertDieStderr(
  { threw, code, errors, logs },
  pattern,
  { exitCode = 1, allowStdout = false } = {},
) {
  assert.equal(threw, true, "expected process.exit from die()");
  assert.equal(code, exitCode);
  if (!allowStdout) {
    assert.equal(logs.length, 0, `die() must not write stdout, got: ${JSON.stringify(logs)}`);
  }
  const msg = dieStderrMessage(errors);
  assert.equal(errors[0], formatCliError(msg));
  if (pattern instanceof RegExp) assert.match(msg, pattern);
  else assert.ok(msg.includes(pattern), `stderr should include ${pattern}, got: ${msg}`);
}

function minimalClaudeJsonl(sessionId = "cli-cmd-1") {
  const ts = "2026-06-03T12:00:00Z";
  return (
    [
      JSON.stringify({
        type: "user",
        sessionId,
        message: { content: "hello cli" },
        timestamp: ts,
        uuid: "u1",
        isMeta: false,
      }),
      JSON.stringify({
        type: "assistant",
        message: { model: "m", content: [{ type: "text", text: "ok" }] },
        timestamp: ts,
        uuid: "a1",
      }),
    ].join("\n") + "\n"
  );
}

function captureExit(fn) {
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  let code;
  const errors = [];
  const logs = [];
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  console.error = (...a) => errors.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    fn();
    return { threw: false, code, errors, logs };
  } catch (err) {
    if (err.message !== "process.exit") throw err;
    return { threw: true, code, errors, logs };
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
  }
}

function captureLogs(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  const logs = [];
  const warns = [];
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => warns.push(a.join(" "));
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
  return { logs, warns };
}

/** Capture process.stdout.write + console.error (for cmdMessages which writes JSON to stdout). */
function captureStdoutWrite(fn) {
  const origWrite = process.stdout.write;
  const origError = console.error;
  const chunks = [];
  const errors = [];
  process.stdout.write = (data) => { chunks.push(String(data)); return true; };
  console.error = (...a) => errors.push(a.join(" "));
  try {
    fn();
  } finally {
    process.stdout.write = origWrite;
    console.error = origError;
  }
  return { stdout: chunks.join(""), errors };
}

function captureExitWithStreams(fn) {
  const origExit = process.exit;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  let code;
  const stdout = [];
  const stderr = [];
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  process.stdout.write = (data) => { stdout.push(String(data)); return true; };
  process.stderr.write = (data) => { stderr.push(String(data)); return true; };
  console.log = (...a) => stdout.push(`${a.join(" ")}\n`);
  console.error = (...a) => stderr.push(`${a.join(" ")}\n`);
  console.warn = (...a) => stderr.push(`${a.join(" ")}\n`);
  try {
    fn();
    return { threw: false, code, stdout: stdout.join(""), stderr: stderr.join("") };
  } catch (err) {
    if (err.message !== "process.exit") throw err;
    return { threw: true, code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.exit = origExit;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

async function captureExitWithStreamsAsync(fn) {
  const origExit = process.exit;
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  let code;
  const stdout = [];
  const stderr = [];
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  process.stdout.write = (data) => { stdout.push(String(data)); return true; };
  process.stderr.write = (data) => { stderr.push(String(data)); return true; };
  console.log = (...a) => stdout.push(`${a.join(" ")}\n`);
  console.error = (...a) => stderr.push(`${a.join(" ")}\n`);
  console.warn = (...a) => stderr.push(`${a.join(" ")}\n`);
  try {
    await fn();
    return { threw: false, code, stdout: stdout.join(""), stderr: stderr.join("") };
  } catch (err) {
    if (err.message !== "process.exit") throw err;
    return { threw: true, code, stdout: stdout.join(""), stderr: stderr.join("") };
  } finally {
    process.exit = origExit;
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
}

function withTmpDir(fn, prefix = "tq-cli-cmd-") {
  const dir = mkdtempSync(join(os.tmpdir(), prefix));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withTmpHome(fn) {
  const tmpDir = mkdtempSync(join(os.tmpdir(), "tq-cli-home-"));
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
    const sessionsMod = await import(modUrl.href);
    return await fn(tmpDir, sessionsMod);
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    try {
      rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* worker threads may still flush index files under HOME */
    }
  }
}

function seedClaudeProject(home, project, files) {
  const projDir = join(home, ".claude", "projects", project);
  mkdirSync(projDir, { recursive: true });
  const paths = [];
  for (const [name, content, mtimeOffsetSec] of files) {
    const filePath = join(projDir, name);
    writeFileSync(filePath, content ?? "{}");
    paths.push(filePath);
    if (mtimeOffsetSec != null) {
      const t = Date.now() / 1000 - mtimeOffsetSec;
      utimesSync(filePath, t, t);
    }
  }
  return paths;
}

function previousWeekdayAt(hour) {
  const now = new Date();
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, hour, 0, 0, 0);
  while (candidate.getDay() === 0 || candidate.getDay() === 6) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate;
}

/**
 * Build Claude JSONL with a specific model name and optional tool_use blocks.
 * This allows filter expressions like `model:sonnet` or `tool:Read` to match.
 */
function claudeJsonlWithMeta(sessionId, { model = "claude-sonnet-4-20250514", tools = [], prompt = "hello" } = {}) {
  const ts = "2026-06-03T12:00:00Z";
  const assistantContent = [{ type: "text", text: "ok" }];
  for (const t of tools) {
    assistantContent.push({ type: "tool_use", id: `tu_${t}`, name: t, input: {} });
  }
  return (
    [
      JSON.stringify({
        type: "user",
        sessionId,
        message: { content: prompt },
        timestamp: ts,
        uuid: "u1",
        isMeta: false,
      }),
      JSON.stringify({
        type: "assistant",
        message: { model, content: assistantContent },
        timestamp: ts,
        uuid: "a1",
      }),
    ].join("\n") + "\n"
  );
}

function minimalCodexJsonl(cwd = "/tmp/codex-cli-latest") {
  const ts = "2026-06-03T12:00:00.000Z";
  return (
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "codex-cli-latest-1", cwd, model_provider: "openai" },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: ts,
        payload: { type: "user_message", message: "codex latest cli" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: ts,
        payload: {
          role: "assistant",
          content: [{ type: "output_text", text: "codex ok" }],
        },
      }),
    ].join("\n") + "\n"
  );
}

function seedCodexRollout(home, name, content, mtimeOffsetSec) {
  const dir = join(home, ".codex", "sessions");
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, name);
  writeFileSync(filePath, content ?? minimalCodexJsonl(home));
  if (mtimeOffsetSec != null) {
    const t = Date.now() / 1000 - mtimeOffsetSec;
    utimesSync(filePath, t, t);
  }
  return filePath;
}

function seedGrokSession(home, sessName, mtimeOffsetSec) {
  const grokDir = join(home, ".grok", "sessions", "ws-cli-latest", sessName);
  mkdirSync(grokDir, { recursive: true });
  writeFileSync(
    join(grokDir, "chat_history.jsonl"),
    JSON.stringify({ type: "user", content: `grok ${sessName}` }) + "\n",
  );
  writeFileSync(
    join(grokDir, "events.jsonl"),
    JSON.stringify({ type: "turn_started", ts: "2026-06-03T12:00:00Z" }) + "\n",
  );
  if (mtimeOffsetSec != null) {
    const t = Date.now() / 1000 - mtimeOffsetSec;
    utimesSync(join(grokDir, "chat_history.jsonl"), t, t);
    utimesSync(grokDir, t, t);
  }
  return grokDir;
}

function runCmdLatestInHome(home, positionals, values) {
  const prevHome = process.env.HOME;
  process.env.HOME = home;
  try {
    return captureLogs(() => cmdLatest(positionals, values));
  } finally {
    process.env.HOME = prevHome;
  }
}

function listenOnEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    // Bind 127.0.0.1, the same address `serve` binds by default. A different
    // address would NOT collide on macOS, so the "port already in use" child
    // would start successfully and the test would hang instead of seeing EADDRINUSE.
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/** Bind :0, release, return port — avoids collisions with fixed 65529/8888 in parallel runs. */
async function allocEphemeralPort() {
  const { server, port } = await listenOnEphemeralPort();
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

/** cmdServe child processes still listening when the suite moves on. */
const serveChildren = new Set();

function killServeChild(child) {
  if (child.exitCode != null || child.killed) return;
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  }, 200);
}

const CLI_COMMANDS_URL = fileURLToPath(
  new URL("../../src/cli/cli-commands.js", import.meta.url),
);

/** Run cmdServe in a child; kills after brief window unless process exits first. */
function runCmdServeChild(values, { home, timeoutMs = 700, untilStdout } = {}) {
  const runnerDir = mkdtempSync(join(os.tmpdir(), "tq-serve-runner-"));
  const runner = join(runnerDir, "run.mjs");
  writeFileSync(
    runner,
    `import { cmdServe } from ${JSON.stringify(CLI_COMMANDS_URL)};
process.env.TRACEQUEST_SKIP_LR_WATCH = "1";
cmdServe([], ${JSON.stringify(values)});
`,
  );
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      TRACEQUEST_SKIP_LR_WATCH: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_VERBOSE: "1",
    };
    if (home) env.HOME = home;
    const child = spawn(process.execPath, [runner], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    serveChildren.add(child);
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      serveChildren.delete(child);
      killServeChild(child);
      rmSync(runnerDir, { recursive: true, force: true });
      resolve({ stdout, stderr, reason, code: child.exitCode });
    };
    child.stdout.on("data", (d) => {
      stdout += d;
      if (untilStdout?.test(stdout)) {
        setTimeout(() => finish("matched"), 50);
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (untilStdout?.test(stderr)) {
        setTimeout(() => finish("matched"), 50);
      }
    });
    const timer = setTimeout(() => {
      killServeChild(child);
      setTimeout(() => finish("timeout"), 250);
    }, timeoutMs);
    child.on("exit", () => finish("exit"));
  });
}

describe("cli-commands resolveCliSessionInput", () => {
  const OC_URI = "opencode://ses_integOpenCodeTestSession01";

  it("returns opencode virtual URI unchanged when well-formed", () => {
    assert.equal(resolveCliSessionInput(OC_URI), OC_URI);
  });

  it("dies for malformed opencode virtual URI", () => {
    assertDieStderr(captureExit(() => resolveCliSessionInput("opencode://sess-not-valid-id")), /Invalid OpenCode session path/);
  });

  it("dies when filesystem session path does not exist", () => {
    const missing = join(os.tmpdir(), `tracequest-missing-resolve-${Date.now()}.jsonl`);
    assertDieStderr(captureExit(() => resolveCliSessionInput(missing)), /File not found/);
  });
});

describe("cli-commands cmdRender", () => {
  it("dies when session path is omitted", () => {
    const captured = captureExit(() => cmdRender([], {}));
    assertDieStderr(captured, /session\.jsonl/);
  });

  it("dies when session file does not exist", () => {
    const missing = join(os.tmpdir(), `tracequest-missing-${Date.now()}.jsonl`);
    assertDieStderr(captureExit(() => cmdRender([missing], {})), /File not found/);
  });

  it("dies for bare directory without chat_history.jsonl", () => {
    withTmpDir((dir) => {
      assertDieStderr(captureExit(() => cmdRender([dir], {})), /Not a session file/);
    });
  });

  it("dies for top-level agent sessions directory", () => {
    withTmpDir((dir) => {
      const sessionsDir = join(dir, "sessions");
      mkdirSync(sessionsDir);
      assertDieStderr(captureExit(() => cmdRender([sessionsDir], {})), /top-level agent dir 'sessions'/);
    });
  });

  it("dies for top-level agent projects directory", () => {
    withTmpDir((dir) => {
      const projectsDir = join(dir, "projects");
      mkdirSync(projectsDir);
      assertDieStderr(captureExit(() => cmdRender([projectsDir], {})), /top-level agent dir 'projects'/);
    });
  });

  it("dies when output path is not writable", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const out = join(dir, "missing-parent", "out.html");
      assertDieStderr(captureExit(() => cmdRender([jsonl], { out })), /Failed to write output/, {
        allowStdout: true,
      });
    });
  });

  it("dies when session file cannot be read", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "locked.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      chmodSync(jsonl, 0o000);
      try {
        assertDieStderr(captureExit(() => cmdRender([jsonl], {})), /Failed to parse session/, {
          allowStdout: true,
        });
      } finally {
        chmodSync(jsonl, 0o644);
      }
    });
  });

  it("writes HTML to explicit --out in tmp dir", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      const out = join(dir, "rendered.html");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { logs } = captureLogs(() => cmdRender([jsonl], { out }));
      assert.ok(existsSync(out));
      assert.match(readFileSync(out, "utf8"), /<html/i);
      assert.ok(logs.some((l) => l.includes("Written:")));
      assert.ok(logs.some((l) => l.includes("Parsing session")));
    });
  });

  it("renders opencode:// virtual URI when HOME has matching DB row", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "tq-cli-render-oc-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const sessionId = "ses_integOpenCodeTestSession01";
      const uri = `opencode://${sessionId}`;
      await seedOpenCodeIndexDb(home, [
        {
          id: sessionId,
          messages: [
            { role: "user", parts: [{ type: "text", text: "cli opencode render marker" }] },
            { role: "assistant", parts: [{ type: "text", text: "cli opencode reply" }] },
            { role: "user", parts: [{ type: "text", text: "third message" }] },
          ],
        },
      ]);
      const out = join(home, "oc-render.html");
      const { logs } = captureLogs(() => cmdRender([uri], { out }));
      assert.ok(existsSync(out));
      assert.match(readFileSync(out, "utf8"), /cli opencode render marker/);
      assert.ok(logs.some((l) => l.includes("Written:")));
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("renders Grok session directory containing chat_history.jsonl", () => {
    withTmpDir((dir) => {
      const grokDir = join(dir, ".grok", "sessions", "grok-sess");
      mkdirSync(grokDir, { recursive: true });
      writeFileSync(
        join(grokDir, "chat_history.jsonl"),
        JSON.stringify({ type: "user", content: "grok dir render" }) + "\n",
      );
      writeFileSync(
        join(grokDir, "events.jsonl"),
        JSON.stringify({ type: "turn_started", ts: "2026-06-03T12:00:00Z" }) + "\n",
      );
      const out = join(dir, "grok.html");
      captureLogs(() => cmdRender([grokDir], { out }));
      assert.ok(existsSync(out));
      assert.match(readFileSync(out, "utf8"), /<html/i);
    });
  });

  it("showHelp via --help exits 0", () => {
    const { threw, code, logs } = captureExit(() => cmdRender([], { help: true }));
    assert.equal(threw, true);
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("tracequest")));
  });

  it("dies on unknown preset before reading session file", () => {
    assertDieStderr(
      captureExit(() =>
        cmdRender(["/tmp/should-not-be-read.jsonl"], { preset: "no-such-preset-xyz" }),
      ),
      /Preset not found/,
    );
  });
});

describe("cli-commands cmdLatest", () => {
  it("dies when no sessions exist in HOME", async () => {
    await withTmpHome(async () => {
      const { threw, errors } = captureExit(() => cmdLatest([], {}));
      assert.equal(threw, true);
      assert.ok(errors.some((e) => e.includes("No sessions found")));
    });
  });

  it("renders the newest session by mtime", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "latestproj", [
        ["old.jsonl", minimalClaudeJsonl("old"), 200],
        ["new.jsonl", minimalClaudeJsonl("new"), 0],
      ]);
      const out = join(tmpDir, "latest-out.html");
      const { logs } = captureLogs(() => cmdLatest([], { out }));
      assert.ok(existsSync(out));
      assert.ok(logs.some((l) => LATEST_HASH_RE.test(l) && l.includes("new.jsonl")));
      assert.ok(logs.some((l) => l.includes("Written:")));
    });
  });

  it("filters sessions with positional project name", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "keep-me", [["a.jsonl", minimalClaudeJsonl("keep"), 0]]);
      seedClaudeProject(tmpDir, "drop-me", [["b.jsonl", minimalClaudeJsonl("drop"), 0]]);
      const out = join(tmpDir, "filtered.html");
      const { logs } = captureLogs(() => cmdLatest(["keep-me"], { out }));
      assert.ok(existsSync(out));
      assert.ok(logs.some((l) => LATEST_HASH_RE.test(l) && l.includes("a.jsonl")));
    });
  });

  it("showHelp via --help exits 0", () => {
    const { threw, code, logs } = captureExit(() => cmdLatest([], { help: true }));
    assert.equal(threw, true);
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("latest")));
  });

  it("dies on unknown preset", () => {
    const { threw, errors } = captureExit(() =>
      cmdLatest([], { preset: "missing-preset-cli-latest" }),
    );
    assert.equal(threw, true);
    assert.ok(errors.some((e) => e.includes("Preset not found")));
  });

  it("picks newest among five sessions in one project (mtime not filename)", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "five-mtime", [
        ["aaa.jsonl", minimalClaudeJsonl("aaa"), 500],
        ["bbb.jsonl", minimalClaudeJsonl("bbb"), 400],
        ["ccc.jsonl", minimalClaudeJsonl("ccc"), 300],
        ["ddd.jsonl", minimalClaudeJsonl("ddd"), 200],
        ["zzz-newest.jsonl", minimalClaudeJsonl("zzz"), 0],
      ]);
      const out = join(tmpDir, "five-latest.html");
      const { logs } = runCmdLatestInHome(tmpDir, [], { out });
      assert.ok(existsSync(out));
      assert.ok(logs.some((l) => LATEST_HASH_RE.test(l) && l.includes("zzz-newest.jsonl")));
      assert.ok(logs.some((l) => l.includes("Parsing session")));
    });
  });

  it("global latest ignores older sessions in other projects", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "stale-proj", [
        ["stale-a.jsonl", minimalClaudeJsonl("stale-a"), 500],
        ["stale-b.jsonl", minimalClaudeJsonl("stale-b"), 510],
      ]);
      seedClaudeProject(tmpDir, "fresh-proj", [
        ["fresh-old.jsonl", minimalClaudeJsonl("fresh-old"), 800],
        ["fresh-win.jsonl", minimalClaudeJsonl("fresh-win"), 0],
      ]);
      const out = join(tmpDir, "cross-proj.html");
      const { logs } = runCmdLatestInHome(tmpDir, [], { out });
      assert.ok(logs.some((l) => LATEST_HASH_RE.test(l) && l.includes("fresh-win.jsonl")));
      assert.ok(!logs.some((l) => l.includes("Latest:") && l.includes("stale-a.jsonl")));
    });
  });

  it("project prefix filter picks newest match, not global newest", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "keep-alpha", [
        ["alpha-old.jsonl", minimalClaudeJsonl("alpha-old"), 120],
        ["alpha-new.jsonl", minimalClaudeJsonl("alpha-new"), 60],
      ]);
      seedClaudeProject(tmpDir, "keep-beta", [["beta.jsonl", minimalClaudeJsonl("beta"), 90]]);
      seedClaudeProject(tmpDir, "drop-global", [
        ["global-newest.jsonl", minimalClaudeJsonl("global"), 0],
      ]);
      const out = join(tmpDir, "prefix-filter.html");
      const { logs } = runCmdLatestInHome(tmpDir, ["keep-"], { out });
      assert.ok(logs.some((l) => LATEST_HASH_RE.test(l) && l.includes("alpha-new.jsonl")));
      assert.ok(!logs.some((l) => l.includes("Latest:") && l.includes("global-newest.jsonl")));
    });
  });

  it("dies when positional filter matches no sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "only-proj", [["only.jsonl", minimalClaudeJsonl("only"), 0]]);
      const { threw, errors } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdLatest(["no-such-prefix-xyz"], {});
      });
      assert.equal(threw, true);
      assert.ok(errors.some((e) => e.includes("No sessions found")));
    });
  });

  it("codex rollout wins over older claude when codex mtime is newer", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "claude-side", [
        ["claude-old.jsonl", minimalClaudeJsonl("claude-old"), 200],
      ]);
      seedCodexRollout(tmpDir, "rollout-newest.jsonl", minimalCodexJsonl(tmpDir), 5);
      const out = join(tmpDir, "codex-wins.html");
      const { logs } = runCmdLatestInHome(tmpDir, [], { out });
      assert.ok(logs.some((l) => LATEST_HASH_RE.test(l) && l.includes("rollout-newest.jsonl")));
      assert.ok(existsSync(out));
      assert.match(readFileSync(out, "utf8"), /<html/i);
    });
  });

  it("grok session dir wins over claude jsonl when grok mtime is newer", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "grok-beat", [
        ["claude.jsonl", minimalClaudeJsonl("claude"), 300],
      ]);
      seedGrokSession(tmpDir, "grok-newest", 10);
      const out = join(tmpDir, "grok-wins.html");
      const { logs } = runCmdLatestInHome(tmpDir, [], { out });
      assert.ok(logs.some((l) => LATEST_HASH_RE.test(l) && l.includes("grok-newest")));
      assert.ok(existsSync(out));
    });
  });

  it("writes default tracequest-*.html in cwd when --out is omitted", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "default-out", [
        ["older.jsonl", minimalClaudeJsonl("older"), 40],
        ["picked.jsonl", minimalClaudeJsonl("picked"), 0],
      ]);
      await withTmpDir(async (cwd) => {
        const prevCwd = process.cwd();
        process.chdir(cwd);
        try {
          const { logs } = runCmdLatestInHome(tmpDir, [], {});
          const written = logs.find((l) => /Written: tracequest-/.test(l));
          assert.ok(written, `expected Written log, got: ${JSON.stringify(logs)}`);
          const m = written.match(/Written: (tracequest-[^\s(]+\.html)/);
          assert.ok(m, written);
          const outPath = join(cwd, m[1]);
          assert.ok(existsSync(outPath));
          assert.match(readFileSync(outPath, "utf8"), /<html/i);
        } finally {
          process.chdir(prevCwd);
        }
      }, "tq-cli-latest-cwd-");
    });
  });
});

describe("cli-commands cmdServe", () => {
  afterEach(() => {
    for (const child of serveChildren) killServeChild(child);
  });

  it("dies when port is above 65535", () => {
    assertDieStderr(captureExit(() => cmdServe([], { port: "99999" })), /Invalid port: 99999/);
  });

  it("dies when port is zero", () => {
    assertDieStderr(captureExit(() => cmdServe([], { port: "0" })), /Invalid port: 0/);
  });

  it("dies when port is not numeric", () => {
    assertDieStderr(captureExit(() => cmdServe([], { port: "abc" })), /Invalid port: abc/);
  });

  it("dies on unknown preset", () => {
    assertDieStderr(
      captureExit(() => cmdServe([], { preset: "missing-preset-cli-serve" })),
      /Preset not found/,
    );
  });

  it("showHelp via --help exits 0", () => {
    const { threw, code, logs } = captureExit(() => cmdServe([], { help: true }));
    assert.equal(threw, true);
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("serve")));
  });

  it("logs warning when filter matches no sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      const port = String(await allocEphemeralPort());
      const { stdout, stderr } = await runCmdServeChild(
        { filter: "no-match-filter-xyz", port },
        {
          home: tmpDir,
          timeoutMs: 5000,
          untilStdout: /No sessions match filter/,
        },
      );
      assert.match(stdout + stderr, /No sessions match filter/);
    });
  });

  it("logs session count when filter matches", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "servefilter", [["s.jsonl", "{}", 0]]);
      const port = String(await allocEphemeralPort());
      const { stdout, stderr } = await runCmdServeChild(
        { filter: "servefilter", port },
        {
          home: tmpDir,
          timeoutMs: 5000,
          untilStdout: /Found 1 sessions for filter 'servefilter'/,
        },
      );
      assert.match(stdout + stderr, /Found 1 sessions for filter 'servefilter'/);
    });
  });

  it("logs index build start and end before the server URL", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "serveindex", [["s.jsonl", minimalClaudeJsonl("serve-idx"), 0]]);
      const port = String(await allocEphemeralPort());
      const { stdout, stderr } = await runCmdServeChild(
        { port },
        {
          home: tmpDir,
          timeoutMs: 10000,
          untilStdout: /tracequest → http/,
        },
      );
      assert.match(stderr, /tracequest: building index for 1 session \(1 stale\)/);
      assert.match(stderr, /tracequest: indexed 1 session/);
      const buildIdx = stderr.indexOf("building index");
      const indexedIdx = stderr.indexOf("indexed 1 session");
      const urlIdx = stdout.indexOf("tracequest → http");
      assert.ok(buildIdx >= 0 && indexedIdx > buildIdx && urlIdx >= 0);
    });
  });

  it("exits when port is already in use", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "serve-inuse", [["s.jsonl", minimalClaudeJsonl("inuse"), 0]]);
      const { server, port } = await listenOnEphemeralPort();
      try {
        const { reason, code, stderr } = await runCmdServeChild(
          { port: String(port) },
          { home: tmpDir, timeoutMs: 5000 },
        );
        assert.equal(reason, "exit");
        assert.equal(code, 1);
        assert.match(stderr, /Error: Port .* already in use/);
        assert.match(stderr, /tracequest serve --port/);
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });

  it("uses preset local port 8888 when CLI omits --port", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "serve-preset", [["s.jsonl", minimalClaudeJsonl("preset"), 0]]);
      const { stdout, stderr, reason, code } = await runCmdServeChild(
        { preset: "local" },
        { home: tmpDir, timeoutMs: 5000, untilStdout: /8888/ },
      );
      const combined = stdout + stderr;
      if (reason === "exit" && code === 1 && /already in use/.test(combined)) {
        assert.match(combined, /8888/);
        return;
      }
      assert.match(stdout, /8888/);
    });
  });

  it("child serve honors CLI --port over preset", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "serve-portover", [["s.jsonl", minimalClaudeJsonl("portover"), 0]]);
      const port = String(await allocEphemeralPort());
      const { stdout } = await runCmdServeChild(
        { preset: "local", port },
        { home: tmpDir, timeoutMs: 5000, untilStdout: new RegExp(String(port)) },
      );
      assert.match(stdout, new RegExp(String(port)));
    });
  });
});

describe("cli-commands showHelp", () => {
  it("prints usage and exits 0", () => {
    const { threw, code, logs } = captureExit(() => showHelp());
    assert.equal(threw, true);
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("Commands:")));
  });
});

describe("cli-commands printSessionStats toolCounts", () => {
  it("stats line sums all toolCounts values across tools", () => {
    const ts = "2026-06-03T12:00:00Z";
    const jsonl =
      [
        JSON.stringify({
          type: "user",
          sessionId: "sum-tools",
          message: { content: "run tools" },
          timestamp: ts,
          uuid: "u1",
          isMeta: false,
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            model: "claude-sonnet-4-20250514",
            content: [
              { type: "text", text: "Using tools." },
              { type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/a.js" } },
              { type: "tool_use", id: "toolu_b1", name: "Bash", input: { command: "echo hi" } },
              { type: "tool_use", id: "toolu_g1", name: "Grep", input: { pattern: "foo" } },
            ],
          },
          timestamp: ts,
          uuid: "a1",
        }),
      ].join("\n") + "\n";

    withTmpDir((dir) => {
      const sessionPath = join(dir, "session.jsonl");
      writeFileSync(sessionPath, jsonl);
      const { logs } = captureLogs(() => cmdRender([sessionPath], { out: join(dir, "out.html") }));
      assert.ok(
        logs.some((l) => /\b3 tool calls\b/.test(l)),
        `expected summed tool count in stats line, got: ${JSON.stringify(logs)}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// --filter and --sort for cmdList and cmdLatest (TODO #4)
// ---------------------------------------------------------------------------

describe("cmdList --filter", () => {
  it("filters by model:sonnet and shows only matching sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "expr-model", [
        ["sonnet.jsonl", claudeJsonlWithMeta("s1", { model: "claude-sonnet-4-20250514" }), 10],
        ["opus.jsonl", claudeJsonlWithMeta("s2", { model: "claude-opus-4-20250514" }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { filter: "model:sonnet" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")), `expected 1 session, got: ${JSON.stringify(logs)}`);
      assert.ok(logs.some((l) => l.includes("sonnet.jsonl")));
      assert.ok(!logs.some((l) => l.includes("opus.jsonl")));
    });
  });

  it("filters by source:claude", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "expr-source", [
        ["claude-a.jsonl", claudeJsonlWithMeta("ca"), 0],
      ]);
      seedCodexRollout(tmpDir, "codex-a.jsonl", minimalCodexJsonl(tmpDir), 0);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { filter: "source:claude" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Only claude sessions should be shown
      assert.ok(logs.some((l) => l.includes("claude-a.jsonl")));
      assert.ok(!logs.some((l) => l.includes("codex-a.jsonl")));
    });
  });

  it("cmdList discovery-only --filter avoids indexing", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "filter-source", [
        ["claude.jsonl", claudeJsonlWithMeta("c1"), 10],
      ]);
      seedCodexRollout(tmpDir, "codex-a.jsonl", minimalCodexJsonl(tmpDir), 0);
      const { threw, code, errors, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { expr: "source:claude", filter: "source:claude", sort: "date" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 1);
      assert.ok(sessionLines[0].includes("claude.jsonl"));
      assert.ok(!sessionLines.some((l) => l.includes("codex-a.jsonl")));
      assert.ok(!errors.some((e) => e.includes("tracequest: building index") || e.includes("tracequest: index up to date")));
      assert.equal(existsSync(indexPath()), false);
      assert.equal(existsSync(searchIdxPath()), false);
    });
  });

  it("cmdList compound discovery-only --filter avoids indexing", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "filter-project-keep", [
        ["keep.jsonl", claudeJsonlWithMeta("cp1"), 10],
      ]);
      seedClaudeProject(tmpDir, "filter-project-drop", [
        ["drop.jsonl", claudeJsonlWithMeta("cp2"), 0],
      ]);
      const { threw, code, errors, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], {
          expr: "project:filter-project-keep age:<7d",
          filter: "project:filter-project-keep age:<7d",
          sort: "recent",
        });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 1);
      assert.ok(sessionLines[0].includes("keep.jsonl"));
      assert.ok(!sessionLines.some((l) => l.includes("drop.jsonl")));
      assert.ok(!errors.some((e) => e.includes("tracequest: building index") || e.includes("tracequest: index up to date")));
      assert.equal(existsSync(indexPath()), false);
      assert.equal(existsSync(searchIdxPath()), false);
    });
  });

  it("returns empty result message when expr matches nothing", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "expr-empty", [
        ["only.jsonl", claudeJsonlWithMeta("e1", { model: "claude-sonnet-4-20250514" }), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { filter: "model:nonexistent-model-xyz" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("No sessions match")));
    });
  });

  it("combines positional project filter with --filter", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "projA", [
        ["a-sonnet.jsonl", claudeJsonlWithMeta("a1", { model: "claude-sonnet-4-20250514" }), 10],
        ["a-opus.jsonl", claudeJsonlWithMeta("a2", { model: "claude-opus-4-20250514" }), 5],
      ]);
      seedClaudeProject(tmpDir, "projB", [
        ["b-sonnet.jsonl", claudeJsonlWithMeta("b1", { model: "claude-sonnet-4-20250514" }), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        // Positional filter narrows to projA, then --filter further narrows to sonnet
        cmdList(["projA"], { filter: "model:sonnet" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      assert.ok(logs.some((l) => l.includes("a-sonnet.jsonl")));
      assert.ok(!logs.some((l) => l.includes("a-opus.jsonl")));
      assert.ok(!logs.some((l) => l.includes("b-sonnet.jsonl")));
    });
  });

  it("filters by tool:Read", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "expr-tool", [
        ["with-read.jsonl", claudeJsonlWithMeta("t1", { tools: ["Read", "Edit"] }), 10],
        ["no-read.jsonl", claudeJsonlWithMeta("t2", { tools: ["Bash"] }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { filter: "tool:Read" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      assert.ok(logs.some((l) => l.includes("with-read.jsonl")));
      assert.ok(!logs.some((l) => l.includes("no-read.jsonl")));
    });
  });
});

describe("cmdList --sort", () => {
  it("sort by tokens puts largest first", async () => {
    await withTmpHome(async (tmpDir) => {
      // Create sessions with different sizes (more content = more tokens from peek)
      seedClaudeProject(tmpDir, "sort-tok", [
        ["small.jsonl", claudeJsonlWithMeta("s1", { prompt: "a" }), 10],
        ["large.jsonl", claudeJsonlWithMeta("s2", { prompt: "a much longer prompt with many tokens to get higher count" }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { sort: "recent" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Should show 2 sessions (sort alone does not filter)
      assert.ok(logs.some((l) => l.includes("2 sessions")));
    });
  });

  it("cmdList --sort recent without --filter avoids indexing", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "sort-only", [
        ["a.jsonl", claudeJsonlWithMeta("a"), 100],
        ["b.jsonl", claudeJsonlWithMeta("b"), 0],
      ]);
      const { threw, code, errors, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { sort: "recent" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Both sessions still shown (no filtering, just sorting)
      assert.ok(logs.some((l) => l.includes("2 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 2);
      assert.ok(sessionLines[0].includes("b.jsonl"));
      assert.ok(sessionLines[1].includes("a.jsonl"));
      assert.ok(!errors.some((e) => e.includes("tracequest: building index") || e.includes("tracequest: index up to date")));
      assert.equal(existsSync(indexPath()), false);
      assert.equal(existsSync(searchIdxPath()), false);
    });
  });
});

describe("cmdLatest --filter", () => {
  it("returns the matching session with --filter source:claude", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "lat-expr", [
        ["claude-old.jsonl", claudeJsonlWithMeta("co", { model: "claude-sonnet-4-20250514" }), 100],
        ["claude-new.jsonl", claudeJsonlWithMeta("cn", { model: "claude-opus-4-20250514" }), 0],
      ]);
      const out = join(tmpDir, "latest-expr.html");
      const { logs } = captureLogs(() => {
        process.env.HOME = tmpDir;
        cmdLatest([], { filter: "model:opus", out });
      });
      assert.ok(existsSync(out));
      // Should have picked the opus session, not the most recent by mtime
      assert.ok(logs.some((l) => l.includes("claude-new.jsonl")));
    });
  });

  it("dies when --filter matches no sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "lat-empty", [
        ["only.jsonl", claudeJsonlWithMeta("o1"), 0],
      ]);
      const { threw, errors } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdLatest([], { filter: "model:nonexistent" });
      });
      assert.equal(threw, true);
      assert.ok(errors.some((e) => e.includes("No sessions match the filter")));
    });
  });

  it("--filter with --sort picks top sorted session", async () => {
    await withTmpHome(async (tmpDir) => {
      // Two sonnet sessions, different mtimes; --sort recent picks the newer one
      seedClaudeProject(tmpDir, "lat-sort", [
        ["old-sonnet.jsonl", claudeJsonlWithMeta("os", { model: "claude-sonnet-4-20250514" }), 200],
        ["new-sonnet.jsonl", claudeJsonlWithMeta("ns", { model: "claude-sonnet-4-20250514" }), 0],
        ["opus.jsonl", claudeJsonlWithMeta("op", { model: "claude-opus-4-20250514" }), 5],
      ]);
      const out = join(tmpDir, "sorted-latest.html");
      const { logs } = captureLogs(() => {
        process.env.HOME = tmpDir;
        cmdLatest([], { filter: "model:sonnet", sort: "recent", out });
      });
      assert.ok(existsSync(out));
      assert.ok(logs.some((l) => l.includes("new-sonnet.jsonl")));
    });
  });

  it("positional filter plus --filter both narrow results", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "alpha", [
        ["alpha-sonnet.jsonl", claudeJsonlWithMeta("as", { model: "claude-sonnet-4-20250514" }), 0],
      ]);
      seedClaudeProject(tmpDir, "beta", [
        ["beta-sonnet.jsonl", claudeJsonlWithMeta("bs", { model: "claude-sonnet-4-20250514" }), 5],
      ]);
      const out = join(tmpDir, "combo.html");
      const { logs } = captureLogs(() => {
        process.env.HOME = tmpDir;
        // Positional "alpha" narrows to alpha project, --filter further confirms model:sonnet
        cmdLatest(["alpha"], { filter: "model:sonnet", out });
      });
      assert.ok(existsSync(out));
      assert.ok(logs.some((l) => l.includes("alpha-sonnet.jsonl")));
    });
  });
});

describe("cmdFind --filter edge cases", () => {
  it("lists 10 most recent sessions when no --filter is given", async () => {
    await withTmpHome(async (tmpDir) => {
      const files = [];
      for (let i = 0; i < 12; i++) {
        files.push([`s${i}.jsonl`, claudeJsonlWithMeta(`s${i}`), i * 10]);
      }
      seedClaudeProject(tmpDir, "find-default", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdFind([], {});
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("12 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 10);
      assert.ok(sessionLines[0].includes("s0.jsonl"));
      assert.ok(sessionLines[9].includes("s9.jsonl"));
      assert.ok(!sessionLines.some((l) => l.includes("s10.jsonl") || l.includes("s11.jsonl")));
    });
  });

  it("finds sessions matching a positional model expression", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "find-positional", [
        ["pos-sonnet.jsonl", claudeJsonlWithMeta("fps", { model: "claude-sonnet-4-20250514" }), 10],
        ["pos-opus.jsonl", claudeJsonlWithMeta("fpo", { model: "claude-opus-4-20250514" }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdFind(["model:sonnet"], {});
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      assert.ok(logs.some((l) => l.includes("pos-sonnet.jsonl")));
      assert.ok(!logs.some((l) => l.includes("pos-opus.jsonl")));
    });
  });

  it("combines positional and --filter expressions with AND", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "find-combo-alpha", [
        ["alpha-sonnet.jsonl", claudeJsonlWithMeta("fcas", { model: "claude-sonnet-4-20250514" }), 10],
        ["alpha-opus.jsonl", claudeJsonlWithMeta("fcao", { model: "claude-opus-4-20250514" }), 5],
      ]);
      seedClaudeProject(tmpDir, "find-combo-beta", [
        ["beta-sonnet.jsonl", claudeJsonlWithMeta("fcbs", { model: "claude-sonnet-4-20250514" }), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdFind(["project:find-combo-alpha"], { filter: "model:sonnet" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      assert.ok(logs.some((l) => l.includes("alpha-sonnet.jsonl")));
      assert.ok(!logs.some((l) => l.includes("alpha-opus.jsonl")));
      assert.ok(!logs.some((l) => l.includes("beta-sonnet.jsonl")));
    });
  });

  it("ignores --sort without --filter and keeps recency order (unlike list)", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "find-sort-only", [
        ["recent-small.jsonl", claudeJsonlWithMeta("recent", { prompt: "a" }), 0],
        ["old-large.jsonl", claudeJsonlWithMeta("old", { prompt: "a much longer prompt with many tokens to get higher count" }), 100],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdFind([], { sort: "tokens" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 2);
      assert.ok(sessionLines[0].includes("recent-small.jsonl"));
      assert.ok(sessionLines[1].includes("old-large.jsonl"));
    });
  });

  it("finds sessions matching a model expression", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "find-proj", [
        ["find-sonnet.jsonl", claudeJsonlWithMeta("fs", { model: "claude-sonnet-4-20250514" }), 10],
        ["find-opus.jsonl", claudeJsonlWithMeta("fo", { model: "claude-opus-4-20250514" }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdFind([], { filter: "model:sonnet" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      assert.ok(logs.some((l) => l.includes("find-sonnet.jsonl")));
    });
  });

  it("respects --limit flag", async () => {
    await withTmpHome(async (tmpDir) => {
      const files = [];
      for (let i = 0; i < 5; i++) {
        files.push([`s${i}.jsonl`, claudeJsonlWithMeta(`s${i}`), i * 10]);
      }
      seedClaudeProject(tmpDir, "find-limit", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdFind([], { filter: "source:claude", limit: "2" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Should report total found but only show 2
      assert.ok(logs.some((l) => l.includes("5 sessions")));
      // Count session path lines (lines containing .jsonl)
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 2);
    });
  });

});

describe("applyExprFilter correctness", () => {
  it("empty expr string still returns all sessions sorted", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "empty-expr", [
        ["a.jsonl", claudeJsonlWithMeta("a"), 100],
        ["b.jsonl", claudeJsonlWithMeta("b"), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        // Pass empty string as expr; parseFilterExpr("") returns null, so no filtering happens
        cmdList([], { filter: "" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Empty expr means no filtering; should show all sessions
      assert.ok(logs.some((l) => l.includes("2 sessions")));
    });
  });

  it("boolean OR in expr matches either condition", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "or-expr", [
        ["sonnet.jsonl", claudeJsonlWithMeta("s", { model: "claude-sonnet-4-20250514" }), 10],
        ["opus.jsonl", claudeJsonlWithMeta("o", { model: "claude-opus-4-20250514" }), 5],
        ["haiku.jsonl", claudeJsonlWithMeta("h", { model: "claude-haiku-3-20250514" }), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { filter: "model:sonnet OR model:opus" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("2 sessions")));
      assert.ok(!logs.some((l) => l.includes("haiku.jsonl")));
    });
  });

  it("negation with NOT excludes matching sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "not-expr", [
        ["sonnet.jsonl", claudeJsonlWithMeta("s", { model: "claude-sonnet-4-20250514" }), 10],
        ["opus.jsonl", claudeJsonlWithMeta("o", { model: "claude-opus-4-20250514" }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { filter: "NOT model:opus" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("1 sessions")));
      assert.ok(logs.some((l) => l.includes("sonnet.jsonl")));
      assert.ok(!logs.some((l) => l.includes("opus.jsonl")));
    });
  });

  it("free-text expr matches session content via SearchIndex", async () => {
    await withTmpHome(async (tmpDir) => {
      // SearchIndex term frequencies are built from session content. A free-text
      // term in --filter should match through the SearchIndex-backed filter
      // context, without requiring a searchText field on API objects.
      seedClaudeProject(tmpDir, "freetext-proj", [
        ["match.jsonl", claudeJsonlWithContent("ft1", {
          prompt: "deploy the function",
          reply: "assistant saw parseSession details",
        }), 10],
        ["nomatch.jsonl", claudeJsonlWithContent("ft2", { prompt: "unrelated topic" }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { filter: "parseSession" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // The free-text term "parseSession" should match via SearchIndex content.
      assert.ok(logs.some((l) => l.includes("1 sessions")), `expected 1 session matched by free text, got: ${JSON.stringify(logs)}`);
      assert.ok(logs.some((l) => l.includes("match.jsonl")));
      assert.ok(!logs.some((l) => l.includes("nomatch.jsonl")));
    });
  });
});

describe("cmdShare [project] --filter", () => {
  it("scopes project positional before --filter picks the match", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "share-proj-a", [
        ["a-sonnet.jsonl", claudeJsonlWithMeta("share-a", { model: "claude-sonnet-4-20250514", prompt: "alpha deploy" }), 100],
      ]);
      seedClaudeProject(tmpDir, "share-proj-b", [
        ["b-sonnet.jsonl", claudeJsonlWithMeta("share-b", { model: "claude-sonnet-4-20250514", prompt: "beta deploy newer" }), 0],
      ]);

      const { server, port } = await listenOnEphemeralPort();
      let sharedPrompt = "";
      server.on("request", (req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => { body += chunk; });
          req.on("end", () => {
            const parsed = JSON.parse(body);
            sharedPrompt = parsed.description || "";
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/share-filter", id: "sf" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const prevHome = process.env.HOME;
      const prevToken = process.env.GITHUB_TOKEN;
      const prevApi = process.env.GITHUB_API_URL;
      process.env.HOME = tmpDir;
      process.env.GITHUB_TOKEN = "fake";
      process.env.GITHUB_API_URL = `http://127.0.0.1:${port}`;

      try {
        await cmdShare(["share-proj-a"], { filter: "deploy", force: true, json: true });
        assert.match(sharedPrompt, /alpha deploy/i);
        assert.ok(!/beta deploy newer/i.test(sharedPrompt));
      } finally {
        process.env.HOME = prevHome;
        if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = prevToken;
        if (prevApi === undefined) delete process.env.GITHUB_API_URL;
        else process.env.GITHUB_API_URL = prevApi;
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// cmdSearch tests
// ---------------------------------------------------------------------------

/**
 * Build Claude JSONL with searchable text content to test cmdSearch.
 * SearchIndex terms come from the user prompt + assistant reply.
 */
function claudeJsonlWithContent(sessionId, { prompt = "hello", reply = "ok", model = "claude-sonnet-4-20250514" } = {}) {
  const ts = "2026-06-03T12:00:00Z";
  return (
    [
      JSON.stringify({
        type: "user",
        sessionId,
        message: { content: prompt },
        timestamp: ts,
        uuid: "u1",
        isMeta: false,
      }),
      JSON.stringify({
        type: "assistant",
        message: { model, content: [{ type: "text", text: reply }] },
        timestamp: ts,
        uuid: "a1",
      }),
    ].join("\n") + "\n"
  );
}

function claudeJsonlWithPrivacySentinels(sessionId, {
  promptTail,
  replyTail,
  rawJsonlSentinel,
  absPathSentinel,
  toolOutputSentinel,
} = {}) {
  const ts = "2026-06-03T12:00:00Z";
  const usefulPrompt = "Investigate compact-input privacy regression and keep a standup-safe progress summary.";
  const usefulReply = "Added focused regression coverage and preserved useful capped standup signal.";
  const commandPath = `/tmp/${absPathSentinel}/workspace/tracequest/private/secret-output.log`;
  const readPath = `/tmp/${absPathSentinel}/workspace/tracequest/private/config.secret`;
  return (
    [
      JSON.stringify({
        type: "user",
        sessionId,
        cwd: `/tmp/${absPathSentinel}/workspace/tracequest`,
        message: {
          content: `${usefulPrompt} ${"private prompt detail ".repeat(30)} ${promptTail}`,
        },
        timestamp: ts,
        uuid: "u-privacy",
        isMeta: false,
        rawTraceSentinel: rawJsonlSentinel,
      }),
      JSON.stringify({
        type: "assistant",
        sessionId,
        message: {
          model: "claude-sonnet-4-20250514",
          content: [
            { type: "text", text: `${usefulReply} ${"private assistant detail ".repeat(30)} ${replyTail}` },
            { type: "tool_use", id: "toolu_privacy_bash", name: "Bash", input: { command: `npm run test:privacy -- --log ${commandPath}` } },
            { type: "tool_use", id: "toolu_privacy_read", name: "Read", input: { file_path: readPath } },
          ],
        },
        timestamp: ts,
        uuid: "a-privacy",
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_privacy_bash",
              content: [{ type: "text", text: `private command output ${toolOutputSentinel}\n`.repeat(40) }],
            },
            {
              type: "tool_result",
              tool_use_id: "toolu_privacy_read",
              content: [{ type: "text", text: `private file contents ${toolOutputSentinel}` }],
            },
          ],
        },
        timestamp: ts,
        uuid: "tr-privacy",
        isMeta: false,
      }),
    ].join("\n") + "\n"
  );
}

describe("cli-commands cmdSearch", () => {
  it("dies when no query is given", () => {
    const { threw, errors } = captureExit(() => cmdSearch([], {}));
    assert.equal(threw, true);
    assert.ok(errors.some((e) => e.includes("query")));
  });

  it("showHelp via --help exits 0", () => {
    const { threw, code, logs } = captureExit(() => cmdSearch([], { help: true }));
    assert.equal(threw, true);
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("tracequest")));
  });

  it("finds sessions matching a query in session content", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "search-proj", [
        ["match.jsonl", claudeJsonlWithContent("s1", { prompt: "the parseSession function is broken" }), 10],
        ["nomatch.jsonl", claudeJsonlWithContent("s2", { prompt: "unrelated topic about cats" }), 5],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["parseSession"], {});
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Should find at least 1 result
      assert.ok(logs.some((l) => l.includes("result")));
      assert.ok(logs.some((l) => l.includes("match.jsonl")));
    });
  });

  it("returns gracefully when no results match the query", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "search-empty", [
        ["only.jsonl", claudeJsonlWithContent("s1", { prompt: "normal session" }), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["xyzzynonexistentterm12345"], {});
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("No sessions match")));
    });
  });

  it("respects --limit flag", async () => {
    await withTmpHome(async (tmpDir) => {
      // Create multiple sessions all containing the search term
      const files = [];
      for (let i = 0; i < 5; i++) {
        files.push([`s${i}.jsonl`, claudeJsonlWithContent(`s${i}`, { prompt: `the needle is in session ${i}` }), i * 10]);
      }
      seedClaudeProject(tmpDir, "search-limit", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["needle"], { limit: "2" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Count the number of session path lines shown (lines containing .jsonl)
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.ok(sessionLines.length <= 2, `expected at most 2 results, got ${sessionLines.length}`);
    });
  });

  it("joins multi-word positionals into a single query", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "search-multi", [
        ["multi.jsonl", claudeJsonlWithContent("s1", { prompt: "error handling in production" }), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        // Multi-word query passed as separate positionals
        cmdSearch(["error", "handling"], {});
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("result")));
    });
  });

  it("handoff prints Markdown to stdout with progress on stderr", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "handoff-proj", [
        ["match.jsonl", claudeJsonlWithContent("handoff-s1", { prompt: "handoff needle query in a compact result" }), 0],
      ]);
      const { threw, code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["handoff", "needle"], { format: "handoff", limit: "1" });
      });
      const hash = SESSION_HASH_RE.source.slice(1, -1);
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Query: `handoff needle`/);
      assert.match(stdout, new RegExp(`Session \`${hash}\``));
      assert.match(stdout, new RegExp(`tracequest render ${hash}`));
      assert.match(stdout, new RegExp(`tracequest messages ${hash} --pretty`));
      assert.match(stdout, /handoff needle/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.equal(stdout.includes(tmpDir), false, "handoff output should avoid absolute paths");
      assert.equal(stdout.includes("match.jsonl"), false, "handoff output should prefer hashes over filenames");
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index for 1 sessions/);
    });
  });

  it("direct handoff command prints Markdown to stdout with progress on stderr", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "handoff-direct", [
        ["match.jsonl", claudeJsonlWithContent("handoff-direct-s1", { prompt: "direct handoff command needle in a compact result" }), 0],
      ]);
      const { threw, code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdHandoff(["direct", "handoff", "needle"], { limit: "1" });
      });
      const hash = SESSION_HASH_RE.source.slice(1, -1);
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Query: `direct handoff needle`/);
      assert.match(stdout, new RegExp(`Session \`${hash}\``));
      assert.match(stdout, /Refresh this handoff: `tracequest handoff 'direct handoff needle' --limit 1`/);
      assert.match(stdout, new RegExp(`tracequest render ${hash}`));
      assert.match(stdout, new RegExp(`tracequest messages ${hash} --pretty`));
      assert.doesNotMatch(stdout, /Discovering sessions|Building index|Running standup agent/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.equal(stdout.includes(tmpDir), false, "direct handoff output should avoid absolute paths");
      assert.equal(stdout.includes("match.jsonl"), false, "direct handoff output should prefer hashes over filenames");
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index for 1 sessions/);
    });
  });

  it("direct handoff command applies --filter before search", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "handoff-filter-include", [
        ["match.jsonl", claudeJsonlWithContent("handoff-filter-s1", { prompt: "shared handoff filter needle in included project" }), 10],
      ]);
      seedClaudeProject(tmpDir, "handoff-filter-exclude", [
        ["excluded.jsonl", claudeJsonlWithContent("handoff-filter-s2", { prompt: "shared handoff filter needle in excluded project" }), 0],
      ]);
      const { threw, code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdHandoff(["shared", "handoff", "filter", "needle"], {
          filter: "project:handoff-filter-include",
          limit: "5",
        });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Query: `shared handoff filter needle`/);
      assert.match(stdout, /- Results: 1/);
      assert.match(stdout, /Project: `handoff-filter-include`/);
      assert.doesNotMatch(stdout, /handoff-filter-exclude/);
      assert.doesNotMatch(stdout, /Discovering sessions|Filtering sessions|Building index|Running standup agent/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.equal(stdout.includes(tmpDir), false, "filtered handoff output should avoid absolute paths");
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Filtering sessions/);
      assert.match(stderr, /Building index for 1 sessions/);
    });
  });

  it("direct handoff command orders matching results by recency when --sort recent", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "handoff-sort-old", [
        [
          "old.jsonl",
          claudeJsonlWithContent("handoff-sort-old-s1", {
            prompt: `${"handoff recency needle ".repeat(40)}older high relevance match`,
          }),
          86_400,
        ],
      ]);
      seedClaudeProject(tmpDir, "handoff-sort-new", [
        [
          "new.jsonl",
          claudeJsonlWithContent("handoff-sort-new-s1", {
            prompt: "handoff recency needle newer low relevance match",
          }),
          0,
        ],
      ]);

      const defaultResult = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdHandoff(["handoff", "recency", "needle"], { limit: "1" });
      });
      assert.equal(defaultResult.threw, true);
      assert.equal(defaultResult.code, 0);
      assert.match(defaultResult.stdout, /- Sort: `relevance`/);
      assert.match(defaultResult.stdout, /Project: `handoff-sort-old`/);
      assert.doesNotMatch(defaultResult.stdout, /Project: `handoff-sort-new`/);

      const dateAlias = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdHandoff(["handoff", "recency", "needle"], {
          sort: "date",
          limit: "1",
        });
      });
      assert.equal(dateAlias.threw, true);
      assert.equal(dateAlias.code, 0);
      assert.match(dateAlias.stdout, /- Sort: `date`/);
      assert.match(dateAlias.stdout, /Project: `handoff-sort-new`/);
      assert.match(dateAlias.stdout, /Refresh this handoff: `tracequest handoff 'handoff recency needle' --sort date --limit 1`/);

      const { threw, code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdHandoff(["handoff", "recency", "needle"], {
          sort: "recent",
          limit: "1",
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Sort: `recent`/);
      assert.match(stdout, /- Results: 1/);
      assert.match(stdout, /Project: `handoff-sort-new`/);
      assert.doesNotMatch(stdout, /Project: `handoff-sort-old`/);
      assert.match(stdout, /Refresh this handoff: `tracequest handoff 'handoff recency needle' --sort recent --limit 1`/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index|Running standup agent/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index for 2 sessions/);
    });
  });

  it("direct handoff quoted recent sort keeps phrase verification capped", async () => {
    await withTmpHome(async (tmpDir) => {
      const phrase = "handoff quoted cap";
      const files = [];
      for (let i = 0; i < 200; i++) {
        files.push([
          `nonphrase-${String(i).padStart(3, "0")}.jsonl`,
          claudeJsonlWithContent(`handoff-quoted-cap-nonphrase-${i}`, {
            prompt: `handoff quoted scattered cap nonphrase ${i}`,
          }),
          i,
        ]);
      }
      files.push([
        "older-exact.jsonl",
        claudeJsonlWithContent("handoff-quoted-cap-exact", {
          prompt: `older exact ${phrase} match beyond the default phrase scan cap`,
        }),
        1000,
      ]);
      seedClaudeProject(tmpDir, "handoff-quoted-cap", files);

      for (const sort of ["recent", "date"]) {
        const { threw, code, stdout, stderr } = captureExitWithStreams(() => {
          process.env.HOME = tmpDir;
          cmdHandoff([`"${phrase}"`], {
            sort,
            limit: "1",
          });
        });

        assert.equal(threw, true);
        assert.equal(code, 0);
        assert.match(stdout, /^# TraceQuest Search Handoff\n/);
        assert.match(stdout, new RegExp(`- Sort: \`${sort}\``));
        assert.match(stdout, /- Results: 0/);
        assert.match(stdout, /No matching sessions found\./);
        assert.doesNotMatch(stdout, /Project: `handoff-quoted-cap`/);
        assert.doesNotMatch(stdout, /older exact/);
        assert.doesNotMatch(stdout, /Running standup agent/);
        assert.match(stderr, /Discovering sessions/);
        assert.match(stderr, /Building index for 201 sessions/);
      }
    });
  });

  it("handoff renders Markdown-sensitive project names and snippets as code spans", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "handoff-[proj]*", [
        [
          "match.jsonl",
          claudeJsonlWithContent("handoff-s2", {
            prompt: "handoff-needle # forged heading [link](https://example.test) *bold* `code`",
          }),
          0,
        ],
      ]);
      const { threw, code, stdout } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["handoff-needle"], { format: "handoff", limit: "1" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /Project: `handoff-\[proj\]\*`/);
      assert.match(stdout, /Snippets:/);
      assert.match(stdout, /handoff-needle/);
      assert.doesNotMatch(stdout, /^# forged heading/m);
      assert.doesNotMatch(stdout, /^\*bold\*/m);
    });
  });

  it("handoff empty states keep stdout markdown and progress on stderr", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "handoff-empty", [
        ["only.jsonl", claudeJsonlWithContent("handoff-empty-s1", { prompt: "ordinary session text" }), 0],
      ]);
      const { threw, code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["xyzzynonexistentterm12345"], { format: "handoff", limit: "3" });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Results: 0/);
      assert.match(stdout, /No matching sessions found\./);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.equal(stdout.includes(tmpDir), false, "empty handoff should avoid absolute paths");
      assert.equal(stdout.includes("only.jsonl"), false, "empty handoff should avoid filenames");
      assert.match(stderr, /Discovering sessions/);
      assert.match(stderr, /Building index for 1 sessions/);
    });

    await withTmpHome(async (tmpDir) => {
      const { threw, code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["anything"], { format: "handoff", limit: "3" });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Search Handoff\n/);
      assert.match(stdout, /- Results: 0/);
      assert.match(stdout, /No matching sessions found\./);
      assert.doesNotMatch(stdout, /No sessions found/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index/);
      assert.doesNotMatch(stdout, /\x1b\[/);
      assert.match(stderr, /Discovering sessions/);
      assert.doesNotMatch(stderr, /Building index/);
    });
  });

  it("reports no sessions found when HOME is empty", async () => {
    await withTmpHome(async (tmpDir) => {
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["anything"], {});
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("No sessions found")));
    });
  });
});

describe("cli-commands cmdStandup", () => {
  it("standup --probe-agents probes synthetic installed agents without profiles or sessions", async () => {
    const tmpDir = mkdtempSync(join(os.tmpdir(), "tq-cli-probe-home-"));
    try {
      const fakeBin = writeFakeStandupProbePath(tmpDir);
      const oldPath = process.env.PATH;
      const oldFakeBin = process.env.TRACEQUEST_FAKE_BIN;
      const oldHome = process.env.HOME;
      try {
        process.env.HOME = tmpDir;
        process.env.PATH = fakeBin;
        process.env.TRACEQUEST_FAKE_BIN = fakeBin;
        const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
          return cmdStandup(["ignored-project"], {
            "probe-agents": true,
            profile: "missing-profile-must-not-load",
            "agent-timeout-ms": "1000",
          });
        });

        assert.equal(threw, true);
        assert.equal(code, 0);
        assertProbePreflight(stderr);
        assert.doesNotMatch(stdout, /No sessions found|TraceQuest Standup Request/);
        assert.doesNotMatch(stdout, /TraceQuest standup agent probe:/);
        assert.equal(stdout.includes(tmpDir), false, "probe report must not include temp HOME");
        const jsonStart = stdout.indexOf('{\n  "mode"');
        assert.notEqual(jsonStart, -1, `probe JSON report missing from stdout: ${JSON.stringify(stdout.slice(0, 80))}`);
        const report = JSON.parse(stdout.slice(jsonStart));
        assert.equal(report.mode, "standup-agent-probe");
        assert.match(report.dataPolicy, /synthetic prompts only/);
        assert.match(report.dataPolicy, /no raw JSONL/);
        assert.equal(report.timeoutMs, 1000);
        assert.deepEqual(report.actions, {
          loadedProfile: false,
          discoveredSessions: false,
          builtCompactInputFromRealTraces: false,
          sentPrivateTraceData: false,
        });
        assert.deepEqual(report.summary, { passed: 1, failed: 0, missing: 2, skipped: 0 });
        assert.deepEqual(report.agents.map((agent) => [agent.id, agent.status]), [
          ["codex", "passed"],
          ["claude", "missing"],
          ["droid", "missing"],
        ]);
        assert.match(report.agents[0].stdoutSnippet, /TQ_AGENT_PROBE_CODEX_OK/);
        assert.match(report.agents[0].args.join(" "), /--skip-git-repo-check/);
      } finally {
        if (oldPath === undefined) delete process.env.PATH;
        else process.env.PATH = oldPath;
        if (oldFakeBin === undefined) delete process.env.TRACEQUEST_FAKE_BIN;
        else process.env.TRACEQUEST_FAKE_BIN = oldFakeBin;
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("standup dry-run agent detection resolves CLI argv without sessions or agent invocation", async () => {
    await withTmpHome(async (tmpDir) => {
      const marker = join(tmpDir, "dry-run-agent-ran");
      const agentCode = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`;
      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          "dry-run-agent-detection": true,
          "agent-command": process.execPath,
          "agent-arg": ["-e", agentCode],
          "agent-timeout-ms": "1111",
          param: ["model=cli-model"],
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.equal(stderr, "");
      assert.equal(existsSync(marker), false);
      assert.doesNotMatch(stdout, /TraceQuest Standup Request|Omitted: raw JSONL|Running standup agent/);
      const report = JSON.parse(stdout);
      assert.equal(report.mode, "standup-agent-detection-dry-run");
      assert.deepEqual(report.agent, {
        id: "configured",
        source: "configured",
        command: process.execPath,
        args: ["-e", agentCode, "--model", "cli-model"],
        input: "stdin",
      });
      assert.equal(report.timeoutMs, 1111);
      assert.deepEqual(report.actions, {
        discoveredSessions: false,
        builtCompactInput: false,
        sentPrompt: false,
        invokedAgent: false,
      });
    });
  });

  it("standup dry-run agent detection uses env defaults without sessions or agent invocation", async () => {
    await withTmpHome(async (tmpDir) => {
      const marker = join(tmpDir, "dry-run-env-agent-ran");
      const oldCommand = process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
      const oldArgs = process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
      const oldTimeout = process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
      try {
        process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = process.execPath;
        process.env.TRACEQUEST_STANDUP_AGENT_ARGS = JSON.stringify([
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          "--",
          "--from-env",
        ]);
        process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = "2222";

        const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], {
            "dry-run-agent-detection": true,
          });
        });

        assert.equal(threw, true);
        assert.equal(code, 0);
        assert.equal(stderr, "");
        assert.equal(existsSync(marker), false);
        const report = JSON.parse(stdout);
        assert.equal(report.agent.command, process.execPath);
        assert.deepEqual(report.agent.args.slice(-1), ["--from-env"]);
        assert.equal(report.timeoutMs, 2222);
        assert.equal(report.actions.invokedAgent, false);
      } finally {
        if (oldCommand === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        else process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = oldCommand;
        if (oldArgs === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        else process.env.TRACEQUEST_STANDUP_AGENT_ARGS = oldArgs;
        if (oldTimeout === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
        else process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = oldTimeout;
      }
    });
  });

  it("standup dry-run agent detection loads profile agent defaults before session discovery", async () => {
    await withTmpHome(async (tmpDir) => {
      const marker = join(tmpDir, "dry-run-profile-agent-ran");
      writeStandupProfiles(tmpDir, {
        audit: {
          project: "profile-project-with-no-sessions",
          agentCommand: process.execPath,
          agentArgs: [
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
            "--",
            "--from-profile",
          ],
          agentTimeoutMs: 3333,
          params: { model: "profile-model" },
        },
      });

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          profile: "audit",
          "dry-run-agent-detection": true,
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.equal(stderr, "");
      assert.equal(existsSync(marker), false);
      assert.doesNotMatch(stdout, /No sessions found|TraceQuest Standup Request/);
      const report = JSON.parse(stdout);
      assert.equal(report.agent.command, process.execPath);
      assert.deepEqual(report.agent.args.slice(-3), ["--from-profile", "--model", "profile-model"]);
      assert.equal(report.timeoutMs, 3333);
      assert.equal(report.actions.discoveredSessions, false);
    });
  });

  it("standup profile/env/CLI precedence resolves agent defaults before sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      const oldCommand = process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
      const oldArgs = process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
      const oldTimeout = process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
      try {
        process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = "env-agent";
        process.env.TRACEQUEST_STANDUP_AGENT_ARGS = JSON.stringify(["--from-env"]);
        process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = "1111";
        writeStandupProfiles(tmpDir, {
          daily: {
            project: "profile-project-with-no-sessions",
            agentCommand: "profile-agent",
            agentArgs: ["--from-profile"],
            agentTimeoutMs: 2222,
            params: { model: "profile-model" },
          },
        });

        const profileResult = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], {
            profile: "daily",
            "dry-run-agent-detection": true,
          });
        });
        assert.equal(profileResult.threw, true);
        assert.equal(profileResult.code, 0);
        assert.equal(profileResult.stderr, "");
        assert.doesNotMatch(profileResult.stdout, /No sessions found|TraceQuest Standup Request/);
        const profileReport = JSON.parse(profileResult.stdout);
        assert.equal(profileReport.agent.command, "profile-agent");
        assert.deepEqual(profileReport.agent.args, ["--from-profile", "--model", "profile-model"]);
        assert.equal(profileReport.timeoutMs, 2222);
        assert.equal(profileReport.actions.discoveredSessions, false);
        assert.equal(profileReport.actions.invokedAgent, false);

        const cliResult = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], {
            profile: "daily",
            "dry-run-agent-detection": true,
            "agent-command": "cli-agent",
            "agent-arg": ["--from-cli"],
            "agent-timeout-ms": "3333",
            param: ["model=cli-model", "json"],
          });
        });
        assert.equal(cliResult.threw, true);
        assert.equal(cliResult.code, 0);
        assert.equal(cliResult.stderr, "");
        const cliReport = JSON.parse(cliResult.stdout);
        assert.equal(cliReport.agent.command, "cli-agent");
        assert.deepEqual(cliReport.agent.args, ["--from-cli", "--model", "cli-model", "--json"]);
        assert.equal(cliReport.timeoutMs, 3333);
        assert.equal(cliReport.actions.discoveredSessions, false);
        assert.equal(cliReport.actions.invokedAgent, false);
      } finally {
        if (oldCommand === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        else process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = oldCommand;
        if (oldArgs === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        else process.env.TRACEQUEST_STANDUP_AGENT_ARGS = oldArgs;
        if (oldTimeout === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
        else process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = oldTimeout;
      }
    });
  });

  it("standup mixed partial agent overrides isolate command argv before sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      const oldCommand = process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
      const oldArgs = process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
      const oldTimeout = process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
      try {
        process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = "env-agent";
        process.env.TRACEQUEST_STANDUP_AGENT_ARGS = JSON.stringify(["--from-env"]);
        process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = "1111";
        writeStandupProfiles(tmpDir, {
          daily: {
            project: "profile-project-with-no-sessions",
            agentCommand: "profile-agent",
            agentArgs: ["--from-profile"],
            agentTimeoutMs: 2222,
            params: { model: "profile-model" },
          },
        });

        const commandResult = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], {
            profile: "daily",
            "dry-run-agent-detection": true,
            "agent-command": "cli-agent",
          });
        });
        assert.equal(commandResult.threw, true);
        assert.equal(commandResult.code, 0);
        assert.equal(commandResult.stderr, "");
        assert.doesNotMatch(commandResult.stdout, /No sessions found|TraceQuest Standup Request/);
        const commandReport = JSON.parse(commandResult.stdout);
        assert.equal(commandReport.agent.command, "cli-agent");
        assert.deepEqual(commandReport.agent.args, []);
        assert.equal(commandReport.timeoutMs, 2222);
        assert.equal(commandReport.actions.discoveredSessions, false);
        assert.equal(commandReport.actions.invokedAgent, false);

        const argsResult = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], {
            profile: "daily",
            "dry-run-agent-detection": true,
            "agent-arg": ["--from-cli"],
          });
        });
        assert.equal(argsResult.threw, true);
        assert.equal(argsResult.code, 0);
        assert.equal(argsResult.stderr, "");
        const argsReport = JSON.parse(argsResult.stdout);
        assert.equal(argsReport.agent.command, "profile-agent");
        assert.deepEqual(argsReport.agent.args, ["--from-cli", "--model", "profile-model"]);
        assert.equal(argsReport.timeoutMs, 2222);
        assert.equal(argsReport.actions.discoveredSessions, false);
        assert.equal(argsReport.actions.invokedAgent, false);
      } finally {
        if (oldCommand === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        else process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = oldCommand;
        if (oldArgs === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        else process.env.TRACEQUEST_STANDUP_AGENT_ARGS = oldArgs;
        if (oldTimeout === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
        else process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = oldTimeout;
      }
    });
  });

  it("cmdStandup --print-input selects recent sessions and skips agent invocation", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-proj", [
        ["old.jsonl", claudeJsonlWithContent("standup-old", { prompt: "old standup prompt should be omitted" }), 200],
        ["new.jsonl", claudeJsonlWithContent("standup-new", { prompt: "new standup compact prompt" }), 0],
      ]);
      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          "print-input": true,
          limit: "1",
          "agent-command": process.execPath,
          "agent-arg": ["-e", "process.stdout.write('AGENT SHOULD NOT RUN')"],
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /Sessions selected: 1 of 1/);
      assert.match(stdout, /new standup compact prompt/);
      assert.doesNotMatch(stdout, /old standup prompt should be omitted/);
      assert.doesNotMatch(stdout, /AGENT SHOULD NOT RUN/);
      assert.doesNotMatch(stdout, /\/home\/dev/);
      assert.equal(stderr, "");
    });
  });

  it("cmdStandup --print-input privacy regression omits adversarial raw trace sentinels while keeping capped summaries", async () => {
    await withTmpHome(async (tmpDir) => {
      const promptTail = "FULL_PRIVATE_PROMPT_TAIL_SENTINEL_CLI_61GF";
      const replyTail = "FULL_PRIVATE_ASSISTANT_TAIL_SENTINEL_CLI_72HT";
      const rawJsonlSentinel = "RAW_JSONL_RECORD_SENTINEL_CLI_83JV";
      const absPathSentinel = "ABSOLUTE_SESSION_PATH_SENTINEL_CLI_94KW";
      const toolOutputSentinel = "FULL_TOOL_OUTPUT_SENTINEL_CLI_A5LX";
      const [sessionPath] = seedClaudeProject(tmpDir, "standup-privacy-regression", [
        [
          "privacy.jsonl",
          claudeJsonlWithPrivacySentinels("standup-privacy-cli", {
            promptTail,
            replyTail,
            rawJsonlSentinel,
            absPathSentinel,
            toolOutputSentinel,
          }),
          0,
        ],
      ]);

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup(["standup-privacy-regression"], {
          "print-input": true,
          limit: "1",
          "agent-command": process.execPath,
          "agent-arg": ["-e", "process.stdout.write('AGENT SHOULD NOT RUN')"],
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /Omitted: raw JSONL/);
      assert.match(stdout, /Sessions selected: 1 of 1/);
      assert.match(stdout, /Project: standup-privacy-regression/);
      assert.match(stdout, /Investigate compact-input privacy regression/);
      assert.match(stdout, /Added focused regression coverage/);
      assert.match(stdout, /Bash x1, Read x1/);
      assert.match(stdout, /Commands: \[ok\] npm run test:privacy -- --log \.\.\.\/secret-output\.log/);
      assert.match(stdout, /Files: private\/config\.secret \(Read\)/);
      assert.match(stdout, /\.\.\./);
      assert.doesNotMatch(stdout, /AGENT SHOULD NOT RUN/);

      for (const privateNeedle of [
        promptTail,
        replyTail,
        rawJsonlSentinel,
        absPathSentinel,
        toolOutputSentinel,
        sessionPath,
        tmpDir,
        "privacy.jsonl",
        "\"type\":\"user\"",
        "\"type\":\"tool_result\"",
        "\"sessionId\":\"standup-privacy-cli\"",
      ]) {
        assert.ok(!stdout.includes(privateNeedle), `--print-input leaked ${privateNeedle}`);
      }
      assert.equal(stderr, "");
    });
  });

  it("standup selection windows apply --since before compact input", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-window-proj", [
        ["old.jsonl", claudeJsonlWithContent("standup-window-old", { prompt: "old window prompt should be omitted" }), 10 * 60 * 60],
        ["new.jsonl", claudeJsonlWithContent("standup-window-new", { prompt: "recent window prompt should be included" }), 60],
      ]);
      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          "print-input": true,
          since: "2h",
          limit: "5",
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /Window: since 2h/);
      assert.match(stdout, /Sessions selected: 1 of 1/);
      assert.match(stdout, /recent window prompt should be included/);
      assert.doesNotMatch(stdout, /old window prompt should be omitted/);
      assert.equal(stderr, "");
    });
  });

  it("standup --workday applies the local business-hours window before compact input", async () => {
    await withTmpHome(async (tmpDir) => {
      const [insidePath, outsidePath] = seedClaudeProject(tmpDir, "standup-workday-proj", [
        ["inside.jsonl", claudeJsonlWithContent("standup-workday-inside", { prompt: "inside workday prompt should be included" })],
        ["outside.jsonl", claudeJsonlWithContent("standup-workday-outside", { prompt: "outside workday prompt should be omitted" })],
      ]);
      const now = new Date();
      const inside = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
      const outside = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
      utimesSync(insidePath, inside, inside);
      utimesSync(outsidePath, outside, outside);

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          "print-input": true,
          workday: true,
          limit: "5",
          "agent-command": process.execPath,
          "agent-arg": ["-e", "process.stdout.write('AGENT SHOULD NOT RUN')"],
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /Window: workday \(09:00-17:00 local\)/);
      assert.match(stdout, /Sessions selected: 1 of 1/);
      assert.match(stdout, /inside workday prompt should be included/);
      assert.doesNotMatch(stdout, /outside workday prompt should be omitted/);
      assert.doesNotMatch(stdout, /AGENT SHOULD NOT RUN/);
      assert.doesNotMatch(stdout, /\/home\/dev/);
      assert.equal(stderr, "");
    });
  });

  it("standup --previous-workday applies the previous weekday business-hours window before compact input", async () => {
    await withTmpHome(async (tmpDir) => {
      const [insidePath, earlyPath, todayPath] = seedClaudeProject(tmpDir, "standup-previous-workday-proj", [
        ["inside.jsonl", claudeJsonlWithContent("standup-prev-workday-inside", { prompt: "previous workday prompt should be included" })],
        ["early.jsonl", claudeJsonlWithContent("standup-prev-workday-early", { prompt: "early previous workday prompt should be omitted" })],
        ["today.jsonl", claudeJsonlWithContent("standup-prev-workday-today", { prompt: "today prompt should be omitted from previous workday" })],
      ]);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 0, 0);
      const inside = previousWeekdayAt(10);
      const early = previousWeekdayAt(8);
      utimesSync(insidePath, inside, inside);
      utimesSync(earlyPath, early, early);
      utimesSync(todayPath, today, today);

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          "print-input": true,
          "previous-workday": true,
          limit: "5",
          "agent-command": process.execPath,
          "agent-arg": ["-e", "process.stdout.write('AGENT SHOULD NOT RUN')"],
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /Window: previous workday \(09:00-17:00 local\)/);
      assert.match(stdout, /Sessions selected: 1 of 1/);
      assert.match(stdout, /previous workday prompt should be included/);
      assert.doesNotMatch(stdout, /early previous workday prompt should be omitted/);
      assert.doesNotMatch(stdout, /today prompt should be omitted from previous workday/);
      assert.doesNotMatch(stdout, /AGENT SHOULD NOT RUN/);
      assert.equal(stderr, "");
    });
  });

  it("standup profiles load defaults and explicit CLI flags override profile values", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-profile-keep", [
        ["old.jsonl", claudeJsonlWithContent("standup-profile-old", { prompt: "old profile prompt should be omitted" }), 10 * 60 * 60],
        ["new.jsonl", claudeJsonlWithContent("standup-profile-new", { prompt: "recent profile prompt should be included" }), 60],
      ]);
      seedClaudeProject(tmpDir, "standup-profile-drop", [
        ["drop.jsonl", claudeJsonlWithContent("standup-profile-drop", { prompt: "dropped profile project prompt" }), 0],
      ]);
      const agentCode = [
        "let stdin = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { stdin += chunk; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({",
        "    argv: process.argv.slice(1),",
        "    hasHeader: stdin.includes('# TraceQuest Standup Request'),",
        "    hasPrivacyBoundary: stdin.includes('Omitted: raw JSONL'),",
        "    hasRawJsonl: stdin.includes('\\\"type\\\":\\\"user\\\"'),",
        "    hasRecent: stdin.includes('recent profile prompt should be included'),",
        "    hasOld: stdin.includes('old profile prompt should be omitted'),",
        "    hasDrop: stdin.includes('dropped profile project prompt'),",
        "  }));",
        "});",
      ].join("\n");
      writeStandupProfiles(tmpDir, {
        daily: {
          project: "standup-profile-keep",
          since: "2h",
          limit: 1,
          agentCommand: process.execPath,
          agentArgs: ["-e", agentCode, "--", "--from-profile"],
          agentTimeoutMs: 9999,
          params: {
            model: "profile-model",
          },
        },
      });

      const { threw, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          profile: "daily",
          param: ["model=cli-model"],
          "agent-timeout-ms": "3333",
        });
      });

      assert.equal(threw, false);
      const jsonMatch = stdout.match(/\{"argv":\[.*?\],"hasHeader":(?:true|false),"hasPrivacyBoundary":(?:true|false),"hasRawJsonl":(?:true|false),"hasRecent":(?:true|false),"hasOld":(?:true|false),"hasDrop":(?:true|false)\}/s);
      assert.ok(jsonMatch, `expected agent JSON in stdout, got: ${JSON.stringify(stdout.slice(0, 120))}`);
      const parsed = JSON.parse(jsonMatch[0]);
      assert.deepEqual(parsed.argv, ["--from-profile", "--model", "cli-model"]);
      assert.equal(parsed.hasHeader, true);
      assert.equal(parsed.hasPrivacyBoundary, true);
      assert.equal(parsed.hasRawJsonl, false);
      assert.equal(parsed.hasRecent, true);
      assert.equal(parsed.hasOld, false);
      assert.equal(parsed.hasDrop, false);
      assert.match(stderr, /Running standup agent:/);
      assert.match(stderr, /timeout 3333ms/);
    });
  });

  it("standup profile print-input audit skips profile-configured agent", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-profile-audit", [
        ["new.jsonl", claudeJsonlWithContent("standup-profile-audit", { prompt: "profile audit prompt" }), 0],
      ]);
      writeStandupProfiles(tmpDir, {
        audit: {
          project: "standup-profile-audit",
          limit: 1,
          agentCommand: process.execPath,
          agentArgs: ["-e", "process.stdout.write('PROFILE AGENT SHOULD NOT RUN')"],
        },
      });

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          profile: "audit",
          "print-input": true,
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.match(stdout, /^# TraceQuest Standup Request\n/);
      assert.match(stdout, /profile audit prompt/);
      assert.match(stdout, /Omitted: raw JSONL/);
      assert.doesNotMatch(stdout, /PROFILE AGENT SHOULD NOT RUN/);
      assert.equal(stderr, "");
    });
  });

  it("standup profile invalid config reports malformed JSON before sessions or agents", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-profile-invalid-json", [
        ["new.jsonl", claudeJsonlWithContent("standup-profile-invalid-json", { prompt: "profile JSON should not parse sessions" }), 0],
      ]);
      const configDir = join(tmpDir, ".tracequest");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(join(configDir, "standup-profiles.json"), "{not json");

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          profile: "bad",
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /Failed to parse standup profile JSON file .*standup-profiles\.json:/);
      assert.doesNotMatch(stderr, /No sessions found|Running standup agent|profile JSON should not parse sessions/);
    });
  });

  it("standup profile invalid config rejects nonscalar agent args before fake agent execution", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-profile-invalid-args", [
        ["new.jsonl", claudeJsonlWithContent("standup-profile-invalid-args", { prompt: "profile args should not reach agent" }), 0],
      ]);
      const marker = join(tmpDir, "invalid-profile-agent-ran");
      const agentCode = [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`,
        "process.stdout.write('PROFILE AGENT SHOULD NOT RUN');",
      ].join("\n");
      writeStandupProfiles(tmpDir, {
        bad: {
          project: "standup-profile-invalid-args",
          agentCommand: process.execPath,
          agentArgs: ["-e", agentCode, { nested: true }],
          params: {
            model: "fake-model",
          },
        },
      });

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          profile: "bad",
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /Standup profile agentArgs must be a string or an array of string\/number\/boolean values; got object\./);
      assert.doesNotMatch(stderr, /Running standup agent|PROFILE AGENT SHOULD NOT RUN|profile args should not reach agent/);
      assert.equal(existsSync(marker), false);
    });
  });

  it("standup env defaults provide agent command args and timeout", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-env-proj", [
        ["new.jsonl", claudeJsonlWithContent("standup-env", { prompt: "standup env prompt" }), 0],
      ]);
      const oldCommand = process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
      const oldArgs = process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
      const oldTimeout = process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
      const agentCode = [
        "let stdin = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { stdin += chunk; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write(JSON.stringify({",
        "    argv: process.argv.slice(1),",
        "    hasInput: stdin.includes('# TraceQuest Standup Request'),",
        "    hasRawJsonl: stdin.includes('\\\"type\\\":\\\"user\\\"'),",
        "  }));",
        "});",
      ].join("\n");

      try {
        process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = process.execPath;
        process.env.TRACEQUEST_STANDUP_AGENT_ARGS = JSON.stringify(["-e", agentCode, "--", "--from-env"]);
        process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = "4321";
        const { threw, stdout, stderr } = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], { limit: "1" });
        });

        assert.equal(threw, false);
        const jsonMatch = stdout.match(/\{"argv":\[.*?\],"hasInput":(?:true|false),"hasRawJsonl":(?:true|false)\}/s);
        assert.ok(jsonMatch, `expected agent JSON in stdout, got: ${JSON.stringify(stdout.slice(0, 120))}`);
        const parsed = JSON.parse(jsonMatch[0]);
        assert.deepEqual(parsed.argv, ["--from-env"]);
        assert.equal(parsed.hasInput, true);
        assert.equal(parsed.hasRawJsonl, false);
        assert.match(stderr, /Running standup agent:/);
        assert.match(stderr, /timeout 4321ms/);
      } finally {
        if (oldCommand === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        else process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = oldCommand;
        if (oldArgs === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        else process.env.TRACEQUEST_STANDUP_AGENT_ARGS = oldArgs;
        if (oldTimeout === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
        else process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = oldTimeout;
      }
    });
  });

  it("cmdStandup surfaces an actionable hint when the agent refuses (trusted directory)", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-hint-proj", [
        ["new.jsonl", claudeJsonlWithContent("standup-hint", { prompt: "standup hint prompt" }), 0],
      ]);
      const agentCode = [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified.\\n');",
        "  process.exit(1);",
        "});",
      ].join("\n");
      const { threw, code, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          limit: "1",
          "agent-command": process.execPath,
          "agent-arg": ["-e", agentCode],
          "agent-timeout-ms": "5000",
        });
      });
      assert.equal(threw, true);
      assert.equal(code, 1);
      assert.match(stderr, /Error: Standup agent failed with exit code 1/);
      assert.match(stderr, /Hint:.*trusted git repo/);
      assert.match(stderr, /--skip-git-repo-check/);
    });
  });

  it("cmdStandup formats agent failures without hiding stdout or stderr", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-fail-proj", [
        ["new.jsonl", claudeJsonlWithContent("standup-fail", { prompt: "standup failure prompt" }), 0],
      ]);
      const agentCode = [
        "let stdin = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { stdin += chunk; });",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('agent stdout before failure\\n');",
        "  process.stderr.write('agent stderr before failure\\n');",
        "  process.exit(7);",
        "});",
      ].join("\n");

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          limit: "1",
          "agent-command": process.execPath,
          "agent-arg": ["-e", agentCode],
          "agent-timeout-ms": "5000",
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 7);
      assert.match(stdout, /agent stdout before failure/);
      assert.match(stderr, /Running standup agent:/);
      assert.match(stderr, /agent stderr before failure/);
      assert.match(stderr, /Error: Standup agent failed with exit code 7/);
      assert.match(stderr, /Command: .* -e /);
      assert.match(stderr, /Stdout: agent stdout before failure/);
      assert.match(stderr, /Stderr: agent stderr before failure/);

      const signalAgentCode = [
        "process.stdin.resume();",
        "process.stdin.on('end', () => { process.kill(process.pid, 'SIGTERM'); });",
      ].join("\n");
      const signalResult = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          limit: "1",
          "agent-command": process.execPath,
          "agent-arg": ["-e", signalAgentCode],
          "agent-timeout-ms": "5000",
        });
      });

      assert.equal(signalResult.threw, true);
      assert.equal(signalResult.code, 1);
      assert.match(signalResult.stderr, /Running standup agent:/);
      assert.match(signalResult.stderr, /Error: Standup agent exited from signal SIGTERM/);
      assert.match(signalResult.stderr, /Stdout: \(empty\)/);
    });
  });

  it("cmdStandup timeout diagnostics preserve bounded stdout and stderr tails", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-timeout-noisy", [
        ["new.jsonl", claudeJsonlWithContent("standup-timeout-noisy", { prompt: "standup timeout noisy prompt" }), 0],
      ]);
      const agentScript = join(tmpDir, "noisy-timeout-agent.mjs");
      writeFileSync(agentScript, [
        "process.stdin.resume();",
        "process.stdout.write('STDOUT_HEAD_' + 'o'.repeat(900) + 'STDOUT_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG' + 'o'.repeat(900) + 'STDOUT_TAIL_NO_NEWLINE');",
        "process.stderr.write('STDERR_HEAD_' + 'e'.repeat(900) + 'STDERR_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG' + 'e'.repeat(900) + 'STDERR_TAIL_NO_NEWLINE');",
        "setInterval(() => {}, 1000);",
      ].join("\n"));

      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          limit: "1",
          "agent-command": process.execPath,
          "agent-arg": [agentScript],
          "agent-timeout-ms": "250",
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 1);
      assert.match(stdout, /STDOUT_HEAD_/);
      assert.match(stdout, /STDOUT_TAIL_NO_NEWLINE/);
      assert.match(stderr, /STDERR_TAIL_NO_NEWLINE\n\x1b\[31mError: Standup agent timed out after 250ms\./);

      const diagnostic = stderr.slice(stderr.lastIndexOf("Error: Standup agent timed out"));
      const stdoutSnippet = diagnostic.match(/Stdout: ([\s\S]*?)\nStderr:/)?.[1] || "";
      const stderrSnippet = diagnostic.match(/Stderr: ([\s\S]*?)\x1b\[0m/)?.[1] || "";
      assert.ok(stdoutSnippet.length <= 700, `stdout snippet should stay bounded, got ${stdoutSnippet.length} chars`);
      assert.ok(stderrSnippet.length <= 700, `stderr snippet should stay bounded, got ${stderrSnippet.length} chars`);
      assert.match(diagnostic, /Stdout: STDOUT_HEAD_/);
      assert.match(diagnostic, /STDOUT_TAIL_NO_NEWLINE/);
      assert.doesNotMatch(diagnostic, /STDOUT_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG/);
      assert.match(diagnostic, /Stderr: STDERR_HEAD_/);
      assert.match(diagnostic, /STDERR_TAIL_NO_NEWLINE/);
      assert.doesNotMatch(diagnostic, /STDERR_MIDDLE_SHOULD_NOT_APPEAR_IN_DIAG/);
      assert.match(diagnostic, /\.\.\. \[truncated\] \.\.\./);
    });
  });

  it("standup missing agent is reported before selected sessions are parsed", async () => {
    await withTmpHome(async (tmpDir) => {
      const [sessionPath] = seedClaudeProject(tmpDir, "standup-no-agent-invalid", [
        ["broken.jsonl", "not a valid jsonl private-parse-sentinel\n", 0],
      ]);
      const oldPath = process.env.PATH;
      const oldCommand = process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
      const oldArgs = process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
      const oldTimeout = process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
      try {
        process.env.PATH = "";
        delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;

        const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], {
            filter: "private-parse-sentinel",
            limit: "1",
          });
        });

        assert.equal(threw, true);
        assert.equal(code, 1);
        assert.equal(stdout, "");
        assert.match(stderr, /Error: No prompt-mode agent command found\./);
        assert.doesNotMatch(stderr, /Failed to parse session|TraceQuest Standup Request|Running standup agent/);
        assert.equal(stderr.includes(sessionPath), false, "missing-agent stderr must not expose the selected session path");
        assert.equal(stderr.includes(tmpDir), false, "missing-agent stderr must not expose HOME");
        assert.equal(stderr.includes("broken.jsonl"), false, "missing-agent stderr must not expose the session filename");
        assert.equal(stderr.includes("private-parse-sentinel"), false, "missing-agent stderr must not expose trace content");
      } finally {
        process.env.PATH = oldPath;
        if (oldCommand === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        else process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = oldCommand;
        if (oldArgs === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        else process.env.TRACEQUEST_STANDUP_AGENT_ARGS = oldArgs;
        if (oldTimeout === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
        else process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = oldTimeout;
      }
    });
  });

  it("standup empty and no-agent errors are stderr-only", async () => {
    await withTmpHome(async (tmpDir) => {
      const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
        process.env.HOME = tmpDir;
        return cmdStandup([], {
          "print-input": true,
          "agent-command": process.execPath,
        });
      });

      assert.equal(threw, true);
      assert.equal(code, 1);
      assert.equal(stdout, "");
      assert.match(stderr, /Error: No sessions found\./);
      assert.doesNotMatch(stderr, /TraceQuest Standup Request|Running standup agent/);
    });

    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "standup-no-agent", [
        ["new.jsonl", claudeJsonlWithContent("standup-no-agent", { prompt: "standup no agent prompt" }), 0],
      ]);
      const oldPath = process.env.PATH;
      const oldCommand = process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
      const oldArgs = process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
      const oldTimeout = process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
      try {
        process.env.PATH = "";
        delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;

        const { threw, code, stdout, stderr } = await captureExitWithStreamsAsync(() => {
          process.env.HOME = tmpDir;
          return cmdStandup([], { limit: "1" });
        });

        assert.equal(threw, true);
        assert.equal(code, 1);
        assert.equal(stdout, "");
        assert.match(stderr, /Error: No prompt-mode agent command found\./);
        assert.match(stderr, /Tried: codex, claude, droid\./);
        assert.match(stderr, /--agent-command/);
        assert.doesNotMatch(stderr, /TraceQuest Standup Request|Running standup agent/);
      } finally {
        process.env.PATH = oldPath;
        if (oldCommand === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_COMMAND;
        else process.env.TRACEQUEST_STANDUP_AGENT_COMMAND = oldCommand;
        if (oldArgs === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_ARGS;
        else process.env.TRACEQUEST_STANDUP_AGENT_ARGS = oldArgs;
        if (oldTimeout === undefined) delete process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS;
        else process.env.TRACEQUEST_STANDUP_AGENT_TIMEOUT_MS = oldTimeout;
      }
    });
  });
});

// ---------------------------------------------------------------------------
// cmdMessages tests
// ---------------------------------------------------------------------------

/** Build Claude JSONL with tool calls for messages export testing.
 *
 * Real Claude Code sessions embed tool_result blocks inside type:"user" rows
 * (not as top-level type:"tool_result" JSONL lines).  The parser's line-filter
 * (isClaudeIndexedJsonlLine) only passes type:"user" and type:"assistant",
 * so a top-level type:"tool_result" row would be silently skipped.
 */
function claudeJsonlWithToolCalls(sessionId) {
  const ts = "2026-06-03T12:00:00Z";
  return (
    [
      JSON.stringify({
        type: "user",
        sessionId,
        message: { content: "read the file" },
        timestamp: ts,
        uuid: "u1",
        isMeta: false,
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-20250514",
          content: [
            { type: "text", text: "I will read the file." },
            { type: "tool_use", id: "toolu_r1", name: "Read", input: { file_path: "/src/app.js" } },
          ],
        },
        timestamp: ts,
        uuid: "a1",
      }),
      JSON.stringify({
        type: "user",
        sessionId,
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_r1", content: "file contents here" },
          ],
        },
        timestamp: ts,
        uuid: "u2",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-sonnet-4-20250514",
          content: [{ type: "text", text: "The file contains the app code." }],
        },
        timestamp: ts,
        uuid: "a2",
      }),
    ].join("\n") + "\n"
  );
}

describe("cli-commands cmdMessages", () => {
  it("dies when session path is omitted", () => {
    const captured = captureExit(() => cmdMessages([], {}));
    assertDieStderr(captured, /session\.jsonl/);
  });

  it("exports the newest discovered session with --latest", async () => {
    await withTmpHome(async (home) => {
      seedClaudeProject(home, "msg-latest", [
        ["older.jsonl", claudeJsonlWithMeta("messages-older", { prompt: "older prompt" }), 20],
        ["newer.jsonl", claudeJsonlWithMeta("messages-newer", { prompt: "newer prompt" }), 0],
      ]);
      const { stdout, errors } = captureStdoutWrite(() => cmdMessages([], { latest: true }));
      assert.ok(errors.some((e) => e.includes("Parsing")));
      const result = JSON.parse(stdout.trim());
      assert.equal(result.session_id, "messages-newer");
      assert.equal(result.messages[0].content[0].text, "newer prompt");
    });
  });

  it("applies --filter when exporting --latest messages", async () => {
    await withTmpHome(async (home) => {
      seedClaudeProject(home, "msg-filter", [
        ["newer-opus.jsonl", claudeJsonlWithMeta("messages-opus", {
          model: "claude-opus-4-20250514",
          prompt: "opus prompt",
        }), 0],
        ["older-sonnet.jsonl", claudeJsonlWithMeta("messages-sonnet", {
          model: "claude-sonnet-4-20250514",
          prompt: "sonnet prompt",
        }), 20],
      ]);
      const { stdout } = captureStdoutWrite(() => {
        cmdMessages(["msg-filter"], { latest: true, filter: "model:sonnet", sort: "recent" });
      });
      const result = JSON.parse(stdout.trim());
      assert.equal(result.session_id, "messages-sonnet");
      assert.equal(result.messages[0].content[0].text, "sonnet prompt");
    });
  });

  it("rejects --filter without --latest", () => {
    assertDieStderr(
      captureExit(() => cmdMessages(["session.jsonl"], { filter: "source:claude" })),
      /--filter and --sort require --latest/,
    );
  });

  it("dies when session file does not exist", () => {
    const missing = join(os.tmpdir(), `tracequest-missing-msg-${Date.now()}.jsonl`);
    assertDieStderr(captureExit(() => cmdMessages([missing], {})), /File not found/);
  });

  it("dies for invalid --format value", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      assertDieStderr(captureExit(() => cmdMessages([jsonl], { format: "invalid" })), /Invalid format/);
    });
  });

  it("exports messages from opencode:// virtual URI", async () => {
    const home = mkdtempSync(join(os.tmpdir(), "tq-cli-msg-oc-"));
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const sessionId = "ses_integOpenCodeTestSession01";
      const uri = `opencode://${sessionId}`;
      await seedOpenCodeIndexDb(home, [
        {
          id: sessionId,
          messages: [
            { role: "user", parts: [{ type: "text", text: "cli opencode messages marker" }] },
            { role: "assistant", parts: [{ type: "text", text: "cli opencode reply" }] },
            { role: "user", parts: [{ type: "text", text: "third message" }] },
          ],
        },
      ]);
      const { stdout, errors } = captureStdoutWrite(() => cmdMessages([uri], {}));
      assert.ok(errors.some((e) => e.includes("Parsing")));
      const result = JSON.parse(stdout.trim());
      assert.equal(result.messages[0].role, "user");
      assert.ok(result.messages[0].content[0].text.includes("cli opencode messages marker"));
    } finally {
      process.env.HOME = originalHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("outputs valid JSON for anthropic format", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { stdout, errors } = captureStdoutWrite(() => cmdMessages([jsonl], {}));
      // stderr gets "Parsing session..." info
      assert.ok(errors.some((e) => e.includes("Parsing")));
      // stdout should be valid JSON
      const result = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(result.messages));
      assert.ok(result.messages.length > 0);
      // Default format is anthropic — messages should have role and content array
      const firstMsg = result.messages[0];
      assert.ok(firstMsg.role === "user" || firstMsg.role === "assistant");
    });
  });

  it("outputs valid JSON for openai format", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], { format: "openai" }));
      const result = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(result.messages));
      assert.ok(result.messages.length > 0);
      // OpenAI format has string content, not array
      const userMsg = result.messages.find((m) => m.role === "user");
      assert.ok(userMsg);
      assert.equal(typeof userMsg.content, "string");
    });
  });

  it("--pretty flag produces indented JSON", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], { pretty: true }));
      // Pretty JSON should have newlines and indentation
      assert.ok(stdout.includes("\n  "), "expected indented JSON");
      // Should still be valid JSON
      const result = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(result.messages));
    });
  });

  it("non-pretty output is compact single-line JSON", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], {}));
      const lines = stdout.trim().split("\n");
      assert.equal(lines.length, 1, "compact JSON should be a single line");
    });
  });

  it("exports session with tool calls in anthropic format", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, claudeJsonlWithToolCalls("msg-tools"));
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], { format: "anthropic" }));
      const result = JSON.parse(stdout.trim());
      // user, assistant+tool_use, user(tool_result), assistant
      assert.ok(result.messages.length >= 3, `expected >= 3 messages, got ${result.messages.length}`);
      // There should be an assistant message with tool_use
      const assistants = result.messages.filter((m) => m.role === "assistant");
      assert.ok(assistants.length >= 1);
      const toolUseMsg = assistants.find(
        (m) => m.content.some((b) => b.type === "tool_use"),
      );
      assert.ok(toolUseMsg, "assistant should have a tool_use block");
      // tool_result should be in a user message
      const toolResultMsg = result.messages.find(
        (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
      );
      assert.ok(toolResultMsg, "should have a user message with tool_result");
      assert.equal(toolResultMsg.content[0].tool_use_id, "toolu_r1");
    });
  });

  it("exports session with tool calls in openai format", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, claudeJsonlWithToolCalls("msg-tools-oai"));
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], { format: "openai" }));
      const result = JSON.parse(stdout.trim());
      // user, assistant+tool_calls, tool, assistant
      assert.ok(result.messages.length >= 3, `expected >= 3 messages, got ${result.messages.length}`);
      // OpenAI format user messages have string content
      const userMsg = result.messages.find((m) => m.role === "user");
      assert.ok(userMsg);
      assert.equal(typeof userMsg.content, "string");
      // tool result should be a separate "tool" role message
      const toolMsg = result.messages.find((m) => m.role === "tool");
      assert.ok(toolMsg, "should have a tool role message for tool_result");
      assert.equal(toolMsg.tool_call_id, "toolu_r1");
    });
  });

  it("includes model and session_id in output when available", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl("session-id-test"));
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], {}));
      const result = JSON.parse(stdout.trim());
      // session_id should be present if the session has a sessionId
      if (result.session_id) {
        assert.equal(typeof result.session_id, "string");
      }
    });
  });

  it("showHelp via --help exits 0", () => {
    const { threw, code, logs } = captureExit(() => cmdMessages([], { help: true }));
    assert.equal(threw, true);
    assert.equal(code, 0);
    assert.ok(logs.some((l) => l.includes("tracequest")));
  });

  it("rejects a directory that is not a Grok session directory", () => {
    withTmpDir((dir) => {
      // dir exists but is not a Grok session (no chat_history.jsonl)
      assertDieStderr(
        captureExit(() => cmdMessages([dir], {})),
        /Not a session file/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// cmdFind / cmdSearch --limit hardening
// ---------------------------------------------------------------------------

describe("CLI --limit hardening", () => {
  it("cmdFind treats non-numeric --limit as default 20", async () => {
    await withTmpHome(async (home) => {
      seedClaudeProject(home, "-test-limit", [
        ["s1.jsonl", minimalClaudeJsonl("limit-1")],
      ]);
      // "abc" is not a valid number
      const { threw, code, logs } = captureExit(() => {
        cmdFind([], { filter: "source:claude", limit: "abc" });
      });
      // Should not crash — NaN is treated as default 20
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("Found")));
    });
  });

  it("cmdSearch treats non-numeric --limit as default 20", async () => {
    await withTmpHome(async (home) => {
      seedClaudeProject(home, "-test-limit-search", [
        ["s1.jsonl", claudeJsonlWithContent("limit-s1", { prompt: "unique-search-term-xz" })],
      ]);
      const { threw, code, logs } = captureExit(() => {
        cmdSearch(["unique-search-term-xz"], { limit: "not-a-number" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
    });
  });

  it("cmdFind treats negative --limit as default 20", async () => {
    await withTmpHome(async (home) => {
      seedClaudeProject(home, "-test-neg-limit", [
        ["s1.jsonl", minimalClaudeJsonl("neg-limit-1")],
      ]);
      const { threw, code, logs } = captureExit(() => {
        cmdFind([], { filter: "source:claude", limit: "-5" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("Found")));
    });
  });

  it("cmdFind without --filter treats non-numeric --limit as default 10", async () => {
    await withTmpHome(async (home) => {
      const files = [];
      for (let i = 0; i < 12; i++) {
        files.push([`s${i}.jsonl`, claudeJsonlWithMeta(`s${i}`), i * 10]);
      }
      seedClaudeProject(home, "-test-no-filter-limit", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = home;
        cmdFind([], { limit: "abc" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("12 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 10);
    });
  });

  it("cmdFind without --filter treats negative --limit as default 10", async () => {
    await withTmpHome(async (home) => {
      const files = [];
      for (let i = 0; i < 12; i++) {
        files.push([`s${i}.jsonl`, claudeJsonlWithMeta(`s${i}`), i * 10]);
      }
      seedClaudeProject(home, "-test-no-filter-neg-limit", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = home;
        cmdFind([], { limit: "-5" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("12 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 10);
    });
  });

  it("cmdList treats non-numeric --limit as default 20", async () => {
    await withTmpHome(async (home) => {
      seedClaudeProject(home, "-test-list-limit", [
        ["s1.jsonl", minimalClaudeJsonl("list-limit-1")],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = home;
        cmdList([], { limit: "abc" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("Found")));
    });
  });

  it("cmdLatest treats non-numeric --limit as default 1", async () => {
    await withTmpHome(async (home) => {
      seedClaudeProject(home, "-test-latest-limit", [
        ["s1.jsonl", minimalClaudeJsonl("latest-limit-1"), 0],
      ]);
      const out = join(home, "latest-limit.html");
      const { logs } = captureLogs(() => {
        process.env.HOME = home;
        cmdLatest([], { limit: "abc", out });
      });
      // Non-numeric limit falls back to 1, so renders the session normally
      assert.ok(existsSync(out));
      assert.ok(logs.some((l) => l.includes("Latest:")));
    });
  });
});

// ---------------------------------------------------------------------------
// cmdList --limit tests
// ---------------------------------------------------------------------------

describe("cmdList --limit", () => {
  it("--limit restricts number of displayed sessions", async () => {
    await withTmpHome(async (tmpDir) => {
      const files = [];
      for (let i = 0; i < 5; i++) {
        files.push([`s${i}.jsonl`, minimalClaudeJsonl(`s${i}`), i * 10]);
      }
      seedClaudeProject(tmpDir, "list-limit-proj", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { limit: "2" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Total count should show 5
      assert.ok(logs.some((l) => l.includes("5 sessions")));
      // Only 2 session lines shown
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 2);
      // Should show "... and 3 more"
      assert.ok(logs.some((l) => l.includes("3 more")));
    });
  });

  it("--limit larger than result count shows all", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "list-limit-big", [
        ["a.jsonl", minimalClaudeJsonl("a"), 10],
        ["b.jsonl", minimalClaudeJsonl("b"), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], { limit: "100" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("2 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 2);
      // Should NOT show "more" line
      assert.ok(!logs.some((l) => l.includes("more")));
    });
  });

  it("default limit is 20 when --limit omitted", async () => {
    await withTmpHome(async (tmpDir) => {
      const files = [];
      for (let i = 0; i < 25; i++) {
        files.push([`s${String(i).padStart(2, "0")}.jsonl`, minimalClaudeJsonl(`s${i}`), i * 10]);
      }
      seedClaudeProject(tmpDir, "list-default-limit", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdList([], {});
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("25 sessions")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 20);
      assert.ok(logs.some((l) => l.includes("5 more")));
    });
  });
});

// ---------------------------------------------------------------------------
// cmdMessages --out tests
// ---------------------------------------------------------------------------

describe("cmdMessages --out", () => {
  it("writes JSON to file when --out is specified", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      const outPath = join(dir, "output.json");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { errors } = captureStdoutWrite(() => cmdMessages([jsonl], { out: outPath }));
      // File should exist
      assert.ok(existsSync(outPath));
      // Should be valid JSON
      const result = JSON.parse(readFileSync(outPath, "utf8"));
      assert.ok(Array.isArray(result.messages));
      assert.ok(result.messages.length > 0);
      // stderr should have "Written:" confirmation
      assert.ok(errors.some((e) => e.includes("Written:")));
    });
  });

  it("writes pretty JSON to file with --out --pretty", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      const outPath = join(dir, "pretty.json");
      writeFileSync(jsonl, minimalClaudeJsonl());
      captureStdoutWrite(() => cmdMessages([jsonl], { out: outPath, pretty: true }));
      const content = readFileSync(outPath, "utf8");
      // Pretty JSON should have newlines and indentation
      assert.ok(content.includes("\n  "), "expected indented JSON in file");
      // Should be valid JSON
      const result = JSON.parse(content);
      assert.ok(Array.isArray(result.messages));
    });
  });

  it("does not write to stdout when --out is specified", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      const outPath = join(dir, "out.json");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], { out: outPath }));
      // stdout should be empty (no JSON written to stdout)
      assert.equal(stdout, "");
    });
  });

  it("dies when --out path is not writable", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const outPath = join(dir, "nonexistent-dir", "out.json");
      const captured = captureExit(() => cmdMessages([jsonl], { out: outPath }));
      assert.equal(captured.threw, true);
      assert.equal(captured.code, 1);
      // stderr has "Parsing session..." line and then the error line
      assert.ok(captured.errors.some((e) => e.includes("Failed to write output")));
    });
  });

  it("outputs to stdout when --out is not specified (existing behavior)", () => {
    withTmpDir((dir) => {
      const jsonl = join(dir, "session.jsonl");
      writeFileSync(jsonl, minimalClaudeJsonl());
      const { stdout } = captureStdoutWrite(() => cmdMessages([jsonl], {}));
      // stdout should have JSON content
      assert.ok(stdout.trim().length > 0);
      const result = JSON.parse(stdout.trim());
      assert.ok(Array.isArray(result.messages));
    });
  });
});

// ---------------------------------------------------------------------------
// cmdLatest --limit tests
// ---------------------------------------------------------------------------

describe("cmdLatest --limit", () => {
  it("--limit 1 (default) renders the session", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "lat-lim-1", [
        ["a.jsonl", minimalClaudeJsonl("a"), 10],
        ["b.jsonl", minimalClaudeJsonl("b"), 0],
      ]);
      const out = join(tmpDir, "latest-lim1.html");
      const { logs } = captureLogs(() => {
        process.env.HOME = tmpDir;
        cmdLatest([], { out });
      });
      assert.ok(existsSync(out));
      assert.ok(logs.some((l) => l.includes("Latest:")));
    });
  });

  it("--limit N>1 lists top N sessions instead of rendering", async () => {
    await withTmpHome(async (tmpDir) => {
      const files = [];
      for (let i = 0; i < 5; i++) {
        files.push([`s${i}.jsonl`, minimalClaudeJsonl(`s${i}`), i * 10]);
      }
      seedClaudeProject(tmpDir, "lat-lim-n", files);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdLatest([], { limit: "3" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      // Should show "Top 3 latest sessions" header
      assert.ok(logs.some((l) => l.includes("Top 3")));
      // 3 session lines shown
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 3);
      // Should show "... and 2 more"
      assert.ok(logs.some((l) => l.includes("2 more")));
    });
  });

  it("--limit N with --filter filters before limiting", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "lat-lim-expr", [
        ["s1.jsonl", claudeJsonlWithMeta("s1", { model: "claude-sonnet-4-20250514" }), 30],
        ["s2.jsonl", claudeJsonlWithMeta("s2", { model: "claude-sonnet-4-20250514" }), 20],
        ["s3.jsonl", claudeJsonlWithMeta("s3", { model: "claude-sonnet-4-20250514" }), 10],
        ["o1.jsonl", claudeJsonlWithMeta("o1", { model: "claude-opus-4-20250514" }), 0],
      ]);
      const { threw, code, logs } = captureExit(() => {
        process.env.HOME = tmpDir;
        cmdLatest([], { filter: "model:sonnet", limit: "2" });
      });
      assert.equal(threw, true);
      assert.equal(code, 0);
      assert.ok(logs.some((l) => l.includes("Top 2")));
      const sessionLines = logs.filter((l) => l.includes(".jsonl"));
      assert.equal(sessionLines.length, 2);
      // Should not contain opus
      assert.ok(!logs.some((l) => l.includes("o1.jsonl")));
    });
  });
});

const JSON_RECORD_KEYS = ["date", "source", "sessionHash", "sizeKB", "project", "path"];

describe("cmd find/list/search --json (machine-readable output, fact json-output)", () => {
  it("cmdFind --json writes a parseable JSON array with the required fields to stdout", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "jsonfind", [
        ["a.jsonl", minimalClaudeJsonl("ja"), 100],
        ["b.jsonl", minimalClaudeJsonl("jb"), 0],
      ]);
      const { code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdFind([], { json: true, limit: "5" });
      });
      assert.equal(code, 0);
      const records = JSON.parse(stdout); // must parse cleanly
      assert.ok(Array.isArray(records) && records.length >= 1);
      for (const key of JSON_RECORD_KEYS) {
        assert.ok(Object.prototype.hasOwnProperty.call(records[0], key), `record missing ${key}`);
      }
      assert.equal(typeof records[0].sizeKB, "number");
      // stdout is pure JSON: no status text, no ANSI
      assert.doesNotMatch(stdout, /Found \d+ sessions/);
      assert.doesNotMatch(stdout, /\x1b\[/);
    });
  });

  it("cmdList --json emits [] and status on stderr when nothing matches", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "jsonlist", [["a.jsonl", minimalClaudeJsonl("jl"), 0]]);
      const { code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdList([], { json: true, filter: "project:nomatchxyz" });
      });
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), []);
      assert.match(stderr, /No sessions match the filter expression/);
      assert.doesNotMatch(stdout, /No sessions/);
    });
  });

  it("cmdSearch --json includes matches with field classification; status on stderr", async () => {
    await withTmpHome(async (tmpDir) => {
      seedClaudeProject(tmpDir, "jsonsearch", [
        ["m.jsonl", claudeJsonlWithContent("js1", { prompt: "uniqueneedle handling in production" }), 0],
      ]);
      const { code, stdout, stderr } = captureExitWithStreams(() => {
        process.env.HOME = tmpDir;
        cmdSearch(["uniqueneedle"], { json: true, limit: "5" });
      });
      assert.equal(code, 0);
      const records = JSON.parse(stdout);
      assert.ok(Array.isArray(records) && records.length >= 1);
      for (const key of JSON_RECORD_KEYS) {
        assert.ok(Object.prototype.hasOwnProperty.call(records[0], key), `record missing ${key}`);
      }
      assert.ok(Array.isArray(records[0].matches));
      for (const m of records[0].matches) {
        assert.ok(["command", "file", "error", "text"].includes(m.field), `unexpected field ${m.field}`);
        assert.equal(typeof m.snippet, "string");
      }
      // Progress messages went to stderr, not stdout.
      assert.match(stderr, /Discovering sessions|Building index/);
      assert.doesNotMatch(stdout, /Discovering sessions|Building index/);
    });
  });
});
