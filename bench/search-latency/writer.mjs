#!/usr/bin/env node
// Live-load generator for the search-latency harness. Simulates agents at work on a
// corpus copy: appends real JSONL lines (taken from other real sessions of the same
// source) to a few active sessions, and moves held-out real sessions back into the
// corpus as "new" ones (or as a bulk host pull).
//
// usage: writer.mjs live <plan.json> [appendMs=500] [newEveryMs=5000]
//        writer.mjs pull <plan.json> [durationMs=30000]
import { appendFileSync, mkdirSync, readFileSync, renameSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";

const [mode, planFile, a1, a2] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, "utf8"));
let stopped = false;
process.on("SIGTERM", () => { stopped = true; });
process.on("SIGINT", () => { stopped = true; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function restore(item) {
  if (existsSync(item.to)) return false;
  mkdirSync(dirname(item.to), { recursive: true });
  // Copy then rename: the session appears whole, as an rsync temp-file rename does.
  const tmp = `${item.to}.tqwriter.tmp`;
  copyFileSync(item.from, tmp);
  renameSync(tmp, item.to);
  return true;
}

if (mode === "live") {
  const appendMs = Number(a1 || 500);
  const newEveryMs = Number(a2 || 5000);
  const pools = new Map(Object.entries(plan.linePools)); // source -> [line, ...]
  const cursor = new Map();
  let lastNew = Date.now();
  let newIdx = 0;
  let appended = 0;
  while (!stopped) {
    for (const s of plan.active) {
      const pool = pools.get(s.source) || [];
      if (!pool.length) continue;
      const i = cursor.get(s.path) || 0;
      appendFileSync(s.path, pool[i % pool.length].replace(/\n?$/, "\n"));
      cursor.set(s.path, i + 1);
      appended++;
    }
    if (Date.now() - lastNew >= newEveryMs && newIdx < plan.newSessions.length) {
      restore(plan.newSessions[newIdx++]);
      lastNew = Date.now();
    }
    await sleep(appendMs);
  }
  process.stdout.write(JSON.stringify({ appended, newSessions: newIdx }) + "\n");
} else if (mode === "pull") {
  const durationMs = Number(a1 || 30000);
  const items = plan.pull;
  const gap = items.length ? durationMs / items.length : 0;
  let n = 0;
  for (const item of items) {
    if (stopped) break;
    if (restore(item)) n++;
    await sleep(gap);
  }
  process.stdout.write(JSON.stringify({ pulled: n }) + "\n");
} else {
  console.error("usage: writer.mjs live|pull <plan.json> ...");
  process.exit(2);
}
