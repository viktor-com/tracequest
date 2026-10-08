import "../helpers/skip-lr-watch-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createHandle } from "../../src/server/server-http.js";
import { handleApiSearch } from "../../src/routes/route-handlers-api.js";
import { installModVersionTestHygiene } from "../helpers/mod-version-hygiene.js";
import {
  SHARED_QUERY,
  FACTORY_DISK_ONLY,
  GROK_DISK_ONLY,
} from "../helpers/multi-source-fixtures.js";
import { withMultiSourceHarness } from "../helpers/multi-source-harness.js";

/** @type {import("node:http").Server[]} */
const servers = [];

afterEach(() => {
  while (servers.length) servers.pop()?.close();
});

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

function httpGet(port, reqPath) {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${reqPath}`, (res) => {
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

/** HTTP layer over withMultiSourceHarness; counters observe blank-query short-circuit and route cache. */
async function withApiSearchServer(fn, { seedOpenCode = true } = {}) {
  const counters = { findSessions: 0, buildIndex: 0 };

  await withMultiSourceHarness(async ({ paths, findSessions, buildIndex }) => {
    const deps = {
      findSessions: (filter) => {
        counters.findSessions++;
        return findSessions(filter);
      },
      buildIndex: (sessions, opts) => {
        counters.buildIndex++;
        return buildIndex(sessions, opts);
      },
    };

    const routeMap = {
      "/api/search": (req, res, url) => handleApiSearch(req, res, url, deps),
    };
    const { port } = await listen(createHandle(routeMap));
    const get = (reqPath) => httpGet(port, reqPath);

    await fn({ port, paths, counters, get });
  }, { seedOpenCode });
}

describe("/api/search HTTP integration with real session fixtures", () => {
  installModVersionTestHygiene();

  test("GET /api/search?q= returns empty results without loading sessions", async () => {
    await withApiSearchServer(async ({ get, counters }) => {
      const res = await get("/api/search?q=");
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body), { results: [] });
      assert.equal(counters.findSessions, 0);
      assert.equal(counters.buildIndex, 0);
    });
  });

  test("GET /api/search whitespace-only q skips session discovery", async () => {
    await withApiSearchServer(async ({ get, counters }) => {
      const res = await get("/api/search?q=%20%20");
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.body).results, []);
      assert.equal(counters.findSessions, 0);
      assert.equal(counters.buildIndex, 0);
    });
  });

  test("unfiltered search hits all seven sources (eight sessions) for shared needle", async () => {
    await withApiSearchServer(async ({ get }) => {
      const res = await get(`/api/search?q=${SHARED_QUERY}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-type"], /application\/json/);
      const data = JSON.parse(res.body);
      assert.equal(data.results.length, 8);
      const sources = new Set(data.results.map((r) => r.source));
      assert.deepEqual(sources, new Set(["claude", "cursor", "cursor-cloud", "codex", "factory", "grok", "opencode"]));
      assert.ok(data.results.every((r) => Array.isArray(r.matches) && r.matches.length >= 1));
    });
  });

  test("?filter=msrc-alpha scopes to the claude alpha session", async () => {
    await withApiSearchServer(async ({ get, paths }) => {
      const res = await get(`/api/search?q=${SHARED_QUERY}&filter=msrc-alpha`);
      const data = JSON.parse(res.body);
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0].source, "claude");
      assert.equal(data.results[0].path, paths.alphaPath);
      assert.match(data.results[0].project, /msrc-alpha/);
    });
  });

  test("?filter=msrc-factory returns both factory jsonl sessions", async () => {
    await withApiSearchServer(async ({ get, paths }) => {
      const res = await get(`/api/search?q=${SHARED_QUERY}&filter=msrc-factory`);
      const data = JSON.parse(res.body);
      assert.equal(data.results.length, 2);
      assert.ok(data.results.every((r) => r.source === "factory"));
      const hitPaths = new Set(data.results.map((r) => r.path));
      assert.ok(hitPaths.has(paths.factoryPath));
      assert.ok(hitPaths.has(paths.factoryErrPath));
    });
  });

  test("result items expose path, prompt, id, model, and snippet matches", async () => {
    await withApiSearchServer(async ({ get, paths }) => {
      const res = await get(`/api/search?q=${SHARED_QUERY}&filter=msrc-alpha`);
      const hit = JSON.parse(res.body).results[0];
      assert.equal(hit.path, paths.alphaPath);
      assert.equal(typeof hit.id, "string");
      assert.ok(hit.prompt.includes("deploy-marker"));
      assert.equal(hit.model, "claude-sonnet-4-20250514");
      assert.ok(hit.matches.some((m) => m.snippet.toLowerCase().includes(SHARED_QUERY)));
    });
  });

  test("search is case-insensitive over real SearchIndex content", async () => {
    await withApiSearchServer(async ({ get }) => {
      const upper = SHARED_QUERY.toUpperCase();
      const res = await get(`/api/search?q=${upper}`);
      const data = JSON.parse(res.body);
      assert.equal(data.results.length, 8);
    });
  });

  test("matches firstPrompt when query is absent from indexed body text", async () => {
    await withApiSearchServer(async ({ get, paths }) => {
      const res = await get("/api/search?q=deploy-marker&filter=msrc-alpha");
      const data = JSON.parse(res.body);
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0].path, paths.alphaPath);
      assert.ok(data.results[0].prompt.includes("deploy-marker"));
    });
  });

  test("factory bash command needle (tool_use input.command) not found by BM25 — not indexed", async () => {
    // FACTORY_DISK_ONLY is in tool_use.input.command which the factory indexer does not
    // push into termFreqs. BM25 cannot find unindexed content; result is 0 hits.
    await withApiSearchServer(async ({ get }) => {
      const res = await get(`/api/search?q=${FACTORY_DISK_ONLY}&filter=msrc-factory`);
      const data = JSON.parse(res.body);
      assert.equal(data.results.length, 0, "unindexed tool_use command not found by BM25");
    });
  });

  test("grok chat_history-only phrase is findable through the API route", async () => {
    await withApiSearchServer(async ({ get, paths }) => {
      const res = await get(`/api/search?q=${GROK_DISK_ONLY}`);
      const data = JSON.parse(res.body);
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0].source, "grok");
      assert.equal(data.results[0].path, paths.grokSessDir);
    });
  });

  test("unmatched query returns empty results array", async () => {
    await withApiSearchServer(async ({ get }) => {
      const res = await get("/api/search?q=zzzz-no-match-token-xyzzy");
      const data = JSON.parse(res.body);
      assert.deepEqual(data.results, []);
    });
  });

  test("repeat identical search reuses route cache (single findSessions/buildIndex)", async () => {
    await withApiSearchServer(async ({ get, counters }) => {
      const searchPath = `/api/search?q=${SHARED_QUERY}&filter=msrc-codex`;
      const first = await get(searchPath);
      const second = await get(searchPath);
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.strictEqual(second.body, first.body);
      assert.equal(counters.findSessions, 1);
      assert.equal(counters.buildIndex, 1);
      const data = JSON.parse(first.body);
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0].source, "codex");
    });
  });

  test("different filter params bypass route cache and reload sessions", async () => {
    await withApiSearchServer(async ({ get, counters }) => {
      await get(`/api/search?q=${SHARED_QUERY}&filter=msrc-alpha`);
      await get(`/api/search?q=${SHARED_QUERY}&filter=msrc-codex`);
      assert.equal(counters.findSessions, 2);
      assert.equal(counters.buildIndex, 2);
    });
  });
});
