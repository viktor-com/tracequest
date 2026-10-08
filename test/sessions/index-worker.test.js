import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  Worker,
  MessageChannel,
  receiveMessageOnPort,
} from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { mkTmp, writeJsonl } from "../helpers/fixtures.js";

const WORKER_URL = new URL("../../src/sessions/index-worker.js", import.meta.url);
const CORE_URL = new URL("../../src/sessions/session-index-core.js", import.meta.url);
const MOCK_CORE = "../../test/fixtures/index-worker-session-index-core-mock.mjs";
const MOCK_CORE_BOOM = "../../test/fixtures/index-worker-session-index-core-boom.mjs";

function workerImportTarget(relativeFromWorker) {
  return new URL(relativeFromWorker, WORKER_URL).href;
}

function spawnIndexWorker(sessions, { coreFixture, timeoutMs = 8000 } = {}) {
  const prevCore = process.env.TRACEQUEST_TEST_SESSION_INDEX_CORE;
  if (coreFixture) process.env.TRACEQUEST_TEST_SESSION_INDEX_CORE = coreFixture;
  else delete process.env.TRACEQUEST_TEST_SESSION_INDEX_CORE;

  const workerCount = 1;
  const sab = new SharedArrayBuffer(4 * workerCount);
  const signals = new Int32Array(sab);
  const ch = new MessageChannel();

  const worker = new Worker(WORKER_URL, {
    workerData: {
      sessions,
      sab,
      workerIndex: 0,
      port: ch.port1,
    },
    transferList: [ch.port1],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (prevCore === undefined) delete process.env.TRACEQUEST_TEST_SESSION_INDEX_CORE;
      else process.env.TRACEQUEST_TEST_SESSION_INDEX_CORE = prevCore;
      fn();
    };

    const timer = setTimeout(() => {
      worker.terminate().catch(() => {});
      finish(() => reject(new Error("index-worker did not signal within timeout")));
    }, timeoutMs);

    worker.once("error", (err) => {
      worker.terminate().catch(() => {});
      finish(() => reject(err));
    });
    worker.once("exit", (code) => {
      if (!settled && code !== 0) {
        finish(() => reject(new Error(`index-worker exited with code ${code}`)));
      }
    });

    const waitResult = Atomics.wait(signals, 0, 0, timeoutMs);
    if (waitResult === "timed-out") {
      worker.terminate().catch(() => {});
      return finish(() => reject(new Error("Atomics.wait timed out")));
    }

    const msg = receiveMessageOnPort(ch.port2);
    finish(() => resolve({ message: msg?.message, waitResult, signals }));
  });
}

describe("index-worker import paths", () => {
  test("session-index-core resolves as sibling under src/sessions after reorg", () => {
    const fromWorker = workerImportTarget("./session-index-core.js");
    assert.equal(fromWorker, CORE_URL.href);
    assert.ok(fs.existsSync(fileURLToPath(CORE_URL)), "session-index-core.js must exist");
  });
});

describe("index-worker spawn", () => {
  test("indexes sessions via session-index-core import", async () => {
    const tmpDir = mkTmp("tq-index-worker-");
    const filePath = path.join(tmpDir, "probe.jsonl");
    writeJsonl(filePath, [
      {
        type: "user",
        message: { content: "worker probe" },
        timestamp: "2026-05-01T00:00:00Z",
      },
    ]);

    try {
      const { message, waitResult } = await spawnIndexWorker([
        { path: filePath, source: "claude" },
      ]);
      assert.equal(waitResult, "ok");
      assert.ok(message[filePath], "worker should post per-path results");
      assert.equal(message[filePath].firstPrompt, "worker probe");
      // termFreqs is a Map (structured-clone serializable) over the worker message channel
      const tf = message[filePath].termFreqs;
      assert.ok(tf instanceof Map && (tf.has('worker') || tf.has('probe')), "termFreqs should contain tokens from 'worker probe'");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("loads mock session-index-core fixture when test env is set", async () => {
    const sessions = [
      { path: "/tmp/tq-iw-mock/a.jsonl", source: "claude" },
      { path: "/tmp/tq-iw-mock/b.jsonl", source: "codex" },
    ];
    const { message } = await spawnIndexWorker(sessions, { coreFixture: MOCK_CORE });
    assert.equal(message["/tmp/tq-iw-mock/a.jsonl"].firstPrompt, "mock-a.jsonl");
    assert.equal(message["/tmp/tq-iw-mock/b.jsonl"].firstPrompt, "mock-b.jsonl");
  });

  test("posts _error when mock session-index-core throws", async () => {
    const { message } = await spawnIndexWorker(
      [{ path: "/tmp/tq-iw-err.jsonl", source: "claude" }],
      { coreFixture: MOCK_CORE_BOOM }
    );
    assert.equal(message._error, "mock session-index-core boom");
  });
});