/**
 * Idle cost of a running server: CPU percent and RSS trend with watchers armed.
 *
 * Starts `tracequest serve` against a corpus, lets it settle, then samples
 * /proc for the requested duration with nobody touching the tree. A healthy
 * server is near 0% CPU and flat RSS; anything else is a watcher storm or a
 * leak.
 *
 *   node bench/idle.js --seconds 300
 *   node bench/idle.js --seconds 300 --live-page    # with a live-session poller attached
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { seedCorpus, makeBenchHome, removeCorpus } from "./lib/corpus.js";
import { parseArgs, reportRun } from "./lib/harness.js";
import { sampleProcess, sleep, mb } from "./lib/measure.js";

const REPO = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

async function waitForServer(port, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions?pageSize=1`);
      if (res.ok) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seconds = Number(args.seconds ?? 300);
  const perSource = Number(args["per-source"] ?? 400);
  const port = Number(args.port ?? 43117);

  const home = makeBenchHome("tq-bench-idle-");
  const seeded = await seedCorpus(home, { perSource });
  process.stderr.write(`seeded ${seeded.expected.length} sessions; starting serve on ${port}\n`);

  const child = spawn(process.execPath, [path.join(REPO, "bin", "tracequest.js"), "serve", "--port", String(port)], {
    cwd: REPO,
    env: { ...process.env, HOME: home, TRACEQUEST_NO_BROWSER: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverLog = "";
  child.stdout.on("data", (b) => (serverLog += b.toString()));
  child.stderr.on("data", (b) => (serverLog += b.toString()));

  try {
    const up = await waitForServer(port);
    if (!up) throw new Error(`server did not answer on ${port}:\n${serverLog.slice(-2000)}`);

    // Let the first index settle so we sample steady state, not startup.
    await sleep(5000);

    let poller = null;
    if (args["live-page"]) {
      // Mimic an open live-session page: one /api/sessions/live poll per second.
      // The UI addresses a session by HASH (/run?session=<hash>), not by path,
      // and the two take different routes through resolution — so the hash form
      // is the one worth measuring. --live-page-path measures the other.
      const first = seeded.expected[0].path;
      const { sessionHash } = await import("../src/sessions/session-hash.js");
      const id = args["live-page-path"] ? first : sessionHash(first);
      poller = setInterval(() => {
        fetch(`http://127.0.0.1:${port}/api/sessions/live?id=${encodeURIComponent(id)}`).catch(() => {});
      }, 1000);
    }

    const sample = await sampleProcess(child.pid, { durationMs: seconds * 1000 });
    if (poller) clearInterval(poller);

    reportRun("idle", {
      seconds,
      sessions: seeded.expected.length,
      livePage: Boolean(args["live-page"]),
      livePageForm: args["live-page"] ? (args["live-page-path"] ? "path" : "hash") : null,
      cpuPercent: sample.cpuPercent === null ? null : +sample.cpuPercent.toFixed(2),
      cpuSeconds: sample.cpuSeconds === null ? null : +sample.cpuSeconds.toFixed(2),
      rssStartMb: mb(sample.rssStartBytes),
      rssEndMb: mb(sample.rssEndBytes),
      rssPeakMb: mb(sample.rssPeakBytes),
      rssGrowthMbPerMin: mb(sample.rssSlopeBytesPerMin),
      rssGrowthMbPerMinFirstHalf: mb(sample.rssSlopeFirstHalfBytesPerMin),
      rssGrowthMbPerMinSecondHalf: mb(sample.rssSlopeSecondHalfBytesPerMin),
      rssMidMb: mb(sample.rssMidBytes),
      samples: sample.samples,
    });
  } finally {
    child.kill("SIGTERM");
    await sleep(500);
    child.kill("SIGKILL");
    if (!args.keep) removeCorpus(home);
  }
}

await main();
