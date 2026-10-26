/**
 * Search terms of sessions indexed by the sidecar (facts ln2, r7r): search.idx
 * holds the JS indexer's words and counts for them, in full and delta runs, so
 * search ranks the same with and without the sidecar; a format 4 search.idx,
 * which can hold the sidecar's own terms, is rebuilt.
 * Real bin/tracequest.js invocations against an isolated HOME.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const SIDECAR = join(ROOT, "sidecar/target/release/tracequest-sidecar");

/** A file read by the agent, as a Claude tool result: long enough that the sidecar's own terms leave it out. */
function readResult(uuid, word) {
  const text = Array.from({ length: 80 }, (_, i) => `${i + 1}\t${word}${i % 7} line of the file`).join("\n");
  return {
    type: "user", sessionId: "s1", timestamp: "2026-06-03T12:00:03.000Z", uuid, sourceToolAssistantUUID: "a1",
    message: { role: "user", content: [{ tool_use_id: `t-${uuid}`, type: "tool_result", content: text }] },
  };
}

function claudeLines(sidechain) {
  return [
    {
      type: "user", sessionId: "s1", cwd: "/home/dev/alpha", timestamp: "2026-06-03T12:00:00.000Z", uuid: "u1",
      isSidechain: sidechain, message: { role: "user", content: [{ type: "text", text: "read the deploy notes" }] },
    },
    {
      type: "assistant", sessionId: "s1", timestamp: "2026-06-03T12:00:01.000Z", uuid: "a1", isSidechain: sidechain,
      message: { model: "claude-opus-4", role: "assistant", content: [{ type: "tool_use", id: "t-r1", name: "Read", input: { file_path: "/home/dev/alpha/notes.md" } }] },
    },
    { ...readResult("r1", "zetaword"), isSidechain: sidechain },
  ];
}

function writeHome(home) {
  const dir = join(home, ".claude/projects/-home-dev-alpha");
  mkdirSync(join(dir, "s1/subagents"), { recursive: true });
  const main = join(dir, "s1.jsonl");
  const sub = join(dir, "s1/subagents/agent-a1.jsonl");
  writeJsonl(main, claudeLines(false));
  writeJsonl(sub, claudeLines(true));
  return { main, sub };
}

function run(home, cache, sidecar, args) {
  const env = { ...process.env, HOME: home, TRACEQUEST_CACHE_DIR: join(home, cache), TRACEQUEST_SKIP_LR_WATCH: "1", TRACEQUEST_NO_SIDECAR: sidecar ? "" : "1" };
  if (sidecar) env.TRACEQUEST_SIDECAR_PATH = SIDECAR;
  else delete env.TRACEQUEST_SIDECAR_PATH;
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: home, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${args.join(" ")} failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return r;
}

/** search.idx as { format, terms: { path: { word: count } } }. */
function readTerms(home, cache) {
  const idx = JSON.parse(readFileSync(join(home, cache, "search.idx"), "utf8"));
  const terms = Object.fromEntries(idx.paths.map((p) => [p, {}]));
  idx.vocab.forEach((word, vi) => {
    const e = idx.postings[vi] || [];
    for (let i = 0; i < e.length; i += 2) terms[idx.paths[e[i]]][word] = e[i + 1];
  });
  return { format: idx._sv, terms };
}

const skip = existsSync(SIDECAR) ? false : "sidecar not built (npm run build:sidecar)";

describe("search terms of sessions the sidecar indexes", { skip }, () => {
  test("sidecar index search terms equal the JS indexer's in full and delta runs", () => {
    const home = mkTmp("tq-sidecar-terms-");
    const { main, sub } = writeHome(home);
    const sc = run(home, "c-sc", true, ["search", "zetaword3", "--json"]);
    assert.match(sc.stderr, /via sidecar/);
    run(home, "c-js", false, ["search", "zetaword3", "--json"]);
    const viaSidecar = readTerms(home, "c-sc");
    assert.deepEqual(viaSidecar.terms, readTerms(home, "c-js").terms);
    assert.equal(viaSidecar.terms[main].zetaword3, 11);
    assert.deepEqual(JSON.parse(sc.stdout).map((r) => r.path).sort(), [main, sub].sort());

    // Appended lines: the sidecar re-reads the changed session in a delta run.
    appendFileSync(main, `${JSON.stringify(readResult("r2", "omegaword"))}\n`);
    const delta = run(home, "c-sc", true, ["search", "omegaword5", "--json"]);
    assert.match(delta.stderr, /via sidecar \(delta/);
    run(home, "c-js", false, ["search", "omegaword5", "--json"]);
    assert.deepEqual(readTerms(home, "c-sc").terms, readTerms(home, "c-js").terms);
    assert.deepEqual(JSON.parse(delta.stdout).map((r) => r.path), [main]);
  });

  test("search index format 4 is rebuilt with the JS indexer's terms", () => {
    const home = mkTmp("tq-sidecar-terms-format-");
    writeHome(home);
    run(home, "c-js", false, ["search", "zetaword3", "--json"]);
    const expected = readTerms(home, "c-js");
    assert.equal(expected.format, 5);
    for (const sidecar of [true, false]) {
      const cache = sidecar ? "c-old-sc" : "c-old-js";
      run(home, cache, sidecar, ["search", "zetaword3", "--json"]);
      // A format 4 index whose sessions hold other terms, as the sidecar's own terms are.
      const idxPath = join(home, cache, "search.idx");
      const idx = JSON.parse(readFileSync(idxPath, "utf8"));
      idx._sv = 4;
      idx.postings = idx.postings.map(() => []);
      idx.vocab.push("oldsidecarword");
      idx.postings.push(idx.paths.flatMap((_, i) => [i, 1]));
      writeFileSync(idxPath, JSON.stringify(idx));
      writeFileSync(join(dirname(idxPath), "search.bin"), "");
      const r = run(home, cache, sidecar, ["search", "zetaword3", "--json"]);
      assert.equal(JSON.parse(r.stdout).length, 2, `${cache}: both sessions are found again`);
      assert.deepEqual(readTerms(home, cache), expected, cache);
    }
  });
});
