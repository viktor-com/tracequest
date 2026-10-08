import fs from "node:fs";
import path from "node:path";
import { resolveOpenCodeDbPath } from "../../src/sessions/session-discovery-paths.js";

const DEFAULT_DISCOVERY_SESSION = { id: "paths-1", title: "Paths Fixture", msgCount: 3 };
const SEARCH_SESSION_T0 = 1_715_731_200_000;

export async function openOpenCodeDb(home, opts = {}) {
  const dbPath = resolveOpenCodeDbPath(home);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  if (opts.wal) {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = OFF");
  }
  return { db, dbPath };
}

/** DDL for parse/index/search OpenCode fixtures (session + message.data + part.data). */
export function execOpenCodeIndexSchema(db) {
  db.exec(
    `CREATE TABLE session (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT,
      version TEXT,
      time_created INTEGER,
      time_updated INTEGER
    )`
  );
  db.exec(
    `CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT,
      time_created INTEGER,
      time_updated INTEGER
    )`
  );
  db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT, time_created INTEGER)`);
}

/** DDL for session-discovery fixtures (session + flat message rows). */
export function execOpenCodeDiscoverySchema(db) {
  db.exec(
    `CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created INTEGER, time_updated INTEGER)`
  );
  db.exec(`CREATE TABLE message (session_id TEXT, role TEXT, content TEXT)`);
}

export async function seedOpenCodeDiscoveryDb(home, sessions = [DEFAULT_DISCOVERY_SESSION]) {
  const { db, dbPath } = await openOpenCodeDb(home);
  execOpenCodeDiscoverySchema(db);
  const insS = db.prepare(
    `INSERT INTO session (id, title, directory, version, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insM = db.prepare(`INSERT INTO message (session_id, role, content) VALUES (?, ?, ?)`);
  for (const s of sessions) {
    const timeCreated = s.time_created ?? 1715731200;
    insS.run(
      s.id,
      s.title ?? s.id,
      s.directory ?? "/tmp/ocproj",
      s.version ?? "1.0",
      timeCreated,
      s.time_updated ?? timeCreated
    );
    const count = s.msgCount ?? 3;
    for (let i = 0; i < count; i++) insM.run(s.id, "user", `msg-${i}`);
  }
  db.close();
  return dbPath;
}

export async function seedOpenCodeIndexDb(home, sessions, opts = {}) {
  const {
    includeSessionTable = true,
    defaultDirectory = "/tmp/ocproj",
    defaultTime = SEARCH_SESSION_T0,
    wal = false,
  } = opts;
  const { db, dbPath } = await openOpenCodeDb(home, { wal });
  if (includeSessionTable) {
    execOpenCodeIndexSchema(db);
  } else {
    db.exec(
      `CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)`
    );
    db.exec(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, data TEXT)`);
  }

  const insS = includeSessionTable
    ? db.prepare(
        `INSERT INTO session (id, title, directory, version, time_created, time_updated)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
    : null;
  const insMsg = includeSessionTable
    ? db.prepare(
        `INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`
      )
    : db.prepare(`INSERT INTO message (id, session_id, data, time_created) VALUES (?, ?, ?, ?)`);
  const insPart = includeSessionTable
    ? db.prepare(`INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)`)
    : db.prepare(`INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)`);

  let msgSeq = 0;
  let partSeq = 0;
  for (const sess of sessions) {
    const sessTime = sess.time_created ?? defaultTime;
    const sessUpdated = sess.time_updated ?? sessTime + 5000;
    if (insS) {
      insS.run(sess.id, sess.title ?? sess.id, sess.directory ?? defaultDirectory, "1.0", sessTime, sessUpdated);
    }
    for (const msg of sess.messages ?? []) {
      const mid = msg.id ?? `m${++msgSeq}`;
      const created = msg.timeCreated ?? (typeof msg.time === "number" ? msg.time : defaultTime);
      const payload = { role: msg.role ?? "user", modelID: msg.modelID };
      if (msg.finish != null) payload.finish = msg.finish;
      if (msg.time !== undefined) payload.time = msg.time;
      else if (includeSessionTable) payload.time = { created };

      if (includeSessionTable) {
        insMsg.run(mid, sess.id, JSON.stringify(payload), created, created);
        for (const part of msg.parts ?? []) {
          const pid = part.id ?? `p${++partSeq}`;
          insPart.run(pid, mid, JSON.stringify(part), part.timeCreated ?? created);
        }
      } else {
        insMsg.run(
          mid,
          sess.id,
          JSON.stringify(payload),
          msg.time ?? "2026-06-03T10:00:00.000Z"
        );
        for (const part of msg.parts ?? []) {
          insPart.run(part.id ?? `p${++partSeq}`, mid, JSON.stringify(part));
        }
      }
    }
  }
  db.close();
  return dbPath;
}

/** fsync opencode.db after writes so fs.watch observers see durable on-disk changes. */
export function fsyncOpenCodeDbPath(dbPath) {
  const fd = fs.openSync(dbPath, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Insert one session into an existing index-shaped opencode.db and fsync.
 * Use in live-reload integration tests after seedOpenCodeIndexDb(home, []).
 */
export async function appendOpenCodeIndexSessionSynced(home, session, opts = {}) {
  const { defaultDirectory = "/tmp/ocproj", defaultTime = SEARCH_SESSION_T0 } = opts;
  const { db, dbPath } = await openOpenCodeDb(home);

  const insS = db.prepare(
    `INSERT INTO session (id, title, directory, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insMsg = db.prepare(
    `INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`
  );
  const insPart = db.prepare(`INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)`);

  const sessTime = session.time_created ?? defaultTime;
  const sessUpdated = session.time_updated ?? sessTime + 5000;
  insS.run(
    session.id,
    session.title ?? session.id,
    session.directory ?? defaultDirectory,
    "1.0",
    sessTime,
    sessUpdated
  );

  let msgSeq = 0;
  let partSeq = 0;
  for (const msg of session.messages ?? []) {
    const mid = msg.id ?? `m${++msgSeq}`;
    const created = msg.timeCreated ?? (typeof msg.time === "number" ? msg.time : defaultTime);
    const payload = { role: msg.role ?? "user", modelID: msg.modelID };
    if (msg.finish != null) payload.finish = msg.finish;
    if (msg.time !== undefined) payload.time = msg.time;
    else payload.time = { created };

    insMsg.run(mid, session.id, JSON.stringify(payload), created, created);
    for (const part of msg.parts ?? []) {
      const pid = part.id ?? `p${++partSeq}`;
      insPart.run(pid, mid, JSON.stringify(part), part.timeCreated ?? created);
    }
  }

  db.close();
  fsyncOpenCodeDbPath(dbPath);
  return { dbPath, uri: `opencode://${session.id}` };
}

export async function seedOpenCodeSearchSession(home, sessionId, text) {
  const { db, dbPath } = await openOpenCodeDb(home);
  execOpenCodeIndexSchema(db);
  const insS = db.prepare(
    `INSERT INTO session (id, title, directory, version, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insMsg = db.prepare(
    `INSERT INTO message (id, session_id, data, time_created, time_updated) VALUES (?, ?, ?, ?, ?)`
  );
  const insPart = db.prepare(`INSERT INTO part (id, message_id, data, time_created) VALUES (?, ?, ?, ?)`);
  const t0 = SEARCH_SESSION_T0;
  insS.run(sessionId, "MSRC OpenCode", "/home/dev/msrc-opencode-proj", "1.0", t0, t0 + 5000);
  for (let i = 0; i < 3; i++) {
    const mid = `m${i}`;
    insMsg.run(
      mid,
      sessionId,
      JSON.stringify({ role: i % 2 === 0 ? "user" : "assistant", modelID: "gpt-5-codex" }),
      t0 + i * 1000,
      t0 + i * 1000
    );
    if (i === 0) {
      insPart.run(`p${i}`, mid, JSON.stringify({ type: "text", text }), t0);
    } else {
      insPart.run(`p${i}`, mid, JSON.stringify({ type: "text", text: `filler turn ${i}` }), t0 + i);
    }
  }
  db.close();
  return dbPath;
}
