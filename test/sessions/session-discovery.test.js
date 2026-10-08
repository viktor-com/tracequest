import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { claudeProj, writeJsonl } from "../helpers/fixtures.js";
import { seedOpenCodeDiscoveryDb } from "../helpers/opencode-db-fixtures.js";
import { assertPerf } from "../helpers/perf-assert.js";

function importDiscovery() {
  const modUrl = new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  return (async () => {
    try {
      const mod = await importDiscovery();
      return await fn(mod, tmpDir);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
}

describe("session-discovery findClaudeSessions", () => {
  test("returns empty when .claude/projects is missing", () =>
    withTempHome(async ({ findClaudeSessions }) => {
      const out = [];
      findClaudeSessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("discovers top-level jsonl in project directory", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const dir = claudeProj(tmpDir, "myproj");
      const mainFile = path.join(dir, "main.jsonl");
      writeJsonl(mainFile);
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "main.jsonl");
      assert.equal(out[0].source, "claude");
      assert.equal(out[0].project, "myproj");
      assert.equal(out[0].path, mainFile);
    }));

  test("discovers subagent jsonl under parent-session/subagents", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const projDir = claudeProj(tmpDir, "myproj");
      const subDir = path.join(projDir, "parent-session", "subagents");
      fs.mkdirSync(subDir, { recursive: true });
      const subFile = path.join(subDir, "sub.jsonl");
      writeJsonl(subFile);
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "sub.jsonl");
      assert.equal(out[0].parentSession, "parent-session");
    }));

  test("discovers both top-level and subagent sessions together", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const projDir = claudeProj(tmpDir, "combo");
      writeJsonl(path.join(projDir, "root.jsonl"));
      writeJsonl(path.join(projDir, "sess-a", "subagents", "agent.jsonl"));
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 2);
      assert.ok(out.some((s) => s.file === "root.jsonl" && !s.parentSession));
      assert.ok(out.some((s) => s.file === "agent.jsonl" && s.parentSession === "sess-a"));
    }));

  test("ignores non-jsonl files in project root", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const dir = claudeProj(tmpDir, "p");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");
      fs.writeFileSync(path.join(dir, "data.json"), "{}");
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("ignores session directories without subagents folder", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const dir = claudeProj(tmpDir, "p");
      const orphan = path.join(dir, "orphan-dir");
      fs.mkdirSync(orphan, { recursive: true });
      writeJsonl(path.join(orphan, "hidden.jsonl"));
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("skips non-jsonl files inside subagents", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const subDir = path.join(claudeProj(tmpDir, "p"), "parent", "subagents");
      fs.mkdirSync(subDir, { recursive: true });
      fs.writeFileSync(path.join(subDir, "readme.md"), "#");
      writeJsonl(path.join(subDir, "ok.jsonl"));
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "ok.jsonl");
    }));

  test("discovers multiple projects independently", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      writeJsonl(path.join(claudeProj(tmpDir, "alpha"), "a.jsonl"));
      writeJsonl(path.join(claudeProj(tmpDir, "beta"), "b.jsonl"));
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 2);
      assert.deepEqual(new Set(out.map((s) => s.project)), new Set(["alpha", "beta"]));
    }));

  test("discovers multiple jsonl files in one project", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const dir = claudeProj(tmpDir, "multi");
      writeJsonl(path.join(dir, "one.jsonl"));
      writeJsonl(path.join(dir, "two.jsonl"));
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 2);
      assert.deepEqual(new Set(out.map((s) => s.file)), new Set(["one.jsonl", "two.jsonl"]));
    }));

  test("applies projectFilter as substring on directory name", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      writeJsonl(path.join(claudeProj(tmpDir, "alpha-proj"), "s.jsonl"));
      writeJsonl(path.join(claudeProj(tmpDir, "beta-proj"), "s.jsonl"));
      const out = [];
      findClaudeSessions("alpha", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, "alpha-proj");
    }));

  test("projectFilter with no match returns empty", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      writeJsonl(path.join(claudeProj(tmpDir, "only"), "s.jsonl"));
      const out = [];
      findClaudeSessions("zzz-nomatch", out);
      assert.equal(out.length, 0);
    }));

  test("empty project directory yields no sessions", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      fs.mkdirSync(claudeProj(tmpDir, "empty"), { recursive: true });
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("includes size and mtime from file stat", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      const file = path.join(claudeProj(tmpDir, "stat"), "s.jsonl");
      writeJsonl(file, '{"x":1}');
      const st = fs.statSync(file);
      const out = [];
      findClaudeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].size, st.size);
      assert.equal(out[0].mtime.getTime(), st.mtime.getTime());
    }));

  test("reuses out array when passed in", () =>
    withTempHome(async ({ findClaudeSessions }, tmpDir) => {
      writeJsonl(path.join(claudeProj(tmpDir, "reuse"), "s.jsonl"));
      const out = [{ path: "seed" }];
      const ret = findClaudeSessions(null, out);
      assert.equal(ret, out);
      assert.equal(out.length, 2);
    }));
});

describe("session-discovery findCursorSessions", () => {
  function cursorProj(tmpDir, name) {
    return path.join(tmpDir, ".cursor", "projects", name);
  }

  test("returns empty when .cursor/projects is missing", () =>
    withTempHome(async ({ findCursorSessions }) => {
      const out = [];
      findCursorSessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("discovers cursor jsonl in agent-transcripts directory", () =>
    withTempHome(async ({ findCursorSessions }, tmpDir) => {
      const uuid = "abc12345-1234-5678-9abc-def012345678";
      const mainFile = path.join(cursorProj(tmpDir, "cursorproj"), "agent-transcripts", uuid, uuid + ".jsonl");
      writeJsonl(mainFile);
      const out = [];
      findCursorSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, uuid + ".jsonl");
      assert.equal(out[0].source, "cursor");
      assert.equal(out[0].project, "cursorproj");
      assert.equal(out[0].path, mainFile);
    }));

  test("discovers Cursor subagent jsonl under agent-transcripts/uuid/subagents", () =>
    withTempHome(async ({ findCursorSessions }, tmpDir) => {
      const uuid = "parent-uuid-1234";
      const subFile = path.join(cursorProj(tmpDir, "cursorproj"), "agent-transcripts", uuid, "subagents", "sub.jsonl");
      writeJsonl(subFile);
      const out = [];
      findCursorSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].source, "cursor");
      assert.equal(out[0].file, "sub.jsonl");
      assert.equal(out[0].parentSession, uuid);
    }));

  test("applies projectFilter as substring on Cursor project directory name", () =>
    withTempHome(async ({ findCursorSessions }, tmpDir) => {
      const uuid1 = "a1111111-1111-1111-1111-111111111111";
      const uuid2 = "b2222222-2222-2222-2222-222222222222";
      writeJsonl(path.join(cursorProj(tmpDir, "cursor-alpha"), "agent-transcripts", uuid1, uuid1 + ".jsonl"));
      writeJsonl(path.join(cursorProj(tmpDir, "cursor-beta"), "agent-transcripts", uuid2, uuid2 + ".jsonl"));
      const out = [];
      findCursorSessions("alpha", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, "cursor-alpha");
    }));
});

describe("session-discovery findCursorCloudSessions", () => {
  function cursorCloudRoot(tmpDir) {
    return path.join(tmpDir, ".local", "share", "tracequest", "cursor-cloud");
  }

  test("returns empty when the cursor-cloud root is missing", () =>
    withTempHome(async ({ findCursorCloudSessions }) => {
      const out = [];
      findCursorCloudSessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("discovers cursor-cloud jsonl under the cursor-cloud root", () =>
    withTempHome(async ({ findCursorCloudSessions }, tmpDir) => {
      const agentFile = path.join(cursorCloudRoot(tmpDir), "org-repo", "bc-0a1b2c3d.jsonl");
      writeJsonl(agentFile, [
        { type: "session_meta", bcId: "bc-0a1b2c3d", name: "Cloud run", status: "FINISHED", createdAt: "2026-07-01T00:00:00Z" },
        { role: "user", message: { content: [{ type: "text", text: "cloud discovery prompt" }] } },
      ]);
      const out = [];
      findCursorCloudSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].source, "cursor-cloud");
      assert.equal(out[0].project, "org-repo");
      assert.equal(out[0].file, "bc-0a1b2c3d.jsonl");
      assert.equal(out[0].path, agentFile);
      assert.ok(out[0].size > 0);
      assert.ok(out[0].mtime instanceof Date);
    }));

  test("applies projectFilter as substring on the project slug", () =>
    withTempHome(async ({ findCursorCloudSessions }, tmpDir) => {
      writeJsonl(path.join(cursorCloudRoot(tmpDir), "org-alpha", "bc-a.jsonl"));
      writeJsonl(path.join(cursorCloudRoot(tmpDir), "org-beta", "bc-b.jsonl"));
      const out = [];
      findCursorCloudSessions("alpha", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, "org-alpha");
    }));
});

describe("session-discovery findCodexSessions", () => {
  function codexDir(tmpDir, ...parts) {
    return path.join(tmpDir, ".codex", "sessions", ...parts);
  }

  function writeRollout(filePath, cwd) {
    const payload = cwd === undefined ? {} : { cwd };
    fs.writeFileSync(filePath, JSON.stringify({ type: "session_meta", payload }) + "\n");
    return filePath;
  }

  function assertProjectLabels(out, extractCodexProject) {
    for (const row of out) {
      assert.equal(row.project, extractCodexProject(row.path), `project for ${row.file}`);
    }
  }

  test("returns empty when .codex/sessions is missing", () =>
    withTempHome(async ({ findCodexSessions }) => {
      const out = [];
      findCodexSessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("returns empty for empty sessions tree", () =>
    withTempHome(async ({ findCodexSessions }, tmpDir) => {
      fs.mkdirSync(codexDir(tmpDir), { recursive: true });
      const out = [];
      findCodexSessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("walks nested dirs and reads cwd from session_meta", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const nested = codexDir(tmpDir, "2026", "06");
      const codexFile = path.join(nested, "rollout-abc.jsonl");
      const cwd = path.join(tmpDir, "my-repo");
      fs.mkdirSync(nested, { recursive: true });
      fs.writeFileSync(
        codexFile,
        JSON.stringify({ type: "session_meta", payload: { cwd } }) + "\n"
      );
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].path, codexFile);
      assert.equal(out[0].source, "codex");
      assert.equal(out[0].project, extractCodexProject(codexFile));
    }));

  test("walks three or more directory levels", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const deep = codexDir(tmpDir, "a", "b", "c");
      fs.mkdirSync(deep, { recursive: true });
      const file = writeRollout(path.join(deep, "rollout-deep.jsonl"), tmpDir);
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "rollout-deep.jsonl");
      assert.equal(out[0].project, extractCodexProject(file));
    }));

  test("discovers multiple rollout files in one directory", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const dir = codexDir(tmpDir, "batch");
      fs.mkdirSync(dir, { recursive: true });
      for (const id of ["one", "two"]) {
        writeRollout(path.join(dir, `rollout-${id}.jsonl`), tmpDir);
      }
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 2);
      assertProjectLabels(out, extractCodexProject);
    }));

  test("ignores non-rollout jsonl files", () =>
    withTempHome(async ({ findCodexSessions }, tmpDir) => {
      const root = codexDir(tmpDir);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "other.jsonl"), "{}");
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("ignores jsonl files not prefixed with rollout-", () =>
    withTempHome(async ({ findCodexSessions }, tmpDir) => {
      const root = codexDir(tmpDir);
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "session-x.jsonl"), "{}");
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("projectFilter matches extracted project substring", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const dir = codexDir(tmpDir, "filter");
      fs.mkdirSync(dir, { recursive: true });
      const cwd = path.join(tmpDir, "code", "match-me");
      const file = writeRollout(path.join(dir, "rollout-a.jsonl"), cwd);
      const out = [];
      findCodexSessions("match-me", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, extractCodexProject(file));
      assert.equal(out[0].project, "match-me");
    }));

  test("projectFilter excludes non-matching projects", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const dir = codexDir(tmpDir, "filter");
      fs.mkdirSync(dir, { recursive: true });
      const cwd = path.join(tmpDir, "code", "visible-proj");
      const file = writeRollout(path.join(dir, "rollout-a.jsonl"), cwd);
      assert.equal(extractCodexProject(file), "visible-proj");
      const out = [];
      findCodexSessions("nomatch-xyz", out);
      assert.equal(out.length, 0);
    }));

  test("defaults project to (unknown) when session_meta lacks cwd", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const dir = codexDir(tmpDir, "fallback");
      fs.mkdirSync(dir, { recursive: true });
      const file = writeRollout(path.join(dir, "rollout-nocwd.jsonl"), undefined);
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, "(unknown)");
      assert.equal(out[0].project, extractCodexProject(file));
    }));

  test("assigns distinct project labels per rollout cwd", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const dir = codexDir(tmpDir, "labels");
      fs.mkdirSync(dir, { recursive: true });
      writeRollout(path.join(dir, "rollout-a.jsonl"), path.join(tmpDir, "code", "alpha"));
      writeRollout(path.join(dir, "rollout-b.jsonl"), path.join(tmpDir, "code", "beta"));
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 2);
      assertProjectLabels(out, extractCodexProject);
      assert.deepEqual(
        out.map((r) => r.project).sort(),
        ["alpha", "beta"]
      );
    }));

  test("uses codex fallback label when first line is not session_meta", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const dir = codexDir(tmpDir, "badmeta");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, "rollout-bad.jsonl");
      fs.writeFileSync(file, JSON.stringify({ type: "event" }) + "\n");
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, extractCodexProject(file));
      assert.equal(out[0].project, "codex");
    }));

  test("includes file size and mtime on discovered rows", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const statDir = codexDir(tmpDir, "stat");
      fs.mkdirSync(statDir, { recursive: true });
      const file = writeRollout(path.join(statDir, "rollout-stat.jsonl"), tmpDir);
      const st = fs.statSync(file);
      const out = [];
      findCodexSessions(null, out);
      assert.equal(out[0].size, st.size);
      assert.equal(out[0].mtime.getTime(), st.mtime.getTime());
      assert.equal(out[0].project, extractCodexProject(file));
    }));

  test("reuses out array when passed in", () =>
    withTempHome(async ({ findCodexSessions, extractCodexProject }, tmpDir) => {
      const reuseDir = codexDir(tmpDir, "r");
      fs.mkdirSync(reuseDir, { recursive: true });
      const file = writeRollout(path.join(reuseDir, "rollout-r.jsonl"), tmpDir);
      const out = [];
      const ret = findCodexSessions(null, out);
      assert.equal(ret, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, extractCodexProject(file));
    }));

  test("findCodexSessions scales with single open per rollout file", () =>
    withTempHome(async ({ findCodexSessions }, tmpDir) => {
      const COUNT = 200;
      const root = codexDir(tmpDir, "perf");
      fs.mkdirSync(root, { recursive: true });
      const cwd = path.join(tmpDir, "code", "perf-proj");
      for (let i = 0; i < COUNT; i++) {
        writeRollout(path.join(root, `rollout-${i}.jsonl`), cwd);
      }
      const ITERS = 5;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const out = [];
        findCodexSessions(null, out);
        assert.equal(out.length, COUNT);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 250,
        `expected findCodexSessions under 250ms for ${COUNT} rollouts, got ${ms.toFixed(1)}ms`,
      );
    }));
});

describe("session-discovery findFactorySessions", () => {
  function factoryWs(tmpDir, slug, ...files) {
    const dir = path.join(tmpDir, ".factory", "sessions", slug);
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.writeFileSync(path.join(dir, f), "{}");
    return dir;
  }

  test("returns empty when .factory/sessions is missing", () =>
    withTempHome(async ({ findFactorySessions }) => {
      const out = [];
      findFactorySessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("discovers factory workspace jsonl files", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      const ws = factoryWs(tmpDir, "ws-home-user-code-myproj", "run.jsonl");
      const factoryFile = path.join(ws, "run.jsonl");
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].path, factoryFile);
      assert.equal(out[0].source, "factory");
      assert.ok(out[0].project);
    }));

  test("projectLabel extracts -code- suffix from workspace slug", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "ws-home-dev-code-tracequest", "a.jsonl");
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out[0].project, "tracequest");
    }));

  test("discovers multiple workspaces", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "ws-a", "a.jsonl");
      factoryWs(tmpDir, "ws-b", "b.jsonl");
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out.length, 2);
    }));

  test("discovers multiple jsonl files in one workspace", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "ws-multi", "one.jsonl", "two.jsonl");
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out.length, 2);
      assert.deepEqual(new Set(out.map((s) => s.file)), new Set(["one.jsonl", "two.jsonl"]));
    }));

  test("ignores non-jsonl files in workspace", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      const dir = factoryWs(tmpDir, "ws-skip");
      fs.writeFileSync(path.join(dir, "notes.txt"), "x");
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("empty workspace directory yields no sessions", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      fs.mkdirSync(path.join(tmpDir, ".factory", "sessions", "ws-empty"), { recursive: true });
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("projectFilter matches derived project label", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "ws-home-user-code-alpha", "s.jsonl");
      factoryWs(tmpDir, "ws-home-user-code-beta", "s.jsonl");
      const out = [];
      findFactorySessions("alpha", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, "alpha");
    }));

  test("projectFilter matches raw workspace slug", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "custom-slug-needle", "s.jsonl");
      const out = [];
      findFactorySessions("custom-slug", out);
      assert.equal(out.length, 1);
    }));

  test("projectFilter with no match returns empty", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "ws-home-user-code-only", "s.jsonl");
      const out = [];
      findFactorySessions("zzz-nomatch", out);
      assert.equal(out.length, 0);
    }));

  test("falls back to factory project when slug has no -code- suffix", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "plain-ws", "s.jsonl");
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out[0].project, "plain-ws");
    }));

  test("includes size and mtime from file stat", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      const file = path.join(factoryWs(tmpDir, "ws-stat"), "s.jsonl");
      fs.writeFileSync(file, "0123456789");
      const st = fs.statSync(file);
      const out = [];
      findFactorySessions(null, out);
      assert.equal(out[0].size, st.size);
      assert.equal(out[0].mtime.getTime(), st.mtime.getTime());
    }));

  test("reuses out array when passed in", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      factoryWs(tmpDir, "ws-reuse", "s.jsonl");
      const out = [];
      const ret = findFactorySessions(null, out);
      assert.equal(ret, out);
      assert.equal(out.length, 1);
    }));

  test("projectFilter excludes workspace before inner readdir", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      const included = factoryWs(tmpDir, "ws-home-user-code-alpha", "a.jsonl");
      const excluded = factoryWs(tmpDir, "ws-home-user-code-beta", "b.jsonl");
      fs.writeFileSync(path.join(excluded, "trap.jsonl"), "{}", { flag: "wx" });
      const out = [];
      findFactorySessions("alpha", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].path, path.join(included, "a.jsonl"));
    }));

  test("findFactorySessions scales with single stat per jsonl file", () =>
    withTempHome(async ({ findFactorySessions }, tmpDir) => {
      const COUNT = 200;
      const ws = factoryWs(tmpDir, "ws-home-user-code-perf");
      for (let i = 0; i < COUNT; i++) {
        fs.writeFileSync(path.join(ws, `run-${i}.jsonl`), "{}");
      }
      const ITERS = 5;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const out = [];
        findFactorySessions(null, out);
        assert.equal(out.length, COUNT);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 200,
        `expected findFactorySessions under 200ms for ${COUNT} jsonl files, got ${ms.toFixed(1)}ms`,
      );
    }));
});

describe("session-discovery findGrokSessions", () => {
  function grokWs(tmpDir, wsName) {
    return path.join(tmpDir, ".grok", "sessions", wsName);
  }

  function grokSession(wsDir, sessionId, withChat = true) {
    const dir = path.join(wsDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    if (withChat) fs.writeFileSync(path.join(dir, "chat_history.jsonl"), '{"type":"user"}\n');
    return dir;
  }

  test("returns empty when .grok/sessions is missing", () =>
    withTempHome(async ({ findGrokSessions }) => {
      const out = [];
      findGrokSessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("requires chat_history.jsonl in session directory", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const ws = grokWs(tmpDir, encodeURIComponent("/tmp/grok-ws"));
      grokSession(ws, "sess-a", true);
      grokSession(ws, "sess-b", false);
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "sess-a");
      assert.equal(out[0].source, "grok");
    }));

  test("ignores session dirs without chat_history.jsonl", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const ws = grokWs(tmpDir, "ws-plain");
      grokSession(ws, "empty", false);
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("discovers multiple sessions in one workspace", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const ws = grokWs(tmpDir, "ws-multi");
      grokSession(ws, "s1", true);
      grokSession(ws, "s2", true);
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out.length, 2);
      assert.deepEqual(new Set(out.map((s) => s.file)), new Set(["s1", "s2"]));
    }));

  test("discovers sessions across multiple workspaces", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      grokSession(grokWs(tmpDir, "ws-a"), "sa", true);
      grokSession(grokWs(tmpDir, "ws-b"), "sb", true);
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out.length, 2);
    }));

  test("path points at session directory not chat file", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const ws = grokWs(tmpDir, "ws-path");
      const sessDir = grokSession(ws, "sid", true);
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out[0].path, sessDir);
      assert.ok(!out[0].path.endsWith("chat_history.jsonl"));
    }));

  test("project derived from decodeURIComponent of workspace name", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const decoded = path.join(tmpDir, "code", "grokapp");
      const ws = grokWs(tmpDir, encodeURIComponent(decoded));
      grokSession(ws, "s1", true);
      const out = [];
      findGrokSessions(null, out);
      assert.ok(out[0].project.includes("grokapp") || out[0].project === "grokapp");
    }));

  test("projectFilter matches decoded workspace path segment", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const matchPath = path.join(tmpDir, "code", "filter-hit");
      const missPath = path.join(tmpDir, "code", "filter-miss");
      grokSession(grokWs(tmpDir, encodeURIComponent(matchPath)), "s", true);
      grokSession(grokWs(tmpDir, encodeURIComponent(missPath)), "s", true);
      const out = [];
      findGrokSessions("filter-hit", out);
      assert.equal(out.length, 1);
    }));

  test("projectFilter matches encoded workspace directory name", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const wsName = "needle-encoded-ws";
      grokSession(grokWs(tmpDir, wsName), "s", true);
      const out = [];
      findGrokSessions("needle-encoded", out);
      assert.equal(out.length, 1);
    }));

  test("projectFilter with no match returns empty", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      grokSession(grokWs(tmpDir, "ws-only"), "s", true);
      const out = [];
      findGrokSessions("zzz-nomatch", out);
      assert.equal(out.length, 0);
    }));

  test("uses chat_history.jsonl stat for size and mtime", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const ws = grokWs(tmpDir, "ws-stat");
      const dir = grokSession(ws, "stat-sess", true);
      const chat = path.join(dir, "chat_history.jsonl");
      fs.writeFileSync(chat, "x".repeat(20));
      const st = fs.statSync(chat);
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out[0].size, st.size);
      assert.equal(out[0].mtime.getTime(), st.mtime.getTime());
    }));

  test("ignores jsonl files placed directly under workspace", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      const ws = grokWs(tmpDir, "ws-root-file");
      fs.mkdirSync(ws, { recursive: true });
      fs.writeFileSync(path.join(ws, "chat_history.jsonl"), "{}\n");
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out.length, 0);
    }));

  test("reuses out array when passed in", () =>
    withTempHome(async ({ findGrokSessions }, tmpDir) => {
      grokSession(grokWs(tmpDir, "ws-reuse"), "s", true);
      const out = [];
      const ret = findGrokSessions(null, out);
      assert.equal(ret, out);
      assert.equal(out.length, 1);
    }));
});

describe("session-discovery findOpenCodeSessions", () => {
  test("returns empty when DB is missing", () =>
    withTempHome(async ({ findOpenCodeSessions }) => {
      const out = [];
      findOpenCodeSessions(null, out);
      assert.deepEqual(out, []);
    }));

  test("queries SQLite and caches rows by DB mtime", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-opencode-disc-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "oc-1", msgCount: 3 }]);
      const { findOpenCodeSessions, clearOpenCodeDiscoveryCache } = await importDiscovery();

      const out1 = [];
      findOpenCodeSessions(null, out1);
      assert.equal(out1.length, 1);
      assert.equal(out1[0].source, "opencode");
      assert.equal(out1[0].file, "oc-1");
      assert.equal(out1[0].path, "opencode://oc-1");

      const origStat = fs.statSync(dbPath);
      const { DatabaseSync } = await import("node:sqlite");
      const db2 = new DatabaseSync(dbPath);
      const s2 = db2.prepare(
        `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
      );
      const m2 = db2.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
      s2.run("oc-2", "Second", "/tmp/ocproj", "1.0", 1715731300, 1715731300);
      for (let i = 0; i < 3; i++) m2.run("oc-2", "user", "hi");
      db2.close();
      fs.utimesSync(dbPath, origStat.atime, origStat.mtime);

      const out2 = [];
      findOpenCodeSessions(null, out2);
      assert.equal(out2.length, 1, "mtime cache must skip re-query when DB mtime unchanged");
      assert.equal(out2[0].file, "oc-1");

      clearOpenCodeDiscoveryCache();
      fs.unlinkSync(dbPath);
      const out3 = [];
      findOpenCodeSessions(null, out3);
      assert.equal(out3.length, 0);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("filters out sessions with fewer than 3 messages", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [
        { id: "few", msgCount: 2 },
        { id: "enough", msgCount: 3 },
      ]);
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "enough");
    }));

  test("includes sessions with exactly 3 messages", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "exact", msgCount: 3 }]);
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].size, 3 * 1024);
    }));

  test("returns multiple qualifying sessions", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [
        { id: "oc-a", msgCount: 3 },
        { id: "oc-b", msgCount: 4 },
      ]);
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out.length, 2);
    }));

  test("projectFilter matches directory path", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [
        { id: "hit", directory: path.join(tmpDir, "code", "needle-proj"), msgCount: 3 },
        { id: "miss", directory: "/tmp/other", msgCount: 3 },
      ]);
      const out = [];
      findOpenCodeSessions("needle-proj", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "hit");
    }));

  test("projectFilter matches shortened project label", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [
        { id: "lbl", directory: path.join(tmpDir, "code", "myapp"), msgCount: 3 },
      ]);
      const out = [];
      findOpenCodeSessions("myapp", out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, "myapp");
    }));

  test("projectFilter with no match returns empty", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "x", msgCount: 3 }]);
      const out = [];
      findOpenCodeSessions("zzz-nomatch", out);
      assert.equal(out.length, 0);
    }));

  test("includes title from session row", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "titled", title: "My OpenCode Session", msgCount: 3 }]);
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out[0].title, "My OpenCode Session");
    }));

  test("mtime prefers time_updated over time_created", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [
        {
          id: "times",
          time_created: 1000,
          time_updated: 2000,
          msgCount: 3,
        },
      ]);
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out[0].mtime.getTime(), 2000);
    }));

  test("clearOpenCodeDiscoveryCache forces fresh query after DB change", () =>
    withTempHome(async ({ findOpenCodeSessions, clearOpenCodeDiscoveryCache }, tmpDir) => {
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "first", msgCount: 3 }]);
      const out1 = [];
      findOpenCodeSessions(null, out1);
      assert.equal(out1.length, 1);

      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.prepare(
        `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("second", "S2", "/tmp/x", "1", 3000, 3000);
      const m = db.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
      for (let i = 0; i < 3; i++) m.run("second", "user", "m");
      db.close();

      clearOpenCodeDiscoveryCache();
      const out2 = [];
      findOpenCodeSessions(null, out2);
      assert.equal(out2.length, 2);
    }));

  test("reuses out array when passed in", () =>
    withTempHome(async ({ findOpenCodeSessions }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "reuse", msgCount: 3 }]);
      const out = [];
      const ret = findOpenCodeSessions(null, out);
      assert.equal(ret, out);
      assert.equal(out.length, 1);
    }));

  test("findOpenCodeSessions uses single grouped query for message counts", () =>
    withTempHome(async ({ findOpenCodeSessions, clearOpenCodeDiscoveryCache }, tmpDir) => {
      const COUNT = 500;
      const sessions = [];
      for (let i = 0; i < COUNT; i++) {
        sessions.push({
          id: `oc-perf-${i}`,
          msgCount: 5,
          time_updated: 1_700_000_000 + i,
        });
      }
      await seedOpenCodeDiscoveryDb(tmpDir, sessions);
      clearOpenCodeDiscoveryCache();

      const ITERS = 5;
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const out = [];
        findOpenCodeSessions(null, out);
        assert.equal(out.length, COUNT);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 120,
        `expected findOpenCodeSessions under 120ms for ${COUNT} sessions, got ${ms.toFixed(1)}ms`,
      );
    }));
});

describe("session-discovery discoverSessions", () => {
  test("findOpenCodeSessions uses shared paths.openCodeDb without default DB path", () =>
    withTempHome(async ({ findOpenCodeSessions, getDiscoveryPaths }, tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "shared-path-oc", msgCount: 3 }]);
      const defaultDb = path.join(tmpDir, ".local", "share", "opencode", "opencode.db");
      const customDb = path.join(tmpDir, "alt", "opencode.db");
      fs.mkdirSync(path.dirname(customDb), { recursive: true });
      fs.copyFileSync(defaultDb, customDb);
      fs.rmSync(defaultDb);

      const paths = { ...getDiscoveryPaths(), openCodeDb: customDb };
      const out = [];
      findOpenCodeSessions(null, out, paths);
      assert.equal(out.length, 1);
      assert.equal(out[0].file, "shared-path-oc");
    }));

  test("aggregates all providers into one array", () =>
    withTempHome(async ({ discoverSessions }, tmpDir) => {
      writeJsonl(path.join(claudeProj(tmpDir, "p1"), "c.jsonl"));
      const cursorUuid = "c1111111-1111-1111-1111-111111111111";
      writeJsonl(path.join(tmpDir, ".cursor", "projects", "p2", "agent-transcripts", cursorUuid, cursorUuid + ".jsonl"));
      writeJsonl(path.join(tmpDir, ".local", "share", "tracequest", "cursor-cloud", "org-repo", "bc-agg.jsonl"));
      const codexRoot = path.join(tmpDir, ".codex", "sessions");
      fs.mkdirSync(codexRoot, { recursive: true });
      fs.writeFileSync(
        path.join(codexRoot, "rollout-x.jsonl"),
        JSON.stringify({ type: "session_meta", payload: { cwd: tmpDir } }) + "\n"
      );
      const factoryWs = path.join(tmpDir, ".factory", "sessions", "ws-factory");
      fs.mkdirSync(factoryWs, { recursive: true });
      fs.writeFileSync(path.join(factoryWs, "f.jsonl"), "{}");
      const grokSess = path.join(tmpDir, ".grok", "sessions", "ws", "g1");
      fs.mkdirSync(grokSess, { recursive: true });
      fs.writeFileSync(path.join(grokSess, "chat_history.jsonl"), "{}\n");

      const sessions = discoverSessions(null, []);
      const sources = new Set(sessions.map((s) => s.source));
      assert.deepEqual(sources, new Set(["claude", "codex", "cursor", "cursor-cloud", "factory", "grok"]));
      assert.equal(sessions.length, 6);
    }));

  test("discoveryRoots lists all provider paths under temp HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const roots = discoveryRoots();
      assert.ok(roots.some((r) => r.includes(".claude")));
      assert.ok(roots.some((r) => r.includes(".codex")));
      assert.ok(roots.some((r) => r.includes(".cursor")));
      assert.ok(roots.some((r) => r.endsWith(path.join("tracequest", "cursor-cloud"))));
      assert.ok(roots.some((r) => r.includes(".factory")));
      assert.ok(roots.some((r) => r.includes(".grok")));
      assert.ok(roots.some((r) => r.endsWith("opencode.db")));
      for (const root of roots) {
        assert.ok(root.startsWith(tmpDir), `root ${root} should be under temp HOME`);
      }
    }));

  test("getDiscoveryPaths resolves lazy paths from HOME", () =>
    withTempHome(async ({ getDiscoveryPaths }, tmpDir) => {
      const p = getDiscoveryPaths();
      assert.equal(p.claudeDir, path.join(tmpDir, ".claude", "projects"));
      assert.equal(p.codexDir, path.join(tmpDir, ".codex", "sessions"));
      assert.equal(p.cursorDir, path.join(tmpDir, ".cursor", "projects"));
      assert.equal(p.cursorCloudDir, path.join(tmpDir, ".local", "share", "tracequest", "cursor-cloud"));
      assert.equal(p.factoryDir, path.join(tmpDir, ".factory", "sessions"));
      assert.equal(p.grokDir, path.join(tmpDir, ".grok", "sessions"));
      assert.ok(p.openCodeDb.endsWith("opencode.db"));
    }));

  test("discoverSessions batch-stat scan stays fast on large provider trees", () =>
    withTempHome(async ({ discoverSessions, clearOpenCodeDiscoveryCache }, tmpDir) => {
      const claudeDir = path.join(tmpDir, ".claude", "projects");
      const cursorDir = path.join(tmpDir, ".cursor", "projects");
      const factoryDir = path.join(tmpDir, ".factory", "sessions");
      const grokDir = path.join(tmpDir, ".grok", "sessions");
      const codexDir = path.join(tmpDir, ".codex", "sessions");
      for (let p = 0; p < 30; p++) {
        const proj = path.join(claudeDir, `proj-${p}`);
        fs.mkdirSync(proj, { recursive: true });
        for (let f = 0; f < 15; f++) writeJsonl(path.join(proj, `sess-${f}.jsonl`));
        for (let s = 0; s < 3; s++) {
          writeJsonl(path.join(proj, `parent-${s}`, "subagents", "sub.jsonl"));
        }
      }
      for (let p = 0; p < 10; p++) {
        const proj = path.join(cursorDir, `cursor-${p}`);
        for (let f = 0; f < 6; f++) {
          const uuid = `cursor-${p}-${f}`;
          writeJsonl(path.join(proj, "agent-transcripts", uuid, uuid + ".jsonl"));
        }
      }
      for (let w = 0; w < 20; w++) {
        const ws = path.join(factoryDir, `ws-home-user-proj-${w}`);
        fs.mkdirSync(ws, { recursive: true });
        for (let f = 0; f < 10; f++) writeJsonl(path.join(ws, `f-${f}.jsonl`));
      }
      for (let w = 0; w < 15; w++) {
        const ws = path.join(grokDir, encodeURIComponent(`/home/user/grok-${w}`));
        fs.mkdirSync(ws, { recursive: true });
        for (let s = 0; s < 8; s++) {
          const sd = path.join(ws, `sess-${s}`);
          fs.mkdirSync(sd);
          fs.writeFileSync(path.join(sd, "chat_history.jsonl"), "{}\n");
        }
      }
      fs.mkdirSync(codexDir, { recursive: true });
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(
          path.join(codexDir, `rollout-${i}.jsonl`),
          JSON.stringify({ type: "session_meta", payload: { cwd: tmpDir } }) + "\n",
        );
      }

      clearOpenCodeDiscoveryCache();
      const ITERS = 15;
      for (let i = 0; i < 2; i++) {
        const warm = [];
        discoverSessions(null, warm);
        assert.equal(warm.length, 30 * 15 + 30 * 3 + 10 * 6 + 20 * 10 + 15 * 8 + 50);
      }
      const t0 = performance.now();
      for (let i = 0; i < ITERS; i++) {
        const out = [];
        discoverSessions(null, out);
        assert.equal(out.length, 30 * 15 + 30 * 3 + 10 * 6 + 20 * 10 + 15 * 8 + 50);
      }
      const ms = (performance.now() - t0) / ITERS;
      assertPerf(
        ms < 12,
        `expected discoverSessions under 12ms/op for ~1k mixed sessions, got ${ms.toFixed(2)}ms`,
      );
    }));
});

describe("session-discovery imported ssh hosts", () => {
  test("stamps host on sessions under the hosts root", () =>
    withTempHome(async ({ discoverSessions, stampImportedHost, resolveHostsRoot }, tmpDir) => {
      const hostsRoot = resolveHostsRoot(tmpDir);
      const file = path.join(hostsRoot, "gpu", ".claude", "projects", "myproj", "sess.jsonl");
      writeJsonl(file, [{ type: "user", message: { content: [{ type: "text", text: "hi" }] } }]);
      const out = [];
      discoverSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].source, "claude");
      stampImportedHost(out[0], hostsRoot);
      assert.equal(out[0].host, "gpu");
      assert.equal(out[0].path, file);
    }));

  test("discovers cursor transcripts under an imported host home", () =>
    withTempHome(async ({ discoverSessions, stampImportedHost, resolveHostsRoot }, tmpDir) => {
      const hostsRoot = resolveHostsRoot(tmpDir);
      const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      const file = path.join(
        hostsRoot,
        "gpu",
        ".cursor",
        "projects",
        "cproj",
        "agent-transcripts",
        uuid,
        `${uuid}.jsonl`,
      );
      writeJsonl(file, [{ role: "user", message: { content: [{ type: "text", text: "cursor remote" }] } }]);
      const out = [];
      discoverSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].source, "cursor");
      stampImportedHost(out[0], hostsRoot);
      assert.equal(out[0].host, "gpu");
    }));

  test("imported OpenCode sessions use host-prefixed URIs", () =>
    withTempHome(async ({ discoverSessions }, tmpDir) => {
      const hostsRoot = path.join(tmpDir, ".local", "share", "tracequest", "hosts");
      const hostHome = path.join(hostsRoot, "gpu");
      const id = "ses_abcdefghijklmnopqrst";
      await seedOpenCodeDiscoveryDb(hostHome, [{ id, title: "Remote OC", msgCount: 3 }]);
      const out = [];
      discoverSessions(null, out);
      const oc = out.filter((s) => s.source === "opencode");
      assert.equal(oc.length, 1);
      assert.equal(oc[0].path, `opencode://gpu/${id}`);
      assert.equal(oc[0].host, "gpu");
      assert.equal(oc[0].file, id);
    }));
});
