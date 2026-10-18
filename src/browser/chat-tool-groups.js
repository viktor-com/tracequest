/**
 * Tool-call grouping for the chat transcript (/run, /run?session=).
 *
 * A turn's tool calls read like Cursor's agent chat: consecutive calls of
 * one kind collapse into a single summary row ("Read 4 files", "Ran 3
 * commands", "Edited app.ts +12 −3"), and a click opens the group to one
 * compact line per call, then a call to its full input and output. This file
 * is the data half: classify a call, build the groups, say how a group reads,
 * and decide what is open. The page renders the HTML.
 *
 * Every export is serialized into the page with Function#toString, so each
 * function may call only the others declared here and no module-level names.
 */

/**
 * Which kind of work one tool call is, the same for every agent source.
 * Shell calls (Bash, Codex Exec, Cursor Shell) are always commands: reading
 * the command to call `cat` a read and `rg` a search would split a run of
 * shell calls into one-call groups.
 */
export function toolKind(name) {
  var n = String(name || "").toLowerCase().replace(/[^a-z]/g, "");
  if (/^(read|readfile|view|viewimage|notebookread)$/.test(n)) return "read";
  if (/^(edit|write|multiedit|applypatch|patch|strreplace|strreplaceeditor|notebookedit|createfile|deletefile)$/.test(n)) return "edit";
  if (/^(grep|glob|rg|search|searchtool|semanticsearch|codebasesearch|toolsearch|find|findfiles)$/.test(n)) return "search";
  if (/^(websearch|webfetch|fetch|fetchurl|browse)$/.test(n)) return "web";
  if (/^(sleep|wait|awaitshell|monitor)$/.test(n)) return "wait";
  if (/^(agent|task|spawnagent|sendmessage|followuptask|waitagent|listagents|closeagent|taskstop)$/.test(n)) return "agent";
  if (/^(bash|exec|execcommand|shell|run|runcommand|terminal|command|writestdin|bashoutput|killshell)$/.test(n)) return "command";
  return "other";
}

/** One field of a call's input: the input itself when it is a plain string, else the first named key of its JSON. */
export function inputField(input, keys) {
  var s = String(input == null ? "" : input).trim();
  if (s.charAt(0) !== "{") return s;
  try {
    var o = JSON.parse(s);
    for (var i = 0; i < keys.length; i++) {
      if (typeof o[keys[i]] === "string" && o[keys[i]]) return o[keys[i]];
    }
  } catch (e) { /* truncated JSON: fall back to the raw text */ }
  return s;
}

/** The files and +/- line counts of an apply_patch body ("*** Begin Patch ... *** Update File: x"); null for anything else. */
export function patchSummary(input) {
  var text = String(input == null ? "" : input);
  if (!/^\*\*\* Begin Patch/m.test(text)) return null;
  var files = [];
  var added = 0;
  var removed = 0;
  var lines = text.split("\n");
  for (var i = 0; i < lines.length; i++) {
    var m = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/.exec(lines[i]);
    if (m) files.push(m[1].trim());
    else if (lines[i].charAt(0) === "+") added++;
    else if (lines[i].charAt(0) === "-") removed++;
  }
  return { files: files, added: added, removed: removed };
}

/** The part of a call a reader scans for: the file, the command head, the pattern, the host. */
export function toolTarget(tc, kind, rel) {
  var input = String(tc.input == null ? "" : tc.input).trim();
  var n = String(tc.name || "").toLowerCase().replace(/[^a-z]/g, "");
  var relPath = rel || function (p) { return p; };
  var m;
  var s;
  if (kind === "read" || kind === "edit") {
    var patch = kind === "edit" ? patchSummary(input) : null;
    if (patch) return patch.files.length ? relPath(patch.files[0]) + (patch.files.length > 1 ? " and " + (patch.files.length - 1) + " more" : "") : "patch";
    s = inputField(input, ["file_path", "path", "target_file", "filePath"]);
    return relPath(s.replace(/^["']|["']$/g, ""));
  }
  if (kind === "command") {
    s = inputField(input, ["command", "cmd"]);
    m = /cmd\s*:\s*"((?:[^"\\]|\\.)*)/.exec(s);
    if (n === "exec" && m) s = m[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
    s = s.split("\n").filter(function (l) { return l.trim(); })[0] || "";
    return s.replace(/\s+/g, " ").trim();
  }
  if (kind === "search") {
    s = inputField(input, ["pattern", "query", "regex", "glob_pattern", "path"]);
    return s.split(/\s+/)[0] || s;
  }
  if (kind === "web") {
    s = inputField(input, ["url", "query"]);
    m = /^https?:\/\/([^/\s]+)(\/\S*)?/.exec(s);
    return m ? m[1] + (m[2] && m[2] !== "/" ? m[2] : "") : s;
  }
  if (kind === "wait") {
    var o = {};
    try { o = JSON.parse(input) || {}; } catch (e) { /* plain or truncated input */ }
    var ms = Number(o.duration_ms != null ? o.duration_ms : o.ms);
    if (ms > 0) return ms >= 1000 ? Math.round(ms / 1000) + "s" : ms + "ms";
    var secs = Number(o.seconds != null ? o.seconds : o.duration);
    return secs > 0 ? secs + "s" : "";
  }
  if (kind === "agent") {
    if (tc.agentInfo && tc.agentInfo.description) return tc.agentInfo.description;
    return inputField(input, ["description", "message", "target", "prompt"]).slice(0, 120);
  }
  var mcp = /^mcp__(.+?)__(.+)$/.exec(String(tc.name || ""));
  if (mcp) return mcp[1].replace(/_/g, " ") + " · " + mcp[2].replace(/_/g, " ");
  return input.split("\n")[0].slice(0, 120);
}

/** The verb that leads a single call's row and, with a count, its group's summary. */
export function toolVerb(tc, kind) {
  var n = String(tc.name || "").toLowerCase().replace(/[^a-z]/g, "");
  if (kind === "read") return "Read";
  if (kind === "edit") return n === "write" || n === "createfile" ? "Wrote" : n === "deletefile" ? "Deleted" : "Edited";
  if (kind === "command") return "Ran";
  if (kind === "search") return "Searched";
  if (kind === "web") return n === "websearch" ? "Searched the web" : "Fetched";
  if (kind === "wait") return "Waited";
  if (kind === "agent") return n === "agent" || n === "task" || n === "spawnagent" ? "Subagent" : n === "sendmessage" || n === "followuptask" ? "Messaged" : "Checked agents";
  return String(tc.name || "tool").replace(/^mcp__.+?__/, "").replace(/_/g, " ");
}

/** Added and removed line counts of an edit, from the parser's diffInfo. */
export function diffCounts(tc) {
  var di = tc.diffInfo || {};
  var count = function (s) { return s ? String(s).replace(/\n$/, "").split("\n").length : 0; };
  var patch = tc.diffInfo ? null : patchSummary(tc.input);
  if (patch) return { added: patch.added, removed: patch.removed };
  if (String(tc.name || "").toLowerCase() === "write") return { added: count(di.content || di.newStr), removed: 0 };
  return { added: count(di.newStr || di.content), removed: count(di.oldStr) };
}

/** One tool block as the row the page draws: what it did, to what, and how it ended. */
export function toolRow(block, rel) {
  var tc = block.tc;
  var kind = toolKind(tc.name);
  var res = block.res || null;
  var d = kind === "edit" ? diffCounts(tc) : { added: 0, removed: 0 };
  var error = !!(res && res.isError);
  return {
    kind: kind,
    verb: toolVerb(tc, kind),
    target: toolTarget(tc, kind, rel),
    name: tc.name || "",
    input: String(tc.input == null ? "" : tc.input),
    output: res && res.text ? String(res.text) : "",
    error: error,
    running: !!block.running,
    done: !!res && !error,
    added: d.added,
    removed: d.removed,
  };
}

/**
 * Splits a block list into plain blocks and tool groups. A group is a run of
 * tool blocks of one kind; a user or assistant message, an error note, or a
 * call of another kind ends it. A thought between two calls of the same kind
 * stays inside the group (models think before every call, and that alone
 * would shatter a run of reads into one-call groups).
 *
 * @returns {Array<{ type: "block", block: object, index: number } |
 *   { type: "group", kind: string, key: string, eventIndex: (number|undefined),
 *     items: Array<{ type: "row"|"thought", block: object, index: number, row?: object, key: string }>,
 *     rows: object[], failed: number, running: boolean }>}
 */
export function groupToolBlocks(blocks, rel) {
  var out = [];
  var group = null;
  var keyOf = function (b, i) { return b.kind === "tool" && b.tc && b.tc.id ? "tool:" + b.tc.id : b.kind + ":" + i; };
  var close = function () { group = null; };
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i];
    if (b.kind === "tool") {
      var row = toolRow(b, rel);
      if (!group || group.kind !== row.kind) {
        group = { type: "group", kind: row.kind, key: "group:" + keyOf(b, i), eventIndex: b.eventIndex, items: [], rows: [], failed: 0, running: false };
        out.push(group);
      }
      group.items.push({ type: "row", block: b, index: i, row: row, key: keyOf(b, i) });
      group.rows.push(row);
      if (row.error) group.failed++;
      if (row.running) group.running = true;
    } else if (b.kind === "thought" && group) {
      var j = i;
      while (j < blocks.length && blocks[j].kind === "thought") j++;
      var next = blocks[j];
      if (next && next.kind === "tool" && toolKind(next.tc.name) === group.kind) {
        for (; i < j; i++) group.items.push({ type: "thought", block: blocks[i], index: i, key: keyOf(blocks[i], i) });
        i = j - 1;
      } else {
        close();
        out.push({ type: "block", block: b, index: i });
      }
    } else {
      close();
      out.push({ type: "block", block: b, index: i });
    }
  }
  return out;
}

/** The last path segment. */
export function baseName(p) {
  var parts = String(p).split("/");
  return parts[parts.length - 1] || p;
}

/** The group's one-line summary: "Read 4 files", "Ran 3 commands", "Edited app.ts +12 −3", "Searched 'foo'". */
export function groupSummary(group) {
  var rows = group.rows;
  var n = rows.length;
  var first = rows[0];
  var distinct = function (key) {
    var seen = {};
    var c = 0;
    for (var i = 0; i < rows.length; i++) {
      if (!seen[rows[i][key]]) { seen[rows[i][key]] = 1; c++; }
    }
    return c;
  };
  var added = 0;
  var removed = 0;
  var i;
  if (group.kind === "read") {
    return n === 1 ? "Read " + baseName(first.target) : "Read " + distinct("target") + " files";
  }
  if (group.kind === "command") {
    return n === 1 ? "Ran " + first.target : "Ran " + n + " commands";
  }
  if (group.kind === "edit") {
    for (i = 0; i < n; i++) { added += rows[i].added; removed += rows[i].removed; }
    var stat = (added || removed) ? " +" + added + " −" + removed : "";
    var verb = first.verb;
    for (i = 1; i < n; i++) if (rows[i].verb !== verb) verb = "Edited";
    return (distinct("target") === 1 ? verb + " " + baseName(first.target) : verb + " " + distinct("target") + " files") + stat;
  }
  if (group.kind === "search") {
    return n === 1 ? "Searched ‘" + first.target + "’" : "Searched " + n + " patterns";
  }
  if (group.kind === "web") {
    var allSearch = true;
    for (i = 0; i < n; i++) if (rows[i].verb !== "Searched the web") allSearch = false;
    if (n === 1) return first.target ? first.verb + " " + (allSearch ? "for ‘" + first.target + "’" : first.target) : first.verb;
    return allSearch ? "Searched the web " + n + " times" : "Browsed " + n + " pages";
  }
  if (group.kind === "wait") {
    return n === 1 ? (first.target ? "Waited " + first.target : "Waited") : "Waited " + n + " times";
  }
  if (group.kind === "agent") {
    return n === 1 ? first.verb + (first.target ? ": " + first.target : "") : "Ran " + n + " agent calls";
  }
  return n === 1 ? first.verb : "Used " + n + " tools";
}

/** The muted line after the summary: the first few targets of a multi-call group. */
export function groupDetail(group) {
  var rows = group.rows;
  if (rows.length < 2 || group.kind === "wait") return "";
  var seen = {};
  var names = [];
  for (var i = 0; i < rows.length; i++) {
    var t = group.kind === "read" || group.kind === "edit" ? baseName(rows[i].target) : rows[i].target;
    if (t && !seen[t]) { seen[t] = 1; names.push(t); }
  }
  var shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? shown + ", +" + (names.length - 3) : shown;
}

/** Whether a text holds the find query (case-insensitive). An empty query matches nothing. */
export function textMatches(text, query) {
  var q = String(query || "").toLowerCase();
  return !!q && String(text).toLowerCase().indexOf(q) >= 0;
}

/** Whether a row's text holds the find query. */
export function rowMatches(row, query) {
  if (!query) return false;
  return textMatches(row.target + "\n" + row.input + "\n" + row.output, query);
}

/**
 * Whether a group, a row or a thought is open. The reader's own click wins;
 * then a find hit or a deep link, which open what they point at even under
 * Collapse all; then Expand all / Collapse all; then the default, where only
 * what holds a failure is open so collapsing never hides one.
 *
 * @param {string} key
 * @param {{ mode: "auto"|"all"|"none", overrides: Object<string, boolean>, forced: Object<string, boolean> }} st
 * @param {boolean} hit    a find hit sits in it
 * @param {boolean} failed a failed call sits in it
 */
export function isOpen(key, st, hit, failed) {
  if (Object.prototype.hasOwnProperty.call(st.overrides, key)) return !!st.overrides[key];
  if (hit || (st.forced && st.forced[key])) return true;
  if (st.mode === "all") return true;
  if (st.mode === "none") return false;
  return !!failed;
}

/** A #tool-<id> or #event-<n> hash as { tool } or { event }; null for anything else. */
export function parseDeepLink(hash) {
  var m = /^#?tool-(.+)$/.exec(String(hash || ""));
  if (m) {
    try { return { tool: decodeURIComponent(m[1]) }; } catch (e) { return null; }
  }
  m = /^#?event-(\d+)$/.exec(String(hash || ""));
  if (m) return { event: Number(m[1]) };
  return null;
}

/** The keys a deep link opens: the group and the row (or thought) it points at. Empty when the link names nothing in this transcript. */
export function deepLinkKeys(entries, link) {
  var keys = {};
  if (!link) return keys;
  for (var i = 0; i < entries.length; i++) {
    var g = entries[i];
    if (g.type !== "group") continue;
    for (var j = 0; j < g.items.length; j++) {
      var it = g.items[j];
      var hitTool = link.tool != null && it.block.tc && it.block.tc.id === link.tool;
      var hitEvent = link.event != null && it.block.eventIndex === link.event;
      if (hitTool || hitEvent) {
        keys[g.key] = true;
        keys[it.key] = true;
      }
    }
  }
  return keys;
}

/** The first `max` lines of a text and how many were left out. */
export function outputPreview(text, max) {
  var s = String(text).replace(/\n$/, "");
  var end = -1;
  for (var i = 0; i < max; i++) {
    end = s.indexOf("\n", end + 1);
    if (end < 0) return { text: s, hidden: 0 };
  }
  return { text: s.slice(0, end), hidden: s.slice(end + 1).split("\n").length };
}

/** The group's rendering of the page's open state: which of its rows and thoughts are open. */
export function groupOpenState(group, st, query) {
  var hits = {};
  var hit = false;
  var open = {};
  for (var i = 0; i < group.items.length; i++) {
    var it = group.items[i];
    if (it.type === "row") {
      hits[it.key] = rowMatches(it.row, query);
      if (hits[it.key]) hit = true;
      open[it.key] = isOpen(it.key, st, hits[it.key], it.row.error);
    } else {
      var thoughtHit = textMatches(it.block.text || "", query);
      if (thoughtHit) hit = true;
      open[it.key] = isOpen(it.key, st, thoughtHit, false);
    }
  }
  return { group: isOpen(group.key, st, hit, group.failed > 0), items: open, hit: hit };
}
