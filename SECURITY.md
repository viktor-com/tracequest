# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest release | :white_check_mark: |
| older   | :x:                |

## Reporting a Vulnerability

We take security seriously.

Please report vulnerabilities privately using GitHub Security Advisories:

https://github.com/viktor-com/tracequest/security/advisories/new

Do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.

## Scope

`tracequest serve` has no authentication. Its API can read every local agent session
and can launch, steer and kill agent runs. It listens on `127.0.0.1` by default; binding
it to another address with `--bind` exposes all of that to anyone who can reach the
port. Exposure only through a trusted network or an authenticating reverse proxy is the
supported setup; reports about an intentionally exposed server are still welcome.


This policy covers the CLI tool and server code in this repository.

`tracequest import ssh` copies session recordings from remote machines you name on the command line (or in `~/.tracequest/import-hosts`). It runs `rsync` over `ssh -o BatchMode=yes` (no password prompt), copies only the five filesystem session trees (not credentials, not OpenCode's db), and never prints identity-file contents. Network I/O to SSH hosts happens only when that command runs.
