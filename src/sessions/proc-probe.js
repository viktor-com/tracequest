import { readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { isProcRaceErr } from "../utils/fs-expected-err.js";

/**
 * Platform-abstracted process probes used by live-session detection and
 * run↔session attribution.
 *
 * Three questions need answering, and each OS answers them differently:
 *   1. what is process <pid>'s working directory?   (linux: /proc/<pid>/cwd, darwin: lsof -d cwd)
 *   2. WHICH processes hold each of these files open?  (linux: /proc/*\/fd scan, darwin: lsof -- paths)
 *   3. which pids form the process TREE under a root pid?  (linux: /proc/<pid>/stat, darwin: ps)
 *
 * Everything OS-specific lives here so callers stay platform-agnostic.
 */

const LSOF_TIMEOUT_MS = 2000;
/** argv chunking for `lsof -- <paths>`; keeps command lines well under ARG_MAX. */
const LSOF_PATH_CHUNK = 200;

/** @typedef {{ platform?: string, spawnSync?: Function, readlinkSync?: Function, readdirSync?: Function, realpathSync?: Function }} ProbeDeps */

let _lsofMissingWarned = false;

/** Reset the once-per-process lsof warning (tests only). */
export function resetProcProbeWarnings() {
  _lsofMissingWarned = false;
}

function pick(deps, name, fallback) {
  return deps?.[name] ?? fallback;
}

/**
 * Which probe family to use. Dep injection may override it so both
 * implementations are testable from any host.
 */
function platformOf(deps) {
  return deps?.platform ?? process.platform;
}

function runLsof(args, deps) {
  const spawn = pick(deps, "spawnSync", spawnSync);
  const result = spawn("lsof", args, { encoding: "utf-8", timeout: LSOF_TIMEOUT_MS });
  if (result?.error) {
    warnLsofOnce(`live sessions: lsof probe unavailable, live detection disabled: ${result.error.message}`);
    return "";
  }
  // Exit status is deliberately ignored. lsof exits 1 both for "nothing matched"
  // and for "some named file has no open users" — the latter still prints valid
  // matches for the other files, which is the normal case when probing a batch of
  // mostly-idle session files. stdout is the only reliable signal. Per-file
  // complaints (a session file deleted mid-probe) are routine and suppressed by -w.
  return result?.stdout ?? "";
}

/** lsof runs every few seconds; a broken probe must not spam the log. */
function warnLsofOnce(message) {
  if (_lsofMissingWarned) return;
  _lsofMissingWarned = true;
  console.error(message);
}

/**
 * Parse `lsof -F0` field output into records.
 * `p<pid>` starts a process block, `n<name>` is a path. -F0 terminates each field
 * with NUL rather than a newline, so a path containing a newline still parses.
 * @returns {Array<{ pid: string, name: string }>}
 */
function parseLsofFields(stdout) {
  const out = [];
  let pid = "";
  for (const raw of stdout.split("\0")) {
    // lsof terminates each field with NUL and each record with a newline, so the
    // record separator arrives as a leading newline on the next field. Splitting on
    // NUL alone (never on newline) is what keeps a path containing a newline intact.
    const field = raw.replace(/^\n+/, "");
    if (!field) continue;
    const tag = field[0];
    const value = field.slice(1);
    if (tag === "p") pid = value;
    else if (tag === "n" && value) out.push({ pid, name: value });
  }
  return out;
}

/**
 * Resolve working directories for the given pids.
 * @param {Iterable<string|number>} pids
 * @param {ProbeDeps} [deps]
 * @returns {Map<string, string>} pid → cwd (pids that could not be resolved are absent)
 */
export function procCwds(pids, deps) {
  // Pids reach us from ~/.grok/active_sessions.json, so they are untrusted input.
  // `lsof -p` rejects the entire comma-joined list if any entry is non-numeric,
  // which would silently drop every other pid in the batch.
  const list = [...pids].map(String).filter((p) => /^\d+$/.test(p));
  const out = new Map();
  if (!list.length) return out;

  const platform = platformOf(deps);
  if (platform === "linux") {
    const readlink = pick(deps, "readlinkSync", readlinkSync);
    for (const pid of list) {
      try {
        out.set(pid, readlink(`/proc/${pid}/cwd`));
      } catch (err) {
        if (!isProcRaceErr(err)) console.error(`procCwds: failed to read /proc/${pid}/cwd:`, err.message);
      }
    }
    return out;
  }
  if (platform !== "darwin") return out;

  // One lsof call for the whole pid set: per-pid spawns cost ~90ms each.
  const stdout = runLsof(["-a", "-d", "cwd", "-n", "-P", "-w", "-p", list.join(","), "-F0pn"], deps);
  for (const { pid, name } of parseLsofFields(stdout)) {
    if (pid && !out.has(pid)) out.set(pid, name);
  }
  return out;
}

/** Resolve one pid's cwd, or null. */
export function procCwd(pid, deps) {
  return procCwds([pid], deps).get(String(pid)) ?? null;
}

/** Bytes lsof renders as a two-character escape. */
const LSOF_TWO_CHAR_ESCAPES = {
  "\\": "\\\\", "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f",
};

/**
 * How lsof renders a path in -F output. Verified byte-by-byte against lsof 4.91,
 * which uses three different renderings:
 *   - `\ \n \r \t \b \f`        → two-character escape
 *   - other C0 controls          → caret notation (`\x01` → `^A`, i.e. byte + 0x40)
 *   - DEL (0x7f)                 → `\x7f`
 * Printable ASCII (including spaces and quotes) and UTF-8 pass through unchanged.
 */
function lsofEscape(p) {
  let out = "";
  for (const ch of p) {
    const twoChar = LSOF_TWO_CHAR_ESCAPES[ch];
    if (twoChar) { out += twoChar; continue; }
    const code = ch.codePointAt(0);
    if (code < 0x20) out += "^" + String.fromCharCode(code + 0x40);
    else if (code === 0x7f) out += "\\x7f";
    else out += ch;
  }
  return out;
}

/**
 * lsof reports realpaths (/tmp/x on macOS surfaces as /private/tmp/x) and escapes
 * exotic characters, so index each candidate under every spelling it may come back
 * as: given, resolved, and the escaped form of both.
 */
function candidateAliases(paths, platform, deps) {
  const realpath = pick(deps, "realpathSync", realpathSync);
  // Only lsof escapes; /proc readlink returns raw kernel bytes. Registering escaped
  // aliases on linux could only ever produce a false positive, never a match.
  const escapes = platform === "darwin";
  /** @type {Map<string, string>} alias → original caller-supplied path */
  const aliases = new Map();
  const addAlias = (alias, original) => {
    if (alias && !aliases.has(alias)) aliases.set(alias, original);
  };
  for (const p of paths) {
    aliases.set(p, p);
    if (escapes) addAlias(lsofEscape(p), p);
    try {
      const real = realpath(p);
      addAlias(real, p);
      if (real && escapes) addAlias(lsofEscape(real), p);
    } catch (err) {
      if (!isProcRaceErr(err)) console.error(`openPathsAmong: realpath failed for ${p}:`, err.message);
    }
  }
  return aliases;
}

/** Record `pid` as a holder of caller path `original` in the holders map. */
function addHolder(holders, original, pid) {
  let set = holders.get(original);
  if (!set) {
    set = new Set();
    holders.set(original, set);
  }
  set.add(String(pid));
}

function holdersLinux(aliases, deps) {
  const readdir = pick(deps, "readdirSync", readdirSync);
  const readlink = pick(deps, "readlinkSync", readlinkSync);
  /** @type {Map<string, Set<string>>} */
  const holders = new Map();
  try {
    for (const d of readdir("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        for (const fd of readdir(`/proc/${d}/fd`)) {
          try {
            const link = readlink(`/proc/${d}/fd/${fd}`);
            const original = aliases.get(link);
            if (original) addHolder(holders, original, d);
          } catch (err) {
            if (!isProcRaceErr(err)) console.error(`openPathHolders: readlink /proc/${d}/fd/${fd} failed:`, err.message);
          }
        }
      } catch (err) {
        if (!isProcRaceErr(err)) console.error(`openPathHolders: failed to read /proc/${d}/fd:`, err.message);
      }
    }
  } catch (err) {
    if (!isProcRaceErr(err)) console.error("openPathHolders: failed to read /proc:", err.message);
  }
  return holders;
}

function holdersDarwin(aliases, paths, deps) {
  /** @type {Map<string, Set<string>>} */
  const holders = new Map();
  for (let i = 0; i < paths.length; i += LSOF_PATH_CHUNK) {
    const chunk = paths.slice(i, i + LSOF_PATH_CHUNK);
    const stdout = runLsof(["-n", "-P", "-w", "-F0pn", "--", ...chunk], deps);
    for (const { pid, name } of parseLsofFields(stdout)) {
      const original = aliases.get(name);
      if (original && pid) addHolder(holders, original, pid);
    }
  }
  return holders;
}

/**
 * WHICH processes hold each of `paths` open — the pid-keyed probe behind
 * run↔session attribution ("whose file is this", not just "is it open").
 * @param {string[]} paths
 * @param {ProbeDeps} [deps]
 * @returns {Map<string, Set<string>>} caller-supplied path → pids holding it open
 */
export function openPathHolders(paths, deps) {
  if (!paths?.length) return new Map();
  const platform = platformOf(deps);
  if (platform !== "linux" && platform !== "darwin") return new Map();

  const aliases = candidateAliases(paths, platform, deps);
  return platform === "linux"
    ? holdersLinux(aliases, deps)
    : holdersDarwin(aliases, paths, deps);
}

/**
 * Subset of `paths` currently held open by some process.
 * @param {string[]} paths
 * @param {ProbeDeps} [deps]
 * @returns {string[]} caller-supplied paths (not realpaths), in input order
 */
export function openPathsAmong(paths, deps) {
  if (!paths?.length) return [];
  const holders = openPathHolders(paths, deps);
  return paths.filter((p) => (holders.get(p)?.size ?? 0) > 0);
}

/** Timeout for the `ps` snapshot behind descendantPids on darwin. */
const PS_TIMEOUT_MS = 2000;

/** [pid, ppid] pairs from /proc/<pid>/stat (linux — no external command). */
function pidPpidPairsLinux(deps) {
  const readdir = pick(deps, "readdirSync", readdirSync);
  const readFile = pick(deps, "readFileSync", readFileSync);
  const pairs = [];
  try {
    for (const d of readdir("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = String(readFile(`/proc/${d}/stat`, "utf8"));
        // "pid (comm) state ppid ..." — comm may itself contain spaces and
        // parens, so fields are taken AFTER the last ")".
        const rest = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        if (/^\d+$/.test(rest[1] ?? "")) pairs.push([d, rest[1]]);
      } catch (err) {
        if (!isProcRaceErr(err)) console.error(`descendantPids: failed to read /proc/${d}/stat:`, err.message);
      }
    }
  } catch (err) {
    if (!isProcRaceErr(err)) console.error("descendantPids: failed to read /proc:", err.message);
  }
  return pairs;
}

/** [pid, ppid] pairs from one `ps -axo pid=,ppid=` snapshot (darwin). */
function pidPpidPairsPs(deps) {
  const spawn = pick(deps, "spawnSync", spawnSync);
  const result = spawn("ps", ["-axo", "pid=,ppid="], { encoding: "utf-8", timeout: PS_TIMEOUT_MS });
  if (result?.error) {
    console.error(`descendantPids: ps snapshot failed: ${result.error.message}`);
    return [];
  }
  const pairs = [];
  for (const line of String(result?.stdout || "").split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) pairs.push([m[1], m[2]]);
  }
  return pairs;
}

/**
 * The full process tree rooted at `rootPid` (root included) — how a tmux
 * pane's pid expands to "every process this run owns" so an open session
 * file can be attributed to the run whose tree actually holds it.
 * @param {string|number} rootPid
 * @param {ProbeDeps & { pidPpidPairs?: () => Array<[string, string]> }} [deps]
 * @returns {Set<string>} pids as strings; empty when rootPid is not a pid
 */
export function descendantPids(rootPid, deps) {
  const root = String(rootPid ?? "");
  if (!/^\d+$/.test(root)) return new Set();
  const pairs = deps?.pidPpidPairs
    ? deps.pidPpidPairs()
    : platformOf(deps) === "linux"
      ? pidPpidPairsLinux(deps)
      : pidPpidPairsPs(deps);
  /** @type {Map<string, string[]>} ppid → child pids */
  const children = new Map();
  for (const [pid, ppid] of pairs) {
    let kids = children.get(ppid);
    if (!kids) {
      kids = [];
      children.set(ppid, kids);
    }
    kids.push(pid);
  }
  const tree = new Set([root]);
  const queue = [root];
  while (queue.length) {
    for (const pid of children.get(queue.pop()) ?? []) {
      if (!tree.has(pid)) {
        tree.add(pid);
        queue.push(pid);
      }
    }
  }
  return tree;
}
