import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { shareGist, gistApiUrl, buildGistHostPreviewUrl } from "../../src/share/gist-adapter.js";
import { shareHf, buildHfSidecar, hfApiUrl, sanitizePathSegment, HF_PREUPLOAD_THRESHOLD } from "../../src/share/hf-adapter.js";

const META = {
  sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
  source: "claude",
  model: "claude-3-5-sonnet",
  firstPrompt: "hello world",
  durationFormatted: "1m 0s",
};

describe("share adapters", () => {
  test("buildGistHostPreviewUrl includes filename for non-index files", () => {
    assert.equal(
      buildGistHostPreviewUrl("abc123", "tracequest-claude-abcdef12.html"),
      "https://gisthost.github.io/?abc123/tracequest-claude-abcdef12.html",
    );
    assert.equal(buildGistHostPreviewUrl("abc123", "index.html"), "https://gisthost.github.io/?abc123");
    assert.equal(buildGistHostPreviewUrl("abc123"), "https://gisthost.github.io/?abc123");
    assert.equal(buildGistHostPreviewUrl(null), null);
    assert.equal(buildGistHostPreviewUrl(""), null);
    assert.equal(buildGistHostPreviewUrl(undefined), null);
  });

  test("gistApiUrl respects GITHUB_API_URL override", () => {
    const prev = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "http://127.0.0.1:19999";
    assert.equal(gistApiUrl(), "http://127.0.0.1:19999");
    if (prev === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = prev;
  });

  test("shareGist POSTs to gists endpoint", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, method: opts.method, body: JSON.parse(opts.body) });
      return {
        ok: true,
        json: async () => ({ html_url: "https://gist.github.com/test/1", id: "1" }),
      };
    };
    const prev = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "http://127.0.0.1:19999";
    const result = await shareGist({ html: "<html></html>", metadata: META, isPrivate: false, token: "fake", fetchImpl });
    assert.equal(result.url, "https://gist.github.com/test/1");
    assert.equal(
      result.previewUrl,
      "https://gisthost.github.io/?1/tracequest-claude-abcdef12.html",
    );
    assert.equal(result.filename, "tracequest-claude-abcdef12.html");
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/gists"));
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body.public, true);
    if (prev === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = prev;
  });

  test("shareGist sanitizes filename segments", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ html_url: "https://gist.github.com/test/9", id: "9" }),
    });
    const prev = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "http://127.0.0.1:19999";
    const result = await shareGist({
      html: "<html></html>",
      metadata: { ...META, source: "../../evil", sessionId: "bad/id!!" },
      isPrivate: false,
      token: "fake",
      fetchImpl,
    });
    assert.equal(result.filename, "tracequest-------evil-bad-id--.html");
    assert.equal(
      result.previewUrl,
      "https://gisthost.github.io/?9/tracequest-------evil-bad-id--.html",
    );
    if (prev === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = prev;
  });

  test("shareGist rejects failed upload", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Bad credentials",
    });
    const prev = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "http://127.0.0.1:19999";
    await assert.rejects(
      () => shareGist({ html: "<html></html>", metadata: META, isPrivate: false, token: "bad", fetchImpl }),
      /GitHub Gist upload failed \(401\)/,
    );
    if (prev === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = prev;
  });

  test("shareGist rejects response missing id", async () => {
    const fetchImpl = async () => ({
      ok: true,
      json: async () => ({ html_url: "https://gist.github.com/test/no-id" }),
    });
    const prev = process.env.GITHUB_API_URL;
    process.env.GITHUB_API_URL = "http://127.0.0.1:19999";
    await assert.rejects(
      () => shareGist({ html: "<html></html>", metadata: META, isPrivate: false, token: "fake", fetchImpl }),
      /response missing id/,
    );
    if (prev === undefined) delete process.env.GITHUB_API_URL;
    else process.env.GITHUB_API_URL = prev;
  });

  test("hfApiUrl respects HF_API_URL override", () => {
    const prev = process.env.HF_API_URL;
    process.env.HF_API_URL = "http://127.0.0.1:19999";
    assert.equal(hfApiUrl(), "http://127.0.0.1:19999");
    if (prev === undefined) delete process.env.HF_API_URL;
    else process.env.HF_API_URL = prev;
  });

  test("shareHf creates repo and commits html+json on first share", async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, method: opts?.method || "GET", body: opts?.body ? JSON.parse(opts.body) : null });
      if (url.includes("/api/whoami-v2")) {
        return { ok: true, json: async () => ({ name: "testuser" }) };
      }
      if (url.includes("/api/datasets/testuser/tracequest-sessions") && (!opts || opts.method === undefined)) {
        return { ok: false, status: 404 };
      }
      if (url.endsWith("/api/repos/create")) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes("/commit/main")) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    };

    const prev = process.env.HF_API_URL;
    process.env.HF_API_URL = "http://127.0.0.1:19999";
    const sidecar = buildHfSidecar({
      sessionId: META.sessionId,
      source: "claude",
      model: META.model,
      project: "test",
      firstPrompt: META.firstPrompt,
      eventCount: 1,
      errorCount: 0,
      tools: [],
      filePaths: [],
      gitBranch: null,
      costEstimate: 0,
      chapterCount: 1,
    });

    const result = await shareHf({
      html: "<html>ok</html>",
      metadata: META,
      sidecar,
      repo: "testuser/tracequest-sessions",
      isPrivate: false,
      token: "fake",
      fetchImpl,
    });

    assert.ok(result.url.includes("testuser/tracequest-sessions"));
    const createCall = calls.find((c) => c.url.endsWith("/api/repos/create"));
    assert.ok(createCall);
    assert.equal(createCall.body.type, "dataset");
    assert.equal(createCall.body.organization, undefined, "personal repos omit organization");

    const commitCall = calls.find((c) => c.url.includes("/commit/main"));
    assert.ok(commitCall);
    const paths = commitCall.body.operations.map((op) => op.path);
    assert.ok(paths.some((p) => p.endsWith(".html")));
    assert.ok(paths.some((p) => p.endsWith(".json")));
    assert.ok(paths.includes("README.md"));

    if (prev === undefined) delete process.env.HF_API_URL;
    else process.env.HF_API_URL = prev;
  });

  test("sanitizePathSegment strips unsafe characters", () => {
    assert.equal(sanitizePathSegment("claude"), "claude");
    assert.equal(sanitizePathSegment("../../evil"), "------evil");
    assert.equal(sanitizePathSegment(""), "unknown");
  });

  test("shareHf uses preupload for large HTML", async () => {
    const calls = [];
    const largeHtml = "<html>" + "x".repeat(HF_PREUPLOAD_THRESHOLD) + "</html>";
    const fetchImpl = async (url, opts) => {
      calls.push({ url, method: opts?.method || "GET" });
      if (url.includes("/api/whoami-v2")) {
        return { ok: true, json: async () => ({ name: "testuser" }) };
      }
      if (url.includes("/api/datasets/testuser/tracequest-sessions") && (!opts || opts.method === undefined)) {
        return { ok: true, json: async () => ({}) };
      }
      if (url.includes("/preupload/main")) {
        return { ok: true, json: async () => ({ files: [{ path: "sessions/claude/sess.html", uploadUrl: "http://127.0.0.1:19999/upload", oid: "abc123" }] }) };
      }
      if (url.includes("/upload")) {
        return { ok: true };
      }
      if (url.includes("/commit/main")) {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({}) };
    };

    const prev = process.env.HF_API_URL;
    process.env.HF_API_URL = "http://127.0.0.1:19999";
    await shareHf({
      html: largeHtml,
      metadata: { ...META, sessionId: "sess", source: "claude" },
      sidecar: buildHfSidecar({ sessionId: "sess", source: "claude", model: "m", project: "p", firstPrompt: "fp", eventCount: 1, errorCount: 0, tools: [], filePaths: [], gitBranch: null, costEstimate: 0, chapterCount: 1 }),
      repo: "testuser/tracequest-sessions",
      isPrivate: false,
      token: "fake",
      fetchImpl,
    });

    assert.ok(calls.some((c) => c.url.includes("/preupload/main")));
    const commitCall = calls.find((c) => c.url.includes("/commit/main"));
    assert.ok(commitCall);

    if (prev === undefined) delete process.env.HF_API_URL;
    else process.env.HF_API_URL = prev;
  });

  test("buildHfSidecar includes required fields", () => {
    const sidecar = buildHfSidecar({
      sessionId: "abc",
      source: "claude",
      model: "m",
      project: "p",
      firstPrompt: "fp",
      eventCount: 3,
      errorCount: 1,
      tools: ["Read"],
      filePaths: ["/a.js"],
      gitBranch: "main",
      costEstimate: 0.5,
      chapterCount: 2,
    });
    assert.equal(sidecar.sessionId, "abc");
    assert.equal(sidecar.eventCount, 3);
    assert.equal(sidecar.errorCount, 1);
    assert.deepEqual(sidecar.tools, ["Read"]);
    assert.deepEqual(sidecar.filePaths, ["/a.js"]);
    assert.equal(sidecar.gitBranch, "main");
    assert.equal(sidecar.costEstimate, 0.5);
  });
});