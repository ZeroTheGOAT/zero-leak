//! Filesystem access, and the boundary that makes it safe.
//!
//! Every path the agent touches passes through [`resolve`]. Nothing else in the
//! core opens a file by a name a model chose, which is why this module is short
//! and why the interesting part of it is the refusals.
//!
//! ## What containment actually checks
//!
//! Rejecting `..` by string match is the usual mistake. On Windows the same
//! escape has too many spellings for that to hold — `..\`, `../`, a UNC prefix,
//! a bare drive letter, an 8.3 short name, a directory junction planted inside
//! the workspace — and a check that enumerates spellings is a check that is
//! one spelling behind. So the test here is structural instead:
//!
//!   1. The relative path is parsed into [`std::path::Component`]s. Anything
//!      that is not a plain name is refused, which covers `..`, roots and
//!      prefixes in every spelling at once because the parser normalises them.
//!   2. The joined result is canonicalised, and containment is proved on the
//!      canonical form. Junctions, symlinks and short names all resolve before
//!      the comparison, so they cannot smuggle a path out of the workspace.
//!
//! A path that does not exist yet still has to resolve, because writes name
//! files that are not there. In that case the deepest ancestor that *does*
//! exist is canonicalised and checked, and the remainder — already proved to be
//! plain names — is appended after. That closes the case where an existing
//! intermediate directory is a junction pointing somewhere else.
//!
//! ## Why the pickers do not use the plugin's blocking form
//!
//! `blocking_pick_folder` ends in `rx.recv().unwrap()` on a rendezvous channel
//! whose sender lives inside a closure handed to `run_on_main_thread` — and the
//! plugin discards that call's `Result`. If the post ever fails the sender is
//! dropped, `recv` returns `Err`, and the `unwrap` panics. This binary is built
//! with `panic = "abort"`, so that panic would end the process instead of
//! failing one command. The callback form plus a local channel and a deadline
//! turns the same failure into a message the operator can read.

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::state::{new_id, now_ms, AppState};
use crate::types::*;

/// Above this a file is not handed to the text reader. Large files are not
/// refused because they are dangerous but because the caller — a chat panel or
/// a model's context window — cannot use eight megabytes of text, and reading it
/// only to truncate it wastes the read.
const MAX_TEXT_BYTES: u64 = 8 * 1024 * 1024;

/// Maximum file copied into the webview for an inline preview.
///
/// Images and PDFs are commonly larger than source files, so this is higher
/// than the model-facing text limit. Above it, metadata is still returned and
/// the file remains inside the app; only the expensive byte copy is omitted.
const MAX_PREVIEW_BYTES: u64 = 32 * 1024 * 1024;

/// How much of a file is examined for the binary test. A NUL byte anywhere in
/// the first few kilobytes is the reliable signal; scanning the whole file to be
/// certain would defeat the point of refusing early.
const SNIFF_BYTES: usize = 8192;

/// How long a native picker may stay open before the command gives up. Long
/// enough that a person browsing a large share is not cut off, short enough that
/// a dialog which never appeared does not pin the request forever.
const PICKER_TIMEOUT: Duration = Duration::from_secs(600);

/* ------------------------------------------------------------------ */
/* Path containment                                                    */
/* ------------------------------------------------------------------ */

/// A path as the operator should see it.
///
/// `canonicalize` hands back the extended-length form, `\\?\C:\sovereign\...`, which
/// is correct to pass to the filesystem and wrong to show anyone. Left in, it
/// reaches the Artifacts panel, the tool result, and from there the model's own
/// answer, which then tells the operator their report is at a path with `\\?\` on
/// the front. Windows accepts the stripped form for every path this application
/// produces — they are short, and under a root the operator chose — so the
/// display form is also what gets stored.
///
/// The prefix pattern is four characters: a backslash pair, a question mark, a
/// backslash. A three-character spelling of it compiles and silently matches
/// nothing, which is how one copy of this function shipped as a no-op.
pub fn tidy(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    match s.strip_prefix(r"\\?\") {
        // The UNC form is `\\?\UNC\server\share`; putting back the pair of leading
        // backslashes is what makes it a usable path again.
        Some(rest) => match rest.strip_prefix("UNC\\") {
            Some(unc) => format!(r"\\{unc}"),
            None => rest.to_string(),
        },
        None => s,
    }
}

/// One spelling per file on disk.
///
/// Records are looked up by their path string, so two spellings of the same file
/// are two records: index `C:/plant/docs` and the walk hands back
/// `C:/plant/docs\sop.md`, while the file watcher reports the same save as
/// `C:\plant\docs\sop.md`, and a native file picker hands back the
/// extended-length `\\?\C:\plant\docs\sop.md`. Left alone, the same document is
/// stored twice, indexed twice, retrieved twice, and listed twice in the panel —
/// which is how one UT record becomes two search hits that disagree about
/// nothing. Canonicalising first means the existing record is found and updated.
///
/// A path that cannot be canonicalised — a file that has since been deleted, a
/// disconnected share — is tidied and returned as written rather than rejected,
/// because the caller's question is what to *call* it, not whether it is there.
pub fn canonical(p: &Path) -> String {
    std::fs::canonicalize(p).map(|c| tidy(&c)).unwrap_or_else(|_| tidy(p))
}

/// Lowercased path components, for containment tests.
///
/// The extended-length prefix is stripped first so a canonical path can be
/// compared with a plain one, and `.` segments are dropped so `a\.\b` and `a\b`
/// agree.
fn parts(p: &Path) -> Vec<String> {
    Path::new(&tidy(p))
        .components()
        .filter(|c| !matches!(c, Component::CurDir))
        .map(|c| c.as_os_str().to_string_lossy().to_lowercase())
        .collect()
}

/// True when `target` is `root` or lies inside it.
///
/// Component-wise rather than by string prefix, because `C:\Data` is a string
/// prefix of `C:\Database` and is not its parent — a check that accepted the
/// second because it starts with the first would be no check at all. Lowercased
/// because Windows paths are case-insensitive, and a path out of the registry or
/// typed by an operator rarely matches the on-disk casing.
///
/// Both sides must already be canonical: a junction is only resolved by
/// `canonicalize`, and comparing the components of unresolved paths would let one
/// point out of the root it appears to sit inside.
///
/// This is the one containment test outside [`contain`], which needs its own form
/// because it also walks up to a path that exists yet and reports why. The
/// version here was written twice — once in `sovereign` for sync roots, once in
/// `artifacts` for the output folder — and two copies of a boundary check is two
/// chances for one of them to be quietly weaker than the other.
pub fn within(root: &Path, target: &Path) -> bool {
    let r = parts(root);
    let t = parts(target);
    !r.is_empty() && t.len() >= r.len() && t[..r.len()] == r[..]
}

/// The approved workspace and its canonical root.
///
/// `approved_workspace` fails for a folder that was added but never approved, so
/// approval is enforced here rather than trusted from the caller.
fn workspace_root(st: &AppState, workspace_id: &str) -> CoreResult<(Workspace, PathBuf)> {
    let ws = st.with_db(|c| db::approved_workspace(c, workspace_id))?;
    let root = std::fs::canonicalize(&ws.path).map_err(|e| {
        CoreError::Denied(format!(
            "The workspace folder \"{}\" could not be opened ({e}), so no path inside it was \
             resolved. If the folder was moved or is on a disconnected drive, remove it and add \
             it again.",
            ws.path
        ))
    })?;
    Ok((ws, root))
}

/// Parses a workspace-relative path, refusing anything that is not plain names.
///
/// The refusals are structural: `Component::ParentDir` is `..` however it was
/// spelled, and `RootDir`/`Prefix` are an absolute path or a drive however it
/// was spelled. A colon inside a name is refused separately because NTFS reads
/// `file.txt:hidden` as an alternate data stream, which is a second file the
/// caller did not name.
fn plain_components(rel: &str, ws: &Workspace) -> CoreResult<PathBuf> {
    let deny = |why: &str| {
        Err(CoreError::Denied(format!(
            "The path \"{rel}\" was refused: {why}. Nothing was opened. Paths are relative to the \
             workspace \"{}\" and cannot point outside it.",
            ws.name
        )))
    };

    if rel.contains('\0') {
        return deny("it contains a NUL byte, which truncates the name the operating system sees");
    }

    let mut out = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(seg) => {
                if seg.to_string_lossy().contains(':') {
                    return deny("a component contains a colon, which names an alternate data stream");
                }
                out.push(seg);
            }
            // `.` is meaningless once the path is rebuilt, so it is dropped
            // rather than refused — asking for `./notes.txt` is not an attack.
            Component::CurDir => {}
            Component::ParentDir => return deny("it traverses upward"),
            Component::RootDir => return deny("it is an absolute path"),
            Component::Prefix(_) => return deny("it names a drive or a network share"),
        }
    }
    Ok(out)
}

/// Proves a joined path lies inside `root`, canonicalising first.
///
/// Walks up until an existing ancestor is found so that paths for files not yet
/// written can still be checked. The ancestor is what gets canonicalised, so a
/// junction anywhere along the existing part of the path is caught.
fn contain(root: &Path, target: PathBuf, rel: &str, ws: &Workspace) -> CoreResult<PathBuf> {
    let outside = || {
        CoreError::Denied(format!(
            "The path \"{rel}\" resolves outside the workspace \"{}\", so nothing was opened. This \
             happens when a folder inside the workspace is a junction or a symbolic link pointing \
             elsewhere.",
            ws.name
        ))
    };

    let mut probe = target;
    let mut tail: Vec<OsString> = Vec::new();
    loop {
        if let Ok(real) = std::fs::canonicalize(&probe) {
            if !real.starts_with(root) {
                return Err(outside());
            }
            let mut out = real;
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return Ok(out);
        }
        // Nothing at `probe`; step up and remember the name for reassembly.
        let name = match probe.file_name() {
            Some(n) => n.to_os_string(),
            None => return Err(outside()),
        };
        match probe.parent() {
            Some(parent) if parent != probe => {
                tail.push(name);
                probe = parent.to_path_buf();
            }
            // Ran out of ancestors without finding one that exists, which means
            // the workspace root itself is gone.
            _ => return Err(outside()),
        }
    }
}

/// The only way to turn a workspace-relative path into something openable.
/// Drops a leading segment that merely repeats the open folder's own name.
///
/// Models name paths the way a person reads them aloud. The open folder is
/// `turbine-reports`, so the file inside it is offered as
/// `turbine-reports/thickness-log.csv` — and since relative means relative *to*
/// that folder, the literal join reaches
/// `.../turbine-reports/turbine-reports/thickness-log.csv` and finds nothing.
/// The bare name `turbine-reports` has the same problem and means the root.
///
/// The segment is dropped only when the root has no child of that name, so a
/// workspace that genuinely contains a folder named after itself keeps the
/// literal reading. No valid interpretation is lost, and nothing outside the
/// workspace becomes reachable: this only ever shortens the path.
fn without_repeated_root(root: &Path, checked: &Path) -> Option<PathBuf> {
    let mut parts = checked.components();
    let first = parts.next()?;
    let own = root.file_name()?.to_string_lossy().to_lowercase();
    if first.as_os_str().to_string_lossy().to_lowercase() != own {
        return None;
    }
    if root.join(first.as_os_str()).exists() {
        return None;
    }
    Some(parts.collect())
}

pub fn resolve(st: &AppState, workspace_id: &str, rel: &str) -> CoreResult<PathBuf> {
    let (ws, root) = workspace_root(st, workspace_id)?;
    let mut checked = plain_components(rel, &ws)?;
    if let Some(shorter) = without_repeated_root(&root, &checked) {
        checked = shorter;
    }
    // An empty or `.`-only path is the workspace root, which is legitimate: it
    // is what the file explorer asks for first.
    let target = if checked.as_os_str().is_empty() { root.clone() } else { root.join(&checked) };
    contain(&root, target, rel, &ws)
}

/// Re-verifies containment after open: closes the check-then-open (TOCTOU)
/// window where a junction swap between `resolve` and `read` could redirect
/// the handle outside the workspace. The parent is canonicalized again and
/// must still sit inside the canonical root.
pub fn reverify_after_open(root: &Path, opened: &Path, rel: &str) -> CoreResult<()> {
    let real_root = std::fs::canonicalize(root).map_err(|_| {
        CoreError::Denied(format!(
            "The path \"{rel}\" was refused: the workspace root could not be re-verified after open."
        ))
    })?;
    let anchor = if opened.is_dir() { opened.to_path_buf() } else { opened.parent().map(|p| p.to_path_buf()).unwrap_or_else(|| opened.to_path_buf()) };
    // Walk up to the nearest existing ancestor (the file itself may be new).
    let mut probe = anchor;
    loop {
        if let Ok(real) = std::fs::canonicalize(&probe) {
            if real.starts_with(&real_root) {
                return Ok(());
            }
            return Err(CoreError::Denied(format!(
                "The path \"{rel}\" resolves outside its workspace after open (a folder on the path changed), so nothing was read."
            )));
        }
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => {
                return Err(CoreError::Denied(format!(
                    "The path \"{rel}\" could not be re-verified after open, so nothing was read."
                )))
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Native pickers                                                      */
/* ------------------------------------------------------------------ */

/// Runs a native picker without the plugin's blocking helper.
///
/// The closure receives a sender for its one answer; the deadline covers the
/// case where the dialog never reaches the screen. See the module header for why
/// the blocking helper is avoided entirely.
pub(crate) async fn await_picker<T, F>(what: &str, arm: F) -> CoreResult<Option<T>>
where
    T: Send + 'static,
    F: FnOnce(tokio::sync::oneshot::Sender<Option<T>>),
{
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<T>>();
    arm(tx);
    match tokio::time::timeout(PICKER_TIMEOUT, rx).await {
        Ok(Ok(chosen)) => Ok(chosen),
        // The sender was dropped without an answer. In practice this means the
        // request never reached the main thread's event loop, which is what
        // happens when there is no window and no message pump to post to.
        Ok(Err(_)) => Err(CoreError::ExecutionFailed(format!(
            "{what} closed without answering, so nothing was chosen. A native dialog needs the \
             desktop window; if this application was started with --no-window, choose the folder \
             from the window instead, or pass the path directly."
        ))),
        Err(_) => Err(CoreError::Timeout(format!(
            "{what} was still open after ten minutes, so the request was abandoned. Nothing was \
             chosen and nothing was changed."
        ))),
    }
}

pub(crate) fn to_path(fp: tauri_plugin_dialog::FilePath, what: &str) -> CoreResult<PathBuf> {
    fp.into_path().map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "{what} returned something that is not a filesystem path ({e}), so it was ignored."
        ))
    })
}

/* ------------------------------------------------------------------ */
/* Workspaces                                                          */
/* ------------------------------------------------------------------ */

pub fn list_workspaces(st: &AppState) -> CoreResult<Vec<Workspace>> {
    st.with_db(crate::db::workspaces)
}

/// Registers a folder chosen by the operator, unapproved.
///
/// Adding and approving are two steps on purpose. A folder arrives here because
/// somebody browsed to it; that is not the same as consenting to let a model
/// read and write inside it, and `resolve` refuses an unapproved workspace.
pub async fn add_workspace(st: Arc<AppState>) -> CoreResult<Option<Workspace>> {
    use tauri_plugin_dialog::DialogExt;

    let app = st.app.clone();
    let chosen = await_picker("The folder picker", move |tx| {
        app.dialog()
            .file()
            .set_title("Choose a folder for the workbench to work in")
            .pick_folder(move |folder| {
                let _ = tx.send(folder);
            });
    })
    .await?;

    let Some(picked) = chosen else {
        // Cancelling is an answer, not a failure.
        return Ok(None);
    };

    let path = to_path(picked, "The folder picker")?;
    let real = std::fs::canonicalize(&path).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The chosen folder \"{}\" could not be opened ({e}), so it was not registered.",
            path.display()
        ))
    })?;
    if !real.is_dir() {
        return Err(CoreError::ExecutionFailed(format!(
            "\"{}\" is a file, not a folder, so it was not registered as a workspace.",
            tidy(&real)
        )));
    }

    let stored = tidy(&real);

    // Re-adding the same folder should be idempotent rather than producing a
    // second workspace with its own approval state.
    let existing = st.with_db(db::workspaces)?;
    if let Some(w) = existing.iter().find(|w| {
        std::fs::canonicalize(&w.path).map(|p| p == real).unwrap_or(false)
    }) {
        crate::harness::ensure_project_layout(w)?;
        crate::harness::sync_memory_files(&st)?;
        return Ok(Some(w.clone()));
    }

    let name = real
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| stored.clone());

    let ws = Workspace {
        id: new_id("ws"),
        name,
        path: stored,
        folders: vec![WorkspaceFolder {
            id: new_id("folder"),
            path: tidy(&real),
            is_primary: true,
        }],
        approved: false,
        pinned: false,
        archived: false,
        added_at: now_ms(),
        file_count: None,
        indexed_count: None,
    };
    st.with_db(|c| db::insert_workspace(c, &ws))?;
    crate::harness::ensure_project_layout(&ws)?;
    crate::harness::sync_memory_files(&st)?;
    Ok(Some(ws))
}

/// Lets the project dialog choose one source folder without registering it as
/// a workspace. The folder is copied only when the operator creates the
/// project, so cancelling the dialog leaves no partial state.
pub async fn pick_source_folder(st: Arc<AppState>) -> CoreResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let app = st.app.clone();
    let chosen = await_picker("The source folder picker", move |tx| {
        app.dialog()
            .file()
            .set_title("Choose a folder to add to the project")
            .pick_folder(move |folder| {
                let _ = tx.send(folder);
            });
    })
    .await?;
    chosen
        .map(|picked| to_path(picked, "The source folder picker").map(|p| tidy(&p)))
        .transpose()
}

/// Creates a project and copies any selected sources into it.
///
/// With no `location`, the project is an isolated, app-owned folder under the
/// sovereign projects root — the original behaviour. With a `location`, the
/// operator chose where this project lives (e.g. `C:\Projects\MyWebsite`) and
/// the workspace is rooted *at that folder*: every file the agent writes, every
/// command it runs, every install and dev server happen inside it, not in an
/// app container. The harness's own files (project instructions, memories) are
/// keyed by workspace id under the sovereign root, so nothing is littered into
/// the chosen folder.
pub async fn create_workspace(
    st: Arc<AppState>,
    name: String,
    source_paths: Vec<String>,
    location: Option<String>,
) -> CoreResult<Workspace> {
    tokio::task::spawn_blocking(move || {
        create_workspace_blocking(&st, &name, &source_paths, location.as_deref())
    })
    .await
    .map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The project creation task stopped unexpectedly ({e}), so no project was registered."
        ))
    })?
}

fn project_slug(name: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            separator = false;
        } else if !separator && !out.is_empty() {
            out.push('-');
            separator = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "project".into()
    } else {
        trimmed.chars().take(48).collect::<String>().trim_end_matches('-').into()
    }
}

fn create_workspace_blocking(
    st: &AppState,
    raw_name: &str,
    source_paths: &[String],
    location: Option<&str>,
) -> CoreResult<Workspace> {
    let name = raw_name.trim();
    if name.is_empty() {
        return Err(CoreError::ExecutionFailed(
            "Give the project a name before creating it.".into(),
        ));
    }
    if name.chars().count() > 80 || name.chars().any(|c| c.is_control()) {
        return Err(CoreError::ExecutionFailed(
            "Project names must be 80 visible characters or fewer.".into(),
        ));
    }

    let projects_root = crate::registry::sovereign_root().join("projects");
    std::fs::create_dir_all(&projects_root)?;
    let projects_root = std::fs::canonicalize(&projects_root)?;
    let unique = new_id("p");
    let id = format!("{}--{}", project_slug(name), unique);

    // Where this project lives. `None` is the app-owned container; `Some` is
    // a folder the operator picked, which becomes the workspace root itself.
    let (files_root, rollback_folder) = match location.map(str::trim).filter(|l| !l.is_empty()) {
        None => {
            let container = projects_root.join(&id);
            if !within(&projects_root, &container) || container.exists() {
                return Err(CoreError::ExecutionFailed(
                    "A safe, unique project folder could not be allocated.".into(),
                ));
            }
            let files_root = container.join("files");
            std::fs::create_dir_all(&files_root)?;
            (files_root, Some(container))
        }
        Some(picked) => {
            // Created if missing — a picker normally returns an existing
            // folder, but a typed path may name one that should exist.
            let picked_path = std::path::PathBuf::from(picked);
            if !picked_path.is_dir() {
                std::fs::create_dir_all(&picked_path).map_err(|e| {
                    CoreError::ExecutionFailed(format!(
                        "The chosen project folder \"{picked}\" could not be created ({e})."
                    ))
                })?;
            }
            let canonical = std::fs::canonicalize(&picked_path).map_err(|e| {
                CoreError::ExecutionFailed(format!(
                    "The chosen project folder \"{picked}\" could not be opened ({e})."
                ))
            })?;
            if source_overlaps_projects(&projects_root, &canonical) {
                return Err(CoreError::Denied(
                    "A project cannot live inside the app's own projects directory. Choose a folder elsewhere."
                        .into(),
                ));
            }
            // One workspace per folder: registering the same folder twice
            // would give two ids one directory, and the harness (sessions,
            // memories) is keyed by workspace id.
            let already = st
                .with_db(db::workspaces)?
                .into_iter()
                .any(|w| w.path.eq_ignore_ascii_case(&tidy(&canonical)));
            if already {
                return Err(CoreError::ExecutionFailed(format!(
                    "\"{}\" is already an open project. Open it from the Files panel instead of creating it again.",
                    tidy(&canonical)
                )));
            }
            (canonical, None)
        }
    };

    let result = (|| -> CoreResult<Workspace> {
        for source in source_paths {
            copy_source_into_project(&projects_root, Path::new(source), &files_root)?;
        }

        let root = tidy(&std::fs::canonicalize(&files_root)?);
        let ws = Workspace {
            id: id.clone(),
            name: name.to_string(),
            path: root.clone(),
            folders: vec![WorkspaceFolder {
                id: new_id("folder"),
                path: root,
                is_primary: true,
            }],
            // The operator just created or picked this folder explicitly. A
            // second approval prompt would add no new consent.
            approved: true,
            pinned: false,
            archived: false,
            added_at: now_ms(),
            file_count: None,
            indexed_count: None,
        };
        crate::harness::ensure_project_layout(&ws)?;
        crate::harness::sync_memory_files(st)?;
        // Registration is last: every filesystem operation has succeeded, so
        // the database can never point at a project folder rolled back below.
        st.with_db(|c| db::insert_workspace(c, &ws))?;
        Ok(ws)
    })();

    if result.is_err() {
        // Only the app-owned container is ours to delete. An operator-chosen
        // folder is theirs: a failed creation removes the registration, never
        // the folder (or the sources already copied into it).
        if let Some(container) = rollback_folder {
            let _ = std::fs::remove_dir_all(&container);
        }
    }
    result
}

fn copy_source_into_project(projects_root: &Path, source: &Path, files_root: &Path) -> CoreResult<()> {
    let source = std::fs::canonicalize(source).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The source folder \"{}\" could not be opened ({e}).",
            source.display()
        ))
    })?;
    if !source.is_dir() {
        return Err(CoreError::ExecutionFailed(format!(
            "\"{}\" is not a folder, so it was not added to the project.",
            tidy(&source)
        )));
    }
    if source_overlaps_projects(projects_root, &source) {
        return Err(CoreError::Denied(
            "A project cannot import the projects directory, one of its parent folders, or another managed project."
                .into(),
        ));
    }

    let base_name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "source".into());
    let mut destination = files_root.join(&base_name);
    let mut suffix = 2;
    while destination.exists() {
        destination = files_root.join(format!("{base_name}-{suffix}"));
        suffix += 1;
    }

    for entry in walkdir::WalkDir::new(&source).follow_links(false) {
        let entry = entry.map_err(|e| {
            CoreError::ExecutionFailed(format!(
                "The source folder \"{}\" could not be copied ({e}).",
                tidy(&source)
            ))
        })?;
        let relative = entry.path().strip_prefix(&source).map_err(|_| {
            CoreError::Denied("A source entry resolved outside the selected folder.".into())
        })?;
        let target = destination.join(relative);
        if entry.file_type().is_symlink() {
            return Err(CoreError::Denied(format!(
                "The source contains a link at \"{}\". Links are not copied because they could point outside the project.",
                tidy(entry.path())
            )));
        }
        if entry.file_type().is_dir() {
            std::fs::create_dir_all(&target)?;
        } else if entry.file_type().is_file() {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::copy(entry.path(), &target).map_err(|e| {
                CoreError::ExecutionFailed(format!(
                    "\"{}\" could not be copied into the project ({e}).",
                    tidy(entry.path())
                ))
            })?;
        }
    }
    Ok(())
}

fn source_overlaps_projects(projects_root: &Path, source: &Path) -> bool {
    within(projects_root, source) || within(source, projects_root)
}

pub fn approve_workspace(st: &AppState, id: &str) -> CoreResult<Workspace> {
    st.with_db(|c| {
        db::set_workspace_approved(c, id, true)?;
        db::workspace(c, id)
    })
}

/// Renames a project, changes its attached roots and persists its sidebar state.
/// Folder access stays local and explicit: every new root must exist and be a
/// directory, there can be no more than five, and exactly one is primary.
pub fn update_workspace(
    st: &AppState,
    id: &str,
    mut update: WorkspaceUpdate,
) -> CoreResult<Workspace> {
    let name = update.name.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(|c| c.is_control()) {
        return Err(CoreError::ExecutionFailed(
            "Project names must contain 1 to 80 visible characters.".into(),
        ));
    }
    if update.folders.is_empty() || update.folders.len() > 5 {
        return Err(CoreError::ExecutionFailed(
            "A project must have between one and five folders.".into(),
        ));
    }
    if update.folders.iter().filter(|folder| folder.is_primary).count() != 1 {
        return Err(CoreError::ExecutionFailed(
            "Choose exactly one primary project folder.".into(),
        ));
    }

    let existing = st.with_db(|c| db::workspace(c, id))?;
    let existing_paths: Vec<PathBuf> = existing
        .folders
        .iter()
        .filter_map(|folder| std::fs::canonicalize(&folder.path).ok())
        .collect();
    let projects_root = std::fs::canonicalize(crate::registry::sovereign_root().join("projects"))?;
    let mut seen = Vec::<PathBuf>::new();
    for folder in &mut update.folders {
        let was_existing = existing
            .folders
            .iter()
            .any(|saved| parts(Path::new(&saved.path)) == parts(Path::new(&folder.path)));
        let real = match std::fs::canonicalize(&folder.path) {
            Ok(path) => path,
            Err(_) if was_existing => {
                PathBuf::from(&folder.path)
            }
            Err(error) => {
                return Err(CoreError::ExecutionFailed(format!(
                    "The project folder \"{}\" could not be opened ({error}).",
                    folder.path
                )))
            }
        };
        if !real.is_dir() && !was_existing {
            return Err(CoreError::ExecutionFailed(format!(
                "\"{}\" is not a folder.",
                tidy(&real)
            )));
        }
        if seen.iter().any(|path| parts(path) == parts(&real)) {
            return Err(CoreError::ExecutionFailed(
                "The same folder cannot be attached to a project twice.".into(),
            ));
        }
        if source_overlaps_projects(&projects_root, &real)
            && !existing_paths.iter().any(|path| parts(path) == parts(&real))
        {
            return Err(CoreError::Denied(
                "A project cannot attach the projects directory or another managed project.".into(),
            ));
        }
        seen.push(real.clone());
        folder.path = tidy(&real);
        if folder.id.trim().is_empty() {
            folder.id = new_id("folder");
        }
    }
    update.name = name.to_string();
    let workspace = st.with_db(|c| db::update_workspace(c, id, &update))?;
    crate::harness::ensure_project_layout(&workspace)?;
    crate::harness::sync_memory_files(st)?;
    Ok(workspace)
}

/// Unregisters a workspace. Nothing the operator or a run produced is deleted.
///
/// Deliberate: removing a folder from the list withdraws the application's
/// access to it, and destroying the operator's files would be a different and
/// much worse operation than the one the button says. Source files, attached
/// folders and everything under the project's `artifacts/` survive.
///
/// What is removed is state this application generated and can regenerate: the
/// database rows for the workspace and its sessions, the session and project
/// memory mirrors, `AGENTS.md` and `project.json` — see
/// `harness::remove_project_mirrors`.
pub fn remove_workspace(
    st: &AppState,
    id: &str,
    detach_session_ids: &[String],
) -> CoreResult<()> {
    // The workspace's dev server, if one is running, has no workspace to serve
    // once this returns — and its cwd may be a folder the operator is about to
    // delete or move.
    crate::devserver::stop(st, id)?;
    let removed_session_ids: Vec<String> = st
        .with_db(db::sessions)?
        .into_iter()
        .filter(|session| session.workspace_id.as_deref() == Some(id))
        .filter(|session| !detach_session_ids.contains(&session.id))
        .map(|session| session.id)
        .collect();
    st.with_db(|c| db::delete_workspace_with_sessions(c, id, detach_session_ids))?;
    for session_id in removed_session_ids {
        if let Err(error) = crate::harness::remove_session_mirror(&session_id) {
            st.emit_failure(&error);
        }
    }
    if let Err(error) = crate::harness::remove_project_mirrors(st, id) {
        st.emit_failure(&error);
    }
    crate::harness::sync_memory_files(st)?;
    Ok(())
}

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

fn modified_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One level of a directory, folders first.
///
/// `rel_path` is built with forward slashes so it round-trips through `resolve`
/// unchanged — Rust's path parser accepts either separator on Windows, and the
/// wire is easier to read without escapes.
pub fn list_dir(st: &AppState, workspace_id: &str, rel: &str) -> CoreResult<Vec<FileNode>> {
    let dir = resolve(st, workspace_id, rel)?;
    let entries = std::fs::read_dir(&dir).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The folder \"{rel}\" could not be listed ({e}), so nothing was read."
        ))
    })?;

    let prefix = rel.trim_matches('/').trim_matches('\\').replace('\\', "/");
    let mut out = Vec::new();
    for entry in entries.flatten() {
        // An entry whose metadata cannot be read is omitted rather than reported
        // with guessed values, because a file explorer showing a zero-byte file
        // that is not zero bytes is worse than one showing nothing.
        let Ok(meta) = entry.metadata() else { continue };
        let name = entry.file_name().to_string_lossy().to_string();
        let rel_path = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
        out.push(FileNode {
            name,
            rel_path,
            is_dir: meta.is_dir(),
            size_bytes: if meta.is_dir() { 0 } else { meta.len() },
            modified_at: modified_ms(&meta),
            // knowledge.rs owns this column. Claiming `false` here would render
            // as "not indexed" for files that are.
            indexed: None,
        });
    }

    out.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(out)
}

/// A file as text, or an honest refusal.
///
/// Neither cap here is arbitrary. Lossy decoding would hand the caller — often a
/// model — plausible-looking mojibake with no way to tell it apart from the real
/// contents, and silently truncating a large file would do the same for the
/// missing half.
pub fn read_text(st: &AppState, workspace_id: &str, rel: &str) -> CoreResult<String> {
    let path = resolve(st, workspace_id, rel)?;
    // Re-verify after open (TOCTOU): the workspace root is re-canonicalized
    // via the opened path's parent before bytes are trusted.
    {
        let (_, root) = workspace_root(st, workspace_id)?;
        reverify_after_open(&root, &path, rel)?;
    }
    let meta = std::fs::metadata(&path).map_err(|e| {
        CoreError::ExecutionFailed(format!("\"{rel}\" could not be opened ({e}), so nothing was read."))
    })?;
    if meta.is_dir() {
        return Err(CoreError::ExecutionFailed(format!(
            "\"{rel}\" is a folder, so nothing was read. List it instead."
        )));
    }
    if meta.len() > MAX_TEXT_BYTES {
        return Err(CoreError::ExecutionFailed(format!(
            "\"{rel}\" is {} MiB, above the {} MiB text limit, so nothing was read. Ingest it as a \
             document instead, which extracts it in pages.",
            meta.len() / (1024 * 1024),
            MAX_TEXT_BYTES / (1024 * 1024)
        )));
    }

    let bytes = std::fs::read(&path).map_err(|e| {
        CoreError::ExecutionFailed(format!("\"{rel}\" could not be read ({e}), so nothing was returned."))
    })?;

    if bytes.iter().take(SNIFF_BYTES).any(|b| *b == 0) {
        return Err(CoreError::InvalidDocument(format!(
            "\"{rel}\" is binary, not text, so nothing was returned. Ingest it as a document if it \
             is a PDF, an image or an Office file."
        )));
    }

    String::from_utf8(bytes).map_err(|_| {
        CoreError::InvalidDocument(format!(
            "\"{rel}\" is not valid UTF-8 text, so nothing was returned rather than a partly \
             mangled transcription. Convert it to UTF-8 first."
        ))
    })
}

/// Returns an approved local file for display inside the right panel.
///
/// This accepts an absolute path because artifacts live under the configured
/// artifact root while workspace files live under independently approved
/// roots. `permitted_existing_file` proves that either provenance is valid
/// before a byte is read.
pub fn preview_file(st: &AppState, path: &str) -> CoreResult<FilePreview> {
    use base64::Engine as _;

    let target = permitted_existing_file(st, path)?;
    let meta = std::fs::metadata(&target).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "\"{path}\" could not be inspected ({e}), so nothing was read."
        ))
    })?;
    if meta.is_dir() {
        return Err(CoreError::ExecutionFailed(format!(
            "\"{path}\" is a folder, so it cannot be previewed as a file."
        )));
    }

    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| tidy(&target));
    let too_large = meta.len() > MAX_PREVIEW_BYTES;
    let content_base64 = if too_large {
        None
    } else {
        let bytes = std::fs::read(&target).map_err(|e| {
            CoreError::ExecutionFailed(format!(
                "\"{path}\" could not be read ({e}), so no preview was returned."
            ))
        })?;
        Some(base64::engine::general_purpose::STANDARD.encode(bytes))
    };

    Ok(FilePreview {
        path: tidy(&target),
        file_name: file_name.clone(),
        size_bytes: meta.len(),
        modified_at: modified_ms(&meta),
        mime_type: preview_mime(&file_name).to_string(),
        content_base64,
        too_large,
    })
}

/// Writes text back to a file the right panel has open.
///
/// The panel's editor is the operator typing, so there is no diff to approve —
/// they are looking at the change as they make it, and the file they saved is
/// the file they were shown. What still applies is everything that governs
/// where a write may land: the path must be one `permitted_existing_file`
/// accepts, and the operator's own path rules are re-checked here, the same
/// check `apply_change` makes before it writes.
///
/// Existing files only. Creating one from the panel would need a containment
/// decision of its own, and a "save" that silently creates a mistyped path is
/// worse than a refusal. The returned preview is read back from disk, so what
/// the panel shows afterwards is the file rather than the buffer it sent.
pub fn save_text(st: &AppState, path: &str, contents: &str) -> CoreResult<FilePreview> {
    let started = now_ms();
    let target = permitted_existing_file(st, path)?;
    if !target.is_file() {
        return Err(CoreError::ExecutionFailed(format!(
            "\"{path}\" is not a file, so nothing was written."
        )));
    }
    if let Some(refusal) = crate::guards::check_path(st, &target.to_string_lossy()) {
        return Err(CoreError::Denied(refusal.message("saving this file")));
    }
    if contents.len() as u64 > MAX_TEXT_BYTES {
        return Err(CoreError::ExecutionFailed(format!(
            "That is {} MB of text, over the {} MB limit, so nothing was written.",
            contents.len() as u64 / (1024 * 1024),
            MAX_TEXT_BYTES / (1024 * 1024)
        )));
    }

    std::fs::write(&target, contents).map_err(|e| {
        CoreError::ExecutionFailed(format!("\"{path}\" could not be written ({e})."))
    })?;

    // Recorded like any other write. The audit table is what the operator reads
    // back to find out what touched a file, and a save made by hand belongs in
    // it as much as one a run made — with no workspace or session, because this
    // is the operator acting directly rather than a run doing it.
    st.audit(
        ToolName::WriteFile,
        format!("saved {} from the file panel", tidy(&target)),
        "ok",
        started,
        "",
        None,
        None,
        None,
    );

    preview_file(st, path)
}

fn preview_mime(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "flac" => "audio/flac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "csv" => "text/csv",
        "json" => "application/json",
        "xml" => "application/xml",
        "md" | "markdown" => "text/markdown",
        "txt" | "log" | "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "py"
        | "rs" | "c" | "h" | "cpp" | "hpp" | "cs" | "java" | "go" | "rb"
        | "php" | "sh" | "ps1" | "sql" | "yaml" | "yml" | "toml" | "ini"
        | "conf" | "env" => "text/plain",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// Resolves an existing file and proves it belongs to a user-approved input or
/// an application-owned output root.
fn permitted_existing_file(st: &AppState, path: &str) -> CoreResult<PathBuf> {
    let target = std::fs::canonicalize(path).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "\"{path}\" could not be opened ({e}), so nothing was read."
        ))
    })?;

    let settings = st.settings();
    let mut roots: Vec<PathBuf> = st
        .with_db(db::workspaces)?
        .into_iter()
        .filter(|w| w.approved)
        .flat_map(|w| w.folders)
        .filter_map(|folder| std::fs::canonicalize(folder.path).ok())
        .collect();
    let projects_root = crate::registry::sovereign_root().join("projects");
    // Pasted images are staged under `sovereign_root/attachments`, so that
    // folder is an output root of this application too.
    let attachments_root = crate::registry::sovereign_root().join("attachments");
    for extra in [
        Path::new(&settings.artifact_root),
        Path::new(&settings.sandbox_root),
        Path::new(&settings.knowledge_root),
        projects_root.as_path(),
        attachments_root.as_path(),
    ] {
        if let Ok(p) = std::fs::canonicalize(extra) {
            roots.push(p);
        }
    }
    if !roots.iter().any(|r| target.starts_with(r)) {
        return Err(CoreError::Denied(format!(
            "\"{path}\" is not inside an approved workspace or an output folder of this application, so it was not opened."
        )));
    }
    Ok(target)
}

/* ------------------------------------------------------------------ */
/* Revealing                                                           */
/* ------------------------------------------------------------------ */

/// Opens Explorer with the item selected.
///
/// Takes an absolute path because that is what the artifact and document lists
/// hold. It is still checked against the approved workspaces and the roots this
/// application writes to, because a reveal that accepts any path is a way to
/// confirm what exists on a disk the caller was never granted.
pub fn reveal(st: &AppState, path: &str) -> CoreResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let target = std::fs::canonicalize(path).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "\"{path}\" could not be opened ({e}), so Explorer was not opened."
        ))
    })?;

    let settings = st.settings();
    let mut roots: Vec<PathBuf> = st
        .with_db(db::workspaces)?
        .into_iter()
        .filter(|w| w.approved)
        .flat_map(|w| w.folders)
        .filter_map(|folder| std::fs::canonicalize(folder.path).ok())
        .collect();
    // The application's own output folders. An artifact this core produced is
    // something the operator is entitled to see even when it lives outside a
    // workspace.
    for extra in [&settings.artifact_root, &settings.sandbox_root, &settings.knowledge_root] {
        if let Ok(p) = std::fs::canonicalize(extra) {
            roots.push(p);
        }
    }

    if !roots.iter().any(|r| target.starts_with(r)) {
        return Err(CoreError::Denied(format!(
            "\"{path}\" is not inside an approved workspace or an output folder of this \
             application, so Explorer was not opened. Add and approve the containing folder first."
        )));
    }

    st.app.opener().reveal_item_in_dir(&target).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "Explorer could not be opened for \"{}\" ({e}).",
            tidy(&target)
        ))
    })
}

/* ------------------------------------------------------------------ */
/* Opening                                                              */
/* ------------------------------------------------------------------ */

/// Opens a file in whatever the machine registered as its default handler.
///
/// Gated by the same boundary as [`reveal`]: only files inside an approved
/// workspace or an application-owned output folder may leave the workbench
/// inside another program.
pub fn open_default(st: &AppState, path: &str) -> CoreResult<()> {
    use tauri_plugin_opener::OpenerExt;

    let target = permitted_existing_file(st, path)?;
    st.app
        .opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| {
            CoreError::ExecutionFailed(format!(
                "\"{}\" could not be opened in its default app ({e}).",
                tidy(&target)
            ))
        })
}

/// Launches one installed program with a file.
///
/// The executable must already exist on disk and end in `.exe`: anything else
/// would need a shell to interpret it, and there is no shell here to do that.
/// The file itself clears the same boundary as [`reveal`].
pub fn open_with(st: &AppState, path: &str, exe: &str) -> CoreResult<()> {
    use std::process::{Command, Stdio};

    let target = permitted_existing_file(st, path)?;
    let program = std::fs::canonicalize(exe).map_err(|e| {
        CoreError::ExecutionFailed(format!("\"{exe}\" could not be launched ({e}), so nothing was opened."))
    })?;
    let is_program = program.is_file()
        && program
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
    if !is_program {
        return Err(CoreError::Denied(format!(
            "\"{}\" is not an installed program, so it was not launched.",
            tidy(&program)
        )));
    }
    Command::new(&program)
        .arg(&target)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            CoreError::ExecutionFailed(format!(
                "\"{}\" could not open \"{}\" ({e}).",
                tidy(&program),
                tidy(&target)
            ))
        })?;
    Ok(())
}

/// The per-user registrations first — they override the machine — then the
/// machine-wide ones. Read-only throughout; listing associations never writes
/// one.
fn classes_keys() -> Vec<winreg::RegKey> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .filter_map(|hive| {
            RegKey::predef(hive)
                .open_subkey_with_flags("Software\\Classes", KEY_READ)
                .ok()
        })
        .collect()
}

/// Pulls the executable out of a `shell\open\command` string — `"C:\a\b.exe"
/// "%1"` or `C:\a\b.exe %1` — expanding any `%VAR%` segments on the way.
/// Unknown variables stay verbatim rather than vanishing the path.
fn parse_open_command(raw: &str) -> Option<PathBuf> {
    let raw = raw.trim();
    let end = match raw.strip_prefix('"') {
        Some(rest) => rest.find('"').map(|i| &rest[..i]),
        None => raw.split_whitespace().next(),
    }?;
    let expanded = expand_env(end.trim());
    if expanded.is_empty() {
        return None;
    }
    Some(PathBuf::from(expanded))
}

fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let tail = &rest[start + 1..];
        match tail.find('%') {
            Some(end) => {
                let name = &tail[..end];
                match std::env::var(name) {
                    Ok(v) => out.push_str(&v),
                    Err(_) => {
                        out.push('%');
                        out.push_str(name);
                        out.push('%');
                    }
                }
                rest = &tail[end + 1..];
            }
            None => {
                out.push('%');
                out.push_str(tail);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// File stem as a last-resort display name: `Code.exe` reads as "Code".
fn exe_stem_name(exe: &Path) -> String {
    exe.file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "Program".to_string())
}

/// The name Windows itself shows for an installed program: `ApplicationName`,
/// then `FriendlyAppName` — unless the latter is an indirect `@path,-id`
/// resource reference, which resolving would mean loading a foreign DLL's
/// string table. That stays unresolved and the stem wins instead.
fn app_display_name(classes: &[winreg::RegKey], exe_file_name: &str) -> Option<String> {
    use winreg::enums::KEY_READ;
    for root in classes {
        let key_path = format!("Applications\\{exe_file_name}");
        let Ok(app) = root.open_subkey_with_flags(&key_path, KEY_READ) else {
            continue;
        };
        for value in ["ApplicationName", "FriendlyAppName"] {
            if let Ok(name) = app.get_value::<String, _>(value) {
                let name = name.trim().to_string();
                if !name.is_empty() && !name.starts_with('@') {
                    return Some(name);
                }
            }
        }
    }
    None
}

/// Resolves a ProgID to its open command's executable.
fn progid_target(classes: &[winreg::RegKey], progid: &str) -> Option<(PathBuf, String)> {
    use winreg::enums::KEY_READ;
    for root in classes {
        let key_path = format!("{progid}\\shell\\open\\command");
        let Ok(cmd) = root.open_subkey_with_flags(&key_path, KEY_READ) else {
            continue;
        };
        let Ok(raw) = cmd.get_value::<String, _>("") else {
            continue;
        };
        let Some(exe) = parse_open_command(&raw) else {
            continue;
        };
        if !exe.is_file() {
            continue;
        }
        let file_name = exe.file_name()?.to_string_lossy().to_string();
        let name = app_display_name(classes, &file_name).unwrap_or_else(|| exe_stem_name(&exe));
        return Some((exe, name));
    }
    None
}

/// Resolves a bare executable name from `OpenWithList` — first through its
/// `Applications` registration, then `App Paths`, then `PATH` — because the
/// list itself only carries names like `Code.exe`, never locations.
fn exe_target(classes: &[winreg::RegKey], exe_name: &str) -> Option<(PathBuf, String)> {
    use winreg::enums::KEY_READ;
    if exe_name.contains(['/', '\\']) {
        let direct = PathBuf::from(exe_name);
        if !direct.is_file() {
            return None;
        }
        let file_name = direct.file_name()?.to_string_lossy().to_string();
        let name =
            app_display_name(classes, &file_name).unwrap_or_else(|| exe_stem_name(&direct));
        return Some((direct, name));
    }
    for root in classes {
        let key_path = format!("Applications\\{exe_name}\\shell\\open\\command");
        if let Ok(cmd) = root.open_subkey_with_flags(&key_path, KEY_READ) {
            if let Ok(raw) = cmd.get_value::<String, _>("") {
                if let Some(exe) = parse_open_command(&raw) {
                    if exe.is_file() {
                        let name = app_display_name(classes, exe_name)
                            .unwrap_or_else(|| exe_stem_name(&exe));
                        return Some((exe, name));
                    }
                }
            }
        }
    }
    let exe = app_paths_target(exe_name)?;
    let name =
        app_display_name(classes, exe_name).unwrap_or_else(|| exe_stem_name(&exe));
    Some((exe, name))
}

/// Where installers say they put things (`Code.exe` lives far from `PATH`),
/// with `PATH` itself covering the rest (`notepad.exe`).
fn app_paths_target(exe_name: &str) -> Option<PathBuf> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
        let key_path = format!("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe_name}");
        let Ok(key) = RegKey::predef(hive).open_subkey_with_flags(&key_path, KEY_READ) else {
            continue;
        };
        let Ok(raw) = key.get_value::<String, _>("") else {
            continue;
        };
        let candidate = PathBuf::from(expand_env(raw.trim().trim_matches('"').trim()));
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Adds one candidate, first wins on duplicates, hard-capped so a long tail
/// of stale entries cannot flood the dropdown.
fn push_entry(seen: &mut Vec<String>, out: &mut Vec<OpenWithEntry>, exe: PathBuf, name: String, recommended: bool) {
    if out.len() >= 8 {
        return;
    }
    let key = exe.to_string_lossy().to_lowercase();
    if seen.iter().any(|s| s == &key) {
        return;
    }
    seen.push(key);
    out.push(OpenWithEntry {
        name,
        exe: tidy(&exe),
        recommended,
    });
}

/// Every installed application Windows offers for a file: the registered
/// default first, then `OpenWithProgids` alternates, then the explicit
/// `OpenWithList` choices — the same order the system menu shows, capped so
/// a long tail of stale entries cannot flood the dropdown.
pub fn open_with_list(st: &AppState, path: &str) -> CoreResult<Vec<OpenWithEntry>> {
    use winreg::enums::KEY_READ;

    let target = permitted_existing_file(st, path)?;
    let Some(ext) = target
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{}", s.to_lowercase()))
    else {
        return Ok(Vec::new());
    };

    let roots = classes_keys();
    let mut seen: Vec<String> = Vec::new();
    let mut out: Vec<OpenWithEntry> = Vec::new();

    // The registered default, user hive first — it alone is recommended.
    for root in &roots {
        let Ok(ext_key) = root.open_subkey_with_flags(&ext, KEY_READ) else {
            continue;
        };
        if let Ok(pid) = ext_key.get_value::<String, _>("") {
            let pid = pid.trim().to_string();
            if !pid.is_empty() {
                if let Some((exe, name)) = progid_target(&roots, &pid) {
                    push_entry(&mut seen, &mut out, exe, name, true);
                }
                break;
            }
        }
    }
    for root in &roots {
        let Ok(ext_key) = root.open_subkey_with_flags(&ext, KEY_READ) else {
            continue;
        };
        if let Ok(progids) = ext_key.open_subkey_with_flags("OpenWithProgids", KEY_READ) {
            let mut names: Vec<String> = progids.enum_values().flatten().map(|(n, _)| n).collect();
            names.sort();
            for pid in names {
                if pid.trim().is_empty() {
                    continue;
                }
                if let Some((exe, name)) = progid_target(&roots, &pid) {
                    push_entry(&mut seen, &mut out, exe, name, false);
                }
                if out.len() >= 8 {
                    break;
                }
            }
        }
        if out.len() >= 8 {
            break;
        }
        if let Ok(list) = ext_key.open_subkey_with_flags("OpenWithList", KEY_READ) {
            let mut names: Vec<String> = Vec::new();
            for (name, _) in list.enum_values().flatten() {
                if name.eq_ignore_ascii_case("MRUList") || name.trim().is_empty() {
                    continue;
                }
                if let Ok(exe) = list.get_value::<String, _>(&name) {
                    if !exe.trim().is_empty() {
                        names.push(exe.trim().to_string());
                    }
                }
            }
            names.sort();
            for exe_name in names {
                if let Some((exe, name)) = exe_target(&roots, &exe_name) {
                    push_entry(&mut seen, &mut out, exe, name, false);
                }
                if out.len() >= 8 {
                    break;
                }
            }
        }
        if out.len() >= 8 {
            break;
        }
    }
    Ok(out)
}

/// Save dialog plus copy. Answers the destination path, or null when the
/// operator cancels — cancelling is an answer, not a failure.
pub async fn save_copy_as(st: Arc<AppState>, path: &str) -> CoreResult<Option<String>> {
    use tauri_plugin_dialog::DialogExt;

    let target = permitted_existing_file(&st, path)?;
    let file_name = target
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "copy".to_string());
    let app = st.app.clone();
    let chosen = await_picker("The save dialog", move |tx| {
        app.dialog()
            .file()
            .set_title("Save a copy of the file")
            .set_file_name(&file_name)
            .save_file(move |file| {
                let _ = tx.send(file);
            });
    })
    .await?;
    let Some(picked) = chosen else {
        return Ok(None);
    };
    let dest = to_path(picked, "The save dialog")?;
    std::fs::copy(&target, &dest).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The copy to \"{}\" failed ({e}), so nothing was saved.",
            tidy(&dest)
        ))
    })?;
    Ok(Some(tidy(&dest)))
}

#[cfg(test)]
mod open_with_tests {
    use super::{expand_env, parse_open_command};
    use std::path::PathBuf;

    #[test]
    fn quoted_commands_resolve_to_the_exe() {
        assert_eq!(
            parse_open_command("\"C:\\Program Files\\App\\app.exe\" \"%1\""),
            Some(PathBuf::from("C:\\Program Files\\App\\app.exe"))
        );
    }

    #[test]
    fn bare_commands_take_the_first_token() {
        assert_eq!(
            parse_open_command("C:\\Windows\\notepad.exe %1"),
            Some(PathBuf::from("C:\\Windows\\notepad.exe"))
        );
    }

    #[test]
    fn empty_commands_resolve_to_nothing() {
        assert_eq!(parse_open_command("   "), None);
        assert_eq!(parse_open_command("\"\""), None);
    }

    #[test]
    fn unknown_variables_stay_verbatim() {
        assert_eq!(
            expand_env("%DEFINITELY_NOT_SET_ZL123%\\app.exe"),
            "%DEFINITELY_NOT_SET_ZL123%\\app.exe".to_string()
        );
    }

    #[test]
    fn known_variables_expand() {
        let root = std::env::var("SystemRoot").expect("SystemRoot is always set on Windows");
        assert_eq!(
            expand_env("%SystemRoot%\\notepad.exe"),
            format!("{root}\\notepad.exe")
        );
    }
}

#[cfg(test)]
mod preview_tests {
    use super::{preview_mime, project_slug, source_overlaps_projects};
    use std::path::Path;

    #[test]
    fn preview_mime_is_case_insensitive_and_safe_by_default() {
        assert_eq!(preview_mime("scan.JPEG"), "image/jpeg");
        assert_eq!(preview_mime("main.rs"), "text/plain");
        assert_eq!(preview_mime("unknown.bin"), "application/octet-stream");
    }

    #[test]
    fn project_names_become_safe_readable_folder_prefixes() {
        assert_eq!(project_slug(" Copenhagen Trip "), "copenhagen-trip");
        assert_eq!(project_slug("安全"), "project");
        assert!(!project_slug("../../Windows").contains('.'));
    }

    #[test]
    fn source_imports_cannot_contain_or_be_contained_by_projects() {
        let projects = Path::new(r"C:\sovereign\projects");
        assert!(source_overlaps_projects(projects, Path::new(r"C:\sovereign")));
        assert!(source_overlaps_projects(
            projects,
            Path::new(r"C:\sovereign\projects\alpha")
        ));
        assert!(!source_overlaps_projects(projects, Path::new(r"C:\drawings")));
    }
}
#[cfg(test)]
mod path_containment {
    use super::*;

    #[test]
    fn tidy_strips_the_extended_length_prefix() {
        assert_eq!(tidy(Path::new(r"\\?\C:\Reports\turbine.docx")), r"C:\Reports\turbine.docx");
        // The UNC form has to come back with both leading backslashes or the
        // result names a local directory called `server`.
        assert_eq!(tidy(Path::new(r"\\?\UNC\plant-nas\shared\sop.pdf")), r"\\plant-nas\shared\sop.pdf");
        // A plain path is left exactly as it was.
        assert_eq!(tidy(Path::new(r"C:\Reports")), r"C:\Reports");
    }

    #[test]
    fn a_sibling_that_shares_a_prefix_is_not_inside() {
        // The reason this is component-wise. `C:\Data` is a string prefix of
        // `C:\Database`, and a check built on `starts_with` over the raw text
        // would place an unrelated folder inside a protected root.
        assert!(!within(Path::new(r"C:\Data"), Path::new(r"C:\Database\report.docx")));
        assert!(within(Path::new(r"C:\Data"), Path::new(r"C:\Data\report.docx")));
    }

    #[test]
    fn casing_and_the_prefix_do_not_change_the_answer() {
        // One side canonical, the other as an operator typed it: the same folder.
        assert!(within(Path::new(r"\\?\C:\Plant\Reports"), Path::new(r"c:\plant\reports\weld.docx")));
        assert!(within(Path::new(r"C:\Plant\Reports"), Path::new(r"\\?\C:\PLANT\REPORTS")));
    }

    #[test]
    fn a_root_is_inside_itself_and_a_parent_is_not() {
        // `list` asks for the root itself, so equality has to count as inside.
        assert!(within(Path::new(r"C:\Plant"), Path::new(r"C:\Plant")));
        assert!(!within(Path::new(r"C:\Plant\Reports"), Path::new(r"C:\Plant")));
    }

    /// The mistake this tolerates is the single most common one a model makes
    /// with a workspace-relative path, and it used to surface to the operator as
    /// a red step reading `The folder "turbine-reports" could not be listed`
    /// about the folder they had just opened.
    #[test]
    fn a_path_may_repeat_the_open_folders_own_name() {
        let root = std::env::temp_dir().join(format!("sovereign-repeat-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&root);

        // The bare name means the root itself.
        assert_eq!(
            without_repeated_root(&root, Path::new(root.file_name().unwrap())),
            Some(PathBuf::new())
        );
        // And a file under it means that file.
        let named = PathBuf::from(root.file_name().unwrap()).join("thickness-log.csv");
        assert_eq!(
            without_repeated_root(&root, &named),
            Some(PathBuf::from("thickness-log.csv"))
        );
        // Casing is not what decides it: Windows paths are case-insensitive.
        let shouted = PathBuf::from(root.file_name().unwrap().to_string_lossy().to_uppercase())
            .join("log.csv");
        assert_eq!(without_repeated_root(&root, &shouted), Some(PathBuf::from("log.csv")));

        // Any other first segment is left alone, whether or not it exists.
        assert_eq!(without_repeated_root(&root, Path::new("reports/march.docx")), None);

        // And a workspace that really does hold a folder named after itself
        // keeps the literal reading — the child wins, so nothing is lost.
        let twin = root.join(root.file_name().unwrap());
        let _ = std::fs::create_dir_all(&twin);
        assert_eq!(without_repeated_root(&root, &named), None);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_root_contains_nothing() {
        // A caller that lost its root must not end up with a check that passes
        // everything. This is the `!r.is_empty()` guard.
        assert!(!within(Path::new(""), Path::new(r"C:\Plant\Reports")));
    }
}
