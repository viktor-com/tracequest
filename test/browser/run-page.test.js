/**
 * /run watch page structure tests — assertions on the server-generated HTML
 * string (no browser): the chat transcript surface (session polling with the
 * etag flow, user/assistant/tool-card renderers, grouping, streaming and
 * pending/exited states, sticky scroll), the collapsed raw-terminal block
 * (~600ms snapshot polling, ansi palette CSS), kill wiring, back link,
 * metadata escaping, and route registration. Fact anchors: lawp, lalv
 * (launch-s4) and the chat-ui facts (cuts, cutl, cusp, cusc).
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { liveSessionPage, runPage, RUN_POLL_MS, SESSION_POLL_MS } from "../../src/browser/run-page.js";
import { ansiPaletteCss } from "../../src/render/ansi-html.js";
import { ROUTE_MAP } from "../../src/routes.js";
import { handleRun } from "../../src/routes/route-handlers-pages.js";
import { assertChatRailLiveCount, renderChatRail } from "../helpers/render-rail-vm.js";
import { paintLaunchedRunIdentity } from "../helpers/render-run-identity-vm.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { paintWatchIdentityAfterPoll } from "../helpers/render-watch-identity-vm.js";

const RUN = {
  id: "@3",
  agent: "claude",
  cwd: "/home/dev/project",
  startedAt: "2026-08-10T12:00:00.000Z",
  status: "running",
};

function html(overrides = {}) {
  return runPage({ run: { ...RUN, ...overrides } });
}

describe("run page — document shell and header", () => {
  test("run page header is the record's LIST identity row (state badge, source pill, id) with a back link", () => {
    const page = html();
    assert.match(page, /^<!DOCTYPE html>/);
    assert.match(page, /<title>tracequest — run @3<\/title>/);
    // The exact chips the dashboard list card wears, same classes verbatim.
    assert.ok(page.includes('<span class="run-state-badge" id="runStatus" data-status="running">running</span>'));
    assert.match(page, /<span class="session-source" style="background:#a78bfa">claude<\/span>/);
    assert.ok(page.includes('<span class="session-id" id="chatSessionId" title="run @3">@3</span>'));
    assert.ok(page.includes('<span class="session-model" id="chatModel" hidden></span>'));
    assert.ok(page.includes("started 2026-08-10T12:00:00.000Z"));
    assert.match(page, /<a class="run-back" href="\/sessions">&larr; sessions<\/a>/);
    assert.ok(!page.includes('href="/launch"'), "no stray /launch navigation");
  });

  test("run page cross-links the linked recording via the view session header link", () => {
    const page = html();
    // Hidden until the session poll reports a linked recording (fact cixl).
    assert.match(page, /<a class="run-view-link" id="viewSessionLink"[^>]* hidden>view session<\/a>/);
    assert.ok(page.includes('var viewHref = "/view?path=" + encodeURIComponent(data.sessionPath)'));
    assert.ok(page.includes("viewSessionLink.href = viewHref"));
    assert.ok(page.includes("viewSessionLink.hidden = false"));
  });

  test("run metadata is HTML-escaped", () => {
    const page = html({ agent: '<script>"x', cwd: '/tmp/<dir>"quoted' });
    assert.ok(!page.includes('>claude</span><script>'));
    assert.ok(!/<span class="session-source"[^>]*><script>/.test(page));
    assert.ok(page.includes("&lt;script&gt;&quot;x"));
    assert.ok(page.includes('title="/tmp/&lt;dir&gt;&quot;quoted"'));
  });
});

describe("run page — chat transcript surface (chat-ui fact cuts)", () => {
  test("the conversation column is the page: thread + activity inside a dedicated scroller", () => {
    const page = html();
    assert.ok(page.includes('<div class="chat-scroll" id="chatScroll">'));
    assert.ok(page.includes('<div class="chat-thread" id="chatThread">'));
    assert.ok(page.includes('<div class="chat-activity" id="chatActivity">'));
    assert.match(page, /\.chat-scroll\s*{[^}]*overflow-y: auto/);
    assert.match(page, /\.chat-col\s*{[^}]*max-width: 760px/);
  });

  test("client renders user bubbles, assistant markdown prose, and thought markers", () => {
    const page = html();
    assert.ok(page.includes('"chat-user chat-message"'), "user bubble renderer");
    assert.ok(page.includes('"chat-assistant chat-message"'), "assistant prose renderer");
    assert.match(page, /function md\(src\)/, "markdown-lite renderer present");
    assert.match(page, /function mdText\(/, "block-level markdown handling");
    assert.ok(page.includes("chat-thought-toggle"), "thought marker expands thinking text");
    assert.ok(page.includes('"briefly"'), "Thought briefly fallback when no duration");
    assert.match(page, /\.chat-user\s*{[^}]*border-radius: 12px/, "user bubble styling");
  });

  test("all client-rendered session text flows through escHtml before hitting innerHTML", () => {
    const page = html();
    assert.match(page, /function escHtml\(s\)/);
    assert.ok(page.includes('escHtml(b.text)'), "user/thinking text escaped");
    assert.ok(page.includes("inlineMd(escHtml("), "markdown decorates already-escaped text");
  });

  test("session polling uses the etag flow at ~1s cadence", () => {
    const page = html();
    assert.equal(SESSION_POLL_MS, 1000);
    assert.ok(page.includes("var SESSION_POLL_MS = 1000;"));
    assert.ok(page.includes('"/api/runs/session?id=" + encodeURIComponent(runId)'));
    assert.ok(page.includes('"&etag=" + encodeURIComponent(lastEtag)'), "etag repeated on the next poll");
    assert.ok(page.includes("data.unchanged"), "unchanged answer skips re-render");
    assert.ok(page.includes("setTimeout(pollSession, SESSION_POLL_MS)"));
    assert.ok(page.includes('data-chat-polling="0"'), "chat polling flag exposed on body");
  });

  test("thread re-renders only when content changed and sticks to the bottom unless the user scrolled up", () => {
    const page = html();
    assert.match(page, /function isAtBottom\(\)/);
    assert.match(page, /function scrollBottom\(\)/);
    assert.match(page, /function pinLiveTail\(\)/);
    assert.ok(page.includes("threadHtml !== lastThreadHtml"), "no-op renders skipped");
    assert.ok(page.includes("var followTail = true"), "live tail starts following");
    assert.ok(page.includes("var stick = followTail || isAtBottom();"),
      "stickiness uses the follow-tail flag, not a post-chrome sample");
    assert.ok(page.includes("if (stick) frameLiveTrail();"));
    assert.ok(page.includes("followTail = isAtBottom()"), "user scroll away from the tail is remembered");
  });
});

describe("run page — incremental thread apply (chat-ui fact ciin)", () => {
  test("existing message/tool-card nodes are patched by key, not wiped via chatThread.innerHTML", () => {
    const page = html();
    assert.match(page, /function applyThreadItems\(/, "keyed reconciler is embedded");
    assert.ok(page.includes("applyThreadItems(chatThread, items)"), "rerender patches the live thread");
    assert.ok(!page.includes("chatThread.innerHTML = threadHtml"), "full-thread remount is gone");
    assert.ok(page.includes("data-block-key"), "nodes carry a stable key");
    assert.ok(page.includes('data-role'), "nodes carry data-role for identity");
    assert.ok(page.includes('"chat-user chat-message"'));
    assert.ok(page.includes('"chat-assistant chat-message"'));
    assert.ok(page.includes("tool-card"), "tool cards are stampable as .tool-card");
  });
});

describe("run page — stay-loaded live watch (chat-ui fact cisl)", () => {
  test("both watch pages stay loaded: _stayLoaded plus _refreshData kick a session poll, never location.reload", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes("window._stayLoaded = true"), "src-reload SSE must not navigate");
      assert.match(page, /window\._refreshData = function/);
      assert.ok(page.includes("pollSession()"), "data-update reuses the etag poll");
      assert.ok(!/\blocation\.reload\s*\(/.test(page), "page script never reloads the document");
    }
  });
});

describe("run page — tool-call presentation (chat-ui fact cutl)", () => {
  test("tool cards carry a human title plus muted binary names", () => {
    const page = html();
    assert.match(page, /function toolTitle\(tc\)/);
    assert.match(page, /function bashTitle\(cmd\)/);
    assert.match(page, /function bashBins\(cmd\)/);
    assert.ok(page.includes('"Search for "'), "search commands get a human title");
    assert.ok(page.includes('"List "'), "ls gets a human title");
    assert.ok(page.includes('"List workspace root directory"'), "bare ls names the workspace root");
    assert.ok(page.includes('"Find all files under workspace"'), "bare find names the workspace");
    assert.ok(page.includes('"Ripgrep for "'), "rg cards use a verb-object investigation title");
    assert.ok(page.includes("card-bins"), "muted binary names rendered on the card");
    assert.ok(page.includes("card-icon"), "cards carry an icon");
  });

  test("Read renders as a plain tool line, Edit/Write as file cards with +N/-N stats", () => {
    const page = html();
    assert.ok(page.includes('tc.name === "Read"'));
    assert.ok(page.includes("chat-toolline"));
    assert.ok(page.includes('tc.name === "Edit" || tc.name === "Write"'));
    assert.ok(page.includes('class="plus">+'), "added-line count");
    assert.ok(page.includes('class="minus">-'), "removed-line count");
    assert.match(page, /\.chat-card\.file \.plus\s*{[^}]*var\(--green\)/);
    assert.match(page, /\.chat-card\.file \.minus\s*{[^}]*var\(--red\)/);
  });

  test("consecutive search-type tool calls group under an Explored N searches marker", () => {
    const page = html();
    assert.match(page, /function isExplore\(tc\)/);
    assert.ok(page.includes("Explored"), "Explored grouping marker");
    assert.ok(page.includes('n + " searches"'), "count in the Explored marker");
    assert.ok(page.includes("if (n >= 2)"), "grouping only for runs of two or more");
  });

  test("an error tool_result marks its card, and unmatched error results render as error notes", () => {
    const page = html();
    assert.ok(page.includes("card-err"), "error chip on the card");
    assert.match(page, /\.chat-card\.err\s*{[^}]*240,112,112/, "error card border tint");
    assert.ok(page.includes("chat-errnote"), "unmatched error results visible");
  });
});

function loadInvestigationFns() {
  const page = html();
  const start = page.indexOf("function truncate(s, n)");
  const end = page.indexOf("function threadItem(");
  assert.ok(start > 0 && end > start, "investigation helpers are embedded");
  const src = page.slice(start, end);
  const title = new Function("cmd", `var runCwd = ${JSON.stringify(RUN.cwd)};\n${src}\nreturn bashTitle(cmd);`);
  const tool = new Function("tc", `var runCwd = ${JSON.stringify(RUN.cwd)};\n${src}\nreturn toolTitle(tc);`);
  return { title, tool };
}

describe("run page — verb-object investigation titles (chat-ui fact me4)", () => {
  test("live trail Bash/Grep cards name the action plus the object of investigation", () => {
    const { title, tool } = loadInvestigationFns();
    assert.equal(title("ls"), "List workspace root directory");
    assert.equal(title("ls | head"), "List workspace root directory");
    assert.equal(title("ls -la"), "List workspace root directory");
    assert.equal(title("ls src/client"), "List src/client directory");
    assert.equal(title("ls /home/dev/project/.cursor"), "List .cursor directory");
    assert.equal(title("find"), "Find all files under workspace");
    assert.equal(title("find ."), "Find all files under workspace");
    assert.equal(title("find .cursor"), "Find all files under .cursor");
    assert.equal(title("find . -name '*agent*'"), "Find agent files");
    assert.equal(title("find .cursor -name '*agent*'"), "Find agent files under .cursor");
    assert.equal(title("rg leftover"), "Ripgrep for leftover");
    assert.equal(title('rg -n "fetchClient" src | head -20'), "Ripgrep for fetchClient in src");
    assert.equal(title("grep leftover"), "Search for leftover");
    const ls = tool({ name: "Bash", input: "ls | head" });
    assert.equal(ls.title, "List workspace root directory");
    assert.deepEqual(ls.bins, ["ls", "head"]);
    const find = tool({ name: "Bash", input: "find" });
    assert.equal(find.title, "Find all files under workspace");
    assert.deepEqual(find.bins, ["find"]);
    const rg = tool({ name: "Bash", input: "rg leftover" });
    assert.equal(rg.title, "Ripgrep for leftover");
    assert.deepEqual(rg.bins, ["rg"]);
    const grep = tool({ name: "Grep", input: "leftover src" });
    assert.equal(grep.title, "Search for leftover in src");
    assert.ok(!/List directory$/.test(title("ls")), "bare ls is not a generic List directory badge");
    assert.ok(title("find") !== "Find files", "bare find is not a generic Find files badge");
  });
});

describe("run page — full turn bodies (chat-ui fact cuft)", () => {
  test("assistant markdown preserves line breaks and tool_result bodies render in full", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes('para.map(function (ln) { return inlineMd(escHtml(ln)); }).join("<br>")'),
        "assistant paragraphs keep source line breaks (not space-joined)");
      assert.ok(page.includes("function toolResultHtml(b)"), "tool_result body helper");
      assert.ok(page.includes('class="chat-tool-body"'), "tool_result body is in the transcript, not a tooltip");
      assert.ok(page.includes("if (e.text) r.text = e.text"), "tool_result text is kept on the card");
      assert.ok(page.includes('escHtml(b.text)'), "thinking/user/errnote bodies are not sliced");
      assert.ok(!page.includes("truncate(b.text"), "turn bodies are not 400/500-char truncated in the renderer");
      assert.match(page, /\.chat-tool-body\s*{[^}]*white-space:\s*pre-wrap/, "tool_result line structure is preserved");
      assert.match(page, /\.chat-thinking\s*{[^}]*white-space:\s*pre-wrap/, "thinking stays pre-wrap");
    }
  });
});

describe("run page — full-transcript output card (chat-ui fact cuoc)", () => {
  test("a long tool_result is a named output card, not a second dump", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes("function outputCardItem(b, key)"), "named output-card builder");
      assert.ok(page.includes("function outputCardName(tc)"), "source name for the card header");
      assert.ok(page.includes("function outputLineMeta(text)"), "Lines 1-N range helper");
      assert.ok(page.includes('"Lines 1-"'), "header carries a line range");
      assert.ok(page.includes("chat-output-name"), "named header");
      assert.ok(page.includes("chat-output-meta"), "line-range meta");
      assert.ok(page.includes('"chat-card chat-output tool-card"'), "output card class");
      assert.ok(page.includes('hasBody && tc.name !== "Edit" && tc.name !== "Write"'),
        "Read/Bash/etc. results promote to the named card");
      assert.ok(page.includes('escHtml(text)'), "every character of the body is escaped, not sliced");
      assert.match(page, /\.chat-assistant\s*\+\s*\.tool-card\s*{[^}]*margin-top:\s*8px/,
        "output card sits under assistant prose as one turn");
    }
  });

  test("the named output card paints advertised lines in a line-snapped file object", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /\.chat-card\.chat-output\s+\.chat-tool-body\s*{[^}]*overflow:\s*auto/,
        "output body is an internal file-object scroller");
      assert.match(page, /\.chat-card\.chat-output\s*{[^}]*overflow:\s*visible/,
        "the card does not leftover-clip a mid-glyph");
      assert.match(page, /\.chat-card\.chat-output\s+\.chat-tool-body\s*{[^}]*scrollbar-gutter:\s*stable/,
        "the file-object scroller is visible");
      assert.ok(!/\.chat-card\.chat-output\s+\.chat-tool-body\s*{[^}]*max-height:\s*18em/.test(page),
        "18em clip from the contained-card round is gone");
      assert.ok(!/\.chat-card\.chat-output\s+\.chat-tool-body\s*{[^}]*overflow:\s*visible/.test(page),
        "uncapped overflow:visible shear is gone");
      assert.ok(!/\.chat-card\.chat-output\s+\.chat-tool-body\s*{[^}]*max-height:\s*none/.test(page),
        "uncapped max-height:none shear is gone");
      assert.ok(!/\.chat-card\.chat-output\s*{[^}]*overflow:\s*hidden/.test(page),
        "leftover-column overflow:hidden shear is gone");
    }
  });
});

describe("run page — full-transcript file object (chat-ui fact cufs/cucp)", () => {
  test("containNamedOutput sizes the named card as a line-snapped file object", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /function containNamedOutput\(\)/, "file-object sizer is present");
      assert.match(page, /function measurePreLines\(/, "line boxes are Range-measured");
      assert.match(page, /function snapBodyToWholeLines\(/, "viewport snaps to whole lines");
      assert.match(page, /function clearOutputCap\(/, "idle remasure can release a trail collapse");
      assert.ok(page.includes("document.createRange()"), "each pre line is a Range");
      assert.ok(page.includes("FILE_OBJECT_MAX = 12"), "preferred file-object ceiling is 12 whole lines");
      assert.ok(page.includes("leftoverBody"), "card takes leftover above the composer");
      assert.ok(page.includes("lastLine.bottom"), "last visible line Range.bottom is checked against the card");
      assert.ok(page.includes('querySelector(".chat-composer")'), "still stays above .chat-composer");
      assert.ok(page.includes('card.setAttribute("data-contained", "1")'), "contained card is marked");
      assert.ok(page.includes("frameCompletedTurn();") && page.includes("containNamedOutput();"),
        "first completed paint frames then sizes the file object");
      assert.ok(page.includes("if (lastState === \"running\")"), "generating still owns stick-to-bottom");
      assert.ok(!page.includes("max-height: 18em"), "no fixed 18em fallback");
      assert.ok(!page.includes("Math.floor(inner / lh)"), "theoretical leftover line-height snap is gone");
      assert.ok(!page.includes("FILE_OBJECT_MIN"), "no 8-line minimum that steals from the answer");
      assert.ok(!page.includes("data-yield"), "assistant is never yielded");
      assert.ok(!page.includes("clearAssistantYield"), "yield machinery is gone");
    }
  });
});

describe("run page — full-transcript leftover file object (chat-ui fact cual)", () => {
  test("containNamedOutput cuts preferred file-object lines instead of clipping the assistant", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes("Answer-first leftover snap"), "sizer is answer-first");
      assert.ok(page.includes("cutting preferred file-object lines first"),
        "preferred tool lines yield, not the prose");
      assert.ok(page.includes("leftoverBody"), "budget is leftover after unclipped prose");
      assert.ok(page.includes("FILE_OBJECT_MAX"), "preferred ceiling, not a forced minimum");
      assert.ok(!page.includes('setAttribute("data-yield"'), "no assistant yield attribute");
      assert.ok(!page.includes("asst.style.maxHeight"), "assistant max-height is never set");
      assert.ok(!page.includes("asst.style.overflow"), "assistant overflow is never set");
      assert.ok(!page.includes("MIN_ASSISTANT"), "no assistant budget that clips L017–L023");
      assert.ok(!page.includes("FILE_OBJECT_MIN"), "no 8-line file-object floor");
      assert.ok(!/\.chat-assistant\[data-yield/.test(page), "no yield CSS on the assistant");
      assert.match(page, /function snapBodyToWholeLines\(/, "last visible tool line stays whole");
    }
  });
});

describe("run page — full-transcript output pane (chat-ui fact cuop)", () => {
  test("output pane stays a click-to-inspect sibling, not the default idle layout", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes('id="chatOutputPane"'), "output pane element");
      assert.ok(page.includes('class="chat-output-pane"'), "output pane class");
      assert.ok(page.includes('class="chat-body"'), "row wraps chat + pane");
      assert.ok(page.includes('class="chat-main"'), "composer stays in chat-main");
      assert.ok(page.includes("function syncOutputPane(items)"), "pane helper is present");
      assert.ok(page.includes("function outputPaneHtml(o)"), "pane can render the advertised body");
      assert.match(page, /\.chat-app\[data-has-output="1"\]\s+\.chat-output-pane\s*{/,
        "open pane is a flex sibling, not parked under the composer");
      assert.match(page, /\.chat-body\s*{[^}]*flex-direction:\s*row/,
        "pane sits beside the conversation column when opened");
      assert.ok(page.includes('item.output = { name: name, meta: meta, text: text, err: err }'),
        "full tool_result text is kept on the named card");
      const paneIdx = page.indexOf('id="chatOutputPane"');
      const composerClose = page.lastIndexOf("</footer>");
      assert.ok(paneIdx > 0 && composerClose > 0 && paneIdx > composerClose,
        "pane is a sibling after the composer footer, not nested under it");
    }
  });
});

describe("run page — full-transcript finished answer (chat-ui fact cuaf)", () => {
  test("a completed turn is framed from the last user bubble, not pinned to the log tail", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /function frameCompletedTurn\(\)/, "completed-turn framer is present");
      assert.ok(page.includes('querySelectorAll(".chat-user")'), "framer targets the last user bubble");
      assert.ok(page.includes("requestAnimationFrame(function () {") &&
        page.includes("frameCompletedTurn();") &&
        page.includes("containNamedOutput();"),
        "first completed paint frames then caps the named card");
      assert.ok(page.includes("function watchFramesLiveTrail()"), "generating still owns stick-to-bottom");
      assert.ok(page.includes("if (stick) frameLiveTrail();"), "growing recordings still pin a following scroller");
      assert.ok(page.includes("framedTurnKey"), "a completed turn is framed once, not on every poll");
    }
  });
});

describe("run page — full-transcript undivided answer (chat-ui fact cuua)", () => {
  test("assistant prose is one subject: no first-blank-line split, no mid-message chip", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(!page.includes("function composeAnswerItems("),
        "finished-turn composer no longer splits the assistant");
      assert.ok(!page.includes("function splitAssistantLead("),
        "lead/rest split at the first blank line is gone");
      assert.ok(!page.includes("chat-assistant-more"),
        "no rest-of-prose node after a mid-message chip");
      assert.ok(!page.includes("chat-answer-full"),
        "no hidden full-source span compensating for a split");
      assert.ok(!page.includes("Open output"),
        "no hollow Open-output chip inserted into the assistant");
      assert.ok(!page.includes("chat-output-open-label"),
        "opener-label class is gone");
      assert.ok(!page.includes('it.key + ":more"'),
        "assistant is not split into a :more key");
      assert.ok(/if \(e\.text\) blocks\.push\(\{ kind: "text", text: e\.text(?:, eventIndex: i)? \}\)/.test(page),
        "assistant text is still one text block");
      assert.ok(page.includes("md(b.text)"),
        "the whole assistant source is rendered as one markdown subject");
    }
  });
});

describe("run page — full-transcript named output body (chat-ui fact cuno)", () => {
  test("named output card after the prose includes the actual tool_result body", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes("function outputCardItem(b, key)"), "named output-card builder");
      assert.ok(page.includes("function outputCardName(tc)"), "source name for the card header");
      assert.ok(page.includes("function outputLineMeta(text)"), "Lines 1-N range helper");
      assert.ok(page.includes('"Lines 1-"'), "header carries a line range");
      assert.ok(page.includes("chat-output-name"), "named header");
      assert.ok(page.includes("chat-output-meta"), "line-range meta");
      assert.ok(page.includes("'<pre class=\"chat-tool-body\">' + escHtml(text) + \"</pre>\""),
        "in-thread card carries the actual tool_result body");
      assert.ok(!page.includes("Open output"), "card is not an empty opener");
      assert.match(page, /\.chat-assistant\s*\+\s*\.tool-card\s*{[^}]*margin-top:/,
        "named output sits after the complete assistant prose");
    }
  });
});

describe("run page — full-transcript column width (chat-ui fact cuwp)", () => {
  test("default completed-turn paint does not auto-open the output pane", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes("if (!last || !pane._tqOpen)"),
        "pane stays closed unless the user opens it");
      assert.ok(page.includes("pane._tqOpen = true"),
        "click-to-inspect still opens the pane");
      assert.ok(page.includes('app.removeAttribute("data-has-output")'),
        "closed pane does not squeeze the conversation column");
      assert.match(page, /\.chat-col\s*{[^}]*max-width:\s*760px/,
        "conversation column keeps its full readable width");
      assert.ok(page.includes('id="chatOutputPane"'), "pane remains available");
    }
  });
});

describe("run page — full-transcript slim answer footer (chat-ui fact cuas)", () => {
  test("an idle /run?session= column ends on a slim follow-up, not a 350px archive stack", () => {
    const idle = sessionHtml({ live: false, continuable: true, agent: "claude", source: "claude" });
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\](?::not\(\[data-live-tail="1"\]\))? \.observer-card/,
      "observer pamphlet leaves the completed column");
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\](?::not\(\[data-live-tail="1"\]\))? \.composer-status/,
      "status strip leaves the completed column");
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\](?::not\(\[data-live-tail="1"\]\))? \.chat-activity/,
      "idle archive line leaves the completed column");
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm/,
      "takeover continue becomes the slim pill");
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*border-radius:\s*22px/,
      "idle continue is a rounded pill, not a stacked card");
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*margin-top:\s*0/,
      "hidden observer-card cannot add a 10px gap above the idle pill");
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*border-color:\s*rgba\(255, 255, 255, 0\.10\)/,
      "idle pill uses the live-tail border, not the purple continue outline");
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \.composer-context/,
      "context chip row is not part of the slim pill");
    assert.match(idle, /id="liveTailForm"[^>]*hidden/, "exclusive live tail stays hidden while idle");
    const live = sessionHtml({ live: true, continuable: true, agent: "claude", source: "claude" });
    assert.match(live, /id="liveTailForm"/, "growing recordings still end on #liveTailForm");
    assert.match(live, /id="archiveEnding" hidden/, "archive pamphlet still leaves the live column");
    assert.ok(live.includes("body[data-live-tail=\"1\"] #archiveEnding"));
    assert.ok(live.includes("body[data-live-tail=\"1\"] #continueForm"));
  });
});

describe("run page — leftover-snap after growth keeps newest turn whole (idle-live-compose)", () => {
  test("after growth, leftover-snap leftover-snaps leftover as a reading block", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /function leftoverSnapIsStale\(/,
        "stale leftover-snap is detected when the newest assistant follows the named card");
      assert.match(page, /function keepNewestTurnAbovePill\(/,
        "newest completed turn is kept above the continue pill");
      assert.match(page, /function leftoverCloseTop\(/,
        "leftover-snap still closes a named file above the composer");
      assert.ok(!page.includes("if (!newestTurnOwnFile()) return true"),
        "file-less growth does not re-frame the first dump as leftover");
      assert.match(page, /function parkPriorFixtureOnly\(/,
        "file-less growth parks only the prior fixture, not the first dump");
      assert.match(page, /function parkFirstDumpOffLeftover\(/,
        "own-file newest still parks the first dump off leftover");
      assert.ok(page.includes("if (leftoverSnapIsStale())"),
        "containNamedOutput and idle frame consult stale leftover-snap");
      assert.ok(page.includes("if (shouldFrameCompletedTurn()) frameCompletedTurn()"),
        "first-turn leftover-snap still frames the last user");
      assert.ok(page.includes("leftoverSnapNewestTurn()"),
        "idle after growth leftover-snaps the newest turn");
      assert.ok(page.includes("Answer-first leftover snap"),
        "first-turn leftover-snap interiors are unchanged");
      assert.ok(page.includes("FILE_OBJECT_MAX = 12"),
        "leftover-snap preferred-line ceiling is unchanged");
      assert.match(page, /function snapBodyToWholeLines\(/,
        "leftover-snap line-snap math is unchanged");
      assert.match(page, /function parkPriorCompletedTurn\(/,
        "live parking is unchanged");
      assert.ok(page.includes("Later assistant events accumulate on the fold"),
        "live-trail accumulation is unchanged");
      assert.ok(!page.includes("if (firstOut >= 0 && lastAsst > firstOut) return true"),
        "G1 tool-then-prose lastAsst > firstOut is not after-growth");
      assert.ok(page.includes("Same-turn tool-then-prose"),
        "leftoverSnapIsStale names G1 as the completed named column, not after-growth");
    }
  });

  test("after growth, leftover-snap frames the newest completed turn as the reading block", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /function newestTurnAnchor\(/,
        "newest-turn reading frame has a user-or-assistant anchor");
      assert.match(page, /function leftoverSnapNewestTurn\(/,
        "idle after growth leftover-snaps the newest turn, not only its last box");
      assert.match(page, /function newestTurnOwnFile\(/,
        "only that turn's own file (same event-index) leftover-snaps");
      assert.ok(!page.includes("function leftoverSnapNewestProse"),
        "r4 min-height stretch of a 39px caption is gone");
      assert.ok(!page.includes("el.style.minHeight = leftover + \"px\""),
        "file-less newest prose is not stretched to claim leftover");
      assert.match(page, /function leftoverSnapNewestTurnReading\(/,
        "newest turn owns leftover as prose + that turn's file + close");
      assert.match(page, /function snapNamedOutputCard\(/,
        "leftover-snap interiors stay in one file-object sizer");
      assert.ok(page.includes("nodeFollows(firstOut, user)"),
        "a follow-up user after the first named output starts the newest turn");
      assert.ok(page.includes("return lastThreadEl(\".chat-assistant\")"),
        "same-user measure-append does not treat the first-dump user as the newest-turn anchor");
      assert.ok(!/function newestTurnAnchor\(\) \{\s*var user = lastThreadEl\("\.chat-user"\);\s*if \(user\) return user/.test(page),
        "r2 last-user anchor is gone — that painted a two-line island over unused leftover");
      assert.ok(page.includes("parkFirstDumpOffLeftover();"),
        "own-file stale idle parks the first dump so leftover is that turn");
      assert.ok(page.includes("parkPriorFixtureOnly();"),
        "file-less stale idle parks only the prior fixture");
      assert.ok(page.includes("two-line island over unused leftover"),
        "r2 parking-only leftover is named as not a reading block");
      assert.ok(page.includes("prose + file card + close"),
        "leftover-snap leftover-snaps leftover as a reading block");
      assert.ok(page.includes("if (ce === ev) own = cards[i]"),
        "own file is the card whose data-event-index matches the last assistant");
      assert.ok(page.includes("unparkNode(own)"),
        "stale leftover-snap unparks that turn's own file, not the last named-output");
      assert.ok(page.includes("snapNamedOutputCard(own, true)"),
        "that turn's own file leftover-snaps to leftover (owns leftover, not a 12-line island)");
      assert.ok(page.includes("function leftoverSnapNamedColumn("),
        "first-turn leftover-occupies the named shell-output column");
      assert.ok(page.includes("snapNamedOutputCard(named, true)"),
        "G1 named card occupies leftover with fillLeftover, not a 12-line island");
      assert.ok(page.includes("for (i = 0; i < start; i++) parkNode(kids[i]);"),
        "first-turn leftover layout parks user and prior dumps off leftover");
      assert.ok(page.includes('data-leftover-owned", "named-column"'),
        "first-turn leftover-owned pixels are the named column occupying leftover");
      assert.ok(page.includes("opening prose +") && page.includes("named card (Lines 1"),
        "leftover occupancy of leftover-owned pixels is opening + named + closing");
      assert.ok(page.includes("leftover occupancy of leftover-owned content is not leftover occupancy of leftover"),
        "leftover occupancy of leftover-owned is not leftover occupancy of leftover");
      assert.ok(page.includes("leftover.clientHeight") && page.includes("leftover air under closing"),
        "leftover occupancy of leftover is leftover.clientHeight leftover viewport leftoverAir");
      assert.ok(!page.includes("snapNamedOutputCard(cards[cards.length - 1]);"),
        "first-turn does not 12-line-snap cards[last] without fillLeftover");
      assert.ok(page.includes("Honest absence"),
        "no file on the newest turn does not fake a file");
      assert.ok(page.includes("do not stretch the caption"),
        "file-less newest is not a 710px min-height on 39px of marker");
      assert.ok(page.includes("first dump's fixture in place"),
        "r5 leftover-snap of the first dump's fixture is named as not leftover");
      assert.ok(!page.includes("function placeNewestOutputAfterProse"),
        "r3 does not staple the last named-output under newest prose");
      assert.ok(!page.includes("unparkNode(newestCard)"),
        "r3 unpark of last named-output is gone");
      assert.ok(page.includes("tr.top - sr.top") && page.includes("newestTurnAnchor()"),
        "own-file newest turn is scrolled to the top of #chatScroll like leftover-snap");
      assert.ok(page.includes("39px caption under an uncapped prior file object"),
        "the r1 last-box pin is named as not the reading frame");
      assert.ok(page.includes("if (leftoverSnapIsStale()) leftoverSnapNewestTurn()"),
        "stale leftover-snap still leftover-snaps the newest turn");
      assert.match(page, /function frameNewestTurnAtLeftoverTop\(/,
        "file-less newest is framed as leftover-owned leftover");
      assert.match(page, /function occupyLeftoverAsNewestReading\(/,
        "leftover fills leftover as the newest turn's reading block");
      assert.ok(!page.includes("function sizeLeftoverToNewestTurn"),
        "r9 leftover-pocket shrink of leftover is gone");
      assert.match(page, /function splitPriorOffLeftover\(/,
        "prior dump leaves leftover into leftover history");
      assert.ok(page.includes('id="chatHistory"'),
        "leftover history keeps dump nodes for incremental stamps");
      assert.ok(page.includes("not leftover-owned"),
        "first dump is not leftover-owned");
      assert.ok(page.includes("root.hidden = false"),
        "leftover history stays in the document so full-text innerText still has L001–L023");
      assert.ok(page.includes("681px dump-on-fold"),
        "r8 leftover history painted the dump on leftover");
      assert.match(page, /data-leftover-reading="1"\] #chatScroll \{[^}]*flex:\s*1/,
        "leftover-owned newest-turn reading block fills leftover");
      assert.ok(!/data-leftover-pocket="1"\] \.chat-main \{[^}]*justify-content:\s*flex-end/.test(page),
        "r9 55px leftover-pocket glued to the pill is gone");
      assert.match(page, /\.chat-history\[data-split="1"\] \{[^}]*left:\s*-9999px/,
        "split leftover history is parked off leftover so leftover-owned pixels cannot be the dump");
      assert.ok(!page.includes("flex: 1;\n  min-height: 0;\n  overflow-y: auto;"),
        "leftover history is not leftover (r8 flex:1 dump on fold)");
      assert.ok(page.includes("keepNewestTurnAbovePill()"),
        "last box still stays above the continue pill after the reading frame");
      assert.ok(page.includes("if (shouldFrameCompletedTurn()) frameCompletedTurn()"),
        "first-turn leftover-snap still frames the last user");
      assert.ok(page.includes("Answer-first leftover snap"),
        "first-turn leftover-snap interiors are unchanged");
      assert.match(page, /function parkPriorCompletedTurn\(/,
        "live parking is unchanged");
    }
  });

  test("after growth, leftover-snap leftover-snaps that turn's own file or honest absence", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.ok(page.includes("That turn's own file: same data-event-index"),
        "own-file matcher is keyed to the last assistant, not last .chat-output");
      assert.ok(page.includes("do not staple it under BAR_NEW_TURN_MARKER"),
        "r3 staple of the prior fixture is named as not leftover-snap");
      assert.ok(page.includes("leftoverSnapNewestTurnReading()"),
        "stale containNamedOutput leftover-snaps the newest turn reading block");
      assert.match(page, /function leftoverCloseTop\(/,
        "named-file leftover still closes above the composer");
      assert.ok(page.includes("close - nh - 8"),
        "leftover reserves newest height above the composer, not newest.top after a 475px uncap");
      assert.ok(!page.includes("snapNamedOutputCard(cards[cards.length - 1], true)"),
        "file-less leftover does not leftover-snap the first dump's fixture in place");
      assert.ok(!page.includes("function pinNewestProseClose"),
        "r6 margin-top spacer pin is gone");
      assert.ok(!page.includes("el.style.marginTop = slack"),
        "file-less leftover does not claim leftover with a margin-top spacer");
      assert.ok(!page.includes("function leftoverScrollPadForNewest"),
        "r7 #chatThread padding-bottom hoist is gone");
      assert.match(page, /function occupyLeftoverAsNewestReading\(/,
        "file-less leftover occupies leftover as the newest turn's reading block");
      assert.ok(page.includes("data-leftover-reading"),
        "leftover is leftover-owned by the newest turn occupying leftover, not unused leftover");
      assert.ok(!page.includes("function sizeLeftoverToNewestTurn"),
        "r9 55px leftover-pocket does not cede leftover to unused chat-main");
      assert.ok(page.includes('data-leftover-owned", "newest"') || page.includes("data-leftover-owned"),
        "leftover-owned pixels are named as the newest turn");
      assert.ok(page.includes("splitPriorOffLeftover()"),
        "file-less leftover lifts the first dump off leftover-owned leftover");
      assert.ok(page.includes("does not paint leftover") || page.includes("not leftover-owned"),
        "leftover history does not paint leftover");
      assert.ok(page.includes("cedes leftover to unused chat-main"),
        "r9 55px pocket unused chat-main is named as not leftover-owned");
      assert.ok(page.includes("not a black void"),
        "r6 leftover void above a caption glued to the pill is named");
      assert.ok(page.includes("padding-bottom hoisting a 39px caption"),
        "r7 pad-bottom unused leftover is named as not leftover-snap");
      assert.ok(page.includes("r4 stretched a 39px caption"),
        "r4 min-height stretch is named as not leftover-snap");
      assert.ok(page.includes("701px"),
        "r4 leftover air is named as unused column");
      assert.ok(page.includes("margin-top spacer"),
        "r6 leftover-claiming spacer is named as not leftover-snap");
      assert.ok(!page.includes("function leftoverSnapNewestProse"),
        "honest absence does not leftover-snap the caption with min-height");
      assert.ok(!page.includes("el.style.minHeight = leftover + \"px\""),
        "newest prose is not stretched when that turn has no file");
      assert.ok(page.includes("clearNewestProseLeftover(newest)"),
        "own-file path does not also stretch newest prose over the file");
      assert.ok(page.includes("FILE_OBJECT_MAX = 12"),
        "first-turn leftover-snap preferred-line ceiling is unchanged");
      assert.ok(!page.includes("asst.style.maxHeight"),
        "assistant max-height is never set");
      assert.ok(!page.includes("asst.style.overflow"),
        "assistant overflow is never set");
    }
  });

  test("leftoverSnapIsStale does not treat G1 tool-then-prose as after-growth", () => {
    const page = html();
    const start = page.indexOf("function leftoverSnapIsStale()");
    const end = page.indexOf("function shouldFrameCompletedTurn()");
    assert.ok(start > 0 && end > start, "leftoverSnapIsStale is embedded");
    const src = page.slice(start, end);
    const isStale = (blocks) => new Function(
      "lastBlocks",
      "lastThreadEl",
      "nodeFollows",
      `${src}\nreturn leftoverSnapIsStale();`,
    )(blocks, function lastThreadEl() { return null; }, function nodeFollows() { return false; });

    const g1 = [
      { kind: "user", eventIndex: 0 },
      { kind: "tool", eventIndex: 2, res: { text: "lsof" } },
      { kind: "tool", eventIndex: 4, res: { text: "ps" } },
      { kind: "text", eventIndex: 6, text: "It's tracequest serve on port 7777." },
      { kind: "tool", eventIndex: 6, res: { text: "exit: 0\nport 7777 is free" } },
      { kind: "text", eventIndex: 7, text: "I stopped it. Port 7777 is free." },
    ];
    assert.equal(isStale(g1), false,
      "G1 opening + shell output + closing is the completed named column, not after-growth");

    const followUp = [
      { kind: "user", eventIndex: 0 },
      { kind: "text", eventIndex: 1 },
      { kind: "tool", eventIndex: 1, res: { text: "fixture" } },
      { kind: "user", eventIndex: 2 },
      { kind: "text", eventIndex: 3 },
    ];
    assert.equal(isStale(followUp), true,
      "a follow-up user after the first named output is after-growth");
  });
});

describe("run page — slim pill chrome (chat-ui fact c9v)", () => {
  test("idle #continueForm and live #liveTailForm share one pill chrome", () => {
    const idle = sessionHtml({ live: false, continuable: true, agent: "claude", source: "claude" });
    const live = sessionHtml({ live: true, continuable: true, agent: "claude", source: "claude" });
    assert.match(idle, /id="continueInput"[^>]*placeholder="Send a follow-up"/);
    assert.match(live, /id="liveTailInput"[^>]*placeholder="Send a follow-up"/);
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*padding:\s*7px 8px 7px 16px/);
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*border-radius:\s*22px/);
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*border-color:\s*rgba\(255, 255, 255, 0\.10\)/);
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*box-shadow:\s*0 4px 16px rgba\(0, 0, 0, 0\.22\)/);
    assert.match(idle, /body\[data-watch="session"\]\[data-run-state="idle"\] #continueForm \{[^}]*margin-top:\s*0/);
    assert.match(live, /\.composer-card\.live-tail-card \{[^}]*padding:\s*7px 8px 7px 16px/);
    assert.match(live, /\.composer-card\.live-tail-card \{[^}]*border-radius:\s*22px/);
    assert.match(live, /\.composer-card\.live-tail-card \{[^}]*border-color:\s*rgba\(255, 255, 255, 0\.10\)/);
    assert.match(live, /\.composer-card\.live-tail-card \{[^}]*box-shadow:\s*0 4px 16px rgba\(0, 0, 0, 0\.22\)/);
    assert.ok(idle.includes("continues as a new run"), "fork honesty stays on the hidden continue chip");
    assert.match(idle, /id="continueSendBtn"[^>]*continues as a new run/,
      "fork honesty stays on the idle send title");
    assert.ok(!/id="continueForm"[^>]*data-mode="live-tail"/.test(live),
      "exclusive live composer is still a separate #liveTailForm");
  });
});

describe("run page — streaming, pending, and exited states (chat-ui fact cusp)", () => {
  test("while live the last activity reads as in-progress with a shimmer marker", () => {
    const page = html();
    assert.ok(page.includes('"Thinking"'), "thinking marker after a user message");
    assert.ok(page.includes('"Planning next moves"'), "running marker after assistant activity");
    assert.match(page, /\.shimmer\s*{[^}]*animation: chat-shimmer/);
    assert.ok(page.includes("b.running = true"), "trailing tool calls without results marked running");
    assert.ok(page.includes('<span class="spinner">'), "running cards swap the icon for a spinner");
    assert.match(page, /if \(lastState === "idle"\) return markerHtml\("Not running"/,
      "idle launched G1 does not shimmer Planning next moves");
  });

  test("a live /run?session= recording with no parsed turns is not Thinking", () => {
    const page = sessionHtml({ live: true });
    assert.ok(page.includes("No transcript yet"), "empty live recording is honest");
    assert.ok(page.includes("the agent process is running but this recording has no turns"));
    assert.doesNotMatch(page, /the agent process is live/);
    assert.match(page, /if \(!events\.length\) return false/,
      "empty events are not treated as generating");
    const watchFn = page.slice(page.indexOf("/* watch-page activity marker"));
    assert.ok(watchFn.includes('if (!last)'), "empty thread skips Thinking");
    assert.ok(watchFn.includes("No transcript yet"));
  });

  test("a run without a linked session renders the pending state, not an empty error", () => {
    const page = html();
    assert.ok(page.includes("Waiting for the agent session"));
    assert.ok(page.includes("no session recording linked yet"));
    assert.ok(page.includes('data.link === "pending"'));
  });

  test("the exited state stops both pollers after a final render and keeps the transcript", () => {
    const page = html();
    assert.ok(page.includes('markerHtml("Agent exited", "transcript preserved")'));
    assert.ok(page.includes("sessFinalDone"), "one delayed final session poll after exit");
    assert.match(page, /function markExited\(\)[\s\S]*?stopSnapshotLoop\(\);/);
    assert.ok(page.includes('showBanner("exited"'));
    assert.ok(page.includes("killBtn.hidden = true"), "kill control hidden once exited");
  });
});

describe("run page — collapsed raw terminal (facts lawp/lalv)", () => {
  test("the raw terminal lives in a collapsed details block below the transcript", () => {
    const page = html();
    assert.ok(page.includes('<details class="chat-terminal" id="terminalDetails">'));
    assert.ok(!page.includes('<details class="chat-terminal" id="terminalDetails" open'), "collapsed by default");
    assert.ok(page.includes('<pre class="run-screen" id="runScreen">'));
    assert.match(page, /\.run-screen\s*{[^}]*font-family: var\(--mono\)/);
    assert.match(page, /\.run-screen\s*{[^}]*white-space: pre/);
    assert.match(page, /\.run-screen\s*{[^}]*min-width: 80ch/);
    assert.match(page, /\.run-terminal\s*{[^}]*overflow-x: auto/);
    assert.match(page, /\.run-terminal\s*{[^}]*--ansi-bg: #101012/, "dark terminal background");
  });

  test("run page embeds the full ansi palette css for SGR-classed spans", () => {
    const page = html();
    assert.ok(page.includes(ansiPaletteCss()), "ansiPaletteCss() output embedded verbatim");
    assert.ok(page.includes(".ansi-fg-1{"));
    assert.ok(page.includes(".ansi-bold{"));
    assert.ok(page.includes(".ansi-dim{"));
  });

  test("client script polls the snapshot endpoint every ~600ms and swaps html into the viewport", () => {
    const page = html();
    assert.equal(RUN_POLL_MS, 600);
    assert.ok(page.includes("var POLL_MS = 600;"));
    assert.ok(page.includes('fetch("/api/runs/snapshot?id=" + encodeURIComponent(runId))'));
    assert.ok(page.includes("setTimeout(poll, POLL_MS)"));
    assert.ok(page.includes("screen.innerHTML = data.html"));
    assert.ok(page.includes('var runId = "@3";'), "run id embedded server-side");
  });

  test("exited snapshot stops terminal polling and keeps the final screen under an exited banner", () => {
    const page = html();
    assert.ok(page.includes('if (data.status === "exited") { markExited(); return; }'));
    assert.ok(page.includes('data-polling="0"'), "page exposes a polling flag");
    assert.match(page, /\.run-terminal\[data-status="exited"\] \.run-screen[^{]*{[^}]*opacity/);
    assert.match(page, /\.run-banner\[data-kind="exited"\]/);
  });

  test("a 404 answer flips to the gone state and stops all polling", () => {
    const page = html();
    assert.ok(page.includes("if (res.status === 404) { markGone(); return; }"));
    assert.match(page, /function markGone\([\s\S]*?stopPolling\(\);/);
    assert.match(page, /function stopPolling\(\)[\s\S]*?stopSnapshotLoop\(\);[\s\S]*?stopSessionLoop\(\);/);
    assert.match(page, /\.run-state-badge\[data-status="gone"\]/);
  });

  test("polling pauses while the document is hidden and resumes on visibility", () => {
    const page = html();
    assert.ok(page.includes('document.addEventListener("visibilitychange"'));
    assert.ok(page.includes("if (document.hidden)"));
  });

  test("kill button POSTs /api/runs/kill and updates state without reload", () => {
    const page = html();
    assert.match(page, /<button class="status-btn danger" id="killBtn" type="button"[^>]*>Kill run<\/button>/);
    assert.ok(page.includes('fetch("/api/runs/kill"'));
    assert.match(page, /method: "POST"/);
    assert.ok(page.includes('markGone("run killed")'));
    assert.ok(!page.includes("location.reload"));
  });

  test("poll re-checks the stopped flags after every await before touching the DOM", () => {
    // UI-001: a kill can stop the page while a poll is in flight — the
    // resolved late poll must not repaint the pre-kill screen or flip the
    // status back to running.
    const page = html();
    assert.match(
      page,
      /var res = await fetch\("\/api\/runs\/snapshot\?id=" \+ encodeURIComponent\(runId\)\);[\s\S]{0,500}?if \(stopped \|\| snapStopped\) return;\s*if \(res\.status === 404\)/,
      "stopped re-checked after the fetch await, before any state change",
    );
    assert.match(
      page,
      /var data = await res\.json\(\);\s*if \(stopped \|\| snapStopped\) return;\s*screen\.innerHTML = data\.html;/,
      "stopped re-checked after the json await, before the DOM swap",
    );
  });

  test("markGone never overwrites an existing gone reason", () => {
    // UI-001 (post-kill 404 path): after markGone("run killed") a late 404
    // poll calling markGone() must keep the "run killed" banner.
    const page = html();
    assert.match(
      page,
      /function markGone\(message\) {\s*[\s\S]{0,300}?if \(!banner\.hidden && banner\.getAttribute\("data-kind"\) === "gone"\) return;/,
      "markGone bails out when a gone banner is already shown",
    );
  });

  test("kill failure shows the server error inline and re-enables the button", () => {
    // UI-005: a failed kill was silent — the server {error} must surface
    // via the page's existing inline error helper.
    const page = html();
    const killHandler = page.slice(page.indexOf('killBtn.addEventListener("click"'));
    assert.ok(killHandler.includes("showInputError(await readError(res))"), "server {error} shown inline");
    assert.ok(killHandler.includes("showInputError(String(e))"), "network failure shown inline");
    assert.ok(killHandler.includes("killBtn.disabled = false"), "button re-enabled after failure");
    assert.ok(killHandler.includes("clearInputError()"), "stale error cleared on retry");
  });
});

describe("run page — server-rendered exited state", () => {
  test("an already-exited run renders the exited badge and no kill button", () => {
    const page = html({ status: "exited" });
    assert.ok(page.includes('id="runStatus" data-status="exited"'));
    assert.ok(page.includes('id="runTerminal" data-status="exited"'));
    assert.match(page, /id="killBtn" type="button"[^>]* hidden>/, "kill control starts hidden");
    assert.match(page, /id="stopBtn" type="button"[^>]* hidden>/, "stop control starts hidden");
    assert.ok(page.includes('id="composerStatus" data-state="exited"'), "status strip starts exited");
    assert.ok(page.includes(">Agent exited</span>"), "status strip carries the exited copy");
    assert.ok(page.includes('data-run-state="exited"'), "chat renderer starts from the exited state");
  });
});

describe("run page — composer input card (facts laiu, chat-composer ccin)", () => {
  test("composer input card renders the Cursor-style card: chip row, borderless input, control row, round send", () => {
    const page = html();
    assert.match(page, /<form class="composer-card" id="inputRow" data-empty="true">/);
    assert.match(page, /<input class="run-input" id="inputText" type="text"[^>]*autocomplete="off"/);
    assert.match(page, /placeholder="Send a follow-up"/);
    // Card chrome: rounded bordered surface, borderless input inside it.
    assert.match(page, /\.composer-card\s*{[^}]*border-radius: 14px/);
    assert.match(page, /\.composer-card\s*{[^}]*background: var\(--surface\)/);
    assert.match(page, /\.run-input\s*{[^}]*background: none/, "input is borderless inside the card");
    assert.match(page, /\.run-input\s*{[^}]*border: none/);
    // Context row: the @ affordance is a REAL button (inserts an @-mention
    // into the input) + cwd chip with the run's dir basename.
    assert.match(page, /<button class="ctx-at" id="ctxAtBtn" type="button" title="[^"]*@[^"]*">@<\/button>/);
    assert.match(page, /ctxAtBtn\.addEventListener\("click"/, "@ button is wired, not decorative");
    assert.match(page, /ctxAtBtn\.addEventListener\("click"[\s\S]{0,400}?inputText\.focus\(\)/, "@ button hands focus to the input");
    assert.match(page, /<span class="ctx-chip" title="\/home\/dev\/project">/);
    assert.ok(page.includes("project\n"), "cwd chip shows the dir basename");
    // Control row: caret-marked agent chip (a real disclosure button with a
    // visible shortcut), the live-model chip (hidden until the session
    // reports a model), the labeled Send key chip, and the round send arrow —
    // no cryptic bare run id in the row (it lives in the run-details menu).
    assert.match(page, /<button class="chip-btn mode-chip" id="agentChip" type="button"[^>]*aria-haspopup="true" aria-expanded="false"[^>]*>[\s\S]*?claude[\s\S]*?<\/button>/);
    assert.ok(page.includes('<span class="chip-kbd" id="agentChipKbd">&#8984;I</span>'), "agent chip carries a visible keyboard shortcut");
    assert.match(page, /id="agentChip"[\s\S]{0,700}?<svg class="caret"/, "agent chip carries a caret disclosure glyph");
    assert.match(page, /<button class="chip-btn model-chip" id="modelChip" type="button"[^>]*aria-haspopup="true"[^>]*hidden>/, "model chip present but hidden until the session reports a model");
    assert.match(page, /id="modelChip"[\s\S]{0,900}?<svg class="caret"/, "model chip carries a caret too");
    assert.ok(!page.includes('composer-meta'), "no unexplained bare run id in the control row");
    assert.match(page, /\.chip-btn\[aria-expanded="true"\] \.caret\s*{[^}]*rotate\(180deg\)/, "caret flips while the menu is open");
    assert.match(page, /<button class="run-send-btn" id="sendBtn" type="submit" aria-label="Send"/);
    assert.match(page, /\.run-send-btn\s*{[^}]*border-radius: 50%/, "send button is round");
    // Empty input visibly stands the send button down (muted circle + faint
    // arrow via data-empty, toggled by the client) so it never reads fully
    // active over an empty input; its title admits the bare-Enter behavior.
    assert.match(page, /\.composer-card\[data-empty="true"\] \.run-send-btn\s*{[^}]*rgba\(255, 255, 255, 0\.07\)/);
    assert.match(page, /\.composer-card\[data-empty="true"\] \.run-send-btn\s*{[^}]*color: rgba\(255, 255, 255, 0\.4\)/, "arrow glyph itself dims too");
    assert.match(page, /id="sendBtn"[^>]*title="Send \(Enter\)[^"]*bare Enter[^"]*"/, "send tooltip explains the empty-submit behavior");
    assert.ok(page.includes('inputText.addEventListener("input", syncEmpty)'));
    // The card must still honor the hidden attribute.
    assert.match(page, /\.composer-card\[hidden\]\s*{\s*display:\s*none;\s*}/);
  });

  test("send submits {text, key:Enter} to /api/runs/input, clears the input, and keeps focus", () => {
    const page = html();
    assert.ok(page.includes('fetch("/api/runs/input"'));
    assert.match(page, /inputRow\.addEventListener\("submit"/, "form submit (Enter in the input) = send");
    assert.ok(page.includes("event.preventDefault()"), "no page reload on submit");
    assert.ok(page.includes('{ text: text, key: "Enter" }'), "typed text is sent with an Enter key");
    assert.ok(page.includes('{ key: "Enter" }'), "empty input still submits a bare Enter");
    assert.ok(page.includes('inputText.value = ""'), "input cleared after a successful send");
    assert.ok(page.includes("inputText.focus()"), "focus returns to the input");
    assert.ok(!page.includes("location.reload"));
  });

  test("input errors are shown inline like the launch form, never via alert()", () => {
    const page = html();
    assert.ok(page.includes('<div class="run-input-error" id="inputError" role="alert" hidden></div>'));
    assert.match(page, /function showInputError\(/);
    assert.ok(page.includes("showInputError(await readError(res))"), "non-2xx {error} shown inline");
    assert.ok(!page.includes("alert("), "no alert() error reporting");
  });

  test("input card hides once the run is exited or gone", () => {
    const running = html();
    assert.match(running, /function markExited\(\)[\s\S]*?inputRow\.hidden = true;/);
    assert.match(running, /function markGone\([\s\S]*?inputRow\.hidden = true;[\s\S]*?stopPolling\(\);/);
    // Server-rendered exited state starts with the card hidden.
    const exitedPage = html({ status: "exited" });
    assert.match(exitedPage, /id="inputRow" data-empty="true" hidden>/);
  });
});

describe("run page — special-keys popover (chat-composer fact ccky)", () => {
  test("special-keys popover lists exactly the six allowed input keys with kbd glyphs", () => {
    const page = html();
    assert.match(page, /<button class="chip-btn keys-btn" id="keysBtn" type="button"[^>]*aria-haspopup="true" aria-expanded="false"/);
    assert.match(page, /id="keysBtn"[\s\S]{0,700}?Send key[\s\S]{0,200}?<svg class="caret"/, "keys control is an action-labeled chip (Send key) with a caret, not a bare icon or cryptic noun");
    assert.match(page, /<div class="keys-menu" id="keysMenu" role="dialog" aria-modal="true"[^>]*hidden tabindex="-1">/);
    for (const key of ["Enter", "C-c", "Escape", "Up", "Down", "Tab"]) {
      assert.ok(page.includes(`data-key="${key}"`), `special-key button for ${key} must be present`);
    }
    assert.match(page, /data-key="C-c">Interrupt <span class="kbd">\^C<\/span><\/button>/, "C-c reads as Interrupt with a ^C kbd glyph");
    assert.equal((page.match(/data-key="/g) || []).length, 6, "no keys beyond the server allowlist");
    assert.match(page, /\.keys-menu\s*{[^}]*position: absolute/, "menu floats above the button");
    assert.match(page, /\.keys-menu\[hidden\]\s*{\s*display:\s*none;\s*}/);
  });

  test("popover toggles from the keys button, closes on outside click and Escape, and closes after a send", () => {
    const page = html();
    assert.match(page, /function openKeysMenu\(\)[\s\S]*?aria-expanded", "true"/);
    assert.match(page, /function closeKeysMenu\(\)[\s\S]*?aria-expanded", "false"/);
    assert.match(page, /keysBtn\.addEventListener\("click"/);
    assert.match(page, /document\.addEventListener\("click",[\s\S]{0,400}?closeKeysMenu\(\);/, "outside click closes");
    assert.match(page, /event\.key === "Escape"[\s\S]{0,400}?closeKeysMenu\(\)/, "Escape closes");
    assert.match(page, /closeKeysMenu\(\);\s*await sendInput\({ key: btn\.getAttribute\("data-key"\) }\)/, "key send closes the menu first");
    assert.ok(page.includes("inputText.focus()"), "focus returns to the input after a key send");
  });
});

describe("run page — run-details popover (chat-composer fact cmrd)", () => {
  test("agent and model chips open a run-details popover naming what the run is", () => {
    const page = html();
    assert.match(page, /<div class="run-menu" id="runMenu" role="dialog" aria-modal="true"[^>]*hidden tabindex="-1">/);
    assert.match(page, /\.run-menu\s*{[^}]*position: absolute/, "popover floats above the row");
    assert.match(page, /\.run-menu\[hidden\]\s*{\s*display:\s*none;\s*}/);
    // Identity rows: agent, model, run id, directory, recording.
    assert.match(page, /<span class="rm-k">Agent<\/span><span class="rm-v">claude<\/span>/);
    assert.match(page, /<span class="rm-k">Model<\/span><span class="rm-v" id="menuModel">detecting&hellip;<\/span>/);
    assert.match(page, /<span class="rm-k">Run<\/span><span class="rm-v mono">@3 &middot; tmux window<\/span>/);
    assert.match(page, /<span class="rm-k">Directory<\/span><span class="rm-v mono">\/home\/dev\/project<\/span>/);
    assert.match(page, /<span class="rm-k">Recording<\/span><span class="rm-v" id="menuRecording">not linked yet<\/span>/);
    // The honest-affordance note: nothing is a fake picker.
    assert.match(page, /Agent &amp; model are fixed at launch/);
  });

  test("popover toggles from both chips, via Cmd/Ctrl-I, and closes like the keys menu", () => {
    const page = html();
    assert.match(page, /function openRunMenu\(\)[\s\S]*?aria-expanded", "true"/);
    assert.match(page, /function closeRunMenu\(\)[\s\S]*?aria-expanded", "false"/);
    assert.match(page, /agentChip\.addEventListener\("click"[\s\S]{0,120}?toggleRunMenu\(\)/);
    assert.match(page, /modelChip\.addEventListener\("click"[\s\S]{0,120}?toggleRunMenu\(\)/);
    assert.match(page, /\(event\.metaKey \|\| event\.ctrlKey\)[\s\S]{0,200}?toggleRunMenu\(\)/, "visible shortcut actually works");
    assert.match(page, /openKeysMenu\(\)\s*{\s*closeRunMenu\(\)/, "menus are mutually exclusive");
    assert.match(page, /openRunMenu\(\)\s*{\s*closeKeysMenu\(\)/, "menus are mutually exclusive both ways");
    assert.ok(page.includes('agentChipKbd.textContent = "Ctrl+I"'), "non-mac platforms get an honest shortcut label");
  });

  test("model chip and recording row are fed by the live session, never invented", () => {
    const page = html();
    assert.match(page, /function setModel\(model\)[\s\S]*?modelChip\.hidden = false;/, "model chip unhides only when a model is known");
    assert.ok(page.includes("if (lastSession && lastSession.model) setModel(lastSession.model)"), "model comes from the polled session");
    assert.match(page, /function shortModel\(m\)/, "display name shortened like the dashboard");
    assert.ok(page.includes('recLink.textContent = "view session"') || page.includes('recLink.textContent = "view session";'), "recording row links to /view once linked");
    assert.match(page, /recLink\.href = viewHref/, "recording link shares the header cross-link target");
  });
});

describe("run page — composer status strip (chat-composer fact ccst)", () => {
  test("status strip sits directly above the input card with a pulsing dot and Running copy while live", () => {
    const page = html();
    const strip = page.indexOf('id="composerStatus"');
    const card = page.indexOf('id="inputRow"');
    assert.ok(strip >= 0 && card > strip, "status strip renders above the input card");
    assert.ok(page.includes('<div class="composer-status" id="composerStatus" data-state="running">'));
    assert.ok(page.includes('<span class="status-dot"></span>'));
    assert.ok(page.includes('>Running</span>'));
    assert.match(page, /\.status-dot\s*{[^}]*animation: composer-pulse/, "dot pulses while running");
    assert.match(page, /\.composer-status\[data-state="exited"\] \.status-dot\s*{[^}]*var\(--orange\)/);
    assert.match(page, /\.composer-status\[data-state="gone"\] \.status-dot\s*{[^}]*var\(--red\)/);
  });

  test("Stop control interrupts the agent with C-c; Kill run stays a separate run-level control", () => {
    const page = html();
    assert.match(page, /<button class="status-btn" id="stopBtn" type="button"[^>]*>Stop <span class="kbd">\^C<\/span><\/button>/);
    assert.match(page, /stopBtn\.addEventListener\("click"[\s\S]{0,200}?sendInput\({ key: "C-c" }\)/, "Stop sends C-c, not kill");
    assert.match(page, /killBtn\.addEventListener\("click"[\s\S]{0,300}?fetch\("\/api\/runs\/kill"/, "Kill POSTs /api/runs/kill");
    // The two controls explain their different scopes: labels distinguish
    // agent-interrupt from run-kill, tooltips spell it out, and the
    // run-details note explains the pair in a discoverable place.
    assert.match(page, /id="stopBtn"[^>]*title="Interrupt the agent[^"]*Ctrl-C[^"]*"/, "Stop tooltip explains the interrupt");
    assert.match(page, /id="killBtn"[^>]*title="End the run[^"]*tmux window[^"]*"/, "Kill tooltip explains the kill scope");
    assert.match(page, /Stop sends \^C to interrupt the agent; Kill run ends its tmux window/, "run-details note explains Stop vs Kill run");
  });

  test("Stop and Kill run render as REAL bordered pill buttons, Kill with a rest-state danger tint", () => {
    const page = html();
    // Button containment: a bordered pill shape at rest, not a bare label.
    assert.match(page, /\.status-btn\s*{[^}]*border: 1px solid rgba\(255, 255, 255, 0\.14\)/, "buttons carry a rest-state border");
    assert.match(page, /\.status-btn\s*{[^}]*border-radius: 999px/, "buttons are pill-shaped");
    assert.match(page, /\.status-btn\s*{[^}]*background: rgba\(255, 255, 255, 0\.05\)/, "buttons carry a rest-state fill");
    // Destructive Kill run is red-tinted BEFORE hover: text, border, fill.
    assert.match(page, /\.status-btn\.danger\s*{[^}]*color: var\(--red\)/, "Kill run text is danger-tinted at rest");
    assert.match(page, /\.status-btn\.danger\s*{[^}]*border-color: rgba\(240, 112, 112, 0\.38\)/, "Kill run border is danger-tinted at rest");
    assert.match(page, /\.status-btn\.danger\s*{[^}]*background: rgba\(240, 112, 112, 0\.08\)/, "Kill run fill is danger-tinted at rest");
    // The ^C keycap inside the Stop pill reads as muted glyphs, not a
    // second nested box outshining the button itself.
    assert.match(page, /\.status-btn \.kbd\s*{[^}]*border: none/, "keycap chip loses its box inside a pill button");
  });

  test("exited and gone retire the stop/kill controls and swap the strip copy", () => {
    const page = html();
    assert.match(page, /function setComposerState\(state, text\)[\s\S]*?stopBtn\.hidden = !generating;\s*killBtn\.hidden = !attached;/);
    assert.ok(page.includes('setComposerState("exited", "Agent exited")'));
    assert.ok(page.includes('setComposerState("gone", message || "Run gone'));
  });
});

describe("run page — in-composer run feedback (chat-composer fact cmal)", () => {
  test("the strip text is the run's LIVE activity, derived from the polled session, never invented", () => {
    const page = html();
    // The derivation is a client port of the server's describeToolCall:
    // unresolved tool call → humanized in-progress action.
    assert.match(page, /function describeAction\(tc\)/);
    assert.match(page, /case "Bash":[\s\S]{0,200}?"Running " \+ cmd/, "bash reads as Running <cmd>");
    assert.match(page, /case "Edit": return input \? "Editing " \+ actBasename\(input\)/);
    assert.match(page, /case "Grep":\s*case "Glob": return input \? "Searching " \+ input/);
    // Activity model: unresolved tool call in the newest assistant turn,
    // else user/tool_result tail or recent recording growth => Generating,
    // else the plain honest Running.
    assert.match(page, /function runActivity\(\)[\s\S]*?if \(lastState !== "running" \|\| !lastSession\) return null;/, "no linked generating session — no invented activity");
    assert.match(page, /runActivity\(\)[\s\S]*?toolUseId\]\s*=\s*true/, "resolved tool results tracked from the same session events");
    assert.match(page, /if \(last\.type === "user" \|\| last\.type === "tool_result"\) return { busy: true, label: "Generating" };/);
    assert.match(page, /Date\.now\(\) - lastGrowthAt < QUIET_MS/, "recent recording growth keeps Generating during a quiet gap");
    assert.match(page, /return { busy: false, label: "Running" };/, "quiet complete turn falls back to plain Running");
    assert.ok(page.includes("lastGrowthAt = Date.now(); // the recording actually grew this poll"), "growth timestamp fed by the session poll");
    // Synced every poll and on keystrokes; exited/gone copy never clobbered.
    assert.match(page, /updateContinueComposer\(\);\s*syncRunFeedback\(\);/, "feedback syncs with every applied session poll");
    assert.match(page, /function syncEmpty\(\)[\s\S]{0,200}?syncRunFeedback\(\);/, "keystrokes resync the affordance");
    assert.match(page, /function syncRunFeedback\(\)[\s\S]{0,220}?(stopped \|\| continueMode \|\| runDone\(\))/, "done/continue states opt out before touching the strip");
    assert.match(page, /getAttribute\("data-state"\) === "running"/, "only the running strip text is activity-driven");
    // The animated ellipsis is real markup shown only under data-busy.
    assert.ok(page.includes('<span class="status-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span>'));
    assert.match(page, /\.composer-status\[data-busy="true"\] \.status-dots\s*{\s*display:\s*inline;\s*}/);
    assert.match(page, /\.status-dots\s*{\s*display:\s*none;/, "dots hidden unless busy");
    assert.match(page, /@keyframes status-dot-pulse/);
  });
});

describe("run page — client-held follow-up queue (chat-composer fact cmqu)", () => {
  test("a non-empty submit while the agent is busy is HELD as a visible queue row, never silently sent", () => {
    const page = html();
    // Queue block renders above the status strip, hidden while empty.
    const queueAt = page.indexOf('id="composerQueue"');
    const stripAt = page.indexOf('id="composerStatus"');
    assert.ok(queueAt >= 0 && stripAt > queueAt, "queue block sits above the status strip");
    assert.match(page, /<div class="composer-queue" id="composerQueue" hidden>/);
    assert.match(page, /<span id="queueCount">0 in queue<\/span>/);
    assert.match(page, /id="queueHead"[^>]*aria-expanded="true"[^>]*title="[^"]*there is no server-side queue[^"]*"/, "the header admits the queue is page-held");
    // Submit branch: busy (or already-queued backlog) => enqueue, not send.
    assert.match(page, /if \(text\.length && \(agentBusyNow\(\) \|\| queue\.length\)\)\s*{[\s\S]{0,300}?enqueue\(text\);/, "busy submit holds the message; a backlog keeps order");
    assert.ok(page.includes('{ text: text, key: "Enter" }'), "ready submit still sends immediately");
    // Every row is real: edit (click text), remove (×), force-send (send now).
    assert.match(page, /queue-text[\s\S]{0,200}?Edit \\u2014 moves this follow-up back into the input/);
    assert.match(page, /queue-send-now[^>]*title="Send now/);
    assert.match(page, /queue-x[^>]*title="Remove from queue"/);
    assert.match(page, /closest\("\.queue-x"\)[\s\S]{0,80}?removeFromQueue\(qid\)/);
    assert.match(page, /closest\("\.queue-send-now"\)[\s\S]{0,80}?deliverItem\(q\)/);
    assert.match(page, /closest\("\.queue-text"\)[\s\S]{0,200}?inputText\.value = q\.text;/, "click-to-edit pulls the text back into the input");
    // Queue text is escaped before hitting innerHTML.
    assert.match(page, /escHtml\(q\.text\)/);
    // In-order auto-delivery, one in flight, only while live and ready.
    assert.match(page, /function maybeDeliver\(\)[\s\S]*?if \(lastState !== "running" && lastState !== "idle"\) return;[\s\S]*?if \(agentBusyNow\(\)\) return;[\s\S]*?deliverItem\(queue\[0\]\);/);
    assert.match(page, /lastGrowthAt <= lastDeliveryAt && Date\.now\(\) - lastDeliveryAt < 8000/, "next delivery waits for recording growth or the 8s guard");
    assert.match(page, /if \(queueDelivering \|\| q\.sending\) return;/, "one delivery in flight at a time");
    // Honest persistence + close guard + run-end note.
    assert.match(page, /var QUEUE_KEY = "tq-queue:" \+ runId;/);
    assert.match(page, /sessionStorage\.setItem\(QUEUE_KEY/, "queue persists per run");
    assert.match(page, /beforeunload[\s\S]{0,200}?queue\.length && !runDone\(\)/, "a live page with held follow-ups warns before closing");
    assert.match(page, /The run ended before these were sent \\u2014 nothing was delivered\./, "run end keeps undelivered rows honest");
  });
});

describe("run page — send affordance is state-aware during generation (chat-composer fact cmsm)", () => {
  test("busy+empty morphs the round button into a stop control; busy+text labels the queue consequence", () => {
    const page = html();
    // Two icons in the button; data-busy + data-empty pick one.
    assert.match(page, /<svg class="icon-send"[\s\S]{0,300}?<svg class="icon-stop"/, "send arrow and stop square coexist in the button");
    assert.match(page, /\.run-send-btn \.icon-stop\s*{\s*display:\s*none;\s*}/);
    assert.match(page, /\.composer-card\[data-busy="true"\]\[data-empty="true"\] \.run-send-btn\s*{[^}]*rgba\(255, 255, 255, 0\.92\)/, "stop morph is high-contrast, not dimmed");
    assert.match(page, /\.composer-card\[data-busy="true"\]\[data-empty="true"\] \.run-send-btn \.icon-send\s*{\s*display:\s*none;\s*}/);
    assert.match(page, /\.composer-card\[data-busy="true"\]\[data-empty="true"\] \.run-send-btn \.icon-stop\s*{\s*display:\s*block;\s*}/);
    // The morphed click interrupts and never submits; Enter keeps its bare-Enter contract.
    assert.match(page, /sendBtn\.addEventListener\("click"[\s\S]{0,700}?event\.preventDefault\(\);\s*sendInput\({ key: "C-c" }\);/);
    assert.match(page, /if \(event\.detail === 0 && document\.activeElement !== sendBtn\) return;/, "implicit form submission (Enter in the input) stays a bare Enter");
    assert.match(page, /Stop generating \\u2014 sends \^C to the agent's terminal/, "morphed title says what the click does");
    assert.match(page, /"aria-label", "Stop generating"/);
    // Busy + text: queue-labeled send + placeholder states the consequence.
    assert.match(page, /Queue follow-up \(Enter\) \\u2014 held on this page/);
    assert.match(page, /"aria-label", "Queue follow-up"/);
    assert.match(page, /inputText\.placeholder = "Queue a follow-up \\u2014 sends when the agent is ready";/);
    assert.match(page, /inputText\.placeholder = "Send a follow-up";/, "idle restores the original placeholder");
    // Continue mode is never touched by the morph.
    assert.match(page, /sendBtn\.addEventListener\("click"[\s\S]{0,120}?if \(continueMode \|\| inputText\.value\.length\) return;/);
    assert.match(page, /if \(stopped \|\| continueMode \|\| runDone\(\)\)\s*{\s*composerStatus\.removeAttribute\("data-busy"\);\s*inputRow\.removeAttribute\("data-busy"\);/);
  });
});

describe("run page — route registration", () => {
  test("/run is registered in ROUTE_MAP with the run page handler", () => {
    assert.equal(ROUTE_MAP["/run"], handleRun);
    assert.equal(typeof ROUTE_MAP["/run"], "function");
  });
});

// ---------------------------------------------------------------------------
// Unified-live: the read-only live-session watch page (liveSessionPage)
// ---------------------------------------------------------------------------

const LIVE_SESSION = {
  hash: "abcd1234",
  path: "/home/dev/.codex/sessions/2026/08/11/rollout-live.jsonl",
  source: "codex",
  project: "my-project",
  live: true,
  run: null,
};

function sessionHtml(overrides = {}) {
  return liveSessionPage({ session: { ...LIVE_SESSION, ...overrides } });
}

describe("live-session watch page — header and identity (unified-live)", () => {
  test("header carries the LIST identity row — source pill, hash, honest external origin chip, one status vocabulary", () => {
    const page = sessionHtml();
    assert.match(page, /^<!DOCTYPE html>/);
    assert.match(page, /<title>tracequest — running session abcd1234<\/title>/);
    assert.doesNotMatch(page, /<title>tracequest — live session/);
    // The exact chips the dashboard's external live row wears, same classes.
    assert.match(page, /<span class="session-source" style="background:#59d4a0">codex<\/span>/);
    assert.ok(page.includes('<span class="session-id" id="chatSessionId">abcd1234</span>'));
    assert.ok(page.includes('<span class="session-model" id="chatModel" hidden></span>'));
    assert.match(page, /<span class="run-origin" title="[^"]*outside tracequest[^"]*">external<\/span>/);
    // One vocabulary: a generating session reads as "running" on the badge
    // AND data-run-state — never live beside running.
    assert.ok(page.includes('id="runStatus" data-status="running">running</span>'));
    assert.ok(page.includes('data-run-state="running"'), "D1: watch page data-run-state is running");
    assert.ok(!page.includes('data-run-state="live"'), "D1: watch page does not stamp data-run-state live");
    assert.match(page, /<a class="run-back" href="\/sessions">&larr; sessions<\/a>/);
  });

  test("D1: generating watch page title and observer heading say running session, not live", () => {
    const live = sessionHtml({ live: true });
    assert.match(live, /<title>tracequest — running session abcd1234<\/title>/,
      "D1: generating /run?session= title uses running, not live");
    assert.match(live, /id="observerTitle">Watching a running session<\/span>/,
      "D1: generating observer heading uses running");
    assert.ok(live.includes("the agent process is running but this recording has no turns"),
      "D1: empty-transcript marker uses running, not live");
    assert.ok(live.includes('document.title = "tracequest — " + word + " session " + sessionHandle'),
      "D1: paintWatchChrome retitles with running|idle");
    assert.ok(live.includes('observerTitle.textContent = word === "running" ? "Watching a running session" : "Watching an idle session"'),
      "D1: paintWatchChrome identity heading follows watchIdentityWord, never live");
    assert.doesNotMatch(live, /<title>tracequest — live session/,
      "D1: watch page title does not say live session");
    assert.doesNotMatch(live, /Watching a live session/,
      "D1: observer heading does not say Watching a live session");
    assert.doesNotMatch(live, /the agent process is live/,
      "D1: empty-transcript marker does not say the agent process is live");
    assert.match(live, /id="observerNoteTail">The transcript updates as the agent works; to steer it, use the terminal where it is running\.<\/span>/,
      "D1: generating observer paragraph updates as the agent works, never live");
    assert.doesNotMatch(live, /updates live as the agent works/,
      "D1: generating observer paragraph does not say updates live as the agent works");
    assert.doesNotMatch(live, /id="observerNoteTail">The agent is not generating right now/,
      "D1: generating first-paint observer tail is not the idle copy");
    assert.ok(live.includes('observerNoteTail.textContent = word === "running"'),
      "D1: paintWatchChrome identity paragraph follows watchIdentityWord, not the growth overlay");
    assert.doesNotMatch(live, /"Watch live"/,
      "D1: /run?session= palette fallback is not Watch live");
  });

  test("D1: idle watch page title and observer heading say idle session, not live", () => {
    const idle = sessionHtml({ live: false });
    assert.match(idle, /<title>tracequest — idle session abcd1234<\/title>/,
      "D1: idle /run?session= title uses idle, not live");
    assert.match(idle, /id="observerTitle">Watching an idle session<\/span>/,
      "D1: idle observer heading uses idle (idle TUI is not labeled live)");
    assert.doesNotMatch(idle, /id="observerTitle">Watching a running session/,
      "D1: idle first paint heading is idle, not running");
    assert.doesNotMatch(idle, /<title>tracequest — live session/);
    assert.doesNotMatch(idle, /Watching a live session/);
    assert.match(idle, /id="observerNoteTail">The agent is not generating right now; to steer it, use the terminal where it is running\.<\/span>/,
      "D1: idle G1 observer paragraph says the agent is not generating, not that it updates live");
    assert.doesNotMatch(idle, /updates live as the agent works/,
      "D1: idle G1 observer paragraph does not say updates live as the agent works");
    assert.doesNotMatch(idle, /id="observerNoteTail">The transcript updates as the agent works/,
      "D1: idle first-paint observer tail is not the generating copy");
    assert.doesNotMatch(idle, /"Watch live"/,
      "D1: idle /run?session= palette fallback is not Watch live");
  });

  test("D1: idle G1 /run?session= #runStatus stays idle inside QUIET_MS", () => {
    const insideQuiet = Date.now() - 500;
    const idle = paintWatchIdentityAfterPoll({
      live: false,
      etagMtime: insideQuiet,
    });
    assert.ok(insideQuiet > Date.now() - 4000, "etag mtime is inside QUIET_MS");
    assert.equal(idle.status, "idle", "idle G1 #runStatus stays idle inside the 4s quiet window");
    assert.equal(idle.text, "idle");
    assert.equal(idle.runState, "idle", "idle G1 data-run-state stays idle inside QUIET_MS");
    assert.match(idle.title, /idle session g1idle/, "idle G1 title stays idle session");
    assert.equal(idle.observerTitle, "Watching an idle session",
      "idle G1 observer heading stays idle, not Watching a running session");
    assert.equal(idle.growth, false,
      "completed idle G1 lastState follows identity, not QUIET_MS etag");
    assert.equal(idle.liveTail, "0", "exclusive live-tail Stop follows identity, not QUIET_MS");
    assert.equal(idle.liveTailFormHidden, true,
      "D1: idle G1 hides #liveTailForm (no Stop) inside QUIET_MS");
    assert.equal(idle.namedOutput, "leftover-snap",
      "D1: idle G1 leftover-snaps named-output (does not park a generating trail)");
    assert.notEqual(idle.namedCardContained, "parked",
      "D1: leftover-occupying named card is not data-contained=parked");
    assert.equal(idle.namedCardInHistory, false,
      "D1: leftover-occupying named card is not split into #chatHistory");
    assert.equal(idle.namedCardName, "shell output",
      "D1: leftover-occupying named card is the screenshot shell output");
    assert.equal(idle.namedCardMeta, "Lines 1-6",
      "D1: leftover-occupying named card keeps Lines 1-6 in the fold");
    assert.equal(idle.namedCardFold, true,
      "D1: named shell output occupies leftover");
    assert.equal(idle.namedOccupiesLeftover, true,
      "D1: named shell output occupies leftover pixels above the composer");
    assert.equal(idle.leftoverOpeningOnLeftover, true,
      "D1: leftover-owned pixels include opening prose occupying leftover");
    assert.equal(idle.leftoverClosingOnLeftover, true,
      "D1: leftover-owned pixels include closing prose occupying leftover");
    assert.match(idle.leftoverOpeningText || "", /I'll stop that process now/,
      "D1: leftover-owned opening is the screenshot opening prose");
    assert.match(idle.leftoverClosingText || "", /Port 7777 is free/,
      "D1: leftover-owned closing is the screenshot closing prose");
    assert.equal(idle.leftoverUserOnLeftover, false,
      "D1: user is off leftover (not occupying leftover pixels)");
    assert.ok(idle.leftover === idle.leftoverComposerTop - idle.leftoverTop,
      "D1: leftover bounds are production leftover = composer.top − leftover.top");
    assert.equal(idle.leftover, idle.leftoverClientHeight,
      "D1: leftover occupancy of leftover is leftover.clientHeight leftover viewport");
    assert.ok(idle.leftoverClientHeight > 0,
      "D1: leftover.clientHeight is leftover leftover viewport");
    assert.notEqual(idle.leftover, 560,
      "D1: leftover is not a hardcoded 0–560 leftover box");
    assert.ok(idle.leftoverNamedTop >= idle.leftoverTop - 1 && idle.leftoverNamedTop < idle.leftoverComposerTop,
      "D1: named card top is in leftover above .chat-composer");
    assert.ok(idle.leftoverNamedBottom <= idle.leftoverComposerTop + 1,
      "D1: named card does not extend under .chat-composer");
    assert.ok(idle.leftoverOwnedTop <= idle.leftoverTop + 1,
      "D1: leftover-owned named column starts at leftover top (opening occupies leftover)");
    assert.ok(idle.leftoverOwnedBottom < idle.leftoverComposerTop,
      "D1: leftover-owned closing has leftover air under closing (BAR leftover leftoverAir)");
    assert.ok(idle.leftover > idle.leftoverOwned,
      "D1: leftover occupancy of leftover-owned content is not leftover occupancy of leftover");
    assert.ok(idle.leftoverAir === idle.leftover - idle.leftoverOwned,
      "D1: leftoverAir is leftover − leftoverOwned of leftover leftover viewport");
    assert.ok(idle.leftoverAir > 8,
      "D1: BAR leftover has leftover air under closing; leftoverAir ≤ 8 is leftover occupancy of leftover-owned");
    assert.equal(idle.leftoverPreFirstNodeType, 3,
      "D1: production measurePreLines sees a text node in the named pre");
    assert.match(idle.namedCardText, /pid 2287 is gone/,
      "D1: leftover named card is the completed kill/shell output, not a prior dump");
    assert.equal(idle.priorDumpsParked, true,
      "D1: prior lsof/ps dumps do not occupy leftover");
    assert.equal(idle.leftoverSnapIsStale, false,
      "D1: production leftoverSnapIsStale does not treat G1 tool-then-prose as after-growth");
    const g1Asst = (idle.events || []).filter((e) => e.type === "assistant");
    assert.ok(g1Asst.some((e) => (e.toolCalls || []).some((t) => t.name === "Bash" && /kill/.test(String(t.input || "")))),
      "D1: real G1 fixture has named Bash/shell output (kill), not a tool-less stub");
    const g1Close = g1Asst[g1Asst.length - 1];
    assert.ok(g1Close && /Port 7777 is free/.test(g1Close.text || ""),
      "D1: real G1 fixture has closing prose after the named shell output");
    assert.ok(!idle.page.includes("if (firstOut >= 0 && lastAsst > firstOut) return true"),
      "D1: leftoverSnapIsStale does not treat G1 lastAsst > firstOut as after-growth");
    assert.doesNotMatch(idle.activityHtml, /shimmer/,
      "D1: idle G1 activityHtml does not shimmer inside QUIET_MS");
    assert.doesNotMatch(idle.activityHtml, /Planning next moves/,
      "D1: idle G1 does not emit Planning next moves under an idle chip");
    assert.equal(idle.continueFormHidden, false,
      "D1: idle G1 paints the visible Send a follow-up composer");
    assert.equal(idle.continuePlaceholder, "Send a follow-up",
      "D1: idle G1 composer is Send a follow-up, not Stop");
    assert.ok(idle.page.includes("var liveNow = word === \"running\""),
      "paintWatchChrome Stop composer follows identity word, not growth lastState");
    assert.ok(idle.page.includes("function watchFramesLiveTrail()"),
      "shared rerender does not frameLiveTrail off QUIET_MS lastState");
    const helperSrc = readFileSync(fileURLToPath(new URL("../helpers/render-watch-identity-vm.js", import.meta.url)), "utf8");
    assert.ok(!helperSrc.includes("function leftoverSnapIsStale() { return false; }"),
      "D1 does not stub leftoverSnapIsStale to false");
    assert.ok(!helperSrc.includes("function snapNamedOutputCard() { namedOutputMode = \"leftover-snap\"; }"),
      "D1 does not stub snapNamedOutputCard occupancy");
    assert.ok(!helperSrc.includes("function unparkAll() { namedOutputMode = namedOutputMode || \"leftover-snap\"; }"),
      "D1 does not stub unparkAll occupancy");
    assert.ok(!helperSrc.includes("function newestTurnOwnFile() { return false; }"),
      "D1 does not stub newestTurnOwnFile to false");
    assert.ok(helperSrc.includes("extractRange(page, \"escHtml\", \"rerender\")"),
      "D1 runs production leftover layout including production rerender");
    assert.ok(!helperSrc.includes("function rerender() {\n  lastBlocks = lastSession"),
      "D1 does not stub rerender occupancy");
    assert.ok(!helperSrc.includes("name.textContent = \"shell output\""),
      "D1 does not helper-bake the shell output fold caption");
    assert.ok(!helperSrc.includes("Lines 1-\" + n") && !helperSrc.includes("Lines 1-\"+"),
      "D1 does not helper-bake Lines 1-N fold captions");
    assert.ok(!helperSrc.includes("if (node.id === \"chatScroll\")") && !helperSrc.includes("bottom: 560"),
      "D1 leftover bounds are not hardcoded #chatScroll 0–560");
    assert.ok(helperSrc.includes("appendChild(chatThread)") && helperSrc.includes("chatScroll.appendChild"),
      "D1 parents #chatThread under leftover #chatScroll");
    assert.ok(helperSrc.includes("composer.top") && helperSrc.includes("leftover.top"),
      "D1 leftover occupancy uses leftover = composer.top − leftover.top");
    assert.ok(helperSrc.includes("leftover.clientHeight") && helperSrc.includes("leftover viewport"),
      "D1 leftover bounds are leftover.clientHeight leftover viewport");
    assert.ok(!helperSrc.includes("leftoverAir <= 8"),
      "D1 leftoverAir ≤ 8 is leftover occupancy of leftover-owned, not leftover occupancy of leftover");
    assert.ok(helperSrc.includes("leftover occupancy of leftover-owned content is not leftover occupancy of leftover"),
      "D1 leftover occupancy of leftover-owned content must not pass as leftover occupancy of leftover");
    assert.ok(helperSrc.includes("parseGrok") && helperSrc.includes("grok-idle"),
      "D1 leftover-snap uses the real G1 fixture");
    assert.ok(idle.page.includes("var QUIET_MS = 4000;"));
    assert.ok(idle.page.includes("function watchIdentityWord()"));
    assert.ok(idle.page.includes('typeof watchIdentityWord === "function" ? watchIdentityWord() : lastState'),
      "shared rerender cannot overwrite identity with growth lastState");

    const gen = paintWatchIdentityAfterPoll({ live: true, etagMtime: insideQuiet });
    assert.equal(gen.status, "running", "generating poll still paints #runStatus running");
    assert.equal(gen.runState, "running");
    assert.equal(gen.observerTitle, "Watching a running session");
    assert.equal(gen.liveTail, "1", "generating identity still uses exclusive live-tail Stop");
    assert.equal(gen.liveTailFormHidden, false, "generating identity still shows #liveTailForm Stop");
    assert.equal(gen.growth, true, "generating identity still sets growth lastState running");
    assert.equal(gen.namedOutput, "parked", "generating identity still parks leftover named-output");
    assert.match(gen.activityHtml, /Planning next moves/,
      "generating identity still shimmers Planning next moves");
    assert.equal(gen.continueFormHidden, true,
      "generating identity hides the archive follow-up composer behind Stop");

    const unmatched = paintWatchIdentityAfterPoll({
      live: false,
      etagMtime: Date.now() - 30_000,
      events: [
        { type: "user", text: "go" },
        { type: "assistant", text: "", toolCalls: [{ id: "t1", name: "Bash", input: "ls" }] },
      ],
    });
    assert.equal(unmatched.status, "idle",
      "unmatched tool_use overlay does not promote idle identity to running");
    assert.equal(unmatched.runState, "idle");
    assert.equal(unmatched.growth, true, "unmatched tool_use may still spin in-thread tools");
    assert.equal(unmatched.liveTail, "0", "unmatched tool_use does not unhide Stop under idle identity");
    assert.equal(unmatched.liveTailFormHidden, true,
      "unmatched tool_use keeps #liveTailForm hidden while identity is idle");
    assert.equal(unmatched.continueFormHidden, false,
      "unmatched tool_use keeps the Send a follow-up composer visible");
  });

  test("D1: leftover live-session copy is gone from /run destinations", () => {
    const launched = html();
    assert.match(launched, /title="Model reported by the session recording — run details"/,
      "D1: /run?id= model chip title is session recording, not live session recording");
    assert.doesNotMatch(launched, /Model reported by the live session recording/,
      "D1: /run?id= model chip title does not say live session recording");
    assert.doesNotMatch(launched, /"Watch live"/,
      "D1: /run?id= palette fallback is not Watch live");
    const watch = sessionHtml({ live: false });
    assert.doesNotMatch(watch, /Detected live session/,
      "D1: /run?session= does not title origin as Detected live session");
    assert.doesNotMatch(watch, /updates live as the agent works/,
      "D1: leftover observer phrase is gone from idle destination HTML");
  });

  test("view session cross-link is always visible (the recording is known up front)", () => {
    const page = sessionHtml();
    assert.match(page, /<a class="run-view-link" id="viewSessionLink" href="\/view\?path=[^"]+"[^>]*>view session<\/a>/);
    assert.ok(!page.includes("viewSessionLink.hidden"), "no hidden-until-linked dance — the path is known");
  });

  test("metadata is HTML-escaped", () => {
    const page = sessionHtml({ source: '<script>"x', project: '<em>"p' });
    assert.ok(!/<span class="session-source"[^>]*><script>/.test(page));
    assert.ok(page.includes("&lt;script&gt;&quot;x"));
    assert.ok(page.includes("&lt;em&gt;&quot;p"));
  });
});

describe("live-session watch page — identical transcript treatment", () => {
  test("the shared chat-transcript renderer is byte-identical to the run page's", () => {
    const runP = html();
    const sessP = sessionHtml();
    // The transcript chunk is one shared constant — spot anchors from each
    // of its regions must appear in BOTH pages.
    for (const anchor of [
      "function escHtml(s)",
      "function md(src)",
      "function buildBlocks(session, state)",
      "function hasUnresolvedToolUse(session)",
      "function recordingGrewRecently()",
      'function applyThreadItems(',
      "function renderBlocks(blocks)",
      "function isAtBottom()",
      "function rerender()",
      'chatThread.addEventListener("click"',
      "applyThreadItems(chatThread, items)",
    ]) {
      assert.ok(runP.includes(anchor), `run page missing ${anchor}`);
      assert.ok(sessP.includes(anchor), `session page missing ${anchor}`);
    }
    assert.ok(sessP.includes('<div class="chat-thread" id="chatThread">'));
    assert.ok(sessP.includes('<div class="chat-activity" id="chatActivity">'));
  });

  test("polls the session-keyed live endpoint with the etag flow at the run cadence", () => {
    const page = sessionHtml();
    assert.ok(page.includes(`var SESSION_POLL_MS = ${SESSION_POLL_MS};`));
    assert.ok(page.includes('"/api/sessions/live?id=" + encodeURIComponent(sessionHandle)'));
    assert.ok(page.includes('var sessionHandle = "abcd1234";'));
    assert.ok(page.includes('"&etag=" + encodeURIComponent(lastEtag)'));
    assert.ok(page.includes("data.unchanged"));
    assert.ok(page.includes('data-chat-polling="0"'));
    assert.ok(page.includes('document.addEventListener("visibilitychange"'));
  });

  test("liveness lapsing flips to an honest idle state but NEVER stops polling", () => {
    const page = sessionHtml();
    assert.match(page, /function setWatchState\(state\)/);
    assert.ok(page.includes('markerHtml("Not running", "transcript preserved \\u2014 still watching for changes")'));
    assert.match(page, /\.composer-status\[data-state="idle"\] \.status-dot\s*{[^}]*animation: none/);
    // Only gone (404) stops the loop — idle keeps scheduling.
    assert.match(page, /function markGone\([\s\S]*?stopped = true;/);
    assert.ok(page.includes("if (res.status === 404) { markGone(); return; }"));
    assert.ok(!page.includes("sessFinalDone"), "no exit-style final poll — an idle session can come back");
  });

  test("a not-live session server-renders the idle state", () => {
    const page = sessionHtml({ live: false });
    assert.ok(page.includes('data-run-state="idle"'));
    assert.ok(page.includes('id="runStatus" data-status="idle">idle</span>'));
    assert.ok(page.includes('data-state="idle"'));
    assert.ok(page.includes("Not running right now"));
    assert.match(page, /<title>tracequest — idle session abcd1234<\/title>/);
    assert.ok(page.includes("Watching an idle session"));
    assert.doesNotMatch(page, /Watching a live session/);
    assert.doesNotMatch(page, /<title>tracequest — live session/);
  });
});

describe("live-session watch page — growth-driven live tail (chat-ui fact cilg)", () => {
  test("recording growth or a trailing tool_use paints a live tail even when the process probe is idle", () => {
    const page = sessionHtml({ live: false });
    assert.ok(page.includes("var lastGrowthAt = 0;"), "first paint of an archive is not growth");
    assert.ok(page.includes("var QUIET_MS = 4000;"));
    assert.ok(page.includes("var apiLive = false;"), "process probe stays a separate signal");
    assert.match(page, /function hasUnresolvedToolUse\(session\)/);
    assert.match(page, /function recordingGrewRecently\(\)/);
    assert.match(page, /function deriveWatchLive\(\)/);
    assert.match(page, /function sessionLooksGenerating\(\)/);
    assert.ok(page.includes("if (hasUnresolvedToolUse(lastSession)) return true;"),
      "trailing tool_use without a result is in-progress");
    assert.ok(page.includes("function recordingGrewRecently()"),
      "quiet-window helper stays on the page");
    assert.ok(!/function deriveWatchLive\(\)[\s\S]*?if \(recordingGrewRecently\(\)\) return true/.test(page),
      "completed idle G1 etag inside QUIET_MS does not set growth lastState running");
    assert.ok(page.includes('setWatchState(deriveWatchLive() ? "running" : "idle")'),
      "growth lastState still uses deriveWatchLive (unmatched tool_use / identity)");
    assert.ok(page.includes("function watchIdentityWord()"),
      "identity chrome is a separate detectLiveSessions word");
    assert.ok(page.includes('return apiLive ? "running" : "idle"'),
      "watch identity is poll state / detectLiveSessions, not the quiet window");
    assert.ok(page.includes("var word = watchIdentityWord()"),
      "#runStatus / data-run-state / title read watchIdentityWord, not lastState");
    assert.ok(page.includes("var liveNow = word === \"running\""),
      "exclusive Stop / data-live-tail follows identity, not growth lastState");
    assert.match(page, /if \(data\.etag && data\.etag !== lastEtag\)/);
    assert.match(page, /parseInt\(String\(data\.etag\)\.split\("-"\)\[0\], 10\)/,
      "etag prefix is the recording mtime, so a file that just grew reads as live on the first poll");
    assert.ok(page.includes("if (liveNow) liveTailForm.setAttribute(\"data-busy\", \"true\")"),
      "exclusive live-ending composer is data-busy while identity is generating");
    assert.ok(page.includes('id="liveTailForm"'), "live ending is the slim composer, not a Generating strip");
    assert.ok(page.includes('markerHtml("Not running", "transcript preserved \\u2014 still watching for changes")'),
      "quiet complete recordings keep honest idle chrome");
  });
});

describe("live-session watch page — live trail not leftover dump (chat-ui fact jtc, cipa, cilp, cite)", () => {
  test("growing recordings park the previous completed turn off the fold", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /function parkPriorCompletedTurn\(/, "prior leftover-snap turn is parked");
      assert.match(page, /function parkNode\(/, "park zeros height without a costume");
      assert.match(page, /function unparkAll\(/, "idle restores parked nodes");
      assert.match(page, /function sizeLiveAir\(/, "live air helper remains so idle leftover styles clear");
      assert.match(page, /function frameLiveTrail\(/, "short trails stay prompt-anchored");
      assert.ok(!page.includes("var LIVE_TRAIL = 168"), "no manufactured trail-budget spacer");
      assert.ok(page.includes('setAttribute("data-contained", "parked")'),
        "live completed leftover is marked parked, not a trail costume");
      assert.ok(!page.includes('setAttribute("data-contained", "trail")'),
        "r10 22px data-trail costume is gone");
      assert.ok(!page.includes("function trailLabelForAssistant("),
        "no Wrote-the-answer one-line label");
      assert.ok(!page.includes("function collapseAssistantToTrail("),
        "do not crush the completed assistant to 22px");
      assert.ok(!page.includes("function collapseOutputToTrail("),
        "do not keep a fixture/Lines header on the fold");
      assert.ok(!page.includes("max-height: 22px"),
        "no 22px costume on parked leftover");
      assert.ok(page.includes("Do not leftover-snap-uncap"),
        "live no longer expands leftover-snap onto the fold");
      assert.ok(!/if \(lastState === "live"\) \{\s*for \(i = 0; i < cards\.length; i\+\+\) clearOutputCap\(cards\[i\]\);\s*return;/.test(page),
        "live branch does not clearOutputCap every named card");
      assert.ok(page.includes("chatActivity.style.minHeight = \"\""),
        "empty air is natural leftover viewport, not a fold-filling spacer");
      assert.ok(!page.includes("viewH - LIVE_TRAIL"),
        "do not fill the fold with #chatActivity min-height");
      assert.ok(page.includes("parkPriorCompletedTurn();"),
        "live parks the leftover-snap turn, not the current tools");
      assert.ok(page.includes("if (watchFramesLiveTrail() && followTail) frameLiveTrail()"),
        "resize still pins a following scroller after prior-turn parking");
    }
    const idle = sessionHtml({ live: false });
    assert.ok(idle.includes("Answer-first leftover snap"),
      "idle leftover-snap file object is unchanged");
    assert.ok(idle.includes('card.setAttribute("data-contained", "1")'),
      "idle completed card is still a contained file object");
    assert.ok(idle.includes("unparkAll();"),
      "idle restores parked leftover-snap nodes before leftover-snap");
    assert.match(idle, /id="liveTailForm"[^>]*hidden/, "idle still hides the live composer");
  });

  test("this turn live work is first under the prompt, not the last completed assistant", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /function thisTurnEventIndex\(/,
        "this turn is the live assistant event, not leftover-snap's last dump");
      assert.ok(page.includes('b.kind === "tool" && b.running && typeof b.eventIndex === "number"'),
        "running tools pick the live event");
      assert.ok(page.includes('setAttribute("data-event-index"'),
        "thread nodes carry the session event they belong to");
      assert.ok(page.includes("ev >= liveEv"),
        "nodes of this turn stay; earlier events park");
      assert.ok(!page.includes("function assistantIsCompleted("),
        "r11 following-assistant/output predicate is gone");
      assert.ok(page.includes("A completed measure-append with no following assistant/output"),
        "the last completed assistant parks once later tool_use is this turn");
      assert.ok(page.includes("the last completed assistant"),
        "park comment names the measure-append case");
    }
  });
});

function loadThisTurnEventIndex() {
  const page = html();
  const start = page.indexOf("function thisTurnEventIndex()");
  const end = page.indexOf("function parkPriorCompletedTurn()");
  assert.ok(start > 0 && end > start, "thisTurnEventIndex is embedded");
  const src = page.slice(start, end);
  return function thisTurn(blocks) {
    return new Function("lastBlocks", `${src}\nreturn thisTurnEventIndex();`)(blocks);
  };
}

describe("live-session watch page — live trail accumulates (chat-ui fact f9l)", () => {
  test("later assistant events keep earlier this-turn verb-object cards; leftover stays parked", () => {
    const page = html();
    assert.ok(page.includes("Later assistant events accumulate on the fold"),
      "this turn is not the newest assistant event alone");
    assert.ok(page.includes("ls | head stays"),
      "first this-turn card is named as staying");
    assert.ok(page.includes("if (firstLive < 0) firstLive = b.eventIndex"),
      "running-tool scan keeps the first live event, not the last");
    assert.ok(!/if \(b\.kind === "tool" && b\.running && typeof b\.eventIndex === "number"\) live = b\.eventIndex/.test(page),
      "last-running-tool cutoff that parked ls is gone");

    const thisTurn = loadThisTurnEventIndex();
    const leftover = [
      { kind: "user", eventIndex: 0 },
      { kind: "text", eventIndex: 1 },
      { kind: "tool", eventIndex: 1, res: { text: "fixture" } },
      { kind: "text", eventIndex: 2 },
    ];
    const seq1 = leftover.concat([
      { kind: "tool", eventIndex: 3, running: true, tc: { name: "Bash", input: "ls | head" } },
    ]);
    const seq2 = leftover.concat([
      { kind: "tool", eventIndex: 3, running: true, tc: { name: "Bash", input: "ls | head" } },
      { kind: "tool", eventIndex: 4, running: true, tc: { name: "Bash", input: "find" } },
      { kind: "tool", eventIndex: 4, running: true, tc: { name: "Bash", input: "rg leftover" } },
    ]);
    assert.equal(thisTurn(seq1), 3, "seq1 this turn starts at ls | head");
    assert.equal(thisTurn(seq2), 3, "seq2 keeps ls | head; find/rg do not raise the cutoff");
    assert.ok(thisTurn(seq2) < 4, "later assistant event is not the park floor");

    const lsDoneThenFind = leftover.concat([
      { kind: "tool", eventIndex: 3, res: { text: "README" }, tc: { name: "Bash", input: "ls | head" } },
      { kind: "tool", eventIndex: 4, running: true, tc: { name: "Bash", input: "find" } },
      { kind: "tool", eventIndex: 4, running: true, tc: { name: "Bash", input: "rg leftover" } },
    ]);
    assert.equal(thisTurn(lsDoneThenFind), 3,
      "completed this-turn ls stays when a later assistant brings find/rg");

    const batch = leftover.concat([
      { kind: "tool", eventIndex: 5, running: true, tc: { name: "Bash", input: "ls | head" } },
      { kind: "tool", eventIndex: 5, running: true, tc: { name: "Bash", input: "find" } },
      { kind: "tool", eventIndex: 5, running: true, tc: { name: "Bash", input: "rg leftover" } },
    ]);
    assert.equal(thisTurn(batch), 5, "frozen one-event trail still starts at that event");
    assert.equal(thisTurn(leftover), 2,
      "leftover-only still cuts at the last completed assistant (measure-append)");
  });
});

describe("live-session watch page — live tail sticks to the generating end (chat-ui fact cist)", () => {
  test("growing recordings pin #chatScroll to the live tail after leftover-snap chrome, unless the user scrolled up", () => {
    const page = sessionHtml({ live: false });
    assert.ok(page.includes("var followTail = true"), "first paint follows the conversation end");
    assert.match(page, /function pinLiveTail\(\)/);
    assert.ok(page.includes("if (state === \"running\") followTail = followTail || isAtBottom()"),
      "follow-tail is sampled before paintWatchChrome applies live chrome CSS");
    const sampleIdx = page.indexOf("if (state === \"running\") followTail = followTail || isAtBottom()");
    const paintIdx = page.indexOf("function setWatchState(state)");
    const chromeIdx = page.indexOf("function paintWatchChrome()");
    const callChrome = page.indexOf("paintWatchChrome();", paintIdx);
    assert.ok(sampleIdx > 0 && callChrome > sampleIdx,
      "setWatchState samples isAtBottom before it applies live-tail CSS");
    assert.ok(chromeIdx > callChrome, "paintWatchChrome is the chrome mutator, called after the sample");
    assert.ok(page.includes("body[data-live-tail=\"1\"] .chat-activity { min-height: 72px; }"),
      "the live chrome that used to poison isAtBottom is still the empty-air rule");
    assert.ok(page.includes("body[data-live-tail=\"1\"] .chat-col { padding-bottom: 56px; }"));
    assert.ok(page.includes("var stick = followTail || isAtBottom();"),
      "rerender does not re-sample after chrome has grown the column");
    assert.ok(page.includes("if (stick) frameLiveTrail();"),
      "a following scroller pins after live-trail collapse and activity paint");
    assert.ok(page.includes("pinLiveTail();"),
      "a trail that overflows the fold still sticks Planning on screen");
    assert.ok(page.includes("followTail = isAtBottom()"),
      "a user who scrolled up is not yanked to the tail");
    assert.ok(page.includes("pinningTail"),
      "programmatic pinLiveTail does not count as the user scrolling up");
  });
});

describe("live-session watch page — live tail replaces observer chrome (chat-ui fact cilt)", () => {
  test("a live/growing recording ends the conversation column on the live tail, not the archive observer stack", () => {
    const live = sessionHtml({ live: true });
    assert.match(live, /data-live-tail="1"/, "first paint of a live session is already live-tail");
    assert.match(live, /id="archiveEnding" hidden/, "archive ending is out of the column");
    assert.ok(live.includes("body[data-live-tail=\"1\"] #archiveEnding"),
      "CSS keeps the whole archive slot out of the live column");
    assert.ok(live.includes("body[data-live-tail=\"1\"] .composer-status"),
      "the Generating/Stop status strip is not a second live bar");
    assert.ok(live.includes("body[data-live-tail=\"1\"] #continueForm"));
    assert.ok(live.includes('id="liveTailForm"'), "slim follow-up composer is present");
    assert.ok(live.includes('id="liveTailStop"'), "composer carries a Stop control");
    assert.match(live, /placeholder="Send a follow-up"/);
    assert.ok(live.includes('data-mode="live-tail"'));
    assert.ok(live.includes("body[data-live-tail=\"1\"] .observer-card"),
      "CSS keeps archive chrome out of the live column");
    assert.ok(live.includes("body[data-live-tail=\"1\"] .readonly-chip"));
    assert.ok(live.includes("archiveEnding.hidden = liveNow"),
      "paintWatchChrome hides the archive slot while the tail is live");
    assert.ok(live.includes("observerCard.hidden = liveNow"));
    assert.ok(live.includes("readonlyChip.hidden = liveNow"));
    assert.ok(live.includes('document.body.setAttribute("data-live-tail", liveNow ? "1" : "0")'));
    assert.ok(!live.includes('contForm.setAttribute("data-mode", liveNow ? "live-tail" : "continue")'),
      "takeover composer is never restyled into the live tail");
    // Archive copy stays in markup for the idle restore, but is not the live ending.
    assert.match(live, /Watching a running session/);
    assert.doesNotMatch(live, /Watching a live session/);
    assert.match(live, /Open full session view/);
    assert.match(live, /Export markdown/);
    assert.match(live, />watch-only</);
  });

  test("a quiet complete recording restores the observer stack and retires the live-tail composer", () => {
    const idle = sessionHtml({ live: false });
    assert.match(idle, /data-live-tail="0"/);
    assert.match(idle, /id="archiveEnding">/, "archive ending is in the column again");
    assert.ok(!/id="archiveEnding" hidden/.test(idle));
    assert.match(idle, /id="observerCard">/, "observer card is in the column again");
    assert.ok(!/id="readonlyChip"[^>]*hidden/.test(idle), "WATCH-ONLY returns when idle");
    assert.match(idle, /id="liveTailForm"[^>]*hidden/, "slim composer hides when idle");
    assert.ok(idle.includes("Not running right now — transcript preserved, still watching"));
    assert.ok(idle.includes("Watching an idle session"));
    assert.doesNotMatch(idle, /Watching a live session/);
    assert.ok(idle.includes("Open full session view"));
  });

  test("a continuable live session keeps the takeover composer in the archive slot", () => {
    const live = sessionHtml({ live: true, continuable: true, agent: "claude", source: "claude" });
    assert.match(live, /id="continueForm"[^>]*data-mode="continue"/);
    assert.ok(!/id="continueForm"[^>]*data-mode="live-tail"/.test(live),
      "takeover form is never the live ending");
    assert.ok(live.includes('id="liveTailForm"'), "exclusive slim composer is the live ending");
    assert.match(live, /id="liveTailForm"[^>]*data-mode="live-tail"/);
    assert.match(live, /placeholder="Send a follow-up"/);
    assert.ok(live.includes('class="icon-stop"'), "live composer right control is Stop");
    const idle = sessionHtml({ live: false, continuable: true, agent: "claude", source: "claude" });
    assert.match(idle, /id="continueForm"[^>]*data-mode="continue"/);
    assert.match(idle, /id="continueInput"[^>]*placeholder="Send a follow-up"/,
      "idle slim continue uses the same placeholder as the live tail");
    assert.ok(idle.includes("continues as a new run"));
  });
});

describe("live-session watch page — exclusive live-ending composer (chat-ui fact cilc)", () => {
  test("a live recording ends on one slim generating composer, not a two-tier strip + follow-up stack", () => {
    const live = sessionHtml({ live: true, continuable: true, agent: "claude", source: "claude" });
    assert.match(live, /id="archiveEnding" hidden/, "status strip + observer + takeover leave together");
    assert.match(live, /id="liveTailForm"[^>]*(data-busy="true"|data-mode="live-tail")/);
    assert.ok(!/id="liveTailForm"[^>]*hidden/.test(live), "the slim composer is the visible ending");
    assert.ok(!live.includes('id="statusText">Generating</span>'),
      "no Generating status strip on the live ending");
    assert.ok(!live.includes('id="watchStopBtn"'),
      "Stop is not a second bar above the composer");
    const formIdx = live.indexOf('id="liveTailForm"');
    const stopIdx = live.indexOf('id="liveTailStop"');
    const archiveIdx = live.indexOf('id="archiveEnding"');
    assert.ok(formIdx > 0 && stopIdx > formIdx, "Stop lives on the slim composer");
    assert.ok(archiveIdx > 0 && archiveIdx < formIdx, "archive slot precedes the exclusive composer");
    assert.match(live, /live-tail-card \.run-send-btn \.icon-send \{ display: none; \}/);
    assert.match(live, /live-tail-card \.run-send-btn \.icon-stop \{ display: block; \}/);
    assert.ok(live.includes("body[data-live-tail=\"1\"] .composer-status"),
      "CSS cannot show the status strip beside the slim composer");
    assert.ok(live.includes('contForm.setAttribute("data-mode", "continue")'),
      "paintWatchChrome never puts #continueForm into live-tail mode");
  });
});

describe("live-session watch page — honest read-only state (no fake composer)", () => {
  test("no input box, no send, no stop/kill — the session is driven outside tracequest", () => {
    const page = sessionHtml();
    assert.ok(!page.includes('id="inputRow"'), "no steerable run composer form");
    assert.ok(!page.includes('id="inputText"'), "no run text input");
    assert.ok(!page.includes('id="sendBtn"'), "no run send button");
    assert.ok(!page.includes('id="stopBtn"') && !page.includes('id="killBtn"'), "no run stop/kill — live-tail Stop is watch-local");
    assert.ok(!page.includes("/api/runs/input"), "no input wiring at all");
    assert.ok(!page.includes('id="terminalDetails"'), "no raw tmux terminal — there is no pane");
  });

  test("the observer card says exactly what this is and what IS possible", () => {
    const page = sessionHtml({ live: false });
    assert.match(page, /<span class="readonly-chip"[^>]*>watch-only<\/span>/);
    assert.ok(page.includes("Not running right now — transcript preserved, still watching"));
    assert.match(page, /Watching an idle session/);
    assert.doesNotMatch(page, /Watching a live session/);
    assert.match(page, /started outside tracequest[\s\S]*?no composer here/);
    assert.match(page, /to steer it, use the terminal where it is running/);
    assert.match(page, /<a class="observer-btn" href="\/view\?path=[^"]+">Open full session view<\/a>/);
    assert.match(page, /<a class="observer-btn" href="\/markdown\?path=[^"]+">Export markdown<\/a>/);
  });

  test("a session that IS some run's recording cross-links into the steerable run chat", () => {
    const withRun = sessionHtml({ run: { id: "@7", status: "running" } });
    assert.match(withRun, /<a class="observer-btn accent" href="\/run\?id=%407"[^>]*>Open run chat @7<\/a>/);
    assert.ok(!sessionHtml().includes("Open run chat"), "no run link when nobody owns the recording");
  });
});

describe("watch pages — app shell (the chat lives inside tracequest)", () => {
  test("both watch pages render the tracequest shell: wordmark header, live counter, New run launcher", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /<a class="app-wordmark" href="\/">tracequest<\/a>/, "wordmark links home");
      assert.ok(page.includes('<span class="app-live" id="appLive" hidden>'), "origin-agnostic live counter");
      assert.ok(page.includes('class="new-run-btn" id="newRunBtn"'), "same New run button as the dashboard");
      assert.ok(page.includes('id="launchOverlay"'), "launcher modal embedded — start a run from any chat");
      assert.ok(page.includes("var _INIT_DATA"), "launcher defaultCwd payload present");
    }
    // The run page prefills the launcher with the open run's cwd.
    assert.ok(html().includes('var _INIT_DATA = { defaultCwd: "/home/dev/project" }'));
  });

  test("both watch pages render the persistent session rail beside the chat pane", () => {
    for (const page of [html(), sessionHtml()]) {
      // ONE noun: the rail is "Sessions", matching its own "All sessions" foot
      // link and the dashboard heading (no agents/sessions vocabulary split).
      assert.match(page, /<aside class="agent-rail" aria-label="Sessions">/);
      assert.match(page, /<div class="rail-head">Sessions <span class="rail-count" id="railCount">/);
      assert.ok(!page.includes('<span class="app-crumb">agents</span>'), "no agents crumb — the crumb says sessions");
      assert.ok(page.includes('<span class="app-crumb">sessions</span>'));
      assert.ok(page.includes('<nav class="rail-list" id="railList">'), "client-rendered rail list");
      assert.match(page, /<a class="rail-all" href="\/sessions">All sessions &rarr;<\/a>/, "inventory pinned at the rail foot");
      assert.ok(page.includes('fetch("/api/runs")'), "rail polls runs");
      assert.ok(page.includes('"/api/sessions?pageSize=50"') || page.includes("/api/sessions?pageSize=50"), "rail lists recent sessions too");
      assert.ok(page.includes("function sessionsQueryUrl("), "rail filter query is sent to /api/sessions");
      assert.ok(page.includes('aria-current="page"'), "the open chat's rail row is highlighted");
      assert.match(page, /\.rail-row\[aria-current="page"\]\s*\{[^}]*box-shadow:\s*inset 0 0 28px 10px rgba\(139, 124, 246, 0\.14\)/,
        "selected rail row uses a soft accent inner glow");
      assert.ok(!page.includes("inset 2px 0 0 var(--accent)"),
        "selected rail row has no hard left accent bar");
      assert.ok(page.includes('"/run?session=" + encodeURIComponent(ls.id)'), "external live rows link to their live chat");
    }
    assert.ok(html().includes('var RAIL_CURRENT = {"type":"run","id":"@3"}'));
    assert.ok(sessionHtml().includes('var RAIL_CURRENT = {"type":"session","id":"abcd1234"}'));
  });

  test("rail rows carry the live activity line for launched AND external agents alike", () => {
    for (const page of [html(), sessionHtml()]) {
      // Run rows: the server-derived activity line while running.
      assert.ok(page.includes('railEsc(run.activity || (run.sessionPath ? "Working\\u2026" : "Waiting for the agent session\\u2026"))'),
        "running run rows lead with the activity line");
      // External live rows: the SAME activity treatment (origin is a suffix,
      // not a different anatomy) — /api/sessions serves liveSessions[].activity.
      assert.ok(page.includes('(ls.activity ? railEsc(ls.activity) : agentBit(ls.source, ls.project)) + " &middot; external"'),
        "external live rows lead with the same activity line");
    }
  });

  test("D1: chat-page renderRail #appLive requires s.live === true", () => {
    for (const page of [html(), sessionHtml()]) {
      assert.match(page, /if \(ls\.live !== true\) continue/,
        "renderRail skips _liveSessions entries that are not the detectLiveSessions bit");
      assert.match(page, /status: ls\.live === true \? "running" : "idle"/,
        "external rail-row status is s.live, never hardcoded running");
      assert.doesNotMatch(page, /status: "running"/,
        "renderRail does not hardcode status running from membership");
      assert.match(page, /function liveNow\(/,
        "chat-page shell embeds the shared liveNow() counter");
      assert.match(page, /var liveN = liveNow\(\)/,
        "renderRail paints #appLive from liveNow(), not a filtered loop");
      assert.match(page, /liveN \+ " running"/,
        "chat-page #appLive / railCount print N running");
      assert.match(page, /dashStat\('<span style="color:#4ade80">' \+ liveCount \+ "<\/span>", "running"\)/,
        "chat-page Overview dashStat label is running");
      assert.doesNotMatch(page, /liveN \+ " live"/,
        "chat-page count chrome does not print N live");
      assert.doesNotMatch(page, /dashStat\('<span style="color:#4ade80">' \+ liveCount \+ "<\/span>", "live"\)/,
        "chat-page Overview dashStat label is not live");
    }

    const g1 = {
      path: "/tmp/g1-idle.jsonl",
      id: "g1-idle",
      source: "grok",
      project: "sample-app",
      prompt: "Send a follow-up",
      live: false,
      mtime: Date.now(),
    };
    const g2 = {
      ...g1,
      path: "/tmp/g2-gen.jsonl",
      id: "g2-gen",
      prompt: "generating now",
      live: true,
      activity: "Working",
    };

    const mixed = renderChatRail({
      sessions: [g1, g2],
      liveSessions: [g1, g2],
    });
    assertChatRailLiveCount(mixed, 1, "G1 leak + G2 generating: chat-page #appLive is 1");
    assert.match(
      mixed.html,
      /href="\/run\?session=g2-gen"[^>]*><span class="rail-glyph" data-status="running"/,
      "G2 generating is a running rail glyph from s.live === true",
    );
    assert.doesNotMatch(
      mixed.html,
      /href="\/run\?session=g1-idle"[^>]*><span class="rail-glyph" data-status="running"/,
      "G1 idle-open is not a running rail glyph",
    );
    assert.match(
      mixed.html,
      /href="\/run\?session=g1-idle"[^>]*><span class="rail-glyph" data-status="done"/,
      "G1 stays an inventory done row, not a live row",
    );

    const leaked = renderChatRail({
      sessions: [g1],
      liveSessions: [{ ...g1, live: false }, { path: "/tmp/no-bit.jsonl", id: "no-bit", source: "grok" }],
    });
    assertChatRailLiveCount(leaked, 0, "live:false / missing-bit leak does not paint chat-page #appLive");
    assert.doesNotMatch(leaked.html, /data-status="running"/);

    const withRun = renderChatRail({
      runs: [{
        id: "@1",
        status: "running",
        agent: "claude",
        cwd: "/tmp/p",
        startedAt: new Date().toISOString(),
        prompt: "go",
      }],
      sessions: [g1],
      liveSessions: [g1, g2],
      stats: { totalSessions: 2 },
    });
    assertChatRailLiveCount(withRun, 2, "pending tmux-running run + G2 live; G1 leak excluded");

    const idleLaunched = renderChatRail({
      runs: [{
        id: "@idle",
        status: "idle",
        sessionPath: g1.path,
        agent: "grok",
        cwd: "/tmp/sample-app",
        startedAt: new Date().toISOString(),
        prompt: "Send a follow-up",
      }],
      sessions: [g1],
      liveSessions: [{ ...g1, live: false }],
      stats: { totalSessions: 1 },
    });
    assertChatRailLiveCount(idleLaunched, 0, "idle launched window (tmux running, recording settled) does not increment #appLive");
    assert.match(
      idleLaunched.html,
      /href="\/run\?id=%40idle"[^>]*><span class="rail-glyph" data-status="idle"/,
      "idle launched rail glyph is idle, not running",
    );
    assert.doesNotMatch(
      idleLaunched.html,
      /href="\/run\?id=%40idle"[^>]*><span class="rail-glyph" data-status="running"/,
      "idle launched window is not a running rail glyph",
    );

    const genLaunched = renderChatRail({
      runs: [{
        id: "@gen",
        status: "running",
        sessionPath: g2.path,
        agent: "grok",
        cwd: "/tmp/sample-app",
        startedAt: new Date().toISOString(),
        prompt: "generating now",
        activity: "Working",
      }],
      sessions: [g2],
      liveSessions: [g2],
      stats: { totalSessions: 1 },
    });
    assertChatRailLiveCount(genLaunched, 1, "generating launched window (tmux running, recording in detectLiveSessions) is 1");
    assert.match(
      genLaunched.html,
      /href="\/run\?id=%40gen"[^>]*><span class="rail-glyph" data-status="running"/,
      "generating launched rail glyph is running",
    );

    const withExited = renderChatRail({
      runs: [{
        id: "@done",
        status: "exited",
        sessionPath: g2.path,
        agent: "grok",
        cwd: "/tmp/p",
        startedAt: new Date().toISOString(),
        prompt: "done",
      }],
      sessions: [g1, g2],
      liveSessions: [g1, g2],
      stats: { totalSessions: 2 },
    });
    assertChatRailLiveCount(withExited, 1, "exited-run-linked G2: chat #appLive is 1");
    assert.doesNotMatch(
      withExited.html,
      /href="\/run\?session=g2-gen"[^>]*><span class="rail-glyph" data-status="running"/,
      "rail list still absorbs G2 into the exited run row",
    );

    const filtered = renderChatRail({
      sessions: [g1, g2],
      liveSessions: [g1, g2],
      railExpr: "source:claude",
    });
    assertChatRailLiveCount(filtered, 1, "source:claude vs grok G2: chat #appLive stays 1");
    assert.doesNotMatch(
      filtered.html,
      /data-status="running"/,
      "rail list filter stays local: grok G2 is not a visible running row",
    );
  });

  test("D1: launched-run #runStatus / #composerStatus / activityHtml / session state are generating, not tmux", () => {
    const page = html();
    assert.match(
      page,
      /function runIsLive\(r\) \{\s*return !!\(r && r\.status === "running"\);\s*\}/,
      "D1: runIsLive consumes r.status === running, not a second _liveSessions snapshot",
    );
    assert.match(
      page,
      /lastState = data\.link === "pending" && word === "running"\s*\?\s*"pending"\s*:\s*word;/,
      "D1: applySession lastState is the generating word, not live beside running",
    );
    assert.match(page, /function runIdentityStatus\(/,
      "run page embeds runIdentityStatus next to runIsLive");
    assert.match(page, /function currentRunIdentityStatus\(/,
      "shell resolves the open run's identity from runIsLive");
    assert.match(page, /window\._currentRunIdentityStatus = currentRunIdentityStatus/,
      "rail identity still shares runIdentityStatus with the list");
    assert.match(page, /runStatusEl\.setAttribute\("data-status", word\)/,
      "updateHeaderIdentity paints #runStatus from runIsLive, not only id/model/stats/grade");
    assert.match(
      page,
      /if \(status === "running" \|\| status === "idle"\) \{\s*terminal\.setAttribute\("data-status", "running"\);/,
      "snapshot poll still marks the raw terminal pane-alive",
    );
    assert.match(
      page,
      /setStatus\(data\.status === "idle" \? "idle" : "running"\)/,
      "snapshot poll paints identity from snapshot generating status",
    );

    const idleRun = {
      id: "@idle",
      agent: "grok",
      cwd: "/tmp/sample-app",
      startedAt: "2026-08-10T12:00:00.000Z",
      status: "idle",
      sessionPath: "/tmp/g1-idle.jsonl",
      live: false,
      prompt: "Send a follow-up",
    };
    const genRun = {
      ...idleRun,
      id: "@gen",
      status: "running",
      sessionPath: "/tmp/g2-gen.jsonl",
      live: true,
      prompt: "generating now",
    };

    const idle = paintLaunchedRunIdentity({
      run: idleRun,
      liveSessions: [{ path: idleRun.sessionPath, live: false, id: "g1-idle", source: "grok" }],
      sessionState: "idle",
    });
    assert.match(
      idle.page,
      /id="runStatus" data-status="idle">idle/,
      "runPage() SSR of idle launched G1 is idle, not tmux running",
    );
    assert.doesNotMatch(
      idle.page,
      /id="runStatus" data-status="running">running/,
      "idle launched G1 SSR must not paint identity running",
    );
    assert.equal(idle.ssr, "idle");
    assert.match(idle.page, /data-run-state="idle"/, "D1: idle G1 data-run-state is idle");
    assert.doesNotMatch(idle.page, /data-run-state="live"/);
    assert.equal(idle.status, "idle", "setStatus after snapshot poll does not paint tmux running");
    assert.equal(idle.text, "idle");
    assert.equal(idle.terminalStatus, "running", "raw terminal may stay pane-alive");
    assert.equal(idle.composer.state, "idle", "idle launched G1 #composerStatus is idle, not Running");
    assert.equal(idle.composer.text, "Idle");
    assert.equal(idle.composer.stopHidden, true, "idle launched G1 hides Stop");
    assert.equal(idle.composer.killHidden, false, "idle launched G1 keeps Kill");
    assert.match(idle.activity, /Not running/, "idle launched G1 activity is not Planning next moves");
    assert.doesNotMatch(idle.activity, /Planning next moves/);
    assert.equal(idle.pollComposer.state, "idle", "session-poll idle paints composer idle");
    assert.equal(idle.pollComposer.stopHidden, true);
    assert.match(
      idle.page,
      /if \(lastState === "idle"\) return markerHtml\("Not running"/,
      "activityHtml idle branch is the generating bit, not tmux live",
    );
    assert.match(
      idle.page,
      /else if \(word === "idle"\) \{\s*setComposerState\("idle", "Idle"\);\s*setStatus\("idle"\);/,
      "applySession maps poll status idle onto #composerStatus and #runStatus",
    );

    const gen = paintLaunchedRunIdentity({
      run: genRun,
      liveSessions: [{ path: genRun.sessionPath, live: true, id: "g2-gen", source: "grok" }],
      sessionState: "running",
    });
    assert.match(
      gen.page,
      /id="runStatus" data-status="running">running/,
      "runPage() SSR of generating launched G2 is running",
    );
    assert.equal(gen.ssr, "running");
    assert.match(gen.page, /data-run-state="running"/, "D1: generating G2 data-run-state is running");
    assert.doesNotMatch(gen.page, /data-run-state="live"/, "D1: generating G2 does not split live vs running");
    assert.equal(gen.status, "running", "setStatus after snapshot poll keeps generating running");
    assert.equal(gen.terminalStatus, "running");
    assert.equal(gen.composer.state, "running", "generating launched G2 #composerStatus is running");
    assert.equal(gen.composer.text, "Running");
    assert.equal(gen.composer.stopHidden, false);
    assert.equal(gen.composer.killHidden, false);
    assert.match(gen.activity, /Planning next moves/, "generating launched G2 keeps the in-progress marker");
    assert.equal(gen.pollComposer.state, "running");
    assert.equal(gen.pollComposer.stopHidden, false);

    const pending = paintLaunchedRunIdentity({
      run: { id: "@3", agent: "claude", cwd: "/tmp/p", startedAt: "2026-08-10T12:00:00.000Z", status: "running" },
      liveSessions: [],
    });
    assert.equal(pending.ssr, "running", "pending first recording is first-token generating");
    assert.equal(pending.status, "running");

    const dead = paintLaunchedRunIdentity({
      run: { ...idleRun, status: "exited" },
      liveSessions: [],
      snapshotStatus: "exited",
    });
    assert.equal(dead.ssr, "exited");
    assert.equal(dead.status, "exited");
    assert.equal(dead.terminalStatus, "exited");
  });

  test("the chat header repeats the record's list identity row verbatim, not a raw path", () => {
    const page = html();
    assert.ok(!page.includes('class="run-cwd"'), "raw-path header span is gone");
    assert.match(page, /<span class="session-project" title="\/home\/dev\/project">project<\/span>/,
      "the list card's project chip, verbatim — cwd basename, full path as tooltip");
    assert.ok(page.includes('<span class="session-grade-badge run-grade" id="runGrade" hidden>'),
      "grade badge slot, fed from the indexed recording");
    assert.match(page, /<span class="run-started" data-started="2026-08-10T12:00:00.000Z">/,
      "started time re-rendered client-side as a relative age");
    // The list card's stat line, client-filled from the same polled objects.
    assert.ok(page.includes('<div class="session-stats chat-head-stats" id="chatStats" hidden></div>'),
      "stat-chip slot in the header");
    assert.ok(page.includes("function sessionStatChipsHtml("), "shared stat-chip builder embedded");
    assert.ok(page.includes("headStatsEl.innerHTML = chips"), "header stats filled client-side");
    assert.ok(page.includes("headIdEl.textContent = identity.id"), "run id swaps to the linked session hash — the list's idLabel");
    const sess = sessionHtml();
    assert.ok(sess.includes('id="runGrade"'), "watch page gets the same grade slot");
    assert.match(sess, /<span class="session-project" title="[^"]*">my-project<\/span>/);
    assert.ok(sess.includes('id="chatStats"'), "watch page gets the same stat slot");
  });

  test("the sessions text link is only the narrow-viewport escape hatch — the rail is the way back", () => {
    const page = html();
    assert.match(page, /@media \(min-width: 881px\) \{ \.run-back \{ display: none; \} \}/);
    assert.match(page, /@media \(max-width: 880px\) \{ \.agent-rail \{ display: none; \} \}/);
  });
});

// ---------------------------------------------------------------------------
// Continue composer: the finished thread keeps a live composer whose typing
// IS the continue (continue-resume lane; fact ikw + type-to-continue facts)
// ---------------------------------------------------------------------------

describe("run page — finished-run continue composer (typing IS the continue)", () => {
  test("the exited run re-arms the SAME composer card into continue mode, gated on canResume + linked recording", () => {
    const page = html({ status: "exited", canResume: true });
    // Gating is honest: canResume AND a linked recording AND a finished run.
    assert.match(page, /var offer = canResume && !!lastSessionPath && runDone\(\)/);
    assert.ok(page.includes('inputRow.setAttribute("data-mode", "continue")'), "same input card, continue mode");
    assert.ok(page.includes("inputRow.hidden = false"), "the composer comes BACK for a continuable finished run");
    assert.ok(page.includes('id="ctxContinueChip"'), "fork-semantics chip in the context row");
    assert.ok(page.includes("continues as a new run"));
    assert.match(page, /inputText\.placeholder = "Send a follow-up \\u2014 continues in a new run"/);
    // Terminal-only controls retire in continue mode.
    assert.match(page, /\.composer-card\[data-mode="continue"\] \.keys-wrap \{ display: none; \}/);
    // The bare status-strip Continue button is gone — the composer IS the affordance.
    assert.ok(!page.includes('id="continueBtn"'), "no bare Continue button");
  });

  test("continue submit POSTs {resumeSession, prompt} and hands the follow-up to the landing page", () => {
    const page = html({ status: "exited", canResume: true });
    assert.ok(page.includes('if (continueMode) { continueSubmit(); return; }'), "submit branches on continue mode");
    assert.match(page, /var body = \{ resumeSession: lastSessionPath \};[\s\S]*?if \(text\.length\) body\.prompt = text;/);
    assert.ok(page.includes('sessionStorage.setItem("tq-followup:" + data.id, body.prompt)'),
      "full follow-up text rides to the new run's page");
    assert.ok(page.includes('window.location.href = "/run?id=" + encodeURIComponent(data.id)'), "lands in the NEW run's chat");
  });

  test("a canResume:false agent keeps honest absence — the composer retires for good", () => {
    const page = html({ status: "exited", canResume: false });
    assert.ok(page.includes("var canResume = false"), "gate baked into the page");
    assert.ok(page.includes("if (runDone()) inputRow.hidden = true"), "no continue offer → composer stays retired");
  });

  test("vanished-cwd recovery: a needs:'cwd' 400 reveals an inline directory prompt and retries with explicit cwd", () => {
    const page = html({ status: "exited", canResume: true });
    assert.ok(page.includes('id="continueCwdRow"'), "inline directory row in the composer card");
    assert.ok(page.includes('id="continueCwdInput"'));
    assert.match(page, /if \(data && data\.needs === "cwd"\)/, "machine-readable recovery trigger");
    assert.ok(page.includes("continueCwdRow.hidden = false"));
    assert.match(page, /if \(!continueCwdRow\.hidden && continueCwdInput\.value\) body\.cwd = continueCwdInput\.value/,
      "next submit carries the explicit cwd");
  });

  test("a resumed run's page renders the delivered follow-up as an honest pending bubble until the fork recording carries it", () => {
    const page = html({ status: "running", resumedFrom: "feedbeef", prompt: "add the backoff test" });
    assert.ok(page.includes('var runPromptSnippet = "add the backoff test"'), "server snippet is the reload-safe fallback");
    assert.ok(page.includes('sessionStorage.getItem("tq-followup:" + runId)'), "full text preferred when handed over");
    assert.match(page, /chat-user chat-user-pending/, "pending bubble reuses the user-bubble anatomy");
    assert.ok(page.includes("Delivering your follow-up"));
    assert.match(page, /waiting for the fork recording to link/);
    assert.match(page, /function followupDelivered\(\)/, "bubble retires only once the transcript carries the message");
    assert.match(page, /\.chat-user-pending \{ border-style: dashed/, "pending bubble visibly provisional");
  });
});

describe("live-session watch page — observer continue composer", () => {
  test("a continuable external session gets a live composer under the observer card", () => {
    const page = sessionHtml({ source: "claude", continuable: true, agent: "claude", live: false });
    assert.ok(page.includes('id="continueForm"'), "continue composer form present");
    assert.match(page, /<form class="composer-card" id="continueForm" data-empty="true" data-mode="continue">/,
      "same composer-card design language as the run composer");
    assert.ok(page.includes('id="continueInput"'));
    assert.ok(page.includes('id="continueSendBtn"'));
    assert.match(page, /id="continueInput"[^>]*placeholder="Send a follow-up"/,
      "idle slim continue matches the live-tail placeholder");
    assert.ok(page.includes("claude"), "the resuming agent is named");
    // Honest note: watch-only transcript, typing continues as a NEW run.
    assert.match(page, /type a follow-up below/);
    assert.ok(!page.includes("Continue as a run &#8594;"), "no bare continue button — the composer IS the affordance");
  });

  test("observer continue submit POSTs {resumeSession, prompt}, hands over the follow-up, and recovers a vanished cwd inline", () => {
    const page = sessionHtml({ source: "claude", continuable: true, agent: "claude" });
    assert.match(page, /var body = \{ resumeSession: sessionHandle \};[\s\S]*?if \(prompt\) body\.prompt = prompt;/);
    assert.ok(page.includes('sessionStorage.setItem("tq-followup:" + data.id, body.prompt)'));
    assert.match(page, /if \(data && data\.needs === "cwd"\)/);
    assert.ok(page.includes('id="continueCwdRow"'));
    assert.ok(page.includes("contCwdRow.hidden = false"));
  });

  test("a non-continuable session keeps honest absence: no composer, unchanged note", () => {
    const page = sessionHtml(); // codex source, continuable unset
    assert.ok(!page.includes('id="continueForm"'), "no composer form element");
    assert.ok(!page.includes('id="continueInput"'));
    assert.match(page, /no composer here/, "the honest read-only note stays");
  });
});
