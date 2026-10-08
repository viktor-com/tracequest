/**
 * Deep coverage for extractCodexProject — session_meta cwd → project label.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function importParseCodex() {
  const modUrl = new URL("../../src/parse/parse-codex.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-extract-codex-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  return (async () => {
    try {
      const mod = await importParseCodex();
      return await fn(mod, tmpDir);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
}

function rolloutFile(tmpDir, name = "rollout-edge.jsonl") {
  const dir = path.join(tmpDir, ".codex", "sessions", "fixture");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function writeSessionMeta(file, cwd) {
  const line = JSON.stringify({ type: "session_meta", payload: { cwd } });
  fs.writeFileSync(file, line + "\n");
}

describe("discoverCodexSessionMeta", () => {
  test("returns project, size, and mtime in one read", () =>
    withTempHome(async ({ discoverCodexSessionMeta, extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      const cwd = path.join(tmpDir, "code", "tracequest");
      writeSessionMeta(file, cwd);
      const st = fs.statSync(file);
      const meta = discoverCodexSessionMeta(file);
      assert.equal(meta.project, extractCodexProject(file));
      assert.equal(meta.project, "tracequest");
      assert.equal(meta.size, st.size);
      assert.equal(meta.mtime.getTime(), st.mtime.getTime());
    }));
});

describe("extractCodexProject path parsing", () => {
  test("maps cwd under ~/code to short project label", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      const cwd = path.join(tmpDir, "code", "tracequest");
      writeSessionMeta(file, cwd);
      assert.equal(extractCodexProject(file), "tracequest");
    }));

  test("uses last folder segment for nested paths under ~/code", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      const cwd = path.join(tmpDir, "code", "foo", "bar");
      writeSessionMeta(file, cwd);
      assert.equal(extractCodexProject(file), "bar");
    }));

  test("uses last folder segment for other home-relative cwd paths", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      const cwd = path.join(tmpDir, "projects", "app");
      writeSessionMeta(file, cwd);
      assert.equal(extractCodexProject(file), "app");
    }));

  test("returns (unknown) when cwd is empty string (falsy payload.cwd)", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      writeSessionMeta(file, "");
      assert.equal(extractCodexProject(file), "(unknown)");
    }));

  test("returns (unknown) when session_meta has no cwd in payload", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: {} }) + "\n");
      assert.equal(extractCodexProject(file), "(unknown)");
    }));

  test("returns codex when first line is not session_meta", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      fs.writeFileSync(file, JSON.stringify({ type: "event", payload: { cwd: "/ignored" } }) + "\n");
      assert.equal(extractCodexProject(file), "codex");
    }));

  test("returns codex on invalid JSON in first line", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      fs.writeFileSync(file, "not-json\n");
      assert.equal(extractCodexProject(file), "codex");
    }));

  test("returns codex when rollout file is missing", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const missing = path.join(tmpDir, ".codex", "sessions", "nope", "rollout-missing.jsonl");
      assert.equal(extractCodexProject(missing), "codex");
    }));

  test("returns codex for empty rollout file", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir, "rollout-empty.jsonl");
      fs.writeFileSync(file, "");
      assert.equal(extractCodexProject(file), "codex");
    }));

  test("reads only the first line when later lines differ", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      const cwd = path.join(tmpDir, "code", "first");
      const first = JSON.stringify({ type: "session_meta", payload: { cwd } });
      const second = JSON.stringify({
        type: "session_meta",
        payload: { cwd: path.join(tmpDir, "code", "second") },
      });
      fs.writeFileSync(file, first + "\n" + second + "\n");
      assert.equal(extractCodexProject(file), "first");
    }));

  test("parses session_meta when first line has no trailing newline", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir, "rollout-no-nl.jsonl");
      const cwd = path.join(tmpDir, "code", "nonl");
      fs.writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { cwd } }));
      assert.equal(extractCodexProject(file), "nonl");
    }));

  test("uses folder name when cwd is exactly ~/code", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir);
      const cwd = path.join(tmpDir, "code");
      writeSessionMeta(file, cwd);
      assert.equal(extractCodexProject(file), "code");
    }));

  test("uses last folder segment for absolute paths outside HOME", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir, "rollout-abs.jsonl");
      writeSessionMeta(file, "/var/tmp/worktree");
      assert.equal(extractCodexProject(file), "worktree");
    }));
});

describe("extractCodexProject robustness", () => {
  test("missing rollout file returns codex without logging", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const missing = path.join(tmpDir, ".codex", "sessions", "nope", "rollout-missing.jsonl");
      const errors = [];
      const origError = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        assert.equal(extractCodexProject(missing), "codex");
        assert.equal(errors.length, 0);
      } finally {
        console.error = origError;
      }
    }));

  test("logs and returns codex when rollout file exists but is unreadable", () =>
    withTempHome(async ({ extractCodexProject }, tmpDir) => {
      const file = rolloutFile(tmpDir, "rollout-locked.jsonl");
      writeSessionMeta(file, path.join(tmpDir, "code", "locked-proj"));
      const errors = [];
      const origError = console.error;
      console.error = (...args) => errors.push(args.join(" "));
      try {
        fs.chmodSync(file, 0o000);
        assert.equal(extractCodexProject(file), "codex");
        assert.equal(errors.length, 1);
        assert.match(errors[0], /extractCodexProject: failed to read/);
        assert.match(errors[0], /rollout-locked\.jsonl/);
      } finally {
        fs.chmodSync(file, 0o644);
        console.error = origError;
      }
    }));
});