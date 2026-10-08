#!/usr/bin/env node
/**
 * Build the sidecar and stage it into sidecar/bin/<platform>-<arch>/, the
 * location the distribution tarball ships and detectSidecar prefers.
 *
 * Usage:
 *   node scripts/bundle-sidecar.mjs                     # host platform
 *   node scripts/bundle-sidecar.mjs --platform darwin-x64
 *   TRACEQUEST_DIST_PLATFORM=darwin-x64 node scripts/bundle-sidecar.mjs
 *
 * Distribution is one tarball per platform, so sidecar/bin/ must contain
 * exactly one platform directory: the one this tarball is named after. The
 * directory is cleared before staging, otherwise a previous build would ride
 * along inside the next platform's tarball.
 *
 * The staged binary's real CPU architecture is read back from its Mach-O/ELF
 * header. Magic bytes alone cannot distinguish arm64 from x86_64, and a
 * mislabeled artifact would degrade that platform to the JS indexer silently.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExecutableTarget } from "../src/sessions/native-executable.js";
import { PLATFORM_TO_RUST_TARGET } from "./dist-platforms.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function parsePlatform() {
  const flag = process.argv.indexOf("--platform");
  if (flag !== -1) {
    const value = process.argv[flag + 1];
    if (!value) {
      console.error("bundle-sidecar: --platform requires a value");
      process.exit(1);
    }
    return value;
  }
  return process.env.TRACEQUEST_DIST_PLATFORM || `${process.platform}-${process.arch}`;
}

const platform = parsePlatform();
const rustTarget = PLATFORM_TO_RUST_TARGET[platform];
if (!rustTarget) {
  console.error(`bundle-sidecar: unsupported platform ${platform}`);
  console.error(`supported: ${Object.keys(PLATFORM_TO_RUST_TARGET).join(", ")}`);
  process.exit(1);
}

const [osName, arch] = platform.split("-");
const exe = osName === "win32" ? "tracequest-sidecar.exe" : "tracequest-sidecar";

const build = spawnSync("cargo", ["build", "--release", "--target", rustTarget], {
  cwd: join(root, "sidecar"),
  stdio: "inherit",
});
if (build.status !== 0) {
  console.error("bundle-sidecar: cargo build failed");
  process.exit(build.status ?? 1);
}

const built = join(root, "sidecar/target", rustTarget, "release", exe);
if (!existsSync(built)) {
  console.error(`bundle-sidecar: expected binary at ${built}`);
  process.exit(1);
}

const found = readExecutableTarget(built);
if (!found) {
  console.error(`bundle-sidecar: ${built} is not a recognized native executable`);
  process.exit(1);
}
if (found.arch !== arch) {
  console.error(
    `bundle-sidecar: ${built} is ${found.format}/${found.arch ?? "unknown"}, expected ${arch}`,
  );
  process.exit(1);
}

// One platform per tarball: never let a previous build leak into this one.
const binRoot = join(root, "sidecar/bin");
rmSync(binRoot, { recursive: true, force: true });

const destDir = join(binRoot, platform);
mkdirSync(destDir, { recursive: true });
const dest = join(destDir, exe);
copyFileSync(built, dest);
chmodSync(dest, 0o755);
console.log(`bundle-sidecar: staged ${platform} (${found.format}/${found.arch})`);
