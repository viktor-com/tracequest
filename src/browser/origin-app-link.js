/**
 * "Open in <App>": the per-session deep link of the app a session came from,
 * or null when that app has no link to one session. Inlined into page
 * scripts with toString(), so it stays self-contained.
 *
 * - Kandev: a session run in a Kandev task folder
 *   (.kandev/tasks/<workspace id>/<task id>) opens /t/<task id> on the Kandev
 *   of the machine that recorded it, on Kandev's default port 38429.
 * - Codex: the desktop app's codex://threads/<thread id>. The app opens the
 *   thread on the clicking machine, so only sessions recorded on this
 *   machine (no host) get it.
 * - Cursor Cloud Agents: https://cursor.com/agents/<agent id>.
 * Claude Code, Cursor, Factory, Grok, vktr, fx, DeepSeek Harness and OpenCode
 * offer no link to an existing session.
 *
 * @param {{ source?: string, path?: string, host?: string }} s session row
 * @param {{ hostname?: string, hosts?: Record<string, string> }} [where]
 *   hostname: the address this page was served from (sessions recorded
 *   here); hosts: imported host id -> that machine's address.
 * @returns {{ app: string, href: string } | null}
 */
export function originAppLink(s, where) {
  var path = (s && s.path) || "";
  var source = (s && s.source) || "";
  var host = (s && s.host) || "";
  var at = where || {};
  var uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  var sep = "(?:/|-|%2F)";
  // Raw cwd, Claude's dashed slug or Grok's percent-encoded cwd.
  var kandev = new RegExp("kandev" + sep + "tasks" + sep + uuid + sep + "(" + uuid + ")(?![0-9a-f])", "i").exec(path);
  var addr = host ? (at.hosts && at.hosts[host]) || "" : at.hostname || "";
  if (kandev && addr) {
    if (addr.indexOf(":") !== -1 && addr.charAt(0) !== "[") addr = "[" + addr + "]";
    return { app: "Kandev", href: "http://" + addr + ":38429/t/" + kandev[1].toLowerCase() };
  }
  if (source === "codex" && !host) {
    var thread = new RegExp("rollout-[^/]*?(" + uuid + ")\\.jsonl$", "i").exec(path);
    if (thread) return { app: "Codex", href: "codex://threads/" + thread[1].toLowerCase() };
  }
  if (source === "cursor-cloud") {
    var agent = /(?:^|\/)(bc-[A-Za-z0-9-]+)\.jsonl$/.exec(path);
    if (agent) return { app: "Cursor", href: "https://cursor.com/agents/" + agent[1] };
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
  a.title = "Open this session in " + link.app;
  // App schemes hand off to the OS; web apps open beside the hub.
  if (/^https?:/.test(link.href)) {
    a.target = "_blank";
    a.rel = "noopener";
  } else {
    a.removeAttribute("target");
    a.removeAttribute("rel");
  }
}

/** Both helpers, for inlining into a page script. */
export const ORIGIN_APP_LINK_JS = [originAppLink, showOriginAppLink]
  .map((fn) => fn.toString().replace(/^export /, ""))
  .join("\n");
