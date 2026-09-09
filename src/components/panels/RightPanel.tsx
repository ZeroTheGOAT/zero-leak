import React, { useEffect, useRef, useState } from 'react';
import {
  FileCheck,
  File,
  FileText,
  Brain,
  FolderTree,
  Library,
  Maximize2,
  Minimize2,
  Package,
  Plus,
  ScrollText,
  Server,
  Share2,
  Terminal,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { PanelTabKind } from '../../types';
import { DiffReviewer } from './DiffReviewer';
import { SandboxConsole } from './SandboxConsole';
import { FileExplorerView, iconFor as fileTypeIcon } from './FileExplorerView';
import { DocumentViewer } from './DocumentViewer';
import { KnowledgeView } from './KnowledgeView';
import { MemoryView } from './MemoryView';
import { ArtifactsView } from './ArtifactsView';
import { ModelManagerView } from './ModelManagerView';
import { AuditView } from './AuditView';
import { FilePreview } from './FilePreview';
import { WorkflowView } from './WorkflowView';
import { ConversationSourcesView } from './ConversationSourcesView';

const TAB_META: Record<
  PanelTabKind,
  { label: string; icon: React.ElementType; tone: string; hint: string }
> = {
  workflows: { label: 'Workflows', icon: FileCheck, tone: 'text-[var(--primary)]', hint: 'Industrial workflows, run receipts and deployment checks' },
  review: {
    label: 'Review',
    icon: FileCheck,
    tone: 'text-[var(--success)]',
    hint: 'Proposed file changes, applied only when you accept them',
  },
  terminal: {
    label: 'Sandbox',
    icon: Terminal,
    tone: 'text-[var(--info)]',
    hint: 'Isolated execution — no network, capped memory and runtime',
  },
  files: {
    label: 'Files',
    icon: FolderTree,
    tone: 'text-[var(--warning)]',
    hint: 'Files inside the approved workspace',
  },
  sources: {
    label: 'Sources',
    icon: Share2,
    tone: 'text-[var(--muted-foreground)]',
    hint: 'Every file and citation attached to this conversation',
  },
  file: {
    label: 'File',
    icon: File,
    tone: 'text-[var(--accent-2)]',
    hint: 'Local file preview — stays inside the workbench',
  },
  document: {
    label: 'Documents',
    icon: FileText,
    tone: 'text-[var(--accent-2)]',
    hint: 'Extracted text and tables with their source coordinates',
  },
  knowledge: {
    label: 'Knowledge',
    icon: Library,
    tone: 'text-[var(--info)]',
    hint: 'The local index — embedded and stored on this device',
  },
  memories: {
    label: 'Memories',
    icon: Brain,
    tone: 'text-[var(--accent-2)]',
    hint: 'Global and project recall, plus durable instructions',
  },
  artifacts: {
    label: 'Artifacts',
    icon: Package,
    tone: 'text-[var(--primary)]',
    hint: 'Generated files with their provenance',
  },
  models: {
    label: 'Models',
    icon: Server,
    tone: 'text-[var(--foreground)]',
    hint: 'Registry, residency and the routing table',
  },
  audit: {
    label: 'Audit',
    icon: ScrollText,
    tone: 'text-[var(--muted-foreground)]',
    hint: 'Every tool call, and every byte that left this machine',
  },
};

const ORDER: PanelTabKind[] = [
  'workflows',
  'review',
  'terminal',
  'files',
  'document',
  'artifacts',
  'audit',
];

const PanelLauncher: React.FC<{
  onOpen: (kind: PanelTabKind, label: string) => void;
}> = ({ onOpen }) => (
  <div className="flex flex-1 items-center justify-center overflow-y-auto px-6 py-8">
    <div className="w-full max-w-md space-y-1.5" role="menu" aria-label="Open a side panel">
      {ORDER.map((kind) => {
        const meta = TAB_META[kind];
        const Icon = meta.icon;
        return (
          <button
            key={kind}
            type="button"
            role="menuitem"
            onClick={() => onOpen(kind, meta.label)}
            className="flex w-full items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] px-4 py-3 text-left text-sm font-medium text-[var(--foreground)] transition hover:bg-[var(--accent)]"
            title={meta.hint}
          >
            <Icon size={17} className={`${meta.tone} flex-shrink-0`} />
            <span>{meta.label}</span>
          </button>
        );
      })}
    </div>
  </div>
);

export const RightPanel: React.FC = () => {
  const {
    isPanelOpen,
    tabs,
    activeTabId,
    setActiveTabId,
    openTab,
    closeTab,
  } = useApp();

  const [addOpen, setAddOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(560);
  const [expanded, setExpanded] = useState(false);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Drag sizing never eats the chat screen: the panel may grow to at most
  // 60% of the window, so the composer's action row (planning, approvals,
  // documents, local models…) is never squeezed off. Past that, a deliberate
  // Expand from the header opens the panel at full width instead.
  const MAX_PANEL_FRACTION = 0.6;
  const clampWidth = (width: number) =>
    Math.min(Math.max(340, width), Math.max(340, Math.floor(window.innerWidth * MAX_PANEL_FRACTION)));

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width: panelWidth };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      if (!resizeStart.current) return;
      const width = resizeStart.current.width + resizeStart.current.x - event.clientX;
      setPanelWidth(clampWidth(width));
    };
    const end = () => {
      resizeStart.current = null;
      setResizing(false);
    };
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [resizing]);

  useEffect(() => {
    if (!addOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!addRef.current?.contains(e.target as Node)) setAddOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [addOpen]);

  // Expanding covers the chat with the panel; drop any focus that landed in
  // the composer so keystrokes never keep going to an invisible input.
  useEffect(() => {
    if (!expanded) return;
    (document.activeElement as HTMLElement | null)?.blur?.();
  }, [expanded]);

  // Keep the active tab (and its close button) in view, so opening or
  // selecting the last tab never strands it off-screen behind a manual scroll.
  useEffect(() => {
    if (!activeTabId) return;
    tabRefs.current.get(activeTabId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeTabId, tabs.length]);

  const current = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  return (
    <aside
      aria-hidden={!isPanelOpen}
      inert={!isPanelOpen}
      className={`overflow-hidden border-l bg-[var(--card)] flex flex-col min-h-0 select-none ${
        isPanelOpen ? 'border-[var(--border)]' : 'pointer-events-none border-transparent'
      } ${
        // Expanded: lift out of the flex row and cover it edge to edge. The
        // composer and its action row float above the chat column, so a
        // collapsed chat can still paint them over the panel — only full
        // cover in front of everything inside the row hides the chat.
        expanded ? 'absolute inset-y-0 right-0 z-[60]' : 'relative h-full flex-shrink-0'
      } ${
        resizing
          ? 'transition-[transform,opacity,border-color]'
          : 'transition-[width,transform,opacity,border-color]'
      } duration-[390ms] ease-[cubic-bezier(0.22,1,0.36,1)]`}
      style={{
        width: isPanelOpen ? (expanded ? '100%' : panelWidth) : 0,
        transform: isPanelOpen ? 'translateX(0)' : 'translateX(100%)',
        opacity: isPanelOpen ? 1 : 0,
      }}
    >
      {/* Drag handle only while docked — an expanded panel fills the row, so
          there is nothing beside it to resize against. */}
      {isPanelOpen && !expanded && (
        <div
          role="separator"
          aria-label="Resize right panel"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          onDoubleClick={() => setPanelWidth(560)}
          className="group/split absolute -left-1 top-0 bottom-0 z-[80] w-2 cursor-col-resize touch-none"
          title="Drag left or right to resize — up to 60% of the window"
        >
          {/* Slim 1px line that only brightens a touch on hover — never a band. */}
          <div
            aria-hidden="true"
            className={`mx-auto h-full w-px transition-colors ${
              resizing ? 'bg-[var(--muted-foreground)]' : 'bg-transparent group-hover/split:bg-[var(--muted-foreground)]'
            }`}
          />
        </div>
      )}
      <div className="h-11 pl-2 pr-12 flex items-center bg-[var(--background)] border-b border-[var(--border)] relative">
        <div className="flex items-center gap-1 overflow-x-auto py-1 min-w-0 max-w-full shrink [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="tablist" aria-label="Side panel tabs">
          {tabs.map((tab) => {
            const meta = TAB_META[tab.kind];
            const Icon = meta.icon;
            const active = tab.id === current?.id;
            return (
              <div
                key={tab.id}
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                role="tab"
                aria-selected={active}
                aria-label={tab.title}
                onClick={() => setActiveTabId(tab.id)}
                className={`group flex min-w-[96px] shrink-0 cursor-pointer items-center gap-1.5 overflow-hidden pl-2 pr-1.5 py-1.5 rounded-[10px] text-[11.5px] border transition ${
                  active
                    ? 'bg-[var(--card)] border-[var(--border)] text-[var(--foreground)] font-medium'
                    : 'bg-transparent border-transparent text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:border-[var(--border)] hover:text-[var(--foreground)]'
                }`}
              >
                <button
                  onClick={() => setActiveTabId(tab.id)}
                  aria-label={`Show ${tab.title} panel`}
                  className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden"
                  title={meta.hint}
                >
                  {tab.kind === 'file' && tab.filePath ? (
                    fileTypeIcon(
                      {
                        name: tab.filePath.split(/[\\/]/).pop() ?? tab.filePath,
                        relPath: '',
                        isDir: false,
                        sizeBytes: 0,
                        modifiedAt: 0,
                      },
                      false,
                    )
                  ) : (
                    <Icon size={12} className={`${meta.tone} flex-shrink-0`} />
                  )}
                  <span className="truncate min-w-0 max-w-[140px]">{tab.title}</span>
                </button>
                <button
                  onClick={(e) => {
                    // Closing a tab is not selecting it — never let the click
                    // fall through to the pill's own handler.
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  aria-label={`Close ${tab.title} tab`}
                  tabIndex={active ? 0 : -1}
                  className={`p-0.5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--popover)] transition flex-shrink-0 ${
                    active
                      ? 'opacity-100'
                      : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 focus-visible:opacity-100 pointer-events-none group-hover:pointer-events-auto group-focus-within:pointer-events-auto focus:pointer-events-auto'
                  }`}
                  title="Close tab"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        {tabs.length > 0 && (
          <div ref={addRef} className="relative flex-shrink-0 mr-1">
            <button
              onClick={() => setAddOpen(!addOpen)}
              className={`p-1.5 rounded-lg transition ${
                addOpen
                  ? 'bg-[var(--popover)] text-[var(--foreground)]'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--card)]'
              }`}
              title="Open a panel"
            >
              <Plus size={14} />
            </button>

            {addOpen && (
              <div className="absolute top-full right-0 mt-1.5 w-72 bg-[var(--popover)] border border-[var(--border)] rounded-xl shadow-2xl py-1.5 z-[100] animate-popover">
                {ORDER.map((kind) => {
                  const meta = TAB_META[kind];
                  const Icon = meta.icon;
                  return (
                    <button
                      key={kind}
                      onClick={() => {
                        openTab(kind, meta.label);
                        setAddOpen(false);
                      }}
                      className="w-full flex items-start space-x-2.5 px-3 py-2 text-left transition hover:bg-[var(--popover)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                    >
                      <Icon size={13} className={`${meta.tone} flex-shrink-0 mt-0.5`} />
                      <span className="min-w-0">
                        <span className="block text-[11.5px] font-medium">{meta.label}</span>
                        <span className="block text-[10px] text-[var(--muted-foreground)] leading-snug">
                          {meta.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center space-x-1 text-[var(--muted-foreground)] flex-shrink-0 ml-auto">
          {/* Expand — the drag handle stops at 60% of the window so the chat
              screen keeps its action row; wanting more than that is a choice,
              made here: full width, and Restore brings the docked width back. */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 hover:text-[var(--foreground)] hover:bg-[var(--card)] rounded-lg transition"
            title={expanded ? 'Restore — back to the docked width' : 'Expand — panel at full width'}
            aria-pressed={expanded}
          >
            {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {!current ? (
          <PanelLauncher onOpen={(kind, label) => openTab(kind, label)} />
        ) : (
          <>
            {current.kind === 'workflows' && <WorkflowView />}
            {current.kind === 'review' && <DiffReviewer />}
            {current.kind === 'terminal' && <SandboxConsole />}
            {current.kind === 'files' && <FileExplorerView />}
            {current.kind === 'sources' && <ConversationSourcesView />}
            {current.kind === 'file' && <FilePreview path={current.filePath} />}
            {current.kind === 'document' && <DocumentViewer documentId={current.documentId} />}
            {current.kind === 'knowledge' && <KnowledgeView />}
            {current.kind === 'memories' && <MemoryView />}
            {current.kind === 'artifacts' && <ArtifactsView />}
            {current.kind === 'models' && <ModelManagerView />}
            {current.kind === 'audit' && <AuditView />}
          </>
        )}
      </div>
    </aside>
  );
};
