import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Edit3,
  FolderOpen,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  ShieldAlert,
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

export const Sidebar: React.FC = () => {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
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
    coreStatus,
  } = useApp();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sidebarWidth, setSidebarWidth] = useState(256);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);
  const [editingProject, setEditingProject] = useState<Workspace | null>(null);
  const [deletingProject, setDeletingProject] = useState<Workspace | null>(null);
  const [deletingChat, setDeletingChat] = useState<Session | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ workspace: Workspace; x: number; y: number } | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const isExpanded = (id: string) => expanded[id] ?? id === activeWorkspaceId;

  const personalChats = sessions.filter((s) => !s.workspaceId);
  const detachedChats = sessions.filter(
    (s) => s.workspaceId && !workspaces.some((w) => w.id === s.workspaceId),
  );
  const projectOrder = (left: Workspace, right: Workspace) =>
    Number(right.pinned) - Number(left.pinned) || left.addedAt - right.addedAt;
  const visibleProjects = workspaces.filter((workspace) => !workspace.archived).sort(projectOrder);
  const archivedProjects = workspaces.filter((workspace) => workspace.archived).sort(projectOrder);

  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !isExpanded(id) }));

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width: sidebarWidth };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      if (!resizeStart.current) return;
      const width = resizeStart.current.width + event.clientX - resizeStart.current.x;
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
  }, [resizing]);

  /**
   * One conversation. The delete button removes it from the core's store as
   * well as the list, so it is confirmed first — a transcript is the record of
   * what was asked and answered, and §12 keeps it precisely so it cannot be
   * lost by accident.
   */
  const sessionRow = (sess: Session, before?: () => void) => (
    <div
      key={sess.id}
      className={`w-full flex items-center rounded-md text-xs transition group ${
        activeSessionId === sess.id
          ? 'bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] font-medium shadow-sm'
          : 'text-[var(--muted-foreground)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)]'
      }`}
    >
      <button
        onClick={() => {
          before?.();
          openSession(sess.id);
        }}
        className="flex-1 min-w-0 text-left px-2 py-1.5 flex items-center gap-1.5"
        title={`${sess.title}\n${new Date(sess.updatedAt).toLocaleString()}`}
      >
        {/* A turn in flight in this chat. Several can run at once, so the
            spinner is per chat — it says which conversations are generating,
            not just that something somewhere is. */}
        {runningSessionIds.includes(sess.id) && (
          <Loader2 size={10} className="animate-spin flex-shrink-0 text-[var(--success)]" />
        )}
        <span className="truncate block">{sess.title}</span>
      </button>
      <button
        onClick={() => {
          setDeletingChat(sess);
        }}
        className="flex-shrink-0 mr-1.5 p-0.5 rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)] opacity-0 group-hover:opacity-100 transition"
        title="Delete this chat"
      >
        <Trash2 size={11} />
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

  const workspaceRow = (ws: Workspace) => {
    const wsSessions = sessions.filter((session) => session.workspaceId === ws.id);
    const open = isExpanded(ws.id);
    const isActive = activeWorkspaceId === ws.id;
    return (
      <div key={ws.id} className="space-y-0.5">
        <div
          className={`w-full flex items-center space-x-1.5 px-2 py-1.5 rounded-md transition text-xs group/project ${
            isActive && !activeSessionId
              ? 'bg-[var(--sidebar-accent)] text-[var(--sidebar-accent-foreground)] font-medium'
              : 'hover:bg-[var(--sidebar-accent)] text-[var(--sidebar-foreground)]'
          }`}
        >
          <button
            onClick={() => {
              toggle(ws.id);
              setActiveWorkspaceId(ws.id);
            }}
            className="flex items-center space-x-2 flex-1 min-w-0 text-left"
            title={`${ws.name}\n${ws.folders.length} project ${ws.folders.length === 1 ? 'folder' : 'folders'}\n${ws.path}`}
          >
            <FolderOpen size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />
            <span className="truncate flex-1 font-medium">{ws.name}</span>
            {ws.pinned && <Pin size={10} className="text-[var(--muted-foreground)]" />}
            {open ? <ChevronDown size={12} className="text-[var(--muted-foreground)]" /> : <ChevronRight size={12} className="text-[var(--muted-foreground)]" />}
          </button>
          {!ws.approved && (
            <button onClick={() => void approveWorkspace(ws.id)} className="flex-shrink-0 text-[var(--warning)]" title="Approve project folders">
              <ShieldAlert size={12} />
            </button>
          )}
          <button
            onClick={() => setEditingProject(ws)}
            className="flex-shrink-0 text-[var(--muted-foreground)] opacity-0 transition hover:text-[var(--foreground)] group-hover/project:opacity-100"
            title="Edit project"
          >
            <Edit3 size={12} />
          </button>
          <button
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setProjectMenu({ workspace: ws, x: rect.right + 6, y: rect.top });
            }}
            className="flex-shrink-0 text-[var(--muted-foreground)] opacity-0 transition hover:text-[var(--foreground)] group-hover/project:opacity-100"
            title="Project actions"
          >
            <MoreHorizontal size={13} />
          </button>
        </div>

        {open && !ws.archived && (
          <div className="pl-4 pr-1 space-y-0.5">
            <button
              onClick={() => {
                setActiveWorkspaceId(ws.id);
                newSession('project', ws.id);
              }}
              className="w-full text-left px-2 py-1 rounded-md text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)] transition flex items-center space-x-1.5"
            >
              <Plus size={10} />
              <span>New project chat</span>
            </button>
            {wsSessions.map((session) => sessionRow(session, () => setActiveWorkspaceId(ws.id)))}
          </div>
        )}
      </div>
    );
  };

  const navItem = (
    icon: React.ReactNode,
    label: string,
    onClick: () => void,
    badge?: string,
  ) => (
    <button
      onClick={onClick}
      className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-md hover:bg-[var(--sidebar-accent)] transition group text-left"
    >
      <div className="flex items-center space-x-2.5">
        <span className="text-[var(--muted-foreground)] group-hover:text-[var(--sidebar-foreground)]">{icon}</span>
        <span>{label}</span>
      </div>
      {badge && <span className="text-[10px] text-[var(--muted-foreground)] tabular-nums">{badge}</span>}
    </button>
  );

  return (
    <>
    <aside
      className="relative bg-[var(--sidebar)] border-r nerve-border flex flex-col h-full min-h-0 text-[var(--sidebar-foreground)] text-[13px] select-none flex-shrink-0"
      style={{ width: sidebarWidth }}
    >
      <div
        role="separator"
        aria-label="Resize left sidebar"
        aria-orientation="vertical"
        onPointerDown={beginResize}
        onDoubleClick={() => setSidebarWidth(256)}
        className={`absolute -right-1 top-0 bottom-0 z-[80] w-2 cursor-col-resize touch-none transition-colors ${
          resizing ? 'bg-[var(--primary-ring)]' : 'hover:bg-[var(--primary-ring)]'
        }`}
        title="Drag left or right to resize"
      />
      {/* Header */}
      <div className="h-11 px-3 flex items-center justify-between border-b nerve-border">
        <div className="flex items-center space-x-2 py-1 px-1.5 min-w-0">
          <span className="font-semibold text-sm text-[var(--foreground)] truncate">Servergen AI</span>
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              coreStatus.state === 'connected'
                ? 'bg-[var(--success)]'
                : coreStatus.state === 'core_only'
                  ? 'bg-[var(--warning)]'
                  : coreStatus.state === 'checking'
                    ? 'bg-[var(--muted-foreground)]'
                    : 'bg-[var(--destructive)]'
            }`}
            title={coreStatus.detail}
          />
        </div>

        <div className="flex items-center space-x-1 text-[var(--muted-foreground)]">
          <button
            onClick={() => setIsSearchOpen(true)}
            className="p-1.5 rounded hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)] transition"
            title="Search workspace (Ctrl+K)"
          >
            <Search size={15} />
          </button>
          <button
            onClick={() => newSession('personal')}
            className="p-1.5 rounded hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)] transition"
            title="New personal chat"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2 space-y-4">
        {/* Task creation stays here; application managers live in Settings. */}
        <div className="space-y-0.5 text-xs text-[var(--sidebar-foreground)]">
          {navItem(<MessageSquare size={14} />, 'New personal chat', () => newSession('personal'))}
        </div>

        {/* Workspaces (§8 — tools may only touch approved ones) */}
        <div className="space-y-2">
          <div className="flex items-center justify-between px-2.5 text-[11px] font-medium text-[var(--muted-foreground)]">
            <span>Projects</span>
            <button
              onClick={addWorkspace}
              className="hover:text-[var(--sidebar-foreground)] transition"
              title="Create project"
            >
              <Plus size={12} />
            </button>
          </div>

          {workspaces.length === 0 && (
            <p className="px-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
              No project yet. Create one here; its files stay together in the managed projects folder.
            </p>
          )}

          <div className="space-y-1">
            {visibleProjects.map(workspaceRow)}
          </div>

          {archivedProjects.length > 0 && (
            <div className="pt-1">
              <button
                onClick={() => setShowArchived((current) => !current)}
                className="flex w-full items-center gap-1.5 px-2.5 py-1 text-[10.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
              >
                {showArchived ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                Archived projects ({archivedProjects.length})
              </button>
              {showArchived && <div className="mt-1 space-y-1">{archivedProjects.map(workspaceRow)}</div>}
            </div>
          )}

          {/*
            Conversations that belong to no folder in the list: started before a
            folder was opened, or left behind when one was removed. Grouping the
            list by workspace would otherwise make them unreachable — stored,
            replayable, and invisible.
          */}
          {personalChats.length > 0 && (
            <div className="space-y-0.5 pt-1">
              <div className="px-2.5 text-[11px] font-medium text-[var(--muted-foreground)]">
                Personal chats
              </div>
              <div className="pl-4 pr-1 space-y-0.5">
                {personalChats.map((sess) => sessionRow(sess, () => setActiveWorkspaceId(null)))}
              </div>
            </div>
          )}

          {detachedChats.length > 0 && (
            <div className="space-y-0.5 pt-1">
              <div className="px-2.5 text-[11px] font-medium text-[var(--muted-foreground)]">
                Detached project chats
              </div>
              <div className="pl-4 pr-1 space-y-0.5">
                {detachedChats.map((sess) => sessionRow(sess))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Profile and settings stay anchored above the global status bar. */}
      <div className="h-14 border-t nerve-border p-2 bg-[var(--card)] flex-shrink-0">
        <button
          onClick={() => openSettings('workbench')}
          className="w-full h-full flex items-center gap-2.5 px-2 rounded-lg hover:bg-[var(--sidebar-accent)] transition text-left group"
          title="Open profile settings"
        >
          <span className="w-7 h-7 rounded-full bg-[var(--accent)] border nerve-border flex items-center justify-center text-[var(--sidebar-foreground)] flex-shrink-0">
            <UserRound size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-medium text-[var(--sidebar-foreground)] truncate">Local profile</span>
            <span className="block text-[10px] text-[var(--muted-foreground)] truncate">
              {activeWorkspaceId ? 'Project workspace' : 'On this device'}
            </span>
          </span>
          <Settings size={14} className="text-[var(--muted-foreground)] group-hover:text-[var(--sidebar-foreground)] flex-shrink-0" />
        </button>
      </div>
    </aside>
    {projectMenu && (
      <>
        <button className="fixed inset-0 z-[250] cursor-default" onClick={() => setProjectMenu(null)} aria-label="Close project menu" />
        <div
          className="fixed z-[260] w-52 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--popover)] p-1.5 shadow-2xl"
          style={{ left: Math.min(projectMenu.x, window.innerWidth - 220), top: Math.min(projectMenu.y, window.innerHeight - 240) }}
        >
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
