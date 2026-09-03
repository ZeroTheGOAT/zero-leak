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
    className={`relative h-5 w-9 rounded-full transition ${on ? 'bg-violet-600' : 'bg-[#2a2c35]'}`}
    title={label}
  >
    <span
      className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
        on ? 'translate-x-[18px]' : 'translate-x-0.5'
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
      <div className="px-3 py-2.5 border-b border-[#1a1b21] flex-shrink-0">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[12px] text-[#d4d4d8]">Harness memory</p>
            <p className="text-[10.5px] text-[#666975] leading-relaxed mt-0.5">
              Global recall follows you. Project recall stays with the selected workspace.
            </p>
          </div>
          <Brain size={17} className="text-violet-400 flex-shrink-0 mt-0.5" />
        </div>
        <p className="mt-2 text-[9.5px] font-mono text-[#555865] truncate" title={harnessInfo?.root}>
          {harnessInfo?.root ?? settings.memoryRoot}
        </p>
      </div>

      <div className="px-3 py-2 border-b border-[#1a1b21] flex-shrink-0 space-y-2">
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-[#101116] p-1">
          {(['memories', 'instructions'] as const).map((item) => (
            <button
              key={item}
              onClick={() => setSurface(item)}
              className={`rounded-md px-2 py-1.5 text-[11px] capitalize transition ${
                surface === item
                  ? 'bg-[#282b37] text-white shadow-sm'
                  : 'text-[#7f828d] hover:text-[#d4d4d8]'
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
                ? 'border-violet-500/40 bg-violet-500/10 text-violet-200'
                : 'border-[#262833] text-[#7f828d] hover:text-[#d4d4d8]'
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
                ? 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200'
                : 'border-[#262833] text-[#7f828d] hover:text-[#d4d4d8]'
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
          <div className="px-3 py-2 border-b border-[#1a1b21] flex-shrink-0 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] text-[#a8aab2]">Use this scope</p>
                <p className="text-[9.5px] text-[#595c67]">Injected into eligible chats</p>
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
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-[#232631] bg-[#111218] p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9.5px] text-[#777a85]">Use in chat</span>
                  <Switch
                    label="Use memories in this chat"
                    on={activeSession.useMemories}
                    onChange={(on) =>
                      void setSessionMemory(on, activeSession.contributeMemories)
                    }
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[9.5px] text-[#777a85]">Learn from chat</span>
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
              className="w-full flex items-center justify-center gap-1.5 rounded-md border border-[#2a2d38] bg-[#1a1c23] px-2 py-1.5 text-[10.5px] text-[#b8bac2] hover:bg-[#222530] hover:text-white transition"
            >
              <Plus size={11} /> Add {selectedScope} memory
            </button>

            {showForm && (
              <div className="space-y-1.5 rounded-lg border border-[#292c38] bg-[#111218] p-2">
                <input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Short title (optional)"
                  className="w-full rounded-md border border-[#292c38] bg-[#0d0e12] px-2 py-1.5 text-[11px] text-white outline-none focus:border-violet-500/50"
                />
                <textarea
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="A preference, instruction, decision, fact or concise summary"
                  rows={4}
                  className="w-full resize-none rounded-md border border-[#292c38] bg-[#0d0e12] px-2 py-1.5 text-[11px] leading-relaxed text-white outline-none focus:border-violet-500/50"
                />
                <div className="flex items-center justify-between gap-2">
                  <select
                    value={kind}
                    onChange={(event) => setKind(event.target.value as MemoryKind)}
                    className="rounded-md border border-[#292c38] bg-[#171820] px-2 py-1 text-[10px] text-[#b7b9c2] outline-none"
                  >
                    {KINDS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                  <button
                    onClick={() => void submit()}
                    disabled={!content.trim() || (selectedScope === 'project' && !activeWorkspace)}
                    className="rounded-md bg-violet-600 px-2.5 py-1 text-[10.5px] text-white hover:bg-violet-500 disabled:opacity-35 transition"
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
                <Brain size={22} className="mx-auto text-[#3d404b]" />
                <p className="mt-2 text-[11.5px] text-[#777a85]">No {selectedScope} memories yet.</p>
                <p className="mt-1 text-[10px] leading-relaxed text-[#565965]">
                  Add one here or start a message with “Remember{selectedScope === 'global' ? ' globally' : ' for this project'}:”.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#18191f]">
                {visible.map((memory) => (
                  <div key={memory.id} className={`px-3 py-2.5 group ${memory.enabled ? '' : 'opacity-50'}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-[11.5px] font-medium text-[#d7d8dd]">{memory.title}</p>
                        <p className="mt-0.5 text-[9.5px] uppercase tracking-wide text-[#666a76]">{memory.kind}</p>
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
                              ? 'text-red-400'
                              : 'text-[#555965] opacity-0 group-hover:opacity-100 hover:text-red-400'
                          }`}
                          title={confirmDelete === memory.id ? 'Click again to forget' : 'Forget memory'}
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[10.5px] leading-relaxed text-[#898c96]">{memory.content}</p>
                    {memory.sourceSessionId && (
                      <p className="mt-1.5 truncate font-mono text-[9px] text-[#50535e]">from {memory.sourceSessionId}</p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 p-3 gap-2">
          <div className="flex items-start gap-2 rounded-lg border border-[#262936] bg-[#111218] p-2.5">
            <FileText size={13} className="mt-0.5 flex-shrink-0 text-cyan-400" />
            <div className="min-w-0">
              <p className="text-[10.5px] text-[#aeb0b9]">
                {selectedScope === 'global' ? 'Global operator instructions' : `${activeWorkspace?.name ?? 'Project'} instructions`}
              </p>
              <p className="mt-0.5 truncate font-mono text-[9px] text-[#555965]" title={instructionDoc?.path}>
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
            className="min-h-0 flex-1 resize-none rounded-lg border border-[#272a35] bg-[#0e0f13] p-3 font-mono text-[10.5px] leading-relaxed text-[#d2d3d8] outline-none focus:border-cyan-500/40 disabled:opacity-35"
            spellCheck={false}
          />
          <button
            onClick={() => void save()}
            disabled={!instructionDoc || instructionDraft === instructionDoc.content}
            className="flex items-center justify-center gap-1.5 rounded-md bg-cyan-700 px-3 py-1.5 text-[10.5px] text-white hover:bg-cyan-600 disabled:opacity-35 transition"
          >
            {saved ? <Check size={11} /> : <Save size={11} />}
            {saved ? 'Saved' : 'Save instructions'}
          </button>
        </div>
      )}
    </div>
  );
};
