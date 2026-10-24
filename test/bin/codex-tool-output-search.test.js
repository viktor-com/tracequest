/**
 * Quoted-phrase search over Codex tool output (facts alq, l5g, qy2).
 * Real bin/tracequest.js invocations against an isolated HOME, with the Node
 * indexer and, when it is built, the sidecar.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const SIDECAR = join(ROOT, "sidecar/target/release/tracequest-sidecar");
const PHRASE = "cannot contain whitespace";
const CWD = "/home/dev/phraseproj";

function rollout(id, items) {
  return [
    { timestamp: "2026-05-01T00:00:00Z", type: "session_meta", payload: { id, cwd: CWD, model_provider: "openai" } },
    { timestamp: "2026-05-01T00:00:01Z", type: "event_msg", payload: { type: "user_message", message: `Tag the facts for ${id}` } },
    ...items.map((payload, i) => ({ timestamp: `2026-05-01T00:01:${String(i).padStart(2, "0")}Z`, type: "response_item", payload })),
  ];
}

function call(callId) {
  return { type: "function_call", name: "exec_command", call_id: callId, arguments: JSON.stringify({ cmd: "facts add --tags 'spec cursor'" }) };
}

function writeSessions(home) {
  const dir = join(home, ".codex/sessions/2026/05/01");
  const paths = {
    short: join(dir, "rollout-2026-05-01T00-00-00-short.jsonl"),
    tail: join(dir, "rollout-2026-05-01T00-00-01-tail.jsonl"),
    words: join(dir, "rollout-2026-05-01T00-00-02-words.jsonl"),
  };
  // The phrase is only in a short function_call_output; the assistant uses its words apart.
  writeJsonl(paths.short, rollout("short", [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "A tag cannot hold spaces; the list may contain tabs or whitespace." }] },
    call("c1"),
    { type: "function_call_output", call_id: "c1", output: `Exit code: 1\nWall time: 0.1 seconds\nOutput:\nError: tag 'spec cursor' ${PHRASE}\n` },
  ]));
  // The phrase ends a custom tool output far longer than the indexed head.
  writeJsonl(paths.tail, rollout("tail", [
    call("c2"),
    { type: "custom_tool_call_output", call_id: "c2", output: `${"ok filler line\n".repeat(400)}Error: tag 'spec ui' ${PHRASE}\n` },
  ]));
  // Every word of the phrase, never the phrase.
  writeJsonl(paths.words, rollout("words", [
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "The parser cannot cope; names contain dashes and whitespace." }] },
  ]));
  return paths;
}

function search(home, query, sidecar) {
  const env = {
    ...process.env,
    HOME: home,
    TRACEQUEST_CACHE_DIR: join(home, "cache"),
    TRACEQUEST_SKIP_LR_WATCH: "1",
    TRACEQUEST_NO_SIDECAR: sidecar ? "" : "1",
  };
  if (sidecar) env.TRACEQUEST_SIDECAR_PATH = SIDECAR;
  else delete env.TRACEQUEST_SIDECAR_PATH;
  const r = spawnSync(process.execPath, [BIN, "search", query, "--json"], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `search failed\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  return { results: JSON.parse(r.stdout), stderr: r.stderr };
}

const INDEXERS = [
  { name: "node indexer", sidecar: false },
  { name: "sidecar", sidecar: true, skip: existsSync(SIDECAR) ? false : "sidecar not built (npm run build:sidecar)" },
];

for (const { name, sidecar, skip } of INDEXERS) {
  describe(`quoted phrase search (${name})`, { skip }, () => {
    test("codex tool output phrase is found in short and long outputs, with the phrase as the first snippet", () => {
      const home = mkTmp("tq-codex-phrase-");
      const paths = writeSessions(home);
      const { results, stderr } = search(home, `"${PHRASE}"`, sidecar);
      if (sidecar) assert.match(stderr, /via sidecar/);
      assert.deepEqual(results.map((r) => r.path).sort(), [paths.short, paths.tail].sort());
      for (const r of results) assert.ok(r.matches[0].snippet.includes(PHRASE), `first snippet of ${r.path}: ${r.matches[0].snippet}`);
    });

    test("phrase-only snippets are phrase occurrences, not the phrase's separate words", () => {
      const home = mkTmp("tq-codex-phrase-snips-");
      const paths = writeSessions(home);
      const short = search(home, `"${PHRASE}"`, sidecar).results.find((r) => r.path === paths.short);
      assert.ok(short, "session with the phrase is found");
      for (const m of short.matches) assert.ok(m.snippet.includes(PHRASE), `snippet without the phrase: ${m.snippet}`);
      const mixed = search(home, `"${PHRASE}" tabs`, sidecar).results.find((r) => r.path === paths.short);
      assert.ok(mixed.matches.some((m) => m.snippet.includes("tabs")), "an unquoted term still gets its snippet");
    });
  });
}

test("search.idx from before codex tool output indexing is rebuilt, so the phrase is found", () => {
  const home = mkTmp("tq-codex-phrase-upgrade-");
  const paths = writeSessions(home);
  assert.equal(search(home, `"${PHRASE}"`, false).results.length, 2);
  // An index written by a version that did not tokenize tool output: format 3, no phrase words.
  const idxPath = join(home, "cache/search.idx");
  const idx = JSON.parse(readFileSync(idxPath, "utf8"));
  idx._sv = 3;
  for (const word of ["cannot", "contain", "whitespace"]) {
    const vi = idx.vocab.indexOf(word);
    if (vi >= 0) idx.postings[vi] = [];
  }
  writeFileSync(idxPath, JSON.stringify(idx));
  const { results } = search(home, `"${PHRASE}"`, false);
  assert.deepEqual(results.map((r) => r.path).sort(), [paths.short, paths.tail].sort());
});
