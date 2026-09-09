import React from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Globe,
  Loader2,
  RotateCcw,
  Square,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';

/**
 * The active project's dev server, as a slim bar above the composer.
 *
 * Every field is the core's own state (`devserver://status`): the URL is only
 * set after the core verified the port answers an HTTP request, so what this
 * bar links to is reachable or the bar says otherwise. A server that dies on
 * its own flips to an error state here without waiting for a run to notice,
 * because servers outlive the runs that started them.
 */
export const DevServerBar: React.FC = () => {
  const { activeDevServer, activeWorkspaceId, startDevServer, stopDevServer, openDevServerUrl } =
    useApp();

  if (!activeWorkspaceId || !activeDevServer || activeDevServer.status === 'stopped') return null;
  const s = activeDevServer;

  const statusIcon =
    s.status === 'running' ? (
      <span className="relative flex h-2 w-2">
        <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--success)]" />
      </span>
    ) : s.status === 'starting' ? (
      <Loader2 size={12} className="animate-spin text-[var(--info)]" />
    ) : s.status === 'failed' ? (
      <AlertTriangle size={12} className="text-[var(--destructive)]" />
    ) : (
      <span className="h-2 w-2 rounded-full bg-[var(--muted-foreground)]" />
    );

  const statusText =
    s.status === 'running'
      ? 'live'
      : s.status === 'starting'
        ? 'starting…'
        : s.status === 'failed'
          ? 'stopped on error'
          : 'stopped';

  return (
    <details className="composer-activity" key={s.status}>
        <summary className="composer-activity-summary">
          {statusIcon}
          <Globe size={12} className="flex-shrink-0" />
          <span className="flex-shrink-0">Local server</span>
          {s.status === 'running' && s.url ? (
            <span className="min-w-0 flex-1 truncate" title={s.url}>
              {s.url}
            </span>
          ) : s.status === 'failed' && s.error ? (
            <span
              className="min-w-0 flex-1 truncate text-[var(--destructive)]"
              title={s.error}
            >
              {s.error}
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate">{s.command}</span>
          )}
          <span className="flex-shrink-0 tabular-nums">· {statusText}</span>
          <ChevronDown size={12} className="activity-chevron shrink-0" />
        </summary>
        <div className="px-3 pb-2">
          <p className="mb-2 max-h-24 overflow-y-auto break-words text-xs">{s.error || s.command}</p>
        <div className="flex flex-wrap items-center gap-1">
          {s.status === 'running' && s.url && (
            <button
              onClick={() => void openDevServerUrl(s.url!)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition"
              title="Open in the browser"
            >
              <ExternalLink size={12} />
              Open
            </button>
          )}
          <button
            onClick={() => void startDevServer(s.workspaceId, s.command)}
            disabled={s.status === 'starting'}
            className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition disabled:cursor-wait disabled:opacity-60"
            title={
              s.status === 'running' || s.status === 'starting'
                ? 'Stop the current server and start a fresh one'
                : `Run ${s.command}`
            }
          >
            <RotateCcw size={12} />
            {s.status === 'running' || s.status === 'starting' ? 'Restart' : 'Start'}
          </button>
          {(s.status === 'running' || s.status === 'starting') && (
            <button
              onClick={() => void stopDevServer(s.workspaceId)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition"
              title="Stop the dev server"
            >
              <Square size={12} />
              Stop
            </button>
          )}
        </div>
        </div>
    </details>
  );
};
