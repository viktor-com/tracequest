//! `near` subcommand: the raw-file scan behind the CLI's near-words re-rank.
//!
//! Byte-exact port of `nearTermScorer`'s per-file work in
//! `src/sessions/scan-queries.js` (search-ranking facts): find every needle
//! at token boundaries in the first `maxBytes` of each file, ignore hits in
//! Codex's own injected lines, split hits into runs at most `gap` bytes apart,
//! count runs with two or more query words (verbatim copies of the query once
//! per file) and note whether a copy follows a `search`/`handoff` command word.
//! Files are scanned in parallel. Node turns each result into the score with
//! its own float expression, so scores are bit-identical to the JS scanner;
//! weights arrive as f64 bit patterns so no decimal parse can round them.

use memchr::memmem::Finder;
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NearRequest {
    /// `[q, prefix, hex bytes]` in the JS needle order (hit ties keep it).
    pub needles: Vec<(usize, bool, String)>,
    /// Per-term IDF weights as hex `f64::to_bits`, indexed by q.
    pub weights: Vec<String>,
    /// The verbatim query as UTF-16 code units (JS string indices), if any.
    pub verbatim: Option<Vec<u16>>,
    /// ` words of the verbatim query ` (JS `verbatimWords`), if any.
    pub verbatim_words: Option<String>,
    pub gap: i64,
    pub max_bytes: u64,
    /// `[path, isCodex]`.
    pub files: Vec<(String, bool)>,
}

/// Per-file result: best run weight, counted runs, ran a search for the query.
#[derive(Serialize, Debug, Clone, Copy, PartialEq)]
pub struct NearResult(pub f64, pub u64, pub bool);

pub struct NearSpec {
    needles: Vec<(usize, bool, Finder<'static>)>,
    weights: Vec<f64>,
    verbatim: Option<Vec<u16>>,
    word_offsets: Vec<usize>,
    verbatim_words: Option<Finder<'static>>,
    gap: i64,
    max_bytes: u64,
}

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 {
        return Err(format!("odd hex length: {s}"));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

impl NearSpec {
    pub fn new(req: &NearRequest) -> Result<NearSpec, String> {
        let mut needles = Vec::with_capacity(req.needles.len());
        for (q, prefix, hex) in &req.needles {
            let bytes = decode_hex(hex)?;
            if bytes.is_empty() {
                return Err("empty needle".into());
            }
            needles.push((*q, *prefix, Finder::new(&bytes).into_owned()));
        }
        let weights = req
            .weights
            .iter()
            .map(|h| u64::from_str_radix(h, 16).map(f64::from_bits).map_err(|e| e.to_string()))
            .collect::<Result<Vec<f64>, String>>()?;
        if needles.iter().any(|(q, _, _)| *q >= weights.len()) {
            return Err("needle term out of range".into());
        }
        // JS treats an empty verbatim string as no verbatim query.
        let verbatim = req.verbatim.clone().filter(|v| !v.is_empty());
        let mut word_offsets = Vec::new();
        if let Some(v) = &verbatim {
            for i in 0..v.len() {
                if i == 0 || v[i - 1] == b' ' as u16 {
                    word_offsets.push(i);
                }
            }
        }
        let verbatim_words = if verbatim.is_some() {
            req.verbatim_words.as_ref().map(|w| Finder::new(w.as_bytes()).into_owned())
        } else {
            None
        };
        Ok(NearSpec {
            needles,
            weights,
            verbatim,
            word_offsets,
            verbatim_words,
            gap: req.gap,
            max_bytes: req.max_bytes,
        })
    }
}

fn is_alnum(c: u8) -> bool {
    c.is_ascii_alphanumeric()
}

/// Token boundary before byte i, as `isTokenBoundary` in scan-queries.js.
fn is_token_boundary(buf: &[u8], i: usize) -> bool {
    if i == 0 || i >= buf.len() {
        return true;
    }
    let a = buf[i - 1];
    let b = buf[i];
    if !is_alnum(a) || !is_alnum(b) {
        return true;
    }
    b.is_ascii_uppercase() && !a.is_ascii_uppercase()
}

/// JS `String.prototype.toLowerCase` of one latin1-decoded byte.
fn latin1_lower(b: u8) -> u8 {
    match b {
        b'A'..=b'Z' => b + 32,
        0xC0..=0xDE if b != 0xD7 => b + 32,
        _ => b,
    }
}

fn find_overlapping(finder: &Finder, hay: &[u8], mut f: impl FnMut(usize)) {
    let mut from = 0;
    while from < hay.len() {
        match finder.find(&hay[from..]) {
            Some(p) => {
                f(from + p);
                from += p + 1;
            }
            None => break,
        }
    }
}

const MMAP_MIN_BYTES: u64 = 512 * 1024;

const RE_TEXT: &[u8] = b"\"text\":\"";

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    memchr::memmem::find(hay, needle).is_some()
}

/// `"text":"(?:# AGENTS\.md instructions|<)` anywhere in `head`.
fn injected_user_text(head: &[u8]) -> bool {
    let mut found = false;
    let finder = Finder::new(RE_TEXT);
    find_overlapping(&finder, head, |p| {
        let rest = &head[p + RE_TEXT.len()..];
        if rest.starts_with(b"# AGENTS.md instructions") || rest.starts_with(b"<") {
            found = true;
        }
    });
    found
}

/// Byte ranges `[start, end)` of Codex's own lines, as `codexInjectedRanges`.
pub fn codex_injected_ranges(buf: &[u8]) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < buf.len() {
        let end = memchr::memchr(b'\n', &buf[start..]).map_or(buf.len(), |p| start + p);
        let head = &buf[start..end.min(start + 400)];
        if contains(head, b"\"type\":\"session_meta\"")
            || contains(head, b"\"type\":\"turn_context\"")
            || contains(head, b"\"role\":\"developer\"")
            || (contains(head, b"\"role\":\"user\"") && injected_user_text(head))
        {
            ranges.push((start, end));
        }
        start = end + 1;
    }
    ranges
}

/// `SEARCH_CALL_RE` (`(?:^|[^a-z0-9_-])(?:search|handoff)[\s\\"'\`]+$`) on the lowercased latin1 text.
fn is_search_call(s: &[u8]) -> bool {
    // JS `\s` within latin1: \t \n \v \f \r space NBSP.
    let is_tail = |b: u8| matches!(b, 9..=13 | b' ' | 0xA0 | b'\\' | b'"' | b'\'' | b'`');
    let mut k = s.len();
    while k > 0 && is_tail(s[k - 1]) {
        k -= 1;
    }
    if k == s.len() {
        return false;
    }
    let body = &s[..k];
    [&b"search"[..], &b"handoff"[..]].iter().any(|word| {
        if body.len() < word.len() || !body[body.len() - word.len()..].eq_ignore_ascii_case(word) {
            return false;
        }
        let before = body.len() - word.len();
        before == 0 || {
            let c = body[before - 1];
            !(c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
        }
    })
}

#[derive(Default)]
struct FileState {
    best: f64,
    runs: u64,
    copies: u64,
    searched: bool,
}

impl NearSpec {
    fn is_copy(&self, buf: &[u8], run_start: usize, run_end: usize) -> bool {
        let Some(v) = &self.verbatim else { return false };
        let vlen = v.len();
        let exact = self.word_offsets.iter().any(|&o| {
            if run_start < o || run_start - o + vlen < run_end {
                return false;
            }
            let from = run_start - o;
            let to = (from + vlen).min(buf.len());
            to - from == vlen && buf[from..to].iter().zip(v).all(|(&b, &u)| latin1_lower(b) as u16 == u)
        });
        if exact {
            return true;
        }
        let Some(words) = &self.verbatim_words else { return false };
        let mut text = Vec::with_capacity(run_end - run_start + 2);
        text.push(b' ');
        let mut in_gap = false;
        for &b in &buf[run_start..run_end] {
            let l = latin1_lower(b);
            if l.is_ascii_lowercase() || l.is_ascii_digit() {
                text.push(l);
                in_gap = false;
            } else if !in_gap {
                text.push(b' ');
                in_gap = true;
            }
        }
        text.push(b' ');
        words.find(&text).is_some()
    }

    fn scan_buf(&self, buf: &[u8], skip: Option<&[(usize, usize)]>, st: &mut FileState) {
        let mut hits: Vec<(usize, usize, usize)> = Vec::new();
        for (q, prefix, finder) in &self.needles {
            let len = finder.needle().len();
            find_overlapping(finder, buf, |i| {
                let end = i + len;
                if !is_token_boundary(buf, i) || (!prefix && !is_token_boundary(buf, end)) {
                    return;
                }
                hits.push((i, end, *q));
            });
        }
        if hits.len() < 2 {
            return;
        }
        hits.sort_by_key(|h| h.0); // stable, like Array.prototype.sort
        let mut in_run = vec![false; self.weights.len()];
        let mut run_start = 0usize;
        let mut run_end: Option<usize> = None;
        let mut run_terms = 0u32;
        let mut run_weight = 0f64;
        let close_run = |st: &mut FileState, run_start: usize, run_end: Option<usize>, run_terms: u32, run_weight: f64| {
            if run_terms < 2 {
                return;
            }
            let run_end = run_end.unwrap_or(0);
            let copy = self.is_copy(buf, run_start, run_end);
            if copy && !st.searched {
                let from = run_start.saturating_sub(24);
                let lowered: Vec<u8> = buf[from..run_start].iter().map(|&b| latin1_lower(b)).collect();
                st.searched = is_search_call(&lowered);
            }
            if copy {
                let prior = st.copies;
                st.copies += 1;
                if prior > 0 {
                    return;
                }
            }
            st.runs += 1;
            if run_weight > st.best {
                st.best = run_weight;
            }
        };
        let mut skip_at = 0usize;
        for &(start, end, q) in &hits {
            if let Some(skip) = skip {
                while skip_at < skip.len() && skip[skip_at].1 <= start {
                    skip_at += 1;
                }
                if skip_at < skip.len() && skip[skip_at].0 <= start {
                    continue;
                }
            }
            if run_end.map_or(true, |e| start as i64 - e as i64 > self.gap) {
                close_run(st, run_start, run_end, run_terms, run_weight);
                in_run.iter_mut().for_each(|x| *x = false);
                run_start = start;
                run_terms = 0;
                run_weight = 0.0;
            }
            if !in_run[q] {
                in_run[q] = true;
                run_weight += self.weights[q];
                run_terms += 1;
            }
            run_end = Some(run_end.map_or(end, |e| e.max(end)));
        }
        close_run(st, run_start, run_end, run_terms, run_weight);
    }

    /// Scan one file's prefix; Err when it cannot be read (Node then rescans it in JS).
    pub fn scan_file(&self, path: &str, codex: bool) -> std::io::Result<NearResult> {
        let f = File::open(path)?;
        let len = f.metadata()?.len().min(self.max_bytes);
        // Large files are mapped rather than copied (as the indexer does past 512 KB).
        if len > MMAP_MIN_BYTES {
            // SAFETY: read-only map of a session file; agents only append to them.
            let map = unsafe { memmap2::MmapOptions::new().len(len as usize).map(&f)? };
            return Ok(self.scan_bytes(&map, codex));
        }
        let mut buf = Vec::with_capacity(len as usize);
        f.take(len).read_to_end(&mut buf)?;
        Ok(self.scan_bytes(&buf, codex))
    }

    pub fn scan_bytes(&self, buf: &[u8], codex: bool) -> NearResult {
        let skip = if codex { Some(codex_injected_ranges(buf)) } else { None };
        let mut st = FileState::default();
        self.scan_buf(buf, skip.as_deref(), &mut st);
        NearResult(st.best, st.runs, st.searched)
    }
}

/// Results in file order; `None` for a file that could not be read.
pub fn near(req: &NearRequest) -> Result<Vec<Option<NearResult>>, String> {
    let spec = NearSpec::new(req)?;
    Ok(req
        .files
        .par_iter()
        .map(|(path, codex)| spec.scan_file(path, *codex).ok())
        .collect())
}
