// Centralized ANSI color helper with NO_COLOR + TTY awareness.
//
// Rules (checked per call so late `setColorEnabled` / env changes take effect):
//   1. An explicit override via setColorEnabled(true|false) wins (used by --no-color).
//   2. FORCE_COLOR forces color on (any non-"0" value) or off ("0").
//   3. NO_COLOR, when present with any value, disables color (https://no-color.org).
//   4. Otherwise color is enabled only when stdout is a TTY, so piped/redirected
//      output stays plain text.

let colorOverride = null; // null = auto; true/false = explicit override

function envForceColor() {
  const v = process.env.FORCE_COLOR;
  if (v === "0") return false;
  if (v != null && v !== "") return true;
  return null;
}

/** Explicitly force color on/off, or pass null to return to auto-detection. */
export function setColorEnabled(enabled) {
  colorOverride = enabled == null ? null : !!enabled;
}

/** Resolve whether ANSI color should be emitted on `stream` right now. */
export function isColorEnabled(stream = process.stdout) {
  if (colorOverride !== null) return colorOverride;
  const forced = envForceColor();
  if (forced !== null) return forced;
  if (process.env.NO_COLOR != null) return false;
  return !!(stream && stream.isTTY);
}

function wrap(code) {
  return (s) => (isColorEnabled() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
}

/** Minimal ANSI color helper — zero dependencies, NO_COLOR/TTY-aware. */
export const k = {
  red: wrap(31),
  green: wrap(32),
  yellow: wrap(33),
  cyan: wrap(36),
  bold: wrap(1),
  dim: wrap(2),
};
