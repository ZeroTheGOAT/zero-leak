/*
 * Source-port of Nerve's titlebar composition for Servergen AI.
 * Nerve Copyright © 2026 ThilinaTLM, Apache-2.0. See THIRD_PARTY_NOTICES.md.
 *
 * ChatGPT-style menu bar: sidebar toggle, back/forward, File / Edit / View.
 * No app icon, no project name — those lived here before and are gone on
 * purpose. Window controls stay on the right.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardCheck,
  Logs,
  Minus,
  PanelLeft,
  Square,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { hasIpc, win } from '../../services/core';

/* ------------------------------------------------------------------ */
/* Edit helpers — act on the focused editable, never on app state      */
/* ------------------------------------------------------------------ */

const focusedEditable = (): HTMLInputElement | HTMLTextAreaElement | HTMLElement | null => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return null;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  if (el.isContentEditable) return el;
  return null;
};

const exec = (command: string): boolean => {
  try {
    return document.execCommand(command);
  } catch {
    return false;
  }
};

const doUndo = () => {
  if (!exec('undo')) focusedEditable()?.blur();
};

const doRedo = () => {
  if (!exec('redo')) exec('redo');
};

const doCut = () => {
  const el = focusedEditable();
  if (!el) return;
  if (!exec('cut')) {
    try {
      const text = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
        : window.getSelection()?.toString() ?? '';
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
      exec('delete');
    } catch {
      /* clipboard blocked: leave the selection alone */
    }
  }
};

const doCopy = () => {
  const el = focusedEditable();
  const selected = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0)
    : window.getSelection()?.toString() ?? '';
  if (!exec('copy') && selected) {
    try {
      void navigator.clipboard?.writeText(selected).catch(() => {});
    } catch {
      /* clipboard blocked */
    }
  }
};

const doPaste = () => {
  const el = focusedEditable();
  if (!el) return;
  if (!exec('paste')) {
    try {
      void navigator.clipboard?.readText().then((text) => {
        if (!text) return;
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const start = el.selectionStart ?? el.value.length;
          const end = el.selectionEnd ?? el.value.length;
          el.setRangeText(text, start, end, 'end');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          exec('insertText');
        }
      }).catch(() => {});
    } catch {
      /* clipboard blocked */
    }
  }
};

const doDelete = () => {
  if (!exec('delete')) exec('forwardDelete');
};

const doSelectAll = () => {
  const el = focusedEditable();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    el.select();
    return;
  }
  exec('selectAll');
};

/* ------------------------------------------------------------------ */
/* Menu primitives                                                     */
/* ------------------------------------------------------------------ */

interface MenuItemDef {
  label: string;
  shortcut?: string;
  checked?: boolean;
  disabled?: boolean;
  action?: () => void;
}

const SEPARATOR = '---';

const MenuButton: React.FC<{
  label: string;
  open: boolean;
  onClick: () => void;
  onHover: () => void;
}> = ({ label, open, onClick, onHover }) => (
  <button
    onMouseEnter={onHover}
    onClick={onClick}
    aria-expanded={open}
    aria-haspopup="menu"
    className={`h-7 rounded-md px-2.5 text-xs transition ${
      open
        ? 'bg-[var(--accent)] text-[var(--foreground)]'
        : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]'
    }`}
  >
    {label}
  </button>
);

/* ------------------------------------------------------------------ */
/* Title bar                                                           */
/* ------------------------------------------------------------------ */

export const TitleBar: React.FC = () => {
  const {
    setView,
    openTab,
    tabs,
    closeTab,
    newSession,
    addWorkspace,
    sessions,
    activeSessionId,
    openSession,
    setIsSearchOpen,
    isSidebarOpen,
    setIsSidebarOpen,
    isBottomPanelOpen,
    setIsBottomPanelOpen,
    showPinnedSummary,
    setShowPinnedSummary,
    zoomLevel,
    zoomIn,
    zoomOut,
    resetZoom,
  } = useApp();
  const desktop = hasIpc();
  const [openMenu, setOpenMenu] = useState<'file' | 'edit' | 'view' | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const barRef = useRef<HTMLElement>(null);

  /* Chat back/forward history: every opened session is pushed; Back walks
   * to the previously opened one, Forward re-enters. Previous/Next Chat
   * instead cycle the session list order (with wrap). Kept in state (no
   * refs) so rendering the menus never touches a ref value. */
  const [nav, setNav] = useState<{ hist: string[]; idx: number }>({ hist: [], idx: -1 });

  useEffect(() => {
    if (!activeSessionId) return;
    // A Back/Forward step lands on a session already in history, so the
    // equality guard makes navigation a no-push automatically.
    setNav((prev) => {
      if (prev.hist[prev.idx] === activeSessionId) return prev;
      const hist = [...prev.hist.slice(0, prev.idx + 1), activeSessionId].slice(-50);
      return { hist, idx: hist.length - 1 };
    });
  }, [activeSessionId]);

  const goBack = useCallback(() => {
    const target = nav.hist[nav.idx - 1];
    if (!target) return;
    setNav((prev) => ({ hist: prev.hist, idx: prev.idx - 1 }));
    openSession(target);
  }, [nav, openSession]);

  const goForward = useCallback(() => {
    const target = nav.hist[nav.idx + 1];
    if (!target) return;
    setNav((prev) => ({ hist: prev.hist, idx: prev.idx + 1 }));
    openSession(target);
  }, [nav, openSession]);

  const canGoBack = nav.idx > 0;
  const canGoForward = nav.idx < nav.hist.length - 1;

  const stepChat = useCallback((direction: 1 | -1) => {
    if (sessions.length === 0) return;
    const at = sessions.findIndex((s) => s.id === activeSessionId);
    const next = sessions[(at + direction + sessions.length) % sessions.length];
    if (next) openSession(next.id);
  }, [sessions, activeSessionId, openSession]);

  const prevChat = useCallback(() => stepChat(1), [stepChat]);
  const nextChat = useCallback(() => stepChat(-1), [stepChat]);

  const hasFilesTab = tabs.some((t) => t.kind === 'files');
  const hasReviewTab = tabs.some((t) => t.kind === 'review');

  const toggleFilesTab = useCallback(() => {
    const existing = tabs.filter((t) => t.kind === 'files');
    if (existing.length > 0) existing.forEach((t) => closeTab(t.id));
    else openTab('files', 'Files');
  }, [tabs, closeTab, openTab]);

  const toggleReviewTab = useCallback(() => {
    const existing = tabs.filter((t) => t.kind === 'review');
    if (existing.length > 0) existing.forEach((t) => closeTab(t.id));
    else openTab('review', 'Review');
  }, [tabs, closeTab, openTab]);

  const toggleFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void document.documentElement.requestFullscreen().catch(() => {});
    } catch {
      /* webview without fullscreen support: no-op */
    }
  }, []);

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const openNewWindow = useCallback(() => {
    // No backend window spawner exists, so this re-opens the current entry
    // point in a second window/tab. Local-only either way: same origin,
    // same device, no network.
    try {
      window.open(window.location.href, '_blank', 'noopener');
    } catch {
      /* popup blocked: the operator can duplicate the window manually */
    }
  }, []);

  const closeWindow = useCallback(() => {
    // File → Close closes this window. Quitting the whole app is File → Quit.
    if (desktop) void win.close().catch(() => {});
    else {
      try {
        window.close();
      } catch {
        /* browsers block script-closing a tab with history: no-op */
      }
    }
  }, [desktop]);

  const quitApp = useCallback(() => {
    // Quits the entire app (all windows), not just this one.
    if (desktop) void win.quit().catch(() => {});
    else {
      try {
        window.close();
      } catch {
        /* browser tab: same as Close */
      }
    }
  }, [desktop]);

  /* View-menu accelerators that App.tsx does not already own (it owns
   * Ctrl+N new chat and Ctrl+K search). Typing is never hijacked for
   * keys the focused field needs. */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target?.isContentEditable ?? false);
      const key = e.key.toLowerCase();
      if (key === 'o') {
        e.preventDefault();
        addWorkspace();
      } else if (key === 'f' && !typing) {
        e.preventDefault();
        setIsSearchOpen(true);
      } else if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        zoomIn();
      } else if (e.key === '-') {
        e.preventDefault();
        zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        resetZoom();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [addWorkspace, setIsSearchOpen, zoomIn, zoomOut, resetZoom]);

  /* Click-away and Escape close the open menu. */
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const dragWindow = (event: React.MouseEvent<HTMLElement>) => {
    if (!desktop || event.button !== 0) return;
    const target = event.target as HTMLElement;
    // Controls keep their normal click behavior. Everything else in the bar
    // is a reliable grip, including the padded areas around each group.
    if (target.closest('button, input, select, textarea, a, [role="menu"]')) return;
    if (event.detail === 2) {
      void win.toggleMaximize().catch(() => {});
      return;
    }
    void win.startDragging().catch(() => {});
  };

  const fileItems: Array<MenuItemDef | typeof SEPARATOR> = [
    { label: 'New Window', action: openNewWindow },
    { label: 'New Chat', shortcut: 'Ctrl+N', action: () => newSession() },
    { label: 'Open Folder…', shortcut: 'Ctrl+O', action: addWorkspace },
    SEPARATOR,
    // Close closes this window; Quit exits the whole app (all windows).
    { label: 'Close', shortcut: 'Ctrl+W', action: closeWindow },
    { label: 'Minimize', action: () => void win.minimize().catch(() => {}) },
    SEPARATOR,
    { label: 'Quit', shortcut: 'Ctrl+Q', action: quitApp },
  ];

  const editItems: Array<MenuItemDef | typeof SEPARATOR> = [
    { label: 'Undo', shortcut: 'Ctrl+Z', action: doUndo },
    { label: 'Redo', shortcut: 'Ctrl+Y', action: doRedo },
    SEPARATOR,
    { label: 'Cut', shortcut: 'Ctrl+X', action: doCut },
    { label: 'Copy', shortcut: 'Ctrl+C', action: doCopy },
    { label: 'Paste', shortcut: 'Ctrl+V', action: doPaste },
    { label: 'Delete', action: doDelete },
    SEPARATOR,
    { label: 'Select All', shortcut: 'Ctrl+A', action: doSelectAll },
  ];

  const viewItems: Array<MenuItemDef | typeof SEPARATOR> = [
    { label: 'Toggle Sidebar', checked: isSidebarOpen, action: () => setIsSidebarOpen(!isSidebarOpen) },
    // The bottom dock hosts the sandbox terminal.
    { label: 'Toggle Bottom Panel', checked: isBottomPanelOpen, action: () => setIsBottomPanelOpen(!isBottomPanelOpen) },
    { label: 'Toggle Pinned Summary', checked: showPinnedSummary, action: () => setShowPinnedSummary(!showPinnedSummary) },
    { label: 'Toggle File Tree', checked: hasFilesTab, action: toggleFilesTab },
    { label: 'Toggle Review Panel', checked: hasReviewTab, action: toggleReviewTab },
    SEPARATOR,
    { label: 'Find…', shortcut: 'Ctrl+F', action: () => setIsSearchOpen(true) },
    { label: 'Previous Chat', disabled: sessions.length < 2, action: prevChat },
    { label: 'Next Chat', disabled: sessions.length < 2, action: nextChat },
    { label: 'Back', disabled: !canGoBack, action: goBack },
    { label: 'Forward', disabled: !canGoForward, action: goForward },
    SEPARATOR,
    { label: 'Zoom In', shortcut: 'Ctrl+=', action: zoomIn },
    { label: 'Zoom Out', shortcut: 'Ctrl+-', action: zoomOut },
    { label: `Actual Size${Math.abs(zoomLevel - 1) < 0.001 ? '' : ` (${Math.round(zoomLevel * 100)}%)`}`, shortcut: 'Ctrl+0', action: resetZoom },
    { label: 'Toggle Full Screen', checked: isFullscreen, action: toggleFullscreen },
  ];

  const renderMenu = (items: Array<MenuItemDef | typeof SEPARATOR>) => (
    <div
      role="menu"
      className="absolute top-full left-0 mt-1 min-w-60 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] py-1.5 shadow-2xl animate-popover z-[200]"
    >
      {items.map((item, i) =>
        item === SEPARATOR ? (
          <div key={`sep-${i}`} className="my-1.5 border-t border-[var(--border)]" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              setOpenMenu(null);
              item.action?.();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-[var(--foreground)] transition hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <span className="w-4 flex-shrink-0 text-[var(--primary)]">
              {item.checked && <Check size={13} />}
            </span>
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.shortcut && (
              <span className="flex-shrink-0 font-mono text-[10.5px] text-[var(--muted-foreground)]">
                {item.shortcut}
              </span>
            )}
          </button>
        ),
      )}
    </div>
  );

  const menus: Array<{ id: 'file' | 'edit' | 'view'; label: string; items: Array<MenuItemDef | typeof SEPARATOR> }> = [
    { id: 'file', label: 'File', items: fileItems },
    { id: 'edit', label: 'Edit', items: editItems },
    { id: 'view', label: 'View', items: viewItems },
  ];

  return (
    <header
      ref={barRef}
      {...(desktop ? { 'data-tauri-drag-region': true } : {})}
      onMouseDown={dragWindow}
      className="nerve-card h-9 min-h-9 flex items-center gap-1 px-2 select-none border-b nerve-border"
    >
      {/* Left: sidebar toggle, history, menus — ChatGPT order */}
      <div
        {...(desktop ? { 'data-tauri-drag-region': true } : {})}
        className="flex min-w-0 flex-none items-center gap-0.5"
      >
        <button
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          aria-pressed={isSidebarOpen}
          aria-label={isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          title={isSidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          className={`grid size-7 place-items-center rounded-md transition ${
            isSidebarOpen
              ? 'text-[var(--foreground)] hover:bg-[var(--accent)]'
              : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]'
          }`}
        >
          <PanelLeft size={15} />
        </button>
        <button
          onClick={goBack}
          disabled={!canGoBack}
          aria-label="Back to previous chat"
          title="Back"
          className="grid size-7 place-items-center rounded-md text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--muted-foreground)]"
        >
          <ArrowLeft size={15} />
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          aria-label="Forward to next chat"
          title="Forward"
          className="grid size-7 place-items-center rounded-md text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-[var(--muted-foreground)]"
        >
          <ArrowRight size={15} />
        </button>

        {menus.map((menu) => (
          <div key={menu.id} className="relative">
            <MenuButton
              label={menu.label}
              open={openMenu === menu.id}
              onClick={() => setOpenMenu(openMenu === menu.id ? null : menu.id)}
              onHover={() => {
                if (openMenu && openMenu !== menu.id) setOpenMenu(menu.id);
              }}
            />
            {openMenu === menu.id && renderMenu(menu.items)}
          </div>
        ))}
      </div>

      <div
        {...(desktop ? { 'data-tauri-drag-region': true } : {})}
        className="min-w-6 self-stretch flex-1 cursor-default"
        aria-hidden="true"
      />

      {/* Right: utilities + window controls. No Help menu by design. */}
      <div
        {...(desktop ? { 'data-tauri-drag-region': true } : {})}
        className="flex min-w-0 flex-none items-center gap-1"
      >
        <button onClick={() => { setView('workbench'); openTab('workflows', 'Workflows'); }} className="hidden sm:inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-[var(--foreground)] hover:bg-[var(--accent)]" title="Industrial workflows, receipts and readiness"><ClipboardCheck size={12} /><span>Workflows</span></button>
        <span className="hidden sm:inline-flex rounded-md border nerve-border px-1.5 py-0.5 font-mono text-[9px] text-[var(--muted-foreground)]">
          v0.1.0
        </span>
        <button
          onClick={() => openTab('audit', 'Logs')}
          className="grid size-6 place-items-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
          title="Open Servergen logs"
        >
          <Logs size={12} strokeWidth={2.1} />
        </button>

        {desktop && (
          <>
            <span className="mx-0.5 h-4 w-px bg-[var(--border)]" aria-hidden="true" />
            <button
              onClick={() => void win.minimize().catch(() => {})}
              className="grid h-6 w-8 place-items-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              title="Minimize"
            >
              <Minus size={11} />
            </button>
            <button
              onClick={() => void win.toggleMaximize().catch(() => {})}
              className="grid h-6 w-8 place-items-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              title="Maximize"
            >
              <Square size={8} />
            </button>
            <button
              onClick={() => void win.close().catch(() => {})}
              className="grid h-6 w-8 place-items-center rounded-sm text-[var(--muted-foreground)] hover:bg-[var(--destructive-solid)] hover:text-[var(--destructive-solid-foreground)]"
              title="Close"
            >
              <X size={11} />
            </button>
          </>
        )}
      </div>
    </header>
  );
};
