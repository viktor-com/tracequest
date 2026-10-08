import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SESSION_VIEWER_CSS } from "../src/render/render-session-css.js";
import { CSS, STANDALONE_BASE_CSS } from "../src/render/render-css.js";
import { renderHTML } from "../src/render.js";

describe("render-session-css SESSION_VIEWER_CSS", () => {
  test("includes session viewer layout and chapter rules", () => {
    assert.match(SESSION_VIEWER_CSS, /#app\s*\{/);
    assert.match(SESSION_VIEWER_CSS, /\.chapter\s*\{/);
    assert.match(SESSION_VIEWER_CSS, /\.chapter-prompt/);
    assert.match(SESSION_VIEWER_CSS, /\.stats-bar/);
    assert.match(SESSION_VIEWER_CSS, /\.filter-bar/);
    assert.match(SESSION_VIEWER_CSS, /\.waveform-wrap/);
    assert.match(SESSION_VIEWER_CSS, /\.tool-flow/);
    assert.match(SESSION_VIEWER_CSS, /\.session-summary/);
    assert.match(SESSION_VIEWER_CSS, /\.minimap/);
    assert.match(SESSION_VIEWER_CSS, /@media print/);
    assert.match(SESSION_VIEWER_CSS, /@media \(max-width: 768px\)/);
  });

  test("defines full session theme tokens including dim variants", () => {
    assert.match(SESSION_VIEWER_CSS, /--green-dim:/);
    assert.match(SESSION_VIEWER_CSS, /--red-dim:/);
    assert.match(SESSION_VIEWER_CSS, /--orange-dim:/);
    assert.match(SESSION_VIEWER_CSS, /--radius:/);
    assert.equal((SESSION_VIEWER_CSS.match(/:root/g) || []).length, 2, "screen + print :root");
  });

  test("does not duplicate standalone-only accent-dim token", () => {
    assert.doesNotMatch(SESSION_VIEWER_CSS, /--accent-dim:/);
    assert.match(STANDALONE_BASE_CSS, /--accent-dim:/);
  });

  test("substantial stylesheet for session embed", () => {
    assert.ok(SESSION_VIEWER_CSS.length > 50_000);
    assert.ok(SESSION_VIEWER_CSS.split("\n").length > 2000);
  });
});

describe("render-css compose exports", () => {
  test("CSS alias re-exports session viewer stylesheet", () => {
    assert.strictEqual(CSS, SESSION_VIEWER_CSS);
  });

  test("renderHTML embeds session CSS in a single style block", () => {
    const session = {
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      source: "claude",
      model: "",
      durationMs: 0,
      events: [],
      stats: {},
      _path: "/tmp/a.jsonl",
    };
    const html = renderHTML(session);
    const headEnd = html.indexOf("</head>");
    assert.ok(headEnd > 0, "expected </head>");
    const head = html.slice(0, headEnd);
    assert.equal((head.match(/<style>/g) || []).length, 1, "one style tag in document head");
    assert.ok(html.includes(".minimap {"), "minimap from session CSS");
    assert.ok(html.includes(".session-grade-letter"), "session grade from session CSS");
    const styleStart = head.indexOf("<style>");
    const styleEnd = head.indexOf("</style>", styleStart);
    const styleBlock = html.slice(styleStart + "<style>".length, styleEnd);
    assert.ok(styleBlock.includes(CSS.slice(0, 80)), "style block contains session CSS");
  });
});