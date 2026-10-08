import "../helpers/skip-lr-watch-env.js";
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  handleIndex,
  handleSessions,
  handleRun,
  handleView,
  handleExport,
  handleMarkdown,
  handleCompare,
  applyViewEmbedMode,
  pickDefaultChatTarget,
} from "../../src/routes/route-handlers-pages.js";
import { clearRouteCache } from "../../src/routes/route-cache.js";
import { setInitialFilter } from "../../src/server/server-state.js";
import { ROUTE_MAP } from "../../src/routes.js";
import {
  writeClaudeJsonl,
  claudeProj,
  CLAUDE_FIXTURE_CWD,
  CLAUDE_FIXTURE_MODEL,
} from "../helpers/fixtures.js";
import { COMPARE_METRIC_LABELS } from "../../src/chapters/compare-metrics.js";
import { sessionRow, makeFilteredIndexDeps } from "../helpers/api-route-cache-fixtures.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

function captureHtmlResponse() {
  let status;
  let headers;
  let body;
  const res = {
    writeHead: mock.fn((s, h) => {
      status = s;
      headers = h;
    }),
    end: mock.fn((b) => {
      body = b;
    }),
    get status() {
      return status;
    },
    get headers() {
      return headers;
    },
    get body() {
      return body;
    },
  };
  return { res };
}

function makeIndexDeps(sessionCount = 1, filterTag = "pages-test") {
  const sessions = Array.from({ length: sessionCount }, (_, i) => ({
    path: `/fake/pages-${filterTag}-${i}.jsonl`,
    mtime: new Date("2026-05-01T12:00:00Z"),
    size: 512,
    source: "claude",
    project: "proj",
    file: `s${i}.jsonl`,
  }));
  const index = new Map();
  for (const s of sessions) {
    index.set(s.path, {
      firstPrompt: `prompt ${s.file}`,
      model: "claude-sonnet-4-6",
      tools: [],
      toolCounts: {},
      chapters: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      durationMs: 0,
      errors: 0,
      files: 0,
      commits: 0,
    });
  }
  const findSessions = mock.fn(() => sessions);
  const buildIndex = mock.fn(() => index);
  const browserPage = mock.fn(() => "<!DOCTYPE html><html><body>index-page</body></html>");
  const muxAvailable = mock.fn(() => false);
  const listWindows = mock.fn(() => []);
  const detectLiveSessions = mock.fn(() => []);
  return { findSessions, buildIndex, browserPage, muxAvailable, listWindows, detectLiveSessions, sessions, index };
}

function withClaudeSession(home, name = "solo.jsonl", lines = ['{"type":"user"}\n']) {
  const proj = path.join(home, ".claude", "projects", "pages-proj");
  fs.mkdirSync(proj, { recursive: true });
  const sessionPath = path.join(proj, name);
  fs.writeFileSync(sessionPath, lines.join(""));
  return sessionPath;
}

const COMPARE_A_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const COMPARE_B_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
const PAGES_EXPORT_ID = "cccccccc-dddd-eeee-ffff-111111111111";
const PAGES_MARKDOWN_ID = "dddddddd-eeee-ffff-0000-222222222222";

function compareSessionALines() {
  return [
    {
      type: "user",
      sessionId: COMPARE_A_ID,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T10:00:00.000Z",
      message: { content: [{ type: "text", text: "Compare handler mock session A" }] },
    },
    {
      type: "assistant",
      sessionId: COMPARE_A_ID,
      timestamp: "2026-06-03T10:00:05.000Z",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        usage: { input_tokens: 120, output_tokens: 30 },
        content: [{ type: "text", text: "Session A handler reply." }],
      },
    },
  ];
}

function compareSessionBLines() {
  return [
    {
      type: "user",
      sessionId: COMPARE_B_ID,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T11:00:00.000Z",
      message: { content: [{ type: "text", text: "Compare handler mock session B" }] },
    },
    {
      type: "assistant",
      sessionId: COMPARE_B_ID,
      timestamp: "2026-06-03T11:00:06.000Z",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        usage: { input_tokens: 200, output_tokens: 50 },
        content: [{ type: "text", text: "Session B handler reply." }],
      },
    },
  ];
}

function withComparePair(home, aName = "cmp-a.jsonl", bName = "cmp-b.jsonl") {
  const proj = claudeProj(home, "pages-compare");
  const pathA = writeClaudeJsonl(proj, aName, compareSessionALines());
  const pathB = writeClaudeJsonl(proj, bName, compareSessionBLines());
  return { pathA, pathB };
}

function compareUrl(pathA, pathB) {
  const url = new URL("http://localhost:7777/compare");
  url.searchParams.set("a", pathA);
  url.searchParams.set("b", pathB);
  return url;
}

function assertCompareLoadError(res, { status, side, handle, message }) {
  assert.equal(res.status, status);
  assert.match(res.headers["Content-Type"], /text\/html/);
  assert.match(res.body, /<!DOCTYPE html>/i);
  assert.match(res.body, /data-compare-state="error"/);
  assert.match(res.body, new RegExp(`Could not load ${side}`));
  assert.match(res.body, new RegExp(`HTTP ${status}`));
  assert.match(res.body, /back to sessions/);
  assert.doesNotMatch(res.body, /<div class="cmp-sessions">/);
  assert.doesNotMatch(res.body, /<table class="cmp-table">/);
  if (handle) assert.ok(res.body.includes(handle));
  if (message) assert.match(res.body, message);
}

function assertViewLoadError(res, { status, handle, message }) {
  assert.equal(res.status, status);
  assert.match(res.headers["Content-Type"], /text\/html/);
  assert.match(res.body, /<!DOCTYPE html>/i);
  assert.match(res.body, /data-view-state="error"/);
  assert.match(res.body, /Could not load session/);
  assert.match(res.body, new RegExp(`HTTP ${status}`));
  assert.match(res.body, /back to sessions/);
  assert.match(res.body, /EventSource\("\/__livereload"\)/);
  if (handle) assert.ok(res.body.includes(handle));
  if (message) assert.match(res.body, message);
}

function exportSessionLines() {
  return [
    {
      type: "user",
      sessionId: PAGES_EXPORT_ID,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T12:00:00.000Z",
      message: { content: [{ type: "text", text: "Export handler fixture prompt" }] },
    },
    {
      type: "assistant",
      sessionId: PAGES_EXPORT_ID,
      timestamp: "2026-06-03T12:00:05.000Z",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        usage: { input_tokens: 80, output_tokens: 20 },
        content: [{ type: "text", text: "Export handler fixture reply." }],
      },
    },
  ];
}

function markdownSessionLines() {
  return [
    {
      type: "user",
      sessionId: PAGES_MARKDOWN_ID,
      cwd: CLAUDE_FIXTURE_CWD,
      timestamp: "2026-06-03T13:00:00.000Z",
      message: { content: [{ type: "text", text: "Markdown handler fixture prompt" }] },
    },
    {
      type: "assistant",
      sessionId: PAGES_MARKDOWN_ID,
      timestamp: "2026-06-03T13:00:05.000Z",
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        usage: { input_tokens: 90, output_tokens: 25 },
        content: [{ type: "text", text: "Markdown handler fixture reply." }],
      },
    },
  ];
}

function withRichClaudeSession(home, name, lines, project = "pages-rich") {
  const proj = claudeProj(home, project);
  return writeClaudeJsonl(proj, name, lines);
}

function exportUrl(sessionPath) {
  return new URL(`http://localhost:7777/export?path=${encodeURIComponent(sessionPath)}`);
}

function markdownUrl(sessionPath) {
  return new URL(`http://localhost:7777/markdown?path=${encodeURIComponent(sessionPath)}`);
}

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pages-route-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    return await fn(tmpHome);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

afterEach(() => {
  clearRouteCache();
  setInitialFilter(null);
});

describe("route-handlers-pages handleSessions route cache", () => {
  test("calls findSessions and buildIndex only once on repeated requests", async () => {
    const deps = makeIndexDeps(1, "cache-once");
    const { res } = captureHtmlResponse();
    const url = new URL("http://localhost:7777/sessions?filter=cache-once");

    await handleSessions({}, res, url, deps);
    await handleSessions({}, res, url, deps);

    assert.equal(deps.findSessions.mock.calls.length, 1);
    assert.equal(deps.buildIndex.mock.calls.length, 1);
  });

  test("invalidates cache when filter query param changes", async () => {
    const deps = makeIndexDeps(1, "shared");
    const { res } = captureHtmlResponse();

    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=alpha"), deps);
    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=beta"), deps);

    assert.equal(deps.findSessions.mock.calls.length, 2);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], "alpha");
    assert.equal(deps.findSessions.mock.calls[1].arguments[0], "beta");
  });

  test("produces identical HTML on route cache hit", async () => {
    const deps = makeIndexDeps(1, "html-stable");
    const { res, html: _h } = captureHtmlResponse();
    const url = new URL("http://localhost:7777/sessions?filter=html-stable");

    await handleSessions({}, res, url, deps);
    const html1 = res.end.mock.calls[0].arguments[0];
    await handleSessions({}, res, url, deps);
    const html2 = res.end.mock.calls[1].arguments[0];

    assert.strictEqual(html2, html1);
    assert.equal(deps.browserPage.mock.calls.length, 2);
  });

  test("route cache supersedes removed page HTML cache (no buildPageCacheKey)", async () => {
    const pageMod = await import("../../src/browser/browser-page.js");
    assert.equal(pageMod.buildPageCacheKey, undefined);

    const deps = makeIndexDeps(1, "no-page-cache");
    const { res } = captureHtmlResponse();
    const url = new URL("http://localhost:7777/sessions?filter=no-page-cache");

    await handleSessions({}, res, url, deps);
    await handleSessions({}, res, url, deps);

    assert.equal(deps.findSessions.mock.calls.length, 1, "route cache skips session discovery");
    assert.equal(deps.buildIndex.mock.calls.length, 1, "route cache skips index build");
    assert.equal(deps.browserPage.mock.calls.length, 2, "browserPage still renders each request");
  });

  test("uses custom browserPage from deps when provided", async () => {
    const deps = makeIndexDeps(2, "custom-bp");
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=custom-bp"), deps);
    assert.match(res.body, /index-page/);
    assert.equal(deps.browserPage.mock.calls.length, 1);
    assert.equal(deps.browserPage.mock.calls[0].arguments[2], "custom-bp");
  });
});

describe("route-handlers-pages handleSessions sessionsForLive → browserPage", () => {
  test("unfiltered index passes the same session list for table and live detection", async () => {
    const rows = [
      sessionRow("/fake/live-alpha.jsonl", "alpha"),
      sessionRow("/fake/live-beta.jsonl", "beta"),
    ];
    const deps = makeFilteredIndexDeps(rows);
    const { res } = captureHtmlResponse();

    await handleSessions({}, res, new URL("http://localhost:7777/sessions"), deps);

    assert.equal(deps.browserPage.mock.calls.length, 1);
    const [tableSessions, , filterArg, liveSessions] = deps.browserPage.mock.calls[0].arguments;
    assert.equal(filterArg, null);
    assert.strictEqual(tableSessions, rows);
    assert.strictEqual(liveSessions, rows);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], null);
  });

  test("filtered index after unfiltered load uses full snapshot for live detection only", async () => {
    const rows = [
      sessionRow("/fake/live-alpha.jsonl", "alpha"),
      sessionRow("/fake/live-beta.jsonl", "beta"),
    ];
    const deps = makeFilteredIndexDeps(rows);
    const { res } = captureHtmlResponse();

    await handleSessions({}, res, new URL("http://localhost:7777/sessions"), deps);
    const callsBeforeFilter = deps.findSessions.mock.calls.length;

    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=alpha"), deps);

    const filterCalls = deps.findSessions.mock.calls.slice(callsBeforeFilter);
    assert.equal(filterCalls.length, 1);
    assert.equal(filterCalls[0].arguments[0], "alpha");
    const [tableSessions, , filterArg, liveSessions] = deps.browserPage.mock.calls[1].arguments;
    assert.equal(filterArg, "alpha");
    assert.equal(tableSessions.length, 1);
    assert.equal(tableSessions[0].path, "/fake/live-alpha.jsonl");
    assert.strictEqual(liveSessions, rows);
  });

  test("filtered-only load falls back to filtered sessions when no global snapshot exists", async () => {
    const rows = [sessionRow("/fake/live-alpha.jsonl", "alpha")];
    const deps = makeFilteredIndexDeps(rows);
    const { res } = captureHtmlResponse();

    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=alpha"), deps);

    const [tableSessions, , filterArg, liveSessions] = deps.browserPage.mock.calls[0].arguments;
    assert.equal(filterArg, "alpha");
    assert.strictEqual(tableSessions, liveSessions);
    assert.equal(tableSessions.length, 1);
    assert.deepEqual(deps.findSessions.mock.calls.map((c) => c.arguments[0]), ["alpha"]);
  });
});

describe("route-handlers-pages handleSessions filter query params", () => {
  test("passes filter query string to findSessions", async () => {
    const deps = makeIndexDeps(1, "unused");
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=proj:foo"), deps);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], "proj:foo");
  });

  test("treats empty ?filter= as null because empty string is falsy", async () => {
    const deps = makeIndexDeps(1, "unused");
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter="), deps);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], null);
  });

  test("falls back to getInitialFilter when URL has no filter", async () => {
    setInitialFilter("initial-from-cli");
    const deps = makeIndexDeps(1, "unused");
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions"), deps);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], "initial-from-cli");
  });

  test("uses null filter when neither query nor initial filter is set", async () => {
    const deps = makeIndexDeps(1, "unused");
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions"), deps);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], null);
  });
});

describe("route-handlers-pages handleSessions response shape", () => {
  test("responds 200 text/html with live-reload script injected", async () => {
    const deps = makeIndexDeps(1, "shape");
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=shape"), deps);
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /text\/html/);
    assert.match(res.body, /EventSource\("\/__livereload"\)/);
  });

  test("served pages embed the identity catalog", async () => {
    const deps = makeIndexDeps(2, "cmdk-cat");
    const meta0 = deps.index.get(deps.sessions[0].path);
    meta0.firstPrompt = "Investigate Read path";
    meta0.tools = ["Read", "Bash"];
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions?filter=cmdk-cat"), deps);
    assert.match(res.body, /id="tq-cmdk-catalog"/);
    const m = res.body.match(/<script type="application\/json" id="tq-cmdk-catalog">([^<]*)<\/script>/);
    assert.ok(m, "catalog script tag");
    const { unpackSearchCatalog } = await import("../../src/browser/command-palette.js");
    const sessions = unpackSearchCatalog(JSON.parse(m[1]));
    assert.ok(sessions.length >= 1);
    const row = sessions.find((s) => s.prompt === "Investigate Read path") || sessions[0];
    assert.equal(row.source, "claude");
    assert.equal(typeof row.id, "string");
    assert.ok(row.id.length >= 8);
    assert.equal(row.prompt, "Investigate Read path");
    assert.ok(row.tools.includes("Read"));
    assert.equal(deps.findSessions.mock.calls.length, 1, "catalog uses the already-resolved session index");
  });
});

describe("route-handlers-pages handleView error paths", () => {
  test("returns compact HTML error state when path is missing", async () => {
    const { res } = captureHtmlResponse();
    await handleView({}, res, new URL("http://localhost:7777/view"));
    assertViewLoadError(res, {
      status: 400,
      handle: "(missing)",
      message: /Missing path/,
    });
    assert.equal(res.end.mock.calls.length, 1);
  });

  test("returns compact HTML error state for forbidden session path", async () => {
    const { res } = captureHtmlResponse();
    await handleView({}, res, new URL("http://localhost:7777/view?path=/etc/passwd"));
    assertViewLoadError(res, {
      status: 403,
      handle: "/etc/passwd",
      message: /Forbidden/,
    });
  });

  test("returns compact HTML error state when parseSession throws", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "unreadable.jsonl");
      fs.chmodSync(sessionPath, 0o000);
      const { res } = captureHtmlResponse();
      const errorSpy = mock.method(console, "error", () => {});
      try {
        await handleView(
          {},
          res,
          new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
        );
        assertViewLoadError(res, {
          status: 500,
          handle: sessionPath,
          message: /Error parsing session/,
        });
      } finally {
        errorSpy.mock.restore();
        try {
          fs.chmodSync(sessionPath, 0o644);
        } catch {
          /* cleanup best-effort */
        }
      }
    });
  });

  test("returns compact HTML error state when session file no longer exists", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "gone.jsonl");
      fs.unlinkSync(sessionPath);
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
      );
      assertViewLoadError(res, {
        status: 403,
        handle: sessionPath,
        message: /Forbidden/,
      });
    });
  });
});

describe("route-handlers-pages handleView embed-view flyout mode", () => {
  test("embed-view: applyViewEmbedMode marks body.embed-view and injects compact CSS", () => {
    const html = applyViewEmbedMode("<!DOCTYPE html><html><head></head><body><div id=\"app\"></div></body></html>");
    assert.match(html, /<body class="embed-view">/);
    assert.match(html, /id="embed-view-css"/);
    assert.match(html, /body\.embed-view #app/);
    assert.match(html, /body\.embed-view \.header-top/);
    assert.match(html, /view-continue-chip/);
  });

  test("embed-view: /view?embed=1 renders body.embed-view and skips floating chips", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "embed.jsonl", [
        JSON.stringify({
          type: "user",
          sessionId: "embed-view-session",
          cwd: CLAUDE_FIXTURE_CWD,
          timestamp: "2026-06-03T10:00:00.000Z",
          message: { content: [{ type: "text", text: "Flyout embed analytics" }] },
        }) + "\n",
        JSON.stringify({
          type: "assistant",
          sessionId: "embed-view-session",
          timestamp: "2026-06-03T10:00:05.000Z",
          message: {
            model: CLAUDE_FIXTURE_MODEL,
            usage: { input_tokens: 80, output_tokens: 20 },
            content: [{ type: "text", text: "Embedded reply." }],
          },
        }) + "\n",
      ]);
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}&embed=1`),
      );
      assert.equal(res.status, 200);
      assert.match(res.body, /<body class="embed-view">/);
      assert.match(res.body, /id="embed-view-css"/);
      assert.match(res.body, /const SESSION = /);
      assert.match(res.body, /<div id="app"><\/div>/);
      assert.doesNotMatch(res.body, /class="view-continue-chip"/);
      assert.doesNotMatch(res.body, /class="view-run-chip"/);
    });
  });
});

describe("route-handlers-pages handleView success path", () => {
  test("returns 200 HTML with live-reload for valid session file", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home);
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
      );
      assert.equal(res.status, 200);
      assert.match(res.headers["Content-Type"], /text\/html/);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /EventSource\("\/__livereload"\)/);
    });
  });
});

describe("route-handlers-pages handleExport error paths", () => {
  test("returns 400 when path query is missing", async () => {
    const { res } = captureHtmlResponse();
    await handleExport({}, res, new URL("http://localhost:7777/export"));
    assert.equal(res.status, 400);
    assert.equal(res.body, "Missing path");
    assert.equal(res.end.mock.calls.length, 1);
    assert.notEqual(res.headers?.["Content-Type"], "text/html; charset=utf-8");
  });

  test("returns 403 for non-session export path", async () => {
    const { res } = captureHtmlResponse();
    await handleExport({}, res, new URL("http://localhost:7777/export?path=/var/log/syslog"));
    assert.equal(res.status, 403);
    assert.match(res.body, /Forbidden/);
    assert.equal(res.end.mock.calls.length, 1);
  });

  test("returns 403 for forbidden session path under etc", async () => {
    const { res } = captureHtmlResponse();
    await handleExport({}, res, new URL("http://localhost:7777/export?path=/etc/passwd"));
    assert.equal(res.status, 403);
    assert.match(res.body, /Forbidden/);
  });

  test("returns 500 when parseSession throws", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "export-locked.jsonl");
      fs.chmodSync(sessionPath, 0o000);
      const { res } = captureHtmlResponse();
      const errorSpy = mock.method(console, "error", () => {});
      try {
        await handleExport({}, res, exportUrl(sessionPath));
        assert.equal(res.status, 500);
        assert.equal(res.body, "Error parsing session");
        assert.equal(res.headers["Content-Type"], "text/plain");
      } finally {
        errorSpy.mock.restore();
        try {
          fs.chmodSync(sessionPath, 0o644);
        } catch {
          /* cleanup best-effort */
        }
      }
    });
  });

  test("returns 403 when session file no longer exists", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "export-gone.jsonl");
      fs.unlinkSync(sessionPath);
      const { res } = captureHtmlResponse();
      await handleExport({}, res, exportUrl(sessionPath));
      assert.equal(res.status, 403);
      assert.match(res.body, /Forbidden/);
    });
  });
});

describe("route-handlers-pages handleExport success paths", () => {
  test("streams HTML attachment with path-hash filename", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "export-me.jsonl");
      const { res } = captureHtmlResponse();
      await handleExport({}, res, exportUrl(sessionPath));
      assert.equal(res.status, 200);
      assert.match(res.headers["Content-Type"], /text\/html.*charset=utf-8/);
      assert.match(res.headers["Content-Disposition"], /attachment/);
      assert.match(res.headers["Content-Disposition"], new RegExp(`tracequest-${sessionHash(sessionPath)}\\.html`));
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.equal(res.writeHead.mock.calls.length, 1);
      assert.equal(res.end.mock.calls.length, 1);
    });
  });

  test("uses path-derived hash in attachment filename", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withRichClaudeSession(home, "export-id.jsonl", exportSessionLines());
      const { res } = captureHtmlResponse();
      await handleExport({}, res, exportUrl(sessionPath));
      assert.equal(res.status, 200);
      assert.match(res.headers["Content-Disposition"], new RegExp(`tracequest-${sessionHash(sessionPath)}\\.html`));
    });
  });

  test("does not inject livereload script in export HTML", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withRichClaudeSession(home, "export-nolr.jsonl", exportSessionLines());
      const { res } = captureHtmlResponse();
      await handleExport({}, res, exportUrl(sessionPath));
      assert.equal(res.status, 200);
      assert.doesNotMatch(res.body, /EventSource\("\/__livereload"\)/);
    });
  });

  test("renders parsed session prompt text in exported HTML body", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withRichClaudeSession(home, "export-body.jsonl", exportSessionLines());
      const { res } = captureHtmlResponse();
      await handleExport({}, res, exportUrl(sessionPath));
      assert.match(res.body, /Export handler fixture prompt/);
    });
  });
});

describe("route-handlers-pages handleMarkdown error paths", () => {
  test("returns 400 when path is absent", async () => {
    const { res } = captureHtmlResponse();
    await handleMarkdown({}, res, new URL("http://localhost:7777/markdown"));
    assert.equal(res.status, 400);
    assert.equal(res.body, "Missing path");
    assert.equal(res.end.mock.calls.length, 1);
    assert.notEqual(res.headers?.["Content-Type"], "text/markdown; charset=utf-8");
  });

  test("returns 403 for forbidden non-session markdown path", async () => {
    const { res } = captureHtmlResponse();
    await handleMarkdown({}, res, new URL("http://localhost:7777/markdown?path=/var/log/syslog"));
    assert.equal(res.status, 403);
    assert.match(res.body, /Forbidden/);
  });

  test("returns 403 for etc passwd style forbidden path", async () => {
    const { res } = captureHtmlResponse();
    await handleMarkdown({}, res, new URL("http://localhost:7777/markdown?path=/etc/shadow"));
    assert.equal(res.status, 403);
    assert.match(res.body, /Forbidden/);
    assert.equal(res.end.mock.calls.length, 1);
  });

  test("returns 500 when parseSession throws", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "md-locked.jsonl");
      fs.chmodSync(sessionPath, 0o000);
      const { res } = captureHtmlResponse();
      const errorSpy = mock.method(console, "error", () => {});
      try {
        await handleMarkdown({}, res, markdownUrl(sessionPath));
        assert.equal(res.status, 500);
        assert.equal(res.body, "Error parsing session");
        assert.equal(res.headers["Content-Type"], "text/plain");
      } finally {
        errorSpy.mock.restore();
        try {
          fs.chmodSync(sessionPath, 0o644);
        } catch {
          /* cleanup best-effort */
        }
      }
    });
  });

  test("returns 403 when markdown session file was deleted", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "md-gone.jsonl");
      fs.unlinkSync(sessionPath);
      const { res } = captureHtmlResponse();
      await handleMarkdown({}, res, markdownUrl(sessionPath));
      assert.equal(res.status, 403);
      assert.match(res.body, /Forbidden/);
    });
  });
});

describe("route-handlers-pages handleMarkdown success paths", () => {
  test("returns markdown attachment with path-hash filename", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "md.jsonl");
      const { res } = captureHtmlResponse();
      await handleMarkdown({}, res, markdownUrl(sessionPath));
      assert.equal(res.status, 200);
      assert.match(res.headers["Content-Type"], /text\/markdown.*charset=utf-8/);
      assert.match(res.headers["Content-Disposition"], /attachment/);
      assert.match(res.headers["Content-Disposition"], new RegExp(`tracequest-${sessionHash(sessionPath)}\\.md`));
      assert.equal(typeof res.body, "string");
      assert.ok(res.body.length > 0);
      assert.equal(res.writeHead.mock.calls.length, 1);
      assert.equal(res.end.mock.calls.length, 1);
    });
  });

  test("uses path-derived hash in markdown attachment filename", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withRichClaudeSession(home, "md-id.jsonl", markdownSessionLines());
      const { res } = captureHtmlResponse();
      await handleMarkdown({}, res, markdownUrl(sessionPath));
      assert.equal(res.status, 200);
      assert.match(res.headers["Content-Disposition"], new RegExp(`tracequest-${sessionHash(sessionPath)}\\.md`));
    });
  });

  test("markdown body includes session header with path-derived hash", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withRichClaudeSession(home, "md-header.jsonl", markdownSessionLines());
      const { res } = captureHtmlResponse();
      await handleMarkdown({}, res, markdownUrl(sessionPath));
      assert.match(res.body, new RegExp(`^# Session ${sessionHash(sessionPath)}`, "m"));
      assert.match(res.body, /## Summary/);
    });
  });

  test("markdown body includes fixture prompt text from parsed session", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withRichClaudeSession(home, "md-prompt.jsonl", markdownSessionLines());
      const { res } = captureHtmlResponse();
      await handleMarkdown({}, res, markdownUrl(sessionPath));
      assert.match(res.body, /Markdown handler fixture prompt/);
    });
  });
});

describe("route-handlers-pages handleCompare error paths", () => {
  test("returns 400 when compare param a is missing", async () => {
    const { res } = captureHtmlResponse();
    await handleCompare({}, res, new URL("http://localhost:7777/compare?b=opencode://x"));
    assertCompareLoadError(res, {
      status: 400,
      side: "session A",
      handle: "(missing)",
      message: /Missing compare parameter &quot;a&quot;/,
    });
    assert.equal(res.end.mock.calls.length, 1);
  });

  test("returns 400 for param b when mock session a is valid but b is missing", async () => {
    await withTempHome(async (home) => {
      const { pathA } = withComparePair(home);
      const { res } = captureHtmlResponse();
      await handleCompare(
        {},
        res,
        new URL(`http://localhost:7777/compare?a=${encodeURIComponent(pathA)}`),
      );
      assertCompareLoadError(res, {
        status: 400,
        side: "session B",
        handle: "(missing)",
        message: /Missing compare parameter &quot;b&quot;/,
      });
    });
  });

  test("returns 403 when compare param a is forbidden", async () => {
    const { res } = captureHtmlResponse();
    await handleCompare(
      {},
      res,
      new URL("http://localhost:7777/compare?a=/etc/shadow&b=opencode://y"),
    );
    assertCompareLoadError(res, {
      status: 403,
      side: "session A",
      handle: "/etc/shadow",
      message: /Forbidden/,
    });
  });

  test("returns 403 for forbidden param b when mock session a is valid", async () => {
    await withTempHome(async (home) => {
      const { pathA } = withComparePair(home);
      const { res } = captureHtmlResponse();
      await handleCompare(
        {},
        res,
        new URL(`http://localhost:7777/compare?a=${encodeURIComponent(pathA)}&b=/etc/passwd`),
      );
      assertCompareLoadError(res, {
        status: 403,
        side: "session B",
        handle: "/etc/passwd",
        message: /Forbidden/,
      });
    });
  });

  test("returns 403 when mock session a file no longer exists", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home);
      fs.unlinkSync(pathA);
      const { res } = captureHtmlResponse();
      await handleCompare({}, res, compareUrl(pathA, pathB));
      assertCompareLoadError(res, {
        status: 403,
        side: "session A",
        handle: pathA,
        message: /Forbidden/,
      });
      assert.equal(res.end.mock.calls.length, 1);
    });
  });

  test("returns 403 when mock session b file no longer exists", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home);
      fs.unlinkSync(pathB);
      const { res } = captureHtmlResponse();
      await handleCompare({}, res, compareUrl(pathA, pathB));
      assertCompareLoadError(res, {
        status: 403,
        side: "session B",
        handle: pathB,
        message: /Forbidden/,
      });
    });
  });

  test("returns 500 when mock session a is unreadable", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home, "locked-a.jsonl", "cmp-b.jsonl");
      fs.chmodSync(pathA, 0o000);
      const { res } = captureHtmlResponse();
      const errorSpy = mock.method(console, "error", () => {});
      try {
        await handleCompare({}, res, compareUrl(pathA, pathB));
        assertCompareLoadError(res, {
          status: 500,
          side: "session A",
          handle: pathA,
          message: /Error parsing session/,
        });
      } finally {
        errorSpy.mock.restore();
        try {
          fs.chmodSync(pathA, 0o644);
        } catch {
          /* cleanup best-effort */
        }
      }
    });
  });

  test("returns 500 when mock session b is unreadable after a loads", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home, "cmp-a.jsonl", "locked-b.jsonl");
      fs.chmodSync(pathB, 0o000);
      const { res } = captureHtmlResponse();
      const errorSpy = mock.method(console, "error", () => {});
      try {
        await handleCompare({}, res, compareUrl(pathA, pathB));
        assertCompareLoadError(res, {
          status: 500,
          side: "session B",
          handle: pathB,
          message: /Error parsing session/,
        });
      } finally {
        errorSpy.mock.restore();
        try {
          fs.chmodSync(pathB, 0o644);
        } catch {
          /* cleanup best-effort */
        }
      }
    });
  });
});

describe("route-handlers-pages handleCompare success paths", () => {
  test("returns compare HTML when both mock sessions resolve", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home);
      const { res } = captureHtmlResponse();
      await handleCompare({}, res, compareUrl(pathA, pathB));
      assert.equal(res.status, 200);
      assert.match(res.headers["Content-Type"], /text\/html/);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /session comparison/);
    });
  });

  test("injects live-reload script on successful compare", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home);
      const { res } = captureHtmlResponse();
      await handleCompare({}, res, compareUrl(pathA, pathB));
      assert.match(res.body, /EventSource\("\/__livereload"\)/);
    });
  });

  test("renders session A and B cards with compare metric labels", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home);
      const { res } = captureHtmlResponse();
      await handleCompare({}, res, compareUrl(pathA, pathB));
      assert.match(res.body, /session-a/);
      assert.match(res.body, /session-b/);
      assert.match(res.body, /Compare handler mock session A/);
      assert.match(res.body, /Compare handler mock session B/);
      for (const label of COMPARE_METRIC_LABELS) {
        assert.match(res.body, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });
  });

  test("embeds view links with encoded session hashes", async () => {
    await withTempHome(async (home) => {
      const { pathA, pathB } = withComparePair(home);
      const { res } = captureHtmlResponse();
      await handleCompare({}, res, compareUrl(pathA, pathB));
      assert.match(res.body, new RegExp(`view\\?id=${sessionHash(pathA)}`));
      assert.match(res.body, new RegExp(`view\\?id=${sessionHash(pathB)}`));
    });
  });
});

describe("route-handlers-pages hotModules deps injection", () => {
  test("handleView uses injected parseSession and renderHTML without hotModules", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home);
      const parseSession = mock.fn(() => ({
        sessionId: "deps-view-session",
        source: "claude",
        events: [],
      }));
      const renderHTML = mock.fn(() => "<!DOCTYPE html><html><body>deps-view</body></html>");
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
        { parseSession, renderHTML },
      );
      assert.equal(parseSession.mock.calls.length, 1);
      assert.equal(renderHTML.mock.calls.length, 1);
      assert.match(res.body, /deps-view/);
    });
  });

  test("handleExport uses injected parseSession and renderHTML without hotModules", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home);
      const parseSession = mock.fn(() => ({
        sessionId: "deps-export-session",
        source: "claude",
        events: [],
      }));
      const renderHTML = mock.fn(() => "<!DOCTYPE html><html><body>deps-export</body></html>");
      const { res } = captureHtmlResponse();
      await handleExport(
        {},
        res,
        new URL(`http://localhost:7777/export?path=${encodeURIComponent(sessionPath)}`),
        { parseSession, renderHTML },
      );
      assert.equal(parseSession.mock.calls.length, 1);
      assert.equal(renderHTML.mock.calls.length, 1);
      assert.equal(res.status, 200);
      assert.match(res.headers["Content-Disposition"], new RegExp(`tracequest-${sessionHash(sessionPath)}\\.html`));
    });
  });
});

describe("route-handlers-pages route wiring", () => {
  test("ROUTE_MAP maps page routes to handlers from pages module", () => {
    assert.equal(ROUTE_MAP["/"], handleIndex);
    assert.equal(ROUTE_MAP["/sessions"], handleSessions);
    assert.equal(ROUTE_MAP["/view"], handleView);
    assert.equal(ROUTE_MAP["/export"], handleExport);
    assert.equal(ROUTE_MAP["/markdown"], handleMarkdown);
    assert.equal(ROUTE_MAP["/compare"], handleCompare);
  });
});

// ---------------------------------------------------------------------------
// Unified-live: GET /run?session=<hash|path> — read-only live-session watch
// ---------------------------------------------------------------------------

describe("route-handlers-pages handleRun session mode (unified-live)", () => {
  const P = "/home/dev/.codex/sessions/2026/08/11/rollout-live.jsonl";
  const HASH = sessionHash(P);

  function sessionModeDeps(overrides = {}) {
    return {
      findSessions: () => [{ path: P, source: "codex", project: "-home-dev-proj", size: 1, mtime: new Date() }],
      detectLiveSessions: () => [P],
      muxAvailable: () => false,
      ...overrides,
    };
  }

  test("a live session hash serves the read-only watch page with the transcript surface", async () => {
    const { res } = captureHtmlResponse();
    await handleRun({}, res, new URL(`http://localhost:7777/run?session=${HASH}`), sessionModeDeps());
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /text\/html/);
    assert.match(res.body, /tracequest — running session/);
    assert.doesNotMatch(res.body, /tracequest — live session/);
    assert.ok(res.body.includes(`var sessionHandle = "${HASH}";`));
    assert.ok(res.body.includes('id="chatThread"'));
    assert.ok(res.body.includes("watch-only"));
    assert.ok(res.body.includes('data-status="running">running<'), "live session reads as running");
    assert.ok(res.body.includes('data-run-state="running"'), "D1: generating watch page data-run-state is running");
    assert.ok(!res.body.includes('data-run-state="live"'), "D1: watch page does not stamp data-run-state live");
    assert.ok(!res.body.includes('id="inputText"'), "no composer for an externally driven session");
    assert.match(res.body, /EventSource\("\/__livereload"\)/);
  });

  test("a session not detected live serves the same page in the idle state", async () => {
    const { res } = captureHtmlResponse();
    await handleRun({}, res, new URL(`http://localhost:7777/run?session=${HASH}`), sessionModeDeps({
      detectLiveSessions: () => [],
    }));
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('data-run-state="idle"'));
    assert.match(res.body, /tracequest — idle session/);
    assert.doesNotMatch(res.body, /tracequest — live session/);
    assert.match(res.body, /Watching an idle session/);
    assert.doesNotMatch(res.body, /Watching a live session/);
  });

  test("an unknown session hash answers the 404 error page with the session-watch kicker", async () => {
    const { res } = captureHtmlResponse();
    await handleRun({}, res, new URL("http://localhost:7777/run?session=00000000"), sessionModeDeps());
    assert.equal(res.status, 404);
    assert.match(res.body, /session watch/);
    assert.doesNotMatch(res.body, /live session watch/);
    assert.match(res.body, /Could not load session/);
  });

  test("D1: /run?session= destination copy is running|idle, never live session", async () => {
    const live = captureHtmlResponse();
    await handleRun({}, live.res, new URL(`http://localhost:7777/run?session=${HASH}`), sessionModeDeps());
    assert.equal(live.res.status, 200);
    assert.match(live.res.body, new RegExp(`<title>tracequest — running session ${HASH}</title>`),
      "D1: generating destination title is running session, not live session");
    assert.match(live.res.body, /Watching a running session/,
      "D1: generating observer heading is Watching a running session");
    assert.ok(live.res.body.includes("the agent process is running but this recording has no turns"),
      "D1: empty-transcript uses running, not live");
    assert.doesNotMatch(live.res.body, /<title>tracequest — live session/,
      "D1: destination title does not say live session");
    assert.doesNotMatch(live.res.body, /Watching a live session/);
    assert.doesNotMatch(live.res.body, /the agent process is live/);
    assert.match(live.res.body, /id="observerNoteTail">The transcript updates as the agent works/,
      "D1: generating observer paragraph updates as the agent works, never live");
    assert.doesNotMatch(live.res.body, /updates live as the agent works/,
      "D1: generating observer paragraph does not say updates live as the agent works");
    assert.doesNotMatch(live.res.body, /"Watch live"/,
      "D1: generating destination palette fallback is not Watch live");

    const idle = captureHtmlResponse();
    await handleRun({}, idle.res, new URL(`http://localhost:7777/run?session=${HASH}`), sessionModeDeps({
      detectLiveSessions: () => [],
    }));
    assert.equal(idle.res.status, 200);
    assert.match(idle.res.body, new RegExp(`<title>tracequest — idle session ${HASH}</title>`),
      "D1: idle destination title is idle session");
    assert.match(idle.res.body, /Watching an idle session/,
      "D1: idle observer heading is not Watching a live session");
    assert.doesNotMatch(idle.res.body, /Watching a live session/);
    assert.match(idle.res.body, /id="observerNoteTail">The agent is not generating right now/,
      "D1: idle G1 observer paragraph says the agent is not generating");
    assert.doesNotMatch(idle.res.body, /updates live as the agent works/,
      "D1: idle G1 observer paragraph does not say updates live as the agent works");
    assert.doesNotMatch(idle.res.body, /Detected live session/,
      "D1: idle destination does not title origin as Detected live session");
    assert.doesNotMatch(idle.res.body, /"Watch live"/,
      "D1: idle destination palette fallback is not Watch live");

    const gone = captureHtmlResponse();
    await handleRun({}, gone.res, new URL("http://localhost:7777/run?session=00000000"), sessionModeDeps());
    assert.equal(gone.res.status, 404);
    assert.match(gone.res.body, />session watch</,
      "D1: 404 kicker is session watch");
    assert.doesNotMatch(gone.res.body, /live session watch/,
      "D1: 404 kicker does not say live session watch");
  });

  test("a non-session path answers the 403 error page", async () => {
    const { res } = captureHtmlResponse();
    await handleRun({}, res, new URL("http://localhost:7777/run?session=/etc/passwd"), sessionModeDeps());
    assert.equal(res.status, 403);
    assert.match(res.body, /Forbidden/);
  });

  test("a run-linked recording gets the run cross-link into the steerable chat", async () => {
    const win = { id: "@4", dead: false, options: { tq_agent: "claude" } };
    const { res } = captureHtmlResponse();
    await handleRun({}, res, new URL(`http://localhost:7777/run?session=${HASH}`), sessionModeDeps({
      muxAvailable: () => true,
      listWindows: () => [win],
      linkRunSession: () => ({ path: P, link: "linked", attribution: "sid" }),
    }));
    assert.equal(res.status, 200);
    assert.match(res.body, /Open run chat @4/);
  });

  test("D1: idle launched G1 nested run on /run?session= is not running", async () => {
    const win = { id: "@4", dead: false, options: { tq_agent: "claude" } };
    const { res } = captureHtmlResponse();
    await handleRun({}, res, new URL(`http://localhost:7777/run?session=${HASH}`), sessionModeDeps({
      detectLiveSessions: () => [],
      muxAvailable: () => true,
      listWindows: () => [win],
      linkRunSession: () => ({ path: P, link: "linked", attribution: "sid" }),
    }));
    assert.equal(res.status, 200);
    assert.match(res.body, /Open run chat @4/);
    assert.ok(res.body.includes('data-run-state="idle"'));
    assert.doesNotMatch(res.body, /data-status="running">running</);
  });

  test("?id wins over ?session so run links stay unambiguous", async () => {
    const { res } = captureHtmlResponse();
    await handleRun({}, res, new URL(`http://localhost:7777/run?id=bogus&session=${HASH}`), {
      listWindows: () => [],
      ...sessionModeDeps(),
    });
    assert.equal(res.status, 400, "id present -> run-id grammar applies");
  });
});

describe("route-handlers-pages handleView live watch chip (unified-live)", () => {
  function viewDeps(sessionPath, { live } = { live: true }) {
    return {
      parseSession: () => ({ sessionId: "chip-session", source: "claude", events: [] }),
      renderHTML: () => "<!DOCTYPE html><html><body>chip-view</body></html>",
      findSessions: () => [{ path: sessionPath, source: "claude", project: "proj", size: 1, mtime: new Date() }],
      detectLiveSessions: () => (live ? [sessionPath] : []),
      muxAvailable: () => false,
    };
  }

  test("an external live session's /view page carries the live watch chip into /run?session=<hash>", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "live-chip.jsonl");
      const hash = sessionHash(sessionPath);
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
        viewDeps(sessionPath),
      );
      assert.equal(res.status, 200);
      assert.match(res.body, /view-run-chip/);
      assert.ok(res.body.includes(`href="/run?session=${hash}"`));
      assert.match(
        res.body,
        new RegExp(`<a class="view-run-chip" data-live-session="${hash}" data-status="running" href="/run\\?session=${hash}">`),
      );
      assert.match(res.body, /chip-dot" data-status="running"/);
      assert.match(res.body, /running session &middot; open chat/);
      assert.doesNotMatch(res.body, /live session/);
      assert.doesNotMatch(res.body, /watch live/);
      assert.doesNotMatch(res.body, /live run/);
    });
  });

  test("no live watch chip when the session is not detected live", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "idle-chip.jsonl");
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
        viewDeps(sessionPath, { live: false }),
      );
      assert.equal(res.status, 200);
      assert.ok(!res.body.includes("view-run-chip"));
      assert.doesNotMatch(res.body, /live session &middot; watch live/);
      assert.doesNotMatch(res.body, /running session &middot; open chat/);
    });
  });

  test("D1: external generating /view watch chip is running session, not live", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home, "d1-watch-chip.jsonl");
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
        viewDeps(sessionPath),
      );
      assert.equal(res.status, 200);
      assert.match(res.body, /data-status="running"/, "D1: watch chip data-status is running");
      assert.match(res.body, /running session &middot; open chat/,
        "D1: generating external /view chip uses running, not live");
      assert.doesNotMatch(res.body, /data-status="live"/,
        "D1: watch chip data-status is running|idle|exited, never live");
      assert.doesNotMatch(res.body, /live session &middot; watch live/,
        "D1: watch chip copy does not say live session · watch live");
      assert.doesNotMatch(res.body, /idle session &middot; open chat/);
    });
  });
});

describe("handleView — floating continue composer (continue-resume)", () => {
  const continuableDeps = () => ({
    parseSession: mock.fn(() => ({ sessionId: "view-src-uuid", source: "claude", events: [] })),
    renderHTML: mock.fn(() => "<!DOCTYPE html><html><body>view-body</body></html>"),
    muxAvailable: () => true,
    detectAgents: () => [{ id: "claude", binary: "claude", resume: true }],
    listWindows: () => [],
  });

  test("a continuable session floats a mini composer whose typing IS the continue", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home);
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
        continuableDeps(),
      );
      assert.equal(res.status, 200);
      // A form with an input — not a bare button chip.
      assert.match(res.body, /<form class="view-continue-chip" id="continueSessionChip" data-mode="prompt"/);
      assert.match(res.body, /id="viewContinueInput"[^>]*placeholder="Send a follow-up &mdash; continues as a new run"/);
      assert.ok(res.body.includes('id="viewContinueSend"'), "send affordance present");
      // Submit carries the typed follow-up and hands it to the landing page.
      assert.match(res.body, /body\.prompt = input\.value/);
      assert.ok(res.body.includes('sessionStorage.setItem("tq-followup:" + out.d.id, body.prompt)'));
      // Vanished-cwd recovery: needs:"cwd" flips the input into directory mode.
      assert.match(res.body, /out\.d\.needs === "cwd"/);
      assert.match(res.body, /form\.setAttribute\("data-mode", "cwd"\)/);
    });
  });

  test("honest absence: no composer when the agent is not detected resume-capable", async () => {
    await withTempHome(async (home) => {
      const sessionPath = withClaudeSession(home);
      const deps = { ...continuableDeps(), detectAgents: () => [] };
      const { res } = captureHtmlResponse();
      await handleView(
        {},
        res,
        new URL(`http://localhost:7777/view?path=${encodeURIComponent(sessionPath)}`),
        deps,
      );
      assert.equal(res.status, 200);
      assert.ok(!res.body.includes("continueSessionChip"), "no continue composer without a resume-capable agent");
      assert.ok(!res.body.includes("viewContinueInput"));
    });
  });
});

function assertChatSurface(html, label = "chat surface") {
  assert.match(html, /class="tq-shell"/, `${label}: app shell`);
  assert.match(html, /class="agent-rail"/, `${label}: session rail`);
  assert.match(html, /class="chat-app"/, `${label}: conversation column`);
  assert.match(html, /class="chat-composer"/, `${label}: composer`);
  assert.doesNotMatch(html, /class="runs-inventory"/, `${label}: not the Runs table`);
  assert.doesNotMatch(html, /<h1 class="runs-title">Runs<\/h1>/, `${label}: not the Runs heading`);
}

describe("route-handlers-pages chat-home: / is the chat surface", () => {
  test("chat-home: / is the chat surface, not the Runs inventory", async () => {
    const deps = makeIndexDeps(2, "chat-home-default");
    const { res } = captureHtmlResponse();
    await handleIndex({}, res, new URL("http://localhost:7777/"), deps);
    assert.equal(res.status, 200);
    assert.match(res.headers["Content-Type"], /text\/html/);
    assertChatSurface(res.body, "GET /");
    assert.equal(deps.browserPage.mock.calls.length, 0, "inventory builder is not the default");
  });
});

describe("route-handlers-pages chat-home: opens a record", () => {
  test("chat-home: opens the newest indexed session when no live run exists", async () => {
    const deps = makeIndexDeps(2, "chat-home-open-session");
    const expected = sessionHash(deps.sessions[0].path);
    const { res } = captureHtmlResponse();
    await handleIndex({}, res, new URL("http://localhost:7777/"), deps);
    assert.equal(res.status, 200);
    assertChatSurface(res.body);
    assert.match(res.body, new RegExp(`<title>tracequest — idle session ${expected}</title>`));
    assert.doesNotMatch(res.body, /<title>tracequest — live session/);
    assert.ok(res.body.includes(`var RAIL_CURRENT = {"type":"session","id":"${expected}"}`));
  });

  test("chat-home: opens a live launched run before indexed sessions", async () => {
    const deps = makeIndexDeps(1, "chat-home-open-run");
    deps.muxAvailable = mock.fn(() => true);
    deps.listWindows = mock.fn(() => [{
      id: "@12",
      dead: false,
      options: {
        tq_agent: "claude",
        tq_cwd: "/tmp/proj",
        tq_started: "2026-08-18T10:00:00.000Z",
      },
    }]);
    const { res } = captureHtmlResponse();
    await handleIndex({}, res, new URL("http://localhost:7777/"), deps);
    assert.equal(res.status, 200);
    assertChatSurface(res.body);
    assert.match(res.body, /<title>tracequest — run @12<\/title>/);
    assert.ok(res.body.includes('var RAIL_CURRENT = {"type":"run","id":"@12"}'));
  });

  test("chat-home: opens a live external session before a quieter indexed one", async () => {
    const live = {
      path: "/fake/pages-chat-home-live-0.jsonl",
      mtime: new Date("2026-04-01T12:00:00Z"),
      size: 512,
      source: "claude",
      project: "proj",
      file: "live.jsonl",
    };
    const older = {
      path: "/fake/pages-chat-home-old-0.jsonl",
      mtime: new Date("2026-08-01T12:00:00Z"),
      size: 512,
      source: "claude",
      project: "proj",
      file: "old.jsonl",
    };
    const deps = makeIndexDeps(0, "chat-home-live");
    deps.sessions = [older, live];
    deps.findSessions = mock.fn(() => deps.sessions);
    deps.detectLiveSessions = mock.fn(() => [live.path]);
    const expected = sessionHash(live.path);
    const { res } = captureHtmlResponse();
    await handleIndex({}, res, new URL("http://localhost:7777/"), deps);
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`<title>tracequest — running session ${expected}</title>`));
    assert.doesNotMatch(res.body, /<title>tracequest — live session/);
  });

  test("pickDefaultChatTarget prefers running runs over indexed sessions", () => {
    const deps = makeIndexDeps(1, "pick-run");
    deps.muxAvailable = () => true;
    deps.listWindows = () => [{
      id: "@3",
      dead: false,
      options: { tq_agent: "grok", tq_cwd: "/x", tq_started: "2026-08-18T00:00:00.000Z" },
    }];
    assert.deepEqual(pickDefaultChatTarget(deps), { type: "run", id: "@3" });
  });
});

describe("route-handlers-pages chat-home: empty corpus", () => {
  test("chat-home: empty corpus still renders the chat shell", async () => {
    const deps = makeIndexDeps(0, "chat-home-empty");
    deps.sessions = [];
    deps.findSessions = mock.fn(() => []);
    const { res } = captureHtmlResponse();
    await handleIndex({}, res, new URL("http://localhost:7777/"), deps);
    assert.equal(res.status, 200);
    assertChatSurface(res.body, "empty /");
    assert.match(res.body, /data-chat-home="1"/);
    assert.match(res.body, /No session open/);
    assert.match(res.body, /Start a new run/);
  });
});

describe("route-handlers-pages chat-home: query aliases /run", () => {
  test("chat-home: query ?session= serves the same live-session chat as /run?session=", async () => {
    const deps = makeIndexDeps(1, "chat-home-q-session");
    const handle = sessionHash(deps.sessions[0].path);
    const home = captureHtmlResponse();
    const run = captureHtmlResponse();
    await handleIndex({}, home.res, new URL(`http://localhost:7777/?session=${handle}`), deps);
    await handleRun({}, run.res, new URL(`http://localhost:7777/run?session=${handle}`), deps);
    assert.equal(home.res.status, 200);
    assert.equal(run.res.status, 200);
    assertChatSurface(home.res.body, "/?session=");
    assertChatSurface(run.res.body, "/run?session=");
    assert.equal(home.res.body, run.res.body);
  });

  test("chat-home: query ?id= serves the same run chat as /run?id=", async () => {
    const deps = makeIndexDeps(0, "chat-home-q-run");
    deps.findSessions = mock.fn(() => []);
    deps.muxAvailable = mock.fn(() => true);
    deps.listWindows = mock.fn(() => [{
      id: "@7",
      dead: false,
      options: {
        tq_agent: "claude",
        tq_cwd: "/tmp/q",
        tq_started: "2026-08-18T11:00:00.000Z",
      },
    }]);
    const home = captureHtmlResponse();
    const run = captureHtmlResponse();
    await handleIndex({}, home.res, new URL("http://localhost:7777/?id=@7"), deps);
    await handleRun({}, run.res, new URL("http://localhost:7777/run?id=@7"), deps);
    assert.equal(home.res.status, 200);
    assert.equal(run.res.status, 200);
    assert.equal(home.res.body, run.res.body);
    assert.match(home.res.body, /<title>tracequest — run @7<\/title>/);
  });
});

describe("route-handlers-pages chat-home: inventory stays at /sessions", () => {
  test("chat-home: inventory remains at GET /sessions", async () => {
    const deps = makeIndexDeps(1, "chat-home-inventory");
    const { res } = captureHtmlResponse();
    await handleSessions({}, res, new URL("http://localhost:7777/sessions"), deps);
    assert.equal(res.status, 200);
    assert.match(res.body, /index-page/);
    assert.equal(deps.browserPage.mock.calls.length, 1);
    assert.equal(ROUTE_MAP["/sessions"], handleSessions);
    assert.equal(ROUTE_MAP["/"], handleIndex);
  });
});
