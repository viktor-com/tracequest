# Installation and local setup

[Documentation home](README.md) · [CLI reference](cli-reference.md)

Needs Node.js 22.5 or newer and git. tmux is optional (used for launching runs);
Rust is optional (builds a faster indexer; without it tracequest uses its JS one).

```bash
git clone https://github.com/viktor-com/tracequest.git
cd tracequest
npm install
npm run demo        # serves the bundled sample sessions in examples/
```

Open http://localhost:7777. To browse your own sessions instead:

```bash
npm start           # same as: node bin/tracequest.js serve
```

To put `tracequest` on your PATH, run `npm link` in the clone. The server listens on
`127.0.0.1` only. It has no authentication and can launch agents, so read
[SECURITY.md](../SECURITY.md) before passing `--bind` another address.

Prebuilt per-platform tarballs (macOS arm64, Linux x64) are attached to each
[GitHub Release](https://github.com/viktor-com/tracequest/releases):
`npm install -g ./tracequest-<version>-<platform>.tgz`.

Stop the demo with Ctrl-C before running `npm start` on the same port.
If port 7777 is already in use, run `npm run demo -- --port 7778` and open
http://localhost:7778 instead.

`npm run demo` uses only the bundled synthetic traces and its own tmux socket.
`npm start` discovers recordings from your installed coding agents; no recording
means an empty session list. [Supported sources and paths](cli-reference.md#supported-sources)
are listed in the CLI reference.

## Network access

tracequest reads local files, sends no telemetry and makes no network calls unless
you ask: `share` (GitHub Gists or Hugging Face), `import cursor-cloud` (Cursor API),
`import ssh` (your hosts), `limits`, and `serve --usage-limits`. The last two ask
Anthropic, OpenAI and xAI for your remaining plan windows, using the credentials your
installed agent CLIs already store.

## Troubleshooting

- **No sessions appear:** run `node bin/tracequest.js list` to check discovery.
  Cursor Cloud Agents and remote machines require an explicit import.
- **No Rust toolchain:** the JavaScript indexer works without it. Rust only speeds
  up indexing; browsing and rendering remain available.
- **No tmux:** you can browse, search and analyse recordings. Install tmux to
  launch and control new agent runs from the browser.

## License

TraceQuest is available under the [MIT License](../LICENSE). Bundled third-party
code is documented in [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md).
