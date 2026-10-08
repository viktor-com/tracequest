import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { OPENCODE_DB_REL, resolveOpenCodeDbPath } from "../../src/sessions/session-discovery-paths.js";

function importDiscovery() {
  const modUrl = new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function importRouteCache() {
  const modUrl = new URL("../../src/routes/route-cache.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-paths-consistency-"));
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

/** discoveryRoots() must mirror getDiscoveryPaths() field order (OpenCode last). */
function rootsFromPaths(p) {
  return [p.claudeDir, p.codexDir, p.cursorDir, p.cursorCloudDir, p.factoryDir, p.grokDir, p.openCodeDb];
}

describe("getDiscoveryPaths vs discoveryRoots consistency", () => {
  test("discoveryRoots mirrors getDiscoveryPaths provider field order", () =>
    withTempHome(async ({ getDiscoveryPaths, discoveryRoots }) => {
      const p = getDiscoveryPaths();
      assert.deepEqual(discoveryRoots(), rootsFromPaths(p));
    }));

  test("openCodeDb is seventh in getDiscoveryPaths and last in discoveryRoots", () =>
    withTempHome(async ({ getDiscoveryPaths, discoveryRoots }, tmpDir) => {
      const p = getDiscoveryPaths();
      const roots = discoveryRoots();
      assert.equal(roots.length, 7);
      assert.equal(roots[6], p.openCodeDb);
      assert.equal(p.openCodeDb, path.join(tmpDir, ...OPENCODE_DB_REL));
      assert.ok(p.openCodeDb.endsWith("opencode.db"));
    }));

  test("OpenCode path segments follow OPENCODE_DB_REL ordering under HOME", () =>
    withTempHome(async ({ getDiscoveryPaths, discoveryRoots }, tmpDir) => {
      const openFromPaths = getDiscoveryPaths().openCodeDb;
      const openFromRoots = discoveryRoots()[6];
      assert.equal(openFromPaths, openFromRoots);
      assert.equal(openFromPaths, resolveOpenCodeDbPath(tmpDir));
      const rel = path.relative(tmpDir, openFromPaths);
      assert.equal(rel.split(path.sep).join("/"), OPENCODE_DB_REL.join("/"));
    }));

  test("non-OpenCode roots precede OpenCode in the same order as object fields", () =>
    withTempHome(async ({ getDiscoveryPaths, discoveryRoots }, tmpDir) => {
      const p = getDiscoveryPaths();
      const roots = discoveryRoots();
      assert.deepEqual(roots.slice(0, 6), [
        path.join(tmpDir, ".claude", "projects"),
        path.join(tmpDir, ".codex", "sessions"),
        path.join(tmpDir, ".cursor", "projects"),
        path.join(tmpDir, ".local", "share", "tracequest", "cursor-cloud"),
        path.join(tmpDir, ".factory", "sessions"),
        path.join(tmpDir, ".grok", "sessions"),
      ]);
      assert.equal(roots[5], p.grokDir);
      assert.notEqual(roots[5], p.openCodeDb);
    }));

  test("both APIs track HOME when process.env.HOME changes", async () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-paths-consistency-a-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-paths-consistency-b-"));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tmpA;
      const modA = await importDiscovery();
      const pathsA = modA.getDiscoveryPaths();
      const rootsA = modA.discoveryRoots();
      assert.deepEqual(rootsA, rootsFromPaths(pathsA));
      assert.equal(pathsA.openCodeDb, resolveOpenCodeDbPath(tmpA));

      process.env.HOME = tmpB;
      const modB = await importDiscovery();
      const pathsB = modB.getDiscoveryPaths();
      const rootsB = modB.discoveryRoots();
      assert.deepEqual(rootsB, rootsFromPaths(pathsB));
      assert.equal(pathsB.openCodeDb, resolveOpenCodeDbPath(tmpB));
      assert.notEqual(pathsB.openCodeDb, pathsA.openCodeDb);
      assert.equal(rootsB[6], pathsB.openCodeDb);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});

describe("discoveryRoots vs route-cache getDataRoots", () => {
  test("getDataRoots mirrors discoveryRoots under temp HOME", () =>
    withTempHome(async ({ discoveryRoots }) => {
      const { getDataRoots } = await importRouteCache();
      assert.deepEqual(getDataRoots(), discoveryRoots());
    }));

  test("getDataRoots tracks HOME with discoveryRoots for route-cache keying", async () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-paths-getdataroots-a-"));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "tq-discovery-paths-getdataroots-b-"));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = tmpA;
      const modA = await importDiscovery();
      const cacheA = await importRouteCache();
      const rootsA = cacheA.getDataRoots();
      assert.deepEqual(rootsA, modA.discoveryRoots());
      assert.deepEqual(rootsA, rootsFromPaths(modA.getDiscoveryPaths()));

      process.env.HOME = tmpB;
      const modB = await importDiscovery();
      const cacheB = await importRouteCache();
      const rootsB = cacheB.getDataRoots();
      assert.deepEqual(rootsB, modB.discoveryRoots());
      assert.notEqual(rootsB[0], rootsA[0]);
      assert.equal(rootsB[6], modB.getDiscoveryPaths().openCodeDb);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});

/**
 * ANTI-DRIFT: discovery (what the index sees) and run↔session attribution
 * (what a launched run may link) must model the SAME on-disk layout for
 * every source. Round 6 shipped a cursor-agent candidate scan aimed at a
 * layout the CLI does not use — root-level *.jsonl under a leading-dash
 * project slug — while findCursorSessions already walked the real
 * agent-transcripts/<uuid>/<uuid>.jsonl nesting, so every real cursor run
 * pended forever with its transcript on disk. Both halves now build paths
 * from src/sessions/session-layout.js; this test fails the moment one half
 * starts looking somewhere the other does not.
 */
describe("attribution candidates vs discovery layouts (shared session-layout.js)", () => {
  const CWD = "/w/proj";

  function seedRealLayouts(home, layout) {
    const write = (dir, name) => {
      fs.mkdirSync(dir, { recursive: true });
      const p = path.join(dir, name);
      fs.writeFileSync(p, '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n');
      return p;
    };
    const uuid = "11111111-2222-4333-8444-555555555555";
    return {
      claude: write(layout.claudeProjectDir(home, CWD), "sess-claude.jsonl"),
      cursor: write(
        path.join(layout.cursorTranscriptsDir(home, CWD), uuid),
        `${uuid}.jsonl`,
      ),
      codex: write(path.join(layout.codexSessionsRoot(home), "2026", "08", "11"), "rollout-x.jsonl"),
      factory: write(layout.factoryWorkspaceDir(home, CWD), "sess-droid.jsonl"),
      grok: write(layout.grokSessionDir(home, CWD, "sess-grok"), layout.GROK_CHAT_FILE),
    };
  }

  test("every per-source candidate scan finds exactly the recording discovery indexes", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-layout-parity-"));
    const originalHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const layout = await import("../../src/sessions/session-layout.js");
      const { runSessionCandidates } = await import("../../src/sessions/run-session-link.js");
      const discovery = await importDiscovery();
      const seeded = seedRealLayouts(home, layout);

      const discovered = discovery.discoverSessions(null, []);
      const bySource = (source) => discovered.filter((s) => s.source === source && !s.parentSession).map((s) => s.path);

      const cases = [
        { agent: "claude", source: "claude", expect: seeded.claude },
        { agent: "cursor-agent", source: "cursor", expect: seeded.cursor },
        { agent: "codex", source: "codex", expect: seeded.codex },
        { agent: "droid", source: "factory", expect: seeded.factory },
        // grok's session PATH is the directory; discovery reports the same.
        { agent: "grok", source: "grok", expect: path.dirname(seeded.grok) },
      ];
      for (const c of cases) {
        const candidates = runSessionCandidates({ agent: c.agent, cwd: CWD, home }).map((x) => x.path);
        assert.deepEqual(candidates, [c.expect], `${c.agent}: candidate scan finds the real recording`);
        assert.ok(
          bySource(c.source).includes(c.expect),
          `${c.agent}: discovery indexes the very path attribution may link`,
        );
      }
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
