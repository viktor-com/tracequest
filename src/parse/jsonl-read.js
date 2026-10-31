import { openSync, readSync, closeSync, fstatSync } from "node:fs";

/** Parse one JSONL line; null for empty or malformed input. */
export function parseJsonlLine(rawLine) {
  if (!rawLine) return null;
  try {
    return JSON.parse(rawLine);
  } catch (err) {
    console.error("parseJsonlLine: malformed JSONL line:", err.message);
    return null;
  }
}

/** Parse one JSONL line from a parent string slice [start, end). */
export function parseJsonlLineAt(text, start, end) {
  if (!text || end <= start) return null;
  return parseJsonlLine(text.slice(start, end));
}

/** Wrap 1-arg line callbacks; 3-arg (text, start, end) callbacks skip per-line slice in walkJsonlLines. */
function wrapJsonlLineCallback(onLine) {
  if (onLine.length >= 3) return onLine;
  return (text, start, end) => onLine(text.slice(start, end));
}

/** Walk with a pre-wrapped deliver(text, start, end) callback. */
function walkJsonlLinesDelivered(text, end, deliver, start = 0) {
  let pos = start;
  while (pos < end) {
    const nl = text.indexOf("\n", pos);
    const lineEnd = nl === -1 ? end : nl;
    if (lineEnd > pos && deliver(text, pos, lineEnd) === false) return pos;
    pos = nl === -1 ? end : nl + 1;
  }
  return pos;
}

/**
 * Walk complete lines in a UTF-8 string slice [0, end). Return false from onLine to stop.
 * onLine(text, start, end) receives buffer offsets; 1-arg callbacks still receive sliced lines.
 * @returns {number} index of first byte after the last consumed newline, or end when done
 */
function walkJsonlLines(text, end, onLine, start = 0) {
  return walkJsonlLinesDelivered(text, end, wrapJsonlLineCallback(onLine), start);
}

/** Iterate non-empty lines in a JSONL string without allocating a full split array. Return false from onLine to stop. */
export function forEachJsonlLine(raw, onLine) {
  walkJsonlLines(raw, raw.length, onLine);
}

/** Non-empty JSONL lines from in-memory text (trimmed). */
export function splitJsonlLines(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  const lines = [];
  forEachJsonlLine(text, (line) => lines.push(line));
  return lines;
}

/** Visit each successfully parsed object in a JSONL string. */
export function forEachParsedJsonlLine(raw, onObj) {
  forEachJsonlLine(typeof raw === "string" ? raw.trim() : "", (rawLine) => {
    const obj = parseJsonlLine(rawLine);
    if (obj) onObj(obj);
  });
}

/** Collect all parsed JSONL objects from in-memory text. */
export function collectParsedJsonlLines(raw) {
  const out = [];
  forEachParsedJsonlLine(raw, (obj) => out.push(obj));
  return out;
}

/**
 * Stream complete JSONL lines from a file prefix (up to maxBytes, truncated on last newline).
 * Avoids allocating a lines array; return false from onLine to stop early.
 */
export function forEachPartialJsonlLine(filePath, fileSize, onLine, maxBytes = 524288) {
  const readBytes = Math.min(fileSize ?? maxBytes, maxBytes);
  if (readBytes <= 0) return;
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(readBytes);
  const bytesRead = readSync(fd, buf, 0, readBytes, 0);
  closeSync(fd);
  if (bytesRead <= 0) return;
  const text = buf.toString("utf-8", 0, bytesRead);
  const lastNl = text.lastIndexOf("\n");
  const end = lastNl > 0 ? lastNl : text.length;
  walkJsonlLines(text, end, onLine);
}

/** Read file prefix up to maxBytes, truncate on last newline, return complete JSONL lines. */
export function readPartialJsonlLines(filePath, fileSize, maxBytes = 524288) {
  const lines = [];
  forEachPartialJsonlLine(filePath, fileSize, (line) => {
    lines.push(line);
  }, maxBytes);
  return lines;
}

/** Visit each parsed object from a partial prefix read of a JSONL file. */
export function forEachPartialParsedJsonlLine(filePath, fileSize, onObj, maxBytes = 524288) {
  forEachPartialJsonlLine(filePath, fileSize, (rawLine) => {
    const obj = parseJsonlLine(rawLine);
    if (obj) onObj(obj);
  }, maxBytes);
}

/**
 * Stream JSONL lines from a file without loading the whole file into memory.
 * Return false from onLine to stop reading early. With `opts.keep`, lines are
 * first screened from their leading bytes (see forEachKeptJsonlLineFromFile).
 */
/** True without `state`, else whether the open file `fd` has `state`'s size and mtime (ns). */
function fileStillIs(fd, state) {
  if (!state) return true;
  try {
    const st = fstatSync(fd, { bigint: true });
    return st.size === BigInt(state.size) && st.mtimeNs === BigInt(state.mtimeNs);
  } catch {
    return false;
  }
}

export function forEachJsonlLineFromFile(filePath, onLine, opts) {
  if (opts?.keep) {
    forEachKeptJsonlLineFromFile(filePath, opts.keep, onLine, opts);
    return;
  }
  const deliver = wrapJsonlLineCallback(onLine);
  const fd = openSync(filePath, "r");
  // opts.start: read from this byte offset, the start of a line, instead of the file's start;
  // with opts.startIf ({ size, mtimeNs }), only when the opened file still has that size and mtime.
  let position = opts?.start > 0 && fileStillIs(fd, opts.startIf) ? opts.start : null;
  try {
    let pendingBuf = null;
    let pendingStart = 0;
    let pendingLen = 0;
    const readBuf = Buffer.alloc(65536);
    let mergeBuf = Buffer.alloc(69632);

    while (true) {
      const n = readSync(fd, readBuf, 0, readBuf.length, position);
      if (position !== null && n > 0) position += n;
      if (n <= 0) {
        if (pendingBuf && pendingStart < pendingLen) {
          const tail = pendingBuf.toString("utf-8", pendingStart, pendingLen);
          if (deliver(tail, 0, tail.length) === false) return;
        }
        return;
      }

      const tailBytes = pendingBuf ? pendingLen - pendingStart : 0;

      if (tailBytes === 0) {
        const lastNl = readBuf.lastIndexOf(0x0a, n > 0 ? n - 1 : 0);
        if (lastNl === -1) {
          if (!pendingBuf || pendingBuf.length < n) pendingBuf = Buffer.alloc(Math.max(n, 65536));
          readBuf.copy(pendingBuf, 0, 0, n);
          pendingStart = 0;
          pendingLen = n;
          continue;
        }

        const text = readBuf.toString("utf-8", 0, lastNl);
        const pos = walkJsonlLinesDelivered(text, text.length, deliver);
        if (pos < text.length) return;

        const remainLen = n - (lastNl + 1);
        if (remainLen === 0) {
          pendingBuf = null;
          pendingStart = 0;
          pendingLen = 0;
        } else {
          if (!pendingBuf || pendingBuf.length < remainLen) pendingBuf = Buffer.alloc(remainLen);
          readBuf.copy(pendingBuf, 0, lastNl + 1, n);
          pendingStart = 0;
          pendingLen = remainLen;
        }
        continue;
      }

      // Pending partial line has no newline; only readBuf can complete it.
      const lastNlInChunk = readBuf.lastIndexOf(0x0a, n > 0 ? n - 1 : 0);
      if (lastNlInChunk === -1) {
        const newLen = tailBytes + n;
        if (!pendingBuf || pendingBuf.length < newLen) {
          const next = Buffer.alloc(Math.max(newLen, (pendingBuf?.length ?? 0) * 2 || 65536));
          pendingBuf.copy(next, 0, pendingStart, pendingLen);
          pendingBuf = next;
          pendingStart = 0;
          pendingLen = tailBytes;
        } else if (pendingStart > 0) {
          pendingBuf.copy(pendingBuf, 0, pendingStart, pendingLen);
          pendingStart = 0;
          pendingLen = tailBytes;
        }
        readBuf.copy(pendingBuf, pendingLen, 0, n);
        pendingLen = newLen;
        continue;
      }

      const total = tailBytes + n;
      if (total > mergeBuf.length) mergeBuf = Buffer.alloc(total);
      pendingBuf.copy(mergeBuf, 0, pendingStart, pendingLen);
      readBuf.copy(mergeBuf, tailBytes, 0, n);
      const lastNl = tailBytes + lastNlInChunk;
      const text = mergeBuf.toString("utf-8", 0, lastNl);
      const pos = walkJsonlLinesDelivered(text, text.length, deliver);
      if (pos < text.length) return;

      const remainStart = lastNl + 1;
      const remainLen = total - remainStart;
      if (remainLen === 0) {
        pendingBuf = null;
        pendingStart = 0;
        pendingLen = 0;
      } else {
        if (!pendingBuf || pendingBuf.length < remainLen) pendingBuf = Buffer.alloc(remainLen);
        mergeBuf.copy(pendingBuf, 0, remainStart, total);
        pendingStart = 0;
        pendingLen = remainLen;
      }
    }
  } finally {
    closeSync(fd);
  }
}
/** First "\n" in buf[from, len), or -1 (bytes past `len` are stale and never count). */
function newlineIn(buf, from, len) {
  if (from >= len) return -1;
  const nl = buf.indexOf(0x0a, from);
  return nl === -1 || nl >= len ? -1 : nl;
}

/**
 * Stream JSONL lines from a file, letting `keep(buf, start, end)` reject a line
 * from its leading bytes before it is decoded. keep() sees the whole line when
 * it is shorter than `prefixBytes`, otherwise at least its first `prefixBytes`
 * bytes, and must answer the same for any prefix of that length or longer. A
 * rejected line is skipped up to its newline without being buffered, decoded
 * or parsed, so a file dominated by lines the caller never reads costs one
 * byte scan instead of a UTF-8 decode plus JSON.parse per line.
 * onLine(text) gets each kept non-empty line; return false to stop.
 */
function forEachKeptJsonlLineFromFile(filePath, keep, onLine, { prefixBytes = 512, chunkBytes = 1 << 20 } = {}) {
  const fd = openSync(filePath, "r");
  try {
    let buf = Buffer.allocUnsafe(chunkBytes);
    let len = 0;
    let pos = 0;
    let scanFrom = 0;
    let skipping = false;
    let decided = false;
    let eof = false;
    for (;;) {
      while (pos < len) {
        if (skipping) {
          const nl = newlineIn(buf, pos, len);
          if (nl === -1) { pos = len; break; }
          pos = nl + 1;
          skipping = false;
          continue;
        }
        const nl = newlineIn(buf, Math.max(pos, scanFrom), len);
        if (nl === -1) {
          scanFrom = len;
          if (!decided && len - pos >= prefixBytes) {
            if (!keep(buf, pos, len)) {
              skipping = true;
              pos = len;
              scanFrom = 0;
            } else {
              decided = true;
            }
          }
          break;
        }
        if (nl > pos && (decided || keep(buf, pos, nl))) {
          if (onLine(buf.toString("utf8", pos, nl)) === false) return;
        }
        pos = nl + 1;
        scanFrom = 0;
        decided = false;
      }
      if (eof) {
        if (!skipping && pos < len && (decided || keep(buf, pos, len))) onLine(buf.toString("utf8", pos, len));
        return;
      }
      if (pos > 0) {
        if (pos < len) buf.copy(buf, 0, pos, len);
        len -= pos;
        if (scanFrom) scanFrom -= pos;
        pos = 0;
      }
      if (len === buf.length) {
        const grown = Buffer.allocUnsafe(buf.length * 2);
        buf.copy(grown, 0, 0, len);
        buf = grown;
      }
      const n = readSync(fd, buf, len, buf.length - len, null);
      if (n <= 0) eof = true;
      else len += n;
    }
  } finally {
    closeSync(fd);
  }
}
