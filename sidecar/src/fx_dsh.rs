//! fx and DeepSeek Harness (dsh) sessions: scan and index. Twins of the JS
//! findFxSessions / findDshSessions (src/sessions/session-discovery.js) and
//! indexFx / indexDsh (src/sessions/session-index-fx-dsh.js).
//!
//! fx keeps ~/.fx/sessions/<id>/{session.json,events.jsonl}; the session path
//! is events.jsonl. dsh keeps ~/.dsh/sessions/<cwd slug>/<session dir>/
//! session.v<N>.jsonl.zstd, JSONL appended one zstd frame per write; the
//! session path is that file.

use crate::indexer::{
    append_index_search_text, normalize_tool_name, tokenize, ActiveSpan, RecordKind,
};
use crate::scan::normalize_project_folder;
use crate::types::{IndexEntry, Session};
use regex::Regex;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::LazyLock;
use std::time::SystemTime;

const ZSTD_MAGIC: u32 = 0xfd2f_b528;
/// Skippable frames use magics 0x184D2A50..0x184D2A5F.
const SKIPPABLE_MASK: u32 = 0xffff_fff0;
const SKIPPABLE_MAGIC: u32 = 0x184d_2a50;
/// A head read is enough for the first frames (one write each).
const HEAD_BYTES: usize = 256 * 1024;

static GIT_COMMIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\bgit\b.*\bcommit\b").unwrap());
/// A shell result's trailing "[exit code: N]" marker with N nonzero.
static DSH_FAILED_EXIT_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[exit code: [1-9]\d*\]\s*$").unwrap());

fn u32_le(buf: &[u8], at: usize) -> Option<u32> {
    buf.get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// Byte length of the zstd frame starting at `at`, or None when it is
/// malformed or extends past the end of `buf`. Mirrors JS zstdFrameLength.
pub(crate) fn zstd_frame_length(buf: &[u8], at: usize) -> Option<usize> {
    let magic = u32_le(buf, at)?;
    if magic & SKIPPABLE_MASK == SKIPPABLE_MAGIC {
        let len = 8 + u32_le(buf, at + 4)? as usize;
        return (at + len <= buf.len()).then_some(len);
    }
    if magic != ZSTD_MAGIC {
        return None;
    }
    let mut p = at + 4;
    let fhd = *buf.get(p)?;
    p += 1;
    let fcs_flag = fhd >> 6;
    let single_segment = (fhd >> 5) & 1;
    let checksum = (fhd >> 2) & 1;
    if single_segment == 0 {
        p += 1; // window descriptor
    }
    p += [0, 1, 2, 4][(fhd & 3) as usize];
    p += match fcs_flag {
        0 => single_segment as usize,
        1 => 2,
        2 => 4,
        _ => 8,
    };
    loop {
        let header = buf.get(p..p + 3)?;
        let header = header[0] as u32 | (header[1] as u32) << 8 | (header[2] as u32) << 16;
        p += 3;
        let last = header & 1;
        let block_type = (header >> 1) & 3;
        let size = (header >> 3) as usize;
        if block_type == 3 {
            return None; // reserved block type
        }
        p += if block_type == 1 { 1 } else { size }; // an RLE block stores one byte
        if p > buf.len() {
            return None;
        }
        if last == 1 {
            break;
        }
    }
    if checksum == 1 {
        p += 4;
    }
    (p <= buf.len()).then_some(p - at)
}

/// Decoded bytes of the complete frames in `buf` (at most `max_frames`), in
/// order. A frame cut short or failing to decode ends the read. Mirrors JS
/// decodeZstdFrames.
pub(crate) fn decode_zstd_frames(buf: &[u8], max_frames: usize) -> Vec<u8> {
    let mut out = Vec::new();
    let mut frames = 0usize;
    let mut at = 0usize;
    while at < buf.len() && frames < max_frames {
        let Some(len) = zstd_frame_length(buf, at) else { break };
        if u32_le(buf, at) == Some(ZSTD_MAGIC) {
            let mut frame = &buf[at..at + len];
            let mut decoded = Vec::new();
            let ok = ruzstd::decoding::StreamingDecoder::new(&mut frame)
                .map_err(|_| ())
                .and_then(|mut d| d.read_to_end(&mut decoded).map_err(|_| ()))
                .is_ok();
            if !ok {
                break;
            }
            out.extend_from_slice(&decoded);
            frames += 1;
        }
        at += len;
    }
    out
}

/// The decoded JSONL text of a dsh recording, or of its first `max_frames`
/// writes ("" when unreadable).
pub(crate) fn read_dsh_text(path: &Path, max_frames: usize) -> String {
    let is_zstd = path.extension().and_then(|e| e.to_str()) == Some("zstd");
    if !is_zstd {
        return fs::read_to_string(path).unwrap_or_default();
    }
    let bytes = if max_frames == usize::MAX {
        fs::read(path).unwrap_or_default()
    } else {
        let mut head = Vec::new();
        if let Ok(f) = fs::File::open(path) {
            let _ = f.take(HEAD_BYTES as u64).read_to_end(&mut head);
        }
        head
    };
    String::from_utf8_lossy(&decode_zstd_frames(&bytes, max_frames)).into_owned()
}

/// session.v<N>.jsonl.zstd (or an uncompressed session.v<N>.jsonl).
pub(crate) fn is_dsh_recording_file(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("session.v") else { return false };
    let digits = rest.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && matches!(&rest[digits..], ".jsonl" | ".jsonl.zstd")
}

fn mtime_of(metadata: &fs::Metadata) -> chrono::DateTime<chrono::Utc> {
    let st = metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let d = st.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    chrono::DateTime::from_timestamp(d.as_secs() as i64, d.subsec_nanos())
        .unwrap_or(chrono::DateTime::from_timestamp(0, 0).unwrap())
}

fn subdirs(dir: &Path) -> Vec<(String, std::path::PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| fs::metadata(e.path()).map(|m| m.is_dir()).unwrap_or(false))
        .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
        .collect()
}

fn read_json(path: &Path) -> serde_json::Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

fn project_for(cwd: &str, source: &str) -> String {
    if cwd.is_empty() {
        source.to_string()
    } else {
        normalize_project_folder(cwd)
    }
}

/// fx sessions: every <root>/<id>/events.jsonl, the project from session.json
/// workspace_root; a subagent child names its parent (subagent/owner.json).
pub(crate) fn scan_fx(root: &str, filter: Option<&str>) -> Vec<Session> {
    let mut sessions = Vec::new();
    for (name, dir) in subdirs(Path::new(root)) {
        let events = dir.join("events.jsonl");
        let Ok(metadata) = fs::metadata(&events) else { continue };
        if !metadata.is_file() {
            continue;
        }
        let meta = read_json(&dir.join("session.json"));
        let cwd = meta
            .get("workspace_root")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| meta.get("origin_workspace_root").and_then(|v| v.as_str()))
            .unwrap_or("");
        let project = project_for(cwd, "fx");
        if let Some(f) = filter {
            if !project.contains(f) && !cwd.contains(f) {
                continue;
            }
        }
        let parent_session = if meta.get("subagent_child").and_then(|v| v.as_bool()) == Some(true) {
            read_json(&dir.join("subagent").join("owner.json"))
                .get("parent_id")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        } else {
            None
        };
        sessions.push(Session {
            path: events.to_string_lossy().to_string(),
            project,
            file: name,
            source: "fx".to_string(),
            size: metadata.len(),
            mtime: mtime_of(&metadata),
            parent_session,
            title: None,
        });
    }
    sessions
}

/// The cwd a dsh recording's session row (its first write) names, or "".
fn dsh_session_cwd(path: &Path) -> String {
    let text = read_dsh_text(path, 1);
    let first = text.lines().next().unwrap_or("");
    let row: serde_json::Value = serde_json::from_str(first).unwrap_or(serde_json::Value::Null);
    if row.get("type").and_then(|v| v.as_str()) != Some("session") {
        return String::new();
    }
    row.get("cwd").and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// dsh sessions: <root>/<cwd slug>/<session dir>/session.v<N>.jsonl.zstd, the
/// project from the recording's session row cwd. The dir is session-<uuid>
/// for CLI runs and a bare <uuid> for ACP sessions.
pub(crate) fn scan_dsh(root: &str, filter: Option<&str>) -> Vec<Session> {
    let mut sessions = Vec::new();
    for (_, ws_dir) in subdirs(Path::new(root)) {
        for (name, dir) in subdirs(&ws_dir) {
            let Ok(entries) = fs::read_dir(&dir) else { continue };
            let mut names: Vec<String> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| is_dsh_recording_file(n))
                .collect();
            names.sort();
            let Some(file_name) = names.pop() else { continue };
            let full = dir.join(&file_name);
            let Ok(metadata) = fs::metadata(&full) else { continue };
            if !metadata.is_file() {
                continue;
            }
            let cwd = dsh_session_cwd(&full);
            let project = project_for(&cwd, "dsh");
            if let Some(f) = filter {
                if !project.contains(f) && !cwd.contains(f) {
                    continue;
                }
            }
            sessions.push(Session {
                path: full.to_string_lossy().to_string(),
                project,
                file: name,
                source: "dsh".to_string(),
                size: metadata.len(),
                mtime: mtime_of(&metadata),
                parent_session: None,
                title: None,
            });
        }
    }
    sessions
}

/// Index accumulator shared by fx and dsh (JS createIndexState subset).
#[derive(Default)]
struct Acc {
    first_prompt: Option<String>,
    model: Option<String>,
    search_text: String,
    tools: HashSet<String>,
    tool_counts: HashMap<String, i32>,
    chapters: i32,
    errors: i32,
    files: HashSet<String>,
    commits: i32,
    input_tokens: i64,
    output_tokens: i64,
    cache_read_tokens: i64,
}

/// The text after any leading <kandev-system> blocks Kandev puts ahead of a
/// prompt (JS stripKandevContext).
fn strip_kandev_context(text: &str) -> &str {
    let mut value = text;
    while value.starts_with("<kandev-system>") {
        let Some(end) = value.find("</kandev-system>") else { break };
        value = value[end + "</kandev-system>".len()..].trim_start();
    }
    value
}

impl Acc {
    fn add_prompt(&mut self, text: &str) {
        let clean = strip_kandev_context(text.trim()).replace('\n', " ");
        let clean = clean.trim();
        if clean.is_empty() {
            return;
        }
        if self.first_prompt.is_none() {
            self.first_prompt = Some(clean.chars().take(200).collect());
        }
        self.chapters += 1;
        append_index_search_text(&mut self.search_text, clean);
    }

    fn add_text(&mut self, text: &str) {
        if !text.is_empty() {
            append_index_search_text(&mut self.search_text, &text.replace('\n', " "));
        }
    }

    /// One tool call: its normalized name, the file it names, a git commit.
    fn add_tool_call(&mut self, raw_name: &str, input: &serde_json::Value) {
        let name = normalize_tool_name(raw_name);
        self.tools.insert(name.clone());
        *self.tool_counts.entry(name.clone()).or_insert(0) += 1;
        let fp = input
            .get("file_path")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| input.get("path").and_then(|v| v.as_str()))
            .unwrap_or("");
        if !fp.is_empty() {
            self.files.insert(fp.to_string());
        }
        if name == "Bash" {
            let cmd = input.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if GIT_COMMIT_RE.is_match(cmd) {
                self.commits += 1;
            }
        }
    }

    fn finish(self, duration_ms: i64, default_model: &str) -> IndexEntry {
        let mut tools: Vec<String> = self.tools.into_iter().collect();
        tools.sort_unstable();
        IndexEntry {
            first_prompt: self.first_prompt,
            model: self.model.or_else(|| Some(default_model.to_string())),
            term_freqs: Some(tokenize(&self.search_text)),
            tools,
            tool_counts: self.tool_counts,
            chapters: self.chapters,
            total_tokens: self.input_tokens + self.cache_read_tokens + self.output_tokens,
            input_tokens: self.input_tokens,
            output_tokens: self.output_tokens,
            cache_read_tokens: self.cache_read_tokens,
            duration_ms,
            errors: self.errors,
            files: self.files.len() as i32,
            commits: self.commits,
            mtime: 0,
        }
    }
}

fn parse_args(raw: Option<&serde_json::Value>) -> serde_json::Value {
    match raw {
        Some(serde_json::Value::String(s)) if !s.is_empty() => {
            serde_json::from_str(s).unwrap_or(serde_json::Value::Null)
        }
        Some(v @ serde_json::Value::Object(_)) => v.clone(),
        _ => serde_json::Value::Null,
    }
}

/// fx tool name and argument object mapped onto the shared tool vocabulary (JS fxToolCall).
fn fx_tool_call(tool_name: &str, args: serde_json::Value) -> (String, serde_json::Value) {
    let raw = match tool_name {
        "glob_files" => "glob",
        "grep_files" => "grep",
        "subagent" => "agent",
        other => other,
    };
    if tool_name == "subagent" {
        return (raw.to_string(), serde_json::Value::Null);
    }
    (raw.to_string(), args)
}

/// True when an fx tool result failed: a non-success status or a shell exit
/// code other than 0 (JS fxToolResultText).
fn fx_result_failed(result: &serde_json::Value) -> bool {
    let status = result.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !status.is_empty() && status != "success" {
        return true;
    }
    if result.get("tool_name").and_then(|v| v.as_str()) != Some("shell") {
        return false;
    }
    let preview = result.get("preview").and_then(|v| v.as_str()).unwrap_or("");
    if !preview.starts_with('{') {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(preview)
        .ok()
        .and_then(|v| v.get("exit_code").and_then(|c| c.as_i64()))
        .is_some_and(|code| code != 0)
}

/// Index an fx session (its events.jsonl). Worked time is the sum of the
/// turns' turn_duration_ms: fx stamps a turn's rows with the turn's end.
pub(crate) fn index_fx(path: &Path) -> IndexEntry {
    let mut acc = Acc::default();
    let meta = path
        .parent()
        .map(|d| read_json(&d.join("session.json")))
        .unwrap_or(serde_json::Value::Null);
    acc.model = meta.get("model").and_then(|v| v.as_str()).map(|s| s.to_string());
    let mut worked_ms = 0i64;
    let text = fs::read_to_string(path).unwrap_or_default();
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(event) = row.get("event").and_then(|v| v.as_object()) else { continue };
        let Some((kind, ev)) = event.iter().next() else { continue };
        match kind.as_str() {
            "user" => acc.add_prompt(ev.get("text").and_then(|v| v.as_str()).unwrap_or("")),
            "assistant" => {
                if let Some(m) = ev
                    .pointer("/provider_replay/source/model")
                    .and_then(|v| v.as_str())
                {
                    acc.model = Some(m.to_string());
                }
                acc.add_text(ev.get("text").and_then(|v| v.as_str()).unwrap_or(""));
            }
            "tool_call" => {
                let name = ev.get("tool_name").and_then(|v| v.as_str()).unwrap_or("");
                let (raw, input) = fx_tool_call(name, parse_args(ev.get("arguments_json")));
                acc.add_tool_call(&raw, &input);
            }
            "tool_result" => {
                if fx_result_failed(ev) {
                    acc.errors += 1;
                }
            }
            "turn_completed" | "interrupted" => {
                let summary = ev.get("turn_summary");
                if let Some(ms) = summary
                    .and_then(|s| s.get("turn_duration_ms"))
                    .and_then(|v| v.as_i64())
                {
                    worked_ms += ms;
                }
                if let Some(tp) = summary.and_then(|s| s.get("token_progress")) {
                    acc.input_tokens += tp.get("input_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                    acc.output_tokens += tp.get("output_tokens").and_then(|v| v.as_i64()).unwrap_or(0);
                }
            }
            _ => {}
        }
    }
    acc.finish(worked_ms, "fx")
}

/// Joined text parts of a dsh message content array (JS dshContentText).
fn dsh_content_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("text"))
            .filter_map(|p| p.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Index a dsh recording. Worked time is the active span over its rows.
pub(crate) fn index_dsh(path: &Path) -> IndexEntry {
    let mut acc = Acc::default();
    let mut span = ActiveSpan::default();
    let text = read_dsh_text(path, usize::MAX);
    for line in text.lines() {
        let Ok(row) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let row_type = row.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let data = row.get("data").unwrap_or(&serde_json::Value::Null);
        let mut kind = RecordKind::Other;
        match row_type {
            "user/message" => {
                if data.pointer("/source/kind").and_then(|v| v.as_str()) == Some("user") {
                    kind = RecordKind::User;
                    acc.add_prompt(&dsh_content_text(data.get("content")));
                }
            }
            "assistant/message" => {
                kind = RecordKind::Assistant;
                let msg = data.get("message").unwrap_or(&serde_json::Value::Null);
                if let Some(m) = msg.pointer("/source/model").and_then(|v| v.as_str()) {
                    acc.model = Some(m.to_string());
                }
                for part in msg.get("content").and_then(|v| v.as_array()).into_iter().flatten() {
                    match part.get("type").and_then(|v| v.as_str()) {
                        Some("text") => {
                            acc.add_text(part.get("text").and_then(|v| v.as_str()).unwrap_or(""))
                        }
                        Some("tool-call") => {
                            let name = part.get("name").and_then(|v| v.as_str()).unwrap_or("");
                            let raw = match name {
                                "subagent" | "subagent_fork" => "agent",
                                other => other,
                            };
                            let input = parse_args(part.get("arguments"));
                            acc.add_tool_call(raw, &input);
                            let id = part.get("id").and_then(|v| v.as_str()).unwrap_or("");
                            span.note_tool_call(id, raw);
                        }
                        _ => {}
                    }
                }
                let usage = data.get("usage");
                let tok = |k: &str| usage.and_then(|u| u.get(k)).and_then(|v| v.as_i64()).unwrap_or(0);
                acc.input_tokens += tok("inputTokens");
                acc.output_tokens += tok("outputTokens");
                acc.cache_read_tokens += tok("cacheReadTokens");
            }
            "tool/result" => {
                let msg = data.get("message").unwrap_or(&serde_json::Value::Null);
                let text = dsh_content_text(msg.get("content"));
                if msg.get("isError").and_then(|v| v.as_bool()) == Some(true)
                    || DSH_FAILED_EXIT_RE.is_match(&text)
                {
                    acc.errors += 1;
                }
                let id = msg
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .or_else(|| msg.pointer("/source/callId").and_then(|v| v.as_str()))
                    .unwrap_or("");
                kind = span.result_kind_for_id(id);
            }
            "turn/end" => {
                if data.pointer("/reason/kind").and_then(|v| v.as_str()) == Some("error") {
                    acc.errors += 1;
                }
            }
            _ => {}
        }
        let ms_key = if row_type == "session" { "createdAt" } else { "time" };
        if let Some(ms) = row.get(ms_key).and_then(|v| v.as_i64()) {
            span.add_ms(ms, kind);
        }
    }
    acc.finish(span.active_ms(), "dsh")
}
