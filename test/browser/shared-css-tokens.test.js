import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CSS_ROOT_SHARED,
  CSS_STANDALONE_ROOT_EXTRA,
  CSS_SESSION_ROOT_EXTRA,
  CSS_ROOT_STANDALONE,
  CSS_ROOT_SESSION,
  CSS_RESET,
  CSS_BODY_STANDALONE,
  CSS_BODY_SESSION,
  CSS_PRINT_ROOT_VARS,
  CSS_PRINT_ROOT_MARKER,
  STANDALONE_BASE_CSS,
  SESSION_VIEWER_BASE_CSS,
} from "../../src/browser/shared-css-tokens.js";
import { SESSION_VIEWER_CSS } from "../../src/render/render-session-css.js";
import { STANDALONE_BASE_CSS as STANDALONE_FROM_RENDER } from "../../src/render/render-css.js";
import { comparePage } from "../../src/browser/compare-page.js";
import { browserPageHTML } from "../../src/browser/browser-page-build.js";
import { renderHTML } from "../../src/render.js";
import { emptyCompareSession } from "../helpers/minimal-session.js";

function printBlock(css) {
  const m = css.match(/@media print\s*\{([\s\S]*)\}\s*@media/);
  return m ? m[1] : css.match(/@media print\s*\{([\s\S]*)\}\s*$/m)?.[1] ?? "";
}

describe("shared-css-tokens — CSS_ROOT_SHARED", () => {
  test("defines screen palette and typography once", () => {
    assert.match(CSS_ROOT_SHARED, /--bg: #111113/);
    assert.match(CSS_ROOT_SHARED, /--surface: #19191c/);
    assert.match(CSS_ROOT_SHARED, /--fg: #e4e4e7/);
    assert.match(CSS_ROOT_SHARED, /--accent: #8b7cf6/);
    assert.match(CSS_ROOT_SHARED, /--sans:/);
    assert.match(CSS_ROOT_SHARED, /--mono:/);
  });

  test("omits mode-specific dim tokens and radius", () => {
    assert.doesNotMatch(CSS_ROOT_SHARED, /--accent-dim:/);
    assert.doesNotMatch(CSS_ROOT_SHARED, /--green-dim:/);
    assert.doesNotMatch(CSS_ROOT_SHARED, /--red-dim:/);
    assert.doesNotMatch(CSS_ROOT_SHARED, /--radius:/);
  });
});

describe("shared-css-tokens — STANDALONE vs SESSION roots", () => {
  test("standalone extra adds accent-dim only", () => {
    assert.match(CSS_STANDALONE_ROOT_EXTRA, /--accent-dim: rgba\(139, 124, 246/);
    assert.doesNotMatch(CSS_STANDALONE_ROOT_EXTRA, /--green-dim:/);
    assert.doesNotMatch(CSS_STANDALONE_ROOT_EXTRA, /--radius:/);
  });

  test("session extra adds dim variants and radius", () => {
    assert.match(CSS_SESSION_ROOT_EXTRA, /--green-dim:/);
    assert.match(CSS_SESSION_ROOT_EXTRA, /--red-dim:/);
    assert.match(CSS_SESSION_ROOT_EXTRA, /--orange-dim:/);
    assert.match(CSS_SESSION_ROOT_EXTRA, /--radius: 10px/);
    assert.doesNotMatch(CSS_SESSION_ROOT_EXTRA, /--accent-dim:/);
  });

  test("composed :root blocks include shared core exactly once", () => {
    assert.ok(CSS_ROOT_STANDALONE.includes(CSS_ROOT_SHARED.trim()));
    assert.ok(CSS_ROOT_SESSION.includes(CSS_ROOT_SHARED.trim()));
    assert.equal((CSS_ROOT_STANDALONE.match(/--bg:/g) || []).length, 1);
    assert.equal((CSS_ROOT_SESSION.match(/--bg:/g) || []).length, 1);
  });

  test("STANDALONE_BASE_CSS vs SESSION_VIEWER_BASE_CSS differ on extras and body", () => {
    assert.match(CSS_RESET, /box-sizing: border-box/);
    assert.ok(STANDALONE_BASE_CSS.includes(CSS_RESET.trim()));
    assert.ok(SESSION_VIEWER_BASE_CSS.includes(CSS_RESET.trim()));
    assert.match(STANDALONE_BASE_CSS, /--accent-dim:/);
    assert.doesNotMatch(SESSION_VIEWER_BASE_CSS, /--accent-dim:/);
    assert.match(SESSION_VIEWER_BASE_CSS, /--green-dim:/);
    assert.match(CSS_BODY_SESSION, /overflow-x: hidden/);
    assert.doesNotMatch(CSS_BODY_STANDALONE, /overflow-x/);
    assert.equal((STANDALONE_BASE_CSS.match(/:root\s*\{/g) || []).length, 1);
    assert.equal((SESSION_VIEWER_BASE_CSS.match(/:root\s*\{/g) || []).length, 1);
  });

  test("render-css re-exports the same standalone base string", () => {
    assert.equal(STANDALONE_FROM_RENDER, STANDALONE_BASE_CSS);
  });
});

describe("shared-css-tokens — CSS_PRINT_ROOT_VARS", () => {
  test("is bare custom properties without a :root wrapper", () => {
    assert.doesNotMatch(CSS_PRINT_ROOT_VARS, /:root\s*\{/);
    assert.match(CSS_PRINT_ROOT_VARS, /^\s*--bg:/m);
  });

  test("flips core surfaces and text for light print", () => {
    assert.match(CSS_PRINT_ROOT_VARS, /--bg: #ffffff/);
    assert.match(CSS_PRINT_ROOT_VARS, /--surface: #ffffff/);
    assert.match(CSS_PRINT_ROOT_VARS, /--surface2: #f5f5f7/);
    assert.match(CSS_PRINT_ROOT_VARS, /--fg: #111113/);
    assert.match(CSS_PRINT_ROOT_VARS, /--fg2: #444449/);
    assert.match(CSS_PRINT_ROOT_VARS, /--border: rgba\(0, 0, 0, 0\.1\)/);
  });

  test("tunes semantic colors and session dim tokens for print", () => {
    assert.match(CSS_PRINT_ROOT_VARS, /--accent: #6d5cce/);
    assert.match(CSS_PRINT_ROOT_VARS, /--green: #1a8a42/);
    assert.match(CSS_PRINT_ROOT_VARS, /--green-dim: rgba\(26, 138, 66/);
    assert.match(CSS_PRINT_ROOT_VARS, /--red-dim: rgba\(196, 56, 56/);
    assert.match(CSS_PRINT_ROOT_VARS, /--orange-dim: rgba\(181, 120, 32/);
    assert.doesNotMatch(CSS_PRINT_ROOT_VARS, /--accent-dim:/);
  });

  test("print accent differs from shared screen accent", () => {
    assert.match(CSS_ROOT_SHARED, /--accent: #8b7cf6/);
    assert.match(CSS_PRINT_ROOT_VARS, /--accent: #6d5cce/);
    assert.doesNotMatch(CSS_PRINT_ROOT_VARS, /--accent: #8b7cf6/);
  });

  test("marker constant is stable for render-session-css substitution", () => {
    assert.equal(CSS_PRINT_ROOT_MARKER, "__CSS_PRINT_ROOT_VARS__");
    assert.ok(!SESSION_VIEWER_CSS.includes(CSS_PRINT_ROOT_MARKER));
    assert.ok(SESSION_VIEWER_CSS.includes(CSS_PRINT_ROOT_VARS.trim().slice(0, 40)));
  });
});

describe("shared-css-tokens — composed pages (SESSION vs STANDALONE)", () => {
  test("SESSION_VIEWER_CSS embeds session tokens and print :root inside @media print", () => {
    assert.match(SESSION_VIEWER_CSS, /--bg: #111113/);
    assert.match(SESSION_VIEWER_CSS, /--green-dim:/);
    assert.match(SESSION_VIEWER_CSS, /--radius:/);
    assert.doesNotMatch(SESSION_VIEWER_CSS, /--accent-dim:/);
    assert.equal((SESSION_VIEWER_CSS.match(/:root/g) || []).length, 2, "screen + print :root");
    assert.match(SESSION_VIEWER_CSS, /@media print/);
    const print = printBlock(SESSION_VIEWER_CSS);
    assert.match(print, /--bg: #ffffff/);
    assert.match(print, /--green-dim: rgba\(26, 138, 66/);
    assert.match(print, /print-color-adjust: exact/);
  });

  test("renderHTML session page uses SESSION css with print block, not standalone accent-dim", () => {
    const html = renderHTML(emptyCompareSession());
    assert.equal((html.match(/:root\s*\{/g) || []).length, 2);
    assert.match(html, /@media print/);
    assert.match(html, /--green-dim:/);
    assert.doesNotMatch(html, /--accent-dim:/);
    assert.ok(!html.includes(CSS_PRINT_ROOT_MARKER));
  });

  test("comparePage uses single screen :root and standalone accent-dim, no session print tokens", () => {
    const cmp = comparePage(
      emptyCompareSession(),
      emptyCompareSession({ sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", _path: "/tmp/b.jsonl" }),
    );
    assert.equal((cmp.match(/:root\s*\{/g) || []).length, 1);
    assert.match(cmp, /--accent-dim:/);
    assert.doesNotMatch(cmp, /--green-dim:/);
    assert.doesNotMatch(cmp, /--radius: 10px/);
    assert.doesNotMatch(cmp, /print-color-adjust/);
    assert.match(cmp, /@media print \{\s*\.cmdk-overlay, \.cmdk-trigger, \.tq-search, \.tq-a11y-overlay \{ display: none !important; \}\s*\}/);
  });

  test("browser index shell embeds standalone base once without session radius", () => {
    const html = browserPageHTML('{"sessions":[],"total":0,"page":1,"pageSize":50,"stats":{},"liveSessions":[]}');
    assert.equal((html.match(/:root\s*\{/g) || []).length, 1);
    assert.ok(html.includes(STANDALONE_BASE_CSS.trim().slice(0, 48)));
    assert.match(html, /--accent-dim:/);
    assert.doesNotMatch(html, /--radius: 10px/);
    assert.doesNotMatch(html, /print-color-adjust/);
    assert.match(html, /@media print \{\s*\.cmdk-overlay, \.cmdk-trigger, \.tq-search, \.tq-a11y-overlay \{ display: none !important; \}\s*\}/);
  });
});