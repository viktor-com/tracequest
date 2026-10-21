/**
 * Plan limits: a harness whose usage collect failed (status error, e.g. the
 * Codex usage API answering HTTP 403) stays visible in the browser, both for
 * the local collect and for an imported host's snapshot.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function allocEphemeralPort() {
  const server = createServer();
  const port = await listen(server);
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, child, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`serve exited early (${child.exitCode})\nstdout: ${child._stdout}\nstderr: ${child._stderr}`);
    }
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === 200) return;
      lastErr = new Error(`HTTP ${res.status} for ${reqPath}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastErr ?? new Error(`timed out waiting for ${reqPath}`);
}

function spawnServe(port, home, usageUrl) {
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_LIVE_SESSIONS_HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_SKIP_LR_WATCH: "1",
      TRACEQUEST_USAGE_LIMITS: "1",
      TRACEQUEST_CLAUDE_USAGE_URL: usageUrl,
      TRACEQUEST_CODEX_USAGE_URL: usageUrl,
      TRACEQUEST_GROK_USAGE_URL: usageUrl,
      TRACEQUEST_CURSOR_API2_URL: usageUrl,
    },
  });
  child._stdout = "";
  child._stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { child._stdout += chunk; });
  child.stderr.on("data", (chunk) => { child._stderr += chunk; });
  return child;
}

async function stopServe(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A HOME signed in to Codex only, plus an imported host whose Codex collect failed. */
function seedHome() {
  const home = mkTmp("tracequest-usage-limits-error-");
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "codex-fixture-access", account_id: "acct-fixture" } }),
  );
  const snapDir = join(home, ".local", "share", "tracequest", "hosts", "gpu", ".tracequest");
  mkdirSync(snapDir, { recursive: true });
  writeFileSync(
    join(snapDir, "usage-limits.json"),
    JSON.stringify({
      collectedAt: "2026-10-15T13:24:49.521Z",
      host: "gpu",
      harnesses: [
        {
          id: "claude",
          status: "ok",
          plan: "default_claude_max_5x",
          windows: [{ id: "five_hour", utilization: 0.16, resetsAt: null }],
          limitingWindow: "five_hour",
        },
        { id: "codex", status: "error", plan: null, windows: [], message: "HTTP 403" },
        { id: "cursor", status: "missing", plan: null, windows: [], message: "no credential" },
        { id: "factory", status: "unavailable", plan: null, windows: [], message: "no remaining-window collector" },
      ],
    }),
  );
  return home;
}

describe("usage-limits error playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("plan limits keep a harness whose usage collection error was recorded", async () => {
    const { chromium } = PLAYWRIGHT;
    const forbidden = createServer((_req, res) => {
      res.writeHead(403, { "content-type": "application/json" });
      res.end('{"detail":"forbidden"}');
    });
    const usagePort = await listen(forbidden);
    const home = seedHome();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home, `http://127.0.0.1:${usagePort}/usage`);
    const browser = await chromium.launch();
    try {
      await waitForHttp(port, "/sessions", child);
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.locator("#appLimitsBtn").click();
      const panel = page.locator("#usageRow");
      await panel.waitFor({ state: "visible" });

      const local = panel.locator('.usage-widget[data-harness="codex"]:not([data-host])');
      const imported = panel.locator('.usage-widget[data-harness="codex"][data-host="gpu"]');
      assert.equal(await local.count(), 1, "local Codex error has a widget");
      assert.equal(await imported.count(), 1, "imported Codex error has a widget");
      for (const widget of [local, imported]) {
        assert.equal(await widget.isVisible(), true);
        assert.equal((await widget.locator(".usage-widget-plan").textContent()).trim(), "error");
        assert.equal((await widget.locator(".usage-widget-hint").textContent()).trim(), "HTTP 403");
      }
      assert.equal(
        await panel.locator('.usage-widget[data-harness="claude"][data-host="gpu"]').count(),
        1,
        "ok harnesses stay visible next to the error",
      );
      for (const hidden of ["cursor", "factory"]) {
        assert.equal(await panel.locator(`.usage-widget[data-harness="${hidden}"]`).count(), 0, `${hidden} stays hidden`);
      }

      const chips = await page.locator("#appLimits .app-limit-chip").allTextContents();
      assert.ok(chips.includes("codex error"), `local error chip in ${JSON.stringify(chips)}`);
      assert.ok(chips.includes("codex@gpu error"), `imported error chip in ${JSON.stringify(chips)}`);
      assert.equal(await page.locator("#appLimits .app-limit-chip.is-error").count(), 2);

      // A collector can become available after a page first renders with no limits.
      await page.evaluate(() => window.paintUsageLimits({ local: { harnesses: [] }, hosts: [] }));
      assert.equal(await page.locator("#appLimitsBtn").isVisible(), false);
      await page.evaluate(() => window.paintUsageLimits({
        local: { harnesses: [{ id: "codex", status: "ok", plan: "plus",
          windows: [{ id: "five_hour", utilization: 0.25, resetsAt: null }],
          limitingWindow: "five_hour" }] }, hosts: [],
      }));
      assert.equal(await page.locator("#appLimitsBtn").isVisible(), true);
      await page.keyboard.press("Escape");
      await page.locator("#appLimitsBtn").click();
      assert.equal(await panel.isVisible(), true);
      assert.equal(await panel.locator('.usage-widget[data-harness="codex"]').count(), 1);
      assert.match(await panel.textContent(), /25%/);
    } finally {
      await browser.close();
      await stopServe(child);
      await new Promise((resolve) => forbidden.close(resolve));
      rmSync(home, { recursive: true, force: true });
    }
  });
});
