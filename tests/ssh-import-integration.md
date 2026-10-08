# SSH Host Import Integration Tests

End-to-end integration for `tracequest import ssh` (facts in `ssh-import.facts`). The importer rsyncs the five filesystem session trees from each remote `$HOME` into `~/.local/share/tracequest/hosts/<host>/` (or `TRACEQUEST_HOSTS_DIR`). Copied files keep their original source; discovery stamps `host`.

Automated harness: `test/bin/tracequest-ssh-import-integration.test.js` (27 scenarios). Run via `npm run test:integration` or:

```bash
TRACEQUEST_SKIP_LR_WATCH=1 node --test --test-concurrency=1 test/bin/tracequest-ssh-import-integration.test.js
```

## Prerequisites

- Node.js (same major as CI) and `rsync` on PATH.
- **No real SSH**: `TRACEQUEST_IMPORT_SSH_FIXTURE` points at a local directory of per-host trees. A fake `TRACEQUEST_SSH_RSYNC` wrapper is used only for failure isolation tests.
- Isolation: temp `HOME` and `TRACEQUEST_HOSTS_DIR`.

---

## Test 1: import ssh with no hosts dies

**Steps:** `tracequest import ssh` with no positionals and no import-hosts file.

**Expectations:** exit 1; stderr names `import ssh <host>` and `import-hosts`.

## Test 2: import ssh reads hosts from the import-hosts file

**Steps:** Write `~/.tracequest/import-hosts` with `gpu`; fixture has a Claude tree for `gpu`; run `tracequest import ssh`.

**Expectations:** copies `gpu` without a positional host; dest jsonl exists.

## Test 3: import ssh rejects a non-integer --port

**Steps:** `tracequest import ssh gpu --port nope`.

**Expectations:** exit 1; stderr `Invalid --port`.

## Test 4: import ssh rejects an identity path with whitespace

**Steps:** `tracequest import ssh gpu -i "/tmp/my key"`.

**Expectations:** exit 1; stderr mentions whitespace.

## Test 5: dry-run prints planned actions and writes nothing under the hosts root

**Steps:** fixture with Claude on `gpu`; `tracequest import ssh gpu --dry-run`.

**Expectations:** plan + `dry-run summary:`; hosts root is not created.

## Test 6: prints a per-host plan before rsyncing that host

**Steps:** real import of `gpu`.

**Expectations:** `checked 5 sources on gpu` appears before the first per-source action line.

## Test 7: summary reports checked, fetched, imported, updated, skipped, and failed counts

**Steps:** import `gpu` with one present source.

**Expectations:** `import summary: 5 checked, … fetched, … imported, … updated, … skipped, … failed`.

## Test 8: skips a source tree that is absent on the remote

**Steps:** fixture with only Claude.

**Expectations:** skip lines for absent trees; skipped count > 0.

## Test 9: copies the five filesystem session trees and not opencode or cursor-cloud

**Steps:** fixture contains all five trees plus opencode.db and a cursor-cloud jsonl.

**Expectations:** five trees copied; opencode.db and cursor-cloud absent under dest.

## Test 10: re-run skips unchanged trees and preserves mtime

**Steps:** import twice with an unchanged fixture.

**Expectations:** second run `skip gpu claude (unchanged)`; dest mtime unchanged.

## Test 11: full recopies a remote tree whose size and mtime still match

**Steps:** import, wait, import `--full`.

**Expectations:** action is import/update (not skip-unchanged); dest mtime advances.

## Test 12: does not delete a local file that vanished from the fixture

**Steps:** import two files; delete one from the fixture; import again.

**Expectations:** the vanished file remains locally (no rsync `--delete`).

## Test 13: imported ssh sessions are indexed and searchable with original source and host

**Steps:** import a Claude session containing a unique needle; `tracequest search <needle> --json`.

**Expectations:** one hit, `source=claude`, `host=gpu`, path under the hosts root.

## Test 14: list --json includes host for imported sessions

**Steps:** import; `tracequest list --json --filter host:gpu`.

**Expectations:** records include `host: "gpu"` and `source: "claude"`.

## Test 15: counts a rsync failure under failed and continues

**Steps:** fake rsync exits 23 for `.factory/sessions`; other trees succeed.

**Expectations:** exit 1; factory counted failed; Claude still imported.

## Test 16: unreachable host fails that host and continues with the next

**Steps:** fake rsync exits 255 for `deadbox`; `gpu` succeeds; identity file contains a secret.

**Expectations:** exit 1; `gpu` imported; secret never appears in stdout/stderr.

---

## Test 17: imports two hosts in one run

**Steps:** fixture trees for `gpu` and `laptop`; `tracequest import ssh gpu laptop`.

**Expectations:** both dest trees exist; summary `10 checked`.

## Test 18: rejects an unsafe host id on the CLI

**Steps:** `tracequest import ssh cursor-cloud`.

**Expectations:** exit 1; no dest directory named `cursor-cloud`.

## Test 19: dry-run composes with --full

**Steps:** import once; `tracequest import ssh gpu --dry-run --full`.

**Expectations:** dry-run summary; not `skip ... (unchanged)`.

## Test 20: user@host lands under that host id

**Steps:** `tracequest import ssh user@work` from a fixture named `user@work`.

**Expectations:** dest `hosts/user@work/.claude/projects/...`.

## Test 21: list text shows source@host for imported sessions

**Steps:** import; `tracequest list --filter host:gpu`.

**Expectations:** stdout contains `claude@gpu`.

## Test 22: find --filter host:gpu selects imported sessions

**Steps:** import; `find --filter host:gpu --json` and `find --filter host:nope --json`.

**Expectations:** gpu records all have `host: gpu`; nope is empty.

## Test 23: render of an imported session

**Steps:** import; `tracequest render <imported.jsonl> --out imported.html`.

**Expectations:** HTML contains the session needle.

## Test 24: serve lists host:gpu and opens /view of an imported session

**Steps:** import; `tracequest serve`; `GET /api/sessions?expr=host:gpu`; `GET /view?path=...`.

**Expectations:** API row has `source=claude` and `host=gpu`; view HTML contains the needle.

---

## Execution results

| # | Scenario | Result |
|---|----------|--------|
| 1 | import ssh with no hosts dies | PASS |
| 2 | import ssh reads hosts from the import-hosts file | PASS |
| 3 | import ssh rejects a non-integer --port | PASS |
| 4 | import ssh rejects an identity path with whitespace | PASS |
| 5 | dry-run prints planned actions and writes nothing under the hosts root | PASS |
| 6 | prints a per-host plan before rsyncing that host | PASS |
| 7 | summary reports checked, fetched, imported, updated, skipped, and failed counts | PASS |
| 8 | skips a source tree that is absent on the remote | PASS |
| 9 | copies the five filesystem session trees and not opencode or cursor-cloud | PASS |
| 10 | re-run skips unchanged trees and preserves mtime | PASS |
| 11 | full recopies a remote tree whose size and mtime still match | PASS |
| 12 | does not delete a local file that vanished from the fixture | PASS |
| 13 | imported ssh sessions are indexed and searchable with original source and host | PASS |
| 14 | list --json includes host for imported sessions | PASS |
| 15 | counts a rsync failure under failed and continues | PASS |
| 16 | unreachable host fails that host and continues with the next | PASS |
| 17 | imports two hosts in one run | PASS |
| 18 | rejects an unsafe host id on the CLI | PASS |
| 19 | dry-run composes with --full | PASS |
| 20 | user@host lands under that host id | PASS |
| 21 | list text shows source@host for imported sessions | PASS |
| 22 | find --filter host:gpu selects imported sessions | PASS |
| 23 | render of an imported session | PASS |
| 24 | serve lists host:gpu and opens /view of an imported session | PASS |
| 25 | --as aliases the host id | PASS |
| 26 | import-hosts as alias | PASS |
| 27 | --as with multiple hosts dies | PASS |
