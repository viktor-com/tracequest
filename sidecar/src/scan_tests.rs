use crate::scan::{
    decode_grok_workspace, extract_codex_project, infer_source, normalize_project_folder, scan,
    scan_claude, scan_cursor, scan_cursor_cloud, scan_factory, scan_grok, scan_opencode,
};
use crate::types::Session;
use rusqlite::Connection;
use std::fs;
use std::io::Write;

#[test]
fn test_scan_empty_roots() {
    let sessions = scan(&[], None);
    assert!(sessions.is_empty());
}

#[test]
fn test_infer_source() {
    assert_eq!(
        infer_source("/home/user/.claude/projects"),
        Some(crate::types::Source::Claude)
    );
    assert_eq!(
        infer_source("/home/user/.codex/sessions"),
        Some(crate::types::Source::Codex)
    );
    assert_eq!(
        infer_source("/home/user/.cursor/projects"),
        Some(crate::types::Source::Cursor)
    );
    assert_eq!(
        infer_source("/home/user/.factory/sessions"),
        Some(crate::types::Source::Factory)
    );
    assert_eq!(
        infer_source("/home/user/.grok/sessions"),
        Some(crate::types::Source::Grok)
    );
    assert_eq!(
        infer_source("/home/user/.local/share/opencode/opencode.db"),
        Some(crate::types::Source::OpenCode)
    );
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/cursor-cloud"),
        Some(crate::types::Source::CursorCloud)
    );
    assert_eq!(infer_source("/some/random/path"), None);
}

#[test]
fn test_infer_source_cursor_cloud() {
    // Default root: ~/.local/share/tracequest/cursor-cloud.
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/cursor-cloud"),
        Some(crate::types::Source::CursorCloud)
    );
    // TRACEQUEST_CURSOR_CLOUD_DIR override is an arbitrary string — matching is
    // on the stable "tracequest" + "cursor-cloud" path components.
    assert_eq!(
        infer_source("/tmp/fixtures/tracequest-test/cursor-cloud"),
        Some(crate::types::Source::CursorCloud)
    );
    // No shadowing in either direction with the ".cursor"+"projects" rule.
    assert_eq!(
        infer_source("/home/user/.cursor/projects"),
        Some(crate::types::Source::Cursor)
    );
    assert_eq!(
        infer_source("/home/user/.cursor/projects/tracequest/cursor-cloud"),
        Some(crate::types::Source::CursorCloud)
    );
    // Both components required.
    assert_eq!(infer_source("/home/user/cursor-cloud"), None);
    assert_eq!(infer_source("/home/user/tracequest"), None);
}

#[test]
fn test_infer_source_ssh_imported_hosts() {
    // Imported trees live under ~/.local/share/tracequest/hosts/<id>/...
    // They contain "tracequest" but must NOT be labeled CursorCloud.
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/hosts/gpu/.claude/projects"),
        Some(crate::types::Source::Claude)
    );
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/hosts/gpu/.cursor/projects"),
        Some(crate::types::Source::Cursor)
    );
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/hosts/gpu/.codex/sessions"),
        Some(crate::types::Source::Codex)
    );
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/hosts/gpu/.factory/sessions"),
        Some(crate::types::Source::Factory)
    );
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/hosts/gpu/.grok/sessions"),
        Some(crate::types::Source::Grok)
    );
    // A host id that is not cursor-cloud must never flip the cursor-cloud rule.
    assert_eq!(
        infer_source("/home/user/.local/share/tracequest/hosts/work-box/.cursor/projects"),
        Some(crate::types::Source::Cursor)
    );
}

#[test]
fn test_scan_opencode_imported_host_prefixes_uri() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_opencode_host_scan");
    let _ = fs::remove_dir_all(&tmp_dir);
    let host_root = tmp_dir
        .join("tracequest")
        .join("hosts")
        .join("gpu")
        .join(".local")
        .join("share")
        .join("opencode");
    fs::create_dir_all(&host_root).unwrap();
    let db_path = host_root.join("opencode.db");
    {
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, version TEXT, time_created TEXT, time_updated TEXT);
             CREATE TABLE message (id INTEGER PRIMARY KEY, session_id TEXT);
             INSERT INTO session VALUES ('ses_abcdefghijklmnopqrst','t','/tmp/p','1','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
             INSERT INTO message (session_id) VALUES ('ses_abcdefghijklmnopqrst');
             INSERT INTO message (session_id) VALUES ('ses_abcdefghijklmnopqrst');
             INSERT INTO message (session_id) VALUES ('ses_abcdefghijklmnopqrst');",
        )
        .unwrap();
    }
    let sessions = scan_opencode(db_path.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].path, "opencode://gpu/ses_abcdefghijklmnopqrst");
    assert_eq!(sessions[0].source, "opencode");
    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_scan_cursor_cloud_structure() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_cursor_cloud_scan");
    let _ = fs::remove_dir_all(&tmp_dir);
    let slug_dir = tmp_dir.join("myorg-myrepo");
    fs::create_dir_all(&slug_dir).unwrap();

    let agent_file = slug_dir.join("bc-abc12345-1234-5678-9abc-def012345678.jsonl");
    let content = "{\"type\":\"session_meta\",\"bcId\":\"bc-abc\",\"name\":\"Fix bug\",\"status\":\"FINISHED\",\"createdAt\":\"2026-07-01T00:00:00Z\"}\n{\"role\":\"user\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"hi\"}]}}\n";
    fs::write(&agent_file, content).unwrap();

    // Files at the wrong depth are NOT sessions: no bare files at the root,
    // no subagents subdir (cursor-cloud has none).
    fs::write(tmp_dir.join("stray.jsonl"), "{}\n").unwrap();
    let deep = slug_dir.join("subagents");
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("sub.jsonl"), "{}\n").unwrap();

    let sessions = scan_cursor_cloud(tmp_dir.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 1);
    let s = &sessions[0];
    assert_eq!(s.source, "cursor-cloud");
    assert_eq!(s.project, "myorg-myrepo");
    assert_eq!(s.file, "bc-abc12345-1234-5678-9abc-def012345678.jsonl");
    assert_eq!(s.path, agent_file.to_string_lossy().to_string());
    assert_eq!(s.size, content.len() as u64);
    assert!(s.mtime.timestamp_millis() > 0);
    assert_eq!(s.parent_session, None);

    let filtered = scan_cursor_cloud(tmp_dir.to_str().unwrap(), Some("nomatch"));
    assert!(filtered.is_empty());
    let matching = scan_cursor_cloud(tmp_dir.to_str().unwrap(), Some("myorg"));
    assert_eq!(matching.len(), 1);

    // Absent root: silently empty like every other source.
    let absent = scan_cursor_cloud(tmp_dir.join("does-not-exist").to_str().unwrap(), None);
    assert!(absent.is_empty());

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_decode_grok_workspace() {
    assert_eq!(decode_grok_workspace("my%20project"), "my project");
    assert_eq!(
        decode_grok_workspace("code%2Ftracequest"),
        "code/tracequest"
    );
    assert_eq!(decode_grok_workspace("plain-workspace"), "plain-workspace");
}

#[test]
fn test_extract_codex_project_from_meta() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_codex");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file_path = tmp_dir.join("rollout-test.jsonl");

    let meta = serde_json::json!({
        "type": "session_meta",
        "payload": {
            "cwd": "/home/dev/code/tracequest"
        }
    });
    let mut file = fs::File::create(&file_path).unwrap();
    writeln!(file, "{}", meta).unwrap();

    let project = extract_codex_project(&file_path);
    assert_eq!(project, "tracequest");

    // With HOME replacement
    std::env::set_var("HOME", "/home/dev");
    let project2 = extract_codex_project(&file_path);
    assert_eq!(project2, "tracequest");

    // Cleanup
    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_extract_codex_project_long_first_line() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_codex_long");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file_path = tmp_dir.join("rollout-long.jsonl");

    let padding = "x".repeat(10_000);
    let meta = serde_json::json!({
        "type": "session_meta",
        "payload": {
            "cwd": "/home/dev/code/workspace-notes",
            "note": padding
        }
    });
    let mut file = fs::File::create(&file_path).unwrap();
    writeln!(file, "{}", meta).unwrap();

    std::env::set_var("HOME", "/home/dev");
    let project = extract_codex_project(&file_path);
    assert_eq!(project, "workspace-notes");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_normalize_project_folder() {
    std::env::set_var("HOME", "/home/dev");
    assert_eq!(
        normalize_project_folder("/home/dev/code/workspace-notes"),
        "workspace-notes"
    );
    assert_eq!(
        normalize_project_folder("/home/dev/code/foo/bar"),
        "bar"
    );
    assert_eq!(
        normalize_project_folder("ws-home-dev-code-tracequest"),
        "tracequest"
    );
    assert_eq!(
        normalize_project_folder("foo-home-dev-code-bar"),
        "bar"
    );
    assert_eq!(normalize_project_folder("plain-project"), "plain-project");
    assert_eq!(normalize_project_folder(""), "(unknown)");
}

#[test]
fn test_extract_codex_project_fallback() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_codex2");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file_path = tmp_dir.join("rollout-bad.jsonl");

    let mut file = fs::File::create(&file_path).unwrap();
    writeln!(file, "not valid json").unwrap();

    let project = extract_codex_project(&file_path);
    assert_eq!(project, "codex");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_extract_codex_project_session_meta_without_cwd() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_codex_no_cwd");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file_path = tmp_dir.join("rollout-no-cwd.jsonl");

    let meta = serde_json::json!({
        "type": "session_meta",
        "payload": {}
    });
    let mut file = fs::File::create(&file_path).unwrap();
    writeln!(file, "{}", meta).unwrap();

    let project = extract_codex_project(&file_path);
    assert_eq!(project, "(unknown)");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_extract_codex_project_oversized_line_without_newline() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_codex_oversized");
    fs::create_dir_all(&tmp_dir).unwrap();
    let file_path = tmp_dir.join("rollout-huge.jsonl");

    let mut file = fs::File::create(&file_path).unwrap();
    let huge = "x".repeat(1024 * 1024 + 1);
    write!(file, "{}", huge).unwrap();

    let project = extract_codex_project(&file_path);
    assert_eq!(project, "codex");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_scan_claude_structure() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_claude");
    fs::create_dir_all(tmp_dir.join("myproject")).unwrap();
    fs::create_dir_all(tmp_dir.join("myproject").join("session1").join("subagents")).unwrap();

    let main_file = tmp_dir.join("myproject").join("main.jsonl");
    let sub_file = tmp_dir
        .join("myproject")
        .join("session1")
        .join("subagents")
        .join("sub.jsonl");

    fs::write(&main_file, "{}\n").unwrap();
    fs::write(&sub_file, "{}\n").unwrap();

    let sessions = scan_claude(tmp_dir.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 2);

    let main_session = sessions
        .iter()
        .find(|s| s.file == "main.jsonl")
        .expect("main session missing");
    assert_eq!(main_session.project, "myproject");
    assert_eq!(main_session.source, "claude");
    assert_eq!(main_session.parent_session, None);

    let sub_session = sessions
        .iter()
        .find(|s| s.file == "sub.jsonl")
        .expect("sub session missing");
    assert_eq!(sub_session.project, "myproject");
    assert_eq!(sub_session.parent_session, Some("session1".to_string()));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_scan_cursor_structure() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_cursor");
    let uuid = "abc12345-1234-5678-9abc-def012345678";
    fs::create_dir_all(
        tmp_dir
            .join("cursorproject")
            .join("agent-transcripts")
            .join(uuid),
    )
    .unwrap();
    fs::create_dir_all(
        tmp_dir
            .join("cursorproject")
            .join("agent-transcripts")
            .join(uuid)
            .join("subagents"),
    )
    .unwrap();

    let main_file = tmp_dir
        .join("cursorproject")
        .join("agent-transcripts")
        .join(uuid)
        .join(format!("{}.jsonl", uuid));
    let sub_file = tmp_dir
        .join("cursorproject")
        .join("agent-transcripts")
        .join(uuid)
        .join("subagents")
        .join("sub.jsonl");

    fs::write(&main_file, "{}\n").unwrap();
    fs::write(&sub_file, "{}\n").unwrap();

    let sessions = scan_cursor(tmp_dir.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 2);

    let main_session = sessions
        .iter()
        .find(|s| s.file == format!("{}.jsonl", uuid))
        .expect("main session missing");
    assert_eq!(main_session.project, "cursorproject");
    assert_eq!(main_session.source, "cursor");
    assert_eq!(main_session.parent_session, None);

    let sub_session = sessions
        .iter()
        .find(|s| s.file == "sub.jsonl")
        .expect("sub session missing");
    assert_eq!(sub_session.project, "cursorproject");
    assert_eq!(sub_session.source, "cursor");
    assert_eq!(sub_session.parent_session, Some(uuid.to_string()));

    let filtered = scan_cursor(tmp_dir.to_str().unwrap(), Some("nomatch"));
    assert!(filtered.is_empty());

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_scan_factory_structure() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_factory");
    let ws = tmp_dir.join("foo-home-dev-code-tracequest");
    fs::create_dir_all(&ws).unwrap();
    let file = ws.join("session.jsonl");
    fs::write(&file, "{}\n").unwrap();

    let sessions = scan_factory(tmp_dir.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].project, "tracequest");
    assert_eq!(sessions[0].source, "factory");
    assert_eq!(sessions[0].file, "session.jsonl");

    let filtered = scan_factory(tmp_dir.to_str().unwrap(), Some("nomatch"));
    assert_eq!(filtered.len(), 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_scan_grok_structure() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_grok");
    let ws = tmp_dir.join("my%20workspace");
    let session = ws.join("session-abc");
    fs::create_dir_all(&session).unwrap();
    let chat = session.join("chat_history.jsonl");
    fs::write(&chat, "{}\n").unwrap();

    let sessions = scan_grok(tmp_dir.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].project, "my workspace");
    assert_eq!(sessions[0].source, "grok");
    assert_eq!(sessions[0].file, "session-abc");
    assert!(sessions[0].path.ends_with("session-abc"));

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_session_serialization_roundtrip() {
    let session = Session {
        path: "/tmp/test.jsonl".to_string(),
        project: "testproj".to_string(),
        file: "test.jsonl".to_string(),
        source: "claude".to_string(),
        size: 1234,
        mtime: chrono::DateTime::from_timestamp(1700000000, 0).unwrap(),
        parent_session: Some("parent".to_string()),
        title: Some("My Title".to_string()),
    };

    let json = serde_json::to_string(&session).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();

    assert_eq!(parsed["path"], "/tmp/test.jsonl");
    assert_eq!(parsed["project"], "testproj");
    assert_eq!(parsed["file"], "test.jsonl");
    assert_eq!(parsed["source"], "claude");
    assert_eq!(parsed["size"], 1234);
    assert_eq!(parsed["parentSession"], "parent");
    assert_eq!(parsed["title"], "My Title");

    // mtime should be milliseconds since epoch
    assert_eq!(parsed["mtime"], 1700000000000i64);
}

#[test]
fn test_session_deserialize_fractional_mtime_truncates() {
    let json = r#"{"path":"/tmp/a.jsonl","project":"p","file":"a.jsonl","source":"claude","size":1,"mtime":1700000000000.9}"#;
    let session: Session = serde_json::from_str(json).unwrap();
    assert_eq!(session.mtime.timestamp_millis(), 1700000000000);
}

#[test]
fn test_session_deserialize_integer_mtime_unchanged() {
    let json = r#"{"path":"/tmp/a.jsonl","project":"p","file":"a.jsonl","source":"claude","size":1,"mtime":1700000000000}"#;
    let session: Session = serde_json::from_str(json).unwrap();
    assert_eq!(session.mtime.timestamp_millis(), 1700000000000);
}

#[test]
fn test_session_deserialize_negative_fractional_mtime_truncates() {
    let json = r#"{"path":"/tmp/a.jsonl","project":"p","file":"a.jsonl","source":"claude","size":1,"mtime":-86400000.9}"#;
    let session: Session = serde_json::from_str(json).unwrap();
    assert_eq!(session.mtime.timestamp_millis(), -86400000);
}

#[test]
fn test_scan_filtering() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_filter");
    fs::create_dir_all(tmp_dir.join("matchme")).unwrap();
    fs::create_dir_all(tmp_dir.join("other")).unwrap();
    fs::write(tmp_dir.join("matchme").join("a.jsonl"), "{}\n").unwrap();
    fs::write(tmp_dir.join("other").join("b.jsonl"), "{}\n").unwrap();

    let all = scan_claude(tmp_dir.to_str().unwrap(), None);
    assert_eq!(all.len(), 2);

    let filtered = scan_claude(tmp_dir.to_str().unwrap(), Some("matchme"));
    assert_eq!(filtered.len(), 1);
    assert_eq!(filtered[0].project, "matchme");

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_scan_opencode_basic() {
    let tmp_dir = std::env::temp_dir().join("tracequest_test_opencode_scan");
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
        "INSERT INTO session (id, title, directory, version, time_created, time_updated)
         VALUES ('sess-1', 'Test Session', '/home/dev/code/tracequest', 1, '2024-01-01T00:00:00Z', '2024-01-02T00:00:00Z')",
        [],
    )
    .unwrap();
    for i in 0..5 {
        conn.execute(
            &format!(
                "INSERT INTO message (session_id, data, time_created)
                 VALUES ('sess-1', '{{}}', '2024-01-01T00:00:0{i}Z')"
            ),
            [],
        )
        .unwrap();
    }

    std::env::set_var("HOME", "/home/dev");
    let sessions = scan_opencode(db_path.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 1);
    assert_eq!(sessions[0].file, "sess-1");
    assert_eq!(sessions[0].project, "tracequest");
    assert_eq!(sessions[0].source, "opencode");
    assert_eq!(sessions[0].path, "opencode://sess-1");
    assert_eq!(sessions[0].size, 5 * 1024);
    assert_eq!(sessions[0].title, Some("Test Session".to_string()));

    let filtered = scan_opencode(db_path.to_str().unwrap(), Some("nomatch"));
    assert_eq!(filtered.len(), 0);

    let _ = fs::remove_dir_all(&tmp_dir);
}

#[test]
fn test_scan_sorts_results_by_mtime_desc() {
    fn seed_db(db_path: &std::path::Path, id: &str, updated: &str) {
        fs::create_dir_all(db_path.parent().unwrap()).unwrap();
        let conn = Connection::open(db_path).unwrap();
        conn.execute(
            "CREATE TABLE session (
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
            "CREATE TABLE message (
                id INTEGER PRIMARY KEY,
                session_id TEXT,
                data TEXT,
                time_created TEXT
            )",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session (id, title, directory, version, time_created, time_updated)
             VALUES (?1, ?2, '/home/dev/code/tracequest', 1, '2024-01-01T00:00:00Z', ?3)",
            [id, id, updated],
        )
        .unwrap();
        for i in 0..3 {
            conn.execute(
                "INSERT INTO message (session_id, data, time_created) VALUES (?1, '{}', ?2)",
                [id, &format!("2024-01-01T00:00:0{i}Z")],
            )
            .unwrap();
        }
    }

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let tmp_dir = std::env::temp_dir().join(format!(
        "tracequest_test_scan_sort_{}_{}",
        std::process::id(),
        unique
    ));
    let _ = fs::remove_dir_all(&tmp_dir);
    let older_db = tmp_dir.join("older").join("opencode.db");
    let newer_db = tmp_dir.join("newer").join("opencode.db");
    seed_db(&older_db, "older-session", "2024-01-01T00:00:00Z");
    seed_db(&newer_db, "newer-session", "2024-01-02T00:00:00Z");

    std::env::set_var("HOME", "/home/dev");
    let sessions = scan(
        &[
            older_db.to_string_lossy().to_string(),
            newer_db.to_string_lossy().to_string(),
        ],
        None,
    );
    assert_eq!(sessions.len(), 2);
    assert_eq!(sessions[0].file, "newer-session");
    assert_eq!(sessions[1].file, "older-session");
    assert!(sessions[0].mtime >= sessions[1].mtime);

    let _ = fs::remove_dir_all(&tmp_dir);
}
