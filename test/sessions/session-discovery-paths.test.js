import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SESSION_DISCOVERY_PATHS_SRC = readFileSync(
  fileURLToPath(new URL("../../src/sessions/session-discovery-paths.js", import.meta.url)),
  "utf8",
);
import {
  OPENCODE_DB_REL,
  resolveOpenCodeDbPath,
  loadDatabaseSync,
  openOpenCodeDbReadOnly,
  withOpenCodeDb,
  openCodeDbMtimeMs,
} from "../../src/sessions/session-discovery-paths.js";
import { seedOpenCodeDiscoveryDb } from "../helpers/opencode-db-fixtures.js";
import {
  getDiscoveryPaths,
  discoveryRoots,
  clearOpenCodeDiscoveryCache,
} from "../../src/sessions/session-discovery.js";

function importDiscovery() {
  const modUrl = new URL("../../src/sessions/session-discovery.js?" + Date.now(), import.meta.url);
  return import(modUrl.href);
}

function withTempHome(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-paths-"));
  const originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
  return (async () => {
    try {
      return await fn(tmpDir);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  })();
}

describe("session-discovery-paths resolveOpenCodeDbPath", () => {
  test("OPENCODE_DB_REL matches XDG data layout under home", () => {
    assert.deepEqual(OPENCODE_DB_REL, [".local", "share", "opencode", "opencode.db"]);
    const home = "/fake/home";
    assert.equal(resolveOpenCodeDbPath(home), path.join(home, ...OPENCODE_DB_REL));
  });

  test("resolveOpenCodeDbPath without args follows process HOME", () =>
    withTempHome((tmpDir) => {
      assert.equal(resolveOpenCodeDbPath(), resolveOpenCodeDbPath(tmpDir));
    }));

  test("getDiscoveryPaths.openCodeDb matches resolveOpenCodeDbPath for HOME", () =>
    withTempHome((tmpDir) => {
      const paths = getDiscoveryPaths();
      assert.equal(paths.openCodeDb, resolveOpenCodeDbPath(tmpDir));
      assert.ok(paths.openCodeDb.endsWith("opencode.db"));
    }));

  test("discoveryRoots ends with the OpenCode SQLite path", () =>
    withTempHome((tmpDir) => {
      const roots = discoveryRoots();
      assert.equal(roots[roots.length - 1], resolveOpenCodeDbPath(tmpDir));
    }));
});

describe("session-discovery-paths openCodeDbMtimeMs", () => {
  test("returns null when the database file is missing", () =>
    withTempHome((tmpDir) => {
      assert.equal(openCodeDbMtimeMs(resolveOpenCodeDbPath(tmpDir)), null);
    }));

  test("returns positive mtime after fixture is written", () =>
    withTempHome(async (tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir);
      const mtime = openCodeDbMtimeMs(resolveOpenCodeDbPath(tmpDir));
      assert.ok(typeof mtime === "number" && mtime > 0);
    }));

  test("reflects utimes when DB content changes but mtime is restored", () =>
    withTempHome(async (tmpDir) => {
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "mtime-a", msgCount: 3 }]);
      const before = openCodeDbMtimeMs(dbPath);
      const origStat = fs.statSync(dbPath);
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.prepare(
        `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("mtime-b", "B", "/tmp/x", "1", 1, 1);
      db.close();
      fs.utimesSync(dbPath, origStat.atime, origStat.mtime);
      assert.equal(openCodeDbMtimeMs(dbPath), before);
    }));
});

describe("session-discovery-paths loadDatabaseSync and openOpenCodeDbReadOnly", () => {
  test("loadDatabaseSync suppresses sqlite ExperimentalWarning via includesLower", () => {
    assert.ok(SESSION_DISCOVERY_PATHS_SRC.includes('includesLower(msg, "sqlite")'));
    assert.ok(SESSION_DISCOVERY_PATHS_SRC.includes('includesLower(msg, "experimental")'));
    assert.ok(!SESSION_DISCOVERY_PATHS_SRC.includes('msg.toLowerCase().includes("sqlite")'));
  });

  test("loadDatabaseSync returns DatabaseSync constructor", () => {
    const DatabaseSync = loadDatabaseSync();
    assert.equal(typeof DatabaseSync, "function");
  });

  test("openOpenCodeDbReadOnly reads session rows from fixture", () =>
    withTempHome(async (tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir);
      const { db, dbPath } = openOpenCodeDbReadOnly(tmpDir);
      try {
        assert.equal(dbPath, resolveOpenCodeDbPath(tmpDir));
        const row = db.prepare("SELECT title FROM session WHERE id = ?").get("paths-1");
        assert.equal(row.title, "Paths Fixture");
      } finally {
        db.close();
      }
    }));
});

describe("session-discovery-paths withOpenCodeDb", () => {
  test("passes dbPath as second callback argument", () =>
    withTempHome(async (tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir);
      let seenPath = null;
      withOpenCodeDb((_db, dbPath) => {
        seenPath = dbPath;
      }, { home: tmpDir });
      assert.equal(seenPath, resolveOpenCodeDbPath(tmpDir));
    }));

  test("returns the callback result", () =>
    withTempHome(async (tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir);
      const count = withOpenCodeDb((db) => {
        return db.prepare("SELECT COUNT(*) AS n FROM session").get().n;
      }, { home: tmpDir });
      assert.equal(count, 1);
    }));

  test("closes connection after callback returns", () =>
    withTempHome(async (tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir);
      let sawTitle = false;
      withOpenCodeDb((db) => {
        const row = db.prepare("SELECT title FROM session WHERE id = ?").get("paths-1");
        sawTitle = row.title === "Paths Fixture";
      }, { home: tmpDir });
      assert.equal(sawTitle, true);
      const { db } = openOpenCodeDbReadOnly(tmpDir);
      db.close();
    }));

  test("closes connection when callback throws", () =>
    withTempHome(async (tmpDir) => {
      await seedOpenCodeDiscoveryDb(tmpDir);
      assert.throws(
        () =>
          withOpenCodeDb(() => {
            throw new Error("paths probe");
          }, { home: tmpDir }),
        /paths probe/
      );
      const { db } = openOpenCodeDbReadOnly(tmpDir);
      db.close();
    }));
});

describe("session-discovery-paths findOpenCodeSessions mtime cache", () => {
  test("skips re-query when openCodeDbMtimeMs is unchanged", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-paths-cache-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "cache-1", msgCount: 3 }]);
      const { findOpenCodeSessions } = await importDiscovery();

      const out1 = [];
      findOpenCodeSessions(null, out1);
      assert.equal(out1.length, 1);
      assert.equal(out1[0].file, "cache-1");

      const origStat = fs.statSync(dbPath);
      const { DatabaseSync } = await import("node:sqlite");
      const db2 = new DatabaseSync(dbPath);
      db2.prepare(
        `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
      ).run("cache-2", "Second", "/tmp/ocproj", "1.0", 1715731300, 1715731300);
      const m2 = db2.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
      for (let i = 0; i < 3; i++) m2.run("cache-2", "user", "hi");
      db2.close();
      fs.utimesSync(dbPath, origStat.atime, origStat.mtime);

      const out2 = [];
      findOpenCodeSessions(null, out2);
      assert.equal(out2.length, 1, "mtime cache must not re-query when DB mtime unchanged");
      assert.equal(out2[0].file, "cache-1");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("re-queries when DB file mtime changes", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-paths-inval-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [
        { id: "old", title: "Old Session", msgCount: 3 },
      ]);
      const { findOpenCodeSessions } = await importDiscovery();

      const out1 = [];
      findOpenCodeSessions(null, out1);
      assert.equal(out1[0].title, "Old Session");

      fs.unlinkSync(dbPath);
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "new", title: "New Session", msgCount: 3 }]);

      const out2 = [];
      findOpenCodeSessions(null, out2);
      assert.equal(out2.length, 1);
      assert.equal(out2[0].title, "New Session");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("missing DB clears cache via openCodeDbMtimeMs null", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-paths-miss-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "gone", msgCount: 3 }]);
      const { findOpenCodeSessions } = await importDiscovery();

      const out1 = [];
      findOpenCodeSessions(null, out1);
      assert.equal(out1.length, 1);

      fs.unlinkSync(dbPath);
      clearOpenCodeDiscoveryCache();

      const out2 = [];
      findOpenCodeSessions(null, out2);
      assert.equal(out2.length, 0);
      assert.equal(openCodeDbMtimeMs(dbPath), null);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("session-discovery-paths findGrokSessions edge paths", () => {
  function grokSessionsRoot(tmpDir) {
    const root = path.join(tmpDir, ".grok", "sessions");
    fs.mkdirSync(root, { recursive: true });
    return root;
  }

  function grokWorkspace(tmpDir, wsName) {
    const ws = path.join(grokSessionsRoot(tmpDir), wsName);
    fs.mkdirSync(ws, { recursive: true });
    return ws;
  }

  function grokChatSession(wsDir, sessionId) {
    const dir = path.join(wsDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "chat_history.jsonl"), '{"type":"user"}\n');
    return dir;
  }

  test("returns empty when .grok/sessions exists but has no workspaces", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-edge-empty-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      grokSessionsRoot(tmpDir);
      const { findGrokSessions } = await importDiscovery();
      const out = [];
      findGrokSessions(null, out);
      assert.deepEqual(out, []);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("skips non-directory entries at the sessions root", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-edge-rootfile-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const root = grokSessionsRoot(tmpDir);
      fs.writeFileSync(path.join(root, "stray.jsonl"), "{}\n");
      const { findGrokSessions } = await importDiscovery();
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out.length, 0);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("empty workspace directory yields no sessions", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-edge-wsempty-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      grokWorkspace(tmpDir, "ws-empty");
      const { findGrokSessions } = await importDiscovery();
      const out = [];
      findGrokSessions(null, out);
      assert.deepEqual(out, []);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("ignores subdirs without chat_history.jsonl and file entries in workspace", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-grok-edge-mixed-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const ws = grokWorkspace(tmpDir, "ws-mixed");
      const orphan = path.join(ws, "orphan-no-chat");
      fs.mkdirSync(orphan, { recursive: true });
      fs.writeFileSync(path.join(ws, "loose.jsonl"), "{}\n");
      const good = grokChatSession(ws, "good-sess");
      const { findGrokSessions } = await importDiscovery();
      const out = [];
      findGrokSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].path, good);
      assert.equal(out[0].file, "good-sess");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("session-discovery-paths findOpenCodeSessions edge paths", () => {
  test("defaults project to opencode when session directory is empty", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-edge-proj-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "no-dir", directory: "", msgCount: 3 }]);
      const { findOpenCodeSessions } = await importDiscovery();
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].project, "opencode");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("mtime falls back to time_created when time_updated is null", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-edge-mtime-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      await seedOpenCodeDiscoveryDb(tmpDir, [
        { id: "created-only", time_created: 424242, time_updated: 999999, msgCount: 3 },
      ]);
      const dbPath = resolveOpenCodeDbPath(tmpDir);
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(dbPath);
      db.prepare("UPDATE session SET time_updated = NULL WHERE id = ?").run("created-only");
      db.close();

      const { findOpenCodeSessions } = await importDiscovery();
      const out = [];
      findOpenCodeSessions(null, out);
      assert.equal(out.length, 1);
      assert.equal(out[0].mtime.getTime(), 424242);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("returns empty when opencode.db is not valid SQLite", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-edge-corrupt-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = resolveOpenCodeDbPath(tmpDir);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "NOT_A_SQLITE_FILE");
      const { findOpenCodeSessions } = await importDiscovery();
      const out = [];
      findOpenCodeSessions(null, out);
      assert.deepEqual(out, []);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("recovers after corrupt DB is replaced with a valid fixture", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tq-oc-edge-recover-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    try {
      const dbPath = resolveOpenCodeDbPath(tmpDir);
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, "NOT_A_SQLITE_FILE");
      const { findOpenCodeSessions, clearOpenCodeDiscoveryCache } = await importDiscovery();

      const outBad = [];
      findOpenCodeSessions(null, outBad);
      assert.deepEqual(outBad, []);

      fs.unlinkSync(dbPath);
      clearOpenCodeDiscoveryCache();
      await seedOpenCodeDiscoveryDb(tmpDir, [{ id: "recovered", title: "Recovered", msgCount: 3 }]);

      const outOk = [];
      findOpenCodeSessions(null, outOk);
      assert.equal(outOk.length, 1);
      assert.equal(outOk[0].file, "recovered");
      assert.equal(outOk[0].title, "Recovered");
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});