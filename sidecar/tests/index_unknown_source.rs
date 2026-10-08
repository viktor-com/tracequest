//! Regression: the `index` subcommand must FAIL CLOSED on an unrecognised `source`.
//!
//! Before the fix, `build_index` dispatched every unknown source to `index_claude`,
//! which "read" the non-existent path, logged `Error reading …` to stderr only, and
//! returned an all-zero `IndexEntry`. The process still exited 0 AND persisted the
//! all-zero entry into `index.json` with `mtime` equal to the discovery row's — so the
//! mtime-equality incremental check never re-indexed it. Silent, sticky corruption.
//!
//! These tests drive the real binary (shipped-binary shape) rather than the library
//! internals, so they describe the observable contract: non-zero exit, no entry
//! persisted, nothing laundered back out of a previously corrupted cache.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const UNKNOWN_PATH: &str = "nosuchsource://bc-abc123";
const MTIME_MS: i64 = 1_750_000_000_000;

fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "tracequest_sidecar_unknown_source_{}_{}_{}",
        name,
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Run `index` against `index_path` with the given stdin payload; returns (status code, stdout, stderr).
fn run_index(index_path: &PathBuf, payload: &str) -> (Option<i32>, String, String) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_tracequest-sidecar"))
        .arg("index")
        .arg("--index-path")
        .arg(index_path)
        .arg("--version")
        .arg("10")
        .arg("--sessions-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("failed to spawn sidecar binary");
    child
        .stdin
        .as_mut()
        .unwrap()
        .write_all(payload.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    (
        out.status.code(),
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
    )
}

fn session_json(path: &str, source: &str, mtime_ms: i64) -> String {
    format!(
        r#"{{"path":"{path}","project":"demo","file":"x","source":"{source}","size":10,"mtime":{mtime_ms}}}"#
    )
}

/// Unknown source ⇒ non-zero exit, nothing on stdout, nothing persisted to index.json.
#[test]
fn index_fails_closed_on_unknown_source() {
    let dir = scratch_dir("basic");
    let index_path = dir.join("index.json");
    let payload = format!(
        r#"{{"sessions":[{}],"searchStale":[]}}"#,
        session_json(UNKNOWN_PATH, "no-such-source", MTIME_MS)
    );

    let (code, stdout, stderr) = run_index(&index_path, &payload);

    assert_ne!(
        code,
        Some(0),
        "expected NON-ZERO exit for an unrecognised source, got {code:?}\nstdout: {stdout}\nstderr: {stderr}"
    );
    assert!(
        stderr.contains("no-such-source") && stderr.contains(UNKNOWN_PATH),
        "stderr must name the offending source and session path, got: {stderr}"
    );
    assert!(
        !stdout.contains(UNKNOWN_PATH),
        "unknown-source session must NOT be emitted on stdout, got: {stdout}"
    );

    let persisted = std::fs::read_to_string(&index_path).unwrap_or_default();
    assert!(
        !persisted.contains(UNKNOWN_PATH),
        "unknown-source session must NOT be persisted to index.json, got: {persisted}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// A previously corrupted index.json entry must not be laundered back out via the
/// mtime-equality cache-reuse path — the source check happens before cache reuse.
#[test]
fn index_fails_closed_even_when_unknown_source_is_already_cached() {
    let dir = scratch_dir("cached");
    let index_path = dir.join("index.json");
    // Hand-craft the exact all-zero entry the old code persisted.
    let corrupt = format!(
        r#"{{"_v":10,"{UNKNOWN_PATH}":{{"tools":[],"toolCounts":{{}},"chapters":0,"totalTokens":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"durationMs":0,"errors":0,"files":0,"commits":0,"mtime":{MTIME_MS}}}}}}}"#
    );
    std::fs::write(&index_path, &corrupt).unwrap();

    let payload = format!(
        r#"{{"sessions":[{}],"searchStale":[]}}"#,
        session_json(UNKNOWN_PATH, "no-such-source", MTIME_MS)
    );
    let (code, stdout, _stderr) = run_index(&index_path, &payload);

    assert_ne!(
        code,
        Some(0),
        "a cached entry for an unknown source must not turn the failure back into a success"
    );
    assert!(
        !stdout.contains(UNKNOWN_PATH),
        "cached unknown-source entry must not be re-emitted, got: {stdout}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

/// Positive control: all seven known sources still index and exit 0 (fail-closed must
/// not be over-broad). Claude is exercised with a real file; the others are checked
/// for "does not reject the source" via the same run.
#[test]
fn index_still_succeeds_for_known_sources() {
    let dir = scratch_dir("known");
    let index_path = dir.join("index.json");
    let session_file = dir.join("known.jsonl");
    std::fs::write(
        &session_file,
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hello sidecar\"}}\n",
    )
    .unwrap();
    let session_path = session_file.to_string_lossy().replace('\\', "\\\\");

    let payload = format!(
        r#"{{"sessions":[{}],"searchStale":[]}}"#,
        session_json(&session_path, "claude", MTIME_MS)
    );
    let (code, stdout, stderr) = run_index(&index_path, &payload);

    assert_eq!(code, Some(0), "known source must exit 0, stderr: {stderr}");
    assert!(
        stdout.contains("hello sidecar"),
        "known source must still be indexed, got: {stdout}"
    );
    let persisted = std::fs::read_to_string(&index_path).unwrap();
    assert!(
        persisted.contains(&session_path),
        "known source must still be persisted, got: {persisted}"
    );

    let _ = std::fs::remove_dir_all(&dir);
}
