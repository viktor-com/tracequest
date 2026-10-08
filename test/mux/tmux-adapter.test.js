/**
 * tmux adapter unit/integration tests on a private tmux server
 * (TRACEQUEST_TMUX_SOCKET) — never touches the user's default tmux.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SKIP_NO_TMUX, TMUX } from "../helpers/tmux-gate.js";
import {
  available,
  capturePane,
  ensureSession,
  killWindow,
  listWindows,
  newWindow,
  sendKeys,
  tmuxSession,
} from "../../src/mux/tmux.js";

const SOCKET = `tq-test-${process.pid}`;
const SESSION = `tq-adapter-${process.pid}`;
const ENV_KEYS = ["TRACEQUEST_TMUX_BIN", "TRACEQUEST_TMUX_SOCKET", "TRACEQUEST_TMUX_SESSION"];
const savedEnv = {};

before(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  delete process.env.TRACEQUEST_TMUX_BIN;
  process.env.TRACEQUEST_TMUX_SOCKET = SOCKET;
  process.env.TRACEQUEST_TMUX_SESSION = SESSION;
});

after(() => {
  // ALWAYS tear down the private tmux server for this socket.
  if (TMUX) {
    try {
      spawnSync(TMUX.bin, ["-L", SOCKET, "kill-server"], { stdio: "ignore" });
    } catch {
      // best-effort cleanup
    }
  }
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** Raw tmux probe on the private socket, independent of the adapter. */
function rawTmux(args) {
  return spawnSync(TMUX.bin, ["-L", SOCKET, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

async function waitFor(predicate, { timeoutMs = 5_000, intervalMs = 50, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("tmux adapter", () => {
  test("available() is false and never throws when the tmux binary does not run", () => {
    process.env.TRACEQUEST_TMUX_BIN = "/nonexistent-tracequest-tmux";
    try {
      let result;
      assert.doesNotThrow(() => {
        result = available();
      });
      assert.equal(result, false);
    } finally {
      delete process.env.TRACEQUEST_TMUX_BIN;
    }
  });

  test("available() is true on a tmux-equipped machine", SKIP_NO_TMUX, () => {
    assert.equal(available(), true);
  });

  test("tmuxSession() reflects TRACEQUEST_TMUX_SESSION override", () => {
    assert.equal(tmuxSession(), SESSION);
  });

  test("ensureSession creates the session detached and is idempotent", SKIP_NO_TMUX, () => {
    assert.equal(ensureSession(), SESSION);
    assert.equal(rawTmux(["has-session", "-t", `=${SESSION}`]).status, 0);

    const windowsBefore = listWindows();
    assert.equal(ensureSession(), SESSION, "second ensureSession reuses the session");

    const sessions = String(rawTmux(["list-sessions", "-F", "#{session_name}"]).stdout || "")
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(sessions, [SESSION], "ensureSession must not create a second session");
    assert.deepEqual(listWindows(), windowsBefore, "existing session reused untouched");
  });

  test("listWindows lists session windows and answers [] for a missing session", SKIP_NO_TMUX, () => {
    ensureSession();
    const windows = listWindows();
    assert.ok(windows.length >= 1, "fresh session has its initial window");
    for (const w of windows) {
      assert.match(w.id, /^@\d+$/);
      assert.equal(typeof w.name, "string");
      assert.equal(typeof w.dead, "boolean");
    }
    assert.deepEqual(listWindows(`${SESSION}-no-such-session`), []);
  });

  test("newWindow/capturePane/killWindow round-trip", SKIP_NO_TMUX, async () => {
    ensureSession();
    const marker = `tq-roundtrip-${process.pid}`;
    const id = newWindow({
      argv: ["sh", "-c", `echo ${marker}; sleep 30`],
      cwd: tmpdir(),
      name: "tq-rt",
    });
    assert.match(id, /^@\d+$/);

    const listed = listWindows().find((w) => w.id === id);
    assert.ok(listed, "new window appears in listWindows");
    assert.equal(listed.name, "tq-rt");

    await waitFor(() => capturePane(id).includes(marker), { label: "marker in capture-pane" });

    killWindow(id);
    assert.equal(
      listWindows().some((w) => w.id === id),
      false,
      "killed window is gone from listWindows",
    );
  });

  test("finished window stays viewable via remain-on-exit", SKIP_NO_TMUX, async () => {
    ensureSession();
    const marker = `tq-exited-${process.pid}`;
    // Instant exit: the window must survive (remain-on-exit precedes the
    // command), even when the command finishes before set-option could
    // have run post-spawn.
    const instant = newWindow({ argv: ["sh", "-c", "true"] });
    await waitFor(
      () => (listWindows().find((w) => w.id === instant) || {}).dead === true,
      { label: "instant-exit window pane_dead" },
    );
    killWindow(instant);

    const id = newWindow({ argv: ["sh", "-c", `echo ${marker}; sleep 1`] });
    await waitFor(
      () => (listWindows().find((w) => w.id === id) || {}).dead === true,
      { label: "window pane_dead" },
    );
    assert.ok(
      capturePane(id, { withHistory: true }).includes(marker),
      "exited window output still capturable",
    );
    killWindow(id);
  });

  test("capturePane withHistory succeeds on a dead pane with >1.5MB SGR-dense scrollback", SKIP_NO_TMUX, async () => {
    // MUX-001 regression: a dead pane's full-history capture (-S -) at the
    // default history-limit with SGR-dense output exceeds Node's 1MB
    // execFileSync default maxBuffer — without tmuxExec's generous
    // maxBuffer the capture throws ENOBUFS and the snapshot of an exited
    // run permanently 500s.
    ensureSession();
    // Pin the default history-limit so a user tmux.conf cannot shrink it.
    rawTmux(["set-option", "-g", "history-limit", "2500"]);
    // Every cell alternates truecolor, so capture-pane -e re-emits an SGR
    // sequence per character (~17 bytes/cell) — thousands of full lines.
    const script = [
      'line=$(printf "\\033[38;2;255;0;0mA\\033[38;2;0;255;0mB%.0s" $(seq 1 200))',
      'yes "$line" | head -n 900',
    ].join("; ");
    const id = newWindow({ argv: ["sh", "-c", script], name: "tq-sgr-dense" });
    await waitFor(
      () => (listWindows().find((w) => w.id === id) || {}).dead === true,
      { label: "SGR-dense window pane_dead", timeoutMs: 15_000 },
    );
    try {
      let capture;
      assert.doesNotThrow(() => {
        capture = capturePane(id, { withHistory: true });
      }, "full-history capture of the dead pane must not throw (ENOBUFS regression)");
      assert.ok(
        capture.length > 1.5 * 1024 * 1024,
        `capture must exceed the old 1MB ceiling (got ${capture.length} bytes)`,
      );
    } finally {
      killWindow(id);
    }
  });

  test("listWindows parses run metadata under a C/POSIX locale (no LANG/LC_*)", SKIP_NO_TMUX, () => {
    // Regression: serve started by launchd/cron has no LANG/LC_*, and a
    // C-locale tmux client replaces every control byte in list-windows
    // output with "_" — the old 0x1f field separator collapsed, run
    // parsing broke, and GET /api/runs answered []. listWindows must
    // parse exactly with a locale-scrubbed environment, including a
    // tq_cwd containing spaces.
    ensureSession();
    const cwdWithSpaces = mkdtempSync(join(tmpdir(), "tq locale dir "));
    const id = newWindow({
      argv: ["sh", "-c", "sleep 30"],
      cwd: tmpdir(),
      name: "tq-locale",
      userOptions: {
        tq_agent: "claude",
        tq_cwd: cwdWithSpaces,
        tq_started: "2026-08-10T00:00:00.000Z",
      },
    });
    const localeKeys = Object.keys(process.env).filter((k) => k === "LANG" || k.startsWith("LC_"));
    const savedLocale = {};
    for (const key of localeKeys) {
      savedLocale[key] = process.env[key];
      delete process.env[key];
    }
    try {
      const listed = listWindows().find((w) => w.id === id);
      assert.ok(listed, "run window listed under C locale");
      assert.equal(listed.name, "tq-locale");
      assert.equal(listed.dead, false);
      assert.equal(listed.options.tq_agent, "claude");
      assert.equal(listed.options.tq_cwd, cwdWithSpaces, "cwd with spaces round-trips intact");
      assert.equal(listed.options.tq_started, "2026-08-10T00:00:00.000Z");
    } finally {
      for (const key of localeKeys) process.env[key] = savedLocale[key];
      killWindow(id);
      rmSync(cwdWithSpaces, { recursive: true, force: true });
    }
  });

  test("sendKeys delivers literal text as discrete argv (no shell)", SKIP_NO_TMUX, async () => {
    ensureSession();
    const id = newWindow({ argv: ["sh", "-c", "cat; sleep 30"] });
    const marker = `tq-sendkeys-$(echo injected)-${process.pid}`;
    sendKeys(id, [marker], { literal: true });
    sendKeys(id, ["Enter"]);
    await waitFor(() => capturePane(id).includes(marker), { label: "sendKeys echo" });
    assert.ok(
      !capturePane(id).includes("injected-"),
      "command substitution in text must not execute",
    );
    killWindow(id);
  });
});
