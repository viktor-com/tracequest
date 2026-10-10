import "../helpers/skip-lr-watch-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

import { installModVersionTestHygiene } from "../helpers/mod-version-hygiene.js";
import { mkClaudeJsonlTmp } from "../helpers/fixtures.js";
import { minimalSession } from "../helpers/minimal-session.js";
import { renderHTML as staticRenderHTML } from "../../src/render.js";
import { browserPage as staticBrowserPage } from "../../src/browser/browser-page.js";
import {
  hotModules,
  resetHotModulesCacheForTests,
} from "../../src/server/server-state.js";
import { bumpModVersion } from "../../src/server/server-live-reload.js";
import { createHotModuleSnapshotImporter } from "../../src/server/hot-module-snapshot.js";

installModVersionTestHygiene();

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_SRC = readFileSync(
  join(__dirname, "../../src/server/server-state.js"),
  "utf8",
);

const HOT_KEYS = [
  "parseSession",
  "renderHTML",
  "findSessions",
  "peekSession",
  "buildIndex",
  "searchSessions",
  "browserPage",
  "runPage",
  "chatHomePage",
  "liveSessionPage",
];



describe("server-state hotModules contract", () => {
  it("source wires snapshot imports for parse, render, sessions, browser-page", () => {
    assert.match(STATE_SRC, /browserPage: bp\.browserPage/);
  });

  it("hotModules reimports nested helper modules from a fresh src snapshot after modVersion changes", async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "tq-hotmods-src-"));
    try {
      const src = join(root, "src");
      fs.mkdirSync(join(src, "render"), { recursive: true });
      fs.mkdirSync(join(src, "server"), { recursive: true });
      fs.mkdirSync(join(src, "browser"), { recursive: true });

      fs.writeFileSync(
        join(src, "render.js"),
        [
          'import { renderToken } from "./render/render-token.js";',
          'import { serverToken } from "./server/server-token.js";',
          "export function renderHTML() { return `${renderToken}:${serverToken}`; }",
          "",
        ].join("\n")
      );
      fs.writeFileSync(
        join(src, "browser", "browser-page.js"),
        [
          'import { browserToken } from "./browser-client.js";',
          'import { serverToken } from "../server/server-token.js";',
          "export function browserPage() { return `${browserToken}:${serverToken}`; }",
          "",
        ].join("\n")
      );
      fs.writeFileSync(join(src, "parse.js"), "export function parseSession() { return null; }\n");
      fs.writeFileSync(
        join(src, "sessions.js"),
        [
          "export function findSessions() { return []; }",
          "export function peekSession() { return {}; }",
          "export function buildIndex() { return new Map(); }",
          "export function searchSessions() { return []; }",
          "",
        ].join("\n")
      );

      const writeHelpers = (value) => {
        fs.writeFileSync(
          join(src, "render", "render-token.js"),
          `export const renderToken = "render-${value}";\n`
        );
        fs.writeFileSync(
          join(src, "server", "server-token.js"),
          `export const serverToken = "server-${value}";\n`
        );
        fs.writeFileSync(
          join(src, "browser", "browser-client.js"),
          `export const browserToken = "browser-${value}";\n`
        );
      };

      writeHelpers("before");
      const importer = createHotModuleSnapshotImporter(pathToFileURL(src), {
        cacheRoot: join(root, "cache"),
      });
      const [, renderBefore, , browserBefore] = await importer.importEntries(1, [
        "parse.js",
        "render.js",
        "sessions.js",
        "browser/browser-page.js",
      ]);

      writeHelpers("after");
      const [, renderAfter, , browserAfter] = await importer.importEntries(2, [
        "parse.js",
        "render.js",
        "sessions.js",
        "browser/browser-page.js",
      ]);

      assert.equal(renderBefore.renderHTML(), "render-before:server-before");
      assert.equal(browserBefore.browserPage(), "browser-before:server-before");
      assert.equal(renderAfter.renderHTML(), "render-after:server-after");
      assert.equal(browserAfter.browserPage(), "browser-after:server-after");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns exactly the ten hot-reload exports", async () => {
    const mods = await hotModules();
    assert.deepEqual(Object.keys(mods).sort(), [...HOT_KEYS].sort());
  });

  it("exposes callable parseSession, renderHTML, sessions helpers, and browserPage", async () => {
    const mods = await hotModules();
    for (const key of HOT_KEYS) {
      assert.equal(typeof mods[key], "function", `${key} should be a function`);
    }
  });
});

describe("server-state hotModules browserPage", () => {
  it("renders the index shell with filter bar and embedded init data", async () => {
    const { browserPage } = await hotModules();
    const html = browserPage([], new Map(), "");
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /id="filterBar"/);
    assert.match(html, /id="filterInput"/);
    assert.match(html, /<title>Runs · tracequest<\/title>/);
  });

  it("injects initialFilter into the filter input value", async () => {
    const { browserPage } = await hotModules();
    const html = browserPage([], new Map(), "tool:Bash");
    assert.match(html, /value="tool:Bash"/);
    assert.doesNotMatch(html, /value="tool:Bash tool:Bash"/);
  });

  it("hot browserPage matches static browserPage output for empty index", async () => {
    const { browserPage } = await hotModules();
    const hotHtml = browserPage([], new Map(), "live:true");
    const staticHtml = staticBrowserPage([], new Map(), "live:true");
    assert.equal(hotHtml, staticHtml);
  });
});

describe("server-state hotModules renderHTML", () => {
  it("renders a self-contained session detail page", async () => {
    const { renderHTML } = await hotModules();
    const session = minimalSession();
    const html = renderHTML(session);
    assert.match(html, /^<!DOCTYPE html>/);
    assert.match(html, /aaaaaaaa-bbbb/);
    assert.match(html, /<div id="app"><\/div>/);
  });

  it("hot renderHTML matches static renderHTML for the same session", async () => {
    const { renderHTML } = await hotModules();
    const session = minimalSession();
    assert.equal(renderHTML(session), staticRenderHTML(session));
  });
});

describe("server-state hotModules session barrel", () => {
  it("hot-loaded parseSession parses a claude jsonl fixture", async () => {
    const { parseSession } = await hotModules();
    const { file, dir } = mkClaudeJsonlTmp(
      [{ type: "user", message: { content: [{ type: "text", text: "hot parse" }] } }],
      "hotmods",
    );
    try {
      const session = parseSession(file, "claude");
      assert.equal(session.events.length, 1);
      assert.equal(session.events[0].type, "user");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hot-loaded peekSession and buildIndex index the same fixture", async () => {
    const { peekSession, buildIndex } = await hotModules();
    const { file, dir } = mkClaudeJsonlTmp(
      [{ type: "user", message: { content: [{ type: "text", text: "hot peek" }] } }],
      "hotmods",
    );
    try {
      const stat = fs.statSync(file);
      const meta = peekSession({ path: file, size: stat.size, source: "claude" });
      assert.match(meta.firstPrompt || "", /hot peek/);
      const index = buildIndex([{ path: file, source: "claude", mtime: stat.mtime }]);
      assert.ok(index instanceof Map);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("hot-loaded findSessions returns an array for a non-matching filter", async () => {
    const { findSessions } = await hotModules();
    const sessions = findSessions("hotmods-no-such-project-xyz");
    assert.ok(Array.isArray(sessions));
  });

  it("hot-loaded searchSessions is the scan-queries BM25 entry point", async () => {
    const { searchSessions } = await hotModules();
    assert.equal(typeof searchSessions, "function");
    assert.deepEqual(searchSessions([], new Map(), "needle"), []);
  });
});

describe("server-state hotModules cache", () => {
  it("returns the same cached object while modVersion is unchanged", async () => {
    const a = await hotModules();
    const b = await hotModules();
    assert.strictEqual(a, b);
  });

  it("resetHotModulesCacheForTests forces a new bundle when modVersion is unchanged", async () => {
    const cached = await hotModules();
    resetHotModulesCacheForTests();
    const fresh = await hotModules();
    assert.notStrictEqual(fresh, cached);
    const html = fresh.browserPage([], new Map(), "reset-cache");
    assert.match(html, /value="reset-cache"/);
  });

  it("reloads the bundle after bumpModVersion and still serves working exports", async () => {
    const before = await hotModules();
    bumpModVersion();
    const after = await hotModules();
    assert.notStrictEqual(before, after);
    const html = after.browserPage([], new Map(), "status:error");
    assert.match(html, /value="status:error"/);
    const detail = after.renderHTML(minimalSession());
    assert.match(detail, /const SESSION = /);
  });
});
