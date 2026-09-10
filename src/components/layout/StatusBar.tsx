import React from 'react';
import { Cpu, HardDrive, Laptop, MemoryStick, Loader2, AlertTriangle, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatDuration } from '../../services/registry';
import { isSubagentActive } from '../../services/subagents';

const Meter: React.FC<{ used: number; total: number; warn?: boolean }> = ({ used, total, warn }) => {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="w-16 h-1 rounded-full bg-[var(--border)] overflow-hidden">
      <div
        className={`h-full rounded-full transition-all duration-500 ${
          warn ? 'bg-[var(--warning)]' : pct > 90 ? 'bg-[var(--destructive)]' : 'bg-[var(--success)]'
        }`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
};

/**
 * §11 + §2 — the honest bottom line: what is loaded, what it costs, and
 * whether anything is running. Numbers come from the core, never from a guess.
 */
export const StatusBar: React.FC = () => {
  const {
    hardware,
    catalogueModels,
    modelRuntime,
    anyRunning,
    runningSessionIds,
    liveSteps,
    subagents,
    failures,
    dismissFailure,
    coreStatus,
    openTab,
  } = useApp();

  const loaded = catalogueModels.filter((m) => modelRuntime[m.id]?.state === 'loaded');
  const busy = catalogueModels.find((m) => {
    const s = modelRuntime[m.id]?.state;
    return s === 'loading' || s === 'unloading';
  });
  const busyState = busy ? modelRuntime[busy.id]?.state : undefined;
  // The open chat's step; when the running chat is another one, say so rather
  // than naming a step that belongs to a conversation the operator left.
  const currentStep = liveSteps.filter((s) => s.status === 'running').slice(-1)[0];
  const latest = failures[0];
  const activeChildren = subagents.filter(isSubagentActive).length;

  const gb = (mb: number) => (mb / 1024).toFixed(1);

  return (
    <footer className="h-7 nerve-card border-t nerve-border flex items-center justify-between gap-3 px-1.5 text-xs text-[var(--muted-foreground)] select-none flex-shrink-0 tabular-nums">
      {/* Left: activity */}
      <div className="flex items-center space-x-3 min-w-0">
        {busy ? (
          <span className="flex items-center space-x-1.5 text-[var(--info)]">
            <Loader2 size={11} className="animate-spin" />
            <span className="truncate">
              {busyState === 'loading' ? 'Loading' : 'Evicting'} {busy.displayName}
            </span>
          </span>
        ) : anyRunning ? (
          <span className="flex items-center space-x-1.5 text-[var(--success)]">
            <Loader2 size={11} className="animate-spin" />
            <span className="truncate max-w-[380px]">
              {currentStep
                ? currentStep.title
                : activeChildren > 0
                  ? `${activeChildren} sub-agent${activeChildren === 1 ? '' : 's'} working`
                : runningSessionIds.length > 1
                  ? `Working in ${runningSessionIds.length} chats`
                  : 'Working in another chat'}
            </span>
          </span>
        ) : latest ? (
          <span className="flex items-center space-x-1.5 text-[var(--warning)] min-w-0">
            <AlertTriangle size={11} className="flex-shrink-0" />
            <span className="truncate max-w-[420px]" title={latest.recovery ?? latest.message}>
              {latest.message}
            </span>
            <button
              onClick={() => dismissFailure(latest.id)}
              aria-label="Dismiss latest failure"
              className="hover:text-[var(--foreground)] flex-shrink-0"
              title="Dismiss"
            >
              <X size={10} />
            </button>
          </span>
        ) : (
          <span className="flex items-center space-x-1.5">
            <Laptop size={11} />
            <span>
              {coreStatus.state === 'connected'
                ? 'Idle · all computation on this device'
                : coreStatus.detail}
            </span>
          </span>
        )}
      </div>

      {/* Right: resident model + telemetry */}
      <div className="flex items-center space-x-4 flex-shrink-0">
        <button
          onClick={() => openTab('models', 'Models')}
          aria-label="Open model runtime panel"
          className="flex items-center space-x-1.5 hover:text-[var(--foreground)] transition"
          title="Model runtime"
        >
          <HardDrive size={11} />
          <span>
            {loaded.length === 0
              ? 'No model resident'
              : loaded
                  .map((m) => {
                    const rt = modelRuntime[m.id];
                    const speed = rt?.lastTokensPerSec ?? m.genTokensPerSec;
                    return speed ? `${m.displayName} · ${speed.toFixed(1)} tok/s` : m.displayName;
                  })
                  .join(' · ')}
          </span>
          {loaded.length === 1 && modelRuntime[loaded[0]?.id ?? '']?.loadTimeMs !== undefined && (
            <span className="text-[var(--muted-foreground)] opacity-70">
              ({formatDuration(modelRuntime[loaded[0]?.id ?? '']?.loadTimeMs ?? 0)} to load)
            </span>
          )}
        </button>

        <div className="flex items-center space-x-1.5" title={`${hardware.gpuName} — budget ${hardware.vramBudgetMb} MiB of ${hardware.vramTotalMb} MiB`}>
          <span className="text-[var(--muted-foreground)]">VRAM</span>
          <Meter
            used={hardware.vramUsedMb}
            total={hardware.vramBudgetMb || hardware.vramTotalMb}
            warn={hardware.offloading}
          />
          <span>
            {gb(hardware.vramUsedMb)}/{gb(hardware.vramBudgetMb || hardware.vramTotalMb)} GB
          </span>
          {hardware.offloading && (
            <span className="text-[var(--warning)]" title="Some layers spilled to system RAM">
              offloading
            </span>
          )}
        </div>

        <div className="flex items-center space-x-1.5" title={hardware.gpuName}>
          <Cpu size={11} />
          <span>GPU {Math.round(hardware.gpuUtilPct)}%</span>
        </div>

        <div className="flex items-center space-x-1.5" title={hardware.cpuName}>
          <MemoryStick size={11} />
          <span>
            RAM {gb(hardware.ramUsedMb)}/{gb(hardware.ramTotalMb)} GB
          </span>
        </div>
      </div>
    </footer>
  );
};
