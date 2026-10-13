/**
 * Hub stability, end to end: a real `tracequest serve` child process against a
 * temp HOME, with sidecars that hang, time out, or log their invocations
 * (facts hsa1-hsa4, hsf1, hnr2, hrd1-hrd3, hrd5, sidx2 in session-stability.facts).
 */
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_MODEL, mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { claudeProjectDir } from "../../src/sessions/session-layout.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const REAL_SIDECAR = join(ROOT, "sidecar/target/release/tracequest-sidecar");

const children = [];
const temps = [];

afterEach(async () => {
  while (children.length) await stop(children.pop());
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

function claudeLines(id, prompt, reply) {
  return [
    { type: "user", sessionId: id, cwd: "/home/dev/stability", timestamp: "2026-06-03T12:00:00.000Z", uuid: `u-${id}`, message: { content: [{ type: "text", text: prompt }] } },
    { type: "assistant", sessionId: id, timestamp: "2026-06-03T12:00:01.000Z", uuid: `a-${id}`, message: { model: CLAUDE_FIXTURE_MODEL, content: [{ type: "text", text: reply }] } },
  ];
}

function seedHome() {
  const home = mkTmp("tq-hub-stability-");
  temps.push(home);
  const alpha = join(home, ".claude", "projects", "-home-dev-alpha", "alpha-session.jsonl");
  const beta = join(home, ".claude", "projects", "-home-dev-beta", "beta-session.jsonl");
  writeJsonl(alpha, claudeLines("alpha-session", "alpha prompt", "alpha reply"));
  writeJsonl(beta, claudeLines("beta-session", "beta prompt", "beta reply"));
  return { home, alpha, beta };
}

/** A sidecar that records its pid and never answers (stdin stays unread, like the deadlock). */
function hangingSidecar(dir) {
  const bin = join(dir, "tracequest-sidecar");
  const pids = join(dir, "pids.log");
  writeFileSync(bin, `#!${NODE}\nrequire("fs").appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\nsetTimeout(() => process.exit(0), 30000);\n`, { mode: 0o755 });
  return { bin, pids };
}

/** The real sidecar behind a wrapper that logs each invocation's op. */
function loggingSidecar(dir) {
  const bin = join(dir, "tracequest-sidecar");
  const log = join(dir, "calls.log");
  writeFileSync(bin, `#!/bin/sh\necho "$1" >> ${JSON.stringify(log)}\nexec ${JSON.stringify(REAL_SIDECAR)} "$@"\n`, { mode: 0o755 });
  return { bin, log };
}

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function get(port, path, timeoutMs = 60_000) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, ms: performance.now() - t0 }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${path}`)));
    req.on("error", reject);
  });
}

async function startServe(home, env = {}, { bin = BIN, args = [] } = {}) {
  const port = await freePort();
  const child = spawn(NODE, [bin, "serve", "--port", String(port), ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_LIVE_SESSIONS_HOME: home,
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_SKIP_LR_WATCH: "1",
      ...env,
    },
  });
  child.out = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => { child.out += c; });
  child.stderr.on("data", (c) => { child.out += c; });
  children.push(child);
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode != null) throw new Error(`serve exited early:\n${child.out}`);
    try {
      await get(port, "/__tq_probe_404", 2_000);
      return { port, child };
    } catch {
      if (Date.now() > deadline) throw new Error(`serve never listened:\n${child.out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function stop(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
}

function pidsOf(file) {
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number) : [];
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function count(text, re) {
  return (text.match(re) || []).length;
}


/** A key that appears bare (as an api_key value) and also inside a longer planted key. */
const NESTED = Buffer.from("nested-planted-key-0042").toString("base64url");

/** Secret-shaped values planted in a big recording: dozens of distinct high-entropy keys, one holding NESTED. */
const PLANTED = [
  ...Array.from({ length: 60 }, (_, k) => `sk-${"Q7xZ".repeat(2)}${k}${Buffer.from(`planted-secret-${k}-for-hub-redaction`).toString("base64url")}`),
  `sk-${NESTED}Zq9XwV`,
];

/** Every secret string the big recording holds; none may survive hub redaction. */
const SECRETS = [...PLANTED, NESTED];

/**
 * A claude recording of at least `mb` MB whose turns repeat the planted
 * secrets; every third reply holds none.
 */
function writeBigRecording(home, mb) {
  const file = join(home, ".claude", "projects", "-home-dev-big", "big-session.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const filler = "Ran the build and the tests — every module compiled and nothing else changed. ".repeat(40);
  const lines = [];
  let bytes = 0;
  for (let i = 0; bytes < mb * 1024 * 1024; i++) {
    const secret = PLANTED[i % PLANTED.length];
    const prompt = `turn ${i}: export OPENAI_KEY=${secret}${i % 5 === 0 ? ` and api_key: ${NESTED}` : ""}`;
    const [user, assistant] = claudeLines("big-session", prompt, i % 3 === 0 ? filler : `${filler} key ${secret}`);
    user.uuid = `u-big-${i}`;
    assistant.uuid = `a-big-${i}`;
    for (const entry of [user, assistant]) {
      const line = JSON.stringify(entry);
      lines.push(line);
      bytes += line.length + 1;
    }
  }
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

describe("hub stability (serve end to end)", () => {
  test("hung sidecar: unrelated requests still answer while a sidecar never exits", async () => {
    const { home, alpha } = seedHome();
    const { bin, pids } = hangingSidecar(home);
    const { port } = await startServe(home, { TRACEQUEST_SIDECAR_PATH: bin, TRACEQUEST_SIDECAR_TIMEOUT_MS: "20000" });
    const pending = get(port, "/api/sessions").catch(() => null);
    const deadline = Date.now() + 5_000;
    while (!pidsOf(pids).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(pidsOf(pids).length > 0, "the sidecar was started");
    for (let i = 0; i < 5; i++) {
      const probe = await get(port, "/__tq_probe_404");
      assert.equal(probe.status, 404);
      assert.ok(probe.ms < 500, `probe answered in ${probe.ms.toFixed(0)}ms while the sidecar hangs`);
    }
    const view = await get(port, `/api/view-session?path=${encodeURIComponent(alpha)}`);
    assert.equal(view.status, 200);
    assert.ok(view.ms < 500, `session data answered in ${view.ms.toFixed(0)}ms while the sidecar hangs`);
    assert.ok(pidsOf(pids).some(alive), "the sidecar is still running during the probes");
    void pending;
  });


  test("redaction off-thread: a large hub /raw never blocks other requests and leaks nothing", async () => {
    const { home, alpha } = seedHome();
    const big = writeBigRecording(home, 48);
    const { port } = await startServe(home, { TRACEQUEST_NO_SIDECAR: "1" }, { args: ["--hub"] });
    assert.equal((await get(port, "/api/sessions", 120_000)).status, 200);
    let done = false;
    const raw = get(port, `/raw?path=${encodeURIComponent(big)}&source=claude`, 120_000).finally(() => { done = true; });
    const probes = [];
    while (!done) {
      const probe = await get(port, `/api/view-session?path=${encodeURIComponent(alpha)}&source=claude`);
      assert.equal(probe.status, 200);
      probes.push(probe.ms);
      await new Promise((r) => setTimeout(r, 100));
    }
    const res = await raw;
    assert.equal(res.status, 200);
    assert.ok(probes.length >= 3, `probed ${probes.length} times during the download`);
    const slowest = Math.max(...probes);
    assert.ok(slowest < 500, `every request answered within 500 ms during the redaction (slowest ${slowest.toFixed(0)} ms)`);
    assert.ok(res.ms < 6_000, `the redacted ${(res.body.length / 1048576).toFixed(0)} MB download arrived within 6 s (took ${res.ms.toFixed(0)} ms)`);
    for (const secret of SECRETS) assert.ok(!res.body.includes(secret), `secret leaked: ${secret}`);
    // Line by line: a line without a secret keeps its exact bytes, a line with
    // one is the same JSON record with each secret (longest first) replaced.
    const want = readFileSync(big, "utf8").split("\n");
    const got = res.body.split("\n");
    assert.equal(got.length, want.length, "one downloaded line per recorded line");
    const longestFirst = [...SECRETS].sort((a, b) => b.length - a.length);
    for (let i = 0; i < want.length; i++) {
      if (!SECRETS.some((s) => want[i].includes(s))) {
        assert.ok(got[i] === want[i], `line ${i + 1} unchanged`);
      } else {
        const masked = longestFirst.reduce((line, s) => line.split(s).join("[REDACTED]"), want[i]);
        assert.deepEqual(JSON.parse(got[i]), JSON.parse(masked), `line ${i + 1} is its JSON record with only the secrets redacted`);
      }
    }
  });

  test("live probe off-thread: a slow pgrep never blocks other requests", async () => {
    const { home } = seedHome();
    const binDir = join(home, "slow-bin");
    mkdirSync(binDir, { recursive: true });
    const calls = join(home, "pgrep.log");
    writeFileSync(join(binDir, "pgrep"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(calls)}\nsleep 0.7\nexit 1\n`, { mode: 0o755 });
    const { port } = await startServe(home, { TRACEQUEST_NO_SIDECAR: "1", PATH: `${binDir}:${process.env.PATH}` });
    const pending = get(port, "/api/sessions");
    const deadline = Date.now() + 10_000;
    while (!existsSync(calls) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(calls), "the slow probe ran");
    for (let i = 0; i < 6; i++) {
      const probe = await get(port, "/__tq_probe_404");
      assert.ok(probe.ms < 500, `probe answered in ${probe.ms.toFixed(0)}ms while pgrep is slow`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).total, 2);
  });

  /** SSE payloads from /__livereload until `ms` elapse. */
  function collectSse(port, ms) {
    return new Promise((resolve, reject) => {
      const seen = [];
      const req = http.get(`http://127.0.0.1:${port}/__livereload`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (c) => { for (const m of c.matchAll(/data: (\S+)/g)) seen.push(m[1]); });
      });
      req.on("error", reject);
      setTimeout(() => { req.destroy(); resolve(seen); }, ms);
    });
  }

  for (const hub of [true, false]) {
    test(`hub never hot-reloads from its own src (${hub ? "hub" : "non-hub control"})`, async () => {
      const { home, alpha } = seedHome();
      // A private copy of the checkout, so editing its src/ touches nothing real.
      const checkout = join(home, "checkout");
      for (const dir of ["bin", "src", "data", "presets"]) {
        if (existsSync(join(ROOT, dir))) cpSync(join(ROOT, dir), join(checkout, dir), { recursive: true });
      }
      cpSync(join(ROOT, "package.json"), join(checkout, "package.json"));
      const { port } = await startServe(home, { TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "" }, {
        bin: join(checkout, "bin", "tracequest.js"),
        args: hub ? ["--hub"] : [],
      });
      const sse = collectSse(port, 7_000);
      await new Promise((r) => setTimeout(r, 500));
      writeFileSync(join(checkout, "src", "render", "hot-edit-probe.js"), "export const probe = 1;\n");
      appendFileSync(alpha, JSON.stringify(claudeLines("alpha-session", "alpha more", "alpha more reply")[0]) + "\n");
      const seen = await sse;
      assert.ok(seen.includes("data-update"), `data roots still watched: ${seen.join(",")}`);
      if (hub) assert.ok(!seen.includes("reload"), `no reload from a src edit in hub mode: ${seen.join(",")}`);
      else assert.ok(seen.includes("reload"), `a non-hub serve keeps source hot-reload: ${seen.join(",")}`);
    });
  }

  test("session parse off-thread: opening a large recording never blocks other requests", async () => {
    const { home, alpha } = seedHome();
    const big = writeBigRecording(home, 48);
    const { port } = await startServe(home, { TRACEQUEST_NO_SIDECAR: "1" }, { args: ["--hub"] });
    assert.equal((await get(port, "/api/sessions", 120_000)).status, 200);
    const open = (route, file = big) => `/${route}?path=${encodeURIComponent(file)}&source=claude`;
    const compare = `/compare?a=${encodeURIComponent(big)}&b=${encodeURIComponent(alpha)}`;
    // One open of each route, then two of the page at once.
    for (const opens of [[open("view")], [open("api/view-session")], [open("export")], [open("markdown")], [compare], [open("view"), open("view")]]) {
      let done = false;
      const all = Promise.all(opens.map((p) => get(port, p, 120_000))).finally(() => { done = true; });
      const probes = [];
      while (!done) {
        probes.push((await get(port, "/__tq_probe_404")).ms);
        await new Promise((r) => setTimeout(r, 10));
      }
      for (const res of await all) assert.equal(res.status, 200, opens[0]);
      assert.ok(probes.length >= 3, `probed ${probes.length} times while ${opens.length} x ${opens[0].split("?")[0]} opened`);
      const slowest = Math.max(...probes);
      assert.ok(slowest < 150, `every request answered within 150 ms while ${opens.length} x ${opens[0].split("?")[0]} opened (slowest ${slowest.toFixed(0)} ms)`);
    }
    // The worker answers what the parse holds: every recorded turn, redacted.
    const data = await get(port, open("api/view-session"), 120_000);
    const lines = readFileSync(big, "utf8").split("\n").filter(Boolean).length;
    const { etag, session } = JSON.parse(data.body);
    assert.match(etag, /^\d+-\d+$/);
    assert.equal(session.events.length, lines, "one event per recorded line");
    for (const secret of SECRETS) assert.ok(!data.body.includes(secret), `secret leaked: ${secret}`);
    const md = await get(port, open("markdown", alpha));
    assert.equal(md.status, 200);
    assert.match(md.body, /alpha prompt/);
    const page = await get(port, open("view", alpha));
    assert.match(page.body, /alpha reply/);
    assert.match(page.body, /data-tq-hub="readonly"/);
    // Handles are still resolved before any parse; a parse that throws is a 500.
    assert.equal((await get(port, "/markdown?id=ffffffff")).status, 404);
    assert.equal((await get(port, `/markdown?path=${encodeURIComponent(join(home, "notes.jsonl"))}`)).status, 403);
    if (process.getuid?.() !== 0) {
      const locked = join(home, ".claude", "projects", "-home-dev-locked", "locked-session.jsonl");
      writeJsonl(locked, claudeLines("locked-session", "locked prompt", "locked reply"));
      chmodSync(locked, 0o000);
      const failed = await get(port, open("markdown", locked));
      assert.equal(failed.status, 500);
      chmodSync(locked, 0o644);
    }
  });

});
