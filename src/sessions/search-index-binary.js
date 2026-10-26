/**
 * search.bin — the BM25 SearchIndex in a binary layout that opens without
 * parsing the whole index (facts 82g, ohy).
 *
 * search.idx (JSON) stays the source of truth. search.bin mirrors one exact
 * search.idx file: its header records that file's size, mtime (ns) and inode,
 * and a reader that sees a different search.idx ignores it. Opening reads the
 * header, paths, document lengths and the sorted vocabulary; a term's posting
 * list is read and decoded only when it is looked up.
 *
 * Layout (little endian; each section starts on a 4-byte boundary):
 *   header (64 bytes)
 *     0  magic "TQSB"            4  SEARCH_BIN_FORMAT     8  search.idx format (_sv)
 *     12 docs                    16 terms                 20 paths bytes
 *     24 vocab bytes             28 postings bytes
 *     32 search.idx size u64     40 search.idx mtime ns u64   48 search.idx inode u64
 *   paths      utf8, NUL-separated, in docLen order (the document ids)
 *   docLen     u32 x docs
 *   termStart  u32 x (terms + 1)  byte offset of each term in vocab
 *   vocab      utf8, every term followed by a NUL, in sorted (String sort) order
 *   postOff    u32 x (terms + 1)  byte offset of each term's postings
 *   postings   per term: (varint doc, varint tf) pairs in the posting's own order
 *
 * Orders are exactly those of a SearchIndex loaded from search.idx: terms in
 * sorted order (only non-empty postings), each posting in stored entry order,
 * documents in stored order. Doc indexes are NOT sorted or delta-encoded:
 * BM25 tie-breaks follow posting iteration order.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** Bump when the binary layout changes; a search.bin of another format is ignored. */
export const SEARCH_BIN_FORMAT = 1;

const MAGIC = 0x42535154; // "TQSB" read as a little-endian u32
const HEADER_BYTES = 64;
const MAX_U32 = 0xffffffff;

const pad4 = (n) => (n + 3) & ~3;

/** search.idx identity recorded in search.bin: a bigint fs.Stats of that file. */
export function fileIdentity(bigintStats) {
  return { size: bigintStats.size, mtimeNs: bigintStats.mtimeNs, ino: bigintStats.ino };
}

/** Count of NUL bytes in a buffer. */
function countNul(buf) {
  let n = 0;
  let i = buf.indexOf(0);
  while (i !== -1) {
    n++;
    i = buf.indexOf(0, i + 1);
  }
  return n;
}

/**
 * Builds search.bin term by term, from the same posting entry arrays
 * ([docIdx, tf, ...]) search.idx is written from. `ok` turns false when the
 * index holds something the layout cannot represent (a NUL in a path or term,
 * a non-integer count); such an index is written to search.idx only.
 */
export class BinaryIndexEncoder {
  /**
   * @param {string[]} paths
   * @param {number[]} docLens
   */
  constructor(paths, docLens) {
    this.ok = true;
    this._paths = paths;
    this._docLen = new Uint32Array(paths.length);
    for (let i = 0; i < paths.length; i++) {
      const v = docLens[i];
      if (!(Number.isInteger(v) && v >= 0 && v <= MAX_U32)) this.ok = false;
      else this._docLen[i] = v;
    }
    this._terms = [];
    this._postOff = [0];
    this._buf = Buffer.allocUnsafe(1 << 20);
    this._len = 0;
  }

  _varint(v) {
    if (!(Number.isInteger(v) && v >= 0 && v <= MAX_U32)) {
      this.ok = false;
      return;
    }
    if (this._len + 5 > this._buf.length) {
      const next = Buffer.allocUnsafe(this._buf.length * 2);
      this._buf.copy(next, 0, 0, this._len);
      this._buf = next;
    }
    const b = this._buf;
    let n = this._len;
    while (v >= 128) {
      b[n++] = (v & 127) | 128;
      v = Math.floor(v / 128);
    }
    b[n++] = v;
    this._len = n;
  }

  /**
   * Add the next term (terms must come in sorted order). An empty entry list
   * adds nothing: a SearchIndex loaded from search.idx has no such term either.
   * @param {string} term
   * @param {number[]} entries  [docIdx, tf, docIdx, tf, ...]
   */
  addTerm(term, entries) {
    if (!this.ok || !entries.length) return;
    this._terms.push(term);
    for (let i = 0; i < entries.length; i++) this._varint(entries[i]);
    this._postOff.push(this._len);
    if (this._len > MAX_U32) this.ok = false;
  }

  /**
   * The file contents as buffers to write in order, or null when the index
   * cannot be written in this layout.
   * @param {{ size: bigint, mtimeNs: bigint, ino: bigint }} identity  of the search.idx this mirrors
   * @param {number} searchIdxVersion
   * @returns {Buffer[]|null}
   */
  finish(identity, searchIdxVersion) {
    if (!this.ok) return null;
    const nDocs = this._paths.length;
    const nTerms = this._terms.length;
    const pathsBuf = Buffer.from(this._paths.join("\0"), "utf8");
    if (nDocs && countNul(pathsBuf) !== nDocs - 1) return null;
    const vocabBuf = nTerms ? Buffer.from(this._terms.join("\0") + "\0", "utf8") : Buffer.alloc(0);
    if (countNul(vocabBuf) !== nTerms) return null;
    const termStart = new Uint32Array(nTerms + 1);
    let t = 0;
    for (let i = 0; i < vocabBuf.length; i++) {
      if (vocabBuf[i] === 0) termStart[++t] = i + 1;
    }
    if (pathsBuf.length > MAX_U32 || vocabBuf.length > MAX_U32) return null;

    const header = Buffer.alloc(HEADER_BYTES);
    header.writeUInt32LE(MAGIC, 0);
    header.writeUInt32LE(SEARCH_BIN_FORMAT, 4);
    header.writeUInt32LE(searchIdxVersion, 8);
    header.writeUInt32LE(nDocs, 12);
    header.writeUInt32LE(nTerms, 16);
    header.writeUInt32LE(pathsBuf.length, 20);
    header.writeUInt32LE(vocabBuf.length, 24);
    header.writeUInt32LE(this._len, 28);
    header.writeBigUInt64LE(BigInt(identity.size), 32);
    header.writeBigUInt64LE(BigInt(identity.mtimeNs), 40);
    header.writeBigUInt64LE(BigInt(identity.ino), 48);

    const zeros = (n) => Buffer.alloc(pad4(n) - n);
    const u32 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
    return [
      header,
      pathsBuf, zeros(pathsBuf.length),
      u32(this._docLen),
      u32(termStart),
      vocabBuf, zeros(vocabBuf.length),
      u32(Uint32Array.from(this._postOff)),
      this._buf.subarray(0, this._len),
    ];
  }
}

function readFully(fd, buf, position) {
  let off = 0;
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, position + off);
    if (n === 0) throw new Error("search.bin: unexpected end of file");
    off += n;
  }
}

/**
 * Open search.bin when it mirrors the search.idx whose identity is `expect`.
 * Returns null (and holds no file open) when it is missing, of another format
 * or index version, truncated, or written for a different search.idx.
 * @param {string} binPath
 * @param {{ size: bigint, mtimeNs: bigint, ino: bigint }} expect
 * @param {number} searchIdxVersion
 * @returns {{ docLen: Map<string, number>, postings: LazyPostings }|null}
 */
export function openBinaryIndex(binPath, expect, searchIdxVersion) {
  let fd;
  try {
    fd = openSync(binPath, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < HEADER_BYTES) throw new Error("short");
    const h = Buffer.alloc(HEADER_BYTES);
    readFully(fd, h, 0);
    if (
      h.readUInt32LE(0) !== MAGIC ||
      h.readUInt32LE(4) !== SEARCH_BIN_FORMAT ||
      h.readUInt32LE(8) !== searchIdxVersion ||
      h.readBigUInt64LE(32) !== BigInt(expect.size) ||
      h.readBigUInt64LE(40) !== BigInt(expect.mtimeNs) ||
      h.readBigUInt64LE(48) !== BigInt(expect.ino)
    ) {
      throw new Error("mismatch");
    }
    const nDocs = h.readUInt32LE(12);
    const nTerms = h.readUInt32LE(16);
    const pathsBytes = h.readUInt32LE(20);
    const vocabBytes = h.readUInt32LE(24);
    const postBytes = h.readUInt32LE(28);
    const headLen = pad4(pathsBytes) + 4 * nDocs + 4 * (nTerms + 1) + pad4(vocabBytes) + 4 * (nTerms + 1);
    if (HEADER_BYTES + headLen + postBytes !== size) throw new Error("size");
    // A fresh ArrayBuffer so the u32 views below are aligned.
    const head = Buffer.from(new ArrayBuffer(headLen));
    readFully(fd, head, HEADER_BYTES);
    let o = 0;
    const paths = nDocs ? head.toString("utf8", 0, pathsBytes).split("\0") : [];
    if (paths.length !== nDocs) throw new Error("paths");
    o += pad4(pathsBytes);
    const docLens = new Uint32Array(head.buffer, o, nDocs);
    o += 4 * nDocs;
    const termStart = new Uint32Array(head.buffer, o, nTerms + 1);
    o += 4 * (nTerms + 1);
    const vocab = head.subarray(o, o + vocabBytes);
    o += pad4(vocabBytes);
    const postOff = new Uint32Array(head.buffer, o, nTerms + 1);
    if (termStart[nTerms] !== vocabBytes || postOff[nTerms] !== postBytes) throw new Error("offsets");
    const docLen = new Map();
    for (let i = 0; i < nDocs; i++) docLen.set(paths[i], docLens[i]);
    const postings = new LazyPostings(fd, {
      nTerms, termStart, vocab, postOff, postBase: HEADER_BYTES + headLen, paths,
    });
    return { docLen, postings };
  } catch {
    closeSync(fd);
    return null;
  }
}

/**
 * Read-only, Map-like view of the postings in search.bin: term -> Map(path -> tf).
 * Supports what the search path uses of a Map (get, has, size, keys, entries,
 * values, forEach, iteration) with the same orders a SearchIndex loaded from
 * search.idx has. Posting lists are decoded on first lookup and kept.
 */
export class LazyPostings {
  constructor(fd, { nTerms, termStart, vocab, postOff, postBase, paths }) {
    this._fd = fd;
    this._n = nTerms;
    this._termStart = termStart;
    this._vocab = vocab;
    this._postOff = postOff;
    this._postBase = postBase;
    this._paths = paths;
    /** @type {Map<string, Map<string, number>>} decoded postings by term */
    this._decoded = new Map();
    /** @type {string[]|null} every term, decoded on first full iteration */
    this._terms = null;
    /** @type {{ start: number, end: number, buf: Buffer }[]} prefetched posting byte ranges */
    this._ranges = [];
  }

  get size() {
    return this._n;
  }

  _termAt(i) {
    if (this._terms) return this._terms[i];
    return this._vocab.toString("utf8", this._termStart[i], this._termStart[i + 1] - 1);
  }

  /** First term index whose term is >= key (String comparison, the order sort() gives). */
  _lowerBound(key) {
    let lo = 0;
    let hi = this._n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this._termAt(mid) < key) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  _indexOf(term) {
    if (typeof term !== "string") return -1;
    const i = this._lowerBound(term);
    return i < this._n && this._termAt(i) === term ? i : -1;
  }

  _bytes(start, len) {
    for (const r of this._ranges) {
      if (start >= r.start && start + len <= r.end) return r.buf.subarray(start - r.start, start - r.start + len);
    }
    if (this._fd === null) throw new Error("search.bin: index closed");
    const buf = Buffer.allocUnsafe(len);
    readFully(this._fd, buf, this._postBase + start);
    return buf;
  }

  /** Read the posting bytes of terms [lo, hi) in one go, for the lookups that follow. */
  _prefetch(lo, hi) {
    if (hi - lo < 2) return;
    const start = this._postOff[lo];
    const end = this._postOff[hi];
    this._ranges.push({ start, end, buf: this._bytes(start, end - start) });
  }

  _postingAt(i, term = this._termAt(i)) {
    const hit = this._decoded.get(term);
    if (hit) return hit;
    const start = this._postOff[i];
    const len = this._postOff[i + 1] - start;
    const b = this._bytes(start, len);
    const paths = this._paths;
    const posting = new Map();
    let p = 0;
    while (p < len) {
      let doc = 0;
      let mul = 1;
      let c;
      do {
        c = b[p++];
        doc += (c & 127) * mul;
        mul *= 128;
      } while (c & 128);
      let tf = 0;
      mul = 1;
      do {
        c = b[p++];
        tf += (c & 127) * mul;
        mul *= 128;
      } while (c & 128);
      posting.set(paths[doc], tf);
    }
    this._decoded.set(term, posting);
    return posting;
  }

  has(term) {
    return this._decoded.has(term) || this._indexOf(term) >= 0;
  }

  get(term) {
    const hit = this._decoded.get(term);
    if (hit) return hit;
    const i = this._indexOf(term);
    return i < 0 ? undefined : this._postingAt(i, term);
  }

  /** Every term, in order. */
  allTerms() {
    if (!this._terms) {
      this._terms = this._n ? this._vocab.toString("utf8", 0, this._vocab.length - 1).split("\0") : [];
    }
    return this._terms;
  }

  /**
   * Terms starting with `prefix`, in iteration order: the same list as
   * filtering keys() by startsWith, found by binary search (a sorted
   * vocabulary keeps a prefix's terms contiguous).
   * @param {string} prefix
   * @returns {string[]}
   */
  termsWithPrefix(prefix) {
    const lo = this._lowerBound(prefix);
    let hi = lo;
    const out = [];
    while (hi < this._n) {
      const term = this._termAt(hi);
      if (!term.startsWith(prefix)) break;
      out.push(term);
      hi++;
    }
    this._prefetch(lo, hi);
    return out;
  }

  keys() {
    return this.allTerms()[Symbol.iterator]();
  }

  *entries() {
    const terms = this.allTerms();
    for (let i = 0; i < terms.length; i++) yield [terms[i], this._postingAt(i, terms[i])];
  }

  *values() {
    for (const [, posting] of this.entries()) yield posting;
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  forEach(fn, thisArg) {
    for (const [term, posting] of this.entries()) fn.call(thisArg, posting, term, this);
  }

  /** Every posting decoded into a plain Map, in iteration order. */
  toMap() {
    this._prefetch(0, this._n);
    const map = new Map();
    for (const [term, posting] of this.entries()) map.set(term, posting);
    return map;
  }

  close() {
    if (this._fd === null) return;
    try {
      closeSync(this._fd);
    } catch {
      // already closed
    }
    this._fd = null;
  }
}
