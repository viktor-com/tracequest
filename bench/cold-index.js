/**
 * Cold and warm index benchmark.
 *
 * Cold  = no ~/.cache/tracequest/index.json: every session must be parsed.
 * Warm  = index.json present and current: the run should be a stat-per-session
 *         revalidation and nothing else.
 *
 * Both the Rust sidecar path (production default) and the pure-JS fallback
 * (TRACEQUEST_NO_SIDECAR=1) are measured, because they are different programs
 * and only one of them is exercised by most of the test suite.
 *
 *   node bench/cold-index.js --per-source 1000
 *   node bench/cold-index.js --real            # against the operator's real $HOME
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { seedCorpus, makeBenchHome, removeCorpus, BENCH_SOURCES } from "./lib/corpus.js";
import { timed, mb, ms } from "./lib/measure.js";
import { parseArgs, reportRun, runInChild } from "./lib/harness.js";

/** Body of one measurement, executed in a fresh child so module state is cold. */
export async function coldIndexRun({ home, noSidecar, dropCache }) {
  process.env.HOME = home;
  if (noSidecar) process.env.TRACEQUEST_NO_SIDECAR = "1";
  else delete process.env.TRACEQUEST_NO_SIDECAR;

  const cacheDir = path.join(home, ".cache", "tracequest");
  if (dropCache) fs.rmSync(cacheDir, { recursive: true, force: true });

  const { findSessions, buildIndex } = await import("../src/sessions.js");
  const { flushDeferredIndexWriteForTests } = await import("../src/sessions/index-writers.js");
  const { flushSearchIdxWriteForTests } = await import("../src/sessions/search-index.js");

  const scan = await timed(() => findSessions());
  const sessions = scan.value;
  const build = await timed(() => buildIndex(sessions));
  const flush = await timed(async () => {
    flushDeferredIndexWriteForTests?.();
    flushSearchIdxWriteForTests?.();
  });

  let indexBytes = null;
  let searchBytes = null;
  try {
    indexBytes = fs.statSync(path.join(cacheDir, "index.json")).size;
  } catch {}
  try {
    searchBytes = fs.statSync(path.join(cacheDir, "search.idx")).size;
  } catch {}

  return {
    sessions: sessions.length,
    scanMs: ms(scan.ms),
    buildMs: ms(build.ms),
    flushMs: ms(flush.ms),
    totalMs: ms(scan.ms + build.ms + flush.ms),
    peakRssMb: mb(process.memoryUsage().rss),
    heapUsedMb: mb(process.memoryUsage().heapUsed),
    indexJsonMb: mb(indexBytes),
    searchIdxMb: mb(searchBytes),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const perSource = Number(args["per-source"] ?? 1000);
  const real = Boolean(args.real);

  let home;
  let seeded = null;
  if (real) {
    home = os.homedir();
  } else {
    home = makeBenchHome("tq-bench-cold-");
    const t = await timed(() => seedCorpus(home, { perSource, sources: BENCH_SOURCES }));
    seeded = t.value;
    process.stderr.write(
      `seeded ${seeded.expected.length} sessions across ${BENCH_SOURCES.length} sources in ${ms(t.ms)}ms\n`,
    );
  }

  const results = {};
  for (const noSidecar of [false, true]) {
    const label = noSidecar ? "js" : "sidecar";
    if (real) {
      // Never delete the operator's real index. Whether this ends up warm or
      // cold depends on what is already in ~/.cache/tracequest.
      results[`${label}.warm`] = await runInChild(import.meta.url, "coldIndexRun", {
        home,
        noSidecar,
        dropCache: false,
      });
    } else {
      results[`${label}.cold`] = await runInChild(import.meta.url, "coldIndexRun", {
        home,
        noSidecar,
        dropCache: true,
      });
      results[`${label}.warm`] = await runInChild(import.meta.url, "coldIndexRun", {
        home,
        noSidecar,
        dropCache: false,
      });
    }
  }

  reportRun("cold-index", {
    mode: real ? "real-home" : `synthetic perSource=${perSource}`,
    home: real ? "(real $HOME)" : home,
    expected: seeded?.expected.length ?? null,
    bySource: seeded?.bySource ?? null,
    results,
  });

  if (!real && !args.keep) removeCorpus(home);
}

if (process.env.TQ_BENCH_CHILD !== "1") await main();
