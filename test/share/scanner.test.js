import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  scanSessionForSecrets,
  redactMatchDisplay,
  shannonEntropy,
  compileRules,
  normalizeRuleRegex,
} from "../../src/share/scanner.js";
import { redactSession } from "../../src/share/redactor.js";
import { loadSecretRules } from "../../src/share/secret-rules.js";
import { minimalSession } from "../helpers/minimal-session.js";

const INLINE_RULES = [
  {
    id: "openai-api-key",
    description: "OpenAI API Key",
    regex: "sk-[A-Za-z0-9]{16,}",
    keywords: ["sk-"],
    entropy: 3.0,
  },
];

describe("share scanner", () => {
  test("shannonEntropy returns higher values for random strings", () => {
    assert.ok(shannonEntropy("aaaaaaaa") < shannonEntropy("sk-fake1234567890abcdef"));
  });

  test("redactMatchDisplay shows first 4 and last 4 chars", () => {
    assert.equal(redactMatchDisplay("sk-fake1234567890abcdef"), "sk-f…cdef");
    assert.equal(redactMatchDisplay("short"), "****");
  });

  test("loadSecretRules returns shipped rules with gitleaks structure", () => {
    const rules = loadSecretRules();
    assert.ok(rules.length >= 5);
    const openai = rules.find((r) => r.id === "openai-api-key");
    assert.ok(openai);
    assert.ok(openai.regex);
    assert.ok(openai.description);
    assert.ok(Array.isArray(openai.keywords));
    const pem = rules.find((r) => r.id === "private-key-block");
    assert.ok(pem);
    assert.ok(pem.regex.includes("END"));
  });

  test("shipped rules detect sk- secrets in event.text", () => {
    const session = minimalSession({
      events: [
        { type: "user", text: "key sk-fake1234567890abcdef", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const findings = scanSessionForSecrets(session, loadSecretRules());
    assert.ok(findings.length >= 1);
    assert.equal(findings[0].ruleId, "openai-api-key");
  });

  test("scanSessionForSecrets finds secret in event.text with field in location", () => {
    const session = minimalSession({
      events: [
        { type: "user", text: "Here is the key: sk-fake1234567890abcdef and the endpoint", timestamp: "2026-01-01T00:00:00.000Z" },
      ],
    });
    const findings = scanSessionForSecrets(session, INLINE_RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, "openai-api-key");
    assert.equal(findings[0].match, "sk-f…cdef");
    assert.equal(findings[0].location.eventType, "user");
    assert.equal(findings[0].location.field, "text");
    assert.equal(findings[0].location.chapterIndex, 0);
  });

  test("scanSessionForSecrets finds secret in toolCalls[].input", () => {
    const session = minimalSession({
      events: [
        {
          type: "assistant",
          text: "running command",
          toolCalls: [{ id: "t1", name: "Bash", input: "curl -H 'Authorization: Bearer sk-fake1234567890abcdef'" }],
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const findings = scanSessionForSecrets(session, INLINE_RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].location.toolName, "Bash");
    assert.equal(findings[0].location.field, "toolCalls[].input");
  });

  test("scanSessionForSecrets finds secret in thinking blocks", () => {
    const session = minimalSession({
      events: [
        {
          type: "assistant",
          text: "ok",
          thinking: ["use sk-fake1234567890abcdef here"],
          timestamp: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    const findings = scanSessionForSecrets(session, INLINE_RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].location.field, "thinking");
  });

  test("scanSessionForSecrets finds secret in agentHistory", () => {
    const session = minimalSession({
      agentHistory: [
        { agentId: "sub1", record: { content: "token sk-fake1234567890abcdef" } },
      ],
    });
    const findings = scanSessionForSecrets(session, INLINE_RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].location.eventType, "agentHistory");
    assert.equal(findings[0].location.field, "agentHistory.record");
  });

  test("scanSessionForSecrets scans session scalar cwd", () => {
    const session = minimalSession({
      cwd: "/home/user/sk-fake1234567890abcdef",
      events: [],
    });
    const findings = scanSessionForSecrets(session, INLINE_RULES);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].location.field, "cwd");
    assert.equal(findings[0].location.eventType, "session");
  });

  test("redactSession replaces secrets with [REDACTED] without mutating original", () => {
    const secret = "sk-fake1234567890abcdef";
    const session = minimalSession({
      events: [{ type: "user", text: `key ${secret}`, timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    const findings = scanSessionForSecrets(session, INLINE_RULES);
    const redacted = redactSession(session, findings);
    assert.ok(redacted.events[0].text.includes("[REDACTED]"));
    assert.ok(!redacted.events[0].text.includes(secret));
    assert.ok(session.events[0].text.includes(secret));
  });

  test("redactSession redacts full PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEAfake\n-----END RSA PRIVATE KEY-----";
    const session = minimalSession({
      events: [{ type: "user", text: `key:\n${pem}`, timestamp: "2026-01-01T00:00:00.000Z" }],
    });
    const findings = scanSessionForSecrets(session, loadSecretRules());
    assert.ok(findings.some((f) => f.ruleId === "private-key-block"));
    const redacted = redactSession(session, findings);
    assert.ok(!redacted.events[0].text.includes("MIIEpAIBAAKCAQEAfake"));
    assert.ok(redacted.events[0].text.includes("[REDACTED]"));
  });

  test("compileRules skips invalid regexes", () => {
    const compiled = compileRules([{ id: "bad", description: "bad", regex: "(" }]);
    assert.equal(compiled.length, 0);
  });

  test("normalizeRuleRegex converts gitleaks (?i) prefix to RegExp i flag", () => {
    const { source, flags } = normalizeRuleRegex("(?i)bearer\\s+([A-Za-z0-9._\\-]{20,})");
    assert.equal(source, "bearer\\s+([A-Za-z0-9._\\-]{20,})");
    assert.match(flags, /i/);
    const re = new RegExp(source, flags);
    assert.ok(re.test("Authorization: Bearer dG9rZW5fc2VjcmV0X2Jhc2U2NF9oaWdoX2VudHJvcHlfdGVzdA=="));
  });

  test("normalizeRuleRegex converts combined PCRE inline flags (?is)", () => {
    const { source, flags } = normalizeRuleRegex("(?is)^secret\\..*token$");
    assert.equal(source, "^secret\\..*token$");
    assert.match(flags, /i/);
    assert.match(flags, /s/);
    const re = new RegExp(source, flags);
    assert.ok(re.test("secret.\nmultiline\ntoken"));
  });

  test("normalizeRuleRegex strips stacked inline flag groups", () => {
    const { source, flags } = normalizeRuleRegex("(?i)(?m)^Bearer\\s+token$");
    assert.equal(source, "^Bearer\\s+token$");
    assert.match(flags, /i/);
    assert.match(flags, /m/);
  });

  test("all shipped secret rules compile without silent drop", () => {
    const rules = loadSecretRules();
    const compiled = compileRules(rules);
    assert.equal(compiled.length, rules.length, "every shipped rule must compile");
    assert.deepEqual(
      compiled.map((r) => r.id).sort(),
      rules.map((r) => r.id).sort(),
    );
  });

  test("shipped bearer-token and generic-api-key rules compile and match", () => {
    const rules = loadSecretRules();
    const compiled = compileRules(rules);
    assert.ok(compiled.some((r) => r.id === "bearer-token"));
    assert.ok(compiled.some((r) => r.id === "generic-api-key"));

    const bearerText =
      'curl -H "Authorization: Bearer dG9rZW5fc2VjcmV0X2Jhc2U2NF9oaWdoX2VudHJvcHlfdGVzdA=="';
    const bearerFindings = scanSessionForSecrets(
      minimalSession({
        events: [
          {
            type: "assistant",
            text: "run",
            toolCalls: [{ id: "t1", name: "Bash", input: bearerText }],
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      rules,
    );
    assert.ok(bearerFindings.some((f) => f.ruleId === "bearer-token"));

    const apiKeyText = "export SERVICE_API_KEY=dG9rZW5fc2VjcmV0X2Jhc2U2NF9oaWdoX2VudHJvcHlfdGVzdA==";
    const apiFindings = scanSessionForSecrets(
      minimalSession({
        events: [
          {
            type: "assistant",
            text: "run",
            toolCalls: [{ id: "t1", name: "Bash", input: apiKeyText }],
            timestamp: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      rules,
    );
    assert.ok(apiFindings.some((f) => f.ruleId === "generic-api-key"));
  });
});