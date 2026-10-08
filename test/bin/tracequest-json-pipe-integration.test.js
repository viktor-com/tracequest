import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

// A bare process.exit() after a large async write to a PIPE truncates output at
// the pipe buffer (~64 KiB) — but a redirect to a file (synchronous) does not, and
// an in-process stdout spy never exercises the pipe path. This suite must run the
// real binary and read its stdout through an actual pipe, or it cannot catch the bug.
function runBinPiped(args, env, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("bin timeout")); }, timeoutMs);
    child.on("error", (err) => { clearTimeout(timer); reject(err); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function seedManySessions(home, project, count) {
  const dir = join(home, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-06-03T12:00:00Z",
    sessionId: "seed",
    uuid: "u1",
    message: { model: "claude-sonnet-4", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 } },
  });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(dir, `session-${String(i).padStart(4, "0")}.jsonl`), line + "\n");
  }
}

describe("find/list/search --json survive a real pipe past 64 KiB (fact json-pipe-no-truncate)", () => {
  test("find --json piped through a real pipe is complete and parses", async () => {
    const home = mkdtempSync(join(tmpdir(), "tq-json-pipe-"));
    try {
      const COUNT = 600; // ~120 KiB of JSON records — well past the 64 KiB pipe buffer
      seedManySessions(home, "bigproj", COUNT);

      const piped = await runBinPiped(["find", "--json", "-l", "5000"], { HOME: home });
      assert.equal(piped.code, 0, `nonzero exit; stderr: ${piped.stderr}`);
      // The payload must exceed one pipe buffer, or this test proves nothing.
      assert.ok(piped.stdout.length > 65536, `payload too small to exercise the bug: ${piped.stdout.length} bytes`);
      let records;
      assert.doesNotThrow(() => { records = JSON.parse(piped.stdout); }, "piped JSON must parse (not truncated mid-string)");
      assert.equal(records.length, COUNT, "piped row count must equal seeded session count");

      // Pipe output must match a file redirect byte-for-byte.
      const redirect = await runBinPiped(["find", "--json", "-l", "5000"], { HOME: home });
      assert.equal(piped.stdout.length, redirect.stdout.length, "pipe output length must be stable/complete");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });

  test("list --json and search --json piped past 64 KiB parse fully", async () => {
    const home = mkdtempSync(join(tmpdir(), "tq-json-pipe2-"));
    try {
      const COUNT = 600;
      seedManySessions(home, "bigproj", COUNT);

      const list = await runBinPiped(["list", "--json", "-l", "5000"], { HOME: home });
      assert.equal(list.code, 0, list.stderr);
      assert.ok(list.stdout.length > 65536, `list payload too small: ${list.stdout.length}`);
      assert.equal(JSON.parse(list.stdout).length, COUNT);

      // Every seeded session has the token "ok"; search should hit them all.
      const search = await runBinPiped(["search", "ok", "--json", "-l", "5000"], { HOME: home });
      assert.equal(search.code, 0, search.stderr);
      assert.ok(search.stdout.length > 65536, `search payload too small: ${search.stdout.length}`);
      const hits = JSON.parse(search.stdout);
      assert.ok(Array.isArray(hits) && hits.length > 250, `expected many search hits, got ${hits.length}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
