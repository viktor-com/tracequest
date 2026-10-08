/**
 * Incremental update cost: how long does one appended turn take to reach the index?
 *
 * The interesting axis is transcript SIZE. Invalidation is mtime-equality with no
 * stored byte offset, so an append re-reads the whole file; this bench makes that
 * cost visible by sweeping file size rather than session count.
 *
 *   node bench/incremental.js
 *   node bench/incremental.js --huge-mb 300
 */
import fs from "node:fs";
import path from "node:path";

import { seedCorpus, seedHugeTranscript, makeBenchHome, removeCorpus, appendTurn } from "./lib/corpus.js";
import { parseArgs, reportRun, runInChild } from "./lib/harness.js";
import { timed, summarise, ms, mb } from "./lib/measure.js";

/**
 * Build a warm index, then append to one session and re-index, measuring only
 * the second pass — the incremental one a running server would do.
 */
export async function incrementalRun({ home, targetRel, iters = 5 }) {
  process.env.HOME = home;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  const { findSessions, buildIndex } = await import("../src/sessions.js");
  const target = path.join(home, targetRel);

  // Warm pass: everything cached.
  buildIndex(findSessions());

  const samples = [];
  for (let i = 0; i < iters; i++) {
    appendTurn(target, `benchinc-${i}`);
    const pass = await timed(() => {
      const sessions = findSessions();
      return buildIndex(sessions);
    });
    samples.push(pass.ms);
  }

  return {
    targetBytes: fs.statSync(target).size,
    targetMb: mb(fs.statSync(target).size),
    stats: summarise(samples),
    rssMb: mb(process.memoryUsage().rss),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const perSource = Number(args["per-source"] ?? 500);
  const hugeMb = Number(args["huge-mb"] ?? 0);

  const home = makeBenchHome("tq-bench-inc-");
  const seeded = await seedCorpus(home, { perSource, sources: ["claude"] });
  process.stderr.write(`seeded ${seeded.expected.length} claude sessions\n`);

  const results = {};

  // Small transcript: the common case.
  const small = seeded.expected[0].path.slice(home.length + 1);
  results.small = await runInChild(import.meta.url, "incrementalRun", { home, targetRel: small });

  // Large transcripts: where re-reading from byte 0 starts to hurt.
  for (const sizeMb of hugeMb ? [hugeMb] : [16, 64]) {
    const huge = seedHugeTranscript(home, { targetMb: sizeMb, name: `huge-${sizeMb}.jsonl` });
    process.stderr.write(`seeded ${sizeMb}MB transcript (${huge.bytes} bytes)\n`);
    results[`huge${sizeMb}mb`] = await runInChild(import.meta.url, "incrementalRun", {
      home,
      targetRel: huge.path.slice(home.length + 1),
      iters: 3,
    });
  }

  reportRun("incremental", { sessions: seeded.expected.length, home, results });
  if (!args.keep) removeCorpus(home);
}

if (process.env.TQ_BENCH_CHILD !== "1") await main();
