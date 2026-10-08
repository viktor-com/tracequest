/** ENOENT when the on-disk index file has not been created yet (expected on first run). */
export function isIndexDiskExpectedErr(err) {
  const c = err && err.code;
  return c === "ENOENT";
}

/** ENOENT/ESRCH/etc. when a process or fd vanishes between pgrep and /proc reads. */
export function isProcRaceErr(err) {
  const c = err && err.code;
  return c === "ENOENT" || c === "ESRCH" || c === "EPERM" || c === "EINVAL" || c === "EACCES";
}

/** Worker already stopped when terminate races with exit/error handlers during index cleanup. */
export function isWorkerTerminateExpectedErr(err) {
  const c = err && err.code;
  return c === "ERR_WORKER_NOT_RUNNING" || c === "ERR_WORKER_INVALID_STATE";
}
/**
 * Errors that make ONE directory entry unreadable rather than the scan invalid.
 *
 * A session tree is ordinary user data: it contains other people's 0700
 * directories, symlinks that point at their own ancestors, and files that
 * vanish while an agent rotates them. Any of those raising out of the walk
 * empties the whole session list, so discovery treats them as "skip this
 * subtree" and keeps the sessions it can read.
 */
export function isScanSkippableErr(err) {
  const c = err && err.code;
  return (
    c === "ENOENT" ||
    c === "ENOTDIR" ||
    c === "EACCES" ||
    c === "EPERM" ||
    c === "ELOOP" ||
    c === "EMFILE" ||
    c === "ENFILE" ||
    c === "ENAMETOOLONG"
  );
}
