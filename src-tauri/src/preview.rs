//! Loopback preview servers: a folder in an open workspace, served to the
//! operator's own browser.
//!
//! The tool that lands here is `serve_folder`, and the run it answers is the
//! one that ends "host it locally and give me the link". The sandbox cannot
//! do that — `run_command` is synchronous and per-call approved, so a
//! `python -m http.server` would block its own run and then be killed by the
//! sandbox timeout, and the link would be dead before the operator clicked
//! it. A first-class server, bound to loopback and owned by the app, is the
//! same shape as the two servers the workbench already runs (`web.rs` for
//! browser access, llama-server for inference), so it adds no new kind of
//! exposure: nothing leaves the machine, and only files inside an approved
//! workspace are reachable.
//!
//! A preview is not a private mechanism. It registers in the same
//! `devserver` registry the UI reads and `devserver://status` reports, so the
//! composer bar shows it with its verified URL, Stop works, and there is one
//! source of truth for everything reachable on loopback — a URL printed in a
//! chat that the registry does not know about is exactly the class of lie
//! this module exists to prevent.
//!
//! The chat transcript that names the URL is immutable, so the promise
//! "stays live after this run ends" has to survive an app restart too. Every
//! binding is persisted (`db::previews`) and re-bound at startup, preferring
//! the stored port: after a restart the old link points at the same folder
//! again. Servers are keyed by folder — a second `serve_folder` on a folder
//! already being served returns the existing port rather than a second
//! listener.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::net::TcpListener as StdListener;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::Notify;
use tower_http::services::ServeDir;

use crate::devserver;
use crate::error::{CoreError, CoreResult};
use crate::state::{now_ms, AppState};
use crate::types::{DevServerState, DevServerStatus};

/// Where a preview's deterministic port lives. Derived from the folder path so
/// a binding that lost its row (or a collision fallback at startup) usually
/// lands on the same port the old URL named anyway.
const PORT_LO: u16 = 49000;
const PORT_HI: u16 = 50000;

/// How long the readiness probe may take. The server is in-process, so this
/// only covers the first accept scheduling; anything longer means the bind
/// itself is broken.
const READY_TIMEOUT: Duration = Duration::from_secs(5);

struct Preview {
    port: u16,
    /// Fired by `kill`; the axum task's graceful-shutdown signal.
    shutdown: Arc<Notify>,
}

/// The running preview servers, one per served folder.
pub struct Previews {
    /// Folder root → live server. Guarded by a std mutex; nothing here is
    /// held across an await.
    servers: Mutex<HashMap<PathBuf, Preview>>,
}

impl Previews {
    pub fn new() -> Self {
        Self { servers: Mutex::new(HashMap::new()) }
    }

    /// The live binding for a folder, if it has one.
    pub fn binding(&self, root: &Path) -> Option<(u16, Arc<Notify>)> {
        self.servers
            .lock()
            .expect("preview servers lock")
            .get(root)
            .map(|p| (p.port, p.shutdown.clone()))
    }

    /// Drops the folder's binding, if present, returning the port it held.
    /// Called by the registry's kill closure so `devserver_stop` works on
    /// previews exactly as it does on spawned servers.
    pub fn remove(&self, root: &Path) -> Option<u16> {
        self.servers
            .lock()
            .expect("preview servers lock")
            .remove(root)
            .map(|p| p.port)
    }
}

/// The deterministic port for a folder: a stable hash of the path folded into
/// the preview range. Not a guarantee — collisions fall back — but the common
/// case is a folder getting the same port in every launch.
fn stable_port(root: &Path) -> u16 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    root.to_string_lossy().to_lowercase().hash(&mut hasher);
    let h = hasher.finish();
    PORT_LO + (h % (PORT_HI - PORT_LO) as u64) as u16
}

/// What `serve` produced, for the tool note and the registry alike.
pub struct PreviewInfo {
    pub status: DevServerStatus,
    /// Whether the folder is on disk at all.
    pub folder_exists: bool,
    /// Whether the folder has an entry file, so `/` answers with a page.
    ///
    /// A folder with no `index.html` is served exactly as faithfully as one with
    /// it — and every request 404s. That is the shape of "it said it hosted the
    /// site and the page is blank", so the tool note says it outright rather
    /// than reporting a healthy server.
    pub has_index: bool,
}

/// Whether `/` will answer with a page: `ServeDir` appends `index.html` for a
/// directory request and 404s when there is none.
fn has_index(root: &Path) -> bool {
    ["index.html", "index.htm"]
        .iter()
        .any(|name| root.join(name).is_file())
}

/// Serves `root` at `http://127.0.0.1:<port>/`, reusing the listener if this
/// exact folder is already being served, and registering the server in the
/// dev-server registry so the UI and the commands see it.
///
/// `root` may not exist yet — a run can serve the folder it is about to fill,
/// and a project can be deleted under a server that is already running. Rather
/// than refuse, the server binds anyway and serves 404s until the folder
/// appears; `PreviewInfo` reports both that and a missing entry file so the
/// caller can say which of the two is wrong.
pub async fn serve(
    st: &Arc<AppState>,
    workspace_id: &str,
    root: &Path,
    rel: &str,
) -> CoreResult<PreviewInfo> {
    serve_with_preferred(st, workspace_id, root, rel, None).await
}

/// Startup re-binding of a persisted preview: the stored port is preferred so
/// the URL an earlier chat named points here again. A port taken by someone
/// else falls back to the deterministic one, then to any free port.
pub async fn restore(
    st: &Arc<AppState>,
    workspace_id: &str,
    root: &Path,
    rel: &str,
    port: u16,
) -> CoreResult<PreviewInfo> {
    serve_with_preferred(st, workspace_id, root, rel, Some(port)).await
}

/// The kill closure: the whole lifecycle in one function. Forgets the folder
/// binding, forgets the persisted row (an explicit Stop stays stopped), and
/// signals the axum task to wind down.
fn kill_for(st: &Arc<AppState>, root: &Path, shutdown: &Arc<Notify>) -> Arc<dyn Fn() + Send + Sync> {
    let root = root.to_path_buf();
    let st = st.clone();
    let shutdown = shutdown.clone();
    Arc::new(move || {
        st.previews.remove(&root);
        let _ = st.with_db(|conn| crate::db::delete_preview(conn, &root.display().to_string()));
        shutdown.notify_waiters();
    })
}

async fn serve_with_preferred(
    st: &Arc<AppState>,
    workspace_id: &str,
    root: &Path,
    rel: &str,
    preferred: Option<u16>,
) -> CoreResult<PreviewInfo> {
    // Reuse: the same folder is one server no matter who asks or how often.
    if let Some((port, shutdown)) = st.previews.binding(root) {
        let status = DevServerStatus {
            workspace_id: workspace_id.to_string(),
            cwd: root.display().to_string(),
            command: format!("serve {rel}"),
            pid: std::process::id(),
            port: Some(port),
            url: Some(format!("http://127.0.0.1:{port}/")),
            status: DevServerState::Running,
            started_at: now_ms(),
            error: None,
            output: vec![],
        };
        // Still register for this workspace: a second workspace sharing the
        // folder, or a re-serve after the registry entry was replaced, gets
        // its own entry pointing at the one listener — with a working Stop.
        devserver::register_inprocess(st, status.clone(), kill_for(st, root, &shutdown));
        return Ok(PreviewInfo {
            status,
            folder_exists: root.is_dir(),
            has_index: has_index(root),
        });
    }

    let folder_exists = root.is_dir();
    // Port choice: the stored one (a restart re-binding what an old URL
    // names), then the deterministic one, then whatever the OS picks. A
    // preview never shadows the app's own loopback listeners by range.
    let mut candidates: Vec<u16> = Vec::new();
    if let Some(p) = preferred {
        candidates.push(p);
    }
    candidates.push(stable_port(root));
    let std_listener = candidates
        .iter()
        .find_map(|p| try_bind(*p))
        .or_else(|| try_bind(0))
        .ok_or_else(|| {
            CoreError::ExecutionFailed(format!(
                "Could not bind a loopback port to serve {}",
                root.display()
            ))
        })?;
    std_listener
        .set_nonblocking(true)
        .map_err(|e| CoreError::ExecutionFailed(format!("Could not configure the preview listener: {e}")))?;
    let port = std_listener
        .local_addr()
        .map_err(|e| CoreError::ExecutionFailed(format!("Could not read the bound port: {e}")))?
        .port();

    // ServeDir answers from disk per request — no snapshot — so files the
    // operator accepts later, and later edits, are picked up on refresh
    // without anything here being told.
    let shutdown = Arc::new(Notify::new());
    let app = axum::Router::new().fallback_service(ServeDir::new(root.to_path_buf()));
    let task_shutdown = shutdown.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            // Nothing to report to and nothing to serve; the port is simply
            // not registered below because this task ends here.
            Err(_) => return,
        };
        // The shutdown future must own its Arc: `notified()` borrows the
        // Notify, and graceful shutdown requires 'static.
        let stop = async move {
            task_shutdown.notified().await;
        };
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(stop)
            .await;
    });

    let url = format!("http://127.0.0.1:{port}/");
    // The bind alone proves nothing to the operator, who only has the URL:
    // verify it answers, the same bar a spawned dev server has to clear.
    let probe_deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let probe = st.http.get(&url).timeout(Duration::from_secs(3)).send().await;
        if probe.is_ok() {
            break;
        }
        if Instant::now() >= probe_deadline {
            // Unbind what we just bound: a half-server registered as Running
            // would put a dead link in the UI, the exact thing this module
            // exists to make impossible.
            let shutdown = shutdown.clone();
            shutdown.notify_waiters();
            return Err(CoreError::ExecutionFailed(format!(
                "The preview server bound port {port} but never answered on {url}."
            )));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // Persist before registering, so a crash between the two cannot leave the
    // registry claiming a server no restart will bring back.
    let root_str = root.display().to_string();
    // Reported rather than dropped. This write failing is exactly how the
    // "the link stopped working after I reopened the app" bug hid: the row
    // never landed, `restore_all` found nothing, and no line said why.
    if let Err(e) = st.with_db(|conn| crate::db::upsert_preview(conn, &root_str, workspace_id, rel, port)) {
        eprintln!(
            "[preview] {root_str} is being served on {port} but could not be remembered ({e}); it will not come back automatically after a restart."
        );
    }

    let kill = kill_for(st, root, &shutdown);

    let status = DevServerStatus {
        workspace_id: workspace_id.to_string(),
        cwd: root_str.clone(),
        command: format!("serve {rel}"),
        pid: std::process::id(),
        port: Some(port),
        url: Some(url),
        status: DevServerState::Running,
        started_at: now_ms(),
        error: None,
        output: vec![],
    };
    st.previews
        .servers
        .lock()
        .expect("preview servers lock")
        .insert(root.to_path_buf(), Preview { port, shutdown });
    devserver::register_inprocess(st, status.clone(), kill);
    Ok(PreviewInfo { status, folder_exists, has_index: has_index(root) })
}

/// Re-establishes every persisted preview at startup. Rows whose folder has
/// vanished (a project deleted, a drive unplugged) are dropped rather than
/// re-created as 404 machines.
pub async fn restore_all(st: &Arc<AppState>) {
    let rows = match st.with_db(crate::db::previews) {
        Ok(rows) => rows,
        Err(e) => {
            eprintln!("[preview] the remembered previews could not be read ({e}); none were re-served.");
            return;
        }
    };
    for row in rows {
        let root = PathBuf::from(&row.root);
        if !root.is_dir() {
            let _ = st.with_db(|conn| crate::db::delete_preview(conn, &row.root));
            continue;
        }
        if let Err(e) = restore(st, &row.workspace_id, &root, &row.rel, row.port).await {
            eprintln!("[preview] could not re-serve {}: {e}", row.root);
        }
    }
}

/// Binds `port` (0 = any), returning the listener, or `None` when the port is
/// taken — the caller falls through to its next candidate.
fn try_bind(port: u16) -> Option<StdListener> {
    StdListener::bind(("127.0.0.1", port)).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_folder_hash_maps_into_the_preview_port_range() {
        let p = stable_port(Path::new("C:/sovereign/projects/demo"));
        assert!((PORT_LO..PORT_HI).contains(&p));
        // Deterministic: the same folder wants the same port every launch.
        assert_eq!(p, stable_port(Path::new("C:/sovereign/projects/demo")));
        // And not every folder collapses onto one port.
        let q = stable_port(Path::new("C:/sovereign/projects/other"));
        assert_ne!(p, q);
    }
}
