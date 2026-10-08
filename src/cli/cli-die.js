import { isColorEnabled } from "./cli-color.js";

/** ANSI-wrapped CLI error line (stderr), honoring NO_COLOR / non-TTY stderr. */
export function formatCliError(msg) {
  return isColorEnabled(process.stderr)
    ? `\x1b[31mError: ${msg}\x1b[0m`
    : `Error: ${msg}`;
}

/** CLI fatal error — shared by command modules to avoid circular imports */
export function die(msg) {
  console.error(formatCliError(msg));
  process.exit(1);
}