/**
 * Bridge to the sidecar `near` scan (search-perf facts): the raw-file part of
 * the CLI's near-words re-rank, run in parallel in Rust. Node keeps the score
 * expression; the sidecar returns each file's best run weight, counted runs
 * and whether it ran a search for the query, computed byte-for-byte like
 * nearTermScorer's JS scan. Weights travel as f64 bit patterns so no decimal
 * round trip can change them.
 */
import { runSidecar } from "./index-writers.js";

const _f64 = new Float64Array(1);
const _u64 = new BigUint64Array(_f64.buffer);

function f64Bits(x) {
  _f64[0] = x;
  return _u64[0].toString(16);
}

/**
 * Scan `files` ([path, isCodex] pairs) with the scorer's needles. Returns one
 * `[best, runs, searched]` or null (unreadable file) per file, in order, or
 * null when the sidecar is unavailable or failed (callers scan in JS then).
 */
export function sidecarNearScan({ needles, weights, verbatim, verbatimWords, gap, maxBytes }, files) {
  if (!files.length) return null;
  const input = JSON.stringify({
    needles: needles.map(({ q, bytes, prefix }) => [q, prefix, bytes.toString("hex")]),
    weights: weights.map(f64Bits),
    // UTF-16 code units: the JS scan indexes and compares the verbatim query by them.
    verbatim: verbatim ? Array.from({ length: verbatim.length }, (_, i) => verbatim.charCodeAt(i)) : null,
    verbatimWords,
    gap,
    maxBytes,
    files,
  });
  return runSidecar("near", ["near"], (result) => {
    const out = JSON.parse(result.stdout);
    if (!Array.isArray(out) || out.length !== files.length) throw new Error("near: result count mismatch");
    return out;
  }, { input });
}
