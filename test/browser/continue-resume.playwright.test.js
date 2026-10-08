/**
 * Continue-resume browser coverage: real tracequest serve + headless
 * Chromium + a PRIVATE tmux server + a stub `claude` modeling the real
 * CLI's documented fork-resume semantics (--resume <src> --fork-session
 * --session-id <new> [-- <prompt>] → a NEW recording that BEGINS with the
 * source conversation, then appends the DELIVERED prompt as the next user
 * turn plus a reply — exactly the prompt-carrying resume the argv
 * plumbing produces).
 *
 * Flow under test (facts ikw + type-to-continue): typing IS the continue.
 * An EXITED run's chat keeps a live composer in continue mode — type a
 * follow-up, submit, land in the NEW run's chat with the follow-up already
 * delivered (prior context + the typed message in the transcript, plus the
 * "continued from <hash>" provenance header). The dashboard row's Continue
 * control opens an inline composer with the same one-action flow, and the
 * read-only external-session chat (/run?session=) carries a continue
 * composer under its observer card — including inline vanished-cwd
 * recovery when the recorded directory no longer exists. Runs only under
 * `npm run test:browser` (TRACEQUEST_SKIP_PLAYWRIGHT=1 keeps it out of
 * npm test).
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { SKIP_NO_TMUX, TMUX } from "../helpers/tmux-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const SOCKET = `tq-test-continue-${process.pid}`;
const SESSION = `tq-continue-${process.pid}`;

/** Playwright AND tmux must both be present. */
const SKIP_NO_BOTH = SKIP_NO_PLAYWRIGHT.skip ? SKIP_NO_PLAYWRIGHT : SKIP_NO_TMUX;

const ORIG_ID = "dddddddd-1111-4222-8333-444455556666";

/**
 * Fork-resume stub `claude` modeling the real CLI's argv contract:
 * `--session-id <sid>` names the recording, `--resume <src> --fork-session`
 * copies the source conversation, and the positional prompt (after the `--`
 * end-of-options marker) is DELIVERED — appended as the fork's next user
 * turn. A create-mode invocation (no --resume) records its prompt plus a
 * first answer and exits fast, producing an EXITED run with a linked
 * recording. The source recording is echoed into the transcript so the
 * "prior context carries over" assertion is real, not cosmetic.
 */
function resumeStubScript(home) {
  return [
    "#!/bin/sh",
    'echo "tq-stub:$@"',
    'SID=""; RESUME=""; PROMPT=""; prev=""',
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
    'f="$dir/$SID.jsonl"',
    'if [ -n "$RESUME" ]; then',
    '  src=$(ls -1 ' + `${home}/.claude/projects` + '/*/"$RESUME".jsonl 2>/dev/null | head -1)',
    '  sed "s/$RESUME/$SID/g" "$src" > "$f"',
    "  sleep 0.4",
    '  [ -n "$PROMPT" ] || PROMPT="CONTINUED-FOLLOW-UP"',
    '  cat >> "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-11T11:00:00.000Z","uuid":"u-resume","isMeta":false,"message":{"content":[{"type":"text","text":"$PROMPT"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T11:00:05.000Z","uuid":"a-resume","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"RESUMED-REPLY: picking up where we left off"}],"usage":{"input_tokens":5,"output_tokens":9}}}',
    "EOF",
    "  sleep 30",
    "else",
    '  [ -n "$PROMPT" ] || PROMPT="untitled run"',
    '  cat > "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-11T10:00:00.000Z","uuid":"u-first","isMeta":false,"message":{"content":[{"type":"text","text":"$PROMPT"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T10:00:04.000Z","uuid":"a-first","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"FIRST-ANSWER: retry helper added"}],"usage":{"input_tokens":3,"output_tokens":4}}}',
    "EOF",
    "  sleep 1",
    "fi",
    "",
  ].join("\n");
}

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];
/** @type {string[]} */
const pendingDirs = [];

function mkDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  pendingDirs.push(dir);
  return dir;
}

function rawTmux(args) {
  return spawnSync(TMUX.bin, ["-L", SOCKET, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function killRunWindows() {
  const out = rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}\t#{@tq_agent}"]);
  for (const line of String(out.stdout || "").split("\n")) {
    const [id, agent] = line.split("\t");
    if (id && agent) rawTmux(["kill-window", "-t", id]);
  }
}

function stubEnv(stubDir) {
  const whichTmux = spawnSync("which", [TMUX.bin], { encoding: "utf8" });
  const tmuxBin = TMUX.bin.startsWith("/")
    ? TMUX.bin
    : String(whichTmux.stdout || "").trim() || TMUX.bin;
  return {
    TRACEQUEST_TMUX_SOCKET: SOCKET,
    TRACEQUEST_TMUX_SESSION: SESSION,
    TRACEQUEST_TMUX_BIN: tmuxBin,
    PATH: `${stubDir}:/usr/bin:/bin`,
  };
}

function spawnServe(port, home, extraEnv) {
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
  serveChildren.push(child);
  return child;
}

async function stopServe(child) {
  if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  await new Promise((resolve) => {
    if (child.exitCode != null) return resolve();
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

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
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      })
      .on("error", reject);
  });
}

function httpPost(port, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitForHttp(port, reqPath, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === 200) return res;
      lastErr = new Error(`HTTP ${res.status} for ${reqPath}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastErr ?? new Error(`timed out waiting for ${reqPath}`);
}

/**
 * Boot serve with the resume stub + a planted EXTERNAL session.
 * `vanishedCwd: true` deletes the session's recorded working directory
 * after planting — the vanished-cwd recovery scenario.
 */
async function bootWithExternalSession({ vanishedCwd = false } = {}) {
  const home = mkDir("tq-continue-pw-home-");
  const stubDir = mkDir("tq-continue-pw-stub-");
  const stubPath = join(stubDir, "claude");
  writeFileSync(stubPath, resumeStubScript(home));
  chmodSync(stubPath, 0o755);
  const workDir = mkDir("tq-continue-pw-cwd-");
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
  if (vanishedCwd) rmSync(workDir, { recursive: true, force: true });
  const port = await allocEphemeralPort();
  spawnServe(port, home, stubEnv(stubDir));
  await waitForHttp(port, "/api/agents");
  return { port, srcPath, srcHash: sessionHash(srcPath) };
}

/** Boot serve with only the resume stub — for launched-run scenarios. */
async function bootBare() {
  const home = mkDir("tq-continue-pw-home-");
  const stubDir = mkDir("tq-continue-pw-stub-");
  const stubPath = join(stubDir, "claude");
  writeFileSync(stubPath, resumeStubScript(home));
  chmodSync(stubPath, 0o755);
  const workDir = realpathSync(mkDir("tq-continue-pw-cwd-"));
  const port = await allocEphemeralPort();
  spawnServe(port, home, stubEnv(stubDir));
  await waitForHttp(port, "/api/agents");
  return { port, workDir };
}

/** Poll /api/runs until run `id` is exited WITH a linked recording. */
async function waitForExitedLinkedRun(port, id, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await httpGet(port, "/api/runs");
    if (res.status === 200) {
      const runs = JSON.parse(res.body).runs || [];
      last = runs.find((r) => r.id === id) || null;
      if (last && last.status === "exited" && last.sessionPath) return last;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`run ${id} never reached exited+linked: ${JSON.stringify(last)}`);
}

async function withPage(fn) {
  const { chromium } = PLAYWRIGHT;
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await fn(page);
  } finally {
    await browser.close();
  }
}

afterEach(async () => {
  while (serveChildren.length) {
    await stopServe(serveChildren.pop());
  }
  if (TMUX) killRunWindows();
  await new Promise((r) => setTimeout(r, 100));
  while (pendingDirs.length) {
    const dir = pendingDirs.pop();
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // best-effort
    }
  }
});

after(() => {
  if (TMUX) {
    try {
      spawnSync(TMUX.bin, ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("continue-resume in a served browser", () => {
  test("EXITED run chat: typing into the live continue composer IS the continue — lands with the follow-up delivered", SKIP_NO_BOTH, async () => {
    const { port, workDir } = await bootBare();
    // A real run that records its conversation and exits fast.
    const created = await httpPost(port, "/api/runs", {
      agent: "claude",
      cwd: workDir,
      prompt: "FIRST-QUESTION add a retry helper",
    });
    assert.equal(created.status, 200, created.body);
    const firstId = JSON.parse(created.body).id;
    const run = await waitForExitedLinkedRun(port, firstId);
    const srcHash = sessionHash(run.sessionPath);
    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/run?id=${encodeURIComponent(firstId)}`, { waitUntil: "load" });
      // The finished thread keeps a LIVE composer, re-armed into continue
      // mode — no bare Continue button anywhere.
      const composer = page.locator('#inputRow[data-mode="continue"]');
      await composer.waitFor({ timeout: 15_000 });
      assert.ok(await page.locator("#ctxContinueChip").isVisible(), "fork-semantics chip visible");
      assert.match(
        await page.locator("#inputText").getAttribute("placeholder"),
        /continues in a new run/,
        "placeholder says what typing does",
      );
      assert.equal(await page.locator("#continueBtn").count(), 0, "the bare Continue button is gone");
      assert.match(await page.locator("#statusText").textContent(), /follow-ups continue in a new run/);
      // Typing IS the continue: one action from thought to running follow-up.
      await page.fill("#inputText", "SECOND-FOLLOW-UP now add exponential backoff");
      const beforeUrl = page.url();
      await Promise.all([
        page.waitForURL((u) => /\/run\?id=/.test(String(u)) && String(u) !== beforeUrl, { timeout: 15_000 }),
        page.press("#inputText", "Enter"),
      ]);
      // Honest interim: the follow-up is visible on the landing page (as
      // the pending bubble until the fork recording links, then for real).
      await page.waitForFunction(
        () => document.body.textContent.includes("SECOND-FOLLOW-UP now add exponential backoff"),
        null,
        { timeout: 10_000 },
      );
      // Provenance header links back to the source recording.
      const prov = page.locator("#continuedFrom");
      await prov.waitFor({ timeout: 15_000 });
      assert.match(await prov.textContent(), new RegExp(`continued from ${srcHash}`));
      // The transcript eventually carries prior context AND the delivered
      // follow-up, then the resumed reply.
      await page.waitForFunction(
        () => {
          const t = document.getElementById("chatThread").textContent;
          return t.includes("FIRST-QUESTION add a retry helper") &&
            t.includes("SECOND-FOLLOW-UP now add exponential backoff") &&
            t.includes("RESUMED-REPLY");
        },
        null,
        { timeout: 20_000 },
      );
      const thread = await page.locator("#chatThread").textContent();
      assert.match(thread, /FIRST-ANSWER/, "prior assistant turn carried into the fork");
      assert.equal(await page.locator("#pendingFollowup").count(), 0, "pending bubble retires once the transcript carries the message");
    });
  });

  test("dashboard session row: Continue opens an inline composer — type, submit, land with the follow-up delivered", SKIP_NO_BOTH, async () => {
    const { port, srcHash } = await bootWithExternalSession();
    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "load" });
      // The Continue control appears on the external session's row once
      // /api/agents reports claude detected + resume-capable.
      const cont = page.locator(".session-continue").first();
      await cont.waitFor({ timeout: 15_000 });
      assert.match(await cont.getAttribute("title"), /type your follow-up right here/);
      await cont.click();
      // The inline composer opens IN the row.
      const input = page.locator(".session-continue-input");
      await input.waitFor({ timeout: 5_000 });
      await input.fill("ROW-FOLLOW-UP from the dashboard");
      await Promise.all([
        page.waitForURL(/\/run\?id=/, { timeout: 15_000 }),
        input.press("Enter"),
      ]);
      // Landed in the NEW run's chat: provenance + prior context + the
      // typed follow-up, all without retyping anything.
      const prov = page.locator("#continuedFrom");
      await prov.waitFor({ timeout: 15_000 });
      assert.match(await prov.textContent(), new RegExp(`continued from ${srcHash}`));
      assert.equal(await prov.getAttribute("href"), `/view?id=${srcHash}`);
      await page.waitForFunction(
        () => {
          const t = document.getElementById("chatThread").textContent;
          return t.includes("EXTERNAL-PRIOR-QUESTION") && t.includes("ROW-FOLLOW-UP from the dashboard");
        },
        null,
        { timeout: 20_000 },
      );
      const thread = await page.locator("#chatThread").textContent();
      assert.match(thread, /EXTERNAL-PRIOR-ANSWER/, "prior assistant turn carried into the fork");
      await page.waitForFunction(
        () => document.getElementById("chatThread").textContent.includes("RESUMED-REPLY"),
        null,
        { timeout: 15_000 },
      );
      // Full steering on the resumed run while it lives.
      assert.ok(await page.locator("#inputText").isVisible(), "composer available on the resumed run");
    });
  });

  test("external-session chat (/run?session=): the observer continue composer carries the follow-up", SKIP_NO_BOTH, async () => {
    const { port, srcHash } = await bootWithExternalSession();
    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/run?session=${srcHash}`, { waitUntil: "load" });
      const form = page.locator("#continueForm");
      await form.waitFor({ timeout: 15_000 });
      assert.equal(await form.getAttribute("data-mode"), "continue");
      await page.fill("#continueInput", "OBSERVER-FOLLOW-UP taken over from the chat");
      await Promise.all([
        page.waitForURL(/\/run\?id=/, { timeout: 15_000 }),
        page.press("#continueInput", "Enter"),
      ]);
      const prov = page.locator("#continuedFrom");
      await prov.waitFor({ timeout: 15_000 });
      assert.match(await prov.textContent(), new RegExp(`continued from ${srcHash}`));
      await page.waitForFunction(
        () => {
          const t = document.getElementById("chatThread").textContent;
          return t.includes("EXTERNAL-PRIOR-QUESTION") && t.includes("OBSERVER-FOLLOW-UP taken over from the chat");
        },
        null,
        { timeout: 20_000 },
      );
    });
  });

  test("vanished-cwd recovery: the observer composer asks for a directory inline and the retry lands", SKIP_NO_BOTH, async () => {
    const { port, srcHash } = await bootWithExternalSession({ vanishedCwd: true });
    const retryCwd = realpathSync(mkDir("tq-continue-pw-retry-"));
    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/run?session=${srcHash}`, { waitUntil: "load" });
      await page.locator("#continueForm").waitFor({ timeout: 15_000 });
      await page.fill("#continueInput", "RECOVERED-FOLLOW-UP after the directory moved");
      await page.press("#continueInput", "Enter");
      // The 400 needs:"cwd" answer surfaces as an inline directory prompt
      // — the typed follow-up stays put.
      const cwdInput = page.locator("#continueCwdInput");
      await cwdInput.waitFor({ state: "visible", timeout: 10_000 });
      assert.match(await page.locator("#continueError").textContent(), /cwd/);
      assert.equal(
        await page.locator("#continueInput").inputValue(),
        "RECOVERED-FOLLOW-UP after the directory moved",
        "follow-up survives the recovery detour",
      );
      await cwdInput.fill(retryCwd);
      await Promise.all([
        page.waitForURL(/\/run\?id=/, { timeout: 15_000 }),
        page.press("#continueCwdInput", "Enter"),
      ]);
      await page.waitForFunction(
        () => {
          const t = document.getElementById("chatThread").textContent;
          return t.includes("EXTERNAL-PRIOR-QUESTION") && t.includes("RECOVERED-FOLLOW-UP after the directory moved");
        },
        null,
        { timeout: 20_000 },
      );
    });
  });
});
