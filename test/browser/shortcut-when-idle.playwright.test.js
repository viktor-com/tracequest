/**
 * Playwright MEASURE dimension B: idle shortcuts with palette closed
 * and no editable focused. Fact anchors: swis swiv swir swijk swio swip swig swik swiesc swiclosed swiss swisgh swicmdks swichip swsoptab swslistprint swichkui swichkoff swichkon swichkmod swihelp swicmdslash swicheat swihelpfield swihelpoff swilist swilistfield swilistcheat swilistesc swilistescpeek swilistescover swihelpfocus swigshift swilisto swilistrun swilistoe swilistenter
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeClaudeJsonl, CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

function seedIdleHome() {
  const home = mkTmp("tracequest-idle-shortcuts-");
  const dir = join(home, ".claude", "projects", "-home-dev-tracequest");
  mkdirSync(dir, { recursive: true });
  writeClaudeJsonl(dir, "idle-alpha.jsonl", [
    {
      type: "user",
      sessionId: "idle-alpha-1",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T12:00:00.000Z",
      uuid: "u-idle-a-1",
      isMeta: false,
      message: { content: [{ type: "text", text: "idle-alpha first chapter prompt" }] },
    },
    {
      type: "assistant",
      sessionId: "idle-alpha-1",
      timestamp: "2026-06-03T12:00:01.000Z",
      uuid: "a-idle-a-1",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "Noted idle-alpha" }],
      },
    },
    {
      type: "user",
      sessionId: "idle-alpha-1",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T12:01:00.000Z",
      uuid: "u-idle-a-2",
      isMeta: false,
      message: { content: [{ type: "text", text: "idle-alpha second chapter prompt" }] },
    },
    {
      type: "assistant",
      sessionId: "idle-alpha-1",
      timestamp: "2026-06-03T12:01:01.000Z",
      uuid: "a-idle-a-2",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "Second chapter done" }],
      },
    },
  ]);
  writeClaudeJsonl(dir, "idle-beta.jsonl", [
    {
      type: "user",
      sessionId: "idle-beta-1",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T11:00:00.000Z",
      uuid: "u-idle-b-1",
      isMeta: false,
      message: { content: [{ type: "text", text: "idle-beta first chapter prompt" }] },
    },
    {
      type: "assistant",
      sessionId: "idle-beta-1",
      timestamp: "2026-06-03T11:00:01.000Z",
      uuid: "a-idle-b-1",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "Noted idle-beta" }],
      },
    },
  ]);
  return home;
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
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode }));
      })
      .on("error", reject);
  });
}

function httpGetJson(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch (err) { reject(err); }
        });
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
  if (child.exitCode == null && !child.killed) child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function becomeIdle(page) {
  await page.evaluate(() => {
    if (typeof window.setCharacterKeysEnabled === "function") window.setCharacterKeysEnabled(true);
    else {
      try { localStorage.removeItem("tq-character-keys"); } catch (e0) {}
      if (document.documentElement) document.documentElement.setAttribute("data-tq-character-keys", "on");
    }
    const el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === "function") el.blur();
  });
}

const meta = process.platform === "darwin" ? "Meta" : "Control";

describe("shortcut-when-idle playwright", SKIP_NO_PLAYWRIGHT, () => {
  let child;
  let port;
  let browser;
  let sessionId;

  before(async () => {
    const home = seedIdleHome();
    port = await allocEphemeralPort();
    child = spawnServe(port, home);
    await waitForHttp(port, "/sessions", child);
    const listed = await httpGetJson(port, "/api/sessions?page=1&pageSize=8&sort=recent");
    const sessions = listed.data.sessions || [];
    assert.ok(sessions.length >= 2, "need two sessions for peek");
    const alpha = sessions.find((s) => String(s.firstPrompt || s.prompt || "").includes("idle-alpha")) || sessions[0];
    sessionId = alpha.id || alpha.sessionHash;
    assert.ok(sessionId, "seeded session id");
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (child) await stopServe(child);
  });

  test("idle / on /sessions focuses #workspaceSearch, not the page-local filter", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      await page.keyboard.press("/");
      const shot = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(shot.id, "workspaceSearch", "idle / focuses #workspaceSearch on /sessions");
      assert.equal(shot.cmdk, false, "idle / does not open the CommandPalette");
    } finally {
      await page.close();
    }
  });

  test("visible search chip advertises S as well as /; idle s and / still focus #workspaceSearch", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      const chip = await page.evaluate(() => {
        const el = document.querySelector(".tq-search-kbd");
        const keys = el ? [...el.querySelectorAll("kbd")].map((k) => (k.textContent || "").trim()) : [];
        const cs = el && window.getComputedStyle(el);
        return {
          keys,
          text: el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "",
          visible: !!(el && cs && cs.display !== "none" && cs.visibility !== "hidden" && (el.offsetWidth > 0 || el.offsetHeight > 0)),
          hotkey: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").getAttribute("data-hotkey")) || "",
        };
      });
      assert.equal(chip.hotkey, "s,/", "GitHub s,/ encoding on #workspaceSearch");
      assert.ok(chip.keys.includes("S"), "visible chip advertises S");
      assert.ok(chip.keys.includes("/"), "visible chip advertises /");
      assert.equal(chip.visible, true, "idle search chip is visible");
      for (const key of ["s", "/"]) {
        await becomeIdle(page);
        await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
        await page.keyboard.press(key);
        const shot = await page.evaluate(() => ({
          id: document.activeElement && document.activeElement.id,
          cmdk: document.body.classList.contains("cmdk-open"),
          value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        }));
        assert.equal(shot.id, "workspaceSearch", `idle ${key} focuses #workspaceSearch`);
        assert.equal(shot.cmdk, false, `idle ${key} does not open the CommandPalette`);
        assert.equal(shot.value, "", `idle ${key} is the opener, not a typed query character`);
        await page.keyboard.press("Escape");
      }
    } finally {
      await page.close();
    }
  });

  test("idle s and / both focus #workspaceSearch on /sessions", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await page.waitForSelector("#workspaceSearch");
      for (const key of ["s", "/"]) {
        await becomeIdle(page);
        await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
        const before = await page.evaluate(() => ({
          id: document.activeElement && document.activeElement.id,
          tag: document.activeElement && document.activeElement.tagName,
          cmdk: document.body.classList.contains("cmdk-open"),
          overlayHidden: !!(document.getElementById("cmdkOverlay") && document.getElementById("cmdkOverlay").hidden),
          hotkey: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").getAttribute("data-hotkey")) || "",
        }));
        assert.equal(before.tag, "BODY", `idle ${key}: BODY is focused first`);
        assert.equal(before.cmdk, false, `idle ${key}: palette closed`);
        assert.equal(before.overlayHidden, true, `idle ${key}: overlay hidden`);
        assert.equal(before.hotkey, "s,/", "GitHub s,/ encoding on #workspaceSearch");
        await page.keyboard.press(key);
        const shot = await page.evaluate(() => ({
          id: document.activeElement && document.activeElement.id,
          cmdk: document.body.classList.contains("cmdk-open"),
          value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        }));
        assert.equal(shot.id, "workspaceSearch", `idle ${key} focuses #workspaceSearch on /sessions`);
        assert.equal(shot.cmdk, false, `idle ${key} does not open the CommandPalette`);
        assert.equal(shot.value, "", `idle ${key} is the opener, not a typed query character`);
        await page.keyboard.press("Escape");
      }
    } finally {
      await page.close();
    }
  });

  test("Cmd+K then type s still inserts into #cmdkInput", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#cmdkTrigger");
      await becomeIdle(page);
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      await page.keyboard.type("s");
      const shot = await page.evaluate(() => ({
        value: document.getElementById("cmdkInput") && document.getElementById("cmdkInput").value,
        activeId: document.activeElement && document.activeElement.id,
        ws: document.activeElement && document.activeElement.id === "workspaceSearch",
        wsValue: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(shot.activeId, "cmdkInput", "combobox keeps focus");
      assert.equal(shot.value, "s", "s inserts into #cmdkInput");
      assert.equal(shot.ws, false, "s does not focus #workspaceSearch");
      assert.equal(shot.wsValue, "", "s does not type into #workspaceSearch");
      assert.equal(shot.cmdk, true, "palette stays open");
    } finally {
      await page.close();
    }
  });

  test("idle j/k step the sessions peek flyout", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.session-row");
    const ids = await page.locator(".session-row-wrap").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-session-id")).filter(Boolean),
    );
    assert.ok(ids.length >= 2, `need two rows, got ${ids.join(",")}`);
    await page.locator("a.session-row").first().click();
    await page.locator("#sessionFlyout").waitFor({ state: "visible" });
    const first = await page.locator(".session-row-wrap.is-selected").getAttribute("data-session-id");
    await becomeIdle(page);
    await page.keyboard.press("j");
    await page.waitForFunction((prev) => {
      const sel = document.querySelector(".session-row-wrap.is-selected");
      return sel && sel.getAttribute("data-session-id") && sel.getAttribute("data-session-id") !== prev;
    }, first);
    const second = await page.locator(".session-row-wrap.is-selected").getAttribute("data-session-id");
    assert.notEqual(second, first);
    await page.keyboard.press("k");
    await page.waitForFunction((want) => {
      const sel = document.querySelector(".session-row-wrap.is-selected");
      return sel && sel.getAttribute("data-session-id") === want;
    }, first);
  });

  test("idle j/k on /sessions with peek closed move the run list", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      const ids = await page.locator(".session-row-wrap").evaluateAll((els) =>
        els.map((el) => el.getAttribute("data-session-id")).filter(Boolean),
      );
      assert.ok(ids.length >= 2, `need two rows, got ${ids.join(",")}`);
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      const before = await page.evaluate(() => ({
        selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
        flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        activeTag: document.activeElement && document.activeElement.tagName,
        cmdk: document.body.classList.contains("cmdk-open"),
        stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
      }));
      assert.equal(before.activeTag, "BODY", "idle BODY is focused");
      assert.equal(before.cmdk, false);
      assert.equal(before.stack, 0);
      assert.equal(before.selectedCount, 0, "no row selected until J/K");
      assert.equal(before.flyHidden, true, "peek starts closed");
      await page.keyboard.press("j");
      const afterJ = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        const fly = document.getElementById("sessionFlyout");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(fly && fly.hidden),
        };
      });
      assert.equal(afterJ.selectedCount, 1, "idle j selects a run row with peek closed");
      assert.ok(afterJ.selectedId, "idle j sets a selected session id");
      assert.equal(afterJ.flyHidden, true, "idle j does not open peek");
      await page.keyboard.press("j");
      const afterJ2 = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        };
      });
      assert.equal(afterJ2.selectedCount, 1);
      assert.notEqual(afterJ2.selectedId, afterJ.selectedId, "second j moves to another row");
      assert.equal(afterJ2.flyHidden, true);
      await page.keyboard.press("k");
      const afterK = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return sel && sel.getAttribute("data-session-id");
      });
      assert.equal(afterK, afterJ.selectedId, "k moves back");
      await page.keyboard.press("ArrowDown");
      const afterDown = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        };
      });
      assert.equal(afterDown.selectedCount, 1);
      assert.equal(afterDown.selectedId, afterJ2.selectedId, "ArrowDown moves the same list");
      assert.equal(afterDown.flyHidden, true);
    } finally {
      await page.close();
    }
  });

  test("idle j on a running div.session-row.run-row keeps focus so Enter opens", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.route((url) => url.pathname === "/api/runs", async (route) => {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            runs: [{
              id: "run-jk-1",
              status: "running",
              agent: "claude",
              cwd: "/tmp/tracequest",
              prompt: "live-run-jk",
              startedAt: "2026-08-21T10:00:00.000Z",
              activity: "Working…",
            }],
          }),
        });
      });
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("div.session-row.run-row");
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      const before = await page.evaluate(() => ({
        tag: document.activeElement && document.activeElement.tagName,
        first: (() => {
          const row = document.querySelector("div.session-row.run-row");
          return row && {
            tag: row.tagName,
            className: row.className,
            href: row.getAttribute("data-href"),
            tabindex: row.getAttribute("tabindex"),
          };
        })(),
        cmdk: document.body.classList.contains("cmdk-open"),
        flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
      }));
      assert.equal(before.tag, "BODY", "idle BODY is focused");
      assert.equal(before.first.tag, "DIV");
      assert.ok(String(before.first.className).split(/\s+/).includes("run-row"));
      assert.equal(before.first.href, "/run?id=run-jk-1");
      assert.equal(before.first.tabindex, "0");
      assert.equal(before.cmdk, false);
      assert.equal(before.flyHidden, true);
      await page.keyboard.press("j");
      const afterJ = await page.evaluate(() => {
        const active = document.activeElement;
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          activeTag: active && active.tagName,
          activeClass: active && active.className,
          activeIsRunRow: !!(active && active.classList && active.classList.contains("run-row")),
          activeHref: active && active.getAttribute && active.getAttribute("data-href"),
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
          cmdk: document.body.classList.contains("cmdk-open"),
        };
      });
      assert.equal(afterJ.selectedCount, 1, "idle j selects the running row");
      assert.equal(afterJ.activeTag, "DIV", "idle j focuses the running div row");
      assert.equal(afterJ.activeIsRunRow, true, "activeElement is div.session-row.run-row");
      assert.equal(afterJ.activeHref, "/run?id=run-jk-1");
      assert.equal(afterJ.flyHidden, true, "idle j does not peek");
      assert.equal(afterJ.cmdk, false);
      const nav = page.waitForURL((url) => url.pathname === "/run" && url.searchParams.get("id") === "run-jk-1", {
        timeout: 5000,
      });
      await page.keyboard.press("Enter");
      await nav;
      assert.match(page.url(), /\/run\?id=run-jk-1/, "Enter on the focused run-row opens it");
    } finally {
      await page.close();
    }
  });

  async function mockRunningRow(page) {
    await page.route((url) => url.pathname === "/api/runs", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          runs: [{
            id: "run-jk-1",
            status: "running",
            agent: "claude",
            cwd: "/tmp/tracequest",
            prompt: "live-run-jk",
            startedAt: "2026-08-21T10:00:00.000Z",
            activity: "Working…",
          }],
        }),
      });
    });
  }

  async function idleJThenOpenRunningRowFromBody(page, key) {
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("div.session-row.run-row");
    await becomeIdle(page);
    await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
    await page.keyboard.press("j");
    const nav = page.waitForURL((url) => url.pathname === "/run" && url.searchParams.get("id") === "run-jk-1", {
      timeout: 5000,
    });
    const before = await page.evaluate((openKey) => {
      const sel = document.querySelector(".session-row-wrap.is-selected");
      const row = sel && sel.querySelector(".session-row");
      if (row && typeof row.blur === "function") row.blur();
      if (document.body) {
        document.body.tabIndex = -1;
        document.body.focus();
      }
      const active = document.activeElement;
      const shot = {
        activeTag: active && active.tagName,
        selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
        selectedIsRun: !!(row && row.classList && row.classList.contains("run-row")),
        href: row && row.getAttribute("data-href"),
        flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        cmdk: document.body.classList.contains("cmdk-open"),
      };
      (active || document.body).dispatchEvent(new KeyboardEvent("keydown", {
        key: openKey,
        bubbles: true,
        cancelable: true,
      }));
      return shot;
    }, key);
    await nav;
    return before;
  }

  test("idle O and Enter open the J/K cursor when the list owns the keyboard", async () => {
    const pageO = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await mockRunningRow(pageO);
      const afterJ = await idleJThenOpenRunningRowFromBody(pageO, "o");
      assert.equal(afterJ.activeTag, "BODY", "focus is BODY after idle j");
      assert.equal(afterJ.selectedCount, 1, ".is-selected still set");
      assert.equal(afterJ.selectedIsRun, true, "cursor is a running div.session-row.run-row");
      assert.equal(afterJ.href, "/run?id=run-jk-1");
      assert.equal(afterJ.flyHidden, true);
      assert.equal(afterJ.cmdk, false);
      assert.match(pageO.url(), /\/run\?id=run-jk-1/, "idle o from BODY opens the running J/K cursor");
    } finally {
      await pageO.close();
    }

    const pageEnter = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await mockRunningRow(pageEnter);
      const afterJ = await idleJThenOpenRunningRowFromBody(pageEnter, "Enter");
      assert.equal(afterJ.activeTag, "BODY", "focus is BODY after idle j");
      assert.equal(afterJ.selectedCount, 1, ".is-selected still set");
      assert.equal(afterJ.selectedIsRun, true);
      assert.match(pageEnter.url(), /\/run\?id=run-jk-1/, "idle Enter from BODY is the same open action");
    } finally {
      await pageEnter.close();
    }

    for (const key of ["o", "Enter"]) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      try {
        await mockRunningRow(page);
        await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("div.session-row.run-row");
        await becomeIdle(page);
        await page.keyboard.press("j");
        const before = await page.evaluate(() => {
          const row = document.querySelector(".session-row-wrap.is-selected .session-row");
          if (row && typeof row.blur === "function") row.blur();
          if (document.body) {
            document.body.tabIndex = -1;
            document.body.focus();
          }
          const active = document.activeElement;
          const sel = document.querySelector(".session-row-wrap.is-selected");
          return {
            activeTag: active && active.tagName,
            selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
            selectedIsRun: !!(sel && sel.querySelector(".session-row.run-row")),
          };
        });
        assert.equal(before.selectedCount, 1, ".is-selected still set before " + key);
        assert.equal(before.selectedIsRun, true);
        const nav = page.waitForURL((url) => url.pathname === "/run" && url.searchParams.get("id") === "run-jk-1", {
          timeout: 5000,
        });
        await page.keyboard.press(key);
        await nav;
        assert.match(page.url(), /\/run\?id=run-jk-1/, "page.keyboard " + key + " opens the running J/K cursor");
      } finally {
        await page.close();
      }
    }
  });

  test("focused #newRunBtn Enter is native activation", async () => {
    const pageBtn = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await mockRunningRow(pageBtn);
      await pageBtn.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await pageBtn.waitForSelector("#newRunBtn");
      await pageBtn.waitForSelector("div.session-row.run-row");
      await becomeIdle(pageBtn);
      await pageBtn.locator("#newRunBtn").focus();
      const before = await pageBtn.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        launchHidden: !!(document.getElementById("launchOverlay") && document.getElementById("launchOverlay").hidden),
        selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
        href: location.pathname + location.search,
      }));
      assert.equal(before.id, "newRunBtn");
      assert.equal(before.launchHidden, true);
      assert.equal(before.selectedCount, 0);
      assert.equal(before.href, "/sessions");
      await pageBtn.keyboard.press("Enter");
      await pageBtn.waitForSelector("#launchOverlay:not([hidden])");
      const after = await pageBtn.evaluate(() => ({
        launchHidden: !!(document.getElementById("launchOverlay") && document.getElementById("launchOverlay").hidden),
        href: location.pathname + location.search,
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(after.launchHidden, false, "focused #newRunBtn Enter opens launch");
      assert.equal(after.href, "/sessions", "must not navigate to a run");
      assert.equal(after.cmdk, false);
      await pageBtn.keyboard.press("Escape");
      await pageBtn.waitForFunction(() => {
        const el = document.getElementById("launchOverlay");
        return !el || el.hidden;
      });
    } finally {
      await pageBtn.close();
    }

    const pageSelected = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await mockRunningRow(pageSelected);
      await pageSelected.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await pageSelected.waitForSelector("div.session-row.run-row");
      await becomeIdle(pageSelected);
      await pageSelected.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await pageSelected.keyboard.press("j");
      const afterJ = await pageSelected.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        document.getElementById("newRunBtn").focus();
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedIsRun: !!(sel && sel.querySelector(".session-row.run-row")),
          activeId: document.activeElement && document.activeElement.id,
        };
      });
      assert.equal(afterJ.selectedCount, 1, ".is-selected still set");
      assert.equal(afterJ.selectedIsRun, true);
      assert.equal(afterJ.activeId, "newRunBtn");
      await pageSelected.keyboard.press("Enter");
      await pageSelected.waitForSelector("#launchOverlay:not([hidden])");
      const afterEnter = await pageSelected.evaluate(() => ({
        launchHidden: !!(document.getElementById("launchOverlay") && document.getElementById("launchOverlay").hidden),
        href: location.pathname + location.search,
        flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
      }));
      assert.equal(afterEnter.launchHidden, false, "Enter on focused #newRunBtn opens launch even with .is-selected");
      assert.equal(afterEnter.href, "/sessions", "must not open the selected running row");
      assert.equal(afterEnter.flyHidden, true);
    } finally {
      await pageSelected.close();
    }

    const pageRow = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await mockRunningRow(pageRow);
      await pageRow.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await pageRow.waitForSelector("div.session-row.run-row");
      await becomeIdle(pageRow);
      await pageRow.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await pageRow.keyboard.press("j");
      const nav = pageRow.waitForURL((url) => url.pathname === "/run" && url.searchParams.get("id") === "run-jk-1", {
        timeout: 5000,
      });
      await pageRow.keyboard.press("Enter");
      await nav;
      assert.match(pageRow.url(), /\/run\?id=run-jk-1/, "idle j then Enter still opens the selected running row");
    } finally {
      await pageRow.close();
    }
  });

  test("idle o on a /sessions list cursor opens the focused item", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("o");
      const noCursor = await page.evaluate(() => ({
        flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
      }));
      assert.equal(noCursor.flyHidden, true, "idle o with no cursor is a no-op");
      assert.equal(noCursor.selectedCount, 0);
      await page.keyboard.press("j");
      const afterJ = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        };
      });
      assert.ok(afterJ.selectedId, "idle j selects a row");
      assert.equal(afterJ.flyHidden, true);
      await page.keyboard.press("o");
      await page.locator("#sessionFlyout").waitFor({ state: "visible" });
      const afterO = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        const fly = document.getElementById("sessionFlyout");
        return {
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(fly && fly.hidden),
          cmdk: document.body.classList.contains("cmdk-open"),
        };
      });
      assert.equal(afterO.flyHidden, false, "idle o opens the focused list item");
      assert.equal(afterO.selectedId, afterJ.selectedId);
      assert.equal(afterO.cmdk, false);
    } finally {
      await page.close();
    }
  });

  test("idle Escape on /sessions with peek closed clears the list cursor", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("j");
      const afterJ = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        const row = sel && sel.querySelector(".session-row");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          aria: row && row.getAttribute("aria-current"),
          activeIsRow: !!(document.activeElement && document.activeElement.classList
            && document.activeElement.classList.contains("session-row")),
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
          stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
        };
      });
      assert.equal(afterJ.selectedCount, 1, "idle j selects a run row");
      assert.equal(afterJ.aria, "true");
      assert.equal(afterJ.activeIsRow, true);
      assert.equal(afterJ.flyHidden, true);
      assert.equal(afterJ.stack, 0);
      await page.keyboard.press("Escape");
      const afterEsc = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        const current = document.querySelector(".session-row[aria-current]");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          hasAria: !!current,
          activeIsRow: !!(document.activeElement && document.activeElement.classList
            && document.activeElement.classList.contains("session-row")),
          activeTag: document.activeElement && document.activeElement.tagName,
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        };
      });
      assert.equal(afterEsc.selectedCount, 0, "Escape clears .session-row-wrap.is-selected");
      assert.equal(afterEsc.hasAria, false, "Escape drops aria-current");
      assert.equal(afterEsc.activeIsRow, false, "Escape blurs the role=link row");
      assert.equal(afterEsc.flyHidden, true);
    } finally {
      await page.close();
    }
  });

  test("peek Escape still closes peek before list-clear", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await page.locator("a.session-row").first().click();
      await page.locator("#sessionFlyout").waitFor({ state: "visible" });
      const peeked = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        };
      });
      assert.equal(peeked.selectedCount, 1);
      assert.equal(peeked.flyHidden, false);
      await becomeIdle(page);
      await page.keyboard.press("Escape");
      const afterPeekEsc = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedId: sel && sel.getAttribute("data-session-id"),
          flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
          aria: sel && sel.querySelector(".session-row") && sel.querySelector(".session-row").getAttribute("aria-current"),
        };
      });
      assert.equal(afterPeekEsc.flyHidden, true, "first Escape closes peek");
      assert.equal(afterPeekEsc.selectedCount, 1, "peek Escape does not yet clear the list cursor");
      assert.equal(afterPeekEsc.selectedId, peeked.selectedId);
      assert.equal(afterPeekEsc.aria, "true");
      await page.keyboard.press("Escape");
      const afterListEsc = await page.evaluate(() => ({
        selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
        hasAria: !!document.querySelector(".session-row[aria-current]"),
        flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
      }));
      assert.equal(afterListEsc.flyHidden, true);
      assert.equal(afterListEsc.selectedCount, 0, "second idle Escape unfocuses the list cursor");
      assert.equal(afterListEsc.hasAria, false);
    } finally {
      await page.close();
    }
  });

  test("overlay Escape still pops overlays before list-clear", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("j");
      const afterJ = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedId: sel && sel.getAttribute("data-session-id"),
        };
      });
      assert.equal(afterJ.selectedCount, 1);
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      await page.keyboard.type("/ojkg?x");
      const typed = await page.evaluate(() => ({
        value: document.getElementById("cmdkInput") && document.getElementById("cmdkInput").value,
        stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(typed.value, "/ojkg?x", "Cmd+K /ojkg?x still inserts");
      assert.ok(typed.stack >= 1);
      assert.equal(typed.cmdk, true);
      await page.keyboard.press("Escape");
      const afterOverlayEsc = await page.evaluate(() => {
        const sel = document.querySelector(".session-row-wrap.is-selected");
        return {
          selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
          selectedId: sel && sel.getAttribute("data-session-id"),
          cmdk: document.body.classList.contains("cmdk-open"),
          overlayHidden: !!(document.getElementById("cmdkOverlay") && document.getElementById("cmdkOverlay").hidden),
          stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
        };
      });
      assert.equal(afterOverlayEsc.cmdk, false, "Escape pops the palette");
      assert.equal(afterOverlayEsc.overlayHidden, true);
      assert.equal(afterOverlayEsc.stack, 0);
      assert.equal(afterOverlayEsc.selectedCount, 1, "overlay Escape must not clear the list cursor");
      assert.equal(afterOverlayEsc.selectedId, afterJ.selectedId);
      await page.keyboard.press("Escape");
      const afterListEsc = await page.evaluate(() => ({
        selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
        hasAria: !!document.querySelector(".session-row[aria-current]"),
      }));
      assert.equal(afterListEsc.selectedCount, 0, "idle Escape after overlay pop unfocuses the list cursor");
      assert.equal(afterListEsc.hasAria, false);
    } finally {
      await page.close();
    }
  });

  test("while a text field is focused, j/k/ArrowDown do not move the /sessions run list", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#workspaceSearch");
      await page.waitForSelector("a.session-row");
      await becomeIdle(page);
      await page.locator("#workspaceSearch").click();
      await page.keyboard.type("jk");
      await page.keyboard.press("ArrowDown");
      const shot = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        selectedCount: document.querySelectorAll(".session-row-wrap.is-selected").length,
        flyHidden: !!(document.getElementById("sessionFlyout") && document.getElementById("sessionFlyout").hidden),
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(shot.id, "workspaceSearch");
      assert.ok(shot.value.includes("j") && shot.value.includes("k"), "j and k insert into the field");
      assert.equal(shot.selectedCount, 0, "focused field: j/k/ArrowDown must not select a run row");
      assert.equal(shot.flyHidden, true);
      assert.equal(shot.cmdk, false);
    } finally {
      await page.close();
    }
  });

  test("cheatsheet advertises J/K as current-list navigation", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#shortcutCheatsheet", { state: "attached" });
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("?");
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      const text = await page.evaluate(() => {
        const table = document.getElementById("shortcutCheatsheet");
        return (table && table.textContent) || "";
      });
      assert.match(text, /J/);
      assert.match(text, /K/);
      assert.match(text, /current list/);
    } finally {
      await page.close();
    }
  });

  test("idle Cmd/Ctrl+K toggles the CommandPalette when focus is on the page and no form field is focused", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#cmdkTrigger");
    await becomeIdle(page);
    const overlay = page.locator("#cmdkOverlay");
    await page.keyboard.press(`${meta}+k`);
    await overlay.waitFor({ state: "visible" });
    assert.equal(await page.evaluate(() => document.body.classList.contains("cmdk-open")), true);
    await page.keyboard.press(`${meta}+k`);
    await overlay.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.body.classList.contains("cmdk-open")), false);
  });

  test("idle shortcuts work again after the CommandPalette closes", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#filterInput");
    await becomeIdle(page);
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkOverlay:not([hidden])");
    await page.keyboard.press(`${meta}+k`);
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    await becomeIdle(page);
    await page.keyboard.press("/");
    assert.equal(
      await page.evaluate(() => document.activeElement && document.activeElement.id),
      "workspaceSearch",
      "idle / focuses #workspaceSearch after palette close",
    );
  });

  test("idle / on /run focuses #workspaceSearch, not the rail filter", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/run`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#workspaceSearch");
    await becomeIdle(page);
    await page.keyboard.press("/");
    const shot = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      open: !!(document.querySelector(".agent-rail") && document.querySelector(".agent-rail").classList.contains("filters-open")),
      cmdk: document.body.classList.contains("cmdk-open"),
    }));
    assert.equal(shot.id, "workspaceSearch", "idle / focuses #workspaceSearch on /run");
    assert.equal(shot.open, false, "idle / does not open rail filters");
    assert.equal(shot.cmdk, false, "idle / does not open the CommandPalette");
  });

  test("idle / on a rendered session focuses #workspaceSearch, not .filter-search", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#chapter-0", { timeout: 15_000 });
    await page.waitForSelector("#workspaceSearch");
    await becomeIdle(page);
    await page.keyboard.press("/");
    const shot = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      chapter: !!(document.activeElement && document.activeElement.classList.contains("filter-search")),
      cmdk: document.body.classList.contains("cmdk-open"),
    }));
    assert.equal(shot.id, "workspaceSearch", "idle / focuses #workspaceSearch on /view");
    assert.equal(shot.chapter, false, "idle / does not focus chapter search");
    assert.equal(shot.cmdk, false);
    await page.keyboard.press("Escape");
    await becomeIdle(page);
  });

  test("idle / on /sessions, /run, /view, and /compare focuses the same #workspaceSearch", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      const surfaces = [
        { name: "/sessions", path: "/sessions" },
        { name: "/run", path: "/run" },
        { name: "/view", path: `/view?id=${encodeURIComponent(sessionId)}` },
        { name: "/compare", path: "/compare" },
      ];
      for (const surface of surfaces) {
        await page.goto(`http://127.0.0.1:${port}${surface.path}`, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#workspaceSearch");
        await becomeIdle(page);
        await page.keyboard.press("/");
        const shot = await page.evaluate(() => ({
          id: document.activeElement && document.activeElement.id,
          cmdk: document.body.classList.contains("cmdk-open"),
          overlayHidden: !!(document.getElementById("cmdkOverlay") && document.getElementById("cmdkOverlay").hidden),
          value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
          filter: document.activeElement && document.activeElement.id === "filterInput",
          chapter: !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("filter-search")),
        }));
        assert.equal(shot.id, "workspaceSearch", `${surface.name}: idle / focuses #workspaceSearch`);
        assert.equal(shot.cmdk, false, `${surface.name}: not a Cmd+K alias`);
        assert.equal(shot.overlayHidden, true, `${surface.name}: palette stays closed`);
        assert.equal(shot.value, "", `${surface.name}: slash is the opener, not a typed character`);
        assert.equal(shot.filter, false, `${surface.name}: not #filterInput`);
        assert.equal(shot.chapter, false, `${surface.name}: not .filter-search`);
        await page.keyboard.press("Escape");
        await becomeIdle(page);
      }
    } finally {
      await page.close();
    }
  });

  test("idle / does not open the CommandPalette", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/compare`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      await page.keyboard.press("/");
      const afterSlash = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(afterSlash.id, "workspaceSearch");
      assert.equal(afterSlash.cmdk, false);
      await page.keyboard.press("Escape");
      await becomeIdle(page);
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkOverlay:not([hidden])");
      assert.equal(await page.evaluate(() => document.body.classList.contains("cmdk-open")), true);
    } finally {
      await page.close();
    }
  });

  test("while the CommandPalette is open, s types into #cmdkInput", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#cmdkTrigger");
      await becomeIdle(page);
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      await page.keyboard.type("s");
      const shot = await page.evaluate(() => ({
        value: document.getElementById("cmdkInput") && document.getElementById("cmdkInput").value,
        activeId: document.activeElement && document.activeElement.id,
        ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      }));
      assert.equal(shot.activeId, "cmdkInput");
      assert.equal(shot.value, "s", "s inside the palette is typed filter text, not the search opener");
      assert.equal(shot.ws, false);
    } finally {
      await page.close();
    }
  });

  test("while the CommandPalette is open, / types into #cmdkInput", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#cmdkTrigger");
      await becomeIdle(page);
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      await page.keyboard.type("/");
      const shot = await page.evaluate(() => ({
        value: document.getElementById("cmdkInput") && document.getElementById("cmdkInput").value,
        activeId: document.activeElement && document.activeElement.id,
        ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      }));
      assert.equal(shot.activeId, "cmdkInput");
      assert.equal(shot.value, "/", "/ inside the palette is a typed prefix, not the opener");
      assert.equal(shot.ws, false);
    } finally {
      await page.close();
    }
  });

  test("idle j/k on a rendered session move chapter kb-focused", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#chapter-0", { timeout: 15_000 });
    await page.waitForSelector("#chapter-1");
    await becomeIdle(page);
    await page.keyboard.press("j");
    await page.locator("#chapter-0.kb-focused").waitFor();
    await page.keyboard.press("j");
    await page.locator("#chapter-1.kb-focused").waitFor();
    await page.keyboard.press("k");
    await page.locator("#chapter-0.kb-focused").waitFor();
  });

  test("idle o or Enter toggles the kb-focused chapter", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#chapter-0", { timeout: 15_000 });
    await becomeIdle(page);
    await page.keyboard.press("j");
    await page.locator("#chapter-0.kb-focused").waitFor();
    await page.keyboard.press("o");
    await page.locator("#chapter-0.expanded.kb-focused").waitFor();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => {
      const el = document.getElementById("chapter-0");
      return el && el.classList.contains("kb-focused") && !el.classList.contains("expanded");
    });
  });

  test("idle Escape clears chapter kb-focused; Escape in chapter search still clears and unfocuses", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#chapter-0", { timeout: 15_000 });
    await becomeIdle(page);
    await page.keyboard.press("j");
    await page.locator("#chapter-0.kb-focused").waitFor();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".chapter.kb-focused"));

    const search = page.locator(".filter-search");
    await search.waitFor({ state: "visible" });
    await search.focus();
    await page.keyboard.type("idle-alpha");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => {
      const el = document.querySelector(".filter-search");
      return el && el.value === "" && document.activeElement !== el;
    });
  });

  test("idle G then C/R/D/V/N jumps to Chat, Runs, Compare, rendered session, or New run", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.session-row");
    await becomeIdle(page);
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForFunction(() => location.pathname === "/" || location.pathname === "/run");

    await becomeIdle(page);
    await page.keyboard.press("g");
    await page.keyboard.press("r");
    await page.waitForURL((url) => url.pathname === "/sessions");
    await page.waitForSelector("a.session-row");
    await page.waitForSelector("#filterInput");
    // After G then R, do not blur: /sessions must already be idle (no #filterInput autofocus).
    const afterRuns = await page.evaluate(() => ({
      path: location.pathname,
      search: location.search,
      activeId: document.activeElement && document.activeElement.id,
    }));
    assert.equal(afterRuns.path, "/sessions");
    assert.notEqual(
      afterRuns.activeId,
      "filterInput",
      "G then R must not leave #filterInput focused (no autofocus)",
    );

    await page.keyboard.press("g");
    await page.keyboard.press("d");
    await page.waitForURL((url) => url.pathname === "/compare");
    const afterCompare = new URL(page.url());
    assert.equal(afterCompare.pathname, "/compare");
    assert.equal(
      afterCompare.searchParams.get("expr"),
      null,
      "G then D after G then R must not type d into the sessions filter",
    );
    assert.doesNotMatch(afterCompare.search, /(?:^|[?&])expr=/);

    await becomeIdle(page);
    await page.keyboard.press("g");
    await page.keyboard.press("v");
    await page.waitForURL((url) => url.pathname === "/view");

    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#filterInput");
    const afterReload = await page.evaluate(() => document.activeElement && document.activeElement.id);
    assert.notEqual(afterReload, "filterInput", "/sessions load must not autofocus the filter");
    await page.keyboard.press("g");
    await page.keyboard.press("n");
    await page.waitForFunction(() => {
      const overlay = document.getElementById("launchOverlay");
      return (overlay && !overlay.hidden)
        || new URLSearchParams(location.search).get("launch") === "1";
    });
  });

  test("Shift+G then c jumps as G then C as written", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      const before = await page.evaluate(() => location.pathname);
      assert.equal(before, "/sessions");
      await page.keyboard.press("Shift+G");
      await page.keyboard.press("c");
      await page.waitForFunction(() => location.pathname === "/" || location.pathname === "/run");
      const after = await page.evaluate(() => ({
        path: location.pathname,
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.ok(after.path === "/" || after.path === "/run", "Shift+G then c jumps off /sessions");
      assert.equal(after.cmdk, false);
    } finally {
      await page.close();
    }
  });

  test("after G then D lands on /compare with BODY focused, idle / focuses #workspaceSearch", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await page.waitForSelector("#filterInput");
      const beforeJump = await page.evaluate(() => ({
        activeId: document.activeElement && document.activeElement.id,
        tag: document.activeElement && document.activeElement.tagName,
      }));
      assert.notEqual(beforeJump.activeId, "filterInput", "G-then-D start must not be in the sessions filter");

      await page.keyboard.press("g");
      await page.keyboard.press("d");
      await page.waitForURL((url) => url.pathname === "/compare");
      await page.waitForSelector("#workspaceSearch");
      await page.waitForSelector("#cmdkOverlay", { state: "attached" });

      const idle = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          path: location.pathname,
          tag: el && el.tagName,
          id: el && el.id,
          cmdk: document.body.classList.contains("cmdk-open"),
          overlayHidden: !!(document.getElementById("cmdkOverlay") && document.getElementById("cmdkOverlay").hidden),
        };
      });
      assert.equal(idle.path, "/compare");
      assert.equal(idle.cmdk, false, "palette must be closed after G then D");
      assert.equal(idle.overlayHidden, true);
      assert.ok(
        idle.tag === "BODY" || idle.tag === "HTML",
        `G then D must land idle on BODY, got ${idle.tag}#${idle.id}`,
      );

      await page.keyboard.press("/");
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === "workspaceSearch");
      const after = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          tag: el && el.tagName,
          id: el && el.id,
          cmdk: document.body.classList.contains("cmdk-open"),
          overlayHidden: !!(document.getElementById("cmdkOverlay") && document.getElementById("cmdkOverlay").hidden),
          value: el && "value" in el ? el.value : "",
        };
      });
      assert.equal(after.cmdk, false, "idle / after G then D must not alias Cmd+K");
      assert.equal(after.overlayHidden, true);
      assert.equal(after.id, "workspaceSearch", "idle / on /compare focuses #workspaceSearch");
      assert.equal(after.value, "", "slash is the opener, not a typed query character");
    } finally {
      await page.close();
    }
  });

  test("Tab from #workspaceSearch does not land on popup options or page behind", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a.session-row");
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      await page.keyboard.press("/");
      await page.waitForFunction(() => document.activeElement && document.activeElement.id === "workspaceSearch");
      await page.waitForSelector("#workspaceSearchList .tq-search-item");
      const before = await page.evaluate(() => {
        const items = [...document.querySelectorAll("#workspaceSearchList .tq-search-item")];
        return {
          count: items.length,
          tabIndexes: items.map((el) => el.getAttribute("tabindex")),
        };
      });
      assert.ok(before.count >= 1, "popup has option buttons");
      assert.ok(
        before.tabIndexes.every((t) => t === "-1"),
        "listbox popup options are excluded from the page Tab sequence",
      );
      await page.keyboard.press("Tab");
      const shot = await page.evaluate(() => {
        const ae = document.activeElement;
        const list = document.getElementById("workspaceSearchList");
        return {
          id: ae && ae.id,
          isOption: !!(ae && ae.classList && ae.classList.contains("tq-search-item")),
          inList: !!(list && ae && list.contains(ae)),
          isSessionRow: !!(ae && (
            (ae.classList && ae.classList.contains("session-row"))
            || (typeof ae.closest === "function" && ae.closest(".session-row"))
          )),
        };
      });
      assert.equal(shot.isOption, false, "Tab does not land on a popup option");
      assert.equal(shot.inList, false, "Tab does not land inside the listbox");
      assert.equal(shot.isSessionRow, false, "Tab does not land on page behind the popup");
    } finally {
      await page.close();
    }
  });

  test("printable / and j while a workspace search result is focused insert into #workspaceSearch", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      await page.keyboard.press("/");
      await page.waitForSelector("#workspaceSearchList .tq-search-item");
      await page.locator("#workspaceSearchList .tq-search-item").first().evaluate((el) => el.focus());
      const focused = await page.evaluate(() => !!(
        document.activeElement && document.activeElement.classList.contains("tq-search-item")
      ));
      assert.equal(focused, true, "result option can take DOM focus");
      await page.keyboard.type("/");
      const slashShot = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(slashShot.id, "workspaceSearch", "/ returns focus to the combobox");
      assert.ok(slashShot.value.includes("/"), "/ inserts into #workspaceSearch, not consumed as opener");
      assert.equal(slashShot.cmdk, false, "/ does not reopen the command palette");

      await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector("#chapter-0", { timeout: 15_000 });
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      await page.keyboard.press("/");
      await page.waitForSelector("#workspaceSearchList .tq-search-item");
      await page.locator("#workspaceSearchList .tq-search-item").first().evaluate((el) => el.focus());
      await page.keyboard.type("j");
      const jShot = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        kbFocused: document.querySelectorAll(".chapter.kb-focused").length,
      }));
      assert.equal(jShot.id, "workspaceSearch", "j returns focus to the combobox");
      assert.ok(jShot.value.includes("j"), "j inserts into #workspaceSearch");
      assert.equal(jShot.kbFocused, 0, "j on a focused option does not set chapter kb-focused");
    } finally {
      await page.close();
    }
  });

  test("a Character keys checkbox (GitHub WCAG 2.1.4 hatch) is available to turn off unmodified character-key shortcuts", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#newRunBtn");
      await becomeIdle(page);
      const hatch = await page.evaluate(() => ({
        toggle: !!(document.getElementById("characterKeysToggle")),
        overlay: !!(document.getElementById("characterKeysOverlay")),
        label: (document.querySelector("label[for='characterKeysToggle']") || {}).textContent || "",
        checked: !!(document.getElementById("characterKeysToggle") && document.getElementById("characterKeysToggle").checked),
      }));
      assert.equal(hatch.toggle, true, "Character keys checkbox exists");
      assert.equal(hatch.overlay, true, "Keyboard shortcuts dialog exists");
      assert.match(hatch.label, /Character keys/);
      assert.equal(hatch.checked, true, "Character keys is selected by default");

      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      await page.keyboard.type("character keys");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      const open = await page.evaluate(() => ({
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        active: document.activeElement && document.activeElement.id,
        checked: !!(document.getElementById("characterKeysToggle") && document.getElementById("characterKeysToggle").checked),
      }));
      assert.equal(open.hidden, false, "Keyboard shortcuts dialog opened from the command palette");
      assert.equal(open.checked, true);
    } finally {
      await page.close();
    }
  });

  test("when Character keys is deselected, focused #newRunBtn then s does not move focus to #workspaceSearch and g then c does not navigate", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#newRunBtn");
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      await page.keyboard.type("character keys");
      await page.keyboard.press("Enter");
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      await page.locator("#characterKeysToggle").uncheck();
      await page.locator("#characterKeysClose").click();
      await page.waitForFunction(() => {
        const el = document.getElementById("characterKeysOverlay");
        return !el || el.hidden;
      });
      await page.locator("#newRunBtn").focus();
      const before = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        enabled: typeof window.characterKeysEnabled === "function" ? window.characterKeysEnabled() : null,
        href: location.pathname,
      }));
      assert.equal(before.id, "newRunBtn");
      assert.equal(before.enabled, false, "Character keys setting is off");
      await page.keyboard.press("s");
      const afterS = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        wsValue: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(afterS.id, "newRunBtn", "s must not move focus to #workspaceSearch");
      assert.notEqual(afterS.id, "workspaceSearch");
      assert.equal(afterS.cmdk, false);
      const hrefBefore = page.url();
      await page.keyboard.press("g");
      await page.keyboard.press("c");
      const afterGc = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        path: location.pathname,
      }));
      assert.equal(afterGc.path, "/sessions", "g then c must not navigate when Character keys is off");
      assert.equal(page.url(), hrefBefore);
      assert.notEqual(afterGc.path, "/");
    } finally {
      await page.evaluate(() => {
        if (typeof window.setCharacterKeysEnabled === "function") window.setCharacterKeysEnabled(true);
      }).catch(() => {});
      await page.close();
    }
  });

  test("when Character keys is selected (the default), idle s and / still focus #workspaceSearch and idle g then c still jumps", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      const enabled = await page.evaluate(() => (
        typeof window.characterKeysEnabled === "function" ? window.characterKeysEnabled() : true
      ));
      assert.equal(enabled, true, "Character keys default on");
      await page.locator("#newRunBtn").focus();
      await page.keyboard.press("s");
      const afterS = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(afterS, "workspaceSearch", "default idle s focuses search");
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("/");
      const afterSlash = await page.evaluate(() => document.activeElement && document.activeElement.id);
      assert.equal(afterSlash, "workspaceSearch", "default idle / focuses search");
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("g");
      await page.keyboard.press("c");
      await page.waitForFunction(() => location.pathname === "/");
      assert.equal(new URL(page.url()).pathname, "/", "default idle g then c still jumps");
    } finally {
      await page.close();
    }
  });

  test("Cmd/Ctrl+K still toggles the CommandPalette when Character keys is deselected", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#cmdkTrigger");
      await page.waitForSelector("#newRunBtn");
      await becomeIdle(page);
      await page.evaluate(() => window.setCharacterKeysEnabled(false));
      await page.locator("#newRunBtn").focus();
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      const open = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(open.id, "cmdkInput", "Cmd+K still opens the palette with Character keys off");
      assert.equal(open.cmdk, true);
      await page.keyboard.type("/ojkg?x");
      const typed = await page.$eval("#cmdkInput", (el) => el.value);
      assert.equal(typed, "/ojkg?x", "Cmd+K then /ojkg?x still inserts with Character keys off");
      await page.keyboard.press(`${meta}+k`);
      await page.waitForFunction(() => !document.body.classList.contains("cmdk-open"));
    } finally {
      await page.evaluate(() => {
        if (typeof window.setCharacterKeysEnabled === "function") window.setCharacterKeysEnabled(true);
      }).catch(() => {});
      await page.close();
    }
  });

  test("idle ? opens the keyboard-shortcuts cheatsheet", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#characterKeysOverlay", { state: "attached" });
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      const before = await page.evaluate(() => ({
        active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
        cmdk: document.body.classList.contains("cmdk-open"),
        stack: (window.__tqOverlayStack || []).length,
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
      }));
      assert.equal(before.cmdk, false, "palette closed");
      assert.equal(before.stack, 0, "overlayStack=0");
      assert.equal(before.hidden, true, "cheatsheet starts hidden");
      await page.keyboard.press("?");
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      const after = await page.evaluate(() => ({
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        cmdk: document.body.classList.contains("cmdk-open"),
        title: (document.getElementById("characterKeysTitle") && document.getElementById("characterKeysTitle").textContent) || "",
        table: !!(document.getElementById("shortcutCheatsheet")),
      }));
      assert.equal(after.hidden, false, "idle ? opens #characterKeysOverlay");
      assert.equal(after.cmdk, false, "idle ? does not open the command palette");
      assert.match(after.title, /Keyboard shortcuts/);
      assert.equal(after.table, true);
    } finally {
      await page.close();
    }
  });

  test("idle ? focuses the cheatsheet dialog, not the Character keys checkbox", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#characterKeysOverlay", { state: "attached" });
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("?");
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      const after = await page.evaluate(() => {
        const active = document.activeElement;
        const dialog = document.getElementById("characterKeysDialog")
          || document.querySelector("#characterKeysOverlay .tq-a11y-dialog");
        const closeBtn = document.getElementById("characterKeysClose");
        const toggle = document.getElementById("characterKeysToggle");
        return {
          activeId: active && active.id,
          activeClass: active && active.className,
          isToggle: active === toggle,
          isDialog: active === dialog,
          isClose: active === closeBtn,
          hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        };
      });
      assert.equal(after.hidden, false);
      assert.equal(after.isToggle, false, "idle ? must not land on #characterKeysToggle");
      assert.notEqual(after.activeId, "characterKeysToggle");
      assert.ok(after.isDialog || after.isClose, "idle ? focuses the dialog or Close");
    } finally {
      await page.close();
    }
  });

  test("idle Cmd/Ctrl+/ opens the keyboard-shortcuts cheatsheet", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#characterKeysOverlay", { state: "attached" });
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      const before = await page.evaluate(() => ({
        active: document.activeElement && (document.activeElement.id || document.activeElement.tagName),
        cmdk: document.body.classList.contains("cmdk-open"),
        stack: (window.__tqOverlayStack || []).length,
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
      }));
      assert.equal(before.cmdk, false);
      assert.equal(before.stack, 0);
      assert.equal(before.hidden, true);
      await page.keyboard.press(`${meta}+Slash`);
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      const after = await page.evaluate(() => ({
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(after.hidden, false, "idle Meta+Slash / Ctrl+Slash opens #characterKeysOverlay");
      assert.equal(after.cmdk, false);
    } finally {
      await page.close();
    }
  });

  test("the keyboard-shortcuts cheatsheet lists page shortcuts and includes the Character keys checkbox", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#shortcutCheatsheet", { state: "attached" });
      await becomeIdle(page);
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("?");
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      const sheet = await page.evaluate(() => {
        const table = document.getElementById("shortcutCheatsheet");
        const toggle = document.getElementById("characterKeysToggle");
        const label = document.querySelector("label[for='characterKeysToggle']");
        return {
          text: (table && table.textContent) || "",
          toggle: !!(toggle && toggle.type === "checkbox"),
          label: (label && label.textContent) || "",
          checked: !!(toggle && toggle.checked),
        };
      });
      assert.match(sheet.text, /Search/);
      assert.match(sheet.text, /Command menu/);
      assert.match(sheet.text, /current list/);
      assert.match(sheet.text, /Keyboard shortcuts/);
      assert.equal(sheet.toggle, true, "Character keys checkbox is in the cheatsheet");
      assert.match(sheet.label, /Character keys/);
      assert.equal(sheet.checked, true);
    } finally {
      await page.close();
    }
  });

  test("while a text field is focused, ? inserts and Cmd/Ctrl+/ does not open the cheatsheet", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#workspaceSearch");
      await becomeIdle(page);
      await page.locator("#workspaceSearch").click();
      await page.keyboard.type("?");
      const afterQ = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(afterQ.id, "workspaceSearch");
      assert.ok(afterQ.value.includes("?"), "focused field: ? inserts");
      assert.equal(afterQ.hidden, true, "focused field: ? must not open the cheatsheet");
      assert.equal(afterQ.cmdk, false);
      const beforeSlash = afterQ.value;
      await page.keyboard.press(`${meta}+Slash`);
      const afterSlash = await page.evaluate(() => ({
        id: document.activeElement && document.activeElement.id,
        value: (document.getElementById("workspaceSearch") && document.getElementById("workspaceSearch").value) || "",
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
      }));
      assert.equal(afterSlash.id, "workspaceSearch");
      assert.equal(afterSlash.hidden, true, "focused field: Cmd+/ must not open the cheatsheet");
      assert.equal(afterSlash.value, beforeSlash, "Cmd+/ does not insert or steal while typing");

      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      await page.keyboard.type("/ojkg?x");
      const typed = await page.$eval("#cmdkInput", (el) => el.value);
      assert.equal(typed, "/ojkg?x", "Cmd+K then /ojkg?x still inserts");
      const paletteHelp = await page.evaluate(() => ({
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        cmdk: document.body.classList.contains("cmdk-open"),
      }));
      assert.equal(paletteHelp.hidden, true, "palette ? is query text, not the cheatsheet");
      assert.equal(paletteHelp.cmdk, true);
    } finally {
      await page.close();
    }
  });

  test("when Character keys is deselected, idle ? does not open the cheatsheet and Cmd/Ctrl+/ still opens it", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#characterKeysOverlay", { state: "attached" });
      await becomeIdle(page);
      await page.evaluate(() => {
        if (typeof window.setCharacterKeysEnabled === "function") window.setCharacterKeysEnabled(false);
      });
      await page.evaluate(() => { if (document.body && document.body.focus) document.body.focus(); });
      await page.keyboard.press("?");
      const afterQ = await page.evaluate(() => ({
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        enabled: typeof window.characterKeysEnabled === "function" ? window.characterKeysEnabled() : null,
      }));
      assert.equal(afterQ.enabled, false);
      assert.equal(afterQ.hidden, true, "character-key ? is off");
      await page.keyboard.press(`${meta}+Slash`);
      await page.waitForSelector("#characterKeysOverlay:not([hidden])");
      const afterMod = await page.evaluate(() => ({
        hidden: !!(document.getElementById("characterKeysOverlay") && document.getElementById("characterKeysOverlay").hidden),
        checked: !!(document.getElementById("characterKeysToggle") && document.getElementById("characterKeysToggle").checked),
      }));
      assert.equal(afterMod.hidden, false, "modifier Cmd+/ still opens the cheatsheet");
      assert.equal(afterMod.checked, false, "Character keys checkbox still reflects off");
    } finally {
      await page.evaluate(() => {
        if (typeof window.setCharacterKeysEnabled === "function") window.setCharacterKeysEnabled(true);
      }).catch(() => {});
      await page.close();
    }
  });
});
