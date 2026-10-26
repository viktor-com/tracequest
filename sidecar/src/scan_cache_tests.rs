//! Scan metadata cache (fact 5vs): Codex projects are reused while a rollout's
//! size and mtime match, re-read otherwise, and the scan output never changes.

use crate::scan::{scan_with_meta_cache, ScanMetaCache};
use std::fs;
use std::path::{Path, PathBuf};

fn tmp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tracequest_scan_meta_cache_{}_{}", name, std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write_rollout(root: &Path, name: &str, cwd: &str) -> PathBuf {
    let dir = root.join("2026/05/01");
    fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("rollout-2026-05-01T00-00-00-{}.jsonl", name));
    fs::write(
        &path,
        format!(
            "{{\"type\":\"session_meta\",\"payload\":{{\"id\":\"{}\",\"cwd\":\"{}\"}}}}\n{{\"type\":\"event_msg\"}}\n",
            name, cwd
        ),
    )
    .unwrap();
    path
}

fn scan_json(roots: &[String], cache: Option<&Path>) -> String {
    serde_json::to_string(&scan_with_meta_cache(roots, None, cache)).unwrap()
}

#[test]
fn scan_meta_cache_output_matches_uncached_scan() {
    let dir = tmp_dir("same");
    let root = dir.join(".codex/sessions");
    for i in 0..40 {
        write_rollout(&root, &format!("s{}", i), &format!("/home/dev/project{}", i % 7));
    }
    fs::write(root.join("2026/05/01/notes.txt"), "not a rollout").unwrap();
    let roots = vec![root.to_string_lossy().to_string()];
    let cache = dir.join("cache/scan-meta.json");

    let uncached = scan_json(&roots, None);
    assert!(!cache.exists());
    assert_eq!(scan_json(&roots, Some(&cache)), uncached, "cold cache");
    assert!(cache.exists(), "the first cached scan writes scan-meta.json");
    let written = fs::metadata(&cache).unwrap().modified().unwrap();
    assert_eq!(scan_json(&roots, Some(&cache)), uncached, "warm cache");
    assert_eq!(
        fs::metadata(&cache).unwrap().modified().unwrap(),
        written,
        "an unchanged tree does not rewrite the cache"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn scan_meta_cache_reuses_matching_entries_and_rereads_changed_files() {
    let dir = tmp_dir("reuse");
    let root = dir.join(".codex/sessions");
    let a = write_rollout(&root, "a", "/home/dev/apple");
    let b = write_rollout(&root, "b", "/home/dev/banana");
    let roots = vec![root.to_string_lossy().to_string()];
    let cache = dir.join("scan-meta.json");
    scan_with_meta_cache(&roots, None, Some(&cache));

    // Plant a project for `a`: while its size and mtime match, the file is not read.
    let raw = fs::read_to_string(&cache).unwrap();
    assert_eq!(raw.matches("\"apple\"]").count(), 1);
    fs::write(&cache, raw.replace("\"apple\"]", "\"planted\"]")).unwrap();
    let project_of = |p: &Path| {
        scan_with_meta_cache(&roots, None, Some(&cache))
            .into_iter()
            .find(|s| s.path == p.to_string_lossy())
            .map(|s| s.project)
            .unwrap()
    };
    assert_eq!(project_of(&a), "planted");
    assert_eq!(project_of(&b), "banana");

    // Grown file (an appended line): re-read, and the cache is corrected.
    let mut body = fs::read_to_string(&a).unwrap();
    body.push_str("{\"type\":\"event_msg\"}\n");
    fs::write(&a, body).unwrap();
    assert_eq!(project_of(&a), "apple");
    assert!(!fs::read_to_string(&cache).unwrap().contains("planted"));

    // A removed file leaves the cache.
    fs::remove_file(&b).unwrap();
    assert_eq!(scan_with_meta_cache(&roots, None, Some(&cache)).len(), 1);
    assert!(!fs::read_to_string(&cache).unwrap().contains("banana"));

    // An unreadable or foreign cache file is ignored, then replaced.
    fs::write(&cache, "{not json").unwrap();
    assert_eq!(project_of(&a), "apple");
    assert_eq!(ScanMetaCache::load(&cache).codex_entries(), 1);
    let _ = fs::remove_dir_all(&dir);
}
