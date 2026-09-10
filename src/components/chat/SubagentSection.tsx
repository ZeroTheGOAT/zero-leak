import React from 'react';
import { AlertCircle, Check, ChevronRight, GitFork, Loader2, Pause, Square } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { isSubagentActive } from '../../services/subagents';
import type { SubagentInfo } from '../../types';

export const SubagentStatusIcon: React.FC<{ agent: SubagentInfo }> = ({ agent }) => {
  if (agent.status === 'waiting') return <Pause size={14} className="shrink-0 text-[var(--warning)]" />;
  if (isSubagentActive(agent)) return <Loader2 size={14} className="shrink-0 animate-spin" />;
  if (agent.status === 'completed') return <Check size={14} className="shrink-0 text-[var(--success)]" />;
  if (agent.status === 'interrupted') return <Square size={12} className="shrink-0 text-[var(--muted-foreground)]" />;
  return <AlertCircle size={14} className="shrink-0 text-[var(--destructive)]" />;
};

export const SubagentList: React.FC<{ limit?: number; onNavigate?: () => void }> = ({ limit, onNavigate }) => {
  const { subagents, subagentChats, viewSubagents } = useApp();
  return <div className="space-y-1">
    {subagents.slice(0, limit).map((agent) => {
      const live = subagentChats[agent.id]?.live;
      const current = isSubagentActive(agent)
        ? live?.phase?.label || live?.steps.findLast((step) => step.status === 'running')?.title
        : agent.error || agent.result;
      return <button key={agent.id} type="button" onClick={() => { onNavigate?.(); viewSubagents(agent.id); }}
        aria-label={`View sub-agent ${agent.taskName}`}
        className="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left transition hover:bg-[var(--accent)]"
        title={agent.path}>
        <span className="mt-1"><SubagentStatusIcon agent={agent} /></span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-[var(--foreground)]">{agent.taskName}</span>
          <span className="mt-0.5 block text-[11px] capitalize text-[var(--muted-foreground)]">{agent.status} · {agent.role}</span>
          <span className="mt-1 block truncate text-[11px] text-[var(--muted-foreground)]">{current || agent.path}</span>
        </span>
        <ChevronRight size={13} className="mt-1 shrink-0 text-[var(--muted-foreground)]" />
      </button>;
    })}
  </div>;
};

export const SubagentSection: React.FC<{ onNavigate?: () => void }> = ({ onNavigate }) => {
  const { subagents, viewSubagents } = useApp();
  if (subagents.length === 0) return null;
  const active = subagents.filter(isSubagentActive).length;
  return <section aria-label="Sub-agents" className="mt-4 border-t border-[var(--border)] pt-4">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-[13px] font-medium text-[var(--muted-foreground)]"><GitFork size={14} />Sub-agents</h2>
      <span className="text-[11px] text-[var(--muted-foreground)]">{active > 0 ? `${active} working · ` : ''}{subagents.length} total</span>
    </div>
    <SubagentList limit={3} onNavigate={onNavigate} />
    <button type="button" aria-label="View all sub-agents" onClick={() => { onNavigate?.(); viewSubagents(); }}
      className="mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]">
      <GitFork size={14} />View all<ChevronRight size={13} className="ml-auto" />
    </button>
  </section>;
};
