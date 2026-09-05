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
  Terminal,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { PanelTabKind } from '../../types';
import { DiffReviewer } from './DiffReviewer';
import { SandboxConsole } from './SandboxConsole';
import { FileExplorerView } from './FileExplorerView';
import { DocumentViewer } from './DocumentViewer';
import { KnowledgeView } from './KnowledgeView';
import { MemoryView } from './MemoryView';
import { ArtifactsView } from './ArtifactsView';
import { ModelManagerView } from './ModelManagerView';
import { AuditView } from './AuditView';
import { FilePreview } from './FilePreview';
import { WorkflowView } from './WorkflowView';

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
  file: {
    label: 'File',
    icon: File,
    tone: 'text-[var(--accent-2)]',
    hint: 'Local file preview — stays inside the workbench',
  },
  document: {
    label: 'Document',
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

export const RightPanel: React.FC = () => {
  const { isPanelOpen, setIsPanelOpen, tabs, activeTabId, setActiveTabId, openTab, closeTab } =
    useApp();

  const [addOpen, setAddOpen] = useState(false);
  const [panelWidth, setPanelWidth] = useState(560);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);

  const clampWidth = (width: number) =>
    Math.min(Math.max(340, width), Math.max(340, window.innerWidth - 360));

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
      setPanelWidth(Math.min(Math.max(340, width), Math.max(340, window.innerWidth - 360)));
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

  if (!isPanelOpen || tabs.length === 0) return null;

  const current = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const wide = panelWidth >= 700;

  return (
    <aside
      className={`relative border-l border-[var(--border)] bg-[var(--card)] flex flex-col h-full min-h-0 select-none flex-shrink-0 ${
        resizing ? '' : 'transition-[width] duration-200'
      }`}
      style={{ width: panelWidth }}
    >
      <div
        role="separator"
        aria-label="Resize right panel"
        aria-orientation="vertical"
        onPointerDown={beginResize}
        onDoubleClick={() => setPanelWidth(560)}
        className={`absolute -left-1 top-0 bottom-0 z-[80] w-2 cursor-col-resize touch-none transition-colors ${
          resizing ? 'bg-[var(--primary-ring)]' : 'hover:bg-[var(--primary-ring)]'
        }`}
        title="Drag left or right to resize"
      />
      <div className="h-11 px-2 border-b border-[var(--border)] flex items-center bg-[var(--card)] relative z-50">
        <div className="flex items-center space-x-1 overflow-x-auto scrollbar-none py-1 min-w-0">
          {tabs.map((tab) => {
            const meta = TAB_META[tab.kind];
            const Icon = meta.icon;
            const active = tab.id === current?.id;
            return (
              <div
                key={tab.id}
                className={`flex items-center space-x-1.5 pl-2 pr-1 py-1.5 rounded-lg text-[11.5px] transition flex-shrink-0 border ${
                  active
                    ? 'bg-[var(--card)] text-[var(--foreground)] border-[var(--border)] font-medium'
                    : 'bg-transparent text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] border-transparent'
                }`}
              >
                <button
                  onClick={() => setActiveTabId(tab.id)}
                  className="flex items-center space-x-1.5 min-w-0"
                  title={meta.hint}
                >
                  <Icon size={12} className={`${meta.tone} flex-shrink-0`} />
                  <span className="truncate max-w-[110px]">{tab.title}</span>
                </button>
                <button
                  onClick={() => closeTab(tab.id)}
                  className="p-0.5 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--popover)] transition flex-shrink-0"
                  title="Close tab"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>

        <div ref={addRef} className="relative flex-shrink-0 mx-1">
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

        <div className="flex items-center space-x-1 text-[var(--muted-foreground)] flex-shrink-0 ml-auto">
          <button
            onClick={() => setPanelWidth(clampWidth(wide ? 560 : 760))}
            className="p-1.5 hover:text-[var(--foreground)] hover:bg-[var(--card)] rounded-lg transition"
            title={wide ? 'Narrow' : 'Widen'}
          >
            {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={() => setIsPanelOpen(false)}
            className="p-1.5 hover:text-[var(--foreground)] hover:bg-[var(--card)] rounded-lg transition"
            title="Close panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {current?.kind === 'workflows' && <WorkflowView />}
        {current?.kind === 'review' && <DiffReviewer />}
        {current?.kind === 'terminal' && <SandboxConsole />}
        {current?.kind === 'files' && <FileExplorerView />}
        {current?.kind === 'file' && <FilePreview path={current.filePath} />}
        {current?.kind === 'document' && <DocumentViewer documentId={current.documentId} />}
        {current?.kind === 'knowledge' && <KnowledgeView />}
        {current?.kind === 'memories' && <MemoryView />}
        {current?.kind === 'artifacts' && <ArtifactsView />}
        {current?.kind === 'models' && <ModelManagerView />}
        {current?.kind === 'audit' && <AuditView />}
      </div>
    </aside>
  );
};
