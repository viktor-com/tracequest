/**
 * tracequest design tokens, derived from cursor.com/brand (measured from the
 * live site's computed styles, October 2026).
 *
 * Paper and ink, warm. One accent (Cursor orange) used sparingly for brand
 * and attention; status colours are Cursor's ANSI green and red. Text and
 * borders are the ink colour mixed down, so every grey stays in temperature.
 *
 * Dark is the default. Light applies when the system prefers it, unless the
 * user chose a theme (html[data-theme], remembered by the app shell).
 */

/** Theme-independent tokens: type, space, shape, motion, layers. */
export const TOKENS_STATIC = `
  --font-sans: "CursorGothic", "Inter Variable", Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  --font-mono: "Berkeley Mono", ui-monospace, "SF Mono", SFMono-Regular, Menlo, "JetBrains Mono", Consolas, monospace;

  /* type scale: size / line-height (px); headings 400 with negative tracking */
  --text-2xs: 11px; --lh-2xs: 16px;
  --text-xs: 12px;  --lh-xs: 16px;
  --text-sm: 13px;  --lh-sm: 20px;
  --text-md: 14px;  --lh-md: 20px;
  --text-lg: 16px;  --lh-lg: 24px;
  --text-xl: 20px;  --lh-xl: 26px;
  --text-2xl: 26px; --lh-2xl: 32px;
  --text-3xl: 36px; --lh-3xl: 42px;
  --track-tight: -0.0125em;
  --track-display: -0.02em;
  --weight-regular: 400;
  --weight-medium: 500;

  /* 4px grid */
  --space-0: 2px; --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-8: 32px; --space-10: 40px; --space-12: 48px; --space-16: 64px;

  /* shape: controls are pills, surfaces are softly rounded */
  --radius-xs: 4px; --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px; --radius-xl: 16px; --radius-pill: 999px;
  --control-sm: 24px; --control-md: 30px; --control-lg: 36px;

  /* motion: short, eased, never decorative */
  --ease-out: cubic-bezier(0.2, 0.8, 0.2, 1);
  --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --dur-1: 90ms; --dur-2: 160ms; --dur-3: 240ms; --dur-4: 360ms;

  /* layers */
  --z-sticky: 20; --z-rail: 30; --z-popover: 200; --z-dialog: 400; --z-palette: 600; --z-toast: 800;

  --shell-top: 52px;
  --content-max: 1200px;
  --reading-max: 760px;
`;

/** Dark (default): warm near-black paper, warm off-white ink. */
export const TOKENS_DARK = `
  color-scheme: dark;
  --ink: #edecec;
  --paper: #14120b;
  --bg: #14120b;
  --bg-sunken: #100e08;
  --surface-1: #1b1913;
  --surface-2: #201e18;
  --surface-3: #26241e;
  --surface-4: #2b2923;
  --surface-pop: #201e18;
  --text: #edecec;
  --text-2: color-mix(in oklab, #edecec 62%, transparent);
  --text-3: color-mix(in oklab, #edecec 42%, transparent);
  --text-4: color-mix(in oklab, #edecec 26%, transparent);
  --line-1: color-mix(in oklab, #edecec 6%, transparent);
  --line-2: color-mix(in oklab, #edecec 10%, transparent);
  --line-3: color-mix(in oklab, #edecec 20%, transparent);
  --hover: color-mix(in oklab, #edecec 5%, transparent);
  --press: color-mix(in oklab, #edecec 9%, transparent);
  --accent: #f54e00;
  --accent-text: #ff7a3d;
  --accent-soft: color-mix(in srgb, #f54e00 14%, transparent);
  --ok: #3fae84;
  --ok-soft: color-mix(in srgb, #1f8a65 22%, transparent);
  --bad: #ec5a7c;
  --bad-soft: color-mix(in srgb, #cf2d56 20%, transparent);
  --warn: #e7a33e;
  --warn-soft: color-mix(in srgb, #e7a33e 16%, transparent);
  --info: #8fb4e3;
  --info-soft: color-mix(in srgb, #8fb4e3 14%, transparent);
  --focus: color-mix(in oklab, #edecec 55%, transparent);
  --selection: color-mix(in srgb, #8bc4f8 32%, transparent);
  --shadow-1: 0 1px 0 rgba(0, 0, 0, 0.25);
  --shadow-pop: 0 0 0 1px var(--line-2), 0 12px 32px rgba(0, 0, 0, 0.45), 0 2px 6px rgba(0, 0, 0, 0.3);
  --scrim: rgba(8, 7, 4, 0.62);
  /* categorical hues for agents and tools (Cursor timeline palette + ANSI) */
  --hue-claude: #d6a07f;
  --hue-codex: #9fc9a2;
  --hue-cursor: #edecec;
  --hue-cursor-cloud: #8fc8d6;
  --hue-factory: #e1c37a;
  --hue-opencode: #9fbbe0;
  --hue-grok: #c0a8dd;
  --hue-read: #9fbbe0;
  --hue-edit: #c0a8dd;
  --hue-grep: #9fc9a2;
  --hue-bash: #dfa88f;
  --hue-web: #8fc8d6;
  --hue-agent: #e1c37a;
  --hue-other: color-mix(in oklab, #edecec 40%, transparent);
`;

/** Light: warm paper, warm ink. Same names, re-pointed. */
export const TOKENS_LIGHT = `
  color-scheme: light;
  --ink: #26251e;
  --paper: #f7f7f4;
  --bg: #f7f7f4;
  --bg-sunken: #efeee9;
  --surface-1: #f2f1ed;
  --surface-2: #ebeae5;
  --surface-3: #e6e5e0;
  --surface-4: #dddcd6;
  --surface-pop: #fbfbf9;
  --text: #26251e;
  --text-2: color-mix(in oklab, #26251e 64%, transparent);
  --text-3: color-mix(in oklab, #26251e 46%, transparent);
  --text-4: color-mix(in oklab, #26251e 28%, transparent);
  --line-1: color-mix(in oklab, #26251e 6%, transparent);
  --line-2: color-mix(in oklab, #26251e 11%, transparent);
  --line-3: color-mix(in oklab, #26251e 22%, transparent);
  --hover: color-mix(in oklab, #26251e 4%, transparent);
  --press: color-mix(in oklab, #26251e 8%, transparent);
  --accent: #f54e00;
  --accent-text: #c63f00;
  --accent-soft: color-mix(in srgb, #f54e00 10%, transparent);
  --ok: #1f8a65;
  --ok-soft: color-mix(in srgb, #1f8a65 12%, transparent);
  --bad: #cf2d56;
  --bad-soft: color-mix(in srgb, #cf2d56 10%, transparent);
  --warn: #a8670a;
  --warn-soft: color-mix(in srgb, #c98a1b 14%, transparent);
  --info: #3d6aa8;
  --info-soft: color-mix(in srgb, #3d6aa8 10%, transparent);
  --focus: color-mix(in oklab, #26251e 50%, transparent);
  --selection: color-mix(in srgb, #8bc4f8 40%, transparent);
  --shadow-1: 0 1px 0 rgba(38, 37, 30, 0.04);
  --shadow-pop: 0 0 0 1px var(--line-2), 0 12px 32px rgba(38, 37, 30, 0.12), 0 2px 6px rgba(38, 37, 30, 0.06);
  --scrim: rgba(38, 37, 30, 0.28);
  --hue-claude: #b0603a;
  --hue-codex: #2f7d55;
  --hue-cursor: #26251e;
  --hue-cursor-cloud: #2a7f93;
  --hue-factory: #94700f;
  --hue-opencode: #3d6aa8;
  --hue-grok: #7a55a8;
  --hue-read: #3d6aa8;
  --hue-edit: #7a55a8;
  --hue-grep: #2f7d55;
  --hue-bash: #b0603a;
  --hue-web: #2a7f93;
  --hue-agent: #94700f;
  --hue-other: color-mix(in oklab, #26251e 45%, transparent);
`;

/** :root carries static + dark; light re-points on preference or choice. */
export const TOKENS_CSS = `
:root {${TOKENS_STATIC}${TOKENS_DARK}}
html[data-theme="light"] {${TOKENS_LIGHT}}
@media screen and (prefers-color-scheme: light) {
  html:not([data-theme="dark"]) {${TOKENS_LIGHT}}
}
@media print {
  :root, html[data-theme] {${TOKENS_LIGHT}}
}
`;

/** Source → hue token, for inline style="--hue: var(--hue-…)" chips. */
export function sourceHueVar(source) {
  const known = ["claude", "codex", "cursor", "cursor-cloud", "factory", "opencode", "grok"];
  return known.includes(source) ? `var(--hue-${source})` : "var(--hue-other)";
}
