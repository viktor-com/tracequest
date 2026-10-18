//! Session indexing and index cache I/O.

use crate::token_accounting::{claude_usage_delta, BillingTokens, CostIndexEntry};

use crate::types::{parse_opencode_timestamp, IndexEntry, Session};
use memmap2;
use rayon::prelude::*;
use regex::Regex;
use rusqlite::Connection;
use serde_json;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

pub(crate) const INDEX_SEARCH_TEXT_MAX: usize = 500_000;

// ---------------------------------------------------------------------------
// BM25 tokenizer
// ---------------------------------------------------------------------------

/// Tokenize `input` into a term-frequency map using the shared BM25 tokenizer rules:
///
/// 1. Lowercase.
/// 2. Split on any non-alphanumeric character (including `/`, `_`, `.`, `-`, …).
/// 3. Additionally split on camelCase boundaries:
///    - Before an uppercase letter that follows a lowercase letter or digit:
///      `indexWriters` → ["index", "writers"]
///    - Before an uppercase letter that precedes a lowercase letter when the
///      previous character is also uppercase (last cap of an acronym run):
///      `HTTPServer` → ["http", "server"], `parseHTML` → ["parse", "html"]
/// 4. Discard tokens shorter than 2 or longer than 32 characters.
/// 5. Input is capped at 500,000 characters (fact 7et).
///
/// These rules are byte-for-byte equivalent to the JS tokenizer spec in
/// .facts search/tokenizer section.
pub fn tokenize(input: &str) -> HashMap<String, u32> {
    // Cap input at 500k chars (fact 7et).
    // The cap must be on char count to match the JS `slice(0, budgetBox[0])` which
    // operates on UTF-16 code units.
    //
    // Fast path: for ASCII-only content (the common case), char count == byte count,
    // so we can work directly on bytes and byte-slice the original &str for tokens,
    // avoiding the Vec<char> allocation that was the primary cost of the old path.
    //
    // We detect ASCII-only in a single pass; if non-ASCII is found, fall back to the
    // char-indexed path. For the fixture and parity tests, all content is ASCII.
    let input = if input.len() > INDEX_SEARCH_TEXT_MAX {
        // Byte-length guard: if the input's byte length exceeds the cap we must
        // find the correct char boundary. For ASCII content this is byte-exact.
        // For mixed content we walk chars; this path is rare.
        if input.is_ascii() {
            &input[..INDEX_SEARCH_TEXT_MAX]
        } else {
            let end = input
                .char_indices()
                .nth(INDEX_SEARCH_TEXT_MAX)
                .map(|(i, _)| i)
                .unwrap_or(input.len());
            &input[..end]
        }
    } else {
        input
    };

    // `freqs` counts raw term occurrences, matching JS accumulateTermFreqs semantics.
    // JS accumulateTermFreqs does NOT deduplicate — it increments the count each time
    // splitTokens emits a token, so a term appearing N times gets count N.
    // Rust must do the same: count every occurrence, no deduplication.
    //
    // Note on JS/Rust budget parity (fact 7et): JS accumulateTermFreqs applies the
    // 500k budget per-chunk across multiple calls (one call per content block), which
    // means a repeated term in different chunks both contribute to its raw count.
    // Rust sees the same content assembled into one string before the 500k cap, so
    // raw counts are identical as long as the total input fits within the cap.
    let mut freqs: HashMap<String, u32> = HashMap::new();

    if input.is_ascii() {
        // --- ASCII fast path: work on bytes, no Vec<char> allocation ---
        let bytes = input.as_bytes();
        let n = bytes.len();
        let mut token_start: Option<usize> = None;

        // Flush a token from `bytes[start..end]` (all ASCII alnum).
        // SAFETY: bytes[start..end] is valid UTF-8 (it's a sub-slice of an ASCII &str).
        let flush_ascii =
            |start: usize, end: usize, bytes: &[u8], freqs: &mut HashMap<String, u32>| {
                let len = end - start;
                if len < 2 || len > 32 {
                    return;
                }
                // Lowercase in-place to avoid a second allocation: copy to a stack-allocated
                // SmallVec would be ideal, but for correctness we use a heap String. The
                // to_ascii_lowercase call on a &str is a single allocation.
                // SAFETY: bytes[start..end] is valid UTF-8 (ASCII sub-slice).
                let s = unsafe { std::str::from_utf8_unchecked(&bytes[start..end]) }
                    .to_ascii_lowercase();
                *freqs.entry(s).or_insert(0) += 1;
            };

        let mut i = 0usize;
        while i < n {
            let c = bytes[i];
            let is_ascii_alnum = c.is_ascii_alphanumeric();
            if !is_ascii_alnum {
                if let Some(start) = token_start.take() {
                    flush_ascii(start, i, bytes, &mut freqs);
                }
                i += 1;
                continue;
            }
            let is_upper = c.is_ascii_uppercase();
            if let Some(start) = token_start {
                if is_upper {
                    let prev = bytes[i - 1];
                    if prev.is_ascii_alphanumeric() {
                        if prev.is_ascii_lowercase() || prev.is_ascii_digit() {
                            flush_ascii(start, i, bytes, &mut freqs);
                            token_start = Some(i);
                            i += 1;
                            continue;
                        }
                        let next_is_lower = i + 1 < n
                            && (bytes[i + 1].is_ascii_lowercase() || bytes[i + 1].is_ascii_digit());
                        if prev.is_ascii_uppercase() && next_is_lower && (i - start) > 0 {
                            flush_ascii(start, i, bytes, &mut freqs);
                            token_start = Some(i);
                            i += 1;
                            continue;
                        }
                    }
                }
            } else {
                token_start = Some(i);
            }
            i += 1;
        }
        if let Some(start) = token_start {
            flush_ascii(start, n, bytes, &mut freqs);
        }
    } else {
        // --- Non-ASCII fallback: collect to Vec<char> for correct indexing ---
        let chars_input: Vec<char> = input.chars().collect();
        let chars = &chars_input[..];
        let n = chars.len();

        let flush = |start: usize, end: usize, chars: &[char], freqs: &mut HashMap<String, u32>| {
            if end <= start {
                return;
            }
            let s: String = chars[start..end].iter().collect::<String>().to_lowercase();
            let len = s.chars().count();
            if len >= 2 && len <= 32 {
                *freqs.entry(s).or_insert(0) += 1;
            }
        };

        let mut token_start: Option<usize> = None;
        let mut i = 0usize;
        while i < n {
            let c = chars[i];
            let is_ascii_alnum = c.is_ascii_alphanumeric();
            if !is_ascii_alnum {
                if let Some(start) = token_start.take() {
                    flush(start, i, chars, &mut freqs);
                }
                i += 1;
                continue;
            }
            let is_upper = c.is_ascii_uppercase();
            let is_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
            if let Some(start) = token_start {
                let prev = chars[i - 1];
                let prev_is_ascii_alnum = prev.is_ascii_alphanumeric();
                if is_upper && prev_is_ascii_alnum {
                    let prev_is_lower_or_digit = prev.is_ascii_lowercase() || prev.is_ascii_digit();
                    if prev_is_lower_or_digit {
                        flush(start, i, chars, &mut freqs);
                        token_start = Some(i);
                        i += 1;
                        continue;
                    }
                    let next_is_lower = i + 1 < n
                        && (chars[i + 1].is_ascii_lowercase() || chars[i + 1].is_ascii_digit());
                    if prev.is_ascii_uppercase() && next_is_lower && (i - start) > 0 {
                        flush(start, i, chars, &mut freqs);
                        token_start = Some(i);
                        i += 1;
                        continue;
                    }
                }
            } else {
                token_start = Some(i);
            }
            let _ = is_lower;
            i += 1;
        }
        if let Some(start) = token_start {
            flush(start, n, chars, &mut freqs);
        }
    }

    freqs
}

/// Collapse whitespace runs to single spaces (parity with JS `.replace(/\s+/g, " ")` after newline fold).
/// Avoids `split_whitespace().collect::<Vec<_>>().join(" ")` alloc on hot index paths.
pub(crate) fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_ws = true;
    for c in s.chars() {
        if c.is_whitespace() {
            prev_ws = true;
        } else {
            if !out.is_empty() && prev_ws {
                out.push(' ');
            }
            out.push(c);
            prev_ws = false;
        }
    }
    out
}

/// Join Claude/Cursor-style content blocks (`type: "text"`) without `collect::<Vec<_>>().join(" ")`.
fn join_content_text_blocks(arr: &[serde_json::Value]) -> String {
    let mut out = String::new();
    let mut sep = false;
    for b in arr {
        if b.get("type").and_then(|v| v.as_str()) != Some("text") {
            continue;
        }
        if let Some(text) = b.get("text").and_then(|v| v.as_str()) {
            if sep {
                out.push(' ');
            }
            out.push_str(text);
            sep = true;
        }
    }
    out
}

/// Append a chunk to the tokenizer-input accumulator without Vec + join.
pub(crate) fn append_index_search_text(search_text: &mut String, chunk: &str) {
    if chunk.is_empty() || search_text.len() >= INDEX_SEARCH_TEXT_MAX {
        return;
    }
    let sep_len = usize::from(!search_text.is_empty());
    let room = INDEX_SEARCH_TEXT_MAX - search_text.len() - sep_len;
    if room == 0 {
        return;
    }
    if sep_len > 0 {
        search_text.push(' ');
    }
    // Fast path: if chunk fits within the remaining budget without truncation, push directly.
    // The room check uses byte length as a conservative lower bound; char count is <= byte count,
    // so if chunk.len() <= room, the entire chunk fits without hitting the char cap.
    if chunk.len() <= room {
        search_text.push_str(chunk);
    } else {
        // Slow path: need to truncate at the char boundary.
        search_text.push_str(&chunk.chars().take(room).collect::<String>());
    }
}

/// The opencode.db holding a session: `opencode://<id>` is a local session
/// ($HOME/.local/share/opencode/opencode.db, or TRACEQUEST_OPCODE_DB), and
/// `opencode://<host>/<id>` one imported from a hub host, read from that host's
/// copy under the hosts root (TRACEQUEST_HOSTS_DIR, else
/// $HOME/.local/share/tracequest/hosts) — the database parseOpenCode reads.
fn opencode_db_path(session_path: &str) -> PathBuf {
    let rest = session_path.strip_prefix("opencode://").unwrap_or(session_path);
    let home = std::env::var("HOME").unwrap_or_default();
    if let Some((host, _)) = rest.split_once('/') {
        let hosts_root = match std::env::var("TRACEQUEST_HOSTS_DIR") {
            Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
            _ => PathBuf::from(&home).join(".local/share/tracequest/hosts"),
        };
        return hosts_root.join(host).join(".local/share/opencode/opencode.db");
    }
    if let Ok(path) = std::env::var("TRACEQUEST_OPCODE_DB") {
        return PathBuf::from(path);
    }
    PathBuf::from(home).join(".local/share/opencode/opencode.db")
}

/// Read-only opencode.db connections one rayon worker reuses across the OpenCode
/// sessions of an index pass: thousands of sessions share a few databases, and
/// opening a multi-gigabyte WAL database per session costs more than reading it.
#[derive(Default)]
pub(crate) struct OpenCodeConns(HashMap<PathBuf, Option<Connection>>);

impl OpenCodeConns {
    fn get(&mut self, db_path: PathBuf) -> Option<&Connection> {
        self.0
            .entry(db_path)
            .or_insert_with_key(|p| {
                Connection::open_with_flags(p, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()
            })
            .as_ref()
    }
}

pub(crate) fn index_opencode(session: &Session) -> IndexEntry {
    index_opencode_in(&mut OpenCodeConns::default(), session)
}

pub(crate) fn index_opencode_in(conns: &mut OpenCodeConns, session: &Session) -> IndexEntry {
    let Some(conn) = conns.get(opencode_db_path(&session.path)) else {
        return empty_index_entry();
    };

    let session_id = &session.file;

    let mut first_prompt: Option<String> = None;
    let mut model: Option<String> = None;
    // Accumulate message text first; prepend title + single space at end (parity with JS indexOpenCode).
    let mut search_text = String::new();
    let mut chapters = 0i32;
    // The message of the previous row: its parts arrive together, so each
    // message's JSON is parsed once rather than once per part.
    let mut cur_msg_key: Option<String> = None;
    let mut cur_msg: Option<serde_json::Value> = None;
    let mut tools: HashSet<String> = HashSet::new();
    let mut tool_counts: HashMap<String, i32> = HashMap::new();
    let mut errors = 0i32;
    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut cache_read_tokens = 0i64;
    // Worked time over the messages in time order (fact durac).
    let mut span = ActiveSpan::default();
    let mut steps = OpenCodeSteps::default();

    {
        let mut stmt = match conn.prepare_cached(
            "SELECT m.data as msg_data, p.data as part_data, m.time_created, m.id \
             FROM message m \
             LEFT JOIN part p ON p.message_id = m.id \
             WHERE m.session_id = ? \
             ORDER BY m.time_created, m.id",
        ) {
            Ok(s) => s,
            Err(_) => return empty_index_entry(),
        };
        let rows = stmt.query_map([session_id], |row| {
            let msg_data: String = row.get(0)?;
            let part_data: Option<String> = row.get(1).ok();
            let time_created_val: rusqlite::types::Value =
                row.get(2).ok().unwrap_or(rusqlite::types::Value::Null);
            let time_created = match time_created_val {
                rusqlite::types::Value::Text(s) => Some(s),
                rusqlite::types::Value::Integer(i) => Some(i.to_string()),
                _ => None,
            };
            let msg_key = match row.get(3).ok().unwrap_or(rusqlite::types::Value::Null) {
                rusqlite::types::Value::Text(s) => s,
                rusqlite::types::Value::Integer(i) => i.to_string(),
                _ => msg_data.clone(),
            };
            Ok((msg_data, part_data, time_created, msg_key))
        });
        if let Ok(rows) = rows {
            for row in rows.flatten() {
                let (msg_data, part_data, time_created, msg_key) = row;
                if cur_msg_key.as_deref() != Some(msg_key.as_str()) {
                    cur_msg = serde_json::from_str::<serde_json::Value>(&msg_data).ok();
                    cur_msg_key = Some(msg_key);
                    if let Some(data) = cur_msg.as_ref() {
                        if model.is_none() {
                            if let Some(m) = data.get("modelID").and_then(|v| v.as_str()) {
                                model = Some(m.to_string());
                            }
                        }
                        if data.get("role").and_then(|v| v.as_str()) == Some("user") {
                            chapters += 1;
                        }
                    }
                }
                {
                    let role = cur_msg
                        .as_ref()
                        .and_then(|d| d.get("role"))
                        .and_then(|v| v.as_str());
                    let at = time_created
                        .as_deref()
                        .and_then(parse_opencode_timestamp)
                        .map(|d| d.timestamp_millis());
                    steps.add_row(&mut span, cur_msg_key.as_deref().unwrap_or(""), role, at);
                }
                if let Some(data) = cur_msg.as_ref() {
                    if let Some(pd) = part_data {
                        if let Ok(part) = serde_json::from_str::<serde_json::Value>(&pd) {
                            match part.get("type").and_then(|v| v.as_str()) {
                                Some("step-finish") => {
                                    if let Some(tokens) = part.get("tokens") {
                                        let in_tok = tokens
                                            .get("input")
                                            .and_then(|v| v.as_i64())
                                            .unwrap_or(0);
                                        let out_tok = tokens
                                            .get("output")
                                            .and_then(|v| v.as_i64())
                                            .unwrap_or(0);
                                        input_tokens += in_tok;
                                        output_tokens += out_tok;
                                        if let Some(cache) = tokens.get("cache") {
                                            let read = cache
                                                .get("read")
                                                .and_then(|v| v.as_i64())
                                                .unwrap_or(0);
                                            let write = cache
                                                .get("write")
                                                .and_then(|v| v.as_i64())
                                                .unwrap_or(0);
                                            cache_read_tokens += read;
                                            input_tokens += read + write;
                                        }
                                    }
                                }
                                Some("tool") => {
                                    steps.note_tool(
                                        part.get("tool").and_then(|v| v.as_str()).unwrap_or(""),
                                    );
                                    if let Some(name) = part.get("tool").and_then(|v| v.as_str()) {
                                        let tn = normalize_tool_name(name);
                                        tools.insert(tn.clone());
                                        *tool_counts.entry(tn).or_insert(0) += 1;
                                    }
                                    // Same rule as the detail view (parseOpenCode): a failed
                                    // call or an error-shaped output.
                                    let state = part.get("state");
                                    let status = state.and_then(|s| s.get("status"));
                                    let output = state
                                        .and_then(|s| s.get("output"))
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    if status.and_then(|v| v.as_str()) == Some("error")
                                        || OPENCODE_ERROR_OUTPUT_RE.is_match(output)
                                    {
                                        errors += 1;
                                    }
                                }
                                Some("text") | Some("reasoning") => {
                                    let part_type =
                                        part.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                    let t = part
                                        .get("text")
                                        .and_then(|v| v.as_str())
                                        .or_else(|| part.get("content").and_then(|v| v.as_str()))
                                        .unwrap_or("");
                                    if !t.is_empty() && !t.starts_with('<') {
                                        let clean = collapse_whitespace(t);
                                        if part_type == "text"
                                            && data.get("role").and_then(|v| v.as_str())
                                                == Some("user")
                                            && first_prompt.is_none()
                                        {
                                            first_prompt =
                                                Some(clean.chars().take(200).collect::<String>());
                                        }
                                        append_index_search_text(&mut search_text, &clean);
                                    }
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
        }
    }

    let duration_ms = span.active_ms();

    let mut tools_vec: Vec<String> = tools.into_iter().collect();
    tools_vec.sort_unstable();

    IndexEntry {
        first_prompt: first_prompt.or_else(|| session.title.clone()),
        model,
        term_freqs: Some(tokenize(&search_text)),
        tools: tools_vec,
        tool_counts,
        chapters,
        total_tokens: input_tokens + output_tokens,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        duration_ms,
        errors,
        files: 0,
        commits: 0,
        mtime: 0,
    }
}

fn empty_index_entry() -> IndexEntry {
    IndexEntry {
        first_prompt: None,
        model: None,
        term_freqs: Some(HashMap::new()),
        tools: Vec::new(),
        tool_counts: HashMap::new(),
        chapters: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        duration_ms: 0,
        errors: 0,
        files: 0,
        commits: 0,
        mtime: 0,
    }
}

// --- Index helpers ---

static NORMALIZED_TOOL_MAP: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    let mut m = HashMap::new();
    m.insert("bash", "Bash");
    m.insert("shell", "Bash");
    m.insert("exec_command", "Bash");
    m.insert("execute", "Bash");
    m.insert("run_command", "Bash");
    m.insert("run_terminal_command", "Bash");
    m.insert("read_file", "Read");
    m.insert("read", "Read");
    m.insert("write_file", "Write");
    m.insert("write", "Write");
    m.insert("create_file", "Write");
    m.insert("edit_file", "Edit");
    m.insert("edit", "Edit");
    m.insert("apply_patch", "Edit");
    m.insert("patch", "Edit");
    m.insert("search_replace", "Edit");
    m.insert("strreplace", "Edit");
    m.insert("askquestion", "Ask");
    m.insert("enter_plan_mode", "Plan");
    m.insert("exit_plan_mode", "Plan");
    m.insert("grep", "Grep");
    m.insert("ripgrep", "Grep");
    m.insert("glob", "Glob");
    m.insert("list_dir", "Glob");
    m.insert("ls", "Glob");
    m.insert("agent", "Agent");
    m.insert("task", "Agent");
    m.insert("taskcreate", "Agent");
    m.insert("taskupdate", "Agent");
    m.insert("dispatch_agent", "Agent");
    m.insert("spawn_subagent", "Agent");
    m.insert("wait_commands_or_subagents", "Agent");
    m.insert("get_command_or_subagent_output", "Agent");
    m.insert("kill_command_or_subagent", "Agent");
    m.insert("web_search", "WebSearch");
    m.insert("websearch", "WebSearch");
    m.insert("web_fetch", "WebFetch");
    m.insert("webfetch", "WebFetch");
    m.insert("browser_tab", "WebFetch");
    m.insert("todo_write", "TodoWrite");
    m.insert("todowrite", "TodoWrite");
    m.insert("write_stdin", "Bash");
    m.insert("memory_get", "Memory");
    m.insert("memory_search", "Memory");
    m.insert("ask_user_question", "Ask");
    m
});

pub(crate) fn normalize_tool_name(name: &str) -> String {
    if name.is_empty() {
        return "unknown".to_string();
    }
    if name.starts_with("mcp__") {
        return name.to_string();
    }
    let lower = name.to_lowercase();
    NORMALIZED_TOOL_MAP
        .get(lower.as_str())
        .copied()
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let mut chars = name.chars();
            match chars.next() {
                None => String::new(),
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            }
        })
}

pub(crate) fn extract_prompt(content: &serde_json::Value) -> Option<String> {
    let t = match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(arr) => join_content_text_blocks(arr),
        serde_json::Value::Object(obj) => obj
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        _ => return None,
    };

    let t = t.trim();
    if t.is_empty() {
        return None;
    }

    static USER_QUERY_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<user_query>\s*([\s\S]*?)\s*</user_query>").unwrap());
    static COMMAND_ARGS_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<command-args>([\s\S]*?)</command-args>").unwrap());
    static COMMAND_MESSAGE_RE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"<command-message>([\s\S]*?)</command-message>").unwrap());

    if let Some(caps) = USER_QUERY_RE.captures(t) {
        let inner = caps.get(1)?.as_str().trim();
        if let Some(args_caps) = COMMAND_ARGS_RE.captures(inner) {
            let clean = collapse_whitespace(args_caps.get(1)?.as_str().trim());
            return if clean.is_empty() { None } else { Some(clean) };
        }
        if let Some(msg_caps) = COMMAND_MESSAGE_RE.captures(inner) {
            let clean = collapse_whitespace(msg_caps.get(1)?.as_str().trim());
            return if clean.is_empty() { None } else { Some(clean) };
        }
        if inner.starts_with('<') {
            return None;
        }
        return Some(collapse_whitespace(inner));
    }

    if t.starts_with('<') {
        return None;
    }
    Some(collapse_whitespace(t))
}

#[allow(dead_code)] // used by unit tests; reserved for search-text heuristics
pub(crate) fn looks_like_code_or_path(s: &str) -> bool {
    if s.trim().starts_with('/') && s.trim().chars().filter(|&c| c == '/').count() >= 1 {
        // simple file path heuristic
        let trimmed = s.trim();
        if trimmed
            .chars()
            .all(|c| c == '/' || c == '.' || c == '_' || c == '-' || c.is_alphanumeric())
        {
            return true;
        }
    }
    if s.starts_with("http://") || s.starts_with("https://") {
        return true;
    }
    if HEX_HASH_RE.is_match(s) {
        return true;
    }
    if BASE64_BLOB_RE.is_match(s) {
        return true;
    }
    if (s.starts_with('{') && s.ends_with('}')) || (s.starts_with('[') && s.ends_with(']')) {
        return true;
    }
    let non_word = s
        .chars()
        .filter(|&c| !c.is_alphanumeric() && !c.is_whitespace())
        .count();
    if s.len() > 0 && non_word as f64 / s.len() as f64 > 0.7 {
        return true;
    }
    false
}

pub(crate) fn unescape_json_string(raw: &str) -> String {
    let wrapped = format!("\"{}\"", raw);
    serde_json::from_str::<String>(&wrapped).unwrap_or_else(|_| raw.to_string())
}

#[allow(dead_code)]
static HEX_HASH_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[0-9a-f]{32,}$").unwrap());
#[allow(dead_code)]
static BASE64_BLOB_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[A-Za-z0-9+/]{40,}={0,2}$").unwrap());

static GIT_COMMIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bgit\b.*\bcommit\b").unwrap());

static ERROR_PATTERN_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(Error:|exit code [1-9]|command failed|ENOENT|EACCES|SyntaxError|TypeError|ReferenceError)").unwrap()
});

/// ERROR_PATTERN_RE matching any line of a tool output, like the JS errorPattern
/// (`/im`) that parseOpenCode applies to an OpenCode tool part's output.
static OPENCODE_ERROR_OUTPUT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?imR)^(Error:|exit code [1-9]|command failed|ENOENT|EACCES|SyntaxError|TypeError|ReferenceError)").unwrap()
});

// Regex patterns used by claude/factory indexers
static TS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""timestamp":\s*"([^"]+)""#).unwrap());
static TOOL_USE_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""type":\s*"tool_use"[^}]*?"name":\s*"([^"]+)""#).unwrap());
static FILE_PATH_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""file_path":\s*"([^"]+)""#).unwrap());
static COMMAND_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""command":\s*"((?:[^"\\]|\\.)*)""#).unwrap());
pub(crate) static TEXT_BLOCK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""type":\s*"text",\s*"text":\s*"((?:[^"\\]|\\.)*)""#).unwrap());
static THINKING_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""type":\s*"thinking"[^}]*?"thinking":\s*"((?:[^"\\]|\\.)*)""#).unwrap()
});
/// Matches "text" JSON string fields with 30–500 raw chars (mirrors JS accumulateErrors regex
/// `/"text":\s*"((?:[^"\\]|\\.){30,500})"/g` used with extractToolResultChunks:true).
static TOOL_RESULT_TEXT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""text":\s*"((?:[^"\\]|\\.){30,500})""#).unwrap());
static INPUT_TOKENS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""input_tokens":\s*(\d+)"#).unwrap());
static OUTPUT_TOKENS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""output_tokens":\s*(\d+)"#).unwrap());
static CACHE_READ_TOKENS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""cache_read_input_tokens":\s*(\d+)"#).unwrap());
static CACHE_WRITE_TOKENS_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""cache_creation_input_tokens":\s*(\d+)"#).unwrap());
/// `message.model` on Claude assistant lines (model precedes nested content in serialized JSON).
pub(crate) static MESSAGE_MODEL_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""message"\s*:\s*\{[^}]*?"model"\s*:\s*"([^"]+)""#).unwrap());

/// Process a file line-by-line, using memmap2 for files > 512KB.
pub(crate) fn process_file_lines<F>(path: &Path, mut f: F) -> Result<(), std::io::Error>
where
    F: FnMut(&str),
{
    let metadata = fs::metadata(path)?;
    let size = metadata.len();

    if size > 512 * 1024 {
        let file = fs::File::open(path)?;
        let mmap = unsafe { memmap2::Mmap::map(&file)? };
        // Use `split` on the byte slice; the optimizer can vectorize this newline scan
        // much more effectively than the manual enumerate loop.
        for chunk in mmap.split(|&b| b == b'\n') {
            // Skip empty trailing chunk after final newline.
            if chunk.is_empty() {
                continue;
            }
            if let Ok(line) = std::str::from_utf8(chunk) {
                f(line);
            }
        }
    } else {
        let file = fs::File::open(path)?;
        let reader = std::io::BufReader::new(file);
        for line in reader.lines() {
            if let Ok(l) = line {
                f(&l);
            }
        }
    }
    Ok(())
}

/// Progress stream rows — no index state; safe to skip entirely in index_claude.
pub(crate) fn is_claude_progress_filler_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    line.starts_with("{\"type\":\"progress\"") || line.starts_with("{\"type\": \"progress\"")
}

/// Lines that can affect Claude JSONL parsing/indexing (skip parse on filler rows).
pub(crate) fn is_claude_indexed_jsonl_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    line.contains("\"type\":\"user\"")
        || line.contains("\"type\": \"user\"")
        || line.contains("\"type\":\"assistant\"")
        || line.contains("\"type\": \"assistant\"")
        || line.contains("\"sessionId\"")
        || line.contains("\"cwd\"")
        || line.contains("\"gitBranch\"")
}

/// Lines that can affect Cursor JSONL parsing/indexing.
pub(crate) fn is_cursor_indexed_jsonl_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    line.starts_with("{\"role\":\"user\"")
        || line.starts_with("{\"role\": \"user\"")
        || line.starts_with("{\"role\":\"assistant\"")
        || line.starts_with("{\"role\": \"assistant\"")
}

/// Cursor turn_ended rows with status "error" (counted toward session errors).
pub(crate) fn is_cursor_turn_ended_error_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    if !line.starts_with("{\"type\":\"turn_ended\"") && !line.starts_with("{\"type\": \"turn_ended\"")
    {
        return false;
    }
    line.contains("\"status\":\"error\"") || line.contains("\"status\": \"error\"")
}

/// Rows with no Cursor index contribution.
pub(crate) fn is_cursor_index_skippable_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    !is_cursor_indexed_jsonl_line(line)
}

/// Standalone tool_result rows with stderr (indexed via separate accumulator path).
pub(crate) fn is_claude_tool_result_stderr_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    if !line.contains("\"tool_result\"") {
        return false;
    }
    line.contains("\"stderr\"")
}

/// Rows with no index_claude contribution (progress, system, queue, content tool_result).
pub(crate) fn is_claude_index_skippable_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    if is_claude_progress_filler_line(line) {
        return true;
    }
    if is_claude_indexed_jsonl_line(line) {
        return false;
    }
    if line.contains("\"type\":\"tool_result\"") || line.contains("\"type\": \"tool_result\"") {
        return !is_claude_tool_result_stderr_line(line);
    }
    true
}

/// A gap this long with no event is a stall (agent waiting) or idle (human away).
const STALL_MS: i64 = 5 * 60 * 1000;
/// Longer than this is never one command running: the session was left and resumed.
const MAX_STALL_MS: i64 = 6 * 60 * 60 * 1000;
/// A model turn slower than this is a rate-limit pause or a suspended machine.
const MAX_MODEL_WAIT_MS: i64 = 30 * 60 * 1000;

/// Kind of a session's timestamped record (fact durac); Other is a line that is
/// no message (metadata, notices). Mirrors JS active-time.js.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum RecordKind {
    #[default]
    Other,
    User,
    Assistant,
    /// The result of a quick tool (a file read or edit, a question to the user).
    ToolResult,
    /// An OpenCode assistant step after a prompt or a step without tools: the
    /// gap before it is the model answering.
    ModelStep,
    /// The result of a long-running tool (is_long_running_tool): the gap
    /// before it is the agent's wait.
    ToolWait,
}

static SHELL_TOOL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:bash|shell|exec|exec_command|run_terminal_cmd|run_command|execute|local_shell|terminal|monitor)$").unwrap()
});
static LONG_RUNNING_TOOL_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:agent|task|subagent|spawn_agent|wait_agent|taskoutput|bashoutput|startmissionrun|skill|webfetch|web_fetch|websearch|web_search|wait|write_stdin)$").unwrap()
});

/// Tools whose call keeps the agent waiting for work that runs meanwhile
/// (commands, sub-agents, a mission's workers, fetches, MCP), matched on the
/// normalized name. Mirrors JS isLongRunningTool.
pub(crate) fn is_long_running_tool(normalized: &str) -> bool {
    SHELL_TOOL_RE.is_match(normalized)
        || LONG_RUNNING_TOOL_RE.is_match(normalized)
        || normalized.starts_with("mcp__")
}

/// A session's duration is the time it was worked on (fact durac), the one
/// computation behind insights agent time too: the gaps between consecutive
/// timestamped records add up, except that a gap longer than STALL_MS counts
/// only while the agent was the one waiting — up to MAX_STALL_MS when it ends
/// at a long-running tool's result, up to MAX_MODEL_WAIT_MS when it ends at an
/// assistant turn after a tool result (or at an OpenCode step answering a
/// prompt). The days between a session's resumes, and a question or
/// permission prompt left waiting, count nothing. Mirrors JS
/// createActiveSpan/addActiveRecord.
#[derive(Default)]
pub(crate) struct ActiveSpan {
    prev_ms: Option<i64>,
    prev_kind: RecordKind,
    active_ms: i64,
    /// Active time up to the last message record (None before one).
    at_message_ms: Option<i64>,
    last_ts: String,
    last_ts_ms: Option<i64>,
    /// Tool call id -> whether that tool keeps the agent waiting.
    waits: HashMap<String, bool>,
}

impl ActiveSpan {
    pub(crate) fn add(&mut self, ts: &str, kind: RecordKind) {
        // Consecutive records often share a timestamp: parse each string once.
        if ts != self.last_ts {
            self.last_ts.clear();
            self.last_ts.push_str(ts);
            self.last_ts_ms = chrono::DateTime::parse_from_rfc3339(ts)
                .ok()
                .map(|d| d.timestamp_millis());
        }
        if let Some(ms) = self.last_ts_ms {
            self.add_ms(ms, kind);
        }
    }

    pub(crate) fn add_ms(&mut self, ms: i64, kind: RecordKind) {
        match self.prev_ms {
            Some(prev) => {
                let gap = ms - prev;
                if gap > 0 && active_gap_counts(gap, kind, self.prev_kind) {
                    self.active_ms += gap;
                }
                // Out-of-order records: gaps run from the latest time seen.
                if ms > prev {
                    self.prev_ms = Some(ms);
                }
            }
            None => self.prev_ms = Some(ms),
        }
        if kind != RecordKind::Other {
            self.prev_kind = kind;
            self.at_message_ms = Some(self.active_ms);
        }
    }

    /// Record a tool call by id and raw name, so its result knows what it waited for.
    pub(crate) fn note_tool_call(&mut self, id: &str, name: &str) {
        if !id.is_empty() {
            self.waits.insert(
                id.to_string(),
                is_long_running_tool(&normalize_tool_name(name)),
            );
        }
    }

    /// ToolWait when the call `id` is a long-running tool, else ToolResult.
    pub(crate) fn result_kind_for_id(&self, id: &str) -> RecordKind {
        if self.waits.get(id).copied().unwrap_or(false) {
            RecordKind::ToolWait
        } else {
            RecordKind::ToolResult
        }
    }

    /// ToolWait when any call id `id_re` finds in a result line is a long-running tool.
    fn result_kind(&self, line: &str, id_re: &Regex) -> RecordKind {
        for caps in id_re.captures_iter(line) {
            if let Some(id) = caps.get(1) {
                if self.waits.get(id.as_str()).copied().unwrap_or(false) {
                    return RecordKind::ToolWait;
                }
            }
        }
        RecordKind::ToolResult
    }

    fn note_tool_use_blocks(&mut self, line: &str) {
        if !line.contains("\"tool_use\"") {
            return;
        }
        for caps in TOOL_USE_ID_NAME_RE.captures_iter(line) {
            if let (Some(id), Some(name)) = (caps.get(1), caps.get(2)) {
                self.note_tool_call(id.as_str(), name.as_str());
            }
        }
    }

    /// Worked time over every record.
    pub(crate) fn active_ms(&self) -> i64 {
        self.active_ms
    }

    /// Worked time up to the last message record, or over every record when
    /// there is none (fact durcl).
    pub(crate) fn active_ms_to_last_message(&self) -> i64 {
        self.at_message_ms.unwrap_or(self.active_ms)
    }
}

fn active_gap_counts(gap: i64, kind: RecordKind, prev_kind: RecordKind) -> bool {
    if gap <= STALL_MS {
        return true;
    }
    match kind {
        RecordKind::ToolWait => gap <= MAX_STALL_MS,
        RecordKind::ModelStep => gap <= MAX_MODEL_WAIT_MS,
        RecordKind::Assistant => {
            matches!(prev_kind, RecordKind::ToolResult | RecordKind::ToolWait)
                && gap <= MAX_MODEL_WAIT_MS
        }
        _ => false,
    }
}

/// A Claude Code / Factory tool_use block's id and name (written type, id, name).
static TOOL_USE_ID_NAME_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""type":\s*"tool_use",\s*"id":\s*"([^"]+)",\s*"name":\s*"([^"]+)""#).unwrap()
});
static TOOL_USE_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""tool_use_id":\s*"([^"]+)""#).unwrap());
static CODEX_CALL_ID_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""call_id":\s*"([^"]+)""#).unwrap());
static CODEX_CALL_NAME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#""name":\s*"([^"]+)""#).unwrap());

fn has_json_kv(line: &str, compact: &str, spaced: &str) -> bool {
    line.contains(compact) || line.contains(spaced)
}

/// Claude Code JSONL line kind (the substring tests index_claude routes lines
/// with); notes the tool calls an assistant line makes.
pub(crate) fn claude_record_kind(line: &str, span: &mut ActiveSpan) -> RecordKind {
    if has_json_kv(line, "\"type\":\"assistant\"", "\"type\": \"assistant\"") {
        span.note_tool_use_blocks(line);
        RecordKind::Assistant
    } else if has_json_kv(line, "\"type\":\"user\"", "\"type\": \"user\"") {
        if line.contains("\"tool_result\"") {
            span.result_kind(line, &TOOL_USE_ID_RE)
        } else {
            RecordKind::User
        }
    } else {
        RecordKind::Other
    }
}

/// Codex rollout line kind: response items are the conversation; event_msg,
/// turn_context and session_meta lines are not.
pub(crate) fn codex_record_kind(line: &str, span: &mut ActiveSpan) -> RecordKind {
    if !has_json_kv(
        line,
        "\"type\":\"response_item\"",
        "\"type\": \"response_item\"",
    ) {
        return RecordKind::Other;
    }
    if has_json_kv(
        line,
        "\"type\":\"function_call_output\"",
        "\"type\": \"function_call_output\"",
    ) || has_json_kv(
        line,
        "\"type\":\"custom_tool_call_output\"",
        "\"type\": \"custom_tool_call_output\"",
    ) {
        return span.result_kind(line, &CODEX_CALL_ID_RE);
    }
    if has_json_kv(line, "\"type\":\"function_call\"", "\"type\": \"function_call\"")
        || has_json_kv(
            line,
            "\"type\":\"custom_tool_call\"",
            "\"type\": \"custom_tool_call\"",
        )
    {
        let id = CODEX_CALL_ID_RE
            .captures(line)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str());
        let name = CODEX_CALL_NAME_RE
            .captures(line)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str());
        if let (Some(id), Some(name)) = (id, name) {
            span.note_tool_call(id, name);
        }
        return RecordKind::Assistant;
    }
    if has_json_kv(line, "\"role\":\"user\"", "\"role\": \"user\"") {
        return RecordKind::User;
    }
    if has_json_kv(line, "\"role\":\"developer\"", "\"role\": \"developer\"")
        || has_json_kv(line, "\"role\":\"system\"", "\"role\": \"system\"")
    {
        return RecordKind::Other;
    }
    RecordKind::Assistant
}

/// Factory JSONL line kind; notes the tool calls an assistant message makes.
pub(crate) fn factory_record_kind(line: &str, span: &mut ActiveSpan) -> RecordKind {
    if !has_json_kv(line, "\"type\":\"message\"", "\"type\": \"message\"") {
        return RecordKind::Other;
    }
    if has_json_kv(line, "\"role\":\"assistant\"", "\"role\": \"assistant\"") {
        span.note_tool_use_blocks(line);
        RecordKind::Assistant
    } else if has_json_kv(line, "\"role\":\"user\"", "\"role\": \"user\"") {
        if line.contains("\"tool_result\"") {
            span.result_kind(line, &TOOL_USE_ID_RE)
        } else {
            RecordKind::User
        }
    } else {
        RecordKind::Other
    }
}

/// OpenCode messages in time order (fact durac): an assistant message is one
/// agent step whose tools ran inside it, so the gap before step N+1 is step
/// N's work. It counts like the wait for step N's tool results (ToolWait when
/// one is long-running, ToolResult when all were quick, such as a question to
/// the user) or, after a prompt or a step without tools, like the model
/// answering (ModelStep). Mirrors JS createOpenCodeSteps/addOpenCodeRow.
#[derive(Default)]
pub(crate) struct OpenCodeSteps {
    id: Option<String>,
    role: Option<String>,
    tools: bool,
    wait: bool,
}

impl OpenCodeSteps {
    /// Add one message/part join row's message: a new message is a record.
    pub(crate) fn add_row(
        &mut self,
        span: &mut ActiveSpan,
        message_id: &str,
        role: Option<&str>,
        time_ms: Option<i64>,
    ) {
        if self.id.as_deref() != Some(message_id) {
            let prev_step = self.role.as_deref() == Some("assistant");
            let kind = if role != Some("assistant") {
                RecordKind::User
            } else if prev_step && self.wait {
                RecordKind::ToolWait
            } else if prev_step && self.tools {
                RecordKind::ToolResult
            } else {
                RecordKind::ModelStep
            };
            if let Some(ms) = time_ms {
                span.add_ms(ms, kind);
            }
            self.id = Some(message_id.to_string());
            self.role = role.map(|r| r.to_string());
            self.tools = false;
            self.wait = false;
        }
    }

    /// A tool part of the current message (`name` is "" when the part names none).
    pub(crate) fn note_tool(&mut self, name: &str) {
        self.tools = true;
        if is_long_running_tool(&normalize_tool_name(name)) {
            self.wait = true;
        }
    }
}

/// Grok events.jsonl event kind: a turn starts at a prompt, a tool completes
/// (naming its tool), the model's first token.
pub(crate) fn grok_event_kind(event_type: Option<&str>, tool_name: Option<&str>) -> RecordKind {
    match event_type {
        Some("turn_started") => RecordKind::User,
        Some("tool_completed") => {
            if is_long_running_tool(&normalize_tool_name(tool_name.unwrap_or(""))) {
                RecordKind::ToolWait
            } else {
                RecordKind::ToolResult
            }
        }
        Some("first_token") => RecordKind::Assistant,
        _ => RecordKind::Other,
    }
}

#[cfg(test)]
pub(crate) fn index_claude(path: &Path) -> IndexEntry {
    index_claude_with_cost(path).meta
}

fn index_claude_with_cost(path: &Path) -> CostIndexEntry {
    let mut usage_seen = HashMap::new();
    let mut billing_tokens = BillingTokens::default();
    let mut first_prompt: Option<String> = None;
    let mut model: Option<String> = None;
    let mut search_text = String::new();
    // Mirrors JS pushIndexSearchChunk _searchChunkSeen dedup (parity with accumulateErrors chunks).
    let mut seen_chunks: HashSet<String> = HashSet::new();
    let mut tools: HashSet<String> = HashSet::new();
    let mut tool_counts: HashMap<String, i32> = HashMap::new();
    let mut chapters = 0i32;
    let mut total_tokens = 0i64;
    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut cache_read_tokens = 0i64;
    let mut errors = 0i32;
    let mut files: HashSet<String> = HashSet::new();
    let mut commits = 0i32;
    // Worked time (fact durac); it ends at the last user/assistant line (fact
    // durcl): lines a lingering process writes after it (system notices, queue
    // operations) do not stretch the session.
    let mut span = ActiveSpan::default();

    let result = process_file_lines(path, |line| {
        if line.is_empty() || is_claude_index_skippable_line(line) {
            return;
        }
        // Fast timestamp extraction via regex
        if let Some(t) = TS_RE.captures(line).and_then(|caps| caps.get(1)) {
            let kind = claude_record_kind(line, &mut span);
            span.add(t.as_str(), kind);
        }
        // Tool_use extraction
        if line.contains("\"tool_use\"") {
            for caps in TOOL_USE_NAME_RE.captures_iter(line) {
                if let Some(name) = caps.get(1) {
                    let tn = normalize_tool_name(name.as_str());
                    tools.insert(tn.clone());
                    *tool_counts.entry(tn).or_insert(0) += 1;
                }
            }
            for caps in FILE_PATH_RE.captures_iter(line) {
                if let Some(fp) = caps.get(1) {
                    files.insert(fp.as_str().to_string());
                }
            }
            for caps in COMMAND_RE.captures_iter(line) {
                if let Some(cmd_raw) = caps.get(1) {
                    let cmd = unescape_json_string(cmd_raw.as_str());
                    if GIT_COMMIT_RE.is_match(&cmd) {
                        commits += 1;
                    }
                }
            }
        }
        // Error detection
        if line.contains("\"is_error\":true") || line.contains("\"is_error\": true") {
            errors += 1;
        } else if line.contains("\"tool_result\"") {
            // Check text content for error patterns via substring since regex over long lines is expensive
            if ERROR_PATTERN_RE.is_match(line) {
                errors += 1;
            }
        }

        let is_user = line.contains("\"type\":\"user\"") || line.contains("\"type\": \"user\"");
        let is_assistant =
            line.contains("\"type\":\"assistant\"") || line.contains("\"type\": \"assistant\"");
        if !is_user && !is_assistant {
            return;
        }

        if is_assistant {
            if model.is_none() && line.contains("\"model\"") {
                if let Some(caps) = MESSAGE_MODEL_RE.captures(line) {
                    if let Some(m) = caps.get(1) {
                        model = Some(m.as_str().to_string());
                    }
                }
            }
            // Count message usage once, while retaining all content fragments.
            if let Ok(record) = serde_json::from_str::<serde_json::Value>(line) {
                let t = claude_usage_delta(&record, &mut usage_seen);
                input_tokens += t[0] - t[2] - t[3];
                output_tokens += t[1];
                cache_read_tokens += t[2];
                total_tokens += t[0] + t[1];
                billing_tokens.add(&t, record["message"]["model"].as_str().unwrap_or(""));
            }
            // Text blocks
            for caps in TEXT_BLOCK_RE.captures_iter(line) {
                if let Some(text_raw) = caps.get(1) {
                    let text = unescape_json_string(text_raw.as_str());
                    if !text.is_empty() {
                        append_index_search_text(&mut search_text, &text);
                    }
                }
            }
            // Thinking blocks
            for caps in THINKING_RE.captures_iter(line) {
                if let Some(text_raw) = caps.get(1) {
                    let text = unescape_json_string(text_raw.as_str());
                    if !text.is_empty() {
                        append_index_search_text(&mut search_text, &text);
                    }
                }
            }
            return;
        }

        // User line: parse as JSON
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };
        if obj.get("type").and_then(|v| v.as_str()) != Some("user") {
            return;
        }
        if obj.get("isMeta").and_then(|v| v.as_bool()) == Some(true) {
            return;
        }
        chapters += 1;
        let content = obj.get("message").and_then(|m| m.get("content"));
        if let Some(clean) = content.and_then(extract_prompt) {
            if first_prompt.is_none() {
                first_prompt = Some(clean.chars().take(200).collect::<String>());
            }
            // Track in seen_chunks so the tool_result loop below won't double-add the same text
            // (mirrors JS pushIndexSearchChunk _searchChunkSeen dedup).
            seen_chunks.insert(clean.clone());
            append_index_search_text(&mut search_text, &clean);
        }

        // Extract tool_result text chunks from user lines (mirrors JS accumulateErrors with
        // extractToolResultChunks:true). User messages in Claude Code JSONL embed tool results
        // as content blocks: {"type":"user","message":{"content":[{"type":"tool_result",...}]}}.
        // The JS regex matches "text" fields of 30–500 raw chars and pushes each (deduped,
        // trimmed, max 500 chars) into the term-frequency accumulator.
        if line.contains("\"tool_result\"") {
            for caps in TOOL_RESULT_TEXT_RE.captures_iter(line) {
                if let Some(raw) = caps.get(1) {
                    let text = unescape_json_string(raw.as_str());
                    let trimmed = text.trim();
                    if trimmed.len() >= 30 {
                        let chunk: String = trimmed.chars().take(500).collect();
                        if seen_chunks.insert(chunk.clone()) {
                            append_index_search_text(&mut search_text, &chunk);
                        }
                    }
                }
            }
        }
    });

    if let Err(e) = result {
        eprintln!("Error reading {}: {}", path.display(), e);
    }

    let duration_ms = span.active_ms_to_last_message();

    let mut tools_vec: Vec<String> = tools.into_iter().collect();
    tools_vec.sort_unstable();

    CostIndexEntry {
        meta: IndexEntry {
            first_prompt,
            model,
            term_freqs: Some(tokenize(&search_text)),
            tools: tools_vec,
            tool_counts,
            chapters,
            total_tokens,
            input_tokens,
            output_tokens,
            cache_read_tokens,
            duration_ms,
            errors,
            files: files.len() as i32,
            commits,
            mtime: 0,
        },
        billing_tokens: Some(billing_tokens),
    }
}

/// Cursor tools whose `path` input names a touched file (Cursor uses `path`, not `file_path`).
const CURSOR_PATH_TOOLS: [&str; 4] = ["Read", "Write", "StrReplace", "Delete"];

/// Cursor transcripts carry no event timestamps; derive durationMs from file
/// birthtime (created) → mtime (modified). Per-value ms truncation mirrors the
/// JS cursorFileTimeBounds (BigInt ns / 1e6) so index entries agree exactly.
/// created() missing/unsupported or later than modified clamps to 0.
pub(crate) fn cursor_file_duration_ms(path: &Path) -> i64 {
    let epoch_ms = |t: std::time::SystemTime| -> Option<i64> {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as i64)
    };
    std::fs::metadata(path)
        .ok()
        .and_then(|md| {
            let m_ms = md.modified().ok().and_then(epoch_ms)?;
            let c_ms = md.created().ok().and_then(epoch_ms)?;
            if c_ms > 0 && c_ms <= m_ms {
                Some(m_ms - c_ms)
            } else {
                Some(0)
            }
        })
        .unwrap_or(0)
}

// Cursor transcript rows carry no model field; the model name lives in Cursor's
// global state DB under `composerData:<uuid>` → modelConfig.modelName. This must
// stay byte-for-byte in agreement with src/sessions/cursor-state-db.js, or a
// session's model would change depending on whether JS or the sidecar indexed it.
static CURSOR_STATE_DB_PATH: LazyLock<Option<PathBuf>> = LazyLock::new(|| {
    if let Ok(p) = std::env::var("TRACEQUEST_CURSOR_STATE_DB") {
        if !p.is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    if cfg!(target_os = "windows") {
        let appdata = std::env::var("APPDATA").ok()?;
        return Some(Path::new(&appdata).join("Cursor/User/globalStorage/state.vscdb"));
    }
    let home = std::env::var("HOME").ok()?;
    let rel = if cfg!(target_os = "macos") {
        "Library/Application Support/Cursor/User/globalStorage/state.vscdb"
    } else {
        ".config/Cursor/User/globalStorage/state.vscdb"
    };
    Some(Path::new(&home).join(rel))
});

pub(crate) fn cursor_model_from_state_db(path: &Path) -> Option<String> {
    let composer_id = path.file_stem()?.to_str()?;
    cursor_model_from_db_at(CURSOR_STATE_DB_PATH.as_ref()?, composer_id)
}

pub(crate) fn cursor_model_from_db_at(db_path: &Path, composer_id: &str) -> Option<String> {
    let conn = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let raw: rusqlite::types::Value = conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            [format!("composerData:{composer_id}")],
            |row| row.get(0),
        )
        .ok()?;
    let text = match raw {
        rusqlite::types::Value::Text(s) => s,
        rusqlite::types::Value::Blob(b) => String::from_utf8(b).ok()?,
        _ => return None,
    };
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    let name = parsed.get("modelConfig")?.get("modelName")?.as_str()?;
    if name.is_empty() {
        return None;
    }
    Some(name.to_string())
}

/// Shared accumulator for Cursor-style message rows
/// (`{"role":"user"|"assistant","message":{"content":[...]}}`).
///
/// Both `index_cursor` (local transcripts) and `index_cursor_cloud` (imported
/// cloud-agent transcripts) drive their message-row indexing and cursor-style
/// char-count token estimation through this one type, so the two cannot drift
/// (facts sd3, ccrx).
#[derive(Default)]
struct CursorRowAccumulator {
    first_prompt: Option<String>,
    search_text: String,
    seen_chunks: HashSet<String>,
    tools: HashSet<String>,
    tool_counts: HashMap<String, i32>,
    chapters: i32,
    input_chars: usize,
    output_chars: usize,
    errors: i32,
    files: HashSet<String>,
    commits: i32,
}

impl CursorRowAccumulator {
    fn process_line(&mut self, line: &str) {
        if line.is_empty() {
            return;
        }
        if is_cursor_turn_ended_error_line(line) {
            self.errors += 1;
            return;
        }
        if is_cursor_index_skippable_line(line) {
            return;
        }
        // Tool_use extraction (same inner content format as Claude)
        if line.contains("\"tool_use\"") {
            for caps in TOOL_USE_NAME_RE.captures_iter(line) {
                if let Some(name) = caps.get(1) {
                    let tn = normalize_tool_name(name.as_str());
                    self.tools.insert(tn.clone());
                    *self.tool_counts.entry(tn).or_insert(0) += 1;
                }
            }
            for caps in COMMAND_RE.captures_iter(line) {
                if let Some(cmd_raw) = caps.get(1) {
                    let cmd = unescape_json_string(cmd_raw.as_str());
                    if GIT_COMMIT_RE.is_match(&cmd) {
                        self.commits += 1;
                    }
                }
            }
        }

        let is_user =
            line.starts_with("{\"role\":\"user\"") || line.starts_with("{\"role\": \"user\"");
        let is_assistant = line.starts_with("{\"role\":\"assistant\"")
            || line.starts_with("{\"role\": \"assistant\"");
        if !is_user && !is_assistant {
            return;
        }

        if is_assistant {
            // Text blocks (search text + output char estimation)
            for caps in TEXT_BLOCK_RE.captures_iter(line) {
                if let Some(text_raw) = caps.get(1) {
                    let text = unescape_json_string(text_raw.as_str());
                    if !text.is_empty() {
                        append_index_search_text(&mut self.search_text, &text);
                        self.output_chars += text.len();
                    }
                }
            }
            // Tool_use blocks: output char estimation + touched files via Cursor's `path` input
            if line.contains("\"tool_use\"") {
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(line) {
                    let content = obj.get("message").and_then(|m| m.get("content"));
                    if let Some(arr) = content.and_then(|v| v.as_array()) {
                        for b in arr {
                            if b.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
                                continue;
                            }
                            let name = b.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            self.output_chars += name.len() + 20;
                            if CURSOR_PATH_TOOLS.contains(&name) {
                                if let Some(p) = b
                                    .get("input")
                                    .and_then(|i| i.get("path"))
                                    .and_then(|v| v.as_str())
                                {
                                    if !p.is_empty() {
                                        self.files.insert(p.to_string());
                                    }
                                }
                            }
                        }
                    }
                }
            }
            return;
        }

        // User line: parse as JSON for prompt extraction
        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };
        if obj.get("role").and_then(|v| v.as_str()) != Some("user") {
            return;
        }
        self.chapters += 1;
        let content = obj.get("message").and_then(|m| m.get("content"));
        if let Some(clean) = content.and_then(extract_prompt) {
            if self.first_prompt.is_none() {
                self.first_prompt = Some(clean.chars().take(200).collect::<String>());
            }
            self.seen_chunks.insert(clean.clone());
            append_index_search_text(&mut self.search_text, &clean);
            self.input_chars += clean.len();
        }
    }

    /// Finish into an IndexEntry with the given model and durationMs.
    /// Cursor JSONL carries no usage fields; estimate tokens from chars like factory/grok.
    fn into_entry(self, model: String, duration_ms: i64) -> IndexEntry {
        let input_tokens = estimate_tokens_from_chars(self.input_chars);
        let output_tokens = estimate_tokens_from_chars(self.output_chars);

        let mut tools_vec: Vec<String> = self.tools.into_iter().collect();
        tools_vec.sort_unstable();

        IndexEntry {
            first_prompt: self.first_prompt,
            model: Some(model),
            term_freqs: Some(tokenize(&self.search_text)),
            tools: tools_vec,
            tool_counts: self.tool_counts,
            chapters: self.chapters,
            total_tokens: input_tokens + output_tokens,
            input_tokens,
            output_tokens,
            cache_read_tokens: 0,
            duration_ms,
            errors: self.errors,
            files: self.files.len() as i32,
            commits: self.commits,
            mtime: 0,
        }
    }
}

pub(crate) fn index_cursor(path: &Path) -> IndexEntry {
    let mut acc = CursorRowAccumulator::default();
    let result = process_file_lines(path, |line| acc.process_line(line));
    if let Err(e) = result {
        eprintln!("Error reading {}: {}", path.display(), e);
    }
    let model = cursor_model_from_state_db(path).unwrap_or_else(|| "cursor".to_string());
    acc.into_entry(model, cursor_file_duration_ms(path))
}

/// session_meta first line of an imported cursor-cloud transcript (fact ccml).
pub(crate) struct CursorCloudMeta {
    pub model: Option<String>,
    pub name: Option<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

/// Parse a line as a cursor-cloud `{"type":"session_meta",...}` row; None when
/// the line is not valid JSON or not a session_meta row.
fn parse_cursor_cloud_meta(line: &str) -> Option<CursorCloudMeta> {
    let obj: serde_json::Value = serde_json::from_str(line).ok()?;
    if obj.get("type").and_then(|v| v.as_str()) != Some("session_meta") {
        return None;
    }
    let field = |key: &str| {
        obj.get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    Some(CursorCloudMeta {
        model: field("model"),
        name: field("name"),
        created_at: field("createdAt"),
        updated_at: field("updatedAt"),
    })
}

/// durationMs = max(0, updatedAt − createdAt) from the meta's ISO-8601 strings;
/// 0 when updatedAt is absent or either timestamp fails to parse (facts ccix/ccrx).
fn cursor_cloud_duration_ms(meta: &CursorCloudMeta) -> i64 {
    let parse_ms = |s: &str| {
        chrono::DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|d| d.timestamp_millis())
    };
    match (
        meta.created_at.as_deref().and_then(parse_ms),
        meta.updated_at.as_deref().and_then(parse_ms),
    ) {
        (Some(created_ms), Some(updated_ms)) => (updated_ms - created_ms).max(0),
        _ => 0,
    }
}

/// Index an imported cursor-cloud transcript (fact ccrx).
///
/// Message rows reuse Cursor's Claude-family row indexing and token estimation
/// unchanged (via `CursorRowAccumulator`), with the session_meta deltas:
/// - line 1 `{"type":"session_meta",...}` is consumed, never indexed;
/// - model = session_meta.model, else the literal "cursor-cloud" (fact ccmf);
/// - durationMs = max(0, updatedAt − createdAt) from the meta's ISO-8601 strings
///   (0 when updatedAt is absent) instead of file birthtime/mtime;
/// - firstPrompt falls back to session_meta.name when the transcript yields no
///   user prompt.
///
/// A file whose first line is NOT session_meta degrades to the local-cursor
/// behavior: state-db model with "cursor" fallback, file-time durationMs (ccpp).
pub(crate) fn index_cursor_cloud(path: &Path) -> IndexEntry {
    let mut acc = CursorRowAccumulator::default();
    let mut meta: Option<CursorCloudMeta> = None;
    let mut first_line = true;
    let result = process_file_lines(path, |line| {
        if std::mem::take(&mut first_line) {
            meta = parse_cursor_cloud_meta(line);
            if meta.is_some() {
                return; // consumed, not indexed
            }
        }
        acc.process_line(line);
    });
    if let Err(e) = result {
        eprintln!("Error reading {}: {}", path.display(), e);
    }

    let Some(meta) = meta else {
        // No session_meta first line: degrade to the local-cursor behavior (ccpp).
        let model = cursor_model_from_state_db(path).unwrap_or_else(|| "cursor".to_string());
        return acc.into_entry(model, cursor_file_duration_ms(path));
    };

    let duration_ms = cursor_cloud_duration_ms(&meta);
    let model = meta
        .model
        .clone()
        .unwrap_or_else(|| "cursor-cloud".to_string());
    let mut entry = acc.into_entry(model, duration_ms);
    if entry.first_prompt.is_none() {
        entry.first_prompt = meta.name;
    }
    entry
}

/// stream_chunk filler dominates rollout volume; skip before timestamp regex / indexed gate.
pub(crate) fn is_codex_index_skippable_line(line: &str) -> bool {
    line.contains("\"type\":\"stream_chunk\"") || line.contains("\"type\": \"stream_chunk\"")
}

/// Fast pre-parse guard; mirrors Node isCodexIndexedJsonlLine.
pub(crate) fn is_codex_indexed_line(line: &str) -> bool {
    line.contains("\"session_meta\"")
        || line.contains("\"turn_context\"")
        || line.contains("\"response_item\"")
        || line.contains("\"event_msg\"")
}

/// Mirror of Node isCodexDisplayableUserText: user text is displayable when
/// non-empty, not an XML-wrapped hidden block, and not the codex AGENTS.md
/// instructions injection ("# AGENTS.md instructions[ for <path>]" — the one
/// machine-injected user block that is markdown, not XML; taking it as the
/// first prompt titled every real codex session with the injection and broke
/// run attribution's prompt corroboration).
fn is_codex_displayable_user_text(text: &str) -> bool {
    !text.is_empty() && !text.starts_with('<') && !text.starts_with("# AGENTS.md instructions")
}

// Codex status and output interpretation mirrors codex-response-item.js.
fn codex_status_error(value: &serde_json::Value) -> bool {
    let code = value.get("exit_code").and_then(|v| {
        v.as_i64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
    });
    code.is_some_and(|n| n != 0)
        || value.get("is_error").and_then(|v| v.as_bool()) == Some(true)
        || value.get("isError").and_then(|v| v.as_bool()) == Some(true)
        || value.get("success").and_then(|v| v.as_bool()) == Some(false)
        || value
            .get("error")
            .is_some_and(|v| !v.is_null() && v != false && v != "")
}

fn codex_status_success(value: &serde_json::Value) -> bool {
    value.get("exit_code").is_some_and(|v| v == 0 || v == "0")
        || value.get("success").and_then(|v| v.as_bool()) == Some(true)
}

static CODEX_EXIT_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)^(?:Chunk ID:[^\n]*\n)?(?:Wall time:[^\n]*\n)?Process exited with code (-?\d+)\b",
    )
    .unwrap()
});

static CODEX_FAILURE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^(?:Script failed\b|apply_patch verification failed:|Failed to (?:find expected lines|apply patch)|(?:command|execution|tool|js execution) timed out\b|Error (?:parsing function call|executing tool)\b)").unwrap()
});

fn codex_output_error(value: &serde_json::Value) -> bool {
    if let Some(items) = value.as_array() {
        return items.iter().any(codex_output_error);
    }
    if value.is_object() {
        if codex_status_error(value) {
            return true;
        }
        if codex_status_success(value) {
            return false;
        }
        if value.get("output").is_some_and(codex_output_error) {
            return true;
        }
    }
    let text = value
        .as_str()
        .or_else(|| match value.get("type").and_then(|v| v.as_str()) {
            Some("text" | "input_text" | "output_text") => {
                value.get("text").and_then(|v| v.as_str())
            }
            _ => None,
        })
        .unwrap_or("");
    if let Some(captures) = CODEX_EXIT_RE.captures(text) {
        return captures[1].parse::<i64>().is_ok_and(|code| code != 0);
    }
    if CODEX_FAILURE_RE.is_match(text) {
        return true;
    }
    if text.trim_start().starts_with('{') {
        if let Ok(result) = serde_json::from_str::<serde_json::Value>(text) {
            return codex_status_error(&result);
        }
    }
    text.lines().any(|line| {
        line.trim_start().starts_with('{')
            && serde_json::from_str::<serde_json::Value>(line)
                .ok()
                .is_some_and(|v| {
                    v.get("chunk_id").is_some_and(|v| v.is_string())
                        && v.get("wall_time_seconds").is_some_and(|v| v.is_number())
                        && v.get("output").is_some_and(|v| v.is_string())
                        && codex_status_error(&v)
                })
    })
}

fn codex_payload_error(payload: &serde_json::Value) -> bool {
    if codex_status_error(payload) {
        return true;
    }
    if codex_status_success(payload) {
        return false;
    }
    ["output", "aggregated_output", "stdout", "stderr"]
        .iter()
        .any(|key| payload.get(key).is_some_and(codex_output_error))
}

/// Raw codex index: `model` keeps its original session_meta-first precedence
/// (model_provider, else the first turn_context model). Session indexing goes
/// through `index_codex_session`, which reports the model id (fact cdxmodel);
/// only the unit tests read the raw form.
#[cfg(test)]
pub(crate) fn index_codex(path: &Path) -> IndexEntry {
    index_codex_with_named_model(path).0
}

/// Codex index as build_index stores it: the model is the first turn_context
/// model id (e.g. gpt-5-codex), else the thread_settings_applied model, else the
/// session_meta base_instructions provenance model; session_meta model_provider
/// ("openai") only names the vendor and stays the fallback (facts cdxmodel,
/// cdxprov, mirrors Node indexCodexJsonl).
pub(crate) fn index_codex_session(path: &Path) -> IndexEntry {
    let (mut entry, named_model, _) = index_codex_with_named_model(path);
    if named_model.is_some() {
        entry.model = named_model;
    }
    entry
}

fn non_empty_str(v: Option<&serde_json::Value>) -> Option<String> {
    v.and_then(|m| m.as_str())
        .filter(|m| !m.is_empty())
        .map(|m| m.to_string())
}

/// Model id a session_meta payload names in base_instructions.provenance (fact cdxprov).
fn codex_provenance_model(meta_payload: &serde_json::Value) -> Option<String> {
    non_empty_str(
        meta_payload
            .get("base_instructions")
            .and_then(|b| b.get("provenance"))
            .and_then(|p| p.get("model")),
    )
}

/// Model id an event_msg thread_settings_applied payload names (fact cdxprov).
fn codex_thread_settings_model(event_payload: &serde_json::Value) -> Option<String> {
    if event_payload.get("type").and_then(|t| t.as_str()) != Some("thread_settings_applied") {
        return None;
    }
    non_empty_str(
        event_payload
            .get("thread_settings")
            .and_then(|t| t.get("model")),
    )
}

/// The item of an event_msg item_completed payload from another thread than
/// the session's (a review sub-thread, fact cdxsub); None for the session's own
/// thread, whose items mirror its response_items. Mirrors Node codexSubThreadItem.
fn codex_sub_thread_item<'a>(
    event_payload: &'a serde_json::Value,
    session_id: Option<&str>,
) -> Option<&'a serde_json::Value> {
    if event_payload.get("type").and_then(|t| t.as_str()) != Some("item_completed") {
        return None;
    }
    let thread_id = event_payload.get("thread_id").and_then(|t| t.as_str())?;
    let session_id = session_id?;
    if thread_id.is_empty() || thread_id == session_id {
        return None;
    }
    event_payload.get("item").filter(|i| i.is_object())
}

/// Text blocks of a sub-thread UserMessage / AgentMessage item, joined by newlines.
fn codex_sub_thread_item_text(item: &serde_json::Value) -> String {
    let mut text = String::new();
    for b in item
        .get("content")
        .and_then(|c| c.as_array())
        .into_iter()
        .flatten()
    {
        if let Some(t) = b.get("text").and_then(|t| t.as_str()).filter(|t| !t.is_empty()) {
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(t);
        }
    }
    text
}

/// Command line of a sub-thread CommandExecution item: parsed_cmd cmd, else the last argv element.
fn codex_command_execution_cmd(item: &serde_json::Value) -> String {
    if let Some(cmd) = non_empty_str(
        item.get("parsed_cmd")
            .and_then(|p| p.get(0))
            .and_then(|p| p.get("cmd")),
    ) {
        return cmd;
    }
    match item.get("command") {
        Some(serde_json::Value::Array(argv)) => argv
            .last()
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Some(serde_json::Value::String(cmd)) => cmd.clone(),
        _ => String::new(),
    }
}

/// One pass over a rollout: the raw entry plus the model id the rollout names
/// (first turn_context model, else thread_settings_applied, else provenance).
fn index_codex_with_named_model(path: &Path) -> (IndexEntry, Option<String>, BillingTokens) {
    let mut cost_requests = Vec::new();
    let mut cost_total = [0i64; 4];
    let mut first_prompt: Option<String> = None;
    let mut model: Option<String> = None;
    let mut search_text = String::new();
    let mut tools: HashSet<String> = HashSet::new();
    let mut tool_counts: HashMap<String, i32> = HashMap::new();
    let mut chapters = 0i32;
    let mut total_tokens = 0i64;
    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut cache_read_tokens = 0i64;
    let mut saw_token_count_total = false;
    let mut errors = 0i32;
    let mut files: HashSet<String> = HashSet::new();
    let mut commits = 0i32;
    // Worked time (fact durac).
    let mut span = ActiveSpan::default();
    let mut turn_model: Option<String> = None;
    let mut settings_model: Option<String> = None;
    let mut provenance_model: Option<String> = None;
    // The session's own thread id: item_completed items of any other thread
    // are a review sub-thread's work (fact cdxsub).
    let mut session_id: Option<String> = None;

    let result = process_file_lines(path, |line| {
        if line.is_empty() || is_codex_index_skippable_line(line) {
            return;
        }
        if let Some(t) = TS_RE.captures(line).and_then(|caps| caps.get(1)) {
            let kind = codex_record_kind(line, &mut span);
            span.add(t.as_str(), kind);
        }

        // Mirror Node indexCodexJsonl isIndexedLine: skip serde_json on irrelevant lines.
        if !is_codex_indexed_line(line) {
            return;
        }

        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };
        let obj_type = obj.get("type").and_then(|v| v.as_str());

        if obj_type == Some("session_meta") {
            if let Some(payload) = obj.get("payload") {
                if let Some(provider) = payload.get("model_provider").and_then(|v| v.as_str()) {
                    model = Some(provider.to_string());
                }
                if provenance_model.is_none() {
                    provenance_model = codex_provenance_model(payload);
                }
                if session_id.is_none() {
                    session_id = non_empty_str(payload.get("id"));
                }
            }
        }

        if obj_type == Some("turn_context") {
            if turn_model.is_none() {
                if let Some(m) = obj
                    .get("payload")
                    .and_then(|p| p.get("model"))
                    .and_then(|v| v.as_str())
                {
                    turn_model = Some(m.to_string());
                    if model.is_none() {
                        model = Some(m.to_string());
                    }
                }
            }
            if !saw_token_count_total {
                if let Some(usage) = obj.get("payload").and_then(|p| p.get("last_token_usage")) {
                    let in_tok = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let out_tok = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    total_tokens += in_tok + out_tok;
                    input_tokens += in_tok;
                    output_tokens += out_tok;
                }
            }
        }

        if obj_type == Some("response_item") {
            let payload = obj
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let role = payload.get("role").and_then(|v| v.as_str());

            if role == Some("assistant") {
                for b in payload
                    .get("content")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                {
                    let btype = b.get("type").and_then(|v| v.as_str());
                    if btype == Some("function_call") {
                        if let Some(name) = b.get("name").and_then(|v| v.as_str()) {
                            let tn = normalize_tool_name(name);
                            tools.insert(tn.clone());
                            *tool_counts.entry(tn).or_insert(0) += 1;
                            // Extract file paths from arguments
                            if let Some(args) = (|| {
                                let args_val = b.get("arguments").cloned()?;
                                let args_str = if args_val.is_string() {
                                    args_val.as_str()?.to_string()
                                } else {
                                    args_val.to_string()
                                };
                                if args_val.is_string() {
                                    serde_json::from_str::<serde_json::Value>(&args_str).ok()
                                } else {
                                    Some(args_val)
                                }
                            })() {
                                if let Some(fp) = args
                                    .get("file_path")
                                    .or_else(|| args.get("path"))
                                    .and_then(|v| v.as_str())
                                {
                                    files.insert(fp.to_string());
                                }
                                if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                                    if GIT_COMMIT_RE.is_match(cmd) {
                                        commits += 1;
                                    }
                                }
                            }
                        }
                    }
                    if btype == Some("output_text") {
                        if let Some(text) = b.get("text").and_then(|v| v.as_str()) {
                            let flat = text.replace('\n', " ");
                            append_index_search_text(&mut search_text, &flat);
                        }
                    }
                }
            }

            if role == Some("user") {
                for b in payload
                    .get("content")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                {
                    if b.get("type").and_then(|v| v.as_str()) == Some("input_text") {
                        if let Some(text) = b.get("text").and_then(|v| v.as_str()) {
                            if is_codex_displayable_user_text(text) {
                                let clean = collapse_whitespace(text);
                                if first_prompt.is_none() {
                                    first_prompt =
                                        Some(clean.chars().take(200).collect::<String>());
                                }
                                chapters += 1;
                                append_index_search_text(&mut search_text, &clean);
                            }
                        }
                    }
                }
            }

            // Payload-level function_call (no role)
            let ptype = payload.get("type").and_then(|v| v.as_str());
            if ptype == Some("function_call") {
                if let Some(name) = payload.get("name").and_then(|v| v.as_str()) {
                    let tn = normalize_tool_name(name);
                    tools.insert(tn.clone());
                    *tool_counts.entry(tn).or_insert(0) += 1;
                    if let Some(args) = (|| {
                        let args_val = payload.get("arguments").cloned()?;
                        let args_str = if args_val.is_string() {
                            args_val.as_str()?.to_string()
                        } else {
                            args_val.to_string()
                        };
                        if args_val.is_string() {
                            serde_json::from_str::<serde_json::Value>(&args_str).ok()
                        } else {
                            Some(args_val)
                        }
                    })() {
                        if let Some(fp) = args
                            .get("file_path")
                            .or_else(|| args.get("path"))
                            .and_then(|v| v.as_str())
                        {
                            files.insert(fp.to_string());
                        }
                        if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                            if GIT_COMMIT_RE.is_match(cmd) {
                                commits += 1;
                            }
                        }
                    }
                }
            }
            if matches!(ptype, Some("function_call_output" | "custom_tool_call_output"))
                && codex_payload_error(&payload)
            {
                errors += 1;
            }
            if ptype == Some("custom_tool_call") {
                if let Some(name) = payload.get("name").and_then(|v| v.as_str()) {
                    let tn = normalize_tool_name(name);
                    tools.insert(tn.clone());
                    *tool_counts.entry(tn).or_insert(0) += 1;
                }
            }
            if ptype == Some("web_search_call") {
                tools.insert("WebSearch".to_string());
                *tool_counts.entry("WebSearch".to_string()).or_insert(0) += 1;
            }
        }

        if obj_type == Some("event_msg") {
            let p = obj
                .get("payload")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let ptype = p.get("type").and_then(|v| v.as_str());
            if ptype == Some("thread_settings_applied") && settings_model.is_none() {
                settings_model = codex_thread_settings_model(&p);
            }
            if let Some(item) = codex_sub_thread_item(&p, session_id.as_deref()) {
                match item.get("type").and_then(|t| t.as_str()) {
                    Some("UserMessage") => {
                        let text = codex_sub_thread_item_text(item);
                        if is_codex_displayable_user_text(&text) {
                            let clean = collapse_whitespace(&text);
                            if first_prompt.is_none() {
                                first_prompt = Some(clean.chars().take(200).collect::<String>());
                            }
                            chapters += 1;
                            append_index_search_text(&mut search_text, &clean);
                        }
                    }
                    Some("AgentMessage") => {
                        let text = codex_sub_thread_item_text(item);
                        if !text.is_empty() {
                            append_index_search_text(&mut search_text, &text.replace('\n', " "));
                        }
                    }
                    Some("CommandExecution") => {
                        tools.insert("Bash".to_string());
                        *tool_counts.entry("Bash".to_string()).or_insert(0) += 1;
                        if codex_payload_error(item) {
                            errors += 1;
                        }
                        if GIT_COMMIT_RE.is_match(&codex_command_execution_cmd(item)) {
                            commits += 1;
                        }
                    }
                    _ => {}
                }
            }
            if ptype == Some("user_message") {
                if let Some(text) = p.get("message").and_then(|v| v.as_str()) {
                    if is_codex_displayable_user_text(text) {
                        let clean = collapse_whitespace(text);
                        if first_prompt.is_none() {
                            first_prompt = Some(clean.chars().take(200).collect::<String>());
                        }
                        chapters += 1;
                        append_index_search_text(&mut search_text, &clean);
                    }
                }
            }
            if ptype == Some("patch_apply_end") {
                tools.insert("Edit".to_string());
                *tool_counts.entry("Edit".to_string()).or_insert(0) += 1;
                if let Some(path) = p.get("path").and_then(|v| v.as_str()) {
                    files.insert(path.to_string());
                }
                if codex_payload_error(&p) {
                    errors += 1;
                }
            }
            if ptype == Some("exec_command_end") {
                tools.insert("Bash".to_string());
                *tool_counts.entry("Bash".to_string()).or_insert(0) += 1;
                if codex_payload_error(&p) {
                    errors += 1;
                }
                if let Some(cmd) = p.get("command").and_then(|v| v.as_str()) {
                    if GIT_COMMIT_RE.is_match(cmd) {
                        commits += 1;
                    }
                }
            }
            if ptype == Some("web_search_end") {
                tools.insert("WebSearch".to_string());
                *tool_counts.entry("WebSearch".to_string()).or_insert(0) += 1;
            }
            if ptype == Some("token_count") {
                if let Some(usage) = p.get("info").and_then(|i| {
                    i.get("total_token_usage")
                        .or_else(|| i.get("last_token_usage"))
                }) {
                    let in_tok = usage
                        .get("input_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let out_tok = usage
                        .get("output_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let cache = usage
                        .get("cached_input_tokens")
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let writes = usage["cache_write_input_tokens"].as_i64().unwrap_or(0);
                    let now = [in_tok, out_tok, cache, writes];
                    let cumulative = p["info"]["total_token_usage"].is_object();
                    let mut delta = [0; 5];
                    for i in 0..4 {
                        delta[i] = if cumulative {
                            (now[i] - cost_total[i]).max(0)
                        } else {
                            now[i]
                        };
                    }
                    if cumulative {
                        cost_total = now;
                    }
                    cost_requests.push(delta);
                    input_tokens = in_tok;
                    output_tokens = out_tok;
                    total_tokens = in_tok + out_tok;
                    cache_read_tokens = cache;
                    saw_token_count_total = true;
                }
            }
        }
    });

    if let Err(e) = result {
        eprintln!("Error reading {}: {}", path.display(), e);
    }

    let duration_ms = span.active_ms();

    let mut tools_vec: Vec<String> = tools.into_iter().collect();
    tools_vec.sort_unstable();

    let entry = IndexEntry {
        first_prompt,
        model,
        term_freqs: Some(tokenize(&search_text)),
        tools: tools_vec,
        tool_counts,
        chapters,
        total_tokens,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        duration_ms,
        errors,
        files: files.len() as i32,
        commits,
        mtime: 0,
    };
    let named_model = turn_model.or(settings_model).or(provenance_model);
    let mut billing = BillingTokens::default();
    for request in cost_requests {
        billing.add(&request, named_model.as_deref().unwrap_or(""));
    }
    (entry, named_model, billing)
}

/// Match JS `Math.round(chars / 4)` for non-negative char counts.
fn estimate_tokens_from_chars(chars: usize) -> i64 {
    ((chars as i64) + 2) / 4
}

/// Factory JSONL rows that affect index state (type:message only).
pub(crate) fn is_factory_indexed_line(line: &str) -> bool {
    line.contains("\"type\":\"message\"") || line.contains("\"type\": \"message\"")
}

/// Non-message filler rows (standalone tool_result etc.) — no index contribution.
pub(crate) fn is_factory_index_skippable_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    !is_factory_indexed_line(line)
}

pub(crate) fn index_factory(path: &Path) -> IndexEntry {
    // Factory JSONL format is very similar to Claude
    let mut first_prompt: Option<String> = None;
    let model: Option<String> = None;
    let mut search_text = String::new();
    let mut tools: HashSet<String> = HashSet::new();
    let mut tool_counts: HashMap<String, i32> = HashMap::new();
    let mut chapters = 0i32;
    let mut total_tokens = 0i64;
    let mut input_tokens = 0i64;
    let mut output_tokens = 0i64;
    let mut cache_read_tokens = 0i64;
    let mut input_chars = 0usize;
    let mut output_chars = 0usize;
    let mut errors = 0i32;
    let mut files: HashSet<String> = HashSet::new();
    let mut commits = 0i32;
    // Worked time (fact durac).
    let mut span = ActiveSpan::default();

    let result = process_file_lines(path, |line| {
        if line.is_empty() || is_factory_index_skippable_line(line) {
            return;
        }
        if let Some(t) = TS_RE.captures(line).and_then(|caps| caps.get(1)) {
            let kind = factory_record_kind(line, &mut span);
            span.add(t.as_str(), kind);
        }
        let is_assistant =
            line.contains("\"role\":\"assistant\"") || line.contains("\"role\": \"assistant\"");
        if line.contains("\"tool_use\"") {
            for caps in TOOL_USE_NAME_RE.captures_iter(line) {
                if let Some(name) = caps.get(1) {
                    let tn = normalize_tool_name(name.as_str());
                    tools.insert(tn.clone());
                    *tool_counts.entry(tn).or_insert(0) += 1;
                    if is_assistant {
                        output_chars += name.as_str().len() + 20;
                    }
                }
            }
            for caps in FILE_PATH_RE.captures_iter(line) {
                if let Some(fp) = caps.get(1) {
                    files.insert(fp.as_str().to_string());
                }
            }
            for caps in COMMAND_RE.captures_iter(line) {
                if let Some(cmd_raw) = caps.get(1) {
                    let cmd = unescape_json_string(cmd_raw.as_str());
                    if GIT_COMMIT_RE.is_match(&cmd) {
                        commits += 1;
                    }
                }
            }
        }
        if line.contains("\"is_error\":true") || line.contains("\"is_error\": true") {
            errors += 1;
        } else if line.contains("\"tool_result\"") {
            if ERROR_PATTERN_RE.is_match(line) {
                errors += 1;
            }
        }

        if is_assistant {
            if let Some(caps) = INPUT_TOKENS_RE.captures(line) {
                if let Some(v) = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok()) {
                    total_tokens += v;
                    input_tokens += v;
                }
            }
            if let Some(caps) = OUTPUT_TOKENS_RE.captures(line) {
                if let Some(v) = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok()) {
                    total_tokens += v;
                    output_tokens += v;
                }
            }
            if let Some(caps) = CACHE_READ_TOKENS_RE.captures(line) {
                if let Some(v) = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok()) {
                    total_tokens += v;
                    cache_read_tokens += v;
                }
            }
            if let Some(caps) = CACHE_WRITE_TOKENS_RE.captures(line) {
                if let Some(v) = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok()) {
                    total_tokens += v;
                }
            }
            for caps in TEXT_BLOCK_RE.captures_iter(line) {
                if let Some(text_raw) = caps.get(1) {
                    let text = unescape_json_string(text_raw.as_str());
                    if !text.is_empty() {
                        append_index_search_text(&mut search_text, &text);
                        output_chars += text.len();
                    }
                }
            }
            for caps in THINKING_RE.captures_iter(line) {
                if let Some(text_raw) = caps.get(1) {
                    let text = unescape_json_string(text_raw.as_str());
                    if !text.is_empty() {
                        append_index_search_text(&mut search_text, &text);
                        output_chars += text.len();
                    }
                }
            }
            return;
        }

        let is_user = line.contains("\"role\":\"user\"") || line.contains("\"role\": \"user\"");
        if !is_user {
            return;
        }

        let obj: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => return,
        };
        if obj.get("type").and_then(|v| v.as_str()) != Some("message") {
            return;
        }
        let role = obj
            .get("message")
            .and_then(|m| m.get("role"))
            .and_then(|v| v.as_str());
        if role != Some("user") {
            return;
        }
        let content = obj.get("message").and_then(|m| m.get("content"));
        if let Some(arr) = content.and_then(|v| v.as_array()) {
            for b in arr {
                if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = b.get("text").and_then(|v| v.as_str()) {
                        if !text.is_empty() && !text.starts_with('<') {
                            let clean = collapse_whitespace(text);
                            if first_prompt.is_none() {
                                first_prompt = Some(clean.chars().take(200).collect::<String>());
                            }
                            chapters += 1;
                            append_index_search_text(&mut search_text, &clean);
                            input_chars += clean.len();
                        }
                    }
                }
            }
        }
    });

    if let Err(e) = result {
        eprintln!("Error reading {}: {}", path.display(), e);
    }

    if total_tokens == 0 && input_tokens == 0 && output_tokens == 0 {
        input_tokens = estimate_tokens_from_chars(input_chars);
        output_tokens = estimate_tokens_from_chars(output_chars);
        total_tokens = input_tokens + output_tokens;
    }

    let duration_ms = span.active_ms();

    let mut tools_vec: Vec<String> = tools.into_iter().collect();
    tools_vec.sort_unstable();

    IndexEntry {
        first_prompt,
        model: model.or_else(|| Some("claude (factory)".to_string())),
        term_freqs: Some(tokenize(&search_text)),
        tools: tools_vec,
        tool_counts,
        chapters,
        total_tokens,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        duration_ms,
        errors,
        files: files.len() as i32,
        commits,
        mtime: 0,
    }
}

/// Lines that can affect Grok index state from chat_history.jsonl (skip parse on filler rows).
pub(crate) fn is_grok_chat_indexed_line(line: &str) -> bool {
    if line.is_empty() || !line.starts_with('{') {
        return false;
    }
    // system filler dominates chat_history volume; one prefix check beats seven scans.
    if line.starts_with("{\"type\":\"system\"") || line.starts_with("{\"type\": \"system\"") {
        return false;
    }
    line.contains("\"type\":\"user\"")
        || line.contains("\"type\": \"user\"")
        || line.contains("\"type\":\"assistant\"")
        || line.contains("\"type\": \"assistant\"")
        || line.contains("\"type\":\"tool_result\"")
        || line.contains("\"type\": \"tool_result\"")
        || ((line.contains("\"type\":\"tool\"") || line.contains("\"type\": \"tool\""))
            && !line.contains("tool_result"))
}

/// Lines that can affect Grok index state from events.jsonl (skip parse on filler rows).
pub(crate) fn is_grok_events_indexed_line(line: &str) -> bool {
    if line.is_empty() {
        return false;
    }
    // stream_chunk filler dominates events.jsonl volume; one scan beats five on ~8k rows.
    if line.contains("\"type\":\"stream_chunk\"") || line.contains("\"type\": \"stream_chunk\"") {
        return false;
    }
    line.contains("\"turn_started\"")
        || line.contains("\"tool_started\"")
        || line.contains("\"tool_completed\"")
        || line.contains("\"ts\"")
        || line.contains("\"timestamp\"")
}

/// Single pass over compact indexed events.jsonl rows: timestamps, model, tools, errors.
fn index_grok_events_lines(
    events_objs: &[serde_json::Value],
    model: &mut Option<String>,
    span: &mut ActiveSpan,
    errors: &mut i32,
    tool_outcomes: &mut Vec<String>,
) {
    for obj in events_objs {
        let ts = obj
            .get("ts")
            .or_else(|| obj.get("timestamp"))
            .and_then(|v| v.as_str());
        if let Some(t) = ts {
            span.add(
                t,
                grok_event_kind(
                    obj.get("type").and_then(|v| v.as_str()),
                    obj.get("tool_name").and_then(|v| v.as_str()),
                ),
            );
        }
        if obj.get("type").and_then(|v| v.as_str()) == Some("turn_started") {
            if let Some(m) = obj.get("model_id").and_then(|v| v.as_str()) {
                *model = Some(m.to_string());
            }
        }
        if obj.get("type").and_then(|v| v.as_str()) == Some("tool_started") {
            if let Some(name) = obj.get("tool_name").and_then(|v| v.as_str()) {
                tool_outcomes.push(normalize_tool_name(name));
            }
        }
        if obj.get("type").and_then(|v| v.as_str()) == Some("tool_completed") {
            if obj.get("outcome").and_then(|v| v.as_str()) == Some("error") {
                *errors += 1;
            }
        }
    }
}

fn index_grok_tool_result_content(
    line: &serde_json::Value,
    search_text: &mut String,
    input_chars: &mut usize,
) {
    if let Some(s) = line.get("content").and_then(|v| v.as_str()) {
        *input_chars += s.len();
        let trimmed = s.trim();
        if trimmed.len() >= 30 {
            let folded = trimmed.replace('\n', " ");
            append_index_search_text(search_text, &folded);
        }
    } else {
        let result_text = line
            .get("content")
            .cloned()
            .unwrap_or(serde_json::Value::Null)
            .to_string();
        *input_chars += result_text.len();
    }
}

/// Single pass over compact indexed chat_history rows: prompts/chunks + toolCounts (indexGrokJsonl parity).
fn index_grok_chat_lines(
    chat_objs: &[serde_json::Value],
    tool_outcomes: &[String],
    first_prompt: &mut Option<String>,
    search_text: &mut String,
    chapters: &mut i32,
    input_chars: &mut usize,
    output_chars: &mut usize,
    files: &mut HashSet<String>,
    commits: &mut i32,
    tools: &mut HashSet<String>,
    tool_counts: &mut HashMap<String, i32>,
) -> usize {
    let mut tool_outcome_idx = 0usize;
    let mut saw_user_or_assistant = false;

    let bump_tool =
        |name: &str, tools: &mut HashSet<String>, tool_counts: &mut HashMap<String, i32>| {
            let tn = name.to_string();
            tools.insert(tn.clone());
            *tool_counts.entry(tn).or_insert(0) += 1;
        };

    let mut i = 0usize;
    while i < chat_objs.len() {
        let line = &chat_objs[i];
        let obj_type = line.get("type").and_then(|v| v.as_str());

        if obj_type == Some("user") {
            let content = line
                .get("content")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            if let Some(text) = extract_prompt(&content) {
                if first_prompt.is_none() {
                    *first_prompt = Some(text.chars().take(200).collect::<String>());
                }
                *chapters += 1;
                append_index_search_text(search_text, &text);
            }
            let user_text = if let Some(s) = content.as_str() {
                s.to_string()
            } else {
                content.to_string()
            };
            *input_chars += user_text.len();
        }

        if obj_type == Some("assistant") {
            if let Some(text) = line.get("content").and_then(|v| v.as_str()) {
                let t = text.replace('\n', " ");
                if !t.is_empty() {
                    append_index_search_text(search_text, &t);
                }
                *output_chars += text.len();
            } else if let Some(arr) = line.get("content").and_then(|v| v.as_array()) {
                for b in arr {
                    if b.get("type").and_then(|v| v.as_str()) == Some("text") {
                        if let Some(text) = b.get("text").and_then(|v| v.as_str()) {
                            let t = text.replace('\n', " ");
                            if !t.is_empty() {
                                append_index_search_text(search_text, &t);
                            }
                            *output_chars += text.len();
                        }
                    }
                }
            }
            for tc in line
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .into_iter()
                .flatten()
            {
                if let Some(name) = tc.get("name").and_then(|v| v.as_str()) {
                    let tn = normalize_tool_name(name);
                    *output_chars += name.len() + 20;
                    let args_val = tc
                        .get("arguments")
                        .cloned()
                        .unwrap_or(serde_json::Value::Null);
                    let args_str = if args_val.is_string() {
                        args_val.as_str().unwrap_or("").to_string()
                    } else {
                        args_val.to_string()
                    };
                    let args = if args_val.is_string() {
                        serde_json::from_str::<serde_json::Value>(&args_str).unwrap_or(args_val)
                    } else {
                        args_val
                    };
                    if let Some(fp) = args
                        .get("file_path")
                        .or_else(|| args.get("path"))
                        .and_then(|v| v.as_str())
                    {
                        files.insert(fp.to_string());
                    }
                    if let Some(cmd) = args.get("command").and_then(|v| v.as_str()) {
                        if tn == "Bash" && GIT_COMMIT_RE.is_match(cmd) {
                            *commits += 1;
                        }
                    }
                    *output_chars += args_str.len();
                }
            }
        }

        if obj_type == Some("tool_result") || obj_type == Some("tool") {
            index_grok_tool_result_content(line, search_text, input_chars);
        }

        if obj_type == Some("system") {
            i += 1;
            continue;
        }
        if obj_type == Some("user") || obj_type == Some("assistant") {
            saw_user_or_assistant = true;
        }

        if obj_type == Some("assistant") {
            let assistant_tool_calls_empty = line
                .get("tool_calls")
                .and_then(|v| v.as_array())
                .map(|a| a.is_empty())
                .unwrap_or(true);
            if !assistant_tool_calls_empty {
                if let Some(arr) = line.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in arr {
                        if let Some(name) = tc.get("name").and_then(|v| v.as_str()) {
                            bump_tool(&normalize_tool_name(name), tools, tool_counts);
                        }
                    }
                }
            }
            let mut j = i + 1;
            while j < chat_objs.len() {
                let next = &chat_objs[j];
                let next_type = next.get("type").and_then(|v| v.as_str());
                if next_type == Some("tool_result") || next_type == Some("tool") {
                    index_grok_tool_result_content(next, search_text, input_chars);
                    if assistant_tool_calls_empty {
                        let name = tool_outcomes
                            .get(tool_outcome_idx)
                            .map(|s| s.as_str())
                            .unwrap_or("unknown");
                        bump_tool(name, tools, tool_counts);
                    }
                    tool_outcome_idx += 1;
                    j += 1;
                } else {
                    break;
                }
            }
            i = j;
            continue;
        }

        if (obj_type == Some("tool_result") || obj_type == Some("tool")) && !saw_user_or_assistant {
            let name = tool_outcomes
                .get(tool_outcome_idx)
                .map(|s| s.as_str())
                .unwrap_or("unknown");
            bump_tool(name, tools, tool_counts);
            tool_outcome_idx += 1;
        }
        i += 1;
    }
    tool_outcome_idx
}

pub(crate) fn index_grok(session_dir: &str) -> IndexEntry {
    index_grok_family(session_dir, "grok")
}

/// Index a grok-layout session dir; `source` ("grok" | "vktr") is the model fallback.
pub(crate) fn index_grok_family(session_dir: &str, source: &str) -> IndexEntry {
    let session_path = Path::new(session_dir);
    let mut model: Option<String> = None;
    let mut first_prompt: Option<String> = None;
    let mut search_text = String::new();
    let mut tools: HashSet<String> = HashSet::new();
    let mut tool_counts: HashMap<String, i32> = HashMap::new();
    let mut chapters = 0i32;
    let mut errors = 0i32;
    let mut files: HashSet<String> = HashSet::new();
    let mut commits = 0i32;
    // Worked time over events.jsonl (fact durac).
    let mut span = ActiveSpan::default();
    let mut input_chars = 0usize;
    let mut output_chars = 0usize;
    let mut tool_outcomes: Vec<String> = Vec::new();
    let mut events_objs: Vec<serde_json::Value> = Vec::new();
    let mut chat_objs: Vec<serde_json::Value> = Vec::new();
    // Read prompt_context.json for model
    let ctx_path = session_path.join("prompt_context.json");
    if let Ok(raw) = fs::read_to_string(&ctx_path) {
        if let Ok(ctx) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(m) = ctx.get("model_id").and_then(|v| v.as_str()) {
                model = Some(m.to_string());
            }
        }
    }
    if model.is_none() {
        model = Some(source.to_string());
    }

    // Read events.jsonl for timestamps, tools, errors (compact indexed objs, like chat_history).
    let events_path = session_path.join("events.jsonl");
    let _ = process_file_lines(&events_path, |line| {
        if line.is_empty() || !is_grok_events_indexed_line(line) {
            return;
        }
        if let Ok(v) = serde_json::from_str(line) {
            events_objs.push(v);
        }
    });
    index_grok_events_lines(
        &events_objs,
        &mut model,
        &mut span,
        &mut errors,
        &mut tool_outcomes,
    );

    // Read chat_history.jsonl for prompts, assistant text, tool calls
    let chat_path = session_path.join("chat_history.jsonl");
    let chat_file_exists = chat_path.exists();
    let _ = process_file_lines(&chat_path, |line| {
        if line.is_empty() || !is_grok_chat_indexed_line(line) {
            return;
        }
        if let Ok(v) = serde_json::from_str(line) {
            chat_objs.push(v);
        }
    });

    if chat_file_exists {
        let consumed = index_grok_chat_lines(
            &chat_objs,
            &tool_outcomes,
            &mut first_prompt,
            &mut search_text,
            &mut chapters,
            &mut input_chars,
            &mut output_chars,
            &mut files,
            &mut commits,
            &mut tools,
            &mut tool_counts,
        );
        for name in tool_outcomes.iter().skip(consumed) {
            tools.insert(name.clone());
            *tool_counts.entry(name.clone()).or_insert(0) += 1;
        }
    } else {
        for name in &tool_outcomes {
            tools.insert(name.clone());
            *tool_counts.entry(name.clone()).or_insert(0) += 1;
        }
    }

    let duration_ms = span.active_ms();

    let est_input_tokens = estimate_tokens_from_chars(input_chars);
    let est_output_tokens = estimate_tokens_from_chars(output_chars);

    let mut tools_vec: Vec<String> = tools.into_iter().collect();
    tools_vec.sort_unstable();

    IndexEntry {
        first_prompt,
        model,
        term_freqs: Some(tokenize(&search_text)),
        tools: tools_vec,
        tool_counts,
        chapters,
        total_tokens: est_input_tokens + est_output_tokens,
        input_tokens: est_input_tokens,
        output_tokens: est_output_tokens,
        cache_read_tokens: 0,
        duration_ms,
        errors,
        files: files.len() as i32,
        commits,
        mtime: 0,
    }
}

/// Codex entry format, stored as index.json's top-level `_codex` (fact cdxheal).
/// Format 2 records the turn_context model id (index_codex_session); format 3
/// also records, for a rollout without one, its thread_settings_applied or
/// provenance model (fact cdxheal3); format 4 also counts a review sub-thread's
/// prompt and commands (fact cdxsub). A reused codex entry from an index without
/// this marker gets its model from codex_heal_model, or is re-indexed when it
/// has neither a prompt nor a tool (fact cdxsub2). Mirrors Node
/// CODEX_INDEX_FORMAT.
pub const CODEX_INDEX_FORMAT: i64 = 4;

/// The model id a codex index row should carry (facts cdxheal, cdxheal3): the
/// first turn_context model id, reading only up to that line; for a rollout
/// without one, its thread_settings_applied or provenance model (fact cdxprov);
/// None when the rollout names no model.
pub(crate) fn codex_heal_model(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return codex_model_outside_turn_context(path),
            Ok(_) => {}
        }
        if !line.windows(14).any(|w| w == b"\"turn_context\"") {
            continue;
        }
        let Ok(obj) = serde_json::from_slice::<serde_json::Value>(&line) else {
            continue;
        };
        if obj.get("type").and_then(|t| t.as_str()) != Some("turn_context") {
            continue;
        }
        if let Some(m) = obj
            .get("payload")
            .and_then(|p| p.get("model"))
            .and_then(|m| m.as_str())
            .filter(|m| !m.is_empty())
        {
            return Some(m.to_string());
        }
    }
}

/// thread_settings_applied model, else session_meta provenance model, of a
/// rollout with no turn_context model id (fact cdxprov). Only lines naming
/// either field are parsed.
fn codex_model_outside_turn_context(path: &Path) -> Option<String> {
    fn contains(line: &[u8], needle: &[u8]) -> bool {
        line.windows(needle.len()).any(|w| w == needle)
    }
    let file = fs::File::open(path).ok()?;
    let mut reader = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut line = Vec::new();
    let mut provenance_model: Option<String> = None;
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => return provenance_model,
            Ok(_) => {}
        }
        if provenance_model.is_none()
            && contains(&line, b"\"provenance\"")
            && contains(&line, b"\"session_meta\"")
        {
            if let Ok(obj) = serde_json::from_slice::<serde_json::Value>(&line) {
                if obj.get("type").and_then(|t| t.as_str()) == Some("session_meta") {
                    provenance_model = obj.get("payload").and_then(codex_provenance_model);
                }
            }
        }
        if contains(&line, b"\"thread_settings_applied\"") {
            if let Ok(obj) = serde_json::from_slice::<serde_json::Value>(&line) {
                if obj.get("type").and_then(|t| t.as_str()) == Some("event_msg") {
                    if let Some(m) = obj.get("payload").and_then(codex_thread_settings_model) {
                        return Some(m);
                    }
                }
            }
        }
    }
}

/// Top-level index.json keys that are not session paths.
const INDEX_META_KEYS: [&str; 2] = ["_v", "_codex"];

/// Read existing disk cache and return entries whose _v version matches expected.
#[cfg(test)]
pub fn read_index_cache(path: &Path, expected_version: i32) -> HashMap<String, IndexEntry> {
    read_index_cache_with_codex_format(path, expected_version)
        .0
        .into_iter()
        .map(|(k, v)| (k, v.meta))
        .collect()
}

/// Like read_index_cache, plus whether the file's codex entries are in the
/// current CODEX_INDEX_FORMAT.
fn read_index_cache_with_codex_format(
    path: &Path,
    expected_version: i32,
) -> (HashMap<String, CostIndexEntry>, bool) {
    let raw = match fs::read_to_string(path) {
        Ok(r) => r,
        Err(_) => return (HashMap::new(), false),
    };
    let value: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return (HashMap::new(), false),
    };
    let version = match value.get("_v").and_then(|v| v.as_i64()) {
        Some(v) => v as i32,
        None => return (HashMap::new(), false),
    };
    if version != expected_version {
        return (HashMap::new(), false);
    }
    let codex_current = value.get("_codex").and_then(|v| v.as_i64()) == Some(CODEX_INDEX_FORMAT);
    let mut map = HashMap::new();
    if let Some(obj) = value.as_object() {
        for (key, val) in obj {
            if INDEX_META_KEYS.contains(&key.as_str()) {
                continue;
            }
            if let Ok(entry) = serde_json::from_value::<CostIndexEntry>(val.clone()) {
                map.insert(key.clone(), entry);
            }
        }
    }
    (map, codex_current)
}

/// A session arrived with a `source` this build does not know how to index.
///
/// This is a contract violation between the discovery layer and the indexer, not a
/// per-file data error: guessing an indexer would write a plausible-looking but
/// entirely fabricated entry into `index.json` (fact z9k).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownSourceError {
    pub path: String,
    pub source: String,
}

impl std::fmt::Display for UnknownSourceError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "unrecognised session source {:?} for {} — refusing to index (known sources: {})",
            self.source,
            self.path,
            KNOWN_SOURCES.join(", ")
        )
    }
}

impl std::error::Error for UnknownSourceError {}

/// Every `source` value this build can index. Kept in sync with `indexer_for`.
pub const KNOWN_SOURCES: [&str; 10] = [
    "claude",
    "codex",
    "cursor",
    "cursor-cloud",
    "dsh",
    "factory",
    "fx",
    "grok",
    "opencode",
    "vktr",
];

/// Resolve the indexer for a session source, or `None` when the source is unknown.
///
/// Single dispatch point — there is deliberately no catch-all fallback arm. A new
/// source must be added here (and to `KNOWN_SOURCES`) to be indexable.
fn indexer_for(source: &str) -> Option<fn(&Session) -> IndexEntry> {
    match source {
        "claude" => Some(|s| index_claude_with_cost(Path::new(&s.path)).meta),
        "codex" => Some(|s| index_codex_session(Path::new(&s.path))),
        "cursor" => Some(|s| index_cursor(Path::new(&s.path))),
        "cursor-cloud" => Some(|s| index_cursor_cloud(Path::new(&s.path))),
        "factory" => Some(|s| index_factory(Path::new(&s.path))),
        "grok" => Some(|s| index_grok(&s.path)),
        "vktr" => Some(|s| index_grok_family(&s.path, "vktr")),
        "fx" => Some(|s| crate::fx_dsh::index_fx(Path::new(&s.path))),
        "dsh" => Some(|s| crate::fx_dsh::index_dsh(Path::new(&s.path))),
        "opencode" => Some(index_opencode),
        _ => None,
    }
}

/// Build or update the session index, reusing disk-cache entries whose mtime matches.
///
/// `search_stale` is a set of session paths that are missing from the Node-side
/// SearchIndex (8rj). A session in this set is always re-parsed and returned with
/// a fresh `termFreqs` even if its mtime-matched cache entry would otherwise be reused.
///
/// A reused codex entry from an index without the current `_codex` marker gets
/// its model id from the head of the rollout (facts cdxheal, cdxheal3), or is
/// re-indexed when it has neither a prompt nor a tool (fact cdxsub2); the
/// rest of the entry and every other source stay plain mtime cache hits.
///
/// Fails closed on an unrecognised `source` (fact z9k): the whole batch returns
/// `Err` so no caller can persist or emit an entry for it.
pub fn build_index(
    index_path: &PathBuf,
    version: i32,
    sessions: &[Session],
    search_stale: &HashSet<String>,
) -> Result<HashMap<String, CostIndexEntry>, UnknownSourceError> {
    let (cache, codex_current) = read_index_cache_with_codex_format(index_path, version);

    // Parse session files in parallel with rayon. The cache is read once and
    // shared immutably; each index_* function is pure (reads its own file/DB
    // connection and returns an IndexEntry), so per-session work is independent.
    sessions
        .par_iter()
        .map_init(OpenCodeConns::default, |opencode_conns, session| {
            let key = session.path.clone();
            let mtime = session.mtime.timestamp_millis();

            // Resolve the indexer BEFORE the mtime cache-reuse check. An entry
            // persisted by an older, fallback-happy build must not be laundered
            // back out of index.json just because its mtime still matches.
            let Some(indexer) = indexer_for(&session.source) else {
                return Err(UnknownSourceError {
                    path: key,
                    source: session.source.clone(),
                });
            };

            // Reuse cache entry when mtime matches AND session is not search-stale.
            if !search_stale.contains(&key) {
                if let Some(entry) = cache.get(&key) {
                    // A codex row from before fact cdxsub with no prompt and no
                    // tool may be a review rollout whose work was all in its
                    // sub-thread: re-index it once (fact cdxsub2).
                    let codex_reindex = !codex_current
                        && session.source == "codex"
                        && entry.first_prompt.as_deref().unwrap_or("").is_empty()
                        && entry.tool_counts.is_empty();
                    if entry.mtime == mtime && !codex_reindex {
                        let mut entry = entry.clone();
                        if !codex_current && session.source == "codex" {
                            if let Some(m) = codex_heal_model(Path::new(&key)) {
                                entry.model = Some(m);
                            }
                        }
                        return Ok((key, entry));
                    }
                }
            }

            let mut entry = if session.source == "claude" {
                index_claude_with_cost(Path::new(&session.path))
            } else if session.source == "codex" {
                let (mut meta, named_model, billing) =
                    index_codex_with_named_model(Path::new(&session.path));
                if named_model.is_some() {
                    meta.model = named_model;
                }
                CostIndexEntry {
                    meta,
                    billing_tokens: Some(billing),
                }
            } else if session.source == "opencode" {
                index_opencode_in(opencode_conns, session).into()
            } else {
                indexer(session).into()
            };
            entry.mtime = mtime;
            Ok((key, entry))
        })
        .collect()
}

/// Write index.json disk cache — metadata-only (no termFreqs per yb5/9ct).
pub fn write_index_cache<T: serde::Serialize>(
    path: &Path,
    version: i32,
    entries: &HashMap<String, T>,
) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut wrapper = serde_json::Map::new();
    wrapper.insert("_v".to_string(), serde_json::Value::Number(version.into()));
    // Every codex entry written here came from index_codex_session or was
    // healed by build_index, so it is in the current format.
    wrapper.insert(
        "_codex".to_string(),
        serde_json::Value::Number(CODEX_INDEX_FORMAT.into()),
    );
    for (k, v) in entries {
        // Strip full-text payload fields — index.json is metadata only (yb5, 9ct).
        let mut stripped = serde_json::to_value(v).unwrap_or(serde_json::Value::Null);
        if let Some(obj) = stripped.as_object_mut() {
            obj.remove("termFreqs");
        }
        wrapper.insert(k.clone(), stripped);
    }
    let json = serde_json::to_string(&serde_json::Value::Object(wrapper))?;
    // Write to a sibling temp file and rename it into place so a concurrent
    // reader (the Node server) never parses a half-written index.json.
    let mut tmp_name = path.file_name().unwrap_or_default().to_os_string();
    tmp_name.push(format!(".{}.sidecar.tmp", std::process::id()));
    let tmp = path.with_file_name(tmp_name);
    fs::write(&tmp, json)?;
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}
