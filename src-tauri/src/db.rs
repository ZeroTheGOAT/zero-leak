//! The local store. One SQLite file, `C:\sovereign\state\workbench.db`.
//!
//! Bundled SQLite, so nothing has to be preinstalled on a plant workstation,
//! and FTS5 is compiled in — verified on this build: SQLite 3.50.2, `bm25()`
//! available. That matters because §5 wants hybrid retrieval, and the lexical
//! half of a hybrid index is exactly what FTS5 is.
//!
//! Dense vectors live in `chunk_vectors.embedding` as raw little-endian f32
//! blobs and cosine similarity is computed in Rust. The alternative was the
//! sqlite-vec loadable extension: a C dependency that must be shipped, found at
//! runtime, and version-matched against the SQLite we bundle. At the scale this
//! index actually reaches — a plant document set, tens of thousands of chunks —
//! a linear scan over 1024-dimension vectors is a few milliseconds, so the
//! extension buys latency we do not need in exchange for a way to fail on
//! startup. Reliability first.
//!
//! Schema changes go through `MIGRATIONS`, keyed off `PRAGMA user_version`.
//! Nothing here drops a table.

use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{CoreError, CoreResult};
use crate::types::*;

pub fn state_dir() -> PathBuf {
    crate::registry::sovereign_root().join("state")
}

/* ------------------------------------------------------------------ */
/* Migrations                                                          */
/* ------------------------------------------------------------------ */

/// Applied in order; index + 1 is the resulting `user_version`. Append only.
const MIGRATIONS: &[&str] = &[
    // ---- 1: the whole initial schema -------------------------------
    r#"
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- §9. `approved` is the gate the tool layer reads before every path
    -- resolution. A row here is not permission; `approved = 1` is.
    CREATE TABLE workspaces (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        path          TEXT NOT NULL UNIQUE,
        approved      INTEGER NOT NULL DEFAULT 0,
        added_at      INTEGER NOT NULL,
        file_count    INTEGER,
        indexed_count INTEGER
    );

    -- §4. One row per ingested file. `sha256` is what makes re-ingestion
    -- detectable, so an unchanged file is never OCR'd twice.
    CREATE TABLE documents (
        id          TEXT PRIMARY KEY,
        path        TEXT NOT NULL,
        file_name   TEXT NOT NULL,
        kind        TEXT NOT NULL,
        page_count  INTEGER NOT NULL,
        extraction  TEXT NOT NULL,
        model_id    TEXT,
        entities    TEXT NOT NULL DEFAULT '[]',
        size_bytes  INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        ingested_at INTEGER NOT NULL,
        preview_uri TEXT
    );
    CREATE UNIQUE INDEX documents_sha ON documents(sha256, path);

    -- §4/§14. Every block keeps its page and its normalised box, because a
    -- citation without a location is not traceable.
    CREATE TABLE doc_blocks (
        id         TEXT PRIMARY KEY,
        doc_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal    INTEGER NOT NULL,
        kind       TEXT NOT NULL,
        text       TEXT NOT NULL,
        page       INTEGER NOT NULL,
        x          REAL NOT NULL,
        y          REAL NOT NULL,
        w          REAL NOT NULL,
        h          REAL NOT NULL,
        confidence REAL
    );
    CREATE INDEX doc_blocks_doc ON doc_blocks(doc_id, ordinal);

    CREATE TABLE doc_tables (
        id      TEXT PRIMARY KEY,
        doc_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        page    INTEGER NOT NULL,
        x       REAL NOT NULL,
        y       REAL NOT NULL,
        w       REAL NOT NULL,
        h       REAL NOT NULL,
        header  TEXT NOT NULL,
        rows    TEXT NOT NULL
    );
    CREATE INDEX doc_tables_doc ON doc_tables(doc_id, ordinal);

    -- §5. Indexed sources.
    CREATE TABLE knowledge_sources (
        id         TEXT PRIMARY KEY,
        path       TEXT NOT NULL UNIQUE,
        file_name  TEXT NOT NULL,
        kind       TEXT NOT NULL,
        chunks     INTEGER NOT NULL DEFAULT 0,
        size_bytes INTEGER NOT NULL,
        sha256     TEXT NOT NULL,
        status     TEXT NOT NULL,
        indexed_at INTEGER,
        error      TEXT
    );

    CREATE TABLE chunks (
        id        TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
        ordinal   INTEGER NOT NULL,
        text      TEXT NOT NULL,
        page      INTEGER,
        x REAL, y REAL, w REAL, h REAL
    );
    CREATE INDEX chunks_source ON chunks(source_id, ordinal);

    -- Little-endian f32, `dim` floats. Separate table so the lexical path
    -- never has to read vector blobs it will not use.
    CREATE TABLE chunk_vectors (
        chunk_id  TEXT PRIMARY KEY REFERENCES chunks(id) ON DELETE CASCADE,
        dim       INTEGER NOT NULL,
        norm      REAL NOT NULL,
        embedding BLOB NOT NULL
    );

    CREATE VIRTUAL TABLE chunks_fts USING fts5(
        text,
        content = 'chunks',
        content_rowid = 'rowid',
        tokenize = 'porter unicode61'
    );

    -- §10. `verified` is only ever set by reopening the file.
    CREATE TABLE artifacts (
        id                 TEXT PRIMARY KEY,
        path               TEXT NOT NULL,
        file_name          TEXT NOT NULL,
        kind               TEXT NOT NULL,
        size_bytes         INTEGER NOT NULL,
        created_at         INTEGER NOT NULL,
        source_task        TEXT NOT NULL,
        source_document_ids TEXT NOT NULL DEFAULT '[]',
        producing_model_id TEXT NOT NULL,
        tool_history       TEXT NOT NULL DEFAULT '[]',
        verified           INTEGER NOT NULL DEFAULT 0,
        verify_note        TEXT
    );

    -- §13. Append-only in practice: nothing in the core issues a DELETE or an
    -- UPDATE against this table. Every tool call lands here, allowed or denied.
    CREATE TABLE audit (
        id           TEXT PRIMARY KEY,
        tool         TEXT NOT NULL,
        args_summary TEXT NOT NULL,
        status       TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        duration_ms  INTEGER NOT NULL,
        workspace_id TEXT NOT NULL,
        run_id       TEXT,
        error        TEXT
    );
    CREATE INDEX audit_time ON audit(started_at DESC);

    -- §8.
    CREATE TABLE sandbox_runs (
        id         TEXT PRIMARY KEY,
        command    TEXT NOT NULL,
        cwd        TEXT NOT NULL,
        status     TEXT NOT NULL,
        exit_code  INTEGER,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER
    );
    CREATE INDEX sandbox_runs_time ON sandbox_runs(started_at DESC);

    CREATE TABLE sandbox_lines (
        run_id  TEXT NOT NULL REFERENCES sandbox_runs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        stream  TEXT NOT NULL,
        text    TEXT NOT NULL,
        at      INTEGER NOT NULL,
        PRIMARY KEY (run_id, ordinal)
    );

    -- §11. Byte counters survive restarts, so the figure in the status bar is
    -- a real total and not a per-session one.
    CREATE TABLE egress (
        id                      INTEGER PRIMARY KEY CHECK (id = 1),
        public_internet_bytes   INTEGER NOT NULL DEFAULT 0,
        private_server_bytes    INTEGER NOT NULL DEFAULT 0,
        device_requests         INTEGER NOT NULL DEFAULT 0,
        private_server_requests INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO egress (id) VALUES (1);
    "#,
    // ---- 2: which conversation a tool call belongs to ---------------
    //
    // §13 records the run, and a run is one prompt. The question an auditor
    // actually asks is "what was the operator working on when this file was
    // written", and that is the session — the whole conversation the run sat in.
    // Nullable because rows written before this migration genuinely do not know,
    // and backfilling them with a guess would put invented data in the one table
    // that has to be defensible.
    r#"
    ALTER TABLE audit ADD COLUMN session_id TEXT;
    CREATE INDEX audit_session ON audit(session_id, started_at DESC);
    "#,
    // ---- 3: which pipeline produced a stored extraction --------------
    //
    // §4 skips OCR when the file hash is unchanged, which is right for an
    // unchanged file and wrong for a changed pipeline. A prompt fix that stopped
    // a drawing coming back with an invented thickness reading in it changed
    // nothing for the drawing already stored: the hash still matched, so the bad
    // record was handed back to the operator who re-ingested the file to be rid
    // of it. A record is only worth reusing if what produced it is what is
    // running now. Nullable, and a NULL never matches, so every row written
    // before this is extracted again the next time its file is ingested.
    r#"
    ALTER TABLE documents ADD COLUMN pipeline TEXT;
    "#,
    // ---- 4: the conversation ----------------------------------------
    //
    // §6 kept the transcript in the UI and nowhere else, which cost two things.
    // A reload lost the conversation. And the model was handed one message per
    // turn — every question answered as if it were the first, so "and the one
    // before that?" had nothing to refer to. Both are the same missing table.
    //
    // `workspace_id` is deliberately not a foreign key: removing a folder from
    // the workbench must not delete the record of what was discussed in it.
    r#"
    CREATE TABLE sessions (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT,
        title        TEXT NOT NULL,
        mode         TEXT NOT NULL,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
    );
    CREATE INDEX sessions_recent ON sessions(updated_at DESC);

    -- `extra` is display detail the core writes and never reads back for its
    -- own purposes: which model answered, how long it took, what it cited.
    CREATE TABLE session_messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal    INTEGER NOT NULL,
        sender     TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        extra      TEXT
    );
    CREATE INDEX session_messages_session ON session_messages(session_id, ordinal);
    "#,
    // ---- 5: Codex-style harness scopes ------------------------------
    //
    // Chats choose memory use and contribution independently. Memories are
    // either global or tied to one workspace. Artifact rows gain the project
    // and chat that produced them; older rows keep NULL because guessing would
    // falsify provenance.
    r#"
    ALTER TABLE sessions ADD COLUMN use_memories INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE sessions ADD COLUMN contribute_memories INTEGER NOT NULL DEFAULT 1;

    ALTER TABLE artifacts ADD COLUMN workspace_id TEXT;
    ALTER TABLE artifacts ADD COLUMN session_id TEXT;
    CREATE INDEX artifacts_workspace ON artifacts(workspace_id, created_at DESC);
    CREATE INDEX artifacts_session ON artifacts(session_id, created_at DESC);

    CREATE TABLE memories (
        id                TEXT PRIMARY KEY,
        scope             TEXT NOT NULL CHECK (scope IN ('global', 'project')),
        workspace_id      TEXT,
        title             TEXT NOT NULL,
        content           TEXT NOT NULL,
        kind              TEXT NOT NULL,
        source_session_id TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL,
        CHECK (
            (scope = 'global' AND workspace_id IS NULL) OR
            (scope = 'project' AND workspace_id IS NOT NULL)
        )
    );
    CREATE INDEX memories_context ON memories(scope, workspace_id, enabled, updated_at DESC);
    CREATE INDEX memories_source ON memories(source_session_id);
    "#,
    // ---- 6: staged memory writing ----------------------------------
    //
    // One row is the inspectable Phase-1 result for one chat. The small
    // `memories` rows above remain the consolidated, prompt-ready layer. This
    // separation mirrors the local harness contract: immutable transcripts are
    // evidence, per-chat summaries preserve provenance, and only consolidated
    // high-signal memory is injected into later chats.
    r#"
    CREATE TABLE memory_rollouts (
        session_id        TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        workspace_id      TEXT,
        source_updated_at INTEGER NOT NULL,
        raw_memory        TEXT NOT NULL,
        rollout_summary   TEXT NOT NULL,
        rollout_slug      TEXT NOT NULL,
        generated_at      INTEGER NOT NULL
    );
    CREATE INDEX memory_rollouts_scope
        ON memory_rollouts(workspace_id, source_updated_at DESC);
    "#,
    // ---- 7: project folders and project lifecycle -------------------
    //
    // A project can own up to five approved local roots. `workspaces.path`
    // remains the primary root so older file-tool code has one unambiguous cwd;
    // this table preserves the complete ordered set. Pin and archive are project
    // properties, not browser preferences, so they survive every client restart.
    r#"
    ALTER TABLE workspaces ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE workspaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

    CREATE TABLE workspace_folders (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        path         TEXT NOT NULL,
        position     INTEGER NOT NULL,
        is_primary   INTEGER NOT NULL DEFAULT 0,
        UNIQUE(workspace_id, path),
        UNIQUE(workspace_id, position)
    );
    CREATE UNIQUE INDEX workspace_one_primary
        ON workspace_folders(workspace_id) WHERE is_primary = 1;
    INSERT INTO workspace_folders (id, workspace_id, path, position, is_primary)
        SELECT id || ':folder:0', id, path, 0, 1 FROM workspaces;

    -- `sessions.workspace_id` predates project lifecycle management and cannot
    -- be safely rebuilt in place without risking the existing message rows.
    -- This trigger gives project deletion the same database-enforced cascade.
    CREATE TRIGGER workspace_delete_sessions
        BEFORE DELETE ON workspaces
        BEGIN
            DELETE FROM sessions WHERE workspace_id = OLD.id;
        END;
    "#,
    // ---- 8: preview servers outlive the app process -----------------
    //
    // `serve_folder` hands the operator a URL and the chat transcript that
    // contains it is immutable — so the promise "it stays live" has to survive
    // an app restart, not just the run that made it. One row is one served
    // folder with the port its URL names; the core re-binds each row at
    // startup, preferring the stored port so old links point at the same
    // server again. A row deleted here (explicit Stop, folder gone) is a
    // preview that stays down.
    r#"
    CREATE TABLE previews (
        root         TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        rel          TEXT NOT NULL DEFAULT '.',
        port         INTEGER NOT NULL
    );
    CREATE INDEX previews_workspace ON previews(workspace_id);
    "#,
    // ---- 9: which operator account made each tool call ----------------
    //
    // §13 records one row per tool call, allowed or denied. The store is
    // single-operator by design, but an audit trail has to say *which* account,
    // and a row with no operator is a hole an auditor cannot defend — the
    // question "who approved this write" has no answer. Nullable because rows
    // written before this migration genuinely do not know, and backfilling
    // them with a guess would put invented data in the one table that has to
    // be defensible.
    r#"
    ALTER TABLE audit ADD COLUMN operator TEXT;
    "#,
    // ---- 10: append-only log of replicated-store gate decisions ----------
    //
    // §11 refuses agent work when an app-owned store folder replicates off the
    // machine, and the operator's override exists to be audited, not hidden:
    // every refusal and every overridden start is one row here, named to the
    // operator who was at the keyboard. Append-only by construction — nothing
    // in the codebase updates or deletes these rows, because a record table
    // that can forget is not a record.
    r#"
    CREATE TABLE store_gate (
        id           TEXT PRIMARY KEY,
        at           INTEGER NOT NULL,
        operator     TEXT NOT NULL,
        session_id   TEXT,
        workspace_id TEXT,
        decision     TEXT NOT NULL CHECK (decision IN ('refused', 'overridden')),
        folders      TEXT NOT NULL,
        summary      TEXT NOT NULL
    );
    CREATE INDEX store_gate_time ON store_gate(at DESC);
    "#,
];

/* ------------------------------------------------------------------ */
/* Open                                                               */
/* ------------------------------------------------------------------ */

/// Opens (creating if needed) and migrates the store.
///
/// WAL, because the knowledge indexer writes while the UI reads and rollback
/// journal mode would make those block each other. `foreign_keys` on, so the
/// `ON DELETE CASCADE` above is real rather than decorative.
pub fn open(dir: &Path) -> CoreResult<Connection> {
    std::fs::create_dir_all(dir)?;
    let conn = Connection::open(dir.join("workbench.db"))?;

    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.busy_handler(Some(|attempts: i32| attempts < 200))?;

    migrate(&conn)?;

    // A column added to an already-released migration's DDL cannot reach a
    // store that has passed that version. Repaired separately, and only when
    // the column really is missing — see `repair_drifted_columns`. Not fatal:
    // a store that cannot be repaired still opens, it just keeps whatever
    // feature the column serves broken, which is what it was doing anyway.
    if let Err(e) = repair_drifted_columns(&conn) {
        eprintln!("[db] A schema repair could not run: {e}");
    }

    // A crash, a power loss or a kill that beat the shutdown handler can leave a
    // run marked `running`. Nothing is executing at the moment the store opens,
    // so any such row is a leftover, and leaving it makes the Sandbox panel lie.
    match reap_orphan_sandbox_runs(&conn) {
        Ok(0) => {}
        Ok(n) => println!("[db] {n} sandbox run(s) were left marked running by a previous session; recorded as interrupted."),
        Err(e) => eprintln!("[db] Could not clear interrupted sandbox runs: {e}"),
    }

    Ok(conn)
}

/// Adds a column that a released migration's DDL grew after the fact.
///
/// `migrate` is version-keyed and append-only: editing an old migration's SQL
/// only reaches stores created after the edit, because one already at that
/// version skips it forever. `previews.rel` was added that way, so on every
/// store built before the edit each `upsert_preview` failed with "no such
/// column: rel" — silently, since the caller drops the result — and no served
/// folder was ever remembered across a restart. That is the bug where a URL
/// the agent handed over stopped answering after the app was closed.
///
/// Idempotent by construction: a table that already has the column, or does
/// not exist yet, is left alone. Safe to run on every open.
fn repair_drifted_columns(conn: &Connection) -> CoreResult<()> {
    /// (table, column, the statement that adds it)
    const REPAIRS: &[(&str, &str, &str)] = &[(
        "previews",
        "rel",
        "ALTER TABLE previews ADD COLUMN rel TEXT NOT NULL DEFAULT '.'",
    )];

    for (table, column, sql) in REPAIRS {
        if !has_table(conn, table)? || has_column(conn, table, column)? {
            continue;
        }
        conn.execute_batch(sql).map_err(|e| {
            CoreError::ExecutionFailed(format!("Could not add {table}.{column}: {e}"))
        })?;
        println!("[db] Added the missing {table}.{column} column.");
    }
    Ok(())
}

fn has_table(conn: &Connection, table: &str) -> CoreResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn has_column(conn: &Connection, table: &str, column: &str) -> CoreResult<bool> {
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM pragma_table_info(?1) WHERE lower(name) = lower(?2)",
        [table, column],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

fn migrate(conn: &Connection) -> CoreResult<()> {
    let current: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate() {
        let version = i as i64 + 1;
        if current >= version {
            continue;
        }
        conn.execute_batch(&format!("BEGIN; {sql} PRAGMA user_version = {version}; COMMIT;"))
            .map_err(|e| {
                CoreError::ExecutionFailed(format!("Migration {version} failed: {e}"))
            })?;
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTINGS_KEY: &str = "app_settings";

/// Stored as one JSON row and merged over the defaults on read, so a settings
/// file written by an older build gains new fields instead of failing to parse.
pub fn load_settings(conn: &Connection) -> CoreResult<AppSettings> {
    let stored: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![SETTINGS_KEY], |r| r.get(0))
        .optional()?;

    let defaults = serde_json::to_value(crate::registry::default_settings())?;
    let merged = match stored {
        Some(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) => merge(defaults, v),
            // A corrupt settings row must not stop the app from starting; the
            // defaults are always usable and the row is rewritten on next save.
            Err(_) => defaults,
        },
        None => defaults,
    };
    Ok(serde_json::from_value(merged)?)
}

pub fn save_settings(conn: &Connection, s: &AppSettings) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SETTINGS_KEY, serde_json::to_string(s)?],
    )?;
    Ok(())
}

/// Shallow object merge, `patch` winning. `settings_set` takes a partial from
/// the UI, and this is what makes it a patch rather than a replacement — 25
/// `Option` fields on `AppSettings` would be the alternative.
pub fn merge(base: serde_json::Value, patch: serde_json::Value) -> serde_json::Value {
    match (base, patch) {
        (serde_json::Value::Object(mut b), serde_json::Value::Object(p)) => {
            for (k, v) in p {
                if v.is_null() {
                    continue;
                }
                let merged = match b.remove(&k) {
                    Some(existing) if existing.is_object() && v.is_object() => merge(existing, v),
                    _ => v,
                };
                b.insert(k, merged);
            }
            serde_json::Value::Object(b)
        }
        (_, p) => p,
    }
}

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

pub fn workspaces(conn: &Connection) -> CoreResult<Vec<Workspace>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, path, approved, pinned, archived, added_at, file_count, indexed_count
         FROM workspaces ORDER BY pinned DESC, added_at ASC",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Workspace {
                id: r.get(0)?,
                name: r.get(1)?,
                path: r.get(2)?,
                folders: Vec::new(),
                approved: r.get::<_, i64>(3)? != 0,
                pinned: r.get::<_, i64>(4)? != 0,
                archived: r.get::<_, i64>(5)? != 0,
                added_at: r.get(6)?,
                file_count: r.get(7)?,
                indexed_count: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut rows = rows;
    let mut folder_stmt = conn.prepare(
        "SELECT id, path, is_primary FROM workspace_folders
         WHERE workspace_id = ?1 ORDER BY position ASC",
    )?;
    for workspace in &mut rows {
        workspace.folders = folder_stmt
            .query_map(params![workspace.id], |r| {
                Ok(WorkspaceFolder {
                    id: r.get(0)?,
                    path: r.get(1)?,
                    is_primary: r.get::<_, i64>(2)? != 0,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        // A partially migrated/corrupt row should remain usable and repairable.
        if workspace.folders.is_empty() {
            workspace.folders.push(WorkspaceFolder {
                id: format!("{}:folder:0", workspace.id),
                path: workspace.path.clone(),
                is_primary: true,
            });
        }
    }
    Ok(rows)
}

pub fn workspace(conn: &Connection, id: &str) -> CoreResult<Workspace> {
    workspaces(conn)?
        .into_iter()
        .find(|w| w.id == id)
        .ok_or_else(|| CoreError::Denied(format!("No workspace '{id}' is registered.")))
}

/// The boundary check every filesystem tool goes through.
pub fn approved_workspace(conn: &Connection, id: &str) -> CoreResult<Workspace> {
    let ws = workspace(conn, id)?;
    if !ws.approved {
        return Err(CoreError::Denied(format!(
            "{} has not been approved. Nothing is read, written or indexed there until it is.",
            ws.name
        )));
    }
    Ok(ws)
}

pub fn insert_workspace(conn: &Connection, w: &Workspace) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO workspaces (id, name, path, approved, pinned, archived, added_at, file_count, indexed_count)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name",
        params![w.id, w.name, w.path, w.approved as i64, w.pinned as i64, w.archived as i64,
                w.added_at, w.file_count, w.indexed_count],
    )?;
    // `ON CONFLICT(path)` can return an existing workspace. Do not attach the
    // new id's folders to a row that was not inserted.
    let stored_id: String = tx.query_row(
        "SELECT id FROM workspaces WHERE path = ?1",
        params![w.path],
        |r| r.get(0),
    )?;
    if stored_id == w.id {
        for (position, folder) in w.folders.iter().enumerate() {
            tx.execute(
                "INSERT OR REPLACE INTO workspace_folders
                 (id, workspace_id, path, position, is_primary) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![folder.id, w.id, folder.path, position as i64, folder.is_primary as i64],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

pub fn update_workspace(conn: &Connection, id: &str, update: &WorkspaceUpdate) -> CoreResult<Workspace> {
    let primary = update
        .folders
        .iter()
        .find(|folder| folder.is_primary)
        .ok_or_else(|| CoreError::ExecutionFailed("A project needs one primary folder.".into()))?;
    let tx = conn.unchecked_transaction()?;
    let changed = tx.execute(
        "UPDATE workspaces SET name = ?2, path = ?3, pinned = ?4, archived = ?5 WHERE id = ?1",
        params![id, update.name, primary.path, update.pinned as i64, update.archived as i64],
    )?;
    if changed == 0 {
        return Err(CoreError::Denied(format!("No workspace '{id}' is registered.")));
    }
    tx.execute("DELETE FROM workspace_folders WHERE workspace_id = ?1", params![id])?;
    for (position, folder) in update.folders.iter().enumerate() {
        tx.execute(
            "INSERT INTO workspace_folders (id, workspace_id, path, position, is_primary)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![folder.id, id, folder.path, position as i64, folder.is_primary as i64],
        )?;
    }
    tx.commit()?;
    workspace(conn, id)
}

pub fn set_workspace_approved(conn: &Connection, id: &str, approved: bool) -> CoreResult<()> {
    let n = conn.execute(
        "UPDATE workspaces SET approved = ?2 WHERE id = ?1",
        params![id, approved as i64],
    )?;
    if n == 0 {
        return Err(CoreError::Denied(format!("No workspace '{id}' is registered.")));
    }
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Previews                                                            */
/* ------------------------------------------------------------------ */

/// A preview binding the core will re-establish at startup: the folder being
/// served, the workspace it belongs to, the path label its `serve` command
/// names (so Restart re-serves the same folder), and the port its published
/// URL uses.
pub struct StoredPreview {
    pub root: String,
    pub workspace_id: String,
    pub rel: String,
    pub port: u16,
}

pub fn upsert_preview(
    conn: &Connection,
    root: &str,
    workspace_id: &str,
    rel: &str,
    port: u16,
) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO previews (root, workspace_id, rel, port) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(root) DO UPDATE SET workspace_id = ?2, rel = ?3, port = ?4",
        params![root, workspace_id, rel, port as i64],
    )?;
    Ok(())
}

pub fn previews(conn: &Connection) -> CoreResult<Vec<StoredPreview>> {
    let mut stmt = conn.prepare("SELECT root, workspace_id, rel, port FROM previews")?;
    let rows = stmt.query_map([], |r| {
        Ok(StoredPreview {
            root: r.get(0)?,
            workspace_id: r.get(1)?,
            rel: r.get(2)?,
            // A port outside u16 cannot be served; treat it as absent rather
            // than panicking on a hand-edited row.
            port: r.get::<_, i64>(3)?.clamp(1, u16::MAX as i64) as u16,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Forgets a preview so it does not come back at the next startup. Explicit
/// Stop and a vanished folder are the two callers.
pub fn delete_preview(conn: &Connection, root: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM previews WHERE root = ?1", params![root])?;
    Ok(())
}

/// Deletes one project and every attached chat except the explicitly retained
/// conversations, which become personal chats. The whole lifecycle change is a
/// transaction: a crash cannot detach half the requested chats and delete the rest.
pub fn delete_workspace_with_sessions(
    conn: &Connection,
    id: &str,
    detach_session_ids: &[String],
) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspaces WHERE id = ?1)",
        params![id],
        |r| r.get(0),
    )?;
    if !exists {
        return Err(CoreError::Denied(format!("No workspace '{id}' is registered.")));
    }
    for session_id in detach_session_ids {
        let owner: Option<Option<String>> = tx
            .query_row(
                "SELECT workspace_id FROM sessions WHERE id = ?1",
                params![session_id],
                |r| r.get(0),
            )
            .optional()?;
        if matches!(owner, Some(ref workspace_id) if workspace_id.as_deref() != Some(id)) {
            return Err(CoreError::Denied(format!(
                "Chat '{session_id}' does not belong to this project, so nothing was deleted."
            )));
        }
        // An empty chat exists only in React until its first turn. Treating its
        // absent row as detachable keeps project deletion idempotent.
        tx.execute(
            "UPDATE sessions SET workspace_id = NULL WHERE id = ?1 AND workspace_id = ?2",
            params![session_id, id],
        )?;
    }
    tx.execute(
        "DELETE FROM memories WHERE workspace_id = ?1 OR source_session_id IN
         (SELECT id FROM sessions WHERE workspace_id = ?1)",
        params![id],
    )?;
    tx.execute("DELETE FROM artifacts WHERE workspace_id = ?1", params![id])?;
    tx.execute("DELETE FROM sessions WHERE workspace_id = ?1", params![id])?;
    tx.execute("DELETE FROM workspaces WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* §4  Documents                                                       */
/* ------------------------------------------------------------------ */

/// Enum → the TEXT the column stores. These go through serde rather than a
/// hand-written match so the stored spelling is the same one the frontend sees
/// over the wire; a second mapping would be a second thing to keep in step.
fn enum_str<T: serde::Serialize>(v: T) -> CoreResult<String> {
    Ok(serde_json::to_value(v)?.as_str().unwrap_or_default().to_string())
}

fn enum_from<T: serde::de::DeserializeOwned>(raw: String, column: &str) -> CoreResult<T> {
    serde_json::from_value(serde_json::Value::String(raw.clone())).map_err(|e| {
        // A value the current build cannot parse means the store was written by
        // a different version. Saying which column and which value is the
        // difference between a fixable report and a mystery.
        CoreError::InvalidDocument(format!(
            "The store holds '{raw}' in documents.{column}, which this build does not recognise ({e}). \
             The row was not returned rather than guessing at its meaning."
        ))
    })
}

/// Writes a document and its blocks and tables as one transaction.
///
/// Atomic on purpose. A document row whose blocks are half-written looks
/// successfully ingested and reads back as a document with missing pages, which
/// is worse than a failed ingest: nothing prompts a retry. `INSERT OR REPLACE`
/// on the parent plus `ON DELETE CASCADE` clears the previous blocks, so
/// re-ingesting a changed file cannot leave the old ones behind.
pub fn insert_document(conn: &Connection, d: &IngestedDocument, pipeline: &str) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;

    // The unique index is (sha256, path), so a same-content-same-path re-ingest
    // replaces rather than duplicating. Deleting by id first covers the other
    // direction: the same path with new content keeps the caller's id.
    tx.execute("DELETE FROM documents WHERE id = ?1 OR path = ?2", params![d.id, d.path])?;
    tx.execute(
        "INSERT INTO documents
           (id, path, file_name, kind, page_count, extraction, model_id,
            entities, size_bytes, sha256, ingested_at, preview_uri, pipeline)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            d.id,
            d.path,
            d.file_name,
            enum_str(d.kind)?,
            d.page_count,
            enum_str(d.extraction)?,
            d.model_id,
            serde_json::to_string(&d.entities)?,
            d.size_bytes as i64,
            d.sha256,
            d.ingested_at,
            d.preview_uri,
            pipeline,
        ],
    )?;

    {
        let mut stmt = tx.prepare(
            "INSERT INTO doc_blocks (id, doc_id, ordinal, kind, text, page, x, y, w, h, confidence)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        )?;
        for (i, b) in d.blocks.iter().enumerate() {
            stmt.execute(params![
                b.id,
                d.id,
                i as i64,
                enum_str(b.kind)?,
                b.text,
                b.bbox.page,
                b.bbox.x,
                b.bbox.y,
                b.bbox.w,
                b.bbox.h,
                b.confidence,
            ])?;
        }
    }

    {
        let mut stmt = tx.prepare(
            "INSERT INTO doc_tables (id, doc_id, ordinal, page, x, y, w, h, header, rows)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        )?;
        for (i, t) in d.tables.iter().enumerate() {
            stmt.execute(params![
                t.id,
                d.id,
                i as i64,
                t.page,
                t.bbox.x,
                t.bbox.y,
                t.bbox.w,
                t.bbox.h,
                serde_json::to_string(&t.header)?,
                serde_json::to_string(&t.rows)?,
            ])?;
        }
    }

    tx.commit()?;
    Ok(())
}

fn blocks_of(conn: &Connection, doc_id: &str) -> CoreResult<Vec<DocBlock>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, text, page, x, y, w, h, confidence
         FROM doc_blocks WHERE doc_id = ?1 ORDER BY ordinal ASC",
    )?;
    let rows = stmt
        .query_map(params![doc_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, u32>(3)?,
                r.get::<_, f32>(4)?,
                r.get::<_, f32>(5)?,
                r.get::<_, f32>(6)?,
                r.get::<_, f32>(7)?,
                r.get::<_, Option<f32>>(8)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    rows.into_iter()
        .map(|(id, kind, text, page, x, y, w, h, confidence)| {
            Ok(DocBlock {
                id,
                kind: enum_from(kind, "doc_blocks.kind")?,
                text,
                bbox: BoundingBox { page, x, y, w, h },
                confidence,
            })
        })
        .collect()
}

fn tables_of(conn: &Connection, doc_id: &str) -> CoreResult<Vec<DocTable>> {
    let mut stmt = conn.prepare(
        "SELECT id, page, x, y, w, h, header, rows
         FROM doc_tables WHERE doc_id = ?1 ORDER BY ordinal ASC",
    )?;
    let rows = stmt
        .query_map(params![doc_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, f32>(2)?,
                r.get::<_, f32>(3)?,
                r.get::<_, f32>(4)?,
                r.get::<_, f32>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    rows.into_iter()
        .map(|(id, page, x, y, w, h, header, body)| {
            Ok(DocTable {
                id,
                page,
                bbox: BoundingBox { page, x, y, w, h },
                header: serde_json::from_str(&header)?,
                rows: serde_json::from_str(&body)?,
            })
        })
        .collect()
}

/// Reads the row without its blocks or tables.
///
/// The document list shows a file's name, kind and page count; loading every
/// OCR'd block for every document to render that list would read the whole
/// corpus to display a sidebar.
fn document_row(conn: &Connection, sql: &str, key: &str) -> CoreResult<Option<IngestedDocument>> {
    let mut stmt = conn.prepare(sql)?;
    let row = stmt
        .query_row(params![key], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, u32>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, String>(7)?,
                r.get::<_, i64>(8)?,
                r.get::<_, String>(9)?,
                r.get::<_, i64>(10)?,
                r.get::<_, Option<String>>(11)?,
            ))
        })
        .optional()?;

    let Some((id, path, file_name, kind, page_count, extraction, model_id, entities, size, sha, at, preview)) = row
    else {
        return Ok(None);
    };

    Ok(Some(IngestedDocument {
        id,
        path,
        file_name,
        kind: enum_from(kind, "documents.kind")?,
        page_count,
        extraction: enum_from(extraction, "documents.extraction")?,
        model_id,
        blocks: Vec::new(),
        tables: Vec::new(),
        entities: serde_json::from_str(&entities)?,
        size_bytes: size.max(0) as u64,
        sha256: sha,
        ingested_at: at,
        preview_uri: preview,
    }))
}

/* ------------------------------------------------------------------ */
/* The conversation                                                    */
/* ------------------------------------------------------------------ */

/// Creates the conversation if this is its first turn, and touches it if not.
///
/// The title is the first thing the operator typed, which is what the sidebar
/// shows; later turns leave it alone, so a conversation keeps the name it earned
/// rather than being renamed by whatever was asked last.
pub fn touch_session(
    conn: &Connection,
    id: &str,
    workspace_id: Option<&str>,
    mode: AgentMode,
    title: &str,
    at: i64,
) -> CoreResult<()> {
    let short: String = title.chars().take(60).collect();
    conn.execute(
        "INSERT INTO sessions (id, workspace_id, title, mode, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(id) DO UPDATE SET
             updated_at   = ?5,
             mode         = ?4,
             workspace_id = COALESCE(?2, workspace_id)",
        params![id, workspace_id, short.trim(), enum_str(mode)?, at],
    )?;
    Ok(())
}

/// Newest conversation first — the sidebar lists what was worked on last.
pub fn sessions(conn: &Connection) -> CoreResult<Vec<StoredSession>> {
    let mut stmt = conn.prepare(
        "SELECT id, workspace_id, title, mode, use_memories, contribute_memories,
                created_at, updated_at
         FROM sessions ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, workspace_id, title, mode, use_memories, contribute_memories, created_at, updated_at) = row?;
        out.push(StoredSession {
            id,
            workspace_id,
            title,
            mode: enum_from(mode, "sessions.mode")?,
            use_memories: use_memories != 0,
            contribute_memories: contribute_memories != 0,
            created_at,
            updated_at,
        });
    }
    Ok(out)
}

pub fn session(conn: &Connection, id: &str) -> CoreResult<StoredSession> {
    let row = conn
        .query_row(
            "SELECT id, workspace_id, title, mode, use_memories, contribute_memories,
                    created_at, updated_at
             FROM sessions WHERE id = ?1",
            params![id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, i64>(6)?,
                    r.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoreError::ExecutionFailed(format!("No chat '{id}' is on record.")))?;
    Ok(StoredSession {
        id: row.0,
        workspace_id: row.1,
        title: row.2,
        mode: enum_from(row.3, "sessions.mode")?,
        use_memories: row.4 != 0,
        contribute_memories: row.5 != 0,
        created_at: row.6,
        updated_at: row.7,
    })
}

pub fn set_session_memory(
    conn: &Connection,
    id: &str,
    use_memories: bool,
    contribute_memories: bool,
) -> CoreResult<()> {
    let changed = conn.execute(
        "UPDATE sessions SET use_memories = ?2, contribute_memories = ?3 WHERE id = ?1",
        params![id, use_memories as i64, contribute_memories as i64],
    )?;
    if changed == 0 {
        return Err(CoreError::ExecutionFailed(
            "Send the first message before changing this chat's memory controls.".into(),
        ));
    }
    Ok(())
}

/// Appends a turn and returns it, numbered after whatever is already there.
pub fn add_message(
    conn: &Connection,
    session_id: &str,
    sender: &str,
    content: &str,
    extra: &MessageExtra,
    at: i64,
) -> CoreResult<StoredMessage> {
    let ordinal: i64 = conn.query_row(
        "SELECT COALESCE(MAX(ordinal), -1) + 1 FROM session_messages WHERE session_id = ?1",
        params![session_id],
        |r| r.get(0),
    )?;
    let id = crate::state::new_id("msg");
    let json = serde_json::to_string(extra)?;
    conn.execute(
        "INSERT INTO session_messages (id, session_id, ordinal, sender, content, created_at, extra)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![id, session_id, ordinal, sender, content, at, json],
    )?;
    Ok(StoredMessage {
        id,
        sender: sender.to_string(),
        content: content.to_string(),
        created_at: at,
        extra: extra.clone(),
    })
}

/// One conversation in the order it happened.
///
/// `limit` counts back from the end, because the turns that matter to the next
/// answer are the most recent ones; the result is still oldest-first, which is
/// both how it is read on screen and the order a model expects.
pub fn session_messages(
    conn: &Connection,
    session_id: &str,
    limit: usize,
) -> CoreResult<Vec<StoredMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, sender, content, created_at, extra
         FROM session_messages WHERE session_id = ?1
         ORDER BY ordinal DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![session_id, limit as i64], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, Option<String>>(4)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (id, sender, content, created_at, extra) = row?;
        out.push(StoredMessage {
            id,
            sender,
            content,
            created_at,
            // Display detail only. A blob this build cannot parse loses the
            // model name off one bubble; dropping the turn would lose the
            // conversation, so it is defaulted rather than refused.
            extra: extra
                .and_then(|j| serde_json::from_str(&j).ok())
                .unwrap_or_default(),
        });
    }
    out.reverse();
    Ok(out)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectSessionMessage {
    pub session_id: String,
    pub session_title: String,
    pub sender: String,
    pub content: String,
    pub created_at: i64,
}

/// Candidate history for cross-chat project recall. The workspace predicate is
/// deliberately mandatory and exact: there is no global fallback and no row
/// from a sibling workspace can enter this result.
pub fn project_session_messages(
    conn: &Connection,
    workspace_id: &str,
    exclude_session_id: &str,
    limit: usize,
) -> CoreResult<Vec<ProjectSessionMessage>> {
    let mut stmt = conn.prepare(
        "SELECT m.session_id, s.title, m.sender, m.content, m.created_at
         FROM session_messages AS m
         JOIN sessions AS s ON s.id = m.session_id
         WHERE s.workspace_id = ?1 AND s.id <> ?2
         ORDER BY m.created_at DESC, m.ordinal DESC
         LIMIT ?3",
    )?;
    let rows = stmt
        .query_map(params![workspace_id, exclude_session_id, limit as i64], |row| {
            Ok(ProjectSessionMessage {
                session_id: row.get(0)?,
                session_title: row.get(1)?,
                sender: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Removes a conversation and its turns. `ON DELETE CASCADE` takes the messages.
pub fn delete_session(conn: &Connection, id: &str) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM memories WHERE source_session_id = ?1", params![id])?;
    tx.execute("DELETE FROM artifacts WHERE session_id = ?1", params![id])?;
    tx.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryRollout {
    pub session_id: String,
    pub workspace_id: Option<String>,
    pub source_updated_at: i64,
    pub raw_memory: String,
    pub rollout_summary: String,
    pub rollout_slug: String,
    pub generated_at: i64,
}

/// Store the latest Phase-1 memory extraction for a chat. A chat is updated in
/// place as it grows, while its session id keeps the evidence traceable.
pub fn upsert_memory_rollout(conn: &Connection, row: &MemoryRollout) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO memory_rollouts (
             session_id, workspace_id, source_updated_at, raw_memory,
             rollout_summary, rollout_slug, generated_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(session_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             source_updated_at = excluded.source_updated_at,
             raw_memory = excluded.raw_memory,
             rollout_summary = excluded.rollout_summary,
             rollout_slug = excluded.rollout_slug,
             generated_at = excluded.generated_at",
        params![
            row.session_id,
            row.workspace_id,
            row.source_updated_at,
            row.raw_memory,
            row.rollout_summary,
            row.rollout_slug,
            row.generated_at,
        ],
    )?;
    Ok(())
}

/// Phase-2 inputs are scope-exact. Project consolidation never reads another
/// project or the global personal stream, and global consolidation never reads
/// project rollouts.
pub fn memory_rollouts_by_scope(
    conn: &Connection,
    workspace_id: Option<&str>,
) -> CoreResult<Vec<MemoryRollout>> {
    let mut stmt = conn.prepare(
        "SELECT session_id, workspace_id, source_updated_at, raw_memory,
                rollout_summary, rollout_slug, generated_at
         FROM memory_rollouts
         WHERE (workspace_id IS NULL AND ?1 IS NULL) OR workspace_id = ?1
         ORDER BY source_updated_at DESC, session_id DESC",
    )?;
    let rows = stmt
        .query_map(params![workspace_id], |row| {
            Ok(MemoryRollout {
                session_id: row.get(0)?,
                workspace_id: row.get(1)?,
                source_updated_at: row.get(2)?,
                raw_memory: row.get(3)?,
                rollout_summary: row.get(4)?,
                rollout_slug: row.get(5)?,
                generated_at: row.get(6)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/* ------------------------------------------------------------------ */
/* Harness memories                                                    */
/* ------------------------------------------------------------------ */

const MEMORY_COLUMNS: &str = "id, scope, workspace_id, title, content, kind, \
    source_session_id, enabled, created_at, updated_at";

fn memory_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<(MemoryEntry, String, String)> {
    let scope: String = row.get(1)?;
    let kind: String = row.get(5)?;
    Ok((
        MemoryEntry {
            id: row.get(0)?,
            scope: MemoryScope::Global,
            workspace_id: row.get(2)?,
            title: row.get(3)?,
            content: row.get(4)?,
            kind: MemoryKind::Fact,
            source_session_id: row.get(6)?,
            enabled: row.get::<_, i64>(7)? != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
        },
        scope,
        kind,
    ))
}

fn parse_memory(
    mut memory: MemoryEntry,
    scope: String,
    kind: String,
) -> CoreResult<MemoryEntry> {
    memory.scope = enum_from(scope, "memories.scope")?;
    memory.kind = enum_from(kind, "memories.kind")?;
    Ok(memory)
}

pub fn insert_memory(conn: &Connection, memory: &MemoryEntry) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO memories (id, scope, workspace_id, title, content, kind,
             source_session_id, enabled, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            memory.id,
            enum_str(memory.scope)?,
            memory.workspace_id,
            memory.title,
            memory.content,
            enum_str(memory.kind)?,
            memory.source_session_id,
            memory.enabled as i64,
            memory.created_at,
            memory.updated_at,
        ],
    )?;
    Ok(())
}

pub fn memory(conn: &Connection, id: &str) -> CoreResult<MemoryEntry> {
    let sql = format!("SELECT {MEMORY_COLUMNS} FROM memories WHERE id = ?1");
    let (memory, scope, kind) = conn
        .query_row(&sql, params![id], memory_from_row)
        .optional()?
        .ok_or_else(|| CoreError::ExecutionFailed(format!("No memory '{id}' is on record.")))?;
    parse_memory(memory, scope, kind)
}

pub fn memory_by_content(
    conn: &Connection,
    scope: MemoryScope,
    workspace_id: Option<&str>,
    content: &str,
) -> CoreResult<Option<MemoryEntry>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memories
         WHERE scope = ?1
           AND ((workspace_id IS NULL AND ?2 IS NULL) OR workspace_id = ?2)
           AND lower(trim(content)) = lower(trim(?3))
         LIMIT 1"
    );
    let row = conn
        .query_row(
            &sql,
            params![enum_str(scope)?, workspace_id, content],
            memory_from_row,
        )
        .optional()?;
    row.map(|(memory, raw_scope, kind)| parse_memory(memory, raw_scope, kind))
        .transpose()
}

pub fn memory_by_title(
    conn: &Connection,
    scope: MemoryScope,
    workspace_id: Option<&str>,
    title: &str,
) -> CoreResult<Option<MemoryEntry>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memories
         WHERE scope = ?1
           AND ((workspace_id IS NULL AND ?2 IS NULL) OR workspace_id = ?2)
           AND lower(trim(title)) = lower(trim(?3))
         LIMIT 1"
    );
    let row = conn
        .query_row(
            &sql,
            params![enum_str(scope)?, workspace_id, title],
            memory_from_row,
        )
        .optional()?;
    row.map(|(memory, raw_scope, kind)| parse_memory(memory, raw_scope, kind))
        .transpose()
}

pub fn memories_for_context(
    conn: &Connection,
    workspace_id: Option<&str>,
    include_disabled: bool,
) -> CoreResult<Vec<MemoryEntry>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memories
         WHERE (scope = 'global' OR (scope = 'project' AND workspace_id = ?1))
           AND (?2 = 1 OR enabled = 1)
         ORDER BY CASE scope WHEN 'project' THEN 0 ELSE 1 END, updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![workspace_id, include_disabled as i64], memory_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(memory, scope, kind)| parse_memory(memory, scope, kind))
        .collect()
}

pub fn memories_by_scope(
    conn: &Connection,
    scope: MemoryScope,
    workspace_id: Option<&str>,
) -> CoreResult<Vec<MemoryEntry>> {
    let sql = format!(
        "SELECT {MEMORY_COLUMNS} FROM memories
         WHERE scope = ?1
           AND ((workspace_id IS NULL AND ?2 IS NULL) OR workspace_id = ?2)
         ORDER BY updated_at DESC"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![enum_str(scope)?, workspace_id], memory_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(memory, raw_scope, kind)| parse_memory(memory, raw_scope, kind))
        .collect()
}

pub fn update_memory(
    conn: &Connection,
    id: &str,
    patch: &MemoryPatch,
    at: i64,
) -> CoreResult<MemoryEntry> {
    let current = memory(conn, id)?;
    let title = patch
        .title
        .as_deref()
        .unwrap_or(&current.title)
        .trim()
        .chars()
        .take(120)
        .collect::<String>();
    let content = patch
        .content
        .as_deref()
        .unwrap_or(&current.content)
        .trim()
        .to_string();
    if title.is_empty() || content.is_empty() {
        return Err(CoreError::ExecutionFailed(
            "A memory needs both a title and content.".into(),
        ));
    }
    conn.execute(
        "UPDATE memories
         SET title = ?2, content = ?3, kind = ?4, enabled = ?5,
             source_session_id = ?6, updated_at = ?7
         WHERE id = ?1",
        params![
            id,
            title,
            content,
            enum_str(patch.kind.unwrap_or(current.kind))?,
            patch.enabled.unwrap_or(current.enabled) as i64,
            patch
                .source_session_id
                .as_deref()
                .or(current.source_session_id.as_deref()),
            at,
        ],
    )?;
    memory(conn, id)
}

pub fn delete_memory(conn: &Connection, id: &str) -> CoreResult<()> {
    let changed = conn.execute("DELETE FROM memories WHERE id = ?1", params![id])?;
    if changed == 0 {
        return Err(CoreError::ExecutionFailed(format!("No memory '{id}' is on record.")));
    }
    Ok(())
}

/// Forgets a document. Its blocks and tables go with it, by cascade.
///
/// Returns whether a row was actually there, so a second click on a document
/// somebody else already removed reads as "already gone" instead of an error.
pub fn delete_document(conn: &Connection, id: &str) -> CoreResult<bool> {
    Ok(conn.execute("DELETE FROM documents WHERE id = ?1", params![id])? > 0)
}

const DOC_COLUMNS: &str = "SELECT id, path, file_name, kind, page_count, extraction, model_id,
                                  entities, size_bytes, sha256, ingested_at, preview_uri
                           FROM documents";

/// One document, with everything that was extracted from it.
pub fn document(conn: &Connection, id: &str) -> CoreResult<IngestedDocument> {
    let sql = format!("{DOC_COLUMNS} WHERE id = ?1");
    let mut doc = document_row(conn, &sql, id)?.ok_or_else(|| {
        CoreError::InvalidDocument(format!(
            "No document '{id}' has been ingested in this session, so there was nothing to open."
        ))
    })?;
    doc.blocks = blocks_of(conn, &doc.id)?;
    doc.tables = tables_of(conn, &doc.id)?;
    Ok(doc)
}

/// Looks a file up by content and location, which is how re-ingestion is
/// avoided. Both have to match: the same bytes saved under a second name is a
/// second document as far as the operator is concerned, and the same path with
/// new bytes is a document that has to be read again.
pub fn document_by_sha_path(
    conn: &Connection,
    sha256: &str,
    path: &str,
    pipeline: &str,
) -> CoreResult<Option<IngestedDocument>> {
    let sql = format!("{DOC_COLUMNS} WHERE sha256 = ?1 AND path = ?2 AND pipeline = ?3");
    let mut stmt = conn.prepare(&sql)?;
    let found: Option<String> = stmt
        .query_row(params![sha256, path, pipeline], |r| r.get::<_, String>(0))
        .optional()?;
    match found {
        Some(id) => Ok(Some(document(conn, &id)?)),
        None => Ok(None),
    }
}

/// Newest first — the document panel shows what was just ingested at the top.
/// Blocks and tables are left empty here; see `document_row`.
pub fn documents(conn: &Connection) -> CoreResult<Vec<IngestedDocument>> {
    let sql = format!("{DOC_COLUMNS} ORDER BY ingested_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;

    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let one = format!("{DOC_COLUMNS} WHERE id = ?1");
        if let Some(d) = document_row(conn, &one, &id)? {
            out.push(d);
        }
    }
    Ok(out)
}

/* ------------------------------------------------------------------ */
/* §13  Audit                                                          */
/* ------------------------------------------------------------------ */

pub fn record_tool_call(
    conn: &Connection,
    rec: &ToolCallRecord,
    run_id: Option<&str>,
    session_id: Option<&str>,
) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO audit (id, tool, args_summary, status, started_at, duration_ms, workspace_id, run_id, session_id, operator, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            rec.id,
            serde_json::to_value(rec.tool)?.as_str().unwrap_or_default(),
            rec.args_summary,
            rec.status,
            rec.started_at,
            rec.duration_ms as i64,
            rec.workspace_id,
            run_id,
            session_id,
            rec.operator.as_deref(),
            rec.error,
        ],
    )?;
    Ok(())
}

pub fn audit_page(conn: &Connection, limit: u32, offset: u32) -> CoreResult<Vec<ToolCallRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, tool, args_summary, status, started_at, duration_ms, workspace_id, operator, error
         FROM audit ORDER BY started_at DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt
        .query_map(params![limit, offset], |r| {
            let tool_raw: String = r.get(1)?;
            Ok(ToolCallRecord {
                id: r.get(0)?,
                tool: serde_json::from_value(serde_json::Value::String(tool_raw))
                    .unwrap_or(ToolName::ReadFile),
                args_summary: r.get(2)?,
                status: r.get(3)?,
                started_at: r.get(4)?,
                duration_ms: r.get::<_, i64>(5)?.max(0) as u64,
                workspace_id: r.get(6)?,
                operator: r.get(7)?,
                error: r.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/* ------------------------------------------------------------------ */
/* §11  Store-gate decisions (append-only)                             */
/* ------------------------------------------------------------------ */

/// Records one §11 gate decision — a refusal, or an audited override — at the
/// start of an agent turn. Append-only: there is no update or delete path for
/// these rows anywhere in the codebase.
pub fn record_store_gate(conn: &Connection, rec: &StoreGateDecision) -> CoreResult<()> {
    let decision = match rec.decision {
        StoreGateDecisionKind::Refused => "refused",
        StoreGateDecisionKind::Overridden => "overridden",
    };
    conn.execute(
        "INSERT INTO store_gate (id, at, operator, session_id, workspace_id, decision, folders, summary)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            rec.id,
            rec.at,
            rec.operator,
            rec.session_id,
            rec.workspace_id,
            decision,
            serde_json::to_string(&rec.folders)?,
            rec.summary,
        ],
    )?;
    Ok(())
}

/// The gate history, newest first. Bounded like the audit log: the Sovereignty
/// panel is a working view, not the archive.
pub fn store_gate_page(conn: &Connection, limit: u32) -> CoreResult<Vec<StoreGateDecision>> {
    let mut stmt = conn.prepare(
        "SELECT id, at, operator, session_id, workspace_id, decision, folders, summary
         FROM store_gate ORDER BY at DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |r| {
            let decision: String = r.get(5)?;
            let folders_raw: String = r.get(6)?;
            Ok(StoreGateDecision {
                id: r.get(0)?,
                at: r.get(1)?,
                operator: r.get(2)?,
                session_id: r.get(3)?,
                workspace_id: r.get(4)?,
                decision: match decision.as_str() {
                    "overridden" => StoreGateDecisionKind::Overridden,
                    _ => StoreGateDecisionKind::Refused,
                },
                folders: serde_json::from_str(&folders_raw).unwrap_or_default(),
                summary: r.get(7)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/* ------------------------------------------------------------------ */
/* §11  Egress counters                                                */
/* ------------------------------------------------------------------ */

/// Bumped on every request the core makes. `public` is separate from `private`
/// because claiming zero network traffic while talking to a LAN server would be
/// a lie, and the brief says so explicitly.
pub fn add_egress(
    conn: &Connection,
    public_bytes: u64,
    private_bytes: u64,
    device_requests: u64,
    private_requests: u64,
) -> CoreResult<()> {
    conn.execute(
        "UPDATE egress SET
            public_internet_bytes   = public_internet_bytes   + ?1,
            private_server_bytes    = private_server_bytes    + ?2,
            device_requests         = device_requests         + ?3,
            private_server_requests = private_server_requests + ?4
         WHERE id = 1",
        params![public_bytes as i64, private_bytes as i64, device_requests as i64, private_requests as i64],
    )?;
    Ok(())
}

pub fn egress(conn: &Connection) -> CoreResult<(u64, u64, u64, u64)> {
    let row = conn.query_row(
        "SELECT public_internet_bytes, private_server_bytes, device_requests, private_server_requests
         FROM egress WHERE id = 1",
        [],
        |r| {
            Ok((
                r.get::<_, i64>(0)?.max(0) as u64,
                r.get::<_, i64>(1)?.max(0) as u64,
                r.get::<_, i64>(2)?.max(0) as u64,
                r.get::<_, i64>(3)?.max(0) as u64,
            ))
        },
    )?;
    Ok(row)
}

/* ------------------------------------------------------------------ */
/* Vector helpers                                                      */
/* ------------------------------------------------------------------ */

pub fn encode_vector(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}

pub fn decode_vector(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

pub fn l2_norm(v: &[f32]) -> f32 {
    v.iter().map(|x| x * x).sum::<f32>().sqrt()
}

/// Cosine similarity with both norms supplied, so the stored norm is read from
/// the row rather than recomputed on every comparison.
pub fn cosine(a: &[f32], a_norm: f32, b: &[f32], b_norm: f32) -> f32 {
    if a.len() != b.len() || a_norm == 0.0 || b_norm == 0.0 {
        return 0.0;
    }
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    dot / (a_norm * b_norm)
}

/* ------------------------------------------------------------------ */
/* §5  Knowledge sources and chunks                                    */
/* ------------------------------------------------------------------ */

fn source_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, String, String, u32, u64, String, String, Option<i64>, Option<String>)> {
    Ok((
        r.get(0)?,
        r.get(1)?,
        r.get(2)?,
        r.get(3)?,
        r.get::<_, i64>(4)? as u32,
        r.get::<_, i64>(5)? as u64,
        r.get(6)?,
        r.get(7)?,
        r.get(8)?,
        r.get(9)?,
    ))
}

const SOURCE_COLUMNS: &str = "SELECT id, path, file_name, kind, chunks, size_bytes, sha256, status, \
                              indexed_at, error FROM knowledge_sources";

fn to_source(
    raw: (String, String, String, String, u32, u64, String, String, Option<i64>, Option<String>),
) -> CoreResult<KnowledgeSource> {
    Ok(KnowledgeSource {
        id: raw.0,
        path: raw.1,
        file_name: raw.2,
        kind: enum_from(raw.3, "knowledge_sources.kind")?,
        chunks: raw.4,
        size_bytes: raw.5,
        sha256: raw.6,
        status: enum_from(raw.7, "knowledge_sources.status")?,
        indexed_at: raw.8,
        error: raw.9,
    })
}

/// Newest-indexed first, with never-indexed rows ahead of them.
///
/// A queued or failed source is the one the operator is looking for when they
/// open the panel, so it sorts to the top rather than to wherever its timestamp
/// happens to put it.
pub fn knowledge_sources(conn: &Connection) -> CoreResult<Vec<KnowledgeSource>> {
    let sql = format!("{SOURCE_COLUMNS} ORDER BY indexed_at IS NOT NULL, indexed_at DESC, file_name");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], source_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter().map(to_source).collect()
}

pub fn knowledge_source(conn: &Connection, id: &str) -> CoreResult<KnowledgeSource> {
    let sql = format!("{SOURCE_COLUMNS} WHERE id = ?1");
    let raw = conn
        .prepare(&sql)?
        .query_row(params![id], source_from_row)
        .optional()?
        .ok_or_else(|| {
            CoreError::IndexFailed(format!("No indexed source '{id}' exists, so there was nothing to act on."))
        })?;
    to_source(raw)
}

pub fn knowledge_source_by_path(conn: &Connection, path: &str) -> CoreResult<Option<KnowledgeSource>> {
    let sql = format!("{SOURCE_COLUMNS} WHERE path = ?1");
    let raw = conn.prepare(&sql)?.query_row(params![path], source_from_row).optional()?;
    match raw {
        Some(r) => Ok(Some(to_source(r)?)),
        None => Ok(None),
    }
}

/// Inserts or updates a source row, keyed on its path.
///
/// Keyed on path rather than id because the same file re-indexed is the same
/// source: a second row for it would show the operator two entries for one
/// document and leave the old chunks orphaned in the index.
pub fn upsert_knowledge_source(conn: &Connection, s: &KnowledgeSource) -> CoreResult<()> {
    conn.execute(
        "INSERT INTO knowledge_sources
            (id, path, file_name, kind, chunks, size_bytes, sha256, status, indexed_at, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(path) DO UPDATE SET
            file_name = excluded.file_name,
            kind = excluded.kind,
            chunks = excluded.chunks,
            size_bytes = excluded.size_bytes,
            sha256 = excluded.sha256,
            status = excluded.status,
            indexed_at = excluded.indexed_at,
            error = excluded.error",
        params![
            s.id,
            s.path,
            s.file_name,
            enum_str(s.kind)?,
            s.chunks as i64,
            s.size_bytes as i64,
            s.sha256,
            enum_str(s.status)?,
            s.indexed_at,
            s.error,
        ],
    )?;
    Ok(())
}

/// Removes a source, its chunks, its vectors and its FTS rows.
///
/// `chunks_fts` is an external-content FTS5 table, so the `ON DELETE CASCADE`
/// on `chunks` does not reach it — an FTS5 external-content index has to be told
/// about every deletion explicitly, and one that is not becomes an index that
/// returns rowids for text that is no longer there. The delete command is issued
/// before the rows go, because it needs the old text to remove the right terms.
pub fn delete_knowledge_source(conn: &Connection, id: &str) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("SELECT rowid, text FROM chunks WHERE source_id = ?1")?;
        let doomed = stmt
            .query_map(params![id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        for (rowid, text) in doomed {
            tx.execute(
                "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?1, ?2)",
                params![rowid, text],
            )?;
        }
    }
    tx.execute("DELETE FROM chunks WHERE source_id = ?1", params![id])?;
    tx.execute("DELETE FROM knowledge_sources WHERE id = ?1", params![id])?;
    tx.commit()?;
    Ok(())
}

/// One indexable passage: its text, and where in the document it came from.
pub struct ChunkRow {
    pub id: String,
    pub ordinal: u32,
    pub text: String,
    pub page: Option<u32>,
    pub bbox: Option<BoundingBox>,
    /// `None` when the embedding model was unreachable — the chunk is still
    /// inserted so lexical search finds it.
    pub embedding: Option<Vec<f32>>,
}

/// Replaces a source's chunks in one transaction.
///
/// Replace rather than append: re-indexing a changed file must not leave the
/// previous version's passages in the index, or a question gets answered from a
/// paragraph that was deleted from the document weeks ago.
pub fn replace_chunks(conn: &Connection, source_id: &str, chunks: &[ChunkRow]) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare("SELECT rowid, text FROM chunks WHERE source_id = ?1")?;
        let doomed = stmt
            .query_map(params![source_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<Result<Vec<_>, _>>()?;
        for (rowid, text) in doomed {
            tx.execute(
                "INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', ?1, ?2)",
                params![rowid, text],
            )?;
        }
    }
    tx.execute("DELETE FROM chunks WHERE source_id = ?1", params![source_id])?;

    for c in chunks {
        let (page, x, y, w, h) = match &c.bbox {
            Some(b) => (Some(b.page as i64), Some(b.x), Some(b.y), Some(b.w), Some(b.h)),
            None => (c.page.map(|p| p as i64), None, None, None, None),
        };
        tx.execute(
            "INSERT INTO chunks (id, source_id, ordinal, text, page, x, y, w, h)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![c.id, source_id, c.ordinal as i64, c.text, page, x, y, w, h],
        )?;
        let rowid = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO chunks_fts(rowid, text) VALUES (?1, ?2)",
            params![rowid, c.text],
        )?;
        if let Some(v) = &c.embedding {
            tx.execute(
                "INSERT INTO chunk_vectors (chunk_id, dim, norm, embedding) VALUES (?1, ?2, ?3, ?4)",
                params![c.id, v.len() as i64, l2_norm(v), encode_vector(v)],
            )?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// A retrieved passage before scoring: enough to build a `Citation` from.
pub struct ChunkHit {
    pub chunk_id: String,
    pub source_id: String,
    pub path: String,
    pub file_name: String,
    pub text: String,
    pub page: Option<u32>,
    pub bbox: Option<BoundingBox>,
    /// FTS5 `bm25()` for the lexical path — lower is better, and negative.
    pub rank: f64,
}

fn hit_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<ChunkHit> {
    let page: Option<i64> = r.get(5)?;
    let x: Option<f32> = r.get(6)?;
    let y: Option<f32> = r.get(7)?;
    let w: Option<f32> = r.get(8)?;
    let h: Option<f32> = r.get(9)?;
    let bbox = match (page, x, y, w, h) {
        (Some(p), Some(x), Some(y), Some(w), Some(h)) => {
            Some(BoundingBox { page: p as u32, x, y, w, h })
        }
        _ => None,
    };
    Ok(ChunkHit {
        chunk_id: r.get(0)?,
        source_id: r.get(1)?,
        path: r.get(2)?,
        file_name: r.get(3)?,
        text: r.get(4)?,
        page: page.map(|p| p as u32),
        bbox,
        rank: r.get(10).unwrap_or(0.0),
    })
}

/// Lexical retrieval through FTS5, ranked by BM25.
///
/// The query is passed as a bound parameter to a `MATCH`, so FTS5 parses it as a
/// query string and never as SQL. It is still sanitised by the caller, because
/// FTS5's own syntax will reject an unbalanced quote with an error rather than
/// treating it as a word.
pub fn fts_search(conn: &Connection, query: &str, limit: u32) -> CoreResult<Vec<ChunkHit>> {
    let mut stmt = conn.prepare(
        "SELECT c.id, c.source_id, s.path, s.file_name, c.text, c.page, c.x, c.y, c.w, c.h,
                bm25(chunks_fts)
         FROM chunks_fts
         JOIN chunks c ON c.rowid = chunks_fts.rowid
         JOIN knowledge_sources s ON s.id = c.source_id
         WHERE chunks_fts MATCH ?1
         ORDER BY bm25(chunks_fts)
         LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![query, limit as i64], hit_from_row)?;
    // A malformed FTS query is the user's words, not a fault: it comes back as
    // no lexical hits and the semantic path still answers.
    match rows.collect::<Result<Vec<_>, _>>() {
        Ok(v) => Ok(v),
        Err(_) => Ok(Vec::new()),
    }
}

/// Every stored vector, with the chunk it belongs to.
///
/// A full scan, deliberately. The alternative is a vector index (HNSW, IVF),
/// which means another native dependency and a second copy of the data to keep
/// in sync; at the scale this actually runs — a plant document set, tens of
/// thousands of chunks — a scan over 1024-float vectors is a few milliseconds of
/// arithmetic, and correctness needs no tuning parameters.
pub fn all_vectors(conn: &Connection) -> CoreResult<Vec<(String, f32, Vec<f32>)>> {
    let mut stmt = conn.prepare("SELECT chunk_id, norm, embedding FROM chunk_vectors")?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, f32>(1)?,
                decode_vector(&r.get::<_, Vec<u8>>(2)?),
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// The named chunks, in no particular order, with their source metadata.
pub fn chunks_by_id(conn: &Connection, ids: &[String]) -> CoreResult<Vec<ChunkHit>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    // Built from a placeholder count, never from the values: the ids come from
    // the vector table, but a query assembled by interpolating values is the
    // wrong habit to have anywhere in this file.
    let placeholders = std::iter::repeat("?").take(ids.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT c.id, c.source_id, s.path, s.file_name, c.text, c.page, c.x, c.y, c.w, c.h, 0.0
         FROM chunks c
         JOIN knowledge_sources s ON s.id = c.source_id
         WHERE c.id IN ({placeholders})"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(ids.iter()), hit_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// Index totals: sources, chunks, stored vector bytes, and when it last changed.
pub fn knowledge_totals(conn: &Connection) -> CoreResult<(u32, u32, u64, Option<i64>, u32)> {
    let documents: i64 = conn.query_row(
        "SELECT COUNT(*) FROM knowledge_sources WHERE status = 'indexed'",
        [],
        |r| r.get(0),
    )?;
    let chunks: i64 = conn.query_row("SELECT COUNT(*) FROM chunks", [], |r| r.get(0))?;
    let index_bytes: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(LENGTH(embedding)), 0) + COALESCE((SELECT SUM(LENGTH(text)) FROM chunks), 0)
             FROM chunk_vectors",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let last: Option<i64> =
        conn.query_row("SELECT MAX(indexed_at) FROM knowledge_sources", [], |r| r.get(0))?;
    let dim: i64 = conn
        .query_row("SELECT dim FROM chunk_vectors LIMIT 1", [], |r| r.get(0))
        .optional()?
        .unwrap_or(0);
    Ok((documents as u32, chunks as u32, index_bytes as u64, last, dim as u32))
}

/* ------------------------------------------------------------------ */
/* §10  Artifacts                                                      */
/* ------------------------------------------------------------------ */

fn artifact_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(Artifact, String)> {
    // `kind` comes back as the raw TEXT and is parsed by the caller, because
    // `enum_from` returns a `CoreError` and this closure may only return
    // `rusqlite::Error`. Threading the string out is less machinery than
    // inventing a conversion between the two error types for one column.
    let kind_raw: String = r.get(3)?;
    let art = Artifact {
        id: r.get(0)?,
        path: r.get(1)?,
        file_name: r.get(2)?,
        kind: ArtifactKind::Docx,
        size_bytes: r.get::<_, i64>(4)? as u64,
        created_at: r.get(5)?,
        source_task: r.get(6)?,
        source_document_ids: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or_default(),
        producing_model_id: r.get(8)?,
        tool_history: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
        verified: r.get::<_, i64>(10)? != 0,
        verify_note: r.get(11)?,
        workspace_id: r.get(12)?,
        session_id: r.get(13)?,
    };
    Ok((art, kind_raw))
}

const ARTIFACT_COLUMNS: &str = "id, path, file_name, kind, size_bytes, created_at, source_task, \
     source_document_ids, producing_model_id, tool_history, verified, verify_note, workspace_id, session_id";

/// Every artifact, newest first.
///
/// Unbounded on purpose, unlike `sandbox_runs`: an artifact is a file the
/// operator has on disk, and a panel that silently stopped listing the fiftieth
/// one would be hiding something that exists.
pub fn artifacts(conn: &Connection) -> CoreResult<Vec<Artifact>> {
    let sql = format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts ORDER BY created_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map([], artifact_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|(mut a, kind)| {
            a.kind = enum_from(kind, "artifacts.kind")?;
            Ok(a)
        })
        .collect()
}

pub fn artifact(conn: &Connection, id: &str) -> CoreResult<Artifact> {
    let sql = format!("SELECT {ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?1");
    let (mut a, kind) = conn
        .query_row(&sql, params![id], artifact_from_row)
        .optional()?
        .ok_or_else(|| {
            CoreError::ExecutionFailed(format!(
                "No artifact '{id}' is on record, so nothing was opened. It may have been \
                 produced by an earlier install of this application."
            ))
        })?;
    a.kind = enum_from(kind, "artifacts.kind")?;
    Ok(a)
}

/// Records a generated file.
///
/// Keyed on `path` as well as `id`: regenerating a report under the same name
/// overwrites the file on disk, and leaving the old row behind would show the
/// operator two entries for one file, one of them describing bytes that no
/// longer exist. The row is replaced, and `verified` resets to 0 because the new
/// bytes have not been reopened yet.
pub fn insert_artifact(conn: &Connection, a: &Artifact) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM artifacts WHERE path = ?1 AND id <> ?2", params![a.path, a.id])?;
    tx.execute(
        "INSERT INTO artifacts (id, path, file_name, kind, size_bytes, created_at, source_task,
             source_document_ids, producing_model_id, tool_history, verified, verify_note,
             workspace_id, session_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
         ON CONFLICT(id) DO UPDATE SET
            path = excluded.path,
            file_name = excluded.file_name,
            kind = excluded.kind,
            size_bytes = excluded.size_bytes,
            created_at = excluded.created_at,
            source_task = excluded.source_task,
            source_document_ids = excluded.source_document_ids,
            producing_model_id = excluded.producing_model_id,
            tool_history = excluded.tool_history,
            verified = excluded.verified,
            verify_note = excluded.verify_note,
            workspace_id = excluded.workspace_id,
            session_id = excluded.session_id",
        params![
            a.id,
            a.path,
            a.file_name,
            enum_str(a.kind)?,
            a.size_bytes as i64,
            a.created_at,
            a.source_task,
            serde_json::to_string(&a.source_document_ids)?,
            a.producing_model_id,
            serde_json::to_string(&a.tool_history)?,
            a.verified as i64,
            a.verify_note,
            a.workspace_id,
            a.session_id,
        ],
    )?;
    tx.commit()?;
    Ok(())
}

/// Records the outcome of reopening a file.
///
/// The note is stored whether the parse succeeded or failed, because "reopened
/// and read 3 sheets, 41 rows" and "reopened and the package has no
/// word/document.xml" are both things the operator should be able to read
/// without running the check again.
pub fn set_artifact_verified(
    conn: &Connection,
    id: &str,
    verified: bool,
    note: Option<&str>,
    size_bytes: u64,
) -> CoreResult<()> {
    let n = conn.execute(
        "UPDATE artifacts SET verified = ?2, verify_note = ?3, size_bytes = ?4 WHERE id = ?1",
        params![id, verified as i64, note, size_bytes as i64],
    )?;
    if n == 0 {
        return Err(CoreError::ExecutionFailed(format!(
            "No artifact '{id}' is on record, so the check result had nowhere to go."
        )));
    }
    Ok(())
}

/// The tools a run actually used, in the order it used them.
///
/// Read back out of the audit log rather than accumulated in memory, because the
/// audit log is the record that has to be defensible: a provenance line on an
/// artifact that disagrees with §13 would make both untrustworthy. Only
/// successful calls are listed — a denied `run_command` is part of the run's
/// history but not part of how the file came to exist.
pub fn run_tools(conn: &Connection, run_id: &str) -> CoreResult<Vec<ToolName>> {
    let mut stmt = conn.prepare(
        "SELECT tool, MIN(started_at) AS first_use
         FROM audit
         WHERE run_id = ?1 AND status = 'ok'
         GROUP BY tool ORDER BY first_use ASC",
    )?;
    let rows = stmt
        .query_map(params![run_id], |r| r.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    // A tool spelling this build does not know means the row was written by
    // another version. Skipped rather than defaulted to some arbitrary tool,
    // which would put a name in the provenance line that never ran.
    Ok(rows
        .into_iter()
        .filter_map(|raw| serde_json::from_value(serde_json::Value::String(raw)).ok())
        .collect())
}

/// Document ids for a set of absolute paths, in the order the paths were given.
///
/// Used to record which ingested documents a generated file drew on. Matching on
/// path rather than on content means a document re-ingested from the same
/// location resolves to its current row, which is the one the operator can open.
pub fn documents_at_paths(conn: &Connection, paths: &[String]) -> CoreResult<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT id FROM documents WHERE path = ?1 ORDER BY ingested_at DESC LIMIT 1")?;
    let mut out = Vec::new();
    for path in paths {
        if let Some(id) = stmt.query_row(params![path], |r| r.get::<_, String>(0)).optional()? {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    Ok(out)
}

/// Drops a row whose file is gone.
///
/// Called only when the file cannot be found on disk. The alternative — keeping
/// the row and marking it unverified — would leave a permanent entry the
/// operator can neither open nor clear.
pub fn delete_artifact(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("DELETE FROM artifacts WHERE id = ?1", params![id])?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* §8  Sandbox runs                                                    */
/* ------------------------------------------------------------------ */

/// Records a run at the moment it starts, before any output exists.
///
/// Written up front rather than at the end so that a run interrupted by a crash
/// or a power loss leaves a row saying what was attempted. An audit trail that
/// only contains the commands that finished cleanly is not an audit trail.
pub fn insert_sandbox_run(conn: &Connection, run: &SandboxRun) -> CoreResult<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO sandbox_runs (id, command, cwd, status, exit_code, started_at, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            exit_code = excluded.exit_code,
            duration_ms = excluded.duration_ms",
        params![
            run.id,
            run.command,
            run.cwd,
            run.status,
            run.exit_code,
            run.started_at,
            run.duration_ms.map(|d| d as i64),
        ],
    )?;
    for (i, line) in run.output.iter().enumerate() {
        tx.execute(
            "INSERT OR REPLACE INTO sandbox_lines (run_id, ordinal, stream, text, at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![run.id, i as i64, line.stream, line.text, line.at],
        )?;
    }
    tx.commit()?;
    Ok(())
}

/// Appends one output line.
///
/// `ordinal` is supplied by the caller rather than derived from a `COUNT`,
/// because two lines arriving in the same millisecond from stdout and stderr
/// must keep the order they were read in — and a count-based ordinal would give
/// them both the same number and lose one to the primary key.
pub fn append_sandbox_line(
    conn: &Connection,
    run_id: &str,
    ordinal: u32,
    line: &SandboxLine,
) -> CoreResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sandbox_lines (run_id, ordinal, stream, text, at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![run_id, ordinal as i64, line.stream, line.text, line.at],
    )?;
    Ok(())
}

/// Updates a run's terminal state. Output rows were written as they arrived, so
/// this only touches the status columns.
pub fn finish_sandbox_run(conn: &Connection, run: &SandboxRun) -> CoreResult<()> {
    conn.execute(
        "UPDATE sandbox_runs SET status = ?2, exit_code = ?3, duration_ms = ?4 WHERE id = ?1",
        params![run.id, run.status, run.exit_code, run.duration_ms.map(|d| d as i64)],
    )?;
    Ok(())
}

/// Marks a run as stopped without needing its `SandboxRun` in hand.
///
/// Called when the app shuts down with commands still live, and on startup for
/// anything a crash left behind. Without it a `running` row survives the process
/// that owned it, and the Sandbox panel shows a command that appears to still be
/// executing when its process died with the app — which also means its Stop
/// button can never succeed. Guarded on `status = 'running'` so it can never
/// rewrite the outcome of a command that actually finished.
pub fn mark_sandbox_stopped(conn: &Connection, run_id: &str, status: &str) -> CoreResult<()> {
    conn.execute(
        "UPDATE sandbox_runs SET status = ?2 WHERE id = ?1 AND status = 'running'",
        params![run_id, status],
    )?;
    Ok(())
}

/// Clears rows a previous process left marked `running`.
///
/// Returns how many, so startup can say so rather than silently rewriting
/// history. Nothing in this application can be executing a sandbox command at
/// the moment the store is opened, so every such row is a leftover.
pub fn reap_orphan_sandbox_runs(conn: &Connection) -> CoreResult<usize> {
    Ok(conn.execute(
        "UPDATE sandbox_runs SET status = 'interrupted' WHERE status = 'running'",
        [],
    )?)
}

/// Recent runs, newest first, with their output.
///
/// Bounded at 50 runs: the console is a working view, not the archive. The full
/// history including every command that was ever refused lives in the audit
/// tables and is read through `audit_page`.
pub fn sandbox_runs(conn: &Connection) -> CoreResult<Vec<SandboxRun>> {
    let mut stmt = conn.prepare(
        "SELECT id, command, cwd, status, exit_code, started_at, duration_ms
         FROM sandbox_runs ORDER BY started_at DESC LIMIT 50",
    )?;
    let mut runs = stmt
        .query_map([], |r| {
            Ok(SandboxRun {
                id: r.get(0)?,
                command: r.get(1)?,
                cwd: r.get(2)?,
                status: r.get(3)?,
                exit_code: r.get(4)?,
                started_at: r.get(5)?,
                duration_ms: r.get::<_, Option<i64>>(6)?.map(|d| d as u64),
                output: Vec::new(),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut lines = conn.prepare(
        "SELECT stream, text, at FROM sandbox_lines WHERE run_id = ?1 ORDER BY ordinal",
    )?;
    for run in &mut runs {
        run.output = lines
            .query_map(params![run.id], |r| {
                Ok(SandboxLine { stream: r.get(0)?, text: r.get(1)?, at: r.get(2)? })
            })?
            .collect::<Result<Vec<_>, _>>()?;
    }
    // Oldest first, so the console reads top-to-bottom like a terminal.
    runs.reverse();
    Ok(runs)
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

#[cfg(test)]
mod conversation {
    use super::*;

    /// The shipping schema, in memory.
    ///
    /// `migrate` is the same function the on-disk store runs, so what these
    /// tests exercise is the schema that ships rather than a copy of it — and
    /// `foreign_keys` is on for the same reason it is on in `open`, because
    /// whether deleting a conversation takes its turns with it depends on it.
    fn store() -> Connection {
        let conn = Connection::open_in_memory().expect("an in-memory store opens");
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&conn).expect("the migrations apply to an empty store");
        conn
    }

    fn say(conn: &Connection, id: &str, sender: &str, content: &str, at: i64) {
        add_message(conn, id, sender, content, &MessageExtra::default(), at)
            .expect("a turn is recorded");
    }

    #[test]
    fn a_conversation_comes_back_in_the_order_it_was_said() {
        let c = store();
        touch_session(&c, "s1", Some("ws1"), AgentMode::Plan, "what is the tag list", 100).unwrap();
        say(&c, "s1", "user", "what is the tag list", 100);
        say(&c, "s1", "agent", "PSV-1101 and four others.", 101);
        say(&c, "s1", "user", "and the first one?", 102);

        let turns = session_messages(&c, "s1", 40).unwrap();
        let said: Vec<&str> = turns.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(
            said,
            ["what is the tag list", "PSV-1101 and four others.", "and the first one?"],
            "a replayed conversation has to read forwards or the model is told the answer first"
        );
        assert_eq!(turns[1].sender, "agent");
    }

    #[test]
    fn project_history_search_never_crosses_workspace_or_current_chat() {
        let c = store();
        touch_session(&c, "alpha-old", Some("alpha"), AgentMode::Plan, "intro", 1).unwrap();
        touch_session(&c, "alpha-now", Some("alpha"), AgentMode::Plan, "question", 2).unwrap();
        touch_session(&c, "beta-old", Some("beta"), AgentMode::Plan, "private", 3).unwrap();
        say(&c, "alpha-old", "user", "My name is Hari.", 10);
        say(&c, "alpha-now", "user", "What is my name?", 11);
        say(&c, "beta-old", "user", "My name is not available to alpha.", 12);

        let rows = project_session_messages(&c, "alpha", "alpha-now", 20).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].session_id, "alpha-old");
        assert_eq!(rows[0].content, "My name is Hari.");
    }

    #[test]
    fn the_turns_that_are_kept_are_the_newest_ones() {
        let c = store();
        touch_session(&c, "s1", None, AgentMode::Plan, "first", 1).unwrap();
        for i in 0..10 {
            say(&c, "s1", "user", &format!("turn {i}"), 100 + i);
        }
        let turns = session_messages(&c, "s1", 3).unwrap();
        let said: Vec<&str> = turns.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(said, ["turn 7", "turn 8", "turn 9"], "the limit counts back from the end");
    }

    #[test]
    fn what_a_turn_carried_survives_the_round_trip() {
        let c = store();
        touch_session(&c, "s1", None, AgentMode::Plan, "read this", 1).unwrap();
        let extra = MessageExtra {
            model_id: Some("qwen3.5-9b".into()),
            elapsed_ms: Some(4200),
            attachments: vec!["C:/plant/PID-CDU4-1102.png".into()],
            ..Default::default()
        };
        add_message(&c, "s1", "user", "read this", &extra, 2).unwrap();

        let back = session_messages(&c, "s1", 40).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].extra.model_id.as_deref(), Some("qwen3.5-9b"));
        assert_eq!(back[0].extra.elapsed_ms, Some(4200));
        assert_eq!(back[0].extra.attachments, ["C:/plant/PID-CDU4-1102.png"]);
        assert!(
            back[0].extra.tokens_per_sec.is_none(),
            "an absent field must come back absent, not as a zero the UI would show"
        );
    }

    #[test]
    fn the_title_is_the_first_thing_asked_and_then_left_alone() {
        let c = store();
        touch_session(&c, "s1", None, AgentMode::Plan, "check the P&ID tag list", 100).unwrap();
        touch_session(&c, "s1", Some("ws1"), AgentMode::Agent, "and now something else", 200)
            .unwrap();

        let all = sessions(&c).unwrap();
        assert_eq!(all.len(), 1, "the same id is one conversation, not two");
        assert_eq!(all[0].title, "check the P&ID tag list");
        assert_eq!(all[0].created_at, 100);
        assert_eq!(all[0].updated_at, 200, "the list is ordered by this");
        assert_eq!(
            all[0].workspace_id.as_deref(),
            Some("ws1"),
            "a folder opened later attaches to the conversation already running"
        );
        assert!(matches!(all[0].mode, AgentMode::Agent), "the mode follows the latest turn");
    }

    #[test]
    fn a_long_first_line_is_shortened_for_the_sidebar() {
        let c = store();
        let long = "a".repeat(200);
        touch_session(&c, "s1", None, AgentMode::Plan, &long, 1).unwrap();
        assert_eq!(sessions(&c).unwrap()[0].title.chars().count(), 60);
    }

    #[test]
    fn newest_conversation_first() {
        let c = store();
        touch_session(&c, "old", None, AgentMode::Plan, "yesterday", 100).unwrap();
        touch_session(&c, "new", None, AgentMode::Plan, "today", 900).unwrap();
        let ids: Vec<String> = sessions(&c).unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["new", "old"]);
    }

    #[test]
    fn deleting_a_conversation_takes_its_turns_with_it() {
        let c = store();
        touch_session(&c, "s1", None, AgentMode::Plan, "one", 1).unwrap();
        touch_session(&c, "s2", None, AgentMode::Plan, "two", 2).unwrap();
        say(&c, "s1", "user", "one", 1);
        say(&c, "s2", "user", "two", 2);

        delete_session(&c, "s1").unwrap();
        assert_eq!(sessions(&c).unwrap().len(), 1);
        assert!(
            session_messages(&c, "s1", 40).unwrap().is_empty(),
            "turns left behind by a deleted conversation would be a record nobody can reach"
        );
        assert_eq!(
            session_messages(&c, "s2", 40).unwrap().len(),
            1,
            "and the conversation next to it is untouched"
        );
    }

    #[test]
    fn deleting_something_that_is_not_there_is_not_an_error() {
        let c = store();
        delete_session(&c, "never-existed").expect("a second click must not raise");
    }

    fn project(id: &str) -> Workspace {
        Workspace {
            id: id.into(),
            name: "Plant records".into(),
            path: r"C:\Plant\Records".into(),
            folders: vec![WorkspaceFolder {
                id: format!("{id}-primary"),
                path: r"C:\Plant\Records".into(),
                is_primary: true,
            }],
            approved: true,
            pinned: false,
            archived: false,
            added_at: 1,
            file_count: None,
            indexed_count: None,
        }
    }

    #[test]
    fn deleting_a_project_keeps_only_the_chats_explicitly_detached() {
        let c = store();
        insert_workspace(&c, &project("ws1")).unwrap();
        touch_session(&c, "keep", Some("ws1"), AgentMode::Plan, "keep me", 1).unwrap();
        touch_session(&c, "delete", Some("ws1"), AgentMode::Plan, "delete me", 2).unwrap();
        say(&c, "keep", "user", "needed", 1);
        say(&c, "delete", "user", "obsolete", 2);

        delete_workspace_with_sessions(&c, "ws1", &["keep".into()]).unwrap();

        assert!(workspaces(&c).unwrap().is_empty());
        let remaining = sessions(&c).unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, "keep");
        assert_eq!(remaining[0].workspace_id, None);
        assert_eq!(session_messages(&c, "keep", 40).unwrap().len(), 1);
        assert!(session_messages(&c, "delete", 40).unwrap().is_empty());
    }

    #[test]
    fn project_folder_roles_and_sidebar_state_round_trip() {
        let c = store();
        insert_workspace(&c, &project("ws1")).unwrap();
        update_workspace(
            &c,
            "ws1",
            &WorkspaceUpdate {
                name: "Renamed".into(),
                folders: vec![
                    WorkspaceFolder {
                        id: "secondary".into(),
                        path: r"C:\Plant\Records".into(),
                        is_primary: false,
                    },
                    WorkspaceFolder {
                        id: "primary".into(),
                        path: r"D:\Drawings".into(),
                        is_primary: true,
                    },
                ],
                pinned: true,
                archived: true,
            },
        )
        .unwrap();

        let saved = workspace(&c, "ws1").unwrap();
        assert_eq!(saved.name, "Renamed");
        assert_eq!(saved.path, r"D:\Drawings");
        assert!(saved.pinned && saved.archived);
        assert_eq!(saved.folders.len(), 2);
        assert!(saved.folders[1].is_primary);
    }

    #[test]
    fn a_turn_cannot_be_recorded_against_a_conversation_that_does_not_exist() {
        let c = store();
        assert!(
            add_message(&c, "ghost", "user", "hello", &MessageExtra::default(), 1).is_err(),
            "the foreign key is what keeps orphan turns out of the store"
        );
    }
}

#[cfg(test)]
mod audit_trail {
    use super::*;

    fn store() -> Connection {
        let conn = Connection::open_in_memory().expect("an in-memory store opens");
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&conn).expect("the migrations apply to an empty store");
        conn
    }

    #[test]
    fn the_operator_is_attributed_to_the_audit_row() {
        let c = store();
        let rec = ToolCallRecord {
            id: "tc_1".into(),
            tool: ToolName::ReadFile,
            args_summary: "read secret-1.pdf".into(),
            status: "ok".into(),
            started_at: 1000,
            duration_ms: 5,
            workspace_id: "ws1".into(),
            operator: Some("MRPL\\operator".into()),
            error: None,
        };
        record_tool_call(&c, &rec, Some("run_1"), Some("sess_1")).expect("the call is recorded");

        let page = audit_page(&c, 50, 0).expect("the page reads back");
        assert_eq!(page.len(), 1);
        let row = &page[0];
        assert_eq!(row.id, "tc_1");
        assert_eq!(row.operator.as_deref(), Some("MRPL\\operator"));
        assert_eq!(row.tool, ToolName::ReadFile);
    }

    #[test]
    fn a_row_written_before_attribution_has_a_null_operator() {
        let c = store();
        // Rows that predate the operator migration genuinely do not know who
        // ran them; backfilling a guess would invent data in the one table
        // that has to be defensible. They must round-trip as `None`, not as a
        // fabricated account.
        let rec = ToolCallRecord {
            id: "tc_old".into(),
            tool: ToolName::ReadFile,
            args_summary: "read legacy.pdf".into(),
            status: "ok".into(),
            started_at: 1,
            duration_ms: 5,
            workspace_id: "ws1".into(),
            operator: None,
            error: None,
        };
        record_tool_call(&c, &rec, None, None).expect("the call is recorded");

        let page = audit_page(&c, 50, 0).expect("the page reads back");
        assert_eq!(page[0].operator, None);
    }

    #[test]
    fn a_refusal_and_an_override_each_round_trip_newest_first() {
        let c = store();
        let refused = StoreGateDecision {
            id: "sg_1".into(),
            at: 10,
            operator: "MRPL\\operator".into(),
            session_id: Some("sess_1".into()),
            workspace_id: Some("ws1".into()),
            decision: StoreGateDecisionKind::Refused,
            folders: vec!["Models directory".into(), "Knowledge folder".into()],
            summary: "2 of 7 folders replicate off this machine.".into(),
        };
        let overridden = StoreGateDecision {
            id: "sg_2".into(),
            at: 20,
            operator: "MRPL\\operator".into(),
            session_id: None,
            workspace_id: None,
            decision: StoreGateDecisionKind::Overridden,
            folders: vec!["Models directory".into()],
            summary: "1 of 7 folders replicate off this machine.".into(),
        };
        record_store_gate(&c, &refused).expect("the refusal is recorded");
        record_store_gate(&c, &overridden).expect("the override is recorded");

        let page = store_gate_page(&c, 50).expect("the gate log reads back");
        assert_eq!(page.len(), 2);
        // Newest first, with the decision and the replicated folder labels intact.
        assert_eq!(page[0].id, "sg_2");
        assert_eq!(page[0].decision, StoreGateDecisionKind::Overridden);
        assert_eq!(page[1].id, "sg_1");
        assert_eq!(page[1].decision, StoreGateDecisionKind::Refused);
        assert_eq!(page[1].operator, "MRPL\\operator");
        assert_eq!(page[1].folders, vec!["Models directory", "Knowledge folder"]);
        assert_eq!(page[1].summary, "2 of 7 folders replicate off this machine.");
    }
}

#[cfg(test)]
mod harness_state {
    use super::*;

    fn store() -> Connection {
        let conn = Connection::open_in_memory().expect("an in-memory store opens");
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&conn).expect("the migrations apply to an empty store");
        conn
    }

    fn remembered(id: &str, scope: MemoryScope, workspace_id: Option<&str>) -> MemoryEntry {
        MemoryEntry {
            id: id.into(),
            scope,
            workspace_id: workspace_id.map(str::to_string),
            title: format!("memory {id}"),
            content: format!("content {id}"),
            kind: MemoryKind::Preference,
            source_session_id: None,
            enabled: true,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn project_memory_never_leaks_into_another_project() {
        let conn = store();
        insert_memory(&conn, &remembered("global", MemoryScope::Global, None)).unwrap();
        insert_memory(&conn, &remembered("alpha", MemoryScope::Project, Some("alpha"))).unwrap();
        insert_memory(&conn, &remembered("beta", MemoryScope::Project, Some("beta"))).unwrap();

        let alpha = memories_for_context(&conn, Some("alpha"), false).unwrap();
        let ids: Vec<&str> = alpha.iter().map(|m| m.id.as_str()).collect();
        assert!(ids.contains(&"global"), "global recall is shared");
        assert!(ids.contains(&"alpha"), "the selected project's recall is present");
        assert!(!ids.contains(&"beta"), "another project's recall is isolated");
    }

    #[test]
    fn staged_rollout_memory_is_upserted_and_scope_isolated() {
        let conn = store();
        touch_session(&conn, "alpha-chat", Some("alpha"), AgentMode::Plan, "alpha", 1)
            .unwrap();
        touch_session(&conn, "beta-chat", Some("beta"), AgentMode::Plan, "beta", 2)
            .unwrap();
        let mut alpha = MemoryRollout {
            session_id: "alpha-chat".into(),
            workspace_id: Some("alpha".into()),
            source_updated_at: 3,
            raw_memory: "alpha raw".into(),
            rollout_summary: "alpha summary".into(),
            rollout_slug: "alpha-purpose".into(),
            generated_at: 4,
        };
        let beta = MemoryRollout {
            session_id: "beta-chat".into(),
            workspace_id: Some("beta".into()),
            source_updated_at: 3,
            raw_memory: "beta raw".into(),
            rollout_summary: "beta summary".into(),
            rollout_slug: "beta-purpose".into(),
            generated_at: 4,
        };
        upsert_memory_rollout(&conn, &alpha).unwrap();
        upsert_memory_rollout(&conn, &beta).unwrap();

        let rows = memory_rollouts_by_scope(&conn, Some("alpha")).unwrap();
        assert_eq!(rows, vec![alpha.clone()]);

        alpha.raw_memory = "refined alpha raw".into();
        alpha.source_updated_at = 5;
        upsert_memory_rollout(&conn, &alpha).unwrap();
        assert_eq!(memory_rollouts_by_scope(&conn, Some("alpha")).unwrap(), vec![alpha]);

        delete_session(&conn, "alpha-chat").unwrap();
        assert!(memory_rollouts_by_scope(&conn, Some("alpha")).unwrap().is_empty());
        assert_eq!(memory_rollouts_by_scope(&conn, Some("beta")).unwrap(), vec![beta]);
    }

    #[test]
    fn a_semantic_memory_title_is_resolved_only_inside_its_scope() {
        let conn = store();
        let mut alpha = remembered("alpha-purpose", MemoryScope::Project, Some("alpha"));
        alpha.title = "Project purpose".into();
        let mut beta = remembered("beta-purpose", MemoryScope::Project, Some("beta"));
        beta.title = "Project purpose".into();
        insert_memory(&conn, &alpha).unwrap();
        insert_memory(&conn, &beta).unwrap();

        let found = memory_by_title(
            &conn,
            MemoryScope::Project,
            Some("alpha"),
            "project PURPOSE",
        )
        .unwrap()
        .expect("title lookup is case-insensitive");
        assert_eq!(found.id, "alpha-purpose");
    }

    #[test]
    fn disabled_memory_is_inspectable_but_not_injected() {
        let conn = store();
        let mut row = remembered("off", MemoryScope::Global, None);
        row.enabled = false;
        insert_memory(&conn, &row).unwrap();
        assert!(memories_for_context(&conn, None, false).unwrap().is_empty());
        assert_eq!(memories_for_context(&conn, None, true).unwrap().len(), 1);
    }

    #[test]
    fn chat_memory_controls_survive_a_restart() {
        let conn = store();
        touch_session(&conn, "s1", None, AgentMode::Plan, "hello", 1).unwrap();
        set_session_memory(&conn, "s1", false, true).unwrap();
        let row = session(&conn, "s1").unwrap();
        assert!(!row.use_memories);
        assert!(row.contribute_memories);
    }

    #[test]
    fn artifact_provenance_keeps_project_and_chat() {
        let conn = store();
        let row = Artifact {
            id: "artifact-1".into(),
            path: "C:/sovereign/artifacts/s1/report.md".into(),
            file_name: "report.md".into(),
            kind: ArtifactKind::Markdown,
            size_bytes: 12,
            created_at: 1,
            source_task: "run-1".into(),
            source_document_ids: Vec::new(),
            producing_model_id: "local".into(),
            tool_history: vec![ToolName::GenerateText],
            workspace_id: Some("ws-1".into()),
            session_id: Some("s1".into()),
            verified: false,
            verify_note: None,
        };
        insert_artifact(&conn, &row).unwrap();
        let back = artifact(&conn, "artifact-1").unwrap();
        assert_eq!(back.workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(back.session_id.as_deref(), Some("s1"));
    }
}

/// Removing an extraction.
///
/// The cascade is the whole point: the panel deletes one row, and the blocks and
/// tables that row indexes have to go with it or the store keeps text nobody can
/// reach and the disk never shrinks.
#[cfg(test)]
mod removal {
    use super::*;

    fn store() -> Connection {
        let conn = Connection::open_in_memory().expect("an in-memory store opens");
        conn.pragma_update(None, "foreign_keys", true).unwrap();
        migrate(&conn).expect("the migrations apply to an empty store");
        conn
    }

    fn scan(id: &str, path: &str) -> IngestedDocument {
        let bbox = BoundingBox { page: 1, x: 0.1, y: 0.1, w: 0.5, h: 0.1 };
        IngestedDocument {
            id: id.to_string(),
            path: path.to_string(),
            file_name: path.rsplit('/').next().unwrap_or(path).to_string(),
            kind: DocumentKind::PdfScanned,
            page_count: 1,
            extraction: ExtractionMethod::Ocr,
            model_id: Some("olmocr-2".into()),
            blocks: vec![DocBlock {
                id: format!("{id}-b1"),
                kind: BlockKind::Text,
                text: "UT thickness 11.8 mm".into(),
                bbox: bbox.clone(),
                confidence: Some(0.91),
            }],
            tables: vec![DocTable {
                id: format!("{id}-t1"),
                page: 1,
                bbox,
                header: vec!["Point".into(), "mm".into()],
                rows: vec![vec!["A1".into(), "11.8".into()]],
            }],
            entities: vec!["MEC-UT-11".into()],
            size_bytes: 4096,
            sha256: format!("{id}sha"),
            ingested_at: 1,
            preview_uri: None,
        }
    }

    fn counts(c: &Connection, id: &str) -> (i64, i64) {
        let b = c
            .query_row("SELECT COUNT(*) FROM doc_blocks WHERE doc_id = ?1", params![id], |r| r.get(0))
            .unwrap();
        let t = c
            .query_row("SELECT COUNT(*) FROM doc_tables WHERE doc_id = ?1", params![id], |r| r.get(0))
            .unwrap();
        (b, t)
    }

    #[test]
    fn removing_a_document_takes_its_blocks_and_tables_with_it() {
        let c = store();
        insert_document(&c, &scan("d1", "C:/plant/ut-a.png"), "p3").unwrap();
        assert_eq!(counts(&c, "d1"), (1, 1), "the extraction is stored before it is removed");

        assert!(delete_document(&c, "d1").unwrap(), "the row was there, so it was removed");
        assert_eq!(
            counts(&c, "d1"),
            (0, 0),
            "text and tables belonging to a forgotten document must not outlive it"
        );
        assert!(documents(&c).unwrap().is_empty());
    }

    #[test]
    fn removing_one_document_leaves_the_others_alone() {
        let c = store();
        insert_document(&c, &scan("d1", "C:/plant/ut-a.png"), "p3").unwrap();
        insert_document(&c, &scan("d2", "C:/plant/ut-b.png"), "p3").unwrap();

        delete_document(&c, "d1").unwrap();

        let left: Vec<String> = documents(&c).unwrap().into_iter().map(|d| d.id).collect();
        assert_eq!(left, ["d2"]);
        assert_eq!(counts(&c, "d2"), (1, 1));
    }

    #[test]
    fn removing_something_that_is_not_there_says_so_rather_than_failing() {
        let c = store();
        assert!(
            !delete_document(&c, "never-ingested").unwrap(),
            "a second click on an already-removed row is not a database error"
        );
    }
}
