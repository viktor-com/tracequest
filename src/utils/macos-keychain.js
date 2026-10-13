import { execFile } from "node:child_process";

/**
 * Read one generic-password item's secret from the macOS login Keychain via
 * /usr/bin/security (not a harness binary). Resolves null on any failure —
 * missing item, locked Keychain, timeout — and never logs the secret.
 */
export function readKeychainPassword(service, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/security",
      ["find-generic-password", "-s", service, "-w"],
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout) => resolve(err ? null : String(stdout || "").trim() || null),
    );
  });
}
