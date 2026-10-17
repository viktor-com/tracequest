import test from "node:test";
import assert from "node:assert/strict";
import {
  toolKind,
  toolRow,
  groupToolBlocks,
  groupSummary,
  groupDetail,
  groupOpenState,
  isOpen,
  rowMatches,
  parseDeepLink,
  deepLinkKeys,
  outputPreview,
  patchSummary,
} from "../../src/browser/chat-tool-groups.js";

const tool = (name, input, res, extra = {}) => ({ kind: "tool", tc: { id: `id-${name}-${String(input).length}-${Math.random()}`, name, input, ...extra.tc }, res: res || null, eventIndex: extra.eventIndex, running: extra.running });
const text = (t) => ({ kind: "text", text: t });
const user = (t) => ({ kind: "user", text: t });
const thought = (t) => ({ kind: "thought", text: t });
const ok = (t = "fine") => ({ isError: false, text: t });
const bad = (t = "boom") => ({ isError: true, text: t });
const summaries = (blocks) => groupToolBlocks(blocks).filter((e) => e.type === "group").map(groupSummary);
const closed = { mode: "auto", overrides: {}, forced: {} };

test("every source's tool names map to the same kinds, and shell calls are always commands", () => {
  const cases = {
    read: [["Read", "/a.js"], ["ReadFile", "a.js"], ["View", "a.js"]],
    edit: [["Edit", "a.js"], ["Write", "a.js"], ["MultiEdit", "a.js"], ["ApplyPatch", "x"]],
    search: [["Grep", "foo src"], ["Glob", "**/*.js"], ["Rg", "foo"], ["Search_tool", "q"]],
    command: [["Bash", "npm test"], ["Exec", 'text(await tools.exec_command({cmd:"npm test"'], ["Shell", "git status"], ["Bash", "cat a | wc -l"], ["Bash", "rg -n foo src"], ["Bash", "cat src/a.js"]],
    wait: [["Sleep", '{"duration_ms":40000}'], ["Wait", "{}"], ["AwaitShell", "{}"]],
    agent: [["Agent", "map the repo"], ["Spawn_agent", "{}"], ["Send_message", "{}"], ["Wait_agent", "{}"], ["List_agents", "{}"]],
    web: [["WebFetch", "https://a.dev/x"], ["WebSearch", "q"]],
    other: [["TodoWrite", "[]"], ["Skill", "x"], ["Use_tool", "{}"], ["mcp__srv__do_it", "{}"]],
  };
  for (const [kind, calls] of Object.entries(cases)) {
    for (const [name, input] of calls) assert.equal(toolKind(name), kind, `${name} ${input}`);
  }
});

test("consecutive calls of one kind group into one summary row", () => {
  const blocks = [
    tool("Read", "/r/a.js", ok()), tool("Read", "/r/b.js", ok()), tool("Read", "/r/c.js", ok()), tool("Read", "/r/d.js", ok()),
    tool("Bash", "npm test", ok()), tool("Bash", "npm run lint", ok()), tool("Bash", "git status", ok()),
  ];
  const groups = groupToolBlocks(blocks);
  assert.deepEqual(groups.map((g) => [g.type, g.kind, g.rows.length]), [["group", "read", 4], ["group", "command", 3]]);
  assert.deepEqual(summaries(blocks), ["Read 4 files", "Ran 3 commands"]);
});

test("a lone call reads as that call", () => {
  assert.deepEqual(summaries([tool("Read", "/r/src/app.js")]), ["Read app.js"]);
  assert.deepEqual(summaries([tool("Bash", "npm   test  --silent")]), ["Ran npm test --silent"]);
  assert.deepEqual(summaries([tool("Grep", "foo src")]), ["Searched ‘foo’"]);
});

test("edits sum their +/- lines and name the file", () => {
  const edit = (path, o, n) => tool("Edit", path, ok(), { tc: { diffInfo: { oldStr: o, newStr: n } } });
  assert.deepEqual(summaries([edit("/r/app.ts", "a\nb\nc", "a\nb\nc\nd\ne\nf\ng")]), ["Edited app.ts +7 −3"]);
  assert.deepEqual(summaries([edit("/r/a.ts", "x", "y\nz"), edit("/r/b.ts", "", "q")]), ["Edited 2 files +3 −1"]);
  assert.deepEqual(summaries([tool("Write", "/r/new.js", ok(), { tc: { diffInfo: { content: "1\n2\n3" } } })]), ["Wrote new.js +3 −0"]);
});

test("search and web groups count their calls", () => {
  assert.deepEqual(summaries([tool("Grep", "a"), tool("Glob", "*.js"), tool("Rg", "b")]), ["Searched 3 patterns"]);
  assert.deepEqual(summaries([tool("WebFetch", "https://example.com/docs")]), ["Fetched example.com/docs"]);
  assert.deepEqual(summaries([tool("WebSearch", "agents")]), ["Searched the web for ‘agents’"]);
  assert.deepEqual(summaries([tool("WebFetch", "https://a.dev"), tool("WebSearch", "x")]), ["Browsed 2 pages"]);
  assert.deepEqual(summaries([tool("Sleep", "{}"), tool("Sleep", "{}")]), ["Waited 2 times"]);
});

test("a Codex Exec wrapper shows the command it runs", () => {
  const row = toolRow(tool("Exec", 'text(await tools.exec_command({cmd:"cat /r/a.txt && ls",\\"max_output_tokens\\"'));
  assert.equal(row.kind, "command");
  assert.equal(row.target, "cat /r/a.txt && ls");
});

test("a failed call is flagged on its row and its group", () => {
  const blocks = [tool("Read", "/r/a.js", ok()), tool("Read", "/r/missing.js", bad("ENOENT")), tool("Read", "/r/c.js", ok())];
  const [g] = groupToolBlocks(blocks);
  assert.equal(g.failed, 1);
  assert.deepEqual(g.rows.map((r) => r.error), [false, true, false]);
  assert.equal(g.rows[1].output, "ENOENT");
});

test("a running call flags its group", () => {
  const [g] = groupToolBlocks([tool("Bash", "sleep 9", null, { running: true })]);
  assert.equal(g.running, true);
  assert.equal(g.rows[0].done, false);
});

test("a text message breaks a group", () => {
  const blocks = [tool("Read", "/r/a.js"), text("Now the second file."), tool("Read", "/r/b.js")];
  const entries = groupToolBlocks(blocks);
  assert.deepEqual(entries.map((e) => e.type === "group" ? e.kind : e.block.kind), ["read", "text", "read"]);
  assert.deepEqual(summaries(blocks), ["Read a.js", "Read b.js"]);
});

test("a user message breaks a group, and so does a call of another kind", () => {
  assert.equal(groupToolBlocks([tool("Read", "/a"), user("hm"), tool("Read", "/b")]).filter((e) => e.type === "group").length, 2);
  assert.deepEqual(summaries([tool("Read", "/a"), tool("Bash", "ls"), tool("Read", "/b")]), ["Read a", "Ran ls", "Read b"]);
});

test("a thought between calls of the same kind stays in the group, otherwise it stands alone", () => {
  const inside = groupToolBlocks([tool("Read", "/a"), thought("hmm"), tool("Read", "/b")]);
  assert.equal(inside.length, 1);
  assert.deepEqual(inside[0].items.map((i) => i.type), ["row", "thought", "row"]);
  const across = groupToolBlocks([tool("Read", "/a"), thought("hmm"), tool("Bash", "ls")]);
  assert.deepEqual(across.map((e) => e.type === "group" ? e.kind : e.block.kind), ["read", "thought", "command"]);
});

test("a group's key is its first call's, so a growing group keeps its identity", () => {
  const a = tool("Read", "/a");
  const b = tool("Read", "/b");
  const before = groupToolBlocks([a])[0].key;
  assert.equal(groupToolBlocks([a, b])[0].key, before);
});

test("the detail line lists the first targets", () => {
  const [g] = groupToolBlocks(["a", "b", "c", "d", "e"].map((n) => tool("Read", `/r/${n}.js`)));
  assert.equal(groupDetail(g), "a.js, b.js, c.js, +2");
  assert.equal(groupDetail(groupToolBlocks([tool("Read", "/a")])[0]), "");
});

test("a group is open by default only when it holds a failure", () => {
  const [clean] = groupToolBlocks([tool("Read", "/a", ok())]);
  const [failing] = groupToolBlocks([tool("Read", "/a", ok()), tool("Read", "/b", bad())]);
  assert.equal(groupOpenState(clean, closed, "").group, false);
  const state = groupOpenState(failing, closed, "");
  assert.equal(state.group, true);
  assert.deepEqual(failing.items.map((i) => state.items[i.key]), [false, true]);
});

test("Expand all and Collapse all override the default, and a reader's own click beats both", () => {
  const [g] = groupToolBlocks([tool("Read", "/a", ok()), tool("Read", "/b", bad())]);
  const rowKey = g.items[0].key;
  assert.equal(groupOpenState(g, { ...closed, mode: "all" }, "").items[rowKey], true);
  const none = groupOpenState(g, { ...closed, mode: "none" }, "");
  assert.equal(none.group, false, "Collapse all closes even a failing group");
  assert.equal(none.items[g.items[1].key], false);
  assert.equal(groupOpenState(g, { mode: "all", overrides: { [rowKey]: false }, forced: {} }, "").items[rowKey], false);
  assert.equal(isOpen("k", { mode: "none", overrides: { k: true }, forced: {} }, false, false), true);
});

test("a search hit opens its row and its group, even under Collapse all", () => {
  const [g] = groupToolBlocks([tool("Bash", "npm test", ok("3 passing")), tool("Bash", "git status", ok("On branch needle-fix"))]);
  assert.equal(rowMatches(g.rows[1], "NEEDLE"), true);
  assert.equal(rowMatches(g.rows[0], "needle"), false);
  const state = groupOpenState(g, { ...closed, mode: "none" }, "needle");
  assert.equal(state.group, true);
  assert.deepEqual(g.items.map((i) => state.items[i.key]), [false, true]);
  assert.equal(groupOpenState(g, { ...closed, mode: "none" }, "").group, false, "no query, no hit");
  assert.equal(rowMatches(g.rows[0], ""), false, "an empty query matches nothing");
});

test("a search hit in a thought opens that thought and its group", () => {
  const [g] = groupToolBlocks([tool("Read", "/a"), thought("the cache key is wrong"), tool("Read", "/b")]);
  const state = groupOpenState(g, { ...closed, mode: "none" }, "cache key");
  assert.equal(state.group, true);
  assert.equal(state.items[g.items[1].key], true);
});

test("deep links name a tool call or an event and open its group and row", () => {
  assert.deepEqual(parseDeepLink("#tool-toolu_01"), { tool: "toolu_01" });
  assert.deepEqual(parseDeepLink("#event-42"), { event: 42 });
  assert.equal(parseDeepLink("#chapter-3"), null);
  const a = tool("Read", "/a", ok(), { eventIndex: 4 });
  const b = tool("Read", "/b", ok(), { eventIndex: 5 });
  const entries = groupToolBlocks([a, b]);
  const keys = deepLinkKeys(entries, { tool: b.tc.id });
  assert.deepEqual(Object.keys(keys).sort(), [entries[0].key, `tool:${b.tc.id}`].sort());
  assert.deepEqual(Object.keys(deepLinkKeys(entries, { event: 4 })).sort(), [entries[0].key, `tool:${a.tc.id}`].sort());
  assert.deepEqual(deepLinkKeys(entries, { tool: "nope" }), {});
  const forcedOpen = groupOpenState(entries[0], { ...closed, mode: "none", forced: keys }, "");
  assert.equal(forcedOpen.group, true);
  assert.deepEqual(entries[0].items.map((i) => forcedOpen.items[i.key]), [false, true]);
});

test("long output is cut at the preview limit and says how much is left", () => {
  const long = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  assert.deepEqual(outputPreview(long, 12), { text: long.split("\n").slice(0, 12).join("\n"), hidden: 18 });
  assert.deepEqual(outputPreview("a\nb\n", 12), { text: "a\nb", hidden: 0 });
});

test("an apply_patch call names its files and counts its lines", () => {
  const patch = "*** Begin Patch\n*** Update File: /r/src/a.js\n@@\n-old\n+new\n+newer\n*** Add File: /r/src/b.js\n+x\n*** End Patch";
  assert.deepEqual(patchSummary(patch), { files: ["/r/src/a.js", "/r/src/b.js"], added: 3, removed: 1 });
  assert.equal(patchSummary("just text"), null);
  assert.deepEqual(summaries([tool("Apply_patch", patch)]), ["Edited a.js and 1 more +3 \u22121"]);
  assert.equal(toolRow(tool("Apply_patch", patch), (p) => p.replace("/r/", "")).target, "src/a.js and 1 more");
});

test("a malformed #tool- link is ignored, not thrown", () => {
  assert.equal(parseDeepLink("#tool-%E0%A4%A"), null);
});

test("a sleep names its duration from the fields it has, never from stray digits", () => {
  const wait = (input) => toolRow(tool("Sleep", input)).target;
  assert.equal(wait('{"duration_ms":40000}'), "40s");
  assert.equal(wait('{"duration_ms":500}'), "500ms");
  assert.equal(wait('{"seconds":5}'), "5s");
  assert.equal(wait('{"id":"x7"}'), "");
});
