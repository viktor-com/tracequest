/**
 * /insights — where agents waste time and fail, across every collected machine
 * (facts inspg, inspd, inspr). Server-rendered and script-free: every figure is
 * a labelled row that opens onto the example sessions behind it.
 */
import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { esc } from "../server/server-html-helpers.js";
import { fmtCost, fmtTokens, formatDuration } from "../filter/filter-formats.js";
import { INSIGHTS_RANGES } from "../insights/load.js";

const INSIGHTS_PAGE_CSS = `
.container { max-width: 1120px; margin: 0 auto; padding: 28px 24px 80px; }
.ins-header { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
.ins-title { font-size: 24px; font-weight: 400; letter-spacing: -0.02em; }
.ins-title a { color: var(--fg2); text-decoration: none; }
.ins-title a:hover { color: var(--fg); }
.ins-subtitle { color: var(--fg2); font-size: 13px; }
.ins-lede { color: var(--fg2); max-width: 760px; margin-bottom: 18px; }
.ins-scope { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 22px; }
.ins-scope-input {
  flex: 1 1 260px; min-width: 200px; background: var(--surface); color: var(--fg);
  border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px;
  font-family: var(--mono); font-size: 12px;
}
.ins-scope-input:focus { outline: 1px solid var(--accent); }
.ins-chip {
  color: var(--fg2); background: var(--surface); border: 1px solid var(--border);
  border-radius: 999px; padding: 4px 11px; font-size: 12px; text-decoration: none; cursor: pointer;
  font-family: var(--sans);
}
.ins-chip:hover { color: var(--fg); }
.ins-chip[aria-current="true"] { color: var(--bg); border-color: var(--fg); background: var(--fg); }
.ins-note {
  border: 1px solid var(--border); border-left: 2px solid var(--orange); border-radius: 6px;
  background: var(--surface); color: var(--fg2); padding: 9px 12px; font-size: 12.5px; margin-bottom: 18px;
}
.ins-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-bottom: 30px; }
.ins-tile { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.ins-tile-val { font-size: 28px; font-weight: 400; letter-spacing: -0.02em; line-height: 1.15; }
.ins-tile-label { color: var(--fg); font-size: 12.5px; margin-top: 4px; }
.ins-tile-sub { color: var(--fg3); font-size: 11.5px; margin-top: 2px; }
.ins-section { margin-bottom: 34px; }
.ins-section-title { font-size: 16px; font-weight: 500; letter-spacing: -0.01em; margin-bottom: 2px; }
.ins-section-sub { color: var(--fg2); font-size: 12.5px; margin-bottom: 12px; max-width: 760px; }
.ins-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 26px; }
.ins-bars { display: flex; flex-direction: column; gap: 2px; }
.ins-bar-row { border-radius: 6px; }
.ins-bar-row[open] { background: var(--surface); }
.ins-bar-head {
  display: grid; grid-template-columns: minmax(150px, 220px) 1fr auto; gap: 12px; align-items: center;
  padding: 6px 8px; cursor: pointer; list-style: none; border-radius: 6px;
}
.ins-bar-head::-webkit-details-marker { display: none; }
.ins-bar-head:hover { background: var(--surface2); }
.ins-bar-head:focus-visible { outline: 1px solid var(--accent); }
.ins-bar-label { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ins-bar-label::before { content: "▸"; color: var(--fg3); display: inline-block; width: 14px; font-size: 10px; }
.ins-bar-row[open] > .ins-bar-head .ins-bar-label::before { content: "▾"; }
.ins-bar-track { height: 10px; border-radius: 4px; background: transparent; }
.ins-bar-fill { height: 10px; min-width: 2px; border-radius: 0 4px 4px 0; background: var(--fg2); }
.ins-bar-val { font-family: var(--mono); font-size: 12px; color: var(--fg); text-align: right; white-space: nowrap; }
.ins-bar-val small { color: var(--fg3); font-size: 11px; margin-left: 6px; }
.ins-detail { padding: 4px 10px 12px 30px; }
.ins-detail-meta { color: var(--fg2); font-size: 12px; margin-bottom: 6px; }
.ins-examples { display: flex; flex-direction: column; gap: 4px; }
.ins-example {
  display: block; text-decoration: none; color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 7px 10px; background: var(--bg);
}
.ins-example:hover { border-color: rgba(255, 255, 255, 0.24); }
.ins-example-top { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.ins-example-src { font-family: var(--mono); font-size: 11px; color: var(--fg2); background: var(--surface2); border-radius: 4px; padding: 0 6px; }
.ins-example-project { color: var(--fg2); font-family: var(--mono); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
.ins-example-when { color: var(--fg3); font-size: 11px; margin-left: auto; white-space: nowrap; }
.ins-example-prompt { font-size: 12.5px; color: var(--fg); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-example-note { font-family: var(--mono); font-size: 11.5px; color: var(--fg2); margin-top: 2px; overflow-wrap: anywhere; }
.ins-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.ins-table th { text-align: left; color: var(--fg3); font-weight: 400; font-size: 12px; font-family: var(--sans); padding: 6px 8px; border-bottom: 1px solid var(--border); }
.ins-table td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.ins-table td.num, .ins-table th.num { text-align: right; font-family: var(--mono); white-space: nowrap; }
.ins-table a { color: var(--fg); text-decoration: none; }
.ins-table a:hover { color: var(--accent); }
.ins-table .ins-cell-sub { color: var(--fg3); font-size: 11.5px; font-family: var(--mono); overflow-wrap: anywhere; }
.ins-state { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; white-space: nowrap; }
.ins-state-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg3); }
.ins-state[data-state="fresh"] .ins-state-dot, .ins-state[data-state="local"] .ins-state-dot { background: var(--green); }
.ins-state[data-state="stale"] .ins-state-dot { background: var(--orange); }
.ins-state[data-state="failing"] .ins-state-dot { background: var(--red); border-radius: 2px; }
.ins-state[data-state="never"] .ins-state-dot { background: transparent; border: 1px solid var(--fg3); }
.ins-cols { display: flex; align-items: flex-end; gap: 8px; height: 150px; padding: 18px 4px 0; border-bottom: 1px solid var(--border); }
.ins-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
.ins-col-val { font-family: var(--mono); font-size: 11.5px; color: var(--fg2); margin-bottom: 4px; }
.ins-col-bar { width: 100%; max-width: 72px; min-height: 2px; background: var(--fg2); border-radius: 4px 4px 0 0; }
.ins-col:hover .ins-col-bar, .ins-bar-head:hover .ins-bar-fill { filter: brightness(1.2); }
.ins-col-labels { display: flex; gap: 8px; padding: 6px 4px 0; }
.ins-col-labels span { flex: 1; text-align: center; color: var(--fg2); font-size: 11.5px; }
.ins-facts { display: flex; gap: 22px; flex-wrap: wrap; margin-bottom: 12px; }
.ins-fact-val { font-size: 18px; font-weight: 500; }
.ins-fact-label { color: var(--fg2); font-size: 12px; }
.ins-traps { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; }
.ins-trap { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
.ins-trap-title { font-weight: 600; font-size: 13.5px; }
.ins-trap-hint { color: var(--fg2); font-size: 12px; margin: 2px 0 10px; min-height: 36px; }
.ins-trap-val { font-size: 22px; font-weight: 400; }
.ins-trap-val small { color: var(--fg2); font-size: 12px; font-weight: 400; margin-left: 4px; }
.ins-trap-sub { color: var(--fg2); font-size: 12px; }
.ins-trap details { margin-top: 10px; }
.ins-trap summary { color: var(--fg2); font-size: 12px; cursor: pointer; }
.ins-trap summary:hover { color: var(--fg); }
.ins-trap .ins-examples { margin-top: 8px; }
.ins-empty { color: var(--fg3); font-size: 12.5px; padding: 8px; }
.ins-foot { color: var(--fg3); font-size: 11.5px; margin-top: 30px; border-top: 1px solid var(--border); padding-top: 12px; }
@media (max-width: 560px) {
  .ins-grid { grid-template-columns: 1fr; }
  .ins-bar-head { grid-template-columns: 1fr auto; }
  .ins-bar-track { display: none; }
}
`;

function pct(fraction, digits = 1) {
  return `${(fraction * 100).toFixed(digits)}%`;
}

function num(n) {
  return Number(n || 0).toLocaleString("en-US");
}

function hours(ms) {
  const h = ms / 3600000;
  if (h >= 10) return `${Math.round(h)} h`;
  if (h >= 1) return `${h.toFixed(1)} h`;
  return `${Math.round(ms / 60000)} min`;
}

function ago(ms, now) {
  if (!ms) return "";
  const d = Math.max(0, now - ms);
  if (d < 3600000) return `${Math.max(1, Math.round(d / 60000))} min ago`;
  if (d < 48 * 3600000) return `${Math.round(d / 3600000)} h ago`;
  return `${Math.round(d / 86400000)} d ago`;
}

function viewHref(ref) {
  return `/view?path=${encodeURIComponent(ref.path)}&source=${encodeURIComponent(ref.source || "")}`;
}

function exampleHtml(ref, now) {
  return `<a class="ins-example" href="${esc(viewHref(ref))}">
  <div class="ins-example-top">
    <span class="ins-example-src">${esc(ref.source)}@${esc(ref.host)}</span>
    <span class="ins-example-project">${esc(ref.project)}</span>
    <span class="ins-example-when">${esc(ago(ref.mtime, now))}</span>
  </div>
  <div class="ins-example-prompt">${esc(ref.prompt || "(no prompt recorded)")}</div>
  ${ref.note ? `<div class="ins-example-note">${esc(ref.note)}</div>` : ""}
</a>`;
}

function examplesHtml(examples, now) {
  if (!examples?.length) return `<div class="ins-empty">No example sessions.</div>`;
  return `<div class="ins-examples">${examples.map((e) => exampleHtml(e, now)).join("\n")}</div>`;
}

/** One expandable bar row: label, bar, value; opens onto meta + example sessions. */
function barRow({ label, fraction, value, sub, meta, examples, title }, now) {
  const width = Math.max(0, Math.min(100, fraction * 100));
  return `<details class="ins-bar-row">
  <summary class="ins-bar-head" title="${esc(title || "")}">
    <span class="ins-bar-label">${esc(label)}</span>
    <span class="ins-bar-track"><span class="ins-bar-fill" style="display:block;width:${width.toFixed(1)}%"></span></span>
    <span class="ins-bar-val">${esc(value)}${sub ? `<small>${esc(sub)}</small>` : ""}</span>
  </summary>
  <div class="ins-detail">
    ${meta ? `<div class="ins-detail-meta">${esc(meta)}</div>` : ""}
    ${examplesHtml(examples, now)}
  </div>
</details>`;
}

function classBars(classes, now) {
  if (!classes.length) return `<div class="ins-empty">No tool errors in this scope.</div>`;
  const max = classes[0].count;
  return `<div class="ins-bars" data-insight="error-classes">${classes.map((c) => barRow({
    label: c.label,
    fraction: c.count / max,
    value: num(c.count),
    sub: pct(c.share, 0),
    meta: `${num(c.count)} failed tool calls in ${num(c.sessions)} sessions`,
    title: `${c.label}: ${num(c.count)} failed tool calls (${pct(c.share, 0)} of all errors) in ${num(c.sessions)} sessions`,
    examples: c.examples,
  }, now)).join("\n")}</div>`;
}

function rateBars(groups, id, now) {
  if (!groups.length) return `<div class="ins-empty">Nothing to show in this scope.</div>`;
  const max = Math.max(...groups.map((g) => g.errorRate), 0.0001);
  return `<div class="ins-bars" data-insight="${esc(id)}">${groups.map((g) => barRow({
    label: g.key,
    fraction: g.errorRate / max,
    value: pct(g.errorRate),
    sub: `${num(g.errors)} / ${num(g.calls)}`,
    meta: `${num(g.sessions)} sessions, ${num(g.errorSessions)} with errors. Top causes: `
      + (g.topClasses.map((c) => `${c.label} (${num(c.count)})`).join(", ") || "none"),
    title: `${g.key}: ${num(g.errors)} of ${num(g.calls)} tool calls failed (${pct(g.errorRate)})`,
    examples: g.examples,
  }, now)).join("\n")}</div>`;
}

const STATE_LABEL = { local: "this machine", fresh: "up to date", stale: "stale", failing: "pull failing", never: "never pulled" };

function hubTable(hub, now) {
  const rows = hub.map((h) => {
    const pulled = h.state === "local"
      ? "not needed"
      : h.lastSuccessAt ? ago(Date.parse(h.lastSuccessAt), now) : "never";
    const detail = h.error
      ? `${h.error}${h.consecutiveFailures > 1 ? ` (${h.consecutiveFailures} failed pulls in a row)` : ""}`
      : h.spec && h.spec !== h.host ? h.spec : "";
    return `<tr data-host="${esc(h.host)}" data-state="${esc(h.state)}">
  <td><a href="/insights?host=${encodeURIComponent(h.host)}">${esc(h.host)}</a>${detail ? `<div class="ins-cell-sub">${esc(detail)}</div>` : ""}</td>
  <td><span class="ins-state" data-state="${esc(h.state)}"><span class="ins-state-dot"></span>${esc(STATE_LABEL[h.state] || h.state)}</span></td>
  <td class="num">${num(h.sessions)}</td>
  <td class="num">${esc(h.newestSessionAt ? ago(h.newestSessionAt, now) : "—")}</td>
  <td class="num">${esc(pulled)}</td>
</tr>`;
  }).join("\n");
  return `<table class="ins-table" data-insight="machines">
<thead><tr><th>Machine</th><th>Collection</th><th class="num">Sessions collected</th><th class="num">Newest session</th><th class="num">Last good pull</th></tr></thead>
<tbody>${rows}</tbody></table>`;
}

function histogramHtml(buckets) {
  const max = Math.max(...buckets.map((b) => b.count), 1);
  return `<div class="ins-cols" data-insight="active-time">${buckets.map((b) => `<div class="ins-col" title="${esc(`${b.label}: ${num(b.count)} sessions`)}">
  <span class="ins-col-val">${num(b.count)}</span>
  <span class="ins-col-bar" style="height:${((b.count / max) * 100).toFixed(1)}%"></span>
</div>`).join("")}</div>
<div class="ins-col-labels">${buckets.map((b) => `<span>${esc(b.label)}</span>`).join("")}</div>`;
}

function expensiveTable(rows, now) {
  if (!rows.length) return `<div class="ins-empty">No token usage recorded in this scope.</div>`;
  return `<table class="ins-table" data-insight="expensive">
<thead><tr><th>Session</th><th class="num">Est. cost</th><th class="num">Tokens</th><th class="num">Active</th><th class="num">Errors</th></tr></thead>
<tbody>${rows.map((r) => `<tr>
  <td><a href="${esc(viewHref(r))}">${esc(r.prompt || "(no prompt recorded)")}</a>
    <div class="ins-cell-sub">${esc(r.source)}@${esc(r.host)} · ${esc(r.project)} · ${esc(r.model)} · ${esc(ago(r.mtime, now))}</div></td>
  <td class="num">${esc(fmtCost(r.cost, { zeroLabel: "—", prefix: "$" }))}</td>
  <td class="num">${esc(fmtTokens(r.tokens, { zeroLabel: "—" }))}</td>
  <td class="num">${esc(formatDuration(r.activeMs, { zeroLabel: "—" }))}</td>
  <td class="num">${num(r.errors)}</td>
</tr>`).join("\n")}</tbody></table>`;
}

function trapCards(traps, now) {
  return `<div class="ins-traps" data-insight="traps">${traps.map((t) => `<div class="ins-trap" data-trap="${esc(t.id)}">
  <div class="ins-trap-title">${esc(t.label)}</div>
  <div class="ins-trap-hint">${esc(t.hint)}</div>
  <div class="ins-trap-val">${num(t.sessions)}<small>sessions</small></div>
  <div class="ins-trap-sub">${num(t.events)} times${t.ms >= 60000 ? ` · ${esc(hours(t.ms))} waiting` : ""}</div>
  ${t.examples.length ? `<details><summary>Example sessions</summary>${examplesHtml(t.examples, now)}</details>` : ""}
</div>`).join("\n")}</div>`;
}

function scopeHref(query, patch) {
  const next = { ...query, ...patch };
  const params = new URLSearchParams();
  if (next.expr) params.set("expr", next.expr);
  if (next.days) params.set("days", String(next.days));
  if (next.host) params.set("host", next.host);
  const qs = params.toString();
  return qs ? `/insights?${qs}` : "/insights";
}

function fact(value, label) {
  return `<div><div class="ins-fact-val">${esc(value)}</div><div class="ins-fact-label">${esc(label)}</div></div>`;
}

function tile(value, label, sub) {
  return `<div class="ins-tile"><div class="ins-tile-val">${esc(value)}</div><div class="ins-tile-label">${esc(label)}</div><div class="ins-tile-sub">${esc(sub)}</div></div>`;
}

/** @param {object} data loadInsightsData() result */
export function insightsPage(data) {
  const now = Date.parse(data.generatedAt) || Date.now();
  const t = data.totals;
  const q = data.query || { expr: "", days: 0, host: "" };
  const rangeChips = [0, ...INSIGHTS_RANGES].map((d) => `<a class="ins-chip" href="${esc(scopeHref(q, { days: d }))}" aria-current="${q.days === d}">${d ? `last ${d} days` : "all time"}</a>`).join("\n");
  const notes = [];
  if (data.exprError) notes.push(`Filter ignored: ${data.exprError}`);
  if (t.pending > 0) notes.push(`${num(t.pending)} of ${num(t.sessions)} sessions are not analysed yet and are left out. Run: tracequest insights --refresh`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tracequest — insights</title>
<style>
${STANDALONE_BASE_CSS}
${INSIGHTS_PAGE_CSS}
</style>
</head>
<body>
<div class="container" data-insights-state="${t.analyzed > 0 ? "ready" : "empty"}">
  <div class="ins-header">
    <div class="ins-title"><a href="/">tracequest</a> / insights</div>
    <div class="ins-subtitle">where agents waste time and fail</div>
  </div>
  <p class="ins-lede">Every figure covers the sessions in scope across all collected machines. Click a row to see the sessions behind it.</p>

  <form class="ins-scope" method="get" action="/insights">
    <input class="ins-scope-input" type="text" name="expr" value="${esc(q.expr)}" placeholder="filter, e.g. project:sample-app source:claude host:mac" aria-label="Filter sessions">
    ${q.days ? `<input type="hidden" name="days" value="${q.days}">` : ""}
    ${q.host ? `<input type="hidden" name="host" value="${esc(q.host)}">` : ""}
    <button class="ins-chip" type="submit">Apply</button>
    ${rangeChips}
    ${q.host ? `<a class="ins-chip" href="${esc(scopeHref(q, { host: "" }))}" aria-current="true" title="Show every machine">machine: ${esc(q.host)} ×</a>` : ""}
  </form>
  ${notes.map((n) => `<div class="ins-note" role="status">${esc(n)}</div>`).join("\n")}

  <div class="ins-tiles" data-insight="headline">
    ${tile(num(t.analyzed), "sessions analysed", `${num(t.hosts)} machine${t.hosts === 1 ? "" : "s"} · ${hours(t.activeMs)} of agent time`)}
    ${tile(pct(t.errorRate), "of tool calls fail", `${num(t.errors)} of ${num(t.calls)} calls`)}
    ${tile(pct(t.analyzed ? t.errorSessions / t.analyzed : 0, 0), "of sessions hit an error", `${num(t.errorSessions)} sessions`)}
    ${tile(hours(data.stalls.ms), "agents sat waiting", `${num(data.stalls.count)} stalls of 5 min or more`)}
    ${tile(fmtCost(t.cost, { zeroLabel: "$0", prefix: "$", decimals: 0 }), "estimated model spend", `${fmtTokens(t.tokens, { zeroLabel: "0" })} tokens`)}
  </div>

  <section class="ins-section">
    <div class="ins-section-title">Machines</div>
    <div class="ins-section-sub">Which machines feed this view and how fresh each one is. A machine is stale after a day without a good pull.</div>
    ${hubTable(data.hub, now)}
  </section>

  <section class="ins-section">
    <div class="ins-section-title">Why tool calls fail</div>
    <div class="ins-section-sub">Failed tool calls grouped by cause, most common first.</div>
    ${classBars(data.classes, now)}
  </section>

  <section class="ins-section ins-grid">
    <div>
      <div class="ins-section-title">Error rate by harness</div>
      <div class="ins-section-sub">Share of tool calls that fail, per coding agent.</div>
      ${rateBars(data.byHarness, "by-harness", now)}
    </div>
    <div>
      <div class="ins-section-title">Error rate by repo area</div>
      <div class="ins-section-sub">Sessions grouped by the folder they touched most.</div>
      ${rateBars(data.byArea, "by-area", now)}
    </div>
  </section>

  <section class="ins-section">
    <div class="ins-section-title">Retries and loops</div>
    <div class="ins-section-sub">A retry repeats a call that already failed. A loop is the same call three or more times in a row of twelve.</div>
    <div class="ins-facts" data-insight="retries">
      ${fact(num(data.retries.retries), `retries in ${num(data.retries.sessions)} sessions`)}
      ${fact(num(data.retries.loops), `loops in ${num(data.retries.loopSessions)} sessions`)}
      ${fact(num(data.retries.loopCalls), "calls spent inside loops")}
    </div>
    ${examplesHtml(data.retries.examples, now)}
  </section>

  <section class="ins-section ins-grid">
    <div>
      <div class="ins-section-title">Time per session</div>
      <div class="ins-section-sub">Active agent time, with gaps spent waiting for a person removed.</div>
      <div class="ins-facts">
        ${fact(formatDuration(data.time.medianActiveMs, { zeroLabel: "—" }), "median active time")}
        ${fact(formatDuration(data.time.p90ActiveMs, { zeroLabel: "—" }), "9 in 10 finish within")}
        ${fact(fmtTokens(data.time.medianTokens, { zeroLabel: "—" }), "median tokens")}
        ${fact(fmtTokens(data.time.p90Tokens, { zeroLabel: "—" }), "9 in 10 stay under")}
      </div>
      ${histogramHtml(data.time.histogram)}
    </div>
    <div>
      <div class="ins-section-title">Long stalls</div>
      <div class="ins-section-sub">Five minutes or more with nothing happening while the agent, not a person, was the one waiting.</div>
      <div class="ins-facts" data-insight="stalls">
        ${fact(num(data.stalls.count), `stalls in ${num(data.stalls.sessions)} sessions`)}
        ${fact(hours(data.stalls.ms), "total waiting")}
      </div>
      ${examplesHtml(data.stalls.examples, now)}
    </div>
  </section>

  <section class="ins-section">
    <div class="ins-section-title">Most expensive sessions</div>
    <div class="ins-section-sub">Estimated from token counts at list prices; subscription plans are billed differently.</div>
    ${expensiveTable(data.expensive, now)}
  </section>

  <section class="ins-section">
    <div class="ins-section-title">Recurring traps</div>
    <div class="ins-section-sub">Known ways a session loses time that better setup or instructions can remove.</div>
    ${trapCards(data.traps, now)}
  </section>

  <div class="ins-foot">Generated ${esc(data.generatedAt)}. Prompts, error text and commands shown here are redacted for secrets.${t.suspect ? ` ${num(t.suspect)} results flagged as errors by the session parser look like ordinary output and are not counted.` : ""}</div>
</div>
</body>
</html>`;
}
