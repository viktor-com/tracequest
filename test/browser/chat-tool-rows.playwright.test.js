/**
 * The chat transcript (/run?session=) reads like Cursor's agent chat: tool calls
 * are collapsed rows, grouped by kind, opened in place. Synthetic Claude, Codex
 * and Cursor recordings go through the real server and a real browser.
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { cursorSessionPath } from "../helpers/multi-source-fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (n) => new Date(Date.UTC(2026, 9, 17, 10, 0, n)).toISOString();
const longOutput = Array.from({ length: 30 }, (_, i) => `build line ${i + 1}`).join("\n");

async function serve(home) {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const child = spawn(process.execPath, ["bin/tracequest.js", "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1", TRACEQUEST_SKIP_LR_WATCH: "1", TRACEQUEST_TMUX_SOCKET: `tq-rows-${port}`, TRACEQUEST_TMUX_SESSION: `tq-rows-${port}` },
  });
  let log = "";
  child.stdout.on("data", (c) => { log += c; });
  child.stderr.on("data", (c) => { log += c; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode != null) throw new Error(log);
    try { await fetch(base + "/__probe"); return { child, base }; } catch { await pause(50); }
  }
  child.kill("SIGKILL");
  throw new Error(`serve did not listen: ${log}`);
}

async function stop(child, home) {
  if (child.exitCode == null && child.signalCode == null) {
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
  }
  rmSync(home, { recursive: true, force: true });
}

const claudeRow = (n, role, content, extra = {}) => ({ type: role, sessionId: "rows", cwd: "/repo", timestamp: ts(n), uuid: `${role}-${n}`, message: role === "assistant" ? { model: "claude-sonnet-4-20250514", content } : { content }, ...extra });
const use = (n, id, name, input) => claudeRow(n, "assistant", [{ type: "tool_use", id, name, input }]);
const result = (n, id, content, isError = false) => claudeRow(n, "user", [{ type: "tool_result", tool_use_id: id, content, is_error: isError }]);
const say = (n, text) => claudeRow(n, "assistant", [{ type: "text", text }]);

function claudeRecording() {
  const rows = [claudeRow(0, "user", "Fix the build and tell me what changed")];
  let n = 1;
  rows.push(say(n++, "Reading the sources first."));
  for (const f of ["a", "b", "c", "d"]) {
    rows.push(use(n++, `read-${f}`, "Read", { file_path: `/repo/src/${f}.js` }));
    rows.push(result(n++, `read-${f}`, `contents of ${f}.js`));
  }
  rows.push(say(n++, "Now the build."));
  rows.push(use(n++, "run-1", "Bash", { command: "npm run build" }));
  rows.push(result(n++, "run-1", longOutput));
  rows.push(use(n++, "run-2", "Bash", { command: "cat /repo/missing.txt" }));
  rows.push(result(n++, "run-2", "cat: /repo/missing.txt: No such file or directory", true));
  rows.push(use(n++, "run-3", "Bash", { command: "git status --short" }));
  rows.push(result(n++, "run-3", "needle-marker modified: src/a.js"));
  rows.push(say(n++, "The build needs one edit."));
  rows.push(use(n++, "edit-1", "Edit", { file_path: "/repo/src/app.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" }));
  rows.push(result(n++, "edit-1", "ok"));
  rows.push(say(n++, "Done: app.ts now sets both constants."));
  return rows;
}

const codexMeta = { timestamp: ts(0), type: "session_meta", payload: { id: "rows", cwd: "/repo" } };
const codexRow = (n, type, payload) => ({ timestamp: ts(n), type, payload });
function codexRecording() {
  return [
    codexMeta,
    codexRow(1, "event_msg", { type: "user_message", message: "List the repo and run the tests" }),
    codexRow(2, "response_item", { type: "function_call", call_id: "c1", name: "exec_command", arguments: JSON.stringify({ cmd: "ls -la" }) }),
    codexRow(3, "response_item", { type: "function_call_output", call_id: "c1", output: "Chunk ID: 1\nProcess exited with code 0\nOutput:\nREADME.md\n" }),
    codexRow(4, "response_item", { type: "function_call", call_id: "c2", name: "exec_command", arguments: JSON.stringify({ cmd: "npm test" }) }),
    codexRow(5, "response_item", { type: "function_call_output", call_id: "c2", output: "Chunk ID: 2\nProcess exited with code 1\nOutput:\n3 tests failed\n" }),
    codexRow(6, "response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "Three tests fail." }] }),
  ];
}

const cursorRecording = [
  { role: "user", message: { content: [{ type: "text", text: "<user_query>\nFind where the config is loaded\n</user_query>" }] } },
  { role: "assistant", message: { content: [
    { type: "text", text: "Looking through the config code." },
    { type: "tool_use", name: "Read", input: { path: "/repo/config/a.js" } },
    { type: "tool_use", name: "Read", input: { path: "/repo/config/b.js" } },
    { type: "tool_use", name: "Read", input: { path: "/repo/config/c.js" } },
    { type: "tool_use", name: "Grep", input: { pattern: "loadConfig", path: "/repo" } },
  ] } },
  { role: "assistant", message: { content: [{ type: "text", text: "It is loaded in config/a.js." }] } },
];

async function withRecordings(fn) {
  const home = mkTmp("tq-rows-");
  const old = new Date(Date.now() - 3600_000);
  const claude = join(home, ".claude/projects/proj/rows.jsonl");
  const codex = join(home, ".codex/sessions/2026/10/17/rollout-rows.jsonl");
  const cursor = cursorSessionPath(home, "proj", "11111111-2222-3333-4444-555555555555");
  writeJsonl(claude, claudeRecording());
  writeJsonl(codex, codexRecording());
  writeJsonl(cursor, cursorRecording);
  for (const p of [claude, codex, cursor]) utimesSync(p, old, old);
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    await fn({ base, browser, paths: { claude, codex, cursor } });
  } finally {
    await browser.close();
    await stop(child, home);
  }
}

const url = (base, path, extra = "") => `${base}/run?session=${encodeURIComponent(path)}${extra}`;
const heads = (page) => page.locator("#chatThread .tg-head, #chatThread .tg-single > .tg-row > .tg-row-head").allInnerTexts().then((all) => all.map((t) => t.replace(/\s+/g, " ").trim()));
const text = (page) => page.evaluate(() => document.getElementById("chatThread").textContent);

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`Claude tool calls collapse into grouped rows at ${viewport.width}px`, SKIP_NO_PLAYWRIGHT, async () => {
    await withRecordings(async ({ base, browser, paths }) => {
      const page = await browser.newPage({ viewport });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(url(base, paths.claude));
      await page.locator("#chatThread .tg-head").first().waitFor();

      // Messages stay as prose; each run of calls is one row.
      const rows = await heads(page);
      assert.equal(rows.length, 3);
      assert.match(rows[0], /^Read 4 files/);
      assert.match(rows[1], /^Ran 3 commands/);
      assert.match(rows[2], /^Edited src\/app\.ts \+2\s*\u22121/);
      assert.match(await page.locator("#chatThread .chat-assistant").last().innerText(), /app\.ts now sets both constants/);

      // Collapsed means not in the page: no tool input or output yet, except the failure.
      const before = await text(page);
      assert.ok(!before.includes("contents of a.js"), "read output is not painted");
      assert.ok(!before.includes("build line 1"), "command output is not painted");
      assert.ok(before.includes("No such file or directory"), "the failed call stays visible");
      const failing = page.locator("#chatThread .chat-tools.has-err");
      assert.equal(await failing.count(), 1);
      assert.match(await failing.locator(".tg-head").innerText(), /2 failed|failed/);
      assert.equal(await failing.locator(".tg-row.err").count(), 1);
      assert.equal(await failing.locator(".tg-row.err .tg-pre.err").isVisible(), true);

      // A clean group opens in place to compact rows, then one row to its output.
      const reads = page.locator("#chatThread .chat-tools", { hasText: "Read 4 files" });
      await reads.locator(".tg-head").click();
      assert.equal(await reads.locator(".tg-row").count(), 4);
      assert.equal(await reads.locator(".tg-pre").count(), 0, "rows are compact until opened");
      await reads.locator(".tg-row-head").nth(1).click();
      assert.match(await reads.locator(".tg-pre").innerText(), /contents of b\.js/);

      // Long output is cut at 12 lines behind "show more".
      const cmds = page.locator("#chatThread .chat-tools", { hasText: "Ran 3 commands" });
      await cmds.locator(".tg-row", { hasText: "npm run build" }).locator(".tg-row-head").click();
      const pre = cmds.locator(".tg-row", { hasText: "npm run build" }).locator(".tg-pre").last();
      assert.ok(!(await pre.innerText()).includes("build line 13"));
      assert.ok((await pre.innerText()).includes("build line 12"));
      await cmds.locator(".tg-more").click();
      assert.ok((await cmds.locator(".tg-row", { hasText: "npm run build" }).locator(".tg-pre").last().innerText()).includes("build line 30"));

      const overflow = await page.evaluate(() => { const s = document.getElementById("chatScroll"); return s.scrollWidth - s.clientWidth; });
      assert.ok(overflow <= 1, `no horizontal overflow (${overflow}px)`);
      assert.deepEqual(errors, []);
    });
  });
}

test("Expand all and Collapse all work, never hide a failure, and are remembered", SKIP_NO_PLAYWRIGHT, async () => {
  await withRecordings(async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url(base, paths.claude));
    const toggle = page.locator("#chatToggleAll");
    await toggle.waitFor({ state: "visible" });
    assert.equal(await toggle.innerText(), "Expand all");

    await toggle.click();
    assert.equal(await toggle.innerText(), "Collapse all");
    assert.equal(await page.locator("#chatThread .tg-row.open").count() >= 8, true, "every row is open");
    assert.ok((await text(page)).includes("contents of a.js"));

    await toggle.click();
    assert.equal(await toggle.innerText(), "Expand all");
    assert.equal(await page.locator("#chatThread .tg-row.open").count(), 0);
    assert.ok(!(await text(page)).includes("contents of a.js"));
    assert.match(await page.locator("#chatThread .chat-tools.has-err .tg-head").innerText(), /failed/, "a collapsed group still says it holds a failure");

    await toggle.click();
    await page.reload();
    await page.locator("#chatToggleAll").waitFor({ state: "visible" });
    assert.equal(await page.locator("#chatToggleAll").innerText(), "Collapse all", "the choice survives a reload");
    assert.ok((await text(page)).includes("contents of a.js"));
  });
});

test("a search hit opens the row that holds it and highlights it", SKIP_NO_PLAYWRIGHT, async () => {
  await withRecordings(async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url(base, paths.claude, "&q=needle-marker"));
    await page.locator("#chatThread mark.chat-hit").first().waitFor();
    const row = page.locator("#chatThread .tg-row.open", { hasText: "git status" });
    assert.equal(await row.count(), 1);
    assert.equal(await page.locator("#chatThread .tg-row.open").count() >= 1, true);
    assert.ok(!(await text(page)).includes("contents of a.js"), "rows without a hit stay closed");
    assert.match(await page.locator("#chatFindCount").innerText(), /\d/);

    // Typing in the find box does the same.
    await page.locator("#chatFind").fill("contents of c.js");
    await page.locator("#chatThread .tg-row.open", { hasText: "c.js" }).waitFor();
    assert.ok(!(await text(page)).includes("contents of d.js"));
    await page.locator("#chatFind").fill("no such phrase anywhere");
    await page.waitForFunction(() => document.getElementById("chatFindCount").textContent === "no matches");
  });
});

test("a #tool- link opens its row and scrolls to it", SKIP_NO_PLAYWRIGHT, async () => {
  await withRecordings(async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 500 } });
    await page.goto(url(base, paths.claude, "#tool-read-c"));
    const row = page.locator('#chatThread .tg-row[data-tool-id="read-c"]');
    await row.locator(".tg-pre").waitFor();
    assert.match(await row.locator(".tg-pre").innerText(), /contents of c\.js/);
    await pause(400);
    const inView = await row.evaluate((el) => { const r = el.getBoundingClientRect(); const s = document.getElementById("chatScroll").getBoundingClientRect(); return r.top >= s.top && r.bottom <= s.bottom; });
    assert.ok(inView, "the linked row is scrolled into view");
    assert.equal(await page.locator("#chatThread .tg-row.open").count() >= 1, true);
  });
});

test("Codex and Cursor recordings get the same grouping", SKIP_NO_PLAYWRIGHT, async () => {
  await withRecordings(async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url(base, paths.codex));
    await page.locator("#chatThread .tg-head").first().waitFor();
    assert.match((await heads(page))[0], /^Ran 2 commands/);
    assert.match(await page.locator("#chatThread .chat-tools.has-err").innerText(), /3 tests failed/, "the failed Codex call stays visible");

    await page.goto(url(base, paths.cursor));
    await page.locator("#chatThread .tg-head").first().waitFor();
    assert.deepEqual((await heads(page)).map((t) => t.split(" ").slice(0, 3).join(" ")), ["Read 3 files", "Searched loadConfig"]);
    await page.locator("#chatThread .tg-head").first().click();
    await page.locator("#chatThread .tg-row-head").first().click();
    assert.match(await page.locator("#chatThread .tg-none").first().innerText(), /No output recorded/);
  });
});

test("an opened group and row keep their state while the recording grows", SKIP_NO_PLAYWRIGHT, async () => {
  await withRecordings(async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url(base, paths.claude));
    const reads = page.locator("#chatThread .chat-tools", { hasText: "Read 4 files" });
    await reads.locator(".tg-head").click();
    await reads.locator(".tg-row-head").nth(2).click();
    assert.match(await reads.locator(".tg-pre").innerText(), /contents of c\.js/);

    // A fifth read arrives in the same run of reads: the group grows and stays as the reader left it.
    const more = [claudeRow(40, "assistant", [{ type: "tool_use", id: "read-late", name: "Read", input: { file_path: "/repo/src/e.js" } }]), claudeRow(41, "user", [{ type: "tool_result", tool_use_id: "read-late", content: "contents of e.js" }])];
    // Splice before the "Now the build." message so the new call joins the existing group.
    const lines = readFileSync(paths.claude, "utf8").trim().split("\n");
    const at = lines.findIndex((l) => l.includes("Now the build."));
    lines.splice(at, 0, ...more.map((r) => JSON.stringify(r)));
    writeFileSync(paths.claude, lines.join("\n") + "\n");
    await page.locator("#chatThread .chat-tools", { hasText: "Read 5 files" }).waitFor({ timeout: 12000 });
    const grown = page.locator("#chatThread .chat-tools", { hasText: "Read 5 files" });
    assert.equal(await grown.locator(".tg-row").count(), 5, "the group stayed open");
    assert.match(await grown.locator(".tg-row.open .tg-pre").innerText(), /contents of c\.js/, "the opened row stayed open");
  });
});
