/*
 * Source-port of Nerve's settings information architecture and presentation
 * primitives for Servergen AI. Nerve Copyright © 2026 ThilinaTLM,
 * Apache-2.0. See THIRD_PARTY_NOTICES.md.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  Bell,
  Bot,
  Check,
  ChevronRight,
  CloudCog,
  Cpu,
  HardDrive,
  Keyboard,
  Library,
  Lightbulb,
  Mic,
  Monitor,
  Moon,
  Palette,
  Plus,
  Save,
  Server,
  Shield,
  ShieldCheck,
  Sun,
  TreePine,
  Waves,
  Wrench,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { AuditView } from '../panels/AuditView';
import { KnowledgeView } from '../panels/KnowledgeView';
import { MemoryView } from '../panels/MemoryView';
import { ModelManagerView } from '../panels/ModelManagerView';
import type {
  AgentMode,
  AppSettings,
  ApprovalPolicy,
  ModelCapability,
  ModelEntry,
  SettingsPage,
} from '../../types';
import {
  readAppearance,
  saveAppearance,
  type AppearancePreferences,
  type ColorMode,
  type ColorTheme,
} from '../../services/appearance';

type NavPage = {
  id: SettingsPage;
  label: string;
  icon: React.ElementType;
  description?: string;
  sections: Array<{ id: string; label: string }>;
};

const PAGES: NavPage[] = [
  { id: 'workbench', label: 'Workbench', icon: Monitor, sections: [
    { id: 'appearance', label: 'Appearance' },
    { id: 'desktop', label: 'Desktop' },
  ] },
  { id: 'providers', label: 'Providers', icon: CloudCog, sections: [
    { id: 'local-runtimes', label: 'Local runtimes' },
    { id: 'local-models', label: 'Local models' },
    { id: 'private-endpoint', label: 'Private endpoint' },
  ] },
  { id: 'models', label: 'Scoped Models', icon: ShieldCheck, description: 'Choose the local models available to agent workflows.', sections: [
    { id: 'model-catalogue', label: 'Scoped Models' },
    { id: 'runtime', label: 'Runtime' },
  ] },
  { id: 'agent', label: 'Agents', icon: Bot, sections: [
    { id: 'defaults', label: 'Defaults' },
    { id: 'compaction', label: 'Compaction' },
    { id: 'explore', label: 'Explore agent' },
  ] },
  { id: 'permissions', label: 'Permissions', icon: Shield, description: 'Set local defaults and focused workspace exceptions.', sections: [
    { id: 'default-permission', label: 'Default permission' },
    { id: 'project-exceptions', label: 'Project exceptions' },
    { id: 'network-boundary', label: 'Network boundary' },
  ] },
  { id: 'tools', label: 'Tools', icon: Wrench, sections: [
    { id: 'core', label: 'Core' },
    { id: 'workflow', label: 'Workflow' },
    { id: 'third-party', label: 'Third party' },
  ] },
  { id: 'skills', label: 'Skills', icon: Library, description: 'Local project and user resources applied to subsequent agent runs.', sections: [
    { id: 'skills', label: 'Skills' },
  ] },
  { id: 'transcription', label: 'Transcription', icon: Mic, description: 'Configure lightweight speech-to-text models and local context hints.', sections: [
    { id: 'stt-model', label: 'Model' },
    { id: 'stt-context', label: 'Context' },
  ] },
  { id: 'suggestions', label: 'Suggestions', icon: Lightbulb, description: 'Reusable prompt chips for this workstation.', sections: [
    { id: 'suggestions', label: 'Suggestions' },
  ] },
  { id: 'notifications', label: 'Notifications', icon: Bell, sections: [
    { id: 'general-notifications', label: 'General' },
    { id: 'sounds', label: 'Sounds' },
  ] },
  { id: 'shortcuts', label: 'Shortcuts', icon: Keyboard, description: 'Fixed keyboard bindings for the desktop workbench.', sections: [
    { id: 'shortcuts', label: 'Shortcuts' },
  ] },
  { id: 'storage', label: 'Storage', icon: HardDrive, description: 'Inspect the local-only data owned by Servergen AI.', sections: [
    { id: 'storage', label: 'Storage' },
  ] },
  { id: 'system', label: 'System', icon: Server, sections: [
    { id: 'network', label: 'Network' },
    { id: 'diagnostics', label: 'Diagnostics' },
    { id: 'daemon', label: 'Daemon' },
    { id: 'desktop-rendering', label: 'Desktop rendering' },
    { id: 'launch-context', label: 'Launch context' },
    { id: 'system-information', label: 'System information' },
  ] },
];

const fieldClass =
  'h-8 rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--ring)]';

const Section: React.FC<{ id: string; title: string; description?: string; children: React.ReactNode }> = ({
  id,
  title,
  description,
  children,
}) => (
  <section id={`settings-section-${id}`} className="scroll-mt-4 grid gap-3">
    <div>
      <h2 className="text-sm font-semibold text-[var(--foreground)]">{title}</h2>
      {description && <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">{description}</p>}
    </div>
    <div className="overflow-hidden rounded-lg border nerve-border bg-[var(--card)]">{children}</div>
  </section>
);

const Row: React.FC<{
  label: string;
  description?: string;
  children?: React.ReactNode;
  stacked?: boolean;
}> = ({ label, description, children, stacked }) => (
  <div className={`border-b nerve-border p-3.5 last:border-b-0 ${stacked ? 'grid gap-3' : 'flex items-center justify-between gap-5'}`}>
    <div className="min-w-0">
      <p className="text-sm font-medium text-[var(--card-foreground)]">{label}</p>
      {description && <p className="mt-0.5 text-xs leading-relaxed text-[var(--muted-foreground)]">{description}</p>}
    </div>
    {children && <div className={stacked ? 'min-w-0' : 'flex-none'}>{children}</div>}
  </div>
);

const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative h-5 w-9 rounded-full border transition-colors disabled:opacity-50 ${
      checked ? 'border-[var(--primary)] bg-[var(--primary)]' : 'border-[var(--input)] bg-[var(--muted)]'
    }`}
  >
    <span className={`absolute top-0.5 size-3.5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
  </button>
);

const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = (props) => (
  <select {...props} className={`${fieldClass} min-w-40 ${props.className ?? ''}`} />
);

const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
  <input {...props} className={`${fieldClass} ${props.className ?? ''}`} />
);

const ChoiceCards = <T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string; description?: string; icon: React.ElementType }>;
  onChange: (value: T) => void;
}) => (
  <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
    {options.map((option) => {
      const Icon = option.icon;
      const active = value === option.value;
      return (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`relative min-h-20 rounded-lg border p-3 text-left transition-colors ${
            active
              ? 'border-[var(--primary)] bg-[var(--accent)]'
              : 'nerve-border bg-[var(--background)] hover:bg-[var(--accent)]'
          }`}
        >
          <Icon size={16} className={active ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]'} />
          <p className="mt-2 text-sm font-medium text-[var(--foreground)]">{option.label}</p>
          {option.description && <p className="mt-0.5 text-[11px] text-[var(--muted-foreground)]">{option.description}</p>}
          {active && <Check size={14} className="absolute right-2.5 top-2.5 text-[var(--primary)]" />}
        </button>
      );
    })}
  </div>
);

type WorkbenchPreferences = {
  compactAt: number;
  keepRecent: number;
  exploreEnabled: boolean;
  exploreModel: string;
  toolEnabled: Record<string, boolean>;
  transcriptionModel: string;
  transcriptionLanguage: string;
  transcriptionVocabulary: string;
  notifications: boolean;
  sounds: boolean;
  diagnosticLogs: boolean;
  suggestions: Array<{ id: string; title: string; prompt: string; enabled: boolean }>;
};

const DEFAULT_PREFS: WorkbenchPreferences = {
  compactAt: 80,
  keepRecent: 20,
  exploreEnabled: true,
  exploreModel: 'qwen3.5-9b',
  toolEnabled: {},
  transcriptionModel: 'whisper.cpp-base',
  transcriptionLanguage: 'Auto detect',
  transcriptionVocabulary: 'Servergen, GGUF, llama.cpp, Zero, P&ID',
  notifications: true,
  sounds: false,
  diagnosticLogs: true,
  suggestions: [
    { id: 'inspect', title: 'Inspect this project', prompt: 'Inspect this project and explain its architecture before proposing changes.', enabled: true },
    { id: 'plan', title: 'Plan an implementation', prompt: 'Research the relevant files and prepare a reviewable implementation plan.', enabled: true },
    { id: 'documents', title: 'Analyze local documents', prompt: 'Analyze the attached documents locally and cite the source page for every finding.', enabled: true },
  ],
};

function useWorkbenchPreferences() {
  const [value, setValue] = useState<WorkbenchPreferences>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('servergen.workbench-preferences.v1') ?? '{}') as Partial<WorkbenchPreferences>;
      return { ...DEFAULT_PREFS, ...stored, toolEnabled: { ...DEFAULT_PREFS.toolEnabled, ...stored.toolEnabled } };
    } catch {
      return DEFAULT_PREFS;
    }
  });
  useEffect(() => {
    localStorage.setItem('servergen.workbench-preferences.v1', JSON.stringify(value));
  }, [value]);
  return [value, setValue] as const;
}

const AddModelDialog: React.FC<{ onClose: () => void; onAdd: (model: ModelEntry) => Promise<void> }> = ({ onClose, onAdd }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({
    id: '',
    displayName: '',
    source: '',
    architecture: 'llama',
    quantization: 'Q4_K_M',
    contextSize: '32768',
    trainedContext: '32768',
    estimatedVramMb: '4096',
    fileSizeBytes: '0',
    backend: 'llama.cpp' as 'llama.cpp' | 'python',
    priority: 'primary' as ModelEntry['priority'],
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (!form.id.trim() || !form.displayName.trim() || !form.source.trim()) {
      setError('Model id, display name, and local weights path are required.');
      return;
    }
    setBusy(true);
    try {
      await onAdd({
        id: form.id.trim(),
        displayName: form.displayName.trim(),
        backend: form.backend,
        location: 'this_device',
        source: form.source.trim(),
        architecture: form.architecture.trim(),
        quantization: form.quantization.trim(),
        contextSize: Number(form.contextSize),
        trainedContext: Number(form.trainedContext),
        capabilities: ['general', 'reasoning', 'tools'] satisfies ModelCapability[],
        estimatedVramMb: Number(form.estimatedVramMb),
        fileSizeBytes: Number(form.fileSizeBytes),
        priority: form.priority,
        note: 'Added from Servergen AI Settings.',
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form onSubmit={submit} className="w-full max-w-xl rounded-xl border nerve-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">Add local model</h2>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">Register a GGUF/llama.cpp model or a local Python sidecar. URLs are refused by the core.</p>
          </div>
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-md hover:bg-[var(--accent)]"><X size={15} /></button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-xs">Model id<Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="my-local-model" /></label>
          <label className="grid gap-1 text-xs">Display name<Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="My Local Model" /></label>
          <label className="col-span-2 grid gap-1 text-xs">Weights path<Input className="font-mono" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="C:/models/model.gguf" /></label>
          <label className="grid gap-1 text-xs">Runtime<Select value={form.backend} onChange={(e) => setForm({ ...form, backend: e.target.value as typeof form.backend })}><option value="llama.cpp">llama.cpp</option><option value="python">Python sidecar</option></Select></label>
          <label className="grid gap-1 text-xs">Priority<Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as ModelEntry['priority'] })}><option value="primary">Primary</option><option value="fallback">Fallback</option><option value="specialist">Specialist</option><option value="disabled">Disabled</option></Select></label>
          <label className="grid gap-1 text-xs">Architecture<Input value={form.architecture} onChange={(e) => setForm({ ...form, architecture: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Quantization<Input value={form.quantization} onChange={(e) => setForm({ ...form, quantization: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Allocated context<Input type="number" min="1" value={form.contextSize} onChange={(e) => setForm({ ...form, contextSize: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Trained context<Input type="number" min="1" value={form.trainedContext} onChange={(e) => setForm({ ...form, trainedContext: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Peak VRAM (MiB)<Input type="number" min="0" value={form.estimatedVramMb} onChange={(e) => setForm({ ...form, estimatedVramMb: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">File bytes<Input type="number" min="0" value={form.fileSizeBytes} onChange={(e) => setForm({ ...form, fileSizeBytes: e.target.value })} /></label>
        </div>
        {error && <p className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-[var(--destructive)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Cancel</button>
          <button disabled={busy} className="servergen-primary h-8 rounded-md px-3 text-sm font-medium disabled:opacity-50"><span className="inline-flex items-center gap-1.5"><Save size={13} />{busy ? 'Adding…' : 'Add model'}</span></button>
        </div>
      </form>
    </div>
  );
};

const TOOL_GROUPS = [
  ['file-inspection', 'File inspection', 'Read, list, find, and search files inside approved workspaces.', 'read · list · find · search'],
  ['file-editing', 'File editing', 'Create and patch files with reviewable diffs and approvals.', 'write · edit · create directory'],
  ['plan-mode', 'Plan mode', 'Research and prepare implementation plans before workspace changes.', 'planning · review · approval'],
  ['todos', 'Todos', 'Track multi-step work in the current task.', 'set todos · inspect progress'],
  ['tasks', 'Task management', 'Start, supervise, inspect, and cancel bounded background work.', 'start · status · logs · control'],
  ['shell', 'Sandbox shell', 'Run allow-listed checks and builds in the local sandbox.', 'command · terminal · process control'],
  ['python', 'Python', 'Run memory-capped Python for analysis and artifact generation.', 'python · data analysis'],
  ['knowledge', 'Knowledge and OCR', 'Search the local index, OCR scans, and analyze drawings.', 'retrieval · OCR · vision'],
  ['documents', 'Documents and artifacts', 'Read and generate DOCX, XLSX, PPTX, PDF, Markdown, and code.', 'read · create · verify'],
  ['transcription', 'Voice transcription', 'Convert microphone input with the selected local STT model.', 'record · transcribe · insert'],
] as const;

const SHORTCUTS = [
  ['New task', 'Ctrl+N'], ['Search', 'Ctrl+K'], ['Settings', 'Ctrl+,'], ['Sandbox', 'Ctrl+`'],
  ['Review changes', 'Ctrl+Shift+G'], ['Files', 'Ctrl+P'], ['Toggle right dock', 'Ctrl+B'], ['Send prompt', 'Enter'],
  ['New line in prompt', 'Shift+Enter'], ['Close popover', 'Escape'],
];

export const SettingsView: React.FC = () => {
  const {
    settings,
    updateSettings,
    settingsPage,
    openSettings,
    setView,
    catalogueModels,
    addCatalogueModel,
    workspaces,
    activeWorkspace,
    hardware,
    coreStatus,
    sovereign,
    knowledgeStats,
    memories,
    artifacts,
    auditLog,
    openTab,
  } = useApp();
  const [appearance, setAppearance] = useState<AppearancePreferences>(() => readAppearance());
  const [prefs, setPrefs] = useWorkbenchPreferences();
  const [addModelOpen, setAddModelOpen] = useState(false);
  const activePage = PAGES.find((item) => item.id === settingsPage) ?? PAGES[0];

  const setApp = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    void updateSettings({ [key]: value } as Partial<AppSettings>);
  };
  const setAppearanceValue = <K extends keyof AppearancePreferences>(key: K, value: AppearancePreferences[K]) => {
    const next = { ...appearance, [key]: value };
    setAppearance(next);
    saveAppearance(next);
  };
  const setTool = (id: string, enabled: boolean) => setPrefs({ ...prefs, toolEnabled: { ...prefs.toolEnabled, [id]: enabled } });
  const scrollTo = (id: string) => document.getElementById(`settings-section-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const pageContent = useMemo(() => {
    if (settingsPage === 'knowledge') return <div className="h-[620px] overflow-hidden rounded-lg border nerve-border"><KnowledgeView /></div>;
    if (settingsPage === 'memories') return <div className="h-[620px] overflow-hidden rounded-lg border nerve-border"><MemoryView /></div>;
    if (settingsPage === 'audit') return <div className="h-[620px] overflow-hidden rounded-lg border nerve-border"><AuditView /></div>;
    return null;
  }, [settingsPage]);

  const renderPage = () => {
    if (pageContent) return pageContent;

    switch (settingsPage) {
      case 'workbench':
        return <>
          <Section id="appearance" title="Appearance">
            <Row label="Theme" description="Nerve's original theme presets, applied directly from the source tokens." stacked>
              <ChoiceCards<ColorTheme> value={appearance.theme} onChange={(value) => setAppearanceValue('theme', value)} options={[
                { value: 'nerve', label: 'Nerve', description: 'Warm neutral and orange', icon: Palette },
                { value: 'ocean', label: 'Ocean', description: 'Cool blue workbench', icon: Waves },
                { value: 'forest', label: 'Forest', description: 'Low-chroma green', icon: TreePine },
              ]} />
            </Row>
            <Row label="Color mode" stacked>
              <ChoiceCards<ColorMode> value={appearance.colorMode} onChange={(value) => setAppearanceValue('colorMode', value)} options={[
                { value: 'system', label: 'System', description: 'Follow Windows', icon: Monitor },
                { value: 'light', label: 'Light', description: 'Light theme', icon: Sun },
                { value: 'dark', label: 'Dark', description: 'Dark theme', icon: Moon },
              ]} />
            </Row>
          </Section>
          <Section id="desktop" title="Desktop">
            <Row label="Header style" description="Auto follows the operating system. Choose another style to override it."><Select value={appearance.headerStyle} onChange={(e) => setAppearanceValue('headerStyle', e.target.value as AppearancePreferences['headerStyle'])}><option value="auto">Auto</option><option value="windows">Windows</option><option value="macos">macOS</option><option value="linux">Linux</option></Select></Row>
            <Row label="Close to system tray" description="Hide Servergen AI in the tray instead of quitting."><Toggle checked={appearance.closeToTray} onChange={(value) => setAppearanceValue('closeToTray', value)} /></Row>
          </Section>
        </>;

      case 'providers':
        return <>
          <Section id="local-runtimes" title="Local runtimes" description="Only runtimes permitted by this air-gapped workflow are shown.">
            <Row label="llama.cpp" description="Loopback-native GGUF inference for reasoning, coding, vision, OCR, and embeddings."><span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-[var(--success)]">Configured</span></Row>
            <Row label="Python sidecars" description="Local specialist runtimes for document processing, data work, and speech-to-text."><span className="rounded-full bg-emerald-500/10 px-2 py-1 text-xs text-[var(--success)]">Available</span></Row>
            <Row label="Public cloud providers" description="Hidden and unavailable. Servergen AI does not expose API keys or public inference providers."><span className="rounded-full bg-[var(--muted)] px-2 py-1 text-xs text-[var(--muted-foreground)]">Blocked</span></Row>
          </Section>
          <Section id="local-models" title="Local models">
            <Row label="Models directory" description="All registered weights must resolve to files on this device."><Input className="w-80 font-mono" value={settings.modelsDirectory} onChange={(e) => setApp('modelsDirectory', e.target.value)} /></Row>
            <Row label="Registered models" description={`${catalogueModels.length} local definitions in the canonical catalogue.`}><button onClick={() => setAddModelOpen(true)} className="servergen-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium"><Plus size={13} />Add model</button></Row>
            <Row label="llama-server path"><Input className="w-80 font-mono" value={settings.llamaServerPath} onChange={(e) => setApp('llamaServerPath', e.target.value)} /></Row>
          </Section>
          <Section id="private-endpoint" title="Private endpoint" description="Optional on-prem inference only; public endpoints remain blocked.">
            <Row label="Allow approved private server"><Toggle checked={settings.allowPrivateServer} onChange={(value) => setApp('allowPrivateServer', value)} /></Row>
            <Row label="Display name"><Input disabled={!settings.allowPrivateServer} value={settings.privateServerName} onChange={(e) => setApp('privateServerName', e.target.value)} placeholder="Inference cluster" /></Row>
            <Row label="Endpoint URL"><Input disabled={!settings.allowPrivateServer} className="w-80 font-mono" value={settings.privateServerUrl} onChange={(e) => setApp('privateServerUrl', e.target.value)} placeholder="https://inference.internal" /></Row>
          </Section>
        </>;

      case 'models':
        return <>
          <Section id="model-catalogue" title="Scoped Models" description="Load, unload, inspect, and route the local model catalogue.">
            <div className="h-[520px] overflow-hidden"><ModelManagerView /></div>
            <div className="flex justify-end border-t nerve-border p-3"><button onClick={() => setAddModelOpen(true)} className="servergen-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium"><Plus size={13} />Add local model</button></div>
          </Section>
          <Section id="runtime" title="Runtime">
            <Row label="Loopback address"><div className="flex gap-2"><Input className="w-36 font-mono" value={settings.routerHost} onChange={(e) => setApp('routerHost', e.target.value)} /><Input className="w-24 font-mono" type="number" value={settings.routerPort} onChange={(e) => setApp('routerPort', Number(e.target.value))} /></div></Row>
            <Row label="Resident models" description="Maximum models kept in memory simultaneously."><Input className="w-20" type="number" min="1" max="3" value={settings.maxResidentModels} onChange={(e) => setApp('maxResidentModels', Number(e.target.value))} /></Row>
            <Row label="Idle eviction" description="Release an unused model after this many seconds."><Input className="w-24" type="number" min="0" value={settings.modelIdleEvictSec} onChange={(e) => setApp('modelIdleEvictSec', Number(e.target.value))} /></Row>
          </Section>
        </>;

      case 'agent':
        return <>
          <Section id="defaults" title="Defaults">
            <Row label="Default mode" description="New conversations start with this agent policy." stacked><ChoiceCards<AgentMode> value={settings.defaultMode} onChange={(value) => setApp('defaultMode', value)} options={[
              { value: 'plan', label: 'Plan', description: 'Read and propose', icon: Lightbulb },
              { value: 'agent', label: 'Agent', description: 'Edit and execute with approval', icon: Bot },
            ]} /></Row>
            <Row label="Permission policy"><Select value={settings.approvalPolicy} onChange={(e) => setApp('approvalPolicy', e.target.value as ApprovalPolicy)}><option value="ask_always">Ask for every write and execution</option><option value="ask_risky_only">Ask only for risky actions</option></Select></Row>
            <Row label="Extended thinking" description="Ask compatible local models to reason longer before answering."><Toggle checked={settings.extendedThinking} onChange={(value) => setApp('extendedThinking', value)} /></Row>
          </Section>
          <Section id="compaction" title="Compaction">
            <Row label="Automatic compaction" description="Summarize older context before the model window fills."><Toggle checked={true} onChange={() => {}} /></Row>
            <Row label="Trigger threshold"><div className="flex items-center gap-2"><Input className="w-20" type="number" min="40" max="95" value={prefs.compactAt} onChange={(e) => setPrefs({ ...prefs, compactAt: Number(e.target.value) })} /><span className="text-xs text-[var(--muted-foreground)]">%</span></div></Row>
            <Row label="Retain recent context"><div className="flex items-center gap-2"><Input className="w-20" type="number" min="5" max="50" value={prefs.keepRecent} onChange={(e) => setPrefs({ ...prefs, keepRecent: Number(e.target.value) })} /><span className="text-xs text-[var(--muted-foreground)]">%</span></div></Row>
          </Section>
          <Section id="explore" title="Explore agent">
            <Row label="Enable Explore" description="Use a read-only local sub-agent for codebase discovery."><Toggle checked={prefs.exploreEnabled} onChange={(value) => setPrefs({ ...prefs, exploreEnabled: value })} /></Row>
            <Row label="Explore model"><Select value={prefs.exploreModel} onChange={(e) => setPrefs({ ...prefs, exploreModel: e.target.value })}>{catalogueModels.map((model) => <option key={model.id} value={model.id}>{model.displayName}</option>)}</Select></Row>
          </Section>
        </>;

      case 'permissions':
        return <>
          <Section id="default-permission" title="Default permission">
            <Row label="Rule set" description="Applied to new local conversations."><Select value={settings.approvalPolicy} onChange={(e) => setApp('approvalPolicy', e.target.value as ApprovalPolicy)}><option value="ask_always">Review first</option><option value="ask_risky_only">Local autonomous</option></Select></Row>
            <Row label="Sandbox network" description="Off means child processes cannot reach any network."><Toggle checked={settings.sandboxNetwork} onChange={(value) => setApp('sandboxNetwork', value)} /></Row>
          </Section>
          <Section id="project-exceptions" title="Project exceptions" description="Every project is isolated and must be approved before tools may access it.">
            {workspaces.length ? workspaces.map((workspace) => <Row key={workspace.id} label={workspace.name} description={workspace.path}><span className={`text-xs ${workspace.approved ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>{workspace.approved ? 'Approved' : 'Blocked'}</span></Row>) : <Row label="No project exceptions" description="Open and approve a project folder from the title bar." />}
          </Section>
          <Section id="network-boundary" title="Network boundary">
            <Row label="Block public internet" description="Hard egress boundary for models, tools, and document processors."><Toggle checked={settings.blockPublicInternet} onChange={(value) => setApp('blockPublicInternet', value)} /></Row>
            <Row label="Observed public traffic"><span className={sovereign.publicInternetBytes === 0 ? 'text-xs text-[var(--success)]' : 'text-xs text-[var(--destructive)]'}>{sovereign.publicInternetBytes.toLocaleString()} bytes</span></Row>
          </Section>
        </>;

      case 'tools':
        return <>
          <Section id="core" title="Core tools" description="Built into the local harness and constrained by workspace permissions.">
            {TOOL_GROUPS.slice(0, 7).map(([id, label, description, tools]) => <Row key={id} label={label} description={`${description} ${tools}.`}><Toggle checked={prefs.toolEnabled[id] ?? true} onChange={(value) => setTool(id, value)} /></Row>)}
          </Section>
          <Section id="workflow" title="Workflow tools" description="Additional local tools selected for Servergen AI.">
            {TOOL_GROUPS.slice(7).map(([id, label, description, tools]) => <Row key={id} label={label} description={`${description} ${tools}.`}><Toggle checked={prefs.toolEnabled[id] ?? true} onChange={(value) => setTool(id, value)} /></Row>)}
          </Section>
          <Section id="third-party" title="Third party">
            <Row label="External integrations" description="No public third-party tool providers are exposed in this air-gapped build."><span className="rounded-full bg-[var(--muted)] px-2 py-1 text-xs text-[var(--muted-foreground)]">Unavailable</span></Row>
          </Section>
        </>;

      case 'skills':
        return <Section id="skills" title="Skills" description="Servergen keeps instructions, knowledge, and memories local and project-scoped.">
          <Row label="Knowledge resources" description={`${knowledgeStats.documents} documents · ${knowledgeStats.chunks.toLocaleString()} indexed passages`}><button onClick={() => openSettings('knowledge')} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Manage</button></Row>
          <Row label="Memory resources" description={`${memories.length} durable global and project-scoped memories`}><button onClick={() => openSettings('memories')} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Manage</button></Row>
          <Row label="Project instructions" description={activeWorkspace ? `Isolated to ${activeWorkspace.name}` : 'Open a project to manage its AGENTS.md'}><span className="text-xs text-[var(--muted-foreground)]">AGENTS.md</span></Row>
        </Section>;

      case 'transcription':
        return <>
          <Section id="stt-model" title="Model" description="Lightweight, offline speech-to-text choices suitable for ordinary workstations.">
            <Row label="Transcription model" stacked><ChoiceCards<string> value={prefs.transcriptionModel} onChange={(value) => setPrefs({ ...prefs, transcriptionModel: value })} options={[
              { value: 'whisper.cpp-tiny', label: 'Whisper Tiny', description: '~75 MB · fastest', icon: Mic },
              { value: 'whisper.cpp-base', label: 'Whisper Base', description: '~142 MB · balanced', icon: Mic },
              { value: 'moonshine-tiny', label: 'Moonshine Tiny', description: '~60 MB · low latency', icon: Activity },
            ]} /></Row>
            <Row label="Model storage" description="STT weights use the same local models root."><span className="max-w-80 truncate font-mono text-xs text-[var(--muted-foreground)]">{settings.modelsDirectory}/stt</span></Row>
            <Row label="Add STT model" description="Register another local Python or whisper.cpp model in the shared catalogue."><button onClick={() => setAddModelOpen(true)} className="inline-flex h-8 items-center gap-1.5 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]"><Plus size={13} />Add model</button></Row>
          </Section>
          <Section id="stt-context" title="Context">
            <Row label="Expected language"><Select value={prefs.transcriptionLanguage} onChange={(e) => setPrefs({ ...prefs, transcriptionLanguage: e.target.value })}><option>Auto detect</option><option>English</option><option>Hindi</option><option>Multilingual</option></Select></Row>
            <Row label="Vocabulary hints" description="Names, acronyms, and preferred spellings passed only to the local transcriber." stacked><Input className="w-full" value={prefs.transcriptionVocabulary} onChange={(e) => setPrefs({ ...prefs, transcriptionVocabulary: e.target.value })} /></Row>
          </Section>
        </>;

      case 'suggestions':
        return <Section id="suggestions" title="Suggestions">
          {prefs.suggestions.map((suggestion) => <Row key={suggestion.id} label={suggestion.title} description={suggestion.prompt}><Toggle checked={suggestion.enabled} onChange={(enabled) => setPrefs({ ...prefs, suggestions: prefs.suggestions.map((item) => item.id === suggestion.id ? { ...item, enabled } : item) })} /></Row>)}
          <Row label="Add suggestion" description="Create a reusable local prompt chip."><button onClick={() => setPrefs({ ...prefs, suggestions: [...prefs.suggestions, { id: crypto.randomUUID(), title: 'New suggestion', prompt: 'Describe the next local workflow.', enabled: true }] })} className="inline-flex h-8 items-center gap-1.5 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]"><Plus size={13} />Add</button></Row>
        </Section>;

      case 'notifications':
        return <>
          <Section id="general-notifications" title="General">
            <Row label="Desktop notifications" description="Notify when a background run completes or needs approval."><Toggle checked={prefs.notifications} onChange={(value) => setPrefs({ ...prefs, notifications: value })} /></Row>
            <Row label="Approval notifications" description="Always surface blocked writes and executions."><Toggle checked={true} onChange={() => {}} /></Row>
          </Section>
          <Section id="sounds" title="Sounds">
            <Row label="Notification sounds" description="Play a local tone for completed runs and approvals."><Toggle checked={prefs.sounds} onChange={(value) => setPrefs({ ...prefs, sounds: value })} /></Row>
          </Section>
        </>;

      case 'shortcuts':
        return <Section id="shortcuts" title="Shortcuts">
          {SHORTCUTS.map(([label, shortcut]) => <Row key={label} label={label}><kbd className="rounded border nerve-border bg-[var(--background)] px-2 py-1 font-mono text-xs text-[var(--muted-foreground)]">{shortcut}</kbd></Row>)}
        </Section>;

      case 'storage':
        return <Section id="storage" title="Storage" description="Canonical state and generated mirrors stay under local roots.">
          <Row label="Model weights" description={settings.modelsDirectory}><span className="font-mono text-xs text-[var(--muted-foreground)]">{catalogueModels.length} models</span></Row>
          <Row label="Knowledge index" description={settings.knowledgeRoot}><span className="font-mono text-xs text-[var(--muted-foreground)]">{knowledgeStats.documents} docs</span></Row>
          <Row label="Memories" description={settings.memoryRoot}><span className="font-mono text-xs text-[var(--muted-foreground)]">{memories.length} entries</span></Row>
          <Row label="Artifacts" description={settings.artifactRoot}><span className="font-mono text-xs text-[var(--muted-foreground)]">{artifacts.length} files</span></Row>
          <Row label="Canonical database" description="state/workbench.db is authoritative; Markdown and JSONL are inspectable mirrors."><HardDrive size={15} className="text-[var(--muted-foreground)]" /></Row>
        </Section>;

      case 'system':
      case 'about':
      case 'sovereignty':
      case 'sandbox':
      case 'artifacts':
        return <>
          <Section id="network" title="Network">
            <Row label="Daemon bind" description="The application API and model router remain bound to loopback."><span className="font-mono text-xs text-[var(--muted-foreground)]">{settings.routerHost}:{settings.routerPort}</span></Row>
            <Row label="Public egress"><span className={settings.blockPublicInternet ? 'text-xs text-[var(--success)]' : 'text-xs text-[var(--warning)]'}>{settings.blockPublicInternet ? 'Blocked' : 'Allowed'}</span></Row>
          </Section>
          <Section id="diagnostics" title="Diagnostics">
            <Row label="Application logging" description={`${auditLog.length} locally retained tool records.`}><Toggle checked={prefs.diagnosticLogs} onChange={(value) => setPrefs({ ...prefs, diagnosticLogs: value })} /></Row>
            <Row label="Audit log"><button onClick={() => openTab('audit', 'Audit')} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Open logs</button></Row>
          </Section>
          <Section id="daemon" title="Daemon">
            <Row label="Core status" description={coreStatus.detail}><span className={`rounded-full px-2 py-1 text-xs ${coreStatus.state === 'connected' ? 'bg-emerald-500/10 text-[var(--success)]' : 'bg-amber-500/10 text-[var(--warning)]'}`}>{coreStatus.state.replace('_', ' ')}</span></Row>
            <Row label="Local model router"><span className="text-xs text-[var(--muted-foreground)]">{coreStatus.router ? 'Running' : 'Stopped'}</span></Row>
          </Section>
          <Section id="desktop-rendering" title="Desktop rendering">
            <Row label="Interface font"><span className="text-xs text-[var(--muted-foreground)]">Outfit</span></Row>
            <Row label="Code and paths"><span className="font-mono text-xs text-[var(--muted-foreground)]">Iosevka</span></Row>
          </Section>
          <Section id="launch-context" title="Launch context">
            <Row label="Project" description={activeWorkspace?.path ?? 'No project open'}><span className="text-xs text-[var(--muted-foreground)]">Local</span></Row>
            <Row label="Security model"><span className="text-xs text-[var(--success)]">Air-gapped</span></Row>
          </Section>
          <Section id="system-information" title="System information">
            <Row label="Application"><span className="text-xs text-[var(--muted-foreground)]">Servergen AI 0.1.0</span></Row>
            <Row label="GPU" description={hardware.gpuName}><span className="font-mono text-xs text-[var(--muted-foreground)]">{Math.round(hardware.vramBudgetMb / 1024)} GB usable</span></Row>
            <Row label="CPU" description={hardware.cpuName}><Cpu size={15} className="text-[var(--muted-foreground)]" /></Row>
          </Section>
        </>;

      default:
        return null;
    }
  };

  return (
    <div className="flex min-h-0 flex-1 bg-[var(--background)] text-[var(--foreground)]">
      <aside className="grid w-[13.5rem] min-h-0 flex-none grid-rows-[auto_minmax(0,1fr)_auto] border-r border-[color-mix(in_oklab,var(--border)_60%,transparent)] bg-[var(--sidebar)] p-[0.9rem_0.7rem] text-[var(--sidebar-foreground)]">
        <div className="px-1.5 pb-3">
          <strong className="text-sm font-semibold text-[var(--foreground)]">Settings</strong>
        </div>
        <nav className="min-h-0 overflow-y-auto space-y-0.5" aria-label="Settings pages">
          {PAGES.map((page) => {
            const Icon = page.icon;
            const active = page.id === activePage.id;
            return <div key={page.id}>
              <button onClick={() => openSettings(page.id)} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm font-medium transition-colors ${active ? 'bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)]'}`}>
                <Icon size={16} strokeWidth={2} className="flex-none opacity-85" />
                <span className="min-w-0 flex-1 truncate">{page.label}</span>
                {page.sections.length > 1 && <ChevronRight size={13} className={`transition-transform ${active ? 'rotate-90' : ''}`} />}
              </button>
              {active && page.sections.length > 1 && <ul className="ml-6 mt-0.5 grid list-none gap-0.5 p-0">
                {page.sections.map((section) => <li key={section.id}><button onClick={() => scrollTo(section.id)} className="w-full rounded-md px-2 py-1 text-left text-xs text-[var(--muted-foreground)] hover:bg-[color-mix(in_oklab,var(--sidebar-accent)_45%,transparent)] hover:text-[var(--sidebar-accent-foreground)]">{section.label}</button></li>)}
              </ul>}
            </div>;
          })}
        </nav>
        <button onClick={() => setView('workbench')} className="mt-3 flex items-center gap-2 rounded-md border nerve-border px-2.5 py-2 text-xs text-[var(--muted-foreground)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)]">
          <X size={13} /> Close settings
        </button>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto px-5 pb-16 pt-4">
        <div className="grid w-full max-w-[44rem] content-start gap-5">
          <header className="flex min-h-10 items-start justify-between gap-4">
            <div>
              <h1 className="text-lg font-semibold">{activePage.label}</h1>
              {activePage.description && <p className="mt-1 text-xs text-[var(--muted-foreground)]">{activePage.description}</p>}
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--muted-foreground)]"><Check size={12} className="text-[var(--success)]" />Saved locally</span>
          </header>
          {renderPage()}
        </div>
      </main>
      {addModelOpen && <AddModelDialog onClose={() => setAddModelOpen(false)} onAdd={addCatalogueModel} />}
    </div>
  );
};
