use crate::indexer::{
    build_index, collapse_whitespace, extract_prompt, index_claude, index_codex, index_cursor,
    index_cursor_cloud, index_factory, index_grok, index_opencode, is_claude_index_skippable_line,
    is_codex_index_skippable_line, is_factory_index_skippable_line, is_grok_chat_indexed_line,
    is_grok_events_indexed_line, looks_like_code_or_path, normalize_tool_name, process_file_lines,
    read_index_cache, tokenize, unescape_json_string, write_index_cache, MESSAGE_MODEL_RE,
    TEXT_BLOCK_RE,
};
use crate::types::{IndexEntry, Session};
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

/// Assert a wall-clock perf budget, unless perf assertions are disabled.
///
/// These budgets are real regression guards (see CLAUDE.md), but wall-clock time
/// is unstable on shared CI runners — the same test that passes locally in a
/// debug build blows its budget on a noisy GitHub runner. With
/// `TRACEQUEST_SKIP_PERF_ASSERTS=1` the workload and every functional assertion
/// still run; only the timing comparison is skipped and logged, so slow hardware
/// cannot fail the correctness gate. Left unset (local runs, dedicated perf
/// jobs) the budget is enforced.
fn assert_perf_ms(actual_ms: f64, budget_ms: f64, what: &str) {
    if std::env::var("TRACEQUEST_SKIP_PERF_ASSERTS").as_deref() == Ok("1") {
        eprintln!("perf-assert skipped ({what}): {actual_ms:.2}ms vs budget {budget_ms}ms");
        return;
    }
    assert!(
        actual_ms < budget_ms,
        "expected {what} under {budget_ms}ms, got {actual_ms:.2}ms"
    );
}

#[test]
fn test_looks_like_code_or_path() {
    assert!(looks_like_code_or_path("/home/user/code/foo.rs"));
    assert!(looks_like_code_or_path("https://example.com/x"));
    assert!(looks_like_code_or_path("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
    assert!(looks_like_code_or_path("{\"key\":1}"));
    assert!(!looks_like_code_or_path("fix the login bug"));
    assert!(!looks_like_code_or_path("hello"));
}

#[test]
fn test_append_index_search_text_incremental_cap() {
    use crate::indexer::append_index_search_text;
    let mut s = String::new();
    append_index_search_text(&mut s, "alpha");
    append_index_search_text(&mut s, "beta");
    assert_eq!(s, "alpha beta");
    let big = "x".repeat(600_000);
    append_index_search_text(&mut s, &big);
    assert!(s.len() <= 500_000);
    assert!(s.starts_with("alpha beta "));
}

#[test]
fn test_normalize_tool_name() {
    assert_eq!(normalize_tool_name("bash"), "Bash");
    assert_eq!(normalize_tool_name("Bash"), "Bash");
    assert_eq!(normalize_tool_name("read_file"), "Read");
    assert_eq!(normalize_tool_name("edit_file"), "Edit");
    assert_eq!(normalize_tool_name("web_search"), "WebSearch");
    assert_eq!(
        normalize_tool_name("mcp__server__tool"),
        "mcp__server__tool"
    );
    assert_eq!(normalize_tool_name(""), "unknown");
    assert_eq!(normalize_tool_name("customTool"), "CustomTool");
    assert_eq!(normalize_tool_name("search_replace"), "Edit");
}

#[test]
fn test_collapse_whitespace_matches_split_whitespace_join() {
    let cases = [
        "Hello\nworld",
        "  padded  text  ",
        "mix\tof\n  whitespace",
        "single",
        "",
    ];
    for s in cases {
        let legacy = s
            .replace('\n', " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(collapse_whitespace(s), legacy, "mismatch for {s:?}");
    }
}

#[test]
fn test_extract_prompt() {
    let simple = serde_json::Value::String("Hello world".to_string());
    assert_eq!(extract_prompt(&simple), Some("Hello world".to_string()));

    let with_newlines = serde_json::Value::String("Hello\nworld".to_string());
    assert_eq!(
        extract_prompt(&with_newlines),
        Some("Hello world".to_string())
    );

    let starts_with_angle = serde_json::Value::String("<xml>".to_string());
    assert_eq!(extract_prompt(&starts_with_angle), None);

    let user_query = serde_json::Value::String(
        "<user_query>  <command-args>run tests</command-args>  </user_query>".to_string(),
    );
    assert_eq!(extract_prompt(&user_query), Some("run tests".to_string()));

    let blocks = serde_json::json!([
        { "type": "text", "text": "Hello" },
        { "type": "image", "url": "x" },
        { "type": "text", "text": "world" }
    ]);
    assert_eq!(extract_prompt(&blocks), Some("Hello world".to_string()));
}

#[test]
fn test_process_file_lines_small_file() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_lines");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("small.jsonl");
    fs::write(&file, "line1\nline2\nline3\n").unwrap();

    let mut lines = Vec::new();
    process_file_lines(&file, |l| lines.push(l.to_string())).unwrap();
    assert_eq!(lines, vec!["line1", "line2", "line3"]);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_read_index_cache_version_mismatch() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_cache");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("index.json");

    let cache_json = serde_json::json!({
        "_v": 5,
        "/tmp/test.jsonl": {
            "firstPrompt": "hello",
            "tools": [],
            "toolCounts": {},
            "chapters": 1,
            "totalTokens": 100,
            "inputTokens": 50,
            "outputTokens": 50,
            "cacheReadTokens": 0,
            "durationMs": 1000,
            "errors": 0,
            "files": 0,
            "commits": 0,
            "mtime": 1700000000000i64
        }
    });
    fs::write(&file, serde_json::to_string(&cache_json).unwrap()).unwrap();

    // Version 5 != 8, should return empty map
    let cache = read_index_cache(&file, 8);
    assert!(cache.is_empty());

    // Version 5 == 5, should return entry
    let cache = read_index_cache(&file, 5);
    assert_eq!(cache.len(), 1);
    assert_eq!(
        cache.get("/tmp/test.jsonl").unwrap().first_prompt,
        Some("hello".to_string())
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_claude_basic() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_claude");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("session.jsonl");

    let line1 = r#"{"type":"user","message":{"content":"Hello claude"}}"#;
    let line2 = r#"{"type":"assistant","message":{"model":"claude-3-opus","content":[{"type":"text","text":"Hi there"}]}}"#;
    fs::write(&file, format!("{}\n{}\n", line1, line2)).unwrap();

    let entry = index_claude(&file);
    assert_eq!(entry.first_prompt, Some("Hello claude".to_string()));
    assert_eq!(entry.model, Some("claude-3-opus".to_string()));
    assert_eq!(entry.chapters, 1);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("hello")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("hi")));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_cursor_real_format() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_cursor");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("cursor.jsonl");

    let line1 = r#"{"role":"user","message":{"content":[{"type":"text","text":"Hello cursor"}]}}"#;
    let line2 = r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Cursor reply"},{"type":"tool_use","name":"Read","input":{"path":"/tmp/test.txt"}}]}}"#;
    let line3 = r#"{"type":"turn_ended","status":"success"}"#;
    let line4 = r#"{"type":"turn_ended","status":"error","error":"User aborted request"}"#;
    fs::write(&file, format!("{}\n{}\n{}\n{}\n", line1, line2, line3, line4)).unwrap();

    let entry = index_cursor(&file);
    assert_eq!(entry.first_prompt, Some("Hello cursor".to_string()));
    assert_eq!(entry.model, Some("cursor".to_string()));
    assert_eq!(entry.chapters, 1);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("cursor")));
    assert!(entry.tools.contains(&"Read".to_string()));
    // Estimated tokens: input "Hello cursor" (12 chars → 3), output "Cursor reply" (12) + "Read"+20 (24) → 36 chars → 9
    assert_eq!(entry.input_tokens, 3);
    assert_eq!(entry.output_tokens, 9);
    assert_eq!(entry.total_tokens, 12);
    // Touched files come from Cursor's `path` tool input; errors from turn_ended status "error"
    assert_eq!(entry.files, 1);
    assert_eq!(entry.errors, 1);
    // Duration derives from file birthtime/mtime; the fixture is freshly written
    // (created == modified ≈ now), so the value is tiny but never negative.
    assert!(entry.duration_ms >= 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// Fact sd3: Cursor index reuses Claude-family JSONL indexing — cursor rows are
/// the Claude-family message shape ({"role":...,"message":{"content":[blocks]}})
/// and flow through the same shared machinery (extract_prompt, text-block and
/// tool_use extraction, tool-name normalization) as index_claude.
///
/// This test previously did not exist, so sd3's cargo filter matched zero tests
/// and passed vacuously; it now pins the reuse claim for real.
#[test]
fn test_index_cursor_reuses_claude_jsonl() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_cursor_reuses_claude");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("cursor.jsonl");

    // Claude-family content blocks inside cursor role rows: array-of-blocks user
    // content (extract_prompt), assistant text blocks, tool_use with a raw tool
    // name that the shared normalize_tool_name canonicalizes.
    let user = r#"{"role":"user","message":{"content":[{"type":"text","text":"Claude family prompt"}]}}"#;
    let assistant = r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Shared text block"},{"type":"tool_use","name":"StrReplace","input":{"path":"/tmp/f.txt"}}]}}"#;
    fs::write(&file, format!("{user}\n{assistant}\n")).unwrap();

    let entry = index_cursor(&file);
    // extract_prompt handled the Claude-family content array.
    assert_eq!(entry.first_prompt, Some("Claude family prompt".to_string()));
    assert_eq!(entry.chapters, 1);
    // TEXT_BLOCK_RE picked up the assistant text block into search text.
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("shared")));
    // Shared normalize_tool_name canonicalized the tool name (StrReplace → Edit),
    // exactly as index_claude would for the same block.
    assert_eq!(normalize_tool_name("StrReplace"), "Edit");
    assert_eq!(entry.tools, vec!["Edit".to_string()]);
    // Cursor `path` tool input tracked as a touched file.
    assert_eq!(entry.files, 1);

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// Fact ccrx: index_cursor_cloud consumes the session_meta first line — model,
/// ISO-8601 createdAt/updatedAt → durationMs = max(0, updatedAt − createdAt)
/// (0 when updatedAt is absent), firstPrompt fallback to session_meta.name —
/// and the meta line itself is never indexed.
#[test]
fn test_index_cursor_cloud_meta() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_cursor_cloud_meta");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();

    // Full meta: model, createdAt + updatedAt 10 minutes apart.
    let file = tmp_dir.join("bc-full.jsonl");
    let meta = r#"{"type":"session_meta","bcId":"bc-full","name":"Metaname unsearchable","status":"FINISHED","createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T00:10:00Z","model":"claude-4.5-opus"}"#;
    let user = r#"{"role":"user","message":{"content":[{"type":"text","text":"Hello cloud"}]}}"#;
    let assistant = r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Cloud reply"}]}}"#;
    fs::write(&file, format!("{meta}\n{user}\n{assistant}\n")).unwrap();

    let entry = index_cursor_cloud(&file);
    assert_eq!(entry.model, Some("claude-4.5-opus".to_string()));
    assert_eq!(entry.duration_ms, 10 * 60 * 1000);
    assert_eq!(entry.first_prompt, Some("Hello cloud".to_string()));
    assert_eq!(entry.chapters, 1);
    // The meta line is consumed, not indexed: its name must not reach search text.
    assert!(!entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("metaname")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("cloud")));

    // No model in meta -> literal "cursor-cloud" (fact ccmf). No updatedAt -> durationMs 0.
    // No user rows -> firstPrompt falls back to session_meta.name.
    let file2 = tmp_dir.join("bc-min.jsonl");
    let meta2 = r#"{"type":"session_meta","bcId":"bc-min","name":"Investigate flaky test","status":"RUNNING","createdAt":"2026-07-01T00:00:00Z"}"#;
    let assistant2 = r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Working on it"}]}}"#;
    fs::write(&file2, format!("{meta2}\n{assistant2}\n")).unwrap();

    let entry2 = index_cursor_cloud(&file2);
    assert_eq!(entry2.model, Some("cursor-cloud".to_string()));
    assert_eq!(entry2.duration_ms, 0);
    assert_eq!(
        entry2.first_prompt,
        Some("Investigate flaky test".to_string())
    );
    assert_eq!(entry2.chapters, 0);

    // updatedAt earlier than createdAt clamps to 0 (max(0, ...)).
    let file3 = tmp_dir.join("bc-clamp.jsonl");
    let meta3 = r#"{"type":"session_meta","bcId":"bc-clamp","name":"n","status":"FINISHED","createdAt":"2026-07-01T00:10:00Z","updatedAt":"2026-07-01T00:00:00Z"}"#;
    fs::write(&file3, format!("{meta3}\n")).unwrap();
    assert_eq!(index_cursor_cloud(&file3).duration_ms, 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// Fact ccrx: index_cursor_cloud reuses Cursor's Claude-family message-row
/// indexing and char-count token estimation unchanged, and a file whose first
/// line is NOT session_meta degrades to the local-cursor behavior.
#[test]
fn test_index_cursor_cloud_reuses_cursor_rows() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_cursor_cloud_rows");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();

    // Same message rows as test_index_cursor_real_format, preceded by a meta line.
    let meta = r#"{"type":"session_meta","bcId":"bc-rows","name":"Rows","status":"FINISHED","createdAt":"2026-07-01T00:00:00Z","updatedAt":"2026-07-01T01:00:00Z"}"#;
    let line1 = r#"{"role":"user","message":{"content":[{"type":"text","text":"Hello cursor"}]}}"#;
    let line2 = r#"{"role":"assistant","message":{"content":[{"type":"text","text":"Cursor reply"},{"type":"tool_use","name":"Read","input":{"path":"/tmp/test.txt"}}]}}"#;
    let line3 = r#"{"type":"turn_ended","status":"success"}"#;
    let line4 = r#"{"type":"turn_ended","status":"error","error":"User aborted request"}"#;

    let cloud_file = tmp_dir.join("bc-rows.jsonl");
    fs::write(
        &cloud_file,
        format!("{meta}\n{line1}\n{line2}\n{line3}\n{line4}\n"),
    )
    .unwrap();
    let cloud = index_cursor_cloud(&cloud_file);

    // Identical message rows through index_cursor (no meta line).
    let local_file = tmp_dir.join("local.jsonl");
    fs::write(&local_file, format!("{line1}\n{line2}\n{line3}\n{line4}\n")).unwrap();
    let local = index_cursor(&local_file);

    // Message-row indexing and cursor-style token estimation are byte-identical.
    assert_eq!(cloud.first_prompt, local.first_prompt);
    assert_eq!(cloud.chapters, local.chapters);
    assert_eq!(cloud.tools, local.tools);
    assert_eq!(cloud.tool_counts, local.tool_counts);
    assert_eq!(cloud.input_tokens, local.input_tokens);
    assert_eq!(cloud.output_tokens, local.output_tokens);
    assert_eq!(cloud.total_tokens, local.total_tokens);
    assert_eq!(cloud.files, local.files);
    assert_eq!(cloud.errors, local.errors);
    assert_eq!(cloud.commits, local.commits);
    assert_eq!(cloud.term_freqs, local.term_freqs);
    // Same expectations as test_index_cursor_real_format (estimation reused).
    assert_eq!(cloud.input_tokens, 3);
    assert_eq!(cloud.output_tokens, 9);
    assert_eq!(cloud.total_tokens, 12);
    // Deltas: meta-driven model and durationMs instead of state-db/file times.
    assert_eq!(cloud.model, Some("cursor-cloud".to_string()));
    assert_eq!(cloud.duration_ms, 60 * 60 * 1000);

    // First line NOT session_meta -> degrades to the local-cursor behavior.
    let degraded = index_cursor_cloud(&local_file);
    assert_eq!(degraded.model, local.model);
    assert_eq!(degraded.first_prompt, local.first_prompt);
    assert_eq!(degraded.chapters, local.chapters);
    assert_eq!(degraded.total_tokens, local.total_tokens);
    assert_eq!(degraded.term_freqs, local.term_freqs);
    assert!(degraded.duration_ms >= 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_regex_message_model() {
    let line = r#"{"type":"assistant","message":{"model":"claude-3-opus","content":[{"type":"text","text":"Hi"}]}}"#;
    let caps = MESSAGE_MODEL_RE
        .captures(line)
        .expect("MESSAGE_MODEL_RE should match message.model");
    assert_eq!(caps.get(1).map(|m| m.as_str()), Some("claude-3-opus"));
}

#[test]
fn test_regex_text_block() {
    let line = r#"{"type":"assistant","message":{"model":"claude-3-opus","content":[{"type":"text","text":"Hi there"}]}}"#;
    let mut found = false;
    for caps in TEXT_BLOCK_RE.captures_iter(line) {
        if let Some(text_raw) = caps.get(1) {
            let text = unescape_json_string(text_raw.as_str());
            eprintln!("DEBUG regex matched: '{}'", text);
            if text == "Hi there" {
                found = true;
            }
        }
    }
    assert!(
        found,
        "TEXT_BLOCK_RE should match 'Hi there' in assistant line"
    );
}

#[test]
fn test_index_claude_tool_use_and_tokens() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_claude_tools");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("session.jsonl");

    let line = r#"{"type":"assistant","message":{"model":"claude-3","content":[{"type":"tool_use","name":"bash","input":{"command":"git commit -m test"}},{"type":"text","text":"Done"}]},"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":20}}"#;
    fs::write(&file, format!("{}\n", line)).unwrap();

    let entry = index_claude(&file);
    assert_eq!(entry.model, Some("claude-3".to_string()));
    assert_eq!(entry.total_tokens, 170);
    assert_eq!(entry.input_tokens, 100);
    assert_eq!(entry.output_tokens, 50);
    assert_eq!(entry.cache_read_tokens, 20);
    assert!(entry.tools.contains(&"Bash".to_string()));
    assert_eq!(entry.commits, 1);
    assert_eq!(entry.tool_counts.get("Bash").copied().unwrap_or(0), 1i32);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_is_claude_index_skippable_line_skips_filler_rows() {
    assert!(is_claude_index_skippable_line(
        &serde_json::json!({ "type": "progress", "data": "x".repeat(200) }).to_string()
    ));
    assert!(is_claude_index_skippable_line(
        &serde_json::json!({ "type": "system", "subtype": "init", "data": "x" }).to_string()
    ));
    assert!(!is_claude_index_skippable_line(
        &serde_json::json!({ "type": "user", "message": { "content": "hi" } }).to_string()
    ));
    assert!(!is_claude_index_skippable_line(
        &serde_json::json!({ "sessionId": "s1", "type": "system" }).to_string()
    ));
    assert!(is_claude_index_skippable_line(
        &serde_json::json!({ "type": "tool_result", "content": "ok" }).to_string()
    ));
    assert!(!is_claude_index_skippable_line(
        &serde_json::json!({ "type": "tool_result", "stderr": "Error: boom" }).to_string()
    ));
    assert!(!is_claude_index_skippable_line(""));
}

#[test]
fn test_index_claude_ignores_progress_system_and_tool_result_filler_rows() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_claude_filler");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("filler.jsonl");

    let mut lines: Vec<String> = Vec::new();
    for i in 0..8000 {
        lines.push(serde_json::json!({ "type": "progress", "data": "x".repeat(800) }).to_string());
        if i % 3 == 0 {
            lines.push(
                serde_json::json!({
                    "type": "user",
                    "message": { "content": format!("claude prompt {i}") },
                    "timestamp": "2026-05-01T00:00:00Z"
                })
                .to_string(),
            );
        }
    }
    for i in 0..2000 {
        lines.push(
            serde_json::json!({ "type": "system", "subtype": "init", "data": "x".repeat(400) })
                .to_string(),
        );
        lines.push(
            serde_json::json!({
                "type": "tool_result",
                "tool_use_id": format!("t{i}"),
                "content": [{ "type": "text", "text": "x".repeat(200) }]
            })
            .to_string(),
        );
    }
    lines.push(
        serde_json::json!({
            "type": "user",
            "message": { "content": "claude filler compact probe" },
            "timestamp": "2026-05-01T01:00:00Z"
        })
        .to_string(),
    );
    fs::write(&file, lines.join("\n") + "\n").unwrap();

    let entry = index_claude(&file);
    assert_eq!(entry.first_prompt.as_deref(), Some("claude prompt 0"));
    assert!(entry.chapters > 0);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("claude")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(true, |m| !m.contains_key(&"x".repeat(200))));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_claude_ignores_pure_progress_filler_rows() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_claude_progress_only");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("progress.jsonl");

    let mut lines: Vec<String> = Vec::with_capacity(8001);
    for _ in 0..8000 {
        lines.push(r#"{"type":"progress","data":"x"}"#.to_string());
    }
    lines.push(
        serde_json::json!({
            "type": "user",
            "message": { "content": "only indexed prompt" },
            "timestamp": "2026-05-01T00:00:00Z"
        })
        .to_string(),
    );
    fs::write(&file, lines.join("\n") + "\n").unwrap();

    let entry = index_claude(&file);
    assert_eq!(entry.first_prompt.as_deref(), Some("only indexed prompt"));
    assert_eq!(entry.chapters, 1);

    let iters = 20u32;
    let start = std::time::Instant::now();
    for _ in 0..iters {
        let e = index_claude(&file);
        assert_eq!(e.chapters, 1);
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
    eprintln!("index_claude progress-only filler: {ms:.2}ms/op (8k short rows, {iters} iters)");
    assert_perf_ms(ms, 15.0, "index_claude/op with 8k progress filler");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_codex_basic() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_codex");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("rollout-test.jsonl");

    let meta =
        serde_json::json!({ "type": "session_meta", "payload": { "model_provider": "openai" } });
    let turn = serde_json::json!({
        "type": "turn_context",
        "payload": { "model": "gpt-4", "last_token_usage": { "input_tokens": 10, "output_tokens": 5 } }
    });
    let response = serde_json::json!({
        "type": "response_item",
        "payload": {
            "role": "assistant",
            "content": [
                { "type": "function_call", "name": "bash", "arguments": "{\"command\":\"git commit\"}" },
                { "type": "output_text", "text": "Done" }
            ]
        }
    });
    let event = serde_json::json!({
        "type": "event_msg",
        "payload": { "type": "user_message", "message": "Hello codex" }
    });
    fs::write(
        &file,
        format!("{}\n{}\n{}\n{}\n", meta, turn, response, event),
    )
    .unwrap();

    let entry = index_codex(&file);
    assert_eq!(entry.model, Some("openai".to_string()));
    assert_eq!(entry.total_tokens, 15);
    assert_eq!(entry.input_tokens, 10);
    assert_eq!(entry.output_tokens, 5);
    assert!(entry.tools.contains(&"Bash".to_string()));
    assert_eq!(entry.commits, 1);
    assert_eq!(entry.chapters, 1);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_codex_skips_injected_agents_md_first_user_item() {
    // Real codex rollouts open with a user response_item holding only the
    // injected instruction context (AGENTS.md markdown + XML-wrapped blocks);
    // the true prompt arrives later as an event_msg user_message plus its own
    // response_item. first_prompt must be the true prompt (r8 dialect fix,
    // mirrors Node isCodexDisplayableUserText).
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_codex_agents_md");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("rollout-agents.jsonl");

    let meta =
        serde_json::json!({ "type": "session_meta", "payload": { "model_provider": "openai" } });
    let injected = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": "user",
            "content": [
                { "type": "input_text", "text": "# AGENTS.md instructions for /Users/dev/proj\n\n<INSTRUCTIONS>injected</INSTRUCTIONS>" },
                { "type": "input_text", "text": "<environment_context>\n  <cwd>/Users/dev/proj</cwd>\n</environment_context>" }
            ]
        }
    });
    let event = serde_json::json!({
        "type": "event_msg",
        "payload": { "type": "user_message", "message": "the real codex prompt" }
    });
    let real_user = serde_json::json!({
        "type": "response_item",
        "payload": {
            "type": "message",
            "role": "user",
            "content": [ { "type": "input_text", "text": "the real codex prompt" } ]
        }
    });
    fs::write(
        &file,
        format!("{}\n{}\n{}\n{}\n", meta, injected, event, real_user),
    )
    .unwrap();

    let entry = index_codex(&file);
    assert_eq!(entry.first_prompt, Some("the real codex prompt".to_string()));
    assert!(
        entry
            .term_freqs
            .as_ref()
            .map_or(false, |m| m.contains_key("prompt")),
        "the real prompt must be indexed"
    );
    assert!(
        entry
            .term_freqs
            .as_ref()
            .map_or(true, |m| !m.contains_key("agents")),
        "injected AGENTS.md text must not enter the search index"
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_codex_token_count_total_token_usage() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_codex_token_count");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("rollout-token-count.jsonl");

    let token_count = serde_json::json!({
        "type": "event_msg",
        "payload": {
            "type": "token_count",
            "info": {
                "total_token_usage": {
                    "input_tokens": 100,
                    "output_tokens": 40,
                    "cached_input_tokens": 12
                }
            }
        }
    });
    let turn = serde_json::json!({
        "type": "turn_context",
        "payload": {
            "model": "gpt-5-codex",
            "last_token_usage": { "input_tokens": 50, "output_tokens": 10 }
        }
    });
    fs::write(&file, format!("{}\n{}\n", token_count, turn)).unwrap();

    let entry = index_codex(&file);
    assert_eq!(entry.input_tokens, 100);
    assert_eq!(entry.output_tokens, 40);
    assert_eq!(entry.total_tokens, 140);
    assert_eq!(entry.cache_read_tokens, 12);
    assert_eq!(entry.model, Some("gpt-5-codex".to_string()));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_codex_skips_irrelevant_lines() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_codex_skip");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("rollout-skip.jsonl");

    let noise = r#"{"noise":"padding without codex event types"}"#;
    let ts_noise = r#"{"timestamp":"2026-06-03T09:00:00.000Z","noise":"ts only"}"#;
    let meta =
        serde_json::json!({ "type": "session_meta", "payload": { "model_provider": "openai" } });
    let event = serde_json::json!({
        "type": "event_msg",
        "payload": { "type": "user_message", "message": "indexed codex line" }
    });
    fs::write(
        &file,
        format!("{}\n{}\n{}\n{}\n", noise, ts_noise, meta, event),
    )
    .unwrap();

    let entry = index_codex(&file);
    assert_eq!(entry.model, Some("openai".to_string()));
    assert_eq!(entry.chapters, 1);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("indexed")));
    assert_eq!(entry.duration_ms, 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_is_codex_index_skippable_line_skips_stream_filler() {
    assert!(is_codex_index_skippable_line(
        r#"{"type":"stream_chunk","payload":{"text":"x"}}"#
    ));
    assert!(is_codex_index_skippable_line(&format!(
        r#"{{"type":"stream_chunk","payload":{{"text":"{}"}}}}"#,
        "x".repeat(400)
    )));
    assert!(!is_codex_index_skippable_line(
        r#"{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}"#
    ));
}

#[test]
fn test_index_codex_ignores_stream_chunk_filler_rows() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_codex_stream_chunk");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("rollout-filler.jsonl");

    let mut lines: Vec<String> = vec![serde_json::json!({
        "type": "session_meta",
        "payload": { "model_provider": "openai" },
        "timestamp": "2026-05-01T00:00:00Z"
    })
    .to_string()];
    for _ in 0..8000 {
        lines.push(
            serde_json::json!({ "type": "stream_chunk", "payload": { "text": "x".repeat(400) } })
                .to_string(),
        );
    }
    lines.push(
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": "codex stream_chunk compact probe" },
            "timestamp": "2026-05-01T00:01:00Z"
        })
        .to_string(),
    );
    fs::write(&file, lines.join("\n") + "\n").unwrap();

    let entry = index_codex(&file);
    assert_eq!(entry.model, Some("openai".to_string()));
    assert_eq!(
        entry.first_prompt.as_deref(),
        Some("codex stream_chunk compact probe")
    );
    assert_eq!(entry.chapters, 1);
    assert_eq!(entry.duration_ms, 60000);

    let iters = 12u32;
    let start = std::time::Instant::now();
    for _ in 0..iters {
        let e = index_codex(&file);
        assert_eq!(
            e.first_prompt.as_deref(),
            Some("codex stream_chunk compact probe")
        );
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
    eprintln!("index_codex stream_chunk filler: {ms:.2}ms/op (8k rows, {iters} iters)");
    assert_perf_ms(ms, 35.0, "index_codex/op with 8k stream_chunk filler");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_factory_basic() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_factory");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("session.jsonl");

    let line1 = serde_json::json!({
        "type": "message",
        "message": { "role": "user", "content": [{ "type": "text", "text": "Hello factory" }] }
    });
    let line2 = serde_json::json!({
        "type": "message",
        "message": { "role": "assistant", "content": [{ "type": "text", "text": "Hi there" }] }
    });
    fs::write(&file, format!("{}\n{}\n", line1, line2)).unwrap();

    let entry = index_factory(&file);
    assert_eq!(entry.first_prompt, Some("Hello factory".to_string()));
    assert_eq!(entry.chapters, 1);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("hello")));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_factory_rounds_estimated_tokens() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_factory_round");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("factory-round.jsonl");
    let line = serde_json::json!({
        "type": "message",
        "message": { "role": "user", "content": [{ "type": "text", "text": "abcdef" }] }
    });
    fs::write(&file, format!("{}\n", line)).unwrap();

    let entry = index_factory(&file);
    assert_eq!(entry.input_tokens, 2);
    assert_eq!(entry.output_tokens, 0);
    assert_eq!(entry.total_tokens, 2);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_is_factory_index_skippable_line_skips_tool_result_filler() {
    assert!(is_factory_index_skippable_line(
        &serde_json::json!({ "type": "tool_result", "content": "ok" }).to_string()
    ));
    assert!(!is_factory_index_skippable_line(
        &serde_json::json!({
            "type": "message",
            "message": { "role": "user", "content": [{ "type": "text", "text": "hi" }] }
        })
        .to_string()
    ));
    assert!(!is_factory_index_skippable_line(""));
}

#[test]
fn test_index_factory_counts_embedded_errors_only_on_message_lines() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_factory_embedded_errors");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("errors.jsonl");

    let standalone = serde_json::json!({
        "type": "tool_result",
        "tool_use_id": "filler",
        "is_error": true,
        "content": [{ "type": "text", "text": "Error: standalone filler must not count" }]
    });
    let embedded = serde_json::json!({
        "type": "message",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "is_error": true,
                "content": [{ "type": "text", "text": "Error: embedded factory failure" }]
            }]
        }
    });
    fs::write(
        &file,
        format!(
            "{}\n{}\n",
            serde_json::to_string(&standalone).unwrap(),
            serde_json::to_string(&embedded).unwrap()
        ),
    )
    .unwrap();

    let entry = index_factory(&file);
    assert_eq!(entry.errors, 1);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_factory_ignores_tool_result_filler_rows() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_factory_filler");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("filler.jsonl");

    let mut lines: Vec<String> = Vec::with_capacity(8001);
    for i in 0..8000 {
        lines.push(
            serde_json::json!({
                "type": "tool_result",
                "tool_use_id": format!("t{i}"),
                "content": [{ "type": "text", "text": "x".repeat(200) }]
            })
            .to_string(),
        );
        if i % 3 == 0 {
            lines.push(
                serde_json::json!({
                    "type": "message",
                    "message": {
                        "role": "user",
                        "content": [{ "type": "text", "text": format!("factory prompt {i}") }]
                    }
                })
                .to_string(),
            );
        }
    }
    fs::write(&file, lines.join("\n") + "\n").unwrap();

    let entry = index_factory(&file);
    assert_eq!(entry.first_prompt.as_deref(), Some("factory prompt 0"));
    assert!(entry.chapters > 0);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(true, |m| !m.contains_key(&"x".repeat(200))));

    let iters = 12u32;
    let start = std::time::Instant::now();
    for _ in 0..iters {
        let e = index_factory(&file);
        assert!(e.chapters > 0);
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
    eprintln!("index_factory tool_result filler: {ms:.2}ms/op (8k rows, {iters} iters)");
    assert_perf_ms(ms, 120.0, "index_factory/op with 8k tool_result filler");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_factory_skips_non_message_lines() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_factory_skip");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("factory-skip.jsonl");

    let noise = r#"{"noise":"padding without message type"}"#;
    let tool_result = serde_json::json!({
        "type": "tool_result",
        "content": "user assistant role words in payload only"
    });
    let user_msg = serde_json::json!({
        "type": "message",
        "message": { "role": "user", "content": [{ "type": "text", "text": "indexed factory line" }] }
    });
    fs::write(
        &file,
        format!(
            "{}\n{}\n{}\n",
            noise,
            serde_json::to_string(&tool_result).unwrap(),
            serde_json::to_string(&user_msg).unwrap()
        ),
    )
    .unwrap();

    let entry = index_factory(&file);
    assert_eq!(entry.first_prompt, Some("indexed factory line".to_string()));
    assert_eq!(entry.chapters, 1);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("indexed")));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_is_grok_chat_indexed_line_skips_system_filler() {
    assert!(!is_grok_chat_indexed_line(
        r#"{"type":"system","content":"x"}"#
    ));
    assert!(!is_grok_chat_indexed_line(&format!(
        r#"{{"type":"system","content":"{}"}}"#,
        "x".repeat(800)
    )));
    assert!(is_grok_chat_indexed_line(
        r#"{"type":"user","content":"hi"}"#
    ));
    assert!(is_grok_chat_indexed_line(
        r#"{"type":"tool_result","content":"ok"}"#
    ));
}

#[test]
fn test_is_grok_chat_indexed_line_system_prefix_fast_reject_perf() {
    let filler = format!(r#"{{"type":"system","content":"{}"}}"#, "x".repeat(800));
    let lines: Vec<String> = (0..8000).map(|_| filler.clone()).collect();
    let iters = 20u32;
    let start = std::time::Instant::now();
    for _ in 0..iters {
        for line in &lines {
            assert!(!is_grok_chat_indexed_line(line));
        }
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
    assert_perf_ms(ms, 0.6, "is_grok_chat_indexed_line/op on 8k system filler");
}

#[test]
fn test_index_grok_ignores_system_filler_rows_perf() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_grok_chat_filler");
    let session = tmp_dir.join("session-1");
    fs::create_dir_all(&session).unwrap();

    let filler = serde_json::json!({ "type": "system", "content": "x".repeat(800) });
    let mut lines: Vec<String> = (0..8000)
        .map(|_| serde_json::to_string(&filler).unwrap())
        .collect();
    lines.push(
        serde_json::json!({ "type": "user", "content": "grok chat compact probe" }).to_string(),
    );
    lines.push(
        serde_json::json!({
            "type": "assistant",
            "content": "answer",
            "tool_calls": [{ "id": "b1", "name": "bash", "arguments": "{}" }]
        })
        .to_string(),
    );
    lines.push(
        serde_json::json!({
            "type": "tool_result",
            "tool_call_id": "b1",
            "content": "ok"
        })
        .to_string(),
    );
    fs::write(session.join("chat_history.jsonl"), lines.join("\n") + "\n").unwrap();
    fs::write(
        session.join("events.jsonl"),
        serde_json::json!({
            "type": "turn_started",
            "ts": "2026-05-01T00:00:00Z",
            "model_id": "grok-2"
        })
        .to_string()
            + "\n",
    )
    .unwrap();

    let entry = index_grok(session.to_str().unwrap());
    assert_eq!(
        entry.first_prompt.as_deref(),
        Some("grok chat compact probe")
    );
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("grok")));
    assert_eq!(entry.tool_counts.get("Bash").copied().unwrap_or(0), 1i32);

    let iters = 12u32;
    let start = std::time::Instant::now();
    for _ in 0..iters {
        let e = index_grok(session.to_str().unwrap());
        assert_eq!(e.first_prompt.as_deref(), Some("grok chat compact probe"));
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
    eprintln!("index_grok system chat filler: {ms:.2}ms/op (8k rows, {iters} iters)");
    assert_perf_ms(ms, 320.0, "index_grok/op with 8k system chat filler");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_is_grok_events_indexed_line_skips_stream_filler() {
    assert!(!is_grok_events_indexed_line(
        r#"{"type":"stream_chunk","data":"x"}"#
    ));
    assert!(!is_grok_events_indexed_line(&format!(
        r#"{{"type":"stream_chunk","payload":"{}"}}"#,
        "x".repeat(400)
    )));
    assert!(is_grok_events_indexed_line(
        r#"{"type":"turn_started","ts":"2026-01-01T00:00:00Z"}"#
    ));
    assert!(is_grok_events_indexed_line(
        r#"{"type":"tool_completed","outcome":"error"}"#
    ));
}

#[test]
fn test_index_grok_ignores_stream_chunk_filler_rows() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_grok_events_filler");
    let session = tmp_dir.join("session-1");
    fs::create_dir_all(&session).unwrap();

    let mut lines: Vec<String> = (0..8000)
        .map(|_| {
            serde_json::json!({ "type": "stream_chunk", "payload": "x".repeat(400) }).to_string()
        })
        .collect();
    lines.push(
        serde_json::json!({
            "type": "turn_started",
            "ts": "2026-05-01T00:00:00Z",
            "model_id": "grok-2"
        })
        .to_string(),
    );
    lines.push(
        serde_json::json!({
            "type": "tool_started",
            "ts": "2026-05-01T00:01:00Z",
            "tool_name": "read"
        })
        .to_string(),
    );
    lines.push(
        serde_json::json!({
            "type": "tool_completed",
            "ts": "2026-05-01T00:02:00Z",
            "tool_name": "read",
            "outcome": "success"
        })
        .to_string(),
    );
    fs::write(session.join("events.jsonl"), lines.join("\n") + "\n").unwrap();
    fs::write(
        session.join("chat_history.jsonl"),
        r#"{"type":"user","content":"grok events compact probe"}"#,
    )
    .unwrap();

    let entry = index_grok(session.to_str().unwrap());
    assert_eq!(entry.model, Some("grok-2".to_string()));
    assert!(entry.tools.contains(&"Read".to_string()));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("grok")));

    let iters = 12u32;
    let start = std::time::Instant::now();
    for _ in 0..iters {
        let e = index_grok(session.to_str().unwrap());
        assert_eq!(e.model.as_deref(), Some("grok-2"));
    }
    let ms = start.elapsed().as_secs_f64() * 1000.0 / f64::from(iters);
    assert_perf_ms(ms, 60.0, "index_grok/op with 8k stream_chunk filler");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_grok_basic() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_grok");
    let session = tmp_dir.join("session-1");
    fs::create_dir_all(&session).unwrap();

    let ctx = serde_json::json!({ "model_id": "grok-2" });
    fs::write(
        session.join("prompt_context.json"),
        serde_json::to_string(&ctx).unwrap(),
    )
    .unwrap();

    let events = [
        serde_json::json!({
            "type": "turn_started",
            "model_id": "grok-2",
            "ts": "2024-01-01T00:00:00Z"
        }),
        serde_json::json!({
            "type": "tool_started",
            "tool_name": "bash",
            "ts": "2024-01-01T00:00:01Z"
        }),
        serde_json::json!({
            "type": "tool_completed",
            "tool_name": "bash",
            "outcome": "success",
            "ts": "2024-01-01T00:00:02Z"
        }),
    ];
    fs::write(
        session.join("events.jsonl"),
        events
            .iter()
            .map(|e| serde_json::to_string(e).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n",
    )
    .unwrap();

    let chat1 = serde_json::json!({ "type": "user", "content": "Hello grok" });
    let chat2 = serde_json::json!({
        "type": "assistant",
        "content": "Hi there",
        "tool_calls": [{ "id": "b1", "name": "bash", "arguments": "{}" }]
    });
    let chat3 = serde_json::json!({
        "type": "tool_result",
        "tool_call_id": "b1",
        "content": "ok"
    });
    fs::write(
        session.join("chat_history.jsonl"),
        format!("{}\n{}\n{}\n", chat1, chat2, chat3),
    )
    .unwrap();

    let entry = index_grok(session.to_str().unwrap());
    assert_eq!(entry.model, Some("grok-2".to_string()));
    assert_eq!(entry.first_prompt, Some("Hello grok".to_string()));
    assert_eq!(entry.chapters, 1);
    assert!(entry.tools.contains(&"Bash".to_string()));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("hello")));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_build_index_with_cache_reuse() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_build_index");
    fs::create_dir_all(&tmp_dir).unwrap();
    let cache_file = tmp_dir.join("index.json");

    // Write a cache entry with matching mtime
    let cache_json = serde_json::json!({
        "_v": 8,
        "/tmp/stale.jsonl": {
            "firstPrompt": "stale",
            "tools": [],
            "toolCounts": {},
            "chapters": 1,
            "totalTokens": 100,
            "inputTokens": 50,
            "outputTokens": 50,
            "cacheReadTokens": 0,
            "durationMs": 1000,
            "errors": 0,
            "files": 0,
            "commits": 0,
            "mtime": 1700000000000i64
        }
    });
    fs::write(&cache_file, serde_json::to_string(&cache_json).unwrap()).unwrap();

    // Create a real session file for one session
    let session_dir = tmp_dir.join("real_session");
    fs::create_dir_all(&session_dir).unwrap();
    let real_file = session_dir.join("session.jsonl");
    let line = serde_json::json!({
        "type": "user",
        "message": { "content": "Hello world" }
    });
    fs::write(&real_file, format!("{}\n", line)).unwrap();

    let sessions = vec![
        Session {
            path: "/tmp/stale.jsonl".to_string(),
            project: "test".to_string(),
            file: "stale.jsonl".to_string(),
            source: "claude".to_string(),
            size: 100,
            mtime: chrono::DateTime::from_timestamp(1700000000, 0).unwrap(),
            parent_session: None,
            title: None,
        },
        Session {
            path: real_file.to_str().unwrap().to_string(),
            project: "test".to_string(),
            file: "session.jsonl".to_string(),
            source: "claude".to_string(),
            size: 100,
            mtime: chrono::DateTime::from_timestamp(1700000001, 0).unwrap(),
            parent_session: None,
            title: None,
        },
    ];

    let result = build_index(&cache_file, 8, &sessions, &std::collections::HashSet::new())
        .expect("known sources must index without error");
    assert_eq!(result.len(), 2);

    // Stale entry should be reused (mtime matches 1700000000000)
    let stale = result.get("/tmp/stale.jsonl").unwrap();
    assert_eq!(stale.first_prompt, Some("stale".to_string()));

    // Real entry should be freshly indexed
    let real = result.get(real_file.to_str().unwrap()).unwrap();
    assert_eq!(real.first_prompt, Some("Hello world".to_string()));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_build_index_reparses_search_stale_cache_hit_for_term_freqs() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!(
        "tracequest_test_build_index_search_stale_{}_{}",
        std::process::id(),
        unique
    ));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();
    let cache_file = tmp_dir.join("index.json");
    let session_file = tmp_dir.join("session.jsonl");
    let mtime = chrono::DateTime::from_timestamp(1_700_000_000, 0).unwrap();
    let mtime_ms = mtime.timestamp_millis();

    fs::write(
        &session_file,
        r#"{"type":"user","message":{"content":"search stale fresh needle"}}"#,
    )
    .unwrap();
    let cache_json = serde_json::json!({
        "_v": 8,
        session_file.to_string_lossy().to_string(): {
            "firstPrompt": "cached prompt",
            "tools": [],
            "toolCounts": {},
            "chapters": 1,
            "totalTokens": 0,
            "inputTokens": 0,
            "outputTokens": 0,
            "cacheReadTokens": 0,
            "durationMs": 0,
            "errors": 0,
            "files": 0,
            "commits": 0,
            "mtime": mtime_ms
        }
    });
    fs::write(&cache_file, serde_json::to_string(&cache_json).unwrap()).unwrap();

    let session = Session {
        path: session_file.to_string_lossy().to_string(),
        project: "test".to_string(),
        file: "session.jsonl".to_string(),
        source: "claude".to_string(),
        size: 100,
        mtime,
        parent_session: None,
        title: None,
    };

    let cached = build_index(
        &cache_file,
        8,
        std::slice::from_ref(&session),
        &HashSet::new(),
    )
    .expect("known sources must index without error");
    let cached_entry = cached.get(&session.path).unwrap();
    assert_eq!(cached_entry.first_prompt, Some("cached prompt".to_string()));
    assert!(
        cached_entry.term_freqs.is_none(),
        "mtime-cache-reused entries are metadata only"
    );

    let rebuilt = build_index(
        &cache_file,
        8,
        std::slice::from_ref(&session),
        &HashSet::from([session.path.clone()]),
    )
    .expect("known sources must index without error");
    let rebuilt_entry = rebuilt.get(&session.path).unwrap();
    assert_eq!(
        rebuilt_entry.first_prompt,
        Some("search stale fresh needle".to_string())
    );
    assert!(
        rebuilt_entry
            .term_freqs
            .as_ref()
            .map_or(false, |terms| terms.contains_key("needle")),
        "search-stale cache hits must be re-parsed with fresh termFreqs"
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_opencode_basic() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_opencode_index");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();
    let db_path = tmp_dir.join("opencode.db");

    let conn = Connection::open(&db_path).unwrap();
    conn.execute(
        "CREATE TABLE IF NOT EXISTS session (
            id TEXT PRIMARY KEY,
            title TEXT,
            directory TEXT,
            version INTEGER,
            time_created TEXT,
            time_updated TEXT
        )",
        [],
    )
    .unwrap();
    conn.execute(
        "CREATE TABLE IF NOT EXISTS message (
            id INTEGER PRIMARY KEY,
            session_id TEXT,
            data TEXT,
            time_created TEXT
        )",
        [],
    )
    .unwrap();
    conn.execute(
        "CREATE TABLE IF NOT EXISTS part (
            id INTEGER PRIMARY KEY,
            message_id INTEGER,
            data TEXT
        )",
        [],
    )
    .unwrap();

    conn.execute(
        "INSERT INTO session (id, title, directory, version, time_created, time_updated)
         VALUES ('sess-1', 'My Title', '/home/dev/code/tracequest', 1, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z')",
        [],
    )
    .unwrap();

    let msg_data = r#"{"role":"user","modelID":"gpt-4o"}"#;
    conn.execute(
        "INSERT INTO message (session_id, data, time_created) VALUES ('sess-1', ?, '2024-01-01T00:00:00Z')",
        [msg_data],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO message (session_id, data, time_created) VALUES ('sess-1', ?, '2024-01-01T00:10:00Z')",
        [r#"{"role":"assistant","modelID":"gpt-4o"}"#],
    )
    .unwrap();
    let msg_id: i64 = conn
        .query_row(
            "SELECT id FROM message WHERE session_id = 'sess-1' LIMIT 1",
            [],
            |row| row.get(0),
        )
        .unwrap();

    let part_data = r#"{"type":"text","text":"Hello opencode"}"#;
    conn.execute(
        "INSERT INTO part (message_id, data) VALUES (?, ?)",
        [msg_id.to_string(), part_data.to_string()],
    )
    .unwrap();

    let tool_part = r#"{"type":"tool","tool":"bash"}"#;
    conn.execute(
        "INSERT INTO part (message_id, data) VALUES (?, ?)",
        [msg_id.to_string(), tool_part.to_string()],
    )
    .unwrap();

    let error_part = r#"{"type":"tool","status":"error"}"#;
    conn.execute(
        "INSERT INTO part (message_id, data) VALUES (?, ?)",
        [msg_id.to_string(), error_part.to_string()],
    )
    .unwrap();

    std::env::set_var("TRACEQUEST_OPCODE_DB", db_path.to_str().unwrap());

    let session = Session {
        path: "opencode://sess-1".to_string(),
        project: "tracequest".to_string(),
        file: "sess-1".to_string(),
        source: "opencode".to_string(),
        size: 3072,
        mtime: chrono::DateTime::from_timestamp(1704153600, 0).unwrap(),
        parent_session: None,
        title: Some("My Title".to_string()),
    };

    let entry = index_opencode(&session);
    assert_eq!(entry.first_prompt, Some("Hello opencode".to_string()));
    assert_eq!(entry.model, Some("gpt-4o".to_string()));
    assert_eq!(entry.chapters, 1);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("hello")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| !m.contains_key("my")));
    assert!(entry.tools.contains(&"Bash".to_string()));
    assert_eq!(entry.tool_counts.get("Bash").copied().unwrap_or(0), 1i32);
    assert_eq!(entry.errors, 1);
    assert_eq!(entry.duration_ms, 600_000);

    let _ = std::env::remove_var("TRACEQUEST_OPCODE_DB");
    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_opencode_step_finish_tokens() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_opencode_step_finish");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();
    let db_path = tmp_dir.join("opencode.db");

    let conn = Connection::open(&db_path).unwrap();
    conn.execute(
        "CREATE TABLE message (id INTEGER PRIMARY KEY, session_id TEXT, data TEXT, time_created TEXT)",
        [],
    )
    .unwrap();
    conn.execute(
        "CREATE TABLE part (id INTEGER PRIMARY KEY, message_id INTEGER, data TEXT)",
        [],
    )
    .unwrap();

    let msg_data = r#"{"role":"assistant","modelID":"gpt-4o"}"#;
    conn.execute(
        "INSERT INTO message (session_id, data, time_created) VALUES ('tok-1', ?, '2024-01-01T00:00:00Z')",
        [msg_data],
    )
    .unwrap();
    let msg_id: i64 = conn
        .query_row("SELECT id FROM message LIMIT 1", [], |row| row.get(0))
        .unwrap();

    let step_finish = r#"{"type":"step-finish","tokens":{"input":120,"output":40,"cache":{"read":30,"write":0}}}"#;
    conn.execute(
        "INSERT INTO part (message_id, data) VALUES (?, ?)",
        [msg_id.to_string(), step_finish.to_string()],
    )
    .unwrap();

    std::env::set_var("TRACEQUEST_OPCODE_DB", db_path.to_str().unwrap());

    let session = Session {
        path: "opencode://tok-1".to_string(),
        project: "tracequest".to_string(),
        file: "tok-1".to_string(),
        source: "opencode".to_string(),
        size: 1024,
        mtime: chrono::DateTime::from_timestamp(1704153600, 0).unwrap(),
        parent_session: None,
        title: None,
    };

    let entry = index_opencode(&session);
    assert_eq!(entry.input_tokens, 150);
    assert_eq!(entry.output_tokens, 40);
    assert_eq!(entry.cache_read_tokens, 30);
    assert_eq!(entry.total_tokens, 190);

    let _ = std::env::remove_var("TRACEQUEST_OPCODE_DB");
    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_grok_rounds_estimated_tokens() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_grok_round");
    let session = tmp_dir.join("session-round");
    fs::create_dir_all(&session).unwrap();

    let chat = serde_json::json!({ "type": "user", "content": "abcdef" });
    fs::write(session.join("chat_history.jsonl"), format!("{}\n", chat)).unwrap();

    let entry = index_grok(session.to_str().unwrap());
    assert_eq!(entry.input_tokens, 2);
    assert_eq!(entry.output_tokens, 0);
    assert_eq!(entry.total_tokens, 2);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_write_index_cache() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_write_cache");
    fs::create_dir_all(&tmp_dir).unwrap();
    let cache_file = tmp_dir.join("index.json");

    let mut entries = HashMap::new();
    entries.insert(
        "/tmp/test.jsonl".to_string(),
        IndexEntry {
            first_prompt: Some("hello".to_string()),
            model: Some("claude-3".to_string()),
            term_freqs: Some(std::collections::HashMap::new()),
            tools: vec!["Bash".to_string()],
            tool_counts: [("Bash".to_string(), 1)].into_iter().collect(),
            chapters: 1,
            total_tokens: 100,
            input_tokens: 50,
            output_tokens: 50,
            cache_read_tokens: 0,
            duration_ms: 1000,
            errors: 0,
            files: 0,
            commits: 0,
            mtime: 1700000000000i64,
        },
    );

    write_index_cache(&cache_file, 8, &entries).unwrap();

    let cached = read_index_cache(&cache_file, 8);
    assert_eq!(cached.len(), 1);
    assert_eq!(
        cached.get("/tmp/test.jsonl").unwrap().first_prompt,
        Some("hello".to_string())
    );
    assert_eq!(
        cached
            .get("/tmp/test.jsonl")
            .unwrap()
            .tool_counts
            .get("Bash")
            .copied()
            .unwrap_or(0),
        1i32
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_build_index_keeps_term_freqs_for_stdout_but_cache_omits_them() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_sidecar_index_termfreq_contract");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();
    let session_file = tmp_dir.join("session.jsonl");
    let cache_file = tmp_dir.join("index.json");
    fs::write(
        &session_file,
        concat!(
            r#"{"type":"user","message":{"content":"metadata prompt only"}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"stdout-only-sidecar-needle body"}]}}"#,
            "\n",
        ),
    )
    .unwrap();

    let session = Session {
        path: session_file.to_string_lossy().to_string(),
        project: "termfreq-contract".to_string(),
        file: "session.jsonl".to_string(),
        source: "claude".to_string(),
        size: 0,
        mtime: chrono::Utc::now(),
        parent_session: None,
        title: None,
    };
    let entries = build_index(
        &cache_file,
        8,
        std::slice::from_ref(&session),
        &HashSet::from([session.path.clone()]),
    )
    .expect("known sources must index without error");
    let entry = entries.get(&session.path).unwrap();
    let term_freqs = entry
        .term_freqs
        .as_ref()
        .expect("sidecar stdout entries must include transient termFreqs");
    assert!(
        term_freqs.contains_key("needle"),
        "termFreqs must include searchable content for SearchIndex insertion"
    );
    let stdout_json = serde_json::to_value(&entries).unwrap();
    let stdout_entry = stdout_json.get(&session.path).unwrap();
    assert!(
        stdout_entry.get("termFreqs").is_some(),
        "sidecar stdout entries must serialize termFreqs"
    );
    assert!(
        stdout_entry.get("searchText").is_none(),
        "sidecar stdout entries must not serialize searchText"
    );

    write_index_cache(&cache_file, 8, &entries).unwrap();
    let raw_cache = fs::read_to_string(&cache_file).unwrap();
    let cache_json: serde_json::Value = serde_json::from_str(&raw_cache).unwrap();
    assert!(
        cache_json
            .get(&session.path)
            .and_then(|entry| entry.get("termFreqs"))
            .is_none(),
        "index.json must not persist termFreqs"
    );
    assert!(
        !raw_cache.contains("stdout-only-sidecar-needle"),
        "index.json must not persist raw searchable text"
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_grok_ignores_system_filler_rows() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_grok_filler");
    let session = tmp_dir.join("session-1");
    fs::create_dir_all(&session).unwrap();

    let filler = serde_json::json!({ "type": "system", "content": "x".repeat(800) });
    let user = serde_json::json!({ "type": "user", "content": "real prompt" });
    let assistant = serde_json::json!({
        "type": "assistant",
        "content": "answer",
        "tool_calls": [{ "id": "b1", "name": "bash", "arguments": "{}" }]
    });
    let tool_result = serde_json::json!({
        "type": "tool_result",
        "tool_call_id": "b1",
        "content": "ok"
    });
    fs::write(
        session.join("chat_history.jsonl"),
        format!(
            "{}\n{}\n{}\n{}\n{}\n",
            serde_json::to_string(&filler).unwrap(),
            serde_json::to_string(&filler).unwrap(),
            user,
            assistant,
            tool_result
        ),
    )
    .unwrap();

    let entry = index_grok(session.to_str().unwrap());
    assert_eq!(entry.first_prompt.as_deref(), Some("real prompt"));
    assert_eq!(entry.chapters, 1);
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("real")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("answer")));
    assert_eq!(entry.tool_counts.get("Bash").copied().unwrap_or(0), 1i32);

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// Canonical synthetic Claude session shape — mirrors test/helpers/synthetic-sessions.js.
fn synthetic_claude_session_lines(
    session_index: usize,
    with_error: bool,
    filler_lines: usize,
) -> Vec<String> {
    let marker = format!("perfneedle-sess-{session_index}");
    let mut lines = Vec::new();
    for _ in 0..filler_lines {
        lines.push(serde_json::json!({ "type": "progress", "data": "x".repeat(120) }).to_string());
    }
    lines.push(
        serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": format!("Deploy {marker} to staging") }] }
        })
        .to_string(),
    );
    // Field order must match JS synthetic-sessions.js: type before name in tool_use objects
    // so TOOL_USE_NAME_RE can extract bash (serde_json::json! may reorder keys).
    lines.push(format!(
        r#"{{"type":"assistant","message":{{"model":"claude-3-opus","content":[{{"type":"tool_use","name":"bash","input":{{"command":"npm run deploy-{session_index}"}}}},{{"type":"text","text":"Running deploy for {marker}"}}],"usage":{{"input_tokens":100,"output_tokens":50}}}}}}"#,
    ));
    let stderr = if with_error {
        Some("Error: deployment failed exit code 1".to_string())
    } else {
        None
    };
    let mut tool_result = serde_json::json!({
        "type": "tool_result",
        "tool_use_id": format!("toolu-{session_index}"),
        "content": [{ "type": "text", "text": stderr.clone().unwrap_or_else(|| "ok".to_string()) }]
    });
    if let Some(stderr) = stderr {
        tool_result["stderr"] = serde_json::Value::String(stderr);
        tool_result["is_error"] = serde_json::Value::Bool(true);
    }
    lines.push(tool_result.to_string());
    for _ in 0..10 {
        lines.push(
            serde_json::json!({ "type": "system", "subtype": "init", "data": "y".repeat(80) })
                .to_string(),
        );
    }
    lines.push(
        serde_json::json!({
            "type": "user",
            "message": { "content": [{ "type": "text", "text": format!("Verify {marker} health check") }] }
        })
        .to_string(),
    );
    lines.push(
        serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": format!("Health OK for {marker}") }] }
        })
        .to_string(),
    );
    lines
}

#[test]
fn test_index_claude_synthetic_session_shape_matches_js_helper() {
    let tmp_dir =
        std::env::temp_dir().join(format!("tracequest_synthetic_shape_{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).expect("create synthetic shape temp dir");
    let file = tmp_dir.join("session-0.jsonl");
    let body = synthetic_claude_session_lines(0, true, 40).join("\n") + "\n";
    fs::write(&file, body).expect("write synthetic shape session");

    for line in synthetic_claude_session_lines(0, true, 40) {
        if line.contains("assistant") && line.contains("tool_use") {
            assert!(
                !is_claude_index_skippable_line(&line),
                "embedded tool_use assistant line must not be skippable: {line}"
            );
        }
    }

    let entry = index_claude(&file);
    assert!(entry
        .first_prompt
        .as_ref()
        .is_some_and(|p| p.contains("perfneedle-sess-0")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("perfneedle")));
    assert!(entry.chapters >= 2);
    assert!(
        entry.tools.iter().any(|t| t == "Bash"),
        "expected Bash in tools: {:?}",
        entry.tools
    );
    assert_eq!(entry.tool_counts.get("Bash").copied().unwrap_or(0), 1i32);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_build_index_synthetic_claude_batch_perf() {
    use chrono::TimeZone;

    let tmp_dir = std::env::temp_dir().join(format!(
        "tracequest_build_index_batch_{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).expect("create synthetic batch perf temp dir");

    let session_count = 3000usize;
    let filler_lines = 8usize;
    let mut sessions = Vec::with_capacity(session_count);
    let base_mtime = chrono::Utc.with_ymd_and_hms(2026, 6, 1, 12, 0, 0).unwrap();

    for i in 0..session_count {
        let file = tmp_dir.join(format!("session-{i}.jsonl"));
        let with_error = i % 7 == 0;
        let body = synthetic_claude_session_lines(i, with_error, filler_lines).join("\n") + "\n";
        fs::write(&file, body).expect("write synthetic session jsonl");
        let meta = fs::metadata(&file).expect("stat synthetic session jsonl");
        sessions.push(Session {
            path: file.to_string_lossy().into_owned(),
            project: "batchperf".to_string(),
            file: format!("session-{i}.jsonl"),
            source: "claude".to_string(),
            size: meta.len(),
            mtime: base_mtime + chrono::Duration::milliseconds(i as i64),
            parent_session: None,
            title: None,
        });
    }

    let index_path = tmp_dir.join("index.json");
    for _ in 0..2 {
        let _ = build_index(&index_path, 8, &sessions, &std::collections::HashSet::new())
            .expect("known sources must index without error");
    }
    let start = std::time::Instant::now();
    let out = build_index(&index_path, 8, &sessions, &std::collections::HashSet::new())
        .expect("known sources must index without error");
    let ms = start.elapsed().as_secs_f64() * 1000.0;

    assert_eq!(out.len(), session_count);
    let sample = out
        .get(sessions[0].path.as_str())
        .expect("first session indexed");
    assert!(sample
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("perfneedle")));

    assert_perf_ms(
        ms,
        2000.0,
        &format!("build_index for {session_count} synthetic sessions"),
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// Canonical synthetic Factory session shape — mirrors test/helpers/synthetic-sessions.js.
fn synthetic_factory_session_lines(
    session_index: usize,
    with_error: bool,
    filler_lines: usize,
    disk_only_cmd: Option<&str>,
) -> Vec<String> {
    let marker = format!("factoryperf-sess-{session_index}");
    let mut lines = Vec::new();

    for i in 0..filler_lines {
        lines.push(
            serde_json::json!({
                "type": "heartbeat",
                "ts": format!("2026-05-01T00:00:{i:02}Z")
            })
            .to_string(),
        );
    }

    lines.push(
        serde_json::json!({
            "type": "message",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": format!("Deploy {marker} to staging") }]
            }
        })
        .to_string(),
    );

    // Field order must match JS synthetic-sessions.js: type before name in tool_use objects
    // so TOOL_USE_NAME_RE can extract Bash (serde_json::json! may reorder keys).
    let mut assistant_line = format!(
        r#"{{"type":"message","message":{{"role":"assistant","content":[{{"type":"text","text":"Running deploy for {marker}"}},{{"type":"tool_use","name":"Bash","input":{{"command":"npm run deploy-{session_index}"}}}}"#,
    );
    if let Some(cmd) = disk_only_cmd {
        assistant_line.push_str(&format!(
            ",{{\"type\":\"tool_use\",\"name\":\"Bash\",\"input\":{{\"command\":\"{cmd}\"}}}}"
        ));
    }
    assistant_line.push_str("]}}}");
    lines.push(assistant_line);

    if with_error {
        lines.push(
            serde_json::json!({
                "type": "message",
                "message": {
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": format!("factory-err-{session_index}"),
                        "content": [{ "type": "text", "text": "Error: factory deployment failed exit code 1" }],
                        "is_error": true
                    }]
                }
            })
            .to_string(),
        );
    }

    for i in 0..6 {
        lines.push(
            serde_json::json!({
                "type": "heartbeat",
                "ts": format!("2026-05-01T00:01:{i:02}Z")
            })
            .to_string(),
        );
    }

    lines.push(
        serde_json::json!({
            "type": "message",
            "message": {
                "role": "user",
                "content": [{ "type": "text", "text": format!("Verify {marker} health check") }]
            }
        })
        .to_string(),
    );
    lines.push(
        serde_json::json!({
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": format!("Health OK for {marker}") }]
            }
        })
        .to_string(),
    );

    lines
}

/// Canonical synthetic Grok session files — mirrors test/helpers/synthetic-sessions.js.
fn synthetic_grok_session_files(
    session_index: usize,
    with_error: bool,
    filler_lines: usize,
    disk_only_phrase: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let marker = format!("grokperf-sess-{session_index}");
    let mut chat_lines = Vec::new();

    for _ in 0..filler_lines {
        chat_lines
            .push(serde_json::json!({ "type": "system", "content": "x".repeat(120) }).to_string());
    }

    chat_lines.push(
        serde_json::json!({ "type": "user", "content": format!("Deploy {marker} to staging") })
            .to_string(),
    );
    chat_lines.push(
        serde_json::json!({
            "type": "assistant",
            "content": format!("Running deploy for {marker}"),
            "tool_calls": [{
                "name": "bash",
                "arguments": serde_json::json!({ "command": format!("npm run deploy-{session_index}") }).to_string()
            }]
        })
        .to_string(),
    );

    if let Some(phrase) = disk_only_phrase {
        chat_lines.push(serde_json::json!({ "type": "user", "content": phrase }).to_string());
    }

    chat_lines.push(
        serde_json::json!({ "type": "user", "content": format!("Verify {marker} health check") })
            .to_string(),
    );
    chat_lines.push(
        serde_json::json!({
            "type": "assistant",
            "content": format!("Health OK for {marker}")
        })
        .to_string(),
    );

    let mut event_lines = vec![
        serde_json::json!({
            "type": "turn_started",
            "ts": "2026-05-01T00:01:00Z",
            "model_id": "grok-3"
        })
        .to_string(),
        serde_json::json!({
            "type": "tool_started",
            "ts": "2026-05-01T00:01:01Z",
            "tool_name": "bash"
        })
        .to_string(),
    ];
    if with_error {
        event_lines.push(
            serde_json::json!({
                "type": "tool_completed",
                "ts": "2026-05-01T00:01:02Z",
                "outcome": "error"
            })
            .to_string(),
        );
    }
    for _ in 0..filler_lines {
        event_lines.push(
            serde_json::json!({ "type": "stream_chunk", "data": "y".repeat(80) }).to_string(),
        );
    }

    (chat_lines, event_lines)
}

#[test]
fn test_index_factory_synthetic_session_shape_matches_js_helper() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "tracequest_factory_synthetic_shape_{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).expect("create factory synthetic shape temp dir");
    let file = tmp_dir.join("session-0.jsonl");
    let body = synthetic_factory_session_lines(0, true, 12, None).join("\n") + "\n";
    fs::write(&file, body).expect("write factory synthetic shape session");

    for line in synthetic_factory_session_lines(0, true, 12, None) {
        if line.contains("heartbeat") {
            assert!(
                is_factory_index_skippable_line(&line),
                "heartbeat filler must be skippable: {line}"
            );
        }
        if line.contains("\"type\":\"message\"") || line.contains("\"type\": \"message\"") {
            assert!(
                !is_factory_index_skippable_line(&line),
                "message row must not be skippable: {line}"
            );
        }
    }

    let entry = index_factory(&file);
    assert!(entry
        .first_prompt
        .as_ref()
        .is_some_and(|p| p.contains("factoryperf-sess-0")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("factoryperf")));
    assert!(entry.chapters >= 2);
    assert!(
        entry.tools.iter().any(|t| t == "Bash"),
        "expected Bash in tools: {:?}",
        entry.tools
    );
    assert_eq!(entry.tool_counts.get("Bash").copied().unwrap_or(0), 1i32);
    assert_eq!(
        entry.errors, 1,
        "session-0 is_error embedded tool_result increments errors in Rust factory indexer"
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_grok_synthetic_session_shape_matches_js_helper() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "tracequest_grok_synthetic_shape_{}",
        std::process::id()
    ));
    let session = tmp_dir.join("session-0");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&session).expect("create grok synthetic shape temp dir");

    let (chat_lines, event_lines) = synthetic_grok_session_files(0, true, 12, None);
    fs::write(
        session.join("chat_history.jsonl"),
        chat_lines.join("\n") + "\n",
    )
    .expect("write grok chat_history");
    fs::write(session.join("events.jsonl"), event_lines.join("\n") + "\n")
        .expect("write grok events");

    let entry = index_grok(session.to_str().unwrap());
    assert!(entry
        .first_prompt
        .as_ref()
        .is_some_and(|p| p.contains("grokperf-sess-0")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("grokperf")));
    assert!(entry.chapters >= 2);
    assert_eq!(entry.model.as_deref(), Some("grok-3"));
    assert!(
        entry.tools.iter().any(|t| t == "Bash"),
        "expected Bash in tools: {:?}",
        entry.tools
    );
    assert!(
        entry.tool_counts.get("Bash").copied().unwrap_or(0) >= 1,
        "expected Bash tool count >=1: {:?}",
        entry.tool_counts
    );
    assert_eq!(
        entry.errors, 1,
        "session-0 tool_completed error increments errors in Rust grok indexer"
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// Canonical synthetic Codex session shape — mirrors test/helpers/synthetic-sessions.js.
fn synthetic_codex_session_lines(
    session_index: usize,
    with_error: bool,
    filler_lines: usize,
    disk_only_cmd: Option<&str>,
    project_cwd: &str,
) -> Vec<String> {
    let marker = format!("codexperf-sess-{session_index}");
    let mut lines = Vec::new();

    lines.push(
        serde_json::json!({
            "type": "session_meta",
            "payload": { "cwd": project_cwd, "model_provider": "openai" },
            "timestamp": "2026-05-01T00:00:00Z"
        })
        .to_string(),
    );

    for _ in 0..filler_lines {
        lines.push(
            serde_json::json!({ "type": "stream_chunk", "payload": { "text": "x".repeat(120) } })
                .to_string(),
        );
    }

    lines.push(
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": format!("Deploy {marker} to staging") },
            "timestamp": "2026-05-01T00:01:00Z"
        })
        .to_string(),
    );

    lines.push(format!(
        r#"{{"type":"response_item","payload":{{"role":"assistant","content":[{{"type":"output_text","text":"Running deploy for {marker}"}},{{"type":"function_call","name":"bash","arguments":"{{\"command\":\"npm run deploy-{session_index}\"}}"}}]}}}}"#
    ));

    if let Some(cmd) = disk_only_cmd {
        lines.push(
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "exec_command_end", "command": cmd, "exit_code": 0 }
            })
            .to_string(),
        );
    }

    if with_error {
        lines.push(
            serde_json::json!({
                "type": "event_msg",
                "payload": {
                    "type": "exec_command_end",
                    "command": format!("npm run deploy-{session_index}"),
                    "exit_code": 1
                }
            })
            .to_string(),
        );
        lines.push(
            serde_json::json!({
                "type": "response_item",
                "payload": {
                    "type": "function_call_output",
                    "exit_code": 1,
                    "output": "Error: codex deployment failed exit code 1"
                }
            })
            .to_string(),
        );
    }

    for _ in 0..6 {
        lines.push(
            serde_json::json!({ "type": "stream_chunk", "payload": { "text": "y".repeat(80) } })
                .to_string(),
        );
    }

    lines.push(
        serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "user_message", "message": format!("Verify {marker} health check") },
            "timestamp": "2026-05-01T00:02:00Z"
        })
        .to_string(),
    );

    lines.push(
        serde_json::json!({
            "type": "turn_context",
            "payload": {
                "model": "gpt-5-codex",
                "last_token_usage": { "input_tokens": 100, "output_tokens": 50 }
            },
            "timestamp": "2026-05-01T00:03:00Z"
        })
        .to_string(),
    );

    lines
}

fn seed_synthetic_opencode_db(
    db_path: &std::path::Path,
    session_count: usize,
    project_dir: &str,
) -> Vec<Session> {
    use chrono::TimeZone;

    let _ = fs::remove_file(db_path);
    fs::create_dir_all(db_path.parent().unwrap()).expect("create opencode db parent");
    let conn = Connection::open(db_path).expect("open synthetic opencode db");
    conn.execute_batch(
        "CREATE TABLE session (
            id TEXT PRIMARY KEY,
            title TEXT,
            directory TEXT,
            version TEXT,
            time_created INTEGER,
            time_updated INTEGER
        );
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT,
            data TEXT,
            time_created TEXT,
            time_updated TEXT
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT,
            data TEXT,
            time_created INTEGER
        );",
    )
    .expect("create opencode schema");

    let base_mtime = chrono::Utc.with_ymd_and_hms(2026, 6, 1, 12, 0, 0).unwrap();
    let mut sessions = Vec::with_capacity(session_count);

    let tx = conn.unchecked_transaction().expect("begin opencode tx");
    for i in 0..session_count {
        let marker = format!("opencodeperf-sess-{i}");
        let id = format!("oc-perf-{i}");
        let t0: i64 = 1_748_784_000_000 + i as i64 * 1000;
        let with_error = i % 7 == 0;
        let disk_only_phrase = if i == 5 {
            Some("opencodeperf-disk-phrase-5")
        } else {
            None
        };

        tx.execute(
            "INSERT INTO session (id, title, directory, version, time_created, time_updated)
             VALUES (?1, ?2, ?3, '1.0', ?4, ?5)",
            rusqlite::params![id, format!("OpenCode {marker}"), project_dir, t0, t0 + 5000],
        )
        .expect("insert opencode session");

        let msg_specs: Vec<(String, String, String, Vec<String>)> = vec![
            (
                format!("{id}-m0"),
                r#"{"role":"user","modelID":"gpt-5-codex"}"#.to_string(),
                t0.to_string(),
                vec![serde_json::json!({ "type": "text", "text": format!("Deploy {marker} to staging") }).to_string()],
            ),
            (
                format!("{id}-m1"),
                r#"{"role":"assistant","modelID":"gpt-5-codex"}"#.to_string(),
                (t0 + 1000).to_string(),
                {
                    let mut parts = vec![
                        serde_json::json!({ "type": "text", "text": format!("Running deploy for {marker}") }).to_string(),
                        serde_json::json!({ "type": "tool", "tool": "bash" }).to_string(),
                    ];
                    if with_error {
                        parts.push(serde_json::json!({ "type": "tool", "status": "error" }).to_string());
                    }
                    parts
                },
            ),
            (
                format!("{id}-m2"),
                r#"{"role":"user"}"#.to_string(),
                (t0 + 2000).to_string(),
                {
                    let mut parts = vec![
                        serde_json::json!({ "type": "text", "text": format!("Verify {marker} health check") }).to_string(),
                    ];
                    if let Some(phrase) = disk_only_phrase {
                        parts.push(serde_json::json!({ "type": "text", "text": phrase }).to_string());
                    }
                    parts
                },
            ),
            (
                format!("{id}-m3"),
                r#"{"role":"assistant"}"#.to_string(),
                (t0 + 3000).to_string(),
                vec![serde_json::json!({ "type": "text", "text": format!("Health OK for {marker}") }).to_string()],
            ),
        ];

        let mut part_seq = 0usize;
        for (mid, msg_data, time_created, parts) in msg_specs {
            tx.execute(
                "INSERT INTO message (id, session_id, data, time_created, time_updated)
                 VALUES (?1, ?2, ?3, ?4, ?4)",
                rusqlite::params![mid, id, msg_data, time_created],
            )
            .expect("insert opencode message");
            for part_data in parts {
                tx.execute(
                    "INSERT INTO part (id, message_id, data, time_created) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![format!("{id}-p{part_seq}"), mid, part_data, t0],
                )
                .expect("insert opencode part");
                part_seq += 1;
            }
        }

        sessions.push(Session {
            path: format!("opencode://{id}"),
            project: "perf-opencode".to_string(),
            file: id,
            source: "opencode".to_string(),
            size: 4096,
            mtime: base_mtime + chrono::Duration::milliseconds(i as i64),
            parent_session: None,
            title: Some(format!("OpenCode {marker}")),
        });
    }
    tx.commit().expect("commit opencode tx");
    drop(conn);
    sessions
}

#[test]
fn test_index_codex_synthetic_session_shape_matches_js_helper() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "tracequest_codex_synthetic_shape_{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).expect("create codex synthetic shape temp dir");
    let file = tmp_dir.join("rollout-0.jsonl");
    let body =
        synthetic_codex_session_lines(0, true, 12, None, "/home/dev/perf-codex").join("\n") + "\n";
    fs::write(&file, body).expect("write codex synthetic shape session");

    for line in synthetic_codex_session_lines(0, true, 12, None, "/home/dev/perf-codex") {
        if line.contains("stream_chunk") {
            assert!(
                is_codex_index_skippable_line(&line),
                "stream_chunk filler must be skippable: {line}"
            );
        }
    }

    let entry = index_codex(&file);
    assert!(entry
        .first_prompt
        .as_ref()
        .is_some_and(|p| p.contains("codexperf-sess-0")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("codexperf")));
    assert!(entry.chapters >= 2);
    assert!(
        entry.tools.iter().any(|t| t == "Bash"),
        "expected Bash in tools: {:?}",
        entry.tools
    );
    assert!(
        entry.tool_counts.get("Bash").copied().unwrap_or(0) >= 1,
        "expected Bash tool count >=1: {:?}",
        entry.tool_counts
    );
    assert!(
        entry.errors >= 2,
        "session-0 exec_command_end + function_call_output increment errors in Rust codex indexer"
    );
    assert_eq!(entry.model.as_deref(), Some("openai"));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_opencode_synthetic_session_shape_matches_js_helper() {
    let tmp_dir = std::env::temp_dir().join(format!(
        "tracequest_opencode_synthetic_shape_{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).expect("create opencode synthetic shape temp dir");
    let db_path = tmp_dir.join("opencode.db");
    let sessions = seed_synthetic_opencode_db(&db_path, 1, "/home/dev/perf-opencode");
    std::env::set_var("TRACEQUEST_OPCODE_DB", db_path.to_str().unwrap());

    let entry = index_opencode(&sessions[0]);
    assert!(entry
        .first_prompt
        .as_ref()
        .is_some_and(|p| p.contains("opencodeperf-sess-0")));
    assert!(entry
        .term_freqs
        .as_ref()
        .map_or(false, |m| m.contains_key("opencodeperf")));
    assert!(entry.chapters >= 2);
    assert_eq!(entry.model.as_deref(), Some("gpt-5-codex"));
    assert!(
        entry.tools.iter().any(|t| t == "Bash"),
        "expected Bash in tools: {:?}",
        entry.tools
    );
    assert_eq!(entry.tool_counts.get("Bash").copied().unwrap_or(0), 1i32);
    assert_eq!(
        entry.errors, 1,
        "session-0 with_error should increment errors in Rust opencode indexer"
    );

    let _ = std::env::remove_var("TRACEQUEST_OPCODE_DB");
    let _ = fs::remove_dir_all(&tmp_dir);
}

// ---------------------------------------------------------------------------
// Tokenizer unit tests (ovv: shared fixture for Rust/JS equivalence)
// ---------------------------------------------------------------------------

/// Collect sorted term list from tokenize output for deterministic assertion.
fn sorted_terms(freqs: &HashMap<String, u32>) -> Vec<String> {
    let mut v: Vec<String> = freqs.keys().cloned().collect();
    v.sort();
    v
}

#[test]
fn test_tokenize_camel_case_basic() {
    let terms = sorted_terms(&tokenize("indexWriters"));
    assert_eq!(terms, vec!["index", "writers"]);
}

#[test]
fn test_tokenize_path_and_snake_case() {
    let terms = sorted_terms(&tokenize("src/index_writers.js"));
    assert!(
        terms.contains(&"src".to_string()),
        "expected 'src' in {:?}",
        terms
    );
    assert!(
        terms.contains(&"index".to_string()),
        "expected 'index' in {:?}",
        terms
    );
    assert!(
        terms.contains(&"writers".to_string()),
        "expected 'writers' in {:?}",
        terms
    );
    assert!(
        terms.contains(&"js".to_string()),
        "expected 'js' in {:?}",
        terms
    );
    assert_eq!(
        terms.len(),
        4,
        "expected exactly 4 unique terms, got {:?}",
        terms
    );
}

#[test]
fn test_tokenize_acronym_boundary() {
    // HTTPServer → ["http", "server"]
    let terms = sorted_terms(&tokenize("HTTPServer"));
    assert_eq!(
        terms,
        vec!["http", "server"],
        "HTTPServer split: {:?}",
        terms
    );

    // parseHTML → ["html", "parse"]
    let terms2 = sorted_terms(&tokenize("parseHTML"));
    assert_eq!(
        terms2,
        vec!["html", "parse"],
        "parseHTML split: {:?}",
        terms2
    );

    // getHTTPResponse → ["get", "http", "response"]
    let terms3 = sorted_terms(&tokenize("getHTTPResponse"));
    assert_eq!(
        terms3,
        vec!["get", "http", "response"],
        "getHTTPResponse: {:?}",
        terms3
    );
}

#[test]
fn test_tokenize_discards_short_and_long_tokens() {
    let long_tok = "a".repeat(33);
    let input = format!("x {} short", long_tok);
    let terms = sorted_terms(&tokenize(&input));
    assert!(
        terms.contains(&"short".to_string()),
        "expected 'short': {:?}",
        terms
    );
    assert!(
        !terms.iter().any(|t| t == "x"),
        "should not contain 'x': {:?}",
        terms
    );
    assert!(
        !terms.iter().any(|t| t.len() > 32),
        "no token >32 chars: {:?}",
        terms
    );
}

#[test]
fn test_tokenize_counts_repeated_terms() {
    let freqs = tokenize("already already already");
    assert_eq!(
        freqs.get("already").copied().unwrap_or(0),
        3,
        "repeated terms should be counted (count=3), freqs: {:?}",
        freqs
    );
}

#[test]
fn test_tokenize_cap_at_500k() {
    let big = "hello ".repeat(200_000);
    let freqs = tokenize(&big);
    assert!(freqs.contains_key("hello"), "should have 'hello'");
}

/// Compute the expected term-frequency map for the shared tokenizer corpus fixture.
/// Run with WRITE_TOKENIZER_FIXTURE=1 cargo test test_tokenize_corpus_fixture
/// to emit test/fixtures/tokenizer-corpus.termfreqs.json for JS cross-check.
#[test]
fn test_tokenize_corpus_fixture() {
    let corpus_path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/tokenizer-corpus.txt"
    );
    let corpus = fs::read_to_string(corpus_path)
        .expect("tokenizer corpus fixture not found at test/fixtures/tokenizer-corpus.txt");

    let freqs = tokenize(&corpus);

    let must_contain = [
        "index",
        "writers",
        "src",
        "js",
        "http",
        "server",
        "parse",
        "html",
        "snake",
        "case",
        "var",
        "camel",
        "identifier",
        "xml",
        "parser",
        "get",
        "response",
        "hyphenated",
        "token",
        "path",
        "to",
        "some",
        "file",
        "ts",
        "hello",
        "world",
        "short",
        "normal",
        "word",
    ];
    for term in &must_contain {
        assert!(
            freqs.contains_key(*term),
            "expected term '{}' missing. got: {:?}",
            term,
            {
                let mut v: Vec<_> = freqs.keys().cloned().collect();
                v.sort();
                v
            }
        );
    }

    if std::env::var("WRITE_TOKENIZER_FIXTURE").as_deref() == Ok("1") {
        let out_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../test/fixtures/tokenizer-corpus.termfreqs.json"
        );
        let sorted_map: std::collections::BTreeMap<String, u32> = freqs.into_iter().collect();
        let json = serde_json::to_string_pretty(&sorted_map).expect("serialize term freqs");
        fs::write(out_path, json).expect("write tokenizer-corpus.termfreqs.json");
        println!("Wrote {}", out_path);
    }
}

// ---------------------------------------------------------------------------
// JS/Rust parity test: tool_result extraction in index_claude
// ---------------------------------------------------------------------------

/// Verify that index_claude produces the same term-frequency map as the JS indexer
/// for a synthetic session containing user prompts, assistant text, thinking blocks,
/// tool_result content blocks, and an isMeta line (which must be skipped).
///
/// The expected fixture was generated by running:
///   node -e "import('/home/dev/code/tracequest/src/sessions/session-index-jsonl.js')
///     .then(({indexClaudeJsonl}) => { const r = indexClaudeJsonl('...parity.jsonl');
///       fs.writeFileSync('...parity.termfreqs.json', JSON.stringify(Object.fromEntries([...r.termFreqs.entries()].sort()), null, 2)); })"
///
/// To regenerate: delete test/fixtures/claude-tool-result-parity.termfreqs.json and re-run
/// the node command above (or set WRITE_PARITY_FIXTURE=1 env var in a future test helper).
#[test]
fn test_index_claude_tool_result_parity_with_js() {
    let fixture_jsonl = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/claude-tool-result-parity.jsonl"
    );
    let fixture_expected = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../test/fixtures/claude-tool-result-parity.termfreqs.json"
    );

    let entry = index_claude(Path::new(fixture_jsonl));
    let rust_freqs = entry
        .term_freqs
        .expect("index_claude must produce term_freqs for parity fixture");

    let expected_json = fs::read_to_string(fixture_expected)
        .expect("parity fixture not found: test/fixtures/claude-tool-result-parity.termfreqs.json");
    let expected_map: std::collections::BTreeMap<String, u32> =
        serde_json::from_str(&expected_json).expect("parse expected termfreqs JSON");

    // Convert Rust output to BTreeMap for deterministic comparison
    let rust_sorted: std::collections::BTreeMap<String, u32> = rust_freqs.into_iter().collect();

    // Check every JS term appears in Rust with the same count
    let mut mismatches = Vec::new();
    for (term, &js_count) in &expected_map {
        let rust_count = rust_sorted.get(term).copied().unwrap_or(0);
        if rust_count != js_count {
            mismatches.push(format!(
                "  term {:?}: js={} rust={}",
                term, js_count, rust_count
            ));
        }
    }
    // Check Rust doesn't emit terms that JS doesn't
    for (term, &rust_count) in &rust_sorted {
        if !expected_map.contains_key(term) {
            mismatches.push(format!(
                "  extra rust term {:?}: rust={} js=0",
                term, rust_count
            ));
        }
    }

    assert!(
        mismatches.is_empty(),
        "Rust/JS term-frequency parity mismatch for claude-tool-result-parity.jsonl:\n{}",
        mismatches.join("\n")
    );

    // Spot-check key terms to catch regressions clearly
    // tool_result content
    assert!(
        rust_sorted.contains_key("deployment"),
        "term 'deployment' from tool_result must be indexed"
    );
    assert!(
        rust_sorted.contains_key("npm"),
        "term 'npm' from tool_result must be indexed"
    );
    assert!(
        rust_sorted.contains_key("succeeded"),
        "term 'succeeded' from tool_result must be indexed"
    );
    // assistant text
    assert!(
        rust_sorted.contains_key("completed"),
        "term 'completed' from assistant text must be indexed"
    );
    // thinking
    assert!(
        rust_sorted.contains_key("carefully"),
        "term 'carefully' from thinking block must be indexed"
    );
    // user prompt
    assert!(
        rust_sorted.contains_key("warnings"),
        "term 'warnings' from user prompt must be indexed"
    );
    // isMeta must be skipped (its content "system init context" would add "system", "init", "context")
    assert!(
        !rust_sorted.contains_key("init"),
        "isMeta:true line content must NOT be indexed"
    );
}

#[test]
fn test_index_claude_empty_file() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_claude_empty");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("empty.jsonl");
    fs::write(&file, "").unwrap();

    let entry = index_claude(&file);
    assert_eq!(entry.chapters, 0);
    assert_eq!(entry.first_prompt, None);
    assert_eq!(entry.total_tokens, 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_claude_malformed_only() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_claude_malformed");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("bad.jsonl");
    fs::write(&file, "not json\n{broken\n").unwrap();

    let entry = index_claude(&file);
    assert_eq!(entry.chapters, 0);
    assert_eq!(entry.first_prompt, None);
    assert_eq!(entry.errors, 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_build_index_empty_sessions() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_build_index_empty");
    fs::create_dir_all(&tmp_dir).unwrap();
    let index_path = tmp_dir.join("index.json");
    let stale = std::collections::HashSet::new();

    let index = build_index(&index_path, 8, &[], &stale)
        .expect("known sources must index without error");
    assert!(index.is_empty());

    let _ = fs::remove_dir_all(&tmp_dir);
}

/// build_index fails closed on an unrecognised source: no partial map, no fabricated
/// entry — the whole batch errors so nothing can be persisted (fact z9k).
#[test]
fn test_build_index_errors_on_unknown_source() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_build_index_unknown_source");
    fs::create_dir_all(&tmp_dir).unwrap();
    let index_path = tmp_dir.join("index.json");
    let stale = std::collections::HashSet::new();

    let unknown = Session {
        path: "nosuchsource://bc-abc123".to_string(),
        project: "demo".to_string(),
        file: "bc-abc123".to_string(),
        source: "no-such-source".to_string(),
        size: 10,
        mtime: chrono::DateTime::from_timestamp_millis(1_750_000_000_000).unwrap(),
        parent_session: None,
        title: None,
    };

    let err = build_index(&index_path, 8, std::slice::from_ref(&unknown), &stale)
        .expect_err("an unrecognised source must not silently fall back to index_claude");
    assert_eq!(err.source, "no-such-source");
    assert_eq!(err.path, "nosuchsource://bc-abc123");
    assert!(
        !index_path.exists(),
        "build_index must not have written an index cache"
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_claude_large_file_exceeds_mmap_threshold() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_index_claude_large");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("large.jsonl");
    let mut content = String::new();
    for i in 0..3000 {
        content.push_str(&format!(
            r#"{{"type":"user","message":{{"content":"large-marker-{i} {}"}},"timestamp":"2026-06-03T12:00:00.000Z"}}"#,
            "x".repeat(200)
        ));
        content.push('\n');
        content.push_str(&format!(
            r#"{{"type":"assistant","message":{{"model":"claude-sonnet-4","content":[{{"type":"text","text":"reply"}}],"usage":{{"input_tokens":10,"output_tokens":5}}}},"timestamp":"2026-06-03T12:01:00.000Z"}}"#
        ));
        content.push('\n');
    }
    fs::write(&file, &content).unwrap();
    let meta = fs::metadata(&file).unwrap();
    assert!(
        meta.len() > 512 * 1024,
        "fixture must exceed 512KB mmap threshold, got {} bytes",
        meta.len()
    );

    let entry = index_claude(&file);
    assert!(
        entry
            .first_prompt
            .as_ref()
            .map_or(false, |p| p.contains("large-marker-0")),
        "large file should index first user prompt"
    );
    assert_eq!(entry.chapters, 3000);
    assert!(entry.total_tokens > 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

// Fact im6: the sidecar reads the Cursor model from state.vscdb exactly like
// src/sessions/cursor-state-db.js, and falls back to "cursor" when the row or
// the DB is missing. A regression here silently desyncs JS and Rust indexing.
#[test]
fn test_cursor_model_from_state_db() {
    let tmp_dir = std::env::temp_dir().join("tq_cursor_model_db");
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).unwrap();
    let db_path = tmp_dir.join("state.vscdb");

    let conn = Connection::open(&db_path).unwrap();
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT)", [])
        .unwrap();
    conn.execute(
        "INSERT INTO cursorDiskKV (key, value) VALUES (?1, ?2)",
        rusqlite::params![
            "composerData:aaaa-bbbb",
            r#"{"modelConfig":{"modelName":"composer-2.5"}}"#
        ],
    )
    .unwrap();
    drop(conn);

    // Present row -> real model name.
    assert_eq!(
        crate::indexer::cursor_model_from_db_at(&db_path, "aaaa-bbbb"),
        Some("composer-2.5".to_string())
    );
    // Missing row -> None, so index_cursor falls back to "cursor".
    assert_eq!(crate::indexer::cursor_model_from_db_at(&db_path, "no-such-id"), None);
    // Missing DB -> None.
    assert_eq!(
        crate::indexer::cursor_model_from_db_at(&tmp_dir.join("absent.vscdb"), "aaaa-bbbb"),
        None
    );

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_index_codex_real_tool_outcomes() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/codex-tool-outcomes");
    for (name, errors) in [
        ("nonzero-exit", 1),
        ("patch-failure", 1),
        ("timeout", 1),
        ("structured-exit", 1),
        ("success", 0),
        ("structured-success", 0),
        ("legacy-patch-failure", 1),
        ("legacy-exec-success", 0),
        ("documentation-success", 0),
        ("script-failure", 1),
        ("negative-checks", 4),
    ] {
        let entry = index_codex(&root.join(format!("{name}.jsonl")));
        assert_eq!(entry.errors, errors, "{name}");
    }
}

#[test]
fn test_index_codex_status_and_output_errors() {
    let tmp_dir =
        std::env::temp_dir().join(format!("tracequest_codex_outcomes_{}", std::process::id()));
    fs::create_dir_all(&tmp_dir).unwrap();
    let file = tmp_dir.join("rollout.jsonl");
    for (payload, errors) in [
        (
            serde_json::json!({"type":"custom_tool_call_output","output":"RESULT 1\n{\"chunk_id\":\"x\",\"wall_time_seconds\":0.1,\"exit_code\":1,\"output\":\"\"}"}),
            1,
        ),
        (
            serde_json::json!({"type":"custom_tool_call_output","output":"Documentation\n{\"exit_code\":1}"}),
            0,
        ),
        (
            serde_json::json!({"type":"function_call_output","exit_code":2,"output":""}),
            1,
        ),
        (
            serde_json::json!({"type":"custom_tool_call_output","output":{"isError":true}}),
            1,
        ),
        (
            serde_json::json!({"type":"exec_command_end","exit_code":0,"stdout":"ok","stderr":"Error: boom"}),
            0,
        ),
        (
            serde_json::json!({"type":"exec_command_end","exit_code":0,"aggregated_output":"SyntaxError: invalid syntax"}),
            0,
        ),
        (
            serde_json::json!({"type":"exec_command_end","exit_code":2}),
            1,
        ),
        (
            serde_json::json!({"type":"patch_apply_end","success":false}),
            1,
        ),
        (
            serde_json::json!({"type":"function_call_output","output":"Chunk ID: x\nProcess exited with code 0\nOutput:\nError: boom"}),
            0,
        ),
        (
            serde_json::json!({"type":"function_call_output","output":"Process exited with code 0\nOutput:\n{\"exit_code\":1}\ncommand timed out after 1000 milliseconds\nProcess exited with code 1"}),
            0,
        ),
        (
            serde_json::json!({"type":"function_call_output","output":"Process running with session ID 123"}),
            0,
        ),
        (
            serde_json::json!({"type":"patch_apply_end","success":true}),
            0,
        ),
    ] {
        let kind = if payload["type"].as_str().unwrap().ends_with("_end") {
            "event_msg"
        } else {
            "response_item"
        };
        fs::write(
            &file,
            serde_json::json!({"type":kind,"payload":payload}).to_string(),
        )
        .unwrap();
        assert_eq!(index_codex(&file).errors, errors, "{payload}");
    }
    fs::remove_dir_all(tmp_dir).unwrap();
}
