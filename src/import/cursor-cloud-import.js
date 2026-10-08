/**
 * `tracequest import cursor-cloud` — explicit importer for Cursor Cloud
 * Agents.
 *
 * Two disjoint transports (facts cckey, ccax): with no --api-key and no
 * CURSOR_API_KEY the importer reads this machine's local Cursor session token
 * (fact ccak) and takes the keyless api2 connect-rpc route (facts cca2, ccah);
 * an explicitly supplied dashboard key selects the documented v0 API instead
 * (fact ccep). The two credentials belong to separate auth systems and are
 * never merged or cross-retried.
 *
 * All Cursor network I/O lives in this module and runs only when the user
 * invokes the import command (facts ccng, ccni). Fetched agents materialise
 * as JSONL files under the tracequest-owned cursor-cloud discovery root
 * (resolveCursorCloudRoot — fact ccrt); normal discovery/indexing then finds
 * them like any other source with no extra flag or rescan (fact ccis).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  loadDatabaseSync,
  resolveCursorCloudRoot,
} from "../sessions/session-discovery-paths.js";

/** Default v0 Cursor API base; TRACEQUEST_CURSOR_API_URL overrides it so the
 * integration test can point the v0 route at a local fixture HTTP server
 * and no tracequest test ever performs real network I/O (fact ccau). */
const DEFAULT_CURSOR_API_BASE = "https://api.cursor.com";

/** Default keyless connect-rpc base; TRACEQUEST_CURSOR_API2_URL overrides the
 * api2 route only, so one test process can stand up a separate fixture server
 * per route and prove which route a run took (facts cca2, ccau). */
const DEFAULT_CURSOR_API2_BASE = "https://api2.cursor.sh";

/** The only two api2 methods the importer ever calls (fact cca2). */
const API2_LIST_PATH = "/aiserver.v1.BackgroundComposerService/ListBackgroundComposers";
const API2_CONVERSATION_PATH = "/aiserver.v1.BackgroundComposerService/GetBackgroundComposerConversation";

export function resolveCursorApiBase() {
  return process.env.TRACEQUEST_CURSOR_API_URL || DEFAULT_CURSOR_API_BASE;
}

export function resolveCursorApi2Base() {
  return process.env.TRACEQUEST_CURSOR_API2_URL || DEFAULT_CURSOR_API2_BASE;
}

/** Same platform resolution as src/sessions/cursor-state-db.js, honouring
 * the TRACEQUEST_CURSOR_STATE_DB override (facts ccak, ccme). */
export function resolveCursorStateDbPath(home = homedir(), { platform = process.platform } = {}) {
  const override = process.env.TRACEQUEST_CURSOR_STATE_DB;
  if (override) return override;
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

export function cursorStateDbCandidates(home) {
  return [
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
}

/** Normalize a state.vscdb ItemTable value into a session token string. */
export function parseCursorAccessTokenValue(value) {
  if (value instanceof Uint8Array) value = Buffer.from(value).toString("utf8");
  if (typeof value !== "string") return null;
  value = value.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return typeof value === "string" && value ? value : null;
}

/** Open Cursor's state.vscdb read-only (cursor-state-db.js loader pattern);
 * falls back to an immutable URI when the live db is locked. Never opened
 * for writing (fact ccak). */
function openCursorStateDbReadOnly(dbPath) {
  const DatabaseSync = loadDatabaseSync();
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return new DatabaseSync(`file:${encodeURI(dbPath)}?mode=ro&immutable=1`, { readOnly: true });
  }
}

/**
 * The local credential: Cursor's own session token from state.vscdb ItemTable
 * key cursorAuth/accessToken (fact ccak). Read lazily at request time, never
 * cached to disk, never logged (fact ccse). Returns null when it cannot be
 * read for any reason — the caller turns that into the actionable die of
 * fact cckey.
 */
export function loadLocalCursorSessionToken(home = homedir(), { dbPath } = {}) {
  try {
    const db = openCursorStateDbReadOnly(dbPath || resolveCursorStateDbPath(home));
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
      return parseCursorAccessTokenValue(row?.value);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Actionable message for "no explicit key and no local token" (fact cckey).
 * Names where it looked plus both opt-in credentials; carries no secret. */
function noCredentialMessage() {
  return [
    "No Cursor credential found.",
    `Looked for the local Cursor session token in ${resolveCursorStateDbPath()} (ItemTable key cursorAuth/accessToken).`,
    "Sign in to Cursor so the session token exists, or pass --api-key <key> or set the CURSOR_API_KEY environment variable to use the documented v0 API.",
  ].join("\n");
}

/** Fatal 401 (fact ccxp): the local session token expired or was revoked.
 * The token itself never appears in the message (fact ccse). */
function unauthenticatedMessage() {
  return [
    "Cursor rejected the local session token (HTTP 401 unauthenticated).",
    "Sign in again in Cursor to refresh it, or pass --api-key <key> / set CURSOR_API_KEY to import over the documented v0 API instead.",
  ].join("\n");
}

function authError() {
  const err = new Error(unauthenticatedMessage());
  err.fatalAuth = true;
  return err;
}

/** GET a v0 endpoint with Bearer auth; non-2xx throws with err.status set. */
async function fetchJson(url, apiKey) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    if (res.status === 401) throw authError();
    const err = new Error(`GET ${url} failed: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * POST one connect-rpc method on api2 with exactly two headers — Content-Type
 * and authorization Bearer — and nothing else: no cookie, no Origin, no
 * Connect-Protocol-Version (facts cca2, ccah). Responses are read in full via
 * res.json(), so multi-megabyte conversations are never truncated (fact cccv).
 */
async function postApi2(path, body, token, base = resolveCursorApi2Base()) {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let code = null;
    try {
      code = (await res.json())?.code ?? null;
    } catch {
      code = null;
    }
    // 401 {"code":"unauthenticated"} is fatal for the run (fact ccxp);
    // 404 {"code":"not_found"} is a per-agent skip (fact cc44).
    if (res.status === 401 || code === "unauthenticated") throw authError();
    const err = new Error(`POST ${path} failed: HTTP ${res.status}`);
    err.status = res.status;
    err.code = code;
    throw err;
  }
  return res.json();
}

/** Enumerate all cloud agents on the v0 route: GET /v0/agents?limit=100,
 * following nextCursor until the response omits it (fact ccep). */
export async function listCloudAgents(apiKey, base = resolveCursorApiBase()) {
  const agents = [];
  let cursor = null;
  do {
    const url = new URL("/v0/agents", base);
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const page = await fetchJson(url.toString(), apiKey);
    if (Array.isArray(page?.agents)) agents.push(...page.agents);
    cursor = page?.nextCursor || null;
  } while (cursor);
  return agents;
}

/**
 * Enumerate all cloud agents on the keyless route (fact ccpg):
 * {"n":100,"includeArchived":true,"includeStatus":true}, following
 * nextPageOffset via lastMessageActivityAtMsOffset. The offset boundary is
 * INCLUSIVE so the boundary composer repeats on the next page — dedupe by
 * bcId. An absent hasMore or nextPageOffset ends the walk (proto3 omits
 * false/0).
 */
export async function listCloudAgentsApi2(token, base = resolveCursorApi2Base()) {
  const composers = [];
  const seen = new Set();
  let offset = null;
  for (;;) {
    const body = { n: 100, includeArchived: true, includeStatus: true };
    if (offset != null) body.lastMessageActivityAtMsOffset = offset;
    const page = await postApi2(API2_LIST_PATH, body, token, base);
    const batch = Array.isArray(page?.composers) ? page.composers : [];
    for (const composer of batch) {
      const bcId = composer?.bcId;
      if (typeof bcId !== "string" || !bcId || seen.has(bcId)) continue;
      seen.add(bcId);
      composers.push(composer);
    }
    const next = page?.nextPageOffset;
    if (!page?.hasMore || next == null || next === offset) break;
    offset = next;
  }
  return composers;
}

/** One agent's transcript (fact cccv): body is the single field bcId, the
 * response is the unpaginated chronological conversation array. */
export async function fetchCloudConversationApi2(bcId, token, base = resolveCursorApi2Base()) {
  const payload = await postApi2(API2_CONVERSATION_PATH, { bcId }, token, base);
  return Array.isArray(payload?.conversation) ? payload.conversation : [];
}

/** Project slug from the agent's repository: trailing owner/name with
 * "/" -> "-", tolerating both observed schemes (https://github.com/org/repo
 * and github.com/org/repo -> org-repo); literal fallback "cursor-cloud"
 * when the repository is absent or unparseable (fact ccly). */
export function cursorCloudProjectSlug(repository) {
  if (typeof repository !== "string" || !repository) return "cursor-cloud";
  const parts = repository.replace(/\/+$/, "").split("/").filter(Boolean);
  if (parts.length < 2) return "cursor-cloud";
  const name = parts[parts.length - 1].replace(/\.git$/, "");
  const owner = parts[parts.length - 2];
  if (!owner || !name) return "cursor-cloud";
  return `${owner}-${name}`;
}

/**
 * Fail-soft enrichment map bcId -> { model?, updatedAt? } from Cursor's local
 * state.vscdb ItemTable key cloudAgentRepository.agents.<authUser>: each value
 * is a JSON array of agent rows carrying modelDetails.modelName and an
 * updatedAt in epoch milliseconds (converted to ISO-8601 — fact ccml).
 * Any failure (missing DB, missing key, bad JSON) returns null and the
 * import proceeds without enrichment. v0 route only (fact ccme).
 */
export function loadCloudAgentEnrichment() {
  try {
    const db = openCursorStateDbReadOnly(resolveCursorStateDbPath());
    try {
      const rows = db
        .prepare("SELECT value FROM ItemTable WHERE key LIKE 'cloudAgentRepository.agents.%'")
        .all();
      const byId = new Map();
      for (const row of rows) {
        let entries;
        try {
          entries = JSON.parse(row.value);
        } catch {
          continue;
        }
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (!entry || typeof entry.bcId !== "string" || !entry.bcId) continue;
          const modelName = entry.modelDetails?.modelName;
          const enriched = {};
          if (typeof modelName === "string" && modelName) enriched.model = modelName;
          if (Number.isFinite(entry.updatedAt)) {
            enriched.updatedAt = new Date(entry.updatedAt).toISOString();
          }
          byId.set(entry.bcId, enriched);
        }
      }
      return byId;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Line 1 of every v0-route file (fact ccml): required bcId/name/status/
 * createdAt (createdAt is the API list value verbatim), optional fields
 * simply omitted when absent. Unknown status strings are stored verbatim
 * (fact ccvb). */
export function buildSessionMeta(agent, enriched) {
  const meta = {
    type: "session_meta",
    bcId: agent.id,
    name: agent.name,
    status: agent.status,
    createdAt: agent.createdAt,
  };
  if (enriched?.updatedAt) meta.updatedAt = enriched.updatedAt;
  const repository = agent.source?.repository;
  if (repository) meta.repository = repository;
  if (agent.source?.ref) meta.ref = agent.source.ref;
  if (agent.target?.branchName) meta.branchName = agent.target.branchName;
  if (agent.target?.prUrl) meta.prUrl = agent.target.prUrl;
  if (agent.target?.url) meta.url = agent.target.url;
  if (enriched?.model) meta.model = enriched.model;
  return meta;
}

/** Epoch milliseconds (JSON number or numeric string) -> ISO-8601, or null
 * when the value is missing or unusable (fail soft — fact ccdf). */
function msToIso(ms) {
  const n = typeof ms === "string" ? Number(ms) : ms;
  if (!Number.isFinite(n) || n <= 0) return null;
  const iso = new Date(n).toISOString();
  return iso === "Invalid Date" ? null : iso;
}

/**
 * Line 1 of every keyless-route file (fact ccml): every value comes from the
 * agent's LIST entry — createdAt/updatedAt are ISO-8601 conversions of
 * createdAtMs/updatedAtMs, status is the string enum verbatim, model is
 * modelDetails.modelName, repository is repoUrl verbatim (either scheme).
 */
export function buildSessionMetaFromComposer(composer) {
  const meta = {
    type: "session_meta",
    bcId: composer.bcId,
    name: composer.name,
    status: composer.status,
    createdAt: msToIso(composer.createdAtMs),
  };
  const updatedAt = msToIso(composer.updatedAtMs);
  if (updatedAt) meta.updatedAt = updatedAt;
  if (composer.repoUrl) meta.repository = composer.repoUrl;
  if (composer.branchName) meta.branchName = composer.branchName;
  if (composer.prUrl) meta.prUrl = composer.prUrl;
  const model = composer.modelDetails?.modelName;
  if (typeof model === "string" && model) meta.model = model;
  return meta;
}

/** user_message -> user, assistant_message -> assistant in the Cursor CLI
 * row shape consumed unchanged by the Cursor-family indexers (fact ccmr). */
export function mapConversationMessage(message) {
  const role = message?.type === "user_message"
    ? "user"
    : message?.type === "assistant_message"
      ? "assistant"
      : null;
  if (!role) return null;
  const text = typeof message.text === "string" ? message.text : "";
  return { role, message: { content: [{ type: "text", text }] } };
}

/**
 * api2 toolName -> the tool vocabulary the local Cursor CLI already writes.
 * Keys are the toolName values present in the recorded fixture
 * (test/helpers/cursor-cloud-api2-fixtures.js); read_file and search_replace
 * land on the CURSOR_PATH_TOOLS names so their file path is tracked from
 * input.path. Any toolName with no alias passes through verbatim — a
 * fidelity degradation, never an error (fact cctb).
 */
const API2_TOOL_ALIASES = {
  read_file: "Read",
  search_replace: "StrReplace",
  run_terminal_cmd: "Shell",
  grep: "Grep",
  glob_file_search: "Glob",
  task_v2: "Task",
  mcp: "CallMcpTool",
  get_mcp_tools: "GetMcpTools",
};

export function aliasCursorCloudToolName(toolName) {
  if (typeof toolName !== "string" || !toolName) return null;
  return API2_TOOL_ALIASES[toolName.toLowerCase()] || toolName;
}

function parseMaybeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstString(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return null;
}

/**
 * The tool_use input: the observed argument keys reduced to the few the
 * Cursor-family indexers and renderers read — path (file tracking via
 * CURSOR_PATH_TOOLS), command (git-commit counting), pattern, description.
 * Unknown or missing argument shapes simply yield fewer keys (fact ccdf).
 */
function buildToolInput(toolResult) {
  const call = toolResult?.toolCall && typeof toolResult.toolCall === "object" ? toolResult.toolCall : {};
  const rawArgs = parseMaybeJsonObject(toolResult?.rawArgs) || parseMaybeJsonObject(call.rawArgs) || {};
  const input = {};
  const path = firstString(
    rawArgs.target_file,
    rawArgs.path,
    rawArgs.file_path,
    call.readFileParams?.relativeWorkspacePath,
    call.editFileParams?.relativeWorkspacePath,
  );
  if (path) input.path = path;
  const command = firstString(rawArgs.command, call.runTerminalCommandV2Params?.command);
  if (command) input.command = command;
  const pattern = firstString(
    rawArgs.pattern,
    call.ripgrepSearchParams?.patternInfo?.pattern,
    call.globFileSearchParams?.globPattern,
    call.getMcpToolsParams?.pattern,
  );
  if (pattern) input.pattern = pattern;
  const description = firstString(rawArgs.description, call.taskV2Params?.description);
  if (description) input.description = description;
  return input;
}

/** One toolResults entry -> a tool_use content block whose "type" key is
 * immediately followed by "name" (both the JS accumulateToolUse regex and the
 * Rust TOOL_USE_NAME_RE stop at a closing brace) and then input (fact cctb). */
export function mapToolResultBlock(toolResult) {
  const name = aliasCursorCloudToolName(toolResult?.toolName ?? toolResult?.toolCall?.name);
  if (!name) return null;
  return { type: "tool_use", name, input: buildToolInput(toolResult) };
}

/**
 * One api2 conversation message -> at most one Cursor CLI row (facts ccmr,
 * cctx, cctb, ccdm): role is the FIRST key, text and thinking merge into ONE
 * text block, assistant toolResults become tool_use blocks, and a message
 * with no text, no thinking, and no mappable toolResults is dropped. Rows
 * with role "tool" are never emitted (neither indexer consumes them).
 */
export function mapApi2ConversationMessage(message) {
  const type = message?.type;
  const role = type === "MESSAGE_TYPE_HUMAN" ? "user" : type === "MESSAGE_TYPE_AI" ? "assistant" : null;
  if (!role) return null;
  const text = typeof message.text === "string" ? message.text.trim() : "";
  const thinking = typeof message.thinking?.text === "string" ? message.thinking.text.trim() : "";
  const content = [];
  const merged = text && thinking ? `${text}\n\n${thinking}` : text || thinking;
  if (merged) content.push({ type: "text", text: merged });
  if (role === "assistant" && Array.isArray(message.toolResults)) {
    for (const toolResult of message.toolResults) {
      const block = mapToolResultBlock(toolResult);
      if (block) content.push(block);
    }
  }
  if (!content.length) return null;
  const row = { role, message: { content } };
  if (typeof message.bubbleId === "string" && message.bubbleId) row.bubbleId = message.bubbleId;
  return row;
}

/** Read an existing imported file's session_meta and message-line count;
 * null when the file is absent or its first line is not session_meta. */
function readExistingSession(filePath) {
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (!lines.length) return null;
  let meta;
  try {
    meta = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (!meta || meta.type !== "session_meta") return null;
  return { meta, messageLineCount: lines.length - 1 };
}

/** Idempotency (fact ccid): same createdAt + same optional updatedAt
 * (both-absent compares equal) + same message-line count => skip. Applies
 * only to agents whose conversation was actually fetched; agents resolved
 * from the list response alone never reach it (fact ccin). */
function isUnchanged(existing, meta, messageCount) {
  return (
    existing.meta.createdAt === meta.createdAt &&
    (existing.meta.updatedAt ?? null) === (meta.updatedAt ?? null) &&
    existing.messageLineCount === messageCount
  );
}

/**
 * The incremental fetch decision (fact ccin), taken from the LIST response
 * alone — no conversation request is issued when this returns true.
 *
 * It is deliberately strict in the opposite direction from isUnchanged:
 * both sides must carry a non-empty updatedAt and the two ISO-8601 strings
 * (the exact representation written into session_meta) must be equal, plus
 * createdAt must match. Everything else — no local file, an unreadable or
 * corrupt one, a first line that is not session_meta (all of which make
 * readExistingSession return null), or an absent/differing timestamp on
 * either side — falls through to a fetch, because correctness beats speed.
 */
function isUnchangedFromList(existing, meta) {
  if (!existing) return false;
  const local = existing.meta?.updatedAt;
  const remote = meta?.updatedAt;
  if (typeof local !== "string" || !local) return false;
  if (typeof remote !== "string" || !remote) return false;
  if (local !== remote) return false;
  return existing.meta.createdAt === meta.createdAt;
}

/** Atomic write (temp file + rename) so discovery never observes a
 * half-written session (fact ccly). */
function writeSessionFileAtomically(filePath, rows) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(tmpPath, payload);
  renameSync(tmpPath, filePath);
}

/** v0 route plan: one entry per listed agent, each able to fetch and map its
 * own conversation (fact ccep). */
async function planV0Route(apiKey) {
  const base = resolveCursorApiBase();
  const agents = await listCloudAgents(apiKey, base);
  // state.vscdb enrichment applies to the v0 route only (fact ccme).
  const enrichment = loadCloudAgentEnrichment();
  return agents.map((agent) => ({
    id: agent?.id,
    slug: cursorCloudProjectSlug(agent?.source?.repository),
    meta: () => buildSessionMeta(agent, enrichment?.get(agent?.id) ?? null),
    fetchRows: async () => {
      // Agent ids are used verbatim in conversation URLs (fact ccvb).
      const conversation = await fetchJson(
        new URL(`/v0/agents/${agent.id}/conversation`, base).toString(),
        apiKey,
      );
      const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
      return messages.map(mapConversationMessage).filter(Boolean);
    },
  }));
}

/** Keyless api2 route plan; the conversations that survive the incremental
 * decision of fact ccin are then fetched with the bounded concurrency of
 * fact cccv. */
async function planApi2Route(token) {
  const base = resolveCursorApi2Base();
  const composers = await listCloudAgentsApi2(token, base);
  return composers.map((composer) => ({
    id: composer?.bcId,
    slug: cursorCloudProjectSlug(composer?.repoUrl),
    meta: () => buildSessionMetaFromComposer(composer),
    fetchRows: async () => {
      const conversation = await fetchCloudConversationApi2(composer.bcId, token, base);
      return conversation.map(mapApi2ConversationMessage).filter(Boolean);
    },
  }));
}

/**
 * Maximum conversation requests in flight at any instant (fact cccv).
 * Deliberately modest: api2 is an undocumented internal backend with no
 * rate-limit headers and no documented quota, so this is the largest
 * speed-up defensible without server cooperation. Never unbounded.
 */
export const CURSOR_CLOUD_FETCH_CONCURRENCY = 4;

/**
 * Run the import. Returns { checked, fetched, imported, updated, skipped,
 * failed } (fact ccsm).
 *
 * Two phases. Phase 1 walks the list response and decides locally which
 * agents need their transcript at all (fact ccin) — an agent whose local
 * session_meta.updatedAt already equals the remote one costs zero network
 * requests. Phase 2 downloads only the remainder, at most
 * CURSOR_CLOUD_FETCH_CONCURRENCY at a time (fact cccv). `full` bypasses
 * phase 1's skip entirely (fact ccfu).
 *
 * --dry-run performs exactly the same requests over the selected route but
 * writes no files and creates no directories under the root (fact ccdry).
 * A 404 conversation is skip-with-warning naming the agent id; any other
 * per-agent error counts as failed without aborting the run (fact cc44);
 * a 401 aborts the whole run with an actionable message (fact ccxp).
 */
export async function runCursorCloudImport({
  apiKey,
  dryRun = false,
  full = false,
  out = (line) => console.log(line),
  warn = (line) => console.error(line),
} = {}) {
  // Credential source selects the route; the two auth systems are never
  // merged and never cross-retried (facts cckey, ccax).
  let token = null;
  if (!apiKey) {
    token = loadLocalCursorSessionToken();
    if (!token) throw new Error(noCredentialMessage());
  }

  const root = resolveCursorCloudRoot();
  const summary = { checked: 0, fetched: 0, imported: 0, updated: 0, skipped: 0, failed: 0 };
  const plan = apiKey ? await planV0Route(apiKey) : await planApi2Route(token);
  summary.checked = plan.length;

  // Phase 1 — decide from the list response alone (fact ccin). Every action
  // line is printed the moment its agent is decided (fact ccpr).
  const pending = [];
  for (const entry of plan) {
    const id = entry.id;
    if (typeof id !== "string" || !id) {
      summary.failed += 1;
      warn("warning: agent without an id in the list response — counted as failed");
      continue;
    }
    let meta;
    try {
      meta = entry.meta();
    } catch (err) {
      warn(`warning: agent ${id}: ${err?.message || err} — counted as failed`);
      summary.failed += 1;
      continue;
    }
    // Agent ids are used verbatim as <agentId>.jsonl filenames (fact ccvb).
    const filePath = join(root, entry.slug, `${id}.jsonl`);
    const existing = readExistingSession(filePath);
    if (!full && isUnchangedFromList(existing, meta)) {
      out(`skip ${id} (unchanged)`);
      summary.skipped += 1;
      continue;
    }
    pending.push({ entry, id, meta, filePath, existing });
  }

  // The whole plan, printed before a single conversation request goes out so
  // a long run never looks hung (fact ccpr).
  const bound = Math.max(1, Math.min(CURSOR_CLOUD_FETCH_CONCURRENCY, pending.length || 1));
  out(
    `checked ${summary.checked} agents: ${summary.skipped} unchanged, ${pending.length} to fetch` +
      (pending.length ? ` (up to ${bound} at a time)` : ""),
  );

  /** Fetch + write one agent; never throws except to abort on a fatal 401. */
  const processOne = async (task) => {
    const { entry, id, meta, filePath, existing } = task;
    let rows;
    summary.fetched += 1;
    try {
      rows = await entry.fetchRows();
    } catch (err) {
      if (err?.fatalAuth) throw err;
      if (err?.status === 404 || err?.code === "not_found") {
        warn(`warning: agent ${id}: conversation not found (404, deleted remotely?) — skipping`);
        out(`skip ${id} (conversation deleted remotely)`);
        summary.skipped += 1;
      } else {
        warn(`warning: agent ${id}: ${err?.message || err} — counted as failed`);
        summary.failed += 1;
      }
      return;
    }
    try {
      const action = !existing
        ? "import"
        : isUnchanged(existing, meta, rows.length)
          ? "skip"
          : "update";
      out(`${action} ${id} -> ${join(entry.slug, `${id}.jsonl`)}`);
      if (action === "skip") {
        // Skip the write entirely: mtime untouched, so strict mtime-equality
        // staleness means buildIndex does not re-index (fact ccid).
        summary.skipped += 1;
        return;
      }
      if (!dryRun) writeSessionFileAtomically(filePath, [meta, ...rows]);
      if (action === "import") summary.imported += 1;
      else summary.updated += 1;
    } catch (err) {
      warn(`warning: agent ${id}: ${err?.message || err} — counted as failed`);
      summary.failed += 1;
    }
  };

  // Phase 2 — a fixed pool of at most `bound` workers pulling from one queue:
  // bounded concurrency, never a fan-out over the whole list (fact cccv).
  let next = 0;
  let fatal = null;
  const worker = async () => {
    while (next < pending.length && !fatal) {
      const task = pending[next++];
      try {
        await processOne(task);
      } catch (err) {
        // A 401 aborts the whole run (fact ccxp); in-flight peers finish
        // their current task and no further work is scheduled.
        fatal ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: bound }, worker));
  if (fatal) throw fatal;

  return summary;
}
