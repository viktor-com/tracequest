#!/usr/bin/env node
// Search latency harness for tracequest: times the CLI and the real hub UI (Playwright
// on the served page) for every condition in the search acceptance, on a frozen copy
// of a real corpus. Read-only towards the source corpus: everything runs on a reflink
// copy under runs/<label>/.
//
// usage: node search-latency.mjs --build <tracequest dir> --label <name> --corpus <home>
//          [--only cli,cli-changed,cli-cold,fresh,ui,idle,indexing,pull] [--rounds 2]
//          [--runs 5] [--port 7795] [--no-hub-mode] [--no-sidecar] [--type-delay 50]
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync,
  statSync, writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = dirname(new URL(import.meta.url).pathname);
const { values: opt } = parseArgs({
  options: {
    build: { type: "string" }, label: { type: "string" }, corpus: { type: "string" },
    only: { type: "string", default: "cli,cli-changed,fresh,ui,idle,indexing,pull" },
    rounds: { type: "string", default: "2" }, runs: { type: "string", default: "5" },
    port: { type: "string", default: "7795" }, "no-hub-mode": { type: "boolean" },
    "no-sidecar": { type: "boolean" }, "type-delay": { type: "string", default: "50" },
    "keep-run": { type: "boolean" }, "playwright": { type: "string" },
    "cwd": { type: "string", default: join(process.env.HOME, "tqbench/cwd/tracequest") },
    "video": { type: "string" }, groups: { type: "string" }, "runs-dir": { type: "string", default: join(process.env.HOME, "tqbench/runs") }, out: { type: "string", default: "results.json" },
  },
});
const BUILD = resolve(opt.build);
const LABEL = opt.label;
const CORPUS = resolve(opt.corpus);
const ONLY = new Set(opt.only.split(","));
const ROUNDS = Number(opt.rounds);
const RUNS = Number(opt.runs);
const PORT = Number(opt.port);
const TYPE_DELAY = Number(opt["type-delay"]);
const RUN_CWD = opt.cwd;
const RUN = join(opt["runs-dir"], LABEL);
const HOME = join(RUN, "home");
const HELD = join(RUN, "heldout");
const CACHE_BASE = join(RUN, "cache-base");
const CACHE = join(RUN, "cache");
const QUERIES = JSON.parse(readFileSync(join(HERE, "queries.json"), "utf8"));
const PW = opt.playwright || join(BUILD, "node_modules/playwright/index.mjs");
const results = { label: LABEL, build: BUILD, corpus: CORPUS, startedAt: new Date().toISOString(), host: execFileSync("hostname").toString().trim(), sidecar: !opt["no-sidecar"], hubMode: !opt["no-hub-mode"], conditions: {} };
// The exact code measured: the build's commit and whether its tree was clean.
try {
  results.head = execFileSync("git", ["-C", BUILD, "rev-parse", "HEAD"]).toString().trim();
  results.dirty = execFileSync("git", ["-C", BUILD, "status", "--porcelain", "--untracked-files=no"]).toString().trim() !== "";
} catch {
  results.head = null;
}

const log = (...a) => console.error(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  const v = arr.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
};
const stats = (arr) => ({ n: arr.length, fail: arr.filter((x) => !Number.isFinite(x)).length, p50: pct(arr, 50), p90: pct(arr, 90), max: pct(arr, 100) });
const GROUPS = opt.groups ? opt.groups.split(",") : null;
const allQueries = GROUPS ? GROUPS.flatMap((g) => QUERIES[g]) : [...QUERIES.original26, ...QUERIES.common, ...(QUERIES.quoted || []), ...QUERIES.long, ...QUERIES.rare];
// Every query is timed in every condition, live ones included.
const liveQueries = allQueries;

function env(extra = {}) {
  const e = {
    ...process.env, HOME, TRACEQUEST_CACHE_DIR: CACHE, TRACEQUEST_TMUX_SOCKET: "tqbench",
    // No query-keyed caches in any timing: every query is timed as a novel one.
    TRACEQUEST_NO_RESULT_CACHE: "1", TRACEQUEST_NEAR_CACHE: "0", TRACEQUEST_NO_RESPONSE_CACHE: "1", ...extra,
  };
  if (opt["no-sidecar"]) e.TRACEQUEST_NO_SIDECAR = "1";
  delete e.TRACEQUEST_VERBOSE;
  return e;
}

/** Stop resident CLI search processes of this run (their socket lives in CACHE). */
function stopResidentSearch() {
  const r = spawnSync("pgrep", ["-f", `search-daemon-main.js ${CACHE}`], { encoding: "utf8" });
  for (const pid of (r.stdout || "").trim().split("\n").filter(Boolean)) {
    try { process.kill(Number(pid), "SIGTERM"); } catch {}
  }
}

/** Wait until a resident CLI search answers on CACHE (builds without one return at once). */
async function waitResidentSearch(ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (existsSync(CACHE) && readdirSync(CACHE).some((n) => n.endsWith(".sock"))) return true;
    if (!existsSync(join(BUILD, "src/cli/search-daemon.js"))) return false;
    await sleep(100);
  }
  return false;
}

function resetCache() {
  stopResidentSearch();
  spawnSync("sleep", ["1"]);
  rmSync(CACHE, { recursive: true, force: true, maxRetries: 5 });
  execFileSync("cp", ["-a", "--reflink=auto", CACHE_BASE, CACHE]);
  // search.bin names the inode of the search.idx it mirrors; a copy has a new
  // one. Re-open it once so it is current, as on a machine whose cache is not copied.
  spawnSync("node", ["--input-type=module", "-e", `const m = await import(${JSON.stringify(join(BUILD, "src/sessions/search-index.js"))}); m.loadSearchIndex();`], { env: env(), stdio: "ignore" });
}

// ---------------------------------------------------------------- corpus prep
function listSessions(home) {
  const out = [];
  const push = (p, source, host) => { try { const st = statSync(p); out.push({ path: p, source, host, mtime: st.mtimeMs, size: st.size }); } catch {} };
  const walk = (base, host) => {
    const cp = join(base, ".claude/projects");
    if (existsSync(cp)) for (const d of readdirSync(cp)) {
      const dir = join(cp, d);
      try { for (const f of readdirSync(dir)) if (f.endsWith(".jsonl")) push(join(dir, f), "claude", host); } catch {}
    }
    const cx = join(base, ".codex/sessions");
    if (existsSync(cx)) for (const f of readdirSync(cx, { recursive: true })) if (/rollout-.*\.jsonl$/.test(f)) push(join(cx, f), "codex", host);
  };
  walk(home, null);
  const hosts = join(home, ".local/share/tracequest/hosts");
  if (existsSync(hosts)) for (const h of readdirSync(hosts)) if (!h.startsWith(".")) walk(join(hosts, h), h);
  return out;
}
const rank = (p) => createHash("sha1").update(p).digest("hex");
/** Sessions held out of the timed corpus: written as new while the hub runs, and pulled as a host import. */
const NEW_HELD = 30;
const PULL_HELD = 150;
/** The pull writes its sessions over this long; every pull-condition query must fall inside it. */
const PULL_MS = 600000;

function prepare() {
  if (existsSync(join(RUN, "plan.json"))) {
    log("reusing prepared run", RUN);
    return JSON.parse(readFileSync(join(RUN, "plan.json"), "utf8"));
  }
  mkdirSync(RUN, { recursive: true });
  log("reflink-copying corpus", CORPUS, "->", HOME);
  execFileSync("cp", ["-a", "--reflink=auto", CORPUS, HOME]);
  const all = listSessions(HOME);
  const byRecent = [...all].sort((a, b) => b.mtime - a.mtime);
  const active = byRecent.filter((s) => !s.host).slice(0, 8);
  const activeSet = new Set(active.map((s) => s.path));
  // Held out (moved, never copied): "new" sessions written while the hub runs, and a host pull.
  // Ranked by the path inside the corpus, so every run of the same corpus holds out the same sessions.
  const pickable = all.filter((s) => !activeSet.has(s.path) && s.size > 2000 && s.size < 4e6).sort((a, b) => rank(relative(HOME, a.path)).localeCompare(rank(relative(HOME, b.path))));
  const newPick = pickable.slice(0, NEW_HELD);
  const hostPool = pickable.slice(NEW_HELD).filter((s) => s.host);
  const pullPick = (hostPool.length >= PULL_HELD ? hostPool : pickable.slice(NEW_HELD)).slice(0, PULL_HELD);
  const move = (s, kind) => {
    const to = join(HELD, kind, relative(HOME, s.path));
    mkdirSync(dirname(to), { recursive: true });
    renameSync(s.path, to);
    return { from: to, to: s.path };
  };
  const newSessions = newPick.map((s) => move(s, "new"));
  const pull = pullPick.map((s) => move(s, "pull"));
  // Lines appended to the active sessions come from other real sessions of the same source.
  const linePools = {};
  for (const source of ["claude", "codex"]) {
    const heldOut = new Set([...newPick, ...pullPick].map((s) => s.path));
    const donors = pickable.filter((s) => s.source === source && !heldOut.has(s.path)).slice(-20);
    const lines = [];
    for (const d of donors) {
      for (const line of readFileSync(d.path, "utf8").split("\n")) if (line && line.length < 20000) lines.push(line);
      if (lines.length > 3000) break;
    }
    linePools[source] = lines.slice(0, 3000);
  }
  const plan = { active: active.map((s) => ({ path: s.path, source: s.source })), newSessions, pull, linePools };
  writeFileSync(join(RUN, "plan.json"), JSON.stringify(plan));
  writeFileSync(join(RUN, "pristine-sizes.json"), JSON.stringify(active.map((s) => [s.path, s.size])));
  // Index once into cache-base; every condition starts from a copy of it.
  mkdirSync(CACHE, { recursive: true });
  const t0 = performance.now();
  const r = spawnSync("node", [join(BUILD, "bin/tracequest.js"), "search", "index warmup", "--limit", "1"], { cwd: RUN_CWD, env: env(), encoding: "utf8" });
  results.coldIndexBuildMs = Math.round(performance.now() - t0);
  log("cold index build", results.coldIndexBuildMs, "ms", (r.stderr || "").trim().split("\n").slice(-1)[0]);
  spawnSync("node", [join(BUILD, "bin/tracequest.js"), "search", "index warmup", "--limit", "1"], { cwd: RUN_CWD, env: env(), encoding: "utf8" });
  rmSync(CACHE_BASE, { recursive: true, force: true });
  renameSync(CACHE, CACHE_BASE);
  return plan;
}

// Put the corpus back as prepared: held-out sessions out again, active sessions truncated.
function restoreCorpus(plan) {
  for (const item of [...plan.newSessions, ...plan.pull]) {
    if (existsSync(item.to) && !existsSync(item.from)) { mkdirSync(dirname(item.from), { recursive: true }); renameSync(item.to, item.from); }
    else if (existsSync(item.to)) rmSync(item.to);
  }
  for (const [p, size] of JSON.parse(readFileSync(join(RUN, "pristine-sizes.json"), "utf8"))) {
    try { if (statSync(p).size !== size) execFileSync("truncate", ["-s", String(size), p]); } catch {}
  }
}

// ---------------------------------------------------------------- CLI
/** One timed CLI search per query, with wall-clock start and end (for overlap checks). */
function cliRowsFor(queries) {
  return queries.map((q) => {
    const at = Date.now();
    const ms = Math.round(cli(["search", q, "--limit", "10"]));
    return { query: q, ms, at, end: Date.now() };
  });
}

/** Rows of `rows` (with at/end) that ran wholly inside [from, to]. */
function overlap(rows, from, to) {
  const inside = rows.filter((r) => r.at >= from && r.end <= to).length;
  return { rows: rows.length, inside, from, to };
}

function cli(args, extraEnv) {
  const t0 = performance.now();
  const r = spawnSync("node", [join(BUILD, "bin/tracequest.js"), ...args], { cwd: RUN_CWD, env: env(extraEnv), encoding: "utf8", maxBuffer: 64 << 20 });
  const ms = performance.now() - t0;
  if (r.status !== 0) log("CLI exit", r.status, args.join(" "), (r.stderr || "").slice(-300));
  return r.status === 0 ? ms : NaN;
}

/** RSS, threads and CPU of the resident search process(es) of this run. */
function residentResources() {
  const r = spawnSync("pgrep", ["-f", `search-daemon-main.js ${CACHE}`], { encoding: "utf8" });
  const pids = (r.stdout || "").trim().split("\n").filter(Boolean).map(Number);
  return pids.map((pid) => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rssKB = Number(status.match(/VmRSS:\s+(\d+)/)?.[1] || 0);
      const threads = Number(status.match(/Threads:\s+(\d+)/)?.[1] || 0);
      const f = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
      return { pid, rssMB: Math.round(rssKB / 1024), threads, cpuSec: (Number(f[11]) + Number(f[12])) / 100 };
    } catch {
      return { pid, gone: true };
    }
  });
}

async function condCli() {
  resetCache();
  cli(["search", "warm up", "--limit", "10"]);
  results.residentSearch = await waitResidentSearch();
  cli(["search", "warm up again", "--limit", "10"]);
  results.residentAtStart = residentResources();
  const rows = [];
  for (const q of allQueries) {
    for (const cmd of ["search", "handoff"]) {
      const lim = cmd === "search" ? "10" : "5";
      const t = [];
      for (let i = 0; i < RUNS; i++) t.push(cli([cmd, q, "--limit", lim]));
      rows.push({ query: q, cmd, ms: t.map(Math.round), p50: pct(t, 50), p90: pct(t, 90) });
    }
    log("cli", q, rows.at(-2).p50?.toFixed(0), rows.at(-1).p50?.toFixed(0));
  }
  results.residentAfterCli = residentResources();
  return { rows, search: stats(rows.filter((r) => r.cmd === "search").map((r) => r.p50)), handoff: stats(rows.filter((r) => r.cmd === "handoff").map((r) => r.p50)), allRuns: stats(rows.flatMap((r) => r.ms)) };
}

// First CLI search after sessions changed (agents wrote since the last search).
async function condCliChanged(plan) {
  resetCache();
  cli(["search", "warm up", "--limit", "10"]);
  await waitResidentSearch();
  cli(["search", "warm up again", "--limit", "10"]);
  const pools = plan.linePools;
  let k = 0;
  const rows = [];
  for (const q of liveQueries) {
    for (const s of plan.active) for (let i = 0; i < 3; i++) appendFileSync(s.path, (pools[s.source][k++ % pools[s.source].length]) + "\n");
    const item = plan.newSessions[rows.length % plan.newSessions.length];
    if (!existsSync(item.to)) { mkdirSync(dirname(item.to), { recursive: true }); cpSync(item.from, item.to); }
    rows.push({ query: q, ms: Math.round(cli(["search", q, "--limit", "10"])) });
    log("cli-changed", q, rows.at(-1).ms);
  }
  restoreCorpus(plan);
  return { rows, search: stats(rows.map((r) => r.ms)) };
}

// First search of a fresh CLI start: no resident search running, index on disk current.
function condCliFirst() {
  resetCache();
  cli(["search", "warm up", "--limit", "10"]);
  const rows = [];
  for (const q of ["you're absolutely right", "let me", "codex stop button", "zstd", "I'll"]) {
    stopResidentSearch();
    spawnSync("sleep", ["0.5"]);
    rows.push({ query: q, ms: Math.round(cli(["search", q, "--limit", "10"])) });
    log("cli-first", q, rows.at(-1).ms);
  }
  stopResidentSearch();
  return { rows, search: stats(rows.map((r) => r.ms)) };
}

// First search with an empty cache directory (fresh install / upgrade with index rebuild).
function condCliCold() {
  stopResidentSearch();
  spawnSync("sleep", ["1"]);
  rmSync(CACHE, { recursive: true, force: true, maxRetries: 5 });
  const ms = cli(["search", "you're absolutely right", "--limit", "10"]);
  return { firstSearchEmptyCacheMs: Math.round(ms) };
}

// ---------------------------------------------------------------- hub
let hub = null;

/** Pid listening on PORT, or null. */
function portOwner() {
  const r = spawnSync("ss", ["-ltnpH", `sport = :${PORT}`], { encoding: "utf8" });
  const m = (r.stdout || "").match(/pid=(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Kill whatever still listens on PORT (a hub a previous step failed to stop). */
async function freePort() {
  for (let i = 0; i < 40; i++) {
    const pid = portOwner();
    if (!pid) return;
    log("port", PORT, "still held by", pid, "- killing it");
    try { process.kill(pid, "SIGKILL"); } catch {}
    await sleep(250);
  }
  throw new Error(`port ${PORT} stays in use`);
}

async function startHub() {
  await freePort();
  const args = [join(BUILD, "bin/tracequest.js"), "serve", "--port", String(PORT), "--bind", "127.0.0.1"];
  if (!opt["no-hub-mode"]) args.push("--hub");
  const t0 = performance.now();
  const proc = spawn("node", args, { cwd: RUN_CWD, env: env(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  const logFile = join(RUN, "hub.log");
  proc.stdout.on("data", (d) => appendFileSync(logFile, d));
  proc.stderr.on("data", (d) => appendFileSync(logFile, d));
  let readyMs = null;
  for (let i = 0; i < 1200 && readyMs === null; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/agents`, { signal: AbortSignal.timeout(2000) });
      if (r.status < 500) readyMs = performance.now() - t0;
    } catch {}
    if (readyMs === null) await sleep(25);
  }
  hub = proc;
  // The hub answering must be the one just started, never a leftover.
  if (portOwner() !== proc.pid) throw new Error(`port ${PORT} is answered by ${portOwner()}, not the hub just started (${proc.pid})`);
  return { proc, readyMs: Math.round(readyMs), t0 };
}
async function stopHub() {
  if (!hub) return;
  try { process.kill(-hub.pid, "SIGTERM"); } catch {}
  for (let i = 0; i < 100 && hub.exitCode === null && hub.signalCode === null; i++) await sleep(50);
  try { process.kill(-hub.pid, "SIGKILL"); } catch {}
  try { process.kill(hub.pid, "SIGKILL"); } catch {}
  hub = null;
  await freePort();
}

function procTreeTicks(root) {
  const kids = new Map();
  const stat = new Map();
  for (const p of readdirSync("/proc")) {
    if (!/^\d+$/.test(p)) continue;
    try {
      const s = readFileSync(`/proc/${p}/stat`, "utf8");
      const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
      stat.set(Number(p), f);
      const pp = Number(f[1]);
      if (!kids.has(pp)) kids.set(pp, []);
      kids.get(pp).push(Number(p));
    } catch {}
  }
  let ticks = 0;
  let rss = 0;
  const visit = (pid, isRoot) => {
    const f = stat.get(pid);
    if (!f) return;
    ticks += Number(f[11]) + Number(f[12]) + (isRoot ? Number(f[13]) + Number(f[14]) : 0);
    rss += Number(f[21]) * 4096;
    for (const k of kids.get(pid) || []) visit(k, false);
  };
  visit(root, true);
  return { ticks, rss };
}
async function cpuOver(pid, ms) {
  const a = procTreeTicks(pid);
  const t0 = performance.now();
  await sleep(ms);
  const b = procTreeTicks(pid);
  return { cpuPct: Math.round(((b.ticks - a.ticks) / 100) / ((performance.now() - t0) / 1000) * 1000) / 10, rssMB: Math.round(b.rss / 1048576) };
}

// ---------------------------------------------------------------- browser
const INSTRUMENT = `(() => {
  const T = window.__tq = { marks: [], keys: [] };
  const of = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || String(input);
    const p = of.apply(this, arguments);
    let kind = null, q = null;
    try {
      const u = new URL(url, location.href);
      if (u.pathname === "/api/search" && u.searchParams.has("q")) { kind = "search"; q = u.searchParams.get("q"); }
      else if (u.pathname === "/api/sessions" && u.searchParams.has("expr")) { kind = "sessions"; q = u.searchParams.get("expr"); }
    } catch (e) {}
    if (!kind) return p;
    const t0 = performance.now();
    return p.then((r) => {
      const wrap = (name) => { const orig = r[name].bind(r); r[name] = () => orig().then((v) => {
        const m = { kind, q, t0, t: performance.now(), status: r.status, partial: name === "json" && Boolean(v && v.partial) };
        T.marks.push(m);
        // The page renders in the same task as this resolution; the next frame shows it.
        requestAnimationFrame(() => { m.paint = performance.now(); });
        return v; }); };
      wrap("json"); wrap("text");
      return r;
    });
  };
  document.addEventListener("keydown", (e) => T.keys.push({ key: e.key, t: performance.now() }), true);
})();`;

let browser = null;
async function newPage(context) {
  const page = await context.newPage();
  page.on("pageerror", (e) => log("pageerror", String(e).slice(0, 200)));
  return page;
}
async function openBrowser() {
  const { chromium } = await import(PW);
  browser = await chromium.launch({ headless: true });
}
async function newContext() {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ...(opt.video ? { recordVideo: { dir: opt.video, size: { width: 1440, height: 900 } } } : {}),
  });
  await ctx.addInitScript(INSTRUMENT);
  return ctx;
}

const base = () => `http://127.0.0.1:${PORT}`;

/** Top-bar search box: type the query, time from its last keystroke to its results painted. */
async function topbarQuery(page, q, timeout = 120000) {
  await page.evaluate(() => { const b = document.getElementById("workspaceSearch"); b.value = ""; b.blur(); });
  await page.click("#workspaceSearch");
  await page.waitForTimeout(200);
  await page.evaluate(() => { window.__tq.marks = []; window.__tq.keys = []; });
  await page.keyboard.type(q, { delay: TYPE_DELAY });
  const want = q.trim();
  try {
    const h = await page.waitForFunction((want) => {
      const T = window.__tq;
      const m = T.marks.find((x) => x.kind === "search" && x.q === want && x.paint);
      if (!m) return null;
      const chars = T.keys.filter((k) => k.key.length === 1);
      return { lastKeyMs: m.paint - chars.at(-1).t, firstKeyMs: m.paint - chars[0].t, serverMs: m.t - m.t0, status: m.status,
        items: document.querySelectorAll("#workspaceSearchList .tq-search-item").length,
        requests: T.marks.filter((x) => x.kind === "search").length };
    }, want, { timeout, polling: 10 });
    return await h.jsonValue();
  } catch (e) {
    return { lastKeyMs: NaN, error: String(e).slice(0, 120) };
  }
}

/** Runs page filter box: type the query, press Enter, time from Enter to the filtered rows painted. */
async function runsEnter(page, q, timeout = 120000) {
  await page.click("#filterInput");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await page.waitForFunction(() => !document.body.classList.contains("runs-loading"), null, { timeout }).catch(() => {});
  await page.evaluate(() => { window.__tq.marks = []; window.__tq.keys = []; });
  await page.keyboard.type(q, { delay: TYPE_DELAY });
  if (await page.evaluate(() => document.getElementById("suggestions")?.classList.contains("open"))) await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  const want = q.trim();
  try {
    const h = await page.waitForFunction((want) => {
      const T = window.__tq;
      const enter = T.keys.filter((k) => k.key === "Enter").at(-1);
      if (!enter) return null;
      // The first answer for this expression painted after Enter (Enter may keep a request already in flight).
      const m = T.marks.find((x) => x.kind === "sessions" && x.q === want && x.paint && x.paint >= enter.t);
      if (!m) return null;
      return { enterMs: m.paint - enter.t, serverMs: m.t - m.t0, status: m.status, partial: m.partial,
        rows: document.querySelectorAll("#sessions .session-row").length };
    }, want, { timeout, polling: 10 });
    const first = await h.jsonValue();
    // A first page (partial) is followed by the complete answer: its count and stats.
    const c = await page.waitForFunction((want) => {
      const T = window.__tq;
      const enter = T.keys.filter((k) => k.key === "Enter").at(-1);
      const m = T.marks.find((x) => x.kind === "sessions" && x.q === want && x.paint && x.paint >= enter.t && !x.partial);
      return m ? { completeMs: m.paint - enter.t } : null;
    }, want, { timeout, polling: 10 });
    return { ...first, ...(await c.jsonValue()) };
  } catch (e) {
    return { enterMs: NaN, completeMs: NaN, error: String(e).slice(0, 120) };
  }
}

/**
 * Deep link /sessions?expr=q (what the top bar's Enter opens without a hit):
 * navigation start to the filtered rows on screen. The page embeds its rows,
 * so this watches the list itself, not a fetch.
 */
async function deepLink(page, q, timeout = 120000) {
  await page.goto(`${base()}/sessions?expr=${encodeURIComponent(q)}`, { waitUntil: "commit", timeout });
  try {
    const h = await page.waitForFunction(() => {
      const list = document.getElementById("sessions");
      const input = document.getElementById("filterInput");
      if (!list || !input || document.body.classList.contains("runs-loading")) return null;
      const shown = list.querySelector(".session-row") || document.querySelector(".ui-empty");
      return shown ? { navMs: performance.now(), expr: input.value } : null;
    }, null, { timeout, polling: "raf" });
    return await h.jsonValue();
  } catch (e) {
    return { navMs: NaN, error: String(e).slice(0, 120) };
  }
}

async function uiRounds(queries, rounds, tag) {
  const rows = [];
  for (let round = 0; round < rounds; round++) {
    const ctx = await newContext();
    const page = await newPage(ctx);
    await page.goto(`${base()}/sessions`, { waitUntil: "load", timeout: 180000 });
    for (const q of queries) {
      const at = Date.now();
      const r = await topbarQuery(page, q);
      rows.push({ round, query: q, kind: "topbar", ms: r.lastKeyMs, at, end: Date.now(), ...r });
    }
    await page.goto(`${base()}/sessions`, { waitUntil: "load", timeout: 180000 });
    await page.waitForSelector("#filterInput");
    for (const q of queries) {
      const at = Date.now();
      const r = await runsEnter(page, q);
      rows.push({ round, query: q, kind: "runsEnter", ms: r.enterMs, at, end: Date.now(), ...r });
    }
    for (const q of queries.slice(0, 8)) {
      const at = Date.now();
      const r = await deepLink(page, q);
      rows.push({ round, query: q, kind: "deepLink", ms: r.navMs, at, end: Date.now(), ...r });
    }
    await ctx.close();
    log(tag, "round", round, "done");
  }
  const summary = {};
  for (const kind of ["topbar", "runsEnter", "deepLink"]) {
    // Round 0 = every query novel to the server; later rounds repeat (the hub's response cache may answer).
    summary[`${kind}.novel`] = stats(rows.filter((r) => r.kind === kind && r.round === 0).map((r) => r.ms));
    if (rounds > 1) summary[`${kind}.repeat`] = stats(rows.filter((r) => r.kind === kind && r.round > 0).map((r) => r.ms));
  }
  // The Runs filter's complete answer (count and stats), which may follow a first page.
  summary["runsComplete.novel"] = stats(rows.filter((r) => r.kind === "runsEnter" && r.round === 0).map((r) => r.completeMs));
  return { rows, summary };
}

async function condFresh(plan) {
  const out = [];
  for (const q of ["you're absolutely right", "let me", "codex stop button"]) {
    resetCache();
    const { readyMs, t0 } = await startHub();
    const ctx = await newContext();
    const page = await newPage(ctx);
    const tl = performance.now();
    await page.goto(`${base()}/sessions`, { waitUntil: "load", timeout: 180000 });
    const pageLoadMs = Math.round(performance.now() - tl);
    const r = await topbarQuery(page, q);
    out.push({ query: q, readyMs, pageLoadMs, firstSearchMs: r.lastKeyMs, serverMs: r.serverMs, spawnToResultsMs: Math.round(performance.now() - t0) });
    log("fresh", JSON.stringify(out.at(-1)));
    await ctx.close();
    await stopHub();
  }
  return { rows: out, firstSearch: stats(out.map((r) => r.firstSearchMs)) };
}

async function settle(pid, maxMs = 300000) {
  // Settled: 30 s in a row (six 5 s windows) under 5% CPU, or maxMs; a deferred
  // index write (30 s after the last change) falls inside that wait.
  const t0 = performance.now();
  let calm = 0;
  while (performance.now() - t0 < maxMs) {
    const { cpuPct } = await cpuOver(pid, 5000);
    calm = cpuPct < 5 ? calm + 1 : 0;
    if (calm >= 6) break;
  }
  return Math.round(performance.now() - t0);
}

function startWriter(mode, args) {
  const p = spawn("node", [join(HERE, "writer.mjs"), mode, join(RUN, "plan.json"), ...args], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  p.stdout.on("data", (d) => { out += d; });
  return { stop: async () => { p.kill("SIGTERM"); await new Promise((r) => p.once("exit", r)); return out.trim(); }, done: new Promise((r) => p.once("exit", () => r(out.trim()))) };
}

/**
 * Sessions tracequest discovers in `home` (all sources, imported hosts
 * included) and their unique identities: source plus session file name or
 * OpenCode id, so one session imported from two machines counts once.
 */
function discovered(home) {
  const code = `const m = await import(${JSON.stringify(join(BUILD, "src/sessions.js"))}); const s = m.findSessions(null); const by = {}; const ids = new Set(); for (const x of s) { const k = (x.source || "claude") + (x.host ? "@" + x.host : ""); by[k] = (by[k] || 0) + 1; ids.add((x.source || "claude") + ":" + String(x.file || x.path).split("/").filter(Boolean).pop()); } console.log(JSON.stringify({ n: s.length, unique: ids.size, by }));`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { cwd: RUN_CWD, env: { ...env(), HOME: home }, encoding: "utf8" });
  try { return JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { return null; }
}

function countDiscovered() {
  const copied = discovered(CORPUS);
  const timed = discovered(HOME);
  results.corpusBySource = timed?.by;
  results.corpusIdentity = {
    copied: copied && { sessions: copied.n, unique: copied.unique },
    heldOut: { new: NEW_HELD, pull: PULL_HELD, active: 8 },
    timed: timed && { sessions: timed.n, unique: timed.unique },
  };
  return timed?.n ?? null;
}

// ---------------------------------------------------------------- main
const plan = prepare();
results.corpusSessions = countDiscovered();
results.plan = { active: plan.active.length, newSessions: plan.newSessions.length, pull: plan.pull.length };
const save = () => {
  writeFileSync(join(RUN, opt.out), JSON.stringify(results, null, 1));
};
try {
  restoreCorpus(plan);
  if (ONLY.has("cli")) { log("== cli warm"); results.conditions.cliWarm = await condCli(); save(); }
  if (ONLY.has("cli-first")) { log("== cli first search"); results.conditions.cliFirst = condCliFirst(); save(); }
  if (ONLY.has("cli-changed")) { log("== cli after changes"); results.conditions.cliChanged = await condCliChanged(plan); save(); }
  if (ONLY.has("cli-cold")) { log("== cli empty cache"); results.conditions.cliCold = condCliCold(); save(); }
  const needBrowser = ["fresh", "ui", "idle", "indexing", "pull"].some((c) => ONLY.has(c));
  if (needBrowser) await openBrowser();
  if (ONLY.has("fresh")) { log("== fresh hub start"); results.conditions.freshHub = await condFresh(plan); save(); }
  if (["ui", "idle", "indexing", "pull"].some((c) => ONLY.has(c))) {
    resetCache();
    const { readyMs } = await startHub();
    results.hubReadyMs = readyMs;
    const settledMs = await settle(hub.pid);
    results.hubSettleMs = settledMs;
    if (ONLY.has("idle")) {
      log("== idle cpu");
      results.conditions.idle = await cpuOver(hub.pid, 60000);
      log("idle", JSON.stringify(results.conditions.idle));
      save();
    }
    if (ONLY.has("ui")) { log("== ui warm"); results.conditions.uiWarm = await uiRounds(allQueries, ROUNDS, "ui"); save(); }
    if (ONLY.has("indexing")) {
      log("== ui while agents write");
      // The resident CLI search runs first, so it keeps up with the writes too.
      cli(["search", "warm up", "--limit", "10"]);
      await waitResidentSearch();
      const from = Date.now();
      const w = startWriter("live", ["500", "5000"]);
      await sleep(10000);
      const cpu = cpuOver(hub.pid, 20000);
      const r = await uiRounds(liveQueries, 1, "indexing");
      r.hubCpuDuring = await cpu;
      const cliRows = cliRowsFor(liveQueries);
      r.cli = { rows: cliRows, search: stats(cliRows.map((x) => x.ms)) };
      r.resident = residentResources();
      r.writer = await w.stop();
      const to = Date.now();
      r.overlap = { ui: overlap(r.rows, from, to), cli: overlap(cliRows, from, to) };
      results.conditions.uiIndexing = r;
      save();
      restoreCorpus(plan);
      await settle(hub.pid);
    }
    if (ONLY.has("pull")) {
      log("== ui and cli during a host pull");
      cli(["search", "warm up", "--limit", "10"]);
      await waitResidentSearch();
      const from = Date.now();
      const w = startWriter("pull", [String(PULL_MS)]);
      await sleep(2000);
      const r = await uiRounds(liveQueries, 1, "pull");
      const cliRows = cliRowsFor(liveQueries);
      r.cli = { rows: cliRows, search: stats(cliRows.map((x) => x.ms)) };
      const lastQuery = Date.now();
      r.writer = await w.done;
      const to = Date.now();
      // Every timed query must have run while sessions were still arriving.
      r.overlap = { ui: overlap(r.rows, from, to), cli: overlap(cliRows, from, to), lastQuery, pullEnd: to, queriesInsidePull: lastQuery < to - 1000 };
      results.conditions.uiPull = r;
      save();
      restoreCorpus(plan);
    }
    if (ONLY.has("idle")) {
      await settle(hub.pid);
      results.conditions.idleAfter = await cpuOver(hub.pid, 60000);
      log("idle after", JSON.stringify(results.conditions.idleAfter));
    }
    await stopHub();
  }
} finally {
  stopResidentSearch();
  await stopHub();
  if (browser) await browser.close();
  restoreCorpus(plan);
  results.finishedAt = new Date().toISOString();
  save();
  log("results:", join(RUN, opt.out));
}
