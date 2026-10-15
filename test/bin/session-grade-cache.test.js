import "../helpers/skip-lr-watch-env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { mkTmp } from "../helpers/fixtures.js";

test("offline HTML grade caching avoids rereads and invalidates on recording changes", () => {
  const home = mkTmp("tracequest-grade-cache-");
  try {
    // A fresh process/HOME guarantees no preloaded index can hide the cold path.
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { parseSession } from './src/parse.js';
      import { renderHTML } from './src/render.js';
      import { writeJsonl } from './test/helpers/fixtures.js';
      const path = process.env.HOME + '/.claude/projects/cache/session.jsonl';
      const lines = [
        {type:'user',message:{content:'Inspect source'}},
        {type:'assistant',message:{model:'claude-sonnet-4',content:[{type:'tool_use',id:'x',name:'Read',input:{file_path:'source.js'}}]}},
        {type:'user',message:{content:[{type:'tool_result',tool_use_id:'x',is_error:true,content:'error'}]}},
        {type:'assistant',message:{content:[{type:'text',text:'Done'}]}}
      ];
      writeJsonl(path, lines);
      let reads = 0;
      const original = fs.openSync;
      fs.openSync = function(file, ...args) {
        if (file === path) reads++;
        return original.call(this, file, ...args);
      };
      syncBuiltinESMExports();
      const parsed = parseSession(path, 'claude');
      const first = renderHTML(parsed);
      const firstReads = reads;
      assert.equal(renderHTML(parsed), first);
      assert.equal(reads, firstReads, 'cached HTML must not reread an unchanged recording');
      lines[2].message.content[0].is_error = false;
      writeJsonl(path, lines);
      const future = new Date(Date.now() + 5000);
      fs.utimesSync(path, future, future);
      const changed = parseSession(path, 'claude');
      const afterParse = reads;
      const next = renderHTML(changed);
      assert.ok(reads > afterParse, 'changed recording must refresh its grade');
      assert.notEqual(next, first, 'grade change must invalidate HTML even with unchanged event count and timestamps');
      assert.match(next, /"grade":\\{"score":95,"letter":"A"/);
      const lastReads = reads;
      assert.equal(renderHTML(changed), next);
      assert.equal(reads, lastReads);
    `], {
      cwd: join(import.meta.dirname, "../.."),
      env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
