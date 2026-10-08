import "./helpers/skip-lr-watch-env.js";
import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fetchSession } from "../src/server/server-helpers.js";
import { mockHttpResponse } from "./helpers/capture-json-handler.js";

describe("fetchSession", () => {
  it("returns 400 when path query param is missing", async () => {
    const res = mockHttpResponse();
    const url = new URL("http://localhost/view");
    const session = await fetchSession(url, async () => ({}), res);
    assert.equal(session, null);
    assert.equal(res.status, 400);
    assert.equal(res.body, "Missing path");
  });

  it("returns 403 when path fails isSessionPath validation", async () => {
    const res = mockHttpResponse();
    const url = new URL("http://localhost/view?path=/etc/passwd");
    const session = await fetchSession(url, async () => ({}), res);
    assert.equal(session, null);
    assert.equal(res.status, 403);
    assert.match(res.body, /Forbidden/);
  });

  it("returns parsed session for valid opencode virtual path", async () => {
    const res = mockHttpResponse();
    const path = "opencode://ses_1c558d1a8ffeLIDNXi2mi8401L";
    const url = new URL(`http://localhost/view?path=${encodeURIComponent(path)}`);
    const parsed = { sessionId: "ses_test", chapters: [] };
    const session = await fetchSession(url, async (p, source) => {
      assert.equal(p, path);
      assert.equal(source, undefined);
      return parsed;
    }, res);
    assert.strictEqual(session, parsed);
    assert.equal(res.status, undefined);
  });

  it("attaches agentHistory when claude subagent sidecar files exist", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-sidecar-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const proj = path.join(tmpHome, ".claude", "projects", "tq-proj");
      const sessionId = "sess-sidecar-test";
      const subDir = path.join(proj, sessionId, "subagents");
      fs.mkdirSync(subDir, { recursive: true });
      const sessionPath = path.join(proj, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionPath, '{"type":"user","timestamp":"2026-06-03T00:00:00.000Z"}\n');
      fs.writeFileSync(
        path.join(subDir, "agent-x.jsonl"),
        '{"type":"assistant","timestamp":"2026-06-03T00:00:01.000Z","text":"done"}\n',
      );

      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(url, async (p) => ({ sessionId: "parent", events: [], path: p }), res);

      assert.ok(session);
      assert.equal(res.status, undefined);
      assert.ok(Array.isArray(session.agentHistory));
      assert.equal(session.agentHistory.length, 1);
      assert.equal(session.agentHistory[0].agentId, "agent-x");
      assert.equal(session.agentHistory[0].record.text, "done");
      assert.equal(session.agentSidecarCount, 1);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("merges multiple sidecars into chronological agentHistory", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-multi-sidecar-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const proj = path.join(tmpHome, ".claude", "projects", "tq-proj");
      const sessionId = "sess-multi";
      const subDir = path.join(proj, sessionId, "subagents");
      fs.mkdirSync(subDir, { recursive: true });
      const sessionPath = path.join(proj, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionPath, '{"type":"user"}\n');
      fs.writeFileSync(
        path.join(subDir, "agent-b.jsonl"),
        '{"type":"assistant","timestamp":"2026-06-03T00:00:02.000Z","text":"later"}\n',
      );
      fs.writeFileSync(
        path.join(subDir, "agent-a.jsonl"),
        '{"type":"user","timestamp":"2026-06-03T00:00:01.000Z","text":"earlier"}\n',
      );

      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(
        url,
        async (p) => ({ sessionId: "parent", events: [{ n: 1 }], path: p }),
        res,
      );

      assert.ok(session);
      assert.equal(session.events.length, 1);
      assert.equal(session.agentSidecarCount, 2);
      assert.equal(session.agentHistory.length, 2);
      assert.deepEqual(
        session.agentHistory.map((e) => e.record.text),
        ["earlier", "later"],
      );
      assert.deepEqual(
        session.agentHistory.map((e) => e.agentId),
        ["agent-a", "agent-b"],
      );
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("omits agentHistory when sidecar files exist but contain no parseable lines", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-empty-sidecar-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const proj = path.join(tmpHome, ".claude", "projects", "tq-proj");
      const sessionId = "sess-empty-sidecar";
      const subDir = path.join(proj, sessionId, "subagents");
      fs.mkdirSync(subDir, { recursive: true });
      const sessionPath = path.join(proj, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionPath, '{"type":"user"}\n');
      fs.writeFileSync(path.join(subDir, "agent-empty.jsonl"), "{not json\n\n");

      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(url, async () => ({ events: [] }), res);

      assert.ok(session);
      assert.equal(session.agentHistory, undefined);
      assert.equal(session.agentSidecarCount, undefined);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("omits agentHistory when subagents directory is empty", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-dir-sidecar-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const proj = path.join(tmpHome, ".claude", "projects", "tq-proj");
      const sessionId = "sess-dir-only";
      const subDir = path.join(proj, sessionId, "subagents");
      fs.mkdirSync(subDir, { recursive: true });
      const sessionPath = path.join(proj, `${sessionId}.jsonl`);
      fs.writeFileSync(sessionPath, '{"type":"user"}\n');

      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(url, async () => ({ events: [] }), res);

      assert.ok(session);
      assert.equal(session.agentHistory, undefined);
      assert.equal(session.agentSidecarCount, undefined);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("omits agentHistory when no sidecar directory exists", async () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-no-sidecar-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const proj = path.join(tmpHome, ".claude", "projects", "tq-proj");
      fs.mkdirSync(proj, { recursive: true });
      const sessionPath = path.join(proj, "solo.jsonl");
      fs.writeFileSync(sessionPath, '{"type":"user"}\n');

      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(url, async () => ({ events: [] }), res);

      assert.ok(session);
      assert.equal(session.agentHistory, undefined);
      assert.equal(session.agentSidecarCount, undefined);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("attaches agentHistory when cursor subagent sidecar files exist", async () => {
    // realpath keeps the canonical session path under the $HOME prefix allowlist on macOS
    const tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fetch-cursor-sidecar-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const uuid = "519aed76-0000-0000-0000-000000000001";
      const uuidDir = path.join(tmpHome, ".cursor", "projects", "tq-proj", "agent-transcripts", uuid);
      const subDir = path.join(uuidDir, "subagents");
      fs.mkdirSync(subDir, { recursive: true });
      const sessionPath = path.join(uuidDir, `${uuid}.jsonl`);
      fs.writeFileSync(
        sessionPath,
        '{"role":"user","message":{"content":[{"type":"text","text":"parent prompt"}]}}\n',
      );
      fs.writeFileSync(
        path.join(subDir, "sub-agent-1.jsonl"),
        '{"role":"user","message":{"content":[{"type":"text","text":"scan the diff for bugs"}]}}\n' +
          '{"role":"assistant","message":{"content":[{"type":"text","text":"found two issues"}]}}\n',
      );

      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(url, async (p) => ({ sessionId: "parent", events: [], path: p }), res);

      assert.ok(session);
      assert.equal(res.status, undefined);
      assert.ok(Array.isArray(session.agentHistory));
      assert.equal(session.agentHistory.length, 2);
      assert.ok(session.agentHistory.every((e) => e.agentId === "sub-agent-1"));
      assert.ok(session.agentHistory.every((e) => e.timestampMs === null));
      assert.deepEqual(
        session.agentHistory.map((e) => [e.record.type, e.record.text]),
        [
          ["user", "scan the diff for bugs"],
          ["assistant", "found two issues"],
        ],
      );
      assert.equal(session.agentSidecarCount, 1);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("omits agentHistory for cursor parents without a subagents directory", async () => {
    const tmpHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "fetch-cursor-solo-"));
    const originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
    try {
      const uuid = "519aed76-0000-0000-0000-000000000002";
      const uuidDir = path.join(tmpHome, ".cursor", "projects", "tq-proj", "agent-transcripts", uuid);
      fs.mkdirSync(uuidDir, { recursive: true });
      const sessionPath = path.join(uuidDir, `${uuid}.jsonl`);
      fs.writeFileSync(
        sessionPath,
        '{"role":"user","message":{"content":[{"type":"text","text":"solo prompt"}]}}\n',
      );

      const res = mockHttpResponse();
      const url = new URL(`http://localhost/view?path=${encodeURIComponent(sessionPath)}`);
      const session = await fetchSession(url, async () => ({ events: [] }), res);

      assert.ok(session);
      assert.equal(session.agentHistory, undefined);
      assert.equal(session.agentSidecarCount, undefined);
    } finally {
      process.env.HOME = originalHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("returns 500 and logs when parseSession throws", async () => {
    const res = mockHttpResponse();
    const path = "opencode://ses_17d0929beffeDWDAOOZMIKY7bq";
    const url = new URL(`http://localhost/view?path=${encodeURIComponent(path)}`);
    const errorSpy = mock.method(console, "error", () => {});

    try {
      const session = await fetchSession(url, async () => {
        throw new Error("parse boom");
      }, res);
      assert.equal(session, null);
      assert.equal(res.status, 500);
      assert.equal(res.body, "Error parsing session");
      assert.equal(res.headers["Content-Type"], "text/plain");
      assert.ok(errorSpy.mock.calls.length >= 1);
      assert.match(String(errorSpy.mock.calls[0].arguments[0]), /fetchSession parse error/);
      assert.match(String(errorSpy.mock.calls[0].arguments[2]), /parse boom/);
    } finally {
      errorSpy.mock.restore();
    }
  });
});