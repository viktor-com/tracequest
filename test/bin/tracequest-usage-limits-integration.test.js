/**
 * Automated harness for tests/usage-limits-integration.md.
 * Local node:http fixtures; never real network or real credentials.
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import {
  CLAUDE_USAGE_BODY,
  startJsonFixture,
  writeClaudeCreds,
} from "../usage/helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== expectCode) {
        reject(new Error(`bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function seedClaudeTree(root, host) {
  const dir = join(root, host, ".claude", "projects", "myproj");
  mkdirSync(dir, { recursive: true });
  writeJsonl(join(dir, "sess.jsonl"), [
    { type: "user", message: { content: [{ type: "text", text: "hi" }] } },
  ]);
}

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
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

async function waitForHttp(port, reqPath, child, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) throw new Error(`serve exited ${child.exitCode}`);
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === 200) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw lastErr ?? new Error(`timeout ${reqPath}`);
}

test("limits help lists usage and options", async () => {
  const { stdout } = await runBin(["limits", "-h"]);
  const text = stripAnsi(stdout);
  assert.match(text, /limits/);
  assert.match(text, /--json/);
  assert.match(text, /--host/);
});

test("limits command is listed in top-level help", async () => {
  const { stdout } = await runBin(["--help"]);
  assert.match(stripAnsi(stdout), /limits/);
});

test("limits empty exits 0", async () => {
  const home = mkTmp("tq-ul-empty-");
  try {
    const { code, stdout } = await runBin(["limits"], { env: { HOME: home } });
    assert.equal(code, 0);
    assert.match(stripAnsi(stdout), /claude\s+missing/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("limits human and limits --json", async () => {
  const home = mkTmp("tq-ul-json-");
  const fx = await startJsonFixture({ "/api/oauth/usage": { body: CLAUDE_USAGE_BODY } });
  try {
    writeClaudeCreds(home, "sk-ant-cli-token-never-print");
    const env = {
      HOME: home,
      TRACEQUEST_CLAUDE_USAGE_URL: `${fx.baseUrl}/api/oauth/usage`,
      TRACEQUEST_CODEX_USAGE_URL: `${fx.baseUrl}/missing`,
      TRACEQUEST_GROK_USAGE_URL: `${fx.baseUrl}/missing`,
      TRACEQUEST_CURSOR_API2_URL: fx.baseUrl,
      TRACEQUEST_CURSOR_STATE_DB: join(home, "missing.vscdb"),
    };
    const human = await runBin(["limits"], { env });
    assert.match(stripAnsi(human.stdout), /claude\s+default_claude_max_20x/);
    assert.match(stripAnsi(human.stdout), /25%/);
    assert.doesNotMatch(human.stdout + human.stderr, /sk-ant-cli-token-never-print/);
    const json = await runBin(["limits", "--json"], { env });
    const snap = JSON.parse(json.stdout);
    const claude = snap.harnesses.find((h) => h.id === "claude");
    assert.equal(claude.status, "ok");
    assert.equal(claude.windows[0].utilization, 0.25);
    assert.doesNotMatch(json.stdout, /sk-ant-cli-token-never-print/);
  } finally {
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("limits --host reads the imported snapshot", async () => {
  const home = mkTmp("tq-ul-host-");
  const hostsRoot = join(home, "hosts-root");
  try {
    mkdirSync(join(hostsRoot, "gpu", ".tracequest"), { recursive: true });
    writeFileSync(join(hostsRoot, "gpu", ".tracequest", "usage-limits.json"), JSON.stringify({
      collectedAt: "2026-09-20T17:00:00.000Z",
      host: "gpu",
      harnesses: [{ id: "claude", status: "ok", plan: "max", windows: [{ id: "five_hour", utilization: 0.5, resetsAt: "2026-09-20T21:00:00.000Z" }] }],
    }));
    const { stdout } = await runBin(["limits", "--host", "gpu", "--json"], {
      env: { HOME: home, TRACEQUEST_HOSTS_DIR: hostsRoot },
    });
    const snap = JSON.parse(stdout);
    assert.equal(snap.host, "gpu");
    assert.equal(snap.harnesses[0].windows[0].utilization, 0.5);
    const missing = await runBin(["limits", "--host", "nope"], {
      env: { HOME: home, TRACEQUEST_HOSTS_DIR: hostsRoot },
      expectCode: 1,
    });
    assert.match(stripAnsi(missing.stderr), /import ssh/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("GET /api/usage-limits via serve", async () => {
  const home = mkTmp("tq-ul-api-");
  const fx = await startJsonFixture({ "/api/oauth/usage": { body: CLAUDE_USAGE_BODY } });
  let child;
  try {
    writeClaudeCreds(home, "sk-ant-api-token-never-print");
    const port = await allocEphemeralPort();
    child = spawn(NODE, [BIN, "serve", "--usage-limits", "--port", String(port)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        TRACEQUEST_SKIP_TMUX: "1",
        TRACEQUEST_CLAUDE_USAGE_URL: `${fx.baseUrl}/api/oauth/usage`,
        TRACEQUEST_CURSOR_STATE_DB: join(home, "missing.vscdb"),
      },
    });
    await waitForHttp(port, "/", child);
    const res = await httpGet(port, "/api/usage-limits");
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.local);
    assert.ok(Array.isArray(data.hosts));
    const claude = data.local.harnesses.find((h) => h.id === "claude");
    assert.equal(claude.status, "ok");
    assert.doesNotMatch(res.body, /sk-ant-api-token-never-print/);
  } finally {
    if (child && child.exitCode == null) child.kill("SIGKILL");
    await fx.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import ssh writes a usage-limits snapshot", async () => {
  const home = mkTmp("tq-ul-ssh-");
  const fixture = mkTmp("tq-ul-ssh-fix-");
  const fx = await startJsonFixture({ "/api/oauth/usage": { body: CLAUDE_USAGE_BODY } });
  try {
    seedClaudeTree(fixture, "gpu");
    writeClaudeCreds(join(fixture, "gpu"), "sk-ant-ssh-token-never-print");
    const env = {
      HOME: home,
      TRACEQUEST_HOSTS_DIR: join(home, "hosts-root"),
      TRACEQUEST_IMPORT_SSH_FIXTURE: fixture,
      TRACEQUEST_CLAUDE_USAGE_URL: `${fx.baseUrl}/api/oauth/usage`,
      TRACEQUEST_CURSOR_STATE_DB: join(home, "missing.vscdb"),
    };
    const { stdout } = await runBin(["import", "ssh", "gpu"], { env });
    const text = stripAnsi(stdout);
    assert.match(text, /limits gpu claude ok/);
    assert.match(text, /import summary: 6 checked/);
    const snapPath = join(home, "hosts-root", "gpu", ".tracequest", "usage-limits.json");
    assert.equal(existsSync(snapPath), true);
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    assert.equal(snap.host, "gpu");
    assert.doesNotMatch(readFileSync(snapPath, "utf8"), /sk-ant-ssh-token-never-print/);
    assert.doesNotMatch(readFileSync(snapPath, "utf8"), /eyJ[A-Za-z0-9_-]{10,}\./);
  } finally {
    await fx.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("dry-run does not write usage-limits", async () => {
  const home = mkTmp("tq-ul-dry-");
  const fixture = mkTmp("tq-ul-dry-fix-");
  try {
    seedClaudeTree(fixture, "gpu");
    const env = {
      HOME: home,
      TRACEQUEST_HOSTS_DIR: join(home, "hosts-root"),
      TRACEQUEST_IMPORT_SSH_FIXTURE: fixture,
    };
    const { stdout } = await runBin(["import", "ssh", "gpu", "--dry-run"], { env });
    assert.match(stripAnsi(stdout), /limits gpu: collect remaining plan windows/);
    assert.equal(existsSync(join(home, "hosts-root")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("limits skip-with-warning and summary counters unchanged", async () => {
  const home = mkTmp("tq-ul-skip-");
  const fixture = mkTmp("tq-ul-skip-fix-");
  try {
    seedClaudeTree(fixture, "gpu");
    const env = {
      HOME: home,
      TRACEQUEST_HOSTS_DIR: join(home, "hosts-root"),
      TRACEQUEST_IMPORT_SSH_FIXTURE: fixture,
    };
    const { stdout } = await runBin(["import", "ssh", "gpu"], { env });
    const text = stripAnsi(stdout);
    assert.match(text, /skip gpu claude \(no credential\)/);
    assert.match(text, /6 checked/);
    assert.match(text, /0 failed/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
