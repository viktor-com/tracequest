/**
 * Automated harness for tests/sharing-integration.md — share pipeline integration scenarios.
 * Real bin/tracequest.js invocations; temp dirs; mock Gist/HF servers; HOME override.
 */
import "../helpers/skip-lr-watch-env.js";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkTmp, writeClaudeJsonl, CLAUDE_FIXTURE_MODEL } from "../helpers/fixtures.js";
import { seedOpenCodeIndexDb } from "../helpers/opencode-db-fixtures.js";
import { loadSecretRules } from "../../src/share/secret-rules.js";
import { compileRules, scanSessionForSecrets } from "../../src/share/scanner.js";
import { minimalSession as minimalParsedSession } from "../helpers/minimal-session.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const SECRET = "sk-fake1234567890abcdef";
const AWS_ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";
const BEARER_TOKEN = "Bearer dG9rZW5fc2VjcmV0X2Jhc2U2NF9oaWdoX2VudHJvcHlfdGVzdA==";
const GHP_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz123456";
const PEM_BLOCK =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAfakekeymaterial\n-----END RSA PRIVATE KEY-----";
const GITHUB_FINE_GRAINED_PAT = "github_pat_abcdefghijklmnopqrstuvwxyz1234567890";
const HF_TOKEN = "hf_abcdefghijklmnopqrstuvwxyz123456";
const SLACK_TOKEN = ["xoxb", "1234567890", "abcdefghijklmnop"].join("-");
const STRIPE_SECRET_KEY = "sk_live_abcdefghijklmnopqrst";
const GENERIC_API_KEY_VALUE = "dG9rZW5fc2VjcmV0X2Jhc2U2NF9oaWdoX2VudHJvcHlfdGVzdA==";

/** Representative secret samples — one per shipped rule id. */
const RULE_FIXTURES = [
  { ruleId: "openai-api-key", text: `key ${SECRET}` },
  { ruleId: "github-pat", text: `export GITHUB_TOKEN=${GHP_TOKEN}` },
  { ruleId: "github-fine-grained-pat", text: `token ${GITHUB_FINE_GRAINED_PAT}` },
  { ruleId: "aws-access-key", text: `export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY}` },
  { ruleId: "generic-api-key", text: `export SERVICE_API_KEY=${GENERIC_API_KEY_VALUE}` },
  { ruleId: "bearer-token", text: BEARER_TOKEN },
  { ruleId: "private-key-block", text: PEM_BLOCK },
  { ruleId: "huggingface-token", text: `hf login ${HF_TOKEN}` },
  { ruleId: "slack-token", text: `SLACK_BOT_TOKEN=${SLACK_TOKEN}` },
  { ruleId: "stripe-secret-key", text: `stripe_key=${STRIPE_SECRET_KEY}` },
];

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function runBin(args, { env = {}, timeoutMs = 60_000, expectCode = 0 } = {}) {
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

function minimalSession(sessionId, { prompt = "hello share", toolSecret = null } = {}) {
  const ts = "2026-06-03T12:00:00.000Z";
  const user = {
    type: "user",
    sessionId,
    cwd: "/home/dev/tracequest",
    timestamp: ts,
    uuid: `u-${sessionId}`,
    isMeta: false,
    message: { content: [{ type: "text", text: prompt }] },
  };
  const assistantContent = toolSecret
    ? [
        { type: "text", text: "running" },
        {
          type: "tool_use",
          id: "t1",
          name: "Bash",
          input: { command: `export API_KEY=${toolSecret}` },
        },
      ]
    : [{ type: "text", text: "ok" }];
  const assistant = {
    type: "assistant",
    sessionId,
    timestamp: ts,
    uuid: `a-${sessionId}`,
    message: { model: CLAUDE_FIXTURE_MODEL, content: assistantContent },
  };
  return [user, assistant];
}

function seedClaudeProject(home, projectName, fileName, lines, mtimeOffsetSec = 0) {
  const dir = join(home, ".claude", "projects", projectName);
  mkdirSync(dir, { recursive: true });
  const filePath = writeClaudeJsonl(dir, fileName, lines);
  if (mtimeOffsetSec) {
    const t = Date.now() / 1000 + mtimeOffsetSec;
    utimesSync(filePath, t, t);
  }
  return filePath;
}

function extractScriptBundle(html) {
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  return scripts.join("\n");
}

async function withMockGistServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withMockHfServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const port = server.address().port;
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("tests/sharing-integration.md harness", () => {
  test("Test 1: share --help documents flags", async () => {
    const { stdout } = await runBin(["share", "--help"]);
    const visible = stripAnsi(stdout);
    assert.match(visible, /share/);
    assert.match(visible, /--target/);
    assert.match(visible, /gist/);
    assert.match(visible, /--open/);
    assert.match(visible, /--json/);
    assert.match(visible, /--private/);
    assert.match(visible, /--force/);
    assert.match(visible, /--hf-repo/);
  });

  test("Test 2: share rejects unknown options", async () => {
    const { stderr } = await runBin(["share", "/tmp/fake.jsonl", "--not-a-flag"], { expectCode: 1 });
    assert.match(stderr, /Unknown option '--not-a-flag'/);
    assert.ok(!stderr.includes("node:internal/process"));
  });

  test("Test 3: share session path runs pipeline and emits JSON via mock gist", async () => {
    const dir = mkTmp("tracequest-share-int-3-");
    const sessionPath = writeClaudeJsonl(
      dir,
      "sess-with-secret.jsonl",
      minimalSession("share-secret-1", { prompt: `Here is the key: ${SECRET} and the endpoint` }),
    );
    try {
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ html_url: "https://gist.github.com/mock-user/abc123", id: "abc123" }));
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout, stderr } = await runBin(
          ["share", sessionPath, "--target", "gist", "--json", "--force"],
          { env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const combined = stripAnsi(stdout + stderr);
        assert.ok(!combined.includes("Unknown command: share"));
        assert.match(combined, /Parsing session|Scanning session for secrets/);
        assert.ok(stdout.trimStart().startsWith("{"), "stdout should be pure JSON (index logs on stderr)");
        const parsed = JSON.parse(stdout);
        for (const key of [
          "sessionId",
          "source",
          "model",
          "project",
          "firstPrompt",
          "chapterCount",
          "target",
          "url",
          "findings",
          "private",
        ]) {
          assert.ok(key in parsed, `missing JSON field ${key}`);
        }
        assert.equal(parsed.target, "gist");
        assert.match(parsed.url, /^https:\/\/gisthost\.github\.io\/\?abc123\//);
        assert.equal(parsed.gistUrl, "https://gist.github.com/mock-user/abc123");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 4: share pipeline redacts secrets in upload payload", async () => {
    const dir = mkTmp("tracequest-share-int-4-");
    const sessionPath = writeClaudeJsonl(
      dir,
      "sess-with-secret.jsonl",
      minimalSession("share-secret-4", { prompt: `Here is the key: ${SECRET} and the endpoint` }),
    );
    const originalHtml = join(dir, "original.html");
    try {
      await runBin(["render", sessionPath, "--out", originalHtml]);
      const original = readFileSync(originalHtml, "utf8");
      assert.ok(original.includes(SECRET), "original render should contain literal secret");

      let gistBody = null;
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            gistBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/1", id: "1" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout } = await runBin(
          ["share", sessionPath, "--target", "gist", "--json", "--force"],
          { env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const parsed = JSON.parse(stdout);
        const fileContent = Object.values(gistBody.files)[0].content;
        assert.ok(!fileContent.includes(SECRET));
        assert.ok(fileContent.includes("[REDACTED]"));
        const finding = parsed.findings[0];
        assert.ok(finding.ruleId);
        assert.ok(finding.description);
        assert.ok(finding.match);
        assert.ok(finding.location);
        assert.equal(typeof finding.location.chapterIndex, "number");
        assert.equal(typeof finding.location.eventIndex, "number");
        assert.ok(finding.location.eventType);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 4b: tool input secrets are redacted in upload payload", async () => {
    const dir = mkTmp("tracequest-share-int-4b-");
    const sessionPath = writeClaudeJsonl(
      dir,
      "sess-tool-secret.jsonl",
      minimalSession("share-tool-1", { prompt: "run command", toolSecret: SECRET }),
    );
    try {
      let gistBody = null;
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            gistBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/t", id: "t" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout } = await runBin(
          ["share", sessionPath, "--target", "gist", "--json", "--force"],
          { env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const parsed = JSON.parse(stdout);
        const fileContent = Object.values(gistBody.files)[0].content;
        assert.ok(parsed.findings.length >= 1);
        assert.ok(!fileContent.includes(SECRET));
        assert.ok(fileContent.includes("[REDACTED]"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 5: rendered HTML embeds share modal UI in script bundle", async () => {
    const dir = mkTmp("tracequest-share-int-5-");
    const sessionPath = writeClaudeJsonl(dir, "sess-ui.jsonl", minimalSession("share-ui-1"));
    const out = join(dir, "ui.html");
    try {
      await runBin(["render", sessionPath, "--out", out]);
      const html = readFileSync(out, "utf8");
      const js = extractScriptBundle(html);
      assert.ok(js.includes("hf-btn"));
      assert.ok(js.includes("header-actions"));
      assert.ok(js.includes("hf-modal-overlay"));
      assert.ok(/Gist|HF/.test(js));
      assert.ok(js.includes("hf-modal-share"));
      assert.ok(js.includes("hf-modal-cancel"));
      assert.ok(js.includes("hf-modal-input"));
      assert.ok(/privateChk|private/.test(js));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 6: rendered HTML embeds scanner rules and upload adapters", async () => {
    const dir = mkTmp("tracequest-share-int-6-");
    const sessionPath = writeClaudeJsonl(dir, "sess-ui.jsonl", minimalSession("share-ui-6"));
    const out = join(dir, "ui.html");
    try {
      await runBin(["render", sessionPath, "--out", out]);
      const js = extractScriptBundle(readFileSync(out, "utf8"));
      assert.match(js, /"id".*"description".*"regex"/s);
      assert.match(js, /shareGist[\s\S]*fetch\([^)]*gists/);
      assert.match(js, /shareHf[\s\S]*repos\/create/);
      assert.match(js, /scanSessionForSecrets/);
      assert.ok(js.includes("SECRET_RULES"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 13: share --latest resolves most recent OpenCode session in OpenCode-only HOME", async () => {
    const home = mkTmp("tracequest-share-int-oc-latest-");
    const ocProject = "/home/dev/oc-share-latest-proj";
    const olderId = "ses_shareOcLatestOlderSess01";
    const newerId = "ses_shareOcLatestNewerSess01";
    const olderT = 1_715_731_200_000;
    const newerT = 1_715_731_500_000;
    try {
      await seedOpenCodeIndexDb(home, [
        {
          id: olderId,
          title: "Older OpenCode Share",
          directory: ocProject,
          time_created: olderT,
          time_updated: olderT,
          messages: [
            { role: "user", parts: [{ type: "text", text: "older opencode share prompt" }] },
            { role: "assistant", modelID: "gpt-4o", parts: [{ type: "text", text: "older reply" }] },
            { role: "user", parts: [{ type: "text", text: "older third turn" }] },
          ],
        },
        {
          id: newerId,
          title: "Newer OpenCode Share",
          directory: ocProject,
          time_created: newerT,
          time_updated: newerT,
          messages: [
            { role: "user", parts: [{ type: "text", text: "newer opencode share prompt" }] },
            { role: "assistant", modelID: "gpt-4o", parts: [{ type: "text", text: "newer reply" }] },
            { role: "user", parts: [{ type: "text", text: "newer third turn" }] },
          ],
        },
      ]);

      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/oc-latest", id: "oc-latest" }));
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout, stderr } = await runBin(
          ["share", "--latest", "oc-share-latest", "--target", "gist", "--json", "--force"],
          { env: { HOME: home, GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const combined = stripAnsi(stdout + stderr);
        assert.ok(!combined.includes("Unknown command: share"));
        assert.ok(!combined.includes("No sessions found"));
        assert.ok(stdout.trimStart().startsWith("{"));
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.sessionId, newerId);
        assert.equal(parsed.target, "gist");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 7: share --latest resolves the most recent session", async () => {
    const home = mkTmp("tracequest-share-int-home-7-");
    seedClaudeProject(
      home,
      "-tmp-tracequest-share-tests-project-a",
      "older.jsonl",
      minimalSession("share-latest-old", { prompt: "older" }),
      -3600,
    );
    seedClaudeProject(
      home,
      "-tmp-tracequest-share-tests-project-a",
      "newer.jsonl",
      minimalSession("share-latest-new", { prompt: "newer" }),
      0,
    );
    try {
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/7", id: "7" }));
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout, stderr } = await runBin(
          ["share", "--latest", "project-a", "--target", "gist", "--json", "--force"],
          { env: { HOME: home, GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const combined = stripAnsi(stdout + stderr);
        assert.ok(!combined.includes("Unknown command: share"));
        assert.ok(stdout.trimStart().startsWith("{"));
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.sessionId, "share-latest-new");
        assert.equal(parsed.target, "gist");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 8: share --filter filters and picks most recent match", async () => {
    const home = mkTmp("tracequest-share-int-home-8-");
    seedClaudeProject(
      home,
      "-tmp-tracequest-share-tests-project-b",
      "no-deploy.jsonl",
      minimalSession("share-expr-old", { prompt: "just chatting" }),
      -7200,
    );
    seedClaudeProject(
      home,
      "-tmp-tracequest-share-tests-project-b",
      "deploy.jsonl",
      minimalSession("share-expr-deploy", { prompt: "plan the deploy rollout" }),
      -60,
    );
    try {
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/8", id: "8" }));
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout, stderr } = await runBin(
          ["share", "--filter", "deploy", "--target", "gist", "--json", "--force"],
          { env: { HOME: home, GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const combined = stripAnsi(stdout + stderr);
        assert.ok(!combined.includes("Unknown command: share"));
        const parsed = JSON.parse(stdout);
        assert.match(parsed.firstPrompt, /deploy/i);
        assert.equal(parsed.target, "gist");
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Test 9: re-share creates a new gist (no dedup)", async () => {
    const dir = mkTmp("tracequest-share-int-9-");
    const sessionPath = writeClaudeJsonl(dir, "sess-reshare.jsonl", minimalSession("share-reshare-1"));
    try {
      let postCount = 0;
      const ids = ["id1", "id2"];
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          postCount += 1;
          const id = ids[postCount - 1] || `id${postCount}`;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ html_url: `https://gist.github.com/mock/${id}`, id }));
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const env = { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl };
        const first = await runBin(["share", sessionPath, "--target", "gist", "--json", "--force"], { env });
        const second = await runBin(["share", sessionPath, "--target", "gist", "--json", "--force"], { env });
        assert.equal(postCount, 2);
        const j1 = JSON.parse(first.stdout);
        const j2 = JSON.parse(second.stdout);
        assert.ok(j1.url);
        assert.ok(j2.url);
        assert.notEqual(j1.url, j2.url);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 10: HF adapter creates repo and writes html+json+README", async () => {
    const dir = mkTmp("tracequest-share-int-10-");
    const sessionPath = writeClaudeJsonl(dir, "sess-hf.jsonl", minimalSession("share-hf-1", { prompt: "hf share test" }));
    try {
      const calls = [];
      await withMockHfServer((req, res) => {
        const url = req.url || "";
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          if (body) {
            try {
              calls.push({ url, method: req.method, body: JSON.parse(body) });
            } catch {
              calls.push({ url, method: req.method, body });
            }
          } else {
            calls.push({ url, method: req.method, body: null });
          }
          if (url.includes("/api/whoami-v2")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ name: "testuser" }));
            return;
          }
          if (url.includes("/api/datasets/testuser/tracequest-sessions") && req.method === "GET") {
            res.writeHead(404);
            res.end();
            return;
          }
          if (url.endsWith("/api/repos/create") && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          if (url.includes("/commit/main") && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          res.writeHead(404);
          res.end();
        });
      }, async (apiUrl) => {
        const { stdout } = await runBin(
          [
            "share",
            sessionPath,
            "--target",
            "hf",
            "--hf-repo",
            "testuser/tracequest-sessions",
            "--json",
            "--force",
          ],
          { env: { HF_TOKEN: "fake", HF_API_URL: apiUrl } },
        );
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.target, "hf");
        assert.ok(parsed.url.includes("/datasets/testuser/tracequest-sessions"));
        const createCall = calls.find((c) => c.url.endsWith("/api/repos/create"));
        assert.ok(createCall);
        assert.equal(createCall.body.type, "dataset");
        const commitCall = calls.find((c) => c.url.includes("/commit/main"));
        assert.ok(commitCall);
        const paths = commitCall.body.operations.map((op) => op.path);
        assert.ok(paths.some((p) => p.endsWith(".html")));
        assert.ok(paths.some((p) => p.endsWith(".json")));
        assert.ok(paths.includes("README.md"));
        const jsonOp = commitCall.body.operations.find((op) => op.path.endsWith(".json"));
        const sidecar = JSON.parse(jsonOp.content);
        for (const key of [
          "sessionId",
          "source",
          "model",
          "project",
          "firstPrompt",
          "eventCount",
          "errorCount",
          "tools",
          "filePaths",
          "gitBranch",
        ]) {
          assert.ok(key in sidecar, `sidecar missing ${key}`);
        }
        assert.ok("costEstimate" in sidecar || "cost" in sidecar);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 12: HF re-share to existing repo skips README.md (fact 8gh)", async () => {
    const dir = mkTmp("tracequest-share-int-12-");
    const sessionA = writeClaudeJsonl(dir, "sess-hf-a.jsonl", minimalSession("share-hf-a", { prompt: "hf first share" }));
    const sessionB = writeClaudeJsonl(dir, "sess-hf-b.jsonl", minimalSession("share-hf-b", { prompt: "hf second share" }));
    try {
      const calls = [];
      let repoExists = false;
      await withMockHfServer((req, res) => {
        const url = req.url || "";
        let body = "";
        req.on("data", (c) => {
          body += c;
        });
        req.on("end", () => {
          if (body) {
            try {
              calls.push({ url, method: req.method, body: JSON.parse(body) });
            } catch {
              calls.push({ url, method: req.method, body });
            }
          } else {
            calls.push({ url, method: req.method, body: null });
          }
          if (url.includes("/api/whoami-v2")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ name: "testuser" }));
            return;
          }
          if (url.includes("/api/datasets/testuser/tracequest-sessions") && req.method === "GET") {
            if (repoExists) {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ id: "testuser/tracequest-sessions" }));
              return;
            }
            res.writeHead(404);
            res.end();
            return;
          }
          if (url.endsWith("/api/repos/create") && req.method === "POST") {
            repoExists = true;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          if (url.includes("/commit/main") && req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end("{}");
            return;
          }
          res.writeHead(404);
          res.end();
        });
      }, async (apiUrl) => {
        const env = {
          HF_TOKEN: "fake",
          HF_API_URL: apiUrl,
        };
        const hfArgs = (path) => [
          "share",
          path,
          "--target",
          "hf",
          "--hf-repo",
          "testuser/tracequest-sessions",
          "--json",
          "--force",
        ];

        const first = await runBin(hfArgs(sessionA), { env });
        const second = await runBin(hfArgs(sessionB), { env });

        const createCalls = calls.filter((c) => c.url.endsWith("/api/repos/create"));
        assert.equal(createCalls.length, 1, "repo create should happen only on first share");

        const commitCalls = calls.filter((c) => c.url.includes("/commit/main") && c.method === "POST");
        assert.equal(commitCalls.length, 2, "two commits expected for two shares");

        const firstPaths = commitCalls[0].body.operations.map((op) => op.path);
        const secondPaths = commitCalls[1].body.operations.map((op) => op.path);

        assert.ok(firstPaths.includes("README.md"), "first share should add README.md dataset card");
        assert.ok(firstPaths.some((p) => p.endsWith(".html")));
        assert.ok(firstPaths.some((p) => p.endsWith(".json")));

        assert.ok(!secondPaths.includes("README.md"), "re-share must not overwrite README.md");
        assert.equal(secondPaths.length, 2, "re-share commit should only update html+json");
        assert.ok(secondPaths.some((p) => p.endsWith(".html")));
        assert.ok(secondPaths.some((p) => p.endsWith(".json")));

        const j1 = JSON.parse(first.stdout);
        const j2 = JSON.parse(second.stdout);
        assert.equal(j1.target, "hf");
        assert.equal(j2.target, "hf");
        assert.ok(j1.url.includes("/datasets/testuser/tracequest-sessions"));
        assert.ok(j2.url.includes("/datasets/testuser/tracequest-sessions"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 14: PEM private key block redacted in share upload payload", async () => {
    const dir = mkTmp("tracequest-share-int-14-");
    const sessionPath = writeClaudeJsonl(
      dir,
      "sess-pem.jsonl",
      minimalSession("share-pem-1", { prompt: `Deploy with key:\n${PEM_BLOCK}` }),
    );
    try {
      let gistBody = null;
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            gistBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/pem", id: "pem" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout } = await runBin(
          ["share", sessionPath, "--target", "gist", "--json", "--force"],
          { env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const parsed = JSON.parse(stdout);
        const fileContent = Object.values(gistBody.files)[0].content;
        assert.ok(parsed.findings.some((f) => f.ruleId === "private-key-block"));
        assert.ok(!fileContent.includes("MIIEpAIBAAKCAQEAfakekeymaterial"));
        assert.ok(!fileContent.includes("BEGIN RSA PRIVATE KEY"));
        assert.ok(fileContent.includes("[REDACTED]"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 15: AWS access key in env-var export tool input redacted before share", async () => {
    const dir = mkTmp("tracequest-share-int-15-");
    const sessionPath = writeClaudeJsonl(
      dir,
      "sess-aws-env.jsonl",
      minimalSession("share-aws-1", {
        prompt: "deploy to staging",
        toolSecret: `export AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY} && ./deploy.sh`,
      }),
    );
    try {
      let gistBody = null;
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            gistBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/aws", id: "aws" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout } = await runBin(
          ["share", sessionPath, "--target", "gist", "--json", "--force"],
          { env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const parsed = JSON.parse(stdout);
        const fileContent = Object.values(gistBody.files)[0].content;
        assert.ok(parsed.findings.some((f) => f.ruleId === "aws-access-key"));
        assert.ok(!fileContent.includes(AWS_ACCESS_KEY));
        assert.ok(fileContent.includes("[REDACTED]"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 16: bearer/base64 token in curl tool input redacted before share", async () => {
    const dir = mkTmp("tracequest-share-int-16-");
    const sessionPath = writeClaudeJsonl(
      dir,
      "sess-bearer.jsonl",
      minimalSession("share-bearer-1", {
        prompt: "call upstream API",
        toolSecret: `curl -H "Authorization: ${BEARER_TOKEN}" https://api.example.com`,
      }),
    );
    try {
      let gistBody = null;
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            gistBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/bearer", id: "bearer" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout } = await runBin(
          ["share", sessionPath, "--target", "gist", "--json", "--force"],
          { env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const parsed = JSON.parse(stdout);
        const fileContent = Object.values(gistBody.files)[0].content;
        assert.ok(parsed.findings.some((f) => f.ruleId === "bearer-token"));
        assert.ok(!fileContent.includes("dG9rZW5fc2VjcmV0X2Jhc2U2NF9oaWdoX2VudHJvcHlfdGVzdA=="));
        assert.ok(fileContent.includes("[REDACTED]"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 17: redaction preserves legitimate session content alongside secrets", async () => {
    const dir = mkTmp("tracequest-share-int-17-");
    const ts = "2026-06-03T12:00:00.000Z";
    const sessionPath = writeClaudeJsonl(dir, "sess-preserve.jsonl", [
      {
        type: "user",
        sessionId: "share-preserve-1",
        cwd: "/home/dev/tracequest",
        timestamp: ts,
        uuid: "u-preserve",
        isMeta: false,
        message: {
          content: [
            {
              type: "text",
              text: "Please review our API key rotation policy for the dashboard OAuth2 flow.",
            },
          ],
        },
      },
      {
        type: "assistant",
        sessionId: "share-preserve-1",
        timestamp: ts,
        uuid: "a-preserve",
        message: {
          model: CLAUDE_FIXTURE_MODEL,
          content: [
            { type: "text", text: "The dashboard uses OAuth2 refresh tokens. Rotate keys quarterly per policy." },
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: `export GITHUB_TOKEN=${GHP_TOKEN}` },
            },
          ],
        },
      },
    ]);
    try {
      let gistBody = null;
      await withMockGistServer((req, res) => {
        if (req.url?.endsWith("/gists") && req.method === "POST") {
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            gistBody = JSON.parse(body);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ html_url: "https://gist.github.com/mock/preserve", id: "preserve" }));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      }, async (apiUrl) => {
        const { stdout } = await runBin(
          ["share", sessionPath, "--target", "gist", "--json", "--force"],
          { env: { GITHUB_TOKEN: "fake", GITHUB_API_URL: apiUrl } },
        );
        const parsed = JSON.parse(stdout);
        const fileContent = Object.values(gistBody.files)[0].content;
        assert.ok(parsed.findings.some((f) => f.ruleId === "github-pat"));
        assert.ok(!fileContent.includes(GHP_TOKEN));
        assert.ok(fileContent.includes("[REDACTED]"));
        assert.ok(fileContent.includes("API key rotation policy"));
        assert.ok(fileContent.includes("OAuth2 refresh tokens"));
        assert.ok(fileContent.includes("Rotate keys quarterly per policy"));
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Test 18: all shipped secret rules compile and match representative secrets", () => {
    const rules = loadSecretRules();
    const compiled = compileRules(rules);
    assert.equal(
      compiled.length,
      rules.length,
      `expected ${rules.length} compiled rules, got ${compiled.length}`,
    );
    assert.deepEqual(
      compiled.map((r) => r.id).sort(),
      rules.map((r) => r.id).sort(),
    );

    for (const { ruleId, text } of RULE_FIXTURES) {
      const findings = scanSessionForSecrets(
        minimalParsedSession({
          events: [{ type: "user", text, timestamp: "2026-01-01T00:00:00.000Z" }],
        }),
        rules,
      );
      assert.ok(
        findings.some((f) => f.ruleId === ruleId),
        `rule ${ruleId} should match representative secret`,
      );
    }
  });

  test("Test 11: share modal JS references localStorage keys and status classes (structural)", async () => {
    const dir = mkTmp("tracequest-share-int-11-");
    const sessionPath = writeClaudeJsonl(dir, "sess-ui.jsonl", minimalSession("share-ui-11"));
    const out = join(dir, "ui.html");
    try {
      await runBin(["render", sessionPath, "--out", out]);
      assert.ok(existsSync(out));
      const js = extractScriptBundle(readFileSync(out, "utf8"));
      assert.ok(js.includes("tracequest-gh-token"));
      assert.ok(js.includes("tracequest-hf-token"));
      assert.ok(js.includes("hf-success"));
      assert.ok(js.includes("hf-error"));
      assert.ok(/spinnerEl|⏳/.test(js));
      assert.ok(js.includes("shareBtn.disabled"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});