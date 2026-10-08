/**
 * Playwright availability gate — mirrors sidecar SKIP_NO_SIDECAR pattern.
 * Skips browser tests when chromium is not installed or TRACEQUEST_SKIP_PLAYWRIGHT=1.
 */
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);

export const PLAYWRIGHT_SKIP_ENV = {
  SKIP: "TRACEQUEST_SKIP_PLAYWRIGHT",
};

/** @type {{ chromium: import('playwright').ChromiumBrowserType } | null} */
let resolved = null;

function resolvePlaywrightSync() {
  if (process.env[PLAYWRIGHT_SKIP_ENV.SKIP] === "1") return null;
  try {
    const { chromium } = require("playwright");
    const executablePath = chromium.executablePath();
    if (!executablePath || !existsSync(executablePath)) return null;
    return { chromium };
  } catch {
    return null;
  }
}

resolved = resolvePlaywrightSync();

export const PLAYWRIGHT = resolved;

export const SKIP_NO_PLAYWRIGHT = PLAYWRIGHT
  ? {}
  : {
      skip:
        "Playwright chromium not installed (npm i -D playwright && npx playwright install chromium)",
    };