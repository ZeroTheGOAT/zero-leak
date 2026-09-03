import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  MessageSquare,
  Plus,
  Search,
  Settings,
  ShieldAlert,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { Session } from '../../types';

export const Sidebar: React.FC = () => {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspaceId,
    addWorkspace,
    approveWorkspace,
    removeWorkspace,
    sessions,
    activeSessionId,
    openSession,
    newSession,
    deleteSession,
    setIsSearchOpen,
    openSettings,
    openTab,
    coreStatus,
  } = useApp();

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** The conversation whose delete button has been armed by a first click. */
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  /**
   * The workspace whose remove button has been armed by a first click.
   *
   * Removing a folder does not touch a file on disk, but getting it back means
   * the native picker and a fresh approval, and until that approval every tool
   * is blocked inside it. That is too much to lose to one stray click on an
   * icon that only appears on hover.
   */
  const [confirmWs, setConfirmWs] = useState<string | null>(null);

  const isExpanded = (id: string) => expanded[id] ?? id === activeWorkspaceId;

  const personalChats = sessions.filter((s) => !s.workspaceId);
  const detachedChats = sessions.filter(
    (s) => s.workspaceId && !workspaces.some((w) => w.id === s.workspaceId),
  );

  const toggle = (id: string) =>
    setExpanded((prev) => ({ ...prev, [id]: !isExpanded(id) }));

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
        className="flex-1 min-w-0 text-left px-2 py-1.5"
        title={`${sess.title}\n${new Date(sess.updatedAt).toLocaleString()}`}
      >
        <span className="truncate block">{sess.title}</span>
      </button>
      <button
        onClick={() => {
          if (confirmDelete === sess.id) {
            setConfirmDelete(null);
            void deleteSession(sess.id);
          } else {
            setConfirmDelete(sess.id);
          }
        }}
        onBlur={() => setConfirmDelete((cur) => (cur === sess.id ? null : cur))}
        className={`flex-shrink-0 mr-1.5 p-0.5 rounded transition ${
          confirmDelete === sess.id
            ? 'text-red-400 opacity-100'
            : 'text-[var(--muted-foreground)] hover:text-red-400 opacity-0 group-hover:opacity-100'
        }`}
        title={
          confirmDelete === sess.id
            ? 'Click again to delete this conversation for good'
            : 'Delete this conversation'
        }
      >
        <Trash2 size={11} />
      </button>
    </div>
  );

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
    <aside className="w-64 bg-[var(--sidebar)] border-r nerve-border flex flex-col h-full min-h-0 text-[var(--sidebar-foreground)] text-[13px] select-none flex-shrink-0">
      {/* Header */}
      <div className="h-11 px-3 flex items-center justify-between border-b nerve-border">
        <div className="flex items-center space-x-2 py-1 px-1.5 min-w-0">
          <span className="font-semibold text-sm text-[var(--foreground)] truncate">Servergen AI</span>
          <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
              coreStatus.state === 'connected'
                ? 'bg-emerald-500'
                : coreStatus.state === 'core_only'
                  ? 'bg-amber-500'
                  : coreStatus.state === 'checking'
                    ? 'bg-[var(--muted-foreground)]'
                    : 'bg-red-500'
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
            <span>Workspaces</span>
            <button
              onClick={() => void addWorkspace()}
              className="hover:text-[var(--sidebar-foreground)] transition"
              title="Add a folder"
            >
              <Plus size={12} />
            </button>
          </div>

          {workspaces.length === 0 && (
            <p className="px-2.5 text-[11px] leading-relaxed text-[var(--muted-foreground)]">
              No workspace yet. Tools only operate inside folders you add and approve here.
            </p>
          )}

          <div className="space-y-1">
            {workspaces.map((ws) => {
              const wsSessions = sessions.filter((s) => s.workspaceId === ws.id);
              const open = isExpanded(ws.id);
              const isActive = activeWorkspaceId === ws.id;

              return (
                <div key={ws.id} className="space-y-0.5">
                  <div
                    className={`w-full flex items-center space-x-1.5 px-2 py-1.5 rounded-md transition text-xs group ${
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
                      title={ws.path}
                    >
                      <FolderOpen size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />
                      <span className="truncate flex-1 font-medium">{ws.name}</span>
                      {open ? (
                        <ChevronDown size={12} className="text-[var(--muted-foreground)] flex-shrink-0" />
                      ) : (
                        <ChevronRight size={12} className="text-[var(--muted-foreground)] flex-shrink-0" />
                      )}
                    </button>
                    {!ws.approved && (
                      <button
                        onClick={() => void approveWorkspace(ws.id)}
                        className="flex-shrink-0 text-amber-500 hover:text-amber-300"
                        title="Not approved — tools are blocked here. Click to approve."
                      >
                        <ShieldAlert size={12} />
                      </button>
                    )}
                    <button
                      onClick={() => {
                        if (confirmWs === ws.id) {
                          setConfirmWs(null);
                          void removeWorkspace(ws.id);
                        } else {
                          setConfirmWs(ws.id);
                        }
                      }}
                      onBlur={() => setConfirmWs((cur) => (cur === ws.id ? null : cur))}
                      className={`flex-shrink-0 transition ${
                        confirmWs === ws.id
                          ? 'text-red-400 opacity-100'
                          : 'text-[var(--muted-foreground)] hover:text-red-400 opacity-0 group-hover:opacity-100'
                      }`}
                      title={
                        confirmWs === ws.id
                          ? 'Click again to remove this folder — its tasks are kept'
                          : 'Remove workspace'
                      }
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>

                  {open && (
                    <div className="pl-4 pr-1 space-y-0.5">
                      <div className="px-2 py-1 text-[10px] text-[var(--muted-foreground)] font-mono truncate" title={ws.path}>
                        {ws.path}
                      </div>
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
                      <button
                        onClick={() => {
                          setActiveWorkspaceId(ws.id);
                          openTab('files', 'Files');
                        }}
                        className="w-full text-left px-2 py-1 rounded-md text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--sidebar-accent)] hover:text-[var(--sidebar-foreground)] transition flex items-center justify-between"
                      >
                        <span>Browse files</span>
                        {ws.fileCount !== undefined && (
                          <span className="tabular-nums">{ws.fileCount}</span>
                        )}
                      </button>

                      {wsSessions.map((sess) =>
                        sessionRow(sess, () => setActiveWorkspaceId(ws.id)),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

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
