/**
 * The tracequest mark: a Q whose tail leaves the run and runs on flat — the
 * trace. The bowl is the session (the loop the agent made); the tail is the
 * trace that comes out of it and keeps going along the timeline. Both strokes
 * share one weight on a 32-unit square, so the mark holds from the 16px
 * favicon to the app header. The bowl follows the theme, the trace is accent.
 */

/** Bowl: 330° of a circle at (14.8, 14.3) r 8.7, open where the trace leaves. */
const BOWL_D = "M23.13 16.9A8.7 8.7 0 1 0 17.88 22.61";
/** The trace: starts in the run, steps out through the gap, runs flat along the timeline. */
const TRACE_D = "M16 15.2 21.6 20.8H29.8";
const STROKE = 'fill="none" stroke-width="4.2" stroke-linecap="round" stroke-linejoin="round"';

/** Accent orange from TOKENS_DARK/TOKENS_LIGHT (`--accent`), the same in both themes. */
const ACCENT = "#f54e00";

const markPaths = (bowl, trace) =>
  `<path d="${BOWL_D}" ${STROKE} ${bowl}/><path class="app-mark-trace" d="${TRACE_D}" ${STROKE} ${trace}/>`;

/** Mark beside the lowercase wordmark for the app header; colours come from CSS. */
export const MARK_SVG =
  `<svg class="app-mark" width="22" height="22" viewBox="0 0 32 32" aria-hidden="true">` +
  markPaths('stroke="currentColor"', `stroke="${ACCENT}"`) +
  `</svg><span class="app-word">tracequest</span>`;

/** The lockup for the README (docs/assets/logo.svg); ink follows prefers-color-scheme. */
export const LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="74" viewBox="0 0 190 64">` +
  `<style>.ink{color:#26251e;fill:#26251e}@media (prefers-color-scheme:dark){.ink{color:#edecec;fill:#edecec}}</style>` +
  `<g class="ink" transform="translate(4 18)">${markPaths('stroke="currentColor"', `stroke="${ACCENT}"`)}</g>` +
  `<text class="ink" x="48" y="40" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Inter, sans-serif" font-size="27" font-weight="500" letter-spacing="-0.4">tracequest</text>` +
  `</svg>`;

/** Favicon: the mark on a dark tile; the tile lifts a little in dark mode. */
export const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">` +
  `<clipPath id="t"><rect width="32" height="32" rx="7.5"/></clipPath><g clip-path="url(#t)">` +
  `<rect class="tile" width="32" height="32"/><g transform="translate(4.2 4.6) scale(0.8)">` +
  markPaths('stroke="#edecec"', `stroke="${ACCENT}"`) +
  `</g></g><style>.tile{fill:#14120b}@media (prefers-color-scheme:dark){.tile{fill:#2b2820}}</style></svg>`;

/** Head tag pointing browsers at the served favicon (route /favicon.svg). */
export const FAVICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
