import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { sessionHash } from "../../src/sessions/session-hash.js";

const BIN = join(process.cwd(), "bin/tracequest.js");

// Safety net: never let a CLI child launch a real browser from tests.
// Individual tests may override TRACEQUEST_OPEN_CMD with a recording stub.
function safeEnv(env) {
  return { TRACEQUEST_OPEN_CMD: "/usr/bin/true", ...env };
}

function run(args, env = process.env) {
  try {
    return execFileSync("node", [BIN, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: safeEnv(env),
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
  } catch (err) {
    err.stdout = err.stdout?.toString?.() || "";
    err.stderr = err.stderr?.toString?.() || "";
    throw err;
  }
}

/** Async CLI runner — required when an in-process mock HTTP server must handle requests. */
function runAsync(args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [BIN, ...args], {
      env: safeEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const err = new Error(`tracequest exited with code ${code}`);
      err.status = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });
  });
}

function minimalClaudeJsonl() {
  const ts = "2026-06-03T12:00:00Z";
  return (
    [
      JSON.stringify({
        type: "user",
        sessionId: "cli-share-test",
        message: { content: "hello share" },
        timestamp: ts,
        uuid: "u1",
        isMeta: false,
      }),
      JSON.stringify({
        type: "assistant",
        message: { model: "m", content: [{ type: "text", text: "ok" }] },
        timestamp: ts,
        uuid: "a1",
      }),
    ].join("\n") + "\n"
  );
}

async function withMockHfServer(fn) {
  const server = createServer((req, res) => {
    const url = req.url || "";
    if (url.includes("/api/whoami-v2")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ name: "testuser" }));
      return;
    }
    if (url.includes("/api/datasets/testuser/tracequest-sessions") && req.method === "GET") {
      res.writeHead(404);
      res.end();
      return;
    }
    if (url.endsWith("/api/repos/create") && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    if (url.includes("/commit/main") && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withMockGistServer(fn) {
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/gists") && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ html_url: "https://gist.github.com/mock-user/abc123", id: "abc123" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("share CLI", () => {
  test("share --help documents flags", () => {
    const out = run(["share", "--help"]);
    assert.ok(out.includes("share"));
    assert.ok(out.includes("--target"));
    assert.ok(out.includes("gist"));
    assert.ok(out.includes("--open"));
    assert.ok(out.includes("--json"));
    assert.ok(out.includes("--private"));
    assert.ok(out.includes("--force"));
    assert.ok(out.includes("--hf-repo"));
    assert.ok(out.includes("gisthost"));
    assert.ok(out.includes("gistUrl"));
  });

  test("share rejects unknown options", () => {
    try {
      run(["share", "/tmp/fake.jsonl", "--not-a-flag"]);
      assert.fail("expected exit 1");
    } catch (err) {
      assert.equal(err.status, 1);
      assert.match(err.stderr, /Unknown option '--not-a-flag'/);
      assert.ok(!err.stderr.includes("node:internal/process"));
    }
  });

  test("share --help documents gisthost url and gistUrl json fields", () => {
    const out = run(["share", "--help"]);
    assert.ok(out.includes("gisthost"));
    assert.ok(out.includes("gistUrl"));
    assert.ok(out.includes("GitHub auth"));
  });

  test("share --json prints gisthost url and gistUrl", async () => {
    await withMockGistServer(async (apiUrl) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tq-share-cli-"));
      const sessionPath = join(tmpDir, "session.jsonl");
      writeFileSync(sessionPath, minimalClaudeJsonl());
      const env = { ...process.env, GITHUB_TOKEN: "fake-token", GITHUB_API_URL: apiUrl };

      const stdout = await runAsync(["share", sessionPath, "--json", "--force"], env);
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.url, `https://gisthost.github.io/?abc123/tracequest-claude-${sessionHash(sessionPath)}.html`);
      assert.equal(parsed.gistUrl, "https://gist.github.com/mock-user/abc123");

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  test("share human output prints gisthost url and dim gist line", async () => {
    await withMockGistServer(async (apiUrl) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tq-share-cli-"));
      const sessionPath = join(tmpDir, "session.jsonl");
      writeFileSync(sessionPath, minimalClaudeJsonl());
      const env = { ...process.env, GITHUB_TOKEN: "fake-token", GITHUB_API_URL: apiUrl };

      const stdout = await runAsync(["share", sessionPath, "--force"], env);
      assert.ok(stdout.includes("gisthost.github.io/?abc123"));
      assert.ok(stdout.includes("gist.github.com/mock-user/abc123"));

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  test("share --target hf --json omits gistUrl", async () => {
    await withMockHfServer(async (apiUrl) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tq-share-cli-hf-"));
      const sessionPath = join(tmpDir, "session.jsonl");
      writeFileSync(sessionPath, minimalClaudeJsonl());
      const env = {
        ...process.env,
        HF_TOKEN: "fake-token",
        HF_API_URL: apiUrl,
      };

      const stdout = await runAsync(
        ["share", sessionPath, "--target", "hf", "--hf-repo", "testuser/tracequest-sessions", "--json", "--force"],
        env,
      );
      const parsed = JSON.parse(stdout.trim());
      assert.equal(parsed.target, "hf");
      assert.ok(parsed.url.includes("/datasets/testuser/tracequest-sessions"));
      assert.equal(parsed.gistUrl, undefined);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });

  test("share --open passes gisthost preview url to browser launcher", async () => {
    await withMockGistServer(async (apiUrl) => {
      const tmpDir = mkdtempSync(join(tmpdir(), "tq-share-cli-"));
      const sessionPath = join(tmpDir, "session.jsonl");
      const openedPath = join(tmpDir, "opened.txt");
      const fakeOpen = join(tmpDir, "xdg-open");
      writeFileSync(sessionPath, minimalClaudeJsonl());
      writeFileSync(fakeOpen, `#!/bin/sh\necho "$@" >> "${openedPath}"\n`);
      chmodSync(fakeOpen, 0o755);

      const env = {
        ...process.env,
        GITHUB_TOKEN: "fake-token",
        GITHUB_API_URL: apiUrl,
        TRACEQUEST_OPEN_CMD: fakeOpen,
      };

      await runAsync(["share", sessionPath, "--open", "--force"], env);
      const opened = readFileSync(openedPath, "utf8").trim();
      assert.equal(opened, `https://gisthost.github.io/?abc123/tracequest-claude-${sessionHash(sessionPath)}.html`);

      rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
