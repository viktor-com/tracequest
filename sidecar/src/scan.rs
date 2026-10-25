//! Session scanning across agent data roots.

use crate::types::{parse_opencode_timestamp, Session, Source};
use jwalk::WalkDir;
use rayon::prelude::*;
use regex::Regex;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::SystemTime;

/// Host id when `root` is an imported tree under `…/tracequest/hosts/<id>/…`.
fn host_id_from_imported_root(root: &str) -> Option<String> {
    let lower = root.to_lowercase().replace('\\', "/");
    if !lower.contains("tracequest") {
        return None;
    }
    let idx = lower.find("/hosts/")?;
    let rest = &root[idx + "/hosts/".len()..];
    let id = rest.split(['/', '\\']).next().unwrap_or("");
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

pub(crate) fn infer_source(root: &str) -> Option<Source> {
    let lower = root.to_lowercase();
    // cursor-cloud is checked FIRST: its root is tracequest-owned (default
    // ~/.local/share/tracequest/cursor-cloud, arbitrary via
    // TRACEQUEST_CURSOR_CLOUD_DIR), and matching on the stable "tracequest" +
    // "cursor-cloud" path components before the ".cursor"+"projects" rule keeps
    // an override path that happens to contain both from being shadowed.
    if lower.contains("tracequest") && lower.contains("cursor-cloud") {
        Some(Source::CursorCloud)
    } else if lower.contains(".fx/sessions") || lower.contains(".fx\\sessions") {
        // fx and dsh match their whole "<home dir>/sessions" segment so a host id
        // or project path cannot claim another agent's root.
        Some(Source::Fx)
    } else if lower.contains(".dsh/sessions") || lower.contains(".dsh\\sessions") {
        Some(Source::Dsh)
    } else if lower.contains(".claude") && lower.contains("projects") {
        Some(Source::Claude)
    } else if lower.contains(".codex") && lower.contains("sessions") {
        Some(Source::Codex)
    } else if lower.contains(".cursor") && lower.contains("projects") {
        Some(Source::Cursor)
    } else if lower.contains(".factory") && lower.contains("sessions") {
        Some(Source::Factory)
    } else if lower.contains(".vktr/sessions") || lower.contains(".vktr\\sessions") {
        // vktr shares grok's layout; matched on the whole ".vktr/sessions" segment
        // (checked before grok) so a host id like "box.vktr" cannot claim a grok root.
        Some(Source::Vktr)
    } else if lower.contains(".grok") && lower.contains("sessions") {
        Some(Source::Grok)
    } else if lower.contains("opencode.db") {
        Some(Source::OpenCode)
    } else {
        None
    }
}

fn system_time_to_chrono(st: SystemTime) -> chrono::DateTime<chrono::Utc> {
    let duration = st
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default();
    chrono::DateTime::from_timestamp(duration.as_secs() as i64, duration.subsec_nanos())
        .unwrap_or(chrono::DateTime::from_timestamp(0, 0).unwrap())
}

fn make_session(
    path: &Path,
    project: &str,
    source: &str,
    metadata: &std::fs::Metadata,
    parent_session: Option<String>,
) -> Session {
    let mtime = metadata
        .modified()
        .map(system_time_to_chrono)
        .unwrap_or_else(|_| chrono::DateTime::from_timestamp(0, 0).unwrap());
    Session {
        path: path.to_string_lossy().to_string(),
        project: project.to_string(),
        file: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        source: source.to_string(),
        size: metadata.len(),
        mtime,
        parent_session,
        title: None,
    }
}

/// Environment variable naming the scan metadata cache file (fact 5vs). Node sets
/// it to `<tracequest cache dir>/scan-meta.json`; unset or empty, nothing is cached.
pub(crate) const SCAN_META_CACHE_ENV: &str = "TRACEQUEST_SCAN_CACHE";
const SCAN_META_CACHE_VERSION: u32 = 1;

/// What a scan learned by reading session files, so the next scan need not read
/// them again: per Codex root, each rollout's (size, mtime ns, project). The
/// project comes from the rollout's first line, which is written once at start;
/// a size or mtime change still re-reads the file.
#[derive(Serialize, Deserialize, Default)]
pub(crate) struct ScanMetaCache {
    v: u32,
    codex: HashMap<String, HashMap<String, (u64, u64, String)>>,
}

impl ScanMetaCache {
    pub(crate) fn load(path: &Path) -> ScanMetaCache {
        fs::read(path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<ScanMetaCache>(&raw).ok())
            .filter(|c| c.v == SCAN_META_CACHE_VERSION)
            .unwrap_or_default()
    }

    #[cfg(test)]
    pub(crate) fn codex_entries(&self) -> usize {
        self.codex.values().map(|m| m.len()).sum()
    }

    /// Write atomically (temp file + rename); a cache that cannot be written only
    /// makes the next scan slower.
    pub(crate) fn save(&mut self, path: &Path) {
        self.v = SCAN_META_CACHE_VERSION;
        let Ok(raw) = serde_json::to_vec(self) else { return };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let tmp = PathBuf::from(format!("{}.{}.tmp", path.display(), std::process::id()));
        if fs::write(&tmp, raw).is_ok() && fs::rename(&tmp, path).is_err() {
            let _ = fs::remove_file(&tmp);
        }
    }
}

/// (size, mtime in ns since the epoch) — the key a cached file read is valid for.
fn file_stamp(metadata: &std::fs::Metadata) -> Option<(u64, u64)> {
    let mtime = metadata.modified().ok()?.duration_since(SystemTime::UNIX_EPOCH).ok()?;
    Some((metadata.len(), u64::try_from(mtime.as_nanos()).ok()?))
}

/// Scan all agent data roots and return sessions sorted by mtime descending,
/// using the scan metadata cache named by `TRACEQUEST_SCAN_CACHE` when set.
pub fn scan(roots: &[String], filter: Option<&str>) -> Vec<Session> {
    let cache_path = std::env::var_os(SCAN_META_CACHE_ENV)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from);
    scan_with_meta_cache(roots, filter, cache_path.as_deref())
}

/// `scan` with an explicit metadata cache file (None: read every file, cache nothing).
/// The returned sessions are the same with or without the cache.
pub(crate) fn scan_with_meta_cache(
    roots: &[String],
    filter: Option<&str>,
    cache_path: Option<&Path>,
) -> Vec<Session> {
    let mut cache = cache_path.map(ScanMetaCache::load);
    let mut cache_changed = false;
    // Iterate roots SEQUENTIALLY. Each per-source scanner uses jwalk, which runs
    // its directory walk on rayon's global thread pool. Nesting a `roots.par_iter()`
    // on top of that same pool starved jwalk's inner tasks and dropped results
    // non-deterministically on x86_64 (arm64 happened to schedule cleanly) — a
    // multi-source scan would return a random subset of sessions. There are only a
    // handful of roots, so serial dispatch costs nothing; the heavy per-directory
    // walk is still parallelized inside jwalk.
    let mut all_sessions: Vec<Session> = roots
        .iter()
        .filter_map(|root| {
            let source = infer_source(root)?;
            let sessions = match source {
                Source::Claude => scan_claude(root, filter),
                Source::Codex => {
                    let (sessions, changed) = scan_codex(root, filter, cache.as_mut());
                    cache_changed |= changed;
                    sessions
                }
                Source::Cursor => scan_cursor(root, filter),
                Source::CursorCloud => scan_cursor_cloud(root, filter),
                Source::Factory => scan_factory(root, filter),
                Source::Grok => scan_grok(root, filter),
                Source::Vktr => scan_grok_family(root, filter, "vktr"),
                Source::Fx => crate::fx_dsh::scan_fx(root, filter),
                Source::Dsh => crate::fx_dsh::scan_dsh(root, filter),
                Source::OpenCode => scan_opencode(root, filter),
            };
            Some(sessions)
        })
        .flatten()
        .collect();

    if let (true, Some(cache), Some(path)) = (cache_changed, cache.as_mut(), cache_path) {
        cache.save(path);
    }

    all_sessions.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    all_sessions
}

pub(crate) fn scan_claude(root: &str, filter: Option<&str>) -> Vec<Session> {
    scan_claude_family(root, filter, "claude")
}

pub(crate) fn scan_cursor(root: &str, filter: Option<&str>) -> Vec<Session> {
    let mut sessions = Vec::new();
    let root_path = Path::new(root);

    if !root_path.exists() {
        return sessions;
    }

    for entry in WalkDir::new(root).max_depth(5) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if !metadata.is_file() {
            continue;
        }

        let rel = match path.strip_prefix(root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let components: Vec<_> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();

        match components.len() {
            4 if components[1] == "agent-transcripts" => {
                // <project>/agent-transcripts/<uuid>/<file>.jsonl
                let project = normalize_project_folder(&components[0]);
                if filter.map_or(true, |f| project.contains(f)) {
                    sessions.push(make_session(&path, &project, "cursor", &metadata, None));
                }
            }
            5 if components[1] == "agent-transcripts" && components[3] == "subagents" => {
                // <project>/agent-transcripts/<uuid>/subagents/<file>.jsonl
                let project = normalize_project_folder(&components[0]);
                let parent_session = Some(components[2].clone());
                if filter.map_or(true, |f| project.contains(f)) {
                    sessions.push(make_session(
                        &path,
                        &project,
                        "cursor",
                        &metadata,
                        parent_session,
                    ));
                }
            }
            _ => {}
        }
    }

    sessions
}

/// Imported Cursor cloud-agent transcripts: <root>/<project-slug>/<agentId>.jsonl
/// (slug dir then file — no subagents subdir). Rows carry source "cursor-cloud"
/// and project = the slug directory name, matching JS discovery (facts ccri/ccdw).
pub(crate) fn scan_cursor_cloud(root: &str, filter: Option<&str>) -> Vec<Session> {
    let mut sessions = Vec::new();
    let root_path = Path::new(root);

    if !root_path.exists() {
        return sessions;
    }

    for entry in WalkDir::new(root).max_depth(2) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if !metadata.is_file() {
            continue;
        }

        let rel = match path.strip_prefix(root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let components: Vec<_> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();

        // Exactly <project-slug>/<agentId>.jsonl — nothing deeper, no subagents.
        if components.len() != 2 {
            continue;
        }

        let project = &components[0];
        if filter.map_or(true, |f| project.contains(f)) {
            sessions.push(make_session(&path, project, "cursor-cloud", &metadata, None));
        }
    }

    sessions
}

fn scan_claude_family(root: &str, filter: Option<&str>, source: &str) -> Vec<Session> {
    let mut sessions = Vec::new();
    let root_path = Path::new(root);

    if !root_path.exists() {
        return sessions;
    }

    for entry in WalkDir::new(root).max_depth(4) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if !metadata.is_file() {
            continue;
        }

        let rel = match path.strip_prefix(root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let components: Vec<_> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();

        match components.len() {
            2 => {
                // <project>/<file>.jsonl
                let project = normalize_project_folder(&components[0]);
                if filter.map_or(true, |f| project.contains(f)) {
                    sessions.push(make_session(&path, &project, source, &metadata, None));
                }
            }
            4 => {
                // <project>/<session_dir>/subagents/<file>.jsonl
                if components[2] == "subagents" {
                    let project = normalize_project_folder(&components[0]);
                    let parent_session = Some(components[1].clone());
                    if filter.map_or(true, |f| project.contains(f)) {
                        sessions.push(make_session(
                            &path,
                            &project,
                            source,
                            &metadata,
                            parent_session,
                        ));
                    }
                }
            }
            _ => {}
        }
    }

    sessions
}

const MAX_CODEX_FIRST_LINE_BYTES: usize = 1024 * 1024;

static PROJECT_CODE_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-code-(.+)$").unwrap());
static PROJECT_HOME_PREFIX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^-home-[^-]+-").unwrap());

fn project_label(slug: &str) -> String {
    if slug.is_empty() {
        return String::new();
    }
    if let Some(caps) = PROJECT_CODE_SUFFIX.captures(slug) {
        if let Some(m) = caps.get(1) {
            let suffix = m.as_str();
            if !suffix.is_empty() {
                return suffix.to_string();
            }
        }
    }
    PROJECT_HOME_PREFIX.replace(slug, "").to_string()
}

fn shorten_project_path(path: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let with_tilde = path.replace(&home, "~");
    with_tilde
        .strip_prefix("~/code/")
        .map(str::to_string)
        .unwrap_or(with_tilde)
}

pub(crate) fn normalize_project_folder(project: &str) -> String {
    let trimmed = project.trim();
    if trimmed.is_empty() {
        return "(unknown)".to_string();
    }

    let mut label = project_label(trimmed);
    if label.is_empty() {
        label = trimmed.to_string();
    }

    let shortened = shorten_project_path(&label);
    if !shortened.is_empty() {
        label = shortened;
    }

    if label.contains('/') {
        label = label.rsplit('/').next().unwrap_or(&label).to_string();
    }

    if label.is_empty() {
        "(unknown)".to_string()
    } else {
        label
    }
}

/// Read through the first newline with a hard byte cap (mirrors JS readFirstJsonlLineFromFd).
fn read_first_jsonl_line(file: &mut fs::File, max_bytes: usize) -> Option<String> {
    const CHUNK_SIZE: usize = 65536;
    let mut offset = 0usize;
    let mut acc = Vec::new();
    let mut buf = [0u8; CHUNK_SIZE];

    while offset < max_bytes {
        let to_read = std::cmp::min(buf.len(), max_bytes - offset);
        let n = match file.read(&mut buf[..to_read]) {
            Ok(0) => break,
            Ok(n) => n,
            Err(_) => return None,
        };
        offset += n;

        if let Some(pos) = buf[..n].iter().position(|&b| b == b'\n') {
            acc.extend_from_slice(&buf[..pos]);
            return String::from_utf8(acc).ok();
        }
        acc.extend_from_slice(&buf[..n]);
    }

    if acc.is_empty() {
        None
    } else {
        String::from_utf8(acc).ok()
    }
}

pub(crate) fn extract_codex_project(path: &Path) -> String {
    let mut file = match fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return "codex".to_string(),
    };

    let first_line = match read_first_jsonl_line(&mut file, MAX_CODEX_FIRST_LINE_BYTES) {
        Some(line) => line,
        None => return "codex".to_string(),
    };
    let first_line = first_line.trim_end_matches(['\r', '\n']);
    if first_line.is_empty() {
        return "codex".to_string();
    }

    let json: serde_json::Value = match serde_json::from_str(first_line) {
        Ok(v) => v,
        Err(_) => return "codex".to_string(),
    };

    if json.get("type").and_then(|v| v.as_str()) == Some("session_meta") {
        if let Some(cwd) = json
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .and_then(|c| c.as_str())
        {
            return normalize_project_folder(cwd);
        }
        return "(unknown)".to_string();
    }

    "codex".to_string()
}

/// Codex rollouts under `root`. Each project comes from the rollout's first line:
/// taken from `cache` when the file's size and mtime match, otherwise read (in
/// parallel). Returns the sessions in walk order and whether `cache` changed.
fn scan_codex(
    root: &str,
    filter: Option<&str>,
    cache: Option<&mut ScanMetaCache>,
) -> (Vec<Session>, bool) {
    let mut files = Vec::new();
    for entry in WalkDir::new(root) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let file_name = path.file_name().and_then(|f| f.to_str()).unwrap_or("");
        if !file_name.ends_with(".jsonl") || !file_name.starts_with("rollout-") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if !metadata.is_file() {
            continue;
        }
        files.push((path, metadata));
    }

    let known = cache
        .as_ref()
        .and_then(|c| c.codex.get(root))
        .map(|m| m.len())
        .unwrap_or(0);
    let cached = cache.as_ref().and_then(|c| c.codex.get(root));
    let stamps: Vec<Option<(u64, u64)>> = files.iter().map(|(_, m)| file_stamp(m)).collect();
    let mut projects: Vec<Option<String>> = files
        .iter()
        .zip(&stamps)
        .map(|((path, _), stamp)| {
            let (size, mtime) = (*stamp)?;
            let (c_size, c_mtime, project) = cached?.get(path.to_str()?)?;
            (*c_size == size && *c_mtime == mtime).then(|| project.clone())
        })
        .collect();
    let misses: Vec<usize> = (0..files.len()).filter(|&i| projects[i].is_none()).collect();
    let read: Vec<String> = misses
        .par_iter()
        .map(|&i| extract_codex_project(&files[i].0))
        .collect();
    for (&i, project) in misses.iter().zip(read) {
        projects[i] = Some(project);
    }

    let mut changed = false;
    if let Some(cache) = cache {
        let mut entries = HashMap::with_capacity(files.len());
        for (((path, _), stamp), project) in files.iter().zip(&stamps).zip(&projects) {
            if let (Some((size, mtime)), Some(path), Some(project)) = (stamp, path.to_str(), project) {
                entries.insert(path.to_string(), (*size, *mtime, project.clone()));
            }
        }
        // Changed: a file was read that can be cached, or a cached file is gone.
        let cacheable_read = misses
            .iter()
            .any(|&i| stamps[i].is_some() && files[i].0.to_str().is_some());
        changed = cacheable_read || entries.len() != known;
        if changed {
            cache.codex.insert(root.to_string(), entries);
        }
    }

    let mut sessions = Vec::new();
    for ((path, metadata), project) in files.iter().zip(projects) {
        let project = project.unwrap_or_default();
        if filter.map_or(true, |f| project.contains(f)) {
            sessions.push(make_session(path, &project, "codex", metadata, None));
        }
    }
    (sessions, changed)
}

pub(crate) fn scan_factory(root: &str, filter: Option<&str>) -> Vec<Session> {
    let mut sessions = Vec::new();
    let root_path = Path::new(root);

    if !root_path.exists() {
        return sessions;
    }

    for entry in WalkDir::new(root).max_depth(2) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if !metadata.is_file() {
            continue;
        }

        let rel = match path.strip_prefix(root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let components: Vec<_> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();

        if components.len() != 2 {
            continue;
        }

        let workspace = &components[0];
        let project = normalize_project_folder(workspace);

        if filter.map_or(true, |f| project.contains(f) || workspace.contains(f)) {
            sessions.push(make_session(&path, &project, "factory", &metadata, None));
        }
    }

    sessions
}

pub(crate) fn decode_grok_workspace(encoded: &str) -> String {
    urlencoding::decode(encoded)
        .map(|s| s.into_owned())
        .unwrap_or_else(|_| encoded.to_string())
}

pub(crate) fn scan_grok(root: &str, filter: Option<&str>) -> Vec<Session> {
    scan_grok_family(root, filter, "grok")
}

/// Grok-layout sessions (<root>/<enc-cwd>/<id>/chat_history.jsonl) labelled `source`
/// ("grok" for ~/.grok/sessions, "vktr" for ~/.vktr/sessions).
pub(crate) fn scan_grok_family(root: &str, filter: Option<&str>, source: &str) -> Vec<Session> {
    let mut sessions = Vec::new();
    let root_path = Path::new(root);

    if !root_path.exists() {
        return sessions;
    }

    for entry in WalkDir::new(root).max_depth(3) {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if path.file_name().and_then(|f| f.to_str()) != Some("chat_history.jsonl") {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };

        if !metadata.is_file() {
            continue;
        }

        let rel = match path.strip_prefix(root_path) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let components: Vec<_> = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().to_string())
            .collect();

        if components.len() != 3 {
            continue;
        }

        let workspace_encoded = &components[0];
        let session_dir = &components[1];
        let decoded_workspace = decode_grok_workspace(workspace_encoded);

        let project_display = normalize_project_folder(&decoded_workspace);

        if filter.map_or(true, |f| {
            project_display.contains(f) || decoded_workspace.contains(f)
        }) {
            let session_path = path.parent().unwrap_or(&path).to_string_lossy().to_string();
            let mtime = metadata
                .modified()
                .map(system_time_to_chrono)
                .unwrap_or_else(|_| chrono::DateTime::from_timestamp(0, 0).unwrap());

            sessions.push(Session {
                path: session_path,
                project: project_display,
                file: session_dir.clone(),
                source: source.to_string(),
                size: metadata.len(),
                mtime,
                parent_session: None,
                title: None,
            });
        }
    }

    sessions
}

pub(crate) fn scan_opencode(root: &str, filter: Option<&str>) -> Vec<Session> {
    let mut sessions = Vec::new();

    let conn = match Connection::open(root) {
        Ok(c) => c,
        Err(_) => return sessions,
    };

    let mut stmt = match conn.prepare(
        "SELECT s.id, s.title, s.directory, s.version, s.time_created, s.time_updated, \
         (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) as msg_count \
         FROM session s \
         WHERE (SELECT COUNT(*) FROM message m WHERE m.session_id = s.id) >= 3 \
         ORDER BY s.time_updated DESC \
         LIMIT 10000",
    ) {
        Ok(s) => s,
        Err(_) => return sessions,
    };

    let rows = stmt.query_map([], |row| {
        let id: String = row.get(0)?;
        let title: Option<String> = row.get(1).ok();
        let directory: Option<String> = row.get(2).ok();

        let time_created_val: rusqlite::types::Value = row.get(4)?;
        let time_created = match time_created_val {
            rusqlite::types::Value::Text(s) => s,
            rusqlite::types::Value::Integer(i) => i.to_string(),
            _ => String::new(),
        };

        let time_updated_val: rusqlite::types::Value =
            row.get(5).ok().unwrap_or(rusqlite::types::Value::Null);
        let time_updated = match time_updated_val {
            rusqlite::types::Value::Text(s) => Some(s),
            rusqlite::types::Value::Integer(i) => Some(i.to_string()),
            _ => None,
        };

        let msg_count: i64 = row.get(6)?;

        let dir = directory.unwrap_or_default();
        let project_display = normalize_project_folder(&dir);

        let ts_str = time_updated.as_ref().unwrap_or(&time_created);
        let mtime = parse_opencode_timestamp(ts_str)
            .unwrap_or_else(|| chrono::DateTime::from_timestamp(0, 0).unwrap());

        let path = match host_id_from_imported_root(root) {
            Some(host) => format!("opencode://{}/{}", host, id),
            None => format!("opencode://{}", id),
        };

        Ok(Session {
            path,
            project: project_display.clone(),
            file: id.clone(),
            source: "opencode".to_string(),
            size: (msg_count * 1024) as u64,
            mtime,
            parent_session: None,
            title,
        })
    });

    if let Ok(rows) = rows {
        for row in rows {
            if let Ok(session) = row {
                if filter.map_or(true, |f| {
                    session.project.contains(f)
                        || session.file.contains(f)
                        || session.path.contains(f)
                }) {
                    sessions.push(session);
                }
            }
        }
    }

    sessions
}
