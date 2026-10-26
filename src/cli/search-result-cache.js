/**
 * Exact-repeat cache for `tracequest search` / `tracequest handoff` results.
 *
 * A search is a pure function of: the query and its options, the current
 * repository, the discovered session list (each file's size and mtime stand in
 * for its content), the persisted index (index.json + search.idx), the
 * TRACEQUEST_* environment and the code. All of that goes into the key, so a
 * hit can only happen when an uncached run would compute the same thing; the
 * hit then skips loading the index, the BM25 + near-words re-rank and the
 * snippet scans. Only an exact repeat on an unchanged corpus hits: any changed
 * session, rewritten index or code edit is a miss.
 *
 * Entries are only stored from runs that neither changed the in-memory search
 * index nor left index.json and search.idx different from how they found them
 * (checked at process exit, after the index flush), so a run that re-indexed —
 * whose output depends on that rebuild — is never replayed.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT = 1;
const MAX_ENTRIES = 64;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function cacheDir() {
  return process.env.TRACEQUEST_CACHE_DIR || join(homedir(), ".cache", "tracequest");
}

export function searchResultCachePath() {
  return join(cacheDir(), "search-results.json");
}

function fileStamp(path) {
  try {
    const st = statSync(path, { bigint: true });
    return `${st.size}:${st.mtimeNs}:${st.ino}`;
  } catch {
    return "-";
  }
}

/** size+mtime of every tracequest code file and bundled sidecar: any edit or upgrade is a miss. */
function codeStamp() {
  const stamps = [];
  for (const dir of ["src", "bin"]) {
    let names = [];
    try {
      names = readdirSync(join(ROOT, dir), { recursive: true });
    } catch {
      // Missing dir: nothing to stamp.
    }
    for (const name of names.sort()) stamps.push(`${dir}/${name}=${fileStamp(join(ROOT, dir, name))}`);
  }
  for (const rel of ["package.json", "sidecar/target/release/tracequest-sidecar", "sidecar/target/debug/tracequest-sidecar"]) {
    stamps.push(`${rel}=${fileStamp(join(ROOT, rel))}`);
  }
  try {
    for (const name of readdirSync(join(ROOT, "sidecar/bin"), { recursive: true }).sort()) {
      stamps.push(`sidecar/bin/${name}=${fileStamp(join(ROOT, "sidecar/bin", name))}`);
    }
  } catch {
    // No bundled sidecars.
  }
  return stamps.join("\n");
}

function indexStamp() {
  return [fileStamp(join(cacheDir(), "index.json")), fileStamp(join(cacheDir(), "search.idx"))].join("|");
}

function envStamp() {
  return Object.keys(process.env)
    .filter((k) => k.startsWith("TRACEQUEST_"))
    .sort()
    .map((k) => `${k}=${process.env[k]}`)
    .join("\n");
}

/**
 * Every field of every discovered session row, in order (same information as
 * JSON.stringify, about twice as fast on a large hub: Dates go in as epoch ms).
 */
function hashSessions(hash, sessions) {
  let chunk = "";
  for (const row of sessions) {
    for (const key in row) {
      const v = row[key];
      // Strings are length-prefixed, so no value can run into the next field.
      const text = typeof v === "string" ? `s${v.length}:${v}`
        : v instanceof Date ? `D${v.getTime()}`
        : v !== null && typeof v === "object" ? `O${JSON.stringify(v)}`
        : `${typeof v}${v}`;
      chunk += `${key.length}:${key}${text}\u0002`;
    }
    chunk += "\n";
    if (chunk.length > 65536) {
      hash.update(chunk);
      chunk = "";
    }
  }
  hash.update(chunk);
}

function readStore(path) {
  try {
    const store = JSON.parse(readFileSync(path, "utf8"));
    if (store && store.format === FORMAT && Array.isArray(store.entries)) return store;
  } catch {
    // Missing or unreadable: an empty cache.
  }
  return null;
}

/**
 * Open the cache for one search. `request` holds every option that shapes the
 * result list (query, limit, format, sort, currentProject). Returns null when
 * the cache does not apply, else { hit, remember(results, stderr) } where hit
 * is { results, stderr } or null.
 */
export function openSearchResultCache(sessions, request) {
  if (process.env.TRACEQUEST_NO_RESULT_CACHE === "1" || process.env.TRACEQUEST_VERBOSE === "1") return null;
  const before = indexStamp();
  const hash = createHash("sha256").update(JSON.stringify([FORMAT, codeStamp(), envStamp(), before, sessions.length]));
  hashSessions(hash, sessions);
  const state = hash.digest("hex");
  const key = JSON.stringify(request);
  const path = searchResultCachePath();
  const store = readStore(path);
  const live = store && store.state === state ? store : null;
  const found = live?.entries.find((e) => e[0] === key);
  return {
    hit: found ? found[1] : null,
    /** `indexUnchanged`: the in-memory search index is still exactly the one loaded from disk. */
    remember(results, stderr, indexUnchanged) {
      if (!indexUnchanged) return;
      const entry = { results: JSON.parse(JSON.stringify(results)), stderr };
      // Runs after buildIndex's exit flush (registered earlier), so a run that
      // rewrote the index is seen here and not stored.
      process.once("exit", () => {
        if (indexStamp() !== before) return;
        const entries = (live?.entries || []).filter((e) => e[0] !== key);
        entries.push([key, entry]);
        try {
          mkdirSync(dirname(path), { recursive: true });
          const tmp = `${path}.${process.pid}.tmp`;
          writeFileSync(tmp, JSON.stringify({ format: FORMAT, state, entries: entries.slice(-MAX_ENTRIES) }));
          renameSync(tmp, path);
        } catch {
          // The cache is an optimisation; an unwritable cache dir is only a slower next run.
        }
      });
    },
  };
}

/** Record everything written to stderr until the returned stop() is called (which returns it). */
export function captureStderr() {
  const original = process.stderr.write;
  let text = "";
  process.stderr.write = function write(chunk, encoding, cb) {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8");
    return original.call(process.stderr, chunk, encoding, cb);
  };
  return () => {
    process.stderr.write = original;
    return text;
  };
}
