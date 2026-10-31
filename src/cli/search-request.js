/**
 * The request a valid search/handoff invocation makes, computed without
 * loading the search modules, so a search answered by the resident search
 * process (search-daemon facts) starts in a few ms. Anything unusual (help,
 * --filter, an invalid option) is left to cmdSearch, which reports it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, basename, dirname, join } from "node:path";
import { isColorEnabled } from "./cli-color.js";
import { askSearchDaemon } from "./search-daemon.js";

/**
 * Names of the git repository enclosing the cwd (not a dotfiles repo at HOME), or null: its origin
 * remote's name, so a worktree in a differently named folder still names its repository, and its folder.
 */
export function currentRepoNames() {
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

/**
 * { query, limit, isHandoff, asJson, handoffSort, filter, entryCommand } of a
 * search/handoff invocation, or null when cmdSearch must report a problem.
 */
export function searchRequest(positionals, values) {
  const query = positionals.join(" ").trim() || null;
  const format = values.format || "text";
  if (!query || (format !== "text" && format !== "handoff")) return null;
  const isHandoff = format === "handoff";
  if (!isHandoff && values.sort) return null;
  let handoffSort = "relevance";
  if (isHandoff) {
    const sort = String(values.sort || "relevance").trim().toLowerCase();
    if (sort === "recent" || sort === "date") handoffSort = sort;
    else if (sort && sort !== "relevance" && sort !== "score") return null;
  }
  const asJson = Boolean(values.json) && !isHandoff;
  const rawLimit = values.limit ? Number(values.limit) : 20;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 20;
  return { query, limit, isHandoff, asJson, handoffSort, filter: values.filter || "", entryCommand: values.handoffEntryCommand };
}

export function isHandoffRecentSortOf(p) {
  return p.isHandoff && (p.handoffSort === "recent" || p.handoffSort === "date");
}

/**
 * Print the resident search's answer to a search/handoff invocation and exit;
 * false when it is not one the resident search answers, or none is running.
 */
export async function answerFromSearchDaemon(positionals, values) {
  if (values.help || values.filter) return false;
  const p = searchRequest(positionals, values);
  if (!p) return false;
  const currentProject = isHandoffRecentSortOf(p) ? null : currentRepoNames();
  const answer = await askSearchDaemon({ p, currentProject, color: isColorEnabled() });
  if (!answer) return false;
  process.stdout.write(answer.stdout);
  process.stderr.write(answer.stderr);
  process.exit(0);
}
