//! §11 — is anything on this machine copying our files somewhere else?
//!
//! An air-gapped workbench is only air-gapped if the folders it writes to stay
//! on the disk. A cloud-sync client is the one way that stops being true without
//! any code in this application doing anything wrong: the operator saves an
//! inspection report into a synced folder, a background service uploads it, and
//! the sovereignty guarantee is broken by a program we never called.
//!
//! The first version of this check matched the *folder name* against
//! `/onedrive|dropbox|.../` and was wrong. On the machine this was built on,
//! `C:\Users\harih\OneDrive\Documents\ocr` is an ordinary local directory: no
//! OneDrive account is configured, no sync root is registered, no sync process
//! runs, and not one file carries a cloud attribute. The warning fired anyway,
//! because a string matched a string. A security control that cries wolf is
//! worse than no control — the operator learns to dismiss it, and the day it is
//! right they dismiss it too.
//!
//! So this module never looks at the path text. It asks the operating system
//! three questions, in increasing order of authority:
//!
//!   1. **Is a sync client running?** A process scan against a table of known
//!      executables. On its own this proves nothing about *our* folders — a
//!      running Dropbox says Dropbox syncs something, not that it syncs this.
//!      Reported, never decisive.
//!   2. **Is a sync root registered that contains this path?** Read from
//!      `Explorer\SyncRootManager` (the Cloud Files API registration every
//!      modern provider uses), `SyncEngines\Providers`, and OneDrive's own
//!      per-account `UserFolder`. Containment is structural — both sides
//!      canonicalised and compared component by component — so a junction
//!      cannot hide inside a root and a name cannot fake its way into one.
//!      Decisive.
//!   3. **Do the files themselves carry cloud attributes?** `RECALL_ON_OPEN`,
//!      `RECALL_ON_DATA_ACCESS` and `OFFLINE` mark a placeholder whose contents
//!      live on a server; `PINNED`/`UNPINNED` are set only by a cloud filter
//!      driver, so they mark a folder under sync management even when every file
//!      in it happens to be hydrated. Decisive.
//!
//! Note what is deliberately *not* evidence. `HKCU\Software\Microsoft\OneDrive`
//! exists on every Windows 11 install whether or not anyone signed in, and the
//! `cldflt` cloud-files filter driver is running right now on the build machine
//! with nothing to filter. Both would produce exactly the false positive this
//! module exists to remove. Reading metadata does not hydrate a placeholder
//! either, so on a machine where sync *is* real this scan does not pull a single
//! byte down from anyone's server.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use crate::fsops::tidy;
use std::sync::Arc;

use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
use winreg::RegKey;

use crate::error::CoreResult;
use crate::state::{now_ms, AppState};
use crate::types::*;

/* ------------------------------------------------------------------ */
/* Windows constants                                                   */
/* ------------------------------------------------------------------ */

/// Contents are not on local media. Set by sync engines and by tape/HSM tiers.
const FILE_ATTRIBUTE_OFFLINE: u32 = 0x0000_1000;
/// A junction, a symbolic link, or a cloud placeholder.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
/// Opening the file at all fetches it from the provider.
const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
/// Reading the file's data fetches it; metadata is local. Modern OneDrive.
const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
/// "Always keep on this device". Only a cloud filter driver sets this.
const FILE_ATTRIBUTE_PINNED: u32 = 0x0008_0000;
/// "Free up space". Likewise only ever set by a cloud filter driver.
const FILE_ATTRIBUTE_UNPINNED: u32 = 0x0010_0000;

const PLACEHOLDER_MASK: u32 =
    FILE_ATTRIBUTE_OFFLINE | FILE_ATTRIBUTE_RECALL_ON_OPEN | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
const PIN_MASK: u32 = FILE_ATTRIBUTE_PINNED | FILE_ATTRIBUTE_UNPINNED;

/// How many files to look at per path. A sync engine marks *every* entry it
/// manages, so the first handful settle the question; the cap exists so opening
/// Settings never stats a hundred thousand files.
const MAX_FILES_CHECKED: u32 = 900;

/// Deep enough to reach past a wrapper folder, shallow enough to stay quick.
const MAX_DEPTH: usize = 4;

/// Skipped so the sample describes the operator's documents rather than a build
/// tree. A sync engine would mark these too, but 900 files of `target/` tells
/// nobody anything about the folder they actually care about.
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", ".next", "__pycache__", ".venv", "venv",
    ".cache", "vendor",
];

/// Executables that replicate a local folder to somewhere else, by file stem.
///
/// Matched on equality, not substring: `box` must not be found inside
/// `sandbox`, and `sync` would match half the processes on a Windows machine.
/// Updaters and shell-extension hosts are left out on purpose — `OneDriveSetup`
/// running is not replication, and counting it would put this check back in the
/// business of false positives.
const SYNC_CLIENTS: &[(&str, &str)] = &[
    ("onedrive", "Microsoft OneDrive"),
    ("dropbox", "Dropbox"),
    ("googledrivefs", "Google Drive"),
    ("drivefs", "Google Drive"),
    ("googledrivesync", "Google Drive (legacy client)"),
    ("icloudservices", "iCloud Drive"),
    ("iclouddrive", "iCloud Drive"),
    ("box", "Box Drive"),
    ("boxdrive", "Box Drive"),
    ("nextcloud", "Nextcloud"),
    ("owncloud", "ownCloud"),
    ("syncthing", "Syncthing"),
    ("megasync", "MEGAsync"),
    ("pcloud", "pCloud Drive"),
    ("seadrive", "Seafile Drive"),
    ("resilio sync", "Resilio Sync"),
    ("btsync", "Resilio Sync (legacy client)"),
    ("tresorit", "Tresorit"),
    ("egnyteclient", "Egnyte"),
    ("yandex.disk", "Yandex.Disk"),
    ("sugarsync", "SugarSync"),
    ("cloudstation", "Synology Drive"),
    ("synology drive", "Synology Drive"),
];

const SYNC_ROOT_MANAGER: &str =
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\SyncRootManager";

/* ------------------------------------------------------------------ */
/* Path comparison                                                     */
/* ------------------------------------------------------------------ */

/// True when `target` is `root` or lies inside it.
///
/// [`fsops::within`] does the comparison; what belongs here is the treatment of a
/// root that will not canonicalise — a registered sync root on a drive that is
/// not mounted. That falls back to the raw registry text rather than returning
/// false, because failing to resolve a path must not be able to hide a
/// replication relationship.
///
/// [`fsops::within`]: crate::fsops::within
fn is_under(root: &str, target_canonical: &Path) -> bool {
    let root_path = std::fs::canonicalize(root)
        .unwrap_or_else(|_| std::path::PathBuf::from(root.trim_end_matches(['\\', '/'])));
    crate::fsops::within(&root_path, target_canonical)
}

/* ------------------------------------------------------------------ */
/* Evidence 1 — running clients                                        */
/* ------------------------------------------------------------------ */

/// Sync clients found running, by product name, deduplicated and sorted.
///
/// One scan per report rather than one per path: the answer is a property of the
/// machine, and enumerating every process six times to learn the same thing
/// would be the slowest part of opening Settings.
fn running_clients() -> Vec<String> {
    let mut sys = sysinfo::System::new();
    // `nothing()` still yields the process name — that is all this needs, and
    // asking for memory and CPU would make the scan cost real money.
    sys.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::nothing(),
    );

    let mut found: BTreeSet<&'static str> = BTreeSet::new();
    for proc_ in sys.processes().values() {
        let name = proc_.name().to_string_lossy().to_lowercase();
        let stem = name.strip_suffix(".exe").unwrap_or(name.as_str());
        if let Some((_, label)) = SYNC_CLIENTS.iter().find(|(exe, _)| *exe == stem) {
            found.insert(label);
        }
    }
    found.into_iter().map(str::to_string).collect()
}

/* ------------------------------------------------------------------ */
/* Evidence 2 — registered sync roots                                  */
/* ------------------------------------------------------------------ */

/// A folder some provider has told Windows it replicates.
struct Root {
    label: String,
    path: String,
    source: &'static str,
}

/// Adds a root, ignoring blanks and duplicates.
///
/// Duplicates are common and meaningless: OneDrive registers the same folder in
/// `SyncRootManager` and again under its own `Accounts` key, and reporting it
/// twice would suggest two things are syncing it.
fn push_root(out: &mut Vec<Root>, label: String, path: String, source: &'static str) {
    let path = path.trim().trim_end_matches(['\\', '/']).to_string();
    if path.is_empty() || path.len() < 3 {
        return;
    }
    let key = path.to_lowercase();
    if out.iter().any(|r| r.path.to_lowercase() == key) {
        return;
    }
    out.push(Root { label, path, source });
}

/// Reads a `REG_SZ` value, or nothing.
fn reg_str(key: &RegKey, name: &str) -> Option<String> {
    key.get_value::<String, _>(name).ok().filter(|s| !s.trim().is_empty())
}

/// Pulls mount points out of a `SyncEngines` provider subtree.
///
/// Providers disagree about where the folder goes and how deep the instance keys
/// sit, so this reads the three names that are actually used in the wild and
/// recurses a bounded distance rather than hard-coding one vendor's layout.
fn collect_mount_points(key: &RegKey, label: &str, out: &mut Vec<Root>, depth: u32) {
    for name in ["MountPoint", "LocalDirectory", "Path", "UserFolder"] {
        if let Some(p) = reg_str(key, name) {
            push_root(out, label.to_string(), p, "SyncEngines provider registration");
        }
    }
    if depth == 0 {
        return;
    }
    for child in key.enum_keys().flatten() {
        if let Ok(sub) = key.open_subkey_with_flags(&child, KEY_READ) {
            collect_mount_points(&sub, label, out, depth - 1);
        }
    }
}

/// Every folder registered as replicated on this machine.
///
/// Three sources, because no single one is complete: the Cloud Files API
/// registration under `SyncRootManager` (OneDrive, Dropbox, Google Drive,
/// iCloud, Box on current versions), the older `SyncEngines\Providers`
/// convention, and OneDrive's own per-account `UserFolder`. All three name a
/// folder somebody configured; none of them can be produced by a folder simply
/// being *called* something.
fn registered_roots() -> Vec<Root> {
    let mut out: Vec<Root> = Vec::new();
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);

    /* (a) Cloud Files API sync roots, per user and machine-wide. */
    for hive in [&hkcu, &hklm] {
        let manager = match hive.open_subkey_with_flags(SYNC_ROOT_MANAGER, KEY_READ) {
            Ok(k) => k,
            Err(_) => continue,
        };
        for id in manager.enum_keys().flatten() {
            // Ids look like `OneDrive!S-1-5-21-…!Personal`; the provider moniker
            // is the readable part and the rest is an account identifier we have
            // no business displaying.
            let label = id.split('!').next().unwrap_or(&id).to_string();
            let root = match manager.open_subkey_with_flags(&id, KEY_READ) {
                Ok(k) => k,
                Err(_) => continue,
            };
            // The authoritative location: one value per user SID.
            if let Ok(users) = root.open_subkey_with_flags("UserSyncRoots", KEY_READ) {
                for (name, _) in users.enum_values().flatten() {
                    if let Some(p) = reg_str(&users, &name) {
                        push_root(&mut out, label.clone(), p, "Windows sync-root registration");
                    }
                }
            }
            if let Some(p) = reg_str(&root, "Path") {
                push_root(&mut out, label.clone(), p, "Windows sync-root registration");
            }
        }
    }

    /* (b) The older per-provider convention. */
    if let Ok(providers) = hkcu.open_subkey_with_flags(r"Software\SyncEngines\Providers", KEY_READ) {
        for provider in providers.enum_keys().flatten() {
            if let Ok(key) = providers.open_subkey_with_flags(&provider, KEY_READ) {
                collect_mount_points(&key, &provider, &mut out, 2);
            }
        }
    }

    /* (c) OneDrive's own account records.
       Keyed on a configured `UserFolder` and nothing weaker. The parent key
       `Software\Microsoft\OneDrive` exists on every Windows 11 machine — using
       its presence as evidence is the false positive this module removes. */
    if let Ok(accounts) =
        hkcu.open_subkey_with_flags(r"Software\Microsoft\OneDrive\Accounts", KEY_READ)
    {
        for account in accounts.enum_keys().flatten() {
            if let Ok(key) = accounts.open_subkey_with_flags(&account, KEY_READ) {
                if let Some(p) = reg_str(&key, "UserFolder") {
                    push_root(
                        &mut out,
                        format!("Microsoft OneDrive ({account})"),
                        p,
                        "OneDrive account folder",
                    );
                }
            }
        }
    }

    out
}

/* ------------------------------------------------------------------ */
/* Evidence 3 — file attributes                                        */
/* ------------------------------------------------------------------ */

#[derive(Default)]
struct Scan {
    files: u32,
    placeholders: u32,
    pinned: u32,
    reparse: u32,
    /// One named file, so a positive result can be checked by hand.
    example: Option<String>,
    /// True when the cap stopped the walk, so `files` is a sample not a total.
    truncated: bool,
}

/// Counts cloud attributes under `root`, bounded in depth and in file count.
///
/// `symlink_metadata` semantics throughout: walkdir does not follow links unless
/// told to, and a placeholder is precisely a file we must not open. Reading
/// attributes never triggers a recall, so this is safe to run against a folder
/// that genuinely is syncing.
fn scan_attributes(root: &Path) -> Scan {
    use std::os::windows::fs::MetadataExt;

    let mut s = Scan::default();

    // The folder itself first. A sync root's own directory carries the pin state
    // and a reparse point even when the files inside it are all hydrated.
    if let Ok(md) = std::fs::symlink_metadata(root) {
        let a = md.file_attributes();
        if a & PIN_MASK != 0 {
            s.pinned += 1;
        }
        if a & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            s.reparse += 1;
        }
        if a & PLACEHOLDER_MASK != 0 {
            s.placeholders += 1;
            s.example = Some(tidy(root));
        }
    }

    let walk = walkdir::WalkDir::new(root)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0
                || !e.file_type().is_dir()
                || !e
                    .file_name()
                    .to_str()
                    .map(|n| SKIP_DIRS.contains(&n))
                    .unwrap_or(false)
        });

    for entry in walk.filter_map(Result::ok) {
        if entry.depth() == 0 {
            continue;
        }
        if s.files >= MAX_FILES_CHECKED {
            s.truncated = true;
            break;
        }
        let md = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let a = md.file_attributes();

        if a & PIN_MASK != 0 {
            s.pinned += 1;
        }
        if a & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            s.reparse += 1;
        }
        if !md.is_dir() {
            s.files += 1;
            if a & PLACEHOLDER_MASK != 0 {
                s.placeholders += 1;
                if s.example.is_none() {
                    s.example = Some(tidy(entry.path()));
                }
            }
        }
    }

    s
}

/* ------------------------------------------------------------------ */
/* The verdict                                                         */
/* ------------------------------------------------------------------ */

/// Machine-wide facts, gathered once and reused for every path in a report.
struct Facts {
    clients: Vec<String>,
    roots: Vec<Root>,
}

impl Facts {
    fn gather() -> Self {
        Facts {
            clients: running_clients(),
            roots: registered_roots(),
        }
    }

    fn client_summary(&self) -> Option<String> {
        if self.clients.is_empty() {
            None
        } else {
            Some(self.clients.join(", "))
        }
    }
}

/// What may be said about a folder that would not open, and whether that counts
/// as having examined it.
///
/// *Why* it would not open decides what may be said. A folder that is not there
/// yet is the ordinary case on a fresh install and holds nothing to replicate —
/// that is a finding. Any other failure — a denied ACL, a disconnected network
/// drive, a path Windows will not resolve — is a folder that exists as far as
/// anyone here knows and was never looked at, which is not. This used to assert
/// "it is created when the feature that uses it first runs" over every error
/// alike: a guess, printed as a finding, about a folder that might well be
/// replicating.
fn unopenable(e: &std::io::Error) -> (bool, String) {
    if e.kind() == std::io::ErrorKind::NotFound {
        (
            true,
            "This folder does not exist yet, so there is nothing in it to replicate. It is \
             created when the feature that uses it first runs, and this check will examine it \
             then."
                .to_string(),
        )
    } else {
        (
            false,
            format!(
                "This folder could not be opened ({e}), so its files were NOT examined and \
                 nothing is claimed about it. That is not the same as finding it clean: a folder \
                 this check cannot read could be replicating without this report seeing it. \
                 Confirm the path in Settings is right and that this account can read it."
            ),
        )
    }
}

/// The exposure of one path, given facts already gathered.
fn exposure_with(label: &str, path: &str, facts: &Facts) -> SyncExposure {
    let canonical = std::fs::canonicalize(path);
    let display = match &canonical {
        Ok(p) => tidy(p),
        Err(_) => path.to_string(),
    };
    let client_running = facts.client_summary();

    // Nothing on disk to inspect. Said plainly rather than reported as clean:
    // "no evidence of replication" and "nothing was examined" are different
    // findings and a report that conflates them is not evidence of anything.
    let canonical = match canonical {
        Ok(p) => p,
        Err(e) => {
            let (examined, mut detail) = unopenable(&e);
            detail.push(' ');
            detail.push_str(&roots_sentence(facts, None));
            detail.push(' ');
            detail.push_str(&clients_sentence(facts));
            return SyncExposure {
                label: label.to_string(),
                path: display,
                replicated: false,
                client_running,
                registered_root: None,
                placeholder_files: 0,
                pin_marked_files: 0,
                reparse_points: 0,
                files_checked: 0,
                examined,
                detail,
            };
        }
    };

    let containing = facts.roots.iter().find(|r| is_under(&r.path, &canonical));
    let registered_root = containing
        .map(|r| format!("{} — {} ({})", r.label, r.path, r.source));

    let scan = scan_attributes(&canonical);

    // The rule, stated once: a registration or a cloud attribute settles it. A
    // running client does not, because it says nothing about *this* folder.
    let replicated =
        registered_root.is_some() || scan.placeholders > 0 || scan.pinned > 0;

    let mut detail = String::new();

    if replicated {
        detail.push_str(
            "Replicated. Files written here leave this machine. Point the setting at a folder \
             outside every sync root before putting confidential work in it.",
        );
    } else {
        detail.push_str("Local only. Nothing on this machine claims to replicate this folder.");
    }

    detail.push(' ');
    detail.push_str(&roots_sentence(facts, containing));
    detail.push(' ');

    /* What the files themselves said. */
    if scan.files == 0 {
        detail.push_str("The folder holds no files yet, so no file attributes were read.");
    } else {
        let scope = if scan.truncated {
            format!("the first {} files", scan.files)
        } else {
            format!("all {} files", scan.files)
        };
        if scan.placeholders > 0 {
            detail.push_str(&format!(
                "{} of {scope} checked ({MAX_DEPTH} levels deep) carry cloud placeholder \
                 attributes — their contents live on a server, not on this disk",
                scan.placeholders
            ));
            if let Some(ex) = &scan.example {
                detail.push_str(&format!(", for example {ex}"));
            }
            detail.push('.');
        } else {
            detail.push_str(&format!(
                "None of {scope} checked ({MAX_DEPTH} levels deep) carry a cloud placeholder \
                 attribute (RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS or OFFLINE)."
            ));
        }
        if scan.pinned > 0 {
            detail.push_str(&format!(
                " {} entries carry PINNED or UNPINNED, which only a cloud sync driver sets — the \
                 folder is under sync management even where its files are downloaded.",
                scan.pinned
            ));
        }
        if scan.reparse > 0 && scan.placeholders == 0 {
            detail.push_str(&format!(
                " {} entries are reparse points. With no cloud attributes present these are \
                 junctions or symbolic links, so part of this tree physically lives elsewhere on \
                 this machine — worth knowing, but not replication off it.",
                scan.reparse
            ));
        }
    }

    detail.push(' ');
    detail.push_str(&clients_sentence(facts));

    detail.push_str(
        " The folder's name is not part of this test. The verdict comes from the sync-root \
         registry and from the files' own attributes, which is why a directory merely called \
         OneDrive, Dropbox or Drive is reported for what it is.",
    );

    SyncExposure {
        label: label.to_string(),
        path: display,
        replicated,
        client_running,
        registered_root,
        placeholder_files: scan.placeholders,
        pin_marked_files: scan.pinned,
        reparse_points: scan.reparse,
        files_checked: scan.files,
        examined: true,
        detail,
    }
}

fn roots_sentence(facts: &Facts, containing: Option<&Root>) -> String {
    match containing {
        Some(r) => format!(
            "It sits inside a sync root registered by {} at {} ({}).",
            r.label, r.path, r.source
        ),
        None if facts.roots.is_empty() => {
            "No sync root is registered on this machine at all — not for this folder and not for \
             any other."
                .to_string()
        }
        None => {
            let n = facts.roots.len();
            let list = facts
                .roots
                .iter()
                .map(|r| format!("{} at {}", r.label, r.path))
                .collect::<Vec<_>>()
                .join("; ");
            format!(
                "No registered sync root contains it. {n} {} registered on this machine: {list}.",
                if n == 1 { "is" } else { "are" }
            )
        }
    }
}

fn clients_sentence(facts: &Facts) -> String {
    match facts.client_summary() {
        None => "No file-sync client is running.".to_string(),
        Some(list) => format!(
            "{list} is running on this machine. That alone does not mean this folder is synced, \
             and it is not counted as evidence that it is — but it is the program that would do it."
        ),
    }
}

/* ------------------------------------------------------------------ */
/* Public surface                                                      */
/* ------------------------------------------------------------------ */

/// Re-runs the check in the background and publishes `core://exposure`.
///
/// Called whenever a folder setting changes or a workspace is added, approved or
/// removed — the three moments an operator points this application at somewhere
/// new. Waiting for them to open the Sovereignty page to find out that the folder
/// they just chose replicates to a server would be telling them too late.
///
/// Fire-and-forget on purpose: the caller is a command that has already done its
/// job, and a folder scan must not be able to make saving a setting feel slow or
/// make it fail. If the check cannot run, no event is published and the page's
/// own fetch is still there to report it.
pub fn refresh(st: &Arc<AppState>) {
    let st = st.clone();
    tauri::async_runtime::spawn(async move {
        if let Ok(report) = exposure_report(&st).await {
            st.emit("core://exposure", report);
        }
    });
}

/// Every folder this application writes to, labelled by the setting that names
/// it, plus the machine-wide facts the per-path verdicts were derived from.
///
/// Labelled by setting rather than by path because "Knowledge folder" is what
/// the operator would change if the answer were bad; a bare path leaves them
/// hunting for which screen owns it. Paths that resolve to the same folder are
/// merged so a shared parent is scanned once and reported once, with both names
/// on it.
pub async fn exposure_report(st: &Arc<AppState>) -> CoreResult<ExposureReport> {
    let s = st.settings();
    let workspaces = st.with_db(crate::db::workspaces)?;

    // Insertion order preserved by hand: a BTreeMap keyed on the path would sort
    // the report alphabetically by folder, which is not the order the operator
    // thinks about these in.
    let mut targets: Vec<(String, String)> = vec![
        ("Harness home".into(), crate::registry::sovereign_root().to_string_lossy().to_string()),
        ("Database and audit log".into(), crate::db::state_dir().to_string_lossy().to_string()),
        ("Models directory".into(), s.models_directory.clone()),
        ("Knowledge folder".into(), s.knowledge_root.clone()),
        ("Sandbox folder".into(), s.sandbox_root.clone()),
        ("Generated artifacts".into(), s.artifact_root.clone()),
        ("Memory mirrors".into(), s.memory_root.clone()),
    ];
    for ws in &workspaces {
        let state = if ws.approved { "approved" } else { "not approved" };
        for (index, folder) in ws.folders.iter().enumerate() {
            let role = if folder.is_primary { "primary" } else { "secondary" };
            targets.push((
                format!("Project \"{}\" folder {} ({role}, {state})", ws.name, index + 1),
                folder.path.clone(),
            ));
        }
    }

    // Merge duplicates on the resolved path where it resolves, on the text where
    // it does not.
    let mut order: Vec<String> = Vec::new();
    let mut merged: BTreeMap<String, (String, String)> = BTreeMap::new();
    for (label, path) in targets {
        if path.trim().is_empty() {
            continue;
        }
        let key = std::fs::canonicalize(&path)
            .map(|p| tidy(&p).to_lowercase())
            .unwrap_or_else(|_| path.trim_end_matches(['\\', '/']).to_lowercase());
        match merged.get_mut(&key) {
            Some((existing, _)) => {
                if !existing.contains(&label) {
                    existing.push_str(" · ");
                    existing.push_str(&label);
                }
            }
            None => {
                order.push(key.clone());
                merged.insert(key, (label, path));
            }
        }
    }
    let work: Vec<(String, String)> = order
        .into_iter()
        .filter_map(|k| merged.remove(&k))
        .collect();

    // One blocking task for the whole report: the registry reads and the file
    // walk are synchronous, and doing them on the runtime's worker would stall
    // token streaming for however long a cold folder takes to stat.
    let (paths, clients_running, registered_roots) = tokio::task::spawn_blocking(move || {
        let facts = Facts::gather();
        let rows: Vec<SyncExposure> = work
            .iter()
            .map(|(label, path)| exposure_with(label, path, &facts))
            .collect();
        let roots = facts
            .roots
            .iter()
            .map(|r| format!("{} — {} ({})", r.label, r.path, r.source))
            .collect::<Vec<_>>();
        (rows, facts.clients, roots)
    })
    .await
    .map_err(|e| {
        crate::error::CoreError::ExecutionFailed(format!(
            "The replication check could not be run ({e}), so nothing is claimed about these folders."
        ))
    })?;

    let any_replicated = paths.iter().any(|p| p.replicated);
    // A folder that could not be opened has not been cleared, and the summary is
    // the one line most operators will read. It used to say "All N folders are
    // local" on the strength of `any_replicated == false`, which is also false for
    // a folder nothing looked at.
    let unexamined: Vec<&str> =
        paths.iter().filter(|p| !p.examined).map(|p| p.label.as_str()).collect();
    let caveat = match unexamined.as_slice() {
        [] => String::new(),
        names => format!(
            " {} could not be opened and {} not examined, so {} not covered by this: {}.",
            if names.len() == 1 { "One folder" } else { "Some folders" },
            if names.len() == 1 { "was" } else { "were" },
            if names.len() == 1 { "it is" } else { "they are" },
            names.join(", ")
        ),
    };

    let summary = if any_replicated {
        let names: Vec<&str> = paths
            .iter()
            .filter(|p| p.replicated)
            .map(|p| p.label.as_str())
            .collect();
        format!(
            "{} of {} folders replicate off this machine: {}.{caveat}",
            names.len(),
            paths.len(),
            names.join(", ")
        )
    } else if !unexamined.is_empty() {
        // Neither "all local" nor "something replicates" is true, so the summary
        // says what it does know and stops there.
        format!(
            "{} of {} folders are local.{caveat}",
            paths.len() - unexamined.len(),
            paths.len()
        )
    } else if registered_roots.is_empty() && clients_running.is_empty() {
        format!(
            "All {} folders are local. No sync client is running and no sync root is registered on \
             this machine, so there is nothing here that could copy a file off it.",
            paths.len()
        )
    } else {
        format!(
            "All {} folders are local. Sync software is present on this machine but none of it is \
             registered against any folder this application writes to.",
            paths.len()
        )
    };

    Ok(ExposureReport {
        clients_running,
        registered_roots,
        paths,
        any_replicated,
        summary,
        checked_at: now_ms(),
    })
}
#[cfg(test)]
mod exposure {
    use super::*;

    /// A machine with no sync client running and no registered sync root.
    fn clean_machine() -> Facts {
        Facts { clients: Vec::new(), roots: Vec::new() }
    }

    #[test]
    fn a_folder_merely_named_onedrive_is_not_reported_as_replicated() {
        // This workstation keeps its work under `C:\Users\...\OneDrive\Documents`
        // with no OneDrive client installed at all — the folder name is a
        // leftover. A check that pattern-matched the name would raise a
        // permanent, unfixable warning on an air-gapped machine, which is the
        // fastest way to teach an operator to ignore the panel. The verdict has
        // to come from the three kinds of evidence, so the name is asserted to
        // carry no weight.
        let dir = std::env::temp_dir().join("sovereign-test-OneDrive\\Documents\\ocr");
        std::fs::create_dir_all(&dir).expect("temp tree");
        std::fs::write(dir.join("inspection.txt"), b"weld log").expect("temp file");

        let e = exposure_with("Test folder", &dir.to_string_lossy(), &clean_machine());

        assert!(!e.replicated, "a folder named OneDrive with no sync evidence must read as local");
        assert_eq!(e.registered_root, None);
        assert_eq!(e.placeholder_files, 0);
        assert_eq!(e.pin_marked_files, 0);
        assert_eq!(e.client_running, None);
        assert!(
            !e.path.starts_with(r"\\?\"),
            "the operator-visible path must not carry the extended-length prefix, got {}",
            e.path
        );

        let _ = std::fs::remove_dir_all(std::env::temp_dir().join("sovereign-test-OneDrive"));
    }

    #[test]
    fn a_registered_root_above_the_folder_is_reported() {
        // The mechanism the previous test says must be the only trigger: with a
        // root actually registered above it, the same tree reads as replicated.
        let dir = std::env::temp_dir().join("sovereign-test-registered\\Documents");
        std::fs::create_dir_all(&dir).expect("temp tree");

        let parent = std::env::temp_dir().join("sovereign-test-registered");
        let facts = Facts {
            clients: Vec::new(),
            roots: vec![Root {
                label: "Test provider".into(),
                path: parent.to_string_lossy().to_string(),
                source: "test",
            }],
        };

        let e = exposure_with("Test folder", &dir.to_string_lossy(), &facts);

        assert!(e.replicated, "a folder under a registered sync root is replicated");
        assert!(e.registered_root.is_some());

        let _ = std::fs::remove_dir_all(parent);
    }

    #[test]
    fn a_running_client_alone_is_context_not_a_verdict() {
        // A sync client running says something on this machine is synced, not
        // that this folder is. Reporting it as the verdict would flag every
        // folder on a workstation that happens to have Dropbox installed.
        let dir = std::env::temp_dir().join("sovereign-test-plainfolder");
        std::fs::create_dir_all(&dir).expect("temp tree");

        let facts = Facts { clients: vec!["OneDrive".into()], roots: Vec::new() };
        let e = exposure_with("Test folder", &dir.to_string_lossy(), &facts);

        assert!(!e.replicated, "a running client must not by itself mark a folder replicated");
        assert_eq!(e.client_running.as_deref(), Some("OneDrive"));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// A folder that is not there yet is the ordinary case on a fresh install:
    /// nothing to examine because there is nothing there, and that *is* a finding.
    #[test]
    fn a_folder_that_does_not_exist_yet_is_examined_and_empty() {
        let dir = std::env::temp_dir().join("sovereign-test-absent-folder-9f2a");
        let _ = std::fs::remove_dir_all(&dir);

        let e = exposure_with("Knowledge folder", &dir.to_string_lossy(), &clean_machine());

        assert!(!e.replicated);
        assert!(e.examined, "a missing folder holds nothing, which is a finding");
        assert!(e.detail.contains("does not exist yet"), "{}", e.detail);
        assert!(e.detail.contains("created when the feature"), "{}", e.detail);
        assert_eq!(e.files_checked, 0);
    }

    /// Every other reason a folder will not open is a folder that was not looked
    /// at. The report used to print "it is created when the feature that uses it
    /// first runs" over all of them alike — a guess about a folder that may well
    /// exist and may well be replicating — and then the summary counted it in
    /// "All N folders are local".
    #[test]
    fn an_unreadable_folder_is_not_described_as_one_that_does_not_exist_yet() {
        use std::io::{Error, ErrorKind};

        let (examined, detail) = unopenable(&Error::from(ErrorKind::NotFound));
        assert!(examined);
        assert!(detail.contains("does not exist yet"), "{detail}");

        for kind in [ErrorKind::PermissionDenied, ErrorKind::InvalidInput, ErrorKind::Other] {
            let (examined, detail) = unopenable(&Error::from(kind));
            assert!(!examined, "{kind:?} means nothing was examined");
            assert!(!detail.contains("does not exist yet"), "{kind:?}: {detail}");
            assert!(detail.contains("NOT examined"), "{kind:?}: {detail}");
            assert!(
                detail.contains("not the same as finding it clean"),
                "the distinction is the point of the field — {kind:?}: {detail}"
            );
        }
    }
}
