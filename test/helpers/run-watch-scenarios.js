/**
 * Shared live scenarios for the /run watch page: real tracequest serve +
 * headless Chromium + a PRIVATE tmux server + stub `claude` agents on the
 * serve child's stripped PATH. Scenario bodies live here so the fact-anchored
 * tests (test/browser/launch-page.test.js, facts lawp/lalv) and the
 * playwright harness file (test/browser/run-watch.playwright.test.js) run
 * the exact same verification without duplicating it.
 *
 * Callers gate their tests on playwright + tmux availability and wire
 * afterEachCleanup()/teardown() into their own hooks.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYWRIGHT } from "./playwright-gate.js";
import { TMUX } from "./tmux-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

/** Stub `claude` printing an incrementing counter every ~300ms, forever. */
const TICK_STUB = [
  "#!/bin/sh",
  "i=0",
  "while :; do",
  '  echo "TICK-$i"',
  "  i=$((i+1))",
  "  sleep 0.3",
  "done",
  "",
].join("\n");

/**
 * Stub `claude` that prints its FULL argv and exits immediately —
 * positional prompts arrive as `-- <prompt>` (the end-of-options marker).
 */
const EXIT_STUB = ["#!/bin/sh", 'echo "tq-stub:$@"', "exit 0", ""].join("\n");

/** Interactive stub `claude` echoing every stdin line back as "GOT:<line>". */
const ECHO_STUB = [
  "#!/bin/sh",
  'echo "tq-stub:$@"',
  "while read line; do",
  '  echo "GOT:$line"',
  "done",
  "",
].join("\n");

/**
 * Session-writing stub `claude` for the chat-transcript scenarios,
 * modeling the REAL claude CLI's recording behavior: it honors the
 * launcher's spawn-assigned `--session-id <uuid>` by naming its recording
 * <uuid>.jsonl, and never holds the file open (open/append/close writes).
 * It records a growing claude-format JSONL under
 * <home>/.claude/projects/<slug-of-cwd>/ while it runs — first a user
 * prompt plus an assistant turn with thinking and two search-type Bash
 * tool calls, then (after ~1s) the tool results and a second assistant
 * turn with prose and an Edit tool call that never resolves (so the live
 * page shows a running edit card). The serve HOME is baked in because the
 * persistent tmux server keeps the first scenario's env.
 */
function chatSessionStub(home) {
  return [
    "#!/bin/sh",
    'echo "tq-stub:$@"',
    'SID=""; prev=""',
    'for arg in "$@"; do',
    '  case "$prev" in --session-id) SID="$arg";; esac',
    '  prev="$arg"',
    "done",
    "proj=\"$(pwd | tr '/' '-')\"",
    `dir="${home}/.claude/projects/$proj"`,
    'mkdir -p "$dir"',
    'f="$dir/$SID.jsonl"',
    'cat > "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-11T10:00:00.000Z","uuid":"u-1","isMeta":false,"message":{"content":[{"type":"text","text":"Add a retry helper to the fetch client"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T10:00:05.000Z","uuid":"a-1","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"thinking","thinking":"The fetch client likely lives under src/client."},{"type":"text","text":"Searching the codebase for the fetch client."},{"type":"tool_use","id":"t-1","name":"Bash","input":{"command":"rg -n \\"fetchClient\\" src | head -20"}},{"type":"tool_use","id":"t-2","name":"Bash","input":{"command":"ls src/client"}}],"usage":{"input_tokens":10,"output_tokens":20}}}',
    "EOF",
    "sleep 1",
    'cat >> "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","timestamp":"2026-08-11T10:00:08.000Z","uuid":"r-1","message":{"content":[{"type":"tool_result","tool_use_id":"t-1","content":"src/client/fetch.js:12: fetchClient"}]}}',
    '{"type":"user","sessionId":"$SID","timestamp":"2026-08-11T10:00:09.000Z","uuid":"r-2","message":{"content":[{"type":"tool_result","tool_use_id":"t-2","content":"fetch.js"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-11T10:00:12.000Z","uuid":"a-2","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Adding the retry wrapper to the client."},{"type":"tool_use","id":"t-3","name":"Edit","input":{"file_path":"$PWD/src/client/fetch.js","old_string":"return doFetch(url);","new_string":"return withRetry(() => doFetch(url), 3);"}}],"usage":{"input_tokens":12,"output_tokens":22}}}',
    "EOF",
    "sleep 30",
    "",
  ].join("\n");
}

/**
 * Session-writing stub for the in-composer state-feedback scenario. Same
 * recording contract as chatSessionStub (spawn-assigned --session-id names
 * the file, open/append/close writes), but the TURN SHAPE is driven by the
 * test: batch 1 leaves two Bash tool calls unresolved (the composer must
 * read busy with the humanized action), then the stub BLOCKS until the
 * test drops a `tq-go` marker in the run cwd, then batch 2 resolves both
 * calls and ends with plain assistant text (a complete-looking turn, so
 * after the quiet window the composer reads ready and auto-delivers the
 * held queue).
 */
function feedbackSessionStub(home) {
  return [
    "#!/bin/sh",
    'echo "tq-stub:$@"',
    'SID=""; prev=""',
    'for arg in "$@"; do',
    '  case "$prev" in --session-id) SID="$arg";; esac',
    '  prev="$arg"',
    "done",
    "proj=\"$(pwd | tr '/' '-')\"",
    `dir="${home}/.claude/projects/$proj"`,
    'mkdir -p "$dir"',
    'f="$dir/$SID.jsonl"',
    'cat > "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","cwd":"$PWD","timestamp":"2026-08-12T10:00:00.000Z","uuid":"u-1","isMeta":false,"message":{"content":[{"type":"text","text":"Add a retry helper to the fetch client"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-12T10:00:05.000Z","uuid":"a-1","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Searching the codebase for the fetch client."},{"type":"tool_use","id":"t-1","name":"Bash","input":{"command":"rg -n \\"fetchClient\\" src | head -20"}},{"type":"tool_use","id":"t-2","name":"Bash","input":{"command":"ls src/client"}}],"usage":{"input_tokens":10,"output_tokens":20}}}',
    "EOF",
    'while [ ! -e "$PWD/tq-go" ]; do sleep 0.2; done',
    'cat >> "$f" <<EOF',
    '{"type":"user","sessionId":"$SID","timestamp":"2026-08-12T10:00:08.000Z","uuid":"r-1","message":{"content":[{"type":"tool_result","tool_use_id":"t-1","content":"src/client/fetch.js:12: fetchClient"}]}}',
    '{"type":"user","sessionId":"$SID","timestamp":"2026-08-12T10:00:09.000Z","uuid":"r-2","message":{"content":[{"type":"tool_result","tool_use_id":"t-2","content":"fetch.js"}]}}',
    '{"type":"assistant","sessionId":"$SID","timestamp":"2026-08-12T10:00:12.000Z","uuid":"a-2","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"The retry helper is in place."}],"usage":{"input_tokens":12,"output_tokens":22}}}',
    "EOF",
    "sleep 60",
    "",
  ].join("\n");
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
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      })
      .on("error", reject);
  });
}

function httpPost(port, reqPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: reqPath,
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function waitForHttp(port, reqPath, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
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

/**
 * Create a scenario harness bound to one private tmux socket + session.
 * @param {{ socket: string, session: string }} names
 */
export function createRunWatchHarness({ socket, session }) {
  /** @type {import("node:child_process").ChildProcess[]} */
  const serveChildren = [];
  /** @type {string[]} */
  const pendingDirs = [];

  function mkDir(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    pendingDirs.push(dir);
    return dir;
  }

  /** Stub dir whose `claude` runs `script` (detection sees exactly one agent). */
  function mkStubAgentDir(script) {
    const dir = mkDir("tq-runwatch-stub-");
    const path = join(dir, "claude");
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    return dir;
  }

  function rawTmux(args) {
    return spawnSync(TMUX.bin, ["-L", socket, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  }

  /** Kill every tq-run window so scenarios stay independent. */
  function killRunWindows() {
    const out = rawTmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}\t#{@tq_agent}"]);
    for (const line of String(out.stdout || "").split("\n")) {
      const [id, agent] = line.split("\t");
      if (id && agent) rawTmux(["kill-window", "-t", id]);
    }
  }

  /**
   * Serve child's PATH: stub dir + bare system dirs only. node and tmux are
   * pinned by absolute path because the stripped PATH would not resolve them.
   */
  function stubEnv(stubDir) {
    const whichTmux = spawnSync("which", [TMUX.bin], { encoding: "utf8" });
    const tmuxBin = TMUX.bin.startsWith("/")
      ? TMUX.bin
      : String(whichTmux.stdout || "").trim() || TMUX.bin;
    return {
      TRACEQUEST_TMUX_SOCKET: socket,
      TRACEQUEST_TMUX_SESSION: session,
      TRACEQUEST_TMUX_BIN: tmuxBin,
      PATH: `${stubDir}:/usr/bin:/bin`,
    };
  }

  function spawnServe(port, home, extraEnv) {
    const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...extraEnv,
      },
    });
    serveChildren.push(child);
    return child;
  }

  async function stopServe(child) {
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGKILL");
    }
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve();
      const timer = setTimeout(resolve, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /** Boot serve with a stub `claude` and start one run; returns {port, id}. */
  async function bootRun(stubScript, prompt) {
    const home = mkDir("tq-runwatch-home-");
    // A function stub gets the serve HOME baked in (session-writing stubs).
    if (typeof stubScript === "function") stubScript = stubScript(home);
    const stubDir = mkStubAgentDir(stubScript);
    const workDir = mkDir("tq-runwatch-cwd-");
    const port = await allocEphemeralPort();
    spawnServe(port, home, stubEnv(stubDir));
    await waitForHttp(port, "/api/agents");
    const created = await httpPost(port, "/api/runs", { agent: "claude", cwd: workDir, prompt });
    assert.equal(created.status, 200, `run create failed: ${created.body}`);
    const { id } = JSON.parse(created.body);
    return { port, id, workDir };
  }

  async function withPage(fn) {
    const { chromium } = PLAYWRIGHT;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await fn(page);
    } finally {
      await browser.close();
    }
  }

  function gotoRun(page, port, id) {
    return page.goto(`http://127.0.0.1:${port}/run?id=${encodeURIComponent(id)}`, {
      waitUntil: "load",
    });
  }

  return {
    /**
     * Fact lalv (live half): a ticking stub keeps writing output; the watch
     * page's viewport text CHANGES between successive polls while the run
     * stays in the running state with polling active.
     */
    async scenarioLiveTick() {
      const { port, id } = await bootRun(TICK_STUB, "tick");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("TICK-"),
          null,
          { timeout: 15_000 },
        );
        const first = await page.locator("#runScreen").textContent();
        await page.waitForFunction(
          (prev) => document.getElementById("runScreen").textContent !== prev,
          first,
          { timeout: 15_000 },
        );
        const second = await page.locator("#runScreen").textContent();
        assert.notEqual(second, first, "viewport content must change between polls");
        assert.match(second, /TICK-\d+/);
        assert.equal(await page.locator("#runStatus").getAttribute("data-status"), "running");
        assert.equal(await page.locator("body").getAttribute("data-polling"), "1", "still polling");
      });
    },

    /**
     * Fact lalv (exited half): a fast-exit stub ends; the page reaches the
     * distinct exited state with the final output still visible, the kill
     * control hidden, and polling STOPPED (page-side data-polling flag).
     */
    async scenarioExited() {
      const { port, id } = await bootRun(EXIT_STUB, "exit-fast");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        await page.locator('#runStatus[data-status="exited"]').waitFor({ timeout: 15_000 });
        const banner = page.locator('#runBanner[data-kind="exited"]');
        await banner.waitFor({ timeout: 15_000 });
        assert.match(await banner.textContent(), /exited/i);
        assert.match(
          await page.locator("#runScreen").textContent(),
          /tq-stub:/,
          "final output stays visible (remain-on-exit)",
        );
        assert.ok(await page.locator("#killBtn").isHidden(), "kill control hidden once exited");
        assert.ok(await page.locator("#inputRow").isHidden(), "input row hidden once exited");
        // Polling stopped for good — flag off now and still off after a poll period.
        assert.equal(await page.locator("body").getAttribute("data-polling"), "0");
        await new Promise((r) => setTimeout(r, 900));
        assert.equal(await page.locator("body").getAttribute("data-polling"), "0");
      });
    },

    /**
     * Facts laiu + chat-composer: type into the composer card and press
     * Enter (the real browser typing path — form submit sends {id, text,
     * key:"Enter"}); the run echoes the line back and it appears in the
     * polled viewport. The input clears and keeps focus, with no page
     * reload. Then the composer affordances: filling text un-dims the round
     * send button (data-empty flips) and clicking it delivers the text too;
     * the keys popover opens from the keys button, lists the allowed keys,
     * and clicking Enter sends a bare Enter (the echo loop prints an empty
     * "GOT:" line) while the menu closes and focus returns to the input.
     */
    async scenarioInput() {
      const { port, id } = await bootRun(ECHO_STUB, "echo-me");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("-- echo-me"),
          null,
          { timeout: 15_000 },
        );
        await page.locator("#inputText").fill("hello-from-browser");
        await page.locator("#inputText").press("Enter");
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("GOT:hello-from-browser"),
          null,
          { timeout: 15_000 },
        );
        assert.equal(await page.locator("#inputText").inputValue(), "", "input cleared after send");
        assert.equal(
          await page.evaluate(() => document.activeElement && document.activeElement.id),
          "inputText",
          "focus stays in the input box",
        );
        assert.equal(await page.locator("#runStatus").getAttribute("data-status"), "running");
        assert.equal(await page.locator("body").getAttribute("data-polling"), "1", "no reload — still the same polling page");

        // Round send button path: typing un-dims it (data-empty flips) and
        // clicking it submits the same {text, key:"Enter"} payload.
        assert.equal(await page.locator("#inputRow").getAttribute("data-empty"), "true");
        await page.locator("#inputText").fill("sent-via-button");
        assert.equal(await page.locator("#inputRow").getAttribute("data-empty"), "false", "typing un-dims the send button");
        await page.click("#sendBtn");
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("GOT:sent-via-button"),
          null,
          { timeout: 15_000 },
        );
        assert.equal(await page.locator("#inputRow").getAttribute("data-empty"), "true", "send re-dims the empty composer");

        // Keys popover: opens from the keys button with the full allowlist,
        // a key click sends it (bare Enter echoes an empty GOT: line),
        // closes the menu, and returns focus to the input.
        assert.ok(await page.locator("#keysMenu").isHidden(), "keys menu starts closed");
        await page.click("#keysBtn");
        assert.ok(await page.locator("#keysMenu").isVisible(), "keys button opens the menu");
        assert.equal(await page.locator("#keysMenu [data-key]").count(), 6, "all six allowed keys listed");
        await page.click('#keysMenu [data-key="Enter"]');
        await page.waitForFunction(
          () => /(^|\n)GOT:\s*($|\n)/.test(document.getElementById("runScreen").textContent),
          null,
          { timeout: 15_000 },
        );
        assert.ok(await page.locator("#keysMenu").isHidden(), "key send closes the menu");
        assert.equal(
          await page.evaluate(() => document.activeElement && document.activeElement.id),
          "inputText",
          "focus returns to the input after a key send",
        );

        // Run-details popover: the agent chip is a real disclosure control —
        // clicking it opens the run identity menu (agent, run id, directory,
        // Stop-vs-Kill note), it is mutually exclusive with the keys menu,
        // and Escape closes it. The echo stub writes no recording, so the
        // model row honestly stays at "detecting…" with the chip hidden.
        assert.ok(await page.locator("#runMenu").isHidden(), "run menu starts closed");
        await page.click("#agentChip");
        assert.ok(await page.locator("#runMenu").isVisible(), "agent chip opens run details");
        assert.equal(await page.locator("#agentChip").getAttribute("aria-expanded"), "true");
        const menuText = await page.locator("#runMenu").textContent();
        assert.match(menuText, /Agent\s*claude/, "run menu names the agent");
        assert.match(menuText, /Run\s*@\d+/, "run menu carries the run id");
        assert.match(menuText, /Stop sends \^C to interrupt the agent; Kill run ends its tmux window/, "Stop vs Kill explained");
        assert.ok(await page.locator("#modelChip").isHidden(), "model chip hidden while no session reports a model");
        assert.match(menuText, /detecting…/, "model row honest while unknown");
        // APG modal: the run overlay inerts the page, so chips behind it
        // cannot be clicked. Escape closes; Cmd/Ctrl-I still toggles.
        await page.keyboard.press("Escape");
        assert.ok(await page.locator("#runMenu").isHidden(), "Escape closes run details");
        await page.click("#keysBtn");
        assert.ok(await page.locator("#keysMenu").isVisible());
        await page.keyboard.press("Control+i");
        assert.ok(await page.locator("#keysMenu").isHidden(), "run details closes the keys menu");
        assert.ok(await page.locator("#runMenu").isVisible(), "Ctrl/Cmd-I opens run details over keys");
        await page.keyboard.press("Escape");
        assert.ok(await page.locator("#runMenu").isHidden(), "Escape closes run details");
      });
    },

    /**
     * Chat-composer fact: the status strip's Stop control sends C-c into
     * the run's tty — the interrupt kills the echo loop, the page reaches
     * the exited state, the strip swaps to "Agent exited", and the input
     * card plus stop/kill controls retire.
     */
    async scenarioStop() {
      const { port, id } = await bootRun(ECHO_STUB, "stop-me");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("-- stop-me"),
          null,
          { timeout: 15_000 },
        );
        assert.equal(await page.locator("#composerStatus").getAttribute("data-state"), "running");
        assert.equal(await page.locator("#statusText").textContent(), "Running");
        await page.click("#stopBtn");
        await page.locator('#runStatus[data-status="exited"]').waitFor({ timeout: 15_000 });
        assert.equal(await page.locator("#composerStatus").getAttribute("data-state"), "exited");
        assert.equal(await page.locator("#statusText").textContent(), "Agent exited");
        assert.ok(await page.locator("#inputRow").isHidden(), "input card retired once exited");
        assert.ok(await page.locator("#stopBtn").isHidden(), "stop control retired once exited");
        assert.ok(await page.locator("#killBtn").isHidden(), "kill control retired once exited");
      });
    },

    /**
     * Chat-ui facts cuts/cutl/cusp (live half): the watch page renders the
     * run's unified session as a chat transcript — the user bubble,
     * assistant prose, thought marker, "Explored 2 searches" grouping, and
     * tool cards appear; events the agent appends ~1s later render WITHOUT
     * a reload (etag polling stays active) including an Edit file card with
     * +N/-N stats that reads as running, and the in-progress shimmer marker
     * stays visible while the run is live.
     */
    async scenarioChatLive() {
      const { port, id } = await bootRun(chatSessionStub, "chat-live");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        // First batch: user bubble + assistant prose + thought + grouped search cards.
        await page.waitForFunction(
          () => {
            const t = document.getElementById("chatThread").textContent;
            return t.includes("Add a retry helper to the fetch client");
          },
          null,
          { timeout: 15_000 },
        );
        assert.equal(
          await page.locator(".chat-user").first().textContent(),
          "Add a retry helper to the fetch client",
          "user event renders as a chat bubble",
        );
        const thread = page.locator("#chatThread");
        assert.match(await thread.textContent(), /Searching the codebase for the fetch client/);
        assert.match(await thread.textContent(), /Thought/, "thinking renders as a thought marker");
        assert.match(await thread.textContent(), /Explored 2 searches/, "search calls grouped");
        assert.match(await thread.textContent(), /Ripgrep for fetchClient/, "verb-object investigation title");
        // Second batch appends live, without reload.
        await page.waitForFunction(
          () => document.getElementById("chatThread").textContent.includes("Adding the retry wrapper"),
          null,
          { timeout: 15_000 },
        );
        const fileCard = page.locator(".chat-card.file");
        assert.match(await fileCard.textContent(), /src\/client\/fetch\.js/, "edit renders as a file card");
        assert.match(await fileCard.textContent(), /\+1/, "added-line stat");
        assert.equal(
          await page.locator("body").getAttribute("data-chat-polling"),
          "1",
          "no reload — the same session-polling page appended the events",
        );
        assert.equal(await page.locator("body").getAttribute("data-run-state"), "running");
        assert.ok(
          (await page.locator("#chatActivity .shimmer").count()) > 0,
          "in-progress shimmer marker visible while live",
        );
        // The composer's model chip is fed by the live session recording:
        // once the linked session reports a model, the chip unhides with the
        // dashboard-short name and the run-details menu carries the full id
        // plus a "view session" recording link.
        await page.locator("#modelChip:not([hidden])").waitFor({ timeout: 15_000 });
        assert.equal(
          await page.locator("#modelName").textContent(),
          "sonnet-4",
          "model chip shows the session-reported model, shortened",
        );
        await page.click("#modelChip");
        assert.ok(await page.locator("#runMenu").isVisible(), "model chip opens run details");
        assert.equal(
          await page.locator("#menuModel").textContent(),
          "claude-sonnet-4-20250514",
          "run details carry the full model id",
        );
        const recHref = await page.locator("#menuRecording a").getAttribute("href");
        assert.match(recHref, /^\/view\?path=/, "recording row links to the session view");
      });
    },

    /**
     * Chat-ui fact cusp (pending half): a run whose agent never writes a
     * recording shows the pending state — waiting copy, no thread content,
     * chat polling still active.
     */
    async scenarioChatPending() {
      const { port, id } = await bootRun(TICK_STUB, "no-session");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        await page.waitForFunction(
          () => document.getElementById("chatActivity").textContent.includes("Waiting for the agent session"),
          null,
          { timeout: 15_000 },
        );
        assert.equal(await page.locator("#chatThread").textContent(), "", "no thread content while pending");
        assert.match(
          await page.locator("#chatActivity").textContent(),
          /no session recording linked yet/,
        );
        // The pending copy paints immediately; session polling engages with
        // the first completed poll and stays active while the run is live.
        await page.waitForFunction(
          () => document.body.getAttribute("data-chat-polling") === "1",
          null,
          { timeout: 15_000 },
        );
        assert.equal(await page.locator("body").getAttribute("data-run-state"), "pending");
      });
    },

    /**
     * Chat-composer fact cmfw: in-composer state feedback against a live
     * run — the strip text becomes the run's live activity (humanized
     * unresolved tool call, not a static "Running"), the empty-input send
     * button morphs to a stop control, a mid-generation submit is HELD as
     * a visible queue row (editable, removable, force-sendable), and once
     * the stub completes its turn and the recording goes quiet the held
     * follow-up auto-delivers into the pane and the queue empties.
     */
    async scenarioComposerFeedback() {
      const { port, id, workDir } = await bootRun(feedbackSessionStub, "state-feedback");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        // (1) live activity line: the newest unresolved tool call reads as
        // the humanized in-progress action; the composer flips to busy.
        await page.waitForFunction(
          () => document.getElementById("statusText").textContent === "Running ls src/client",
          null,
          { timeout: 15_000 },
        );
        assert.equal(await page.locator("#inputRow").getAttribute("data-busy"), "true");
        assert.equal(await page.locator("#composerStatus").getAttribute("data-busy"), "true");
        // (2) send-morphs-to-stop over the empty input.
        assert.equal(await page.locator("#sendBtn").getAttribute("aria-label"), "Stop generating");
        assert.ok(await page.locator("#sendBtn .icon-stop").isVisible(), "stop glyph shows while busy+empty");
        assert.ok(await page.locator("#sendBtn .icon-send").isHidden(), "send arrow hidden while busy+empty");
        assert.match(
          await page.locator("#inputText").getAttribute("placeholder"),
          /Queue a follow-up/,
          "placeholder states the mid-generation consequence",
        );
        // (3) typing flips the affordance to a queue-labeled send, and
        // Enter HOLDS the message as a visible queue row — nothing sent.
        await page.locator("#inputText").fill("queued-one");
        assert.equal(await page.locator("#sendBtn").getAttribute("aria-label"), "Queue follow-up");
        assert.ok(await page.locator("#sendBtn .icon-send").isVisible(), "arrow returns over text");
        await page.locator("#inputText").press("Enter");
        await page.locator("#composerQueue:not([hidden])").waitFor({ timeout: 5_000 });
        assert.equal(await page.locator("#queueCount").textContent(), "1 in queue");
        assert.equal(await page.locator("#inputText").inputValue(), "", "input cleared into the queue");
        assert.ok(
          !(await page.locator("#runScreen").textContent()).includes("queued-one"),
          "nothing typed into the pane while the message is held",
        );
        await page.locator("#inputText").fill("queued-two");
        await page.locator("#inputText").press("Enter");
        assert.equal(await page.locator("#queueCount").textContent(), "2 in queue");
        // (4) every row is real: × removes, click-to-edit pulls it back.
        await page.locator(".queue-item .queue-x").first().click();
        assert.equal(await page.locator("#queueCount").textContent(), "1 in queue");
        assert.match(await page.locator(".queue-item .queue-text").textContent(), /queued-two/);
        await page.locator(".queue-item .queue-text").click();
        assert.equal(await page.locator("#inputText").inputValue(), "queued-two", "click-to-edit restores the text");
        assert.ok(await page.locator("#composerQueue").isHidden(), "empty queue hides");
        // (5) "send now" types a held row into the terminal immediately.
        await page.locator("#inputText").fill("sent-now-follow-up");
        await page.locator("#inputText").press("Enter");
        await page.locator(".queue-item .queue-send-now").click();
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("sent-now-follow-up"),
          null,
          { timeout: 15_000 },
        );
        // (6) queue another while busy, then let the stub complete its
        // turn: after the quiet window the held follow-up auto-delivers.
        await page.locator("#inputText").fill("auto-delivered-follow-up");
        await page.locator("#inputText").press("Enter");
        assert.equal(await page.locator("#queueCount").textContent(), "1 in queue");
        writeFileSync(join(workDir, "tq-go"), "");
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("auto-delivered-follow-up"),
          null,
          { timeout: 20_000 },
        );
        await page.locator("#composerQueue").waitFor({ state: "hidden", timeout: 5_000 });
        // Ready again: the strip returns to the plain honest Running.
        assert.equal(await page.locator("#statusText").textContent(), "Running");
        assert.equal(await page.locator("#inputRow").getAttribute("data-busy"), "false");
      });
    },

    /** Kill from the watch page: gone state without reload, window gone in tmux. */
    async scenarioKill() {
      const { port, id } = await bootRun(TICK_STUB, "tick");
      await withPage(async (page) => {
        await gotoRun(page, port, id);
        await page.waitForFunction(
          () => document.getElementById("runScreen").textContent.includes("TICK-"),
          null,
          { timeout: 15_000 },
        );
        await page.click("#killBtn");
        const banner = page.locator('#runBanner[data-kind="gone"]');
        await banner.waitFor({ timeout: 15_000 });
        assert.match(await banner.textContent(), /killed/i);
        assert.equal(await page.locator("#runStatus").getAttribute("data-status"), "gone");
        assert.equal(await page.locator("body").getAttribute("data-polling"), "0");
      });
      const windowIds = String(
        rawTmux(["list-windows", "-t", `=${session}`, "-F", "#{window_id}"]).stdout || "",
      )
        .split("\n")
        .filter(Boolean);
      assert.ok(!windowIds.includes(id), "killed run's tmux window is gone");
    },

    /** Wire into afterEach: stop serves, kill run windows, drop temp dirs. */
    async afterEachCleanup() {
      while (serveChildren.length) {
        await stopServe(serveChildren.pop());
      }
      if (TMUX) killRunWindows();
      await new Promise((r) => setTimeout(r, 100));
      while (pendingDirs.length) {
        const dir = pendingDirs.pop();
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
          // best-effort
        }
      }
    },

    /** Wire into after: ALWAYS tear down the private tmux server. */
    teardown() {
      if (TMUX) {
        try {
          spawnSync(TMUX.bin, ["-L", socket, "kill-server"], { stdio: "ignore" });
        } catch {
          // best-effort cleanup
        }
      }
    },
  };
}
