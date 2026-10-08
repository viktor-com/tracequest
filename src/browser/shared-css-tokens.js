/** Shared :root design tokens for session viewer and standalone browser pages. */

/** Core palette and typography (screen). */
export const CSS_ROOT_SHARED = `
  --bg: #111113;
  --surface: #19191c;
  --surface2: #222226;
  --fg: #e4e4e7;
  --fg2: #9d9da4;
  --fg3: #6e6e76;
  --border: rgba(255, 255, 255, 0.08);
  --accent: #8b7cf6;
  --red: #f07070;
  --green: #4ade80;
  --orange: #e8a44c;
  --sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --mono: ui-monospace, 'SF Mono', Menlo, 'Cascadia Code', 'JetBrains Mono', 'Fira Code', monospace;
`;

/** Compare / browser standalone pages only. */
export const CSS_STANDALONE_ROOT_EXTRA = `
  --accent-dim: rgba(139, 124, 246, 0.12);
`;

/** Session HTML viewer only. */
export const CSS_SESSION_ROOT_EXTRA = `
  --green-dim: rgba(74, 222, 128, 0.1);
  --red-dim: rgba(240, 112, 112, 0.1);
  --orange-dim: rgba(232, 164, 76, 0.1);
  --radius: 10px;
`;

export const CSS_ROOT_STANDALONE = `
:root {${CSS_ROOT_SHARED}${CSS_STANDALONE_ROOT_EXTRA}
}
`;

export const CSS_ROOT_SESSION = `
:root {${CSS_ROOT_SHARED}${CSS_SESSION_ROOT_EXTRA}
}
`;

export const CSS_RESET = `
* { margin: 0; padding: 0; box-sizing: border-box; }
`;


/**
 * Light theme: the same tokens re-pointed at paper and ink. Follows the
 * system unless the user picked a theme (html[data-theme], set by the app
 * shell and remembered in localStorage). Dark stays the default.
 */
const CSS_LIGHT_VARS = `
    --bg: #fafafa;
    --surface: #ffffff;
    --surface2: #f0f0f2;
    --fg: #18181b;
    --fg2: #52525b;
    --fg3: #71717a;
    --border: rgba(0, 0, 0, 0.09);
    --accent: #6d5cce;
    --red: #c43838;
    --green: #1a8a42;
    --orange: #b06f12;
    --chip-tint: rgba(255, 255, 255, 0.80);
    color-scheme: light;
`;

export const CSS_THEME_LIGHT = `
html[data-theme="light"] {${CSS_LIGHT_VARS}}
@media screen and (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) {${CSS_LIGHT_VARS}}
}
`;

export const CSS_BODY_STANDALONE = `
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
${CSS_THEME_LIGHT}`;

export const CSS_BODY_SESSION = `
body {
  background: var(--bg);
  color: var(--fg);
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.6;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
}
${CSS_THEME_LIGHT}`;

/** Print/PDF :root overrides (inside @media print). */
export const CSS_PRINT_ROOT_VARS = `
    --bg: #ffffff;
    --surface: #ffffff;
    --surface2: #f5f5f7;
    --fg: #111113;
    --fg2: #444449;
    --fg3: #6b6b73;
    --border: rgba(0, 0, 0, 0.1);
    --accent: #6d5cce;
    --green: #1a8a42;
    --green-dim: rgba(26, 138, 66, 0.08);
    --red: #c43838;
    --red-dim: rgba(196, 56, 56, 0.08);
    --orange: #b57820;
    --orange-dim: rgba(181, 120, 32, 0.08);
`;

/** Marker replaced when composing SESSION_VIEWER_CSS. */
export const CSS_PRINT_ROOT_MARKER = "__CSS_PRINT_ROOT_VARS__";

/** Standalone base for compare + browser index (embed before page-specific CSS). */
export const STANDALONE_BASE_CSS =
  CSS_ROOT_STANDALONE + CSS_RESET + CSS_BODY_STANDALONE;

/** Session viewer base (embed before layout rules). */
export const SESSION_VIEWER_BASE_CSS =
  CSS_ROOT_SESSION + CSS_RESET + CSS_BODY_SESSION;