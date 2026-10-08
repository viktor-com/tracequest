import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { loadHubConfig } from "../../src/hub/config.js";
import { runSshImport } from "../../src/import/ssh-import.js";

function withConfig(config, fn) {
  const dir = mkdtempSync(join(tmpdir(), "tq-config-"));
  const file = join(dir, "hub.json");
  writeFileSync(file, JSON.stringify(config));
  try { return fn(file, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("hub config resolves paths beside its file and rejects invalid configuration", () => {
  withConfig({ home: "home", cacheDir: "cache", hostsDir: "archive", hosts: [], serve: { hub: true, port: 7780 } }, (file, dir) => {
    const config = loadHubConfig(file);
    assert.equal(config.home, join(dir, "home"));
    assert.equal(config.cacheDir, join(dir, "cache"));
    assert.equal(config.hostsDir, join(dir, "archive"));
  });
  for (const bad of [[], { serve: { port: 0 } }, { hosts: [{ spec: "source", hostId: "../escape" }] }, { hosts: [{ spec: "source", hostId: "builder", sources: { unknown: "traces" } }] }, { cacheDir: "" }, { checkoutPatterns: ["["] }, { typo: true }]) {
    withConfig(bad, (file) => assert.throws(() => loadHubConfig(file), /Invalid hub config/));
  }
});

test("CLI config uses only its local traces and keeps all three caches together", () => {
  const root = mkdtempSync(join(tmpdir(), "tq-config-example-"));
  cpSync(resolve("examples/hub"), root, { recursive: true, filter: (p) => !p.includes("/state") });
  const file = join(root, "config.json");
  try {
    const result = spawnSync(process.execPath, ["bin/tracequest.js", "insights", "--refresh", "--json", "--config", file], {
      encoding: "utf8", env: { ...process.env, TRACEQUEST_NO_SIDECAR: "1", TRACEQUEST_SKIP_LR_WATCH: "1" }, timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(result.stdout);
    assert.equal(data.totals.sessions, 1);
    assert.equal(data.totals.analyzed, 1);
    assert.equal(data.totals.errors, 1);
    const paths = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {loadHubConfig,applyHubConfig} from './src/hub/config.js';
      import {indexPath} from './src/sessions/index-writers.js';
      import {searchIdxPath} from './src/sessions/search-index.js';
      import {insightsCachePath} from './src/insights/store.js';
      import {loadImportHostsFile} from './src/import/ssh-import.js';
      applyHubConfig(loadHubConfig(${JSON.stringify(file)}));
      console.log(JSON.stringify([indexPath(),searchIdxPath(),insightsCachePath(),loadImportHostsFile()]));
    `], { encoding: "utf8", timeout: 30_000 });
    assert.equal(paths.status, 0, paths.stderr);
    const cache = join(root, "state/cache");
    assert.deepEqual(JSON.parse(paths.stdout), [join(cache, "index.json"), join(cache, "search.idx"), join(cache, "insights.json"), []]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SSH source config selects providers and routes custom paths to canonical archives", async () => {
  const root = mkdtempSync(join(tmpdir(), "tq-config-import-"));
  const previous = process.env.TRACEQUEST_HOSTS_DIR;
  process.env.TRACEQUEST_HOSTS_DIR = root;
  const calls = [];
  try {
    const result = await runSshImport({ hosts: [{ spec: "dev@source.example", hostId: "builder", sources: { claude: "/srv/traces/claude" } }],
      runSsh: async () => ({ status: 0, stdout: "", stderr: "" }),
      runRsync: async (args) => { calls.push(args); return { status: 0, stdout: ">f+++++++++ sample.jsonl\n", stderr: "" }; }, out: () => {}, warn: () => {} });
    assert.equal(result.checked, 1);
    assert.equal(result.failed, 0);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes("dev@source.example:/srv/traces/claude/"));
    assert.ok(calls[0].includes(`${join(root, "builder", ".claude", "projects")}/`));
  } finally {
    if (previous === undefined) delete process.env.TRACEQUEST_HOSTS_DIR; else process.env.TRACEQUEST_HOSTS_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("custom checkout patterns enable path-bleed analysis without deployment code", () => {
  withConfig({ checkoutPatterns: ["/checkouts/[^/]+/"] }, (file) => {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import {loadHubConfig,applyHubConfig} from './src/hub/config.js';
      import {isPathBleed} from './src/insights/classify.js';
      applyHubConfig(loadHubConfig(${JSON.stringify(file)}));
      console.log(JSON.stringify([
        isPathBleed('/checkouts/build-1/shop', '/checkouts/build-2/shop/src/a.js'),
        isPathBleed('/checkouts/build-1/shop', '/checkouts/build-1/shop/src/a.js'),
        isPathBleed('/checkouts/build-1/shop', '/checkouts/build-2/docs/src/a.js')
      ]));
    `], { encoding: "utf8", timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [true, false, false]);
  });
});
