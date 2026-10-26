/**
 * Near-words re-rank scan in the sidecar (search-perf facts): the sidecar
 * `near` scan gives bit-identical scores to the JS scan of nearTermScorer over
 * generated session files full of edge cases (case variants, camelCase and
 * prefix boundaries, verbatim copies, recorded searches, Codex injected lines,
 * latin1 bytes, the 8 MB scan cap, unreadable files), and the JS fallback
 * gives the same scores when the sidecar is unavailable.
 */
import "../helpers/skip-lr-watch-env.js";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp } from "../helpers/fixtures.js";
import { nearTermScorer } from "../../src/sessions/scan-queries.js";
import { sidecarNearScan } from "../../src/sessions/near-sidecar.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SIDECAR = join(ROOT, "sidecar/target/release/tracequest-sidecar");
const CAP = 8 * 1024 * 1024;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = [
  "codex", "Codex", "CODEX", "stop", "Stop", "STOP", "button", "Button", "BUTTON", "buttons", "stopped",
  "codexStop", "CodexStopButton", "stop-button", "stop_button", "xcodex", "codex2", "über", "Über", "ÜBER",
  "café", "CAFÉ", "run", "the", "alpha", "beta", "a-a-a", "b",
];
const COPIES = [
  "codex stop button", "\"Codex Stop-button\"", "tracequest search \"codex stop button\"", "handoff codex stop button",
  "research codex stop button", "search\\\"codex stop button", "SEARCH  'codex stop button", "searchcodex stop button",
  "über café stop", "Über Café stop", "my-search codex stop button", "search codex stop button",
];
const SEPS = [" ", " ", " ", "  ", ".", "\\n", ", ", "-", " ".repeat(10), ".".repeat(20), " ".repeat(30), "\t"];
const RAW = [
  Buffer.from([0xc0]), Buffer.from([0xa0]), Buffer.from([0xd7]), Buffer.from([0xde, 0x41]), Buffer.from([0xff]),
  // Latin1 text (not UTF-8): a search with a no-break space, and copies whose first word (not a query word) only
  // matches the verbatim query after latin1 lowercasing.
  Buffer.from("search\u00a0codex stop button", "latin1"), Buffer.from("handoff \u00a0\"codex stop button", "latin1"),
  Buffer.from("Z\u00dcZ stop button", "latin1"), Buffer.from("z\u00fcz STOP BUTTON", "latin1"), Buffer.from("z\u00d7 stop button", "latin1"),
  Buffer.from("z\u00f7 stop button", "latin1"),
];
const CODEX_HEADS = [
  '{"type":"session_meta","payload":{"instructions":"',
  '{"type":"turn_context","payload":{"text":"',
  '{"type":"response_item","payload":{"role":"developer","content":[{"text":"',
  '{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"<env>',
  '{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions ',
  '{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"',
  '{"type":"event_msg","payload":{"message":"',
  `{"pad":"${"x".repeat(420)}","type":"turn_context","text":"`,
];

function fragments(rand, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = rand();
    if (r < 0.55) out.push(Buffer.from(WORDS[Math.floor(rand() * WORDS.length)]));
    else if (r < 0.62) out.push(Buffer.from(COPIES[Math.floor(rand() * COPIES.length)]));
    else if (r < 0.66) out.push(RAW[Math.floor(rand() * RAW.length)]);
    out.push(Buffer.from(SEPS[Math.floor(rand() * SEPS.length)]));
  }
  return out;
}

function codexBody(rand, lines) {
  const out = [];
  for (let i = 0; i < lines; i++) {
    out.push(Buffer.from(CODEX_HEADS[Math.floor(rand() * CODEX_HEADS.length)]), ...fragments(rand, 5 + Math.floor(rand() * 40)), Buffer.from('"}}\n'));
  }
  return Buffer.concat(out);
}

/** Sessions of every scanned file shape; returns { sessions, dir }. */
function writeCorpus() {
  const dir = mkTmp("tracequest-near-sidecar-");
  const rand = rng(57);
  const sessions = [];
  for (let i = 0; i < 160; i++) {
    const source = ["claude", "codex", "codex", "factory"][i % 4];
    const path = join(dir, `${source}-${i}.jsonl`);
    const body = source === "codex" ? codexBody(rand, 3 + Math.floor(rand() * 60)) : Buffer.concat(fragments(rand, 20 + Math.floor(rand() * 1500)));
    writeFileSync(path, body);
    sessions.push({ path, source });
  }
  for (const source of ["grok", "vktr"]) {
    const sdir = join(dir, `${source}-session`);
    mkdirSync(sdir);
    writeFileSync(join(sdir, "chat_history.jsonl"), Buffer.concat(fragments(rand, 800)));
    sessions.push({ path: sdir, source });
  }
  // Words together across the 8 MB scan cap, and the final word cut by it.
  const filler = Buffer.alloc(CAP - 12, 0x20);
  writeFileSync(join(dir, "cap-across.jsonl"), Buffer.concat([Buffer.from("codex stop button "), filler, Buffer.from("codex stop button and more codex stop")]));
  sessions.push({ path: join(dir, "cap-across.jsonl"), source: "claude" });
  writeFileSync(join(dir, "cap-cut.jsonl"), Buffer.concat([Buffer.alloc(CAP - 15, 0x2e), Buffer.from("codex stop butt"), Buffer.from("on")]));
  sessions.push({ path: join(dir, "cap-cut.jsonl"), source: "claude" });
  // Unreadable: a missing file, and a directory where a file should be.
  sessions.push({ path: join(dir, "missing.jsonl"), source: "claude" });
  mkdirSync(join(dir, "a-dir.jsonl"));
  sessions.push({ path: join(dir, "a-dir.jsonl"), source: "claude" });
  writeFileSync(join(dir, "empty.jsonl"), "");
  sessions.push({ path: join(dir, "empty.jsonl"), source: "codex" });
  return { sessions, dir };
}

const term = (queryToken, extra = []) => ({ queryToken, matches: [{ term: queryToken }, ...extra.map((t) => ({ term: t }))] });

/** Scorer inputs as rerankCandidates builds them: resolved terms, IDF weights, distinct words, final token, verbatim query. */
const SPECS = [
  { name: "three words with a verbatim copy", args: [[term("codex", ["codex2"]), term("stop", ["stopped"]), term("button", ["buttons"])], [1.0986122886681098, 2.4849066497880004, 0.6931471805599453], [0, 1, 2], "button", "codex stop button"] },
  { name: "no verbatim, final word as a prefix", args: [[term("codex"), term("stop"), term("butt")], [0.287682072451781, 3.1354942159291497, 1.791759469228055], [0, 1, 2], "butt", null] },
  { name: "a common word left out", args: [[term("the"), term("stop"), term("button"), term("run")], [0.01, 1.3862943611198906, 2.0794415416798357, 0.4054651081081644], [1, 2, 3], "run", "the stop button run"] },
  { name: "non-ascii words and verbatim", args: [[term("über"), term("café"), term("stop")], [1.9459101090932196, 0.8472978603872037, 1.252762968495368], [0, 1, 2], "stop", "über café stop"] },
  { name: "punctuated verbatim", args: [[term("codex"), term("stop"), term("button")], [0.7, 0.2, 0.1], [0, 1, 2], "button", "codex stop-button"] },
  { name: "latin1 uppercase verbatim word", args: [[term("x"), term("stop"), term("button")], [0.9, 1.1, 1.3], [1, 2], "button", "z\u00fcz stop button"] },
  { name: "latin1 sign verbatim word", args: [[term("x"), term("stop"), term("button")], [0.9, 1.1, 1.3], [1, 2], "button", "z\u00d7 stop button"] },
  { name: "self-overlapping needle", args: [[term("a-a"), term("b")], [0.3, 0.6], [0, 1], "b", null] },
];

describe("near-words re-rank scan in the sidecar", { skip: existsSync(SIDECAR) ? false : "sidecar not built (npm run build:sidecar)" }, () => {
  let corpus;
  const saved = {};
  before(() => {
    for (const k of ["TRACEQUEST_NO_SIDECAR", "TRACEQUEST_SIDECAR_PATH"]) saved[k] = process.env[k];
    corpus = writeCorpus();
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    rmSync(corpus.dir, { recursive: true, force: true });
  });

  test("sidecar near scan scores equal the JS scan bit for bit", () => {
    delete process.env.TRACEQUEST_NO_SIDECAR;
    process.env.TRACEQUEST_SIDECAR_PATH = SIDECAR;
    const probe = sidecarNearScan(
      { needles: [{ q: 0, bytes: Buffer.from("stop"), prefix: false }], weights: [1], verbatim: null, verbatimWords: null, gap: 24, maxBytes: CAP },
      corpus.sessions.slice(0, 2).map((s) => [s.path, s.source === "codex"]),
    );
    assert.ok(Array.isArray(probe) && probe.length === 2, "the sidecar answers the near op");
    for (const { name, args } of SPECS) {
      const scorer = nearTermScorer(...args);
      const js = corpus.sessions.map((s) => scorer.score(s));
      const viaSidecar = scorer.scoreMany(corpus.sessions);
      const differing = js.flatMap((v, i) => (Object.is(v, viaSidecar[i]) ? [] : [`${corpus.sessions[i].path}: js ${v} sidecar ${viaSidecar[i]}`]));
      assert.deepEqual(differing, [], `${name}: scores differ`);
      assert.ok(js.filter((v) => v > 0).length >= 20, `${name}: the corpus exercises the scorer (${js.filter((v) => v > 0).length} non-zero)`);
    }
  });

  test("without the sidecar the JS fallback gives the same scores", () => {
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    const scorer = nearTermScorer(...SPECS[0].args);
    process.env.TRACEQUEST_SIDECAR_PATH = SIDECAR;
    delete process.env.TRACEQUEST_NO_SIDECAR;
    const viaSidecar = scorer.scoreMany(corpus.sessions);
    process.env.TRACEQUEST_NO_SIDECAR = "1";
    const fallback = scorer.scoreMany(corpus.sessions);
    assert.deepEqual(fallback, viaSidecar);
  });
});
