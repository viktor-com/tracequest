import "../helpers/skip-lr-watch-env.js";
import { test, describe, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProj, writeClaudeJsonl } from "../helpers/fixtures.js";

import { createHandle } from "../../src/server/server-http.js";
import * as routesBarrel from "../../src/routes.js";
import { ROUTE_MAP } from "../../src/routes.js";
import {
  handleApiSessions,
  handleApiSearch,
} from "../../src/routes/route-handlers-api.js";
import { handleIndex, handleSessions } from "../../src/routes/route-handlers-pages.js";
import {
  clearRouteCache,
  buildRouteCacheKey,
  peekRouteCache,
} from "../../src/routes/route-cache.js";
import { installModVersionTestHygiene } from "../helpers/mod-version-hygiene.js";
import { getSearchIndex, resetSearchIndexForTests } from "../../src/sessions/search-index.js";
import { tokenize } from "../../src/sessions/search-tokenizer.js";


/** @type {import("node:http").Server[]} */
const servers = [];

afterEach(() => {
  clearRouteCache();
  resetSearchIndexForTests();
  while (servers.length) {
    const s = servers.pop();
    s.close();
  }
});

function seedSearchIndex(filePath, text) {
  const si = getSearchIndex();
  const terms = tokenize(text);
  const termFreqs = new Map();
  for (const t of terms) termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
  si.upsert(filePath, termFreqs);
}

function makeSessions(n) {
  const sessions = [];
  for (let i = 0; i < n; i++) {
    sessions.push({
      path: `/fake/http-s${i}.jsonl`,
      mtime: new Date(Date.now() - i * 60_000),
      size: 2048 * (i + 1),
      source: i % 3 === 0 ? "claude" : i % 3 === 1 ? "codex" : "factory",
      project: `project-${i % 4}`,
      file: `s${i}.jsonl`,
    });
  }
  return sessions;
}

function makeIndex(sessions) {
  const index = new Map();
  for (const s of sessions) {
    index.set(s.path, {
      firstPrompt: `prompt for ${s.file}`,
      model: "claude-sonnet-4-6",
      tools: ["Bash"],
      toolCounts: { Bash: 2 },
      chapters: 1,
      totalTokens: 10_000 + sessions.indexOf(s) * 100,
      inputTokens: 6000,
      outputTokens: 4000,
      cacheReadTokens: 500,
      durationMs: 60_000,
      errors: sessions.indexOf(s) % 5 === 0 ? 1 : 0,
      files: 2,
      commits: 0,
    });
  }
  return index;
}

function stubBrowserPage(sessions, _index, filter) {
  return `<!DOCTYPE html><html data-count="${sessions.length}" data-filter="${filter ?? ""}"></html>`;
}

function makeDeps(sessionCount = 5, overrides = {}) {
  const sessions = overrides.sessions ?? makeSessions(sessionCount);
  const index = overrides.index ?? makeIndex(sessions);
  return {
    findSessions: mock.fn(overrides.findSessions ?? (() => sessions)),
    buildIndex: mock.fn(overrides.buildIndex ?? (() => index)),
    browserPage: overrides.browserPage ?? stubBrowserPage,
    peekSession: overrides.peekSession,
    muxAvailable: overrides.muxAvailable ?? (() => false),
    listWindows: overrides.listWindows ?? (() => []),
    detectLiveSessions: overrides.detectLiveSessions ?? (() => []),
    ...overrides.extra,
  };
}

/** Route map with injectable deps for HTTP integration (production handlers omit deps). */
function bindApiCacheRoutes(deps) {
  return {
    "/": (req, res, url) => handleIndex(req, res, url, deps),
    "/sessions": (req, res, url) => handleSessions(req, res, url, deps),
    "/api/sessions": (req, res, url) => handleApiSessions(req, res, url, deps),
    "/api/search": (req, res, url) => handleApiSearch(req, res, url, deps),
  };
}

function listen(handle) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    servers.push(server);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/** Error responses must not echo requested paths or serve HTML. */
function assertBodyDoesNotLeakPaths(body, ...pathFragments) {
  assert.doesNotMatch(body, /<!DOCTYPE html>/i);
  for (const frag of pathFragments) {
    if (frag) assert.equal(body.includes(frag), false, `body must not echo ${frag}`);
  }
}

async function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(join(tmpdir(), "routes-prod-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
  try {
    return await fn(tmpHome);
  } finally {
    process.env.HOME = originalHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      })
      .on("error", reject);
  });
}

describe("routes barrel", () => {
  test("routes.js exposes only ROUTE_MAP for createHandle wiring", () => {
    assert.deepEqual(Object.keys(routesBarrel).sort(), ["ROUTE_MAP"]);
    for (const key of [
      "handleIndex",
      "handleView",
      "clearRouteCache",
      "buildRouteCacheKey",
      "handleApiSessions",
      "handleApiSearch",
      "getSessionsAndIndex",
      "computeStats",
    ]) {
      assert.equal(routesBarrel[key], undefined, `internal ${key} must not be on routes barrel`);
    }
  });
});

describe("routes HTTP integration — dispatch", () => {
  test("ROUTE_MAP registers index, view, export, and API paths", () => {
    assert.equal(typeof ROUTE_MAP["/"], "function");
    assert.equal(typeof ROUTE_MAP["/view"], "function");
    assert.equal(typeof ROUTE_MAP["/export"], "function");
    assert.equal(typeof ROUTE_MAP["/api/sessions"], "function");
    assert.equal(typeof ROUTE_MAP["/api/search"], "function");
  });

  test("handler throw returns 500 Internal error", async () => {
    const routeMap = {
      "/boom": async () => {
        throw new Error("http boom");
      },
    };
    const { port } = await listen(createHandle(routeMap));
    const res = await httpGet(port, "/boom");
    assert.equal(res.status, 500);
    assert.equal(res.body, "Internal error");
  });

  test("dispatches query string to handler url", async () => {
    const deps = makeDeps(1);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const res = await httpGet(port, "/api/sessions?page=1&pageSize=1");
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.pageSize, 1);
    assert.equal(deps.findSessions.mock.calls.length, 1);
  });
});

describe("routes HTTP integration — production ROUTE_MAP /view and /export", () => {
  test("GET /export non-session path returns 403 without echoing requested path", async () => {
    const secret = "/var/log/syslog";
    const { port } = await listen(createHandle(ROUTE_MAP));
    const res = await httpGet(port, `/export?path=${encodeURIComponent(secret)}`);
    assert.equal(res.status, 403);
    assert.equal(res.body, "Forbidden: path is not a session file");
    assert.equal(res.headers["content-disposition"], undefined);
    assertBodyDoesNotLeakPaths(res.body, secret, "/var/log");
  });

  test("GET /view missing session file returns route error shell with failed handle", async () => {
    await withTempHome(async (home) => {
      const sessionPath = writeClaudeJsonl(
        claudeProj(home, "http-route-proj"),
        "gone.jsonl",
        ['{"type":"user"}\n'],
      );
      fs.unlinkSync(sessionPath);
      const { port } = await listen(createHandle(ROUTE_MAP));
      const res = await httpGet(port, `/view?path=${encodeURIComponent(sessionPath)}`);
      assert.equal(res.status, 403);
      assert.match(res.body, /<!DOCTYPE html>/i);
      assert.match(res.body, /data-view-state="error"/);
      assert.match(res.body, /Could not load session/);
      assert.match(res.body, /HTTP 403/);
      assert.match(res.body, /Forbidden: path is not a session file/);
      assert.ok(res.body.includes(sessionPath));
    });
  });

  test("GET /export forbidden etc path returns 403 without echoing path", async () => {
    const secret = "/etc/passwd";
    const { port } = await listen(createHandle(ROUTE_MAP));
    const res = await httpGet(port, `/export?path=${encodeURIComponent(secret)}`);
    assert.equal(res.status, 403);
    assert.equal(res.body, "Forbidden: path is not a session file");
    assertBodyDoesNotLeakPaths(res.body, secret);
  });
});

describe("routes HTTP integration — index route cache", () => {
  test("GET / returns the chat surface HTML", async () => {
    const deps = makeDeps(7);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const res = await httpGet(port, "/");
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/html/);
    assert.match(res.body, /class="tq-shell"/);
    assert.match(res.body, /class="agent-rail"/);
    assert.match(res.body, /class="chat-composer"/);
    assert.doesNotMatch(res.body, /data-count="7"/);
  });

  test("repeated GET /sessions with same filter hits route cache (single findSessions)", async () => {
    const deps = makeDeps(3);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    await httpGet(port, "/sessions?filter=http-cache-a");
    await httpGet(port, "/sessions?filter=http-cache-a");
    await httpGet(port, "/sessions?filter=http-cache-a");
    assert.equal(deps.findSessions.mock.calls.length, 1);
    assert.equal(deps.buildIndex.mock.calls.length, 1);
  });

  test("GET /sessions with different filters bypasses route cache", async () => {
    const deps = makeDeps(2);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    await httpGet(port, "/sessions?filter=alpha");
    await httpGet(port, "/sessions?filter=beta");
    assert.equal(deps.findSessions.mock.calls.length, 2);
    assert.equal(deps.buildIndex.mock.calls.length, 2);
  });

  test("route cache hit returns byte-identical HTML", async () => {
    const deps = makeDeps(4);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const first = await httpGet(port, "/sessions?filter=html-stable");
    const second = await httpGet(port, "/sessions?filter=html-stable");
    assert.strictEqual(second.body, first.body);
    assert.match(first.body, /<!DOCTYPE html>/);
  });

  test("peekRouteCache serves stored entry after first HTTP GET /sessions", async () => {
    clearRouteCache();
    const deps = makeDeps(2);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    await httpGet(port, "/sessions?filter=peek-http");
    const key = buildRouteCacheKey("peek-http");
    const hit = peekRouteCache(key);
    assert.ok(hit, "HTTP index handler should store route cache");
    assert.equal(hit.sessions.length, 2);
  });

  test("HTTP GET / invalidates cache when top session file mtime changes", async () => {
    clearRouteCache();
    const ts = Date.now();
    const tmpFile = join(tmpdir(), `tracequest-http-mtime-${ts}.jsonl`);
    fs.writeFileSync(tmpFile, '{"x":1}\n');
    const mtime = fs.statSync(tmpFile).mtime;

    const sessions = [{
      path: tmpFile,
      mtime,
      size: 100,
      source: "claude",
      project: "test",
      file: "s1.jsonl",
    }];
    const deps = makeDeps(1, { sessions, index: makeIndex(sessions) });
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));

    await httpGet(port, "/sessions?filter=mtime-http");
    assert.equal(deps.findSessions.mock.calls.length, 1);

    const bumped = new Date(mtime.getTime() + 5000);
    fs.utimesSync(tmpFile, bumped, bumped);

    await httpGet(port, "/sessions?filter=mtime-http");
    assert.equal(deps.findSessions.mock.calls.length, 2);

    fs.unlinkSync(tmpFile);
  });

  test("clearRouteCache forces reload on next HTTP GET /", async () => {
    const deps = makeDeps(2);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    await httpGet(port, "/sessions?filter=clear-http");
    clearRouteCache();
    await httpGet(port, "/sessions?filter=clear-http");
    assert.equal(deps.findSessions.mock.calls.length, 2);
  });
});

describe("routes HTTP integration — /api/sessions", () => {
  test("GET /api/sessions does not leak searchText to client", async () => {
    const deps = makeDeps(3);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const data = JSON.parse((await httpGet(port, "/api/sessions")).body);
    for (const s of data.sessions) {
      assert.equal(s.searchText, undefined);
      assert.equal(s.search, undefined);
    }
  });

  test("GET /api/sessions?expr=source:factory filters via HTTP", async () => {
    const deps = makeDeps(15);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const data = JSON.parse((await httpGet(port, "/api/sessions?expr=source:factory")).body);
    assert.ok(data.total > 0 && data.total < 15);
    for (const s of data.sessions) {
      assert.equal(s.source, "factory");
    }
    assert.equal(data.stats.totalSessions, data.total);
  });

  test("GET /api/sessions stats aggregate full filtered set not current page", async () => {
    const deps = makeDeps(8);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const data = JSON.parse((await httpGet(port, "/api/sessions?page=2&pageSize=2")).body);
    assert.equal(data.sessions.length, 2);
    assert.equal(data.stats.totalSessions, 8);
    assert.equal(data.stats.totalTokens, 8 * 10_000 + (0 + 1 + 2 + 3 + 4 + 5 + 6 + 7) * 100);
  });

  test("GET /api/sessions?sort=tokens orders by totalTokens descending", async () => {
    const sessions = makeSessions(4);
    const index = makeIndex(sessions);
    const tokens = [50, 900, 200, 400];
    for (let i = 0; i < sessions.length; i++) {
      index.get(sessions[i].path).totalTokens = tokens[i];
    }
    const deps = makeDeps(4, { sessions, index });
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const data = JSON.parse((await httpGet(port, "/api/sessions?sort=tokens&pageSize=10")).body);
    assert.deepEqual(
      data.sessions.map((s) => s.totalTokens),
      [900, 400, 200, 50],
    );
  });

  test("GET /api/sessions clamps page beyond last page", async () => {
    const deps = makeDeps(3);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const data = JSON.parse((await httpGet(port, "/api/sessions?page=99&pageSize=10")).body);
    assert.equal(data.page, 1);
    assert.equal(data.sessions.length, 3);
  });

  test("GET /api/sessions with empty list returns zero envelope", async () => {
    const deps = makeDeps(0, {
      findSessions: () => [],
      buildIndex: () => new Map(),
    });
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const data = JSON.parse((await httpGet(port, "/api/sessions")).body);
    assert.deepEqual(data.sessions, []);
    assert.equal(data.total, 0);
    assert.equal(data.stats.totalSessions, 0);
  });

  test("repeated GET /api/sessions with same filter hits route cache (single findSessions)", async () => {
    const deps = makeDeps(2);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    await httpGet(port, "/api/sessions");
    await httpGet(port, "/api/sessions");
    assert.equal(deps.findSessions.mock.calls.length, 1);
    assert.equal(deps.buildIndex.mock.calls.length, 1);
  });
});

describe("routes HTTP integration — /api/search", () => {
  test("GET /api/search?q=deploy returns JSON hits", async () => {
    const deps = makeDeps(6);
    // Seed the SearchIndex so the BM25 search has something to find.
    seedSearchIndex(deps.findSessions()[0].path, "deploy staging production");
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const res = await httpGet(port, "/api/search?q=deploy");
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data.results));
    assert.ok(data.results.length >= 1);
    assert.equal(typeof data.results[0].path, "string");
  });

  test("GET /api/search passes filter param to findSessions", async () => {
    const deps = makeDeps(2);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    await httpGet(port, "/api/search?q=test&filter=my-proj-filter");
    assert.equal(deps.findSessions.mock.calls.length, 1);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], "my-proj-filter");
  });

  test("GET /api/search result includes path, prompt, and matches", async () => {
    const sessions = [{
      path: "/fake/needle.jsonl",
      mtime: new Date(),
      size: 512,
      source: "claude",
      project: "p",
      file: "needle.jsonl",
    }];
    seedSearchIndex("/fake/needle.jsonl", "alpha beta gamma unique-needle-token omega");
    const index = new Map([["/fake/needle.jsonl", {
      firstPrompt: "start here",
      model: "claude-sonnet-4-6",
    }]]);
    const deps = makeDeps(1, { sessions, index });
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const hit = JSON.parse((await httpGet(port, "/api/search?q=unique-needle-token")).body).results[0];
    assert.equal(hit.path, "/fake/needle.jsonl");
    assert.equal(hit.prompt, "start here");
    assert.ok(Array.isArray(hit.matches));
    assert.ok(hit.matches.length >= 1);
  });
});

describe("routes HTTP integration — cross-route cache", () => {
  installModVersionTestHygiene();

  function crossRouteSessionRow(path, project) {
    return {
      path,
      mtime: new Date("2026-05-01T12:00:00Z"),
      size: 512,
      source: "claude",
      project,
      file: path.split("/").pop(),
    };
  }

  function makeCrossRouteSearchDeps(rows) {
    return makeDeps(rows.length, {
      sessions: rows,
      findSessions: (filter) => {
        if (!filter) return rows;
        return rows.filter((s) => (s.project || "").includes(filter));
      },
      buildIndex: (sessions) => {
        const index = new Map();
        for (const s of sessions) {
          seedSearchIndex(s.path, `http-cross-needle ${s.project}`);
          index.set(s.path, {
            firstPrompt: `prompt ${s.file}`,
            model: "claude-sonnet-4-6",
          });
        }
        return index;
      },
    });
  }

  test("GET / warms route cache; repeat filtered /api/search skips findSessions", async () => {
    const rows = [
      crossRouteSessionRow("/fake/http-cross-alpha.jsonl", "alpha-proj"),
      crossRouteSessionRow("/fake/http-cross-beta.jsonl", "beta-proj"),
    ];
    const deps = makeCrossRouteSearchDeps(rows);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const searchPath = "/api/search?q=http-cross-needle&filter=alpha-proj";

    const indexRes = await httpGet(port, "/sessions");
    assert.equal(indexRes.status, 200);
    assert.match(indexRes.body, /data-count="2"/);
    assert.equal(deps.findSessions.mock.calls.length, 1);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], null);
    assert.equal(deps.buildIndex.mock.calls.length, 1);

    const firstSearch = await httpGet(port, searchPath);
    assert.equal(firstSearch.status, 200);
    const data1 = JSON.parse(firstSearch.body);
    assert.equal(deps.findSessions.mock.calls.length, 2);
    assert.deepEqual(
      deps.findSessions.mock.calls.map((c) => c.arguments[0]),
      [null, "alpha-proj"],
    );
    assert.equal(deps.buildIndex.mock.calls.length, 2);
    assert.equal(data1.results.length, 1);
    assert.equal(data1.results[0].path, "/fake/http-cross-alpha.jsonl");
    assert.equal(data1.results[0].prompt, "prompt http-cross-alpha.jsonl");

    const secondSearch = await httpGet(port, searchPath);
    assert.equal(secondSearch.status, 200);
    const data2 = JSON.parse(secondSearch.body);
    assert.deepEqual(data2, data1);
    assert.equal(
      deps.findSessions.mock.calls.length,
      2,
      "second search should not call findSessions",
    );
    assert.equal(
      deps.buildIndex.mock.calls.length,
      2,
      "second search should not rebuild index",
    );
    assert.equal(
      deps.findSessions.mock.calls.some((c) => c.arguments[0] === null),
      true,
      "only GET / should load unfiltered sessions",
    );
  });

  test("GET /api/sessions?filter=alpha warms route cache; repeat filtered /api/search skips findSessions", async () => {
    const rows = [
      crossRouteSessionRow("/fake/http-cross-alpha.jsonl", "alpha-proj"),
      crossRouteSessionRow("/fake/http-cross-beta.jsonl", "beta-proj"),
    ];
    const deps = makeCrossRouteSearchDeps(rows);
    const { port } = await listen(createHandle(bindApiCacheRoutes(deps)));
    const filter = "alpha";
    const searchPath = `/api/search?q=http-cross-needle&filter=${filter}`;

    const sessionsRes = await httpGet(port, `/api/sessions?filter=${filter}`);
    assert.equal(sessionsRes.status, 200);
    const sessionsData = JSON.parse(sessionsRes.body);
    assert.equal(sessionsData.sessions.length, 1);
    assert.equal(sessionsData.sessions[0].path, "/fake/http-cross-alpha.jsonl");
    assert.equal(deps.findSessions.mock.calls.length, 1);
    assert.equal(deps.findSessions.mock.calls[0].arguments[0], filter);
    assert.equal(deps.buildIndex.mock.calls.length, 1);

    const firstSearch = await httpGet(port, searchPath);
    assert.equal(firstSearch.status, 200);
    const data1 = JSON.parse(firstSearch.body);
    assert.equal(
      deps.findSessions.mock.calls.length,
      1,
      "search after sessions warm should reuse route cache",
    );
    assert.equal(deps.buildIndex.mock.calls.length, 1);
    assert.equal(data1.results.length, 1);
    assert.equal(data1.results[0].path, "/fake/http-cross-alpha.jsonl");
    assert.equal(data1.results[0].prompt, "prompt http-cross-alpha.jsonl");

    const secondSearch = await httpGet(port, searchPath);
    assert.equal(secondSearch.status, 200);
    const data2 = JSON.parse(secondSearch.body);
    assert.deepEqual(data2, data1);
    assert.equal(
      deps.findSessions.mock.calls.length,
      1,
      "second search should not call findSessions",
    );
    assert.equal(
      deps.buildIndex.mock.calls.length,
      1,
      "second search should not rebuild index",
    );
    assert.deepEqual(
      deps.findSessions.mock.calls.map((c) => c.arguments[0]),
      [filter],
      "only filtered /api/sessions should load sessions",
    );
  });
});
