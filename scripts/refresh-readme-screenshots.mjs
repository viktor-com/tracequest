#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { MARK_SVG, WORDMARK_SVG } from "../src/ui/brand.js";
import { parseSession } from "../src/parse.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "bin/tracequest.js");
const out = join(root, "docs/assets");
const scratch = mkdtempSync(join(tmpdir(), "tracequest-readme-"));
const home = join(scratch, "home");
const children = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TRACEQUEST_")));
Object.assign(env, {
  HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home,
  TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1",
  TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux", TRACEQUEST_SKIP_LR_WATCH: "1",
});

function writeJsonl(path, rows) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function seedCodex(index, prompt, command, failure, project) {
  const id = `0000000${index}-0000-4000-8000-00000000000${index}`;
  const path = join(home, ".codex/sessions/2026/10/01", `rollout-docs-${id}.jsonl`);
  const at = (seconds) => new Date(Date.UTC(2026, 9, 1, 12, index * 5, seconds)).toISOString();
  const rows = [];
  const row = (seconds, type, payload) => rows.push({ timestamp: at(seconds), type, payload });
  row(0, "session_meta", { id, cwd: `/home/demo/code/${project}`, originator: "codex_cli_rs", cli_version: "0.161.0" });
  row(0, "turn_context", { model: "gpt-5.6-sol" });
  row(1, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  row(3, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "I’ll inspect the implementation and run the focused tests." }] });
  row(5, "response_item", { type: "function_call", call_id: `read-${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: `cat src/${project}.js` }) });
  row(8, "response_item", { type: "function_call_output", call_id: `read-${index}`, output: "Process exited with code 0\nexport function run(options) { return options; }" });
  row(14, "response_item", { type: "function_call", call_id: `test-${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: command }) });
  row(21, "response_item", { type: "function_call_output", call_id: `test-${index}`, output: failure ? "Process exited with code 1\nnot ok 2 - validates empty input\nAssertionError: expected an empty result" : "Process exited with code 0\n# tests 12\n# pass 12\n# fail 0" });
  if (failure) {
    row(28, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "The empty-input case needs an early return. I’ll fix it and rerun the test." }] });
    row(38, "response_item", { type: "function_call", call_id: `retry-${index}`, name: "exec_command", arguments: JSON.stringify({ cmd: command }) });
    row(46, "response_item", { type: "function_call_output", call_id: `retry-${index}`, output: "Process exited with code 0\n# tests 12\n# pass 12\n# fail 0" });
  }
  row(49, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 8500 + index * 1400, cached_input_tokens: 6400 + index * 1000, output_tokens: 1100 + index * 100, reasoning_output_tokens: 300, total_tokens: 9600 + index * 1500 } } });
  row(52, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Implemented the change and verified the focused tests. All 12 tests pass." }] });
  writeJsonl(path, rows);
  assert.ok(parseSession(path, "codex").events.length > 0);
}

function seed() {
  cpSync(join(root, "examples/home/.claude"), join(home, ".claude"), { recursive: true });
  const examples = [
    ["Validate empty input in the CSV reader", "node --test test/csv.test.js", true, "csv-reader"],
    ["Add a --json option to the weather CLI", "node --test test/weather.test.js", false, "weather-cli"],
    ["Fix the slug parser’s Unicode handling", "node --test test/slug.test.js", true, "slugify"],
    ["Cache repeated exchange-rate lookups", "node --test test/cache.test.js", false, "exchange-rates"],
    ["Return a useful error for unknown cities", "node --test test/weather.test.js", true, "weather-cli"],
    ["Add pagination to the project list", "node --test test/projects.test.js", false, "project-api"],
  ];
  examples.forEach((args, i) => seedCodex(i + 1, ...args));
  const hosts = join(home, ".local/share/tracequest/hosts");
  for (const name of ["laptop", "builder"]) {
    cpSync(join(home, ".claude"), join(hosts, name, ".claude"), { recursive: true });
  }
  const now = new Date().toISOString();
  writeFileSync(join(hosts, ".pull-state.json"), JSON.stringify({ hosts: Object.fromEntries(["laptop", "builder"].map((name) => [name, {
    spec: `demo@${name}`, ok: true, lastAttemptAt: now, lastSuccessAt: now,
    fetched: 2, changed: 0, skipped: 2, failed: 0, consecutiveFailures: 0, error: null,
  }])) }));
}

async function startServer(hub = false) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [bin, "serve", "--port", String(port), ...(hub ? ["--hub"] : [])], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(log);
    try { if ((await fetch(base + "/favicon.svg")).ok) return base; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Screenshot server did not start: ${log}`);
}

async function assertBrand(page) {
  for (const [selector, svg] of [[".app-mark", MARK_SVG], [".app-logotype", WORDMARK_SVG]]) {
    const logo = page.locator(selector).first();
    await logo.waitFor({ state: "visible" });
    assert.deepEqual(await logo.locator("path").evaluateAll((paths) => paths.map((p) => p.getAttribute("d"))), [...svg.matchAll(/<path[^>]* d="([^"]*)"/g)].map((m) => m[1]), `${selector} uses canonical artwork`);
    const box = await logo.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= page.viewportSize().width, `${selector} is fully visible`);
  }
}

let browser;
try {
  seed();
  const analysis = spawnSync(process.execPath, [bin, "insights", "--refresh", "--json"], { cwd: root, env, encoding: "utf8", timeout: 30000 });
  assert.equal(analysis.status, 0, analysis.stderr);
  const base = await startServer();
  const hub = await startServer(true);
  const response = await fetch(base + "/api/sessions?pageSize=100");
  assert.ok(response.ok);
  const { sessions } = await response.json();
  assert.equal(sessions.length, 12);
  const codex = sessions.filter((s) => s.source === "codex");
  assert.equal(codex.length, 6);
  assert.ok(codex.some((s) => s.errors > 0), "fixture contains indexed tool errors");
  const first = codex.find((s) => s.errors > 0);
  const second = codex.find((s) => s.errors === 0);
  const detail = sessions.find((s) => s.source === "claude" && !s.host && s.project.includes("todo-api"));
  assert.ok(first && second && detail);
  const handle = (s) => s.sessionHash;
  assert.ok(handle(first) && handle(second));
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, colorScheme: "light" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => { if (window.top === window) localStorage.setItem("tq-theme", "light"); });
  mkdirSync(out, { recursive: true });

  async function capture(name, url, ready) {
    const res = await page.goto(url, { waitUntil: "domcontentloaded" });
    assert.ok(res.ok(), `${url} loads successfully`);
    await page.locator(ready).first().waitFor({ state: "visible" });
    await assertBrand(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "page fits viewport");
    await page.screenshot({ path: join(out, name), animations: "disabled" });
    console.log(`wrote docs/assets/${name}`);
  }

  await page.setViewportSize({ width: 1440, height: 600 });
  await capture("browse.png", base + "/sessions?filter=" + encodeURIComponent("source:codex errors:>0"), "#sessions .session-row-wrap");
  await page.setViewportSize({ width: 1440, height: 960 });
  await capture("compare.png", `${base}/compare?a=${handle(first)}&b=${handle(second)}`, ".cmp-title");
  await capture("session.png", `${base}/view?id=${handle(detail)}`, ".activity-timeline");
  await capture("insights.png", base + "/insights", ".ins-heading");
  await capture("hub.png", hub + "/insights", ".ins-heading");
  assert.equal(await page.locator("html").getAttribute("data-tq-hub"), "readonly");
  await capture("runs.png", `${base}/run?session=${handle(first)}`, "#chatThread");
  const exported = await fetch(`${base}/export?id=${handle(detail)}`);
  assert.ok(exported.ok);
  const report = join(scratch, "report.html");
  writeFileSync(report, await exported.text());
  await capture("reports.png", pathToFileURL(report).href, ".report-brand");
  assert.ok((await page.locator('link[rel="icon"]').getAttribute("href")).startsWith("data:image/svg+xml"));

  await page.goto(`${base}/run?session=${handle(detail)}`, { waitUntil: "domcontentloaded" });
  await page.locator("#chatThread").waitFor({ state: "visible" });
  await page.locator("#themeToggle").click();
  await page.locator("#analyticsToggle").click();
  await page.locator("#runAnalyticsFrame:not([hidden])").waitFor({ state: "visible" });
  await page.frameLocator("#runAnalyticsFrame").locator(".activity-timeline").waitFor({ state: "visible" });
  await assertBrand(page);
  await page.screenshot({ path: join(out, "hero.png"), animations: "disabled" });
  console.log("wrote docs/assets/hero.png");
  assert.deepEqual(errors, [], "all screenshot pages run without browser errors");
  await context.close();
} finally {
  if (browser) await browser.close();
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
  }
  rmSync(scratch, { recursive: true, force: true });
}
