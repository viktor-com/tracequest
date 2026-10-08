import "../helpers/skip-lr-watch-env.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildRouteCacheKey,
  peekRouteCache,
  storeRouteCache,
} from "../../src/routes/route-cache.js";
import { hotModules } from "../../src/server/server-state.js";
import { bumpModVersion, modVersion } from "../../src/server/server-live-reload.js";
import { installModVersionTestHygiene } from "../helpers/mod-version-hygiene.js";

installModVersionTestHygiene();

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTE_CACHE_SRC = readFileSync(
  join(__dirname, "../../src/routes/route-cache.js"),
  "utf8",
);
const SERVER_STATE_SRC = readFileSync(
  join(__dirname, "../../src/server/server-state.js"),
  "utf8",
);

/** Second colon-separated segment is the hot-reload generation. */
function modVersionSegment(cacheKey) {
  return cacheKey.split(":")[1];
}

describe("modVersion counter", () => {
  it("modVersion returns a non-negative integer", () => {
    const v = modVersion();
    assert.equal(Number.isInteger(v), true);
    assert.ok(v >= 0);
  });

  it("bumpModVersion increments monotonically", () => {
    const before = modVersion();
    bumpModVersion();
    try {
      assert.equal(modVersion(), before + 1);
      bumpModVersion();
      assert.equal(modVersion(), before + 2);
    } finally {
      bumpModVersion();
      bumpModVersion();
    }
  });
});

describe("modVersion route-cache invalidation", () => {
  it("route-cache source keys buildRouteCacheKey on modVersion()", () => {
    assert.match(ROUTE_CACHE_SRC, /modVersion\(\)/);
    assert.match(ROUTE_CACHE_SRC, /String\(modVersion\(\)\)/);
  });

  it("buildRouteCacheKey embeds the current modVersion as the second segment", () => {
    const key = buildRouteCacheKey("segment-check");
    assert.equal(modVersionSegment(key), String(modVersion()));
  });

  it("keeps the same cache key while modVersion is unchanged", () => {
    const a = buildRouteCacheKey("stable");
    const b = buildRouteCacheKey("stable");
    assert.strictEqual(b, a);
  });

  it("changes the cache key after bumpModVersion for the same filter", () => {
    const before = buildRouteCacheKey("invalidate");
    bumpModVersion();
    try {
      const after = buildRouteCacheKey("invalidate");
      assert.notEqual(after, before);
      assert.equal(modVersionSegment(after), String(modVersion()));
    } finally {
      bumpModVersion();
    }
  });

  it("peekRouteCache misses the post-bump key until the handler stores again", () => {
    const filter = "mod-version-peek";
    const key = buildRouteCacheKey(filter);
    const sessions = [{ path: "/fake/session.jsonl", mtime: new Date(), size: 1 }];
    storeRouteCache(key, sessions, new Map([["k", 1]]));

    assert.ok(peekRouteCache(key));
    bumpModVersion();
    try {
      const newKey = buildRouteCacheKey(filter);
      assert.notEqual(newKey, key);
      assert.equal(peekRouteCache(newKey), null);
    } finally {
      bumpModVersion();
    }
  });

  it("allows repopulating the route cache under the bumped key", () => {
    const filter = "mod-version-store";
    const oldKey = buildRouteCacheKey(filter);
    storeRouteCache(oldKey, [], new Map());

    bumpModVersion();
    try {
      const newKey = buildRouteCacheKey(filter);
      const index = new Map([["fresh", 2]]);
      storeRouteCache(newKey, [], index);
      const hit = peekRouteCache(newKey);
      assert.ok(hit);
      assert.equal(hit.index, index);
    } finally {
      bumpModVersion();
    }
  });
});

describe("modVersion hotModules invalidation", () => {
  it("server-state hotModules gates reload on modVersion()", () => {
    assert.match(SERVER_STATE_SRC, /const v = modVersion\(\)/);
    assert.match(SERVER_STATE_SRC, /if \(v === _lastV\) return _mods/);
    assert.match(SERVER_STATE_SRC, /_hotModuleImporter\.importEntries\(v, \[/);
  });

  it("returns the same cached object while modVersion is unchanged", async () => {
    const a = await hotModules();
    const b = await hotModules();
    assert.strictEqual(b, a);
  });

  it("returns a new bundle after bumpModVersion", async () => {
    const before = await hotModules();
    bumpModVersion();
    try {
      const after = await hotModules();
      assert.notStrictEqual(after, before);
    } finally {
      bumpModVersion();
    }
  });

  it("tracks each bump with a distinct hotModules object", async () => {
    const snapshots = [await hotModules()];
    bumpModVersion();
    bumpModVersion();
    try {
      snapshots.push(await hotModules());
      snapshots.push(await hotModules());
      assert.notStrictEqual(snapshots[1], snapshots[0]);
      assert.strictEqual(snapshots[2], snapshots[1]);
    } finally {
      bumpModVersion();
      bumpModVersion();
    }
  });

  it("reloads callable exports that still render HTML after a bump", async () => {
    bumpModVersion();
    try {
      const { browserPage, renderHTML } = await hotModules();
      assert.equal(typeof browserPage, "function");
      assert.equal(typeof renderHTML, "function");
      const indexHtml = browserPage([], new Map(), "mod:v");
      assert.match(indexHtml, /value="mod:v"/);
      const detailHtml = renderHTML({
        sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        events: [],
        stats: {},
      });
      assert.match(detailHtml, /const SESSION = /);
    } finally {
      bumpModVersion();
    }
  });
});

describe("modVersion coordinated invalidation", () => {
  it("one bump invalidates both route-cache lookup and hotModules cache", async () => {
    const filter = "coordinated";
    const routeKey = buildRouteCacheKey(filter);
    storeRouteCache(routeKey, [], new Map());
    const modsBefore = await hotModules();

    bumpModVersion();
    try {
      const newRouteKey = buildRouteCacheKey(filter);
      const modsAfter = await hotModules();

      assert.notEqual(newRouteKey, routeKey);
      assert.equal(peekRouteCache(newRouteKey), null);
      assert.notStrictEqual(modsAfter, modsBefore);
    } finally {
      bumpModVersion();
    }
  });

  it("simulated index handler flow misses cache then reloads modules after bump", async () => {
    const filter = "handler-flow";
    let cacheKey = buildRouteCacheKey(filter);
    storeRouteCache(cacheKey, [], new Map([["idx", 0]]));
    let mods = await hotModules();

    bumpModVersion();
    try {
      cacheKey = buildRouteCacheKey(filter);
      assert.equal(peekRouteCache(cacheKey), null);

      const nextMods = await hotModules();
      assert.notStrictEqual(nextMods, mods);
      mods = nextMods;

      storeRouteCache(cacheKey, [], new Map([["idx", 1]]));
      assert.ok(peekRouteCache(cacheKey));
      assert.equal(typeof mods.findSessions, "function");
      assert.equal(typeof mods.buildIndex, "function");
    } finally {
      bumpModVersion();
    }
  });
});
