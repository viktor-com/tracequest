/**
 * Base stylesheet for every page: the tracequest design system (src/ui).
 * Kept under its historical name so page modules import one base.
 */
import { DESIGN_SYSTEM_CSS } from "../ui/index.js";

/** App pages (Runs, Chat, Compare, Insights, errors). */
export const STANDALONE_BASE_CSS = DESIGN_SYSTEM_CSS;

/** Session viewer and its exported/shared HTML. */
export const SESSION_VIEWER_BASE_CSS = DESIGN_SYSTEM_CSS;
