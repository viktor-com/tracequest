import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createHandle, setHubMode } from "../../src/server/server-http.js";
import { BRAND_ASSETS } from "../../src/ui/brand.js";
import { chatHomePage, runPage, liveSessionPage } from "../../src/browser/run-page.js";
import { browserPageHTML } from "../../src/browser/browser-page-build.js";
import { compareLoadErrorPage } from "../../src/browser/compare-page.js";
import { renderHTML } from "../../src/render.js";
import { SHARE_JS } from "../../src/render/render-share.js";

function httpRequest(port, path, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path, method }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("branding assets preserve bytes over GET and HEAD in local and hub servers", async () => {
  const server = createServer(createHandle({}));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    for (const hub of [false, true]) {
      setHubMode(hub);
      for (const [path, asset] of BRAND_ASSETS) {
        const expected = readFileSync(asset.url);
        const get = await httpRequest(port, path);
        assert.equal(get.status, 200, `${path}, hub=${hub}`);
        assert.equal(get.headers["content-type"], asset.type);
        assert.deepEqual(get.body, expected, `${path} must remain binary-safe, hub=${hub}`);
        const head = await httpRequest(port, path, "HEAD");
        assert.equal(head.status, 200);
        assert.equal(head.headers["content-type"], asset.type);
        assert.equal(head.body.length, 0);
      }
      for (const path of ["/assets/brand/package.json", "/assets/brand/../../package.json", "/assets/brand/%2e%2e%2fpackage.json", "/assets/brand/favicon.ico/extra"]) {
        const res = await httpRequest(port, path);
        assert.equal(res.status, 404, path);
        assert.equal(res.body.toString(), "Not found");
      }
      const post = await httpRequest(port, "/favicon.ico", "POST");
      assert.equal(post.status, hub ? 403 : 405);
      if (!hub) assert.equal(post.headers.allow, "GET, HEAD");
    }
  } finally {
    setHubMode(false);
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

test("SVG artwork contains vector shapes and ICO supplies valid browser-size frames", () => {
  for (const [path, asset] of BRAND_ASSETS) {
    if (!path.endsWith(".svg")) continue;
    const svg = readFileSync(asset.url, "utf8");
    assert.match(svg, /<svg\b[^>]*\bviewBox=/, path);
    assert.match(svg, /<path\b[^>]*\bd=/, path);
    assert.doesNotMatch(svg, /<(?:image|text|script|foreignObject)\b|(?:href|src)\s*=|@import|url\(/i, path);
  }
  const ico = readFileSync(BRAND_ASSETS.get("/favicon.ico").url);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.ok(count >= 3);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + 16 * i;
    const width = ico[entry] || 256;
    assert.equal(ico[entry + 1] || 256, width);
    sizes.push(width);
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(bytes > 0 && offset >= 6 + count * 16 && offset + bytes <= ico.length);
    const frame = ico.subarray(offset, offset + bytes);
    if (frame.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      assert.equal(frame.readUInt32BE(16), width);
      assert.equal(frame.readUInt32BE(20), width);
    } else {
      assert.equal(frame.readUInt32LE(0), 40);
      assert.equal(frame.readInt32LE(4), width);
      assert.equal(frame.readInt32LE(8), width * 2);
    }
  }
  for (const size of [16, 32, 48]) assert.ok(sizes.includes(size), `${size}px favicon frame`);
});

test("served page shells include the TQ mark, wordmark and browser icon links", () => {
  const pages = {
    home: chatHomePage(),
    run: runPage({ run: { id: "branding-run", agent: "claude", cwd: "/repo", startedAt: "2026-10-21T10:00:00Z", status: "running", prompt: "Branding" } }),
    session: liveSessionPage({ session: { hash: "branding-session", path: "/repo/session.jsonl", source: "claude", live: false } }),
    runs: browserPageHTML(JSON.stringify({ sessions: [], total: 0 }), ""),
    compareError: compareLoadErrorPage(),
  };
  for (const [name, html] of Object.entries(pages)) {
    const head = html.slice(0, html.indexOf("</head>"));
    assert.match(head, /<link\b[^>]*rel="icon"[^>]*href="\/favicon\.ico"/, name);
    assert.match(head, /<link\b[^>]*rel="icon"[^>]*href="\/favicon\.svg"/, name);
    const header = html.match(/<header class="app-top">[\s\S]*?<\/header>/)?.[0];
    assert.ok(header, name);
    assert.match(header, /<svg class="app-mark"/, name);
    assert.match(header, /<svg class="app-logotype"/, name);
    assert.match(header, /aria-label="TraceQuest — Chat"/, name);
    assert.doesNotMatch(header, /<img\b|(?:src|href)="\/assets\/brand\//, name);
  }
});

function assertEmbeddedIcon(html) {
  const head = html.slice(0, html.indexOf("</head>"));
  const encoded = head.match(/href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)"/)?.[1];
  assert.ok(encoded, "standalone favicon is embedded");
  assert.equal(Buffer.from(encoded, "base64").toString(), readFileSync(BRAND_ASSETS.get("/favicon.svg").url, "utf8").trim());
  assert.doesNotMatch(head, /href="\/(?:favicon|assets\/brand)/);
}

test("standalone render and client-built share keep their favicon without a server", () => {
  const session = { sessionId: "branding-offline", source: "claude", events: [], stats: {} };
  assertEmbeddedIcon(renderHTML(session));
  const document = {
    querySelector: () => ({ textContent: "body { color: black; }" }),
    getElementsByTagName: () => [{ textContent: "const SESSION = {};\nwindow.rendered = true;" }],
  };
  const sharedHtml = runInNewContext(`${SHARE_JS}\nclientRenderHTML(session)`, { document, session });
  assertEmbeddedIcon(sharedHtml);
  assert.match(sharedHtml, /window\.rendered = true/);
});
