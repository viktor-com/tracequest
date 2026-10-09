#!/usr/bin/env node
/**
 * Writes a one-page specimen of the design system (tokens + every
 * component, dark and light side by side) for review:
 *   node scripts/design-specimen.mjs [out.html]
 */
import { writeFileSync } from "node:fs";
import { DESIGN_SYSTEM_CSS, ICONS, TOKENS_LIGHT, TOKENS_DARK } from "../src/ui/index.js";

const out = process.argv[2] || "design-specimen.html";

const swatches = ["bg", "surface-1", "surface-2", "surface-3", "surface-4", "text", "text-2", "text-3", "line-2", "line-3", "accent", "ok", "bad", "warn", "info"];
const hues = ["claude", "codex", "cursor", "cursor-cloud", "factory", "opencode", "grok"];

const panel = (theme) => `
<section class="sp" data-theme-panel="${theme}">
  <div class="sp-head"><span class="ui-label">${theme}</span></div>
  <div class="ui-display">Stop reading agent logs.</div>
  <div class="ui-title">Runs</div>
  <div class="ui-heading">Why tool calls fail</div>
  <p class="ui-body ui-muted" style="max-width:520px">Body text sits at 14/20 in warm ink. Secondary text is the same ink at 62%, tertiary at 42%, so greys never change temperature.</p>
  <div class="row">${swatches.map((s) => `<div class="sw"><i style="background:var(--${s})"></i><span class="ui-caption">${s}</span></div>`).join("")}</div>
  <div class="row">${hues.map((h) => `<span class="ui-agent" style="--hue:var(--hue-${h})">${h}</span>`).join("")}</div>
  <div class="row">
    <button class="ui-btn ui-btn--primary">${ICONS.plus}New run</button>
    <button class="ui-btn">Compare</button>
    <button class="ui-btn ui-btn--outline">Export</button>
    <button class="ui-btn ui-btn--ghost">Cancel</button>
    <button class="ui-btn ui-btn--danger">Kill run</button>
    <button class="ui-btn ui-btn--icon ui-btn--ghost" aria-label="Theme">${ICONS.theme}</button>
    <button class="ui-btn ui-btn--sm">Small</button>
  </div>
  <div class="row" style="max-width:560px">
    <input class="ui-input" placeholder="Filter runs — project:api errors:>0">
    <div class="ui-seg"><button aria-pressed="true">24h</button><button>7d</button><button>30d</button><button>All</button></div>
  </div>
  <div class="row">
    <span class="ui-chip">project:billing</span><button class="ui-chip is-active">errors</button><span class="ui-chip ui-chip--mono">61ac950a</span>
    <span class="ui-badge ui-badge--ok">A</span><span class="ui-badge">B</span><span class="ui-badge ui-badge--warn">C</span><span class="ui-badge ui-badge--bad">F</span>
    <span class="ui-dot ui-dot--live"></span><span class="ui-dot ui-dot--idle"></span><span class="ui-dot ui-dot--bad"></span>
    <span class="ui-kbd">⌘</span><span class="ui-kbd">K</span>
    <span class="ui-meter"><i style="width:34%"></i></span><span class="ui-meter is-high"><i style="width:86%"></i></span>
    <span class="ui-spark"><i style="width:40%;--hue:var(--hue-bash)"></i><i style="width:30%;--hue:var(--hue-read)"></i><i style="width:30%;--hue:var(--hue-edit)"></i></span>
  </div>
  <div class="ui-stats">
    <div class="ui-stat"><span class="ui-stat-value">14,448</span><span class="ui-stat-label">runs</span></div>
    <div class="ui-stat"><span class="ui-stat-value">$612.91</span><span class="ui-stat-label">estimated cost</span></div>
    <div class="ui-stat"><span class="ui-stat-value is-bad">33</span><span class="ui-stat-label">errors</span></div>
    <div class="ui-stat"><span class="ui-stat-value is-ok">92%</span><span class="ui-stat-label">cache hit</span></div>
  </div>
  <div class="ui-card ui-card--flush">
    <table class="ui-table"><thead><tr><th>Run</th><th>Agent</th><th class="is-num">Duration</th><th class="is-num">Cost</th></tr></thead>
    <tbody><tr><td>Migrate the invoice exporter</td><td><span class="ui-agent" style="--hue:var(--hue-claude)">claude</span></td><td class="is-num">6h 50m</td><td class="is-num">$612.91</td></tr>
    <tr><td>Fix the flaky date-picker test</td><td><span class="ui-agent" style="--hue:var(--hue-codex)">codex</span></td><td class="is-num">8m</td><td class="is-num">$0.61</td></tr></tbody></table>
  </div>
  <div class="ui-notice ui-notice--warn">7 of 7 sessions are not analysed yet.</div>
  <div class="ui-card"><div class="ui-empty"><div class="ui-empty-mark">${ICONS.search}</div><div class="ui-empty-title">No runs match <code>zzz</code></div><div class="ui-empty-body">Filters combine with AND. Drop one, or widen the time range.</div><div class="ui-empty-actions"><button class="ui-btn ui-btn--primary">Clear filters</button></div></div></div>
  <div class="row"><div class="ui-skel" style="width:220px;height:12px"></div><div class="ui-skel" style="width:120px;height:12px"></div><span class="ui-spinner"></span></div>
  <div class="ui-pop" style="position:relative;width:260px"><div class="ui-menu-item is-active">${ICONS.runs}Go to Runs<span class="ui-menu-aside"><span class="ui-kbd">G</span> <span class="ui-kbd">R</span></span></div><div class="ui-menu-item">${ICONS.insights}Go to Insights</div></div>
</section>`;

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>tracequest design system</title>
<style>${DESIGN_SYSTEM_CSS}
body { padding: 0; }
.grid { display: grid; grid-template-columns: 1fr 1fr; min-height: 100vh; }
.sp { padding: 40px; display: flex; flex-direction: column; gap: 20px; background: var(--bg); color: var(--text); }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.sw { display: flex; flex-direction: column; gap: 4px; width: 64px; }
.sw i { height: 32px; border-radius: 8px; box-shadow: inset 0 0 0 1px var(--line-2); }
</style></head><body>
<div class="grid">
  ${panel("dark")}
  ${panel("light")}
</div>
</body></html>`;

// Scope each theme's tokens to its panel.
const scoped = html.replace(
  "</style>",
  `[data-theme-panel="light"] {${TOKENS_LIGHT}} [data-theme-panel="dark"] {${TOKENS_DARK}}</style>`,
);
writeFileSync(out, scoped);
console.log(`wrote ${out}`);
