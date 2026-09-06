import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Folder,
  FolderPlus,
  Loader2,
  MessageSquare,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { Session, Workspace, WorkspaceFolder } from '../../types';

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;
const newFolderId = () =>
  `folder_${typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;

interface EditProjectDialogProps {
  workspace: Workspace;
  onClose: () => void;
  onDelete: () => void;
}

export const EditProjectDialog: React.FC<EditProjectDialogProps> = ({
  workspace,
  onClose,
  onDelete,
}) => {
  const { pickProjectSource, updateWorkspace } = useApp();
  const [name, setName] = useState(workspace.name);
  const [folders, setFolders] = useState<WorkspaceFolder[]>(workspace.folders);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [busy, onClose]);

  const addFolder = async () => {
    if (folders.length >= 5 || busy) return;
    const path = await pickProjectSource();
    if (!path || folders.some((folder) => folder.path.toLowerCase() === path.toLowerCase())) return;
    setFolders((current) => [
      ...current,
      { id: newFolderId(), path, isPrimary: current.length === 0 },
    ]);
  };

  const removeFolder = (id: string) => {
    setFolders((current) => {
      if (current.length === 1) return current;
      const removed = current.find((folder) => folder.id === id);
      const next = current.filter((folder) => folder.id !== id);
      return removed?.isPrimary
        ? next.map((folder, index) => ({ ...folder, isPrimary: index === 0 }))
        : next;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || folders.length === 0 || busy) return;
    setBusy(true);
    const saved = await updateWorkspace(workspace.id, {
      name: name.trim(),
      folders,
      pinned: workspace.pinned,
      archived: workspace.archived,
    });
    if (saved) onClose();
    else setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-[320] flex items-center justify-center bg-black/65 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--popover)] shadow-2xl"
        aria-label="Edit project"
      >
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="text-[22px] font-semibold text-[var(--foreground)]">Edit project</h2>
          <button type="button" onClick={onClose} disabled={busy} className="modal-icon-button" title="Close">
            <X size={17} />
          </button>
        </div>

        <div className="space-y-4 px-6 pb-5">
          <label className="h-12 px-3 rounded-xl border border-[var(--primary-ring)] bg-[var(--background)] flex items-center gap-2.5">
            <Folder size={16} className="text-[var(--muted-foreground)]" />
            <input
              ref={inputRef}
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--foreground)] outline-none select-text"
              aria-label="Project name"
            />
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-[var(--foreground)]">Project folders</span>
              <span className="text-[10.5px] text-[var(--muted-foreground)]">{folders.length} of 5</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--background)]">
              {folders.map((folder) => (
                <div
                  key={folder.id}
                  className="flex min-h-14 items-center gap-3 border-b border-[var(--border)] px-3 last:border-b-0"
                >
                  <Folder size={15} className={folder.isPrimary ? 'text-[var(--primary)]' : 'text-[var(--muted-foreground)]'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-[var(--foreground)]">{folderName(folder.path)}</span>
                    <span className="block truncate font-mono text-[9.5px] text-[var(--muted-foreground)]" title={folder.path}>
                      {folder.path}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setFolders((current) =>
                        current.map((item) => ({ ...item, isPrimary: item.id === folder.id })),
                      )
                    }
                    className={`flex h-7 items-center gap-1 rounded-md px-2 text-[10.5px] transition ${
                      folder.isPrimary
                        ? 'bg-[var(--primary-soft)] text-[var(--primary)]'
                        : 'text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]'
                    }`}
                    title={folder.isPrimary ? 'Primary folder' : 'Secondary folder — click to make primary'}
                  >
                    {folder.isPrimary ? <Check size={11} /> : <Star size={11} />}
                    {folder.isPrimary ? 'Primary' : 'Secondary · Make primary'}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeFolder(folder.id)}
                    disabled={folders.length === 1}
                    className="modal-icon-button hover:!text-[var(--destructive)] disabled:cursor-not-allowed disabled:opacity-25"
                    title={folders.length === 1 ? 'A project needs at least one folder' : 'Detach folder from project'}
                  >
                    <X size={14} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => void addFolder()}
                disabled={busy || folders.length >= 5}
                className="flex h-12 w-full items-center gap-2.5 px-3 text-[12px] text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:cursor-not-allowed disabled:opacity-35"
              >
                <FolderPlus size={16} />
                {folders.length >= 5 ? 'Five-folder limit reached' : 'Add folder'}
              </button>
            </div>
            <p className="mt-2 text-[10.5px] leading-relaxed text-[var(--muted-foreground)]">
              File tools start in the primary folder. Detaching a folder never deletes it from disk.
            </p>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="h-10 rounded-xl bg-[var(--destructive-soft)] px-4 text-[12px] text-[var(--destructive)] transition hover:brightness-110 disabled:opacity-40"
            >
              Delete project…
            </button>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} disabled={busy} className="h-10 px-4 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]">
                Cancel
              </button>
              <button
                type="submit"
                disabled={busy || !name.trim() || folders.length === 0}
                className="zeroleak-primary flex h-10 min-w-24 items-center justify-center gap-2 rounded-xl px-4 text-[12px] font-medium disabled:opacity-35"
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                Save
              </button>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
};

interface DeleteProjectDialogProps {
  workspace: Workspace;
  sessions: Session[];
  blocked?: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

export const DeleteProjectDialog: React.FC<DeleteProjectDialogProps> = ({
  workspace,
  sessions,
  blocked = false,
  onClose,
  onDeleted,
}) => {
  const { removeWorkspace } = useApp();
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const projectSessions = useMemo(
    () => sessions.filter((session) => session.workspaceId === workspace.id),
    [sessions, workspace.id],
  );

  const remove = async (detachSessionIds: string[]) => {
    if (blocked || busy) return;
    setBusy(true);
    const removed = await removeWorkspace(workspace.id, detachSessionIds);
    if (removed) onDeleted();
    else setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-[340] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--popover)] p-5 shadow-2xl" role="dialog" aria-modal="true" aria-label="Delete project">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[19px] font-semibold text-[var(--foreground)]">Delete “{workspace.name}”?</h2>
            <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--muted-foreground)]">
              Project files stay on disk. Chats not selected below are permanently deleted with their messages and project memory.
            </p>
          </div>
          <button onClick={onClose} disabled={busy} className="modal-icon-button" title="Close"><X size={16} /></button>
        </div>

        {projectSessions.length > 0 && (
          <div className="mt-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[12px] font-medium text-[var(--foreground)]">Detach chats to keep</span>
              <button
                onClick={() => setKeep((current) => current.size === projectSessions.length ? new Set() : new Set(projectSessions.map((session) => session.id)))}
                className="text-[10.5px] text-[var(--primary)] hover:underline"
              >
                {keep.size === projectSessions.length ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="max-h-52 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--background)]">
              {projectSessions.map((session) => (
                <label key={session.id} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-[var(--border)] px-3 last:border-b-0 hover:bg-[var(--accent)]">
                  <input
                    type="checkbox"
                    checked={keep.has(session.id)}
                    onChange={() => setKeep((current) => {
                      const next = new Set(current);
                      if (next.has(session.id)) next.delete(session.id);
                      else next.add(session.id);
                      return next;
                    })}
                    className="accent-[var(--primary)]"
                  />
                  <MessageSquare size={13} className="text-[var(--muted-foreground)]" />
                  <span className="min-w-0 flex-1 truncate text-[11.5px] text-[var(--foreground)]">{session.title}</span>
                  <span className="text-[9.5px] text-[var(--muted-foreground)]">{new Date(session.updatedAt).toLocaleDateString()}</span>
                </label>
              ))}
            </div>
            {keep.size > 0 && (
              <p className="mt-2 text-[10.5px] text-[var(--success)]">
                {keep.size} selected {keep.size === 1 ? 'chat will' : 'chats will'} remain under Personal chats.
              </p>
            )}
          </div>
        )}

        {blocked && (
          <p className="mt-4 rounded-lg bg-[var(--warning-soft)] px-3 py-2 text-[11px] text-[var(--warning)]">
            Finish or stop the running chat in this project before deleting it.
          </p>
        )}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-10 px-4 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]">Cancel</button>
          {keep.size > 0 && (
            <button
              onClick={() => void remove([...keep])}
              disabled={busy || blocked}
              className="h-10 rounded-xl border border-[var(--border)] px-4 text-[12px] text-[var(--foreground)] hover:bg-[var(--accent)] disabled:opacity-35"
            >
              Keep selected & delete project
            </button>
          )}
          <button
            onClick={() => void remove([])}
            disabled={busy || blocked}
            className="flex h-10 items-center gap-2 rounded-xl bg-[var(--destructive-solid)] px-4 text-[12px] font-medium text-[var(--destructive-solid-foreground)] transition hover:brightness-110 disabled:opacity-35"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            Delete project and chats
          </button>
        </div>
      </div>
    </div>
  );
};

export const DeleteChatDialog: React.FC<{
  session: Session;
  blocked?: boolean;
  onClose: () => void;
}> = ({ session, blocked = false, onClose }) => {
  const { deleteSession } = useApp();
  const [busy, setBusy] = useState(false);
  return (
    <div className="fixed inset-0 z-[340] flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--popover)] p-5 shadow-2xl" role="dialog" aria-modal="true" aria-label="Delete chat">
        <h2 className="text-[18px] font-semibold text-[var(--foreground)]">Delete this chat?</h2>
        <p className="mt-2 text-[11.5px] leading-relaxed text-[var(--muted-foreground)]">
          “{session.title}” and its complete message history will be permanently deleted.
        </p>
        {blocked && <p className="mt-3 text-[11px] text-[var(--warning)]">Stop the running response before deleting this chat.</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="h-9 px-3 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]">Cancel</button>
          <button
            onClick={() => {
              setBusy(true);
              void deleteSession(session.id).then(onClose);
            }}
            disabled={busy || blocked}
            className="flex h-9 items-center gap-2 rounded-lg bg-[var(--destructive-solid)] px-3 text-[12px] font-medium text-[var(--destructive-solid-foreground)] transition hover:brightness-110 disabled:opacity-35"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
            Delete chat
          </button>
        </div>
      </div>
    </div>
  );
};
