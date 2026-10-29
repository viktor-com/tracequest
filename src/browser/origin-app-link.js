/**
 * "Open in <App>": a link that opens a session in its native app on this
 * machine, or null. Only sessions recorded on the machine the hub runs on
 * (no host) qualify, and only for apps that register a per-session link.
 * Inlined into page scripts with toString(), so it stays self-contained.
 *
 * - Codex: codex://threads/<thread id>, the id at the end of the rollout
 *   file name (the Codex desktop app).
 * - Claude Code: claude://resume?session=<session id>, the transcript's
 *   file name, which is what `claude --desktop --resume <id>` opens in
 *   Claude Desktop. Desktop does not take over a session that is still
 *   running, so a live one gets no link.
 * Cursor, Factory, Grok, vktr, fx, DeepSeek Harness, OpenCode and Kandev
 * register no link to an existing session.
 *
 * @param {{ source?: string, path?: string, host?: string, live?: boolean }} s session row
 * @returns {{ app: string, href: string } | null}
 */
export function originAppLink(s) {
  if (!s || s.host) return null;
  var path = s.path || "";
  var uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  if (s.source === "codex") {
    var thread = new RegExp("/rollout-[^/]*?(" + uuid + ")\\.jsonl$", "i").exec(path);
    if (thread) return { app: "Codex", href: "codex://threads/" + thread[1].toLowerCase() };
  }
  if (s.source === "claude" && !s.live) {
    var session = new RegExp("/\\.claude/projects/[^/]+/(" + uuid + ")\\.jsonl$", "i").exec(path);
    if (session) return { app: "Claude", href: "claude://resume?session=" + session[1].toLowerCase() };
  }
  return null;
}

/** Point anchor `a` at `link` ("Open in <App>"), or hide it when there is none. */
export function showOriginAppLink(a, link) {
  if (!a) return;
  a.hidden = !link;
  if (!link) {
    a.removeAttribute("href");
    return;
  }
  a.href = link.href;
  a.textContent = "Open in " + link.app;
  a.title = "Open this session in the " + link.app + " app on this machine";
}

/** Both helpers, for inlining into a page script. */
export const ORIGIN_APP_LINK_JS = [originAppLink, showOriginAppLink]
  .map((fn) => fn.toString().replace(/^export /, ""))
  .join("\n");
