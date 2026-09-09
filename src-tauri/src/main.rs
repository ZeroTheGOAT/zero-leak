#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! ZeroLeak AI — process entry point and transports.
//!
//! This file is deliberately thin. It opens the store, builds the shared state,
//! starts the router, and attaches transports. It contains no policy and no
//! subsystem logic.
//!
//! ## Two transports, one core
//!
//! The same application is reachable two ways:
//!
//!   * **Tauri IPC** from the desktop window.
//!   * **HTTP on 127.0.0.1** from a browser tab.
//!
//! Both funnel into `api::dispatch`, so the command surface is identical by
//! construction rather than by discipline. There is one `#[tauri::command]` in
//! this file — `invoke_core` — and its whole body is a call to that dispatcher.
//! Events go the same way: `AppState::emit` serialises a payload once and sends
//! those exact bytes to both the webview and the SSE broadcast channel.
//!
//! The browser tab is not a lesser version. Every heavy operation in this
//! application already runs in a native process — `llama-server.exe` on CUDA,
//! the sandbox children under job objects, the OCR and document pipelines on the
//! Rust side — and the UI only renders text and reads events. A tab therefore
//! reaches 100% of this machine exactly as the window does. At 8188 MiB of VRAM
//! the tab is arguably the better option for long jobs: `--no-window` runs with
//! no WebView2 surface at all, which hands its compositing VRAM back to the
//! model.
//!
//! ## Modes
//!
//! | invocation                  | window | browser access                |
//! |-----------------------------|--------|-------------------------------|
//! | (none)                      | yes    | yes, link on request          |
//! | `--open`                    | yes    | yes, browser opened at start  |
//! | `--no-window`               | no     | yes, browser opened at start  |
//! | `--no-web`                  | yes    | no listener at all            |
//!
//! `--port <n>` pins the port; the default is an ephemeral one the OS picks.
//!
//! ## Note on the ACL
//!
//! Application-defined commands are not gated by Tauri's capability system —
//! `capabilities/default.json` governs the built-in `core:` commands only. The
//! enforcement for everything reachable through `invoke_core` lives in
//! `state.rs` (`classify_url`, `with_db`, `needs_approval`), `fsops.rs` (path
//! containment) and `sandbox.rs` (job objects). None of it is transport-specific,
//! which is why adding the HTTP transport did not move a security boundary. What
//! the HTTP transport does add is a listening socket; `web.rs` documents what
//! guards it and, just as importantly, what those guards do not cover.

mod agent;
mod api;
mod artifacts;
mod attachments;
mod audit;
mod db;
mod devserver;
mod documents;
mod evidence;
mod error;
mod fsops;
mod gguf;
mod guards;
mod harness;
mod hardware;
mod knowledge;
mod log;
mod mcp;
mod multi_agent;
mod preview;
mod registry;
mod router;
mod sandbox;
mod selfcheck;
mod sovereign;
mod state;
mod transcription;
mod types;
mod vault;
mod web;
mod web_search;
mod winproc;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use tauri::{Manager, RunEvent, State};

use error::CoreResult;
use state::AppState;
use types::*;

type St<'a> = State<'a, Arc<AppState>>;

/* ------------------------------------------------------------------ */
/* The IPC surface — one command                                       */
/* ------------------------------------------------------------------ */

/// The desktop window's door into the core.
///
/// Deliberately the only command. Forty-odd typed commands would have to be kept
/// in step with forty-odd HTTP routes, and the first one anybody forgot would be
/// a behaviour difference between the window and the tab. One command that
/// forwards to a shared dispatch table cannot drift.
#[tauri::command]
async fn invoke_core(
    st: St<'_>,
    command: String,
    args: Option<serde_json::Value>,
) -> CoreResult<serde_json::Value> {
    let args = args.unwrap_or_else(|| serde_json::json!({}));
    api::dispatch(&st, &command, &args).await
}

/* ------------------------------------------------------------------ */
/* Command line                                                        */
/* ------------------------------------------------------------------ */

#[derive(Clone, Copy)]
struct Mode {
    window: bool,
    web: bool,
    open_browser: bool,
    port: u16,
}

fn parse_args() -> Mode {
    let mut mode = Mode { window: true, web: true, open_browser: false, port: 0 };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--no-window" | "--headless" => {
                mode.window = false;
                // Without a window and without a browser there is no UI at all,
                // so this combination implies both.
                mode.web = true;
                mode.open_browser = true;
            }
            "--no-web" => mode.web = false,
            "--open" => mode.open_browser = true,
            "--no-open-browser" => mode.open_browser = false,
            "--port" => {
                if let Some(p) = args.next().and_then(|v| v.parse().ok()) {
                    mode.port = p;
                }
            }
            _ => {}
        }
    }
    if !mode.web {
        // A listener that was turned off cannot be opened.
        mode.open_browser = false;
        mode.window = true;
    }
    mode
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

fn main() {
    let mode = parse_args();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![invoke_core])
        .setup(move |app| {
            let handle = app.handle().clone();

            // The store has to open before anything else; without it there are
            // no workspaces, no settings and no audit log, and a UI that cannot
            // record what it did should not start.
            harness::ensure_layout()?;
            let conn = db::open(&db::state_dir())?;
            let st = Arc::new(AppState::new(handle.clone(), conn)?);
            multi_agent::start_supervisor(st.clone());
            // Generated Markdown mirrors are inspectable even before the memory
            // panel is opened. A mirror failure must not invalidate the canonical
            // SQLite store, so it is reported and startup continues.
            if let Err(e) = harness::sync_memory_files(&st) {
                logln!("Could not refresh memory mirrors: {e}");
                st.emit_failure(&e);
            }
            app.manage(st.clone());

            // Browser access first, so the link exists before anything slow
            // happens. A failure here is reported and not fatal: the desktop
            // window does not depend on it.
            if mode.web {
                match web::serve(st.clone(), mode.port) {
                    Ok(url) => {
                        let file = web::write_session_file(&url);
                        // Only visible in a debug build; release is a windows
                        // subsystem binary with no console, which is exactly why
                        // the file above exists.
                        println!("Browser access: {url}");
                        if let Some(p) = &file {
                            println!("Saved to: {}", p.display());
                        }
                        if mode.open_browser {
                            use tauri_plugin_opener::OpenerExt;
                            if let Err(e) = handle.opener().open_url(url, None::<&str>) {
                                logln!("Could not open the browser automatically: {e}");
                            }
                        }
                    }
                    Err(e) => {
                        logln!("Browser access unavailable: {}", e.message());
                        st.emit_failure(&e);
                    }
                }
            }

            // Headless: drop the WebView2 surface so its compositing VRAM goes
            // back to the model. The core keeps running; `RunEvent` below is
            // what stops Tauri from exiting once the window count hits zero.
            if !mode.window {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.destroy();
                }
            }

            // Telemetry polls on its own thread so the window paints
            // immediately. §2 — the status bar is live from the first frame.
            hardware::spawn_poller(st.clone());

            // Bring the router up in the background. A failure here is reported
            // through `core://status`, not by refusing to start: the file
            // explorer, the audit log and settings all work without it.
            let boot = st.clone();
            tauri::async_runtime::spawn(async move {
                let status = router::start(&boot).await.unwrap_or_else(|e| {
                    boot.emit_failure(&e);
                    CoreStatus {
                        state: "core_only".into(),
                        ipc: true,
                        router: false,
                        router_version: None,
                        detail: e.message(),
                    }
                });
                boot.emit("core://status", status);

                // Preview servers the previous launch left bound: the chats
                // that named their URLs are immutable, so the promise "stays
                // live" is honoured by re-binding each persisted folder, on
                // its stored port where possible. After the router so a model
                // is not blocked behind it; failures are per-folder.
                preview::restore_all(&boot).await;
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("ZeroLeak AI failed to start");

    // Teardown lives on `RunEvent::Exit` rather than on a window event, because
    // in headless mode there is no window whose destruction could carry it. The
    // child processes are held in job objects and would die with this one
    // regardless; this is the orderly path.
    app.run(move |handle, event| match event {
        // "The last window closed" is not necessarily a shutdown request here,
        // because a window is not the only interface. Exit is prevented while
        // one is still attached:
        //
        //   * Launched headless there is never a window, so zero windows is the
        //     steady state rather than an event.
        //   * Launched with a window, closing it quits — unless a browser tab is
        //     attached, in which case that tab is the interface now and ending
        //     the process would discard whatever it has running.
        //
        // `receiver_count()` is every open SSE stream, so it answers "is a tab
        // watching" directly rather than by inference. A tab that died without
        // closing its socket is dropped on the next keep-alive write, so this
        // cannot hold the process open indefinitely on a stale connection — and
        // `app_quit` sets `QUITTING`, which wins either way.
        RunEvent::ExitRequested { api, .. } if !api::QUITTING.load(Ordering::Relaxed) => {
            let attached = handle
                .try_state::<Arc<AppState>>()
                .map(|st| st.events.receiver_count())
                .unwrap_or(0);
            if !mode.window || attached > 0 {
                println!(
                    "Window closed; {attached} browser session(s) still attached, so the core keeps running."
                );
                api.prevent_exit();
            }
        }
        RunEvent::Exit => {
            if let Some(st) = handle.try_state::<Arc<AppState>>() {
                router::shutdown_blocking(st.inner());
                sandbox::kill_all(st.inner());
                // Dev servers live longer than the runs that started them, but
                // not longer than the app. Closing the job handles would kill
                // them anyway; this also emits the state change to any tab
                // still attached.
                devserver::stop_all(st.inner());
            }
        }
        _ => {}
    });
}
