/**
 * Natural-phrase ranking for tracequest search and handoff (search-ranking facts):
 * query words together, and the current repository's project, rank above
 * sessions that only match the same words far apart. Real bin, isolated HOME.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_FIXTURE_CWD, CLAUDE_FIXTURE_MODEL, mkTmp, writeClaudeJsonl, writeJsonl } from "../helpers/fixtures.js";
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
        `${FILLER} Pressing the Stop button of the Codex run needs one click. ${FILLER}`, FILLER);
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
        `${FILLER.repeat(10)} ${"Pressing the Stop button of the Codex run needs one click. ".repeat(40)}${FILLER.repeat(10)}`, FILLER);

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [together, ...scattered])[0], together, `together session should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words and sessions that only quote the query", async () => {
    const home = mkTmp("tracequest-rank-quote-");
    try {
      // Sessions that kept running the search: the query word for word, many times.
      const quoting = [1, 2, 3].map((i) => seedSession(home, "-home-dev-alpha", `quoting-${i}`,
        `Run tracequest handoff "${QUERY}" and report.`,
        `tracequest handoff "${QUERY}" --limit 5 returned five sessions again. `.repeat(60)));
      // The session that did the work: the words sit together in their own forms, often.
      const work = seedSession(home, "-home-dev-beta", "work",
        `${FILLER} ${"The Codex Stop button now interrupts the run. Both Stop buttons keep it usable. ".repeat(20)}${FILLER}`, FILLER);

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [work, ...quoting])[0], work, `the session that did the work should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words when one query word is in most sessions", async () => {
    const home = mkTmp("tracequest-rank-common-");
    try {
      // "stop" is in every session, as in over half of a large hub's sessions.
      const noise = Array.from({ length: 8 }, (_, i) => seedSession(home, "-home-dev-gamma", `noise-${i}`,
        `Please stop the build ${i} before lunch.`, "Stopped."));
      // The work never puts "codex" next to "button": its words sit together only through "stop".
      const work = seedSession(home, "-home-dev-beta", "work",
        `${FILLER} ${"Codex Send and Stop now finish in one action. Both Stop buttons interrupt the run cleanly every single time. ".repeat(10)}${FILLER}`, FILLER);
      // A short session with "codex" next to "button" once, and "stop" far away.
      const other = seedSession(home, "-home-dev-alpha", "other",
        `Rename the Codex button in the sidebar. ${FILLER} Then stop.`, "Done.");

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [work, other, ...noise])[0], work, `the session that did the work should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words and sessions that repeat the query with other punctuation", async () => {
    const home = mkTmp("tracequest-rank-near-copy-");
    try {
      // Sessions about the search itself: the query's words in order, hyphenated or as two commands run back to back.
      const quoting = [1, 2, 3].map((i) => seedSession(home, "-home-dev-alpha", `near-copy-${i}`,
        "Find the Codex Stop-button fix session.",
        ["Ran handoff 'codex stop button' -n 5 then search \"Codex stop button\" again.",
          "Nothing useful came back from either of those two attempts this time.",
          "Looking for the Codex Stop-button fix.",
          "Nothing useful came back from either of those two attempts this time. "].join(" ").repeat(30)));
      const work = seedSession(home, "-home-dev-beta", "work",
        `${FILLER} ${"Codex Send and Stop now finish in one action. Both Stop buttons interrupt the run cleanly every single time. ".repeat(10)}${FILLER}`, FILLER);

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [work, ...quoting])[0], work, `the session that did the work should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words without hiding the only exact quoted match", async () => {
    const home = mkTmp("tracequest-rank-quoted-");
    try {
      // 260 longer sessions of the current repository with the words together but never as the exact
      // phrase: all of them get scanned, more than the phrase scan cap.
      const repo = join(home, "code", "alpha");
      mkdirSync(join(repo, ".git"), { recursive: true });
      for (let i = 0; i < 260; i++) seedSession(home, "-home-dev-alpha", `near-${i}`,
        `${FILLER.repeat(3)} ${"Pressing the Stop button of the Codex run needs one click. ".repeat(5)}`, FILLER);
      // The one exact match is short, so word frequency ranks it first.
      const exact = seedSession(home, "-home-dev-beta", "exact", "The log said codex stop button.", "codex stop button, codex stop button.");

      const search = await runBin(["search", `"${QUERY}"`, "--limit", "5"], { home, cwd: repo });
      assert.ok(search.includes(sessionHash(exact)), `the exact quoted match should be found:\n${search}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words when genuine work states the query", async () => {
    const home = mkTmp("tracequest-rank-genuine-");
    try {
      const work = seedSession(home, "-home-dev-beta", "work",
        `${FILLER} Implemented the Codex Stop button. Clicking it now cancels generation. ${FILLER}`, FILLER);
      const scattered = seedSession(home, "-home-dev-alpha", "scattered",
        "codex codex review notes for the release checklist and its owners",
        "stop stop the old deploy job first. Unrelated: the help page gets a new button button");

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [work, scattered])[0], work, `the work session should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words in a session that ran this search itself", async () => {
    const home = mkTmp("tracequest-rank-searcher-");
    try {
      // It searched for the query, then wrote about it with all its words together.
      const searcher = seedSession(home, "-home-dev-alpha", "searcher",
        `Ran tracequest handoff "${QUERY}" --limit 5 to find earlier work.`,
        "Pressing the Stop button of the Codex run needs one click, as the notes say again and again. ".repeat(15));
      const work = seedSession(home, "-home-dev-beta", "work",
        `${FILLER} ${"Codex Send and Stop now finish in one action. Both Stop buttons interrupt the run cleanly every single time. ".repeat(8)}${FILLER}`, FILLER);

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [work, searcher])[0], work, `the session that did the work should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words when genuine work says it will search for the query", async () => {
    const home = mkTmp("tracequest-rank-search-prose-");
    try {
      // "search" in prose before the query is not a recorded search: the work keeps its full score.
      const work = seedSession(home, "-home-dev-beta", "work",
        `${FILLER} Let me search for the codex stop button handler. ${FILLER}`,
        `${FILLER} ${"The Stop button now cancels the Codex run. ".repeat(3)}${FILLER}`);
      const incidental = seedSession(home, "-home-dev-alpha", "incidental", "Note: the codex stop button looks grey.", "Noted.");

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [work, incidental])[0], work, `the work session should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("words together outrank scattered words placed only in Codex's injected instructions", async () => {
    const home = mkTmp("tracequest-rank-boilerplate-");
    try {
      // Every Codex session carries its base instructions and AGENTS.md context; here they hold the words together.
      const instructions = "Use the Stop button of the Codex panel to interrupt a run. ".repeat(30);
      const codex = join(home, ".codex", "sessions", "2026", "06", "03", "rollout-boilerplate.jsonl");
      writeJsonl(codex, [
        { type: "session_meta", payload: { cwd: "/home/dev/other", model_provider: "openai", base_instructions: { text: instructions } } },
        { type: "response_item", payload: { type: "message", role: "user", content: [
          { type: "input_text", text: `# AGENTS.md instructions for /home/dev/other\n\n${instructions}` }] } },
        { type: "event_msg", payload: { type: "user_message", message: `codex: tidy the release notes. ${FILLER} Then stop. ${FILLER} Then add a button.` } },
      ]);
      const work = seedSession(home, "-home-dev-beta", "work",
        `${FILLER} ${"The Stop button of the Codex run now interrupts it. ".repeat(3)}${FILLER}`, FILLER);

      const handoff = await runBin(["handoff", QUERY, "--limit", "5"], { home, cwd: home });
      assert.equal(order(handoff, [work, codex])[0], work, `the session that did the work should lead:\n${handoff}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("current repository project ranks first for a worktree session that names the repository", async () => {
    const home = mkTmp("tracequest-rank-worktree-");
    try {
      const repo = join(home, "code", "widget");
      mkdirSync(join(repo, ".git"), { recursive: true });
      const plainDir = join(home, "scratch");
      mkdirSync(plainDir, { recursive: true });
      const other = seedSession(home, "-home-dev-other", "other", "Fix the Stop button of the Codex run.", "Done.");
      // Run in a worktree folder named by an id, so only its text says which repository it worked on.
      const worktree = seedSession(home, "-home-dev-tasks-9660ab35", "worktree",
        `${FILLER} Fix the Stop button of the Codex run. ${"widget/src/run.js ".repeat(25)}`, FILLER);
      const both = [worktree, other];

      const outside = await runBin(["search", QUERY], { home, cwd: plainDir });
      assert.deepEqual(order(outside, both), [other, worktree], `outside a repo BM25 order stays:\n${outside}`);

      const inside = await runBin(["handoff", QUERY], { home, cwd: repo });
      assert.deepEqual(order(inside, both), [worktree, other], `inside widget/ the worktree session ranks first:\n${inside}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("current repository project ranks first from a worktree in a differently named folder", async () => {
    const home = mkTmp("tracequest-rank-wt-name-");
    try {
      // Repository "widget" (named by its origin remote), checked out as a worktree in "fix-123".
      const gitDir = join(home, "code", "widget-main", ".git");
      mkdirSync(join(gitDir, "worktrees", "fix-123"), { recursive: true });
      writeFileSync(join(gitDir, "config"), '[remote "origin"]\n\turl = git@github.com:dev/widget.git\n');
      writeFileSync(join(gitDir, "worktrees", "fix-123", "commondir"), "../..\n");
      const worktree = join(home, "wt", "fix-123");
      mkdirSync(worktree, { recursive: true });
      writeFileSync(join(worktree, ".git"), `gitdir: ${join(gitDir, "worktrees", "fix-123")}\n`);
      const other = seedSession(home, "-home-dev-other", "other", "Fix the Stop button of the Codex run.", "Done.");
      const mine = seedSession(home, "-home-dev-widget", "mine", `${FILLER} Fix the Stop button of the Codex run.`, FILLER);

      const inside = await runBin(["search", QUERY], { home, cwd: worktree });
      assert.deepEqual(order(inside, [mine, other]), [mine, other], `the widget session should rank first:\n${inside}`);
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("current repository project ranks first in a checkout whose folder differs from its origin", async () => {
    const home = mkTmp("tracequest-rank-folder-");
    try {
      const repo = join(home, "code", "tq");
      mkdirSync(join(repo, ".git"), { recursive: true });
      writeFileSync(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:dev/widget.git\n');
      const other = seedSession(home, "-home-dev-other", "other", "Fix the Stop button of the Codex run.", "Done.");
      const mine = seedSession(home, "-home-dev-code-tq", "mine", `${FILLER} Fix the Stop button of the Codex run.`, FILLER);

      const inside = await runBin(["search", QUERY], { home, cwd: repo });
      assert.deepEqual(order(inside, [mine, other]), [mine, other], `the tq folder's session should rank first:\n${inside}`);
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
      const other = seedSession(home, "-home-dev-other", "other", "Fix the Stop button of the Codex run.", "Done.");
      const mine = seedSession(home, "-home-dev-widget", "mine", `${FILLER} Fix the Stop button of the Codex run.`, FILLER);
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
