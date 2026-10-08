import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { STANDALONE_BASE_CSS } from "../src/render/render-css.js";
import { comparePage } from "../src/browser/compare-page.js";
import { browserPageHTML } from "../src/browser/browser-page-build.js";
import { emptyCompareSession } from "./helpers/minimal-session.js";

describe("render-css STANDALONE_BASE_CSS", () => {
  test("includes shared theme tokens and reset", () => {
    assert.match(STANDALONE_BASE_CSS, /--bg: #111113/);
    assert.match(STANDALONE_BASE_CSS, /--accent-dim:/);
    assert.match(STANDALONE_BASE_CSS, /box-sizing: border-box/);
    assert.equal((STANDALONE_BASE_CSS.match(/:root/g) || []).length, 1);
  });

  test("compare and browser pages embed base once", () => {
    const cmp = comparePage(emptyCompareSession(), emptyCompareSession({
      sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
      _path: "/tmp/b.jsonl",
    }));
    const browser = browserPageHTML('{"sessions":[],"total":0,"page":1,"pageSize":50,"stats":{},"liveSessions":[]}', "");
    for (const html of [cmp, browser]) {
      assert.equal((html.match(/:root\s*\{/g) || []).length, 1, "single :root block");
      assert.ok(html.includes("--accent-dim:"), "accent-dim from shared base");
    }
  });
});