/**
 * Disk cache of what the near-words re-rank finds in each session file
 * (search-perf facts). The re-rank scans up to 8 MB of every candidate session
 * for the query's words; what it keeps from that scan (how many runs count,
 * the query words of each counted run in the order they appear, whether the
 * session searched for the query) depends only on the file's bytes and on the
 * words looked for. So one file per looked-for word set
 * (~/.cache/tracequest/near/<hash>.json, TRACEQUEST_CACHE_DIR overrides the
 * directory) maps each session file to those findings, stamped with the
 * file's size, modification time and inode; a changed file no longer matches
 * its stamp and is scanned again. The score is recomputed from the findings
 * with the current word weights, so it is exactly the score a fresh scan gives.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FORMAT = 1;
/** Word sets kept on disk; the least recently used beyond this are deleted. */
const MAX_WORD_SETS = 64;

function nearCacheDir() {
  return join(process.env.TRACEQUEST_CACHE_DIR || join(homedir(), ".cache", "tracequest"), "near");
}

/** Whether the near-words cache is used (TRACEQUEST_NEAR_CACHE=0 turns it off). */
export function nearCacheEnabled() {
  return process.env.TRACEQUEST_NEAR_CACHE !== "0";
}

/** Stamp of an open file from its bigint fstat: a rewrite, append or replacement changes it. */
export function nearCacheStamp(st) {
  return `${st.size}:${st.mtimeNs}:${st.ino}`;
}

/**
 * Open the cached findings for one looked-for word set (`signature` names the
 * words, their byte patterns and the scan rules). get/set by session file path
 * and stamp; flush writes the file once if anything was added.
 */
export function openNearCache(signature) {
  const dir = nearCacheDir();
  const file = join(dir, `${createHash("sha256").update(signature).digest("hex").slice(0, 32)}.json`);
  let entries = new Map();
  let loaded = false;
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data && data.format === FORMAT && data.signature === signature && data.entries && typeof data.entries === "object") {
      entries = new Map(Object.entries(data.entries));
      loaded = true;
    }
  } catch {
    // Missing, unreadable or corrupt: start empty and rewrite on flush.
  }
  let dirty = false;
  return {
    get(path, stamp) {
      const e = entries.get(path);
      return e && e.stamp === stamp && Array.isArray(e.q) ? e : null;
    },
    set(path, stamp, findings) {
      entries.set(path, { stamp, r: findings.r, s: findings.s, q: findings.q });
      dirty = true;
    },
    flush() {
      try {
        if (!dirty) {
          if (loaded) {
            const now = new Date();
            utimesSync(file, now, now);
          }
          return;
        }
        mkdirSync(dir, { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ format: FORMAT, signature, entries: Object.fromEntries(entries) }));
        renameSync(tmp, file);
        dirty = false;
        loaded = true;
        pruneNearCache(dir);
      } catch {
        // A cache that cannot be written only costs the next search a rescan.
      }
    },
  };
}

function pruneNearCache(dir) {
  const names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  if (names.length <= MAX_WORD_SETS) return;
  const aged = [];
  for (const name of names) {
    try {
      aged.push([statSync(join(dir, name)).mtimeMs, name]);
    } catch {
      // Removed by another process meanwhile.
    }
  }
  aged.sort((a, b) => a[0] - b[0]);
  for (const [, name] of aged.slice(0, aged.length - MAX_WORD_SETS)) {
    try {
      unlinkSync(join(dir, name));
    } catch {
      // Already gone.
    }
  }
}
