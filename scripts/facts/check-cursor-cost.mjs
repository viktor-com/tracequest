// Fact dc9: real-format Cursor sessions yield a nonzero estimateCost from estimated tokens.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexCursorJsonl } from "../../src/sessions/session-index-jsonl.js";
import { estimateCost } from "../../src/filter/filter-formats.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fact-dc9-"));
const file = path.join(dir, "c.jsonl");
fs.writeFileSync(
  file,
  JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "real cursor prompt for cost" }] } }) +
    "\n" +
    JSON.stringify({ role: "assistant", message: { content: [{ type: "text", text: "a reply with enough text to estimate" }] } }) +
    "\n",
);
const meta = indexCursorJsonl(file);
fs.rmSync(dir, { recursive: true, force: true });
if (!(estimateCost(meta) > 0)) {
  console.error("cursor estimateCost was not > 0:", estimateCost(meta));
  process.exit(1);
}
