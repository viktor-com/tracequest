# Sharing Integration Tests

Tests the share pipeline (CLI and browser UI) defined in `.facts` under the `# share` section. The feature is currently spec'd as `@draft`; these tests verify whether the implementation meets the spec.

## Integration test principles

1. **Real workflows** — invoke `bin/tracequest.js` end-to-end (parse → scan → redact → render → upload), not isolated unit mocks of internal helpers.
2. **Verifiable expectations** — each test states observable pass/fail criteria (exit codes, JSON fields, HTML script markers, mock-server request counts) before execution.
3. **Isolated fixtures** — synthetic sessions under temp dirs; `HOME` override for discovery tests; mock Gist/HF servers via `GITHUB_API_URL` / `HF_API_URL` so uploads never hit production APIs.
4. **Stdout/stderr contract** — `--json` stdout must be parseable JSON only; progress/diagnostics (parsing, scanning, index build) belong on stderr.

Automated harness: `test/bin/tracequest-sharing-integration.test.js` (19 scenarios). Run via `npm run test:integration` or `npm test`.

## Prerequisites

- Node.js and npm dependencies installed in the project root.
- A writable temporary directory for synthetic sessions: `/tmp/tracequest-share-tests`.
- The `tracequest` CLI is invoked via `node ./bin/tracequest.js` from the repo root.
- Tests 1, 2, 5, 6, 11, and 18 remain local or structural only: they verify CLI help/errors, rendered HTML structure, modal bundle markers, and scanner rules without starting upload mock servers.
- Tests 3, 4, 4b, 7, 8, 9, 10, 12, 13, 14, 15, 16, and 17 use local mock Gist/HF upload servers plus the `GITHUB_API_URL` / `HF_API_URL` overrides defined in `.facts`, so upload assertions never hit production APIs.

---

## Test 1: CLI share subcommand exists and is documented

**Steps:**
1. Run `node ./bin/tracequest.js share --help` from the repo root.

**Expectations:**
1. The process exits with code `0`.
2. stdout contains the word `share` in the command list.
3. stdout documents `--target gist|hf`.
4. stdout documents `--open`, `--json`, `--private`, `--force`, and `--hf-repo` flags.

---

## Test 2: CLI share rejects unknown options with the standard parser error

**Steps:**
1. Run `node ./bin/tracequest.js share /tmp/fake.jsonl --not-a-flag` from the repo root.

**Expectations:**
1. The process exits with code `1`.
2. stderr contains `Unknown option '--not-a-flag'` (node:util parseArgs format, including quotes).
3. stderr does not contain an uncaught stack trace.

---

## Test 3: CLI share accepts a session path and runs the local pipeline

**Steps:**
1. Create a synthetic Claude session at `/tmp/tracequest-share-tests/sess-with-secret.jsonl` with one user prompt containing a fake secret: `sk-fake1234567890abcdef`.
2. Start a local mock Gist server on an ephemeral port that returns `{ html_url, id }` for `POST /gists`.
3. Run `node ./bin/tracequest.js share /tmp/tracequest-share-tests/sess-with-secret.jsonl --target gist --json --force` with `GITHUB_TOKEN=fake` and `GITHUB_API_URL=http://127.0.0.1:<port>`.

**Note:** A fake token against the real GitHub API fails before JSON is emitted; the mock server is required to complete the upload step and verify JSON fields.

**Expectations:**
1. The process does not print `Unknown command: share`.
2. stderr/stdout contains evidence that the session was parsed and scanned (e.g., a mention of the scanner or of `[REDACTED]`).
3. The emitted JSON (`--json`) contains fields: `sessionId`, `source`, `model`, `project`, `firstPrompt`, `chapterCount`, `target`, `url`, `findings`, and `private`.
4. For `--target gist`, `url` is the gisthost preview URL (`https://gisthost.github.io/?{gistId}/...`), not the raw gist page.
5. For `--target gist`, `gistUrl` is the raw `gist.github.com` link (secondary); it is omitted for HF shares.

---

## Test 4: Share pipeline redacts secrets before reporting upload content

**Steps:**
1. Create a synthetic Claude session at `/tmp/tracequest-share-tests/sess-with-secret.jsonl` with user prompt text: `Here is the key: sk-fake1234567890abcdef and the endpoint`.
2. Render it to HTML with `node ./bin/tracequest.js render /tmp/tracequest-share-tests/sess-with-secret.jsonl --out /tmp/tracequest-share-tests/original.html`.
3. Run the share pipeline with a mock target and capture any intermediate HTML produced (or run `node ./bin/tracequest.js share ... --json` and inspect the `findings` array).
4. Verify the redacted copy does not contain the literal secret string.

**Expectations:**
1. The original rendered HTML contains the literal secret string `sk-fake1234567890abcdef`.
2. The share pipeline's output (findings or uploaded HTML) contains `[REDACTED]` in place of the secret.
3. The findings array includes an object with `ruleId`, `description`, `match` (redacted to first 4 + last 4 chars), and `location {chapterIndex, eventIndex, eventType}`.

---

## Test 4b: Tool input secrets are redacted in share upload payload

**Steps:**
1. Create a synthetic Claude session at `/tmp/tracequest-share-tests/sess-tool-secret.jsonl` whose assistant response contains a Bash `tool_use` command input with the fake secret `sk-fake1234567890abcdef`.
2. Start a local mock Gist server and run `node ./bin/tracequest.js share /tmp/tracequest-share-tests/sess-tool-secret.jsonl --target gist --json --force` with `GITHUB_TOKEN=fake` and `GITHUB_API_URL=http://127.0.0.1:<port>`.
3. Inspect the emitted JSON findings and the captured Gist upload payload.

**Expectations:**
1. The findings array contains at least one finding.
2. The uploaded HTML does not contain the literal secret string.
3. The uploaded HTML contains `[REDACTED]`.
4. Redaction applies even though the secret appears only in tool input, not ordinary user or assistant text.

---

## Test 5: Rendered HTML contains a Share button and modal UI

**Steps:**
1. Create a synthetic Claude session at `/tmp/tracequest-share-tests/sess-ui.jsonl`.
2. Render it to HTML with `node ./bin/tracequest.js render /tmp/tracequest-share-tests/sess-ui.jsonl --out /tmp/tracequest-share-tests/ui.html`.
3. Search the HTML `<script>` bundle for share-related DOM construction (not `<style>` rules).

**Expectations:**
1. The JS bundle creates a clickable element with class `hf-btn` inside `header-actions` (per `.facts`; not CSS-only).
2. The JS bundle creates a modal overlay element with class `hf-modal-overlay`.
3. The modal markup contains a target selector (e.g., radio buttons or buttons labeled `Gist` and `HF`).
4. The modal markup contains inputs for token and repo name (for HF) and a `private` toggle.
5. The modal markup contains `Share` and `Cancel` action elements with classes `hf-modal-share` and `hf-modal-cancel`.

**Anti-false-positive:** Grep matches inside `<style>` blocks do not satisfy this test.

---

## Test 6: Rendered HTML embeds the secret scanner rules and upload adapters

**Steps:**
1. Render a synthetic session to `/tmp/tracequest-share-tests/ui.html`.
2. Grep the `<script>` block for the embedded scanner rules and adapter code.

**Expectations:**
1. The HTML contains a `<script>` block or JSON blob with gitleaks-style rules (e.g., fields `id`, `description`, `regex`, `keywords`, `entropy`).
2. The HTML contains a function or code block named `shareGist` or equivalent that calls `fetch('https://api.github.com/gists', ...)`.
3. The HTML contains a function or code block named `shareHf` or equivalent that calls `fetch('https://huggingface.co/api/repos/create', ...)` or `https://huggingface.co/api/datasets/.../commit/...`.
4. The HTML contains a `scanSessionForSecrets` or equivalent function that consumes the embedded rules and the session data.

---

## Test 13: share --latest picks the most recent OpenCode session (OpenCode-only HOME)

**Steps:**
1. Seed two OpenCode sessions under an isolated `HOME` (no Claude JSONL) with distinct `time_updated` values.
2. Run `tracequest share --latest <project-filter> --target gist --json --force` against a mock Gist server.

**Expectations:**
1. Exit `0`; stdout is parseable JSON.
2. `sessionId` matches the session with the newer `time_updated`.
3. No `No sessions found` error.

---

## Test 7: CLI share --latest resolves the most recent session

**Steps:**
1. Create two synthetic Claude sessions under `$HOME/.claude/projects/-tmp-tracequest-share-tests-project-a/` with different mtimes (older and newer). Use a project folder name that `findSessions('project-a')` will match.
2. Run `node ./bin/tracequest.js share --latest project-a --target gist --json` with `GITHUB_TOKEN=fake`.

**Expectations:**
1. The process does not print `Unknown command: share`.
2. The JSON output's `sessionId` matches the newer session file.
3. The output references the `gist` target.

**Note:** `--latest` uses session discovery under agent data dirs (`~/.claude/projects`, etc.), not arbitrary `/tmp` paths. Alternatively, pass an explicit session path (Test 3) when discovery setup is impractical.

---

## Test 8: CLI share --expr filters sessions and picks the most recent match

**Steps:**
1. Create two synthetic Claude sessions under `$HOME/.claude/projects/-tmp-tracequest-share-tests-project-b/` with different first prompts and mtimes; ensure one session's first prompt contains the word `deploy`.
2. Run `node ./bin/tracequest.js share --expr "deploy" --target gist --json` with `GITHUB_TOKEN=fake`.

**Expectations:**
1. The process does not print `Unknown command: share`.
2. The JSON output's `firstPrompt` contains the word `deploy`.
3. The output references the `gist` target.

**Note:** `firstPrompt` is not a filter key (`FILTER_KEYS` in `src/filter/filter.js`). Use a free-text term like `deploy` or a supported key such as `project:` / `model:`.

---

## Test 9: Share creates new gist for re-shares (no dedup)

**Steps:**
1. Create a synthetic session at `/tmp/tracequest-share-tests/sess-reshare.jsonl`.
2. Mock the GitHub API response locally by running a tiny HTTP server on `127.0.0.1:19999` that returns a JSON response with `html_url` set to a test URL.
3. Set `GITHUB_API_URL=http://127.0.0.1:19999` and `GITHUB_TOKEN=fake` (per `.facts` gist adapter).
4. Share the same session twice: `node ./bin/tracequest.js share /tmp/tracequest-share-tests/sess-reshare.jsonl --target gist --json`.
5. Count POST requests received by the mock server.

**Expectations:**
1. The mock server receives exactly two POST requests to the gists endpoint.
2. Both invocations return a URL in the JSON output.
3. The two returned URLs differ (or the server logs show two distinct IDs).

---

## Test 10: HF adapter creates repo and writes files on first share

**Steps:**
1. Create a synthetic session at `/tmp/tracequest-share-tests/sess-hf.jsonl`.
2. Mock the HF Hub API locally on `127.0.0.1:19999` with endpoints for `/api/repos/create` and `/api/datasets/testuser/tracequest-sessions/commit/main`.
3. Set `HF_API_URL=http://127.0.0.1:19999` and `HF_TOKEN=fake` (per `.facts` HF adapter).
4. Run `node ./bin/tracequest.js share /tmp/tracequest-share-tests/sess-hf.jsonl --target hf --hf-repo testuser/tracequest-sessions --json`.

**Expectations:**
1. The mock server receives a `POST /api/repos/create` request with `type: "dataset"` if the repo does not exist.
2. The mock server receives a `POST /api/datasets/testuser/tracequest-sessions/commit/main` request containing two files: `sessions/claude/{sessionId}.html` and `sessions/claude/{sessionId}.json`.
3. The JSON sidecar file contains `sessionId`, `source`, `model`, `project`, `firstPrompt`, `eventCount`, `errorCount`, `tools`, `filePaths`, `gitBranch`, and cost estimate.
4. If the repo is newly created, the mock server receives a `README.md` dataset card with YAML frontmatter containing `license`, `tags`, and `task_categories`.

---

## Test 12: HF re-share to existing repo skips README.md

**Steps:**
1. Create two synthetic sessions at `/tmp/tracequest-share-tests/sess-hf-a.jsonl` and `sess-hf-b.jsonl`.
2. Mock the HF Hub API with stateful repo existence: first `GET /api/datasets/testuser/tracequest-sessions` returns 404; after first share returns 200.
3. Set `HF_API_URL` and `HF_TOKEN=fake`.
4. Share session A, then session B to the same `--hf-repo testuser/tracequest-sessions`.

**Expectations:**
1. First share triggers `POST /api/repos/create` and commit includes `README.md` plus `.html` and `.json` session files.
2. Second share does **not** call `/api/repos/create` again.
3. Second commit contains only the two session files — no `README.md` (per `.facts` line 51 / fact 8gh: subsequent uploads do not overwrite the dataset card).

---

## Test 11: Browser modal persists tokens in localStorage and shows status states

**Steps:**
1. Render a synthetic session to `/tmp/tracequest-share-tests/ui.html` and serve it with a static file server (or `python -m http.server`), **not** `tracequest serve --filter` (filter matches project names under `~/.claude/projects`, not `/tmp` paths).
2. Open the rendered session detail HTML in a headless browser environment.
3. Inspect the modal DOM and JS behavior.

**Expectations:**
1. Entering a token in the modal and clicking Save persists the token under `localStorage.tracequest-gh-token` (for Gist) or `localStorage.tracequest-hf-token` (for HF).
2. Clicking the Share button while the upload is in progress disables the button and shows a spinner/status area.
3. On a mocked success, a status element with class `hf-success` appears containing a clickable URL.
4. On a mocked error, a status element with class `hf-error` appears containing an error message.

**Note:** Full browser automation is in `test/browser/share-modal.playwright.test.js` (skips when Playwright chromium is not installed). The structural expectations (JS bundle references to localStorage keys and modal classes) remain verifiable by reading the emitted HTML/JS — not CSS rules alone.

---

## Test 14: PEM private key block redacted in share upload payload

**Steps:**
1. Create a synthetic session whose user prompt embeds a PEM `RSA PRIVATE KEY` block.
2. Share via mock Gist with `--force --json`.

**Expectations:**
1. Findings include `private-key-block`.
2. Upload HTML does not contain PEM header/footer or key material.
3. Upload HTML contains `[REDACTED]`.

---

## Test 15: AWS access key in env-var export tool input redacted before share

**Steps:**
1. Create a session with a Bash `tool_use` input: `export AWS_ACCESS_KEY_ID=AKIA...`.
2. Share via mock Gist with `--force --json`.

**Expectations:**
1. Findings include `aws-access-key`.
2. Upload payload does not contain the literal `AKIA` key.
3. Upload payload contains `[REDACTED]`.

---

## Test 16: Bearer/base64 token in curl tool input redacted before share

**Steps:**
1. Create a session with curl `Authorization: Bearer <base64-like token>` only in tool input.
2. Share via mock Gist with `--force --json`.

**Expectations:**
1. Findings include `bearer-token`.
2. Upload payload does not contain the base64 token substring.
3. Upload payload contains `[REDACTED]`.

---

## Test 18: All shipped secret rules compile and match representative secrets

**Steps:**
1. Load `data/secret-rules.json` via `loadSecretRules()`.
2. `compileRules(rules)` — assert count equals rule count (no silent drop).
3. For each rule id, scan a minimal session containing one representative secret sample.

**Expectations:**
1. All 10 shipped rules compile to RegExp objects.
2. Each rule id produces at least one finding for its representative sample (`openai-api-key`, `github-pat`, `github-fine-grained-pat`, `aws-access-key`, `generic-api-key`, `bearer-token`, `private-key-block`, `huggingface-token`, `slack-token`, `stripe-secret-key`).
3. `normalizeRuleRegex()` handles gitleaks PCRE inline flags (`(?i)`, `(?is)`, stacked groups).

---

## Test 17: Redaction preserves legitimate session content alongside secrets

**Steps:**
1. Create a session with benign discussion of “API key rotation policy” and OAuth2 in user/assistant text.
2. Place the only real secret (`ghp_…`) in a Bash tool export.
3. Share via mock Gist with `--force --json`.

**Expectations:**
1. Findings include `github-pat`; upload has `[REDACTED]` and no literal `ghp_` token.
2. Upload still contains legitimate phrases: “API key rotation policy”, “OAuth2 refresh tokens”, “Rotate keys quarterly per policy”.

---

## Execution Results

Manual execution from repo root on 2026-06-25. Tests use `TRACEQUEST_NO_SIDECAR=1`, temp fixtures under `/tmp/tracequest-share-tests`, mock HTTP servers for upload tests (3, 4, 4b, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17), and `HOME` override for discovery tests (7, 8, 13).

| Test | Description | Result | Evidence |
|------|-------------|--------|----------|
| 1 | share --help documents flags | **PASS** | exit 0; stdout contains `--target`, `--open`, `--json`, `--private`, `--force`, `--hf-repo` |
| 2 | share rejects unknown options | **PASS** | exit 1; stderr `Unknown option '--not-a-flag'`; no stack trace |
| 3 | share session path + JSON via mock gist | **PASS** | parse/scan on stderr; stdout JSON with `sessionId`, `gisthost` preview `url`, `gistUrl` |
| 4 | secrets redacted before upload | **PASS** | original HTML has literal secret; gist payload has `[REDACTED]`; findings shape valid |
| 4b | tool input secrets redacted before upload | **PASS** | gist payload has `[REDACTED]` and no literal secret when the secret appears only in Bash tool input |
| 5 | rendered HTML share modal UI | **PASS** | script bundle contains `hf-btn`, `hf-modal-overlay`, `hf-modal-share/cancel`, target selector, token input |
| 6 | embedded scanner rules + adapters | **PASS** | script bundle contains `SECRET_RULES`, `scanSessionForSecrets`, `shareGist`/`shareHf` fetch calls |
| 7 | share --latest picks newest session | **PASS** | after fix: index logs on stderr; stdout JSON `sessionId=share-latest-new` |
| 13 | share --latest OpenCode-only HOME | **PASS** | stdout JSON `sessionId` = newer OpenCode session |
| 8 | share --expr filters by free text | **PASS** | stdout JSON `firstPrompt` contains `deploy`; `target=gist` |
| 9 | re-share creates new gist (no dedup) | **PASS** | mock server received 2 POSTs; two distinct gisthost URLs |
| 10 | HF adapter creates repo + files | **PASS** | `POST /api/repos/create` type=dataset; commit has `.html`, `.json`, `README.md`; sidecar keys present |
| 12 | HF re-share skips README.md | **PASS** | first commit has README; second commit html+json only; single repo create |
| 11 | modal localStorage + status (structural) | **PASS** | JS references `tracequest-gh-token`, `tracequest-hf-token`, `hf-success`, `hf-error`, `shareBtn.disabled` |
| 11b | modal browser UX (Playwright) | **PASS** / skip | `test/browser/share-modal.playwright.test.js` — real DOM, localStorage, mocked gist success/error |
| 11c | HF adapter browser UX (Playwright) | **PASS** / skip | `test/browser/share-modal-hf.playwright.test.js` — HF target/repo UI, mocked HF API success/error |
| 14 | PEM private key redacted | **PASS** | gist upload has `[REDACTED]`; no PEM header/material |
| 15 | AWS env-var export redacted | **PASS** | `aws-access-key` finding; no literal AKIA key |
| 16 | Bearer/base64 curl token redacted | **PASS** | `bearer-token` finding; no base64 substring |
| 17 | Legitimate content preserved | **PASS** | policy/OAuth2 text intact; only `ghp_` redacted |
| 18 | All rules compile + match samples | **PASS** | 10/10 rules compile; each id matches representative secret |

**Summary:** 19/19 CLI/structural harness scenarios pass; optional Playwright browser coverage is tracked by `test:browser`. **Bug fixed:** index build status lines were written to stdout, breaking `share --json` with `--latest`/`--expr`; moved to stderr in `src/sessions/index-writers.js`. **Bug fixed:** gitleaks `(?i)` PCRE prefix broke `bearer-token` and `generic-api-key` rules in JavaScript — `normalizeRuleRegex()` in `src/share/scanner.js` (now handles `(?i)`, `(?m)`, `(?s)`, `(?u)` and stacked inline groups).
