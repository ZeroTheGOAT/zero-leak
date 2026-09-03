//! Shared state, and the two chokepoints every subsystem has to go through:
//! `with_db` for the store and `classify_url` for the network.
//!
//! `classify_url` is where §11 stops being a claim. There is exactly one HTTP
//! client in the process and it is on `AppState`; nothing in the core builds its
//! own. Every request is classified first — loopback, the approved private
//! server, or the public internet — and a public destination is refused rather
//! than counted. That is also why the status bar can distinguish "this device"
//! from "private server" instead of showing one undifferentiated number.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::error::{CoreError, CoreResult};
use crate::registry::Registry;
use crate::types::*;

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/* ------------------------------------------------------------------ */
/* Network classification                                              */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Destination {
    /// The router or another process on this machine. Not network egress.
    Loopback,
    /// The private server the operator explicitly configured and approved.
    PrivateServer,
}

/* ------------------------------------------------------------------ */
/* Cancellable work                                                    */
/* ------------------------------------------------------------------ */

/// One in-flight agent run. Cancellation is cooperative: the orchestrator
/// checks the flag between steps and before each network call, so a cancelled
/// run stops at a step boundary rather than mid-write.
#[derive(Clone)]
pub struct RunHandle {
    pub run_id: String,
    pub started_at: i64,
    pub cancelled: Arc<AtomicBool>,
    /// Every model this run has made resident. `make_room` refuses to evict a
    /// model another live run is using — with several chats running at once,
    /// evicting the model a generation is streaming from would fail that chat
    /// mid-answer, which is exactly the interference concurrent runs must not
    /// cause each other. The set dies with the run, so an idle model becomes
    /// evictable the moment its chat finishes.
    models: Arc<Mutex<Vec<String>>>,
    /// The live plan this run published through `update_plan`. Emitted whole on
    /// every revision, so the UI holds only the latest — there is no partial
    /// state to reconcile.
    plan: Arc<Mutex<Vec<PlanItem>>>,
}

impl RunHandle {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn check(&self) -> CoreResult<()> {
        if self.is_cancelled() {
            return Err(CoreError::Denied("The run was cancelled.".into()));
        }
        Ok(())
    }

    /// Records that this run is using `model_id`, so residency knows the model
    /// is not idle. Called from `ensure_loaded`, which every path that touches
    /// a model goes through, so tool-driven reads (OCR, vision) are covered
    /// without their call sites knowing about it.
    pub fn note_model(&self, model_id: &str) {
        let mut m = self.models.lock().expect("run models lock");
        if !m.iter().any(|id| id == model_id) {
            m.push(model_id.to_string());
        }
    }

    /// The models this run has noted, snapshot for a decision made elsewhere
    /// (`make_room` reads every live run's set at once).
    pub fn noted_models(&self) -> Vec<String> {
        self.models.lock().expect("run models lock").clone()
    }

    /// Replaces the run's published plan. Returns the stored copy so the
    /// emitter can send exactly what was validated, not a re-read.
    ///
    /// Step ids are preserved across revisions: a step whose text survives a
    /// re-publish keeps its id, so the UI keys checklist rows on it and
    /// updates one list in place. New steps get fresh ids; steps that were
    /// reworded count as new, which is honest — the operator sees what the
    /// model actually changed.
    pub fn set_plan(&self, items: Vec<PlanItem>) -> Vec<PlanItem> {
        let mut plan = self.plan.lock().expect("run plan lock");
        let previous = plan.clone();
        let mut stored = items;
        for item in stored.iter_mut() {
            if let Some(prev) = previous.iter().find(|p| p.step == item.step) {
                item.id = prev.id.clone();
            }
        }
        *plan = stored;
        plan.clone()
    }

    /// The plan as last published, so a new `update_plan` call can be compared
    /// against it. A revision that changes nothing — observed as the same
    /// three steps published nine times in a row while the model waited for
    /// permission to act — is a loop, and this is what lets the tool result
    /// name it as one instead of the run discovering it by round 60.
    pub fn current_plan(&self) -> Vec<PlanItem> {
        self.plan.lock().expect("run plan lock").clone()
    }
}

/// The run a piece of work belongs to, visible to sync code deep in the stack.
///
/// Steps and tool results are emitted far below `orchestrate` — in document
/// extraction, spreadsheet reads, image analysis — and those functions are
/// also called outside any run (a user-initiated ingest, knowledge indexing).
/// Threading a run parameter through all of them would churn every signature
/// to serve one field, so the run is carried as a task-local instead: set once
/// around the run's task, absent outside one. Reading it from sync code inside
/// the task works; from a plain thread or an unrelated task it answers `None`,
/// which is the honest answer there.
#[derive(Clone)]
pub struct RunScope {
    pub handle: RunHandle,
    pub session_id: String,
}

tokio::task_local! {
    pub static RUN_CONTEXT: RunScope;
}

/// Reads the current run's identity, or `None` outside a run.
pub fn current_run() -> Option<(String, String)> {
    RUN_CONTEXT
        .try_with(|c| (c.handle.run_id.clone(), c.session_id.clone()))
        .ok()
}

/// Pins `model_id` to the current run, if there is one. No-op outside a run —
/// a model loaded from the Models panel is idle by definition.
pub fn note_model_on_current_run(model_id: &str) {
    let _ = RUN_CONTEXT.try_with(|c| c.handle.note_model(model_id));
}

/// A live sandbox process. `kill` closes the job object, which terminates the
/// whole tree — the child, and anything it spawned. Held as a closure so this
/// module stays free of Windows handle types.
#[derive(Clone)]
pub struct SandboxHandle {
    pub run_id: String,
    pub pid: u32,
    pub kill: Arc<dyn Fn() + Send + Sync>,
}

/// The `llama-server` router process, likewise kept alive by a job object so it
/// cannot outlive the app.
///
/// `api_key` is generated per launch and required on every request. The router
/// listens on loopback, which is not a boundary on a shared workstation: any
/// other process on the machine could otherwise drive the operator's models.
/// `stopping` distinguishes a deliberate stop from a crash, so the watcher
/// thread does not report an orderly shutdown as a failure.
#[derive(Clone)]
pub struct RouterChild {
    pub pid: u32,
    pub port: u16,
    pub api_key: String,
    pub stopping: Arc<AtomicBool>,
    pub kill: Arc<dyn Fn() + Send + Sync>,
}

/// A permission prompt waiting on the operator, paired with the run that asked.
pub struct PendingPermission {
    run_id: Option<String>,
    tx: tokio::sync::oneshot::Sender<PermissionDecision>,
}

/// An open `ask_operator` question waiting on the operator's free-text reply.
/// The answer is the result the tool returns to the model, so the channel
/// carries a string, not a decision enum.
pub struct PendingQuestion {
    pub run_id: String,
    tx: tokio::sync::oneshot::Sender<String>,
}

/// One run's proposed writes, and the workspace they were proposed against.
///
/// The workspace is recorded when the first proposal is queued, not looked up
/// at apply time: "the approved workspace" is ambiguous on a machine with more
/// than one project, and applying a relative path in the wrong project's
/// folder writes a file nobody reviewed into a project nobody was looking at.
pub struct PendingRun {
    pub workspace_id: Option<String>,
    pub files: Vec<FileChange>,
}

/* ------------------------------------------------------------------ */
/* AppState                                                            */
/* ------------------------------------------------------------------ */

pub struct AppState {
    pub app: AppHandle,

    /// Held behind a std mutex, never across an await. `with_db` enforces that:
    /// the guard cannot escape the closure.
    db: Mutex<Connection>,

    pub settings: RwLock<AppSettings>,
    pub registry: RwLock<Registry>,

    /// Live per-model state. The router is the authority; this is the cache the
    /// UI reads so a `model_list` does not have to wait on HTTP.
    pub models: RwLock<HashMap<String, ModelRuntime>>,

    pub router: Mutex<Option<RouterChild>>,
    pub router_version: RwLock<Option<String>>,

    /// The process's only HTTP client. See `classify_url`.
    pub http: reqwest::Client,

    /// Fan-out for the browser transport. Every `emit` is mirrored here as one
    /// JSON line so an SSE stream can replay it verbatim. A broadcast channel
    /// drops for slow receivers rather than blocking the emitter, which is the
    /// right trade: a stalled browser tab must never wedge the agent loop.
    /// Sends fail harmlessly when nobody is subscribed, i.e. in desktop-only
    /// mode, so this costs one allocation per event and nothing else.
    ///
    /// The ring is deliberately deep. Browsers throttle background tabs, and the
    /// densest event on the wire is `agent://text` — one per token. A shallow
    /// ring would silently drop answer text whenever the user switched tabs
    /// during a run, so the capacity is sized to hold a whole long answer
    /// (roughly a hundred KiB of pointers) rather than to save memory.
    pub events: tokio::sync::broadcast::Sender<String>,

    /// The browser URL for this launch, token included, or `None` when the HTTP
    /// transport is not running. Read by the `web_info` command so the desktop
    /// window can offer a working link.
    pub web_url: RwLock<Option<String>>,

    pub runs: Mutex<HashMap<String, RunHandle>>,
    pub sandbox: Mutex<HashMap<String, SandboxHandle>>,

    /// Loopback preview servers started by `serve_folder`, keyed by folder.
    /// One per folder, persisted in the store and re-bound at startup so the
    /// URLs immutable chat transcripts name keep working — see `preview.rs`.
    pub previews: crate::preview::Previews,

    /// Persistent dev servers started by `start_dev_server`, keyed by
    /// workspace. One per workspace, outliving the runs that started them —
    /// see `devserver.rs` for why their lifecycle is not the sandbox's.
    pub dev_servers: crate::devserver::DevServers,

    /// Serialises model residency changes. With several chats running at once,
    /// two `ensure_loaded` calls racing each other would both run `make_room`
    /// against the same resident set and both evict for models that then have
    /// to share the space they just freed. One load pipeline at a time keeps
    /// the admission decision honest; requests against an already-resident
    /// model never take this lock at all.
    pub model_load_lock: tokio::sync::Mutex<()>,

    /// Permission requests awaiting an answer from the UI. §9 — a run that asks
    /// blocks here until the user decides; there is no default-allow path.
    /// The run id is kept beside the sender so cancellation can reject only
    /// the asking run's prompt.
    pub permissions: Mutex<HashMap<String, PendingPermission>>,

    /// Open `ask_operator` questions awaiting the operator's free-text reply.
    /// Same blocking contract as permissions: the asking run is parked here
    /// until an answer, a cancel, or the timeout resolves it.
    pub questions: Mutex<HashMap<String, PendingQuestion>>,

    /// Writes the agent has proposed but not performed, keyed by run id.
    ///
    /// §12 — a write reaches disk only after the diff has been reviewed, so the
    /// new content lives here between the model producing it and the operator
    /// accepting it. Keeping the whole `FileChange`, old content included, is
    /// what lets the review panel show a diff without re-reading a file that may
    /// have changed underneath, and what lets Apply verify the file is still what
    /// the diff was computed against. The workspace the run wrote against rides
    /// beside the files: with more than one approved project, Apply must resolve
    /// the path in the folder the proposal was made in, not in whichever project
    /// the database happens to return first.
    pub pending_changes: Mutex<HashMap<String, PendingRun>>,

    /// Tools the user allowed for the rest of the session.
    pub session_grants: RwLock<Vec<ToolName>>,

    /// Set while the knowledge folder watcher is running.
    pub watching: AtomicBool,

    /// Folders the running watcher actually holds a handle on.
    ///
    /// Recorded rather than recomputed so the panel can name them: documents are
    /// indexed from wherever the operator keeps them, so "watching" covers the
    /// configured knowledge folder *and* every folder an indexed source came out
    /// of, minus any that a failed watch dropped. A count derived from settings
    /// would claim folders that are not being watched.
    pub watched_folders: Mutex<Vec<String>>,
}

impl AppState {
    pub fn new(app: AppHandle, conn: Connection) -> CoreResult<Self> {
        let settings = crate::db::load_settings(&conn)?;
        let registry = Registry::load_or_seed(&crate::registry::config_dir(), &settings.models_directory)?;

        let models = registry
            .all()
            .iter()
            .map(|m| (m.id.clone(), ModelRuntime::unloaded(&m.id)))
            .collect();

        let http = reqwest::Client::builder()
            // Loopback and LAN only; a long default would make an unreachable
            // private server look like a hang instead of a failure.
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(600))
            .pool_idle_timeout(std::time::Duration::from_secs(30))
            .no_proxy()
            .build()
            .map_err(|e| CoreError::ExecutionFailed(format!("Could not build the HTTP client: {e}")))?;

        Ok(Self {
            app,
            db: Mutex::new(conn),
            settings: RwLock::new(settings),
            registry: RwLock::new(registry),
            models: RwLock::new(models),
            router: Mutex::new(None),
            router_version: RwLock::new(None),
            http,
            events: tokio::sync::broadcast::channel(4096).0,
            web_url: RwLock::new(None),
            runs: Mutex::new(HashMap::new()),
            sandbox: Mutex::new(HashMap::new()),
            previews: crate::preview::Previews::new(),
            dev_servers: crate::devserver::DevServers::new(),
            model_load_lock: tokio::sync::Mutex::new(()),
            permissions: Mutex::new(HashMap::new()),
            questions: Mutex::new(HashMap::new()),
            pending_changes: Mutex::new(HashMap::new()),
            session_grants: RwLock::new(Vec::new()),
            watching: AtomicBool::new(false),
            watched_folders: Mutex::new(Vec::new()),
        })
    }

    /* ---- store ---- */

    /// The only way to reach the connection. A poisoned mutex is reported as a
    /// database fault rather than panicking the command.
    pub fn with_db<T>(&self, f: impl FnOnce(&Connection) -> CoreResult<T>) -> CoreResult<T> {
        let guard = self
            .db
            .lock()
            .map_err(|_| CoreError::ExecutionFailed("The local database lock was poisoned by an earlier panic. Restart the application.".into()))?;
        f(&guard)
    }

    pub fn settings(&self) -> AppSettings {
        self.settings.read().expect("settings lock").clone()
    }

    /* ---- events ---- */

    /// Emission failures mean the window is gone, which is not a core error.
    ///
    /// The payload goes to two places and must carry the same bytes in both: the
    /// Tauri event system for the desktop window, and the broadcast channel for
    /// any browser attached over SSE. Serialising once and sending that one
    /// string is what makes it impossible for the two transports to drift.
    pub fn emit<T: Serialize + Clone>(&self, event: &str, payload: T) {
        if let Ok(json) = serde_json::to_string(&payload) {
            let _ = self.events.send(format!(
                "{{\"event\":{},\"payload\":{}}}",
                serde_json::Value::String(event.to_string()),
                json
            ));
        }
        let _ = self.app.emit(event, payload);
    }

    pub fn emit_failure(&self, err: &CoreError) {
        self.emit("agent://failure", err.to_failure(new_id("fail"), now_ms()));
    }

    /// `core://model` carries one runtime, not the whole set: the frontend
    /// merges it into a map by id, so sending an array would break the reducer.
    pub fn set_model_state(&self, id: &str, f: impl FnOnce(&mut ModelRuntime)) {
        let updated = {
            let mut m = self.models.write().expect("models lock");
            let entry = m.entry(id.to_string()).or_insert_with(|| ModelRuntime::unloaded(id));
            f(entry);
            entry.clone()
        };
        self.emit("core://model", updated);
    }

    pub fn model_runtimes(&self) -> Vec<ModelRuntime> {
        let m = self.models.read().expect("models lock");
        let reg = self.registry.read().expect("registry lock");
        // Registry order, so the Models panel does not reshuffle between polls.
        reg.all()
            .iter()
            .map(|e| m.get(&e.id).cloned().unwrap_or_else(|| ModelRuntime::unloaded(&e.id)))
            .collect()
    }

    pub fn loaded_ids(&self) -> Vec<String> {
        self.models
            .read()
            .expect("models lock")
            .values()
            .filter(|r| r.state == ModelState::Loaded)
            .map(|r| r.id.clone())
            .collect()
    }

    /* ---- §11 network chokepoint ---- */

    /// Classifies a destination, or refuses it.
    ///
    /// Loopback is always allowed: the router runs on this machine and talking
    /// to it is not egress. The configured private server is allowed only when
    /// `allow_private_server` is on and the URL actually matches it. Everything
    /// else is refused — there is no public-cloud fallback, not even on failure.
    pub fn classify_url(&self, url: &str) -> CoreResult<Destination> {
        let s = self.settings();

        let host = url
            .split("://")
            .nth(1)
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or_default()
            .rsplit_once(':')
            .map(|(h, _)| h)
            .unwrap_or_else(|| url.split("://").nth(1).unwrap_or(url).split('/').next().unwrap_or_default())
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_ascii_lowercase();

        let is_loopback = host == "localhost"
            || host == "::1"
            || host
                .parse::<std::net::IpAddr>()
                .map(|ip| ip.is_loopback())
                .unwrap_or(false);

        if is_loopback {
            return Ok(Destination::Loopback);
        }

        if s.allow_private_server && !s.private_server_url.is_empty() {
            let configured = s.private_server_url.trim_end_matches('/');
            if url.starts_with(configured) {
                return Ok(Destination::PrivateServer);
            }
        }

        Err(CoreError::Denied(format!(
            "Refused a request to {host}. This build reaches loopback and the one private server you approve in Settings, and nothing else. No public cloud service is contacted, including as a fallback."
        )))
    }

    /// Counts a completed request. `bytes` is the response size; the split
    /// between device and private-server totals is what the status bar shows.
    pub fn count_request(&self, dest: Destination, bytes: u64) {
        let _ = self.with_db(|conn| match dest {
            Destination::Loopback => crate::db::add_egress(conn, 0, 0, 1, 0),
            Destination::PrivateServer => crate::db::add_egress(conn, 0, bytes, 0, 1),
        });
        if let Ok(status) = self.sovereign_status() {
            self.emit("core://sovereign", status);
        }
    }

    /// Counts the response bytes from the one explicitly enabled Web Search
    /// tool. No other subsystem uses this path; ordinary requests still pass
    /// through `classify_url`, where public destinations are refused.
    pub fn count_public_request(&self, bytes: u64) {
        let _ = self.with_db(|conn| crate::db::add_egress(conn, bytes, 0, 0, 0));
        if let Ok(status) = self.sovereign_status() {
            self.emit("core://sovereign", status);
        }
    }

    pub fn sovereign_status(&self) -> CoreResult<SovereignStatus> {
        let s = self.settings();
        let (public, private, device, private_req) = self.with_db(crate::db::egress)?;
        Ok(SovereignStatus {
            public_internet_bytes: public,
            private_server_bytes: private,
            device_requests: device,
            private_server_requests: private_req,
            egress_blocked: s.block_public_internet,
            private_server_name: if s.allow_private_server && !s.private_server_name.is_empty() {
                Some(s.private_server_name)
            } else {
                None
            },
        })
    }

    /* ---- §13 audit ---- */

    /// Records a tool call and returns the record so a step can carry it. Every
    /// call is logged, including the ones that were denied — a denial is the
    /// most interesting line in an audit log, not the least.
    pub fn audit(
        &self,
        tool: ToolName,
        args_summary: impl Into<String>,
        status: &str,
        started_at: i64,
        workspace_id: &str,
        run_id: Option<&str>,
        // `session_id` is the conversation the run sat in. `None` where there is
        // no run — a sandbox command launched from the Sandbox panel is the
        // operator acting directly, not a session doing it.
        session_id: Option<&str>,
        error: Option<String>,
    ) -> ToolCallRecord {
        let rec = ToolCallRecord {
            id: new_id("tc"),
            tool,
            args_summary: args_summary.into(),
            status: status.to_string(),
            started_at,
            duration_ms: (now_ms() - started_at).max(0) as u64,
            workspace_id: workspace_id.to_string(),
            error,
        };
        let _ = self.with_db(|conn| crate::db::record_tool_call(conn, &rec, run_id, session_id));
        rec
    }

    /* ---- runs ---- */

    pub fn register_run(&self, run_id: &str) -> RunHandle {
        let handle = RunHandle {
            run_id: run_id.to_string(),
            started_at: now_ms(),
            cancelled: Arc::new(AtomicBool::new(false)),
            models: Arc::new(Mutex::new(Vec::new())),
            plan: Arc::new(Mutex::new(Vec::new())),
        };
        self.runs.lock().expect("runs lock").insert(run_id.to_string(), handle.clone());
        handle
    }

    pub fn finish_run(&self, run_id: &str) {
        self.runs.lock().expect("runs lock").remove(run_id);
    }

    /// Cancels a run and releases anything waiting on a permission answer for
    /// *it*, so a cancelled run does not leave its prompt on screen — and a
    /// different chat's prompt, if one is also pending, stays exactly as it
    /// was. Rejecting every pending prompt was correct when there was one run
    /// at a time; with several chats running, Stop in one must not answer for
    /// another.
    pub fn cancel_run(&self, run_id: &str) -> bool {
        let found = {
            let runs = self.runs.lock().expect("runs lock");
            match runs.get(run_id) {
                Some(h) => {
                    h.cancelled.store(true, Ordering::Relaxed);
                    true
                }
                None => false,
            }
        };
        let pending: Vec<String> = {
            let perms = self.permissions.lock().expect("permissions lock");
            perms
                .iter()
                .filter(|(_, p)| p.run_id.as_deref() == Some(run_id))
                .map(|(id, _)| id.clone())
                .collect()
        };
        for id in pending {
            self.answer_permission(&id, PermissionDecision::Reject);
        }
        // The run's open ask_operator question resolves as cancelled rather
        // than vanishing: the loop would otherwise sit on the channel until
        // its timeout, and Stop would look like a hang.
        self.resolve_questions_for_run(
            run_id,
            "The run was cancelled by the operator before you received an answer. Stop working; \
say what you had finished so far.",
        );
        found
    }

    /* ---- §9 permissions ---- */

    /// Puts a request on screen and blocks this run until the operator answers.
    ///
    /// There is deliberately no timeout and no default. A prompt that expired
    /// into "allow" would make the approval theatre; a prompt that expired into
    /// "deny" would make a run fail because somebody went to lunch. So it waits,
    /// and the two ways out are the operator answering and the run being
    /// cancelled — `cancel_run` rejects the prompts belonging to that run,
    /// which is what makes Stop end a run that is sitting on a prompt.
    ///
    /// The sender is dropped if `answer_permission` is called for this id from
    /// somewhere else, which surfaces here as a receive error rather than a hang.
    pub async fn ask_permission(&self, req: &PermissionRequest) -> CoreResult<PermissionDecision> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.permissions
            .lock()
            .map_err(|_| {
                CoreError::ExecutionFailed(
                    "The permission table lock was poisoned by an earlier panic, so nothing was asked and nothing ran.".into(),
                )
            })?
            .insert(
                req.id.clone(),
                PendingPermission { run_id: req.run_id.clone(), tx },
            );

        self.emit("agent://permission", req.clone());

        match rx.await {
            Ok(d) => Ok(d),
            // No answer will arrive. Failing closed is the only safe reading.
            Err(_) => Err(CoreError::Denied(format!(
                "The approval prompt for {} was dismissed without an answer, so it was treated as a refusal and nothing was done.",
                req.target
            ))),
        }
    }

    pub fn answer_permission(&self, id: &str, decision: PermissionDecision) -> bool {
        let tx = self.permissions.lock().expect("permissions lock").remove(id).map(|p| p.tx);
        match tx {
            Some(tx) => tx.send(decision).is_ok(),
            None => false,
        }
    }

    /// Blocks until the operator answers `ask_operator`, the run is cancelled,
    /// or the wait times out. The reply is a free string; "no answer" is
    /// reported as its own message rather than an error, because the model
    /// should continue with what it has instead of treating a quiet operator
    /// as a failed tool.
    pub async fn ask_operator(
        &self,
        question: OperatorQuestion,
        timeout: std::time::Duration,
    ) -> CoreResult<String> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.questions
            .lock()
            .map_err(|_| {
                CoreError::ExecutionFailed(
                    "The question table lock was poisoned by an earlier panic, so the question was not delivered.".into(),
                )
            })?
            .insert(
                question.id.clone(),
                PendingQuestion { run_id: question.run_id.clone(), tx },
            );

        self.emit("agent://question", &question);

        let reply = match tokio::time::timeout(timeout, rx).await {
            // The channel also resolves if the sender was dropped — the run
            // ended without an answer — and `Err` here means exactly that.
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) | Err(_) => {
                self.questions
                    .lock()
                    .expect("questions lock")
                    .retain(|id, _| id != &question.id);
                "The operator did not answer in time. Proceed with what you already have, and \
say plainly in your answer which part you were unable to confirm."
                    .to_string()
            }
        };
        Ok(reply)
    }

    /// Delivers the operator's typed reply. Returns false when the question
    /// is gone (already answered, timed out, or its run cancelled).
    pub fn answer_question(&self, id: &str, answer: &str) -> bool {
        let tx = self.questions.lock().expect("questions lock").remove(id).map(|q| q.tx);
        match tx {
            Some(tx) => tx.send(answer.to_string()).is_ok(),
            None => false,
        }
    }

    /// Resolves the asking run's open question, if any, so cancellation does
    /// not leave the loop parked on a channel nobody will fill. The reply is
    /// worded as a fact the model can continue from, not an error to retry.
    pub fn resolve_questions_for_run(&self, run_id: &str, reply: &str) {
        let mut map = self.questions.lock().expect("questions lock");
        let ids: Vec<String> = map
            .iter()
            .filter(|(_, q)| q.run_id == run_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(q) = map.remove(&id) {
                let _ = q.tx.send(reply.to_string());
            }
        }
    }

    /// Whether a tool needs to ask. `AskAlways` asks for every write or
    /// execute; `AskRiskyOnly` asks for execute and destructive work;
    /// `AutoRunSandbox` asks only for destructive work. Reads
    /// inside an approved workspace never prompt — the approval already
    /// happened, at the folder.
    pub fn needs_approval(&self, tool: ToolName) -> bool {
        if self.session_grants.read().expect("grants lock").contains(&tool) {
            return false;
        }
        let Some(desc) = crate::registry::tool_by_name(tool) else {
            // Unknown tool: ask. Failing closed is the whole point.
            return true;
        };
        match self.settings().approval_policy {
            ApprovalPolicy::AskAlways => desc.requires_approval,
            ApprovalPolicy::AskRiskyOnly => {
                matches!(desc.risk, ToolRisk::Execute | ToolRisk::Destructive)
            }
            ApprovalPolicy::AutoRunSandbox => desc.risk == ToolRisk::Destructive,
        }
    }

    pub fn grant_session(&self, tool: ToolName) {
        let mut g = self.session_grants.write().expect("grants lock");
        if !g.contains(&tool) {
            g.push(tool);
        }
    }
}
