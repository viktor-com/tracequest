#!/usr/bin/env node
/**
 * Build one distribution tarball per supported platform:
 *   dist/tracequest-<version>-<platform>.tgz
 *
 * Each tarball carries exactly one sidecar binary, for the platform it names.
 * `npm pack` always writes tracequest-<version>.tgz, so the file is renamed
 * afterwards; the name inside package.json is unchanged.
 *
 * Usage:
 *   node scripts/pack-dist.mjs                  # every supported platform
 *   node scripts/pack-dist.mjs darwin-arm64     # one platform
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { SUPPORTED_PLATFORMS } from "./dist-platforms.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = createRequire(import.meta.url)(join(root, "package.json"));

const supported = SUPPORTED_PLATFORMS;
const requested = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const platforms = requested.length ? requested : supported;

for (const platform of platforms) {
  if (!supported.includes(platform)) {
    console.error(`pack-dist: unsupported platform ${platform}`);
    console.error(`supported: ${supported.join(", ")}`);
    process.exit(1);
  }
}

const distDir = join(root, "dist");
mkdirSync(distDir, { recursive: true });

for (const platform of platforms) {
  // prepack reads TRACEQUEST_DIST_PLATFORM: it stages that platform's sidecar
  // and the preflight refuses to continue if the staged binary disagrees.
  const env = { ...process.env, TRACEQUEST_DIST_PLATFORM: platform };
  const packed = join(root, `tracequest-${version}.tgz`);
  rmSync(packed, { force: true });

  const result = spawnSync("npm", ["pack", "--silent"], { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`pack-dist: npm pack failed for ${platform}`);
    process.exit(result.status ?? 1);
  }
  if (!existsSync(packed)) {
    console.error(`pack-dist: expected ${packed}`);
    process.exit(1);
  }

  const dest = join(distDir, `tracequest-${version}-${platform}.tgz`);
  renameSync(packed, dest);
  console.log(`pack-dist: dist/tracequest-${version}-${platform}.tgz`);
}
