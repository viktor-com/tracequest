/**
 * Serve live-reload integration — real tracequest serve + fs.watch + SSE.
 * Does NOT import skip-lr-watch-env; watchers must be enabled in the child process.
 */
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FIXTURE_MODEL,
  mkTmp,
  writeClaudeJsonlSynced,
} from "../helpers/fixtures.js";
import {
  appendOpenCodeIndexSessionSynced,
  seedOpenCodeIndexDb,
} from "../helpers/opencode-db-fixtures.js";
import { DATA_UPDATE_DEBOUNCE_MS } from "../../src/server/server-live-reload.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const LR_MARKER = "livereload-integ-new-session-marker-xyz";
const CONCURRENT_LR_MARKER = "concurrent-lr-stress-marker-xyz";
const OC_LR_MARKER = "livereload-opencode-db-marker-xyz";
const OC_LR_SESSION_ID = "ses_lrIntegOpenCodeSession01";
/** Watched src/*.js file — append-only touch; restored in finally. */
const SRC_TOUCH_FILE = join(ROOT, "src/routes.js");
const SRC_LR_TOUCH_MARKER = "\n// livereload-integ-src-touch-marker-xyz\n";
/** Nested browser helper imported through browser/browser-page.js; restored in finally. */
const NESTED_BROWSER_HELPER_FILE = join(ROOT, "src/browser/browser-page-build.js");
const NESTED_BROWSER_HELPER_NEEDLE = "<title>Runs · tracequest</title>";
const NESTED_BROWSER_HELPER_MARKER = "tracequest-hot-reload-nested-browser-helper-marker";
const NESTED_BROWSER_HELPER_MARKUP =
  `<meta name="tracequest-hot-reload-regression" content="${NESTED_BROWSER_HELPER_MARKER}">`;

/** Extra slack beyond debounce for slow fs.watch + CI filesystem latency. */
const LR_DEBOUNCE_BUFFER_MS = 8_000;

/** @type {import("node:child_process").ChildProcess[]} */
const serveChildren = [];
/** @type {string[]} */
const pendingHomes = [];

afterEach(async () => {
  while (serveChildren.length) {
    await stopServe(serveChildren.pop());
  }
  await new Promise((r) => setTimeout(r, 150));
  while (pendingHomes.length) {
    const home = pendingHomes.pop();
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Best-effort cleanup.
    }
  }
});

function minimalClaudeSession(sessionId, prompt = LR_MARKER) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId,
      cwd: "/home/dev/tracequest",
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
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "livereload integration reply" }],
      },
    },
  ];
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
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, { expectedStatus = 200, timeoutMs = 25_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === expectedStatus) return res;
      lastErr = new Error(`HTTP ${res.status} for ${reqPath}, expected ${expectedStatus}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw lastErr ?? new Error(`timed out waiting for ${reqPath}`);
}

function spawnServeWithLiveReload(port, home) {
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_TMUX: "1",
  };
  delete env.TRACEQUEST_SKIP_LR_WATCH;

  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  serveChildren.push(child);
  return child;
}

async function stopServe(child) {
  if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  if (child.exitCode == null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

function trackHome(home) {
  pendingHomes.push(home);
}

function seedEmptyClaudeHome() {
  const home = mkTmp("tracequest-livereload-home-");
  trackHome(home);
  const projDir = join(home, ".claude", "projects", "lr-integ-empty");
  mkdirSync(projDir, { recursive: true });
  return { home, projDir };
}

async function seedEmptyOpenCodeHome() {
  const home = mkTmp("tracequest-livereload-opencode-home-");
  trackHome(home);
  await seedOpenCodeIndexDb(home, []);
  return { home };
}

function openCodeLivereloadSession(prompt = OC_LR_MARKER) {
  return {
    id: OC_LR_SESSION_ID,
    title: "Live Reload OpenCode",
    directory: "/home/dev/lr-opencode-proj",
    messages: [
      {
        role: "user",
        parts: [{ type: "text", text: prompt }],
      },
      {
        role: "assistant",
        modelID: "gpt-4o",
        parts: [{ type: "text", text: "livereload opencode assistant reply" }],
      },
      {
        role: "user",
        parts: [{ type: "text", text: "third turn for discovery msg-count threshold" }],
      },
    ],
  };
}

/** Retry async fn on transient failure (fs.watch / SSE timing). */
async function retryAsync(label, fn, { attempts = 3, delayMs = 400 } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
}

function waitForLivereloadEvent(port, pattern, { timeoutMs = DATA_UPDATE_DEBOUNCE_MS + LR_DEBOUNCE_BUFFER_MS } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const deadline = Date.now() + timeoutMs;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(deadlineTimer);
      req.destroy();
      reject(err);
    };

    const req = http.get(`http://127.0.0.1:${port}/__livereload`, (res) => {
      if (res.statusCode !== 200) {
        fail(new Error(`livereload HTTP ${res.statusCode}`));
        return;
      }
      res.on("data", (chunk) => {
        buf += chunk.toString();
        if (pattern.test(buf) && !settled) {
          settled = true;
          clearInterval(deadlineTimer);
          req.destroy();
          resolve(buf);
        }
      });
      res.on("end", () => {
        if (!settled) {
          fail(new Error(`livereload stream closed before ${pattern}; got: ${buf.slice(0, 400)}`));
        }
      });
    });
    req.on("error", (err) => fail(err));

    const deadlineTimer = setInterval(() => {
      if (settled) {
        clearInterval(deadlineTimer);
        return;
      }
      if (Date.now() >= deadline) {
        fail(new Error(`timeout waiting for livereload ${pattern}; got: ${buf.slice(0, 400)}`));
      }
    }, 200);
  });
}

async function waitForSessionCount(port, expectedTotal, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastTotal;
  while (Date.now() < deadline) {
    const res = await httpGet(port, "/api/sessions");
    const data = JSON.parse(res.body);
    lastTotal = data.total;
    if (data.total === expectedTotal) return data;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`expected /api/sessions total ${expectedTotal}, last saw ${lastTotal}`);
}

function touchFileSynced(filePath, content) {
  writeFileSync(filePath, content);
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Keep one SSE connection open: wait for connected, run touchFn, then wait for reload.
 * Src reload has no debounce — touch must happen only after the client is registered.
 */
function waitForSrcReloadAfterConnected(port, touchFn, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let connected = false;
    let settled = false;
    const deadline = Date.now() + timeoutMs;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearInterval(deadlineTimer);
      req.destroy();
      reject(err);
    };

    const req = http.get(`http://127.0.0.1:${port}/__livereload`, (res) => {
      if (res.statusCode !== 200) {
        fail(new Error(`livereload HTTP ${res.statusCode}`));
        return;
      }
      res.on("data", (chunk) => {
        buf += chunk.toString();
        if (!connected && /data: connected/.test(buf)) {
          connected = true;
          try {
            touchFn();
          } catch (err) {
            fail(err);
          }
        }
        if (connected && /data: reload/.test(buf) && !settled) {
          settled = true;
          clearInterval(deadlineTimer);
          req.destroy();
          resolve(buf);
        }
      });
      res.on("end", () => {
        if (!settled) {
          fail(new Error(`livereload stream closed before reload; got: ${buf.slice(0, 400)}`));
        }
      });
    });
    req.on("error", (err) => fail(err));

    const deadlineTimer = setInterval(() => {
      if (settled) {
        clearInterval(deadlineTimer);
        return;
      }
      if (Date.now() >= deadline) {
        fail(
          new Error(
            `timeout waiting for src reload (connected=${connected}); got: ${buf.slice(0, 400)}`,
          ),
        );
      }
    }, 200);
  });
}

async function waitForViewContains(port, sessionPath, pattern, { timeoutMs = 20_000 } = {}) {
  const reqPath = `/view?path=${encodeURIComponent(sessionPath)}`;
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  let lastSnippet = "";
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, reqPath);
      lastStatus = res.status;
      if (res.status === 200 && pattern.test(res.body)) return res;
      lastSnippet = res.body.slice(0, 200);
    } catch (err) {
      lastStatus = err.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `view did not match ${pattern} within ${timeoutMs}ms (last status ${lastStatus}; snippet: ${lastSnippet})`,
  );
}

async function waitForRootContains(port, pattern, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus;
  let lastSnippet = "";
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, "/sessions");
      lastStatus = res.status;
      if (res.status === 200 && pattern.test(res.body)) return res;
      lastSnippet = res.body.slice(0, 200);
    } catch (err) {
      lastStatus = err.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `root page did not match ${pattern} within ${timeoutMs}ms (last status ${lastStatus}; snippet: ${lastSnippet})`,
  );
}

describe("serve live-reload integration", () => {
  test("Test 1: /__livereload SSE connects and sends connected frame", async () => {
    const { home } = seedEmptyClaudeHome();
    const port = await allocEphemeralPort();
    spawnServeWithLiveReload(port, home);
    try {
      await waitForHttp(port, "/api/sessions");
      const buf = await retryAsync("livereload connected", () =>
        waitForLivereloadEvent(port, /data: connected/, { timeoutMs: 8_000 }),
      );
      assert.match(buf, /text\/event-stream|data: connected/);
    } finally {
      // afterEach stops serve + cleans home
    }
  });

  test("Test 2: new .jsonl under watched data root debounces into data-update SSE", async () => {
    const { home, projDir } = seedEmptyClaudeHome();
    const port = await allocEphemeralPort();
    spawnServeWithLiveReload(port, home);
    try {
      await waitForHttp(port, "/api/sessions");
      const { buf, sessionPath } = await retryAsync("livereload data-update", async () => {
        const ssePromise = waitForLivereloadEvent(port, /data: data-update/, {
          timeoutMs: DATA_UPDATE_DEBOUNCE_MS + LR_DEBOUNCE_BUFFER_MS,
        });
        const path = writeClaudeJsonlSynced(
          projDir,
          "lr-new-session.jsonl",
          minimalClaudeSession("lr-integ-new-1", LR_MARKER),
        );
        return { buf: await ssePromise, sessionPath: path };
      });
      assert.match(buf, /data: data-update/);
      assert.ok(sessionPath.includes("lr-new-session.jsonl"));
    } finally {
      // afterEach
    }
  });

  test("Test 3: after data-update, /api/sessions lists the new session", async () => {
    const { home, projDir } = seedEmptyClaudeHome();
    const port = await allocEphemeralPort();
    spawnServeWithLiveReload(port, home);
    try {
      const empty = JSON.parse((await waitForHttp(port, "/api/sessions")).body);
      assert.equal(empty.total, 0);

      const sessionPath = await retryAsync("livereload data-update", async () => {
        const ssePromise = waitForLivereloadEvent(port, /data: data-update/, {
          timeoutMs: DATA_UPDATE_DEBOUNCE_MS + LR_DEBOUNCE_BUFFER_MS,
        });
        const path = writeClaudeJsonlSynced(
          projDir,
          "lr-listed-session.jsonl",
          minimalClaudeSession("lr-integ-listed-1", LR_MARKER),
        );
        await ssePromise;
        return path;
      });

      const data = await retryAsync("session index refresh", () => waitForSessionCount(port, 1));
      assert.equal(data.sessions.length, 1);
      assert.match(data.sessions[0].prompt, new RegExp(LR_MARKER));
      assert.match(data.sessions[0].path, /lr-listed-session\.jsonl$/);
      assert.equal(data.sessions[0].path, sessionPath);
    } finally {
      // afterEach
    }
  });

  test("Test 4: after data-update, /view?path= serves fresh HTML (route cache cleared)", async () => {
    const { home, projDir } = seedEmptyClaudeHome();
    const port = await allocEphemeralPort();
    spawnServeWithLiveReload(port, home);
    try {
      // Warm route cache while index is empty.
      const empty = JSON.parse((await waitForHttp(port, "/api/sessions")).body);
      assert.equal(empty.total, 0);

      const sessionPath = await retryAsync("livereload data-update", async () => {
        const ssePromise = waitForLivereloadEvent(port, /data: data-update/, {
          timeoutMs: DATA_UPDATE_DEBOUNCE_MS + LR_DEBOUNCE_BUFFER_MS,
        });
        const path = writeClaudeJsonlSynced(
          projDir,
          "lr-view-session.jsonl",
          minimalClaudeSession("lr-integ-view-1", LR_MARKER),
        );
        await ssePromise;
        return path;
      });

      const viewRes = await retryAsync("view after route cache clear", () =>
        waitForViewContains(port, sessionPath, new RegExp(LR_MARKER)),
      );
      assert.match(viewRes.body, /<html/i);
      assert.match(viewRes.body, /SESSION\s*=/);
    } finally {
      // afterEach
    }
  });

});
