# Core CLI Integration Tests

End-to-end integration tests for tracequest's primary CLI workflows: session discovery, rendering, search/filter, messages export, and the serve HTTP browser. Tests exercise real component interactions (CLI entry → parse → index → render/server) without mocking internal modules.

Sharing-specific workflows are covered separately in `tests/sharing-integration.md`.

Automated harness: `test/bin/tracequest-integration.test.js` (16 scenarios). Run via `npm run test:integration` or `npm test`.

## Prerequisites

- Node.js (same major as CI) and repo dependencies installed (`npm install` if needed).
- Run all commands from the repository root: `/home/dev/code/tracequest`.
- Invoke the CLI as `node ./bin/tracequest.js` (not a global install) so tests track the working tree.
- Set `TRACEQUEST_NO_SIDECAR=1` on commands that touch session discovery or indexing to avoid sidecar binary dependencies and keep runs deterministic.
- Use a writable temp directory for synthetic fixtures: `/tmp/tracequest-integration-tests`.
- For discovery tests (list, find, search, latest, serve), seed sessions under a temporary `HOME` override:
  1. `export TQ_HOME=$(mktemp -d /tmp/tracequest-integration-home-XXXXXX)`
  2. Create `$TQ_HOME/.claude/projects/integration-smoke/` with at least one valid Claude JSONL session (user prompt + assistant reply).
  3. Prefix discovery commands with `HOME=$TQ_HOME TRACEQUEST_NO_SIDECAR=1`.
- Tear down temp dirs after each test: `rm -rf /tmp/tracequest-integration-tests $TQ_HOME`.

---

## Test 1: CLI help documents core commands

**Steps:**
1. Run `node ./bin/tracequest.js --help` from the repo root.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `tracequest` and a `Commands:` section.
3. stdout documents subcommands: `render`, `messages`, `list`, `find`, `search`, `latest`, `share`, `serve`, and `presets`.
4. stdout documents global flags `-h, --help` and `-v, --version`.

---

## Test 2: CLI version prints package.json semver

**Steps:**
1. Read `version` from `package.json`.
2. Run `node ./bin/tracequest.js --version`.

**Expectations:**
1. Exit code is `0`.
2. stdout trimmed equals the `package.json` version string exactly.

---

## Test 3: render produces self-contained HTML from a session file

**Steps:**
1. Create `/tmp/tracequest-integration-tests/render-session.jsonl` with a minimal Claude session (one user message, one assistant reply).
2. Run `node ./bin/tracequest.js render /tmp/tracequest-integration-tests/render-session.jsonl --out /tmp/tracequest-integration-tests/render-out.html`.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Written:` and the output path.
3. `/tmp/tracequest-integration-tests/render-out.html` exists and is non-empty.
4. The HTML contains `<html`, a `SESSION =` assignment in a `<script>` block, and embedded CSS (no external stylesheet `href` required for core view).

---

## Test 4: messages exports valid Anthropic-format JSON

**Steps:**
1. Reuse or recreate the session JSONL from Test 3.
2. Run `node ./bin/tracequest.js messages /tmp/tracequest-integration-tests/render-session.jsonl`.

**Expectations:**
1. Exit code is `0`.
2. stderr contains `Parsing session`.
3. stdout parses as JSON with a `messages` array containing at least two entries.
4. First message has `role: "user"`; second has `role: "assistant"`.
5. User `content` is an array of typed blocks (e.g. `{ type: "text", ... }`).

---

## Test 5: list discovers seeded sessions under HOME override

**Steps:**
1. Seed `$TQ_HOME/.claude/projects/integration-smoke/` with `smoke-session.jsonl` (valid Claude JSONL).
2. Run `HOME=$TQ_HOME TRACEQUEST_NO_SIDECAR=1 node ./bin/tracequest.js list integration-smoke`.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Found` and a positive session count.
3. stdout references `integration-smoke` (project name) and the session path under `$TQ_HOME/.claude/projects/`.
4. stdout includes a `claude` source label.

---

## Test 6: find filters sessions by model expression

**Steps:**
1. Seed `$TQ_HOME` with two projects: one session using model `claude-sonnet-4-20250514`, another using `claude-opus-4-20250514`.
2. Run `HOME=$TQ_HOME TRACEQUEST_NO_SIDECAR=1 node ./bin/tracequest.js find "model:sonnet"`.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Found` with count ≥ 1.
3. stdout includes the sonnet project name.
4. stdout does not include the opus-only project name.

---

## Test 7: search matches free-text in session prompts

**Steps:**
1. Seed a session whose first user prompt contains the unique phrase `integration-search-marker-xyz`.
2. Run `HOME=$TQ_HOME TRACEQUEST_NO_SIDECAR=1 node ./bin/tracequest.js search "integration-search-marker-xyz"`.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Found` with count ≥ 1.
3. stdout references the seeded session's project or path.

---

## Test 8: latest renders the most recent matching session

**Steps:**
1. Seed two sessions under `$TQ_HOME/.claude/projects/integration-latest/` with different mtimes (touch the newer file after creation).
2. Run `HOME=$TQ_HOME TRACEQUEST_NO_SIDECAR=1 node ./bin/tracequest.js latest integration-latest --out /tmp/tracequest-integration-tests/latest-out.html`.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Written:`.
3. `/tmp/tracequest-integration-tests/latest-out.html` exists.
4. The rendered HTML's embedded session id or filename corresponds to the newer session (verify via `grep` of session id substring in the HTML).

---

## Test 9: serve starts HTTP server and serves the browser shell

**Steps:**
1. Seed at least one session under `$TQ_HOME` (as in Test 5).
2. Pick a free port (e.g. `18877`).
3. Start `HOME=$TQ_HOME TRACEQUEST_NO_SIDECAR=1 node ./bin/tracequest.js serve --port 18877` in the background.
4. Wait until `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18877/` returns `200`.
5. `curl -s http://127.0.0.1:18877/` and fetch `http://127.0.0.1:18877/api/sessions`.
6. Stop the background server (`kill` the PID).

**Expectations:**
1. Server process starts without immediate exit.
2. `GET /` returns HTTP `200` with HTML containing tracequest browser markup (e.g. `tracequest` or session list UI hooks).
3. `GET /api/sessions` returns HTTP `200` with JSON containing a `sessions` array with length ≥ 1.
4. At least one session entry includes `source`, `project`, and `path` fields.

---

## Test 10: presets lists built-in default and local configurations

**Steps:**
1. Run `node ./bin/tracequest.js presets`.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Built-in presets` (or equivalent heading).
3. stdout lists `default` with port `7777` and `local` with port `8888`.
4. `node ./bin/tracequest.js preset` produces the same output as `presets` (alias).

---

## Test 11: invalid inputs fail with clear CLI errors (no stack traces)

**Steps:**
1. Run `node ./bin/tracequest.js render` (no path).
2. Run `node ./bin/tracequest.js not-a-command`.
3. Run `node ./bin/tracequest.js serve --port 0`.

**Expectations:**
1. Each command exits with code `1`.
2. stderr begins with or contains `Error:` and a human-readable message.
3. stderr does not contain `node:internal` uncaught exception stack traces.

---

## Test 12: render missing file reports file-not-found

**Steps:**
1. Run `node ./bin/tracequest.js render /tmp/tracequest-nonexistent-session-12345.jsonl`.

**Expectations:**
1. Exit code is `1`.
2. stderr contains `Error: File not found`.
3. stdout is empty.

---

## Test 13: find compound AND expression narrows to matching sessions

**Steps:**
1. Seed three sessions: sonnet + opus under `expr-compound-alpha`, sonnet under `expr-compound-beta`.
2. Run `find --filter "project:expr-compound-alpha AND model:sonnet"`.

**Expectations:**
1. Exit code is `0`.
2. stdout reports `Found 1 session`.
3. stdout includes `alpha-sonnet.jsonl` under `expr-compound-alpha`.
4. stdout excludes `alpha-opus.jsonl` and any path under `expr-compound-beta`.

---

## Test 13b: find positional and --filter expressions combine with AND

**Steps:**
1. Seed three sessions: sonnet + opus under `expr-pos-filter-alpha`, sonnet under `expr-pos-filter-beta`.
2. Run `find "project:expr-pos-filter-alpha" --filter "model:sonnet"`.

**Expectations:**
1. Exit code is `0`.
2. stdout reports `Found 1 session`.
3. stdout includes `alpha-sonnet.jsonl` under `expr-pos-filter-alpha`.
4. stdout excludes `alpha-opus.jsonl` and any path under `expr-pos-filter-beta`.

---

## Test 14: find OR expression matches either branch

**Steps:**
1. Seed sonnet, opus, and haiku sessions under `expr-or-mix`.
2. Run `find "model:sonnet OR model:opus"`.

**Expectations:**
1. Exit code is `0`.
2. stdout reports `Found 2 sessions`.
3. stdout includes `sonnet.jsonl` and `opus.jsonl`.
4. stdout excludes `haiku.jsonl`.

---

## Test 15: latest --filter picks newest matching session

**Steps:**
1. Seed three sessions with mtimes sonnet-old < sonnet-new < opus-newest (opus is globally newest).
2. Run `latest --filter "model:sonnet" --out /tmp/latest-expr-out.html`.

**Expectations:**
1. Exit code is `0`.
2. stdout contains `Latest: sonnet-new.jsonl`.
3. Rendered HTML contains session id for the newer sonnet, not the older sonnet or the newer opus.

---

## Execution Results

Manual execution from repo root on 2026-06-25. All tests use `TRACEQUEST_NO_SIDECAR=1` for discovery commands and temp fixtures under `/tmp/tracequest-integration-tests` / `/tmp/tracequest-integration-home-*`.

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | CLI help documents core commands | **PASS** | `node ./bin/tracequest.js --help` exit 0; stdout contains `tracequest`, `Commands:`, and all subcommands (iteration 1) |
| 2 | CLI version prints package.json semver | **PASS** | `--version` stdout `0.1.0` matches `package.json` version exactly |
| 3 | render produces self-contained HTML | **PASS** | `Written:` + HTML with `<html`, `SESSION =`, embedded CSS (iteration 1) |
| 4 | messages exports valid Anthropic-format JSON | **PASS** | stderr `Parsing session`; stdout JSON with `messages[0].role=user`, `messages[1].role=assistant`, typed content blocks |
| 5 | list discovers seeded sessions under HOME | **PASS** | `Found` + `integration-smoke` + `claude` label (iteration 1) |
| 6 | find filters sessions by model expression | **PASS** | `find "model:sonnet"` → `Found 1 sessions` with `integration-sonnet`; `integration-opus` excluded |
| 7 | search matches free-text in prompts | **PASS** | `search "integration-search-marker-xyz"` → `Found 1 result` referencing `integration-search` |
| 8 | latest renders the most recent matching session | **PASS** | `Latest: newer-session.jsonl`; HTML contains session id `int-latest-new` (not older) |
| 9 | serve starts HTTP server and serves browser | **PASS** | `GET /` and `GET /api/sessions` both HTTP 200 with sessions array (iteration 1) |
| 10 | presets lists built-in configurations | **PASS** | `Built-in presets` heading; `default` port 7777, `local` port 8888; `preset` alias identical |
| 11 | invalid inputs fail with clear CLI errors | **PASS** | `render` (no path), `not-a-command`, `serve --port 0` all exit 1 with `Error:` prefix; no `node:internal` stack traces |
| 12 | render missing file reports file-not-found | **PASS** | exit 1; stderr `Error: File not found`; stdout empty |
| 13 | find compound AND expression | **PASS** | `project:expr-compound-alpha AND model:sonnet` → 1 hit (`alpha-sonnet.jsonl`) |
| 13b | find positional and --filter expression | **PASS** | positional `project:expr-pos-filter-alpha` plus `--filter model:sonnet` → 1 hit (`alpha-sonnet.jsonl`) |
| 14 | find OR expression | **PASS** | `model:sonnet OR model:opus` → 2 hits; `haiku.jsonl` excluded |
| 15 | latest --filter picks newest match | **PASS** | `--filter model:sonnet` renders `sonnet-new.jsonl` despite newer opus |

**Summary:** 16/16 PASS. No bugs discovered; no code fixes required.
