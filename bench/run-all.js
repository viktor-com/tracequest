/**
 * Run the whole bench suite and print one record per benchmark.
 *
 * Defaults are the numbers BASELINE.md is recorded at. The idle runs dominate
 * wall time, so --quick shortens them for an iteration loop; a number quoted in
 * BASELINE.md should always come from a full run.
 *
 *   node bench/run-all.js
 *   node bench/run-all.js --quick
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./lib/harness.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function run(script, argv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...argv], {
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

const args = parseArgs(process.argv.slice(2));
const quick = Boolean(args.quick);
const idleSeconds = String(quick ? 60 : 300);

const plan = [
  ["correctness.js", []],
  ["cold-index.js", ["--per-source", quick ? "200" : "1000"]],
  ["incremental.js", ["--per-source", quick ? "100" : "500"]],
  ["live-stability.js", ["--seconds", String(quick ? 60 : 120)]],
  ["idle.js", ["--seconds", idleSeconds, "--port", "43201"]],
  ["idle.js", ["--seconds", idleSeconds, "--port", "43202", "--live-page"]],
];

let failed = 0;
for (const [script, argv] of plan) {
  process.stderr.write(`\n>>> ${script} ${argv.join(" ")}\n`);
  const code = await run(script, argv);
  if (code !== 0) {
    failed++;
    process.stderr.write(`<<< ${script} exited ${code}\n`);
  }
}

process.stderr.write(`\nbench suite finished, ${failed} script(s) reported failure\n`);
process.exitCode = failed ? 1 : 0;
