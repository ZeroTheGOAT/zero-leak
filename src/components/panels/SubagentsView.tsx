import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, GitFork, Loader2, RefreshCw, Square } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { rehydrate } from '../../services/chatHistory';
import * as core from '../../services/core';
import { isSubagentActive, mergeSubagentMessages } from '../../services/subagents';
import type { ChatMessage, SubagentInfo } from '../../types';
import { ActivityFlow, Message } from '../chat/ChatContainer';
import { SubagentList, SubagentStatusIcon } from '../chat/SubagentSection';
import { PlanChecklist } from '../chat/PlanChecklist';

const SubagentChat: React.FC<{ agent: SubagentInfo }> = ({ agent }) => {
  const { subagentChats, interruptSubagent, coreStatus } = useApp();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [stopping, setStopping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const snapshot = subagentChats[agent.id];
  const active = isSubagentActive(agent);
  const messages = useMemo(() => mergeSubagentMessages(history, snapshot?.messages ?? []), [history, snapshot?.messages]);
  const live = snapshot?.live;

  useEffect(() => {
    let cancelled = false;
    let fetching = false;
    const refresh = async () => {
      if (fetching) return;
      fetching = true;
      try {
        const rows = await core.agent.subagents.history(agent.rootSessionId, agent.id);
        if (!cancelled) { setHistory(rows.map(rehydrate)); setError(null); }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load this sub-agent’s chat.');
      } finally {
        fetching = false;
        if (!cancelled) setLoading(false);
      }
    };
    void refresh();
    // Prompts and follow-ups are authoritative stored rows. Text and actions
    // arrive through the app's event stream even when this panel is closed.
    const timer = active ? window.setInterval(() => void refresh(), 2000) : undefined;
    const resync = () => void refresh();
    window.addEventListener('sovereign:resync', resync);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener('sovereign:resync', resync); };
  }, [agent.rootSessionId, agent.id, agent.updatedAt, active, retry, coreStatus.state]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [messages, live?.activity, live?.phase, loading]);

  const current = active ? live?.phase?.label || live?.steps.findLast((step) => step.status === 'running')?.title : undefined;
  return <>
    <div className="flex items-start gap-3 border-b border-[var(--border)] px-4 py-4">
      <span className="mt-1"><SubagentStatusIcon agent={agent} /></span>
      <div className="min-w-0 flex-1">
        <h2 className="break-words text-sm font-medium">{agent.taskName}</h2>
        <p className="mt-1 text-xs capitalize text-[var(--muted-foreground)]">{agent.status} · {agent.role}</p>
        <p className="mt-1 break-all text-[11px] text-[var(--muted-foreground)]">{agent.path}</p>
        {current && <p role="status" className="mt-2 text-xs text-[var(--foreground)]">{current}</p>}
      </div>
      {active && <button type="button" disabled={stopping || agent.status === 'stopping'} aria-label={`Stop sub-agent ${agent.taskName}`}
        onClick={async () => { setStopping(true); try { await interruptSubagent(agent.id); } finally { setStopping(false); } }}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs hover:bg-[var(--accent)] disabled:opacity-50"><Square size={11} />{stopping || agent.status === 'stopping' ? 'Stopping…' : 'Stop'}</button>}
    </div>
    <div ref={scrollRef} onScroll={() => { const node = scrollRef.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80; }}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-5" aria-label={`${agent.taskName} chat`}>
      {error && <div role="alert" className="mb-4 rounded-lg border border-[var(--destructive-ring)] bg-[var(--destructive-soft)] p-3 text-xs">
        <p>{error}</p><button type="button" onClick={() => setRetry((value) => value + 1)} className="mt-2 flex items-center gap-1.5 underline"><RefreshCw size={12} />Retry loading chat</button>
      </div>}
      {loading && <p role="status" className="mb-4 flex items-center gap-2 text-xs text-[var(--muted-foreground)]"><Loader2 size={13} className="animate-spin" />Loading chat…</p>}
      <div className="space-y-6">
        {messages.map((message) => {
          const delegated = message.sender === 'user' && message.content.startsWith('[Delegated agent: ');
          const task = delegated ? message.content.split('\n\nTask:\n')[1]?.split('\n\nParent conversation context')[0] : undefined;
          return <div key={message.id} className="min-w-0 break-words">
            <Message msg={{ ...message, content: task ?? message.content, fileChanges: undefined }} />
            {delegated && task && <details className="mt-2 text-[11px] text-[var(--muted-foreground)]"><summary className="cursor-pointer">Delegation context</summary><p className="mt-2 whitespace-pre-wrap break-words">{message.content}</p></details>}
          </div>;
        })}
        {active && live && <div className="min-w-0 break-words">
          <ActivityFlow blocks={live.activity} live thinkingLive={live.phase?.phase === 'reasoning'} />
          {live.plan.length > 0 && <PlanChecklist items={live.plan} isRunning />}
        </div>}
        {!loading && !error && messages.length === 0 && !(active && live?.activity.length) && <p className="text-xs text-[var(--muted-foreground)]">
          {active ? 'Waiting for this sub-agent’s first update…' : agent.result || 'No messages were recorded for this sub-agent.'}
        </p>}
        {agent.error && <p role="alert" className="rounded-lg bg-[var(--destructive-soft)] p-3 text-xs text-[var(--destructive)]">{agent.error}</p>}
      </div>
    </div>
  </>;
};

export const SubagentsView: React.FC = () => {
  const { activeSessionId, subagents, selectedSubagentId, viewSubagents } = useApp();
  const selected = subagents.find((agent) => agent.id === selectedSubagentId);
  return <div className="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
    {selected ? <>
      <div className="border-b border-[var(--border)] px-3 py-2"><button type="button" onClick={() => viewSubagents()}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-[var(--muted-foreground)] hover:bg-[var(--accent)]"><ArrowLeft size={14} />View all sub-agents ({subagents.length})</button></div>
      <SubagentChat key={`${activeSessionId}:${selected.id}`} agent={selected} />
    </> : <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-3 flex items-center gap-2"><GitFork size={16} /><h2 className="text-sm font-medium">Sub-agents</h2><span className="ml-auto text-xs text-[var(--muted-foreground)]">{subagents.length} total</span></div>
      {subagents.length > 0 ? <SubagentList /> : <p className="py-8 text-center text-xs text-[var(--muted-foreground)]">Sub-agents will appear here when this chat delegates work.</p>}
    </div>}
  </div>;
};
