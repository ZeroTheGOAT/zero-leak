import { useEffect, useRef, useState } from 'react';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { useApp } from '../../context/AppContext';

const LEVELS = ['off', 'low', 'medium', 'high', 'max'] as const;
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function EffortPicker({ modelName }: { modelName: string }) {
  const { settings, updateSettings, isRunning } = useApp();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const slider = useRef<HTMLInputElement>(null);
  const effort = settings.extendedThinking ? settings.thinkingEffort ?? 'medium' : 'off';
  const index = LEVELS.indexOf(effort);

  useEffect(() => {
    if (!open) return;
    slider.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  async function choose(value: typeof LEVELS[number]) {
    setSaving(true);
    setError('');
    try {
      await updateSettings({ extendedThinking: value !== 'off', thinkingEffort: value === 'off' ? 'medium' : value });
    } catch {
      setError('Could not save effort. Try again.');
    } finally { setSaving(false); }
  }

  return <div ref={root} className="relative ml-auto flex min-w-0 items-center">
    <button ref={trigger} type="button" onClick={() => setOpen(!open)}
      className="composer-tab min-w-0 max-w-64" aria-haspopup="dialog" aria-expanded={open}
      title={`${modelName} · ${label(effort)} thinking effort`}>
      <span className="truncate">{modelName}</span>
      <span className="text-[var(--primary)]">{label(effort)}</span><ChevronDown size={12} />
    </button>
    {open && <div role="dialog" aria-label="Thinking effort"
      className="absolute bottom-full right-0 z-50 mb-2 w-80 max-w-[calc(100vw-2rem)] rounded-2xl border nerve-border bg-[var(--popover)] p-4 text-[var(--popover-foreground)] shadow-[shadow:var(--shadow-lg)] animate-popover">
      <div className="flex items-start justify-between gap-3">
        <span className="w-6 shrink-0" aria-hidden="true" />
        <div className="min-w-0 text-center"><div className="text-sm font-semibold text-[var(--primary)]">{label(effort)}</div>
          <div className="truncate text-xs text-[var(--muted-foreground)]" title={modelName}>{modelName}</div></div>
        <button type="button" aria-label="Reset effort to Medium" title="Reset to Medium"
          disabled={saving || isRunning} onClick={() => void choose('medium')}
          className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] disabled:opacity-40"><RotateCcw size={16} /></button>
      </div>
      <input ref={slider} type="range" min={0} max={4} step={1} value={index}
        aria-label="Thinking effort" aria-valuetext={label(effort)} disabled={saving || isRunning}
        onChange={(event) => void choose(LEVELS[Number(event.target.value)])}
        className="effort-slider mt-4 w-full" style={{ '--effort-fill': `calc(${index * 25}% + ${14 - index * 7}px)` } as React.CSSProperties} />
      <div className="mt-1 flex justify-between text-[10px] text-[var(--muted-foreground)]">
        {LEVELS.map(value => <button key={value} type="button" disabled={saving || isRunning}
          onClick={() => void choose(value)} aria-pressed={effort === value}
          className="rounded px-1 py-1 hover:bg-[var(--accent)] disabled:opacity-40">{label(value)}</button>)}
      </div>
      <p className="mt-2 text-[10px] text-[var(--muted-foreground)]">{isRunning ? 'Change effort after this run finishes.' : 'Higher effort gives compatible local models more thinking time.'}</p>
      {error && <p role="alert" className="mt-2 text-xs text-[var(--destructive)]">{error}</p>}
    </div>}
  </div>;
}
