/**
 * Browser integration test for sharing-integration.md Test 11 — share modal UX.
 * Real rendered HTML in headless Chromium; mocks Gist upload via Playwright routing.
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

function minimalSession(sessionId, { prompt = "hello share browser" } = {}) {
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

async function withRenderedPage(fn) {
  const dir = mkTmp("tracequest-share-pw-");
  const sessionPath = writeClaudeJsonl(dir, "sess-browser.jsonl", minimalSession("share-pw-11"));
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

describe("sharing-integration.md Test 11 — share modal browser UX", () => {
  test(
    "modal opens with target selector, token input, and status area",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedPage(async (url) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "load" });
          await openShareModal(page);

          await page.locator(".hf-modal-title", { hasText: "Share session" }).waitFor();
          await page.locator('input[name="share-target"][value="gist"]').waitFor();
          await page.locator('input[name="share-target"][value="hf"]').waitFor();
          await page.locator(".hf-modal-input[type='password']").waitFor();
          await page.locator(".hf-modal-actions button.hf-modal-share").waitFor();
          await page.locator("button.hf-modal-cancel").waitFor();
        } finally {
          await browser.close();
        }
      });
    },
  );

  test(
    "token input persists gist and HF tokens in localStorage per adapter",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      await withRenderedPage(async (url) => {
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(url, { waitUntil: "load" });
          await openShareModal(page);

          const tokenInput = page.locator(".hf-modal-input[type='password']");
          await tokenInput.fill("ghp_browser_gist_token");
          const ghStored = await page.evaluate(() => localStorage.getItem("tracequest-gh-token"));
          assert.equal(ghStored, "ghp_browser_gist_token");

          await page.locator('input[name="share-target"][value="hf"]').check();
          await page.locator(".hf-modal-input[type='text']").waitFor({ state: "visible" });
          await tokenInput.fill("hf_browser_token");
          const hfStored = await page.evaluate(() => localStorage.getItem("tracequest-hf-token"));
          assert.equal(hfStored, "hf_browser_token");

          await page.locator('input[name="share-target"][value="gist"]').check();
          await page.locator(".hf-modal-input[type='text']").waitFor({ state: "hidden" });
          const gistValue = await tokenInput.inputValue();
          assert.equal(gistValue, "ghp_browser_gist_token");
        } finally {
          await browser.close();
        }
      });
    },
  );

  test(
    "mocked gist upload disables share button then shows hf-success preview URL",
    SKIP_NO_PLAYWRIGHT,
    async () => {
      const { chromium } = PLAYWRIGHT;
      const gistId = "pw-browser-gist-abc123";
      const rawGistUrl = `https://gist.github.com/user/${gistId}`;

      await withRenderedPage(async (url, { hash }) => {
        const gistFilename = `tracequest-claude-${hash}.html`;
        const previewUrl = `https://gisthost.github.io/?${gistId}/${gistFilename}`;
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          let uploadSeen = false;
          await page.route("**/api.github.com/gists", async (route) => {
            uploadSeen = true;
            await new Promise((r) => setTimeout(r, 150));
            await route.fulfill({
              status: 201,
              contentType: "application/json",
              body: JSON.stringify({
                id: gistId,
                html_url: rawGistUrl,
                files: {
                  [gistFilename]: { content: "<html></html>" },
                },
              }),
            });
          });

          await page.goto(url, { waitUntil: "load" });
          await openShareModal(page);

          await page.locator(".hf-modal-input[type='password']").fill("ghp_mock_upload_token");
          const shareBtn = page.locator("button.hf-modal-share");
          await shareBtn.click();

          await page.locator(".hf-modal-status", { hasText: "Uploading" }).last().waitFor();
          assert.equal(await shareBtn.isDisabled(), true, "share button should disable during upload");

          const success = page.locator(".hf-modal-status.hf-success").last();
          await success.waitFor({ timeout: 10_000 });
          const statusText = await success.innerText();
          assert.match(statusText, /Shared!/);
          assert.match(statusText, new RegExp(previewUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
          const linkHref = await success.locator("a").first().getAttribute("href");
          assert.equal(linkHref, previewUrl);
          assert.ok(uploadSeen, "browser should POST to GitHub gists API");
          await shareBtn.isEnabled();
        } finally {
          await browser.close();
        }
      });
    },
  );

  test("mocked gist upload failure shows hf-error status message", SKIP_NO_PLAYWRIGHT, async () => {
    const { chromium } = PLAYWRIGHT;

    await withRenderedPage(async (url) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.route("**/api.github.com/gists", async (route) => {
          await route.fulfill({
            status: 401,
            contentType: "text/plain",
            body: "Bad credentials",
          });
        });

        await page.goto(url, { waitUntil: "load" });
        await openShareModal(page);
        await page.locator(".hf-modal-input[type='password']").fill("ghp_bad_token");
        await page.locator("button.hf-modal-share").click();

        const error = page.locator(".hf-modal-status.hf-error").last();
        await error.waitFor({ timeout: 10_000 });
        const message = await error.innerText();
        assert.match(message, /Gist upload failed \(401\)/);
        assert.match(message, /Bad credentials/);
      } finally {
        await browser.close();
      }
    });
  });

  test("share without token shows hf-error Token required", SKIP_NO_PLAYWRIGHT, async () => {
    const { chromium } = PLAYWRIGHT;

    await withRenderedPage(async (url) => {
      const browser = await chromium.launch({ headless: true });
      try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "load" });
        await openShareModal(page);
        await page.locator("button.hf-modal-share").click();

        const error = page.locator(".hf-modal-status.hf-error", { hasText: "Token required" }).last();
        await error.waitFor({ timeout: 5_000 });
      } finally {
        await browser.close();
      }
    });
  });
});
