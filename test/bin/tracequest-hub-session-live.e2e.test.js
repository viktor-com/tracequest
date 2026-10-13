/**
 * GET /api/sessions/live end to end on a real hub serve: the whole-file parse
 * of a large recording and the serialization of its answer happen off the
 * event loop, the answer is what the parse holds (every turn, redacted, the
 * etag flow intact), and it follows the recording when it grows.
 */
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_MODEL, mkTmp } from "../helpers/fixtures.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");

const children = [];
const temps = [];

afterEach(async () => {
  while (children.length) {
    const child = children.pop();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
  }
  while (temps.length) rmSync(temps.pop(), { recursive: true, force: true });
});

/** A secret-shaped value the recording repeats; hub redaction must remove it. */
const SECRET = `sk-${"Q7xZ".repeat(2)}${Buffer.from("planted-secret-for-the-live-endpoint").toString("base64url")}`;

function turn(i, reply) {
  return [
    { type: "user", sessionId: "big-live", cwd: "/home/dev/live", timestamp: "2026-06-03T12:00:00.000Z", uuid: `u-${i}`, message: { content: [{ type: "text", text: `turn ${i}: export OPENAI_KEY=${SECRET}` }] } },
    { type: "assistant", sessionId: "big-live", timestamp: "2026-06-03T12:00:01.000Z", uuid: `a-${i}`, message: { model: CLAUDE_FIXTURE_MODEL, content: [{ type: "text", text: reply }] } },
  ];
}

/** A claude recording of at least `mb` MB. */
function writeBigRecording(home, mb) {
  const file = join(home, ".claude", "projects", "-home-dev-live", "big-live.jsonl");
  mkdirSync(dirname(file), { recursive: true });
  const filler = "Ran the build and the tests — every module compiled and nothing else changed. ".repeat(40);
  const lines = [];
  let bytes = 0;
  for (let i = 0; bytes < mb * 1024 * 1024; i++) {
    for (const entry of turn(i, filler)) {
      const line = JSON.stringify(entry);
      lines.push(line);
      bytes += line.length + 1;
    }
  }
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
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

async function startHub(home) {
  const port = await freePort();
  const child = spawn(process.execPath, [BIN, "serve", "--hub", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_LIVE_SESSIONS_HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_SKIP_LR_WATCH: "1",
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
      return port;
    } catch {
      if (Date.now() > deadline) throw new Error(`serve never listened:\n${child.out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** Run `fetch` while probing an unrelated request every 10 ms; returns [result, slowest probe ms]. */
async function whileProbing(port, fetch) {
  let done = false;
  const pending = fetch().finally(() => { done = true; });
  const probes = [];
  while (!done) {
    probes.push((await get(port, "/__tq_probe_404")).ms);
    await new Promise((r) => setTimeout(r, 10));
  }
  return [await pending, Math.max(...probes), probes.length];
}

describe("hub /api/sessions/live (serve end to end)", () => {
  test("live session off-thread: parsing and serializing a large recording never blocks other requests", async () => {
    const home = mkTmp("tq-hub-session-live-");
    temps.push(home);
    const big = writeBigRecording(home, 48);
    const port = await startHub(home);
    assert.equal((await get(port, "/api/sessions", 120_000)).status, 200);
    const live = `/api/sessions/live?id=${sessionHash(big)}`;

    // First open: the whole-file parse. Then an open of the unchanged recording.
    for (const label of ["first open", "second open"]) {
      const [res, slowest, n] = await whileProbing(port, () => get(port, live, 120_000));
      assert.equal(res.status, 200, label);
      assert.ok(n >= 3, `probed ${n} times during the ${label}`);
      assert.ok(slowest < 150, `every request answered within 150 ms during the ${label} (slowest ${slowest.toFixed(0)} ms)`);
    }

    const data = JSON.parse((await get(port, live, 120_000)).body);
    const lines = readFileSync(big, "utf8").split("\n").filter(Boolean).length;
    assert.equal(data.session.events.length, lines, "one event per recorded line, in full");
    assert.equal(data.sessionHash, sessionHash(big));
    assert.equal(data.state, "idle");
    assert.ok(Array.isArray(data.chapters) && data.chapters.length >= 1, "the chapters come with the session");
    assert.match(data.etag, /^\d+-\d+$/);
    const raw = (await get(port, live, 120_000)).body;
    assert.ok(!raw.includes(SECRET), "the answer is redacted");

    // The etag flow: the same etag answers unchanged; growth answers the new turn.
    const same = JSON.parse((await get(port, `${live}&etag=${encodeURIComponent(data.etag)}`)).body);
    assert.equal(same.unchanged, true);
    assert.equal(same.session, null);
    for (const entry of turn("grown", "the recording grew by one more turn")) appendFileSync(big, `${JSON.stringify(entry)}\n`);
    const grown = JSON.parse((await get(port, `${live}&etag=${encodeURIComponent(data.etag)}`, 120_000)).body);
    assert.notEqual(grown.etag, data.etag);
    assert.equal(grown.session.events.length, lines + 2);
    assert.equal(grown.session.events.at(-1).text, "the recording grew by one more turn");
  });
});
