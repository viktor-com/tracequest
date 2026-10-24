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
import { mkdir, open, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";

/** 4: Codex tool output is tokenized, so older indexes are rebuilt (fact qy2). */
export const SEARCH_IDX_VERSION = 4;

/** Sessions whose term lists the index keeps for direct removal (fact hsi3). */
const MAX_REMEMBERED_DOCS = 256;
/** Batches larger than this (a bulk re-index) do not remember term lists. */
const REMEMBER_BATCH_MAX = 64;

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
    /**
     * Terms of each session upserted since load, so replacing an actively
     * written session removes its old postings directly instead of scanning
     * the whole vocabulary (fact hsi3). Bounded: past the cap, removal falls
     * back to the scan.
     * @type {Map<string, string[]>}
     */
    this._docTerms = new Map();
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
    this.upsertMany([[path, termFreqs]]);
  }

  /**
   * Insert or replace the term-frequency maps of several sessions. Old
   * postings of a session whose terms are remembered (upserted since load) are
   * removed directly; every other replaced session's are removed in ONE pass
   * over the vocabulary, so re-indexing thousands of sessions costs one scan
   * rather than one per session (fact hsi3).
   *
   * @param {Iterable<[string, Map<string,number>|null]>} entries  [path, termFreqs]; the last entry for a path wins
   */
  upsertMany(entries) {
    const byPath = new Map(entries);
    if (!byPath.size) return;
    const scan = new Set();
    for (const path of byPath.keys()) {
      if (!this._docLen.has(path)) continue;
      if (!this._removeKnownPostings(path)) scan.add(path);
    }
    this._removePostingsOf(scan);
    this._generation++;
    const remember = byPath.size <= REMEMBER_BATCH_MAX;
    for (const [path, termFreqs] of byPath) this._insertPostings(path, termFreqs, remember);
  }

  _insertPostings(path, termFreqs, remember) {
    if (!termFreqs || !termFreqs.size) {
      this._docLen.set(path, 0);
      if (remember) this._rememberTerms(path, []);
      else this._docTerms.delete(path);
      return;
    }
    let docLen = 0;
    const terms = remember ? [] : null;
    for (const [term, tf] of termFreqs) {
      let posting = this._postings.get(term);
      if (!posting) {
        posting = new Map();
        this._postings.set(term, posting);
      }
      posting.set(path, tf);
      docLen += tf;
      if (terms) terms.push(term);
    }
    this._docLen.set(path, docLen);
    if (remember) this._rememberTerms(path, terms);
    else this._docTerms.delete(path);
  }

  _rememberTerms(path, terms) {
    if (!this._docTerms.has(path) && this._docTerms.size >= MAX_REMEMBERED_DOCS) this._docTerms.clear();
    this._docTerms.set(path, terms);
  }

  /**
   * Remove a session from the index.
   * @param {string} path
   */
  remove(path) {
    this.removeMany([path]);
  }

  /**
   * Remove several sessions in at most one pass over the vocabulary.
   * @param {Iterable<string>} paths
   */
  removeMany(paths) {
    const scan = new Set();
    const gone = [];
    for (const path of paths) {
      if (!this._docLen.has(path)) continue;
      gone.push(path);
      if (!this._removeKnownPostings(path)) scan.add(path);
    }
    this._removePostingsOf(scan);
    for (const path of gone) this._docLen.delete(path);
    this._generation++;
  }

  /** Remove the postings of a session whose terms are remembered; false when they are not. */
  _removeKnownPostings(path) {
    const known = this._docTerms.get(path);
    if (!known) return false;
    this._docTerms.delete(path);
    for (const term of known) {
      const posting = this._postings.get(term);
      if (!posting) continue;
      posting.delete(path);
      if (!posting.size) this._postings.delete(term);
    }
    return true;
  }

  /**
   * Drop the postings of `paths` (sessions present in the index, terms not
   * remembered). There is no full reverse index, so this scans the vocabulary
   * once for the whole set: each posting list is walked or probed, whichever
   * is smaller.
   * @param {Set<string>} paths
   */
  _removePostingsOf(paths) {
    if (!paths.size) return;
    for (const [term, posting] of this._postings) {
      if (posting.size <= paths.size) {
        for (const path of posting.keys()) if (paths.has(path)) posting.delete(path);
      } else {
        for (const path of paths) posting.delete(path);
      }
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
    const gone = [];
    for (const path of this._docLen.keys()) {
      if (!validPaths.has(path)) gone.push(path);
    }
    if (gone.length) this.removeMany(gone);
    // Drop empty posting lists (may be left over from removes above)
    for (const [term, posting] of this._postings) {
      if (!posting.size) this._postings.delete(term);
    }
    // _generation already bumped by removeMany() above.
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
   * serialize() as a sequence of string pieces produced in slices of at most
   * ~`sliceMs` of event-loop time, yielding between slices (fact sidx2): a
   * multi-hundred-MB index never blocks request serving while it is written.
   * Resolves to the pieces (their concatenation equals serialize()), or null
   * when the index changed while they were being produced.
   * @returns {Promise<string[]|null>}
   */
  async serializePiecesAsync(sliceMs = 15) {
    const gen = this._generation;
    let sliceStart = Date.now();
    const pause = async () => {
      if (Date.now() - sliceStart < sliceMs) return true;
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = Date.now();
      return this._generation === gen;
    };
    const vocab = [...this._postings.keys()].sort();
    if (!(await pause())) return null;
    const pathArr = [...this._docLen.keys()];
    const pathIdx = new Map();
    for (let i = 0; i < pathArr.length; i++) pathIdx.set(pathArr[i], i);
    if (!(await pause())) return null;
    const pieces = [`{"_sv":${JSON.stringify(SEARCH_IDX_VERSION)},"vocab":`, JSON.stringify(vocab), ',"postings":['];
    if (!(await pause())) return null;
    let batch = [];
    for (let vi = 0; vi < vocab.length; vi++) {
      const posting = this._postings.get(vocab[vi]);
      const entries = [];
      if (posting) {
        for (const [path, tf] of posting) {
          const pi = pathIdx.get(path);
          if (pi !== undefined) entries.push(pi, tf);
        }
      }
      batch.push(JSON.stringify(entries));
      if ((vi & 255) === 255) {
        pieces.push((vi > 255 ? "," : "") + batch.join(","));
        batch = [];
        if (!(await pause())) return null;
      }
    }
    if (batch.length) pieces.push((vocab.length > batch.length ? "," : "") + batch.join(","));
    pieces.push('],"paths":', JSON.stringify(pathArr), ',"docLen":', JSON.stringify(pathArr.map((p) => this._docLen.get(p))), "}");
    return (await pause()) ? pieces : null;
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
/** Indexes of at most this many sessions are written synchronously when the debounce fires. */
const SYNC_WRITE_MAX_DOCS = 500;

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

/**
 * The deferred write: serialized in slices that yield the event loop and
 * written asynchronously (fact sidx2). An index that changes meanwhile is
 * written by the next scheduled write instead.
 */
async function writeSearchIdxToDiskAsync() {
  if (!_searchIdx) return;
  const idx = _searchIdx;
  const tWrite = Date.now();
  const pieces = await idx.serializePiecesAsync();
  if (!pieces || idx !== _searchIdx) {
    scheduleSearchIdxWrite();
    return;
  }
  const dir = searchIdxCacheDir();
  await mkdir(dir, { recursive: true });
  const p = searchIdxPath();
  const tmp = `${p}.${process.pid}.tmp`;
  const fh = await open(tmp, "w");
  try {
    for (const piece of pieces) await fh.write(piece);
  } finally {
    await fh.close();
  }
  await rename(tmp, p);
  searchIdxLog(`search.idx: wrote ${idx.docCount} sessions in ${Date.now() - tWrite}ms (sliced)`);
}

export function scheduleSearchIdxWrite() {
  if (_searchIdxWriteTimer) clearTimeout(_searchIdxWriteTimer);
  _searchIdxWriteTimer = setTimeout(() => {
    _searchIdxWriteTimer = null;
    // A small index serializes in a few ms: write it at once. A corpus-sized
    // one (hundreds of ms to serialize) is written in yielding slices.
    if (!_searchIdx || _searchIdx.docCount <= SYNC_WRITE_MAX_DOCS) {
      try {
        writeSearchIdxToDisk();
      } catch (err) {
        console.warn("deferred search.idx write failed:", err.message);
      }
      return;
    }
    writeSearchIdxToDiskAsync().catch((err) => {
      console.warn("deferred search.idx write failed:", err.message);
    });
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
