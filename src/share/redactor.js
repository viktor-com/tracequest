const PEM_BLOCK_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;

export function redactString(str, secrets) {
  if (!str || typeof str !== "string") return str;
  let out = str;
  for (const secret of secrets) {
    if (!secret || !out.includes(secret)) continue;
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

export function redactPemBlocks(str) {
  if (!str || typeof str !== "string") return str;
  return str.replace(PEM_BLOCK_RE, "[REDACTED]");
}

export function redactValue(val, secrets) {
  if (typeof val === "string") return redactPemBlocks(redactString(val, secrets));
  if (Array.isArray(val)) return val.map((item) => redactValue(item, secrets));
  if (val && typeof val === "object") {
    for (const key of Object.keys(val)) {
      val[key] = redactValue(val[key], secrets);
    }
    return val;
  }
  return val;
}

/**
 * Deep-copy a session and replace matched secrets with [REDACTED].
 * The original session is never mutated.
 */
export function redactSession(session, findings) {
  if (!findings.length) return structuredClone(session);
  const secrets = [...new Set(findings.map((f) => f.secret).filter(Boolean))];
  secrets.sort((a, b) => b.length - a.length);
  return redactValue(structuredClone(session), secrets);
}
