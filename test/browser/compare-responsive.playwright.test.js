/**
 * Browser-level responsive coverage for the compare worksheet.
 * Loads generated compare HTML in headless Chromium so mobile media rules are
 * verified against actual layout metrics, not only CSS text.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { comparePage } from "../../src/browser/compare-page.js";
import { emptyCompareSession } from "../helpers/minimal-session.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

function compareHtmlWithLongToolLabel() {
  const longToolName = "TracequestResponsiveComparisonDiagnosticToolWithVeryLongName";
  return {
    longToolName,
    html: comparePage(
      emptyCompareSession({
        stats: { toolCounts: { [longToolName]: 12 } },
      }),
      emptyCompareSession({
        sessionId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        stats: { toolCounts: { [longToolName]: 7 } },
        _path: "/tmp/b.jsonl",
      }),
    ),
  };
}

describe("compare responsive tool labels", () => {
  test(
    "long tool labels truncate without widening the narrow viewport",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage({ viewport: { width: 390, height: 720 } });
        const { html, longToolName } = compareHtmlWithLongToolLabel();
        await page.setContent(html, { waitUntil: "load" });

        const label = page.locator(".tool-cmp-name", { hasText: longToolName }).first();
        await label.waitFor({ state: "visible" });

        const labelMetrics = await label.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return {
            clientWidth: el.clientWidth,
            scrollWidth: el.scrollWidth,
            maxWidth: style.maxWidth,
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            whiteSpace: style.whiteSpace,
          };
        });
        assert.ok(
          labelMetrics.scrollWidth > labelMetrics.clientWidth,
          "long tool label should be clipped by the mobile label box",
        );

        const pageMetrics = await page.evaluate(() => {
          const tracked = [document.querySelector(".container"), ...document.querySelectorAll(".tool-cmp-row")]
            .filter(Boolean)
            .map((el) => el.getBoundingClientRect());
          return {
            viewportWidth: window.innerWidth,
            scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
            rightmostTrackedEdge: Math.max(...tracked.map((rect) => rect.right)),
          };
        });
        assert.ok(
          pageMetrics.scrollWidth <= pageMetrics.viewportWidth + 1,
          `compare page should not horizontally overflow: ${pageMetrics.scrollWidth} > ${pageMetrics.viewportWidth}`,
        );
        assert.ok(
          pageMetrics.rightmostTrackedEdge <= pageMetrics.viewportWidth + 1,
          `compare rows should stay inside viewport: ${pageMetrics.rightmostTrackedEdge} > ${pageMetrics.viewportWidth}`,
        );
      } finally {
        await browser.close();
      }
    },
  );
});
