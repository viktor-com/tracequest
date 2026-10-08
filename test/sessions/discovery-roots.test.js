import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  CURSOR_CLOUD_ROOT_REL,
  HOSTS_ROOT_REL,
  OPENCODE_DB_REL,
  resolveCursorCloudRoot,
  resolveHostsRoot,
  resolveOpenCodeDbPath,
} from "../../src/sessions/session-discovery-paths.js";

function importDiscovery() {
  const modUrl = new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-roots-"));
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

function expectedRoots(home) {
  return [
    path.join(home, ".claude", "projects"),
    path.join(home, ".codex", "sessions"),
    path.join(home, ".cursor", "projects"),
    resolveCursorCloudRoot(home),
    path.join(home, ".factory", "sessions"),
    path.join(home, ".grok", "sessions"),
    resolveOpenCodeDbPath(home),
  ];
}

describe("discoveryRoots stability under temp HOME", () => {
  test("returns exactly seven provider roots", () =>
    withTempHome(async ({ discoveryRoots }) => {
      const roots = discoveryRoots();
      assert.equal(roots.length, 7);
      assert.ok(roots.every((r) => typeof r === "string" && r.length > 0));
    }));

  test("matches canonical paths derived from temp HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      assert.deepEqual(discoveryRoots(), expectedRoots(tmpDir));
    }));

  test("claude root is .claude/projects under HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const [claude] = discoveryRoots();
      assert.equal(claude, path.join(tmpDir, ".claude", "projects"));
    }));

  test("codex root is .codex/sessions under HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const [, codex] = discoveryRoots();
      assert.equal(codex, path.join(tmpDir, ".codex", "sessions"));
    }));

  test("factory root is .factory/sessions under HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const [, , , , factory] = discoveryRoots();
      assert.equal(factory, path.join(tmpDir, ".factory", "sessions"));
    }));

  test("cursor root is .cursor/projects under HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const [, , cursor] = discoveryRoots();
      assert.equal(cursor, path.join(tmpDir, ".cursor", "projects"));
    }));

  test("cursor-cloud root is .local/share/tracequest/cursor-cloud under HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const [, , , cursorCloud] = discoveryRoots();
      assert.equal(cursorCloud, path.join(tmpDir, ...CURSOR_CLOUD_ROOT_REL));
      assert.equal(cursorCloud, path.join(tmpDir, ".local", "share", "tracequest", "cursor-cloud"));
    }));

  test("TRACEQUEST_CURSOR_CLOUD_DIR overrides the cursor-cloud root", async () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-cursor-cloud-override-"));
    const hadOverride = Object.hasOwn(process.env, "TRACEQUEST_CURSOR_CLOUD_DIR");
    const prevOverride = process.env.TRACEQUEST_CURSOR_CLOUD_DIR;
    process.env.TRACEQUEST_CURSOR_CLOUD_DIR = overrideDir;
    try {
      await withTempHome(async ({ discoveryRoots, getDiscoveryPaths }, tmpDir) => {
        assert.equal(resolveCursorCloudRoot(tmpDir), overrideDir);
        assert.equal(getDiscoveryPaths().cursorCloudDir, overrideDir);
        assert.equal(discoveryRoots()[3], overrideDir);
      });
    } finally {
      if (hadOverride) process.env.TRACEQUEST_CURSOR_CLOUD_DIR = prevOverride;
      else delete process.env.TRACEQUEST_CURSOR_CLOUD_DIR;
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test("grok root is .grok/sessions under HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const [, , , , , grok] = discoveryRoots();
      assert.equal(grok, path.join(tmpDir, ".grok", "sessions"));
    }));

  test("last root is OpenCode SQLite at XDG data layout", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const roots = discoveryRoots();
      const openCode = roots[roots.length - 1];
      assert.equal(openCode, path.join(tmpDir, ...OPENCODE_DB_REL));
      assert.ok(openCode.endsWith("opencode.db"));
    }));

  test("every root path is prefixed by temp HOME", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      for (const root of discoveryRoots()) {
        assert.ok(root.startsWith(tmpDir), `root ${root} should live under ${tmpDir}`);
      }
    }));

  test("aligns with getDiscoveryPaths field order", () =>
    withTempHome(async ({ discoveryRoots, getDiscoveryPaths }) => {
      const p = getDiscoveryPaths();
      assert.deepEqual(discoveryRoots(), [p.claudeDir, p.codexDir, p.cursorDir, p.cursorCloudDir, p.factoryDir, p.grokDir, p.openCodeDb]);
    }));

  test("repeated calls return identical arrays when HOME is unchanged", () =>
    withTempHome(async ({ discoveryRoots }) => {
      const a = discoveryRoots();
      const b = discoveryRoots();
      assert.deepEqual(b, a);
      assert.notEqual(b, a, "each call should return a fresh array");
    }));

  test("hosts root is .local/share/tracequest/hosts under HOME", () =>
    withTempHome(async (_mod, tmpDir) => {
      assert.equal(resolveHostsRoot(tmpDir), path.join(tmpDir, ...HOSTS_ROOT_REL));
    }));

  test("TRACEQUEST_HOSTS_DIR overrides the hosts root", async () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-hosts-override-"));
    const hadOverride = Object.hasOwn(process.env, "TRACEQUEST_HOSTS_DIR");
    const prevOverride = process.env.TRACEQUEST_HOSTS_DIR;
    process.env.TRACEQUEST_HOSTS_DIR = overrideDir;
    try {
      await withTempHome(async ({ discoveryRoots }, tmpDir) => {
        assert.equal(resolveHostsRoot(tmpDir), overrideDir);
        fs.mkdirSync(path.join(overrideDir, "gpu"));
        const roots = discoveryRoots();
        assert.equal(roots.length, 13);
        assert.ok(roots.includes(path.join(overrideDir, "gpu", ".claude", "projects")));
      });
    } finally {
      if (hadOverride) process.env.TRACEQUEST_HOSTS_DIR = prevOverride;
      else delete process.env.TRACEQUEST_HOSTS_DIR;
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test("appends six roots per imported host after the local seven", () =>
    withTempHome(async ({ discoveryRoots }, tmpDir) => {
      const hostsRoot = path.join(tmpDir, ...HOSTS_ROOT_REL);
      fs.mkdirSync(path.join(hostsRoot, "alpha"), { recursive: true });
      fs.mkdirSync(path.join(hostsRoot, "gpu"), { recursive: true });
      const roots = discoveryRoots();
      assert.equal(roots.length, 19);
      assert.deepEqual(roots.slice(0, 7), expectedRoots(tmpDir));
      const extra = roots.slice(7);
      assert.deepEqual(extra, [
        path.join(hostsRoot, "alpha", ".claude", "projects"),
        path.join(hostsRoot, "alpha", ".cursor", "projects"),
        path.join(hostsRoot, "alpha", ".codex", "sessions"),
        path.join(hostsRoot, "alpha", ".factory", "sessions"),
        path.join(hostsRoot, "alpha", ".grok", "sessions"),
        path.join(hostsRoot, "alpha", ".local", "share", "opencode", "opencode.db"),
        path.join(hostsRoot, "gpu", ".claude", "projects"),
        path.join(hostsRoot, "gpu", ".cursor", "projects"),
        path.join(hostsRoot, "gpu", ".codex", "sessions"),
        path.join(hostsRoot, "gpu", ".factory", "sessions"),
        path.join(hostsRoot, "gpu", ".grok", "sessions"),
        path.join(hostsRoot, "gpu", ".local", "share", "opencode", "opencode.db"),
      ]);
    }));

  test("getDiscoveryPaths stays local-only when hosts exist", () =>
    withTempHome(async ({ getDiscoveryPaths, discoveryRoots }, tmpDir) => {
      fs.mkdirSync(path.join(tmpDir, ...HOSTS_ROOT_REL, "gpu"), { recursive: true });
      const p = getDiscoveryPaths();
      assert.equal(p.claudeDir, path.join(tmpDir, ".claude", "projects"));
      assert.equal(discoveryRoots().length, 13);
      assert.equal(
        discoveryRoots().includes(path.join(tmpDir, ...HOSTS_ROOT_REL, "gpu", ".claude", "projects")),
        true,
      );
    }));

  test("tracks HOME when process.env.HOME changes", async () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-roots-a-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-roots-b-"));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tmpA;
      const { discoveryRoots: rootsForA } = await importDiscovery();
      const rootsA = rootsForA();
      assert.deepEqual(rootsA, expectedRoots(tmpA));

      process.env.HOME = tmpB;
      const { discoveryRoots: rootsForB } = await importDiscovery();
      const rootsB = rootsForB();
      assert.deepEqual(rootsB, expectedRoots(tmpB));
      assert.notEqual(rootsB[0], rootsA[0]);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});
