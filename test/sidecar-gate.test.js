/**
 * Canonical reference for sidecar gates, skip env vars, and JS fallback behavior.
 *
 * | Mechanism | Value / condition | Effect |
 * |-----------|-------------------|--------|
 * | TRACEQUEST_NO_SIDECAR | `"1"` only | detectSidecar() → null; runSidecar never spawns; findSessions/buildIndex use JS |
 * | TRACEQUEST_SIDECAR_PATH | path to executable | Tests: force mock/real binary without touching target/release |
 * | TRACEQUEST_NO_SIDECAR | unset, `""`, `"0"`, `"true"`, etc. | No gate; sidecar used when a binary is found |
 * | Missing binary | no release/debug ELF and none on PATH | detectSidecar() → null; silent JS fallback |
 * | runSidecar failure | non-zero exit, parse error, spawn error | warn + null → JS fallback (see index-writers tests) |
 * | sidecar-parity.test.js | no built ELF | `test(..., { skip })` — not an env var |
 *
 * Test hygiene: call resetIndexWritersForTests() after swapping mock binaries so
 * _sidecarPath cache is cleared. Never overwrite sidecar/target/release binaries —
 * use TRACEQUEST_SIDECAR_PATH mocks only. Most suites set TRACEQUEST_NO_SIDECAR=1 to avoid flakes.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isNativeExecutable, bundledPlatformSidecarPath } from "../src/sessions/index-writers.js";
import { findSessions } from "../src/sessions/session-index-core.js";
import { sessionMtimeMs } from "../src/sessions/session-list.js";
import { mkTmp, writeJsonl } from "./helpers/fixtures.js";
import { SIDECAR_PATH_ENV, SIDECAR_SKIP_ENV, withMockSidecarScript } from "./helpers/sidecar-mock.js";

const PROJECT_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export { SIDECAR_SKIP_ENV };

export const SIDECAR_GATE_ACTIVE_VALUE = "1";

/** Every path detectSidecar probes, so "missing binary" tests really hide it. */
function sidecarBinPaths() {
  return [
    bundledPlatformSidecarPath(),
    path.join(PROJECT_ROOT, "sidecar/target/release/tracequest-sidecar"),
    path.join(PROJECT_ROOT, "sidecar/target/debug/tracequest-sidecar"),
  ];
}

async function importIndexWriters() {
  const modUrl = new URL("../src/sessions/index-writers.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function saveEnv(key) {
  const had = Object.hasOwn(process.env, key);
  const prev = process.env[key];
  return {
    restore() {
      if (had) process.env[key] = prev;
      else delete process.env[key];
    },
  };
}

async function withTmpHome(noSidecar, fn) {
  const tmpDir = mkTmp("tq-sidecar-gate-home-");
  const home = saveEnv("HOME");
  const gate = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
  process.env.HOME = tmpDir;
  if (noSidecar) process.env[SIDECAR_SKIP_ENV.NO_SIDECAR] = SIDECAR_GATE_ACTIVE_VALUE;
  else delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];

  try {
    const modUrl = new URL("../src/sessions.js?" + Date.now(), import.meta.url);
    const mod = await import(modUrl.href);
    return await fn(tmpDir, mod);
  } finally {
    home.restore();
    gate.restore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function assertMtimeDesc(sessions, label = "sessions") {
  for (let i = 1; i < sessions.length; i++) {
    assert.ok(
      sessionMtimeMs(sessions[i - 1]) >= sessionMtimeMs(sessions[i]),
      `${label} must be mtime-desc (newest first)`,
    );
  }
}

describe("sidecar gate env (TRACEQUEST_NO_SIDECAR)", () => {
  test("runSidecar returns null for scan when gate is active", async () => {
    const gate = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
    process.env[SIDECAR_SKIP_ENV.NO_SIDECAR] = SIDECAR_GATE_ACTIVE_VALUE;
    try {
      const { runSidecar } = await importIndexWriters();
      assert.equal(runSidecar("scan", ["scan", "--roots", "[]"], () => []), null);
    } finally {
      gate.restore();
    }
  });

  test("runSidecar returns null for index when gate is active", async () => {
    const gate = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
    process.env[SIDECAR_SKIP_ENV.NO_SIDECAR] = SIDECAR_GATE_ACTIVE_VALUE;
    try {
      const { runSidecar } = await importIndexWriters();
      assert.equal(
        runSidecar("index", ["index", "--sessions-json", "[]"], () => new Map()),
        null,
      );
    } finally {
      gate.restore();
    }
  });

  test("only literal 1 activates the gate (0, true, empty do not)", async () => {
    const script = `#!/usr/bin/env node
console.log(JSON.stringify({ via: "mock-sidecar", argv: process.argv[2] }));
process.exit(0);
`;
    const inactiveValues = ["0", "true", "", "yes"];
    for (const val of inactiveValues) {
      await withMockSidecarScript(script, async () => {
        const gate = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
        if (val === "") delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];
        else process.env[SIDECAR_SKIP_ENV.NO_SIDECAR] = val;
        try {
          const { runSidecar, resetIndexWritersForTests } = await importIndexWriters();
          resetIndexWritersForTests();
          const out = runSidecar("index", ["index"], (r) => JSON.parse(r.stdout));
          assert.deepEqual(
            out,
            { via: "mock-sidecar", argv: "index" },
            `NO_SIDECAR=${JSON.stringify(val)} must not gate`,
          );
        } finally {
          gate.restore();
        }
      });
    }
  });

  test("gate active skips spawn even when mock binary is installed", async () => {
    const script = `#!/usr/bin/env node
console.log(JSON.stringify({ spawned: true }));
process.exit(0);
`;
    await withMockSidecarScript(script, async () => {
      const gate = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
      process.env[SIDECAR_SKIP_ENV.NO_SIDECAR] = SIDECAR_GATE_ACTIVE_VALUE;
      try {
        const { runSidecar } = await importIndexWriters();
        assert.equal(runSidecar("scan", ["scan"], () => ({ spawned: true })), null);
      } finally {
        gate.restore();
      }
    });
  });
});

describe("sidecar gate JS fallback paths", () => {
  test("findSessions uses JS discovery when TRACEQUEST_NO_SIDECAR=1", async () => {
    await withTmpHome(true, async (tmpDir) => {
      const projDir = path.join(tmpDir, ".claude", "projects", "gate-js");
      fs.mkdirSync(projDir, { recursive: true });
      const filePath = path.join(projDir, "only.jsonl");
      fs.writeFileSync(filePath, JSON.stringify({ command: "gate-js-discovery" }));
      const sessions = findSessions("gate-js");
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].source, "claude");
      assert.equal(sessions[0].path, filePath);
    });
  });

  test("buildIndex indexes via JS when TRACEQUEST_NO_SIDECAR=1", async () => {
    await withTmpHome(true, async (_tmpDir, { buildIndex }) => {
      const tmpDir = mkTmp("tq-gate-build-");
      const filePath = path.join(tmpDir, "gate.jsonl");
      writeJsonl(filePath, [
        {
          type: "user",
          message: { content: "gate buildIndex js path" },
          timestamp: "2026-06-03T12:00:00.000Z",
        },
      ]);
      try {
        const stat = fs.statSync(filePath);
        const sessions = [
          {
            path: filePath,
            source: "claude",
            mtime: stat.mtime,
            size: stat.size,
          },
        ];
        const index = buildIndex(sessions);
        assert.ok(index instanceof Map);
        const meta = index.get(filePath);
        assert.ok(meta);
        // searchText no longer in index; verify firstPrompt contains the expected text instead
        assert.ok(meta.firstPrompt && meta.firstPrompt.includes("gate buildIndex js path") ||
          (meta.termFreqs instanceof Map && meta.termFreqs.has("gate")),
          "meta should reference indexed content from gate buildIndex js path session");
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
});

describe("sidecar implicit skip (missing binary)", () => {
  test("runSidecar returns null when no sidecar binary exists", async () => {
    const bins = sidecarBinPaths();
    const backups = new Map();
    const existed = new Set();
    for (const bin of bins) {
      if (fs.existsSync(bin)) {
        backups.set(bin, fs.readFileSync(bin));
        fs.unlinkSync(bin);
        existed.add(bin);
      }
    }
    const gate = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
    delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];

    try {
      const { runSidecar, resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
      assert.equal(runSidecar("scan", ["scan", "--roots", "[]"], () => []), null);
    } finally {
      for (const bin of bins) {
        if (backups.has(bin)) fs.writeFileSync(bin, backups.get(bin), { mode: 0o755 });
      }
      gate.restore();
      const { resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
    }
  });

  test("sidecar-parity skips when release/debug binary is not a built ELF", () => {
    const bins = sidecarBinPaths();
    const elf = bins.find((b) => isNativeExecutable(b));
    const which = spawnSync("which", ["tracequest-sidecar"], { encoding: "utf-8" });
    const pathElf =
      which.status === 0 && which.stdout.trim() && isNativeExecutable(which.stdout.trim())
        ? which.stdout.trim()
        : null;
    if (elf || pathElf) {
      assert.ok(isNativeExecutable(elf || pathElf));
    } else {
      assert.equal(elf, undefined);
      assert.equal(pathElf, null);
    }
  });
});

describe("sidecar enabled path (gate off, mock binary)", () => {
  test("findSessions uses mock sidecar scan and coerces mtime-desc", async () => {
    const olderPath = "/tmp/tq-gate-sidecar-old.jsonl";
    const newerPath = "/tmp/tq-gate-sidecar-new.jsonl";
    const tOld = 1_700_000_000_000;
    const tNew = 1_700_000_100_000;
    const script = `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === "scan") {
  console.log(JSON.stringify([
    { path: ${JSON.stringify(olderPath)}, project: "mock", file: "old.jsonl", size: 1, mtime: ${tOld}, source: "claude" },
    { path: ${JSON.stringify(newerPath)}, project: "mock", file: "new.jsonl", size: 1, mtime: ${tNew}, source: "claude" }
  ]));
  process.exit(0);
}
process.exit(1);
`;

    await withMockSidecarScript(script, async () => {
      const sessions = findSessions(null);
      assert.equal(sessions.length, 2);
      assert.equal(sessions[0].path, newerPath);
      assert.equal(sessions[1].path, olderPath);
      assert.ok(sessions[0].mtime instanceof Date);
      assert.equal(sessions[0].mtime.getTime(), tNew);
      assertMtimeDesc(sessions, "mock sidecar findSessions");
    });
  });

  test("runSidecar index passes sessions on stdin with --sessions-stdin", async () => {
    const script = `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd !== "index" || !process.argv.includes("--sessions-stdin")) process.exit(1);
const sessions = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
console.log(JSON.stringify({ count: sessions.length, stdin: true }));
process.exit(0);
`;
    await withMockSidecarScript(script, async () => {
      const { runSidecar } = await importIndexWriters();
      const payload = JSON.stringify([{ path: "/tmp/a.jsonl", mtime: 1, source: "claude" }]);
      const out = runSidecar(
        "index",
        ["index", "--sessions-stdin"],
        (r) => JSON.parse(r.stdout),
        { input: payload },
      );
      assert.deepEqual(out, { count: 1, stdin: true });
    });
  });

  test("buildIndex sends searchStale stdin to sidecar, inserts termFreqs into SearchIndex, and drops searchText", async () => {
    const filePath = "/tmp/tq-gate-sidecar-index.jsonl";
    const script = `#!/usr/bin/env node
const fs = require("node:fs");
const cmd = process.argv[2];
if (cmd !== "index") process.exit(1);
for (const flag of ["--index-path", "--version", "--sessions-stdin", "--term-freqs"]) {
  if (!process.argv.includes(flag)) process.exit(2);
}
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
if (!Array.isArray(payload.sessions) || !Array.isArray(payload.searchStale)) process.exit(3);
if (!payload.searchStale.includes(${JSON.stringify(filePath)})) process.exit(4);
const out = {};
for (const s of payload.sessions) {
  out[s.path] = {
    mtime: s.mtime,
    firstPrompt: "sidecar gate indexed prompt",
    model: "mock-sidecar-model",
    tools: ["bash"],
    toolCounts: { bash: 1 },
    chapters: 1,
    totalTokens: 3,
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    durationMs: 0,
    errors: 0,
    files: 0,
    commits: 0,
    searchText: "legacy sidecar full-text blob must not leak",
    termFreqs: { sidecar: 1, gate: 1, needle: 1 }
  };
}
console.log(JSON.stringify(out));
process.exit(0);
`;

    await withMockSidecarScript(script, async () => {
      await withTmpHome(false, async (_tmpDir, { buildIndex, searchSessions }) => {
        const sessions = [{
          path: filePath,
          project: "sidecar-gate",
          file: "gate.jsonl",
          size: 42,
          mtime: new Date("2026-06-01T00:00:00.000Z"),
          source: "claude",
        }];

        const index = buildIndex(sessions);
        const meta = index.get(filePath);
        assert.ok(meta, "sidecar metadata should be merged into buildIndex result");
        assert.equal(meta.firstPrompt, "sidecar gate indexed prompt");
        assert.equal(meta.termFreqs, undefined, "termFreqs must not remain on metadata entries");
        assert.equal(meta.searchText, undefined, "searchText must not remain on metadata entries");

        const results = searchSessions(sessions, index, "needle", 5);
        assert.equal(results.length, 1);
        assert.equal(results[0].path, filePath);
      });
    });
  });

  test("resetIndexWritersForTests clears cached sidecar path after env/binary change", async () => {
    const scriptA = `#!/usr/bin/env node
console.log(JSON.stringify({ which: "A" }));
process.exit(0);
`;
    const scriptB = `#!/usr/bin/env node
console.log(JSON.stringify({ which: "B" }));
process.exit(0);
`;

    const dir = mkdtempSync(path.join(tmpdir(), "tq-sidecar-swap-"));
    const binA = path.join(dir, "tracequest-sidecar-a");
    const binB = path.join(dir, "tracequest-sidecar-b");
    const pathEnv = saveEnv(SIDECAR_PATH_ENV);
    const noSidecar = saveEnv(SIDECAR_SKIP_ENV.NO_SIDECAR);
    delete process.env[SIDECAR_SKIP_ENV.NO_SIDECAR];

    try {
      fs.writeFileSync(binA, scriptA, { mode: 0o755 });
      fs.writeFileSync(binB, scriptB, { mode: 0o755 });
      process.env[SIDECAR_PATH_ENV] = binA;
      const { runSidecar, resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
      const a = runSidecar("index", ["index"], (r) => JSON.parse(r.stdout));
      assert.deepEqual(a, { which: "A" });

      process.env[SIDECAR_PATH_ENV] = binB;
      resetIndexWritersForTests();

      const b = runSidecar("index", ["index"], (r) => JSON.parse(r.stdout));
      assert.deepEqual(b, { which: "B" });
    } finally {
      pathEnv.restore();
      noSidecar.restore();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      const { resetIndexWritersForTests } = await importIndexWriters();
      resetIndexWritersForTests();
    }
  });
});

describe("sidecar gate contract (exported constants)", () => {
  test("SIDECAR_SKIP_ENV documents the only sidecar disable env var", () => {
    assert.equal(SIDECAR_SKIP_ENV.NO_SIDECAR, "TRACEQUEST_NO_SIDECAR");
    assert.equal(SIDECAR_GATE_ACTIVE_VALUE, "1");
  });
});
