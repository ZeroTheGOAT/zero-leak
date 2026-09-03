//! §10 — generated files, with provenance that survives the session and a
//! verification that means something.
//!
//! The brief's outputs are an inspection report, an approval note, a procedure,
//! a calculation sheet. Three things have to be true of each one for it to be
//! usable inside a refinery's document trail:
//!
//! 1. **It is a real file of its stated format.** A `.docx` that is actually
//!    Markdown with a renamed extension will open in Word as gibberish, and the
//!    operator will find that out in front of whoever they sent it to. So the
//!    DOCX goes through `docx-rs`, the XLSX through `rust_xlsxwriter` and the PDF
//!    through `printpdf`, and each one is written as a complete package rather
//!    than assembled by string concatenation.
//!
//! 2. **`verified` means the bytes were reopened and parsed.** Generation
//!    returning `Ok` proves the writer did not error; it does not prove the file
//!    on disk is readable. `verify` reopens it with the *reading* half of this
//!    application — the same `zip`/`calamine`/`lopdf` paths §4 uses on documents
//!    the operator supplies — and stores what it found. That is why the note says
//!    "3 sheets, 41 rows" and not "OK".
//!
//! 3. **Its provenance is recorded, not asserted.** `tool_history` is read back
//!    out of the §13 audit log for the run, and `source_document_ids` are
//!    resolved from the paths the operator attached. Neither is assembled from
//!    what the model claimed it did.
//!
//! Everything lands under `settings.artifact_root` and nowhere else. A file name
//! arrives from a language model, which makes it untrusted input: `sanitize_name`
//! is the boundary, and `resolve` re-checks containment afterwards so a name that
//! defeats the sanitiser still cannot escape the folder.

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::db;
use crate::fsops::{tidy, within};
use crate::error::{CoreError, CoreResult};
use crate::state::{new_id, now_ms, AppState};
use crate::types::*;

/// Page geometry, shared by the DOCX and the PDF so the two renderings of the
/// same Markdown are recognisably the same document. A4 with 20 mm margins:
/// metric paper because the operator is in India, and 20 mm because a report
/// that goes into a binder needs the gutter.
const PAGE_W_MM: f32 = 210.0;
const PAGE_H_MM: f32 = 297.0;
const MARGIN_MM: f32 = 20.0;

/// Body text size in points. 10.5 pt Helvetica is the size a two-column
/// inspection table stays legible at without spilling.
const BODY_PT: f32 = 10.5;

/// Longest file name accepted, before the extension. Windows allows 255 for the
/// whole path component; stopping well short leaves room for the folder and for
/// the `.tmp` suffix the atomic write appends.
const MAX_NAME_LEN: usize = 96;

/// Cells past this many per sheet are refused rather than written slowly. Twenty
/// thousand rows across five sheets is a large engineering workbook; a model
/// looping on a row generator would otherwise fill the disk quietly.
const MAX_CELLS: usize = 500_000;

/* ------------------------------------------------------------------ */
/* Names and paths                                                     */
/* ------------------------------------------------------------------ */

/// Extensions this application will write, and the kind each one means.
const EXTENSIONS: &[(&str, ArtifactKind)] = &[
    ("docx", ArtifactKind::Docx),
    ("xlsx", ArtifactKind::Xlsx),
    ("pptx", ArtifactKind::Pptx),
    ("pdf", ArtifactKind::Pdf),
    ("md", ArtifactKind::Markdown),
    ("markdown", ArtifactKind::Markdown),
    ("txt", ArtifactKind::Text),
];

fn extension_for(kind: ArtifactKind) -> &'static str {
    match kind {
        ArtifactKind::Docx => "docx",
        ArtifactKind::Xlsx => "xlsx",
        ArtifactKind::Pptx => "pptx",
        ArtifactKind::Pdf => "pdf",
        ArtifactKind::Markdown => "md",
        ArtifactKind::Text => "txt",
        // Source files keep whatever extension the caller gave them; `.code` is
        // not a file type. `sanitize_name` leaves the extension alone for this
        // kind, so this fallback is only reached for a name with none at all.
        ArtifactKind::Code => "txt",
    }
}

/// Reserved device names on Windows. `CON.docx` is not a file — the OS resolves
/// it to the console device, and the write either fails or goes somewhere the
/// operator will never find.
const RESERVED: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Turns whatever the model asked for into a file name this application is
/// willing to create.
///
/// Deliberately strict. The input is a string a language model produced, and the
/// output is a path this process writes to: `..\..\Windows\System32\drivers\etc\hosts`
/// is a plausible thing for a confused model to emit and must not be a possible
/// thing for it to achieve. Directory separators, drive colons, wildcards and
/// control characters are removed rather than escaped, because an artifact folder
/// with subdirectories in it is not a feature anyone asked for.
///
/// The extension is forced to match the kind for every format that has a fixed
/// one, so a `generate_docx` call naming `report.pdf` produces `report.docx`
/// rather than a Word package that Explorer will hand to a PDF reader.
fn sanitize_name(raw: &str, kind: ArtifactKind) -> CoreResult<String> {
    // Take the last path component, so a name that arrived with directories in it
    // loses them rather than being rejected outright — the model's intent was the
    // file name at the end.
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw).trim();

    let cleaned: String = base
        .chars()
        .map(|c| match c {
            // The Windows-illegal set, plus the ones that are legal but arrive
            // from shell quoting accidents.
            '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\0' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();

    // Trailing dots and spaces are silently stripped by the filesystem, so a
    // name ending in one resolves to a different file than the one recorded.
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if cleaned.is_empty() {
        return Err(CoreError::MalformedToolCall(format!(
            "\"{raw}\" is not a usable file name, so nothing was written. Give a plain name such as \
             inspection-report.{}.",
            extension_for(kind)
        )));
    }

    // Split stem from extension once, on the last dot.
    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() && !e.is_empty() && e.len() <= 8 => {
            (s.to_string(), e.to_ascii_lowercase())
        }
        _ => (cleaned.clone(), String::new()),
    };

    if RESERVED.contains(&stem.to_ascii_lowercase().as_str()) {
        return Err(CoreError::MalformedToolCall(format!(
            "\"{stem}\" is a reserved device name on Windows and cannot be a file. Nothing was \
             written — choose another name."
        )));
    }

    let mut stem: String = stem.chars().take(MAX_NAME_LEN).collect();
    stem = stem.trim_end_matches(['.', ' ']).to_string();
    if stem.is_empty() {
        stem = "artifact".into();
    }

    // Source files keep their own extension — the point of `generate_code` is a
    // `.py` or a `.rs`, and forcing `.txt` would make the result unrunnable.
    let final_ext = if kind == ArtifactKind::Code {
        if ext.is_empty() { "txt".to_string() } else { ext }
    } else {
        extension_for(kind).to_string()
    };

    Ok(format!("{stem}.{final_ext}"))
}

fn kind_from_extension(name: &str) -> Option<ArtifactKind> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    EXTENSIONS.iter().find(|(e, _)| *e == ext).map(|(_, k)| *k)
}

/// Path inside the artifact folder for a sanitised name, with the folder created
/// if it does not exist yet.
///
/// The containment re-check after joining is not redundant with `sanitize_name`:
/// that function is a filter and this one is a boundary, and the boundary is what
/// the guarantee rests on. Belt and braces on a path that a model chose is the
/// right amount of paranoia.
fn resolve(
    st: &AppState,
    file_name: &str,
    workspace_id: Option<&str>,
    session_id: Option<&str>,
) -> CoreResult<(PathBuf, PathBuf)> {
    // App-created projects are containers under `projects/<workspace-id>`.
    // Their generated outputs stay in that same container instead of leaking
    // into the global artifact directory. Legacy externally-added workspaces
    // retain the configured global destination.
    let managed_root = workspace_id.and_then(|id| {
        let ws = st.with_db(|c| db::workspace(c, id)).ok()?;
        let container = crate::registry::sovereign_root().join("projects").join(id);
        let container = std::fs::canonicalize(container).ok()?;
        let workspace = std::fs::canonicalize(ws.path).ok()?;
        if within(&container, &workspace) {
            Some(container.join("artifacts"))
        } else {
            None
        }
    });
    let root_raw = managed_root.unwrap_or_else(|| PathBuf::from(st.settings().artifact_root));
    if root_raw.as_os_str().is_empty() {
        return Err(CoreError::ExecutionFailed(
            "No artifacts folder is configured, so there is nowhere to write. Set one in \
             Settings → Storage."
                .into(),
        ));
    }

    std::fs::create_dir_all(&root_raw).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The artifacts folder \"{}\" could not be created ({e}), so nothing was written.",
            root_raw.display()
        ))
    })?;

    let root = std::fs::canonicalize(&root_raw).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The artifacts folder \"{}\" could not be opened ({e}), so nothing was written.",
            root_raw.display()
        ))
    })?;

    let output_dir = match session_id {
        Some(id)
            if !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') =>
        {
            root.join(id)
        }
        Some(_) => {
            return Err(CoreError::Denied(
                "The chat id is not safe to use as an artifact folder name.".into(),
            ))
        }
        None => root.clone(),
    };
    std::fs::create_dir_all(&output_dir)?;
    let output_dir = std::fs::canonicalize(output_dir)?;
    if !within(&root, &output_dir) {
        return Err(CoreError::Denied(
            "The chat artifact directory resolved outside the configured artifacts root.".into(),
        ));
    }
    let target = output_dir.join(file_name);
    // `canonicalize` needs the file to exist, so the parent is compared instead:
    // a name that survived the sanitiser has no separators, so its parent is the
    // root or the name defeated the sanitiser and this catches it.
    let parent = target.parent().map(std::fs::canonicalize);
    match parent {
        Some(Ok(p)) if p == output_dir => Ok((root, target)),
        _ => Err(CoreError::Denied(format!(
            "\"{file_name}\" does not resolve to a file inside the selected chat's artifacts folder, so \
             nothing was written."
        ))),
    }
}

/// Writes bytes so that the path either holds the complete new file or is
/// untouched.
///
/// A report half-written because the disk filled mid-flush is worse than no
/// report: it opens, shows the first three sections, and looks finished. The
/// temporary file is created beside the target so the rename is within one
/// volume and therefore atomic.
fn write_atomic(target: &Path, bytes: &[u8]) -> CoreResult<()> {
    let tmp = target.with_extension(format!(
        "{}.tmp",
        target.extension().and_then(|e| e.to_str()).unwrap_or("out")
    ));

    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        // Flushed and synced before the rename: on a power loss the rename must
        // not be able to land ahead of the data.
        f.flush()?;
        f.sync_all()?;
        drop(f);
        // Windows `rename` fails if the destination exists, unlike POSIX.
        if target.exists() {
            std::fs::remove_file(target)?;
        }
        std::fs::rename(&tmp, target)
    };

    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        CoreError::ExecutionFailed(format!(
            "{} could not be written ({e}). The existing file, if there was one, is unchanged.",
            target.file_name().and_then(|n| n.to_str()).unwrap_or("The file")
        ))
    })
}

/* ------------------------------------------------------------------ */
/* Markdown → blocks                                                   */
/* ------------------------------------------------------------------ */

/// A run of text with its emphasis. `code` is tracked separately from `bold` and
/// `italic` because it changes the typeface, not the weight — an equipment tag or
/// a file path set in Courier is legible in a way the same string in Helvetica
/// italic is not.
#[derive(Debug, Clone, Default)]
struct Span {
    text: String,
    bold: bool,
    italic: bool,
    code: bool,
}

#[derive(Debug, Clone)]
enum Block {
    Heading(u8, Vec<Span>),
    Para(Vec<Span>),
    /// `(indent level, spans)` per item. Ordered lists carry their number so a
    /// procedure's steps keep the numbering the model chose rather than being
    /// silently renumbered from one.
    Bullets(Vec<(u8, Vec<Span>)>),
    Numbered(Vec<(u8, u32, Vec<Span>)>),
    Table {
        header: Vec<String>,
        rows: Vec<Vec<String>>,
    },
    Code(Vec<String>),
    Quote(Vec<Span>),
    Rule,
}

/// Splits one line of Markdown into emphasis spans.
///
/// Handles `**bold**`, `*italic*`, `_italic_` and `` `code` ``, which is what
/// models actually emit for a report. Nesting is not supported and unmatched
/// markers are left as literal text: showing a stray asterisk is a small
/// cosmetic flaw, and silently swallowing half a sentence looking for its closing
/// marker is not.
/// Closes the run being accumulated. A free function rather than a closure so it
/// does not hold a borrow on `out` across the loop that also pushes to it.
fn flush(out: &mut Vec<Span>, buf: &mut String, bold: bool, italic: bool) {
    if !buf.is_empty() {
        out.push(Span { text: std::mem::take(buf), bold, italic, code: false });
    }
}

fn inline(line: &str) -> Vec<Span> {
    let chars: Vec<char> = line.chars().collect();
    let mut out: Vec<Span> = Vec::new();
    let mut buf = String::new();
    let mut bold = false;
    let mut italic = false;
    let mut i = 0;


    while i < chars.len() {
        let c = chars[i];

        // Escaped marker: the next character is literal.
        if c == '\\' && i + 1 < chars.len() {
            buf.push(chars[i + 1]);
            i += 2;
            continue;
        }

        if c == '`' {
            // Code spans run to the next backtick and take no emphasis parsing
            // inside, which is the whole point of them.
            if let Some(end) = chars[i + 1..].iter().position(|&c| c == '`') {
                flush(&mut out, &mut buf, bold, italic);
                let text: String = chars[i + 1..i + 1 + end].iter().collect();
                if !text.is_empty() {
                    out.push(Span { text, bold, italic, code: true });
                }
                i += end + 2;
                continue;
            }
        }

        if c == '*' && i + 1 < chars.len() && chars[i + 1] == '*' {
            flush(&mut out, &mut buf, bold, italic);
            bold = !bold;
            i += 2;
            continue;
        }

        if (c == '*' || c == '_') && !matches!(chars.get(i + 1), Some('*') | Some('_')) {
            // `snake_case_names` must not turn into italics. An underscore only
            // opens emphasis when it is at a word boundary.
            let boundary = c == '*'
                || i == 0
                || !chars[i - 1].is_alphanumeric()
                || !chars.get(i + 1).is_some_and(|n| n.is_alphanumeric());
            if boundary {
                flush(&mut out, &mut buf, bold, italic);
                italic = !italic;
                i += 1;
                continue;
            }
        }

        buf.push(c);
        i += 1;
    }

    flush(&mut out, &mut buf, bold, italic);
    if out.is_empty() {
        out.push(Span { text: String::new(), ..Default::default() });
    }
    out
}

/// Splits a `| a | b |` row into its cells.
fn table_cells(line: &str) -> Vec<String> {
    let t = line.trim();
    let t = t.strip_prefix('|').unwrap_or(t);
    let t = t.strip_suffix('|').unwrap_or(t);
    t.split('|').map(|c| c.trim().to_string()).collect()
}

/// True for a `|---|:--:|` alignment row, which is structure rather than data.
fn is_table_divider(line: &str) -> bool {
    let t = line.trim();
    t.contains('-')
        && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '))
        && t.chars().filter(|&c| c == '|').count() >= 1
}

/// Markdown to blocks.
///
/// A deliberately small subset: headings, paragraphs, bullet and numbered lists,
/// pipe tables, fenced code, block quotes and horizontal rules. That is what an
/// inspection report is made of, and every construct here renders in all three
/// output formats. A full CommonMark parser would accept footnotes and reference
/// links that the DOCX and PDF writers would then have to drop silently, which
/// is a worse outcome than not accepting them.
fn parse_markdown(src: &str) -> Vec<Block> {
    let lines: Vec<&str> = src.lines().collect();
    let mut out: Vec<Block> = Vec::new();
    let mut i = 0;

    while i < lines.len() {
        let raw = lines[i];
        let line = raw.trim_end();
        let trimmed = line.trim_start();
        let indent = (line.len() - trimmed.len()) as u8 / 2;

        if trimmed.is_empty() {
            i += 1;
            continue;
        }

        /* Fenced code. */
        if let Some(fence) = trimmed.strip_prefix("```").map(|_| "```").or_else(|| {
            trimmed.strip_prefix("~~~").map(|_| "~~~")
        }) {
            let mut body = Vec::new();
            i += 1;
            while i < lines.len() && !lines[i].trim_start().starts_with(fence) {
                body.push(lines[i].to_string());
                i += 1;
            }
            // A fence the model never closed still yields its content: the lines
            // exist, and dropping them would lose the code the report is about.
            if i < lines.len() {
                i += 1;
            }
            out.push(Block::Code(body));
            continue;
        }

        /* Horizontal rule. */
        if trimmed.len() >= 3
            && (trimmed.chars().all(|c| c == '-')
                || trimmed.chars().all(|c| c == '*')
                || trimmed.chars().all(|c| c == '_'))
        {
            out.push(Block::Rule);
            i += 1;
            continue;
        }

        /* ATX heading. */
        if trimmed.starts_with('#') {
            let hashes = trimmed.chars().take_while(|&c| c == '#').count();
            if hashes <= 6 && trimmed.chars().nth(hashes) == Some(' ') {
                let text = trimmed[hashes + 1..].trim().trim_end_matches('#').trim();
                out.push(Block::Heading(hashes as u8, inline(text)));
                i += 1;
                continue;
            }
        }

        /* Pipe table: a header row followed by a divider. */
        if trimmed.contains('|')
            && lines.get(i + 1).is_some_and(|n| is_table_divider(n))
        {
            let header = table_cells(trimmed);
            let mut rows = Vec::new();
            i += 2;
            while i < lines.len() {
                let r = lines[i].trim();
                if r.is_empty() || !r.contains('|') {
                    break;
                }
                let mut cells = table_cells(r);
                // Ragged rows are padded rather than dropped. A row with one
                // missing cell is a typo in the model's output; losing the whole
                // row loses a reading off an inspection sheet.
                cells.resize(header.len().max(cells.len()), String::new());
                rows.push(cells);
                i += 1;
            }
            out.push(Block::Table { header, rows });
            continue;
        }

        /* Block quote. */
        if let Some(rest) = trimmed.strip_prefix("> ").or_else(|| trimmed.strip_prefix(">")) {
            let mut text = rest.trim().to_string();
            i += 1;
            while i < lines.len() {
                let t = lines[i].trim();
                match t.strip_prefix('>') {
                    Some(more) if !t.is_empty() => {
                        text.push(' ');
                        text.push_str(more.trim());
                        i += 1;
                    }
                    _ => break,
                }
            }
            out.push(Block::Quote(inline(&text)));
            continue;
        }

        /* Bullet list. */
        if trimmed.starts_with("- ") || trimmed.starts_with("* ") || trimmed.starts_with("+ ") {
            let mut items = Vec::new();
            while i < lines.len() {
                let l = lines[i].trim_end();
                let t = l.trim_start();
                if !(t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ")) {
                    break;
                }
                let ind = (l.len() - t.len()) as u8 / 2;
                items.push((ind.min(3), inline(t[2..].trim())));
                i += 1;
            }
            out.push(Block::Bullets(items));
            continue;
        }

        /* Numbered list. */
        if let Some((num, rest)) = numbered_item(trimmed) {
            let mut items = Vec::new();
            let mut num = num;
            let mut rest = rest;
            loop {
                let l = lines[i].trim_end();
                let t = l.trim_start();
                let ind = (l.len() - t.len()) as u8 / 2;
                items.push((ind.min(3), num, inline(rest.trim())));
                i += 1;
                match lines.get(i).and_then(|n| numbered_item(n.trim_start())) {
                    Some((n, r)) => {
                        num = n;
                        rest = r;
                    }
                    None => break,
                }
            }
            out.push(Block::Numbered(items));
            continue;
        }

        /* Paragraph: consecutive plain lines, joined. */
        let mut text = trimmed.to_string();
        i += 1;
        while i < lines.len() {
            let t = lines[i].trim();
            if t.is_empty()
                || t.starts_with('#')
                || t.starts_with("- ")
                || t.starts_with("* ")
                || t.starts_with("+ ")
                || t.starts_with('>')
                || t.starts_with("```")
                || t.starts_with("~~~")
                || t.contains('|')
                || numbered_item(t).is_some()
            {
                break;
            }
            text.push(' ');
            text.push_str(t);
            i += 1;
        }
        let _ = indent;
        out.push(Block::Para(inline(&text)));
    }

    out
}

/// `3. text` → `(3, "text")`. Both `.` and `)` are accepted as the delimiter.
fn numbered_item(t: &str) -> Option<(u32, &str)> {
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 4 {
        return None;
    }
    let rest = &t[digits.len()..];
    let rest = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") "))?;
    Some((digits.parse().ok()?, rest))
}

/// Flattens spans back to plain text, for the formats that carry no emphasis.
fn plain(spans: &[Span]) -> String {
    spans.iter().map(|s| s.text.as_str()).collect()
}

/* ------------------------------------------------------------------ */
/* Blocks → DOCX                                                       */
/* ------------------------------------------------------------------ */

/// A4 in twips, and 20 mm margins in twips (1 mm = 56.6929 twips).
const TWIP_PAGE_W: u32 = 11906;
const TWIP_PAGE_H: u32 = 16838;
const TWIP_MARGIN: i32 = 1134;
/// Width available to a table, so its columns add up to the text column rather
/// than running into the margin.
const TWIP_TEXT_W: usize = (TWIP_PAGE_W as i32 - 2 * TWIP_MARGIN) as usize;

/// Heading sizes in half-points, indexed by level 1..=6.
const DOCX_HEADING_HALF_PT: [usize; 6] = [32, 26, 23, 21, 21, 21];

fn docx_run(sp: &Span, half_pt: usize, force_bold: bool) -> docx_rs::Run {
    use docx_rs::*;
    let mut r = Run::new().add_text(&sp.text).size(half_pt);
    if sp.bold || force_bold {
        r = r.bold();
    }
    if sp.italic {
        r = r.italic();
    }
    if sp.code {
        // Consolas with Courier New behind it: the first is on every Windows
        // install this runs on, the second is the fallback for a document mailed
        // to someone else.
        r = r
            .fonts(RunFonts::new().ascii("Consolas").hi_ansi("Consolas").cs("Courier New"))
            .size(half_pt.saturating_sub(2).max(14));
    }
    r
}

fn docx_para(spans: &[Span], half_pt: usize, force_bold: bool) -> docx_rs::Paragraph {
    let mut p = docx_rs::Paragraph::new();
    for sp in spans {
        p = p.add_run(docx_run(sp, half_pt, force_bold));
    }
    p
}

/// Registers heading styles and returns the document with them attached.
///
/// `Styles::default()` in docx-rs emits a stylesheet containing only "Normal",
/// so `Paragraph::style("Heading1")` alone would reference a style that is not in
/// the package — Word falls back to Normal and every heading comes out as body
/// text. The styles are therefore added here *and* the run formatting is applied
/// directly at each heading (see `docx_para(.., force_bold)`), so the document
/// renders correctly even in a reader that resolves styles differently.
fn docx_with_styles(mut d: docx_rs::Docx) -> docx_rs::Docx {
    use docx_rs::*;
    d = d.add_style(
        Style::new("SWTitle", StyleType::Paragraph)
            .name("Title")
            .based_on("Normal")
            .size(44)
            .bold(),
    );
    for lvl in 1..=6usize {
        d = d.add_style(
            Style::new(format!("Heading{lvl}"), StyleType::Paragraph)
                .name(format!("heading {lvl}"))
                .based_on("Normal")
                .size(DOCX_HEADING_HALF_PT[lvl - 1])
                .bold()
                .outline_lvl(lvl - 1),
        );
    }
    d
}

/// A Word package for the parsed Markdown.
fn docx_bytes(title: Option<&str>, blocks: &[Block]) -> CoreResult<Vec<u8>> {
    use docx_rs::*;

    let body_pt = (BODY_PT * 2.0).round() as usize;
    let mut d = Docx::new()
        .page_size(TWIP_PAGE_W, TWIP_PAGE_H)
        .page_margin(PageMargin {
            top: TWIP_MARGIN,
            left: TWIP_MARGIN,
            bottom: TWIP_MARGIN,
            right: TWIP_MARGIN,
            ..Default::default()
        })
        .default_size(body_pt)
        .default_fonts(RunFonts::new().ascii("Calibri").hi_ansi("Calibri").cs("Calibri"));
    d = docx_with_styles(d);

    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        d = d.add_paragraph(
            docx_para(&[Span { text: t.to_string(), ..Default::default() }], 44, true)
                .style("SWTitle"),
        );
    }

    for b in blocks {
        match b {
            Block::Heading(lvl, spans) => {
                let lvl = (*lvl).clamp(1, 6) as usize;
                d = d.add_paragraph(
                    docx_para(spans, DOCX_HEADING_HALF_PT[lvl - 1], true)
                        .style(&format!("Heading{lvl}"))
                        .keep_next(true),
                );
            }
            Block::Para(spans) => d = d.add_paragraph(docx_para(spans, body_pt, false)),
            Block::Bullets(items) => {
                for (indent, spans) in items {
                    // A literal bullet with a hanging indent, rather than a real
                    // Word list. A list needs a numbering definition in the
                    // package, and a numbering reference that fails to resolve
                    // renders as an unmarked paragraph — the marker silently
                    // gone. A typed "• " cannot fail to appear.
                    let mut with_marker = vec![Span {
                        text: "\u{2022}  ".into(),
                        ..Default::default()
                    }];
                    with_marker.extend(spans.iter().cloned());
                    let left = 340 + 340 * *indent as i32;
                    d = d.add_paragraph(
                        docx_para(&with_marker, body_pt, false)
                            .indent(Some(left), Some(SpecialIndentType::Hanging(280)), None, None),
                    );
                }
            }
            Block::Numbered(items) => {
                for (indent, n, spans) in items {
                    let mut with_marker =
                        vec![Span { text: format!("{n}.  "), ..Default::default() }];
                    with_marker.extend(spans.iter().cloned());
                    let left = 340 + 340 * *indent as i32;
                    d = d.add_paragraph(
                        docx_para(&with_marker, body_pt, false)
                            .indent(Some(left), Some(SpecialIndentType::Hanging(340)), None, None),
                    );
                }
            }
            Block::Table { header, rows } => {
                let cols = header.len().max(rows.iter().map(|r| r.len()).max().unwrap_or(0)).max(1);
                let col_w = TWIP_TEXT_W / cols;

                let cell = |text: &str, bold: bool| {
                    let mut c = TableCell::new()
                        .width(col_w, WidthType::Dxa)
                        .add_paragraph(docx_para(&inline(text), body_pt, bold));
                    if bold {
                        c = c.shading(Shading::new().fill("EEF1F5"));
                    }
                    c
                };

                let mut trs = Vec::new();
                if !header.iter().all(|h| h.trim().is_empty()) {
                    // `cant_split` keeps a header from being orphaned at a page
                    // break, which is what makes the continuation readable.
                    trs.push(
                        TableRow::new(
                            (0..cols)
                                .map(|i| cell(header.get(i).map(String::as_str).unwrap_or(""), true))
                                .collect(),
                        )
                        .cant_split(),
                    );
                }
                for r in rows {
                    trs.push(TableRow::new(
                        (0..cols)
                            .map(|i| cell(r.get(i).map(String::as_str).unwrap_or(""), false))
                            .collect(),
                    ));
                }
                if trs.is_empty() {
                    continue;
                }
                d = d
                    .add_table(
                        Table::new(trs)
                            .set_grid(vec![col_w; cols])
                            .width(TWIP_TEXT_W, WidthType::Dxa)
                            .layout(TableLayoutType::Fixed),
                    )
                    // A table and the paragraph after it are otherwise flush
                    // against each other.
                    .add_paragraph(Paragraph::new());
            }
            Block::Code(lines) => {
                for l in lines {
                    d = d.add_paragraph(
                        docx_para(
                            &[Span { text: l.clone(), code: true, ..Default::default() }],
                            body_pt,
                            false,
                        )
                        .indent(Some(280), None, None, None),
                    );
                }
                d = d.add_paragraph(Paragraph::new());
            }
            Block::Quote(spans) => {
                let mut italicised: Vec<Span> = spans.clone();
                for sp in &mut italicised {
                    sp.italic = true;
                }
                d = d.add_paragraph(
                    docx_para(&italicised, body_pt, false).indent(Some(567), None, None, None),
                );
            }
            Block::Rule => {
                // Box-drawing characters set in the body font, at the width of
                // the text column. A paragraph border would be tidier but
                // docx-rs exposes borders on tables rather than paragraphs.
                d = d.add_paragraph(
                    Paragraph::new().add_run(
                        Run::new()
                            .add_text("\u{2500}".repeat(72))
                            .size(body_pt)
                            .color("BFBFBF"),
                    ),
                );
            }
        }
    }

    let mut cur = std::io::Cursor::new(Vec::new());
    d.build().pack(&mut cur).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The Word document could not be assembled ({e}), so nothing was written."
        ))
    })?;
    Ok(cur.into_inner())
}

/* ------------------------------------------------------------------ */
/* Blocks → PDF                                                        */
/* ------------------------------------------------------------------ */

/// The four faces the PDF uses, parsed once per document.
///
/// Every one is a *built-in* PDF font, so nothing is embedded and no font file
/// has to exist on the machine. That is what makes PDF output work in an
/// air-gapped install: there is no asset to download and no system font to
/// depend on. Parsing them here rather than in a global gives exact advance
/// widths for word wrapping without needing the cache to be `Sync`.
struct Faces {
    regular: Option<printpdf::ParsedFont>,
    bold: Option<printpdf::ParsedFont>,
    italic: Option<printpdf::ParsedFont>,
    bold_italic: Option<printpdf::ParsedFont>,
    mono: Option<printpdf::ParsedFont>,
}

impl Faces {
    fn load() -> Self {
        use printpdf::BuiltinFont as B;
        Self {
            regular: B::Helvetica.get_parsed_font(),
            bold: B::HelveticaBold.get_parsed_font(),
            italic: B::HelveticaOblique.get_parsed_font(),
            bold_italic: B::HelveticaBoldOblique.get_parsed_font(),
            mono: B::Courier.get_parsed_font(),
        }
    }

    fn pick(&self, sp: &Span, force_bold: bool) -> (printpdf::BuiltinFont, &Option<printpdf::ParsedFont>) {
        use printpdf::BuiltinFont as B;
        let bold = sp.bold || force_bold;
        match (sp.code, bold, sp.italic) {
            (true, _, _) => (B::Courier, &self.mono),
            (false, true, true) => (B::HelveticaBoldOblique, &self.bold_italic),
            (false, true, false) => (B::HelveticaBold, &self.bold),
            (false, false, true) => (B::HelveticaOblique, &self.italic),
            (false, false, false) => (B::Helvetica, &self.regular),
        }
    }
}

/// Advance width of a string in that face at that size, in points.
///
/// Falls back to half an em per character when a glyph is not in the font's
/// cmap, which is what printpdf itself does. An estimate is the right failure
/// mode here: a slightly ragged right edge is a cosmetic flaw, whereas refusing
/// to produce the PDF because one character has no metric would lose the report.
fn width_of(s: &str, face: &Option<printpdf::ParsedFont>, size: f32) -> f32 {
    let Some(f) = face else {
        return s.chars().count() as f32 * size * 0.5;
    };
    let upm = f.font_metrics.units_per_em as f32;
    if upm <= 0.0 {
        return s.chars().count() as f32 * size * 0.5;
    }
    s.chars()
        .map(|c| match f.lookup_glyph_index(c as u32) {
            Some(gid) => {
                let adv = f.get_horizontal_advance(gid) as f32;
                if adv > 0.0 {
                    adv / upm * size
                } else {
                    size * 0.5
                }
            }
            None => size * 0.5,
        })
        .sum()
}

/// Replaces the characters WinAnsi cannot carry with an ASCII equivalent.
///
/// The built-in fonts are `/WinAnsiEncoding`, a single-byte encoding, and
/// printpdf writes an unrepresentable character as `?`. For most text that never
/// comes up — WinAnsi covers Latin-1 plus the typographic quotes and dashes — but
/// three of the exceptions matter for this application: the rupee sign in a cost
/// column, the arrows and comparison signs an engineer writes in a note, and the
/// tick marks in a checklist. A bare `?` in a cost column is worse than "Rs.".
fn pdf_safe(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            '\u{20B9}' => "Rs.",       // ₹
            '\u{2192}' => "->",        // →
            '\u{2190}' => "<-",        // ←
            '\u{21D2}' => "=>",        // ⇒
            '\u{2264}' => "<=",        // ≤
            '\u{2265}' => ">=",        // ≥
            '\u{2260}' => "!=",        // ≠
            '\u{2248}' => "~",         // ≈
            '\u{2713}' | '\u{2714}' => "OK",
            '\u{2717}' | '\u{2718}' => "X",
            '\u{2500}'..='\u{257F}' => "-", // box drawing
            '\u{2010}'..='\u{2015}' => "-", // exotic dashes WinAnsi lacks
            '\t' => "    ",
            _ => return c.to_string(),
        }
        .to_string())
        .collect()
}

/// One laid-out text line: the spans, the left inset from the text column, and
/// the size they are set at.
struct Lay {
    spans: Vec<Span>,
    indent: f32,
    size: f32,
    bold: bool,
}

/// Splits a string into words and the whitespace between them, keeping both, so
/// wrapping can drop a break's trailing space without losing an internal one.
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_ws = false;
    for c in s.chars() {
        let ws = c.is_whitespace();
        if !cur.is_empty() && ws != in_ws {
            out.push(std::mem::take(&mut cur));
        }
        in_ws = ws;
        cur.push(c);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Wraps spans to a maximum width, preserving each span's emphasis.
fn wrap(spans: &[Span], faces: &Faces, size: f32, max: f32, bold: bool) -> Vec<Vec<Span>> {
    let mut lines: Vec<Vec<Span>> = Vec::new();
    let mut cur: Vec<Span> = Vec::new();
    let mut w = 0.0f32;

    let push = |cur: &mut Vec<Span>, sp: &Span, text: &str| match cur.last_mut() {
        // Merged into the previous run when the emphasis is identical, so a
        // wrapped paragraph does not become one PDF text-showing operation per
        // word.
        Some(last) if last.bold == sp.bold && last.italic == sp.italic && last.code == sp.code => {
            last.text.push_str(text)
        }
        _ => cur.push(Span { text: text.to_string(), ..sp.clone() }),
    };

    for sp in spans {
        let (_, face) = faces.pick(sp, bold);
        for word in words(&sp.text) {
            let ww = width_of(&word, face, size);
            let blank = word.trim().is_empty();

            if w + ww > max && !cur.is_empty() {
                if blank {
                    // A break falling on a space: end the line and drop it.
                    lines.push(std::mem::take(&mut cur));
                    w = 0.0;
                    continue;
                }
                lines.push(std::mem::take(&mut cur));
                w = 0.0;
            }
            if cur.is_empty() && blank {
                continue;
            }

            if ww > max && cur.is_empty() {
                // One word wider than the column — a long path or a chemical
                // name. Broken by character, because the alternative is a line
                // that runs off the page.
                let mut piece = String::new();
                let mut pw = 0.0;
                for c in word.chars() {
                    let cw = width_of(&c.to_string(), face, size);
                    if pw + cw > max && !piece.is_empty() {
                        push(&mut cur, sp, &piece);
                        lines.push(std::mem::take(&mut cur));
                        piece.clear();
                        pw = 0.0;
                    }
                    piece.push(c);
                    pw += cw;
                }
                if !piece.is_empty() {
                    push(&mut cur, sp, &piece);
                    w = pw;
                }
                continue;
            }

            push(&mut cur, sp, &word);
            w += ww;
        }
    }
    if !cur.is_empty() {
        lines.push(cur);
    }
    if lines.is_empty() {
        lines.push(vec![Span::default()]);
    }
    lines
}

/// Accumulates pages, breaking when the cursor runs past the bottom margin.
struct Sheet {
    pages: Vec<printpdf::PdfPage>,
    ops: Vec<printpdf::Op>,
    /// Baseline for the next line, in points from the bottom of the page.
    y: f32,
}

impl Sheet {
    fn new() -> Self {
        Self { pages: Vec::new(), ops: Vec::new(), y: mm_to_pt(PAGE_H_MM - MARGIN_MM) }
    }

    fn top(&self) -> f32 {
        mm_to_pt(PAGE_H_MM - MARGIN_MM)
    }

    fn bottom(&self) -> f32 {
        mm_to_pt(MARGIN_MM)
    }

    /// Reserves vertical space, starting a new page if it does not fit.
    fn need(&mut self, h: f32) {
        if self.y - h < self.bottom() {
            self.page_break();
        }
    }

    fn page_break(&mut self) {
        use printpdf::{Mm, PdfPage};
        let ops = std::mem::take(&mut self.ops);
        self.pages.push(PdfPage::new(Mm(PAGE_W_MM), Mm(PAGE_H_MM), ops));
        self.y = self.top();
    }

    fn finish(mut self) -> Vec<printpdf::PdfPage> {
        // The last page is kept even when empty only if it is the only one: a
        // zero-page PDF is not a valid document, and a trailing blank page after
        // real content is just noise.
        if !self.ops.is_empty() || self.pages.is_empty() {
            self.page_break();
        }
        self.pages
    }

    /// Draws one laid-out line at the current cursor and advances it.
    fn line(&mut self, faces: &Faces, lay: &Lay, leading: f32) {
        use printpdf::*;
        self.need(leading);
        let mut x = mm_to_pt(MARGIN_MM) + lay.indent;
        let y = self.y - lay.size;
        for sp in &lay.spans {
            let (builtin, face) = faces.pick(sp, lay.bold);
            let text = pdf_safe(&sp.text);
            if !text.trim().is_empty() {
                self.ops.push(Op::StartTextSection);
                self.ops.push(Op::SetFont {
                    font: PdfFontHandle::Builtin(builtin),
                    size: Pt(lay.size),
                });
                self.ops.push(Op::SetTextCursor { pos: Point { x: Pt(x), y: Pt(y) } });
                self.ops.push(Op::ShowText { items: vec![TextItem::Text(text.clone())] });
                self.ops.push(Op::EndTextSection);
            }
            x += width_of(&text, face, lay.size);
        }
        self.y -= leading;
    }

    fn gap(&mut self, h: f32) {
        self.y -= h;
        if self.y < self.bottom() {
            self.page_break();
        }
    }

    /// A horizontal rule across the text column at the current cursor.
    fn rule(&mut self, grey: f32) {
        use printpdf::*;
        self.need(8.0);
        let y = Pt(self.y - 4.0);
        let x0 = Pt(mm_to_pt(MARGIN_MM));
        let x1 = Pt(mm_to_pt(PAGE_W_MM - MARGIN_MM));
        self.ops.push(Op::SetOutlineColor {
            col: Color::Rgb(Rgb::new(grey, grey, grey, None)),
        });
        self.ops.push(Op::SetOutlineThickness { pt: Pt(0.6) });
        self.ops.push(Op::DrawLine {
            line: Line {
                points: vec![
                    LinePoint { p: Point { x: x0, y }, bezier: false },
                    LinePoint { p: Point { x: x1, y }, bezier: false },
                ],
                is_closed: false,
            },
        });
        self.y -= 8.0;
    }
}

fn mm_to_pt(mm: f32) -> f32 {
    mm * 2.834_646
}

/// Heading sizes in points, indexed by level 1..=6.
const PDF_HEADING_PT: [f32; 6] = [16.0, 13.0, 11.5, 10.5, 10.5, 10.5];

/// A PDF for the parsed Markdown, paginated.
fn pdf_bytes(title: Option<&str>, blocks: &[Block]) -> CoreResult<Vec<u8>> {
    use printpdf::*;

    let faces = Faces::load();
    let text_w = mm_to_pt(PAGE_W_MM - 2.0 * MARGIN_MM);
    let mut sh = Sheet::new();

    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        let spans = [Span { text: t.to_string(), bold: true, ..Default::default() }];
        for l in wrap(&spans, &faces, 19.0, text_w, true) {
            sh.line(&faces, &Lay { spans: l, indent: 0.0, size: 19.0, bold: true }, 24.0);
        }
        sh.rule(0.72);
        sh.gap(6.0);
    }

    for b in blocks {
        match b {
            Block::Heading(lvl, spans) => {
                let size = PDF_HEADING_PT[(*lvl).clamp(1, 6) as usize - 1];
                sh.gap(if sh.y < sh.top() { 6.0 } else { 0.0 });
                // A heading alone at the foot of a page is worse than a slightly
                // short page, so it and its first body line are kept together.
                sh.need(size * 2.6);
                for l in wrap(spans, &faces, size, text_w, true) {
                    sh.line(&faces, &Lay { spans: l, indent: 0.0, size, bold: true }, size * 1.45);
                }
                sh.gap(2.0);
            }
            Block::Para(spans) => {
                for l in wrap(spans, &faces, BODY_PT, text_w, false) {
                    sh.line(
                        &faces,
                        &Lay { spans: l, indent: 0.0, size: BODY_PT, bold: false },
                        BODY_PT * 1.45,
                    );
                }
                sh.gap(4.0);
            }
            Block::Bullets(items) => {
                for (depth, spans) in items {
                    let ind = 14.0 + 14.0 * *depth as f32;
                    pdf_list_item(&mut sh, &faces, "\u{2022}", ind, spans, text_w);
                }
                sh.gap(4.0);
            }
            Block::Numbered(items) => {
                for (depth, n, spans) in items {
                    let ind = 18.0 + 18.0 * *depth as f32;
                    pdf_list_item(&mut sh, &faces, &format!("{n}."), ind, spans, text_w);
                }
                sh.gap(4.0);
            }
            Block::Table { header, rows } => pdf_table(&mut sh, &faces, header, rows, text_w),
            Block::Code(lines) => {
                for l in lines {
                    let spans = [Span { text: l.clone(), code: true, ..Default::default() }];
                    for wl in wrap(&spans, &faces, BODY_PT - 1.0, text_w - 14.0, false) {
                        sh.line(
                            &faces,
                            &Lay { spans: wl, indent: 14.0, size: BODY_PT - 1.0, bold: false },
                            (BODY_PT - 1.0) * 1.35,
                        );
                    }
                }
                sh.gap(5.0);
            }
            Block::Quote(spans) => {
                let italicised: Vec<Span> =
                    spans.iter().map(|s| Span { italic: true, ..s.clone() }).collect();
                for l in wrap(&italicised, &faces, BODY_PT, text_w - 20.0, false) {
                    sh.line(
                        &faces,
                        &Lay { spans: l, indent: 20.0, size: BODY_PT, bold: false },
                        BODY_PT * 1.45,
                    );
                }
                sh.gap(5.0);
            }
            Block::Rule => {
                sh.gap(3.0);
                sh.rule(0.75);
                sh.gap(3.0);
            }
        }
    }

    let mut doc = PdfDocument::new(title.unwrap_or("Document"));
    doc.with_pages(sh.finish());
    let mut warnings = Vec::new();
    let bytes = doc.save(&PdfSaveOptions::default(), &mut warnings);
    if bytes.is_empty() {
        return Err(CoreError::ExecutionFailed(format!(
            "The PDF came back empty{}, so nothing was written.",
            match warnings.first() {
                Some(w) => format!(" ({w:?})"),
                None => String::new(),
            }
        )));
    }
    Ok(bytes)
}

/// A list item: the marker on the first line, the text hanging under it.
fn pdf_list_item(sh: &mut Sheet, faces: &Faces, marker: &str, indent: f32, spans: &[Span], text_w: f32) {
    let lines = wrap(spans, faces, BODY_PT, text_w - indent, false);
    for (i, l) in lines.into_iter().enumerate() {
        let mut row = l;
        if i == 0 {
            row.insert(0, Span { text: format!("{marker}  "), ..Default::default() });
            sh.line(
                faces,
                &Lay { spans: row, indent: indent - 14.0, size: BODY_PT, bold: false },
                BODY_PT * 1.4,
            );
        } else {
            sh.line(faces, &Lay { spans: row, indent, size: BODY_PT, bold: false }, BODY_PT * 1.4);
        }
    }
}

/// A table, with column widths proportional to content and a rule under the
/// header.
///
/// Every row is measured before anything is drawn, so a row that would straddle
/// a page break moves down whole rather than being cut through the middle of its
/// text.
fn pdf_table(sh: &mut Sheet, faces: &Faces, header: &[String], rows: &[Vec<String>], text_w: f32) {
    let cols = header.len().max(rows.iter().map(|r| r.len()).max().unwrap_or(0)).max(1);

    // Weight each column by the longest cell in it, clamped so one long remark
    // column cannot squeeze the numeric columns to nothing.
    let mut weight = vec![1.0f32; cols];
    for c in 0..cols {
        let longest = std::iter::once(header.get(c).map(String::as_str).unwrap_or(""))
            .chain(rows.iter().map(|r| r.get(c).map(String::as_str).unwrap_or("")))
            .map(|s| s.chars().count())
            .max()
            .unwrap_or(1);
        weight[c] = (longest as f32).clamp(4.0, 48.0);
    }
    let total: f32 = weight.iter().sum();
    let widths: Vec<f32> = weight.iter().map(|w| text_w * w / total).collect();

    let size = BODY_PT - 0.5;
    let leading = size * 1.35;
    let pad = 4.0;

    let draw_row = |sh: &mut Sheet, cells: &dyn Fn(usize) -> String, bold: bool| {
        // Wrap every cell first so the row's height is known before the page
        // decision is made.
        let cell_lines: Vec<Vec<Vec<Span>>> = (0..cols)
            .map(|c| wrap(&inline(&cells(c)), faces, size, widths[c] - 2.0 * pad, bold))
            .collect();
        let height = cell_lines.iter().map(|l| l.len()).max().unwrap_or(1) as f32 * leading;
        sh.need(height + 2.0);

        let row_top = sh.y;
        for (c, lines) in cell_lines.iter().enumerate() {
            let x: f32 = widths[..c].iter().sum::<f32>() + pad;
            sh.y = row_top;
            for l in lines {
                sh.line(faces, &Lay { spans: l.clone(), indent: x, size, bold }, leading);
            }
        }
        sh.y = row_top - height;
    };

    if !header.iter().all(|h| h.trim().is_empty()) {
        let h: Vec<String> = header.to_vec();
        draw_row(sh, &|c| h.get(c).cloned().unwrap_or_default(), true);
        sh.rule(0.55);
    }
    for r in rows {
        let r = r.clone();
        draw_row(sh, &|c| r.get(c).cloned().unwrap_or_default(), false);
    }
    sh.gap(6.0);
}

/* ------------------------------------------------------------------ */
/* Blocks → PPTX                                                       */
/* ------------------------------------------------------------------ */

/// XML text escaping. Applied to every string that reaches a generated part:
/// an equipment tag containing `&` would otherwise produce a package that no
/// reader will open, and the failure would show up in front of an audience.
fn xesc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 forbids these outright; a stray control byte from an OCR
            // pass would make the package unreadable.
            c if (c as u32) < 0x20 && c != '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// One slide: a heading and the lines under it.
struct Slide {
    title: String,
    lines: Vec<(u8, String)>,
}

/// Turns the parsed Markdown into slides.
///
/// A heading starts a new slide; everything until the next heading of the same or
/// higher level becomes its body. Deeper headings become bold lines inside the
/// slide rather than new slides, because a deck whose every `###` is its own
/// slide is unreadable. Content before the first heading goes onto a slide of its
/// own so nothing is dropped.
fn slides_from(title: Option<&str>, blocks: &[Block]) -> Vec<Slide> {
    let mut out: Vec<Slide> = Vec::new();
    let mut cur = Slide {
        title: title.map(str::trim).unwrap_or("").to_string(),
        lines: Vec::new(),
    };

    let push_line = |cur: &mut Slide, depth: u8, text: String| {
        if !text.trim().is_empty() {
            cur.lines.push((depth, text));
        }
    };

    for b in blocks {
        match b {
            Block::Heading(lvl, spans) if *lvl <= 2 => {
                if !cur.title.is_empty() || !cur.lines.is_empty() {
                    out.push(std::mem::replace(
                        &mut cur,
                        Slide { title: String::new(), lines: Vec::new() },
                    ));
                }
                cur.title = plain(spans);
            }
            Block::Heading(_, spans) => push_line(&mut cur, 0, plain(spans)),
            Block::Para(spans) => push_line(&mut cur, 0, plain(spans)),
            Block::Quote(spans) => push_line(&mut cur, 0, plain(spans)),
            Block::Bullets(items) => {
                for (d, spans) in items {
                    push_line(&mut cur, (*d).min(3) + 1, plain(spans));
                }
            }
            Block::Numbered(items) => {
                for (d, n, spans) in items {
                    push_line(&mut cur, (*d).min(3) + 1, format!("{n}. {}", plain(spans)));
                }
            }
            Block::Table { header, rows } => {
                // A slide is not a spreadsheet. The table becomes one line per
                // row, tab-separated, which keeps the readings on the slide
                // instead of silently dropping them.
                if !header.iter().all(|h| h.trim().is_empty()) {
                    push_line(&mut cur, 1, header.join("   |   "));
                }
                for r in rows {
                    push_line(&mut cur, 1, r.join("   |   "));
                }
            }
            Block::Code(lines) => {
                for l in lines {
                    push_line(&mut cur, 1, l.clone());
                }
            }
            Block::Rule => {}
        }
    }
    if !cur.title.is_empty() || !cur.lines.is_empty() {
        out.push(cur);
    }
    if out.is_empty() {
        out.push(Slide { title: title.unwrap_or("Untitled").to_string(), lines: Vec::new() });
    }

    // PowerPoint will render a slide with forty lines of 4 pt text; nobody can
    // read it. Overflow spills onto a continuation slide instead.
    const MAX_LINES: usize = 14;
    let mut split: Vec<Slide> = Vec::new();
    for s in out {
        if s.lines.len() <= MAX_LINES {
            split.push(s);
            continue;
        }
        for (i, chunk) in s.lines.chunks(MAX_LINES).enumerate() {
            split.push(Slide {
                title: if i == 0 { s.title.clone() } else { format!("{} (cont.)", s.title) },
                lines: chunk.to_vec(),
            });
        }
    }
    split
}

const NS_P: &str = "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:p=\"http://schemas.openxmlformats.org/presentationml/2006/main\"";
const NS_REL: &str = "xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"";
const XML_HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";

/// The empty shape tree every `cSld` needs before its own shapes.
const SP_TREE_HEAD: &str = concat!(
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>",
    "<p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/>",
    "<a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>",
);

/// A 16:9 deck, written as a PresentationML package by hand.
///
/// There is no PPTX writer crate in this build, and adding one would mean another
/// dependency to vet for an offline install. The package is small and entirely
/// deterministic: a presentation part, one master, one blank layout, a theme, and
/// a slide part per slide. Nothing here is generated from a template file on
/// disk, so there is no asset that can go missing.
fn pptx_bytes(title: Option<&str>, blocks: &[Block]) -> CoreResult<Vec<u8>> {
    use std::io::Write;

    let slides = slides_from(title, blocks);
    let n = slides.len();

    let fail = |e: std::io::Error| {
        CoreError::ExecutionFailed(format!(
            "The presentation could not be assembled ({e}), so nothing was written."
        ))
    };

    let mut cur = std::io::Cursor::new(Vec::new());
    {
        let mut z = zip::ZipWriter::new(&mut cur);
        let opts: zip::write::SimpleFileOptions = Default::default();
        let mut part = |name: &str, body: String| -> CoreResult<()> {
            z.start_file(name, opts).map_err(|e| {
                CoreError::ExecutionFailed(format!("The part {name} could not be added ({e})."))
            })?;
            z.write_all(body.as_bytes()).map_err(fail)
        };

        /* [Content_Types].xml */
        let mut ct = String::from(XML_HEAD);
        ct.push_str("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">");
        ct.push_str("<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>");
        ct.push_str("<Default Extension=\"xml\" ContentType=\"application/xml\"/>");
        ct.push_str("<Override PartName=\"/ppt/presentation.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml\"/>");
        ct.push_str("<Override PartName=\"/ppt/slideMasters/slideMaster1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml\"/>");
        ct.push_str("<Override PartName=\"/ppt/slideLayouts/slideLayout1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml\"/>");
        ct.push_str("<Override PartName=\"/ppt/theme/theme1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.theme+xml\"/>");
        for i in 1..=n {
            ct.push_str(&format!("<Override PartName=\"/ppt/slides/slide{i}.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.presentationml.slide+xml\"/>"));
        }
        ct.push_str("</Types>");
        part("[Content_Types].xml", ct)?;

        /* Package relationships */
        part(
            "_rels/.rels",
            format!(
                "{XML_HEAD}<Relationships {NS_REL}><Relationship Id=\"rId1\" \
                 Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" \
                 Target=\"ppt/presentation.xml\"/></Relationships>"
            ),
        )?;

        /* presentation.xml — 16:9 at 13.333in × 7.5in in EMU. */
        let mut pres = String::from(XML_HEAD);
        pres.push_str(&format!("<p:presentation {NS_P}>"));
        pres.push_str("<p:sldMasterIdLst><p:sldMasterId id=\"2147483648\" r:id=\"rId1\"/></p:sldMasterIdLst>");
        pres.push_str("<p:sldIdLst>");
        for i in 1..=n {
            pres.push_str(&format!("<p:sldId id=\"{}\" r:id=\"rId{}\"/>", 255 + i, i + 1));
        }
        pres.push_str("</p:sldIdLst>");
        pres.push_str("<p:sldSz cx=\"12192000\" cy=\"6858000\"/><p:notesSz cx=\"6858000\" cy=\"9144000\"/>");
        pres.push_str("</p:presentation>");
        part("ppt/presentation.xml", pres)?;

        let mut prels = String::from(XML_HEAD);
        prels.push_str(&format!("<Relationships {NS_REL}>"));
        prels.push_str("<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"slideMasters/slideMaster1.xml\"/>");
        for i in 1..=n {
            prels.push_str(&format!(
                "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide\" Target=\"slides/slide{i}.xml\"/>",
                i + 1
            ));
        }
        prels.push_str(&format!(
            "<Relationship Id=\"rId{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"theme/theme1.xml\"/>",
            n + 2
        ));
        prels.push_str("</Relationships>");
        part("ppt/_rels/presentation.xml.rels", prels)?;

        /* Master and its single blank layout. */
        part(
            "ppt/slideMasters/slideMaster1.xml",
            format!(
                "{XML_HEAD}<p:sldMaster {NS_P}><p:cSld><p:spTree>{SP_TREE_HEAD}</p:spTree></p:cSld>\
                 <p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" \
                 accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" \
                 accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>\
                 <p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>\
                 </p:sldMaster>"
            ),
        )?;
        part(
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            format!(
                "{XML_HEAD}<Relationships {NS_REL}>\
                 <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
                 <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme\" Target=\"../theme/theme1.xml\"/>\
                 </Relationships>"
            ),
        )?;
        part(
            "ppt/slideLayouts/slideLayout1.xml",
            format!(
                "{XML_HEAD}<p:sldLayout {NS_P} type=\"blank\" preserve=\"1\">\
                 <p:cSld name=\"Blank\"><p:spTree>{SP_TREE_HEAD}</p:spTree></p:cSld>\
                 <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
            ),
        )?;
        part(
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            format!(
                "{XML_HEAD}<Relationships {NS_REL}>\
                 <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster\" Target=\"../slideMasters/slideMaster1.xml\"/>\
                 </Relationships>"
            ),
        )?;
        part("ppt/theme/theme1.xml", theme_xml())?;

        /* One part per slide. */
        for (i, s) in slides.iter().enumerate() {
            part(&format!("ppt/slides/slide{}.xml", i + 1), slide_xml(s))?;
            part(
                &format!("ppt/slides/_rels/slide{}.xml.rels", i + 1),
                format!(
                    "{XML_HEAD}<Relationships {NS_REL}>\
                     <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout\" Target=\"../slideLayouts/slideLayout1.xml\"/>\
                     </Relationships>"
                ),
            )?;
        }

        z.finish().map_err(|e| {
            CoreError::ExecutionFailed(format!(
                "The presentation package could not be closed ({e}), so nothing was written."
            ))
        })?;
    }
    Ok(cur.into_inner())
}

/// One slide part: a title text box and a body text box.
fn slide_xml(s: &Slide) -> String {
    let mut x = String::from(XML_HEAD);
    x.push_str(&format!("<p:sld {NS_P}><p:cSld><p:spTree>{SP_TREE_HEAD}"));

    // Title: 0.6in from the left and top, 12.1in wide. EMU = inches × 914400.
    x.push_str("<p:sp><p:nvSpPr><p:cNvPr id=\"2\" name=\"Title\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>");
    x.push_str("<p:spPr><a:xfrm><a:off x=\"548640\" y=\"457200\"/><a:ext cx=\"11094720\" cy=\"1005840\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>");
    x.push_str("<p:txBody><a:bodyPr wrap=\"square\"><a:normAutofit/></a:bodyPr><a:lstStyle/><a:p>");
    x.push_str(&format!(
        "<a:r><a:rPr lang=\"en-IN\" sz=\"2800\" b=\"1\" dirty=\"0\"/><a:t>{}</a:t></a:r>",
        xesc(if s.title.trim().is_empty() { " " } else { s.title.trim() })
    ));
    x.push_str("</a:p></p:txBody></p:sp>");

    // Body.
    x.push_str("<p:sp><p:nvSpPr><p:cNvPr id=\"3\" name=\"Body\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr>");
    x.push_str("<p:spPr><a:xfrm><a:off x=\"548640\" y=\"1600200\"/><a:ext cx=\"11094720\" cy=\"4525963\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr>");
    x.push_str("<p:txBody><a:bodyPr wrap=\"square\"><a:normAutofit/></a:bodyPr><a:lstStyle/>");
    if s.lines.is_empty() {
        x.push_str("<a:p><a:endParaRPr lang=\"en-IN\"/></a:p>");
    }
    for (depth, text) in &s.lines {
        // Depth 0 is a plain paragraph; 1 and deeper carry a bullet at that
        // outline level, which is how PowerPoint indents them.
        let ppr = if *depth == 0 {
            "<a:pPr><a:buNone/></a:pPr>".to_string()
        } else {
            format!("<a:pPr lvl=\"{}\"/>", depth - 1)
        };
        x.push_str(&format!(
            "<a:p>{ppr}<a:r><a:rPr lang=\"en-IN\" sz=\"1800\" dirty=\"0\"/><a:t>{}</a:t></a:r></a:p>",
            xesc(text)
        ));
    }
    x.push_str("</p:txBody></p:sp>");

    x.push_str("</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>");
    x
}

/// A minimal but schema-complete Office theme.
///
/// PowerPoint refuses to open a master that references a theme part it cannot
/// parse, and a theme is only valid with all twelve scheme colours, both font
/// schemes and three entries in each of the four format lists. Written out in
/// full rather than trimmed, because "opens on the machine that made it" is not
/// the standard a deck emailed to a client is held to.
fn theme_xml() -> String {
    let solid = |c: &str| format!("<a:solidFill><a:srgbClr val=\"{c}\"/></a:solidFill>");
    let line = |w: u32| {
        format!(
            "<a:ln w=\"{w}\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\">\
             <a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>\
             <a:prstDash val=\"solid\"/></a:ln>"
        )
    };
    let mut t = String::from(XML_HEAD);
    t.push_str("<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Sovereign\">");
    t.push_str("<a:themeElements>");
    t.push_str("<a:clrScheme name=\"Sovereign\">");
    for (tag, val) in [
        ("dk1", "111827"),
        ("lt1", "FFFFFF"),
        ("dk2", "1F2937"),
        ("lt2", "F3F4F6"),
        ("accent1", "1E6FB8"),
        ("accent2", "0E7490"),
        ("accent3", "B45309"),
        ("accent4", "047857"),
        ("accent5", "6D28D9"),
        ("accent6", "B91C1C"),
        ("hlink", "1E6FB8"),
        ("folHlink", "6D28D9"),
    ] {
        t.push_str(&format!("<a:{tag}><a:srgbClr val=\"{val}\"/></a:{tag}>"));
    }
    t.push_str("</a:clrScheme>");
    t.push_str("<a:fontScheme name=\"Sovereign\">");
    for which in ["major", "minor"] {
        t.push_str(&format!(
            "<a:{which}Font><a:latin typeface=\"Calibri\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/></a:{which}Font>"
        ));
    }
    t.push_str("</a:fontScheme>");
    t.push_str("<a:fmtScheme name=\"Sovereign\">");
    t.push_str("<a:fillStyleLst>");
    for _ in 0..3 {
        t.push_str("<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>");
    }
    t.push_str("</a:fillStyleLst>");
    t.push_str(&format!("<a:lnStyleLst>{}{}{}</a:lnStyleLst>", line(6350), line(12700), line(19050)));
    t.push_str("<a:effectStyleLst>");
    for _ in 0..3 {
        t.push_str("<a:effectStyle><a:effectLst/></a:effectStyle>");
    }
    t.push_str("</a:effectStyleLst>");
    t.push_str("<a:bgFillStyleLst>");
    for _ in 0..3 {
        t.push_str("<a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill>");
    }
    t.push_str("</a:bgFillStyleLst>");
    t.push_str("</a:fmtScheme></a:themeElements>");
    t.push_str(&format!("<a:objectDefaults/><a:extraClrSchemeLst/><!--{}-->", solid("FFFFFF").len()));
    t.push_str("</a:theme>");
    t
}

/* ------------------------------------------------------------------ */
/* Rows → XLSX                                                         */
/* ------------------------------------------------------------------ */

/// A sheet name Excel will accept.
///
/// Excel refuses `[]:*?/\`, a name over 31 characters, and an empty name, and it
/// refuses the whole workbook rather than fixing the name — so a model that
/// called a sheet "Thickness readings: 2026/03" would otherwise lose the entire
/// file. The name is repaired here and the workbook is written.
fn sheet_name(raw: &str, index: usize, taken: &[String]) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            '[' | ']' | ':' | '*' | '?' | '/' | '\\' => '-',
            c if (c as u32) < 0x20 => ' ',
            c => c,
        })
        .collect();
    let mut name: String = cleaned.trim().chars().take(31).collect();
    // A leading or trailing apostrophe is also refused.
    name = name.trim_matches('\'').trim().to_string();
    if name.is_empty() {
        name = format!("Sheet{}", index + 1);
    }
    // Sheet names are case-insensitively unique within a workbook.
    let mut candidate = name.clone();
    let mut n = 2;
    while taken.iter().any(|t| t.eq_ignore_ascii_case(&candidate)) {
        let suffix = format!(" ({n})");
        let keep = 31usize.saturating_sub(suffix.len());
        candidate = format!("{}{suffix}", name.chars().take(keep).collect::<String>());
        n += 1;
    }
    candidate
}

/// A cell's numeric value, when writing it as a number is safe.
///
/// The point of a generated calculation sheet is that the operator can total a
/// column, and a number stored as text does not add up. But coercing everything
/// that parses would corrupt real data: an equipment tag `007` must not become
/// `7`, and `1E5` in a materials code must not become `100000`. So the string has
/// to look like a plain decimal — digits, at most one dot, an optional leading
/// sign — and must not have a leading zero in front of another digit.
fn as_number(s: &str) -> Option<f64> {
    let t = s.trim();
    if t.is_empty() || t.len() > 24 {
        return None;
    }
    let body = t.strip_prefix(['-', '+']).unwrap_or(t);
    if body.is_empty() || !body.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return None;
    }
    if body.chars().filter(|&c| c == '.').count() > 1 {
        return None;
    }
    let digits: &str = body.split('.').next().unwrap_or("");
    if digits.len() > 1 && digits.starts_with('0') {
        return None;
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn xlsx_bytes(sheets: &[(String, Vec<Vec<String>>)]) -> CoreResult<Vec<u8>> {
    use rust_xlsxwriter::{Format, Workbook};

    let cells: usize = sheets.iter().map(|(_, r)| r.iter().map(Vec::len).sum::<usize>()).sum();
    if cells > MAX_CELLS {
        return Err(CoreError::MalformedToolCall(format!(
            "That workbook would hold {cells} cells, past the {MAX_CELLS} this application will \
             write in one file. Nothing was written — split it across several files."
        )));
    }

    let mut wb = Workbook::new();
    let header = Format::new().set_bold().set_background_color(0x_EE_F1_F5);
    let mut taken: Vec<String> = Vec::new();

    let list: Vec<&(String, Vec<Vec<String>>)> =
        if sheets.is_empty() { Vec::new() } else { sheets.iter().collect() };

    if list.is_empty() {
        // A workbook with no sheets is not a valid file. An empty sheet is, and
        // it is a truthful representation of "the model asked for no rows".
        wb.add_worksheet();
    }

    for (i, (raw_name, rows)) in list.into_iter().enumerate() {
        let name = sheet_name(raw_name, i, &taken);
        taken.push(name.clone());

        let ws = wb.add_worksheet();
        ws.set_name(&name).map_err(|e| {
            CoreError::ExecutionFailed(format!("The sheet name \"{name}\" was refused ({e})."))
        })?;

        for (r, row) in rows.iter().enumerate() {
            for (c, cell) in row.iter().enumerate() {
                let (row_i, col_i) = (r as u32, c as u16);
                let res = if r == 0 {
                    ws.write_with_format(row_i, col_i, cell.as_str(), &header).map(|_| ())
                } else {
                    match as_number(cell) {
                        Some(n) => ws.write_number(row_i, col_i, n).map(|_| ()),
                        None => ws.write_string(row_i, col_i, cell.as_str()).map(|_| ()),
                    }
                };
                res.map_err(|e| {
                    CoreError::ExecutionFailed(format!(
                        "Cell {}{} of \"{name}\" could not be written ({e}), so nothing was written.",
                        c + 1,
                        r + 1
                    ))
                })?;
            }
        }

        // The header stays on screen while the operator scrolls a long
        // thickness-survey sheet, and the columns are sized to their contents.
        if rows.len() > 1 {
            ws.set_freeze_panes(1, 0).map_err(|e| {
                CoreError::ExecutionFailed(format!("The header row could not be frozen ({e})."))
            })?;
        }
        ws.autofit();
    }

    wb.save_to_buffer().map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The workbook could not be assembled ({e}), so nothing was written."
        ))
    })
}

/* ------------------------------------------------------------------ */
/* Provenance                                                          */
/* ------------------------------------------------------------------ */

/// Where a generated file came from.
///
/// Passed as one value rather than five loose arguments because the whole point
/// of it is that these five facts travel together: a `tool_history` recorded
/// without its `run_id` cannot be checked against §13, and a `producing_model_id`
/// without the attachments does not answer "what did it read".
pub struct Provenance<'a> {
    /// Human-readable origin, e.g. `run agent-run-3f19`.
    pub task: &'a str,
    /// The agent run, if this came from one. `None` for a direct call.
    pub run_id: Option<&'a str>,
    /// Project and chat that own this output.
    pub workspace_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    /// Absolute paths the operator attached to the message that produced this.
    pub attachments: &'a [String],
    /// The reasoning model that wrote the content.
    pub model_id: &'a str,
    /// The tool that produced the file, appended to the history read from §13.
    pub tool: ToolName,
}

/// Writes the bytes and records the row.
///
/// The order matters: the file lands on disk first, and only a successful write
/// produces a database row. The other order would leave the Artifacts panel
/// listing a file that does not exist, and the operator clicking Open on it.
fn record(
    st: &Arc<AppState>,
    kind: ArtifactKind,
    raw_name: &str,
    bytes: &[u8],
    prov: &Provenance,
) -> CoreResult<Artifact> {
    let file_name = sanitize_name(raw_name, kind)?;
    let (_root, target) = resolve(st, &file_name, prov.workspace_id, prov.session_id)?;
    write_atomic(&target, bytes)?;

    // Read out of §13 rather than accumulated in memory, so the provenance line
    // and the audit log cannot disagree. The generating tool is appended because
    // its own audit row is written after the tool returns and so does not exist
    // yet at this point.
    let mut tool_history = match prov.run_id {
        Some(run) => st.with_db(|conn| db::run_tools(conn, run))?,
        None => Vec::new(),
    };
    if tool_history.last() != Some(&prov.tool) {
        tool_history.push(prov.tool);
    }

    let source_document_ids = if prov.attachments.is_empty() {
        Vec::new()
    } else {
        st.with_db(|conn| db::documents_at_paths(conn, prov.attachments))?
    };

    let art = Artifact {
        id: new_id("artifact"),
        path: tidy(&target),
        file_name,
        kind,
        size_bytes: bytes.len() as u64,
        created_at: now_ms(),
        source_task: prov.task.to_string(),
        source_document_ids,
        producing_model_id: prov.model_id.to_string(),
        tool_history,
        workspace_id: prov.workspace_id.map(str::to_string),
        session_id: prov.session_id.map(str::to_string),
        verified: false,
        verify_note: None,
    };
    st.with_db(|conn| db::insert_artifact(conn, &art))?;

    // §10 — the catalogue entry says "produce it, then verify it opens", and this
    // is where that happens. A failed check does not fail the generation: the
    // file exists either way, and an artifact marked "the package has no
    // word/document.xml" is more useful to the operator than a tool error with no
    // file to inspect.
    if st.settings().verify_artifacts {
        return verify(st, &art.id).or_else(|e| {
            let note = e.message();
            st.with_db(|conn| {
                db::set_artifact_verified(conn, &art.id, false, Some(&note), art.size_bytes)
            })?;
            Ok(Artifact { verified: false, verify_note: Some(note), ..art })
        });
    }
    Ok(art)
}

/* ------------------------------------------------------------------ */
/* The public surface                                                  */
/* ------------------------------------------------------------------ */

/// Every artifact on record, newest first.
///
/// Paths are normalised on the way out rather than by rewriting the table: rows
/// written by an earlier build hold the extended-length form, and the display
/// form is the same file either way.
pub fn list(st: &Arc<AppState>) -> CoreResult<Vec<Artifact>> {
    let mut rows = st.with_db(db::artifacts)?;
    for r in &mut rows {
        r.path = tidy(Path::new(&r.path));
    }
    Ok(rows)
}

/// Reopens a generated file and parses it.
///
/// This is the whole meaning of the `verified` flag, and it is deliberately done
/// with the same crates §4 uses to read the operator's own documents — `zip` for
/// the OOXML packages, `calamine` for a workbook, `lopdf` for a PDF. A file this
/// passes is a file this application can read back, which is the strongest claim
/// that can be made without a copy of Word on the machine.
///
/// The note is stored on failure as well as success, because "reopened and read 3
/// sheets, 41 rows" and "the package has no word/document.xml" are both things
/// the operator should be able to read without running the check again.
pub fn verify(st: &Arc<AppState>, id: &str) -> CoreResult<Artifact> {
    let mut art = st.with_db(|conn| db::artifact(conn, id))?;
    art.path = tidy(Path::new(&art.path));
    let path = PathBuf::from(&art.path);

    let meta = match std::fs::metadata(&path) {
        Ok(m) => m,
        Err(_) => {
            // The row describes bytes that are not there. Keeping it and marking
            // it unverified would leave a permanent entry the operator can
            // neither open nor clear, so it goes.
            st.with_db(|conn| db::delete_artifact(conn, id))?;
            return Err(CoreError::ExecutionFailed(format!(
                "{} is no longer at {} — it was moved or deleted outside this application. The \
                 entry has been removed from Artifacts.",
                art.file_name, art.path
            )));
        }
    };
    let size = meta.len();
    if size == 0 {
        let note = "The file on disk is empty (0 bytes).".to_string();
        st.with_db(|conn| db::set_artifact_verified(conn, id, false, Some(&note), 0))?;
        return Ok(Artifact { verified: false, verify_note: Some(note), size_bytes: 0, ..art });
    }

    let note = match art.kind {
        ArtifactKind::Docx => verify_ooxml(&path, "word/document.xml", "paragraph")?,
        ArtifactKind::Pptx => verify_pptx(&path)?,
        ArtifactKind::Xlsx => verify_xlsx(&path)?,
        ArtifactKind::Pdf => verify_pdf(&path)?,
        ArtifactKind::Markdown | ArtifactKind::Text | ArtifactKind::Code => verify_text(&path)?,
    };

    st.with_db(|conn| db::set_artifact_verified(conn, id, true, Some(&note), size))?;
    Ok(Artifact { verified: true, verify_note: Some(note), size_bytes: size, ..art })
}

/// Opens an artifact in whatever the operating system associates with its type.
///
/// The path comes from the database, but it is re-checked against the artifacts
/// folder before being handed to the shell: a row could have been written by an
/// earlier build with a different root, and "open whatever path is in this
/// column" is not a thing this application should do.
pub fn open(st: &Arc<AppState>, id: &str) -> CoreResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let art = st.with_db(|conn| db::artifact(conn, id))?;
    let path = std::fs::canonicalize(&art.path).map_err(|_| {
        CoreError::ExecutionFailed(format!(
            "{} is no longer at {}, so there was nothing to open. Run the check on it to clear \
             the entry.",
            art.file_name, art.path
        ))
    })?;

    let root = st.settings().artifact_root;
    let root = std::fs::canonicalize(&root).map_err(|e| {
        CoreError::ExecutionFailed(format!("The artifacts folder could not be opened ({e})."))
    })?;
    if !within(&root, &path) {
        return Err(CoreError::Denied(format!(
            "{} sits outside the artifacts folder, so this application will not hand it to the \
             shell. Move it under {} or open it from Explorer yourself.",
            art.path,
            root.display()
        )));
    }

    st.app.opener().open_path(path.to_string_lossy().to_string(), None::<&str>).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "Windows would not open {} ({e}). There may be no application associated with this \
             file type.",
            art.file_name
        ))
    })
}

/// Produces a DOCX or a PDF from Markdown.
pub fn generate_doc(
    st: &Arc<AppState>,
    kind: ArtifactKind,
    file_name: &str,
    title: Option<&str>,
    markdown: &str,
    prov: &Provenance,
) -> CoreResult<Artifact> {
    let blocks = parse_markdown(markdown);
    let bytes = match kind {
        ArtifactKind::Docx => docx_bytes(title, &blocks)?,
        ArtifactKind::Pdf => pdf_bytes(title, &blocks)?,
        ArtifactKind::Pptx => pptx_bytes(title, &blocks)?,
        // Markdown, text and source pass through unchanged. Reformatting the
        // model's own Markdown would mean the file on disk is not what it wrote.
        ArtifactKind::Markdown | ArtifactKind::Text | ArtifactKind::Code => {
            let mut s = String::new();
            if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
                if kind == ArtifactKind::Markdown && !markdown.trim_start().starts_with('#') {
                    s.push_str(&format!("# {t}\n\n"));
                }
            }
            s.push_str(markdown);
            s.into_bytes()
        }
        ArtifactKind::Xlsx => {
            return Err(CoreError::MalformedToolCall(
                "A spreadsheet is produced from rows, not from Markdown. Use generate_xlsx with a \
                 \"sheets\" array."
                    .into(),
            ))
        }
    };
    record(st, kind, file_name, &bytes, prov)
}

/// Writes plain text — a script, a note, a Markdown summary — into the artifacts
/// folder.
///
/// This is the path for a deliverable that is *not* a change to the operator's
/// own code. `write_file` proposes a diff inside an approved workspace and needs
/// one to be open; on a fresh install none is, and "write me a Python script that
/// checks these thickness readings" should still produce a file the operator can
/// run.
///
/// The kind is taken from the name rather than from the caller, because the name
/// is what Windows will act on. A name claiming a rich binary format is refused
/// outright: writing Python source into a file called `.docx` would produce
/// exactly the artifact this module's first invariant exists to prevent — one
/// that opens as gibberish in the application its extension names.
pub fn generate_text(
    st: &Arc<AppState>,
    file_name: &str,
    content: &str,
    prov: &Provenance,
) -> CoreResult<Artifact> {
    let kind = match kind_from_extension(file_name) {
        Some(k @ (ArtifactKind::Docx | ArtifactKind::Xlsx | ArtifactKind::Pptx | ArtifactKind::Pdf)) => {
            return Err(CoreError::MalformedToolCall(format!(
                "\"{file_name}\" names a {} file, which is a packaged binary format and cannot hold plain text. Use the matching generator for it, or give the file a .md, .txt or source-code extension.",
                extension_for(k).to_uppercase()
            )))
        }
        Some(k) => k,
        // Anything else — .py, .rs, .sql, .yaml — is source. The extension is
        // kept as given, which is what makes the result runnable.
        None => ArtifactKind::Code,
    };
    record(st, kind, file_name, content.as_bytes(), prov)
}

/// Produces an XLSX workbook from rows. The first row of each sheet is treated as
/// its header.
pub fn generate_sheet(
    st: &Arc<AppState>,
    file_name: &str,
    sheets: Vec<(String, Vec<Vec<String>>)>,
    prov: &Provenance,
) -> CoreResult<Artifact> {
    let bytes = xlsx_bytes(&sheets)?;
    record(st, ArtifactKind::Xlsx, file_name, &bytes, prov)
}

/* ------------------------------------------------------------------ */
/* Verification per format                                             */
/* ------------------------------------------------------------------ */

fn read_file(path: &Path) -> CoreResult<Vec<u8>> {
    std::fs::read(path).map_err(|e| {
        CoreError::InvalidDocument(format!("{} could not be read back ({e}).", path.display()))
    })
}

/// Counts the entries of a zip package and confirms the required part parses.
fn zip_names(bytes: &[u8], what: &str) -> CoreResult<Vec<String>> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| {
        CoreError::InvalidDocument(format!(
            "The {what} is not a readable package ({e}). The file on disk is damaged."
        ))
    })?;
    Ok((0..z.len())
        .filter_map(|i| z.by_index(i).ok().map(|e| e.name().to_string()))
        .collect())
}

fn entry(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut f = z.by_name(name).ok()?;
    let mut out = Vec::new();
    f.read_to_end(&mut out).ok()?;
    Some(out)
}

/// Confirms an OOXML part exists and is well-formed XML, and counts its elements.
fn verify_ooxml(path: &Path, part: &str, counted: &str) -> CoreResult<String> {
    let bytes = read_file(path)?;
    let names = zip_names(&bytes, "document")?;
    let xml = entry(&bytes, part).ok_or_else(|| {
        CoreError::InvalidDocument(format!(
            "The package has no {part}, so it is not a valid document. It holds {} parts.",
            names.len()
        ))
    })?;

    let mut reader = quick_xml::Reader::from_reader(xml.as_slice());
    let mut buf = Vec::new();
    let mut paragraphs = 0usize;
    let mut tables = 0usize;
    let mut chars = 0usize;
    let mut in_text = false;
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Eof) => break,
            // quick-xml 0.42 hands names back as `&str`, and these are the
            // qualified names as they appear in the file — `w:` in WordprocessingML,
            // `a:` in the DrawingML a slide's text lives in.
            Ok(quick_xml::events::Event::Start(e)) => match AsRef::<str>::as_ref(&e.name()) {
                "w:p" | "a:p" => paragraphs += 1,
                "w:tbl" | "a:tbl" => tables += 1,
                "w:t" | "a:t" => in_text = true,
                _ => {}
            },
            Ok(quick_xml::events::Event::End(e)) => {
                if matches!(AsRef::<str>::as_ref(&e.name()), "w:t" | "a:t") {
                    in_text = false;
                }
            }
            Ok(quick_xml::events::Event::Text(t)) if in_text => {
                chars += AsRef::<str>::as_ref(&t).chars().count();
            }
            Ok(_) => {}
            Err(e) => {
                return Err(CoreError::InvalidDocument(format!(
                    "{part} is not well-formed XML ({e}), so the file will not open."
                )))
            }
        }
        buf.clear();
    }

    Ok(format!(
        "Reopened and parsed: {paragraphs} {counted}{}, {tables} table{}, {chars} characters of \
         text, across {} package parts.",
        if paragraphs == 1 { "" } else { "s" },
        if tables == 1 { "" } else { "s" },
        names.len()
    ))
}

fn verify_pptx(path: &Path) -> CoreResult<String> {
    let bytes = read_file(path)?;
    let names = zip_names(&bytes, "presentation")?;
    let slides: Vec<&String> = names
        .iter()
        .filter(|n| n.starts_with("ppt/slides/slide") && n.ends_with(".xml"))
        .collect();
    if slides.is_empty() {
        return Err(CoreError::InvalidDocument(format!(
            "The package holds {} parts but no slides, so there is nothing to present.",
            names.len()
        )));
    }
    // Every slide, not just the first: a deck whose eleventh slide is malformed
    // fails in front of the audience, which is exactly the case this check
    // exists for.
    let mut total_paragraphs = 0usize;
    for s in &slides {
        let note = verify_ooxml(path, s, "paragraph")?;
        total_paragraphs += note
            .split_whitespace()
            .nth(3)
            .and_then(|n| n.parse::<usize>().ok())
            .unwrap_or(0);
    }
    Ok(format!(
        "Reopened and parsed: {} slide{}, {total_paragraphs} paragraphs, across {} package parts.",
        slides.len(),
        if slides.len() == 1 { "" } else { "s" },
        names.len()
    ))
}

fn verify_xlsx(path: &Path) -> CoreResult<String> {
    use calamine::Reader;
    let mut wb: calamine::Xlsx<_> = calamine::open_workbook(path).map_err(|e| {
        CoreError::InvalidDocument(format!(
            "The workbook would not open ({e}). The file on disk is damaged."
        ))
    })?;
    let names = wb.sheet_names().to_vec();
    if names.is_empty() {
        return Err(CoreError::InvalidDocument(
            "The workbook opened but holds no sheets, so there is nothing in it.".into(),
        ));
    }
    let mut rows = 0usize;
    let mut cells = 0usize;
    for n in &names {
        let range = wb.worksheet_range(n).map_err(|e| {
            CoreError::InvalidDocument(format!("Sheet \"{n}\" would not be read ({e})."))
        })?;
        rows += range.height();
        cells += range.cells().filter(|(_, _, v)| !matches!(v, calamine::Data::Empty)).count();
    }
    Ok(format!(
        "Reopened and parsed: {} sheet{} ({}), {rows} rows, {cells} non-empty cells.",
        names.len(),
        if names.len() == 1 { "" } else { "s" },
        names.join(", ")
    ))
}

fn verify_pdf(path: &Path) -> CoreResult<String> {
    let doc = lopdf::Document::load(path).map_err(|e| {
        CoreError::InvalidDocument(format!(
            "The PDF would not open ({e}). The file on disk is damaged."
        ))
    })?;
    let pages = doc.get_pages();
    if pages.is_empty() {
        return Err(CoreError::InvalidDocument(
            "The PDF opened but has no pages, so there is nothing in it.".into(),
        ));
    }
    // Text is extracted as well as counted, because a PDF of blank pages loads
    // without error and would otherwise pass.
    let numbers: Vec<u32> = pages.keys().copied().collect();
    let text = doc.extract_text(&numbers).unwrap_or_default();
    let chars = text.chars().filter(|c| !c.is_whitespace()).count();
    if chars == 0 {
        return Err(CoreError::InvalidDocument(format!(
            "The PDF has {} page{} but no extractable text, so the content did not make it into \
             the file.",
            pages.len(),
            if pages.len() == 1 { "" } else { "s" }
        )));
    }
    Ok(format!(
        "Reopened and parsed: {} page{}, {chars} characters of extractable text.",
        pages.len(),
        if pages.len() == 1 { "" } else { "s" }
    ))
}

fn verify_text(path: &Path) -> CoreResult<String> {
    let bytes = read_file(path)?;
    let text = String::from_utf8(bytes).map_err(|e| {
        CoreError::InvalidDocument(format!(
            "The file is not valid UTF-8 ({e}), so it was written with a broken encoding."
        ))
    })?;
    let lines = text.lines().count();
    Ok(format!(
        "Reopened and read: {lines} line{}, {} characters.",
        if lines == 1 { "" } else { "s" },
        text.chars().count()
    ))
}
