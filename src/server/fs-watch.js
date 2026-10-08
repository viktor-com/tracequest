import { watch, existsSync } from "node:fs";

/**
 * Facade over node:fs watch. All watcher setup goes through here so the failure
 * modes are handled once instead of at every call site:
 *
 *   - Watching a single file dies permanently when that file is replaced by
 *     rename, deleted, or does not exist yet (routine for SQLite and atomic
 *     writes). watchFile re-arms with backoff.
 *   - `filename` can be null. The facade passes it through so each caller can
 *     declare a policy rather than dropping the event by accident.
 *   - Setup can fail for reasons the caller cannot act on (missing path, inotify
 *     limits). Those degrade to a no-op handle instead of throwing.
 *
 * Recursive watching is used unconditionally. It is supported on darwin and
 * win32 always, and on linux since node 20.13 — and this project's engines floor
 * is node >= 22.5 (required by the built-in SQLite module), so there is no
 * reachable runtime without it. A non-recursive fallback existed here briefly
 * and was removed as dead code; if the engines floor is ever lowered below
 * 20.13, restore it.
 *
 * Every watcher is non-persistent: watching must never hold the process open.
 */

/** Delay before re-attaching a watcher whose file was replaced. */
const RE_ARM_DELAY_MS = 250;

/** Ceiling on the re-arm backoff while a watched file stays missing. */
const MAX_RE_ARM_DELAY_MS = 30_000;

/** Errors meaning "out of watch resources" — actionable by the user, not the code. */
const RESOURCE_CODES = new Set(["ENOSPC", "EMFILE", "ENFILE"]);

/** Errors meaning the runtime cannot watch recursively (should be unreachable). */
const NO_RECURSIVE_CODES = new Set(["ERR_FEATURE_UNAVAILABLE_ON_PLATFORM", "EINVAL", "ENOTSUP"]);

const NOOP_HANDLE = Object.freeze({ close() {} });

const _warnedOnce = new Set();

/** Resource limits recur on every watcher; warn once per kind per process. */
function warnOnce(key, message) {
  if (_warnedOnce.has(key)) return;
  _warnedOnce.add(key);
  console.error(message);
}

/** @internal — tests only */
export function _resetFsWatchWarningsForTests() {
  _warnedOnce.clear();
}

/**
 * Whether this runtime supports `{recursive:true}`. Always true on a supported
 * engine; exposed so the failure is diagnosable if someone runs an older one.
 */
export function watchCapabilities() {
  if (process.platform === "darwin" || process.platform === "win32") return { recursive: true, platform: process.platform };
  const [major, minor] = process.versions.node.split(".").map(Number);
  return { recursive: major > 20 || (major === 20 && minor >= 13), platform: process.platform };
}

/** Wrap a caller callback so a throwing listener can never kill the watcher. */
function safeCallback(onChange, label) {
  return (eventType, filename) => {
    try {
      onChange(filename, eventType);
    } catch (err) {
      console.error(`fs-watch: ${label} listener failed:`, err.message);
    }
  };
}

function startNativeWatch(target, options, listener, label, watchImpl) {
  try {
    return (watchImpl ?? watch)(target, options, listener);
  } catch (err) {
    const code = err?.code;
    if (RESOURCE_CODES.has(code)) {
      warnOnce(
        `resource:${code}`,
        `fs-watch: ${code} watching ${label} — the OS watch limit is exhausted, so live updates are disabled. `
        + (process.platform === "linux" ? "Raise fs.inotify.max_user_watches to restore them." : "Raise the open file limit to restore them."),
      );
    } else if (NO_RECURSIVE_CODES.has(code)) {
      warnOnce(
        "no-recursive",
        `fs-watch: this runtime cannot watch directories recursively (${code}), so live updates are disabled. `
        + `Node >= 20.13 is required on linux; this project's engines floor is higher still (node ${process.versions.node} in use).`,
      );
    } else if (code !== "ENOENT") {
      console.error(`fs-watch: failed to watch ${label}:`, err.message);
    }
    return null;
  }
}

function closableOnce(handle) {
  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      try { handle.close(); } catch { /* already closed */ }
    },
  };
}

/**
 * Watch the direct contents of a single directory (no recursion).
 * @param {string} dir
 * @param {(filename: string | null, eventType: string) => void} onChange
 * @returns {{ close(): void }} idempotent handle
 */
export function watchDir(dir, onChange, opts = {}) {
  if (!existsSync(dir)) return NOOP_HANDLE;
  const label = opts.label || dir;
  const handle = startNativeWatch(dir, { persistent: false, recursive: false }, safeCallback(onChange, label), label, opts.watchImpl);
  return handle ? closableOnce(handle) : NOOP_HANDLE;
}

/**
 * Watch every file under `dir`, recursively.
 * @param {string} dir
 * @param {(filename: string | null, eventType: string) => void} onChange
 *   `filename` is relative to `dir`, or null when the platform could not name
 *   the changed file.
 * @returns {{ close(): void }} idempotent handle
 */
export function watchTree(dir, onChange, opts = {}) {
  if (!existsSync(dir)) return NOOP_HANDLE;
  const label = opts.label || dir;
  const handle = startNativeWatch(dir, { persistent: false, recursive: true }, safeCallback(onChange, label), label, opts.watchImpl);
  return handle ? closableOnce(handle) : NOOP_HANDLE;
}

/**
 * Watch a single file, surviving replacement, deletion, and late creation.
 *
 * fs.watch binds to the inode, so `mv new old` leaves the watcher attached to the
 * old one — silently dead. A rename event re-arms; a missing path retries on a
 * capped backoff so a recreated file is picked up again.
 *
 * @param {string} file
 * @param {(filename: string | null, eventType: string) => void} onChange
 * @returns {{ close(): void }} idempotent handle
 */
export function watchFile(file, onChange, opts = {}) {
  const label = opts.label || file;
  const reArmDelay = opts.reArmDelayMs ?? RE_ARM_DELAY_MS;
  const maxBackoff = opts.maxReArmDelayMs ?? MAX_RE_ARM_DELAY_MS;
  let backoff = reArmDelay;
  let current = null;
  let timer = null;
  let closed = false;

  const arm = () => {
    if (closed) return;
    if (!existsSync(file)) {
      // Gone for now — a database reset, or a first run before it is created.
      // Keep waiting, or a recreated file would never be watched again.
      scheduleReArm(true);
      return;
    }
    backoff = reArmDelay;
    const listener = safeCallback((filename, eventType) => {
      onChange(filename, eventType);
      // rename means this inode is gone (replaced, moved, or deleted).
      if (eventType === "rename") scheduleReArm();
    }, label);
    current = startNativeWatch(file, { persistent: false }, listener, label, opts.watchImpl);
    if (!current) scheduleReArm(true);
  };

  const scheduleReArm = (isRetry = false) => {
    if (closed || timer) return;
    if (current) {
      try { current.close(); } catch { /* already closed */ }
      current = null;
    }
    const delay = isRetry ? backoff : reArmDelay;
    // Back off while the file stays missing so a permanently-deleted target costs
    // one cheap timer per interval rather than a tight poll.
    if (isRetry) backoff = Math.min(backoff * 2, maxBackoff);
    timer = setTimeout(() => {
      timer = null;
      arm();
    }, delay);
    // Re-arming must not hold the event loop open.
    if (typeof timer.unref === "function") timer.unref();
  };

  arm();

  return {
    close() {
      if (closed) return;
      closed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (current) {
        try { current.close(); } catch { /* already closed */ }
        current = null;
      }
    },
  };
}
