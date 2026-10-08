export {
  safeSlice,
  shortToolPath,
  parseEscapedJsonString,
  parseWebSearchLinks,
} from "./parse-utils.js";

import { setContentTruncation } from "./parse-utils.js";

export { parseJsonlLine, forEachPartialParsedJsonlLine } from "./jsonl-read.js";

export { normalizeToolName } from "./parse-enrich.js";

import { sep } from "node:path";
import { parseClaude, parseCursor, parseCursorCloud } from "./parse-claude.js";
import { parseCodex } from "./parse-codex.js";
import { parseFactory } from "./parse-factory.js";
import { parseGrok } from "./parse-grok.js";
import { parseOpenCode } from "./parse-opencode.js";
import { attachSessionHash } from "../sessions/session-hash.js";
import { resolveCursorCloudRoot } from "../sessions/session-discovery-paths.js";

export function parseSession(filePath, source, opts = {}) {
  if (!source) source = detectSource(filePath);
  // `opts.full` disables content truncation for a verbatim parse (messages --full).
  // The toggle is restored in finally so it never leaks to later parses.
  const full = opts && opts.full === true;
  if (full) setContentTruncation(false);
  let session;
  try {
    switch (source) {
      case "codex": session = parseCodex(filePath); break;
      case "cursor": session = parseCursor(filePath); break;
      case "cursor-cloud": session = parseCursorCloud(filePath); break;
      case "factory": session = parseFactory(filePath); break;
      case "grok": session = parseGrok(filePath); break;
      case "opencode": session = parseOpenCode(filePath); break;
      default: session = parseClaude(filePath); break;
    }
  } finally {
    if (full) setContentTruncation(true);
  }
  if (session && !session.path) session.path = filePath;
  return attachSessionHash(session);
}

/** The resolved cursor-cloud import root may live anywhere (env override), so
 * it must be sniffed before the generic `.cursor/` substring match. */
function isUnderCursorCloudRoot(filePath) {
  const root = resolveCursorCloudRoot();
  return filePath.startsWith(root.endsWith(sep) ? root : root + sep);
}

function detectSource(filePath) {
  if (filePath.startsWith("opencode://")) return "opencode";
  if (filePath.includes(".codex/")) return "codex";
  if (isUnderCursorCloudRoot(filePath)) return "cursor-cloud";
  if (filePath.includes(".cursor/")) return "cursor";
  if (filePath.includes(".factory/")) return "factory";
  if (filePath.includes(".grok/")) return "grok";
  return "claude";
}
