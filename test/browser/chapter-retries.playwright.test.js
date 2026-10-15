import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

// Raw Claude records exercise discovery, parsing, the served viewer bundle,
// chapter classification and the expanded waste diagnosis together.
const cases = [
  { name: "inspection", calls: [
    ["cd /missing && pwd", true],
    ...["1,80", "81,160", "161,240", "241,320", "321,400"].map(range =>
      [`cd /repo && sed -n '${range}p' src/main.js`, false]),
  ], retries: 0, outcome: "corrected", waste: false },
  { name: "successful read ranges", calls: [0, 80, 160, 240].map(offset =>
    [{ file_path: "/repo/src/main.js", offset, limit: 80 }, false, "Read"]),
    retries: 0, outcome: "clean", waste: false },
  { name: "failed read recovers", calls: [true, false, false].map(error =>
    [{ file_path: "/repo/src/main.js" }, error, "Read"]),
    retries: 1, outcome: "corrected", waste: false },
  { name: "successful polling", calls: Array.from({ length: 5 }, () => ["git status", false]),
    retries: 0, outcome: "clean", waste: false },
  { name: "resolved retries", calls: [true, true, false, false].map(error => ["npm test", error]),
    retries: 2, outcome: "corrected", waste: false },
  { name: "recovery beyond the self-correction window", calls: [
    ...[true, true, true].map(error => ["npm test", error]),
    ...["a", "b", "c"].map(file => [`cat ${file}`, false]),
    ["npm test", false],
  ], retries: 3, outcome: "struggling", waste: true, resolved: true },
  { name: "unresolved retries", calls: Array.from({ length: 4 }, () => ["npm test", true]),
    retries: 3, outcome: "struggling", waste: true },
  { name: "different command after failure", calls: [
    ["cd /missing && pwd", true], ["cd /repo && pwd", false],
    ["cd /repo && ls", false], ["cd /repo && cat README.md", false],
  ], retries: 0, outcome: "corrected", waste: false },
];

function seed(home) {
  const directory = join(home, ".claude/projects/retry-diagnosis");
  mkdirSync(directory, { recursive: true });
  const records = [];
  let tick = 0;
  const record = (type, content, usage) => records.push({
    type, sessionId: "retry-diagnosis", cwd: "/repo",
    timestamp: new Date(Date.UTC(2026, 9, 15, 10, 0, tick++)).toISOString(),
    message: { role: type, model: "claude-sonnet-4-20250514", content, ...(usage ? { usage } : {}) },
  });
  for (const scenario of cases) {
    record("user", [{ type: "text", text: scenario.name }]);
    for (const [input, isError, name = "Bash"] of scenario.calls) {
      const id = `call-${tick}`;
      record("assistant", [{ type: "tool_use", id, name, input: typeof input === "string" ? { command: input } : input }],
        { input_tokens: 1000, output_tokens: 100 });
      record("user", [{ type: "tool_result", tool_use_id: id, is_error: isError,
        content: isError ? "command failed: exit code 1" : "successful inspection" }]);
    }
  }
  const path = join(directory, "retry-diagnosis.jsonl");
  writeFileSync(path, records.map(record => JSON.stringify(record)).join("\n") + "\n");
  return path;
}

test("served chapters distinguish successful inspection from failed retries", SKIP_NO_PLAYWRIGHT, async () => {
  const home = mkdtempSync(join(tmpdir(), "tracequest-retries-"));
  const sessionPath = seed(home);
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ["bin/tracequest.js", "serve", "--port", String(port)], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home,
      TRACEQUEST_SKIP_LR_WATCH: "1", TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1",
      TRACEQUEST_TMUX_SOCKET: `retries-${process.pid}`, TRACEQUEST_TMUX_SESSION: `retries-${process.pid}` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let browser;
  let log = "";
  try {
    const base = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`serve timeout: ${log}`)), 20000);
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`serve exited ${code}: ${log}`)); });
      child.stderr.on("data", chunk => { log += chunk; });
      child.stdout.on("data", chunk => {
        log += chunk;
        const match = log.match(/http:\/\/localhost:(\d+)/);
        if (match) { clearTimeout(timeout); resolve(`http://127.0.0.1:${match[1]}`); }
      });
    });
    browser = await PLAYWRIGHT.chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/view?path=${encodeURIComponent(sessionPath)}`);
    await page.locator("#chapter-0").waitFor();
    for (let index = 0; index < cases.length; index++) {
      const scenario = cases[index];
      const chapter = page.locator(`#chapter-${index}`);
      await chapter.click();
      assert.equal(await chapter.locator(".chapter-pattern-badge.retry").count(), scenario.retries ? 1 : 0, scenario.name);
      if (scenario.retries) assert.match(await chapter.locator(".chapter-pattern-badge.retry").innerText(), new RegExp(`${scenario.retries} ${scenario.retries === 1 ? "retry" : "retries"}`), scenario.name);
      assert.equal(await chapter.locator(".chapter-waste-badge").count(), scenario.waste ? 1 : 0, await chapter.innerText());
      const text = await chapter.innerText();
      assert.match(text, new RegExp(`\\b${scenario.outcome}\\b`), scenario.name);
      if (scenario.waste && !scenario.resolved) assert.match(text, /3 failed retries without resolution/);
      else assert.doesNotMatch(text, /failed retries without resolution/, scenario.name);
      if (!scenario.waste) assert.doesNotMatch(text, /est\. wasted:/, scenario.name);
    }
    assert.deepEqual(errors, [], "viewer has no JavaScript errors");
  } finally {
    await browser?.close();
    if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    rmSync(home, { recursive: true, force: true });
  }
});
