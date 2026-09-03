/*
 * Source-port of Nerve's titlebar composition for Servergen AI.
 * Nerve Copyright © 2026 ThilinaTLM, Apache-2.0. See THIRD_PARTY_NOTICES.md.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  Compass,
  FolderOpen,
  Logs,
  Minus,
  Plus,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { hasIpc, win } from '../../services/core';

export const TitleBar: React.FC = () => {
  const {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    setActiveWorkspaceId,
    addWorkspace,
    openSettings,
    openTab,
    setView,
  } = useApp();
  const desktop = hasIpc();
  const [projectMenu, setProjectMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!projectMenu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setProjectMenu(false);
    };
    const escape = (event: KeyboardEvent) => event.key === 'Escape' && setProjectMenu(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', escape);
    };
  }, [projectMenu]);

  return (
    <header
      {...(desktop ? { 'data-tauri-drag-region': true } : {})}
      className="nerve-card h-12 min-h-12 flex items-center justify-between gap-4 px-3 select-none border-b nerve-border"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden">
        <button
          onClick={() => setView('workbench')}
          className="inline-flex size-5 flex-none items-center justify-center rounded-[4px] bg-[var(--foreground)] text-[var(--background)] text-[11px] font-semibold"
          title="Servergen AI"
          aria-label="Open workbench"
        >
          S
        </button>
        <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setProjectMenu((open) => !open)}
            className="flex max-w-[26rem] items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--foreground)] hover:bg-[var(--accent)] transition-colors"
            aria-expanded={projectMenu}
          >
            <FolderOpen size={15} className="text-[var(--muted-foreground)]" />
            <span className="truncate">{activeWorkspace?.name ?? 'Open a project'}</span>
            <ChevronDown size={13} className="text-[var(--muted-foreground)]" />
          </button>

          {projectMenu && (
            <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border nerve-border bg-[var(--popover)] p-1 text-[var(--popover-foreground)] shadow-xl animate-popover">
              <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--muted-foreground)]">
                Projects
              </p>
              {workspaces.map((workspace) => (
                <button
                  key={workspace.id}
                  onClick={() => {
                    setActiveWorkspaceId(workspace.id);
                    setView('workbench');
                    setProjectMenu(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors ${
                    activeWorkspaceId === workspace.id
                      ? 'bg-[var(--accent)] text-[var(--accent-foreground)]'
                      : 'hover:bg-[var(--accent)]'
                  }`}
                  title={workspace.path}
                >
                  <FolderOpen size={14} className="text-[var(--muted-foreground)]" />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {!workspace.approved && (
                    <span className="text-[10px] text-[var(--warning)]">approval needed</span>
                  )}
                </button>
              ))}
              {workspaces.length === 0 && (
                <p className="px-2 py-2 text-xs text-[var(--muted-foreground)]">
                  No local project is open.
                </p>
              )}
              <div className="my-1 h-px bg-[var(--border)]" />
              <button
                onClick={() => {
                  setProjectMenu(false);
                  void addWorkspace();
                }}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-[var(--accent)]"
              >
                <Plus size={14} />
                Open project folder
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-none items-center gap-1.5">
        <span className="hidden sm:inline-flex rounded-md border nerve-border px-2 py-1 font-mono text-[10px] text-[var(--muted-foreground)]">
          v0.1.0
        </span>
        <button
          onClick={() => setView('workbench')}
          className="grid size-8 place-items-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          title="Discover Servergen AI"
        >
          <Compass size={16} strokeWidth={2.1} />
        </button>
        <button
          onClick={() => openTab('audit', 'Logs')}
          className="grid size-8 place-items-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          title="Open Servergen logs"
        >
          <Logs size={16} strokeWidth={2.1} />
        </button>
        <button
          onClick={() => openSettings('workbench')}
          className="grid size-8 place-items-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          title="Open settings"
        >
          <Settings size={16} strokeWidth={2.1} />
        </button>

        {desktop && (
          <>
            <span className="mx-0.5 h-5 w-px bg-[var(--border)]" aria-hidden="true" />
            <button
              onClick={() => void win.minimize().catch(() => {})}
              className="grid h-8 w-10 place-items-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              title="Minimize"
            >
              <Minus size={14} />
            </button>
            <button
              onClick={() => void win.toggleMaximize().catch(() => {})}
              className="grid h-8 w-10 place-items-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              title="Maximize"
            >
              <Square size={11} />
            </button>
            <button
              onClick={() => void win.close().catch(() => {})}
              className="grid h-8 w-10 place-items-center rounded-sm text-[var(--muted-foreground)] hover:bg-red-600 hover:text-white"
              title="Close"
            >
              <X size={14} />
            </button>
          </>
        )}
      </div>
    </header>
  );
};
