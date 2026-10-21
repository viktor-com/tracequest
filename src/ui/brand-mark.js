/**
 * The tracequest logo: TRACE and QUEST in custom heavy condensed capitals. Both
 * words have five letters, so they stack into one block. The Q's tail leaves
 * the letter and runs under the word as an orange line: the trace. Letters
 * follow the theme; the trace uses the accent.
 */

/** Letter centrelines on a 10×16 cell, drawn with a 3.6 stroke and butt caps. */
const GLYPHS = {
  T: "M0 1.8H10M5 1.8V16",
  R: "M1.8 16V1.8H5A3.2 3.2 0 0 1 8.2 5V5.6A3.2 3.2 0 0 1 5 8.8H1.8M4.4 7.2L8.3 16",
  A: "M1.8 16V5A3.2 3.2 0 0 1 8.2 5V16M1.8 9.1H8.2",
  C: "M8.2 5.9V5A3.2 3.2 0 0 0 1.8 5V11A3.2 3.2 0 0 0 8.2 11V10.1",
  E: "M10 1.8H1.8V14.2H10M1.8 8.2H8.6",
  Q: "M1.8 5A3.2 3.2 0 0 1 8.2 5V11A3.2 3.2 0 0 1 1.8 11Z",
  U: "M1.8 0V11A3.2 3.2 0 0 0 8.2 11V0",
  S: "M8.2 5.9V5A3.2 3.2 0 0 0 1.8 5C1.8 7.2 2.4 8.2 5 8.2C7.6 8.2 8.2 9.2 8.2 11A3.2 3.2 0 0 1 1.8 11V10.1",
};

/** Letter advance: 10-unit cell plus 1.4 tracking (the same unit sets leading and the trace gap). */
const ADVANCE = 11.4;
const LINE = 17.4;

/** Accent orange from TOKENS_DARK/TOKENS_LIGHT (`--accent`). */
const ACCENT = "#f54e00";

const n = (v) => +v.toFixed(3);

const letters = (word, y = 0) =>
  [...word].map((c, i) => `<path transform="translate(${n(i * ADVANCE)} ${y})" d="${GLYPHS[c]}"/>`).join("");

/** The Q's tail: a 45° stub out of the bowl, then a straight run to `endX` under the baseline. */
const traceD = (qx, qy, endX) =>
  `M${n(qx + 6.189)} ${n(qy + 10.411)}L${n(qx + 13.178)} ${n(qy + 17.4)}H${endX}V${n(qy + 19.632)}H${n(qx + 12.254)}L${n(qx + 4.611)} ${n(qy + 11.989)}Z`;

const STROKE = 'fill="none" stroke-width="3.6"';
const ONE_LINE_W = 112.6;
const BLOCK_W = 54.8;
const BLOCK_H = 37.032;

/** One-line logotype for the app header; colours come from CSS (.app-mark, .app-mark-trace). */
export const MARK_SVG =
  `<svg class="app-mark" width="86" height="15" viewBox="0 0 ${ONE_LINE_W} 19.632" aria-hidden="true">` +
  `<g ${STROKE} stroke="currentColor">${letters("TRACEQUEST")}</g>` +
  `<path class="app-mark-trace" d="${traceD(5 * ADVANCE, 0, ONE_LINE_W)}" fill="${ACCENT}"/></svg>`;

const block = (style) =>
  `<style>${style}</style><g class="ink" ${STROKE}>${letters("TRACE")}${letters("QUEST", LINE)}</g>` +
  `<path d="${traceD(0, LINE, BLOCK_W)}" fill="${ACCENT}"/>`;

/** Stacked TRACE/QUEST block for the README (docs/assets/logo.svg); ink follows prefers-color-scheme. */
export const LOGO_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="149" viewBox="0 0 ${BLOCK_W} ${BLOCK_H}">` +
  block(".ink{stroke:#14120b}@media (prefers-color-scheme:dark){.ink{stroke:#edecec}}") +
  `</svg>`;

/** Favicon: the block cropped into a dark tile like a poster bleed; the tile lifts a little in dark mode. */
export const FAVICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24">` +
  `<clipPath id="t"><rect width="24" height="24" rx="5.5"/></clipPath><g clip-path="url(#t)">` +
  `<rect class="tile" width="24" height="24"/><g transform="translate(3 2.6) scale(0.6)">` +
  block(".tile{fill:#14120b}.ink{stroke:#edecec}@media (prefers-color-scheme:dark){.tile{fill:#2b2820}}") +
  `</g></g></svg>`;

/** Head tag pointing browsers at the served favicon (route /favicon.svg). */
export const FAVICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
