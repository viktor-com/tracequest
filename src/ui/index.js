/**
 * The tracequest design system: tokens (dark + light) and the component
 * layer. Every page embeds DESIGN_SYSTEM_CSS first, then its own screen CSS.
 */
import { TOKENS_CSS } from "./tokens.js";
import { COMPONENTS_CSS } from "./components.js";

export { TOKENS_CSS, TOKENS_STATIC, TOKENS_DARK, TOKENS_LIGHT, sourceHueVar } from "./tokens.js";
export { COMPONENTS_CSS, ICONS } from "./components.js";

export const DESIGN_SYSTEM_CSS = TOKENS_CSS + COMPONENTS_CSS;
