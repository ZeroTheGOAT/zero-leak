import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Cpu,
  FolderLock,
  Loader2,
  ShieldOff,
  Square,
  Terminal,
  WifiOff,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatDuration } from '../../services/registry';
import type { SandboxRun } from '../../types';

const STATUS: Record<SandboxRun['status'], { label: string; tone: string }> = {
  running: { label: 'running', tone: 'text-[var(--info)]' },
  exited: { label: 'exited', tone: 'text-[var(--muted-foreground)]' },
  killed: { label: 'killed', tone: 'text-[var(--warning)]' },
  timeout: { label: 'timed out', tone: 'text-[var(--warning)]' },
  denied: { label: 'refused', tone: 'text-[var(--destructive)]' },
  interrupted: { label: 'interrupted', tone: 'text-[var(--warning)]' },
};

const UNKNOWN_STATUS = { label: 'unknown', tone: 'text-[var(--muted-foreground)]' };

const RunBlock: React.FC<{ run: SandboxRun }> = ({ run }) => {
  const { killRun } = useApp();
  const [open, setOpen] = useState(true);
  const status = STATUS[run.status] ?? UNKNOWN_STATUS;
  const failed = run.status === 'denied' || (run.exitCode !== undefined && run.exitCode !== 0);

  return (
    <div className="border-b border-[var(--accent)] last:border-0">
      <div className="flex items-start px-2 py-1.5 group">
        <button
          onClick={() => setOpen(!open)}
          className="p-0.5 text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition flex-shrink-0 mt-px"
        >
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline space-x-2">
            <span className="text-[var(--success)] flex-shrink-0 select-none">$</span>
            <code className="text-[12px] text-[var(--foreground)] break-all">{run.command}</code>
          </div>
          <div className="flex items-center space-x-2.5 mt-0.5 text-[10px] tabular-nums">
            <span className={status.tone}>
              {run.status === 'running' && <Loader2 size={9} className="inline animate-spin mr-1" />}
              {status.label}
              {run.exitCode !== undefined && ` · exit ${run.exitCode}`}
            </span>
            {run.durationMs !== undefined && (
              <span className="text-[var(--muted-foreground)]">{formatDuration(run.durationMs)}</span>
            )}
            <span className="text-[var(--input)] font-mono truncate" title={run.cwd}>
              {run.cwd}
            </span>
          </div>
        </div>

        {run.status === 'running' && (
          <button
            onClick={() => void killRun(run.id)}
            className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--destructive)] transition flex-shrink-0"
            title="Terminate — kills the job object and everything inside it"
          >
            <Square size={10} fill="currentColor" />
          </button>
        )}
      </div>

      {open && run.output.length > 0 && (
        <pre className="px-2 pb-2 pl-7 text-[11.5px] leading-[1.55] font-mono whitespace-pre-wrap break-all">
          {run.output.map((line, i) => (
            <span
              key={i}
              className={
                line.stream === 'stderr'
                  ? 'text-[var(--destructive)]'
                  : line.stream === 'system'
                    ? 'text-[var(--warning)]'
                    : 'text-[var(--foreground)]'
              }
            >
              {line.text}
              {'\n'}
            </span>
          ))}
        </pre>
      )}

      {open && run.output.length === 0 && run.status !== 'running' && (
        <p className="px-2 pb-2 pl-7 text-[11px] text-[var(--muted-foreground)]">No output.</p>
      )}

      {failed && run.status === 'denied' && (
        <p className="px-2 pb-2 pl-7 text-[11px] text-[var(--destructive)] leading-relaxed">
          Refused by policy before anything ran — the command matched the deny list.
        </p>
      )}
    </div>
  );
};

/**
 * §8 — the sandbox console.
 *
 * This is not a shell into the machine. Every command runs inside the isolated
 * working directory under a restricted token with the network switched off, and
 * the policy that constrains it is shown here rather than assumed. Commands
 * outside the allow list require approval; commands on the deny list are
 * refused even with approval.
 */
export const SandboxConsole: React.FC = () => {
  const { sandboxPolicy, sandboxRuns, runInSandbox, coreStatus, activeWorkspace } = useApp();

  const [cmd, setCmd] = useState('');
  const [showPolicy, setShowPolicy] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [sandboxRuns]);

  const busy = sandboxRuns.some((r) => r.status === 'running');
  const detached = coreStatus.state === 'unavailable';

  const submit = () => {
    const c = cmd.trim();
    if (!c || detached) return;
    setHistory((prev) => [c, ...prev.filter((x) => x !== c)].slice(0, 50));
    setHistIdx(-1);
    setCmd('');
    void runInSandbox(c);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--sidebar-accent)]">
      {/* Policy header — the constraints, stated */}
      <div className="px-2.5 py-2 border-b border-[var(--muted)] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <Terminal size={12} className="text-[var(--info)] flex-shrink-0" />
            <span className="text-[11px] text-[var(--muted-foreground)]">Isolated execution</span>
          </div>
          <button
            onClick={() => setShowPolicy(!showPolicy)}
            className="text-[10px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition flex-shrink-0"
          >
            {showPolicy ? 'Hide policy' : 'Policy'}
          </button>
        </div>

        <div className="flex items-center flex-wrap gap-x-2.5 gap-y-1 mt-1.5 text-[10px]">
          <span
            className={`flex items-center space-x-1 ${
              sandboxPolicy.networkEnabled ? 'text-[var(--destructive)]' : 'text-[var(--success)]'
            }`}
            title={
              sandboxPolicy.networkEnabled
                ? 'Network access has been granted to this sandbox.'
                : 'The container has no network capability — outbound calls fail at the kernel, not at a filter.'
            }
          >
            {sandboxPolicy.networkEnabled ? <ShieldOff size={9} /> : <WifiOff size={9} />}
            <span>{sandboxPolicy.networkEnabled ? 'network ALLOWED' : 'no network'}</span>
          </span>
          <span className="flex items-center space-x-1 text-[var(--muted-foreground)] tabular-nums">
            <Clock size={9} />
            <span>{sandboxPolicy.timeoutSec}s cap</span>
          </span>
          <span className="flex items-center space-x-1 text-[var(--muted-foreground)] tabular-nums">
            <Cpu size={9} />
            <span>
              {(sandboxPolicy.maxMemoryMb / 1024).toFixed(1)} GiB · {sandboxPolicy.maxProcesses} proc
            </span>
          </span>
        </div>

        <div
          className="flex items-center space-x-1 mt-1 text-[10px] text-[var(--muted-foreground)] font-mono truncate"
          title={sandboxPolicy.workingDir}
        >
          <FolderLock size={9} className="flex-shrink-0" />
          <span className="truncate">{sandboxPolicy.workingDir}</span>
        </div>

        {showPolicy && (
          <div className="mt-2 pt-2 border-t border-[var(--muted)] space-y-2 text-[10.5px]">
            <div>
              <div className="flex items-center space-x-1 text-[var(--success)] mb-1">
                <Check size={9} />
                <span>Runs without approval</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {sandboxPolicy.allowedCommands.map((c) => (
                  <code key={c} className="px-1 py-0.5 rounded bg-[var(--accent)] text-[var(--muted-foreground)]">
                    {c}
                  </code>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center space-x-1 text-[var(--destructive)] mb-1">
                <Ban size={9} />
                <span>Refused even with approval</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {sandboxPolicy.deniedCommands.map((c) => (
                  <code key={c} className="px-1 py-0.5 rounded bg-[var(--accent)] text-[var(--destructive)]">
                    {c}
                  </code>
                ))}
              </div>
            </div>
            <p className="text-[10px] text-[var(--muted-foreground)] leading-relaxed">
              Anything not on either list asks first. The process runs under a restricted token in
              its own job object, so a kill takes its children with it.
            </p>
          </div>
        )}
      </div>

      {/* Runs */}
      <div className="flex-1 overflow-y-auto">
        {sandboxRuns.length === 0 ? (
          <div className="p-3">
            <p className="text-[11.5px] text-[var(--muted-foreground)] leading-relaxed">
              {detached
                ? coreStatus.detail
                : activeWorkspace
                  ? 'Nothing has run yet. Commands execute in the isolated directory above — not in your workspace, and not with your account’s privileges.'
                  : 'Add a workspace first. The sandbox reads its inputs from approved folders only.'}
            </p>
          </div>
        ) : (
          <>
            {sandboxRuns.map((r) => (
              <RunBlock key={r.id} run={r} />
            ))}
            <div ref={endRef} />
          </>
        )}
      </div>

      {/* Prompt */}
      <div className="border-t border-[var(--muted)] p-2 flex-shrink-0">
        <div
          className={`flex items-center space-x-2 px-2.5 py-1.5 rounded-lg bg-[var(--accent)] border transition-colors ${
            detached ? 'border-[var(--border)]' : 'border-[var(--border)] focus-within:border-[var(--primary)]'
          }`}
        >
          <span className="text-[var(--success)] text-[12px] font-mono flex-shrink-0 select-none">$</span>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              } else if (e.key === 'ArrowUp' && history.length) {
                e.preventDefault();
                const i = Math.min(histIdx + 1, history.length - 1);
                setHistIdx(i);
                setCmd(history[i]);
              } else if (e.key === 'ArrowDown' && histIdx >= 0) {
                e.preventDefault();
                const i = histIdx - 1;
                setHistIdx(i);
                setCmd(i < 0 ? '' : history[i]);
              }
            }}
            disabled={detached}
            placeholder={detached ? 'Core not attached' : 'Command to run in the sandbox'}
            spellCheck={false}
            className="flex-1 bg-transparent text-[12px] font-mono text-[var(--foreground)] placeholder-[var(--input)] outline-none disabled:cursor-not-allowed"
          />
          {busy && <Loader2 size={11} className="animate-spin text-[var(--info)] flex-shrink-0" />}
          <button
            onClick={submit}
            disabled={!cmd.trim() || detached}
            className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition disabled:opacity-25 flex-shrink-0"
            title="Run"
          >
            <ArrowUp size={12} />
          </button>
        </div>
        <p className="text-[10px] text-[var(--input)] mt-1.5 px-1 leading-relaxed">
          Destructive commands ask for approval every time, regardless of your policy setting.
        </p>
      </div>
    </div>
  );
};
