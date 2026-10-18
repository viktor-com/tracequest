import test from "node:test";
import assert from "node:assert/strict";
import { messagePreview } from "../../src/browser/chat-tool-groups.js";

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

test("a short message is shown whole", () => {
  assert.deepEqual(messagePreview("Fix the lock", 8, 800), { text: "Fix the lock", folded: false });
  assert.deepEqual(messagePreview(lines(8), 8, 800), { text: lines(8), folded: false });
  assert.deepEqual(messagePreview(lines(8) + "\n\n", 8, 800), { text: lines(8), folded: false }, "trailing blank lines are not a fold");
});

test("a message longer than the line limit folds to its first lines", () => {
  const pv = messagePreview(lines(40), 8, 800);
  assert.equal(pv.text, lines(8));
  assert.equal(pv.folded, true);
});

test("a message longer than the character limit folds at a word boundary", () => {
  const long = "word ".repeat(400).trim();
  const pv = messagePreview(long, 8, 800);
  assert.equal(pv.folded, true);
  assert.ok(pv.text.length <= 800);
  assert.match(pv.text, /word$/, "never cuts a word in half");
});

test("one unbroken run of characters still folds", () => {
  const pv = messagePreview("x".repeat(2000), 8, 800);
  assert.equal(pv.text.length, 800);
  assert.equal(pv.folded, true);
});
