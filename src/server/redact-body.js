/**
 * Hub-mode redaction of whole response bodies that never corrupts structured
 * data (fact hrd6). A secret pattern run over serialized JSON can match across
 * a string boundary — `"model":"x","prompt":"…@…"` — and replacing that span
 * eats quotes and commas, so the page's JSON.parse fails. Structured data is
 * therefore redacted value by value:
 *
 * - JSON bodies: each string member ("key":"value", so key-named secrets are
 *   still found) and string element is redacted on its own, then the
 *   document is re-serialized.
 * - JSONL bodies (raw recordings): each line holding a secret is redacted as
 *   JSON; every other line keeps its exact bytes.
 * - HTML bodies: data embedded as `<script type="application/json">…</script>`
 *   or as a one-line `var|let|const NAME = <json>;` is redacted as JSON (and
 *   re-escaped for a script element); the markup around it as text.
 * - Anything else (markdown, plain text) is redacted as text.
 *
 * Structured redaction never sees a pattern straddle two values; a secret
 * inside one value is replaced exactly as redactText would replace it.
 */
import { REDACTED, redactText } from "../insights/redact.js";

/** Kind of body a Content-Type carries, for redactBody. */
export function redactKindFor(contentType) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.startsWith("text/html")) return "html";
  if (/^application\/(?:jsonl|x-ndjson|ndjson)\b/.test(ct)) return "jsonl";
  if (/^application\/(?:[\w.+-]*\+)?json\b/.test(ct)) return "json";
  return "text";
}

/** Redact `text` (a string) according to `kind` ("html" | "json" | "jsonl" | "text"). */
export function redactBody(text, kind) {
  if (typeof text !== "string" || !text) return text;
  if (kind === "json") return redactJsonText(text);
  if (kind === "jsonl") return redactJsonlText(text);
  if (kind === "html") return redactHtmlText(text);
  return redactText(text);
}

/**
 * Separator for redacting many strings in one redactText call. It holds a
 * newline (no secret shape spans one without whitespace classes) and NULs,
 * which no secret shape contains; a match that still consumes one shows up as
 * a missing separator and the strings are then redacted one by one.
 */
const SEP = "\n\u0000\u0000\n";

function countSep(text) {
  let n = 0;
  for (let i = text.indexOf(SEP); i !== -1; i = text.indexOf(SEP, i + SEP.length)) n++;
  return n;
}

/** Redacted copies of `units` (same order), or null when none changes. */
function redactUnits(units) {
  if (!units.length) return null;
  const joined = units.join(SEP);
  const red = redactText(joined);
  if (red === joined) return null;
  // A unit that itself contains SEP would misalign the split.
  if (countSep(joined) === units.length - 1) {
    const parts = red.split(SEP);
    if (parts.length === units.length) return parts;
  }
  return units.map((u) => redactText(u));
}

/**
 * The redaction units of a parsed JSON document: each string array element
 * serialized on its own (`"value"`), and each object member with a string
 * value serialized with its key (`"key":"value"`), so key-named secrets
 * (`"api_key":"…"`) are found exactly as in the serialized text while no
 * pattern can span two members.
 */
function collectUnits(value, units, refs) {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      if (typeof v === "string") {
        units.push(JSON.stringify(v));
        refs.push({ arr: value, i });
      } else if (v && typeof v === "object") {
        collectUnits(v, units, refs);
      }
    }
  } else if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (typeof v === "string") {
        units.push(JSON.stringify(k) + ":" + JSON.stringify(v));
        refs.push({ obj: value, k });
      } else if (v && typeof v === "object") {
        collectUnits(v, units, refs);
      }
    }
  }
}

function setOwn(obj, key, val) {
  // defineProperty: a "__proto__" key stays an own data property.
  Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
}

/**
 * Write redacted units back. A unit that no longer parses as its member or
 * element (a match ran past its quotes) gets its whole value replaced:
 * never corrupt, never leak.
 */
function applyUnits(refs, units, red) {
  const renamed = new Map();
  for (let u = 0; u < refs.length; u++) {
    if (red[u] === units[u]) continue;
    const ref = refs[u];
    if (ref.arr) {
      let v;
      try {
        v = JSON.parse(red[u]);
      } catch {
        v = undefined;
      }
      ref.arr[ref.i] = typeof v === "string" ? v : REDACTED;
      continue;
    }
    let key = ref.k;
    let val = REDACTED;
    try {
      const o = JSON.parse("{" + red[u] + "}");
      const keys = Object.keys(o);
      if (keys.length === 1 && typeof o[keys[0]] === "string") {
        key = keys[0];
        val = o[key];
      }
    } catch {
      // keep the key, drop the value
    }
    setOwn(ref.obj, ref.k, val);
    if (key !== ref.k) {
      let m = renamed.get(ref.obj);
      if (!m) renamed.set(ref.obj, (m = new Map()));
      m.set(ref.k, key);
    }
  }
  // Renamed keys keep their position: re-add every member in order.
  for (const [obj, names] of renamed) {
    const entries = Object.keys(obj).map((k) => [names.get(k) ?? k, obj[k]]);
    for (const k of Object.keys(obj)) delete obj[k];
    for (const [k, v] of entries) setOwn(obj, k, v);
  }
}

/** JSON text safe inside a <script> element: no "<", ">", "&" or line separators. */
function scriptSafeJson(json) {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Redact one JSON document value by value. Text that is not JSON is redacted
 * as text. Unchanged documents keep their exact bytes.
 */
export function redactJsonText(text, { script = false } = {}) {
  if (text.length < MEMO_MIN_CHARS) return redactJsonUncached(text, script);
  // A large embedded document (the palette catalog, a session) is often the
  // same text request after request: redaction is a pure function of it.
  const key = script ? "s" : "j";
  const memo = _memo.get(text);
  if (memo && memo[key] !== undefined) {
    _memo.delete(text);
    _memo.set(text, memo);
    return memo[key];
  }
  const out = redactJsonUncached(text, script);
  const entry = memo || {};
  entry[key] = out;
  _memo.delete(text);
  _memo.set(text, entry);
  while (_memo.size > MEMO_ENTRIES) _memo.delete(_memo.keys().next().value);
  return out;
}

/** Documents at least this long are memoized, the last MEMO_ENTRIES of them. */
const MEMO_MIN_CHARS = 256 * 1024;
const MEMO_ENTRIES = 2;
/** text -> { j?: redacted JSON, s?: redacted script-safe JSON }, least recently used first. */
const _memo = new Map();

function redactJsonUncached(text, script) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return redactText(text);
  }
  if (typeof value === "string") {
    const red = redactText(value);
    if (red === value) return text;
    return script ? scriptSafeJson(JSON.stringify(red)) : JSON.stringify(red);
  }
  const units = [];
  const refs = [];
  collectUnits(value, units, refs);
  const red = redactUnits(units);
  if (!red) return text;
  applyUnits(refs, units, red);
  const json = JSON.stringify(value);
  return script ? scriptSafeJson(json) : json;
}

/** Lines per redactText call when scanning a recording for secrets. */
const JSONL_BLOCK_CHARS = 1 << 20;

/** Redact a JSONL body line by line; lines without a secret keep their bytes. */
export function redactJsonlText(text) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", Math.min(text.length, start + JSONL_BLOCK_CHARS));
    end = end === -1 ? text.length : end + 1;
    const block = text.slice(start, end);
    out.push(redactText(block) === block ? block : redactJsonlLines(block));
    start = end;
  }
  return out.join("");
}

function redactJsonlLines(block) {
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || redactText(line) === line) continue;
    lines[i] = redactJsonText(line);
  }
  return lines.join("\n");
}

const JSON_SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']application\/json["'][^>]*>/gi;
const DATA_LINE_RE = /(^|\n)([ \t]*(?:var|let|const)[ \t]+[A-Za-z_$][\w$]*[ \t]*=[ \t]*)(?=[[{"])/g;

/**
 * Embedded JSON regions of an HTML page: [start, end) of each JSON text.
 * A `NAME = <json>;` line counts only when the text up to the line's end
 * (minus a trailing ";") parses as JSON — JSON.stringify output never holds a
 * raw newline, so the value always ends on its own line.
 */
function embeddedJsonRegions(html) {
  const regions = [];
  JSON_SCRIPT_RE.lastIndex = 0;
  for (let m = JSON_SCRIPT_RE.exec(html); m; m = JSON_SCRIPT_RE.exec(html)) {
    const start = m.index + m[0].length;
    const end = html.indexOf("</script", start);
    if (end === -1) break;
    regions.push([start, end]);
    JSON_SCRIPT_RE.lastIndex = end;
  }
  DATA_LINE_RE.lastIndex = 0;
  for (let m = DATA_LINE_RE.exec(html); m; m = DATA_LINE_RE.exec(html)) {
    const start = m.index + m[1].length + m[2].length;
    let end = html.indexOf("\n", start);
    if (end === -1) end = html.length;
    let jsonEnd = end;
    while (jsonEnd > start && /\s/.test(html[jsonEnd - 1])) jsonEnd--;
    if (html[jsonEnd - 1] === ";") jsonEnd--;
    DATA_LINE_RE.lastIndex = end;
    if (jsonEnd - start < 2) continue;
    try {
      JSON.parse(html.slice(start, jsonEnd));
    } catch {
      continue;
    }
    regions.push([start, jsonEnd]);
  }
  regions.sort((a, b) => a[0] - b[0]);
  // Drop a region nested in an earlier one (a data line inside a JSON script).
  const flat = [];
  for (const r of regions) if (!flat.length || r[0] >= flat[flat.length - 1][1]) flat.push(r);
  return flat;
}

/** Redact an HTML page: embedded JSON as JSON, the markup between as text. */
export function redactHtmlText(html) {
  const regions = embeddedJsonRegions(html);
  if (!regions.length) return redactText(html);
  const out = [];
  let at = 0;
  for (const [start, end] of regions) {
    out.push(redactText(html.slice(at, start)), redactJsonText(html.slice(start, end), { script: true }));
    at = end;
  }
  out.push(redactText(html.slice(at)));
  return out.join("");
}
