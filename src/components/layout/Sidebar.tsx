import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Edit3,
  Folder,
  FolderOpen,
  Loader2,
  MessageCircle,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  SquarePen,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { Session, Workspace } from '../../types';
import {
  DeleteChatDialog,
  DeleteProjectDialog,
  EditProjectDialog,
} from '../modals/ProjectDialogs';
import { sidebarSizeTransition } from './sidebarMotion';

export const Sidebar: React.FC<{ closing?: boolean; floating?: boolean }> = ({
  closing = false,
  // Floating = the peek overlay shown over content while the sidebar is
  // collapsed. It is pinned-width and transient, so it gets no resize handle —
  // dragging to resize only belongs to the docked, screen-attached sidebar.
  floating = false,
}) => {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
    approveWorkspace,
    updateWorkspace,
    openWorkspaceInExplorer,
    sessions,
    activeSessionId,
    openSession,
    newSession,
    runningSessionIds,
    setIsSearchOpen,
    openSettings,
    setIsSidebarOpen,
  } = useApp();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  // While `closing` the sidebar stays mounted and glides to zero width + fades,
  // so a collapse is a motion, never a vanish. AppContext clears the flag only
  // after the motion has had time to finish (see sidebarLeaving).
  const [fading, setFading] = useState(false);
  const widthRef = useRef(sidebarWidth);
  const wasClosing = useRef(closing);
  const restoreWidth = useRef(260);
  const [editingProject, setEditingProject] = useState<Workspace | null>(null);
  const [deletingProject, setDeletingProject] = useState<Workspace | null>(null);
  const [deletingChat, setDeletingChat] = useState<Session | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ workspace: Workspace; x: number; y: number } | null>(null);
  const [hoverPreview, setHoverPreview] = useState<{ workspace: Workspace; x: number; y: number } | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const hoverHideTimer = useRef<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // How many chats each list shows before "Show more", keyed by project id
  // (`__personal__` / `__detached__` for the ungrouped lists). Each click
  // reveals one more page — never the whole history at once.
  const [chatLimits, setChatLimits] = useState<Record<string, number>>({});

  const isExpanded = (id: string) => expanded[id] ?? id === activeWorkspaceId;

  const personalChats = sessions.filter((s) => !s.workspaceId);
  const detachedChats = sessions.filter(
    (s) => s.workspaceId && !workspaces.some((w) => w.id === s.workspaceId),
  );
  const projectOrder = (left: Workspace, right: Workspace) =>
    Number(right.pinned) - Number(left.pinned) || left.addedAt - right.addedAt;
  const visibleProjects = workspaces.filter((workspace) => !workspace.archived).sort(projectOrder);
  const archivedProjects = workspaces.filter((workspace) => workspace.archived).sort(projectOrder);

  const toggle = (id: string) => {
    // Collapsing a project drops its "Show more" pages: re-expanding starts
    // again from the first few chats instead of the whole revealed history.
    if (isExpanded(id)) {
      setChatLimits((prev) => {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
    setExpanded((prev) => ({ ...prev, [id]: !isExpanded(id) }));
  };

  /** Chats per list before "Show more" — a few, like the reference design. */
  const CHAT_PAGE = 5;
  const limitFor = (key: string) => chatLimits[key] ?? CHAT_PAGE;
  const showMoreChats = (key: string) =>
    setChatLimits((prev) => ({ ...prev, [key]: (prev[key] ?? CHAT_PAGE) + CHAT_PAGE }));

  /**
   * The visible slice of one chat list: the first page plus the open chat,
   * which must never hide itself, with how many are still behind "Show more".
   */
  const pagedChats = (key: string, list: Session[]) => {
    const limit = limitFor(key);
    const shown = list.slice(0, limit);
    if (activeSessionId && !shown.some((s) => s.id === activeSessionId)) {
      const active = list.find((s) => s.id === activeSessionId);
      if (active) shown.push(active);
    }
    return { shown, remaining: Math.max(0, list.length - limit) };
  };

  const showMoreButton = (key: string, remaining: number) =>
    remaining > 0 ? (
      <button
        onClick={() => showMoreChats(key)}
        className="flex h-9 w-full items-center rounded-[10px] px-3 text-left text-[13.5px] text-[var(--muted-foreground)] transition hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)]"
      >
        Show more
      </button>
    ) : null;

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width: sidebarWidth };
    setResizing(true);
  };

  // Dragging the edge all the way to the left collapses the sidebar instead
  // of parking it at a sliver: below the threshold the bar glides away to
  // zero width (closing prop) and returns on hover at the left edge or via
  // the title-bar toggle.
  const COLLAPSE_AT = 140;

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      if (!resizeStart.current) return;
      const width = resizeStart.current.width + event.clientX - resizeStart.current.x;
      if (width < COLLAPSE_AT) {
        resizeStart.current = null;
        setResizing(false);
        setIsSidebarOpen(false);
        return;
      }
      // Names and rows stay fully rendered while resizing — truncation only
      // clips the text, so nothing vanishes before the collapse point.
      setSidebarWidth(Math.min(480, Math.max(180, width)));
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
  }, [resizing, setIsSidebarOpen]);

  // Keep a live copy of the width for the close/reopen effect below — that
  // effect must not re-run on every pixel of a resize drag, but needs the
  // most recent width when a collapse is asked for.
  useEffect(() => {
    widthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  /**
   * Exit / re-entry. When `closing` arrives the sidebar is still mounted
   * (AppContext holds it there via sidebarLeaving): glide width to zero and
   * fade out. A fast reopen glides back to the width it closed from. All
   * state changes happen on the next frame so the (re-enabled) transition
   * has a settled frame to glide from.
   */
  useEffect(() => {
    if (closing) {
      restoreWidth.current = widthRef.current;
      wasClosing.current = true;
      const raf = window.requestAnimationFrame(() => {
        setSidebarWidth(0);
        setFading(true);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    if (wasClosing.current) {
      // Reopened mid-exit (a fast toggle): glide back to the closed-from
      // width instead of snapping, again from the next frame.
      wasClosing.current = false;
      const raf = window.requestAnimationFrame(() => {
        setSidebarWidth(restoreWidth.current);
        setFading(false);
      });
      return () => window.cancelAnimationFrame(raf);
    }
    wasClosing.current = false;
  }, [closing]);

  /**
   * One conversation. The delete button removes it from the core's store as
   * well as the list, so it is confirmed first — a transcript is the record of
   * what was asked and answered, and §12 keeps it precisely so it cannot be
   * lost by accident.
   */
  const sessionRow = (sess: Session, before?: () => void) => (
    <div
      key={sess.id}
      className={`group flex h-9 w-full items-stretch rounded-[10px] text-[13.5px] transition ${
        activeSessionId === sess.id
          ? 'bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)]'
          : 'text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]'
      }`}
    >
      {/* The action button stretches across the row's full height — clicking
          anywhere in the highlighted band opens the chat, not just the text. */}
      <button
        onClick={() => {
          before?.();
          openSession(sess.id);
        }}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 px-3 text-left"
        title={`${sess.title}\n${new Date(sess.updatedAt).toLocaleString()}`}
      >
        {/* A turn in flight in this chat. Several can run at once, so the
            spinner is per chat — it says which conversations are generating,
            not just that something somewhere is. */}
        {runningSessionIds.includes(sess.id) && (
          <Loader2 size={13} className="animate-spin flex-shrink-0 text-[var(--success)]" />
        )}
        <span className="block truncate">{sess.title}</span>
      </button>
      <button
        onClick={() => {
          setDeletingChat(sess);
        }}
        aria-label={`Delete chat ${sess.title}`}
        className="mr-2 flex-shrink-0 cursor-pointer self-center rounded p-1 text-[var(--muted-foreground)] opacity-0 transition hover:text-[var(--destructive)] group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
        title="Delete this chat"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );

  const saveProjectState = (workspace: Workspace, patch: Partial<Pick<Workspace, 'pinned' | 'archived'>>) => {
    void updateWorkspace(workspace.id, {
      name: workspace.name,
      folders: workspace.folders,
      pinned: patch.pinned ?? workspace.pinned,
      archived: patch.archived ?? workspace.archived,
    });
  };

  const clearHoverTimers = () => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (hoverHideTimer.current !== null) {
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
  };

  const cancelHoverPreview = () => {
    clearHoverTimers();
    setHoverPreview(null);
  };

  const keepHoverPreview = () => {
    if (hoverHideTimer.current !== null) {
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  };

  const scheduleHoverHide = (delay = 250) => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    if (hoverHideTimer.current !== null) window.clearTimeout(hoverHideTimer.current);
    hoverHideTimer.current = window.setTimeout(() => {
      setHoverPreview(null);
      hoverHideTimer.current = null;
    }, delay);
  };

  const scheduleHoverPreview = (workspace: Workspace, anchor: HTMLElement) => {
    // Moving from the row toward the card crosses a small gap — don't let the
    // pending hide win while the cursor is on its way over.
    if (hoverHideTimer.current !== null) {
      window.clearTimeout(hoverHideTimer.current);
      hoverHideTimer.current = null;
    }
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    const rect = anchor.getBoundingClientRect();
    const x = rect.right + 6;
    const y = Math.max(8, rect.top - 8);
    // When a card is already open, switching rows follows instantly so the
    // card tracks the cursor instead of flickering out and back in.
    if (hoverPreview) {
      setHoverPreview({ workspace, x, y });
      return;
    }
    // ChatGPT shows the project card after a short hover dwell, not instantly.
    hoverTimer.current = window.setTimeout(() => {
      setHoverPreview({ workspace, x, y });
      hoverTimer.current = null;
    }, 350);
  };

  // A pending show/hide must never fire after unmount.
  useEffect(
    () => () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
      if (hoverHideTimer.current !== null) window.clearTimeout(hoverHideTimer.current);
    },
    [],
  );

  const workspaceRow = (ws: Workspace) => {
    const wsSessions = sessions.filter((session) => session.workspaceId === ws.id);
    const { shown: shownSessions, remaining: remainingChats } = pagedChats(ws.id, wsSessions);
    const open = isExpanded(ws.id);
    const isActive = activeWorkspaceId === ws.id;
    // Like the reference, only the open chat carries the highlight — the
    // project row itself stays unselected while one of its chats is open.
    // With nothing open, clicking the project still selects it.
    const activeChatInProject =
      activeSessionId !== null &&
      sessions.some((s) => s.id === activeSessionId && s.workspaceId === ws.id);
    const selected = isActive && !activeChatInProject;
    const FolderIcon = open ? FolderOpen : Folder;
    return (
      <div key={ws.id}>
        <div
          onMouseEnter={(event) => scheduleHoverPreview(ws, event.currentTarget as HTMLElement)}
          onMouseLeave={() => scheduleHoverHide(250)}
          className={`group/project flex h-9 w-full items-stretch rounded-[10px] text-[13.5px] font-normal leading-5 transition ${
            selected
              ? 'bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)]'
              : 'text-[var(--sidebar-foreground)] hover:bg-[var(--sidebar-accent)]'
          }`}
        >
          {/* Full-height action: any click in the highlighted band toggles the
              project, not just the one on its name. */}
          <button
            onClick={() => {
              cancelHoverPreview();
              toggle(ws.id);
              setActiveWorkspaceId(ws.id);
            }}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-3 text-left"
          >
            <FolderIcon size={16} strokeWidth={1.8} className="flex-shrink-0 text-[var(--muted-foreground)]" />
            <span className="flex-1 truncate">{ws.name}</span>
            {ws.pinned && <Pin size={11} className="flex-shrink-0 text-[var(--muted-foreground)]" />}
          </button>
          {!ws.approved && (
            <button onClick={() => void approveWorkspace(ws.id)} className="flex-shrink-0 cursor-pointer self-center px-1 text-[var(--warning)]" title="Approve project folders">
              <ShieldAlert size={13} />
            </button>
          )}
          <div className="mr-1.5 flex flex-shrink-0 items-center opacity-0 transition group-hover/project:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100">
            <button
              onClick={(event) => {
                cancelHoverPreview();
                const rect = event.currentTarget.getBoundingClientRect();
                setProjectMenu({ workspace: ws, x: rect.right + 6, y: rect.top });
              }}
              aria-label={`Project actions for ${ws.name}`}
              className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] focus-visible:opacity-100"
              title="Project actions"
            >
              <MoreHorizontal size={14} />
            </button>
            <button
              onClick={() => {
                cancelHoverPreview();
                setActiveWorkspaceId(ws.id);
                newSession('project', ws.id);
              }}
              aria-label={`New chat in ${ws.name}`}
              className="rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)] focus-visible:opacity-100"
              title={`New chat in ${ws.name}`}
            >
              <SquarePen size={13} />
            </button>
          </div>
        </div>

        {open && !ws.archived && (
          <div className="mt-0.5 space-y-0.5 pl-5">
            {shownSessions.map((session) => sessionRow(session, () => setActiveWorkspaceId(ws.id)))}
            {showMoreButton(ws.id, remainingChats)}
          </div>
        )}
      </div>
    );
  };

  // Normal chats that live in no project: started with no folder open, or
  // left behind when their folder was removed. They sit under their own
  // label at the bottom, below the projects.
  const ungroupedChats = [...personalChats, ...detachedChats];
  const chatsPaged = pagedChats('__chats__', ungroupedChats);

  return (
    <>
    <aside
      className={`relative flex h-full min-h-0 flex-shrink-0 select-none flex-col bg-[var(--sidebar)] text-[13.5px] text-[var(--sidebar-foreground)] ${
        fading || sidebarWidth < 180 ? 'overflow-hidden' : ''
      } ${fading ? 'pointer-events-none' : ''}`}
      style={{
        width: sidebarWidth,
        // No easing while the mouse drags the edge — that would lag behind
        // the cursor. Idle, the transition is what lets a collapse (width to
        // zero) and a collapse-to-zero reopen glide instead of snapping.
        opacity: fading ? 0 : 1,
        transition: resizing ? 'none' : sidebarSizeTransition,
      }}
    >
      {!floating && (
      <div
        role="separator"
        aria-label="Resize left sidebar"
        aria-orientation="vertical"
        onPointerDown={beginResize}
        onDoubleClick={() => setSidebarWidth(260)}
        className="group/split absolute -right-1 bottom-0 top-0 z-[80] w-2 cursor-col-resize touch-none"
        title="Drag left or right to resize"
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
      {/* Header */}
      <div className="flex h-[52px] flex-shrink-0 items-center justify-between px-3">
        <span
          className="min-w-0 truncate px-1 py-1 text-[18px] font-semibold tracking-[-0.01em] text-[var(--foreground)]"
          title="ZeroLeak AI"
        >
          ZeroLeak AI
        </span>

        <div className="flex flex-shrink-0 items-center">
          <button
            onClick={() => setIsSearchOpen(true)}
            className="rounded-lg p-2 text-[var(--muted-foreground)] transition hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)]"
            title="Search chats (Ctrl+K)"
          >
            <Search size={17} />
          </button>
        </div>
      </div>

      {/* New chat — the one prominent block in the sidebar header. Filled
          with the sidebar's own primary pair (--sidebar-primary), not the
          page-level --primary: page primary is white in the zero dark theme,
          while the sidebar tokens are what the reference uses on this
          surface. */}
      <div className="flex-shrink-0 px-2">
        <button
          onClick={() => newSession('personal')}
          className="flex h-9 w-full items-center gap-2.5 rounded-[10px] px-3 text-left text-[13.5px] font-medium shadow-sm transition hover:brightness-110 bg-[var(--sidebar-primary)] text-[var(--sidebar-primary-foreground)]"
          title="New chat (Ctrl+N)"
        >
          <SquarePen size={16} strokeWidth={2} className="flex-shrink-0" />
          <span className="truncate">New chat</span>
        </button>
      </div>

      <div className="mt-2 flex-1 space-y-5 overflow-y-auto px-2 pb-3">
        {/* Projects on top — folders with their chats, under the same style
            of heading the personal "Chats" list carries below. */}
        {visibleProjects.length > 0 && (
          <div>
            <div className="px-3 pb-1 text-[13px] text-[var(--muted-foreground)]">
              Projects
            </div>
            <div className="space-y-0.5">
              {visibleProjects.map(workspaceRow)}
            </div>
          </div>
        )}

        {archivedProjects.length > 0 && (
          <div>
            <button
              onClick={() => setShowArchived((current) => !current)}
              className="flex w-full items-center gap-1.5 rounded-[10px] px-3 py-1.5 text-[13px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
            >
              {showArchived ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Archived projects ({archivedProjects.length})
            </button>
            {showArchived && <div className="mt-0.5 space-y-0.5">{archivedProjects.map(workspaceRow)}</div>}
          </div>
        )}

        {/*
          Normal chats that belong to no project: started before a folder was
          opened, or left behind when one was removed. Without this list they
          would be stored, replayable, and invisible.
        */}
        {ungroupedChats.length > 0 && (
          <div>
            <div className="px-3 pb-1 text-[13px] text-[var(--muted-foreground)]">
              Chats
            </div>
            <div className="space-y-0.5">
              {chatsPaged.shown.map((sess) =>
                personalChats.some((personal) => personal.id === sess.id)
                  ? sessionRow(sess, () => setActiveWorkspaceId(null))
                  : sessionRow(sess),
              )}
              {showMoreButton('__chats__', chatsPaged.remaining)}
            </div>
          </div>
        )}
      </div>

      {/* Profile row and settings stay anchored above the global status bar.
          The profile is a label only — clicking it does nothing. Only the
          gear opens Settings. */}
      <div className="h-14 border-t nerve-border p-2 bg-[var(--card)] flex-shrink-0">
        <div className="flex h-full w-full items-center gap-2.5 px-2">
          <span className="w-7 h-7 rounded-full bg-[var(--accent)] border nerve-border flex items-center justify-center text-[var(--sidebar-foreground)] flex-shrink-0">
            <UserRound size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-[var(--sidebar-foreground)] truncate">Local profile</span>
            <span className="block text-[10px] text-[var(--muted-foreground)] truncate">
              {activeWorkspaceId ? 'Project workspace' : 'On this device'}
            </span>
          </span>
          <button
            onClick={() => openSettings('workbench')}
            aria-label="Open settings"
            title="Open settings (Ctrl+,)"
            className="grid size-8 flex-shrink-0 place-items-center rounded-lg text-[var(--muted-foreground)] transition hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)]"
          >
            <Settings size={15} />
          </button>
        </div>
      </div>
    </aside>
    {hoverPreview && !projectMenu && (() => {
      const fresh = workspaces.find((w) => w.id === hoverPreview.workspace.id) ?? hoverPreview.workspace;
      const ws = fresh;
      const taskCount = sessions.filter((session) => session.workspaceId === ws.id).length;
      return (
        <div
          onMouseEnter={keepHoverPreview}
          onMouseLeave={() => scheduleHoverHide(150)}
          className="animate-popover fixed z-[255] w-[320px] rounded-2xl border border-[var(--border)] bg-[var(--popover)] p-2 shadow-2xl"
          style={{
            left: Math.min(hoverPreview.x, window.innerWidth - 336),
            top: Math.min(hoverPreview.y, window.innerHeight - 240),
          }}
          role="dialog"
          aria-label={`Project details for ${ws.name}`}
        >
          <div className="flex items-center gap-2.5 px-3 pb-1.5 pt-2">
            <Folder size={16} strokeWidth={1.8} className="flex-shrink-0 text-[var(--muted-foreground)]" />
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium leading-5 text-[var(--foreground)]">
              {ws.name}
            </span>
            <button
              onClick={() => saveProjectState(ws, { pinned: !ws.pinned })}
              className="flex-shrink-0 rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
              title={ws.pinned ? 'Unpin project' : 'Pin project'}
            >
              {ws.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            </button>
          </div>
          <div className="flex items-center gap-2.5 px-3 py-1.5 text-[13px] leading-5 text-[var(--muted-foreground)]">
            <MessageCircle size={15} className="flex-shrink-0" />
            <span>
              {taskCount} {taskCount === 1 ? 'task' : 'tasks'}
            </span>
          </div>
          <div className="my-1 border-t border-[var(--border)]" />
          <button
            onClick={() => {
              void openWorkspaceInExplorer(ws.id);
            }}
            className="flex w-full items-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2 text-left transition hover:brightness-110"
            title={`Open ${ws.path} in File Manager`}
          >
            <Folder size={15} className="flex-shrink-0 text-[var(--muted-foreground)]" />
            <span
              className="min-w-0 flex-1 truncate text-[12px] leading-5 text-[var(--foreground)]"
              title={ws.path}
            >
              {ws.path}
            </span>
            <ArrowUpRight size={14} className="flex-shrink-0 text-[var(--muted-foreground)]" />
          </button>
          <div className="my-1 border-t border-[var(--border)]" />
          <button
            onClick={() => {
              cancelHoverPreview();
              setEditingProject(ws);
            }}
            className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] leading-5 text-[var(--foreground)] transition hover:bg-[var(--accent)]"
          >
            <Settings size={15} className="flex-shrink-0 text-[var(--muted-foreground)]" />
            Edit project
          </button>
        </div>
      );
    })()}
    {projectMenu && (
      <>
        <button className="fixed inset-0 z-[250] cursor-default" onClick={() => setProjectMenu(null)} aria-label="Close project menu" />
        <div
          className="fixed z-[260] w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] p-1.5 shadow-2xl"
          style={{ left: Math.min(projectMenu.x, window.innerWidth - 220), top: Math.min(projectMenu.y, window.innerHeight - 280) }}
        >
          <button onClick={() => { setActiveWorkspaceId(projectMenu.workspace.id); newSession('project', projectMenu.workspace.id); setProjectMenu(null); }} className="project-menu-item"><Plus size={14} />New project chat</button>
          <button onClick={() => { saveProjectState(projectMenu.workspace, { pinned: !projectMenu.workspace.pinned }); setProjectMenu(null); }} className="project-menu-item">
            {projectMenu.workspace.pinned ? <PinOff size={14} /> : <Pin size={14} />}
            {projectMenu.workspace.pinned ? 'Unpin' : 'Pin'}
          </button>
          <button onClick={() => { setEditingProject(projectMenu.workspace); setProjectMenu(null); }} className="project-menu-item"><Edit3 size={14} />Edit project</button>
          <button onClick={() => { void openWorkspaceInExplorer(projectMenu.workspace.id); setProjectMenu(null); }} className="project-menu-item"><FolderOpen size={14} />Open in Explorer</button>
          <div className="my-1 border-t border-[var(--border)]" />
          <button onClick={() => { saveProjectState(projectMenu.workspace, { archived: !projectMenu.workspace.archived }); if (projectMenu.workspace.id === activeWorkspaceId) setActiveWorkspaceId(null); setProjectMenu(null); }} className="project-menu-item">
            <Archive size={14} />{projectMenu.workspace.archived ? 'Unarchive project' : 'Archive project'}
          </button>
          <button onClick={() => { setDeletingProject(projectMenu.workspace); setProjectMenu(null); }} className="project-menu-item !text-[var(--destructive)]"><Trash2 size={14} />Delete project…</button>
        </div>
      </>
    )}
    {editingProject && (
      <EditProjectDialog
        workspace={editingProject}
        onClose={() => setEditingProject(null)}
        onDelete={() => { setDeletingProject(editingProject); setEditingProject(null); }}
      />
    )}
    {deletingProject && (
      <DeleteProjectDialog
        workspace={deletingProject}
        sessions={sessions}
        blocked={sessions.some((session) => session.workspaceId === deletingProject.id && runningSessionIds.includes(session.id))}
        onClose={() => setDeletingProject(null)}
        onDeleted={() => setDeletingProject(null)}
      />
    )}
    {deletingChat && (
      <DeleteChatDialog
        session={deletingChat}
        blocked={runningSessionIds.includes(deletingChat.id)}
        onClose={() => setDeletingChat(null)}
      />
    )}
    </>
  );
};

/** Small shared close button used by panel headers. */
export const CloseButton: React.FC<{ onClick: () => void; title?: string }> = ({
  onClick,
  title = 'Close',
}) => (
  <button
    onClick={onClick}
    className="p-1 rounded hover:bg-[var(--accent)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
    title={title}
  >
    <X size={13} />
  </button>
);
