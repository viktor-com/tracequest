/**
 * tracequest component layer. Every screen is built from these primitives;
 * screen stylesheets only arrange them. Class names are prefixed `ui-` so a
 * screen's own structure never collides with the system.
 */

/** Reset + document defaults. */
export const BASE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
* { margin: 0; padding: 0; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: var(--text-md);
  line-height: var(--lh-md);
  font-feature-settings: "cv11", "ss01";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}
::selection { background: var(--selection); }
a { color: inherit; text-decoration: none; }
button, input, select, textarea { font: inherit; color: inherit; }
button { cursor: pointer; background: none; border: 0; }
img, svg { display: block; }
code, kbd, pre, samp { font-family: var(--font-mono); font-size: 0.92em; }
[hidden] { display: none !important; }
:focus { outline: none; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--radius-xs); }
.ui-num { font-variant-numeric: tabular-nums; }
.ui-mono { font-family: var(--font-mono); }
.ui-sr {
  position: absolute !important; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
* { scrollbar-width: thin; scrollbar-color: var(--line-3) transparent; }
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 999px; border: 3px solid transparent; background-clip: padding-box; }
::-webkit-scrollbar-thumb:hover { background-color: var(--line-3); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}
`;

/** Typography roles. */
export const TYPE_CSS = `
.ui-display { font-size: var(--text-3xl); line-height: var(--lh-3xl); font-weight: var(--weight-regular); letter-spacing: var(--track-display); }
.ui-title { font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: var(--weight-regular); letter-spacing: var(--track-display); }
.ui-heading { font-size: var(--text-xl); line-height: var(--lh-xl); font-weight: var(--weight-regular); letter-spacing: var(--track-tight); }
.ui-subheading { font-size: var(--text-lg); line-height: var(--lh-lg); font-weight: var(--weight-medium); letter-spacing: var(--track-tight); }
.ui-body { font-size: var(--text-md); line-height: var(--lh-md); }
.ui-small { font-size: var(--text-sm); line-height: var(--lh-sm); }
.ui-caption { font-size: var(--text-xs); line-height: var(--lh-xs); color: var(--text-3); }
.ui-label { font-size: var(--text-xs); line-height: var(--lh-xs); color: var(--text-3); font-weight: var(--weight-regular); }
.ui-muted { color: var(--text-2); }
.ui-faint { color: var(--text-3); }
.ui-ok { color: var(--ok); } .ui-bad { color: var(--bad); } .ui-warn { color: var(--warn); } .ui-accent { color: var(--accent-text); }
`;

/** Buttons: ink primary, quiet secondary, ghost; all pills. */
export const BUTTON_CSS = `
.ui-btn {
  --btn-h: var(--control-md);
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: var(--btn-h); padding: 0 calc(var(--btn-h) * 0.42);
  border-radius: var(--radius-pill);
  font-size: var(--text-sm); line-height: 1; font-weight: var(--weight-regular); white-space: nowrap;
  color: var(--text); background: var(--surface-3);
  border: 0; cursor: pointer; user-select: none;
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out), opacity var(--dur-2) var(--ease-out), transform var(--dur-1) var(--ease-out);
}
.ui-btn:hover { background: var(--surface-4); }
.ui-btn:active { transform: translateY(0.5px); }
.ui-btn[disabled], .ui-btn[aria-disabled="true"] { opacity: 0.45; cursor: default; pointer-events: none; }
.ui-btn svg { width: 14px; height: 14px; flex: none; }
.ui-btn--primary { background: var(--ink); color: var(--paper); }
.ui-btn--primary:hover { background: color-mix(in oklab, var(--ink) 86%, var(--paper)); }
.ui-btn--outline { background: transparent; box-shadow: inset 0 0 0 1px var(--line-3); }
.ui-btn--outline:hover { background: var(--hover); }
.ui-btn--ghost { background: transparent; color: var(--text-2); }
.ui-btn--ghost:hover { background: var(--hover); color: var(--text); }
.ui-btn--danger { background: var(--bad-soft); color: var(--bad); }
.ui-btn--danger:hover { background: color-mix(in srgb, var(--bad) 26%, transparent); }
.ui-btn--sm { --btn-h: var(--control-sm); font-size: var(--text-xs); }
.ui-btn--lg { --btn-h: var(--control-lg); font-size: var(--text-md); }
.ui-btn--icon { width: var(--btn-h); padding: 0; }
`;

/** Inputs, search fields, selects, segmented controls. */
export const FIELD_CSS = `
.ui-input {
  height: var(--control-md); width: 100%;
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  background: var(--surface-1);
  box-shadow: inset 0 0 0 1px var(--line-2);
  border: 0; color: var(--text); font-size: var(--text-sm);
  transition: box-shadow var(--dur-2) var(--ease-out), background var(--dur-2) var(--ease-out);
}
.ui-input::placeholder { color: var(--text-3); }
.ui-input:hover { box-shadow: inset 0 0 0 1px var(--line-3); }
.ui-input:focus, .ui-input:focus-within { outline: none; box-shadow: inset 0 0 0 1px var(--focus); background: var(--surface-2); }
.ui-textarea { border-radius: var(--radius-lg); padding: var(--space-3); height: auto; min-height: 72px; resize: vertical; line-height: var(--lh-sm); }
.ui-field { display: flex; flex-direction: column; gap: 6px; }
.ui-field > label, .ui-field > .ui-field-label { font-size: var(--text-xs); color: var(--text-2); }
.ui-field-hint { font-size: var(--text-xs); color: var(--text-3); }
.ui-seg {
  display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--radius-pill);
  background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2);
}
.ui-seg > * {
  height: calc(var(--control-md) - 4px); padding: 0 var(--space-3);
  display: inline-flex; align-items: center; gap: 6px;
  border-radius: var(--radius-pill); font-size: var(--text-xs); color: var(--text-2);
  transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out);
}
.ui-seg > *:hover { color: var(--text); }
.ui-seg > [aria-current="true"], .ui-seg > [aria-pressed="true"], .ui-seg > [aria-selected="true"], .ui-seg > .is-active {
  background: var(--surface-4); color: var(--text);
}
`;

/** Chips, badges, status dots, kbd, meters. */
export const MARK_CSS = `
.ui-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 var(--space-2);
  border-radius: var(--radius-pill); font-size: var(--text-xs); line-height: 1; white-space: nowrap;
  color: var(--text-2); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-1);
  max-width: 100%; overflow: hidden; text-overflow: ellipsis;
}
button.ui-chip, a.ui-chip { cursor: pointer; transition: background var(--dur-2) var(--ease-out), color var(--dur-2) var(--ease-out); }
button.ui-chip:hover, a.ui-chip:hover { background: var(--surface-3); color: var(--text); }
.ui-chip[aria-pressed="true"], .ui-chip.is-active { background: var(--ink); color: var(--paper); box-shadow: none; }
.ui-chip--mono { font-family: var(--font-mono); font-size: 11px; }
.ui-agent {
  display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-xs); color: var(--text-2); white-space: nowrap;
}
.ui-agent::before { content: ""; width: 7px; height: 7px; border-radius: 2px; background: var(--hue, var(--hue-other)); flex: none; }
.ui-badge {
  display: inline-flex; align-items: center; justify-content: center; min-width: 20px; height: 18px; padding: 0 5px;
  border-radius: var(--radius-xs); font-family: var(--font-mono); font-size: 11px; font-weight: var(--weight-medium);
  color: var(--text-2); background: var(--surface-3);
}
.ui-badge--ok { color: var(--ok); background: var(--ok-soft); }
.ui-badge--warn { color: var(--warn); background: var(--warn-soft); }
.ui-badge--bad { color: var(--bad); background: var(--bad-soft); }
.ui-badge--accent { color: var(--accent-text); background: var(--accent-soft); }
.ui-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--text-4); flex: none; display: inline-block; }
.ui-dot--live { background: var(--ok); box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 60%, transparent); animation: ui-pulse 2.2s var(--ease-out) infinite; }
.ui-dot--idle { background: var(--warn); }
.ui-dot--bad { background: var(--bad); }
@keyframes ui-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 55%, transparent); }
  70% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--ok) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ok) 0%, transparent); }
}
.ui-kbd {
  display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 4px;
  border-radius: var(--radius-xs); font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-2), 0 1px 0 var(--line-2);
}
.ui-meter { position: relative; display: inline-block; width: 48px; height: 4px; border-radius: 999px; background: var(--surface-4); overflow: hidden; vertical-align: middle; }
.ui-meter > i { position: absolute; inset: 0 auto 0 0; border-radius: inherit; background: var(--text-2); transition: width var(--dur-4) var(--ease-out); }
.ui-meter.is-high > i { background: var(--accent); }
.ui-spark { display: inline-flex; height: 4px; width: 64px; border-radius: 999px; overflow: hidden; background: var(--surface-3); gap: 1px; }
.ui-spark > i { display: block; height: 100%; background: var(--hue, var(--hue-other)); }
`;

/** Surfaces: cards, sections, tables, lists, dividers. */
export const SURFACE_CSS = `
.ui-card { background: var(--surface-1); border-radius: var(--radius-lg); box-shadow: inset 0 0 0 1px var(--line-1); }
.ui-card--pad { padding: var(--space-5); }
.ui-card--flush { overflow: hidden; }
.ui-section { display: flex; flex-direction: column; gap: var(--space-3); }
.ui-section-head { display: flex; align-items: baseline; gap: var(--space-3); }
.ui-section-title { font-size: var(--text-md); font-weight: var(--weight-medium); letter-spacing: var(--track-tight); color: var(--text); }
.ui-section-sub { font-size: var(--text-sm); color: var(--text-3); }
.ui-section-head > .ui-section-aside { margin-left: auto; font-size: var(--text-xs); color: var(--text-3); }
.ui-divider { height: 1px; background: var(--line-2); border: 0; }
.ui-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 1px; background: var(--line-1); border-radius: var(--radius-lg); overflow: hidden; box-shadow: inset 0 0 0 1px var(--line-1); }
.ui-stat { background: var(--surface-1); padding: var(--space-4) var(--space-5); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ui-stat-value { font-size: var(--text-xl); line-height: var(--lh-xl); letter-spacing: var(--track-tight); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ui-stat-label { font-size: var(--text-xs); color: var(--text-3); }
.ui-stat-value.is-bad { color: var(--bad); } .ui-stat-value.is-ok { color: var(--ok); } .ui-stat-value.is-warn { color: var(--warn); }
.ui-table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--text-sm); }
.ui-table th {
  text-align: left; font-weight: var(--weight-regular); font-size: var(--text-xs); color: var(--text-3);
  padding: 0 var(--space-3) var(--space-2); border-bottom: 1px solid var(--line-2); white-space: nowrap;
}
.ui-table td { padding: 10px var(--space-3); border-bottom: 1px solid var(--line-1); vertical-align: middle; }
.ui-table tr:last-child td { border-bottom: 0; }
.ui-table .is-num { text-align: right; font-variant-numeric: tabular-nums; }
.ui-table tbody tr { transition: background var(--dur-1) var(--ease-out); }
.ui-table tbody tr:hover { background: var(--hover); }
`;

/** Overlays: popover/menu, dialog, tooltip, toast. */
export const OVERLAY_CSS = `
.ui-pop {
  background: var(--surface-pop); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop);
  padding: var(--space-1); min-width: 200px; z-index: var(--z-popover);
  animation: ui-pop-in var(--dur-2) var(--ease-out);
}
.ui-menu-item svg { width: 16px; height: 16px; flex: none; color: var(--text-3); }
.ui-menu-item {
  display: flex; align-items: center; gap: var(--space-2); width: 100%;
  height: 30px; padding: 0 var(--space-2); border-radius: var(--radius-sm);
  font-size: var(--text-sm); color: var(--text-2); text-align: left; cursor: pointer;
}
.ui-menu-item:hover, .ui-menu-item[aria-selected="true"], .ui-menu-item.is-active { background: var(--hover); color: var(--text); }
.ui-menu-item .ui-menu-aside { margin-left: auto; font-size: var(--text-xs); color: var(--text-3); }
.ui-scrim { position: fixed; inset: 0; background: var(--scrim); backdrop-filter: blur(2px); z-index: var(--z-dialog); animation: ui-fade-in var(--dur-2) var(--ease-out); }
.ui-dialog {
  position: fixed; left: 50%; top: 14vh; transform: translateX(-50%);
  width: min(560px, calc(100vw - 32px)); max-height: 76vh; overflow: auto;
  background: var(--surface-pop); border-radius: var(--radius-xl); box-shadow: var(--shadow-pop);
  z-index: calc(var(--z-dialog) + 1); animation: ui-dialog-in var(--dur-3) var(--ease-out);
}
.ui-dialog-head { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-5) var(--space-5) var(--space-3); }
.ui-dialog-title { font-size: var(--text-lg); letter-spacing: var(--track-tight); }
.ui-dialog-body { padding: 0 var(--space-5) var(--space-5); display: flex; flex-direction: column; gap: var(--space-4); }
.ui-dialog-foot { display: flex; justify-content: flex-end; gap: var(--space-2); padding: var(--space-3) var(--space-5) var(--space-5); }
.ui-tooltip {
  position: fixed; z-index: var(--z-toast); pointer-events: none;
  background: var(--ink); color: var(--paper); font-size: var(--text-xs); line-height: var(--lh-xs);
  padding: 5px 8px; border-radius: var(--radius-sm); max-width: 320px;
}
.ui-toast {
  position: fixed; bottom: var(--space-5); left: 50%; transform: translateX(-50%); z-index: var(--z-toast);
  background: var(--ink); color: var(--paper); font-size: var(--text-sm); padding: 8px 14px; border-radius: var(--radius-pill);
  animation: ui-rise-in var(--dur-3) var(--ease-out);
}
@keyframes ui-fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes ui-pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes ui-dialog-in { from { opacity: 0; transform: translate(-50%, 8px) scale(0.985); } to { opacity: 1; transform: translateX(-50%); } }
@keyframes ui-rise-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translateX(-50%); } }
`;

/** Result states: empty, loading (skeleton, spinner), error, notice. */
export const STATE_CSS = `
.ui-empty {
  display: flex; flex-direction: column; align-items: center; text-align: center; gap: var(--space-2);
  padding: var(--space-16) var(--space-6); color: var(--text-2);
}
.ui-empty-mark { width: 40px; height: 40px; border-radius: var(--radius-lg); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--line-2); display: grid; place-items: center; color: var(--text-3); margin-bottom: var(--space-2); }
.ui-empty-mark svg { width: 18px; height: 18px; }
.ui-empty-title { font-size: var(--text-lg); line-height: var(--lh-lg); color: var(--text); letter-spacing: var(--track-tight); }
.ui-empty-body { font-size: var(--text-sm); max-width: 440px; }
.ui-empty-title code { font-size: 0.86em; background: var(--surface-2); padding: 1px 6px; border-radius: var(--radius-xs); }
.ui-empty-body code { background: var(--surface-2); padding: 1px 6px; border-radius: var(--radius-xs); color: var(--text); }
.ui-empty-actions { display: flex; gap: var(--space-2); margin-top: var(--space-3); }
.ui-skel { position: relative; overflow: hidden; background: var(--surface-2); border-radius: var(--radius-sm); }
.ui-skel::after {
  content: ""; position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, var(--hover), transparent);
  animation: ui-shimmer 1.4s var(--ease-in-out) infinite;
}
@keyframes ui-shimmer { to { transform: translateX(100%); } }
.ui-spinner { width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid var(--line-3); border-top-color: var(--text); animation: ui-spin 0.8s linear infinite; display: inline-block; }
@keyframes ui-spin { to { transform: rotate(360deg); } }
.ui-notice {
  display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-md); background: var(--surface-1); box-shadow: inset 0 0 0 1px var(--line-2);
  font-size: var(--text-sm); color: var(--text-2);
}
.ui-notice::before { content: ""; width: 6px; height: 6px; margin-top: 7px; border-radius: 50%; background: var(--text-3); flex: none; }
.ui-notice--warn::before { background: var(--warn); }
.ui-notice--bad::before { background: var(--bad); }
.ui-notice--ok::before { background: var(--ok); }
.ui-error-page { min-height: 100vh; display: grid; place-items: center; padding: var(--space-8); }
.ui-error-card { width: min(520px, 100%); display: flex; flex-direction: column; gap: var(--space-3); }
.ui-error-code { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-3); }
.ui-error-handle { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-2); background: var(--surface-1); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); overflow-wrap: anywhere; box-shadow: inset 0 0 0 1px var(--line-1); }
`;

/** The whole component layer, in cascade order. */
export const COMPONENTS_CSS = [BASE_CSS, TYPE_CSS, BUTTON_CSS, FIELD_CSS, MARK_CSS, SURFACE_CSS, OVERLAY_CSS, STATE_CSS].join("\n");

/** Small inline icon set (16px grid, 1.5 stroke), shared by every screen. */
export const ICONS = {
  search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3 3"/></svg>',
  plus: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  arrowLeft: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 8h-9M7 4.5 3.5 8 7 11.5"/></svg>',
  arrowRight: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8h9M9 4.5 12.5 8 9 11.5"/></svg>',
  swap: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5.5h9.5M10 3l2.5 2.5L10 8M13 10.5H3.5M6 8l-2.5 2.5L6 13"/></svg>',
  theme: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5.75" stroke="currentColor" stroke-width="1.5"/><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor"/></svg>',
  close: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  runs: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M3 8h10M3 11.5h6"/></svg>',
  chat: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M3 4h10v6.5H7.5L4.5 13v-2.5H3z"/></svg>',
  insights: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3.5 12.5V9M6.5 12.5V4.5M9.5 12.5V7M12.5 12.5V3"/></svg>',
  alert: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 2.75 14 13.25H2z" stroke-linejoin="round"/><path d="M8 6.75v3M8 11.6v.1"/></svg>',
  inbox: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 9 4 3.5h8L13.5 9v3.5h-11z"/><path d="M2.5 9h3l1 1.5h3l1-1.5h3"/></svg>',
  filter: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 4h11M4.5 8h7M6.5 12h3"/></svg>',
  download: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10"/></svg>',
  share: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2.5M5 5.5l3-3 3 3M3.5 9v4.5h9V9"/></svg>',
  print: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4.5 6V2.5h7V6M4.5 11.5h-2V6h11v5.5h-2M4.5 9.5h7v4h-7z"/></svg>',
  doc: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" stroke-linecap="round"/></svg>',
  send: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.5v-9M4.5 7 8 3.5 11.5 7"/></svg>',
};
