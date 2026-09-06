import React, { useEffect, useRef, useState } from 'react';
import { HelpCircle, CornerDownLeft } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { OperatorQuestion } from '../../types';

/**
 * §9 — a mid-run question the model itself asked (`ask_operator`).
 *
 * The run is blocked on a channel until a reply is delivered, exactly like a
 * permission prompt, but the reply is free text: the model asks when it does
 * not understand the task, or needs a decision no risk table can make. Escape
 * does nothing — there is no safe default answer to someone else's question;
 * the operator either types one or cancels the run.
 */
export const QuestionPrompt: React.FC = () => {
  const { pendingQuestion } = useApp();
  if (!pendingQuestion) return null;
  // A new question remounts the inner form, so the box starts empty and
  // focused without a reset effect.
  return <QuestionForm key={pendingQuestion.id} question={pendingQuestion} />;
};

const QuestionForm: React.FC<{ question: OperatorQuestion }> = ({ question: q }) => {
  const { answerQuestion } = useApp();
  const [answer, setAnswer] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  const submit = () => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    void answerQuestion(trimmed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter makes a new line, as in the composer.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4 backdrop-blur-sm"
      style={{ background: 'color-mix(in oklab, var(--background) 72%, transparent)' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-question-title"
        aria-describedby="agent-question-text"
        onKeyDown={(e) => {
          if (e.key === 'Tab') {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
              'button, textarea, [href], input, select, [tabindex]:not([tabindex="-1"])',
            );
            const first = controls?.[0];
            const last = controls?.[controls.length - 1];
            if (!first || !last) return;
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
        className="w-full max-w-lg overflow-hidden rounded-xl border nerve-border bg-[var(--popover)] text-[var(--popover-foreground)] shadow-[shadow:var(--shadow-lg)] animate-popover"
      >
        {/* Header */}
        <div className="px-4 py-3 border-b flex items-start space-x-3 text-[var(--primary)] border-[var(--border)] bg-[var(--muted)]">
          <HelpCircle size={18} className="flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h2 id="agent-question-title" className="text-sm font-semibold text-[var(--popover-foreground)]">
              The agent is asking you
            </h2>
            <p className="text-[11px] mt-0.5">The run is paused until you answer</p>
          </div>
        </div>

        <div className="px-4 py-3 space-y-3">
          <p
            id="agent-question-text"
            className="text-xs leading-relaxed text-[var(--popover-foreground)] whitespace-pre-wrap"
          >
            {q.question}
          </p>

          {q.context && (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md border nerve-border bg-[var(--muted)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
              {q.context}
            </pre>
          )}

          <div>
            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={onKeyDown}
              rows={3}
              autoFocus
              aria-label="Your answer to the agent's question"
              className="w-full resize-none rounded-md border nerve-border bg-[var(--background)] p-2.5 text-xs leading-relaxed text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]"
              placeholder="Type your answer — the agent will continue from it"
            />
            <p className="mt-1 flex items-center space-x-1 text-[10px] text-[var(--muted-foreground)]">
              <CornerDownLeft size={11} />
              <span>Enter sends · Shift+Enter for a new line</span>
            </p>
          </div>
        </div>

        {/* Reply */}
        <div className="flex items-center justify-end space-x-2 border-t nerve-border bg-[var(--card)] px-4 py-3">
          <button
            onClick={submit}
            disabled={!answer.trim()}
            aria-label="Send your answer to the agent"
            className="rounded-md px-3 py-1.5 text-xs font-medium zeroleak-primary transition hover:brightness-105 disabled:opacity-40 disabled:pointer-events-none"
          >
            Send answer
          </button>
        </div>
      </div>
    </div>
  );
};
