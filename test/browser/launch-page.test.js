/**
 * Launcher integration structure tests — assertions on the dashboard-embedded
 * launcher modal (agent dropdown mount, cwd/prompt inputs, Start POST wiring,
 * in-flight guard, no-mux state, ?launch=1 auto-open), the /launch redirect,
 * and the dashboard header's New run control. Fact anchors: lalp, ladl
 * (launch-s3) and the chat-integration facts (ciln, cilr, cixl).
 *
 * Also home to the /run WATCH page fact anchors (lawp, lalv — launch-s4):
 * a browserless polling-viewer test plus playwright+tmux-gated live
 * scenarios (shared with test/browser/run-watch.playwright.test.js via
 * test/helpers/run-watch-scenarios.js) that run under `facts check` and
 * skip under `npm test` (TRACEQUEST_SKIP_PLAYWRIGHT=1).
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import {
  LAUNCHER_MODAL_CSS,
  LAUNCHER_MODAL_HTML,
  LAUNCHER_CLIENT_JS,
} from "../../src/browser/launch-page.js";
import { runPage } from "../../src/browser/run-page.js";
import { browserPageHTML } from "../../src/browser/browser-page-build.js";
import { ROUTE_MAP } from "../../src/routes.js";
import { handleLaunch, handleRun, handleView } from "../../src/routes/route-handlers-pages.js";
import { SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { SKIP_NO_TMUX } from "../helpers/tmux-gate.js";
import { createRunWatchHarness } from "../helpers/run-watch-scenarios.js";

const INIT_EMPTY = '{"sessions":[],"total":0,"page":1,"pageSize":50,"stats":{},"liveSessions":[],"defaultCwd":"/home/dev"}';

function dashboardHtml() {
  return browserPageHTML(INIT_EMPTY, "");
}

describe("launcher modal — dashboard-native launch surface", () => {
  test("launcher modal renders the form mounts inside the dashboard page", () => {
    const html = dashboardHtml();
    // The modal is embedded ONCE in the dashboard document.
    assert.ok(html.includes('id="launchOverlay"'), "overlay mount");
    assert.equal(html.split('id="launchOverlay"').length, 2, "exactly one overlay");
    assert.match(html, /<div class="launch-modal" role="dialog" aria-modal="true"/);
    assert.ok(html.includes('<form id="launchForm" data-launch-state="form">'));
    // Agent dropdown mount (filled client-side from /api/agents), cwd, prompt, Start.
    assert.ok(html.includes('<select class="launch-select" id="agentSelect">'));
    assert.ok(html.includes('id="agentsEmpty"'), "no-agents-detected state present");
    assert.ok(html.includes("no agents detected on PATH"));
    assert.match(html, /<input class="launch-input" id="cwdInput" type="text" placeholder="\/path\/to\/project"/);
    assert.match(html, /<textarea class="launch-textarea" id="promptInput"[^>]*placeholder="optional initial prompt[^"]*"/);
    assert.match(html, /<button class="launch-start" id="startBtn" type="submit">Start<\/button>/);
    // Overlay starts hidden; the header button opens it.
    assert.match(html, /<div class="launch-overlay" id="launchOverlay" hidden>/);
  });

  test("launcher modal client wires /api/agents, POST /api/runs, and navigates into the run chat", () => {
    const html = dashboardHtml();
    assert.ok(html.includes("fetch('/api/agents')"), "agents+mux state loaded on open");
    assert.ok(html.includes("fetch('/api/runs', {"), "Start POSTs /api/runs");
    assert.ok(html.includes("method: 'POST'"));
    assert.ok(html.includes("'Content-Type': 'application/json'"));
    assert.ok(html.includes("showLaunchError(await readLaunchError(res))"), "non-2xx {error} shown inline");
    assert.ok(!html.includes("alert("), "no alert() error reporting");
    // Success lands straight on the run's chat.
    assert.ok(html.includes("window.location.href = '/run?id=' + encodeURIComponent(data.id)"));
    // Deep link: /?launch=1 auto-opens (the /launch redirect target).
    assert.ok(html.includes("get('launch') === '1'"), "?launch=1 auto-open");
    // cwd default: localStorage memory falling back to the server-embedded default.
    assert.ok(html.includes("localStorage.getItem('tq-launch-cwd')"));
    assert.ok(html.includes("_INIT_DATA.defaultCwd"));
    assert.ok(html.includes('"defaultCwd":"/home/dev"'), "init payload carries the server default cwd");
  });

  test("launcher modal submit guards against double-submit while the POST is in flight", () => {
    const js = LAUNCHER_CLIENT_JS;
    assert.ok(js.includes("if (startInFlight) return;"), "re-entry suppressed while in flight");
    assert.ok(js.includes("startInFlight = true;"));
    assert.ok(js.includes("startBtn.disabled = true;"), "Start disabled during the POST");
    assert.match(
      js,
      /} finally {\s*startInFlight = false;\s*startBtn\.disabled = false;\s*}/,
      "guard and button restored in finally",
    );
  });

  test("launcher modal carries the missing-multiplexer state instead of the form when mux is unavailable", () => {
    const html = LAUNCHER_MODAL_HTML;
    assert.ok(html.includes('data-launch-state="no-mux"'));
    assert.match(html, /Multiplexer unavailable/);
    assert.match(html, /tmux was not found/);
    // Client swaps states from /api/agents mux.available.
    const js = LAUNCHER_CLIENT_JS;
    assert.match(js, /if \(!data\.mux \|\| !data\.mux\.available\) {\s*launchFormEl\.hidden = true;\s*launchNoMux\.hidden = false;/);
    // Detected agents fill the dropdown; empty detection disables Start.
    assert.ok(js.includes("agentSelect.disabled = !agents.length;"));
    assert.ok(js.includes("startBtn.disabled = !agents.length;"));
  });

  test("launcher modal styles ship with the dashboard stylesheet", () => {
    const html = dashboardHtml();
    assert.ok(html.includes(".launch-overlay"), "modal CSS embedded");
  });
});

describe("dashboard header — New run entry point", () => {
  test("dashboard header exposes the New run launcher control instead of a /launch link", () => {
    const html = dashboardHtml();
    const headerStart = html.indexOf('<header class="app-top">');
    const headerEnd = html.indexOf('<div class="filter-wrap">', headerStart);
    assert.ok(headerStart >= 0 && headerEnd > headerStart);
    const header = html.slice(headerStart, headerEnd);
    assert.match(header, /<button class="new-run-btn" id="newRunBtn" type="button"[^>]*>[\s\S]*?New run[\s\S]*?<\/button>/);
    assert.ok(!header.includes('href="/launch"'), "no standalone /launch link in the header");
  });
});

describe("/launch route — redirect into the dashboard launcher", () => {
  test("/launch is registered in ROUTE_MAP with the launch handler", () => {
    assert.equal(ROUTE_MAP["/launch"], handleLaunch);
    assert.equal(typeof ROUTE_MAP["/launch"], "function");
  });

  test("GET /launch redirects to /?launch=1 instead of serving a standalone page", async () => {
    let status = null;
    let headers = null;
    let body = null;
    const res = {
      writeHead(s, h) {
        status = s;
        headers = h;
      },
      end(b) {
        body = b == null ? "" : String(b);
      },
    };
    await handleLaunch(null, res, null, {});
    assert.equal(status, 302);
    assert.equal(headers.Location, "/?launch=1");
    assert.equal(body, "", "redirect carries no page body");
  });
});

describe("/view cross-link — live run chip (fact cixl)", () => {
  function chipDeps({ dead = false, generating = true, linkedPath = "/tmp/linked.jsonl" } = {}) {
    return {
      parseSession: () => ({ sessionId: "linked-session", source: "claude", events: [], path: linkedPath }),
      renderHTML: () => "<!DOCTYPE html><html><body>SESSION VIEW</body></html>",
      findSessions: () => [{ path: linkedPath, source: "claude", project: "p", size: 1, mtime: Date.now() }],
      detectLiveSessions: () => (generating ? [linkedPath] : []),
      muxAvailable: () => true,
      listWindows: () => [
        {
          id: "@6",
          name: "claude",
          dead,
          options: { tq_agent: "claude", tq_cwd: "/x", tq_started: "2026-08-11T10:00:00.000Z" },
        },
      ],
      linkRunSession: (win, _windows, opts = {}) => {
        assert.equal(opts.persist, false, "page views must never persist a run link");
        return { path: linkedPath, link: "linked" };
      },
    };
  }

  async function viewWith(deps, handle) {
    let status = null;
    let body = null;
    const res = {
      writeHead(s) {
        status = s;
      },
      end(b) {
        body = String(b);
      },
    };
    await handleView(null, res, new URL(`http://localhost/view?path=${encodeURIComponent(handle)}`), deps);
    return { status, body };
  }

  test("view page cross-links a run's linked recording with an open-chat chip", async () => {
    const { sessionHash } = await import("../../src/sessions/session-hash.js");
    const handle = sessionHash("/tmp/linked.jsonl");
    const { status, body } = await viewWith(chipDeps(), handle);
    assert.equal(status, 200);
    assert.ok(body.includes("SESSION VIEW"));
    assert.match(body, /<a class="view-run-chip" data-run-id="@6" data-status="running" href="\/run\?id=%406">/);
    assert.match(body, /running run &middot; open chat/);
    const at = body.indexOf('class="view-run-chip"');
    assert.ok(at > body.indexOf("SESSION VIEW"), "chip injected before </body>, after the page content");
  });

  test("view page cross-link chip shows the exited variant and skips unrelated sessions", async () => {
    const { sessionHash } = await import("../../src/sessions/session-hash.js");
    const idle = await viewWith(chipDeps({ generating: false }), sessionHash("/tmp/linked.jsonl"));
    assert.match(idle.body, /view-run-chip" data-run-id="@6" data-status="idle"/);
    assert.match(idle.body, /idle run &middot; open chat/);
    assert.doesNotMatch(idle.body, /running run &middot; open chat/,
      "D1: idle launched G1 /view chip is not running run");
    assert.doesNotMatch(idle.body, /live run &middot; open chat/,
      "D1: idle launched G1 /view chip is not live run");

    const exited = await viewWith(chipDeps({ dead: true, generating: false }), sessionHash("/tmp/linked.jsonl"));
    assert.match(exited.body, /view-run-chip" data-run-id="@6" data-status="exited"/);
    assert.match(exited.body, /run exited &middot; open chat/);

    // A session that is NOT any run's recording and is not generating gets no chip.
    const deps = chipDeps({ linkedPath: "/tmp/other.jsonl", generating: false });
    deps.linkRunSession = () => ({ path: "/tmp/unrelated.jsonl", link: "linked" });
    const none = await viewWith(deps, sessionHash("/tmp/other.jsonl"));
    assert.equal(none.status, 200);
    assert.ok(!none.body.includes("view-run-chip"));

    // Mux unavailable: page renders, run-chip logic never lists windows.
    const noMux = chipDeps({ generating: false });
    noMux.muxAvailable = () => false;
    noMux.listWindows = () => {
      throw new Error("must not touch tmux when mux is unavailable");
    };
    const plain = await viewWith(noMux, sessionHash("/tmp/linked.jsonl"));
    assert.equal(plain.status, 200);
    assert.ok(!plain.body.includes("view-run-chip"));
  });

  test("D1: idle launched G1 /view chip is idle run, generating G2 is running run", async () => {
    const { sessionHash } = await import("../../src/sessions/session-hash.js");
    const handle = sessionHash("/tmp/linked.jsonl");
    const idle = await viewWith(chipDeps({ generating: false }), handle);
    assert.match(idle.body, /data-status="idle"/);
    assert.match(idle.body, /idle run &middot; open chat/);
    assert.doesNotMatch(idle.body, /running run &middot; open chat/);
    assert.doesNotMatch(idle.body, /live run &middot; open chat/);

    const gen = await viewWith(chipDeps({ generating: true }), handle);
    assert.match(gen.body, /data-status="running"/);
    assert.match(gen.body, /running run &middot; open chat/);
    assert.doesNotMatch(gen.body, /live run &middot; open chat/,
      "D1: generating chip copy uses running, not live");
    assert.doesNotMatch(gen.body, /idle run &middot; open chat/);
  });
});

describe("run watch page — polling viewer", () => {
  test("watch page serves the polling viewer", async () => {
    // Page structure: terminal-styled block + ~600ms snapshot polling +
    // kill control + back link (fact lawp).
    const html = runPage({
      run: {
        id: "@4",
        agent: "claude",
        cwd: "/home/dev/project",
        startedAt: "2026-08-10T12:00:00.000Z",
        status: "running",
      },
    });
    assert.ok(html.includes('<pre class="run-screen" id="runScreen">'), "terminal viewport block");
    assert.ok(html.includes("var POLL_MS = 600;"), "~600ms poll cadence");
    assert.ok(html.includes('fetch("/api/runs/snapshot?id=" + encodeURIComponent(runId))'));
    assert.ok(html.includes("screen.innerHTML = data.html"), "snapshot html swapped into the block");
    assert.ok(html.includes('fetch("/api/runs/kill"'), "kill control wired");
    assert.match(html, /<a class="run-back" href="\/sessions">/, "back link to the inventory");

    // GET /run?id serves exactly this page for a known run (injected deps).
    let status = null;
    let body = null;
    const res = {
      writeHead(s, headers) {
        status = s;
        this.type = headers && headers["Content-Type"];
      },
      end(b) {
        body = String(b);
      },
    };
    await handleRun(null, res, new URL("http://localhost/run?id=%404"), {
      runPage,
      listWindows: () => [
        {
          id: "@4",
          name: "claude",
          dead: false,
          options: {
            tq_agent: "claude",
            tq_cwd: "/home/dev/project",
            tq_started: "2026-08-10T12:00:00.000Z",
          },
        },
      ],
    });
    assert.equal(status, 200);
    assert.match(res.type, /text\/html/);
    assert.ok(body.includes('var runId = "@4";'));
    assert.ok(body.includes('id="runScreen"'));
  });
});

describe("run watch page — live (playwright + private tmux)", () => {
  const SKIP_NO_BOTH = SKIP_NO_PLAYWRIGHT.skip ? SKIP_NO_PLAYWRIGHT : SKIP_NO_TMUX;
  const harness = createRunWatchHarness({
    socket: `tq-test-watchfact-${process.pid}`,
    session: `tq-watchfact-${process.pid}`,
  });

  afterEach(() => harness.afterEachCleanup());
  after(() => harness.teardown());

  test("watch page reflects new output between polls", SKIP_NO_BOTH, async () => {
    await harness.scenarioLiveTick();
  });

  test("watch page shows the exited state with the final output preserved", SKIP_NO_BOTH, async () => {
    await harness.scenarioExited();
  });

  test("watch page kill button ends the run and shows the gone state", SKIP_NO_BOTH, async () => {
    await harness.scenarioKill();
  });

  test("watch page input reaches the run", SKIP_NO_BOTH, async () => {
    // Fact laiu (launch-s5): browser-typed text POSTs {id, text, key:"Enter"}
    // to /api/runs/input and echoes back into the polled viewport.
    await harness.scenarioInput();
  });
});
