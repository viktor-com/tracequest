/**
 * Assert that a snapshot, log line, or error string contains none of the
 * secrets loaded for a collect run. Used by tests and production logging.
 */
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;
const SK_RE = /sk-[A-Za-z0-9_-]{8,}/;

export function collectSecrets(values) {
  const out = [];
  for (const value of values || []) {
    if (typeof value === "string" && value.length >= 8) out.push(value);
  }
  return out;
}

export function assertNoSecrets(text, secrets, { label = "text" } = {}) {
  const haystack = typeof text === "string" ? text : JSON.stringify(text);
  for (const secret of secrets || []) {
    if (secret && haystack.includes(secret)) {
      throw new Error(`${label} leaked a loaded secret`);
    }
  }
  return true;
}

export function looksLikeSecretBlob(text) {
  const haystack = typeof text === "string" ? text : JSON.stringify(text);
  return JWT_RE.test(haystack) || SK_RE.test(haystack);
}

export function redactSecrets(text, secrets) {
  let out = String(text ?? "");
  for (const secret of secrets || []) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}
