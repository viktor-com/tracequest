/**
 * Browser integration tests for sharing-integration.md Test 10/11 — HF adapter in share modal.
 * Real rendered HTML in headless Chromium; mocks Hugging Face Hub API via Playwright routing.
 * Skips when Playwright chromium is unavailable (see test/helpers/playwright-gate.js).
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeClaudeJsonl, CLAUDE_FIXTURE_MODEL } from "../helpers/fixtures.js";
import { PLAYWRIGHT, SKIP_NO_PLAYWRIGHT } from "../helpers/playwright-gate.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;

const HF_NAMESPACE = "testuser";
const HF_REPO = "tracequest-sessions";
const HF_REPO_SLUG = `${HF_NAMESPACE}/${HF_REPO}`;

function minimalSession(sessionId, { prompt = "hello hf share browser" } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  return [
    {
      type: "user",
      sessionId,
      cwd: "/home/dev/tracequest",
      timestamp: ts,
      uuid: `u-${sessionId}`,
      isMeta: false,
      message: { content: [{ type: "text", text: prompt }] },
    },
    {
      type: "assistant",
      sessionId,
      timestamp: ts,
      uuid: `a-${sessionId}`,
      message: {
        model: CLAUDE_FIXTURE_MODEL,
        content: [{ type: "text", text: "ok" }],
      },
    },
  ];
}

function renderSessionHtml(sessionPath, outPath) {
  const result = spawnSync(NODE, [BIN, "render", sessionPath, "--out", outPath], {
    cwd: ROOT,
    encoding: "utf-8",
    env: {
      ...process.env,
      TRACEQUEST_NO_SIDECAR: "1",
      TRACEQUEST_SKIP_LR_WATCH: "1",
    },
  });
  if (result.status !== 0) {
    throw new Error(
      `render failed (${result.status})\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
}

async function withStaticServer(filePath, fn) {
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    if (path === "/" || path === "/session.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(filePath));
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

async function withRenderedPage(sessionId, fn) {
  const dir = mkTmp("tracequest-share-hf-pw-");
  const sessionPath = writeClaudeJsonl(dir, "sess-hf-browser.jsonl", minimalSession(sessionId));
  const htmlPath = join(dir, "session.html");
  try {
    renderSessionHtml(sessionPath, htmlPath);
    await withStaticServer(htmlPath, (url) => fn(url, { sessionPath, hash: sessionHash(sessionPath) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function openShareModal(page) {
  const shareBtn = page.locator("button.hf-btn");
  await shareBtn.waitFor({ state: "visible", timeout: 15_000 });
  await shareBtn.click();
  const overlay = page.locator(".hf-modal-overlay");
  await overlay.waitFor({ state: "visible", timeout: 5_000 });
  return overlay;
}

async function selectHfTarget(page) {
  await page.locator('input[name="share-target"][value="hf"]').check();
  await page.locator('input.hf-modal-input[type="text"]').waitFor({ state: "visible" });
}

/**
 * Mock HF Hub API for browser share flow (new dataset repo).
 * @param {import('playwright').Page} page
 * @param {{ failCommit?: boolean }} [opts]
 */
async function installHfApiMocks(page, { failCommit = false, sessionHash: expectedSessionHash = "share-hf-pw-11" } = {}) {
  const calls = [];
  const previewHtmlPath = `sessions/claude/${expectedSessionHash}.html`;
  const previewUrl = `https://huggingface.co/datasets/${HF_REPO_SLUG}/blob/main/${previewHtmlPath}`;

  await page.route("**/huggingface.co/**", async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    calls.push({ url, method });

    if (url.includes("/api/whoami-v2")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ name: HF_NAMESPACE }),
      });
      return;
    }

    if (url.includes(`/api/datasets/${HF_REPO_SLUG}`) && method === "GET") {
      await route.fulfill({ status: 404, body: "not found" });
      return;
    }

    if (url.endsWith("/api/repos/create") && method === "POST") {
      const body = route.request().postDataJSON();
      assert.equal(body.type, "dataset");
      assert.equal(body.name, HF_REPO);
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }

    if (url.includes(`/api/datasets/${HF_REPO_SLUG}/commit/main`) && method === "POST") {
      if (failCommit) {
        await route.fulfill({ status: 403, contentType: "text/plain", body: "Forbidden dataset write" });
        return;
      }
      const body = route.request().postDataJSON();
      const paths = body.operations.map((op) => op.path);
      assert.ok(paths.some((p) => p.endsWith(".html")), "commit should include html file");
      assert.ok(paths.some((p) => p.endsWith(".json")), "commit should include json sidecar");
      assert.ok(paths.includes("README.md"), "first share should add README.md");
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }

    await route.fulfill({ status: 404, body: `unmocked HF route: ${method} ${url}` });
  });

  return { calls, previewUrl };
}

describe("sharing-integration.md — HF adapter share modal browser UX", () => {
  test(
    "selecting HF target shows repo input and persists tracequest-hf-repo in localStorage",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedPage("share-hf-pw-11", async (url) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "load" });
          await openShareModal(page);

          const gistRepo = page.locator('input.hf-modal-input[type="text"]');
          await gistRepo.waitFor({ state: "hidden" });

          await selectHfTarget(page);
          await gistRepo.fill(HF_REPO_SLUG);
          const stored = await page.evaluate(() => localStorage.getItem("tracequest-hf-repo"));
          assert.equal(stored, HF_REPO_SLUG);

          await page.locator('input[name="share-target"][value="gist"]').check();
          await gistRepo.waitFor({ state: "hidden" });

          await page.locator('input[name="share-target"][value="hf"]').check();
          await gistRepo.waitFor({ state: "visible" });
          assert.equal(await gistRepo.inputValue(), HF_REPO_SLUG);
        } finally {
          await browser.close();
        }
      });
    },
  );

  test(
    "mocked HF upload disables share button then shows hf-success dataset preview URL",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;

      await withRenderedPage("share-hf-pw-11", async (url, { hash }) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          const { calls, previewUrl } = await installHfApiMocks(page, { sessionHash: hash });

          await page.goto(url, { waitUntil: "load" });
          await openShareModal(page);
          await selectHfTarget(page);

          await page.locator(".hf-modal-input[type='password']").fill("hf_mock_browser_token");
          await page.locator('input.hf-modal-input[type="text"]').fill(HF_REPO_SLUG);

          const shareBtn = page.locator("button.hf-modal-share");
          await shareBtn.click();

          await page.locator(".hf-modal-status", { hasText: "Uploading" }).last().waitFor();
          assert.equal(await shareBtn.isDisabled(), true, "share button should disable during HF upload");

          const success = page.locator(".hf-modal-status.hf-success").last();
          await success.waitFor({ timeout: 15_000 });
          const statusText = await success.innerText();
          assert.match(statusText, /Shared!/);
          assert.match(statusText, new RegExp(previewUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          const linkHref = await success.locator("a").first().getAttribute("href");
          assert.equal(linkHref, previewUrl);

          assert.ok(
            calls.some((c) => c.url.includes("/api/repos/create") && c.method === "POST"),
            "browser should POST to HF repos/create",
          );
          assert.ok(
            calls.some((c) => c.url.includes("/commit/main") && c.method === "POST"),
            "browser should POST HF dataset commit",
          );
          await shareBtn.isEnabled();
        } finally {
          await browser.close();
        }
      });
    },
  );

  test("mocked HF commit failure shows hf-error status message", SKIP_NO_PLAYWRIGHT, async () => {
    const { chromium } = PLAYWRIGHT;

    await withRenderedPage("share-hf-pw-11", async (url) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await installHfApiMocks(page, { failCommit: true });

        await page.goto(url, { waitUntil: "load" });
        await openShareModal(page);
        await selectHfTarget(page);
        await page.locator(".hf-modal-input[type='password']").fill("hf_bad_token");
        await page.locator('input.hf-modal-input[type="text"]').fill(HF_REPO_SLUG);
        await page.locator("button.hf-modal-share").click();

        const error = page.locator(".hf-modal-status.hf-error").last();
        await error.waitFor({ timeout: 15_000 });
        const message = await error.innerText();
        assert.match(message, /HF commit failed/);
        assert.match(message, /Forbidden dataset write/);
      } finally {
        await browser.close();
      }
    });
  });
});
