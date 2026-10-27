import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "bin/tracequest.js");

// Mac window widths: 13"/14"/16" MacBook full screen, and a half-screen window.
const WIDTHS = [756, 1280, 1512, 1728];
const TABS = [
  { name: "Chat", nav: "chat", path: "/run" },
  { name: "Runs", nav: "runs", path: "/sessions" },
  { name: "Insights", nav: "insights", path: "/insights" },
];

test("hub section nav: Chat, Runs and Insights each open their own section", { ...SKIP_NO_PLAYWRIGHT, timeout: 120_000 }, async () => {
  const home = mkTmp("tq-hub-section-nav-");
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_HOSTS_DIR: join(home, ".local/share/tracequest/hosts"),
    TRACEQUEST_CACHE_DIR: join(home, ".cache/tracequest"),
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tq-hub-section-nav-tmux",
    TRACEQUEST_TMUX_SOCKET: `tq-hub-section-nav-${process.pid}`,
    TRACEQUEST_TMUX_SESSION: `tq-hub-section-nav-${process.pid}`,
  };
  let server;
  let browser;
  try {
    const timestamp = new Date(Date.now() - 3_600_000).toISOString();
    writeJsonl(join(home, ".claude/projects/-tmp-nav/nav-session.jsonl"), [
      { type: "user", sessionId: "nav-session", timestamp, cwd: "/tmp/nav", message: { role: "user", content: "Check the section nav" } },
      { type: "assistant", sessionId: "nav-session", timestamp, message: { role: "assistant", model: "claude-sonnet-4-20250514", content: [{ type: "text", text: "Done" }] } },
    ]);

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
        try { if ((await fetch(`${base}/insights`)).ok) return; } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(output || "Server did not start");
    });

    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on("pageerror", (err) => errors.push(err.message));
      for (const from of TABS) {
        for (const to of TABS) {
          await page.goto(base + from.path);
          await page.locator(".app-top .app-nav").getByRole("link", { name: to.name, exact: true }).click();
          await page.waitForURL((url) => url.pathname === to.path, { timeout: 10_000 }).catch(() => {});
          const where = `${width}px, ${from.name} → ${to.name}`;
          assert.equal(new URL(page.url()).pathname, to.path, where);
          assert.equal(await page.locator('.app-top .app-nav [aria-current="page"]').getAttribute("data-nav"), to.nav, where);
        }
      }
      assert.deepEqual(errors, [], `${width}px page errors`);
      await page.close();
    }
  } finally {
    await browser?.close();
    if (server && server.exitCode === null && server.signalCode === null) {
      const stopped = once(server, "exit");
      server.kill("SIGKILL");
      await stopped;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
