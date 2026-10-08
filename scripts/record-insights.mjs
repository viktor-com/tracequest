#!/usr/bin/env node
/**
 * Record a short webm of the /insights page: headline, machines, error
 * classes with a drill-down, traps. Writes docs/ui-examples/insights.webm and
 * a poster PNG from a fixture corpus (three machines, no real sessions).
 *
 *   node scripts/record-insights.mjs
 *   node scripts/record-insights.mjs --url http://hub:7780/insights --out /some/dir
 *
 * With --url it records a running server instead and never touches fixtures;
 * point --out away from the repo when that server holds real sessions.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import http from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { writeJsonl } from "../test/helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin/tracequest.js");

const { values } = parseArgs({ options: { url: { type: "string" }, out: { type: "string" } } });
const OUT_DIR = values.out || join(ROOT, "docs", "ui-examples");
const VIDEO_OUT = join(OUT_DIR, "insights.webm");
const POSTER_OUT = join(OUT_DIR, "insights.png");

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

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    }).on("error", reject);
  });
}

async function waitForHttp(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`serve exited ${child.exitCode}`);
    try {
      if ((await httpGet(url)) === 200) return;
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** One Claude session: steps are [minutesFromStart, command, resultText, isError]. */
function claudeSession({ cwd, prompt, startedHoursAgo, steps }) {
  const t0 = Date.now() - startedHoursAgo * 3600_000;
  const at = (min) => new Date(t0 + min * 60_000).toISOString();
  const lines = [{ type: "user", timestamp: at(0), cwd, message: { role: "user", content: prompt } }];
  steps.forEach(([min, command, text, isError], i) => {
    const id = `toolu_${i}`;
    const tool = command.startsWith("/") ? { name: "Edit", input: { file_path: command, old_string: "a", new_string: "b" } } : { name: "Bash", input: { command } };
    lines.push({
      type: "assistant",
      timestamp: at(min),
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "tool_use", id, ...tool }],
        usage: { input_tokens: 4000, output_tokens: 900, cache_read_input_tokens: 180_000 * (i + 1) },
      },
    });
    lines.push({
      type: "user",
      timestamp: at(min + (steps[i + 1] ? Math.min(0.2, steps[i + 1][0] - min) : 0.2)),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: Boolean(isError) }] },
    });
  });
  return lines;
}

const REPO = "/home/dev/work/shop";
const WORKTREE = "/home/dev/worktrees/checkout-flow_a1/shop";
const SESSIONS = [
  { host: null, project: "-home-dev-work-shop", s: { cwd: REPO, prompt: "Fix the flaky checkout total test and get CI green", startedHoursAgo: 5, steps: [
    [0, "cd backend && uv run pytest tests/checkout -q", "Exit code 1\n===== FAILURES =====\n2 failed, 41 passed", true],
    [2, `${REPO}/backend/shop/checkout/totals.py`, "ok"],
    [3, "cd backend && uv run pytest tests/checkout -q", "43 passed"],
    [4, "gh pr checks 812", "build pending"], [9, "gh pr checks 812", "build pending"], [14, "gh pr checks 812", "build pending"],
    [19, "gh pr checks 812", "build pending"], [24, "gh pr checks 812", "all checks passed"],
  ] } },
  { host: null, project: "-home-dev-work-shop", s: { cwd: REPO, prompt: "Add a currency selector to the cart page", startedHoursAgo: 30, steps: [
    [0, "npm test", "Exit code 254\nnpm error enoent Could not read package.json: Error: ENOENT: no such file or directory", true],
    [1, "cd frontend/apps/web && npm test", "Tests 18 passed"],
    [2, `${REPO}/frontend/apps/web/src/cart/Currency.tsx`, "ok"],
    [3, "cat frontend/apps/web/src/cart/currency.ts", "Exit code 1\ncat: frontend/apps/web/src/cart/currency.ts: No such file or directory", true],
    [4, "cat frontend/apps/web/src/cart/currency.ts", "Exit code 1\ncat: frontend/apps/web/src/cart/currency.ts: No such file or directory", true],
  ] } },
  { host: "mac", project: "-home-dev-worktrees-checkout-flow-a1-shop", s: { cwd: WORKTREE, prompt: "Move tax calculation into the pricing service", startedHoursAgo: 8, steps: [
    [0, `${REPO}/backend/shop/pricing/tax.py`, "ok"],
    [1, `${WORKTREE}/backend/shop/pricing/tax.py`, "<tool_use_error>String to replace not found in file.</tool_use_error>", true],
    [2, "cd backend && uv run pytest tests/pricing -q", "Command timed out after 10m 0s", true],
    [14, "cd backend && uv run pytest tests/pricing -q -x", "12 passed"],
    [15, "git push", "fatal: not a git repository (or any of the parent directories): .git", true],
  ] } },
  { host: "mac", project: "-home-dev-work-shop", s: { cwd: REPO, prompt: "Upgrade the payments SDK and fix the type errors", startedHoursAgo: 50, steps: [
    [0, "cd frontend && npx tsc --noEmit", "Exit code 2\nsrc/pay/client.ts(41,7): error TS2345: Argument of type 'string' is not assignable", true],
    [3, `${REPO}/frontend/packages/pay/src/client.ts`, "ok"],
    [4, "cd frontend && npx tsc --noEmit", "ok"],
    [5, "curl -s https://api.payments.example/v2/health", "Exit code 22\ncurl: (22) The requested URL returned error: 401 Unauthorized", true],
  ] } },
  { host: "devbox", project: "-home-dev-work-shop", s: { cwd: REPO, prompt: "Rebase the search branch and resolve conflicts", startedHoursAgo: 2, steps: [
    [0, "git rebase origin/main", "Exit code 1\nCONFLICT (content): Merge conflict in backend/shop/search/index.py", true],
    [2, `${REPO}/backend/shop/search/index.py`, "ok"],
    [3, "git rebase --continue", "Successfully rebased"],
    [4, "gh run watch 5512", "completed success"],
    [11, "python -c 'import shop.search'", "Exit code 1\nModuleNotFoundError: No module named 'shop'", true],
  ] } },
  { host: "devbox", project: "-home-dev-work-shop", s: { cwd: REPO, prompt: "Write the release notes for 4.2", startedHoursAgo: 70, steps: [
    [0, "git log --oneline v4.1..HEAD", "a1b2c3 Add currency selector"],
    [1, `${REPO}/docs/releases/4.2.md`, "ok"],
  ] } },
];

async function startFixtureServer() {
  const home = mkdtempSync(join(tmpdir(), "tq-insights-record-"));
  const hostsRoot = join(home, ".local", "share", "tracequest", "hosts");
  SESSIONS.forEach(({ host, project, s }, i) => {
    const base = host ? join(hostsRoot, host) : home;
    writeJsonl(join(base, ".claude", "projects", project, `sess-${i}.jsonl`), claudeSession(s));
  });
  const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
  mkdirSync(hostsRoot, { recursive: true });
  writeFileSync(join(hostsRoot, ".pull-state.json"), JSON.stringify({ hosts: {
    mac: { spec: "dev@mac", ok: true, lastAttemptAt: ago(12), lastSuccessAt: ago(12), fetched: 6, changed: 1, skipped: 5, failed: 0, consecutiveFailures: 0, error: null },
    devbox: { spec: "devbox", ok: true, lastAttemptAt: ago(12), lastSuccessAt: ago(12), fetched: 6, changed: 0, skipped: 6, failed: 0, consecutiveFailures: 0, error: null },
    laptop: { spec: "dev@laptop", ok: false, lastAttemptAt: ago(12), lastSuccessAt: ago(60 * 30), fetched: 0, changed: 0, skipped: 0, failed: 6, consecutiveFailures: 3, error: "ssh: connect to host laptop port 22: Connection timed out" },
  } }));
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_TMUX: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
    TRACEQUEST_SKIP_LR_WATCH: "1",
  };
  delete env.TRACEQUEST_HOSTS_DIR;
  const refresh = spawnSync(process.execPath, [BIN, "insights", "--refresh", "--json"], { cwd: ROOT, env, encoding: "utf8" });
  if (refresh.status !== 0) throw new Error(`insights --refresh failed: ${refresh.stderr}`);
  const port = await allocPort();
  const child = spawn(process.execPath, [BIN, "serve", "--hub", "--bind", "127.0.0.1", "--port", String(port)], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env,
  });
  const url = `http://127.0.0.1:${port}/insights`;
  await waitForHttp(url, child);
  return { url, stop: () => { child.kill("SIGTERM"); rmSync(home, { recursive: true, force: true }); } };
}

const target = values.url ? { url: values.url, stop: () => {} } : await startFixtureServer();
const videoDir = mkdtempSync(join(tmpdir(), "tq-insights-video-"));
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  await page.goto(target.url, { waitUntil: "load" });
  await page.waitForSelector('[data-insight="headline"]');
  mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: POSTER_OUT, fullPage: true });
  await sleep(1100);

  const scrollTo = async (selector) => {
    await page.locator(selector).first().evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" }));
    await sleep(800);
  };
  await scrollTo('[data-insight="machines"]');
  await scrollTo('[data-insight="error-classes"]');
  const firstClass = page.locator('[data-insight="error-classes"] .ins-bar-head').first();
  if (await firstClass.count()) {
    await firstClass.hover();
    await sleep(500);
    await firstClass.click();
    await sleep(1100);
  }
  await scrollTo('[data-insight="by-harness"]');
  await scrollTo('[data-insight="retries"]');
  await scrollTo('[data-insight="active-time"]');
  await scrollTo('[data-insight="expensive"]');
  await scrollTo('[data-insight="traps"]');
  const trap = page.locator('[data-insight="traps"] details summary').last();
  if (await trap.count()) {
    await trap.click();
    await sleep(900);
    // Drill down: open the first example session of that trap.
    const example = page.locator('[data-insight="traps"] details[open] .ins-example').first();
    if (await example.count()) {
      await example.click();
      await page.waitForLoadState("load");
      await sleep(1400);
    }
  }
  await context.close();
  const [video] = readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  if (!video) throw new Error("no video recorded");
  cpSync(join(videoDir, video), VIDEO_OUT);
  console.log(`wrote ${VIDEO_OUT}\nwrote ${POSTER_OUT}`);
} finally {
  await browser.close();
  rmSync(videoDir, { recursive: true, force: true });
  target.stop();
}
