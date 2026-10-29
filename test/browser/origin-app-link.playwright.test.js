/**
 * "Open in <App>" end to end on a hub serve (facts oalbar, oalfly): the
 * read-only bar of a running session and the Runs side panel header carry a
 * native app link only for sessions recorded on this machine whose app has
 * one; imported sessions and apps without a link show no button.
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { grokSessionDir } from "../../src/sessions/session-layout.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "bin/tracequest.js");
const WS = "8e0bfb9e-1b7f-4aca-8b0e-2eb321a21b07";
const TASK = "913978b4-50a2-4fbc-9a75-a0c7c639a2dc";
const LIVE_THREAD = "0199a7f3-0000-7000-8000-000000000001";
const DONE_THREAD = "0199a7f3-0000-7000-8000-000000000002";
const HOST_THREAD = "0199a7f3-0000-7000-8000-000000000003";
const CLAUDE_ID = "5ffccdb0-f62c-4825-8fc8-15489b4624c9";

/** A Codex rollout under `home`; `running` leaves its task open. */
function writeCodex(home, thread, cwd, prompt, running) {
  const ts = new Date(Date.now() - 600_000).toISOString();
  const path = join(home, `.codex/sessions/2026/10/01/rollout-2026-10-01T11-00-00-${thread}.jsonl`);
  writeJsonl(path, [
    { timestamp: ts, type: "session_meta", payload: { id: thread, timestamp: ts, cwd } },
    { timestamp: ts, type: "event_msg", payload: { type: "task_started" } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: prompt }] } },
    ...(running ? [] : [
      { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
      { timestamp: ts, type: "event_msg", payload: { type: "task_complete" } },
    ]),
  ]);
  return path;
}

function seed(home, hostsDir) {
  const ts = new Date(Date.now() - 600_000).toISOString();
  const codexDir = join(home, "codex-work");
  const taskDir = join(home, ".kandev/tasks", WS, TASK);
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(taskDir, { recursive: true });
  const codexCwd = realpathSync(codexDir);
  const kandevCwd = realpathSync(taskDir);
  const liveCodex = writeCodex(home, LIVE_THREAD, codexCwd, "Live Codex run", true);
  writeCodex(home, DONE_THREAD, "/home/dev/repo", "Finished Codex run", false);
  writeCodex(join(hostsDir, "builder"), HOST_THREAD, "/home/dev/repo", "Imported Codex run", false);
  writeJsonl(join(home, `.claude/projects/-home-dev-shop/${CLAUDE_ID}.jsonl`), [
    { type: "user", sessionId: CLAUDE_ID, timestamp: ts, cwd: "/home/dev/shop", message: { role: "user", content: "Finished Claude run" } },
    { type: "assistant", sessionId: CLAUDE_ID, timestamp: ts, message: { role: "assistant", model: "claude-sonnet-4-20250514", content: [{ type: "text", text: "Done" }] } },
  ]);
  // A running Grok session in a Kandev task folder: Kandev and Grok register no session link.
  const kandevGrok = grokSessionDir(home, kandevCwd, "grok-kandev", "grok");
  writeJsonl(join(kandevGrok, "chat_history.jsonl"), [
    { type: "system", content: "You are Grok." },
    { type: "user", content: [{ type: "text", text: "<user_query>\nKandev Grok run\n</user_query>" }], prompt_index: 0 },
  ]);
  const doneGrok = grokSessionDir(home, kandevCwd, "grok-kandev-done", "grok");
  writeJsonl(join(doneGrok, "chat_history.jsonl"), [
    { type: "system", content: "You are Grok." },
    { type: "user", content: [{ type: "text", text: "<user_query>\nFinished Kandev Grok run\n</user_query>" }], prompt_index: 0 },
    { type: "assistant", content: "Done", model_id: "grok-4" },
  ]);
  writeJsonl(join(doneGrok, "events.jsonl"), [{ ts, type: "turn_started" }, { ts, type: "turn_ended" }]);
  return { codexCwd, kandevCwd, liveCodex, kandevGrok };
}

test("Open in <App>: read-only bar and Runs side panel", { ...SKIP_NO_PLAYWRIGHT, timeout: 120_000 }, async () => {
  const home = mkTmp("tq-origin-app-link-");
  const hostsDir = join(home, ".local/share/tracequest/hosts");
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_HOSTS_DIR: hostsDir,
    TRACEQUEST_CACHE_DIR: join(home, ".cache/tracequest"),
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tq-origin-app-link-tmux",
  };
  const s = seed(home, hostsDir);
  const idle = ["-e", "setInterval(() => {}, 1e9)"];
  // Stand-ins for the agents' processes: a `codex` in the live Codex session's cwd, a grok in the task folder.
  const procs = [
    spawn(process.execPath, idle, { cwd: s.codexCwd, argv0: join(s.codexCwd, "codex"), stdio: "ignore" }),
    spawn(process.execPath, idle, { cwd: s.kandevCwd, stdio: "ignore" }),
  ];
  writeFileSync(join(home, ".grok/active_sessions.json"), JSON.stringify([
    { session_id: "grok-kandev", pid: procs[1].pid, cwd: s.kandevCwd, opened_at: new Date().toISOString() },
  ]));
  let server;
  let browser;
  try {
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const { port } = reservation.address();
    await new Promise((resolve) => reservation.close(resolve));
    server = spawn(process.execPath, [BIN, "serve", "--hub", "--port", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    server.stdout.on("data", (chunk) => { output += chunk; });
    server.stderr.on("data", (chunk) => { output += chunk; });
    const base = `http://127.0.0.1:${port}`;
    await assert.doesNotReject(async () => {
      for (let i = 0; i < 150; i++) {
        assert.equal(server.exitCode, null, output);
        try { if ((await fetch(`${base}/sessions`)).ok) return; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(output || "Server did not start");
    });

    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));

    // Read-only bar of a running local Codex session: Open in Codex.
    const bar = page.locator("#liveTailForm");
    await page.goto(`${base}/run?session=${sessionHash(s.liveCodex)}`);
    await bar.waitFor({ state: "visible", timeout: 15_000 });
    const barLink = bar.locator("#originAppBar");
    await barLink.waitFor({ state: "visible" });
    assert.equal(await barLink.textContent(), "Open in Codex");
    assert.equal(await barLink.getAttribute("href"), `codex://threads/${LIVE_THREAD}`);

    // A running session in a Kandev task folder has no native link: no button.
    await page.goto(`${base}/run?session=${sessionHash(s.kandevGrok)}`);
    await bar.waitFor({ state: "visible", timeout: 15_000 });
    assert.equal(await bar.locator("#originAppBar").isVisible(), false);
    assert.equal(await bar.locator("#originAppBar").getAttribute("href"), null);

    // Runs side panel header.
    await page.goto(`${base}/sessions`);
    await page.waitForSelector("a.session-row");
    const panelLink = page.locator("#sessionFlyout .session-flyout-head #sessionFlyoutOrigin");
    const openRun = async (prompt) => {
      await page.locator(".session-row-wrap", { hasText: prompt }).locator("a.session-row").click();
      await page.locator("#sessionFlyout").waitFor({ state: "visible" });
    };
    const expectLink = async (prompt, text, href) => {
      await openRun(prompt);
      await page.waitForFunction(([t, h]) => {
        const a = document.getElementById("sessionFlyoutOrigin");
        return a && !a.hidden && a.textContent === t && a.getAttribute("href") === h;
      }, [text, href], { timeout: 5_000 });
    };
    const expectNone = async (prompt) => {
      await openRun(prompt);
      await panelLink.waitFor({ state: "hidden" });
      assert.equal(await panelLink.getAttribute("href"), null, prompt);
    };
    await expectLink("Finished Codex run", "Open in Codex", `codex://threads/${DONE_THREAD}`);
    await expectNone("Imported Codex run");
    await expectLink("Finished Claude run", "Open in Claude", `claude://resume?session=${CLAUDE_ID}`);
    await expectNone("Finished Kandev Grok run");

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    for (const child of [server, ...procs]) {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGKILL");
        await stopped;
      }
    }
    rmSync(home, { recursive: true, force: true });
  }
});
