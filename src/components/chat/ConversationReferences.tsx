import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileImage,
  FileOutput,
  FileText,
  Plus,
  Share2,
  SlidersHorizontal,
  Square,
  Terminal,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { Artifact } from '../../types';
import { collectConversationSources } from './conversationSources';

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
};

/**
 * A conversation-level index of generated outputs and document-backed sources.
 *
 * Sources come from citations attached to agent answers and from sent user
 * attachments. Composer drafts are not messages, so unsent files never appear.
 */
export const ConversationReferences: React.FC<{
  buttonClassName?: string;
  sidePanelOpen?: boolean;
  onAddSources?: () => Promise<void>;
}> = ({
  buttonClassName = 'right-3',
  sidePanelOpen = false,
  onAddSources,
}) => {
  const {
    activeSessionId,
    messages,
    artifacts,
    openArtifact,
    openDocumentAt,
    openTab,
    activeDevServer,
    sandboxRuns,
    killRun,
    stopDevServer,
  } = useApp();
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const open = activeSessionId !== null && openSessionId === activeSessionId;

  const sources = useMemo(() => collectConversationSources(messages), [messages]);

  const outputs = useMemo<Artifact[]>(() => {
    const byId = new Map<string, Artifact>();

    // Message-owned artifacts are authoritative for the current conversation,
    // including older records created before artifact rows carried sessionId.
    for (const message of messages) {
      for (const artifact of message.artifacts ?? []) byId.set(artifact.id, artifact);
    }
    // Rehydrated artifact rows restore outputs after reopening the app. Never
    // include an unscoped row here: that could leak another project's output.
    if (activeSessionId) {
      for (const artifact of artifacts) {
        if (artifact.sessionId === activeSessionId) byId.set(artifact.id, artifact);
      }
    }

    return [...byId.values()].sort((left, right) => right.createdAt - left.createdAt);
  }, [activeSessionId, artifacts, messages]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenSessionId(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // A floating references window behaves like a popover: interacting with
  // the chat or the docked side panel dismisses it. In its standalone rail
  // mode it remains open until its own toggle is used, matching the original
  // right-hand layout.
  useEffect(() => {
    if (!open || !sidePanelOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpenSessionId(null);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, sidePanelOpen]);

  if (sources.length === 0 && outputs.length === 0) return null;

  const summary = [
    outputs.length > 0 ? `${outputs.length} output${outputs.length === 1 ? '' : 's'}` : '',
    sources.length > 0 ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' and ');
  const runningSandboxRuns = sandboxRuns.filter((run) => run.status === 'running');
  const runningDevServer = activeDevServer && ['starting', 'running'].includes(activeDevServer.status)
    ? activeDevServer
    : null;
  const processCount = runningSandboxRuns.length + (runningDevServer ? 1 : 0);
  const visibleSources = sources.slice(0, 3);

  const openTerminal = () => {
    setOpenSessionId(null);
    openTab('terminal', 'Sandbox');
  };

  const stopAllProcesses = async () => {
    const stops = runningSandboxRuns.map((run) => killRun(run.id));
    if (runningDevServer) stops.push(stopDevServer(runningDevServer.workspaceId));
    await Promise.all(stops);
  };

  return (
    <div
      className={sidePanelOpen
        ? 'pointer-events-none absolute inset-0 z-40'
        : `relative h-full shrink-0 transition-[width] duration-200 ${
            open ? 'w-[min(22rem,38vw)]' : 'w-0'
          }`}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpenSessionId((value) => value === activeSessionId ? null : activeSessionId)}
        aria-label={`Toggle conversation outputs and sources: ${summary}`}
        aria-expanded={open}
        aria-controls="conversation-references-panel"
        className={`pointer-events-auto absolute top-2 z-40 grid size-8 place-items-center rounded-[10px] transition-colors ${buttonClassName} ${
          open
            ? 'bg-[var(--accent)] text-[var(--foreground)]'
            : 'bg-[var(--card)] text-[var(--foreground)] shadow-sm hover:bg-[var(--accent)]'
        }`}
        title={`Outputs and sources — ${summary}`}
      >
        <SlidersHorizontal size={16} />
      </button>

      {open && (
        <aside
          ref={panelRef}
          id="conversation-references-panel"
          role="complementary"
          aria-label="Conversation outputs and sources"
          className={`pointer-events-auto absolute top-16 max-h-[calc(100%-5rem)] overflow-y-auto rounded-[20px] border border-[var(--border)] bg-[var(--card)] ${
            processCount > 0 ? 'min-h-[20rem]' : 'min-h-[15.25rem]'
          } ${
            sidePanelOpen
              ? 'right-3 w-[min(22rem,calc(100%-1.5rem))] shadow-xl'
              : 'inset-x-3 shadow-sm'
          }`}
        >
          <div className="px-4 py-4">
            <section aria-labelledby="conversation-outputs-heading">
              <div className="mb-2 flex items-center justify-between">
                <h2
                  id="conversation-outputs-heading"
                  className="text-[13px] font-medium text-[var(--muted-foreground)]"
                >
                  Outputs
                </h2>
                <button
                  type="button"
                  onClick={() => {
                    setOpenSessionId(null);
                    openTab('artifacts', 'Artifacts');
                  }}
                  aria-label="Open outputs"
                  title="Open outputs"
                  className="grid size-7 place-items-center rounded-lg text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                >
                  <Plus size={17} />
                </button>
              </div>
              {outputs.length > 0 ? (
                <div className="space-y-1">
                  {outputs.map((artifact) => (
                    <button
                      key={artifact.id}
                      type="button"
                      onClick={() => {
                        setOpenSessionId(null);
                        void openArtifact(artifact.id);
                      }}
                      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-[var(--accent)]"
                      title={artifact.path}
                    >
                      <FileOutput size={16} className="shrink-0 text-[var(--muted-foreground)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-[var(--foreground)]">
                          {artifact.fileName}
                        </span>
                        <span className="block text-[11px] text-[var(--muted-foreground)]">
                          {artifact.kind.toUpperCase()} · {formatBytes(artifact.sizeBytes)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <p className="px-0.5 text-[12px] text-[var(--muted-foreground)]">
                  Create a file or site
                </p>
              )}
            </section>

            {processCount > 0 && (
              <section
                aria-labelledby="conversation-processes-heading"
                className="mt-4 border-t border-[var(--border)] pt-4"
              >
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <h2
                    id="conversation-processes-heading"
                    className="text-[13px] font-medium text-[var(--muted-foreground)]"
                  >
                    Background processes
                  </h2>
                  <button
                    type="button"
                    onClick={() => void stopAllProcesses()}
                    aria-label="Stop all background terminals"
                    title="Stop all background terminals"
                    className="grid size-7 shrink-0 place-items-center rounded-lg text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                </div>
                <div className="space-y-0.5">
                  {runningDevServer && (
                    <div className="group flex w-full items-center rounded-lg transition hover:bg-[var(--accent)]">
                      <button
                        type="button"
                        onClick={openTerminal}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1.5 text-left"
                        title={runningDevServer.command}
                      >
                        <Terminal size={15} className="shrink-0 text-[var(--muted-foreground)]" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--foreground)]">
                          {runningDevServer.command}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void stopDevServer(runningDevServer.workspaceId);
                        }}
                        aria-label={`Stop ${runningDevServer.command}`}
                        title="Stop background terminal"
                        className="grid size-7 shrink-0 place-items-center rounded-lg text-[var(--muted-foreground)] opacity-0 transition hover:bg-[var(--border)] hover:text-[var(--foreground)] group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <Square size={11} fill="currentColor" />
                      </button>
                    </div>
                  )}
                  {runningSandboxRuns.map((run) => (
                    <div key={run.id} className="group flex w-full items-center rounded-lg transition hover:bg-[var(--accent)]">
                      <button
                        type="button"
                        onClick={openTerminal}
                        className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5 py-1.5 text-left"
                        title={run.command}
                      >
                        <Terminal size={15} className="shrink-0 text-[var(--muted-foreground)]" />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--foreground)]">
                          {run.command}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          void killRun(run.id);
                        }}
                        aria-label={`Stop ${run.command}`}
                        title="Stop background terminal"
                        className="grid size-7 shrink-0 place-items-center rounded-lg text-[var(--muted-foreground)] opacity-0 transition hover:bg-[var(--border)] hover:text-[var(--foreground)] group-hover:opacity-100 group-focus-within:opacity-100"
                      >
                        <Square size={11} fill="currentColor" />
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}

            <section
              aria-labelledby="conversation-sources-heading"
              className="mt-4 border-t border-[var(--border)] pt-4"
            >
              <div className="mb-2 flex items-center justify-between">
                <h2
                  id="conversation-sources-heading"
                  className="text-[13px] font-medium text-[var(--muted-foreground)]"
                >
                  Sources
                </h2>
                <button
                  type="button"
                  onClick={() => void onAddSources?.()}
                  aria-label="Add sources to the message"
                  title="Add sources"
                  className="grid size-7 place-items-center rounded-lg text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                >
                  <Plus size={17} />
                </button>
              </div>
              {sources.length > 0 && (
                <div className="space-y-1">
                  {visibleSources.map((source) => {
                    const pages = source.pages.slice(0, 4);
                    const pageLabel = pages.length > 0
                      ? ` · ${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')}${source.pages.length > pages.length ? '…' : ''}`
                      : '';
                    return (
                      <button
                        key={source.key}
                        type="button"
                        onClick={() => {
                          setOpenSessionId(null);
                          if (source.attachmentKind === 'image') {
                            void openTab('file', source.fileName, undefined, source.path, true);
                          } else if (source.citation) {
                            void openDocumentAt(source.path, source.citation);
                          } else {
                            void openTab('file', source.fileName, undefined, source.path, true);
                          }
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-[var(--accent)]"
                        title={source.path}
                      >
                        {source.attachmentKind === 'image' ? (
                          <FileImage size={16} className="shrink-0 text-[var(--muted-foreground)]" />
                        ) : (
                          <FileText size={16} className="shrink-0 text-[var(--muted-foreground)]" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-[var(--foreground)]">
                            {source.fileName}
                          </span>
                          <span className="block truncate text-[11px] text-[var(--muted-foreground)]">
                            {source.references > 0
                              ? `${source.references} ${source.references === 1 ? 'reference' : 'references'}${pageLabel}`
                              : source.attachmentKind === 'image'
                                ? 'Image used in answer'
                                : 'File used in answer'}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
              {sources.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setOpenSessionId(null);
                    openTab('sources', 'Sources');
                  }}
                  className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-[12.5px] text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
                >
                  <Share2 size={15} className="shrink-0" />
                  View all
                </button>
              )}
            </section>
          </div>
        </aside>
      )}
    </div>
  );
};
