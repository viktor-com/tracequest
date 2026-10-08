#!/usr/bin/env node
/**
 * Distribution guard.
 *
 * tracequest ships as per-platform tarballs on GitHub Releases, not via a registry.
 * Run as `prepack`, this validates the tarball before it is built. Run as
 * `prepublishOnly --forbid-publish`, it unconditionally aborts `npm publish`:
 * `"private": true` is supposed to do that too, but npm does not enforce it under
 * --dry-run, so this hook is the check that is actually observable.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExecutableTarget } from "../src/sessions/native-executable.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, name), "utf8");

if (process.argv.includes("--forbid-publish")) {
  console.error("refusing to publish: tracequest is not published to any registry yet.");
  console.error("distribute the tarball instead: npm pack");
  process.exit(1);
}

const errors = [];

let pkg;
try {
  pkg = JSON.parse(read("package.json"));
} catch (err) {
  errors.push(`package.json unreadable: ${err.message}`);
}

if (pkg) {
  if (pkg.private !== true) errors.push('package.json must set "private": true');
  if (pkg.publishConfig) errors.push("package.json must not define publishConfig");
  if (!pkg.files?.includes("THIRD-PARTY-NOTICES.md")) {
    errors.push('package.json "files" must include THIRD-PARTY-NOTICES.md');
  }
  if (!pkg.files?.includes("sidecar/bin/")) {
    errors.push('package.json "files" must include sidecar/bin/');
  }
}

// A tarball with no bundled sidecar silently degrades to the JS indexer on the
// recipient's machine. Distribution is one tarball per platform, so sidecar/bin
// must hold exactly one platform: the one this tarball is named after.
const binRoot = join(root, "sidecar/bin");
const target = process.env.TRACEQUEST_DIST_PLATFORM || `${process.platform}-${process.arch}`;
const staged = existsSync(binRoot) ? readdirSync(binRoot) : [];

if (!staged.length) {
  errors.push("sidecar/bin/ contains no bundled sidecar (run: npm run build:sidecar:bundle)");
} else if (staged.length > 1) {
  errors.push(`sidecar/bin/ holds ${staged.length} platforms (${staged.join(", ")}); expected only ${target}`);
} else if (staged[0] !== target) {
  errors.push(`sidecar/bin/ holds ${staged[0]}, but this tarball targets ${target}`);
} else {
  const [osName, arch] = target.split("-");
  const exe = osName === "win32" ? "tracequest-sidecar.exe" : "tracequest-sidecar";
  const binary = join(binRoot, target, exe);
  if (!existsSync(binary)) {
    errors.push(`sidecar/bin/${target}/ has no ${exe}`);
  } else {
    const found = readExecutableTarget(binary);
    if (!found) errors.push(`sidecar/bin/${target}/${exe} is not a native executable`);
    else if (found.arch !== arch) {
      errors.push(`sidecar/bin/${target}/${exe} is ${found.arch ?? "unknown"}, expected ${arch}`);
    } else {
      console.log(`preflight: bundled sidecar ${target} (${found.format}/${found.arch})`);
    }
  }
}

try {
  const license = read("LICENSE");
  if (!/^MIT License/.test(license)) errors.push("LICENSE is not the MIT License");
} catch {
  errors.push("LICENSE is missing");
}

try {
  const notices = read("THIRD-PARTY-NOTICES.md");
  if (!/gitleaks/i.test(notices) || !/Zachary Rice/.test(notices)) {
    errors.push("THIRD-PARTY-NOTICES.md is missing the gitleaks attribution");
  }
} catch {
  errors.push("THIRD-PARTY-NOTICES.md is missing");
}

if (errors.length) {
  console.error("distribution preflight failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
