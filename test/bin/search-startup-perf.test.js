/**
 * Startup and cache behaviour of tracequest search / handoff (facts bks, 5vs, id4).
 * Real bin/tracequest.js invocations against an isolated HOME.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const SIDECAR = join(ROOT, "sidecar/target/release/tracequest-sidecar");
const NO_SIDECAR = existsSync(SIDECAR) ? false : "sidecar not built (npm run build:sidecar)";

function claudeSession(home, project, name, text) {
  const file = join(home, ".claude/projects", `-home-dev-${project}`, `${name}.jsonl`);
  writeJsonl(file, [
    { type: "user", sessionId: name, cwd: `/home/dev/${project}`, timestamp: "2026-05-01T00:00:00Z", uuid: `u-${name}`, message: { content: [{ type: "text", text: `Session ${name}` }] } },
    { type: "assistant", sessionId: name, timestamp: "2026-05-01T00:00:01Z", uuid: `a-${name}`, message: { model: "claude-sonnet-4-20250514", content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } } },
  ]);
  return file;
}

function codexSession(home, name, cwd) {
  const file = join(home, ".codex/sessions/2026/05/01", `rollout-2026-05-01T00-00-00-${name}.jsonl`);
  writeJsonl(file, [
    { timestamp: "2026-05-01T00:00:00Z", type: "session_meta", payload: { id: name, cwd, model_provider: "openai" } },
    { timestamp: "2026-05-01T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: `Work on ${name}` } },
  ]);
  return file;
}

function run(home, args, { sidecar = false, nodeArgs = [], env: extraEnv = {} } = {}) {
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_CACHE_DIR: join(home, "cache"),
    TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_NO_SIDECAR: sidecar ? "" : "1",
    NO_COLOR: "1",
    ...extraEnv,
  };
  if (sidecar) env.TRACEQUEST_SIDECAR_PATH = SIDECAR;
  else delete env.TRACEQUEST_SIDECAR_PATH;
  // cwd outside any git repository: no current-repository boost.
  const r = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], { cwd: home, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${args.join(" ")} failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

const searchJson = (home, args, opts) => JSON.parse(run(home, ["search", ...args, "--json"], opts).stdout);

function indexedPaths(home) {
  const index = JSON.parse(readFileSync(join(home, "cache/index.json"), "utf8"));
  const idx = JSON.parse(readFileSync(join(home, "cache/search.idx"), "utf8"));
  return { index: Object.keys(index).filter((k) => !k.startsWith("_")).length, search: idx.paths.length };
}

/**
 * Two sessions of project "alpha" that rank in opposite orders by word
 * statistics of all sessions and of the alpha sessions alone: "kiwi" is common
 * across every project (beta repeats it), "lime" is common only inside alpha.
 */
function writeRankingCorpus(home) {
  claudeSession(home, "alpha", "kiwi-rich", "kiwi kiwi kiwi kiwi kiwi kiwi and one lime here");
  claudeSession(home, "alpha", "lime-rich", "lime lime lime lime lime lime and one kiwi here");
  for (let i = 0; i < 6; i++) claudeSession(home, "alpha", `alpha-filler-${i}`, `lime notes number ${i}`);
  for (let i = 0; i < 12; i++) claudeSession(home, "beta", `beta-filler-${i}`, `kiwi notes number ${i}`);
}

const order = (results) => results.map((r) => r.prompt).filter((p) => /rich/.test(p));

describe("filtered search keeps the full index", () => {
  for (const { name, sidecar, skip } of [{ name: "node indexer", sidecar: false }, { name: "sidecar", sidecar: true, skip: NO_SIDECAR }]) {
    test(`${name}: a --filter search leaves index.json and search.idx whole and ranks with the filtered sessions' statistics`, { skip }, () => {
      const home = mkTmp("tq-filter-index-");
      writeRankingCorpus(home);
      const all = order(searchJson(home, ["kiwi lime"], { sidecar }));
      const before = indexedPaths(home);
      assert.equal(before.index, 20);
      assert.equal(before.search, 20);

      const filtered = searchJson(home, ["kiwi lime", "--filter", "project:alpha"], { sidecar });
      assert.deepEqual(indexedPaths(home), before, "the filtered search must not shrink the persisted index");
      const handoff = run(home, ["handoff", "kiwi lime", "--filter", "project:alpha"], { sidecar });
      assert.match(handoff.stdout, /Results: \d+/);
      assert.deepEqual(indexedPaths(home), before, "the filtered handoff must not shrink the persisted index");

      // Ranked as if the alpha sessions were the whole corpus.
      const alphaOnly = mkTmp("tq-filter-alpha-only-");
      claudeSession(alphaOnly, "alpha", "kiwi-rich", "kiwi kiwi kiwi kiwi kiwi kiwi and one lime here");
      claudeSession(alphaOnly, "alpha", "lime-rich", "lime lime lime lime lime lime and one kiwi here");
      for (let i = 0; i < 6; i++) claudeSession(alphaOnly, "alpha", `alpha-filler-${i}`, `lime notes number ${i}`);
      const expected = order(searchJson(alphaOnly, ["kiwi lime"], { sidecar }));
      assert.deepEqual(order(filtered), expected);
      assert.notDeepEqual(order(filtered), all, "fixture: the two statistics must rank the pair differently");

      const next = run(home, ["search", "kiwi lime", "--json"], { sidecar });
      assert.match(next.stderr, /index up to date \(20 sessions, 20 cached\)/, `the next unfiltered search re-indexed:\n${next.stderr}`);
    });
  }
});

describe("scan meta cache", { skip: NO_SIDECAR }, () => {
  const projects = (home) => Object.fromEntries(
    JSON.parse(run(home, ["list", "--json"], { sidecar: true }).stdout).map((s) => [s.path, s.project]),
  );

  test("scan meta cache: a repeat scan takes an unchanged Codex file's project from scan-meta.json and re-reads a changed one", () => {
    const home = mkTmp("tq-scan-meta-");
    const a = codexSession(home, "a", "/home/dev/apple");
    const b = codexSession(home, "b", "/home/dev/banana");
    const first = projects(home);
    assert.deepEqual([first[a], first[b]], ["apple", "banana"]);
    const cachePath = join(home, "cache/scan-meta.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const root = Object.keys(cache.codex)[0];
    assert.deepEqual(Object.keys(cache.codex[root]).sort(), [a, b].sort());

    // Same output from the cache as from reading every file.
    assert.deepEqual(projects(home), first);

    // A cached project is used while size and mtime match: the file is not read.
    // (Edited as text: the nanosecond mtimes do not survive a JS number round trip.)
    const raw = readFileSync(cachePath, "utf8");
    assert.equal(raw.split('"apple"]').length, 2);
    writeFileSync(cachePath, raw.replace('"apple"]', '"from-cache"]'));
    assert.equal(projects(home)[a], "from-cache");

    // A changed mtime re-reads the file.
    const { mtime } = statSync(a);
    utimesSync(a, mtime, new Date(mtime.getTime() + 5000));
    assert.equal(projects(home)[a], "apple");
  });
});

describe("search startup", () => {
  test("search loads only search modules: no renderer, server, share, standup, import or usage-limit module", { skip: typeof nodeModule.registerHooks === "function" ? false : "module.registerHooks unavailable" }, () => {
    const home = mkTmp("tq-search-startup-");
    claudeSession(home, "alpha", "one", "kiwi lime");
    const log = join(home, "loaded.txt");
    const hook = join(home, "hook.mjs");
    writeFileSync(hook, `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const urls = [];
registerHooks({ load(url, context, next) { urls.push(url); return next(url, context); } });
process.on("exit", () => writeFileSync(process.env.TQ_LOADED_LOG, urls.join("\\n")));
`);
    const loadedFor = (args) => {
      run(home, args, { nodeArgs: ["--import", hook], env: { TQ_LOADED_LOG: log } });
      return readFileSync(log, "utf8").split("\n").filter((u) => u.includes("/src/")).map((u) => u.slice(u.indexOf("/src/") + 1));
    };
    const forbidden = /^src\/(render\.js|render\/|server\.js|server\/(?!server-session-path\.js)|share\/|standup\/(?!agent-runner\.js)|import\/|usage\/|export\/|chapters\/)/;
    for (const args of [["search", "kiwi lime"], ["handoff", "kiwi lime"]]) {
      const loaded = loadedFor(args);
      assert.ok(loaded.includes("src/cli/cli-search.js"), `${args[0]}: cli-search.js not loaded`);
      assert.deepEqual(loaded.filter((m) => forbidden.test(m)), [], `${args[0]} loaded modules it does not need`);
      assert.ok(!loaded.includes("src/cli/cli-commands.js"), `${args[0]} loaded cli-commands.js`);
    }
  });
});
