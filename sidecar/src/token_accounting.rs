use crate::types::IndexEntry;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::ops::{Deref, DerefMut};

/// Billing weights retain per-request prices independently of displayed tokens.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub(crate) struct BillingTokens {
    pub input: f64,
    pub output: f64,
    #[serde(rename = "cacheHit")]
    pub cache_hit: f64,
    #[serde(rename = "cacheWrite")]
    pub cache_write: f64,
    #[serde(rename = "cacheWrite1h")]
    pub cache_write_1h: f64,
}

impl BillingTokens {
    pub fn add(&mut self, t: &[i64; 5], model: &str) {
        let long_model = ["gpt-6.1-sol", "gpt-5.6-sol"].iter().any(|prefix| {
            model.strip_prefix(prefix).is_some_and(|suffix| suffix.is_empty() || suffix.starts_with('-'))
        });
        let long = long_model && t[0] > 272_000;
        self.input += t[0] as f64 * if long { 2.0 } else { 1.0 };
        self.output += t[1] as f64 * if long { 1.5 } else { 1.0 };
        self.cache_hit += t[2] as f64 * if long { 2.0 } else { 1.0 };
        self.cache_write += t[3] as f64 * if long { 2.0 } else { 1.0 };
        self.cache_write_1h += t[4] as f64;
    }
}

/// Cost metadata extends the index without changing its base metadata contract.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct CostIndexEntry {
    #[serde(flatten)]
    pub meta: IndexEntry,
    #[serde(
        rename = "billingTokens",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub billing_tokens: Option<BillingTokens>,
}

impl From<IndexEntry> for CostIndexEntry {
    fn from(meta: IndexEntry) -> Self {
        Self {
            meta,
            billing_tokens: None,
        }
    }
}
impl Deref for CostIndexEntry {
    type Target = IndexEntry;
    fn deref(&self) -> &IndexEntry {
        &self.meta
    }
}
impl DerefMut for CostIndexEntry {
    fn deref_mut(&mut self) -> &mut IndexEntry {
        &mut self.meta
    }
}

/// Return only the growth of usage repeated across Claude content fragments.
pub(crate) fn claude_usage_delta(record: &Value, seen: &mut HashMap<String, [i64; 5]>) -> [i64; 5] {
    let msg = &record["message"];
    let u = msg.get("usage")
        .or_else(|| record.get("usage"))
        .unwrap_or(&Value::Null);
    let base = u["input_tokens"].as_i64().unwrap_or(0);
    let read = u["cache_read_input_tokens"].as_i64().unwrap_or(0);
    let write = u["cache_creation_input_tokens"].as_i64().unwrap_or(0);
    let tokens = [
        base + read + write,
        u["output_tokens"].as_i64().unwrap_or(0),
        read,
        write,
        u["cache_creation"]["ephemeral_1h_input_tokens"]
            .as_i64()
            .unwrap_or(0),
    ];
    let Some(id) = msg["id"].as_str() else {
        return tokens;
    };
    let key = serde_json::to_string(&(record["requestId"].as_str().unwrap_or(""), id)).unwrap();
    let prev = seen.entry(key).or_insert([0; 5]);
    let mut delta = [0; 5];
    for i in 0..5 {
        let next = prev[i].max(tokens[i]);
        delta[i] = next - prev[i];
        prev[i] = next;
    }
    delta
}
