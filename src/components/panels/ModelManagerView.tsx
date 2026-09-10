import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Ban,
  CircleDot,
  Cpu,
  Download,
  Eye,
  HardDrive,
  Info,
  Loader2,
  Power,
  Pencil,
  RotateCw,
  Route,
  Trash2,
} from 'lucide-react';
import { ModelEditor } from '../settings/ModelEditor';
import * as core from '../../services/core';
import { useApp } from '../../context/AppContext';
import {
  CAPABILITY_LABELS,
  formatBytes,
  formatContext,
  formatDuration,
} from '../../services/registry';
import type { ModelCapability, ModelEntry, ModelPriority, TaskKind } from '../../types';

const PRIORITY_TONE: Record<ModelPriority, string> = {
  primary: 'text-[var(--success)] bg-[var(--success-soft)] border-[var(--success-ring)]',
  fallback: 'text-[var(--info)] bg-[var(--info-soft)] border-[var(--info-ring)]',
  specialist: 'text-[var(--accent-2)] bg-[var(--accent-2-soft)] border-[var(--accent-2-ring)]',
  disabled: 'text-[var(--muted-foreground)] bg-[var(--card)] border-[var(--border)]',
};

const ModelCard: React.FC<{ model: ModelEntry }> = ({ model }) => {
  const { modelRuntime, loadModel, evictModel, hardware, loadedModelIds, catalogueModels, addCatalogueModel } = useApp();
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);

  const rt = modelRuntime[model.id] ?? { id: model.id, state: 'unloaded' as const };
  const busy = rt.state === 'loading' || rt.state === 'unloading';
  const isLoaded = rt.state === 'loaded';
  const disabled = model.priority === 'disabled';

  const budget = hardware.vramBudgetMb || 7106;
  const fitPct = Math.min(100, (model.estimatedVramMb / budget) * 100);
  const tight = model.estimatedVramMb > budget * 0.95;

  // §2 — one heavy model at a time. Loading this evicts whatever is resident.
  const wouldEvict = !isLoaded && loadedModelIds.filter((id) => id !== model.id);

  return (
    <div
      className={`rounded-lg border transition ${
        isLoaded ? 'border-[var(--success-ring)] bg-[var(--success-soft)]' : 'border-[var(--border)] bg-[var(--sidebar)]'
      }`}
    >
      {editing && <ModelEditor initial={model} onClose={() => setEditing(false)} onAdd={addCatalogueModel} />}
      <div className="p-3">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center space-x-2">
              <span className="flex-shrink-0">
                {rt.state === 'loading' ? (
                  <Loader2 size={12} className="animate-spin text-[var(--info)]" />
                ) : rt.state === 'unloading' ? (
                  <Loader2 size={12} className="animate-spin text-[var(--warning)]" />
                ) : rt.state === 'loaded' ? (
                  <CircleDot size={12} className="text-[var(--success)]" />
                ) : rt.state === 'error' ? (
                  <AlertTriangle size={12} className="text-[var(--destructive)]" />
                ) : disabled ? (
                  <Ban size={12} className="text-[var(--muted-foreground)]" />
                ) : (
                  <CircleDot size={12} className="text-[var(--border)]" />
                )}
              </span>
              <h3 className={`text-[13px] font-medium ${disabled ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'}`}>
                {model.displayName}
              </h3>
              <span
                className={`text-[9.5px] px-1.5 py-0.5 rounded border uppercase tracking-wide ${PRIORITY_TONE[model.priority]}`}
              >
                {model.priority}
              </span>
            </div>

            <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1 mt-1.5 text-[10.5px] text-[var(--muted-foreground)] tabular-nums">
              <span>{model.architecture}</span>
              <span>{model.quantization}</span>
              <span>
                <span
                  className="cursor-help"
                  title={
                    isLoaded && rt.contextTokens
                      ? rt.contextTokens === model.contextSize
                        ? 'The window this model is running with now'
                        : `Launched with ${rt.contextTokens.toLocaleString()} tokens — runtime fitted the ${model.contextSize.toLocaleString()} fallback allocation to available memory`
                      : 'Auto: the runtime fits context to device memory when loading. This number is the fallback allocation.'
                  }
                >
                  {isLoaded && rt.contextTokens ? `${formatContext(rt.contextTokens)} ctx window` : model.location === 'this_device' && model.contextMode !== 'manual' ? 'Auto context' : `${formatContext(model.contextLimit ?? model.contextSize)} ctx`}
                </span>
                {model.kvCacheType && model.kvCacheType !== 'f16' && ` · KV ${model.kvCacheType}`}
              </span>
              <span>{formatBytes(model.fileSizeBytes)}</span>
              {model.genTokensPerSec !== undefined && (
                <span className="text-[var(--muted-foreground)]">{model.genTokensPerSec.toFixed(1)} tok/s</span>
              )}
              <span
                className={
                  model.backend === 'llama.cpp'
                    ? ''
                    : 'text-[var(--warning)]'
                }
                title={
                  model.backend === 'python'
                    ? 'Runs in the Python sidecar, not llama.cpp'
                    : undefined
                }
              >
                {model.backend}
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-1 flex-shrink-0 ml-2">
            <button aria-label={`Edit ${model.displayName}`} title="Edit model" className="p-1.5 rounded hover:bg-[var(--card)]" disabled={busy} onClick={() => setEditing(true)}><Pencil size={12} /></button>
            {model.location === 'private_server' ? <span className="text-[10px] text-[var(--muted-foreground)]">Private server</span> : isLoaded ? (
              <button
                onClick={() => void evictModel(model.id)}
                disabled={busy}
                className="flex items-center space-x-1.5 px-2 py-1 rounded text-[11px] text-[var(--foreground)] border border-[var(--border)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition disabled:opacity-40"
                title="Unload and release VRAM"
              >
                <Power size={11} />
                <span>Unload</span>
              </button>
            ) : (
              <button
                onClick={() => void loadModel(model.id)}
                disabled={busy || disabled}
                className="flex items-center space-x-1.5 px-2 py-1 rounded text-[11px] text-[var(--foreground)] border border-[var(--border)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition disabled:opacity-30 disabled:hover:bg-transparent"
                title={
                  disabled
                    ? 'Disabled in the registry — see the note below'
                    : Array.isArray(wouldEvict) && wouldEvict.length > 0
                      ? `Loading this will evict ${wouldEvict.map((id) => catalogueModels.find((entry) => entry.id === id)?.displayName ?? id).join(', ')}`
                      : 'Load into VRAM'
                }
              >
                <Download size={11} />
                <span>Load</span>
              </button>
            )}
            <button
              onClick={() => setOpen(!open)}
              className="p-1.5 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
              title="Details"
            >
              <Info size={12} />
            </button>
          </div>
        </div>

        {/* VRAM fit against the real budget */}
        <div className="mt-2.5">
          <div className="flex items-center justify-between text-[10px] text-[var(--muted-foreground)] mb-1 tabular-nums">
            <span>
              {model.estimatedVramMb.toLocaleString()} MiB estimated peak
              {isLoaded && rt.residentVramMb !== undefined && (
                <span className="text-[var(--success)]"> · {rt.residentVramMb.toLocaleString()} resident</span>
              )}
            </span>
            <span>{Math.round(fitPct)}% of budget</span>
          </div>
          <div className="h-1 rounded-full bg-[var(--border)] overflow-hidden">
            <div
              className={`h-full rounded-full ${tight ? 'bg-[var(--warning)]' : 'bg-[var(--success)]'}`}
              style={{ width: `${fitPct}%` }}
            />
          </div>
          {tight && (
            <p className="text-[10px] text-[var(--warning)] mt-1">
              Leaves under 5% headroom — nothing else may be resident alongside it.
            </p>
          )}
        </div>

        {rt.state === 'error' && rt.lastError && (
          <p className="mt-2 text-[11px] text-[var(--destructive)] leading-relaxed">{rt.lastError}</p>
        )}

        {open && (
          <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-2 text-[11px]">
            <div className="flex flex-wrap gap-1">
              {model.capabilities.map((c) => (
                <span
                  key={c}
                  className="px-1.5 py-0.5 rounded bg-[var(--card)] text-[var(--muted-foreground)] text-[10px]"
                >
                  {CAPABILITY_LABELS[c] ?? c}
                </span>
              ))}
            </div>

            <div className="space-y-1 text-[var(--muted-foreground)]">
              <div className="flex">
                <span className="w-24 flex-shrink-0">Trained ctx</span>
                <span className="text-[var(--muted-foreground)] tabular-nums">
                  {model.trainedContext.toLocaleString()} — allocated {model.contextSize.toLocaleString()}
                </span>
              </div>
              {isLoaded && rt.contextTokens !== undefined && (
                <div className="flex">
                  <span className="w-24 flex-shrink-0">Running ctx</span>
                  <span className="text-[var(--muted-foreground)] tabular-nums">
                    {rt.contextTokens.toLocaleString()}
                    {rt.contextTokens !== model.contextSize &&
                      ` — raised from ${model.contextSize.toLocaleString()} at launch`}
                  </span>
                </div>
              )}
              {model.promptTokensPerSec !== undefined && (
                <div className="flex">
                  <span className="w-24 flex-shrink-0">Prompt</span>
                  <span className="text-[var(--muted-foreground)] tabular-nums">
                    {model.promptTokensPerSec.toLocaleString()} tok/s
                  </span>
                </div>
              )}
              {rt.loadTimeMs !== undefined && (
                <div className="flex">
                  <span className="w-24 flex-shrink-0">Last load</span>
                  <span className="text-[var(--muted-foreground)]">{formatDuration(rt.loadTimeMs)}</span>
                </div>
              )}
              <div className="flex">
                <span className="w-24 flex-shrink-0">Weights</span>
                <span className="text-[var(--muted-foreground)] font-mono break-all">{model.source}</span>
              </div>
              {model.projector && (
                <div className="flex">
                  <span className="w-24 flex-shrink-0">Projector</span>
                  <span className="text-[var(--muted-foreground)] font-mono break-all">{model.projector}</span>
                </div>
              )}
              <div className="flex">
                <span className="w-24 flex-shrink-0">Location</span>
                <span className="text-[var(--muted-foreground)]">
                  {model.location === 'this_device' ? 'This device' : 'Approved on-prem server'}
                </span>
              </div>
            </div>

            {model.note && (
              <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed bg-[var(--sidebar-accent)] border border-[var(--border)] rounded p-2">
                {model.note}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Routing table (§3)                                                 */
/* ------------------------------------------------------------------ */

const ROUTE_CAPABILITIES: Record<TaskKind, ModelCapability[]> = {
  digital_document: [],
  scanned_document: ['ocr', 'documents'],
  handwriting: ['handwriting', 'ocr', 'vision'],
  engineering_drawing: ['drawings', 'vision'],
  photograph: ['vision'],
  code: ['coding'],
  long_context: ['long_context'],
  knowledge_query: ['reasoning', 'general'],
  reasoning: ['reasoning', 'general'],
  embedding: ['embeddings'],
};

const supportsRoute = (model: ModelEntry, kind: TaskKind) =>
  model.priority !== 'disabled' &&
  ROUTE_CAPABILITIES[kind].some((capability) => model.capabilities.includes(capability));

const RoutingTable: React.FC = () => {
  const { routeRules, catalogueModels, updateModelRoute } = useApp();
  const [saving, setSaving] = useState<TaskKind | null>(null);

  const changeRoute = async (
    kind: TaskKind,
    modelId: string,
    fallbackModelId?: string,
  ) => {
    setSaving(kind);
    await updateModelRoute(kind, modelId, fallbackModelId);
    setSaving(null);
  };

  return (
  <div className="space-y-2">
    <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed mb-2">
      Routing first identifies the kind of work, then uses your selected local model. Only models
      with the required capability are offered. Digital documents with an existing text layer stay
      model-free because native extraction is faster and exact.
    </p>
    {routeRules.map((r) => {
      const candidates = catalogueModels.filter((model) => supportsRoute(model, r.kind));
      const deterministic = r.modelId === null;
      return (
        <div
          key={r.kind}
          className="px-2.5 py-2 rounded-md bg-[var(--sidebar)] border border-[var(--border)]"
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[var(--foreground)]">{r.label}</span>
            <span
              className={`text-[9.5px] px-1.5 py-0.5 rounded uppercase tracking-wide ${
                r.basis === 'classifier'
                  ? 'bg-[var(--warning-soft)] text-[var(--warning)]'
                  : 'bg-[var(--card)] text-[var(--muted-foreground)]'
              }`}
              title={
                r.basis === 'classifier'
                  ? 'May consult a lightweight model when rules cannot decide'
                  : 'Decided without invoking any model'
              }
            >
              {r.basis.replace('_', ' ')}
            </span>
          </div>

          <div className="mt-2 text-[11px]">
            {deterministic ? (
              <span className="text-[var(--success)]">No model — native extraction</span>
            ) : (
              <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
                <label className="text-[var(--muted-foreground)]">Primary</label>
                <select
                  value={r.modelId ?? ''}
                  disabled={saving === r.kind}
                  onChange={(event) => {
                    const next = event.target.value;
                    const fallback = r.fallbackModelId === next ? undefined : r.fallbackModelId;
                    void changeRoute(r.kind, next, fallback);
                  }}
                  className="h-8 min-w-0 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] outline-none disabled:opacity-50"
                >
                  {candidates.map((model) => (
                    <option key={model.id} value={model.id}>{model.displayName}</option>
                  ))}
                </select>

                <label className="text-[var(--muted-foreground)]">Fallback</label>
                <select
                  value={r.fallbackModelId ?? ''}
                  disabled={saving === r.kind}
                  onChange={(event) =>
                    void changeRoute(r.kind, r.modelId ?? '', event.target.value || undefined)
                  }
                  className="h-8 min-w-0 rounded-md border border-[var(--border)] bg-[var(--background)] px-2 text-[11px] text-[var(--foreground)] outline-none disabled:opacity-50"
                >
                  <option value="">No fallback</option>
                  {candidates
                    .filter((model) => model.id !== r.modelId)
                    .map((model) => (
                      <option key={model.id} value={model.id}>{model.displayName}</option>
                    ))}
                </select>
              </div>
            )}
          </div>

          <p className="text-[10.5px] text-[var(--muted-foreground)] mt-2 leading-relaxed flex items-start gap-1.5">
            {!deterministic && <ArrowRight size={10} className="flex-shrink-0 mt-0.5" />}
            <span>{saving === r.kind ? 'Saving route…' : r.detail}</span>
          </p>
        </div>
      );
    })}
  </div>
  );
};

/* ------------------------------------------------------------------ */

export const ModelManagerView: React.FC = () => {
  const { hardware, loadedModelIds, coreStatus, refreshCore, settings, catalogueModels, anyRunning } = useApp();
  const [restarting, setRestarting] = useState(false);
  const [runtimeError, setRuntimeError] = useState('');
  const restart = async () => {
    setRestarting(true); setRuntimeError('');
    try { await core.models.routerRestart(); await refreshCore(); }
    catch (reason) { setRuntimeError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setRestarting(false); }
  };
  const [tab, setTab] = useState<'models' | 'routing'>('models');

  const active = catalogueModels.filter((m) => m.priority !== 'disabled');
  const retired = catalogueModels.filter((m) => m.priority === 'disabled');
  const budget = hardware.vramBudgetMb || 7106;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header: the physical constraint this whole design turns on */}
      <div className="px-3 py-2.5 border-b border-[var(--muted)] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <HardDrive size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />
            <span className="text-[11px] text-[var(--muted-foreground)] truncate" title={hardware.gpuName}>
              {hardware.gpuName}
            </span>
          </div>
          <span className="text-[10px] text-[var(--muted-foreground)] tabular-nums flex-shrink-0">
            {hardware.vramUsedMb.toLocaleString()} / {budget.toLocaleString()} MiB usable
          </span>
        </div>

        <div className="h-1 rounded-full bg-[var(--border)] overflow-hidden mt-2">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              hardware.vramUsedMb > budget * 0.95 ? 'bg-[var(--destructive)]' : 'bg-[var(--success)]'
            }`}
            style={{ width: `${Math.min(100, (hardware.vramUsedMb / budget) * 100)}%` }}
          />
        </div>

        <p className="text-[10px] text-[var(--muted-foreground)] mt-1.5 leading-relaxed">
          {settings.maxResidentModels === 1
            ? 'One model resident at a time. Loading another evicts the current one first.'
            : `Up to ${settings.maxResidentModels} models resident.`}
          {settings.modelIdleEvictSec > 0 &&
            ` Idle models are evicted after ${settings.modelIdleEvictSec}s.`}
        </p>

        {coreStatus.state !== 'connected' && (
          <button
            onClick={() => void refreshCore()}
            className="mt-2 w-full flex items-center justify-center space-x-1.5 px-2 py-1.5 rounded-md border border-[var(--warning-ring)] bg-[var(--warning-soft)] text-[11px] text-[var(--warning)] hover:bg-[var(--warning-soft)] transition"
          >
            <AlertTriangle size={11} />
            <span>{coreStatus.detail} — retry</span>
          </button>
        )}
      </div>

      <div className="px-3 py-2 border-b nerve-border text-xs">
        <p className="text-[var(--muted-foreground)]">Context defaults to Auto. Set a custom limit beside Thinking Effort in the composer. Restart after adding models or changing runtime settings; resident models will unload.</p>
        <button className="mt-2 inline-flex items-center gap-1.5 rounded border nerve-border px-2 py-1 disabled:opacity-40" disabled={restarting || anyRunning || coreStatus.state === 'unavailable' || coreStatus.state === 'checking'} onClick={() => void restart()}><RotateCw size={12} />{restarting ? 'Restarting…' : 'Restart model runtime'}</button>
        {anyRunning && <p className="mt-1 text-[var(--muted-foreground)]">Available after active tasks finish.</p>}
        {runtimeError && <p role="alert" className="mt-1 break-words text-[var(--destructive)]">{runtimeError}</p>}
      </div>
      {/* Tabs */}
      <div className="flex items-center px-3 pt-2 space-x-1 flex-shrink-0">
        {(
          [
            ['models', 'Models', Cpu],
            ['routing', 'Routing', Route],
          ] as const
        ).map(([key, label, Icon]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`flex items-center space-x-1.5 px-2.5 py-1 rounded-md text-[11px] transition ${
              tab === key
                ? 'bg-[var(--popover)] text-[var(--foreground)]'
                : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]'
            }`}
          >
            <Icon size={11} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 min-h-0 overflow-y-scroll overscroll-contain p-3 space-y-2">
        {tab === 'routing' ? (
          <RoutingTable />
        ) : (
          <>
            {loadedModelIds.length === 0 && (
              <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed pb-1">
                Nothing is resident. A model is loaded on demand when a task routes to it, and
                released again — no model sits in VRAM waiting.
              </p>
            )}

            {active.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}

            {retired.length > 0 && (
              <div className="pt-3">
                <div className="flex items-center space-x-1.5 text-[10px] text-[var(--muted-foreground)] uppercase tracking-wide mb-2">
                  <Trash2 size={10} />
                  <span>Not routed to</span>
                </div>
                {retired.map((m) => (
                  <ModelCard key={m.id} model={m} />
                ))}
              </div>
            )}

            <p className="text-[10px] text-[var(--input)] leading-relaxed pt-2 flex items-start space-x-1.5">
              <Eye size={10} className="flex-shrink-0 mt-0.5" />
              <span>
                VRAM figures and throughput were measured on this machine, not estimated. Context
                sizes match the curated preset at {settings.modelPresetPath}.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  );
};
