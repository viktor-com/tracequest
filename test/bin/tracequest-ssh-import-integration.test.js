/**
 * Automated harness for tests/ssh-import-integration.md — `tracequest import ssh`.
 * Local rsync via TRACEQUEST_IMPORT_SSH_FIXTURE; never opens a real SSH
 * connection (facts sshfx, sshfd).
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { createServer } from "node:http";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const NEEDLE = "ssh-import-search-needle-xyzzy";

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== expectCode) {
        reject(
          new Error(
            `bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function claudeLines(text) {
  return [
    { type: "user", message: { content: [{ type: "text", text }] } },
    {
      type: "assistant",
      message: {
        model: "claude-sonnet-4-20250514",
        content: [{ type: "text", text: `ok ${text}` }],
        usage: { input_tokens: 10, output_tokens: 4 },
      },
    },
  ];
}

function seedClaude(root, host, fileName = "sess.jsonl", text = "hello from remote") {
  const dir = join(root, host, ".claude", "projects", "myproj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName);
  writeJsonl(file, claudeLines(text));
  return file;
}

function seedAllSources(root, host) {
  seedClaude(root, host, "sess.jsonl", NEEDLE);
  const uuid = "11111111-1111-1111-1111-111111111111";
  const cursorDir = join(root, host, ".cursor", "projects", "cproj", "agent-transcripts", uuid);
  mkdirSync(cursorDir, { recursive: true });
  writeJsonl(join(cursorDir, `${uuid}.jsonl`), [
    { role: "user", message: { content: [{ type: "text", text: "cursor remote" }] } },
  ]);
  const codexDir = join(root, host, ".codex", "sessions", "2026", "06", "03");
  mkdirSync(codexDir, { recursive: true });
  writeJsonl(join(codexDir, "rollout-2026-06-03T00-00-00-aaaaaaaa.jsonl"), [
    { timestamp: "2026-06-03T00:00:00.000Z", type: "session_meta", payload: { cwd: "/home/dev/app", id: "aaaaaaaa" } },
    { timestamp: "2026-06-03T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "codex remote" } },
  ]);
  const factoryDir = join(root, host, ".factory", "sessions", "ws-home-dev-code-app");
  mkdirSync(factoryDir, { recursive: true });
  writeJsonl(join(factoryDir, "f.jsonl"), [{ type: "user", content: "factory remote" }]);
  const grokDir = join(root, host, ".grok", "sessions", encodeURIComponent("/home/dev/app"), "sid");
  mkdirSync(grokDir, { recursive: true });
  writeJsonl(join(grokDir, "chat_history.jsonl"), [{ role: "user", content: "grok remote" }]);
  mkdirSync(join(root, host, ".local", "share", "opencode"), { recursive: true });
  writeFileSync(join(root, host, ".local", "share", "opencode", "opencode.db"), "not-copied");
  mkdirSync(join(root, host, ".local", "share", "tracequest", "cursor-cloud", "org"), { recursive: true });
  writeFileSync(join(root, host, ".local", "share", "tracequest", "cursor-cloud", "org", "bc.jsonl"), "{}\n");
}

function makeEnv(home, fixture, extra = {}) {
  return {
    HOME: home,
    TRACEQUEST_HOSTS_DIR: join(home, "hosts-root"),
    TRACEQUEST_IMPORT_SSH_FIXTURE: fixture,
    ...extra,
  };
}

function writeFakeRsync(dir, script) {
  const path = join(dir, "fake-rsync");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

test("import ssh with no hosts dies", async () => {
  const home = mkTmp("tq-ssh-nohosts-");
  try {
    const env = { HOME: home };
    const missing = await runBin(["import", "ssh"], { env, expectCode: 1 });
    const err = stripAnsi(missing.stderr);
    assert.match(err, /import ssh <host>/);
    assert.match(err, /import-hosts/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import ssh reads hosts from the import-hosts file", async () => {
  const home = mkTmp("tq-ssh-hostsfile-");
  const fixture = mkTmp("tq-ssh-fix-hostsfile-");
  try {
    mkdirSync(join(home, ".tracequest"), { recursive: true });
    writeFileSync(join(home, ".tracequest", "import-hosts"), "# boxes\ngpu\n");
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    const { stdout } = await runBin(["import", "ssh"], { env });
    const text = stripAnsi(stdout);
    assert.match(text, /gpu/);
    assert.match(text, /import summary:/);
    assert.equal(
      existsSync(join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl")),
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("import ssh rejects a non-integer --port", async () => {
  const home = mkTmp("tq-ssh-port-");
  try {
    const { stderr } = await runBin(["import", "ssh", "gpu", "--port", "nope"], {
      env: { HOME: home },
      expectCode: 1,
    });
    assert.match(stripAnsi(stderr), /Invalid --port/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import ssh rejects an identity path with whitespace", async () => {
  const home = mkTmp("tq-ssh-ident-");
  try {
    const { stderr } = await runBin(["import", "ssh", "gpu", "-i", "/tmp/my key"], {
      env: { HOME: home },
      expectCode: 1,
    });
    assert.match(stripAnsi(stderr), /whitespace/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dry-run prints planned actions and writes nothing under the hosts root", async () => {
  const home = mkTmp("tq-ssh-dry-");
  const fixture = mkTmp("tq-ssh-fix-dry-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    const hostsRoot = env.TRACEQUEST_HOSTS_DIR;
    const { stdout } = await runBin(["import", "ssh", "gpu", "--dry-run"], { env });
    const text = stripAnsi(stdout);
    assert.match(text, /checked 6 sources on gpu/);
    assert.match(text, /dry-run summary:/);
    assert.equal(existsSync(hostsRoot), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("prints a per-host plan before rsyncing that host", async () => {
  const home = mkTmp("tq-ssh-plan-");
  const fixture = mkTmp("tq-ssh-fix-plan-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    const { stdout } = await runBin(["import", "ssh", "gpu"], { env });
    const text = stripAnsi(stdout);
    const planAt = text.indexOf("checked 6 sources on gpu");
    const actionAt = text.search(/^(import|skip) gpu /m) >= 0
      ? text.search(/import gpu |skip gpu /)
      : text.indexOf("import gpu");
    assert.ok(planAt >= 0, text);
    assert.ok(actionAt > planAt, text);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("summary reports checked, fetched, imported, updated, skipped, and failed counts", async () => {
  const home = mkTmp("tq-ssh-sum-");
  const fixture = mkTmp("tq-ssh-fix-sum-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    const { stdout } = await runBin(["import", "ssh", "gpu"], { env });
    const text = stripAnsi(stdout);
    assert.match(
      text,
      /import summary: 6 checked, \d+ fetched, \d+ imported, \d+ updated, \d+ skipped, \d+ failed/,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("skips a source tree that is absent on the remote", async () => {
  const home = mkTmp("tq-ssh-absent-");
  const fixture = mkTmp("tq-ssh-fix-absent-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    const { stdout, stderr } = await runBin(["import", "ssh", "gpu"], { env });
    const text = stripAnsi(stdout + "\n" + stderr);
    assert.match(text, /skip gpu (cursor|codex|factory|grok) \(absent on remote\)/);
    assert.match(text, /skipped/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("copies the filesystem session trees including opencode and not cursor-cloud", async () => {
  const home = mkTmp("tq-ssh-five-");
  const fixture = mkTmp("tq-ssh-fix-five-");
  try {
    seedAllSources(fixture, "gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const dest = join(home, "hosts-root", "gpu");
    assert.equal(existsSync(join(dest, ".claude", "projects", "myproj", "sess.jsonl")), true);
    assert.equal(
      existsSync(join(dest, ".cursor", "projects", "cproj", "agent-transcripts", "11111111-1111-1111-1111-111111111111", "11111111-1111-1111-1111-111111111111.jsonl")),
      true,
    );
    assert.equal(existsSync(join(dest, ".codex", "sessions", "2026", "06", "03", "rollout-2026-06-03T00-00-00-aaaaaaaa.jsonl")), true);
    assert.equal(existsSync(join(dest, ".factory", "sessions", "ws-home-dev-code-app", "f.jsonl")), true);
    assert.equal(
      existsSync(join(dest, ".grok", "sessions", encodeURIComponent("/home/dev/app"), "sid", "chat_history.jsonl")),
      true,
    );
    assert.equal(existsSync(join(dest, ".local", "share", "opencode", "opencode.db")), true);
    assert.equal(existsSync(join(dest, ".local", "share", "tracequest", "cursor-cloud")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("re-run skips unchanged trees and preserves mtime", async () => {
  const home = mkTmp("tq-ssh-rerun-");
  const fixture = mkTmp("tq-ssh-fix-rerun-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const destFile = join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl");
    const before = statSync(destFile).mtimeMs;
    const { stdout } = await runBin(["import", "ssh", "gpu"], { env });
    const text = stripAnsi(stdout);
    assert.match(text, /skip gpu claude \(unchanged\)/);
    assert.equal(statSync(destFile).mtimeMs, before);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("full recopies a remote tree whose size and mtime still match", async () => {
  const home = mkTmp("tq-ssh-full-");
  const fixture = mkTmp("tq-ssh-fix-full-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const destFile = join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl");
    const { stdout } = await runBin(["import", "ssh", "gpu", "--full"], { env });
    const text = stripAnsi(stdout);
    // --full must reconsider the tree (not the unchanged skip). Archive rsync
    // (-a) then restores source mtimes, so dest mtime may stay equal.
    assert.match(text, /update gpu claude|import gpu claude/);
    assert.doesNotMatch(text, /skip gpu claude \(unchanged\)/);
    assert.equal(existsSync(destFile), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("does not delete a local file that vanished from the fixture", async () => {
  const home = mkTmp("tq-ssh-keep-");
  const fixture = mkTmp("tq-ssh-fix-keep-");
  try {
    seedClaude(fixture, "gpu", "keep.jsonl");
    seedClaude(fixture, "gpu", "gone.jsonl");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const goneRemote = join(fixture, "gpu", ".claude", "projects", "myproj", "gone.jsonl");
    const goneLocal = join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "gone.jsonl");
    rmSync(goneRemote);
    await runBin(["import", "ssh", "gpu"], { env });
    assert.equal(existsSync(goneLocal), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("imported ssh sessions are indexed and searchable with original source and host", async () => {
  const home = mkTmp("tq-ssh-search-");
  const fixture = mkTmp("tq-ssh-fix-search-");
  try {
    seedClaude(fixture, "gpu", "sess.jsonl", `please investigate the ${NEEDLE} report`);
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const { stdout } = await runBin(["search", NEEDLE, "--json"], { env });
    const jsonLine = stdout.split("\n").find((line) => line.trim().startsWith("["));
    assert.ok(jsonLine, `expected JSON records: ${stdout}`);
    const records = JSON.parse(jsonLine);
    assert.equal(records.length, 1);
    assert.equal(records[0].source, "claude");
    assert.equal(records[0].host, "gpu");
    assert.equal(
      records[0].path,
      join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl"),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("list --json includes host for imported sessions", async () => {
  const home = mkTmp("tq-ssh-list-");
  const fixture = mkTmp("tq-ssh-fix-list-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const { stdout } = await runBin(["list", "--json", "--filter", "host:gpu"], { env });
    const jsonLine = stdout.split("\n").find((line) => line.trim().startsWith("["));
    assert.ok(jsonLine, stdout);
    const records = JSON.parse(jsonLine);
    assert.ok(records.length >= 1);
    assert.equal(records[0].host, "gpu");
    assert.equal(records[0].source, "claude");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("counts a rsync failure under failed and continues", async () => {
  const home = mkTmp("tq-ssh-fail-");
  const fixture = mkTmp("tq-ssh-fix-fail-");
  try {
    seedAllSources(fixture, "gpu");
    const fake = writeFakeRsync(
      home,
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    *.factory/sessions*|*.factory/sessions/) echo "simulated rsync failure" >&2; exit 23 ;;
  esac
done
exec /usr/bin/rsync "$@"
`,
    );
    const env = makeEnv(home, fixture, { TRACEQUEST_SSH_RSYNC: fake });
    const { stdout, stderr } = await runBin(["import", "ssh", "gpu"], { env, expectCode: 1 });
    const text = stripAnsi(stdout + "\n" + stderr);
    assert.match(text, /factory: rsync exit (1|23)/);
    assert.match(text, /failed/);
    assert.equal(existsSync(join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("unreachable host fails that host and continues with the next", async () => {
  const home = mkTmp("tq-ssh-unreach-");
  const fixture = mkTmp("tq-ssh-fix-unreach-");
  try {
    seedClaude(fixture, "deadbox");
    seedClaude(fixture, "gpu");
    const secret = "IDENTITY-SECRET-MUST-NEVER-PRINT-9f3a";
    const ident = join(home, "id_test");
    writeFileSync(ident, secret);
    const fake = writeFakeRsync(
      home,
      `#!/bin/sh
for arg in "$@"; do
  case "$arg" in
    */deadbox/*) echo "ssh: Could not resolve hostname deadbox" >&2; exit 255 ;;
  esac
done
exec /usr/bin/rsync "$@"
`,
    );
    const env = makeEnv(home, fixture, { TRACEQUEST_SSH_RSYNC: fake });
    const { stdout, stderr } = await runBin(["import", "ssh", "deadbox", "gpu", "-i", ident], {
      env,
      expectCode: 1,
    });
    const text = stripAnsi(stdout + "\n" + stderr);
    assert.match(text, /deadbox/);
    assert.match(text, /gpu/);
    assert.equal(text.includes(secret), false);
    assert.equal(existsSync(join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl")), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("imports two hosts in one run", async () => {
  const home = mkTmp("tq-ssh-two-");
  const fixture = mkTmp("tq-ssh-fix-two-");
  try {
    seedClaude(fixture, "gpu", "sess.jsonl", "from gpu");
    seedClaude(fixture, "laptop", "sess.jsonl", "from laptop");
    const env = makeEnv(home, fixture);
    const { stdout } = await runBin(["import", "ssh", "gpu", "laptop"], { env });
    const text = stripAnsi(stdout);
    assert.match(text, /checked 6 sources on gpu/);
    assert.match(text, /checked 6 sources on laptop/);
    assert.equal(existsSync(join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl")), true);
    assert.equal(existsSync(join(home, "hosts-root", "laptop", ".claude", "projects", "myproj", "sess.jsonl")), true);
    assert.match(text, /12 checked/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("rejects an unsafe host id on the CLI", async () => {
  const home = mkTmp("tq-ssh-badid-");
  const fixture = mkTmp("tq-ssh-fix-badid-");
  try {
    const env = makeEnv(home, fixture);
    const { stdout, stderr } = await runBin(["import", "ssh", "cursor-cloud"], { env, expectCode: 1 });
    const text = stripAnsi(stdout + "\n" + stderr);
    assert.match(text, /cursor-cloud/);
    assert.match(text, /failed/);
    assert.equal(existsSync(join(home, "hosts-root", "cursor-cloud")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("dry-run composes with --full", async () => {
  const home = mkTmp("tq-ssh-dryfull-");
  const fixture = mkTmp("tq-ssh-fix-dryfull-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const { stdout } = await runBin(["import", "ssh", "gpu", "--dry-run", "--full"], { env });
    const text = stripAnsi(stdout);
    assert.match(text, /dry-run summary:/);
    assert.doesNotMatch(text, /skip gpu claude \(unchanged\)/);
    assert.match(text, /update gpu claude|import gpu claude/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("user@host lands under that host id", async () => {
  const home = mkTmp("tq-ssh-userhost-");
  const fixture = mkTmp("tq-ssh-fix-userhost-");
  try {
    seedClaude(fixture, "user@work");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "user@work"], { env });
    assert.equal(
      existsSync(join(home, "hosts-root", "user@work", ".claude", "projects", "myproj", "sess.jsonl")),
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("--as aliases the host id", async () => {
  const home = mkTmp("tq-ssh-as-");
  const fixture = mkTmp("tq-ssh-fix-as-");
  try {
    seedClaude(fixture, "user@gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "user@gpu", "--as", "gpu"], { env });
    assert.equal(
      existsSync(join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl")),
      true,
    );
    assert.equal(existsSync(join(home, "hosts-root", "user@gpu")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("import-hosts as alias", async () => {
  const home = mkTmp("tq-ssh-hostsas-");
  const fixture = mkTmp("tq-ssh-fix-hostsas-");
  try {
    mkdirSync(join(home, ".tracequest"), { recursive: true });
    writeFileSync(join(home, ".tracequest", "import-hosts"), "user@gpu as gpu\n");
    seedClaude(fixture, "user@gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh"], { env });
    assert.equal(
      existsSync(join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl")),
      true,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("--as with multiple hosts dies", async () => {
  const home = mkTmp("tq-ssh-asmany-");
  try {
    const { stderr } = await runBin(["import", "ssh", "gpu", "laptop", "--as", "box"], {
      env: { HOME: home },
      expectCode: 1,
    });
    assert.match(stripAnsi(stderr), /--as/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("list text shows source@host for imported sessions", async () => {
  const home = mkTmp("tq-ssh-listtext-");
  const fixture = mkTmp("tq-ssh-fix-listtext-");
  try {
    seedClaude(fixture, "gpu");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const { stdout } = await runBin(["list", "--filter", "host:gpu"], { env });
    assert.match(stripAnsi(stdout), /claude@gpu/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("find --filter host:gpu selects imported sessions", async () => {
  const home = mkTmp("tq-ssh-find-");
  const fixture = mkTmp("tq-ssh-fix-find-");
  try {
    seedClaude(fixture, "gpu", "sess.jsonl", "gpu only");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const hit = await runBin(["find", "--filter", "host:gpu", "--json"], { env });
    const records = JSON.parse(hit.stdout.split("\n").find((line) => line.trim().startsWith("[")));
    assert.ok(records.length >= 1);
    assert.ok(records.every((r) => r.host === "gpu"));
    const miss = await runBin(["find", "--filter", "host:nope", "--json"], { env });
    const none = JSON.parse(miss.stdout.split("\n").find((line) => line.trim().startsWith("[")) || "[]");
    assert.equal(none.length, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("render of an imported session", async () => {
  const home = mkTmp("tq-ssh-render-");
  const fixture = mkTmp("tq-ssh-fix-render-");
  try {
    seedClaude(fixture, "gpu", "sess.jsonl", "ssh-import-render-needle");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const sessionPath = join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl");
    const outFile = join(home, "imported.html");
    await runBin(["render", sessionPath, "--out", outFile], { env });
    const html = readFileSync(outFile, "utf8");
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, /ssh-import-render-needle/);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("serve lists host:gpu and opens /view of an imported session", async () => {
  const home = mkTmp("tq-ssh-serve-");
  const fixture = mkTmp("tq-ssh-fix-serve-");
  let child;
  try {
    seedClaude(fixture, "gpu", "sess.jsonl", "ssh-import-serve-needle");
    const env = makeEnv(home, fixture);
    await runBin(["import", "ssh", "gpu"], { env });
    const sessionPath = join(home, "hosts-root", "gpu", ".claude", "projects", "myproj", "sess.jsonl");
    const port = await allocEphemeralPort();
    child = spawn(NODE, [BIN, "serve", "--port", String(port)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        TRACEQUEST_SKIP_TMUX: "1",
        ...env,
      },
    });
    await waitForHttp(port, "/api/sessions");
    const list = await httpGet(port, "/api/sessions?expr=" + encodeURIComponent("host:gpu"));
    assert.equal(list.status, 200);
    const payload = JSON.parse(list.body);
    const sessions = payload.sessions || payload.items || (Array.isArray(payload) ? payload : []);
    const imported = sessions.find((s) => s.host === "gpu") || sessions[0];
    assert.ok(imported, `expected a host:gpu session in ${list.body.slice(0, 400)}`);
    assert.equal(imported.source, "claude");
    assert.equal(imported.host, "gpu");
    const view = await httpGet(port, `/view?path=${encodeURIComponent(sessionPath)}`);
    assert.equal(view.status, 200);
    assert.match(view.body, /ssh-import-serve-needle/);
  } finally {
    if (child && child.exitCode == null) child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});

function allocEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
        });
      })
      .on("error", reject);
  });
}

async function waitForHttp(port, reqPath, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await httpGet(port, reqPath);
      if (res.status === 200) return res;
      lastErr = new Error(`HTTP ${res.status} for ${reqPath}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw lastErr ?? new Error(`timed out waiting for ${reqPath}`);
}
