/**
 * Automated harness for tests/sidecar-integration.md — real tracequest-sidecar ELF binary.
 * Sidecar enabled via TRACEQUEST_SIDECAR_PATH; TRACEQUEST_NO_SIDECAR must stay unset.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FIXTURE_MODEL,
  mkTmp,
  writeClaudeJsonl,
  writeJsonl,
} from "../helpers/fixtures.js";
import {
  SIDECAR_BIN,
  SKIP_NO_SIDECAR,
  MINIMAL_PARITY_LINES,
  PARITY_KEYS,
  assertIndexParity,
} from "../helpers/sidecar-parity-helpers.js";
import { INDEX_VERSION } from "../../src/sessions/index-writers.js";
import { discoverSessions } from "../../src/sessions/session-discovery.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const SEARCH_MARKER = "sidecar-integration-marker-xyz";

/** @type {string[]} */
const pendingHomes = [];

afterEach(() => {
  while (pendingHomes.length) {
    const home = pendingHomes.pop();
    try {
      rmSync(home, { recursive: true, force: true });
    } catch {
      /* worker may still flush index under HOME */
    }
  }
});

function sidecarEnv(extra = {}) {
  return {
    ...process.env,
    TRACEQUEST_SIDECAR_PATH: SIDECAR_BIN,
    TRACEQUEST_SKIP_LR_WATCH: "1",
    ...extra,
  };
}

function runSidecarCli(args, { input, env = {}, expectCode = 0 } = {}) {
  const result = spawnSync(SIDECAR_BIN, args, {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
    input,
    env: sidecarEnv(env),
  });
  if (result.status !== expectCode) {
    throw new Error(
      `sidecar ${args.join(" ")} expected exit ${expectCode}, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  return result;
}

function runSidecarCliAsync(args, { input, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(SIDECAR_BIN, args, {
      env: sidecarEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    if (input != null) {
      child.stdin.write(input);
    }
    child.stdin.end();
    child.on("close", (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: sidecarEnv(env),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== expectCode) {
        reject(
          new Error(
            `bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function minimalClaudeSession(sessionId, { prompt = SEARCH_MARKER, model = CLAUDE_FIXTURE_MODEL } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId,
      cwd: "/home/dev/tracequest",
      timestamp: ts,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      message: {
        model,
        content: [{ type: "text", text: "sidecar integration reply" }],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    },
  ];
}

function seedClaudeProject(home, projectName, fileName, lines) {
  const dir = join(home, ".claude", "projects", projectName);
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, fileName, lines);
}

function sessionPayloadFromPath(filePath, { project = "sidecar-int", source = "claude" } = {}) {
  const stat = statSync(filePath);
  return {
    path: filePath,
    project,
    file: filePath.split("/").pop(),
    source,
    size: stat.size,
    mtime: stat.mtime.getTime(),
  };
}

function discoveryRootsForHome(home) {
  return [
    join(home, ".claude", "projects"),
    join(home, ".codex", "sessions"),
    join(home, ".factory", "sessions"),
    join(home, ".grok", "sessions"),
    join(home, ".local", "share", "opencode", "opencode.db"),
  ];
}

describe("tests/sidecar-integration.md harness", () => {
  test("Test 1: sidecar binary runs and documents subcommands", SKIP_NO_SIDECAR, () => {
    const { stdout } = runSidecarCli(["--help"]);
    assert.match(stdout, /tracequest-sidecar/);
    assert.match(stdout, /\bscan\b/);
    assert.match(stdout, /\bindex\b/);
  });

  test("Test 2: direct scan on empty roots returns []", SKIP_NO_SIDECAR, () => {
    const { stdout } = runSidecarCli(["scan", "--roots", "[]"]);
    assert.deepEqual(JSON.parse(stdout), []);
  });

  test("Test 3: direct index on empty session list returns {}", SKIP_NO_SIDECAR, () => {
    const indexPath = join(mkTmp("tq-sidecar-empty-index-"), "index.json");
    const { stdout } = runSidecarCli(
      ["index", "--index-path", indexPath, "--version", String(INDEX_VERSION), "--sessions-stdin"],
      { input: "[]" },
    );
    assert.deepEqual(JSON.parse(stdout), {});
  });

  test("Test 4: malformed JSONL indexes without crash", SKIP_NO_SIDECAR, () => {
    const dir = mkTmp("tq-sidecar-malformed-");
    const badPath = join(dir, "bad.jsonl");
    writeFileSync(badPath, "not json\n{broken\n");
    const session = sessionPayloadFromPath(badPath);
    const indexPath = join(dir, "index.json");
    try {
      const { stdout } = runSidecarCli(
        ["index", "--index-path", indexPath, "--version", String(INDEX_VERSION), "--sessions-stdin"],
        { input: JSON.stringify({ sessions: [session] }) },
      );
      const map = JSON.parse(stdout);
      const entry = map[badPath];
      assert.ok(entry, "malformed file should still produce an index entry");
      assert.equal(entry.chapters, 0);
      assert.equal(entry.firstPrompt, undefined);
      assert.equal(entry.totalTokens, 0);
      assert.equal(entry.errors, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 5: large session file indexes via mmap path (>512KB)", SKIP_NO_SIDECAR, () => {
    const dir = mkTmp("tq-sidecar-large-");
    const largePath = join(dir, "large.jsonl");
    const lines = [];
    for (let i = 0; i < 3000; i++) {
      lines.push({
        type: "user",
        message: { content: `sidecar-large-marker-${i} ${"x".repeat(200)}` },
        timestamp: "2026-06-03T12:00:00.000Z",
      });
      lines.push({
        type: "assistant",
        message: {
          model: CLAUDE_FIXTURE_MODEL,
          content: [{ type: "text", text: "reply" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
        timestamp: "2026-06-03T12:01:00.000Z",
      });
    }
    writeJsonl(largePath, lines);
    const size = statSync(largePath).size;
    assert.ok(size > 512 * 1024, `fixture must exceed mmap threshold, got ${size} bytes`);
    const session = sessionPayloadFromPath(largePath);
    const indexPath = join(dir, "index.json");
    try {
      const { stdout } = runSidecarCli(
        ["index", "--index-path", indexPath, "--version", String(INDEX_VERSION), "--sessions-stdin"],
        { input: JSON.stringify({ sessions: [session] }) },
      );
      const entry = JSON.parse(stdout)[largePath];
      assert.ok(entry.firstPrompt?.includes("sidecar-large-marker-0"));
      assert.ok(entry.chapters >= 1000);
      assert.ok(entry.totalTokens > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 6: CLI list discovers sessions via sidecar scan", SKIP_NO_SIDECAR, async () => {
    const home = mkTmp("tq-sidecar-home-list-");
    pendingHomes.push(home);
    const sessionPath = seedClaudeProject(
      home,
      "sidecar-int",
      "smoke.jsonl",
      minimalClaudeSession("sidecar-list-1"),
    );
    const { stdout } = await runBin(["list", "sidecar-int"], { env: { HOME: home } });
    const visible = stripAnsi(stdout);
    assert.match(visible, /Found 1 session/);
    assert.match(visible, /sidecar-int/);
    assert.match(visible, new RegExp(sessionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(visible, /claude/i);
  });

  test("Test 7: CLI search builds index via sidecar", SKIP_NO_SIDECAR, async () => {
    const home = mkTmp("tq-sidecar-home-search-");
    pendingHomes.push(home);
    seedClaudeProject(
      home,
      "sidecar-search",
      "search.jsonl",
      minimalClaudeSession("sidecar-search-1", { prompt: SEARCH_MARKER }),
    );
    const { stdout, stderr } = await runBin(["search", SEARCH_MARKER], { env: { HOME: home } });
    const visible = stripAnsi(stdout);
    assert.match(stderr, /via sidecar/);
    assert.match(visible, /Found 1 result/);
    assert.match(visible, /sidecar-search/);
  });

  test("Test 8: sidecar scan matches JS discoverSessions on same HOME", SKIP_NO_SIDECAR, () => {
    const home = mkTmp("tq-sidecar-scan-parity-");
    pendingHomes.push(home);
    const matchPath = seedClaudeProject(
      home,
      "sidecar-match-proj",
      "match.jsonl",
      minimalClaudeSession("sidecar-match-1"),
    );
    seedClaudeProject(
      home,
      "sidecar-other-proj",
      "other.jsonl",
      minimalClaudeSession("sidecar-other-1"),
    );
    const filter = "sidecar-match";
    const roots = discoveryRootsForHome(home);
    const { stdout } = runSidecarCli([
      "scan",
      "--roots",
      JSON.stringify(roots),
      "--filter",
      filter,
    ], { env: { HOME: home } });
    const sidecarPaths = JSON.parse(stdout).map((s) => s.path).sort();
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const jsSessions = [];
      discoverSessions(filter, jsSessions);
      const jsPaths = jsSessions.map((s) => s.path).sort();
      assert.deepEqual(sidecarPaths, jsPaths);
      assert.equal(sidecarPaths.length, 1);
      assert.equal(sidecarPaths[0], matchPath);
    } finally {
      process.env.HOME = prevHome;
    }
  });

  test("Test 9: buildIndex via sidecar matches JS-only buildIndex", SKIP_NO_SIDECAR, async () => {
    const dir = mkTmp("tq-sidecar-build-parity-");
    const filePath = join(dir, "parity.jsonl");
    writeJsonl(filePath, MINIMAL_PARITY_LINES);
    const session = sessionPayloadFromPath(filePath, { project: "parity-probe" });
    const sessions = [session];
    const home = mkTmp("tq-sidecar-build-home-");
    pendingHomes.push(home);

    const modUrl = new URL(`../../src/sessions/index-writers.js?${Date.now()}`, import.meta.url);
    const {
      buildIndex,
      initIndexWriters,
      resetIndexWritersForTests,
    } = await import(modUrl.href);
    const { indexSession } = await import(
      new URL(`../../src/sessions/session-index-core.js?${Date.now()}`, import.meta.url).href,
    );
    const { sessionListChecksum } = await import(
      new URL(`../../src/sessions/session-list.js?${Date.now()}`, import.meta.url).href,
    );
    initIndexWriters({ indexSession, sessionListChecksum });
    resetIndexWritersForTests();

    const prevHome = process.env.HOME;
    const prevNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
    const prevSidecarPath = process.env.TRACEQUEST_SIDECAR_PATH;
    process.env.HOME = home;
    process.env.TRACEQUEST_SIDECAR_PATH = SIDECAR_BIN;
    delete process.env.TRACEQUEST_NO_SIDECAR;
    resetIndexWritersForTests();

    let sidecarMap;
    let jsMap;
    try {
      sidecarMap = buildIndex(sessions);
      process.env.TRACEQUEST_NO_SIDECAR = "1";
      delete process.env.TRACEQUEST_SIDECAR_PATH;
      resetIndexWritersForTests();
      jsMap = buildIndex(sessions);
    } finally {
      process.env.HOME = prevHome;
      if (prevNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
      else process.env.TRACEQUEST_NO_SIDECAR = prevNoSidecar;
      if (prevSidecarPath === undefined) delete process.env.TRACEQUEST_SIDECAR_PATH;
      else process.env.TRACEQUEST_SIDECAR_PATH = prevSidecarPath;
      resetIndexWritersForTests();
      rmSync(dir, { recursive: true, force: true });
    }

    const sidecarEntry = sidecarMap.get(filePath);
    const jsEntry = jsMap.get(filePath);
    assert.ok(sidecarEntry, "sidecar buildIndex should index session");
    assert.ok(jsEntry, "JS buildIndex should index session");
    assertIndexParity(jsEntry, sidecarEntry, "buildIndex");
    for (const key of PARITY_KEYS) {
      if (key === "tools" || key === "toolCounts") continue;
      assert.equal(sidecarEntry[key], jsEntry[key], `buildIndex parity: ${key}`);
    }
  });

  test("Test 10: concurrent parallel index builds complete identically", SKIP_NO_SIDECAR, async () => {
    const dir = mkTmp("tq-sidecar-concurrent-");
    const indexPath = join(dir, "index.json");
    const sessions = [];
    for (const n of [1, 2]) {
      const p = join(dir, `s${n}.jsonl`);
      writeJsonl(p, [
        {
          type: "user",
          message: { content: `concurrent-sidecar-${n}` },
          timestamp: "2026-06-03T12:00:00.000Z",
        },
      ]);
      sessions.push(sessionPayloadFromPath(p, { project: "conc" }));
    }
    const input = JSON.stringify({ sessions });
    const args = [
      "index",
      "--index-path",
      indexPath,
      "--version",
      String(INDEX_VERSION),
      "--sessions-stdin",
    ];
    try {
      const [r1, r2] = await Promise.all([
        runSidecarCliAsync(args, { input }),
        runSidecarCliAsync(args, { input }),
      ]);
      assert.equal(r1.code, 0, `concurrent build 1 failed: ${r1.stderr}`);
      assert.equal(r2.code, 0, `concurrent build 2 failed: ${r2.stderr}`);
      const map1 = JSON.parse(r1.stdout);
      const map2 = JSON.parse(r2.stdout);
      assert.equal(Object.keys(map1).length, 2);
      assert.equal(Object.keys(map2).length, 2);
      for (const p of Object.keys(map1)) {
        assert.deepEqual(map2[p], map1[p], `parallel builds must agree on ${p}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 11: fractional mtime in stdin JSON indexes without panic", SKIP_NO_SIDECAR, () => {
    const dir = mkTmp("tq-sidecar-frac-mtime-");
    const filePath = join(dir, "frac.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: { content: "fractional-mtime-marker" },
        timestamp: "2026-06-03T12:00:00.000Z",
      },
    ]);
    const stat = statSync(filePath);
    const session = {
      path: filePath,
      project: "frac",
      file: "frac.jsonl",
      source: "claude",
      size: stat.size,
      mtime: 1_700_000_000_000.9,
    };
    const indexPath = join(dir, "index.json");
    try {
      const { stdout } = runSidecarCli(
        ["index", "--index-path", indexPath, "--version", String(INDEX_VERSION), "--sessions-stdin"],
        { input: JSON.stringify({ sessions: [session] }) },
      );
      const entry = JSON.parse(stdout)[filePath];
      assert.ok(entry, "fractional mtime session should index");
      assert.equal(entry.mtime, 1_700_000_000_000);
      assert.ok(entry.firstPrompt?.includes("fractional-mtime-marker"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
