/** Plain-text rendering of the insights aggregates for `tracequest insights`. */
import { fmtCost, fmtTokens, formatDuration } from "../filter/filter-formats.js";

function pct(fraction) {
  return `${(fraction * 100).toFixed(1)}%`;
}

function hours(ms) {
  return `${(ms / 3600000).toFixed(1)} h`;
}

export function formatInsights(data) {
  const t = data.totals;
  const lines = [];
  lines.push(`insights: ${t.analyzed} sessions on ${t.hosts} machine${t.hosts === 1 ? "" : "s"}`
    + (t.pending ? ` (${t.pending} not analysed yet — run with --refresh)` : ""));
  lines.push(`  tool errors   ${t.errors} of ${t.calls} calls (${pct(t.errorRate)}), ${t.errorSessions} sessions with errors`);
  lines.push(`  agent time    ${hours(t.activeMs)} active, median ${formatDuration(data.time.medianActiveMs, { zeroLabel: "0s" })} per session`);
  lines.push(`  stalls        ${data.stalls.count} of 5 min or more, ${hours(data.stalls.ms)} waiting`);
  lines.push(`  retries       ${data.retries.retries} retries, ${data.retries.loops} loops (${data.retries.loopCalls} calls)`);
  lines.push(`  spend         ${fmtCost(t.cost, { zeroLabel: "$0", prefix: "$" })} estimated, ${fmtTokens(t.tokens, { zeroLabel: "0" })} tokens`);
  lines.push("");
  lines.push("machines:");
  for (const h of data.hub) {
    const pulled = h.state === "local" ? "" : `, last good pull ${h.lastSuccessAt || "never"}`;
    lines.push(`  ${h.host.padEnd(18)} ${h.state.padEnd(8)} ${String(h.sessions).padStart(6)} sessions${pulled}${h.error ? ` — ${h.error}` : ""}`);
  }
  lines.push("");
  lines.push("top error classes:");
  for (const c of data.classes.slice(0, 8)) {
    lines.push(`  ${c.label.padEnd(30)} ${String(c.count).padStart(6)}  ${pct(c.share).padStart(6)}  ${c.sessions} sessions`);
  }
  lines.push("");
  lines.push("error rate by harness:");
  for (const g of data.byHarness) {
    lines.push(`  ${g.key.padEnd(30)} ${pct(g.errorRate).padStart(6)}  ${g.errors} of ${g.calls} calls`);
  }
  lines.push("");
  lines.push("traps:");
  for (const trap of data.traps) {
    lines.push(`  ${trap.label.padEnd(30)} ${String(trap.sessions).padStart(6)} sessions, ${trap.events} times`
      + (trap.ms ? `, ${hours(trap.ms)} waiting` : ""));
  }
  return lines.join("\n");
}
