/**
 * Find in the run view (/run?session=): every match is highlighted and
 * counted, including those in collapsed rows, collapsed thoughts and past
 * the "show more" cut, and Enter / Shift+Enter / the step buttons walk them.
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = new URL("../../", import.meta.url).pathname;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (n) => new Date(Date.UTC(2026, 9, 17, 10, 0, 0, n * 10)).toISOString();

async function serve(home) {
  const socket = createServer();
  await new Promise((r) => socket.listen(0, "127.0.0.1", r));
  const port = socket.address().port;
  await new Promise((r) => socket.close(r));
  const child = spawn(process.execPath, ["bin/tracequest.js", "serve", "--port", String(port)], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1", TRACEQUEST_SKIP_LR_WATCH: "1", TRACEQUEST_TMUX_SOCKET: `tq-find-${port}`, TRACEQUEST_TMUX_SESSION: `tq-find-${port}` },
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

const row = (n, role, content) => ({ type: role, sessionId: "find", cwd: "/repo", timestamp: ts(n), uuid: `${role}-${n}`, message: role === "assistant" ? { model: "claude-sonnet-4-20250514", content } : { content } });
const use = (n, id, name, input) => row(n, "assistant", [{ type: "tool_use", id, name, input }]);
const result = (n, id, content) => row(n, "user", [{ type: "tool_result", tool_use_id: id, content }]);
const say = (n, text) => row(n, "assistant", [{ type: "text", text }]);
const think = (n, text) => row(n, "assistant", [{ type: "thinking", thinking: text }]);

/** Five "zebra" hits: two in prose, one in a thought, one in a collapsed row, one at line 30 of a long output. */
function shortRecording() {
  const tail = Array.from({ length: 30 }, (_, i) => (i === 29 ? "zebra at line 30" : `build line ${i + 1}`)).join("\n");
  let n = 0;
  return [
    row(n++, "user", "Find the zebra in the build"),
    think(n++, "The zebra is probably in the logs."),
    use(n++, "r1", "Read", { file_path: "/repo/a.js" }),
    result(n++, "r1", "const zebra = 1;"),
    use(n++, "r2", "Read", { file_path: "/repo/b.js" }),
    result(n++, "r2", "const b = 2;"),
    use(n++, "b1", "Bash", { command: "npm run build" }),
    result(n++, "b1", tail),
    say(n++, "Found the last zebra."),
  ];
}

/** 600 messages: 150 rounds of prose, a call, its result and a reply. */
function longRecording() {
  const rows = [row(0, "user", "Walk the whole repo")];
  let n = 1;
  for (let i = 0; i < 150; i++) {
    rows.push(say(n++, `Step ${i}: looking at module ${i} for the giraffe pattern and other details worth reading.`));
    rows.push(use(n++, `c${i}`, "Bash", { command: `grep -rn pattern src/mod${i}` }));
    rows.push(result(n++, `c${i}`, Array.from({ length: 20 }, (_, j) => `src/mod${i}/f${j}.js:${j}: giraffe ${i}-${j}`).join("\n")));
    rows.push(say(n++, `Module ${i} done.`));
  }
  return rows;
}

async function withServer(recordings, fn) {
  const home = mkTmp("tq-find-");
  const old = new Date(Date.now() - 3600_000);
  const paths = {};
  for (const [name, rows] of Object.entries(recordings)) {
    paths[name] = join(home, `.claude/projects/proj/${name}.jsonl`);
    writeJsonl(paths[name], rows);
    utimesSync(paths[name], old, old);
  }
  const { child, base } = await serve(home);
  const browser = await PLAYWRIGHT.chromium.launch();
  try {
    await fn({ base, browser, paths });
  } finally {
    await browser.close();
    if (child.exitCode == null && child.signalCode == null) {
      child.kill("SIGKILL");
      await new Promise((r) => child.once("exit", r));
    }
    rmSync(home, { recursive: true, force: true });
  }
}

const url = (base, path) => `${base}/run?session=${encodeURIComponent(path)}`;
const count = (page) => page.locator("#chatFindCount").innerText();
const current = (page) => page.evaluate(() => {
  const marks = [...document.querySelectorAll("#chatThread mark.chat-hit")];
  const at = marks.findIndex((m) => m.classList.contains("current"));
  if (at < 0) return null;
  const r = marks[at].getBoundingClientRect();
  const s = document.getElementById("chatScroll").getBoundingClientRect();
  return { at, text: marks[at].closest("[data-block-key]").textContent, inView: r.top >= s.top && r.bottom <= s.bottom };
});

test("run view find: count and steps", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer({ find: shortRecording() }, async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
    await page.goto(url(base, paths.find));
    await page.locator("#chatThread .chat-user").waitFor();
    await page.locator("#chatFind").fill("zebra");
    await page.waitForFunction(() => /of 5$/.test(document.getElementById("chatFindCount").textContent));
    assert.equal(await page.locator("#chatThread mark.chat-hit").count(), 5);
    assert.equal(await count(page), "1 of 5");

    await page.locator("#chatFind").press("Enter");
    assert.equal(await count(page), "2 of 5");
    assert.equal((await current(page)).at, 1);
    await page.locator("#chatFind").press("Shift+Enter");
    await page.locator("#chatFind").press("Shift+Enter");
    assert.equal(await count(page), "5 of 5", "Shift+Enter wraps to the last match");
    const last = await current(page);
    assert.match(last.text, /Found the last zebra/);
    assert.ok(last.inView, "the current match is scrolled into view");

    await page.locator("#chatFindNext").click();
    assert.equal(await count(page), "1 of 5", "the next button wraps to the first match");
    await page.locator("#chatFindPrev").click();
    assert.equal(await count(page), "5 of 5");
    assert.ok((await current(page)).inView);
  });
});

test("run view find: hidden matches in collapsed rows, thoughts and long output", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer({ find: shortRecording() }, async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 400 } });
    await page.goto(url(base, paths.find));
    await page.locator("#chatThread .chat-user").waitFor();
    await page.locator("#chatFind").fill("zebra");
    await page.waitForFunction(() => /of 5$/.test(document.getElementById("chatFindCount").textContent));
    const blocks = await page.evaluate(() => [...document.querySelectorAll("#chatThread mark.chat-hit")].map((m) => m.closest(".chat-thinking, .tg-pre, .chat-message")?.className || ""));
    assert.ok(blocks.some((c) => c.includes("chat-thinking")), "the collapsed thought is opened and marked");
    assert.equal(blocks.filter((c) => c.includes("tg-pre")).length, 2, "the collapsed row and line 30 of the long output are marked");

    for (let i = 0; i < 4; i++) {
      await page.locator("#chatFind").press("Enter");
      const cur = await current(page);
      assert.ok(cur.inView, `match ${cur.at + 1} is scrolled into view`);
    }
    const pre = page.locator("#chatThread .tg-row", { hasText: "npm run build" }).locator(".tg-pre").last();
    assert.match(await pre.innerText(), /zebra at line 30/);
    await page.locator("#chatThread .tg-row", { hasText: "npm run build" }).locator(".tg-more").click();
    assert.ok(!(await pre.innerText()).includes("zebra at line 30"), "show less still collapses the output");
    assert.match(await count(page), / of 4$/);
  });
});

test("run view find: long transcript highlights fast and Ctrl+F focuses the box", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer({ long: longRecording() }, async ({ base, browser, paths }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(url(base, paths.long));
    await page.locator("#chatThread .chat-assistant").last().waitFor();
    await pause(500);
    await page.locator("#chatScroll").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "chatFind");

    const timings = [];
    for (const q of ["giraffe 14", "module 77 ", "giraffe 149-19"]) {
      await page.locator("#chatFind").fill(q.slice(0, -1));
      await page.waitForFunction(() => document.querySelector("#chatThread mark.chat-hit"));
      await page.evaluate(() => {
        window.__tqFind = new Promise((resolve) => {
          const input = document.getElementById("chatFind");
          input.addEventListener("input", () => {
            const t0 = performance.now();
            const done = () => {
              const n = document.getElementById("chatFindCount").textContent;
              if (input.value && /of \d+$/.test(n) && n.split(" of ")[1] !== window.__tqPrev) resolve(performance.now() - t0);
              else requestAnimationFrame(done);
            };
            requestAnimationFrame(done);
          }, { once: true });
        });
        window.__tqPrev = document.getElementById("chatFindCount").textContent.split(" of ")[1];
      });
      await page.locator("#chatFind").press(q.slice(-1) === " " ? "Space" : q.slice(-1));
      timings.push(await page.evaluate(() => window.__tqFind));
    }
    assert.ok(Math.max(...timings) < 200, `first highlight within 200 ms of the last keystroke (${timings.map((t) => Math.round(t)).join(", ")} ms)`);
    assert.equal(await count(page), "1 of 1");
    assert.ok((await current(page)).inView);
  });
});

test("run view find: rail check mark is centred in its circle", SKIP_NO_PLAYWRIGHT, async () => {
  await withServer({ find: shortRecording(), other: shortRecording() }, async ({ base, browser, paths }) => {
    for (const colorScheme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme });
      await page.goto(url(base, paths.find));
      const glyph = page.locator('.rail-row .rail-glyph[data-status="done"]').first();
      await glyph.waitFor();
      const off = await glyph.evaluate((el) => {
        const c = el.getBoundingClientRect();
        const mark = el.firstElementChild;
        if (!mark) return null;
        const m = mark.getBoundingClientRect();
        return { dx: Math.abs(m.left + m.width / 2 - (c.left + c.width / 2)), dy: Math.abs(m.top + m.height / 2 - (c.top + c.height / 2)), w: m.width, h: m.height, cw: c.width };
      });
      assert.ok(off, "the check is a drawn mark, not a font glyph");
      assert.ok(off.dx <= 1 && off.dy <= 1, `centred (${colorScheme}): ${JSON.stringify(off)}`);
      assert.ok(off.w > 4 && off.w < off.cw && off.h > 4 && off.h < off.cw, `inside the circle (${colorScheme}): ${JSON.stringify(off)}`);
      await page.close();
    }
  });
});
