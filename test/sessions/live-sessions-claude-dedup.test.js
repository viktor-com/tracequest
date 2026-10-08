import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import {
  findLiveClaude,
  setFindLiveClaudeDepsForTests,
  clearLiveSessionsCache,
} from "../../src/sessions/live-sessions.js";
import { assertPerf } from "../helpers/perf-assert.js";

const origHomeEnv = process.env.TRACEQUEST_LIVE_SESSIONS_HOME;

afterEach(() => {
  if (origHomeEnv === undefined) delete process.env.TRACEQUEST_LIVE_SESSIONS_HOME;
  else process.env.TRACEQUEST_LIVE_SESSIONS_HOME = origHomeEnv;
  setFindLiveClaudeDepsForTests(null);
  clearLiveSessionsCache();
});

describe("findLiveClaude projDir dedup", { concurrency: false }, () => {
  test("scans each project directory once when multiple pids share cwd", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-claude-dedup-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = "/tmp/tracequest-dedup-proj";
    const proj = "-" + cwd.slice(1).replace(/\//g, "-");
    const projDir = path.join(home, ".claude", "projects", proj);
    fs.mkdirSync(projDir, { recursive: true });
    const oldFile = path.join(projDir, "old.jsonl");
    const newFile = path.join(projDir, "new.jsonl");
    const generating = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }) + "\n";
    fs.writeFileSync(oldFile, generating);
    fs.writeFileSync(newFile, generating);
    const oldTime = new Date("2020-01-01");
    const newTime = new Date("2025-06-01");
    fs.utimesSync(oldFile, oldTime, oldTime);
    fs.utimesSync(newFile, oldTime, newTime);

    let readdirCalls = 0;
    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: () => ({ status: 0, stdout: "101\n102\n103\n" }),
      readlinkSync: (target) => {
        if (String(target).startsWith("/proc/")) return cwd;
        return fs.readlinkSync(target);
      },
      readdirSync: (...args) => {
        readdirCalls++;
        return fs.readdirSync(...args);
      },
      statSync: (...args) => fs.statSync(...args),
    });

    const live = findLiveClaude();

    assert.deepEqual(live, [newFile, newFile, newFile]);
    assert.equal(readdirCalls, 1, "projDir must be scanned once per findLiveClaude call");
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("still resolves distinct project dirs for different cwds", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-claude-multi-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwdA = "/tmp/proj-a";
    const cwdB = "/tmp/proj-b";
    const projA = "-" + cwdA.slice(1).replace(/\//g, "-");
    const projB = "-" + cwdB.slice(1).replace(/\//g, "-");
    const dirA = path.join(home, ".claude", "projects", projA);
    const dirB = path.join(home, ".claude", "projects", projB);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const fileA = path.join(dirA, "a.jsonl");
    const fileB = path.join(dirB, "b.jsonl");
    const generating = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }) + "\n";
    fs.writeFileSync(fileA, generating);
    fs.writeFileSync(fileB, generating);

    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: () => ({ status: 0, stdout: "201\n202\n" }),
      readlinkSync: (target) => {
        const s = String(target);
        if (s === "/proc/201/cwd") return cwdA;
        if (s === "/proc/202/cwd") return cwdB;
        return fs.readlinkSync(target);
      },
    });

    const live = findLiveClaude();

    assert.deepEqual(new Set(live), new Set([fileA, fileB]));
    assert.equal(live.length, 2);
    fs.rmSync(home, { recursive: true, force: true });
  });

  test("perf: projDir dedup under 1ms/op with 12 pids and 100 jsonl files", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-claude-perf-"));
    process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
    const cwd = "/tmp/tracequest-perf-proj";
    const proj = "-" + cwd.slice(1).replace(/\//g, "-");
    const projDir = path.join(home, ".claude", "projects", proj);
    fs.mkdirSync(projDir, { recursive: true });
    const generating = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } }) + "\n";
    for (let i = 0; i < 100; i++) {
      fs.writeFileSync(path.join(projDir, `sess-${i}.jsonl`), generating);
    }

    const pids = `${Array.from({ length: 12 }, (_, i) => String(300 + i)).join("\n")}\n`;
    setFindLiveClaudeDepsForTests({
      platform: "linux",
      spawnSync: () => ({ status: 0, stdout: pids }),
      readlinkSync: (target) => {
        if (String(target).startsWith("/proc/")) return cwd;
        return fs.readlinkSync(target);
      },
    });

    const ITERS = 80;
    for (let i = 0; i < 10; i++) findLiveClaude();
    const t0 = performance.now();
    for (let i = 0; i < ITERS; i++) findLiveClaude();
    const ms = (performance.now() - t0) / ITERS;

    assertPerf(
      ms < 1,
      `expected findLiveClaude under 1ms/op with projDir dedup (12 pids, 100 files), got ${ms.toFixed(2)}ms`,
    );
    fs.rmSync(home, { recursive: true, force: true });
  });
});