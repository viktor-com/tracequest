import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import {
  watchDir,
  watchTree,
  watchFile,
  watchCapabilities,
  _resetFsWatchWarningsForTests,
} from "../../src/server/fs-watch.js";

afterEach(() => {
  _resetFsWatchWarningsForTests();
});

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Give a freshly-created watcher time to arm. FSEvents/inotify registration is
 * asynchronous, so a mutation issued immediately after watch() can be missed —
 * a test artifact, not a product behaviour.
 */
function settle(ms = 150) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait until `predicate()` is truthy, or fail after `timeout` ms. */
async function waitFor(predicate, message, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out waiting for: ${message}`);
}

/** An fs.watch stand-in that throws a given code on construction. */
function throwingWatch(code) {
  return () => {
    throw Object.assign(new Error(`simulated ${code}`), { code });
  };
}

/** An fs.watch stand-in that captures listeners so tests can emit synthetic events. */
function fakeWatch() {
  const calls = [];
  const impl = (target, options, listener) => {
    calls.push({ target, options, listener });
    return { close() { impl.closed++; } };
  };
  impl.calls = calls;
  impl.closed = 0;
  impl.emit = (index, eventType, filename) => calls[index].listener(eventType, filename);
  return impl;
}

describe("fs-watch facade", { concurrency: false }, () => {
  describe("watchCapabilities", () => {
    test("reports recursive support for the host platform", () => {
      const caps = watchCapabilities();
      assert.equal(caps.platform, process.platform);
      if (process.platform === "darwin" || process.platform === "win32") {
        assert.equal(caps.recursive, true, "darwin/win32 have always supported recursive watching");
      } else {
        assert.equal(typeof caps.recursive, "boolean");
      }
    });

      });

  describe("watchTree recursive fallback", () => {
    test("native recursive watching reports root-relative nested paths", async () => {
      const dir = tmpDir("tq-watch-native-");
      fs.mkdirSync(path.join(dir, "sub"), { recursive: true });
      const seen = [];
      const handle = watchTree(dir, (filename) => seen.push(filename));

      try {
        await settle();
        fs.writeFileSync(path.join(dir, "sub", "a.jsonl"), "{}");
        await waitFor(() => seen.includes(path.join("sub", "a.jsonl")), `nested path, got ${JSON.stringify(seen)}`);
      } finally {
        handle.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

                                      });

  describe("watchFile re-arm", () => {
    test("survives atomic replacement by rename", async () => {
      // Verified by hand that a plain fs.watch goes permanently silent here: the
      // post-rename write produces no event at all because the watcher is still
      // bound to the replaced inode.
      const dir = tmpDir("tq-watch-rearm-");
      const target = path.join(dir, "opencode.db");
      fs.writeFileSync(target, "v1");
      let events = 0;
      const handle = watchFile(target, () => { events++; }, { reArmDelayMs: 20 });

      try {
        await settle();
        const replacement = path.join(dir, "opencode.db.new");
        fs.writeFileSync(replacement, "v2");
        fs.renameSync(replacement, target);
        await waitFor(() => events > 0, "rename event");

        const afterRename = events;
        await new Promise((r) => setTimeout(r, 150)); // let the re-arm land
        fs.writeFileSync(target, "v3");
        await waitFor(
          () => events > afterRename,
          "a write AFTER the atomic replace must still be observed",
        );
      } finally {
        handle.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("control: a raw fs.watch DOES go silent after the same replacement", async () => {
      // Guards the test above from becoming vacuous. If this ever starts passing,
      // the platform gained inode-follow semantics and the re-arm test proves nothing.
      const dir = tmpDir("tq-watch-control-");
      const target = path.join(dir, "opencode.db");
      fs.writeFileSync(target, "v1");
      let events = 0;
      const raw = fs.watch(target, { persistent: false }, () => { events++; });

      try {
        await settle();
        const replacement = path.join(dir, "opencode.db.new");
        fs.writeFileSync(replacement, "v2");
        fs.renameSync(replacement, target);
        await waitFor(() => events > 0, "rename event on the raw watcher");

        const afterRename = events;
        await settle(200);
        fs.writeFileSync(target, "v3");
        await settle(400);
        assert.equal(events, afterRename, "raw fs.watch is expected to miss post-replacement writes");
      } finally {
        raw.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("recovers after the file is deleted and recreated much later", async () => {
      // The gap the atomic-replace test does NOT cover: the path stops existing for
      // longer than one re-arm delay (an opencode reset, a db reinstall). Without a
      // retry the watcher gives up permanently and live updates die until restart.
      const dir = tmpDir("tq-watch-recreate-");
      const target = path.join(dir, "opencode.db");
      fs.writeFileSync(target, "v1");
      let events = 0;
      const handle = watchFile(target, () => { events++; }, { reArmDelayMs: 20, maxReArmDelayMs: 40 });

      try {
        await settle();
        fs.rmSync(target);
        await settle(400); // stay deleted well beyond the initial re-arm delay
        const beforeRecreate = events;

        fs.writeFileSync(target, "v2");
        await settle(200);
        fs.writeFileSync(target, "v3");
        await waitFor(
          () => events > beforeRecreate,
          "writes to a recreated file must be observed again",
        );
      } finally {
        handle.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("watches a file that does not exist yet", async () => {
      const dir = tmpDir("tq-watch-notyet-");
      const target = path.join(dir, "later.db");
      let events = 0;
      const handle = watchFile(target, () => { events++; }, { reArmDelayMs: 20, maxReArmDelayMs: 40 });

      try {
        await settle(100);
        fs.writeFileSync(target, "v1");
        await settle(200);
        fs.writeFileSync(target, "v2");
        await waitFor(() => events > 0, "a file created after startup must still be watched");
      } finally {
        handle.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a permanently missing file settles into a backed-off retry, not a tight poll", async () => {
      const dir = tmpDir("tq-watch-gone-");
      const target = path.join(dir, "never.db");
      let attempts = 0;
      const impl = () => { attempts++; throw Object.assign(new Error("nope"), { code: "ENOENT" }); };
      const handle = watchFile(target, () => {}, { watchImpl: impl, reArmDelayMs: 10, maxReArmDelayMs: 40 });

      try {
        await settle(400);
        // Backoff 10→20→40 (capped) over 400ms allows well under 20 attempts;
        // a tight 10ms poll would be ~40.
        assert.ok(attempts < 20, `expected backed-off retries, got ${attempts} attempts`);
      } finally {
        handle.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("plain writes do not trigger a re-arm", async () => {
      const dir = tmpDir("tq-watch-nochurn-");
      const target = path.join(dir, "f.db");
      fs.writeFileSync(target, "1");
      const impl = fakeWatch();
      const handle = watchFile(target, () => {}, { watchImpl: impl, reArmDelayMs: 5 });

      try {
        impl.emit(0, "change", "f.db");
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(impl.calls.length, 1, "a change event must not re-arm the watcher");
      } finally {
        handle.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("missing file is a silent no-op with an idempotent handle", () => {
      const errorSpy = mock.method(console, "error", () => {});
      try {
        const handle = watchFile("/definitely/not/here.db", () => {});
        handle.close();
        handle.close();
        assert.deepEqual(errorSpy.mock.calls.map((c) => String(c.arguments[0])), []);
      } finally {
        errorSpy.mock.restore();
      }
    });
  });

  describe("null filename policy", () => {
    test("facade forwards a null filename instead of dropping the event", () => {
      const dir = tmpDir("tq-watch-null-");
      const impl = fakeWatch();
      const seen = [];

      try {
        const handle = watchDir(dir, (filename) => seen.push(filename), { watchImpl: impl });
        impl.emit(0, "change", null);
        assert.deepEqual(seen, [null], "null must reach the caller so it can decide");
        handle.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

      });

  describe("failure handling", () => {
    test("missing directory is a silent no-op", () => {
      const errorSpy = mock.method(console, "error", () => {});
      try {
        watchTree("/definitely/not/here", () => {}).close();
        watchDir("/definitely/not/here", () => {}).close();
        assert.deepEqual(errorSpy.mock.calls.map((c) => String(c.arguments[0])), []);
      } finally {
        errorSpy.mock.restore();
      }
    });

    test("ENOSPC warns once per process, not once per watcher", () => {
      const dir = tmpDir("tq-watch-enospc-");
      const errorSpy = mock.method(console, "error", () => {});

      try {
        for (let i = 0; i < 5; i++) watchDir(dir, () => {}, { watchImpl: throwingWatch("ENOSPC") }).close();
        const warnings = errorSpy.mock.calls.filter((c) => String(c.arguments[0]).includes("ENOSPC"));
        assert.equal(warnings.length, 1, "an exhausted watch limit must not spam the log");
        assert.match(String(warnings[0].arguments[0]), /live updates are disabled/);
      } finally {
        errorSpy.mock.restore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("resource failure yields a working no-op handle, never a throw", () => {
      const dir = tmpDir("tq-watch-emfile-");
      try {
        const handle = watchTree(dir, () => {}, { watchImpl: throwingWatch("EMFILE") });
        handle.close();
        handle.close();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a throwing listener does not kill the watcher", async () => {
      const dir = tmpDir("tq-watch-throw-");
      const errorSpy = mock.method(console, "error", () => {});
      let secondEvent = false;
      const impl = fakeWatch();

      try {
        const handle = watchDir(dir, (filename) => {
          if (filename === "boom") throw new Error("listener exploded");
          secondEvent = true;
        }, { watchImpl: impl });
        impl.emit(0, "change", "boom");
        impl.emit(0, "change", "ok");
        assert.ok(secondEvent, "the watcher must keep delivering after a listener throws");
        handle.close();
      } finally {
        errorSpy.mock.restore();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("caller null-filename policies", () => {
    test("data roots fail open on null; src hot-reload fails closed", async () => {
      const { shouldTriggerDataUpdate, isSrcHotReloadFile } = await import("../../src/server/server-live-reload.js");

      assert.equal(shouldTriggerDataUpdate(null), true, "an unnamed data change must still refresh");
      assert.equal(shouldTriggerDataUpdate("a.jsonl"), true);
      assert.equal(shouldTriggerDataUpdate("notes.txt"), false);

      assert.equal(isSrcHotReloadFile(null), false, "an unnamed src change must not force a reload");
      assert.equal(isSrcHotReloadFile("x.js"), true);
    });
  });

  describe("facade containment", () => {
    test("no src module outside the facade imports watch from node:fs", () => {
      const root = path.resolve(import.meta.dirname, "..", "..", "src");
      const hits = execSync(
        `grep -rln 'from "node:fs"' ${JSON.stringify(root)} || true`,
        { encoding: "utf-8" },
      ).trim().split("\n").filter(Boolean);

      const offenders = hits.filter((file) => {
        if (path.basename(file) === "fs-watch.js") return false;
        const src = fs.readFileSync(file, "utf-8");
        const importLine = src.match(/import\s*\{([^}]*)\}\s*from\s*"node:fs"/)?.[1] ?? "";
        return /\bwatch\b/.test(importLine);
      });

      assert.deepEqual(offenders, [], "fs.watch must only be used inside the facade");
    });
  });
});
