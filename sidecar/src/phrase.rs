//! `phrase` subcommand: the byte test behind the quoted-phrase check.
//!
//! Exact port of `phraseMayOccurInFile` in `src/sessions/scan-queries.js`
//! (fact flt7): false only when a JSONL file cannot hold a byte-checkable
//! lowercase phrase anywhere the line scan looks. A file may hold it when its
//! bytes contain the phrase ignoring ASCII case, when the phrase has `i` or
//! `k` and the file has the UTF-8 of U+0130 or U+212A, or when the file has a
//! `\uXXXX` escape of a character that lowercases to one of the phrase's
//! characters. Each of those needs the bytes on the matching line itself, so
//! a file that may hold the phrase also answers where its first line that can
//! hold it starts: the line of the first raw match unless an escape or a
//! U+0130/U+212A comes before that line, else 0. Files are read in parallel;
//! an unreadable file answers 0, so the line scan reports it as before.

use memchr::memmem;
use rayon::prelude::*;
use regex::bytes::{Regex, RegexBuilder};
use serde::Deserialize;
use std::fs::File;
use std::io::Read;

#[derive(Deserialize)]
pub struct PhraseRequest {
    /// Lowercase printable ASCII without `"`, `/` and `\` (the caller checks).
    pub phrase: String,
    pub files: Vec<String>,
}

struct PhraseSpec {
    pattern: Regex,
    escape: Regex,
    chars: [bool; 128],
    lowers_to_ascii: bool,
}

fn byte_checkable(phrase: &str) -> bool {
    !phrase.is_empty()
        && phrase
            .bytes()
            .all(|b| (0x20..=0x7e).contains(&b) && b != b'"' && b != b'/' && b != b'\\')
}

impl PhraseSpec {
    fn new(phrase: &str) -> Result<Self, String> {
        if !byte_checkable(phrase) {
            return Err("phrase is not byte-checkable".into());
        }
        let pattern = RegexBuilder::new(&regex::escape(phrase))
            .case_insensitive(true)
            .unicode(false)
            .build()
            .map_err(|e| e.to_string())?;
        let escape = Regex::new(r"\\u([0-9a-fA-F]{4})").map_err(|e| e.to_string())?;
        let mut chars = [false; 128];
        for b in phrase.bytes() {
            chars[b as usize] = true;
        }
        let lowers_to_ascii = chars[b'i' as usize] || chars[b'k' as usize];
        Ok(PhraseSpec { pattern, escape, chars, lowers_to_ascii })
    }

    /// `String.fromCharCode(code).toLowerCase()` is one of the phrase's characters.
    fn escaped_char_in_phrase(&self, code: u32) -> bool {
        if code < 0x80 {
            let lower = (code as u8).to_ascii_lowercase();
            return self.chars[lower as usize];
        }
        // U+212A KELVIN SIGN is the only non-ASCII code point whose lowercase is one ASCII character.
        code == 0x212a && self.chars[b'k' as usize]
    }

    /** A `\uXXXX` escape or U+0130/U+212A in `data` through which a line may hold the phrase. */
    fn has_decoded_route(&self, data: &[u8]) -> bool {
        if self.lowers_to_ascii
            && (memmem::find(data, b"\xc4\xb0").is_some() || memmem::find(data, b"\xe2\x84\xaa").is_some())
        {
            return true;
        }
        if memmem::find(data, b"\\u").is_none() {
            return false;
        }
        for caps in self.escape.captures_iter(data) {
            let hex = std::str::from_utf8(&caps[1]).unwrap_or("0");
            let code = u32::from_str_radix(hex, 16).unwrap_or(0);
            if self.escaped_char_in_phrase(code)
                || (self.lowers_to_ascii && (code == 0x130 || code == 0x212a))
            {
                return true;
            }
        }
        false
    }

    /**
     * -1 when `data` cannot hold the phrase (phraseMayOccurInFile false), else
     * the offset of the first line that can: the start of the line of the
     * first raw match when nothing before that line decodes or lowercases
     * into the phrase, else 0.
     */
    fn first_line(&self, data: &[u8]) -> i64 {
        match self.pattern.find(data) {
            Some(m) => {
                let line = memchr::memrchr(b'\n', &data[..m.start()]).map_or(0, |nl| nl + 1);
                if line > 0 && !self.has_decoded_route(&data[..line]) {
                    line as i64
                } else {
                    0
                }
            }
            None if self.has_decoded_route(data) => 0,
            None => -1,
        }
    }

    #[cfg(test)]
    fn may_occur(&self, data: &[u8]) -> bool {
        self.first_line(data) >= 0
    }
}

/// The file state an answer holds for: size and mtime in nanoseconds ("" when unknown).
fn file_state(file: &File) -> (u64, String) {
    match file.metadata() {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(String::new(), |d| d.as_nanos().to_string());
            (m.len(), mtime)
        }
        Err(_) => (0, String::new()),
    }
}

/// `[first line or -1, size, mtime ns]` of one file; a line offset holds only for that size and mtime.
fn file_first_line(spec: &PhraseSpec, path: &str) -> (i64, u64, String) {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, 0, String::new()),
    };
    let (len, mtime) = file_state(&file);
    if len == 0 {
        return (-1, len, mtime);
    }
    // SAFETY: read-only map of a session file; a file shrinking meanwhile is read as the JS reads it, best effort.
    let first = match unsafe { memmap2::Mmap::map(&file) } {
        Ok(map) => spec.first_line(&map),
        Err(_) => {
            let mut data = Vec::new();
            if file.read_to_end(&mut data).is_err() {
                return (0, len, mtime);
            }
            spec.first_line(&data)
        }
    };
    (first, len, mtime)
}

/// One answer per file, in order: `[-1 (cannot hold the phrase) or the offset of its first line that can, size, mtime ns]`.
pub fn phrase_first_lines(req: &PhraseRequest) -> Result<Vec<(i64, u64, String)>, String> {
    let spec = PhraseSpec::new(&req.phrase)?;
    Ok(req.files.par_iter().map(|path| file_first_line(&spec, path)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn may(phrase: &str, data: &[u8]) -> bool {
        PhraseSpec::new(phrase).unwrap().may_occur(data)
    }

    #[test]
    fn matches_ignoring_ascii_case_only() {
        assert!(may("absolutely right", b"{\"t\":\"You're Absolutely RIGHT\"}"));
        assert!(!may("absolutely right", b"{\"t\":\"absolutely wrong\"}"));
        assert!(!may("let me", b"let\\tme"));
        assert!(may("a.b", b"A.B"));
        assert!(!may("a.b", b"axb"));
    }

    #[test]
    fn escapes_and_case_folding_keep_the_file() {
        assert!(may("you're right", b"you\\u0027re"), "an escape of a phrase character");
        assert!(may("you're right", b"\\u0052"), "an escape of an upper-case phrase letter");
        assert!(!may("you're right", b"\\u0041"), "an escape of another character");
        assert!(may("key", b"\\u212A"), "kelvin sign");
        assert!(may("ink", b"\\u0130"), "dotted capital I");
        assert!(may("key", "\u{212a}".as_bytes()));
        assert!(may("lid", "\u{130}".as_bytes()));
        assert!(!may("lad", "\u{130}".as_bytes()));
    }

    #[test]
    fn first_line_starts_at_the_line_of_the_first_match() {
        let spec = PhraseSpec::new("let me").unwrap();
        assert_eq!(spec.first_line(b"a\nb\nsay LET ME\nlet me"), 4);
        assert_eq!(spec.first_line(b"let me first"), 0);
        assert_eq!(spec.first_line(b"\\u006c\nb\nlet me"), 0, "an escape before the match line");
        assert_eq!(spec.first_line(b"a\nx \\u006c let me"), 2, "an escape on the match line itself");
        assert_eq!(spec.first_line(b"a\nb"), -1);
        assert_eq!(spec.first_line(b"a\n\\u0065"), 0, "only an escape");
    }

    #[test]
    fn rejects_phrases_the_caller_must_not_send() {
        assert!(PhraseSpec::new("a\"b").is_err());
        assert!(PhraseSpec::new("a/b").is_err());
        assert!(PhraseSpec::new("über").is_err());
        assert!(PhraseSpec::new("").is_err());
    }
}
