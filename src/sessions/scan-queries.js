import { existsSync } from "node:fs";
import { join } from "node:path";
import { isClaudeProgressFillerLine, isCursorCloudMetaLine } from "../parse/claude-jsonl-index.js";
import { isCodexIndexSkippableLine } from "../parse/codex-event-msg.js";
import { isGrokChatScanSkippableLine } from "../parse/grok-chat-index.js";
import { isFactoryScanSkippableLine } from "../parse/parse-factory.js";
import { forEachJsonlLine, forEachJsonlLineFromFile } from "../parse/jsonl-read.js";
import { includesLower, indexOfLower, parseEscapedJsonString, safeSlice } from "../parse/parse-utils.js";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { sessionHash } from "./session-hash.js";
import { sessionMtimeMs } from "./session-list.js";
import { withOpenCodeDb } from "./session-discovery-paths.js";
import { OPENCODE_TERM_INDEX_PART_TYPES_SQL } from "./session-index-opencode.js";
import { tokenize } from "./search-tokenizer.js";
import { getSearchIndex } from "./search-index.js";

/** Hoisted scan patterns (global; String.matchAll resets lastIndex per call). */
const RE_FILE_PATH = /"file_path":\s*"([^"]+)"/g;
const RE_GROK_FILE_PATH = /"(?:file_path|path)":\s*"([^"]+)"/g;
const RE_COMMAND = /"command":\s*"((?:[^"\\]|\\.)*)"/g;
const RE_ERROR_FIELD = /"(?:error|Error|stderr)":\s*"((?:[^"\\]|\\.)*)"/g;
const RE_NEWLINE = /\n/g;

/** Suppress duplicate scan-error lines; key = "label:loc:message", TTL 60 s. */
const _warnedScanErrors = new Map();
function warnScanQueryFailed(label, loc, err) {
  if (isIndexDiskExpectedErr(err)) return;
  const key = `${label}:${loc}:${err.message}`;
  const now = Date.now();
  const last = _warnedScanErrors.get(key);
  if (last !== undefined && now - last < 60_000) return;
  _warnedScanErrors.set(key, now);
  console.error(`${label}: failed to scan ${loc}:`, err.message);
}

/** ENOENT → caller returns []; unexpected failures log once and propagate. */
function finishScanQueryCatch(label, loc, err) {
  if (isIndexDiskExpectedErr(err)) return;
  warnScanQueryFailed(label, loc, err);
  throw err;
}

/** Canonical OpenCode session id: .file, else id parsed from opencode:// virtual path. */
function openCodeSessionFileId(session) {
  return session.file ||
    (session.path && session.path.startsWith("opencode://")
      ? session.path.slice("opencode://".length)
      : undefined);
}

function searchResultRow(session, meta, matches) {
  const file = openCodeSessionFileId(session);
  const hash = sessionHash(session.path);
  return {
    path: session.path,
    sessionHash: hash,
    source: session.source || "claude",
    ...(session.host ? { host: session.host } : {}),
    project: session.project,
    file,
    mtime: sessionMtimeMs(session),
    id: hash,
    prompt: meta.firstPrompt || "",
    model: meta.model || "",
    matches,
  };
}

// ---------------------------------------------------------------------------
// BM25 constants (facts bpf, 1h8)
// ---------------------------------------------------------------------------
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const FUZZY_MAX_EXPANSIONS = 3;
const FUZZY_MIN_JACCARD = 0.4;

// ---------------------------------------------------------------------------
// Trigram helpers (facts 5hi, 1h8)
// Built lazily once per Vocabulary snapshot; keyed by Vocabulary reference.
// ---------------------------------------------------------------------------

/**
 * Trigram index cache keyed by postings Map reference.
 * Each entry is { generation: number, index: Map<string, Set<string>> }.
 * The cached index is rebuilt when SearchIndex._generation has changed
 * since it was built (fact 1h8).
 * @type {WeakMap<Map<string,*>, { generation: number, index: Map<string, Set<string>> }>}
 */
const _trigramMapCache = new WeakMap();

function buildTrigramSet(term) {
  const s = `  ${term}  `;
  const tgrams = new Set();
  for (let i = 0; i < s.length - 2; i++) {
    tgrams.add(s.slice(i, i + 3));
  }
  return tgrams;
}

function trigramJaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  return inter / (setA.size + setB.size - inter);
}

/**
 * Build (or return cached) trigram inverted index over Vocabulary terms.
 * Keys: trigram string → Set of vocab terms containing it.
 * Cached via WeakMap on the postings Map reference; invalidated when the
 * SearchIndex generation counter changes (upsert/remove/prune bump it).
 * The cache is rebuilt lazily on the next fuzzy query after any mutation.
 * (fact 5hi, 1h8)
 *
 * @param {import('./search-index.js').SearchIndex} si
 * @returns {Map<string, Set<string>>}
 */
function getTrigramIndex(si) {
  const postings = si.postings;
  const current = si._generation;
  const entry = _trigramMapCache.get(postings);
  if (entry && entry.generation === current) return entry.index;
  const idx = new Map();
  for (const term of postings.keys()) {
    for (const tg of buildTrigramSet(term)) {
      let bucket = idx.get(tg);
      if (!bucket) { bucket = new Set(); idx.set(tg, bucket); }
      bucket.add(term);
    }
  }
  _trigramMapCache.set(postings, { generation: current, index: idx });
  return idx;
}

/**
 * Expand a query term absent from Vocabulary to at most 3 Vocabulary terms
 * with trigram Jaccard >= 0.4. Returns [{term, similarity}] sorted descending.
 * (facts 1h8, 5hi)
 *
 * @param {string} queryTerm
 * @param {import('./search-index.js').SearchIndex} si
 * @returns {{term: string, similarity: number}[]}
 */
function fuzzyExpand(queryTerm, si) {
  const postings = si.postings;
  if (!postings.size) return [];
  const trigramIdx = getTrigramIndex(si);
  const queryTgrams = buildTrigramSet(queryTerm);

  // Candidate vocab terms: only those sharing at least one trigram with queryTerm.
  const candidates = new Set();
  for (const tg of queryTgrams) {
    const bucket = trigramIdx.get(tg);
    if (bucket) for (const t of bucket) candidates.add(t);
  }

  const results = [];
  for (const vocabTerm of candidates) {
    const vocabTgrams = buildTrigramSet(vocabTerm);
    const sim = trigramJaccard(queryTgrams, vocabTgrams);
    if (sim >= FUZZY_MIN_JACCARD) results.push({ term: vocabTerm, similarity: sim });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, FUZZY_MAX_EXPANSIONS);
}

/**
 * Expand final query term by prefix match over Vocabulary (fact 3ns).
 * Returns all Vocabulary terms that start with the given prefix.
 *
 * @param {string} prefix
 * @param {Map<string, Map<string,number>>} postings
 * @returns {string[]}
 */
export function prefixExpand(prefix, postings) {
  const results = [];
  for (const term of postings.keys()) {
    if (term !== prefix && term.startsWith(prefix)) results.push(term);
  }
  return results;
}

/**
 * Resolve a single query token to vocabulary matches with weights.
 *
 * Logic (facts 1h8, 3ns, m6s):
 *   - If the token is in Vocabulary: exact match with weight 1.0
 *   - Else: fuzzy expansion (≤3 terms, Jaccard ≥0.4), weight = similarity
 *   - If isFinal is true: additionally prefix-expand the token (weight 1.0)
 *     for search-as-you-type behavior (fact 3ns)
 *
 * Shared between searchSessions and buildBm25FilterContext so both paths
 * produce identical match sets (fact 0oy).
 *
 * @param {string} token - already lowercased, tokenized query token
 * @param {boolean} isFinal - true if this is the last non-phrase token in the query term
 * @param {import('./search-index.js').SearchIndex} si
 * @returns {{ term: string, weight: number }[]}
 */
export function resolveQueryToken(token, isFinal, si) {
  const postings = si.postings;
  const matches = [];
  if (postings.has(token)) {
    matches.push({ term: token, weight: 1.0 });
  } else {
    const fuzzy = fuzzyExpand(token, si);
    for (const { term, similarity } of fuzzy) {
      matches.push({ term, weight: similarity });
    }
  }
  if (isFinal) {
    const prefixTerms = prefixExpand(token, postings);
    for (const pt of prefixTerms) {
      if (!matches.find(m => m.term === pt)) {
        matches.push({ term: pt, weight: 1.0 });
      }
    }
  }
  return matches;
}

/**
 * Union of session paths that match any resolved vocab term.
 *
 * @param {{ term: string, weight?: number }[]} matches
 * @param {Map<string, Map<string, number>>} postings
 * @returns {Set<string>}
 */
export function pathsFromPostingMatches(matches, postings) {
  const paths = new Set();
  for (const { term } of matches) {
    const posting = postings.get(term);
    if (posting) {
      for (const path of posting.keys()) paths.add(path);
    }
  }
  return paths;
}

/**
 * Intersect multiple Sets (AND semantics over session paths). (fact m6s)
 *
 * @param {Set<string>[]} sets
 * @returns {Set<string>}
 */
export function intersectSets(sets) {
  if (!sets.length) return new Set();
  let result = sets[0];
  for (let i = 1; i < sets.length; i++) {
    const next = new Set();
    for (const p of result) {
      if (sets[i].has(p)) next.add(p);
    }
    result = next;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Query parser: splits into terms and quoted phrases (fact yd3)
// ---------------------------------------------------------------------------

/**
 * Parse query string into segments: [{type:'term'|'phrase', value:string}]
 * Quoted text (single or double quotes) becomes a 'phrase' segment.
 * Unquoted text is split by whitespace into individual 'term' segments.
 */
function parseQuerySegments(query) {
  const segments = [];
  let i = 0;
  const s = query.trim();
  while (i < s.length) {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i++];
      let word = '';
      while (i < s.length && s[i] !== q) word += s[i++];
      if (i < s.length) i++;
      if (word.trim()) segments.push({ type: 'phrase', value: word.trim() });
    } else {
      let word = '';
      while (i < s.length && s[i] !== ' ' && s[i] !== '\t') word += s[i++];
      if (word) segments.push({ type: 'term', value: word });
    }
  }
  return segments;
}

// ---------------------------------------------------------------------------
// BM25 scoring helpers
// ---------------------------------------------------------------------------

/**
 * Compute BM25 score contribution for one query term posting.
 *
 * @param {number} tf - term frequency in the document
 * @param {number} docLen
 * @param {number} avgDocLen
 * @param {number} N - total document count
 * @param {number} df - number of documents containing the term
 * @returns {number}
 */
function bm25Score(tf, docLen, avgDocLen, N, df) {
  const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
  const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / (avgDocLen || 1))));
  return idf * tfNorm;
}

// ---------------------------------------------------------------------------
// searchSessions — BM25 path (facts bpf, m6s, yd3, yyz, cot, n03, 1h8, 5hi, 3ns, fp4)
// ---------------------------------------------------------------------------

/**
 * Search sessions using BM25 ranking over the SearchIndex.
 *
 * @param {object[]} sessions
 * @param {Map<string,object>} index - metadata index (firstPrompt, model, etc.)
 * @param {string} query
 * @param {number} [maxResults=50]
 * @param {{ sort?: "recent"|"date", phraseScanCap?: number, snippets?: boolean }} [options]
 * @returns {object[]} result rows sorted by BM25 score descending, or by mtime descending when options.sort is recent/date
 */
export function searchSessions(sessions, index, query, maxResults = 50, options = {}) {
  if (!query || !query.trim()) return [];

  const si = getSearchIndex();
  const postings = si.postings;
  const docLens = si.docLens;
  const N = si.docCount;
  const avgDocLen = si.avgDocLen;

  // fp4: if SearchIndex started empty (e.g. search.idx absent/unloadable),
  // buildIndex should already have re-populated it before searchSessions is called.
  // In the rare case it's still empty here, return no results.
  if (!postings.size) {
    return [];
  }

  // Parse query into segments (terms and quoted phrases)
  const segments = parseQuerySegments(query);
  if (!segments.length) return [];

  // Build flat list of tokens with metadata.
  // The "final non-phrase token" gets prefix expansion (fact 3ns).
  const termList = [];
  const phrases = [];
  for (const seg of segments) {
    const tokens = tokenize(seg.value);
    if (!tokens.length) continue;
    if (seg.type === 'phrase') {
      phrases.push({ tokens, raw: seg.value.toLowerCase() });
      for (const t of tokens) termList.push({ token: t, fromPhrase: true });
    } else {
      for (const t of tokens) termList.push({ token: t, fromPhrase: false });
    }
  }
  if (!termList.length) return [];

  // Find index of last non-phrase token for prefix expansion
  let lastNonPhraseIdx = -1;
  for (let i = termList.length - 1; i >= 0; i--) {
    if (!termList[i].fromPhrase) { lastNonPhraseIdx = i; break; }
  }

  // Resolve each unique query token to vocab matches with weights
  const resolvedTerms = [];
  const seen = new Set();
  const finalToken = lastNonPhraseIdx >= 0 ? termList[lastNonPhraseIdx].token : null;
  for (let i = 0; i < termList.length; i++) {
    const { token } = termList[i];
    if (seen.has(token)) continue;
    seen.add(token);
    const isFinalNonPhrase = token === finalToken;
    const matches = resolveQueryToken(token, isFinalNonPhrase, si);
    resolvedTerms.push({ queryToken: token, matches });
  }

  // Score sessions and build per-query-token match sets for AND semantics
  const scores = new Map();
  const termMatchSets = [];
  const scoredTerms = new Map(); // term → best weight already scored
  for (const { matches } of resolvedTerms) {
    const matchSet = new Set();
    for (const { term, weight } of matches) {
      const posting = postings.get(term);
      if (!posting) continue;
      const df = posting.size;
      const prevWeight = scoredTerms.get(term);
      const shouldScore = prevWeight === undefined;
      const shouldUpgrade = !shouldScore && weight > prevWeight;
      if (shouldScore || shouldUpgrade) {
        scoredTerms.set(term, weight);
        for (const [path, tf] of posting) {
          const docLen = docLens.get(path) || 1;
          const score = bm25Score(tf, docLen, avgDocLen, N, df) * weight;
          if (shouldUpgrade) {
            // Replace the previously added contribution for this term
            const prevScore = bm25Score(tf, docLen, avgDocLen, N, df) * prevWeight;
            scores.set(path, (scores.get(path) || 0) - prevScore + score);
          } else {
            scores.set(path, (scores.get(path) || 0) + score);
          }
          matchSet.add(path);
        }
      } else {
        // Term already scored at equal or higher weight; still populate matchSet
        for (const [path] of posting) {
          matchSet.add(path);
        }
      }
    }
    termMatchSets.push(matchSet);
  }

  // AND filter: keep only paths present in all match sets (fact m6s)
  if (!termMatchSets.length) return [];
  const andSet = intersectSets(termMatchSets);

  // Restrict to input sessions that have index entries, and keep the same
  // lookup for result materialization below.
  const sessionByPath = new Map();
  for (const s of sessions) {
    if (index.has(s.path)) sessionByPath.set(s.path, s);
  }

  // Collect and sort candidates
  const candidates = [];
  for (const path of andSet) {
    if (!sessionByPath.has(path)) continue;
    candidates.push({ path, score: scores.get(path) || 0 });
  }
  candidates.sort((a, b) => b.score - a.score);
  if (options?.sort === "recent" || options?.sort === "date") {
    candidates.sort((a, b) => sessionMtimeMs(sessionByPath.get(b.path)) - sessionMtimeMs(sessionByPath.get(a.path)));
  }

  if (!candidates.length) return [];

  // Expanded vocab terms matched (for snippet extraction, fact n03)
  const expandedTerms = new Set();
  for (const { matches } of resolvedTerms) {
    for (const { term } of matches) expandedTerms.add(term);
  }

  // Phrase queries: verify before counting toward maxResults (fact e3y).
  // Iterate BM25-ranked candidates and run phrase scan on each; stop once
  // maxResults verified results are collected or the scan cap is reached.
  // Non-phrase path: slice to maxResults upfront as before (fact yyz) —
  // no extra scans, same cost as before.
  const requestedPhraseScanCap = Number(options?.phraseScanCap);
  const phraseScanCap = Number.isFinite(requestedPhraseScanCap) && requestedPhraseScanCap > 0
    ? requestedPhraseScanCap
    : Math.max(200, maxResults * 10);
  const wantSnippets = options?.snippets !== false;
  // Index-only path (palette): no phrase verification or snippet file scans.
  const scanPhrases = wantSnippets && phrases.length > 0;
  const scanCap = scanPhrases ? Math.max(maxResults, phraseScanCap) : maxResults;
  const top = scanPhrases ? candidates : candidates.slice(0, maxResults);

  const results = [];
  let scanned = 0;
  for (const { path } of top) {
    if (results.length >= maxResults) break;
    if (scanned >= scanCap) break;

    const s = sessionByPath.get(path);
    if (!s) continue;
    const meta = index.get(path);
    if (!meta) continue;

    if (!wantSnippets) {
      const fp = meta.firstPrompt || "";
      results.push(searchResultRow(s, meta, [{ type: "text", snippet: fp || "(match in session content)" }]));
      continue;
    }

    // Phrase verification: exact substring match via on-demand scan (fact yd3, e3y)
    // Collect phrase snippets here so they can be reused in the snippet block below.
    const verifiedPhraseSnips = new Map();
    if (phrases.length > 0) {
      scanned++;
      let phraseVerified = true;
      for (const { raw } of phrases) {
        const phraseSnips = scanSessionForQuery(s, raw, 1);
        if (!phraseSnips.length) { phraseVerified = false; break; }
        verifiedPhraseSnips.set(raw, phraseSnips);
      }
      if (!phraseVerified) continue;
    }

    // Find which expanded terms actually hit this document
    const docTerms = [];
    for (const term of expandedTerms) {
      const posting = postings.get(term);
      if (posting && posting.has(path)) docTerms.push(term);
    }

    // Snippet extraction via on-demand scan, driven by matched terms (fact n03, cot)
    let snippets = [];

    // For phrase queries, fill the first slot with the literal phrase occurrence (fact yq2)
    // Reuse snippets already collected during verification — no second file read.
    for (const { raw } of phrases) {
      if (snippets.length >= 3) break;
      const phraseSnips = verifiedPhraseSnips.get(raw) || [];
      for (const snip of phraseSnips) {
        if (snippets.length >= 3) break;
        snippets.push(snip);
      }
    }

    const termSnippets = docTerms.length > 1 && snippets.length < 3
      ? scanSessionForQueries(s, docTerms, 3 - snippets.length)
      : null;

    for (const term of docTerms) {
      if (snippets.length >= 3) break;
      const s2 = termSnippets?.get(term) ?? scanSessionForQuery(s, term, 3 - snippets.length);
      for (const snip of s2) {
        if (snippets.length >= 3) break;
        snippets.push(snip);
      }
    }
    // Fallback to firstPrompt snippet (fact n03)
    if (!snippets.length) {
      const fp = meta.firstPrompt || "";
      snippets = [{ type: "text", snippet: fp || "(match in session content)" }];
    }

    results.push(searchResultRow(s, meta, snippets));
  }

  return results;
}

/** Slice [start, end); collapse newlines only when the slice contains any. */
function formatSnippetSlice(text, start, end) {
  const nl = text.indexOf("\n", start);
  const slice = text.slice(start, end);
  const body = nl === -1 || nl >= end ? slice : slice.replace(RE_NEWLINE, " ");
  if (start > 0 && end < text.length) return `...${body}...`;
  if (start > 0) return `...${body}`;
  if (end < text.length) return `${body}...`;
  return body;
}

/**
 * Newline-collapse and cap structured field values (command/error snippets).
 * When the query match sits past the head cap, window around the match so the
 * matched text stays visible in the snippet (fact yq2).
 */
function structuredFieldSnippet(text, query) {
  if (query) {
    const idx = indexOfLower(text, query);
    if (idx > 80) {
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + query.length + 60);
      return safeSlice(formatSnippetSlice(text, start, end), 120);
    }
  }
  return safeSlice(formatSnippetSlice(text, 0, text.length), 120);
}

export function extractSnippets(text, query, max = 3, lowerText) {
  const lower = lowerText ?? text.toLowerCase();
  const snippets = [];
  let pos = 0;
  while (snippets.length < max) {
    const idx = lower.indexOf(query, pos);
    if (idx === -1) break;
    const start = Math.max(0, idx - 40);
    const end = Math.min(text.length, idx + query.length + 60);
    const snippet = formatSnippetSlice(text, start, end);
    snippets.push({ type: "text", snippet, matchStart: idx - start + (start > 0 ? 3 : 0), matchLen: query.length });
    pos = idx + query.length;
  }
  return snippets;
}

const MAX_SCAN_CACHE = 50;
const _scanCache = new Map();

function getScanCacheKey(session) {
  const size = session.size || 0;
  return `${session.path}:${size}:${sessionMtimeMs(session)}`;
}

function getCachedScanLines(session) {
  const key = getScanCacheKey(session);
  const lines = _scanCache.get(key);
  if (lines !== undefined) {
    _scanCache.delete(key);
    _scanCache.set(key, lines);
    return lines;
  }
  return null;
}

function setCachedScanLines(session, lines) {
  const key = getScanCacheKey(session);
  if (_scanCache.size >= MAX_SCAN_CACHE) {
    const oldest = _scanCache.keys().next().value;
    _scanCache.delete(oldest);
  }
  _scanCache.set(key, lines);
}

/** Walk JSONL lines from a string or cached line array without joining for cache hits. */
function forEachScanJsonlLine(source, onLine) {
  if (Array.isArray(source)) {
    for (const line of source) {
      if (onLine(line) === false) return;
    }
    return;
  }
  forEachJsonlLine(source, onLine);
}

/** cursor-cloud reuses the Cursor query-scan over message rows, but the imported
 * session_meta first line must never yield a snippet (fact ccsc). */
function isCursorCloudScanSkippableLine(line, start, end) {
  return isCursorCloudMetaLine(line, start, end) || isClaudeProgressFillerLine(line, start, end);
}

function scanSkipLineForSource(source) {
  if (source === "codex") return isCodexIndexSkippableLine;
  if (source === "factory") return isFactoryScanSkippableLine;
  if (source === "grok") return isGrokChatScanSkippableLine;
  if (source === "cursor-cloud") return isCursorCloudScanSkippableLine;
  return isClaudeProgressFillerLine;
}

function createJsonlQueryScanState() {
  return {
    snippets: [],
    seenCmds: new Set(),
    seenFiles: new Set(),
    firstTextLine: null,
    stoppedEarly: false,
  };
}

/** Shared per-line scan step for in-memory and file-backed JSONL query walks. */
function accumulateJsonlLineForQuery(line, query, max, filePathPattern, state) {
  collectStructuredSnippetsFromLine(
    line,
    query,
    state.snippets,
    max,
    state.seenCmds,
    state.seenFiles,
    filePathPattern,
  );

  if (
    state.snippets.length === 0 &&
    !state.firstTextLine &&
    (line.includes(query) || includesLower(line, query))
  ) {
    state.firstTextLine = line;
  }

  if (state.snippets.length >= max) {
    state.stoppedEarly = true;
    return false;
  }
  return true;
}

function finalizeJsonlQueryScan(state, query) {
  if (state.snippets.length === 0 && state.firstTextLine) {
    const snippet = textSnippetFromLine(state.firstTextLine, query);
    if (snippet) state.snippets.push({ type: "text", snippet });
  }
  return state.snippets;
}

/** LRU cache hit: scan JSONL line-by-line (no full-text toLowerCase). */
function scanInMemoryJsonlLines(lines, query, max, filePathPattern = RE_FILE_PATH, skipLine) {
  const state = createJsonlQueryScanState();

  forEachScanJsonlLine(lines, (line) => {
    if (skipLine?.(line)) return true;
    return accumulateJsonlLineForQuery(line, query, max, filePathPattern, state);
  });

  return finalizeJsonlQueryScan(state, query);
}

function createJsonlQueryScanStates(queries) {
  return new Map(queries.map((query) => [query, createJsonlQueryScanState()]));
}

function finalizeJsonlQueryScanStates(states) {
  const snippetsByQuery = new Map();
  for (const [query, state] of states) {
    snippetsByQuery.set(query, finalizeJsonlQueryScan(state, query));
  }
  return snippetsByQuery;
}

function accumulateJsonlLineForQueries(line, queries, max, filePathPattern, states) {
  for (const query of queries) {
    const state = states.get(query);
    if (!state || state.stoppedEarly) continue;
    accumulateJsonlLineForQuery(line, query, max, filePathPattern, state);
  }
  return !states.get(queries[0])?.stoppedEarly;
}

function scanInMemoryJsonlLinesForQueries(lines, queries, max, filePathPattern = RE_FILE_PATH, skipLine) {
  const states = createJsonlQueryScanStates(queries);

  forEachScanJsonlLine(lines, (line) => {
    if (skipLine?.(line)) return true;
    return accumulateJsonlLineForQueries(line, queries, max, filePathPattern, states);
  });

  return finalizeJsonlQueryScanStates(states);
}

function collectStructuredSnippetsFromLine(
  line,
  query,
  snippets,
  max,
  seenCmds,
  seenFiles,
  filePathPattern = RE_FILE_PATH
) {
  if (line.includes('"command"')) {
    for (const m of line.matchAll(RE_COMMAND)) {
      if (snippets.length >= max) return;
      const cmd = parseEscapedJsonString(m[1]);
      if (cmd && includesLower(cmd, query)) {
        const snippet = structuredFieldSnippet(cmd, query);
        if (!seenCmds.has(snippet)) {
          seenCmds.add(snippet);
          snippets.push({ type: "command", snippet });
        }
      }
    }
  }

  if (snippets.length < max && (line.includes('"file_path"') || line.includes('"path"'))) {
    for (const m of line.matchAll(filePathPattern)) {
      if (snippets.length >= max) return;
      const fp = m[1];
      if (includesLower(fp, query) && !seenFiles.has(fp)) {
        seenFiles.add(fp);
        snippets.push({ type: "file", snippet: fp });
      }
    }
  }

  if (
    snippets.length < max &&
    (line.includes('"error"') || line.includes('"Error"') || line.includes('"stderr"'))
  ) {
    for (const m of line.matchAll(RE_ERROR_FIELD)) {
      if (snippets.length >= max) return;
      const err = parseEscapedJsonString(m[1]);
      if (err && includesLower(err, query)) {
        const snippet = structuredFieldSnippet(err, query);
        snippets.push({ type: "error", snippet });
      }
    }
  }
}

/**
 * Unescape JSON string escape sequences in a raw slice extracted from a JSONL line.
 * Handles \\n, \\t, \\r, \\", \\\\, \\uXXXX. A trailing lone backslash (from a
 * slice boundary landing mid-escape) is stripped rather than left mangled.
 * Only allocates when the slice actually contains a backslash.
 */
function unescapeJsonSlice(s) {
  if (s.indexOf("\\") === -1) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "\\") {
      out += s[i++];
      continue;
    }
    // lone trailing backslash at slice boundary — strip it
    if (i + 1 >= s.length) break;
    const c = s[i + 1];
    if (c === "n") { out += "\n"; i += 2; }
    else if (c === "t") { out += "\t"; i += 2; }
    else if (c === "r") { out += "\r"; i += 2; }
    else if (c === '"') { out += '"'; i += 2; }
    else if (c === "\\") { out += "\\"; i += 2; }
    else if (c === "/") { out += "/"; i += 2; }
    else if (c === "b") { out += "\b"; i += 2; }
    else if (c === "f") { out += "\f"; i += 2; }
    else if (c === "u" && i + 5 < s.length) {
      const hex = s.slice(i + 2, i + 6);
      const cp = parseInt(hex, 16);
      if (!isNaN(cp)) { out += String.fromCharCode(cp); i += 6; }
      else { out += "\\"; i++; }
    } else {
      // unknown escape: pass the character through
      out += c; i += 2;
    }
  }
  return out;
}

function textSnippetFromLine(line, query) {
  const idx = indexOfLower(line, query);
  if (idx === -1) return null;
  const start = Math.max(0, idx - 40);
  const end = Math.min(line.length, idx + query.length + 60);
  const raw = formatSnippetSlice(line, start, end);
  return unescapeJsonSlice(raw);
}

/**
 * Stream-scan a JSONL file for query matches (structured fields first, then one text fallback).
 * When the full file is read without early exit, returns cachedLines for LRU caching.
 */
export function scanJsonlFileForQuery(
  filePath,
  query,
  max = 3,
  filePathPattern = RE_FILE_PATH,
  skipLine,
) {
  const state = createJsonlQueryScanState();
  const cachedLines = [];

  forEachJsonlLineFromFile(filePath, (text, start, end) => {
    if (skipLine?.(text, start, end)) return true;
    const line = text.slice(start, end);
    if (!accumulateJsonlLineForQuery(line, query, max, filePathPattern, state)) return false;
    cachedLines.push(line);
    return true;
  });

  return {
    snippets: finalizeJsonlQueryScan(state, query),
    cachedLines: state.stoppedEarly ? null : cachedLines,
  };
}

function scanJsonlFileForQueries(
  filePath,
  queries,
  max = 3,
  filePathPattern = RE_FILE_PATH,
  skipLine,
) {
  const states = createJsonlQueryScanStates(queries);
  const cachedLines = [];
  let stoppedEarly = false;

  forEachJsonlLineFromFile(filePath, (text, start, end) => {
    if (skipLine?.(text, start, end)) return true;
    const line = text.slice(start, end);
    if (!accumulateJsonlLineForQueries(line, queries, max, filePathPattern, states)) {
      stoppedEarly = true;
      return false;
    }
    cachedLines.push(line);
    return true;
  });

  return {
    snippetsByQuery: finalizeJsonlQueryScanStates(states),
    cachedLines: stoppedEarly ? null : cachedLines,
  };
}

export function scanSessionForQuery(session, query, max = 3) {
  const source = session.source || "claude";
  try {
    if (source === "opencode") return scanOpenCodeForQuery(session, query, max);
    if (source === "grok") return scanGrokForQuery(session.path, query, max);

    const skipLine = scanSkipLineForSource(source);
    const cached = getCachedScanLines(session);
    if (cached !== null) {
      return scanInMemoryJsonlLines(cached, query, max, RE_FILE_PATH, skipLine);
    }

    const { snippets, cachedLines } = scanJsonlFileForQuery(session.path, query, max, RE_FILE_PATH, skipLine);
    if (cachedLines !== null) setCachedScanLines(session, cachedLines);
    return snippets;
  } catch (err) {
    const loc = session.path || session.file || session.sessionId || "unknown";
    finishScanQueryCatch("scanSessionForQuery", loc, err);
    return [];
  }
}

function scanSessionForQueries(session, queries, max = 3) {
  const source = session.source || "claude";
  if (queries.length === 0) return new Map();
  try {
    if (source === "grok") return scanGrokForQueries(session.path, queries, max);
    if (source === "opencode") {
      return new Map(queries.map((query) => [query, scanSessionForQuery(session, query, max)]));
    }

    const skipLine = scanSkipLineForSource(source);
    const cached = getCachedScanLines(session);
    if (cached !== null) {
      return scanInMemoryJsonlLinesForQueries(cached, queries, max, RE_FILE_PATH, skipLine);
    }

    const { snippetsByQuery, cachedLines } =
      scanJsonlFileForQueries(session.path, queries, max, RE_FILE_PATH, skipLine);
    if (cachedLines !== null) setCachedScanLines(session, cachedLines);
    return snippetsByQuery;
  } catch (err) {
    const loc = session.path || session.file || session.sessionId || "unknown";
    finishScanQueryCatch("scanSessionForQueries", loc, err);
    return new Map(queries.map((query) => [query, []]));
  }
}

function emptySnippetMap(queries) {
  return new Map(queries.map((query) => [query, []]));
}

export function scanGrokForQuery(sessionDir, query, max) {
  try {
    const chatPath = join(sessionDir, "chat_history.jsonl");
    if (!existsSync(chatPath)) return [];
    return scanJsonlFileForQuery(
      chatPath,
      query,
      max,
      RE_GROK_FILE_PATH,
      isGrokChatScanSkippableLine,
    ).snippets;
  } catch (err) {
    finishScanQueryCatch("scanGrokForQuery", sessionDir, err);
    return [];
  }
}

function scanGrokForQueries(sessionDir, queries, max) {
  try {
    const chatPath = join(sessionDir, "chat_history.jsonl");
    if (!existsSync(chatPath)) return emptySnippetMap(queries);
    return scanJsonlFileForQueries(
      chatPath,
      queries,
      max,
      RE_GROK_FILE_PATH,
      isGrokChatScanSkippableLine,
    ).snippetsByQuery;
  } catch (err) {
    finishScanQueryCatch("scanGrokForQueries", sessionDir, err);
    return emptySnippetMap(queries);
  }
}

/** SQL body for part.text || part.content (case-insensitive); mirrors JS scan loop. */
const OPENCODE_PART_TEXT_BODY_SQL = `
  CASE WHEN nullif(json_extract(p.data, '$.text'), '') IS NOT NULL
       THEN json_extract(p.data, '$.text')
       ELSE coalesce(json_extract(p.data, '$.content'), '')
  END
`;

export function scanOpenCodeForQuery(session, query, max) {
  const sessionId = openCodeSessionFileId(session);
  try {
    if (!sessionId) {
      warnScanQueryFailed("scanOpenCodeForQuery", session.path || "unknown",
        new Error("session has no file id — cannot bind SQLite parameter"));
      return [];
    }
    return withOpenCodeDb((db) => {
      const snippets = [];

      const parts = db.prepare(`
      SELECT p.data FROM part p JOIN message m ON p.message_id = m.id
      WHERE m.session_id = ?
        AND json_extract(p.data, '$.type') IN (${OPENCODE_TERM_INDEX_PART_TYPES_SQL})
        AND instr(lower(${OPENCODE_PART_TEXT_BODY_SQL}), ?) > 0
      LIMIT 100
    `).all(sessionId, query);

      for (const row of parts) {
        if (snippets.length >= max) break;
        const part = JSON.parse(row.data);
        const original = part.text || part.content || "";
        const snippet = textSnippetFromLine(original, query);
        if (snippet) snippets.push({ type: "text", snippet });
      }

      return snippets;
    });
  } catch (err) {
    const loc = sessionId || session.path || "unknown";
    finishScanQueryCatch("scanOpenCodeForQuery", loc, err);
    return [];
  }
}
