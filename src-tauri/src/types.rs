//! The Rust half of the contract in `src/types/index.ts`.
//!
//! Field names are camelCase on the wire because that is what the TypeScript
//! side declares; `rename_all` handles it rather than Rust-side camelCase.
//!
//! Optional fields use `skip_serializing_if` so an absent value arrives as
//! `undefined` and not `null`. That distinction is load-bearing in at least one
//! place: `DocBlock.confidence` is absent when extraction was native, because
//! there is no score to report, and the viewer keys its confidence column off
//! `!== undefined`. Sending `null` would print a column with nothing in it.

use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------------ */
/* §11  Sovereignty                                                    */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SovereignStatus {
    /// The operator account this instance runs as (`DOMAIN\user`). Shown on
    /// the Sovereignty panel so the operator sees, up front, whose account the
    /// audit trail will attribute work to.
    pub operator: String,
    pub public_internet_bytes: u64,
    pub private_server_bytes: u64,
    pub device_requests: u64,
    pub private_server_requests: u64,
    pub egress_blocked: bool,
    /// `string | null` in TS, so this one is deliberately not skipped.
    pub private_server_name: Option<String>,
}

/* ------------------------------------------------------------------ */
/* §1 / §2  Models                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelCapability {
    General,
    Reasoning,
    Coding,
    Vision,
    Ocr,
    Handwriting,
    Documents,
    Drawings,
    Embeddings,
    LongContext,
    Tools,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ModelBackend {
    #[serde(rename = "llama.cpp")]
    LlamaCpp,
    #[serde(rename = "python")]
    Python,
    #[serde(rename = "private_endpoint")]
    PrivateEndpoint,
}

/// Never `cloud`. The type system is the first place that guarantee lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelLocation {
    ThisDevice,
    PrivateServer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelState {
    Unloaded,
    Loading,
    Loaded,
    Unloading,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelPriority {
    Primary,
    Fallback,
    Specialist,
    Disabled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEntry {
    pub id: String,
    pub display_name: String,
    pub backend: ModelBackend,
    pub location: ModelLocation,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projector: Option<String>,
    pub architecture: String,
    pub quantization: String,
    pub context_size: u32,
    pub trained_context: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kv_cache_type: Option<String>,
    pub capabilities: Vec<ModelCapability>,
    pub estimated_vram_mb: u32,
    pub file_size_bytes: u64,
    pub priority: ModelPriority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt_tokens_per_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gen_tokens_per_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// Extra `llama-server` preset keys for this model, written verbatim into
    /// the generated `models.ini`. This is the escape hatch that keeps runtime
    /// tuning out of the code: `image-min-tokens`, `pooling`, `cache-type-k`,
    /// anything the server accepts. A `BTreeMap` so the generated INI is byte
    /// stable and does not churn between runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_options: Option<std::collections::BTreeMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRuntime {
    pub id: String,
    pub state: ModelState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub load_time_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resident_vram_mb: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tokens_per_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<i64>,
}

impl ModelRuntime {
    pub fn unloaded(id: &str) -> Self {
        Self {
            id: id.to_string(),
            state: ModelState::Unloaded,
            load_time_ms: None,
            resident_vram_mb: None,
            last_tokens_per_sec: None,
            last_error: None,
            last_used_at: None,
        }
    }
}

/* ------------------------------------------------------------------ */
/* §2  Hardware                                                        */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareStatus {
    pub gpu_name: String,
    pub vram_used_mb: u32,
    pub vram_total_mb: u32,
    pub vram_budget_mb: u32,
    pub gpu_util_pct: u32,
    pub cpu_name: String,
    pub cpu_util_pct: u32,
    pub ram_used_mb: u32,
    pub ram_total_mb: u32,
    pub offloading: bool,
}

/* ------------------------------------------------------------------ */
/* §6  Agent                                                           */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentMode {
    Plan,
    Agent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepKind {
    Planning,
    SelectingModel,
    LoadingModel,
    ReadingFile,
    SearchingFiles,
    SearchingKnowledge,
    Ocr,
    Vision,
    RunningPython,
    RunningCommand,
    StartingServer,
    EditingFile,
    WritingFile,
    GeneratingArtifact,
    Verifying,
    AwaitingApproval,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Running,
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStep {
    pub id: String,
    pub kind: StepKind,
    /// The run and chat this step belongs to. `None` on steps emitted outside
    /// any run (a user-initiated document ingest, knowledge indexing), which is
    /// what lets the UI keep several concurrent chats' timelines separate
    /// instead of merging every step into whichever buffer happens to be open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// A one-line action summary. Never raw chain-of-thought: reasoning arrives
    /// in its own field and is never concatenated into a step. It reaches the
    /// operator as a `Thinking` run-text only when Extended Thinking is on.
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub status: StepStatus,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<ToolName>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub citations: Option<Vec<Citation>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/* ------------------------------------------------------------------ */
/* §7  Tools                                                           */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolName {
    ListFiles,
    ReadFile,
    SearchFiles,
    WriteFile,
    EditFile,
    CreateDirectory,
    OcrDocument,
    AnalyzeImage,
    QueryKnowledge,
    ExecutePython,
    RunCommand,
    ReadSpreadsheet,
    WriteSpreadsheet,
    GenerateDocx,
    GenerateXlsx,
    GeneratePptx,
    GeneratePdf,
    GenerateText,
    AnalyzeData,
    InspectArtifact,
    WebSearch,
    WebFetch,
    McpListTools,
    McpCall,
    UpdatePlan,
    AskOperator,
    ServeFolder,
    StartDevServer,
    CheckPage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolRisk {
    Read,
    Write,
    Execute,
    Destructive,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub tool: ToolName,
    pub args_summary: String,
    /// 'ok' | 'denied' | 'failed'
    pub status: String,
    pub started_at: i64,
    pub duration_ms: u64,
    pub workspace_id: String,
    /// The operator account whose action this row records — the Windows
    /// `DOMAIN\user` the instance runs as. `None` only for rows written before
    /// the column existed; everything since is attributable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub operator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/* ------------------------------------------------------------------ */
/* §9  Permissions                                                     */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowSession,
    Reject,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalPolicy {
    AskAlways,
    AskRiskyOnly,
    /// Full autonomy inside the sandbox: writes, generators and allow-listed
    /// commands all proceed. Only destructive work still asks. The allow-list
    /// and the workspace containment are what make this a bounded level
    /// rather than an unbounded one — the agent can build freely but cannot
    /// reach past the workspace or the sandbox command list.
    AutoRunSandbox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    /// The run that is asking. A second concurrent chat's Stop must not
    /// answer — or cancel — this run's prompt, so the request names its run
    /// and `cancel_run` only rejects its own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    pub tool: ToolName,
    pub title: String,
    pub rationale: String,
    pub risk: ToolRisk,
    pub target: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    pub workspace_id: String,
    pub created_at: i64,
}

/* ------------------------------------------------------------------ */
/* §9  Mid-run operator questions                                      */
/* ------------------------------------------------------------------ */

/// A free-text question the agent is blocked on, asked through the
/// `ask_operator` tool. Unlike a permission prompt there is no allow/reject:
/// the *answer* is the result the model asked for, so the UI is a text box,
/// not three buttons. Cancel still resolves it — with a "cancelled" reply the
/// model can react to instead of hanging forever.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OperatorQuestion {
    pub id: String,
    /// The run that asked; the answer is routed back to exactly that run.
    pub run_id: String,
    pub session_id: String,
    /// The question, in the model's own words, as the operator should read it.
    pub question: String,
    /// What the model was doing when it decided it could not proceed without
    /// asking — context for a person who just opened the app.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    pub created_at: i64,
}

/* ------------------------------------------------------------------ */
/* §8  Sandbox                                                         */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxPolicy {
    pub working_dir: String,
    pub network_enabled: bool,
    pub timeout_sec: u32,
    pub max_memory_mb: u32,
    pub max_processes: u32,
    pub allowed_commands: Vec<String>,
    pub denied_commands: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxRun {
    pub id: String,
    pub command: String,
    pub cwd: String,
    /// 'running' | 'exited' | 'killed' | 'timeout' | 'denied'
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    pub output: Vec<SandboxLine>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxLine {
    /// 'stdout' | 'stderr' | 'system'
    pub stream: String,
    pub text: String,
    pub at: i64,
}

/// `sandbox://line` carries the run id alongside the line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxLineEvent {
    pub run_id: String,
    pub stream: String,
    pub text: String,
    pub at: i64,
    /// The agent run and chat this command belongs to, when a tool call
    /// started it rather than the operator's console. Lets the line stream
    /// into the chat timeline as well as the console.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/* ------------------------------------------------------------------ */
/* §4  Documents                                                       */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DocumentKind {
    PdfDigital,
    PdfScanned,
    Docx,
    Xlsx,
    Pptx,
    Text,
    Markdown,
    SourceCode,
    Image,
    Photograph,
    Handwriting,
    Drawing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExtractionMethod {
    Native,
    Ocr,
    Vision,
    Pending,
}

/// Normalised 0..1 so overlays survive any zoom level.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoundingBox {
    pub page: u32,
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    Text,
    Heading,
    Table,
    Figure,
    Tag,
    Handwriting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocBlock {
    pub id: String,
    pub kind: BlockKind,
    pub text: String,
    pub bbox: BoundingBox,
    /// Absent for native extraction — there is no score to report.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocTable {
    pub id: String,
    pub page: u32,
    pub bbox: BoundingBox,
    pub header: Vec<String>,
    pub rows: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngestedDocument {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub kind: DocumentKind,
    pub page_count: u32,
    pub extraction: ExtractionMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    pub blocks: Vec<DocBlock>,
    pub tables: Vec<DocTable>,
    pub entities: Vec<String>,
    pub size_bytes: u64,
    pub sha256: String,
    pub ingested_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_uri: Option<String>,
}

/* ------------------------------------------------------------------ */
/* §5  Knowledge                                                       */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IndexStatus {
    Queued,
    Indexing,
    Indexed,
    Failed,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub kind: DocumentKind,
    pub chunks: u32,
    pub size_bytes: u64,
    pub sha256: String,
    pub status: IndexStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeIndexStats {
    pub documents: u32,
    pub chunks: u32,
    pub index_bytes: u64,
    pub embedding_model_id: String,
    pub embedding_dim: u32,
    pub watching: bool,
    /// The folders being watched, when `watching` is set. Named so the panel can
    /// say which ones rather than implying it is all of them.
    pub watched_folders: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_indexed_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Citation {
    /// The indexed source this passage came from — a `KnowledgeSource` id, not an
    /// `IngestedDocument` id. The two stores are separate: a file can be
    /// searchable without its layout ever having been extracted, so anything that
    /// wants to show the page goes through `path`.
    pub doc_id: String,
    pub path: String,
    pub file_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox: Option<BoundingBox>,
    pub snippet: String,
    pub score: f32,
}

/* ------------------------------------------------------------------ */
/* §10  Artifacts                                                      */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    Docx,
    Xlsx,
    Pptx,
    Pdf,
    Markdown,
    Text,
    Code,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub kind: ArtifactKind,
    pub size_bytes: u64,
    pub created_at: i64,
    pub source_task: String,
    pub source_document_ids: Vec<String>,
    pub producing_model_id: String,
    pub tool_history: Vec<ToolName>,
    /// Project and chat that produced the file. Both are optional so artifacts
    /// created by a direct tool call still have an honest provenance record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Only true after the file was reopened and parsed successfully.
    pub verified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verify_note: Option<String>,
}

/* ------------------------------------------------------------------ */
/* Workspaces, files, changes                                          */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    /// The primary attached folder. Older callers continue to use this field.
    pub path: String,
    pub folders: Vec<WorkspaceFolder>,
    pub approved: bool,
    pub pinned: bool,
    pub archived: bool,
    pub added_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFolder {
    pub id: String,
    pub path: String,
    pub is_primary: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceUpdate {
    pub name: String,
    pub folders: Vec<WorkspaceFolder>,
    pub pinned: bool,
    pub archived: bool,
}

/* ------------------------------------------------------------------ */
/* Harness memory and durable instructions                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryScope {
    Global,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryKind {
    Preference,
    Instruction,
    Decision,
    Fact,
    Summary,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntry {
    pub id: String,
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub title: String,
    pub content: String,
    pub kind: MemoryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    pub enabled: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub scope: MemoryScope,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub title: String,
    pub content: String,
    pub kind: MemoryKind,
    #[serde(default)]
    pub source_session_id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPatch {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub kind: Option<MemoryKind>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub source_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    pub root: String,
    pub sessions_root: String,
    pub memories_root: String,
    pub projects_root: String,
    pub global_instructions_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_instructions_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstructionDocument {
    pub scope: MemoryScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    pub path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub size_bytes: u64,
    pub modified_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed: Option<bool>,
}

/// Bytes and metadata for the in-workbench file viewer.
///
/// The content is optional because sending a very large file through IPC would
/// duplicate it several times in memory.  The viewer still opens the tab and
/// shows the honest metadata in that case.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    pub path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub modified_at: i64,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_base64: Option<String>,
    pub too_large: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    /// 'modified' | 'created' | 'deleted'
    pub status: String,
    pub additions: u32,
    pub deletions: u32,
    pub old_content: String,
    pub new_content: String,
    pub applied: bool,
    /// What the run had actually read when it produced these bytes: the files,
    /// documents and queries whose results reached the model first.
    ///
    /// Empty means the contents are the model's own invention. That is a normal
    /// thing for a script or a scaffold and a serious thing for anything stating
    /// a thickness, a limit, a date or an equipment number, so the review panel
    /// says which of the two it is looking at rather than leaving the operator to
    /// assume. `default` because a change queued before this field existed was
    /// not, by that fact, a grounded one.
    #[serde(default)]
    pub grounding: Vec<String>,
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /* Runtime */
    pub llama_server_path: String,
    pub model_preset_path: String,
    pub models_directory: String,
    /// The port the router listens on. There is no host setting: see
    /// `registry::ROUTER_BIND_HOST`.
    pub router_port: u16,
    pub max_resident_models: u32,
    pub model_idle_evict_sec: u32,
    pub extended_thinking: bool,

    /* Sovereignty */
    pub allow_private_server: bool,
    pub private_server_url: String,
    pub private_server_name: String,
    pub block_public_internet: bool,
    /// §11 — override for the replicated-store lock. Default off: when an
    /// app-owned store folder replicates off this machine, agent work is
    /// refused until the folder is local again. Turning this on lets work
    /// proceed anyway; every such start is recorded to the append-only
    /// `store_gate` table with the operator's name on it, which is the point —
    /// the override exists to be audited, not to be quiet.
    #[serde(default)]
    pub allow_replicated_store: bool,

    /* Optional integrations */
    pub web_search_mode: WebSearchMode,
    pub web_search_provider: WebSearchProvider,
    pub web_search_api_key_env: String,
    pub mcp_servers: Vec<McpServerConfig>,

    /* Agent */
    pub default_mode: AgentMode,
    pub approval_policy: ApprovalPolicy,
    /// Operator-authored safety rules. Empty by default — the built-in
    /// workspace containment and sandbox allow-list are always on; these are
    /// the operator's own hard stops on top of both.
    #[serde(default)]
    pub guard_rules: Vec<GuardRuleEntry>,

    /* Sandbox */
    pub sandbox_root: String,
    pub sandbox_network: bool,
    pub sandbox_timeout_sec: u32,
    pub sandbox_max_memory_mb: u32,

    /* Knowledge */
    pub knowledge_root: String,
    pub watch_knowledge_folder: bool,
    pub retrieval_top_k: u32,
    pub hybrid_retrieval: bool,

    /* Memories */
    pub memory_root: String,
    pub use_global_memories: bool,
    pub use_project_memories: bool,
    pub capture_memories: bool,

    /* Artifacts */
    pub artifact_root: String,
    pub verify_artifacts: bool,

    /* UI */
    pub show_right_panel: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchMode {
    Disabled,
    Direct,
    Provider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchProvider {
    Brave,
    Tavily,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub enabled: bool,
}

/* ------------------------------------------------------------------ */
/* Operator-authored safety guardrails                                 */
/* ------------------------------------------------------------------ */

/// One operator-authored safety rule. Rules are hard stops: a tool call that
/// matches is refused with the rule's name, before any approval prompt and
/// before anything runs — they sit *under* the approval system, not beside
/// it, so neither an allow-session grant nor an operator click can waive one.
///
/// Two kinds, because the two ways a run destroys things are different:
/// - `ProtectPath` refuses any write whose resolved target lies under the
///   given folder (prefix match, case-insensitive, on a separator boundary —
///   `C:/project` protects the folder, not a file named `project2`).
/// - `ForbidCommand` refuses a command (or a Python script's source) whose
///   text contains the pattern, matched the way the sandbox deny list
///   matches: a single word as a word, a phrase as a substring.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GuardRule {
    /// `pattern` is an absolute folder path. Writes under it are refused.
    ProtectPath {
        pattern: String,
    },
    /// `pattern` is matched against command text and Python source.
    ForbidCommand {
        pattern: String,
    },
}

/// A rule plus its bookkeeping: the operator's name for it, an optional
/// one-line note shown in refusals, and whether it is active. Kept as one
/// struct so the settings list and the refusal message never disagree about
/// which rule fired.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GuardRuleEntry {
    pub id: String,
    pub name: String,
    pub rule: GuardRule,
    /// Shown to the model and the operator when this rule refuses a call.
    #[serde(default)]
    pub note: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolSummary {
    pub name: String,
    pub description: String,
}

/* ------------------------------------------------------------------ */
/* Core status and failures                                            */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreStatus {
    /// 'checking' | 'connected' | 'core_only' | 'unavailable'
    pub state: String,
    pub ipc: bool,
    pub router: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub router_version: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreFailure {
    pub id: String,
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<String>,
    pub at: i64,
}

/* ------------------------------------------------------------------ */
/* The conversation                                                    */
/* ------------------------------------------------------------------ */

/// One conversation, as the sidebar lists it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    /// Null for a conversation started before any folder was opened.
    pub workspace_id: Option<String>,
    pub title: String,
    pub mode: AgentMode,
    pub use_memories: bool,
    pub contribute_memories: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

/// What a stored turn carries besides its text.
///
/// The core writes this and never reads it back: it is what the transcript needs
/// to look the same after a restart as it did when it was live — which model
/// answered, how fast, what it cited, what was attached. Absent fields are
/// absent, not zero, so a turn that failed before a model was chosen does not
/// come back claiming one.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageExtra {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens_per_sec: Option<f64>,
    /// The run that produced an `agent` row. Present on answers and failed
    /// turns only, never on the operator's own messages. It survives a reload
    /// so the transcript view can name a finished turn's run (`msg-<runId>`),
    /// which is what lets editing that turn back out of its still-pending file
    /// changes even after the page was refreshed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<AgentMode>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub citations: Vec<Citation>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    /// The run's step checklist as last published with `update_plan`.
    ///
    /// Codex-style: the plan is part of the session record, not a live-run
    /// ephemeral. Replaying a conversation replays its checklist, and the
    /// plan-mode handoff survives a restart because of this field — an
    /// approved-but-unfinished plan is still sitting there to be executed
    /// after relaunch, not lost with the process that drew it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<Vec<PlanItem>>,
}

/// One turn as it is stored and replayed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    /// `user`, `agent` or `system`.
    pub sender: String,
    pub content: String,
    pub created_at: i64,
    #[serde(flatten)]
    pub extra: MessageExtra,
}

/* ------------------------------------------------------------------ */
/* Agent run payloads                                                  */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRunInput {
    pub session_id: String,
    /// Absent when no folder has been opened yet.
    ///
    /// A workspace is what makes *file* tools legal, not what makes the
    /// assistant usable. Asking what a model can do, transcribing a photograph
    /// that was dragged in, or reading an ingested drawing all work with no
    /// folder registered at all — so this is optional here and enforced at the
    /// point a tool actually reaches for a path. Gating the text box on it left
    /// the operator with a dead keyboard and no way to find out why.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub mode: AgentMode,
    pub prompt: String,
    pub attachments: Vec<String>,
    #[serde(default = "default_true")]
    pub use_memories: bool,
    #[serde(default = "default_true")]
    pub contribute_memories: bool,
}

/// One model-visible input item on an explicitly submitted turn.
///
/// This mirrors the Codex app-server boundary: choosing a local file creates an
/// input item in the client draft, while only `turn_start` sends the item to the
/// orchestrator. `LocalFile` is the workbench's document extension to Codex's
/// text and local-image input types.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TurnInput {
    Text { text: String },
    LocalImage { path: String },
    LocalFile { path: String },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTurnInput {
    pub thread_id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub mode: AgentMode,
    pub input: Vec<TurnInput>,
    #[serde(default = "default_true")]
    pub use_memories: bool,
    #[serde(default = "default_true")]
    pub contribute_memories: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunStarted {
    pub run_id: String,
    pub session_id: String,
}

/// Fired once a started turn's operator message has actually been written to
/// the conversation store.
///
/// `turn_start` answers before the row exists (the store happens in the run's
/// async body), so the id cannot ride on the start reply. The frontend uses
/// this to stamp the DB row id onto the user bubble it already drew — without
/// it, an edit could never address the message it came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunUserStored {
    pub run_id: String,
    pub session_id: String,
    pub message_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunText {
    pub run_id: String,
    pub session_id: String,
    /// Separates short tool-round narration from the final streamed answer.
    pub kind: RunTextKind,
    /// User-visible text only. `reasoning_content` is emitted separately as a
    /// `Thinking` delta when — and only when — the operator has enabled
    /// Extended Thinking; otherwise it is discarded here by design.
    pub delta: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RunTextKind {
    Commentary,
    Answer,
    /// The model's own reasoning stream, emitted only when the operator has
    /// enabled Extended Thinking. With it off, no such event is ever emitted.
    Thinking,
}

/// One step of the live plan the model publishes through `update_plan`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanItem {
    /// Stable across revisions: `set_plan` reuses the previous id when the step
    /// text survives a re-publish, so the UI can key rows on it and update a
    /// checklist in place instead of re-rendering a second list. New steps get
    /// fresh ids. Absent on plans stored before ids existed.
    #[serde(default)]
    pub id: String,
    pub step: String,
    pub status: PlanStatus,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanStatus {
    Pending,
    InProgress,
    Completed,
}

/// `agent://plan` — the current plan for a run, emitted whenever the model
/// revises it. The checklist in the UI is a projection of the latest one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPlan {
    pub run_id: String,
    pub session_id: String,
    pub items: Vec<PlanItem>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDone {
    pub run_id: String,
    /// The chat that started this turn. The UI must never infer this from the
    /// chat that happens to be visible when the event arrives.
    pub session_id: String,
    pub mode: AgentMode,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_per_sec: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Authoritative accumulated response. Streaming deltas are presentation;
    /// this is what is persisted and committed to the main transcript.
    pub message: String,
    pub summary: String,
    pub citations: Vec<Citation>,
    /// Proposed writes, still unwritten. The review panel is populated from
    /// here; nothing else in the contract carries a `FileChange`.
    pub changes: Vec<FileChange>,
    /// Set only when the run failed. The chat shows it as the failure banner,
    /// and the retry control hangs off it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
    /// The final checklist, on success and failure alike. A failed Plan-mode
    /// turn still published steps, and the plan→agent handoff card is built
    /// from them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<Vec<PlanItem>>,
}

/// `agent://phase` — what the run is doing between tool calls.
///
/// The thinking spinner used to be driven by "a run is live", which kept
/// spinning through every tool call, the whole answer phase, and a hung
/// permission dialog, because no event ever said the reasoning had ended. This
/// is that event: one per transition, with a label the status line can show
/// verbatim. It is presentation state, not persisted — the transcript carries
/// the steps and text; this only says what *now* is.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPhase {
    pub run_id: String,
    pub session_id: String,
    pub phase: RunPhaseKind,
    /// The current action in the operator's words, e.g. "Run command: npm install".
    /// `None` when the phase itself says it (e.g. a plain reasoning tick).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunPhaseKind {
    /// Between tool calls: the model is reasoning about what to do next.
    Reasoning,
    /// A tool call is executing. The label carries the step title.
    Executing,
    /// The final answer is being streamed.
    Answering,
    /// The run is parked on the operator: a permission or a question.
    Waiting,
    /// The run has finished, however it finished. Terminal.
    Done,
}

/// `devserver://status` — one persistent dev server per workspace.
///
/// The URL in here has been verified by an actual HTTP round trip, so the UI
/// can render it as a link without a "the agent said this was live" asterisk.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DevServerStatus {
    pub workspace_id: String,
    /// The folder the server was started in (the workspace root).
    pub cwd: String,
    /// The command line, as resolved (e.g. `npm run dev`).
    pub command: String,
    pub pid: u32,
    /// The port the server itself printed, not a guessed one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// `http://127.0.0.1:{port}/` — set only once the port answered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub status: DevServerState,
    pub started_at: i64,
    /// Why a start failed, or the tail of the output when the server died.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The last lines the server printed, stdout and stderr merged, so a
    /// failure banner can show the real reason (missing dependency, bad
    /// script) rather than "could not start".
    pub output: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DevServerState {
    Starting,
    Running,
    Failed,
    Stopped,
}

/* ------------------------------------------------------------------ */
/* Sync exposure — the honest version of the OneDrive check            */
/* ------------------------------------------------------------------ */

/// Whether a configured path is genuinely replicated off this machine.
///
/// The first version of this test matched the folder *name* against
/// /onedrive|dropbox|.../ and was wrong: a directory called `OneDrive` with no
/// sync client installed is an ordinary local directory, and the warning was a
/// false positive. This reports what is actually true of the filesystem:
/// a registered sync root, a running client, and cloud reparse attributes on
/// the files themselves.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncExposure {
    /// The setting that names this folder — "Knowledge folder", "Workspace
    /// \"Turbine reports\" (approved)". What the operator would go and change if
    /// the verdict were bad; a bare path leaves them hunting for the screen.
    pub label: String,
    pub path: String,
    /// True when this is one of the application's own store folders (harness
    /// home, database and audit log, models, knowledge, sandbox, artifacts,
    /// memory) as opposed to a project folder the operator added and approved.
    /// The §11 lock refuses agent work when an *owned* folder replicates — that
    /// is the store itself leaving the machine. A replicated operator project
    /// folder is shown on the panel in the same red but is not, by itself, a
    /// store-wide lock.
    #[serde(default)]
    pub owned: bool,
    /// True when a registered sync root contains the path, or the files carry
    /// cloud attributes. A running sync client alone does not set this: it says
    /// something is being synced somewhere, not that this folder is.
    pub replicated: bool,
    /// A sync client is installed and running. Context, never the verdict.
    pub client_running: Option<String>,
    /// The path sits under a root registered with the Cloud Files API, with
    /// `SyncEngines\Providers`, or as a OneDrive account folder.
    pub registered_root: Option<String>,
    /// Files carry FILE_ATTRIBUTE_RECALL_ON_* or OFFLINE, i.e. cloud placeholders.
    pub placeholder_files: u32,
    /// Entries carry FILE_ATTRIBUTE_PINNED or UNPINNED. Only a cloud filter
    /// driver sets those, so they betray a managed folder whose files all happen
    /// to be downloaded — the case `placeholder_files` alone would miss.
    pub pin_marked_files: u32,
    /// Entries that are reparse points without any cloud attribute: junctions
    /// and symbolic links. Part of the tree lives elsewhere on this machine,
    /// which is worth reporting but is not replication off it.
    pub reparse_points: u32,
    /// Files checked, so the ratio above is interpretable.
    pub files_checked: u32,
    /// The folder's contents were actually inspected.
    ///
    /// False means the folder could not be opened, so every count above is zero
    /// for want of looking rather than for want of finding. Distinct from
    /// `files_checked == 0`, which an existing but empty folder also produces —
    /// and the distinction is the whole point: "no evidence of replication" and
    /// "nothing was examined" are different findings, and a report that lets the
    /// second read as the first is not evidence of anything.
    pub examined: bool,
    /// Shown verbatim in Settings.
    pub detail: String,
}

/// The replication picture for every folder this application writes to.
///
/// The machine-wide facts are carried alongside the per-path verdicts because
/// they are what makes a negative result meaningful: "no sync root contains the
/// knowledge folder" is reassuring, and "no sync root is registered on this
/// machine at all" is more so. Showing the evidence, not just the conclusion, is
/// the same rule the model-selection panel follows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposureReport {
    /// Sync clients found running, by product name. Empty is the expected case.
    pub clients_running: Vec<String>,
    /// Every sync root registered on this machine, whether or not it contains
    /// one of ours.
    pub registered_roots: Vec<String>,
    /// One row per folder, in the order the operator would think about them.
    pub paths: Vec<SyncExposure>,
    pub any_replicated: bool,
    /// One line for the head of the report.
    pub summary: String,
    pub checked_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StoreGateDecisionKind {
    /// The start was refused because an app-owned store folder replicated.
    Refused,
    /// The start was allowed because the operator set the audited override.
    Overridden,
}

/// One §11 gate decision at the start of an agent turn.
///
/// When an app-owned store folder replicates off this machine, agent work is
/// refused and the refusal is recorded here; when the operator has set the
/// audited override, the start is recorded here instead. Append-only — there is
/// no update or delete path in the codebase, because the one thing a record
/// table must never do is forget.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreGateDecision {
    pub id: String,
    pub at: i64,
    /// The operator account that attempted (or overrode) the start.
    pub operator: String,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub decision: StoreGateDecisionKind,
    /// Labels of the app-owned store folders that were replicating.
    pub folders: Vec<String>,
    /// One line capturing what the report found, for a reader who never opens
    /// the Sovereignty panel.
    pub summary: String,
}

/* ------------------------------------------------------------------ */
/* §16  At-rest passphrase vault                                       */
/* ------------------------------------------------------------------ */

/// What kind of §16 at-rest vault lifecycle event this row records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VaultAction {
    /// The vault was enabled: a passphrase was set and every existing
    /// confidential mirror was sealed to ciphertext.
    Enabled,
    /// The vault was disabled with the correct passphrase: the sealed mirrors
    /// were restored to plaintext and appends/mirroring resumed.
    Disabled,
    /// A disable was attempted with a passphrase that did not verify. Logged,
    /// not merely refused — a wrong passphrase on an at-rest vault is exactly
    /// the kind of line an auditor wants to see.
    Denied,
}

/// One append-only entry in the at-rest vault lifecycle ledger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEvent {
    pub id: String,
    pub at: i64,
    /// The operator account that performed (or attempted) the action.
    pub operator: String,
    pub action: VaultAction,
    /// One line of context — how many files were sealed or restored, or why a
    /// disable was refused.
    pub detail: String,
}

/// The §16 at-rest vault's observable state, for the Sovereignty panel.
///
/// Everything here is read from the state file and the payload folders — never
/// from the passphrase, which is not stored anywhere.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    /// True while the state file exists — i.e. while the operator has chosen to
    /// keep this application's confidential mirrors sealed.
    pub enabled: bool,
    /// When the vault was enabled, if it is.
    pub enabled_at: Option<i64>,
    /// Who enabled it.
    pub operator: Option<String>,
    /// How many confidential mirror files are currently sealed (`.vault`
    /// envelopes present in the payload set).
    pub sealed_files: u64,
    /// How many confidential mirror files are still in clear text. Zero while
    /// the vault is enabled; non-zero means an enable was interrupted or a file
    /// appeared after it, and is reported rather than hidden.
    pub plaintext_files: u64,
}

#[cfg(test)]
mod turn_wire_tests {
    use super::*;

    #[test]
    fn typed_turn_inputs_keep_text_images_and_documents_distinct() {
        let input: StartTurnInput = serde_json::from_value(serde_json::json!({
            "threadId": "sess-1",
            "workspaceId": null,
            "mode": "plan",
            "input": [
                { "type": "text", "text": "Read the heading" },
                { "type": "localImage", "path": "C:/private/photo.jpg" },
                { "type": "localFile", "path": "C:/private/report.pdf" }
            ]
        }))
        .expect("Codex-style turn input should deserialize");

        assert_eq!(input.thread_id, "sess-1");
        assert_eq!(
            input.input,
            vec![
                TurnInput::Text { text: "Read the heading".into() },
                TurnInput::LocalImage { path: "C:/private/photo.jpg".into() },
                TurnInput::LocalFile { path: "C:/private/report.pdf".into() },
            ]
        );
        assert!(input.use_memories);
        assert!(input.contribute_memories);
    }
}

#[cfg(test)]
mod plan_and_thinking_wire_tests {
    use super::*;

    /// The plan event is the whole plan, camelCase, snake_case statuses — the
    /// exact shape `PlanChecklist` in the UI consumes. A drift here is a
    /// silently empty checklist, so it is pinned by test.
    #[test]
    fn the_plan_event_serializes_as_the_ui_expects() {
        let plan = RunPlan {
            run_id: "run-1".into(),
            session_id: "sess-1".into(),
            items: vec![
                PlanItem { id: "task-1".into(), step: "Read the report".into(), status: PlanStatus::Completed },
                PlanItem { id: "task-2".into(), step: "Write the note".into(), status: PlanStatus::InProgress },
            ],
        };
        let v = serde_json::to_value(&plan).expect("serializes");
        assert_eq!(v["runId"], "run-1");
        assert_eq!(v["sessionId"], "sess-1");
        assert_eq!(v["items"][0]["step"], "Read the report");
        assert_eq!(v["items"][0]["status"], "completed");
        assert_eq!(v["items"][1]["status"], "in_progress");
        assert_eq!(v["items"][0]["id"], "task-1");
    }

    /// Plans stored before ids existed deserialize with an empty id rather
    /// than failing, so an old conversation still rehydrates its checklist.
    #[test]
    fn a_plan_item_without_an_id_still_deserializes() {
        let v = serde_json::json!({ "step": "Read the report", "status": "completed" });
        let item: PlanItem = serde_json::from_value(v).expect("deserializes");
        assert_eq!(item.id, "");
        assert_eq!(item.step, "Read the report");
    }

    /// A thinking delta is a first-class kind on the wire, distinct from
    /// commentary and answer, so the UI can route it to its own block.
    #[test]
    fn thinking_is_a_distinct_run_text_kind() {
        let t = RunText {
            run_id: "run-1".into(),
            session_id: "sess-1".into(),
            kind: RunTextKind::Thinking,
            delta: "checking the report page".into(),
        };
        let v = serde_json::to_value(&t).expect("serializes");
        assert_eq!(v["kind"], "thinking");
        assert_eq!(v["delta"], "checking the report page");
    }
}
