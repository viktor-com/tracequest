import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COMPARE_PAGE_CSS } from "../../src/browser/compare-page-css.js";
import { comparePage } from "../../src/browser/compare-page.js";

function mobileBlock(css) {
  const m = css.match(/@media \(max-width: 600px\)\s*\{([\s\S]*)\}\s*$/);
  return m ? m[1] : "";
}

describe("compare-page-css — module contract", () => {
  test("COMPARE_PAGE_CSS is a non-empty embed fragment without :root", () => {
    assert.ok(COMPARE_PAGE_CSS.length > 2000);
    assert.match(COMPARE_PAGE_CSS, /\.container\s*\{/);
    assert.doesNotMatch(COMPARE_PAGE_CSS, /:root\s*\{/);
    assert.doesNotMatch(COMPARE_PAGE_CSS, /@media print/);
  });
});

describe("compare-page-css — metric table", () => {
  test("cmp-table uses full-width collapsed borders and row dividers", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-table\s*\{\s*width: 100%;\s*border-collapse: collapse;/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-table tr \{ border-bottom: 1px solid var\(--border\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-table tr:last-child \{ border-bottom: none; \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-table td \{ padding: 7px 0; vertical-align: middle; \}/);
  });

  test("cmp-label column is centered mono with fixed width", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-label\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /text-align: center/);
    assert.match(COMPARE_PAGE_CSS, /font-family: var\(--mono\)/);
    assert.match(COMPARE_PAGE_CSS, /white-space: nowrap/);
    assert.match(COMPARE_PAGE_CSS, /width: 160px/);
    assert.match(COMPARE_PAGE_CSS, /padding: 7px 12px/);
  });

  test("cmp-val cells use tabular mono with side-specific alignment", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-val\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /font-variant-numeric: tabular-nums/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-val:first-child \{ text-align: right; color: var\(--fg\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-val:last-child \{ text-align: left; color: var\(--fg\); \}/);
    assert.match(COMPARE_PAGE_CSS, /padding: 7px 8px/);
  });

  test("cmp-col-headers grid mirrors table column widths", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-col-headers\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /grid-template-columns: 1fr 160px 1fr/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-col-a \{ text-align: right; padding-right: 8px; color: var\(--accent\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-col-b \{ text-align: left; padding-left: 8px; color: var\(--orange\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-col-label \{ text-align: center; \}/);
  });
});

describe("compare-page-css — delta classes", () => {
  test("delta-good and delta-bad are cmp-val modifiers with semantic colors", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-val\.delta-good \{ color: var\(--green\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-val\.delta-bad \{ color: var\(--red\); \}/);
    assert.equal((COMPARE_PAGE_CSS.match(/\.delta-good/g) || []).length, 1);
    assert.equal((COMPARE_PAGE_CSS.match(/\.delta-bad/g) || []).length, 1);
    assert.equal(
      COMPARE_PAGE_CSS.match(/(^|\n)\.delta-(good|bad)\s*\{/g),
      null,
      "no bare .delta-good/.delta-bad selectors",
    );
  });

  test("base cmp-val colors stay neutral until delta modifier applies", () => {
    const betweenValAndDelta = COMPARE_PAGE_CSS.slice(
      COMPARE_PAGE_CSS.indexOf(".cmp-val {"),
      COMPARE_PAGE_CSS.indexOf(".cmp-val.delta-good"),
    );
    assert.doesNotMatch(betweenValAndDelta, /--green/);
    assert.doesNotMatch(betweenValAndDelta, /--red/);
  });
});

describe("compare-page-css — session and section chrome", () => {
  test("session cards use two-column grid with accent vs orange top borders", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-sessions\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /grid-template-columns: 1fr 1fr/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-session\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /border-top: 3px solid var\(--accent\)/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-session\.session-b \{ border-top-color: var\(--orange\); \}/);
    assert.match(COMPARE_PAGE_CSS, /min-width: 0/);
    assert.match(COMPARE_PAGE_CSS, /text-overflow: ellipsis/);
  });

  test("cmp-section panels and header/back link styles", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-section\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /background: var\(--surface\)/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-section-title\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /text-transform: uppercase/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-back\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-back:hover \{ color: var\(--fg2\); \}/);
    assert.match(COMPARE_PAGE_CSS, /margin-left: auto/);
  });
});

describe("compare-page-css — tool and outcome visuals", () => {
  test("tool comparison row uses mirrored bar layout with hover emphasis", () => {
    assert.match(COMPARE_PAGE_CSS, /\.tool-cmp-row\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /grid-template-columns: 1fr auto 1fr/);
    assert.match(COMPARE_PAGE_CSS, /\.tool-cmp-left \{ flex-direction: row-reverse; \}/);
    assert.match(COMPARE_PAGE_CSS, /\.tool-cmp-row:hover \.tool-cmp-bar \{ opacity: 1; \}/);
    assert.match(COMPARE_PAGE_CSS, /\.tool-cmp-left \.tool-cmp-count \{ text-align: right; \}/);
    assert.match(COMPARE_PAGE_CSS, /\.tool-cmp-right \.tool-cmp-count \{ text-align: left; \}/);
  });

  test("outcome bars and legend dots map grades to semantic colors", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-outcome-seg\.clean \{ background: var\(--green\)/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-outcome-seg\.corrected \{ background: var\(--orange\)/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-outcome-seg\.struggling \{ background: var\(--red\)/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-outcome-dot\.clean \{ background: var\(--green\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-outcome-dot\.corrected \{ background: var\(--orange\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-outcome-dot\.struggling \{ background: var\(--red\); \}/);
    assert.match(COMPARE_PAGE_CSS, /\.cmp-outcome-bar\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /border-radius: 5px/);
  });

  test("source badge is compact uppercase mono chip", () => {
    assert.match(COMPARE_PAGE_CSS, /\.cmp-source-badge\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /text-transform: uppercase/);
    assert.match(COMPARE_PAGE_CSS, /font-weight: 600/);
    assert.match(COMPARE_PAGE_CSS, /color: #111/);
    assert.match(COMPARE_PAGE_CSS, /border-radius: 4px/);
  });
});

describe("compare-page-css — responsive rules", () => {
  test("@media (max-width: 600px) tightens container padding", () => {
    const mobile = mobileBlock(COMPARE_PAGE_CSS);
    assert.ok(mobile.length > 100, "mobile block present");
    assert.match(mobile, /\.container \{ padding: 24px 12px; \}/);
  });

  test("mobile layout stacks sessions and outcome grids", () => {
    const mobile = mobileBlock(COMPARE_PAGE_CSS);
    assert.match(mobile, /\.cmp-sessions \{ grid-template-columns: 1fr; \}/);
    assert.match(mobile, /\.cmp-outcome \{ grid-template-columns: 1fr; \}/);
  });

  test("mobile metric table narrows label column and font sizes", () => {
    const mobile = mobileBlock(COMPARE_PAGE_CSS);
    assert.match(mobile, /\.cmp-label \{ width: 100px; font-size: 11px; padding: 5px 6px; \}/);
    assert.match(mobile, /\.cmp-val \{ font-size: 12px; \}/);
    assert.match(mobile, /\.cmp-col-headers \{ grid-template-columns: 1fr 100px 1fr; \}/);
  });

  test("tool rows keep three-column grid on narrow screens", () => {
    const mobile = mobileBlock(COMPARE_PAGE_CSS);
    assert.match(mobile, /\.tool-cmp-row \{ grid-template-columns: 1fr auto 1fr; \}/);
  });

  test("tool labels truncate instead of widening the mobile worksheet", () => {
    assert.match(COMPARE_PAGE_CSS, /\.tool-cmp-name\s*\{/);
    assert.match(COMPARE_PAGE_CSS, /white-space: nowrap/);
    assert.match(COMPARE_PAGE_CSS, /max-width: 180px/);
    assert.match(COMPARE_PAGE_CSS, /overflow: hidden/);
    assert.match(COMPARE_PAGE_CSS, /text-overflow: ellipsis/);

    const mobile = mobileBlock(COMPARE_PAGE_CSS);
    assert.match(mobile, /\.tool-cmp-name \{ max-width: 96px; \}/);
  });
});

describe("compare-page-css — page embed", () => {
  test("comparePage inlines COMPARE_PAGE_CSS after standalone base", () => {
    const session = {
      sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      source: "claude",
      model: "",
      durationMs: 0,
      events: [],
      stats: {},
      _path: "/tmp/a.jsonl",
    };
    const html = comparePage(session, {
      ...session,
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    });
    assert.ok(html.includes(COMPARE_PAGE_CSS.trim().slice(0, 60)));
    assert.match(html, /\.cmp-val\.delta-good/);
    assert.match(html, /@media \(max-width: 600px\)/);
  });
});
