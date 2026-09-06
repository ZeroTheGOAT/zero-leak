import React, { useEffect, useRef, useState } from 'react';
import { Check, Folder, FolderOpen, FolderX, Plus, Search } from 'lucide-react';
import { useApp } from '../../context/AppContext';

/**
 * ChatGPT-style project affordance for the composer.
 *
 * A personal chat (no project) is legitimate: plain questions send with
 * `workspaceId: null` and the core answers them. File work needs a folder,
 * so this control lets the operator attach the empty chat to a project —
 * or create one, or detach it again — before (or when) that work is asked
 * for.
 *
 * Names only, never folder paths: the button and every row show the project
 * name and nothing else.
 */
export const ProjectPicker: React.FC<{ align?: 'left' | 'right' }> = ({ align = 'left' }) => {
  const {
    workspaces,
    activeWorkspaceId,
    activeWorkspace,
    activeSessionId,
    sessions,
    setActiveWorkspaceId,
    setSessionWorkspace,
    setIsCreateProjectOpen,
  } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const toggle = () => {
    if (!open) setQuery('');
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    window.requestAnimationFrame(() => searchRef.current?.focus());
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open ]);

  const visible = workspaces
    .filter((w) => !w.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
  const filtered = query.trim()
    ? visible.filter((w) => w.name.toLowerCase().includes(query.trim().toLowerCase()))
    : visible;

  const choose = (workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    // Bind the empty chat to the project so the next turn carries it. The
    // core's `touch_session` persists the same binding on that first turn
    // (COALESCE), so no extra backend call is needed here.
    if (activeSessionId) {
      const session = sessions.find((s) => s.id === activeSessionId);
      if (session && !session.workspaceId) setSessionWorkspace(activeSessionId, workspaceId);
    }
    setOpen(false);
  };

  // The mirror of `choose`: back to a personal chat. Clearing the session
  // binding matters as much as the active scope — the core reads the former
  // on the next turn, so leaving it set would quietly keep the chat in the
  // project.
  const unchoose = () => {
    if (activeSessionId) setSessionWorkspace(activeSessionId, null);
    else setActiveWorkspaceId(null);
    setOpen(false);
  };

  const label = activeWorkspace ? activeWorkspace.name : 'Choose project';

  return (
    <div ref={wrapRef} className={`relative ${align === 'right' ? 'flex justify-end' : 'flex'}`}>
      <button
        type="button"
        onClick={toggle}
        data-state={open ? 'open' : 'closed'}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={activeWorkspace ? `Project: ${activeWorkspace.name} — click to switch` : 'Chat without a project — click to attach one'}
        className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition border ${
          activeWorkspace
            ? 'bg-[var(--accent)] border-[var(--border)] text-[var(--foreground)] hover:border-[var(--primary-ring)]'
            : 'border-dashed border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:border-[var(--primary-ring)] hover:bg-[var(--accent)]'
        }`}
      >
        {activeWorkspace ? <FolderOpen size={11} /> : <Folder size={11} />}
        <span className="max-w-40 truncate">{label}</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="Choose project"
          className="absolute top-full z-50 mt-2 w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border nerve-border bg-[var(--popover)] py-1 text-[var(--popover-foreground)] shadow-[shadow:var(--shadow-lg)] animate-popover left-0 origin-top-left"
        >
          <div className="px-2 pb-1 pt-1.5">
            <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-1.5">
              <Search size={12} className="text-[var(--muted-foreground)] flex-shrink-0" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search projects"
                aria-label="Search projects"
                data-inset-field
                className="w-full bg-transparent text-xs text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none select-text"
              />
            </div>
          </div>
          {/* Four rows at a time: rows are locked to h-8 (32px), so the
              8rem cap fits exactly four before the scroller kicks in. */}
          <div className="max-h-32 overflow-y-auto px-1 mb-1">
            {filtered.map((w) => {
              const selected = w.id === activeWorkspaceId;
              return (
                <button
                  key={w.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => choose(w.id)}
                  title={w.name}
                  className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-xs transition hover:bg-[var(--accent)] ${
                    selected ? 'bg-[var(--accent)]' : ''
                  }`}
                >
                  <Folder size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{w.name}</span>
                  {selected && <Check size={13} className="text-[var(--primary)] flex-shrink-0" />}
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="px-3 py-3 text-[11px] text-[var(--muted-foreground)]">
                {visible.length === 0 ? 'No projects yet.' : 'No project matches that search.'}
              </p>
            )}
          </div>
          <div className="menu-divider border-t border-[var(--border)] p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setIsCreateProjectOpen(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-[var(--foreground)] transition hover:bg-[var(--accent)]"
            >
              <Plus size={13} />
              <span>New project</span>
            </button>
            {/* Only offered while a project is attached — there is nothing
                to detach otherwise. */}
            {activeWorkspace && (
              <button
                type="button"
                onClick={unchoose}
                title="Detach the chat from the project"
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-xs text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
              >
                <FolderX size={13} className="flex-shrink-0" />
                <span>Don't work in a project</span>
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
