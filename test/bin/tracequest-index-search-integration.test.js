/**
 * Automated harness for tests/index-search-integration.md — index/search pipeline integration.
 * Real bin/tracequest.js invocations; isolated HOME fixtures; BM25 ranking + cache persistence.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
  bumpFileMtime,
  mkTmp,
  writeClaudeJsonl,
  writeJsonl,
} from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const BASELINE_MARKER = "idx-search-baseline-marker";
const BM25_NEEDLE = "bm25rankneedle";
const INCREMENTAL_A = "idxincremental_alpha_xyzzy";
const INCREMENTAL_B = "idxincremental_bravo_plugh";
const SHARED_NEEDLE = "idx-shared-query-needle";
const INV_DELETE_MARKER = "idx-inv-delete-marker-xyzzy";
const INV_EDIT_BEFORE = "idx-inv-edit-before-plugh";
const INV_EDIT_AFTER = "idx-inv-edit-after-plugh";
const INV_SURVIVOR_MARKER = "idx-inv-survivor-marker-plugh";

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...env,
      },
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

function claudeSessionLines(
  sessionId,
  {
    prompt = "integration prompt",
    assistantText = "integration assistant reply",
    model = CLAUDE_FIXTURE_MODEL,
    tStart = "2026-06-03T12:00:00.000Z",
    tEnd = "2026-06-03T12:00:05.000Z",
    usage = null,
  } = {},
) {
  const assistantMessage = {
    model,
    content: [{ type: "text", text: assistantText }],
  };
  if (usage) assistantMessage.usage = usage;
  return [
    {
      type: "user",
      sessionId,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: tStart,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: tEnd,
      uuid: `a-${sessionId}`,
      message: assistantMessage,
    },
  ];
}

function seedClaudeProject(home, projectName, fileName, lines) {
  const dir = join(home, ".claude", "projects", projectName);
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, fileName, lines);
}

function cachePaths(home) {
  const cacheDir = join(home, ".cache", "tracequest");
  return {
    indexJson: join(cacheDir, "index.json"),
    searchIdx: join(cacheDir, "search.idx"),
  };
}

function pathOrderInStdout(stdout, ...needles) {
  const visible = stripAnsi(stdout);
  return needles.map((needle) => visible.indexOf(needle));
}

describe("tests/index-search-integration.md harness", () => {
  test("Test 1: index build produces searchable CLI results and persists cache files", async () => {
    const home = mkTmp("tracequest-idx-search-baseline-");
    try {
      const sessionPath = seedClaudeProject(
        home,
        "idx-search-baseline",
        "baseline.jsonl",
        claudeSessionLines("idx-base-1", { prompt: `hello ${BASELINE_MARKER}` }),
      );
      const { stdout } = await runBin(["search", BASELINE_MARKER], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 1 result/);
      assert.match(visible, new RegExp(sessionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const { indexJson, searchIdx } = cachePaths(home);
      assert.ok(existsSync(indexJson), "index.json should exist after search");
      assert.ok(existsSync(searchIdx), "search.idx should exist after search");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("Test 2: multi-session BM25 search ranks higher-frequency session first", async () => {
    const home = mkTmp("tracequest-idx-search-rank-");
    try {
      const densePath = seedClaudeProject(
        home,
        "idx-search-rank",
        "dense.jsonl",
        claudeSessionLines("idx-dense-1", {
          prompt: `${BM25_NEEDLE} ${BM25_NEEDLE} ${BM25_NEEDLE} dense session`,
          assistantText: `${BM25_NEEDLE} ${BM25_NEEDLE} ${BM25_NEEDLE} dense reply`,
        }),
      );
      const sparsePath = seedClaudeProject(
        home,
        "idx-search-rank",
        "sparse.jsonl",
        claudeSessionLines("idx-sparse-1", {
          prompt: `only one ${BM25_NEEDLE} here`,
          assistantText: "sparse reply without extra terms",
        }),
      );
      const { stdout } = await runBin(["search", BM25_NEEDLE], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 2 results/);
      const [denseIdx, sparseIdx] = pathOrderInStdout(stdout, densePath, sparsePath);
      assert.ok(denseIdx >= 0, "dense session path should appear in output");
      assert.ok(sparseIdx >= 0, "sparse session path should appear in output");
      assert.ok(denseIdx < sparseIdx, "dense session should rank above sparse (BM25 score)");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("Test 3: incremental index update finds newly added session", async () => {
    const home = mkTmp("tracequest-idx-search-incremental-");
    try {
      const pathA = seedClaudeProject(
        home,
        "idx-search-incremental",
        "session-a.jsonl",
        claudeSessionLines("idx-inc-a", { prompt: `marker ${INCREMENTAL_A}` }),
      );
      const first = await runBin(["search", INCREMENTAL_A], { env: { HOME: home } });
      const firstVisible = stripAnsi(first.stdout);
      assert.match(firstVisible, /Found 1 result/);
      assert.match(firstVisible, /session-a\.jsonl/);
      assert.doesNotMatch(firstVisible, /session-b\.jsonl/);

      const pathB = seedClaudeProject(
        home,
        "idx-search-incremental",
        "session-b.jsonl",
        claudeSessionLines("idx-inc-b", { prompt: `marker ${INCREMENTAL_B}` }),
      );

      const second = await runBin(["search", INCREMENTAL_B], { env: { HOME: home } });
      const secondVisible = stripAnsi(second.stdout);
      assert.match(secondVisible, /Found 1 result/);
      assert.match(secondVisible, new RegExp(pathB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const third = await runBin(["search", INCREMENTAL_A], { env: { HOME: home } });
      const thirdVisible = stripAnsi(third.stdout);
      assert.match(thirdVisible, /Found 1 result/);
      assert.match(thirdVisible, new RegExp(pathA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("Test 4: shared query returns all matching sessions", async () => {
    const home = mkTmp("tracequest-idx-search-shared-");
    try {
      for (const [file, sid] of [
        ["shared-one.jsonl", "idx-shared-1"],
        ["shared-two.jsonl", "idx-shared-2"],
        ["shared-three.jsonl", "idx-shared-3"],
      ]) {
        seedClaudeProject(
          home,
          "idx-search-shared",
          file,
          claudeSessionLines(sid, { prompt: `project text includes ${SHARED_NEEDLE}` }),
        );
      }
      const { stdout } = await runBin(["search", SHARED_NEEDLE], { env: { HOME: home } });
      const visible = stripAnsi(stdout);
      assert.match(visible, /Found 3 results/);
      for (const file of ["shared-one.jsonl", "shared-two.jsonl", "shared-three.jsonl"]) {
        assert.match(visible, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("Test 5: deleted session no longer searchable after warm index cache", async () => {
    const home = mkTmp("tracequest-idx-search-delete-");
    try {
      const doomedPath = seedClaudeProject(
        home,
        "idx-search-delete",
        "doomed.jsonl",
        claudeSessionLines("idx-del-1", { prompt: `delete me ${INV_DELETE_MARKER}` }),
      );
      seedClaudeProject(
        home,
        "idx-search-delete",
        "survivor.jsonl",
        claudeSessionLines("idx-del-surv", { prompt: `still here ${INV_SURVIVOR_MARKER}` }),
      );

      const warm = await runBin(["search", INV_DELETE_MARKER], { env: { HOME: home } });
      assert.match(stripAnsi(warm.stdout), /Found 1 result/);
      assert.match(stripAnsi(warm.stdout), /doomed\.jsonl/);

      unlinkSync(doomedPath);

      const afterDelete = await runBin(["search", INV_DELETE_MARKER], { env: { HOME: home } });
      assert.match(
        stripAnsi(afterDelete.stdout),
        new RegExp(`No sessions match query: "${INV_DELETE_MARKER}"`),
      );

      const survivor = await runBin(["search", INV_SURVIVOR_MARKER], { env: { HOME: home } });
      assert.match(stripAnsi(survivor.stdout), /Found 1 result/);
      assert.match(stripAnsi(survivor.stdout), /survivor\.jsonl/);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("Test 6: edited session file reflects new content on re-search", async () => {
    const home = mkTmp("tracequest-idx-search-edit-");
    try {
      const sessionPath = seedClaudeProject(
        home,
        "idx-search-edit",
        "editable.jsonl",
        claudeSessionLines("idx-edit-1", { prompt: `original ${INV_EDIT_BEFORE}` }),
      );

      const before = await runBin(["search", INV_EDIT_BEFORE], { env: { HOME: home } });
      assert.match(stripAnsi(before.stdout), /Found 1 result/);
      assert.doesNotMatch(stripAnsi(before.stdout), new RegExp(INV_EDIT_AFTER));

      writeJsonl(
        sessionPath,
        claudeSessionLines("idx-edit-1", { prompt: `revised ${INV_EDIT_AFTER}` }),
      );
      bumpFileMtime(sessionPath);

      const afterNew = await runBin(["search", INV_EDIT_AFTER], { env: { HOME: home } });
      const afterNewVisible = stripAnsi(afterNew.stdout);
      assert.match(afterNewVisible, /Found 1 result/);
      assert.match(afterNewVisible, /editable\.jsonl/);

      const afterOld = await runBin(["search", INV_EDIT_BEFORE], { env: { HOME: home } });
      assert.match(
        stripAnsi(afterOld.stdout),
        new RegExp(`No sessions match query: "${INV_EDIT_BEFORE}"`),
      );
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("Test 7: corrupt index.json rebuilds gracefully and search stays correct", async () => {
    const home = mkTmp("tracequest-idx-search-corrupt-json-");
    try {
      seedClaudeProject(
        home,
        "idx-search-corrupt-json",
        "baseline.jsonl",
        claudeSessionLines("idx-corrupt-json-1", { prompt: `needle ${INV_SURVIVOR_MARKER}` }),
      );

      await runBin(["search", INV_SURVIVOR_MARKER], { env: { HOME: home } });
      const { indexJson } = cachePaths(home);
      assert.ok(existsSync(indexJson), "precondition: warm cache wrote index.json");
      writeFileSync(indexJson, "{not valid json\n");

      const afterCorrupt = await runBin(["search", INV_SURVIVOR_MARKER], { env: { HOME: home } });
      const visible = stripAnsi(afterCorrupt.stdout);
      assert.match(visible, /Found 1 result/);
      assert.match(visible, /baseline\.jsonl/);
      const rebuilt = JSON.parse(readFileSync(indexJson, "utf8"));
      assert.equal(typeof rebuilt._v, "number", "corrupt index.json should be rewritten with version");
      assert.ok(rebuilt[Object.keys(rebuilt).find((k) => k.endsWith("baseline.jsonl"))]);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("Test 8: corrupt search.idx rebuilds gracefully and search stays correct", async () => {
    const home = mkTmp("tracequest-idx-search-corrupt-idx-");
    try {
      seedClaudeProject(
        home,
        "idx-search-corrupt-idx",
        "indexed.jsonl",
        claudeSessionLines("idx-corrupt-idx-1", { prompt: `needle ${INV_DELETE_MARKER}` }),
      );

      await runBin(["search", INV_DELETE_MARKER], { env: { HOME: home } });
      const { searchIdx } = cachePaths(home);
      assert.ok(existsSync(searchIdx), "precondition: warm cache wrote search.idx");
      writeFileSync(searchIdx, "TQSI\x00corrupt-bytes");

      const afterCorrupt = await runBin(["search", INV_DELETE_MARKER], { env: { HOME: home } });
      const visible = stripAnsi(afterCorrupt.stdout);
      assert.match(visible, /Found 1 result/);
      assert.match(visible, /indexed\.jsonl/);
      assert.ok(existsSync(searchIdx), "search.idx should exist after rebuild");
      assert.ok(readFileSync(searchIdx).length > 16, "search.idx should contain rebuilt binary payload");
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});