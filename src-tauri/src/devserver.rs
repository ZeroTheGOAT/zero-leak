//! Persistent development servers, one per workspace.
//!
//! Why this module exists: `run_command` starts a dev server inside the
//! sandbox, which kills the whole process tree the moment the command returns
//! (or times out) — `sandbox.rs` closes the job object on completion by
//! design, so a `vite` that never exits is killed by the timeout and the
//! `http://localhost:5173` the model read from the killed output was never
//! reachable. The model then reports that dead URL as the deliverable.
//!
//! A dev server is not a tool call. It outlives the tool call that started it,
//! the run that made the call, and the chat the run belongs to. So it is
//! spawned through the same job-object machinery (`winproc::spawn_contained`)
//! but with the job handle held *here* for the life of the server: the tree
//! survives the tool call because this module keeps a reference, and it dies
//! with the app because the handle is process-owned and `KILL_ON_JOB_CLOSE`
//! closes it at exit.
//!
//! The URL handed to the model and the UI is verified by an actual HTTP round
//! trip on 127.0.0.1 — the port comes from what the server itself printed,
//! not from a guess, which also covers frameworks that silently move to
//! another port when theirs is taken.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::error::{CoreError, CoreResult};
use crate::state::{now_ms, AppState};
use crate::types::{DevServerState, DevServerStatus};
use crate::winproc::{self, JobLimits};

/// How long the port line may take to appear in the output.
const PORT_DEADLINE: Duration = Duration::from_secs(60);
/// How long the server may take after printing its port to answer HTTP.
const READY_DEADLINE: Duration = Duration::from_secs(90);
/// How long to wait for the server to *print* its port before falling back to
/// the one named on the command line. Frameworks announce themselves within a
/// second or two; anything still silent after this never will — Python 3.13's
/// `http.server`, for one, serves without printing a single line.
const PRINT_GRACE: Duration = Duration::from_secs(10);
/// Kept lines of output, ring-style, per server.
const OUTPUT_RING: usize = 200;

/// Programs a dev server may legitimately be started through. The command
/// comes from the model, so it is treated like any other model-authored
/// input: the first token must resolve to one of these, and no shell
/// metacharacter is accepted — there is no shell here to interpret one.
const ALLOWED_PROGRAMS: &[&str] = &[
    "npm", "npx", "node", "yarn", "pnpm", "python", "py", "deno", "bun",
];

struct Entry {
    status: DevServerStatus,
    /// Terminates the leader pid and, on the last drop, releases the job
    /// object — which kills the whole tree. Same shape as a sandbox handle.
    kill: Arc<dyn Fn() + Send + Sync>,
    /// Set by `stop` before the kill fires, so the watcher reports the exit
    /// as "stopped" rather than "failed".
    stopping: Arc<AtomicBool>,
}

/// The per-workspace registry. One server per workspace: a second start with
/// the same command reuses the running one, and with a different command
/// restarts it. That is what a person means by "start the dev server" for a
/// project that already has one running.
#[derive(Default)]
pub struct DevServers {
    entries: Mutex<HashMap<String, Entry>>,
}

impl DevServers {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot for the UI. Includes stopped/failed servers: the composer bar
    /// shows why a server is not running, not just that one is.
    pub fn status(&self) -> Vec<DevServerStatus> {
        self.entries
            .lock()
            .expect("dev server registry lock")
            .values()
            .map(|e| e.status.clone())
            .collect()
    }
}

/// Registers an in-process server — a `serve_folder` preview — in the same
/// registry the UI and the devserver commands read, so there is one source of
/// truth for everything reachable on loopback. `kill` shuts the server down
/// without a process to signal; the workspace's previous entry, if any, is
/// stopped first so "one server per workspace" holds across both kinds.
pub(crate) fn register_inprocess(
    st: &AppState,
    status: DevServerStatus,
    kill: Arc<dyn Fn() + Send + Sync>,
) {
    stop(st, &status.workspace_id).ok();
    let entry = Entry {
        status: status.clone(),
        kill,
        stopping: Arc::new(AtomicBool::new(false)),
    };
    st.dev_servers
        .entries
        .lock()
        .expect("dev server registry lock")
        .insert(status.workspace_id.clone(), entry);
    emit(st, &status);
}

fn emit(st: &AppState, status: &DevServerStatus) {
    st.emit("devserver://status", status.clone());
}

/// The tail of the output ring, for error messages.
fn output_tail(lines: &[String]) -> String {
    let start = lines.len().saturating_sub(12);
    lines[start..].join("\n")
}

/// Port markers that name a real URL the server printed for itself — vite
/// ("Local: http://localhost:5173/"), next ("Ready on http://localhost:3000"),
/// CRA, Angular. A URL is authoritative: it is what the server actually bound.
const URL_MARKERS: &[&str] = &["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:"];

/// Weaker markers — a bare "port 4200" with no URL. Only used when no URL
/// form ever appears, which is the case for servers that log a port number
/// without a clickable line.
const NUMBER_MARKERS: &[&str] = &["port ", "port="];

fn port_after_marker(line: &str, marker: &str) -> Option<u16> {
    let lower = line.to_lowercase();
    let at = lower.find(marker)?;
    let digits: String = line[at + marker.len()..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    digits.parse::<u16>().ok().filter(|p| *p > 0)
}

/// The port this server is really on, from the output it printed.
///
/// URL forms win over bare numbers, and the *last* URL wins: when a
/// configured port is taken, vite prints "Port 5173 is in use, trying another
/// one…" followed by a Local: line for 5174 — the first number in the stream
/// is the port that was *rejected*, and a first-match parse would probe a
/// dead port forever.
fn best_port(lines: &[String]) -> Option<u16> {
    let mut from_number = None;
    for line in lines {
        for marker in NUMBER_MARKERS {
            if let Some(p) = port_after_marker(line, marker) {
                from_number = from_number.or(Some(p));
            }
        }
    }
    let mut from_url = None;
    for line in lines {
        for marker in URL_MARKERS {
            if let Some(p) = port_after_marker(line, marker) {
                from_url = Some(p);
            }
        }
    }
    from_url.or(from_number)
}

/// The first bare port number among a command's arguments. `["python",
/// "-m", "http.server", "8017"]` names 8017; a flag value like `--port 3000`
/// names 3000 the same way, because the value is also a bare argument. Only
/// port-shaped numbers count: 1–65535, no sign, no suffix.
fn port_argument(parts: &[String]) -> Option<u16> {
    parts.iter().skip(1).find_map(|a| {
        if a.len() > 5 || !a.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        a.parse::<u16>().ok().filter(|p| *p > 0)
    })
}

/// The command to run: the model's explicit one, or the project's own dev
/// script discovered from `package.json`. A project without either is a
/// project that has no server to start, and that is said rather than guessed.
fn resolve_command(cwd: &Path, explicit: Option<&str>) -> CoreResult<String> {
    if let Some(given) = explicit.map(str::trim).filter(|c| !c.is_empty()) {
        return Ok(given.to_string());
    }
    let pkg_path = cwd.join("package.json");
    let Ok(raw) = std::fs::read_to_string(&pkg_path) else {
        return Err(CoreError::ExecutionFailed(format!(
            "The workspace has no package.json, so there is no dev script to run. Create the project files first, \
or pass an explicit command."
        )));
    };
    let pkg: Value = serde_json::from_str(&raw).map_err(|e| {
        CoreError::ExecutionFailed(format!("The workspace's package.json is not valid JSON ({e})."))
    })?;
    let scripts = pkg.get("scripts");
    for script in ["dev", "start"] {
        let present = scripts
            .and_then(|s| s.get(script))
            .and_then(Value::as_str)
            .is_some_and(|s| !s.trim().is_empty());
        if present {
            return Ok(format!("npm run {script}"));
        }
    }
    Err(CoreError::ExecutionFailed(
        "package.json has no \"dev\" or \"start\" script, so there is nothing to run as a dev server. Pass an \
explicit command if one is needed."
            .into(),
    ))
}

/// Starts (or reuses) the workspace's dev server and returns its status only
/// once it is genuinely listening — or the honest failure if it never did.
pub async fn start(
    st: &Arc<AppState>,
    workspace_id: &str,
    cwd: &str,
    command: Option<String>,
) -> CoreResult<DevServerStatus> {
    // A preview's command line is `serve <path>`, not a program to spawn —
    // Restart on a `serve_folder` entry re-serves the folder through the same
    // path the tool uses, so the bar's buttons work for both kinds of server.
    if let Some(given) = command.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
        if given == "serve" || given.starts_with("serve ") {
            let rel = given.strip_prefix("serve").unwrap_or("").trim();
            let rel = if rel.is_empty() { "." } else { rel };
            let root = crate::fsops::resolve(st, workspace_id, rel)?;
            let preview = crate::preview::serve(st, workspace_id, &root, rel).await?;
            return Ok(preview.status);
        }
    }

    let cwd = cwd.to_string();
    let command = resolve_command(Path::new(&cwd), command.as_deref())?;

    // Reuse: a running (or still-starting) server with the same command is
    // the same server. A different command means the project changed how it
    // runs — restart. Decided in a block so no mutex guard is alive across
    // the await below (a std guard is not Send, and this future is spawned).
    enum Reuse {
        Running(DevServerStatus),
        Starting,
        Fresh,
    }
    let reuse = {
        let entries = st.dev_servers.entries.lock().expect("dev server registry lock");
        match entries.get(workspace_id) {
            Some(entry)
                if matches!(entry.status.status, DevServerState::Starting | DevServerState::Running)
                    && winproc::pid_alive(entry.status.pid)
                    && entry.status.command == command =>
            {
                if entry.status.status == DevServerState::Running {
                    Reuse::Running(entry.status.clone())
                } else {
                    Reuse::Starting
                }
            }
            _ => Reuse::Fresh,
        }
    };
    match reuse {
        Reuse::Running(status) => return Ok(status),
        // Still starting: wait for whoever is bringing it up.
        Reuse::Starting => return wait_for_start(st, workspace_id).await,
        Reuse::Fresh => {}
    }
    // A dead entry or a different command: clear it out and start fresh.
    stop(st, workspace_id).ok();

    spawn(st, workspace_id, &cwd, &command).await
}

/// Waits for an in-flight start to resolve, bounded, so two concurrent
/// `start_dev_server` calls for one workspace cannot race two servers.
async fn wait_for_start(st: &Arc<AppState>, workspace_id: &str) -> CoreResult<DevServerStatus> {
    let deadline = Instant::now() + READY_DEADLINE + PORT_DEADLINE;
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let entries = st.dev_servers.entries.lock().expect("dev server registry lock");
        if let Some(entry) = entries.get(workspace_id) {
            match entry.status.status {
                DevServerState::Running => return Ok(entry.status.clone()),
                DevServerState::Failed | DevServerState::Stopped => {
                    let error = entry
                        .status
                        .error
                        .clone()
                        .unwrap_or_else(|| "The dev server stopped before it answered.".into());
                    return Err(CoreError::ExecutionFailed(error));
                }
                DevServerState::Starting => continue,
            }
        }
        return Err(CoreError::ExecutionFailed(
            "The dev server was stopped while it was starting.".into(),
        ));
    }
    Err(CoreError::ExecutionFailed(
        "The dev server did not finish starting within the timeout.".into(),
    ))
}

async fn spawn(
    st: &Arc<AppState>,
    workspace_id: &str,
    cwd: &str,
    command: &str,
) -> CoreResult<DevServerStatus> {
    // ---- validate and resolve the command ----
    if ['&', '|', ';', '>', '<', '`'].iter().any(|c| command.contains(*c)) {
        return Err(CoreError::ExecutionFailed(
            "A dev server command may not contain shell operators; it is run directly, with no shell. \
Pass the plain command, e.g. \"npm run dev\"."
                .into(),
        ));
    }
    let parts = crate::sandbox::split_args(command);
    let Some(program) = parts.first() else {
        return Err(CoreError::ExecutionFailed("The dev server command is empty.".into()));
    };
    let stem = Path::new(program)
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| program.to_lowercase());
    if !ALLOWED_PROGRAMS.contains(&stem.as_str()) {
        return Err(CoreError::ExecutionFailed(format!(
            "'{program}' is not a program a dev server may be started through. Allowed: npm, npx, node, yarn, \
pnpm, python, deno, bun."
        )));
    }
    let Some(resolved) = crate::sandbox::resolve_program(program) else {
        return Err(CoreError::ExecutionFailed(format!(
            "'{program}' was not found on this machine (every folder on PATH was searched, with each \
suffix in PATHEXT), so the dev server could not start."
        )));
    };
    // The port named on the command line, if any — "http.server 8017", "vite
    // --port 3000". A server that never prints a URL (Python's http.server
    // serves silently) is still findable through it, but it is only a guess:
    // what the server *printed* always wins, and the command port is only
    // probed once the server has had its chance to announce itself.
    let command_port = port_argument(&parts);

    let mut cmd = Command::new(&resolved);
    cmd.args(&parts[1..])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Same minimal environment as the sandbox — the child must not see the
    // router's API key — plus what node/npm genuinely need on Windows: a
    // writable temp dir and the user profile paths the npm cache derives from.
    crate::sandbox::inherit_minimal_env(&mut cmd);
    cmd.env("TEMP", cwd)
        .env("TMP", cwd)
        .env("FORCE_COLOR", "0")
        // npm resolves its cache and config from these; without them it
        // fails or silently misconfigures.
        .env("APPDATA", std::env::var("APPDATA").unwrap_or_else(|_| cwd.to_string()))
        .env("LOCALAPPDATA", std::env::var("LOCALAPPDATA").unwrap_or_else(|_| cwd.to_string()))
        .env("USERPROFILE", std::env::var("USERPROFILE").unwrap_or_else(|_| cwd.to_string()));

    let contained = winproc::spawn_contained(cmd, JobLimits::dev_server()).map_err(|e| {
        CoreError::ExecutionFailed(format!("The dev server could not be started: {e}"))
    })?;
    let pid = contained.pid;
    let kill = contained.killer();
    let mut child = contained.child;

    let stopping = Arc::new(AtomicBool::new(false));
    let output: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    // ---- readers: stdout and stderr merged into one ring ----
    // Boxed, because ChildStdout and ChildStderr are different types and the
    // reader thread only needs `Read + Send`.
    let pipes: Vec<Box<dyn std::io::Read + Send>> = [
        child.stdout.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|s| Box::new(s) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    .collect();
    for pipe in pipes {
        let ring = Arc::clone(&output);
        std::thread::spawn(move || {
            let reader = BufReader::new(pipe);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let mut ring = ring.lock().expect("dev server output ring lock");
                ring.push(crate::sandbox::truncate_line(&line));
                let excess = ring.len().saturating_sub(OUTPUT_RING);
                if excess > 0 {
                    ring.drain(0..excess);
                }
            }
        });
    }

    let initial = DevServerStatus {
        workspace_id: workspace_id.to_string(),
        cwd: cwd.to_string(),
        command: command.to_string(),
        pid,
        port: None,
        url: None,
        status: DevServerState::Starting,
        started_at: now_ms(),
        error: None,
        output: Vec::new(),
    };
    emit(st, &initial);
    st.dev_servers.entries.lock().expect("dev server registry lock").insert(
        workspace_id.to_string(),
        Entry { status: initial, kill, stopping: Arc::clone(&stopping) },
    );

    // ---- watcher: owns the Child, reports an unexpected exit ----
    let watch_st = Arc::clone(st);
    let watch_id = workspace_id.to_string();
    let watch_output = Arc::clone(&output);
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let entries = &watch_st.dev_servers.entries;
        let mut entries = entries.lock().expect("dev server registry lock");
        let Some(entry) = entries.get_mut(&watch_id) else { return };
        if entry.stopping.load(Ordering::Relaxed) {
            entry.status.status = DevServerState::Stopped;
            entry.status.url = None;
        } else {
            entry.status.status = DevServerState::Failed;
            entry.status.url = None;
            let tail = output_tail(&watch_output.lock().expect("dev server output ring lock"));
            entry.status.error = Some(format!(
                "The dev server exited unexpectedly{}. {}",
                code.map(|c| format!(" (exit code {c})")).unwrap_or_default(),
                if tail.is_empty() { String::new() } else { format!("Last output:\n{tail}") }
            ));
        }
        emit(&watch_st, &entry.status.clone());
    });

    // ---- readiness: the port the server printed, then an HTTP answer ----
    let port_deadline = Instant::now() + PORT_DEADLINE;
    let ready_deadline = Instant::now() + READY_DEADLINE;
    let print_grace_deadline = Instant::now() + PRINT_GRACE;
    let mut port: Option<u16> = None;

    while Instant::now() < ready_deadline {
        if !winproc::pid_alive(pid) {
            break;
        }
        let printed = if Instant::now() < port_deadline {
            // Re-read every tick rather than scanning incrementally: a server
            // whose configured port was taken prints the rejected number
            // first and the real URL after it, so the latest URL is the truth.
            best_port(&output.lock().expect("dev server output ring lock"))
        } else {
            None
        };
        port = printed.or_else(|| {
            // Silent after the grace period: the command's own port is the
            // only other candidate. Still only trusted once something answers
            // HTTP on it.
            if Instant::now() >= print_grace_deadline {
                command_port
            } else {
                None
            }
        });
        if let Some(p) = port {
            // Any HTTP response — including a 404 or 500 — means something
            // is listening on that port. Only a connection error means "not
            // yet".
            let probe = st
                .http
                .get(format!("http://127.0.0.1:{p}/"))
                .timeout(Duration::from_secs(3))
                .send()
                .await;
            if probe.is_ok() {
                let url = format!("http://127.0.0.1:{p}/");
                let entries = &st.dev_servers.entries;
                let mut entries = entries.lock().expect("dev server registry lock");
                if let Some(entry) = entries.get_mut(workspace_id) {
                    if winproc::pid_alive(entry.status.pid) {
                        entry.status.port = Some(p);
                        entry.status.url = Some(url.clone());
                        entry.status.status = DevServerState::Running;
                        entry.status.output =
                            output.lock().expect("dev server output ring lock").clone();
                        let status = entry.status.clone();
                        emit(st, &status);
                        return Ok(status);
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // Not ready. Kill it, and say why with the server's own output.
    let ring = output.lock().expect("dev server output ring lock").clone();
    let failure = if !winproc::pid_alive(pid) {
        format!(
            "The dev server exited before it was reachable. {}",
            if ring.is_empty() {
                "It printed nothing.".into()
            } else {
                format!("Last output:\n{}", output_tail(&ring))
            }
        )
    } else if port.is_none() {
        format!(
            "The dev server is running but its port could not be verified: it printed no localhost \
URL within {} seconds{} and answered no probe. Last output:\n{}",
            PORT_DEADLINE.as_secs(),
            if command_port.is_some() {
                format!(" (the command named port {}, which never answered either)", command_port.unwrap())
            } else {
                String::new()
            },
            output_tail(&ring)
        )
    } else {
        format!(
            "The dev server printed port {} but nothing answered on http://127.0.0.1:{} within {} \
seconds. Last output:\n{}",
            port.unwrap(),
            port.unwrap(),
            READY_DEADLINE.as_secs(),
            output_tail(&ring)
        )
    };

    // Not ready. Kill it, and say why with the server's own output. The
    // watcher thread's report is moot — the entry is removed here — so the
    // failure status is emitted from this side with the actual reason.
    let entry = st
        .dev_servers
        .entries
        .lock()
        .expect("dev server registry lock")
        .remove(workspace_id);
    if let Some(entry) = entry {
        let mut status = entry.status;
        (entry.kill)();
        status.status = DevServerState::Failed;
        status.url = None;
        status.error = Some(failure.clone());
        status.output = ring.clone();
        emit(st, &status);
    }
    Err(CoreError::ExecutionFailed(failure))
}

/// Stops the workspace's server, if any. Safe to call when none is running —
/// a workspace switch and an app exit both call it unconditionally.
pub fn stop(st: &AppState, workspace_id: &str) -> CoreResult<()> {
    let entry = st
        .dev_servers
        .entries
        .lock()
        .expect("dev server registry lock")
        .remove(workspace_id);
    let Some(entry) = entry else { return Ok(()) };
    entry.stopping.store(true, Ordering::Relaxed);
    (entry.kill)();
    let mut status = entry.status;
    status.status = DevServerState::Stopped;
    status.url = None;
    emit(st, &status);
    Ok(())
}

/// Stops every server. App exit calls this, though closing the job handles
/// would kill the trees anyway; this way the UI (a still-attached browser
/// tab) hears the state change rather than discovering a dead pid.
pub fn stop_all(st: &AppState) {
    let ids: Vec<String> = st
        .dev_servers
        .entries
        .lock()
        .expect("dev server registry lock")
        .keys()
        .cloned()
        .collect();
    for id in ids {
        let _ = stop(st, &id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Each line parsed through the weaker number markers too, so the helper
    /// below exercises one line at a time on both paths.
    fn port_of(line: &str) -> Option<u16> {
        best_port(&[line.to_string()])
    }

    #[test]
    fn ports_are_read_from_framework_output_lines() {
        // vite
        assert_eq!(port_of("  ➜  Local:   http://localhost:5173/"), Some(5173));
        // next
        assert_eq!(port_of("▲ Next.js 15 - Ready on http://localhost:3000"), Some(3000));
        // angular / generic
        assert_eq!(port_of("Application is running at http://127.0.0.1:4200/"), Some(4200));
        assert_eq!(port_of("Server listening on port 8080"), Some(8080));
        assert_eq!(port_of("no port mentioned here"), None);
    }

    #[test]
    fn a_moved_port_reports_the_new_port_not_the_rejected_one() {
        // What vite actually prints when its configured port is taken: the
        // rejected number first, the real URL after. The latest URL wins and
        // the bare number is never consulted, because a URL was printed.
        let lines = [
            "Port 5173 is in use, trying another one...".to_string(),
            "  ➜  Local:   http://localhost:5174/".to_string(),
        ];
        assert_eq!(best_port(&lines), Some(5174));
    }

    #[test]
    fn a_bare_number_only_counts_when_no_url_was_ever_printed() {
        let lines = ["Application server running on port 3000".to_string()];
        assert_eq!(best_port(&lines), Some(3000));
    }

    #[test]
    fn a_port_named_on_the_command_line_is_recognised() {
        let parts = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        // The classic silent server: Python's http.server.
        assert_eq!(port_argument(&parts("python -m http.server 8017")), Some(8017));
        // A flag's value is also a bare argument.
        assert_eq!(port_argument(&parts("npx vite --port 3000")), Some(3000));
        // Not ports: the program itself, and non-numeric arguments.
        assert_eq!(port_argument(&parts("npm run dev")), None);
        assert_eq!(port_argument(&parts("node server.js 80x")), None);
        // Six digits is not a u16 port.
        assert_eq!(port_argument(&parts("python serve.py 1234567")), None);
    }
}
