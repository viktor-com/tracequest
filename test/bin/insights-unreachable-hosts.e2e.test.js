import "../helpers/skip-lr-watch-env.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "bin/tracequest.js");
const ADDRESS = "127.0.0.1";
const SKIP_NO_SSH = spawnSync("ssh", ["-V"]).error ? { skip: "ssh client not installed" } : {};

async function freePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

const ctx = {};

before(async () => {
  if (SKIP_NO_SSH.skip) return;
  const home = mkTmp("tq-insights-unreachable-");
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_HOSTS_DIR: join(home, ".local/share/tracequest/hosts"),
    TRACEQUEST_CACHE_DIR: join(home, ".cache/tracequest"),
    TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1",
    TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_TMUX_BIN: "/nonexistent-tq-insights-unreachable-tmux",
    TRACEQUEST_TMUX_SOCKET: `tq-insights-unreachable-${process.pid}`,
    TRACEQUEST_TMUX_SESSION: `tq-insights-unreachable-${process.pid}`,
  };
  Object.assign(ctx, { home, env });
  const timestamp = new Date().toISOString();
  writeJsonl(join(home, ".codex/sessions", "rollout-local.jsonl"), [
    { type: "session_meta", timestamp, payload: { id: "local", cwd: "/tmp/unreachable" } },
    { type: "event_msg", timestamp, payload: { type: "user_message", message: "hello" } },
    { type: "response_item", timestamp, payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] } },
  ]);
  mkdirSync(join(home, ".tracequest"), { recursive: true });
  writeFileSync(join(home, ".tracequest/import-hosts"), `tq@${ADDRESS} as lab\n`);

  // A real ssh pull against a closed port: ssh names the address in its error.
  const closedPort = await freePort();
  const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
  ctx.pull = run(["import", "ssh", "--port", String(closedPort)]);
  ctx.pullState = readFileSync(join(env.TRACEQUEST_HOSTS_DIR, ".pull-state.json"), "utf8");
  assert.equal(run(["insights", "--refresh"]).status, 0);
  ctx.text = run(["insights"]);
  ctx.json = run(["insights", "--json"]);

  const port = await freePort();
  ctx.server = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  ctx.server.stdout.on("data", (chunk) => { output += chunk; });
  ctx.server.stderr.on("data", (chunk) => { output += chunk; });
  for (let i = 0; i < 150 && !ctx.page; i++) {
    assert.equal(ctx.server.exitCode, null, output);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/insights`);
      if (res.ok) ctx.page = await res.text();
    } catch {}
    if (!ctx.page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ctx.page, output || "Server did not start");
});

after(async () => {
  if (ctx.server && ctx.server.exitCode === null) {
    ctx.server.kill();
    await once(ctx.server, "exit");
  }
  if (ctx.home) rmSync(ctx.home, { recursive: true, force: true });
});

test("insights names unreachable machines without their address", SKIP_NO_SSH, () => {
  assert.match(ctx.pull.stderr, new RegExp(ADDRESS.replaceAll(".", "\\.")), "import ssh keeps the address for debugging");
  assert.match(ctx.pullState, new RegExp(ADDRESS.replaceAll(".", "\\.")), "the pull record keeps the raw error");

  assert.equal(ctx.text.status, 0, ctx.text.stderr);
  assert.match(ctx.text.stdout, /^ {2}lab +failing /m);
  assert.ok(!ctx.text.stdout.includes(ADDRESS), ctx.text.stdout);
  assert.ok(!ctx.text.stderr.includes(ADDRESS), ctx.text.stderr);

  assert.equal(ctx.json.status, 0, ctx.json.stderr);
  assert.ok(!ctx.json.stdout.includes(ADDRESS), "--json carries no address");
  const lab = JSON.parse(ctx.json.stdout).hub.find((h) => h.host === "lab");
  assert.equal(lab.state, "failing");
  assert.equal(lab.error, "connection refused");
  assert.equal(lab.spec, undefined);

  const panel = ctx.page.match(/<table class="ins-table" data-insight="machines">[\s\S]*?<\/table>/)?.[0];
  assert.ok(panel, "machine panel rendered");
  assert.match(panel, /data-host="lab"/);
  assert.match(panel, /connection refused/);
  assert.ok(!ctx.page.includes(`tq@${ADDRESS}`), "page carries no SSH destination");
  assert.ok(!panel.includes(ADDRESS), panel);
});

test("insights warns once about failing pulls", SKIP_NO_SSH, () => {
  const warnings = ctx.text.stdout.split("\n").filter((line) => /failing to pull/.test(line));
  assert.deepEqual(warnings, ["  1 machine failing to pull (connection refused); `tracequest import ssh` shows the ssh error"]);
  const lab = ctx.text.stdout.split("\n").find((line) => /^ {2}lab /.test(line));
  assert.ok(!/refused|—/.test(lab), lab);
});
