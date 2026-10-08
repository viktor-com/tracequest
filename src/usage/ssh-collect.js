/**
 * SSH-side I/O for usage-limits: read credential files over the existing
 * ControlMaster into memory, run the same collectors, write a secret-free
 * snapshot. Never rsyncs credential files.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { collectUsageLimits } from "./collect.js";
import { writeUsageSnapshot } from "./snapshot.js";
import { cursorStateDbCandidates, parseCursorAccessTokenValue } from "../import/cursor-cloud-import.js";
import { resolveHostsRoot } from "../sessions/session-discovery-paths.js";

const REMOTE_CRED_PATHS = Object.freeze({
  claudeJson: ".claude/.credentials.json",
  codexJson: ".codex/auth.json",
  grokAuthJson: ".grok/auth.json",
});

async function sshCapture(runSsh, argv, spec, remoteCommand) {
  return runSsh([...argv, spec, remoteCommand]);
}

async function sshReadFile(runSsh, argv, spec, remotePath) {
  const quoted = `'${String(remotePath).replace(/'/g, `'\\''`)}'`;
  let result;
  try {
    result = await sshCapture(runSsh, argv, spec, `cat ${quoted}`);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (result.status !== 0) {
    const blob = `${result.stderr || ""}\n${result.stdout || ""}`;
    if (/No such file or directory/i.test(blob) || result.status === 1) {
      return { ok: true, text: null };
    }
    return { ok: false, error: `ssh cat ${remotePath} exit ${result.status}` };
  }
  return { ok: true, text: result.stdout || "" };
}

function sqliteTokenScript(paths) {
  const list = paths.map((p) => `'${p.replace(/'/g, `'\\''`)}'`).join(" ");
  return [
    `for p in ${list}; do`,
    `  if [ -f "$p" ]; then`,
    `    if command -v sqlite3 >/dev/null 2>&1; then`,
    `      sqlite3 -readonly "$p" "SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken'" 2>/dev/null && exit 0`,
    `    fi`,
    `    if command -v python3 >/dev/null 2>&1; then`,
    `      python3 -c "import sqlite3,sys; p=sys.argv[1]; db=sqlite3.connect('file:'+p+'?mode=ro', uri=True); r=db.execute(\\"SELECT value FROM ItemTable WHERE key=?\\", ('cursorAuth/accessToken',)).fetchone(); print(r[0] if r and r[0] else '')" "$p" && exit 0`,
    `    fi`,
    `  fi`,
    `done`,
    `exit 2`,
  ].join("\n");
}

async function sshReadCursorToken(runSsh, argv, spec, warn, hostId) {
  const paths = cursorStateDbCandidates("");
  const rel = paths.map((p) => p.replace(/^\//, ""));
  let result;
  try {
    result = await sshCapture(runSsh, argv, spec, sqliteTokenScript(rel));
  } catch (err) {
    warn(`warning: ${hostId} cursor: ${err.message} — skipping`);
    return { ok: false, token: null };
  }
  if (result.status === 2 || /No such file/i.test(result.stderr || "")) {
    return { ok: true, token: null };
  }
  if (result.status !== 0) {
    warn(`warning: ${hostId} cursor: remote sqlite/python unavailable — skipping`);
    return { ok: false, token: null };
  }
  return { ok: true, token: parseCursorAccessTokenValue((result.stdout || "").trim()) };
}

function printHarnessLines(snapshot, hostId, out) {
  for (const row of snapshot.harnesses || []) {
    if (row.status === "ok") out(`limits ${hostId} ${row.id} ok`);
    else if (row.status === "missing") out(`skip ${hostId} ${row.id} (no credential)`);
    else if (row.status === "unavailable") continue;
    else out(`skip ${hostId} ${row.id} (${row.status})`);
  }
}

function fixtureHostHome(fixtureRoot, hostId, spec) {
  const byId = join(fixtureRoot, hostId);
  if (existsSync(byId)) return byId;
  return join(fixtureRoot, spec);
}

/**
 * After a host's session-tree rsync. Does not change import summary counters.
 * dry-run prints the plan and writes nothing.
 */
export async function collectUsageLimitsForRemote({
  spec,
  hostId,
  sshArgv = [],
  runSsh,
  fixtureRoot = null,
  dryRun = false,
  fetchImpl = fetch,
  out = () => {},
  warn = () => {},
  hostsRoot = resolveHostsRoot(),
} = {}) {
  if (dryRun) {
    out(`limits ${hostId}: collect remaining plan windows (no write)`);
    return null;
  }

  try {
    if (fixtureRoot) {
      const snapshot = await collectUsageLimits({
        home: fixtureHostHome(fixtureRoot, hostId, spec),
        host: hostId,
        fetchImpl,
      });
      writeUsageSnapshot(hostId, snapshot, { hostsRoot });
      printHarnessLines(snapshot, hostId, out);
      return snapshot;
    }

    const credentials = {};
    for (const [key, rel] of Object.entries(REMOTE_CRED_PATHS)) {
      const got = await sshReadFile(runSsh, sshArgv, spec, rel);
      if (!got.ok) {
        warn(`warning: ${hostId}: ${got.error} — skipping usage limits`);
        return null;
      }
      credentials[key] = got.text;
    }
    const cursor = await sshReadCursorToken(runSsh, sshArgv, spec, warn, hostId);
    if (cursor.ok) credentials.cursorToken = cursor.token;

    const snapshot = await collectUsageLimits({
      host: hostId,
      fetchImpl,
      credentials,
    });
    writeUsageSnapshot(hostId, snapshot, { hostsRoot });
    printHarnessLines(snapshot, hostId, out);
    return snapshot;
  } catch (err) {
    warn(`warning: ${hostId}: usage limits ${err.message} — skipping`);
    return null;
  }
}
