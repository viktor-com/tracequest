import "../helpers/skip-lr-watch-env.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";

import { createHandle } from "../../src/server/server-http.js";
import { MARK_SVG, LOGO_SVG, FAVICON_SVG, FAVICON_LINK } from "../../src/ui/brand-mark.js";
import { appTopHtml, APP_TOP_CSS } from "../../src/browser/app-chrome.js";

const servers = [];
afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

function get(handle, path) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      http
        .get(`http://127.0.0.1:${server.address().port}${path}`, (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
        })
        .on("error", reject);
    });
  });
}

test("brand mark: header wordmark renders the TRACEQUEST logotype with an accent trace", () => {
  const top = appTopHtml({ nav: "chat" });
  assert.ok(top.includes(MARK_SVG), "app top bar embeds the mark");
  assert.match(MARK_SVG, /stroke="currentColor"/);
  assert.match(MARK_SVG, /class="app-mark-trace"/);
  assert.match(APP_TOP_CSS, /\.app-mark-trace\s*\{\s*fill:\s*var\(--accent\)/);
  assert.doesNotMatch(top, /M5 11\.5h2\.5l1\.5-5/, "old zigzag mark is gone");
});

test("brand mark: /favicon.svg serves a theme-aware SVG favicon", async () => {
  const res = await get(createHandle({}), "/favicon.svg");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /^image\/svg\+xml/);
  assert.equal(res.body, FAVICON_SVG);
  assert.match(res.body, /prefers-color-scheme:dark/);
  assert.match(res.body, /fill="#f54e00"/);
});

test("brand mark: every served page head links the favicon", () => {
  const files = [
    "src/routes/route-handlers-pages.js",
    "src/browser/browser-page-build.js",
    "src/browser/compare-page.js",
    "src/browser/run-page.js",
  ];
  for (const f of files) {
    const src = readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    const boots = src.split("${THEME_BOOT_SCRIPT}").length - 1;
    const linked = src.split("${THEME_BOOT_SCRIPT}${FAVICON_LINK}").length - 1;
    assert.ok(boots > 0, `${f} boots the theme`);
    assert.equal(linked, boots, `${f}: every head links the favicon`);
  }
  const insights = readFileSync(new URL("../../src/browser/insights-page.js", import.meta.url), "utf8");
  assert.ok(insights.includes("</title>\n${FAVICON_LINK}"), "insights page head links the favicon");
  assert.match(FAVICON_LINK, /rel="icon".*href="\/favicon\.svg"/);
});

test("brand mark: README shows docs/assets/logo.svg, the stacked logo from brand-mark.js", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(readme.split("\n")[0], /<img src="docs\/assets\/logo\.svg"/);
  const logo = readFileSync(new URL("../../docs/assets/logo.svg", import.meta.url), "utf8");
  assert.equal(logo, LOGO_SVG);
});
