/**
 * tmux availability gate — mirrors the playwright-gate pattern.
 * Skips tmux-dependent tests when tmux is not installed or
 * TRACEQUEST_SKIP_TMUX=1.
 */
import { spawnSync } from "node:child_process";

export const TMUX_SKIP_ENV = {
  SKIP: "TRACEQUEST_SKIP_TMUX",
};

/** @type {{ bin: string, version: string } | null} */
function resolveTmuxSync() {
  if (process.env[TMUX_SKIP_ENV.SKIP] === "1") return null;
  const bin = process.env.TRACEQUEST_TMUX_BIN || "tmux";
  try {
    const result = spawnSync(bin, ["-V"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status !== 0) return null;
    return { bin, version: String(result.stdout || "").trim() };
  } catch {
    return null;
  }
}

export const TMUX = resolveTmuxSync();

export const SKIP_NO_TMUX = TMUX
  ? {}
  : { skip: "tmux not installed (or TRACEQUEST_SKIP_TMUX=1)" };
