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
  Route,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import {
  CAPABILITY_LABELS,
  ROUTING_RULES,
  formatBytes,
  formatContext,
  formatDuration,
  modelById,
} from '../../services/registry';
import type { ModelEntry, ModelPriority } from '../../types';

const PRIORITY_TONE: Record<ModelPriority, string> = {
  primary: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/25',
  fallback: 'text-sky-400 bg-sky-500/10 border-sky-500/25',
  specialist: 'text-violet-400 bg-violet-500/10 border-violet-500/25',
  disabled: 'text-[#6b6d75] bg-[#1f212a] border-[#2a2c34]',
};

const ModelCard: React.FC<{ model: ModelEntry }> = ({ model }) => {
  const { modelRuntime, loadModel, evictModel, hardware, loadedModelIds } = useApp();
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
        isLoaded ? 'border-emerald-500/30 bg-emerald-500/[0.03]' : 'border-[#22242c] bg-[#131418]'
      }`}
    >
      <div className="p-3">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <div className="flex items-center space-x-2">
              <span className="flex-shrink-0">
                {rt.state === 'loading' ? (
                  <Loader2 size={12} className="animate-spin text-sky-400" />
                ) : rt.state === 'unloading' ? (
                  <Loader2 size={12} className="animate-spin text-amber-400" />
                ) : rt.state === 'loaded' ? (
                  <CircleDot size={12} className="text-emerald-500" />
                ) : rt.state === 'error' ? (
                  <AlertTriangle size={12} className="text-red-400" />
                ) : disabled ? (
                  <Ban size={12} className="text-[#5f6169]" />
                ) : (
                  <CircleDot size={12} className="text-[#3a3d47]" />
                )}
              </span>
              <h3 className={`text-[13px] font-medium ${disabled ? 'text-[#8e8e93]' : 'text-white'}`}>
                {model.displayName}
              </h3>
              <span
                className={`text-[9.5px] px-1.5 py-0.5 rounded border uppercase tracking-wide ${PRIORITY_TONE[model.priority]}`}
              >
                {model.priority}
              </span>
            </div>

            <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1 mt-1.5 text-[10.5px] text-[#71717a] tabular-nums">
              <span>{model.architecture}</span>
              <span>{model.quantization}</span>
              <span>
                {formatContext(model.contextSize)} ctx
                {model.kvCacheType && model.kvCacheType !== 'f16' && ` · KV ${model.kvCacheType}`}
              </span>
              <span>{formatBytes(model.fileSizeBytes)}</span>
              {model.genTokensPerSec !== undefined && (
                <span className="text-[#8e8e93]">{model.genTokensPerSec.toFixed(1)} tok/s</span>
              )}
              <span
                className={
                  model.backend === 'llama.cpp'
                    ? ''
                    : 'text-amber-600'
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
            {isLoaded ? (
              <button
                onClick={() => void evictModel(model.id)}
                disabled={busy}
                className="flex items-center space-x-1.5 px-2 py-1 rounded text-[11px] text-[#c4c4c8] border border-[#2a2c34] hover:bg-[#1f212a] hover:text-white transition disabled:opacity-40"
                title="Unload and release VRAM"
              >
                <Power size={11} />
                <span>Unload</span>
              </button>
            ) : (
              <button
                onClick={() => void loadModel(model.id)}
                disabled={busy || disabled}
                className="flex items-center space-x-1.5 px-2 py-1 rounded text-[11px] text-[#c4c4c8] border border-[#2a2c34] hover:bg-[#1f212a] hover:text-white transition disabled:opacity-30 disabled:hover:bg-transparent"
                title={
                  disabled
                    ? 'Disabled in the registry — see the note below'
                    : Array.isArray(wouldEvict) && wouldEvict.length > 0
                      ? `Loading this will evict ${wouldEvict.map((id) => modelById(id)?.displayName ?? id).join(', ')}`
                      : 'Load into VRAM'
                }
              >
                <Download size={11} />
                <span>Load</span>
              </button>
            )}
            <button
              onClick={() => setOpen(!open)}
              className="p-1.5 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition"
              title="Details"
            >
              <Info size={12} />
            </button>
          </div>
        </div>

        {/* VRAM fit against the real budget */}
        <div className="mt-2.5">
          <div className="flex items-center justify-between text-[10px] text-[#6b6d75] mb-1 tabular-nums">
            <span>
              {model.estimatedVramMb.toLocaleString()} MiB measured peak
              {isLoaded && rt.residentVramMb !== undefined && (
                <span className="text-emerald-600"> · {rt.residentVramMb.toLocaleString()} resident</span>
              )}
            </span>
            <span>{Math.round(fitPct)}% of budget</span>
          </div>
          <div className="h-1 rounded-full bg-[#22242c] overflow-hidden">
            <div
              className={`h-full rounded-full ${tight ? 'bg-amber-500' : 'bg-[#3f8f6f]'}`}
              style={{ width: `${fitPct}%` }}
            />
          </div>
          {tight && (
            <p className="text-[10px] text-amber-600 mt-1">
              Leaves under 5% headroom — nothing else may be resident alongside it.
            </p>
          )}
        </div>

        {rt.state === 'error' && rt.lastError && (
          <p className="mt-2 text-[11px] text-red-400 leading-relaxed">{rt.lastError}</p>
        )}

        {open && (
          <div className="mt-3 pt-3 border-t border-[#22242c] space-y-2 text-[11px]">
            <div className="flex flex-wrap gap-1">
              {model.capabilities.map((c) => (
                <span
                  key={c}
                  className="px-1.5 py-0.5 rounded bg-[#1f212a] text-[#a1a1aa] text-[10px]"
                >
                  {CAPABILITY_LABELS[c] ?? c}
                </span>
              ))}
            </div>

            <div className="space-y-1 text-[#71717a]">
              <div className="flex">
                <span className="w-24 flex-shrink-0">Trained ctx</span>
                <span className="text-[#a1a1aa] tabular-nums">
                  {model.trainedContext.toLocaleString()} — allocated {model.contextSize.toLocaleString()}
                </span>
              </div>
              {model.promptTokensPerSec !== undefined && (
                <div className="flex">
                  <span className="w-24 flex-shrink-0">Prompt</span>
                  <span className="text-[#a1a1aa] tabular-nums">
                    {model.promptTokensPerSec.toLocaleString()} tok/s
                  </span>
                </div>
              )}
              {rt.loadTimeMs !== undefined && (
                <div className="flex">
                  <span className="w-24 flex-shrink-0">Last load</span>
                  <span className="text-[#a1a1aa]">{formatDuration(rt.loadTimeMs)}</span>
                </div>
              )}
              <div className="flex">
                <span className="w-24 flex-shrink-0">Weights</span>
                <span className="text-[#a1a1aa] font-mono break-all">{model.source}</span>
              </div>
              {model.projector && (
                <div className="flex">
                  <span className="w-24 flex-shrink-0">Projector</span>
                  <span className="text-[#a1a1aa] font-mono break-all">{model.projector}</span>
                </div>
              )}
              <div className="flex">
                <span className="w-24 flex-shrink-0">Location</span>
                <span className="text-[#a1a1aa]">
                  {model.location === 'this_device' ? 'This device' : 'Approved on-prem server'}
                </span>
              </div>
            </div>

            {model.note && (
              <p className="text-[11px] text-[#8e8e93] leading-relaxed bg-[#0f1014] border border-[#22242c] rounded p-2">
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

const RoutingTable: React.FC = () => (
  <div className="space-y-1">
    <p className="text-[11px] text-[#71717a] leading-relaxed mb-2">
      Routing is decided by file type and rules first. Only the general-reasoning path may consult
      a model to classify, and no model is loaded at all for documents that already carry a text
      layer.
    </p>
    {ROUTING_RULES.map((r) => {
      const target = modelById(r.modelId);
      const fallback = modelById(r.fallbackModelId);
      return (
        <div
          key={r.kind}
          className="px-2.5 py-2 rounded-md bg-[#131418] border border-[#22242c]"
        >
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-[#d4d4d8]">{r.label}</span>
            <span
              className={`text-[9.5px] px-1.5 py-0.5 rounded uppercase tracking-wide ${
                r.basis === 'classifier'
                  ? 'bg-amber-500/10 text-amber-500'
                  : 'bg-[#1f212a] text-[#71717a]'
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

          <div className="flex items-center space-x-1.5 mt-1 text-[11px]">
            <ArrowRight size={10} className="text-[#5f6169] flex-shrink-0" />
            {r.deterministic ? (
              <span className="text-emerald-600">No model — native extraction</span>
            ) : (
              <>
                <span className="text-[#a1a1aa]">{target?.displayName ?? r.modelId}</span>
                {fallback && (
                  <span className="text-[#5f6169]">→ {fallback.displayName} on failure</span>
                )}
              </>
            )}
          </div>

          <p className="text-[10.5px] text-[#5f6169] mt-1 leading-relaxed">{r.detail}</p>
        </div>
      );
    })}
  </div>
);

/* ------------------------------------------------------------------ */

export const ModelManagerView: React.FC = () => {
  const { hardware, loadedModelIds, coreStatus, refreshCore, settings, catalogueModels } = useApp();
  const [tab, setTab] = useState<'models' | 'routing'>('models');

  const active = catalogueModels.filter((m) => m.priority !== 'disabled');
  const retired = catalogueModels.filter((m) => m.priority === 'disabled');
  const budget = hardware.vramBudgetMb || 7106;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header: the physical constraint this whole design turns on */}
      <div className="px-3 py-2.5 border-b border-[#1a1b21] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <HardDrive size={13} className="text-[#8e8e93] flex-shrink-0" />
            <span className="text-[11px] text-[#a1a1aa] truncate" title={hardware.gpuName}>
              {hardware.gpuName}
            </span>
          </div>
          <span className="text-[10px] text-[#6b6d75] tabular-nums flex-shrink-0">
            {hardware.vramUsedMb.toLocaleString()} / {budget.toLocaleString()} MiB usable
          </span>
        </div>

        <div className="h-1 rounded-full bg-[#22242c] overflow-hidden mt-2">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              hardware.vramUsedMb > budget * 0.95 ? 'bg-red-500' : 'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(100, (hardware.vramUsedMb / budget) * 100)}%` }}
          />
        </div>

        <p className="text-[10px] text-[#5f6169] mt-1.5 leading-relaxed">
          {settings.maxResidentModels === 1
            ? 'One model resident at a time. Loading another evicts the current one first.'
            : `Up to ${settings.maxResidentModels} models resident.`}
          {settings.modelIdleEvictSec > 0 &&
            ` Idle models are evicted after ${settings.modelIdleEvictSec}s.`}
        </p>

        {coreStatus.state !== 'connected' && (
          <button
            onClick={() => void refreshCore()}
            className="mt-2 w-full flex items-center justify-center space-x-1.5 px-2 py-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 text-[11px] text-amber-400 hover:bg-amber-500/10 transition"
          >
            <AlertTriangle size={11} />
            <span>{coreStatus.detail} — retry</span>
          </button>
        )}
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
                ? 'bg-[#252834] text-white'
                : 'text-[#8e8e93] hover:bg-[#1a1b21] hover:text-[#d4d4d8]'
            }`}
          >
            <Icon size={11} />
            <span>{label}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {tab === 'routing' ? (
          <RoutingTable />
        ) : (
          <>
            {loadedModelIds.length === 0 && (
              <p className="text-[11px] text-[#5f6169] leading-relaxed pb-1">
                Nothing is resident. A model is loaded on demand when a task routes to it, and
                released again — no model sits in VRAM waiting.
              </p>
            )}

            {active.map((m) => (
              <ModelCard key={m.id} model={m} />
            ))}

            {retired.length > 0 && (
              <div className="pt-3">
                <div className="flex items-center space-x-1.5 text-[10px] text-[#5f6169] uppercase tracking-wide mb-2">
                  <Trash2 size={10} />
                  <span>Not routed to</span>
                </div>
                {retired.map((m) => (
                  <ModelCard key={m.id} model={m} />
                ))}
              </div>
            )}

            <p className="text-[10px] text-[#4a4c53] leading-relaxed pt-2 flex items-start space-x-1.5">
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
