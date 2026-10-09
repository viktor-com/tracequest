/**
 * The tracequest design system: tokens (dark + light) and the component
 * layer. Every page embeds DESIGN_SYSTEM_CSS first, then its own screen CSS.
 */
import { TOKENS_CSS } from "./tokens.js";
import { COMPONENTS_CSS } from "./components.js";

export { TOKENS_CSS, TOKENS_STATIC, TOKENS_DARK, TOKENS_LIGHT, sourceHueVar } from "./tokens.js";
export { COMPONENTS_CSS, ICONS } from "./components.js";

/**
 * Bridge for stylesheets not yet rewritten onto the system: the old token
 * names resolve to the new ones, so they inherit the palette and both
 * themes. Each screen PR drops its uses; the last one removes this block.
 */
export const LEGACY_ALIASES_CSS = `
:root, html[data-theme] {
  --surface: var(--surface-1);
  --surface2: var(--surface-3);
  --fg: var(--text);
  --fg2: var(--text-2);
  --fg3: var(--text-3);
  --border: var(--line-2);
  --red: var(--bad);
  --green: var(--ok);
  --orange: var(--warn);
  --sans: var(--font-sans);
  --mono: var(--font-mono);
  --accent-dim: var(--accent-soft);
  --green-dim: var(--ok-soft);
  --red-dim: var(--bad-soft);
  --orange-dim: var(--warn-soft);
  --radius: var(--radius-lg);
  --chip-tint: color-mix(in oklab, var(--bg) 78%, transparent);
}
`;

export const DESIGN_SYSTEM_CSS = TOKENS_CSS + LEGACY_ALIASES_CSS + COMPONENTS_CSS;
