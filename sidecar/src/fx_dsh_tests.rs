//! fx and DeepSeek Harness scan/index tests over the scrubbed real recordings
//! in test/fixtures/fx-dsh. The expected figures are the ones the JS test
//! (test/bin/fx-dsh-support.test.js) asserts, so the two indexers agree.

use crate::fx_dsh::{
    decode_zstd_frames, index_dsh, index_fx, is_dsh_recording_file, read_dsh_text, scan_dsh,
    scan_fx,
};
use crate::scan::{infer_source, scan};
use crate::types::Source;
use std::fs;
use std::path::{Path, PathBuf};

const FX_MAIN: &str = "J1awiyS7sSqf";
const FX_PARENT: &str = "CBwLZxqkuY5v";
const FX_CHILD: &str = "HWr-N-WJc8XG";
const DSH_ID: &str = "session-51fc1afe-8d30-4f77-98a3-7c7a5e9d67fc";

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/fx-dsh")
}

fn copy_tree(src: &Path, dst: &Path) {
    fs::create_dir_all(dst).unwrap();
    for entry in fs::read_dir(src).unwrap().flatten() {
        let to = dst.join(entry.file_name());
        if entry.path().is_dir() {
            copy_tree(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), &to).unwrap();
        }
    }
}

/// A fresh HOME-like dir holding the fixtures at ~/.fx/sessions and ~/.dsh/sessions.
fn home(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tracequest_test_fx_dsh_{name}"));
    let _ = fs::remove_dir_all(&dir);
    copy_tree(&fixtures().join("fx"), &dir.join(".fx/sessions"));
    let dsh_dir = dir.join(".dsh/sessions/-home-dev-calc-").join(DSH_ID);
    fs::create_dir_all(&dsh_dir).unwrap();
    fs::copy(
        fixtures().join("dsh/session.v4.jsonl.zstd"),
        dsh_dir.join("session.v4.jsonl.zstd"),
    )
    .unwrap();
    dir
}

#[test]
fn fx_dsh_infer_source() {
    assert_eq!(infer_source("/home/u/.fx/sessions"), Some(Source::Fx));
    assert_eq!(infer_source("/home/u/.dsh/sessions"), Some(Source::Dsh));
    assert_eq!(
        infer_source("/home/u/.local/share/tracequest/hosts/box/.dsh/sessions"),
        Some(Source::Dsh)
    );
    assert_eq!(infer_source("/home/u/.fx/settings"), None);
}

#[test]
fn fx_dsh_zstd_frames_decode_every_frame_and_drop_a_cut_one() {
    let path = fixtures().join("dsh/session.v4.jsonl.zstd");
    let text = read_dsh_text(&path, usize::MAX);
    assert_eq!(text.lines().count(), 75);
    assert!(text.lines().next().unwrap().contains("\"type\":\"session\""));
    assert_eq!(read_dsh_text(&path, 1).lines().count(), 1);
    let bytes = fs::read(&path).unwrap();
    let cut = decode_zstd_frames(&bytes[..bytes.len() - 3], usize::MAX);
    assert_eq!(String::from_utf8(cut).unwrap().lines().count(), 74);
    assert!(is_dsh_recording_file("session.v4.jsonl.zstd"));
    assert!(is_dsh_recording_file("session.v4.jsonl"));
    assert!(!is_dsh_recording_file("session.lock"));
}

#[test]
fn fx_dsh_scan_fx_lists_sessions_with_project_and_parent() {
    let dir = home("scan_fx");
    let root = dir.join(".fx/sessions");
    let mut sessions = scan_fx(root.to_str().unwrap(), None);
    sessions.sort_by(|a, b| a.file.cmp(&b.file));
    let files: Vec<&str> = sessions.iter().map(|s| s.file.as_str()).collect();
    let mut want = vec![FX_PARENT, FX_CHILD, FX_MAIN];
    want.sort();
    assert_eq!(files, want);
    let main = sessions.iter().find(|s| s.file == FX_MAIN).unwrap();
    assert_eq!(main.path, root.join(FX_MAIN).join("events.jsonl").to_string_lossy());
    assert_eq!(main.project, "calc");
    assert_eq!(main.source, "fx");
    assert_eq!(main.parent_session, None);
    let child = sessions.iter().find(|s| s.file == FX_CHILD).unwrap();
    assert_eq!(child.parent_session.as_deref(), Some(FX_PARENT));
    assert_eq!(scan_fx(root.to_str().unwrap(), Some("nomatch")).len(), 0);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn fx_dsh_scan_dsh_lists_cli_and_acp_sessions() {
    let dir = home("scan_dsh");
    let acp = dir.join(".dsh/sessions/-tmp-acp-/5957ddfd-343b-4293-ac80-e6df4ea35147");
    fs::create_dir_all(&acp).unwrap();
    fs::copy(
        fixtures().join("dsh/session.v4.jsonl.zstd"),
        acp.join("session.v4.jsonl.zstd"),
    )
    .unwrap();
    fs::write(acp.join("session.lock"), "").unwrap();
    let root = dir.join(".dsh/sessions");
    let sessions = scan_dsh(root.to_str().unwrap(), None);
    assert_eq!(sessions.len(), 2);
    let main = sessions.iter().find(|s| s.file == DSH_ID).unwrap();
    assert_eq!(main.project, "calc");
    assert_eq!(main.source, "dsh");
    assert!(main.path.ends_with("session.v4.jsonl.zstd"));
    assert!(sessions.iter().any(|s| s.file == "5957ddfd-343b-4293-ac80-e6df4ea35147"));
    // The full scan dispatches both roots.
    let all = scan(
        &[
            dir.join(".fx/sessions").to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        ],
        None,
    );
    assert_eq!(all.iter().filter(|s| s.source == "fx").count(), 3);
    assert_eq!(all.iter().filter(|s| s.source == "dsh").count(), 2);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn fx_dsh_index_matches_the_js_indexer() {
    let fx = index_fx(&fixtures().join("fx").join(FX_MAIN).join("events.jsonl"));
    assert!(fx.first_prompt.as_deref().unwrap().starts_with("Read calc.py and test_calc.py"));
    assert_eq!(fx.model.as_deref(), Some("deepseek/deepseek-v4.1-flash-1017"));
    assert_eq!(fx.chapters, 2);
    assert_eq!(fx.tool_counts.get("Read"), Some(&4));
    assert_eq!(fx.tool_counts.get("Bash"), Some(&3));
    assert_eq!(fx.tool_counts.get("Edit"), Some(&3));
    assert_eq!(fx.errors, 1);
    assert_eq!(fx.output_tokens, 1001);
    assert_eq!(fx.files, 2);
    assert_eq!(fx.duration_ms, 9065 + 5434);
    let parent = index_fx(&fixtures().join("fx").join(FX_PARENT).join("events.jsonl"));
    assert_eq!(parent.tool_counts.get("Agent"), Some(&1));

    let dsh = index_dsh(&fixtures().join("dsh/session.v4.jsonl.zstd"));
    assert!(dsh.first_prompt.as_deref().unwrap().starts_with("Read calc.py and test_calc.py"));
    assert_eq!(dsh.model.as_deref(), Some("deepseek/deepseek-v4.1-flash-1017"));
    assert_eq!(dsh.chapters, 2);
    assert_eq!(dsh.tool_counts.get("Read"), Some(&4));
    assert_eq!(dsh.tool_counts.get("Bash"), Some(&4));
    assert_eq!(dsh.tool_counts.get("Edit"), Some(&3));
    assert_eq!(dsh.errors, 2);
    assert_eq!(dsh.input_tokens, 7361);
    assert_eq!(dsh.cache_read_tokens, 60288);
    assert_eq!(dsh.total_tokens, 7361 + 60288 + 994);
    assert!(dsh.duration_ms > 15000 && dsh.duration_ms < 20000, "{}", dsh.duration_ms);
    assert!(!dsh.term_freqs.as_ref().unwrap().is_empty());
}
