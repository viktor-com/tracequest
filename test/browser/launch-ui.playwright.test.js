/**
 * /launch page browser coverage: real tracequest serve + headless Chromium
 * + a PRIVATE tmux server (TRACEQUEST_TMUX_SOCKET) + a stub `claude` agent
 * on the serve child's stripped PATH. Runs only under `npm run test:browser`
 * (TRACEQUEST_SKIP_PLAYWRIGHT=1 keeps it out of npm test).
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { SKIP_NO_TMUX, TMUX } from "../helpers/tmux-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const SOCKET = `tq-test-launchui-${process.pid}`;
const SESSION = `tq-launchui-${process.pid}`;

/** Playwright AND tmux must both be present (tmux-independent tests gate on playwright only). */
const SKIP_NO_BOTH = SKIP_NO_PLAYWRIGHT.skip ? SKIP_NO_PLAYWRIGHT : SKIP_NO_TMUX;

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];
/** @type {string[]} */
const pendingDirs = [];

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

/** Kill every tq-run window so scenarios stay independent. */
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
}

/**
 * Stub agent standing in for the real `claude` CLI (see launch integration
 * test). It echoes its FULL argv — positional prompts arrive as
 * `-- <prompt>` ($1 is the end-of-options "--", $2 the prompt).
 */
function mkStubAgentDir() {
  const dir = mkDir("tq-launchui-stub-");
  const script = join(dir, "claude");
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      'echo "tq-stub:$@"',
      // The launcher spawns `claude --session-id <uuid> [-- <prompt>]`, so
      // the prompt is the argv element BEHIND "--", not a fixed position.
      'PROMPT=""; prev=""',
      'for arg in "$@"; do',
      '  case "$prev" in --) PROMPT="$arg";; esac',
      '  prev="$arg"',
      "done",
      'if [ "$PROMPT" = "exit-fast" ]; then exit 0; fi',
      "sleep 30",
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
  return dir;
}

/**
 * Serve child's PATH: stub dir + bare system dirs only, so detection sees
 * exactly one agent (the stub `claude`). node and tmux are pinned by
 * absolute path because the stripped PATH would not resolve them.
 */
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

async function bootServeWithStub() {
  const home = mkDir("tq-launchui-home-");
  const stubDir = mkStubAgentDir();
  const workDir = mkDir("tq-launchui-cwd-");
  const port = await allocEphemeralPort();
  spawnServe(port, home, stubEnv(stubDir));
  await waitForHttp(port, "/api/agents");
  return { home, workDir, port };
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

describe("integrated launch UI in a served browser", () => {
  test("New run modal starts a run that lands on the chat and appears as ONE run row in the session list", SKIP_NO_BOTH, async () => {
    const { workDir, port } = await bootServeWithStub();
    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });

      // Launcher opens from the dashboard header — no page change.
      await page.click("#newRunBtn");
      await page.locator("#launchForm").waitFor({ state: "visible" });
      await page.locator('#agentSelect option[value="claude"]').waitFor({ state: "attached" });
      assert.deepEqual(
        await page.locator("#agentSelect option").allTextContents(),
        ["claude"],
        "dropdown lists only the detected stub agent",
      );

      await page.fill("#cwdInput", workDir);
      await page.fill("#promptInput", "stay-alive");
      await page.click("#startBtn");

      // Starting a run IS opening its chat.
      await page.waitForURL(/\/run\?id=%40\d+/, { timeout: 15_000 });
      await page.locator('#runStatus[data-status="running"]').waitFor({ timeout: 15_000 });
      assert.equal(await page.locator(".chat-identity .session-source").textContent(), "claude");

      // Back on the dashboard the run is ONE first-class row in the main
      // session list — live state, prompt, and activity line on the row.
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "load" });
      const row = page.locator("#sessions .session-row.run-row", { hasText: "claude" }).first();
      await row.waitFor({ timeout: 15_000 });
      await row.locator('.run-state-badge[data-status="running"]').waitFor({ timeout: 15_000 });
      const rowText = await row.textContent();
      assert.ok(
        rowText.includes(workDir.split("/").filter(Boolean).pop()),
        "row shows the run cwd basename",
      );
      assert.ok(rowText.includes("stay-alive"), "row carries the launch prompt");
      await row.locator(".run-activity").waitFor({ timeout: 15_000 });
      const href = await row.getAttribute("data-href");
      assert.match(href, /^\/run\?id=%40\d+$/, "row targets /run?id=<window id>");
      assert.equal(
        await page.locator("#liveBar .live-run-row, .run-chat-badge").count(),
        0,
        "the run exists nowhere else — no strip row, no chat badge",
      );

      // One click from the row back into the chat.
      await row.click();
      await page.waitForURL(/\/run\?id=%40\d+/, { timeout: 15_000 });
      await page.locator("#chatThread").waitFor({ state: "attached" });
    });
  });

  test("run row kill control dismisses the run from the session list", SKIP_NO_BOTH, async () => {
    const { workDir, port } = await bootServeWithStub();
    const created = await httpPost(port, "/api/runs", {
      agent: "claude",
      cwd: workDir,
      prompt: "stay-alive",
    });
    assert.equal(created.status, 200, `run create failed: ${created.body}`);
    const { id } = JSON.parse(created.body);

    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "load" });
      const row = page.locator(`#sessions .run-row[data-run-id="${id}"]`);
      await row.waitFor({ timeout: 15_000 });

      await row.locator(".run-dismiss").click();
      await row.waitFor({ state: "detached", timeout: 15_000 });
    });

    const windowIds = String(
      rawTmux(["list-windows", "-t", `=${SESSION}`, "-F", "#{window_id}"]).stdout || "",
    )
      .split("\n")
      .filter(Boolean);
    assert.ok(!windowIds.includes(id), "killed run's tmux window is gone");
  });

  test("missing multiplexer renders the no-mux state inside the launcher modal", SKIP_NO_PLAYWRIGHT, async () => {
    const home = mkDir("tq-launchui-nomux-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, {
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_TMUX_SOCKET: SOCKET,
      TRACEQUEST_TMUX_SESSION: SESSION,
    });
    await waitForHttp(port, "/api/agents");

    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
      await page.click("#newRunBtn");
      const nomux = page.locator('[data-launch-state="no-mux"]');
      await nomux.waitFor({ state: "visible" });
      assert.match(await nomux.textContent(), /tmux/, "state names tmux");
      await page.locator("#launchForm").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#startBtn:visible").count(), 0, "no launchable form");
    });
  });

  test("/launch redirects into the dashboard launcher", SKIP_NO_PLAYWRIGHT, async () => {
    const home = mkDir("tq-launchui-redirect-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, {
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_TMUX_SOCKET: SOCKET,
      TRACEQUEST_TMUX_SESSION: SESSION,
    });
    await waitForHttp(port, "/api/agents");

    await withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${port}/launch`, { waitUntil: "load" });
      // Old links land on the dashboard with the launcher auto-opened.
      assert.match(page.url(), /\/\?launch=1$/, "302 target is /?launch=1");
      await page.locator("#launchOverlay").waitFor({ state: "visible" });
      await page.locator("#newRunBtn").waitFor({ state: "attached" });
    });
  });
});
