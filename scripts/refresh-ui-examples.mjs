#!/usr/bin/env node
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { browserPageHTML } from "../src/browser/browser-page-build.js";
import { comparePage } from "../src/browser/compare-page.js";
import { renderHTML } from "../src/render.js";

const ROOT = new URL("..", import.meta.url);
const OUT_DIR = new URL("docs/ui-examples/", ROOT);
const VIEWPORT = { width: 1100, height: 1600 };

function iso(minutes) {
  return new Date(Date.UTC(2026, 6, 3, 7, 30 + minutes, 0)).toISOString();
}

function toolCall(id, name, input, extra = {}) {
  return { id, name, input, ...extra };
}

function toolResult(toolUseId, text, extra = {}) {
  return { type: "tool_result", toolUseId, text, timestamp: iso(2), ...extra };
}

function session(overrides = {}) {
  const events = overrides.events || [
    {
      type: "user",
      text: "Capture visual examples for the UI style guide and keep the workflow reproducible",
      timestamp: iso(0),
    },
    {
      type: "assistant",
      text: "I will inspect the current UI surfaces, update the screenshot examples, and document the refresh command.",
      timestamp: iso(1),
      tokens: { input: 2100, output: 650, cacheHit: 400 },
      toolCalls: [
        toolCall("read-1", "Read", "docs/ui-style-design-guidelines.md"),
        toolCall("bash-1", "Bash", "node scripts/refresh-ui-examples.mjs"),
        toolCall("edit-1", "Edit", "docs/ui-style-design-guidelines.md", {
          diffInfo: { oldStr: "Screenshot-Oriented Examples", newStr: "Screenshot Refresh Workflow" },
        }),
      ],
    },
    toolResult("read-1", "loaded docs and UI selectors"),
    toolResult("bash-1", "exit 1: missing screenshot target", { isError: true }),
    {
      type: "assistant",
      text: "The first capture failed; I checked the selector and recovered without widening the screenshot surface.",
      timestamp: iso(8),
      tokens: { input: 1200, output: 500, cacheHit: 300 },
      toolCalls: [
        toolCall("write-1", "Write", "scripts/refresh-ui-examples.mjs"),
        toolCall("bash-2", "Bash", "node scripts/refresh-ui-examples.mjs"),
      ],
    },
    toolResult("write-1", "wrote the reproducible refresh command"),
    toolResult("bash-2", "wrote docs/ui-examples/browser-index.png\nwrote docs/ui-examples/compare-analysis.png\nwrote docs/ui-examples/rendered-session-detail.png"),
  ];

  const stats = overrides.stats || {
    toolCounts: { Read: 2, Bash: 2, Edit: 1, Write: 1 },
    totalInputTokens: 4200,
    totalOutputTokens: 1150,
    totalCacheHit: 700,
    errors: 1,
    userMessages: 1,
    assistantTurns: 2,
    tokensEstimated: false,
  };

  return {
    sessionId: "ed510361-1111-2222-3333-444444444444",
    sessionHash: "ed510361",
    path: "/home/dev/.claude/projects/tracequest/session.jsonl",
    _path: "/home/dev/.claude/projects/tracequest/session.jsonl",
    source: "claude",
    cwd: "/home/dev/code/tracequest",
    gitBranch: "docs/ui-visual-retry",
    model: "claude-3-7-sonnet-20250219",
    startTime: iso(0),
    endTime: iso(13),
    durationMs: 13 * 60_000,
    eventCount: events.length,
    events,
    stats,
    ...overrides,
  };
}

function browserRows() {
  const gradeClasses = { A: "grade-a", B: "grade-b", C: "grade-c", D: "grade-d", F: "grade-f" };
  const prompts = [
    ["claude", "a13f9c82", "tracequest", "Document session browser examples with filters, dashboard metrics, and compare selection", 0, 2, "A"],
    ["opencode", "b74c21e0", "tracequest-sidecar", "Debug failed sidecar search indexing and preserve row-level error evidence", 4, 0, "C"],
    ["codex", "c05d7a91", "tracequest", "Live run: capture UI screenshots for project design guidelines", 0, 0, "A"],
    ["claude", "d991af44", "tracequest", "Add rendered session print behavior and chapter detail checks", 0, 1, "A"],
    ["claude", "e348b612", "tracequest", "Analyze a high-token browser row without widening the viewport", 1, 0, "B"],
    ["grok", "f24ab908", "tracequest-sidecar", "Compare source badges and compact metadata across providers", 0, 0, "A"],
  ];
  const now = Date.UTC(2026, 6, 3, 8, 20, 0);
  return prompts.map(([source, id, project, prompt, errors, commits, grade], idx) => {
    const toolCounts = { Read: 4 + idx, Bash: 3 + idx, Edit: 2, Grep: 1 };
    const tools = Object.keys(toolCounts);
    const totalTokens = idx === 4 ? 2_300_000 : 85_000 + idx * 37_000;
    return {
      id,
      path: `/tmp/tracequest/${id}.jsonl`,
      source,
      project,
      prompt,
      model: source === "codex" ? "gpt-5-codex" : "claude-3-7-sonnet-20250219",
      mtime: now - idx * 37 * 60_000,
      sizeKB: 51 + idx * 9,
      durationMs: (12 + idx * 4) * 60_000,
      chapters: 4 + idx,
      totalTokens,
      inputTokens: Math.round(totalTokens * 0.55),
      outputTokens: Math.round(totalTokens * 0.25),
      cacheTokens: Math.round(totalTokens * 0.2),
      errors,
      commits,
      files: 6 + idx,
      tools,
      toolCounts,
      grade,
      _gradeCache: { letter: grade, cls: gradeClasses[grade], score: { A: 96, B: 84, C: 73, D: 64, F: 55 }[grade] },
      _costCache: idx === 4 ? 4.81 : 0.19 + idx * 0.07,
      live: idx === 2,
    };
  });
}

function browserData() {
  const sessions = browserRows();
  return {
    sessions,
    total: 128,
    page: 1,
    pageSize: 50,
    liveSessions: [sessions[2]],
    stats: {
      totalSessions: 128,
      totalInputTokens: 4_500_000,
      totalOutputTokens: 1_400_000,
      totalCacheReadTokens: 1_300_000,
      totalDurationMs: 5.5 * 60 * 60 * 1000,
      totalErrors: 37,
      totalCommits: 24,
      totalFiles: 318,
      totalChapters: 412,
      totalCost: 31.42,
      toolAgg: { Bash: 94, Read: 87, Edit: 63, Grep: 35, Write: 21, WebFetch: 12 },
      projectCounts: { tracequest: 79, "tracequest-sidecar": 49 },
      sourceCounts: { claude: 74, codex: 31, opencode: 15, grok: 8 },
      modelCounts: {
        "claude-3-7-sonnet-20250219": 74,
        "gpt-5-codex": 31,
        "opencode": 15,
        "grok": 8,
      },
      gradeDist: { A: 52, B: 34, C: 19, D: 14, F: 9 },
    },
  };
}

function compareSessions() {
  const base = session();
  const peer = session({
    sessionId: "b74c21e0-1111-2222-3333-444444444444",
    sessionHash: "b74c21e0",
    _path: "/home/dev/.opencode/projects/tracequest/session.json",
    path: "/home/dev/.opencode/projects/tracequest/session.json",
    source: "opencode",
    model: "gpt-5-codex",
    durationMs: 21 * 60_000,
    endTime: iso(21),
    stats: {
      toolCounts: { Read: 3, Bash: 5, Edit: 2, Grep: 2, WebFetch: 1 },
      totalInputTokens: 7200,
      totalOutputTokens: 2100,
      totalCacheHit: 300,
      errors: 3,
      userMessages: 2,
      assistantTurns: 4,
      tokensEstimated: false,
    },
    events: [
      { type: "user", text: "Compare the UI example workflow against current rendered surfaces", timestamp: iso(0) },
      {
        type: "assistant",
        text: "I found extra retries and a failing selector before the workflow stabilized.",
        timestamp: iso(3),
        tokens: { input: 2800, output: 900, cacheHit: 120 },
        toolCalls: [
          toolCall("b1", "Read", "src/browser/compare-page.js"),
          toolCall("b2", "Bash", "node scripts/refresh-ui-examples.mjs"),
          toolCall("b3", "Grep", "Screenshot-Oriented Examples"),
        ],
      },
      toolResult("b1", "loaded compare page builder"),
      toolResult("b2", "selector not found", { isError: true }),
      toolResult("b3", "docs/ui-style-design-guidelines.md:233:Screenshot-Oriented Examples", { isError: true }),
      { type: "user", text: "Tighten the refresh note and rerun the capture", timestamp: iso(9) },
      {
        type: "assistant",
        text: "Updated the note and reran the capture successfully.",
        timestamp: iso(21),
        tokens: { input: 4400, output: 1200, cacheHit: 180 },
        toolCalls: [toolCall("b4", "Edit", "docs/ui-style-design-guidelines.md"), toolCall("b5", "Bash", "npm run docs:ui-examples")],
      },
      toolResult("b4", "updated docs"),
      toolResult("b5", "wrote screenshots"),
    ],
  });
  return [base, peer];
}

function writeTempHtml(dir, name, html) {
  const path = join(dir, name);
  writeFileSync(path, html);
  return pathToFileURL(path).href;
}

async function screenshotLocator(page, selector, path) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible" });
  await locator.screenshot({ path });
  console.log(`wrote ${path}`);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "tracequest-ui-examples-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });

    const browserUrl = writeTempHtml(tmp, "browser.html", browserPageHTML(JSON.stringify(browserData()), ""));
    await page.setViewportSize({ width: 1100, height: 950 });
    await page.goto(browserUrl);
    await page.locator(".compare-cb").nth(0).check();
    await page.locator(".compare-cb").nth(1).check();
    await page.waitForTimeout(100);
    await screenshotLocator(page, ".container", join(OUT_DIR.pathname, "browser-index.png"));

    await page.setViewportSize(VIEWPORT);
    const [a, b] = compareSessions();
    const compareUrl = writeTempHtml(tmp, "compare.html", comparePage(a, b));
    await page.goto(compareUrl);
    await page.waitForTimeout(100);
    await screenshotLocator(page, ".container", join(OUT_DIR.pathname, "compare-analysis.png"));

    const renderUrl = writeTempHtml(tmp, "rendered-session.html", renderHTML(a));
    await page.goto(renderUrl);
    await page.locator(".chapter").first().click();
    await page.waitForTimeout(150);
    await screenshotLocator(page, "#app", join(OUT_DIR.pathname, "rendered-session-detail.png"));
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
