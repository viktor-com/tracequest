/**
 * Command palette shell — Cmd/Ctrl+K overlay chrome, a11y, providers,
 * and mount points. Fact anchors: cpk cpd cpe cpf cpx cpt cpa cpv cpr cpm cpi cph.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  COMMAND_PALETTE_CSS,
  COMMAND_PALETTE_HTML,
  COMMAND_PALETTE_CLIENT_JS,
  commandPaletteServeInject,
  injectCommandPalette,
} from "../../src/browser/command-palette.js";
import { appTopHtml } from "../../src/browser/app-chrome.js";
import { browserPageHTML } from "../../src/browser/browser-page-build.js";
import { runPage, liveSessionPage, chatHomePage } from "../../src/browser/run-page.js";
import { comparePage, compareLoadErrorPage } from "../../src/browser/compare-page.js";
import { renderHTML } from "../../src/render.js";
import { handleView } from "../../src/routes/route-handlers-pages.js";
import { emptyCompareSession } from "../helpers/minimal-session.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const INIT_EMPTY = '{"sessions":[],"total":0,"page":1,"pageSize":50,"stats":{},"liveSessions":[],"defaultCwd":"/home/dev"}';

function dashboardHtml() {
  return browserPageHTML(INIT_EMPTY, "");
}

function runHtml() {
  return runPage({
    run: {
      id: "@4",
      agent: "claude",
      cwd: "/home/dev/project",
      startedAt: "2026-08-10T12:00:00.000Z",
      status: "running",
    },
  });
}

function compareHtml() {
  return comparePage(
    emptyCompareSession(),
    emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }),
  );
}

describe("command palette shell", () => {
  test("the CommandPalette is a modal overlay object with a full-viewport dim/scrim", () => {
    const html = COMMAND_PALETTE_HTML;
    const css = COMMAND_PALETTE_CSS;
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(html, /class="cmdk-overlay"/);
    assert.match(html, /id="cmdkScrim"/);
    assert.match(html, /class="cmdk-scrim"/);
    assert.match(css, /\.cmdk-overlay \{/);
    assert.match(css, /position: fixed/);
    assert.match(css, /inset: 0/);
    assert.match(css, /\.cmdk-scrim \{/);
    assert.match(css, /position: absolute/);
    const scrimBlock = css.slice(css.indexOf(".cmdk-scrim {"), css.indexOf(".cmdk {"));
    assert.match(scrimBlock, /inset: 0/);
    assert.match(css, /body\.cmdk-open/);
    assert.match(css, /overflow: hidden/);
    assert.match(js, /cmdkScrim/);
    assert.match(js, /e\.target === overlay/);
    const dash = dashboardHtml();
    assert.ok(dash.includes('id="cmdkScrim"'), "dashboard mounts the scrim");
    assert.ok(dash.includes(".cmdk-scrim"), "dashboard includes scrim CSS");
    assert.ok(runHtml().includes('id="cmdkScrim"'), "run page mounts the scrim");
    assert.ok(compareHtml().includes('id="cmdkScrim"'), "compare mounts the scrim");
  });

  test("the CommandPalette is a modal dialog with a combobox input and a grouped listbox of results", () => {
    const html = COMMAND_PALETTE_HTML;
    assert.match(html, /id="cmdkOverlay"/);
    assert.match(html, /role="dialog"/);
    assert.match(html, /aria-modal="true"/);
    assert.match(html, /aria-label="Command menu"/);
    assert.match(html, /id="cmdkInput"/);
    assert.match(html, /role="combobox"/);
    assert.match(html, /placeholder="Type a command or search\.\.\."/);
    assert.match(html, /aria-controls="cmdkList"/);
    assert.match(html, /id="cmdkList"/);
    assert.match(html, /role="listbox"/);
    assert.match(html, /id="cmdkEmpty"/);
    assert.match(html, /id="cmdkContext"/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /cmdk-group-label/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /setAttribute\("role", "option"\)/);
  });

  test("Cmd/Ctrl+K toggles the CommandPalette on served WebUI pages", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /e\.metaKey \|\| e\.ctrlKey/);
    assert.match(js, /key === "k" \|\| key === "K"/);
    assert.match(js, /togglePalette/);
    assert.match(js, /function togglePalette\(\) \{\s*if \(isOpen\(\)\) closePalette\(\);\s*else openPalette\(\);/);
    assert.match(js, /document\.addEventListener\("keydown", onGlobalKey, true\)/);
    const dash = dashboardHtml();
    assert.ok(dash.includes("togglePalette"), "dashboard embeds toggle");
    assert.ok(runHtml().includes("togglePalette"), "run page embeds toggle");
    assert.ok(compareHtml().includes("togglePalette"), "compare embeds toggle");
  });

  test("an empty query shows grouped actions prioritized by the current page and a context chip when a run or session is open", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /hereGroup/);
    assert.match(js, /"This run"/);
    assert.match(js, /This session/);
    assert.match(js, /This page/);
    assert.match(js, /group: "Go to"/);
    assert.match(js, /group: "Search"/);
    assert.match(js, /groupPriority: 100/);
    assert.match(js, /function contextLabel/);
    assert.match(js, /Run · /);
    assert.match(js, /Chat · /);
    assert.match(js, /Session · /);
    assert.match(js, /contextWrap\.hidden = false/);
    assert.match(js, /Jump to transcript/);
    assert.match(js, /Jump to analytics/);
    assert.match(js, /Jump to raw terminal/);
    assert.match(js, /Jump to composer/);
    assert.match(js, /title: "Go to Runs"/);
    assert.match(js, /title: "Go to Chat"/);
    assert.match(js, /title: "Go to Compare"/);
    assert.match(js, /title: "New run"/);
  });

  test("context chip distinguishes Run, Chat, and rendered Session", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /function contextLabel/);
    assert.match(js, /ctx\.page === "run".*Run · /);
    assert.match(js, /ctx\.page === "session".*Chat · /);
    assert.match(js, /ctx\.page === "view"/);
    assert.match(js, /Session · /);
    assert.doesNotMatch(js, /ctx\.page === "session".*Session · /);
    assert.doesNotMatch(js, /ctx\.page === "view".*ctx\.viewTitle/);
  });

  test("empty query does not list the Search sessions fallback", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /if \(query && searchItem\) show\.push\(searchItem\)/);
    assert.doesNotMatch(js, /else if \(!query && searchItem\) show\.push\(searchItem\)/);
    assert.match(js, /var noResults = query && commands\.length === 0/);
    assert.match(js, /Search sessions/);
  });

  test("typing filters the grouped list; a query that matches no commands shows a no-results state plus a Search sessions fallback", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /function matches\(item, q\)/);
    assert.match(js, /input\.addEventListener\("input"/);
    assert.match(js, /No results found/);
    assert.match(js, /Search sessions/);
    assert.match(js, /kind: "search"/);
    assert.match(js, /Search sessions for/);
    assert.match(js, /\/sessions\?filter=/);
    assert.match(js, /var noResults = query && commands\.length === 0/);
  });

  test("Escape and backdrop dismiss the overlay and restore the previously focused element", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /key === "Escape"/);
    assert.match(js, /closePalette\(\)/);
    assert.match(js, /e\.target === overlay/);
    assert.match(js, /cmdkScrim/);
    assert.match(js, /prevFocus = document\.activeElement/);
    assert.match(js, /restoreOverlayFocus\(prevFocus, overlay\)/);
  });

  test("while the palette is open, keyboard focus stays inside the dialog — focus trap", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /setInert\(true\)/);
    assert.match(js, /setAttribute\("inert"/);
    assert.match(js, /key === "Tab"/);
    assert.match(js, /trapOverlayTab\(e, overlay\)/);
    assert.match(js, /input\.focus\(\)/);
    assert.match(js, /cmdk-open/);
  });

  test("Arrow keys move the highlighted result and Enter runs it", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /key === "ArrowDown"/);
    assert.match(js, /key === "ArrowUp"/);
    assert.match(js, /key === "Enter"/);
    assert.match(js, /function runActive/);
    assert.match(js, /function highlight/);
    assert.match(js, /aria-selected/);
    assert.match(js, /aria-activedescendant/);
  });


  test("later result kinds register via window.TracequestPalette.registerProvider without replacing the shell", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /window\.TracequestPalette = \{/);
    assert.match(js, /registerProvider: registerProvider/);
    assert.match(js, /unregisterProvider: unregisterProvider/);
    assert.match(js, /function registerProvider\(provider\)/);
    assert.match(js, /open: openPalette/);
    assert.match(js, /close: closePalette/);
    assert.match(js, /setContext:/);
    assert.match(js, /getContext: detectContext/);
    assert.ok(COMMAND_PALETTE_HTML.includes('id="cmdkOverlay"'), "shell markup stays the overlay");
  });

  test("Cmd/Ctrl+K is ignored during IME composition so CJK input does not toggle the CommandPalette mid-composition", () => {
    const js = COMMAND_PALETTE_CLIENT_JS;
    assert.match(js, /e\.isComposing \|\| e\.keyCode === 229/);
    assert.match(js, /if \(e\.isComposing \|\| e\.keyCode === 229\) return;/);
  });

  test("the shared app bar exposes a CommandPalette trigger", () => {
    const header = appTopHtml({ crumbHtml: '<span class="app-crumb">Runs</span>' });
    assert.match(header, /id="cmdkTrigger"/);
    assert.match(header, /class="cmdk-trigger"/);
    assert.match(header, /cmdk-trigger-kbd/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /Ctrl\+K/);
    assert.match(COMMAND_PALETTE_CLIENT_JS, /\\u2318K/);
    const dash = dashboardHtml();
    assert.match(dash, /id="cmdkTrigger"/);
    assert.ok(dash.includes("trigger.addEventListener"));
  });

  test("the CommandPalette is mounted on the Runs inventory", () => {
    const html = dashboardHtml();
    assert.match(html, /id="cmdkOverlay"/);
    assert.equal(html.split('id="cmdkOverlay"').length, 2, "exactly one overlay");
    assert.ok(html.includes(".cmdk-overlay"), "palette CSS in dashboard");
    assert.ok(html.includes("window.TracequestPalette"));
    assert.equal((html.match(/<style>/g) || []).length, 1, "still a single style block");
  });

  test("the CommandPalette is mounted on run/chat pages", () => {
    const run = runHtml();
    assert.match(run, /id="cmdkOverlay"/);
    assert.ok(run.includes("window.TracequestPalette"));
    const live = liveSessionPage({
      session: { hash: "abcd1234", path: "/tmp/s.jsonl", source: "claude", live: true, project: "p" },
    });
    assert.match(live, /id="cmdkOverlay"/);
    const home = chatHomePage({ defaultCwd: "/tmp" });
    assert.match(home, /id="cmdkOverlay"/);
  });

  test("the CommandPalette is mounted on compare", () => {
    const html = compareHtml();
    assert.match(html, /id="cmdkOverlay"/);
    assert.ok(html.includes("window.TracequestPalette"));
    const err = compareLoadErrorPage({ handle: "missing", status: 404, message: "nope" });
    assert.match(err, /id="cmdkOverlay"/);
  });

  test("the CommandPalette is mounted on served /view — not on standalone export", async () => {
    const sessionPath = "/tmp/view-palette.jsonl";
    const session = {
      sessionId: "view-palette-aaaa",
      path: sessionPath,
      source: "claude",
      events: [{ type: "user", text: "hello palette" }],
      stats: { toolCounts: {} },
    };
    const standalone = renderHTML(session);
    assert.ok(!standalone.includes('id="cmdkOverlay"'), "export HTML stays palette-free");

    const handle = sessionHash(sessionPath);
    const deps = {
      parseSession: () => session,
      renderHTML,
      findSessions: () => [{ path: sessionPath, source: "claude", project: "p", size: 1, mtime: Date.now() }],
      muxAvailable: () => false,
    };
    let status = null;
    let body = "";
    const res = {
      writeHead(s) { status = s; },
      end(b) { body = String(b); },
    };
    await handleView(null, res, new URL(`http://localhost/view?id=${encodeURIComponent(handle)}`), deps);
    assert.equal(status, 200);
    assert.match(body, /id="cmdkOverlay"/);
    assert.ok(body.includes("window.TracequestPalette"));

    let embedBody = "";
    const embedRes = {
      writeHead() {},
      end(b) { embedBody = String(b); },
    };
    await handleView(null, embedRes, new URL(`http://localhost/view?id=${encodeURIComponent(handle)}&embed=1`), deps);
    assert.ok(!embedBody.includes('id="cmdkOverlay"'), "embed view does not mount the palette");
  });

  test("injectCommandPalette is idempotent and commandPaletteServeInject includes css+html+js", () => {
    const once = injectCommandPalette("<html><body>x</body></html>");
    assert.ok(once.includes('id="cmdkOverlay"'));
    const twice = injectCommandPalette(once);
    assert.equal(twice.split('id="cmdkOverlay"').length, 2);
    const snippet = commandPaletteServeInject();
    assert.ok(snippet.includes("id=\"cmdk-css\""));
    assert.ok(snippet.includes("Type a command or search"));
    assert.ok(snippet.includes("registerProvider"));
  });
});
