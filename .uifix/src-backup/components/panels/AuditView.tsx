import React, { useMemo, useState } from 'react';
import { AlertTriangle, Ban, Check, RefreshCw, ScrollText } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatDuration, toolByName } from '../../services/registry';
import type { ToolCallRecord, ToolRisk } from '../../types';

const RISK_TONE: Record<ToolRisk, string> = {
  read: 'text-[#71717a]',
  write: 'text-amber-500',
  execute: 'text-orange-400',
  destructive: 'text-red-400',
};

const STATUS_ICON: Record<ToolCallRecord['status'], React.ElementType> = {
  ok: Check,
  denied: Ban,
  failed: AlertTriangle,
};

const STATUS_TONE: Record<ToolCallRecord['status'], string> = {
  ok: 'text-emerald-600',
  denied: 'text-[#71717a]',
  failed: 'text-red-400',
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
      <div className="px-3 py-2 border-b border-[#1a1b21] flex-shrink-0">
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
                    ? 'bg-[#252834] text-white'
                    : 'text-[#8e8e93] hover:bg-[#1a1b21] hover:text-[#d4d4d8]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            onClick={() => void refreshAudit()}
            className="p-1.5 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition"
            title="Refresh"
          >
            <RefreshCw size={11} />
          </button>
        </div>

        <p className="text-[10px] text-[#5f6169] mt-2 tabular-nums leading-relaxed">
          {sovereign.deviceRequests} requests served on this device ·{' '}
          {sovereign.privateServerRequests} on the approved server · 0 to any public service
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <div className="p-4 text-center">
            <ScrollText size={20} className="text-[#3a3d47] mx-auto mb-2" />
            <p className="text-[12px] text-[#71717a]">
              {auditLog.length === 0 ? 'No tool calls yet.' : 'Nothing matches this filter.'}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#16171c] font-mono">
            {rows.map((r) => {
              const tool = toolByName(r.tool);
              const Icon = STATUS_ICON[r.status];
              const ws = workspaces.find((w) => w.id === r.workspaceId);
              return (
                <div key={r.id} className="px-3 py-1.5 hover:bg-[#131418] transition">
                  <div className="flex items-start space-x-2">
                    <span className="text-[10px] text-[#4a4c53] tabular-nums flex-shrink-0 mt-[2px]">
                      {time(r.startedAt)}
                    </span>
                    <Icon size={10} className={`flex-shrink-0 mt-[3px] ${STATUS_TONE[r.status]}`} />
                    <span className="min-w-0 flex-1">
                      <span
                        className={`text-[11px] ${tool ? RISK_TONE[tool.risk] : 'text-[#71717a]'}`}
                      >
                        {r.tool}
                      </span>
                      <span className="text-[11px] text-[#8e8e93] ml-1.5 break-all">
                        {r.argsSummary}
                      </span>
                    </span>
                    <span className="text-[10px] text-[#4a4c53] tabular-nums flex-shrink-0">
                      {formatDuration(r.durationMs)}
                    </span>
                  </div>
                  {r.error && (
                    <p className="text-[10.5px] text-red-400 mt-0.5 ml-[52px] leading-relaxed break-all">
                      {r.error}
                    </p>
                  )}
                  {ws && (
                    <p className="text-[10px] text-[#3f4147] mt-0.5 ml-[52px] truncate">
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
