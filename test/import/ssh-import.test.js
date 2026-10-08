import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "../helpers/fixtures.js";
import {
  hostIdFromSpec,
  loadImportHostsFile,
  parseSshPort,
  assertIdentityPath,
  summarizeItemize,
  SSH_IMPORT_SOURCES,
  buildRsyncArgs,
  parseHostRef,
  runSshImport,
} from "../../src/import/ssh-import.js";

describe("parseHostRef", () => {
  test("parseHostRef splits SSH spec from host id", () => {
    assert.deepEqual(parseHostRef("gpu"), { spec: "gpu", hostId: "gpu" });
    assert.deepEqual(parseHostRef("user@work as work"), { spec: "user@work", hostId: "work" });
    assert.deepEqual(parseHostRef("user@gpu", "gpu"), { spec: "user@gpu", hostId: "gpu" });
    assert.deepEqual(parseHostRef("user@gpu as ignored", "gpu"), { spec: "user@gpu", hostId: "gpu" });
  });
});

describe("hostIdFromSpec", () => {
  test("rejects unsafe host ids", () => {
    assert.equal(hostIdFromSpec("gpu"), "gpu");
    assert.equal(hostIdFromSpec(" user@work "), "user@work");
    assert.throws(() => hostIdFromSpec(""), /empty/i);
    assert.throws(() => hostIdFromSpec("   "), /empty/i);
    assert.throws(() => hostIdFromSpec("."), /Invalid host id/);
    assert.throws(() => hostIdFromSpec(".."), /Invalid host id/);
    assert.throws(() => hostIdFromSpec("a/b"), /path separators/);
    assert.throws(() => hostIdFromSpec("a\\b"), /path separators/);
    assert.throws(() => hostIdFromSpec("cursor-cloud"), /cursor-cloud/);
    assert.throws(() => hostIdFromSpec("my-cursor-cloud-box"), /cursor-cloud/);
  });
});

describe("parseSshPort / identity", () => {
  test("accepts a positive TCP port and rejects junk", () => {
    assert.equal(parseSshPort(null), null);
    assert.equal(parseSshPort("22"), 22);
    assert.equal(parseSshPort("2222"), 2222);
    assert.throws(() => parseSshPort("nope"), /Invalid --port/);
    assert.throws(() => parseSshPort("0"), /Invalid --port/);
    assert.throws(() => parseSshPort("65536"), /Invalid --port/);
  });

  test("rejects an identity path with whitespace", () => {
    assert.equal(assertIdentityPath(null), null);
    assert.equal(assertIdentityPath("/home/me/.ssh/id_ed25519"), "/home/me/.ssh/id_ed25519");
    assert.throws(() => assertIdentityPath("/tmp/my key"), /whitespace/);
  });
});

describe("summarizeItemize", () => {
  test("counts new and updated file rows", () => {
    const stdout = [
      ">f+++++++++ .claude/projects/p/a.jsonl",
      ">f.st...... .claude/projects/p/b.jsonl",
      ".f          .claude/projects/p/c.jsonl",
      ">d+++++++++ .claude/projects/p",
      "*deleting   stale.jsonl",
    ].join("\n");
    assert.deepEqual(summarizeItemize(stdout), { newFiles: 1, updatedFiles: 1 });
  });
});

describe("loadImportHostsFile", () => {
  test("skips blanks and hash comments", () => {
    const home = mkTmp("tq-ssh-hosts-file-");
    mkdirSync(join(home, ".tracequest"), { recursive: true });
    writeFileSync(
      join(home, ".tracequest", "import-hosts"),
      ["# laptops", "gpu", "", "  user@work  ", "# ignore", "box"].join("\n"),
    );
    assert.deepEqual(loadImportHostsFile(home), [
      { spec: "gpu", hostId: "gpu" },
      { spec: "user@work", hostId: "user@work" },
      { spec: "box", hostId: "box" },
    ]);
  });

  test("parses as aliases", () => {
    const home = mkTmp("tq-ssh-hosts-as-");
    mkdirSync(join(home, ".tracequest"), { recursive: true });
    writeFileSync(join(home, ".tracequest", "import-hosts"), "user@gpu as gpu\n");
    assert.deepEqual(loadImportHostsFile(home), [{ spec: "user@gpu", hostId: "gpu" }]);
  });

  test("missing file yields an empty list", () => {
    const home = mkTmp("tq-ssh-hosts-missing-");
    assert.deepEqual(loadImportHostsFile(home), []);
  });
});

describe("buildRsyncArgs", () => {
  test("production mode passes ssh BatchMode, identity, and port", () => {
    const args = buildRsyncArgs({
      src: "gpu:.claude/projects/",
      dest: "/tmp/dest/",
      dryRun: false,
      full: true,
      identity: "/tmp/id_ed25519",
      port: 2222,
      fixtureMode: false,
    });
    assert.ok(args.includes("-a"));
    assert.ok(args.includes("-n") === false);
    assert.ok(args.includes("--ignore-times"));
    assert.ok(args.includes("--delete") === false);
    const e = args.indexOf("-e");
    assert.ok(e >= 0);
    assert.equal(args[e + 1], "ssh -o BatchMode=yes -i /tmp/id_ed25519 -p 2222");
    assert.equal(args.at(-2), "gpu:.claude/projects/");
  });

  test("fixture mode omits ssh -e and uses local paths", () => {
    const args = buildRsyncArgs({
      src: "/fix/gpu/.claude/projects/",
      dest: "/tmp/dest/",
      dryRun: true,
      full: false,
      identity: "/tmp/id_ed25519",
      port: 2222,
      fixtureMode: true,
    });
    assert.ok(args.includes("-n"));
    assert.equal(args.includes("-e"), false);
    assert.equal(args.at(-2), "/fix/gpu/.claude/projects/");
  });
});

describe("runSshImport transport flags", () => {
  test("ControlMaster mux per host", async () => {
    const hostsDir = mkTmp("tq-ssh-mux-");
    const prev = process.env.TRACEQUEST_HOSTS_DIR;
    process.env.TRACEQUEST_HOSTS_DIR = hostsDir;
    const sshCalls = [];
    const rsyncCalls = [];
    try {
      const summary = await runSshImport({
        hosts: ["gpu"],
        identity: "/tmp/id_ed25519",
        port: 2222,
        fixtureRoot: null,
        runSsh: async (args) => {
          sshCalls.push(args);
          return { status: 0, stdout: "", stderr: "" };
        },
        runRsync: async (args) => {
          rsyncCalls.push(args);
          return { status: 255, stdout: "", stderr: "ssh: Could not resolve hostname gpu" };
        },
        out: () => {},
        warn: () => {},
      });
      assert.ok(sshCalls[0].includes("-fN"));
      assert.ok(sshCalls[0].includes("ControlMaster=yes"));
      assert.ok(sshCalls[0].includes("gpu"));
      const rsh = rsyncCalls[0][rsyncCalls[0].indexOf("-e") + 1];
      assert.match(rsh, /ControlMaster=auto/);
      assert.match(rsh, /ControlPath=/);
      assert.match(rsh, /BatchMode=yes/);
      assert.ok(sshCalls.some((args) => args.includes("-O") && args.includes("exit")));
      assert.equal(rsyncCalls.length, 1);
      assert.equal(summary.failed, 6);
      assert.equal(summary.fetched, 1);
    } finally {
      if (prev === undefined) delete process.env.TRACEQUEST_HOSTS_DIR;
      else process.env.TRACEQUEST_HOSTS_DIR = prev;
    }
  });
});

describe("SSH_IMPORT_SOURCES", () => {
  test("includes opencode.db and not cursor-cloud", () => {
    assert.deepEqual(
      SSH_IMPORT_SOURCES.map((s) => s.id),
      ["claude", "cursor", "codex", "factory", "grok", "opencode"],
    );
    const joined = SSH_IMPORT_SOURCES.map((s) => s.rel.join("/")).join(" ");
    assert.match(joined, /opencode\.db/);
    assert.equal(joined.includes("cursor-cloud"), false);
  });
});
