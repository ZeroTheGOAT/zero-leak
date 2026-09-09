import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Brain,
  CornerDownLeft,
  FileOutput,
  FileText,
  FolderOpen,
  Library,
  MessageSquare,
  ScrollText,
  Search,
  Server,
  Terminal,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { PanelTabKind } from '../../types';

type Result = {
  id: string;
  icon: React.ElementType;
  label: string;
  detail?: string;
  group: string;
  run: () => void;
};

/**
 * Ctrl+K — navigation over what this app actually holds.
 *
 * It searches local state only: approved workspaces, tasks, ingested documents,
 * generated artifacts, the model registry and the panels. Questions about
 * document *content* are not answered here — they go to the agent, which
 * retrieves from the local index and answers with citations. A modal that
 * returned bare chunks would strip that traceability.
 */
export const SearchModal: React.FC = () => {
  const {
    isSearchOpen,
    setIsSearchOpen,
    setView,
    workspaces,
    catalogueModels,
    setActiveWorkspaceId,
    sessions,
    openSession,
    documents,
    openDocument,
    artifacts,
    openArtifact,
    openTab,
    send,
    newSession,
    activeWorkspace,
  } = useApp();

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeResultRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isSearchOpen) {
      const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQuery('');
      setCursor(0);
      // Focus after paint so the modal is mounted.
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => {
        cancelAnimationFrame(frame);
        if (previousFocus?.isConnected) previousFocus.focus();
      };
    }
  }, [isSearchOpen]);

  const close = useCallback(() => setIsSearchOpen(false), [setIsSearchOpen]);

  const results = useMemo<Result[]>(() => {
    const q = query.trim().toLowerCase();
    const hit = (...fields: Array<string | undefined>) =>
      !q || fields.some((f) => f?.toLowerCase().includes(q));

    const out: Result[] = [];

    workspaces.filter((w) => hit(w.name, w.path)).forEach((w) =>
      out.push({
        id: `ws-${w.id}`,
        icon: FolderOpen,
        label: w.name,
        detail: w.approved ? w.path : `${w.path} · not approved`,
        group: 'Workspaces',
        run: () => {
          setActiveWorkspaceId(w.id);
          newSession('project', w.id);
          setView('workbench');
          close();
        },
      }),
    );

    sessions.filter((s) => hit(s.title)).forEach((s) =>
      out.push({
        id: `sess-${s.id}`,
        icon: MessageSquare,
        label: s.title,
        detail: workspaces.find((w) => w.id === s.workspaceId)?.name,
        group: 'Tasks',
        run: () => {
          openSession(s.id);
          close();
        },
      }),
    );

    documents.filter((d) => hit(d.fileName, d.path, ...d.entities)).forEach((d) =>
      out.push({
        id: `doc-${d.id}`,
        icon: FileText,
        label: d.fileName,
        detail: `${d.pageCount} ${d.pageCount === 1 ? 'page' : 'pages'} · ${
          d.extraction === 'native' ? 'native text' : d.extraction
        }`,
        group: 'Documents',
        run: () => {
          void openDocument(d.id);
          close();
        },
      }),
    );

    artifacts.filter((a) => hit(a.fileName, a.sourceTask)).forEach((a) =>
      out.push({
        id: `art-${a.id}`,
        icon: FileOutput,
        label: a.fileName,
        detail: a.verified ? 'verified openable' : 'not yet verified',
        group: 'Artifacts',
        run: () => {
          void openArtifact(a.id);
          close();
        },
      }),
    );

    catalogueModels.filter((m) => hit(m.displayName, m.architecture, ...m.capabilities)).forEach(
      (m) =>
        out.push({
          id: `model-${m.id}`,
          icon: Server,
          label: m.displayName,
          detail: `${m.architecture} · ${m.quantization} · ${m.estimatedVramMb.toLocaleString()} MiB`,
          group: 'Models',
          run: () => {
            openTab('models', 'Models');
            close();
          },
        }),
    );

    // `tab` is carried rather than derived from `label`, so a panel opened from
    // here is titled exactly as the sidebar, the menu bar and Ctrl+1..7 title it.
    const panels: Array<[PanelTabKind, string, string, React.ElementType]> = [
      ['workflows', 'Industrial workflows, receipts and readiness', 'Workflows', FileOutput],
      ['knowledge', 'Knowledge base', 'Knowledge', Library],
      ['memories', 'Memories and instructions', 'Memories', Brain],
      ['artifacts', 'Artifacts', 'Artifacts', FileOutput],
      ['models', 'Models and routing', 'Models', Server],
      ['audit', 'Audit log', 'Audit', ScrollText],
      ['terminal', 'Sandbox console', 'Sandbox', Terminal],
      ['files', 'Workspace files', 'Files', FolderOpen],
      ['review', 'Proposed changes', 'Review', FileText],
    ];
    panels
      .filter(([, label]) => hit(label))
      .forEach(([kind, label, tab, icon]) =>
        out.push({
          id: `panel-${kind}`,
          icon,
          label,
          group: 'Open panel',
          run: () => {
            openTab(kind, tab);
            close();
          },
        }),
      );

    // Fall through to the agent, which answers with citations.
    if (q && activeWorkspace) {
      out.push({
        id: 'ask',
        icon: ArrowRight,
        label: `Ask about “${query.trim()}”`,
        detail: 'Starts a task — the answer cites the documents it came from',
        group: 'Agent',
        run: () => {
          // The turn is addressed to the task this call creates. `send` reading
          // the active id would find the one that was open before this click.
          const sid = newSession();
          void send(query.trim(), [], sid ?? undefined);
          close();
        },
      });
    }

    return out;
  }, [
    query,
    close,
    catalogueModels,
    workspaces,
    sessions,
    documents,
    artifacts,
    activeWorkspace,
    setActiveWorkspaceId,
    setView,
    openSession,
    openDocument,
    openArtifact,
    openTab,
    newSession,
    send,
  ]);

  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(0, results.length - 1)));
  }, [results.length]);

  useEffect(() => {
    if (isSearchOpen) activeResultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [cursor, query, isSearchOpen]);

  if (!isSearchOpen) return null;

  const grouped = results.reduce<Record<string, Result[]>>((acc, r) => {
    (acc[r.group] ??= []).push(r);
    return acc;
  }, {});

  let flatIndex = -1;

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-start justify-center pt-24 p-4 select-none animate-popover"
      onMouseDown={close}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search the workbench"
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.stopPropagation();
            close();
          }
          if (event.key === 'Tab') {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>('input, button');
            const first = controls?.[0];
            const last = controls?.[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        className="w-full max-w-xl bg-[var(--accent)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center px-3.5 py-3 border-b border-[var(--border)]">
          <Search size={15} className="text-[var(--muted-foreground)] flex-shrink-0 mr-2.5" />
          <input
            data-inset-field
            ref={inputRef}
            value={query}
            aria-label="Search workspaces, tasks, documents, artifacts and panels"
            onChange={(e) => { setQuery(e.target.value); setCursor(0); }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.max(0, Math.min(c + 1, results.length - 1)));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                results[cursor]?.run();
              }
            }}
            placeholder="Find a workspace, task, document, artifact or panel"
            spellCheck={false}
            className="flex-1 bg-transparent text-[13.5px] text-[var(--foreground)] placeholder-[var(--muted-foreground)] outline-none"
          />
          <kbd className="text-[10px] text-[var(--muted-foreground)] border border-[var(--border)] rounded px-1.5 py-0.5 flex-shrink-0 font-mono">
            esc
          </kbd>
        </div>

        <div className="max-h-[380px] overflow-y-auto py-1.5">
          {results.length === 0 ? (
            <p className="px-3.5 py-4 text-[12px] text-[var(--muted-foreground)] leading-relaxed text-center">
              {workspaces.length === 0
                ? 'Nothing to search yet — add a workspace first.'
                : `No match for “${query.trim()}”.`}
            </p>
          ) : (
            Object.entries(grouped).map(([group, items]) => (
              <div key={group} className="mb-1 last:mb-0">
                <div className="px-3.5 py-1 text-[10px] uppercase tracking-wide text-[var(--muted-foreground)]">
                  {group}
                </div>
                {items.map((r) => {
                  flatIndex++;
                  const active = flatIndex === cursor;
                  const Icon = r.icon;
                  const myIndex = flatIndex;
                  return (
                    <button
                      key={r.id}
                      ref={active ? activeResultRef : undefined}
                      onMouseEnter={() => setCursor(myIndex)}
                      onClick={r.run}
                      className={`w-full flex items-center px-3.5 py-2 text-left transition ${
                        active ? 'bg-[var(--popover)]' : 'hover:bg-[var(--card)]'
                      }`}
                    >
                      <Icon
                        size={13}
                        className={`flex-shrink-0 mr-2.5 ${active ? 'text-[var(--foreground)]' : 'text-[var(--muted-foreground)]'}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block text-[12.5px] truncate ${
                            active ? 'text-[var(--foreground)]' : 'text-[var(--foreground)]'
                          }`}
                        >
                          {r.label}
                        </span>
                        {r.detail && (
                          <span className="block text-[10.5px] text-[var(--muted-foreground)] truncate">
                            {r.detail}
                          </span>
                        )}
                      </span>
                      {active && (
                        <CornerDownLeft size={11} className="text-[var(--muted-foreground)] flex-shrink-0 ml-2" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="px-3.5 py-2 border-t border-[var(--border)] flex items-center justify-between">
          <span className="text-[10px] text-[var(--input)]">
            Searches this device only — no index is queried over a network.
          </span>
          <span className="text-[10px] text-[var(--input)] tabular-nums">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </span>
        </div>
      </div>
    </div>
  );
};
