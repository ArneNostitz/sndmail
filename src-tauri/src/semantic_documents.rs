//! sndmail's semantic-search document pipeline, ported from the TypeScript
//! indexer so the Rust manager can build passage documents directly:
//!
//! - `scripts/semantic-search/providers/sndmail.ts` — the SQL, the document
//!   fields (id/tags/metadata/title/subtitle/snippet/content), the
//!   trimmed-body-with-snippet-fallback rule and the 100000/1000000 limits.
//! - `scripts/semantic-search/passages.ts` — `SEMANTIC_VERSION` and the
//!   byte-budgeted passage splitter (320-byte windows, 32-byte title prefix,
//!   96-byte overlap, sentence/word-boundary preference).
//! - `scripts/semantic-search/typesense.ts` — the message-level semantic
//!   fingerprint (same fields, same order, same hash construction).
//! - `src/utils/messageTrim.ts` — only `trimTextBody` (the pure text path);
//!   the HTML/DOM trimmers stay on the JavaScript side.
//!
//! One deliberate approximation: `readableBody`'s html-to-text conversion
//! (used only when a message has no usable plain-text body) has no exact
//! Rust equivalent, so `convert_html_to_text` below approximates it.

use fancy_regex::Regex as JsRegex;
use serde_json::{json, Value as Json};
use sha2::{Digest, Sha256};
use sqlx::Row;
use std::sync::OnceLock;

pub const SEMANTIC_VERSION: &str = "e5-small-384-byte320-title32-overlap96-v2";

// passages.ts constants, ported exactly.
const CONTENT_BYTES: usize = 320;
const TITLE_BYTES: usize = 32;
const OVERLAP_BYTES: usize = 96;

// sndmail.ts limits.
const BODY_INDEX_UNITS: usize = 100000;
const BODY_SQL_CHARS: i64 = 1000000;
const SNIPPET_UNITS: usize = 600;
const SOURCE: &str = "sndmail";
const APP: &str = "sndmail";
const NO_SUBJECT: &str = "(No Subject)";
const FALLBACK_FOLDER: &str = "Mail";

// The collect query from sndmail.ts, ported verbatim: same joins, filters
// and columns, including the JavaScript String.trim whitespace set that
// decides which body a message actually has. The TypeScript batches five
// rows at a time through the sqlite3 CLI (a maxBuffer workaround for the
// child process); sqlx reads the whole scan in one query, so the rowid
// cursor and LIMIT clause are the only parts not carried over.
const COLLECT_SQL: &str = "
SELECT m.rowid, m.id, m.account_id, m.thread_id, m.subject,
  m.from_name, m.from_address, m.to_addresses, m.snippet,
  substr(m.body_text, 1, 1000000) AS body_text,
  CASE WHEN length(trim(COALESCE(m.body_text,''), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0
    THEN NULL ELSE substr(m.body_html, 1, 1000000) END AS body_html,
  length(CASE WHEN length(trim(COALESCE(m.body_text,''), char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0
    THEN m.body_text ELSE COALESCE(m.body_html,'') END) AS body_length,
  a.email AS account_email,
  (SELECT GROUP_CONCAT(COALESCE(l.name, tl.label_id), ', ')
    FROM thread_labels tl LEFT JOIN labels l ON l.account_id = tl.account_id AND l.id = tl.label_id
    WHERE tl.account_id = m.account_id AND tl.thread_id = m.thread_id) AS labels
FROM messages m JOIN accounts a ON a.id = m.account_id
ORDER BY m.rowid";

// JavaScript \s as an explicit class: the regex crates' \s is Unicode
// White_Space, which excludes U+FEFF that JavaScript's \s includes.
const JS_WS_CLASS: &str = r"[\x{9}\x{a}\x{b}\x{c}\x{d}\x{20}\x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]";

// A row of the collect query, mirrored from sndmail.ts's MailRow usage.
// `from` is the sender as sndmail.ts builds it ([from_name, from_address]
// joined with a space); `labels` holds the label names (the GROUP_CONCAT
// output split on ", " with empties dropped, as the tags are built);
// `labels_raw` keeps the GROUP_CONCAT output verbatim for metadata.labels;
// `folder` is that raw string, or "Mail" when there are no labels.
#[derive(Debug, Clone)]
pub struct RawMessage {
    pub account_id: String,
    pub account_email: String,
    // sndmail.ts stores the account email as metadata.accountName.
    pub account_name: String,
    pub thread_id: String,
    // The internal message id (messages.id), not the RFC Message-ID header.
    pub message_id: String,
    pub from: String,
    pub to: Option<String>,
    pub subject: Option<String>,
    pub snippet: Option<String>,
    pub body_text: Option<String>,
    pub body_html: Option<String>,
    pub body_length: i64,
    pub labels: Vec<String>,
    pub labels_raw: String,
    pub folder: String,
}

// One passage of one message, ready for the vector store: the splitter's
// title-prefixed content plus the message-level fields every passage
// carries (same shapes as the UniversalDocument in sndmail.ts). The
// position of a passage in the returned Vec is its passage_index.
#[derive(Debug, Clone)]
pub struct PassageDoc {
    pub id: String,
    // Message-level fingerprint from typesense.ts, identical on every
    // passage of the same message.
    pub message_fingerprint: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub snippet: String,
    // Passage content, title-prefixed per passages.ts.
    pub content: String,
    pub tags: Vec<String>,
    pub metadata: Json,
    pub account_id: String,
    pub thread_id: String,
    pub message_id: String,
}

// ---------------------------------------------------------------- hashing

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

// The parts of JSON.stringify output the pipeline hashes: strings, a
// number, null, and one nested array of strings.
enum JsonPart<'a> {
    Str(&'a str),
    Null,
    Num(u32),
    Arr(&'a [String]),
}

fn push_json_string(out: &mut String, value: &str) {
    out.push('"');
    for character in value.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            // JSON.stringify leaves U+2028/U+2029 and all other non-control
            // characters unescaped.
            control if (control as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", control as u32));
            }
            other => out.push(other),
        }
    }
    out.push('"');
}

// JSON.stringify for the flat array shapes hashed here, byte-for-byte like
// Node's output (compact separators, JS escaping, no lone-surrogate input).
fn js_json(parts: &[JsonPart<'_>]) -> String {
    let mut out = String::from("[");
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match part {
            JsonPart::Str(value) => push_json_string(&mut out, value),
            JsonPart::Null => out.push_str("null"),
            JsonPart::Num(value) => out.push_str(&value.to_string()),
            JsonPart::Arr(items) => {
                out.push('[');
                for (j, item) in items.iter().enumerate() {
                    if j > 0 {
                        out.push(',');
                    }
                    push_json_string(&mut out, item);
                }
                out.push(']');
            }
        }
    }
    out.push(']');
    out
}

// Document id from sndmail.ts: sha256 of JSON.stringify(["sndmail",
// account_id, message id]).
fn document_id(account_id: &str, message_id: &str) -> String {
    sha256_hex(&js_json(&[
        JsonPart::Str(SOURCE),
        JsonPart::Str(account_id),
        JsonPart::Str(message_id),
    ]))
}

// Passage id from passages.ts: sha256 of JSON.stringify([document id,
// generation, passage index]).
fn passage_id(doc_id: &str, generation: &str, index: u32) -> String {
    sha256_hex(&js_json(&[
        JsonPart::Str(doc_id),
        JsonPart::Str(generation),
        JsonPart::Num(index),
    ]))
}

// Message-level fingerprint from typesense.ts: sha256 of JSON.stringify(
// [SEMANTIC_VERSION, title, content, snippet, subtitle, tags, source, app]).
fn message_fingerprint(
    title: &str,
    content: &str,
    snippet: &str,
    subtitle: Option<&str>,
    tags: &[String],
) -> String {
    sha256_hex(&js_json(&[
        JsonPart::Str(SEMANTIC_VERSION),
        JsonPart::Str(title),
        JsonPart::Str(content),
        JsonPart::Str(snippet),
        subtitle.map(JsonPart::Str).unwrap_or(JsonPart::Null),
        JsonPart::Arr(tags),
        JsonPart::Str(SOURCE),
        JsonPart::Str(APP),
    ]))
}

// -------------------------------------------------- UTF-16 (JS strings)

// JavaScript strings are UTF-16; every index the TS pipeline computes
// (slice bounds, byteLength-vs-length budgets, lastIndexOf) is in UTF-16
// code units, so the splitter runs on unit slices.

fn utf16_units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

fn from_units(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

// text.slice(start, end) by UTF-16 code units. A cut that lands inside a
// surrogate pair (only possible at the 100000/600-unit limits) is replaced
// with U+FFFD — Rust strings cannot hold the lone surrogate JS would.
fn slice_units(text: &str, start: usize, end: usize) -> String {
    let units = utf16_units(text);
    let end = end.min(units.len());
    let start = start.min(end);
    from_units(&units[start..end])
}

fn is_ws_unit(unit: u16) -> bool {
    matches!(unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680
        | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

// UTF-8 byte length of a UTF-16 unit slice, surrogate pairs counted once.
fn units_utf8_len(units: &[u16]) -> usize {
    let mut total = 0;
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        if (0xd800..0xdc00).contains(&unit)
            && i + 1 < units.len()
            && (0xdc00..0xe000).contains(&units[i + 1])
        {
            total += 4;
            i += 2;
        } else {
            total += char::from_u32(unit as u32).unwrap_or('\u{fffd}').len_utf8();
            i += 1;
        }
    }
    total
}

// passages.ts prefixLength: the UTF-16 length of the longest prefix of
// whole code points whose UTF-8 encoding fits in `bytes`.
fn prefix_length_units(units: &[u16], bytes: usize) -> usize {
    let mut length = 0;
    let mut used = 0;
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        let (code_units, size) = if (0xd800..0xdc00).contains(&unit)
            && i + 1 < units.len()
            && (0xdc00..0xe000).contains(&units[i + 1])
        {
            (2, 4)
        } else {
            (1, char::from_u32(unit as u32).unwrap_or('\u{fffd}').len_utf8())
        };
        if used + size > bytes {
            break;
        }
        used += size;
        length += code_units;
        i += code_units;
    }
    length
}

// The 32-byte title prefix, as a String.
fn byte_prefix(text: &str, bytes: usize) -> String {
    let units = utf16_units(text);
    let length = prefix_length_units(&units, bytes);
    from_units(&units[..length])
}

// ------------------------------------------------------ JS whitespace

fn is_js_whitespace(character: char) -> bool {
    matches!(character,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' '
        | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}'
        | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

// JavaScript String.prototype.trim / trimEnd cover this set.
fn trim_js(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

fn trim_js_end(text: &str) -> &str {
    text.trim_end_matches(is_js_whitespace)
}

// text.replace(/\s+/g, " "): every run of JavaScript whitespace becomes
// one space. Equivalent to headerScore's two-stage replace in messageTrim.ts
// ([\u00a0\r\n]+ then \s+), which nets out to the same single collapse.
fn collapse_js_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_run = false;
    for character in text.chars() {
        if is_js_whitespace(character) {
            in_run = true;
        } else {
            if in_run && !out.is_empty() {
                out.push(' ');
            }
            in_run = false;
            out.push(character);
        }
    }
    out
}

// ------------------------------------------------------- trimTextBody

#[derive(Debug, Clone, PartialEq)]
pub struct TrimResult {
    pub text: String,
    pub trimmed: bool,
    pub empty: bool,
}

// Static pattern registry. These patterns delegate to the regex engine and
// cannot fail at match time; an Err is treated as "no match" so a broken
// line can never take the trim down (the TS test() is total, too).
fn matches(re: &JsRegex, text: &str) -> bool {
    re.is_match(text).unwrap_or(false)
}

// CUT_PATTERNS from messageTrim.ts, in the same order. \s is written as the
// explicit JavaScript whitespace class (the regex crates' \s excludes
// U+FEFF), \w as the ASCII class JavaScript uses, and \b as an ASCII-word
// negative lookbehind — exactly what a JS \b asserts in front of these
// literal words.
fn cut_patterns() -> &'static [JsRegex] {
    static PATTERNS: OnceLock<Vec<JsRegex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let ws = JS_WS_CLASS;
        let word = r"(?<![0-9A-Za-z_])";
        let sources = [
            format!(r"(?i)^On{ws}[\s\S]{{6,240}}?{word}wrote:"),
            format!(r"(?i)^Am{ws}[\s\S]{{6,240}}?{word}schrieb[^:]{{0,140}}:"),
            format!(r"(?i)^Le{ws}[\s\S]{{6,240}}?{word}a écrit{ws}*:"),
            format!(r"(?i)^El{ws}[\s\S]{{6,240}}?{word}escribió:"),
            format!(r"(?i)^-{{2,}}{ws}*Original Message{ws}*-{{2,}}"),
            format!(r"(?i)^-{{2,}}{ws}*Forwarded message{ws}*-{{2,}}"),
            format!(r"(?i)^-{{3,}}{ws}*Urspr(?:ü|ue)ngliche Nachricht{ws}*-{{3,}}"),
            r"^_{10,}".to_string(),
            r"(?i)^Sent from my [0-9A-Za-z_]+".to_string(),
            r"(?i)^Gesendet von meinem [0-9A-Za-z_]+".to_string(),
            r"(?i)^Von meinem i(?:Phone|Pad) gesendet".to_string(),
            r"(?i)^Envoyé de mon [0-9A-Za-z_]+".to_string(),
            r"(?i)^Get Outlook for [0-9A-Za-z_]+".to_string(),
            format!(r"^--{ws}*$"),
        ];
        sources
            .iter()
            .map(|source| {
                JsRegex::new(source)
                    .unwrap_or_else(|error| panic!("static trim pattern must compile: {source}: {error}"))
            })
            .collect()
    })
}

// SIGNATURE_SEPARATOR from messageTrim.ts: /^--\s?$/.
fn signature_separator() -> &'static JsRegex {
    static PATTERN: OnceLock<JsRegex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        JsRegex::new(&format!(r"^--{JS_WS_CLASS}?$"))
            .unwrap_or_else(|error| panic!("static signature separator must compile: {error}"))
    })
}

// HEADER_LABELS from messageTrim.ts in Object.values order: from, to,
// date, subject.
fn header_label_patterns() -> &'static [JsRegex] {
    static PATTERNS: OnceLock<Vec<JsRegex>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        let ws = JS_WS_CLASS;
        let sources = [
            format!(r"(?i)(?:^|{ws})(?:von|from):"),
            format!(r"(?i)(?:^|{ws})(?:an|to|cc):"),
            format!(r"(?i)(?:^|{ws})(?:datum|date|gesendet|sent):"),
            format!(r"(?i)(?:^|{ws})(?:betreff|subject):"),
        ];
        sources
            .iter()
            .map(|source| {
                JsRegex::new(source)
                    .unwrap_or_else(|error| panic!("static header pattern must compile: {source}: {error}"))
            })
            .collect()
    })
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct HeaderScore {
    score: u32,
    has_from: bool,
    has_to: bool,
    has_date: bool,
    has_subject: bool,
}

// headerScore from messageTrim.ts: whitespace-collapsed text scores one
// point per recognized Outlook/Apple Mail header label.
fn header_score(text: &str) -> HeaderScore {
    let collapsed = collapse_js_whitespace(text);
    let normalized = trim_js(&collapsed);
    let patterns = header_label_patterns();
    let has_from = matches(&patterns[0], &normalized);
    let has_to = matches(&patterns[1], &normalized);
    let has_date = matches(&patterns[2], &normalized);
    let has_subject = matches(&patterns[3], &normalized);
    let score = [has_from, has_to, has_date, has_subject]
        .iter()
        .filter(|flag| **flag)
        .count() as u32;
    HeaderScore { score, has_from, has_to, has_date, has_subject }
}

// text.split(/\r?\n/): \r\n or a lone \n separates; a lone \r does not.
fn split_lines(text: &str) -> Vec<&str> {
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0;
    for i in 0..bytes.len() {
        if bytes[i] == b'\n' {
            let line_end = if i > start && bytes[i - 1] == b'\r' { i - 1 } else { i };
            lines.push(&text[start..line_end]);
            start = i + 1;
        }
    }
    lines.push(&text[start..]);
    lines
}

/// Drop quoted lines, attribution lines and signatures from a plain-text
/// body — the `trimTextBody` port from `src/utils/messageTrim.ts`.
pub fn trim_text_body(text: &str) -> TrimResult {
    let lines = split_lines(text);
    let mut cut = lines.len();

    for (i, raw) in lines.iter().enumerate() {
        let line = trim_js(raw);
        if matches(signature_separator(), line) || cut_patterns().iter().any(|p| matches(p, line)) {
            cut = i;
            break;
        }
        // A run of ">" quoting with nothing but quotes after it.
        if line.starts_with('>')
            && lines[i..].iter().all(|l| {
                let t = trim_js(l);
                t.is_empty() || t.starts_with('>')
            })
        {
            cut = i;
            break;
        }
        let current_header = header_label_patterns().iter().any(|p| matches(p, line));
        if !current_header {
            continue;
        }
        // Header labels pasted without quote markup count only when paired:
        // from + to + (date or subject) within a six-line window.
        let window_end = (i + 6).min(lines.len());
        let header = header_score(&lines[i..window_end].join(" "));
        if header.score >= 3 && header.has_from && header.has_to && (header.has_date || header.has_subject) {
            cut = i;
            break;
        }
    }

    if cut == lines.len() {
        return TrimResult {
            text: text.to_string(),
            trimmed: false,
            empty: trim_js(text).is_empty(),
        };
    }
    let kept = trim_js_end(&lines[..cut].join("\n")).to_string();
    let empty = trim_js(&kept).is_empty();
    TrimResult { text: kept, trimmed: true, empty }
}

// ------------------------------------------------------- readableBody

// plain.replace(/\r\n?/g, "\n").
fn normalize_newlines(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

// Approximation of the html-to-text `convert` call in sndmail.ts's
// readableBody (the one part of the TS pipeline without an exact Rust
// equivalent): script/style/img contents are dropped, anchor text is kept
// without its URL, block boundaries become newlines and common entities
// are decoded. html-to-text's layout passes (tables, wrapping, link
// formatting) are not replicated, so an html-only body can yield slightly
// different words than the TS indexer produced for the same message.
fn convert_html_to_text(html: &str) -> String {
    // limits.maxInputLength: 1000000 characters of input.
    let html = if html.chars().count() > 1_000_000 {
        let cut = html.char_indices().nth(1_000_000).map(|(i, _)| i).unwrap_or(html.len());
        &html[..cut]
    } else {
        html
    };
    let bytes = html.as_bytes();
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'<' => {
                // Naive tag scan: the first '>' ends the tag (a '>' inside
                // an attribute value would truncate it — harmless here).
                let Some(offset) = bytes[i..].iter().position(|&b| b == b'>') else { break };
                let gt = i + offset;
                let tag = &html[(i + 1).min(gt)..gt];
                let name = tag_name(tag);
                let closing = tag.starts_with('/');
                if (name == "script" || name == "style") && !closing {
                    i = skip_until_close(html, gt + 1, &name);
                } else {
                    if is_block_tag(&name) {
                        out.push('\n');
                    }
                    i = gt + 1;
                }
            }
            b'&' => match decode_entity(&html[i..]) {
                Some((text, consumed)) => {
                    out.push_str(&text);
                    // `consumed` is an offset into the remaining text from
                    // `i`, not an absolute position — advancing by it keeps
                    // the cursor moving forward (assigning it directly would
                    // loop forever re-decoding the same entity).
                    i += consumed;
                }
                None => {
                    out.push('&');
                    i += 1;
                }
            },
            _ => {
                let next = bytes[i + 1..]
                    .iter()
                    .position(|&b| b == b'<' || b == b'&')
                    .map(|p| i + 1 + p)
                    .unwrap_or(bytes.len());
                out.push_str(&html[i..next]);
                i = next;
            }
        }
    }
    out
}

fn tag_name(tag: &str) -> String {
    tag.trim_start_matches('/')
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_block_tag(name: &str) -> bool {
    matches!(name,
        "p" | "div" | "br" | "table" | "thead" | "tbody" | "tfoot" | "tr" | "td" | "th"
        | "li" | "ul" | "ol" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "blockquote"
        | "pre" | "section" | "article" | "aside" | "header" | "footer" | "nav" | "dl"
        | "dt" | "dd" | "hr" | "address" | "figure" | "figcaption" | "main" | "form" | "fieldset")
}

fn skip_until_close(html: &str, from: usize, name: &str) -> usize {
    let bytes = html.as_bytes();
    let wanted = format!("</{name}");
    let mut i = from;
    while i < bytes.len() {
        if bytes[i] == b'<' {
            let mut j = i + 1;
            let mut k = 0;
            while k < wanted.len() && j < bytes.len() && bytes[j].eq_ignore_ascii_case(&wanted.as_bytes()[k]) {
                j += 1;
                k += 1;
            }
            if k == wanted.len() {
                return match bytes[j..].iter().position(|&b| b == b'>') {
                    Some(offset) => j + offset + 1,
                    None => bytes.len(),
                };
            }
        }
        i += 1;
    }
    bytes.len()
}

fn decode_entity(text: &str) -> Option<(String, usize)> {
    let bytes = text.as_bytes();
    let end = bytes[..bytes.len().min(12)].iter().position(|&b| b == b';')?;
    if end < 2 {
        return None;
    }
    let body = &text[1..end];
    let decoded = match body {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        "nbsp" => "\u{a0}".to_string(),
        // The Latin-1 accents and symbols that dominate real mail bodies
        // (html-to-text decodes every named entity via `he`; this table
        // approximates it with the common ones).
        "Agrave" => "À".to_string(),
        "Aacute" => "Á".to_string(),
        "Acirc" => "Â".to_string(),
        "Atilde" => "Ã".to_string(),
        "Auml" => "Ä".to_string(),
        "Aring" => "Å".to_string(),
        "AElig" => "Æ".to_string(),
        "Ccedil" => "Ç".to_string(),
        "Egrave" => "È".to_string(),
        "Eacute" => "É".to_string(),
        "Ecirc" => "Ê".to_string(),
        "Euml" => "Ë".to_string(),
        "Igrave" => "Ì".to_string(),
        "Iacute" => "Í".to_string(),
        "Icirc" => "Î".to_string(),
        "Iuml" => "Ï".to_string(),
        "ETH" => "Ð".to_string(),
        "Ntilde" => "Ñ".to_string(),
        "Ograve" => "Ò".to_string(),
        "Oacute" => "Ó".to_string(),
        "Ocirc" => "Ô".to_string(),
        "Otilde" => "Õ".to_string(),
        "Ouml" => "Ö".to_string(),
        "Oslash" => "Ø".to_string(),
        "Ugrave" => "Ù".to_string(),
        "Uacute" => "Ú".to_string(),
        "Ucirc" => "Û".to_string(),
        "Uuml" => "Ü".to_string(),
        "Yacute" => "Ý".to_string(),
        "THORN" => "Þ".to_string(),
        "szlig" => "ß".to_string(),
        "agrave" => "à".to_string(),
        "aacute" => "á".to_string(),
        "acirc" => "â".to_string(),
        "atilde" => "ã".to_string(),
        "auml" => "ä".to_string(),
        "aring" => "å".to_string(),
        "aelig" => "æ".to_string(),
        "ccedil" => "ç".to_string(),
        "egrave" => "è".to_string(),
        "eacute" => "é".to_string(),
        "ecirc" => "ê".to_string(),
        "euml" => "ë".to_string(),
        "igrave" => "ì".to_string(),
        "iacute" => "í".to_string(),
        "icirc" => "î".to_string(),
        "iuml" => "ï".to_string(),
        "eth" => "ð".to_string(),
        "ntilde" => "ñ".to_string(),
        "ograve" => "ò".to_string(),
        "oacute" => "ó".to_string(),
        "ocirc" => "ô".to_string(),
        "otilde" => "õ".to_string(),
        "ouml" => "ö".to_string(),
        "oslash" => "ø".to_string(),
        "ugrave" => "ù".to_string(),
        "uacute" => "ú".to_string(),
        "ucirc" => "û".to_string(),
        "uuml" => "ü".to_string(),
        "yacute" => "ý".to_string(),
        "thorn" => "þ".to_string(),
        "yuml" => "ÿ".to_string(),
        "ndash" => "–".to_string(),
        "mdash" => "—".to_string(),
        "lsquo" => "\u{2018}".to_string(),
        "rsquo" => "\u{2019}".to_string(),
        "ldquo" => "\u{201c}".to_string(),
        "rdquo" => "\u{201d}".to_string(),
        "sbquo" => "\u{201a}".to_string(),
        "bdquo" => "\u{201e}".to_string(),
        "hellip" => "…".to_string(),
        "bull" => "•".to_string(),
        "middot" => "·".to_string(),
        "deg" => "°".to_string(),
        "plusmn" => "±".to_string(),
        "times" => "×".to_string(),
        "divide" => "÷".to_string(),
        "laquo" => "«".to_string(),
        "raquo" => "»".to_string(),
        "iexcl" => "¡".to_string(),
        "iquest" => "¿".to_string(),
        "sect" => "§".to_string(),
        "para" => "¶".to_string(),
        "copy" => "©".to_string(),
        "reg" => "®".to_string(),
        "trade" => "™".to_string(),
        "euro" => "€".to_string(),
        "pound" => "£".to_string(),
        "yen" => "¥".to_string(),
        "cent" => "¢".to_string(),
        "curren" => "¤".to_string(),
        "frac12" => "½".to_string(),
        "frac14" => "¼".to_string(),
        "frac34" => "¾".to_string(),
        "sup1" => "¹".to_string(),
        "sup2" => "²".to_string(),
        "sup3" => "³".to_string(),
        "ordf" => "ª".to_string(),
        "ordm" => "º".to_string(),
        "larr" => "←".to_string(),
        "rarr" => "→".to_string(),
        "minus" => "−".to_string(),
        _ => {
            let code = if let Some(hex) = body.strip_prefix("#x").or_else(|| body.strip_prefix("#X")) {
                u32::from_str_radix(hex, 16).ok()?
            } else if let Some(dec) = body.strip_prefix('#') {
                dec.parse().ok()?
            } else {
                return None;
            };
            char::from_u32(code)?.to_string()
        }
    };
    Some((decoded, end + 1))
}

// readableBody from sndmail.ts: a usable plain-text body wins (with its
// line endings normalized); only a missing/blank one falls back to the
// HTML body, converted to text.
fn readable_body(plain: Option<&str>, html: Option<&str>) -> String {
    if let Some(plain) = plain {
        if !trim_js(plain).is_empty() {
            return normalize_newlines(plain);
        }
    }
    convert_html_to_text(html.unwrap_or(""))
}

// -------------------------------------------------- passage splitting

// The sentence/paragraph boundary regex from passages.ts:
// /[.!?]["')\]]?\s+|\n\s*\n/g, with JS \s as the explicit class.
fn sentence_boundary_pattern() -> &'static JsRegex {
    static PATTERN: OnceLock<JsRegex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        JsRegex::new(&format!(r#"[.!?]["')\]]?{JS_WS_CLASS}+|\n{JS_WS_CLASS}*\n"#))
            .unwrap_or_else(|error| panic!("static sentence boundary pattern must compile: {error}"))
    })
}

// The windowing loop of documentPassages, on UTF-16 units: returns
// (start, end) pairs for every window, including windows whose trimmed
// text is empty (those are skipped when yielding passages, but the next
// window still starts from them).
fn passage_windows(text: &str, context: &str) -> Vec<(usize, usize)> {
    let units = utf16_units(text);
    let budget = CONTENT_BYTES - context.as_bytes().len() - 1;
    let mut windows = Vec::new();
    let mut start = 0;
    while start < units.len() {
        let mut end = start + prefix_length_units(&units[start..], budget);
        if end < units.len() {
            let window = &units[start..end];
            let window_str = from_units(window);
            // Prefer the last sentence/paragraph end in the latter third.
            let mut sentence_end = 0;
            for result in sentence_boundary_pattern().find_iter(&window_str) {
                let Ok(m) = result else { break };
                let boundary = utf16_len(&window_str[..m.end()]);
                if boundary as f64 >= (window.len() * 2) as f64 / 3.0 {
                    sentence_end = boundary;
                }
            }
            // Otherwise end at a word boundary in the latter half; long
            // unbroken strings keep the byte-budgeted end.
            let word_end = [
                window.iter().rposition(|&u| u == 0x20),
                window.iter().rposition(|&u| u == 0x0a),
                window.iter().rposition(|&u| u == 0x09),
            ]
            .into_iter()
            .flatten()
            .max();
            if sentence_end != 0 {
                end = start + sentence_end;
            } else if let Some(word_end) = word_end {
                if word_end as f64 > window.len() as f64 / 2.0 {
                    end = start + word_end;
                }
            }
        }
        if end <= start {
            // passages.ts throws "Unable to split a semantic passage." —
            // unreachable while TITLE_BYTES=32 and CONTENT_BYTES=320 (the
            // budget always covers a whole code point); stay loud and stop
            // rather than loop forever or panic.
            log::error!("semantic passage splitter cannot advance past offset {start}");
            break;
        }
        windows.push((start, end));
        if end == units.len() {
            break;
        }
        // Keep 96 bytes of overlap, then align the next start to a whole
        // word when one is nearby. Alignment can reduce the overlap
        // slightly; it never leaves a gap between windows.
        let window = &units[start..end];
        let keep = units_utf8_len(window).saturating_sub(OVERLAP_BYTES).max(1);
        let mut advance = prefix_length_units(window, keep);
        if let Some(next_space) = window[advance..].iter().position(|&u| is_ws_unit(u)) {
            if units_utf8_len(&window[advance..advance + next_space + 1]) <= 24 {
                advance += next_space + 1;
            }
        }
        start += advance.max(1);
    }
    windows
}

// ------------------------------------------------------ collect/build

/// Read every message the TS indexer would read, through the same SQL
/// (same joins, filters and columns). The pool is provided read-only by
/// the manager; this function only queries.
pub async fn collect_messages(pool: &sqlx::SqlitePool) -> Result<Vec<RawMessage>, String> {
    let rows = sqlx::query(COLLECT_SQL)
        .fetch_all(pool)
        .await
        .map_err(|error| format!("Cannot read sndmail messages for the semantic index: {error}"))?;
    let mut messages = Vec::with_capacity(rows.len());
    for row in rows {
        let column = |name: &str| -> Result<Option<String>, String> {
            row.try_get::<Option<String>, _>(name)
                .map_err(|error| format!("Cannot read the {name} of a sndmail message: {error}"))
        };
        let account_email = row
            .try_get::<String, _>("account_email")
            .map_err(|error| format!("Cannot read the account email of a sndmail message: {error}"))?;
        let body_length = row
            .try_get::<i64, _>("body_length")
            .map_err(|error| format!("Cannot read the body length of a sndmail message: {error}"))?;
        let message_id = column("id")?.ok_or("A sndmail message has no id.")?;
        let account_id = column("account_id")?.ok_or("A sndmail message has no account id.")?;
        let thread_id = column("thread_id")?.ok_or("A sndmail message has no thread id.")?;
        let from_name = column("from_name")?;
        let from_address = column("from_address")?;
        // [from_name, from_address].filter(Boolean).join(" ")
        let mut from = String::new();
        if let Some(name) = from_name.filter(|s| !s.is_empty()) {
            from.push_str(&name);
        }
        if let Some(address) = from_address.filter(|s| !s.is_empty()) {
            if !from.is_empty() {
                from.push(' ');
            }
            from.push_str(&address);
        }
        // GROUP_CONCAT output: "" when the thread has no labels.
        let labels_raw = column("labels")?.unwrap_or_default();
        let labels: Vec<String> = labels_raw
            .split(", ")
            .filter(|name| !name.is_empty())
            .map(String::from)
            .collect();
        let folder = if labels_raw.is_empty() {
            FALLBACK_FOLDER.to_string()
        } else {
            labels_raw.clone()
        };
        messages.push(RawMessage {
            account_id,
            account_email: account_email.clone(),
            // sndmail.ts reports the account email as the account name.
            account_name: account_email,
            thread_id,
            message_id,
            from,
            to: column("to_addresses")?,
            subject: column("subject")?,
            snippet: column("snippet")?,
            body_text: column("body_text")?,
            body_html: column("body_html")?,
            body_length,
            labels,
            labels_raw,
            folder,
        });
    }
    Ok(messages)
}

/// Build the passage documents for one message: trim the body to what the
/// sender actually wrote, fall back to the stored snippet for a bare
/// forward, assemble the document fields exactly as sndmail.ts does, then
/// split it into passages exactly as passages.ts does. The position of a
/// passage in the returned Vec is its passage_index.
///
/// Uses SEMANTIC_VERSION as the passage id generation (deterministic ids
/// for a fresh index); `build_passages_in_generation` takes the real scan
/// generation for exact typesense.ts parity.
pub fn build_passages(message: &RawMessage) -> Vec<PassageDoc> {
    build_passages_in_generation(message, SEMANTIC_VERSION)
}

/// `build_passages` with an explicit scan generation, as documentPassages
/// receives it in the TypeScript pipeline.
pub fn build_passages_in_generation(message: &RawMessage, generation: &str) -> Vec<PassageDoc> {
    // ---- the document (collectSndmailDocuments in sndmail.ts) ----
    let readable = readable_body(message.body_text.as_deref(), message.body_html.as_deref());
    let trimmed = trim_text_body(&readable);
    // A mail that trims to nothing (a bare forward) falls back to its
    // snippet so it stays findable by its own words.
    let body_full = if trim_js(&trimmed.text).is_empty() {
        message.snippet.clone().unwrap_or_default()
    } else {
        trimmed.text.clone()
    };
    let body_index_truncated =
        utf16_len(&body_full) > BODY_INDEX_UNITS || message.body_length > BODY_SQL_CHARS;
    let body = slice_units(&body_full, 0, BODY_INDEX_UNITS);
    let snippet = match &message.snippet {
        Some(s) if !s.is_empty() => s.clone(),
        _ => slice_units(&body, 0, SNIPPET_UNITS),
    };
    let doc_id = document_id(&message.account_id, &message.message_id);
    let title = message
        .subject
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| NO_SUBJECT.to_string());
    let subtitle = format!("{} | {} | {}", message.from, message.folder, message.account_email);
    // [sender, to_addresses, body].filter(Boolean).join("\n")
    let mut content_parts: Vec<&str> = Vec::new();
    if !message.from.is_empty() {
        content_parts.push(message.from.as_str());
    }
    if let Some(to) = message.to.as_deref().filter(|t| !t.is_empty()) {
        content_parts.push(to);
    }
    if !body.is_empty() {
        content_parts.push(body.as_str());
    }
    let content = content_parts.join("\n");
    // [account_email, ...labels].filter(Boolean)
    let mut tags: Vec<String> = Vec::with_capacity(message.labels.len() + 1);
    if !message.account_email.is_empty() {
        tags.push(message.account_email.clone());
    }
    tags.extend(message.labels.iter().cloned());
    let metadata = json!({
        "account": message.account_id,
        "accountName": message.account_name,
        "threadId": message.thread_id,
        "messageId": message.message_id,
        "from": message.from,
        "to": message.to,
        "labels": message.labels_raw,
        "folder": message.folder,
        "body_index_truncated": body_index_truncated,
        "body_missing": message.body_length == 0,
    });
    let fingerprint = message_fingerprint(&title, &content, &snippet, Some(&subtitle), &tags);

    // ---- the passages (documentPassages in passages.ts) ----
    let title_norm = trim_js(&collapse_js_whitespace(&title)).to_string();
    let context = byte_prefix(&title_norm, TITLE_BYTES);
    let text = if trim_js(&content).is_empty() {
        // [snippet, subtitle, ...tags, title].filter(Boolean).join("\n")
        let mut fallback: Vec<&str> = Vec::new();
        if !snippet.is_empty() {
            fallback.push(snippet.as_str());
        }
        if !subtitle.is_empty() {
            fallback.push(subtitle.as_str());
        }
        fallback.extend(tags.iter().map(String::as_str));
        if !title_norm.is_empty() {
            fallback.push(title_norm.as_str());
        }
        fallback.join("\n")
    } else {
        trim_js(&content).to_string()
    };
    let units = utf16_units(&text);
    let mut passages = Vec::new();
    let mut index: u32 = 0;
    for (start, end) in passage_windows(&text, &context) {
        let passage = trim_js(&from_units(&units[start..end])).to_string();
        if passage.is_empty() {
            continue;
        }
        let content = if context.is_empty() {
            passage.clone()
        } else {
            format!("{context}\n{passage}")
        };
        passages.push(PassageDoc {
            id: passage_id(&doc_id, generation, index),
            message_fingerprint: fingerprint.clone(),
            title: title.clone(),
            subtitle: Some(subtitle.clone()),
            snippet: snippet.clone(),
            content,
            tags: tags.clone(),
            metadata: metadata.clone(),
            account_id: message.account_id.clone(),
            thread_id: message.thread_id.clone(),
            message_id: message.message_id.clone(),
        });
        index += 1;
    }
    passages
}

// ----------------------------------------------------------------- tests
// The trimTextBody cases mirror src/utils/messageTrim.test.ts one by one
// (the HTML/DOM suites stay on the JavaScript side); the rest pin the
// passage splitter, the id/fingerprint schemes and the SQL.

#[cfg(test)]
mod tests {
    use super::*;

    fn raw_message() -> RawMessage {
        RawMessage {
            account_id: "acct".into(),
            account_email: "arne@example.com".into(),
            account_name: "arne@example.com".into(),
            thread_id: "t1".into(),
            message_id: "m1".into(),
            from: "Arne Nostitz arne@example.com".into(),
            to: Some("sam@example.com".into()),
            subject: Some("Quarterly review".into()),
            snippet: Some("A short note".into()),
            body_text: Some("Hi Sam,\n\nhere is the actual body text for the semantic index.".into()),
            body_html: None,
            body_length: 62,
            labels: vec!["INBOX".into(), "Updates".into()],
            labels_raw: "INBOX, Updates".into(),
            folder: "INBOX, Updates".into(),
        }
    }

    // ---- trimTextBody: every case from messageTrim.test.ts (text path) ----

    #[test]
    fn drops_a_trailing_run_of_quoted_lines() {
        let result = trim_text_body("My reply\n\n> old line\n> another old line");
        assert!(result.trimmed);
        assert_eq!(result.text, "My reply");
    }

    #[test]
    fn drops_everything_from_the_signature_separator() {
        let result = trim_text_body("Body\n\n-- \nArne\nCEO");
        assert!(result.trimmed);
        assert_eq!(result.text, "Body");
    }

    #[test]
    fn drops_an_attribution_line_and_the_quote_under_it() {
        let result = trim_text_body("Sure\nOn Tue, Sep 1, 2026 at 23:27, Arne wrote:\nold");
        assert!(result.trimmed);
        assert_eq!(result.text, "Sure");
    }

    #[test]
    fn drops_a_german_header_block_in_plain_text() {
        let result = trim_text_body(
            "Neue Antwort\n\nVon: me@example.com\nAn: them@example.com\nDatum: 6.10.2026\nBetreff: Re: Hello\n\nAlter gesendeter Text",
        );
        assert_eq!(result.text, "Neue Antwort");
    }

    #[test]
    fn leaves_a_plain_body_untouched() {
        let text = "Nothing to trim here";
        assert_eq!(trim_text_body(text), TrimResult { text: text.into(), trimmed: false, empty: false });
    }

    #[test]
    fn reports_a_text_body_that_is_only_a_quote_as_empty() {
        let result = trim_text_body("> only a quote");
        assert!(result.trimmed);
        assert!(result.empty);
    }

    #[test]
    fn drops_an_apple_mail_footer() {
        let result = trim_text_body("Gehst du ?\nSent from my iPhone\nOn May 8 Arne wrote:");
        assert_eq!(result.text, "Gehst du ?");
    }

    // The two trimMessageBody cases whose behavior is entirely the text
    // path (the wrapper itself stays on the JavaScript side).

    #[test]
    fn falls_back_to_text_when_there_is_no_html() {
        let result = trim_text_body("hi\n> q");
        assert!(result.trimmed);
        assert_eq!(result.text, "hi");
    }

    #[test]
    fn handles_an_empty_message() {
        let result = trim_text_body("");
        assert!(!result.trimmed);
        assert!(result.empty);
    }

    // ---- trimTextBody: extra fidelity cases for the ported patterns ----

    #[test]
    fn leaves_a_quote_shaped_phrase_inside_real_prose_alone() {
        let result = trim_text_body("I asked her about it and she wrote: nothing at all.");
        assert!(!result.trimmed);
    }

    #[test]
    fn keeps_a_quote_run_when_new_text_follows_it() {
        let result = trim_text_body("My reply\n> old line\nnew text");
        assert!(!result.trimmed);
        assert_eq!(result.text, "My reply\n> old line\nnew text");
    }

    #[test]
    fn needs_three_paired_header_labels_to_cut() {
        // from + to alone (score 2) must not cut.
        let result = trim_text_body("New text\nFrom: a@example.com\nTo: b@example.com\nmore new text");
        assert!(!result.trimmed);
        // from + to + date (score 3) cuts.
        let result = trim_text_body(
            "New text\nFrom: a@example.com\nTo: b@example.com\nDate: Tue, 06 Oct 2026\nold sent text",
        );
        assert_eq!(result.text, "New text");
    }

    #[test]
    fn drops_localized_attribution_lines() {
        for text in [
            "Antwort\nAm 1. Oktober 2026 schrieb Arne:\nzitiert",
            "Réponse\nLe 1 octobre 2026, Arne a écrit :\ncité",
            "Respuesta\nEl 1 de octubre de 2026, Arne escribió:\ncita",
        ] {
            let result = trim_text_body(text);
            assert!(result.trimmed, "attribution not cut: {text}");
            assert!(!result.text.contains(':'), "quote kept: {text}");
        }
    }

    #[test]
    fn drops_outlook_forward_headers() {
        for text in [
            "Note\n---- Original Message ----\nold",
            "Note\n---------- Forwarded message ----------\nold",
            "Notiz\n----- Ursprüngliche Nachricht -----\nalt",
            "Notiz\n----- Urspruengliche Nachricht -----\nalt",
            "Note\n____________________\nold",
        ] {
            let result = trim_text_body(text);
            assert!(result.trimmed, "forward header not cut: {text}");
        }
    }

    #[test]
    fn drops_more_mobile_client_footers() {
        for footer in [
            "Gesendet von meinem iPhone",
            "Von meinem iPad gesendet",
            "Envoyé de mon iPhone",
            "Get Outlook for iOS",
        ] {
            let result = trim_text_body(&format!("Neue Nachricht\n{footer}\nOn May 8 Arne wrote:"));
            assert_eq!(result.text, "Neue Nachricht", "footer not cut: {footer}");
        }
    }

    #[test]
    fn keeps_double_dashes_inside_a_line() {
        let result = trim_text_body("some--text\nmore");
        assert!(!result.trimmed);
    }

    #[test]
    fn trims_trailing_blank_lines_above_the_cut() {
        let result = trim_text_body("Body\n\n\n-- \nArne\nCEO");
        assert!(result.trimmed);
        assert_eq!(result.text, "Body");
    }

    #[test]
    fn splits_on_crlf_but_not_lone_cr() {
        let result = trim_text_body("My reply\r\n\r\n> old\r\n> older");
        assert!(result.trimmed);
        assert_eq!(result.text, "My reply");
        // A lone \r does not split lines in JS: the quote run still starts
        // at the first line, so nothing is kept.
        assert!(trim_text_body("> only\ra quote").empty);
    }

    // ---- readableBody ----

    #[test]
    fn prefers_plain_text_and_normalizes_line_endings() {
        assert_eq!(readable_body(Some("plain\r\nbody\rmore"), None), "plain\nbody\nmore");
    }

    #[test]
    fn blank_plain_text_falls_back_to_html() {
        let text = readable_body(Some("  \u{a0} "), Some("<p>Hello <b>there</b></p><script>evil()</script><style>x{}</style>"));
        assert!(text.contains("Hello there"));
        assert!(!text.contains("evil"));
        assert!(!text.contains("x{}"));
    }

    #[test]
    fn decodes_common_html_entities() {
        let text = readable_body(None, Some("<p>Caf&eacute; &#38; &#x263A; &amp;more</p>"));
        assert_eq!(trim_js(&text), "Café & ☺ &more");
    }

    // ---- JSON hashing helpers ----

    #[test]
    fn js_json_escapes_like_json_stringify() {
        let out = js_json(&[
            JsonPart::Str("a\"b\\c\nd\u{1}\u{2028}"),
            JsonPart::Null,
            JsonPart::Arr(&["x".into(), "y".into()]),
            JsonPart::Num(7),
        ]);
        assert_eq!(out, "[\"a\\\"b\\\\c\\nd\\u0001\u{2028}\",null,[\"x\",\"y\"],7]");
    }

    #[test]
    fn ids_use_the_typescript_schemes() {
        let expected_doc = sha256_hex("[\"sndmail\",\"acct\",\"m1\"]");
        assert_eq!(document_id("acct", "m1"), expected_doc);
        let expected_passage = sha256_hex("[\"doc\",\"gen\",0]");
        assert_eq!(passage_id("doc", "gen", 0), expected_passage);
    }

    #[test]
    fn fingerprint_hashes_the_typescript_field_order() {
        // createHash("sha256").update(JSON.stringify([SEMANTIC_VERSION,
        // title, content, snippet, subtitle, tags, source, app]))
        let expected = sha256_hex(
            "[\"e5-small-384-byte320-title32-overlap96-v2\",\"T\",\"C\",\"S\",\"SUB\",[\"a\",\"b\"],\"sndmail\",\"sndmail\"]",
        );
        let tags = vec!["a".to_string(), "b".to_string()];
        assert_eq!(message_fingerprint("T", "C", "S", Some("SUB"), &tags), expected);
        assert_eq!(message_fingerprint("T", "C", "S", None, &tags), sha256_hex(
            "[\"e5-small-384-byte320-title32-overlap96-v2\",\"T\",\"C\",\"S\",null,[\"a\",\"b\"],\"sndmail\",\"sndmail\"]",
        ));
        assert_ne!(message_fingerprint("T2", "C", "S", Some("SUB"), &tags), expected);
    }

    // ---- UTF-16 helpers ----

    #[test]
    fn utf16_helpers_match_javascript_indices() {
        assert_eq!(slice_units("héllo", 0, 3), "hél");
        // A surrogate split becomes U+FFFD (Rust cannot hold the lone
        // surrogate the JS slice would produce).
        assert_eq!(slice_units("😀ab", 0, 1), "\u{fffd}");
        let units = utf16_units("😀a");
        assert_eq!(units_utf8_len(&units), 5);
        assert_eq!(prefix_length_units(&units, 5), 3);
        assert_eq!(prefix_length_units(&units, 4), 2);
        assert_eq!(prefix_length_units(&units, 3), 0);
        assert_eq!(byte_prefix("a😀", 3), "a");
        assert_eq!(byte_prefix("a😀", 5), "a😀");
    }

    // ---- passage splitting ----

    #[test]
    fn semantic_version_constant() {
        assert_eq!(SEMANTIC_VERSION, "e5-small-384-byte320-title32-overlap96-v2");
    }

    #[test]
    fn unbroken_text_windows_are_exact() {
        let text = "a".repeat(1000);
        let windows = passage_windows(&text, "");
        assert_eq!(windows, vec![(0, 319), (223, 542), (446, 765), (669, 988), (892, 1000)]);
    }

    #[test]
    fn windows_prefer_a_word_boundary_without_punctuation() {
        let text = "word ".repeat(100);
        let windows = passage_windows(&text, "");
        // 319-unit window ends at its last space (314); the next start is
        // aligned to the following word, reducing the 96-byte overlap to 94.
        assert_eq!(windows[0], (0, 314));
        assert_eq!(windows[1].0, 220);
        assert!(windows[1].0 < windows[0].1);
    }

    #[test]
    fn windows_prefer_a_sentence_end_in_the_latter_third() {
        let text = "Sentence number one ends here. Sentence number two ends here. ".repeat(20);
        let windows = passage_windows(&text, "");
        let (start, end) = windows[0];
        let units = utf16_units(&text);
        assert!(end < units.len());
        assert!(end < start + 319);
        assert!(end as f64 >= (start + 319) as f64 * 2.0 / 3.0);
        // The window ends right after a ". " boundary.
        assert_eq!(units[end - 1], 0x20);
        assert_eq!(units[end - 2], b'.' as u16);
    }

    #[test]
    fn windows_respect_the_byte_budget_and_never_leave_gaps() {
        let text = "Äpfel und Birnen liegen im Lager, sagt der Bauer. ".repeat(30);
        let context = byte_prefix("Obstkorb-Mitteilung mit einem langen Titel", TITLE_BYTES);
        let windows = passage_windows(&text, &context);
        assert!(windows.len() > 1);
        let budget = CONTENT_BYTES - context.as_bytes().len() - 1;
        let units = utf16_units(&text);
        for (i, &(start, end)) in windows.iter().enumerate() {
            let passage = from_units(&units[start..end]);
            assert!(passage.as_bytes().len() <= budget, "window {i} exceeds the byte budget");
            if i > 0 {
                let previous = windows[i - 1];
                // Never a gap, and always forward progress.
                assert!(start <= previous.1, "window {i} leaves a gap");
                assert!(start > previous.0, "window {i} did not advance");
            }
        }
        assert_eq!(windows.last().unwrap().1, units.len(), "the last window must reach the end");
    }

    #[test]
    fn windows_that_trim_to_nothing_are_skipped() {
        // A run of spaces long enough that whole 320-byte windows fall
        // inside it: those windows trim to nothing, are skipped when
        // passages are yielded, and their passage indices are not consumed.
        let text = format!("a\n{}b\ntail words here", " ".repeat(1000));
        let windows = passage_windows(&text, "");
        assert_eq!(windows, vec![(0, 318), (223, 541), (446, 764), (669, 987), (892, 1019)]);
        let units = utf16_units(&text);
        assert!(
            windows.iter().any(|&(start, end)| trim_js(&from_units(&units[start..end])).is_empty()),
            "expected an all-whitespace window"
        );
        let passages = build_passages(&RawMessage {
            body_text: Some(text),
            ..raw_message()
        });
        // Only the "a" window and the final window survive; the ids stay
        // sequential (0 and 1) because the empty windows take no index.
        assert_eq!(passages.len(), 2);
        for passage in &passages {
            assert!(!trim_js(&passage.content).is_empty());
        }
        let doc = document_id("acct", "m1");
        assert_eq!(passages[0].id, passage_id(&doc, SEMANTIC_VERSION, 0));
        assert_eq!(passages[1].id, passage_id(&doc, SEMANTIC_VERSION, 1));
    }

    // ---- build_passages ----

    #[test]
    fn builds_document_fields_exactly_like_sndmail_ts() {
        let message = raw_message();
        let passages = build_passages(&message);
        assert_eq!(passages.len(), 1);
        let passage = &passages[0];
        assert_eq!(passage.title, "Quarterly review");
        assert_eq!(
            passage.subtitle.as_deref(),
            Some("Arne Nostitz arne@example.com | INBOX, Updates | arne@example.com")
        );
        assert_eq!(passage.snippet, "A short note");
        assert_eq!(passage.tags, vec!["arne@example.com", "INBOX", "Updates"]);
        assert_eq!(passage.account_id, "acct");
        assert_eq!(passage.thread_id, "t1");
        assert_eq!(passage.message_id, "m1");
        // Content = [sender, to, body].filter(Boolean).join("\n").
        let expected_content = "Arne Nostitz arne@example.com\nsam@example.com\nHi Sam,\n\nhere is the actual body text for the semantic index.";
        let context = "Quarterly review";
        assert_eq!(passage.content, format!("{context}\n{expected_content}"));
        // The metadata shape from sndmail.ts.
        assert_eq!(passage.metadata["account"], "acct");
        assert_eq!(passage.metadata["accountName"], "arne@example.com");
        assert_eq!(passage.metadata["threadId"], "t1");
        assert_eq!(passage.metadata["messageId"], "m1");
        assert_eq!(passage.metadata["from"], "Arne Nostitz arne@example.com");
        assert_eq!(passage.metadata["to"], "sam@example.com");
        assert_eq!(passage.metadata["labels"], "INBOX, Updates");
        assert_eq!(passage.metadata["folder"], "INBOX, Updates");
        assert_eq!(passage.metadata["body_index_truncated"], false);
        assert_eq!(passage.metadata["body_missing"], false);
        // The passage id uses the document id + generation + index scheme.
        let doc = document_id("acct", "m1");
        assert_eq!(passage.id, passage_id(&doc, SEMANTIC_VERSION, 0));
        assert_eq!(passage.message_fingerprint, message_fingerprint(
            "Quarterly review", expected_content, "A short note",
            Some("Arne Nostitz arne@example.com | INBOX, Updates | arne@example.com"),
            &["arne@example.com".into(), "INBOX".into(), "Updates".into()],
        ));
    }

    #[test]
    fn a_bare_forward_falls_back_to_its_snippet() {
        let message = RawMessage {
            body_text: Some("> the whole quoted newsletter\n> second quoted line".into()),
            snippet: Some("The forwarded notice text".into()),
            ..raw_message()
        };
        let passages = build_passages(&message);
        assert!(!passages.is_empty());
        // The trimmed body is empty, so the snippet is the body.
        assert!(passages[0].content.contains("The forwarded notice text"));
        assert!(!passages[0].content.contains("quoted newsletter"));
        assert_eq!(passages[0].snippet, "The forwarded notice text");
    }

    #[test]
    fn empty_content_falls_back_to_snippet_subtitle_tags_and_title() {
        // A message with no sender, no recipient, no snippet and a body
        // that is nothing but a quote: passages.ts builds its text from
        // [snippet, subtitle, tags, title].
        let message = RawMessage {
            from: String::new(),
            to: None,
            subject: None,
            snippet: None,
            body_text: Some("> only a quoted forward\n> with no own words".into()),
            labels: vec![],
            labels_raw: String::new(),
            folder: "Mail".into(),
            ..raw_message()
        };
        let passages = build_passages(&message);
        assert!(!passages.is_empty());
        assert_eq!(passages[0].title, "(No Subject)");
        assert!(passages[0].content.starts_with("(No Subject)\n"));
        // The subtitle keeps its template shape " | Mail | …", but the
        // passage itself is trimmed (passages.ts line 66), so the leading
        // space is gone by the time it lands in the content.
        assert!(passages[0].content.contains("| Mail | arne@example.com"));
        assert!(passages[0].content.contains("arne@example.com"));
    }

    #[test]
    fn marks_body_index_truncated() {
        // A body longer than 100000 UTF-16 units.
        let long_body = "x".repeat(100001);
        let message = RawMessage {
            body_text: Some(long_body.clone()),
            body_length: 100001,
            ..raw_message()
        };
        let passages = build_passages(&message);
        assert_eq!(passages[0].metadata["body_index_truncated"], true);
        // The body itself is sliced to 100000 units: it splits into
        // hundreds of passages, none wider than CONTENT_BYTES (a single
        // passage can never hold the whole 100000-unit body).
        assert!(passages.len() > 300);
        assert!(passages.iter().all(|p| p.content.as_bytes().len() <= CONTENT_BYTES));

        // A SQL-side body_length above 1000000 also marks truncation.
        let message = RawMessage {
            body_text: Some("short".into()),
            body_length: 1_000_001,
            ..raw_message()
        };
        let passages = build_passages(&message);
        assert_eq!(passages[0].metadata["body_index_truncated"], true);
    }

    #[test]
    fn snippet_falls_back_to_a_body_slice_when_missing() {
        let message = RawMessage {
            snippet: None,
            body_text: Some("z".repeat(700)),
            ..raw_message()
        };
        let passages = build_passages(&message);
        assert_eq!(passages[0].snippet, "z".repeat(600));
    }

    #[test]
    fn long_bodies_split_into_passages_sharing_one_fingerprint() {
        let message = RawMessage {
            body_text: Some("Filler sentence for the semantic window. ".repeat(80)),
            ..raw_message()
        };
        let passages = build_passages(&message);
        assert!(passages.len() > 1, "expected multiple passages");
        let fingerprint = passages[0].message_fingerprint.clone();
        let doc = document_id("acct", "m1");
        for (i, passage) in passages.iter().enumerate() {
            assert_eq!(passage.message_fingerprint, fingerprint);
            assert_eq!(passage.id, passage_id(&doc, SEMANTIC_VERSION, i as u32));
            assert!(passage.content.starts_with("Quarterly review\n"));
            // context (≤ 32 bytes) + "\n" + passage (≤ 320 - context - 1).
            assert!(passage.content.as_bytes().len() <= CONTENT_BYTES);
        }
        // All ids distinct.
        let ids: std::collections::HashSet<&str> = passages.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids.len(), passages.len());
    }

    #[test]
    fn html_only_bodies_are_indexed_from_their_converted_text() {
        let message = RawMessage {
            body_text: Some("   ".into()), // blank after trim
            body_html: Some("<p>The html-only body text with real words.</p>".into()),
            ..raw_message()
        };
        let passages = build_passages(&message);
        assert!(passages[0].content.contains("The html-only body text with real words."));
    }

    // ---- collect_messages ----

    async fn test_pool() -> sqlx::SqlitePool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("open test database");
        for ddl in [
            "CREATE TABLE accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL)",
            "CREATE TABLE messages (id TEXT NOT NULL, account_id TEXT NOT NULL, thread_id TEXT NOT NULL,
                subject TEXT, from_name TEXT, from_address TEXT, to_addresses TEXT, snippet TEXT,
                body_text TEXT, body_html TEXT, date INTEGER NOT NULL DEFAULT 0)",
            "CREATE TABLE thread_labels (thread_id TEXT NOT NULL, account_id TEXT NOT NULL, label_id TEXT NOT NULL)",
            "CREATE TABLE labels (id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT NOT NULL)",
        ] {
            sqlx::query(ddl).execute(&pool).await.expect("create test schema");
        }
        sqlx::query("INSERT INTO accounts (id, email) VALUES ('acct', 'arne@example.com')")
            .execute(&pool)
            .await
            .expect("insert account");
        sqlx::query("INSERT INTO labels (id, account_id, name) VALUES ('INBOX', 'acct', 'INBOX'), ('UPD', 'acct', 'Updates')")
            .execute(&pool)
            .await
            .expect("insert labels");
        sqlx::query("INSERT INTO thread_labels (thread_id, account_id, label_id) VALUES ('t1', 'acct', 'INBOX'), ('t1', 'acct', 'UPD')")
            .execute(&pool)
            .await
            .expect("insert thread labels");
        for (id, thread, subject, from_name, from_address, to, snippet, body_text, body_html) in [
            ("m1", "t1", Some("Hello"), Some("Arne Nostitz"), "arne@example.com", Some("sam@example.com"), Some("A short note"), Some("Hi Sam,\n\nbody text."), None::<&str>),
            ("m2", "t1", Some("Blank body"), None, "no-reply@example.org", None, None, Some("   "), Some("<p>html body words</p>")),
            ("m3", "t2", None, None, "bot@example.org", None, None, None, None),
        ] {
            sqlx::query(
                "INSERT INTO messages (id, account_id, thread_id, subject, from_name, from_address, to_addresses, snippet, body_text, body_html)
                 VALUES (?1, 'acct', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .bind(id)
            .bind(thread)
            .bind(subject)
            .bind(from_name)
            .bind(from_address)
            .bind(to)
            .bind(snippet)
            .bind(body_text)
            .bind(body_html)
            .execute(&pool)
            .await
            .expect("insert message");
        }
        pool
    }

    #[tokio::test]
    async fn collect_messages_reads_rows_like_sndmail_ts() {
        let pool = test_pool().await;
        let messages = collect_messages(&pool).await.expect("collect messages");
        assert_eq!(messages.len(), 3);
        assert_eq!(messages.iter().map(|m| m.message_id.as_str()).collect::<Vec<_>>(), vec!["m1", "m2", "m3"]);

        let first = &messages[0];
        assert_eq!(first.from, "Arne Nostitz arne@example.com");
        assert_eq!(first.account_email, "arne@example.com");
        assert_eq!(first.account_name, "arne@example.com");
        assert_eq!(first.subject.as_deref(), Some("Hello"));
        assert_eq!(first.labels, vec!["INBOX", "Updates"]);
        assert_eq!(first.labels_raw, "INBOX, Updates");
        assert_eq!(first.folder, "INBOX, Updates");
        // body_text present -> body_html is NULLed by the SQL CASE.
        assert!(first.body_html.is_none());
        assert!(first.body_text.as_deref().is_some_and(|t| t.contains("body text")));
        // SQLite length() of the winning body.
        assert_eq!(first.body_length, "Hi Sam,\n\nbody text.".chars().count() as i64);

        // Blank body_text -> the SQL CASE yields the html body instead.
        let second = &messages[1];
        assert_eq!(second.body_html.as_deref(), Some("<p>html body words</p>"));
        assert_eq!(second.body_length, "<p>html body words</p>".chars().count() as i64);
        assert_eq!(second.from, "no-reply@example.org");
        // m2 shares thread t1, so it carries the same labels.
        assert_eq!(second.folder, "INBOX, Updates");

        // No text, no html and no labels: body_length 0 (body_missing in
        // metadata) and the "Mail" folder fallback.
        let third = &messages[2];
        assert_eq!(third.body_length, 0);
        assert_eq!(third.body_text, None);
        assert_eq!(third.body_html, None);
        assert!(third.labels.is_empty());
        assert_eq!(third.labels_raw, "");
        assert_eq!(third.folder, "Mail");
    }

    #[tokio::test]
    async fn collect_messages_feeds_build_passages_end_to_end() {
        let pool = test_pool().await;
        let messages = collect_messages(&pool).await.expect("collect messages");
        let passages = messages
            .iter()
            .flat_map(build_passages)
            .collect::<Vec<_>>();
        assert!(!passages.is_empty());
        for passage in &passages {
            assert!(!passage.id.is_empty());
            assert_eq!(passage.message_fingerprint.len(), 64);
            assert!(!passage.tags.is_empty());
        }
        // m1 has real body text; m2 falls back to its converted HTML body;
        // m3 has no subject, body, or snippet, so its content is the sender
        // alone, with the "(No Subject)" title context prepended.
        assert!(passages.iter().any(|p| p.message_id == "m1" && p.content.contains("body text")));
        assert!(passages.iter().any(|p| p.message_id == "m2" && p.content.contains("html body words")));
        assert!(passages.iter().any(|p| p.message_id == "m3" && p.content.contains("(No Subject)")));
    }
}
