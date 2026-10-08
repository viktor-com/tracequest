/** Resolve optional [start, end) bounds against a parent line. */
export function lineRangeBounds(line, start, end) {
  return { s: start ?? 0, e: end ?? line.length };
}

/** True when normalized [s, e) slice opens a JSON object. */
export function lineRangeIsJsonObject(line, s, e) {
  return Boolean(line && e > s && line[s] === "{");
}

/** UTF-16 code unit length of a line range within a parent string. */
export function lineRangeLen(start, end) {
  return end - start;
}

/** Bounded substring search: needle must lie entirely within [start, end). */
export function lineRangeIncludes(text, start, end, needle) {
  const hayLen = end - start;
  if (hayLen < needle.length) return false;
  return text.slice(start, end).includes(needle);
}

/** True when [start, end) begins with prefix. */
export function lineRangeStartsWith(text, start, end, prefix) {
  const plen = prefix.length;
  if (end - start < plen) return false;
  for (let i = 0; i < plen; i++) {
    if (text[start + i] !== prefix[i]) return false;
  }
  return true;
}

/** True when line slice is a stream_chunk filler row (compact or spaced JSON type). */
export function lineRangeIsStreamChunkType(line, s, e) {
  return (
    lineRangeStartsWith(line, s, e, '{"type":"stream_chunk"') ||
    lineRangeStartsWith(line, s, e, '{"type": "stream_chunk"')
  );
}

/** True when line slice is a Grok chat system filler row (compact or spaced JSON type). */
export function lineRangeIsGrokChatSystemType(line, s, e) {
  return (
    lineRangeStartsWith(line, s, e, '{"type":"system"') ||
    lineRangeStartsWith(line, s, e, '{"type": "system"')
  );
}