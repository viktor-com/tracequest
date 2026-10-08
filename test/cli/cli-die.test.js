import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { die, formatCliError } from "../../src/cli/cli-die.js";
import { setColorEnabled } from "../../src/cli/cli-color.js";

// formatCliError is now NO_COLOR/TTY-gated. This file asserts the colored error
// format, so pin color ON for deterministic ANSI regardless of the test stream's
// TTY state. (The gating itself is covered by cli-color.test.js.)
setColorEnabled(true);

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function captureExit(fn) {
  const origExit = process.exit;
  const origError = console.error;
  const origLog = console.log;
  let code;
  const errors = [];
  const logs = [];
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  console.error = (...a) => errors.push(a.join(" "));
  console.log = (...a) => logs.push(a.join(" "));
  try {
    fn();
    return { threw: false, code, errors, logs };
  } catch (err) {
    if (err.message !== "process.exit") throw err;
    return { threw: true, code, errors, logs };
  } finally {
    process.exit = origExit;
    console.error = origError;
    console.log = origLog;
  }
}

describe("cli-die", () => {
  it("calls process.exit(1)", () => {
    const { threw, code } = captureExit(() => die("boom"));
    assert.equal(threw, true);
    assert.equal(code, 1);
  });

  it("formatCliError matches die stderr line", () => {
    assert.equal(formatCliError("file missing"), `${RED}Error: file missing${RESET}`);
  });

  it("writes formatted message to stderr only", () => {
    const { errors, logs } = captureExit(() => die("file missing"));
    assert.equal(errors.length, 1);
    assert.equal(logs.length, 0);
    assert.equal(errors[0], formatCliError("file missing"));
  });

  it("prefixes message with Error: and ANSI red reset", () => {
    const { errors } = captureExit(() => die("bad port"));
    assert.equal(errors[0], `${RED}Error: bad port${RESET}`);
    assert.ok(errors[0].startsWith(RED));
    assert.ok(errors[0].endsWith(RESET));
    assert.ok(errors[0].includes("Error: bad port"));
  });

  it("preserves multiline messages in stderr", () => {
    const msg = "line one\nline two\nRun 'tracequest --help' for usage.";
    const { errors } = captureExit(() => die(msg));
    assert.equal(errors[0], `${RED}Error: ${msg}${RESET}`);
  });

  it("handles empty message", () => {
    const { code, errors } = captureExit(() => die(""));
    assert.equal(code, 1);
    assert.equal(errors[0], `${RED}Error: ${RESET}`);
  });

  it("does not return after die", () => {
    let afterDie = false;
    captureExit(() => {
      die("stop");
      afterDie = true;
    });
    assert.equal(afterDie, false);
  });

  it("passes through special characters without extra formatting", () => {
    const msg = "path/to/file: ENOENT — \"quotes\" & <tags>";
    const { errors } = captureExit(() => die(msg));
    assert.equal(errors[0], `${RED}Error: ${msg}${RESET}`);
  });

  it("accepts long single-line messages", () => {
    const msg = "x".repeat(500);
    const { errors } = captureExit(() => die(msg));
    assert.equal(errors.length, 1);
    assert.ok(errors[0].includes(msg));
    assert.equal(errors[0].length, RED.length + "Error: ".length + msg.length + RESET.length);
  });
});