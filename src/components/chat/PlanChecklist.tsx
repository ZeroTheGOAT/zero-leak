import React from 'react';
import { Check, Loader2, MinusCircle } from 'lucide-react';
import type { PlanItem } from '../../types';

/**
 * The Codex-style live plan: what the model said it would do, kept current by
 * its own `update_plan` calls. One block per run; the latest event replaces
 * the whole list, so this renders items and nothing else — there is no partial
 * state to reconcile.
 *
 * Styling follows AgentTimeline's step rows exactly (12px icons, xs text,
 * theme tokens only) so the plan reads as the first row of the timeline
 * rather than a new UI element.
 */
export const PlanChecklist: React.FC<{ items: PlanItem[] }> = ({ items }) => {
  if (items.length === 0) return null;

  const done = items.filter((i) => i.status === 'completed').length;

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--sidebar)] overflow-hidden">
      <div className="flex items-center space-x-2 px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
        <span>Plan</span>
        <span className="tabular-nums">
          {done}/{items.length}
        </span>
      </div>
      <div className="px-3 pb-2 space-y-1">
        {items.map((item, i) => (
          <div key={item.id || `item-${i}`} className="w-full flex items-start space-x-2 py-0.5 text-left">
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
  );
};
