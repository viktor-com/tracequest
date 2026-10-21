#!/usr/bin/env node
/**
 * Record a short webm of the Chat plan-limits popover (plan window, used
 * versus remaining, reset, sign-in hint, imported host) plus the /run
 * top-bar chips. Writes docs/ui-examples/usage-limits.webm and a poster
 * PNG. Fixture-backed /api/usage-limits; no real network.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import http from "node:http";
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { MARK_SVG, WORDMARK_SVG } from "../src/ui/brand.js";
import { writeJsonl } from "../test/helpers/fixtures.js";

async function assertBrand(page) {
  for (const [selector, svg] of [[".app-mark", MARK_SVG], [".app-logotype", WORDMARK_SVG]]) {
    const logo = page.locator(selector).first();
    await logo.waitFor({ state: "visible" });
    assert.deepEqual(await logo.evaluate((el) => Array.from(el.querySelectorAll("path"), (p) => p.getAttribute("d"))),
      Array.from(svg.matchAll(/<path[^>]* d="([^"]*)"/g), (m) => m[1]), `${selector} must use canonical brand paths`);
    const bounds = await logo.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0 &&
      bounds.x + bounds.width <= page.viewportSize().width && bounds.y + bounds.height <= page.viewportSize().height,
      `${selector} must be visible in the capture`);
  }
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin/tracequest.js");
const OUT_DIR = join(ROOT, "docs", "ui-examples");
const VIDEO_OUT = join(OUT_DIR, "usage-limits.webm");
const POSTER_OUT = join(OUT_DIR, "usage-limits.png");

const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();

const LOCAL = {
  collectedAt: new Date().toISOString(),
  host: null,
  harnesses: [
    {
      id: "claude",
      status: "ok",
      plan: "default_claude_max_20x",
      windows: [
        { id: "five_hour", utilization: 0.25, resetsAt: inHours(3) },
        { id: "seven_day", utilization: 0.04, resetsAt: inHours(24 * 6) },
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
        { id: "billing_cycle", utilization: 0.4, resetsAt: inHours(24 * 12) },
      ],
      limitingWindow: "billing_cycle",
    },
    { id: "grok", status: "missing", plan: null, windows: [] },
    { id: "factory", status: "unavailable", plan: null, windows: [] },
  ],
};

const HOST = {
  collectedAt: "2026-09-20T16:42:00.000Z",
  host: "gpu",
  harnesses: [
    { id: "grok", status: "ok", plan: "SuperGrokPro", windows: [] },
    { id: "factory", status: "unavailable", plan: null, windows: [] },
  ],
};

function allocPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

async function waitForHttp(port, path, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`serve exited ${child.exitCode}`);
    try {
      if ((await httpGet(port, path)) === 200) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`timeout waiting for ${path}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const home = mkdtempSync(join(tmpdir(), "tq-ul-record-"));
const videoDir = mkdtempSync(join(tmpdir(), "tq-ul-video-"));
mkdirSync(join(home, ".claude", "projects", "demo"), { recursive: true });
writeJsonl(join(home, ".claude", "projects", "demo", "sess.jsonl"), [
  { type: "user", message: { content: [{ type: "text", text: "Add a currency selector to the cart" }] } },
]);

const port = await allocPort();
const child = spawn(process.execPath, [BIN, "serve", "--usage-limits", "--port", String(port)], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_TMUX: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
    TRACEQUEST_SKIP_LR_WATCH: "1",
  },
});

const browser = await chromium.launch({ headless: true });
try {
  await waitForHttp(port, "/", child);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/usage-limits", (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ local: LOCAL, hosts: [HOST] }),
    });
  });
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#appLimits:not([hidden]) .app-limit-chip");
  await assertBrand(page);
  await page.locator("#appLimitsBtn").click();
  await page.waitForSelector("#usageRow.is-open .usage-widget");
  assert.equal(await page.locator("#appLimitsBtn").getAttribute("aria-expanded"), "true");
  const widgets = page.locator("#usageRow .usage-widget");
  await widgets.first().scrollIntoViewIfNeeded();
  await sleep(900);
  await widgets.nth(0).hover();
  await sleep(900);
  await widgets.nth(1).hover();
  await sleep(1100);
  await widgets.nth(2).hover();
  await sleep(900);
  await widgets.nth(3).hover();
  await sleep(900);
  await assertBrand(page);
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: POSTER_OUT });
  await page.goto(`http://127.0.0.1:${port}/run`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#appLimits:not([hidden]) .app-limit-chip");
  await assertBrand(page);
  await sleep(1500);
  assert.deepEqual(browserErrors, [], "usage recording must not contain browser errors");
  await context.close();
  const files = readdirSync(videoDir).filter((n) => n.endsWith(".webm"));
  if (!files.length) throw new Error("playwright wrote no webm");
  cpSync(join(videoDir, files[0]), VIDEO_OUT);
  console.log(`wrote ${VIDEO_OUT}`);
  console.log(`wrote ${POSTER_OUT}`);
} finally {
  await browser.close();
  if (child.exitCode == null) await new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
  });
  rmSync(home, { recursive: true, force: true });
  rmSync(videoDir, { recursive: true, force: true });
}
