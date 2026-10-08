//! CLI entrypoints for scan and index subcommands.

use crate::indexer::{build_index, write_index_cache};
use crate::scan::scan;
use crate::types::Session;
use clap::{Parser, Subcommand};
use std::collections::HashSet;
use std::io::Read;
use std::path::PathBuf;

/// tracequest-sidecar — high-performance session scanner and indexer
#[derive(Parser, Debug)]
#[command(name = "tracequest-sidecar")]
#[command(about = "High-performance sidecar for tracequest session scanning and indexing")]
pub struct Cli {
    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
pub enum Commands {
    /// Scan agent data roots for session files
    Scan {
        /// JSON array of root directories to scan
        #[arg(long)]
        roots: String,
        /// Optional project name filter
        #[arg(long)]
        filter: Option<String>,
    },
    /// Build or update the session index
    Index {
        /// Path to the index cache file
        #[arg(long)]
        index_path: PathBuf,
        /// Index format version
        #[arg(long)]
        version: i32,
        /// JSON array of session objects to index (omit when using --sessions-stdin)
        #[arg(long, conflicts_with = "sessions_stdin")]
        sessions_json: Option<String>,
        /// Read session JSON array from stdin (avoids ARG_MAX for large lists)
        #[arg(long)]
        sessions_stdin: bool,
        /// Accepted for backward compatibility — now a no-op. Freshly parsed/search-stale
        /// entries emit termFreqs.
        #[arg(long = "term-freqs", hide = true)]
        term_freqs: bool,
    },
}

pub fn run() {
    let cli = Cli::parse();

    match cli.command {
        Commands::Scan { roots, filter } => {
            let roots: Vec<String> = serde_json::from_str(&roots)
                .expect("--roots must be a valid JSON array of strings");
            let sessions = scan(&roots, filter.as_deref());
            println!("{}", serde_json::to_string(&sessions).unwrap());
        }
        Commands::Index {
            index_path,
            version,
            sessions_json,
            sessions_stdin,
            term_freqs: _,
        } => {
            let raw = if sessions_stdin {
                let mut buf = String::new();
                std::io::stdin()
                    .read_to_string(&mut buf)
                    .expect("failed to read sessions from stdin");
                buf
            } else {
                sessions_json.expect("index requires --sessions-json or --sessions-stdin")
            };

            // Accept either a bare array `[...]` or an object `{"sessions":[...],"searchStale":[...]}`.
            // The object form is the current contract (fact 4hh); bare array kept for tests.
            let (sessions, search_stale_set): (Vec<Session>, HashSet<String>) = {
                let v: serde_json::Value =
                    serde_json::from_str(&raw).expect("stdin must be valid JSON");
                if v.is_array() {
                    let sessions: Vec<Session> = serde_json::from_value(v)
                        .expect("sessions array must be valid Session objects");
                    (sessions, HashSet::new())
                } else {
                    let sessions: Vec<Session> = serde_json::from_value(
                        v.get("sessions")
                            .cloned()
                            .unwrap_or(serde_json::Value::Array(vec![])),
                    )
                    .expect("sessions field must be a valid array of Session objects");
                    let stale: HashSet<String> = v
                        .get("searchStale")
                        .and_then(|a| a.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|s| s.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    (sessions, stale)
                }
            };

            // Fail closed on an unrecognised source (fact z9k): abort the batch
            // BEFORE anything is written or emitted, so a source the indexer does
            // not understand can never be persisted as a fabricated entry. Node
            // treats a non-zero exit as "fall back to the JS indexer", so the run
            // still completes — just without a silently corrupted index.json.
            let index = match build_index(&index_path, version, &sessions, &search_stale_set) {
                Ok(index) => index,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    std::process::exit(2);
                }
            };

            // Write metadata-only cache (no termFreqs) to disk per yb5/9ct.
            if let Err(e) = write_index_cache(&index_path, version, &index) {
                eprintln!("Warning: failed to write index cache: {}", e);
            }

            println!("{}", serde_json::to_string(&index).unwrap());
        }
    }
}
