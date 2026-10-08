//! Shared types for scan and indexer.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::HashMap;

/// Accept integer or fractional epoch-ms values (truncate toward zero, matching JS Date).
mod ts_milliseconds_flexible {
    use super::*;

    pub fn serialize<S>(
        dt: &chrono::DateTime<chrono::Utc>,
        serializer: S,
    ) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        chrono::serde::ts_milliseconds::serialize(dt, serializer)
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<chrono::DateTime<chrono::Utc>, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum MtimeInput {
            Int(i64),
            Float(f64),
        }

        let ms = match MtimeInput::deserialize(deserializer)? {
            MtimeInput::Int(ms) => ms,
            MtimeInput::Float(ms) => {
                if !ms.is_finite() {
                    return Err(serde::de::Error::custom(
                        "invalid unix timestamp in milliseconds",
                    ));
                }
                ms.trunc() as i64
            }
        };

        chrono::DateTime::from_timestamp_millis(ms)
            .map(|dt| dt.with_timezone(&chrono::Utc))
            .ok_or_else(|| serde::de::Error::custom("invalid unix timestamp in milliseconds"))
    }
}

/// Session metadata returned by scan — shape matches JS findSessions output
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct Session {
    pub path: String,
    pub project: String,
    pub file: String,
    #[serde(rename = "source")]
    pub source: String,
    pub size: u64,
    #[serde(with = "ts_milliseconds_flexible")]
    pub mtime: chrono::DateTime<chrono::Utc>,
    #[serde(rename = "parentSession", skip_serializing_if = "Option::is_none")]
    pub parent_session: Option<String>,
    #[serde(rename = "title", skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// Single sidecar index entry.
///
/// Freshly parsed/search-stale entries emit `termFreqs` on stdout so Node can
/// populate SearchIndex/search.idx, then strip it before index.json is persisted
/// or JS buildIndex returns metadata.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct IndexEntry {
    #[serde(rename = "firstPrompt", skip_serializing_if = "Option::is_none")]
    pub first_prompt: Option<String>,
    #[serde(rename = "model", skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Per-session term-frequency map emitted for freshly parsed/search-stale
    /// entries. Mtime-cache-reused entries may omit it because Node already has
    /// their postings in SearchIndex. Never written to index.json (9ct).
    /// Serialized as {"term": count, ...}.
    #[serde(rename = "termFreqs", skip_serializing_if = "Option::is_none")]
    pub term_freqs: Option<HashMap<String, u32>>,
    #[serde(rename = "tools")]
    pub tools: Vec<String>,
    #[serde(rename = "toolCounts")]
    #[serde(default)]
    pub tool_counts: HashMap<String, i32>,
    #[serde(rename = "chapters")]
    pub chapters: i32,
    #[serde(rename = "totalTokens")]
    pub total_tokens: i64,
    #[serde(rename = "inputTokens")]
    pub input_tokens: i64,
    #[serde(rename = "outputTokens")]
    pub output_tokens: i64,
    #[serde(rename = "cacheReadTokens")]
    pub cache_read_tokens: i64,
    #[serde(rename = "durationMs")]
    pub duration_ms: i64,
    #[serde(rename = "errors")]
    pub errors: i32,
    #[serde(rename = "files")]
    pub files: i32,
    #[serde(rename = "commits")]
    pub commits: i32,
    #[serde(rename = "mtime")]
    pub mtime: i64,
}

/// Top-level index cache structure with version marker
#[derive(Serialize, Deserialize, Debug)]
#[allow(dead_code)]
pub struct IndexCache {
    #[serde(rename = "_v")]
    pub version: i32,
    #[serde(flatten)]
    pub entries: HashMap<String, IndexEntry>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Claude,
    Codex,
    Cursor,
    /// Imported Cursor cloud-agent transcripts (source string "cursor-cloud").
    CursorCloud,
    Factory,
    Grok,
    OpenCode,
}

/// Parse OpenCode DB timestamp strings (RFC3339, SQL datetime, or epoch).
pub(crate) fn parse_opencode_timestamp(ts: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Ok(num) = ts.parse::<i64>() {
        if num > 1_000_000_000_000 {
            return chrono::DateTime::from_timestamp_millis(num)
                .map(|d| d.with_timezone(&chrono::Utc));
        }
        return chrono::DateTime::from_timestamp(num, 0).map(|d| d.with_timezone(&chrono::Utc));
    }
    chrono::DateTime::parse_from_rfc3339(ts)
        .map(|d| d.with_timezone(&chrono::Utc))
        .ok()
        .or_else(|| {
            chrono::NaiveDateTime::parse_from_str(ts, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|ndt| ndt.and_utc())
        })
}
