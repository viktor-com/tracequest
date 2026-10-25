import "../helpers/skip-lr-watch-env.js";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp } from "../helpers/fixtures.js";
import { scanSessionForQueries, scanSessionForQuery } from "../../src/sessions/scan-queries.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const FIXTURE = join(FIXTURES, "snippet-one-pass.jsonl");
// Recorded from the per-word scan at 29b56c6 (before the one-pass scan) over the same cases.
const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, "snippet-one-pass.expected.json"), "utf8"));
const CASES = [
  [["stop", "button", "codex", "panel"], 3], [["panel", "stop"], 3], [["panel", "stop"], 2], [["panel", "stop"], 1],
  [["keyword", "promi", "error", "path"], 3], [["zzz", "stop", "panel"], 3], [["tmp", "log", "quoted"], 3], [["stop"], 3], [["button"], 1], [["multi", "panel"], 2], [["panel", "multi"], 3], [["multi"], 1],
];

const tmp = mkTmp("tq-snippet-one-pass-");
after(() => rmSync(tmp, { recursive: true, force: true }));

test("one-pass snippets match per-word scans (claude and grok, file and line cache)", () => {
  const grokDir = join(tmp, "grok-session");
  mkdirSync(grokDir, { recursive: true });
  copyFileSync(FIXTURE, join(grokDir, "chat_history.jsonl"));
  const size = statSync(FIXTURE).size;
  let mtime = 1;
  const got = [];
  for (const source of ["claude", "grok"]) {
    for (const [words, max] of CASES) {
      for (const mode of ["file", "cached"]) {
        // A fresh mtime misses the line cache; mtime 0 reuses the lines cached by the priming call.
        const s = { path: source === "grok" ? grokDir : FIXTURE, source, size, mtime: mode === "file" ? mtime++ : 0 };
        if (mode === "cached") scanSessionForQueries(s, words, max);
        const r = words.length > 1 ? Object.fromEntries(scanSessionForQueries(s, words, max)) : scanSessionForQuery(s, words[0], max);
        got.push({ source, words, max, mode, r });
      }
    }
  }
  assert.deepEqual(got, EXPECTED);
});

test("one-pass snippet scan cost: six words cost less than three times one word", () => {
  const path = join(tmp, "big.jsonl");
  const lines = [];
  for (let i = 0; i < 8000; i++) {
    const k = i % 4;
    if (k === 0) lines.push(JSON.stringify({ type: "user", message: { content: `Line ${i}: look at the renderer and the Sidebar layout again ` + "lorem ipsum dolor sit amet ".repeat(30) } }));
    if (k === 1) lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `rg -n "Renderer${i}" src/ui --glob '*.js' && npm run build -- --mode=dev${i}` } }] } }));
    if (k === 2) lines.push(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: `/repo/src/ui/panel-${i}.js` } }] } }));
    if (k === 3) lines.push(JSON.stringify({ type: "user", toolUseResult: { stdout: "x".repeat(800), stderr: `warning: deprecated option ${i}` }, error: `exit code ${i % 7}` }));
  }
  writeFileSync(path, lines.join("\n") + "\n");
  const size = statSync(path).size;
  assert.ok(size > 4_000_000, `fixture is ${size} bytes`);
  const words = ["kubernetes", "terraform", "postgres", "graphql", "webpack", "redis"];
  let mtime = 1;
  const best = (scan) => {
    let ms = Infinity;
    for (let r = 0; r < 5; r++) {
      const t0 = performance.now();
      scan({ path, source: "claude", size, mtime: mtime++ });
      ms = Math.min(ms, performance.now() - t0);
    }
    return ms;
  };
  const one = best((s) => scanSessionForQuery(s, words[0], 3));
  const six = best((s) => scanSessionForQueries(s, words, 3));
  assert.ok(six < 3 * one, `six words ${six.toFixed(1)} ms vs one word ${one.toFixed(1)} ms`);
});
