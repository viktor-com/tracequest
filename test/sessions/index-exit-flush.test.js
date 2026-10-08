/**
 * The cache is an optimisation, never a reason to fail a command (fact 5pu).
 *
 * index.json's exit-path write has always been guarded; search.idx's was not,
 * so an unwritable ~/.cache/tracequest made every CLI invocation die with an
 * uncaught EACCES stack trace AFTER its real work had already succeeded.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * Index a tiny corpus in a child process whose cache dir is in `mode`, and
 * report how that process exited. A child is required: the behaviour under
 * test lives in a process exit handler.
 */
function runIndexWithCacheDir(mode) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-exitflush-"));
  const projDir = path.join(home, ".claude", "projects", "p");
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(
    path.join(projDir, "s.jsonl"),
    JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "hello" }] } }) + "\n",
  );

  const script = `
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    const fs = require("node:fs");
    import(${JSON.stringify(path.join(REPO, "src/sessions.js"))}).then(async (m) => {
      m.buildIndex(m.findSessions());
      const cd = ${JSON.stringify(path.join(home, ".cache", "tracequest"))};
      fs.mkdirSync(cd, { recursive: true });
      ${mode === "readonly" ? 'fs.chmodSync(cd, 0o500);' : 'fs.rmSync(cd, { recursive: true, force: true });'}
      console.log("READY");
    });
  `;

  let status = 0;
  let stderr = "";
  try {
    execFileSync(process.execPath, ["-e", script], {
      env: { ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: "1" },
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    status = err.status ?? 1;
    stderr = String(err.stderr ?? "");
  } finally {
    try {
      fs.chmodSync(path.join(home, ".cache", "tracequest"), 0o700);
    } catch {}
    fs.rmSync(home, { recursive: true, force: true });
  }
  return { status, stderr };
}

describe("index cache exit flush", () => {
  test("a read-only cache dir does not fail the command", () => {
    const { status, stderr } = runIndexWithCacheDir("readonly");
    assert.equal(status, 0, `expected exit 0, got ${status}:\n${stderr}`);
    assert.ok(!/EACCES/.test(stderr), `no EACCES should escape:\n${stderr}`);
  });

  test("a cache dir removed mid-run does not fail the command", () => {
    const { status, stderr } = runIndexWithCacheDir("removed");
    assert.equal(status, 0, `expected exit 0, got ${status}:\n${stderr}`);
  });

  test("flushDeferredIndexWrites guards the search.idx write like the index.json write", async () => {
    const mod = await import(
      new URL("../../src/sessions/index-writers.js?" + Date.now(), import.meta.url).href
    );
    const src = fs.readFileSync(path.join(REPO, "src/sessions/index-writers.js"), "utf-8");
    const body = src.slice(src.indexOf("export function flushDeferredIndexWrites"));
    const fn = body.slice(0, body.indexOf("\n}"));
    assert.match(fn, /try\s*\{\s*writeIndexFileToDisk\(\);/, "index.json write stays guarded");
    assert.match(fn, /try\s*\{\s*_flushSearchIdxWriteForTests\(\);/, "search.idx write is guarded too");
    assert.equal(typeof mod.flushDeferredIndexWrites, "function");
  });
});
