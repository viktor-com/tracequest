/**
 * Correctness of discovery under adversarial conditions.
 *
 * Every case answers one question: does the session list still match reality?
 * A case that throws is reported as a failure rather than crashing the run, so
 * one broken guarantee does not hide the others.
 *
 *   node bench/correctness.js
 *   node bench/correctness.js --case unreadable-dir
 */
import fs from "node:fs";
import path from "node:path";

import {
  seedCorpus,
  seedSymlinkCycle,
  seedUnreadableDir,
  seedImportedHost,
  makeBenchHome,
  removeCorpus,
  appendTurn,
  appendPartialLine,
  completePartialLine,
} from "./lib/corpus.js";
import { parseArgs, reportRun, runInChild } from "./lib/harness.js";

/**
 * Discover REPEATEDLY for `seconds` while the parent churns the tree, reporting
 * the first failure. A single timed scan cannot test a concurrent modification:
 * the child takes longer to boot than the scan takes to run, so the parent's
 * edits always land before it starts. Sustained churn against sustained
 * scanning is the only version of this that actually overlaps.
 */
export async function churnScanRun({ home, seconds = 8, noSidecar = true }) {
  process.env.HOME = home;
  if (noSidecar) process.env.TRACEQUEST_NO_SIDECAR = "1";

  const { findSessions } = await import("../src/sessions.js");
  const t0 = Date.now();
  let scans = 0;
  let minCount = Infinity;
  let maxCount = 0;

  while (Date.now() - t0 < seconds * 1000) {
    try {
      const sessions = findSessions();
      scans++;
      minCount = Math.min(minCount, sessions.length);
      maxCount = Math.max(maxCount, sessions.length);
      const paths = sessions.map((s) => s.path);
      if (new Set(paths).size !== paths.length) {
        return { ok: false, scans, error: "duplicate paths in one scan" };
      }
    } catch (err) {
      return {
        ok: false,
        scans,
        error: `${err?.code ?? ""} ${err?.message ?? err}`.trim(),
        stack: String(err?.stack ?? "").split("\n").slice(0, 3).join(" | "),
      };
    }
  }
  return { ok: true, scans, minCount: minCount === Infinity ? 0 : minCount, maxCount };
}

/** Discover once in a child and report what came back. Never throws to the parent. */
export async function discoverRun({ home, noSidecar = true }) {
  process.env.HOME = home;
  if (noSidecar) process.env.TRACEQUEST_NO_SIDECAR = "1";
  else delete process.env.TRACEQUEST_NO_SIDECAR;

  const t0 = Date.now();
  try {
    const { findSessions } = await import("../src/sessions.js");
    const sessions = findSessions();
    const paths = sessions.map((s) => s.path);
    const unique = new Set(paths);
    return {
      ok: true,
      count: sessions.length,
      uniquePaths: unique.size,
      duplicatePaths: paths.length - unique.size,
      bySource: tally(sessions.map((s) => s.source)),
      ms: Date.now() - t0,
      paths,
    };
  } catch (err) {
    return {
      ok: false,
      error: `${err?.code ?? ""} ${err?.message ?? err}`.trim(),
      stack: String(err?.stack ?? "").split("\n").slice(0, 4).join(" | "),
      ms: Date.now() - t0,
    };
  }
}

function tally(values) {
  const out = {};
  for (const v of values) out[v ?? "(none)"] = (out[v ?? "(none)"] ?? 0) + 1;
  return out;
}

const CASES = {
  /** Baseline: a plain corpus must be discovered exactly. */
  "baseline": async (home) => {
    const seeded = await seedCorpus(home, { perSource: 20 });
    const got = await runInChild(import.meta.url, "discoverRun", { home });
    return {
      expected: seeded.expected.length,
      got: got.count ?? null,
      duplicatePaths: got.duplicatePaths ?? null,
      pass: got.ok && got.count === seeded.expected.length && got.duplicatePaths === 0,
      detail: got.ok ? got.bySource : got.error,
    };
  },

  /** A 0700 directory inside the scan tree must not take the whole list down. */
  "unreadable-dir": async (home) => {
    const seeded = await seedCorpus(home, { perSource: 20, sources: ["claude"] });
    const denied = seedUnreadableDir(home);
    const got = await runInChild(import.meta.url, "discoverRun", { home });
    denied.restore();
    return {
      expected: seeded.expected.length,
      got: got.count ?? null,
      pass: got.ok && got.count >= seeded.expected.length,
      detail: got.ok ? "scan survived" : got.error,
      note: "an EACCES inside the tree must skip that dir, not abort discovery",
    };
  },

  /** A symlinked directory cycle must terminate and must not double-list sessions. */
  "symlink-cycle": async (home) => {
    const seeded = await seedCorpus(home, { perSource: 20, sources: ["claude"] });
    seedSymlinkCycle(home);
    const got = await runInChild(import.meta.url, "discoverRun", { home });
    return {
      expected: seeded.expected.length,
      got: got.count ?? null,
      duplicatePaths: got.duplicatePaths ?? null,
      pass: got.ok && got.duplicatePaths === 0 && got.count === seeded.expected.length,
      detail: got.ok ? got.bySource : got.error,
      note: "a cycle must not hang, throw, or list a session twice under two paths",
    };
  },

  /** Sessions removed and recreated WHILE scans run must never break a scan. */
  "delete-mid-scan": async (home) => {
    const seeded = await seedCorpus(home, { perSource: 400, sources: ["claude"] });
    const victims = seeded.expected.slice(0, 120);
    const child = runInChild(import.meta.url, "churnScanRun", { home, seconds: 8 });

    // Churn for the whole window so deletions land inside real scans.
    const stopAt = Date.now() + 8000;
    const churn = (async () => {
      while (Date.now() < stopAt) {
        for (const v of victims) {
          try {
            fs.rmSync(v.path, { force: true });
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 20));
        for (const v of victims) {
          try {
            fs.writeFileSync(v.path, '{"type":"user","message":{"content":"re"}}\n');
          } catch {}
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    })();

    const got = await child;
    await churn;
    return {
      expected: `scans complete, count between ${seeded.expected.length - victims.length} and ${seeded.expected.length}`,
      got: got.ok ? `${got.scans} scans, ${got.minCount}..${got.maxCount} sessions` : null,
      pass: got.ok && got.scans > 1,
      detail: got.ok ? "every scan survived concurrent delete/recreate" : got.error,
      note: "deleting during the walk must not throw out of discovery",
    };
  },

  /** A whole project directory removed and recreated during live scans. */
  "rmdir-mid-scan": async (home) => {
    const seeded = await seedCorpus(home, { perSource: 300, sources: ["claude", "codex"] });
    const codexDir = path.join(home, ".codex", "sessions");
    const child = runInChild(import.meta.url, "churnScanRun", { home, seconds: 8 });

    const stopAt = Date.now() + 8000;
    const churn = (async () => {
      while (Date.now() < stopAt) {
        try {
          fs.rmSync(codexDir, { recursive: true, force: true });
        } catch {}
        await new Promise((r) => setTimeout(r, 30));
        try {
          fs.mkdirSync(path.join(codexDir, "d"), { recursive: true });
          fs.writeFileSync(
            path.join(codexDir, "d", "rollout-x.jsonl"),
            '{"type":"session_meta","payload":{"cwd":"/w"}}\n',
          );
        } catch {}
        await new Promise((r) => setTimeout(r, 30));
      }
    })();

    const got = await child;
    await churn;
    return {
      expected: "scans complete",
      got: got.ok ? `${got.scans} scans, ${got.minCount}..${got.maxCount} sessions` : null,
      pass: got.ok && got.scans > 1,
      detail: got.ok ? "every scan survived a directory vanishing mid-walk" : got.error,
      note: "a directory removed between the parent readdir and the nested one",
    };
  },

  /** A torn trailing JSONL record must not corrupt or drop the session. */
  "partial-line": async (home) => {
    const seeded = await seedCorpus(home, { perSource: 5, sources: ["claude"] });
    const victim = seeded.expected[0].path;
    const { truncatedFrom } = appendPartialLine(victim);
    const torn = await runInChild(import.meta.url, "discoverRun", { home });
    completePartialLine(victim, truncatedFrom);
    const healed = await runInChild(import.meta.url, "discoverRun", { home });
    return {
      expected: seeded.expected.length,
      got: torn.count ?? null,
      pass: torn.ok && torn.count === seeded.expected.length && healed.ok,
      detail: torn.ok ? `torn ok, healed ${healed.count}` : torn.error,
      note: "a writer caught mid-append leaves half a JSON line at EOF",
    };
  },

  /** An imported host mirrors another machine's tree; both must be listed, once each. */
  "imported-host": async (home) => {
    const local = await seedCorpus(home, { perSource: 20, sources: ["claude"] });
    const remote = await seedImportedHost(home, { perSource: 20, sources: ["claude"] });
    const got = await runInChild(import.meta.url, "discoverRun", { home });
    const total = local.expected.length + remote.expected.length;
    return {
      expected: total,
      got: got.count ?? null,
      duplicatePaths: got.duplicatePaths ?? null,
      pass: got.ok && got.count === total && got.duplicatePaths === 0,
      detail: got.ok ? got.bySource : got.error,
    };
  },
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const only = typeof args.case === "string" ? [args.case] : Object.keys(CASES);

  const results = {};
  for (const name of only) {
    const fn = CASES[name];
    if (!fn) throw new Error(`unknown case ${name}; have ${Object.keys(CASES).join(", ")}`);
    const home = makeBenchHome(`tq-bench-ok-${name}-`);
    try {
      results[name] = await fn(home);
    } catch (err) {
      results[name] = { pass: false, detail: `harness error: ${err?.stack ?? err}` };
    } finally {
      if (!args.keep) removeCorpus(home);
    }
    const r = results[name];
    process.stderr.write(`${r.pass ? "PASS" : "FAIL"}  ${name}\n`);
  }

  const failed = Object.entries(results).filter(([, r]) => !r.pass).map(([n]) => n);
  reportRun("correctness", { results, failed, allPassed: failed.length === 0 });
  if (failed.length) process.exitCode = 1;
}

if (process.env.TQ_BENCH_CHILD !== "1") await main();
