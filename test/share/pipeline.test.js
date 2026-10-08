import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { loadSecretRules } from "../../src/share/secret-rules.js";
import { scanSessionForSecrets } from "../../src/share/scanner.js";
import { runSharePipeline } from "../../src/share/pipeline.js";

/** Assert uploaded gist HTML has intact viewer script bootstrap. */
function assertUploadedViewerScriptIntegrity(html) {
  const scriptOpen = html.indexOf("<script>\nconst SESSION");
  assert.ok(scriptOpen >= 0, "uploaded HTML should contain viewer script");
  const scriptBodyStart = html.indexOf("\n", scriptOpen) + 1;
  const scriptClose = html.lastIndexOf("</script>");
  const scriptBody = html.slice(scriptBodyStart, scriptClose);
  assert.ok(scriptBody.includes("readUrlState();"), "uploaded script should bootstrap readUrlState");
  assert.ok(scriptBody.includes("render();"), "uploaded script should bootstrap render");
  assert.ok(!/<\/script>/i.test(scriptBody), "script body must not contain premature </script>");
  assert.equal((html.match(/<\/script>/gi) || []).length, 1, "uploaded HTML should have one closing script tag");
}

describe("share pipeline", () => {
  test("metadata and gist description use redacted session, not raw secrets", async () => {
    const session = {
      sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
      source: "claude",
      model: "claude-3-5-sonnet",
      durationMs: 60000,
      events: [
        { type: "user", text: "Here is the key: sk-fake1234567890abcdef", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
      stats: { toolCounts: {}, errors: 0, userMessages: 1, assistantTurns: 0 },
      eventCount: 1,
    };
    const rules = loadSecretRules();
    const findings = scanSessionForSecrets(session, rules);
    assert.ok(findings.length >= 1);

    let gistBody = null;
    const fetchImpl = async (url, opts) => {
      if (url.endsWith("/gists")) {
        gistBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ html_url: "https://gist.github.com/mock/1", id: "1" }) };
      }
      return { ok: false, status: 404 };
    };

    const result = await runSharePipeline({
      session,
      findings,
      target: "gist",
      token: "fake",
      fetchImpl,
    });

    assert.equal(result.url, "https://gisthost.github.io/?1/tracequest-claude-abcdef12.html");
    assert.equal(result.gistUrl, "https://gist.github.com/mock/1");
    assert.ok(result.findings.length >= 1);
    assert.ok(!result.firstPrompt.includes("sk-fake"));
    assert.ok(!result.html.includes("sk-fake1234567890abcdef"));
    assert.ok(result.html.includes("[REDACTED]"));
    assert.ok(gistBody);
    const fileContent = Object.values(gistBody.files)[0].content;
    assert.ok(!gistBody.description.includes("sk-fake"));
    assert.ok(!fileContent.includes("sk-fake1234567890abcdef"));
    assertUploadedViewerScriptIntegrity(fileContent);
  });

  test("pipeline uploads via mock gist with findings and redacted firstPrompt", async () => {
    const session = {
      sessionId: "11111111-2222-3333-4444-555555555555",
      source: "claude",
      model: "claude-3-5-sonnet",
      durationMs: 1000,
      events: [
        { type: "user", text: "deploy sk-fake1234567890abcdef now", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
      stats: { toolCounts: {}, errors: 0, userMessages: 1, assistantTurns: 0 },
      eventCount: 1,
    };
    const findings = scanSessionForSecrets(session, loadSecretRules());
    let gistBody = null;
    const fetchImpl = async (url, opts) => {
      if (url.endsWith("/gists")) {
        gistBody = JSON.parse(opts.body);
        return { ok: true, json: async () => ({ html_url: "https://gist.github.com/mock/2", id: "2" }) };
      }
      return { ok: false, status: 404 };
    };
    const result = await runSharePipeline({
      session,
      findings,
      target: "gist",
      token: "fake",
      fetchImpl,
    });

    assert.equal(result.target, "gist");
    assert.ok(result.sessionId);
    assert.ok(Array.isArray(result.findings));
    assert.ok(result.findings.length >= 1);
    assert.ok(result.findings[0].location.field);
    assert.ok(!result.firstPrompt.includes("sk-fake"));
    assert.equal(result.url, "https://gisthost.github.io/?2/tracequest-claude-11111111.html");
    assert.equal(result.gistUrl, "https://gist.github.com/mock/2");
    assert.ok(gistBody);
    const fileContent = Object.values(gistBody.files)[0].content;
    assertUploadedViewerScriptIntegrity(fileContent);
  });

  test("HF target leaves gistUrl null", async () => {
    const session = {
      sessionId: "hf-test-1111-2222-3333-444455555555",
      source: "claude",
      model: "claude-3-5-sonnet",
      durationMs: 1000,
      events: [
        { type: "user", text: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
      stats: { toolCounts: {}, errors: 0, userMessages: 1, assistantTurns: 0 },
      eventCount: 1,
    };
    const result = await runSharePipeline({
      session,
      findings: [],
      target: "hf",
      token: "fake",
      fetchImpl: async (url, opts) => {
        if (url.includes("/api/whoami-v2")) {
          return { ok: true, json: async () => ({ name: "testuser" }) };
        }
        if (url.includes("/api/datasets/testuser/tracequest-sessions") && (!opts || opts.method === undefined)) {
          return { ok: false, status: 404 };
        }
        if (url.endsWith("/api/repos/create")) {
          return { ok: true, json: async () => ({}) };
        }
        if (url.includes("/commit/main")) {
          return { ok: true, json: async () => ({}) };
        }
        return { ok: true, json: async () => ({}) };
      },
    });

    assert.equal(result.gistUrl, null);
    assert.ok(result.url.includes("huggingface.co"));
  });
});