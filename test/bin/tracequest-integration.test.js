/**
 * Automated harness for tests/integration.md — 16 core CLI integration scenarios.
 * Real bin/tracequest.js invocations; temp dirs; HOME override; TRACEQUEST_NO_SIDECAR=1.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
  mkTmp,
  writeClaudeJsonl,
} from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];

afterEach(() => {
  for (const child of serveChildren) {
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  serveChildren.length = 0;
});

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sortedStdoutLines(stdout) {
  return stripAnsi(stdout)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .sort();
}

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_TMUX: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
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
        reject(
          new Error(
            `bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function minimalClaudeSession(sessionId, { prompt = "integration prompt", model = CLAUDE_FIXTURE_MODEL } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: {
        model,
        content: [{ type: "text", text: "integration assistant reply" }],
      },
    },
  ];
}

function seedClaudeProject(home, projectName, fileName, lines) {
  const dir = join(home, ".claude", "projects", projectName);
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, fileName, lines);
}

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
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

async function waitForHttpOk(port, reqPath, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
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

function spawnServe(port, home) {
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_SKIP_LR_WATCH: "1",
    },
  });
  serveChildren.push(child);
  return child;
}

function waitForChildExit(child, { timeoutMs = 5_000 } = {}) {
  if (child.exitCode != null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopServe(child) {
  if (child.exitCode == null && !child.killed) {
    child.kill("SIGKILL");
  }
  await waitForChildExit(child, { timeoutMs: 2_000 });
}

function rmHomeDir(home) {
  try {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    /* worker threads may still flush index files under HOME */
  }
}

describe("tests/integration.md harness", () => {
  test("Test 1: CLI help documents core commands", async () => {
    const { stdout } = await runBin(["--help"]);
    const visible = stripAnsi(stdout);
    assert.match(visible, /tracequest/);
    assert.match(visible, /Commands:/);
    for (const cmd of ["render", "messages", "list", "find", "search", "latest", "share", "serve", "presets"]) {
      assert.match(visible, new RegExp(`\\b${cmd}\\b`));
    }
    assert.match(visible, /-h, --help/);
    assert.match(visible, /-v, --version/);
  });

  test("Test 2: CLI version prints package.json semver", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const { stdout } = await runBin(["--version"]);
    assert.equal(stdout.trim(), pkg.version);
  });

  test("Test 3: render produces self-contained HTML from a session file", async () => {
    const dir = mkTmp("tracequest-integration-render-");
    const jsonl = join(dir, "render-session.jsonl");
    const out = join(dir, "render-out.html");
    writeClaudeJsonl(dir, "render-session.jsonl", minimalClaudeSession("int-render-1"));
    try {
      const { stdout } = await runBin(["render", jsonl, "--out", out]);
      assert.match(stdout, /Written:/);
      assert.match(stdout, new RegExp(out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.ok(existsSync(out), "render output HTML should exist");
      const html = readFileSync(out, "utf8");
      assert.ok(html.length > 0, "render output HTML should be non-empty");
      assert.match(html, /<html/i);
      assert.match(html, /SESSION\s*=/);
      assert.match(html, /<style/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 4: messages exports valid Anthropic-format JSON", async () => {
    const dir = mkTmp("tracequest-integration-messages-");
    const jsonl = join(dir, "render-session.jsonl");
    writeClaudeJsonl(dir, "render-session.jsonl", minimalClaudeSession("int-messages-1"));
    try {
      const { stdout, stderr } = await runBin(["messages", jsonl]);
      assert.match(stderr, /Parsing session/);
      const result = JSON.parse(stdout);
      assert.ok(Array.isArray(result.messages));
      assert.ok(result.messages.length >= 2);
      assert.equal(result.messages[0].role, "user");
      assert.equal(result.messages[1].role, "assistant");
      assert.ok(Array.isArray(result.messages[0].content));
      assert.equal(result.messages[0].content[0].type, "text");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 5: list discovers seeded sessions under HOME override", async () => {
    const home = mkTmp("tracequest-integration-home-list-");
    const sessionPath = seedClaudeProject(
      home,
      "integration-smoke",
      "smoke-session.jsonl",
      minimalClaudeSession("int-smoke-1"),
    );
    try {
      const { stdout } = await runBin(["list", "integration-smoke"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found \d+ session/);
      assert.match(visible, /integration-smoke/);
      assert.match(visible, new RegExp(sessionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(visible, /claude/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 6: find filters sessions by model expression", async () => {
    const home = mkTmp("tracequest-integration-home-find-");
    seedClaudeProject(
      home,
      "integration-sonnet",
      "sonnet-session.jsonl",
      minimalClaudeSession("int-sonnet-1", { model: "claude-sonnet-4-20250514" }),
    );
    seedClaudeProject(
      home,
      "integration-opus",
      "opus-session.jsonl",
      minimalClaudeSession("int-opus-1", { model: "claude-opus-4-20250514" }),
    );
    try {
      const { stdout } = await runBin(["find", "--filter", "model:sonnet"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found \d+ session/);
      assert.match(visible, /integration-sonnet/);
      assert.ok(!visible.includes("integration-opus"), "opus-only project should be excluded");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 7: search matches free-text in session prompts", async () => {
    const home = mkTmp("tracequest-integration-home-search-");
    seedClaudeProject(
      home,
      "integration-search",
      "search-session.jsonl",
      minimalClaudeSession("int-search-1", { prompt: "integration-search-marker-xyz" }),
    );
    try {
      const { stdout } = await runBin(["search", "integration-search-marker-xyz"], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found \d+ result/);
      assert.match(visible, /integration-search/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 8: latest renders the most recent matching session", async () => {
    const home = mkTmp("tracequest-integration-home-latest-");
    const outDir = mkTmp("tracequest-integration-latest-out-");
    const out = join(outDir, "latest-out.html");
    const projectDir = join(home, ".claude", "projects", "integration-latest");
    mkdirSync(projectDir, { recursive: true });
    const olderPath = writeClaudeJsonl(
      projectDir,
      "older-session.jsonl",
      minimalClaudeSession("int-latest-old"),
    );
    const newerPath = writeClaudeJsonl(
      projectDir,
      "newer-session.jsonl",
      minimalClaudeSession("int-latest-new"),
    );
    const now = Date.now() / 1000;
    utimesSync(olderPath, now - 3600, now - 3600);
    utimesSync(newerPath, now, now);
    try {
      const { stdout } = await runBin(
        ["latest", "integration-latest", "--out", out],
        { env: { HOME: home } },
      );
      const visible = stripAnsi(stdout);
      assert.match(visible, /Written:/);
      assert.match(visible, /newer-session\.jsonl/);
      assert.ok(existsSync(out), "latest --out should create HTML file");
      const html = readFileSync(out, "utf8");
      assert.match(html, /int-latest-new/);
      assert.ok(!html.includes("int-latest-old"), "older session id should not appear in rendered HTML");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  test("Test 9: serve starts HTTP server and serves the browser shell", async () => {
    const home = mkTmp("tracequest-integration-home-serve-");
    seedClaudeProject(
      home,
      "integration-smoke",
      "smoke-session.jsonl",
      minimalClaudeSession("int-serve-1"),
    );
    const port = await allocEphemeralPort();
    const child = spawnServe(port, home);
    try {
      assert.equal(child.exitCode, null, "serve should stay running until stopped");
      const rootRes = await waitForHttpOk(port, "/");
      assert.match(rootRes.body, /tracequest/i);
      const apiRes = await waitForHttpOk(port, "/api/sessions");
      const payload = JSON.parse(apiRes.body);
      assert.ok(Array.isArray(payload.sessions));
      assert.ok(payload.sessions.length >= 1);
      const first = payload.sessions[0];
      assert.ok("source" in first);
      assert.ok("project" in first);
      assert.ok("path" in first);
    } finally {
      await stopServe(child);
      await new Promise((r) => setTimeout(r, 150));
      rmHomeDir(home);
    }
  });

  test("Test 10: presets lists built-in default and local configurations", async () => {
    const presets = await runBin(["presets"]);
    const preset = await runBin(["preset"]);
    const visible = stripAnsi(presets.stdout);
    assert.match(visible, /Built-in presets/);
    assert.match(visible, /\bdefault\b/);
    assert.match(visible, /\blocal\b/);
    assert.match(visible, /\b7777\b/);
    assert.match(visible, /\b8888\b/);
    assert.deepEqual(
      sortedStdoutLines(preset.stdout),
      sortedStdoutLines(presets.stdout),
    );
  });

  test("Test 11: invalid inputs fail with clear CLI errors (no stack traces)", async () => {
    const cases = [
      { args: ["render"], label: "render without path" },
      { args: ["not-a-command"], label: "unknown command" },
      { args: ["serve", "--port", "0"], label: "serve invalid port" },
    ];
    for (const { args, label } of cases) {
      const { stderr, stdout } = await runBin(args, { expectCode: 1 });
      assert.equal(stdout, "", `${label}: stdout should be empty`);
      assert.match(stderr, /Error:/, `${label}: stderr should contain Error:`);
      assert.ok(!stderr.includes("node:internal"), `${label}: stderr should not contain node:internal stack trace`);
    }
  });

  test("Test 12: render missing file reports file-not-found", async () => {
    const missing = "/tmp/tracequest-nonexistent-session-12345.jsonl";
    const { stderr, stdout } = await runBin(["render", missing], { expectCode: 1 });
    assert.equal(stdout, "");
    assert.match(stderr, /Error: File not found/);
  });

  test("Test 13: find compound AND expression narrows to matching sessions", async () => {
    const home = mkTmp("tracequest-integration-home-find-and-");
    seedClaudeProject(
      home,
      "expr-compound-alpha",
      "alpha-sonnet.jsonl",
      minimalClaudeSession("int-and-sonnet-alpha", { model: "claude-sonnet-4-20250514" }),
    );
    seedClaudeProject(
      home,
      "expr-compound-alpha",
      "alpha-opus.jsonl",
      minimalClaudeSession("int-and-opus-alpha", { model: "claude-opus-4-20250514" }),
    );
    seedClaudeProject(
      home,
      "expr-compound-beta",
      "beta-sonnet.jsonl",
      minimalClaudeSession("int-and-sonnet-beta", { model: "claude-sonnet-4-20250514" }),
    );
    try {
      const { stdout } = await runBin(
        ["find", "--filter", "project:expr-compound-alpha AND model:sonnet"],
        { env: { HOME: home } },
      );
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 session/);
      assert.match(visible, /expr-compound-alpha/);
      assert.match(visible, /alpha-sonnet\.jsonl/);
      assert.ok(!visible.includes("alpha-opus.jsonl"), "opus in alpha should be excluded by model");
      assert.ok(!visible.includes("expr-compound-beta"), "beta sonnet should be excluded by project");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 13b: find positional and --filter expressions combine with AND", async () => {
    const home = mkTmp("tracequest-integration-home-find-pos-filter-");
    seedClaudeProject(
      home,
      "expr-pos-filter-alpha",
      "alpha-sonnet.jsonl",
      minimalClaudeSession("int-pos-filter-alpha-sonnet", { model: "claude-sonnet-4-20250514" }),
    );
    seedClaudeProject(
      home,
      "expr-pos-filter-alpha",
      "alpha-opus.jsonl",
      minimalClaudeSession("int-pos-filter-alpha-opus", { model: "claude-opus-4-20250514" }),
    );
    seedClaudeProject(
      home,
      "expr-pos-filter-beta",
      "beta-sonnet.jsonl",
      minimalClaudeSession("int-pos-filter-beta-sonnet", { model: "claude-sonnet-4-20250514" }),
    );
    try {
      const { stdout } = await runBin(
        ["find", "project:expr-pos-filter-alpha", "--filter", "model:sonnet"],
        { env: { HOME: home } },
      );
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 session/);
      assert.match(visible, /expr-pos-filter-alpha/);
      assert.match(visible, /alpha-sonnet\.jsonl/);
      assert.ok(!visible.includes("alpha-opus.jsonl"), "alpha opus should be excluded by --filter");
      assert.ok(!visible.includes("expr-pos-filter-beta"), "beta sonnet should be excluded by positional expression");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 14: find OR expression matches either branch", async () => {
    const home = mkTmp("tracequest-integration-home-find-or-");
    seedClaudeProject(
      home,
      "expr-or-mix",
      "sonnet.jsonl",
      minimalClaudeSession("int-or-sonnet", { model: "claude-sonnet-4-20250514" }),
    );
    seedClaudeProject(
      home,
      "expr-or-mix",
      "opus.jsonl",
      minimalClaudeSession("int-or-opus", { model: "claude-opus-4-20250514" }),
    );
    seedClaudeProject(
      home,
      "expr-or-mix",
      "haiku.jsonl",
      minimalClaudeSession("int-or-haiku", { model: "claude-haiku-3-20250514" }),
    );
    try {
      const { stdout } = await runBin(
        ["find", "--filter", "model:sonnet OR model:opus"],
        { env: { HOME: home } },
      );
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 2 session/);
      assert.match(visible, /sonnet\.jsonl/);
      assert.match(visible, /opus\.jsonl/);
      assert.ok(!visible.includes("haiku.jsonl"), "haiku should be excluded by OR expression");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 15: latest --filter picks newest matching session", async () => {
    const home = mkTmp("tracequest-integration-home-latest-expr-");
    const outDir = mkTmp("tracequest-integration-latest-expr-out-");
    const out = join(outDir, "latest-expr-out.html");
    const projectDir = join(home, ".claude", "projects", "integration-latest-expr");
    mkdirSync(projectDir, { recursive: true });
    const sonnetOldPath = writeClaudeJsonl(
      projectDir,
      "sonnet-old.jsonl",
      minimalClaudeSession("int-latest-expr-sonnet-old", { model: "claude-sonnet-4-20250514" }),
    );
    const sonnetNewPath = writeClaudeJsonl(
      projectDir,
      "sonnet-new.jsonl",
      minimalClaudeSession("int-latest-expr-sonnet-new", { model: "claude-sonnet-4-20250514" }),
    );
    const opusNewestPath = writeClaudeJsonl(
      projectDir,
      "opus-newest.jsonl",
      minimalClaudeSession("int-latest-expr-opus-newest", { model: "claude-opus-4-20250514" }),
    );
    const now = Date.now() / 1000;
    utimesSync(sonnetOldPath, now - 7200, now - 7200);
    utimesSync(sonnetNewPath, now - 3600, now - 3600);
    utimesSync(opusNewestPath, now, now);
    try {
      const { stdout } = await runBin(
        ["latest", "--filter", "model:sonnet", "--out", out],
        { env: { HOME: home } },
      );
      const visible = stripAnsi(stdout);
      assert.match(visible, /Latest: [0-9a-f]{8} sonnet-new\.jsonl/);
      assert.ok(existsSync(out), "latest --filter --out should create HTML file");
      const html = readFileSync(out, "utf8");
      assert.match(html, /int-latest-expr-sonnet-new/);
      assert.ok(!html.includes("int-latest-expr-sonnet-old"), "older sonnet should not be rendered");
      assert.ok(!html.includes("int-latest-expr-opus-newest"), "newer opus should not win over matching sonnet");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
