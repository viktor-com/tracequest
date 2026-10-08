/**
 * Overlay focus lifecycle in a real browser — palette, launch modal,
 * keys menu, run-details popover, share dialog, rail toolbar menus.
 * Fact anchors: ofp oft ofx ofs ofl oflt oflr ofk ofr ofa ofstk ofstkt ofstke ofshare ofshareslash ofkeysslash ofkmodal ofrmodal ofstackz ofsharek ofchordpw ofage ofageslash ofagepush ofageinert offly offlyslash offlyinert offlyframe offlycmdk
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
import { runPage } from "../../src/browser/run-page.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

function seedOflHome() {
  const home = mkTmp("tracequest-ofl-cmdk-");
  const dir = join(home, ".claude", "projects", "-home-dev-tracequest");
  mkdirSync(dir, { recursive: true });
  writeClaudeJsonl(dir, "ofl-share.jsonl", [
    {
      type: "user",
      sessionId: "ofl-share-1",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T12:00:00.000Z",
      uuid: "u-ofl-share-1",
      isMeta: false,
      message: { content: [{ type: "text", text: "ofl share session prompt" }] },
    },
    {
      type: "assistant",
      sessionId: "ofl-share-1",
      timestamp: "2026-06-03T12:00:01.000Z",
      uuid: "a-ofl-share-1",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "Noted ofl share" }],
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

async function waitForHttp(port, reqPath, child, { timeoutMs = 15_000 } = {}) {
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
  if (!child || child.exitCode != null || child.signalCode != null) return;
  if (!child.killed) child.kill("SIGKILL");
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function focusShot(page, rootSel) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const el = document.activeElement;
    const hidden = !!(el && el !== document.body && el !== document.documentElement && (
      el.hidden || (el.closest && el.closest("[hidden]"))
    ));
    return {
      id: el && el.id,
      tag: el && el.tagName,
      inside: !!(root && el && root.contains(el)),
      overlayHidden: !!(root && root.hidden),
      hidden,
    };
  }, rootSel);
}

describe("overlay focus lifecycle — live keyboard", () => {
  let child;
  let port;
  let browser;
  let sessionId;

  before(async () => {
    if (!PLAYWRIGHT) return;
    const home = seedOflHome();
    port = await allocEphemeralPort();
    child = spawnServe(port, home);
    await waitForHttp(port, "/sessions", child);
    const listed = await httpGetJson(port, "/api/sessions?page=1&pageSize=8&sort=recent");
    const sessions = listed.data.sessions || [];
    const share = sessions.find((s) => String(s.firstPrompt || s.prompt || "").includes("ofl share")) || sessions[0];
    sessionId = share && (share.id || share.sessionHash);
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
  });

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (child) await stopServe(child);
  });

  test("Opening the CommandPalette moves document.activeElement inside #cmdkOverlay", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.locator("#filterInput").focus();
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    const shot = await focusShot(page, "#cmdkOverlay");
    assert.equal(shot.inside, true);
    assert.equal(shot.id, "cmdkInput");
  });

  test("While the CommandPalette is open, Tab and Shift+Tab keep focus inside #cmdkOverlay", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.press("Tab");
    let shot = await focusShot(page, "#cmdkOverlay");
    assert.equal(shot.inside, true, `Tab left overlay: ${shot.id || shot.tag}`);
    await page.keyboard.press("Shift+Tab");
    shot = await focusShot(page, "#cmdkOverlay");
    assert.equal(shot.inside, true, `Shift+Tab left overlay: ${shot.id || shot.tag}`);
  });

  test("Escape or backdrop click closes the CommandPalette and restores the previously focused element", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.locator("#filterInput").focus();
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");

    await page.locator("#filterInput").focus();
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkOverlay:not([hidden])");
    await page.locator("#cmdkScrim").click({ position: { x: 4, y: 4 }, force: true });
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");
  });

  test("After the CommandPalette closes, document.activeElement is not inside the hidden overlay", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    const shot = await focusShot(page, "#cmdkOverlay");
    assert.equal(shot.overlayHidden, true);
    assert.equal(shot.hidden, false);
    assert.equal(shot.inside, false);
  });

  test("Opening the launch overlay moves document.activeElement inside #launchOverlay", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.waitForFunction(() => {
      const root = document.getElementById("launchOverlay");
      return root && !root.hidden && root.contains(document.activeElement);
    });
    const shot = await focusShot(page, "#launchOverlay");
    assert.equal(shot.inside, true);
  });

  test("While the launch overlay is open, Tab and Shift+Tab cycle inside #launchOverlay", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.waitForSelector("#promptInput:focus");
    const ids = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      ids.push(await page.evaluate(() => {
        const root = document.getElementById("launchOverlay");
        const el = document.activeElement;
        return { id: el && el.id, inside: !!(root && el && root.contains(el)) };
      }));
    }
    assert.ok(ids.every((s) => s.inside), `Tab left overlay: ${JSON.stringify(ids)}`);
    await page.locator("#launchClose").focus();
    await page.keyboard.press("Shift+Tab");
    const back = await focusShot(page, "#launchOverlay");
    assert.equal(back.inside, true, `Shift+Tab left overlay: ${back.id || back.tag}`);
  });

  test("Escape or backdrop click closes the launch overlay and restores the previously focused element", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.keyboard.press("Escape");
    await page.locator("#launchOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");

    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.locator("#launchOverlay").click({ position: { x: 4, y: 4 }, force: true });
    await page.locator("#launchOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");
  });

  test("Opening the keys menu moves document.activeElement inside #keysMenu; Tab stays inside; Escape restores previous focus", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const html = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp/project", startedAt: "2026-08-10T12:00:00.000Z", status: "running" },
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.locator("#inputText").focus();
    await page.evaluate(() => document.getElementById("keysBtn").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("keysMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const menu = document.getElementById("keysMenu");
        return menu && menu.contains(document.activeElement);
      });
      assert.equal(inside, true, `keys Tab ${i} left the menu`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("keysMenu").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "inputText");
  });

  test("Opening the run-details popover moves document.activeElement inside #runMenu; Tab stays inside; Escape restores previous focus", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const html = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp/project", startedAt: "2026-08-10T12:00:00.000Z", status: "running" },
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.locator("#inputText").focus();
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+i`);
    await page.waitForFunction(() => {
      const menu = document.getElementById("runMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const menu = document.getElementById("runMenu");
        return menu && menu.contains(document.activeElement);
      });
      assert.equal(inside, true, `run menu Tab ${i} left the popover`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("runMenu").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "inputText");
    await page.keyboard.type("ok");
    assert.equal(await page.locator("#inputText").inputValue(), "ok");
  });

  test("After palette, launch, keys, or run-details overlays close, focus is not left on a hidden node", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    const afterPalette = await focusShot(page, "#cmdkOverlay");
    assert.equal(afterPalette.hidden, false);
    await page.keyboard.press("/");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "workspaceSearch");

    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.keyboard.press("Escape");
    await page.locator("#launchOverlay").waitFor({ state: "hidden" });
    const afterLaunch = await focusShot(page, "#launchOverlay");
    assert.equal(afterLaunch.hidden, false);
    await page.keyboard.type("abc");
    assert.match(await page.locator("#filterInput").inputValue(), /abc/);
  });

  test("Cmd+K over an open launch overlay focuses #cmdkInput and does not leave #cmdkOverlay inert", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.waitForSelector("#promptInput:focus");
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    const shot = await page.evaluate(() => {
      const pal = document.getElementById("cmdkOverlay");
      const launch = document.getElementById("launchOverlay");
      const el = document.activeElement;
      const palZ = pal ? parseInt(getComputedStyle(pal).zIndex, 10) : NaN;
      const launchZ = launch ? parseInt(getComputedStyle(launch).zIndex, 10) : NaN;
      return {
        id: el && el.id,
        palHidden: !!(pal && pal.hidden),
        palInert: !!(pal && pal.hasAttribute("inert")),
        launchHidden: !!(launch && launch.hidden),
        launchInert: !!(launch && launch.hasAttribute("inert")),
        insidePal: !!(pal && el && pal.contains(el)),
        palZ,
        launchZ,
      };
    });
    assert.equal(shot.insidePal, true);
    assert.equal(shot.id, "cmdkInput");
    assert.equal(shot.palHidden, false);
    assert.equal(shot.palInert, false, "palette must not be inert when stacked on top");
    assert.equal(shot.launchHidden, false);
    assert.equal(shot.launchInert, true, "launch under the palette is inert");
    assert.ok(shot.palZ > shot.launchZ, `palette z-index ${shot.palZ} must exceed launch ${shot.launchZ}`);
  });

  test("While the CommandPalette is stacked over the launch overlay, Tab stays inside #cmdkOverlay", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#promptInput:focus");
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    const ids = [];
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      ids.push(await page.evaluate(() => {
        const pal = document.getElementById("cmdkOverlay");
        const el = document.activeElement;
        return { id: el && el.id, inside: !!(pal && el && pal.contains(el)) };
      }));
    }
    assert.ok(ids.every((s) => s.inside), `Tab left palette over launch: ${JSON.stringify(ids)}`);
    await page.keyboard.press("Shift+Tab");
    const back = await focusShot(page, "#cmdkOverlay");
    assert.equal(back.inside, true, `Shift+Tab left palette over launch: ${back.id || back.tag}`);
  });

  test("Escape closes the stacked CommandPalette first without closing or leaving the launch overlay inert", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#promptInput:focus");
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    const afterPalette = await page.evaluate(() => {
      const pal = document.getElementById("cmdkOverlay");
      const launch = document.getElementById("launchOverlay");
      const el = document.activeElement;
      return {
        id: el && el.id,
        palHidden: !!(pal && pal.hidden),
        palInert: !!(pal && pal.hasAttribute("inert")),
        launchHidden: !!(launch && launch.hidden),
        launchInert: !!(launch && launch.hasAttribute("inert")),
        insideLaunch: !!(launch && el && launch.contains(el)),
      };
    });
    assert.equal(afterPalette.palHidden, true);
    assert.equal(afterPalette.launchHidden, false, "launch must stay open after palette Escape");
    assert.equal(afterPalette.launchInert, false, "launch must not be left inert");
    assert.equal(afterPalette.insideLaunch, true);
    assert.equal(afterPalette.id, "promptInput");
    await page.keyboard.type("ok");
    assert.match(await page.locator("#promptInput").inputValue(), /ok/);
    await page.keyboard.press("Escape");
    await page.locator("#launchOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");
  });

  test("Escape after Cmd+K opened over #workspaceSearch restores #workspaceSearch", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.locator("#workspaceSearch").focus();
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === "workspaceSearch");
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.activeElement && document.activeElement.id),
      "workspaceSearch",
    );
  });

  test("idle g then click New run then Escape then c does not navigate to /", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });

    async function becomeIdle() {
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
    }

    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.waitForSelector("#promptInput:focus");
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.type("/ojkg?x");
    assert.equal(await page.locator("#cmdkInput").inputValue(), "/ojkg?x", "Cmd+K over launch still types /ojkg?x");
    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.getElementById("launchOverlay").hidden), false, "launch stays open under palette");
    await page.keyboard.press("Escape");
    await page.locator("#launchOverlay").waitFor({ state: "hidden" });

    await becomeIdle();
    await page.keyboard.press("g");
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.keyboard.press("Escape");
    await page.locator("#launchOverlay").waitFor({ state: "hidden" });
    await becomeIdle();
    const hrefBeforeC = page.url();
    await page.keyboard.press("c");
    await page.waitForFunction((before) => location.href === before || location.pathname === "/", hrefBeforeC);
    const afterLaunch = new URL(page.url());
    assert.notEqual(afterLaunch.pathname, "/", "c after launch Escape must not complete g c and navigate to /");
    assert.equal(page.url(), hrefBeforeC, "armed g must not survive overlay keyboard ownership");

    await becomeIdle();
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForFunction(() => location.pathname === "/");
    assert.equal(new URL(page.url()).pathname, "/", "idle G then C still jumps when no overlay is open");
  });

  test("while a launch overlay button is focused, idle / does not focus #workspaceSearch and G-then-letter does not navigate", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.route("**/api/agents", (route) => {
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ mux: { available: true }, agents: [{ id: "claude" }] }),
      });
    });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("newRunBtn").click());
    await page.waitForSelector("#launchOverlay:not([hidden])");
    await page.locator("#launchClose").focus();
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === "launchClose");
    const hrefBefore = page.url();
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      launchHidden: document.getElementById("launchOverlay").hidden,
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
    }));
    assert.equal(afterSlash.ws, false, "/ must not focus #workspaceSearch behind launch");
    assert.equal(afterSlash.launchHidden, false);
    assert.ok(afterSlash.stack > 0);
    assert.notEqual(afterSlash.id, "workspaceSearch");
    await page.keyboard.press("g");
    await page.keyboard.press("r");
    assert.equal(page.url(), hrefBefore, "G then R must not navigate while launch owns the keyboard");
    assert.equal(await page.evaluate(() => document.getElementById("launchOverlay").hidden), false);
  });

  test("Opening the share-session dialog moves document.activeElement inside .hf-modal-overlay; Tab stays inside; Escape dismisses and restores previous focus", SKIP_NO_PLAYWRIGHT, async () => {
    assert.ok(sessionId, "seeded /view session");
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    const shareBtn = page.locator("button.hf-btn");
    await shareBtn.waitFor({ state: "visible", timeout: 15_000 });
    await shareBtn.focus();
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains("hf-btn"));
    await shareBtn.click();
    await page.waitForSelector(".hf-modal-overlay");
    await page.waitForFunction(() => {
      const root = document.querySelector(".hf-modal-overlay");
      return !!(root && root.contains(document.activeElement));
    });
    const open = await page.evaluate(() => {
      const root = document.querySelector(".hf-modal-overlay");
      const dialog = root && root.querySelector('[role="dialog"]');
      const el = document.activeElement;
      return {
        inside: !!(root && el && root.contains(el)),
        role: dialog && dialog.getAttribute("role"),
        modal: dialog && dialog.getAttribute("aria-modal"),
        stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
      };
    });
    assert.equal(open.inside, true, "open must move focus into the share dialog");
    assert.equal(open.role, "dialog");
    assert.equal(open.modal, "true");
    assert.ok(open.stack > 0, "share dialog must join __tqOverlayStack");
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const root = document.querySelector(".hf-modal-overlay");
        return !!(root && root.contains(document.activeElement));
      });
      assert.equal(inside, true, `share Tab ${i} left the dialog`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".hf-modal-overlay"));
    const after = await page.evaluate(() => ({
      cls: document.activeElement && document.activeElement.className,
      modal: !!document.querySelector(".hf-modal-overlay"),
      hidden: !!(document.activeElement && document.activeElement !== document.body && (
        document.activeElement.hidden || (document.activeElement.closest && document.activeElement.closest("[hidden]"))
      )),
    }));
    assert.equal(after.modal, false);
    assert.equal(after.hidden, false);
    assert.match(String(after.cls || ""), /\bhf-btn\b/, "Escape restores the Share invoker");
  });

  test("while a share-session dialog button is focused, idle / does not focus #workspaceSearch and the modal stays up", SKIP_NO_PLAYWRIGHT, async () => {
    assert.ok(sessionId, "seeded /view session");
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("button.hf-btn").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("button.hf-btn").click();
    await page.waitForSelector(".hf-modal-overlay");
    await page.locator("button.hf-modal-cancel").focus();
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains("hf-modal-cancel"));
    const hrefBefore = page.url();
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      cls: document.activeElement && document.activeElement.className,
      modal: !!document.querySelector(".hf-modal-overlay"),
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
    }));
    assert.equal(afterSlash.ws, false, "/ must not focus #workspaceSearch behind share modal");
    assert.equal(afterSlash.modal, true, "share modal must stay up");
    assert.ok(afterSlash.stack > 0);
    assert.notEqual(afterSlash.id, "workspaceSearch");
    await page.keyboard.press("g");
    await page.keyboard.press("r");
    assert.equal(page.url(), hrefBefore, "G then R must not navigate while share owns the keyboard");
    assert.equal(await page.evaluate(() => !!document.querySelector(".hf-modal-overlay")), true);
  });

  test("Cmd+K over the /view share modal focuses #cmdkInput, paints #cmdkOverlay above .hf-modal-overlay, types /ojkg?x, and Escape closes the palette first", SKIP_NO_PLAYWRIGHT, async () => {
    assert.ok(sessionId, "seeded /view session");
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.locator("button.hf-btn").waitFor({ state: "visible", timeout: 15_000 });
    await page.locator("button.hf-btn").click();
    await page.waitForSelector(".hf-modal-overlay");
    await page.waitForFunction(() => {
      const root = document.querySelector(".hf-modal-overlay");
      return !!(root && root.contains(document.activeElement));
    });
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    const stacked = await page.evaluate(() => {
      const pal = document.getElementById("cmdkOverlay");
      const share = document.querySelector(".hf-modal-overlay");
      const input = document.getElementById("cmdkInput");
      const el = document.activeElement;
      const palZ = pal ? parseInt(getComputedStyle(pal).zIndex, 10) : NaN;
      const shareZ = share ? parseInt(getComputedStyle(share).zIndex, 10) : NaN;
      const r = input ? input.getBoundingClientRect() : null;
      const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
      return {
        id: el && el.id,
        palHidden: !!(pal && pal.hidden),
        palInert: !!(pal && pal.hasAttribute("inert")),
        sharePresent: !!share,
        shareInert: !!(share && share.hasAttribute("inert")),
        palZ,
        shareZ,
        hitInsidePal: !!(pal && hit && pal.contains(hit)),
        hitInsideShare: !!(share && hit && share.contains(hit)),
        hitId: hit && hit.id,
        hitTag: hit && hit.tagName,
        hitClass: hit && hit.className,
        stackIds: (window.__tqOverlayStack || []).map((n) => n && n.id),
      };
    });
    assert.equal(stacked.id, "cmdkInput", "Cmd+K over share must focus the palette combobox");
    assert.equal(stacked.palHidden, false);
    assert.equal(stacked.palInert, false, "palette must not be inert when stacked on share");
    assert.equal(stacked.sharePresent, true, "share stays mounted under the palette");
    assert.equal(stacked.shareInert, true, "share under the palette is inert");
    assert.ok(stacked.palZ > stacked.shareZ, `palette z-index ${stacked.palZ} must exceed share ${stacked.shareZ}`);
    assert.equal(stacked.hitInsidePal, true, `combobox is covered by ${stacked.hitId || stacked.hitClass || stacked.hitTag}`);
    assert.equal(stacked.hitInsideShare, false, "share must not paint over the focused combobox");
    await page.keyboard.type("/ojkg?x");
    assert.equal(await page.locator("#cmdkInput").inputValue(), "/ojkg?x");
    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    const after = await page.evaluate(() => {
      const pal = document.getElementById("cmdkOverlay");
      const share = document.querySelector(".hf-modal-overlay");
      const el = document.activeElement;
      return {
        palHidden: !!(pal && pal.hidden),
        sharePresent: !!share,
        shareInert: !!(share && share.hasAttribute("inert")),
        insideShare: !!(share && el && share.contains(el)),
      };
    });
    assert.equal(after.palHidden, true, "Escape closes the palette first");
    assert.equal(after.sharePresent, true, "share remains after palette Escape");
    assert.equal(after.shareInert, false, "share must not be left inert");
    assert.equal(after.insideShare, true, "focus returns to the share dialog");
  });

  test("while a keys menu .run-key-btn is focused, idle / does not focus #workspaceSearch and #keysMenu stays open on the overlay stack", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const html = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp/project", startedAt: "2026-08-10T12:00:00.000Z", status: "running" },
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("keysBtn").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("keysMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    await page.locator(".run-key-btn").first().focus();
    await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains("run-key-btn"));
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      cls: document.activeElement && document.activeElement.className,
      keysHidden: document.getElementById("keysMenu").hidden,
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
    }));
    assert.equal(afterSlash.ws, false, "/ must not focus #workspaceSearch behind keys menu");
    assert.equal(afterSlash.keysHidden, false, "keys menu must stay open");
    assert.ok(afterSlash.stack > 0, "keys menu must join __tqOverlayStack");
    assert.notEqual(afterSlash.id, "workspaceSearch");
  });

  test("keys menu is an APG modal dialog: role=dialog, page behind inert, / does not focus #workspaceSearch", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const html = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp/project", startedAt: "2026-08-10T12:00:00.000Z", status: "running" },
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("keysBtn").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("keysMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    const shot = await page.evaluate(() => {
      function inertAncestor(el) {
        for (let n = el; n; n = n.parentElement) {
          if (n.hasAttribute && n.hasAttribute("inert")) return true;
        }
        return false;
      }
      const menu = document.getElementById("keysMenu");
      const wrap = document.getElementById("workspaceSearchWrap");
      const composer = document.getElementById("inputText");
      const shell = document.querySelector(".tq-shell");
      let bodyChild = menu;
      while (bodyChild && bodyChild.parentElement !== document.body) bodyChild = bodyChild.parentElement;
      return {
        role: menu && menu.getAttribute("role"),
        ariaModal: menu && menu.getAttribute("aria-modal"),
        inShell: !!(shell && menu && shell.contains(menu)),
        overlayId: bodyChild && bodyChild.id,
        shellInert: !!(shell && shell.hasAttribute("inert")),
        wsInertAncestor: inertAncestor(wrap) || inertAncestor(document.getElementById("workspaceSearch")),
        composerInert: inertAncestor(composer),
        wrapInert: !!(wrap && wrap.hasAttribute("inert")),
      };
    });
    assert.equal(shot.role, "dialog", "keys menu is role=dialog");
    assert.equal(shot.ariaModal, "true", "keys menu is aria-modal");
    assert.equal(shot.inShell, false, "keys menu is not inside .tq-shell");
    assert.equal(shot.overlayId, "keysOverlay", "keys overlay is a body child");
    assert.equal(shot.shellInert, true, ".tq-shell is inert");
    assert.equal(shot.wsInertAncestor, true, "#workspaceSearch is under an inert ancestor");
    assert.equal(shot.composerInert, true, "composer is under an inert ancestor");
    await page.locator(".run-key-btn").first().focus();
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      keysHidden: document.getElementById("keysMenu").hidden,
    }));
    assert.equal(afterSlash.ws, false, "/ must not focus #workspaceSearch behind keys dialog");
    assert.equal(afterSlash.keysHidden, false, "keys menu must stay open");
    assert.notEqual(afterSlash.id, "workspaceSearch");
  });

  test("run-details is an APG modal dialog: role=dialog, page behind inert, / does not focus #workspaceSearch", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const html = runPage({
      run: { id: "@1", agent: "claude", cwd: "/tmp/project", startedAt: "2026-08-10T12:00:00.000Z", status: "running" },
    });
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    await page.locator("#inputText").focus();
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+i`);
    await page.waitForFunction(() => {
      const menu = document.getElementById("runMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    const shot = await page.evaluate(() => {
      function inertAncestor(el) {
        for (let n = el; n; n = n.parentElement) {
          if (n.hasAttribute && n.hasAttribute("inert")) return true;
        }
        return false;
      }
      const menu = document.getElementById("runMenu");
      const wrap = document.getElementById("workspaceSearchWrap");
      const composer = document.getElementById("inputText");
      const shell = document.querySelector(".tq-shell");
      let bodyChild = menu;
      while (bodyChild && bodyChild.parentElement !== document.body) bodyChild = bodyChild.parentElement;
      return {
        role: menu && menu.getAttribute("role"),
        ariaModal: menu && menu.getAttribute("aria-modal"),
        inShell: !!(shell && menu && shell.contains(menu)),
        overlayId: bodyChild && bodyChild.id,
        shellInert: !!(shell && shell.hasAttribute("inert")),
        wsInertAncestor: inertAncestor(wrap) || inertAncestor(document.getElementById("workspaceSearch")),
        composerInert: inertAncestor(composer),
      };
    });
    assert.equal(shot.role, "dialog", "run-details is role=dialog");
    assert.equal(shot.ariaModal, "true", "run-details is aria-modal");
    assert.equal(shot.inShell, false, "run-details is not inside .tq-shell");
    assert.equal(shot.overlayId, "runOverlay", "run overlay is a body child");
    assert.equal(shot.shellInert, true, ".tq-shell is inert");
    assert.equal(shot.wsInertAncestor, true, "#workspaceSearch is under an inert ancestor");
    assert.equal(shot.composerInert, true, "composer is under an inert ancestor");
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      runHidden: document.getElementById("runMenu").hidden,
    }));
    assert.equal(afterSlash.ws, false, "/ must not focus #workspaceSearch behind run-details");
    assert.equal(afterSlash.runHidden, false, "run-details must stay open");
    assert.notEqual(afterSlash.id, "workspaceSearch");
  });

  test("Opening #ageMenu, #sourceMenu, or #sortBar moves document.activeElement inside the menu; Tab stays inside; Escape restores previous focus", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.getElementById("ageBtn").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("ageMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const menu = document.getElementById("ageMenu");
        return menu && menu.contains(document.activeElement);
      });
      assert.equal(inside, true, `ageMenu Tab ${i} left the menu`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("ageMenu").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");

    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.getElementById("sourceBtn").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("sourceMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => {
      const menu = document.getElementById("sourceMenu");
      return !!(menu && menu.contains(document.activeElement));
    }), true, "sourceMenu Tab left the menu");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("sourceMenu").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");

    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.getElementById("displayToggle").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("sortBar");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => {
      const menu = document.getElementById("sortBar");
      return !!(menu && menu.contains(document.activeElement));
    }), true, "sortBar Tab left the menu");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("sortBar").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");
  });

  test("while a rail toolbar menu option is focused, idle / does not focus #workspaceSearch and the menu stays open on the overlay stack", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => document.getElementById("ageBtn").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("ageMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    await page.locator("#ageMenu .toolbar-option").first().focus();
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      cls: document.activeElement && document.activeElement.className,
      ageHidden: document.getElementById("ageMenu").hidden,
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
      onStack: !!(window.__tqOverlayStack && window.__tqOverlayStack.includes(document.getElementById("ageMenu"))),
    }));
    assert.equal(afterSlash.ws, false, "/ must not focus #workspaceSearch behind ageMenu");
    assert.equal(afterSlash.ageHidden, false, "ageMenu must stay open");
    assert.ok(afterSlash.stack > 0, "ageMenu must join __tqOverlayStack");
    assert.equal(afterSlash.onStack, true, "ageMenu must be on __tqOverlayStack");
    assert.notEqual(afterSlash.id, "workspaceSearch");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("ageMenu").hidden);
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    await page.keyboard.press("/");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "workspaceSearch");
  });

  test("open #ageMenu inerts the page behind so a session row click does not navigate to /run", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ageBtn");
    await page.evaluate(() => document.getElementById("ageBtn").click());
    await page.waitForFunction(() => {
      const menu = document.getElementById("ageMenu");
      return menu && !menu.hidden && menu.contains(document.activeElement);
    });
    const inertShot = await page.evaluate(() => {
      function inertAncestor(el) {
        for (let n = el; n; n = n.parentElement) {
          if (n.hasAttribute && n.hasAttribute("inert")) return true;
        }
        return false;
      }
      const menu = document.getElementById("ageMenu");
      const row = document.querySelector(".session-row, .run-row");
      const wrap = document.querySelector(".session-row-wrap");
      const inventory = document.querySelector(".runs-inventory, #sessions");
      const shell = document.querySelector(".tq-shell, .container, .runs-home, #app");
      return {
        menuHidden: !!(menu && menu.hidden),
        menuInert: !!(menu && menu.hasAttribute("inert")),
        menuParentIsBody: !!(menu && menu.parentElement === document.body),
        onStack: !!(window.__tqOverlayStack && window.__tqOverlayStack.includes(menu)),
        rowInert: !!(row && inertAncestor(row)),
        wrapInert: !!(wrap && inertAncestor(wrap)),
        inventoryInert: !!(inventory && inertAncestor(inventory)),
        wsInert: inertAncestor(document.getElementById("workspaceSearch")),
        rowHref: row && (row.getAttribute("data-href") || row.getAttribute("href") || ""),
      };
    });
    assert.equal(inertShot.menuHidden, false, "ageMenu must stay open");
    assert.equal(inertShot.menuInert, false, "ageMenu itself is not inert");
    assert.equal(inertShot.menuParentIsBody, false, "ageMenu stays nested (not a body child)");
    assert.equal(inertShot.onStack, true, "ageMenu remains on __tqOverlayStack");
    assert.equal(inertShot.rowInert || inertShot.wrapInert || inertShot.inventoryInert, true, "session row sits under an inert ancestor");
    assert.equal(inertShot.wsInert, true, "#workspaceSearch is under an inert ancestor");

    await page.keyboard.press("Tab");
    const tabInside = await page.evaluate(() => {
      const menu = document.getElementById("ageMenu");
      return !!(menu && menu.contains(document.activeElement));
    });
    assert.equal(tabInside, true, "Tab must stay inside #ageMenu");
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      ageHidden: document.getElementById("ageMenu").hidden,
    }));
    assert.equal(afterSlash.ws, false, "/ must not steal to #workspaceSearch");
    assert.equal(afterSlash.ageHidden, false, "ageMenu must stay open on /");

    const row = page.locator(".session-row, .run-row").first();
    const rowCount = await row.count();
    if (rowCount > 0) {
      await row.click({ timeout: 1500, force: true });
    } else {
      await page.mouse.click(640, 420);
    }
    const afterUrl = page.url();
    const afterPath = new URL(afterUrl).pathname;
    assert.equal(afterPath === "/run" || afterPath.startsWith("/run"), false, `session row click must not navigate to /run (was ${afterUrl})`);
    assert.ok(afterPath === "/sessions" || afterPath === "/", `must stay on sessions, got ${afterPath}`);
    assert.ok(!/\/view/.test(afterPath), `session row click must not navigate to /view (was ${afterUrl})`);

    const stillOpen = await page.evaluate(() => !document.getElementById("ageMenu").hidden);
    if (stillOpen) await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("ageMenu").hidden);

    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.type("/ojkg?x");
    const cmdk = await page.$eval("#cmdkInput", (el) => el.value);
    assert.equal(cmdk, "/ojkg?x", "Cmd+K then /ojkg?x still inserts into the palette");
  });

  test("Opening #sessionFlyout moves document.activeElement inside the flyout; Tab stays trapped; Escape restores previous focus", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.session-row");
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.querySelector("a.session-row").click());
    await page.waitForFunction(() => {
      const fly = document.getElementById("sessionFlyout");
      return fly && !fly.hidden && fly.contains(document.activeElement);
    });
    const opened = await page.evaluate(() => {
      const fly = document.getElementById("sessionFlyout");
      return {
        hidden: !!(fly && fly.hidden),
        inside: !!(fly && fly.contains(document.activeElement)),
        onStack: !!(window.__tqOverlayStack && window.__tqOverlayStack.includes(fly)),
        role: fly && fly.getAttribute("role"),
        ariaModal: fly && fly.getAttribute("aria-modal"),
        activeId: document.activeElement && document.activeElement.id,
      };
    });
    assert.equal(opened.hidden, false);
    assert.equal(opened.inside, true, "focus moved into #sessionFlyout");
    assert.equal(opened.onStack, true, "#sessionFlyout must join __tqOverlayStack");
    assert.equal(opened.role, "dialog");
    assert.equal(opened.ariaModal, "true");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(() => {
        const fly = document.getElementById("sessionFlyout");
        const el = document.activeElement;
        return !!(fly && el && fly.contains(el) && el !== document.body);
      });
      assert.equal(inside, true, `sessionFlyout Tab ${i} left the flyout`);
    }
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("sessionFlyout").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");
  });

  test("while #sessionFlyout is open, idle / does not focus #workspaceSearch and the flyout stays open on the overlay stack", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.session-row");
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.querySelector("a.session-row").click());
    await page.waitForFunction(() => {
      const fly = document.getElementById("sessionFlyout");
      return fly && !fly.hidden && fly.contains(document.activeElement);
    });
    await page.locator("#sessionFlyoutOpen").focus();
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      id: document.activeElement && document.activeElement.id,
      flyHidden: document.getElementById("sessionFlyout").hidden,
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      stack: (window.__tqOverlayStack && window.__tqOverlayStack.length) || 0,
      onStack: !!(window.__tqOverlayStack && window.__tqOverlayStack.includes(document.getElementById("sessionFlyout"))),
    }));
    assert.equal(afterSlash.ws, false, "/ must not focus #workspaceSearch behind sessionFlyout");
    assert.equal(afterSlash.flyHidden, false, "sessionFlyout must stay open");
    assert.ok(afterSlash.stack > 0, "sessionFlyout must join __tqOverlayStack");
    assert.equal(afterSlash.onStack, true, "sessionFlyout must be on __tqOverlayStack");
    assert.notEqual(afterSlash.id, "workspaceSearch");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("sessionFlyout").hidden);
    await page.evaluate(() => { const el = document.activeElement; if (el && el.blur) el.blur(); });
    await page.keyboard.press("/");
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "workspaceSearch");
  });

  test("open #sessionFlyout inerts the page behind so / does not steal to #workspaceSearch", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.session-row");
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.querySelector("a.session-row").click());
    await page.waitForFunction(() => {
      const fly = document.getElementById("sessionFlyout");
      return fly && !fly.hidden && fly.contains(document.activeElement);
    });
    const inertShot = await page.evaluate(() => {
      function inertAncestor(el) {
        for (let n = el; n; n = n.parentElement) {
          if (n.hasAttribute && n.hasAttribute("inert")) return true;
        }
        return false;
      }
      const fly = document.getElementById("sessionFlyout");
      const row = document.querySelector(".session-row, .run-row");
      const wrap = document.querySelector(".session-row-wrap");
      const inventory = document.querySelector(".runs-inventory, #sessions");
      return {
        flyHidden: !!(fly && fly.hidden),
        flyInert: !!(fly && fly.hasAttribute("inert")),
        flyParentIsBody: !!(fly && fly.parentElement === document.body),
        onStack: !!(window.__tqOverlayStack && window.__tqOverlayStack.includes(fly)),
        role: fly && fly.getAttribute("role"),
        ariaModal: fly && fly.getAttribute("aria-modal"),
        rowInert: !!(row && inertAncestor(row)),
        wrapInert: !!(wrap && inertAncestor(wrap)),
        inventoryInert: !!(inventory && inertAncestor(inventory)),
        wsInert: inertAncestor(document.getElementById("workspaceSearch")),
        filterInert: inertAncestor(document.getElementById("filterInput")),
      };
    });
    assert.equal(inertShot.flyHidden, false, "sessionFlyout must stay open");
    assert.equal(inertShot.flyInert, false, "sessionFlyout itself is not inert");
    assert.equal(inertShot.flyParentIsBody, true, "sessionFlyout is a body child");
    assert.equal(inertShot.onStack, true, "sessionFlyout remains on __tqOverlayStack");
    assert.equal(inertShot.role, "dialog");
    assert.equal(inertShot.ariaModal, "true");
    assert.equal(inertShot.rowInert || inertShot.wrapInert || inertShot.inventoryInert, true, "session row sits under an inert ancestor");
    assert.equal(inertShot.wsInert, true, "#workspaceSearch is under an inert ancestor");
    assert.equal(inertShot.filterInert, true, "#filterInput is under an inert ancestor");

    await page.keyboard.press("Tab");
    const tabInside = await page.evaluate(() => {
      const fly = document.getElementById("sessionFlyout");
      return !!(fly && fly.contains(document.activeElement));
    });
    assert.equal(tabInside, true, "Tab must stay inside #sessionFlyout");
    await page.keyboard.press("/");
    const afterSlash = await page.evaluate(() => ({
      ws: document.activeElement && document.activeElement.id === "workspaceSearch",
      flyHidden: document.getElementById("sessionFlyout").hidden,
    }));
    assert.equal(afterSlash.ws, false, "/ must not steal to #workspaceSearch");
    assert.equal(afterSlash.flyHidden, false, "sessionFlyout must stay open on /");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("sessionFlyout").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");

    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.type("/ojkg?x");
    const cmdk = await page.$eval("#cmdkInput", (el) => el.value);
    assert.equal(cmdk, "/ojkg?x", "Cmd+K then /ojkg?x still inserts into the palette");
  });

  test("click inside #sessionFlyoutFrame Tab wraps back to flyout chrome; Escape still dismisses", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.session-row");
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.querySelector("a.session-row").click());
    await page.waitForFunction(() => {
      const fly = document.getElementById("sessionFlyout");
      return fly && !fly.hidden && fly.contains(document.activeElement);
    });
    await page.waitForSelector("#sessionFlyoutFrame:not([hidden])");
    const embed = page.frameLocator("#sessionFlyoutFrame");
    await embed.locator("#app").waitFor({ state: "visible", timeout: 15_000 });
    const errorDot = embed.locator(".error-dot.has-error").first();
    if (await errorDot.count()) await errorDot.click({ force: true });
    else await embed.locator("body").click({ position: { x: 16, y: 16 }, force: true });

    async function flyoutTabShot() {
      return page.evaluate(() => {
        const fly = document.getElementById("sessionFlyout");
        const frame = document.getElementById("sessionFlyoutFrame");
        const el = document.activeElement;
        const chrome = ["sessionFlyoutOpen", "sessionFlyoutPrev", "sessionFlyoutNext", "sessionFlyoutClose"];
        let innerTag = null;
        let innerClass = "";
        try {
          if (el === frame && frame && frame.contentDocument && frame.contentDocument.activeElement) {
            innerTag = frame.contentDocument.activeElement.tagName;
            innerClass = String(frame.contentDocument.activeElement.className || "");
          }
        } catch (e0) {}
        return {
          parentId: el && el.id,
          inFlyout: !!(fly && el && fly.contains(el) && el !== document.body),
          inFrame: el === frame,
          onChrome: !!(el && chrome.includes(el.id)),
          innerTag,
          innerClass,
          flyHidden: !!(fly && fly.hidden),
        };
      });
    }

    let wrapped = false;
    let last = null;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      last = await flyoutTabShot();
      assert.equal(last.inFlyout, true, `Tab ${i} left #sessionFlyout (id=${last.parentId} inner=${last.innerTag}.${last.innerClass})`);
      if (last.onChrome) {
        wrapped = true;
        break;
      }
    }
    assert.equal(wrapped, true, `Tab from nested /view iframe must wrap back to flyout chrome (last=${JSON.stringify(last)})`);

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("sessionFlyout").hidden);
    assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "filterInput");

    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.type("/ojkg?x");
    const cmdk = await page.$eval("#cmdkInput", (el) => el.value);
    assert.equal(cmdk, "/ojkg?x", "Cmd+K then /ojkg?x still inserts into the palette");
  });

  test("Cmd+K inside #sessionFlyoutFrame opens the parent palette the same way Cmd+K over launch does", SKIP_NO_PLAYWRIGHT, async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a.session-row");
    await page.locator("#filterInput").focus();
    await page.evaluate(() => document.querySelector("a.session-row").click());
    await page.waitForFunction(() => {
      const fly = document.getElementById("sessionFlyout");
      return fly && !fly.hidden && fly.contains(document.activeElement);
    });
    await page.waitForSelector("#sessionFlyoutFrame:not([hidden])");
    const embed = page.frameLocator("#sessionFlyoutFrame");
    await embed.locator("#app").waitFor({ state: "visible", timeout: 15_000 });
    const errorDot = embed.locator(".error-dot.has-error").first();
    if (await errorDot.count()) await errorDot.click({ force: true });
    else await embed.locator("body").click({ position: { x: 16, y: 16 }, force: true });
    await page.waitForFunction(() => {
      const frame = document.getElementById("sessionFlyoutFrame");
      return document.activeElement === frame;
    });

    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    const stacked = await page.evaluate(() => {
      const pal = document.getElementById("cmdkOverlay");
      const fly = document.getElementById("sessionFlyout");
      const palZ = pal ? parseInt(getComputedStyle(pal).zIndex, 10) : 0;
      const flyZ = fly ? parseInt(getComputedStyle(fly).zIndex, 10) : 0;
      return {
        palHidden: !!(pal && pal.hidden),
        palInert: !!(pal && pal.hasAttribute("inert")),
        flyHidden: !!(fly && fly.hidden),
        flyInert: !!(fly && fly.hasAttribute("inert")),
        active: document.activeElement && document.activeElement.id,
        palZ,
        flyZ,
      };
    });
    assert.equal(stacked.palHidden, false, "parent #cmdkOverlay must open from iframe Cmd+K");
    assert.equal(stacked.palInert, false, "parent palette must not be inert");
    assert.equal(stacked.flyHidden, false, "#sessionFlyout stays open under the palette");
    assert.equal(stacked.flyInert, true, "#sessionFlyout is inert under the stacked palette");
    assert.equal(stacked.active, "cmdkInput");
    assert.ok(stacked.palZ > stacked.flyZ, `palette z ${stacked.palZ} must exceed flyout z ${stacked.flyZ}`);

    await page.keyboard.type("/ojkg?x");
    const fromIframe = await page.$eval("#cmdkInput", (el) => el.value);
    assert.equal(fromIframe, "/ojkg?x", "Cmd+K from #sessionFlyoutFrame must type /ojkg?x into parent #cmdkInput");

    await page.keyboard.press("Escape");
    await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.getElementById("sessionFlyout").hidden), false, "Escape pops the palette first; flyout stays");

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.getElementById("sessionFlyout").hidden);
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && typeof el.blur === "function") el.blur();
    });
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkInput:focus");
    await page.keyboard.type("/ojkg?x");
    const fromParent = await page.$eval("#cmdkInput", (el) => el.value);
    assert.equal(fromParent, "/ojkg?x", "parent-document Cmd+K still types /ojkg?x");
  });
});
