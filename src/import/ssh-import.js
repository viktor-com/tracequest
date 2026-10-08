/**
 * `tracequest import ssh` — copy filesystem session trees from remote SSH
 * hosts into a synthetic HOME under the tracequest-owned hosts root
 * (resolveHostsRoot — fact sshrt).
 *
 * Production transport is rsync over ssh -o BatchMode=yes (facts sshrs,
 * sshxp). Tests set TRACEQUEST_IMPORT_SSH_FIXTURE to a local directory of
 * per-host trees and never open a real SSH connection (fact sshfx).
 *
 * Copied files keep their original source (claude/cursor/codex/factory/grok)
 * so they are not a new KNOWN_SESSION_SOURCE (fact sshsv). Discovery stamps
 * `host` from the path prefix under the hosts root (fact sshst).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { resolveHostsRoot } from "../sessions/session-discovery-paths.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { collectUsageLimitsForRemote } from "../usage/ssh-collect.js";
import { recordPulls } from "../hub/pull-state.js";
import { hubConfig } from "../hub/config.js";

const execFileAsync = promisify(execFile);

/** The five filesystem session trees copied from remote $HOME (fact sshly). */
export const SSH_IMPORT_SOURCES = Object.freeze([
  { id: "claude", rel: Object.freeze([".claude", "projects"]) },
  { id: "cursor", rel: Object.freeze([".cursor", "projects"]) },
  { id: "codex", rel: Object.freeze([".codex", "sessions"]) },
  { id: "factory", rel: Object.freeze([".factory", "sessions"]) },
  { id: "grok", rel: Object.freeze([".grok", "sessions"]) },
  { id: "opencode", rel: Object.freeze([".local", "share", "opencode", "opencode.db"]), file: true },
]);

export const IMPORT_HOSTS_RELATIVE_PATH = ".tracequest/import-hosts";

export function resolveImportHostsFile(home = homedir()) {
  return join(home, IMPORT_HOSTS_RELATIVE_PATH);
}

/** One host per line; blank lines and # comments skipped (fact sshho). */
export function loadImportHostsFile(home = homedir()) {
  if (hubConfig()?.hosts !== undefined) return hubConfig().hosts;
  let text;
  try {
    text = readFileSync(resolveImportHostsFile(home), "utf8");
  } catch (err) {
    if (isIndexDiskExpectedErr(err)) return [];
    throw err;
  }
  const hosts = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    hosts.push(parseHostRef(trimmed));
  }
  return hosts;
}

/**
 * Split a host argument into SSH destination + host id.
 * `user@gpu as gpu` (or `--as gpu`) keeps the SSH spec and the dest id separate.
 */
export function parseHostRef(raw, asOverride = null) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("Host id is empty.");
  let spec = text;
  let asId = asOverride;
  const m = text.match(/^(.+?)\s+as\s+(\S+)$/i);
  if (m) {
    spec = m[1].trim();
    if (!asOverride) asId = m[2];
  }
  return { spec, hostId: hostIdFromSpec(asId || spec) };
}

/**
 * Host id is the SSH destination after trim (fact sshid). Rejected when it
 * would be a path, a traversal, or contain "cursor-cloud" (sidecar infer_source
 * matches that substring together with "tracequest").
 */
export function hostIdFromSpec(spec) {
  const raw = String(spec ?? "").trim();
  if (!raw) throw new Error("Host id is empty.");
  if (raw === "." || raw === "..") throw new Error(`Invalid host id: ${raw}`);
  if (/[/\0\\]/.test(raw)) {
    throw new Error(`Invalid host id ${JSON.stringify(raw)}: path separators are not allowed.`);
  }
  if (raw.toLowerCase().includes("cursor-cloud")) {
    throw new Error(
      `Invalid host id ${JSON.stringify(raw)}: names containing cursor-cloud would be mis-detected as the cursor-cloud source.`,
    );
  }
  return raw;
}

export function parseSshPort(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid --port: ${raw}\nUse a positive integer TCP port.`);
  }
  return n;
}

export function assertIdentityPath(identity) {
  if (identity == null || identity === "") return null;
  const path = String(identity);
  if (/\s/.test(path)) {
    throw new Error(`Invalid --identity: path must not contain whitespace: ${JSON.stringify(path)}`);
  }
  return path;
}

/** Classify rsync --out-format '%i %n' lines into new vs updated files. */
export function summarizeItemize(stdout) {
  let newFiles = 0;
  let updatedFiles = 0;
  if (!stdout) return { newFiles, updatedFiles };
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    const item = space === -1 ? line : line.slice(0, space);
    if (item.length < 2) continue;
    if (item[0] !== ">" || item[1] !== "f") continue;
    if (item.slice(2).startsWith("+++++++++")) newFiles += 1;
    else updatedFiles += 1;
  }
  return { newFiles, updatedFiles };
}

function destHasFiles(dir) {
  if (!existsSync(dir)) return false;
  try {
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          if (walk(full)) return true;
        } else if (entry.isFile()) {
          return true;
        }
      }
      return false;
    };
    return walk(dir);
  } catch (err) {
    if (isIndexDiskExpectedErr(err)) return false;
    throw err;
  }
}

function isMissingRemotePath(result) {
  const blob = `${result.stderr || ""}\n${result.stdout || ""}`;
  return /No such file or directory|change_dir .* failed/i.test(blob);
}

function isHostUnreachable(result) {
  if (result.status === 255) return true;
  const blob = `${result.stderr || ""}\n${result.stdout || ""}`;
  return /Could not resolve hostname|Permission denied|Connection refused|Connection timed out|No route to host/i.test(blob);
}

async function defaultRunRsync(args) {
  const bin = process.env.TRACEQUEST_SSH_RSYNC || "rsync";
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    return { status: 0, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`rsync not found (${bin}). Install rsync to import from SSH hosts.`);
    }
    const status = Number.isInteger(err.status)
      ? err.status
      : Number.isInteger(err.code)
        ? err.code
        : 1;
    return {
      status,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || "",
    };
  }
}

export function buildSshArgv({ identity, port, controlPath, master = false } = {}) {
  const args = ["-o", "BatchMode=yes"];
  if (identity) args.push("-i", identity);
  if (port != null) args.push("-p", String(port));
  if (controlPath) {
    args.push("-o", `ControlPath=${controlPath}`);
    args.push("-o", master ? "ControlMaster=yes" : "ControlMaster=auto");
    args.push("-o", "ControlPersist=yes");
  }
  return args;
}

export function buildRsyncArgs({ src, dest, dryRun, full, identity, port, fixtureMode, controlPath }) {
  // Never pass --delete: a session that vanished remotely stays in the local
  // archive (fact sshidm), matching cursor-cloud durability.
  const args = ["-a", "--out-format=%i %n"];
  if (dryRun) args.push("-n");
  if (full) args.push("--ignore-times");
  if (!fixtureMode) {
    const ssh = ["ssh", ...buildSshArgv({ identity, port, controlPath, master: false })];
    args.push("-e", ssh.join(" "));
  }
  args.push(src, dest);
  return args;
}

function controlPathForHost(hostId) {
  const safe = String(hostId).replace(/[^A-Za-z0-9._@-]/g, "_");
  return join(tmpdir(), `tq-ssh-${process.pid}-${safe}.sock`);
}

async function defaultRunSsh(args) {
  try {
    const { stdout, stderr } = await execFileAsync("ssh", args, {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    return { status: 0, stdout: stdout || "", stderr: stderr || "" };
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error("ssh not found. Install OpenSSH to import from SSH hosts.");
    }
    const status = Number.isInteger(err.status)
      ? err.status
      : Number.isInteger(err.code)
        ? err.code
        : 1;
    return { status, stdout: err.stdout || "", stderr: err.stderr || err.message || "" };
  }
}

function sourceRelPath(source) {
  return source.rel.join("/");
}

/**
 * Run the import. Returns { checked, fetched, imported, updated, skipped, failed }
 * (fact sshsm). `hosts` is an array of SSH destination specs.
 */
function sourceExists(path) {
  const trimmed = path.replace(/\/+$/, "");
  return existsSync(trimmed) || existsSync(path);
}

function rsyncEndpoints(spec, hostId, source, fixtureRoot) {
  const dest = join(resolveHostsRoot(), hostId, ...source.rel);
  const remoteRel = source.remotePath || source.rel.join("/");
  const isFile = Boolean(source.file);
  if (fixtureRoot) {
    const local = join(fixtureRoot, spec === hostId ? hostId : spec, ...source.rel);
    // Fixture trees are keyed by host id (alias) first, then by SSH spec.
    const byId = join(fixtureRoot, hostId, ...source.rel);
    const srcPath = existsSync(byId) || existsSync(`${byId}/`) ? byId : local;
    return {
      dest,
      remoteRel,
      src: isFile ? srcPath : `${srcPath}/`,
      destArg: isFile ? dest : `${dest}/`,
    };
  }
  return {
    dest,
    remoteRel,
    src: isFile ? `${spec}:${remoteRel}` : `${spec}:${remoteRel}/`,
    destArg: isFile ? dest : `${dest}/`,
  };
}

export async function runSshImport({
  hosts,
  dryRun = false,
  full = false,
  identity = null,
  port = null,
  as: asId = null,
  fixtureRoot = process.env.TRACEQUEST_IMPORT_SSH_FIXTURE || null,
  runRsync = defaultRunRsync,
  runSsh = defaultRunSsh,
  out = (line) => console.log(line),
  warn = (line) => console.error(line),
} = {}) {
  const raw = Array.isArray(hosts) ? hosts : [];
  if (!raw.length) {
    throw new Error(
      [
        "tracequest import ssh <host> [host...]",
        `Or list hosts in ${resolveImportHostsFile()} (one per line).`,
      ].join("\n"),
    );
  }
  if (asId && raw.length > 1) {
    throw new Error("--as <id> can only be used with a single host");
  }

  const parsedIdentity = assertIdentityPath(identity);
  const parsedPort = parseSshPort(port);
  const summary = { checked: 0, fetched: 0, imported: 0, updated: 0, skipped: 0, failed: 0 };
  const fixtureMode = Boolean(fixtureRoot);
  // Per-host outcomes for the hub's pull record (fact hubps).
  const outcomes = [];

  const refs = [];
  for (const item of raw) {
    try {
      if (item && typeof item === "object" && item.spec && item.hostId) {
        refs.push({ ...item, hostId: asId ? hostIdFromSpec(asId) : hostIdFromSpec(item.hostId) });
      } else {
        refs.push(parseHostRef(item, asId));
      }
    } catch (err) {
      warn(`warning: ${err.message} — counted as failed`);
      summary.failed += SSH_IMPORT_SOURCES.length;
      summary.checked += SSH_IMPORT_SOURCES.length;
    }
  }

  for (const { spec, hostId, sources } of refs) {
    const pending = [];
    let hostFailed = false;
    const outcome = { hostId, spec, fetched: 0, changed: 0, skipped: 0, failed: 0, error: "" };
    outcomes.push(outcome);
    const selected = sources ? SSH_IMPORT_SOURCES.filter((s) => sources[s.id]).map((s) => ({ ...s, remotePath: sources[s.id] })) : SSH_IMPORT_SOURCES;
    for (const source of selected) {
      summary.checked += 1;
      const ends = rsyncEndpoints(spec, hostId, source, fixtureRoot);
      pending.push({
        source,
        ...ends,
        existed: source.file ? existsSync(ends.dest) : destHasFiles(ends.dest),
      });
    }

    const knownAbsent = fixtureMode
      ? pending.filter((p) => !sourceExists(p.src)).length
      : 0;
    const toFetch = pending.length - knownAbsent;
    out(
      `checked ${pending.length} sources on ${hostId}: ${knownAbsent} absent, ${toFetch} to fetch`,
    );

    const controlPath = fixtureMode ? null : controlPathForHost(hostId);
    if (!fixtureMode) {
      const masterArgs = [
        ...buildSshArgv({ identity: parsedIdentity, port: parsedPort, controlPath, master: true }),
        "-fN",
        spec,
      ];
      let master;
      try {
        master = await runSsh(masterArgs);
      } catch (err) {
        warn(`warning: ${hostId}: ${err.message} — counted as failed`);
        summary.failed += pending.length;
        outcome.failed += pending.length;
        outcome.error = err.message;
        continue;
      }
      if (master.status !== 0) {
        warn(`warning: ${hostId}: ssh mux exit ${master.status} — counted as failed`);
        if (master.stderr) warn(String(master.stderr).trimEnd());
        summary.failed += pending.length;
        outcome.failed += pending.length;
        outcome.error = master.stderr || `ssh exit ${master.status}`;
        continue;
      }
    }

    try {
      for (const task of pending) {
        if (hostFailed) {
          summary.failed += 1;
          outcome.failed += 1;
          continue;
        }

        if (fixtureMode && !sourceExists(task.src)) {
          warn(`warning: ${hostId} ${task.source.id}: ${task.remoteRel} absent on remote — skipping`);
          out(`skip ${hostId} ${task.source.id} (absent on remote)`);
          summary.skipped += 1;
          outcome.skipped += 1;
          continue;
        }

        if (!dryRun) mkdirSync(task.source.file ? dirname(task.dest) : task.dest, { recursive: true });

        summary.fetched += 1;
        outcome.fetched += 1;
        const args = buildRsyncArgs({
          src: task.src,
          dest: task.destArg,
          dryRun,
          full,
          identity: parsedIdentity,
          port: parsedPort,
          fixtureMode,
          controlPath,
        });

        let result;
        try {
          result = await runRsync(args);
        } catch (err) {
          warn(`warning: ${hostId} ${task.source.id}: ${err.message} — counted as failed`);
          summary.failed += 1;
          outcome.failed += 1;
          outcome.error ||= err.message;
          continue;
        }

        if (result.status !== 0) {
          if (isMissingRemotePath(result)) {
            warn(`warning: ${hostId} ${task.source.id}: ${task.remoteRel} absent on remote — skipping`);
            out(`skip ${hostId} ${task.source.id} (absent on remote)`);
            summary.skipped += 1;
            outcome.skipped += 1;
            continue;
          }
          warn(`warning: ${hostId} ${task.source.id}: rsync exit ${result.status} — counted as failed`);
          if (result.stderr) warn(String(result.stderr).trimEnd());
          summary.failed += 1;
          outcome.failed += 1;
          outcome.error ||= result.stderr || `rsync exit ${result.status}`;
          if (isHostUnreachable(result)) hostFailed = true;
          continue;
        }

        const { newFiles, updatedFiles } = summarizeItemize(result.stdout);
        const transferred = newFiles + updatedFiles;
        if (transferred === 0) {
          out(`skip ${hostId} ${task.source.id} (unchanged)`);
          summary.skipped += 1;
          outcome.skipped += 1;
          continue;
        }

        const action = task.existed ? "update" : "import";
        const relDest = join(hostId, ...task.source.rel);
        out(`${action} ${hostId} ${task.source.id} -> ${relDest} (${transferred} files)`);
        if (action === "import") summary.imported += 1;
        else summary.updated += 1;
        outcome.changed += 1;
      }

      if (!hostFailed) {
        try {
          await collectUsageLimitsForRemote({
            spec,
            hostId,
            sshArgv: buildSshArgv({ identity: parsedIdentity, port: parsedPort, controlPath, master: false }),
            runSsh,
            fixtureRoot,
            dryRun,
            out,
            warn,
          });
        } catch (err) {
          warn(`warning: ${hostId}: usage limits ${err.message} — skipping`);
        }
      }
    } finally {
      if (!fixtureMode && controlPath) {
        try {
          await runSsh(["-o", `ControlPath=${controlPath}`, "-O", "exit", spec]);
        } catch {
          /* mux already gone */
        }
        try {
          rmSync(controlPath, { force: true });
        } catch {
          /* socket already gone */
        }
      }
    }
  }

  if (!dryRun) {
    try {
      recordPulls(outcomes);
    } catch (err) {
      warn(`warning: could not write the pull record: ${err.message}`);
    }
  }

  return summary;
}
