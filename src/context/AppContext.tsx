import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  AgentMode,
  AgentStep,
  AppSettings,
  ApprovalPolicy,
  Artifact,
  ChatActivityBlock,
  ChatMessage,
  CoreFailure,
  DevServerStatus,
  ExposureReport,
  CoreStatus,
  RunPhase,
  FileChange,
  HardwareStatus,
  HarnessInfo,
  IngestedDocument,
  KnowledgeIndexStats,
  KnowledgeSource,
  InstructionDocument,
  MemoryEntry,
  MemoryInput,
  MemoryScope,
  ModelEntry,
  ModelRuntime,
  RouteRule,
  PanelTab,
  PanelTabKind,
  PermissionDecision,
  PermissionRequest,
  OperatorQuestion,
  PlanItem,
  SandboxPolicy,
  SandboxRun,
  Session,
  SettingsPage,
  SovereignStatus,
  StoredMessage,
  ToolCallRecord,
  TaskKind,
  ViewName,
  Workspace,
  WorkspaceUpdate,
} from '../types';
import * as core from '../services/core';
import {
  DEFAULT_SANDBOX_POLICY,
  DEFAULT_SETTINGS,
  INITIAL_RUNTIME,
  MODEL_REGISTRY,
  ROUTING_RULES,
  VRAM_BUDGET_MB,
  VRAM_TOTAL_MB,
} from '../services/registry';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const upsertActivityStep = (
  blocks: ChatActivityBlock[],
  step: AgentStep,
): ChatActivityBlock[] => {
  const blockIndex = blocks.findIndex(
    (block) => block.type === 'actions' && block.steps.some((item) => item.id === step.id),
  );
  if (blockIndex !== -1) {
    return blocks.map((block, index) =>
      index === blockIndex && block.type === 'actions'
        ? {
            ...block,
            steps: block.steps.map((item) => (item.id === step.id ? step : item)),
          }
        : block,
    );
  }

  const last = blocks[blocks.length - 1];
  if (last?.type === 'actions') {
    return [
      ...blocks.slice(0, -1),
      { ...last, steps: [...last.steps, step] },
    ];
  }
  return [...blocks, { id: uid('activity'), type: 'actions', steps: [step] }];
};

/**
 * `since` is when the previous timeline entry ended — the moment the model was
 * handed the turn. A new block takes it as its own start so that "Thought for
 * 4.2 s" measures the wait the operator actually sat through. Measuring from
 * the block's own first delta would read 0 ms for a tool round, whose
 * reasoning is not streamed and arrives in a single delta.
 */
const appendActivityText = (
  blocks: ChatActivityBlock[],
  kind: 'commentary' | 'answer' | 'thinking',
  delta: string,
  since: number,
): ChatActivityBlock[] => {
  if (!delta) return blocks;
  const now = Date.now();
  const last = blocks[blocks.length - 1];
  if (last?.type === 'text' && last.kind === kind) {
    return [...blocks.slice(0, -1), { ...last, text: last.text + delta, endedAt: now }];
  }
  return [
    ...blocks,
    { id: uid('activity'), type: 'text', kind, text: delta, startedAt: since, endedAt: now },
  ];
};

/**
 * A plan revision replaces, it never merges: the event carries the complete
 * list. Plans no longer live in the activity timeline at all — the run's plan
 * is one field updated in place (see `LiveRun.plan`), rendered by the docked
 * task panel, so a revision can never stack a second checklist.
 */

/**
 * Live sandbox output appends to one console block per command: a new block
 * when a command starts, further lines into it. Capped from the front, not
 * the back — the tail is where a build error lands, and that is the part the
 * operator is watching for.
 */
const CONSOLE_MAX_CHARS = 6000;
const appendActivityConsole = (
  blocks: ChatActivityBlock[],
  line: string,
): ChatActivityBlock[] => {
  const last = blocks[blocks.length - 1];
  if (last?.type === 'console') {
    let text = `${last.text}${line}\n`;
    if (text.length > CONSOLE_MAX_CHARS) text = text.slice(text.length - CONSOLE_MAX_CHARS);
    return [...blocks.slice(0, -1), { ...last, text }];
  }
  return [...blocks, { id: uid('activity'), type: 'console', text: `${line}\n` }];
};

/** Replace lossy streamed answer chunks with the authoritative done payload. */
const finalizeActivity = (blocks: ChatActivityBlock[], answer: string): ChatActivityBlock[] => {
  let insertedAnswer = false;
  const final: ChatActivityBlock[] = [];
  for (const block of blocks) {
    if (block.type !== 'text' || block.kind !== 'answer') {
      final.push(block);
      continue;
    }
    if (!insertedAnswer && answer) {
      final.push({ ...block, text: answer });
      insertedAnswer = true;
    }
  }
  if (!insertedAnswer && answer) {
    final.push({ id: uid('activity'), type: 'text', kind: 'answer', text: answer });
  }
  return final;
};

/**
 * Whether two spellings name the same file.
 *
 * The core canonicalises what it stores, but a path arriving from somewhere else
 * — an index row, a citation, a typed argument — may still carry the other
 * separator or a different drive-letter case, and Windows treats all of those as
 * one file.
 */
const samePath = (a: string, b: string) =>
  a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

/** One chat's in-flight turn. Exists from just before the start request until
 *  the run's authoritative `agent://done`. */
interface LiveRun {
  /** Filled in when the start reply lands; steps and text route by session. */
  runId: string;
  steps: AgentStep[];
  activity: ChatActivityBlock[];
  /** The run's single plan, updated in place — never a timeline entry. */
  plan: PlanItem[];
  /** The run's current phase, straight from the core. `null` until the first
   *  `agent://phase` arrives; the spinner and status row render from this. */
  phase: RunPhase | null;
  /** When this run last produced anything the operator can see — a step, a
   *  delta, a console line. The next text block starts its clock here, which
   *  is what lets a whole-arrival reasoning block report a real duration. */
  lastEventAt: number;
}

/** Classification only; this never opens or reads the draft attachment. */
const draftAttachmentKind = (path: string) =>
  core.localTurnInput(path).type === 'localImage' ? ('image' as const) : ('text' as const);

/**
 * Reads a stored transcript back into the shape the transcript view renders.
 *
 * Attachments arrive as the paths the turn was given. Size and kind are not
 * on the row — they were read off disk when the file was attached — and the
 * transcript shows neither, only the file name, so nothing here is invented
 * to fill a field.
 *
 * The stored plan rides on the message itself and is rendered by the docked
 * task panel, so a reopened chat replays its checklist and the plan-mode
 * handoff card — an unexecuted plan survives the restart that ended the run
 * which drew it.
 */
const rehydrate = (m: StoredMessage): ChatMessage => ({
  id: m.id,
  sender: m.sender,
  content: m.content,
  createdAt: m.createdAt,
  citations: m.citations,
  modelId: m.modelId,
  mode: m.mode,
  elapsedMs: m.elapsedMs,
  tokensPerSec: m.tokensPerSec,
  failure: m.failure,
  plan: m.plan?.length ? m.plan : undefined,
  attachments: m.attachments?.map((path, i) => ({
    id: `${m.id}-att-${i}`,
    path,
    fileName: path.split(/[\\/]/).pop() ?? path,
    kind: draftAttachmentKind(path),
    sizeBytes: 0,
  })),
});

/** Zeroed telemetry. Shown only until the core reports real numbers. */
const EMPTY_HARDWARE: HardwareStatus = {
  gpuName: 'not reported',
  vramUsedMb: 0,
  vramTotalMb: VRAM_TOTAL_MB,
  vramBudgetMb: VRAM_BUDGET_MB,
  gpuUtilPct: 0,
  cpuName: 'not reported',
  cpuUtilPct: 0,
  ramUsedMb: 0,
  ramTotalMb: 0,
  offloading: false,
};

const EMPTY_SOVEREIGN: SovereignStatus = {
  operator: 'unknown-operator',
  publicInternetBytes: 0,
  privateServerBytes: 0,
  deviceRequests: 0,
  privateServerRequests: 0,
  egressBlocked: false,
  privateServerName: null,
};

const EMPTY_KNOWLEDGE: KnowledgeIndexStats = {
  documents: 0,
  chunks: 0,
  indexBytes: 0,
  embeddingModelId: 'bge-m3',
  embeddingDim: 1024,
  watching: false,
  watchedFolders: [],
};

/* ------------------------------------------------------------------ */
/* Context shape                                                      */
/* ------------------------------------------------------------------ */

interface AppContextValue {
  /* Shell */
  view: ViewName;
  setView: (v: ViewName) => void;
  settingsPage: SettingsPage;
  openSettings: (page?: SettingsPage) => void;
  isSearchOpen: boolean;
  setIsSearchOpen: (v: boolean) => void;

  /* Core connection (§15) */
  coreStatus: CoreStatus;
  refreshCore: () => Promise<void>;
  failures: CoreFailure[];
  dismissFailure: (id: string) => void;

  /* Telemetry (§2, §11) */
  hardware: HardwareStatus;
  sovereign: SovereignStatus;
  /**
   * §11 — the replication check over every folder the app writes to.
   *
   * `null` means it has not run yet, and the UI must say so rather than
   * render an empty report as a clean one. "Nothing was examined" and
   * "nothing was found" are different findings.
   */
  exposure: ExposureReport | null;
  refreshExposure: () => Promise<void>;

  /* Models (§1, §2) */
  catalogueModels: ModelEntry[];
  modelRuntime: Record<string, ModelRuntime>;
  loadedModelIds: string[];
  addCatalogueModel: (model: ModelEntry) => Promise<void>;
  routeRules: RouteRule[];
  updateModelRoute: (
    kind: TaskKind,
    modelId: string,
    fallbackModelId?: string,
  ) => Promise<void>;
  loadModel: (id: string) => Promise<void>;
  evictModel: (id: string) => Promise<void>;

  /* Workspaces (§8) */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeWorkspace: Workspace | null;
  setActiveWorkspaceId: (id: string | null) => void;
  addWorkspace: () => void;
  isCreateProjectOpen: boolean;
  setIsCreateProjectOpen: (open: boolean) => void;
  pickProjectSource: () => Promise<string | null>;
  /** `locationPath` roots the new project's workspace at an operator-chosen
   *  directory instead of the app-owned container: every file the agent writes,
   *  command it runs, and dev server it starts stays inside that folder. */
  createWorkspace: (
    name: string,
    sourcePaths: string[],
    locationPath?: string,
  ) => Promise<boolean>;
  updateWorkspace: (id: string, update: WorkspaceUpdate) => Promise<boolean>;
  openWorkspaceInExplorer: (id: string) => Promise<void>;
  approveWorkspace: (id: string) => Promise<void>;
  removeWorkspace: (id: string, detachSessionIds?: string[]) => Promise<boolean>;

  /* Dev servers (§8) */
  /** Every dev server the core is holding, keyed by workspace id. A server
   *  outlives the run that started it, so this state is independent of the
   *  conversation. */
  devServers: Record<string, DevServerStatus>;
  /** The active project's dev server, if it has one. */
  activeDevServer: DevServerStatus | null;
  startDevServer: (workspaceId: string, command?: string) => Promise<void>;
  stopDevServer: (workspaceId: string) => Promise<void>;
  openDevServerUrl: (url: string) => Promise<void>;

  /* Sessions */
  sessions: Session[];
  activeSessionId: string | null;
  activeSession: Session | null;
  openSession: (id: string) => void;
  newSession: (
    scope?: 'auto' | 'personal' | 'project',
    workspaceIdOverride?: string,
  ) => string | null;
  deleteSession: (id: string) => Promise<void>;
  setSessionMemory: (useMemories: boolean, contributeMemories: boolean) => Promise<void>;

  /* Conversation (§6) */
  messages: ChatMessage[];
  mode: AgentMode;
  setMode: (m: AgentMode) => void;
  /** The open chat has a turn in flight. Chats run concurrently, so this is
   *  per-chat: a busy chat elsewhere does not lock this one's composer. */
  isRunning: boolean;
  /** Any chat has a turn in flight. For surfaces that report the machine,
   *  not one conversation. */
  anyRunning: boolean;
  /** Every chat with a turn in flight. */
  runningSessionIds: string[];
  /** The open chat's streamed steps and actions, empty when it is idle. */
  liveSteps: AgentStep[];
  liveActivity: ChatActivityBlock[];
  /** The open chat's current plan while a run is live, and the last agent
   *  message's plan when it is not — one checklist, docked at the bottom. */
  livePlan: PlanItem[];
  /** The open chat's current run phase: what the core says it is doing now.
   *  `null` when idle or before the first phase event. */
  livePhase: RunPhase | null;
  send: (
    prompt: string,
    attachmentPaths?: string[],
    intoSession?: string,
    modeOverride?: AgentMode,
  ) => Promise<boolean>;
  /** Follow-ups typed while the open chat's turn was running, in send order.
   *  Each is delivered automatically when the run ahead of it completes. */
  queuedMessages: string[];
  /** Parks an instruction behind the open chat's running turn. */
  queueMessage: (text: string, intoSession?: string) => void;
  /** Takes a parked instruction back out before it is sent. */
  removeQueued: (index: number, intoSession?: string) => void;
  cancelRun: () => Promise<void>;

  /* Permissions (§9) */
  approvalPolicy: ApprovalPolicy;
  setApprovalPolicy: (p: ApprovalPolicy) => void;
  /** The first of possibly several queued prompts — concurrent chats can each
   *  be waiting on an answer. Answering serves the queue in order. */
  pendingPermission: PermissionRequest | null;
  respondToPermission: (d: PermissionDecision) => Promise<void>;

  /* Mid-run operator questions (§9, `ask_operator`) */
  /** The first of possibly several queued questions, same queue discipline as
   *  permissions. The model waits, blocked, until one is answered. */
  pendingQuestion: OperatorQuestion | null;
  answerQuestion: (answer: string) => Promise<void>;

  /* Right panel */
  isPanelOpen: boolean;
  setIsPanelOpen: (v: boolean) => void;
  tabs: PanelTab[];
  activeTabId: string | null;
  setActiveTabId: (id: string) => void;
  openTab: (kind: PanelTabKind, title?: string, documentId?: string, filePath?: string) => void;
  closeTab: (id: string) => void;

  /* Review (§6) */
  fileChanges: FileChange[];
  selectedChangePath: string | null;
  setSelectedChangePath: (p: string | null) => void;
  applyChange: (path: string) => Promise<void>;
  discardChange: (path: string) => Promise<void>;
  /** One approval for the active session's whole proposal set. Files the core
   *  could not apply stay in the panel with a failure entry each. */
  applyAllChanges: () => Promise<void>;
  discardAllChanges: () => Promise<void>;

  /* Documents (§4) */
  documents: IngestedDocument[];
  activeDocumentId: string | null;
  /** Opens the picker only. The returned draft inputs have not been read. */
  pickAttachments: () => Promise<string[]>;
  ingestFiles: () => Promise<void>;
  openDocument: (id: string) => Promise<void>;
  openDocumentAt: (path: string) => Promise<void>;
  removeDocument: (id: string) => Promise<void>;

  /* Knowledge (§5) */
  knowledgeStats: KnowledgeIndexStats;
  knowledgeSources: KnowledgeSource[];
  indexFiles: () => Promise<void>;
  reindexSource: (id: string) => Promise<void>;
  removeSource: (id: string) => Promise<void>;
  toggleWatching: () => Promise<void>;

  /* Harness memories and instructions */
  harnessInfo: HarnessInfo | null;
  memories: MemoryEntry[];
  globalInstructions: InstructionDocument | null;
  projectInstructions: InstructionDocument | null;
  refreshMemories: () => Promise<void>;
  addMemory: (input: MemoryInput) => Promise<void>;
  updateMemory: (
    id: string,
    patch: Partial<Pick<MemoryEntry, 'title' | 'content' | 'kind' | 'enabled'>>,
  ) => Promise<void>;
  removeMemory: (id: string) => Promise<void>;
  saveInstructions: (scope: MemoryScope, content: string) => Promise<void>;

  /* Artifacts (§10) */
  artifacts: Artifact[];
  openArtifact: (id: string) => Promise<void>;
  verifyArtifact: (id: string) => Promise<void>;

  /* Sandbox (§8) */
  sandboxPolicy: SandboxPolicy;
  sandboxRuns: SandboxRun[];
  runInSandbox: (command: string) => Promise<void>;
  killRun: (runId: string) => Promise<void>;

  /* Audit (§12) */
  auditLog: ToolCallRecord[];
  refreshAudit: () => Promise<void>;

  /* Settings */
  settings: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

const AppContext = createContext<AppContextValue | null>(null);

export const useApp = (): AppContextValue => {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
};

/* ------------------------------------------------------------------ */
/* Provider                                                           */
/* ------------------------------------------------------------------ */

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  /* Shell */
  const [view, setView] = useState<ViewName>('workbench');
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('workbench');
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  /* Core */
  const [coreStatus, setCoreStatus] = useState<CoreStatus>({
    state: 'checking',
    ipc: false,
    router: false,
    detail: 'Checking for the Servergen core…',
  });
  const [failures, setFailures] = useState<CoreFailure[]>([]);

  /* Telemetry */
  const [hardware, setHardware] = useState<HardwareStatus>(EMPTY_HARDWARE);
  const [sovereign, setSovereign] = useState<SovereignStatus>(EMPTY_SOVEREIGN);
  const [exposure, setExposure] = useState<ExposureReport | null>(null);

  /* Models */
  const [catalogueModels, setCatalogueModels] = useState<ModelEntry[]>(MODEL_REGISTRY);
  const [routeRules, setRouteRules] = useState<RouteRule[]>(ROUTING_RULES);
  const [modelRuntime, setModelRuntime] =
    useState<Record<string, ModelRuntime>>(INITIAL_RUNTIME);

  /* Workspaces */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false);

  /* Dev servers — keyed by workspace id, kept in sync by `devserver://status`
   * events and the startup status read. These outlive any single run. */
  const [devServers, setDevServers] = useState<Record<string, DevServerStatus>>({});

  /**
   * The conversation list mirrors the core's `sessions` table (§12), and each
   * transcript is fetched the first time its session is opened rather than all
   * at once — a year of conversations is not something to load to draw a
   * sidebar. A session with no entry in `messagesBySession` has not been read
   * back yet; one with an entry, even an empty one, has. That distinction is
   * what stops a reopen from overwriting the run that just finished on screen
   * with the shorter version the core stores.
   */
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messagesBySession, setMessagesBySession] = useState<Record<string, ChatMessage[]>>({});
  /**
   * Sessions whose transcript has been read back from the core, plus the ones
   * started in this session, which have nothing to read back. Kept in a ref
   * rather than state because it only guards a fetch — nothing renders from it,
   * and a double-invoked state updater must not double-fetch.
   */
  const readBack = useRef<Set<string>>(new Set());

  /* Run state — one slot per chat, so chats run concurrently */
  /**
   * The mode the operator chose survives a restart. A relaunch resetting a
   * deliberate "Agent" back to the default Planning is a choice being undone,
   * not a default being applied: the next message goes out read-only, with
   * nothing on screen to say why the agent suddenly refuses to build. Stored
   * in local storage (the same pattern as appearance preferences) and
   * restored in preference to `defaultMode`, which still governs a machine
   * that has never chosen.
   */
  const [mode, setModeState] = useState<AgentMode>(DEFAULT_SETTINGS.defaultMode);
  const setMode = useCallback((m: AgentMode) => {
    setModeState(m);
    try {
      localStorage.setItem('servergen.composer-mode.v1', m);
    } catch {
      /* A browser with storage blocked still gets the mode for this session. */
    }
  }, []);
  /**
   * The in-flight turn of every chat that has one, keyed by session id. The
   * ref is the authoritative copy (event handlers outlive renders); the state
   * renders it. A chat's entry lives from just before its start request until
   * its authoritative `agent://done`, which is also what keeps a cancelled
   * turn's composer occupied until the core confirms the stop.
   */
  const runsRef = useRef<Record<string, LiveRun>>({});
  const [runsBySession, setRunsBySession] = useState<Record<string, LiveRun>>({});
  /** A repeated completion event must never append the same answer twice. */
  const completedRuns = useRef<Set<string>>(new Set());
  /** Handles the rare case where a very early failure completes before the
   *  `turn_start` response crosses the desktop bridge. */
  const completedBeforeStartReply = useRef<Set<string>>(new Set());
  const startReplySeen = useRef<Set<string>>(new Set());

  /**
   * Follow-ups typed while a chat's turn was still running, per chat. The
   * composer stays usable during a run — Codex-style, the next instruction
   * waits here and is sent on its own the moment the run completes. The ref
   * is authoritative (the done handler fires between renders); the state
   * renders the chips.
   */
  const queuedRef = useRef<Record<string, string[]>>({});
  const [queuedBySession, setQueuedBySession] = useState<Record<string, string[]>>({});
  /** Lets the done handler send the queued follow-up without a dependency
   *  cycle: `send` is defined later and reads state this effect owns. */
  const sendRef = useRef<
    ((prompt: string, attachmentPaths?: string[], intoSession?: string) => Promise<boolean>) | null
  >(null);

  /* Permissions — a queue, because concurrent chats can each be asking */
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    DEFAULT_SETTINGS.approvalPolicy,
  );
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [pendingQuestions, setPendingQuestions] = useState<OperatorQuestion[]>([]);

  /**
   * Applies `f` to one chat's in-flight turn. No-op when the chat has no live
   * run — an event for an unknown or run-less turn is not ours to buffer.
   * Stable identity, so the lifetime-long event handlers can call it.
   */
  const mutateLiveRun = useCallback(
    (sid: string, f: (run: LiveRun) => LiveRun) => {
      const current = runsRef.current[sid];
      if (!current) return;
      runsRef.current = { ...runsRef.current, [sid]: f(current) };
      setRunsBySession(runsRef.current);
    },
    [],
  );

  /* Panel */
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [tabs, setTabs] = useState<PanelTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  /* Review */
  /**
   * Proposed writes per chat, keyed by session id, each with the run that
   * produced them.
   *
   * The core keeps its pending changes keyed by run id for the life of the
   * process, so the handle has to outlive the run or `Write this file` has
   * nothing to name — and with several chats running, each chat's proposals
   * have to stay with that chat rather than overwrite whichever one finished
   * last.
   */
  const [changesBySession, setChangesBySession] = useState<
    Record<string, { runId: string; changes: FileChange[] }>
  >({});
  const [selectedChangePath, setSelectedChangePath] = useState<string | null>(null);

  /* Documents / knowledge / artifacts / sandbox / audit */
  const [documents, setDocuments] = useState<IngestedDocument[]>([]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  /** Documents whose blocks and tables have been read back; see `openDocument`. */
  const hydrated = useRef<Set<string>>(new Set());
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeIndexStats>(EMPTY_KNOWLEDGE);
  const [knowledgeSources, setKnowledgeSources] = useState<KnowledgeSource[]>([]);
  const [harnessInfo, setHarnessInfo] = useState<HarnessInfo | null>(null);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [globalInstructions, setGlobalInstructions] = useState<InstructionDocument | null>(null);
  const [projectInstructions, setProjectInstructions] = useState<InstructionDocument | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [sandboxPolicy, setSandboxPolicy] = useState<SandboxPolicy>(DEFAULT_SANDBOX_POLICY);
  const [sandboxRuns, setSandboxRuns] = useState<SandboxRun[]>([]);
  const [auditLog, setAuditLog] = useState<ToolCallRecord[]>([]);

  /* Settings */
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);

  /* ---------------------------------------------------------------- */
  /* Failure reporting                                                */
  /* ---------------------------------------------------------------- */

  const pushFailure = useCallback((kind: CoreFailure['kind'], message: string, recovery?: string) => {
    setFailures((prev) => [{ id: uid('fail'), kind, message, recovery, at: Date.now() }, ...prev].slice(0, 20));
  }, []);

  const dismissFailure = useCallback((id: string) => {
    setFailures((prev) => prev.filter((f) => f.id !== id));
  }, []);

  /** Run a core call, routing any error into the failure list. */
  const guard = useCallback(
    async <T,>(kind: CoreFailure['kind'], fn: () => Promise<T>): Promise<T | null> => {
      try {
        return await fn();
      } catch (e) {
        pushFailure(kind, e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [pushFailure],
  );

  /* ---------------------------------------------------------------- */
  /* Startup: probe the core, then hydrate everything it owns          */
  /* ---------------------------------------------------------------- */

  const refreshCore = useCallback(async () => {
    const status = await core.probe();
    setCoreStatus(status);
    if (status.state === 'unavailable') return;

    const [hw, sov, rt, catalogue, routes, ws, docs, kStats, kList, arts, pol, aud, cfg, sess, dss] =
      await Promise.all([
        core.telemetry.hardware().catch(() => null),
        core.telemetry.sovereign().catch(() => null),
        core.models.list().catch(() => null),
        core.models.catalogue().catch(() => null),
        core.models.routes().catch(() => null),
        core.workspaces.list().catch(() => null),
        core.documents.list().catch(() => null),
        core.knowledge.stats().catch(() => null),
        core.knowledge.list().catch(() => null),
        core.artifacts.list().catch(() => null),
        core.sandbox.policy().catch(() => null),
        core.audit.list().catch(() => null),
        core.settings.get().catch(() => null),
        core.sessions.list().catch(() => null),
        core.devservers.status().catch(() => null),
      ]);

    if (hw) setHardware(hw);
    if (sov) setSovereign(sov);
    if (rt) setModelRuntime(Object.fromEntries(rt.map((r) => [r.id, r])));
    if (catalogue) setCatalogueModels(catalogue);
    if (routes) setRouteRules(routes);
    if (ws) {
      setWorkspaces(ws);
      setActiveWorkspaceId(
        (cur) =>
          cur ??
          ws.find((workspace) => workspace.approved && !workspace.archived)?.id ??
          ws.find((workspace) => !workspace.archived)?.id ??
          null,
      );
    }
    if (docs) setDocuments(docs);
    if (kStats) setKnowledgeStats(kStats);
    if (kList) setKnowledgeSources(kList);
    if (arts) setArtifacts(arts);
    if (pol) setSandboxPolicy(pol);
    if (aud) setAuditLog(aud);
    // Servers the core held across a reconnect (or that this window missed the
    // status events for), re-read rather than believed absent.
    if (dss) setDevServers(Object.fromEntries(dss.map((s) => [s.workspaceId, s])));
    // Past conversations, newest first. Opening one fetches its transcript.
    if (sess) setSessions(sess);
    if (cfg) {
      setSettings(cfg);
      // Their own last choice outranks the default: see the note on `setMode`.
      let restored: AgentMode | null = null;
      try {
        const stored = localStorage.getItem('servergen.composer-mode.v1');
        if (stored === 'plan' || stored === 'agent') restored = stored;
      } catch {
        /* Storage blocked: the default mode is used, as before. */
      }
      setMode(restored ?? cfg.defaultMode);
      setApprovalPolicy(cfg.approvalPolicy);
      setIsPanelOpen(cfg.showRightPanel);
    }
  }, []);

  /*
   * Kept out of the hydration batch above on purpose. The replication check
   * walks the filesystem, and a cold folder on a slow disk would hold up first
   * paint for something nobody is looking at yet. It runs immediately after,
   * unawaited, so the answer is ready before anyone opens Settings — and the
   * core re-pushes it whenever a folder setting or a workspace changes.
   */
  const refreshExposure = useCallback(async () => {
    const report = await core.telemetry.exposure().catch(() => null);
    if (report) setExposure(report);
  }, []);

  const refreshMemories = useCallback(async () => {
    const workspaceId = activeWorkspaceId ?? undefined;
    const [info, rows, globalDoc, projectDoc] = await Promise.all([
      core.harness.info(workspaceId).catch(() => null),
      core.harness.memories.list(workspaceId).catch(() => null),
      core.harness.instructions.get('global').catch(() => null),
      workspaceId
        ? core.harness.instructions.get('project', workspaceId).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (info) setHarnessInfo(info);
    if (rows) setMemories(rows);
    if (globalDoc) setGlobalInstructions(globalDoc);
    setProjectInstructions(projectDoc);
  }, [activeWorkspaceId]);

  useEffect(() => {
    void refreshCore().then(() => refreshExposure());
  }, [refreshCore, refreshExposure]);

  useEffect(() => {
    if (coreStatus.state === 'checking' || coreStatus.state === 'unavailable') return;
    void refreshMemories();
  }, [coreStatus.state, refreshMemories]);

  /*
   * Over HTTP the event stream can have holes: browsers throttle background
   * tabs, and the core drops events for a slow receiver rather than stalling the
   * agent loop. `services/transport.ts` reports each hole instead of hiding it,
   * and the repair is to re-read everything the core owns — not to reload the
   * page, which would throw away the streamed answer text on screen.
   */
  useEffect(() => {
    const onResync = () => void refreshCore();
    window.addEventListener('sovereign:resync', onResync);
    return () => window.removeEventListener('sovereign:resync', onResync);
  }, [refreshCore]);

  /* ---------------------------------------------------------------- */
  /* Event subscriptions                                              */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const unsubs: Array<() => void> = [];
    let cancelled = false;
    const add = (p: Promise<() => void>) =>
      p.then((u) => {
        if (cancelled) u();
        else unsubs.push(u);
      });

    void add(core.on('core://status', setCoreStatus));
    void add(core.on('core://hardware', setHardware));
    void add(core.on('core://sovereign', setSovereign));
    void add(core.on('core://exposure', setExposure));
    void add(
      core.on('core://model', (m) => setModelRuntime((prev) => ({ ...prev, [m.id]: m }))),
    );

    // §6 — structured steps. Replace in place so a running step can complete.
    // Routed by the session the core stamps on every step: concurrent chats
    // each get their own timeline, and run-less work (a user-initiated ingest)
    // belongs to none of them.
    void add(
      core.on('agent://step', (step) => {
        if (!step.sessionId) return;
        mutateLiveRun(step.sessionId, (run) => {
          const i = run.steps.findIndex((s) => s.id === step.id);
          const steps = i === -1 ? [...run.steps, step] : run.steps.slice();
          if (i !== -1) steps[i] = step;
          return {
            ...run,
            steps,
            activity: upsertActivityStep(run.activity, step),
            lastEventAt: Date.now(),
          };
        });
      }),
    );

    void add(
      core.on('agent://text', (t) => {
        // Deltas carry their session, so a second chat's stream appends to
        // that chat's buffer even while another one is mid-answer.
        mutateLiveRun(t.sessionId, (run) => ({
          ...run,
          activity: appendActivityText(
            run.activity,
            t.kind ?? 'answer',
            t.delta,
            run.lastEventAt,
          ),
          lastEventAt: Date.now(),
        }));
      }),
    );

    // A plan event carries the complete list; it replaces the run's single
    // plan field, so a revision updates the docked checklist in place instead
    // of stacking another one in the timeline. Routed by session like
    // everything else.
    void add(
      core.on('agent://plan', (p) => {
        if (!p?.sessionId || !Array.isArray(p.items)) return;
        mutateLiveRun(p.sessionId, (run) => ({ ...run, plan: p.items }));
      }),
    );

    // The core's authoritative word on what the run is doing *now* — the
    // spinner renders from this, not from a frontend timer, so it starts and
    // stops exactly when reasoning actually starts and stops.
    void add(
      core.on('agent://phase', (ph) => {
        if (!ph?.sessionId) return;
        mutateLiveRun(ph.sessionId, (run) => ({ ...run, phase: ph }));
      }),
    );

    // Dev server lifecycle: one server per workspace, events for every
    // transition — including an unexpected death after the run that started
    // it finished.
    void add(
      core.on('devserver://status', (s) => {
        if (!s?.workspaceId) return;
        setDevServers((prev) => ({ ...prev, [s.workspaceId]: s }));
      }),
    );
    void add(core.on('agent://permission', (req) =>
      setPendingPermissions((prev) => [...prev, req]),
    ));
    // Questions queue alongside permissions: the model is parked on a channel
    // until the operator types a reply or the run is cancelled.
    void add(core.on('agent://question', (q) =>
      setPendingQuestions((prev) => [...prev, q]),
    ));

    void add(
      core.on('knowledge://progress', (src) =>
        setKnowledgeSources((prev) => {
          const i = prev.findIndex((s) => s.id === src.id);
          if (i === -1) return [src, ...prev];
          const next = prev.slice();
          next[i] = src;
          return next;
        }),
      ),
    );

    void add(
      core.on('sandbox://line', (line) => {
        setSandboxRuns((prev) =>
          prev.map((r) =>
            r.id === line.runId ? { ...r, output: [...r.output, line] } : r,
          ),
        );
        // A command a tool call started also streams into its chat's
        // timeline, so a long build shows its progress where the operator is
        // looking instead of only in the console panel. Console-initiated
        // runs carry no session and stay console-only.
        if (line.sessionId) {
          const text = line.stream === 'stderr' ? `[stderr] ${line.text}` : line.text;
          mutateLiveRun(line.sessionId, (run) => ({
            ...run,
            activity: appendActivityConsole(run.activity, text),
            lastEventAt: Date.now(),
          }));
        }
      }),
    );

    void add(
      core.on('agent://failure', (f) => {
        setFailures((prev) => [f, ...prev].slice(0, 20));
      }),
    );

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [mutateLiveRun]);

  /* The done event needs current refresh callback, so it gets its own effect. */
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;

    void core
      .on('agent://done', (done) => {
        // Both transports are at-least-once from the UI's point of view: a
        // reconnect or an accidentally overlapping listener can replay a done
        // notification. The run id is the stable identity of this answer.
        if (completedRuns.current.has(done.runId)) return;
        completedRuns.current.add(done.runId);
        if (completedRuns.current.size > 1_000) {
          const oldest = completedRuns.current.values().next().value;
          if (oldest) completedRuns.current.delete(oldest);
        }

        if (!startReplySeen.current.delete(done.runId)) {
          completedBeforeStartReply.current.add(done.runId);
        }

        // Only this run's chat is touched. A chat that is still streaming
        // keeps its buffers, its composer stays occupied, and its permission
        // prompts stay up — one chat finishing must look like nothing at all
        // to the others.
        const sid = done.sessionId;
        const live = runsRef.current[sid];
        const steps = live?.steps ?? [];
        // A failed run's summary is the failure text; it belongs in the
        // banner (`done.failure`), not repeated as the message body — that is
        // also how the stored message reads after a restart.
        const answer = done.failure ? '' : done.message || done.summary;
        const activity = finalizeActivity(live?.activity ?? [], answer);
        // The authoritative checklist rides on the done event — on failure as
        // well, because a Plan-mode run that died mid-write still published
        // steps and the plan→agent handoff card is built from them. It lands
        // on the message, not in the activity: the checklist is the run's
        // state, rendered by the docked task panel, not a timeline entry.
        const plan = done.plan?.length ? done.plan : live?.plan ?? [];
        if (live) {
          delete runsRef.current[sid];
          setRunsBySession({ ...runsRef.current });
        }
        setPendingPermissions((prev) => prev.filter((p) => p.runId !== done.runId));

        const messageId = `msg-${done.runId}`;
        const message: ChatMessage = {
          id: messageId,
          sender: 'agent',
          content: answer,
          createdAt: Date.now(),
          steps,
          activity,
          plan: plan.length ? plan : undefined,
          citations: done.citations,
          fileChanges: done.changes,
          modelId: done.modelId,
          mode: done.mode,
          elapsedMs: done.elapsedMs,
          tokensPerSec: done.tokensPerSec,
          failure: done.failure,
        };
        setMessagesBySession((prev) => {
          const existing = prev[sid] ?? [];
          if (existing.some((item) => item.id === messageId)) return prev;
          return { ...prev, [sid]: [...existing, message] };
        });

        // §6/§9 — the writes this run made, kept with the chat that made them.
        // They are on disk already: each one was approved as it happened, so
        // the panel is the record of what changed, with a revert beside every
        // entry. Anything left unapplied is still written from there.
        setChangesBySession((prev) => ({
          ...prev,
          [sid]: { runId: done.runId, changes: done.changes ?? [] },
        }));

        // The operator may have typed a follow-up while this run was working.
        // The next queued instruction starts on its own now that the turn is
        // free — one at a time, so the next run starts from this answer's
        // record. Pending file changes do not hold the queue: the model is
        // told which writes are still only proposed, and a follow-up like
        // "also add a contact page" is still meaningful against them.
        const queued = queuedRef.current[sid];
        if (queued && queued.length > 0 && sendRef.current) {
          const [next, ...rest] = queued;
          queuedRef.current =
            rest.length > 0 ? { ...queuedRef.current, [sid]: rest } : (() => {
              const { [sid]: _gone, ...others } = queuedRef.current;
              return others;
            })();
          setQueuedBySession(queuedRef.current);
          void sendRef.current(next, [], sid);
        }

        // Pull anything the run may have produced. A requested deliverable is
        // shown beside the main answer as well as in the artifacts manager.
        void core.artifacts
          .list()
          .then((rows) => {
            setArtifacts(rows);
            const produced = rows.filter((artifact) => artifact.sourceTask === done.runId);
            if (produced.length > 0) {
              setMessagesBySession((prev) => ({
                ...prev,
                [sid]: (prev[sid] ?? []).map((message) =>
                  message.id === messageId ? { ...message, artifacts: produced } : message,
                ),
              }));
            }
          })
          .catch(() => {});
        void core.audit.list().then(setAuditLog).catch(() => {});
        void core.documents.list().then(setDocuments).catch(() => {});
        void refreshMemories();
      })
      .then((u) => {
        if (cancelled) u();
        else unsub = u;
      });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [refreshMemories]);

  /* ---------------------------------------------------------------- */
  /* Derived                                                          */
  /* ---------------------------------------------------------------- */

  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const messages = useMemo(
    () => (activeSessionId ? messagesBySession[activeSessionId] ?? [] : []),
    [messagesBySession, activeSessionId],
  );

  const loadedModelIds = useMemo(
    () =>
      catalogueModels.filter((m) => modelRuntime[m.id]?.state === 'loaded').map((m) => m.id),
    [catalogueModels, modelRuntime],
  );

  /** The open chat's in-flight turn, if it has one. */
  const activeLiveRun = activeSessionId ? runsBySession[activeSessionId] : undefined;
  const liveSteps = activeLiveRun?.steps ?? [];
  const liveActivity = activeLiveRun?.activity ?? [];
  /** While a run is live its plan is the run's; idle, the last agent
   *  message's plan keeps the docked checklist on screen. */
  const livePlan = useMemo(
    () =>
      activeLiveRun?.plan?.length
        ? activeLiveRun.plan
        : ([...(messages ?? [])].reverse().find((m) => m.sender === 'agent' && m.plan?.length)
            ?.plan ?? []),
    [activeLiveRun?.plan, messages],
  );
  const livePhase = activeLiveRun?.phase ?? null;
  const runningSessionIds = useMemo(() => Object.keys(runsBySession), [runsBySession]);
  /** The open chat is generating. Another chat being busy does not lock this
   *  one's composer — that is the whole point of concurrent chats. */
  const isRunning = activeLiveRun !== undefined;
  const anyRunning = runningSessionIds.length > 0;
  /** The open chat's parked follow-ups, in send order. */
  const queuedMessages = activeSessionId ? queuedBySession[activeSessionId] ?? [] : [];

  /**
   * The proposals, but only while the task that produced them is the open one.
   *
   * Filtering rather than clearing on a task switch: the core still holds these,
   * so throwing them away in the UI would strand a real pending write, while
   * showing them under another task would credit it with work it never asked for.
   */
  const activeChangeRun = activeSessionId ? changesBySession[activeSessionId] : undefined;
  const visibleChanges = activeChangeRun?.changes ?? [];
  const activeDevServer = activeWorkspaceId ? devServers[activeWorkspaceId] ?? null : null;

  /* ---------------------------------------------------------------- */
  /* Models                                                           */
  /* ---------------------------------------------------------------- */

  const addCatalogueModel = useCallback(
    async (model: ModelEntry) => {
      if (coreStatus.state === 'unavailable') {
        pushFailure('model_load_failed', 'The local core must be attached before a model can be added.');
        return;
      }
      const models = await guard('model_load_failed', () => core.models.add(model));
      if (!models) return;
      setCatalogueModels(models);
      const runtime = await core.models.list().catch(() => null);
      if (runtime) setModelRuntime(Object.fromEntries(runtime.map((entry) => [entry.id, entry])));
    },
    [coreStatus.state, guard, pushFailure],
  );

  const updateModelRoute = useCallback(
    async (kind: TaskKind, modelId: string, fallbackModelId?: string) => {
      const routes = await guard('model_load_failed', () =>
        core.models.setRoute(kind, modelId, fallbackModelId),
      );
      if (routes) setRouteRules(routes);
    },
    [guard],
  );

  const loadModel = useCallback(
    async (id: string) => {
      setModelRuntime((prev) => ({ ...prev, [id]: { ...prev[id], id, state: 'loading' } }));
      const rt = await guard('model_load_failed', () => core.models.load(id));
      if (rt) setModelRuntime((prev) => ({ ...prev, [id]: rt }));
      else
        setModelRuntime((prev) => ({
          ...prev,
          [id]: { ...prev[id], id, state: 'error', lastError: 'Load failed' },
        }));
    },
    [guard],
  );

  const evictModel = useCallback(
    async (id: string) => {
      setModelRuntime((prev) => ({ ...prev, [id]: { ...prev[id], id, state: 'unloading' } }));
      const rt = await guard('model_load_failed', () => core.models.evict(id));
      setModelRuntime((prev) => ({ ...prev, [id]: rt ?? { id, state: 'unloaded' } }));
    },
    [guard],
  );

  /* ---------------------------------------------------------------- */
  /* Workspaces                                                       */
  /* ---------------------------------------------------------------- */

  const addWorkspace = useCallback(() => {
    setIsCreateProjectOpen(true);
  }, []);

  const pickProjectSource = useCallback(async () => {
    return await guard('execution_failed', () => core.workspaces.pickSource());
  }, [guard]);

  const createWorkspace = useCallback(
    async (name: string, sourcePaths: string[], locationPath?: string) => {
      const ws = await guard('execution_failed', () =>
        core.workspaces.create(name, sourcePaths, locationPath),
      );
      if (!ws) return false;
      setWorkspaces((prev) => [...prev.filter((w) => w.id !== ws.id), ws]);
      setActiveWorkspaceId(ws.id);
      setIsCreateProjectOpen(false);
      return true;
    },
    [guard],
  );

  /** Starts (or restarts) the workspace's dev server. The returned status is
   *  only the first word: subsequent `devserver://status` events carry the
   *  transition to running, so the URL bar updates when the core has actually
   *  verified the port answers. */
  const startDevServer = useCallback(
    async (workspaceId: string, command?: string) => {
      await guard('execution_failed', () => core.devservers.start(workspaceId, command));
    },
    [guard],
  );

  const stopDevServer = useCallback(
    async (workspaceId: string) => {
      await guard('execution_failed', () => core.devservers.stop(workspaceId));
    },
    [guard],
  );

  const openDevServerUrl = useCallback(
    async (url: string) => {
      await guard('execution_failed', () => core.devservers.open(url));
    },
    [guard],
  );

  const approveWorkspace = useCallback(
    async (id: string) => {
      const ws = await guard('execution_failed', () => core.workspaces.approve(id));
      if (ws) setWorkspaces((prev) => prev.map((w) => (w.id === id ? ws : w)));
    },
    [guard],
  );

  const updateWorkspace = useCallback(async (id: string, update: WorkspaceUpdate) => {
    const ws = await guard('execution_failed', () => core.workspaces.update(id, update));
    if (!ws) return false;
    setWorkspaces((prev) => prev.map((item) => (item.id === id ? ws : item)));
    if (update.archived) {
      setActiveWorkspaceId((current) => (current === id ? null : current));
      setActiveSessionId((current) =>
        current && sessions.some((session) => session.id === current && session.workspaceId === id)
          ? null
          : current,
      );
    }
    return true;
  }, [guard, sessions]);

  const openWorkspaceInExplorer = useCallback(async (id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    if (!workspace) return;
    await guard('execution_failed', () => core.files.reveal(workspace.path));
  }, [guard, workspaces]);

  const removeWorkspace = useCallback(
    async (id: string, detachSessionIds: string[] = []) => {
      const ok = await guard('execution_failed', async () => {
        await core.workspaces.remove(id, detachSessionIds);
        return true;
      });
      if (!ok) return false;
      const detached = new Set(detachSessionIds);
      const removedSessionIds = new Set(
        sessions.filter((session) => session.workspaceId === id && !detached.has(session.id)).map((session) => session.id),
      );
      setWorkspaces((prev) => prev.filter((w) => w.id !== id));
      setSessions((prev) =>
        prev
          .filter((session) => !removedSessionIds.has(session.id))
          .map((session) => (detached.has(session.id) ? { ...session, workspaceId: null } : session)),
      );
      for (const sessionId of removedSessionIds) readBack.current.delete(sessionId);
      setMessagesBySession((prev) => {
        const next = { ...prev };
        for (const sessionId of removedSessionIds) delete next[sessionId];
        return next;
      });
      setActiveSessionId((cur) => (cur && removedSessionIds.has(cur) ? null : cur));
      setActiveWorkspaceId((cur) => (cur === id ? null : cur));
      return true;
    },
    [guard, sessions],
  );

  /* ---------------------------------------------------------------- */
  /* Sessions                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Opens an empty task and returns its id.
   *
   * The id is handed back because `setActiveSessionId` has not landed by the
   * time this returns. A caller that wants to start a turn in the task it just
   * made has to name that task explicitly, rather than let `send` read the
   * active id this call is in the middle of replacing.
   */
  const newSession = useCallback((
    scope: 'auto' | 'personal' | 'project' = 'auto',
    workspaceIdOverride?: string,
  ): string | null => {
    const workspaceId = scope === 'personal' ? null : workspaceIdOverride ?? activeWorkspaceId;
    if (workspaceIdOverride) setActiveWorkspaceId(workspaceIdOverride);
    if (scope === 'project' && !workspaceId) return null;
    // "New chat" pressed again while an unused one is already sitting there
    // just re-opens that chat. Stacking empty `New …` rows is noise: nothing
    // distinguishes them, and the operator asked for a chat to type into, not
    // for a second blank entry. Unused means the client-created placeholder
    // (title still `New …`, so no turn ever renamed it), no messages on
    // screen, and no run in flight. `readBack` gates out stored chats that
    // simply have not been opened yet — those may hold history on disk.
    const isUnused = (s: Session) =>
      s.workspaceId === workspaceId &&
      s.title.startsWith('New ') &&
      (messagesBySession[s.id] === undefined || messagesBySession[s.id].length === 0) &&
      !runsRef.current[s.id];
    const reusable =
      (activeSessionId && sessions.find((s) => s.id === activeSessionId && isUnused(s))?.id) ??
      sessions.find(isUnused)?.id; // sessions are newest-first
    if (reusable) {
      if (!workspaceId) setActiveWorkspaceId(null);
      setActiveSessionId(reusable);
      setView('workbench');
      return reusable;
    }
    const s: Session = {
      id: uid('sess'),
      workspaceId,
      title: workspaceId ? 'New project chat' : 'New personal chat',
      mode,
      useMemories: true,
      contributeMemories: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (!workspaceId) setActiveWorkspaceId(null);
    readBack.current.add(s.id);
    setSessions((prev) => [s, ...prev]);
    setMessagesBySession((prev) => ({ ...prev, [s.id]: [] }));
    setActiveSessionId(s.id);
    setView('workbench');
    return s.id;
  }, [activeSessionId, activeWorkspaceId, messagesBySession, mode, sessions]);

  const openSession = useCallback(
    (id: string) => {
      const session = sessions.find((item) => item.id === id);
      if (session) setActiveWorkspaceId(session.workspaceId);
      setActiveSessionId(id);
      setView('workbench');

      // Fetched once per session, and never over a transcript already on
      // screen: the live copy carries the step list of the run that produced
      // it, which the stored copy deliberately does not. A failed read is
      // forgotten so opening the conversation again retries.
      if (readBack.current.has(id)) return;
      readBack.current.add(id);
      void core.sessions
        .history(id)
        .then((rows) =>
          setMessagesBySession((cur) =>
            cur[id] !== undefined ? cur : { ...cur, [id]: rows.map(rehydrate) },
          ),
        )
        .catch((e: unknown) => {
          readBack.current.delete(id);
          pushFailure(
            'execution_failed',
            'This conversation could not be read back.',
            e instanceof Error ? e.message : String(e),
          );
        });
    },
    [pushFailure, sessions],
  );

  /**
   * Forgets a conversation, on disk as well as on screen.
   *
   * The core deletes first. If that fails the sidebar is left alone, because a
   * conversation that vanishes from the list and comes back on the next launch
   * is worse than one that refuses to go.
   */
  const deleteSession = useCallback(
    async (id: string) => {
      // A command that returns nothing answers with `null`, which is also what
      // `guard` returns when it swallowed a failure, so say so explicitly.
      const gone = await guard('execution_failed', async () => {
        await core.sessions.remove(id);
        return true;
      });
      if (!gone) return;
      readBack.current.delete(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
      setMessagesBySession((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setChangesBySession((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setActiveSessionId((cur) => (cur === id ? null : cur));
    },
    [guard],
  );

  const setSessionMemory = useCallback(
    async (useMemories: boolean, contributeMemories: boolean) => {
      if (!activeSessionId) return;
      // Update the open chat immediately. The core may ask for a first message
      // before it has a persisted row; the next turn still carries these flags.
      setSessions((prev) =>
        prev.map((session) =>
          session.id === activeSessionId
            ? { ...session, useMemories, contributeMemories }
            : session,
        ),
      );
      if (coreStatus.state === 'unavailable') return;
      const saved = await core.sessions
        .setMemory(activeSessionId, useMemories, contributeMemories)
        .catch(() => null);
      if (saved) {
        setSessions((prev) => prev.map((session) => (session.id === saved.id ? saved : session)));
      }
    },
    [activeSessionId, coreStatus.state],
  );

  /* ---------------------------------------------------------------- */
  /* §6  Sending a turn                                               */
  /* ---------------------------------------------------------------- */

  const send = useCallback(
    async (
      prompt: string,
      attachmentPaths: string[] = [],
      intoSession?: string,
      // The plan handoff approves a plan and starts the follow-up turn in
      // Agent mode from a click that happened while `mode` was still 'plan'.
      // The state update from setMode has not landed by the time send runs,
      // so the override is passed explicitly rather than read from state.
      modeOverride?: AgentMode,
    ) => {
      const text = prompt.trim();
      if (!text) return false;
      const runMode = modeOverride ?? mode;

      // Ensure there is a session to attach the turn to. `intoSession` is for the
      // caller that has just opened one: `activeSessionId` still names the task
      // that was open a moment ago, so without it the question is filed under the
      // old task while the screen shows the new, empty one.
      let sid = intoSession ?? activeSessionId;
      // One turn at a time per chat — but only per chat. A busy chat
      // elsewhere does not block this one; that is what concurrent chats are.
      // Checked before any bookkeeping so a blocked send leaves nothing behind.
      if (sid && runsRef.current[sid]) return false;
      // A run without a workspace is legitimate. The core takes `workspaceId`
      // as optional and refuses individual file tools by name if one is needed
      // and none is open, which is a better answer than refusing the question.
      const storedSession = sid ? sessions.find((session) => session.id === sid) : undefined;
      let wsId = storedSession ? storedSession.workspaceId : activeWorkspaceId;
      // An Agent turn with no folder open would run toolless — every write
      // refused by name. A scratch project under the sovereign root gives it
      // a sandbox to work in instead. Plan turns skip this: they only read,
      // and asking a question should not conjure a folder. touch_session
      // binds the chat to the scratch on the backend side (COALESCE), so one
      // scratch per chat, not one per turn.
      if (runMode === 'agent' && !wsId && coreStatus.state !== 'unavailable') {
        const scratch = await guard('execution_failed', () =>
          core.workspaces.create(`Scratch ${text.slice(0, 40)}`, []),
        );
        if (scratch) {
          setWorkspaces((prev) => [...prev.filter((w) => w.id !== scratch.id), scratch]);
          setActiveWorkspaceId(scratch.id);
          if (sid) {
            setSessions((prev) =>
              prev.map((s) => (s.id === sid ? { ...s, workspaceId: scratch.id } : s)),
            );
          }
          wsId = scratch.id;
        }
        // Creation refused: the turn still runs, toolless — the core answers
        // the question rather than dropping it.
      }
      const useMemories = storedSession?.useMemories ?? true;
      const contributeMemories = storedSession?.contributeMemories ?? true;
      if (!sid) {
        const s: Session = {
          id: uid('sess'),
          workspaceId: wsId,
          title: text.slice(0, 60),
          mode,
          useMemories,
          contributeMemories,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        readBack.current.add(s.id);
        setSessions((prev) => [s, ...prev]);
        setActiveSessionId(s.id);
        sid = s.id;
      } else {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === sid
              ? {
                  ...s,
                  updatedAt: Date.now(),
                  title: s.title.startsWith('New ') ? text.slice(0, 60) : s.title,
                }
              : s,
          ),
        );
      }

      const userMessage: ChatMessage = {
        id: uid('msg'),
        sender: 'user',
        content: text,
        createdAt: Date.now(),
        mode: runMode,
        attachments: attachmentPaths.map((p) => ({
          id: uid('att'),
          path: p,
          fileName: p.split(/[\\/]/).pop() ?? p,
          kind: draftAttachmentKind(p),
          sizeBytes: 0,
        })),
      };
      const key = sid;
      setMessagesBySession((prev) => ({ ...prev, [key]: [...(prev[key] ?? []), userMessage] }));
      // The live-run entry exists before the start request is sent, so a step
      // or delta that beats the reply already has a buffer to land in. The
      // run id is filled in when the reply arrives.
      runsRef.current = {
        ...runsRef.current,
        [key]: {
          runId: '',
          steps: [],
          activity: [],
          plan: [],
          phase: null,
          lastEventAt: Date.now(),
        },
      };
      setRunsBySession(runsRef.current);

      // No core attached: say so plainly instead of inventing a response.
      if (coreStatus.state === 'unavailable') {
        delete runsRef.current[key];
        setRunsBySession({ ...runsRef.current });
        setMessagesBySession((prev) => ({
          ...prev,
          [key]: [
            ...(prev[key] ?? []),
            {
              id: uid('msg'),
              sender: 'system',
              content: coreStatus.detail,
              createdAt: Date.now(),
              failure: 'Core not attached — nothing was run and no model was loaded.',
            },
          ],
        }));
        return true;
      }

      const started = await guard('execution_failed', () =>
        core.turns.start({
          threadId: key,
          workspaceId: wsId,
          mode: runMode,
          input: [
            { type: 'text', text },
            ...attachmentPaths.map(core.localTurnInput),
          ],
          useMemories,
          contributeMemories,
        }),
      );
      if (started) {
        if (completedBeforeStartReply.current.has(started.runId)) {
          // The run already completed before its start reply crossed the
          // bridge; the done handler has committed the answer and cleared
          // the buffer, so there is nothing to register.
          completedBeforeStartReply.current.delete(started.runId);
        } else {
          startReplySeen.current.add(started.runId);
          mutateLiveRun(key, (run) => ({ ...run, runId: started.runId }));
        }
      } else {
        delete runsRef.current[key];
        setRunsBySession({ ...runsRef.current });
        setMessagesBySession((prev) => ({
          ...prev,
          [key]: [
            ...(prev[key] ?? []),
            {
              id: uid('msg'),
              sender: 'system',
              content: 'The turn could not be started. Your request was not sent to a model.',
              createdAt: Date.now(),
              failure: 'Check the failure notice, then send the request again.',
            },
          ],
        }));
      }
      return true;
    },
    [activeSessionId, activeWorkspaceId, coreStatus, guard, mode, mutateLiveRun, sessions],
  );

  // Assigned rather than re-created per render: the done handler reads it at
  // event time, and the current callback is the one that sees current state.
  sendRef.current = send;

  /**
   * Queues a follow-up for a chat whose turn is still running. Delivered
   * automatically by the done handler, in order, one per completed turn.
   */
  const queueMessage = useCallback((text: string, intoSession?: string) => {
    const value = text.trim();
    if (!value) return;
    const sid = intoSession ?? activeSessionId;
    if (!sid) return;
    queuedRef.current = {
      ...queuedRef.current,
      [sid]: [...(queuedRef.current[sid] ?? []), value],
    };
    setQueuedBySession(queuedRef.current);
  }, [activeSessionId]);

  const removeQueued = useCallback((index: number, intoSession?: string) => {
    const sid = intoSession ?? activeSessionId;
    if (!sid) return;
    const current = queuedRef.current[sid] ?? [];
    queuedRef.current = {
      ...queuedRef.current,
      [sid]: current.filter((_, i) => i !== index),
    };
    setQueuedBySession(queuedRef.current);
  }, [activeSessionId]);

  const cancelRun = useCallback(async () => {
    // Cancels the open chat's run. A chat that is busy elsewhere is not
    // touched: its Stop button is in its own chat.
    const live = activeSessionId ? runsRef.current[activeSessionId] : undefined;
    if (!live?.runId) return;
    const runId = live.runId;
    await guard('execution_failed', () => core.agent.cancel(runId));
    // Keep the turn occupied until its authoritative completion arrives. If the
    // composer were re-enabled here, a late completion from the cancelled turn
    // could clear or overwrite a newly started turn.
    setPendingPermissions((prev) => prev.filter((p) => p.runId !== runId));
    setPendingQuestions((prev) => prev.filter((q) => q.runId !== runId));
  }, [activeSessionId, guard]);

  /* ---------------------------------------------------------------- */
  /* §9  Permissions                                                  */
  /* ---------------------------------------------------------------- */

  const respondToPermission = useCallback(
    async (decision: PermissionDecision) => {
      // Serves the head of the queue. The rest — if another chat is also
      // waiting on an answer — surface in turn.
      const head = pendingPermissions[0];
      if (!head) return;
      setPendingPermissions((prev) => prev.slice(1));
      await guard('execution_failed', () => core.agent.respondToPermission(head.id, decision));
    },
    [guard, pendingPermissions],
  );

  const answerQuestion = useCallback(
    async (answer: string) => {
      // Same queue discipline as permissions: the head is served, the rest
      // surface in turn. An empty reply is not delivered — the operator can
      // see the prompt is still waiting and try again.
      const head = pendingQuestions[0];
      const trimmed = answer.trim();
      if (!head || !trimmed) return;
      setPendingQuestions((prev) => prev.slice(1));
      await guard('execution_failed', () => core.agent.answerQuestion(head.id, trimmed));
    },
    [guard, pendingQuestions],
  );

  /* ---------------------------------------------------------------- */
  /* Panel tabs                                                       */
  /* ---------------------------------------------------------------- */

  const openSettings = useCallback((page: SettingsPage = 'workbench') => {
    setSettingsPage(page);
    setView('settings');
  }, []);

  const openTab = useCallback(
    (kind: PanelTabKind, title?: string, documentId?: string, filePath?: string) => {
      // These are application-level managers, not chat context. Keeping them in
      // Settings also means the composer and its Plan/Agent controls cannot show
      // through underneath them.
      const settingsDestination: Partial<Record<PanelTabKind, SettingsPage>> = {
        models: 'models',
        knowledge: 'knowledge',
        memories: 'memories',
      };
      const destination = settingsDestination[kind];
      if (destination) {
        openSettings(destination);
        return;
      }

      // The panel only exists on the workbench, so a tab opened from somewhere
      // that covers it — the menu bar and the command palette are both reachable
      // from Settings — has to bring the workbench back or nothing appears to
      // happen at all.
      setView('workbench');
      setIsPanelOpen(true);
      setTabs((prev) => {
        const existing = prev.find(
          (t) =>
            t.kind === kind &&
            (kind !== 'document' || t.documentId === documentId) &&
            (kind !== 'file' || t.filePath === filePath),
        );
        if (existing) {
          setActiveTabId(existing.id);
          return prev;
        }
        const tab: PanelTab = {
          id: uid('tab'),
          kind,
          title: title ?? kind.charAt(0).toUpperCase() + kind.slice(1),
          documentId,
          filePath,
        };
        setActiveTabId(tab.id);
        return [...prev, tab];
      });
    },
    [openSettings],
  );

  /**
   * Corrects a tab's label once the thing it points at is known.
   *
   * A document tab can be opened before its record has been read, and a tab that
   * says `Document` while the panel shows a named file is the kind of small lie
   * that makes an operator distrust the rest of the screen.
   */
  const renameTab = useCallback((kind: PanelTabKind, title: string, documentId?: string) => {
    setTabs((prev) => {
      const hit = prev.find(
        (t) => t.kind === kind && (kind !== 'document' || t.documentId === documentId),
      );
      if (!hit || hit.title === title) return prev;
      return prev.map((t) => (t === hit ? { ...t, title } : t));
    });
  }, []);

  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((cur) => (cur === id ? next[next.length - 1]?.id ?? null : cur));
      if (next.length === 0) setIsPanelOpen(false);
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------- */
  /* Review                                                           */
  /* ---------------------------------------------------------------- */

  const applyChange = useCallback(
    async (path: string) => {
      if (!activeSessionId || !changesBySession[activeSessionId]) return;
      const runId = changesBySession[activeSessionId].runId;
      const ok = await guard('execution_failed', async () => {
        await core.agent.applyChange(runId, path);
        return true;
      });
      if (ok)
        setChangesBySession((prev) => ({
          ...prev,
          [activeSessionId]: {
            ...prev[activeSessionId],
            changes: prev[activeSessionId].changes.map((c) =>
              c.path === path ? { ...c, applied: true } : c,
            ),
          },
        }));
    },
    [activeSessionId, changesBySession, guard],
  );

  const discardChange = useCallback(
    async (path: string) => {
      if (!activeSessionId || !changesBySession[activeSessionId]) return;
      const runId = changesBySession[activeSessionId].runId;
      const ok = await guard('execution_failed', async () => {
        await core.agent.discardChange(runId, path);
        return true;
      });
      if (ok)
        setChangesBySession((prev) => ({
          ...prev,
          [activeSessionId]: {
            ...prev[activeSessionId],
            changes: prev[activeSessionId].changes.filter((c) => c.path !== path),
          },
        }));
    },
    [activeSessionId, changesBySession, guard],
  );

  const applyAllChanges = useCallback(async () => {
    if (!activeSessionId || !changesBySession[activeSessionId]) return;
    const runId = changesBySession[activeSessionId].runId;
    const failed = await guard('execution_failed', () =>
      core.agent.applyAllChanges(runId),
    );
    if (!failed) return;
    // The server returns the files that did NOT apply; everything else went
    // through, so the panel marks those applied and keeps the failures.
    const failedPaths = new Set(failed.map((f) => f.path));
    for (const f of failed) {
      pushFailure('execution_failed', `${f.path}: ${f.reason}`);
    }
    setChangesBySession((prev) => ({
      ...prev,
      [activeSessionId]: {
        ...prev[activeSessionId],
        changes: prev[activeSessionId].changes.map((c) =>
          failedPaths.has(c.path) ? c : { ...c, applied: true },
        ),
      },
    }));
  }, [activeSessionId, changesBySession, guard, pushFailure]);

  const discardAllChanges = useCallback(async () => {
    if (!activeSessionId || !changesBySession[activeSessionId]) return;
    const runId = changesBySession[activeSessionId].runId;
    const failed = await guard('execution_failed', () =>
      core.agent.discardAllChanges(runId),
    );
    if (!failed) return;
    const failedPaths = new Set(failed.map((f) => f.path));
    for (const f of failed) {
      pushFailure('execution_failed', `${f.path}: ${f.reason}`);
    }
    setChangesBySession((prev) => ({
      ...prev,
      [activeSessionId]: {
        ...prev[activeSessionId],
        changes: prev[activeSessionId].changes.filter((c) => failedPaths.has(c.path)),
      },
    }));
  }, [activeSessionId, changesBySession, guard, pushFailure]);

  /* ---------------------------------------------------------------- */
  /* §4  Documents                                                    */
  /* ---------------------------------------------------------------- */

  const pickAttachments = useCallback(async () => {
    const paths = await guard('invalid_document', () => core.documents.pick());
    return paths ?? [];
  }, [guard]);

  const ingestFiles = useCallback(async () => {
    const paths = await guard('invalid_document', () => core.documents.pick());
    if (!paths?.length) return;
    for (const p of paths) {
      const doc = await guard('invalid_document', () => core.documents.ingest(p));
      if (!doc) continue;
      // An ingest answers with the whole extraction, so this one needs no re-read.
      hydrated.current.add(doc.id);
      setDocuments((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
      setActiveDocumentId(doc.id);
      openTab('document', doc.fileName, doc.id);
    }
  }, [guard, openTab]);

  /**
   * Opens an extraction, fetching the parts the list does not carry.
   *
   * `document_list` returns the rows without their blocks and tables — a
   * hundred scanned pages of them would be megabytes of JSON on every launch —
   * so a document restored at startup has to be read in full before the overlay
   * and the text panel have anything to show.
   */
  const openDocument = useCallback(
    async (id: string) => {
      const known = documents.find((d) => d.id === id);
      setActiveDocumentId(id);
      openTab('document', known?.fileName ?? 'Document', id);
      if (hydrated.current.has(id)) return;

      const full = await guard('invalid_document', () => core.documents.get(id));
      if (!full) return;
      hydrated.current.add(id);
      setDocuments((prev) => prev.map((d) => (d.id === id ? full : d)));
      // The picker may have opened this tab before the file name was known.
      renameTab('document', full.fileName, id);
    },
    [documents, guard, openTab, renameTab],
  );

  /**
   * Opens the extraction for a file on disk, reading it now if it has not been
   * read before.
   *
   * The knowledge index and the document store are separate: a file can be
   * searchable without its layout ever having been extracted. Clicking an
   * indexed file to look at it should therefore be able to produce the
   * extraction, not report that there isn't one.
   */
  const openDocumentAt = useCallback(
    async (path: string) => {
      const known = documents.find((d) => samePath(d.path, path));
      if (known) {
        await openDocument(known.id);
        return;
      }
      const doc = await guard('invalid_document', () => core.documents.ingest(path));
      if (!doc) return;
      hydrated.current.add(doc.id);
      setDocuments((prev) => [doc, ...prev.filter((d) => d.id !== doc.id)]);
      setActiveDocumentId(doc.id);
      openTab('document', doc.fileName, doc.id);
    },
    [documents, guard, openDocument, openTab],
  );

  /**
   * Forgets what was read out of a file. The file on disk is not touched.
   *
   * The core decides first: a record that disappears from the panel and is back
   * after the next launch is worse than one that refuses to go.
   */
  const removeDocument = useCallback(
    async (id: string) => {
      const gone = await guard('invalid_document', async () => {
        await core.documents.remove(id);
        return true;
      });
      if (!gone) return;
      hydrated.current.delete(id);
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      setActiveDocumentId((cur) => (cur === id ? null : cur));
      setTabs((prev) => {
        const next = prev.filter((t) => t.documentId !== id);
        if (next.length === prev.length) return prev;
        // Only move the selection if the tab that went was the open one.
        setActiveTabId((cur) =>
          prev.some((t) => t.id === cur && t.documentId === id)
            ? next[next.length - 1]?.id ?? null
            : cur,
        );
        if (next.length === 0) setIsPanelOpen(false);
        return next;
      });
    },
    [guard],
  );

  /* ---------------------------------------------------------------- */
  /* §5  Knowledge                                                    */
  /* ---------------------------------------------------------------- */

  const refreshKnowledge = useCallback(async () => {
    const [stats, list] = await Promise.all([
      core.knowledge.stats().catch(() => null),
      core.knowledge.list().catch(() => null),
    ]);
    if (stats) setKnowledgeStats(stats);
    if (list) setKnowledgeSources(list);
  }, []);

  const indexFiles = useCallback(async () => {
    const paths = await guard('index_failed', () => core.documents.pick());
    if (!paths?.length) return;
    const added = await guard('index_failed', () => core.knowledge.index(paths));
    if (added) await refreshKnowledge();
  }, [guard, refreshKnowledge]);

  const reindexSource = useCallback(
    async (id: string) => {
      const src = await guard('index_failed', () => core.knowledge.reindex(id));
      if (src) await refreshKnowledge();
    },
    [guard, refreshKnowledge],
  );

  const removeSource = useCallback(
    async (id: string) => {
      const ok = await guard('index_failed', async () => {
        await core.knowledge.remove(id);
        return true;
      });
      if (ok) await refreshKnowledge();
    },
    [guard, refreshKnowledge],
  );

  const toggleWatching = useCallback(async () => {
    const stats = await guard('index_failed', () =>
      core.knowledge.setWatching(!knowledgeStats.watching),
    );
    if (stats) setKnowledgeStats(stats);
  }, [guard, knowledgeStats.watching]);

  /* ---------------------------------------------------------------- */
  /* Harness memories and instructions                                */
  /* ---------------------------------------------------------------- */

  const addMemory = useCallback(
    async (input: MemoryInput) => {
      const added = await guard('execution_failed', () => core.harness.memories.add(input));
      if (added) await refreshMemories();
    },
    [guard, refreshMemories],
  );

  const updateMemory = useCallback(
    async (
      id: string,
      patch: Partial<Pick<MemoryEntry, 'title' | 'content' | 'kind' | 'enabled'>>,
    ) => {
      const updated = await guard('execution_failed', () =>
        core.harness.memories.update(id, patch),
      );
      if (updated) setMemories((prev) => prev.map((m) => (m.id === id ? updated : m)));
    },
    [guard],
  );

  const removeMemory = useCallback(
    async (id: string) => {
      const removed = await guard('execution_failed', async () => {
        await core.harness.memories.remove(id);
        return true;
      });
      if (removed) setMemories((prev) => prev.filter((memory) => memory.id !== id));
    },
    [guard],
  );

  const saveInstructions = useCallback(
    async (scope: MemoryScope, content: string) => {
      const workspaceId = scope === 'project' ? activeWorkspaceId ?? undefined : undefined;
      if (scope === 'project' && !workspaceId) return;
      const saved = await guard('execution_failed', () =>
        core.harness.instructions.set(scope, content, workspaceId),
      );
      if (!saved) return;
      if (scope === 'global') setGlobalInstructions(saved);
      else setProjectInstructions(saved);
    },
    [activeWorkspaceId, guard],
  );

  /* ---------------------------------------------------------------- */
  /* §10  Artifacts                                                   */
  /* ---------------------------------------------------------------- */

  const openArtifact = useCallback(
    async (id: string) => {
      const artifact = artifacts.find((item) => item.id === id);
      if (!artifact) return;
      openTab('file', artifact.fileName, undefined, artifact.path);
    },
    [artifacts, openTab],
  );

  const verifyArtifact = useCallback(
    async (id: string) => {
      const a = await guard('execution_failed', () => core.artifacts.verify(id));
      if (a) setArtifacts((prev) => prev.map((x) => (x.id === id ? a : x)));
    },
    [guard],
  );

  /* ---------------------------------------------------------------- */
  /* §8  Sandbox                                                      */
  /* ---------------------------------------------------------------- */

  const runInSandbox = useCallback(
    async (command: string) => {
      const cmd = command.trim();
      if (!cmd) return;
      const run = await guard('execution_failed', () => core.sandbox.run(cmd));
      if (run) setSandboxRuns((prev) => [...prev, run]);
      void core.audit.list().then(setAuditLog).catch(() => {});
    },
    [guard],
  );

  /** §8 — terminate a running process. The core kills the whole job object,
   *  so children spawned inside the sandbox die with it. */
  const killRun = useCallback(
    async (runId: string) => {
      await guard('execution_failed', () => core.sandbox.kill(runId));
      setSandboxRuns((prev) =>
        prev.map((r) => (r.id === runId && r.status === 'running' ? { ...r, status: 'killed' } : r)),
      );
    },
    [guard],
  );

  /* ---------------------------------------------------------------- */
  /* §12  Audit                                                       */
  /* ---------------------------------------------------------------- */

  const refreshAudit = useCallback(async () => {
    const rows = await core.audit.list().catch(() => null);
    if (rows) setAuditLog(rows);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Settings                                                         */
  /* ---------------------------------------------------------------- */

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      // Optimistic: the controls stay responsive even with no core attached.
      setSettings((prev) => ({ ...prev, ...patch }));
      if (patch.defaultMode) setMode(patch.defaultMode);
      if (patch.approvalPolicy) setApprovalPolicy(patch.approvalPolicy);
      if (coreStatus.state === 'unavailable') return;
      const saved = await guard('execution_failed', () => core.settings.set(patch));
      if (saved) setSettings(saved);
    },
    [coreStatus.state, guard],
  );

  /* ---------------------------------------------------------------- */

  const value: AppContextValue = {
    view,
    setView,
    settingsPage,
    openSettings,
    isSearchOpen,
    setIsSearchOpen,

    coreStatus,
    refreshCore,
    failures,
    dismissFailure,

    hardware,
    sovereign,
    exposure,
    refreshExposure,

    catalogueModels,
    modelRuntime,
    loadedModelIds,
    addCatalogueModel,
    routeRules,
    updateModelRoute,
    loadModel,
    evictModel,

    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    setActiveWorkspaceId,
    addWorkspace,
    isCreateProjectOpen,
    setIsCreateProjectOpen,
    pickProjectSource,
    createWorkspace,
    updateWorkspace,
    openWorkspaceInExplorer,
    approveWorkspace,
    removeWorkspace,

    devServers,
    activeDevServer,
    startDevServer,
    stopDevServer,
    openDevServerUrl,

    sessions,
    activeSessionId,
    activeSession,
    openSession,
    newSession,
    deleteSession,
    setSessionMemory,

    messages,
    mode,
    setMode,
    isRunning,
    anyRunning,
    runningSessionIds,
    liveSteps,
    liveActivity,
    livePlan,
    livePhase,
    send,
    queuedMessages,
    queueMessage,
    removeQueued,
    cancelRun,

    approvalPolicy,
    setApprovalPolicy,
    pendingPermission: pendingPermissions[0] ?? null,
    respondToPermission,

    pendingQuestion: pendingQuestions[0] ?? null,
    answerQuestion,

    isPanelOpen,
    setIsPanelOpen,
    tabs,
    activeTabId,
    setActiveTabId,
    openTab,
    closeTab,

    fileChanges: visibleChanges,
    selectedChangePath,
    setSelectedChangePath,
    applyChange,
    discardChange,
    applyAllChanges,
    discardAllChanges,

    documents,
    activeDocumentId,
    pickAttachments,
    ingestFiles,
    openDocument,
    openDocumentAt,
    removeDocument,

    knowledgeStats,
    knowledgeSources,
    indexFiles,
    reindexSource,
    removeSource,
    toggleWatching,

    harnessInfo,
    memories,
    globalInstructions,
    projectInstructions,
    refreshMemories,
    addMemory,
    updateMemory,
    removeMemory,
    saveInstructions,

    artifacts,
    openArtifact,
    verifyArtifact,

    sandboxPolicy,
    sandboxRuns,
    runInSandbox,
    killRun,

    auditLog,
    refreshAudit,

    settings,
    updateSettings,
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
};
