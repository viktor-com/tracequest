# Contributing to tracequest

Bug reports, fixes and new trace-format adapters are welcome. tracequest is
released under the [MIT License](LICENSE); by submitting a pull request you agree
that your contribution is licensed under the same terms. No copyright assignment
or CLA is needed.

Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security issues privately as described in [SECURITY.md](SECURITY.md), not in
public issues.

## Third-party code

`data/secret-rules.json` is the MIT-licensed gitleaks ruleset, redistributed under the
terms reproduced in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Any new
third-party code must carry an MIT-compatible license (MIT, BSD, ISC, Apache-2.0), and
its notice must be added to that file in the same commit that vendors it.

## Development

- Clone the repo: `git clone https://github.com/viktor-com/tracequest.git`
- No runtime dependencies (zero-dependency CLI)
- Install dev tools if needed for `facts` (optional)
- Run tests: `npm test`
- Run CLI: `node bin/tracequest.js --help` (or `npm run dev`)
- Explore the codebase in `bin/`, `src/`, `test/`
- For UI changes, start with [docs/ui-guidelines.md](docs/ui-guidelines.md) (jobs, information architecture, states) and [docs/design-system.md](docs/design-system.md) (tokens, components, themes).

See [README.md](README.md) for the product overview and [docs/README.md](docs/README.md)
for installation, usage examples and technical documentation.

## Facts-driven workflow

This project follows a strict **facts-driven development** process using the [facts](https://github.com/av/facts) tool for specification and documentation.

All features, fixes, and refactors must follow the workflow described in [CLAUDE.md](CLAUDE.md):

- **Read the spec**: `facts list` (use filters like `--tags "spec"`, `--section "..."`)
- **Check coverage**: Ensure a `@spec` fact exists for planned behavior (`facts list --tags "spec"`)
- **Write missing facts** (if needed): `facts add ... --tags "spec"`
- **Implement** the change
- **Verify**: `facts check --tags "spec"` or `facts get <id>`
- **Tag done**: `facts edit <id> --remove-tag "spec" --add-tag "implemented"`

**Skills reference**: Run `facts skills show facts` for the full format spec and command reference. Key skills include `facts-refine`, `facts-discover`, and `facts-implement`.

Review existing facts with `facts list` before starting work. The `## domain` section defines project vocabulary.

## Changes

- Create a topic branch from the latest main
- Follow the facts-driven workflow above for any code or behavior changes
- Keep changes minimal and focused
- Ensure `npm test` passes cleanly
- Update relevant documentation (README, CHANGELOG if releasing) as needed
- Reference fact IDs in the commit or PR description

## Releasing

tracequest is not published to a registry yet. `package.json` sets `"private": true`, and a
`prepublishOnly` hook aborts `npm publish` unconditionally. Releases are per-platform
tarballs attached to GitHub Releases.

Releasing is automated and needs no configured secrets. Bump the version, then push a
matching `v*` tag: [.github/workflows/release.yml](.github/workflows/release.yml) verifies
the tag against `package.json`, runs the test suite on each platform's native runner,
builds and smoke-tests the per-platform tarballs, and attaches them to a GitHub Release
using the workflow's built-in `GITHUB_TOKEN`. The GitHub Release is the hosting; there is
no external bucket. The `prepack` preflight (`scripts/preflight-dist.mjs`) aborts the pack
if the LICENSE is not MIT, the third-party notices are missing, or the package is
not marked private.

There is **one tarball per platform**, each carrying a sidecar binary built natively
for that CPU: `tracequest-<version>-<platform>.tgz`. Supported platforms live in
[scripts/dist-platforms.mjs](scripts/dist-platforms.mjs) — currently `darwin-arm64`
and `linux-x64` (glibc, built on `ubuntu-24.04`). Adding a platform means adding a native CI runner for it; a
cross-compiled sidecar would ship untested on the hardware that runs it.

Build them locally with `npm run dist` (all platforms) or `npm run dist -- linux-x64`.
`prepack` stages exactly one sidecar into `sidecar/bin/<platform>/`, clearing the
directory first so one platform's binary cannot ride along inside another's tarball,
and the preflight reads the staged binary's real CPU architecture back out of its
Mach-O header before allowing the pack.

---

For questions, open a GitHub issue or discussion.
