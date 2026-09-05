//! Operator-facing execution evidence. No model-authored success flags.
//! Receipts are scoped by chat, persisted in SQLite, and exported only on request.
use std::sync::Arc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use crate::{artifacts, db, hardware, registry, router, sandbox};
use crate::error::{CoreError, CoreResult};
use crate::state::{now_ms, AppState};
use crate::types::{Artifact, ArtifactKind, StartRunInput, ToolName};

pub fn classify_destination(settings: &crate::types::AppSettings, address: &str) -> CoreResult<crate::state::Destination> {
    use crate::state::Destination;
    let deny = || CoreError::Denied("Public networking is blocked. Use loopback or the exact approved private IP endpoint; credentials in URLs are refused.".into());
    let url = reqwest::Url::parse(address).map_err(|_| deny())?;
    if !["http", "https"].contains(&url.scheme()) || !url.username().is_empty() || url.password().is_some() { return Err(deny()); }
    let host = url.host_str().unwrap_or("").trim_matches(['[',']']);
    let ip = host.parse::<std::net::IpAddr>().ok();
    if host == "localhost" || ip.is_some_and(|ip| ip.is_loopback()) { return Ok(Destination::Loopback); }
    let private = ip.is_some_and(|ip| match ip { std::net::IpAddr::V4(v) => v.is_private(), std::net::IpAddr::V6(v) => (v.segments()[0] & 0xfe00) == 0xfc00 });
    if settings.allow_private_server && private {
        if let Ok(configured) = reqwest::Url::parse(&settings.private_server_url) {
            let base = configured.path().trim_end_matches('/');
            if configured.origin() == url.origin() && (base.is_empty() || url.path() == base || url.path().starts_with(&format!("{base}/"))) {
                return Ok(Destination::PrivateServer);
            }
        }
    }
    Err(deny())
}

pub fn begin(st: &AppState, id: &str, input: &StartRunInput) -> CoreResult<()> {
    let workflow = input.prompt.lines().next().and_then(|line| {
        line.strip_prefix("[Workflow: ").and_then(|s| s.strip_suffix(']'))
    }).filter(|s| ["inspection", "dashboard", "discrepancy", "revision"].contains(s));
    let receipt = json!({
        "runId": id, "sessionId": input.session_id, "workspaceId": input.workspace_id,
        "workflow": workflow, "startedAt": now_ms(), "status": "running",
        "operator": st.operator, "inputs": input.attachments, "mode": input.mode,
        "ownerPid": std::process::id(), "ownerStartedAt": process_started(std::process::id()),
        "steps": [], "citations": [], "artifacts": [], "checks": [], "sandboxRuns": [],
        "networkScope": "Application HTTP guard decisions only. This is not an OS packet capture.",
        "networkEvents": []
    });
    st.with_db(|conn| {
        let active: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM run_receipts WHERE session_id=?1 AND json_extract(receipt,'$.status')='running')",[&input.session_id],|r| r.get(0))?;
        if active {return Err(CoreError::ExecutionFailed("This chat already has a running turn. Wait for it to finish or stop it first.".into()));}
        conn.execute("INSERT INTO run_receipts VALUES (?1,?2,?3,?4,?5)", params![
            id, input.session_id, input.workspace_id, receipt["startedAt"].as_i64(), receipt.to_string()
        ])?;
        Ok(())
    })
}

pub fn recover(conn: &Connection) -> CoreResult<()> {
    // A second window/process must not interrupt evidence owned by a live core.
    let mut statement = conn.prepare("SELECT run_id,receipt FROM run_receipts WHERE json_extract(receipt,'$.status')='running'")?;
    let rows=statement.query_map([],|r| Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<Result<Vec<_>,_>>()?;
    for (id,raw) in rows {
        let receipt: Value=serde_json::from_str(&raw)?;
        let live = receipt["ownerPid"].as_u64().and_then(|pid| u32::try_from(pid).ok()).and_then(process_started)
            .is_some_and(|started| receipt["ownerStartedAt"].as_u64()==Some(started));
        if !live {
            conn.execute("UPDATE run_receipts SET receipt=json_set(receipt,'$.status','interrupted') WHERE run_id=?1",[&id])?;
            // A crashed run never fires agent://done, so its receipt would keep an empty
            // networkEvents snapshot even though the run recorded guard decisions. Attach
            // the run-scoped decisions so the interrupted receipt's export still satisfies
            // "exported receipts include the decisions associated with their run".
            attach_interrupted_network(conn,&id)?;
        }
    }
    Ok(())
}

fn attach_interrupted_network(conn: &Connection, run: &str) -> CoreResult<()> {
    let present: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='network_events')",[],|r| r.get(0))?;
    if !present {return Ok(())}
    let rows = network_rows(conn,Some(run))?;
    if !rows.is_empty() {
        conn.execute("UPDATE run_receipts SET receipt=json_set(receipt,'$.networkEvents',json(?1)) WHERE run_id=?2",params![serde_json::to_string(&rows)?,run])?;
    }
    Ok(())
}

fn process_started(pid: u32) -> Option<u64> {
    let pid=sysinfo::Pid::from_u32(pid);
    let mut system=sysinfo::System::new();
    system.refresh_processes_specifics(sysinfo::ProcessesToUpdate::Some(&[pid]),true,sysinfo::ProcessRefreshKind::nothing());
    system.process(pid).map(|process| process.start_time())
}

fn stored(conn: &Connection, id: &str) -> CoreResult<Option<Value>> {
    let raw: Option<String> = conn.query_row("SELECT receipt FROM run_receipts WHERE run_id=?1", [id], |r| r.get(0)).optional()?;
    raw.map(|s| serde_json::from_str(&s).map_err(Into::into)).transpose()
}

fn completed_checks(receipt: &Value, outputs: &[Artifact]) -> Vec<Value> {
    let steps = receipt["steps"].as_array().cloned().unwrap_or_default();
    let ran = |names: &[&str]| steps.iter().any(|s| s["status"] == "done" && names.iter().any(|n| s["toolName"] == *n));
    let file = |kind: ArtifactKind| outputs.iter().any(|a| a.kind == kind && a.verified);
    let check = |name: &str, passed: bool, detail: &str| json!({"name":name,"passed":passed,"detail":detail});
    let mut out = vec![check("Source references recorded", receipt["citations"].as_array().is_some_and(|c| !c.is_empty()), "References establish traceability; they do not establish engineering correctness.")];
    match receipt["workflow"].as_str() {
        Some("inspection") => {
            out.push(check("Word package reopened", file(ArtifactKind::Docx), "A generated DOCX must pass the native package verifier."));
            out.push(check("Excel tracker reopened", file(ArtifactKind::Xlsx), "A generated XLSX must pass the native workbook verifier."));
            out.push(check("Tracker contains data rows", outputs.iter().any(|a| a.kind == ArtifactKind::Xlsx && populated_workbook(&a.path)), "Each sheet must contain non-empty rows beyond its header. Review the facts and references separately."));
            out.push(check("Local knowledge searched", ran(&["query_knowledge"]), "The run must consult the local knowledge connector."));
        }
        Some("dashboard") => {
            out.clear();
            let executed = receipt["sandboxRuns"].as_array().and_then(|runs| runs.last()).is_some_and(|r| r["status"] == "exited" && r["exitCode"] == 0);
            out.push(check("Latest sandbox execution succeeded", executed, "Inspect commands, exit codes and output to assess test coverage; process success alone is not a quality certification."));
            let tested = receipt["sandboxRuns"].as_array().and_then(|runs| runs.iter().rev().find(|r| r["command"].as_str().is_some_and(|c| c.to_lowercase().contains("test")))).is_some_and(|r| r["status"] == "exited" && r["exitCode"] == 0);
            out.push(check("Test command succeeded", tested, "A command naming tests must exit successfully. Inspect its output and source to assess what it actually tested."));
            let page_checked = steps.iter().rev().find(|s| s["toolName"] == "check_page").is_some_and(|s| s["status"] == "done");
            out.push(check("Latest page check completed", page_checked, "A later failure supersedes an earlier check. Read the detailed page-check verdict below."));
        }
        Some("discrepancy" | "revision") => {
            out.push(check("Review workbook reopened", file(ArtifactKind::Xlsx), "The review must produce a readable workbook with source references."));
        }
        _ => {}
    }
    out
}

pub fn workflow_gaps(st: &AppState, run: &str) -> CoreResult<Vec<String>> {
    st.with_db(|conn| {
        if has_denied_call(conn,run)? {return Ok(vec![])}
        let Some(mut receipt) = stored(conn,run)? else {return Ok(vec![])};
        if receipt["workflow"].is_null() {return Ok(vec![])}
        let steps = receipt["steps"].as_array().cloned().unwrap_or_default();
        // Never turn an operator refusal into another automatic approval request.
        if steps.iter().any(|s| (s["status"] == "skipped" && !s["toolName"].is_null()) || s["error"].as_str().is_some_and(|e| {let e=e.to_lowercase(); e.contains("operator") && (e.contains("denied") || e.contains("declined") || e.contains("refused"))})) {return Ok(vec![])}
        receipt["citations"] = json!(steps.iter().flat_map(|s| s["citations"].as_array().cloned().unwrap_or_default()).collect::<Vec<_>>());
        let outputs: Vec<_> = db::artifacts(conn)?.into_iter().filter(|a| a.source_task == run).collect();
        Ok(completed_checks(&receipt,&outputs).iter().filter(|c| c["passed"] == false).filter_map(|c| c["name"].as_str().map(str::to_string)).collect())
    })
}

pub fn workflow_should_escalate(st: &AppState, run: &str) -> CoreResult<bool> {
    st.with_db(|conn| {
        if has_denied_call(conn,run)? {return Ok(false)}
        let Some(receipt) = stored(conn,run)? else {return Ok(false)};
        if receipt["workflow"] != "dashboard" {return Ok(false)}
        let steps=receipt["steps"].as_array().cloned().unwrap_or_default();
        if steps.iter().any(|s| s["status"] == "skipped" && !s["toolName"].is_null()) {return Ok(false)}
        let failed=steps.iter().filter(|s| s["status"] == "failed" && !s["toolName"].is_null()).count();
        Ok(failed >= 3)
    })
}

fn has_denied_call(conn: &Connection, run: &str) -> CoreResult<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM audit WHERE run_id=?1 AND status='denied')",[run],|r| r.get(0))?)
}

fn populated_workbook(path: &str) -> bool {
    use calamine::Reader;
    let Ok(mut workbook) = calamine::open_workbook_auto(path) else {return false};
    let names = workbook.sheet_names().to_vec();
    !names.is_empty() && names.iter().all(|name| workbook.worksheet_range(name).ok().is_some_and(|r| r.rows().skip(1).any(|row| row.iter().any(|c| !matches!(c,calamine::Data::Empty)))))
}

fn validate_sheets(kind: Option<&str>, sheets: &[(String,Vec<Vec<String>>)]) -> CoreResult<()> {
    if !matches!(kind, Some("inspection" | "discrepancy" | "revision")) {return Ok(())}
    if sheets.is_empty() || sheets.iter().any(|(_,rows)| !rows.iter().skip(1).any(|row| row.iter().any(|c| !c.trim().is_empty()))) {
        return Err(CoreError::MalformedToolCall("This review workflow requires populated worksheets, not a header-only template. Call generate_xlsx again with actual findings, actions, source references and unresolved items as rows after each header. If a category has no findings, include an explicit 'None found in the reviewed evidence' row. Do not invent values.".into()));
    }
    if kind == Some("inspection") {
        for name in ["Findings","Actions","Sources","Unresolved"] {
            if !sheets.iter().any(|(n,_)| n.eq_ignore_ascii_case(name)) {return Err(CoreError::MalformedToolCall(format!("Inspection package is missing the {name} worksheet. Include Findings, Actions, Sources and Unresolved, all populated.")));}
        }
    }
    Ok(())
}

pub fn validate_workflow_sheets(st: &AppState, run: &str, sheets: &[(String,Vec<Vec<String>>)]) -> CoreResult<()> {
    let receipt = st.with_db(|c| stored(c,run))?;
    validate_sheets(receipt.as_ref().and_then(|r| r["workflow"].as_str()),sheets)
}

pub fn record_sandbox(st: &AppState, run_id: &str, result: &crate::types::SandboxRun) -> CoreResult<()> {
    st.with_db(|conn| {
        let Some(mut receipt) = stored(conn,run_id)? else {return Ok(())};
        if receipt["sandboxRuns"].is_null() {receipt["sandboxRuns"] = json!([]);}
        let runs = receipt["sandboxRuns"].as_array_mut().expect("sandbox evidence");
        if !runs.iter().any(|r| r["id"] == result.id) {runs.push(json!(result));}
        conn.execute("UPDATE run_receipts SET receipt=?1 WHERE run_id=?2",params![receipt.to_string(),run_id])?;
        Ok(())
    })
}

pub fn observe(st: &AppState, event: &str, raw: &str) -> CoreResult<()> {
    let payload: Value = serde_json::from_str(raw)?;
    let Some(id) = payload["runId"].as_str() else { return Ok(()) };
    st.with_db(|conn| {
        let Some(mut receipt) = stored(conn, id)? else { return Ok(()) };
        if receipt["status"] != "running" { return Ok(()) }
        if event == "agent://step" {
            let steps = receipt["steps"].as_array_mut().expect("receipt steps");
            if let Some(previous) = steps.iter_mut().find(|s| s["id"] == payload["id"]) {
                *previous = payload.clone();
            } else { steps.push(payload.clone()); }
        } else if event == "agent://done" {
            receipt["status"] = json!(if !payload["failure"].is_null() { "failed" } else if payload["summary"] == "Stopped." { "stopped" } else { "finished" });
            for key in ["elapsedMs", "modelId", "tokensPerSec", "citations", "failure", "plan", "changes"] {
                receipt[key] = payload[key].clone();
            }
            receipt["finishedAt"] = json!(now_ms());
            let outputs: Vec<_> = db::artifacts(conn)?.into_iter().filter(|a| a.source_task == id && a.session_id.as_deref() == receipt["sessionId"].as_str()).collect();
            receipt["checks"] = json!(completed_checks(&receipt, &outputs));
            if receipt["status"] == "finished" && !receipt["workflow"].is_null() && receipt["checks"].as_array().is_some_and(|checks| checks.iter().any(|c| c["passed"] == false)) {
                receipt["status"] = json!("incomplete");
            }
            receipt["artifacts"] = json!(outputs);
            receipt["networkEvents"] = json!(network_rows(conn, Some(id))?);
        }
        conn.execute("UPDATE run_receipts SET receipt=?1 WHERE run_id=?2", params![receipt.to_string(),id])?;
        Ok(())
    })
}

pub fn list(st: &AppState, session: &str) -> CoreResult<Vec<Value>> {
    st.with_db(|conn| list_for_session(conn, session))
}

fn list_for_session(conn: &Connection, session: &str) -> CoreResult<Vec<Value>> {
        let mut stmt = conn.prepare("SELECT receipt FROM run_receipts WHERE session_id=?1 ORDER BY started_at DESC LIMIT 50")?;
        let rows = stmt.query_map([session], |r| r.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        rows.into_iter().map(|s| serde_json::from_str(&s).map_err(Into::into)).collect()
}

pub fn export(st: &Arc<AppState>, session: &str, run: &str) -> CoreResult<Artifact> {
    let receipt = st.with_db(|c| stored(c,run))?.filter(|r| r["sessionId"] == session)
        .ok_or_else(|| CoreError::Denied("This receipt does not belong to the requested chat.".into()))?;
    if receipt["status"] == "running" { return Err(CoreError::Denied("Wait for the run to finish before exporting its receipt.".into())); }
    let attachments: Vec<String> = serde_json::from_value(receipt["inputs"].clone())?;
    let prov = artifacts::Provenance { task: run, run_id: Some(run), workspace_id: receipt["workspaceId"].as_str(), session_id: Some(session), attachments: &attachments, model_id: "native-audit", tool: ToolName::GenerateText };
    let body = format!("# Execution receipt\n\nRecorded by the local core. Status: **{}**.\n\nChecks concern execution and file structure, not engineering approval. Application guard decisions are not a machine-wide network capture. Input paths record what was submitted, not proof each file was read.\n\n```json\n{}\n```\n", receipt["status"].as_str().unwrap_or("unknown"), serde_json::to_string_pretty(&receipt)?);
    artifacts::generate_doc(st, ArtifactKind::Markdown, &format!("receipt-{run}.md"), None, &body, &prov)
}

pub fn record_network(st: &AppState, destination: &str, outcome: &str, detail: &str) {
    let run = crate::state::current_run().map(|r| r.0);
    if let Err(e) = st.with_db(|conn| {
        conn.execute("INSERT INTO network_events(at,run_id,destination,outcome,detail) VALUES (?1,?2,?3,?4,?5)",params![now_ms(),run,destination,outcome,detail])?;
        Ok(())
    }) { eprintln!("[network audit] {e}"); }
}

fn network_rows(conn: &Connection, run: Option<&str>) -> CoreResult<Vec<Value>> {
    let mut stmt = conn.prepare("SELECT at,run_id,destination,outcome,detail FROM network_events WHERE (?1 IS NULL OR run_id=?1) ORDER BY id DESC LIMIT 500")?;
    let rows = stmt.query_map([run], |r| Ok(json!({"at":r.get::<_,i64>(0)?,"runId":r.get::<_,Option<String>>(1)?,"destination":r.get::<_,String>(2)?,"outcome":r.get::<_,String>(3)?,"detail":r.get::<_,String>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
    Ok(rows)
}

pub fn network(st: &AppState) -> CoreResult<Vec<Value>> { st.with_db(|c| network_rows(c,None)) }

pub async fn readiness(st: &Arc<AppState>) -> CoreResult<Value> {
    let settings = st.settings();
    let mut checks = Vec::new();
    let mut add = |name: &str, status: &str, detail: String| checks.push(json!({"name":name,"status":status,"detail":detail}));
    add("Public network guard", "pass", "Public HTTP destinations are refused by this build. OS firewall coverage must be verified separately.".into());
    add("Sandbox network policy", if settings.sandbox_network {"fail"} else {"pass"}, "Sandbox network access must remain disabled for the demonstration.".into());
    add("Local inference executable", if std::path::Path::new(&settings.llama_server_path).is_file() {"pass"} else {"fail"}, settings.llama_server_path.clone());
    {
        let reg = st.registry.read().expect("registry lock");
        for (label, kind, agent) in [("Document reasoning route", registry::TaskKind::Reasoning, true), ("Coding route",registry::TaskKind::Code,true), ("Scanned document route",registry::TaskKind::ScannedDocument,false)] {
            let route = if agent {reg.route_agent(kind,None)} else {reg.route(kind,None)};
            let ready = route.model_id.as_deref().is_some_and(|id| reg.is_present(id));
            add(label, if ready {"pass"} else {"fail"}, format!("{} — {}",route.model_id.as_deref().unwrap_or("No model"),route.reason));
        }
    }
    for program in ["python", "node", "pdftoppm"] {
        let found = sandbox::resolve_program(program);
        add(&format!("Local {program}"), if found.is_some() {"pass"} else {"warn"}, found.map(|p| p.display().to_string()).unwrap_or_else(|| "Not resolved locally. Install or configure it offline before using workflows that require it.".into()));
    }
    let exporter = artifacts::readiness_probe();
    add("Artifact exporters", if exporter.is_ok() {"pass"} else {"fail"}, exporter.unwrap_or_else(|e| e.to_string()));
    let knowledge = st.with_db(db::knowledge_totals)?;
    add("Local knowledge", if knowledge.0 > 0 {"pass"} else {"warn"}, format!("{} sources, {} chunks. Index the demonstration SOP before starting.", knowledge.0,knowledge.1));
    let hw = hardware::status(st).await?;
    add("GPU telemetry", if hw.vram_total_mb > 0 {"pass"} else {"warn"}, format!("{}; {} MiB budget. Presence checks do not prove models fit: run a warm-up task.",hw.gpu_name,hw.vram_budget_mb));
    Ok(json!({"checkedAt":now_ms(),"checks":checks,"hardware":hw,"runtime":router::list_models(st).await?,"scope":"Local dependency and configuration checks; no inference is run and no external request is made."}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approved_endpoint_cannot_be_spoofed_with_a_prefix_or_userinfo() {
        let mut s = registry::default_settings();
        s.allow_private_server = true;
        s.private_server_url = "http://10.1.2.3:8080/v1".into();
        assert!(classify_destination(&s,"http://10.1.2.3:8080/v1/chat/completions").is_ok());
        for url in ["http://10.1.2.3:8080/v10/chat", "http://10.1.2.3.evil.example:8080/v1", "http://10.1.2.3:8081/v1", "http://localhost@public.example/", "file:///tmp/a", "https://203.0.113.1/"] {
            assert!(classify_destination(&s,url).is_err(),"{url}");
        }
        assert!(classify_destination(&s,"http://[::1]:8080/v1").is_ok());
    }
    #[test]
    fn successful_prose_cannot_satisfy_deliverable_checks() {
        let receipt = json!({"workflow":"inspection","steps":[],"citations":[]});
        assert!(completed_checks(&receipt,&[]).iter().all(|c| c["passed"] == false));
    }
    #[test]
    fn failed_execution_never_counts_as_verified_coding() {
        let receipt = json!({"workflow":"dashboard","steps":[{"toolName":"run_command","status":"done"}],"sandboxRuns":[{"status":"exited","exitCode":1}],"citations":[]});
        assert!(completed_checks(&receipt,&[]).iter().all(|c| c["passed"] == false));
    }
    #[test]
    fn review_workflows_refuse_header_only_templates() {
        let sheets = vec![("Findings".into(),vec![vec!["Equipment".into()]])];
        assert!(validate_sheets(Some("inspection"),&sheets).is_err());
        assert!(validate_sheets(Some("revision"),&sheets).is_err());
        assert!(validate_sheets(None,&sheets).is_ok());
    }
    #[test]
    fn later_coding_failures_supersede_earlier_success() {
        let receipt = json!({"workflow":"dashboard","steps":[{"toolName":"check_page","status":"done"},{"toolName":"check_page","status":"failed"}],"sandboxRuns":[{"status":"exited","exitCode":0},{"status":"exited","exitCode":1}]});
        assert!(completed_checks(&receipt,&[]).iter().all(|c| c["passed"] == false));
    }
    #[test]
    fn restart_recovery_preserves_finished_receipts_and_chat_isolation() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE run_receipts(run_id TEXT,session_id TEXT,started_at INTEGER,receipt TEXT);").unwrap();
        for (run,session,status) in [("r1","a","running"),("r2","b","finished")] {
            c.execute("INSERT INTO run_receipts VALUES (?1,?2,1,?3)",params![run,session,json!({"runId":run,"status":status}).to_string()]).unwrap();
        }
        recover(&c).unwrap();
        assert_eq!(stored(&c,"r1").unwrap().unwrap()["status"],"interrupted");
        let visible = list_for_session(&c,"b").unwrap();
        assert_eq!(visible.len(),1); assert_eq!(visible[0]["status"],"finished");
        assert_eq!(visible[0]["runId"],"r2");
    }
    #[test]
    fn interrupted_receipts_snapshot_their_runs_guard_decisions() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE run_receipts(run_id TEXT,session_id TEXT,started_at INTEGER,receipt TEXT); CREATE TABLE network_events(id INTEGER PRIMARY KEY,at INTEGER,run_id TEXT,destination TEXT,outcome TEXT,detail TEXT);").unwrap();
        let stale = json!({"runId":"r1","status":"running","ownerPid":99_999_999,"ownerStartedAt":1,"networkEvents":[]});
        c.execute("INSERT INTO run_receipts VALUES ('r1','a',1,?1)",[stale.to_string()]).unwrap();
        c.execute("INSERT INTO network_events(at,run_id,destination,outcome,detail) VALUES (1,'r1','loopback','allowed','one'),(2,'other','public','denied','two')",params![]).unwrap();
        recover(&c).unwrap();
        let receipt = stored(&c,"r1").unwrap().unwrap();
        assert_eq!(receipt["status"],"interrupted");
        let events = receipt["networkEvents"].as_array().expect("networkEvents array");
        assert_eq!(events.len(),1,"only this run's decisions are attached");
        assert_eq!(events[0]["destination"],"loopback");
        assert_eq!(events[0]["outcome"],"allowed");
    }
    #[test]
    fn network_events_are_isolated_by_run() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE network_events(id INTEGER PRIMARY KEY,at INTEGER,run_id TEXT,destination TEXT,outcome TEXT,detail TEXT); INSERT INTO network_events VALUES(1,1,'a','loopback','allowed','one'),(2,2,'b','public','denied','two');").unwrap();
        let rows = network_rows(&c,Some("a")).unwrap();
        assert_eq!(rows.len(),1); assert_eq!(rows[0]["runId"],"a");
    }
    #[test]
    fn a_refusal_stops_automatic_repairs_only_for_its_own_run() {
        let c=Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE audit(run_id TEXT,status TEXT); INSERT INTO audit VALUES('a','denied'),('b','failed');").unwrap();
        assert!(has_denied_call(&c,"a").unwrap());
        assert!(!has_denied_call(&c,"b").unwrap());
    }
    #[test]
    fn another_window_keeps_receipts_owned_by_a_live_process_running() {
        let c=Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE run_receipts(run_id TEXT,receipt TEXT);").unwrap();
        let row=json!({"status":"running","ownerPid":std::process::id(),"ownerStartedAt":process_started(std::process::id()).unwrap()});
        c.execute("INSERT INTO run_receipts VALUES ('live',?1)",[row.to_string()]).unwrap();
        recover(&c).unwrap();
        assert_eq!(stored(&c,"live").unwrap().unwrap()["status"],"running");
    }
}
