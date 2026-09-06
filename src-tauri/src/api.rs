//! The command surface, as data.
//!
//! There are two ways into this application: Tauri IPC from the desktop window,
//! and HTTP from a browser tab. Both land here. `dispatch` is the *only* place
//! that maps a command name to a subsystem call, which is what makes "the web
//! app and the desktop app behave identically" a structural property rather than
//! a promise that has to be maintained by hand. Adding a command to one
//! transport and forgetting the other is not possible: there is one table.
//!
//! Nothing here validates or decides anything. Argument shapes are checked (a
//! missing or wrong-typed field is a clear error, not a panic), and everything
//! else is the owning module's job — path containment in `fsops`, the approval
//! policy in `state`, the sandbox limits in `sandbox`, network classification in
//! `state::classify_url`. The security properties do not live in the transport,
//! so exposing a second transport does not weaken them. What a second transport
//! *does* change is who can reach this function, and that is `web.rs`'s problem.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use tauri::Manager;

use crate::error::{CoreError, CoreResult};
use crate::state::AppState;
use crate::types::*;
use crate::{
    agent, artifacts, audit, db, devserver, documents, fsops, hardware, knowledge, registry,
    router, sandbox, sovereign, transcription,
};
use tauri_plugin_opener::OpenerExt;

/// Set by `app_quit` before the process is asked to exit.
///
/// In headless mode `main` prevents the "last window closed" exit — with no
/// window that is the steady state, not a shutdown request. This flag is how a
/// deliberate quit is told apart from that, so the one path out of a headless
/// session cannot be trapped by the guard that keeps it alive.
pub static QUITTING: AtomicBool = AtomicBool::new(false);

/// Every command the frontend may call. Keeping this list in one place means the
/// answer to "what can the UI ask the core to do" is a screen of code, whichever
/// transport is asking.
pub const COMMANDS: &[&str] = &[
    "core_status", "sovereign_status", "sync_exposure", "hardware_status", "web_info",
    "readiness_check", "receipt_list", "receipt_export", "network_events", "network_guard_check",
    "model_list", "model_catalogue_list", "model_catalogue_add", "model_routing_list", "model_routing_set", "model_load", "model_evict", "router_start", "router_stop",
    "mcp_probe", "web_search_test",
    "transcription_status", "transcription_run",
    "workspace_list", "workspace_add", "workspace_source_pick", "workspace_create", "workspace_update", "workspace_approve", "workspace_remove",
    "fs_list", "fs_read", "fs_preview", "fs_write", "fs_reveal",
    "fs_open_default", "fs_open_with_list", "fs_open_with", "fs_save_copy_as",
    "devserver_start", "devserver_stop", "devserver_status", "devserver_open",
    "document_ingest", "document_get", "document_page_image", "document_list", "document_pick", "document_remove",
    "knowledge_stats", "knowledge_list", "knowledge_index", "knowledge_reindex",
    "knowledge_remove", "knowledge_watch",
    "artifact_list", "artifact_verify", "artifact_open",
    "harness_info", "memory_list", "memory_add", "memory_update", "memory_remove",
    "instructions_get", "instructions_set",
    "sandbox_policy", "sandbox_run", "sandbox_kill", "sandbox_history",
    "audit_list", "store_gate_list",
    "vault_status", "vault_event_list", "vault_enable", "vault_disable",
    "turn_start", "agent_start", "agent_cancel", "permission_respond", "question_answer", "change_apply", "change_discard", "change_apply_all", "change_discard_all",
    "session_list", "session_history", "session_truncate", "session_delete", "session_memory", "session_workspace", "attachment_stage",
    "settings_get", "settings_set",
    "window_minimize", "window_toggle_maximize", "window_close", "app_quit",
];

/* ------------------------------------------------------------------ */
/* Argument helpers                                                    */
/* ------------------------------------------------------------------ */

/// Reads a required argument. Keys are camelCase, matching what the frontend
/// sends and what Tauri's own IPC accepted, so `services/core.ts` did not have
/// to change its call sites when the second transport arrived.
fn arg<T: DeserializeOwned>(args: &Value, key: &str) -> CoreResult<T> {
    let v = args.get(key).ok_or_else(|| {
        CoreError::ExecutionFailed(format!(
            "The request left out the required argument '{key}', so nothing was done."
        ))
    })?;
    serde_json::from_value(v.clone()).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The argument '{key}' was not the expected type ({e}), so nothing was done."
        ))
    })
}

/// Reads an optional argument. A present-but-wrong-typed value is an error
/// rather than a silent `None`; quietly ignoring a malformed argument is how a
/// caller ends up believing a limit was applied when it was not.
fn opt<T: DeserializeOwned>(args: &Value, key: &str) -> CoreResult<Option<T>> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => serde_json::from_value(v.clone()).map(Some).map_err(|e| {
            CoreError::ExecutionFailed(format!(
                "The optional argument '{key}' was present but not the expected type ({e}), so nothing was done."
            ))
        }),
    }
}

fn ok<T: Serialize>(v: T) -> CoreResult<Value> {
    Ok(serde_json::to_value(v)?)
}

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

pub async fn dispatch(st: &Arc<AppState>, command: &str, args: &Value) -> CoreResult<Value> {
    match command {
        /* ---- status ---- */
        "core_status" => ok(router::status(st).await),
        "readiness_check" => ok(crate::evidence::readiness(st).await?),
        "receipt_list" => ok(crate::evidence::list(st, &arg::<String>(args,"sessionId")?)?),
        "receipt_export" => ok(crate::evidence::export(st, &arg::<String>(args,"sessionId")?, &arg::<String>(args,"runId")?)?),
        "network_events" => ok(crate::evidence::network(st)?),
        "network_guard_check" => {
            // TEST-NET is never contacted. Only evaluate the same guard used by inference.
            let denied = st.classify_url("https://203.0.113.1/sovereignty-check").is_err();
            ok(serde_json::json!({"denied":denied,"detail":"Evaluated a public TEST-NET destination against the HTTP guard. No connection was attempted."}))
        }
        "sovereign_status" => ok(st.sovereign_status()?),
        // §11 — the replication check. Reads the sync-root registry and the
        // files' own attributes, never the folder name, so a directory merely
        // called OneDrive is reported as the local directory it is.
        "sync_exposure" => ok(sovereign::exposure_report(st).await?),
        "hardware_status" => ok(hardware::status(st).await?),
        "web_info" => ok(web_info(st)),

        /* ---- §1 / §2 models and router ---- */
        "model_list" => ok(router::list_models(st).await?),
        "model_catalogue_list" => {
            let models = st.registry.read().unwrap_or_else(|e| e.into_inner()).all().to_vec();
            ok(models)
        }
        "model_catalogue_add" => {
            let model = arg::<ModelEntry>(args, "model")?;
            let models_root = st.settings().models_directory;
            // The location decides the arm: a local entry goes through the
            // filesystem-path rules, a server entry through the URL and
            // env-var rules. Each refuses what it cannot validate.
            let models = match model.location {
                ModelLocation::ThisDevice => st
                    .registry
                    .write().unwrap_or_else(|e| e.into_inner())
                    .upsert_local_model(model, &models_root)?,
                ModelLocation::PrivateServer => st
                    .registry
                    .write().unwrap_or_else(|e| e.into_inner())
                    .upsert_server_model(model, &models_root)?,
            };
            ok(models)
        }
        "model_routing_list" => {
            let rules = st.registry.read().unwrap_or_else(|e| e.into_inner()).routes().to_vec();
            ok(rules)
        }
        "model_routing_set" => {
            let models_root = st.settings().models_directory;
            let rules = st
                .registry
                .write().unwrap_or_else(|e| e.into_inner())
                .set_route(
                    arg::<registry::TaskKind>(args, "kind")?,
                    arg::<String>(args, "modelId")?,
                    opt::<String>(args, "fallbackModelId")?,
                    &models_root,
                )?;
            ok(rules)
        }
        "model_load" => ok(router::load_model(st, &arg::<String>(args, "id")?).await?),
        "model_evict" => ok(router::evict_model(st, &arg::<String>(args, "id")?).await?),
        "router_start" => ok(router::start(st).await?),
        "router_stop" => ok(router::stop(st).await?),
        "mcp_probe" => ok(crate::mcp::list_tools(
            &st.settings(),
            &arg::<String>(args, "serverId")?,
        )
        .await?),
        "web_search_test" => ok(crate::web_search::search(
            st,
            &arg::<String>(args, "query")?,
            3,
        )
        .await?),

        /* ---- local voice transcription ---- */
        "transcription_status" => ok(transcription::status(
            st,
            &arg::<String>(args, "modelId")?,
        )?),
        "transcription_run" => ok(transcription::transcribe(
            st,
            arg::<String>(args, "wavBase64")?,
            arg::<String>(args, "modelId")?,
            opt::<String>(args, "language")?.unwrap_or_else(|| "Auto detect".into()),
            opt::<String>(args, "vocabulary")?.unwrap_or_default(),
        )
        .await?),

        /* ---- workspaces and files ---- */
        "workspace_list" => ok(fsops::list_workspaces(st)?),
        // Each of these changes the set of folders §11 reports on, so the
        // replication check is re-run in the background after it lands.
        "workspace_add" => {
            let ws = fsops::add_workspace(st.clone()).await?;
            if ws.is_some() {
                sovereign::refresh(st);
            }
            ok(ws)
        }
        "workspace_source_pick" => ok(fsops::pick_source_folder(st.clone()).await?),
        "workspace_create" => {
            let ws = fsops::create_workspace(
                st.clone(),
                arg::<String>(args, "name")?,
                opt::<Vec<String>>(args, "sourcePaths")?.unwrap_or_default(),
                // An operator-chosen project location: the workspace is rooted
                // at that folder instead of an app-owned container.
                opt::<String>(args, "locationPath")?,
            )
            .await?;
            sovereign::refresh(st);
            ok(ws)
        }
        "workspace_update" => {
            let ws = fsops::update_workspace(
                st,
                &arg::<String>(args, "id")?,
                arg::<WorkspaceUpdate>(args, "update")?,
            )?;
            sovereign::refresh(st);
            ok(ws)
        }
        "workspace_approve" => {
            let ws = fsops::approve_workspace(st, &arg::<String>(args, "id")?)?;
            sovereign::refresh(st);
            ok(ws)
        }
        "workspace_remove" => {
            fsops::remove_workspace(
                st,
                &arg::<String>(args, "id")?,
                &opt::<Vec<String>>(args, "detachSessionIds")?.unwrap_or_default(),
            )?;
            sovereign::refresh(st);
            ok(())
        }
        "fs_list" => ok(fsops::list_dir(
            st,
            &arg::<String>(args, "workspaceId")?,
            &arg::<String>(args, "relPath")?,
        )?),
        "fs_read" => ok(fsops::read_text(
            st,
            &arg::<String>(args, "workspaceId")?,
            &arg::<String>(args, "relPath")?,
        )?),
        "fs_preview" => ok(fsops::preview_file(st, &arg::<String>(args, "path")?)?),
        // Saving an edit made in the file panel. `content` is read with `opt`
        // rather than `arg`, because emptying a file is a legitimate edit and
        // `arg` would reject the empty string.
        "fs_write" => ok(fsops::save_text(
            st,
            &arg::<String>(args, "path")?,
            &opt::<String>(args, "content")?.unwrap_or_default(),
        )?),
        "fs_reveal" => ok(fsops::reveal(st, &arg::<String>(args, "path")?)?),
        // Outward opens. The file clears the workspace boundary in each of
        // these; the program it opens inside is the operator's explicit
        // choice, launched directly with no shell in between.
        "fs_open_default" => ok(fsops::open_default(st, &arg::<String>(args, "path")?)?),
        "fs_open_with_list" => ok(fsops::open_with_list(st, &arg::<String>(args, "path")?)?),
        "fs_open_with" => ok(fsops::open_with(
            st,
            &arg::<String>(args, "path")?,
            &arg::<String>(args, "exe")?,
        )?),
        "fs_save_copy_as" => ok(fsops::save_copy_as(st.clone(), &arg::<String>(args, "path")?).await?),

        /* ---- persistent dev servers ---- */
        "devserver_start" => {
            let workspace_id = arg::<String>(args, "workspaceId")?;
            let path = st.with_db(|c| db::approved_workspace(c, &workspace_id))?.path;
            ok(devserver::start(
                st,
                &workspace_id,
                &path,
                opt::<String>(args, "command")?,
            )
            .await?)
        }
        "devserver_stop" => {
            devserver::stop(st, &arg::<String>(args, "workspaceId")?)?;
            ok(())
        }
        "devserver_status" => ok(st.dev_servers.status()),
        // Opens a dev server's URL in the operator's browser. The URL is one
        // of our own running servers' loopback addresses, not an arbitrary
        // link — checked against the registry, so this command can never be
        // used to aim the browser somewhere else.
        "devserver_open" => {
            let url = arg::<String>(args, "url")?;
            // Matched by origin rather than by exact string. What arrives here
            // was clicked in a chat answer or typed, so it can name a running
            // server without being byte-identical to the registered spelling:
            // no trailing slash, `localhost` for `127.0.0.1`, a path inside the
            // folder being served. The check itself is not relaxed — the port
            // still has to be one this app is serving, so this stays a way to
            // open our own dev servers and never a general-purpose URL opener.
            let want = loopback_origin(&url).ok_or_else(|| {
                CoreError::Denied(format!(
                    "'{url}' is not a loopback http URL with a port, so it was not opened."
                ))
            })?;
            let known = st
                .dev_servers
                .status()
                .into_iter()
                .filter_map(|s| s.url)
                .any(|known| loopback_origin(&known).as_deref() == Some(want.as_str()));
            if !known {
                return Err(CoreError::Denied(format!(
                    "'{url}' is not one of this app's running dev servers, so it was not opened."
                )));
            }
            st.app
                .opener()
                .open_url(url.clone(), None::<&str>)
                .map_err(|e| {
                    CoreError::ExecutionFailed(format!("The URL could not be opened: {e}"))
                })?;
            ok(())
        }

        /* ---- §4 documents ---- */
        "document_ingest" => ok(documents::ingest(st, &arg::<String>(args, "path")?).await?),
        "document_get" => ok(documents::get(st, &arg::<String>(args, "id")?)?),
        "document_page_image" => {
            let id = arg::<String>(args,"id")?;
            let page = arg::<u32>(args,"page")?;
            let state = st.clone();
            ok(tokio::task::spawn_blocking(move || documents::page_image(&state,&id,page)).await.map_err(|e| CoreError::ExecutionFailed(e.to_string()))??)
        }
        "document_list" => ok(documents::list(st)?),
        "document_pick" => ok(documents::pick(st.clone()).await?),
        "document_remove" => ok(documents::remove(st, &arg::<String>(args, "id")?)?),

        /* ---- §5 knowledge ---- */
        "knowledge_stats" => ok(knowledge::stats(st)?),
        "knowledge_list" => ok(knowledge::list(st)?),
        "knowledge_index" => ok(knowledge::index(st.clone(), arg::<Vec<String>>(args, "paths")?).await?),
        "knowledge_reindex" => ok(knowledge::reindex(st.clone(), arg::<String>(args, "id")?).await?),
        "knowledge_remove" => ok(knowledge::remove(st, &arg::<String>(args, "id")?)?),
        "knowledge_watch" => ok(knowledge::set_watching(st.clone(), arg::<bool>(args, "on")?)?),

        /* ---- §10 artifacts ---- */
        "artifact_list" => ok(artifacts::list(st)?),
        "artifact_verify" => ok(artifacts::verify(st, &arg::<String>(args, "id")?)?),
        "artifact_open" => ok(artifacts::open(st, &arg::<String>(args, "id")?)?),

        /* ---- harness, instructions and memories ---- */
        "harness_info" => ok(crate::harness::info(
            st,
            opt::<String>(args, "workspaceId")?.as_deref(),
        )?),
        "memory_list" => ok(crate::harness::list(
            st,
            opt::<String>(args, "workspaceId")?.as_deref(),
        )?),
        "memory_add" => ok(crate::harness::add(st, arg::<MemoryInput>(args, "input")?)?),
        "memory_update" => ok(crate::harness::update(
            st,
            &arg::<String>(args, "id")?,
            arg::<MemoryPatch>(args, "patch")?,
        )?),
        "memory_remove" => ok(crate::harness::remove(st, &arg::<String>(args, "id")?)?),
        "instructions_get" => ok(crate::harness::instructions_get(
            st,
            arg::<MemoryScope>(args, "scope")?,
            opt::<String>(args, "workspaceId")?.as_deref(),
        )?),
        "instructions_set" => ok(crate::harness::instructions_set(
            st,
            arg::<MemoryScope>(args, "scope")?,
            opt::<String>(args, "workspaceId")?.as_deref(),
            arg::<String>(args, "content")?,
        )?),

        /* ---- §8 sandbox ---- */
        "sandbox_policy" => ok(sandbox::policy(st)),
        "sandbox_run" => ok(sandbox::run(st.clone(), arg::<String>(args, "command")?, None).await?),
        "sandbox_kill" => ok(sandbox::kill(st, &arg::<String>(args, "runId")?)?),
        "sandbox_history" => ok(sandbox::history(st)?),

        /* ---- §13 audit ---- */
        "audit_list" => ok(audit::list(st, opt::<u32>(args, "limit")?.unwrap_or(200))?),
        "store_gate_list" => ok(audit::gate_list(st, opt::<u32>(args, "limit")?.unwrap_or(50))?),

        /* ---- §16 at-rest vault ---- */
        // Read-only: the vault's observable state (never derived from a
        // passphrase) and its append-only lifecycle ledger.
        "vault_status" => ok(crate::vault::status(st)?),
        "vault_event_list" => ok(st.with_db(|c| {
            crate::db::vault_event_page(c, opt::<u32>(args, "limit")?.unwrap_or(50))
        })?),
        "vault_enable" => {
            let passphrase = arg::<String>(args, "passphrase")?;
            ok(crate::vault::enable(st, &passphrase)?)
        }
        "vault_disable" => {
            let passphrase = arg::<String>(args, "passphrase")?;
            let status = crate::vault::disable(st, &passphrase)?;
            // The vault is off and mirrors are back in plaintext; rebuild the
            // full set from the database so anything captured while it was
            // sealed appears now rather than on the next scheduled sync.
            crate::harness::sync_memory_files(st)?;
            ok(status)
        }

        /* ---- §6 agent ---- */
        "turn_start" => ok(agent::start_turn(st.clone(), arg::<StartTurnInput>(args, "input")?).await?),
        // Compatibility for older local clients. The workbench composer uses the
        // typed `turn_start` boundary above.
        "agent_start" => ok(agent::start(st.clone(), arg::<StartRunInput>(args, "input")?).await?),
        "agent_cancel" => ok(agent::cancel(st, &arg::<String>(args, "runId")?)?),

        // §6. The conversation is stored by the core, so the transcript on
        // screen and the history the model is replayed are the same rows.
        "session_list" => ok(st.with_db(crate::db::sessions)?),
        "session_history" => {
            let id = arg::<String>(args, "sessionId")?;
            ok(st.with_db(|c| crate::db::session_messages(c, &id, agent::HISTORY_TURNS))?)
        }
        // Editing a sent message: delete that operator row and every turn after
        // it, then resend the corrected wording as a fresh turn. The rewrite
        // of the generated JSONL mirror is best-effort the way session_delete's
        // mirror removal is — the database is canonical either way.
        "session_truncate" => {
            let session_id = arg::<String>(args, "sessionId")?;
            let message_id = arg::<String>(args, "messageId")?;
            st.with_db(|c| crate::db::truncate_session_messages(c, &session_id, &message_id))?;
            let retained =
                st.with_db(|c| crate::db::session_messages(c, &session_id, usize::MAX))?;
            if let Err(error) = crate::harness::rewrite_session_mirror(&session_id, &retained) {
                st.emit_failure(&error);
            }
            ok(())
        }
        /* ---- pasted images: write clipboard pixels to a sovereign file so a
               turn can attach the path exactly as it would a picked file ---- */
        "attachment_stage" => ok(crate::attachments::stage(
            &arg::<String>(args, "name")?,
            &arg::<String>(args, "mimeType")?,
            &arg::<String>(args, "dataBase64")?,
        )?),
        "session_delete" => {
            let id = arg::<String>(args, "sessionId")?;
            st.with_db(|c| crate::db::delete_session(c, &id))?;
            if let Err(error) = crate::harness::remove_session_mirror(&id) {
                st.emit_failure(&error);
            }
            if let Err(error) = crate::harness::sync_memory_files(st) {
                st.emit_failure(&error);
            }
            ok(())
        }
        "session_memory" => ok(crate::harness::set_session_memory(
            st,
            &arg::<String>(args, "sessionId")?,
            arg::<bool>(args, "useMemories")?,
            arg::<bool>(args, "contributeMemories")?,
        )?),
        // Rebind a stored chat to a project, or detach it with a null. The
        // first turn's touch_session COALESCE only ever sets a workspace, so
        // an explicit clear has to come through this command; a chat with no
        // row yet is a no-op whose binding the first turn then inserts.
        "session_workspace" => {
            let session_id = arg::<String>(args, "sessionId")?;
            let workspace_id = opt::<String>(args, "workspaceId")?;
            st.with_db(|c| crate::db::set_session_workspace(c, &session_id, workspace_id.as_deref()))?;
            ok(())
        }
        "permission_respond" => ok(agent::respond_to_permission(
            st,
            &arg::<String>(args, "requestId")?,
            arg::<PermissionDecision>(args, "decision")?,
        )?),
        "question_answer" => {
            let id = arg::<String>(args, "questionId")?;
            let answer = arg::<String>(args, "answer")?;
            let delivered = st.answer_question(&id, &answer);
            if delivered {
                ok(())
            } else {
                Err(CoreError::Denied(
                    "That question is no longer waiting: it was answered, timed out, or its run \
                     was cancelled. Nothing was sent."
                        .to_string(),
                ))
            }
        }
        "change_apply" => ok(agent::apply_change(
            st,
            &arg::<String>(args, "runId")?,
            &arg::<String>(args, "path")?,
        )?),
        "change_discard" => ok(agent::discard_change(
            st,
            &arg::<String>(args, "runId")?,
            &arg::<String>(args, "path")?,
        )?),
        // Batch variants: one approval for the whole run's proposals. The
        // return is the list of files that did not make it, with reasons —
        // an empty list means every file went through.
        "change_apply_all" => ok(agent::apply_all_changes(
            st,
            &arg::<String>(args, "runId")?,
        )?),
        "change_discard_all" => ok(agent::discard_all_changes(
            st,
            &arg::<String>(args, "runId")?,
        )?),

        /* ---- settings ---- */
        "settings_get" => ok(st.settings()),
        "settings_set" => ok(settings_set(st, arg::<Value>(args, "patch")?)?),

        /* ---- shell ---- */
        "window_minimize" => {
            with_window(st, |w| {
                let _ = w.minimize();
            })?;
            ok(())
        }
        "window_toggle_maximize" => {
            with_window(st, |w| {
                let _ = match w.is_maximized() {
                    Ok(true) => w.unmaximize(),
                    _ => w.maximize(),
                };
            })?;
            ok(())
        }
        "window_close" => {
            with_window(st, |w| {
                let _ = w.close();
            })?;
            ok(())
        }
        // The way out when there is no desktop window to close. Reachable only
        // with the session cookie, i.e. only from a tab this process handed the
        // link to.
        "app_quit" => {
            QUITTING.store(true, Ordering::Relaxed);
            let app = st.app.clone();
            // Returned first so the caller sees the acknowledgement rather than
            // a dropped connection.
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(150)).await;
                app.exit(0);
            });
            ok(())
        }

        other => Err(CoreError::not_implemented(
            &format!("the command '{other}'"),
            &format!(
                "This build's command surface is fixed and auditable; nothing outside it runs.{}",
                suggestion(other)
            ),
        )),
    }
}

/* ------------------------------------------------------------------ */
/* Loopback URLs                                                       */
/* ------------------------------------------------------------------ */

/// The `http://127.0.0.1:<port>` origin of a loopback URL, or `None` for
/// anything else.
///
/// This is the whole of what `devserver_open` compares. Written by hand instead
/// of with a URL crate so the accepted shape stays small enough to read in one
/// go: plain http, an explicit port, a host that is this machine, and nothing
/// carried over from the path, query or fragment. A URL with credentials, a
/// different scheme or any other host cannot produce a `Some`.
fn loopback_origin(url: &str) -> Option<String> {
    let rest = url.strip_prefix("http://")?;
    let authority = rest.split(|c| c == '/' || c == '?' || c == '#').next()?;
    let (host, port) = authority.rsplit_once(':')?;
    let port: u16 = port.parse().ok()?;
    if !matches!(host, "127.0.0.1" | "localhost" | "[::1]") {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

#[cfg(test)]
mod loopback_urls {
    use super::loopback_origin;

    /// A registered URL always ends in a slash and the text an operator clicks
    /// often does not, so every spelling of one server has to fold onto one
    /// origin — otherwise the app refuses to open its own link.
    #[test]
    fn the_spellings_of_one_server_agree() {
        let want = Some("http://127.0.0.1:49731".to_string());
        for url in [
            "http://127.0.0.1:49731/",
            "http://127.0.0.1:49731",
            "http://localhost:49731/",
            "http://[::1]:49731/",
            "http://127.0.0.1:49731/index.html",
            "http://127.0.0.1:49731/app/?page=2#top",
        ] {
            assert_eq!(loopback_origin(url), want, "{url}");
        }
        // A different port is a different server.
        assert_ne!(loopback_origin("http://127.0.0.1:49732/"), want);
    }

    /// And the check still has to mean something.
    #[test]
    fn nothing_else_is_a_loopback_origin() {
        for url in [
            "http://example.com:49731/",
            "https://127.0.0.1:49731/",
            "http://127.0.0.1/",
            "http://127.0.0.1:notaport/",
            "http://user:pass@127.0.0.1:49731/",
            "http://127.0.0.1.example.com:49731/",
            "file:///C:/site/index.html",
            "127.0.0.1:49731",
        ] {
            assert_eq!(loopback_origin(url), None, "{url}");
        }
    }
}

/* ------------------------------------------------------------------ */
/* Unknown commands                                                    */
/* ------------------------------------------------------------------ */

/// Names the closest commands to one that does not exist.
///
/// This is what `COMMANDS` is for. A transport that answers a typo with nothing
/// but "no such command" pushes the caller into guessing, and the two callers
/// here are a frontend build and whatever the operator drives the HTTP surface
/// with — a `curl` against a misremembered name is an ordinary way to reach this
/// arm. Saying "did you mean sandbox_run" costs one pass over a fixed list and
/// turns a dead end into a correction.
///
/// Deliberately not fuzzy about *whether* to run something: the suggestion is
/// text in an error. Nothing outside the table is ever dispatched, however close
/// the spelling.
fn suggestion(unknown: &str) -> String {
    let mut near: Vec<(usize, usize, &str)> = COMMANDS
        .iter()
        .filter_map(|&c| score(unknown, c).map(|(dist, shared)| (dist, shared, c)))
        .collect();
    if near.is_empty() {
        return format!(" There are {} commands in this build.", COMMANDS.len());
    }
    // Fewest edits first; among equals the longer shared prefix; then
    // alphabetical, so the same typo always produces the same message.
    near.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.2.cmp(b.2))
    });
    near.truncate(3);
    let names: Vec<String> = near.iter().map(|(_, _, c)| format!("'{c}'")).collect();
    format!(" Did you mean {}?", names.join(", or "))
}

/// Edit distance and shared prefix length, or `None` when the two are not
/// plausibly the same name.
///
/// Two separate jobs, deliberately not folded into one number. The shared prefix
/// decides *whether* a candidate is worth naming — the command names are grouped
/// by subsystem, so `sandbx_run` sharing nothing with `audit_list` is enough to
/// drop it. Edit distance decides the *order*, because it is the one that
/// actually knows `sandbox_kil` means `sandbox_kill` and not `sandbox_history`.
/// An earlier version subtracted the prefix from the distance, which floored
/// every `sandbox_*` candidate at zero and ranked them alphabetically.
fn score(unknown: &str, candidate: &str) -> Option<(usize, usize)> {
    let a = unknown.to_ascii_lowercase();
    let b = candidate.to_ascii_lowercase();
    let shared = a.bytes().zip(b.bytes()).take_while(|(x, y)| x == y).count();
    let related = shared >= 4 || a.contains(&b) || b.contains(&a);
    let dist = edit_distance(&a, &b);
    // A third of the name may differ, at most, before this stops being a typo.
    let tolerance = (b.len() / 3).max(2);
    if !related && dist > tolerance {
        return None;
    }
    Some((dist, shared))
}

/// Levenshtein, two rows. The list is fifty short strings; nothing here needs to
/// be cleverer than that.
fn edit_distance(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() {
        return b.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, &ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, &cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

#[cfg(test)]
mod command_table {
    use super::COMMANDS;

    /// `COMMANDS` claims to be the answer to "what can the UI ask the core to
    /// do". That claim is only true while the list matches the arms of
    /// `dispatch`, and nothing about a `&[&str]` enforces it — a command added to
    /// the table and not the list would suggest wrong names and understate the
    /// surface. So the source is read back and each name is required to appear as
    /// a match pattern in it.
    #[test]
    fn every_name_is_a_dispatch_arm() {
        let src = include_str!("api.rs");
        let (_, body) = src.split_once("pub async fn dispatch").expect("dispatch exists");
        let missing: Vec<&str> = COMMANDS
            .iter()
            .copied()
            .filter(|c| !body.contains(&format!("\"{c}\"")))
            .collect();
        assert!(missing.is_empty(), "in COMMANDS but not dispatched: {missing:?}");
    }

    /// The other direction of the test above: an arm that exists in `dispatch`
    /// but not in `COMMANDS` is a command the frontend really can call while
    /// the table denies it exists — a typo of it gets a did-you-mean for a
    /// wrong name, and "every command the UI may ask the core to do" quietly
    /// stops being true. Five such arms had accumulated when this test was
    /// written. Arms are recognised by their rustfmt shape: exactly eight
    /// spaces, a quoted name, then ` =>` — a nested match inside an arm body
    /// indents deeper and cannot be mistaken for one.
    #[test]
    fn every_dispatch_arm_is_listed() {
        let src = include_str!("api.rs");
        let (_, body) = src.split_once("pub async fn dispatch").expect("dispatch exists");
        let arms: Vec<&str> = body
            .lines()
            .filter_map(|line| {
                let rest = line.strip_prefix("        \"")?;
                let (name, _) = rest.split_once("\" =>")?;
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
                    .then_some(name)
            })
            .collect();
        assert!(!arms.is_empty(), "no arms were extracted; this test has rotted");
        let missing: Vec<&str> = arms
            .iter()
            .copied()
            .filter(|a| !COMMANDS.contains(a))
            .collect();
        assert!(missing.is_empty(), "dispatched but not in COMMANDS: {missing:?}");
    }

    #[test]
    fn no_duplicates() {
        let mut seen: Vec<&str> = COMMANDS.to_vec();
        seen.sort_unstable();
        let before = seen.len();
        seen.dedup();
        assert_eq!(before, seen.len(), "COMMANDS lists a name twice");
    }

    /// The nearest name has to come *first*, not merely appear somewhere in the
    /// list — an operator reads the first suggestion and retries with it.
    #[test]
    fn the_nearest_name_leads() {
        for (typo, want) in [
            ("sandbox_kil", "sandbox_kill"),
            ("modle_list", "model_list"),
            ("artifact_opne", "artifact_open"),
            ("workspace_ad", "workspace_add"),
            ("knowledge_stat", "knowledge_stats"),
        ] {
            let s = super::suggestion(typo);
            assert!(
                s.starts_with(&format!(" Did you mean '{want}'")),
                "{typo} suggested: {s}"
            );
        }
        // And nonsense does not get a confident guess.
        let s = super::suggestion("zzzzzzzzzzzz");
        assert!(!s.contains("Did you mean"), "{s}");
    }
}

/* ------------------------------------------------------------------ */
/* Commands with logic of their own                                    */
/* ------------------------------------------------------------------ */

/// Takes a partial. The patch is merged over what is stored rather than
/// replacing it, so the UI can send one changed field.
fn settings_set(st: &Arc<AppState>, patch: Value) -> CoreResult<AppSettings> {
    let before = st.settings();
    let current = serde_json::to_value(&before)?;
    let merged: AppSettings = serde_json::from_value(db::merge(current, patch))?;
    // Egress follows the operator's settings. Nothing clamps it back here —
    // §11 keeps counting and auditing public traffic regardless, so a network
    // that was switched on remains visible in the status bar and the audit log.

    st.with_db(|conn| db::save_settings(conn, &merged))?;
    *st.settings.write().unwrap_or_else(|e| e.into_inner()) = merged.clone();

    // The catalogue resolves `${MODELS_ROOT}` against the settings, so a change
    // to the models directory has to be reloaded rather than waiting for a
    // restart.
    if let Ok(reg) = registry::Registry::load_or_seed(&registry::config_dir(), &merged.models_directory) {
        *st.registry.write().unwrap_or_else(|e| e.into_inner()) = reg;
        // Moving the folder has to re-render `models.ini` too: it records
        // absolute weight paths, and the offline/air-gapped setup reads it back
        // to rehydrate the catalogue. Reloading the catalogue repoints the
        // in-memory entries but leaves the file pointing at the old folder until
        // the next router start.
        if before.models_directory != merged.models_directory {
            router::write_preset_ini(st)?;
        }
    }

    // §11 — a folder setting is the one change that can move confidential work
    // onto replicated storage, so the replication check is re-run the moment one
    // of them moves rather than the next time somebody opens the Sovereignty
    // page. Only on an actual change: re-scanning on every toggle of a checkbox
    // would stat thousands of files for nothing.
    let folders_moved = before.models_directory != merged.models_directory
        || before.knowledge_root != merged.knowledge_root
        || before.sandbox_root != merged.sandbox_root
        || before.artifact_root != merged.artifact_root
        || before.memory_root != merged.memory_root;
    if folders_moved {
        sovereign::refresh(st);
    }
    if before.memory_root != merged.memory_root {
        crate::harness::sync_memory_files(st)?;
    }

    Ok(merged)
}

/// What the frontend needs to know about how it is being served.
///
/// `url` carries the session token, so the desktop window can offer a working
/// "open in browser" link. That is not an escalation: the webview already has
/// the whole command surface over IPC.
fn web_info(st: &Arc<AppState>) -> Value {
    let url = st.web_url.read().ok().and_then(|u| u.clone());
    serde_json::json!({
        "url": url,
        "headless": st.app.webview_windows().is_empty(),
    })
}

/// Window controls are meaningful only when there is a window. In a browser tab
/// the frontend hides them; if one is called anyway, say why rather than
/// silently succeeding.
fn with_window(st: &Arc<AppState>, f: impl FnOnce(&tauri::WebviewWindow)) -> CoreResult<()> {
    match st.app.get_webview_window("main") {
        Some(w) => {
            f(&w);
            Ok(())
        }
        None => Err(CoreError::not_implemented(
            "a window control",
            "This session has no desktop window — it is being served to a browser, where the tab's own controls apply. Use Quit to stop the core.",
        )),
    }
}
