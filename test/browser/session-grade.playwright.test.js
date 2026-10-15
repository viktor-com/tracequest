/** One grade across triage, chat, analytics and offline reports. */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { parseSession } from "../../src/parse.js";
import { buildShareMetadata } from "../../src/share/metadata.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BIN = join(ROOT, "bin/tracequest.js");

function seed(home, name, calls, errors) {
  const path = join(home, ".claude/projects/grade-test", name + ".jsonl");
  let n = 0;
  const timestamp = () => new Date(Date.UTC(2026, 9, 15, 10, 0, n++)).toISOString();
  const lines = [{ type: "user", timestamp: timestamp(), message: { content: name + " grade witness" } }];
  for (let i = 0; i < calls; i++) {
    lines.push({ type: "assistant", timestamp: timestamp(), message: {
      model: "claude-sonnet-4", usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 10000 },
      content: [{ type: "tool_use", id: "call-" + i, name: "Bash", input: { command: `sed -n '${i * 10 + 1},${i * 10 + 10}p' source.js` } }],
    } });
    lines.push({ type: "user", timestamp: timestamp(), message: { content: [{
      type: "tool_result", tool_use_id: "call-" + i, is_error: i < errors,
      content: i < errors ? "file not found" : "source lines",
    }] } });
  }
  lines.push({ type: "assistant", timestamp: timestamp(), message: {
    model: "claude-sonnet-4", content: [{ type: "text", text: "Inspection complete." }],
  } });
  writeJsonl(path, lines);
  return path;
}

async function readGrade(page) {
  await page.locator("#app .session-summary").waitFor();
  return {
    letter: await page.locator(".session-grade-letter").innerText(),
    score: Number((await page.locator(".session-grade-score").innerText()).split("/")[0]),
  };
}

test("session grade agrees in Runs, filters, sorting, chat, detail and standalone reports", SKIP_NO_PLAYWRIGHT, async () => {
  const home = mkTmp("tracequest-grade-");
  const witness = seed(home, "pending-lock-equivalent", 10, 1);
  seed(home, "failed", 5, 4);
  seed(home, "clean", 1, 0);
  writeJsonl(join(home, ".claude/projects/grade-test/empty.jsonl"), []);
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  const env = {
    ...process.env, HOME: home, TRACEQUEST_LIVE_SESSIONS_HOME: home,
    TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_TMUX: "1", TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_TMUX_SOCKET: `tq-grade-${port}`, TRACEQUEST_TMUX_SESSION: `tq-grade-${port}`,
  };
  const child = spawn(process.execPath, [BIN, "serve", "--port", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let browser;
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20000;
    let response;
    while (Date.now() < deadline) {
      assert.equal(child.exitCode, null, logs);
      try { response = await fetch(base + "/api/sessions?sort=grade"); if (response.ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(response?.ok, logs);
    const { sessions } = await response.json();
    const graded = sessions.filter((s) => s._gradeCache.letter !== "-");
    assert.equal(graded.length, 3);
    assert.deepEqual(graded.map((s) => s._gradeCache.letter), ["A", "B", "F"]);
    browser = await PLAYWRIGHT.chromium.launch();
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    for (const row of graded) {
      const expected = { letter: row._gradeCache.letter, score: row._gradeCache.score };
      const expr = `source:claude grade:${expected.letter}`;
      const filtered = await (await fetch(base + "/api/sessions?expr=" + encodeURIComponent(expr))).json();
      assert.deepEqual(filtered.sessions.map((s) => s.id), [row.id], "grade filter selects the inspected session");
      await page.goto(base + "/sessions?expr=" + encodeURIComponent(expr));
      const badge = page.locator(".session-row .session-grade-badge").first();
      await badge.waitFor();
      assert.equal(await badge.innerText(), expected.letter);
      assert.match(await badge.getAttribute("title"), new RegExp(`${expected.score}/100`));
      await page.goto(base + "/view?id=" + row.id);
      assert.deepEqual(await readGrade(page), expected, "detail uses the list's judgment");
      const fresh = await (await fetch(base + "/api/view-session?id=" + row.id)).json();
      await page.evaluate((session) => window.__tqViewApplySession(session), fresh.session);
      assert.deepEqual(await readGrade(page), expected, "in-place detail refresh retains grade");
      await page.goto(base + "/run?session=" + row.id);
      await page.locator("#runGrade").waitFor({ state: "visible" });
      assert.equal(await page.locator("#runGrade").innerText(), expected.letter);
      assert.match(await page.locator("#runGrade").getAttribute("title"), new RegExp(`\\(${expected.score}\\)`));
      const report = join(home, row.id + ".html");
      writeFileSync(report, await (await fetch(base + "/export?id=" + row.id)).text());
      await page.goto(pathToFileURL(report).href);
      assert.deepEqual(await readGrade(page), expected, "downloaded report works offline");
      if (row.path === witness) {
        const cliReport = join(home, "cli-report.html");
        const cli = spawnSync(process.execPath, [BIN, "render", witness, "--out", cliReport], { cwd: ROOT, env: { ...env, HOME: join(home, "cold-cli") }, encoding: "utf8", timeout: 20000 });
        assert.equal(cli.status, 0, cli.stdout + cli.stderr);
        await page.goto(pathToFileURL(cliReport).href);
        assert.deepEqual(await readGrade(page), expected, "CLI report agrees without a preloaded index");
        assert.deepEqual(buildShareMetadata(parseSession(witness, "claude")).grade, expected, "share metadata agrees");
      }
    }
    const empty = sessions.find((s) => s._gradeCache.letter === "-");
    if (empty) {
      await page.goto(base + "/view?id=" + empty.id);
      await page.locator("#app").waitFor();
      assert.equal(await page.locator(".session-grade").count(), 0, "ungraded sessions have no invented grade");
    }
    assert.deepEqual(errors, [], "all grade surfaces run without browser errors");
  } finally {
    await browser?.close();
    if (child.exitCode === null) { child.kill("SIGKILL"); await once(child, "exit"); }
    rmSync(home, { recursive: true, force: true });
  }
});
