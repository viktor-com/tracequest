import { describe, it, mock, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  lrClients,
  broadcastLr,
  triggerDataUpdate,
  registerDataUpdateListener,
  isSrcHotReloadFile,
  bumpModVersion,
  modVersion,
  DATA_UPDATE_DEBOUNCE_MS,
  SRC_HOT_RELOAD_HELPER_DIRS,
  defaultDataRoots,
  startLiveReloadWatchers,
  _resetDataUpdateTimerForTests,
  _resetWatchersStartedForTests,
  _watchersStartedForTests,
} from "../../src/server/server-live-reload.js";

function trackWrites() {
  const payloads = [];
  const client = { write: (p) => payloads.push(p) };
  lrClients.add(client);
  return {
    payloads,
    cleanup: () => lrClients.delete(client),
  };
}

function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Perform the triggering write and wait for the resulting SSE, re-issuing the
 * write until it arrives. fs.watch arms asynchronously, so a write in the same
 * tick as startLiveReloadWatchers can be missed outright — not merely delayed —
 * and a fixed settle only lowers, never eliminates, that race under load. Every
 * data-update write collapses into a single debounced payload and reload writes
 * are idempotent for our assertions, so re-writing is safe and makes event
 * delivery deterministic.
 */
async function writeUntilBroadcast(write, ready, message, timeoutMs = DATA_UPDATE_DEBOUNCE_MS + 5000) {
  const start = Date.now();
  let lastWrite = -Infinity;
  while (Date.now() - start < timeoutMs) {
    if (ready()) return;
    if (Date.now() - lastWrite > 500) {
      write();
      lastWrite = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

async function waitFor(predicate, message, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

describe("server-live-reload lrClients", () => {
  afterEach(() => lrClients.clear());

  it("is a Set that accepts SSE response handles", () => {
    assert.ok(lrClients instanceof Set);
    const res = { write: mock.fn() };
    lrClients.add(res);
    assert.equal(lrClients.size, 1);
    lrClients.delete(res);
    assert.equal(lrClients.size, 0);
  });
});

describe("server-live-reload broadcastLr", () => {
  afterEach(() => lrClients.clear());

  it("is a no-op when no clients are connected", () => {
    assert.doesNotThrow(() => broadcastLr("data: ping\n\n"));
  });

  it("writes the full SSE frame to every healthy client", () => {
    const a = { write: mock.fn() };
    const b = { write: mock.fn() };
    lrClients.add(a);
    lrClients.add(b);

    broadcastLr("data: reload\n\n");

    assert.equal(a.write.mock.calls.length, 1);
    assert.equal(b.write.mock.calls.length, 1);
    assert.equal(a.write.mock.calls[0].arguments[0], "data: reload\n\n");
    assert.equal(b.write.mock.calls[0].arguments[0], "data: reload\n\n");

    lrClients.clear();
  });

  it("drops clients whose write throws and keeps broadcasting to survivors", () => {
    const good = { write: mock.fn() };
    const bad = {
      write: mock.fn(() => {
        throw new Error("broken pipe");
      }),
    };
    lrClients.add(good);
    lrClients.add(bad);

    broadcastLr("data: ping\n\n");

    assert.equal(good.write.mock.calls.length, 1);
    assert.equal(lrClients.has(bad), false);
    assert.equal(lrClients.has(good), true);

    broadcastLr("data: second\n\n");
    assert.equal(good.write.mock.calls.length, 2);
    assert.equal(good.write.mock.calls[1].arguments[0], "data: second\n\n");

    lrClients.clear();
  });
});

describe("server-live-reload triggerDataUpdate debounce", () => {
  afterEach(() => {
    _resetDataUpdateTimerForTests();
    lrClients.clear();
    mock.timers.reset();
  });

  it("does not broadcast until the debounce window elapses", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { payloads, cleanup } = trackWrites();

    triggerDataUpdate();
    assert.equal(payloads.length, 0);

    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS - 1);
    assert.equal(payloads.length, 0);

    mock.timers.tick(1);
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0], "data: data-update\n\n");
    cleanup();
  });

  it("coalesces rapid triggerDataUpdate calls into one SSE payload", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { payloads, cleanup } = trackWrites();

    triggerDataUpdate();
    triggerDataUpdate();
    triggerDataUpdate();
    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);

    assert.equal(payloads.length, 1);
    cleanup();
  });

  it("schedules a fresh broadcast after the prior debounce fired", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const { payloads, cleanup } = trackWrites();

    triggerDataUpdate();
    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);
    assert.equal(payloads.length, 1);

    triggerDataUpdate();
    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);
    assert.equal(payloads.length, 2);
    cleanup();
  });

  it("invokes registered data-update listeners once per debounced broadcast", () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const calls = [];
    const unregister = registerDataUpdateListener(() => calls.push(1));
    try {
      triggerDataUpdate();
      triggerDataUpdate();
      mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);
      assert.equal(calls.length, 1);
      triggerDataUpdate();
      mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);
      assert.equal(calls.length, 2);
    } finally {
      unregister();
    }
  });
});

describe("server-live-reload isSrcHotReloadFile", () => {
  const cases = [
    ["render.js", true],
    ["nested/render.js", true],
    ["server/route-handlers.js", true],
    ["index.js", true],
    [".js", true],
    ["foo.bar.js", true],
    ["styles.css", false],
    ["bundle.js.map", false],
    ["script.js.bak", false],
    ["file.jsx", false],
    ["file.mjs", false],
    ["file.cjs", false],
    ["README", false],
    ["", false],
    [null, false],
    [undefined, false],
  ];

  for (const [filename, expected] of cases) {
    const label =
      filename === null
        ? "null"
        : filename === undefined
          ? "undefined"
          : JSON.stringify(filename);
    it(`${label} → ${expected}`, () => {
      assert.equal(isSrcHotReloadFile(filename), expected);
    });
  }
});

describe("server-live-reload modVersion and defaultDataRoots", () => {
  it("bumpModVersion increments the hot-module counter", () => {
    const before = modVersion();
    bumpModVersion();
    assert.equal(modVersion(), before + 1);
  });

  it("defaultDataRoots returns every session root under home, local and imported", () => {
    const roots = defaultDataRoots("/fakehome");
    assert.equal(roots.length, 8);
    assert.ok(roots.every((r) => r.startsWith("/fakehome/")));
    assert.ok(roots.some((r) => r.includes(".grok")));
    assert.ok(roots.some((r) => r.includes("opencode")));
    // A live cursor session must tick the data watcher like every other
    // source — its recordings live under ~/.cursor/projects.
    assert.ok(roots.some((r) => r.includes(".cursor")), "cursor recordings are watched too");
    // The two tracequest-owned import roots are scanned by discoveryRoots(),
    // so they have to be watched as well or an imported recording appears only
    // after a restart (fact dyr). Watching the hosts ROOT rather than each host
    // also covers hosts imported after the server started.
    assert.ok(
      roots.some((r) => r.includes("cursor-cloud")),
      "cursor-cloud imports raise data-update ticks",
    );
    assert.ok(
      roots.some((r) => r.endsWith("/hosts")),
      "ssh-imported host trees raise data-update ticks",
    );
  });
});

describe("server-live-reload startLiveReloadWatchers", () => {
  let tmpDir;
  let savedSkip;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tq-lr-watch-"));
    savedSkip = process.env.TRACEQUEST_SKIP_LR_WATCH;
    delete process.env.TRACEQUEST_SKIP_LR_WATCH;
    _resetWatchersStartedForTests();
    _resetDataUpdateTimerForTests();
    lrClients.clear();
  });

  afterEach(() => {
    _resetDataUpdateTimerForTests();
    _resetWatchersStartedForTests();
    lrClients.clear();
    mock.timers.reset();
    if (savedSkip === undefined) {
      delete process.env.TRACEQUEST_SKIP_LR_WATCH;
    } else {
      process.env.TRACEQUEST_SKIP_LR_WATCH = savedSkip;
    }
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  function layoutRoots() {
    const dataRoot = join(tmpDir, "sessions");
    const srcDir = join(tmpDir, "src");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(srcDir, { recursive: true });
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "");
    return { dataRoot, srcDir: pathToFileURL(srcDir), dbPath };
  }

  it("is idempotent — second start does not re-register watchers", () => {
    const { dataRoot, srcDir, dbPath } = layoutRoots();
    startLiveReloadWatchers({
      srcDir,
      dataRoots: [dataRoot],
      openCodeDbPath: dbPath,
    });
    assert.equal(_watchersStartedForTests(), true);
    startLiveReloadWatchers({
      srcDir,
      dataRoots: [dataRoot],
      openCodeDbPath: dbPath,
    });
    assert.equal(_watchersStartedForTests(), true);
  });

  it("no-ops when TRACEQUEST_SKIP_LR_WATCH=1", () => {
    process.env.TRACEQUEST_SKIP_LR_WATCH = "1";
    const { dataRoot, srcDir, dbPath } = layoutRoots();
    startLiveReloadWatchers({
      srcDir,
      dataRoots: [dataRoot],
      openCodeDbPath: dbPath,
    });
    assert.equal(_watchersStartedForTests(), false);
  });

  it("skips missing data roots without throwing", () => {
    const { srcDir, dbPath } = layoutRoots();
    const missing = join(tmpDir, "no-such-root");
    assert.equal(existsSync(missing), false);
    assert.doesNotThrow(() =>
      startLiveReloadWatchers({
        srcDir,
        dataRoots: [missing],
        openCodeDbPath: dbPath,
      })
    );
    assert.equal(_watchersStartedForTests(), true);
  });
});

describe("server-live-reload fs.watch integration", () => {
  let tmpDir;
  let savedSkip;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "tq-lr-fs-"));
    savedSkip = process.env.TRACEQUEST_SKIP_LR_WATCH;
    delete process.env.TRACEQUEST_SKIP_LR_WATCH;
    _resetWatchersStartedForTests();
    _resetDataUpdateTimerForTests();
    lrClients.clear();
  });

  afterEach(() => {
    _resetDataUpdateTimerForTests();
    _resetWatchersStartedForTests();
    lrClients.clear();
    mock.timers.reset();
    if (savedSkip === undefined) {
      delete process.env.TRACEQUEST_SKIP_LR_WATCH;
    } else {
      process.env.TRACEQUEST_SKIP_LR_WATCH = savedSkip;
    }
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("src .js change broadcasts reload immediately and bumps modVersion", async () => {
    const srcPath = join(tmpDir, "src");
    mkdirSync(srcPath, { recursive: true });
    const srcDir = pathToFileURL(srcPath);
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "");

    const { payloads, cleanup } = trackWrites();
    const versionBefore = modVersion();

    startLiveReloadWatchers({
      srcDir,
      dataRoots: [],
      openCodeDbPath: dbPath,
    });

    await writeUntilBroadcast(
      () => writeFileSync(join(srcPath, "hot.js"), "export const x = 1;\n"),
      () => payloads.includes("data: reload\n\n"),
      `expected reload SSE, got: ${JSON.stringify(payloads)}`
    );
    assert.ok(modVersion() > versionBefore);
    cleanup();
  });

  it("nested src helper .js change broadcasts reload immediately and bumps modVersion", async () => {
    const srcPath = join(tmpDir, "src");
    mkdirSync(srcPath, { recursive: true });
    for (const dir of SRC_HOT_RELOAD_HELPER_DIRS) {
      mkdirSync(join(srcPath, dir), { recursive: true });
    }
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "");

    const { payloads, cleanup } = trackWrites();

    startLiveReloadWatchers({
      srcDir: pathToFileURL(srcPath),
      dataRoots: [],
      openCodeDbPath: dbPath,
    });

    for (const dir of SRC_HOT_RELOAD_HELPER_DIRS) {
      const versionBefore = modVersion();
      payloads.length = 0;

      writeFileSync(join(srcPath, dir, `hot-${dir}.js`), `export const ${dir}Hot = 1;\n`);

      await waitFor(
        () => payloads.includes("data: reload\n\n") && modVersion() > versionBefore,
        `${dir} helper edit did not trigger reload; payloads=${JSON.stringify(payloads)}`
      );
    }

    cleanup();
  });

  it("src non-.js writes do not broadcast reload", async () => {
    const srcPath = join(tmpDir, "src");
    mkdirSync(srcPath, { recursive: true });
    const srcDir = pathToFileURL(srcPath);
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "");

    const { payloads, cleanup } = trackWrites();
    const versionBefore = modVersion();

    startLiveReloadWatchers({
      srcDir,
      dataRoots: [],
      openCodeDbPath: dbPath,
    });

    writeFileSync(join(srcPath, "notes.md"), "# noop\n");
    await flushMicrotasks();

    assert.deepEqual(payloads, []);
    assert.equal(modVersion(), versionBefore);
    cleanup();
  });

  it("data-root .jsonl fs events debounce into one data-update SSE", async () => {
    // Real timers, not mocked: waiting for the async fs.watch event while
    // setTimeout is mocked is racy on macOS. The debounce collapse (two rapid
    // writes → one SSE) still proves debouncing; the exact timing is covered
    // deterministically by the triggerDataUpdate debounce unit tests above.
    const dataRoot = join(tmpDir, "sessions");
    const srcPath = join(tmpDir, "src");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(srcPath, { recursive: true });
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "");

    const { payloads, cleanup } = trackWrites();

    startLiveReloadWatchers({
      srcDir: pathToFileURL(srcPath),
      dataRoots: [dataRoot],
      openCodeDbPath: dbPath,
    });

    await writeUntilBroadcast(
      () => writeFileSync(join(dataRoot, "live.jsonl"), "{}\n"),
      () => payloads.length >= 1,
      `expected one debounced data-update, got ${JSON.stringify(payloads)}`
    );
    // Multiple fs writes (the retries above, plus any coalesced events) collapse
    // into exactly one debounced payload.
    assert.equal(payloads.length, 1, "rapid fs churn must collapse to a single data-update");
    assert.equal(payloads[0], "data: data-update\n\n");
    cleanup();
  });

  it("irrelevant data-root filenames do not schedule data-update", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const dataRoot = join(tmpDir, "sessions");
    const srcPath = join(tmpDir, "src");
    mkdirSync(dataRoot, { recursive: true });
    mkdirSync(srcPath, { recursive: true });
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "");

    const { payloads, cleanup } = trackWrites();

    startLiveReloadWatchers({
      srcDir: pathToFileURL(srcPath),
      dataRoots: [dataRoot],
      openCodeDbPath: dbPath,
    });

    writeFileSync(join(dataRoot, "cache-index.json"), "{}");
    await flushMicrotasks();
    mock.timers.tick(DATA_UPDATE_DEBOUNCE_MS);

    assert.deepEqual(payloads, []);
    cleanup();
  });

  it("opencode.db watcher debounces data-update SSE", async () => {
    // Real timers (see the data-root debounce test above for why).
    const srcPath = join(tmpDir, "src");
    mkdirSync(srcPath, { recursive: true });
    const dbPath = join(tmpDir, "opencode.db");
    writeFileSync(dbPath, "sqlite");

    const { payloads, cleanup } = trackWrites();

    startLiveReloadWatchers({
      srcDir: pathToFileURL(srcPath),
      dataRoots: [],
      openCodeDbPath: dbPath,
    });

    let counter = 0;
    await writeUntilBroadcast(
      () => writeFileSync(dbPath, `sqlite-updated-${counter++}`),
      () => payloads.length >= 1,
      `expected one debounced data-update, got ${JSON.stringify(payloads)}`
    );
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0], "data: data-update\n\n");
    cleanup();
  });
});
