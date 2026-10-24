/**
 * `tracequest find <session id>` and the runs page search box resolve a
 * session by its 8-char hash or its full native UUID (facts bxs, jm0, jod, sqy).
 * Real bin/tracequest.js invocations against an isolated HOME.
 */
import "../helpers/skip-lr-watch-env.js";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, get as httpGetRaw } from "node:http";
import { mkdirSync, rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL, mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const TARGET_UUID = "3f2b9c1e-7a4d-4e8b-9c0d-1a2b3c4d5e6f";
const CODEX_UUID = "019f28d8-d8c7-72b3-9e9c-a2d0bb1744f5";
const TEXT_NEEDLE = "findbyidtextneedle";

const ENV = {
  TRACEQUEST_NO_SIDECAR: "1",
  TRACEQUEST_SKIP_LR_WATCH: "1",
  TRACEQUEST_SKIP_TMUX: "1",
};

function claudeLines(sessionId, prompt) {
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T12:00:00.000Z",
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: "2026-06-03T12:00:05.000Z",
      uuid: `a-${sessionId}`,
      message: { model: CLAUDE_FIXTURE_MODEL, content: [{ type: "text", text: "ok" }] },
    },
  ];
}

function codexLines(prompt) {
  return [
    { type: "session_meta", payload: { cwd: "/home/dev/find-id-codex", model_provider: "openai" }, timestamp: "2026-06-01T00:00:00Z" },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] }, timestamp: "2026-06-01T00:00:01Z" },
  ];
}

function seed(filePath, lines, mtimeIso) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeJsonl(filePath, lines);
  const t = new Date(mtimeIso);
  utimesSync(filePath, t, t);
  return filePath;
}

/**
 * Oldest → newest: codex target, claude target, text sessions, then a newer
 * session whose prompt mentions both targets' ids, then the target's subagent.
 */
function seedHome() {
  const home = mkTmp("tracequest-find-by-id-");
  const proj = join(home, ".claude", "projects", "find-id");
  const codexPath = seed(
    join(home, ".codex", "sessions", "2026", "06", "01", `rollout-2026-06-01T10-00-00-${CODEX_UUID}.jsonl`),
    codexLines("codex target session"),
    "2026-06-01T10:00:00Z",
  );
  const targetPath = seed(join(proj, `${TARGET_UUID}.jsonl`), claudeLines(TARGET_UUID, "claude target session"), "2026-06-02T10:00:00Z");
  const textOlder = seed(join(proj, "text-older.jsonl"), claudeLines("text-older", `older ${TEXT_NEEDLE}`), "2026-06-03T10:00:00Z");
  const textNewer = seed(join(proj, "text-newer.jsonl"), claudeLines("text-newer", `newer ${TEXT_NEEDLE}`), "2026-06-04T10:00:00Z");
  const targetHash = sessionHash(targetPath);
  const codexHash = sessionHash(codexPath);
  const mentionPath = seed(
    join(proj, "mention.jsonl"),
    claudeLines("mention", `look at ${targetHash} ${codexHash} ${TARGET_UUID} ${CODEX_UUID}`),
    "2026-06-05T10:00:00Z",
  );
  const subagentPath = seed(
    join(proj, TARGET_UUID, "subagents", "agent-a1b2c3d4e5f6a7b8c.jsonl"),
    claudeLines(TARGET_UUID, "subagent of the target"),
    "2026-06-06T10:00:00Z",
  );
  return { home, codexPath, targetPath, textOlder, textNewer, mentionPath, subagentPath, targetHash, codexHash };
}

function runBin(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...ENV, HOME: home },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout: ${args.join(" ")}`));
    }, 30_000);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`bin ${args.join(" ")} exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function findJson(home, query) {
  const { stdout } = await runBin(["find", query, "--json"], home);
  return JSON.parse(stdout).map((r) => r.path);
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    httpGetRaw(`http://127.0.0.1:${port}${path}`, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    }).on("error", reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

describe("tracequest find by session id", () => {
  let fx;
  before(() => { fx = seedHome(); });
  after(() => rmSync(fx.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

  test("find by session hash lists that session first in text and --json output", async () => {
    const paths = await findJson(fx.home, fx.targetHash);
    assert.equal(paths[0], fx.targetPath);
    assert.ok(paths.includes(fx.mentionPath), "the session mentioning the hash still matches");

    const codexPaths = await findJson(fx.home, fx.codexHash);
    assert.equal(codexPaths[0], fx.codexPath);

    const { stdout } = await runBin(["find", fx.targetHash], fx.home);
    const rows = stripAnsi(stdout).split("\n").filter((line) => line.includes(".jsonl"));
    assert.ok(rows[0].includes(fx.targetHash) && rows[0].includes(fx.targetPath), `first row is the target: ${rows[0]}`);
  });

  test("find by full session id lists that session first and does not pin its subagents", async () => {
    const paths = await findJson(fx.home, TARGET_UUID);
    assert.equal(paths[0], fx.targetPath);
    const sub = paths.indexOf(fx.subagentPath);
    const mention = paths.indexOf(fx.mentionPath);
    assert.ok(mention > 0, "the session mentioning the id still matches");
    assert.ok(sub === -1 || sub > 0, "the subagent file is not pinned as the session");

    const codexPaths = await findJson(fx.home, CODEX_UUID);
    assert.equal(codexPaths[0], fx.codexPath);
  });

  test("find by text unchanged: ordinary text keeps matching and recency order", async () => {
    const paths = await findJson(fx.home, TEXT_NEEDLE);
    assert.deepEqual(paths, [fx.textNewer, fx.textOlder]);
  });

  test("runs search by session hash returns that session first from /api/sessions?expr=", async () => {
    const port = await freePort();
    const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...ENV, HOME: fx.home },
    });
    try {
      const deadline = Date.now() + 15_000;
      let res;
      while (Date.now() < deadline) {
        res = await httpGet(port, `/api/sessions?expr=${encodeURIComponent(fx.targetHash)}`).catch(() => null);
        if (res?.status === 200) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(res?.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.sessions[0].sessionHash, fx.targetHash);
      assert.equal(data.sessions[0].path, fx.targetPath);
      assert.ok(data.sessions.some((s) => s.path === fx.mentionPath));
    } finally {
      child.kill("SIGKILL");
    }
  });
});
