import React, { useMemo, useState } from 'react';
import {
  Brain,
  Check,
  FileText,
  Globe2,
  Plus,
  Save,
  Trash2,
  Workflow,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { MemoryKind, MemoryScope } from '../../types';

const KINDS: MemoryKind[] = ['preference', 'instruction', 'decision', 'fact', 'summary'];

const Switch: React.FC<{ on: boolean; onChange: (on: boolean) => void; label: string }> = ({
  on,
  onChange,
  label,
}) => (
  <button
    role="switch"
    aria-checked={on}
    aria-label={label}
    onClick={() => onChange(!on)}
    className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent p-0.5 shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-[var(--ring)] ${
      on ? 'bg-[var(--primary)]' : 'bg-[var(--input)]'
    }`}
    title={label}
  >
    <span
      className={`pointer-events-none block size-3 rounded-full transition-transform ${
        on
          ? 'translate-x-3 bg-[var(--background)] dark:bg-[var(--primary-foreground)]'
          : 'translate-x-0 bg-[var(--background)] dark:bg-[var(--foreground)]'
      }`}
    />
  </button>
);

export const MemoryView: React.FC = () => {
  const {
    activeWorkspace,
    activeSession,
    harnessInfo,
    memories,
    globalInstructions,
    projectInstructions,
    addMemory,
    updateMemory,
    removeMemory,
    saveInstructions,
    setSessionMemory,
    settings,
    updateSettings,
  } = useApp();

  const [surface, setSurface] = useState<'memories' | 'instructions'>('memories');
  const [scope, setScope] = useState<MemoryScope>('global');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('preference');
  const [showForm, setShowForm] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const selectedScope: MemoryScope = scope === 'project' && !activeWorkspace ? 'global' : scope;
  const instructionDoc = selectedScope === 'global' ? globalInstructions : projectInstructions;
  const instructionKey = `${selectedScope}:${activeWorkspace?.id ?? 'none'}`;
  const [instructionDrafts, setInstructionDrafts] = useState<Record<string, string>>({});
  const instructionDraft = instructionDrafts[instructionKey] ?? instructionDoc?.content ?? '';
  const setInstructionDraft = (value: string) =>
    setInstructionDrafts((current) => ({ ...current, [instructionKey]: value }));
  const [saved, setSaved] = useState(false);

  const visible = useMemo(
    () => memories.filter((memory) => memory.scope === selectedScope),
    [memories, selectedScope],
  );
  const projectCount = memories.filter((memory) => memory.scope === 'project').length;
  const globalCount = memories.filter((memory) => memory.scope === 'global').length;

  const submit = async () => {
    const body = content.trim();
    if (!body || (selectedScope === 'project' && !activeWorkspace)) return;
    await addMemory({
      scope: selectedScope,
      workspaceId: selectedScope === 'project' ? activeWorkspace?.id : undefined,
      title: title.trim() || body.split(/\r?\n/, 1)[0].slice(0, 80),
      content: body,
      kind,
      sourceSessionId: activeSession?.id,
    });
    setTitle('');
    setContent('');
    setShowForm(false);
  };

  const save = async () => {
    await saveInstructions(selectedScope, instructionDraft);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1400);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2.5 border-b border-[var(--muted)] flex-shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[12px] text-[var(--foreground)]">Harness memory</p>
            <p className="text-[10.5px] text-[var(--muted-foreground)] leading-relaxed mt-0.5">
              Global recall follows you. Project recall stays with the selected workspace.
            </p>
          </div>
          <Brain size={17} className="text-[var(--accent-2)] flex-shrink-0 mt-0.5" />
        </div>
        <p className="mt-2 text-[9.5px] font-mono text-[var(--muted-foreground)] truncate" title={harnessInfo?.root}>
          {harnessInfo?.root ?? settings.memoryRoot}
        </p>
      </div>

      <div className="px-3 py-2 border-b border-[var(--muted)] flex-shrink-0 space-y-2">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--sidebar-accent)] p-1">
          {(['memories', 'instructions'] as const).map((item) => (
            <button
              key={item}
              onClick={() => setSurface(item)}
              className={`rounded-md px-2 py-1.5 text-[11px] capitalize transition ${
                surface === item
                  ? 'bg-[var(--popover)] text-[var(--foreground)] shadow-sm'
                  : 'text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
              }`}
            >
              {item}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-1">
          <button
            onClick={() => setScope('global')}
            className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-[10.5px] transition ${
              selectedScope === 'global'
                ? 'border-[var(--accent-2-ring)] bg-[var(--accent-2-soft)] text-[var(--accent-2)]'
                : 'border-[var(--popover)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
          >
            <span className="flex items-center gap-1.5"><Globe2 size={11} /> Global</span>
            <span className="tabular-nums">{globalCount}</span>
          </button>
          <button
            onClick={() => activeWorkspace && setScope('project')}
            disabled={!activeWorkspace}
            className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-[10.5px] transition disabled:opacity-35 ${
              selectedScope === 'project'
                ? 'border-[var(--info-ring)] bg-[var(--info-soft)] text-[var(--info)]'
                : 'border-[var(--popover)] text-[var(--muted-foreground)] hover:text-[var(--foreground)]'
            }`}
            title={activeWorkspace?.path ?? 'Select a workspace to use project memory'}
          >
            <span className="flex items-center gap-1.5"><Workflow size={11} /> Project</span>
            <span className="tabular-nums">{projectCount}</span>
          </button>
        </div>
      </div>

      {surface === 'memories' ? (
        <>
          <div className="px-3 py-2 border-b border-[var(--muted)] flex-shrink-0 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] text-[var(--muted-foreground)]">Use this scope</p>
                <p className="text-[9.5px] text-[var(--muted-foreground)]">Injected into eligible chats</p>
              </div>
              <Switch
                label={`Use ${selectedScope} memories`}
                on={selectedScope === 'global' ? settings.useGlobalMemories : settings.useProjectMemories}
                onChange={(on) =>
                  void updateSettings(
                    selectedScope === 'global'
                      ? { useGlobalMemories: on }
                      : { useProjectMemories: on },
                  )
                }
              />
            </div>

            {activeSession && (
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--card)] bg-[var(--sidebar)] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9.5px] text-[var(--muted-foreground)]">Use in chat</span>
                  <Switch
                    label="Use memories in this chat"
                    on={activeSession.useMemories}
                    onChange={(on) =>
                      void setSessionMemory(on, activeSession.contributeMemories)
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9.5px] text-[var(--muted-foreground)]">Learn from chat</span>
                  <Switch
                    label="Let this chat contribute memories"
                    on={activeSession.contributeMemories}
                    onChange={(on) => void setSessionMemory(activeSession.useMemories, on)}
                  />
                </div>
              </div>
            )}

            <button
              onClick={() => setShowForm(!showForm)}
              className="w-full flex items-center justify-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--muted)] px-2 py-1.5 text-[10.5px] text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
            >
              <Plus size={11} /> Add {selectedScope} memory
            </button>

            {showForm && (
              <div className="space-y-1.5 rounded-lg border border-[var(--border)] bg-[var(--sidebar)] p-2">
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Short title (optional)"
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--sidebar-accent)] px-2 py-1.5 text-[11px] text-[var(--foreground)] outline-none focus:border-[var(--accent-2-ring)]"
                />
                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="A preference, instruction, decision, fact or concise summary"
                  rows={4}
                  className="w-full resize-none rounded-md border border-[var(--border)] bg-[var(--sidebar-accent)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--accent-2-ring)]"
                />
                <div className="flex items-center justify-between gap-2">
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as MemoryKind)}
                    className="rounded-md border border-[var(--border)] bg-[var(--accent)] px-2 py-1 text-[10px] text-[var(--muted-foreground)] outline-none"
                  >
                    {KINDS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                  <button
                    onClick={() => void submit()}
                    disabled={!content.trim() || (selectedScope === 'project' && !activeWorkspace)}
                    className="rounded-md bg-[var(--primary)] px-2.5 py-1 text-[10.5px] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-35 transition"
                  >
                    Remember
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {visible.length === 0 ? (
              <div className="p-5 text-center">
                <Brain size={22} className="mx-auto text-[var(--input)]" />
                <p className="mt-2 text-[11.5px] text-[var(--muted-foreground)]">No {selectedScope} memories yet.</p>
                <p className="mt-1 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
                  Add one here or start a message with “Remember{selectedScope === 'global' ? ' globally' : ' for this project'}:”.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[var(--accent)]">
                {visible.map((memory) => (
                  <div key={memory.id} className={`px-3 py-2.5 group ${memory.enabled ? '' : 'opacity-50'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[11.5px] font-medium text-[var(--foreground)]">{memory.title}</p>
                        <p className="mt-0.5 text-[9.5px] uppercase tracking-wide text-[var(--muted-foreground)]">{memory.kind}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Switch
                          label={memory.enabled ? 'Disable memory' : 'Enable memory'}
                          on={memory.enabled}
                          onChange={(enabled) => void updateMemory(memory.id, { enabled })}
                        />
                        <button
                          onClick={() => {
                            if (confirmDelete === memory.id) {
                              setConfirmDelete(null);
                              void removeMemory(memory.id);
                            } else setConfirmDelete(memory.id);
                          }}
                          onBlur={() => setConfirmDelete((id) => (id === memory.id ? null : id))}
                          className={`rounded p-1 transition ${
                            confirmDelete === memory.id
                              ? 'text-[var(--destructive)]'
                              : 'text-[var(--muted-foreground)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 hover:text-[var(--destructive)]'
                          }`}
                          title={confirmDelete === memory.id ? 'Click again to forget' : 'Forget memory'}
                          aria-label={confirmDelete === memory.id ? `Confirm forget memory ${memory.title}` : `Forget memory ${memory.title}`}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[10.5px] leading-relaxed text-[var(--muted-foreground)]">{memory.content}</p>
                    {memory.sourceSessionId && (
                      <p className="mt-1.5 truncate font-mono text-[9px] text-[var(--muted-foreground)]">from {memory.sourceSessionId}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
          <div className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--sidebar)] p-2.5">
            <FileText size={13} className="mt-0.5 flex-shrink-0 text-[var(--info)]" />
            <div className="min-w-0">
              <p className="text-[10.5px] text-[var(--muted-foreground)]">
                {selectedScope === 'global' ? 'Global operator instructions' : `${activeWorkspace?.name ?? 'Project'} instructions`}
              </p>
              <p className="mt-0.5 truncate font-mono text-[9px] text-[var(--muted-foreground)]" title={instructionDoc?.path}>
                {instructionDoc?.path ?? 'No project selected'}
              </p>
            </div>
          </div>
          <textarea
            value={instructionDraft}
            onChange={(event) => {
              setInstructionDraft(event.target.value);
              setSaved(false);
            }}
            disabled={selectedScope === 'project' && !activeWorkspace}
            className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--sidebar-accent)] p-3 font-mono text-[10.5px] leading-relaxed text-[var(--foreground)] outline-none focus:border-[var(--info-ring)] disabled:opacity-35"
            spellCheck={false}
          />
          <button
            onClick={() => void save()}
            disabled={!instructionDoc || instructionDraft === instructionDoc.content}
            className="flex items-center justify-center gap-1.5 rounded-md bg-[var(--primary)] px-3 py-1.5 text-[10.5px] text-[var(--primary-foreground)] hover:opacity-90 disabled:opacity-35 transition"
          >
            {saved ? <Check size={11} /> : <Save size={11} />}
            {saved ? 'Saved' : 'Save instructions'}
          </button>
        </div>
      )}
    </div>
  );
};
