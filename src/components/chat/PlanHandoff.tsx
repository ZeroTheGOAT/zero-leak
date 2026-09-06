import React, { useState } from 'react';
import { ArrowRight, ListChecks } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { PlanItem } from '../../types';

/**
 * The plan-mode handoff.
 *
 * A Plan-mode turn that published a checklist ends with this card instead of
 * dead air: the operator approves the plan where they are already looking,
 * and approving does both halves of the switch — the mode changes and the
 * execution turn starts — so "I planned it, now do it" is one click rather
 * than a mode change the operator has to remember to make. Dismissal is
 * local and revocable: "Not now" only hides the card for this message, and
 * the mode tabs above the composer still work exactly as before.
 */
export const PlanHandoff: React.FC<{ items: PlanItem[] }> = ({ items }) => {
  const { send, setMode } = useApp();
  const [starting, setStarting] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const start = async () => {
    if (starting) return;
    setStarting(true);
    setMode('agent');
    // The override matters: `send` was created while the mode state was still
    // 'plan', and the plan above this card is in this chat's history — the
    // follow-up turn only needs to name it, not repeat it.
    await send(
      'Plan approved — you are now in Agent mode. Execute the plan you published, step by step: ' +
        'republish the checklist with update_plan if it is not already showing, then start the first ' +
        'step now and work through every step to the end. Write the files, run the commands, and finish ' +
        'each step before moving to the next. Anything you cannot do, say so plainly at the end.',
      [],
      undefined,
      'agent',
    );
    setStarting(false);
  };

  const openCount = items.filter((i) => i.status !== 'completed').length;

  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 rounded-xl border nerve-border bg-[var(--card)]">
      <div className="flex items-center gap-2.5 min-w-0">
        <ListChecks size={15} className="text-[var(--success)] flex-shrink-0" />
        <div className="min-w-0">
          <p className="text-[12.5px] text-[var(--foreground)]">Plan ready</p>
          <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed">
            Switch to Agent mode and start working through the {openCount}{' '}
            {openCount === 1 ? 'step' : 'steps'}?
          </p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={() => setDismissed(true)}
          className="rounded-md border nerve-border px-2.5 py-1.5 text-[11.5px] text-[var(--card-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]"
        >
          Not now
        </button>
        <button
          onClick={() => void start()}
          disabled={starting}
          className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[11.5px] font-medium zeroleak-primary transition hover:brightness-105 disabled:opacity-50"
        >
          {starting ? 'Starting…' : 'Start working'}
          <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
};
