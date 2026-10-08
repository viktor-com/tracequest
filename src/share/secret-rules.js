import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Vendored gitleaks-style rules shipped with the package. */
export function loadSecretRules() {
  const raw = readFileSync(join(PKG_ROOT, "data/secret-rules.json"), "utf8");
  return JSON.parse(raw);
}

/** JSON string for inlining in browser bundles. */
export function secretRulesJson() {
  return readFileSync(join(PKG_ROOT, "data/secret-rules.json"), "utf8");
}