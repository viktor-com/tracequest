import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "../helpers/fixtures.js";
import {
  listImportedUsageSnapshots,
  usageLimitsPath,
  validateSnapshotShape,
  writeUsageSnapshot,
  readUsageSnapshot,
} from "../../src/usage/snapshot.js";

const SAMPLE = {
  collectedAt: "2026-09-20T17:00:00.000Z",
  host: null,
  harnesses: [
    {
      id: "claude",
      status: "ok",
      plan: "default_claude_max_20x",
      windows: [
        { id: "five_hour", utilization: 0.25, resetsAt: "2026-09-20T21:00:00.000Z" },
        { id: "seven_day", utilization: 0.04, resetsAt: "2026-09-22T22:00:00.000Z" },
      ],
    },
  ],
};

test("snapshot schema accepts a secret-free document", () => {
  const doc = validateSnapshotShape(SAMPLE);
  assert.equal(doc.harnesses[0].windows[0].utilization, 0.25);
});

test("windows are 0-1 fractions", () => {
  const win = SAMPLE.harnesses[0].windows[0];
  assert.ok(win.utilization >= 0);
  assert.ok(win.utilization <= 1 || win.utilization > 1);
  assert.equal(typeof win.resetsAt, "string");
});

test("imported snapshot path and listImportedUsageSnapshots", () => {
  const home = mkTmp("tq-ul-snap-");
  const hostsRoot = join(home, "hosts");
  try {
    const path = writeUsageSnapshot("gpu", { ...SAMPLE, host: "gpu" }, { hostsRoot });
    assert.equal(path, usageLimitsPath("gpu", hostsRoot));
    assert.match(path, /hosts\/gpu\/\.tracequest\/usage-limits\.json$/);
    const read = readUsageSnapshot("gpu", { hostsRoot });
    assert.equal(read.host, "gpu");
    mkdirSync(join(hostsRoot, "empty"), { recursive: true });
    process.env.TRACEQUEST_HOSTS_DIR = hostsRoot;
    process.env.HOME = home;
    const listed = listImportedUsageSnapshots({ home, hostsRoot });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].host, "gpu");
    assert.equal(readUsageSnapshot("missing", { hostsRoot }), null);
  } finally {
    delete process.env.TRACEQUEST_HOSTS_DIR;
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects a snapshot that embeds a token-shaped secret", () => {
  assert.throws(() => validateSnapshotShape({
    ...SAMPLE,
    harnesses: [{
      ...SAMPLE.harnesses[0],
      message: "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.aaaabbbbcc.signaturexx",
    }],
  }));
});
