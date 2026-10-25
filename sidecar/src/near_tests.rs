use crate::near::{codex_injected_ranges, NearRequest, NearResult, NearSpec};

fn hex(s: &str) -> String {
    s.bytes().map(|b| format!("{b:02x}")).collect()
}

/// Needles for lowercase words as JS caseVariants builds them; the last word is a prefix.
fn spec(words: &[&str], weights: &[f64], verbatim: Option<&str>) -> NearSpec {
    let mut needles = vec![];
    for (q, w) in words.iter().enumerate() {
        let mut cap = w.to_string();
        cap[..1].make_ascii_uppercase();
        let mut variants = vec![w.to_string()];
        for v in [cap, w.to_uppercase()] {
            if !variants.contains(&v) {
                variants.push(v);
            }
        }
        for v in variants {
            needles.push((q, q == words.len() - 1, hex(&v)));
        }
    }
    let verbatim_words = verbatim.map(|v| {
        let mut out = String::new();
        let mut gap = false;
        for c in v.chars() {
            if c.is_ascii_lowercase() || c.is_ascii_digit() {
                out.push(c);
                gap = false;
            } else if !gap {
                out.push(' ');
                gap = true;
            }
        }
        format!(" {} ", out.trim())
    });
    let req = NearRequest {
        needles,
        weights: weights.iter().map(|w| format!("{:x}", w.to_bits())).collect(),
        verbatim: verbatim.map(|v| v.encode_utf16().collect()),
        verbatim_words,
        gap: 24,
        max_bytes: 8 << 20,
        files: vec![],
    };
    NearSpec::new(&req).unwrap()
}

const W: [f64; 3] = [1.5, 2.25, 0.75];

#[test]
fn near_counts_runs_of_two_or_more_words() {
    let s = spec(&["codex", "stop", "button"], &W, None);
    let r = s.scan_bytes(b"the Stop button of the Codex run. later: codex alone ... far away stop", false);
    assert_eq!(r, NearResult(1.5 + 2.25 + 0.75, 1, false));
    assert_eq!(s.scan_bytes(b"codex .................................... stop", false), NearResult(0.0, 0, false));
}

#[test]
fn near_respects_token_boundaries_and_prefix_final_word() {
    let s = spec(&["codex", "stop", "button"], &W, None);
    // "stopwatch" is not "stop"; camelCase "codexStop" splits; final word matches as a prefix.
    assert_eq!(s.scan_bytes(b"codex stopwatch", false), NearResult(0.0, 0, false));
    assert_eq!(s.scan_bytes(b"codexStop", false).1, 1);
    assert_eq!(s.scan_bytes(b"stop buttons", false), NearResult(2.25 + 0.75, 1, false));
}

#[test]
fn near_ignores_codex_injected_lines() {
    let s = spec(&["codex", "stop"], &W[..2], None);
    let body = b"{\"type\":\"turn_context\",\"x\":\"codex stop\",\"pad\":\"..............................\"}\n{\"role\":\"user\",\"content\":[{\"text\":\"<env>codex stop ..............................\"}]}\n{\"msg\":\"codex stop\"}";
    assert_eq!(codex_injected_ranges(body).len(), 2);
    assert_eq!(s.scan_bytes(body, true).1, 1);
    assert_eq!(s.scan_bytes(body, false).1, 3);
}

#[test]
fn near_counts_verbatim_copies_once_and_flags_searches() {
    let s = spec(&["codex", "stop", "button"], &W, Some("codex stop button"));
    let r = s.scan_bytes(b"tracequest search \"Codex Stop-button\" ...................... and again codex stop button .............................. the stop button of codex", false);
    assert_eq!(r, NearResult(1.5 + 2.25 + 0.75, 2, true));
    let plain = s.scan_bytes(b"a copy: codex stop button .............................. another CODEX STOP BUTTON", false);
    assert_eq!(plain, NearResult(1.5 + 2.25 + 0.75, 1, false));
}

#[test]
fn near_finds_overlapping_needle_hits() {
    // JS Buffer.indexOf(needle, i + 1) also finds "a-a" at 2 of "a-a-a", which ends the run
    // 2 bytes later, so "b" 24 bytes after that still joins it.
    let s = spec(&["a-a", "b"], &W[..2], None);
    let text = format!("a-a-a{}b", " ".repeat(24));
    assert_eq!(s.scan_bytes(text.as_bytes(), false).1, 1);
}
