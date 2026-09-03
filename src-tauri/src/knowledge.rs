//! §5 — the local knowledge index.
//!
//! Retrieval here has to satisfy two things at once that pull in different
//! directions. An operator asking "what does the SOP say about hot work permits"
//! wants passages that *mean* that, which is a job for embeddings. An operator
//! asking about "PSV-2041B" wants the passages that contain exactly that string,
//! and an embedding model will happily return PSV-2041A, PSV-2014B and a
//! paragraph about relief valves in general — all semantically adjacent, all
//! wrong. In an inspection record a near-miss on a tag number is worse than no
//! answer, so both halves run and their rankings are fused: FTS5 with BM25 for
//! the lexical half, cosine over stored vectors for the semantic half.
//!
//! Indexing goes through `documents::ingest`, not through a second extraction
//! path. That is deliberate: it means a scanned drawing added to the knowledge
//! folder is OCR'd by the same code, with the same visible model-selection
//! steps, as one the operator opens by hand — and that a file already read once
//! is not read again, because `ingest` is idempotent on content hash.
//!
//! Every returned passage is a `Citation` carrying its file, page and box. A
//! sentence the operator cannot open and point at is not evidence, and this
//! application exists to produce work that survives being checked.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::db::{ChunkHit, ChunkRow};
use crate::error::{CoreError, CoreResult};
use crate::state::{new_id, now_ms, AppState};
use crate::types::*;

/// Target characters per chunk.
///
/// Sized in characters rather than tokens because the embedding model's
/// tokeniser is not reachable from here, and a 1200-character passage is
/// comfortably inside the context of every embedding model in the catalogue
/// with room for the query. Prose gets ~200 words, a table gets several rows.
const CHUNK_CHARS: usize = 1200;

/// Overlap between consecutive chunks, in characters.
///
/// Without it, a sentence that straddles a boundary is in neither chunk in a
/// readable form and retrieval misses it. One sentence of overlap is the cheap
/// insurance; more than that inflates the index without improving recall.
const CHUNK_OVERLAP: usize = 180;

/// Below this a chunk is not worth a row: a page number, a header fragment, a
/// stray line of dashes. They dilute BM25 and add nothing to retrieve.
const MIN_CHUNK_CHARS: usize = 60;

/// Embedding requests per HTTP call. Large enough that a 400-chunk document is
/// 25 calls rather than 400; small enough that one failure does not cost the
/// whole document, and that the request body stays a sane size.
const EMBED_BATCH: usize = 16;

/// How much of a passage a citation carries.
///
/// The snippet is what the operator reads in the sources list before deciding to
/// open the page, so it has to be long enough to judge relevance and short
/// enough that six of them fit on screen.
const SNIPPET_CHARS: usize = 420;

/// Debounce for the folder watcher, in milliseconds.
///
/// A single save from Word or Excel produces a burst of create/modify/rename
/// events, and re-indexing on each one would OCR the same file several times.
const WATCH_DEBOUNCE_MS: u64 = 2500;

/* ------------------------------------------------------------------ */
/* Chunking                                                            */
/* ------------------------------------------------------------------ */

/// A passage with the page it came from.
struct Passage {
    text: String,
    page: Option<u32>,
    bbox: Option<BoundingBox>,
}

/// Splits at a boundary that is not inside a word.
///
/// Prefers, in order: a paragraph break, a sentence end, a line break, a space.
/// Cutting mid-token would put half a tag number in each chunk — "PSV-20" and
/// "41B" — and neither half retrieves.
fn split_point(s: &str, target: usize) -> usize {
    if s.len() <= target {
        return s.len();
    }
    // Search backwards from the target for a boundary, but never give up more
    // than a third of the chunk chasing one.
    let floor = target.saturating_sub(target / 3).max(1);
    let window = &s[..target.min(s.len())];

    for pat in ["\n\n", ". ", ".\n", "\n", " "] {
        if let Some(idx) = window.rfind(pat) {
            let cut = idx + pat.len();
            if cut >= floor {
                return cut;
            }
        }
    }
    // No boundary in range — cut at the target, moved forward to the next
    // character boundary so the string stays valid UTF-8.
    let mut cut = target.min(s.len());
    while cut < s.len() && !s.is_char_boundary(cut) {
        cut += 1;
    }
    cut
}

/// Chunks one block's text, carrying its page and box onto every piece.
fn chunk_text(text: &str, page: Option<u32>, bbox: Option<&BoundingBox>, out: &mut Vec<Passage>) {
    let text = text.trim();
    if text.is_empty() {
        return;
    }
    let mut rest = text;
    loop {
        let cut = split_point(rest, CHUNK_CHARS);
        let piece = rest[..cut].trim();
        if piece.chars().count() >= MIN_CHUNK_CHARS || (out.is_empty() && !piece.is_empty()) {
            out.push(Passage {
                text: piece.to_string(),
                page,
                bbox: bbox.map(|b| BoundingBox { page: b.page, x: b.x, y: b.y, w: b.w, h: b.h }),
            });
        }
        if cut >= rest.len() {
            break;
        }
        // Step back by the overlap, at a character boundary.
        let mut start = cut.saturating_sub(CHUNK_OVERLAP);
        while start < rest.len() && !rest.is_char_boundary(start) {
            start += 1;
        }
        if start == 0 || start >= cut {
            // Overlap would not advance; take the plain cut instead of looping.
            rest = &rest[cut..];
        } else {
            rest = &rest[start..];
        }
        if rest.trim().is_empty() {
            break;
        }
    }
}

/// Renders a table as one passage per row group, with the header repeated.
///
/// A table row on its own is meaningless — "12.4 | 11.8 | accept" retrieves
/// nothing and explains nothing. Repeating the header into each piece is what
/// makes a thickness reading in an inspection table both findable and readable
/// once found.
fn chunk_table(t: &DocTable, out: &mut Vec<Passage>) {
    if t.rows.is_empty() && t.header.is_empty() {
        return;
    }
    let header = if t.header.is_empty() {
        String::new()
    } else {
        format!("{}\n{}\n", t.header.join(" | "), t.header.iter().map(|_| "---").collect::<Vec<_>>().join(" | "))
    };

    let mut current = String::new();
    let flush = |body: &mut String, out: &mut Vec<Passage>| {
        if body.trim().is_empty() {
            return;
        }
        out.push(Passage {
            text: format!("{header}{body}"),
            page: Some(t.page),
            bbox: Some(BoundingBox {
                page: t.bbox.page,
                x: t.bbox.x,
                y: t.bbox.y,
                w: t.bbox.w,
                h: t.bbox.h,
            }),
        });
        body.clear();
    };

    for row in &t.rows {
        let line = format!("{}\n", row.join(" | "));
        if current.len() + line.len() + header.len() > CHUNK_CHARS && !current.is_empty() {
            flush(&mut current, out);
        }
        current.push_str(&line);
    }
    flush(&mut current, out);
}

/// Turns an extracted document into the passages that will be indexed.
///
/// Blocks first, in document order, then tables. Tables are chunked separately
/// rather than left in the block stream because a table's shape is what makes
/// it readable, and flattening it into prose destroys the column alignment that
/// tells an operator which number is the reading and which is the limit.
fn passages_for(doc: &IngestedDocument) -> Vec<Passage> {
    let mut out: Vec<Passage> = Vec::new();

    for b in &doc.blocks {
        // Tag blocks are one identifier each: indexed verbatim, never split,
        // and never dropped for being short — a tag is the highest-value
        // lexical target in the whole corpus.
        if b.kind == BlockKind::Tag {
            out.push(Passage {
                text: b.text.trim().to_string(),
                page: Some(b.bbox.page),
                bbox: Some(BoundingBox {
                    page: b.bbox.page,
                    x: b.bbox.x,
                    y: b.bbox.y,
                    w: b.bbox.w,
                    h: b.bbox.h,
                }),
            });
            continue;
        }
        chunk_text(&b.text, Some(b.bbox.page), Some(&b.bbox), &mut out);
    }

    for t in &doc.tables {
        chunk_table(t, &mut out);
    }

    // A document whose text is all short fragments — a drawing that is mostly
    // labels, a one-line note — must still be findable, so if strict chunking
    // produced nothing, index the whole thing as one passage.
    if out.is_empty() {
        let joined = doc
            .blocks
            .iter()
            .map(|b| b.text.trim())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !joined.trim().is_empty() {
            out.push(Passage { text: joined, page: Some(1), bbox: None });
        }
    }

    out
}

/* ------------------------------------------------------------------ */
/* Query preparation                                                   */
/* ------------------------------------------------------------------ */

/// Rewrites an operator's words into an FTS5 query string.
///
/// FTS5's query language treats `-`, `"`, `*`, `(`, `:` and `NEAR` as syntax, so
/// a question typed with a hyphen in a tag number ("PSV-2041B") is either a
/// syntax error or a NOT. Every run of alphanumerics becomes a quoted term and
/// everything else becomes a separator, then the terms are OR'd — so a question
/// that shares four words with a passage ranks above one that shares two, and a
/// question that shares none returns nothing rather than failing.
///
/// Quoting also means the tokeniser sees `psv 2041b` as an adjacent pair, which
/// is how the same tag was tokenised at index time.
fn fts_query(query: &str) -> String {
    let mut terms: Vec<String> = Vec::new();
    let mut buf = String::new();

    let push = |buf: &mut String, terms: &mut Vec<String>| {
        if buf.len() >= 2 || buf.chars().any(|c| c.is_ascii_digit()) {
            terms.push(format!("\"{buf}\""));
        }
        buf.clear();
    };

    for ch in query.chars() {
        if ch.is_alphanumeric() {
            buf.push(ch);
        } else if ch == '-' || ch == '_' || ch == '/' || ch == '.' {
            // Inside a tag or a line number these join rather than separate:
            // "PSV-2041B" and "6\"-P-1204" are single identifiers. Keeping them
            // as a quoted phrase matches how the indexer tokenised them.
            buf.push(' ');
        } else {
            push(&mut buf, &mut terms);
        }
    }
    push(&mut buf, &mut terms);

    // Collapse the inner spaces a joined identifier introduced, and drop the
    // stop-words that would otherwise dominate a short question.
    const NOISE: &[&str] = &[
        "the", "and", "for", "with", "what", "which", "how", "does", "did", "was", "are", "this",
        "that", "from", "have", "has", "about", "any", "all", "can", "should", "would", "there",
        "its", "our", "per", "into", "when", "were", "been", "being",
    ];
    let cleaned: Vec<String> = terms
        .into_iter()
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" ").replace("\" \"", " "))
        .filter(|t| {
            let inner = t.trim_matches('"').to_ascii_lowercase();
            !inner.is_empty() && !NOISE.contains(&inner.as_str())
        })
        .collect();

    cleaned.join(" OR ")
}

fn snippet_of(text: &str) -> String {
    let t = text.trim();
    if t.chars().count() <= SNIPPET_CHARS {
        return t.to_string();
    }
    let cut = split_point(t, SNIPPET_CHARS);
    format!("{}…", t[..cut].trim_end())
}

/* ------------------------------------------------------------------ */
/* Fusion                                                             */
/* ------------------------------------------------------------------ */

/// Reciprocal rank fusion.
///
/// Two rankings on incomparable scales — BM25 is an unbounded negative log-odds,
/// cosine is a bounded similarity — cannot be added or averaged without one
/// silently dominating. RRF ignores the magnitudes and uses only the positions,
/// which is what makes it robust: a passage ranked first by both halves wins, a
/// passage ranked first by one and absent from the other still places well, and
/// no normalisation constant has to be tuned per corpus.
///
/// `K` damps the top of the curve so rank 1 is not worth ten times rank 2. 60 is
/// the value from the original Cormack et al. result and it needs no tuning here.
const RRF_K: f32 = 60.0;

fn rrf(rank: usize) -> f32 {
    1.0 / (RRF_K + rank as f32 + 1.0)
}

/* ------------------------------------------------------------------ */
/* Stats and listing                                                   */
/* ------------------------------------------------------------------ */

pub fn stats(st: &AppState) -> CoreResult<KnowledgeIndexStats> {
    let (documents, chunks, index_bytes, last_indexed_at, stored_dim) =
        st.with_db(crate::db::knowledge_totals)?;

    let embedding_model_id = {
        let reg = st
            .registry
            .read()
            .map_err(|_| CoreError::ExecutionFailed("The model registry lock was poisoned.".into()))?;
        reg.embedding_model().map(|e| e.id.clone()).unwrap_or_default()
    };

    Ok(KnowledgeIndexStats {
        documents,
        chunks,
        index_bytes,
        embedding_model_id,
        // The width of what is actually stored, read from a vector row rather
        // than from the catalogue. The catalogue's number is what the model
        // claims; this is what the index contains, and on an empty index the
        // honest answer is 0 rather than a figure nothing was embedded at.
        embedding_dim: stored_dim,
        watching: st.watching.load(Ordering::Relaxed),
        watched_folders: st
            .watched_folders
            .lock()
            .map(|f| f.clone())
            .unwrap_or_default(),
        last_indexed_at,
    })
}

pub fn list(st: &AppState) -> CoreResult<Vec<KnowledgeSource>> {
    st.with_db(crate::db::knowledge_sources)
}

/* ------------------------------------------------------------------ */
/* Indexing                                                           */
/* ------------------------------------------------------------------ */

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

/// Publishes a source's current state to the Knowledge panel and stores it.
///
/// One function for both because a status the UI shows and the store does not
/// hold is a status that vanishes on restart, and an operator who saw "failed"
/// before lunch needs to still see it after.
fn publish(st: &AppState, source: &KnowledgeSource) -> CoreResult<()> {
    st.with_db(|conn| crate::db::upsert_knowledge_source(conn, source))?;
    st.emit("knowledge://progress", source.clone());
    Ok(())
}

/// Embeds passages in batches, returning one optional vector per passage.
///
/// A failure is not fatal. If the embedding model is missing or the router is
/// down, indexing continues and the chunks are stored without vectors: lexical
/// search still finds them, which is a degraded index rather than no index. The
/// reason is returned so the source row can say what was lost.
async fn embed_passages(
    st: &AppState,
    texts: &[String],
) -> (Vec<Option<Vec<f32>>>, Option<String>) {
    let mut out: Vec<Option<Vec<f32>>> = Vec::with_capacity(texts.len());
    let mut note: Option<String> = None;

    for batch in texts.chunks(EMBED_BATCH) {
        if note.is_some() {
            // Once the embedding path has failed, stop hammering it — the
            // remaining batches go in lexical-only alongside the first.
            out.extend(std::iter::repeat_with(|| None).take(batch.len()));
            continue;
        }
        match crate::router::embed(st, batch).await {
            Ok(vecs) if vecs.len() == batch.len() => out.extend(vecs.into_iter().map(Some)),
            Ok(_) => {
                note = Some("The embedding model returned a mismatched batch, so this document was indexed for exact-text search only.".into());
                out.extend(std::iter::repeat_with(|| None).take(batch.len()));
            }
            Err(e) => {
                note = Some(format!(
                    "Semantic indexing was unavailable ({}), so this document was indexed for exact-text search only.",
                    e.message()
                ));
                out.extend(std::iter::repeat_with(|| None).take(batch.len()));
            }
        }
    }

    (out, note)
}

/// Indexes one file: extract, chunk, embed, store.
///
/// Returns the source row in whatever state it ended in — `Indexed` with a
/// possible note, or `Failed` with the reason. It does not propagate the error,
/// because indexing twelve files must not stop at the first unreadable one; the
/// caller reports each outcome separately.
async fn index_one(st: &Arc<AppState>, path: &str) -> KnowledgeSource {
    let name = file_name_of(path);
    let existing = st
        .with_db(|conn| crate::db::knowledge_source_by_path(conn, path))
        .ok()
        .flatten();

    let id = existing.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| new_id("ks"));
    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let mut source = KnowledgeSource {
        id: id.clone(),
        path: path.to_string(),
        file_name: name.clone(),
        kind: existing.as_ref().map(|s| s.kind).unwrap_or(DocumentKind::Text),
        chunks: existing.as_ref().map(|s| s.chunks).unwrap_or(0),
        size_bytes,
        sha256: existing.as_ref().map(|s| s.sha256.clone()).unwrap_or_default(),
        status: IndexStatus::Indexing,
        indexed_at: existing.as_ref().and_then(|s| s.indexed_at),
        error: None,
    };
    let _ = publish(st, &source);

    // Extraction. This is the expensive half for a scanned document — it runs
    // the same OCR path, with the same visible model-selection steps, as opening
    // the file by hand, and it is skipped entirely when the content hash is
    // already known.
    let doc = match crate::documents::ingest(st, path).await {
        Ok(d) => d,
        Err(e) => {
            source.status = IndexStatus::Failed;
            source.error = Some(e.message());
            let _ = publish(st, &source);
            return source;
        }
    };

    source.kind = doc.kind;
    source.sha256 = doc.sha256.clone();

    let passages = passages_for(&doc);
    if passages.is_empty() {
        source.status = IndexStatus::Failed;
        source.chunks = 0;
        source.error = Some(format!(
            "{name} was read but produced no text to index, so nothing was added. A scan with no recoverable text needs to be exported as an image and attached instead."
        ));
        let _ = publish(st, &source);
        return source;
    }

    let texts: Vec<String> = passages.iter().map(|p| p.text.clone()).collect();
    let (vectors, note) = embed_passages(st, &texts).await;

    let rows: Vec<ChunkRow> = passages
        .into_iter()
        .zip(vectors)
        .enumerate()
        .map(|(i, (p, v))| ChunkRow {
            id: new_id("ch"),
            ordinal: i as u32,
            text: p.text,
            page: p.page,
            bbox: p.bbox,
            embedding: v,
        })
        .collect();

    let count = rows.len() as u32;
    // The source row has to exist before the chunks, because `chunks.source_id`
    // is a foreign key onto it.
    source.chunks = count;
    if let Err(e) = publish(st, &source) {
        source.status = IndexStatus::Failed;
        source.error = Some(e.message());
        let _ = publish(st, &source);
        return source;
    }

    match st.with_db(|conn| crate::db::replace_chunks(conn, &id, &rows)) {
        Ok(()) => {
            source.status = IndexStatus::Indexed;
            source.indexed_at = Some(now_ms());
            source.error = note;
        }
        Err(e) => {
            source.status = IndexStatus::Failed;
            source.chunks = 0;
            source.error = Some(e.message());
        }
    }
    let _ = publish(st, &source);
    source
}

/// One spelling per file on disk. See `fsops::canonical` for why.
use crate::fsops::canonical;

/// Expands a selection into the files that will actually be indexed.
///
/// A folder is walked rather than refused, because the operator who points at
/// their SOP folder means the documents in it. Depth is bounded and unreadable
/// entries are skipped rather than aborting the walk — one permission-denied
/// subfolder must not cost the other forty files.
fn expand(paths: &[String]) -> Vec<String> {
    fn walk(dir: &Path, depth: usize, out: &mut Vec<String>) {
        if depth > 6 || out.len() > 4000 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let p = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            // Version-control and build directories are noise in a knowledge
            // index, and `~$…` files are Word's lock stubs, not documents.
            if name.starts_with('.') || name.starts_with("~$") || name == "node_modules" || name == "target" {
                continue;
            }
            match entry.file_type() {
                Ok(t) if t.is_dir() => walk(&p, depth + 1, out),
                Ok(t) if t.is_file() => {
                    if is_indexable(&p) {
                        out.push(canonical(&p));
                    }
                }
                _ => {}
            }
        }
    }

    let mut out = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            walk(path, 0, &mut out);
        } else if path.is_file() {
            out.push(canonical(path));
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Extensions the extraction layer can actually read.
///
/// Listed explicitly rather than attempting everything, because handing a `.exe`
/// or a 400 MB `.iso` to the ingestion path produces a slow failure and a
/// confusing row in the panel.
fn is_indexable(path: &Path) -> bool {
    const OK: &[&str] = &[
        "pdf", "docx", "pptx", "xlsx", "xlsm", "xls", "ods", "csv", "tsv", "txt", "md", "markdown",
        "log", "json", "yaml", "yml", "toml", "ini", "cfg", "xml", "html", "rst", "tex", "png",
        "jpg", "jpeg", "webp", "bmp", "gif", "tif", "tiff", "rs", "py", "js", "ts", "tsx", "jsx",
        "c", "h", "cpp", "hpp", "cs", "java", "go", "rb", "php", "sh", "ps1", "sql", "st", "scl",
    ];
    path.extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .map(|e| OK.contains(&e.as_str()))
        .unwrap_or(false)
}

pub async fn index(st: Arc<AppState>, paths: Vec<String>) -> CoreResult<Vec<KnowledgeSource>> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let files = expand(&paths);
    if files.is_empty() {
        return Err(CoreError::IndexFailed(format!(
            "Nothing indexable was found in the {} path(s) selected. Readable types are documents, spreadsheets, drawings, images and text or source files.",
            paths.len()
        )));
    }

    // Queued rows first, so the panel shows the whole job immediately rather
    // than one row at a time as each file finishes.
    for f in &files {
        let existing = st.with_db(|conn| crate::db::knowledge_source_by_path(conn, f)).ok().flatten();
        if existing.as_ref().map(|s| s.status) != Some(IndexStatus::Indexing) {
            let queued = KnowledgeSource {
                id: existing.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| new_id("ks")),
                path: f.clone(),
                file_name: file_name_of(f),
                kind: existing.as_ref().map(|s| s.kind).unwrap_or(DocumentKind::Text),
                chunks: existing.as_ref().map(|s| s.chunks).unwrap_or(0),
                size_bytes: std::fs::metadata(f).map(|m| m.len()).unwrap_or(0),
                sha256: existing.as_ref().map(|s| s.sha256.clone()).unwrap_or_default(),
                status: IndexStatus::Queued,
                indexed_at: existing.as_ref().and_then(|s| s.indexed_at),
                error: None,
            };
            let _ = publish(&st, &queued);
        }
    }

    // Sequential, deliberately. Indexing a scanned document loads a vision
    // model; running four of those concurrently on one 8 GB GPU means four
    // evictions and a slower total than doing them in turn.
    let mut out = Vec::with_capacity(files.len());
    for f in &files {
        out.push(index_one(&st, f).await);
    }
    Ok(out)
}

pub async fn reindex(st: Arc<AppState>, id: String) -> CoreResult<KnowledgeSource> {
    let source = st.with_db(|conn| crate::db::knowledge_source(conn, &id))?;
    if !Path::new(&source.path).exists() {
        let mut failed = source.clone();
        failed.status = IndexStatus::Failed;
        failed.error = Some(format!(
            "{} is no longer at {}. Its passages are still in the index; remove it if the file is gone for good.",
            source.file_name, source.path
        ));
        publish(&st, &failed)?;
        return Ok(failed);
    }
    Ok(index_one(&st, &source.path).await)
}

pub fn remove(st: &AppState, id: &str) -> CoreResult<()> {
    // Read first so a removal is reported against a real row rather than
    // silently succeeding on an id that never existed.
    let source = st.with_db(|conn| crate::db::knowledge_source(conn, id))?;
    st.with_db(|conn| crate::db::delete_knowledge_source(conn, id))?;
    // Deliberately no `knowledge://progress` here. That event means "this
    // source changed", and every listener merges it into the list by id — so a
    // row emitted for something that no longer exists would reappear as a ghost
    // in any surface that did not initiate the removal. The caller reloads the
    // list, which is the only correct way to communicate a deletion over an
    // upsert-shaped event.
    let _ = source;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Folder watching                                                    */
/* ------------------------------------------------------------------ */

/// What the running watcher currently reports holding.
fn watch_roots_held(st: &AppState) -> Vec<String> {
    st.watched_folders.lock().map(|f| f.clone()).unwrap_or_default()
}

/// The folders a running watcher covers.
///
/// The configured knowledge folder is one of them; the rest are the folders the
/// indexed sources actually came out of. Documents are added from wherever the
/// operator keeps them — a share, a project folder, a copy off a USB stick — and
/// a toggle labelled "watch for changes" that only ever watched the configured
/// folder did nothing at all for any of them, silently, while reading as on.
///
/// Nested folders collapse into their ancestor: the watch is recursive, so
/// holding a handle on both a folder and its parent delivers every save twice.
fn watch_roots(st: &AppState) -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;

    let mut dirs: Vec<PathBuf> = Vec::new();

    let configured = st.settings().knowledge_root;
    if !configured.trim().is_empty() {
        let p = PathBuf::from(&configured);
        // Create it rather than refuse: the folder is ours by configuration and
        // its absence on a fresh install is not an error the operator caused.
        if !p.is_dir() {
            let _ = std::fs::create_dir_all(&p);
        }
        if p.is_dir() {
            dirs.push(PathBuf::from(canonical(&p)));
        }
    }

    if let Ok(sources) = st.with_db(crate::db::knowledge_sources) {
        for s in sources {
            if let Some(parent) = Path::new(&s.path).parent() {
                if parent.is_dir() {
                    dirs.push(PathBuf::from(canonical(parent)));
                }
            }
        }
    }

    dirs.sort();
    dirs.dedup();

    let mut roots: Vec<PathBuf> = Vec::new();
    for d in dirs {
        if roots.iter().any(|r| crate::fsops::within(r, &d)) {
            continue;
        }
        roots.retain(|r| !crate::fsops::within(&d, r));
        roots.push(d);
    }
    roots
}

/// Starts or stops the knowledge-folder watcher.
///
/// The watcher exists so a report dropped into the folder is searchable without
/// anyone remembering to press a button. It is off by default and reports its
/// own state, because a process that reads and OCRs files on its own should be
/// something the operator switched on knowingly.
///
/// Events are debounced and coalesced by path: one save produces one re-index,
/// not the five filesystem events Word actually emits.
pub fn set_watching(st: Arc<AppState>, on: bool) -> CoreResult<KnowledgeIndexStats> {
    if !on {
        // The watcher thread observes this flag between events and returns,
        // dropping the watch handle with it. Cooperative rather than a kill,
        // for the same reason run cancellation is: it stops at a boundary.
        st.watching.store(false, Ordering::Relaxed);
        if let Ok(mut f) = st.watched_folders.lock() {
            f.clear();
        }
        return stats(&st);
    }

    if st.watching.load(Ordering::Relaxed) {
        return stats(&st);
    }

    use notify::{RecursiveMode, Watcher};

    let roots = watch_roots(&st);
    if roots.is_empty() {
        return Err(CoreError::IndexFailed(
            "There is no folder to watch: no documents are indexed and no knowledge folder is configured. Set one in Settings or add documents first.".into(),
        ));
    }

    // The handles are taken here rather than inside the thread so that the call
    // returns the folders it is actually watching. Spawning first and recording
    // afterwards meant the toggle reported "watching" with an empty folder list,
    // and a folder that could not be watched was discovered after the answer.
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(tx).map_err(|e| {
        CoreError::IndexFailed(format!(
            "The folder watcher could not start ({e}). Indexing by hand still works."
        ))
    })?;

    let mut held: Vec<String> = Vec::new();
    let mut refused: Vec<String> = Vec::new();
    for root in &roots {
        match watcher.watch(root, RecursiveMode::Recursive) {
            Ok(()) => held.push(crate::fsops::tidy(root)),
            Err(e) => refused.push(format!("{} ({e})", root.display())),
        }
    }
    if held.is_empty() {
        return Err(CoreError::IndexFailed(format!(
            "No folder could be watched: {}. Indexing by hand still works.",
            refused.join("; ")
        )));
    }
    // A folder that cannot be watched costs that folder, not the feature: one
    // share that went offline must not stop the other three from re-indexing.
    for r in &refused {
        st.emit_failure(&CoreError::IndexFailed(format!(
            "{r} could not be watched, so files there need indexing by hand."
        )));
    }
    held.sort();
    if let Ok(mut f) = st.watched_folders.lock() {
        *f = held;
    }

    st.watching.store(true, Ordering::Relaxed);

    let watch_state = st.clone();
    std::thread::spawn(move || {
        // Moved in so the handles stay alive for the life of the thread, and so
        // the sweep below can add a folder indexed after the watch started.
        let mut watcher = watcher;

        // Paths seen but not yet indexed, with the time they were last touched.
        let mut pending: HashMap<String, u64> = HashMap::new();
        let mut sweep: u32 = 0;
        let tick = std::time::Duration::from_millis(500);

        loop {
            if !watch_state.watching.load(Ordering::Relaxed) {
                return;
            }

            // Folders indexed after the watch started belong to it too. The
            // thread owns the handle, so it re-reads the set instead of the
            // toggle needing to be turned off and on again after every add.
            sweep = sweep.wrapping_add(1);
            if sweep % 20 == 0 {
                let want = watch_roots(&watch_state);
                let have: Vec<String> = watch_roots_held(&watch_state);
                for root in &want {
                    let shown = crate::fsops::tidy(root);
                    if have.contains(&shown) {
                        continue;
                    }
                    if watcher.watch(root, RecursiveMode::Recursive).is_ok() {
                        if let Ok(mut f) = watch_state.watched_folders.lock() {
                            f.push(shown);
                            f.sort();
                        }
                    }
                }
                for shown in have {
                    if want.iter().any(|r| crate::fsops::tidy(r) == shown) {
                        continue;
                    }
                    // Its last indexed source is gone, so the folder is no
                    // longer part of the knowledge base and must stop being
                    // named as watched.
                    let _ = watcher.unwatch(Path::new(&shown));
                    if let Ok(mut f) = watch_state.watched_folders.lock() {
                        f.retain(|held| held != &shown);
                    }
                }
            }

            match rx.recv_timeout(tick) {
                Ok(Ok(event)) => {
                    use notify::EventKind;
                    let interesting = matches!(
                        event.kind,
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                    );
                    if interesting {
                        let now = now_ms() as u64;
                        for p in event.paths {
                            if p.is_file() && is_indexable(&p) {
                                pending.insert(canonical(&p), now);
                            }
                        }
                    }
                }
                Ok(Err(_)) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                // The sender is gone, which means the watcher is gone.
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    watch_state.watching.store(false, Ordering::Relaxed);
                    return;
                }
            }

            let now = now_ms() as u64;
            let ready: Vec<String> = pending
                .iter()
                .filter(|(_, t)| now.saturating_sub(**t) >= WATCH_DEBOUNCE_MS)
                .map(|(p, _)| p.clone())
                .collect();

            for path in ready {
                pending.remove(&path);
                if !Path::new(&path).is_file() {
                    continue;
                }
                // Skip a file whose content is already indexed. `ingest` would
                // return the cached extraction anyway, but checking here avoids
                // re-chunking and re-embedding an unchanged document — which is
                // what a save that only touched metadata produces.
                let unchanged = watch_state
                    .with_db(|conn| crate::db::knowledge_source_by_path(conn, &path))
                    .ok()
                    .flatten()
                    .and_then(|s| {
                        (s.status == IndexStatus::Indexed).then(|| {
                            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                            s.size_bytes == size
                        })
                    })
                    .unwrap_or(false);
                if unchanged {
                    continue;
                }

                let job_state = watch_state.clone();
                // Indexing is async and this thread is not a runtime, so the
                // work is handed to the Tokio runtime the app already has.
                tauri::async_runtime::spawn(async move {
                    let _ = index_one(&job_state, &path).await;
                });
            }
        }
    });

    stats(&st)
}

/* ------------------------------------------------------------------ */
/* Retrieval                                                          */
/* ------------------------------------------------------------------ */

fn citation_of(hit: &ChunkHit, score: f32) -> Citation {
    Citation {
        doc_id: hit.source_id.clone(),
        path: hit.path.clone(),
        file_name: hit.file_name.clone(),
        page: hit.page,
        bbox: hit.bbox.as_ref().map(|b| BoundingBox {
            page: b.page,
            x: b.x,
            y: b.y,
            w: b.w,
            h: b.h,
        }),
        snippet: snippet_of(&hit.text),
        score,
    }
}

/// A retrieved passage: what the operator is shown, and what the model is given.
///
/// Deliberately not the same string. The citation's snippet is capped so half a
/// dozen sources fit on screen; `text` is the whole passage, because the model
/// has to answer out of it. Handing the model the snippet instead is how a
/// question whose answer sat in the second half of an indexed page came back as
/// "not found in the indexed documents" — the fact was indexed, retrieved and
/// ranked first, then truncated away before the model ever saw it. The operator's
/// limit and the model's context are different constraints and cannot share a
/// number.
pub struct Retrieved {
    pub cite: Citation,
    pub text: String,
}

/// Hybrid retrieval over the local index: FTS5 for lexical matches, cosine
/// similarity over stored embeddings for semantic ones, fused into one ranking.
///
/// Returns each passage with its `Citation`, and with the passage text itself:
/// a passage the operator cannot trace back to a page is not evidence, and a
/// snippet of one is not an answer.
///
/// Either half may come back empty and the search still answers. A corpus
/// indexed while the embedding model was unavailable has no vectors, and a
/// question with no matching words has no BM25 hits; only both being empty is
/// an empty result. `hybrid_retrieval` off restricts this to the lexical half,
/// which is the setting to use when an exact-text answer is the only acceptable
/// one — an audit trace, a tag lookup — and the semantic neighbours would be
/// noise.
pub async fn search(st: &AppState, query: &str, limit: u32) -> CoreResult<Vec<Retrieved>> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let settings = st.settings();
    let limit = if limit == 0 { settings.retrieval_top_k.max(1) } else { limit };
    // Each half retrieves deeper than the final cut, because fusion can only
    // promote what it was given: a passage ranked 8th lexically and 3rd
    // semantically deserves to place in a top-5, and it cannot if the lexical
    // half only returned 5.
    let depth = (limit * 4).clamp(20, 200);

    /* ---- lexical ---- */
    let fts = fts_query(query);
    let lexical: Vec<ChunkHit> = if fts.is_empty() {
        Vec::new()
    } else {
        st.with_db(|conn| crate::db::fts_search(conn, &fts, depth))?
    };

    /* ---- semantic ---- */
    let mut semantic: Vec<(String, f32)> = Vec::new();
    let mut semantic_note: Option<String> = None;

    if settings.hybrid_retrieval {
        let vectors = st.with_db(crate::db::all_vectors)?;
        if !vectors.is_empty() {
            let q_batch = [query.to_string()];
            match crate::router::embed(st, &q_batch).await {
                Ok(mut qs) if !qs.is_empty() => {
                    let q = qs.remove(0);
                    let q_norm = crate::db::l2_norm(&q);
                    let mut scored: Vec<(String, f32)> = vectors
                        .into_iter()
                        // A vector of a different width came from a different
                        // embedding model. Comparing them would produce a number
                        // that means nothing, so those chunks sit out the
                        // semantic half and are still reachable lexically.
                        .filter(|(_, _, v)| v.len() == q.len())
                        .map(|(id, norm, v)| (id, crate::db::cosine(&q, q_norm, &v, norm)))
                        .collect();
                    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
                    scored.truncate(depth as usize);
                    semantic = scored;
                }
                Ok(_) => {}
                Err(e) => {
                    semantic_note = Some(e.message());
                }
            }
        }
    }

    /* ---- fusion ---- */
    let mut fused: HashMap<String, f32> = HashMap::new();
    for (rank, hit) in lexical.iter().enumerate() {
        *fused.entry(hit.chunk_id.clone()).or_insert(0.0) += rrf(rank);
    }
    for (rank, (id, _)) in semantic.iter().enumerate() {
        *fused.entry(id.clone()).or_insert(0.0) += rrf(rank);
    }

    if fused.is_empty() {
        if let Some(note) = semantic_note {
            // Nothing matched by words and the semantic half could not run.
            // Saying so is the difference between "no answer in your documents"
            // and "the search was half-blind", which are very different facts.
            return Err(CoreError::IndexFailed(format!(
                "No passage matched those words, and semantic search could not run ({note}). The result is not evidence that your documents do not cover this."
            )));
        }
        return Ok(Vec::new());
    }

    let mut ranked: Vec<(String, f32)> = fused.into_iter().collect();
    // Reciprocal-rank fusion produces genuine ties: two passages that placed
    // second lexically and fifth semantically, in either order, score the same.
    // BM25 breaks those meaningfully — it is a real measure of lexical fit, just
    // not one that can be added to a cosine similarity — and where BM25 does not
    // apply either (two semantic-only hits at the same depth) the id breaks it,
    // so the same query returns the same order twice. A citation list that
    // reshuffles between runs is a citation list nobody trusts.
    let bm25: HashMap<&str, f64> =
        lexical.iter().map(|h| (h.chunk_id.as_str(), h.rank)).collect();
    let lex = |id: &str| bm25.get(id).copied().unwrap_or(f64::MAX);
    ranked.sort_by(|a, b| {
        b.1.total_cmp(&a.1)
            .then_with(|| lex(&a.0).total_cmp(&lex(&b.0)))
            .then_with(|| a.0.cmp(&b.0))
    });
    ranked.truncate(limit as usize);

    // Bodies for whatever survived. The lexical half already has its text; only
    // the semantic-only winners need a read.
    let have: HashMap<&str, &ChunkHit> =
        lexical.iter().map(|h| (h.chunk_id.as_str(), h)).collect();
    let missing: Vec<String> = ranked
        .iter()
        .filter(|(id, _)| !have.contains_key(id.as_str()))
        .map(|(id, _)| id.clone())
        .collect();
    let fetched = st.with_db(|conn| crate::db::chunks_by_id(conn, &missing))?;
    let fetched_map: HashMap<&str, &ChunkHit> =
        fetched.iter().map(|h| (h.chunk_id.as_str(), h)).collect();

    // The reported score is the fused score normalised against the best hit, so
    // a relevance bar in the UI is comparable within one result set. It is not
    // comparable between queries and is not presented as if it were.
    let best = ranked.first().map(|(_, s)| *s).unwrap_or(1.0).max(f32::MIN_POSITIVE);

    let mut out = Vec::with_capacity(ranked.len());
    for (id, score) in ranked {
        let hit = have.get(id.as_str()).copied().or_else(|| fetched_map.get(id.as_str()).copied());
        if let Some(h) = hit {
            out.push(Retrieved {
                cite: citation_of(h, (score / best).clamp(0.0, 1.0)),
                text: h.text.clone(),
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod paths {
    use std::path::Path;

    /// A folder given with forward slashes must not produce mixed-separator paths.
    ///
    /// This is what made the same document appear twice: the panel showed
    /// `C:/plant/docs\sop.md` from the walk and `C:\plant\docs\sop.md` from the
    /// watcher, and `knowledge_source_by_path` compares strings.
    #[test]
    fn one_spelling_comes_back_whichever_way_the_folder_was_spelled() {
        let dir = std::env::temp_dir().join("sovereign-expand-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        std::fs::write(&file, "thickness").unwrap();

        let slashed = dir.to_string_lossy().replace(std::path::MAIN_SEPARATOR, "/");
        let found = super::expand(&[slashed.clone()]);
        std::fs::remove_file(&file).ok();

        assert_eq!(found.len(), 1, "walked {slashed} and found {found:?}");
        assert!(
            !found[0].contains('/'),
            "mixed separators survived: {}",
            found[0]
        );
        assert_eq!(found[0], super::canonical(Path::new(&file)));
    }

    /// An unreadable path still gets a usable string back rather than being dropped.
    #[test]
    fn a_path_that_does_not_exist_is_left_as_written() {
        let p = Path::new("C:/sovereign/no/such/file.md");
        assert_eq!(super::canonical(p), p.to_string_lossy());
    }
}
