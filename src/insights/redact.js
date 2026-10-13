/**
 * Secret redaction for text the hub puts on screen (fact insrd). Reuses the
 * vendored gitleaks rules and the share scanner, plus a few shapes those rules
 * leave alone because they need no keyword (bearer headers, URL credentials,
 * KEY=value assignments). Every pattern targets a secret's shape, never a bare
 * word, because hub mode runs whole HTML and JSON responses through it.
 */
import { loadSecretRules } from "../share/secret-rules.js";
import { compileRules, scanText } from "../share/scanner.js";
import { redactPemBlocks } from "../share/redactor.js";

export const REDACTED = "[REDACTED]";

let _compiled = null;

function compiledRules() {
  if (!_compiled) {
    // Keyword prefilter is applied once per call against one lowercase copy
    // (see activeRules), so the copies handed to scanText carry no keywords
    // and scanText never lowercases the whole text again for every rule.
    _compiled = compileRules(loadSecretRules()).map((rule) => ({ rule, keywords: rule.keywords, scan: { ...rule, keywords: [] } }));
  }
  return _compiled;
}

/** The rules whose keyword prefilter passes on `text` — scanText's own check, done with one lowercase. */
function activeRules(text) {
  const lower = text.toLowerCase();
  const out = [];
  for (const { keywords, scan } of compiledRules()) {
    if (!keywords.length || keywords.some((kw) => lower.includes(kw))) out.push(scan);
  }
  return out;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace every occurrence of each secret with REDACTED, exactly as
 * `for (s of secrets) out = out.split(s).join(REDACTED)` would with secrets
 * sorted longest first, but with one scan of the text (a lookahead regex
 * that stops wherever any secret starts, overlaps included) and one copy,
 * instead of a full scan and copy per secret. A later secret can only match
 * where no earlier one was replaced: secrets never contain "[" or "]" and are
 * longer than the replacement, so a match can neither straddle nor sit
 * inside a "[REDACTED]".
 */
function replaceSecrets(text, secrets) {
  if (secrets.some((s) => s.length <= REDACTED.length || /[[\]]/.test(s))) {
    for (const secret of secrets) text = text.split(secret).join(REDACTED);
    return text;
  }
  const at = secrets.map(() => []);
  const re = new RegExp(`(?=${secrets.map(escapeRegExp).join("|")})`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const i = m.index;
    for (let k = 0; k < secrets.length; k++) if (text.startsWith(secrets[k], i)) at[k].push(i);
    re.lastIndex = i + 1;
  }
  let starts = [];
  let ends = [];
  for (let k = 0; k < secrets.length; k++) {
    const len = secrets[k].length;
    const found = [];
    let pos = 0;
    for (const i of at[k]) {
      if (i < pos) continue;
      const end = i + len;
      // Last claimed interval starting before `end`: claims are disjoint and
      // sorted, so it is the only one that can overlap [i, end).
      let lo = 0;
      let hi = starts.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] < end) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && ends[lo - 1] > i) continue;
      found.push(i, end);
      pos = end;
    }
    if (!found.length) continue;
    const ns = [];
    const ne = [];
    let a = 0;
    let b = 0;
    while (a < starts.length || b < found.length) {
      if (b >= found.length || (a < starts.length && starts[a] < found[b])) {
        ns.push(starts[a]);
        ne.push(ends[a]);
        a++;
      } else {
        ns.push(found[b]);
        ne.push(found[b + 1]);
        b += 2;
      }
    }
    starts = ns;
    ends = ne;
  }
  if (!starts.length) return text;
  const parts = [];
  let last = 0;
  for (let k = 0; k < starts.length; k++) {
    parts.push(text.slice(last, starts[k]), REDACTED);
    last = ends[k];
  }
  parts.push(text.slice(last));
  return parts.join("");
}

const EXTRA_PATTERNS = [
  // Authorization: Bearer <token> / "Bearer <token>"
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, `$1${REDACTED}`],
  // scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]{3,}(@)/gi, `$1${REDACTED}$2`],
  // FOO_TOKEN=value / FOO_API_KEY: "value" — env-style names only, so page
  // scripts that pass through hub-mode redaction are never rewritten.
  [/(\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?|DATABASE_URL|_DSN)[A-Z0-9_]*\\?["']?\s*[:=]\s*\\?["']?)(?!\[REDACTED\])[^\s"'\\,;&)}\]]{8,}/g, `$1${REDACTED}`],
  // password: "value", "api_key": "value" — lowercase names need a quoted value.
  [/(\b(?:password|passwd|secret|client_secret|api[_-]?key|access[_-]?token|auth[_-]?token)\\?["']?\s*[:=]\s*\\?["'])(?!\[REDACTED\])[^"'\\\s]{8,}/gi, `$1${REDACTED}`],
  // JWTs and sk-/ghp_/xox style provider keys that sit bare in output
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, REDACTED],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
];

/** Replace every secret-shaped substring of `text` with [REDACTED]. */
export function redactText(text) {
  if (typeof text !== "string" || !text) return text;
  let out = redactPemBlocks(text);
  const findings = [];
  scanText(out, activeRules(out), { eventIndex: 0, field: "text" }, findings, new Set());
  if (findings.length) {
    const secrets = [...new Set(findings.map((f) => f.secret).filter(Boolean))];
    secrets.sort((a, b) => b.length - a.length);
    out = replaceSecrets(out, secrets);
  }
  for (const [re, replacement] of EXTRA_PATTERNS) out = out.replace(re, replacement);
  return out;
}
