/**
 * Natural-phrase ranking for tracequest search and handoff (search-ranking facts):
 * query words together, and the current repository's project, rank above
 * sessions that only match the same words far apart. Real bin, isolated HOME.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL, mkTmp, writeClaudeJsonl } from "../helpers/fixtures.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const QUERY = "codex stop button";
const FILLER = Array.from({ length: 300 }, (_, i) => `filler${i % 50}`).join(" ");

function runBin(args, { home, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`timeout: ${args.join(" ")}`)); }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}: ${args.join(" ")}\n${stdout}\n${stderr}`));
      else resolve(stdout.replace(/\x1b\[[0-9;]*m/g, ""));
    });
  });
}

function seedSession(home, project, name, prompt, reply) {
  const dir = join(home, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, `${name}.jsonl`, [
    {
      type: "user", sessionId: name, cwd: CLAUDE_FIXTURE_CWD, timestamp: "2026-06-03T12:00:00.000Z",
      uuid: `u-${name}`, isMeta: false, message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant", sessionId: name, timestamp: "2026-06-03T12:00:05.000Z", uuid: `a-${name}`,
      message: { model: CLAUDE_FIXTURE_MODEL, content: [{ type: "text", text: reply }] },
    },
  ]);
}

/** Session hashes in the order they appear in output. */
function order(stdout, paths) {
  return paths
    .map((p) => ({ p, at: stdout.indexOf(sessionHash(p)) }))
    .filter(({ at }) => at >= 0)
    .sort((a, b) => a.at - b.at)
    .map(({ p }) => p);
}

describe("search ranking for natural phrases", () => {
  test("words together outrank scattered words in search and handoff", async () => {
    const home = mkTmp("tracequest-rank-near-");
    try {
      // Scattered: every word repeated in short sessions (high BM25), never next to each other.
      const scattered = [1, 2].map((i) => seedSession(home, "-home-dev-alpha", `scattered-${i}`,
        "codex codex codex review notes for the release checklist and its owners",
        "stop stop stop the old deploy job first. Unrelated: the help page gets a new button button button"));
      // Together: each word once, in a long session (lower BM25).
      const together = seedSession(home, "-home-dev-beta", "together",
        `${FILLER} The Codex stop button needs one click. ${FILLER}`, FILLER);
      const all = [together, ...scattered];

      const search = await runBin(["search", QUERY, "--limit", "10"], { home, cwd: home });
      assert.match(search, /Found 3 results/);
      assert.equal(order(search, all)[0], together, `together session should rank first:\n${search}`);

      const handoff = await runBin(["handoff", QUERY, "--limit", "10"], { home, cwd: home });
      assert.equal(order(handoff, all)[0], together, `together session should lead the handoff:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words beyond the top BM25 hits", async () => {
    const home = mkTmp("tracequest-rank-pool-");
    try {
      // 180 short sessions each mention every word once, far apart: they all outrank the long session on BM25.
      const scattered = Array.from({ length: 180 }, (_, i) => seedSession(home, "-home-dev-alpha", `noise-${i}`,
        `codex review ${i} for the release checklist and its owners`,
        "stop the old deploy job first. Unrelated: the help page gets a new button"));
      // The long session (BM25 ranks it last) is about the query: its words sit together, many times.
      const together = seedSession(home, "-home-dev-beta", "together",
        `${FILLER.repeat(10)} ${"The Codex stop button needs one click. ".repeat(40)}${FILLER.repeat(10)}`, FILLER);

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [together, ...scattered])[0], together, `together session should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("current repository project ranks first inside a git checkout, original order outside", async () => {
    const home = mkTmp("tracequest-rank-project-");
    try {
      const repo = join(home, "code", "widget");
      mkdirSync(join(repo, ".git"), { recursive: true });
      mkdirSync(join(repo, "src"), { recursive: true });
      const plainDir = join(home, "scratch");
      mkdirSync(plainDir, { recursive: true });
      // Same words together in both; the other project's session is shorter, so BM25 prefers it.
      const other = seedSession(home, "-home-dev-other", "other", "Fix the Codex stop button.", "Done.");
      const mine = seedSession(home, "-home-dev-widget", "mine", `${FILLER} Fix the Codex stop button.`, FILLER);
      const both = [mine, other];

      const outside = await runBin(["search", QUERY], { home, cwd: plainDir });
      assert.deepEqual(order(outside, both), [other, mine], `outside a repo BM25 order stays:\n${outside}`);

      const inside = await runBin(["search", QUERY], { home, cwd: join(repo, "src") });
      assert.deepEqual(order(inside, both), [mine, other], `inside widget/ its session ranks first:\n${inside}`);

      const handoff = await runBin(["handoff", QUERY], { home, cwd: repo });
      assert.deepEqual(order(handoff, both), [mine, other], `handoff inside widget/ ranks it first:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
