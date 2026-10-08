/**
 * Discovery must survive the ordinary hostility of a real session tree.
 *
 * A session root is user data: it holds directories this process cannot read,
 * symlinks that point at their own ancestors, and files an agent removes while
 * the walk is in flight. Before these guards, any one of those raised out of
 * findSessions and the whole dashboard went empty (facts a4k, 01c).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeProj, writeJsonl } from "../helpers/fixtures.js";

function importDiscovery() {
  const modUrl = new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-resilience-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  const cleanups = [];
  return (async () => {
    try {
      const mod = await importDiscovery();
      return await fn(mod, tmpDir, (fn2) => cleanups.push(fn2));
    } finally {
      for (const c of cleanups) {
        try {
          c();
        } catch {}
      }
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
}

/** Two readable claude sessions plus whatever hostile thing the test adds. */
function seedReadable(tmpDir, project = "good") {
  const dir = claudeProj(tmpDir, project);
  writeJsonl(path.join(dir, "a.jsonl"), [{ type: "user", message: { content: "a" } }]);
  writeJsonl(path.join(dir, "b.jsonl"), [{ type: "user", message: { content: "b" } }]);
  return dir;
}

describe("discovery resilience: unreadable entries are skipped, not fatal", () => {
  test("an unreadable project directory does not empty the session list", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir, onCleanup) => {
      seedReadable(tmpDir);
      const denied = claudeProj(tmpDir, "denied");
      fs.mkdirSync(path.join(denied, "sub"), { recursive: true });
      fs.chmodSync(denied, 0o000);
      onCleanup(() => fs.chmodSync(denied, 0o755));

      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 2, "the two readable sessions survive the unreadable sibling");
    }));

  test("an unreadable subagents directory does not empty the session list", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir, onCleanup) => {
      const dir = seedReadable(tmpDir);
      const sessionDir = path.join(dir, "session-x");
      const subagents = path.join(sessionDir, "subagents");
      fs.mkdirSync(subagents, { recursive: true });
      writeJsonl(path.join(subagents, "s1.jsonl"), [{ type: "user", message: { content: "s" } }]);
      fs.chmodSync(subagents, 0o000);
      onCleanup(() => fs.chmodSync(subagents, 0o755));

      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 2, "the readable top-level sessions still list");
    }));

  test("a directory removed between the parent readdir and the nested one is skipped", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      seedReadable(tmpDir);
      // A project dir whose entry exists for the parent listing but is gone by
      // the time the walk descends: simulated by a dangling symlink to a dir.
      const projects = path.join(tmpDir, ".claude", "projects");
      fs.symlinkSync(path.join(tmpDir, "no-such-dir"), path.join(projects, "ghost"), "dir");

      const out = [];
      assert.doesNotThrow(() => findClaudeSessions(null, out));
      assert.equal(out.length, 2);
    }));
});

describe("discovery resilience: the walk bounds itself (fact 01c)", () => {
  test("a symlink cycle under the codex root terminates and lists each session once", () =>
    withTempHome(async ({ findCodexSessions }, tmpDir) => {
      const codexDir = path.join(tmpDir, ".codex", "sessions", "a");
      fs.mkdirSync(codexDir, { recursive: true });
      writeJsonl(path.join(codexDir, "rollout-1.jsonl"), [
        { type: "session_meta", payload: { cwd: "/w" } },
      ]);
      // The classic shape: a link pointing back at one of its own ancestors.
      fs.symlinkSync(path.join(tmpDir, ".codex", "sessions"), path.join(codexDir, "loop"), "dir");

      const out = [];
      assert.doesNotThrow(() => findCodexSessions(null, out));
      assert.equal(out.length, 1, "the one rollout is listed exactly once");
      assert.equal(new Set(out.map((s) => s.path)).size, 1, "no duplicate paths from the cycle");
    }));

  test("a directory reachable by two paths contributes its sessions once", () =>
    withTempHome(async ({ findCodexSessions }, tmpDir) => {
      const root = path.join(tmpDir, ".codex", "sessions");
      const real = path.join(root, "real");
      fs.mkdirSync(real, { recursive: true });
      writeJsonl(path.join(real, "rollout-9.jsonl"), [
        { type: "session_meta", payload: { cwd: "/w" } },
      ]);
      fs.symlinkSync(real, path.join(root, "alias"), "dir");

      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 1, "the aliased directory is not walked twice");
    }));

  test("a deeply nested tree stops at the depth ceiling instead of recursing forever", () =>
    withTempHome(async ({ findCodexSessions }, tmpDir) => {
      let dir = path.join(tmpDir, ".codex", "sessions");
      for (let i = 0; i < 40; i++) dir = path.join(dir, `d${i}`);
      fs.mkdirSync(dir, { recursive: true });
      writeJsonl(path.join(dir, "rollout-deep.jsonl"), [
        { type: "session_meta", payload: { cwd: "/w" } },
      ]);

      const out = [];
      assert.doesNotThrow(() => findCodexSessions(null, out));
      // The point is termination, not that a 40-deep rollout is reachable.
      assert.ok(Array.isArray(out));
    }));
});

describe("discovery resilience: findSessions as a whole", () => {
  test("one hostile subtree still yields every readable session across sources", () =>
    withTempHome(async (_mod, tmpDir, onCleanup) => {
      seedReadable(tmpDir);
      const denied = claudeProj(tmpDir, "denied");
      fs.mkdirSync(denied, { recursive: true });
      fs.chmodSync(denied, 0o000);
      onCleanup(() => fs.chmodSync(denied, 0o755));

      const codexDir = path.join(tmpDir, ".codex", "sessions", "c");
      fs.mkdirSync(codexDir, { recursive: true });
      writeJsonl(path.join(codexDir, "rollout-2.jsonl"), [
        { type: "session_meta", payload: { cwd: "/w" } },
      ]);
      fs.symlinkSync(path.join(tmpDir, ".codex", "sessions"), path.join(codexDir, "loop"), "dir");

      process.env.TRACEQUEST_NO_SIDECAR = "1";
      const { findSessions } = await import(
        new URL("../../src/sessions/session-index-core.js?" + Date.now(), import.meta.url).href
      );
      const sessions = findSessions();
      const paths = sessions.map((s) => s.path);
      assert.equal(new Set(paths).size, paths.length, "no session is listed twice");
      assert.ok(paths.some((p) => p.endsWith("a.jsonl")), "claude sessions survived");
      assert.ok(paths.some((p) => p.endsWith("rollout-2.jsonl")), "codex sessions survived");
    }));
});

describe("opencode discovery cache stays bounded (fact dqe)", () => {
  test("repeated writes to one database keep exactly one cache entry", () =>
    withTempHome(async (mod, tmpDir) => {
      const { seedOpenCodeDiscoveryDb } = await import("../helpers/opencode-db-fixtures.js");
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [
        { id: "ses_a", directory: "/w/proj", msgCount: 4 },
      ]);

      mod.clearOpenCodeDiscoveryCache();
      for (let i = 0; i < 25; i++) {
        // Each iteration is a new mtime, which is what an active session does.
        const when = new Date(Date.now() + (i + 1) * 60_000);
        fs.utimesSync(dbPath, when, when);
        const out = [];
        mod.findOpenCodeSessions(null, out);
        assert.ok(out.length >= 1, "rows still come back after the cache is invalidated");
      }

      assert.equal(
        mod.openCodeDiscoveryCacheSizeForTests(),
        1,
        "25 distinct mtimes must leave one cached row set, not 25",
      );
    }));
});

describe("an unreadable subagents dir is reported once, not once per scan", () => {
  test("repeated scans warn a single time for the same directory", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir, onCleanup) => {
      const { resetSubagentDirWarningsForTests } = await import(
        new URL("../../src/sessions/claude-subagents.js?" + Date.now(), import.meta.url).href
      );
      const dir = seedReadable(tmpDir);
      const subagents = path.join(dir, "session-y", "subagents");
      fs.mkdirSync(subagents, { recursive: true });
      fs.chmodSync(subagents, 0o000);
      onCleanup(() => fs.chmodSync(subagents, 0o755));

      resetSubagentDirWarningsForTests?.();
      const warnings = [];
      const realWarn = console.warn;
      console.warn = (...args) => warnings.push(args.join(" "));
      try {
        for (let i = 0; i < 5; i++) findClaudeSessions(null, []);
      } finally {
        console.warn = realWarn;
      }

      const forThisDir = warnings.filter((w) => w.includes(subagents));
      assert.ok(
        forThisDir.length <= 1,
        `five scans should not produce five warnings, got ${forThisDir.length}`,
      );
    }));
});
