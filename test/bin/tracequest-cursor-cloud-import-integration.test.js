/**
 * Automated harness for tests/cursor-cloud-import-integration.md — the
 * explicit `tracequest import cursor-cloud` importer (facts ccim, cckey,
 * ccdry, ccsm, ccis, cca2, ccah, ccax, ccpg, cccv, ccdf, ccep, ccau, cc44,
 * ccvb, ccak, ccse, ccxp, ccly, ccml, ccmr, cctx, cctb, ccdm, ccid, ccme).
 *
 * Real bin/tracequest.js invocations; TWO local node:http fixture servers —
 * the keyless api2 connect-rpc route via TRACEQUEST_CURSOR_API2_URL and the
 * documented v0 route via TRACEQUEST_CURSOR_API_URL — plus a fixture
 * state.vscdb via TRACEQUEST_CURSOR_STATE_DB holding a fake
 * cursorAuth/accessToken. Temp HOME + TRACEQUEST_CURSOR_CLOUD_DIR. No real
 * network I/O and no real user credential, ever (fact ccfd).
 */
import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp } from "../helpers/fixtures.js";
import { loadDatabaseSync } from "../../src/sessions/session-discovery-paths.js";
import { indexCursorCloudJsonl } from "../../src/sessions/session-index-jsonl.js";
import { CURSOR_CLOUD_FETCH_CONCURRENCY } from "../../src/import/cursor-cloud-import.js";
import {
  FIXTURE_PATH,
  RECORDED_TOOL_NAMES,
  api2AiMessage,
  api2Composer,
  api2Conversation,
  api2HumanMessage,
  api2ListResponse,
  api2ToolResult,
} from "../helpers/cursor-cloud-api2-fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const API_KEY = "key_cursor_cloud_fixture";
/** Fake local session token; distinctive so leak assertions are meaningful. */
const SESSION_TOKEN = "fixture-session-token-must-never-be-printed-8f21";
/** Slug derived from the recorded fixture repoUrl. */
const SLUG = "placeholder-org-placeholder-repo";

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runBin(args, { env = {}, timeoutMs = 30_000, expectCode = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TRACEQUEST_NO_SIDECAR: "1",
        TRACEQUEST_SKIP_LR_WATCH: "1",
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`bin timeout after ${timeoutMs}ms: ${args.join(" ")}`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== expectCode) {
        reject(
          new Error(
            `bin ${args.join(" ")} expected exit ${expectCode}, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve({ code, stdout, stderr });
    });
  });
}

function cloudAgent(id, overrides = {}) {
  return {
    id,
    name: `Agent ${id}`,
    status: "FINISHED",
    createdAt: "2026-07-01T10:00:00.000Z",
    source: { repository: "https://github.com/org/repo", ref: "main" },
    target: {
      branchName: `cursor/${id}`,
      url: `https://cursor.com/agents?id=${id}`,
      prUrl: `https://github.com/org/repo/pull/7`,
    },
    ...overrides,
  };
}

function conversationOf(id, texts = ["cloud user prompt", "cloud assistant reply"]) {
  return {
    id,
    messages: texts.map((text, i) => ({
      id: `msg-${id}-${i}`,
      type: i % 2 === 0 ? "user_message" : "assistant_message",
      text,
    })),
  };
}

/**
 * Local Cursor v0 API fixture: paginated GET /v0/agents (limit/cursor) and
 * GET /v0/agents/{id}/conversation with per-id status overrides. Records
 * every request so tests can assert auth headers and pagination.
 */
function startCursorApiFixture({ pages = [{ agents: [] }], conversations = {}, conversationStatus = {} } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const record = {
      method: req.method,
      path: url.pathname,
      limit: url.searchParams.get("limit"),
      cursor: url.searchParams.get("cursor"),
      auth: req.headers.authorization || null,
    };
    requests.push(record);
    const sendJson = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (record.auth !== `Bearer ${API_KEY}`) {
      sendJson(401, { error: "unauthorized" });
      return;
    }
    if (url.pathname === "/v0/agents") {
      const pageIndex = record.cursor ? Number(record.cursor.replace("page-", "")) : 0;
      const page = pages[pageIndex] || { agents: [] };
      const body = { agents: page.agents };
      if (pageIndex + 1 < pages.length) body.nextCursor = `page-${pageIndex + 1}`;
      sendJson(200, body);
      return;
    }
    const convoMatch = url.pathname.match(/^\/v0\/agents\/(.+)\/conversation$/);
    if (convoMatch) {
      const id = decodeURIComponent(convoMatch[1]);
      const status = conversationStatus[id];
      if (status) {
        sendJson(status, { error: `conversation ${status}` });
        return;
      }
      const convo = conversations[id];
      if (!convo) {
        sendJson(404, { error: "not found" });
        return;
      }
      sendJson(200, convo);
      return;
    }
    sendJson(500, { error: `unexpected path ${url.pathname}` });
  });
  return listen(server, requests);
}

/**
 * Local api2 connect-rpc fixture (fact cca2): POST
 * /aiserver.v1.BackgroundComposerService/{ListBackgroundComposers,
 * GetBackgroundComposerConversation}. `listPages` is a list of response
 * objects served in order; `conversations` maps bcId -> response payload.
 * Records method, headers, and parsed body of every request.
 */
function startCursorApi2Fixture({
  listPages = [api2ListResponse([])],
  conversations = {},
  conversationStatus = {},
  token = SESSION_TOKEN,
  alwaysUnauthenticated = false,
  conversationDelayMs = 0,
} = {}) {
  const requests = [];
  let listCalls = 0;
  // Max simultaneous in-flight conversation requests, so a test can prove the
  // importer fans out but never beyond CURSOR_CLOUD_FETCH_CONCURRENCY (cccv).
  const stats = { maxConvoInFlight: 0 };
  let convoInFlight = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      let body = null;
      try {
        body = JSON.parse(raw || "null");
      } catch {
        body = null;
      }
      const record = {
        method: req.method,
        path: url.pathname,
        headers: req.headers,
        auth: req.headers.authorization || null,
        body,
      };
      requests.push(record);
      const sendJson = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      // api2 authenticates with the bearer header only; anything else is
      // 401 {"code":"unauthenticated"} (facts ccah, ccxp).
      if (alwaysUnauthenticated || record.auth !== `Bearer ${token}`) {
        sendJson(401, { code: "unauthenticated", message: "ERROR_NOT_LOGGED_IN" });
        return;
      }
      if (url.pathname.endsWith("/ListBackgroundComposers")) {
        const page = listPages[Math.min(listCalls, listPages.length - 1)];
        listCalls += 1;
        sendJson(200, page);
        return;
      }
      if (url.pathname.endsWith("/GetBackgroundComposerConversation")) {
        convoInFlight += 1;
        if (convoInFlight > stats.maxConvoInFlight) stats.maxConvoInFlight = convoInFlight;
        const reply = (status, payload) => {
          const send = () => {
            convoInFlight -= 1;
            sendJson(status, payload);
          };
          if (conversationDelayMs > 0) setTimeout(send, conversationDelayMs);
          else send();
        };
        const bcId = body?.bcId;
        const status = conversationStatus[bcId];
        if (status === 404) {
          reply(404, { code: "not_found", message: "background composer not found" });
          return;
        }
        if (status) {
          reply(status, { code: "internal", message: "boom" });
          return;
        }
        const convo = conversations[bcId];
        if (!convo) {
          reply(404, { code: "not_found", message: "background composer not found" });
          return;
        }
        reply(200, convo);
        return;
      }
      sendJson(500, { code: "internal", message: `unexpected path ${url.pathname}` });
    });
  });
  return listen(server, requests, stats);
}

function listen(server, requests, stats = { maxConvoInFlight: 0 }) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      let closed = false;
      resolve({
        server,
        requests,
        stats,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => {
          if (closed) return Promise.resolve();
          closed = true;
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

/**
 * v0-route env (fact cctr): CURSOR_API_KEY stays set and
 * TRACEQUEST_CURSOR_STATE_DB points at an absent db, so no local token is
 * derivable and the run provably takes the documented v0 route.
 */
function makeImportEnv(home, root, baseUrl, extra = {}) {
  return {
    HOME: home,
    TRACEQUEST_CURSOR_CLOUD_DIR: root,
    TRACEQUEST_CURSOR_API_URL: baseUrl,
    TRACEQUEST_CURSOR_STATE_DB: join(home, "absent-state.vscdb"),
    CURSOR_API_KEY: API_KEY,
    ...extra,
  };
}

/** Keyless-route env: no key anywhere, api2 base pointed at the fixture, and
 * a fixture state.vscdb holding the fake cursorAuth/accessToken. */
function makeKeylessEnv(home, root, api2BaseUrl, dbPath, extra = {}) {
  return {
    HOME: home,
    TRACEQUEST_CURSOR_CLOUD_DIR: root,
    TRACEQUEST_CURSOR_API2_URL: api2BaseUrl,
    TRACEQUEST_CURSOR_STATE_DB: dbPath,
    CURSOR_API_KEY: "",
    ...extra,
  };
}

function readJsonlLines(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writeStateDbFixture(dbPath, agents) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cloudAgentRepository.agents.user@example.com",
      JSON.stringify(agents),
    );
  } finally {
    db.close();
  }
}

/** Tiny synthetic credential store: one ItemTable row holding a FAKE
 * cursorAuth/accessToken — never the developer's own token (fact ccfd). */
function writeCredentialDbFixture(dbPath, token = SESSION_TOKEN) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
    db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)").run(
      "cursorAuth/accessToken",
      token,
    );
  } finally {
    db.close();
  }
}

test("import with an unknown source dies", async () => {
  const home = mkTmp("tq-cc-import-unknown-");
  try {
    const env = { HOME: home };
    const missing = await runBin(["import"], { env, expectCode: 1 });
    assert.match(stripAnsi(missing.stderr), /cursor-cloud/);

    const unknown = await runBin(["import", "nope"], { env, expectCode: 1 });
    assert.match(stripAnsi(unknown.stderr), /Unknown import source: nope/);
    assert.match(stripAnsi(unknown.stderr), /cursor-cloud/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import help lists usage and options", async () => {
  const home = mkTmp("tq-cc-import-help-");
  try {
    const { stdout } = await runBin(["import", "--help"], { env: { HOME: home } });
    const help = stripAnsi(stdout);
    assert.match(help, /import <source>/);
    assert.match(help, /cursor-cloud/);
    assert.match(help, /import Options:/);
    assert.match(help, /--dry-run/);
    // The incremental-import escape hatch is discoverable (fact ccfu).
    assert.match(help, /--full\s+Refetch every agent/);
    assert.match(help, /--api-key <key>/);
    assert.match(help, /CURSOR_API_KEY/);
    // The key reads as OPTIONAL: the default route needs no key at all.
    assert.match(help, /Optional Cursor dashboard API key/);
    assert.match(help, /tracequest import cursor-cloud/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud imports keylessly with the local session token", async () => {
  const home = mkTmp("tq-cc-import-keyless-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-keyless")])],
    conversations: { "bc-keyless": api2Conversation() },
  });
  const v0 = await startCursorApiFixture();
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath, {
      TRACEQUEST_CURSOR_API_URL: v0.baseUrl,
    });
    const { stdout } = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(stdout), /1 imported, 0 updated, 0 skipped, 0 failed/);
    assert.equal(existsSync(join(root, SLUG, "bc-keyless.jsonl")), true);

    // Exactly the two connect-rpc POSTs, with the pinned list body (fact ccpg).
    const listCalls = api2.requests.filter((r) => r.path.endsWith("/ListBackgroundComposers"));
    const convoCalls = api2.requests.filter((r) => r.path.endsWith("/GetBackgroundComposerConversation"));
    assert.equal(listCalls.length, 1);
    assert.equal(convoCalls.length, 1);
    assert.equal(listCalls[0].method, "POST");
    assert.equal(listCalls[0].path, "/aiserver.v1.BackgroundComposerService/ListBackgroundComposers");
    assert.deepEqual(listCalls[0].body, { n: 100, includeArchived: true, includeStatus: true });
    assert.deepEqual(convoCalls[0].body, { bcId: "bc-keyless" });

    // Headers: Content-Type + authorization Bearer only — no cookie, no
    // Origin, no Connect-Protocol-Version (facts ccah, cca2).
    for (const r of api2.requests) {
      assert.equal(r.auth, `Bearer ${SESSION_TOKEN}`);
      assert.match(r.headers["content-type"], /^application\/json/);
      assert.equal(r.headers.cookie, undefined);
      assert.equal(r.headers.origin, undefined);
      assert.equal(r.headers["connect-protocol-version"], undefined);
    }
    // The v0 route was never touched (facts cckey, ccax).
    assert.equal(v0.requests.length, 0);
  } finally {
    await api2.close();
    await v0.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud dedupes the inclusive list pagination boundary by bcId", async () => {
  const home = mkTmp("tq-cc-import-dedupe-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [
      // Boundary composer bc-b is returned again on the next page.
      api2ListResponse([api2Composer("bc-a"), api2Composer("bc-b")], {
        hasMore: true,
        nextPageOffset: 1785236253131,
      }),
      api2ListResponse([api2Composer("bc-b"), api2Composer("bc-c")]),
    ],
    conversations: {
      "bc-a": api2Conversation(),
      "bc-b": api2Conversation(),
      "bc-c": api2Conversation(),
    },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const { stdout } = await runBin(["import", "cursor-cloud"], { env });
    // Each agent imported at most once per run despite the repeat.
    assert.match(stripAnsi(stdout), /3 imported, 0 updated, 0 skipped, 0 failed/);
    const listCalls = api2.requests.filter((r) => r.path.endsWith("/ListBackgroundComposers"));
    assert.equal(listCalls.length, 2);
    assert.equal(listCalls[1].body.lastMessageActivityAtMsOffset, 1785236253131);
    // Exactly one conversation request per distinct bcId; the order is not
    // pinned because fetches run with bounded concurrency (fact cccv).
    const convoIds = convoCalls(api2).map((r) => r.body.bcId).sort();
    assert.deepEqual(convoIds, ["bc-a", "bc-b", "bc-c"]);
    // An absent hasMore/nextPageOffset ended the walk after page 2.
    for (const id of ["bc-a", "bc-b", "bc-c"]) {
      assert.equal(existsSync(join(root, SLUG, `${id}.jsonl`)), true);
    }
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud maps MESSAGE_TYPE_HUMAN and MESSAGE_TYPE_AI to cursor user and assistant rows", async () => {
  const home = mkTmp("tq-cc-import-types-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const conversation = {
    conversation: [
      api2HumanMessage("please fix the login flow", 0),
      api2AiMessage({ text: "done, pushed a branch", thinking: "checking the failing test first", index: 1 }),
      api2AiMessage({ thinking: "reasoning only, no answer yet", index: 2 }),
      // Dropped: SYSTEM, unknown type, and a bubble with nothing indexable.
      { type: "MESSAGE_TYPE_SYSTEM", bubbleId: "b-sys", text: "system note" },
      { type: "MESSAGE_TYPE_FUTURE_UNKNOWN", bubbleId: "b-unknown", text: "future note" },
      api2AiMessage({ index: 3 }),
    ],
  };
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-types")])],
    conversations: { "bc-types": conversation },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    await runBin(["import", "cursor-cloud"], { env });
    const filePath = join(root, SLUG, "bc-types.jsonl");
    const rawLines = readFileSync(filePath, "utf8").split("\n").filter((l) => l.trim());
    const lines = rawLines.map((l) => JSON.parse(l));
    // session_meta + 3 retained rows: SYSTEM, unknown, and empty are dropped.
    assert.equal(lines.length, 4);

    // role is the FIRST key and message is an object (fact ccmr).
    assert.ok(rawLines[1].startsWith('{"role":"user"'), rawLines[1]);
    assert.ok(rawLines[2].startsWith('{"role":"assistant"'), rawLines[2]);
    assert.ok(rawLines[3].startsWith('{"role":"assistant"'), rawLines[3]);
    assert.equal(lines[1].message.content[0].text, "please fix the login flow");
    assert.equal(lines[1].bubbleId, "placeholder-bubble-human-0");

    // text and thinking merge into ONE text block, text first (fact cctx).
    assert.equal(lines[2].message.content.length, 1);
    assert.deepEqual(lines[2].message.content[0], {
      type: "text",
      text: "done, pushed a branch\n\nchecking the failing test first",
    });
    assert.equal(lines[3].message.content[0].text, "reasoning only, no answer yet");

    // No {"role":"tool"} rows are ever written (fact cctb).
    assert.equal(rawLines.some((l) => l.startsWith('{"role":"tool"')), false);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud tool results become tool_use rows that produce tools and toolCounts", async () => {
  const home = mkTmp("tq-cc-import-tools-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-tools")])],
    conversations: { "bc-tools": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    await runBin(["import", "cursor-cloud"], { env });
    const filePath = join(root, SLUG, "bc-tools.jsonl");
    const raw = readFileSync(filePath, "utf8");

    // "type":"tool_use" is immediately followed by "name" so both the JS
    // accumulateToolUse regex and Rust TOOL_USE_NAME_RE can read it (cctb).
    assert.equal(raw.includes('{"type":"tool_use","name":"Read","input":{"path":'), true);
    assert.equal(raw.includes('{"type":"tool_use","name":"StrReplace","input":{"path":'), true);
    assert.equal(raw.includes('{"type":"tool_use","name":"Shell","input":{"command":'), true);
    assert.match(raw, /"type":"tool_use","name":"Grep"/);
    // Every recorded toolName produced exactly one tool_use block.
    const blocks = [...raw.matchAll(/"type":"tool_use","name":"([^"]+)"/g)].map((m) => m[1]);
    assert.equal(blocks.length, RECORDED_TOOL_NAMES.length);
    assert.deepEqual(
      [...blocks].sort(),
      ["CallMcpTool", "GetMcpTools", "Glob", "Grep", "Read", "Shell", "StrReplace", "Task"],
    );

    // The indexer lights up: toolCounts, touched files, and commit counting.
    const meta = indexCursorCloudJsonl(filePath);
    assert.ok(meta.toolCounts.Bash >= 1, JSON.stringify(meta.toolCounts));
    assert.ok(meta.toolCounts.Read >= 1);
    assert.ok(meta.toolCounts.Grep >= 1);
    assert.ok(meta.toolCounts.Edit >= 1);
    assert.ok(Array.isArray(meta.tools) && meta.tools.length >= 4);
    // Read + StrReplace both name the same placeholder path.
    assert.equal(meta.files, 1);
    assert.equal(meta.commits, 1);
    assert.equal(readFileSync(filePath, "utf8").includes(FIXTURE_PATH), true);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud writes session_meta from the keyless list response", async () => {
  const home = mkTmp("tq-cc-import-keyless-meta-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const composer = api2Composer("bc-keyless-meta", {
    createdAtMs: 1785189945415,
    updatedAtMs: 1785236253467,
    repoUrl: "github.com/placeholder-org/placeholder-repo",
    branchName: "cursor/placeholder-branch",
    prUrl: "https://github.com/placeholder-org/placeholder-repo/pull/9",
    modelDetails: { modelName: "placeholder-model", maxMode: true },
  });
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([composer])],
    conversations: { "bc-keyless-meta": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    await runBin(["import", "cursor-cloud"], { env });
    // Bare-scheme repoUrl still slugs to org-repo (fact ccly).
    const [meta] = readJsonlLines(join(root, SLUG, "bc-keyless-meta.jsonl"));
    assert.equal(meta.type, "session_meta");
    assert.equal(meta.bcId, "bc-keyless-meta");
    assert.equal(meta.name, "placeholder agent bc-keyless-meta");
    // status is the string enum stored verbatim (fact ccvb).
    assert.equal(meta.status, "BACKGROUND_COMPOSER_STATUS_FINISHED");
    // ms -> ISO-8601 for createdAt/updatedAt (fact ccml).
    assert.equal(meta.createdAt, new Date(1785189945415).toISOString());
    assert.equal(meta.updatedAt, new Date(1785236253467).toISOString());
    assert.equal(meta.repository, "github.com/placeholder-org/placeholder-repo");
    assert.equal(meta.branchName, "cursor/placeholder-branch");
    assert.equal(meta.prUrl, "https://github.com/placeholder-org/placeholder-repo/pull/9");
    // model comes from modelDetails.modelName — no state.vscdb enrichment.
    assert.equal(meta.model, "placeholder-model");
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud prefers the v0 route when --api-key is given", async () => {
  const home = mkTmp("tq-cc-import-prefer-v0-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-api2-only")])],
    conversations: { "bc-api2-only": api2Conversation() },
  });
  const v0 = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-v0-only")] }],
    conversations: { "bc-v0-only": conversationOf("bc-v0-only") },
  });
  try {
    // A perfectly usable local token exists; the explicit key still wins.
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath, {
      TRACEQUEST_CURSOR_API_URL: v0.baseUrl,
    });
    const { stdout } = await runBin(["import", "cursor-cloud", "--api-key", API_KEY], { env });
    assert.match(stripAnsi(stdout), /1 imported, 0 updated, 0 skipped, 0 failed/);
    // v0 files only; the keyless route was never touched (facts cckey, ccax).
    assert.equal(existsSync(join(root, "org-repo", "bc-v0-only.jsonl")), true);
    assert.equal(existsSync(join(root, SLUG, "bc-api2-only.jsonl")), false);
    assert.equal(api2.requests.length, 0);
    assert.ok(v0.requests.length >= 2);
    // The dashboard key is never presented to api2 and the session token is
    // never presented to v0 — the two auth systems stay disjoint.
    for (const r of v0.requests) assert.equal(r.auth, `Bearer ${API_KEY}`);

    // CURSOR_API_KEY selects v0 the same way the flag does.
    rmSync(root, { recursive: true, force: true });
    const envKeyEnv = { ...env, CURSOR_API_KEY: API_KEY };
    await runBin(["import", "cursor-cloud"], { env: envKeyEnv });
    assert.equal(existsSync(join(root, "org-repo", "bc-v0-only.jsonl")), true);
    assert.equal(api2.requests.length, 0);
  } finally {
    await api2.close();
    await v0.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud dies with an actionable message when no credential can be found", async () => {
  const home = mkTmp("tq-cc-import-nocred-");
  const root = join(home, "cursor-cloud-root");
  const missingDb = join(home, "no-such-state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-1")])],
    conversations: { "bc-1": api2Conversation() },
  });
  try {
    const env = makeKeylessEnv(home, root, api2.baseUrl, missingDb);
    const { stderr } = await runBin(["import", "cursor-cloud"], { env, expectCode: 1 });
    const text = stripAnsi(stderr);
    // Names where it looked plus both opt-in credentials (fact cckey).
    assert.match(text, /no-such-state\.vscdb/);
    assert.match(text, /cursorAuth\/accessToken/);
    assert.match(text, /--api-key/);
    assert.match(text, /CURSOR_API_KEY/);
    // Dies BEFORE performing any network request.
    assert.equal(api2.requests.length, 0);
    assert.equal(existsSync(root), false);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud dies with a re-authenticate message when the local credential is rejected", async () => {
  const home = mkTmp("tq-cc-import-401-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-401")])],
    conversations: { "bc-401": api2Conversation() },
    alwaysUnauthenticated: true,
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const { stderr } = await runBin(["import", "cursor-cloud"], { env, expectCode: 1 });
    const text = stripAnsi(stderr);
    // 401 is fatal for the whole run, with a re-auth message (fact ccxp).
    assert.match(text, /401/);
    assert.match(text, /[Ss]ign in again/);
    assert.match(text, /--api-key/);
    assert.match(text, /CURSOR_API_KEY/);
    // The importer never tried to refresh the token itself, and never
    // retried the session token against the v0 route (fact ccax).
    assert.equal(api2.requests.length, 1);
    assert.equal(text.includes(SESSION_TOKEN), false);
    assert.equal(existsSync(root), false);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud skips a keyless conversation that 404s with a warning", async () => {
  const home = mkTmp("tq-cc-import-404-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-alive"), api2Composer("bc-gone")])],
    conversations: { "bc-alive": api2Conversation() },
    conversationStatus: { "bc-gone": 404 },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    // 404 {"code":"not_found"} is never fatal (fact cc44).
    const { stdout, stderr } = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(stderr), /bc-gone/);
    assert.match(stripAnsi(stderr), /404/);
    assert.match(stripAnsi(stdout), /1 imported, 0 updated, 1 skipped, 0 failed/);
    assert.equal(existsSync(join(root, SLUG, "bc-alive.jsonl")), true);
    assert.equal(existsSync(join(root, SLUG, "bc-gone.jsonl")), false);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud never prints the credential in dry-run or error output", async () => {
  const home = mkTmp("tq-cc-import-secret-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-secret"), api2Composer("bc-boom")])],
    conversations: { "bc-secret": api2Conversation() },
    conversationStatus: { "bc-boom": 500 },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const dry = await runBin(["import", "cursor-cloud", "--dry-run"], { env, expectCode: 1 });
    const dryText = stripAnsi(dry.stdout + dry.stderr);
    // Not even truncated or masked: no substring of the token appears.
    assert.equal(dryText.includes(SESSION_TOKEN), false);
    assert.equal(dryText.includes(SESSION_TOKEN.slice(0, 12)), false);
    // The failing agent's error message carries no credential either.
    assert.match(dryText, /bc-boom/);

    const real = await runBin(["import", "cursor-cloud"], { env, expectCode: 1 });
    const realText = stripAnsi(real.stdout + real.stderr);
    assert.equal(realText.includes(SESSION_TOKEN.slice(0, 12)), false);
    // The credential is never written into an imported session file either.
    const written = readFileSync(join(root, SLUG, "bc-secret.jsonl"), "utf8");
    assert.equal(written.includes(SESSION_TOKEN.slice(0, 12)), false);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud keyless re-run skips unchanged sessions and preserves mtime", async () => {
  const home = mkTmp("tq-cc-import-keyless-rerun-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const composer = api2Composer("bc-keyless-rerun");
  const listPages = [api2ListResponse([composer])];
  const api2 = await startCursorApi2Fixture({
    listPages,
    conversations: { "bc-keyless-rerun": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const first = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(first.stdout), /1 imported, 0 updated, 0 skipped, 0 failed/);
    const filePath = join(root, SLUG, "bc-keyless-rerun.jsonl");
    const mtimeBefore = statSync(filePath).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    const second = await runBin(["import", "cursor-cloud"], { env });
    const out = stripAnsi(second.stdout);
    assert.match(out, /skip bc-keyless-rerun/);
    assert.match(out, /0 imported, 0 updated, 1 skipped, 0 failed/);
    // Skip means the write is skipped entirely: mtime untouched (fact ccid).
    assert.equal(statSync(filePath).mtimeMs, mtimeBefore);

    // A changed remote updatedAtMs rewrites the file (fact ccid).
    listPages[0] = api2ListResponse([api2Composer("bc-keyless-rerun", { updatedAtMs: 1785236299999 })]);
    const third = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(third.stdout), /0 imported, 1 updated, 0 skipped, 0 failed/);
    assert.notEqual(statSync(filePath).mtimeMs, mtimeBefore);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

/** Conversation POSTs recorded by an api2 fixture (fact ccin's unit of proof). */
function convoCalls(api2) {
  return api2.requests.filter((r) => r.path.endsWith("/GetBackgroundComposerConversation"));
}

function listCallsOf(api2) {
  return api2.requests.filter((r) => r.path.endsWith("/ListBackgroundComposers"));
}

test("import cursor-cloud issues no conversation request for an unchanged agent", async () => {
  const home = mkTmp("tq-cc-import-incremental-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-unchanged")])],
    conversations: { "bc-unchanged": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const first = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(first.stdout), /1 checked, 1 fetched, 1 imported, 0 updated, 0 skipped, 0 failed/);
    const filePath = join(root, SLUG, "bc-unchanged.jsonl");
    const mtimeBefore = statSync(filePath).mtimeMs;
    assert.equal(convoCalls(api2).length, 1);

    await new Promise((r) => setTimeout(r, 20));
    const second = await runBin(["import", "cursor-cloud"], { env });
    const out = stripAnsi(second.stdout);
    // THE core regression assertion: the second run resolved the agent from
    // the list response alone, so the fixture saw NO new conversation POST.
    assert.equal(convoCalls(api2).length, 1, "second run must issue zero conversation requests");
    assert.equal(listCallsOf(api2).length, 2, "the list request still happens on every run");
    assert.match(out, /skip bc-unchanged \(unchanged\)/);
    assert.match(out, /1 checked, 0 fetched, 0 imported, 0 updated, 1 skipped, 0 failed/);
    // No fetch also means no write: mtime untouched (facts ccin, ccid).
    assert.equal(statSync(filePath).mtimeMs, mtimeBefore);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud refetches an agent whose remote updatedAtMs changed", async () => {
  const home = mkTmp("tq-cc-import-changed-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const listPages = [api2ListResponse([api2Composer("bc-changed")])];
  const api2 = await startCursorApi2Fixture({
    listPages,
    conversations: { "bc-changed": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    await runBin(["import", "cursor-cloud"], { env });
    const filePath = join(root, SLUG, "bc-changed.jsonl");
    const mtimeBefore = statSync(filePath).mtimeMs;
    assert.equal(convoCalls(api2).length, 1);

    await new Promise((r) => setTimeout(r, 20));
    // A newer remote updatedAtMs is exactly what the list-only decision keys on.
    listPages[0] = api2ListResponse([api2Composer("bc-changed", { updatedAtMs: 1785299999999 })]);
    const second = await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 2, "a changed agent must be fetched");
    assert.deepEqual(convoCalls(api2)[1].body, { bcId: "bc-changed" });
    assert.match(stripAnsi(second.stdout), /1 checked, 1 fetched, 0 imported, 1 updated, 0 skipped, 0 failed/);
    assert.notEqual(statSync(filePath).mtimeMs, mtimeBefore);

    // The comparison is on the full-millisecond ISO-8601 form, so the
    // SMALLEST possible remote change — one millisecond — must still refetch.
    // A coarser comparison here would silently hide a changed transcript.
    listPages[0] = api2ListResponse([api2Composer("bc-changed", { updatedAtMs: 1785299999999 + 1 })]);
    await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 3, "a one-millisecond updatedAtMs delta must still refetch");

    // The remote losing updatedAtMs entirely leaves nothing to compare, so the
    // decision falls through to a fetch rather than assuming "unchanged".
    listPages[0] = api2ListResponse([api2Composer("bc-changed", { updatedAtMs: undefined })]);
    await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 4, "an absent remote updatedAtMs must force a fetch");

    // ...and a remote updatedAtMs of 0 (proto3 omits zero) is not a timestamp.
    listPages[0] = api2ListResponse([api2Composer("bc-changed", { updatedAtMs: 0 })]);
    await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 5, "a zero remote updatedAtMs must force a fetch");
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud fetches an agent that has no local file", async () => {
  const home = mkTmp("tq-cc-import-newagent-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const listPages = [api2ListResponse([api2Composer("bc-old")])];
  const api2 = await startCursorApi2Fixture({
    listPages,
    conversations: { "bc-old": api2Conversation(), "bc-new": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 1);

    listPages[0] = api2ListResponse([api2Composer("bc-old"), api2Composer("bc-new")]);
    const second = await runBin(["import", "cursor-cloud"], { env });
    // Exactly one new conversation request, and it is the new agent's.
    assert.equal(convoCalls(api2).length, 2);
    assert.deepEqual(convoCalls(api2)[1].body, { bcId: "bc-new" });
    assert.match(stripAnsi(second.stdout), /2 checked, 1 fetched, 1 imported, 0 updated, 1 skipped, 0 failed/);
    assert.equal(existsSync(join(root, SLUG, "bc-new.jsonl")), true);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud refetches when the local file is corrupt or has no session_meta", async () => {
  const home = mkTmp("tq-cc-import-corrupt-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-corrupt")])],
    conversations: { "bc-corrupt": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    await runBin(["import", "cursor-cloud"], { env });
    const filePath = join(root, SLUG, "bc-corrupt.jsonl");
    assert.equal(convoCalls(api2).length, 1);

    // Unparseable first line: correctness beats speed, so it is refetched.
    writeFileSync(filePath, "{not json at all\n");
    const second = await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 2, "a corrupt local file must force a fetch");
    // Unreadable local state also means no baseline to compare: rewritten.
    assert.match(stripAnsi(second.stdout), /1 checked, 1 fetched, 1 imported, 0 updated, 0 skipped, 0 failed/);
    assert.equal(readJsonlLines(filePath)[0].type, "session_meta");

    // Valid JSON but no session_meta line: also refetched.
    writeFileSync(filePath, JSON.stringify({ role: "user", message: { content: [] } }) + "\n");
    const third = await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 3, "a file without session_meta must force a fetch");
    assert.match(stripAnsi(third.stdout), /1 checked, 1 fetched, 1 imported, 0 updated, 0 skipped, 0 failed/);
    assert.equal(readJsonlLines(filePath)[0].type, "session_meta");

    // A truncated-to-nothing file has no first line to compare at all.
    writeFileSync(filePath, "");
    await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 4, "an empty local file must force a fetch");

    // A well-formed session_meta whose updatedAt is unusable (empty string,
    // null, or missing) offers no baseline either: fetch, never assume.
    const meta = readJsonlLines(filePath)[0];
    for (const [i, broken] of [{ ...meta, updatedAt: "" }, { ...meta, updatedAt: null }, (() => {
      const { updatedAt, ...rest } = meta;
      return rest;
    })()].entries()) {
      writeFileSync(filePath, JSON.stringify(broken) + "\n");
      await runBin(["import", "cursor-cloud"], { env });
      assert.equal(
        convoCalls(api2).length,
        5 + i,
        `an unusable local updatedAt (case ${i}) must force a fetch`,
      );
    }
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud --full refetches every agent including unchanged ones", async () => {
  const home = mkTmp("tq-cc-import-full-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-full-a"), api2Composer("bc-full-b")])],
    conversations: { "bc-full-a": api2Conversation(), "bc-full-b": api2Conversation() },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    await runBin(["import", "cursor-cloud"], { env });
    assert.equal(convoCalls(api2).length, 2);
    const filePath = join(root, SLUG, "bc-full-a.jsonl");
    const mtimeBefore = statSync(filePath).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    // Without --full this run would issue zero conversation requests.
    const full = await runBin(["import", "cursor-cloud", "--full"], { env });
    assert.equal(convoCalls(api2).length, 4, "--full refetches every listed agent");
    const out = stripAnsi(full.stdout);
    // The write-skip of fact ccid still applies to the refetched transcripts.
    assert.match(out, /skip bc-full-a -> /);
    assert.match(out, /2 checked, 2 fetched, 0 imported, 0 updated, 2 skipped, 0 failed/);
    assert.equal(statSync(filePath).mtimeMs, mtimeBefore);

    // --full composes with --dry-run and still writes nothing.
    const dry = await runBin(["import", "cursor-cloud", "--full", "--dry-run"], { env });
    assert.equal(convoCalls(api2).length, 6);
    assert.match(stripAnsi(dry.stdout), /dry-run summary: 2 checked, 2 fetched, /);
    assert.equal(statSync(filePath).mtimeMs, mtimeBefore);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud fetches conversations concurrently within the bound", async () => {
  const home = mkTmp("tq-cc-import-concurrency-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const ids = Array.from({ length: 8 }, (_, i) => `bc-conc-${i}`);
  const conversations = {};
  for (const id of ids) conversations[id] = api2Conversation();
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse(ids.map((id) => api2Composer(id)))],
    conversations,
    // Hold each conversation open long enough for overlap to be observable.
    conversationDelayMs: 80,
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const { stdout } = await runBin(["import", "cursor-cloud"], { env, timeoutMs: 60_000 });
    assert.match(stdout && stripAnsi(stdout), /8 checked, 8 fetched, 8 imported, 0 updated, 0 skipped, 0 failed/);
    assert.equal(convoCalls(api2).length, 8);
    assert.ok(
      api2.stats.maxConvoInFlight > 1,
      `expected parallel fetches, saw max ${api2.stats.maxConvoInFlight} in flight`,
    );
    assert.ok(
      api2.stats.maxConvoInFlight <= CURSOR_CLOUD_FETCH_CONCURRENCY,
      `fan-out must stay within ${CURSOR_CLOUD_FETCH_CONCURRENCY}, saw ${api2.stats.maxConvoInFlight}`,
    );
    assert.match(stripAnsi(stdout), new RegExp(`up to ${CURSOR_CLOUD_FETCH_CONCURRENCY} at a time`));
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud summary reports checked and fetched counts alongside the write outcomes", async () => {
  const home = mkTmp("tq-cc-import-counts-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const api2 = await startCursorApi2Fixture({
    listPages: [
      api2ListResponse([api2Composer("bc-c1"), api2Composer("bc-c2"), api2Composer("bc-gone")]),
    ],
    conversations: { "bc-c1": api2Conversation(), "bc-c2": api2Conversation() },
    conversationStatus: { "bc-gone": 404 },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const first = await runBin(["import", "cursor-cloud"], { env });
    const firstOut = stripAnsi(first.stdout);
    assert.match(firstOut, /3 checked, 3 fetched, 2 imported, 0 updated, 1 skipped, 0 failed/);
    // The whole plan is printed before any per-agent fetch outcome (fact ccpr).
    const planIdx = firstOut.indexOf("checked 3 agents: 0 unchanged, 3 to fetch");
    assert.ok(planIdx >= 0, `plan line missing from:\n${firstOut}`);
    assert.ok(planIdx < firstOut.indexOf("import bc-c1"), "plan line must precede fetch outcomes");

    const second = await runBin(["import", "cursor-cloud"], { env });
    const out = stripAnsi(second.stdout);
    // Two agents resolved from the list alone; only the 404 one is fetched.
    assert.equal(convoCalls(api2).length, 4);
    assert.match(out, /checked 3 agents: 2 unchanged, 1 to fetch/);
    assert.match(out, /3 checked, 1 fetched, 0 imported, 0 updated, 3 skipped, 0 failed/);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud tolerates unknown status, source, and message type values", async () => {
  const home = mkTmp("tq-cc-import-unknown-enums-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const oddId = "totally-custom_agent.id-42";
  const composer = api2Composer(oddId, {
    status: "BACKGROUND_COMPOSER_STATUS_SOME_FUTURE_VALUE",
    source: "BACKGROUND_COMPOSER_SOURCE_SOME_FUTURE_VALUE",
    surprisingNewField: { nested: true },
  });
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([composer])],
    conversations: {
      [oddId]: {
        conversation: [
          api2HumanMessage("kept human bubble", 0),
          { type: "MESSAGE_TYPE_SOME_FUTURE_VALUE", bubbleId: "b-future", text: "dropped" },
          api2AiMessage({ text: "kept assistant bubble", index: 1, toolResults: [api2ToolResult("brand_new_tool", 0)] }),
        ],
      },
    },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const { stdout } = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(stdout), /1 imported, 0 updated, 0 skipped, 0 failed/);
    // Ids are used verbatim in the request body and as the filename (ccvb).
    const convoCall = api2.requests.find((r) => r.path.endsWith("/GetBackgroundComposerConversation"));
    assert.equal(convoCall.body.bcId, oddId);
    const filePath = join(root, SLUG, `${oddId}.jsonl`);
    const lines = readJsonlLines(filePath);
    assert.equal(lines[0].status, "BACKGROUND_COMPOSER_STATUS_SOME_FUTURE_VALUE");
    // Unknown message types are dropped, known ones kept (fact ccmr).
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.slice(1).map((l) => l.role), ["user", "assistant"]);
    // An unaliased toolName passes through verbatim (fact cctb).
    assert.match(readFileSync(filePath, "utf8"), /"type":"tool_use","name":"brand_new_tool"/);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud reads a large single-response conversation without truncation", async () => {
  const home = mkTmp("tq-cc-import-large-");
  const root = join(home, "cursor-cloud-root");
  const dbPath = join(home, "state.vscdb");
  const bulk = "x".repeat(900);
  const messages = [api2HumanMessage("large conversation start", 0)];
  for (let i = 1; i <= 1500; i++) {
    messages.push(api2AiMessage({ text: `chunk ${i} ${bulk}`, index: i }));
  }
  messages.push(api2AiMessage({ text: "large conversation end", index: 9999 }));
  const payload = { conversation: messages };
  assert.ok(JSON.stringify(payload).length > 1_000_000, "fixture should exceed one megabyte");
  const api2 = await startCursorApi2Fixture({
    listPages: [api2ListResponse([api2Composer("bc-large")])],
    conversations: { "bc-large": payload },
  });
  try {
    writeCredentialDbFixture(dbPath);
    const env = makeKeylessEnv(home, root, api2.baseUrl, dbPath);
    const { stdout } = await runBin(["import", "cursor-cloud"], { env, timeoutMs: 60_000 });
    assert.match(stripAnsi(stdout), /1 imported, 0 updated, 0 skipped, 0 failed/);
    const lines = readJsonlLines(join(root, SLUG, "bc-large.jsonl"));
    // session_meta + every retained bubble: nothing truncated, no size cap.
    assert.equal(lines.length, messages.length + 1);
    assert.equal(lines.at(-1).message.content[0].text, "large conversation end");
    // One unpaginated conversation request — no cursor or continuation.
    const convoCalls = api2.requests.filter((r) => r.path.endsWith("/GetBackgroundComposerConversation"));
    assert.equal(convoCalls.length, 1);
  } finally {
    await api2.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud --dry-run prints planned actions and writes nothing", async () => {
  const home = mkTmp("tq-cc-import-dryrun-");
  const root = join(home, "cursor-cloud-root");
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-dry-1"), cloudAgent("bc-dry-2")] }],
    conversations: {
      "bc-dry-1": conversationOf("bc-dry-1"),
      "bc-dry-2": conversationOf("bc-dry-2"),
    },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    const dry = await runBin(["import", "cursor-cloud", "--dry-run"], { env });
    const out = stripAnsi(dry.stdout);
    // One planned action per agent (import, update, or skip) plus summary.
    assert.match(out, /import bc-dry-1/);
    assert.match(out, /import bc-dry-2/);
    assert.match(out, /2 imported, 0 updated, 0 skipped, 0 failed/);
    // Same GETs as a real run: list + one conversation per agent.
    assert.equal(fixture.requests.filter((r) => r.path === "/v0/agents").length, 1);
    assert.equal(fixture.requests.filter((r) => r.path.endsWith("/conversation")).length, 2);
    // Writes no files and creates no directories under the root.
    assert.equal(existsSync(root), false);

    // A subsequent real run starts from unchanged local state: both import.
    const real = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(real.stdout), /2 imported, 0 updated, 0 skipped, 0 failed/);
    assert.equal(existsSync(join(root, "org-repo", "bc-dry-1.jsonl")), true);
    assert.equal(existsSync(join(root, "org-repo", "bc-dry-2.jsonl")), true);
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud fetches paginated agents and writes jsonl under the cursor-cloud root", async () => {
  const home = mkTmp("tq-cc-import-paginate-");
  const root = join(home, "cursor-cloud-root");
  const fixture = await startCursorApiFixture({
    pages: [
      { agents: [cloudAgent("bc-page1")] },
      { agents: [cloudAgent("bc-page2")] },
    ],
    conversations: {
      "bc-page1": conversationOf("bc-page1"),
      "bc-page2": conversationOf("bc-page2"),
    },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    const { stdout } = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(stdout), /2 imported, 0 updated, 0 skipped, 0 failed/);

    // GET /v0/agents with limit=100, following nextCursor until absent.
    const listRequests = fixture.requests.filter((r) => r.path === "/v0/agents");
    assert.equal(listRequests.length, 2);
    assert.deepEqual(listRequests.map((r) => r.limit), ["100", "100"]);
    assert.deepEqual(listRequests.map((r) => r.cursor), [null, "page-1"]);
    // Every request authenticates with Bearer <key> (fact ccau).
    for (const r of fixture.requests) {
      assert.equal(r.auth, `Bearer ${API_KEY}`);
    }

    // <root>/<project-slug>/<agentId>.jsonl (org/repo -> org-repo).
    assert.equal(existsSync(join(root, "org-repo", "bc-page1.jsonl")), true);
    assert.equal(existsSync(join(root, "org-repo", "bc-page2.jsonl")), true);
    // No leftover temp files: the write is temp+rename atomic (fact ccly).
    const leftovers = readJsonlLines(join(root, "org-repo", "bc-page1.jsonl"));
    assert.equal(leftovers.length, 3); // session_meta + 2 message rows
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud falls back to the cursor-cloud project slug when repository is absent", async () => {
  const home = mkTmp("tq-cc-import-slug-");
  const root = join(home, "cursor-cloud-root");
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-noslug", { source: {} })] }],
    conversations: { "bc-noslug": conversationOf("bc-noslug") },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    await runBin(["import", "cursor-cloud"], { env });
    assert.equal(existsSync(join(root, "cursor-cloud", "bc-noslug.jsonl")), true);
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud writes a session_meta first line with agent metadata", async () => {
  const home = mkTmp("tq-cc-import-meta-");
  const root = join(home, "cursor-cloud-root");
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-meta")] }],
    conversations: { "bc-meta": conversationOf("bc-meta") },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    await runBin(["import", "cursor-cloud"], { env });
    const [meta] = readJsonlLines(join(root, "org-repo", "bc-meta.jsonl"));
    assert.equal(meta.type, "session_meta");
    assert.equal(meta.bcId, "bc-meta");
    assert.equal(meta.name, "Agent bc-meta");
    assert.equal(meta.status, "FINISHED");
    // createdAt is the API list value verbatim (fact ccml).
    assert.equal(meta.createdAt, "2026-07-01T10:00:00.000Z");
    assert.equal(meta.repository, "https://github.com/org/repo");
    assert.equal(meta.ref, "main");
    assert.equal(meta.branchName, "cursor/bc-meta");
    assert.equal(meta.prUrl, "https://github.com/org/repo/pull/7");
    assert.equal(meta.url, "https://cursor.com/agents?id=bc-meta");
    // Absent optional fields are simply omitted (no state.vscdb here).
    assert.equal("updatedAt" in meta, false);
    assert.equal("model" in meta, false);
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud maps v0 user_message and assistant_message rows to the cursor row shape", async () => {
  const home = mkTmp("tq-cc-import-rows-");
  const root = join(home, "cursor-cloud-root");
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-rows")] }],
    conversations: {
      "bc-rows": conversationOf("bc-rows", ["please fix the login flow", "done, pushed a branch"]),
    },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    await runBin(["import", "cursor-cloud"], { env });
    const lines = readJsonlLines(join(root, "org-repo", "bc-rows.jsonl"));
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[1], {
      role: "user",
      message: { content: [{ type: "text", text: "please fix the login flow" }] },
    });
    assert.deepEqual(lines[2], {
      role: "assistant",
      message: { content: [{ type: "text", text: "done, pushed a branch" }] },
    });
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud re-run skips unchanged sessions and preserves mtime", async () => {
  const home = mkTmp("tq-cc-import-rerun-");
  const root = join(home, "cursor-cloud-root");
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-rerun")] }],
    conversations: { "bc-rerun": conversationOf("bc-rerun") },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    const first = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(first.stdout), /1 imported, 0 updated, 0 skipped, 0 failed/);
    const filePath = join(root, "org-repo", "bc-rerun.jsonl");
    const mtimeBefore = statSync(filePath).mtimeMs;

    await new Promise((r) => setTimeout(r, 20));
    // The all-skipped idempotent re-run still exits 0 (fact ccsm).
    const second = await runBin(["import", "cursor-cloud"], { env });
    const out = stripAnsi(second.stdout);
    assert.match(out, /skip bc-rerun/);
    assert.match(out, /0 imported, 0 updated, 1 skipped, 0 failed/);
    // Skip means the write is skipped entirely: mtime untouched (fact ccid).
    assert.equal(statSync(filePath).mtimeMs, mtimeBefore);
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud skips deleted agents with a warning", async () => {
  const home = mkTmp("tq-cc-import-deleted-");
  const root = join(home, "cursor-cloud-root");
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-alive"), cloudAgent("bc-gone")] }],
    conversations: { "bc-alive": conversationOf("bc-alive") },
    conversationStatus: { "bc-gone": 404 },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    // 404 is never fatal and leaves the exit code unaffected (fact cc44).
    const { stdout, stderr } = await runBin(["import", "cursor-cloud"], { env });
    assert.match(stripAnsi(stderr), /bc-gone/);
    assert.match(stripAnsi(stderr), /404/);
    assert.match(stripAnsi(stdout), /1 imported, 0 updated, 1 skipped, 0 failed/);
    assert.equal(existsSync(join(root, "org-repo", "bc-alive.jsonl")), true);
    assert.equal(existsSync(join(root, "org-repo", "bc-gone.jsonl")), false);
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud uses agent ids verbatim and tolerates unknown status values", async () => {
  const home = mkTmp("tq-cc-import-verbatim-");
  const root = join(home, "cursor-cloud-root");
  // Not the observed bc-<uuid> form: ids are never validated or normalised.
  const oddId = "totally-custom_agent.id-42";
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent(oddId, { status: "SOME_FUTURE_STATUS" })] }],
    conversations: { [oddId]: conversationOf(oddId) },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    await runBin(["import", "cursor-cloud"], { env });
    // Verbatim id in the conversation URL...
    const convoRequest = fixture.requests.find((r) => r.path.endsWith("/conversation"));
    assert.equal(convoRequest.path, `/v0/agents/${oddId}/conversation`);
    // ...and verbatim as the <agentId>.jsonl filename (fact ccvb).
    const filePath = join(root, "org-repo", `${oddId}.jsonl`);
    assert.equal(existsSync(filePath), true);
    const [meta] = readJsonlLines(filePath);
    assert.equal(meta.status, "SOME_FUTURE_STATUS");
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud summary reports imported, updated, skipped, and failed counts", async () => {
  const home = mkTmp("tq-cc-import-summary-");
  const root = join(home, "cursor-cloud-root");
  const conversations = {
    "bc-a": conversationOf("bc-a"),
    "bc-b": conversationOf("bc-b"),
  };
  const fixture = await startCursorApiFixture({
    pages: [
      {
        agents: [
          cloudAgent("bc-a"),
          cloudAgent("bc-b"),
          cloudAgent("bc-gone"),
          cloudAgent("bc-err"),
        ],
      },
    ],
    conversations,
    conversationStatus: { "bc-gone": 404, "bc-err": 500 },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    // Run 1: 2 imported, 1 skipped (404), 1 failed (500) => exit 1.
    const first = await runBin(["import", "cursor-cloud"], { env, expectCode: 1 });
    assert.match(stripAnsi(first.stdout), /2 imported, 0 updated, 1 skipped, 1 failed/);

    // Run 2: bc-b's conversation grew => update; bc-a unchanged => skip.
    conversations["bc-b"] = conversationOf("bc-b", [
      "cloud user prompt",
      "cloud assistant reply",
      "one more follow-up",
    ]);
    const second = await runBin(["import", "cursor-cloud"], { env, expectCode: 1 });
    const out = stripAnsi(second.stdout);
    assert.match(out, /skip bc-a/);
    assert.match(out, /update bc-b/);
    assert.match(out, /0 imported, 1 updated, 2 skipped, 1 failed/);
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("import cursor-cloud --api-key enriches model from state.vscdb and omits model on failure", async () => {
  const home = mkTmp("tq-cc-import-enrich-");
  const root = join(home, "cursor-cloud-root");
  const updatedAtMs = Date.parse("2026-07-01T11:30:00.000Z");
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-enrich")] }],
    conversations: { "bc-enrich": conversationOf("bc-enrich") },
  });
  try {
    // Tiny synthetic state.vscdb built in the test (never real user data).
    const dbPath = join(home, "state.vscdb");
    writeStateDbFixture(dbPath, [
      {
        bcId: "bc-enrich",
        updatedAt: updatedAtMs,
        modelDetails: { modelName: "gpt-5-cursor" },
      },
      { bcId: "bc-other", updatedAt: 1, modelDetails: { modelName: "wrong-model" } },
    ]);
    const enrichedEnv = makeImportEnv(home, root, fixture.baseUrl, {
      TRACEQUEST_CURSOR_STATE_DB: dbPath,
    });
    await runBin(["import", "cursor-cloud"], { env: enrichedEnv });
    const [meta] = readJsonlLines(join(root, "org-repo", "bc-enrich.jsonl"));
    assert.equal(meta.model, "gpt-5-cursor");
    // updatedAt is the ISO-8601 conversion of the state.vscdb ms (fact ccml).
    assert.equal(meta.updatedAt, new Date(updatedAtMs).toISOString());

    // Enrichment failure (missing DB) silently omits the fields (fact ccme).
    rmSync(root, { recursive: true, force: true });
    const failEnv = makeImportEnv(home, root, fixture.baseUrl, {
      TRACEQUEST_CURSOR_STATE_DB: join(home, "no-such-state.vscdb"),
    });
    const { stdout } = await runBin(["import", "cursor-cloud"], { env: failEnv });
    assert.match(stripAnsi(stdout), /1 imported, 0 updated, 0 skipped, 0 failed/);
    const [plainMeta] = readJsonlLines(join(root, "org-repo", "bc-enrich.jsonl"));
    assert.equal("model" in plainMeta, false);
    assert.equal("updatedAt" in plainMeta, false);
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("imported cursor-cloud sessions are indexed and searchable", async () => {
  const home = mkTmp("tq-cc-import-search-");
  const root = join(home, "cursor-cloud-root");
  const needle = "cloud-import-search-needle-xyz";
  const fixture = await startCursorApiFixture({
    pages: [{ agents: [cloudAgent("bc-searchable")] }],
    conversations: {
      "bc-searchable": conversationOf("bc-searchable", [
        `please investigate the ${needle} report`,
        "on it, scanning the repo",
      ]),
    },
  });
  try {
    const env = makeImportEnv(home, root, fixture.baseUrl);
    await runBin(["import", "cursor-cloud"], { env });
    await fixture.close();

    // Normal pipeline, no extra flag or rescan (fact ccis): discovery finds
    // the materialised file, buildIndex indexes it, search returns the hit.
    const { stdout } = await runBin(["search", needle, "--json"], { env });
    const jsonLine = stdout
      .split("\n")
      .find((line) => line.trim().startsWith("["));
    assert.ok(jsonLine, `expected a JSON records line in stdout: ${stdout}`);
    const records = JSON.parse(jsonLine);
    assert.equal(records.length, 1);
    assert.equal(records[0].source, "cursor-cloud");
    assert.equal(records[0].path, join(root, "org-repo", "bc-searchable.jsonl"));
    assert.ok(records[0].matches.length > 0, "expected non-empty matches");
  } finally {
    await fixture.close();
    rmSync(home, { recursive: true, force: true });
  }
});
