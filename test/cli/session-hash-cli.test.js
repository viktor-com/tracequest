import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cmdList,
  cmdMessages,
  cmdSearch,
  resolveCliSessionInput,
} from "../../src/cli/cli-commands.js";
import { sessionHash } from "../../src/sessions/session-hash.js";

function captureExit(fn) {
  const origExit = process.exit;
  const origLog = console.log;
  const origError = console.error;
  const logs = [];
  const errors = [];
  let code;
  process.exit = (c) => {
    code = c;
    throw new Error("process.exit");
  };
  console.log = (...args) => logs.push(args.join(" "));
  console.error = (...args) => errors.push(args.join(" "));
  try {
    fn();
    return { exited: false, code, logs, errors };
  } catch (err) {
    if (err.message !== "process.exit") throw err;
    return { exited: true, code, logs, errors };
  } finally {
    process.exit = origExit;
    console.log = origLog;
    console.error = origError;
  }
}

function captureStdout(fn) {
  const origWrite = process.stdout.write;
  const origError = console.error;
  const chunks = [];
  const errors = [];
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  console.error = (...args) => errors.push(args.join(" "));
  try {
    fn();
    return { stdout: chunks.join(""), errors };
  } finally {
    process.stdout.write = origWrite;
    console.error = origError;
  }
}

async function withTempHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tq-session-hash-cli-"));
  const oldHome = process.env.HOME;
  const oldNoSidecar = process.env.TRACEQUEST_NO_SIDECAR;
  process.env.HOME = home;
  process.env.TRACEQUEST_NO_SIDECAR = "1";
  try {
    await fn(home);
  } finally {
    process.env.HOME = oldHome;
    if (oldNoSidecar === undefined) delete process.env.TRACEQUEST_NO_SIDECAR;
    else process.env.TRACEQUEST_NO_SIDECAR = oldNoSidecar;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function seedClaude(home, name, prompt) {
  const dir = path.join(home, ".claude", "projects", "hash-cli");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    [
      JSON.stringify({
        type: "user",
        sessionId: `native-${name}`,
        timestamp: "2026-06-03T12:00:00.000Z",
        uuid: `u-${name}`,
        isMeta: false,
        message: { content: prompt },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-03T12:00:01.000Z",
        uuid: `a-${name}`,
        message: { model: "claude-test", content: [{ type: "text", text: `reply ${prompt}` }] },
      }),
    ].join("\n") + "\n"
  );
  return file;
}

describe("CLI session hashes", () => {
  test("list and search outputs show the path-derived hash", async () => {
    await withTempHome(async (home) => {
      const file = seedClaude(home, "one.jsonl", "hash-cli-needle");
      const hash = sessionHash(file);

      const list = captureExit(() => cmdList([], { limit: 5 }));
      assert.equal(list.exited, true);
      assert.equal(list.code, 0);
      assert.match(list.logs.join("\n"), new RegExp(hash));

      const search = captureExit(() => cmdSearch(["hash-cli-needle"], { limit: 5 }));
      assert.equal(search.exited, true);
      assert.equal(search.code, 0);
      assert.match(search.logs.join("\n"), new RegExp(hash));
    });
  });

  test("hash input resolves anywhere a CLI session path is accepted", async () => {
    await withTempHome(async (home) => {
      const file = seedClaude(home, "messages.jsonl", "hash input prompt");
      const hash = sessionHash(file);
      assert.equal(resolveCliSessionInput(hash), file);

      const { stdout } = captureStdout(() => cmdMessages([hash], { format: "anthropic", pretty: true }));
      const exported = JSON.parse(stdout);
      const messages = Array.isArray(exported) ? exported : exported.messages;
      assert.equal(messages[0].role, "user");
      assert.match(JSON.stringify(messages), /hash input prompt/);
    });
  });
});
