#!/usr/bin/env node
// Render one or more harness results.json files as a markdown table (one column per run).
// usage: node report.mjs runs/<a>/results.json [runs/<b>/results.json ...] [--per-query]
import { readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const showPerQuery = process.argv.includes("--per-query");

/** p-th percentile of one query's samples of `kind` across rounds (undefined when never run; NaN when one timed out). */
function perQuery(rows, q, kind, p, field = "ms") {
  const ms = (rows || []).filter((x) => x.query === q && x.kind === kind).map((x) => x[field]);
  if (!ms.length) return undefined;
  if (ms.some((v) => !Number.isFinite(v))) return NaN;
  ms.sort((a, b) => a - b);
  return ms[Math.min(ms.length - 1, Math.ceil((p / 100) * ms.length) - 1)];
}
const runs = files.map((f) => JSON.parse(readFileSync(f, "utf8")));
const f = (s) => (s && s.p50 != null ? `${Math.round(s.p50)} / ${Math.round(s.p90)}${s.fail ? ` (${s.fail} failed)` : ""}` : "—");
const target = {
  "CLI warm search, p50/p90 of per-query p50": "<150 p50",
  "CLI warm handoff, p50/p90 of per-query p50": "<150 p50",
  "CLI first search after sessions changed": "<150 p50",
  "CLI first search of a fresh start (nothing resident)": "<1000",
  "Hub fresh start: first search": "<1000",
  "UI top bar, last key → results (novel)": "<100 p50, <200 p90",
  "UI Runs filter, Enter → rows (novel)": "<100 p50, <200 p90",
  "UI Runs filter, Enter → complete count (novel)": "<100 p50, <200 p90",
  "UI while agents write: Runs complete count": "<100 p50, <200 p90",
  "UI during host pull: Runs complete count": "<100 p50, <200 p90",
  "UI deep link /sessions?filter= → rows": "—",
  "UI while agents write: top bar": "<100 p50, <200 p90",
  "UI while agents write: Runs Enter": "<100 p50, <200 p90",
  "CLI while agents write": "<150 p50",
  "UI during host pull: top bar": "<100 p50, <200 p90",
  "UI during host pull: Runs Enter": "<100 p50, <200 p90",
  "Hub idle CPU % (60 s, settled)": "<5",
};
const rows = [
  ["CLI warm search, p50/p90 of per-query p50", (r) => f(r.conditions.cliWarm?.search)],
  ["CLI warm handoff, p50/p90 of per-query p50", (r) => f(r.conditions.cliWarm?.handoff)],
  ["CLI first search after sessions changed", (r) => f(r.conditions.cliChanged?.search)],
  ["CLI first search of a fresh start (nothing resident)", (r) => f(r.conditions.cliFirst?.search)],
  ["Hub fresh start: first search", (r) => f(r.conditions.freshHub?.firstSearch)],
  ["Hub fresh start: spawn → first results (incl. page load)", (r) => (r.conditions.freshHub ? r.conditions.freshHub.rows.map((x) => x.spawnToResultsMs).join(", ") : "—")],
  ["UI top bar, last key → results (novel)", (r) => f(r.conditions.uiWarm?.summary["topbar.novel"])],
  ["UI Runs filter, Enter → rows (novel)", (r) => f(r.conditions.uiWarm?.summary["runsEnter.novel"])],
  ["UI Runs filter, Enter → complete count (novel)", (r) => f(r.conditions.uiWarm?.summary["runsComplete.novel"])],
  ["UI deep link /sessions?expr= → rows on screen", (r) => f(r.conditions.uiWarm?.summary["deepLink.novel"])],
  ["UI while agents write: top bar", (r) => f(r.conditions.uiIndexing?.summary["topbar.novel"])],
  ["UI while agents write: Runs Enter", (r) => f(r.conditions.uiIndexing?.summary["runsEnter.novel"])],
  ["UI while agents write: Runs complete count", (r) => f(r.conditions.uiIndexing?.summary["runsComplete.novel"])],
  ["CLI while agents write", (r) => f(r.conditions.uiIndexing?.cli?.search)],
  ["UI during host pull: top bar", (r) => f(r.conditions.uiPull?.summary["topbar.novel"])],
  ["UI during host pull: Runs Enter", (r) => f(r.conditions.uiPull?.summary["runsEnter.novel"])],
  ["UI during host pull: Runs complete count", (r) => f(r.conditions.uiPull?.summary["runsComplete.novel"])],
  ["Hub idle CPU % (60 s, settled)", (r) => (r.conditions.idle ? `${r.conditions.idle.cpuPct} (RSS ${r.conditions.idle.rssMB} MB)` : "—")],
  ["Hub idle CPU % after live load", (r) => (r.conditions.idleAfter ? `${r.conditions.idleAfter.cpuPct} (RSS ${r.conditions.idleAfter.rssMB} MB)` : "—")],
  ["Hub CPU % while agents write", (r) => (r.conditions.uiIndexing?.hubCpuDuring ? `${r.conditions.uiIndexing.hubCpuDuring.cpuPct}` : "—")],
  ["Cold index build (empty cache, CLI)", (r) => (r.coldIndexBuildMs ? `${r.coldIndexBuildMs}` : "—")],
];
console.log(`ms, p50 / p90 unless noted. Corpus: ${runs.map((r) => `${r.label}=${r.corpusSessions} sessions`).join(", ")}.\n`);
console.log(`| Condition | Target | ${runs.map((r) => r.label).join(" | ")} |`);
console.log(`|---|---|${runs.map(() => "---").join("|")}|`);
for (const [name, fn] of rows) console.log(`| ${name} | ${target[name] || ""} | ${runs.map(fn).join(" | ")} |`);

if (showPerQuery) {
  for (const r of runs) {
    console.log(`\n### ${r.label}: every query (ms; ✗ = over its limit, — = not run, T = timed out)\n`);
    console.log(`Head ${r.head || "?"}${r.dirty ? " (dirty tree)" : ""}; corpus ${JSON.stringify(r.corpusIdentity || {})}`);
    for (const [name, c] of [["while agents write", r.conditions.uiIndexing], ["during the host pull", r.conditions.uiPull]]) {
      if (c?.overlap) console.log(`Overlap ${name}: UI ${c.overlap.ui.inside}/${c.overlap.ui.rows} queries, CLI ${c.overlap.cli.inside}/${c.overlap.cli.rows} queries inside the writer window${c.overlap.queriesInsidePull === false ? " — NOT all inside the pull" : ""}`);
    }
    console.log("");
    const cols = [
      ["CLI search", (q) => r.conditions.cliWarm?.rows?.find((x) => x.query === q && x.cmd === "search")?.p50, 150],
      ["CLI handoff", (q) => r.conditions.cliWarm?.rows?.find((x) => x.query === q && x.cmd === "handoff")?.p50, 150],
      ["CLI writing", (q) => r.conditions.uiIndexing?.cli?.rows?.find((x) => x.query === q)?.ms, 150],
      ["CLI pull", (q) => r.conditions.uiPull?.cli?.rows?.find((x) => x.query === q)?.ms, 150],
      ["Top bar p50", (q) => perQuery(r.conditions.uiWarm?.rows, q, "topbar", 50), 100],
      ["Top bar p90", (q) => perQuery(r.conditions.uiWarm?.rows, q, "topbar", 90), 200],
      ["Runs Enter p50", (q) => perQuery(r.conditions.uiWarm?.rows, q, "runsEnter", 50), 100],
      ["Runs Enter p90", (q) => perQuery(r.conditions.uiWarm?.rows, q, "runsEnter", 90), 200],
      ["Runs count complete p50", (q) => perQuery(r.conditions.uiWarm?.rows, q, "runsEnter", 50, "completeMs"), 100],
      ["Top bar writing", (q) => r.conditions.uiIndexing?.rows?.find((x) => x.query === q && x.kind === "topbar")?.ms, 200],
      ["Runs writing", (q) => r.conditions.uiIndexing?.rows?.find((x) => x.query === q && x.kind === "runsEnter")?.ms, 200],
      ["Runs complete writing", (q) => r.conditions.uiIndexing?.rows?.find((x) => x.query === q && x.kind === "runsEnter")?.completeMs, 200],
      ["Top bar pull", (q) => r.conditions.uiPull?.rows?.find((x) => x.query === q && x.kind === "topbar")?.ms, 200],
      ["Runs pull", (q) => r.conditions.uiPull?.rows?.find((x) => x.query === q && x.kind === "runsEnter")?.ms, 200],
      ["Runs complete pull", (q) => r.conditions.uiPull?.rows?.find((x) => x.query === q && x.kind === "runsEnter")?.completeMs, 200],
      ["Deep link p50", (q) => perQuery(r.conditions.uiWarm?.rows, q, "deepLink", 50), 1000],
    ];
    console.log(`| Query | ${cols.map((c) => c[0]).join(" | ")} |`);
    console.log(`|---|${cols.map(() => "---").join("|")}|`);
    const qs = new Set([...(r.conditions.cliWarm?.rows || []).map((x) => x.query), ...(r.conditions.uiWarm?.rows || []).map((x) => x.query), ...(r.conditions.uiIndexing?.rows || []).map((x) => x.query)]);
    const misses = new Map(cols.map((c) => [c[0], 0]));
    for (const q of qs) {
      const cells = cols.map(([name, get, limit]) => {
        const row = get(q);
        if (row === undefined) return "—";
        if (!Number.isFinite(row)) { misses.set(name, misses.get(name) + 1); return "T"; }
        if (row > limit) { misses.set(name, misses.get(name) + 1); return `${Math.round(row)} ✗`; }
        return String(Math.round(row));
      });
      console.log(`| ${q.replace(/\|/g, "\\|")} | ${cells.join(" | ")} |`);
    }
    console.log(`\nQueries over their limit: ${[...misses].map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
}
