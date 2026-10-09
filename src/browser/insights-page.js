/**
 * /insights — where agents waste time and fail, across every collected machine
 * (facts inspg, inspd, inspr). Server-rendered and script-free: every figure is
 * a labelled row that opens onto the example sessions behind it.
 */
import { STANDALONE_BASE_CSS } from "../render/render-css.js";
import { esc } from "../server/server-html-helpers.js";
import { fmtCost, fmtTokens, formatDuration } from "../filter/filter-formats.js";
import { INSIGHTS_RANGES } from "../insights/load.js";
import { appTopStaticHtml, APP_TOP_CSS } from "./app-chrome.js";

const INSIGHTS_PAGE_CSS = `
.container { max-width: 1200px; margin: 0 auto; padding: var(--space-6) var(--space-8) 120px; }
.ins-header { display: flex; align-items: flex-end; flex-wrap: wrap; gap: var(--space-3) var(--space-6); margin-bottom: var(--space-5); }
.ins-heading { display: flex; flex-direction: column; gap: 4px; }
.ins-title { font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: var(--weight-regular); letter-spacing: var(--track-display); }
.ins-subtitle { color: var(--text-2); font-size: var(--text-md); }
.ins-ranges { margin-left: auto; display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--radius-pill); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2); }
.ins-chip {
  display: inline-flex; align-items: center; height: 28px; padding: 0 12px; border-radius: var(--radius-pill);
  font-size: var(--text-xs); color: var(--text-2); background: none; border: 0; cursor: pointer; white-space: nowrap;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.ins-chip:hover { color: var(--text); }
.ins-chip[aria-current="true"] { background: var(--surface-4); color: var(--text); }
.ins-scope { display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; margin-bottom: var(--space-6); }
.ins-scope-input {
  flex: 1 1 320px; min-width: 220px; height: var(--control-lg); padding: 0 14px; border-radius: var(--radius-pill); border: 0; outline: none;
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2); color: var(--text); font-family: var(--font-mono); font-size: 12.5px;
}
.ins-scope-input::placeholder { color: var(--text-3); font-family: var(--font-sans); font-size: var(--text-sm); }
.ins-scope-input:focus { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--focus); }
.ins-apply { height: var(--control-lg); padding: 0 16px; border-radius: var(--radius-pill); background: var(--surface-3); color: var(--text); font-size: var(--text-sm); border: 0; cursor: pointer; }
.ins-apply:hover { background: var(--surface-4); }
.ins-scope .ins-chip[aria-current="true"] { background: var(--ink); color: var(--paper); height: var(--control-lg); padding: 0 14px; font-size: var(--text-sm); }
.ins-lede { color: var(--text-3); font-size: var(--text-sm); margin: calc(-1 * var(--space-4)) 0 var(--space-6); }
.ins-note {
  display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; margin-bottom: var(--space-5); border-radius: var(--radius-md);
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2); font-size: var(--text-sm); color: var(--text-2);
}
.ins-note::before { content: ""; width: 6px; height: 6px; margin-top: 7px; border-radius: 50%; background: var(--warn); flex: none; }
.ins-empty-state { display: flex; flex-direction: column; gap: var(--space-2); max-width: 680px; padding: var(--space-8) 0 var(--space-10); }
.ins-empty-title { font-size: var(--text-xl); letter-spacing: var(--track-tight); color: var(--text); }
.ins-empty-state p { color: var(--text-2); font-size: var(--text-md); line-height: var(--lh-md); }
.ins-cmd {
  margin: var(--space-2) 0; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px;
  border-radius: var(--radius-md); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2);
  font-family: var(--font-mono); font-size: 13px; color: var(--text); user-select: all;
}
.ins-cmd::before { content: "$"; color: var(--text-4); margin-right: -4px; }
.ins-cmd code { flex: 1; }
.ins-empty-sub { font-size: var(--text-sm); color: var(--text-3) !important; }
.ins-empty-sub a { color: var(--text-2); text-decoration: underline; text-underline-offset: 2px; }
.ins-body[hidden] { display: none; }

.ins-tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 1px; margin-bottom: var(--space-10); border-radius: var(--radius-lg); overflow: hidden; background: var(--line-1); box-shadow: inset 0 0 0 1px var(--line-1); }
.ins-tile { background: var(--surface-1); padding: var(--space-5); display: flex; flex-direction: column; gap: 4px; }
.ins-tile-val { font-size: var(--text-2xl); line-height: var(--lh-2xl); letter-spacing: var(--track-display); font-variant-numeric: tabular-nums; }
.ins-tile-label { color: var(--text); font-size: var(--text-sm); }
.ins-tile-sub { color: var(--text-3); font-size: var(--text-xs); }

.ins-section { margin-bottom: var(--space-10); display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }
.ins-section-title { font-size: var(--text-lg); font-weight: var(--weight-regular); letter-spacing: var(--track-tight); color: var(--text); }
.ins-section-sub { color: var(--text-3); font-size: var(--text-sm); margin-bottom: var(--space-2); max-width: 760px; }
.ins-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: var(--space-8); }
.ins-grid > div { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; }

.ins-bars { display: flex; flex-direction: column; }
.ins-bar-row { border-radius: var(--radius-md); transition: background var(--dur-1) var(--ease-out); }
.ins-bar-row[open] { background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1); margin: 4px 0; }
.ins-bar-head {
  display: grid; grid-template-columns: minmax(150px, 240px) 1fr minmax(100px, auto); gap: var(--space-4); align-items: center;
  padding: 8px 10px; cursor: pointer; list-style: none; border-radius: var(--radius-md);
}
.ins-bar-head::-webkit-details-marker { display: none; }
.ins-bar-head:hover { background: var(--hover); }
.ins-bar-head:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
.ins-bar-label { font-size: var(--text-sm); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: flex; align-items: center; gap: 8px; }
.ins-bar-label::before {
  content: ""; width: 10px; height: 10px; flex: none; background: var(--text-3); transition: transform var(--dur-2) var(--ease-out);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 4 4 4-4 4'/%3E%3C/svg%3E") center / contain no-repeat;
          mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 4 4 4-4 4'/%3E%3C/svg%3E") center / contain no-repeat;
}
.ins-bar-row[open] > .ins-bar-head .ins-bar-label::before { transform: rotate(90deg); }
.ins-bar-track { height: 6px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.ins-bar-fill { height: 6px; min-width: 2px; border-radius: 999px; background: var(--text-2); transition: background var(--dur-2) var(--ease-out); }
.ins-bar-head:hover .ins-bar-fill { background: var(--text); }
[data-insight="error-classes"] .ins-bar-fill { background: color-mix(in srgb, var(--bad) 75%, transparent); }
[data-insight="error-classes"] .ins-bar-head:hover .ins-bar-fill { background: var(--bad); }
.ins-bar-val { font-size: var(--text-sm); color: var(--text); text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ins-bar-val small { color: var(--text-3); font-size: var(--text-xs); margin-left: 8px; }
.ins-detail { padding: 0 14px 14px 30px; display: flex; flex-direction: column; gap: 8px; }
.ins-detail-meta { color: var(--text-3); font-size: var(--text-xs); }

.ins-examples { display: flex; flex-direction: column; gap: 4px; }
.ins-example {
  display: flex; flex-direction: column; gap: 3px; padding: 9px 12px; border-radius: var(--radius-md);
  background: var(--bg); box-shadow: inset 0 0 0 1px var(--line-1); transition: box-shadow var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.ins-example:hover { background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-2); }
.ins-example-top { display: flex; gap: 10px; align-items: baseline; font-size: var(--text-xs); min-width: 0; }
.ins-example-src { color: var(--text-2); }
.ins-example-project { color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
.ins-example-when { color: var(--text-3); margin-left: auto; white-space: nowrap; }
.ins-example-prompt { font-size: var(--text-sm); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ins-example-note { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-3); overflow-wrap: anywhere; }

.ins-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--text-sm); }
.ins-table th { text-align: left; color: var(--text-3); font-weight: var(--weight-regular); font-size: var(--text-xs); padding: 0 12px 10px; box-shadow: inset 0 -1px 0 var(--line-2); white-space: nowrap; }
.ins-table td { padding: 11px 12px; box-shadow: inset 0 -1px 0 var(--line-1); vertical-align: top; }
.ins-table tbody tr { transition: background var(--dur-1) var(--ease-out); }
.ins-table tbody tr:hover { background: var(--hover); }
.ins-table td.num, .ins-table th.num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ins-table a { color: var(--text); }
.ins-table a:hover { text-decoration: underline; text-underline-offset: 2px; }
.ins-table .ins-cell-sub { color: var(--text-3); font-size: var(--text-xs); margin-top: 3px; overflow-wrap: anywhere; }
.ins-state { display: inline-flex; align-items: center; gap: 7px; font-size: var(--text-xs); color: var(--text-2); white-space: nowrap; }
.ins-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-4); }
.ins-state[data-state="fresh"] .ins-state-dot, .ins-state[data-state="local"] .ins-state-dot { background: var(--ok); }
.ins-state[data-state="stale"] .ins-state-dot { background: var(--warn); }
.ins-state[data-state="failing"] .ins-state-dot { background: var(--bad); }
.ins-state[data-state="never"] .ins-state-dot { background: transparent; box-shadow: inset 0 0 0 1px var(--text-3); }

.ins-cols { display: flex; align-items: flex-end; gap: 6px; height: 160px; padding: 20px 0 0; box-shadow: inset 0 -1px 0 var(--line-2); }
.ins-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
.ins-col-val { font-size: 11px; color: var(--text-3); margin-bottom: 6px; font-variant-numeric: tabular-nums; }
.ins-col-bar { width: 100%; max-width: 64px; min-height: 2px; background: var(--surface-4); border-radius: 6px 6px 0 0; transition: background var(--dur-2) var(--ease-out); }
.ins-col:hover .ins-col-bar { background: var(--text-2); }
.ins-col-labels { display: flex; gap: 6px; padding-top: 8px; }
.ins-col-labels span { flex: 1; text-align: center; color: var(--text-3); font-size: 11px; }
.ins-facts { display: flex; gap: var(--space-8); flex-wrap: wrap; margin-bottom: var(--space-3); }
.ins-fact-val { font-size: var(--text-xl); line-height: var(--lh-xl); letter-spacing: var(--track-tight); font-variant-numeric: tabular-nums; }
.ins-fact-label { color: var(--text-3); font-size: var(--text-xs); }

.ins-traps { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: var(--space-3); }
.ins-trap { display: flex; flex-direction: column; gap: 6px; padding: var(--space-5); border-radius: var(--radius-lg); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-1); }
.ins-trap-title { font-size: var(--text-md); color: var(--text); }
.ins-trap-hint { color: var(--text-3); font-size: var(--text-xs); line-height: var(--lh-xs); min-height: 32px; }
.ins-trap-val { font-size: var(--text-2xl); line-height: var(--lh-2xl); letter-spacing: var(--track-display); margin-top: 6px; font-variant-numeric: tabular-nums; }
.ins-trap-val small { color: var(--text-3); font-size: var(--text-xs); margin-left: 6px; letter-spacing: 0; }
.ins-trap-sub { color: var(--text-3); font-size: var(--text-xs); }
.ins-trap details { margin-top: 6px; }
.ins-trap summary { color: var(--text-2); font-size: var(--text-xs); cursor: pointer; list-style: none; }
.ins-trap summary::-webkit-details-marker { display: none; }
.ins-trap summary::after { content: " \\2192"; }
.ins-trap summary:hover { color: var(--text); }
.ins-trap .ins-examples { margin-top: 10px; }
.ins-empty { color: var(--text-3); font-size: var(--text-sm); padding: var(--space-3) 2px; }
.ins-foot { color: var(--text-3); font-size: var(--text-xs); margin-top: var(--space-10); padding-top: var(--space-4); box-shadow: inset 0 1px 0 var(--line-1); }
@media (max-width: 640px) {
  .container { padding: var(--space-5) var(--space-4) 80px; }
  .ins-ranges { margin-left: 0; }
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
${APP_TOP_CSS}
${INSIGHTS_PAGE_CSS}
</style>
</head>
<body>
${appTopStaticHtml("insights")}
<div class="container" data-insights-state="${t.analyzed > 0 ? "ready" : "empty"}">
  <div class="ins-header">
    <div class="ins-heading">
      <h1 class="ins-title">Insights</h1>
      <div class="ins-subtitle">Where agents waste time and fail, across every collected machine.</div>
    </div>
    <nav class="ins-ranges" aria-label="Time range">${rangeChips}</nav>
  </div>

  <form class="ins-scope" method="get" action="/insights">
    <input class="ins-scope-input" type="text" name="expr" value="${esc(q.expr)}" placeholder="Narrow the scope — project:sample-app source:claude host:mac" aria-label="Filter sessions">
    ${q.days ? `<input type="hidden" name="days" value="${q.days}">` : ""}
    ${q.host ? `<input type="hidden" name="host" value="${esc(q.host)}">` : ""}
    <button class="ins-apply" type="submit">Apply</button>
    ${q.host ? `<a class="ins-chip" href="${esc(scopeHref(q, { host: "" }))}" aria-current="true" title="Show every machine">machine: ${esc(q.host)} ×</a>` : ""}
  </form>
  ${t.analyzed === 0 ? "" : notes.map((n) => `<div class="ins-note" role="status">${esc(n)}</div>`).join("\n")}
  ${t.analyzed === 0 ? `<div class="ins-empty-state">
    <div class="ins-empty-title">Nothing analysed in this scope yet</div>
    ${notes.map((n) => `<p class="ins-empty-note" role="status">${esc(n.replace(/\s*Run: tracequest insights --refresh\.?$/, ""))}</p>`).join("\n")}
    <p>Insights reads a cache the CLI fills, so this page never slows your machine down. Build it once, then reload:</p>
    <div class="ins-cmd"><code>tracequest insights --refresh</code></div>
    <p class="ins-empty-sub">If you narrowed the scope, try <a href="/insights">all sessions</a> or a longer time range first.</p>
  </div>` : `<p class="ins-lede">Every figure covers the sessions in scope. Open a row to see the sessions behind it.</p>`}
  <div class="ins-body"${t.analyzed === 0 ? " hidden" : ""}>
  <div class="ins-tiles" data-insight="headline">
    ${tile(num(t.analyzed), "sessions analysed", `${num(t.hosts)} machine${t.hosts === 1 ? "" : "s"} · ${hours(t.activeMs)} of agent time`)}
    ${tile(pct(t.errorRate), "of tool calls fail", `${num(t.errors)} of ${num(t.calls)} calls`)}
    ${tile(pct(t.analyzed ? t.errorSessions / t.analyzed : 0, 0), "of sessions hit an error", `${num(t.errorSessions)} sessions`)}
    ${tile(hours(data.stalls.ms), "agents sat waiting", `${num(data.stalls.count)} stalls of 5 min or more`)}
    ${tile(fmtCost(t.cost, { zeroLabel: "$0", prefix: "$", decimals: 0 }), "estimated model spend", `${fmtTokens(t.tokens, { zeroLabel: "0" })} tokens`)}
  </div>

  </div>
  <section class="ins-section">
    <div class="ins-section-title">Machines</div>
    <div class="ins-section-sub">Which machines feed this view and how fresh each one is. A machine is stale after a day without a good pull.</div>
    ${hubTable(data.hub, now)}
  </section>

  <div class="ins-body"${t.analyzed === 0 ? " hidden" : ""}>
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

  </div>
  <div class="ins-foot">Generated ${esc(data.generatedAt)}. Prompts, error text and commands shown here are redacted for secrets.${t.suspect ? ` ${num(t.suspect)} results flagged as errors by the session parser look like ordinary output and are not counted.` : ""}</div>
</div>
</body>
</html>`;
}
