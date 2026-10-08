/**
 * Supported distribution platforms → the Rust target that builds each.
 *
 * Apple Silicon and Linux x86_64. Each platform is built on a native CI runner —
 * cross-compiled binaries would ship untested on the hardware that runs them.
 * darwin-x64 (Intel) is disabled because GitHub no longer allocates macos-13
 * hosted runners for this repo; re-add it here and in .github/workflows/release.yml
 * once a native Intel runner (or a Rosetta-tested cross-build) is available:
 *   "darwin-x64": "x86_64-apple-darwin",
 */
export const PLATFORM_TO_RUST_TARGET = {
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
};

export const SUPPORTED_PLATFORMS = Object.keys(PLATFORM_TO_RUST_TARGET);
