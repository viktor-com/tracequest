/**
 * Command palette live keyboard paths: open, empty groups, typed filter,
 * no-results, Escape / backdrop / toggle close.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { mkTmp, writeClaudeJsonl, CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const SEARCH_NEEDLE = "cmdk-search-needle-alpha";

function seedPaletteSearchHome() {
  const home = mkTmp("tracequest-cmdk-search-");
  const dir = join(home, ".claude", "projects", "-home-dev-tracequest");
  mkdirSync(dir, { recursive: true });
  writeClaudeJsonl(dir, "palette-search.jsonl", [
    {
      type: "user",
      sessionId: "cmdk-search-1",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T12:00:00.000Z",
      uuid: "u-cmdk-search-1",
      isMeta: false,
      message: { content: [{ type: "text", text: `Document ${SEARCH_NEEDLE} for the command menu` }] },
    },
    {
      type: "assistant",
      sessionId: "cmdk-search-1",
      timestamp: "2026-06-03T12:00:00.000Z",
      uuid: "a-cmdk-search-1",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: `Indexed ${SEARCH_NEEDLE} snippet for ranked hits` }],
      },
    },
  ]);
  writeClaudeJsonl(dir, "other-session.jsonl", [
    {
      type: "user",
      sessionId: "cmdk-search-2",
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T11:00:00.000Z",
      uuid: "u-cmdk-search-2",
      isMeta: false,
      message: { content: [{ type: "text", text: "Unrelated other prompt about logging" }] },
    },
    {
      type: "assistant",
      sessionId: "cmdk-search-2",
      timestamp: "2026-06-03T11:00:00.000Z",
      uuid: "a-cmdk-search-2",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "ok" }],
      },
    },
  ]);
  return home;
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

async function waitForSearchHit(port, query, child, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`serve exited early (${child.exitCode})\nstdout: ${child._stdout}\nstderr: ${child._stderr}`);
    }
    try {
      const res = await httpGetJson(port, `/api/search?q=${encodeURIComponent(query)}`);
      if (res.status === 200 && res.data.results && res.data.results.length >= 1) return res.data;
      lastErr = new Error(`search not ready: ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw lastErr ?? new Error(`timed out waiting for search ${query}`);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

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

describe("command palette — live keyboard", () => {
  let child;
  let port;
  let browser;

  after(async () => {
    if (browser) await browser.close().catch(() => {});
    if (child) await stopServe(child);
  });

  test("Cmd/Ctrl+K opens grouped chrome, filters, shows no-results, and closes", SKIP_NO_PLAYWRIGHT, async () => {
    const home = mkTmp("tracequest-cmdk-");
    port = await allocEphemeralPort();
    child = spawnServe(port, home);
    await waitForHttp(port, "/sessions", child);

    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${port}/sessions`, { waitUntil: "domcontentloaded" });

    const overlay = page.locator("#cmdkOverlay");
    assert.equal(await overlay.getAttribute("hidden"), "");
    assert.equal(await overlay.getAttribute("data-cmdk-state"), "closed");

    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkOverlay:not([hidden])");
    assert.equal(await overlay.getAttribute("data-cmdk-state"), "open");

    const layer = await page.evaluate(() => {
      const root = document.getElementById("cmdkOverlay");
      const scrim = document.getElementById("cmdkScrim") || root.querySelector(".cmdk-scrim");
      const dialog = root.querySelector(".cmdk");
      const or = root.getBoundingClientRect();
      const sr = scrim.getBoundingClientRect();
      const bg = getComputedStyle(scrim).backgroundColor;
      const m = bg.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      const alpha = m ? (m[4] == null ? 1 : Number(m[4])) : 0;
      return {
        overlayFull: Math.abs(or.width - window.innerWidth) < 1 && Math.abs(or.height - window.innerHeight) < 1,
        scrimFull: Math.abs(sr.width - window.innerWidth) < 1 && Math.abs(sr.height - window.innerHeight) < 1,
        alpha,
        dialogAbove: dialog && getComputedStyle(dialog).zIndex !== "auto",
        bodyOpen: document.body.classList.contains("cmdk-open"),
      };
    });
    assert.equal(layer.overlayFull, true, "overlay covers the viewport");
    assert.equal(layer.scrimFull, true, "scrim covers the viewport");
    assert.ok(layer.alpha >= 0.55, `scrim alpha should recede the page, got ${layer.alpha}`);
    assert.equal(layer.bodyOpen, true);

    const input = page.locator("#cmdkInput");
    assert.equal(await input.getAttribute("placeholder"), "Type a command or search...");
    assert.ok(await input.evaluate((el) => el === document.activeElement));

    const groups = await page.locator(".cmdk-group-label").allTextContents();
    assert.ok(groups.includes("This page"), `groups: ${groups.join(",")}`);
    assert.ok(groups.includes("Go to"), `groups: ${groups.join(",")}`);
    assert.ok(!groups.includes("Search"), `empty query should not list Search fallback: ${groups.join(",")}`);

    const titles = await page.locator(".cmdk-item-title").allTextContents();
    assert.ok(titles.some((t) => /Go to Runs/.test(t)), titles.join(","));
    assert.ok(titles.some((t) => /Go to Chat/.test(t)), titles.join(","));
    assert.ok(titles.some((t) => /Go to Compare/.test(t)), titles.join(","));
    assert.ok(titles.includes("New run"));
    assert.ok(titles.includes("Focus filter"));
    assert.equal(await page.locator(".cmdk-item.hl").count(), 1);

    await input.fill("compare");
    await page.waitForFunction(() => {
      const labels = [...document.querySelectorAll(".cmdk-group-label")].map((el) => el.textContent);
      return labels.includes("Go to") && document.querySelector(".cmdk-item-title")?.textContent.includes("Compare");
    });
    const filtered = await page.locator(".cmdk-item-title").allTextContents();
    assert.ok(filtered.some((t) => /compare/i.test(t)), filtered.join(","));

    await input.fill("zzzzzxxyyqq");
    await page.waitForSelector("#cmdkEmpty:not([hidden])");
    const emptyText = await page.locator("#cmdkEmpty").innerText();
    assert.match(emptyText, /Search for/);
    assert.match(emptyText, /zzzzzxxyyqq/);
    assert.match(await page.locator(".cmdk-item").innerText(), /No results found/);
    assert.match(await page.locator(".cmdk-empty-action").innerText(), /Search sessions/);
    const emptyOwnsLayer = await page.evaluate(() => {
      const overlay = document.getElementById("cmdkOverlay");
      const scrim = document.getElementById("cmdkScrim");
      if (!overlay || overlay.hidden || !scrim) return false;
      const sr = scrim.getBoundingClientRect();
      return Math.abs(sr.width - window.innerWidth) < 1 && Math.abs(sr.height - window.innerHeight) < 1;
    });
    assert.equal(emptyOwnsLayer, true, "collapsed no-results still owns the full-viewport scrim");

    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "hidden" });
    assert.equal(await overlay.getAttribute("data-cmdk-state"), "closed");

    await page.keyboard.press(`${meta}+k`);
    await overlay.waitFor({ state: "visible" });
    await page.keyboard.press(`${meta}+k`);
    await overlay.waitFor({ state: "hidden" });

    await page.keyboard.press(`${meta}+k`);
    await overlay.waitFor({ state: "visible" });
    const box = await overlay.boundingBox();
    await page.mouse.click(box.x + 4, box.y + 4);
    await overlay.waitFor({ state: "hidden" });

    const trigger = page.locator("#cmdkTrigger");
    await trigger.click();
    await overlay.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await overlay.waitFor({ state: "hidden" });
  });

  test("typed query ranks pickable session hits with identity and snippets", SKIP_NO_PLAYWRIGHT, async () => {
    const home = seedPaletteSearchHome();
    const searchPort = await allocEphemeralPort();
    const searchChild = spawnServe(searchPort, home);
    const prevChild = child;
    child = searchChild;
    if (prevChild) await stopServe(prevChild);
    await waitForHttp(searchPort, "/sessions", searchChild);
    const indexed = await waitForSearchHit(searchPort, SEARCH_NEEDLE, searchChild);
    const hit = indexed.results[0];
    assert.ok(hit.id || hit.sessionHash, "search hit has id");
    const hitId = hit.id || hit.sessionHash;

    if (browser) await browser.close().catch(() => {});
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${searchPort}/sessions`, { waitUntil: "domcontentloaded" });

    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkOverlay:not([hidden])");

    await page.waitForFunction(() => {
      return [...document.querySelectorAll(".cmdk-group-label")].some((el) => el.textContent === "Recent")
        && document.querySelector(".cmdk-item[data-kind='session']");
    });
    const recentIds = await page.locator(".cmdk-item[data-kind='session']").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-session-id")),
    );
    assert.ok(recentIds.includes(hitId), `recent should include ${hitId}, got ${recentIds.join(",")}`);
    const recentSrc = await page.locator(".cmdk-item[data-kind='session'] .cmdk-src").first().textContent();
    assert.match(recentSrc, /claude/i);
    const recentSid = await page.locator(".cmdk-item[data-kind='session'] .cmdk-sid").first().textContent();
    assert.ok(recentSid);

    const input = page.locator("#cmdkInput");
    await input.fill(SEARCH_NEEDLE);
    await page.waitForFunction((needle) => {
      const labels = [...document.querySelectorAll(".cmdk-group-label")].map((el) => el.textContent);
      const hitRow = document.querySelector(".cmdk-item[data-kind='session']");
      return labels.includes("Sessions") && hitRow && hitRow.innerText.includes(needle);
    }, SEARCH_NEEDLE);

    const sessionRow = page.locator(".cmdk-item[data-kind='session']").first();
    assert.equal(await sessionRow.getAttribute("data-session-id"), hitId);
    assert.match(await sessionRow.locator(".cmdk-src").innerText(), /claude/i);
    assert.equal(await sessionRow.locator(".cmdk-sid").innerText(), hitId);
    assert.match(await sessionRow.locator(".cmdk-item-title").innerText(), /Document|needle|command menu/i);
    const mark = sessionRow.locator("mark.cmdk-mark");
    assert.ok(await mark.count(), "query term should be highlighted");
    assert.match(await mark.first().innerText(), /cmdk|search|needle|alpha/i);
    const rowText = await sessionRow.innerText();
    assert.match(rowText, new RegExp(SEARCH_NEEDLE));

    await sessionRow.click();
    await page.waitForURL((url) => url.pathname === "/view" && url.searchParams.get("id") === hitId);
    assert.equal(new URL(page.url()).searchParams.get("id"), hitId);

    await page.goto(`http://127.0.0.1:${searchPort}/sessions`, { waitUntil: "domcontentloaded" });
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkOverlay:not([hidden])");
    await page.locator("#cmdkInput").fill("zzzzzxxyyqq");
    await page.waitForSelector("#cmdkEmpty:not([hidden])");
    assert.match(await page.locator(".cmdk-empty-action").innerText(), /Search sessions/);

    await page.locator("#cmdkInput").fill(hitId);
    await page.waitForFunction((id) => {
      const row = document.querySelector(`.cmdk-item[data-session-id="${id}"]`);
      return !!(row && (row.innerText.includes("Open session") || row.querySelector(".cmdk-sid")));
    }, hitId);
    const hashHref = await page.locator(`.cmdk-item[data-session-id="${hitId}"]`).first().evaluate((el) => {
      return el.innerText;
    });
    assert.ok(hashHref.includes(hitId));
  });

  test("cold typed query ranks from the page catalog without catalog=1", SKIP_NO_PLAYWRIGHT, async () => {
    const home = seedPaletteSearchHome();
    const coldPort = await allocEphemeralPort();
    const coldChild = spawnServe(coldPort, home);
    const prevChild = child;
    child = coldChild;
    if (prevChild) await stopServe(prevChild);
    await waitForHttp(coldPort, "/sessions", coldChild);
    await waitForSearchHit(coldPort, SEARCH_NEEDLE, coldChild);

    if (browser) await browser.close().catch(() => {});
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const searchUrls = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/search")) searchUrls.push(req.url());
    });
    await page.goto(`http://127.0.0.1:${coldPort}/sessions`, { waitUntil: "load" });
    const catalogJson = await page.locator("#tq-cmdk-catalog").textContent();
    assert.ok(catalogJson && catalogJson.length > 2, "page ships #tq-cmdk-catalog");
    const packed = JSON.parse(catalogJson);
    assert.ok(packed.s || packed.sessions, "catalog payload present");

    const meta = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${meta}+k`);
    await page.waitForSelector("#cmdkOverlay:not([hidden])");
    const input = page.locator("#cmdkInput");
    await input.pressSequentially(SEARCH_NEEDLE, { delay: 0 });
    await page.waitForSelector(".cmdk-hit");
    const row = page.locator(".cmdk-hit").first();
    assert.match(await row.locator(".cmdk-src").innerText(), /claude/i);
    assert.ok(await row.locator(".cmdk-sid").innerText());
    assert.match(await row.innerText(), new RegExp(SEARCH_NEEDLE));
    assert.ok(
      !searchUrls.some((u) => /[?&]catalog=1(?:&|$)/.test(u) || u.endsWith("catalog=1")),
      `cold type must not wait on catalog HTTP, got ${searchUrls.join(" ")}`,
    );
  });

  test("Go to items jump to Chat, Runs, Compare, view, and launch", SKIP_NO_PLAYWRIGHT, async () => {
    const home = seedPaletteSearchHome();
    const navPort = await allocEphemeralPort();
    const navChild = spawnServe(navPort, home);
    const prevChild = child;
    child = navChild;
    if (prevChild) await stopServe(prevChild);
    await waitForHttp(navPort, "/sessions", navChild);
    const listed = await httpGetJson(navPort, "/api/sessions?page=1&pageSize=8&sort=recent");
    const sessionId = (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].id)
      || (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].sessionHash);
    assert.ok(sessionId, "seeded session id");

    if (browser) await browser.close().catch(() => {});
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const meta = process.platform === "darwin" ? "Meta" : "Control";

    async function openPalette() {
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkOverlay:not([hidden])");
    }

    await page.goto(`http://127.0.0.1:${navPort}/sessions`, { waitUntil: "domcontentloaded" });
    await openPalette();
    await page.waitForFunction(() => document.querySelector('[data-dest="chat"]'));
    const emptyDests = await page.locator("[data-dest]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-dest")),
    );
    for (const dest of ["chat", "runs", "compare", "view", "launch"]) {
      assert.ok(emptyDests.includes(dest), `empty query missing ${dest}: ${emptyDests.join(",")}`);
    }

    await page.locator("#cmdkInput").fill("chat");
    await page.waitForSelector('[data-dest="chat"]');
    await page.locator('[data-dest="chat"]').click();
    await page.waitForFunction(() => location.pathname === "/" || location.pathname === "/run");
    assert.ok(["/", "/run"].includes(new URL(page.url()).pathname), page.url());

    await openPalette();
    await page.locator("#cmdkInput").fill("runs");
    await page.waitForSelector('[data-dest="runs"]');
    await page.locator('[data-dest="runs"]').click();
    await page.waitForURL((url) => url.pathname === "/sessions");
    assert.equal(new URL(page.url()).pathname, "/sessions");

    await openPalette();
    await page.locator("#cmdkInput").fill("compare");
    await page.waitForSelector('[data-dest="compare"]');
    await page.locator('[data-dest="compare"]').click();
    await page.waitForURL((url) => url.pathname === "/compare");
    assert.equal(new URL(page.url()).pathname, "/compare");

    await page.goto(`http://127.0.0.1:${navPort}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await openPalette();
    await page.locator("#cmdkInput").fill("go view");
    await page.waitForSelector('[data-dest="view"]');
    const viewHref = await page.locator('[data-dest="view"]').getAttribute("data-href");
    assert.match(viewHref || "", /\/view/);
    await page.locator('[data-dest="view"]').click();
    await page.waitForURL((url) => url.pathname === "/view");
    assert.equal(new URL(page.url()).pathname, "/view");
    assert.equal(new URL(page.url()).searchParams.get("id"), sessionId);

    await page.goto(`http://127.0.0.1:${navPort}/sessions`, { waitUntil: "domcontentloaded" });
    await openPalette();
    await page.locator("#cmdkInput").fill("launch");
    await page.waitForSelector('[data-dest="launch"]');
    await page.locator('[data-dest="launch"]').click();
    await page.waitForFunction(() => {
      const overlay = document.getElementById("launchOverlay");
      return (overlay && !overlay.hidden)
        || new URLSearchParams(location.search).get("launch") === "1";
    });

    await page.goto(`http://127.0.0.1:${navPort}/compare`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && el.blur) el.blur();
    });
    await page.keyboard.press("g");
    await page.keyboard.press("r");
    await page.waitForURL((url) => url.pathname === "/sessions");
    assert.equal(new URL(page.url()).pathname, "/sessions");

    await page.goto(`http://127.0.0.1:${navPort}/compare`, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && el.blur) el.blur();
    });
    await page.keyboard.press("g");
    await page.keyboard.press("c");
    await page.waitForFunction(() => location.pathname === "/" || location.pathname === "/run");
    assert.ok(["/", "/run"].includes(new URL(page.url()).pathname), `G then C -> ${page.url()}`);
  });

  test("in-view section and chapter jumps scroll to run sections and #chapter-N", SKIP_NO_PLAYWRIGHT, async () => {
    const home = mkTmp("tracequest-cmdk-sections-");
    const dir = join(home, ".claude", "projects", "-home-dev-tracequest");
    mkdirSync(dir, { recursive: true });
    writeClaudeJsonl(dir, "palette-chapters.jsonl", [
      {
        type: "user",
        sessionId: "cmdk-chapters-1",
        cwd: CLAUDE_FIXTURE_CWD,
        timestamp: "2026-06-03T12:00:00.000Z",
        uuid: "u-cmdk-ch-1",
        isMeta: false,
        message: { content: [{ type: "text", text: "Document the cmdk-chapter-alpha turn" }] },
      },
      {
        type: "assistant",
        sessionId: "cmdk-chapters-1",
        timestamp: "2026-06-03T12:00:01.000Z",
        uuid: "a-cmdk-ch-1",
        message: {
          model: CLAUDE_FIXTURE_MODEL,
          content: [{ type: "text", text: "Noted the first chapter" }],
        },
      },
      {
        type: "user",
        sessionId: "cmdk-chapters-1",
        cwd: CLAUDE_FIXTURE_CWD,
        timestamp: "2026-06-03T12:01:00.000Z",
        uuid: "u-cmdk-ch-2",
        isMeta: false,
        message: { content: [{ type: "text", text: "Then add cmdk-chapter-beta permalinks" }] },
      },
      {
        type: "assistant",
        sessionId: "cmdk-chapters-1",
        timestamp: "2026-06-03T12:01:01.000Z",
        uuid: "a-cmdk-ch-2",
        message: {
          model: CLAUDE_FIXTURE_MODEL,
          content: [{ type: "text", text: "Chapter two is the beta jump" }],
        },
      },
      {
        type: "user",
        sessionId: "cmdk-chapters-1",
        cwd: CLAUDE_FIXTURE_CWD,
        timestamp: "2026-06-03T12:02:00.000Z",
        uuid: "u-cmdk-ch-3",
        isMeta: false,
        message: { content: [{ type: "text", text: "Finally wire cmdk-chapter-gamma" }] },
      },
      {
        type: "assistant",
        sessionId: "cmdk-chapters-1",
        timestamp: "2026-06-03T12:02:01.000Z",
        uuid: "a-cmdk-ch-3",
        message: {
          model: CLAUDE_FIXTURE_MODEL,
          content: [{ type: "text", text: "Done" }],
        },
      },
    ]);

    const secPort = await allocEphemeralPort();
    const secChild = spawnServe(secPort, home);
    const prevChild = child;
    child = secChild;
    if (prevChild) await stopServe(prevChild);
    await waitForHttp(secPort, "/sessions", secChild);
    const listed = await httpGetJson(secPort, "/api/sessions?page=1&pageSize=8&sort=recent");
    const sessionId = (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].id)
      || (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].sessionHash);
    assert.ok(sessionId, "seeded session id");

    if (browser) await browser.close().catch(() => {});
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const meta = process.platform === "darwin" ? "Meta" : "Control";

    async function openPalette() {
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkOverlay:not([hidden])");
    }

    await page.goto(`http://127.0.0.1:${secPort}/view?id=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#chapter-0", { timeout: 15_000 });
    await page.waitForSelector("#chapter-1");
    await page.waitForSelector("#chapter-2");

    await openPalette();
    await page.waitForFunction(() => document.querySelector('[data-dest="chapters"]'));
    const emptyKinds = await page.locator("[data-kind]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-kind")),
    );
    assert.ok(emptyKinds.includes("jump"), `empty view missing jump: ${emptyKinds.join(",")}`);
    assert.ok(emptyKinds.includes("chapter"), `empty view missing chapter: ${emptyKinds.join(",")}`);
    const emptyDests = await page.locator("[data-dest]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-dest")),
    );
    assert.ok(emptyDests.includes("chapter-0"), emptyDests.join(","));
    assert.ok(emptyDests.includes("chapter-1"), emptyDests.join(","));

    await page.locator("#cmdkInput").fill("chapter-beta");
    await page.waitForSelector('[data-dest="chapter-1"]');
    const filteredCh = await page.locator("[data-kind='chapter']").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-dest")),
    );
    assert.ok(filteredCh.includes("chapter-1"), filteredCh.join(","));
    await page.locator('[data-dest="chapter-1"]').click();
    await page.waitForFunction(() => location.hash === "#chapter-1");
    assert.equal(new URL(page.url()).hash, "#chapter-1");
    await page.waitForFunction(() => {
      const el = document.getElementById("chapter-1");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return el.classList.contains("expanded") && r.top < window.innerHeight && r.bottom > 0;
    });
    const chapterBox = await page.locator("#chapter-1").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, expanded: el.classList.contains("expanded") };
    });
    assert.ok(chapterBox.top < 800 && chapterBox.bottom > 0, `chapter-1 not in view: ${JSON.stringify(chapterBox)}`);
    assert.equal(chapterBox.expanded, true);

    await page.goto(`http://127.0.0.1:${secPort}/run?session=${encodeURIComponent(sessionId)}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForSelector("#chatThread");
    await openPalette();
    await page.waitForFunction(() => document.querySelector('[data-dest="transcript"]'));
    const runGroups = await page.locator(".cmdk-group-label").allTextContents();
    assert.ok(runGroups.includes("This session") || runGroups.includes("This run"), runGroups.join(","));
    const runDests = await page.locator("[data-dest]").evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-dest")),
    );
    for (const dest of ["transcript", "analytics", "composer"]) {
      assert.ok(runDests.includes(dest), `session view missing ${dest}: ${runDests.join(",")}`);
    }

    await page.locator("#cmdkInput").fill("transcript");
    await page.waitForSelector('[data-dest="transcript"]');
    await page.locator('[data-dest="transcript"]').click();
    await page.waitForFunction(() => {
      const overlay = document.getElementById("cmdkOverlay");
      return overlay && overlay.hidden;
    });
    const threadVisible = await page.locator("#chatThread").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight && r.bottom > 0;
    });
    assert.equal(threadVisible, true);

    await openPalette();
    await page.locator("#cmdkInput").fill("analytics");
    await page.waitForSelector('[data-dest="analytics"]');
    await page.locator('[data-dest="analytics"]').click();
    await page.waitForFunction(() => {
      const panel = document.getElementById("runAnalytics");
      const toggle = document.getElementById("analyticsToggle");
      return (panel && !panel.hidden) || (toggle && toggle.getAttribute("aria-expanded") === "true");
    });
  });

  test("open CommandPalette types /ojkg?x on every served surface", SKIP_NO_PLAYWRIGHT, async () => {
    const home = seedPaletteSearchHome();
    const typePort = await allocEphemeralPort();
    const typeChild = spawnServe(typePort, home);
    const prevChild = child;
    child = typeChild;
    if (prevChild) await stopServe(prevChild);
    await waitForHttp(typePort, "/sessions", typeChild);
    const listed = await httpGetJson(typePort, "/api/sessions?page=1&pageSize=8&sort=recent");
    const sessionId = (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].id)
      || (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].sessionHash);
    assert.ok(sessionId, "seeded session id");

    if (browser) await browser.close().catch(() => {});
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const meta = process.platform === "darwin" ? "Meta" : "Control";
    const typed = "/ojkg?x";
    const surfaces = [
      { name: "/sessions", path: "/sessions" },
      { name: "chat home", path: "/" },
      { name: "/run", path: "/run" },
      { name: "/compare", path: "/compare" },
      { name: "/view", path: `/view?id=${encodeURIComponent(sessionId)}` },
    ];

    for (const surface of surfaces) {
      await page.goto(`http://127.0.0.1:${typePort}${surface.path}`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => {
        const el = document.activeElement;
        if (el && el !== document.body && el.blur) el.blur();
      });
      const beforeUrl = page.url();
      await page.keyboard.press(`${meta}+k`);
      await page.waitForSelector("#cmdkInput:focus");
      const helperGone = await page.evaluate(() => {
        const html = String(document.documentElement.innerHTML || "");
        return {
          stopGone: !html.includes("stopPageShortcutsForPrintable"),
          noPrintableInspect: !/!e\.metaKey && !e\.ctrlKey && !e\.altKey && key\.length === 1/.test(html),
        };
      });
      assert.equal(helperGone.stopGone, true, `${surface.name}: stopPageShortcutsForPrintable is gone from the served page`);
      assert.equal(helperGone.noPrintableInspect, true, `${surface.name}: onGlobalKey does not inspect key.length === 1`);
      await page.keyboard.type(typed);
      const shot = await page.evaluate(() => ({
        value: document.getElementById("cmdkInput")?.value || "",
        activeId: document.activeElement && document.activeElement.id,
        href: location.href,
        cmdkOpen: document.body.classList.contains("cmdk-open"),
        filterFocused: document.activeElement && (
          document.activeElement.id === "filterInput"
          || document.activeElement.id === "workspaceSearch"
          || document.activeElement.classList.contains("filter-search")
        ),
        ws: document.activeElement && document.activeElement.id === "workspaceSearch",
        kbFocused: !!document.querySelector(".chapter.kb-focused"),
      }));
      assert.equal(shot.cmdkOpen, true, `${surface.name}: palette stays open`);
      assert.equal(shot.activeId, "cmdkInput", `${surface.name}: combobox keeps focus`);
      assert.equal(shot.value, typed, `${surface.name}: #cmdkInput.value got ${typed}, got ${JSON.stringify(shot.value)}`);
      assert.equal(shot.filterFocused, false, `${surface.name}: slash must not steal to another search`);
      assert.equal(shot.ws, false, `${surface.name}: / does not focus #workspaceSearch`);
      assert.equal(shot.kbFocused, false, `${surface.name}: j/k/o must not walk/toggle chapters`);
      assert.equal(new URL(shot.href).pathname, new URL(beforeUrl).pathname, `${surface.name}: no G-chord navigation`);

      await page.keyboard.type("gr");
      const afterGr = await page.evaluate(() => ({
        value: document.getElementById("cmdkInput")?.value || "",
        href: location.href,
      }));
      assert.equal(afterGr.value, typed + "gr", `${surface.name}: g then r types into the combobox`);
      assert.equal(new URL(afterGr.href).pathname, new URL(beforeUrl).pathname, `${surface.name}: g then r must not jump`);
      await page.keyboard.press("Escape");
      await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
    }
  });

  test("first-key / and o insert into open CommandPalette", SKIP_NO_PLAYWRIGHT, async () => {
    const home = seedPaletteSearchHome();
    const firstPort = await allocEphemeralPort();
    const firstChild = spawnServe(firstPort, home);
    const prevChild = child;
    child = firstChild;
    if (prevChild) await stopServe(prevChild);
    await waitForHttp(firstPort, "/sessions", firstChild);
    const listed = await httpGetJson(firstPort, "/api/sessions?page=1&pageSize=8&sort=recent");
    const sessionId = (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].id)
      || (listed.data.sessions && listed.data.sessions[0] && listed.data.sessions[0].sessionHash);
    assert.ok(sessionId, "seeded session id");

    if (browser) await browser.close().catch(() => {});
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const meta = process.platform === "darwin" ? "Meta" : "Control";

    const firstSurfaces = [
      { name: "/sessions", path: "/sessions" },
      { name: "/view", path: `/view?id=${encodeURIComponent(sessionId)}` },
    ];
    for (const surface of firstSurfaces) {
      for (const key of ["/", "o"]) {
        await page.goto(`http://127.0.0.1:${firstPort}${surface.path}`, { waitUntil: "domcontentloaded" });
        await page.evaluate(() => {
          const el = document.activeElement;
          if (el && el !== document.body && el.blur) el.blur();
        });
        await page.keyboard.press(`${meta}+k`);
        await page.waitForSelector("#cmdkInput:focus");
        await page.keyboard.type(key);
        const shot = await page.evaluate(() => ({
          value: document.getElementById("cmdkInput")?.value || "",
          activeId: document.activeElement && document.activeElement.id,
          ws: document.activeElement && document.activeElement.id === "workspaceSearch",
          wsValue: document.getElementById("workspaceSearch")?.value || "",
          kbFocused: !!document.querySelector(".chapter.kb-focused"),
        }));
        assert.equal(shot.value, key, `${surface.name}: first-key ${JSON.stringify(key)} inserts into #cmdkInput`);
        assert.equal(shot.activeId, "cmdkInput", `${surface.name}: first-key ${JSON.stringify(key)} keeps combobox focus`);
        assert.equal(shot.ws, false, `${surface.name}: first-key ${JSON.stringify(key)} does not focus #workspaceSearch`);
        assert.equal(shot.wsValue, "", `${surface.name}: first-key ${JSON.stringify(key)} does not type into #workspaceSearch`);
        if (key === "o") {
          assert.equal(shot.kbFocused, false, `${surface.name}: first-key o does not toggle chapters`);
        }
        await page.keyboard.press("Escape");
        await page.locator("#cmdkOverlay").waitFor({ state: "hidden" });
      }
    }
  });
});
