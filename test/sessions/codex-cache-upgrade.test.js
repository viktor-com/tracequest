import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const fixtures = fileURLToPath(new URL("../fixtures/codex-tool-outcomes/", import.meta.url));

for (const transport of ["javascript", "default"]) {
  test(`unchanged Codex recording upgrades a warmed main-v10 cache (${transport})`, () => {
    const home = mkdtempSync(join(tmpdir(), "tq-codex-upgrade-"));
    try {
      const file = join(home, ".codex/sessions/rollout-patch.jsonl");
      mkdirSync(join(home, ".codex/sessions"), { recursive: true });
      cpSync(join(fixtures, "patch-failure.jsonl"), file);
      const recordingMtime = statSync(file).mtimeMs;
      const mtime = Math.round(recordingMtime);
      // Captured from main's real buildIndex on this same fixture. Only the
      // temporary path and mtime are rebound; the recording does not change.
      const legacy = JSON.parse(readFileSync(join(fixtures, "main-v10-index.json"), "utf8"));
      legacy.session.mtime = mtime;
      const cacheFile = join(home, ".cache/tracequest/index.json");
      mkdirSync(join(home, ".cache/tracequest"), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ _v: legacy._v, [file]: legacy.session }));
      const env = { ...process.env, HOME: home, TRACEQUEST_NO_SIDECAR: transport === "javascript" ? "1" : "0", TRACEQUEST_SKIP_LR_WATCH: "1" };
      delete env.TRACEQUEST_CACHE_DIR;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import {statSync} from 'node:fs';
        import {buildIndex} from './src/sessions.js';
        const file=${JSON.stringify(file)}; const stat=statSync(file);
        const row={path:file,source:'codex',mtime:stat.mtime,size:stat.size};
        console.log(JSON.stringify(buildIndex([row]).get(file)));
      `], { cwd: ROOT, env, encoding: "utf8", timeout: 15_000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).errors, 1, "old zero-error metadata must be rebuilt");
      assert.equal(statSync(file).mtimeMs, recordingMtime);
      const saved = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(saved._v, 11);
      assert.equal(saved[file].errors, 1);
      assert.equal(saved[file].mtime, mtime);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
}
