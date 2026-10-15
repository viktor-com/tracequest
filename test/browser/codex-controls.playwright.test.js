import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { mockHttpResponse } from "../helpers/capture-json-handler.js";
import { handleApiRunsInput } from "../../src/routes/route-handlers-launch.js";

const ROOT = process.env.TRACEQUEST_TEST_ROOT || fileURLToPath(new URL("../../", import.meta.url));
const native = process.env.TRACEQUEST_TEST_CODEX_BIN;
const tmuxAvailable = spawnSync("tmux", ["-V"]).status === 0;
const shellQuote = s => "'" + s.replaceAll("'", "'\\''") + "'";

async function until(fn, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  assert.fail(`Timed out: ${label}`);
}

// Only loopback traffic: native Codex exercises its real TUI and writes its
// real rollout, but all model responses come from this deterministic stream.
async function provider() {
  let sequence = 0, active = 0;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (!req.url.includes("responses")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end('{"data":[]}');
    }
    const input = JSON.parse(body).input || [];
    const last = input.filter(item => item.role === "user").at(-1);
    const long = last?.content?.some(part => part.text?.startsWith("LONG_REPLY"));
    const id = `resp_${++sequence}`;
    const item = { id: `msg_${sequence}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Native local reply.", annotations: [] }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
    emit("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } });
    emit("response.content_part.added", { output_index: 0, content_index: 0, item_id: item.id, part: { type: "output_text", text: "", annotations: [] } });
    if (long) active++;
    const timer = setInterval(() => {
      emit("response.output_text.delta", { output_index: 0, content_index: 0, item_id: item.id, delta: long ? "Still generating. " : item.content[0].text });
      if (long) return;
      clearInterval(timer);
      emit("response.output_item.done", { output_index: 0, item });
      emit("response.completed", { response: { id, object: "response", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 } } });
      res.end();
    }, long ? 150 : 30);
    res.on("close", () => { clearInterval(timer); if (long) active--; });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, port: server.address().port, active: () => active };
}

async function withRun(t, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-codex-controls-"));
  const socket = `tq-controls-${process.pid}-${path.basename(home)}`;
  const session = socket;
  const model = await provider();
  const cwd = path.join(home, "project");
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, "bin"));
  fs.mkdirSync(path.join(home, ".codex"));
  fs.writeFileSync(path.join(home, ".codex/config.toml"), `check_for_update_on_startup = false\nmodel = "gpt-5-codex"\nmodel_provider = "local"\napproval_policy = "never"\nsandbox_mode = "read-only"\n[model_providers.local]\nname = "Local test provider"\nbase_url = "http://127.0.0.1:${model.port}/v1"\nwire_api = "responses"\n[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n`);
  const command = native
    ? `${shellQuote(native)} --no-alt-screen`
    : `${shellQuote(process.execPath)} ${shellQuote(fileURLToPath(new URL("../fixtures/codex-controls-terminal.mjs", import.meta.url)))}`;
  fs.writeFileSync(path.join(home, "bin/codex"), `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o755 });
  const env = { ...process.env, npm_config_prefix: path.join(home, "npm"), HOME: home, CODEX_HOME: path.join(home, ".codex"), TRACEQUEST_LIVE_SESSIONS_HOME: home, PATH: `${home}/bin:${process.env.PATH}`, TRACEQUEST_TMUX_SOCKET: socket, TRACEQUEST_TMUX_SESSION: session, TRACEQUEST_SKIP_LR_WATCH: "1", TRACEQUEST_NO_SIDECAR: "1" };
  delete env.TRACEQUEST_SKIP_TMUX;
  delete env.TRACEQUEST_TMUX_BIN;
  const portServer = createServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise(resolve => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, "bin/tracequest.js"), "serve", "--port", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", b => { logs += b; });
  child.stderr.on("data", b => { logs += b; });
  let browser;
  try {
    await until(async () => { try { return (await fetch(base + "/api/agents")).ok; } catch { return false; } }, "serve startup");
    const post = async body => {
      const res = await fetch(base + "/api/runs/input", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    let copiedRecording;
    if (native) {
      const seedHome = path.join(home, "seed-home");
      fs.mkdirSync(path.join(seedHome, ".codex"), { recursive: true });
      fs.copyFileSync(path.join(home, ".codex/config.toml"), path.join(seedHome, ".codex/config.toml"));
      const seedEnv = { ...env, HOME: seedHome, CODEX_HOME: path.join(seedHome, ".codex") };
      const seed = spawn(native, ["exec", "--skip-git-repo-check", "Say hello briefly."], { cwd, env: seedEnv, stdio: "ignore" });
      const [code] = await once(seed, "exit");
      assert.equal(code, 0, "native Codex creates a real recording offline");
      const source = fs.readdirSync(path.join(seedHome, ".codex/sessions"), { recursive: true }).find(name => name.endsWith(".jsonl"));
      assert.ok(source);
      copiedRecording = path.join(home, ".codex/sessions", source);
      fs.mkdirSync(path.dirname(copiedRecording), { recursive: true });
      fs.copyFileSync(path.join(seedHome, ".codex/sessions", source), copiedRecording);
      t.diagnostic(`Native recording copied into scratch HOME: ${copiedRecording}`);
    }
    const launchBody = native ? { resumeSession: copiedRecording, cwd } : { agent: "codex", cwd, prompt: "Say hello briefly." };
    const launch = await fetch(base + "/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(launchBody) });
    assert.equal(launch.status, 200);
    const { id } = await launch.json();
    const state = async () => (await fetch(base + `/api/runs/session?id=${id}`)).json();
    await until(async () => { const s = await state(); return s.link === "linked" && s.state === "idle" && s.session?.events.some(e => e.type === "assistant"); }, "first real reply");
    if (native) await until(() => execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-t", id], { encoding: "utf8" }).includes("Ask Codex"), "native resume opens copied recording");
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(base + `/run?id=${id}`);
    await page.locator("#terminalDetails").evaluate(el => { el.open = true; });
    const evidence = async name => {
      const dir = process.env.TRACEQUEST_TEST_EVIDENCE;
      const raw = execFileSync("tmux", ["-L", socket, "capture-pane", "-p", "-S", "-", "-t", id], { encoding: "utf8" });
      if (dir) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${name}.txt`), raw);
        await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
      }
      return raw;
    };
    await fn({ page, post: body => post({ id, ...body }), state, evidence, model });
  } catch (err) {
    t.diagnostic(logs);
    throw err;
  } finally {
    await browser?.close();
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise(resolve => setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2000).unref())]);
    spawnSync("tmux", ["-L", socket, "kill-server"]);
    if (native) spawnSync(native, ["app-server", "daemon", "stop"], { env, timeout: 10_000 });
    // Codex's detached daemon watchdog may outlive daemon stop. Only kill
    // processes whose executable lives in THIS disposable HOME.
    if (native) {
      const processes = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" }).stdout || "";
      for (const line of processes.split("\n")) {
        const match = line.trim().match(/^(\d+) (.*)$/);
        if (match?.[2].startsWith(`${home}/.codex/packages/`)) {
          try { process.kill(Number(match[1]), "SIGTERM"); } catch { /* already exited */ }
        }
      }
    }
    model.server.closeAllConnections();
    await new Promise(resolve => model.server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const gate = { ...SKIP_NO_PLAYWRIGHT, ...(!tmuxAvailable ? { skip: "tmux unavailable" } : {}), timeout: 60_000 };

test(`Codex Send submits once (${native ? "native" : "terminal double"})`, gate, async t => {
  await withRun(t, async ({ page, post, state, evidence }) => {
    const prompt = "Send exactly once; literal Enter;";
    await page.locator("#inputText").fill(prompt);
    await page.locator("#sendBtn").click();
    try {
      await until(async () => (await state()).session.events.filter(e => e.type === "user" && e.text === prompt).length === 1, "one Send submits the follow-up", 3000);
      await page.locator(".chat-user").filter({ hasText: prompt }).waitFor();
    } finally { await evidence("send"); }
    await until(async () => (await state()).state === "idle", "follow-up finishes");
    assert.equal((await post({ text: "line one\nline two;", key: "Enter" })).status, 200);
    await until(async () => (await state()).session.events.some(e => e.type === "user" && e.text === "line one\nline two;"), "multiline submits intact");
    await until(async () => (await state()).state === "idle", "multiline finishes");
    await post({ text: "Raw text stays editable" });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal((await state()).session.events.some(e => e.text === "Raw text stays editable"), false);
    await post({ key: "Enter" });
    await until(async () => (await state()).session.events.some(e => e.text === "Raw text stays editable"), "raw Enter submits");
    assert.equal((await post({ action: "stop", key: "Enter" })).status, 400);
    assert.equal((await post({ action: "arbitrary" })).status, 400);
    assert.equal((await post({ key: "Enter;-l" })).status, 400);
    assert.equal((await post({ text: "\x1b[200~" })).status, 400);
    await evidence("send-after-raw-keys");
  });
});

test(`Codex Stop interrupts once and keeps the run usable (${native ? "native" : "terminal double"})`, gate, async t => {
  await withRun(t, async ({ page, post, state, evidence, model }) => {
    // The separate Enter is deliberate setup: this test isolates Stop even
    // on main, where combined text+Enter is itself broken.
    await post({ text: "LONG_REPLY without tools" });
    await until(async () => (await evidence("stop-setup")).includes("LONG_REPLY without tools"), "native composer receives the long-reply setup");
    await new Promise(resolve => setTimeout(resolve, 150));
    await post({ key: "Enter" });
    await page.locator("#stopBtn").waitFor({ state: "visible" });
    await page.locator("#stopBtn").click();
    try {
      await until(async () => (await state()).state === "idle", "one Stop interrupts generation", 3000);
      await page.waitForFunction(() => document.querySelector("#runStatus").dataset.status === "idle" && document.querySelector("#runTerminal").innerText.includes("Conversation interrupted"));
    } finally { await evidence("stop"); }
    assert.equal((await state()).run.status, "idle", "run was interrupted, not killed");
    if (native) await until(() => model.active() === 0, "native response connection closes");
    await page.locator("#inputText").fill("Reply after stopping");
    await page.locator("#sendBtn").click();
    await until(async () => (await state()).session.events.some(e => e.text === "Reply after stopping"), "run accepts the next Send");
    await until(async () => (await state()).state === "idle", "next reply finishes");
    // The empty composer morphs into the second Stop control.
    await post({ text: "LONG_REPLY again" });
    await until(async () => (await evidence("stop-second-setup")).includes("LONG_REPLY again"), "native composer receives the second long-reply setup");
    await new Promise(resolve => setTimeout(resolve, 150));
    await post({ key: "Enter" });
    await until(async () => (await state()).state === "running", "second task starts before raw Ctrl-C");
    if (native) await until(() => model.active() > 0, "second native response is streaming");
    await post({ key: "C-c" });
    await until(async () => (await evidence("raw-interrupt")).includes("Task is still running"), "raw Ctrl-C keeps native dialog semantics");
    await until(() => page.locator("#sendBtn").getAttribute("aria-label").then(x => x === "Stop generating"), "composer becomes Stop");
    await page.locator("#sendBtn").click();
    await until(async () => (await state()).state === "idle", "composer Stop interrupts once with the native cancellation dialog open");
    await page.waitForFunction(() => document.querySelector("#runStatus").dataset.status === "idle");
    await evidence("stop-composer");
  });
});

test("Stop preserves other agents' Ctrl-C and raw input, with existing guards", async () => {
  async function input(body, { agent = "claude", dead = false, missing = false, host = "localhost" } = {}) {
    const req = Readable.from([JSON.stringify({ id: "@1", ...body })]);
    req.method = "POST";
    req.headers = { host };
    const res = mockHttpResponse();
    const sent = [];
    await handleApiRunsInput(req, res, null, {
      listWindows: () => missing ? [] : [{ id: "@1", dead, options: { tq_agent: agent } }],
      capturePane: () => "",
      sendKeys: (...args) => sent.push(args),
    });
    return { status: res.status, sent };
  }
  assert.deepEqual(await input({ action: "stop" }), { status: 200, sent: [["@1", ["C-c"]]] });
  assert.deepEqual(await input({ text: "literal;", key: "Enter" }), { status: 200, sent: [["@1", ["literal;"], { literal: true }], ["@1", ["Enter"]]] });
  assert.deepEqual(await input({ key: "C-c" }, { agent: "codex" }), { status: 200, sent: [["@1", ["C-c"]]] });
  for (const [body, options, status] of [
    [{ action: "stop" }, { dead: true }, 409],
    [{ action: "stop" }, { missing: true }, 404],
    [{ action: "stop" }, { host: "example.com" }, 403],
    [{ action: "stop", text: "no" }, {}, 400],
    [{ action: "arbitrary" }, {}, 400],
  ]) assert.deepEqual(await input(body, options), { status, sent: [] });
});
