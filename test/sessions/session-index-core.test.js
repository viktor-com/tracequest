import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { coerceSidecarSessionMtimes, indexSession } from "../../src/sessions/session-index-core.js";
import {
  indexClaudeJsonl,
  indexCodexJsonl,
  indexCursorJsonl,
  indexFactoryJsonl,
  indexGrokJsonl,
} from "../../src/sessions/session-index-jsonl.js";
import { indexOpenCode } from "../../src/sessions/session-index-opencode.js";
import { sortSessionsByMtimeDesc, sessionMtimeMs } from "../../src/sessions/session-list.js";
import { clearOpenCodeDiscoveryCache, discoveryRoots } from "../../src/sessions/session-discovery.js";
import { resolveOpenCodeDbPath } from "../../src/sessions/session-discovery-paths.js";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";
import { withMockSidecarScript } from "../helpers/sidecar-mock.js";
import { resetIndexWritersForTests } from "../../src/sessions/index-writers.js";
import { assertPerf } from "../helpers/perf-assert.js";

function assertMtimeDesc(sessions, label = "sessions") {
  for (let i = 1; i < sessions.length; i++) {
    assert.ok(
      sessionMtimeMs(sessions[i - 1]) >= sessionMtimeMs(sessions[i]),
      `${label} must be mtime-desc (newest first)`
    );
  }
}

async function withTmpHome(fn, { noSidecar = true } = {}) {
  const tmpDir = mkTmp("tq-sic-home-");
  const originalHome = process.env.HOME;
  const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = tmpDir;
  if (noSidecar) process.env.TRACEQUEST_NO_SIDECAR = "1";
  else if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;

  try {
    const modUrl = new URL("../../src/sessions.js?" + Date.now(), import.meta.url);
    const mod = await import(modUrl.href);
    return await fn(tmpDir, mod);
  } finally {
    process.env.HOME = originalHome;
    if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function seedIndexOpenCodeDb(dbPath, sessions) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)`);
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
  const insMsg = db.prepare(
    `INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`
  );
  const insPart = db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);
  let msgSeq = 0;
  let partSeq = 0;
  for (const sess of sessions) {
    for (const msg of sess.messages ?? []) {
      const mid = `m${++msgSeq}`;
      insMsg.run(
        mid,
        sess.id,
        JSON.stringify({ role: msg.role ?? "user", modelID: msg.modelID }),
        msg.time ?? "2026-05-01T00:00:00Z"
      );
      for (const part of msg.parts ?? []) {
        insPart.run(`p${++partSeq}`, mid, JSON.stringify(part));
      }
    }
  }
  db.close();
}

function openCodeSessionRow(id, title = id) {
  return { source: "opencode", file: id, title, path: `opencode://${id}` };
}

describe("session-index-core coerceSidecarSessionMtimes", () => {
  test("converts numeric mtimes to Date in place", () => {
    const sessions = [
      { path: "/a", mtime: 1_700_000_000_000 },
      { path: "/b", mtime: new Date(2000) },
    ];
    coerceSidecarSessionMtimes(sessions);
    assert.ok(sessions[0].mtime instanceof Date);
    assert.equal(sessions[0].mtime.getTime(), 1_700_000_000_000);
    assert.ok(sessions[1].mtime instanceof Date);
    assert.equal(sessions[1].mtime.getTime(), 2000);
  });

  test("leaves Date mtimes unchanged", () => {
    const d = new Date(42);
    const sessions = [{ path: "/x", mtime: d }];
    coerceSidecarSessionMtimes(sessions);
    assert.strictEqual(sessions[0].mtime, d);
  });

  test("empty array is a no-op", () => {
    const sessions = [];
    assert.strictEqual(coerceSidecarSessionMtimes(sessions), sessions);
    assert.deepEqual(sessions, []);
  });

  test("returns the same array reference (mutates in place)", () => {
    const sessions = [{ path: "/ref", mtime: 123 }];
    const out = coerceSidecarSessionMtimes(sessions);
    assert.strictEqual(out, sessions);
    assert.equal(sessions.length, 1);
  });

  test("preserves session object identity and non-mtime fields", () => {
    const row = {
      path: "/p/s.jsonl",
      project: "p",
      file: "s.jsonl",
      size: 4096,
      source: "claude",
      mtime: 1_711_000_000_000,
    };
    const sessions = [row];
    coerceSidecarSessionMtimes(sessions);
    assert.strictEqual(sessions[0], row);
    assert.equal(row.path, "/p/s.jsonl");
    assert.equal(row.project, "p");
    assert.equal(row.size, 4096);
    assert.equal(row.source, "claude");
    assert.ok(row.mtime instanceof Date);
    assert.equal(row.mtime.getTime(), 1_711_000_000_000);
  });

  test("epoch zero numeric mtime becomes 1970-01-01 UTC", () => {
    const sessions = [{ path: "/zero", mtime: 0 }];
    coerceSidecarSessionMtimes(sessions);
    assert.ok(sessions[0].mtime instanceof Date);
    assert.equal(sessions[0].mtime.getTime(), 0);
    assert.equal(sessions[0].mtime.toISOString(), "1970-01-01T00:00:00.000Z");
  });

  test("negative numeric mtime coerces without clamping", () => {
    const sessions = [{ path: "/neg", mtime: -86_400_000 }];
    coerceSidecarSessionMtimes(sessions);
    assert.equal(sessions[0].mtime.getTime(), -86_400_000);
  });

  test("floating-point epoch ms truncates to integer milliseconds", () => {
    const sessions = [{ path: "/frac", mtime: 1_700_000_000_000.9 }];
    coerceSidecarSessionMtimes(sessions);
    assert.equal(sessions[0].mtime.getTime(), 1_700_000_000_000);
  });

  test("undefined mtime is left untouched", () => {
    const sessions = [{ path: "/no-mtime" }, { path: "/undef", mtime: undefined }];
    coerceSidecarSessionMtimes(sessions);
    assert.equal(sessions[0].mtime, undefined);
    assert.equal(sessions[1].mtime, undefined);
  });

  test("null mtime is left untouched", () => {
    const sessions = [{ path: "/null", mtime: null }];
    coerceSidecarSessionMtimes(sessions);
    assert.strictEqual(sessions[0].mtime, null);
  });

  test("string mtime (sidecar leak) is left untouched", () => {
    const iso = "2026-06-03T12:00:00.000Z";
    const sessions = [{ path: "/str", mtime: iso }];
    coerceSidecarSessionMtimes(sessions);
    assert.strictEqual(sessions[0].mtime, iso);
  });

  test("NaN numeric mtime becomes invalid Date", () => {
    const sessions = [{ path: "/nan", mtime: NaN }];
    coerceSidecarSessionMtimes(sessions);
    assert.ok(sessions[0].mtime instanceof Date);
    assert.ok(Number.isNaN(sessions[0].mtime.getTime()));
  });

  test("Infinity numeric mtime becomes invalid Date", () => {
    const sessions = [{ path: "/inf", mtime: Infinity }];
    coerceSidecarSessionMtimes(sessions);
    assert.ok(sessions[0].mtime instanceof Date);
    assert.ok(Number.isNaN(sessions[0].mtime.getTime()));
  });

  test("mixed batch only coerces typeof number rows", () => {
    const d = new Date(99);
    const iso = "2026-01-01T00:00:00.000Z";
    const sessions = [
      { path: "/n", mtime: 5000 },
      { path: "/d", mtime: d },
      { path: "/s", mtime: iso },
      { path: "/u", mtime: undefined },
      { path: "/l", mtime: null },
    ];
    coerceSidecarSessionMtimes(sessions);
    assert.equal(sessions[0].mtime.getTime(), 5000);
    assert.strictEqual(sessions[1].mtime, d);
    assert.strictEqual(sessions[2].mtime, iso);
    assert.equal(sessions[3].mtime, undefined);
    assert.strictEqual(sessions[4].mtime, null);
  });

  test("large epoch ms within Date range coerces correctly", () => {
    const ms = 8_640_000_000_000_000; // year ~275760
    const sessions = [{ path: "/max-ish", mtime: ms }];
    coerceSidecarSessionMtimes(sessions);
    assert.equal(sessions[0].mtime.getTime(), ms);
  });

  test("coerced rows sort desc via sessionMtimeMs after coerce", () => {
    const sessions = [
      { path: "/old", mtime: 1000 },
      { path: "/new", mtime: 9000 },
      { path: "/mid", mtime: 5000 },
    ];
    coerceSidecarSessionMtimes(sessions);
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(
      sessions.map((s) => s.path),
      ["/new", "/mid", "/old"]
    );
    for (const s of sessions) assert.ok(s.mtime instanceof Date);
  });
});

describe("session-index-core findSessions sort", () => {
  test("JS discovery returns claude sessions mtime-desc (newest first)", async () => {
    await withTmpHome(async (tmpDir, { findSessions: findFresh }) => {
      const projDir = path.join(tmpDir, ".claude", "projects", "sortproj");
      fs.mkdirSync(projDir, { recursive: true });
      const oldFile = path.join(projDir, "old.jsonl");
      const midFile = path.join(projDir, "mid.jsonl");
      const newFile = path.join(projDir, "new.jsonl");
      for (const f of [oldFile, midFile, newFile]) fs.writeFileSync(f, "{}");
      const base = Date.now();
      fs.utimesSync(oldFile, base / 1000 - 200, base / 1000 - 200);
      fs.utimesSync(midFile, base / 1000 - 100, base / 1000 - 100);
      fs.utimesSync(newFile, base / 1000, base / 1000);

      const sessions = findFresh(null).filter((s) => s.project === "sortproj");
      assert.equal(sessions.length, 3);
      assertMtimeDesc(sessions, "findSessions");
      assert.equal(sessions[0].path, newFile);
      assert.equal(sessions[2].path, oldFile);
    });
  });

  test("coerce + sortSessionsByMtimeDesc matches findSessions finalize order", () => {
    const sessions = [
      { path: "/old", mtime: 1000 },
      { path: "/new", mtime: 5000 },
      { path: "/mid", mtime: 3000 },
    ];
    coerceSidecarSessionMtimes(sessions);
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(
      sessions.map((s) => s.path),
      ["/new", "/mid", "/old"]
    );
  });

  test("project filter narrows results but keeps mtime-desc order", async () => {
    await withTmpHome(async (tmpDir, { findSessions: findFresh }) => {
      for (const name of ["keep-a", "keep-b", "drop-me"]) {
        const dir = path.join(tmpDir, ".claude", "projects", name);
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, "s.jsonl");
        fs.writeFileSync(file, "{}");
        const offset = name === "keep-a" ? 0 : name === "keep-b" ? 50 : 999;
        const t = Date.now() / 1000 - offset;
        fs.utimesSync(file, t, t);
      }
      const sessions = findFresh("keep-");
      assert.equal(sessions.length, 2);
      assert.ok(sessions.every((s) => s.project.startsWith("keep-")));
      assertMtimeDesc(sessions, "filtered findSessions");
    });
  });

  test("mixed Date and numeric mtimes sort desc after sidecar coerce", () => {
    const sessions = [
      { path: "/d", mtime: new Date(4000) },
      { path: "/n", mtime: 9000 },
      { path: "/m", mtime: 6000 },
    ];
    coerceSidecarSessionMtimes(sessions);
    sortSessionsByMtimeDesc(sessions);
    assert.deepEqual(
      sessions.map((s) => s.path),
      ["/n", "/m", "/d"]
    );
  });
});

describe("session-index-core indexSession dispatch", () => {
  test("indexSession uses module-scope source lookup map", () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/sessions/session-index-core.js"),
      "utf8",
    );
    assert.match(src, /INDEX_SESSION_BY_SOURCE\s*=\s*new Map\(/);
    assert.doesNotMatch(src, /\bswitch\s*\(\s*source\s*\)/);
  });

  test("indexSession dispatch scales on repeated mixed-source calls", () => {
    const tmpDir = mkTmp("tq-sic-dispatch-perf-");
    const claudePath = path.join(tmpDir, "c.jsonl");
    const codexPath = path.join(tmpDir, "rollout.jsonl");
    writeJsonl(claudePath, [
      { type: "user", message: { content: "dispatch perf claude" }, timestamp: "2026-05-01T00:00:00Z" },
    ]);
    writeJsonl(codexPath, [
      { type: "session_meta", payload: {} },
      { type: "event_msg", payload: { type: "user_message", message: "dispatch perf codex" } },
    ]);
    const sessions = [
      { path: claudePath, source: "claude" },
      { path: codexPath, source: "codex" },
      { path: claudePath, source: "claude" },
      { path: codexPath, source: "codex" },
    ];
    try {
      indexSession(sessions[0]);
      const ITERS = 800;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) indexSession(sessions[i % sessions.length]);
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 8,
        `expected indexSession dispatch under 8ms/op for small sessions, got ${ms.toFixed(2)}ms`,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("missing source defaults to claude indexer", () => {
    const tmpDir = mkTmp("tq-sic-default-");
    const filePath = path.join(tmpDir, "session.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: "default claude path" }, timestamp: "2026-05-01T00:00:00Z" },
    ]);
    try {
      const direct = indexClaudeJsonl(filePath);
      const viaCore = indexSession({ path: filePath });
      assert.deepEqual(viaCore, direct);
      assert.ok(viaCore.termFreqs instanceof Map && viaCore.termFreqs.has("default") && viaCore.termFreqs.has("claude") && viaCore.termFreqs.has("path"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("explicit claude source matches indexClaudeJsonl", () => {
    const tmpDir = mkTmp("tq-sic-claude-");
    const filePath = path.join(tmpDir, "explicit.jsonl");
    writeJsonl(filePath, [
      {
        type: "assistant",
        message: { model: "claude-sonnet", content: [{ type: "text", text: "claude dispatch" }] },
        timestamp: "2026-05-01T00:00:00Z",
      },
    ]);
    try {
      const session = { path: filePath, source: "claude" };
      assert.deepEqual(indexSession(session), indexClaudeJsonl(filePath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("cursor source matches indexCursorJsonl", () => {
    const tmpDir = mkTmp("tq-sic-cursor-");
    const filePath = path.join(tmpDir, "cursor.jsonl");
    writeJsonl(filePath, [
      {
        role: "user",
        message: { content: [{ type: "text", text: "cursor dispatch needle" }] },
      },
    ]);
    try {
      const session = { path: filePath, source: "cursor" };
      const direct = indexCursorJsonl(filePath);
      const viaCore = indexSession(session);
      assert.deepEqual(viaCore, direct);
      assert.ok(viaCore.termFreqs instanceof Map && viaCore.termFreqs.has("cursor") && viaCore.termFreqs.has("dispatch") && viaCore.termFreqs.has("needle"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("codex source matches indexCodexJsonl", () => {
    const tmpDir = mkTmp("tq-sic-codex-");
    const filePath = path.join(tmpDir, "rollout.jsonl");
    writeJsonl(filePath, [
      { type: "session_meta", payload: { model_provider: "openai-codex" } },
      { type: "event_msg", payload: { type: "user_message", message: "codex dispatch needle" } },
    ]);
    try {
      const session = { path: filePath, source: "codex" };
      const direct = indexCodexJsonl(filePath);
      const viaCore = indexSession(session);
      assert.deepEqual(viaCore, direct);
      assert.ok(viaCore.termFreqs instanceof Map && viaCore.termFreqs.has("codex") && viaCore.termFreqs.has("dispatch") && viaCore.termFreqs.has("needle"));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("factory source matches indexFactoryJsonl", () => {
    const tmpDir = mkTmp("tq-sic-factory-");
    const filePath = path.join(tmpDir, "factory.jsonl");
    writeJsonl(filePath, [
      {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "factory dispatch" }] },
        timestamp: "2026-05-01T00:00:00Z",
      },
    ]);
    try {
      const session = { path: filePath, source: "factory" };
      assert.deepEqual(indexSession(session), indexFactoryJsonl(filePath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("grok source matches indexGrokJsonl", () => {
    const tmpDir = mkTmp("tq-sic-grok-");
    const sessionDir = path.join(tmpDir, "grok-sess");
    fs.mkdirSync(sessionDir, { recursive: true });
    writeJsonl(path.join(sessionDir, "chat_history.jsonl"), [
      { type: "user", content: "grok dispatch line" },
    ]);
    writeJsonl(path.join(sessionDir, "events.jsonl"), [
      { type: "turn_started", ts: "2026-05-01T00:00:00Z", model_id: "grok-3" },
    ]);
    try {
      const session = { path: sessionDir, source: "grok" };
      assert.deepEqual(indexSession(session), indexGrokJsonl(sessionDir));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("opencode source matches indexOpenCode", async () => {
    const tmpDir = mkTmp("tq-sic-oc-");
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = resolveOpenCodeDbPath(tmpDir);
      await seedIndexOpenCodeDb(dbPath, [
        {
          id: "dispatch-core",
          messages: [
            {
              role: "user",
              modelID: "claude-opus",
              parts: [{ type: "text", text: "opencode dispatch path" }],
            },
          ],
        },
      ]);
      const session = openCodeSessionRow("dispatch-core", "OC Dispatch");
      const direct = indexOpenCode(session);
      const viaCore = indexSession(session);
      assert.deepEqual(viaCore, direct);
      assert.equal(viaCore.model, "claude-opus");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // Previously "unknown source falls back to claude indexer" — that fallback was
  // the JS half of the silent index.json corruption (Rust twin: fact z9k). Full
  // fail-closed coverage lives in test/sessions/session-index-fail-closed.test.js.
  test("unknown source fails closed instead of falling back to the claude indexer", () => {
    const tmpDir = mkTmp("tq-sic-unknown-");
    const filePath = path.join(tmpDir, "legacy.jsonl");
    writeJsonl(filePath, [
      { type: "user", message: { content: "unknown source still claude" }, timestamp: "2026-05-01T00:00:00Z" },
    ]);
    try {
      const session = { path: filePath, source: "legacy-provider" };
      assert.throws(() => indexSession(session), { name: "UnknownSessionSourceError" });
      // The fallback would have produced a valid-looking claude entry for this file.
      assert.ok(indexClaudeJsonl(filePath));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/** Roots-aware mock: emits one session under HOME/.claude/projects (not on disk). */
const SCAN_EXCLUSIVE_MOCK = `#!/usr/bin/env node
const path = require("node:path");
if (process.argv[2] === "scan") {
  const i = process.argv.indexOf("--roots");
  const roots = JSON.parse(process.argv[i + 1]);
  const claudeRoot = roots.find((r) => r.includes(".claude/projects")) || roots[0];
  const sidecarOnly = path.join(claudeRoot, "tq-sidecar-exclusive.jsonl");
  console.log(JSON.stringify([{
    path: sidecarOnly,
    project: "mock-only",
    file: "tq-sidecar-exclusive.jsonl",
    size: 1,
    mtime: 1700000200000,
    source: "claude"
  }]));
  process.exit(0);
}
process.exit(1);
`;

describe("session-index-core findSessions sidecar scan fallback", () => {
  async function importFindSessionsFresh() {
    resetIndexWritersForTests();
    const mod = await import(
      new URL(`../../src/sessions/session-index-core.js?${Date.now()}`, import.meta.url).href
    );
    return mod.findSessions;
  }

  async function withHomeAndMockSidecar(script, fn) {
    const tmpDir = mkTmp("tq-sic-scan-fb-");
    const originalHome = process.env.HOME;
    const originalNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    process.env.HOME = tmpDir;
    delete process.env.TRACEQUEST_NO_SIDECAR;
    clearOpenCodeDiscoveryCache();
    try {
      await withMockSidecarScript(script, async () => {
        const findFresh = await importFindSessionsFresh();
        return fn(tmpDir, findFresh);
      });
    } finally {
      process.env.HOME = originalHome;
      if (originalNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = originalNoSidecar;
      clearOpenCodeDiscoveryCache();
      resetIndexWritersForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  test("non-zero scan exit falls back to discoverSessions on disk", async () => {
    await withHomeAndMockSidecar(
      `#!/usr/bin/env node
if (process.argv[2] === "scan") {
  console.error("scan unavailable");
  process.exit(2);
}
process.exit(1);
`,
      async (tmpDir, findFresh) => {
        const projDir = path.join(tmpDir, ".claude", "projects", "fallback-scan");
        fs.mkdirSync(projDir, { recursive: true });
        const filePath = path.join(projDir, "discovered.jsonl");
        fs.writeFileSync(filePath, "{}");

        const sessions = findFresh("fallback-scan");
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].path, filePath);
        assert.equal(sessions[0].source, "claude");
        assert.equal(sessions[0].project, "fallback-scan");
      }
    );
  });

  test("invalid scan stdout falls back to JS discovery", async () => {
    await withHomeAndMockSidecar(
      `#!/usr/bin/env node
if (process.argv[2] === "scan") {
  console.log("not-json");
  process.exit(0);
}
process.exit(1);
`,
      async (tmpDir, findFresh) => {
        const projDir = path.join(tmpDir, ".claude", "projects", "parse-fallback");
        fs.mkdirSync(projDir, { recursive: true });
        const filePath = path.join(projDir, "from-js.jsonl");
        fs.writeFileSync(filePath, "{}");

        const sessions = findFresh("parse-fallback");
        assert.equal(sessions.length, 1);
        assert.equal(sessions[0].path, filePath);
      }
    );
  });

  test("scan failure still returns mtime-desc sorted sessions", async () => {
    await withHomeAndMockSidecar(
      `#!/usr/bin/env node
if (process.argv[2] === "scan") process.exit(1);
process.exit(1);
`,
      async (tmpDir, findFresh) => {
        const projDir = path.join(tmpDir, ".claude", "projects", "sort-fallback");
        fs.mkdirSync(projDir, { recursive: true });
        const oldFile = path.join(projDir, "old.jsonl");
        const newFile = path.join(projDir, "new.jsonl");
        for (const f of [oldFile, newFile]) fs.writeFileSync(f, "{}");
        const base = Date.now();
        fs.utimesSync(oldFile, base / 1000 - 100, base / 1000 - 100);
        fs.utimesSync(newFile, base / 1000, base / 1000);

        const sessions = findFresh("sort-fallback");
        assert.equal(sessions.length, 2);
        assertMtimeDesc(sessions, "scan-fallback discoverSessions");
        assert.equal(sessions[0].path, newFile);
        assert.equal(sessions[1].path, oldFile);
      }
    );
  });

  test("successful sidecar scan does not merge JS-discovered paths", async () => {
    const tSidecar = 1_700_000_200_000;
    await withHomeAndMockSidecar(SCAN_EXCLUSIVE_MOCK, async (tmpDir, findFresh) => {
      const sidecarOnly = path.join(
        tmpDir,
        ".claude",
        "projects",
        "tq-sidecar-exclusive.jsonl"
      );
      const projDir = path.join(tmpDir, ".claude", "projects", "ignored-on-disk");
      fs.mkdirSync(projDir, { recursive: true });
      fs.writeFileSync(path.join(projDir, "disk-only.jsonl"), "{}");

      const sessions = findFresh(null);
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].path, sidecarOnly);
      assert.ok(sessions[0].mtime instanceof Date);
      assert.equal(sessions[0].mtime.getTime(), tSidecar);
    });
  });

  test("warns when sidecar scan exits non-zero before JS fallback", async () => {
    await withHomeAndMockSidecar(
      `#!/usr/bin/env node
if (process.argv[2] === "scan") {
  console.error("roots rejected");
  process.exit(5);
}
process.exit(1);
`,
      async (tmpDir, findFresh) => {
        const projDir = path.join(tmpDir, ".claude", "projects", "warn-fallback");
        fs.mkdirSync(projDir, { recursive: true });
        fs.writeFileSync(path.join(projDir, "w.jsonl"), "{}");

        const warnSpy = mock.method(console, "warn", () => {});
        try {
          const sessions = findFresh("warn-fallback");
          assert.equal(sessions.length, 1);
          assert.ok(
            warnSpy.mock.calls.some((c) =>
              String(c.arguments[0]).includes("Sidecar scan exited 5")
            ),
            "scan failure should warn before discoverSessions fallback"
          );
        } finally {
          warnSpy.mock.restore();
        }
      }
    );
  });
});

describe("session-index-core discoveryRoots", () => {
  test("discoveryRoots lists all provider paths under HOME", async () => {
    await withTmpHome(async (tmpDir) => {
      const roots = discoveryRoots();
      assert.ok(roots.some((r) => r.includes(path.join(tmpDir, ".claude", "projects"))));
      assert.ok(roots.some((r) => r.includes(path.join(tmpDir, ".codex", "sessions"))));
      assert.ok(roots.some((r) => r.includes(path.join(tmpDir, ".factory", "sessions"))));
      assert.ok(roots.some((r) => r.includes(path.join(tmpDir, ".grok", "sessions"))));
    });
  });
});
