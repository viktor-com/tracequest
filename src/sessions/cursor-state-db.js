import { join } from "node:path";
import { homedir } from "node:os";
import { loadDatabaseSync } from "./session-discovery-paths.js";
import { statSync } from "node:fs";
import { basename } from "node:path";

function resolveCursorStateDbPath(home = homedir()) {
  const override = process.env.TRACEQUEST_CURSOR_STATE_DB;
  if (override) return override;
  const platform = process.platform;
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

let cachedDb = null;
let cachedDbPath = null;
let cachedDbMtime = null;

function getDb() {
  const dbPath = resolveCursorStateDbPath();
  try {
    const mtime = statSync(dbPath).mtime.getTime();
    if (cachedDb && cachedDbPath === dbPath && cachedDbMtime === mtime) return cachedDb;
    if (cachedDb) try { cachedDb.close(); } catch {}
    const DatabaseSync = loadDatabaseSync();
    cachedDb = new DatabaseSync(dbPath, { readOnly: true });
    cachedDbPath = dbPath;
    cachedDbMtime = mtime;
    return cachedDb;
  } catch {
    return null;
  }
}

export function cursorModelFromStateDb(filePath) {
  const composerId = basename(filePath, ".jsonl");
  if (!composerId) return null;
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare(
      "SELECT value FROM cursorDiskKV WHERE key = ?",
    ).get(`composerData:${composerId}`);
    if (!row?.value) return null;
    const data = JSON.parse(row.value);
    return data?.modelConfig?.modelName || null;
  } catch {
    return null;
  }
}
