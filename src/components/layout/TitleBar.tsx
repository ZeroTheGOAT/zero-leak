/*
 * Source-port of Nerve's titlebar composition for Servergen AI.
 * Nerve Copyright © 2026 ThilinaTLM, Apache-2.0. See THIRD_PARTY_NOTICES.md.
 */
import React from 'react';
import {
  FolderOpen,
  Logs,
  Minus,
  Settings,
  Square,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { hasIpc, win } from '../../services/core';

export const TitleBar: React.FC = () => {
  const {
    activeWorkspace,
    setView,
    openSettings,
    openTab,
  } = useApp();
  const desktop = hasIpc();

  const dragWindow = (event: React.MouseEvent<HTMLElement>) => {
    if (!desktop || event.button !== 0) return;
    const target = event.target as HTMLElement;
    // Controls keep their normal click behavior. Everything else in the 48px
    // bar is a reliable grip, including the padded areas around each group.
    if (target.closest('button, input, select, textarea, a, [role="menu"]')) return;
    if (event.detail === 2) {
      void win.toggleMaximize().catch(() => {});
      return;
    }
    void win.startDragging().catch(() => {});
  };

  return (
    <header
      {...(desktop ? { 'data-tauri-drag-region': true } : {})}
      onMouseDown={dragWindow}
      className="nerve-card h-12 min-h-12 flex items-center gap-2 px-3 select-none border-b nerve-border"
    >
      <div
        {...(desktop ? { 'data-tauri-drag-region': true } : {})}
        className="flex min-w-0 flex-none items-center gap-2.5 overflow-hidden"
      >
        <button
          onClick={() => setView('workbench')}
          className="inline-flex size-5 flex-none items-center justify-center rounded-[4px] bg-[var(--foreground)] text-[var(--background)] text-[11px] font-semibold"
          title="Servergen AI"
          aria-label="Open workbench"
        >
          S
        </button>
        <span className="h-5 w-px bg-[var(--border)]" aria-hidden="true" />

        <div
          {...(desktop ? { 'data-tauri-drag-region': true } : {})}
          className="flex max-w-[26rem] items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-[var(--foreground)]"
          title={activeWorkspace?.path}
        >
          <FolderOpen size={15} className="text-[var(--muted-foreground)]" />
          <span className="truncate">{activeWorkspace?.name ?? 'Open a project'}</span>
        </div>
      </div>

      <div
        {...(desktop ? { 'data-tauri-drag-region': true } : {})}
        className="min-w-6 self-stretch flex-1 cursor-default"
        aria-hidden="true"
      />

      <div
        {...(desktop ? { 'data-tauri-drag-region': true } : {})}
        className="flex min-w-0 flex-none items-center gap-1.5"
      >
        <span className="hidden sm:inline-flex rounded-md border nerve-border px-2 py-1 font-mono text-[10px] text-[var(--muted-foreground)]">
          v0.1.0
        </span>
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
              className="grid h-8 w-10 place-items-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--destructive-solid)] hover:text-[var(--destructive-solid-foreground)]"
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
