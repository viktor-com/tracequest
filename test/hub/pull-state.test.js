import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHubStatus,
  pullStatePath,
  readPullState,
  recordPulls,
  STALE_AFTER_MS,
} from "../../src/hub/pull-state.js";
import { runSshImport } from "../../src/import/ssh-import.js";
import { listImportedHosts } from "../../src/sessions/session-discovery-paths.js";

function tmp() {
  return mkdtempSync(join(tmpdir(), "tq-hub-"));
}

test("recordPulls keeps the last attempt, last success and failure streak per host", () => {
  const root = tmp();
  try {
    assert.deepEqual(readPullState(root), {});
    const t1 = Date.parse("2026-10-06T10:00:00Z");
    recordPulls([{ hostId: "mac", spec: "u@mac", fetched: 6, changed: 2, skipped: 4, failed: 0, error: "" }], { hostsRoot: root, now: t1 });
    let s = readPullState(root);
    assert.equal(s.mac.ok, true);
    assert.equal(s.mac.lastSuccessAt, "2026-10-06T10:00:00.000Z");
    assert.equal(s.mac.changed, 2);

    for (const min of [30, 60]) {
      recordPulls([{
        hostId: "mac", spec: "u@mac", fetched: 0, changed: 0, skipped: 0, failed: 6,
        error: "ssh: connect to host host.example port 22: Connection timed out\nsecond line never stored",
      }], { hostsRoot: root, now: t1 + min * 60_000 });
    }
    s = readPullState(root);
    assert.equal(s.mac.ok, false);
    assert.equal(s.mac.consecutiveFailures, 2);
    assert.equal(s.mac.lastSuccessAt, "2026-10-06T10:00:00.000Z", "a failure keeps the last good pull");
    assert.equal(s.mac.lastAttemptAt, "2026-10-06T11:00:00.000Z");
    assert.equal(s.mac.error, "ssh: connect to host host.example port 22: Connection timed out");
    assert.deepEqual(listImportedHosts(root), [], "the record is not mistaken for a host");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildHubStatus lists this machine first and labels each host fresh, stale, failing or never", () => {
  const now = Date.parse("2026-10-06T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  const rows = buildHubStatus({
    now,
    sessions: [
      { path: "/a", mtime: new Date(now - 1000) },
      { path: "/b", host: "fresh", mtime: new Date(now - 5000) },
      { path: "/c", host: "fresh", mtime: new Date(now - 9000) },
    ],
    configured: [{ spec: "u@never", hostId: "never" }, { spec: "fresh", hostId: "fresh" }],
    importedHosts: ["fresh", "ondisk"],
    pullState: {
      fresh: { spec: "fresh", ok: true, lastAttemptAt: iso(now - 60_000), lastSuccessAt: iso(now - 60_000), consecutiveFailures: 0 },
      old: { spec: "old", ok: true, lastAttemptAt: iso(now - STALE_AFTER_MS - 1), lastSuccessAt: iso(now - STALE_AFTER_MS - 1), consecutiveFailures: 0 },
      down: { spec: "u@down", ok: false, lastAttemptAt: iso(now), lastSuccessAt: null, consecutiveFailures: 3, error: "Permission denied (publickey)." },
    },
  });
  assert.deepEqual(rows.map((r) => [r.host, r.state, r.sessions]), [
    ["local", "local", 1],
    ["down", "failing", 0],
    ["fresh", "fresh", 2],
    ["never", "never", 0],
    ["old", "stale", 0],
    ["ondisk", "never", 0],
  ]);
  assert.equal(rows[1].error, "Permission denied (publickey).");
  assert.equal(rows[1].consecutiveFailures, 3);
  assert.equal(rows[2].newestSessionAt, now - 5000);
  assert.equal(rows[3].spec, "u@never");
});

test("import ssh records each host's pull, and a dry run records nothing", async () => {
  const fixture = tmp();
  const hostsRoot = tmp();
  const prev = process.env.TRACEQUEST_HOSTS_DIR;
  process.env.TRACEQUEST_HOSTS_DIR = hostsRoot;
  try {
    const dir = join(fixture, "gpu", ".claude", "projects", "-work-app");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "s1.jsonl"), '{"type":"user","message":{"content":"hi"}}\n');
    const quiet = { out: () => {}, warn: () => {} };

    const dry = await runSshImport({ hosts: ["gpu"], fixtureRoot: fixture, dryRun: true, ...quiet });
    assert.equal(dry.failed, 0);
    assert.equal(existsSync(pullStatePath(hostsRoot)), false);

    const real = await runSshImport({ hosts: ["gpu"], fixtureRoot: fixture, ...quiet });
    assert.deepEqual(real, { checked: 6, fetched: 1, imported: 1, updated: 0, skipped: 5, failed: 0 });
    const state = readPullState(hostsRoot);
    assert.equal(state.gpu.ok, true);
    assert.deepEqual(
      { fetched: state.gpu.fetched, changed: state.gpu.changed, skipped: state.gpu.skipped, failed: state.gpu.failed },
      { fetched: 1, changed: 1, skipped: 5, failed: 0 },
    );

    const failing = await runSshImport({
      hosts: ["gpu"], fixtureRoot: fixture, ...quiet,
      runRsync: async () => ({ status: 255, stdout: "", stderr: "ssh: connect to host gpu port 22: Connection refused" }),
    });
    assert.equal(failing.failed, 6, "an unreachable host fails all six sources");
    const after = readPullState(hostsRoot).gpu;
    assert.equal(after.ok, false);
    assert.equal(after.consecutiveFailures, 1);
    assert.equal(after.error, "ssh: connect to host gpu port 22: Connection refused");
    assert.equal(after.lastSuccessAt, state.gpu.lastSuccessAt);
  } finally {
    if (prev === undefined) delete process.env.TRACEQUEST_HOSTS_DIR;
    else process.env.TRACEQUEST_HOSTS_DIR = prev;
    rmSync(fixture, { recursive: true, force: true });
    rmSync(hostsRoot, { recursive: true, force: true });
  }
});
