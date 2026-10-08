/**
 * Shared bench plumbing: argument parsing, child-process isolation, reporting.
 *
 * Every measurement runs in a FRESH child process. The index layer keeps
 * process-lifetime caches (index cache, search index, per-path parse memos), so
 * a second measurement in the same process would report warm-cache numbers and
 * silently invalidate the whole benchmark.
 */
import fs from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * Run `exportName` from `moduleUrl` in a fresh child and resolve its return value.
 * The child re-imports the same module with TQ_BENCH_CHILD=1 so its main() is inert.
 */
export function runInChild(moduleUrl, exportName, payload, { execArgv = [] } = {}) {
  const modulePath = fileURLToPath(moduleUrl);
  const runner = fileURLToPath(new URL("./child-runner.js", import.meta.url));

  return new Promise((resolve, reject) => {
    const child = fork(runner, [modulePath, exportName], {
      env: { ...process.env, TQ_BENCH_CHILD: "1" },
      execArgv: [...process.execArgv, ...execArgv],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    // Hold the result until the child has fully exited: its exit handlers flush
    // deferred index writes, and tearing the corpus down underneath them would
    // both crash the child and corrupt the next measurement.
    let result;
    let failure;
    child.on("message", (msg) => {
      if (msg && msg.ok) result = { value: msg.value };
      else failure = new Error(msg?.error ?? "bench child failed");
      child.disconnect();
    });
    child.on("exit", (code) => {
      if (failure) reject(failure);
      else if (result) resolve(result.value);
      else reject(new Error(`bench child exited ${code} without a result`));
    });
    child.send({ payload });
  });
}

/** Print a bench result as both a human table and a machine-readable JSON line. */
export function reportRun(name, body) {
  const record = { bench: name, at: new Date().toISOString(), ...body };
  process.stdout.write(`\n=== ${name} ===\n`);
  process.stdout.write(JSON.stringify(record, null, 2) + "\n");
  if (process.env.TQ_BENCH_JSON) {
    fs.appendFileSync(process.env.TQ_BENCH_JSON, JSON.stringify(record) + "\n");
  }
  return record;
}
