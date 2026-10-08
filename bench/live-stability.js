/**
 * Live-state stability: does a session that is steadily generating stay "live",
 * and does a settled one stay "idle", across many consecutive polls?
 *
 * Liveness is recomputed from raw inputs on every poll with no hysteresis, so
 * the failure mode this measures is oscillation: the same unchanged situation
 * reported differently between two polls. A flap is any transition in the
 * reported state of a path whose real situation did not change.
 *
 *   node bench/live-stability.js --seconds 120
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

import { seedCorpus, makeBenchHome, removeCorpus, appendTurn } from "./lib/corpus.js";
import { parseArgs, reportRun } from "./lib/harness.js";
import { sleep } from "./lib/measure.js";

/**
 * A stub process whose argv matches the per-binary pgrep patterns live
 * detection uses, running in the session's cwd so procCwds attributes it.
 */
function startStubAgent(binName, cwd) {
  const stubDir = fs.mkdtempSync(path.join(cwd, ".stub-"));
  const stub = path.join(stubDir, binName);
  fs.writeFileSync(stub, "#!/bin/sh\nwhile true; do sleep 1; done\n");
  fs.chmodSync(stub, 0o755);
  const child = spawn(stub, [], { cwd, stdio: "ignore", detached: false });
  return { child, stub };
}

export async function pollRun({ home, seconds, appendEveryMs, targetRel }) {
  process.env.HOME = home;
  process.env.TRACEQUEST_NO_SIDECAR = "1";

  const { findSessions } = await import("../src/sessions.js");
  const { detectLiveSessions, expireLiveMemoForTests, liveProbeDegradedForTests } = await import(
    "../src/sessions/live-sessions.js"
  );

  const target = targetRel ? path.join(home, targetRel) : null;
  const observations = [];
  const t0 = Date.now();
  let lastAppend = 0;
  let i = 0;

  while (Date.now() - t0 < seconds * 1000) {
    if (target && appendEveryMs && Date.now() - lastAppend >= appendEveryMs) {
      appendTurn(target, `benchlive-${i++}`);
      lastAppend = Date.now();
    }
    // The 5s memo is a rate limiter, not part of the decision: expire it so each
    // poll is an independent observation of the same unchanged situation. Expire
    // rather than clear, so the previous clean snapshot survives — that is the
    // state a real poll two seconds later would see.
    expireLiveMemoForTests();
    const sessions = findSessions();
    const tPoll = Date.now();
    const live = detectLiveSessions(sessions);
    const pollMs = Date.now() - tPoll;
    const livePaths = new Set((live ?? []).map((s) => s.path ?? s));
    observations.push({
      tMs: Date.now() - t0,
      pollMs,
      // Whether this pass had a probe that could not answer. A flap on a
      // degraded pass and a flap on a clean pass have different causes, and
      // without recording it the series cannot tell them apart.
      degraded: Boolean(liveProbeDegradedForTests?.()),
      liveCount: livePaths.size,
      targetLive: target ? livePaths.has(target) : null,
    });
    await sleep(2000);
  }

  return { observations };
}

function countFlaps(values) {
  let flaps = 0;
  for (let i = 1; i < values.length; i++) if (values[i] !== values[i - 1]) flaps++;
  return flaps;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seconds = Number(args.seconds ?? 120);

  const home = makeBenchHome("tq-bench-live-");
  const seeded = await seedCorpus(home, { perSource: 50, sources: ["claude", "codex"] });

  // A steadily-appended claude transcript in the project directory that
  // corresponds to a real cwd, with a stub agent process running IN that cwd:
  // liveness needs the pgrep match and the cwd match to line up, otherwise the
  // run measures nothing.
  const { claudeProjectDir } = await import("../src/sessions/session-layout.js");
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "tq-bench-cwd-"));
  const projDir = claudeProjectDir(home, cwd);
  fs.mkdirSync(projDir, { recursive: true });
  const targetPath = path.join(projDir, "live-session.jsonl");
  fs.writeFileSync(
    targetPath,
    JSON.stringify({ type: "user", cwd, message: { content: [{ type: "text", text: "bench start" }] } }) + "\n",
  );
  const target = { path: targetPath };
  const stub = startStubAgent("claude", cwd);

  let result;
  try {
    const { observations } = await pollRunInChild(home, seconds, target);
    const liveCounts = observations.map((o) => o.liveCount);
    const degradedPolls = observations.filter((o) => o.degraded).length;
    const pollMsValues = observations.map((o) => o.pollMs ?? 0);
    const targetStates = observations.map((o) => o.targetLive);
    result = {
      polls: observations.length,
      liveCountFlaps: countFlaps(liveCounts),
      targetStateFlaps: countFlaps(targetStates),
      liveCountRange: [Math.min(...liveCounts), Math.max(...liveCounts)],
      degradedPolls,
      pollMsMedian: pollMsValues.sort((a, b) => a - b)[Math.floor(pollMsValues.length / 2)] ?? 0,
      pollMsMax: Math.max(0, ...pollMsValues),
      targetLiveFraction:
        targetStates.filter(Boolean).length / Math.max(1, targetStates.length),
      observations,
    };
  } finally {
    try {
      stub.child.kill("SIGKILL");
    } catch {}
    fs.rmSync(cwd, { recursive: true, force: true });
  }

  reportRun("live-stability", { seconds, home, sessions: seeded.expected.length, result });
  if (!args.keep) removeCorpus(home);
}

/** Run the poll loop in a child so module-level live caches start cold. */
async function pollRunInChild(home, seconds, target) {
  const { runInChild } = await import("./lib/harness.js");
  return runInChild(import.meta.url, "pollRun", {
    home,
    seconds,
    appendEveryMs: 4000,
    targetRel: target ? target.path.slice(home.length + 1) : null,
  });
}

if (process.env.TQ_BENCH_CHILD !== "1") await main();
