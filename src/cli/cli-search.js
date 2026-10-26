/**
 * tracequest search / handoff. Only what an unfiltered query needs is imported
 * here, so these commands start without loading the renderer, server, share,
 * standup or import modules (fact id4); --filter loads cli-filter.js on demand.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename, dirname, join } from "node:path";
import { findSessions as discoverCliSessions, buildIndex, searchSessions } from "../sessions.js";
import { buildIndexForFilteredSearch } from "../sessions/index-writers.js";
import { getSearchIndex } from "../sessions/search-index.js";
import { captureStderr, openSearchResultCache } from "./search-result-cache.js";
// normalizeProjectFolder (not projectLabel) is the single project-normalisation
// used by every CLI printer, so `list` / `find` / `latest` / `search` render the
// exact same project string that /api/sessions returns for the same record.
// projectLabel alone leaves an absolute project path (Grok workspace shape)
// unchanged; normalizeProjectFolder wraps it and collapses to the folder name.
import { normalizeProjectFolder } from "../server/server-session-path.js";
import { sessionHash } from "../sessions/session-hash.js";
import { die } from "./cli-die.js";
import { k } from "./cli-color.js";
import { showHelp } from "./cli-help.js";

// Discovery seam: tests inject a fixed session list to cover discovery-row
// shapes the local filesystem cannot produce, e.g. an epoch-ms mtime from a
// sidecar scan or index row.
let findSessions = discoverCliSessions;

export function setCliSessionFinderForTests(finder) {
  findSessions = finder || discoverCliSessions;
}

/** Discover sessions through the seam above (every CLI command uses it). */
export function findCliSessions(projectFilter) {
  return findSessions(projectFilter);
}

function markdownInlineCode(value) {
  const text = String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "`(none)`";
  const runs = text.match(/`+/g) || [""];
  const fence = "`".repeat(Math.max(...runs.map((run) => run.length)) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function shellQuote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function compactHandoffText(value, max = 160) {
  const text = String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function normalizeHandoffSort(sort) {
  const value = String(sort || "relevance").trim().toLowerCase();
  if (!value || value === "relevance" || value === "score") return "relevance";
  if (value === "recent" || value === "date") return value;
  die(`Invalid handoff sort: ${sort}\nSupported sorts: relevance, recent, date`);
}

/**
 * Names of the git repository enclosing the cwd (not a dotfiles repo at HOME), or null: its origin
 * remote's name, so a worktree in a differently named folder still names its repository, and its folder.
 */
function currentRepoNames() {
  const home = homedir();
  let dir = process.cwd();
  while (!existsSync(join(dir, ".git"))) {
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  if (dir === home) return null;
  const names = [basename(dir)];
  try {
    let gitDir = join(dir, ".git");
    if (statSync(gitDir).isFile()) {
      // Worktree: ".git" points at <repo>/.git/worktrees/<name>, whose commondir leads back to <repo>/.git.
      gitDir = resolve(dir, readFileSync(gitDir, "utf8").match(/^gitdir:\s*(.+)$/m)[1].trim());
      const common = join(gitDir, "commondir");
      if (existsSync(common)) gitDir = resolve(gitDir, readFileSync(common, "utf8").trim());
    }
    const url = readFileSync(join(gitDir, "config"), "utf8").match(/\[remote "origin"\][^[]*?\burl\s*=\s*(.+)/i)?.[1];
    const origin = url?.trim().replace(/^["']|["']$/g, "").replace(/\/+$/, "").replace(/(\/\.git|\.git)$/, "").split(/[/:]/).pop();
    if (origin && !names.includes(origin)) names.unshift(origin);
  } catch {
    // Unreadable git metadata: the folder name alone.
  }
  return names;
}

function sortSearchHandoffResults(results, sort) {
  if (sort !== "recent" && sort !== "date") return results;
  return [...results].sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
}

function formatSearchHandoff(query, results, { limit, entryCommand = "search", filter = "", sort = "relevance" }) {
  const refreshParts = entryCommand === "handoff"
    ? ["tracequest", "handoff", shellQuote(query)]
    : ["tracequest", "search", shellQuote(query), "--format", "handoff"];
  if (filter) refreshParts.push("--filter", shellQuote(filter));
  if (sort && sort !== "relevance") refreshParts.push("--sort", shellQuote(sort));
  refreshParts.push("--limit", String(limit));
  const refreshCommand = refreshParts.join(" ");
  const lines = [
    "# TraceQuest Search Handoff",
    "",
    `- Query: ${markdownInlineCode(query)}`,
    `- Sort: ${markdownInlineCode(sort || "relevance")}`,
    `- Results: ${results.length}`,
    "- Privacy: includes session hashes, metadata, and capped TraceQuest search snippets; no full transcripts or absolute paths.",
    "",
    "## Follow-up Commands",
    "",
    `- Refresh this handoff: ${markdownInlineCode(refreshCommand)}`,
    "",
    "## Matches",
    "",
  ];

  if (!results.length) {
    lines.push("No matching sessions found.", "");
    return lines.join("\n");
  }

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const hash = r.id || r.sessionHash || sessionHash(r.path);
    const date = r.mtime ? new Date(r.mtime).toISOString().slice(0, 16).replace("T", " ") : "(unknown)";
    const source = r.source || "claude";
    // normalizeProjectFolder (not projectLabel) so an absolute project path
    // collapses to a folder name — the header promises no absolute paths.
    const project = normalizeProjectFolder(r.project);
    const prompt = compactHandoffText(r.prompt, 120);
    const matches = Array.isArray(r.matches) ? r.matches : [];

    lines.push(`${i + 1}. Session ${markdownInlineCode(hash)}`);
    lines.push(`   - Date: ${markdownInlineCode(date)}`);
    lines.push(`   - Source: ${markdownInlineCode(source)}`);
    lines.push(`   - Project: ${markdownInlineCode(project)}`);
    if (prompt) {
      lines.push(`   - First prompt: ${markdownInlineCode(prompt)}`);
    }
    lines.push("   - Snippets:");
    if (!matches.length) {
      lines.push("     - `(no snippets returned)`");
    } else {
      for (const m of matches) {
        const tag = m.type === "text" ? "match" : (m.type || "match");
        lines.push(`     - ${markdownInlineCode(tag)}: ${markdownInlineCode(compactHandoffText(m.snippet))}`);
      }
    }
    lines.push("   - Commands:");
    lines.push(`     - ${markdownInlineCode(`tracequest render ${shellQuote(hash)}`)}`);
    lines.push(`     - ${markdownInlineCode(`tracequest messages ${shellQuote(hash)} --pretty`)}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatSourceColumn(s) {
  const src = s.source || "claude";
  return s.host ? `${src}@${s.host}` : src;
}

/** Emit compact JSON to stdout with a trailing newline (machine-readable output). */
export function emitJson(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

export async function cmdSearch(positionals, values) {
  if (values.help) showHelp();
  const query = positionals.join(" ").trim() || null;
  const usageCommand = values.usageCommand || "search";
  if (!query) {
    const usage = usageCommand === "handoff"
      ? "tracequest handoff <query>\nProvide a search query. Examples:\n  tracequest handoff \"error handling\"\n  tracequest handoff \"deploy\" --sort recent --limit 5"
      : "tracequest search <query>\nProvide a search query. Examples:\n  tracequest search \"parseSession\"\n  tracequest search \"error handling\" --limit 5";
    die(usage);
  }
  const format = values.format || "text";
  if (format !== "text" && format !== "handoff") {
    die(`Invalid search format: ${format}\nSupported formats: text, handoff`);
  }
  const isHandoff = format === "handoff";
  if (!isHandoff && values.sort) {
    die("search --sort is only supported with --format handoff\nUse tracequest handoff <query> --sort recent for Markdown handoffs.");
  }
  const handoffSort = isHandoff ? normalizeHandoffSort(values.sort) : "relevance";
  const asJson = Boolean(values.json) && !isHandoff;
  const status = (isHandoff || asJson) ? console.error : console.log;
  const rawLimit = values.limit ? Number(values.limit) : 20;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
  status(k.dim("Discovering sessions..."));
  const discovered = findSessions(null);
  let sessions = discovered;
  if (!sessions.length) {
    if (isHandoff) {
      process.stdout.write(formatSearchHandoff(query, [], {
        limit,
        entryCommand: values.handoffEntryCommand,
        filter: values.filter || "",
        sort: handoffSort,
      }) + "\n");
      process.exit(0);
    }
    status(k.yellow("No sessions found."));
    if (asJson) emitJson([]);
    process.exit(0);
  }
  if (values.filter) {
    status(k.dim("Filtering sessions..."));
    const { applyExprFilter } = await import("./cli-filter.js");
    sessions = applyExprFilter(sessions, values.filter, "recent");
    if (!sessions.length) {
      if (isHandoff) {
        process.stdout.write(formatSearchHandoff(query, [], {
          limit,
          entryCommand: values.handoffEntryCommand,
          filter: values.filter || "",
          sort: handoffSort,
        }) + "\n");
        process.exit(0);
      }
      status(k.yellow("No sessions match the filter expression."));
      if (asJson) emitJson([]);
      process.exit(0);
    }
  }
  status(k.dim(`Building index for ${sessions.length} sessions...`));
  const isHandoffRecentSort = isHandoff && (handoffSort === "recent" || handoffSort === "date");
  const currentProject = isHandoffRecentSort ? null : currentRepoNames();
  // Exact repeats on an unchanged corpus replay the remembered results (search-perf facts).
  const resultCache = values.filter ? null
    : openSearchResultCache(sessions, { query, limit, format, sort: handoffSort, currentProject });
  let results = resultCache?.hit?.results;
  if (results) {
    process.stderr.write(resultCache.hit.stderr);
  } else {
    const stopCapture = resultCache ? captureStderr() : null;
    const index = values.filter ? buildIndexForFilteredSearch(discovered, sessions) : buildIndex(sessions);
    const rawResults = searchSessions(
      sessions,
      index,
      query,
      limit,
      isHandoffRecentSort
        ? { sort: handoffSort }
        : { rerank: true, currentProject },
    );
    results = isHandoff
      ? sortSearchHandoffResults(rawResults, handoffSort).slice(0, limit)
      : rawResults;
    if (resultCache) resultCache.remember(results, stopCapture(), getSearchIndex()._generation === 1);
  }
  if (isHandoff) {
    process.stdout.write(formatSearchHandoff(query, results, {
      limit,
      entryCommand: values.handoffEntryCommand,
      filter: values.filter || "",
      sort: handoffSort,
    }) + "\n");
    process.exit(0);
  }
  if (asJson) {
    const sizeByPath = new Map(sessions.map((s) => [s.path, s.size]));
    const records = results.map((r) => ({
      date: new Date(r.mtime).toISOString().slice(0, 16).replace("T", " "),
      source: r.source || "claude",
      ...(r.host ? { host: r.host } : {}),
      sessionHash: r.id || r.sessionHash || sessionHash(r.path),
      sizeKB: ((sizeByPath.get(r.path) || 0) / 1024) | 0,
      project: normalizeProjectFolder(r.project),
      path: r.path,
      prompt: r.prompt || "",
      matches: (r.matches || []).map((m) => ({ field: m.type, snippet: m.snippet })),
    }));
    status(k.dim(`Found ${records.length} result${records.length === 1 ? "" : "s"} for "${query}"`));
    emitJson(records);
    process.exit(0);
  }
  if (!results.length) {
    console.log(k.yellow(`No sessions match query: "${query}"`));
    process.exit(0);
  }
  console.log(k.bold(`Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":\n`));
  for (const r of results) {
    const date = new Date(r.mtime).toISOString().slice(0, 16).replace("T", " ");
    const src = formatSourceColumn(r).padEnd(8);
    const proj = normalizeProjectFolder(r.project);
    const prompt = r.prompt ? r.prompt.slice(0, 80).replace(/\n/g, " ") : "";
    console.log(`  ${k.dim(date)}  ${k.cyan(src)}  ${k.bold(r.id || r.sessionHash || sessionHash(r.path))}  ${k.bold(proj.padEnd(24))}  ${k.dim(r.path)}`);
    if (prompt) {
      console.log(`    ${k.dim("prompt:")} ${prompt}${r.prompt.length > 80 ? "..." : ""}`);
    }
    for (const m of r.matches) {
      const tag = m.type === "text" ? "match" : m.type;
      const color = m.type === "error" ? k.red : m.type === "file" ? k.cyan : m.type === "command" ? k.yellow : k.dim;
      console.log(`    ${k.dim(tag + ":")} ${color(m.snippet)}`);
    }
    console.log("");
  }
  process.exit(0);
}

export function cmdHandoff(positionals, values) {
  if (values.help) showHelp();
  return cmdSearch(positionals, {
    ...values,
    format: "handoff",
    handoffEntryCommand: "handoff",
    usageCommand: "handoff",
  });
}
