import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Square, Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { SandboxRun } from '../../types';

/** Coloured status suffix that appears at the end of an echo line when a run
 *  did not end cleanly. A clean exit prints nothing — like PowerShell. */
const SUFFIX: Partial<Record<SandboxRun['status'], { text: string; tone: string }>> = {
  running: { text: 'running…', tone: 'text-[var(--info)]' },
  killed: { text: 'terminated', tone: 'text-[var(--warning)]' },
  timeout: { text: 'timed out', tone: 'text-[var(--warning)]' },
  denied: { text: 'refused by policy', tone: 'text-[var(--destructive)]' },
  interrupted: { text: 'interrupted', tone: 'text-[var(--warning)]' },
};

const RunLine: React.FC<{ run: SandboxRun }> = ({ run }) => {
  const { killRun } = useApp();
  const suffix = SUFFIX[run.status] ?? {
    text: run.exitCode !== undefined ? `exit ${run.exitCode}` : '',
    tone: 'text-[var(--destructive)]',
  };
  const running = run.status === 'running';

  return (
    <div className="px-2 py-0.5">
      {/* Echo line: `PS <dir>> <command>`, prompt in the muted colour. */}
      <div className="flex items-center">
        <span
          className="max-w-[45%] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-[var(--muted-foreground)]"
          title={run.cwd}
        >
          {run.cwd ? `PS ${run.cwd}>` : 'PS>'}
        </span>
        <code className="ml-2 min-w-0 break-all font-mono text-[12px] text-[var(--foreground)]">
          {run.command}
        </code>
        <span className="ml-2 flex flex-shrink-0 items-center text-[10px]">
          {running && <Loader2 size={10} className="mr-1 animate-spin text-[var(--info)]" />}
          {suffix.text && <span className={suffix.tone}>{suffix.text}</span>}
          {running && (
            <button
              onClick={() => void killRun(run.id)}
              className="ml-1.5 rounded p-0.5 text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--destructive)]"
              title="Stop the run — kills the job object and everything inside it"
              aria-label="Stop run"
            >
              <Square size={10} fill="currentColor" />
            </button>
          )}
        </span>
      </div>

      {/* Output below the echo, plain text — stdout, stderr and system notes
          only differ by colour, nothing else. */}
      {run.output.length > 0 && (
        <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] leading-[1.55]">
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
    </div>
  );
};

/**
 * §8 — the sandbox console, one shared component for the bottom dock and the
 * side panel's Sandbox tab, so both behave identically.
 *
 * It is drawn like a plain shell window: no bars, no borders, no chips —
 * just a transcript on the background colour. Each run echoes as
 * `PS <working-directory>> <command>` with its output beneath, exactly as a
 * terminal shows it, and the live prompt at the end of the transcript is a
 * single line — `PS <dir>>` with the caret right after it — not a typing bar
 * under the panel. Enter runs, ↑/↓ walk history, and the transcript
 * autoscrolls so the prompt returns to the bottom after every command.
 * A lone trash glyph at the prompt's end clears the transcript after a
 * confirming click.
 *
 * The audit log stays the durable record of what ran; clearing the console
 * only empties this view.
 */
export const SandboxConsole: React.FC = () => {
  const {
    sandboxPolicy,
    sandboxRuns,
    runInSandbox,
    clearSandboxRuns,
    coreStatus,
    activeDevServer,
    stopDevServer,
  } = useApp();

  const [cmd, setCmd] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Only autoscroll when already near the bottom — inspecting history must
    // not be yanked away by new output.
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) endRef.current?.scrollIntoView({ block: 'end' });
  }, [sandboxRuns]);

  const detached = coreStatus.state === 'unavailable';
  const runningDevServer = activeDevServer && ['starting', 'running'].includes(activeDevServer.status)
    ? activeDevServer
    : null;

  const submit = () => {
    const c = cmd.trim();
    if (!c || detached) return;
    setHistory((prev) => [c, ...prev.filter((x) => x !== c)].slice(0, 50));
    setHistIdx(-1);
    setCmd('');
    void runInSandbox(c);
  };

  const clear = () => {
    clearSandboxRuns();
    setConfirmClear(false);
    inputRef.current?.focus();
  };

  // PowerShell-style prompt: the sandbox working directory stands before the
  // caret and shrinks (never the typing area) when the console is narrow.
  const cwd = sandboxPolicy.workingDir;
  const prefix = cwd ? `PS ${cwd}>` : 'PS>';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--background)]">
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 py-1.5">
        {runningDevServer && (
          <div className="px-2 py-0.5">
            <div className="flex items-center">
              <span
                className="max-w-[45%] shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-[var(--muted-foreground)]"
                title={runningDevServer.cwd}
              >
                {runningDevServer.cwd ? `PS ${runningDevServer.cwd}>` : 'PS>'}
              </span>
              <code className="ml-2 min-w-0 break-all font-mono text-[12px] text-[var(--foreground)]">
                {runningDevServer.command}
              </code>
              <span className="ml-2 flex shrink-0 items-center text-[10px] text-[var(--info)]">
                <Loader2 size={10} className="mr-1 animate-spin" />
                {runningDevServer.status === 'starting' ? 'starting…' : 'running…'}
                <button
                  type="button"
                  onClick={() => void stopDevServer(runningDevServer.workspaceId)}
                  className="ml-1.5 rounded p-0.5 text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--destructive)]"
                  title="Stop the local server"
                  aria-label="Stop the local server"
                >
                  <Square size={10} fill="currentColor" />
                </button>
              </span>
            </div>
            {runningDevServer.output.length > 0 && (
              <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] leading-[1.55] text-[var(--foreground)]">
                {runningDevServer.output.join('\n')}
              </pre>
            )}
          </div>
        )}
        {sandboxRuns.map((r) => (
          <RunLine key={r.id} run={r} />
        ))}

        {/* The live prompt: the last line of the transcript itself — not a
            bar pinned under the panel. Clicking anywhere on the row focuses
            it; the clear glyph sits quietly at its far end. */}
        <div
          onClick={(e) => {
            if (e.target !== inputRef.current) inputRef.current?.focus();
          }}
          className="flex cursor-text items-center py-1 px-2"
        >
          <span
            className="max-w-[45%] flex-shrink-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-[var(--muted-foreground)]"
            title={cwd}
          >
            {prefix}
          </span>
          <input
            ref={inputRef}
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
            placeholder={detached ? 'Core not attached' : ''}
            spellCheck={false}
            aria-label="Command to run in the sandbox"
            className="ml-2 min-w-0 flex-1 bg-transparent font-mono text-[12px] text-[var(--foreground)] caret-[var(--primary)] outline-none placeholder-[var(--input)] disabled:cursor-not-allowed"
          />
          <span className="flex flex-shrink-0 items-center ml-2" onClick={(e) => e.stopPropagation()}>
            {confirmClear ? (
              <>
                <span className="mr-2 text-[10px] text-[var(--muted-foreground)]">
                  Clear all output?
                </span>
                <button
                  onClick={clear}
                  autoFocus={false}
                  className="rounded bg-[var(--destructive)] px-2 py-0.5 text-[10px] font-medium text-[var(--destructive-foreground)] transition hover:brightness-110"
                >
                  Clear
                </button>
                <button
                  onClick={() => setConfirmClear(false)}
                  className="ml-1.5 rounded px-1.5 py-0.5 text-[10px] text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                onClick={() => setConfirmClear(true)}
                title="Clear all output"
                aria-label="Clear all output"
                className="rounded p-1 text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--destructive)]"
              >
                <Trash2 size={12} />
              </button>
            )}
          </span>
        </div>
        <div ref={endRef} />
      </div>
    </div>
  );
};
