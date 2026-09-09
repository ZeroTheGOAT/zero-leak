//! Codex-derived, session-scoped multi-agent control plane.
//!
//! OpenAI Codex models every child as an independent thread beneath a shared
//! root registry. ZeroLeak keeps that useful shape while retaining its own
//! local model router, SQLite authority, approval broker, and air-gap rules.
//! Children never receive another project's memories or paths: their root
//! session and workspace are captured here at reservation time.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::Notify;

use crate::error::{CoreError, CoreResult};
use crate::state::{new_id, now_ms, AppState};
use crate::types::{
    AgentStep, StepKind, StepStatus, SubagentEvent, SubagentInfo, SubagentRole,
    SubagentStatus, ToolName, StartRunInput, RunStarted,
};

struct LaunchRequest {
    input: StartRunInput,
    reply: tokio::sync::oneshot::Sender<CoreResult<RunStarted>>,
}

#[derive(Default)]
struct Inner {
    agents: HashMap<String, SubagentInfo>,
    run_to_agent: HashMap<String, String>,
    session_to_agent: HashMap<String, String>,
    mailboxes: HashMap<String, VecDeque<String>>,
}

/// Shared by every run in the process. Scope is still per root session because
/// every query and capacity check requires the root id captured on the record.
pub struct MultiAgentControl {
    inner: Mutex<Inner>,
    changed: Notify,
    launcher: tokio::sync::mpsc::UnboundedSender<LaunchRequest>,
    launch_rx: Mutex<Option<tokio::sync::mpsc::UnboundedReceiver<LaunchRequest>>>,
}

impl Default for MultiAgentControl {
    fn default() -> Self {
        let (launcher, launch_rx) = tokio::sync::mpsc::unbounded_channel();
        Self {
            inner: Mutex::new(Inner::default()),
            changed: Notify::new(),
            launcher,
            launch_rx: Mutex::new(Some(launch_rx)),
        }
    }
}

impl MultiAgentControl {
    pub async fn launch(&self, input: StartRunInput) -> CoreResult<RunStarted> {
        let (reply, answer) = tokio::sync::oneshot::channel();
        self.launcher
            .send(LaunchRequest { input, reply })
            .map_err(|_| CoreError::ExecutionFailed("The subagent supervisor is not running.".into()))?;
        answer
            .await
            .map_err(|_| CoreError::ExecutionFailed("The subagent supervisor stopped before launching the child.".into()))?
    }

    pub fn restore(&self, rows: Vec<SubagentInfo>) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        for mut row in rows {
            if !row.status.is_final() {
                row.status = SubagentStatus::Interrupted;
                row.error = Some("The application stopped while this agent was running.".into());
                row.updated_at = now_ms();
            }
            if let Some(run_id) = row.run_id.clone() {
                inner.run_to_agent.insert(run_id, row.id.clone());
            }
            inner.session_to_agent.insert(row.session_id.clone(), row.id.clone());
            inner.agents.insert(row.id.clone(), row);
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn reserve(
        &self,
        root_session_id: &str,
        current_session_id: &str,
        parent_run_id: &str,
        workspace_id: Option<String>,
        task_name: &str,
        role: SubagentRole,
        max_agents: u32,
        max_depth: u32,
    ) -> CoreResult<SubagentInfo> {
        let task_name = validate_task_name(task_name)?;
        let mut inner = self.inner.lock().map_err(|_| {
            CoreError::ExecutionFailed("The agent registry lock was poisoned.".into())
        })?;
        let parent = inner
            .session_to_agent
            .get(current_session_id)
            .and_then(|id| inner.agents.get(id))
            .cloned();
        let depth = parent.as_ref().map_or(1, |agent| agent.depth.saturating_add(1));
        if depth > max_depth.max(1) {
            return Err(CoreError::Denied(format!(
                "Subagent depth {depth} exceeds this workstation's limit of {}.",
                max_depth.max(1)
            )));
        }
        let active = inner
            .agents
            .values()
            .filter(|agent| agent.root_session_id == root_session_id && !agent.status.is_final())
            .count();
        if active >= max_agents.max(1) as usize {
            return Err(CoreError::Denied(format!(
                "This chat already has {active} active subagents, the configured limit. Wait for or interrupt one before spawning another."
            )));
        }
        let parent_path = parent.as_ref().map_or("/root", |agent| agent.path.as_str());
        let path = format!("{}/{}", parent_path.trim_end_matches('/'), task_name);
        if inner.agents.values().any(|agent| {
            agent.root_session_id == root_session_id && agent.path == path
        }) {
            return Err(CoreError::Denied(format!(
                "Agent task path '{path}' already exists. Reuse it with followup_task."
            )));
        }
        let now = now_ms();
        let agent = SubagentInfo {
            id: new_id("agent"),
            task_name,
            path,
            root_session_id: root_session_id.to_string(),
            session_id: new_id("subthread"),
            parent_id: parent.map(|agent| agent.id),
            parent_run_id: parent_run_id.to_string(),
            workspace_id,
            role,
            status: SubagentStatus::Pending,
            depth,
            run_id: None,
            model_id: None,
            result: String::new(),
            error: None,
            created_at: now,
            updated_at: now,
        };
        inner.session_to_agent.insert(agent.session_id.clone(), agent.id.clone());
        inner.agents.insert(agent.id.clone(), agent.clone());
        self.changed.notify_waiters();
        Ok(agent)
    }

    pub fn attach_run(&self, agent_id: &str, run_id: &str) -> CoreResult<SubagentInfo> {
        let mut inner = self.inner.lock().map_err(|_| {
            CoreError::ExecutionFailed("The agent registry lock was poisoned.".into())
        })?;
        let agent = inner.agents.get_mut(agent_id).ok_or_else(|| {
            CoreError::ExecutionFailed(format!("Subagent '{agent_id}' was not found."))
        })?;
        agent.run_id = Some(run_id.to_string());
        agent.status = SubagentStatus::Running;
        agent.updated_at = now_ms();
        let out = agent.clone();
        inner.run_to_agent.insert(run_id.to_string(), agent_id.to_string());
        self.changed.notify_waiters();
        Ok(out)
    }

    pub fn fail_reserved(&self, agent_id: &str, error: String) -> Option<SubagentInfo> {
        let mut inner = self.inner.lock().ok()?;
        let agent = inner.agents.get_mut(agent_id)?;
        agent.status = SubagentStatus::Failed;
        agent.error = Some(error);
        agent.updated_at = now_ms();
        let out = agent.clone();
        self.changed.notify_waiters();
        Some(out)
    }

    pub fn restart(&self, reference: &str, root_session_id: &str) -> CoreResult<SubagentInfo> {
        let mut inner = self.inner.lock().map_err(|_| {
            CoreError::ExecutionFailed("The agent registry lock was poisoned.".into())
        })?;
        let id = resolve(&inner, reference, root_session_id)?.id.clone();
        let agent = inner.agents.get_mut(&id).expect("resolved agent");
        if !agent.status.is_final() {
            return Err(CoreError::Denied(format!(
                "Agent '{}' is already active; use send_message to steer it.", agent.path
            )));
        }
        agent.status = SubagentStatus::Pending;
        agent.run_id = None;
        agent.result.clear();
        agent.error = None;
        agent.updated_at = now_ms();
        let out = agent.clone();
        self.changed.notify_waiters();
        Ok(out)
    }

    pub fn complete_run(
        &self,
        run_id: &str,
        result: String,
        error: Option<String>,
        model_id: Option<String>,
    ) -> Option<SubagentInfo> {
        let mut inner = self.inner.lock().ok()?;
        let id = inner.run_to_agent.get(run_id)?.clone();
        let agent = inner.agents.get_mut(&id)?;
        agent.status = if error.is_some() {
            if error.as_deref().is_some_and(|e| e.contains("cancel")) {
                SubagentStatus::Interrupted
            } else {
                SubagentStatus::Failed
            }
        } else {
            SubagentStatus::Completed
        };
        agent.result = result;
        agent.error = error;
        agent.model_id = model_id;
        agent.updated_at = now_ms();
        let out = agent.clone();
        let recipient_session = out
            .parent_id
            .as_ref()
            .and_then(|parent_id| inner.agents.get(parent_id))
            .map(|parent| parent.session_id.clone())
            .unwrap_or_else(|| out.root_session_id.clone());
        let completion = if out.status == SubagentStatus::Completed {
            format!("Subagent {} completed.\n{}", out.path, out.result)
        } else {
            format!(
                "Subagent {} ended as {:?}.\n{}",
                out.path,
                out.status,
                out.error.as_deref().unwrap_or("No error detail was returned.")
            )
        };
        inner.mailboxes.entry(recipient_session).or_default().push_back(completion);
        self.changed.notify_waiters();
        Some(out)
    }

    pub fn get(&self, reference: &str, root_session_id: &str) -> CoreResult<SubagentInfo> {
        let inner = self.inner.lock().map_err(|_| {
            CoreError::ExecutionFailed("The agent registry lock was poisoned.".into())
        })?;
        resolve(&inner, reference, root_session_id).cloned()
    }

    pub fn list(&self, root_session_id: &str, prefix: Option<&str>) -> Vec<SubagentInfo> {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let mut rows = inner
            .agents
            .values()
            .filter(|agent| agent.root_session_id == root_session_id)
            .filter(|agent| prefix.is_none_or(|prefix| agent.path.starts_with(prefix)))
            .cloned()
            .collect::<Vec<_>>();
        rows.sort_by(|a, b| a.path.cmp(&b.path).then_with(|| a.created_at.cmp(&b.created_at)));
        rows
    }

    pub fn remove_root(&self, root_session_id: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let ids = inner
            .agents
            .values()
            .filter(|agent| agent.root_session_id == root_session_id)
            .map(|agent| agent.id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            if let Some(agent) = inner.agents.remove(&id) {
                inner.session_to_agent.remove(&agent.session_id);
                if let Some(run_id) = agent.run_id {
                    inner.run_to_agent.remove(&run_id);
                }
                inner.mailboxes.remove(&agent.session_id);
            }
        }
        self.changed.notify_waiters();
    }

    pub fn descendant_runs(&self, parent_run_id: &str) -> Vec<String> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .agents
            .values()
            .filter(|agent| agent.parent_run_id == parent_run_id && !agent.status.is_final())
            .filter_map(|agent| agent.run_id.clone())
            .collect()
    }

    pub fn send_message(
        &self,
        reference: &str,
        root_session_id: &str,
        message: String,
    ) -> CoreResult<SubagentInfo> {
        if message.trim().is_empty() {
            return Err(CoreError::MalformedToolCall("A subagent message cannot be empty.".into()));
        }
        let mut inner = self.inner.lock().map_err(|_| {
            CoreError::ExecutionFailed("The agent registry lock was poisoned.".into())
        })?;
        let id = resolve(&inner, reference, root_session_id)?.id.clone();
        if inner.agents.get(&id).is_some_and(|agent| agent.status.is_final()) {
            return Err(CoreError::Denied(
                "That agent is no longer running; use followup_task to continue its thread.".into(),
            ));
        }
        let session_id = inner.agents.get(&id).expect("resolved agent").session_id.clone();
        inner.mailboxes.entry(session_id).or_default().push_back(message);
        let agent = inner.agents.get_mut(&id).expect("resolved agent");
        if !agent.status.is_final() {
            agent.status = SubagentStatus::Running;
        }
        agent.updated_at = now_ms();
        let out = agent.clone();
        self.changed.notify_waiters();
        Ok(out)
    }

    pub fn drain_messages(&self, session_id: &str) -> Vec<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|mut inner| inner.mailboxes.remove(session_id))
            .map(|queue| queue.into_iter().collect())
            .unwrap_or_default()
    }

    pub async fn wait_for(
        &self,
        root_session_id: &str,
        references: &[String],
        timeout: Duration,
    ) -> CoreResult<Vec<SubagentInfo>> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let rows = if references.is_empty() {
                self.list(root_session_id, None)
            } else {
                references
                    .iter()
                    .map(|reference| self.get(reference, root_session_id))
                    .collect::<CoreResult<Vec<_>>>()?
            };
            if rows.iter().any(|agent| agent.status.is_final()) {
                return Ok(rows);
            }
            if tokio::time::timeout_at(deadline, self.changed.notified()).await.is_err() {
                return Ok(rows);
            }
        }
    }
}

/// Starts the one launch supervisor after `AppState` has been placed in an
/// `Arc`. Keeping recursive child creation behind this queue breaks the async
/// type recursion and gives the workstation one auditable admission point.
pub fn start_supervisor(st: std::sync::Arc<AppState>) {
    let mut rx = st
        .multi_agent
        .launch_rx
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
    let Some(mut rx) = rx.take() else { return };
    tauri::async_runtime::spawn(async move {
        while let Some(request) = rx.recv().await {
            let result = crate::agent::start(st.clone(), request.input).await;
            let _ = request.reply.send(result);
        }
    });
}

fn resolve<'a>(inner: &'a Inner, reference: &str, root: &str) -> CoreResult<&'a SubagentInfo> {
    inner
        .agents
        .values()
        .find(|agent| {
            agent.root_session_id == root
                && (agent.id == reference || agent.path == reference || agent.task_name == reference)
        })
        .ok_or_else(|| CoreError::Denied(format!("No subagent named '{reference}' exists in this chat.")))
}

fn validate_task_name(value: &str) -> CoreResult<String> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(CoreError::MalformedToolCall(
            "task_name must contain 1-64 lowercase letters, digits, or underscores.".into(),
        ));
    }
    Ok(value.to_string())
}

pub fn emit(st: &AppState, agent: &SubagentInfo) {
    st.emit(
        "agent://subagent",
        SubagentEvent {
            root_session_id: agent.root_session_id.clone(),
            parent_run_id: agent.parent_run_id.clone(),
            agent: agent.clone(),
        },
    );
    let (status, error) = match agent.status {
        SubagentStatus::Pending | SubagentStatus::Running | SubagentStatus::Waiting => {
            (StepStatus::Running, None)
        }
        SubagentStatus::Completed => (StepStatus::Done, None),
        SubagentStatus::Failed => (StepStatus::Failed, agent.error.clone()),
        SubagentStatus::Interrupted => (StepStatus::Skipped, agent.error.clone()),
    };
    let detail = match agent.status {
        SubagentStatus::Completed if !agent.result.trim().is_empty() => Some(agent.result.clone()),
        _ => Some(format!("{} · {:?} · {:?}", agent.path, agent.role, agent.status)),
    };
    st.emit(
        "agent://step",
        AgentStep {
            id: format!("subagent:{}", agent.id),
            kind: StepKind::Subagent,
            run_id: Some(agent.parent_run_id.clone()),
            session_id: Some(agent.root_session_id.clone()),
            title: format!("Agent {}: {:?}", agent.task_name, agent.status),
            detail,
            status,
            started_at: agent.created_at,
            duration_ms: agent
                .status
                .is_final()
                .then(|| agent.updated_at.saturating_sub(agent.created_at) as u64),
            model_id: agent.model_id.clone(),
            tool_name: Some(ToolName::SpawnAgent),
            citations: None,
            error,
        },
    );
}

pub fn persist(st: &AppState, agent: &SubagentInfo) {
    if let Err(error) = st.with_db(|conn| crate::db::upsert_subagent(conn, agent)) {
        st.emit_failure(&error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_stable_and_bounded() {
        assert_eq!(validate_task_name("docs_2").unwrap(), "docs_2");
        assert!(validate_task_name("Docs").is_err());
        assert!(validate_task_name("a/b").is_err());
    }

    #[test]
    fn scope_and_capacity_are_enforced() {
        let control = MultiAgentControl::default();
        let first = control
            .reserve("root-a", "root-a", "run-a", None, "explore", SubagentRole::Explorer, 1, 2)
            .unwrap();
        assert!(control.reserve("root-a", "root-a", "run-a", None, "review", SubagentRole::Reviewer, 1, 2).is_err());
        assert!(control.get(&first.id, "root-b").is_err());
    }
}
