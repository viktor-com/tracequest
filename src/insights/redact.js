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
  if (!_compiled) _compiled = compileRules(loadSecretRules());
  return _compiled;
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
  scanText(out, compiledRules(), { eventIndex: 0, field: "text" }, findings, new Set());
  if (findings.length) {
    const secrets = [...new Set(findings.map((f) => f.secret).filter(Boolean))];
    secrets.sort((a, b) => b.length - a.length);
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of EXTRA_PATTERNS) out = out.replace(re, replacement);
  return out;
}
