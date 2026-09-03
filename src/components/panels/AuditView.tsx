import React, { useMemo, useState } from 'react';
import { AlertTriangle, Ban, Check, RefreshCw, ScrollText } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatBytes, formatDuration, toolByName } from '../../services/registry';
import type { ToolRisk } from '../../types';

const RISK_TONE: Record<ToolRisk, string> = {
  read: 'text-[var(--muted-foreground)]',
  write: 'text-[var(--warning)]',
  execute: 'text-[var(--primary)]',
  destructive: 'text-[var(--destructive)]',
};

/**
 * Older sandbox audit rows used process states (`exited`, `killed`, and so on)
 * instead of the audit contract's three statuses. Never turn an unfamiliar
 * persisted value into an undefined React component: old logs must remain
 * inspectable after an upgrade.
 */
const statusPresentation = (status: string, error?: string) => {
  if (status === 'ok' || (status === 'exited' && !error)) {
    return { Icon: Check, tone: 'text-[var(--success)]' };
  }
  if (status === 'denied') {
    return { Icon: Ban, tone: 'text-[var(--muted-foreground)]' };
  }
  return { Icon: AlertTriangle, tone: 'text-[var(--destructive)]' };
};

const time = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour12: false });

/**
 * §12 — every tool call, in order, with what it touched and what happened.
 *
 * This is the record that makes the sovereignty claim checkable: if a byte
 * left this machine, the call that sent it is in this list.
 */
export const AuditView: React.FC = () => {
  const { auditLog, refreshAudit, workspaces, sovereign } = useApp();
  const [filter, setFilter] = useState<'all' | 'write' | 'denied'>('all');

  const rows = useMemo(() => {
    if (filter === 'all') return auditLog;
    if (filter === 'denied') return auditLog.filter((r) => r.status !== 'ok');
    return auditLog.filter((r) => {
      const risk = toolByName(r.tool)?.risk;
      return risk === 'write' || risk === 'execute' || risk === 'destructive';
    });
  }, [auditLog, filter]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-[var(--muted)] flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-1">
            {(
              [
                ['all', 'All'],
                ['write', 'Changes'],
                ['denied', 'Refused'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-2 py-1 rounded text-[11px] transition ${
                  filter === key
                    ? 'bg-[var(--popover)] text-[var(--foreground)]'
                    : 'text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void refreshAudit()}
            className="p-1.5 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
            title="Refresh"
          >
            <RefreshCw size={11} />
          </button>
        </div>

        <p className="text-[10px] text-[var(--muted-foreground)] mt-2 tabular-nums leading-relaxed">
          {sovereign.deviceRequests} requests served on this device ·{' '}
          {sovereign.privateServerRequests} on the approved server ·{' '}
          {sovereign.publicInternetBytes > 0
            ? `${formatBytes(sovereign.publicInternetBytes)} received by enabled web search`
            : '0 to any public service'}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-4 text-center">
            <ScrollText size={20} className="text-[var(--border)] mx-auto mb-2" />
            <p className="text-[12px] text-[var(--muted-foreground)]">
              {auditLog.length === 0 ? 'No tool calls yet.' : 'Nothing matches this filter.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--accent)] font-mono">
            {rows.map((r) => {
              const tool = toolByName(r.tool);
              const { Icon, tone } = statusPresentation(r.status, r.error);
              const ws = workspaces.find((w) => w.id === r.workspaceId);
              return (
                <div key={r.id} className="px-3 py-1.5 hover:bg-[var(--sidebar)] transition">
                  <div className="flex items-start space-x-2">
                    <span className="text-[10px] text-[var(--input)] tabular-nums flex-shrink-0 mt-[2px]">
                      {time(r.startedAt)}
                    </span>
                    <Icon size={10} className={`flex-shrink-0 mt-[3px] ${tone}`} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`text-[11px] ${tool ? RISK_TONE[tool.risk] : 'text-[var(--muted-foreground)]'}`}
                      >
                        {r.tool}
                      </span>
                      <span className="text-[11px] text-[var(--muted-foreground)] ml-1.5 break-all">
                        {r.argsSummary}
                      </span>
                    </span>
                    <span className="text-[10px] text-[var(--input)] tabular-nums flex-shrink-0">
                      {formatDuration(r.durationMs)}
                    </span>
                  </div>
                  {r.error && (
                    <p className="text-[10.5px] text-[var(--destructive)] mt-0.5 ml-[52px] leading-relaxed break-all">
                      {r.error}
                    </p>
                  )}
                  {ws && (
                    <p className="text-[10px] text-[var(--input)] mt-0.5 ml-[52px] truncate">
                      {ws.path}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
