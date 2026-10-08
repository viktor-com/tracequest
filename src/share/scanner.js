/** Shannon entropy for gitleaks-style rule checks. */
export function shannonEntropy(str) {
  if (!str || str.length === 0) return 0;
  const freq = new Map();
  for (const c of str) freq.set(c, (freq.get(c) || 0) + 1);
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Redact a matched secret for display: first 4 + last 4 chars. */
export function redactMatchDisplay(match) {
  if (!match) return "****";
  if (match.length <= 8) return "****";
  return match.slice(0, 4) + "…" + match.slice(-4);
}

/** Map gitleaks PCRE inline flag letters to JavaScript RegExp flags. */
const PCRE_INLINE_FLAG_MAP = {
  i: "i",
  m: "m",
  s: "s",
  u: "u",
};

/** Normalize gitleaks PCRE inline flags (e.g. `(?i)`, `(?is)`) for JavaScript RegExp. */
export function normalizeRuleRegex(pattern, flags = "g") {
  let source = String(pattern);
  let outFlags = flags.includes("g") ? flags : `${flags}g`;
  const inlineFlagRe = /^\(\?([imsu]+)\)/;
  let match;
  while ((match = inlineFlagRe.exec(source))) {
    for (const ch of match[1]) {
      const jsFlag = PCRE_INLINE_FLAG_MAP[ch];
      if (jsFlag && !outFlags.includes(jsFlag)) outFlags += jsFlag;
    }
    source = source.slice(match[0].length);
  }
  return { source, flags: outFlags };
}

/** Compile vendored rules into RegExp objects. */
export function compileRules(rules) {
  return (rules || []).map((rule) => {
    let regex;
    try {
      const { source, flags } = normalizeRuleRegex(rule.regex, rule.flags || "g");
      regex = new RegExp(source, flags);
    } catch {
      return null;
    }
    const allowlist = (rule.allowlist?.regexes || []).map((pat) => {
      try {
        return new RegExp(pat);
      } catch {
        return null;
      }
    }).filter(Boolean);
    const keywords = (rule.keywords || []).map((k) => String(k).toLowerCase());
    return { ...rule, regex, allowlist, keywords };
  }).filter(Boolean);
}

export function textHasKeywords(text, keywords) {
  if (!keywords.length) return true;
  const lower = text.toLowerCase();
  for (const kw of keywords) {
    if (lower.includes(kw)) return true;
  }
  return false;
}

export function isAllowlisted(match, allowlist) {
  for (const re of allowlist) {
    if (re.test(match)) return true;
  }
  return false;
}

export function scanText(text, compiledRules, ctx, findings, seen) {
  if (!text || typeof text !== "string") return;
  for (const rule of compiledRules) {
    if (!textHasKeywords(text, rule.keywords)) continue;
    rule.regex.lastIndex = 0;
    let m;
    while ((m = rule.regex.exec(text)) !== null) {
      const full = m[0];
      const secret = rule.secretGroup != null ? (m[rule.secretGroup] || full) : full;
      if (!secret) continue;
      if (rule.entropy != null && shannonEntropy(secret) < rule.entropy) continue;
      if (isAllowlisted(secret, rule.allowlist)) continue;
      const key = `${rule.id}:${secret}:${ctx.eventIndex}:${ctx.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        ruleId: rule.id,
        description: rule.description,
        match: redactMatchDisplay(secret),
        secret,
        location: {
          chapterIndex: ctx.chapterIndex,
          eventIndex: ctx.eventIndex,
          eventType: ctx.eventType,
          toolName: ctx.toolName || null,
          field: ctx.field || null,
        },
      });
    }
  }
}

export function scanObjectStrings(obj, compiledRules, ctx, findings, seen, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return;
  if (Array.isArray(obj)) {
    for (const item of obj) scanObjectStrings(item, compiledRules, ctx, findings, seen, depth + 1);
    return;
  }
  for (const val of Object.values(obj)) {
    if (typeof val === "string") scanText(val, compiledRules, ctx, findings, seen);
    else if (val && typeof val === "object") scanObjectStrings(val, compiledRules, ctx, findings, seen, depth + 1);
  }
}

export function scanMcpInfo(mcpInfo, compiledRules, ctx, findings, seen) {
  if (!mcpInfo) return;
  if (typeof mcpInfo.params === "string") {
    scanText(mcpInfo.params, compiledRules, { ...ctx, field: "mcpInfo.params" }, findings, seen);
  }
  scanObjectStrings(mcpInfo, compiledRules, { ...ctx, field: "mcpInfo" }, findings, seen);
}

export function scanDiffInfo(diffInfo, compiledRules, ctx, findings, seen) {
  if (!diffInfo) return;
  if (diffInfo.oldStr) scanText(diffInfo.oldStr, compiledRules, { ...ctx, field: "diffInfo.oldStr" }, findings, seen);
  if (diffInfo.newStr) scanText(diffInfo.newStr, compiledRules, { ...ctx, field: "diffInfo.newStr" }, findings, seen);
  if (diffInfo.content) scanText(diffInfo.content, compiledRules, { ...ctx, field: "diffInfo.content" }, findings, seen);
}

export function scanToolCall(tc, compiledRules, ctx, findings, seen) {
  if (!tc) return;
  const toolCtx = { ...ctx, toolName: tc.name || null, field: "toolCalls[].input" };
  if (tc.input) scanText(tc.input, compiledRules, toolCtx, findings, seen);
  scanDiffInfo(tc.diffInfo, compiledRules, { ...ctx, toolName: tc.name || null }, findings, seen);
  scanMcpInfo(tc.mcpInfo, compiledRules, { ...ctx, toolName: tc.name || null }, findings, seen);
  if (tc.agentInfo) scanObjectStrings(tc.agentInfo, compiledRules, { ...ctx, field: "agentInfo" }, findings, seen);
  if (tc.webInfo) scanObjectStrings(tc.webInfo, compiledRules, { ...ctx, field: "webInfo" }, findings, seen);
}

export function scanAgentHistory(agentHistory, compiledRules, findings, seen) {
  if (!agentHistory || !Array.isArray(agentHistory)) return;
  for (let i = 0; i < agentHistory.length; i++) {
    const entry = agentHistory[i];
    const ctx = {
      chapterIndex: 0,
      eventIndex: i,
      eventType: "agentHistory",
      toolName: entry?.agentId || null,
      field: "agentHistory.record",
    };
    if (entry?.record) scanObjectStrings(entry.record, compiledRules, ctx, findings, seen);
  }
}

/** Scan top-level session string fields embedded in renderHTML JSON. */
export function scanSessionScalars(session, compiledRules, findings, seen) {
  const scalarFields = ["cwd", "gitBranch", "title", "model", "project", "sessionId"];
  for (const field of scalarFields) {
    const val = session[field];
    if (typeof val !== "string" || !val) continue;
    const ctx = {
      chapterIndex: 0,
      eventIndex: -1,
      eventType: "session",
      toolName: null,
      field,
    };
    scanText(val, compiledRules, ctx, findings, seen);
  }
}

/**
 * Scan a parsed session for secrets using vendored gitleaks-style rules.
 * @returns {Array<{ruleId, description, match, secret, location}>}
 */
export function scanSessionForSecrets(session, rules) {
  const compiledRules = compileRules(rules);
  const findings = [];
  const seen = new Set();
  const events = session.events || [];
  let chapterIndex = 0;

  scanSessionScalars(session, compiledRules, findings, seen);

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const e = events[eventIndex];
    if (eventIndex > 0 && e.type === "user" && e.text) chapterIndex++;

    const ctx = {
      chapterIndex,
      eventIndex,
      eventType: e.type,
      toolName: null,
      field: "text",
    };

    if (e.text) scanText(e.text, compiledRules, ctx, findings, seen);

    if (Array.isArray(e.thinking)) {
      for (const block of e.thinking) {
        scanText(block, compiledRules, { ...ctx, field: "thinking" }, findings, seen);
      }
    }

    if (Array.isArray(e.toolCalls)) {
      for (const tc of e.toolCalls) scanToolCall(tc, compiledRules, ctx, findings, seen);
    }

    if (e.diffInfo) scanDiffInfo(e.diffInfo, compiledRules, ctx, findings, seen);
    if (e.mcpInfo) scanMcpInfo(e.mcpInfo, compiledRules, ctx, findings, seen);
  }

  scanAgentHistory(session.agentHistory, compiledRules, findings, seen);

  findings.sort((a, b) => {
    const la = a.location;
    const lb = b.location;
    if (la.chapterIndex !== lb.chapterIndex) return la.chapterIndex - lb.chapterIndex;
    if (la.eventIndex !== lb.eventIndex) return la.eventIndex - lb.eventIndex;
    return (la.toolName || "").localeCompare(lb.toolName || "");
  });

  return findings;
}