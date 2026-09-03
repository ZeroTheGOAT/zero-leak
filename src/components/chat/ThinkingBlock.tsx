import React, { useState } from 'react';
import { Brain, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { formatDuration } from '../../services/registry';

/**
 * The model's reasoning stream, shown only when Extended Thinking is enabled
 * in Settings — the core never emits `thinking` deltas otherwise.
 *
 * Collapsed by default and streaming-aware. While this block is the one being
 * thought into, the header says "Thinking" and carries the spinner; the moment
 * it is done it becomes "Thought for 4.2 s" and the run moves on to the next
 * block. Only one block is ever live — see `ActivityFlow`, which is what went
 * wrong before: every thinking block on the page spun at once, so a run read
 * as "Thinking" five times over with no sense of progress.
 *
 * Same row idioms and theme tokens as AgentTimeline so it reads as part of the
 * run, not a new panel.
 */
export const ThinkingBlock: React.FC<{
  text: string;
  live?: boolean;
  /** The span this reasoning occupied. See `ChatActivityBlock` for why it is
   *  measured from the end of the previous entry rather than the first delta. */
  startedAt?: number;
  endedAt?: number;
}> = ({ text, live = false, startedAt, endedAt }) => {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;

  const lines = text.trim().split('\n').length;
  const words = text.trim().split(/\s+/).length;
  const size = `${lines} ${lines === 1 ? 'line' : 'lines'} · ${words} words`;
  // Only claim a duration when one was actually measured. Blocks the frontend
  // synthesised rather than streamed carry no stamps, and a sub-millisecond
  // span is a clock artefact, not a thought — both fall back to the size.
  const took =
    startedAt !== undefined && endedAt !== undefined && endedAt - startedAt >= 1
      ? endedAt - startedAt
      : undefined;

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--sidebar)] overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={took !== undefined ? `${size} of reasoning` : size}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[var(--accent)] transition group"
      >
        <span className="flex items-center space-x-2 text-[11px] text-[var(--muted-foreground)]">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <Brain size={12} />
          {live ? (
            <>
              <span>Thinking</span>
              <Loader2 size={12} className="animate-spin text-[var(--info)]" />
            </>
          ) : (
            <span className="tabular-nums">
              {took !== undefined ? `Thought for ${formatDuration(took)}` : `Thought · ${size}`}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="px-3 pb-2">
          <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed whitespace-pre-wrap font-mono">
            {text}
          </p>
        </div>
      )}
    </div>
  );
};
