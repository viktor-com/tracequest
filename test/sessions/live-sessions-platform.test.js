import { test, describe, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  descendantPids,
  openPathHolders,
  openPathsAmong,
  procCwd,
  procCwds,
  resetProcProbeWarnings,
} from "../../src/sessions/proc-probe.js";
import { spawnSync } from "node:child_process";
import {
  claudePgrepArgs,
  findLiveClaude,
  findLiveByOpenFd,
  findLiveGrok,
  setFindLiveClaudeDepsForTests,
  clearLiveSessionsCache,
} from "../../src/sessions/live-sessions.js";

const origHomeEnv = process.env.TRACEQUEST_LIVE_SESSIONS_HOME;

afterEach(() => {
  if (origHomeEnv === undefined) delete process.env.TRACEQUEST_LIVE_SESSIONS_HOME;
  else process.env.TRACEQUEST_LIVE_SESSIONS_HOME = origHomeEnv;
  setFindLiveClaudeDepsForTests(null);
  clearLiveSessionsCache();
  resetProcProbeWarnings();
});

/** Records lsof argv and replays canned `-F0` (NUL-delimited) field output. */
function fakeLsof(stdout, { status = 0, error = null } = {}) {
  const calls = [];
  return {
    calls,
    spawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd !== "lsof") return { status: 1, stdout: "" };
      if (error) return { error, status: null, stdout: "" };
      return { status, stdout };
    },
  };
}

describe("proc-probe platform abstraction", { concurrency: false }, () => {
  describe("procCwds", () => {
    test("linux branch reads /proc/<pid>/cwd for each pid", () => {
      const seen = [];
      const cwds = procCwds(["10", "11"], {
        platform: "linux",
        readlinkSync: (target) => {
          seen.push(String(target));
          return String(target) === "/proc/10/cwd" ? "/proj/a" : "/proj/b";
        },
      });

      assert.deepEqual(seen, ["/proc/10/cwd", "/proc/11/cwd"]);
      assert.deepEqual([...cwds], [["10", "/proj/a"], ["11", "/proj/b"]]);
    });

    test("darwin branch resolves every pid in a single batched lsof call", () => {
      const lsof = fakeLsof("p10\0\nfcwd\0n/proj/a\0\np11\0\nfcwd\0n/proj/b\0\n");

      const cwds = procCwds([10, 11], { platform: "darwin", spawnSync: lsof.spawnSync });

      assert.deepEqual([...cwds], [["10", "/proj/a"], ["11", "/proj/b"]]);
      assert.equal(lsof.calls.length, 1, "pid set must be probed with one lsof invocation");
      assert.deepEqual(lsof.calls[0].args, ["-a", "-d", "cwd", "-n", "-P", "-w", "-p", "10,11", "-F0pn"]);
    });

    test("procCwd returns null for an unresolvable pid", () => {
      const lsof = fakeLsof("", { status: 1 });
      assert.equal(procCwd(99, { platform: "darwin", spawnSync: lsof.spawnSync }), null);
      assert.equal(procCwd(99, { platform: "linux", readlinkSync: () => { throw Object.assign(new Error("no"), { code: "ENOENT" }); } }), null);
    });

    test("unsupported platform returns empty without spawning", () => {
      const lsof = fakeLsof("p10\0\nfcwd\0n/proj/a\0\n");
      const cwds = procCwds([10], { platform: "win32", spawnSync: lsof.spawnSync });
      assert.equal(cwds.size, 0);
      assert.equal(lsof.calls.length, 0);
    });

    test("one malformed pid does not poison the rest of the batch", () => {
      // `lsof -p 10,notapid,11` rejects the whole list ("illegal process ID"), which
      // would silently drop every valid pid. Pids come from a user-writable JSON file.
      const lsof = fakeLsof("p10\0\nfcwd\0n/proj/a\0\np11\0\nfcwd\0n/proj/b\0\n");

      const cwds = procCwds([10, "notapid", "", "12x", 11], {
        platform: "darwin", spawnSync: lsof.spawnSync,
      });

      assert.deepEqual(lsof.calls[0].args.at(-2), "10,11", "non-numeric pids must be dropped, not passed to lsof");
      assert.deepEqual([...cwds.keys()], ["10", "11"]);
    });

    test("all-malformed pid list probes nothing", () => {
      const lsof = fakeLsof("");
      assert.equal(procCwds(["notapid"], { platform: "darwin", spawnSync: lsof.spawnSync }).size, 0);
      assert.equal(lsof.calls.length, 0);
    });

    test("linux branch also ignores non-numeric pids", () => {
      const seen = [];
      procCwds(["10", "../etc"], {
        platform: "linux",
        readlinkSync: (t) => { seen.push(String(t)); return "/proj/a"; },
      });
      assert.deepEqual(seen, ["/proc/10/cwd"]);
    });

    test("matches a path that lsof reports in escaped form", () => {
      // Verified against real lsof 4.91: a newline in a filename comes back as the
      // two characters \n, not a raw newline. Backslashes are doubled.
      const lsof = fakeLsof("p500\0\nf11\0n/sessions/we\\nird.jsonl\0\n");

      const open = openPathsAmong(["/sessions/we\nird.jsonl"], {
        platform: "darwin", spawnSync: lsof.spawnSync, realpathSync: (p) => p,
      });

      assert.deepEqual(open, ["/sessions/we\nird.jsonl"], "escaped lsof name must map back to the real path");
    });

    test("escapes backslash before control characters when building aliases", () => {
      const lsof = fakeLsof("p500\0\nf11\0n/sessions/a\\\\b\\tc.jsonl\0\n");

      const open = openPathsAmong(["/sessions/a\\b\tc.jsonl"], {
        platform: "darwin", spawnSync: lsof.spawnSync, realpathSync: (p) => p,
      });

      assert.deepEqual(open, ["/sessions/a\\b\tc.jsonl"]);
    });

    test("no pids means no probe at all", () => {
      const lsof = fakeLsof("");
      assert.equal(procCwds([], { platform: "darwin", spawnSync: lsof.spawnSync }).size, 0);
      assert.equal(lsof.calls.length, 0);
    });
  });

  describe("openPathsAmong", () => {
    test("darwin branch reports open candidates from lsof field output", () => {
      const lsof = fakeLsof("p500\0\nf11\0n/sessions/a.jsonl\0\n");

      const open = openPathsAmong(["/sessions/a.jsonl", "/sessions/b.jsonl"], {
        platform: "darwin",
        spawnSync: lsof.spawnSync,
        realpathSync: (p) => p,
      });

      assert.deepEqual(open, ["/sessions/a.jsonl"]);
      assert.deepEqual(lsof.calls[0].args, [
        "-n", "-P", "-w", "-F0pn", "--", "/sessions/a.jsonl", "/sessions/b.jsonl",
      ]);
    });

    test("maps an lsof realpath back to the caller's original path", () => {
      const lsof = fakeLsof("p500\0\nf11\0n/private/tmp/s.jsonl\0\n");

      const open = openPathsAmong(["/tmp/s.jsonl"], {
        platform: "darwin",
        spawnSync: lsof.spawnSync,
        realpathSync: (p) => (p === "/tmp/s.jsonl" ? "/private/tmp/s.jsonl" : p),
      });

      assert.deepEqual(open, ["/tmp/s.jsonl"], "result must use the path the caller supplied");
    });

    test("chunks large candidate sets across multiple lsof calls", () => {
      const lsof = fakeLsof("");
      const paths = Array.from({ length: 450 }, (_, i) => `/sessions/s${i}.jsonl`);

      openPathsAmong(paths, { platform: "darwin", spawnSync: lsof.spawnSync, realpathSync: (p) => p });

      assert.equal(lsof.calls.length, 3, "450 paths must chunk into 3 lsof calls of at most 200");
      const probed = lsof.calls.flatMap((c) => c.args.slice(c.args.indexOf("--") + 1));
      assert.deepEqual(probed, paths, "every candidate must still be probed exactly once");
    });

    test("keeps matches when lsof exits 1 because some named file has no open users", () => {
      // Real macOS lsof behaviour: a batch containing any idle file exits 1 while
      // still printing valid matches for the busy ones.
      const lsof = fakeLsof("p500\0\nf11\0n/sessions/busy.jsonl\0\n", { status: 1 });

      const open = openPathsAmong(["/sessions/busy.jsonl", "/sessions/idle.jsonl"], {
        platform: "darwin", spawnSync: lsof.spawnSync, realpathSync: (p) => p,
      });

      assert.deepEqual(open, ["/sessions/busy.jsonl"]);
    });

    test("lsof exit status 1 (no matches) is not an error", () => {
      const lsof = fakeLsof("", { status: 1 });
      const errorSpy = mock.method(console, "error", () => {});

      try {
        assert.deepEqual(openPathsAmong(["/sessions/a.jsonl"], {
          platform: "darwin", spawnSync: lsof.spawnSync, realpathSync: (p) => p,
        }), []);
        assert.deepEqual(errorSpy.mock.calls.map((c) => String(c.arguments[0])), []);
      } finally {
        errorSpy.mock.restore();
      }
    });

    test("missing lsof degrades to empty and warns at most once per process", () => {
      const lsof = fakeLsof("", { error: Object.assign(new Error("spawnSync lsof ENOENT"), { code: "ENOENT" }) });
      const errorSpy = mock.method(console, "error", () => {});
      const deps = { platform: "darwin", spawnSync: lsof.spawnSync, realpathSync: (p) => p };

      try {
        assert.deepEqual(openPathsAmong(["/sessions/a.jsonl"], deps), []);
        assert.deepEqual(openPathsAmong(["/sessions/b.jsonl"], deps), []);
        assert.equal(procCwds([1], deps).size, 0);
        const warnings = errorSpy.mock.calls.filter((c) => String(c.arguments[0]).includes("lsof probe unavailable"));
        assert.equal(warnings.length, 1, "lsof unavailability must not be logged on every probe");
      } finally {
        errorSpy.mock.restore();
      }
    });

    test("unsupported platform returns empty without spawning", () => {
      const lsof = fakeLsof("p1\0\nf1\0n/sessions/a.jsonl\0\n");
      assert.deepEqual(openPathsAmong(["/sessions/a.jsonl"], {
        platform: "win32", spawnSync: lsof.spawnSync, realpathSync: (p) => p,
      }), []);
      assert.equal(lsof.calls.length, 0);
    });

    test("empty candidate list returns empty", () => {
      assert.deepEqual(openPathsAmong([]), []);
    });

    test("detects held-open files across every character class lsof escapes", {
      skip: ["linux", "darwin"].includes(process.platform) ? false : "no open-file probe on this platform",
    }, () => {
      // lsof uses three renderings: two-char escapes (\\ \n \r \t \b \f), caret
      // notation for other C0 controls, and \x7f for DEL. Anything the escape table
      // gets wrong shows up here as a silent false negative.
      const chars = {
        backslash: "\\", newline: "\n", cr: "\r", tab: "\t", backspace: "\b",
        formfeed: "\f", vtab: "\v", soh: "\x01", esc: "\x1b", us: "\x1f",
        del: "\x7f", utf8: "中", space: " ",
      };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-probe-chars-"));
      const fds = [];
      const held = [];

      try {
        for (const [name, ch] of Object.entries(chars)) {
          const p = path.join(dir, `${name}[${ch}].jsonl`);
          fs.writeFileSync(p, "{}");
          fds.push(fs.openSync(p, "r"));
          held.push(p);
        }

        assert.deepEqual(openPathsAmong(held), held, "every escaped rendering must map back to its real path");
      } finally {
        for (const fd of fds) fs.closeSync(fd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("escaped aliases are not registered on the linux branch", () => {
      // /proc readlink returns raw bytes, so an escaped alias there could only ever
      // create a false positive against an unrelated file literally named "a\nb".
      const weird = "/sessions/a\nb.jsonl";
      const decoy = "/sessions/a\\nb.jsonl";
      const open = openPathsAmong([weird], {
        platform: "linux",
        realpathSync: (p) => p,
        readdirSync: (d) => (d === "/proc" ? ["500"] : ["0"]),
        readlinkSync: () => decoy,
      });

      assert.deepEqual(open, [], "a literal backslash-n path must not match a real-newline candidate");
    });

    test("detects a held-open file whose name contains a newline and a backslash", {
      skip: ["linux", "darwin"].includes(process.platform) ? false : "no open-file probe on this platform",
    }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-probe-esc-"));
      const held = path.join(dir, "we\nir\\d.jsonl");
      fs.writeFileSync(held, "{}");
      const fd = fs.openSync(held, "r");

      try {
        assert.deepEqual(openPathsAmong([held]), [held]);
      } finally {
        fs.closeSync(fd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    test("detects a file this process actually holds open on the host platform", {
      skip: ["linux", "darwin"].includes(process.platform) ? false : "no open-file probe on this platform",
    }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-probe-host-"));
      const held = path.join(dir, "held.jsonl");
      const idle = path.join(dir, "idle.jsonl");
      fs.writeFileSync(held, "{}");
      fs.writeFileSync(idle, "{}");
      const fd = fs.openSync(held, "r");

      try {
        assert.deepEqual(openPathsAmong([held, idle]), [held]);
      } finally {
        fs.closeSync(fd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("openPathHolders (pid-keyed probe)", () => {
    test("darwin branch maps each open path to the pids holding it", () => {
      const lsof = fakeLsof(
        "p500\0\nf11\0n/sessions/a.jsonl\0\np600\0\nf12\0n/sessions/a.jsonl\0\nf13\0n/sessions/b.jsonl\0\n",
      );

      const holders = openPathHolders(["/sessions/a.jsonl", "/sessions/b.jsonl", "/sessions/idle.jsonl"], {
        platform: "darwin", spawnSync: lsof.spawnSync, realpathSync: (p) => p,
      });

      assert.deepEqual([...(holders.get("/sessions/a.jsonl") ?? [])].sort(), ["500", "600"]);
      assert.deepEqual([...(holders.get("/sessions/b.jsonl") ?? [])], ["600"]);
      assert.equal(holders.has("/sessions/idle.jsonl"), false, "idle files have no holder entry");
    });

    test("linux branch records the /proc pid owning each matching fd", () => {
      const holders = openPathHolders(["/sessions/a.jsonl"], {
        platform: "linux",
        realpathSync: (p) => p,
        readdirSync: (d) => (d === "/proc" ? ["500", "600", "not-a-pid"] : ["3"]),
        readlinkSync: (t) => (String(t).startsWith("/proc/500/") ? "/sessions/a.jsonl" : "/elsewhere"),
      });

      assert.deepEqual([...(holders.get("/sessions/a.jsonl") ?? [])], ["500"]);
    });

    test("host platform: attributes a file held by THIS process to process.pid", {
      skip: ["linux", "darwin"].includes(process.platform) ? false : "no open-file probe on this platform",
    }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-holders-host-"));
      const held = path.join(dir, "held.jsonl");
      fs.writeFileSync(held, "{}");
      const fd = fs.openSync(held, "r");

      try {
        const holders = openPathHolders([held]);
        assert.ok(
          holders.get(held)?.has(String(process.pid)),
          `holder pids must include this process (got: ${JSON.stringify([...(holders.get(held) ?? [])])})`,
        );
      } finally {
        fs.closeSync(fd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("descendantPids (process tree)", () => {
    test("expands a root pid through injected pid/ppid pairs, root included", () => {
      const tree = descendantPids(10, {
        pidPpidPairs: () => [["11", "10"], ["12", "11"], ["20", "1"], ["10", "1"]],
      });
      assert.deepEqual([...tree].sort(), ["10", "11", "12"]);
    });

    test("a non-pid root answers the empty tree without probing", () => {
      let called = false;
      const tree = descendantPids("not-a-pid", { pidPpidPairs: () => { called = true; return []; } });
      assert.equal(tree.size, 0);
      assert.equal(called, false);
    });

    test("linux branch parses ppid from /proc/<pid>/stat past a hostile comm", () => {
      const tree = descendantPids(10, {
        platform: "linux",
        readdirSync: () => ["10", "11"],
        readFileSync: (p) =>
          String(p) === "/proc/11/stat"
            ? "11 (we ) i(rd) cömm) S 10 11 11 0 -1"
            : "10 (sh) S 1 10 10 0 -1",
      });
      assert.deepEqual([...tree].sort(), ["10", "11"]);
    });

    test("host platform: this process is inside its parent's tree", {
      skip: ["linux", "darwin"].includes(process.platform) ? false : "no tree probe on this platform",
    }, () => {
      const tree = descendantPids(process.ppid);
      assert.ok(tree.has(String(process.pid)), "process.pid must be a descendant of process.ppid");
    });
  });

  describe("pgrep ancestor visibility", () => {
    test("darwin passes -a so pgrep does not hide its own ancestors", () => {
      assert.deepEqual(claudePgrepArgs("darwin"), ["-ax", "claude"]);
    });

    test("linux and others omit -a, where it would mean --list-full", () => {
      // On linux `-a` prints the full command line alongside the pid, which would
      // break pid parsing. Linux pgrep already reports ancestors.
      assert.deepEqual(claudePgrepArgs("linux"), ["-x", "claude"]);
      assert.deepEqual(claudePgrepArgs("win32"), ["-x", "claude"]);
    });

    test("findLiveClaude invokes pgrep with the platform-correct args", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-pgrep-args-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const seen = [];
      setFindLiveClaudeDepsForTests({
        platform: "darwin",
        spawnSync: (cmd, args) => {
          seen.push({ cmd, args });
          return { status: 1, stdout: "" };
        },
      });

      try {
        findLiveClaude();
        assert.deepEqual(seen[0], { cmd: "pgrep", args: ["-ax", "claude"] });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("host check: BSD pgrep really does hide ancestors without -a", {
      skip: process.platform !== "darwin" ? "documents BSD pgrep behaviour" : false,
    }, () => {
      // This is the OS behaviour the fix exists for. If a future macOS makes
      // plain pgrep report ancestors too, this test tells us the flag is
      // redundant rather than leaving us guessing.
      const run = (args) => {
        const r = spawnSync("pgrep", args, { encoding: "utf-8" });
        return new Set((r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean));
      };
      const withAncestors = run(["-ax", "claude"]);
      const withoutAncestors = run(["-x", "claude"]);
      if (!withAncestors.size) return; // no claude running; nothing to assert

      for (const pid of withoutAncestors) {
        assert.ok(withAncestors.has(pid), "-ax must be a superset of -x");
      }
    });
  });

  describe("live-session finders on darwin", () => {
    test("findLiveClaude resolves pgrep pids through lsof and dedups project dirs", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-darwin-claude-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = "/Users/dev/proj";
      const projDir = path.join(home, ".claude", "projects", "-Users-dev-proj");
      fs.mkdirSync(projDir, { recursive: true });
      const older = path.join(projDir, "old.jsonl");
      const newer = path.join(projDir, "new.jsonl");
      fs.writeFileSync(older, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t-old", name: "Bash", input: {} }] } }) + "\n");
      fs.writeFileSync(newer, JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t-new", name: "Bash", input: {} }] } }) + "\n");
      const past = new Date("2020-01-01");
      fs.utimesSync(older, past, past);

      const lsofCalls = [];
      setFindLiveClaudeDepsForTests({
        platform: "darwin",
        spawnSync: (cmd, args) => {
          if (cmd === "pgrep") return { status: 0, stdout: "700\n701\n" };
          lsofCalls.push(args);
          return { status: 0, stdout: `p700\0\nfcwd\0n${cwd}\0\np701\0\nfcwd\0n${cwd}\0\n` };
        },
      });

      try {
        assert.deepEqual(findLiveClaude(), [newer, newer]);
        assert.equal(lsofCalls.length, 1, "both pids resolve in one lsof call");
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("findLiveClaude yields nothing when lsof cannot resolve the pid cwd", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-darwin-claude-dead-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      setFindLiveClaudeDepsForTests({
        platform: "darwin",
        spawnSync: (cmd) => (cmd === "pgrep" ? { status: 0, stdout: "800\n" } : { status: 1, stdout: "" }),
      });

      try {
        assert.deepEqual(findLiveClaude(), []);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("host-platform findLiveGrok matches this process's real cwd", () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-host-"));
      process.env.TRACEQUEST_LIVE_SESSIONS_HOME = home;
      const cwd = process.cwd();
      const grokDir = path.join(home, ".grok");
      const sessionDir = path.join(grokDir, "sessions", encodeURIComponent(cwd), "s1");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, "events.jsonl"),
        JSON.stringify({ ts: "2026-08-26T12:12:50.353Z", type: "turn_started" }) + "\n",
      );
      fs.writeFileSync(
        path.join(grokDir, "active_sessions.json"),
        JSON.stringify([{ session_id: "s1", cwd, pid: process.pid }]),
      );

      try {
        assert.deepEqual(findLiveGrok(), [sessionDir]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    test("findLiveByOpenFd dedups repeated candidate paths before probing", () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-fd-dedup-"));
      const p = path.join(dir, "s.jsonl");
      fs.writeFileSync(p, "{}");
      const fd = fs.openSync(p, "r");

      try {
        assert.deepEqual(findLiveByOpenFd([p, p, p]), [p]);
      } finally {
        fs.closeSync(fd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
