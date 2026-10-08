import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSession } from "../../src/parse.js";
import { renderHTML } from "../../src/render.js";
import {
  handleCompare,
  handleExport,
  handleMarkdown,
  handleRaw,
  handleView,
} from "../../src/routes/route-handlers-pages.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

function captureResponse() {
  let status;
  let headers;
  let body;
  return {
    res: {
      writeHead(s, h) { status = s; headers = h; },
      end(b) { body = b; },
      get status() { return status; },
      get headers() { return headers; },
      get body() { return body; },
    },
  };
}

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-session-hash-routes-"));
  const oldHome = process.env.HOME;
  const oldNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = home;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    await fn(home);
  } finally {
    process.env.HOME = oldHome;
    if (oldNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = oldNoSidecar;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function seedClaude(home, name, prompt) {
  const dir = path.join(home, ".claude", "projects", "hash-routes");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "user",
        sessionId: `native-${name}`,
        timestamp: "2026-06-03T12:00:00.000Z",
        uuid: `u-${name}`,
        isMeta: false,
        message: { content: prompt },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-03T12:00:01.000Z",
        uuid: `a-${name}`,
        message: { model: "claude-test", content: [{ type: "text", text: "ok" }] },
      }),
    ].join("\n") + "\n"
  );
  return file;
}

function depsFor(files) {
  const sessions = files.map((file) => ({
    path: file,
    project: "hash-routes",
    file: path.basename(file),
    source: "claude",
    size: fs.statSync(file).size,
    mtime: fs.statSync(file).mtime,
  }));
  return {
    findSessions: () => sessions,
    parseSession,
    renderHTML,
  };
}

describe("session hash routes", () => {
  test("view/export/markdown/raw accept id=<sessionHash>", async () => {
    await withTempHome(async (home) => {
      const file = seedClaude(home, "one.jsonl", "route hash prompt");
      const hash = sessionHash(file);
      const deps = depsFor([file]);

      for (const [handler, route, expected] of [
        [handleView, `/view?id=${hash}`, /route hash prompt/],
        [handleExport, `/export?id=${hash}`, /route hash prompt/],
        [handleMarkdown, `/markdown?id=${hash}`, /^# Session/m],
        [handleRaw, `/raw?id=${hash}`, /route hash prompt/],
      ]) {
        const { res } = captureResponse();
        await handler({}, res, new URL(`http://localhost:7777${route}`), deps);
        assert.equal(res.status, 200, route);
        assert.match(String(res.body), expected, route);
      }
    });
  });

  test("compare accepts hash handles and full paths remain compatible", async () => {
    await withTempHome(async (home) => {
      const a = seedClaude(home, "a.jsonl", "compare A");
      const b = seedClaude(home, "b.jsonl", "compare B");
      const deps = depsFor([a, b]);

      const byHash = captureResponse();
      await handleCompare(
        {},
        byHash.res,
        new URL(`http://localhost:7777/compare?a=${sessionHash(a)}&b=${sessionHash(b)}`),
        deps
      );
      assert.equal(byHash.res.status, 200);
      assert.match(byHash.res.body, /session comparison/);

      const byPath = captureResponse();
      await handleView({}, byPath.res, new URL(`http://localhost:7777/view?path=${encodeURIComponent(a)}`), deps);
      assert.equal(byPath.res.status, 200);
      assert.match(byPath.res.body, /compare A/);
    });
  });

  test("missing and ambiguous hashes return clear route errors", async () => {
    await withTempHome(async (home) => {
      const file = seedClaude(home, "dup.jsonl", "dup");
      const hash = sessionHash(file);
      const sessions = [
        { path: file, project: "p", file: "dup.jsonl", source: "claude", size: 1, mtime: new Date() },
        { path: file, project: "p", file: "dup-again.jsonl", source: "claude", size: 1, mtime: new Date() },
      ];
      const deps = { findSessions: () => sessions, parseSession, renderHTML };

      const missing = captureResponse();
      await handleView({}, missing.res, new URL("http://localhost:7777/view?id=00000000"), deps);
      assert.equal(missing.res.status, 404);
      assert.match(missing.res.body, /not found/);

      const ambiguous = captureResponse();
      await handleView({}, ambiguous.res, new URL(`http://localhost:7777/view?id=${hash}`), deps);
      assert.equal(ambiguous.res.status, 409);
      assert.match(ambiguous.res.body, /Ambiguous/);
    });
  });
});
