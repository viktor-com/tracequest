/**
 * Filter interaction and empty states: a chapter search that hides every
 * chapter explains itself and offers a reset; an open toolbar menu does not
 * block the sibling toolbar buttons under a real pointer click.
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
const NODE = process.execPath;

function allocEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
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
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`serve exited early (${child.exitCode})\nstdout: ${child._stdout}\nstderr: ${child._stderr}`);
    }
    try {
      if ((await httpStatus(port, reqPath)) === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
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
      TRACEQUEST_TMUX_BIN: "/nonexistent-tracequest-tmux",
      TRACEQUEST_SKIP_LR_WATCH: "1",
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
  child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function seedHome() {
  const home = mkTmp("tracequest-filter-empty-");
  const proj = join(home, ".claude", "projects", "filter-empty-proj");
  mkdirSync(proj, { recursive: true });
  const sessionPath = join(proj, "filter-empty-session.jsonl");
  const sid = "filter-empty-session-aaaa";
  const assistant = (ts, text) => ({
    type: "assistant",
    sessionId: sid,
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 100, output_tokens: 30 },
      content: [{ type: "text", text }],
    },
  });
  const toolUse = (ts, id, name, input) => ({
    type: "assistant",
    sessionId: sid,
    timestamp: ts,
    message: {
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 100, output_tokens: 30 },
      content: [{ type: "tool_use", id, name, input }],
    },
  });
  const toolResult = (ts, id, content) => ({
    type: "user",
    sessionId: sid,
    timestamp: ts,
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
  writeJsonl(sessionPath, [
    {
      type: "user",
      sessionId: sid,
      cwd: "/home/dev/tracequest",
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { content: [{ type: "text", text: "first chapter about the parser" }] },
    },
    toolUse("2026-06-03T10:00:03.000Z", "edit-1", "Edit", { file_path: "/repo/parser.js", old_string: "a", new_string: "b" }),
    toolResult("2026-06-03T10:00:04.000Z", "edit-1", "ok"),
    toolUse("2026-06-03T10:00:04.500Z", "edit-2", "Edit", { file_path: "/repo/lexer.js", old_string: "a", new_string: "b" }),
    toolResult("2026-06-03T10:00:04.800Z", "edit-2", "ok"),
    assistant("2026-06-03T10:00:05.000Z", "Parser looks fine."),
    {
      type: "user",
      sessionId: sid,
      timestamp: "2026-06-03T10:07:00.000Z",
      message: { content: [{ type: "text", text: "second chapter about the renderer" }] },
    },
    toolUse("2026-06-03T10:07:02.000Z", "bash-1", "Bash", { command: "ls" }),
    toolResult("2026-06-03T10:07:03.000Z", "bash-1", "renderer.js"),
    assistant("2026-06-03T10:07:04.000Z", "Renderer looks fine."),
  ]);
  return { home, sessionId: sessionHash(sessionPath) };
}

async function withServe(fn) {
  const { chromium } = PLAYWRIGHT;
  const { home, sessionId } = seedHome();
  const port = await allocEphemeralPort();
  const child = spawnServe(port, home);
  const browser = await chromium.launch();
  try {
    await waitForHttp(port, "/sessions", child);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await fn({ page, base: `http://127.0.0.1:${port}`, sessionId });
  } finally {
    await browser.close();
    await stopServe(child);
    rmSync(home, { recursive: true, force: true });
  }
}

async function pointerClick(page, selector) {
  const box = await page.locator(selector).boundingBox();
  assert.ok(box, `${selector} has a box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

describe("filter interaction and empty states playwright", SKIP_NO_PLAYWRIGHT, () => {
  test("chapter search with no match explains the empty list and Clear filters resets it", async () => {
    await withServe(async ({ page, base, sessionId }) => {
      await page.goto(`${base}/view?id=${sessionId}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chapter-1");
      const empty = page.locator(".chapters-filter-empty");
      assert.equal(await empty.isVisible(), false, "no empty state before filtering");

      await page.fill(".filter-search", "audit-no-such-term");
      await empty.waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await page.locator(".chapter:not(.filter-hidden)").count(), 0, "every chapter is hidden");
      assert.match(await empty.innerText(), /No chapters match/);
      assert.match(await empty.innerText(), /audit-no-such-term/);

      const clear = empty.getByRole("button", { name: "Clear filters" });
      await clear.click();
      await empty.waitFor({ state: "hidden", timeout: 5_000 });
      assert.equal(await page.inputValue(".filter-search"), "", "search box emptied");
      assert.equal(await page.locator(".chapter:not(.filter-hidden)").count(), 2, "every chapter is back");
      assert.equal((await page.textContent("#filter-count")).trim(), "", "count label cleared");
    });
  });

  test("chapter filters that hide every chapter through a tool chip and a file hotspot explain it, are not printed, and Clear filters resets both", async () => {
    await withServe(async ({ page, base, sessionId }) => {
      await page.goto(`${base}/view?id=${sessionId}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#chapter-1");
      const empty = page.locator(".chapters-filter-empty");
      const visibleChapters = () => page.locator(".chapter:not(.filter-hidden)").count();

      await page.click('.filter-chip[data-tool="Bash"]');
      assert.equal(await visibleChapters(), 1, "Bash chip keeps one chapter");
      if ((await page.getAttribute(".file-hotspot-header", "aria-expanded")) !== "true") {
        await page.click(".file-hotspot-header");
      }
      const hotspot = page.locator(".file-hotspot-item", { hasText: "parser.js" });
      await hotspot.click();
      await empty.waitFor({ state: "visible", timeout: 5_000 });
      assert.equal(await visibleChapters(), 0, "chip plus file hotspot hide every chapter");
      assert.equal((await page.textContent("#filter-count")).trim(), "0/2");
      assert.match(await empty.innerText(), /No chapters match these filters/);

      await page.emulateMedia({ media: "print" });
      assert.equal(await empty.isVisible(), false, "the empty state is not printed");
      await page.emulateMedia({ media: "screen" });

      await empty.getByRole("button", { name: "Clear filters" }).click();
      await empty.waitFor({ state: "hidden", timeout: 5_000 });
      assert.equal(await visibleChapters(), 2, "every chapter is back");
      assert.equal(await hotspot.getAttribute("aria-pressed"), "false", "file hotspot filter cleared");
      assert.equal(await page.getAttribute('.filter-chip[data-tool="Bash"]', "aria-pressed"), "false", "chip cleared");
      assert.equal((await page.textContent("#filter-count")).trim(), "", "count label cleared");

      // A later full render must not bring the cleared file filter back.
      await page.keyboard.press("Escape");
      await page.keyboard.press("j");
      await page.keyboard.press("o");
      await page.waitForTimeout(300);
      assert.equal(await visibleChapters(), 2, "still every chapter after a re-render");
      assert.equal((await page.textContent("#filter-count")).trim(), "", "still no count after a re-render");
    });
  });

  test("Display open: a pointer click on a sibling toolbar button switches or closes the menu", async () => {
    await withServe(async ({ page, base }) => {
      await page.goto(`${base}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      const sortBar = page.locator("#sortBar");
      const ageMenu = page.locator("#ageMenu");

      await page.click("#displayToggle");
      await sortBar.waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(() => !!document.querySelector("a.session-row").closest("[inert]")),
        true,
        "session rows stay inert behind the open menu",
      );

      await pointerClick(page, "#ageBtn");
      await ageMenu.waitFor({ state: "visible", timeout: 2_000 });
      assert.equal(await sortBar.isHidden(), true, "Display closed when Time range opened");
      assert.equal(await page.getAttribute("#ageBtn", "aria-expanded"), "true");
      assert.equal(await page.getAttribute("#displayToggle", "aria-expanded"), "false");

      await page.keyboard.press("Escape");
      await ageMenu.waitFor({ state: "hidden", timeout: 2_000 });
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "ageBtn",
        "Escape returns focus to the Time range button, not Display");
      await pointerClick(page, "#ageBtn");
      await ageMenu.waitFor({ state: "visible", timeout: 2_000 });

      await pointerClick(page, "#displayToggle");
      await sortBar.waitFor({ state: "visible", timeout: 2_000 });
      assert.equal(await ageMenu.isHidden(), true, "Time range closed when Display opened");

      await pointerClick(page, "#displayToggle");
      await sortBar.waitFor({ state: "hidden", timeout: 2_000 });
      assert.equal(await page.getAttribute("#displayToggle", "aria-expanded"), "false");
      assert.equal(
        await page.evaluate(() => !!document.querySelector("a.session-row").closest("[inert]")),
        false,
        "page is interactive again once the menu closes",
      );
    });
  });
});
