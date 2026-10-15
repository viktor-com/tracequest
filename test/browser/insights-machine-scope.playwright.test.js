import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { rmSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "bin/tracequest.js");

test("Insights machine navigation preserves source and time scope", { ...SKIP_NO_PLAYWRIGHT, timeout: 60_000 }, async () => {
  const home = mkTmp("tq-insights-machine-scope-");
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_HOSTS_DIR: join(home, ".local/share/tracequest/hosts"),
    TRACEQUEST_CACHE_DIR: join(home, ".cache/tracequest"),
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tq-insights-machine-scope-tmux",
    TRACEQUEST_TMUX_SOCKET: `tq-insights-machine-scope-${process.pid}`,
    TRACEQUEST_TMUX_SESSION: `tq-insights-machine-scope-${process.pid}`,
  };
  let server;
  let browser;
  try {
    const now = Date.now();
    for (const [host, source, id, age] of [
      ["fedora", "codex", "recent-fedora", 1],
      ["fedora", "codex", "old-fedora", 60],
      ["fedora", "claude", "claude-fedora", 1],
      ["mac", "codex", "recent-mac", 1],
      ["", "codex", "recent-local", 1],
    ]) {
      const base = host ? join(env.TRACEQUEST_HOSTS_DIR, host) : home;
      const timestamp = new Date(now - age * 86_400_000).toISOString();
      const path = source === "codex"
        ? join(base, ".codex/sessions", `rollout-${id}.jsonl`)
        : join(base, ".claude/projects/-tmp-scope", `${id}.jsonl`);
      writeJsonl(path, source === "codex" ? [
        { type: "session_meta", timestamp, payload: { id, cwd: "/tmp/scope" } },
        { type: "event_msg", timestamp, payload: { type: "user_message", message: id } },
        { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
      ] : [
        { type: "user", sessionId: id, timestamp, cwd: "/tmp/scope", message: { role: "user", content: id } },
        { type: "assistant", sessionId: id, timestamp, message: { role: "assistant", model: "claude-sonnet-4-20250514", content: [{ type: "text", text: "Done" }] } },
      ]);
      utimesSync(path, new Date(timestamp), new Date(timestamp));
    }
    const refresh = spawnSync(process.execPath, [BIN, "insights", "--refresh"], { cwd: ROOT, env, encoding: "utf8", timeout: 20_000 });
    assert.equal(refresh.status, 0, refresh.stderr);

    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const { port } = reservation.address();
    await new Promise((resolve) => reservation.close(resolve));
    server = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
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
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    const filter = page.getByRole("textbox", { name: "Filter sessions" });
    const machine = (host) => page.locator(`[data-insight="machines"] [data-host="${host}"] a`);
    const click = async (link) => {
      await Promise.all([page.waitForEvent("load"), link.click()]);
    };
    const scope = async (expr, days, host, sessions) => {
      const query = new URL(page.url()).searchParams;
      assert.equal(query.get("expr") || "", expr);
      assert.equal(query.get("days") || "0", String(days));
      assert.equal(query.get("host") || "", host);
      assert.equal(await filter.inputValue(), expr);
      assert.equal(await page.getByRole("navigation", { name: "Time range" }).locator('[aria-current="true"]').textContent(), days ? `last ${days} days` : "all time");
      assert.equal(await page.locator(".ins-tile-val").first().textContent(), String(sessions));
      const data = await (await page.request.get(`${base}/api/insights?${query}`)).json();
      assert.equal(data.totals.sessions, sessions);
      assert.equal(data.totals.analyzed, sessions);
    };

    await page.goto(`${base}/insights`);
    await filter.fill("source:codex");
    await click(page.getByRole("button", { name: "Apply", exact: true }));
    await click(page.getByRole("link", { name: "last 7 days", exact: true }));
    await scope("source:codex", 7, "", 3);
    for (const host of ["fedora", "mac", "local"]) {
      await click(machine(host));
      await scope("source:codex", 7, host, 1);
    }
    await click(page.getByRole("link", { name: "machine: local ×", exact: true }));
    await scope("source:codex", 7, "", 3);
    await click(page.getByRole("link", { name: "all time", exact: true }));
    await click(machine("fedora"));
    await scope("source:codex", 0, "fedora", 2);
    await page.goto(`${base}/insights?days=7`);
    await click(machine("fedora"));
    await scope("", 7, "fedora", 2);
    await page.goto(`${base}/insights`);
    await click(machine("fedora"));
    await scope("", 0, "fedora", 3);
    assert.deepEqual(errors, []);
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
