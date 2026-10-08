import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BIN = join(ROOT, "bin/tracequest.js");
const NODE = process.execPath;
const WATCH_EXIT = 87;

function readProjectFile(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function withWatchTrap(args, { expectCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tracequest-startup-"));
  const trap = join(dir, "trap-watch.mjs");
  writeFileSync(
    trap,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
fs.watch = function tracequestStartupWatchTrap(path) {
  process.stderr.write("TRACEQUEST_STARTUP_WATCH " + String(path) + "\\n");
  process.exit(${WATCH_EXIT});
};
syncBuiltinESMExports();
`,
  );

  const env = { ...process.env };
  const importOpt = `--import=${pathToFileURL(trap).href}`;
  env.NODE_OPTIONS = env.NODE_OPTIONS ? `${env.NODE_OPTIONS} ${importOpt}` : importOpt;
  delete env.TRACEQUEST_SKIP_LR_WATCH;

  try {
    const result = spawnSync(NODE, [BIN, ...args], {
      cwd: ROOT,
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.notEqual(
      result.status,
      WATCH_EXIT,
      `${args.join(" ") || "(no args)"} started fs.watch during startup:\n${result.stderr}`,
    );
    assert.equal(result.status, expectCode, result.stderr || result.stdout);
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bin/tracequest.js startup", () => {
  it("keeps global help/version paths off live-reload watchers", () => {
    const cases = [
      { args: [], stdout: /Usage:/ },
      { args: ["--help"], stdout: /Commands:/ },
      { args: ["help"], stdout: /Commands:/ },
      { args: ["--version"], stdout: /^\d+\.\d+\.\d+/ },
    ];
    for (const { args, stdout } of cases) {
      const result = withWatchTrap(args);
      assert.match(result.stdout, stdout);
      assert.equal(result.stderr, "");
    }
  });

  it("keeps command help paths off command startup side effects", () => {
    const helpCases = [
      { args: ["render", "--help"], stdout: /Usage:/ },
      { args: ["serve", "--help"], stdout: /Usage:/ },
      { args: ["share", "--help"], stdout: /tracequest share/ },
      { args: ["presets", "--help"], stdout: /Usage:/ },
    ];
    for (const { args, stdout } of helpCases) {
      const result = withWatchTrap(args);
      assert.match(result.stdout, stdout);
      assert.equal(result.stderr, "");
    }
  });

  it("keeps early error paths off live-reload watchers", () => {
    const unknown = withWatchTrap(["not-a-command"], { expectCode: 1 });
    assert.equal(unknown.stdout, "");
    assert.match(unknown.stderr, /Unknown command/);

    const badServe = withWatchTrap(["serve", "--port", "0"], { expectCode: 1 });
    assert.equal(badServe.stdout, "");
    assert.match(badServe.stderr, /Invalid port/);
  });

  it("does not statically import command implementations from the bin entrypoint", () => {
    const src = readProjectFile("bin/tracequest.js");
    assert.doesNotMatch(src, /from ["']\.\.\/src\/cli\/index\.js["']/);
    assert.doesNotMatch(src, /from ["']\.\.\/src\/cli\/cli-commands\.js["']/);
    assert.match(src, /import\(["']\.\.\/src\/cli\/cli-commands\.js["']\)/);
  });

  it("starts live-reload watchers from serve, not from server-state import", () => {
    const serverState = readProjectFile("src/server/server-state.js");
    const withoutServeHook = serverState.replace(
      /export function startServerLiveReloadWatchers\(\) \{\n  startLiveReloadWatchers\(\{ srcDir: __srcDir, dataRoots, openCodeDbPath \}\);\n\}\n/,
      "",
    );
    assert.doesNotMatch(withoutServeHook, /startLiveReloadWatchers\(/);

    const server = readProjectFile("src/server.js");
    assert.match(server, /startServerLiveReloadWatchers\(\);/);
  });
});
