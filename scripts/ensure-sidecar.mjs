#!/usr/bin/env node
/**
 * Build tracequest-sidecar only when the release binary is missing or is not a
 * native executable. Keeps `bun start` / `npm start` quiet when it is already built.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNativeExecutable } from "../src/sessions/native-executable.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bin = join(root, "sidecar/target/release/tracequest-sidecar");

if (existsSync(bin) && isNativeExecutable(bin)) {
  process.exit(0);
}

const result = spawnSync("cargo", ["build", "--release"], {
  cwd: join(root, "sidecar"),
  stdio: "inherit",
});
// No Rust toolchain: tracequest falls back to its JS indexer, so starting must
// not fail. Building the sidecar is a speed-up, not a requirement.
if (result.error?.code === "ENOENT") {
  console.warn("tracequest: cargo not found, using the JS indexer (install Rust to build the faster sidecar)");
  process.exit(0);
}
process.exit(result.status ?? 1);
