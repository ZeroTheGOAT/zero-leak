import React, { useState } from 'react';
import { Check, ChevronDown, ChevronRight, ListChecks, Loader2, MinusCircle } from 'lucide-react';
import { useApp } from '../../context/AppContext';

/**
 * The run's task list, docked above the composer — never a timeline entry.
 *
 * One checklist per agent turn, updated in place: `agent://plan` carries the
 * whole list each revision and the core keeps item ids stable, so rows
 * re-render where they stand instead of stacking a second copy whenever
 * commentary or actions interleave. Collapsing only hides the rows; the list
 * itself is context state, so it survives collapse and task switches intact.
 *
 * While a run is live it shows the run's own plan; idle, the last agent
 * message's plan stays up so a finished run's checklist is still reviewable.
 */
export const TaskDock: React.FC = () => {
  const { livePlan, isRunning, activeSessionId } = useApp();
  const [open, setOpen] = useState(false);

  if (!activeSessionId || livePlan.length === 0) return null;

  const done = livePlan.filter((i) => i.status === 'completed').length;
  const allDone = done === livePlan.length;

  return (
    <div className="flex-shrink-0 max-w-3xl w-full mx-auto px-4">
      <div className="border border-[var(--border)] rounded-lg bg-[var(--sidebar)] overflow-hidden">
        <button
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--accent)] transition"
        >
          <span className="flex items-center space-x-2 text-[11px] text-[var(--muted-foreground)]">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <ListChecks size={12} />
            <span>Tasks</span>
            <span className="tabular-nums">
              {done}/{livePlan.length}
            </span>
            {isRunning && !allDone && (
              <Loader2 size={12} className="animate-spin text-[var(--info)]" />
            )}
            {allDone && <Check size={12} className="text-[var(--success)]" />}
          </span>
          <span className="text-[10px] text-[var(--muted-foreground)]">
            {allDone ? 'all done' : `${livePlan.length - done} remaining`}
          </span>
        </button>
        {/* Collapse animates the height; the rows themselves are never
            unmounted state — only hidden — so nothing is lost while closed. */}
        <div
          className={`grid transition-[grid-template-rows] duration-200 ease-out ${
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          }`}
        >
          <div className="overflow-hidden">
            <div className="px-3 pb-2 space-y-1">
              {livePlan.map((item, i) => (
                <div
                  key={item.id || `item-${i}`}
                  className="w-full flex items-start space-x-2 py-0.5 text-left"
                >
                  <span className="w-4 flex-shrink-0 flex items-center justify-center mt-[3px]">
                    {item.status === 'in_progress' ? (
                      <Loader2 size={12} className="animate-spin text-[var(--info)]" />
                    ) : item.status === 'completed' ? (
                      <Check size={12} className="text-[var(--success)]" />
                    ) : (
                      <MinusCircle size={12} className="text-[var(--muted-foreground)]" />
                    )}
                  </span>
                  <span
                    className={`flex-1 min-w-0 text-xs ${
                      item.status === 'completed'
                        ? 'text-[var(--muted-foreground)] line-through'
                        : item.status === 'in_progress'
                          ? 'text-[var(--foreground)]'
                          : 'text-[var(--muted-foreground)]'
                    }`}
                  >
                    {item.step}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
