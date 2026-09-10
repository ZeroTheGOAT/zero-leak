//! §1 / §2 — the inference router.
//!
//! One `llama-server` process runs in router mode and owns every model child.
//! This module is the only thing in the core that talks to it, and every other
//! subsystem reaches inference through `chat`, `embed` or `vision` here. That is
//! deliberate: the brief forbids hardcoding a single inference framework, and a
//! single seam is what makes a second backend a new `endpoint` arm rather than a
//! rewrite of the agent loop.
//!
//! ## Why router mode rather than one server per model
//!
//! 8188 MiB of VRAM cannot hold two of the large models at once. Something has
//! to load, unload and re-load models as work moves between chat, OCR and
//! embeddings, and doing that by starting and stopping processes ourselves means
//! reimplementing what `--models-preset` already does — including the part where
//! a half-started child is cleaned up. The router keeps one supervisor process
//! whose lifetime we control with a job object, and model residency becomes an
//! HTTP call instead of a process tree problem.
//!
//! ## What the tuning is, and what it is not — all of this was measured
//!
//! Gemma 4 E4B Q4_0, 16K local profile, cold server, this machine (RTX 4060
//! Laptop 8188 MiB, i7-14700HX 20C/28T):
//!
//! | test                                    | pp tok/s | tg tok/s | VRAM     |
//! |-----------------------------------------|----------|----------|----------|
//! | `llama-bench -ngl 99 -ctk/ctv q8_0`     | 3704.5   | 70.7     | 4373 MiB |
//!
//! The full-offload profile is the measured baseline for the E4B replacement.
//! The router keeps llama.cpp's default batch and thread settings: on this
//! hardware, the useful headroom is better spent on the multimodal projector
//! and KV cache than on hand-tuned buffers.
//!
//! What that leaves as the real levers, in order of effect:
//!   1. Full GPU offload when memory permits. The native fitter now selects
//!      GPU layers automatically so smaller cards can use system RAM too.
//!   2. KV cache quantisation from the catalogue — what makes a 16384-token
//!      context fit in 6947 MiB instead of spilling.
//!   3. `--models-max` plus the VRAM admission check in `make_room` — keeping as
//!      many models resident as actually fit rather than a fixed count.
//!
//! `--cache-reuse 256` was measured too, because prompt reuse across agent turns
//! would cost no VRAM and agent loops resend near-identical prompts. It does
//! nothing on this build. With a 19-token change at the *head* of a 5047-token
//! prompt — the trimmed-history case, and the only case ordinary prefix caching
//! cannot already handle — turn two reprocessed all 5066 tokens either way:
//! 2506.2 ms without the flag, 2503.8 ms with it. (An earlier run appeared to
//! show reuse working; that test was invalid, because the two prompts shared a
//! literal prefix and so exercised prefix caching rather than the flag.) It is
//! not set: a flag that measures as inert is worse than no flag, because it
//! reads as a tuning decision that was never made.
//!
//! Anything further is per-model and lives in `ModelEntry::preset_options`, as
//! catalogue data. There is no `match` on a model id anywhere in this file.

use crate::logln;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::error::{CoreError, CoreResult};
use crate::registry;
use crate::state::{now_ms, AppState, Destination, RouterChild};
use crate::types::*;
use crate::winproc::{self, JobLimits};

/// How long a model may take to appear as loaded. olmOCR-2 is the slowest of the
/// catalogue at ~7.4 GiB and loads from a warm page cache in a few seconds; this
/// allows for a cold disk read of the largest file.
const LOAD_TIMEOUT: Duration = Duration::from_secs(240);
/// How long `llama-server` itself may take to answer `/health` after launch.
const BOOT_TIMEOUT: Duration = Duration::from_secs(45);
/// Residency poll interval. Fast enough that an LRU eviction shows up in the
/// Models panel while the user is still looking at it, slow enough to be free.
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/* ------------------------------------------------------------------ */
/* The contract other modules use                                      */
/* ------------------------------------------------------------------ */

/// Where streamed answer text goes. `agent.rs` passes a closure that forwards to
/// `agent://text`; `documents.rs` passes `None` because a page transcription has
/// no partial state worth showing.
///
/// The callback is tagged: `Answer` is text the operator asked for, `Thinking`
/// is the model's reasoning stream, which reaches the sink only when the
/// request was made with `enable_thinking` — the off path never parses it.
pub type DeltaSink<'a> = &'a (dyn Fn(&str, DeltaKind) + Send + Sync);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeltaKind {
    Answer,
    Thinking,
}

#[derive(Debug, Clone)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// Set on `tool` messages only, naming the call this answers.
    pub tool_call_id: Option<String>,
    /// Set on an `assistant` message only: the calls that turn actually made.
    ///
    /// These belong in the history structurally rather than as prose. An earlier
    /// version pushed the assistant turn as text and, when the model had said
    /// nothing alongside its call, invented `Calling: write_file` to stand in for
    /// it. Models imitate their own transcript: after two such rounds the model
    /// began *writing* `Calling: write_file` as its answer instead of calling
    /// anything, and the run ended with the work announced and not done.
    pub tool_calls: Vec<ToolCall>,
}

impl ChatMessage {
    pub fn system(c: impl Into<String>) -> Self {
        Self { role: "system".into(), content: c.into(), tool_call_id: None, tool_calls: Vec::new() }
    }
    pub fn user(c: impl Into<String>) -> Self {
        Self { role: "user".into(), content: c.into(), tool_call_id: None, tool_calls: Vec::new() }
    }
    /// A tool's output, tagged with the id of the call it answers.
    ///
    /// The id matters as soon as a model issues two calls in one turn: three
    /// `read_file` results with no ids are three messages the model has to match
    /// to its own calls by guessing, and it guesses wrong. `llama-server` passes
    /// `tool_call_id` straight through to the chat template, which is where the
    /// pairing is made.
    pub fn tool_result(call_id: &str, c: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: c.into(),
            tool_call_id: Some(call_id.to_string()).filter(|s| !s.is_empty()),
            tool_calls: Vec::new(),
        }
    }
    /// A previous answer, replayed as context for the turn after it.
    pub fn assistant(c: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: c.into(), tool_call_id: None, tool_calls: Vec::new() }
    }
    /// The assistant turn that issued tool calls, with whatever it said first.
    pub fn assistant_calls(c: impl Into<String>, calls: Vec<ToolCall>) -> Self {
        Self {
            role: "assistant".into(),
            content: c.into(),
            tool_call_id: None,
            tool_calls: calls,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// Already parsed. `llama-server` sends `arguments` as a JSON *string*, and
    /// unwrapping it here means no caller has to know that.
    pub arguments: Value,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub model_id: String,
    pub messages: Vec<ChatMessage>,
    pub max_tokens: u32,
    pub temperature: f32,
    /// OpenAI-shaped tool schemas. Empty means a plain completion.
    pub tools: Vec<Value>,
    pub enable_thinking: bool,
    /// A child role may choose a different local reasoning budget without
    /// changing the operator's default for every other live chat.
    pub thinking_effort: Option<ThinkingEffort>,
}

impl ChatRequest {
    pub fn new(model_id: impl Into<String>, messages: Vec<ChatMessage>) -> Self {
        Self {
            model_id: model_id.into(),
            messages,
            max_tokens: 2048,
            temperature: 0.2,
            tools: Vec::new(),
            enable_thinking: false,
            thinking_effort: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ChatResult {
    pub text: String,
    /// The model's reasoning stream, separate from the answer. Only populated
    /// when the request asked for thinking; otherwise empty by design.
    pub reasoning: String,
    pub tool_calls: Vec<ToolCall>,
    pub tokens_per_sec: f32,
    pub model_id: String,
    pub finish_reason: String,
}

/* ------------------------------------------------------------------ */
/* Status                                                              */
/* ------------------------------------------------------------------ */

pub async fn status(st: &AppState) -> CoreStatus {
    let child = st.router.lock().ok().and_then(|g| g.clone());
    let version = st.router_version.read().ok().and_then(|v| v.clone());

    match child {
        None => CoreStatus {
            state: "core_only".into(),
            ipc: true,
            router: false,
            router_version: None,
            detail: "The inference router is not running. Files, settings and the audit log work without it; start it from the Models panel to load a model.".into(),
        },
        Some(c) => {
            // A held handle is not proof of a live process, so this is asked
            // rather than assumed.
            let healthy = get_json(st, &format!("http://127.0.0.1:{}/health", c.port), Some(&c.api_key))
                .await
                .is_ok();
            if healthy {
                let loaded = st.loaded_ids().len();
                CoreStatus {
                    state: "connected".into(),
                    ipc: true,
                    router: true,
                    router_version: version,
                    detail: format!(
                        "Router on 127.0.0.1:{} — {loaded} model(s) resident of a {} MiB budget.",
                        c.port,
                        registry::vram_budget_mb()
                    ),
                }
            } else {
                CoreStatus {
                    state: "core_only".into(),
                    ipc: true,
                    router: false,
                    router_version: version,
                    detail: format!(
                        "The router process (pid {}) is not answering on 127.0.0.1:{}. Restart it from the Models panel.",
                        c.pid, c.port
                    ),
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

/// Starts the router, or returns the running one's status.
///
/// Takes `&Arc<AppState>` because the watcher and the residency poller outlive
/// this call and need their own handle.
pub async fn start(st: &Arc<AppState>) -> CoreResult<CoreStatus> {
    if let Some(c) = st.router.lock().ok().and_then(|g| g.clone()) {
        if get_json(st, &format!("http://127.0.0.1:{}/health", c.port), Some(&c.api_key))
            .await
            .is_ok()
        {
            return Ok(status(st).await);
        }
        // Held handle, dead process. Clear it before starting another, or the
        // job object of the old one leaks until the app exits.
        shutdown_blocking(st);
    }

    let s = st.settings();

    let exe = PathBuf::from(&s.llama_server_path);
    if !exe.is_file() {
        return Err(CoreError::ModelLoadFailed(format!(
            "No llama-server executable at {}. Set the path in Settings > Runtime; nothing was started.",
            exe.display()
        )));
    }

    let (ini, skipped) = write_preset_ini(st)?;

    // Models whose weights are missing get an explicit reason rather than
    // sitting in the list as a silent "Unloaded".
    for (id, why) in &skipped {
        st.set_model_state(id, |m| {
            m.state = ModelState::Unloaded;
            m.last_error = Some(why.clone());
        });
    }

    // Held until just before the child spawns: the reservation keeps other
    // processes off the port until llama-server can bind it itself. An
    // operator-pinned port is taken as given — the failure of a fixed port to
    // bind is the child's to report, in its own words.
    let (port, _reservation) = if s.router_port != 0 {
        (s.router_port, None)
    } else {
        let r = reserve_port()?;
        (r.port, Some(r))
    };
    // 256 bits from the same CSPRNG that backs uuid v4. Loopback is not a
    // boundary on a shared workstation: without this, any other process on the
    // machine could drive the operator's models and read what they return.
    let api_key = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    let mut cmd = Command::new(&exe);
    cmd.arg("--models-preset").arg(&ini)
        .arg("--models-max").arg(s.max_resident_models.max(1).to_string())
        .arg("--host").arg(registry::ROUTER_BIND_HOST)
        .arg("--port").arg(port.to_string())
        // The server warns at startup when CORS is `*` with no key. Both halves
        // of that warning are closed here.
        .arg("--api-key").arg(&api_key)
        .arg("--cors-origins").arg("localhost")
        // Nothing should be able to reach the models except this application,
        // and a second UI on the same port is a second attack surface.
        .arg("--no-webui");

    // stdout/stderr are captured so a load failure can be quoted back instead
    // of being summarised as "it did not work".
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let mut contained = winproc::spawn_contained(cmd, JobLimits::router())?;
    let pid = contained.pid;
    let stopping = Arc::new(AtomicBool::new(false));

    // Drain the pipes. A child whose stderr fills its buffer blocks forever, so
    // this is required for correctness, not just for diagnostics.
    let log = Arc::new(std::sync::Mutex::new(String::new()));

    // `ChildStdout` and `ChildStderr` are distinct types, so the two pipes get
    // one generic drainer each rather than being forced into a single
    // collection. Both write into the same buffer: llama-server splits its
    // output across the two unpredictably, and a load failure reads more
    // clearly in the order it actually happened.
    fn drain<R: std::io::Read + Send + 'static>(stream: R, sink: Arc<std::sync::Mutex<String>>) {
        std::thread::spawn(move || {
            use std::io::BufRead;
            let reader = std::io::BufReader::new(stream);
            for line in reader.lines().map_while(Result::ok) {
                if let Ok(mut g) = sink.lock() {
                    // Bounded: the last 64 KiB is enough to explain a failure
                    // and cannot grow without limit over a long session.
                    if g.len() > 64 * 1024 {
                        let mut cut = g.len() - 32 * 1024;
                        while !g.is_char_boundary(cut) { cut += 1; }
                        *g = g.split_off(cut);
                    }
                    g.push_str(&line);
                    g.push('\n');
                }
            }
        });
    }

    if let Some(out) = contained.child.stdout.take() {
        drain(out, log.clone());
    }
    if let Some(err) = contained.child.stderr.take() {
        drain(err, log.clone());
    }

    let child = RouterChild {
        pid,
        port,
        api_key: api_key.clone(),
        stopping: stopping.clone(),
        kill: contained.killer(),
    };
    *st.router.lock().map_err(|_| lock_err("router"))? = Some(child);

    // The watcher owns the `Child` so nothing else has to `wait()` on it, which
    // is what stops the process becoming a zombie.
    {
        let watch_st = st.clone();
        let watch_log = log.clone();
        let watch_stopping = stopping.clone();
        let mut proc = contained.child;
        std::thread::spawn(move || {
            let code = proc.wait().ok().and_then(|s| s.code());
            if watch_stopping.load(Ordering::Relaxed) {
                return; // An orderly stop is not a failure.
            }
            let tail = watch_log
                .lock()
                .map(|g| g.lines().rev().take(8).collect::<Vec<_>>().join(" | "))
                .unwrap_or_default();
            let _ = watch_st.router.lock().map(|mut g| *g = None);
            for id in watch_st.loaded_ids() {
                watch_st.set_model_state(&id, |m| {
                    m.state = ModelState::Unloaded;
                    m.resident_vram_mb = None;
                });
            }
            watch_st.emit(
                "core://status",
                CoreStatus {
                    state: "core_only".into(),
                    ipc: true,
                    router: false,
                    router_version: None,
                    detail: format!(
                        "The inference router exited unexpectedly{}. No model is resident. {tail}",
                        code.map(|c| format!(" with code {c}")).unwrap_or_default()
                    ),
                },
            );
        });
    }

    // Wait for it to answer before claiming it started.
    let deadline = Instant::now() + BOOT_TIMEOUT;
    let health = format!("http://127.0.0.1:{port}/health");
    loop {
        if get_json(st, &health, Some(&api_key)).await.is_ok() {
            break;
        }
        if Instant::now() >= deadline {
            let tail = log.lock().map(|g| g.clone()).unwrap_or_default();
            shutdown_blocking(st);
            return Err(CoreError::ModelLoadFailed(format!(
                "llama-server did not answer on 127.0.0.1:{port} within {}s and was terminated. Last output: {}",
                BOOT_TIMEOUT.as_secs(),
                tail.lines().rev().take(10).collect::<Vec<_>>().join(" | ")
            )));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // `/props` carries the build, which belongs in the status bar: a preset that
    // works on one build is not guaranteed on another, and the operator should
    // be able to read which one is running without opening a log.
    if let Ok(props) = get_json(st, &format!("http://127.0.0.1:{port}/props"), Some(&api_key)).await {
        if let Some(build) = props.get("build_info").and_then(Value::as_str) {
            if let Ok(mut v) = st.router_version.write() {
                *v = Some(build.to_string());
            }
        }
    }

    refresh_models(st).await?;
    spawn_poller(st.clone(), port);

    Ok(status(st).await)
}

pub async fn stop(st: &Arc<AppState>) -> CoreResult<CoreStatus> {
    shutdown_blocking(st);
    Ok(status(st).await)
}

/// Synchronous teardown, for the window-destroyed path where there is no
/// runtime left to await on.
pub fn shutdown_blocking(st: &Arc<AppState>) {
    let child = st.router.lock().ok().and_then(|mut g| g.take());
    if let Some(c) = child {
        c.stopping.store(true, Ordering::Relaxed);
        (c.kill)();
    }
    if let Ok(mut v) = st.router_version.write() {
        *v = None;
    }
    let ids: Vec<String> = st
        .models
        .read()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for id in ids {
        st.set_model_state(&id, |m| {
            if m.state != ModelState::Unloaded {
                m.state = ModelState::Unloaded;
                m.resident_vram_mb = None;
            }
        });
    }
}

/// Which loaded models have gone unused long enough to give their VRAM back.
///
/// Pure, so the rule that matters — never take a model out from under a running
/// chat — is testable without a router process.
fn idle_victims(models: &[ModelRuntime], in_use: &HashSet<String>, cutoff: i64) -> Vec<String> {
    models
        .iter()
        // Only `Loaded`: a `Loading` model has an admission decision behind it
        // that has not finished, and an `Unloading` one is already going.
        .filter(|r| r.state == ModelState::Loaded && !in_use.contains(&r.id))
        // No recorded use means no idle time to measure, so it is left alone.
        .filter(|r| r.last_used_at.is_some_and(|at| at < cutoff))
        .map(|r| r.id.clone())
        .collect()
}

/// Unloads models nothing has used for `model_idle_evict_sec` seconds.
///
/// The setting has existed since the first build and two views state it as fact
/// — `SettingsView` offers the number, `ModelManagerView` tells the operator that
/// idle models are released — but nothing implemented it. So a chat model kept
/// its 4945 MiB for the rest of the session, and the next OCR page paid for an
/// eviction that should already have happened, or failed admission outright. On a
/// card this size an idle model holding half of it is the difference between the
/// handwriting model loading and not.
///
/// A model any live run has noted is never evicted: unloading one a chat is
/// generating from would fail that chat mid-answer. Unlike `make_room` this does
/// not exempt the asking run, because the poller is not inside one — every noted
/// model belongs to somebody else. Setting the value to zero turns the sweep off,
/// which is what an operator who wants a model pinned for a demo needs.
async fn evict_idle(st: &AppState) {
    let seconds = i64::from(st.settings().model_idle_evict_sec);
    if seconds <= 0 {
        return;
    }
    let cutoff = now_ms() - seconds * 1000;

    let in_use: HashSet<String> = match st.runs.lock() {
        Ok(runs) => runs.values().flat_map(|h| h.noted_models()).collect(),
        // A poisoned lock is not a reason to start unloading things.
        Err(_) => return,
    };
    let idle = match st.models.read() {
        Ok(models) => {
            let all: Vec<ModelRuntime> = models.values().cloned().collect();
            idle_victims(&all, &in_use, cutoff)
        }
        Err(_) => return,
    };

    for id in idle {
        // One failure does not stop the sweep, and it is not the operator's
        // problem: the model stays resident and the next pass tries again.
        if let Err(e) = unload(st, &id).await {
            logln!("[router] Idle eviction of {id} failed: {}", e.message());
        }
    }
}

/// Polls residency so LRU evictions the router performs on its own show up in
/// the UI, and runs the idle sweep. Ends when the router it was started for is
/// gone, so a restart does not leave two pollers running.
fn spawn_poller(st: Arc<AppState>, port: u16) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let still_ours = st
                .router
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .map(|c| c.port == port)
                .unwrap_or(false);
            if !still_ours {
                return;
            }
            let _ = refresh_models(&st).await;
            evict_idle(&st).await;
        }
    });
}

/* ------------------------------------------------------------------ */
/* The preset file                                                     */
/* ------------------------------------------------------------------ */

/// Generates `models.ini` from the catalogue.
///
/// Returns the path and the models left out, with the reason. Verified against
/// build b10718: the router merges its own command line into every child's
/// preset, and keys written here override it — so global tuning and per-model
/// overrides layer correctly, and `preset_options` from the catalogue wins.
///
/// Written on router start and again when the models directory moves: the file
/// records absolute weight paths, and the offline/air-gapped setup reads it back
/// to rehydrate the catalogue, so a moved folder has to be re-rendered rather
/// than waiting for the next start.
pub(crate) fn write_preset_ini(st: &AppState) -> CoreResult<(PathBuf, Vec<(String, String)>)> {
    // `model_preset_path` is the real destination, not a label. The Models
    // panel tells the operator "sizes match the curated preset at
    // {modelPresetPath}", which was true only because the default happened to
    // equal the location hardcoded here; writing where the setting points makes
    // that claim true by construction, and lets the preset live off the system
    // drive on a machine where it has to.
    let configured = st.settings().model_preset_path;
    let path = if configured.trim().is_empty() {
        registry::config_dir().join("models.ini")
    } else {
        PathBuf::from(configured.trim())
    };
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }

    let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
    let entries: Vec<ModelEntry> = reg.all().to_vec();
    drop(reg);

    // Auto-size context before rendering. A model whose window is VRAM-pinned —
    // agentic and far below its training ceiling — may be launched with more
    // context than the catalogue baseline if this card can hold the extra KV
    // cache (the number written below is what llama-server is actually started
    // with). The raised windows are recorded back on the registry so routing and
    // the agent's context note never trust a bigger window than the one about to
    // launch, and never a smaller one either.
    let solo_mb = registry::vram_solo_mb();
    let mut launched: Vec<ModelEntry> = Vec::with_capacity(entries.len());
    let mut raised: Vec<(String, u32)> = Vec::new();
    for mut e in entries {
        // Mirror render's launchability so an override is never recorded for a
        // model the preset does not actually include.
        let launchable = e.priority != ModelPriority::Disabled
            && e.location == ModelLocation::ThisDevice
            && Path::new(&e.source).is_file()
            && e.projector.as_deref().is_none_or(|p| Path::new(p).is_file());
        let geometry = if launchable && registry::context_auto_eligible(&e) {
            crate::gguf::kv_geometry(Path::new(&e.source))
        } else {
            None
        };
        // Sizing falls back to the catalogue window for anything not eligible,
        // not on disk, or whose geometry the reader cannot determine.
        let effective = registry::autosized_context(&e, geometry, solo_mb);
        if effective != e.context_size {
            raised.push((e.id.clone(), effective));
            e.context_size = effective;
        }
        launched.push(e);
    }

    let (out, skipped) = render_preset_ini(&launched);
    std::fs::write(&path, out)?;

    if st.router.lock().map_err(|_| lock_err("router"))?.is_none() {
        let mut reg = st.registry.write().map_err(|_| lock_err("registry"))?;
        reg.set_ctx_overrides(&raised);
    }
    Ok((path, skipped))
}

/// Renders the `models.ini` body from one catalogue snapshot: a `[id]` section
/// per enabled this-device model whose weights (and projector, if any) are on
/// disk. Disabled models, private-server models and models whose files have
/// moved away are left out and reported back rather than written — a preset must
/// never point at weights that are not there.
///
/// Pure apart from the `Path::is_file` probes, so the router-start write and a
/// rewrite after the models directory moves share one implementation and cannot
/// drift.
fn render_preset_ini(entries: &[ModelEntry]) -> (String, Vec<(String, String)>) {
    let mut out = String::from(
        "; Generated by Sovereign AI Workbench from the model catalogue.\n\
         ; Edit models.json instead — this file is rewritten on every start.\n\n",
    );
    let mut skipped = Vec::new();

    for e in entries {
        if e.priority == ModelPriority::Disabled {
            continue;
        }
        // A model served by an approved private server has no local child.
        if e.location != ModelLocation::ThisDevice || e.backend != ModelBackend::LlamaCpp {
            continue;
        }
        if !Path::new(&e.source).is_file() {
            skipped.push((
                e.id.clone(),
                format!(
                    "The weights for {} were not found at {}. Nothing was loaded and the file on disk was not modified.",
                    e.display_name, e.source
                ),
            ));
            continue;
        }
        if let Some(p) = &e.projector {
            if !Path::new(p).is_file() {
                skipped.push((
                    e.id.clone(),
                    format!(
                        "{} needs its vision projector, which was not found at {p}. It was left out rather than loaded text-only.",
                        e.display_name
                    ),
                ));
                continue;
            }
        }

        // BTreeMap so the generated file is byte-stable between runs and a diff
        // of it means something changed.
        let mut keys: BTreeMap<&str, String> = BTreeMap::new();
        keys.insert("model", e.source.clone());
        if let Some(p) = &e.projector {
            keys.insert("mmproj", p.clone());
        }
        // Zero is llama.cpp's auto context mode: its native memory fitter uses
        // the actual model architecture, trained limit and currently free memory.
        // One sequence avoids splitting the fitted window across parallel slots.
        let generation_model = !e.capabilities.contains(&ModelCapability::Embeddings);
        let auto_context = generation_model && e.context_mode == ContextMode::Auto;
        keys.insert("ctx-size", if auto_context { "0".into() } else { e.context_limit.unwrap_or(e.context_size).to_string() });
        if generation_model {
            keys.insert("fit", "on".into());
            keys.insert("fit-ctx", "512".into());
            keys.insert("parallel", "1".into());
            // The multimodal encoder is separate from the decoder's fitter.
            // Reserve its on-disk size plus workspace before allocating KV.
            let projector_mb = e.projector.as_deref().and_then(|p| std::fs::metadata(p).ok())
                .map(|m| m.len().div_ceil(1024 * 1024)).unwrap_or(0);
            keys.insert("fit-target", (1024 + projector_mb).to_string());
        }
        // Prefer full GPU offload, but permit CPU layers if even the minimum
        // automatic window cannot fit. Manual context remains fixed during fit.
        keys.insert("n-gpu-layers", if generation_model { "auto".into() } else { "999".into() });
        if let Some(kv) = &e.kv_cache_type {
            keys.insert("cache-type-k", kv.clone());
            keys.insert("cache-type-v", kv.clone());
        }
        // Residency is decided here, by VRAM budget, not by whichever model
        // happens to be listed first.
        keys.insert("load-on-startup", "false".to_string());

        let mut extra = String::new();
        if let Some(opts) = &e.preset_options {
            for (k, v) in opts {
                if generation_model && ["ctx-size", "c", "LLAMA_ARG_CTX_SIZE", "fit", "fit-ctx", "fit-target", "parallel", "np", "n-parallel", "n-gpu-layers", "ngl", "gpu-layers", "LLAMA_ARG_N_GPU_LAYERS", "LLAMA_ARG_FIT", "LLAMA_ARG_FIT_CTX", "LLAMA_ARG_FIT_TARGET", "LLAMA_ARG_N_PARALLEL"].contains(&k.as_str()) { continue; }
                extra.push_str(&format!("{k} = {v}\n"));
            }
        }

        out.push_str(&format!("[{}]\n", e.id));
        for (k, v) in &keys {
            out.push_str(&format!("{k} = {v}\n"));
        }
        out.push_str(&extra);
        out.push('\n');
    }
    (out, skipped)
}

/// Picks a port and keeps the reservation alive until the caller is about to
/// hand it to llama-server.
///
/// The plain `free_port` has a window between dropping the listener and the
/// child binding where another process can claim the port — a race whose
/// failure mode is a boot timeout that sends the operator looking at VRAM when
/// the problem is a taken port. Holding the socket until just before spawn
/// closes almost all of that window, because the OS will not hand a bound port
/// to another asker while our listener exists. The listener is bound on the
/// current thread and released on drop, so the reservation lasts exactly as
/// long as this value does — hence the guard type rather than a bare number.
///
/// The residual window (between `drop` and the child's own bind, ~tens of
/// milliseconds) is closed the honest way instead: the boot health check below
/// turns a stolen port into a clear "did not answer" error with the log tail,
/// and `start` can be called again, which picks a fresh port.
struct PortReservation {
    port: u16,
    _listener: std::net::TcpListener,
}

fn reserve_port() -> CoreResult<PortReservation> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not reserve a loopback port for the router: {e}"))
    })?;
    let port = l.local_addr().map(|a| a.port()).map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not read the reserved port: {e}"))
    })?;
    Ok(PortReservation { port, _listener: l })
}

/* ------------------------------------------------------------------ */
/* Residency                                                           */
/* ------------------------------------------------------------------ */

pub async fn list_models(st: &AppState) -> CoreResult<Vec<ModelRuntime>> {
    Ok(st.model_runtimes())
}

/// Reads residency from the router and updates the cache, emitting only for the
/// models whose state actually changed. Without that comparison a 2-second
/// poller would push seven events every two seconds forever.
pub async fn refresh_models(st: &AppState) -> CoreResult<()> {
    let (port, key) = router_addr(st)?;
    let body = get_json(st, &format!("http://127.0.0.1:{port}/v1/models"), Some(&key)).await?;

    let Some(list) = body.get("data").and_then(Value::as_array) else {
        return Err(CoreError::ExecutionFailed(
            "The router's model list was not in the expected shape; residency was left as it was.".into(),
        ));
    };

    for item in list {
        let Some(id) = item.get("id").and_then(Value::as_str) else { continue };
        let raw = item
            .get("status")
            .and_then(|s| s.get("value"))
            .and_then(Value::as_str)
            .unwrap_or("unloaded");
        let next = match raw {
            "loaded" => ModelState::Loaded,
            "loading" => ModelState::Loading,
            "unloading" => ModelState::Unloading,
            _ => ModelState::Unloaded,
        };

        let current = st.models.read().ok().and_then(|m| m.get(id).map(|r| r.state));
        if current == Some(next) {
            continue;
        }
        if next == ModelState::Loaded {
            let mut url = reqwest::Url::parse(&format!("http://127.0.0.1:{port}/props"))
                .map_err(|e| CoreError::ExecutionFailed(e.to_string()))?;
            url.query_pairs_mut().append_pair("model", id);
            let props = get_json(st, url.as_str(), Some(&key)).await?;
            let context = context_from_props(&props).ok_or_else(|| CoreError::ModelLoadFailed(format!(
                "The runtime loaded '{id}' but did not report its context window. Update llama.cpp and restart the model runtime."
            )))?;
            st.registry.write().map_err(|_| lock_err("registry"))?.record_loaded_context(id, context);
        }
        st.set_model_state(id, |m| {
            m.state = next;
            if next == ModelState::Loaded {
                m.last_error = None;
            }
            if next == ModelState::Unloaded {
                m.resident_vram_mb = None;
            }
        });
    }
    Ok(())
}

fn context_from_props(props: &Value) -> Option<u32> {
    props.pointer("/default_generation_settings/n_ctx").and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0)
}

pub async fn load_model(st: &AppState, id: &str) -> CoreResult<ModelRuntime> {
    ensure_loaded(st, id).await?;
    current_runtime(st, id)
}

pub async fn evict_model(st: &AppState, id: &str) -> CoreResult<ModelRuntime> {
    unload(st, id).await?;
    current_runtime(st, id)
}

fn current_runtime(st: &AppState, id: &str) -> CoreResult<ModelRuntime> {
    Ok(st
        .models
        .read()
        .map_err(|_| lock_err("models"))?
        .get(id)
        .cloned()
        .unwrap_or_else(|| ModelRuntime::unloaded(id)))
}

/// Confirms the weights on disk are a GGUF file before anything is evicted for
/// them.
///
/// Without this, a truncated download or a Git-LFS pointer left unfetched fails
/// several seconds later as "did not become resident", which sends the operator
/// looking at VRAM and at the router when the problem is a 133-byte file. Worse,
/// by then `make_room` has already evicted a working model to make space for one
/// that was never going to load.
///
/// The check is the four magic bytes and a plausible size, not a full parse. A
/// full parse would duplicate llama.cpp's job and would still not prove the
/// tensors are intact; these two catch every failure that has actually happened
/// here — a missing file, an LFS pointer, an interrupted copy.
pub(crate) fn check_weights(entry: &ModelEntry) -> CoreResult<()> {
    for (path, what) in [(Some(&entry.source), "weights"), (entry.projector.as_ref(), "projector")]
    {
        let Some(path) = path else { continue };
        let meta = std::fs::metadata(path).map_err(|e| {
            CoreError::ModelLoadFailed(format!(
                "The {what} for {} are not at {path} ({e}). Nothing was evicted. Check                  Settings → Models points at the folder holding your GGUF files.",
                entry.display_name
            ))
        })?;
        // A GGUF small enough to fit in a page is not a model. A Git-LFS pointer
        // is 130-odd bytes and reads as a perfectly valid file.
        if meta.len() < 4096 {
            return Err(CoreError::CorruptModel(format!(
                "The {what} for {} is only {} bytes ({path}), which is too small to be a model —                  this is what an unfetched Git-LFS pointer or an interrupted copy looks like.",
                entry.display_name,
                meta.len()
            )));
        }
        let mut magic = [0u8; 4];
        let read = std::fs::File::open(path)
            .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut magic).map(|_| ()));
        if read.is_err() || &magic != b"GGUF" {
            return Err(CoreError::CorruptModel(format!(
                "{path} does not begin with the GGUF magic bytes, so it is not a file llama.cpp can load as {}'s {what}.",
                entry.display_name
            )));
        }
    }
    Ok(())
}

/// Makes `model_id` resident, freeing VRAM first if it will not otherwise fit.
///
/// Idempotent and safe to call before every request — a model already loaded
/// costs one map read.
pub async fn ensure_loaded(st: &AppState, model_id: &str) -> CoreResult<()> {
    let entry = {
        let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
        reg.require(model_id)?.clone()
    };

    if entry.priority == ModelPriority::Disabled {
        return Err(CoreError::Denied(format!(
            "{} is disabled in the catalogue and was not loaded. Enable it in models.json if you want it available.",
            entry.display_name
        )));
    }
    // A private-server model has no local residency to arrange.
    if entry.location != ModelLocation::ThisDevice {
        return Ok(());
    }

    // Pin the model to the asking run before anything else, so that even while
    // it is only Loading it counts as in use: another chat's `make_room` must
    // not evict a model this run is midway through bringing resident. Outside
    // a run (Models panel, knowledge indexing) there is nothing to pin to.
    crate::state::note_model_on_current_run(model_id);

    let state = st.models.read().ok().and_then(|m| m.get(model_id).map(|r| r.state));
    if state == Some(ModelState::Loaded) {
        st.set_model_state(model_id, |m| m.last_used_at = Some(now_ms()));
        return Ok(());
    }

    // One load pipeline at a time. See `model_load_lock`. The already-loaded
    // fast path above stays outside the lock, so a second chat asking for a
    // resident model is never delayed by a first chat's load.
    let _load_guard = st.model_load_lock.lock().await;

    // Re-checked under the lock: another chat's load may have finished between
    // the fast path and here, including this very model.
    let state = st.models.read().ok().and_then(|m| m.get(model_id).map(|r| r.state));
    if state == Some(ModelState::Loaded) {
        st.set_model_state(model_id, |m| m.last_used_at = Some(now_ms()));
        return Ok(());
    }

    // A load already in flight is not a reason to start a second one.
    //
    // The router answers a second `/models/load` for the same model with a 400
    // and "model is already running", which would fail a turn over a model that
    // was two seconds from ready. That collision is not hypothetical: the most
    // likely moment for it is the first question after launch, while the model
    // that was resident last time is being restored in the background. So join
    // the wait below rather than asking again — the caller wants the model
    // resident, and it is on its way there.
    let joining = state == Some(ModelState::Loading);
    let before = free_vram_mb().await;
    let started = Instant::now();

    if !joining {
        check_weights(&entry)?;
        make_room(st, &entry).await?;

        let (port, key) = router_addr(st)?;
        st.set_model_state(model_id, |m| {
            m.state = ModelState::Loading;
            m.last_error = None;
        });

        let res = post_json(
            st,
            &format!("http://127.0.0.1:{port}/models/load"),
            Some(&key),
            json!({ "model": model_id }),
        )
        .await;

        if let Err(e) = res {
            // Whether the model is resident is a question about the router, not
            // about the status code of the request that asked for it. A router
            // that outlived the last app session is already holding this model
            // and refuses the load; looking is the honest way to find out.
            let resident = refresh_models(st).await.is_ok()
                && st.models.read().ok().and_then(|m| m.get(model_id).map(|r| r.state))
                    == Some(ModelState::Loaded);
            if resident {
                st.set_model_state(model_id, |m| m.last_used_at = Some(now_ms()));
                return Ok(());
            }
            st.set_model_state(model_id, |m| {
                m.state = ModelState::Unloaded;
                m.last_error = Some(e.message());
            });
            return Err(e);
        }
    }

    // `/models/load` returns as soon as the child is spawned — measured at 12 ms
    // for a 6.9 GiB model, which is plainly not a completed load. Residency has
    // to be waited for.
    let deadline = Instant::now() + LOAD_TIMEOUT;
    loop {
        refresh_models(st).await?;
        match st.models.read().ok().and_then(|m| m.get(model_id).map(|r| r.state)) {
            Some(ModelState::Loaded) => break,
            Some(ModelState::Unloaded) if started.elapsed() > Duration::from_secs(3) => {
                // The child exited instead of becoming resident. This is just as
                // conclusive for a joiner: a joiner has seen `Loading` by
                // definition, so a later `Unloaded` can only mean the load it
                // joined ended without success, and polling on to the full
                // LOAD_TIMEOUT would report a four-minute stall over a failure
                // that was already on record. The grace period exists for the
                // owner's registration window — the router's model list needs a
                // moment to name a child that was only just spawned.
                let recorded = st
                    .models
                    .read()
                    .ok()
                    .and_then(|m| m.get(model_id).and_then(|r| r.last_error.clone()))
                    .unwrap_or_else(|| "the router reported it as unloaded".to_string());
                let msg = format!(
                    "{} did not become resident: {recorded}. Nothing else was evicted to make \
                     room a second time.",
                    entry.display_name
                );
                st.set_model_state(model_id, |m| {
                    m.state = ModelState::Unloaded;
                    m.last_error = Some(msg.clone());
                });
                return Err(CoreError::ModelLoadFailed(msg));
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            let msg = format!(
                "{} was still loading after {}s. It was left as-is rather than reported ready.",
                entry.display_name,
                LOAD_TIMEOUT.as_secs()
            );
            st.set_model_state(model_id, |m| m.last_error = Some(msg.clone()));
            return Err(CoreError::Timeout(msg));
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    let load_ms = started.elapsed().as_millis() as u64;
    // A measured delta, or nothing. An estimate presented as a measurement in a
    // panel labelled "resident VRAM" would be a lie the operator cannot check.
    let resident = match (before, free_vram_mb().await) {
        (Some(b), Some(a)) if b > a => Some(b - a),
        _ => None,
    };

    st.set_model_state(model_id, |m| {
        m.state = ModelState::Loaded;
        m.load_time_ms = Some(load_ms);
        m.resident_vram_mb = resident;
        m.last_used_at = Some(now_ms());
        m.last_error = None;
    });
    Ok(())
}

async fn unload(st: &AppState, model_id: &str) -> CoreResult<()> {
    let (port, key) = router_addr(st)?;
    st.set_model_state(model_id, |m| m.state = ModelState::Unloading);

    let res = post_json(
        st,
        &format!("http://127.0.0.1:{port}/models/unload"),
        Some(&key),
        json!({ "model": model_id }),
    )
    .await;

    // A 400 here means "model is not running", which is the state we wanted.
    if let Err(e) = res {
        if !e.message().contains("not running") {
            st.set_model_state(model_id, |m| {
                m.state = ModelState::Loaded;
                m.last_error = Some(e.message());
            });
            return Err(e);
        }
    }

    st.set_model_state(model_id, |m| {
        m.state = ModelState::Unloaded;
        m.resident_vram_mb = None;
    });
    Ok(())
}

/// VRAM admission control — the part that makes residency a budget rather than a
/// count.
///
/// `--models-max` is the router's own limit and it counts processes, not bytes:
/// with it set to 2 the router will happily start a second child that does not
/// fit and let CUDA fail the allocation. So the budget is enforced here, from
/// the catalogue's measured `estimated_vram_mb`, and the router's LRU stays as a
/// backstop. Least-recently-used goes first, which is why `last_used_at` is
/// touched on every request rather than only on load.
async fn make_room(st: &AppState, want: &ModelEntry) -> CoreResult<()> {
    // The sharing budget is not the ceiling for a model that will be alone on
    // the card. Only a model that cannot fit even by itself is impossible.
    let managed_context = !want.capabilities.contains(&ModelCapability::Embeddings);
    if !managed_context && want.estimated_vram_mb > registry::vram_solo_mb() {
        return Err(CoreError::InsufficientVram(format!(
            "{} needs about {} MiB and the most a single model may hold on this device is {} MiB of {} MiB total. Nothing was evicted and nothing was loaded.",
            want.display_name,
            want.estimated_vram_mb,
            registry::vram_solo_mb(),
            registry::vram_total_mb()
        )));
    }
    // The router's own count. Admission has to respect it too: admitting a model
    // the router will not keep means the router evicts one of its own choosing,
    // including a model a concurrent chat is generating from.
    let cap = st.settings().max_resident_models.max(1) as usize;

    // Bounded: each pass evicts exactly one victim, so the loop cannot need
    // more passes than there are resident models plus one. A router that
    // reports an unload succeeded while the model stays resident (or a
    // concurrent load re-filling between passes) would otherwise spin here
    // forever — a turn that hangs with no error and no progress. The bound is
    // generous rather than exact because a concurrent load is legitimate churn,
    // not failure; but a ceiling that can never be hit in a healthy system is
    // the difference between "slower" and "stuck".
    let max_passes = cap + st.models.read().map(|m| m.len()).unwrap_or(0) + 2;
    let mut passes = 0usize;

    loop {
        passes += 1;
        if passes > max_passes {
            return Err(CoreError::InsufficientVram(format!(
                "{} needed about {} MiB, and after {} admission passes the resident set was not \
                 shrinking as expected — a model may be failing to unload while still reporting \
                 success. Nothing further was evicted. Check the router's status in the Models \
                 panel and restart it if it is wedged.",
                want.display_name,
                want.estimated_vram_mb,
                passes - 1,
            )));
        }
        // Recomputed each pass: an eviction changes the set, and a run may have
        // started or finished since the last pass.
        //
        // Models another live run has noted are not candidates. Unloading a
        // model a running chat is generating from would fail that chat
        // mid-answer — the one interference concurrent chats must never cause
        // each other. The asking run's own earlier models stay evictable: a
        // single run moving from its router model to a coding model is normal
        // turnover, not contention.
        let asking_run = crate::state::current_run().map(|(run_id, _)| run_id);
        let in_use: HashSet<String> = {
            let runs = st.runs.lock().map_err(|_| lock_err("runs"))?;
            runs.values()
                .filter(|h| asking_run.as_deref() != Some(h.run_id.as_str()))
                .flat_map(|h| h.noted_models())
                .collect()
        };
        let held_mb: u32 = {
            let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
            in_use
                .iter()
                .filter_map(|id| reg.get(id).map(|e| if !e.capabilities.contains(&ModelCapability::Embeddings) { registry::vram_solo_mb() } else { e.estimated_vram_mb }))
                .sum()
        };
        let resident: Vec<(String, u32, Option<i64>)> = {
            let models = st.models.read().map_err(|_| lock_err("models"))?;
            let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
            models
                .values()
                .filter(|r| {
                    r.id != want.id
                        && matches!(r.state, ModelState::Loaded | ModelState::Loading)
                        && !in_use.contains(&r.id)
                })
                .filter_map(|r| {
                    reg.get(&r.id)
                        .map(|e| (r.id.clone(), r.resident_vram_mb.unwrap_or_else(|| if !e.capabilities.contains(&ModelCapability::Embeddings) { registry::vram_solo_mb() } else { e.estimated_vram_mb }), r.last_used_at))
                })
                .collect()
        };

        let used: u32 = resident.iter().map(|(_, mb, _)| *mb).sum();
        // How many the router is already holding, counting the ones this pass
        // may not touch.
        let live = in_use.len() + resident.len();
        let fits_bytes = if managed_context {
            // Maximise context with the device to itself. Wait rather than
            // evict a model that another live task is using.
            live == 0
        } else if live == 0 {
            // Alone on the card: the sharing headroom is not needed.
            want.estimated_vram_mb <= registry::vram_solo_mb()
        } else {
            used + held_mb + want.estimated_vram_mb <= registry::vram_budget_mb()
        };
        if fits_bytes && live + 1 <= cap {
            return Ok(());
        }

        // Never used sorts first, then oldest.
        let victim = resident
            .iter()
            .min_by_key(|(_, _, used_at)| used_at.unwrap_or(0))
            .map(|(id, _, _)| id.clone());

        match victim {
            Some(id) => unload(st, &id).await?,
            None => {
                return Err(CoreError::InsufficientVram(format!(
                    "{} needs about {} MiB, {used} MiB is resident and evictable, and the sharing budget is {} MiB of which a single model may hold {}. {} MiB is held by {} model(s) other running chats are using, which were not evicted, and this device keeps at most {cap} model(s) resident. Wait for those chats to finish, or stop one of them.",
                    want.display_name,
                    want.estimated_vram_mb,
                    registry::vram_budget_mb(),
                    registry::vram_solo_mb(),
                    held_mb,
                    in_use.len()
                )))
            }
        }
    }
}

/// Free VRAM in MiB from the driver, or `None` if it cannot be read. Never a
/// guess: callers treat `None` as "unmeasured", not as zero.
///
/// Off the async runtime: `nvidia-smi` is a process spawn plus a driver query,
/// which can take tens of milliseconds, and `ensure_loaded` calls this on the
/// hot path to every first request to a model. Blocking a runtime thread there
/// is exactly the stall the rest of this module works to avoid.
async fn free_vram_mb() -> Option<u32> {
    tokio::task::spawn_blocking(|| {
        let out = Command::new("nvidia-smi")
            .args(["--query-gpu=memory.free", "--format=csv,noheader,nounits"])
            .stdin(std::process::Stdio::null())
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .next()?
            .trim()
            .parse()
            .ok()
    })
    .await
    .ok()
    .flatten()
}

/* ------------------------------------------------------------------ */
/* Inference                                                           */
/* ------------------------------------------------------------------ */

/// Shapes the history the way the endpoint reads it.
///
/// Pulled out of `chat` so the one property that matters here can be tested
/// without a server: an assistant turn that made calls has to go back carrying
/// them, because the alternative is describing them in prose and a model that
/// reads prose calls in its history starts writing them instead of making them.
fn wire_messages(history: &[ChatMessage]) -> Vec<Value> {
    history
        .iter()
        .map(|m| {
            let mut v = json!({ "role": m.role, "content": m.content });
            if let Some(id) = &m.tool_call_id {
                v["tool_call_id"] = json!(id);
            }
            if !m.tool_calls.is_empty() {
                // `arguments` goes back as the JSON string it arrived as: that is
                // what the chat templates render, and what a model that reads its
                // own history back expects to see.
                v["tool_calls"] = Value::Array(
                    m.tool_calls
                        .iter()
                        .map(|c| {
                            json!({
                                "id": c.id,
                                "type": "function",
                                "function": {
                                    "name": c.name,
                                    "arguments": c.arguments.to_string(),
                                },
                            })
                        })
                        .collect(),
                );
            }
            v
        })
        .collect()
}

/// A chat completion, optionally streamed.
///
/// Streaming is used only when there are no tools and a sink was given. With
/// tools the caller cannot act until the call is complete anyway, and
/// reassembling a partial `arguments` string from deltas is a way to corrupt a
/// tool call for no benefit. The turn the user actually watches — the final
/// answer — has no tools, so it streams.
///
/// Cancellation: Stop sets the run flag and the waits below abort within
/// ~100 ms. Dropping the in-flight HTTP future cancels the request, so the
/// run reaches `agent://done` instead of generating to completion while the
/// operator watches a dead Stop button.
async fn wait_for_cancel(st: &AppState, run_id: &str) {
    loop {
        tokio::time::sleep(Duration::from_millis(50)).await;
        if st.is_run_cancelled(run_id) {
            return;
        }
    }
}

pub async fn chat(
    st: &AppState,
    req: ChatRequest,
    on_delta: Option<DeltaSink<'_>>,
) -> CoreResult<ChatResult> {
    ensure_loaded(st, &req.model_id).await?;
    let (base, key, dest) = endpoint(st, &req.model_id)?;

    let messages = wire_messages(&req.messages);

    let mut body = json!({
        "model": req.model_id,
        "messages": messages,
        "max_tokens": req.max_tokens,
        "temperature": req.temperature,
        // Verified on b10718: this is what actually suppresses <think> blocks.
        // §7: reasoning stays off unless the operator asked for Extended
        // Thinking; when it is on, the stream arrives in `reasoning_content`
        // and is surfaced separately rather than concatenated into the answer.
        "chat_template_kwargs": { "enable_thinking": req.enable_thinking },
        "reasoning_format": if req.enable_thinking { "deepseek" } else { "auto" },
    });
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(req.tools.clone());
        body["tool_choice"] = json!("auto");
    }

    // llama.cpp supports a bounded reasoning phase independently of answer text.
    // Keep at least 512 completion tokens available after thinking. The selector
    // still thinks even when the worker's Extended Thinking switch is off.
    let local_llama = st.registry.read().unwrap_or_else(|e| e.into_inner())
        .get(&req.model_id).is_some_and(|m| m.backend == ModelBackend::LlamaCpp);
    if local_llama {
        let effort = req.thinking_effort.unwrap_or_else(|| st.settings().thinking_effort);
        body["reasoning_budget"] = json!(if req.enable_thinking { effort.token_budget(req.max_tokens) } else { 0 });
        if req.enable_thinking {
            body["chat_template_kwargs"]["reasoning_effort"] = json!(effort);
        }
    }

    let stream = on_delta.is_some() && req.tools.is_empty();
    if stream {
        body["stream"] = json!(true);
        body["stream_options"] = json!({ "include_usage": true });
    }

    let url = format!("{base}/v1/chat/completions");
    st.classify_url(&url)?;

    let mut rb = st.http.post(&url).json(&body);
    if let Some(k) = &key {
        rb = rb.bearer_auth(k);
    }
    let resp = rb.send().await?;
    let resp = check_status(resp).await?;

    // Captured before the wait: the task-local names the agent run whose
    // generation this is, if any. Console-side calls have none and wait as
    // before.
    let cancel_run_id: Option<String> =
        crate::state::current_run().map(|(run_id, _)| run_id);

    let out = if stream {
        read_stream(resp, on_delta.expect("sink present"), st, dest, &req.model_id).await?
    } else if let Some(run_id) = cancel_run_id {
        tokio::select! {
            res = resp.bytes() => {
                let bytes = res?;
                st.count_request(dest, bytes.len() as u64);
                parse_completion(&serde_json::from_slice(&bytes)?, &req.model_id)?
            }
            _ = wait_for_cancel(st, &run_id) => {
                return Err(CoreError::Denied("The run was cancelled.".into()));
            }
        }
    } else {
        let bytes = resp.bytes().await?;
        st.count_request(dest, bytes.len() as u64);
        parse_completion(&serde_json::from_slice(&bytes)?, &req.model_id)?
    };

    st.set_model_state(&req.model_id, |m| {
        m.last_used_at = Some(now_ms());
        if out.tokens_per_sec > 0.0 {
            m.last_tokens_per_sec = Some(out.tokens_per_sec as f64);
        }
    });
    Ok(out)
}

async fn read_stream(
    resp: reqwest::Response,
    sink: DeltaSink<'_>,
    st: &AppState,
    dest: Destination,
    model_id: &str,
) -> CoreResult<ChatResult> {
    let mut out = ChatResult { model_id: model_id.to_string(), ..Default::default() };
    let mut buf = String::new();
    let mut bytes_seen = 0u64;
    let mut body = resp.bytes_stream();
    // Same task-local as above: abort the stream promptly when Stop lands
    // mid-answer instead of draining it to the end.
    let cancel_run_id: Option<String> =
        crate::state::current_run().map(|(run_id, _)| run_id);

    loop {
        // A plain `body.next().await` parks until the next token, which is
        // exactly where Stop used to hang. A 100 ms window keeps streaming
        // smooth and still notices a cancel almost immediately.
        let next = tokio::time::timeout(Duration::from_millis(100), body.next()).await;
        let chunk = match next {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => {
                if let Some(ref run_id) = cancel_run_id {
                    if st.is_run_cancelled(run_id) {
                        return Err(CoreError::Denied("The run was cancelled.".into()));
                    }
                }
                continue;
            }
        };
        {
            let chunk = chunk?;
            if let Some(ref run_id) = cancel_run_id {
                if st.is_run_cancelled(run_id) {
                    return Err(CoreError::Denied("The run was cancelled.".into()));
                }
            }
        bytes_seen += chunk.len() as u64;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };

            if let Some(choice) = v.get("choices").and_then(Value::as_array).and_then(|a| a.first())
            {
                // Thinking is off unless asked for, and the request body said
                // so; a server that streams reasoning anyway has it routed
                // here, where it only reaches the sink if the request enabled
                // it. The reasoning is never appended to `text`.
                if let Some(d) = choice.get("delta").and_then(|d| d.get("content")).and_then(Value::as_str)
                {
                    if !d.is_empty() {
                        out.text.push_str(d);
                        sink(d, DeltaKind::Answer);
                    }
                }
                if let Some(r) = choice
                    .get("delta")
                    .and_then(|d| d.get("reasoning_content"))
                    .and_then(Value::as_str)
                {
                    if !r.is_empty() {
                        out.reasoning.push_str(r);
                        sink(r, DeltaKind::Thinking);
                    }
                }
                if let Some(fr) = choice.get("finish_reason").and_then(Value::as_str) {
                    out.finish_reason = fr.to_string();
                }
            }
            // The final frame carries `choices: []` plus usage and timings.
            if let Some(tps) = v
                .get("timings")
                .and_then(|t| t.get("predicted_per_second"))
                .and_then(Value::as_f64)
            {
                out.tokens_per_sec = tps as f32;
            }
        }
        }
    }

    st.count_request(dest, bytes_seen);
    if out.finish_reason.is_empty() {
        out.finish_reason = "stop".into();
    }
    Ok(out)
}

fn parse_completion(v: &Value, model_id: &str) -> CoreResult<ChatResult> {
    let choice = v
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| {
            CoreError::MalformedToolCall(format!(
                "The router returned no choices for {model_id}. Nothing was acted on."
            ))
        })?;

    let msg = choice.get("message").unwrap_or(&Value::Null);
    let mut tool_calls = Vec::new();

    if let Some(list) = msg.get("tool_calls").and_then(Value::as_array) {
        for tc in list {
            let id = tc.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            let f = tc.get("function").unwrap_or(&Value::Null);
            let name = f.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
            if name.is_empty() {
                return Err(CoreError::MalformedToolCall(
                    "A tool call arrived with no function name; it was not executed.".into(),
                ));
            }
            // `arguments` is a JSON string, not an object. Verified on b10718.
            let raw = f.get("arguments").and_then(Value::as_str).unwrap_or("{}");
            let arguments = serde_json::from_str::<Value>(raw).map_err(|e| {
                CoreError::MalformedToolCall(format!(
                    "The arguments for tool '{name}' were not valid JSON ({e}), so it was not executed: {raw}"
                ))
            })?;
            tool_calls.push(ToolCall { id, name, arguments });
        }
    }

    Ok(ChatResult {
        text: msg.get("content").and_then(Value::as_str).unwrap_or_default().to_string(),
        // Populated only when the request enabled thinking; servers that emit
        // it unasked still have it kept out of `text`.
        reasoning: msg
            .get("reasoning_content")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        tool_calls,
        tokens_per_sec: v
            .get("timings")
            .and_then(|t| t.get("predicted_per_second"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0) as f32,
        // What the router says it served, not what was asked for. The two are
        // normally the same; when they are not, the operator is being shown the
        // wrong model name, and §3's whole claim is that the name on screen is
        // the model that ran.
        model_id: v
            .get("model")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(model_id)
            .to_string(),
        finish_reason: choice
            .get("finish_reason")
            .and_then(Value::as_str)
            .unwrap_or("stop")
            .to_string(),
    })
}

/// Embeddings for retrieval. The catalogue's embedding model is used, whichever
/// that is — §5 does not name one in code.
pub async fn embed(st: &AppState, texts: &[String]) -> CoreResult<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let model_id = {
        let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
        reg.embedding_model()
            .map(|e| e.id.clone())
            .ok_or_else(|| CoreError::IndexFailed(
                "No embedding model is available in the catalogue, so nothing was indexed semantically. Lexical search still works.".into(),
            ))?
    };

    ensure_loaded(st, &model_id).await?;
    let (base, key, dest) = endpoint(st, &model_id)?;
    let url = format!("{base}/v1/embeddings");
    st.classify_url(&url)?;

    let mut rb = st.http.post(&url).json(&json!({ "model": model_id, "input": texts }));
    if let Some(k) = &key {
        rb = rb.bearer_auth(k);
    }
    let resp = check_status(rb.send().await?).await?;
    let bytes = resp.bytes().await?;
    st.count_request(dest, bytes.len() as u64);
    let v: Value = serde_json::from_slice(&bytes)?;

    let list = v.get("data").and_then(Value::as_array).ok_or_else(|| {
        CoreError::IndexFailed("The embedding response had no data array; nothing was indexed.".into())
    })?;

    // Ordering is by `index`, not by arrival, so a chunk never gets another
    // chunk's vector.
    let mut pairs: Vec<(usize, Vec<f32>)> = Vec::with_capacity(list.len());
    for item in list {
        let idx = item.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
        let vec: Vec<f32> = item
            .get("embedding")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_f64).map(|f| f as f32).collect())
            .unwrap_or_default();
        if vec.is_empty() {
            return Err(CoreError::IndexFailed(
                "An embedding came back empty, so the batch was rejected rather than half-indexed.".into(),
            ));
        }
        pairs.push((idx, vec));
    }
    pairs.sort_by_key(|(i, _)| *i);

    if pairs.len() != texts.len() {
        return Err(CoreError::IndexFailed(format!(
            "Asked for {} embeddings and received {}. The batch was rejected rather than misaligned.",
            texts.len(),
            pairs.len()
        )));
    }
    Ok(pairs.into_iter().map(|(_, v)| v).collect())
}

/// Vision: OCR, drawing reading, photographs. Images are sent as data URIs on
/// the loopback interface, which is the same path the earlier probe verified.
pub async fn vision(
    st: &AppState,
    model_id: &str,
    images: Vec<Vec<u8>>,
    prompt: &str,
) -> CoreResult<String> {
    if images.is_empty() {
        return Err(CoreError::OcrFailed(
            "No image data was supplied, so nothing was transcribed.".into(),
        ));
    }
    ensure_loaded(st, model_id).await?;
    let (base, key, dest) = endpoint(st, model_id)?;

    let mut content = vec![json!({ "type": "text", "text": prompt })];
    for img in &images {
        let b64 = base64_encode(img);
        content.push(json!({
            "type": "image_url",
            "image_url": { "url": format!("data:image/png;base64,{b64}") }
        }));
    }

    let url = format!("{base}/v1/chat/completions");
    st.classify_url(&url)?;
    let mut rb = st.http.post(&url).json(&json!({
        "model": model_id,
        "messages": [{ "role": "user", "content": content }],
        "max_tokens": 4096,
        "temperature": 0.0,
        "chat_template_kwargs": { "enable_thinking": false },
    }));
    if let Some(k) = &key {
        rb = rb.bearer_auth(k);
    }

    let resp = check_status(rb.send().await?).await?;
    let bytes = resp.bytes().await?;
    st.count_request(dest, bytes.len() as u64);
    let out = parse_completion(&serde_json::from_slice(&bytes)?, model_id)?;

    st.set_model_state(model_id, |m| {
        m.last_used_at = Some(now_ms());
        if out.tokens_per_sec > 0.0 {
            m.last_tokens_per_sec = Some(out.tokens_per_sec as f64);
        }
    });

    if out.text.trim().is_empty() {
        return Err(CoreError::OcrFailed(format!(
            "{model_id} returned no text for the page. No text was recorded rather than a guess."
        )));
    }
    Ok(out.text)
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

fn router_addr(st: &AppState) -> CoreResult<(u16, String)> {
    st.router
        .lock()
        .map_err(|_| lock_err("router"))?
        .as_ref()
        .map(|c| (c.port, c.api_key.clone()))
        .ok_or_else(|| {
            CoreError::ModelLoadFailed(
                "The inference router is not running, so nothing was sent to a model. Start it from the Models panel.".into(),
            )
        })
}

/// Base URL, credential and classification for a model. This is the seam that
/// keeps the core from being welded to llama.cpp: a model whose catalogue entry
/// points at an approved private server goes there instead, through the same
/// §11 classification as everything else.
///
/// A model's own `server_url` wins over the global setting, so an org that
/// splits models across servers gets the server its catalogue names — the
/// global setting is the single-server deployment, not a routing rule. The
/// credential is read here from the env var the entry names, because the
/// catalogue is a file on disk whose whole job is to be readable and a token in
/// it would be a token in clear text; an unset variable sends no credential and
/// the server's own 401 is the honest answer.
fn endpoint(st: &AppState, model_id: &str) -> CoreResult<(String, Option<String>, Destination)> {
    let entry = {
        let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
        reg.require(model_id)?.clone()
    };

    match entry.location {
        ModelLocation::ThisDevice => {
            let (port, key) = router_addr(st)?;
            Ok((format!("http://127.0.0.1:{port}"), Some(key), Destination::Loopback))
        }
        ModelLocation::PrivateServer => {
            let s = st.settings();
            let base = match &entry.server_url {
                Some(url) if !url.trim().is_empty() => {
                    // The model's own server, classified exactly as the global
                    // one would be — a per-model URL is not a way around §11.
                    url.trim().trim_end_matches('/').to_string()
                }
                _ => {
                    if !s.allow_private_server || s.private_server_url.is_empty() {
                        return Err(CoreError::PrivateServerUnreachable(format!(
                            "{model_id} is configured to run on a private server, but neither it \
                             nor Settings names which one. The request was not sent anywhere else."
                        )));
                    }
                    s.private_server_url.trim_end_matches('/').to_string()
                }
            };
            let dest = st.classify_url(&base)?;
            let key = entry.server_api_key_env.as_deref().and_then(credential_from_env);
            Ok((base, key, dest))
        }
    }
}

/// Reads one credential from the environment, trimming the newline a shell's
/// `set VAR=...` or a `.env` file leaves behind. `None` means unset or empty:
/// the request goes out unauthenticated and the server says so, which is a
/// better answer than a local guess about a key the core was never given.
fn credential_from_env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

async fn get_json(st: &AppState, url: &str, key: Option<&str>) -> CoreResult<Value> {
    st.classify_url(url)?;
    let mut rb = st.http.get(url);
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let resp = check_status(rb.send().await?).await?;
    let bytes = resp.bytes().await?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn post_json(st: &AppState, url: &str, key: Option<&str>, body: Value) -> CoreResult<Value> {
    st.classify_url(url)?;
    let mut rb = st.http.post(url).json(&body);
    if let Some(k) = key {
        rb = rb.bearer_auth(k);
    }
    let resp = check_status(rb.send().await?).await?;
    let bytes = resp.bytes().await?;
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    Ok(serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

/// Turns a non-2xx into a `CoreError` carrying the server's own message. The
/// body is read for the reason rather than reporting a bare status code, because
/// llama.cpp explains itself well and the operator should see that text.
async fn check_status(resp: reqwest::Response) -> CoreResult<reqwest::Response> {
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let body = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| {
            v.get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| body.chars().take(400).collect());

    Err(match status.as_u16() {
        401 | 403 => CoreError::Denied(format!(
            "The inference router rejected the request's credentials ({status}). {detail}"
        )),
        404 => CoreError::ModelLoadFailed(format!(
            "The router does not know that endpoint or model ({status}). {detail}"
        )),
        503 => CoreError::ModelLoadFailed(format!("The router is not ready ({status}). {detail}")),
        _ => CoreError::ExecutionFailed(format!("The inference router returned {status}. {detail}")),
    })
}

fn lock_err(what: &str) -> CoreError {
    CoreError::ExecutionFailed(format!(
        "The {what} lock was poisoned by an earlier panic. Restart the application."
    ))
}

#[cfg(test)]
mod history {
    use super::*;

    /// The regression this guards. When an assistant turn's calls were dropped
    /// and replaced with the sentence "Calling: write_file", Gemma 4 E4B read that
    /// sentence back out of its own history and produced it as the answer —
    /// announcing the write instead of performing it, twice in a row, with the
    /// operator left holding an empty file. Structural calls cannot be imitated
    /// as text, so they go back structurally.
    #[test]
    fn an_assistant_turn_carries_the_calls_it_made() {
        let calls = vec![ToolCall {
            id: "call_1".into(),
            name: "write_file".into(),
            arguments: json!({ "path": "reports/tp04-note.txt", "content": "TP-04 is thin." }),
        }];
        let wire = wire_messages(&[
            ChatMessage::system("be useful"),
            ChatMessage::user("write the note"),
            ChatMessage::assistant_calls("", calls),
            ChatMessage::tool_result("call_1", "Wrote it."),
        ]);

        let asst = &wire[2];
        assert_eq!(asst["role"], "assistant");
        let made = asst["tool_calls"].as_array().expect("the calls travel with the turn");
        assert_eq!(made.len(), 1);
        assert_eq!(made[0]["type"], "function");
        assert_eq!(made[0]["id"], "call_1");
        assert_eq!(made[0]["function"]["name"], "write_file");
        // A string, not an object: it is what the endpoint sent and what the
        // chat templates render.
        let args = made[0]["function"]["arguments"].as_str().expect("arguments is a JSON string");
        assert!(args.contains("tp04-note.txt"), "{args}");

        // Nothing anywhere in the history describes the call in prose.
        let all = serde_json::to_string(&wire).unwrap();
        assert!(!all.contains("Calling:"), "{all}");

        // And the ordinary messages keep their shape.
        assert_eq!(wire[0]["role"], "system");
        assert!(wire[0].get("tool_calls").is_none());
        assert_eq!(wire[3]["tool_call_id"], "call_1");
        assert!(wire[1].get("tool_call_id").is_none());
    }
}

#[cfg(test)]
mod reasoning_split {
    use super::*;

    /// The deepseek-shaped split: answer text in `content`, reasoning in its
    /// own field. The two must never be concatenated — an answer that opens
    /// with the model's private deliberation is a leak, not a summary.
    #[test]
    fn reasoning_lands_in_its_own_field() {
        let v = json!({
            "model": "gemma-4-e4b",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "TP-04 measures 8.2 mm.",
                    "reasoning_content": "the report page 3 says 8.2, not 82"
                },
                "finish_reason": "stop"
            }]
        });
        let out = parse_completion(&v, "gemma-4-e4b").expect("parses");
        assert_eq!(out.text, "TP-04 measures 8.2 mm.");
        assert_eq!(out.reasoning, "the report page 3 says 8.2, not 82");
        assert!(!out.text.contains("report page"), "reasoning never enters the answer");
    }

    /// With thinking off, servers that omit the field (or send it empty) yield
    /// an empty reasoning string, never an error and never content.
    #[test]
    fn no_reasoning_field_is_an_empty_string_not_an_error() {
        let v = json!({
            "model": "gemma-4-e4b",
            "choices": [{
                "message": { "role": "assistant", "content": "11.9 mm." },
                "finish_reason": "stop"
            }],
        });
        let out = parse_completion(&v, "gemma-4-e4b").expect("parses");
        assert_eq!(out.reasoning, "");
        assert_eq!(out.text, "11.9 mm.");
    }
}

#[cfg(test)]
mod idle_eviction {
    use super::*;

    fn model(id: &str, state: ModelState, last_used_at: Option<i64>) -> ModelRuntime {
        ModelRuntime { state, last_used_at, ..ModelRuntime::unloaded(id) }
    }

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    #[test]
    fn a_model_idle_past_the_cutoff_is_released() {
        let models = [model("gemma-4-e4b", ModelState::Loaded, Some(500))];
        assert_eq!(idle_victims(&models, &none(), 1_000), vec!["gemma-4-e4b".to_string()]);
    }

    #[test]
    fn a_model_used_since_the_cutoff_is_kept() {
        let models = [model("gemma-4-e4b", ModelState::Loaded, Some(1_500))];
        assert!(idle_victims(&models, &none(), 1_000).is_empty());
    }

    /// The rule that matters. A chat generating from a model has noted it, and
    /// unloading it mid-answer would fail that chat — idle time is irrelevant
    /// while a run holds it, because the last request only gets its timestamp
    /// touched when it starts.
    #[test]
    fn a_model_a_live_run_is_using_is_never_released() {
        let models = [model("gemma-4-e4b", ModelState::Loaded, Some(0))];
        let in_use: HashSet<String> = ["gemma-4-e4b".to_string()].into_iter().collect();
        assert!(idle_victims(&models, &in_use, 1_000).is_empty());
    }

    /// A load or an unload already in flight is left to finish. Evicting a
    /// `Loading` model would throw away the admission `make_room` just made
    /// room for.
    #[test]
    fn only_a_settled_load_is_a_candidate() {
        for state in [ModelState::Loading, ModelState::Unloading, ModelState::Unloaded, ModelState::Error] {
            let models = [model("gemma-4-e4b", state, Some(0))];
            assert!(idle_victims(&models, &none(), 1_000).is_empty(), "{state:?} was evicted");
        }
    }

    /// Nothing has used it since the app started, so there is no idle interval
    /// to compare — an unused entry is not the same as a stale one.
    #[test]
    fn a_model_with_no_recorded_use_is_left_alone() {
        let models = [model("bge-m3", ModelState::Loaded, None)];
        assert!(idle_victims(&models, &none(), 1_000).is_empty());
    }

    #[test]
    fn every_idle_model_goes_in_one_sweep_and_the_busy_one_stays() {
        let models = [
            model("bge-m3", ModelState::Loaded, Some(10)),
            model("gemma-4-e4b", ModelState::Loaded, Some(20)),
            model("olmocr-2", ModelState::Loaded, Some(30)),
        ];
        let in_use: HashSet<String> = ["gemma-4-e4b".to_string()].into_iter().collect();
        let mut got = idle_victims(&models, &in_use, 1_000);
        got.sort();
        assert_eq!(got, vec!["bge-m3".to_string(), "olmocr-2".to_string()]);
    }
}

#[cfg(test)]
mod preset_ini {
    use super::*;

    /// One model whose weights the catalogue stores under the portable
    /// `${MODELS_ROOT}` token, the way `Registry::persist` writes it. Moving the
    /// models-directory setting is what re-resolves that token against a new
    /// folder, so this is the shape a moved-folder rewrite has to handle.
    fn catalogue() -> crate::registry::ModelCatalogue {
        crate::registry::ModelCatalogue {
            version: 1,
            models: vec![ModelEntry {
                id: "moved-chat".into(),
                display_name: "Moved Chat".into(),
                backend: ModelBackend::LlamaCpp,
                location: ModelLocation::ThisDevice,
                source: "${MODELS_ROOT}/moved-chat.gguf".into(),
                projector: None,
                architecture: "llama".into(),
                quantization: "Q4_K_M".into(),
                context_size: 32_768,
                context_mode: ContextMode::Auto,
                context_limit: None,
                trained_context: 32_768,
                kv_cache_type: None,
                capabilities: vec![ModelCapability::General],
                estimated_vram_mb: 4_096,
                file_size_bytes: 1,
                priority: ModelPriority::Primary,
                prompt_tokens_per_sec: None,
                gen_tokens_per_sec: None,
                note: None,
                preset_options: None,
                server_url: None,
                server_api_key_env: None,
            }],
            routing: Vec::new(),
        }
    }

    /// The catalogue reloaded the way `settings_set` does after a models-directory
    /// change: `load_or_seed` expands `${MODELS_ROOT}` against `root`, handing the
    /// renderer entries already pointed at that folder.
    fn entries_at(config_dir: &Path, root: &str) -> Vec<ModelEntry> {
        crate::registry::Registry::load_or_seed(config_dir, root)
            .expect("the written catalogue should load")
            .all()
            .to_vec()
    }

    fn slash(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }

    #[test]
    fn a_moved_models_folder_is_rerendered_under_the_new_root() {
        let base = std::env::temp_dir().join(format!(
            "zeroleak-moved-models-{}",
            uuid::Uuid::new_v4()
        ));
        let cfg = base.join("config");
        let old_root = base.join("models-old");
        let new_root = base.join("models-new");
        std::fs::create_dir_all(&cfg).expect("config dir");
        std::fs::create_dir_all(&old_root).expect("old models dir");
        std::fs::create_dir_all(&new_root).expect("new models dir");
        std::fs::write(cfg.join("models.json"), serde_json::to_string(&catalogue()).expect("serialise"))
            .expect("write catalogue");

        let old_dir = slash(&old_root);
        let new_dir = slash(&new_root);

        // Phase 1 — weights live in the old folder, as the preset written at the
        // last router start records.
        std::fs::write(old_root.join("moved-chat.gguf"), b"test weights").expect("old weights");
        let (pre_move, pre_skipped) = render_preset_ini(&entries_at(&cfg, &old_dir));
        assert!(pre_skipped.is_empty(), "weights are present: {pre_skipped:?}");
        assert!(
            pre_move.contains(&format!("model = {old_dir}/moved-chat.gguf")),
            "preset before the move: {pre_move}"
        );

        // Phase 2 — the operator moves the weights and repoints the setting. The
        // catalogue reloads against the new folder, so the render must follow:
        // leaving `models.ini` as it was would keep a `model =` line pointing at
        // a file that no longer exists.
        std::fs::write(new_root.join("moved-chat.gguf"), b"test weights").expect("new weights");
        std::fs::remove_file(old_root.join("moved-chat.gguf")).expect("old weights removed");

        let (post_move, post_skipped) = render_preset_ini(&entries_at(&cfg, &new_dir));
        assert!(post_skipped.is_empty(), "weights are present: {post_skipped:?}");
        assert!(
            post_move.contains(&format!("model = {new_dir}/moved-chat.gguf")),
            "preset after the move: {post_move}"
        );
        assert!(!post_move.contains(&old_dir), "still references the old folder: {post_move}");
        assert_ne!(
            pre_move, post_move,
            "a rewrite that does not change the preset is a no-op"
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_preset_never_points_at_weights_that_moved_away() {
        let base = std::env::temp_dir().join(format!(
            "zeroleak-gone-weights-{}",
            uuid::Uuid::new_v4()
        ));
        let cfg = base.join("config");
        let empty = base.join("models");
        std::fs::create_dir_all(&cfg).expect("config dir");
        std::fs::create_dir_all(&empty).expect("models dir");
        std::fs::write(cfg.join("models.json"), serde_json::to_string(&catalogue()).expect("serialise"))
            .expect("write catalogue");

        // The weights are never under this root, so the entry must be reported
        // missing rather than rendered as a dead `model =` line.
        let (text, skipped) = render_preset_ini(&entries_at(&cfg, &slash(&empty)));
        assert!(!text.contains("[moved-chat]"), "a missing model must not be written: {text}");
        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].0, "moved-chat");
        assert!(skipped[0].1.contains("were not found"), "reason: {}", skipped[0].1);

        let _ = std::fs::remove_dir_all(&base);
    }
}


#[cfg(test)]
mod context_props_tests {
    use super::*;
    #[test]
    fn uses_the_runtime_reported_per_sequence_context() {
        assert_eq!(context_from_props(&json!({"default_generation_settings":{"n_ctx": 65536}})), Some(65536));
        assert_eq!(context_from_props(&json!({"default_generation_settings":{"n_ctx": 0}})), None);
        assert_eq!(context_from_props(&json!({"default_generation_settings":{"n_ctx": 1.5}})), None);
        assert_eq!(context_from_props(&json!({"n_ctx": 65536})), None);
    }
    #[test]
    fn auto_and_custom_presets_choose_different_memory_policies() {
        let dir = std::env::temp_dir().join(format!("zeroleak-fit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let weights = dir.join("model.gguf");
        std::fs::write(&weights, b"test weights").unwrap();
        let mut model = registry::Registry::load_or_seed(&dir, dir.to_str().unwrap()).unwrap().all()[0].clone();
        model.source = weights.to_string_lossy().into_owned();
        model.projector = None;
        model.capabilities = vec![ModelCapability::General];
        model.context_mode = ContextMode::Auto;
        model.context_size = 8192;
        let (auto, _) = render_preset_ini(&[model.clone()]);
        assert!(auto.contains("ctx-size = 0\n") && auto.contains("fit = on\n") && auto.contains("parallel = 1\n") && auto.contains("n-gpu-layers = auto\n"));
        model.context_mode = ContextMode::Manual;
        model.context_limit = Some(131072);
        let (manual, _) = render_preset_ini(&[model]);
        assert!(manual.contains("ctx-size = 131072\n") && manual.contains("n-gpu-layers = auto\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
