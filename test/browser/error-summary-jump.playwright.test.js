/**
 * What went wrong: a failure row names the specific cause and, when clicked,
 * opens its chapter on the failed call instead of only flashing a closed card.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const MISSING = "cd: /tmp/tq-missing-dir-7f3a: No such file or directory";
const LATE_CAUSE = "FileNotFoundError: [Errno 2] No such file or directory: '/data/in-7f3a.csv'";
const MCP_CAUSE = "Error: ENOENT: no such file or directory, open '/srv/data/x-7f3a.json'";

async function allocEphemeralPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function httpStatus(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, child, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`serve exited early (${child.exitCode})\n${child._stderr}`);
    try {
      if ((await httpStatus(port, reqPath)) === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${reqPath}`);
}

function spawnServe(port, home) {
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
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
  child._stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { child._stderr += chunk; });
  child.stdout.resume();
  return child;
}

async function stopServe(child) {
  if (child.exitCode != null || child.signalCode != null) return;
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

/**
 * One chapter of 19 shell calls where only the 13th fails, like a real agent
 * that cds into a directory that is not there: the failure sits past the
 * eight commands an opened chapter lists by default.
 */
function seedHome() {
  const home = mkTmp("tracequest-error-jump-");
  const proj = join(home, ".claude", "projects", "error-jump-proj");
  mkdirSync(proj, { recursive: true });
  const sessionPath = join(proj, "error-jump-session.jsonl");
  const sid = "error-jump-session-aaaa";
  const at = (s) => new Date(Date.UTC(2026, 9, 1, 10, 0, s)).toISOString();
  const lines = [
    {
      type: "user", sessionId: sid, cwd: "/home/dev/repo", timestamp: at(0),
      message: { content: [{ type: "text", text: "inspect the pending lock state" }] },
    },
  ];
  for (let i = 0; i < 19; i++) {
    const failed = i === 12;
    const id = `bash-${i}`;
    lines.push({
      type: "assistant", sessionId: sid, timestamp: at(2 + i * 2),
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{
          type: "tool_use", id, name: "Bash",
          input: { command: failed ? "cd /tmp/tq-missing-dir-7f3a; cat state.json" : `sed -n '${i * 10 + 1},${i * 10 + 10}p' lock.py` },
        }],
      },
    });
    lines.push({
      type: "user", sessionId: sid, timestamp: at(3 + i * 2),
      message: {
        content: [failed
          ? { type: "tool_result", tool_use_id: id, is_error: true, content: `Exit code 1\n/bin/bash: line 1: ${MISSING}` }
          : { type: "tool_result", tool_use_id: id, content: `line ${i}` }],
      },
    });
  }
  lines.push({
    type: "assistant", sessionId: sid, timestamp: at(60),
    message: {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 100, output_tokens: 20 },
      content: [{ type: "text", text: "The lock is held by a stale worker." }],
    },
  });
  // A second chapter whose failure names its cause only at the end of a traceback.
  lines.push(
    {
      type: "user", sessionId: sid, timestamp: at(70),
      message: { content: [{ type: "text", text: "run the importer" }] },
    },
    {
      type: "assistant", sessionId: sid, timestamp: at(72),
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: "tool_use", id: "bash-py", name: "Bash", input: { command: "python3 run.py" } }],
      },
    },
    {
      type: "user", sessionId: sid, timestamp: at(73),
      message: {
        content: [{
          type: "tool_result", tool_use_id: "bash-py", is_error: true,
          content: `Exit code 1\nTraceback (most recent call last):\n  File "run.py", line 9, in <module>\n    main()\n  File "run.py", line 5, in main\n    open(path)\n${LATE_CAUSE}`,
        }],
      },
    },
  );
  // A third chapter: an integration call whose long first line would use up the
  // preview's character cap before its cause.
  lines.push(
    {
      type: "user", sessionId: sid, timestamp: at(80),
      message: { content: [{ type: "text", text: "read the fixture through the fs server" }] },
    },
    {
      type: "assistant", sessionId: sid, timestamp: at(82),
      message: {
        model: "claude-sonnet-4-20250514",
        usage: { input_tokens: 100, output_tokens: 20 },
        content: [{ type: "tool_use", id: "mcp-read", name: "mcp__fs__read_file", input: { path: "/srv/data/x-7f3a.json" } }],
      },
    },
    {
      type: "user", sessionId: sid, timestamp: at(83),
      message: {
        content: [{
          type: "tool_result", tool_use_id: "mcp-read", is_error: true,
          content: `{"request":"read_file","attempts":[${'"retry",'.repeat(30)}"last"]}\n\n\n\n${MCP_CAUSE}`,
        }],
      },
    },
  );
  writeJsonl(sessionPath, lines);
  return { home, sessionId: sessionHash(sessionPath) };
}

async function openView(t, width = 1280) {
  const { chromium } = PLAYWRIGHT;
  const { home, sessionId } = seedHome();
  const port = await allocEphemeralPort();
  const child = spawnServe(port, home);
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await stopServe(child);
    rmSync(home, { recursive: true, force: true });
  });
  await waitForHttp(port, "/sessions", child);
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/view?id=${sessionId}`, { waitUntil: "load" });
  await page.waitForSelector(".error-list-item");
  return page;
}

/** Waits until the cause text itself is on screen, not clipped by its output box's height cap. */
async function waitForCauseOnScreen(page, chapterIdx, cause) {
  await page.waitForFunction(({ chapterIdx, cause }) => {
    const out = Array.from(document.querySelectorAll(`#chapter-${chapterIdx} .chapter-detail .chapter-output, #chapter-${chapterIdx} .chapter-detail .chapter-mcp-output`))
      .find((el) => el.textContent.includes(cause));
    if (!out) return false;
    const node = out.firstChild;
    const range = document.createRange();
    const start = node.textContent.indexOf(cause);
    range.setStart(node, start);
    range.setEnd(node, start + cause.length);
    const text = range.getBoundingClientRect();
    const box = out.getBoundingClientRect();
    return text.height > 0 && text.top >= 0 && text.bottom <= Math.min(box.bottom, window.innerHeight);
  }, { chapterIdx, cause }, { timeout: 5_000 });
}

describe("error summary playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("failure jump opens the chapter on the failed call", async (t) => {
    const page = await openView(t);
    const chapter = page.locator("#chapter-0");
    assert.equal(await chapter.evaluate((el) => el.classList.contains("expanded")), false, "chapters start closed");

    await page.locator(".error-list-item").first().click();

    await page.waitForFunction(() => document.querySelector("#chapter-0.expanded"), null, { timeout: 5_000 });
    const failure = chapter.locator(".chapter-detail .chapter-output", { hasText: "No such file or directory" });
    assert.equal(await failure.count(), 1, "the failed call's output is listed in the opened chapter");
    // Smooth scrolling settles within a second or two; wait for the output to land on screen.
    await page.waitForFunction(() => {
      const out = Array.from(document.querySelectorAll("#chapter-0 .chapter-detail .chapter-output"))
        .find((el) => /No such file or directory/.test(el.textContent));
      if (!out) return false;
      const r = out.getBoundingClientRect();
      return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    }, null, { timeout: 5_000 });
  });

  test("failure jump opens on a cause that ends a long traceback", async (t) => {
    const page = await openView(t);
    await page.locator(".error-list-item", { hasText: "FileNotFoundError" }).click();

    await page.waitForFunction(() => document.querySelector("#chapter-1.expanded"), null, { timeout: 5_000 });
    await waitForCauseOnScreen(page, 1, LATE_CAUSE);
  });

  test("failure jump opens on an integration call's cause on a narrow screen", async (t) => {
    const page = await openView(t, 600);
    await page.locator(".error-list-item", { hasText: "ENOENT" }).click();

    await page.waitForFunction(() => document.querySelector("#chapter-2.expanded"), null, { timeout: 5_000 });
    await waitForCauseOnScreen(page, 2, MCP_CAUSE);
  });

  test("failure rows name the cause instead of the exit code", async (t) => {
    const page = await openView(t);
    const row = page.locator(".error-list-item").first();
    const text = await row.innerText();
    assert.match(text, /Missing file or directory/, "row names the Insights error class");
    assert.equal((await row.locator("code").innerText()).trim(), `/bin/bash: line 1: ${MISSING}`, "row shows the line naming the missing directory");
  });
});
