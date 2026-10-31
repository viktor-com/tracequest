import { includesLower } from "../parse/parse-utils.js";
import { computeGrade, normalizeSortKey, sortSessionList } from "./filter-formats.js";
import { tokenize } from "../sessions/search-tokenizer.js";
import { getSearchIndex } from "../sessions/search-index.js";
import { isSessionHash, sessionHashFor } from "../sessions/session-hash.js";
import {
  intersectSets,
  resolveQueryToken,
  sessionHasPhrase,
} from "../sessions/scan-queries.js";

const FILTER_KEYS = ['project', 'source', 'host', 'tool', 'model', 'grade', 'errors', 'size', 'age', 'live'];

/**
 * Thrown when a filter token is a mistyped structured filter rather than
 * intentional free text (e.g. `age<1d` instead of `age:<1d`, or `size:abc`).
 * Callers (CLI, HTTP routes) catch this to surface an actionable error instead
 * of silently degrading the token into a BM25 free-text term (fact filter-typo).
 */
export class FilterParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "FilterParseError";
    this.isFilterParseError = true;
  }
}

// A known filter key immediately followed by a comparison operator with NO colon
// separator can never be intended free text — it is a mistyped structured filter.
const OPERATOR_OUTSIDE_VALUE_RE = /^(project|source|host|tool|model|grade|errors|size|age|live)[<>=]/;

// Comparison keys require a valid comparison value; any other value is a typo,
// not a match-nothing (the previous silent behavior differed per key).
const COMPARISON_KEY_GRAMMAR = {
  errors: /^([<>]=?)(\d+)$/,
  size: /^([<>]=?)(\d+)$/,
  age: /^([<>]=?)(\d+)([hdw])$/,
};

function comparisonKeyHint(key) {
  return key === 'age'
    ? `${key}:<3d, ${key}:>=1w (units: h=hours, d=days, w=weeks)`
    : `${key}:>0, ${key}:<=10, ${key}:>=2`;
}

/** Per-session lowercased fields; Symbols omitted from API JSON. */
const SOURCE_LOWER = Symbol("sourceLower");
const HOST_LOWER = Symbol("hostLower");
const TOOLS_LOWER = Symbol("toolsLower");
const PROJECT_LOWER = Symbol("projectLower");
const MODEL_LOWER = Symbol("modelLower");

function getCachedSourceLower(session) {
  const src = session.source || "";
  const cached = session[SOURCE_LOWER];
  if (cached && cached.src === src) return cached.lower;
  const lower = src.toLowerCase();
  session[SOURCE_LOWER] = { src, lower };
  return lower;
}

function getCachedHostLower(session) {
  const host = session.host || "";
  const cached = session[HOST_LOWER];
  if (cached && cached.src === host) return cached.lower;
  const lower = host.toLowerCase();
  session[HOST_LOWER] = { src: host, lower };
  return lower;
}

function getCachedToolsLower(session) {
  const tools = session.tools || [];
  const cached = session[TOOLS_LOWER];
  if (cached && cached.src === tools) return cached.lower;
  const lower = new Array(tools.length);
  for (let i = 0; i < tools.length; i++) lower[i] = tools[i].toLowerCase();
  session[TOOLS_LOWER] = { src: tools, lower };
  return lower;
}

function getCachedProjectLower(session) {
  const project = session.project || "";
  const cached = session[PROJECT_LOWER];
  if (cached && cached.src === project) return cached.lower;
  const lower = project.toLowerCase();
  session[PROJECT_LOWER] = { src: project, lower };
  return lower;
}

function getCachedModelLower(session) {
  const model = session.model || "";
  const cached = session[MODEL_LOWER];
  if (cached && cached.src === model) return cached.lower;
  const lower = model.toLowerCase();
  session[MODEL_LOWER] = { src: model, lower };
  return lower;
}

function gradeLetterLower(session) {
  const g = computeGrade(session);
  if (g._letterLower === undefined) g._letterLower = g.letter.toLowerCase();
  return g._letterLower;
}

function parseFilterToken(raw) {
  let str = raw.trim();
  if (!str) return null;
  let negated = false;
  let quoted = false;
  if (str.charAt(0) === '-' && str.length > 1) { negated = true; str = str.slice(1); }
  if ((str.charAt(0) === '"' && str.charAt(str.length - 1) === '"') ||
      (str.charAt(0) === "'" && str.charAt(str.length - 1) === "'")) {
    quoted = true;
    str = str.slice(1, -1);
  }
  const colon = str.indexOf(':');
  if (colon > 0) {
    const key = str.slice(0, colon).toLowerCase();
    const value = str.slice(colon + 1).trim();
    if (value && FILTER_KEYS.indexOf(key) !== -1) {
      const grammar = COMPARISON_KEY_GRAMMAR[key];
      if (grammar && !grammar.test(value)) {
        throw new FilterParseError(
          `Invalid ${key} filter value "${value}". ` +
          `Comparison filters need an operator and number — e.g. ${comparisonKeyHint(key)}.`,
        );
      }
      return { type: 'term', key, value, valueLower: value.toLowerCase(), negated, quoted };
    }
  }
  // Loudly reject a mistyped structured filter: a known key immediately followed
  // by a comparison operator with no colon (e.g. "age<1d"). Quoted tokens are the
  // explicit free-text escape hatch and are exempt (fact filter-typo).
  if (!quoted) {
    const m = OPERATOR_OUTSIDE_VALUE_RE.exec(str);
    if (m) {
      const key = m[1];
      const suggestion = `${key}:${str.slice(key.length).replace(/^=/, '')}`;
      throw new FilterParseError(
        `Invalid filter token "${str}": comparison operator outside the value. ` +
        `Filter comparisons use "key:operator value" — did you mean "${suggestion}"? ` +
        `To search this literally as free text, quote it: "${str}".`,
      );
    }
  }
  return { type: 'term', key: 'text', value: str, valueLower: str.toLowerCase(), negated, quoted };
}

function tokenizeExpr(input) {
  const tokens = [];
  let i = 0;
  while (i < input.length) {
    if (input[i] === ' ' || input[i] === '\t') { i++; continue; }
    if (input[i] === '(') { tokens.push({ type: 'LPAREN' }); i++; continue; }
    if (input[i] === ')') { tokens.push({ type: 'RPAREN' }); i++; continue; }
    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i];
      i++;
      let word = '';
      while (i < input.length && input[i] !== quote) { word += input[i]; i++; }
      if (i < input.length) i++;
      tokens.push({ type: 'TERM', value: quote + word + quote });
      continue;
    }
    const rest = input.slice(i);
    if (/^AND(?=\s|\(|$)/i.test(rest)) { tokens.push({ type: 'AND' }); i += 3; continue; }
    if (/^OR(?=\s|\(|$)/i.test(rest)) { tokens.push({ type: 'OR' }); i += 2; continue; }
    if (/^NOT(?=\s|\(|$)/i.test(rest)) { tokens.push({ type: 'NOT' }); i += 3; continue; }
    let word = '';
    while (i < input.length && input[i] !== ' ' && input[i] !== '\t' && input[i] !== '(' && input[i] !== ')') {
      word += input[i]; i++;
    }
    if (word) tokens.push({ type: 'TERM', value: word });
  }
  return tokens;
}

export function parseFilterExpr(input) {
  const str = input.trim();
  if (!str) return null;
  const tokens = tokenizeExpr(str);
  if (!tokens.length) return null;
  let pos = 0;
  function peek() { return pos < tokens.length ? tokens[pos] : null; }
  function consume() { return tokens[pos++]; }
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().type === 'OR') { consume(); left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (peek() && peek().type !== 'OR' && peek().type !== 'RPAREN') {
      if (peek().type === 'AND') consume();
      left = { type: 'and', left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().type === 'NOT') { consume(); return { type: 'not', child: parseUnary() }; }
    return parsePrimary();
  }
  function parsePrimary() {
    const t = peek();
    if (!t) return { type: 'term', key: 'text', value: '', negated: false };
    if (t.type === 'LPAREN') { consume(); const expr = parseOr(); if (peek() && peek().type === 'RPAREN') consume(); return expr; }
    if (t.type === 'TERM') { consume(); return parseFilterToken(t.value); }
    consume();
    return { type: 'term', key: 'text', value: '', negated: false };
  }
  return parseOr();
}

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * True when a lowercased free-text value names this session: its 8-char hash,
 * or its native UUID as found in the session file name (Claude, Codex rollout,
 * Cursor) or as the session's own directory (DeepSeek Harness). Files nested
 * deeper under a session (subagents) do not carry its id (fact jm0).
 */
function matchesSessionId(session, v) {
  if (isSessionHash(v)) return (session.sessionHash || sessionHashFor(session)) === v;
  if (!SESSION_UUID_RE.test(v)) return false;
  const segments = String(session.path || "").toLowerCase().split(/[\\/]/);
  return segments[segments.length - 1].includes(v) || segments[segments.length - 2] === v;
}

function matchTerm(session, term, now, ctx) {
  const v = term.valueLower ?? term.value.toLowerCase();
  let result;
  switch (term.key) {
    case 'project': result = getCachedProjectLower(session).includes(v); break;
    case 'source': result = getCachedSourceLower(session) === v; break;
    // The hub's own sessions carry no host id; host:local names them (fact hlhost).
    case 'host': { const h = getCachedHostLower(session); result = h === v || (v === 'local' && h === ''); break; }
    case 'tool': {
      const toolsLower = getCachedToolsLower(session);
      result = false;
      for (let i = 0; i < toolsLower.length; i++) {
        if (toolsLower[i] === v) { result = true; break; }
      }
      break;
    }
    case 'model': result = getCachedModelLower(session).includes(v); break;
    case 'grade': result = gradeLetterLower(session) === v; break;
    case 'errors': {
      const em = term.value.match(/^([><]=?)(\d+)$/);
      if (!em) { result = (session.errors || 0) > 0; break; }
      const errs = session.errors || 0, n = parseInt(em[2], 10);
      result = em[1] === '>' ? errs > n : em[1] === '<' ? errs < n : em[1] === '>=' ? errs >= n : em[1] === '<=' ? errs <= n : false;
      break;
    }
    case 'size': {
      const sm = term.value.match(/^([><]=?)(\d+)$/);
      if (!sm) return false;
      const kb = session.sizeKB, n = parseInt(sm[2], 10);
      result = sm[1] === '>' ? kb > n : sm[1] === '<' ? kb < n : sm[1] === '>=' ? kb >= n : sm[1] === '<=' ? kb <= n : false;
      break;
    }
    case 'age': {
      const am = term.value.match(/^([><]=?)(\d+)([hdw])$/);
      if (!am) return false;
      const unit = am[3] === 'h' ? 3600000 : am[3] === 'd' ? 86400000 : 604800000;
      const age = now - session.mtime, limit = parseInt(am[2], 10) * unit;
      result = am[1] === '<' ? age < limit : am[1] === '>' ? age > limit : am[1] === '<=' ? age <= limit : am[1] === '>=' ? age >= limit : false;
      break;
    }
    case 'live': result = !!session.live; break;
    case 'text': {
      if (matchesSessionId(session, v)) { result = true; break; }
      // BM25 path: if a precomputed match set is available for this term value,
      // use it (facts 0oy, cw8). Quoted phrases additionally verify exact substring
      // presence via on-demand scan (fact yd3).
      if (ctx && ctx.textMatchSets) {
        const matchSet = ctx.textMatchSets.get(term.value);
        if (matchSet !== undefined) {
          const inBm25 = matchSet.has(session.path);
          if (!inBm25) { result = false; break; }
          // Quoted phrase: verify exact substring via on-demand scan (fact yd3)
          if (term.quoted && ctx.quotedPhraseValues && ctx.quotedPhraseValues.has(term.value)) {
            result = ctx.phraseCheck ? ctx.phraseCheck(session, term.value) : sessionHasPhrase(session, term.value.toLowerCase());
          } else {
            result = true;
          }
          break;
        }
      }
      const prompt = session.prompt || '';
      if (prompt && includesLower(prompt, v)) {
        result = true;
        break;
      }
      if (getCachedProjectLower(session).includes(v)) {
        result = true;
        break;
      }
      const id = session.id || '';
      if (id && includesLower(id, v)) {
        result = true;
        break;
      }
      result = getCachedModelLower(session).includes(v);
      break;
    }
    default: result = false;
  }
  return term.negated ? !result : result;
}

export function evalFilterExpr(session, node, now, ctx) {
  switch (node.type) {
    case 'and': return evalFilterExpr(session, node.left, now, ctx) && evalFilterExpr(session, node.right, now, ctx);
    case 'or': return evalFilterExpr(session, node.left, now, ctx) || evalFilterExpr(session, node.right, now, ctx);
    case 'not': return !evalFilterExpr(session, node.child, now, ctx);
    case 'term': return matchTerm(session, node, now, ctx);
    default: return true;
  }
}

/**
 * Collect all free-text term values from a filter AST.
 * Returns an array of unique term.value strings with key === 'text'.
 * @param {object} node
 * @returns {string[]}
 */
export function collectTextTermValues(node) {
  if (!node) return [];
  const out = new Set();
  function walk(n) {
    if (!n) return;
    if (n.type === 'term' && n.key === 'text' && n.value) { out.add(n.value); return; }
    if (n.left) walk(n.left);
    if (n.right) walk(n.right);
    if (n.child) walk(n.child);
  }
  walk(node);
  return [...out];
}

/**
 * Build a BM25 match-set context for all free-text terms in a filter AST.
 * Returns an object { textMatchSets: Map<termValue, Set<path>> } for use as
 * the `ctx` parameter in evalFilterExpr calls.
 *
 * Unquoted terms apply the same token resolution as searchSessions:
 *   exact match → fuzzy expansion (OOV) → prefix expansion (final token).
 * Quoted phrases use exact token matches only, then verify exact substring
 * presence via on-demand scan lazily per session in matchTerm (fact yd3).
 * The returned ctx includes quotedPhraseValues so matchTerm knows which
 * terms need scan verification. (facts 0oy, yd3, 1h8, 3ns)
 *
 * @param {object} ast
 * @returns {{ textMatchSets: Map<string, Set<string>>, quotedPhraseValues: Set<string> }}
 */
export function buildBm25FilterContext(ast) {
  const steps = bm25FilterContextSteps(ast);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** buildBm25FilterContext as steps: it yields after each token resolved and each posting read (fact flt1). */
function* bm25FilterContextSteps(ast) {
  const si = getSearchIndex();
  const postings = si.postings;
  const textMatchSets = new Map();
  const quotedPhraseValues = new Set();

  if (!postings.size) return { textMatchSets, quotedPhraseValues };

  // Collect {value, quoted} pairs from all text-key AST nodes, deduped by value.
  const textTerms = new Map(); // value → quoted (first occurrence wins)
  function collectTermNodes(n) {
    if (!n) return;
    if (n.type === 'term' && n.key === 'text' && n.value) {
      if (!textTerms.has(n.value)) textTerms.set(n.value, !!n.quoted);
      return;
    }
    if (n.left) collectTermNodes(n.left);
    if (n.right) collectTermNodes(n.right);
    if (n.child) collectTermNodes(n.child);
  }
  collectTermNodes(ast);

  // Track which term values are quoted phrases (need scan verification)
  for (const [termValue, isQuoted] of textTerms) {
    if (isQuoted) quotedPhraseValues.add(termValue);
  }

  for (const [termValue, isQuoted] of textTerms) {
    const tokens = tokenize(termValue);
    if (!tokens.length) {
      textMatchSets.set(termValue, new Set());
      continue;
    }

    // AND: session must match all tokens (fact m6s)
    const tokenSets = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const matches = isQuoted
        ? [{ term: token, weight: 1.0 }]
        : resolveQueryToken(token, i === tokens.length - 1, si);
      yield;
      // pathsFromPostingMatches, one posting at a time.
      const paths = new Set();
      for (const { term } of matches) {
        const posting = postings.get(term);
        if (posting) for (const path of posting.keys()) paths.add(path);
        yield;
      }
      tokenSets.push(paths);
    }
    textMatchSets.set(termValue, intersectSets(tokenSets));
    yield;
  }

  return { textMatchSets, quotedPhraseValues };
}

/**
 * Filter API session objects by --filter / ?filter= and sort the result.
 * Shared by CLI list/latest/find and /api/sessions so both paths use
 * identical BM25 + phrase-scan semantics.
 *
 * @param {object[]} apiObjects
 * @param {string} [expr]
 * @param {string} [sort]
 * @returns {object[]}
 */
export function applyExprToApiObjects(apiObjects, expr, sort) {
  const exprTrimmed = expr && String(expr).trim();
  const ast = exprTrimmed ? parseFilterExpr(exprTrimmed) : null;
  const run = ast ? filterExprRun(apiObjects, ast, false, buildBm25FilterContext(ast)) : null;
  if (run) while (run.step(Infinity));
  return finishExprFilter(run, apiObjects, sort);
}

/**
 * applyExprToApiObjects for request handlers (fact flt1): the same answer,
 * evaluated in slices of at most ~`sliceMs` that yield the event loop, and
 * resolving to null, unfinished, once `signal` is aborted (the client went
 * away or typed on). With `verifyPhrase(phrase, sessions, signal)` (resolving
 * to the Set of paths of `sessions` holding the lowercase phrase, as
 * sessionHasPhrase decides, or null when aborted), no session file is read
 * here: a first pass leaves undecided only the sessions whose answer needs a
 * quoted phrase, and those are checked through verifyPhrase.
 */
export async function applyExprToApiObjectsAsync(apiObjects, expr, sort, { signal, sliceMs = 8, verifyPhrase = null } = {}) {
  const answer = await applyExprFirstResultsAsync(apiObjects, expr, sort, { signal, sliceMs, verifyPhrase });
  return answer && answer.objects;
}

/** Sorts whose order is a total preorder on finite numbers: the order of a subset is the subset of the order. */
const FIRST_RESULTS_SORTS = new Set(['recent', 'duration', 'tokens', 'errors', 'files', 'commits', 'chapters']);

/**
 * applyExprToApiObjectsAsync that, with `firstResults` > 0 (fact flt5), may
 * stop once the first `firstResults` sessions of the sorted answer are
 * known: the sessions waiting for a quoted phrase are checked in list order,
 * and `{ objects, partial: true }` holds exactly the first `firstResults`
 * sessions of the complete answer. Otherwise, or when every session got
 * decided anyway, `{ objects, partial: false }` is the complete answer.
 * Null once `signal` is aborted.
 */
export async function applyExprFirstResultsAsync(apiObjects, expr, sort, { signal, sliceMs = 8, verifyPhrase = null, firstResults = 0 } = {}) {
  if (signal?.aborted) return null;
  const exprTrimmed = expr && String(expr).trim();
  const ast = exprTrimmed ? parseFilterExpr(exprTrimmed) : null;
  let bm25Ctx = null;
  if (ast) {
    // The expression's word sets, built in slices, so a request typed over stops within one.
    const steps = bm25FilterContextSteps(ast);
    let deadline = Date.now() + sliceMs;
    let step = steps.next();
    while (!step.done) {
      if (Date.now() >= deadline) {
        await new Promise((resolve) => setImmediate(resolve));
        if (signal?.aborted) return null;
        deadline = Date.now() + sliceMs;
      }
      step = steps.next();
    }
    bm25Ctx = step.value;
  }
  const run = ast ? filterExprRun(apiObjects, ast, Boolean(verifyPhrase), bm25Ctx) : null;
  if (run) {
    while (run.step(Date.now() + sliceMs)) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) return null;
    }
    const sortKey = normalizeSortKey(sort || 'recent');
    const ordered = firstResults > 0 && run.pending.size && !exprIdValues(ast).length
      && FIRST_RESULTS_SORTS.has(sortKey.endsWith('-asc') ? sortKey.slice(0, -4) : sortKey);
    if (ordered) {
      const first = await firstResultsInOrder(run, apiObjects, sort, firstResults, verifyPhrase, signal);
      if (!first) return null;
      if (first.partial) return first;
    } else {
      for (const [value, sessions] of run.pending) {
        const found = await verifyPhrase(value.toLowerCase(), sessions, signal);
        if (!found || signal?.aborted) return null;
        run.verified.set(value, found);
      }
      run.resolvePending();
    }
  }
  return { objects: finishExprFilter(run, apiObjects, sort), partial: false };
}

/**
 * Decide the sessions of `run` in sorted list order until the first `want`
 * matches are known, checking the undecided ones' phrases a growing batch at
 * a time. `{ partial: true, objects }` with those matches, or
 * `{ partial: false }` once every session is decided.
 */
async function firstResultsInOrder(run, apiObjects, sort, want, verifyPhrase, signal) {
  const position = new Map(apiObjects.map((obj, k) => [obj, k]));
  // Stable sort: filtering the sorted list keeps the order finishExprFilter gives the filtered list.
  const order = sortSessionList(apiObjects.slice(), sort || 'recent').map((obj) => position.get(obj));
  if (run.pending.size === 1) return firstResultsStreamed(run, apiObjects, order, want, verifyPhrase, signal);
  const found = [];
  let batchSize = Math.max(32, 2 * want);
  let k = 0;
  while (k < order.length) {
    const state = run.decided[order[k]];
    if (state === TRUE) {
      found.push(apiObjects[order[k]]);
      if (found.length >= want) break;
    }
    if (state !== UNDECIDED) { k++; continue; }
    const batch = [];
    for (let j = k; j < order.length && batch.length < batchSize; j++) {
      if (run.decided[order[j]] === UNDECIDED) batch.push(order[j]);
    }
    const byValue = new Map();
    for (const idx of batch) {
      for (const value of run.askedBy.get(idx)) {
        if (!byValue.has(value)) byValue.set(value, []);
        byValue.get(value).push(apiObjects[idx]);
      }
    }
    for (const [value, sessions] of byValue) {
      const hits = await verifyPhrase(value.toLowerCase(), sessions, signal);
      if (!hits || signal?.aborted) return null;
      if (!run.verified.has(value)) run.verified.set(value, new Set());
      const known = run.verified.get(value);
      for (const path of hits) known.add(path);
    }
    run.resolve(batch);
    batchSize *= 2;
  }
  if (k >= order.length) {
    run.resolve(run.undecided.filter((idx) => run.decided[idx] === UNDECIDED));
    return { partial: false };
  }
  return { partial: true, objects: found };
}

/**
 * firstResultsInOrder for one quoted phrase: the undecided sessions are
 * checked in list order as one stream (verifyPhrase's onAnswer), and the
 * stream is stopped once the first `want` matches are decided.
 */
async function firstResultsStreamed(run, apiObjects, order, want, verifyPhrase, signal) {
  const [value] = run.pending.keys();
  const answered = new Set();
  const hits = new Set();
  run.verified.set(value, hits);
  const found = [];
  let k = 0;
  let done = false;
  const stop = new AbortController();
  // Decide the sessions in list order up to the first one still unanswered.
  const advance = () => {
    for (; k < order.length && !done; k++) {
      const idx = order[k];
      if (run.decided[idx] === UNDECIDED) {
        if (!answered.has(apiObjects[idx].path)) return;
        run.resolve([idx]);
      }
      if (run.decided[idx] === TRUE) {
        found.push(apiObjects[idx]);
        if (found.length >= want) {
          done = true;
          stop.abort();
        }
      }
    }
  };
  advance();
  if (done) return { partial: true, objects: found };
  const abort = () => stop.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) stop.abort();
  try {
    const sessions = order.filter((idx) => run.decided[idx] === UNDECIDED).map((idx) => apiObjects[idx]);
    await verifyPhrase(value.toLowerCase(), sessions, stop.signal, (session, hit) => {
      answered.add(session.path);
      if (hit) hits.add(session.path);
      advance();
    });
  } finally {
    signal?.removeEventListener('abort', abort);
  }
  if (signal?.aborted) return null;
  if (done) return { partial: true, objects: found };
  run.resolve(run.undecided.filter((idx) => run.decided[idx] === UNDECIDED));
  return { partial: false };
}

const NEEDS_PHRASE = Symbol("needs a quoted phrase check");
const FALSE = 0;
const TRUE = 1;
const UNDECIDED = 2;

/** evalFilterExpr with quoted phrases unknown: TRUE, FALSE, or UNDECIDED when the answer depends on one. */
function evalFilterExprDeferred(session, node, now, ctx) {
  switch (node.type) {
    case 'and': {
      const left = evalFilterExprDeferred(session, node.left, now, ctx);
      if (left === FALSE) return FALSE;
      const right = evalFilterExprDeferred(session, node.right, now, ctx);
      if (right === FALSE) return FALSE;
      return left === TRUE && right === TRUE ? TRUE : UNDECIDED;
    }
    case 'or': {
      const left = evalFilterExprDeferred(session, node.left, now, ctx);
      if (left === TRUE) return TRUE;
      const right = evalFilterExprDeferred(session, node.right, now, ctx);
      if (right === TRUE) return TRUE;
      return left === FALSE && right === FALSE ? FALSE : UNDECIDED;
    }
    case 'not': {
      const child = evalFilterExprDeferred(session, node.child, now, ctx);
      return child === UNDECIDED ? UNDECIDED : child === TRUE ? FALSE : TRUE;
    }
    case 'term':
      try {
        return matchTerm(session, node, now, ctx) ? TRUE : FALSE;
      } catch (err) {
        if (err === NEEDS_PHRASE) return UNDECIDED;
        throw err;
      }
    default: return TRUE;
  }
}

/**
 * Evaluation state of a parsed filter expression over apiObjects, with its
 * word sets `bm25Ctx` (buildBm25FilterContext). With `deferPhrases`, sessions whose answer needs a quoted
 * phrase are left in `pending` (phrase value -> sessions) for the caller to
 * check into `verified`, then resolvePending() decides them.
 */
function filterExprRun(apiObjects, ast, deferPhrases, bm25Ctx) {
  const now = Date.now();
  const decided = new Uint8Array(apiObjects.length);
  const pending = new Map();
  const verified = new Map();
  const undecided = [];
  const askedBy = new Map();
  let asked = null;
  const deferredCtx = deferPhrases
    ? { ...bm25Ctx, phraseCheck: (session, value) => { asked.add(value); throw NEEDS_PHRASE; } }
    : null;
  const verifiedCtx = { ...bm25Ctx, phraseCheck: (session, value) => verified.get(value).has(session.path) };
  let i = 0;
  return {
    ast,
    pending,
    verified,
    decided,
    undecided,
    askedBy,
    /** Decide undecided sessions `ks`, whose phrases are all in `verified`. */
    resolve(ks) {
      for (const k of ks) decided[k] = evalFilterExpr(apiObjects[k], ast, now, verifiedCtx) ? TRUE : FALSE;
    },
    /** Evaluate sessions until `deadline` (ms epoch); true while any remain. */
    step(deadline) {
      for (; i < apiObjects.length; i++) {
        if (deferredCtx) {
          asked = new Set();
          decided[i] = evalFilterExprDeferred(apiObjects[i], ast, now, deferredCtx);
          if (decided[i] === UNDECIDED) {
            undecided.push(i);
            askedBy.set(i, asked);
            for (const value of asked) {
              if (!pending.has(value)) pending.set(value, []);
              pending.get(value).push(apiObjects[i]);
            }
          }
        } else {
          decided[i] = evalFilterExpr(apiObjects[i], ast, now, bm25Ctx) ? TRUE : FALSE;
        }
        if (Date.now() >= deadline) {
          i++;
          return i < apiObjects.length;
        }
      }
      return false;
    },
    /** Decide the pending sessions from `verified`, as sessionHasPhrase would. */
    resolvePending() {
      this.resolve(undecided);
    },
    /** The matching sessions, in apiObjects order. */
    filtered() {
      const out = [];
      for (let k = 0; k < apiObjects.length; k++) if (decided[k] === TRUE) out.push(apiObjects[k]);
      return out;
    },
  };
}

/** The session ids (hashes or UUIDs) the expression names, lowercase. */
function exprIdValues(ast) {
  return collectTextTermValues(ast)
    .map((value) => value.toLowerCase())
    .filter((v) => isSessionHash(v) || SESSION_UUID_RE.test(v));
}

function finishExprFilter(run, apiObjects, sort) {
  let result = apiObjects;
  let idValues = [];
  if (run) {
    result = run.filtered();
    idValues = exprIdValues(run.ast);
  }
  sortSessionList(result, sort || "recent");
  // A session named by its id leads the list, ahead of sessions that merely
  // mention the id in their text (facts bxs, jm0).
  if (idValues.length) {
    const named = [];
    const rest = [];
    for (const obj of result) {
      (idValues.some((v) => matchesSessionId(obj, v)) ? named : rest).push(obj);
    }
    if (named.length) result = named.concat(rest);
  }
  return result;
}