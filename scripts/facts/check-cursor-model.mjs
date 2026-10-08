// Fact im6: Cursor sessions resolve their model from Cursor's state.vscdb
// (composerData:<uuid> -> modelConfig.modelName) identically in parseCursor,
// indexCursorJsonl and peekCursor, and every layer falls back to "cursor" when
// the DB or the row is absent.
//
// This check seeds a real state.vscdb fixture and points the resolver at it via
// TRACEQUEST_CURSOR_STATE_DB. The earlier version only ever exercised the
// fallback path -- a freshly generated temp UUID is never present in the user's
// real DB -- so it stayed green while index/peek and parse actually disagreed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadDatabaseSync } from "../../src/sessions/session-discovery-paths.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-spr-"));
const uuid = "878bf660-0000-4000-8000-000000000000";
const file = path.join(dir, `${uuid}.jsonl`);
fs.writeFileSync(
  file,
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "hello" }] } }) + "\n",
);

const dbPath = path.join(dir, "state.vscdb");
const DatabaseSync = loadDatabaseSync();
const seed = new DatabaseSync(dbPath);
seed.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)");
seed
  .prepare("INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)")
  .run(`composerData:${uuid}`, JSON.stringify({ modelConfig: { modelName: "composer-2.5" } }));
seed.close();

const { indexCursorJsonl } = await import("../../src/sessions/session-index-jsonl.js");
const { peekCursor } = await import("../../src/sessions/session-peek.js");
const { parseSession } = await import("../../src/parse/index.js");

const modelsFor = () => [
  indexCursorJsonl(file).model,
  peekCursor(file, null).model,
  parseSession(file, "cursor").model,
];

// Row present -> all three layers report the real model name.
process.env.TRACEQUEST_CURSOR_STATE_DB = dbPath;
const withDb = modelsFor();

// DB absent -> all three layers fall back to "cursor".
process.env.TRACEQUEST_CURSOR_STATE_DB = path.join(dir, "absent.vscdb");
const withoutDb = modelsFor();

fs.rmSync(dir, { recursive: true, force: true });

const hitOk = withDb.every((m) => m === "composer-2.5");
const missOk = withoutDb.every((m) => m === "cursor");
if (!hitOk || !missOk) {
  console.error(`spr failed: withDb=${JSON.stringify(withDb)} withoutDb=${JSON.stringify(withoutDb)}`);
  process.exit(1);
}
