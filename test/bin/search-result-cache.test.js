/**
 * Exact-repeat search result cache (search-perf facts): an unchanged repeat
 * replays the remembered results byte for byte; anything that could change the
 * answer misses. Real bin, isolated HOME. A planted marker in the stored
 * results shows whether a run replayed the cache or computed its own answer.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL, mkTmp, writeClaudeJsonl } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const QUERY = "codex stop button";
const MARK = "MARK-FROM-RESULT-CACHE";

function runBin(args, { home, cwd = home, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "1",
        TRACEQUEST_CACHE_DIR: join(home, ".cache", "tracequest"), NO_COLOR: "1", FORCE_COLOR: "0", ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`timeout: ${args.join(" ")}`)); }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`exit ${code}: ${args.join(" ")}\n${stdout}\n${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}

function seedSession(home, project, name, text) {
  const dir = join(home, ".claude", "projects", project);
  mkdirSync(dir, { recursive: true });
  return writeClaudeJsonl(dir, `${name}.jsonl`, [
    {
      type: "user", sessionId: name, cwd: CLAUDE_FIXTURE_CWD, timestamp: "2026-06-03T12:00:00.000Z",
      uuid: `u-${name}`, isMeta: false, message: { content: [{ type: "text", text }] },
    },
    {
      type: "assistant", sessionId: name, timestamp: "2026-06-03T12:00:05.000Z", uuid: `a-${name}`,
      message: { model: CLAUDE_FIXTURE_MODEL, content: [{ type: "text", text: "Done: the Codex Stop button works." }] },
    },
  ]);
}

const cachePath = (home) => join(home, ".cache", "tracequest", "search-results.json");

/** Replace every stored first snippet with MARK: a run that prints MARK replayed the cache. */
function plantMark(home) {
  const store = JSON.parse(readFileSync(cachePath(home), "utf8"));
  for (const [, entry] of store.entries) entry.results[0].matches[0].snippet = MARK;
  writeFileSync(cachePath(home), JSON.stringify(store));
}

async function withHome(prefix, fn) {
  const home = mkTmp(prefix);
  try {
    seedSession(home, "-home-dev-alpha", "work", "Pressing the Stop button of the Codex run needs one click.");
    seedSession(home, "-home-dev-beta", "other", "codex review; stop the deploy; a new help button");
    await fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe("search result cache", () => {
  test("result cache repeat: unchanged repeats replay byte-identical output", async () => {
    await withHome("tq-result-cache-repeat-", async (home) => {
      for (const args of [["search", QUERY], ["search", QUERY, "--json"], ["handoff", QUERY, "--limit", "5"]]) {
        const uncached = await runBin(args, { home, env: { TRACEQUEST_NO_RESULT_CACHE: "1" } });
        const computed = await runBin(args, { home }); // index up to date: computes and stores
        const replayed = await runBin(args, { home });
        assert.equal(computed.stdout, uncached.stdout, args.join(" "));
        assert.equal(replayed.stdout, computed.stdout, args.join(" "));
        assert.equal(replayed.stderr, computed.stderr, args.join(" "));
      }
      assert.ok(existsSync(cachePath(home)));
      plantMark(home);
      for (const args of [["search", QUERY], ["search", QUERY, "--json"], ["handoff", QUERY, "--limit", "5"]]) {
        assert.match((await runBin(args, { home })).stdout, new RegExp(MARK), `${args.join(" ")} should replay the cache`);
      }
    });
  });

  test("result cache invalidation: anything that can change the answer misses", async () => {
    await withHome("tq-result-cache-miss-", async (home) => {
      const args = ["handoff", QUERY, "--limit", "5"];
      const prime = async () => {
        await runBin(args, { home });
        await runBin(args, { home });
        plantMark(home);
        assert.match((await runBin(args, { home })).stdout, new RegExp(MARK));
      };
      const assertFresh = async (runArgs = args, env = {}) => {
        const out = (await runBin(runArgs, { home, env })).stdout;
        assert.doesNotMatch(out, new RegExp(MARK), `${runArgs.join(" ")} ${JSON.stringify(env)} should miss`);
        const uncached = (await runBin(runArgs, { home, env: { ...env, TRACEQUEST_NO_RESULT_CACHE: "1" } })).stdout;
        assert.equal(out, uncached, `${runArgs.join(" ")} should print what an uncached run prints`);
      };

      await prime();
      // Other request options.
      await assertFresh(["handoff", QUERY, "--limit", "4"]);
      await assertFresh(["handoff", "codex stop", "--limit", "5"]);
      await assertFresh(["handoff", QUERY, "--limit", "5", "--sort", "recent"]);
      await assertFresh(["search", QUERY, "--format", "handoff", "--limit", "5", "--filter", "project:alpha"]);
      await assertFresh(args, { TRACEQUEST_NO_RESULT_CACHE: "1" });
      await assertFresh(args, { TRACEQUEST_SOME_SETTING: "x" });

      // A changed session: the run that re-indexes is not stored, and prints the new content.
      await prime();
      const work = join(home, ".claude", "projects", "-home-dev-alpha", "work.jsonl");
      appendFileSync(work, `${JSON.stringify({
        type: "user", sessionId: "work", cwd: CLAUDE_FIXTURE_CWD, timestamp: "2026-06-03T12:01:00.000Z",
        uuid: "u-work-2", isMeta: false, message: { content: [{ type: "text", text: "Codex stop button pressed twice" }] },
      })}\n`);
      const before = readFileSync(cachePath(home), "utf8");
      const changed = (await runBin(args, { home })).stdout;
      assert.doesNotMatch(changed, new RegExp(MARK));
      assert.equal(readFileSync(cachePath(home), "utf8"), before, "a run that re-indexed must not store its results");
      const uncachedChanged = (await runBin(args, { home, env: { TRACEQUEST_NO_RESULT_CACHE: "1" } })).stdout;
      assert.equal(changed, uncachedChanged, "the changed corpus prints what an uncached run prints");      await assertFresh();

      // Same size, new mtime.
      await prime();
      const t = new Date(Date.now() + 5000);
      utimesSync(work, t, t);
      await assertFresh();

      // A new session, then a removed one.
      await prime();
      const extra = seedSession(home, "-home-dev-gamma", "extra", "codex stop button again");
      await assertFresh();
      await prime();
      rmSync(extra);
      await assertFresh();

      // A rewritten index.
      await prime();
      const idx = join(home, ".cache", "tracequest", "index.json");
      writeFileSync(idx, readFileSync(idx));
      await assertFresh();

      // Another repository.
      await prime();
      mkdirSync(join(home, "repo", ".git"), { recursive: true });
      assert.match((await runBin(args, { home })).stdout, new RegExp(MARK), "the same cwd still replays");
      const inRepo = (await runBin(args, { home, cwd: join(home, "repo") })).stdout;
      assert.doesNotMatch(inRepo, new RegExp(MARK), "a run in another repository should miss");
    });
  });
});
