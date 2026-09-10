/**
 * Typed bridge to the Rust core.
 *
 * Three rules govern this file:
 *
 *   1. It never fabricates data. If the core is not reachable, every call
 *      rejects with a plain explanation and the UI renders a disconnected
 *      state. There is no simulation path and no demo mode.
 *   2. It never talks to the network itself. All traffic — including to an
 *      approved on-prem server — is mediated by the Rust core so it can be
 *      counted and audited.
 *   3. It does not know which transport it is using. `services/transport.ts`
 *      decides between Zero IPC and HTTP on 127.0.0.1, and every wrapper below
 *      is written once against `call` and `on`. That is why the browser tab and
 *      the desktop window expose exactly the same features: there is no second
 *      set of call sites that could fall behind.
 */

import {
  call,
  on as subscribe,
  startWindowDragging,
  transport,
  type UnlistenFn,
} from './transport';
export { CoreUnavailable, isDesktopShell, transport } from './transport';
import { IMAGE_EXTENSIONS, basename } from './paths';
export { IMAGE_EXTENSIONS, basename } from './paths';
import type {
  AgentMode,
  AgentStep,
  AppSettings,
  Artifact,
  ChatActivityBlock,
  Citation,
  CoreFailure,
  CoreStatus,
  ExposureReport,
  FileChange,
  FileNode,
  FilePreview,
  HardwareStatus,
  HarnessInfo,
  IngestedDocument,
  KnowledgeIndexStats,
  KnowledgeSource,
  InstructionDocument,
  MemoryEntry,
  MemoryInput,
  MemoryKind,
  MemoryScope,
  McpToolSummary,
  ModelEntry,
  ModelRuntime,
  OpenWithEntry,
  RouteRule,
  PermissionDecision,
  PermissionRequest,
  PlanItem,
  DevServerStatus,
  RunPhase,
  SandboxLine,
  SandboxPolicy,
  SandboxRun,
  Session,
  SovereignStatus,
  SubagentEvent,
  SubagentInfo,
  StoreGateDecision,
  StoredMessage,
  TaskKind,
  ToolCallRecord,
  VaultEvent,
  VaultStatus,
  Workspace,
  WorkspaceUpdate,
} from '../types';

/* ------------------------------------------------------------------ */
/* Availability                                                       */
/* ------------------------------------------------------------------ */

/**
 * True when the page is inside the desktop window.
 *
 * This is a question about the transport, not about whether the core is
 * reachable — a browser tab served by the core has the whole command surface and
 * reports `false` here. Use `probe()` to find out whether the core is answering;
 * this is only for the handful of places that need to know whether a native
 * window exists, such as the title bar's own buttons.
 */
export const hasIpc = (): boolean => transport() === 'ipc';

/** Probe the core without throwing, for the status indicator. */
export async function probe(): Promise<CoreStatus> {
  try {
    return await call<CoreStatus>('core_status');
  } catch (e) {
    return {
      state: 'unavailable',
      // Reaching this point means a transport existed and the request still
      // failed, so the honest report is "attached, not answering".
      ipc: true,
      router: false,
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

/* ------------------------------------------------------------------ */
/* §1 / §2  Models                                                    */
/* ------------------------------------------------------------------ */

export const models = {
  /** Live state for every registry entry, straight from the router. */
  list: () => call<ModelRuntime[]>('model_list'),
  catalogue: () => call<ModelEntry[]>('model_catalogue_list'),
  setContext: (modelId: string, contextSize: number | null) => call<ModelEntry[]>('model_context_set', { modelId, contextSize }),
  add: (model: ModelEntry, replace = false) => call<ModelEntry[]>('model_catalogue_add', { model, replace }),
  routes: () => call<RouteRule[]>('model_routing_list'),
  setRoute: (kind: TaskKind, modelId: string, fallbackModelId?: string) =>
    call<RouteRule[]>('model_routing_set', {
      kind,
      modelId,
      fallbackModelId: fallbackModelId ?? null,
    }),
  load: (id: string) => call<ModelRuntime>('model_load', { id }),
  /**
   * Frees a resident model. The router keeps reporting the entry — a model it
   * knows about but has not loaded is still catalogued — so what comes back is
   * the same `ModelRuntime` with `loaded` false.
   */
  evict: (id: string) => call<ModelRuntime>('model_evict', { id }),
  routerStart: () => call<CoreStatus>('router_start'),
  routerStop: () => call<CoreStatus>('router_stop'),
  routerRestart: () => call<CoreStatus>('router_restart'),
};

export const pickSettingsPath = (kind: 'model' | 'projector' | 'executable' | 'directory') =>
  call<string | null>('settings_pick_path', { kind });

export const integrations = {
  installMcp: (packageSpec: string, nodePath?: string) =>
    call<import('../types').McpServerConfig>('mcp_install_npm', { packageSpec, nodePath }),
  probeMcp: (serverId: string) => call<McpToolSummary[]>('mcp_probe', { serverId }),
  testWebSearch: (query: string) => call<string>('web_search_test', { query }),
};

/* ------------------------------------------------------------------ */
/* Telemetry                                                          */
/* ------------------------------------------------------------------ */

export const telemetry = {
  hardware: () => call<HardwareStatus>('hardware_status'),
  sovereign: () => call<SovereignStatus>('sovereign_status'),
  /**
   * §11 — whether the folders this app writes to are replicated off the machine.
   *
   * Reads the Windows sync-root registrations and the files' own cloud
   * attributes. It never looks at the folder name, which is why a directory
   * called `OneDrive` on a machine with no OneDrive account comes back local.
   * Runs a bounded file walk, so it is a request the UI makes on demand rather
   * than a poll; the core also pushes `core://exposure` whenever a folder
   * setting or a workspace changes.
   */
  exposure: () => call<ExposureReport>('sync_exposure'),
};

/* ------------------------------------------------------------------ */
/* Workspaces and files                                               */
/* ------------------------------------------------------------------ */

export const workspaces = {
  list: () => call<Workspace[]>('workspace_list'),
  /** Opens the OS folder picker, then registers the choice unapproved. */
  add: () => call<Workspace | null>('workspace_add'),
  /** Chooses a source folder to copy later; it does not register a workspace. */
  pickSource: () => call<string | null>('workspace_source_pick'),
  /** Creates an approved project. With a location, the workspace is rooted at
   *  that operator-chosen folder; without one, under the sovereign projects
   *  root as before. */
  create: (name: string, sourcePaths: string[], locationPath?: string | null) =>
    call<Workspace>('workspace_create', { name, sourcePaths, locationPath: locationPath ?? null }),
  update: (id: string, update: WorkspaceUpdate) =>
    call<Workspace>('workspace_update', { id, update }),
  approve: (id: string) => call<Workspace>('workspace_approve', { id }),
  remove: (id: string, detachSessionIds: string[] = []) =>
    call<void>('workspace_remove', { id, detachSessionIds }),
};

export const files = {
  list: (workspaceId: string, relPath: string) =>
    call<FileNode[]>('fs_list', { workspaceId, relPath }),
  read: (workspaceId: string, relPath: string) =>
    call<string>('fs_read', { workspaceId, relPath }),
  /** Reads an approved local file for the in-panel viewer. */
  preview: (path: string) => call<FilePreview>('fs_preview', { path }),
  /**
   * Saves an edit made in the file panel, answering with the file as it is on
   * disk afterwards — so what the panel shows next is the file, not the buffer
   * that was sent. Existing files only; see `fsops::save_text` for why.
   */
  write: (path: string, content: string) => call<FilePreview>('fs_write', { path, content }),
  /** Reveal in Explorer. Never opens a network location. */
  reveal: (path: string) => call<void>('fs_reveal', { path }),
  /** Open in whatever the machine registered as the default handler. */
  openDefault: (path: string) => call<void>('fs_open_default', { path }),
  /** Installed applications the machine offers for a file, default first. */
  openWithList: (path: string) => call<OpenWithEntry[]>('fs_open_with_list', { path }),
  /** Launch one installed program with a file. No shell is involved. */
  openWith: (path: string, exe: string) => call<void>('fs_open_with', { path, exe }),
  /** Save dialog plus copy. Answers the destination path, or null if cancelled. */
  saveCopyAs: (path: string) => call<string | null>('fs_save_copy_as', { path }),
};

/* ------------------------------------------------------------------ */
/* §4  Documents                                                      */
/* ------------------------------------------------------------------ */

export const documents = {
  /** Native extraction is attempted first; OCR only if there is no text layer. */
  ingest: (path: string) => call<IngestedDocument>('document_ingest', { path }),
  get: (id: string) => call<IngestedDocument>('document_get', { id }),
  pageImage: (id: string, page: number) => call<string | null>('document_page_image', { id, page }),
  list: () => call<IngestedDocument[]>('document_list'),
  /** Opens the file picker and returns the chosen paths. */
  pick: () => call<string[]>('document_pick'),
  /** Forgets what was read out of a file. The file on disk is untouched. */
  remove: (id: string) => call<void>('document_remove', { id }),
};

/* ------------------------------------------------------------------ */
/* §5  Knowledge base                                                 */
/* ------------------------------------------------------------------ */

export const knowledge = {
  stats: () => call<KnowledgeIndexStats>('knowledge_stats'),
  list: () => call<KnowledgeSource[]>('knowledge_list'),
  index: (paths: string[]) => call<KnowledgeSource[]>('knowledge_index', { paths }),
  reindex: (id: string) => call<KnowledgeSource>('knowledge_reindex', { id }),
  remove: (id: string) => call<void>('knowledge_remove', { id }),
  setWatching: (on: boolean) => call<KnowledgeIndexStats>('knowledge_watch', { on }),
};

/* ------------------------------------------------------------------ */
/* §10  Artifacts                                                     */
/* ------------------------------------------------------------------ */

export const artifacts = {
  list: () => call<Artifact[]>('artifact_list'),
  /** Reopens and parses the file, then records the result. */
  verify: (id: string) => call<Artifact>('artifact_verify', { id }),
  open: (id: string) => call<void>('artifact_open', { id }),
};

/* ------------------------------------------------------------------ */
/* §8  Sandbox                                                        */
/* ------------------------------------------------------------------ */

export const sandbox = {
  policy: () => call<SandboxPolicy>('sandbox_policy'),
  run: (command: string) => call<SandboxRun>('sandbox_run', { command }),
  kill: (runId: string) => call<void>('sandbox_kill', { runId }),
  history: () => call<SandboxRun[]>('sandbox_history'),
};

/* ------------------------------------------------------------------ */
/* Persistent dev servers                                              */
/* ------------------------------------------------------------------ */

/**
 * One dev server per workspace, managed by the core. A server started by the
 * agent's `start_dev_server` tool outlives the run that started it; these are
 * the composer-bar controls for it. `start` resolves only once the URL has
 * answered HTTP, so a resolved promise carries a link that works.
 */
export const devservers = {
  start: (workspaceId: string, command?: string) =>
    call<DevServerStatus>('devserver_start', { workspaceId, command: command ?? null }),
  stop: (workspaceId: string) => call<void>('devserver_stop', { workspaceId }),
  status: () => call<DevServerStatus[]>('devserver_status'),
  /** Opens one of our own dev server URLs in the operator's browser. */
  open: (url: string) => call<void>('devserver_open', { url }),
};

/* ------------------------------------------------------------------ */
/* §12  Audit                                                         */
/* ------------------------------------------------------------------ */

export const audit = {
  list: (limit = 200) => call<ToolCallRecord[]>('audit_list', { limit }),
  /** §11 store-gate refusals and audited overrides, newest first. */
  gates: (limit = 50) => call<StoreGateDecision[]>('store_gate_list', { limit }),
};

/* ------------------------------------------------------------------ */
/* §16  At-rest vault                                                 */
/* ------------------------------------------------------------------ */

export const vault = {
  /** The vault's observable state — never derived from a passphrase. */
  status: () => call<VaultStatus>('vault_status'),
  /** §16 vault lifecycle ledger, newest first. */
  events: (limit = 50) => call<VaultEvent[]>('vault_event_list', { limit }),
  /** Set a passphrase and seal every existing confidential mirror to ciphertext. */
  enable: (passphrase: string) => call<VaultStatus>('vault_enable', { passphrase }),
  /** Restore sealed mirrors to plaintext; requires the passphrase that armed it. */
  disable: (passphrase: string) => call<VaultStatus>('vault_disable', { passphrase }),
};

/* ------------------------------------------------------------------ */
/* §6  Agent orchestrator                                             */
/* ------------------------------------------------------------------ */

export interface StartRunInput {
  sessionId: string;
  /**
   * Null when no folder is open. A workspace makes *file* tools legal; it is not
   * a precondition for asking a question or reading an attachment, so the core
   * takes this as optional and refuses individual tools by name instead.
   */
  workspaceId: string | null;
  mode: AgentMode;
  prompt: string;
  /** Absolute paths of files the user attached to this turn. */
  attachments: string[];
  useMemories: boolean;
  contributeMemories: boolean;
}

export type TurnInput =
  | { type: 'text'; text: string }
  | { type: 'localImage'; path: string }
  | { type: 'localFile'; path: string };

export interface StartTurnInput {
  threadId: string;
  workspaceId: string | null;
  mode: AgentMode;
  input: TurnInput[];
  useMemories: boolean;
  contributeMemories: boolean;
}

/** Build a typed local input without opening or reading the selected file. */
export const localTurnInput = (path: string): TurnInput => {
  const fileName = basename(path);
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() ?? '' : '';
  return IMAGE_EXTENSIONS.has(extension)
    ? { type: 'localImage', path }
    : { type: 'localFile', path };
};

export const turns = {
  /** The sole composer boundary that starts model routing and agent work. */
  start: (input: StartTurnInput) =>
    call<{ runId: string; sessionId: string }>('turn_start', { input }),
};

/** Compatibility surface for older local clients. New UI code uses `turns`. */
export const agent = {
  start: (input: StartRunInput) =>
    call<{ runId: string; sessionId: string }>('agent_start', { input }),
  cancel: (runId: string) => call<void>('agent_cancel', { runId }),
  subagents: {
    list: (rootSessionId: string, pathPrefix?: string) =>
      call<SubagentInfo[]>('subagent_list', { rootSessionId, pathPrefix }),
    history: (rootSessionId: string, target: string) =>
      call<StoredMessage[]>('subagent_history', { rootSessionId, target }),
    message: (rootSessionId: string, target: string, message: string) =>
      call<SubagentInfo>('subagent_message', { rootSessionId, target, message }),
    interrupt: (rootSessionId: string, target: string) =>
      call<SubagentInfo>('subagent_interrupt', { rootSessionId, target }),
  },
  respondToPermission: (requestId: string, decision: PermissionDecision) =>
    call<void>('permission_respond', { requestId, decision }),
  /** Deliver a typed reply to a mid-run `ask_operator` question. */
  answerQuestion: (questionId: string, answer: string) =>
    call<void>('question_answer', { questionId, answer }),
  /** Apply or discard a proposed file change after review. */
  applyChange: (runId: string, path: string) =>
    call<void>('change_apply', { runId, path }),
  discardChange: (runId: string, path: string) =>
    call<void>('change_discard', { runId, path }),
  /** One approval for every proposal in a run. The reply lists the files that
   *  did not make it — empty means all went through. */
  applyAllChanges: (runId: string) =>
    call<{ path: string; reason: string }[]>('change_apply_all', { runId }),
  discardAllChanges: (runId: string) =>
    call<{ path: string; reason: string }[]>('change_discard_all', { runId }),
};

/* ------------------------------------------------------------------ */
/* §12  Conversations                                                 */
/* ------------------------------------------------------------------ */

/**
 * The transcript is the core's, not the page's.
 *
 * A turn is written to SQLite as it happens, and the same rows are what the
 * model is replayed on the next turn. That is the whole reason this exists: if
 * the UI kept the conversation and the core kept nothing, the agent would answer
 * every question as though it were the first — which is exactly what it did
 * before §12 landed. Reloading the tab or restarting the app now costs the
 * conversation nothing.
 */
export const sessions = {
  list: () => call<Session[]>('session_list'),
  /** Oldest-first, capped at the same depth the model is replayed. */
  history: (sessionId: string) => call<StoredMessage[]>('session_history', { sessionId }),
  /**
   * Attaches a finished run's activity timeline to its stored row, so a
   * reload replays the steps, thinking and commentary that were on screen.
   * Display-only: the core stores the JSON and never reads it back. Called by
   * the done handler right after the run's message is committed; best effort,
   * and a turn that ended as the app closed simply keeps no timeline.
   */
  storeActivity: (sessionId: string, runId: string, activity: ChatActivityBlock[]) =>
    call<boolean>('session_activity_store', { sessionId, runId, activity }),
  remove: (sessionId: string) => call<void>('session_delete', { sessionId }),
  setMemory: (sessionId: string, useMemories: boolean, contributeMemories: boolean) =>
    call<Session>('session_memory', { sessionId, useMemories, contributeMemories }),
  /**
   * Rebinds a stored chat to a project, or detaches it with `null`. The
   * first turn's COALESCE on the store side only ever *sets* a workspace, so
   * an explicit clear — "don't work in a project" — has to travel through
   * this command or the next session_list reload would quietly put the chat
   * back under the project.
   */
  setWorkspace: (sessionId: string, workspaceId: string | null) =>
    call<void>('session_workspace', { sessionId, workspaceId }),
  /**
   * Renames a chat, pins it to the sidebar's top, or archives it out of the
   * list. Every field travels, because for a chat that has not sent its
   * first turn there is no store row yet and the core creates one from the
   * mode and binding sent here — a rename or pin made before the first
   * message would otherwise be dropped by the next session_list reload.
   * Answers with the stored row, its title clamped, so the screen can sync.
   */
  update: (sessionId: string, state: {
    title: string;
    pinned: boolean;
    archived: boolean;
    mode: AgentMode;
    workspaceId: string | null;
  }) =>
    call<Session>('session_update', { sessionId, ...state }),
  /**
   * Deletes one operator message and every turn after it in the store. The
   * frontend then re-sends the corrected wording as a fresh turn, which is how
   * editing an earlier message rewrites the conversation from that point.
   */
  truncate: (sessionId: string, messageId: string) =>
    call<void>('session_truncate', { sessionId, messageId }),
};

/* ------------------------------------------------------------------ */
/* Pasted images                                                       */
/* ------------------------------------------------------------------ */

export const attachments = {
  /** Writes pasted clipboard pixels under the sovereign root and answers with
   *  the path, so the turn can attach it exactly like a picked file. The core
   *  answers a bare path string — like `fs_read` answers text — not an object. */
  stage: (name: string, mimeType: string, dataBase64: string) =>
    call<string>('attachment_stage', { name, mimeType, dataBase64 }),
};

/* ------------------------------------------------------------------ */
/* Harness, memories and durable instructions                          */
/* ------------------------------------------------------------------ */

export const harness = {
  info: (workspaceId?: string) => call<HarnessInfo>('harness_info', { workspaceId }),
  memories: {
    list: (workspaceId?: string) => call<MemoryEntry[]>('memory_list', { workspaceId }),
    add: (input: MemoryInput) => call<MemoryEntry>('memory_add', { input }),
    update: (
      id: string,
      patch: Partial<Pick<MemoryEntry, 'title' | 'content' | 'kind' | 'enabled'>>,
    ) => call<MemoryEntry>('memory_update', { id, patch }),
    remove: (id: string) => call<void>('memory_remove', { id }),
  },
  instructions: {
    get: (scope: MemoryScope, workspaceId?: string) =>
      call<InstructionDocument>('instructions_get', { scope, workspaceId }),
    set: (scope: MemoryScope, content: string, workspaceId?: string) =>
      call<InstructionDocument>('instructions_set', { scope, content, workspaceId }),
  },
};

// These exports keep form code honest without duplicating string unions.
export type { MemoryInput, MemoryKind, MemoryScope };

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */

export const settings = {
  get: () => call<AppSettings>('settings_get'),
  set: (patch: Partial<AppSettings>) => call<AppSettings>('settings_set', { patch }),
};

/* ------------------------------------------------------------------ */
/* Events                                                             */
/* ------------------------------------------------------------------ */

export interface RunDone {
  runId: string;
  sessionId: string;
  mode: AgentMode;
  elapsedMs: number;
  tokensPerSec?: number;
  modelId?: string;
  /** Authoritative final answer; deltas are only a live rendering aid. */
  message: string;
  summary: string;
  citations: Citation[];
  /**
   * Files the run wants to write, still unwritten. Nothing else in the
   * contract carries a FileChange, so without this the review panel could
   * never populate. Applying one is a separate, explicit act.
   */
  changes: FileChange[];
  /** Set only when the run failed; the chat shows it as the failure banner. */
  failure?: string;
  /** The final checklist, on success and failure alike. */
  plan?: PlanItem[];
}

export interface RunUserStored {
  runId: string;
  sessionId: string;
  /** The store's row id of the operator message just persisted. */
  messageId: string;
}

export interface RunText {
  runId: string;
  sessionId: string;
  /** Commentary separates tool rounds; answer is the final streamed reply;
   *  thinking is the model's reasoning, present only when Extended Thinking
   *  is enabled in Settings. */
  kind?: 'commentary' | 'answer' | 'thinking';
  /** Answer and commentary are user-visible text. Thinking deltas are the
   *  model's own reasoning stream, kept separate from the answer. */
  delta: string;
}

/** `agent://plan` — the run's live plan, whole, as last published. */
export interface RunPlan {
  runId: string;
  sessionId: string;
  items: PlanItem[];
}

/** `agent://question` — a run paused on `ask_operator`, awaiting a typed reply. */
export interface OperatorQuestion {
  id: string;
  runId: string;
  sessionId: string;
  question: string;
  context?: string | null;
  createdAt: number;
}

/** Every event the core can push. Names mirror the Rust side exactly. */
export interface CoreEvents {
  'agent://step': AgentStep;
  'agent://text': RunText;
  'agent://plan': RunPlan;
  'agent://phase': RunPhase;
  'agent://question': OperatorQuestion;
  'agent://permission': PermissionRequest;
  'agent://done': RunDone;
  'agent://user-stored': RunUserStored;
  'agent://failure': CoreFailure;
  'agent://subagent': SubagentEvent;
  'devserver://status': DevServerStatus;
  'core://hardware': HardwareStatus;
  'core://sovereign': SovereignStatus;
  'core://exposure': ExposureReport;
  'core://model': ModelRuntime;
  'core://status': CoreStatus;
  'sandbox://line': SandboxLine & { runId: string; agentRunId?: string; sessionId?: string };
  'knowledge://progress': KnowledgeSource;
}

/**
 * Subscribe to a core event.
 *
 * Identical bytes over either transport: `AppState::emit` serialises the payload
 * once and hands the result to both the webview and the SSE channel, so a
 * component cannot behave differently depending on how the page was opened.
 */
export async function on<K extends keyof CoreEvents>(
  event: K,
  handler: (payload: CoreEvents[K]) => void,
): Promise<UnlistenFn> {
  return subscribe<CoreEvents[K]>(event, handler);
}

/* ------------------------------------------------------------------ */
/* Window controls (the title bar is custom, decorations are off)      */
/* ------------------------------------------------------------------ */

/** How this launch is being served. */
export interface WebInfo {
  /** Browser URL including this launch's session token, or null if HTTP is off. */
  url: string | null;
  /** True when no desktop window exists, so the tab is the only UI. */
  headless: boolean;
}

export const win = {
  startDragging: startWindowDragging,
  minimize: () => call<void>('window_minimize'),
  toggleMaximize: () => call<void>('window_toggle_maximize'),
  close: () => call<void>('window_close'),
  /** Asked once at startup so the shell knows which controls make sense. */
  info: () => call<WebInfo>('web_info'),
  /**
   * Stops the core. This is the only way out of a headless session, where
   * closing the tab leaves the process running on purpose — a long OCR or
   * indexing job should survive an accidentally closed window.
   */
  quit: () => call<void>('app_quit'),
};
