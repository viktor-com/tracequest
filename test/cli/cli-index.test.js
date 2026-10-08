import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import { parseSession } from "../../src/parse.js";
import {
  buildHelp,
  RENDER_OUTPUT_OPTIONS,
  renderAndWrite,
  parseAndRender,
  version,
} from "../../src/cli/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function minimalClaudeJsonl() {
  const ts = "2026-05-20T12:00:00Z";
  return [
    JSON.stringify({
      type: "user",
      sessionId: "cli-test-1",
      message: { content: "hello" },
      timestamp: ts,
      uuid: "u1",
      isMeta: false,
    }),
    JSON.stringify({
      type: "assistant",
      message: { model: "m", content: [{ type: "text", text: "ok" }] },
      timestamp: ts,
      uuid: "a1",
    }),
  ].join("\n") + "\n";
}

describe("cli-commands buildHelp", () => {
  it("documents render, list, latest, import, serve, and presets", () => {
    const help = buildHelp();
    assert.match(help, /tracequest/);
    assert.match(help, /\brender\b/);
    assert.match(help, /\blist\b/);
    assert.match(help, /\blatest\b/);
    assert.match(help, /\bimport\b/);
    assert.match(help, /\bserve\b/);
    assert.match(help, /\bpresets\b/);
  });

  it("documents the import command with its options and example", () => {
    const help = buildHelp();
    assert.match(help, /import.*<source>.*cursor-cloud/);
    assert.match(help, /import Options:/);
    assert.match(help, /--dry-run/);
    assert.match(help, /--api-key <key>/);
    assert.match(help, /CURSOR_API_KEY/);
    assert.match(help, /tracequest import cursor-cloud --dry-run/);
  });

  it("documents find optional --filter, dual default limits, and bare find example", () => {
    const help = buildHelp();
    assert.match(help, /find.*\[expr\].*\[--filter <expr>\]/);
    assert.match(help, /default: 10 without any expr, 20 with an expr/);
    assert.match(help, /only with a filter expr/);
    assert.match(help, /tracequest find\n/);
    assert.match(help, /tracequest find "model:sonnet age:<7d"/);
  });

  it("exports RENDER_OUTPUT_OPTIONS keys used by bin router", () => {
    assert.ok(RENDER_OUTPUT_OPTIONS.help);
    assert.ok(RENDER_OUTPUT_OPTIONS.out);
    assert.ok(RENDER_OUTPUT_OPTIONS.preset);
    assert.ok(RENDER_OUTPUT_OPTIONS.open);
  });

  it("version matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    assert.equal(version, pkg.version);
  });
});

describe("cli-commands renderAndWrite", () => {
  it("writes HTML to explicit out path", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "cli-render-"));
    const jsonl = join(dir, "session.jsonl");
    const out = join(dir, "out.html");
    writeFileSync(jsonl, minimalClaudeJsonl());

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      const session = parseSession(jsonl, "claude");
      renderAndWrite(session, out, false);
      assert.ok(existsSync(out));
      const html = readFileSync(out, "utf8");
      assert.match(html, /<html/i);
      assert.ok(logs.some((l) => l.includes("Written:")));
    } finally {
      console.log = origLog;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("cli-commands parseAndRender", () => {
  it("parses jsonl and writes default-named html", () => {
    const dir = mkdtempSync(join(os.tmpdir(), "cli-parse-render-"));
    const jsonl = join(dir, "session.jsonl");
    writeFileSync(jsonl, minimalClaudeJsonl());
    const cwd = process.cwd();
    process.chdir(dir);

    const logs = [];
    const origLog = console.log;
    console.log = (...a) => logs.push(a.join(" "));
    try {
      parseAndRender(jsonl, { out: join(dir, "rendered.html"), open: false });
    } finally {
      console.log = origLog;
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }

    assert.ok(logs.some((l) => l.includes("Parsing session")));
    assert.ok(logs.some((l) => l.includes("Written:")));
  });
});
