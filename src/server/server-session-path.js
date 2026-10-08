import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { isIndexDiskExpectedErr } from "../utils/fs-expected-err.js";
import { isOpenCodeSessionId, parseOpenCodeUri, resolveCursorCloudRoot, resolveHostsRoot } from "../sessions/session-discovery-paths.js";

/** Agent config dirs under $HOME that may contain session logs (trailing slash). */
export function agentSessionRootPrefixes(home = homedir()) {
  return [".claude", ".codex", ".cursor", ".factory", ".grok"].map((dir) => `${home}/${dir}/`);
}

/**
 * The tracequest-owned cursor-cloud import root as a canonical prefix (fact ccsp).
 * Lives under ~/.local/share (or the TRACEQUEST_CURSOR_CLOUD_DIR override), so the
 * dot-dir prefixes above never cover it. Realpath'd like canonicalHome so it can
 * be compared against a realpath'd session path; an absent root keeps its literal
 * path (nothing under it can exist to match anyway).
 */
function cursorCloudRootPrefix() {
  let root = resolveCursorCloudRoot();
  try {
    root = realpathSync(root);
  } catch {
    /* root not created yet */
  }
  return root.endsWith("/") ? root : `${root}/`;
}

function hostsRootPrefix() {
  let root = resolveHostsRoot();
  try {
    root = realpathSync(root);
  } catch {
    /* root not created yet */
  }
  return root.endsWith("/") ? root : `${root}/`;
}

/**
 * Home directory resolved through any symlinks, so it can be compared against a
 * realpath'd file path. Without this, a home reached via a symlinked prefix
 * (macOS `/var` → `/private/var`, or a symlinked `$HOME`) would never match the
 * canonical session path and every session under it would be rejected as 403.
 */
function canonicalHome() {
  const home = homedir();
  try {
    return realpathSync(home);
  } catch {
    return home; // home vanished mid-request; fall back to the literal path
  }
}

/**
 * Best-effort session SOURCE inferred from the recording path alone — the
 * fallback for endpoints whose session-list lookup missed (a recording an
 * agent created seconds ago that discovery has not indexed yet). Keyed off
 * the same agent roots isSessionPath allowlists; claude stays the final
 * fallback (the family-default dialect). A .cursor/projects recording must
 * never be labeled "claude".
 */
export function sourceForSessionPath(p) {
  const s = String(p ?? "");
  if (s.startsWith("opencode://")) return "opencode";
  if (s.includes("/.cursor/")) return "cursor";
  if (s.includes("/.codex/")) return "codex";
  if (s.includes("/.factory/")) return "factory";
  if (s.includes("/.grok/")) return "grok";
  try {
    if (s.startsWith(cursorCloudRootPrefix())) return "cursor-cloud";
  } catch {
    // cursor-cloud root unresolvable — fall through
  }
  return "claude";
}

export function isSessionPath(p) {
  if (!p || typeof p !== "string") return false;
  if (p.startsWith("opencode://")) {
    const { sessionId } = parseOpenCodeUri(p);
    return isOpenCodeSessionId(sessionId);
  }
  const resolved = resolve(p);
  if (!existsSync(resolved)) return false; // missing fs file under prefix -> invalid (prevents 500 parse error path)
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`isSessionPath: realpath failed for ${resolved}:`, err.message);
    }
    return false;
  }
  // Compare the realpath'd file against prefixes built from the realpath'd home,
  // so both sides are canonical (see canonicalHome).
  const prefixes = [...agentSessionRootPrefixes(canonicalHome()), cursorCloudRootPrefix(), hostsRootPrefix()];
  if (!prefixes.some((prefix) => canonical.startsWith(prefix))) return false;
  // Beyond the directory allowlist, require the target to actually be a session:
  // a .jsonl log (Claude/Codex/Factory) or a Grok session directory (which holds
  // chat_history.jsonl). This rejects unrelated files under those dirs such as
  // ~/.claude/.credentials.json or settings.json.
  try {
    const st = statSync(canonical);
    if (st.isDirectory()) return existsSync(join(canonical, "chat_history.jsonl"));
    return canonical.endsWith(".jsonl");
  } catch (err) {
    if (!isIndexDiskExpectedErr(err)) {
      console.error(`isSessionPath: stat failed for ${canonical}:`, err.message);
    }
    return false;
  }
}

export function projectLabel(slug) {
  if (!slug || typeof slug !== "string") return "";
  const m = slug.match(/-code-(.+)$/);
  if (m) return m[1];
  return slug.replace(/^-home-[^-]+-/, "");
}

/** Absolute project directory → short label (e.g. ~/code/foo → foo). */
export function shortenProjectPath(path) {
  if (!path) return "";
  const home = homedir();
  return path.replace(home, "~").replace(/^~\/code\//, "");
}

/** Normalize any project string to a single folder name for display and aggregation. */
export function normalizeProjectFolder(project) {
  if (!project || typeof project !== "string") return "(unknown)";
  let label = project.trim();
  if (!label) return "(unknown)";

  const fromSlug = projectLabel(label);
  if (fromSlug) label = fromSlug;

  const shortened = shortenProjectPath(label);
  if (shortened) label = shortened;

  if (label.includes("/")) {
    const parts = label.split("/").filter(Boolean);
    label = parts[parts.length - 1] || label;
  }

  return label || "(unknown)";
}

/** Short display id from a session filename (e.g. `abc12345.jsonl` → `abc12345`). */
export function sessionDisplayId(file) {
  if (!file) return "";
  return file.replace(".jsonl", "").slice(0, 8);
}
