import React, { useEffect, useRef, useState } from 'react';
import {
  FileCheck,
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

const TAB_META: Record<
  PanelTabKind,
  { label: string; icon: React.ElementType; tone: string; hint: string }
> = {
  review: {
    label: 'Review',
    icon: FileCheck,
    tone: 'text-emerald-400',
    hint: 'Proposed file changes, applied only when you accept them',
  },
  terminal: {
    label: 'Sandbox',
    icon: Terminal,
    tone: 'text-sky-400',
    hint: 'Isolated execution — no network, capped memory and runtime',
  },
  files: {
    label: 'Files',
    icon: FolderTree,
    tone: 'text-amber-400',
    hint: 'Files inside the approved workspace',
  },
  document: {
    label: 'Document',
    icon: FileText,
    tone: 'text-violet-400',
    hint: 'Extracted text and tables with their source coordinates',
  },
  knowledge: {
    label: 'Knowledge',
    icon: Library,
    tone: 'text-cyan-400',
    hint: 'The local index — embedded and stored on this device',
  },
  memories: {
    label: 'Memories',
    icon: Brain,
    tone: 'text-violet-400',
    hint: 'Global and project recall, plus durable instructions',
  },
  artifacts: {
    label: 'Artifacts',
    icon: Package,
    tone: 'text-orange-400',
    hint: 'Generated files with their provenance',
  },
  models: {
    label: 'Models',
    icon: Server,
    tone: 'text-[#c4c4c8]',
    hint: 'Registry, residency and the routing table',
  },
  audit: {
    label: 'Audit',
    icon: ScrollText,
    tone: 'text-[#9da0a8]',
    hint: 'Every tool call, and every byte that left this machine',
  },
};

const ORDER: PanelTabKind[] = [
  'review',
  'terminal',
  'files',
  'document',
  'artifacts',
];

export const RightPanel: React.FC = () => {
  const { isPanelOpen, setIsPanelOpen, tabs, activeTabId, setActiveTabId, openTab, closeTab } =
    useApp();

  const [addOpen, setAddOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);

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

  return (
    <aside
      className={`border-l border-[#1e2027] bg-[#14151a] flex flex-col h-full min-h-0 select-none transition-[width] duration-200 flex-shrink-0 ${
        wide ? 'w-[760px]' : 'w-[480px]'
      }`}
    >
      <div className="h-11 px-2 border-b border-[#1c1d24] flex items-center bg-[#111216] relative z-50">
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
                    ? 'bg-[#1e2029] text-white border-[#313545] font-medium'
                    : 'bg-transparent text-[#8e8e93] hover:text-[#d4d4d8] hover:bg-[#181a21] border-transparent'
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
                  className="p-0.5 rounded text-[#71717a] hover:text-white hover:bg-[#282c3b] transition flex-shrink-0"
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
                ? 'bg-[#282b3a] text-white'
                : 'text-[#8e8e93] hover:text-white hover:bg-[#1e2029]'
            }`}
            title="Open a panel"
          >
            <Plus size={14} />
          </button>

          {addOpen && (
            <div className="absolute top-full right-0 mt-1.5 w-72 bg-[#1c1d27] border border-[#2e3244] rounded-xl shadow-2xl py-1.5 z-[100] animate-popover">
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
                    className="w-full flex items-start space-x-2.5 px-3 py-2 text-left transition hover:bg-[#282c3e] text-[#b0b3c2] hover:text-white"
                  >
                    <Icon size={13} className={`${meta.tone} flex-shrink-0 mt-0.5`} />
                    <span className="min-w-0">
                      <span className="block text-[11.5px] font-medium">{meta.label}</span>
                      <span className="block text-[10px] text-[#787b8d] leading-snug">
                        {meta.hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex items-center space-x-1 text-[#8e8e93] flex-shrink-0 ml-auto">
          <button
            onClick={() => setWide(!wide)}
            className="p-1.5 hover:text-white hover:bg-[#1e2029] rounded-lg transition"
            title={wide ? 'Narrow' : 'Widen'}
          >
            {wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={() => setIsPanelOpen(false)}
            className="p-1.5 hover:text-white hover:bg-[#1e2029] rounded-lg transition"
            title="Close panel"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {current?.kind === 'review' && <DiffReviewer />}
        {current?.kind === 'terminal' && <SandboxConsole />}
        {current?.kind === 'files' && <FileExplorerView />}
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
