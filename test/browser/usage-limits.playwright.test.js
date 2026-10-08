/**
 * Dashboard usage-limit meters in the shared app top bar.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const LOCAL_OK = {
  collectedAt: "2026-09-20T17:00:00.000Z",
  host: null,
  harnesses: [
    {
      id: "claude",
      status: "ok",
      plan: "default_claude_max_20x",
      windows: [
        { id: "five_hour", utilization: 0.25, resetsAt: "2099-01-01T00:00:00.000Z" },
        { id: "seven_day", utilization: 0.04, resetsAt: "2099-01-08T00:00:00.000Z" },
      ],
      limitingWindow: "five_hour",
    },
    {
      id: "codex",
      status: "unauthenticated",
      plan: null,
      windows: [],
      message: "unauthenticated — run `codex login`",
    },
    {
      id: "cursor",
      status: "ok",
      plan: "Pro",
      windows: [
        { id: "billing_cycle", utilization: 0.4, resetsAt: "2099-02-01T00:00:00.000Z" },
        { id: "on_demand", utilization: 1.2, resetsAt: "2099-02-01T00:00:00.000Z" },
      ],
      limitingWindow: "billing_cycle",
    },
    { id: "factory", status: "unavailable", plan: null, windows: [] },
  ],
};

const HOST_OK = {
  collectedAt: "2026-09-20T16:00:00.000Z",
  host: "gpu",
  harnesses: [
    { id: "grok", status: "ok", plan: "SuperGrokPro", windows: [] },
  ],
};

const EMPTY = {
  collectedAt: "2026-09-20T17:00:00.000Z",
  host: null,
  harnesses: [
    { id: "claude", status: "missing", plan: null, windows: [] },
    { id: "factory", status: "unavailable", plan: null, windows: [] },
  ],
};

function allocEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode }));
    }).on("error", reject);
  });
}

async function waitForHttp(port, reqPath, child, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`serve exited ${child.exitCode}`);
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === 200) return;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw lastErr ?? new Error(`timeout ${reqPath}`);
}

/**
 * Page SSR calls detectLiveSessions, which runs several `pgrep -f` scans.
 * On a busy host each scan reads every process cmdline and can block the
 * response past Playwright's navigation budget. These tests assert chips,
 * not live detection, so the serve process gets a pgrep that matches nothing.
 */
function installInstantPgrep(home) {
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = join(binDir, "pgrep");
  writeFileSync(stub, "#!/bin/sh\nexit 1\n");
  chmodSync(stub, 0o755);
  return binDir;
}

function spawnServe(port, home) {
  const pgrepDir = installInstantPgrep(home);
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      PATH: `${pgrepDir}:${process.env.PATH || ""}`,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_SKIP_LR_WATCH: "1",
    },
  });
  return child;
}

function seedHome() {
  const home = mkTmp("tq-ul-pw-");
  const proj = join(home, ".claude", "projects", "p");
  mkdirSync(proj, { recursive: true });
  writeJsonl(join(proj, "s.jsonl"), [
    { type: "user", message: { content: [{ type: "text", text: "hello" }] } },
  ]);
  return home;
}

describe("usage-limits playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("usage limits chips render with reset title", async () => {
    const { chromium } = PLAYWRIGHT;
    const home = seedHome();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    const browser = await chromium.launch({ headless: true });
    try {
      await waitForHttp(port, "/", child);
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.route("**/api/usage-limits", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ local: LOCAL_OK, hosts: [HOST_OK] }),
        });
      });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#appLimits:not([hidden]) .app-limit-chip");
      const chips = page.locator("#appLimits .app-limit-chip");
      assert.equal(await chips.count(), 4);
      assert.match(await chips.nth(0).textContent(), /claude/);
      assert.match(await chips.nth(0).textContent(), /25%/);
      const title = await chips.nth(0).getAttribute("title");
      assert.match(title, /five_hour/);
      assert.match(title, /reset/i);
      assert.match(await chips.nth(1).textContent(), /codex/);
      assert.match(await chips.nth(1).textContent(), /sign-in/);
      assert.equal(await chips.nth(1).evaluate((el) => el.classList.contains("is-unauth")), true);
      assert.match(await chips.nth(1).getAttribute("title"), /codex login/);
      assert.match(await chips.nth(2).textContent(), /cursor 40%/);
      assert.match(await chips.nth(3).textContent(), /grok@gpu/);

      await page.waitForSelector("#usageRow:not([hidden]) .usage-widget");
      const insideDashboard = await page.evaluate(() => !!document.getElementById("usageRow").closest("#dashboard"));
      assert.equal(insideDashboard, false);
      const widgets = page.locator("#usageRow .usage-widget");
      assert.equal(await widgets.count(), 4);
      const claudeWindows = page.locator('.usage-widget[data-harness="claude"] .usage-window');
      assert.equal(await claudeWindows.count(), 2);
      assert.match(await claudeWindows.nth(0).textContent(), /five hour/);
      assert.match(await claudeWindows.nth(0).textContent(), /25%/);
      assert.match(await claudeWindows.nth(0).textContent(), /used/);
      assert.match(await claudeWindows.nth(0).textContent(), /75%/);
      assert.match(await claudeWindows.nth(0).textContent(), /left/);
      assert.match(await claudeWindows.nth(0).textContent(), /resets in/i);
      assert.equal(await claudeWindows.nth(0).evaluate((el) => el.classList.contains("is-limiting")), true);
      assert.match(await claudeWindows.nth(1).textContent(), /seven day/);
      assert.match(await claudeWindows.nth(1).textContent(), /4%/);
      assert.match(await claudeWindows.nth(1).textContent(), /96%/);
      assert.equal(await claudeWindows.nth(1).evaluate((el) => el.classList.contains("is-limiting")), false);
      assert.match(await page.locator('.usage-widget[data-harness="claude"] .usage-widget-plan').textContent(), /default_claude_max_20x/);
      const codex = page.locator('.usage-widget[data-harness="codex"].is-unauth');
      assert.match(await codex.textContent(), /sign-in/);
      assert.match(await codex.locator(".usage-widget-hint").textContent(), /codex login/);
      const cursorWindows = page.locator('.usage-widget[data-harness="cursor"] .usage-window');
      assert.match(await cursorWindows.nth(0).textContent(), /billing cycle/);
      assert.match(await cursorWindows.nth(0).textContent(), /40%/);
      assert.match(await cursorWindows.nth(0).textContent(), /60%/);
      assert.match(await cursorWindows.nth(1).textContent(), /on demand/);
      assert.match(await cursorWindows.nth(1).textContent(), /120%/);
      assert.match(await cursorWindows.nth(1).textContent(), /0%/);
      const grok = page.locator('.usage-widget[data-harness="grok"][data-host="gpu"]');
      assert.match(await grok.textContent(), /SuperGrokPro/);
      assert.equal(await grok.locator(".usage-window").count(), 0);
      assert.match(await grok.getAttribute("title"), /imported gpu/);
      assert.equal(await page.locator('.usage-widget[data-harness="factory"]').count(), 0);
    } finally {
      await browser.close();
      if (child.exitCode == null) child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("appLimits hidden when empty and no overflow at mobile viewport", async () => {
    const { chromium } = PLAYWRIGHT;
    const home = seedHome();
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    const browser = await chromium.launch({ headless: true });
    try {
      await waitForHttp(port, "/", child);
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.route("**/api/usage-limits", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ local: EMPTY, hosts: [] }),
        });
      });
      await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#appLimits", { state: "attached" });
      assert.equal(await page.locator("#appLimits").isHidden(), true);
      await page.waitForSelector("#usageRow", { state: "attached" });
      assert.equal(await page.locator("#usageRow").isHidden(), true);

      await page.unroute("**/api/usage-limits");
      await page.route("**/api/usage-limits", (route) => {
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ local: LOCAL_OK, hosts: [{ ...LOCAL_OK, host: "gpu" }] }),
        });
      });
      await page.evaluate(async () => {
        const res = await fetch("/api/usage-limits");
        const data = await res.json();
        window.paintUsageLimits(data);
      });
      await page.waitForSelector("#appLimits:not([hidden]) .app-limit-chip");
      const overflow = await page.evaluate(() => {
        const el = document.getElementById("appLimits");
        const box = el.getBoundingClientRect();
        return {
          chipRight: box.right,
          chipLeft: box.left,
          vw: window.innerWidth,
          clip: el.scrollWidth - el.clientWidth,
        };
      });
      assert.ok(overflow.chipLeft >= 0, "chips start on-screen");
      assert.ok(overflow.chipRight <= overflow.vw + 1, "chips stay inside the viewport");
      assert.ok(overflow.clip >= 0, "chip row clips rather than expanding the page");
      await page.waitForSelector("#usageRow:not([hidden]) .usage-widget");
      const rowBox = await page.locator("#usageRow").boundingBox();
      assert.ok(rowBox, "home usage row is visible");
      assert.ok(rowBox.x >= -1, "usage row starts on-screen");
      assert.ok(rowBox.x + rowBox.width <= overflow.vw + 1, "usage row stays inside the viewport");
    } finally {
      await browser.close();
      if (child.exitCode == null) child.kill("SIGKILL");
      rmSync(home, { recursive: true, force: true });
    }
  });
});
