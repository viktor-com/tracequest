#!/usr/bin/env node
// Ranking-equality gate: top-10 session ids of `search --json --limit 10` and
// `handoff --limit 10` for the 26 original queries, per build, on one corpus.
// Both builds start from a copy of the SAME index cache (fresh index builds can
// order BM25 ties differently), and the --filter query runs last.
//
// record:  node top10.mjs record --build <dir> --corpus <home> --cache <seed cache dir> --out <file> [--no-sidecar]
// compare: node top10.mjs compare <base.json> <cand.json>
import { spawnSync, execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = new URL(".", import.meta.url).pathname;
const [mode, ...rest] = process.argv.slice(2);
const Q = JSON.parse(readFileSync(join(HERE, "queries.json"), "utf8"));
const queries = [...Q.original26.map((query) => ({ query })), ...Q.original26_filtered];

if (mode === "record") {
  const { values: o } = parseArgs({ args: rest, options: { build: { type: "string" }, corpus: { type: "string" }, cache: { type: "string" }, out: { type: "string" }, "no-sidecar": { type: "boolean" }, cwd: { type: "string", default: join(process.env.HOME, "tqbench/cwd/tracequest") } } });
  const work = `${resolve(o.out)}.cache`;
  rmSync(work, { recursive: true, force: true });
  execFileSync("cp", ["-a", "--reflink=auto", resolve(o.cache), work]);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TRACEQUEST_") || k === "TRACEQUEST_NO_SEARCH_DAEMON")), HOME: resolve(o.corpus), TRACEQUEST_CACHE_DIR: work, NO_COLOR: "1", FORCE_COLOR: "0", TRACEQUEST_NO_RESULT_CACHE: "1", TRACEQUEST_NEAR_CACHE: "0" };
  if (o["no-sidecar"]) env.TRACEQUEST_NO_SIDECAR = "1";
  const tq = (args) => {
    const r = spawnSync("node", [join(resolve(o.build), "bin/tracequest.js"), ...args], { cwd: o.cwd, env, encoding: "utf8", maxBuffer: 256 << 20 });
    if (r.status !== 0) throw new Error(`tracequest ${args.join(" ")} exited ${r.status}: ${r.stderr.slice(-500)}`);
    return r.stdout;
  };
  const out = { build: resolve(o.build), corpus: resolve(o.corpus), sidecar: !o["no-sidecar"], queries: [] };
  for (const q of queries) {
    const f = q.filter ? ["--filter", q.filter] : [];
    const search = JSON.parse(tq(["search", q.query, ...f, "--limit", "10", "--json"])).map((r) => r.sessionHash);
    const handoff = [...tq(["handoff", q.query, ...f, "--limit", "10"]).matchAll(/^\d+\. Session `([0-9a-f]{8})`/gm)].map((m) => m[1]);
    out.queries.push({ ...q, search, handoff });
    console.error(`${search.length}/${handoff.length} ${q.query}${q.filter ? ` --filter ${q.filter}` : ""}`);
  }
  writeFileSync(o.out, JSON.stringify(out, null, 1));
  rmSync(work, { recursive: true, force: true });
} else if (mode === "compare") {
  const [a, b] = rest.map((f) => JSON.parse(readFileSync(f, "utf8")));
  let pass = 0, total = 0;
  for (const qa of a.queries) {
    const qb = b.queries.find((x) => x.query === qa.query && x.filter === qa.filter);
    for (const cmd of ["search", "handoff"]) {
      total++;
      const ok = qb && JSON.stringify(qa[cmd]) === JSON.stringify(qb[cmd]);
      if (ok) pass++;
      console.log(`${ok ? "PASS" : "FAIL"} ${cmd.padEnd(7)} ${qa.query}${qa.filter ? ` --filter ${qa.filter}` : ""}${ok ? "" : `\n  base: ${qa[cmd].join(" ")}\n  cand: ${qb ? qb[cmd].join(" ") : "(missing)"}`}`);
    }
  }
  console.log(`${pass}/${total} identical`);
  process.exit(pass === total ? 0 : 1);
} else {
  console.error("usage: top10.mjs record|compare ...");
  process.exit(2);
}
