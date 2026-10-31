#!/usr/bin/env node
// Screen recording of the real hub UI on a prepared harness run: cold start, a common
// phrase in the top bar, the Runs filter while agents write, and the loading state of
// slow quoted phrases. A label on the page shows each search's keystroke-to-results time.
// usage: node record.mjs --build <dir> --label <prepared run label> --out <dir> [--port 7799]
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: o } = parseArgs({ options: { build: { type: "string" }, label: { type: "string" }, out: { type: "string" }, port: { type: "string", default: "7799" }, "runs-dir": { type: "string", default: join(process.env.HOME, "tqbench/runs") } } });
const BUILD = resolve(o.build);
const RUN = join(o["runs-dir"], o.label);
const HOME = join(RUN, "home");
const CACHE = join(RUN, "cache-rec");
const OUT = resolve(o.out);
const PORT = Number(o.port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

rmSync(CACHE, { recursive: true, force: true });
execFileSync("cp", ["-a", "--reflink=auto", join(RUN, "cache-base"), CACHE]);
mkdirSync(OUT, { recursive: true });
const env = { ...process.env, HOME, TRACEQUEST_CACHE_DIR: CACHE, TRACEQUEST_TMUX_SOCKET: "tqbench", TRACEQUEST_NO_RESULT_CACHE: "1", TRACEQUEST_NEAR_CACHE: "0" };
// search.bin names the inode of the search.idx it mirrors; the copy has a new one.
execFileSync("node", ["--input-type=module", "-e", `const m = await import(${JSON.stringify(join(BUILD, "src/sessions/search-index.js"))}); m.loadSearchIndex();`], { env });

const HUD = `(() => {
  const T = window.__tq = { marks: [], keys: [] };
  const of = window.fetch;
  const hud = () => {
    let el = document.getElementById("tq-rec-hud");
    if (!el && document.body) {
      el = document.createElement("div");
      el.id = "tq-rec-hud";
      el.style.cssText = "position:fixed;left:12px;bottom:12px;z-index:99999;font:13px/1.4 ui-monospace,monospace;background:rgba(0,0,0,.78);color:#9f9;padding:8px 10px;border-radius:8px;max-width:640px;white-space:pre";
      document.body.appendChild(el);
    }
    return el;
  };
  const lines = [];
  const say = (text) => { lines.push(text); while (lines.length > 4) lines.shift(); const el = hud(); if (el) el.textContent = lines.join("\\n"); };
  window.__tqSay = say;
  document.addEventListener("keydown", (e) => T.keys.push({ key: e.key, t: performance.now() }), true);
  window.fetch = function (input) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const p = of.apply(this, arguments);
    let label = null;
    try {
      const u = new URL(url, location.href);
      if (u.pathname === "/api/search" && u.searchParams.has("q")) label = "top bar \\u201c" + u.searchParams.get("q") + "\\u201d";
      else if (u.pathname === "/api/sessions" && u.searchParams.has("expr")) label = "Runs filter \\u201c" + u.searchParams.get("expr") + "\\u201d";
    } catch (e) {}
    if (!label) return p;
    return p.then((r) => {
      const orig = r.json.bind(r);
      r.json = () => orig().then((v) => {
        requestAnimationFrame(() => {
          const now = performance.now();
          const key = T.keys.filter((k) => k.key.length === 1 || k.key === "Enter").at(-1);
          say(label + ": results " + (key ? Math.round(now - key.t) + " ms after the last key" : "shown"));
        });
        return v;
      });
      return r;
    });
  };
})();`;

const hubLog = join(RUN, "record-hub.log");
const t0 = Date.now();
const hub = spawn("node", [join(BUILD, "bin/tracequest.js"), "serve", "--hub", "--port", String(PORT), "--bind", "127.0.0.1"], { cwd: join(process.env.HOME, "tqbench/cwd/tracequest"), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
hub.stdout.on("data", (d) => appendFileSync(hubLog, d));
hub.stderr.on("data", (d) => appendFileSync(hubLog, d));
const { chromium } = await import(join(BUILD, "node_modules/playwright/index.mjs"));
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: OUT, size: { width: 1280, height: 800 } } });
await ctx.addInitScript(HUD);
const page = await ctx.newPage();
let writer = null;
try {
  // 1. Cold start: the page is opened as soon as the hub listens.
  for (;;) {
    try { await page.goto(`http://127.0.0.1:${PORT}/sessions`, { waitUntil: "load", timeout: 120000 }); break; } catch { await sleep(100); }
  }
  await page.evaluate((ms) => window.__tqSay(`hub started, Runs page loaded ${ms} ms after launch (16,957 sessions)`), Date.now() - t0);
  await sleep(1200);
  // 2. A common phrase in the top-bar search box.
  await page.click("#workspaceSearch");
  await page.keyboard.type("you're absolutely right", { delay: 90 });
  await sleep(2500);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  // 3. Agents writing sessions while the Runs filter is used.
  writer = spawn("node", [join(process.env.HOME, "tqbench/harness/writer.mjs"), "live", join(RUN, "plan.json"), "300", "2000"], { stdio: "ignore" });
  await page.evaluate(() => window.__tqSay("agents now writing 8 sessions and adding new ones"));
  await sleep(1500);
  await page.click("#filterInput");
  await page.keyboard.type("let me", { delay: 90 });
  await page.keyboard.press("Enter");
  await sleep(2500);
  // 4. Slow quoted phrases: the spinner stays until the rows are in.
  await page.click("#filterInput");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("\"you're absolutely right\"", { delay: 90 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("filterBar").classList.contains("is-loading"), null, { timeout: 120000 });
  await sleep(2500);
  await page.click("#filterInput");
  await page.keyboard.press("Control+A");
  await page.keyboard.type("\"let me\"", { delay: 90 });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => !document.getElementById("filterBar").classList.contains("is-loading"), null, { timeout: 120000 });
  await sleep(2500);
  // 5. The top bar while the filter list and indexing keep the hub busy.
  await page.click("#workspaceSearch");
  await page.keyboard.type("codex stop button", { delay: 90 });
  await sleep(2500);
} finally {
  if (writer) writer.kill("SIGTERM");
  const video = page.video();
  await ctx.close();
  await browser.close();
  try { process.kill(-hub.pid, "SIGTERM"); } catch {}
  if (video) {
    const path = await video.path();
    renameSync(path, join(OUT, "search-ui.webm"));
    log("video:", join(OUT, "search-ui.webm"));
  }
  // Undo the writer's changes to the prepared corpus.
  const plan = JSON.parse((await import("node:fs")).readFileSync(join(RUN, "plan.json"), "utf8"));
  const sizes = JSON.parse((await import("node:fs")).readFileSync(join(RUN, "pristine-sizes.json"), "utf8"));
  const fs = await import("node:fs");
  for (const item of plan.newSessions) if (fs.existsSync(item.to)) fs.rmSync(item.to);
  for (const [p, size] of sizes) { try { if (fs.statSync(p).size !== size) execFileSync("truncate", ["-s", String(size), p]); } catch {} }
  rmSync(CACHE, { recursive: true, force: true });
}
