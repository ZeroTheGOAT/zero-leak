/*
 * Source-port of Nerve's settings information architecture and presentation
 * primitives for Servergen AI. Nerve Copyright © 2026 ThilinaTLM,
 * Apache-2.0. See THIRD_PARTY_NOTICES.md.
 */
import React, { useEffect, useMemo, useState } from 'react';
import {
  Bell,
  Bot,
  Check,
  ChevronRight,
  CloudCog,
  Cpu,
  HardDrive,
  Globe2,
  Keyboard,
  Library,
  Lightbulb,
  Mic,
  Minus,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Plus,
  PlugZap,
  Save,
  Server,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sun,
  TreePine,
  Trash2,
  Waves,
  Wrench,
  X,
  Ban,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import * as core from '../../services/core';
import { ROUTER_BIND_HOST } from '../../services/registry';
import { languageCode, transcription, TRANSCRIPTION_LANGUAGES, type TranscriptionStatus } from '../../services/transcription';
import { AuditView } from '../panels/AuditView';
import { KnowledgeView } from '../panels/KnowledgeView';
import { MemoryView } from '../panels/MemoryView';
import { ModelManagerView } from '../panels/ModelManagerView';
import type {
  AgentMode,
  AppSettings,
  ApprovalPolicy,
  GuardRule,
  GuardRuleEntry,
  ModelCapability,
  ModelEntry,
  McpServerConfig,
  SettingsPage,
  StoreGateDecision,
  SyncExposure,
  VaultEvent,
  VaultStatus,
} from '../../types';
import {
  readAppearance,
  saveAppearance,
  UI_FONT_MAX,
  UI_FONT_MIN,
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
  { id: 'sovereignty', label: 'Sovereignty', icon: Globe2, description: 'Evidence that this workstation keeps its data on itself.', sections: [
    { id: 'replication', label: 'Replication' },
    { id: 'lock', label: 'Store lock' },
    { id: 'at-rest', label: 'At-rest' },
    { id: 'egress', label: 'Egress' },
  ] },
  { id: 'tools', label: 'Tools', icon: Wrench, sections: [
    { id: 'core', label: 'Core' },
    { id: 'workflow', label: 'Workflow' },
    { id: 'mcp', label: 'MCP' },
    { id: 'web-search', label: 'Web search' },
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
  'h-8 rounded-md border border-[var(--input)] bg-[var(--background)] px-2.5 text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]';

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

/**
 * §11 — one folder's replication verdict.
 *
 * The three states are deliberately distinct, because the whole point of this
 * check is that they are different findings: replicated off the machine, read and
 * found local, and *not examined*. The last one used to be invisible — the core
 * reported it, and nothing in the interface rendered the report at all.
 */
const ExposureRow: React.FC<{ row: SyncExposure }> = ({ row }) => {
  const verdict = row.replicated
    ? { text: 'Replicates off this machine', tone: 'text-[var(--destructive)]', Icon: ShieldAlert }
    : row.examined
      ? { text: 'Local', tone: 'text-[var(--success)]', Icon: ShieldCheck }
      : { text: 'Not examined', tone: 'text-[var(--warning)]', Icon: ShieldAlert };
  return (
    <div className="border-b nerve-border p-3.5 last:border-b-0 grid gap-2">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-[var(--card-foreground)]">
            {row.label}
            {row.owned && (
              <span className="rounded-full border border-[color-mix(in_oklab,var(--border)_70%,transparent)] bg-[var(--muted)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Store folder
              </span>
            )}
          </p>
          <p className="mt-0.5 break-all font-mono text-xs text-[var(--muted-foreground)]">{row.path}</p>
        </div>
        <span className={`flex flex-none items-center gap-1.5 text-xs ${verdict.tone}`}>
          <verdict.Icon size={14} />
          {verdict.text}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{row.detail}</p>
      {row.examined && (
        <p className="text-xs text-[var(--muted-foreground)]">
          {row.filesChecked.toLocaleString()} entries examined · {row.placeholderFiles} cloud placeholders ·{' '}
          {row.pinMarkedFiles} pin-marked · {row.reparsePoints} reparse points
        </p>
      )}
    </div>
  );
};

/**
 * §13 — one row of the store-gate ledger: a §11 refusal, or the audited
 * override that lifted it. Append-only by construction; the application has no
 * delete path for these rows, and this view renders them verbatim.
 */
const GateDecisionRow: React.FC<{ entry: StoreGateDecision }> = ({ entry }) => {
  const overridden = entry.decision === 'overridden';
  return (
    <div className="border-b nerve-border p-3.5 last:border-b-0 grid gap-2">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-[var(--card-foreground)]">
            {overridden ? 'Agent start overridden' : 'Agent start refused'}
            <span className="font-mono text-xs font-normal text-[var(--muted-foreground)]">{entry.operator}</span>
          </p>
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{new Date(entry.at).toLocaleString()}</p>
        </div>
        <span className={`flex flex-none items-center gap-1.5 text-xs ${overridden ? 'text-[var(--warning)]' : 'text-[var(--destructive)]'}`}>
          {overridden ? <ShieldCheck size={14} /> : <ShieldAlert size={14} />}
          {overridden ? 'Overridden' : 'Refused'}
        </span>
      </div>
      {entry.folders.length > 0 && (
        <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">
          Replicating while gated: {entry.folders.join(' · ')}
        </p>
      )}
      {entry.summary && <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{entry.summary}</p>}
    </div>
  );
};

/**
 * §16 — one row of the at-rest vault ledger: an enable, a disable, or a disable
 * refused for a wrong passphrase. Append-only by construction; rendered verbatim.
 */
const VaultEventRow: React.FC<{ entry: VaultEvent }> = ({ entry }) => {
  const meta =
    entry.action === 'enabled'
      ? { title: 'At-rest vault enabled', text: 'Enabled', cls: 'text-[var(--success)]', Icon: ShieldCheck }
      : entry.action === 'disabled'
        ? { title: 'At-rest vault disabled', text: 'Disabled', cls: 'text-[var(--muted-foreground)]', Icon: ShieldCheck }
        : { title: 'Disable refused', text: 'Denied', cls: 'text-[var(--destructive)]', Icon: ShieldAlert };
  return (
    <div className="grid gap-2 border-b nerve-border p-3.5 last:border-b-0">
      <div className="flex items-start justify-between gap-5">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 text-sm font-medium text-[var(--card-foreground)]">
            {meta.title}
            <span className="font-mono text-xs font-normal text-[var(--muted-foreground)]">{entry.operator}</span>
          </p>
          <p className="mt-0.5 text-xs text-[var(--muted-foreground)]">{new Date(entry.at).toLocaleString()}</p>
        </div>
        <span className={`flex flex-none items-center gap-1.5 text-xs ${meta.cls}`}>
          <meta.Icon size={14} />
          {meta.text}
        </span>
      </div>
      {entry.detail && <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{entry.detail}</p>}
    </div>
  );
};

// Geometry and thumb colours ported from Nerve's `settings`-size switch: a
// padded track rather than an absolutely-placed thumb, so the travel can never
// fall outside the rail.
const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }> = ({ checked, onChange, disabled }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent p-0.5 shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] disabled:cursor-not-allowed disabled:opacity-50 ${
      checked ? 'bg-[var(--primary)]' : 'bg-[var(--input)]'
    }`}
  >
    <span
      className={`pointer-events-none block size-3 rounded-full transition-transform ${
        checked
          ? 'translate-x-3 bg-[var(--background)] dark:bg-[var(--primary-foreground)]'
          : 'translate-x-0 bg-[var(--background)] dark:bg-[var(--foreground)]'
      }`}
    />
  </button>
);

const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = (props) => (
  <select {...props} className={`${fieldClass} min-w-40 ${props.className ?? ''}`} />
);

const Input: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => (
  <input {...props} className={`${fieldClass} ${props.className ?? ''}`} />
);

/**
 * An input that commits on blur or Enter rather than on every keystroke.
 * Every keystroke on a settings field is a full settings write — typing
 * "18100" into the port was five writes, and each write on a models path
 * reloads the whole catalogue from disk. A half-typed value is a draft until
 * the operator leaves the field; Escape abandons it.
 */
const CommitInput: React.FC<{
  value: string | number;
  onCommit: (raw: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'onBlur' | 'onKeyDown'>> =
  ({ value, onCommit, ...props }) => {
    const [draft, setDraft] = useState(String(value));
    // Adopt a value that moved underneath us — the core overwriting settings,
    // or another control writing the same field. This field's own commit comes
    // back equal to the draft, so it never clobbers anything.
    useEffect(() => {
      setDraft((current) => (current === String(value) ? current : String(value)));
    }, [value]);
    const commit = () => {
      if (draft.trim() !== '' && draft !== String(value)) onCommit(draft);
    };
    return (
      <Input
        {...props}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(String(value));
            e.currentTarget.blur();
          }
        }}
      />
    );
  };

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

type PreviewMode = 'light' | 'dark';

const ALL_PREVIEW_MODES: PreviewMode[] = ['light', 'dark'];

type PreviewOption<T extends string> = {
  value: T;
  label: string;
  icon: React.ElementType;
  /** Which color modes this option previews; defaults to both light + dark. */
  previews?: PreviewMode[];
};

/*
 * Port of Nerve's SettingsPreviewCards. Each option shows a live miniature of the
 * workbench in that theme: the strips carry data-theme-preview/data-color-mode, so
 * the swatch colors come from the same token blocks the real UI uses rather than
 * from hardcoded values, and stay correct when the token set changes.
 */
const PreviewCards = <T extends string>({
  value,
  options,
  ariaLabel,
  previewAttrs,
  previewForegroundClass = 'bg-[color-mix(in_oklab,var(--foreground)_30%,transparent)]',
  onChange,
}: {
  value: T;
  options: Array<PreviewOption<T>>;
  ariaLabel: string;
  previewAttrs: (option: PreviewOption<T>, mode: PreviewMode) => Record<string, string>;
  previewForegroundClass?: string;
  onChange: (value: T) => void;
}) => (
  <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={ariaLabel}>
    {options.map((option) => {
      const Icon = option.icon;
      const active = value === option.value;
      return (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={active}
          aria-label={option.label}
          onClick={() => onChange(option.value)}
          className={`preview-card grid min-w-0 cursor-pointer gap-1.5 rounded-md border bg-[var(--accent)] p-1.5 text-left transition-colors hover:bg-[var(--muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
            active ? 'border-[var(--primary)]' : 'border-transparent'
          }`}
        >
          <span
            className="preview-frame flex h-12 overflow-hidden rounded-sm border border-[color-mix(in_oklab,var(--border)_60%,transparent)]"
            aria-hidden="true"
          >
            {(option.previews ?? ALL_PREVIEW_MODES).map((mode, index) => (
              <span
                key={mode}
                {...previewAttrs(option, mode)}
                className={`preview-half flex min-w-0 flex-1 gap-1 bg-[var(--background)] p-1 ${
                  index === 1 ? 'preview-divider border-l border-[color-mix(in_oklab,var(--border)_40%,transparent)]' : ''
                }`}
              >
                <span className="w-1.5 flex-none rounded-[2px] bg-[var(--sidebar)]" />
                <span className="grid min-w-0 flex-1 content-start gap-1">
                  <span className={`h-1 w-full rounded-full ${previewForegroundClass}`} />
                  <span className="h-1 w-2/3 rounded-full bg-[color-mix(in_oklab,var(--foreground)_30%,transparent)]" />
                </span>
              </span>
            ))}
          </span>

          <span className="flex min-w-0 items-center gap-1.5">
            {active ? (
              <Check size={14} className="flex-none text-[var(--primary)]" />
            ) : (
              <span className="preview-radio size-3.5 flex-none rounded-full border border-[color-mix(in_oklab,var(--border)_70%,transparent)]" />
            )}
            <Icon size={14} className="flex-none text-[var(--muted-foreground)]" />
            <span className="truncate text-xs font-medium text-[var(--foreground)]">{option.label}</span>
          </span>
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
  exploreModel: 'gemma-4-e4b',
  toolEnabled: {},
  transcriptionModel: 'whisper.cpp-base',
  transcriptionLanguage: 'auto',
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
      const raw = localStorage.getItem('servergen.workbench-preferences.v1');
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_PREFS;
      const rec = parsed as Record<string, unknown>;
      if ('__proto__' in rec || 'constructor' in rec || 'prototype' in rec) return DEFAULT_PREFS;
      const stored = rec as Partial<WorkbenchPreferences>;
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
  /** Which catalogue arm the entry goes through: local files or a private server. */
  const [where, setWhere] = useState<'local' | 'server'>('local');
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
    // Server-model fields. `serverUrl` empty means the global setting applies.
    serverUrl: '',
    serverApiKeyEnv: '',
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (where === 'local') {
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
      return;
    }
    // Server model: the id the remote server serves it under, the server to
    // send requests to, and the NAME of the env var holding the credential —
    // the token itself is the operator's to set in the launch environment.
    if (!form.id.trim() || !form.displayName.trim() || !form.source.trim()) {
      setError('Model id, display name, and the server-side model id are required.');
      return;
    }
    setBusy(true);
    try {
      await onAdd({
        id: form.id.trim(),
        displayName: form.displayName.trim(),
        backend: 'private_endpoint',
        location: 'private_server',
        source: form.source.trim(),
        architecture: form.architecture.trim() || 'remote',
        quantization: form.quantization.trim() || 'server-side',
        contextSize: Number(form.contextSize),
        trainedContext: Number(form.trainedContext),
        capabilities: ['general', 'reasoning', 'tools'] satisfies ModelCapability[],
        estimatedVramMb: Number(form.estimatedVramMb),
        fileSizeBytes: Number(form.fileSizeBytes),
        priority: form.priority,
        note: 'Served by an approved on-prem server.',
        serverUrl: form.serverUrl.trim() || undefined,
        serverApiKeyEnv: form.serverApiKeyEnv.trim() || undefined,
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
            <h2 className="text-base font-semibold">Add model</h2>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              {where === 'local'
                ? 'Register a GGUF/llama.cpp model or a local Python sidecar. URLs are refused by the core.'
                : 'Register a model served by an approved on-prem server. Requests stay behind the network guard.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-md hover:bg-[var(--accent)]"><X size={15} /></button>
        </div>
        <div className="mt-3 flex gap-1 rounded-md bg-[var(--sidebar)] p-1 text-xs">
          {(['local', 'server'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setWhere(tab)}
              className={`flex-1 rounded px-2 py-1 ${where === tab ? 'bg-[var(--card)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}
            >
              {tab === 'local' ? 'This device' : 'On-prem server'}
            </button>
          ))}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-xs">Model id<Input value={form.id} onChange={(e) => setForm({ ...form, id: e.target.value })} placeholder="my-local-model" /></label>
          <label className="grid gap-1 text-xs">Display name<Input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="My Local Model" /></label>
          {where === 'local' ? (
            <label className="col-span-2 grid gap-1 text-xs">Weights path<Input className="font-mono" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="C:/models/model.gguf" /></label>
          ) : (
            <>
              <label className="col-span-2 grid gap-1 text-xs">Server-side model id<Input className="font-mono" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="gemma-4-e4b" /></label>
              <label className="col-span-2 grid gap-1 text-xs">
                Server URL
                <Input className="font-mono" value={form.serverUrl} onChange={(e) => setForm({ ...form, serverUrl: e.target.value })} placeholder="http://10.0.0.10:8080 — empty uses the approved server in Settings" />
              </label>
              <label className="col-span-2 grid gap-1 text-xs">
                Credential env var
                <Input className="font-mono" value={form.serverApiKeyEnv} onChange={(e) => setForm({ ...form, serverApiKeyEnv: e.target.value })} placeholder="SOVEREIGN_MODEL_TOKEN — the NAME, never the token" />
              </label>
            </>
          )}
          {where === 'local' && (
            <label className="grid gap-1 text-xs">Runtime<Select value={form.backend} onChange={(e) => setForm({ ...form, backend: e.target.value as typeof form.backend })}><option value="llama.cpp">llama.cpp</option><option value="python">Python sidecar</option></Select></label>
          )}
          <label className="grid gap-1 text-xs">Priority<Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as ModelEntry['priority'] })}><option value="primary">Primary</option><option value="fallback">Fallback</option><option value="specialist">Specialist</option><option value="disabled">Disabled</option></Select></label>
          <label className="grid gap-1 text-xs">Architecture<Input value={form.architecture} onChange={(e) => setForm({ ...form, architecture: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Quantization<Input value={form.quantization} onChange={(e) => setForm({ ...form, quantization: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Allocated context<Input type="number" min="1" value={form.contextSize} onChange={(e) => setForm({ ...form, contextSize: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Trained context<Input type="number" min="1" value={form.trainedContext} onChange={(e) => setForm({ ...form, trainedContext: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Peak VRAM (MiB)<Input type="number" min="0" value={form.estimatedVramMb} onChange={(e) => setForm({ ...form, estimatedVramMb: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">File bytes<Input type="number" min="0" value={form.fileSizeBytes} onChange={(e) => setForm({ ...form, fileSizeBytes: e.target.value })} /></label>
        </div>
        {error && <p className="mt-3 rounded-md bg-[var(--destructive-soft)] px-3 py-2 text-xs text-[var(--destructive)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Cancel</button>
          <button disabled={busy} className="servergen-primary h-8 rounded-md px-3 text-sm font-medium disabled:opacity-50"><span className="inline-flex items-center gap-1.5"><Save size={13} />{busy ? 'Adding…' : 'Add model'}</span></button>
        </div>
      </form>
    </div>
  );
};

/**
 * §16 — passphrase prompt for enabling or disabling the at-rest vault.
 *
 * Enabling asks for the passphrase twice and enforces the ten-character floor
 * here and in the core; disabling asks once and shows the core's refusal if the
 * passphrase does not verify. The passphrase is sent to the core, used once to
 * seal or restore, and is not stored or retained by either side.
 */
const VaultDialog: React.FC<{
  mode: 'enable' | 'disable';
  onClose: () => void;
  onDone: () => void;
}> = ({ mode, onClose, onDone }) => {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError('');
    if (passphrase.length < 10) {
      setError('The vault passphrase must be at least 10 characters.');
      return;
    }
    if (mode === 'enable' && passphrase !== confirm) {
      setError('The two passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'enable') await core.vault.enable(passphrase);
      else await core.vault.disable(passphrase);
      setPassphrase('');
      setConfirm('');
      onDone();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form onSubmit={submit} className="w-full max-w-md rounded-xl border nerve-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold">{mode === 'enable' ? 'Enable at-rest protection' : 'Disable at-rest protection'}</h2>
            <p className="mt-1 text-xs text-[var(--muted-foreground)]">
              {mode === 'enable'
                ? 'Every existing confidential mirror is sealed to ciphertext and, from then on, none are written in clear text. This passphrase is the only key to those files and is never stored — choose one of at least 10 characters and keep it somewhere safe.'
                : 'Sealed mirrors are decrypted back to plain text and mirror writing resumes. Enter the passphrase that armed the vault; a passphrase that does not verify is recorded in the ledger, not ignored.'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="grid size-8 place-items-center rounded-md hover:bg-[var(--accent)]"><X size={15} /></button>
        </div>
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-xs">{mode === 'enable' ? 'New passphrase' : 'Passphrase'}
            <Input type="password" autoFocus value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={mode === 'enable' ? 'At least 10 characters' : ''} />
          </label>
          {mode === 'enable' && (
            <label className="grid gap-1 text-xs">Confirm passphrase
              <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Repeat the passphrase" />
            </label>
          )}
        </div>
        {error && <p className="mt-3 rounded-md bg-[var(--destructive-soft)] px-3 py-2 text-xs text-[var(--destructive)]">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Cancel</button>
          <button disabled={busy} className={`h-8 rounded-md px-3 text-sm font-medium disabled:opacity-50 ${mode === 'enable' ? 'servergen-primary' : 'border nerve-border hover:bg-[var(--accent)]'}`}>
            {busy ? (mode === 'enable' ? 'Sealing…' : 'Restoring…') : mode === 'enable' ? 'Enable vault' : 'Disable vault'}
          </button>
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
    exposure,
    refreshExposure,
    knowledgeStats,
    memories,
    artifacts,
    auditLog,
    openTab,
  } = useApp();
  const [appearance, setAppearance] = useState<AppearancePreferences>(() => readAppearance());
  const [prefs, setPrefs] = useWorkbenchPreferences();
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [mcpDraft, setMcpDraft] = useState({ name: '', command: '', args: '' });
  const [guardDraft, setGuardDraft] = useState<{
    kind: 'protect_path' | 'forbid_command';
    name: string;
    pattern: string;
    note: string;
  }>({ kind: 'protect_path', name: '', pattern: '', note: '' });
  const [integrationStatus, setIntegrationStatus] = useState<Record<string, string>>({});
  const [localTranscriptionStatus, setLocalTranscriptionStatus] = useState<TranscriptionStatus | null>(null);
  const [gateHistory, setGateHistory] = useState<StoreGateDecision[] | null>(null);
  const [gateHistoryError, setGateHistoryError] = useState<string | null>(null);
  const [vaultStatus, setVaultStatus] = useState<VaultStatus | null>(null);
  const [vaultHistory, setVaultHistory] = useState<VaultEvent[] | null>(null);
  const [vaultError, setVaultError] = useState<string | null>(null);
  const [vaultDialog, setVaultDialog] = useState<'enable' | 'disable' | null>(null);
  const activePage = PAGES.find((item) => item.id === settingsPage) ?? PAGES[0];

  const loadGateLedger = async () => {
    setGateHistoryError(null);
    try {
      setGateHistory(await core.audit.gates(50));
    } catch (reason) {
      setGateHistory(null);
      setGateHistoryError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const loadVault = async () => {
    setVaultError(null);
    try {
      const [status, events] = await Promise.all([core.vault.status(), core.vault.events(50)]);
      setVaultStatus(status);
      setVaultHistory(events);
    } catch (reason) {
      setVaultStatus(null);
      setVaultHistory(null);
      setVaultError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  // Refetch the store-gate ledger and the at-rest vault state each time the
  // Sovereignty page opens, so a refusal, override, enable or disable recorded
  // while the operator was elsewhere is present the moment they look.
  useEffect(() => {
    if (settingsPage === 'sovereignty') {
      void loadGateLedger();
      void loadVault();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsPage]);

  useEffect(() => {
    let current = true;
    void transcription.status(prefs.transcriptionModel)
      .then((status) => { if (current) setLocalTranscriptionStatus(status); })
      .catch((error) => {
        if (current) {
          setLocalTranscriptionStatus({
            ready: false,
            modelId: prefs.transcriptionModel,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      });
    return () => { current = false; };
  }, [prefs.transcriptionModel, settings.modelsDirectory]);

  const setApp = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    void updateSettings({ [key]: value } as { [P in K]: AppSettings[P] });
  };
  const setAppearanceValue = <K extends keyof AppearancePreferences>(key: K, value: AppearancePreferences[K]) => {
    const next = { ...appearance, [key]: value };
    setAppearance(next);
    saveAppearance(next);
  };
  const setTool = (id: string, enabled: boolean) => setPrefs({ ...prefs, toolEnabled: { ...prefs.toolEnabled, [id]: enabled } });
  const saveMcpServer = () => {
    if (!mcpDraft.name.trim() || !mcpDraft.command.trim()) return;
    const idBase = mcpDraft.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp';
    const server: McpServerConfig = {
      id: `${idBase}-${crypto.randomUUID().slice(0, 8)}`,
      name: mcpDraft.name.trim(),
      command: mcpDraft.command.trim(),
      args: mcpDraft.args.split(/\r?\n/).map((arg) => arg.trim()).filter(Boolean),
      enabled: true,
    };
    setApp('mcpServers', [...settings.mcpServers, server]);
    setMcpDraft({ name: '', command: '', args: '' });
  };
  const saveGuardRule = () => {
    const pattern = guardDraft.pattern.trim();
    if (!guardDraft.name.trim() || !pattern) return;
    // A path rule with no absolute spelling can never match anything the core
    // resolves, so it is refused here rather than stored as a silent no-op.
    if (guardDraft.kind === 'protect_path' && !/^[a-zA-Z]:[\\/]/.test(pattern)) return;
    const rule: GuardRule =
      guardDraft.kind === 'protect_path'
        ? { type: 'protect_path', pattern }
        : { type: 'forbid_command', pattern };
    const entry: GuardRuleEntry = {
      id: `guard-${crypto.randomUUID().slice(0, 8)}`,
      name: guardDraft.name.trim(),
      rule,
      note: guardDraft.note.trim(),
      enabled: true,
    };
    setApp('guardRules', [...settings.guardRules, entry]);
    setGuardDraft({ kind: guardDraft.kind, name: '', pattern: '', note: '' });
  };
  const probeMcp = async (server: McpServerConfig) => {
    setIntegrationStatus((current) => ({ ...current, [server.id]: 'Checking…' }));
    try {
      const tools = await core.integrations.probeMcp(server.id);
      setIntegrationStatus((current) => ({ ...current, [server.id]: `${tools.length} tools available` }));
    } catch (error) {
      setIntegrationStatus((current) => ({
        ...current,
        [server.id]: error instanceof Error ? error.message : String(error),
      }));
    }
  };
  const testWebSearch = async () => {
    setIntegrationStatus((current) => ({ ...current, web: 'Checking…' }));
    try {
      await core.integrations.testWebSearch('Servergen AI connectivity test');
      setIntegrationStatus((current) => ({ ...current, web: 'Search connection works' }));
    } catch (error) {
      setIntegrationStatus((current) => ({
        ...current,
        web: error instanceof Error ? error.message : String(error),
      }));
    }
  };
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
            <Row label="Theme" description="Theme presets, applied directly from the source tokens." stacked>
              <PreviewCards<ColorTheme>
                value={appearance.theme}
                ariaLabel="Theme"
                previewForegroundClass="bg-[var(--primary)]"
                previewAttrs={(option, mode) => ({ 'data-theme-preview': option.value, 'data-color-mode': mode })}
                onChange={(value) => setAppearanceValue('theme', value)}
                options={[
                  { value: 'nerve', label: 'Nerve', icon: Palette },
                  { value: 'ocean', label: 'Ocean', icon: Waves },
                  { value: 'forest', label: 'Forest', icon: TreePine },
                  { value: 'zero', label: 'Zero', icon: MessageSquare },
                ]}
              />
            </Row>
            <Row label="Color mode" stacked>
              <PreviewCards<ColorMode>
                value={appearance.colorMode}
                ariaLabel="Color mode"
                previewAttrs={(_option, mode) => ({ 'data-theme-preview': appearance.theme, 'data-color-mode': mode })}
                onChange={(value) => setAppearanceValue('colorMode', value)}
                options={[
                  { value: 'system', label: 'System', icon: Monitor, previews: ['light', 'dark'] },
                  { value: 'light', label: 'Light', icon: Sun, previews: ['light'] },
                  { value: 'dark', label: 'Dark', icon: Moon, previews: ['dark'] },
                ]}
              />
            </Row>
            <Row label="Font size" description="Scales text and layout across the whole workbench — sidebar, transcript, composer and panels. Stored on this device.">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setAppearanceValue('fontSize', Math.max(UI_FONT_MIN, appearance.fontSize - 1))}
                  disabled={appearance.fontSize <= UI_FONT_MIN}
                  aria-label="Decrease font size"
                  className="grid size-8 place-items-center rounded-md border nerve-border text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Minus size={13} />
                </button>
                <span className="w-14 text-center text-sm tabular-nums text-[var(--foreground)]" aria-live="polite">{appearance.fontSize} px</span>
                <button
                  type="button"
                  onClick={() => setAppearanceValue('fontSize', Math.min(UI_FONT_MAX, appearance.fontSize + 1))}
                  disabled={appearance.fontSize >= UI_FONT_MAX}
                  aria-label="Increase font size"
                  className="grid size-8 place-items-center rounded-md border nerve-border text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Plus size={13} />
                </button>
              </div>
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
            <Row label="llama.cpp" description="Loopback-native GGUF inference for reasoning, coding, vision, OCR, and embeddings."><span className="rounded-full bg-[var(--success-soft)] px-2 py-1 text-xs text-[var(--success)]">Configured</span></Row>
            <Row label="Python sidecars" description="Local specialist runtimes for document processing, data work, and speech-to-text."><span className="rounded-full bg-[var(--success-soft)] px-2 py-1 text-xs text-[var(--success)]">Available</span></Row>
            <Row label="Public cloud providers" description="Hidden and unavailable. Servergen AI does not expose API keys or public inference providers."><span className="rounded-full bg-[var(--muted)] px-2 py-1 text-xs text-[var(--muted-foreground)]">Blocked</span></Row>
          </Section>
          <Section id="local-models" title="Local models">
            <Row label="Models directory" description="All registered weights must resolve to files on this device."><CommitInput className="w-80 font-mono" value={settings.modelsDirectory} onCommit={(raw) => setApp('modelsDirectory', raw)} /></Row>
            <Row label="Registered models" description={`${catalogueModels.length} local definitions in the canonical catalogue.`}><button onClick={() => setAddModelOpen(true)} className="servergen-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium"><Plus size={13} />Add model</button></Row>
            <Row label="llama-server path"><CommitInput className="w-80 font-mono" value={settings.llamaServerPath} onCommit={(raw) => setApp('llamaServerPath', raw)} /></Row>
          </Section>
          <Section id="private-endpoint" title="Private endpoint" description="Optional on-prem inference only; public endpoints remain blocked.">
            <Row label="Allow approved private server"><Toggle checked={settings.allowPrivateServer} onChange={(value) => setApp('allowPrivateServer', value)} /></Row>
            <Row label="Display name"><Input disabled={!settings.allowPrivateServer} value={settings.privateServerName} onChange={(e) => setApp('privateServerName', e.target.value)} placeholder="Inference cluster" /></Row>
            <Row label="Endpoint URL" description="Use an approved private IP address. The exact scheme, port and path boundary are enforced."><Input disabled={!settings.allowPrivateServer} className="w-80 font-mono" value={settings.privateServerUrl} onChange={(e) => setApp('privateServerUrl', e.target.value)} placeholder="http://10.0.0.10:8080" /></Row>
          </Section>
        </>;

      case 'models':
        return <>
          <Section id="model-catalogue" title="Scoped Models" description="Load, unload, inspect, and route the local model catalogue.">
            <div className="h-[520px] min-h-0 overflow-hidden flex"><ModelManagerView /></div>
            <div className="flex justify-end border-t nerve-border p-3"><button onClick={() => setAddModelOpen(true)} className="servergen-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium"><Plus size={13} />Add local model</button></div>
          </Section>
          <Section id="runtime" title="Runtime">
            <Row label="Router port" description={`The bind host is fixed at ${ROUTER_BIND_HOST} — the models stay unreachable from off this machine. The port applies the next time the router starts.`}><CommitInput className="w-24 font-mono" type="number" min="1024" max="65535" value={settings.routerPort} onCommit={(raw) => { const n = Number(raw); if (Number.isFinite(n)) setApp('routerPort', n); }} /></Row>
            <Row label="Resident models" description="Maximum models kept in memory simultaneously."><CommitInput className="w-20" type="number" min="1" max="3" value={settings.maxResidentModels} onCommit={(raw) => { const n = Number(raw); if (Number.isFinite(n)) setApp('maxResidentModels', n); }} /></Row>
            <Row label="Idle eviction" description="Release an unused model after this many seconds."><CommitInput className="w-24" type="number" min="0" value={settings.modelIdleEvictSec} onCommit={(raw) => { const n = Number(raw); if (Number.isFinite(n)) setApp('modelIdleEvictSec', n); }} /></Row>
          </Section>
        </>;

      case 'agent':
        return <>
          <Section id="defaults" title="Defaults">
            <Row label="Default mode" description="New conversations start with this agent policy." stacked><ChoiceCards<AgentMode> value={settings.defaultMode} onChange={(value) => setApp('defaultMode', value)} options={[
              { value: 'plan', label: 'Plan', description: 'Read and propose', icon: Lightbulb },
              { value: 'agent', label: 'Agent', description: 'Edit and execute with approval', icon: Bot },
            ]} /></Row>
            <Row label="Permission policy"><Select value={settings.approvalPolicy} onChange={(e) => setApp('approvalPolicy', e.target.value as ApprovalPolicy)}><option value="ask_always">Ask for every write and execution</option><option value="ask_risky_only">Ask only for risky actions</option><option value="auto_run_sandbox">Full autonomy in the sandbox</option></Select></Row>
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
            <Row label="Rule set" description="Applied to new local conversations."><Select value={settings.approvalPolicy} onChange={(e) => setApp('approvalPolicy', e.target.value as ApprovalPolicy)}><option value="ask_always">Review first</option><option value="ask_risky_only">Local autonomous</option><option value="auto_run_sandbox">Full autonomy in the sandbox</option></Select></Row>
            <Row label="Sandbox network" description="Network access remains disabled in this sovereign deployment."><span className="text-xs text-[var(--success)]">Disabled</span></Row>
          </Section>
          <Section id="guardrails" title="Safety guardrails" description="Operator-set hard stops, checked before approvals — like hooks, they cannot be waived by the agent, an allow-session grant, or an approval click.">
            {settings.guardRules.length ? settings.guardRules.map((entry) => (
              <Row
                key={entry.id}
                label={entry.name}
                description={`${entry.rule.type === 'protect_path' ? 'Never write inside' : 'Never run commands matching'} ${entry.rule.pattern}${entry.note ? ` · ${entry.note}` : ''}`}
                stacked
              >
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={entry.enabled}
                    onChange={(enabled) => setApp('guardRules', settings.guardRules.map((item) => item.id === entry.id ? { ...item, enabled } : item))}
                  />
                  <button
                    onClick={() => setApp('guardRules', settings.guardRules.filter((item) => item.id !== entry.id))}
                    className="grid size-8 place-items-center rounded-md border nerve-border text-[var(--muted-foreground)] hover:bg-[var(--destructive-soft)] hover:text-[var(--destructive)]"
                    title="Remove safety rule"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </Row>
            )) : (
              <Row label="No guardrails configured" description="Add one below to make a folder or a command pattern unreachable, no matter what the agent tries." />
            )}
            <Row label="Add safety rule" description="Protect a folder (absolute path, e.g. D:/ or C:/sovereign) or forbid a command pattern (e.g. rm -rf, Remove-Item, format). A refused run reports the rule name and carries on without it." stacked>
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="flex gap-2">
                  <button
                    onClick={() => setGuardDraft({ ...guardDraft, kind: 'protect_path' })}
                    className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border nerve-border px-3 text-xs font-medium ${guardDraft.kind === 'protect_path' ? 'bg-[var(--accent)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)]'}`}
                  >
                    <ShieldAlert size={13} /> Protected path
                  </button>
                  <button
                    onClick={() => setGuardDraft({ ...guardDraft, kind: 'forbid_command' })}
                    className={`inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border nerve-border px-3 text-xs font-medium ${guardDraft.kind === 'forbid_command' ? 'bg-[var(--accent)] text-[var(--foreground)]' : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)]'}`}
                  >
                    <Ban size={13} /> Forbidden command
                  </button>
                </div>
                <Input value={guardDraft.name} onChange={(event) => setGuardDraft({ ...guardDraft, name: event.target.value })} placeholder="Rule name, e.g. Never wipe the models drive" />
                <Input
                  className="font-mono"
                  value={guardDraft.pattern}
                  onChange={(event) => setGuardDraft({ ...guardDraft, pattern: event.target.value })}
                  placeholder={guardDraft.kind === 'protect_path' ? 'D:/models' : 'rm -rf'}
                />
                <Input value={guardDraft.note} onChange={(event) => setGuardDraft({ ...guardDraft, note: event.target.value })} placeholder="Note shown to the agent in the refusal (optional)" />
                <button
                  onClick={saveGuardRule}
                  disabled={!guardDraft.name.trim() || !guardDraft.pattern.trim() || (guardDraft.kind === 'protect_path' && !/^[a-zA-Z]:[\\/]/.test(guardDraft.pattern.trim()))}
                  className="servergen-primary sm:col-span-2 inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-40"
                >
                  <ShieldAlert size={13} /> Add safety rule
                </button>
              </div>
            </Row>
          </Section>
          <Section id="project-exceptions" title="Project exceptions" description="Every project is isolated and must be approved before tools may access it.">
            {workspaces.length ? workspaces.map((workspace) => <Row key={workspace.id} label={workspace.name} description={workspace.path}><span className={`text-xs ${workspace.approved ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>{workspace.approved ? 'Approved' : 'Blocked'}</span></Row>) : <Row label="No project exceptions" description="Open and approve a project folder from the title bar." />}
          </Section>
          <Section id="network-boundary" title="Network boundary">
            <Row label="Block public internet" description="Public HTTP destinations are refused by the application guard. Verify OS-level containment separately."><span className="text-xs text-[var(--success)]">Always blocked</span></Row>
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
          <Section id="mcp" title="MCP servers" description="Local stdio servers only. Each launch and tool call requires approval in Agent mode.">
            {settings.mcpServers.map((server) => (
              <Row key={server.id} label={server.name} description={`${server.command}${server.args.length ? ` · ${server.args.join(' ')}` : ''}`} stacked>
                <div className="flex items-center gap-2">
                  <Toggle
                    checked={server.enabled}
                    onChange={(enabled) => setApp('mcpServers', settings.mcpServers.map((item) => item.id === server.id ? { ...item, enabled } : item))}
                  />
                  <button onClick={() => void probeMcp(server)} className="h-8 rounded-md border nerve-border px-3 text-xs hover:bg-[var(--accent)]">Check tools</button>
                  <button
                    onClick={() => setApp('mcpServers', settings.mcpServers.filter((item) => item.id !== server.id))}
                    className="grid size-8 place-items-center rounded-md border nerve-border text-[var(--muted-foreground)] hover:bg-[var(--destructive-soft)] hover:text-[var(--destructive)]"
                    title="Remove MCP server configuration"
                  >
                    <Trash2 size={13} />
                  </button>
                  {integrationStatus[server.id] && <span className="min-w-0 truncate text-xs text-[var(--muted-foreground)]">{integrationStatus[server.id]}</span>}
                </div>
              </Row>
            ))}
            <Row label="Add local MCP server" description="Use an absolute executable path. Put one argument on each line." stacked>
              <div className="grid gap-2 sm:grid-cols-2">
                <Input value={mcpDraft.name} onChange={(event) => setMcpDraft({ ...mcpDraft, name: event.target.value })} placeholder="Display name" />
                <Input className="font-mono" value={mcpDraft.command} onChange={(event) => setMcpDraft({ ...mcpDraft, command: event.target.value })} placeholder="C:/tools/mcp-server.exe" />
                <textarea
                  value={mcpDraft.args}
                  onChange={(event) => setMcpDraft({ ...mcpDraft, args: event.target.value })}
                  placeholder={'Arguments (one per line)'}
                  className="sm:col-span-2 min-h-20 rounded-md border border-[var(--input)] bg-[var(--background)] p-2.5 font-mono text-xs text-[var(--foreground)] outline-none"
                />
                <button
                  onClick={saveMcpServer}
                  disabled={!mcpDraft.name.trim() || !mcpDraft.command.trim()}
                  className="servergen-primary sm:col-span-2 inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-40"
                >
                  <PlugZap size={13} /> Add MCP server
                </button>
              </div>
            </Row>
          </Section>
          <Section id="web-search" title="Web search" description="The two public tools — search, and fetching one named page — sit behind this switch. Every public byte still counts in the status bar and the audit log.">
            <Row label="Search method" description="Direct combines independent keyless sources. Provider routes through one search API using the environment variable named below.">
              <Select value={settings.webSearchMode} onChange={(event) => setApp('webSearchMode', event.target.value as AppSettings['webSearchMode'])}>
                <option value="disabled">Disabled</option>
                <option value="direct">Direct, no API key</option>
                <option value="provider">Provider API</option>
              </Select>
            </Row>
            {settings.webSearchMode === 'provider' && (
              <>
                <Row label="Provider">
                  <Select value={settings.webSearchProvider} onChange={(event) => setApp('webSearchProvider', event.target.value as AppSettings['webSearchProvider'])}>
                    <option value="brave">Brave Search</option>
                    <option value="tavily">Tavily</option>
                  </Select>
                </Row>
                <Row label="API key environment variable" description="Only the variable name is stored. The key itself never enters settings, memory, or a model prompt.">
                  <Input className="w-64 font-mono" value={settings.webSearchApiKeyEnv} onChange={(event) => setApp('webSearchApiKeyEnv', event.target.value)} placeholder="BRAVE_SEARCH_API_KEY" />
                </Row>
              </>
            )}
            <Row label="Connection test" description={integrationStatus.web ?? 'Runs a harmless fixed query using the selected method.'}>
              <button
                onClick={() => void testWebSearch()}
                disabled={settings.webSearchMode === 'disabled'}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)] disabled:opacity-40"
              >
                <Globe2 size={13} /> Test search
              </button>
            </Row>
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
              { value: 'whisper.cpp-small', label: 'Whisper Small', description: '~488 MB · most accurate', icon: Mic },
            ]} /></Row>
            <Row label="Model storage" description="STT weights use the same local models root."><span className="max-w-80 truncate font-mono text-xs text-[var(--muted-foreground)]">{settings.modelsDirectory}/stt</span></Row>
            <Row label="Local readiness" description={localTranscriptionStatus?.detail ?? 'Checking the local runtime and model…'}><span className={`rounded-full px-2 py-1 text-xs ${localTranscriptionStatus?.ready ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--warning-soft)] text-[var(--warning)]'}`}>{localTranscriptionStatus?.ready ? 'Ready' : localTranscriptionStatus ? 'Setup needed' : 'Checking'}</span></Row>
          </Section>
          <Section id="stt-context" title="Context">
            <Row label="Expected language" description="Passed to whisper.cpp as the spoken language. Auto detect asks it to identify the language itself."><Select value={languageCode(prefs.transcriptionLanguage)} onChange={(e) => setPrefs({ ...prefs, transcriptionLanguage: e.target.value })}>{TRANSCRIPTION_LANGUAGES.map((entry) => <option key={entry.code} value={entry.code}>{entry.label}</option>)}</Select></Row>
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

      case 'sovereignty': {
        // The set the §11 lock gates on: this application's own store folders
        // that the report found genuinely replicating off the machine. Project
        // folders the operator opened deliberately are shown, never locked.
        const lockedStoreFolders = (exposure?.paths ?? []).filter((path) => path.owned && path.replicated);
        const gateState: 'unchecked' | 'clear' | 'locked' =
          exposure === null ? 'unchecked' : lockedStoreFolders.length > 0 ? 'locked' : 'clear';
        return (
        <>
          <Section
            id="replication"
            title="Folder replication"
            description="Whether the folders this application writes to are copied off this machine. Read from the Windows sync-root registrations and the files' own cloud attributes — never from the folder's name, which is why a directory called OneDrive on a machine with no OneDrive account reads as local."
          >
            {exposure === null ? (
              <Row label="Not run yet" description="The replication check has not completed. Nothing is claimed about these folders until it has — an empty report is not a clean one.">
                <button onClick={() => void refreshExposure()} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Run check</button>
              </Row>
            ) : (
              <>
                <Row label={exposure.anyReplicated ? 'Replication found' : 'Verdict'} description={exposure.summary}>
                  <button onClick={() => void refreshExposure()} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Re-check</button>
                </Row>
                {exposure.paths.map((row) => <ExposureRow key={`${row.label}:${row.path}`} row={row} />)}
                <Row
                  label="Sync clients running"
                  description={exposure.clientsRunning.length ? 'Context only. A running client says something on this machine is synced, not that these folders are.' : undefined}
                >
                  <span className={`text-xs ${exposure.clientsRunning.length ? 'text-[var(--warning)]' : 'text-[var(--success)]'}`}>
                    {exposure.clientsRunning.length ? exposure.clientsRunning.join(', ') : 'None'}
                  </span>
                </Row>
                <Row label="Sync roots registered on this machine" description={exposure.registeredRoots.join(' · ') || undefined}>
                  <span className={`text-xs ${exposure.registeredRoots.length ? 'text-[var(--warning)]' : 'text-[var(--success)]'}`}>
                    {exposure.registeredRoots.length || 'None'}
                  </span>
                </Row>
                <Row label="Checked" description={new Date(exposure.checkedAt).toLocaleString()}>
                  <Waves size={15} className="text-[var(--muted-foreground)]" />
                </Row>
              </>
            )}
          </Section>
          <Section
            id="lock"
            title="Store replication lock"
            description="While one of this application's own store folders — the ones whose contents were never meant to leave the machine — is replicating off it, the agent refuses to start. The override does not silence the gate: every start under replication is still refused or lifted, and each lift is written below, append-only and stamped with the operator account."
          >
            <Row
              label={gateState === 'locked' ? 'Store replication detected' : gateState === 'clear' ? 'Store folders are local' : 'Replication not yet measured'}
              description={
                gateState === 'unchecked'
                  ? 'The core re-measures replication on every agent start regardless of this panel. Run the check above to see the folder evidence here.'
                  : gateState === 'locked'
                    ? `Agent starts are ${settings.allowReplicatedStore ? 'lifted under audit — every start is recorded as an override' : 'refused until the replicating folder is moved out of the synced root, or the audited override below is turned on'}: ${lockedStoreFolders.map((folder) => folder.label).join(', ')}.`
                    : exposure?.anyReplicated
                      ? 'Only project folders the operator opened deliberately are replicating. Those are shown in the report above, never locked: their contents were never this application\'s private store.'
                      : 'No owned store folder is copying off this machine, so the gate has nothing to stop.'
              }
            >
              <span className={`rounded-full px-2 py-1 text-xs ${gateState === 'locked' ? (settings.allowReplicatedStore ? 'bg-[var(--warning-soft)] text-[var(--warning)]' : 'bg-[var(--destructive-soft)] text-[var(--destructive)]') : gateState === 'clear' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--warning-soft)] text-[var(--warning)]'}`}>
                {gateState === 'locked' ? (settings.allowReplicatedStore ? 'Overridden' : 'Locked') : gateState === 'clear' ? 'Clear' : 'Not checked'}
              </span>
            </Row>
            <Row
              label="Audited override"
              description={
                settings.allowReplicatedStore
                  ? 'On. Agent starts while a store folder replicates are permitted, and every such start is written to the ledger below as an overridden decision in your name — the opposite of a silent bypass.'
                  : 'Off (recommended). Refusal is the safe answer: a folder that was never told to leave this machine is the strongest evidence it did not. Turn this on only to proceed while replication is present and auditable.'
              }
            >
              <Toggle checked={settings.allowReplicatedStore} onChange={(value) => setApp('allowReplicatedStore', value)} />
            </Row>
            <Row
              label="Decision ledger"
              description={gateHistoryError ? `Could not read the ledger: ${gateHistoryError}` : gateHistory === null ? 'Loading the append-only store-gate table…' : `${gateHistory.length} recorded ${gateHistory.length === 1 ? 'decision' : 'decisions'}, newest first.`}
            >
              <button onClick={() => void loadGateLedger()} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Refresh</button>
            </Row>
            {gateHistoryError ? (
              <Row label="Ledger unavailable" description="The store-gate table could not be read. Nothing is claimed about past decisions." />
            ) : gateHistory === null ? null : gateHistory.length === 0 ? (
              <Row label="No refusals or overrides on record" description="The gate has not had to stop an agent yet. When it does — or when this override lifts it — the decision lands here, and there is no delete path in the application." />
            ) : (
              gateHistory.map((entry) => <GateDecisionRow key={entry.id} entry={entry} />)
            )}
          </Section>
          <Section
            id="at-rest"
            title="At-rest protection"
            description="While enabled, the confidential mirrors this application writes — memory Markdown and each session's transcript — are sealed as AES-256-GCM ciphertext, and none are written in clear text. The key is derived from a passphrase you enter and is never stored or held in memory between operations. Full-volume encryption of the database and your own documents is the operating system's job (BitLocker); this vault covers the copies this application makes of its own store and does not claim more."
          >
            {vaultError ? (
              <Row label="Vault state" description={vaultError}>
                <span className="text-xs text-[var(--destructive)]">Unavailable</span>
              </Row>
            ) : vaultStatus === null ? (
              <Row label="Vault state" description="Reading the vault state from the core — it is read from the state file, never guessed." />
            ) : vaultStatus.enabled ? (
              <>
                <Row
                  label="Status"
                  description={vaultStatus.enabledAt ? `Enabled ${new Date(vaultStatus.enabledAt).toLocaleString()} by ${vaultStatus.operator ?? 'the operator'}.` : `Enabled by ${vaultStatus.operator ?? 'the operator'}.`}
                >
                  <span className="rounded-full bg-[var(--success-soft)] px-2 py-1 text-xs text-[var(--success)]">Enabled</span>
                </Row>
                <Row label="Sealed mirrors" description="Confidential memory and transcript files currently stored as ciphertext. Plain-text mirror writing is paused until the vault is disabled.">
                  <span className="font-mono text-xs text-[var(--muted-foreground)]">{vaultStatus.sealedFiles} sealed</span>
                </Row>
                {vaultStatus.plaintextFiles > 0 && (
                  <Row label="Plaintext mirrors remain" description={`${vaultStatus.plaintextFiles} confidential mirror(s) could not be sealed and are still in clear text. Disabling and re-enabling retries the seal.`}>
                    <span className="text-xs text-[var(--warning)]">{vaultStatus.plaintextFiles} in the clear</span>
                  </Row>
                )}
                <Row label="Restore and resume" description="Disables the vault: sealed mirrors are decrypted back to plain text with your passphrase and mirror writing resumes. Every disable is recorded in the ledger below.">
                  <button onClick={() => setVaultDialog('disable')} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Disable vault</button>
                </Row>
              </>
            ) : (
              <>
                <Row label="Status" description="Confidential mirrors are currently written in clear text alongside the database.">
                  <span className="rounded-full bg-[var(--muted)] px-2 py-1 text-xs text-[var(--muted-foreground)]">Disabled</span>
                </Row>
                <Row label="Seal confidential mirrors" description="Seals every existing memory and transcript mirror to ciphertext and pauses further plain-text writes until the vault is disabled. Choose a passphrase of at least 10 characters — it is never stored.">
                  <button onClick={() => setVaultDialog('enable')} className="servergen-primary h-8 rounded-md px-3 text-sm font-medium">Enable vault</button>
                </Row>
              </>
            )}
            {vaultStatus !== null && vaultHistory !== null && (
              <>
                <div className="border-b nerve-border px-3.5 pt-3.5 pb-1 last:border-b-0">
                  <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">Vault ledger</p>
                </div>
                {vaultHistory.length === 0 ? (
                  <Row label="No vault events on record" description="Nothing has enabled the vault yet — or a disable has already restored and the row above is the pair. Every enable, disable and refused disable lands here, and there is no delete path in the application." />
                ) : (
                  vaultHistory.map((entry) => <VaultEventRow key={entry.id} entry={entry} />)
                )}
              </>
            )}
          </Section>
          <Section
            id="attribution"
            title="Audit attribution"
            description="The operator account every tool call is stamped with from now on. Rows written before attribution are left unclaimed rather than backfilled with a guess — the audit table must never contain invented data."
          >
            <Row label="Operator identity">
              <span className="font-mono text-xs text-[var(--foreground)]">{sovereign.operator}</span>
            </Row>
          </Section>
          <Section id="egress" title="Egress" description="Bytes counted by the guard itself, not by what the application believes it sent.">
            <Row label="Public internet" description="Must remain zero on an air-gapped workstation.">
              <span className={sovereign.publicInternetBytes === 0 ? 'text-xs text-[var(--success)]' : 'text-xs text-[var(--destructive)]'}>
                {sovereign.publicInternetBytes.toLocaleString()} bytes
              </span>
            </Row>
            <Row label="Egress guard" description={settings.blockPublicInternet ? 'Installed and blocking every public destination.' : 'Public destinations are permitted by the current settings.'}>
              <span className={sovereign.egressBlocked ? 'text-xs text-[var(--success)]' : 'text-xs text-[var(--warning)]'}>
                {sovereign.egressBlocked ? 'Blocking' : 'Not blocking'}
              </span>
            </Row>
            <Row label="Approved on-prem server" description={sovereign.privateServerName ?? 'None configured; every request is served on this workstation.'}>
              <span className="text-xs text-[var(--muted-foreground)]">{sovereign.privateServerBytes.toLocaleString()} bytes</span>
            </Row>
            <Row label="Requests served on this device">
              <span className="font-mono text-xs text-[var(--muted-foreground)]">{sovereign.deviceRequests.toLocaleString()}</span>
            </Row>
          </Section>
        </>
        );
      }

      case 'system':
      case 'about':
      case 'sandbox':
      case 'artifacts':
        return <>
          <Section id="network" title="Network" description="Egress follows these switches. Whatever leaves this machine is still counted in the status bar and written to the audit log.">
            <Row label="Daemon bind" description="The application API and model router remain bound to loopback."><span className="font-mono text-xs text-[var(--muted-foreground)]">{ROUTER_BIND_HOST}:{settings.routerPort}</span></Row>
            <Row label="Block public egress" description={settings.blockPublicInternet ? 'On: every public destination is refused — the air-gapped posture.' : 'Off: public destinations are reachable by the web tools and anything the sandbox runs.'}>
              <Toggle checked={settings.blockPublicInternet} onChange={(value) => setApp('blockPublicInternet', value)} />
            </Row>
            <Row label="Sandbox terminal network" description={settings.sandboxNetwork ? 'On: commands in the sandbox (curl, wget, pip, npm install…) may reach the network.' : 'Off: commands run with no network access.'}>
              <Toggle checked={settings.sandboxNetwork} onChange={(value) => setApp('sandboxNetwork', value)} />
            </Row>
          </Section>
          <Section id="diagnostics" title="Diagnostics">
            <Row label="Application logging" description={`${auditLog.length} locally retained tool records.`}><Toggle checked={prefs.diagnosticLogs} onChange={(value) => setPrefs({ ...prefs, diagnosticLogs: value })} /></Row>
            <Row label="Audit log"><button onClick={() => openTab('audit', 'Audit')} className="h-8 rounded-md border nerve-border px-3 text-sm hover:bg-[var(--accent)]">Open logs</button></Row>
          </Section>
          <Section id="daemon" title="Daemon">
            <Row label="Core status" description={coreStatus.detail}><span className={`rounded-full px-2 py-1 text-xs ${coreStatus.state === 'connected' ? 'bg-[var(--success-soft)] text-[var(--success)]' : 'bg-[var(--warning-soft)] text-[var(--warning)]'}`}>{coreStatus.state.replace('_', ' ')}</span></Row>
            <Row label="Local model router"><span className="text-xs text-[var(--muted-foreground)]">{coreStatus.router ? 'Running' : 'Stopped'}</span></Row>
          </Section>
          <Section id="desktop-rendering" title="Desktop rendering">
            <Row label="Interface font"><span className="text-xs text-[var(--muted-foreground)]">Outfit</span></Row>
            <Row label="Code and paths"><span className="font-mono text-xs text-[var(--muted-foreground)]">Iosevka</span></Row>
          </Section>
          <Section id="launch-context" title="Launch context">
            <Row label="Project" description={activeWorkspace?.path ?? 'No project open'}><span className="text-xs text-[var(--muted-foreground)]">Local</span></Row>
            <Row label="Security model"><span className={`text-xs ${settings.blockPublicInternet ? 'text-[var(--success)]' : 'text-[var(--warning)]'}`}>{settings.blockPublicInternet ? 'Air-gapped' : 'Networked — public egress permitted by Settings'}</span></Row>
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
      {vaultDialog && <VaultDialog mode={vaultDialog} onClose={() => setVaultDialog(null)} onDone={() => void loadVault()} />}
    </div>
  );
};
