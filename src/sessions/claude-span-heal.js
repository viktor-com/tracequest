/**
 * One-time correction of cached Claude Code durations (fact durcl2).
 *
 * The index used to end a Claude session's span at its last timestamped line;
 * it now ends at the last user/assistant line (fact durcl). The first line is
 * unchanged, so a cached row's durationMs only needs the time between those
 * two endings taken off — and both lie at the end of the file. Reading the
 * tail of each file corrects every row without re-indexing (and re-tokenizing)
 * the corpus.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isClaudeIndexSkippableLine, isClaudeMessageLine } from "../parse/claude-jsonl-index.js";

/**
 * Bytes read from the end of each file: a short read settles almost every
 * file; a longer one is tried before the row is re-indexed instead.
 */
const TAIL_READS = [16 * 1024, 256 * 1024];

const TS_RE = /"timestamp":\s*"([^"]+)"/;

/** Trim from the last `bytes` of an open file, or null when they cannot tell. */
function trimFromTail(fd, size, bytes) {
  const start = Math.max(0, size - bytes);
  const buf = Buffer.allocUnsafe(size - start);
  let got = 0;
  while (got < buf.length) {
    const n = readSync(fd, buf, got, buf.length - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  const lines = buf.toString("utf8", 0, got).split("\n");
  // A read that starts mid-file starts mid-line: that fragment is not a line.
  const first = start > 0 ? 1 : 0;
  let lastTs = null;
  for (let i = lines.length - 1; i >= first; i--) {
    const line = lines[i];
    // The same lines and timestamps the indexer counts (indexClaudeJsonl).
    if (!line || isClaudeIndexSkippableLine(line, 0, line.length) || !line.includes('"timestamp"')) continue;
    const m = line.match(TS_RE);
    if (!m) continue;
    if (lastTs === null) lastTs = m[1];
    if (isClaudeMessageLine(line)) {
      const trim = new Date(lastTs).getTime() - new Date(m[1]).getTime();
      return Number.isFinite(trim) && trim > 0 ? trim : 0;
    }
  }
  // The whole file has no message line: its span never changed.
  return start === 0 ? 0 : null;
}

/**
 * Milliseconds the old span ran past the last user/assistant line, 0 when it
 * did not (or the file cannot be opened), or null when the tail reads cannot
 * tell (the last message lies before the bytes read, or a read fails).
 */
export function claudeSpanTrimMs(path) {
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    // Nothing to read: the row is pruned or re-indexed when the file changes.
    return 0;
  }
  try {
    const size = fstatSync(fd).size;
    for (const bytes of TAIL_READS) {
      const trim = trimFromTail(fd, size, bytes);
      if (trim !== null || bytes >= size) return trim;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Trim per path (synchronous driver). */
export function readClaudeSpanTrims(paths) {
  const trims = new Map();
  for (const p of paths) trims.set(p, claudeSpanTrimMs(p));
  return trims;
}

/** Event-loop time one slice of readClaudeSpanTrimsAsync may take before yielding. */
const SLICE_MS = 15;

/** readClaudeSpanTrims in slices of at most ~15 ms, yielding the event loop between them. */
export async function readClaudeSpanTrimsAsync(paths) {
  const trims = new Map();
  let sliceStart = Date.now();
  for (const p of paths) {
    trims.set(p, claudeSpanTrimMs(p));
    if (Date.now() - sliceStart >= SLICE_MS) {
      await new Promise((resolve) => setImmediate(resolve));
      sliceStart = Date.now();
    }
  }
  return trims;
}
