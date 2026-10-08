# Deploying a TraceQuest hub

Requires Node.js 22.5 or newer. A source checkout needs no runtime npm dependencies. SSH collection additionally needs OpenSSH, rsync and key-based read access to each source. The JavaScript indexer works without the optional Rust sidecar.

## Try it on a fresh machine

```sh
git clone https://github.com/viktor-com/tracequest.git
cd tracequest
node bin/tracequest.js insights --refresh --config examples/hub/config.json
node bin/tracequest.js serve --config examples/hub/config.json
```

Open http://127.0.0.1:7780/insights. The bundled synthetic Claude trace produces one analysed session and one test failure. Use the default all-time view; the sample has a fixed timestamp. Stop the server with Ctrl-C. Generated archives and caches under `examples/hub/state` are ignored.

## Configure real sources

Keep a private JSON file outside the checkout, for example `~/.config/tracequest/hub.json`:

```json
{
  "home": "~",
  "hostsDir": "./archive",
  "cacheDir": "./cache",
  "hosts": [
    { "spec": "dev@source.example", "hostId": "builder",
      "sources": { "claude": ".claude/projects", "codex": "/srv/traces/codex/sessions" } }
  ],
  "serve": { "hub": true, "bind": "127.0.0.1", "port": 7780 }
}
```

`home` selects the local provider trees and default state paths by setting HOME for the TraceQuest process. Omit it to use the account's home. `hostsDir` and `cacheDir` select durable imported recordings and rebuildable metadata/search/analysis caches. Relative paths resolve beside the config file; `~` expands using the launching account's home. Collector and server must use the same config. Keep source recordings readable by that account.

Each SSH host has a destination `spec` (including an SSH config alias) and unique display/archive `hostId`. Omit `sources` to collect all supported provider trees: Claude, Cursor, Codex, Factory, Grok and OpenCode. A `sources` map selects providers and overrides their remote paths; relative remote paths start at the remote account's home. Imported data retains the standard provider layout. Deleted remote recordings remain in the archive. `hosts: []` disables configured SSH sources. Without a `hosts` field, the existing `~/.tracequest/import-hosts` file is used. An optional `rsync` path selects an installed binary or a private transport wrapper.

`serve` accepts `hub`, `bind`, `port` and `filter`. Explicit CLI flags override these values. Without `bind` the hub listens on `127.0.0.1` only.

### Access

The hub has no login. Hub mode redacts secret-shaped strings and blocks writes, but recordings still contain prompts and source paths, so anyone who can reach the port can read them. Two supported ways to share it:

- **Private network (Tailscale, WireGuard or similar).** Set `bind` to the machine's address on that network, so only its members can connect. Never bind `0.0.0.0` on a machine with a public or shared interface.
- **Authenticating reverse proxy.** Keep the default `127.0.0.1` and put a proxy that enforces login in front of it, for example Caddy or nginx with `basic_auth`, `oauth2-proxy`, Cloudflare Access or `tailscale serve`.

The path-bleed detector recognizes standard worktree directories. For a custom checkout layout, add `checkoutPatterns`, an array of regular-expression strings matching the path through the checkout directory, including its trailing slash. For example, `"/checkouts/[^/]+/"` recognizes `/checkouts/build-1/shop/` and `/checkouts/build-2/shop/` as separate checkouts of `shop`. Keep deployment-specific patterns in the private config.

## Collect and serve

```sh
node bin/tracequest.js import ssh --config ~/.config/tracequest/hub.json
node bin/tracequest.js insights --refresh --config ~/.config/tracequest/hub.json
node bin/tracequest.js serve --config ~/.config/tracequest/hub.json
```

Schedule the first two commands with your machine's scheduler, in sequence, for example every 30 minutes. Run the third as a supervised long-lived service. Use absolute executable, checkout and config paths in scheduler definitions. SSH import is incremental and read-only on source machines; analysis uses local parsers and makes no model calls. All setup for a particular deployment belongs in its private config and service definitions.
