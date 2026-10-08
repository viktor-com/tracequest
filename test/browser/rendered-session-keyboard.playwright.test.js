/**
 * Browser-level accessibility coverage for the rendered session viewer.
 * Uses real renderHTML output in headless Chromium so focus, button activation,
 * and ARIA state changes are verified against the actual shipped document.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { renderHTML } from "../../src/render.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";

function makeRenderedKeyboardSession() {
  const events = [
    {
      type: "user",
      text: "first keyboard chapter run bash tests",
      timestamp: "2026-06-01T10:00:00.000Z",
    },
    {
      type: "assistant",
      text: "I will run the targeted test command.",
      timestamp: "2026-06-01T10:00:02.000Z",
      toolCalls: [{ id: "bash-1", name: "Bash", input: "npm test -- rendered-session" }],
      tokens: { input: 120, output: 80, cacheHit: 0, cacheWrite: 0 },
    },
    {
      type: "tool_result",
      toolUseId: "bash-1",
      text: "ok 1 rendered session keyboard",
      timestamp: "2026-06-01T10:00:04.000Z",
    },
    {
      type: "user",
      text: "second keyboard chapter read documentation panel details",
      timestamp: "2026-06-01T10:07:00.000Z",
    },
    {
      type: "assistant",
      text: "I will inspect the relevant document.",
      timestamp: "2026-06-01T10:07:02.000Z",
      toolCalls: [{ id: "read-1", name: "Read", input: "/repo/docs/ui-style-design-guidelines.md" }],
      tokens: { input: 90, output: 40, cacheHit: 0, cacheWrite: 0 },
    },
    {
      type: "tool_result",
      toolUseId: "read-1",
      text: "Rendered session controls use native buttons.\nKeyboard focus remains visible.\nFilters expose pressed state.",
      timestamp: "2026-06-01T10:07:04.000Z",
    },
    {
      type: "user",
      text: "third keyboard chapter edit session styles",
      timestamp: "2026-06-01T10:08:00.000Z",
    },
    {
      type: "assistant",
      text: "I will make the small style change.",
      timestamp: "2026-06-01T10:08:02.000Z",
      toolCalls: [
        {
          id: "edit-1",
          name: "Edit",
          input: "/repo/src/render/render-session-rules.js",
          diffInfo: {
            oldStr: ".chapter { outline: none; }",
            newStr: ".chapter:focus-visible { outline: 2px solid var(--accent); }",
          },
        },
      ],
      tokens: { input: 110, output: 70, cacheHit: 0, cacheWrite: 0 },
    },
    {
      type: "tool_result",
      toolUseId: "edit-1",
      text: "updated",
      timestamp: "2026-06-01T10:08:04.000Z",
    },
  ];

  return {
    sessionId: "rendered-session-keyboard-pw",
    source: "claude",
    cwd: "/repo",
    model: "claude-test",
    startTime: "2026-06-01T10:00:00.000Z",
    endTime: "2026-06-01T10:08:05.000Z",
    durationMs: 485000,
    eventCount: events.length,
    events,
    stats: {
      toolCounts: { Bash: 1, Read: 1, Edit: 1 },
      totalInputTokens: 320,
      totalOutputTokens: 190,
      totalCacheHit: 0,
      errors: 0,
      userMessages: 3,
      assistantTurns: 3,
      tokensEstimated: false,
    },
  };
}

function makeRenderedDiagnosticStripSession() {
  const session = makeRenderedKeyboardSession();
  const toolNames = ["Bash", "Read", "Edit", "Grep", "Write"];
  const extraEvents = [];

  for (let chapter = 4; chapter <= 12; chapter++) {
    const toolName = toolNames[(chapter - 1) % toolNames.length];
    extraEvents.push(
      {
        type: "user",
        text: `diagnostic strip chapter ${chapter} checks minimap and tool flow semantics`,
        timestamp: `2026-06-01T10:${String(10 + chapter).padStart(2, "0")}:00.000Z`,
      },
      {
        type: "assistant",
        text: `I will use ${toolName} for diagnostic chapter ${chapter}.`,
        timestamp: `2026-06-01T10:${String(10 + chapter).padStart(2, "0")}:02.000Z`,
        toolCalls: [{ id: `diag-${chapter}`, name: toolName, input: `chapter ${chapter}` }],
        tokens: { input: 70 + chapter, output: 30 + chapter, cacheHit: 0, cacheWrite: 0 },
      },
      {
        type: "tool_result",
        toolUseId: `diag-${chapter}`,
        text: `diagnostic result ${chapter}`,
        timestamp: `2026-06-01T10:${String(10 + chapter).padStart(2, "0")}:04.000Z`,
      },
    );
  }

  session.events = [...session.events, ...extraEvents];
  session.eventCount = session.events.length;
  session.stats = {
    ...session.stats,
    toolCounts: { Bash: 3, Read: 3, Edit: 3, Grep: 2, Write: 1 },
    totalInputTokens: 986,
    totalOutputTokens: 532,
    userMessages: 12,
    assistantTurns: 12,
  };
  return session;
}

async function hiddenChapterCount(page) {
  return page.locator(".chapter.filter-hidden").count();
}

async function activeElementLabel(page) {
  return page.evaluate(() => document.activeElement?.getAttribute("aria-label") || "");
}

async function expectVisibleText(locator, text) {
  await locator.waitFor({ state: "visible" });
  assert.match(await locator.innerText(), text);
}

async function withRenderedSessionPage(fn, session = makeRenderedKeyboardSession()) {
  const html = renderHTML(session);
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (path === "/" || path === "/session.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
  try {
    await fn(`http://127.0.0.1:${port}/session.html`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("rendered session keyboard accessibility", () => {
  test(
    "rendered session keyboard workflow updates filter and chapter accessibility state",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedSessionPage(async (url) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "load" });
          await page.waitForFunction(() => document.querySelectorAll(".chapter").length === 3);

          const bashChip = page.getByRole("button", { name: "Filter chapters by Bash" });
          await bashChip.focus();
          assert.equal(await activeElementLabel(page), "Filter chapters by Bash");
          assert.equal(await bashChip.getAttribute("aria-pressed"), "false");

          await page.keyboard.press("Enter");
          await page.locator("#filter-count", { hasText: "1/3" }).waitFor();
          assert.equal(await bashChip.getAttribute("aria-pressed"), "true");
          assert.equal(await hiddenChapterCount(page), 2);
          await page.locator("#chapter-0:not(.filter-hidden)", { hasText: "first keyboard chapter" }).waitFor();

          await page.keyboard.press("Enter");
          await page.waitForFunction(() => document.querySelectorAll(".chapter.filter-hidden").length === 0);
          assert.equal(await bashChip.getAttribute("aria-pressed"), "false");
          assert.equal(await page.locator("#filter-count").innerText(), "");

          await page.keyboard.press("/");
          const search = page.getByRole("textbox", { name: "Search chapters" });
          await search.waitFor({ state: "visible" });
          assert.equal(await activeElementLabel(page), "Search chapters");
          await search.fill("read documentation");
          await page.locator("#filter-count", { hasText: "1/3" }).waitFor();
          assert.equal(await hiddenChapterCount(page), 2);

          await page.keyboard.press("j");
          assert.equal(await page.locator(".chapter.kb-focused").count(), 0, "j is ignored while search has focus");
          assert.equal(await search.inputValue(), "read documentationj", "j types into chapter search");

          await page.keyboard.type("/ojkg?x");
          assert.equal(await search.inputValue(), "read documentationj/ojkg?x");
          assert.equal(await page.locator(".chapter.kb-focused").count(), 0, "printable keys stay in chapter search");

          await page.keyboard.press("Escape");
          await page.waitForFunction(() => document.querySelector(".filter-search")?.value === "");
          await page.waitForFunction(() => document.querySelectorAll(".chapter.filter-hidden").length === 0);

          await page.keyboard.press("j");
          await page.locator("#chapter-0.kb-focused").waitFor();
          await page.keyboard.press("j");
          await page.locator("#chapter-1.kb-focused").waitFor();

          await page.keyboard.press("Enter");
          await page.locator("#chapter-1.expanded.kb-focused").waitFor();
          await page.locator("#chapter-1 .chapter-detail", { hasText: "docs/ui-style-design-guidelines.md" }).waitFor();
          assert.match(page.url(), /#chapter-1$/);
        } finally {
          await browser.close();
        }
      });
    },
  );

  test(
    "chapter search inserts /ojkg?x into the field while a form field is focused",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedSessionPage(async (url) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "load" });
          await page.waitForFunction(() => document.querySelectorAll(".chapter").length === 3);

          await page.keyboard.press("j");
          await page.locator("#chapter-0.kb-focused").waitFor();

          const search = page.getByRole("textbox", { name: "Search chapters" });
          await search.click();
          await search.fill("");
          await page.keyboard.type("/ojkg?x");
          assert.equal(await search.inputValue(), "/ojkg?x");
          assert.equal(await page.locator(".chapter.kb-focused").count(), 1);
          assert.ok(await page.locator("#chapter-0.kb-focused").count());
          assert.equal(await page.locator("#chapter-0.expanded").count(), 0, "o must not toggle the focused chapter");
        } finally {
          await browser.close();
        }
      });
    },
  );

  test(
    "rendered analytics chart keyboard workflow focuses canvases and jumps chapters",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedSessionPage(async (url) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "load" });
          await page.waitForFunction(() => document.querySelectorAll(".chapter").length === 3);

          const waveform = page.getByRole("button", { name: /Waveform chart/ });
          await waveform.waitFor();
          await waveform.focus();
          assert.match(await activeElementLabel(page), /Waveform chart/);
          await expectVisibleText(page.locator(".waveform-tooltip"), /chapter 1/);

          await page.keyboard.press("ArrowRight");
          await expectVisibleText(page.locator(".waveform-tooltip"), /chapter 2/);
          await page.keyboard.press("ArrowLeft");
          await expectVisibleText(page.locator(".waveform-tooltip"), /chapter 1/);
          await page.keyboard.press("End");
          await expectVisibleText(page.locator(".waveform-tooltip"), /chapter 3/);

          await page.keyboard.press("Enter");
          await page.locator("#chapter-2.highlight").waitFor();
          await page.keyboard.press("Home");
          await expectVisibleText(page.locator(".waveform-tooltip"), /chapter 1/);
          await page.keyboard.press(" ");
          await page.locator("#chapter-0.highlight").waitFor();

          const costChart = page.getByRole("button", { name: /Cost progression chart/ });
          await costChart.waitFor();
          await costChart.focus();
          assert.match(await activeElementLabel(page), /Cost progression chart/);
          await expectVisibleText(page.locator(".cost-chart-tooltip"), /chapter 1/);

          await page.keyboard.press("ArrowRight");
          await expectVisibleText(page.locator(".cost-chart-tooltip"), /chapter 2/);
          await page.keyboard.press("ArrowLeft");
          await expectVisibleText(page.locator(".cost-chart-tooltip"), /chapter 1/);
          await page.keyboard.press("End");
          await expectVisibleText(page.locator(".cost-chart-tooltip"), /chapter 3/);

          await page.keyboard.press("Enter");
          await page.locator("#chapter-2.highlight").waitFor();
          await page.keyboard.press("Home");
          await expectVisibleText(page.locator(".cost-chart-tooltip"), /chapter 1/);
          await page.keyboard.press(" ");
          await page.locator("#chapter-0.highlight").waitFor();
        } finally {
          await browser.close();
        }
      });
    },
  );

  test(
    "rendered activity timeline keyboard workflow exposes diagnostics and jumps chapters",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedSessionPage(async (url) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "load" });
          await page.waitForFunction(() => document.querySelectorAll(".chapter").length === 3);

          const timeline = page.getByRole("button", { name: /Activity timeline/ });
          await timeline.waitFor();
          await timeline.focus();
          assert.match(await activeElementLabel(page), /Activity timeline/);
          await expectVisibleText(page.locator(".activity-timeline-tooltip"), /ch 1/);

          await page.keyboard.press("ArrowRight");
          await page.keyboard.press("ArrowRight");
          await expectVisibleText(page.locator(".activity-timeline-tooltip"), /idle gap/);

          await page.keyboard.press("End");
          await expectVisibleText(page.locator(".activity-timeline-tooltip"), /ch 3/);
          await page.keyboard.press("Enter");
          await page.locator("#chapter-2.highlight").waitFor();
        } finally {
          await browser.close();
        }
      });
    },
  );

  test(
    "rendered diagnostic strips expose accessibility tree semantics",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedSessionPage(
        async (url) => {
          const browser = await chromium.launch({ headless: true });
          try {
            const page = await browser.newPage();
            await page.goto(url, { waitUntil: "load" });
            await page.waitForFunction(() => document.querySelectorAll(".chapter").length === 12);

            const toolFlow = page.getByRole("list", { name: "Tool usage sequence by chapter" });
            await toolFlow.waitFor();
            const toolFlowSnapshot = await toolFlow.ariaSnapshot();
            assert.match(toolFlowSnapshot, /^- list "Tool usage sequence by chapter":/);
            assert.match(toolFlowSnapshot, /- listitem "Bash in chapter 1"/);
            assert.match(toolFlowSnapshot, /- listitem "Read in chapter 2"/);
            assert.match(toolFlowSnapshot, /- listitem "Edit in chapter 3"/);
            assert.doesNotMatch(toolFlowSnapshot, /tool-flow-divider/);

            const firstMinimapBlock = page.getByRole("button", { name: "Jump to chapter 1", exact: true });
            await firstMinimapBlock.waitFor();
            assert.equal(await firstMinimapBlock.ariaSnapshot(), '- button "Jump to chapter 1"');
            await firstMinimapBlock.focus();
            const tooltip = page.locator("#minimap-tooltip");
            await tooltip.waitFor({ state: "visible" });
            assert.equal(await tooltip.ariaSnapshot(), '- status: "Ch 1: first keyboard chapter run bash tests"');
          } finally {
            await browser.close();
          }
        },
        makeRenderedDiagnosticStripSession(),
      );
    },
  );
});
