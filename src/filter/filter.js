import { includesLower } from "../parse/parse-utils.js";
import { computeGrade, sortSessionList } from "./filter-formats.js";
import { tokenize } from "../sessions/search-tokenizer.js";
import { getSearchIndex } from "../sessions/search-index.js";
import {
  intersectSets,
  pathsFromPostingMatches,
  resolveQueryToken,
  scanSessionForQuery,
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

function matchTerm(session, term, now, ctx) {
  const v = term.valueLower ?? term.value.toLowerCase();
  let result;
  switch (term.key) {
    case 'project': result = getCachedProjectLower(session).includes(v); break;
    case 'source': result = getCachedSourceLower(session) === v; break;
    case 'host': result = getCachedHostLower(session) === v; break;
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
            const phraseRaw = term.value.toLowerCase();
            const snippets = scanSessionForQuery(session, phraseRaw, 1);
            result = snippets.length > 0;
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
      tokenSets.push(pathsFromPostingMatches(matches, postings));
    }
    textMatchSets.set(termValue, intersectSets(tokenSets));
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
  let result = apiObjects;
  const exprTrimmed = expr && String(expr).trim();
  if (exprTrimmed) {
    const ast = parseFilterExpr(exprTrimmed);
    if (ast) {
      const now = Date.now();
      const bm25Ctx = buildBm25FilterContext(ast);
      const filtered = [];
      for (let i = 0; i < apiObjects.length; i++) {
        if (evalFilterExpr(apiObjects[i], ast, now, bm25Ctx)) filtered.push(apiObjects[i]);
      }
      result = filtered;
    }
  }
  sortSessionList(result, sort || "recent");
  return result;
}