//! Durable harness state: layout, instructions, memories and transcript mirrors.
//!
//! SQLite remains the transactional source of truth. The inspectable files in
//! the sovereign home are a recovery and portability surface, analogous to the
//! generated state under a Codex home directory; they are never credentials and
//! no secret-bearing authentication file is created here.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::error::{CoreError, CoreResult};
use crate::state::{new_id, now_ms, AppState};
use crate::types::*;

const MAX_INSTRUCTIONS: usize = 64 * 1024;
const MAX_MEMORY: usize = 4 * 1024;
const MAX_RAW_MEMORY: usize = 32 * 1024;
const MAX_ROLLOUT_SUMMARY: usize = 64 * 1024;
const PROMPT_MEMORY_BUDGET: usize = 12 * 1024;
const PROMPT_INSTRUCTION_BUDGET: usize = 20 * 1024;

fn tidy(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn safe_id<'a>(id: &'a str, label: &str) -> CoreResult<&'a str> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(CoreError::ExecutionFailed(format!(
            "The {label} id is not a valid harness path component."
        )));
    }
    Ok(id)
}

fn write_if_missing(path: &Path, contents: &str) -> CoreResult<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn ensure_layout() -> CoreResult<()> {
    let root = crate::registry::sovereign_root();
    ensure_layout_at(&root)
}

fn ensure_layout_at(root: &Path) -> CoreResult<()> {
    for dir in [
        "attachments",
        "artifacts",
        "cache",
        "config",
        "knowledge",
        "logs",
        "memories/projects",
        "models",
        "projects",
        "runtime",
        "sandbox",
        "sessions",
        "skills",
        "state",
        "tmp",
    ] {
        fs::create_dir_all(root.join(dir))?;
    }

    write_if_missing(
        &root.join("AGENTS.md"),
        "# Sovereign global instructions\n\n\
         Put durable personal operating preferences here. Project-specific instructions belong in \
         `projects/<workspace-id>/AGENTS.md`. Never put passwords, tokens, private keys, or source \
         document facts in this file.\n",
    )?;
    write_if_missing(
        &root.join("HARNESS.md"),
        "# Sovereign harness home\n\n\
         - `AGENTS.md`: global durable instructions\n\
         - `projects/`: one isolated state directory per approved project\n\
         - `sessions/`: inspectable per-chat JSONL transcript mirrors\n\
         - `memories/`: generated scope folders with `memory_summary.md`, `MEMORY.md`, raw memories, and rollout summaries\n\
         - `artifacts/`: generated deliverables, grouped by chat\n\
         - `state/workbench.db`: transactional application state\n\n\
         SQLite is canonical. Memory Markdown and transcript JSONL files are generated state.\n",
    )?;
    Ok(())
}

fn project_dir(workspace_id: &str) -> CoreResult<PathBuf> {
    let id = safe_id(workspace_id, "workspace")?;
    Ok(crate::registry::sovereign_root().join("projects").join(id))
}

fn project_instructions_path(workspace_id: &str) -> CoreResult<PathBuf> {
    Ok(project_dir(workspace_id)?.join("AGENTS.md"))
}

pub fn ensure_project_layout(workspace: &Workspace) -> CoreResult<()> {
    let dir = project_dir(&workspace.id)?;
    fs::create_dir_all(dir.join("memories"))?;
    fs::create_dir_all(dir.join("artifacts"))?;
    write_if_missing(
        &dir.join("AGENTS.md"),
        &format!(
            "# {} project instructions\n\n\
             Add durable guidance for this project here. These instructions apply only to chats \
             attached to `{}`. Keep source-of-truth engineering facts in project files and indexed \
             documents, not in instructions or memory.\n",
            workspace.name, workspace.path
        ),
    )?;
    write_if_missing(
        &dir.join("project.json"),
        &serde_json::to_string_pretty(&json!({
            "id": workspace.id,
            "name": workspace.name,
            "path": workspace.path,
            "addedAt": workspace.added_at,
        }))?,
    )?;
    Ok(())
}

pub fn info(st: &AppState, workspace_id: Option<&str>) -> CoreResult<HarnessInfo> {
    let root = crate::registry::sovereign_root();
    let settings = st.settings();
    let project_path = match workspace_id {
        Some(id) => {
            let workspace = st.with_db(|c| crate::db::workspace(c, id))?;
            ensure_project_layout(&workspace)?;
            Some(tidy(&project_instructions_path(id)?))
        }
        None => None,
    };
    Ok(HarnessInfo {
        root: tidy(&root),
        sessions_root: tidy(&root.join("sessions")),
        memories_root: settings.memory_root,
        projects_root: tidy(&root.join("projects")),
        global_instructions_path: tidy(&root.join("AGENTS.md")),
        project_instructions_path: project_path,
    })
}

fn instruction_path(scope: MemoryScope, workspace_id: Option<&str>) -> CoreResult<PathBuf> {
    match scope {
        MemoryScope::Global => Ok(crate::registry::sovereign_root().join("AGENTS.md")),
        MemoryScope::Project => project_instructions_path(workspace_id.ok_or_else(|| {
            CoreError::ExecutionFailed(
                "Project instructions need a project, but no workspace was selected.".into(),
            )
        })?),
    }
}

pub fn instructions_get(
    st: &AppState,
    scope: MemoryScope,
    workspace_id: Option<&str>,
) -> CoreResult<InstructionDocument> {
    if let Some(id) = workspace_id {
        let workspace = st.with_db(|c| crate::db::workspace(c, id))?;
        ensure_project_layout(&workspace)?;
    }
    let path = instruction_path(scope, workspace_id)?;
    let content = fs::read_to_string(&path).unwrap_or_default();
    Ok(InstructionDocument {
        scope,
        workspace_id: workspace_id.map(str::to_string),
        path: tidy(&path),
        content,
    })
}

pub fn instructions_set(
    st: &AppState,
    scope: MemoryScope,
    workspace_id: Option<&str>,
    content: String,
) -> CoreResult<InstructionDocument> {
    if content.len() > MAX_INSTRUCTIONS {
        return Err(CoreError::ExecutionFailed(format!(
            "Instructions are limited to {MAX_INSTRUCTIONS} bytes so they cannot crowd the task out of context."
        )));
    }
    if let Some(id) = workspace_id {
        let workspace = st.with_db(|c| crate::db::workspace(c, id))?;
        ensure_project_layout(&workspace)?;
    }
    let path = instruction_path(scope, workspace_id)?;
    fs::write(&path, content.as_bytes())?;
    instructions_get(st, scope, workspace_id)
}

fn read_bounded(path: &Path, budget: usize) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.chars().take(budget).collect())
    }
}

pub fn prompt_instructions(workspace: Option<&Workspace>) -> String {
    let mut sections = Vec::new();
    if let Some(text) = read_bounded(
        &crate::registry::sovereign_root().join("AGENTS.md"),
        PROMPT_INSTRUCTION_BUDGET / 2,
    ) {
        sections.push(format!("Global operator instructions:\n{text}"));
    }
    if let Some(ws) = workspace {
        let _ = ensure_project_layout(ws);
        if let Ok(path) = project_instructions_path(&ws.id) {
            if let Some(text) = read_bounded(&path, PROMPT_INSTRUCTION_BUDGET / 2) {
                sections.push(format!("Project instructions for {}:\n{text}", ws.name));
            }
        }
        // A repository may carry its own more-specific instructions. Nothing is
        // created inside the operator's project; this is read only when present.
        let local = PathBuf::from(&ws.path).join(".sovereign").join("AGENTS.md");
        if let Some(text) = read_bounded(&local, PROMPT_INSTRUCTION_BUDGET / 2) {
            sections.push(format!("Repository-local instructions:\n{text}"));
        }
    }
    sections.join("\n\n")
}

fn validate_memory(input: &MemoryInput) -> CoreResult<()> {
    if input.title.trim().is_empty() || input.content.trim().is_empty() {
        return Err(CoreError::ExecutionFailed(
            "A memory needs both a title and content.".into(),
        ));
    }
    if input.content.len() > MAX_MEMORY {
        return Err(CoreError::ExecutionFailed(format!(
            "One memory is limited to {MAX_MEMORY} bytes. Put long source material in the knowledge base instead."
        )));
    }
    match input.scope {
        MemoryScope::Global if input.workspace_id.is_some() => Err(CoreError::ExecutionFailed(
            "A global memory cannot be attached to one project.".into(),
        )),
        MemoryScope::Project if input.workspace_id.is_none() => Err(CoreError::ExecutionFailed(
            "A project memory needs a selected workspace.".into(),
        )),
        _ => Ok(()),
    }
}

pub(crate) fn looks_secret(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "password",
        "private key",
        "begin rsa private key",
        "begin openssh private key",
        "api_key",
        "api key",
        "access token",
        "refresh token",
        "client secret",
        "bearer ",
        "sk-",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub fn list(st: &AppState, workspace_id: Option<&str>) -> CoreResult<Vec<MemoryEntry>> {
    if let Some(id) = workspace_id {
        st.with_db(|c| crate::db::workspace(c, id))?;
    }
    st.with_db(|c| crate::db::memories_for_context(c, workspace_id, true))
}

pub fn add(st: &AppState, input: MemoryInput) -> CoreResult<MemoryEntry> {
    validate_memory(&input)?;
    if looks_secret(&input.content) {
        return Err(CoreError::Denied(
            "That text looks like a credential or private key, so it was not stored as memory."
                .into(),
        ));
    }
    if let Some(id) = input.workspace_id.as_deref() {
        st.with_db(|c| crate::db::workspace(c, id))?;
    }
    let at = now_ms();
    let entry = MemoryEntry {
        id: new_id("mem"),
        scope: input.scope,
        workspace_id: input.workspace_id,
        title: input.title.trim().chars().take(120).collect(),
        content: input.content.trim().to_string(),
        kind: input.kind,
        source_session_id: input.source_session_id,
        enabled: true,
        created_at: at,
        updated_at: at,
    };
    st.with_db(|c| crate::db::insert_memory(c, &entry))?;
    sync_memory_files(st)?;
    Ok(entry)
}

pub fn update(st: &AppState, id: &str, patch: MemoryPatch) -> CoreResult<MemoryEntry> {
    if patch
        .content
        .as_deref()
        .map(looks_secret)
        .unwrap_or(false)
    {
        return Err(CoreError::Denied(
            "That text looks like a credential or private key, so it was not stored as memory."
                .into(),
        ));
    }
    if patch.content.as_ref().map(|v| v.len() > MAX_MEMORY).unwrap_or(false) {
        return Err(CoreError::ExecutionFailed(format!(
            "One memory is limited to {MAX_MEMORY} bytes."
        )));
    }
    let entry = st.with_db(|c| crate::db::update_memory(c, id, &patch, now_ms()))?;
    sync_memory_files(st)?;
    Ok(entry)
}

pub fn remove(st: &AppState, id: &str) -> CoreResult<()> {
    st.with_db(|c| crate::db::delete_memory(c, id))?;
    sync_memory_files(st)
}

pub fn prompt_memories(st: &AppState, workspace_id: Option<&str>) -> String {
    let settings = st.settings();
    if !settings.use_global_memories && !settings.use_project_memories {
        return String::new();
    }
    let memories = st
        .with_db(|c| crate::db::memories_for_context(c, workspace_id, false))
        .unwrap_or_default();
    let mut out = String::new();
    for memory in memories {
        if matches!(memory.scope, MemoryScope::Global) && !settings.use_global_memories {
            continue;
        }
        if matches!(memory.scope, MemoryScope::Project) && !settings.use_project_memories {
            continue;
        }
        let scope = match memory.scope {
            MemoryScope::Global => "global",
            MemoryScope::Project => "project",
        };
        let line = format!("- [{scope}/{:?}] {}: {}\n", memory.kind, memory.title, memory.content);
        if out.len() + line.len() > PROMPT_MEMORY_BUDGET {
            break;
        }
        out.push_str(&line);
    }
    out
}

pub fn capture_explicit(
    st: &AppState,
    prompt: &str,
    workspace_id: Option<&str>,
    session_id: &str,
) -> CoreResult<Option<MemoryEntry>> {
    if !st.settings().capture_memories {
        return Ok(None);
    }
    let trimmed = prompt.trim();
    let lower = trimmed.to_ascii_lowercase();
    let markers = [
        ("remember globally:", MemoryScope::Global),
        ("remember for all chats:", MemoryScope::Global),
        ("remember for this project:", MemoryScope::Project),
        ("remember for this workspace:", MemoryScope::Project),
    ];
    let mut found = markers
        .iter()
        .find_map(|(marker, scope)| lower.strip_prefix(marker).map(|rest| (*marker, *scope, rest.len())));
    if found.is_none() {
        if let Some(rest) = lower.strip_prefix("remember:") {
            found = Some((
                "remember:",
                if workspace_id.is_some() {
                    MemoryScope::Project
                } else {
                    MemoryScope::Global
                },
                rest.len(),
            ));
        }
    }
    let Some((marker, scope, _)) = found else {
        return Ok(None);
    };
    if matches!(scope, MemoryScope::Project) && workspace_id.is_none() {
        return Ok(None);
    }
    let content = trimmed[marker.len()..].trim();
    if content.len() < 3 || content.len() > MAX_MEMORY || looks_secret(content) {
        return Ok(None);
    }
    let workspace = matches!(scope, MemoryScope::Project)
        .then(|| workspace_id.map(str::to_string))
        .flatten();
    if let Some(existing) = st.with_db(|c| {
        crate::db::memory_by_content(c, scope, workspace.as_deref(), content)
    })? {
        return Ok(Some(existing));
    }
    let title = content
        .lines()
        .next()
        .unwrap_or("Remembered preference")
        .chars()
        .take(80)
        .collect();
    add(
        st,
        MemoryInput {
            scope,
            workspace_id: workspace,
            title,
            content: content.to_string(),
            kind: MemoryKind::Preference,
            source_session_id: Some(session_id.to_string()),
        },
    )
    .map(Some)
}

#[derive(Debug, PartialEq, Eq)]
struct AutomaticMemory {
    title: &'static str,
    content: String,
    kind: MemoryKind,
}

/// Words a personal name never starts or continues with. Everything after one
/// of them is a different clause: `call me if the reactor trips` is an
/// instruction about phone calls, `call me Hari when you are done` is a name
/// followed by one.
///
/// This is the whole difference between the two, because nothing else in the
/// sentence distinguishes them — and getting it wrong wrote "The operator's name
/// is if the reactor trips." into the profile under the stable upsert key
/// `Operator name`, where it went into the system prompt of every later chat in
/// the workspace until someone found it in the memory list and deleted it.
const NOT_NAME_WORDS: &[&str] = &[
    "a", "about", "after", "again", "an", "and", "anytime", "around", "as", "asap", "at",
    "back", "because", "before", "but", "by", "during", "first", "for", "from", "he", "her",
    "here", "him", "his", "if", "immediately", "in", "instead", "it", "its", "later", "me",
    "my", "no", "not", "now", "of", "off", "on", "once", "only", "or", "our", "out", "over",
    "please", "right", "she", "so", "some", "something", "soon", "straight", "that", "the",
    "their", "them", "then", "there", "these", "they", "this", "those", "till", "to", "today",
    "tomorrow", "tonight", "unless", "until", "up", "us", "we", "what", "whatever", "when",
    "whenever", "where", "which", "while", "who", "why", "with", "without", "you", "your",
];

/// Phrasings that put a name in the sentence in order to reject it. `don't call
/// me Sir` is not the operator introducing themselves, and the window is short so
/// an unrelated "not" earlier in the sentence does not suppress a real
/// introduction.
const NAME_NEGATIONS: &[&str] = &["don't ", "dont ", "do not ", "never ", "stop ", "not to "];

/// The name at the start of `clause`, cut at the first word that belongs to the
/// sentence rather than to the name.
///
/// `None` when the clause does not begin with a name at all — which is what
/// `call me back`, `call me at the end` and `call me once you are done` are.
fn leading_name(clause: &str) -> Option<String> {
    let mut words: Vec<&str> = Vec::new();
    for word in clause.split_whitespace() {
        let bare = word.trim_matches(|c: char| !c.is_alphanumeric()).to_ascii_lowercase();
        if NOT_NAME_WORDS.contains(&bare.as_str()) {
            break;
        }
        words.push(word);
        // Four is a long full name and well past a short one; a fifth word means
        // this is a sentence being read as a name.
        if words.len() == 4 {
            break;
        }
    }
    (!words.is_empty()).then(|| words.join(" "))
}

/// Extract only identity statements whose meaning is unambiguous without a
/// model. Automatic memory must be conservative: project documents and casual
/// one-off requests are evidence for the current task, not durable operator
/// profile data.
fn automatic_profile_memory(prompt: &str) -> Option<AutomaticMemory> {
    let lower = prompt.to_ascii_lowercase();
    let markers = [
        "my name is ",
        "you can call me ",
        "please call me ",
        "i go by ",
        "call me ",
    ];

    for marker in markers {
        let Some(start) = lower.find(marker) else {
            continue;
        };
        // `don't call me Sir` puts a name in the sentence in order to refuse
        // it. Only the dozen characters in front of the marker are consulted, so
        // an unrelated "not" earlier in the sentence cannot suppress a real
        // introduction.
        let head = &lower[..start];
        let window: String = head.chars().skip(head.chars().count().saturating_sub(12)).collect();
        if NAME_NEGATIONS.iter().any(|n| window.contains(n)) {
            continue;
        }
        let remainder = &prompt[start + marker.len()..];
        let clause_end = remainder
            .char_indices()
            .find_map(|(index, ch)| {
                matches!(ch, '\n' | '\r' | '.' | ',' | ';' | '!' | '?').then_some(index)
            })
            .unwrap_or(remainder.len());
        let name = remainder[..clause_end]
            .trim()
            .trim_end_matches('.')
            .trim_matches(|ch| matches!(ch, '\'' | '"' | '“' | '”'))
            .trim()
            .to_string();

        // "My name is Hari and I work in inspection" still contains one clear
        // identity fact; the role is deliberately not swept into the memory. Nor
        // is a following clause: "call me Hari when you are done" is a name and an
        // instruction, and "call me if the reactor trips" is only an instruction.
        let Some(name) = leading_name(&name) else {
            continue;
        };

        let lower_name = name.to_ascii_lowercase();
        let rejected = [
            "what",
            "who",
            "unknown",
            "not known",
            "a secret",
            "private",
            "your name",
        ];
        let valid = (2..=80).contains(&name.len())
            && name.split_whitespace().count() <= 4
            && name.chars().any(char::is_alphabetic)
            && name.chars().all(|ch| {
                ch.is_alphabetic()
                    || ch.is_whitespace()
                    || matches!(ch, '-' | '\'' | '’' | '.')
            })
            && !rejected.iter().any(|value| lower_name == *value)
            && !lower_name.starts_with("not ");
        if !valid {
            continue;
        }

        return Some(AutomaticMemory {
            title: "Operator name",
            content: format!("The operator's name is {name}."),
            kind: MemoryKind::Fact,
        });
    }
    None
}

/// Capture clear profile facts without requiring a magic `Remember:` prefix.
/// A project chat writes only to that project's scope; a personal chat writes
/// globally. A stable title acts as an upsert key so a correction replaces the
/// old value instead of injecting two conflicting names into later chats.
pub fn capture_automatic(
    st: &AppState,
    prompt: &str,
    workspace_id: Option<&str>,
    session_id: &str,
) -> CoreResult<Option<MemoryEntry>> {
    if !st.settings().capture_memories {
        return Ok(None);
    }
    let Some(candidate) = automatic_profile_memory(prompt) else {
        return Ok(None);
    };
    if looks_secret(&candidate.content) {
        return Ok(None);
    }

    store_automatic(
        st,
        candidate.title,
        &candidate.content,
        candidate.kind,
        workspace_id,
        session_id,
    )
}

/// Store one memory selected by the local memory curator. Scope is fixed by the
/// current chat rather than accepted from model output, so a project turn can
/// never write into global memory or another project. Title is the semantic
/// upsert key: a later decision can refine "Project purpose" without leaving a
/// stale, contradictory version beside it.
pub fn store_automatic(
    st: &AppState,
    title: &str,
    content: &str,
    kind: MemoryKind,
    workspace_id: Option<&str>,
    session_id: &str,
) -> CoreResult<Option<MemoryEntry>> {
    if !st.settings().capture_memories {
        return Ok(None);
    }
    let title = title.trim();
    let content = content.trim();
    if title.is_empty()
        || content.len() < 3
        || title.len() > 120
        || content.len() > MAX_MEMORY
        || looks_secret(content)
    {
        return Ok(None);
    }

    let scope = if workspace_id.is_some() {
        MemoryScope::Project
    } else {
        MemoryScope::Global
    };
    let workspace = workspace_id.map(str::to_string);
    if let Some(existing) = st.with_db(|c| {
        crate::db::memory_by_title(c, scope, workspace.as_deref(), title)
    })? {
        if existing.content.eq_ignore_ascii_case(content)
            && existing.kind == kind
            && existing.enabled
        {
            return Ok(Some(existing));
        }
        return update(
            st,
            &existing.id,
            MemoryPatch {
                content: Some(content.to_string()),
                kind: Some(kind),
                enabled: Some(true),
                source_session_id: Some(session_id.to_string()),
                ..Default::default()
            },
        )
        .map(Some);
    }

    add(
        st,
        MemoryInput {
            scope,
            workspace_id: workspace,
            title: title.to_string(),
            content: content.to_string(),
            kind,
            source_session_id: Some(session_id.to_string()),
        },
    )
    .map(Some)
}

fn rollout_slug(value: &str, session_id: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            separator = false;
        } else if matches!(ch, '-' | '_' | ' ' | '/' | '\\') && !separator && !out.is_empty() {
            out.push('-');
            separator = true;
        }
        if out.len() >= 80 {
            break;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        format!("chat-{}", safe_id(session_id, "session").unwrap_or("memory"))
    } else {
        trimmed.to_string()
    }
}

/// Persist the per-chat, Phase-1 memory artifact before its high-signal items
/// are consolidated into prompt-ready memories. The transcript remains the
/// immutable evidence; this row is a replaceable, inspectable distillation.
pub fn store_memory_rollout(
    st: &AppState,
    workspace_id: Option<&str>,
    session_id: &str,
    source_updated_at: i64,
    raw_memory: &str,
    rollout_summary: &str,
    slug: &str,
) -> CoreResult<bool> {
    let raw_memory = raw_memory.trim();
    let rollout_summary = rollout_summary.trim();
    if raw_memory.is_empty() && rollout_summary.is_empty() {
        return Ok(false);
    }
    if raw_memory.len() > MAX_RAW_MEMORY || rollout_summary.len() > MAX_ROLLOUT_SUMMARY {
        return Err(CoreError::ExecutionFailed(
            "The local memory curator produced an oversized rollout summary, so it was not stored."
                .into(),
        ));
    }
    if looks_secret(raw_memory) || looks_secret(rollout_summary) {
        return Err(CoreError::Denied(
            "The local memory curator output looked credential-bearing, so the entire rollout memory was discarded."
                .into(),
        ));
    }
    let session = st.with_db(|c| crate::db::session(c, session_id))?;
    if session.workspace_id.as_deref() != workspace_id {
        return Err(CoreError::Denied(
            "The memory rollout scope did not match its chat, so it was not stored.".into(),
        ));
    }
    let row = crate::db::MemoryRollout {
        session_id: safe_id(session_id, "session")?.to_string(),
        workspace_id: workspace_id.map(str::to_string),
        source_updated_at,
        raw_memory: raw_memory.to_string(),
        rollout_summary: rollout_summary.to_string(),
        rollout_slug: rollout_slug(slug, session_id),
        generated_at: now_ms(),
    };
    st.with_db(|c| crate::db::upsert_memory_rollout(c, &row))?;
    sync_memory_files(st)?;
    Ok(true)
}

fn memory_markdown(title: &str, rows: &[MemoryEntry]) -> String {
    let mut out = format!("# {title}\n\nGenerated from the Sovereign memory store.\n\n");
    for row in rows {
        let state = if row.enabled { "active" } else { "disabled" };
        out.push_str(&format!(
            "## {}\n\n- Kind: `{:?}`\n- State: `{state}`\n- Updated: `{}`\n\n{}\n\n",
            row.title, row.kind, row.updated_at, row.content
        ));
    }
    out
}

fn memory_summary_markdown(rows: &[MemoryEntry]) -> String {
    let active = rows.iter().filter(|row| row.enabled).collect::<Vec<_>>();
    let mut out = String::from("v1\n\n## User Profile\n\n");
    for row in active.iter().filter(|row| {
        matches!(row.kind, MemoryKind::Fact | MemoryKind::Summary)
    }) {
        out.push_str(&format!("- {}\n", row.content));
    }
    out.push_str("\n## User preferences\n\n");
    for row in active
        .iter()
        .filter(|row| matches!(row.kind, MemoryKind::Preference))
    {
        out.push_str(&format!("- {}\n", row.content));
    }
    out.push_str("\n## General Tips\n\n");
    for row in active.iter().filter(|row| {
        matches!(row.kind, MemoryKind::Instruction | MemoryKind::Decision)
    }) {
        out.push_str(&format!("- {}\n", row.content));
    }
    out.push_str("\n## What's in Memory\n\n");
    for row in active {
        out.push_str(&format!("- {}: `{:?}`\n", row.title, row.kind));
    }
    out
}

fn raw_memories_markdown(rows: &[crate::db::MemoryRollout]) -> String {
    let mut out = String::from(
        "# Raw Memories\n\nGenerated Phase-1 memory, newest first. Transcripts remain the evidence.\n\n",
    );
    for row in rows {
        out.push_str(&format!(
            "## Chat `{}`\n\n- updated_at: `{}`\n- workspace_id: `{}`\n- rollout_summary_file: `rollout_summaries/{}.md`\n\n{}\n\n",
            row.session_id,
            row.source_updated_at,
            row.workspace_id.as_deref().unwrap_or("global"),
            row.session_id,
            row.raw_memory,
        ));
    }
    out
}

fn sync_scope_files(
    dir: &Path,
    title: &str,
    memories: &[MemoryEntry],
    rollouts: &[crate::db::MemoryRollout],
) -> CoreResult<()> {
    fs::create_dir_all(dir.join("rollout_summaries"))?;
    fs::write(dir.join("MEMORY.md"), memory_markdown(title, memories))?;
    fs::write(
        dir.join("memory_summary.md"),
        memory_summary_markdown(memories),
    )?;
    fs::write(
        dir.join("raw_memories.md"),
        raw_memories_markdown(rollouts),
    )?;
    for rollout in rollouts {
        let session = safe_id(&rollout.session_id, "session")?;
        let body = format!(
            "# {}\n\n- Session: `{}`\n- Updated: `{}`\n- Generated: `{}`\n\n{}\n",
            rollout.rollout_slug,
            rollout.session_id,
            rollout.source_updated_at,
            rollout.generated_at,
            rollout.rollout_summary,
        );
        fs::write(
            dir.join("rollout_summaries").join(format!("{session}.md")),
            body,
        )?;
    }
    Ok(())
}

pub fn sync_memory_files(st: &AppState) -> CoreResult<()> {
    // §16 at-rest vault: while the vault is enabled, no plaintext mirror is
    // written. The database is authoritative and every file this function would
    // produce is a human-readable copy of it; the vault seals the copies that
    // already exist, so writing fresh ones in clear text would defeat it. The
    // next sync after a disable rebuilds the full set from the database.
    if crate::vault::is_enabled() {
        return Ok(());
    }
    let root = PathBuf::from(st.settings().memory_root);
    fs::create_dir_all(root.join("projects"))?;
    let global = st.with_db(|c| crate::db::memories_by_scope(c, MemoryScope::Global, None))?;
    fs::write(root.join("global.md"), memory_markdown("Global memories", &global))?;
    let global_rollouts = st.with_db(|c| crate::db::memory_rollouts_by_scope(c, None))?;
    sync_scope_files(&root.join("global"), "Global memories", &global, &global_rollouts)?;
    for workspace in st.with_db(crate::db::workspaces)? {
        let rows = st.with_db(|c| {
            crate::db::memories_by_scope(c, MemoryScope::Project, Some(&workspace.id))
        })?;
        let rollouts =
            st.with_db(|c| crate::db::memory_rollouts_by_scope(c, Some(&workspace.id)))?;
        fs::write(
            root.join("projects").join(format!("{}.md", safe_id(&workspace.id, "workspace")?)),
            memory_markdown(&format!("{} project memories", workspace.name), &rows),
        )?;
        sync_scope_files(
            &root.join("projects").join(safe_id(&workspace.id, "workspace")?),
            &format!("{} project memories", workspace.name),
            &rows,
            &rollouts,
        )?;
    }
    Ok(())
}

/// Removes the generated transcript mirror for a chat whose canonical database
/// row has been deleted. The validated id keeps the recursive target confined to
/// the harness' `sessions` directory.
pub fn remove_session_mirror(session_id: &str) -> CoreResult<()> {
    let id = safe_id(session_id, "session")?;
    let dir = crate::registry::sovereign_root().join("sessions").join(id);
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    Ok(())
}

/// Removes generated project metadata while deliberately retaining `files/` and
/// `artifacts/`. Managed project source files and every externally attached
/// folder stay on disk.
///
/// `artifacts/` is not a mirror and is never removed. It holds what the runs in
/// this project produced — the verified .xlsx inspection tables, the .docx
/// reports, the .pdf deliverables — and those are the operator's work, not
/// regenerable state. Removing a project from the sidebar withdraws the
/// application's access to a folder; it must not be the gesture that destroys
/// every file the application made in it, least of all through `remove_dir_all`,
/// which does not use the recycle bin.
///
/// What does go: the memory mirror under `memory_root/projects`, `AGENTS.md`,
/// `project.json` and `memories/` — every one of them written by this
/// application from state that lives in the database.
pub fn remove_project_mirrors(st: &AppState, workspace_id: &str) -> CoreResult<()> {
    let id = safe_id(workspace_id, "workspace")?;
    let memory_root = PathBuf::from(st.settings().memory_root).join("projects");
    // The sealed form of the top-level mirror is `<id>.md.vault`; a project
    // removed while the vault is enabled leaves only that, so both the
    // plaintext and the envelope must go. The directory form (`<id>/`, holding
    // MEMORY.md, rollout_summaries/, …) is removed whole, sealed envelopes
    // included.
    for path in [
        memory_root.join(format!("{id}.md")),
        memory_root.join(format!("{id}.md.vault")),
        memory_root.join(id),
    ] {
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else if path.exists() {
            fs::remove_file(path)?;
        }
    }

    let project = crate::registry::sovereign_root().join("projects").join(id);
    for file in [project.join("AGENTS.md"), project.join("project.json")] {
        if file.exists() {
            fs::remove_file(file)?;
        }
    }
    let memories = project.join("memories");
    if memories.exists() {
        fs::remove_dir_all(memories)?;
    }
    // External-folder projects leave an empty metadata directory; a project that
    // still holds `files/` or `artifacts/` does not, so this succeeds only in the
    // safe case.
    let _ = fs::remove_dir(&project);
    Ok(())
}

pub fn set_session_memory(
    st: &AppState,
    session_id: &str,
    use_memories: bool,
    contribute_memories: bool,
) -> CoreResult<StoredSession> {
    st.with_db(|c| {
        crate::db::set_session_memory(c, session_id, use_memories, contribute_memories)?;
        crate::db::session(c, session_id)
    })
}

pub fn append_session_message(
    session_id: &str,
    workspace_id: Option<&str>,
    message: &StoredMessage,
) -> CoreResult<()> {
    let id = safe_id(session_id, "session")?;
    let dir = crate::registry::sovereign_root().join("sessions").join(id);
    fs::create_dir_all(&dir)?;
    write_if_missing(
        &dir.join("metadata.json"),
        &serde_json::to_string_pretty(&json!({
            "sessionId": session_id,
            "workspaceId": workspace_id,
        }))?,
    )?;
    // §16 at-rest vault: the transcript mirror is confidential and must not be
    // appended to in clear text while the vault is enabled. The canonical row is
    // in the database; this mirror is rebuilt from it by the sync that follows a
    // disable. `metadata.json` above stays — it holds only ids.
    if crate::vault::is_enabled() {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("transcript.jsonl"))?;
    serde_json::to_writer(&mut file, message)?;
    file.write_all(b"\n")?;
    file.flush()?;
    Ok(())
}

/// Rewrites a chat's JSONL transcript mirror to match its retained database
/// rows, oldest first.
///
/// The mirror is a generated convenience copy — the database is canonical — so
/// when a conversation is truncated from the middle (an edited message and
/// everything after it), the mirror is rebuilt rather than played append-only:
/// a stale tail would describe a conversation that no longer exists. Editing
/// while the vault seals the mirror leaves the sealed copy untouched, exactly
/// as append does; the next disable rebuilds every mirror from the database.
pub fn rewrite_session_mirror(session_id: &str, messages: &[StoredMessage]) -> CoreResult<()> {
    let id = safe_id(session_id, "session")?;
    let dir = crate::registry::sovereign_root().join("sessions").join(id);
    if !dir.exists() {
        // Nothing was ever mirrored (the chat may have begun while the vault
        // was on); there is nothing to rewrite, and creating an empty file
        // would only add a mirror that never earned one.
        return Ok(());
    }
    if crate::vault::is_enabled() {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(dir.join("transcript.jsonl"))?;
    for message in messages {
        serde_json::to_writer(&mut file, message)?;
        file.write_all(b"\n")?;
    }
    file.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_start_builds_the_complete_harness_contract() {
        let root = std::env::temp_dir().join(format!("sovereign-harness-test-{}", new_id("root")));
        ensure_layout_at(&root).expect("the harness layout is created");
        for relative in [
            "AGENTS.md",
            "HARNESS.md",
            "artifacts",
            "config",
            "knowledge",
            "memories/projects",
            "projects",
            "sandbox",
            "sessions",
            "state",
        ] {
            assert!(root.join(relative).exists(), "{relative} is part of the first-start contract");
        }
        std::fs::remove_dir_all(&root).expect("the test owns and removes its temporary harness");
    }

    #[test]
    fn path_ids_cannot_escape_the_harness() {
        assert!(safe_id("sess-123_ok", "session").is_ok());
        assert!(safe_id("../outside", "session").is_err());
        assert!(safe_id("folder/name", "workspace").is_err());
    }

    #[test]
    fn credentials_are_not_memory_material() {
        assert!(looks_secret("API key: sk-example"));
        assert!(looks_secret("password = operator-secret"));
        assert!(!looks_secret("Prefer concise inspection summaries"));
    }

    #[test]
    fn a_natural_name_statement_becomes_a_profile_fact() {
        let remembered = automatic_profile_memory("Hi, my name is Hari Haran. Nice to meet you")
            .expect("a direct identity statement is durable profile data");
        assert_eq!(remembered.title, "Operator name");
        assert_eq!(remembered.kind, MemoryKind::Fact);
        assert_eq!(remembered.content, "The operator's name is Hari Haran.");
    }

    #[test]
    fn a_name_can_be_given_in_the_other_common_forms() {
        assert_eq!(
            automatic_profile_memory("You can call me Hari").unwrap().content,
            "The operator's name is Hari."
        );
        assert_eq!(
            automatic_profile_memory("I go by Hari and I prefer concise answers")
                .unwrap()
                .content,
            "The operator's name is Hari."
        );
    }

    #[test]
    fn questions_and_ambiguous_identity_text_are_not_memories() {
        assert!(automatic_profile_memory("What is my name?").is_none());
        assert!(automatic_profile_memory("My name is unknown").is_none());
        assert!(automatic_profile_memory("I am working on a name field").is_none());
    }

    /// "Call me" is also how a person asks to be contacted. Storing the rest of
    /// that sentence as their name put it into the system prompt of every later
    /// chat, under a stable upsert key, until someone deleted it by hand.
    #[test]
    fn an_instruction_about_being_contacted_is_not_a_name() {
        for prompt in [
            "call me if the reactor trips",
            "Call me back when the run finishes",
            "call me at the end of the batch",
            "call me once you are done",
            "call me tomorrow about the shutdown",
            "please call me later",
            "I go by the numbers, not by feel",
        ] {
            assert!(
                automatic_profile_memory(prompt).is_none(),
                "{prompt:?} was stored as an operator name"
            );
        }
    }

    /// A name followed by an instruction is still a name — the clause is cut off
    /// rather than the whole statement thrown away.
    #[test]
    fn a_name_is_cut_at_the_clause_that_follows_it() {
        assert_eq!(
            automatic_profile_memory("call me Hari when you are done").unwrap().content,
            "The operator's name is Hari."
        );
        assert_eq!(
            automatic_profile_memory("My name is Hari Haran and I work in inspection")
                .unwrap()
                .content,
            "The operator's name is Hari Haran."
        );
    }

    /// A sentence that names something in order to reject it is not an
    /// introduction.
    #[test]
    fn a_refusal_of_a_name_is_not_an_introduction() {
        assert!(automatic_profile_memory("don't call me Sir").is_none());
        assert!(automatic_profile_memory("Please do not call me Boss").is_none());
        // An unrelated negation earlier in the sentence still leaves a real
        // introduction standing.
        assert_eq!(
            automatic_profile_memory("I am not in the office today, my name is Hari")
                .unwrap()
                .content,
            "The operator's name is Hari."
        );
    }

    #[test]
    fn rollout_slugs_are_stable_safe_path_components() {
        assert_eq!(
            rollout_slug("  OCR project / inspection workflow  ", "sess-1"),
            "ocr-project-inspection-workflow"
        );
        assert_eq!(rollout_slug("../../", "sess-1"), "chat-sess-1");
    }

    #[test]
    fn staged_memory_files_are_inspectable_and_prompt_summary_is_versioned() {
        let root = std::env::temp_dir().join(format!("sovereign-memory-test-{}", new_id("root")));
        let memory = MemoryEntry {
            id: "mem-1".into(),
            scope: MemoryScope::Project,
            workspace_id: Some("alpha".into()),
            title: "Project purpose".into(),
            content: "Build the local OCR workstation.".into(),
            kind: MemoryKind::Summary,
            source_session_id: Some("sess-1".into()),
            enabled: true,
            created_at: 1,
            updated_at: 2,
        };
        let rollout = crate::db::MemoryRollout {
            session_id: "sess-1".into(),
            workspace_id: Some("alpha".into()),
            source_updated_at: 2,
            raw_memory: "The operator defined the project purpose.".into(),
            rollout_summary: "Project purpose was established.".into(),
            rollout_slug: "project-purpose".into(),
            generated_at: 3,
        };

        sync_scope_files(&root, "Alpha memories", &[memory], &[rollout])
            .expect("generated memory mirrors are written");
        assert!(root.join("MEMORY.md").is_file());
        assert!(root.join("raw_memories.md").is_file());
        assert!(root.join("rollout_summaries/sess-1.md").is_file());
        assert!(
            fs::read_to_string(root.join("memory_summary.md"))
                .unwrap()
                .starts_with("v1\n"),
            "the always-loaded summary has an explicit schema version"
        );
        fs::remove_dir_all(root).expect("the test owns its temporary memory folder");
    }
}
