#!/usr/bin/env node
/**
 * Fetch latest gitleaks TOML config and convert to vendored JSON.
 * Dev-only script — TOML parsing uses minimal inline parser (no runtime dep).
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = join(PKG_ROOT, "data/secret-rules.json");
const UPSTREAM_URL = "https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml";

/** Minimal TOML → rules[] for gitleaks [[rules]] blocks. */
function parseGitleaksToml(text) {
  const rules = [];
  let current = null;
  let inAllowlist = false;
  let allowlist = null;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line === "[[rules]]") {
      if (current) rules.push(finalizeRule(current, allowlist));
      current = {};
      allowlist = null;
      inAllowlist = false;
      continue;
    }

    if (line === "[rules.allowlist]") {
      inAllowlist = true;
      allowlist = { regexes: [] };
      continue;
    }

    if (line.startsWith("[") && !line.startsWith("[[rules]]")) {
      inAllowlist = false;
      continue;
    }

    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m || !current) continue;

    const key = m[1];
    let val = m[2].trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);

    if (inAllowlist && key === "regexes") {
      const arr = val.replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      allowlist.regexes.push(...arr);
      continue;
    }

    if (key === "keywords") {
      current.keywords = val.replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
      continue;
    }

    if (key === "id") current.id = val;
    else if (key === "description") current.description = val;
    else if (key === "regex") current.regex = val;
    else if (key === "entropy") current.entropy = Number(val);
    else if (key === "secretGroup") current.secretGroup = Number(val);
  }

  if (current) rules.push(finalizeRule(current, allowlist));
  return rules.filter((r) => r.id && r.regex);
}

function finalizeRule(rule, allowlist) {
  const out = {
    id: rule.id,
    description: rule.description || rule.id,
    regex: rule.regex,
  };
  if (rule.keywords?.length) out.keywords = rule.keywords;
  if (rule.entropy != null && !Number.isNaN(rule.entropy)) out.entropy = rule.entropy;
  if (rule.secretGroup != null && !Number.isNaN(rule.secretGroup)) out.secretGroup = rule.secretGroup;
  if (allowlist?.regexes?.length) out.allowlist = { regexes: allowlist.regexes };
  return out;
}

async function main() {
  console.log(`Fetching ${UPSTREAM_URL} ...`);
  const res = await fetch(UPSTREAM_URL);
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const toml = await res.text();
  const newRules = parseGitleaksToml(toml);

  let oldRules = [];
  try {
    oldRules = JSON.parse(readFileSync(OUT_PATH, "utf8"));
  } catch { /* first run */ }

  const oldIds = new Set(oldRules.map((r) => r.id));
  const newIds = new Set(newRules.map((r) => r.id));
  const added = [...newIds].filter((id) => !oldIds.has(id));
  const removed = [...oldIds].filter((id) => !newIds.has(id));
  const changed = newRules.filter((r) => {
    const prev = oldRules.find((o) => o.id === r.id);
    return prev && JSON.stringify(prev) !== JSON.stringify(r);
  }).map((r) => r.id);

  writeFileSync(OUT_PATH, JSON.stringify(newRules, null, 2) + "\n");
  console.log(`Wrote ${newRules.length} rules to ${OUT_PATH}`);
  console.log(`  added: ${added.length}, removed: ${removed.length}, changed: ${changed.length}`);
  if (added.length) console.log(`  + ${added.slice(0, 10).join(", ")}${added.length > 10 ? "..." : ""}`);
  if (removed.length) console.log(`  - ${removed.slice(0, 10).join(", ")}${removed.length > 10 ? "..." : ""}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});