/**
 * "Open in <App>" end to end on a hub serve (facts oalbar, oalfly): the
 * read-only bar of a running session and the Runs side panel header carry
 * the origin app's link for a session that has one and no button for one
 * that does not.
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
const THREAD = "0199a7f3-0000-7000-8000-000000000007";

/** A Grok session waiting on its prompt, run from `cwd` (live while a process sits there). */
function writePendingGrok(home, cwd, id) {
  const dir = grokSessionDir(home, cwd, id, "grok");
  writeJsonl(join(dir, "chat_history.jsonl"), [
    { type: "system", content: "You are Grok." },
    { type: "user", content: [{ type: "text", text: `<user_query>\n${id} prompt\n</user_query>` }], prompt_index: 0 },
  ]);
  return dir;
}

function seed(home) {
  const ts = new Date(Date.now() - 3_600_000).toISOString();
  writeJsonl(join(home, `.codex/sessions/2026/10/01/rollout-2026-10-01T11-00-00-${THREAD}.jsonl`), [
    { timestamp: ts, type: "session_meta", payload: { id: THREAD, timestamp: ts, cwd: "/home/dev/repo" } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex app run" }] } },
    { timestamp: ts, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
  ]);
  writeJsonl(join(home, ".claude/projects/-tmp-plain/plain-session.jsonl"), [
    { type: "user", sessionId: "plain-session", timestamp: ts, cwd: "/tmp/plain", message: { role: "user", content: "Plain terminal run" } },
    { type: "assistant", sessionId: "plain-session", timestamp: ts, message: { role: "assistant", model: "claude-sonnet-4-20250514", content: [{ type: "text", text: "Done" }] } },
  ]);
  const taskDir = join(home, ".kandev/tasks", WS, TASK);
  const workDir = join(home, "work");
  mkdirSync(taskDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const kandevCwd = realpathSync(taskDir);
  const workCwd = realpathSync(workDir);
  return {
    kandev: { cwd: kandevCwd, path: writePendingGrok(home, kandevCwd, "grok-kandev") },
    plain: { cwd: workCwd, path: writePendingGrok(home, workCwd, "grok-plain") },
  };
}

test("Open in <App>: read-only bar and Runs side panel", { ...SKIP_NO_PLAYWRIGHT, timeout: 120_000 }, async () => {
  const home = mkTmp("tq-origin-app-link-");
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_HOSTS_DIR: join(home, ".local/share/tracequest/hosts"),
    TRACEQUEST_CACHE_DIR: join(home, ".cache/tracequest"),
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tq-origin-app-link-tmux",
  };
  const grok = seed(home);
  const procs = [grok.kandev, grok.plain].map(({ cwd }) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"], { cwd, stdio: "ignore" }));
  writeFileSync(join(home, ".grok/active_sessions.json"), JSON.stringify([
    { session_id: "grok-kandev", pid: procs[0].pid, cwd: grok.kandev.cwd, opened_at: new Date().toISOString() },
    { session_id: "grok-plain", pid: procs[1].pid, cwd: grok.plain.cwd, opened_at: new Date().toISOString() },
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

    // Read-only bar of a running session: a Kandev task's session links to its task.
    await page.goto(`${base}/run?session=${sessionHash(grok.kandev.path)}`);
    const bar = page.locator("#liveTailForm");
    await bar.waitFor({ state: "visible", timeout: 15_000 });
    const barLink = bar.locator("#originAppBar");
    await barLink.waitFor({ state: "visible" });
    assert.equal(await barLink.textContent(), "Open in Kandev");
    assert.equal(await barLink.getAttribute("href"), `http://127.0.0.1:38429/t/${TASK}`);
    assert.equal(await barLink.getAttribute("target"), "_blank");

    // A running session with no per-session link: the bar shows no button.
    await page.goto(`${base}/run?session=${sessionHash(grok.plain.path)}`);
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
    await openRun("Codex app run");
    await panelLink.waitFor({ state: "visible" });
    assert.equal(await panelLink.textContent(), "Open in Codex");
    assert.equal(await panelLink.getAttribute("href"), `codex://threads/${THREAD}`);
    await openRun("Plain terminal run");
    await panelLink.waitFor({ state: "hidden" });
    assert.equal(await panelLink.getAttribute("href"), null);

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
