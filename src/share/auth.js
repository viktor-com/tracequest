import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Resolve GitHub token: GITHUB_TOKEN → gh auth token → error. */
export function resolveGhToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** Resolve Hugging Face token: HF_TOKEN → ~/.cache/huggingface/token → error. */
export function resolveHfToken() {
  if (process.env.HF_TOKEN) return process.env.HF_TOKEN.trim();
  const cachePath = join(homedir(), ".cache", "huggingface", "token");
  if (existsSync(cachePath)) {
    try {
      return readFileSync(cachePath, "utf8").trim();
    } catch {
      return null;
    }
  }
  return null;
}