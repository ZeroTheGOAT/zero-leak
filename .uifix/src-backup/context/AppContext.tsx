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
  ChatMessage,
  CoreFailure,
  ExposureReport,
  CoreStatus,
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
  PanelTab,
  PanelTabKind,
  PermissionDecision,
  PermissionRequest,
  SandboxPolicy,
  SandboxRun,
  Session,
  SettingsPage,
  SovereignStatus,
  StoredMessage,
  ToolCallRecord,
  ViewName,
  Workspace,
} from '../types';
import * as core from '../services/core';
import {
  DEFAULT_SANDBOX_POLICY,
  DEFAULT_SETTINGS,
  INITIAL_RUNTIME,
  MODEL_REGISTRY,
  VRAM_BUDGET_MB,
  VRAM_TOTAL_MB,
} from '../services/registry';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

let seq = 0;
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

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
  loadModel: (id: string) => Promise<void>;
  evictModel: (id: string) => Promise<void>;

  /* Workspaces (§8) */
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeWorkspace: Workspace | null;
  setActiveWorkspaceId: (id: string | null) => void;
  addWorkspace: () => Promise<void>;
  approveWorkspace: (id: string) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;

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
  isRunning: boolean;
  /** Chat that owns the one in-flight local turn. */
  runningSessionId: string | null;
  liveSteps: AgentStep[];
  liveText: string;
  send: (prompt: string, attachmentPaths?: string[], intoSession?: string) => Promise<boolean>;
  cancelRun: () => Promise<void>;

  /* Permissions (§9) */
  approvalPolicy: ApprovalPolicy;
  setApprovalPolicy: (p: ApprovalPolicy) => void;
  pendingPermission: PermissionRequest | null;
  respondToPermission: (d: PermissionDecision) => Promise<void>;

  /* Right panel */
  isPanelOpen: boolean;
  setIsPanelOpen: (v: boolean) => void;
  tabs: PanelTab[];
  activeTabId: string | null;
  setActiveTabId: (id: string) => void;
  openTab: (kind: PanelTabKind, title?: string, documentId?: string) => void;
  closeTab: (id: string) => void;

  /* Review (§6) */
  fileChanges: FileChange[];
  selectedChangePath: string | null;
  setSelectedChangePath: (p: string | null) => void;
  applyChange: (path: string) => Promise<void>;
  discardChange: (path: string) => Promise<void>;

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
  const [modelRuntime, setModelRuntime] =
    useState<Record<string, ModelRuntime>>(INITIAL_RUNTIME);

  /* Workspaces */
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

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

  /* Run state */
  const [mode, setMode] = useState<AgentMode>(DEFAULT_SETTINGS.defaultMode);
  const [runId, setRunId] = useState<string | null>(null);
  const [runningSessionId, setRunningSessionId] = useState<string | null>(null);
  const [liveSteps, setLiveSteps] = useState<AgentStep[]>([]);
  const [liveText, setLiveText] = useState('');
  const runStartRef = useRef<number>(0);
  /** Handles the rare case where a very early failure completes before the
   *  `turn_start` response crosses the desktop bridge. */
  const completedBeforeStartReply = useRef<Set<string>>(new Set());
  const startReplySeen = useRef<Set<string>>(new Set());

  /* Permissions */
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(
    DEFAULT_SETTINGS.approvalPolicy,
  );
  const [pendingPermission, setPendingPermission] = useState<PermissionRequest | null>(null);

  /* Panel */
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [tabs, setTabs] = useState<PanelTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  /* Review */
  const [fileChanges, setFileChanges] = useState<FileChange[]>([]);
  /**
   * The run whose proposed writes are sitting in the review panel, and the task
   * it belongs to.
   *
   * Deliberately not `runId`. That one means "a run is in flight" and is cleared
   * the instant the run ends — which is the same instant the proposals arrive and
   * the panel becomes worth looking at. The core keeps its pending changes keyed
   * by run id for the life of the process, so the handle has to outlive the run
   * or `Write this file` has nothing to name.
   */
  const [changeRun, setChangeRun] = useState<{ runId: string; sessionId: string } | null>(null);
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

    const [hw, sov, rt, catalogue, ws, docs, kStats, kList, arts, pol, aud, cfg, sess] =
      await Promise.all([
        core.telemetry.hardware().catch(() => null),
        core.telemetry.sovereign().catch(() => null),
        core.models.list().catch(() => null),
        core.models.catalogue().catch(() => null),
        core.workspaces.list().catch(() => null),
        core.documents.list().catch(() => null),
        core.knowledge.stats().catch(() => null),
        core.knowledge.list().catch(() => null),
        core.artifacts.list().catch(() => null),
        core.sandbox.policy().catch(() => null),
        core.audit.list().catch(() => null),
        core.settings.get().catch(() => null),
        core.sessions.list().catch(() => null),
      ]);

    if (hw) setHardware(hw);
    if (sov) setSovereign(sov);
    if (rt) setModelRuntime(Object.fromEntries(rt.map((r) => [r.id, r])));
    if (catalogue) setCatalogueModels(catalogue);
    if (ws) {
      setWorkspaces(ws);
      setActiveWorkspaceId((cur) => cur ?? ws.find((w) => w.approved)?.id ?? ws[0]?.id ?? null);
    }
    if (docs) setDocuments(docs);
    if (kStats) setKnowledgeStats(kStats);
    if (kList) setKnowledgeSources(kList);
    if (arts) setArtifacts(arts);
    if (pol) setSandboxPolicy(pol);
    if (aud) setAuditLog(aud);
    // Past conversations, newest first. Opening one fetches its transcript.
    if (sess) setSessions(sess);
    if (cfg) {
      setSettings(cfg);
      setMode(cfg.defaultMode);
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
    void add(
      core.on('agent://step', (step) =>
        setLiveSteps((prev) => {
          const i = prev.findIndex((s) => s.id === step.id);
          if (i === -1) return [...prev, step];
          const next = prev.slice();
          next[i] = step;
          return next;
        }),
      ),
    );

    void add(
      core.on('agent://text', (t) => {
        // There is one local run at a time. The session id is still carried on
        // every delta so a future multi-run client cannot accidentally merge
        // two chats into one buffer.
        setRunningSessionId((current) => current ?? t.sessionId);
        setLiveText((prev) => prev + t.delta);
      }),
    );
    void add(core.on('agent://permission', setPendingPermission));

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
      core.on('sandbox://line', (line) =>
        setSandboxRuns((prev) =>
          prev.map((r) =>
            r.id === line.runId ? { ...r, output: [...r.output, line] } : r,
          ),
        ),
      ),
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
  }, []);

  /* The done event needs current session/mode, so it gets its own effect. */
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;

    void core
      .on('agent://done', (done) => {
        if (!startReplySeen.current.delete(done.runId)) {
          completedBeforeStartReply.current.add(done.runId);
        }
        setRunId(null);
        setRunningSessionId(null);
        setPendingPermission(null);
        const sid = done.sessionId;
        const messageId = uid('msg');

        setLiveSteps((steps) => {
          setLiveText(() => {
            const message: ChatMessage = {
              id: messageId,
              sender: 'agent',
              content: done.message || done.summary,
              createdAt: Date.now(),
              steps,
              citations: done.citations,
              fileChanges: done.changes,
              modelId: done.modelId,
              mode: done.mode,
              elapsedMs: done.elapsedMs,
              tokensPerSec: done.tokensPerSec,
            };
            setMessagesBySession((prev) => ({
              ...prev,
              [sid]: [...(prev[sid] ?? []), message],
            }));
            return '';
          });
          return [];
        });

        // §6/§9 — proposed writes land in the review panel, not on disk.
        setFileChanges(done.changes ?? []);
        setChangeRun({ runId: done.runId, sessionId: sid });

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

  const isRunning = runId !== null || runningSessionId !== null;

  /**
   * The proposals, but only while the task that produced them is the open one.
   *
   * Filtering rather than clearing on a task switch: the core still holds these,
   * so throwing them away in the UI would strand a real pending write, while
   * showing them under another task would credit it with work it never asked for.
   */
  const visibleChanges = useMemo(
    () => (changeRun && changeRun.sessionId === activeSessionId ? fileChanges : []),
    [activeSessionId, changeRun, fileChanges],
  );

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

  const addWorkspace = useCallback(async () => {
    const ws = await guard('execution_failed', () => core.workspaces.add());
    if (!ws) return;
    setWorkspaces((prev) => [...prev.filter((w) => w.id !== ws.id), ws]);
    setActiveWorkspaceId(ws.id);
  }, [guard]);

  const approveWorkspace = useCallback(
    async (id: string) => {
      const ws = await guard('execution_failed', () => core.workspaces.approve(id));
      if (ws) setWorkspaces((prev) => prev.map((w) => (w.id === id ? ws : w)));
    },
    [guard],
  );

  const removeWorkspace = useCallback(
    async (id: string) => {
      const ok = await guard('execution_failed', async () => {
        await core.workspaces.remove(id);
        return true;
      });
      if (!ok) return;
      setWorkspaces((prev) => prev.filter((w) => w.id !== id));
      // The tasks stay. `sessions.workspace_id` is deliberately not a foreign key,
      // so the core keeps the record of what was discussed in the folder; dropping
      // them here hid them until the next reload instead of letting them fall into
      // the sidebar's `No folder` group, which exists for exactly this case.
      setActiveWorkspaceId((cur) => (cur === id ? null : cur));
    },
    [guard],
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
    // A turn belongs to its originating chat. Opening another chat must not
    // destroy the stream that will be committed when that turn completes.
    if (!runningSessionId) {
      setLiveSteps([]);
      setLiveText('');
    }
    setFileChanges([]);
    setChangeRun(null);
    setView('workbench');
    return s.id;
  }, [activeWorkspaceId, mode, runningSessionId]);

  const openSession = useCallback(
    (id: string) => {
      const session = sessions.find((item) => item.id === id);
      if (session) setActiveWorkspaceId(session.workspaceId);
      setActiveSessionId(id);
      if (!runningSessionId) {
        setLiveSteps([]);
        setLiveText('');
      }
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
    [pushFailure, runningSessionId, sessions],
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
    async (prompt: string, attachmentPaths: string[] = [], intoSession?: string) => {
      const text = prompt.trim();
      if (!text || isRunning) return false;

      // Ensure there is a session to attach the turn to. `intoSession` is for the
      // caller that has just opened one: `activeSessionId` still names the task
      // that was open a moment ago, so without it the question is filed under the
      // old task while the screen shows the new, empty one.
      let sid = intoSession ?? activeSessionId;
      // A run without a workspace is legitimate. The core takes `workspaceId`
      // as optional and refuses individual file tools by name if one is needed
      // and none is open, which is a better answer than refusing the question.
      const storedSession = sid ? sessions.find((session) => session.id === sid) : undefined;
      const wsId = storedSession ? storedSession.workspaceId : activeWorkspaceId;
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
        mode,
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
      setLiveSteps([]);
      setLiveText('');

      // No core attached: say so plainly instead of inventing a response.
      if (coreStatus.state === 'unavailable') {
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

      runStartRef.current = Date.now();
      setRunningSessionId(key);
      const started = await guard('execution_failed', () =>
        core.turns.start({
          threadId: key,
          workspaceId: wsId,
          mode,
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
          completedBeforeStartReply.current.delete(started.runId);
        } else {
          startReplySeen.current.add(started.runId);
          setRunId(started.runId);
        }
      } else {
        setRunningSessionId(null);
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
    [activeSessionId, activeWorkspaceId, coreStatus, guard, isRunning, mode, sessions],
  );

  const cancelRun = useCallback(async () => {
    if (!runId) return;
    await guard('execution_failed', () => core.agent.cancel(runId));
    // Keep the turn occupied until its authoritative completion arrives. If the
    // composer were re-enabled here, a late completion from the cancelled turn
    // could clear or overwrite a newly started turn.
    setPendingPermission(null);
  }, [guard, runId]);

  /* ---------------------------------------------------------------- */
  /* §9  Permissions                                                  */
  /* ---------------------------------------------------------------- */

  const respondToPermission = useCallback(
    async (decision: PermissionDecision) => {
      if (!pendingPermission) return;
      const id = pendingPermission.id;
      setPendingPermission(null);
      await guard('execution_failed', () => core.agent.respondToPermission(id, decision));
    },
    [guard, pendingPermission],
  );

  /* ---------------------------------------------------------------- */
  /* Panel tabs                                                       */
  /* ---------------------------------------------------------------- */

  const openSettings = useCallback((page: SettingsPage = 'workbench') => {
    setSettingsPage(page);
    setView('settings');
  }, []);

  const openTab = useCallback(
    (kind: PanelTabKind, title?: string, documentId?: string) => {
      // These are application-level managers, not chat context. Keeping them in
      // Settings also means the composer and its Plan/Agent controls cannot show
      // through underneath them.
      const settingsDestination: Partial<Record<PanelTabKind, SettingsPage>> = {
        models: 'models',
        knowledge: 'knowledge',
        memories: 'memories',
        audit: 'audit',
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
          (t) => t.kind === kind && (kind !== 'document' || t.documentId === documentId),
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
      if (!changeRun) return;
      const ok = await guard('execution_failed', async () => {
        await core.agent.applyChange(changeRun.runId, path);
        return true;
      });
      if (ok) setFileChanges((prev) => prev.map((c) => (c.path === path ? { ...c, applied: true } : c)));
    },
    [changeRun, guard],
  );

  const discardChange = useCallback(
    async (path: string) => {
      if (!changeRun) return;
      const ok = await guard('execution_failed', async () => {
        await core.agent.discardChange(changeRun.runId, path);
        return true;
      });
      if (ok) setFileChanges((prev) => prev.filter((c) => c.path !== path));
    },
    [changeRun, guard],
  );

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
      await guard('execution_failed', () => core.artifacts.open(id));
    },
    [guard],
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
    loadModel,
    evictModel,

    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    setActiveWorkspaceId,
    addWorkspace,
    approveWorkspace,
    removeWorkspace,

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
    runningSessionId,
    liveSteps,
    liveText,
    send,
    cancelRun,

    approvalPolicy,
    setApprovalPolicy,
    pendingPermission,
    respondToPermission,

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
