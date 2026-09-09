import React from 'react';
import { AlertCircle, Check, ChevronDown, GitFork, ListChecks, Loader2, MinusCircle, Square } from 'lucide-react';
import { useApp } from '../../context/AppContext';

/** Only unfinished work belongs beside the composer. Plans remain stored in the transcript. */
export const TaskDock: React.FC = () => {
  const { livePlan, isRunning, activeSessionId, subagents, interruptSubagent } = useApp();
  const done = livePlan.filter((item) => item.status === 'completed').length;
  const activeAgents = subagents.filter((agent) => ['pending', 'running', 'waiting'].includes(agent.status));
  if (!activeSessionId || ((!isRunning || livePlan.length === 0 || done === livePlan.length) && subagents.length === 0)) return null;
  const current = livePlan.find((item) => item.status === 'in_progress')
    ?? livePlan.find((item) => item.status !== 'completed');

  return (
    <details key={activeSessionId} className="composer-activity">
      <summary className="composer-activity-summary">
        {activeAgents.length > 0 ? <GitFork size={14} className="shrink-0" /> : <ListChecks size={14} className="shrink-0" />}
        <span className="shrink-0">{activeAgents.length > 0 ? 'Agents' : 'Tasks'}</span>
        <span className="tabular-nums shrink-0">{activeAgents.length > 0 ? `${activeAgents.length} active` : `${done}/${livePlan.length}`}</span>
        <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{activeAgents[0]?.taskName ?? current?.step}</span>
        {(isRunning || activeAgents.length > 0) && <Loader2 size={12} className="shrink-0 animate-spin" />}
        <ChevronDown size={12} className="activity-chevron shrink-0" />
      </summary>
      <div className="max-h-52 overflow-y-auto px-3 pb-2 space-y-2">
        {livePlan.length > 0 && <ol className="space-y-1">{livePlan.map((item, index) => (
          <li key={item.id || `item-${index}`} className="flex items-start gap-2 py-1 text-xs">
            <span className="mt-0.5 shrink-0">
              {item.status === 'completed' ? <Check size={12} className="text-[var(--success)]" />
                : item.status === 'in_progress' ? <Loader2 size={12} className="animate-spin" />
                  : <MinusCircle size={12} />}
            </span>
            <span className={item.status === 'in_progress' ? 'text-[var(--foreground)] break-words min-w-0' : 'break-words min-w-0'}>{item.step}</span>
          </li>
        ))}</ol>}
        {subagents.length > 0 && <div className="border-t border-[var(--border)] pt-2 space-y-1">
          {subagents.map((agent) => {
            const active = ['pending', 'running', 'waiting'].includes(agent.status);
            return <div key={agent.id} className="flex items-center gap-2 py-1 text-xs">
              {active ? <Loader2 size={12} className="animate-spin shrink-0" />
                : agent.status === 'completed' ? <Check size={12} className="text-[var(--success)] shrink-0" />
                  : <AlertCircle size={12} className="text-[var(--destructive)] shrink-0" />}
              <span className="min-w-0 flex-1 truncate" title={`${agent.path} · ${agent.role}`}>{agent.taskName} <span className="text-[var(--muted-foreground)]">· {agent.role}</span></span>
              <span className="text-[10px] text-[var(--muted-foreground)]">{agent.status}</span>
              {active && <button type="button" title={`Stop ${agent.taskName}`} onClick={() => void interruptSubagent(agent.id)} className="grid size-6 place-items-center rounded hover:bg-[var(--accent)]"><Square size={10} /></button>}
            </div>;
          })}
        </div>}
      </div>
    </details>
  );
};
