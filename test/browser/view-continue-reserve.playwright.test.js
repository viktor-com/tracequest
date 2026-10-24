/**
 * The /view page's floating continue composer never covers session content:
 * its strip of the viewport is a bottom bar, so a long What went wrong list
 * and the end of the page stay readable at desktop and phone widths.
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { makeCodexSessionLines } from "../helpers/synthetic-sessions.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmuxPath = spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout?.trim() || "";
const VIEWPORTS = [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]];

async function until(fn, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  assert.fail(`Timed out: ${label}`);
}

/** Nine failing shell calls, each with its own cause, then more chapters below. */
function seedClaude(home) {
  const proj = path.join(home, ".claude", "projects", "reserve-proj");
  fs.mkdirSync(proj, { recursive: true });
  const file = path.join(proj, "reserve-session.jsonl");
  const sid = "reserve-session-aaaa";
  let s = 0;
  const at = () => new Date(Date.UTC(2026, 9, 1, 10, 0, s++)).toISOString();
  const usage = { input_tokens: 100, output_tokens: 20 };
  const lines = [];
  for (let ch = 0; ch < 4; ch++) {
    lines.push({ type: "user", sessionId: sid, cwd: home, timestamp: at(), message: { content: [{ type: "text", text: `step ${ch} of the import` }] } });
    for (let i = 0; i < 9; i++) {
      const id = `bash-${ch}-${i}`;
      const failed = ch === 0;
      lines.push({ type: "assistant", sessionId: sid, timestamp: at(), message: { model: "claude-sonnet-4-20250514", usage, content: [{ type: "tool_use", id, name: "Bash", input: { command: `./import.sh --part ${ch}-${i}` } }] } });
      lines.push({ type: "user", sessionId: sid, timestamp: at(), message: { content: [failed
        ? { type: "tool_result", tool_use_id: id, is_error: true, content: `Exit code 1\nimport.sh: part ${i} failed: cause-${i} reserve-7f3a` }
        : { type: "tool_result", tool_use_id: id, content: `part ${ch}-${i} ok` }] } });
    }
    lines.push({ type: "assistant", sessionId: sid, timestamp: at(), message: { model: "claude-sonnet-4-20250514", usage, content: [{ type: "text", text: `Step ${ch} done.` }] } });
  }
  writeJsonl(file, lines);
  return file;
}

function seedCodex(home) {
  const dir = path.join(home, ".codex", "sessions", "2026", "06", "07");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-0.jsonl");
  const { lines } = makeCodexSessionLines(0, { withError: true, projectCwd: home });
  writeJsonl(file, lines);
  return file;
}

/** Sampled points of the bottom strip whose topmost element is session content. */
function contentInStrip(page, top) {
  return page.evaluate((top) => {
    const app = document.getElementById("app");
    const hits = [];
    for (let y = Math.ceil(top); y < innerHeight; y += 4) {
      for (let x = 1; x < innerWidth; x += 8) {
        const el = document.elementFromPoint(x, y);
        if (el && el !== app && app.contains(el)) hits.push([x, y, el.className]);
      }
    }
    return hits;
  }, top);
}

const geometry = (page) => page.evaluate(() => {
  const box = document.getElementById("continueSessionChip").getBoundingClientRect();
  // The strip the box needs: its own height plus its bottom offset above it.
  return { boxTop: box.top, stripTop: box.top - (innerHeight - box.bottom) };
});

const gate = { ...SKIP_NO_PLAYWRIGHT, ...(!tmuxPath ? { skip: "tmux unavailable" } : {}), timeout: 90_000 };

test("the /view continue composer never covers What went wrong or the end of the page", gate, async (t) => {
  const home = mkTmp("tq-view-reserve-");
  const claudePath = seedClaude(home);
  const codexPath = seedCodex(home);
  fs.mkdirSync(path.join(home, "bin"));
  fs.writeFileSync(path.join(home, "bin", "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const socket = `tq-reserve-${process.pid}`;
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_CACHE_DIR: path.join(home, ".cache"),
    // Only the fake claude resolves: codex sessions are not continuable here.
    PATH: [path.join(home, "bin"), path.dirname(tmuxPath), "/usr/bin", "/bin"].join(":"),
    TRACEQUEST_TMUX_SOCKET: socket,
    TRACEQUEST_TMUX_SESSION: socket,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_LR_WATCH: "1",
  };
  delete env.TRACEQUEST_SKIP_TMUX;
  delete env.TRACEQUEST_TMUX_BIN;
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "bin/tracequest.js"), "serve", "--port", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (b) => { logs += b; });
  child.stderr.on("data", (b) => { logs += b; });
  let browser;
  try {
    await until(async () => { try { return (await fetch(base + "/api/agents")).ok; } catch { return false; } }, "serve startup");
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    for (const [name, viewport] of VIEWPORTS) {
      const page = await browser.newPage({ viewport });
      await page.goto(`${base}/view?id=${sessionHash(claudePath)}`);
      await page.locator("#continueSessionChip").waitFor();
      await page.locator(".error-list-more").waitFor();
      const rows = page.locator(".error-list-item");
      assert.equal(await rows.count(), 6, `${name}: a long What went wrong list`);

      let g = await geometry(page);
      for (let i = 0; i < 6; i++) {
        // Worst case: the row's bottom sits on the viewport's bottom edge.
        await rows.nth(i).evaluate((el) => window.scrollBy(0, el.getBoundingClientRect().bottom - innerHeight));
        assert.deepEqual(await contentInStrip(page, g.stripTop), [], `${name}: no session content shows beside or under the box (row ${i})`);
        // And the row can be read in full above the strip.
        await rows.nth(i).evaluate((el, top) => window.scrollBy(0, el.getBoundingClientRect().bottom - top), g.stripTop);
        const visible = await rows.nth(i).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const pts = [];
          for (let x = r.left + 4; x < r.right; x += 24) pts.push([x, r.top + 2], [x, r.bottom - 2]);
          return pts.every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
        });
        assert.ok(visible, `${name}: What went wrong row ${i} reads in full`);
      }

      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const end = await page.evaluate(() => {
        let bottom = 0;
        for (const el of document.getElementById("app").querySelectorAll("*")) {
          const r = el.getBoundingClientRect();
          if (r.height > 0) bottom = Math.max(bottom, r.bottom);
        }
        return bottom;
      });
      assert.ok(end <= g.stripTop, `${name}: scrolled to the end, the last content (${end}) sits above the box's strip (${g.stripTop})`);
      assert.deepEqual(await contentInStrip(page, g.stripTop), [], `${name}: nothing at the end of the page is under the box`);

      // A failed continue grows the box with a message: the strip follows.
      await page.evaluate(() => {
        const msg = document.getElementById("viewContinueMsg");
        msg.textContent = "the recorded directory /home/dev/a/long/path/that/no/longer/exists is gone; enter an existing directory";
        msg.hidden = false;
      });
      await until(async () => (await geometry(page)).boxTop < g.boxTop, `${name}: the box grows`);
      g = await geometry(page);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      assert.deepEqual(await contentInStrip(page, g.stripTop), [], `${name}: the grown box covers nothing at the end of the page`);
      await page.close();
    }

    const page = await browser.newPage({ viewport: VIEWPORTS[1][1] });
    await page.goto(`${base}/view?id=${sessionHash(codexPath)}`);
    await page.locator("#app .sv-section").first().waitFor();
    const plain = await page.evaluate(() => ({
      composer: !!document.getElementById("continueSessionChip"),
      band: !!document.getElementById("viewContinueBand"),
      padding: getComputedStyle(document.body).paddingBottom,
    }));
    assert.deepEqual(plain, { composer: false, band: false, padding: "0px" }, "a page without the composer is unchanged");
  } catch (err) {
    t.diagnostic(logs);
    throw err;
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref())]);
    spawnSync(tmuxPath || "tmux", ["-L", socket, "kill-server"]);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
