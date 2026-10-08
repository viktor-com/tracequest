/**
 * Fan-in remaining-window collection across installed harnesses.
 * HOME-parameterized. Never throws the whole run. Never executes a
 * harness binary.
 */
import { homedir } from "node:os";
import { HARNESS_TIMEOUT_MS, defaultReadFile, harnessRow } from "./http.js";
import { collectClaudeUsage } from "./collect-claude.js";
import { collectCodexUsage } from "./collect-codex.js";
import { collectCursorUsage } from "./collect-cursor.js";
import { collectGrokUsage } from "./collect-grok.js";
import { validateSnapshotShape } from "./snapshot.js";

export const UNAVAILABLE_HARNESSES = Object.freeze(["factory", "opencode", "gemini"]);

function unavailableRow(id) {
  return harnessRow({
    id,
    status: "unavailable",
    message: "no remaining-window collector",
  });
}

function asRow(id, value) {
  if (value && typeof value === "object" && value.id === id && value.status) return value;
  return harnessRow({ id, status: "error", message: value?.message || "collector failed" });
}

export async function collectUsageLimits({
  home = homedir(),
  host = null,
  fetchImpl = fetch,
  now = () => new Date(),
  readFile = defaultReadFile,
  readCursorToken,
  credentials = null,
  timeoutMs = HARNESS_TIMEOUT_MS,
} = {}) {
  const creds = credentials || {};
  const collectedAt = (typeof now === "function" ? now() : now).toISOString();

  const settled = await Promise.allSettled([
    collectClaudeUsage({
      home,
      fetchImpl,
      readFile,
      credentialText: creds.claudeJson ?? null,
      timeoutMs,
    }),
    collectCodexUsage({
      home,
      fetchImpl,
      readFile,
      credentialText: creds.codexJson ?? null,
      timeoutMs,
    }),
    collectCursorUsage({
      home,
      fetchImpl,
      readCursorToken,
      cursorToken: creds.cursorToken ?? null,
      timeoutMs,
    }),
    collectGrokUsage({
      home,
      fetchImpl,
      readFile,
      credentialText: creds.grokAuthJson ?? null,
      timeoutMs,
    }),
  ]);

  const ids = ["claude", "codex", "cursor", "grok"];
  const harnesses = ids.map((id, i) => {
    const item = settled[i];
    if (item.status === "fulfilled") return asRow(id, item.value);
    return harnessRow({
      id,
      status: "error",
      message: item.reason?.message || "collector failed",
    });
  });
  for (const id of UNAVAILABLE_HARNESSES) harnesses.push(unavailableRow(id));

  return validateSnapshotShape({
    collectedAt,
    host: host ?? null,
    harnesses,
  });
}
