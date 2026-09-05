//! §4 — turning a file on disk into something a model and an operator can both
//! work with: text, tables, equipment tags, and a record in the store.
//!
//! The routing here is the visible part of §3. A digital PDF is *not* sent to an
//! OCR model — its text layer is extracted natively, no model is loaded, and the
//! document is recorded as `Native` so the operator can see that no inference
//! happened. Only a page with no text layer becomes an OCR job, and only then is
//! a vision model chosen for it.
//!
//! **What the PDF path can and cannot do.** There is no PDF rasteriser in this
//! build: adding pdfium or mupdf means a large native dependency and a build that
//! can fail on a plant workstation, and the brief values a build that works. So a
//! scanned PDF is handled by pulling the *embedded page images* out of the file,
//! which is what a scanner actually puts there — one image per page. That covers
//! JPEG (`DCTDecode`) and raw/Flate images, which is what current scanners and
//! every "print to PDF" path produce. It does not cover JPEG 2000 or the bitonal
//! fax codecs from older equipment, and when one of those turns up it is named in
//! the error rather than reported as an empty document, because "export that page
//! as a PNG and attach it" then works completely.
//!
//! Ingestion is idempotent by content: the same bytes at the same path are
//! returned from the store rather than re-OCR'd. A twelve-page scan costs about a
//! minute of GPU time, and paying it twice because someone re-attached the file is
//! the sort of thing that makes an operator stop using the tool.

use std::path::Path;
use std::sync::Arc;

use crate::error::{CoreError, CoreResult};
use crate::registry::{Registry, TaskKind};
use crate::agent::Step;
use crate::state::{new_id, now_ms, AppState};
use crate::types::*;

/// Below this many characters per page, a PDF is treated as having no usable text
/// layer and is sent down the OCR path.
///
/// It is not zero because scanners routinely embed a few dozen characters of junk
/// — a header, a stamp, an OCR layer that failed — and a page with eleven
/// characters on it is a scan, not a document. It is not high either: a drawing
/// sheet legitimately holds only a title block of native text.
const MIN_CHARS_PER_PAGE: usize = 40;

/// Page images below this size are decoration — a logo, a signature stamp, a
/// rule — not a scanned page, and OCR'ing them wastes a model call each.
const MIN_PAGE_IMAGE_PIXELS: i64 = 200 * 200;

/// A ceiling on pages sent to a vision model in one ingest.
///
/// A 300-page standard would otherwise occupy the GPU for the better part of an
/// hour with no way to tell it had. The limit is stated in the document record,
/// not hidden, so the operator knows the transcription is partial.
const MAX_OCR_PAGES: usize = 40;

/* ------------------------------------------------------------------ */
/* Identity                                                           */
/* ------------------------------------------------------------------ */

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    let mut s = String::with_capacity(64);
    for b in digest {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// Bumped when the extraction *code* changes what a record comes out as.
///
/// The prompts are hashed, so an edit to one of those is picked up without
/// touching this. What is not hashed is the parsing either side of the model —
/// `split_ocr`, `ocr_cells`, `extract_tags`, `drawing_tag_blocks` — so a fix
/// there needs a bump here to reach documents that are already stored.
const EXTRACTION_VERSION: u32 = 5;

/// What the extraction pipeline currently is, short enough to store on a row.
///
/// Ingestion skips the model when the file hash is unchanged, which is right
/// for an unchanged file and wrong for a changed pipeline: the operator who
/// re-attaches a drawing after a bad extraction was fixed is handed the bad
/// extraction back, because the bytes still match. Storing what produced a
/// record and reusing it only when that still matches makes re-attaching the
/// file the repair it looks like.
///
/// Every prompt goes in, not just the one for this document, because the kind is
/// not known until the file has been read — and a pipeline is the whole thing,
/// not the branch one file happened to take.
fn pipeline_id() -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(EXTRACTION_VERSION.to_le_bytes());
    for kind in [
        DocumentKind::Drawing,
        DocumentKind::Handwriting,
        DocumentKind::Photograph,
        DocumentKind::Image,
    ] {
        h.update(ocr_prompt(kind));
    }
    let digest = h.finalize();
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn ext_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

/* ------------------------------------------------------------------ */
/* Equipment tags                                                     */
/* ------------------------------------------------------------------ */

/// Pulls plant equipment tags out of extracted text, deterministically.
///
/// This is not a model call and it must not become one. Refinery tags follow ISA
/// 5.1 shapes — a letter group naming the function, a separator, a number, an
/// optional suffix: `P-101A`, `PSV-2301`, `TI 4501`, `E-204B`. Matching that
/// shape is a parsing problem with an exact answer, and asking a language model
/// to do it instead would introduce hallucinated tags into an inspection record.
///
/// The letter group is checked against the ISA function letters rather than
/// accepted blindly, because otherwise every hyphenated word in the document —
/// `pre-2019`, `ANSI-150` — arrives as equipment.
///
/// Shared with `agent.rs`, which asks the same question of text going the other
/// way: whether a file the model is about to write names plant equipment. One
/// definition of "this is a tag", tested in one place, answers both.
/// Standards whose number names a computing format rather than a plant code.
///
/// `ISO 8601` is a date format, `ISO 8859` a character encoding, `IEEE 754` the
/// float everything on this machine uses. None of them is equipment and none is
/// a statement a plant document is the source for, so a script that formats a
/// timestamp must not come back as an entity called `ISO-8601` or hold a write
/// with a refusal about plant readings.
///
/// Only formats. The plant standards this must never touch — `API 570`,
/// `ISO 4287` surface roughness, `IS 2062` steel, `IEC 61511` safety systems —
/// are deliberately absent, and the numbers listed are exact so a neighbouring
/// standard is not swept up with them.
pub(crate) fn is_format_standard(body: &str, number: &str) -> bool {
    matches!(
        (body, number),
        ("ISO", "8601")
            | ("ISO", "8859")
            | ("ISO", "10646")
            | ("ISO", "639")
            | ("ISO", "3166")
            | ("ISO", "4217")
            | ("ISO", "216")
            | ("IEEE", "754")
            | ("IEEE", "802")
            | ("IEC", "60559")
            | ("ANSI", "378")
    )
}

pub(crate) fn extract_tags(text: &str) -> Vec<String> {
    // ISA 5.1 first letters (measured variable) and common equipment prefixes
    // used on Indian refinery drawings.
    const KNOWN: &[&str] = &[
        // Instruments, by ISA function.
        "FI", "FIC", "FT", "FV", "FE", "FQ", "FIT", "FCV",
        "LI", "LIC", "LT", "LV", "LG", "LS", "LIT", "LCV",
        "PI", "PIC", "PT", "PV", "PS", "PG", "PIT", "PCV", "PSV", "PRV", "PDI", "PDT",
        "TI", "TIC", "TT", "TV", "TE", "TW", "TIT", "TCV",
        "AI", "AT", "AE", "SI", "ST", "XV", "HV", "MOV", "ZV", "SDV", "BDV",
        // Equipment.
        "P", "C", "K", "E", "V", "D", "T", "R", "F", "H", "TK", "PP", "CP", "HE",
        "AC", "FD", "ID", "MP", "MOTOR", "PSE",
        // Inspection records: a test point / condition-monitoring location is
        // the thing a thickness reading is *about*, so a record that names TP-04
        // and yields no entity for it has extracted nothing useful.
        "TP", "CML", "TML",
        // Lines and documents.
        "PID", "ISO", "WO", "MOC",
    ];

    let mut out: Vec<String> = Vec::new();
    let bytes: Vec<char> = text.chars().collect();
    let n = bytes.len();
    let mut i = 0usize;

    while i < n {
        if !bytes[i].is_ascii_uppercase() {
            i += 1;
            continue;
        }
        // A tag may not begin mid-word: `TRIP` must not yield `TR`. The one
        // thing allowed in front is a unit number, because a line number on an
        // Indian refinery drawing is written unit-first — `4-P-1102-6in-CS` is
        // line 1102 in service P of unit 4, and it is what the inspection record
        // calls the equipment. Rejecting it because a hyphen precedes the letters
        // left the central tag of a thickness report unextracted.
        let mut unit = String::new();
        if i > 0 && bytes[i - 1] == '-' {
            let mut d = i - 1;
            while d > 0 && bytes[d - 1].is_ascii_digit() && (i - 1) - (d - 1) <= 2 {
                d -= 1;
            }
            let is_unit = d < i - 1 && (d == 0 || !(bytes[d - 1].is_alphanumeric() || bytes[d - 1] == '-'));
            if is_unit {
                unit = bytes[d..i].iter().collect();
            } else {
                i += 1;
                continue;
            }
        } else if i > 0 && bytes[i - 1].is_alphanumeric() {
            i += 1;
            continue;
        }

        let mut j = i;
        while j < n && bytes[j].is_ascii_uppercase() && j - i < 6 {
            j += 1;
        }
        let letters: String = bytes[i..j].iter().collect();
        if !KNOWN.contains(&letters.as_str()) {
            i = j.max(i + 1);
            continue;
        }

        // Exactly one separator: a hyphen, or a single space.
        let mut k = j;
        if k < n && (bytes[k] == '-' || bytes[k] == '_') {
            k += 1;
        } else if k < n && bytes[k] == ' ' {
            k += 1;
        } else {
            i = j;
            continue;
        }

        let digits_from = k;
        while k < n && bytes[k].is_ascii_digit() && k - digits_from < 6 {
            k += 1;
        }
        // Two digits minimum. A one-digit "P-1" is as likely to be a list item.
        if k - digits_from < 2 {
            i = j;
            continue;
        }
        let digits: String = bytes[digits_from..k].iter().collect();

        // One optional letter suffix — the A/B of a spared pump pair.
        let mut suffix = String::new();
        if k < n && bytes[k].is_ascii_uppercase() && (k + 1 >= n || !bytes[k + 1].is_ascii_uppercase())
        {
            suffix.push(bytes[k]);
            k += 1;
        }

        // `ISO 8601` is a date format, not an isometric drawing. The prefix is
        // shared and only the number tells them apart.
        if is_format_standard(&letters, &digits) {
            i = k;
            continue;
        }

        let tag = format!("{unit}{letters}-{digits}{suffix}");
        if !out.contains(&tag) {
            out.push(tag);
        }
        i = k;
    }

    out.sort();
    out
}

/* ------------------------------------------------------------------ */
/* Block construction                                                 */
/* ------------------------------------------------------------------ */

fn full_page_box(page: u32) -> BoundingBox {
    BoundingBox { page, x: 0.0, y: 0.0, w: 1.0, h: 1.0 }
}

/// One block per page.
///
/// Native extraction gives no geometry — `pdf-extract` returns a page of text,
/// not positioned runs — so the box is the whole page and `confidence` is absent.
/// Inventing a plausible-looking bounding box would put an overlay on the
/// document viewer that points at the wrong place, which is worse than no
/// overlay.
fn page_block(page: u32, kind: BlockKind, text: impl Into<String>, confidence: Option<f32>) -> DocBlock {
    DocBlock {
        id: new_id("blk"),
        kind,
        text: text.into(),
        bbox: full_page_box(page),
        confidence,
    }
}

/* ------------------------------------------------------------------ */
/* Office formats — read directly from the package                     */
/* ------------------------------------------------------------------ */

/// One entry of a zip package, as bytes.
fn zip_entry(bytes: &[u8], name: &str) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).ok()?;
    let mut f = zip.by_name(name).ok()?;
    let mut out = Vec::new();
    f.read_to_end(&mut out).ok()?;
    Some(out)
}

/// Every entry whose name matches a predicate, in sorted order.
///
/// Sorted because PPTX slide parts are `slide1.xml`, `slide2.xml`, …
/// `slide10.xml`, and zip order is not slide order — an unsorted read produces a
/// deck whose slides are shuffled, which is the kind of wrong that reads as
/// correct.
fn zip_entries_matching(bytes: &[u8], f: impl Fn(&str) -> bool) -> Vec<(String, Vec<u8>)> {
    use std::io::Read;
    let Ok(mut zip) = zip::ZipArchive::new(std::io::Cursor::new(bytes)) else {
        return Vec::new();
    };
    let names: Vec<String> = (0..zip.len())
        .filter_map(|i| zip.by_index(i).ok().map(|e| e.name().to_string()))
        .filter(|n| f(n))
        .collect();

    let mut keyed: Vec<(u32, String)> = names
        .into_iter()
        .map(|n| {
            let num = n
                .chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u32>()
                .unwrap_or(0);
            (num, n)
        })
        .collect();
    keyed.sort();

    keyed
        .into_iter()
        .filter_map(|(_, name)| {
            let mut e = zip.by_name(&name).ok()?;
            let mut buf = Vec::new();
            e.read_to_end(&mut buf).ok()?;
            Some((name, buf))
        })
        .collect()
}

/// Text runs from an OOXML part, with paragraph and table structure preserved.
///
/// Works on `word/document.xml` and `ppt/slides/slideN.xml` alike because both
/// use `<a:t>`/`<w:t>` for text and both mark paragraph ends. Structure is what
/// makes the output usable: a wall of concatenated runs loses the row boundaries
/// of an inspection table, and a model reading it will pair the wrong reading
/// with the wrong tag.
fn ooxml_text(xml: &[u8]) -> (Vec<String>, Vec<Vec<Vec<String>>>) {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut reader = Reader::from_reader(xml);
    reader.config_mut().trim_text(false);

    let mut paragraphs: Vec<String> = Vec::new();
    let mut tables: Vec<Vec<Vec<String>>> = Vec::new();

    let mut para = String::new();
    let mut cell = String::new();
    let mut row: Vec<String> = Vec::new();
    let mut table: Vec<Vec<String>> = Vec::new();

    // Depth counters rather than booleans: OOXML tables nest, and a boolean
    // would close the outer table when an inner one ended.
    let mut in_table = 0usize;
    let mut in_cell = 0usize;
    let mut in_text = false;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Eof) | Err(_) => break,
            Ok(Event::Start(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    "t" => in_text = true,
                    "tbl" => {
                        in_table += 1;
                        table.clear();
                    }
                    "tc" => {
                        in_cell += 1;
                        cell.clear();
                    }
                    _ => {}
                }
            }
            Ok(Event::End(e)) => {
                let name = e.local_name();
                match name.as_ref() {
                    "t" => in_text = false,
                    "p" => {
                        // A paragraph inside a cell belongs to the cell, not to
                        // the body: a multi-line remark column would otherwise
                        // leak out of its row.
                        if in_cell > 0 {
                            if !cell.is_empty() && !cell.ends_with(' ') {
                                cell.push(' ');
                            }
                        } else {
                            let t = para.trim();
                            if !t.is_empty() {
                                paragraphs.push(t.to_string());
                            }
                            para.clear();
                        }
                    }
                    "tc" => {
                        in_cell = in_cell.saturating_sub(1);
                        row.push(cell.trim().to_string());
                        cell.clear();
                    }
                    "tr" => {
                        if !row.is_empty() {
                            table.push(std::mem::take(&mut row));
                        }
                    }
                    "tbl" => {
                        in_table = in_table.saturating_sub(1);
                        if !table.is_empty() {
                            tables.push(std::mem::take(&mut table));
                        }
                    }
                    // PowerShell-free line break inside a run.
                    "br" | "cr" => {
                        if in_cell > 0 {
                            cell.push(' ');
                        } else {
                            para.push(' ');
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Text(t)) => {
                if in_text {
                    let s: &str = &t;
                    if in_cell > 0 {
                        cell.push_str(s);
                    } else {
                        para.push_str(s);
                    }
                }
            }
            // quick-xml reports `&amp;` and `&#176;` as their own events rather
            // than folding them into the text. Dropping them would matter here:
            // "P&ID" arrives as "P", "&amp;", "ID", and a P&ID whose name has
            // lost its ampersand is a P&ID nobody can search for.
            Ok(Event::GeneralRef(r)) => {
                if in_text {
                    let resolved: String = match r.resolve_char_ref() {
                        Ok(Some(c)) => c.to_string(),
                        _ => quick_xml::escape::resolve_predefined_entity(&r)
                            .unwrap_or("")
                            .to_string(),
                    };
                    if in_cell > 0 {
                        cell.push_str(&resolved);
                    } else {
                        para.push_str(&resolved);
                    }
                }
            }
            Ok(Event::Empty(e)) => {
                // Self-closing break, the common encoding of a soft line end.
                if matches!(e.local_name().as_ref(), "br" | "cr") {
                    if in_cell > 0 {
                        cell.push(' ');
                    } else {
                        para.push(' ');
                    }
                }
            }
            _ => {}
        }
        buf.clear();
    }

    let t = para.trim();
    if !t.is_empty() {
        paragraphs.push(t.to_string());
    }
    let _ = in_table;
    (paragraphs, tables)
}

fn docx_extract(bytes: &[u8]) -> CoreResult<(Vec<DocBlock>, Vec<DocTable>)> {
    let xml = zip_entry(bytes, "word/document.xml").ok_or_else(|| {
        CoreError::InvalidDocument(
            "This .docx has no word/document.xml, so it is not a Word document however it is named. If it was renamed from another format, rename it back.".into(),
        )
    })?;
    let (paragraphs, tables) = ooxml_text(&xml);

    if paragraphs.is_empty() && tables.is_empty() {
        return Err(CoreError::InvalidDocument(
            "This Word document holds no text — only images, or an empty body. If the content is a scanned page pasted in, export it as an image and attach that instead.".into(),
        ));
    }

    let blocks: Vec<DocBlock> = paragraphs
        .iter()
        .map(|p| {
            // A short line with no sentence punctuation is a heading far more
            // often than it is a sentence. Style names would be exact, but they
            // live in a separate part and are frequently custom.
            let kind = if p.len() <= 80 && !p.ends_with('.') && !p.ends_with(',') {
                BlockKind::Heading
            } else {
                BlockKind::Text
            };
            page_block(1, kind, p.clone(), None)
        })
        .collect();

    let tables = tables
        .into_iter()
        .map(|rows| {
            let mut rows = rows;
            let header = if rows.is_empty() { Vec::new() } else { rows.remove(0) };
            DocTable { id: new_id("tbl"), page: 1, bbox: full_page_box(1), header, rows }
        })
        .collect();

    Ok((blocks, tables))
}

fn pptx_extract(bytes: &[u8]) -> CoreResult<(Vec<DocBlock>, Vec<DocTable>)> {
    let slides = zip_entries_matching(bytes, |n| {
        n.starts_with("ppt/slides/slide") && n.ends_with(".xml")
    });
    if slides.is_empty() {
        return Err(CoreError::InvalidDocument(
            "This .pptx contains no slide parts, so there was nothing to read.".into(),
        ));
    }

    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    for (i, (_, xml)) in slides.iter().enumerate() {
        let page = i as u32 + 1;
        let (paras, tbls) = ooxml_text(xml);
        if paras.is_empty() && tbls.is_empty() {
            continue;
        }
        blocks.push(page_block(page, BlockKind::Heading, format!("Slide {page}"), None));
        for p in paras {
            blocks.push(page_block(page, BlockKind::Text, p, None));
        }
        for rows in tbls {
            let mut rows = rows;
            let header = if rows.is_empty() { Vec::new() } else { rows.remove(0) };
            tables.push(DocTable { id: new_id("tbl"), page, bbox: full_page_box(page), header, rows });
        }
    }
    Ok((blocks, tables))
}

/// Spreadsheet cells, sheet by sheet, formulas included.
///
/// Formulas matter more than values here. An engineering calculation sheet is
/// reviewed by checking the formula, and a reviewer handed only the computed
/// number cannot tell a correct answer from a hard-coded one.
fn xlsx_extract(path: &Path, only_sheet: Option<&str>) -> CoreResult<(Vec<DocBlock>, Vec<DocTable>)> {
    use calamine::{Data, Reader};

    let mut wb = calamine::open_workbook_auto(path).map_err(|e| {
        CoreError::InvalidDocument(format!("{} could not be opened as a spreadsheet: {e}", file_name_of(&path.to_string_lossy())))
    })?;

    let names: Vec<String> = wb.sheet_names().to_vec();
    let mut blocks = Vec::new();
    let mut tables = Vec::new();

    for (i, name) in names.iter().enumerate() {
        if let Some(want) = only_sheet {
            if !name.eq_ignore_ascii_case(want) {
                continue;
            }
        }
        let page = i as u32 + 1;
        let Ok(range) = wb.worksheet_range(name) else { continue };
        if range.is_empty() {
            blocks.push(page_block(page, BlockKind::Heading, format!("Sheet \"{name}\" is empty"), None));
            continue;
        }

        let rows: Vec<Vec<String>> = range
            .rows()
            .map(|r| {
                r.iter()
                    .map(|c| match c {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => {
                            // Integral floats print as integers: "12" not "12.0".
                            // Spreadsheets store everything as a float and the
                            // trailing .0 turns tag numbers into decimals.
                            if f.fract() == 0.0 && f.abs() < 1e15 {
                                format!("{}", *f as i64)
                            } else {
                                format!("{f}")
                            }
                        }
                        Data::Int(v) => v.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(d) => d.to_string(),
                        Data::DateTimeIso(s) => s.clone(),
                        Data::DurationIso(s) => s.clone(),
                        Data::Error(e) => format!("#ERROR({e:?})"),
                    })
                    .collect()
            })
            .collect();

        let mut rows = rows;
        let header = if rows.is_empty() { Vec::new() } else { rows.remove(0) };
        blocks.push(page_block(page, BlockKind::Heading, format!("Sheet: {name}"), None));
        tables.push(DocTable { id: new_id("tbl"), page, bbox: full_page_box(page), header, rows });

        if let Ok(formulas) = wb.worksheet_formula(name) {
            let listed: Vec<String> = formulas
                .used_cells()
                .filter(|(_, _, f)| !f.is_empty())
                .map(|(r, c, f)| format!("{}{} = {f}", column_letter(c), r + 1))
                .take(400)
                .collect();
            if !listed.is_empty() {
                blocks.push(page_block(
                    page,
                    BlockKind::Text,
                    format!("Formulas in {name}:\n{}", listed.join("\n")),
                    None,
                ));
            }
        }
    }

    if blocks.is_empty() && tables.is_empty() {
        let which = only_sheet.map(|s| format!(" named \"{s}\"")).unwrap_or_default();
        return Err(CoreError::InvalidDocument(format!(
            "No sheet{which} was found in this workbook. Sheets present: {}.",
            names.join(", ")
        )));
    }
    Ok((blocks, tables))
}

/// Spreadsheet column index to its letters — 0 becomes A, 26 becomes AA.
///
/// Shared with `artifacts::write_workbook`, so a cell the operator is told about
/// is addressed the same way whether the workbook was being read or written.
pub(crate) fn column_letter(mut i: usize) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b'A' + (i % 26) as u8);
        if i < 26 {
            break;
        }
        i = i / 26 - 1;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Takes the field built so far, and resets the state for the next one.
///
/// A quoted field keeps its spaces exactly as written; an unquoted one is
/// trimmed, because exports written by hand space their delimiters
/// (`Elbow , 4.8`) and nobody means that space to be part of the value.
fn csv_field(field: &mut String, quoted: &mut bool) -> String {
    let v = std::mem::take(field);
    let v = if *quoted { v } else { v.trim().to_string() };
    *quoted = false;
    v
}

/// One record, and the index the next one starts at.
///
/// RFC 4180 rather than `split(delim)`: a quoted field may hold the delimiter, a
/// line break, or a doubled quote standing for one quote. Splitting instead moved
/// every value after a field like `"Elbow, downstream"` one column left —
/// silently, so an inspection table was read as valid with the readings sitting
/// under the wrong headings, which is worse than failing to read the file at all.
///
/// A quote only opens a quoted field at the start of one. Anywhere else it is the
/// character it looks like: `6" CS line` is a diameter in inches, and treating
/// that mark as an opening quote swallowed the rest of the row into one cell.
fn csv_record(c: &[char], from: usize, delim: char) -> (Vec<String>, usize) {
    let n = c.len();
    let mut fields: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut quoted = false;
    let mut i = from;
    while i < n {
        let ch = c[i];
        if ch == '"' && field.trim().is_empty() {
            // Whitespace ahead of the opening quote is not data.
            field.clear();
            quoted = true;
            i += 1;
            while i < n {
                if c[i] == '"' {
                    // A doubled quote is one quote; a single one closes the field.
                    if i + 1 < n && c[i + 1] == '"' {
                        field.push('"');
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                field.push(c[i]);
                i += 1;
            }
            continue;
        }
        if ch == delim {
            fields.push(csv_field(&mut field, &mut quoted));
            i += 1;
            continue;
        }
        if ch == '\n' || ch == '\r' {
            // CRLF, LF or a lone CR — one record ends on any of them.
            i += 1;
            if ch == '\r' && i < n && c[i] == '\n' {
                i += 1;
            }
            break;
        }
        field.push(ch);
        i += 1;
    }
    fields.push(csv_field(&mut field, &mut quoted));
    (fields, i)
}

/// Every record in the text, blank lines dropped.
fn csv_rows(text: &str, delim: char) -> Vec<Vec<String>> {
    let c: Vec<char> = text.chars().collect();
    // Excel writes a byte-order mark ahead of the first heading, and U+FEFF is
    // not whitespace, so `trim` never removed it: the first column came out named
    // with an invisible character in front of it and every lookup by heading —
    // `header_col(t, "tag")`, the sheet-name match — missed it.
    let mut i = usize::from(c.first() == Some(&'\u{feff}'));
    let mut rows = Vec::new();
    while i < c.len() {
        let (row, next) = csv_record(&c, i, delim);
        i = next;
        // A blank line is not a row. A row whose later columns are empty is.
        if row.iter().any(|f| !f.is_empty()) {
            rows.push(row);
        }
    }
    rows
}

/// Which character separates the fields.
///
/// Indian plant exports are as often semicolon- or tab-separated as
/// comma-separated, and guessing comma unconditionally turns a whole row into one
/// cell. Counting raw occurrences guessed wrong the other way: one comma inside a
/// quoted heading of a semicolon-separated file outvoted the semicolons. So each
/// candidate is actually parsed, and the one that gives every record the same
/// number of fields wins — a delimiter that only appears inside some text cannot
/// do that.
fn csv_delimiter(text: &str) -> char {
    // A sample, so a large export is not parsed three times end to end, cut at a
    // record boundary so a half-read last line does not look ragged.
    let head: String = text.chars().take(64 * 1024).collect();
    let head = match head.rfind('\n') {
        Some(k) if head.len() < text.len() => head[..k].to_string(),
        _ => head,
    };

    let mut best = (',', 0usize);
    for delim in [',', ';', '\t'] {
        let rows: Vec<Vec<String>> = csv_rows(&head, delim).into_iter().take(8).collect();
        let Some(width) = rows.first().map(|r| r.len()).filter(|w| *w > 1) else {
            continue;
        };
        let consistent = rows.iter().all(|r| r.len() == width);
        let score = if consistent { width * 100 } else { width };
        if score > best.1 {
            best = (delim, score);
        }
    }
    best.0
}

fn csv_extract(text: &str) -> (Vec<DocBlock>, Vec<DocTable>) {
    let mut rows = csv_rows(text, csv_delimiter(text));
    let header = if rows.is_empty() { Vec::new() } else { rows.remove(0) };
    let table = DocTable { id: new_id("tbl"), page: 1, bbox: full_page_box(1), header, rows };
    (vec![], vec![table])
}

/* ------------------------------------------------------------------ */
/* Parser containment                                                  */
/* ------------------------------------------------------------------ */

/// Longest side, in pixels, of an image handed to a vision model.
///
/// Scans arrive at 300 dpi, which is roughly 2500×3500 for A4. Sent at that
/// size, the vision model spends most of its budget on image tokens and the
/// transcription of a dense drawing gets truncated. Downscaling to this loses
/// nothing a model can read anyway — its own vision encoder tiles to a fixed
/// grid — and roughly halves the time per page.
const MAX_IMAGE_SIDE: u32 = 2200;

/// Runs a parser with a panic caught and reported as a refusal naming the file.
///
/// This is the counterpart of `panic = "unwind"` in Cargo.toml. `pdf-extract`
/// alone panics in 31 places on paths a real plant archive reaches — an
/// unexpected font encoding, a glyph with no declared width. Without this, one
/// malformed drawing from 1997 takes down the process, and with it the resident
/// model, the run in progress and every browser session attached to it. With it,
/// the operator gets a sentence saying which file could not be read.
fn guard<T>(what: &str, f: impl FnOnce() -> CoreResult<T>) -> CoreResult<T> {
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
    match caught {
        Ok(r) => r,
        Err(payload) => {
            let detail = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "no further detail".into());
            Err(CoreError::InvalidDocument(format!(
                "{what} could not be parsed — the reader failed on malformed structure inside it ({detail}). \
                 Nothing else was affected. If this file matters, exporting the pages as images and \
                 attaching those goes down the OCR path instead, which does not depend on the \
                 internal structure."
            )))
        }
    }
}

/* ------------------------------------------------------------------ */
/* Images                                                             */
/* ------------------------------------------------------------------ */

fn encode_png(img: image::DynamicImage, what: &str) -> CoreResult<Vec<u8>> {
    let (w, h) = (img.width(), img.height());
    let img = if w.max(h) > MAX_IMAGE_SIDE {
        img.resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, image::imageops::FilterType::CatmullRom)
    } else {
        img
    };

    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| {
        CoreError::OcrFailed(format!("{what} could not be re-encoded for the model ({e})."))
    })?;
    Ok(out.into_inner())
}

/// The OCR prompt.
///
/// Written to suppress the two habits that make a transcription useless in an
/// inspection record: summarising instead of transcribing, and filling in an
/// unreadable field with something plausible. A `[illegible]` marker an engineer
/// can go and check beats a confident wrong reading they cannot.
/// The table layout shown to the vision model.
///
/// Placeholders rather than plant data, which is the whole point: see the
/// comment inside `ocr_prompt`, and `example_cells` for what happens when the
/// model copies this back.
const TABLE_EXAMPLE: &str = "| Column heading | Column heading | Column heading |
|---|---|---|
| cell | cell | cell |";

fn ocr_prompt(kind: DocumentKind) -> String {
    let specific = match kind {
        DocumentKind::Drawing => {
            "This is an engineering drawing or P&ID. First report the title block as text: \
             drawing number, title, revision, date and scale. Then the notes and legend as text. \
             Then give these tables, each with exactly these headings:\n\n\
             Equipment register (every equipment and instrument symbol on the drawing, one row \
             each, tag exactly as printed):\n\
             | Tag | Type | Description |\n\n\
             Line list (one row per numbered line on the drawing):\n\
             | Line number | From | To | Size | Service |\n\n\
             In the line list, From and To are the tags or line identifiers each line runs \
             between, in the direction of flow where the drawing shows it — this is the \
             connectivity of the plant, so every line matters. Where the drawing does not make \
             a connection unambiguous, write [unclear] in that cell rather than guessing."
        }
        DocumentKind::Handwriting => {
            "This is handwritten. Transcribe it line by line, keeping the original line breaks. \
             Where a word is genuinely unreadable write [illegible] rather than guessing. Keep \
             numbers and units exactly as written — a misread digit in a thickness reading is a \
             safety problem, an [illegible] is not."
        }
        DocumentKind::Photograph => {
            "This is a photograph taken in a plant. Describe what is visible: equipment and its \
             condition, any nameplate or tag text (transcribe it exactly), visible corrosion, \
             leaks, insulation damage or missing guards. Do not diagnose beyond what is visible."
        }
        _ => {
            "This is a scanned page. Transcribe all of its text, preserving reading order, \
             headings and paragraph breaks."
        }
    };

    // The pipe example is not decoration. Asked only for "a Markdown table", a
    // vision model transcribes the columns the way the page lays them out —
    // separated by single spaces — and a thickness log that plainly contains a
    // table then parses as prose, leaving the record with no table in it. Shown
    // the three lines it is meant to produce, the same model produces them.
    //
    // The cells are placeholders because a vision model shown an example copies
    // it when the page gives it nothing to transcribe. The first P&ID put through
    // here came back carrying `TP-01 | 11.9 | Acceptable` — a thickness reading,
    // with a verdict, on a drawing that never mentioned one. In a record an
    // inspector signs against, an invented measurement is worse than a missing
    // one. An example built from words no real page carries cannot be mistaken
    // for the page, and `example_cells` drops it if it is copied anyway.
    format!(
        "{specific}\n\n\
         Write every table with pipes, exactly like this:\n\n\
         {TABLE_EXAMPLE}\n\n\
         Keep every column and every row — do not summarise a table, do not drop rows to save \
         space, and never lay a table out with spaces instead of pipes. Transcribe only what is \
         on the page: add no commentary, no interpretation, and no preamble such as \
         \"Here is the transcription\". That example shows the layout only: never copy \
         its words, and where the page holds no table, write no table. Where the page is \
         unreadable, write [illegible]."
    )
}

/// Splits a transcribed line into cells.
///
/// Column separators do not survive OCR. The models transcribe a bordered table
/// the way the page reads it — `TP-04 7.1 2.4 Below limit` — and a plain split on
/// whitespace turns a two-word verdict into two columns, so no two rows agree on
/// a width and the block stops looking like a table. What holds instead is how a
/// cell *starts*: engineering tables are built from tags, numbers, units and
/// Title-case labels. So a lower-case word continues the cell before it, and a
/// bracketed unit belongs to the label it follows — under which `Test point
/// Measured (mm) Loss (mm) Verdict` and every row beneath it agree on four cells.
///
/// A number never takes a trailing word: `0.8 acceptable` is two cells, because a
/// reading and a verdict are not one column.
fn ocr_cells(line: &str) -> Vec<String> {
    let mut cells: Vec<String> = Vec::new();
    for tok in line.split_whitespace() {
        let continues = tok.starts_with(['(', '[', '/']) || tok.starts_with(char::is_lowercase);
        let after_number = cells.last().is_some_and(|c| is_measurement(c));
        match cells.last_mut() {
            Some(last) if continues && !after_number => {
                last.push(' ');
                last.push_str(tok);
            }
            _ => cells.push(tok.to_string()),
        }
    }
    cells
}

/// Whether a cell is a bare reading rather than a word — digits and the
/// punctuation a measurement carries, nothing else. `12.7` and `14/03/2026` are
/// measurements; `TP-01` and `4-P-1102-6in-CS` are not.
fn is_measurement(cell: &str) -> bool {
    let t = cell.trim_start_matches(['+', '-', '(']);
    !t.is_empty()
        && t.starts_with(|c: char| c.is_ascii_digit())
        && t.chars().all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '%' | ')' | '-' | '/' | ':'))
}

/// Rewrites space-separated table rows as Markdown table rows.
///
/// The prompt shows the model the pipe syntax and the general vision models use
/// it; `paddleocr-vl`, which is the one that reads printed scans, transcribes the
/// table as plain lines regardless — its job is to read the page, not to format
/// it. The structure has to be recovered from the text or the record for a
/// thickness log comes back with no table in it at all.
///
/// The signal is agreement. Three or more consecutive lines that split into the
/// same number of cells with readings in exactly the same positions are columns;
/// prose does not do that. On the record this was written for, the four test-point
/// rows agree on `[tag, number, number, word]` and every other line on the page —
/// the six labelled fields, the caption, the remarks paragraph — disagrees with
/// its neighbours on width, on where the numbers sit, or has no number at all.
/// The line above the block becomes the header when it has the same width and no
/// readings of its own.
///
/// Two-row tables are left as prose. The third line of agreement is what makes
/// this a column structure rather than a coincidence, and a wrongly invented
/// table would misrepresent the page to everyone downstream.
fn pipe_aligned_tables(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let cells: Vec<Vec<String>> = lines.iter().map(|l| ocr_cells(l)).collect();
    let readings = |row: &[String]| -> Vec<bool> { row.iter().map(|c| is_measurement(c)).collect() };
    // A line that cannot be a row of a space-aligned table: it is already a
    // Markdown table row, or it is a bullet.
    //
    // The bullet half is not fussiness. A vision model reports a drawing's
    // instrument tags as a list, and `- PSV 1101` splits into three cells with the
    // same shape as the four lines under it — so five tags came back as a five-row
    // table headed `Column 1 | Column 2 | Column 3`, with `PSV-1101` torn across
    // two of them, the list's own heading orphaned above it, and the tags then
    // invisible to `extract_tags`. A tag split in half is worse than a list left
    // as a list.
    let not_a_row = |i: usize| {
        let t = lines[i].trim_start();
        t.starts_with('|')
            || cells[i].iter().any(|c| c.contains('|'))
            || matches!(t.split_whitespace().next(), Some("-" | "*" | "+" | "•"))
    };

    // How many consecutive lines from `start` share one column structure, or 0
    // when there is no table there.
    let group_at = |start: usize| -> usize {
        if start >= lines.len() || not_a_row(start) {
            return 0;
        }
        let width = cells[start].len();
        let shape = readings(&cells[start]);
        if width < 3 || !shape.iter().any(|&b| b) {
            return 0;
        }
        let mut end = start;
        while end < lines.len() && !not_a_row(end) && cells[end].len() == width && readings(&cells[end]) == shape {
            end += 1;
        }
        match end - start {
            n if n >= 3 => n,
            _ => 0,
        }
    };

    let mut out: Vec<String> = Vec::new();
    let mut i = 0usize;
    while i < lines.len() {
        let below = group_at(i + 1);
        let is_header = below > 0
            && !not_a_row(i)
            && cells[i].len() == cells[i + 1].len()
            && !readings(&cells[i]).iter().any(|&b| b);
        let (head, rows_at, n) = if is_header {
            (Some(i), i + 1, below)
        } else {
            (None, i, group_at(i))
        };
        if n == 0 {
            out.push(lines[i].to_string());
            i += 1;
            continue;
        }
        let width = cells[rows_at].len();
        let header = match head {
            Some(h) => cells[h].join(" | "),
            // Never blank: a row of pipes and spaces would read back as the
            // separator, and the first reading would be taken for a heading.
            None => (1..=width).map(|c| format!("Column {c}")).collect::<Vec<_>>().join(" | "),
        };
        out.push(format!("| {header} |"));
        out.push(format!("|{}", "---|".repeat(width)));
        for row in &cells[rows_at..rows_at + n] {
            out.push(format!("| {} |", row.join(" | ")));
        }
        i = rows_at + n;
    }
    out.join("\n")
}

/// Whether a row is one of the prompt example rows, copied back.
///
/// A vision model shown an example table reproduces it when the page has none.
/// That is not a transcription error the operator can spot: the example is a
/// plausible engineering row, so it lands in the record looking exactly like
/// everything around it that was read off the page.
///
/// Only a verbatim echo of `TABLE_EXAMPLE` is dropped, and it is safe to drop
/// only because that example is built from words no real page carries. A guard
/// written against a realistic example would delete real data instead — a UT
/// record's own header is `Test point | Measured (mm) | Verdict`.
fn example_cells(row: &[String]) -> bool {
    let cells = |line: &str| -> Vec<String> {
        line.trim().trim_matches('|').split('|').map(|c| c.trim().to_lowercase()).collect()
    };
    let got = cells(&row.join("|"));
    TABLE_EXAMPLE.lines().filter(|l| !l.contains("---")).any(|l| cells(l) == got)
}

/// A table cell as the model wrote it, with the markup a chat renderer would
/// have swallowed taken back out.
///
/// A vision model asked for Markdown puts two facts in one cell as
/// `P-4102A DISCH<br>WIKA 233.50`. The document panel renders a cell as text, so
/// left alone that tag arrives as four literal characters in the middle of a
/// nameplate reading — and so does the answer that quotes the cell.
fn cell_text(raw: &str) -> String {
    const BREAKS: [&str; 6] = ["<br>", "<br/>", "<br />", "<BR>", "<BR/>", "<BR />"];
    let mut out = raw.to_string();
    for tag in BREAKS {
        if out.contains(tag) {
            out = out.replace(tag, " ");
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Splits an OCR transcription into blocks, lifting Markdown tables out as tables.
///
/// The model is asked for Markdown tables, so the table structure is already in
/// the text; parsing it back out is what lets the document viewer show a real
/// table and what lets a later question be answered from a row rather than from
/// a paragraph that happens to mention it.
fn split_ocr(page: u32, text: &str, kind: DocumentKind) -> (Vec<DocBlock>, Vec<DocTable>) {
    let text = pipe_aligned_tables(text);
    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut prose: Vec<&str> = Vec::new();
    let mut pending: Vec<Vec<String>> = Vec::new();

    let flush_prose = |prose: &mut Vec<&str>, blocks: &mut Vec<DocBlock>| {
        let joined = prose.join("\n").trim().to_string();
        prose.clear();
        if joined.is_empty() {
            return;
        }
        let bk = if kind == DocumentKind::Handwriting {
            BlockKind::Handwriting
        } else {
            BlockKind::Text
        };
        blocks.push(page_block(page, bk, joined, None));
    };

    let flush_table = |pending: &mut Vec<Vec<String>>, tables: &mut Vec<DocTable>| {
        if pending.is_empty() {
            return;
        }
        let mut rows = std::mem::take(pending);
        let header = rows.remove(0);
        // The example out of the prompt, copied back, is not a row of the
        // document. Rows go one at a time so a real table that picked one up
        // keeps its real rows; a table that is nothing but the example goes.
        rows.retain(|r| !example_cells(r));
        if rows.is_empty() && example_cells(&header) {
            return;
        }
        tables.push(DocTable { id: new_id("tbl"), page, bbox: full_page_box(page), header, rows });
    };

    for line in text.lines() {
        let t = line.trim();
        // A Markdown table row: starts and ends with a pipe and has an interior
        // one. The separator row (|---|---|) is structure, not data.
        let is_row = t.starts_with('|') && t.ends_with('|') && t.len() > 2;
        let is_sep = is_row && t.chars().all(|c| matches!(c, '|' | '-' | ':' | ' '));

        if is_row {
            if !prose.is_empty() {
                flush_prose(&mut prose, &mut blocks);
            }
            if is_sep {
                continue;
            }
            let cells: Vec<String> = t.trim_matches('|').split('|').map(cell_text).collect();
            pending.push(cells);
            continue;
        }

        if !pending.is_empty() {
            flush_table(&mut pending, &mut tables);
        }
        if t.is_empty() {
            flush_prose(&mut prose, &mut blocks);
        } else if t.starts_with('#') {
            flush_prose(&mut prose, &mut blocks);
            blocks.push(page_block(page, BlockKind::Heading, t.trim_start_matches('#').trim(), None));
        } else {
            prose.push(line);
        }
    }
    flush_table(&mut pending, &mut tables);
    flush_prose(&mut prose, &mut blocks);

    (blocks, tables)
}

/* ------------------------------------------------------------------ */
/* Drawing registers                                                  */
/* ------------------------------------------------------------------ */

/// A cell the model writes when the drawing does not answer — the prompt's
/// honesty placeholders. They are a fact about the *drawing* (this connection
/// is not unambiguous), not about the equipment, so they never become the tag
/// or the description of a Tag block.
fn is_placeholder(cell: &str) -> bool {
    let t = cell.trim();
    t.is_empty() || t.starts_with('[') || t == "-" || t == "—"
}

/// Column index of the first header cell containing `needle`, case-blind.
fn header_col(table: &DocTable, needle: &str) -> Option<usize> {
    table
        .header
        .iter()
        .position(|h| h.to_lowercase().contains(needle))
}

/// Turns a drawing's equipment register and line list into Tag blocks.
///
/// `BlockKind::Tag` is what the rest of the pipeline treats as a verbatim,
/// never-split fact: the knowledge indexer pushes each one through whole, and
/// the viewer paints it with the tag overlay. A drawing is the one document
/// kind whose payload *is* its tags, so the register becomes one block per
/// equipment item — tag, type and description together, so "which pumps feed
/// V-301" retrieves the line that answers it rather than a window of prose
/// that happens to contain the number.
///
/// The tables are identified by their headings rather than their position in
/// the reply, because the model is asked for them in an order but the order it
/// writes them in is its own. Anything that is not a register or a line list —
/// a title-block table the drawing itself carried, say — is left as the table
/// it already is.
fn drawing_tag_blocks(tables: &[DocTable]) -> Vec<DocBlock> {
    let mut out = Vec::new();
    for t in tables {
        let tag_col = header_col(t, "tag");
        let from_col = header_col(t, "from");
        let to_col = header_col(t, "to");

        if let Some(ti) = tag_col.filter(|_| header_col(t, "type").is_some() || header_col(t, "description").is_some()) {
            let type_col = header_col(t, "type");
            let desc_col = header_col(t, "description");
            for row in &t.rows {
                let cell = |c: Option<usize>| c.and_then(|i| row.get(i)).map(|s| s.trim()).unwrap_or_default();
                if is_placeholder(&cell(Some(ti))) {
                    continue;
                }
                let (ty, de) = (cell(type_col), cell(desc_col));
                let text = match (ty.is_empty() || is_placeholder(&ty), is_placeholder(&de)) {
                    (false, false) => format!("{} — {}: {}", cell(Some(ti)), ty, de),
                    (false, true) => format!("{} — {}", cell(Some(ti)), ty),
                    _ => cell(Some(ti)).to_string(),
                };
                out.push(page_block(t.bbox.page, BlockKind::Tag, text, None));
            }
        } else if header_col(t, "line number").is_some() || (from_col.is_some() && to_col.is_some()) {
            // The line list's From/To columns are the plant's connectivity, so
            // each line becomes one block carrying both ends. Size and service
            // ride along when the model filled them in — they are what makes
            // "the 6-inch CS line" a query that can land.
            let line_col = header_col(t, "line number");
            let size_col = header_col(t, "size");
            let service_col = header_col(t, "service");
            for row in &t.rows {
                let cell = |c: Option<usize>| c.and_then(|i| row.get(i)).map(|s| s.trim()).unwrap_or_default();
                let (line_no, from, to) = (cell(line_col), cell(from_col), cell(to_col));
                if is_placeholder(&line_no) && is_placeholder(&from) && is_placeholder(&to) {
                    continue;
                }
                let mut text = match (line_no.is_empty(), from.is_empty(), to.is_empty()) {
                    (false, false, false) => format!("Line {line_no}: {from} to {to}"),
                    (false, false, true) | (false, true, false) => {
                        format!("Line {line_no}: {}", if from.is_empty() { to } else { from })
                    }
                    _ => continue,
                };
                let size = cell(size_col);
                let service = cell(service_col);
                if !is_placeholder(&size) {
                    text.push_str(&format!(", {size}"));
                }
                if !is_placeholder(&service) {
                    text.push_str(&format!(", {service}"));
                }
                out.push(page_block(t.bbox.page, BlockKind::Tag, text, None));
            }
        }
    }
    out
}

/* ------------------------------------------------------------------ */
/* PDF                                                                */
/* ------------------------------------------------------------------ */

/// Text layer, page by page, or `None` when there is not enough of one.
///
/// `None` is the signal to try the scanned path. The judgement is per document
/// rather than per page because a mixed PDF — a typed report with two scanned
/// annexures — is better handled as one native document with two thin pages than
/// as a document whose extraction method depends on where you look.
fn pdf_native_pages(bytes: &[u8], what: &str) -> CoreResult<Option<Vec<String>>> {
    let pages = guard(what, || {
        pdf_extract::extract_text_from_mem_by_pages(bytes).map_err(|e| {
            CoreError::InvalidDocument(format!("{what} could not be read as a PDF ({e})."))
        })
    })?;

    if pages.is_empty() {
        return Ok(None);
    }
    let total: usize = pages.iter().map(|p| p.trim().len()).sum();
    if total / pages.len() < MIN_CHARS_PER_PAGE {
        return Ok(None);
    }
    Ok(Some(pages))
}

/// One PNG per page, pulled out of the PDF's embedded image XObjects.
///
/// The largest image on a page is the page: a scanner writes exactly one
/// full-page image, and anything else on the page — a logo, a signature stamp —
/// is smaller. Taking the largest rather than all of them avoids OCR'ing the
/// company letterhead forty times.
fn pdf_page_images(bytes: &[u8], what: &str) -> CoreResult<Vec<(u32, Vec<u8>)>> {
    let doc = lopdf::Document::load_mem(bytes).map_err(|e| {
        CoreError::InvalidDocument(format!(
            "{what} has no readable text layer, and its structure could not be parsed either ({e}), \
             so the pages could not be recovered as images."
        ))
    })?;

    let pages = doc.get_pages();
    let mut out: Vec<(u32, Vec<u8>)> = Vec::new();
    let mut unsupported: Vec<String> = Vec::new();

    for (page_no, page_id) in pages.into_iter() {
        if out.len() >= MAX_OCR_PAGES {
            break;
        }
        let Ok(images) = doc.get_page_images(page_id) else { continue };

        let Some(biggest) = images
            .into_iter()
            .filter(|i| i.width * i.height >= MIN_PAGE_IMAGE_PIXELS)
            .max_by_key(|i| i.width * i.height)
        else {
            continue;
        };

        let filters = biggest.filters.clone().unwrap_or_default();
        match decode_pdf_image(&biggest) {
            Ok(png) => out.push((page_no, png)),
            Err(reason) => {
                unsupported.push(format!("page {page_no} ({reason})"));
                let _ = filters;
            }
        }
    }

    if out.is_empty() {
        let detail = if unsupported.is_empty() {
            "no full-page images were found in it either — it may be a vector-only drawing exported \
             without a text layer"
                .to_string()
        } else {
            format!("its page images use encodings this build does not decode: {}", unsupported.join(", "))
        };
        return Err(CoreError::InvalidDocument(format!(
            "{what} has no text layer, and {detail}. Opening it in a PDF viewer and exporting the \
             pages as PNG, then attaching those, goes down the OCR path and works fully."
        )));
    }
    Ok(out)
}

/// One embedded PDF image to PNG, or a short reason it could not be.
///
/// Two shapes cover current scanners and every "print to PDF" path. `DCTDecode`
/// leaves a complete JPEG in the stream, which the `image` crate decodes
/// directly. `FlateDecode` and no filter at all leave raw samples, which have to
/// be given a colour interpretation from the dictionary because the bytes alone
/// do not say whether they are grey, RGB or CMYK.
fn decode_pdf_image(img: &lopdf::xobject::PdfImage<'_>) -> Result<Vec<u8>, String> {
    let filters = img.filters.clone().unwrap_or_default();
    let is_jpeg = filters.iter().any(|f| f == "DCTDecode" || f == "DCT")
        || img.content.starts_with(&[0xFF, 0xD8, 0xFF]);

    if is_jpeg {
        let decoded = image::load_from_memory_with_format(img.content, image::ImageFormat::Jpeg)
            .map_err(|e| format!("its JPEG data would not decode: {e}"))?;
        return encode_png(decoded, "A scanned page").map_err(|e| e.to_string());
    }

    for f in &filters {
        match f.as_str() {
            "JPXDecode" => return Err("JPEG 2000".into()),
            "CCITTFaxDecode" => return Err("CCITT Group 3/4 fax".into()),
            "JBIG2Decode" => return Err("JBIG2".into()),
            _ => {}
        }
    }

    // get_page_images exposes the ORIGINAL stream, including compressed bytes.
    // Decode through its dictionary so Flate predictors are handled as well.
    let content = if filters.is_empty() {
        img.content.to_vec()
    } else {
        lopdf::Stream::new(img.origin_dict.clone(), img.content.to_vec())
            .decompressed_content_with_limit(128 * 1024 * 1024)
            .map_err(|e| format!("its image stream could not be decompressed: {e}"))?
    };
    let bpc = img.bits_per_component.unwrap_or(8);
    if bpc != 8 {
        return Err(format!("{bpc} bits per component, which this build does not unpack"));
    }
    let w = u32::try_from(img.width).map_err(|_| "an implausible width".to_string())?;
    let h = u32::try_from(img.height).map_err(|_| "an implausible height".to_string())?;
    let px = (w as usize) * (h as usize);
    if px == 0 {
        return Err("zero pixels".into());
    }

    let space = img.color_space.clone().unwrap_or_default();
    let components = content.len() / px.max(1);

    let dynamic = match (components, space.as_str()) {
        (1, _) => image::GrayImage::from_raw(w, h, content.clone())
            .map(image::DynamicImage::ImageLuma8),
        (3, _) => image::RgbImage::from_raw(w, h, content.clone())
            .map(image::DynamicImage::ImageRgb8),
        (4, _) => {
            // CMYK, and PDF stores it inverted for DeviceN separations often
            // enough that a naive read produces a negative. Convert plainly and
            // accept a colour cast: this is going to OCR, not to a printer.
            let mut rgb = Vec::with_capacity(px * 3);
            for chunk in content.chunks_exact(4) {
                let (c, m, y, k) = (chunk[0] as u32, chunk[1] as u32, chunk[2] as u32, chunk[3] as u32);
                rgb.push((255 - (c * k / 255).min(255)) as u8);
                rgb.push((255 - (m * k / 255).min(255)) as u8);
                rgb.push((255 - (y * k / 255).min(255)) as u8);
            }
            image::RgbImage::from_raw(w, h, rgb).map(image::DynamicImage::ImageRgb8)
        }
        _ => None,
    }
    .ok_or_else(|| {
        format!(
            "{} bytes of {space} samples for {w}×{h}, which is not a layout this build recognises",
            content.len()
        )
    })?;

    encode_png(dynamic, "A scanned page").map_err(|e| e.to_string())
}

/* ------------------------------------------------------------------ */
/* Kind classification                                                */
/* ------------------------------------------------------------------ */

/// What kind of thing this file is, and why — decided from the name and, for
/// images, from the pixels.
///
/// The distinction matters because it selects the model and the prompt: a P&ID
/// wants tag and topology extraction from the 9B, a printed page wants the fast
/// OCR model, a photograph wants description rather than transcription. Getting
/// it from a filename alone would misroute half of everything, since a plant
/// scanner names its output `SCAN0042.jpg` regardless of what was on the glass.
///
/// The pixel test is a real classifier, not a guess dressed up as one: line art
/// is a mostly-white image with almost no colour saturation, and a photograph is
/// not. It is stated in the returned reason so the operator can see the call that
/// was made and correct it by renaming if it was wrong.
fn classify_image(img: &image::DynamicImage, file_name: &str) -> (DocumentKind, String) {
    let lower = file_name.to_lowercase();

    const DRAWING: &[&str] = &["p&id", "pid", "pnid", "isometric", "iso-", "drawing", "dwg", "gad", "layout", "schematic", "plot-plan", "datasheet"];
    const HAND: &[&str] = &["handwrit", "hand-writ", "notes", "notebook", "logbook", "sketch", "scribble", "diary"];
    const PHOTO: &[&str] = &["photo", "img_", "dsc", "camera", "site-", "inspection-photo", "whatsapp"];

    if DRAWING.iter().any(|k| lower.contains(k)) {
        return (
            DocumentKind::Drawing,
            "the file name identifies it as a drawing or P&ID".into(),
        );
    }
    if HAND.iter().any(|k| lower.contains(k)) {
        return (DocumentKind::Handwriting, "the file name identifies it as handwritten".into());
    }
    if PHOTO.iter().any(|k| lower.contains(k)) {
        return (DocumentKind::Photograph, "the file name identifies it as a photograph".into());
    }

    // Sample rather than scan: a 2200×3000 image is 6.6M pixels and the answer
    // does not change after a few thousand. Every 17th pixel avoids landing on a
    // regular pattern, which a fixed stride of 10 or 16 does on dithered scans.
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width(), rgb.height());
    let total = (w as u64) * (h as u64);
    if total == 0 {
        return (DocumentKind::Image, "the image has no pixels to examine".into());
    }

    let mut sampled = 0u64;
    let mut near_white = 0u64;
    let mut saturation_sum = 0u64;
    let raw = rgb.as_raw();
    let mut i = 0usize;
    while i + 2 < raw.len() {
        let (r, g, b) = (raw[i] as u32, raw[i + 1] as u32, raw[i + 2] as u32);
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        if max > 235 && min > 225 {
            near_white += 1;
        }
        saturation_sum += (max - min) as u64;
        sampled += 1;
        i += 3 * 17;
    }
    if sampled == 0 {
        return (DocumentKind::Image, "the image was too small to examine".into());
    }

    let white_pct = near_white * 100 / sampled;
    let mean_sat = saturation_sum / sampled;

    if white_pct >= 55 && mean_sat < 24 {
        // Near-white with no colour is a scan or a drawing, and the difference
        // is the ruling: a P&ID is long straight lines and symbols spread over
        // the sheet, while a page of text is short strokes clustered into
        // lines. The bias is deliberate — a text page sent down the drawing
        // route is transcribed correctly by a bigger model and merely costs
        // time, while a drawing sent to the OCR specialist loses every
        // connection on the sheet.
        let runs = long_stroke_runs(&rgb);
        if runs >= 6 {
            return (
                DocumentKind::Drawing,
                format!(
                    "{white_pct}% of the pixels are near-white and {runs} long straight \
                     line segments were sampled, which is an engineering drawing rather \
                     than a page of text"
                ),
            );
        }
        (
            DocumentKind::Image,
            format!("{white_pct}% of the pixels are near-white with almost no colour, which is a scanned or printed page rather than a photograph"),
        )
    } else {
        (
            DocumentKind::Photograph,
            format!("only {white_pct}% of the pixels are near-white and the mean colour spread is {mean_sat}/255, which is a photograph rather than a scan"),
        )
    }
}

/// How many long straight dark segments a sampled grid of rows and columns
/// crosses. This is the line-art signature: text strokes are a few pixels
/// wide, so a row through a paragraph crosses many *short* runs and no long
/// ones, while a row through a P&ID crosses process lines, headers and borders
/// that run for a good fraction of the sheet's width.
///
/// The threshold is a run of at least 4% of the dimension, and the sample is
/// every 96th row and column so the count is a rate, not an artefact of image
/// size. 96th, not 48th: process lines are only 3-5 px thick, and a coarser
/// grid steps straight over them — a 1150 px sheet sampled every 23rd row hit
/// 5 of its long lines, one short of the drawing threshold. Small images are
/// skipped by the caller — under a few hundred pixels the runs are noise.
fn long_stroke_runs(rgb: &image::RgbImage) -> usize {
    let (w, h) = (rgb.width(), rgb.height());
    if w < 300 || h < 300 {
        return 0;
    }
    let dark = |x: u32, y: u32| {
        let p = rgb.get_pixel(x, y);
        (p[0] as u32 * 3 + p[1] as u32 * 6 + p[2] as u32) / 10 < 128
    };
    let min_run_w = (w / 25).max(8);
    let min_run_h = (h / 25).max(8);

    let mut runs = 0usize;
    // Rows: walk full horizontal lines, count maximal dark stretches.
    let mut y = h / 96;
    while y < h {
        let mut run = 0u32;
        let mut x = 0;
        while x <= w {
            let d = x < w && dark(x, y);
            if d {
                run += 1;
            } else {
                if run >= min_run_w {
                    runs += 1;
                }
                run = 0;
            }
            x += 1;
        }
        y += h / 96;
    }
    // Columns: the same, vertically — isometrics and column-driven layouts
    // are mostly vertical lines.
    let mut x = w / 96;
    while x < w {
        let mut run = 0u32;
        let mut y = 0;
        while y <= h {
            let d = y < h && dark(x, y);
            if d {
                run += 1;
            } else {
                if run >= min_run_h {
                    runs += 1;
                }
                run = 0;
            }
            y += 1;
        }
        x += w / 96;
    }
    runs
}

/// The routing task for a document kind.
fn task_of(kind: DocumentKind) -> TaskKind {
    match kind {
        DocumentKind::Drawing => TaskKind::EngineeringDrawing,
        DocumentKind::Handwriting => TaskKind::Handwriting,
        DocumentKind::Photograph => TaskKind::Photograph,
        DocumentKind::PdfScanned | DocumentKind::Image => TaskKind::ScannedDocument,
        _ => TaskKind::DigitalDocument,
    }
}

/* ------------------------------------------------------------------ */
/* Preview                                                            */
/* ------------------------------------------------------------------ */

/// Longest side of the stored preview.
///
/// Small on purpose. The preview is a base64 data URI held in a SQLite row and
/// sent to the frontend with every document list; at full scan resolution that
/// is megabytes per document, and the document panel would take seconds to open.
/// 900px is enough to see which page you are looking at, which is all the
/// preview is for — the overlay coordinates are normalised, so they land
/// correctly at any preview size.
const PREVIEW_SIDE: u32 = 900;

fn preview_data_uri(png: &[u8]) -> Option<String> {
    let img = image::load_from_memory(png).ok()?;
    let small = img.resize(PREVIEW_SIDE, PREVIEW_SIDE, image::imageops::FilterType::Triangle);
    let mut out = std::io::Cursor::new(Vec::new());
    // JPEG for the preview, PNG for the model. The preview only has to look
    // right to a person, and JPEG at this size is a tenth of the bytes.
    small
        .write_to(&mut out, image::ImageFormat::Jpeg)
        .ok()?;
    Some(format!("data:image/jpeg;base64,{}", b64(&out.into_inner())))
}

fn b64(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/* ------------------------------------------------------------------ */
/* OCR                                                                */
/* ------------------------------------------------------------------ */

/// Chooses the vision model for a kind and says so, on the record.
///
/// The step is the point. §3 requires the choice to be visible, and a
/// transcription that appears with no indication of what produced it is not
/// auditable — an inspection record has to be traceable to the model that read
/// it, which is also why the id is stored on the document row.
fn choose_vision_model(st: &AppState, kind: DocumentKind, why: &str, pages: usize) -> CoreResult<String> {
    let decision = {
        let reg = st.registry.read().expect("registry lock");
        reg.route(task_of(kind), None)
    };

    let model_id = decision.model_id.clone().ok_or_else(|| {
        CoreError::OcrFailed(format!(
            "No vision model is configured for {:?}, so nothing could read it. Check the Models panel.",
            kind
        ))
    })?;

    Step::start(st, StepKind::SelectingModel, format!("Reading as {}", kind_label(kind)))
        .model(Some(model_id.clone()))
        .detail(format!(
            "Chose {model_id} for {} {}: {why}. {}",
            pages,
            if pages == 1 { "page" } else { "pages" },
            decision.reason
        ))
        .ok(st);

    Ok(model_id)
}

fn kind_label(kind: DocumentKind) -> &'static str {
    match kind {
        DocumentKind::PdfDigital => "a digital PDF",
        DocumentKind::PdfScanned => "a scanned PDF",
        DocumentKind::Docx => "a Word document",
        DocumentKind::Xlsx => "a spreadsheet",
        DocumentKind::Pptx => "a presentation",
        DocumentKind::Text => "a text file",
        DocumentKind::Markdown => "a Markdown file",
        DocumentKind::SourceCode => "source code",
        DocumentKind::Image => "a scanned page",
        DocumentKind::Photograph => "a photograph",
        DocumentKind::Handwriting => "handwriting",
        DocumentKind::Drawing => "an engineering drawing",
    }
}

/// Why a page transcription cannot be trusted, or `None` if it can.
///
/// There is no confidence number to threshold against: `router::vision` returns
/// text, and llama.cpp's OCR path exposes no per-token probability. What there is
/// is the shape of a failed read — a handful of characters for a whole page, or a
/// page that came back mostly as punctuation and replacement characters because
/// the model could not resolve the glyphs. PaddleOCR-VL fails that way on
/// handwriting: it is a printed-text reader, and asked to read a hand-filled log
/// sheet it returns a few fragments rather than an error.
///
/// So the §3 escalation is written against the shape and says so. Calling this
/// "confidence below threshold" would imply a number the pipeline does not have.
fn unreadable(text: &str) -> Option<String> {
    /// Below this, a full page has not been read. A near-empty page of a scanned
    /// document does exist — a divider, a stamp — and costs one extra pass.
    const MIN_CHARS: usize = 24;
    /// Below this proportion of letters and digits, what came back is noise.
    const MIN_ALNUM: f32 = 0.55;

    let solid: Vec<char> = text.chars().filter(|c| !c.is_whitespace()).collect();
    if solid.len() < MIN_CHARS {
        return Some(format!(
            "only {} characters came back for the whole page",
            solid.len()
        ));
    }
    if solid.contains(&char::REPLACEMENT_CHARACTER) {
        return Some("the transcription contains characters the model could not resolve".into());
    }
    let alnum = solid.iter().filter(|c| c.is_alphanumeric()).count() as f32 / solid.len() as f32;
    (alnum < MIN_ALNUM).then(|| {
        format!(
            "only {}% of what came back is letters or digits, so the page was not read",
            (alnum * 100.0).round() as u32
        )
    })
}

/// Transcribes pages with a vision model, one call per page.
///
/// One page per call rather than a batch: the models here take a single image
/// reliably and several unreliably, page boundaries in the output become
/// guesswork once two pages are in one reply, and a failure on page nine should
/// not lose pages one to eight. The cost is more round trips to a server on
/// loopback, which is not a cost.
///
/// A page the primary could not read is tried once more with the rule's fallback
/// — see `Registry::escalation` and `unreadable`. Both passes are in the step
/// stream under their own model names, because "this page was read by olmOCR
/// after PaddleOCR could not" is exactly the provenance an inspection record
/// needs to carry.
async fn ocr_pages(
    st: &AppState,
    model_id: &str,
    kind: DocumentKind,
    pages: Vec<(u32, Vec<u8>)>,
) -> CoreResult<(Vec<DocBlock>, Vec<DocTable>, Vec<String>)> {
    let prompt = ocr_prompt(kind);
    let total = pages.len();
    let mut blocks = Vec::new();
    let mut tables = Vec::new();
    let mut failures = Vec::new();
    // Pages the primary read too thinly to keep, with the reason, held for one
    // escalation pass.
    let mut thin: Vec<(u32, String)> = Vec::new();

    for (page_no, png) in &pages {
        let page_no = *page_no;
        let step = Step::start(
            st,
            if matches!(kind, DocumentKind::Photograph | DocumentKind::Drawing) {
                StepKind::Vision
            } else {
                StepKind::Ocr
            },
            format!("Reading page {page_no} of {total}"),
        )
        .model(Some(model_id.to_string()));

        match crate::router::vision(st, model_id, vec![png.clone()], &prompt).await {
            Ok(text) if text.trim().is_empty() => {
                step.detail("The model returned nothing for this page.").skip(st);
                thin.push((page_no, "the model returned nothing".to_string()));
            }
            // Too thin to keep: held for the escalation pass rather than counted
            // as read, because a page of fragments in an inspection record is
            // worse than a page the operator is told was not transcribed.
            Ok(text) if unreadable(&text).is_some() => {
                let why = unreadable(&text).unwrap_or_default();
                step.detail(format!("Not usable: {why}.")).skip(st);
                thin.push((page_no, why));
            }
            Ok(text) => {
                let (b, t) = split_ocr(page_no, &text, kind);
                step.detail(format!(
                    "{} characters, {} block{}, {} table{}",
                    text.len(),
                    b.len(),
                    if b.len() == 1 { "" } else { "s" },
                    t.len(),
                    if t.len() == 1 { "" } else { "s" }
                ))
                .ok(st);
                blocks.extend(b);
                tables.extend(t);
            }
            Err(e) => {
                // One bad page does not fail the document. The pages that were
                // read are worth having, and the ones that were not are named.
                step.fail(st, &e.to_string());
                // And it goes to the escalation pass, not straight to the
                // failure list. A call that errors is the *primary* failing, not
                // the page being unreadable: when the primary cannot load at all
                // — olmOCR asking for more VRAM than the budget allows, the
                // router not up yet — every page failed here and the fallback
                // that would have read the whole document was never asked, so
                // the document came back as "None of the N pages could be
                // transcribed" with a model sitting there able to read it.
                thin.push((page_no, format!("{model_id} failed on it: {e}")));
            }
        }
    }

    /* ---- §3 escalation: one more pass, with a model that reads what this one could not ---- */
    if !thin.is_empty() {
        let escalate = {
            let reg = st.registry.read().expect("registry lock");
            reg.escalation(task_of(kind), model_id)
        };
        match escalate {
            None => failures.extend(thin.iter().map(|(page_no, why)| {
                format!("page {page_no}: {why}, and no other model is available to try it")
            })),
            Some(second) => {
                let prompt = ocr_prompt(if matches!(kind, DocumentKind::Image | DocumentKind::PdfScanned) {
                    // A page the printed-text reader could not resolve is being
                    // treated as handwriting from here, which is what the prompt
                    // has to say for the second model to do anything different.
                    DocumentKind::Handwriting
                } else {
                    kind
                });
                for (page_no, why) in &thin {
                    let png = pages.iter().find(|(n, _)| n == page_no).map(|(_, p)| p.clone());
                    let Some(png) = png else { continue };
                    let step = Step::start(
                        st,
                        StepKind::Ocr,
                        format!("Reading page {page_no} again"),
                    )
                    .model(Some(second.clone()))
                    .detail(format!("{model_id} could not read it: {why}."));
                    match crate::router::vision(st, &second, vec![png], &prompt).await {
                        Ok(text) if unreadable(&text).is_none() => {
                            let (b, t) = split_ocr(*page_no, &text, kind);
                            step.detail(format!(
                                "{second} read it: {} characters, {} block{}.",
                                text.len(),
                                b.len(),
                                if b.len() == 1 { "" } else { "s" }
                            ))
                            .ok(st);
                            blocks.extend(b);
                            tables.extend(t);
                        }
                        Ok(_) => {
                            step.detail(format!("{second} could not read it either.")).skip(st);
                            failures.push(format!(
                                "page {page_no}: {why}, and {second} could not read it either"
                            ));
                        }
                        Err(e) => {
                            step.fail(st, &e.to_string());
                            failures
                                .push(format!("page {page_no}: {why}; retry with {second} failed: {e}"));
                        }
                    }
                }
            }
        }
    }

    if blocks.is_empty() && tables.is_empty() {
        return Err(CoreError::OcrFailed(format!(
            "None of the {total} page{} could be transcribed. {}",
            if total == 1 { "" } else { "s" },
            if failures.is_empty() {
                "The model returned nothing.".to_string()
            } else {
                failures.join("; ")
            }
        )));
    }
    Ok((blocks, tables, failures))
}

/* ------------------------------------------------------------------ */
/* Ingestion                                                          */
/* ------------------------------------------------------------------ */

/// Reads a file into the store: text, tables, tags, and a record of how.
///
/// The order is the §3 order and it is not negotiable. Native extraction is
/// tried first for every format that can have a text layer, and when it
/// succeeds no model is loaded, no GPU is touched, and the document is recorded
/// `Native` so the operator can see that. A model is reached for only when
/// there is genuinely nothing to extract.
pub async fn ingest(st: &Arc<AppState>, path: &str) -> CoreResult<IngestedDocument> {
    let p = Path::new(path);
    // One spelling per file, before anything is looked up or stored. The same
    // scan arrives as `C:/plant/x.png` from a typed path, `C:\plant\x.png` from a
    // tool call and `\\?\C:\plant\x.png` from the native picker; without this the
    // Documents panel lists it three times and a search for the record it holds
    // returns three hits. See `fsops::canonical`.
    let path = &crate::fsops::canonical(p);
    let file_name = file_name_of(path);
    let what = format!("\"{file_name}\"");

    let meta = std::fs::metadata(p).map_err(|e| {
        CoreError::InvalidDocument(format!(
            "{what} could not be opened ({e}). If it is on a network share or a removable drive, \
             check that it is still connected."
        ))
    })?;
    if meta.is_dir() {
        return Err(CoreError::InvalidDocument(format!(
            "{what} is a folder. Index a folder from the Knowledge panel; attach a single file here."
        )));
    }

    let bytes = std::fs::read(p).map_err(|e| {
        CoreError::InvalidDocument(format!("{what} could not be read ({e})."))
    })?;
    if bytes.is_empty() {
        return Err(CoreError::InvalidDocument(format!("{what} is empty — there was nothing to read.")));
    }
    let sha256 = sha256_hex(&bytes);
    let pipeline = pipeline_id();

    // Idempotent by content, location and pipeline. A twelve-page scan costs
    // about a minute of GPU time and re-paying it because a file was re-attached
    // is what makes an operator stop attaching files — but the record is only
    // reusable while `pipeline_id` still matches, so re-attaching a file after
    // the extraction was fixed does the re-extraction the operator expects.
    if let Some(existing) = st.with_db(|c| crate::db::document_by_sha_path(c, &sha256, path, &pipeline))? {
        Step::start(st, StepKind::ReadingFile, format!("Already read {file_name}"))
            .model(existing.model_id.clone())
            .detail(format!(
                "Same bytes as when it was read at {}, so the stored extraction was reused and no model was loaded.",
                existing.ingested_at
            ))
            .ok(st);
        return Ok(existing);
    }

    let ext = ext_of(path);
    let mut model_id: Option<String> = None;
    let mut preview: Option<String> = None;
    let mut notes: Vec<String> = Vec::new();

    let (kind, extraction, page_count, blocks, tables) = match ext.as_str() {
        /* ---- PDF: native first, embedded page images second ---- */
        "pdf" => {
            let native = pdf_native_pages(&bytes, &what)?;
            match native {
                Some(pages) => {
                    let step = Step::start(st, StepKind::ReadingFile, format!("Reading {file_name}"));
                    let mut blocks = Vec::new();
                    for (i, text) in pages.iter().enumerate() {
                        let t = text.trim();
                        if t.is_empty() {
                            continue;
                        }
                        blocks.push(page_block(i as u32 + 1, BlockKind::Text, t, None));
                    }
                    let n = pages.len() as u32;
                    step.detail(format!(
                        "{n} page{} of embedded text. No model was loaded and no OCR was run — \
                         the PDF already contained its text.",
                        if n == 1 { "" } else { "s" }
                    ))
                    .ok(st);
                    (DocumentKind::PdfDigital, ExtractionMethod::Native, n, blocks, Vec::new())
                }
                None => {
                    let images = pdf_page_images(&bytes, &what)?;
                    if let Some((_, first)) = images.first() {
                        preview = preview_data_uri(first);
                    }
                    let total_pages = lopdf::Document::load_mem(&bytes)
                        .map(|d| d.get_pages().len() as u32)
                        .unwrap_or(images.len() as u32);
                    if images.len() < total_pages as usize {
                        notes.push(format!(
                            "{} of {total_pages} pages were transcribed; the rest were beyond the \
                             {MAX_OCR_PAGES}-page limit for one ingest or held no full-page image.",
                            images.len()
                        ));
                    }
                    let kind = DocumentKind::PdfScanned;
                    let mid = choose_vision_model(
                        st,
                        kind,
                        "the PDF has no usable text layer, so its pages were recovered as images",
                        images.len(),
                    )?;
                    let (b, t, fails) = ocr_pages(st, &mid, kind, images).await?;
                    notes.extend(fails);
                    model_id = Some(mid);
                    (kind, ExtractionMethod::Ocr, total_pages, b, t)
                }
            }
        }

        /* ---- Office: always native ---- */
        "docx" => {
            let step = Step::start(st, StepKind::ReadingFile, format!("Reading {file_name}"));
            // `keep` closes the step on the error path; a bare `?` here left a
            // "Reading <file>" row spinning for the rest of the session whenever
            // a .docx was corrupt or password-protected.
            let (step, (b, t)) = step.keep(st, guard(&what, || docx_extract(&bytes)))?;
            step.detail(format!("{} paragraphs and {} tables, natively — no model was loaded.", b.len(), t.len()))
                .ok(st);
            (DocumentKind::Docx, ExtractionMethod::Native, 1, b, t)
        }
        "pptx" => {
            let step = Step::start(st, StepKind::ReadingFile, format!("Reading {file_name}"));
            let (step, (b, t)) = step.keep(st, guard(&what, || pptx_extract(&bytes)))?;
            let pages = b.iter().map(|x| x.bbox.page).max().unwrap_or(1);
            step.detail(format!("{pages} slides, natively — no model was loaded.")).ok(st);
            (DocumentKind::Pptx, ExtractionMethod::Native, pages, b, t)
        }
        "xlsx" | "xls" | "xlsm" | "ods" => {
            let step = Step::start(st, StepKind::ReadingFile, format!("Reading {file_name}"));
            let (step, (b, t)) = step.keep(st, guard(&what, || xlsx_extract(p, None)))?;
            let pages = t.iter().map(|x| x.page).max().unwrap_or(1);
            step.detail(format!(
                "{} sheet{}, cells and formulas, natively — no model was loaded.",
                t.len(),
                if t.len() == 1 { "" } else { "s" }
            ))
            .ok(st);
            (DocumentKind::Xlsx, ExtractionMethod::Native, pages, b, t)
        }
        "csv" | "tsv" => {
            let text = String::from_utf8_lossy(&bytes).to_string();
            let (b, t) = csv_extract(&text);
            Step::start(st, StepKind::ReadingFile, format!("Reading {file_name}"))
                .detail(format!(
                    "{} rows, natively — no model was loaded.",
                    t.first().map(|x| x.rows.len()).unwrap_or(0)
                ))
                .ok(st);
            (DocumentKind::Xlsx, ExtractionMethod::Native, 1, b, t)
        }

        /* ---- Images: the vision path ---- */
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "gif" | "tif" | "tiff" => {
            let decoded = image::load_from_memory(&bytes).map_err(|e| {
                CoreError::InvalidDocument(format!(
                    "{what} is not an image this build can decode ({e}). PNG, JPEG, BMP, GIF, WebP \
                     and TIFF are read; HEIC from a phone camera is not — export it as JPEG first."
                ))
            })?;
            let (kind, why) = classify_image(&decoded, &file_name);
            let png = encode_png(decoded, &what)?;
            preview = preview_data_uri(&png);

            let mid = choose_vision_model(st, kind, &why, 1)?;
            let (b, t, fails) = ocr_pages(st, &mid, kind, vec![(1, png)]).await?;
            notes.extend(fails);
            model_id = Some(mid);
            (kind, ExtractionMethod::Vision, 1, b, t)
        }

        /* ---- Everything else that is text ---- */
        _ => {
            let text = match String::from_utf8(bytes.clone()) {
                Ok(t) => t,
                Err(_) => {
                    return Err(CoreError::InvalidDocument(format!(
                        "{what} is not text and is not a format this build reads. PDF, DOCX, XLSX, \
                         PPTX, CSV, images and plain text or source files are supported."
                    )))
                }
            };
            let kind = match Registry::classify_path(path) {
                TaskKind::Code => DocumentKind::SourceCode,
                _ if ext == "md" || ext == "markdown" => DocumentKind::Markdown,
                _ => DocumentKind::Text,
            };
            let blocks = vec![page_block(1, BlockKind::Text, text.trim(), None)];
            Step::start(st, StepKind::ReadingFile, format!("Reading {file_name}"))
                .detail(format!("{} characters of plain text — no model was loaded.", text.len()))
                .ok(st);
            (kind, ExtractionMethod::Native, 1, blocks, Vec::new())
        }
    };

    // Tags come from everything that was extracted, tables included: a tag
    // number in a table cell is exactly as much a reference as one in a
    // sentence, and inspection tables are where most of them live.
    let mut corpus = String::new();
    for b in &blocks {
        corpus.push_str(&b.text);
        corpus.push('\n');
    }
    for t in &tables {
        corpus.push_str(&t.header.join(" "));
        corpus.push('\n');
        for r in &t.rows {
            corpus.push_str(&r.join(" "));
            corpus.push('\n');
        }
    }
    let entities = extract_tags(&corpus);

    // A drawing's registers are its payload, not decoration around prose: the
    // register rows and line list become Tag blocks so each equipment item and
    // each connection is independently retrievable. Other kinds keep their
    // tables as tables — a spreadsheet whose rows became blocks would be worse
    // to read, and only the drawing prompt asks for these headings anyway.
    let mut blocks = blocks;
    if kind == DocumentKind::Drawing {
        blocks.extend(drawing_tag_blocks(&tables));
    }
    if !notes.is_empty() {
        // Recorded as a block rather than logged, so it travels with the
        // document. A partial transcription that does not say it is partial is
        // the one failure here that could put a wrong number in a report.
        blocks.push(page_block(
            1,
            BlockKind::Text,
            format!("[Extraction notes] {}", notes.join("; ")),
            None,
        ));
    }

    let doc = IngestedDocument {
        id: new_id("doc"),
        path: path.to_string(),
        file_name,
        kind,
        page_count: page_count.max(1),
        extraction,
        model_id,
        blocks,
        tables,
        entities,
        size_bytes: meta.len(),
        sha256,
        ingested_at: now_ms(),
        preview_uri: preview,
    };

    st.with_db(|c| crate::db::insert_document(c, &doc, &pipeline))?;
    Ok(doc)
}

pub fn get(st: &AppState, id: &str) -> CoreResult<IngestedDocument> {
    st.with_db(|c| crate::db::document(c, id))
}

/// One inspectable passage per extracted page, using recorded coordinates.
/// Prefer measurement passages to repeated letterheads; this is navigation,
/// not a claim that all conclusions on a page have been verified.
pub fn source_page_citations(doc: &IngestedDocument) -> Vec<Citation> {
    (1..=doc.page_count.min(40)).filter_map(|page| {
        let block = doc.blocks.iter().filter(|b| b.bbox.page == page && !b.text.trim().is_empty()).max_by_key(|b| {
            let text = b.text.to_lowercase();
            let measurement = text.chars().any(|c| c.is_ascii_digit()) && [" mm", " bar", "reading", "thickness", "pressure", "temperature"].iter().any(|word| text.contains(word));
            (measurement, b.text.len())
        })?;
        Some(Citation {doc_id:doc.id.clone(),path:doc.path.clone(),file_name:doc.file_name.clone(),page:Some(page),bbox:Some(block.bbox.clone()),snippet:block.text.chars().take(500).collect(),score:1.0})
    }).collect()
}

/// A page must match the recorded extraction. Never draw page-one pixels below
/// page-two coordinates, or silently replace evidence when a source is edited.
pub fn page_image(st: &AppState, id: &str, page: u32) -> CoreResult<Option<String>> {
    let doc = get(st,id)?;
    if page == 0 || page > doc.page_count { return Err(CoreError::InvalidDocument("Page is outside the recorded document.".into())); }
    if std::fs::metadata(&doc.path)?.len() > 128 * 1024 * 1024 { return Err(CoreError::InvalidDocument("Source preview exceeds the 128 MiB safety limit.".into())); }
    let bytes = std::fs::read(&doc.path)?;
    if sha256_hex(&bytes) != doc.sha256 { return Err(CoreError::InvalidDocument("The source changed since extraction. Reattach it to create a new revision before trusting page highlights.".into())); }
    if ext_of(&doc.path) != "pdf" { return Ok(if page == 1 {doc.preview_uri} else {None}); }
    let pdf = lopdf::Document::load_mem(&bytes).map_err(|e| CoreError::InvalidDocument(e.to_string()))?;
    let pages = pdf.get_pages();
    let Some(id) = pages.get(&page) else { return Ok(None) };
    let Ok(images) = pdf.get_page_images(*id) else { return Ok(None) };
    let image = images.into_iter().filter(|i| i.width * i.height >= MIN_PAGE_IMAGE_PIXELS).max_by_key(|i| i.width * i.height);
    let Some(image) = image else {return Ok(None)};
    let png = decode_pdf_image(&image).map_err(CoreError::InvalidDocument)?;
    Ok(preview_data_uri(&png))
}

#[cfg(test)]
mod scan_regression_tests {
    use super::*;
    #[test]
    fn source_citations_preserve_pages_and_select_measurements_over_headers() {
        let doc = IngestedDocument { id:"d".into(),path:"scan.pdf".into(),file_name:"scan.pdf".into(),kind:DocumentKind::Text,page_count:2,extraction:ExtractionMethod::Native,model_id:None,blocks:vec![page_block(1,BlockKind::Text,"Synthetic cover page for the inspection",None),page_block(2,BlockKind::Heading,"A deliberately very long repeated header with no measurement",None),page_block(2,BlockKind::Text,"DEMO-L-201 measured thickness is 6.2 mm",None)],tables:vec![],entities:vec![],size_bytes:0,sha256:String::new(),ingested_at:0,preview_uri:None };
        let cites = source_page_citations(&doc);
        assert_eq!(cites.len(),2); assert_eq!(cites[1].page,Some(2));
        assert!(cites[1].snippet.contains("6.2 mm"));
        assert_eq!(cites[1].bbox.as_ref().unwrap().page,2);
    }
    #[test]
    fn flate_scans_decode_into_distinct_pages_without_a_text_layer() {
        let bytes = include_bytes!("../../examples/mrpl-demo/inspection-revision-a-scan.pdf");
        let pages = pdf_page_images(bytes,"synthetic scan").unwrap();
        assert_eq!(pages.len(),2);
        assert_eq!(pages[0].0,1); assert_eq!(pages[1].0,2);
        let first = image::load_from_memory(&pages[0].1).unwrap();
        let second = image::load_from_memory(&pages[1].1).unwrap();
        assert_eq!(first.width(),1240); assert_eq!(first.height(),1754);
        assert_ne!(first.to_rgb8(),second.to_rgb8());
    }
    #[test]
    fn revised_scan_really_changes_the_second_page() {
        let old = pdf_page_images(include_bytes!("../../examples/mrpl-demo/inspection-revision-a-scan.pdf"),"old").unwrap();
        let new = pdf_page_images(include_bytes!("../../examples/mrpl-demo/inspection-revision-b-scan.pdf"),"new").unwrap();
        assert_ne!(old[1].1,new[1].1);
    }
}

pub fn list(st: &AppState) -> CoreResult<Vec<IngestedDocument>> {
    st.with_db(crate::db::documents)
}

/// Removes a document's extraction from the store.
///
/// The file on disk is not touched — this forgets what was read out of it, which
/// is the only thing the panel is listing. Re-attaching the file reads it again.
pub fn remove(st: &AppState, id: &str) -> CoreResult<()> {
    let existed = st.with_db(|c| crate::db::delete_document(c, id))?;
    if !existed {
        return Err(CoreError::InvalidDocument(format!(
            "No document '{id}' is in the store, so there was nothing to remove."
        )));
    }
    Ok(())
}

/// Opens the native picker and returns the chosen paths.
///
/// Multi-select, because an inspection round produces a folder of photographs
/// and attaching them one dialog at a time is the kind of friction that decides
/// whether a tool gets used.
pub async fn pick(st: Arc<AppState>) -> CoreResult<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;

    let app = st.app.clone();
    let chosen = crate::fsops::await_picker("The file picker", move |tx| {
        app.dialog()
            .file()
            .set_title("Choose documents, drawings or photographs")
            .add_filter(
                "Documents, drawings and images",
                &[
                    "pdf", "docx", "xlsx", "xlsm", "xls", "pptx", "csv", "tsv", "txt", "md",
                    "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff",
                ],
            )
            .add_filter("Every file", &["*"])
            .pick_files(move |files| {
                let _ = tx.send(files);
            });
    })
    .await?;

    // Cancelling is an answer, not a failure.
    let Some(files) = chosen else { return Ok(Vec::new()) };

    let mut out = Vec::new();
    for f in files {
        let path = crate::fsops::to_path(f, "The file picker")?;
        out.push(path.to_string_lossy().to_string());
    }
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* Tool entry points                                                  */
/* ------------------------------------------------------------------ */

/// A spreadsheet as text the model can reason over, cell addresses included.
///
/// Addresses are what make a follow-up answerable. "The design pressure in B14"
/// can be checked; "the design pressure somewhere in this sheet" cannot, and a
/// model handed a bare grid will invent a location when asked where a number
/// came from.
pub async fn read_spreadsheet_text(
    st: &AppState,
    path: &Path,
    sheet: Option<&str>,
) -> CoreResult<String> {
    let name = file_name_of(&path.to_string_lossy());
    let what = format!("\"{name}\"");

    let step = Step::start(st, StepKind::ReadingFile, format!("Reading {name}"))
        .tool(ToolName::ReadSpreadsheet);

    // A spreadsheet is not always a workbook. `calamine` reads xls, xlsx and ods
    // and answers "Cannot detect file format" for a CSV — and CSV is the
    // commonest tabular file on a plant: thickness logs, vibration trends and lab
    // results all arrive as exports. Ingest has always handled them; this entry
    // point called the workbook reader unconditionally, so a model reaching for
    // the obviously-right tool got a failed step in the operator's timeline and
    // had to fall back to reading the file as prose, which loses the cell
    // addresses that are the reason this tool exists.
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();

    let extracted = guard(&what, || match ext.as_str() {
        "csv" | "tsv" => {
            let bytes = std::fs::read(path).map_err(|e| {
                CoreError::InvalidDocument(format!("{what} could not be read ({e})."))
            })?;
            Ok(csv_extract(&String::from_utf8_lossy(&bytes)))
        }
        _ => xlsx_extract(path, sheet),
    });
    let (blocks, tables) = match extracted {
        Ok(v) => v,
        Err(e) => {
            step.fail(st, &e.to_string());
            return Err(e);
        }
    };

    let mut out = String::new();
    for b in &blocks {
        out.push_str(&b.text);
        out.push_str("\n\n");
    }
    for t in &tables {
        out.push_str(&format!("Sheet page {} — {} rows\n", t.page, t.rows.len()));
        // Header row with its column letters, then each row with its number, so
        // every value in the reply has an address.
        let letters: Vec<String> = (0..t.header.len().max(t.rows.iter().map(|r| r.len()).max().unwrap_or(0)))
            .map(column_letter)
            .collect();
        out.push_str(&format!("      | {}\n", letters.join(" | ")));
        out.push_str(&format!("row 1 | {}\n", t.header.join(" | ")));
        for (i, r) in t.rows.iter().enumerate() {
            out.push_str(&format!("row {} | {}\n", i + 2, r.join(" | ")));
        }
        out.push('\n');
    }

    let tags = extract_tags(&out);
    if !tags.is_empty() {
        out.push_str(&format!("Equipment tags found: {}\n", tags.join(", ")));
    }

    // A CSV has rows, not sheets, and a panel that says "1 sheet" for a file the
    // operator knows is a flat export reads as though something was guessed.
    let unit = if matches!(ext.as_str(), "csv" | "tsv") {
        format!("{} rows", tables.first().map(|t| t.rows.len() + 1).unwrap_or(0))
    } else {
        format!("{} sheet{}", tables.len(), if tables.len() == 1 { "" } else { "s" })
    };
    step.detail(format!("{unit}, {} characters — natively, no model was loaded.", out.len()))
        .ok(st);
    Ok(out)
}

/// Answers a question about one image, and says which model answered.
///
/// Separate from `ingest` because the questions are different: ingest transcribes
/// everything so it can be indexed and cited, while this answers one question
/// and is not stored. Routing still goes through the same classifier, so a
/// question about a P&ID reaches the model that can read a P&ID.
pub async fn analyze_image(
    st: &AppState,
    path: &Path,
    question: &str,
) -> CoreResult<(String, String)> {
    let name = file_name_of(&path.to_string_lossy());
    let what = format!("\"{name}\"");

    let bytes = std::fs::read(path)
        .map_err(|e| CoreError::InvalidDocument(format!("{what} could not be read ({e}).")))?;
    let decoded = image::load_from_memory(&bytes).map_err(|e| {
        CoreError::InvalidDocument(format!(
            "{what} is not an image this build can decode ({e}). If it is a PDF, attach it as a \
             document instead — the PDF path handles both text layers and scans."
        ))
    })?;

    let (kind, why) = classify_image(&decoded, &name);
    let png = encode_png(decoded, &what)?;
    let model_id = choose_vision_model(st, kind, &why, 1)?;

    let step = Step::start(st, StepKind::Vision, format!("Looking at {name}"))
        .tool(ToolName::AnalyzeImage)
        .model(Some(model_id.clone()));

    // The question is asked against the same grounding rules as a transcription.
    // Without them a vision model asked "is there corrosion" answers about
    // corrosion in general rather than about this photograph.
    let prompt = format!(
        "{}\n\nAnswer only from what is visible in this image. Quote any text you rely on exactly \
         as it appears. If the image does not show enough to answer, say precisely what is missing \
         rather than inferring it.\n\nQuestion: {question}",
        match kind {
            DocumentKind::Drawing => "This is an engineering drawing or P&ID.",
            DocumentKind::Handwriting => "This is handwritten.",
            DocumentKind::Photograph => "This is a photograph taken in a plant.",
            _ => "This is a scanned or printed page.",
        }
    );

    match crate::router::vision(st, &model_id, vec![png], &prompt).await {
        Ok(answer) => {
            step.detail(format!("{} characters, from {model_id}.", answer.len())).ok(st);
            Ok((answer, model_id))
        }
        Err(e) => {
            step.fail(st, &e.to_string());
            Err(e)
        }
    }
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod inspection_records {
    use super::{extract_tags, ocr_cells, ocr_prompt, split_ocr, TABLE_EXAMPLE};
    use crate::types::{BlockKind, DocumentKind};

    /// The transcription paddleocr-vl produced from a real-shaped MRPL thickness
    /// record, verbatim. It is here because the record came back with no entities
    /// at all: the extractor wanted a tag to start a word, so the line number —
    /// the one thing the whole report is about — was invisible to it because a
    /// unit number sits in front of the service letter.
    const RECORD: &str = "MANGALORE REFINERY AND PETROCHEMICALS LTD
        Ultrasonic Thickness Inspection Record
        Unit 4 CDU / Form MEC-UT-11 Rev 3
        Equipment: Overhead line 4-P-1102-6in-CS
        Instrument: Krautkramer DM5E, 5 MHz probe
        Nominal wall: 12.7 mm (Sch 40)
        Test point Measured (mm) Loss (mm) Verdict
        TP-01 11.9 0.8 Acceptable
        TP-04 7.1 2.4 Below limit";

    #[test]
    fn the_line_number_and_every_test_point_are_extracted() {
        let tags = extract_tags(RECORD);
        for want in ["4-P-1102", "TP-01", "TP-04"] {
            assert!(tags.contains(&want.to_string()), "{want} missing from {tags:?}");
        }
    }

    /// Everything else on that page is prose, a material grade or an instrument
    /// model, and a tag list padded with those is worse than an empty one — an
    /// operator searching for equipment would have to read past them.
    #[test]
    fn the_rest_of_the_page_is_not_a_tag() {
        let tags = extract_tags(RECORD);
        for junk in ["CS", "K", "R-3", "DM-5", "MEC-UT", "UT-11"] {
            assert!(!tags.contains(&junk.to_string()), "{junk} extracted from {tags:?}");
        }
    }

    /// The guards that were there before the unit prefix was allowed: a tag may
    /// not begin inside a word, and two digits is the minimum after the letters.
    #[test]
    fn a_tag_still_may_not_begin_mid_word() {
        assert!(extract_tags("TRIP setting reached").is_empty());
        assert!(extract_tags("flange rated ANSI-150").is_empty());
        assert!(extract_tags("replaced pre-2019 spool").is_empty());
        // A hyphen only licenses what precedes it when that is a unit number.
        assert!(extract_tags("the spare-PP-01 skid").is_empty());
        // And a unit is one or two digits; a longer run is a serial number, and
        // a serial number followed by a letter is not a tag at all.
        assert!(extract_tags("part 1234-P-1102 shipped").is_empty());
    }

    #[test]
    fn a_unit_prefixed_tag_keeps_its_unit() {
        assert_eq!(extract_tags("line 12-TI-4501 reads high"), vec!["12-TI-4501"]);
        assert_eq!(extract_tags("(4-P-1102)"), vec!["4-P-1102"]);
        // Unprefixed tags are unchanged by that allowance.
        assert_eq!(extract_tags("PSV-2301 lifted"), vec!["PSV-2301"]);
        assert_eq!(extract_tags("pump P-4102A tripped"), vec!["P-4102A"]);
    }

    /// A list of tags is a list, not a table.
    ///
    /// This is how a vision model answers "every equipment and instrument tag":
    /// one bullet each. Every one of those lines splits into the same three cells
    /// with a number in the same place, which is exactly the shape
    /// `pipe_aligned_tables` looks for — so the drawing's tag list came back as a
    /// table of `Column 1 | Column 2 | Column 3` with `PSV-1101` split across two
    /// cells, and the tags stopped being extractable as tags.
    #[test]
    fn a_bulleted_tag_list_stays_a_list() {
        let text = "**Equipment and Instrument Tags:**
            - PSV 1101
            - PT 1102
            - TI 1104
            - LG 1104
            - PIC 1102";
        let (blocks, tables) = split_ocr(1, text, DocumentKind::Drawing);
        assert!(tables.is_empty(), "the list came back as a table: {tables:?}");
        assert_eq!(blocks.len(), 1, "the list was split off its heading: {blocks:?}");
        assert!(blocks[0].text.contains("PSV 1101"), "the tag lost its number");
    }

    /// The example in the prompt is not a row of anybody's document.
    ///
    /// A P&ID with no table on it came back with the prompt's own example in it,
    /// so its record carried a thickness reading of 11.9 mm and a verdict of
    /// "Acceptable" for a test point the drawing only ever named in a note. That
    /// is the one kind of OCR error nobody can catch by eye, because the invented
    /// row looks exactly like a read one.
    #[test]
    fn the_prompt_example_never_reaches_the_record() {
        let echoed = format!("Notes: UT survey at TP-01 to TP-04.

{TABLE_EXAMPLE}");
        let (blocks, tables) = split_ocr(1, &echoed, DocumentKind::Drawing);
        assert!(tables.is_empty(), "the example came back as a table: {tables:?}");
        assert_eq!(blocks.len(), 1, "the prose is still prose: {blocks:?}");
    }

    /// The guard has to take the copied row out without taking the page with it.
    #[test]
    fn a_real_table_survives_a_copied_row() {
        let text = "| Test point | Measured (mm) | Verdict |
            |---|---|---|
            | TP-01 | 11.9 | Acceptable |
            | cell | cell | cell |
            | TP-04 | 7.1 | Below limit |";
        let (_, tables) = split_ocr(1, text, DocumentKind::Image);
        assert_eq!(tables.len(), 1, "got {tables:?}");
        assert_eq!(tables[0].rows.len(), 2, "the copied row goes, the read ones stay");
        assert_eq!(tables[0].rows[1], vec!["TP-04", "7.1", "Below limit"]);
    }

    /// Whatever the example says, no page can be holding those words already.
    #[test]
    fn the_example_cannot_be_mistaken_for_a_reading() {
        let cells = TABLE_EXAMPLE
            .split('|')
            .map(str::trim)
            .filter(|c| !c.is_empty() && !c.contains("---"));
        for cell in cells {
            assert!(
                !cell.chars().any(|c| c.is_ascii_digit()),
                "the example cell {cell:?} could pass for something read off a page"
            );
        }
        let prompt = ocr_prompt(DocumentKind::Drawing);
        assert!(prompt.contains(TABLE_EXAMPLE), "the prompt stopped showing the example");
        assert!(prompt.contains("write no table"), "nothing tells the model to omit it");
    }

    /// The prompt now shows the model the three lines of a pipe table, so this is
    /// the shape that has to survive the trip back into structure: the header
    /// separated from the rows, the separator dropped, and the prose on either
    /// side kept as prose rather than swallowed into the table.
    #[test]
    fn a_pipe_table_comes_back_as_a_table() {
        let text = "Measured thickness by test point
            
            | Test point | Measured (mm) | Verdict |
            |---|---|---|
            | TP-01 | 11.9 | Acceptable |
            | TP-04 | 7.1 | Below limit |
            
            Remarks: TP-04 is below the retirement limit.";
        let (blocks, tables) = split_ocr(1, text, DocumentKind::Image);
        assert_eq!(tables.len(), 1, "one table expected, got {tables:?}");
        let t = &tables[0];
        assert_eq!(t.header, vec!["Test point", "Measured (mm)", "Verdict"]);
        assert_eq!(t.rows.len(), 2, "the separator row is structure, not data");
        assert_eq!(t.rows[1], vec!["TP-04", "7.1", "Below limit"]);
        assert_eq!(blocks.len(), 2, "the prose either side stays prose: {blocks:?}");
        assert!(blocks[0].text.starts_with("Measured thickness"));
        assert!(blocks[1].text.starts_with("Remarks"));
        assert!(blocks.iter().all(|b| b.kind == BlockKind::Text));
    }

    /// A handwritten page is transcribed, not typeset, and the viewer marks it as
    /// handwriting so the operator knows a human wrote the number they are
    /// reading. That distinction is carried on the block, so it has to survive
    /// the same splitter.
    #[test]
    fn handwriting_blocks_are_labelled_as_handwriting() {
        let (blocks, _) = split_ocr(2, "gauge read 9.4 bar at 0730", DocumentKind::Handwriting);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].kind, BlockKind::Handwriting);
        assert_eq!(blocks[0].bbox.page, 2);
    }

    /// What paddleocr-vl actually returned for that page, byte for byte, blocks
    /// rejoined. Unindented because indenting it would not be what the model
    /// produced. There is not a pipe anywhere in it: the prompt shows the model
    /// the syntax and this one still transcribes the page as it reads.
    const TRANSCRIPT: &str = "MANGALORE REFINERY AND PETROCHEMICALS LTD
Ultrasonic Thickness Inspection Record
Unit 4 CDU / Form MEC-UT-11 Rev 3

Equipment: Overhead line 4-P-1102-6in-CS
Inspection date: 14 March 2026
Inspector: Technician, Level II UT
Instrument: Krautkramer DM5E, 5 MHz probe
Nominal wall: 12.7 mm (Sch 40)
Retirement limit: 9.8 mm

Measured thickness by test point
Test point Measured (mm) Loss (mm) Verdict
TP-01 11.9 0.8 Acceptable
TP-02 10.4 2.3 Monitor
TP-03 12.2 0.5 Acceptable
TP-04 7.1 2.4 Below limit

Remarks
TP-04 measures 7.1 mm against a retirement limit of 9.8 mm and is below the acceptance criterion. Recommend replacement of the elbow spool during the next available shutdown. TP-02 shows 2.3 mm loss and is to be added to the six-monthly monitoring list. No through-wall indications were found.

Signed: _____ Date: 14/03/2026

Date: 14/03/2026";

    #[test]
    fn the_test_point_block_becomes_a_table() {
        let (_, tables) = split_ocr(1, TRANSCRIPT, DocumentKind::Image);
        assert_eq!(tables.len(), 1, "expected the readings table, got {tables:?}");
        let t = &tables[0];
        assert_eq!(t.header, ["Test point", "Measured (mm)", "Loss (mm)", "Verdict"]);
        assert_eq!(t.rows.len(), 4, "one row per test point: {:?}", t.rows);
        assert_eq!(t.rows[0], ["TP-01", "11.9", "0.8", "Acceptable"]);
        // The row that matters, and the one a width-only rule would have lost:
        // its verdict is two words.
        assert_eq!(t.rows[3], ["TP-04", "7.1", "2.4", "Below limit"]);
    }

    /// The same page has six labelled fields, a caption, a remarks paragraph and
    /// a signature line. Every one of them has numbers in it somewhere, and not
    /// one of them is a table row — inventing a table out of them would
    /// misrepresent the record to the viewer, to retrieval and to the model.
    #[test]
    fn the_fields_and_the_remarks_stay_prose() {
        let (blocks, _) = split_ocr(1, TRANSCRIPT, DocumentKind::Image);
        let prose: String = blocks.iter().map(|b| b.text.as_str()).collect::<Vec<_>>().join("|");
        for kept in [
            "Nominal wall: 12.7 mm (Sch 40)",
            "Retirement limit: 9.8 mm",
            "Measured thickness by test point",
            "Signed: _____ Date: 14/03/2026",
        ] {
            assert!(prose.contains(kept), "{kept} was lost from the blocks");
        }
        // And the rows are gone from the prose, because they are in the table.
        assert!(!prose.contains("TP-01 11.9"), "the rows are still prose too");
    }

    #[test]
    fn a_reading_does_not_swallow_the_word_after_it() {
        assert_eq!(ocr_cells("TP-02 10.4 2.3 monitor closely"), ["TP-02", "10.4", "2.3", "monitor closely"]);
        assert_eq!(ocr_cells("Nominal wall (mm) Loss (mm)"), ["Nominal wall (mm)", "Loss (mm)"]);
    }

    /// Two lines that agree are a coincidence; three are a column structure. A
    /// wrongly invented table is worse than a missed one, so the rule is strict.
    #[test]
    fn two_agreeing_lines_are_not_a_table() {
        let two = "P-01 4.5 running\nP-02 3.2 running";
        assert_eq!(split_ocr(1, two, DocumentKind::Image).1.len(), 0);
        let three = "P-01 4.5 running\nP-02 3.2 running\nP-03 5.1 stopped";
        let (_, tables) = split_ocr(1, three, DocumentKind::Image);
        assert_eq!(tables.len(), 1);
        // Nothing above them to name the columns, so they are named by position
        // rather than by borrowing the first reading as a heading.
        assert_eq!(tables[0].header, ["Column 1", "Column 2", "Column 3"]);
        assert_eq!(tables[0].rows.len(), 3);
    }

    /// A model that does use pipes must not have its table rebuilt underneath it.
    #[test]
    fn a_piped_table_is_left_alone() {
        let piped = "| Tag | Reading |\n|---|---|\n| PI-01 | 4.2 |\n| PI-02 | 4.9 |\n| PI-03 | 5.1 |";
        assert_eq!(super::pipe_aligned_tables(piped), piped);
    }

    /// A line break inside a cell is layout, and it arrives as a tag.
    #[test]
    fn a_cell_does_not_keep_the_markup_that_wrote_it() {
        let (_, tables) = super::split_ocr(
            1,
            "| Description | Details |\n|---|---|\n| Nameplate | P-4102A DISCH<br>WIKA 233.50 |",
            DocumentKind::Photograph,
        );
        assert_eq!(tables.len(), 1, "one table was written, so one should come back");
        assert_eq!(
            tables[0].rows[0][1],
            "P-4102A DISCH WIKA 233.50",
            "a cell is rendered as text, so a break tag left in it is read as four characters of the reading"
        );
    }

    /// Only a break, though. A cell that is describing markup keeps it.
    #[test]
    fn a_cell_keeps_a_tag_that_is_not_a_line_break() {
        let (_, tables) = super::split_ocr(
            1,
            "| Field | Value |\n|---|---|\n| Note | see <ref-14> |",
            DocumentKind::PdfScanned,
        );
        assert_eq!(tables[0].rows[0][1], "see <ref-14>");
    }
}

#[cfg(test)]
mod stored_records {
    use super::pipeline_id;

    /// A stored extraction is only worth reusing while the pipeline that produced
    /// it is the pipeline running now.
    ///
    /// The hash on the row is the only thing standing between a fixed pipeline and
    /// an operator being handed the old record back — which is what happened to the
    /// drawing that came back carrying an invented thickness reading: the fix
    /// landed, the file was re-attached, and the bytes still matched.
    #[test]
    fn a_stored_record_is_only_reused_for_the_same_pipeline() {
        let id = pipeline_id();
        assert_eq!(id.len(), 16, "expected eight bytes of hex, got {id:?}");
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()), "not hex: {id:?}");
        assert_eq!(id, pipeline_id(), "one pipeline has to hash the same twice");

        let src = include_str!("db.rs");
        let (_, rest) = src
            .split_once("pub fn document_by_sha_path(")
            .expect("the lookup exists");
        let (f, _) = rest.split_once("\n}").expect("the lookup ends");
        assert!(
            f.contains("pipeline = ?3"),
            "the lookup stopped checking which pipeline wrote the row:\n{f}"
        );
    }
}

#[cfg(test)]
mod drawing_registers {
    use super::{classify_image, drawing_tag_blocks, split_ocr};
    use crate::types::{BlockKind, DocumentKind, DocTable};

    fn table(page: u32, header: &[&str], rows: &[&[&str]]) -> DocTable {
        DocTable {
            id: "tbl_test".into(),
            page,
            bbox: crate::types::BoundingBox { page, x: 0.0, y: 0.0, w: 1.0, h: 1.0 },
            header: header.iter().map(|s| s.to_string()).collect(),
            rows: rows.iter().map(|r| r.iter().map(|c| c.to_string()).collect()).collect(),
        }
    }

    /// The register is what the drawing prompt asks for first, and its rows are
    /// the one-place answer to "what is on this drawing" — tag, type and
    /// description travel together on one Tag block each.
    #[test]
    fn the_equipment_register_becomes_tag_blocks() {
        let tables = vec![table(
            1,
            &["Tag", "Type", "Description"],
            &[
                &["P-101", "Centrifugal pump", "Crude charge pump, motor driven"],
                &["V-301", "Vertical vessel", "Crude surge drum"],
                &["[unclear]", "Exchanger", "Tag not legible on the sheet"],
            ],
        )];
        let blocks = drawing_tag_blocks(&tables);
        assert_eq!(blocks.len(), 2, "the placeholder row is a fact about the sheet, not equipment: {blocks:?}");
        assert_eq!(blocks[0].kind, BlockKind::Tag);
        assert_eq!(blocks[0].text, "P-101 — Centrifugal pump: Crude charge pump, motor driven");
        assert_eq!(blocks[1].text, "V-301 — Vertical vessel: Crude surge drum");
    }

    /// The line list is the plant's connectivity. Each line keeps both ends and
    /// its size and service on one block, because "which pumps feed V-301" is
    /// answered by a line, not by a paragraph that mentions the vessel.
    #[test]
    fn the_line_list_keeps_both_ends_of_every_line() {
        let tables = vec![table(
            2,
            &["Line number", "From", "To", "Size", "Service"],
            &[
                &["4-P-1102-6in-CS", "V-301", "P-101", "6 in", "Crude oil"],
                &["4-P-1103-4in-CS", "P-101", "E-204", "4 in", "Crude oil"],
                &["", "[unclear]", "P-102", "", ""],
            ],
        )];
        let blocks = drawing_tag_blocks(&tables);
        assert_eq!(blocks.len(), 2, "a row with no line number names no line, whatever its ends: {blocks:?}");
        assert!(blocks.iter().all(|b| b.kind == BlockKind::Tag));
        assert_eq!(blocks[0].text, "Line 4-P-1102-6in-CS: V-301 to P-101, 6 in, Crude oil");
        assert_eq!(blocks[1].text, "Line 4-P-1103-4in-CS: P-101 to E-204, 4 in, Crude oil");
        assert_eq!(blocks[0].bbox.page, 2, "the block stays on the page its table was on");
    }

    /// A table the drawing itself carried — a title block, a revision list — is
    /// not a register and must not be shredded into per-row tags.
    #[test]
    fn a_title_block_table_is_left_alone() {
        let tables = vec![table(
            1,
            &["Drawing no", "Title", "Rev"],
            &[&["PID-4-2103", "CDU charge", "B"]],
        )];
        assert!(drawing_tag_blocks(&tables).is_empty());
    }

    /// The whole drawing path end to end on the parse side: the model's reply,
    /// with its title block as prose and both register tables as pipes, comes
    /// back as prose blocks, two DocTables and one Tag block per row.
    #[test]
    fn a_drawing_reply_parses_into_registers_and_tags() {
        let reply = "PID-4-2103, CDU charge, Rev B, 14 March 2026.

| Tag | Type | Description |
|---|---|---|
| P-101 | Centrifugal pump | Crude charge pump |
| V-301 | Vertical vessel | Crude surge drum |

| Line number | From | To | Size | Service |
|---|---|---|---|---|
| 4-P-1102-6in-CS | V-301 | P-101 | 6 in | Crude oil |";
        let (blocks, tables) = split_ocr(1, reply, DocumentKind::Drawing);
        assert_eq!(tables.len(), 2, "both registers come back as tables: {tables:?}");
        assert_eq!(blocks.len(), 1, "the title block line is prose: {blocks:?}");
        let tags = drawing_tag_blocks(&tables);
        assert_eq!(tags.len(), 3, "two equipment and one line: {tags:?}");
        assert!(tags.iter().all(|b| b.kind == BlockKind::Tag));
        assert!(tags.iter().any(|b| b.text.contains("V-301 to P-101")), "the connectivity survives: {tags:?}");
    }

    /* ---- the pixel classifier ---- */

    fn white_canvas(w: u32, h: u32) -> image::RgbImage {
        image::ImageBuffer::from_pixel(w, h, image::Rgb([255u8, 255, 255]))
    }

    /// Line art with no filename hint: long straight segments across a white
    /// sheet, the shape every P&ID has and no page of text does.
    #[test]
    fn an_unnamed_line_drawing_is_classified_as_a_drawing() {
        let mut img = white_canvas(600, 800);
        for y in (40..760).step_by(40) {
            for x in 50..550 {
                img.put_pixel(x, y, image::Rgb([20, 20, 20]));
            }
        }
        for x in (100..500).step_by(50) {
            for y in 30..770 {
                img.put_pixel(x, y, image::Rgb([20, 20, 20]));
            }
        }
        let (kind, why) = classify_image(&image::DynamicImage::ImageRgb8(img), "scan0042.jpg");
        assert_eq!(kind, DocumentKind::Drawing, "why: {why}");
        assert!(why.contains("long straight"), "the reason has to name the evidence: {why}");
    }

    /// A page of text under the same test: short strokes in clustered lines,
    /// which crosses the sampled grid as many short runs and no long ones.
    #[test]
    fn an_unnamed_page_of_text_stays_a_scan() {
        let mut img = white_canvas(600, 800);
        for y in (60..740).step_by(30) {
            for cx in (60..540).step_by(14) {
                for dy in 0..8 {
                    for dx in 0..6 {
                        img.put_pixel(cx + dx, y + dy, image::Rgb([20, 20, 20]));
                    }
                }
            }
        }
        let (kind, _) = classify_image(&image::DynamicImage::ImageRgb8(img), "scan0043.jpg");
        assert_eq!(kind, DocumentKind::Image, "a text scan must not be sent down the drawing route");
    }

    /// The filename still wins and is still cheaper than pixels: a P&ID named
    /// as one is routed on the name alone, before any sampling.
    #[test]
    fn a_drawing_named_as_one_needs_no_pixels() {
        let img = white_canvas(10, 10);
        let (kind, why) = classify_image(&image::DynamicImage::ImageRgb8(img), "8-P-2103-A2A PID.jpg");
        assert_eq!(kind, DocumentKind::Drawing);
        assert!(why.contains("file name"), "why: {why}");
    }
}

/// §3 — a page the printed-text reader could not resolve is escalated, not
/// returned as the best that could be managed.
///
/// The Handwriting rule has always claimed this ("chosen when OCR confidence
/// falls below threshold"). What it did not have was a mechanism: `ocr_pages`
/// took one model, and a page PaddleOCR-VL returned as a few fragments — which
/// is how it fails on a hand-filled log sheet, rather than with an error — was
/// stored as the transcription of that page. There is no confidence number to
/// read, so `unreadable` judges the shape of the text instead, and these are the
/// shapes.
#[cfg(test)]
mod ocr_escalation {
    use super::unreadable;

    /// What a page of handwriting looks like coming back from a printed-text
    /// reader: almost nothing, or nothing that is letters.
    #[test]
    fn a_page_that_came_back_as_fragments_is_not_a_transcription() {
        for text in [
            "",
            "   \n  ",
            "1 2 -- .",
            "| | | --- | |",
            "T\u{fffd}-04 7.\u{fffd} mm",
            "•••• ···· ---- ~~~~ ++++ ==== |||| ____ ",
        ] {
            assert!(unreadable(text).is_some(), "kept as a transcription: {text:?}");
        }
    }

    /// A page that was actually read, including one that is mostly a table —
    /// pipes and dashes are structure, and a table must not be mistaken for
    /// noise.
    #[test]
    fn a_page_that_was_read_is_kept() {
        for text in [
            "Thickness survey sheet for 4-P-1102, test point TP-04, reading 7.1 mm.",
            "| Point | Reading | Limit |\n| TP-04 | 7.1 mm | 9.8 mm |\n| TP-05 | 8.4 mm | 9.8 mm |",
            "PUMP DATA SHEET\nService: crude charge\nRated flow 420 m3/h at 2980 rpm\n",
        ] {
            assert!(unreadable(text).is_none(), "rejected a real page: {text:?} -> {:?}", unreadable(text));
        }
    }

    /// The reason travels with the decision, because the operator is told which
    /// pages were escalated and why, and "low confidence" would be a number the
    /// pipeline does not have.
    #[test]
    fn the_reason_says_what_was_actually_measured() {
        let why = unreadable("1 2 -- .").unwrap_or_default();
        assert!(why.contains("characters"), "{why}");
        assert!(!why.to_lowercase().contains("confidence"), "{why}");
    }
}

#[cfg(test)]
mod delimited_files {
    use super::{csv_delimiter, csv_extract, csv_rows};

    /// The defect: `split(',')` moved every value after a quoted comma one
    /// column left, so the reading landed under the wrong heading and the table
    /// still looked valid.
    #[test]
    fn a_comma_inside_a_quoted_field_is_not_a_column_break() {
        let csv = "Component,Measured (mm),Date\n\
                   \"Elbow, downstream\",4.8,2024-06-01\n\
                   \"Header, north end\",6.2,2024-06-02\n";
        let (_, tables) = csv_extract(csv);
        let t = &tables[0];
        assert_eq!(t.header, ["Component", "Measured (mm)", "Date"]);
        assert_eq!(t.rows[0], ["Elbow, downstream", "4.8", "2024-06-01"]);
        assert_eq!(t.rows[1], ["Header, north end", "6.2", "2024-06-02"]);
    }

    /// A doubled quote is one quote, and a quote that is not opening a field is
    /// just a character — `6"` is a diameter in inches, and reading it as an
    /// opening quote swallowed the rest of the row.
    #[test]
    fn quotes_inside_a_value_stay_inside_the_value() {
        let csv = "Line,Size,Note\n\
                   4-P-1102,6\" CS,downstream of V-301\n\
                   4-P-1103,8\" CS,\"marked \"\"replace\"\" in the register\"\n";
        let (_, tables) = csv_extract(csv);
        let t = &tables[0];
        assert_eq!(t.rows[0], ["4-P-1102", "6\" CS", "downstream of V-301"]);
        assert_eq!(t.rows[1][1], "8\" CS");
        assert_eq!(t.rows[1][2], "marked \"replace\" in the register");
    }

    /// A field may span lines. Splitting on newlines first turned one row into
    /// two, the second of them ragged.
    #[test]
    fn a_line_break_inside_a_quoted_field_does_not_end_the_row() {
        let csv = "Tag,Finding\nV-301,\"Pitting on the shell.\nRe-measure next outage.\"\nV-302,None\n";
        let (_, tables) = csv_extract(csv);
        let t = &tables[0];
        assert_eq!(t.rows.len(), 2);
        assert_eq!(t.rows[0][1], "Pitting on the shell.\nRe-measure next outage.");
        assert_eq!(t.rows[1], ["V-302", "None"]);
    }

    /// The delimiter is decided by what parses consistently, not by which
    /// character appears most: one comma in a quoted heading used to outvote
    /// every semicolon in the file.
    #[test]
    fn the_delimiter_is_the_one_that_gives_a_consistent_table() {
        let semi = "Component;\"Measured, mm\";Date\nElbow;4.8;2024-06-01\nHeader;6.2;2024-06-02\n";
        assert_eq!(csv_delimiter(semi), ';');
        let (_, tables) = csv_extract(semi);
        assert_eq!(tables[0].header, ["Component", "Measured, mm", "Date"]);
        assert_eq!(tables[0].rows[0], ["Elbow", "4.8", "2024-06-01"]);

        let tabs = "Component\tMeasured\tDate\nElbow\t4.8\t2024-06-01\nHeader\t6.2\t2024-06-02\n";
        assert_eq!(csv_delimiter(tabs), '\t');

        let commas = "Component,Measured,Date\nElbow,4.8,2024-06-01\n";
        assert_eq!(csv_delimiter(commas), ',');
        // Nothing to separate: one column, and the file is still readable.
        let single = "Component\nElbow\nHeader\n";
        assert_eq!(csv_delimiter(single), ',');
        assert_eq!(csv_extract(single).1[0].rows.len(), 2);
    }

    /// Excel's byte-order mark is not part of the first heading. U+FEFF is not
    /// whitespace, so `trim` left it there and every lookup by heading missed.
    #[test]
    fn a_byte_order_mark_is_not_part_of_the_first_heading() {
        let csv = "\u{feff}Tag,Reading\nPI-01,4.2\n";
        let (_, tables) = csv_extract(csv);
        assert_eq!(tables[0].header, ["Tag", "Reading"]);
    }

    #[test]
    fn windows_line_endings_and_blank_lines_are_handled() {
        let csv = "Tag,Reading\r\nPI-01,4.2\r\n\r\nPI-02,4.9\r\n";
        let rows = csv_rows(csv, ',');
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[1], ["PI-01", "4.2"]);
        assert_eq!(rows[2], ["PI-02", "4.9"]);
        // A row that is genuinely mostly empty is still a row.
        let sparse = csv_rows("PI-03,,\n", ',');
        assert_eq!(sparse, [["PI-03", "", ""]]);
    }

    /// Spacing around a delimiter is not data; spacing inside quotes is.
    #[test]
    fn unquoted_fields_are_trimmed_and_quoted_fields_are_not() {
        let rows = csv_rows("Elbow , 4.8 ,  \" kept  \"\n", ',');
        assert_eq!(rows[0], ["Elbow", "4.8", " kept  "]);
    }
}
