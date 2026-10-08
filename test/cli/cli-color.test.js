import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { k, isColorEnabled, setColorEnabled } from "../../src/cli/cli-color.js";

function fakeStream(isTTY) {
  return { isTTY };
}

afterEach(() => {
  setColorEnabled(null); // return to auto-detection
  delete process.env.NO_COLOR;
  delete process.env.FORCE_COLOR;
});

describe("cli-color NO_COLOR / TTY gating (fact color-gating)", () => {
  test("explicit override wins over everything", () => {
    process.env.NO_COLOR = "1";
    setColorEnabled(true);
    assert.equal(isColorEnabled(fakeStream(false)), true);
    setColorEnabled(false);
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    assert.equal(isColorEnabled(fakeStream(true)), false);
  });

  test("NO_COLOR (any value) disables color even on a TTY", () => {
    process.env.NO_COLOR = "";
    assert.equal(isColorEnabled(fakeStream(true)), false);
    process.env.NO_COLOR = "anything";
    assert.equal(isColorEnabled(fakeStream(true)), false);
  });

  test("FORCE_COLOR forces color on for a non-TTY stream", () => {
    process.env.FORCE_COLOR = "1";
    assert.equal(isColorEnabled(fakeStream(false)), true);
    process.env.FORCE_COLOR = "0";
    assert.equal(isColorEnabled(fakeStream(true)), false);
  });

  test("auto: color only when the stream is a TTY", () => {
    assert.equal(isColorEnabled(fakeStream(true)), true);
    assert.equal(isColorEnabled(fakeStream(false)), false);
  });

  test("k.* emits ANSI when enabled and plain text when disabled", () => {
    setColorEnabled(true);
    assert.equal(k.red("x"), "\x1b[31mx\x1b[0m");
    assert.equal(k.bold("y"), "\x1b[1my\x1b[0m");
    setColorEnabled(false);
    assert.equal(k.red("x"), "x");
    assert.equal(k.bold("y"), "y");
    assert.equal(k.dim("z"), "z");
  });
});
