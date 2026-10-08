# tracequest-sidecar Architecture

## Goal
Provide an optional high-performance Rust sidecar for TraceQuest's scanning and
indexing hot path. Node keeps the JS fallback path and owns search/query
behavior; the sidecar accelerates cold discovery and indexing with parallel I/O,
CPU-efficient parsing, and memory mapping for large files.

## JS Fallback Constraints
1. **Synchronous caller boundary** — `findSessions()` and `buildIndex()` are
   synchronous APIs; discovery uses `readdirSync`/`statSync`, so scans block the
   caller while the fallback path is active.
2. **Partial parallelism** — JS indexing can use worker threads for larger stale
   batches, but small batches run serially and worker startup/merge overhead
   remains in the Node process.
3. **JS parsing cost** — JSONL indexers stream files line-by-line and skip filler
   rows, but extraction still runs in JS with regex/string guards and
   `serde_json`-style work cannot happen off-process.
4. **Cache serialization** — `index.json` is metadata-only now, but it is still
   serialized and atomically written as one JSON document with a 2GB safety cap.
   Full-text term frequencies live separately in `search.idx`.
5. **SQLite fallback work** — OpenCode discovery uses grouped message counts and
   an mtime cache, but JS fallback indexing still calls OpenCode metadata
   extraction per stale virtual session.

## Sidecar Interface
The sidecar is a **CLI binary** invoked by the Node app via `child_process.spawnSync`. It communicates over stdin/stdout JSON.

### Commands

#### `scan`
```bash
tracequest-sidecar scan \
  --roots '["$HOME/.claude/projects","$HOME/.codex/sessions",...]' \
  --filter "tracequest"
```
**Output:** JSON array of `Session` objects (same shape as JS `findSessions`).

#### `index`
```bash
tracequest-sidecar index \
  --index-path "$HOME/.cache/tracequest/index.json" \
  --version 8 \
  --sessions-stdin < sessions.json
```
(`--sessions-json` remains for small lists; Node always uses `--sessions-stdin` to avoid ARG_MAX.)
```bash
# alternate (small lists only):
tracequest-sidecar index \
  --index-path "$HOME/.cache/tracequest/index.json" \
  --version 8 \
  --sessions-json '[{path:"...",mtime:...,source:"claude",size:123},...]'
```
**Output:** JSON object mapping `path → IndexEntry`. Every entry contains
metadata fields. Freshly parsed and search-stale entries also include transient
`termFreqs` for Node-side `SearchIndex` insertion; mtime-cache-reused entries may
omit `termFreqs`.

## Data Flow

```
Node (sessions.js)
  │ 1. Detect sidecar binary at sidecar/target/release/tracequest-sidecar
  │ 2. If present, serialize sessions/roots to JSON, spawn sidecar
  │ 3. Parse sidecar stdout JSON back into JS objects
  │ 4. If absent, fall back to existing JS implementation
  ▼
Rust sidecar
  │ scan: parallel directory walk (jwalk + rayon)
  │ index: parallel file parse (rayon + streaming serde_json)
  │        + memmap2 for files > 512KB
  │        + metadata cache reuse on mtime match unless search-stale
  ▼
Node strips transient termFreqs into SearchIndex/search.idx
~/.cache/tracequest/index.json remains metadata-only
```

## Source-Specific Parsing Strategy

| Source | File Layout | Rust Strategy |
|--------|------------|---------------|
| **claude** | `projects/<proj>/<file>.jsonl` | jwalk parallel walk → mmap large files → line-by-line `serde_json::Value` extraction |
| **codex** | `sessions/<nested>/<rollout-*>.jsonl` | Same as claude; decode `session_meta` cwd for project name |
| **cursor** | `projects/<proj>/<file>.jsonl` | Same Claude-family JSONL scan/index strategy with `source: "cursor"` |
| **factory** | `sessions/<workspace>/<file>.jsonl` | Same as claude; workspace name → project via regex replace |
| **grok** | `sessions/<workspace>/<session>/chat_history.jsonl` | Walk to `chat_history.jsonl` depth; parse `prompt_context.json` for model |
| **opencode** | SQLite `opencode.db` | Single `rusqlite` query for all sessions; batch message counts |

## Key Design Decisions
1. **CLI over IPC / long-lived process** — Simpler integration, no daemon lifecycle, matches JS sync-call pattern.
2. **Memory mapping for large files** — Avoids JS heap pressure; Rust can scan 100MB+ files without full allocation.
3. **Preserve the metadata index format** — `index.json` keeps the `_v` version field, same metadata field names, and same JSON path keys. Transient `termFreqs` exists only on sidecar stdout before Node moves it into `SearchIndex/search.idx`.
4. **Graceful fallback** — If Rust binary is missing or returns non-zero, Node falls back to JS implementation silently.
5. **Search remains Node-owned** — The sidecar replaces scan/index parsing work, while `searchSessions`, `peekSession`, and `parseSession` remain in JS. Node merges sidecar `termFreqs` through the same `SearchIndex` path used by JS indexers.

## Current Boundaries
- `index.json` is a metadata cache only; it never stores `termFreqs` or `searchText`.
- `search.idx` is owned by Node's `SearchIndex` writer.
- Missing binaries, non-zero exits, spawn failures, and invalid sidecar stdout fall back to JS indexing.
