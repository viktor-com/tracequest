/**
 * BM25 SearchIndex — Vocabulary + Postings + per-session document lengths.
 *
 * Defaults to ~/.cache/tracequest/search.idx (TRACEQUEST_CACHE_DIR overrides the directory),
 * persisted as a compact versioned JSON file.
 * Separate from index.json; an existing-file load failure triggers re-tokenization
 * because metadata entries do not contain term frequencies (fact 21x).
 * In-memory SearchIndex updated immediately; writes debounced (fact v99).
 *
 * Serialized format (arrays, not nested objects per posting):
 *   {
 *     _sv: <SEARCH_IDX_VERSION>,
 *     vocab: ["term0", "term1", ...],          // sorted unique terms
 *     postings: [[sessionIdx, tf], ...][],      // one array per vocab entry
 *     paths: ["path0", "path1", ...],           // session paths (document IDs)
 *     docLen: [n0, n1, ...],                    // token counts per session
 *   }
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

export const SEARCH_IDX_VERSION = 3;

function searchIdxLog(...args) {
  if (process.env.TRACEQUEST_VERBOSE === "1") console.log(...args);
}

/**
 * In-memory SearchIndex structure.
 * All mutation happens on the main thread only.
 */
export class SearchIndex {
  constructor() {
    /** @type {Map<string, Map<string, number>>} term → (path → tf) */
    this._postings = new Map();
    /** @type {Map<string, number>} path → token count */
    this._docLen = new Map();
    /**
     * Monotonically increasing counter, bumped on every mutation.
     * Used by scan-queries to invalidate the trigram index cache (fact 1h8).
     * @type {number}
     */
    this._generation = 0;
  }

  get docCount() {
    return this._docLen.size;
  }

  get avgDocLen() {
    if (!this._docLen.size) return 0;
    let total = 0;
    for (const v of this._docLen.values()) total += v;
    return total / this._docLen.size;
  }

  /**
   * Insert or replace a session's term-frequency map.
   * Removes existing postings for the session before inserting new ones.
   *
   * @param {string} path
   * @param {Map<string,number>} termFreqs
   */
  upsert(path, termFreqs) {
    this._removePostings(path);
    this._generation++;
    if (!termFreqs || !termFreqs.size) {
      this._docLen.set(path, 0);
      return;
    }
    let docLen = 0;
    for (const [term, tf] of termFreqs) {
      let posting = this._postings.get(term);
      if (!posting) {
        posting = new Map();
        this._postings.set(term, posting);
      }
      posting.set(path, tf);
      docLen += tf;
    }
    this._docLen.set(path, docLen);
  }

  /**
   * Remove all postings for a session path (prune from disk or mtime-changed).
   * @param {string} path
   */
  remove(path) {
    this._removePostings(path);
    this._docLen.delete(path);
    this._generation++;
  }

  _removePostings(path) {
    if (!this._docLen.has(path)) return;
    // We don't have a reverse index, so scan postings for this path.
    // In practice the posting lists are small relative to vocab size and this
    // only runs on stale sessions (mtime-changed), not on every access.
    for (const [term, posting] of this._postings) {
      posting.delete(path);
      if (!posting.size) this._postings.delete(term);
    }
  }

  /**
   * Whether a path is present in the SearchIndex (has a doc-length entry).
   * @param {string} path
   * @returns {boolean}
   */
  has(path) {
    return this._docLen.has(path);
  }

  /** @returns {Map<string, Map<string,number>>} */
  get postings() {
    return this._postings;
  }

  /** @returns {Map<string,number>} */
  get docLens() {
    return this._docLen;
  }

  /**
   * Drop empty posting lists and remove paths no longer in validPaths.
   * Called at prune time (fact 03w).
   * @param {Set<string>} validPaths
   */
  pruneRemovedSessions(validPaths) {
    for (const path of this._docLen.keys()) {
      if (!validPaths.has(path)) this.remove(path);
    }
    // Drop empty posting lists (may be left over from removes above)
    for (const [term, posting] of this._postings) {
      if (!posting.size) this._postings.delete(term);
    }
    // _generation already bumped by each remove() call above.
  }

  /**
   * Serialize to compact JSON string.
   */
  serialize() {
    // Build sorted vocabulary
    const vocab = [...this._postings.keys()].sort();
    // Build paths list (stable order from docLen map)
    const pathArr = [...this._docLen.keys()];
    const pathIdx = new Map();
    for (let i = 0; i < pathArr.length; i++) pathIdx.set(pathArr[i], i);

    const postingsList = new Array(vocab.length);
    for (let vi = 0; vi < vocab.length; vi++) {
      const posting = this._postings.get(vocab[vi]);
      const entries = [];
      for (const [path, tf] of posting) {
        const pi = pathIdx.get(path);
        if (pi !== undefined) entries.push(pi, tf);
      }
      postingsList[vi] = entries;
    }

    const docLen = pathArr.map((p) => this._docLen.get(p));

    return JSON.stringify({
      _sv: SEARCH_IDX_VERSION,
      vocab,
      postings: postingsList,
      paths: pathArr,
      docLen,
    });
  }

  /**
   * Deserialize from compact JSON (produced by serialize()).
   * Returns null on version mismatch or parse error.
   * @param {string} raw
   * @returns {SearchIndex|null}
   */
  static deserialize(raw) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    if (obj._sv !== SEARCH_IDX_VERSION) return null;
    const { vocab, postings: postingsList, paths, docLen } = obj;
    if (!Array.isArray(vocab) || !Array.isArray(postingsList) || !Array.isArray(paths) || !Array.isArray(docLen)) {
      return null;
    }
    const idx = new SearchIndex();
    // Rebuild docLen
    for (let i = 0; i < paths.length; i++) {
      idx._docLen.set(paths[i], docLen[i]);
    }
    // Rebuild postings
    for (let vi = 0; vi < vocab.length; vi++) {
      const entries = postingsList[vi];
      if (!entries || !entries.length) continue;
      const posting = new Map();
      for (let i = 0; i < entries.length; i += 2) {
        posting.set(paths[entries[i]], entries[i + 1]);
      }
      idx._postings.set(vocab[vi], posting);
    }
    // Loaded from disk — new state, bump generation so any cached trigram
    // index is rebuilt on next fuzzy query (fact 1h8).
    idx._generation++;
    return idx;
  }
}

// --- Persistence (module-scope singleton) ---

let _searchIdx = null;
let _searchIdxWriteTimer = null;
const SEARCH_IDX_WRITE_DELAY_MS = 30_000;

function searchIdxCacheDir() {
  return process.env.TRACEQUEST_CACHE_DIR || join(homedir(), ".cache", "tracequest");
}

export function searchIdxPath() {
  return join(searchIdxCacheDir(), "search.idx");
}

/** Access (or lazily initialize) the global SearchIndex. */
export function getSearchIndex() {
  if (!_searchIdx) _searchIdx = new SearchIndex();
  return _searchIdx;
}

/**
 * Load search.idx from disk into the in-memory singleton.
 * Returns false when the file is absent or cannot be loaded.
 * @returns {boolean} true if loaded successfully
 */
export function loadSearchIndex() {
  const p = searchIdxPath();
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, "utf-8");
    const loaded = SearchIndex.deserialize(raw);
    if (!loaded) {
      searchIdxLog("search.idx: corrupt or version-mismatched, will rebuild");
      return false;
    }
    _searchIdx = loaded;
    searchIdxLog(`search.idx: loaded ${_searchIdx.docCount} sessions`);
    return true;
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error("loadSearchIndex: failed to read search.idx:", err.message);
    }
    return false;
  }
}

function writeSearchIdxToDisk() {
  if (!_searchIdx) return;
  const dir = searchIdxCacheDir();
  mkdirSync(dir, { recursive: true });
  const p = searchIdxPath();
  const tmp = p + ".tmp";
  const tWrite = Date.now();
  const serialized = _searchIdx.serialize();
  writeFileSync(tmp, serialized);
  renameSync(tmp, p);
  searchIdxLog(`search.idx: wrote ${_searchIdx.docCount} sessions in ${Date.now() - tWrite}ms (${Math.round(serialized.length / 1024)}KB)`);
}

export function scheduleSearchIdxWrite() {
  if (_searchIdxWriteTimer) clearTimeout(_searchIdxWriteTimer);
  _searchIdxWriteTimer = setTimeout(() => {
    _searchIdxWriteTimer = null;
    try {
      writeSearchIdxToDisk();
    } catch (err) {
      console.warn("deferred search.idx write failed:", err.message);
    }
  }, SEARCH_IDX_WRITE_DELAY_MS);
  if (_searchIdxWriteTimer.unref) _searchIdxWriteTimer.unref();
}

export function flushSearchIdxWriteForTests() {
  if (_searchIdxWriteTimer) {
    clearTimeout(_searchIdxWriteTimer);
    _searchIdxWriteTimer = null;
  }
  writeSearchIdxToDisk();
}

export function resetSearchIndexForTests() {
  _searchIdx = null;
  if (_searchIdxWriteTimer) {
    clearTimeout(_searchIdxWriteTimer);
    _searchIdxWriteTimer = null;
  }
}
