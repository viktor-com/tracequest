import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BIN = join(ROOT, "bin/tracequest.js");
async function availablePort() {
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

for (const scenario of [
  { name: "configured filter", configFilter: "does-not-exist", count: 0 },
  { name: "CLI filter overrides config", configFilter: "sample-app", cliFilter: "does-not-exist", count: 0 },
  { name: "CLI matching filter overrides config", configFilter: "does-not-exist", cliFilter: "sample-app", count: 1 },
  { name: "page expression intersects server filter", configFilter: "sample-app", count: 1, expr: "project:other", insightCount: 0 },
]) {
  test(`real hub insights respects ${scenario.name}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "tq-hub-filter-"));
    let child;
    let diagnostics = "";
    try {
      cpSync(join(ROOT, "examples/hub/home"), join(root, "home"), { recursive: true });
      const port = await availablePort();
      const config = join(root, "config.json");
      writeFileSync(config, JSON.stringify({ home: "./home", cacheDir: "./cache", hostsDir: "./archive", hosts: [], serve: { hub: true, bind: "127.0.0.1", port, filter: scenario.configFilter } }));
      const env = { ...process.env, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "1", TRACEQUEST_SKIP_TMUX: "1" };
      const refresh = spawnSync(process.execPath, [BIN, "insights", "--refresh", "--config", config], { cwd: ROOT, env, encoding: "utf8", timeout: 15_000 });
      assert.equal(refresh.status, 0, refresh.stderr);
      child = spawn(process.execPath, [BIN, "serve", "--config", config, ...(scenario.cliFilter ? ["--filter", scenario.cliFilter] : [])], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", (chunk) => { diagnostics += chunk; });
      child.stderr.on("data", (chunk) => { diagnostics += chunk; });
      const base = `http://127.0.0.1:${port}`;
      let response;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        assert.equal(child.exitCode, null, diagnostics);
        try { response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(2000) }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      assert.ok(response, diagnostics);
      assert.equal(response.status, 200);
      const inventory = await response.json();
      assert.equal(inventory.total, scenario.count);
      const query = scenario.expr ? `?expr=${encodeURIComponent(scenario.expr)}` : "";
      const insights = await fetch(`${base}/api/insights${query}`);
      assert.equal(insights.status, 200);
      const data = await insights.json();
      assert.equal(data.totals.sessions, scenario.insightCount ?? scenario.count);
      assert.equal(data.totals.analyzed, scenario.insightCount ?? scenario.count);
      const page = await fetch(`${base}/insights${query}`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /data-insight="headline"/);
    } finally {
      if (child && child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
      rmSync(root, { recursive: true, force: true });
    }
  });
}
