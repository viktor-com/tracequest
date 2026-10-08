/**
 * Playwright MEASURE dimension A on the live composer: #liveTailInput
 * on /run?session=<hash>, not #inputText / #homePrompt.
 * Fact anchors: edglive edgtype
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonlSynced, writeClaudeJsonl, CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const LIVE_PROMPT = "editable-guard liveTailInput prompt marker";
const PRINTABLE = "/ojkg?x";

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

function seedLiveCodexHome() {
  const home = mkTmp("tracequest-editable-guard-livetail-");
  const codexDir = join(home, ".codex", "sessions", "2026", "08", "11");
  mkdirSync(codexDir, { recursive: true });
  const codexPath = join(codexDir, "rollout-editable-guard.jsonl");
  writeJsonlSynced(codexPath, [
    {
      type: "session_meta",
      payload: { id: "editable-guard-live-tail", cwd: "/home/dev/editable-guard", model_provider: "gpt-5-codex" },
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
      payload: { role: "assistant", content: [{ type: "output_text", text: "noted editable-guard" }] },
    },
  ]);
  return { home, codexPath };
}

describe("editable-guard live composer", () => {
  let child;
  let browser;

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (child) await stopServe(child);
  });

  test(
    "Playwright page.keyboard.type(\"/ojkg?x\") into the live composer #liveTailInput inserts those characters and does not slash-to-search, G-chord, or steal focus",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { home, codexPath } = seedLiveCodexHome();
      const hash = sessionHash(codexPath);
      const fd = openSync(codexPath, "r");
      try {
        const port = await allocEphemeralPort();
        child = spawnServe(port, home);
        await waitForHttp(port, "/api/sessions", child);

        browser = await PLAYWRIGHT.chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`http://127.0.0.1:${port}/run?session=${hash}`, { waitUntil: "load" });
        await page.locator("body[data-live-tail='1']").waitFor({ timeout: 15_000 });
        const liveTail = page.locator("#liveTailInput");
        await liveTail.waitFor({ state: "visible" });
        assert.equal(await page.locator("#inputText").count(), 0, "live watch page has no #inputText");
        assert.equal(await page.locator("#homePrompt").count(), 0, "live watch page has no #homePrompt");

        await liveTail.click();
        await page.waitForFunction(() => document.activeElement && document.activeElement.id === "liveTailInput");
        const hrefBefore = page.url();
        // GitHub return, not capture-cut: a target-phase listener on the field
        // must see each keydown. document-capture stopPropagation would hide them.
        await page.evaluate(() => {
          const el = document.getElementById("liveTailInput");
          window.__tqLiveTailKeydown = [];
          el.addEventListener("keydown", (e) => {
            window.__tqLiveTailKeydown.push(e.key);
          });
        });
        await page.keyboard.type(PRINTABLE);

        const value = await liveTail.inputValue();
        assert.equal(value, PRINTABLE, `#liveTailInput value after page.keyboard.type('${PRINTABLE}')`);
        for (const ch of PRINTABLE) {
          assert.ok(value.includes(ch), `#liveTailInput missing '${ch}'`);
        }
        const reached = await page.evaluate(() => window.__tqLiveTailKeydown);
        assert.deepEqual(
          reached,
          PRINTABLE.split(""),
          "keydown of /ojkg?x must reach #liveTailInput (GitHub keyDownHandler return, not capture stopPropagation)",
        );
        assert.equal(
          await page.evaluate(() => document.activeElement && document.activeElement.id),
          "liveTailInput",
          "/ must not steal focus to the rail filter",
        );
        assert.equal(page.url(), hrefBefore, "G-chord must not navigate");
        assert.equal(await page.locator("#cmdkOverlay").getAttribute("hidden"), "");
        const railFilter = page.locator("#filterInput");
        if (await railFilter.count()) {
          assert.notEqual(await railFilter.inputValue(), "/", "slash must not land in the rail filter");
        }

        await page.evaluate(() => {
          const btn = document.createElement("button");
          btn.id = "tqHotkeyScopeLiveTail";
          btn.setAttribute("data-hotkey-scope", "liveTailInput");
          btn.setAttribute("data-hotkey", "/,o,j,k,g");
          document.body.appendChild(btn);
        });
        await liveTail.fill("");
        await liveTail.click();
        await page.waitForFunction(() => document.activeElement && document.activeElement.id === "liveTailInput");
        await page.keyboard.type(PRINTABLE);
        assert.equal(
          await liveTail.inputValue(),
          PRINTABLE,
          `#liveTailInput still gets ${PRINTABLE} when a data-hotkey-scope node is present`,
        );
        assert.equal(
          await page.evaluate(() => document.activeElement && document.activeElement.id),
          "liveTailInput",
          "data-hotkey-scope must not let unscoped / steal focus",
        );
        assert.equal(page.url(), hrefBefore, "data-hotkey-scope must not let unscoped G-chord navigate");

        const meta = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.press(`${meta}+k`);
        await page.waitForSelector("#cmdkInput:focus");
        await page.keyboard.type(PRINTABLE);
        const cmdk = await page.evaluate(() => ({
          value: document.getElementById("cmdkInput") && document.getElementById("cmdkInput").value,
          activeId: document.activeElement && document.activeElement.id,
          href: location.href,
        }));
        assert.equal(cmdk.value, PRINTABLE, `#cmdkInput still gets ${PRINTABLE}`);
        assert.equal(cmdk.activeId, "cmdkInput", "Cmd+K combobox keeps focus while typing /ojkg?x");
        assert.equal(cmdk.href, hrefBefore, "G-chord must not navigate from #cmdkInput");
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
        if (child) {
          await stopServe(child);
          child = null;
        }
      }
    },
  );

  test(
    "Playwright page.keyboard.type(\"/ojkg?x\") into #cmdkInput still gets those characters when a data-hotkey-scope node is present",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { home, codexPath } = seedLiveCodexHome();
      const hash = sessionHash(codexPath);
      const fd = openSync(codexPath, "r");
      try {
        const port = await allocEphemeralPort();
        child = spawnServe(port, home);
        await waitForHttp(port, "/api/sessions", child);

        if (browser) await browser.close().catch(() => {});
        browser = await PLAYWRIGHT.chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`http://127.0.0.1:${port}/run?session=${hash}`, { waitUntil: "load" });
        await page.locator("body[data-live-tail='1']").waitFor({ timeout: 15_000 });
        await page.evaluate(() => {
          const btn = document.createElement("button");
          btn.setAttribute("data-hotkey-scope", "cmdkInput");
          btn.setAttribute("data-hotkey", "/,o,j,k,g");
          document.body.appendChild(btn);
          const el = document.activeElement;
          if (el && el !== document.body && el.blur) el.blur();
        });
        const hrefBefore = page.url();
        const meta = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.press(`${meta}+k`);
        await page.waitForSelector("#cmdkInput:focus");
        await page.keyboard.type(PRINTABLE);
        const shot = await page.evaluate(() => ({
          value: document.getElementById("cmdkInput") && document.getElementById("cmdkInput").value,
          activeId: document.activeElement && document.activeElement.id,
          href: location.href,
          ws: document.activeElement && document.activeElement.id === "workspaceSearch",
        }));
        assert.equal(shot.value, PRINTABLE, `#cmdkInput still gets ${PRINTABLE} with a data-hotkey-scope node present`);
        assert.equal(shot.activeId, "cmdkInput");
        assert.equal(shot.ws, false, "/ must not focus #workspaceSearch");
        assert.equal(shot.href, hrefBefore, "G-chord must not navigate from #cmdkInput");
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
        if (child) {
          await stopServe(child);
          child = null;
        }
      }
    },
  );

  test(
    "idle g then type in #liveTailInput then blur then c does not navigate to /",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { home, codexPath } = seedLiveCodexHome();
      const hash = sessionHash(codexPath);
      const fd = openSync(codexPath, "r");
      try {
        const port = await allocEphemeralPort();
        child = spawnServe(port, home);
        await waitForHttp(port, "/api/sessions", child);

        if (browser) await browser.close().catch(() => {});
        browser = await PLAYWRIGHT.chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`http://127.0.0.1:${port}/run?session=${hash}`, { waitUntil: "load" });
        await page.locator("body[data-live-tail='1']").waitFor({ timeout: 15_000 });
        const liveTail = page.locator("#liveTailInput");
        await liveTail.waitFor({ state: "visible" });

        await page.evaluate(() => {
          const el = document.activeElement;
          if (el && typeof el.blur === "function") el.blur();
        });
        await page.waitForFunction(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return true;
          const name = String(el.tagName || "").toLowerCase();
          return name !== "input" && name !== "textarea" && name !== "select" && !el.isContentEditable;
        });

        await page.keyboard.press("g");
        await liveTail.click();
        await page.waitForFunction(() => document.activeElement && document.activeElement.id === "liveTailInput");
        await liveTail.fill("");
        await page.keyboard.type(PRINTABLE);
        assert.equal(
          await liveTail.inputValue(),
          PRINTABLE,
          `#liveTailInput still inserts ${PRINTABLE} after an idle g`,
        );
        const hrefWhileTyping = page.url();
        assert.notEqual(new URL(hrefWhileTyping).pathname, "/", "typing in #liveTailInput must not complete g c");

        await page.evaluate(() => {
          const el = document.getElementById("liveTailInput");
          if (el && typeof el.blur === "function") el.blur();
        });
        await page.waitForFunction(() => {
          const el = document.activeElement;
          return !el || el.id !== "liveTailInput";
        });
        const hrefBeforeC = page.url();
        await page.keyboard.press("c");
        await page.waitForFunction((before) => location.href === before || location.pathname === "/", hrefBeforeC);
        const afterC = new URL(page.url());
        assert.notEqual(afterC.pathname, "/", "c after typing in #liveTailInput must not complete g c and navigate to /");
        assert.equal(page.url(), hrefBeforeC, "armed g must not survive typing then blur");

        await page.evaluate(() => {
          const el = document.activeElement;
          if (el && typeof el.blur === "function") el.blur();
        });
        await page.waitForFunction(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return true;
          const name = String(el.tagName || "").toLowerCase();
          return name !== "input" && name !== "textarea" && name !== "select" && !el.isContentEditable;
        });
        await page.keyboard.press("g");
        await page.keyboard.press("c");
        await page.waitForFunction(() => location.pathname === "/");
        assert.equal(new URL(page.url()).pathname, "/", "idle G then C still jumps when no field is focused");
      } finally {
        closeSync(fd);
        rmSync(home, { recursive: true, force: true });
        if (child) {
          await stopServe(child);
          child = null;
        }
      }
    },
  );
});

function seedFlyoutGuardHome() {
  const home = mkTmp("tracequest-editable-guard-flyout-");
  const dir = join(home, ".claude", "projects", "-home-dev-tracequest");
  mkdirSync(dir, { recursive: true });
  writeClaudeJsonl(dir, "flyout-alpha.jsonl", [
    {
      type: "user",
      sessionId: "flyout-guard-alpha",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T12:00:00.000Z",
      uuid: "u-flyout-a-1",
      isMeta: false,
      message: { content: [{ type: "text", text: "flyout-guard alpha prompt" }] },
    },
    {
      type: "assistant",
      sessionId: "flyout-guard-alpha",
      timestamp: "2026-06-03T12:00:01.000Z",
      uuid: "a-flyout-a-1",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "Noted flyout-guard alpha" }],
      },
    },
  ]);
  writeClaudeJsonl(dir, "flyout-beta.jsonl", [
    {
      type: "user",
      sessionId: "flyout-guard-beta",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T11:00:00.000Z",
      uuid: "u-flyout-b-1",
      isMeta: false,
      message: { content: [{ type: "text", text: "flyout-guard beta prompt" }] },
    },
    {
      type: "assistant",
      sessionId: "flyout-guard-beta",
      timestamp: "2026-06-03T11:00:01.000Z",
      uuid: "a-flyout-b-1",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "Noted flyout-guard beta" }],
      },
    },
  ]);
  return home;
}

describe("editable-guard session flyout capture j/k", () => {
  test(
    "focused input inside #sessionFlyout consumes j/k; idle peek j/k still step; Cmd+K inserts /ojkg?x",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const home = seedFlyoutGuardHome();
      let flyChild;
      let flyBrowser;
      try {
        const port = await allocEphemeralPort();
        flyChild = spawnServe(port, home);
        await waitForHttp(port, "/sessions", flyChild);

        flyBrowser = await PLAYWRIGHT.chromium.launch({ headless: true });
        const page = await flyBrowser.newPage({ viewport: { width: 1440, height: 900 } });
        await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("a.session-row");
        const ids = await page.locator(".session-row-wrap").evaluateAll((els) =>
          els.map((el) => el.getAttribute("data-session-id")).filter(Boolean),
        );
        assert.ok(ids.length >= 2, `need two rows to step peek, got ${ids.join(",")}`);

        await page.locator("a.session-row").first().click();
        await page.locator("#sessionFlyout").waitFor({ state: "visible" });
        const first = await page.locator(".session-row-wrap.is-selected").getAttribute("data-session-id");

        const typed = await page.evaluate(() => {
          const fly = document.getElementById("sessionFlyout");
          const input = document.createElement("input");
          input.id = "flyoutProbe";
          input.type = "text";
          fly.appendChild(input);
          input.focus();
          return document.activeElement && document.activeElement.id;
        });
        assert.equal(typed, "flyoutProbe", "probe input inside #sessionFlyout is focused");
        await page.keyboard.type("jk/ogx");
        const fieldShot = await page.evaluate(() => {
          const el = document.getElementById("flyoutProbe");
          const sel = document.querySelector(".session-row-wrap.is-selected");
          return {
            value: el && el.value,
            activeId: document.activeElement && document.activeElement.id,
            selectedId: sel && sel.getAttribute("data-session-id"),
            flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
          };
        });
        assert.equal(fieldShot.value, "jk/ogx", "focused flyout input keeps j and k (critic sequence jk/ogx)");
        assert.equal(fieldShot.activeId, "flyoutProbe");
        assert.equal(fieldShot.selectedId, first, "j/k in the flyout input must not peekStep");
        assert.equal(fieldShot.flyHidden, false);

        await page.evaluate(() => {
          const el = document.getElementById("flyoutProbe");
          if (el) el.remove();
          const active = document.activeElement;
          if (active && typeof active.blur === "function") active.blur();
        });
        await page.keyboard.press("j");
        await page.waitForFunction((prev) => {
          const sel = document.querySelector(".session-row-wrap.is-selected");
          return sel && sel.getAttribute("data-session-id") && sel.getAttribute("data-session-id") !== prev;
        }, first);
        const second = await page.locator(".session-row-wrap.is-selected").getAttribute("data-session-id");
        assert.notEqual(second, first, "idle j still steps peek when no form field is focused");
        await page.keyboard.press("k");
        await page.waitForFunction((want) => {
          const sel = document.querySelector(".session-row-wrap.is-selected");
          return sel && sel.getAttribute("data-session-id") === want;
        }, first);

        const meta = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.press(`${meta}+k`);
        await page.waitForSelector("#cmdkInput:focus");
        await page.keyboard.type(PRINTABLE);
        const cmdk = await page.evaluate(() => ({
          value: document.getElementById("cmdkInput") && document.getElementById("cmdkInput").value,
          activeId: document.activeElement && document.activeElement.id,
        }));
        assert.equal(cmdk.value, PRINTABLE, `#cmdkInput still inserts ${PRINTABLE}`);
        assert.equal(cmdk.activeId, "cmdkInput");
      } finally {
        if (flyBrowser) await flyBrowser.close().catch(() => {});
        if (flyChild) await stopServe(flyChild);
        rmSync(home, { recursive: true, force: true });
      }
    },
  );
});
