import React, { useEffect, useRef, useState } from 'react';
import { Folder, FolderPlus, Lightbulb, Loader2, Trash2, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';

const folderName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

export const CreateProjectModal: React.FC = () => {
  const {
    isCreateProjectOpen,
    setIsCreateProjectOpen,
    pickProjectSource,
    createWorkspace,
    harnessInfo,
  } = useApp();
  const [name, setName] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  /** Operator-chosen folder this project lives in. `null` means the app-owned
   *  projects root — the previous behaviour, still the default. */
  const [location, setLocation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (!isCreateProjectOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setIsCreateProjectOpen(false);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [busy, isCreateProjectOpen, setIsCreateProjectOpen]);

  if (!isCreateProjectOpen) return null;

  const addSource = async () => {
    const path = await pickProjectSource();
    if (path) setSources((prev) => (prev.includes(path) ? prev : [...prev, path]));
  };

  const chooseLocation = async () => {
    const path = await pickProjectSource();
    if (path) setLocation(path);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    const created = await createWorkspace(name.trim(), sources, location ?? undefined);
    if (!created) setBusy(false);
  };

  return (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) setIsCreateProjectOpen(false);
      }}
    >
      <form
        onSubmit={(event) => void submit(event)}
        className="w-full max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--popover)] shadow-2xl overflow-hidden"
        aria-label="Create project"
      >
        <div className="px-5 pt-5 pb-3 flex items-center justify-between">
          <h2 className="text-[22px] font-semibold text-[var(--foreground)]">Create project</h2>
          <button
            type="button"
            onClick={() => setIsCreateProjectOpen(false)}
            disabled={busy}
            className="p-1.5 rounded-lg text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition disabled:opacity-40"
            title="Close"
          >
            <X size={17} />
          </button>
        </div>

        <div className="px-5 pb-5 space-y-4">
          <label className="block">
            <span className="block text-[12px] font-medium text-[var(--foreground)] mb-1.5">
              Project name
            </span>
            <span className="h-12 px-3 rounded-xl border border-[var(--border)] bg-[var(--background)] flex items-center gap-2.5 focus-within:border-[var(--primary)]">
              <Folder size={16} className="text-[var(--muted-foreground)] flex-shrink-0" />
              <input
                data-inset-field
                ref={inputRef}
                value={name}
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                className="flex-1 min-w-0 bg-transparent text-[14px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none select-text"
              />
            </span>
          </label>

          <div>
            <span className="block text-[12px] font-medium text-[var(--foreground)] mb-1.5">
              Source folders <span className="font-normal text-[var(--muted-foreground)]">(optional)</span>
            </span>
            {sources.length > 0 && (
              <div className="mb-2 space-y-1.5">
                {sources.map((path) => (
                  <div
                    key={path}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--background)]"
                  >
                    <Folder size={13} className="text-[var(--warning)] flex-shrink-0" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-[11.5px] text-[var(--foreground)] truncate">
                        {folderName(path)}
                      </span>
                      <span className="block text-[9.5px] text-[var(--muted-foreground)] truncate" title={path}>
                        {path}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setSources((prev) => prev.filter((item) => item !== path))}
                      className="p-1 rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)] hover:bg-[var(--destructive-soft)] transition"
                      title="Remove source folder"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => void addSource()}
              disabled={busy}
              className="w-full min-h-28 rounded-xl border border-dashed border-[var(--border)] bg-[var(--background)] flex flex-col items-center justify-center gap-2 text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--primary-ring)] hover:bg-[var(--accent)] transition disabled:opacity-40"
            >
              <FolderPlus size={22} />
              <span className="text-[12px]">Add folders to copy into this project</span>
            </button>
          </div>

          <div>
            <span className="block text-[12px] font-medium text-[var(--foreground)] mb-1.5">
              Project location <span className="font-normal text-[var(--muted-foreground)]">(optional)</span>
            </span>
            <button
              type="button"
              onClick={() => void chooseLocation()}
              disabled={busy}
              className="w-full h-12 px-3 rounded-xl border border-[var(--border)] bg-[var(--background)] flex items-center gap-2.5 text-left hover:border-[var(--primary)] transition disabled:opacity-40"
            >
              <Folder size={16} className="text-[var(--muted-foreground)] flex-shrink-0" />
              <span className="flex-1 min-w-0">
                {location ? (
                  <span className="block text-[12.5px] text-[var(--foreground)] font-mono truncate" title={location}>
                    {location}
                  </span>
                ) : (
                  <span className="block text-[12.5px] text-[var(--muted-foreground)]">
                    Default — a new folder under the projects directory
                  </span>
                )}
              </span>
              {location && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(event) => {
                    event.stopPropagation();
                    setLocation(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.stopPropagation();
                      setLocation(null);
                    }
                  }}
                  className="p-1 rounded text-[var(--muted-foreground)] hover:text-[var(--destructive)] hover:bg-[var(--destructive-soft)] transition"
                  title="Back to the default projects directory"
                >
                  <Trash2 size={12} />
                </span>
              )}
            </button>
          </div>

          <div className="rounded-xl bg-[var(--accent)] px-3.5 py-3 flex items-start gap-3">
            <Lightbulb size={17} className="text-[var(--muted-foreground)] mt-0.5 flex-shrink-0" />
            <p className="text-[11.5px] leading-relaxed text-[var(--muted-foreground)]">
              {location ? (
                <>
                  The project is rooted at{' '}
                  <span className="font-mono text-[var(--foreground)]">{location}</span> — every
                  file the agent writes, command it runs, and dev server it starts stays inside
                  that folder.
                </>
              ) : (
                <>
                  The project gets its own folder under{' '}
                  <span className="font-mono text-[var(--foreground)]">
                    {harnessInfo?.projectsRoot ?? 'the projects directory'}
                  </span>
                  . Source folders are copied into it, and generated project files stay in that
                  project. Choose a location above to root it somewhere you picked instead.
                </>
              )}
            </p>
          </div>

          <div className="flex justify-end pt-1">
            <button
              type="submit"
              disabled={!name.trim() || busy}
              className="min-w-32 h-10 px-4 rounded-xl servergen-primary text-[12px] font-medium flex items-center justify-center gap-2 transition disabled:opacity-35 disabled:cursor-not-allowed"
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              <span>{busy ? 'Creating…' : 'Create project'}</span>
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
