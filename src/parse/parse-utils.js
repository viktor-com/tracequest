/**
 * Normalize Claude assistant usage into parse-layer token fields.
 * `input` rolls up base + cache read + cache write (matches chapter stats);
 * cacheHit/cacheWrite stay split for cost (input − cacheHit bills uncached + writes).
 */
export function rollupClaudeUsage(usage = {}) {
  const cacheHit = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const base = usage.input_tokens || 0;
  return {
    input: base + cacheHit + cacheWrite,
    output: usage.output_tokens || 0,
    cacheHit,
    cacheWrite,
  };
}

/** True when text is non-empty and not a hidden XML-tagged block. */
export function isDisplayableUserText(text) {
  return Boolean(text && !text.startsWith("<"));
}

/** Replace newlines with spaces; leaves other whitespace unchanged. */
export function foldNewlines(text) {
  return (text || "").replace(/\n/g, " ");
}

/** Flatten newlines and runs of whitespace for index/search text. */
export function collapseWhitespace(text) {
  return foldNewlines(text).replace(/\s+/g, " ").trim();
}

/** Visit Claude/Factory-style message content blocks (tool_use + text). */
export function visitToolUseTextBlocks(content, hooks = {}) {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (block?.type === "tool_use" && block.name) hooks.onToolUse?.(block.name);
    if (block?.type === "text" && block.text) {
      const t = collapseWhitespace(block.text);
      if (t) hooks.onText?.(t);
    }
  }
}

/** Session index/peek firstPrompt cap (search list + metadata). */
export const FIRST_PROMPT_MAX_LEN = 200;

/** Truncate cleaned user prompt text for session firstPrompt fields. */
export function truncateFirstPrompt(text) {
  return safeSlice(text, FIRST_PROMPT_MAX_LEN);
}

/** Truncate a string without splitting surrogate pairs (emoji, CJK ext-B, etc.) */
export function safeSlice(str, maxLen) {
  if (typeof str !== "string") str = String(str ?? "");
  if (str.length <= maxLen) return str;
  const sliced = str.slice(0, maxLen);
  // If we cut in the middle of a surrogate pair, drop the lone high surrogate
  const last = sliced.charCodeAt(maxLen - 1);
  if (last >= 0xD800 && last <= 0xDBFF) return sliced.slice(0, -1);
  return sliced;
}

// ---------------------------------------------------------------------------
// Event content truncation (fact content-truncation)
//
// Parsers cap message/tool content so previews and exports stay small. This was
// previously silent — a 500-char message and a truncated one looked identical,
// so `messages` could never round-trip a session. `capContent` fixes both ends:
//   - default mode: truncate AND append a visible marker so truncation is never
//     silent (render, markdown, and `messages` all show it);
//   - full mode (`messages --full`): return content untruncated so a session can
//     be replayed into an API verbatim.
// The toggle is process-global and only ever flipped for the duration of a single
// synchronous `parseSession` call, then restored.
// ---------------------------------------------------------------------------

let _truncateContent = true;

/** Enable/disable content truncation for subsequent parses (default enabled). */
export function setContentTruncation(enabled) {
  _truncateContent = enabled !== false;
}

/** Whether content truncation is currently enabled. */
export function isContentTruncationEnabled() {
  return _truncateContent;
}

/**
 * Cap event content to `maxLen`. When truncation is enabled and the string is
 * longer than `maxLen`, the result is the safe-sliced prefix plus a visible
 * marker reporting how many characters were dropped. When truncation is
 * disabled (full parse), the original string is returned unchanged.
 */
export function capContent(str, maxLen) {
  const s = typeof str === "string" ? str : String(str ?? "");
  if (!_truncateContent || s.length <= maxLen) return s;
  const cut = safeSlice(s, maxLen);
  return `${cut} … [truncated ${s.length - cut.length} chars]`;
}

/** Last two path segments for compact file keys in chapter builders. */
export function shortToolPath(input) {
  if (!input || typeof input !== "string") return "";
  const last = input.lastIndexOf("/");
  if (last < 0) return input;
  const prev = last > 0 ? input.lastIndexOf("/", last - 1) : -1;
  return prev < 0 ? input : input.slice(prev + 1);
}

/** Decode a JSON string literal captured without surrounding quotes (regex fragment). */
export function parseEscapedJsonString(escaped) {
  if (!escaped) return null;
  try {
    return JSON.parse('"' + escaped + '"');
  } catch (err) {
    console.error("parseEscapedJsonString: malformed escaped literal:", err.message);
    return null;
  }
}

/** Parse tool-call arguments from JSON string or object; malformed input → {}. */
export function parseToolArgs(raw, logContext) {
  if (raw == null || raw === "") return {};
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    if (logContext) console.error(`${logContext}: malformed tool arguments:`, err.message);
    return {};
  }
}

/** Above this length, V8 toLowerCase+indexOf beats a JS char scan. */
const LOWER_NATIVE_THRESHOLD = 4096;

function needsLocaleFold(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return true;
  }
  return false;
}

/** needle must already be lowercased (e.g. query.trim().toLowerCase()). */
export function indexOfLower(haystack, needleLower, fromIndex = 0) {
  if (!needleLower) {
    const hlen = haystack?.length ?? 0;
    return fromIndex >= 0 && fromIndex <= hlen ? fromIndex : -1;
  }
  if (!haystack) return -1;
  if (
    haystack.length > LOWER_NATIVE_THRESHOLD ||
    needsLocaleFold(haystack) ||
    needsLocaleFold(needleLower)
  ) {
    return haystack.toLowerCase().indexOf(needleLower, fromIndex);
  }
  const hlen = haystack.length;
  const nlen = needleLower.length;
  const start = fromIndex < 0 ? 0 : fromIndex;
  if (!nlen) return start < hlen ? start : hlen;
  if (start + nlen > hlen) return -1;
  outer: for (let i = start; i <= hlen - nlen; i++) {
    for (let j = 0; j < nlen; j++) {
      let hc = haystack.charCodeAt(i + j);
      if (hc >= 0x41 && hc <= 0x5a) hc += 0x20;
      if (hc !== needleLower.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

/** Case-insensitive includes without haystack.toLowerCase() alloc (needle lowercased). */
export function includesLower(haystack, needleLower) {
  return indexOfLower(haystack, needleLower) !== -1;
}

/** Composed source for browser-client bundle (indexOfLower + deps). */
export const INDEX_OF_LOWER_JS = [
  `var LOWER_NATIVE_THRESHOLD = ${LOWER_NATIVE_THRESHOLD};`,
  needsLocaleFold.toString(),
  indexOfLower.toString(),
].join("\n");

/** Sum toolCounts values without Object.values (intermediate array) allocation. */
export function sumToolCounts(counts = {}) {
  let n = 0;
  for (const k in counts) {
    if (Object.prototype.hasOwnProperty.call(counts, k)) n += counts[k];
  }
  return n;
}

/** Word count equivalent to `text.split(/\s+/).filter(Boolean).length` without allocating. */
export function countWords(text) {
  if (!text) return 0;
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && /\s/.test(text[i])) i++;
    if (i >= len) break;
    n++;
    while (i < len && !/\s/.test(text[i])) i++;
  }
  return n;
}

/** Sum word counts over multiple strings (e.g. chapter thinking blocks). */
export function countWordsInStrings(strings) {
  let total = 0;
  for (let i = 0; i < strings.length; i++) total += countWords(strings[i]);
  return total;
}

/** Equivalent to `text.split("\n").filter((l) => l.trim()).length` without allocating. */
export function countNonEmptyLines(text) {
  if (!text) return 0;
  let n = 0;
  let start = 0;
  const len = text.length;
  for (let i = 0; i <= len; i++) {
    if (i === len || text[i] === "\n") {
      if (text.slice(start, i).trim()) n++;
      start = i + 1;
    }
  }
  return n;
}

/** First `maxLines` lines joined with `\n` — same as `split("\n").slice(0, n).join("\n")` without full split. */
export function joinFirstLines(text, maxLines) {
  if (!text || maxLines <= 0) return "";
  let lines = 0;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (text[i] === "\n") {
      lines++;
      if (lines >= maxLines) return text.slice(0, i);
    }
  }
  return text;
}

/** First `maxLines` non-empty lines joined with `\n` (same trim test as countNonEmptyLines). */
export function joinFirstNonEmptyLines(text, maxLines) {
  if (!text || maxLines <= 0) return "";
  const parts = [];
  let start = 0;
  const len = text.length;
  for (let i = 0; i <= len && parts.length < maxLines; i++) {
    if (i === len || text[i] === "\n") {
      const line = text.slice(start, i);
      if (line.trim()) parts.push(line);
      start = i + 1;
    }
  }
  return parts.join("\n");
}

/** Parse WebSearch link objects from tool output JSON fragments. */
export function parseWebSearchLinks(output) {
  if (!output) return [];
  const linkRe = /\{"title":"([^"]*?)","url":"([^"]*?)"\}/g;
  const parsed = [];
  let m;
  while ((m = linkRe.exec(output)) !== null) {
    parsed.push({ title: m[1], url: m[2] });
  }
  return parsed;
}