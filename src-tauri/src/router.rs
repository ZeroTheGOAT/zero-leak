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
//! Qwen3.5-9B Q4_K_M, 4709-token prompt, cold server, this machine (RTX 4060
//! Laptop 8188 MiB, i7-14700HX 20C/28T):
//!
//! | flags                                   | pp tok/s | tg tok/s | VRAM     |
//! |-----------------------------------------|----------|----------|----------|
//! | `-ngl 999` only                         | 1918.9   | 41.1     | 6947 MiB |
//! | `+ -t 8 -tb 20 -b 4096 -ub 1024`        | 1881.8   | 41.3     | 7023 MiB |
//!
//! The second row is the configuration that reads like "maximum performance".
//! It is 2% *slower* on prompt processing and costs 76 MiB more VRAM. The reason
//! is that `-ngl 999` puts every layer on the GPU, so CPU thread counts stop
//! mattering, and a 4060's SMs are already saturated at the default 512-token
//! physical batch — a larger `-ub` only enlarges the compute buffer. So those
//! flags are not set. On this hardware the machine is already at 100% of its
//! throughput with full offload, and the scarce resource is VRAM, not FLOPs.
//!
//! What that leaves as the real levers, in order of effect:
//!   1. `n-gpu-layers = 999` — full offload. Everything else is noise beside it.
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

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::error::{CoreError, CoreResult};
use crate::registry::{self, VRAM_BUDGET_MB};
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
                        "Router on 127.0.0.1:{} — {loaded} model(s) resident of a {VRAM_BUDGET_MB} MiB budget.",
                        c.port
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

    let port = if s.router_port != 0 { s.router_port } else { free_port()? };
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
        .arg("--host").arg("127.0.0.1")
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
                        let cut = g.len() - 32 * 1024;
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

/// Polls residency so LRU evictions the router performs on its own show up in
/// the UI. Ends when the router it was started for is gone, so a restart does
/// not leave two pollers running.
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
fn write_preset_ini(st: &AppState) -> CoreResult<(PathBuf, Vec<(String, String)>)> {
    let dir = registry::config_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("models.ini");

    let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
    let mut out = String::from(
        "; Generated by Sovereign AI Workbench from the model catalogue.\n\
         ; Edit models.json instead — this file is rewritten on every start.\n\n",
    );
    let mut skipped = Vec::new();

    for e in reg.all() {
        if e.priority == ModelPriority::Disabled {
            continue;
        }
        // A model served by an approved private server has no local child.
        if e.location != ModelLocation::ThisDevice {
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
        keys.insert("ctx-size", e.context_size.to_string());
        // The single flag that matters on this hardware. 999 is "every layer";
        // the server clamps to the model's actual depth.
        keys.insert("n-gpu-layers", "999".to_string());
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
    drop(reg);

    std::fs::write(&path, out)?;
    Ok((path, skipped))
}

fn free_port() -> CoreResult<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not reserve a loopback port for the router: {e}"))
    })?;
    let port = l.local_addr().map(|a| a.port()).map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not read the reserved port: {e}"))
    })?;
    Ok(port)
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
fn check_weights(entry: &ModelEntry) -> CoreResult<()> {
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
    let before = free_vram_mb();
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
            Some(ModelState::Unloaded) if !joining && started.elapsed() > Duration::from_secs(3) => {
                // The child exited instead of becoming resident.
                let msg = format!(
                    "{} did not become resident; the router reported it as unloaded. Nothing else was evicted to make room a second time.",
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
    let resident = match (before, free_vram_mb()) {
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
    if want.estimated_vram_mb > VRAM_BUDGET_MB {
        return Err(CoreError::InsufficientVram(format!(
            "{} needs about {} MiB and the working budget on this device is {VRAM_BUDGET_MB} MiB of {} MiB total. Nothing was evicted and nothing was loaded.",
            want.display_name,
            want.estimated_vram_mb,
            registry::VRAM_TOTAL_MB
        )));
    }

    loop {
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
                .filter_map(|id| reg.get(id).map(|e| e.estimated_vram_mb))
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
                        .map(|e| (r.id.clone(), e.estimated_vram_mb, r.last_used_at))
                })
                .collect()
        };

        let used: u32 = resident.iter().map(|(_, mb, _)| *mb).sum();
        if used + want.estimated_vram_mb <= VRAM_BUDGET_MB {
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
                    "{} needs about {} MiB, {used} MiB is resident and evictable, and the budget is {VRAM_BUDGET_MB} MiB. {} MiB more is held by models other running chats are using, which were not evicted. Wait for those chats to finish, or stop one of them.",
                    want.display_name,
                    want.estimated_vram_mb,
                    held_mb
                )))
            }
        }
    }
}

/// Free VRAM in MiB from the driver, or `None` if it cannot be read. Never a
/// guess: callers treat `None` as "unmeasured", not as zero.
fn free_vram_mb() -> Option<u32> {
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

    let out = if stream {
        read_stream(resp, on_delta.expect("sink present"), st, dest, &req.model_id).await?
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

    while let Some(chunk) = body.next().await {
        let chunk = chunk?;
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
fn endpoint(st: &AppState, model_id: &str) -> CoreResult<(String, Option<String>, Destination)> {
    let location = {
        let reg = st.registry.read().map_err(|_| lock_err("registry"))?;
        reg.require(model_id)?.location
    };

    match location {
        ModelLocation::ThisDevice => {
            let (port, key) = router_addr(st)?;
            Ok((format!("http://127.0.0.1:{port}"), Some(key), Destination::Loopback))
        }
        ModelLocation::PrivateServer => {
            let s = st.settings();
            if !s.allow_private_server || s.private_server_url.is_empty() {
                return Err(CoreError::PrivateServerUnreachable(format!(
                    "{model_id} is configured to run on a private server, but no approved server is set in Settings. The request was not sent anywhere else."
                )));
            }
            let base = s.private_server_url.trim_end_matches('/').to_string();
            let dest = st.classify_url(&base)?;
            Ok((base, None, dest))
        }
    }
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
    /// and replaced with the sentence "Calling: write_file", Qwen3.5 read that
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
            "model": "qwen3.5-9b",
            "choices": [{
                "message": {
                    "role": "assistant",
                    "content": "TP-04 measures 8.2 mm.",
                    "reasoning_content": "the report page 3 says 8.2, not 82"
                },
                "finish_reason": "stop"
            }]
        });
        let out = parse_completion(&v, "qwen3.5-9b").expect("parses");
        assert_eq!(out.text, "TP-04 measures 8.2 mm.");
        assert_eq!(out.reasoning, "the report page 3 says 8.2, not 82");
        assert!(!out.text.contains("report page"), "reasoning never enters the answer");
    }

    /// With thinking off, servers that omit the field (or send it empty) yield
    /// an empty reasoning string, never an error and never content.
    #[test]
    fn no_reasoning_field_is_an_empty_string_not_an_error() {
        let v = json!({
            "model": "qwen3.5-9b",
            "choices": [{
                "message": { "role": "assistant", "content": "11.9 mm." },
                "finish_reason": "stop"
            }],
        });
        let out = parse_completion(&v, "qwen3.5-9b").expect("parses");
        assert_eq!(out.reasoning, "");
        assert_eq!(out.text, "11.9 mm.");
    }
}
