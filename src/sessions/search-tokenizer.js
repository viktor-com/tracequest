/**
 * Shared tokenizer for BM25 SearchIndex — used by both indexing and query parsing.
 *
 * Rules (facts lvq, nna):
 *   - Lowercase input
 *   - Split on non-alphanumeric characters, camelCase boundaries, snake_case
 *     underscores, and path separators
 *   - Discard tokens shorter than 2 or longer than 32 chars
 *
 * "indexWriters"      → ["index", "writers"]
 * "src/index_writers.js" → ["src", "index", "writers", "js"]
 */

/**
 * Internal: split text into raw tokens (lowercased, not de-duped).
 * Allocation-light: single pass, char-by-char.
 *
 * @param {string} text
 * @param {(tok: string) => void} emit - called for each valid token
 */
function splitTokens(text, emit) {
  if (!text) return;
  const n = text.length;
  let start = -1;
  let prevIsUpper = false;

  function flush(end) {
    if (start < 0) return;
    const tok = text.slice(start, end).toLowerCase();
    start = -1;
    prevIsUpper = false;
    if (tok.length >= 2 && tok.length <= 32) emit(tok);
  }

  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    const isAlpha =
      (c >= 97 && c <= 122) || // a-z
      (c >= 65 && c <= 90) ||  // A-Z
      (c >= 48 && c <= 57);    // 0-9
    const isUpper = c >= 65 && c <= 90;
    const isLower = (c >= 97 && c <= 122) || (c >= 48 && c <= 57);

    if (!isAlpha) {
      flush(i);
    } else if (isUpper && start >= 0 && !prevIsUpper) {
      // camelCase boundary: lower→upper transition
      flush(i);
      start = i;
      prevIsUpper = true;
    } else if (isLower && start >= 0 && prevIsUpper) {
      // camelCase: "XMLParser" — boundary one char back
      const tokenSoFar = text.slice(start, i - 1).toLowerCase();
      if (i - 1 > start && tokenSoFar.length >= 2 && tokenSoFar.length <= 32) emit(tokenSoFar);
      start = i - 1;
      prevIsUpper = false;
    } else {
      if (start < 0) start = i;
      prevIsUpper = isUpper;
    }
  }
  flush(n);
}

/**
 * Tokenize a text string into a de-duplicated array of unique terms.
 * Used by query parsing (fact 85b — same tokenizer, no duplicates for query terms).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  const terms = [];
  const seen = new Set();
  splitTokens(text, (tok) => {
    if (!seen.has(tok)) {
      seen.add(tok);
      terms.push(tok);
    }
  });
  return terms;
}

/**
 * Build a term-frequency map from text, accumulating into an existing map.
 * Counts raw occurrence frequency (not de-duplicated) for BM25 TF.
 * Tokenizer input capped at TOKENIZER_INPUT_CAP chars (fact 7et).
 *
 * @param {string} text
 * @param {Map<string,number>} termFreqs - accumulator (mutated in place)
 * @param {number[]} budgetBox - single-element array tracking remaining chars; mutated
 */
export function accumulateTermFreqs(text, termFreqs, budgetBox) {
  if (!text || budgetBox[0] <= 0) return;
  const slice = budgetBox[0] < text.length ? text.slice(0, budgetBox[0]) : text;
  budgetBox[0] -= slice.length;
  splitTokens(slice, (tok) => {
    termFreqs.set(tok, (termFreqs.get(tok) || 0) + 1);
  });
}

export const TOKENIZER_INPUT_CAP = 500_000;
