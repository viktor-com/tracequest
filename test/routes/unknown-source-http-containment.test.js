/**
 * Containment audit for the crash path introduced by failing closed on an
 * unrecognised session source (facts 80i, z9k).
 *
 * `buildIndex` now throws where it previously never did, and
 * `resolveSessionsAndIndex` (src/routes/route-cache.js:131) propagates that
 * synchronously into every HTTP handler that resolves an index. These tests pin
 * that the failure is contained: the real dispatcher `createHandle`
 * (src/server/server-http.js:22-35) awaits each handler and converts the
 * rejection into a 500, so no request yields an unhandled rejection (which under
 * Node's default `--unhandled-rejections=throw` would kill a `tracequest serve`
 * process), and none yields a silent empty 200.
 *
 * Handlers that resolve an index, and are therefore covered here:
 *   /api/sessions  route-handlers-api.js:55
 *   /api/search    route-handlers-api.js:129
 *   /              route-handlers-pages.js:171
 * `/__livereload` is deliberately excluded: it never touches the index
 * (route-handlers.js:12-21).
 */
import "../helpers/skip-lr-watch-env.js";
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHandle } from "../../src/server/server-http.js";
import { handleApiSessions, handleApiSearch } from "../../src/routes/route-handlers-api.js";
import { handleIndex } from "../../src/routes/route-handlers-pages.js";
import { clearRouteCache } from "../../src/routes/route-cache.js";
import { setInitialFilter } from "../../src/server/server-state.js";
import { clearLiveSessionsCache } from "../../src/sessions/live-sessions.js";
import {
  indexDiskMtimeMs,
  indexDiskMtimeStatCallsForTests,
  resetIndexDiskMtimeStatCallsForTests,
} from "../../src/sessions/index-writers.js";
import { UnknownSessionSourceError } from "../../src/sessions/session-index-core.js";
import { mockHttpResponse } from "../helpers/capture-json-handler.js";

afterEach(() => {
  clearRouteCache();
  clearLiveSessionsCache();
  setInitialFilter(null);
});

// Clearly-fake canary: "cursor-cloud" was the canary until it became a real source (fact cccn).
const UNKNOWN_SOURCE = "no-such-source";
const UNKNOWN_PATH = "/fake/no-such-source/bc-abc123";

function throwingDeps() {
  return {
    findSessions: () => [
      {
        path: UNKNOWN_PATH,
        project: "p",
        file: "bc-abc123",
        size: 100,
        mtime: new Date(1_750_000_000_000),
        source: UNKNOWN_SOURCE,
      },
    ],
    buildIndex: () => {
      throw new UnknownSessionSourceError(UNKNOWN_SOURCE, UNKNOWN_PATH);
    },
    peekSession: () => ({}),
    searchSessions: () => [],
    muxAvailable: () => false,
    listWindows: () => [],
  };
}

/**
 * Drive a handler through the REAL dispatcher, exactly as node:http would.
 * Returns the response plus anything the dispatcher rejected with.
 */
async function dispatch(handler, path) {
  const routeMap = {
    [path]: (req, res, url) => handler(req, res, url, throwingDeps()),
  };
  const handle = createHandle(routeMap);
  const res = mockHttpResponse();
  const req = { url: path, method: "GET", headers: {} };

  // Any rejection escaping here is precisely the unhandled rejection that would
  // terminate the serve process, so failing to settle is itself the regression.
  let rejected = null;
  await handle(req, res).catch((err) => {
    rejected = err;
  });
  return { res, rejected };
}

const INDEXING_ROUTES = [
  { name: "/api/sessions", path: "/api/sessions", handler: handleApiSessions },
  { name: "/api/search", path: "/api/search", handler: handleApiSearch },
  { name: "/", path: "/", handler: handleIndex },
];

describe("unknown-source buildIndex failure is contained at the HTTP boundary", () => {
  for (const route of INDEXING_ROUTES) {
    test(`${route.name} returns a clean 500 instead of an unhandled rejection`, async () => {
      const url = new URL(
        route.path === "/api/search" ? `${route.path}?q=deploy` : route.path,
        "http://localhost",
      );
      const routeMap = {
        [route.path]: (req, res) => route.handler(req, res, url, throwingDeps()),
      };
      const handle = createHandle(routeMap);
      const res = mockHttpResponse();

      let rejected = null;
      await handle({ url: url.pathname + url.search, method: "GET", headers: {} }, res).catch(
        (err) => {
          rejected = err;
        },
      );

      assert.equal(
        rejected,
        null,
        `dispatching ${route.name} rejected instead of responding: ${rejected?.stack}`,
      );
      assert.equal(
        res.status,
        500,
        `${route.name} must answer 500 on an unknown-source index failure, got ${res.status}`,
      );
      assert.equal(res.body, "Internal error");
    });
  }

  test("a refused index never answers a silent empty 200", async () => {
    for (const route of INDEXING_ROUTES) {
      const url = new URL(
        route.path === "/api/search" ? `${route.path}?q=deploy` : route.path,
        "http://localhost",
      );
      const routeMap = {
        [route.path]: (req, res) => route.handler(req, res, url, throwingDeps()),
      };
      const res = mockHttpResponse();
      await createHandle(routeMap)(
        { url: url.pathname + url.search, method: "GET", headers: {} },
        res,
      ).catch(() => {});
      assert.notEqual(
        res.status,
        200,
        `${route.name} answered 200 for a batch the indexer refused — a silent empty result`,
      );
      clearRouteCache();
    }
  });

  test("the index-mtime coalesce guard is released when the index build throws", async () => {
    // resolveSessionsAndIndex and the api handlers wrap the build in try/finally
    // (route-cache.js:140-142, route-handlers-api.js:56-58). If a throw leaked the
    // coalesce depth, later reads would keep serving the memoized mtime and stop
    // calling stat, silently freezing index freshness for the whole process.
    const url = new URL("/api/sessions", "http://localhost");
    const routeMap = {
      "/api/sessions": (req, res) => handleApiSessions(req, res, url, throwingDeps()),
    };
    const res = mockHttpResponse();
    await createHandle(routeMap)({ url: "/api/sessions", method: "GET", headers: {} }, res).catch(
      () => {},
    );
    assert.equal(res.status, 500);

    resetIndexDiskMtimeStatCallsForTests();
    indexDiskMtimeMs();
    indexDiskMtimeMs();
    assert.equal(
      indexDiskMtimeStatCallsForTests(),
      2,
      "coalesce guard leaked after the throw: mtime reads are still being memoized",
    );
  });
});
