/**
 * Sovereign AI Workbench — shared type contract.
 *
 * These types are the boundary between the React UI and the Rust/Zero core.
 * Every shape here corresponds to something the backend can actually produce;
 * nothing is invented for the sake of the interface.
 */

/* ------------------------------------------------------------------ */
/* §11  Sovereign mode — where computation and bytes actually go       */
/* ------------------------------------------------------------------ */

/** The three destinations a byte can go to. Public internet must stay at 0. */
export type TrafficZone = 'this_device' | 'private_server' | 'public_internet';

export interface SovereignStatus {
  /** The operator account the core is attributing audit rows to (`DOMAIN\user`). */
  operator: string;
  /** Bytes sent to any host outside the organisation. Must remain 0. */
  publicInternetBytes: number;
  /** Bytes exchanged with an approved on-prem inference server. */
  privateServerBytes: number;
  /** Requests served entirely by models on this workstation. */
  deviceRequests: number;
  privateServerRequests: number;
  /** True when the egress guard is installed and actively blocking. */
  egressBlocked: boolean;
  /** Name of the approved on-prem server, if one is configured. */
  privateServerName: string | null;
}

/* ------------------------------------------------------------------ */
/* §1 / §2  Model registry and memory management                       */
/* ------------------------------------------------------------------ */

export type ModelCapability =
  | 'general'
  | 'reasoning'
  | 'coding'
  | 'vision'
  | 'ocr'
  | 'handwriting'
  | 'documents'
  | 'drawings'
  | 'embeddings'
  | 'long_context'
  | 'tools';

export type ModelBackend = 'llama.cpp' | 'python' | 'private_endpoint';

/** Where the weights physically live. Never 'cloud'. */
export type ModelLocation = 'this_device' | 'private_server';

export type ModelState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'error';

/** Router priority. 'disabled' models stay in the registry but are never selected. */
export type ModelPriority = 'primary' | 'fallback' | 'specialist' | 'disabled';

export interface ModelEntry {
  id: string;
  displayName: string;
  backend: ModelBackend;
  location: ModelLocation;
  /** Absolute path to the weights, or the endpoint URL for private_endpoint. */
  source: string;
  /** Vision projector (mmproj) path when the model is multimodal. */
  projector?: string;
  architecture: string;
  quantization: string;
  /** Context we actually allocate, from the curated preset. */
  contextSize: number;
  /** Context the weights were trained for. */
  trainedContext: number;
  /** KV cache quantization in use, e.g. 'q8_0'. */
  kvCacheType?: string;
  capabilities: ModelCapability[];
  /** Measured peak VRAM at contextSize, in MiB. */
  estimatedVramMb: number;
  fileSizeBytes: number;
  priority: ModelPriority;
  /** Measured prompt-processing throughput, tokens/s. */
  promptTokensPerSec?: number;
  /** Measured generation throughput, tokens/s. */
  genTokensPerSec?: number;
  /** Why this model is disabled or constrained. Shown verbatim in the UI. */
  note?: string;
}

/** Live per-model runtime state, kept separate from static registry metadata. */
export interface ModelRuntime {
  id: string;
  state: ModelState;
  /** Wall-clock time of the last successful load. */
  loadTimeMs?: number;
  /** VRAM the loaded child process is actually holding, MiB. */
  residentVramMb?: number;
  /** Tokens/s observed on the most recent generation. */
  lastTokensPerSec?: number;
  /** Set when state is 'error'. */
  lastError?: string;
  /** Timestamp of last use, for the retain-then-evict policy. */
  lastUsedAt?: number;
}

/* ------------------------------------------------------------------ */
/* §2  Hardware telemetry                                             */
/* ------------------------------------------------------------------ */

export interface HardwareStatus {
  gpuName: string;
  /** Free VRAM matters more than total: the compositor holds ~1 GiB. */
  vramUsedMb: number;
  vramTotalMb: number;
  vramBudgetMb: number;
  gpuUtilPct: number;
  cpuName: string;
  cpuUtilPct: number;
  ramUsedMb: number;
  ramTotalMb: number;
  /** True when a load had to spill layers to system RAM. */
  offloading: boolean;
}

/* ------------------------------------------------------------------ */
/* §3  Deterministic router                                           */
/* ------------------------------------------------------------------ */

export type TaskKind =
  | 'code'
  | 'reasoning'
  | 'digital_document'
  | 'scanned_document'
  | 'handwriting'
  | 'engineering_drawing'
  | 'photograph'
  | 'long_context'
  | 'knowledge_query'
  | 'embedding';

export interface RouteRule {
  kind: TaskKind;
  label: string;
  /** How the decision is reached. Rules and file detection come first. */
  basis: 'file_type' | 'rule' | 'token_budget' | 'classifier';
  modelId: string | null;
  fallbackModelId?: string;
  /** Set when the task needs no model at all (native extraction). */
  deterministic?: boolean;
  detail: string;
}

export interface RouteDecision {
  kind: TaskKind;
  basis: RouteRule['basis'];
  modelId: string | null;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* §6  Agent orchestrator — structured events, not a chat transcript   */
/* ------------------------------------------------------------------ */

/** Two modes only: inspect-and-propose, or act-with-approval. */
export type AgentMode = 'plan' | 'agent';

export type StepKind =
  | 'planning'
  | 'selecting_model'
  | 'loading_model'
  | 'reading_file'
  | 'searching_files'
  | 'searching_knowledge'
  | 'ocr'
  | 'vision'
  | 'running_python'
  | 'running_command'
  | 'starting_server'
  | 'editing_file'
  | 'writing_file'
  | 'generating_artifact'
  | 'verifying'
  | 'awaiting_approval'
  | 'error';

export type StepStatus = 'running' | 'done' | 'failed' | 'skipped';

export interface AgentStep {
  id: string;
  kind: StepKind;
  /** Run and chat this step belongs to. Absent on run-less work (a
   *  user-initiated ingest), which no chat's timeline claims. */
  runId?: string;
  sessionId?: string;
  /** One-line action summary. Never raw chain-of-thought. */
  title: string;
  detail?: string;
  status: StepStatus;
  startedAt: number;
  durationMs?: number;
  /** Which model performed this step, if any. */
  modelId?: string;
  toolName?: ToolName;
  citations?: Citation[];
  /** Populated when status is 'failed'. */
  error?: string;
}

/**
 * Chronological, user-visible parts of an agent run.
 *
 * Keeping text and actions in one ordered stream prevents late work (such as
 * memory curation) from being drawn above an answer that was emitted first.
 * Consecutive actions are intentionally grouped into one collapsible block.
 */
export type ChatActivityBlock =
  | {
      id: string;
      type: 'text';
      kind: 'commentary' | 'answer' | 'thinking';
      text: string;
      /** The span this block occupied, in epoch ms — what the thinking
       *  header's "Thought for 4.2 s" is measured from.
       *
       *  `startedAt` is when the *previous* timeline entry ended, not when the
       *  first delta of this block landed: a tool round's reasoning is not
       *  streamed and arrives whole, so first-delta-to-last-delta would report
       *  0 ms for thinking that actually took seconds. Both are optional
       *  because activity is session-lifetime only and never stored, so a
       *  reopened chat has no blocks at all rather than blocks missing a
       *  duration — see `StoredMessage`, which has no `activity` field. */
      startedAt?: number;
      endedAt?: number;
    }
  | {
      id: string;
      type: 'actions';
      steps: AgentStep[];
    }
  | {
      /** Live sandbox command output, streamed line by line while the
       *  command runs. One block per command: lines append to it. */
      id: string;
      type: 'console';
      text: string;
    };
/* The plan is deliberately not an activity block: it is the run's state, not
 * a timeline entry — see `LiveRun.plan` and the docked task panel. */

/* ------------------------------------------------------------------ */
/* Live plan (Codex-style `update_plan`)                              */
/* ------------------------------------------------------------------ */

export type PlanStatus = 'pending' | 'in_progress' | 'completed';

export interface PlanItem {
  /** Stable across revisions: the backend reuses the previous id when the
   *  step text survives an update_plan re-publish, so a checklist keyed on
   *  it updates in place instead of stacking duplicate lists. Empty on plans
   *  stored before ids existed. */
  id: string;
  step: string;
  status: PlanStatus;
}

/** `agent://plan` payload: the whole plan as last published for a run. */
export interface RunPlan {
  runId: string;
  sessionId: string;
  items: PlanItem[];
}

/* ------------------------------------------------------------------ */
/* Run phase — what the run is doing *now*                             */
/* ------------------------------------------------------------------ */

export type RunPhaseKind = 'reasoning' | 'executing' | 'answering' | 'waiting' | 'done';

/** `agent://phase` payload: one per transition, so the thinking spinner
 *  reflects actual reasoning and the status line names the current action. */
export interface RunPhase {
  runId: string;
  sessionId: string;
  phase: RunPhaseKind;
  label?: string | null;
}

/* ------------------------------------------------------------------ */
/* Persistent dev servers                                              */
/* ------------------------------------------------------------------ */

export type DevServerState = 'starting' | 'running' | 'failed' | 'stopped';

/** `devserver://status` payload: the workspace's dev server. The URL was
 *  verified reachable by the core before it was set. */
export interface DevServerStatus {
  workspaceId: string;
  cwd: string;
  command: string;
  pid: number;
  port?: number;
  url?: string;
  status: DevServerState;
  startedAt: number;
  error?: string;
  output: string[];
}

/* ------------------------------------------------------------------ */
/* Mid-run operator question (`ask_operator`)                         */
/* ------------------------------------------------------------------ */

/** `agent://question` payload: a run paused, waiting on a typed reply. */
export interface OperatorQuestion {
  id: string;
  runId: string;
  sessionId: string;
  question: string;
  context?: string | null;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* §7  Tool system                                                    */
/* ------------------------------------------------------------------ */

export type ToolName =
  | 'list_files'
  | 'update_plan'
  | 'ask_operator'
  | 'read_file'
  | 'search_files'
  | 'write_file'
  | 'edit_file'
  | 'create_directory'
  | 'ocr_document'
  | 'analyze_image'
  | 'query_knowledge'
  | 'execute_python'
  | 'run_command'
  | 'serve_folder'
  | 'start_dev_server'
  | 'check_page'
  | 'read_spreadsheet'
  | 'write_spreadsheet'
  | 'generate_docx'
  | 'generate_xlsx'
  | 'generate_pptx'
  | 'generate_pdf'
  | 'analyze_data'
  | 'inspect_artifact'
  | 'web_search'
  | 'web_fetch'
  | 'mcp_list_tools'
  | 'mcp_call';

export type WebSearchMode = 'disabled' | 'direct' | 'provider';
export type WebSearchProvider = 'brave' | 'tavily';

export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

/* ------------------------------------------------------------------ */
/* Operator-authored safety guardrails                                */
/* ------------------------------------------------------------------ */

/**
 * One hard stop the operator wrote. Two kinds, because the two ways a run
 * destroys things are different: writing somewhere it must not, and running
 * something it must not.
 */
export type GuardRule =
  /** `pattern` is an absolute folder path. Writes under it are refused. */
  | { type: 'protect_path'; pattern: string }
  /** `pattern` is matched against command text and Python source. */
  | { type: 'forbid_command'; pattern: string };

export interface GuardRuleEntry {
  id: string;
  /** The operator's own name for the rule, shown in refusals. */
  name: string;
  rule: GuardRule;
  /** Extra context appended to the refusal message. */
  note: string;
  enabled: boolean;
}

export interface McpToolSummary {
  name: string;
  description: string;
}

export type ToolRisk = 'read' | 'write' | 'execute' | 'destructive';

export interface ToolDescriptor {
  name: ToolName;
  label: string;
  risk: ToolRisk;
  /** Whether this tool requires explicit approval in agent mode. */
  requiresApproval: boolean;
  summary: string;
}

/** Every tool call is logged. This is the audit record shape. */
export interface ToolCallRecord {
  id: string;
  tool: ToolName;
  argsSummary: string;
  status: 'ok' | 'denied' | 'failed';
  startedAt: number;
  durationMs: number;
  workspaceId: string;
  /** The operator account that made the call. Absent on pre-attribution rows. */
  operator?: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* §9  Permissions                                                    */
/* ------------------------------------------------------------------ */

export type PermissionDecision = 'allow_once' | 'allow_session' | 'reject';

/** How much the agent may do without asking. */
export type ApprovalPolicy = 'ask_always' | 'ask_risky_only' | 'auto_run_sandbox';

export interface PermissionRequest {
  id: string;
  /** The run that is asking, so Stop in one chat never answers for another. */
  runId?: string;
  tool: ToolName;
  title: string;
  /** Why the agent wants this, in plain language. */
  rationale: string;
  risk: ToolRisk;
  /** Path, command, or endpoint the action targets. */
  target: string;
  /** Diff, command line, or script the user is approving. */
  preview?: string;
  workspaceId: string;
  createdAt: number;
}

/* ------------------------------------------------------------------ */
/* §8  Sandbox                                                        */
/* ------------------------------------------------------------------ */

export interface SandboxPolicy {
  /** Isolated working directory all execution is confined to. */
  workingDir: string;
  networkEnabled: boolean;
  timeoutSec: number;
  maxMemoryMb: number;
  maxProcesses: number;
  /** Commands runnable without approval. */
  allowedCommands: string[];
  /** Commands refused outright, even with approval. */
  deniedCommands: string[];
}

export interface SandboxRun {
  id: string;
  command: string;
  cwd: string;
  /** `interrupted` is written at startup for a run a previous session left mid-flight. */
  status: 'running' | 'exited' | 'killed' | 'timeout' | 'denied' | 'interrupted';
  exitCode?: number;
  startedAt: number;
  durationMs?: number;
  output: SandboxLine[];
}

export interface SandboxLine {
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  at: number;
}

/* ------------------------------------------------------------------ */
/* §4  Document ingestion — never lose source traceability             */
/* ------------------------------------------------------------------ */

export type DocumentKind =
  | 'pdf_digital'
  | 'pdf_scanned'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'text'
  | 'markdown'
  | 'source_code'
  | 'image'
  | 'photograph'
  | 'handwriting'
  | 'drawing';

/** How the text was obtained. Native extraction is always tried first. */
export type ExtractionMethod = 'native' | 'ocr' | 'vision' | 'pending';

/** Normalised page coordinates, 0..1, so overlays survive any zoom. */
export interface BoundingBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type BlockKind = 'text' | 'heading' | 'table' | 'figure' | 'tag' | 'handwriting';

export interface DocBlock {
  id: string;
  kind: BlockKind;
  text: string;
  bbox: BoundingBox;
  /** 0..1. Absent when extraction was native — there is no score to report. */
  confidence?: number;
}

export interface DocTable {
  id: string;
  page: number;
  bbox: BoundingBox;
  header: string[];
  rows: string[][];
}

export interface IngestedDocument {
  id: string;
  path: string;
  fileName: string;
  kind: DocumentKind;
  pageCount: number;
  extraction: ExtractionMethod;
  /** Model used for ocr/vision extraction; absent for native. */
  modelId?: string;
  blocks: DocBlock[];
  tables: DocTable[];
  /** Equipment tags, line numbers, instruments detected in drawings. */
  entities: string[];
  sizeBytes: number;
  sha256: string;
  ingestedAt: number;
  /** Preview image the viewer renders bounding boxes over. */
  previewUri?: string;
}

/* ------------------------------------------------------------------ */
/* §5  Local RAG                                                      */
/* ------------------------------------------------------------------ */

export type IndexStatus = 'queued' | 'indexing' | 'indexed' | 'failed' | 'stale';

export interface KnowledgeSource {
  id: string;
  path: string;
  fileName: string;
  kind: DocumentKind;
  chunks: number;
  sizeBytes: number;
  sha256: string;
  status: IndexStatus;
  indexedAt?: number;
  error?: string;
}

export interface KnowledgeIndexStats {
  documents: number;
  chunks: number;
  /** Bytes on disk for the SQLite store including vectors and FTS index. */
  indexBytes: number;
  embeddingModelId: string;
  embeddingDim: number;
  /** True when a folder watcher is picking up changes automatically. */
  watching: boolean;
  /** The folders the watcher holds: the configured root plus every folder an
   *  indexed source came out of. Named in the panel so "watching" is checkable. */
  watchedFolders: string[];
  lastIndexedAt?: number;
}

/** A retrieval result that can be traced back to an exact page region. */
export interface Citation {
  /**
   * The indexed source this passage came from — a knowledge id, not an
   * `IngestedDocument.id`. To open the file, go through `path`.
   */
  docId: string;
  path: string;
  fileName: string;
  page?: number;
  bbox?: BoundingBox;
  snippet: string;
  /** Fused dense + BM25 score. */
  score: number;
}

/* ------------------------------------------------------------------ */
/* §10  Artifacts                                                     */
/* ------------------------------------------------------------------ */

export type ArtifactKind = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'markdown' | 'text' | 'code';

export interface Artifact {
  id: string;
  path: string;
  fileName: string;
  kind: ArtifactKind;
  sizeBytes: number;
  createdAt: number;
  /** The instruction that produced it. */
  sourceTask: string;
  /** Documents that fed into it, for provenance. */
  sourceDocumentIds: string[];
  producingModelId: string;
  toolHistory: ToolName[];
  workspaceId?: string;
  sessionId?: string;
  /** Set only after the file was reopened and parsed successfully. */
  verified: boolean;
  verifyNote?: string;
}

/* ------------------------------------------------------------------ */
/* Workspaces and file changes                                        */
/* ------------------------------------------------------------------ */

export interface Workspace {
  id: string;
  name: string;
  /** The primary project folder. Kept for compatibility with file tools. */
  path: string;
  /** Up to five local folders attached to this project. Exactly one is primary. */
  folders: WorkspaceFolder[];
  /** Tools may only touch approved workspaces. */
  approved: boolean;
  pinned: boolean;
  archived: boolean;
  addedAt: number;
  fileCount?: number;
  indexedCount?: number;
}

export interface WorkspaceFolder {
  id: string;
  path: string;
  isPrimary: boolean;
}

export interface WorkspaceUpdate {
  name: string;
  folders: Array<Pick<WorkspaceFolder, 'id' | 'path' | 'isPrimary'>>;
  pinned: boolean;
  archived: boolean;
}

/* ------------------------------------------------------------------ */
/* Harness memory and instructions                                     */
/* ------------------------------------------------------------------ */

export type MemoryScope = 'global' | 'project';
export type MemoryKind = 'preference' | 'instruction' | 'decision' | 'fact' | 'summary';

export interface MemoryEntry {
  id: string;
  scope: MemoryScope;
  workspaceId?: string;
  title: string;
  content: string;
  kind: MemoryKind;
  sourceSessionId?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryInput {
  scope: MemoryScope;
  workspaceId?: string;
  title: string;
  content: string;
  kind: MemoryKind;
  sourceSessionId?: string;
}

export interface HarnessInfo {
  root: string;
  sessionsRoot: string;
  memoriesRoot: string;
  projectsRoot: string;
  globalInstructionsPath: string;
  projectInstructionsPath?: string;
}

export interface InstructionDocument {
  scope: MemoryScope;
  workspaceId?: string;
  path: string;
  content: string;
}

export interface FileChange {
  path: string;
  status: 'modified' | 'created' | 'deleted';
  additions: number;
  deletions: number;
  oldContent: string;
  newContent: string;
  /** Whether the user has accepted this change. */
  applied: boolean;
  /**
   * What the run had read when it produced these contents — the paths, queries
   * and documents whose results reached the model first.
   *
   * Empty is meaningful, not missing: it says the contents are the model's own
   * invention. Normal for a script or a scaffold, serious for anything stating a
   * thickness or a limit, so the reviewer shows which of the two it is.
   */
  grounding: string[];
}

/* ------------------------------------------------------------------ */
/* Conversation                                                       */
/* ------------------------------------------------------------------ */

export interface Attachment {
  id: string;
  path: string;
  fileName: string;
  kind: DocumentKind;
  sizeBytes: number;
  /** Present once ingestion has run. */
  documentId?: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent' | 'system';
  content: string;
  createdAt: number;
  /**
   * The row id of a persisted message. User messages sent in this app session
   * get it when the core confirms the row (`agent://user-stored`); rehydrated
   * messages carry their store id directly. Editing is only offered on a user
   * message that has one, because that is what truncation is addressed by.
   */
  rowId?: string;
  /** Structured actions the agent took. Replaces exposed chain-of-thought. */
  steps?: AgentStep[];
  /** Ordered text/action blocks for turns completed in this app session. */
  activity?: ChatActivityBlock[];
  citations?: Citation[];
  fileChanges?: FileChange[];
  artifacts?: Artifact[];
  attachments?: Attachment[];
  modelId?: string;
  mode?: AgentMode;
  elapsedMs?: number;
  tokensPerSec?: number;
  /** Set when the run ended in a handled failure (§15). */
  failure?: string;
  /** The run's final checklist. The plan is the run's state, not a timeline
   *  entry: it is rendered in the bottom task dock, updated in place while
   *  the run is live, and kept on the committed message afterwards. */
  plan?: PlanItem[];
}

/**
 * One turn as the core stores it (§12).
 *
 * Almost a `ChatMessage`, with two honest differences. Attachments come back as
 * the absolute paths the turn was given, because that is all the core was told —
 * the file's size and kind are read from disk when it is attached, not kept on
 * the turn. And `steps` are absent: the structured actions of a finished run
 * live in the audit log, keyed by session, not on the message row. A rehydrated
 * transcript therefore shows what was said and by which model, without
 * reconstructing a step list it cannot vouch for.
 */
export interface StoredMessage {
  id: string;
  sender: 'user' | 'agent' | 'system';
  content: string;
  createdAt: number;
  citations?: Citation[];
  attachments?: string[];
  modelId?: string;
  mode?: AgentMode;
  elapsedMs?: number;
  tokensPerSec?: number;
  failure?: string;
  /** The run that produced this `agent` row, when it was recorded by a build
   *  that persisted it. Lets the transcript name a finished turn by its run. */
  runId?: string;
  /** The run's final checklist, so a reopened chat replays its plan. */
  plan?: PlanItem[];
}

export interface Session {
  id: string;
  /** Null for a session started before any folder was opened. */
  workspaceId: string | null;
  title: string;
  mode: AgentMode;
  useMemories: boolean;
  contributeMemories: boolean;
  createdAt: number;
  updatedAt: number;
}

/* ------------------------------------------------------------------ */
/* Panels and settings                                                */
/* ------------------------------------------------------------------ */

export type PanelTabKind =
  | 'workflows'
  | 'review'
  | 'terminal'
  | 'files'
  | 'file'
  | 'document'
  | 'knowledge'
  | 'memories'
  | 'artifacts'
  | 'models'
  | 'audit';

export interface PanelTab {
  id: string;
  kind: PanelTabKind;
  title: string;
  /** For 'document' tabs: which ingested document to render. */
  documentId?: string;
  /** For 'file' tabs: an approved local path rendered inside the panel. */
  filePath?: string;
}

export type ViewName = 'workbench' | 'settings';

export type SettingsPage =
  | 'workbench'
  | 'providers'
  | 'models'
  | 'agent'
  | 'permissions'
  | 'tools'
  | 'skills'
  | 'transcription'
  | 'suggestions'
  | 'notifications'
  | 'shortcuts'
  | 'storage'
  | 'system'
  | 'knowledge'
  | 'memories'
  | 'audit'
  | 'sovereignty'
  | 'sandbox'
  | 'artifacts'
  | 'about';

export interface AppSettings {
  /* Runtime */
  llamaServerPath: string;
  modelPresetPath: string;
  modelsDirectory: string;
  /**
   * The router's port. Its host is not a setting — the bind is always
   * loopback, exported as ROUTER_BIND_HOST.
   */
  routerPort: number;
  /** Max models resident at once. 2 on an 8 GiB card. */
  maxResidentModels: number;
  /** Seconds a model is retained after its last use before eviction. */
  modelIdleEvictSec: number;
  /** Ask the model to think before answering. Off by default: it burns budget. */
  extendedThinking: boolean;

  /* Sovereignty */
  allowPrivateServer: boolean;
  privateServerUrl: string;
  privateServerName: string;
  /** Hard block on all non-approved egress. */
  blockPublicInternet: boolean;
  /**
   * Audited override for the §11 store-replication lock. When false (default)
   * the agent refuses to start while any owned store folder is replicating off
   * this machine. When true, the gate is lifted — but every lift is recorded,
   * append-only, to the store-gate ledger as an overridden decision. Not a
   * silent bypass: it trades a lock for an auditable trail.
   */
  allowReplicatedStore: boolean;

  /* Optional integrations */
  webSearchMode: WebSearchMode;
  webSearchProvider: WebSearchProvider;
  /** Environment variable containing the provider key; never the key itself. */
  webSearchApiKeyEnv: string;
  mcpServers: McpServerConfig[];

  /* Agent */
  defaultMode: AgentMode;
  approvalPolicy: ApprovalPolicy;
  /** Operator-authored hard stops. Checked before approvals; not waivable. */
  guardRules: GuardRuleEntry[];

  /* Sandbox */
  sandboxRoot: string;
  sandboxNetwork: boolean;
  sandboxTimeoutSec: number;
  sandboxMaxMemoryMb: number;

  /* Knowledge */
  knowledgeRoot: string;
  watchKnowledgeFolder: boolean;
  retrievalTopK: number;
  hybridRetrieval: boolean;

  /* Memories */
  memoryRoot: string;
  useGlobalMemories: boolean;
  useProjectMemories: boolean;
  captureMemories: boolean;

  /* Artifacts */
  artifactRoot: string;
  verifyArtifacts: boolean;

  /* UI */
  showRightPanel: boolean;
}

/* ------------------------------------------------------------------ */
/* Backend connection                                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether the Rust core and the llama.cpp router are actually reachable.
 * The UI shows real state rather than pretending to be connected.
 */
export type CoreState = 'checking' | 'connected' | 'core_only' | 'unavailable';

export interface CoreStatus {
  state: CoreState;
  /** Zero IPC reachable. False when running in a plain browser. */
  ipc: boolean;
  /** llama.cpp router process answering /health. */
  router: boolean;
  routerVersion?: string;
  detail: string;
}

/**
 * §11 — whether one folder this application writes to is genuinely replicated
 * off this machine.
 *
 * Deliberately not a name test. The first version of this warning matched the
 * path against /onedrive|dropbox|.../ and fired on a directory called `OneDrive`
 * on a machine with no OneDrive account configured, which is an ordinary local
 * directory. Everything below is read from the operating system: the sync-root
 * registrations Windows keeps, and the files' own attributes.
 */
export interface SyncExposure {
  /** The setting that names this folder, e.g. "Knowledge folder". */
  label: string;
  path: string;
  /**
   * True when a registered sync root contains the path, or the files carry cloud
   * attributes. A running sync client alone does not set this — it means
   * something somewhere is syncing, not that this folder is.
   */
  replicated: boolean;
  /** A sync client is running. Context, never the verdict. */
  clientRunning: string | null;
  /** The registration that covers this path, if one does. */
  registeredRoot: string | null;
  /** Files carrying RECALL_ON_OPEN, RECALL_ON_DATA_ACCESS or OFFLINE. */
  placeholderFiles: number;
  /** Entries carrying PINNED/UNPINNED, which only a cloud filter driver sets. */
  pinMarkedFiles: number;
  /** Reparse points with no cloud attribute: junctions and symbolic links. */
  reparsePoints: number;
  /** How many files were examined, so the counts above are interpretable. */
  filesChecked: number;
  /**
   * The folder's contents were actually inspected. False means it could not be
   * opened, so every count above is zero for want of looking — which is not the
   * same finding as a folder that was read and found clean.
   */
  examined: boolean;
  /**
   * True when this is one of the app's own store folders — the set the §11 lock
   * gates on. False for an operator's own project folder that merely happens to
   * live inside a synced location: that is shown, never locked, because the
   * operator chose it deliberately and its contents were never private.
   */
  owned: boolean;
  /** The reasoning, in full. Rendered verbatim. */
  detail: string;
}

/** §11 — the replication picture for every folder the app writes to. */
export interface ExposureReport {
  /** Sync clients found running, by product name. Empty is the expected case. */
  clientsRunning: string[];
  /** Every sync root registered on this machine, ours or not. */
  registeredRoots: string[];
  paths: SyncExposure[];
  anyReplicated: boolean;
  summary: string;
  checkedAt: number;
}

/** §13 — how a §11 store-gate refusal was resolved. */
export type StoreGateDecisionKind = 'refused' | 'overridden';

/**
 * One append-only entry in the store-gate ledger: either the gate refused an
 * agent start while an owned store folder was replicating, or the operator had
 * set the audited override and the gate lifted the lock in its place. The row
 * names the operator, so a trail of "overridden" rows is attributable.
 */
export interface StoreGateDecision {
  id: string;
  /** Unix epoch millis the decision was recorded. */
  at: number;
  operator: string;
  sessionId: string | null;
  workspaceId: string | null;
  decision: StoreGateDecisionKind;
  /** The owned store folders that were replicating when the gate ran. */
  folders: string[];
  summary: string;
}

/** §16 — the at-rest vault lifecycle action a row records. */
export type VaultActionKind = 'enabled' | 'disabled' | 'denied';

/**
 * One append-only entry in the at-rest vault ledger: a vault was enabled (and
 * every existing confidential mirror sealed), disabled with the correct
 * passphrase (mirrors restored), or a disable was attempted with a wrong
 * passphrase. The row names the operator, so a trail of wrong-passphrase rows
 * is attributable.
 */
export interface VaultEvent {
  id: string;
  /** Unix epoch millis the event was recorded. */
  at: number;
  operator: string;
  action: VaultActionKind;
  /** One line of context — files sealed/restored, or why a disable was refused. */
  detail: string;
}

/**
 * §16 — the at-rest vault's observable state. Everything here is read from the
 * state file and the payload folders by the core — never derived from the
 * passphrase, which the core does not retain between operations.
 */
export interface VaultStatus {
  /** True while the vault is enabled (its state file exists). */
  enabled: boolean;
  /** When the vault was enabled, if it is. */
  enabledAt: number | null;
  /** The operator account that enabled it. */
  operator: string | null;
  /** Confidential mirrors currently sealed (`.vault` envelopes). */
  sealedFiles: number;
  /** Confidential mirrors still in clear text. Zero while enabled. */
  plaintextFiles: number;
}

/** §15 — a failure the UI must surface rather than swallow. */
export interface CoreFailure {
  id: string;
  kind:
    | 'model_load_failed'
    | 'insufficient_vram'
    | 'corrupt_model'
    | 'ocr_failed'
    | 'invalid_document'
    | 'timeout'
    | 'malformed_tool_call'
    | 'execution_failed'
    | 'private_server_unreachable'
    | 'index_failed';
  message: string;
  /** What the app did instead. */
  recovery?: string;
  at: number;
}

/** One entry in a workspace directory listing. */
export interface FileNode {
  name: string;
  relPath: string;
  isDir: boolean;
  sizeBytes: number;
  modifiedAt: number;
  /** True when this file is present in the knowledge index. */
  indexed?: boolean;
}

export interface FilePreview {
  path: string;
  fileName: string;
  sizeBytes: number;
  modifiedAt: number;
  mimeType: string;
  /** Base64 bytes when the file is small enough to display inline. */
  contentBase64?: string;
  tooLarge: boolean;
}
