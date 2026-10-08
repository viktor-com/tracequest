/**
 * Unified-live served-browser coverage: an EXTERNALLY-simulated live session
 * (a codex-format session file held open by this process — the open-fd
 * liveness path — while being appended to) opens in the SAME chat view a
 * launched run gets (/run?session=<hash>), renders the transcript, updates
 * live as the file grows, and ends the conversation column on the live
 * tail (Planning / one slim Stop composer — not archive observer
 * chrome). The dashboard presents the session as ONE unified live row
 * whose click target IS that chat view.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { appendFileSync, chmodSync, closeSync, fsyncSync, mkdirSync, openSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonlSynced } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { SKIP_NO_TMUX, TMUX } from "../helpers/tmux-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";
import { cursorProjectSlug, factoryWorkspaceSlug } from "../../src/sessions/live-sessions.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const LIVE_PROMPT = "unified live chat prompt marker";
const FIRST_REPLY = "unified live first assistant reply";
const APPENDED_REPLY = "unified live appended assistant reply";
const SOCKET = `tq-test-unichat-${process.pid}`;
const SESSION = `tq-unichat-${process.pid}`;

/** Parity test needs BOTH playwright and tmux (the rest gates on playwright only). */
const SKIP_NO_BOTH = SKIP_NO_PLAYWRIGHT.skip ? SKIP_NO_PLAYWRIGHT : SKIP_NO_TMUX;

after(() => {
  // ALWAYS tear down the private tmux server for this socket.
  if (TMUX) {
    try {
      spawnSync(TMUX.bin, ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
  }
});

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
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
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

async function waitForHttp(port, reqPath, child, { timeoutMs = 15_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`serve exited early (${child.exitCode})\nstdout: ${child._stdout}\nstderr: ${child._stderr}`);
    }
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === 200) return;
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
      TRACEQUEST_LIVE_SESSIONS_HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_SKIP_LR_WATCH: "1",
      // Point the serve child at a nonexistent tmux so the developer's real
      // runs never leak into this test's dashboard.
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
    },
  });
  child._stdout = "";
  child._stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { child._stdout += chunk; });
  child.stderr.on("data", (chunk) => { child._stderr += chunk; });
  return child;
}

async function stopServe(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function withServe(home, fn) {
  const port = await allocEphemeralPort();
  const child = spawnServe(port, home);
  try {
    await waitForHttp(port, "/api/sessions", child);
    await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await stopServe(child);
  }
}

function seedLiveCodexHome() {
  const home = mkTmp("tracequest-unified-live-chat-");
  const codexDir = join(home, ".codex", "sessions", "2026", "08", "11");
  mkdirSync(codexDir, { recursive: true });
  const codexPath = join(codexDir, "rollout-unified-live.jsonl");
  writeJsonlSynced(codexPath, [
    {
      type: "session_meta",
      payload: { id: "unified-live-chat-codex", cwd: "/home/dev/unified-live", model_provider: "gpt-5-codex" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-11T12:00:00.000Z",
      payload: { type: "user_message", message: LIVE_PROMPT },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-11T12:00:01.000Z",
      payload: { type: "task_started", turn_id: "turn-live" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T12:00:05.000Z",
      payload: { role: "assistant", content: [{ type: "output_text", text: FIRST_REPLY }] },
    },
  ]);
  return { home, codexPath };
}

function appendAssistantReply(codexPath, text) {
  appendFileSync(codexPath, `${JSON.stringify({
    type: "response_item",
    timestamp: "2026-08-11T12:00:20.000Z",
    payload: { role: "assistant", content: [{ type: "output_text", text }] },
  })}\n`);
  const fd = openSync(codexPath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

describe("unified live chat (served browser)", () => {
  test(
    "an external live session opens in the chat view, updates live, and shows the read-only state",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const { home, codexPath } = seedLiveCodexHome();
      const hash = sessionHash(codexPath);
      const fd = openSync(codexPath, "r");
      try {
        await withServe(home, async (url) => {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(`${url}run?session=${hash}`, { waitUntil: "load" });

            // Identity + the ONE status vocabulary + honest origin.
            await page.locator(".chat-identity .session-source", { hasText: "codex" }).waitFor();
            await page.locator(".chat-identity .run-origin", { hasText: "external" }).waitFor();
            await page.locator('#runStatus[data-status="running"]', { hasText: "running" }).waitFor({ timeout: 15_000 });

            // The transcript is the same chat surface a run gets.
            await page.locator("#chatThread .chat-user", { hasText: LIVE_PROMPT }).waitFor({ timeout: 15_000 });
            await page.locator("#chatThread .chat-assistant", { hasText: FIRST_REPLY }).waitFor();

            // Live tail: no steerable run composer; archive observer chrome is off the column.
            assert.equal(await page.locator("#inputText").count(), 0, "no run input box for an externally driven session");
            assert.equal(await page.locator("#sendBtn").count(), 0, "no run send affordance");
            await page.locator("body[data-live-tail='1']").waitFor();
            assert.equal(await page.locator("#observerCard").isVisible(), false, "observer card leaves the live column");
            assert.equal(await page.locator("#readonlyChip").isVisible(), false, "WATCH-ONLY leaves the live column");
            await page.locator("#liveTailForm").waitFor();
            await page.locator("#liveTailStop[aria-label='Stop']").waitFor();
            assert.equal(await page.locator("#archiveEnding").isVisible(), false, "archive ending leaves the live column");
            assert.equal(await page.locator("#composerStatus").isVisible(), false, "no Generating/Stop strip stacked on the composer");

            // Live: appended events render without a reload while polling stays on.
            appendAssistantReply(codexPath, APPENDED_REPLY);
            await page.locator("#chatThread .chat-assistant", { hasText: APPENDED_REPLY }).waitFor({ timeout: 15_000 });
            assert.equal(await page.getAttribute("body", "data-chat-polling"), "1", "chat polling stays active");
            assert.equal(await page.getAttribute("body", "data-watch"), "session");
          } finally {
            await browser.close();
          }
        });
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test(
    "the dashboard's unified live row leads straight into the live chat view",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const { home, codexPath } = seedLiveCodexHome();
      const hash = sessionHash(codexPath);
      const fd = openSync(codexPath, "r");
      try {
        await withServe(home, async (url) => {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(`${url}sessions`, { waitUntil: "load" });

            const liveRow = page.locator('.run-row[data-run-origin="external"]', { hasText: LIVE_PROMPT }).first();
            await liveRow.waitFor({ timeout: 15_000 });
            assert.equal(await liveRow.getAttribute("data-href"), `/run?session=${hash}`);
            await liveRow.click();
            await page.waitForURL(`**/run?session=${hash}`);
            await page.locator("#chatThread .chat-user", { hasText: LIVE_PROMPT }).waitFor({ timeout: 15_000 });
            await page.locator("body[data-live-tail='1']").waitFor();
            assert.equal(await page.locator("#readonlyChip").isVisible(), false, "live chat ends on the tail, not WATCH-ONLY");
          } finally {
            await browser.close();
          }
        });
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});

/* ---- both origins live at once: one counter, one anatomy ---- */

const RUN_PROMPT = "unified parity run prompt marker";
const EXT_PROMPT = "unified parity external prompt marker";

/**
 * External codex live session whose newest assistant turn has a PENDING
 * shell call — its activity line must read as the same in-progress
 * "Running …" a launched run gets.
 */
function seedParityCodex(home) {
  const codexDir = join(home, ".codex", "sessions", "2026", "08", "11");
  mkdirSync(codexDir, { recursive: true });
  const codexPath = join(codexDir, "rollout-parity-ext.jsonl");
  writeJsonlSynced(codexPath, [
    {
      type: "session_meta",
      payload: { id: "unified-parity-ext", cwd: "/home/dev/payments", model_provider: "gpt-5-codex" },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-11T12:00:00.000Z",
      payload: { type: "user_message", message: EXT_PROMPT },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-11T12:00:01.000Z",
      payload: { type: "task_started", turn_id: "turn-live" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-11T12:00:05.000Z",
      payload: {
        role: "assistant",
        content: [
          { type: "output_text", text: "Mapping every call site first." },
          { type: "function_call", call_id: "pc1", name: "shell", arguments: JSON.stringify({ command: "rg -n LedgerClientV1 src" }) },
        ],
      },
    },
  ]);
  return codexPath;
}

/**
 * Stub `claude` standing in for the real CLI: writes a session recording
 * named after its --session-id (spawn identity → deterministic link) whose
 * newest assistant turn holds a pending Bash call, then stays alive.
 */
function mkParityStubDir(home) {
  const stubDir = mkTmp("tq-unichat-stub-");
  const script = `#!/bin/sh
echo "tq-stub:$@"
sid="parity-run"
prev=""
for a in "$@"; do
  if [ "$prev" = "--session-id" ]; then sid="$a"; fi
  prev="$a"
done
proj="$(pwd | tr '/' '-')"
dir="${home}/.claude/projects/$proj"
mkdir -p "$dir"
f="$dir/$sid.jsonl"
cat > "$f" <<EOF
{"type":"user","sessionId":"$sid","cwd":"$PWD","timestamp":"2026-08-11T10:00:00.000Z","uuid":"u-1","isMeta":false,"message":{"content":[{"type":"text","text":"${RUN_PROMPT}"}]}}
{"type":"assistant","sessionId":"$sid","timestamp":"2026-08-11T10:00:04.000Z","uuid":"a-1","message":{"model":"claude-sonnet-4-20250514","content":[{"type":"text","text":"Searching the test tree."},{"type":"tool_use","id":"t-1","name":"Bash","input":{"command":"node --test test/agents"}}],"usage":{"input_tokens":10,"output_tokens":40}}}
EOF
sleep 300
`;
  writeFileSync(join(stubDir, "claude"), script);
  chmodSync(join(stubDir, "claude"), 0o755);
  return stubDir;
}

/** Serve child wired to the PRIVATE tmux socket + stub agent PATH. */
function spawnServeTmux(port, home, stubDir) {
  const whichTmux = spawnSync("which", [TMUX.bin], { encoding: "utf8" });
  const tmuxBin = TMUX.bin.startsWith("/")
    ? TMUX.bin
    : String(whichTmux.stdout || "").trim() || TMUX.bin;
  const child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      TRACEQUEST_LIVE_SESSIONS_HOME: home,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_LR_WATCH: "1",
      TRACEQUEST_TMUX_SOCKET: SOCKET,
      TRACEQUEST_TMUX_SESSION: SESSION,
      TRACEQUEST_TMUX_BIN: tmuxBin,
      // /usr/sbin holds lsof — the open-fd liveness probe needs it.
      PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  });
  child._stdout = "";
  child._stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { child._stdout += chunk; });
  child.stderr.on("data", (chunk) => { child._stderr += chunk; });
  return child;
}

/* ---- every source is first-class: three non-claude agents live at once ---- */

const CURSOR_PROMPT = "unified multi cursor prompt marker";
const FACTORY_PROMPT = "unified multi factory prompt marker";
const OC_PROMPT = "unified multi opencode prompt marker";
const OC_SESSION_ID = "ses_livemulti0123456789abcd";

/**
 * Stub agent process standing in for a real CLI: a script whose PATH-name is
 * the agent binary, launched with the fixture cwd. The kernel rewrites the
 * argv to "/bin/sh /<stubdir>/<binary>", which the detector's anchored
 * argv pgrep pattern ("(^|/)<binary>($| )") matches on both platforms —
 * exactly how an interpreter-run real CLI (cursor-agent execs node) is
 * found. No real agent is ever launched.
 */
function spawnStubAgent(stubDir, binary, cwd) {
  const scriptPath = join(stubDir, binary);
  writeFileSync(scriptPath, "#!/bin/sh\nsleep 300\n");
  chmodSync(scriptPath, 0o755);
  // detached → own process group, so teardown can kill the sh AND its
  // sleep child together (killing only the sh would orphan the sleep).
  const child = spawn(scriptPath, [], { cwd, stdio: "ignore", detached: true });
  return child;
}

function killStubAgent(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

/** Temp workdir whose REALPATH is used everywhere (lsof reports realpaths). */
function mkWorkDir(prefix) {
  return realpathSync(mkTmp(prefix));
}

async function seedMultiLiveHome(home) {
  // cursor: <slug>/agent-transcripts/<uuid>/<uuid>.jsonl in real Cursor row shape.
  const cursorCwd = mkWorkDir("tq-multi-cursor-cwd-");
  const uuid = "uuid-multi-live";
  const cursorPath = join(
    home, ".cursor", "projects", cursorProjectSlug(cursorCwd), "agent-transcripts", uuid, `${uuid}.jsonl`,
  );
  mkdirSync(dirname(cursorPath), { recursive: true });
  writeJsonlSynced(cursorPath, [
    { role: "user", message: { content: [{ type: "text", text: CURSOR_PROMPT }] } },
    {
      role: "assistant",
      message: {
        content: [
          { type: "text", text: "Refactoring the cursor fixture module." },
          { type: "tool_use", name: "Read", input: { path: "/home/dev/multi/README.md" } },
        ],
      },
    },
  ]);

  // factory: ~/.factory/sessions/ws<slug>/*.jsonl in droid row shape.
  const factoryCwd = mkWorkDir("tq-multi-factory-cwd-");
  const factoryPath = join(home, ".factory", "sessions", factoryWorkspaceSlug(factoryCwd), "live-run.jsonl");
  mkdirSync(dirname(factoryPath), { recursive: true });
  writeJsonlSynced(factoryPath, [
    { type: "message", message: { role: "user", content: [{ type: "text", text: FACTORY_PROMPT }] } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Wiring the factory deploy pipeline." },
          { type: "tool_use", name: "Bash", input: { command: "npm run build" } },
        ],
      },
    },
  ]);

  // opencode: db rows behind an opencode:// virtual path (>= 3 messages so
  // discovery's msg_count floor keeps the session).
  const ocCwd = mkWorkDir("tq-multi-oc-cwd-");
  await seedOpenCodeIndexDb(home, [
    {
      id: OC_SESSION_ID,
      title: "unified multi opencode session",
      directory: ocCwd,
      messages: [
        { id: "m-oc-1", role: "user", parts: [{ type: "text", text: OC_PROMPT }] },
        { id: "m-oc-2", role: "assistant", modelID: "oc-model", parts: [{ type: "text", text: "Tracing the opencode indexer." }] },
        { id: "m-oc-3", role: "user", parts: [{ type: "text", text: "keep going" }] },
      ],
    },
  ]);

  return { cursorCwd, cursorPath, factoryCwd, factoryPath, ocCwd };
}

describe("unified live dashboard — every source first-class (served browser)", () => {
  test(
    "cursor, factory, and opencode live simultaneously: one RUNNING row per source, one counter, opencode opens its live chat",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const home = mkTmp("tq-unichat-multi-");
      const stubDir = mkTmp("tq-unichat-multi-stub-");
      const { cursorCwd, factoryCwd, ocCwd } = await seedMultiLiveHome(home);
      const ocHash = sessionHash(`opencode://${OC_SESSION_ID}`);
      const stubs = [
        spawnStubAgent(stubDir, "cursor-agent", cursorCwd),
        spawnStubAgent(stubDir, "droid", factoryCwd),
        spawnStubAgent(stubDir, "opencode", ocCwd),
      ];
      try {
        await withServe(home, async (url) => {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(`${url}sessions`, { waitUntil: "load" });

            // One external RUNNING row per source, each with the full anatomy.
            for (const [source, prompt] of [
              ["cursor", CURSOR_PROMPT],
              ["factory", FACTORY_PROMPT],
              ["opencode", OC_PROMPT],
            ]) {
              const row = page.locator('.run-row[data-run-origin="external"]', { hasText: prompt }).first();
              await row.waitFor({ timeout: 20_000 });
              assert.equal(await row.locator(".run-state-badge").textContent(), "running", `${source}: one status vocabulary`);
              assert.equal(await row.locator(".session-source").count(), 1, `${source}: source pill`);
              assert.match(await row.locator(".session-source").innerText(), new RegExp(source, "i"), `${source}: pill names the source`);
              assert.equal(await row.locator(".session-project").count(), 1, `${source}: project chip`);
              assert.equal(await row.locator(".session-prompt").count(), 1, `${source}: prompt line`);
              assert.equal(await row.locator(".run-activity .run-activity-dot").count(), 1, `${source}: pulsing activity dot`);
            }

            // ONE origin-agnostic counter across all three sources (running, not live).
            await page.locator(".dashboard-stat", { hasText: "running" }).locator(".dashboard-stat-val", { hasText: "3" })
              .waitFor({ timeout: 20_000 });

            // The most exotic origin (a virtual opencode:// session) opens
            // the same live-tail chat as any file recording.
            const ocRow = page.locator('.run-row[data-run-origin="external"]', { hasText: OC_PROMPT }).first();
            assert.equal(await ocRow.getAttribute("data-href"), `/run?session=${ocHash}`);
            await ocRow.click();
            await page.waitForURL(`**/run?session=${ocHash}`);
            await page.locator("#chatThread .chat-user", { hasText: OC_PROMPT }).waitFor({ timeout: 15_000 });
            await page.locator("body[data-live-tail='1']").waitFor();
            await page.locator('#runStatus[data-status="running"]', { hasText: "running" }).waitFor({ timeout: 15_000 });
            assert.equal(await page.locator("#inputText").count(), 0, "no run composer for an externally driven opencode session");
            assert.equal(await page.locator("#readonlyChip").isVisible(), false, "live tail replaces WATCH-ONLY");
          } finally {
            await browser.close();
          }
        });
      } finally {
        for (const stub of stubs) killStubAgent(stub);
        rmSync(home, { recursive: true, force: true });
        rmSync(stubDir, { recursive: true, force: true });
      }
    },
  );
});

describe("unified live dashboard — both origins, one anatomy (served browser)", () => {
  test(
    "a launched run AND an external live session: LIVE counter says 2, identical card anatomy, both open their chats",
    SKIP_NO_BOTH,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const home = mkTmp("tq-unichat-parity-");
      const workDir = mkTmp("tq-unichat-cwd-");
      const stubDir = mkParityStubDir(home);
      const codexPath = seedParityCodex(home);
      const extHash = sessionHash(codexPath);
      const fd = openSync(codexPath, "r");
      const port = await allocEphemeralPort();
      const child = spawnServeTmux(port, home, stubDir);
      try {
        await waitForHttp(port, "/api/agents", child);
        const created = await httpPost(port, "/api/runs", {
          agent: "claude",
          cwd: workDir,
          prompt: RUN_PROMPT,
        });
        assert.equal(created.status, 200, `run create failed: ${created.body}`);
        const runId = JSON.parse(created.body).id;

        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "load" });

          const runRowSel = `.run-row[data-run-id="${runId}"]`;
          // Both cards present, each with the SAME server-derived
          // in-progress activity line ("Running <command>").
          await page.locator(`${runRowSel} .run-activity-text`, { hasText: "Running node --test test/agents" })
            .waitFor({ timeout: 20_000 });
          await page.locator('.run-row[data-run-origin="external"] .run-activity-text', { hasText: "Running rg -n LedgerClientV1 src" })
            .waitFor({ timeout: 20_000 });

          // ONE origin-agnostic counter: the overview running stat counts both.
          await page.locator(".dashboard-stat", { hasText: "running" }).locator(".dashboard-stat-val", { hasText: "2" })
            .waitFor({ timeout: 20_000 });

          // Reload once so the freshly written run recording is indexed into
          // the embedded list (stats parity), then compare anatomy.
          await page.reload({ waitUntil: "load" });
          await page.locator(`${runRowSel} .run-activity-text`).waitFor({ timeout: 20_000 });
          const extRows = page.locator('.run-row[data-run-origin="external"]');
          await extRows.first().waitFor({ timeout: 20_000 });
          assert.equal(await extRows.count(), 1, "exactly one external live card");

          for (const [label, row] of [
            ["run", page.locator(runRowSel)],
            ["external", extRows.first()],
          ]) {
            assert.equal(await row.locator(".run-state-badge").textContent(), "running", `${label}: one status vocabulary`);
            assert.equal(await row.locator(".session-source").count(), 1, `${label}: source pill`);
            assert.equal(await row.locator(".session-id").count(), 1, `${label}: id chip`);
            assert.equal(await row.locator(".session-project").count(), 1, `${label}: project chip`);
            assert.equal(await row.locator(".session-prompt").count(), 1, `${label}: prompt line`);
            assert.equal(await row.locator(".run-activity .run-activity-dot").count(), 1, `${label}: pulsing activity dot`);
            assert.ok((await row.locator(".run-activity-text").innerText()).startsWith("Running "), `${label}: in-progress activity line`);
            assert.equal(await row.locator(".session-stats").count(), 1, `${label}: stat row`);
          }

          // Both cards navigate straight into their live chats.
          await extRows.first().click();
          await page.waitForURL(`**/run?session=${extHash}`);
          await page.locator("#chatThread .chat-user", { hasText: EXT_PROMPT }).waitFor({ timeout: 15_000 });

          await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "load" });
          await page.locator(runRowSel).waitFor({ timeout: 20_000 });
          await page.locator(runRowSel).click();
          await page.waitForURL(`**/run?id=${encodeURIComponent(runId)}`);
          await page.locator("#chatThread .chat-user", { hasText: RUN_PROMPT }).waitFor({ timeout: 15_000 });
        } finally {
          await browser.close();
        }
      } finally {
        await stopServe(child);
        try {
          spawnSync(TMUX.bin, ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
        } catch {
          // best-effort cleanup
        }
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
        rmSync(workDir, { recursive: true, force: true });
        rmSync(stubDir, { recursive: true, force: true });
      }
    },
  );
});
