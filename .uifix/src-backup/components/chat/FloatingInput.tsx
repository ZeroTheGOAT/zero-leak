/*
 * Composer structure source-ported from Nerve for Servergen AI.
 * Nerve Copyright © 2026 ThilinaTLM, Apache-2.0. See THIRD_PARTY_NOTICES.md.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Eye,
  FileUp,
  Library,
  Loader2,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Send,
  Shield,
  Square,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { ApprovalPopover } from './ApprovalPopover';
import { formatBytes } from '../../services/registry';
import type { AgentMode } from '../../types';

const MODES: Array<{ value: AgentMode; label: string; hint: string; icon: React.ElementType }> = [
  { value: 'plan', label: 'Planning', hint: 'Read, research, and propose without changing files.', icon: Eye },
  { value: 'agent', label: 'Coding', hint: 'Edit files and execute approved local tools.', icon: Pencil },
];

interface ComposerDraft {
  text: string;
  attached: string[];
}

const EMPTY_DRAFT: ComposerDraft = { text: '', attached: [] };

export const FloatingInput: React.FC = () => {
  const {
    send,
    isRunning,
    cancelRun,
    mode,
    setMode,
    activeSessionId,
    activeWorkspace,
    pickAttachments,
    documents,
    coreStatus,
    openTab,
    openSettings,
    knowledgeStats,
    catalogueModels,
    loadedModelIds,
  } = useApp();
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const [submitting, setSubmitting] = useState(false);
  const [showPlus, setShowPlus] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const draftKey = activeSessionId ?? '__new_chat__';
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const { text, attached } = draft;

  const setText = (value: string) => {
    setDrafts((current) => ({
      ...current,
      [draftKey]: { ...(current[draftKey] ?? EMPTY_DRAFT), text: value },
    }));
  };

  const setAttached = (update: (current: string[]) => string[]) => {
    setDrafts((current) => {
      const existing = current[draftKey] ?? EMPTY_DRAFT;
      return {
        ...current,
        [draftKey]: { ...existing, attached: update(existing.attached) },
      };
    });
  };

  useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
  }, [text]);

  useEffect(() => {
    if (!showPlus && !showApproval) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setShowPlus(false);
        setShowApproval(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [showPlus, showApproval]);

  const submit = async () => {
    if (!text.trim() || isRunning || submitting) return;
    setSubmitting(true);
    try {
      const accepted = await send(text, attached);
      if (accepted) {
        setDrafts((current) => {
          const next = { ...current };
          delete next[draftKey];
          return next;
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const attach = async () => {
    setShowPlus(false);
    const added = await pickAttachments();
    if (added.length > 0) {
      setAttached((current) => [...new Set([...current, ...added])]);
    }
  };

  const disabled = coreStatus.state === 'unavailable';
  const activeMode = MODES.find((item) => item.value === mode) ?? MODES[0];
  const ActiveModeIcon = activeMode.icon;
  const loaded = loadedModelIds
    .map((id) => catalogueModels.find((model) => model.id === id)?.displayName)
    .filter(Boolean);

  return (
    <div className="bg-transparent px-2 pb-2 pt-1">
      <div ref={wrapRef} className="relative mx-auto max-w-4xl">
        {attached.length > 0 && (
          <div className="mb-2">
            <div className="flex flex-wrap gap-1.5">
              {attached.map((path) => {
                const document = documents.find((item) => item.path === path);
                return (
                  <span key={path} className="flex items-center gap-1.5 rounded-md border nerve-border bg-[var(--card)] py-1 pl-2 pr-1 text-xs text-[var(--card-foreground)]" title={path}>
                    <Paperclip size={10} className="text-[var(--muted-foreground)]" />
                    <span className="max-w-[220px] truncate">{document?.fileName ?? path.split(/[\\/]/).pop()}</span>
                    {document && <span className="text-[10px] text-[var(--muted-foreground)]">{formatBytes(document.sizeBytes)}</span>}
                    <button onClick={() => setAttached((current) => current.filter((item) => item !== path))} className="grid size-5 place-items-center rounded hover:bg-[var(--accent)]"><X size={10} /></button>
                  </span>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
              Attached to this draft · nothing is read until you send an instruction
            </p>
          </div>
        )}

        <div className={`relative mt-2 overflow-visible rounded-[calc(var(--radius)*0.8)] border bg-[var(--background)] shadow-sm transition ${
          mode === 'plan' ? 'border-[var(--success)] focus-within:shadow-[0_0_0_1px_var(--success)]' : 'border-[var(--input)] focus-within:border-[var(--primary)] focus-within:shadow-[0_0_0_1px_var(--ring)]'
        }`}>
          <div
            className={`pointer-events-none absolute inset-x-2.5 top-0 flex -translate-y-1/2 items-center gap-1 [&>*]:pointer-events-auto ${
              showApproval ? 'z-50' : 'z-20'
            }`}
          >
            <button type="button" onClick={() => setMode(mode === 'plan' ? 'agent' : 'plan')} className="composer-tab" title={`${activeMode.label}: ${activeMode.hint}`}>
              <ActiveModeIcon size={13} strokeWidth={2.2} />
              <span>{activeMode.label}</span>
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowPlus(false);
                  setShowApproval((open) => !open);
                }}
                data-state={showApproval ? 'open' : 'closed'}
                aria-expanded={showApproval}
                aria-haspopup="dialog"
                className="composer-tab w-7 p-0"
                title="Permission rule set"
              >
                <Shield size={13} strokeWidth={2.2} />
              </button>
              {showApproval && <ApprovalPopover onClose={() => setShowApproval(false)} />}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <span className="composer-tab" title="Local context sources">{knowledgeStats.documents} docs</span>
              <span className="composer-tab max-w-56 truncate" title={loaded.join(', ') || 'Loads the routed local model on demand'}>
                {loaded.length ? loaded.join(', ') : `${catalogueModels.length} local models`}
              </span>
            </div>
          </div>

          <textarea
            ref={areaRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            disabled={disabled}
            placeholder={disabled ? 'The local core is not attached' : attached.length > 0 ? 'Tell the agent what to do with the attached files' : 'Ask the local Servergen agent'}
            className="min-h-[7.25rem] w-full resize-none bg-transparent px-4 pb-12 pt-7 text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div
            className={`absolute bottom-2 left-2 flex items-center gap-1 ${
              showPlus ? 'z-50' : 'z-10'
            }`}
          >
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowApproval(false);
                  setShowPlus((open) => !open);
                }}
                disabled={disabled}
                data-state={showPlus ? 'open' : 'closed'}
                aria-expanded={showPlus}
                aria-haspopup="menu"
                className="grid size-8 place-items-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
                title="Add context"
              >
                <Plus size={16} />
              </button>
              {showPlus && (
                <div
                  role="menu"
                  aria-label="Add context"
                  className="absolute bottom-full left-0 z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] origin-bottom-left rounded-xl border nerve-border bg-[var(--popover)] py-1 text-[var(--popover-foreground)] shadow-[var(--shadow-lg)] animate-popover"
                >
                  <button type="button" role="menuitem" onClick={() => void attach()} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-[var(--accent)]"><FileUp size={13} /><span>Attach document or image<span className="block text-[10px] text-[var(--muted-foreground)]">PDF, Office, scan, photo, drawing</span></span></button>
                  <button type="button" role="menuitem" onClick={() => { setShowPlus(false); openTab('knowledge', 'Knowledge'); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-[var(--accent)]"><Library size={13} /><span>Knowledge base<span className="block text-[10px] text-[var(--muted-foreground)]">{knowledgeStats.documents} local documents</span></span></button>
                </div>
              )}
            </div>
            {!activeWorkspace && <span className="hidden text-[10px] text-[var(--muted-foreground)] sm:inline">Open a project to enable file tools</span>}
          </div>

          <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5">
            {coreStatus.state === 'unavailable' && <span className="mr-1 text-[10px] text-[var(--warning)]">core detached</span>}
            <button type="button" onClick={() => openSettings('transcription')} className="grid size-8 place-items-center rounded-full border nerve-border bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--accent)]" title="Local voice transcription"><Mic size={15} /></button>
            {isRunning ? (
              <button type="button" onClick={() => void cancelRun()} className="grid size-8 place-items-center rounded-full bg-[var(--destructive-solid)] text-[var(--destructive-solid-foreground)]" title="Stop generation"><Square size={12} fill="currentColor" /></button>
            ) : (
              <button type="button" onClick={() => void submit()} disabled={!text.trim() || disabled || submitting} className="servergen-primary grid size-8 place-items-center rounded-full shadow-sm disabled:cursor-not-allowed disabled:opacity-30" title="Send (Enter)">{submitting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} strokeWidth={2.4} />}</button>
            )}
          </div>
        </div>

        {isRunning && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--muted-foreground)]"><Loader2 size={10} className="animate-spin" />Running locally · nothing leaves this device</p>}
      </div>
    </div>
  );
};
