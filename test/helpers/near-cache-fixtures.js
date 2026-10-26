/**
 * Sessions and query terms for the near-words cache tests (search-perf facts).
 * The expected scores in test/bin/near-cache.test.js were computed from these
 * fixtures with the uncached nearTermScorer of 29b56c6.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** "codex stop button": the last word matches as a prefix, like its BM25 expansion. */
export const NEAR_QUERY = {
  resolvedTerms: [
    { queryToken: "codex", matches: [{ term: "codex", weight: 1 }] },
    { queryToken: "stop", matches: [{ term: "stop", weight: 1 }, { term: "stopped", weight: 0.5 }] },
    { queryToken: "button", matches: [{ term: "button", weight: 1 }, { term: "buttons", weight: 0.5 }] },
  ],
  distinct: [0, 1, 2],
  finalToken: "button",
  verbatim: "codex stop button",
};
export const NEAR_WEIGHTS = [1.7, 0.9, 2.3];
export const NEAR_WEIGHTS_2 = [0.4, 3.1, 1.2];

const filler = (i) => `filler line ${i} about the deploy job, the release notes and the owners of the checklist`;

function claudeLine(i, text) {
  return JSON.stringify({ type: i % 2 ? "assistant" : "user", uuid: `u-${i}`, timestamp: "2026-06-03T12:00:00.000Z", message: { content: [{ type: "text", text }] } });
}

/** Claude session: words together in their own forms, camelCase, upper case, one recorded search, words far apart. */
export function claudeLines() {
  const lines = [];
  for (let i = 0; i < 40; i++) {
    let text = filler(i);
    if (i % 7 === 0) text += " Pressing the Stop button of the Codex run needs one click.";
    if (i % 11 === 0) text += " codexStopButton STOP Buttons CODEX";
    if (i === 13) text += " ran tracequest search \"codex stop button\" again";
    if (i === 17) text += " codex was fine. Much later, with lots of words in between that keep them apart, a stop. Then a button.";
    if (i === 19) text += " the stopped buttons";
    if (i === 23) text += " codex stopped";
    lines.push(claudeLine(i, text));
  }
  return lines;
}

/** Codex session: query words in its own injected lines (ignored) and in the work. */
export function codexLines() {
  return [
    JSON.stringify({ type: "session_meta", payload: { instructions: "codex stop button codex stop button" } }),
    JSON.stringify({ type: "turn_context", payload: { note: "the codex stop button" } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>codex stop button</environment_context>" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "the codex buttons hang after a stop" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "The Stop button in Codex now cancels the turn; codex buttons stopped flickering." }] } }),
  ];
}

/** Grok-format chat history: words together twice. */
export function grokLines() {
  return [
    JSON.stringify({ type: "user", content: "why does the stop button do nothing in codex, the buttons are fine" }),
    JSON.stringify({ type: "assistant", content: "The Codex Stop button sends an interrupt; the stop of codex is quick." }),
  ];
}

/** Write the four sessions under dir; returns session objects as discovery gives them. */
export function writeNearSessions(dir) {
  mkdirSync(join(dir, "claude"), { recursive: true });
  mkdirSync(join(dir, "codex"), { recursive: true });
  mkdirSync(join(dir, "grok", "s1"), { recursive: true });
  const claude = join(dir, "claude", "s1.jsonl");
  const codex = join(dir, "codex", "rollout-s1.jsonl");
  const grokDir = join(dir, "grok", "s1");
  writeFileSync(claude, `${claudeLines().join("\n")}\n`);
  writeFileSync(codex, `${codexLines().join("\n")}\n`);
  writeFileSync(join(grokDir, "chat_history.jsonl"), `${grokLines().join("\n")}\n`);
  // Never all three words together: its best run depends on the word weights.
  const partial = join(dir, "claude", "s2.jsonl");
  writeFileSync(partial, `${[claudeLine(0, `${filler(0)} the stop button`), claudeLine(1, `${filler(1)} codex stopped, codex`)].join("\n")}\n`);
  return [
    { path: claude, source: "claude" },
    { path: codex, source: "codex" },
    { path: grokDir, source: "grok" },
    { path: partial, source: "claude" },
  ];
}

/** Text appended to the Claude session to change its score. */
export const CLAUDE_APPEND = `${claudeLine(99, "the Stop button and its stop buttons")}\n`;

/** A large Claude session (~bytes) with words together now and then. */
export function bigClaudeBody(bytes, seed) {
  const lines = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    let text = `${filler(i + seed)} ${"lorem ipsum dolor sit amet ".repeat(8)}`;
    if (i % 50 === seed % 50) text += " the codex stop button";
    if (i % 23 === 0) text += " stop and button";
    const line = claudeLine(i, text);
    lines.push(line);
    size += line.length + 1;
  }
  return `${lines.join("\n")}\n`;
}
