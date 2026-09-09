import React, { useState } from 'react';
import {
  AlertCircle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Download,
  Eye,
  FileEdit,
  FilePlus,
  FileOutput,
  FileSearch,
  FileText,
  Library,
  ListChecks,
  Loader2,
  MinusCircle,
  ScanText,
  Server,
  ShieldQuestion,
  SquareTerminal,
  Terminal,
  BadgeCheck,
  GitFork,
} from 'lucide-react';
import type { AgentStep, ChatActivityBlock, StepKind } from '../../types';
import { formatDuration, modelById } from '../../services/registry';

const STEP_ICON: Record<StepKind, React.ElementType> = {
  planning: ListChecks,
  selecting_model: Cpu,
  loading_model: Download,
  reading_file: FileText,
  searching_files: FileSearch,
  searching_knowledge: Library,
  ocr: ScanText,
  vision: Eye,
  running_python: SquareTerminal,
  running_command: Terminal,
  starting_server: Server,
  editing_file: FileEdit,
  writing_file: FilePlus,
  generating_artifact: FileOutput,
  verifying: BadgeCheck,
  awaiting_approval: ShieldQuestion,
  subagent: GitFork,
  error: AlertCircle,
};

/* ------------------------------------------------------------------ */
/* Group labels — ChatGPT style: "Read files, ran commands, ..."      */
/* ------------------------------------------------------------------ */

const GROUP_PHRASE: Record<StepKind, string> = {
  planning: 'Planned',
  selecting_model: 'Selected model',
  loading_model: 'Loaded model',
  reading_file: 'Read files',
  searching_files: 'Searched files',
  searching_knowledge: 'Searched knowledge',
  ocr: 'Ran OCR',
  vision: 'Looked at images',
  running_python: 'Ran commands',
  running_command: 'Ran commands',
  starting_server: 'Started server',
  editing_file: 'Edited files',
  writing_file: 'Wrote files',
  generating_artifact: 'Generated files',
  verifying: 'Verified',
  awaiting_approval: 'Waited for approval',
  subagent: 'Coordinated agents',
  error: 'Errors',
};

const describeSteps = (steps: AgentStep[]): string => {
  const seen: string[] = [];
  for (const s of steps) {
    const phrase = GROUP_PHRASE[s.kind] ?? 'Worked';
    if (!seen.includes(phrase)) seen.push(phrase);
    if (seen.length >= 3) break;
  }
  if (seen.length === 0) return 'Worked';
  return seen.join(', ');
};

const groupDuration = (steps: AgentStep[]): number =>
  steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);

/* ------------------------------------------------------------------ */
/* Leaf: one tool call                                                */
/* ------------------------------------------------------------------ */

const StepRow: React.FC<{ step: AgentStep }> = ({ step }) => {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICON[step.kind] ?? ListChecks;
  const model = modelById(step.modelId);
  const hasDetail = true;
  const command = step.kind === 'running_command' || step.kind === 'running_python';

  const tone =
    step.status === 'failed'
      ? 'text-[var(--destructive)]'
      : step.status === 'running'
        ? 'text-[var(--info)]'
        : 'text-[var(--muted-foreground)]';

  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen(!open)}
        aria-expanded={open}
        className={`w-full flex items-start space-x-2 py-1 text-left group ${
          hasDetail ? 'cursor-pointer' : 'cursor-default'
        }`}
      >
        <span className="w-4 flex-shrink-0 flex items-center justify-center mt-[3px]">
          {step.status === 'running' ? (
            <Loader2 size={12} className="animate-spin text-[var(--info)]" />
          ) : step.status === 'done' ? (
            <Check size={12} className="text-[var(--success)]" />
          ) : step.status === 'failed' ? (
            <AlertCircle size={12} className="text-[var(--destructive)]" />
          ) : (
            <MinusCircle size={12} className="text-[var(--muted-foreground)]" />
          )}
        </span>
        <Icon size={12} className={`flex-shrink-0 mt-[3px] ${tone}`} />
        <span className="flex-1 min-w-0">
          <span className={`text-xs ${tone} ${step.status === 'skipped' ? 'line-through' : ''}`}>
            {command ? (step.status === 'running' ? 'Running command' : step.status === 'done' ? 'Ran command' : 'Command attempt') : step.title}
          </span>
          {step.modelId && (
            <span className="ml-2 text-[10px] text-[var(--muted-foreground)]">{model?.displayName ?? step.modelId}</span>
          )}
          {step.durationMs !== undefined && step.status !== 'running' && (
            <span className="ml-2 text-[10px] text-[var(--muted-foreground)] tabular-nums">
              · {formatDuration(step.durationMs)}
            </span>
          )}
        </span>
        {hasDetail && (
          <span className="text-[var(--muted-foreground)] flex-shrink-0 mt-[2px]">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-[26px] mb-1.5 pl-2.5 border-l border-[var(--border)] space-y-1.5">
          <p className="text-[11px] text-[var(--muted-foreground)]">Status: {step.status}</p>
          {(step.detail || step.title) && (
            <p className="max-h-80 overflow-auto break-words text-[12px] text-[var(--muted-foreground)] leading-relaxed whitespace-pre-wrap font-mono">
              {step.detail || step.title}
            </p>
          )}
          {step.error && (
            <p className="text-[11px] text-[var(--destructive)] leading-relaxed whitespace-pre-wrap font-mono">
              {step.error}
            </p>
          )}
          {step.citations?.map((c, i) => (
            <div key={i} className="text-[11px]">
              <span className="text-[var(--muted-foreground)]">
                {c.fileName}
                {c.page !== undefined ? ` · p.${c.page}` : ''}
                <span className="ml-1.5 tabular-nums">{c.score.toFixed(3)}</span>
              </span>
              <p className="leading-relaxed">{c.snippet}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Mid level: one collapsible action group                            */
/* e.g. "Read files, ran commands, searched the web"                  */
/* ------------------------------------------------------------------ */

const ActionGroup: React.FC<{ steps: AgentStep[]; defaultOpen?: boolean }> = ({
  steps,
}) => {
  const hasRunning = steps.some((s) => s.status === 'running');
  // Manual override wins; otherwise auto-open running groups. No effect needed,
  // so no cascading render — the open state derives from props until touched.
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? false;

  const label = hasRunning ? (steps.find((s) => s.status === 'running')?.kind === 'running_command' || steps.find((s) => s.status === 'running')?.kind === 'running_python' ? 'Running commands' : steps.find((s) => s.status === 'running')!.title) : describeSteps(steps);
  const total = groupDuration(steps);
  const failed = steps.filter((s) => s.status === 'failed').length;
  const FirstIcon = STEP_ICON[steps[0]?.kind] ?? ListChecks;

  return (
    <div>
      <button
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        title={steps.map((s) => s.title).join('\n')}
        className="w-full flex items-center gap-2 py-1 text-left group hover:bg-[var(--accent)] rounded-md px-1 -mx-1 transition"
      >
        {open ? (
          <ChevronDown size={12} className="flex-shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0 text-[var(--muted-foreground)]" />
        )}
        <FirstIcon size={12} className="flex-shrink-0 text-[var(--muted-foreground)]" />
        <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
          {label}
          <span className="ml-2 tabular-nums text-[10px]">
            · {steps.length} {steps.length === 1 ? 'action' : 'actions'}
            {total > 0 && <span> · {formatDuration(total)}</span>}
            {failed > 0 && <span className="text-[var(--destructive)]"> · {failed} failed</span>}
          </span>
        </span>
        {hasRunning && <Loader2 size={12} className="animate-spin text-[var(--info)] flex-shrink-0" />}
      </button>
      {open && (
        <div className="ml-[18px] pl-2.5 border-l border-[var(--border)] mt-0.5 mb-1">
          {steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Thinking row inside the work card                                  */
/* ------------------------------------------------------------------ */

const ThinkingRow: React.FC<{
  text: string;
  live?: boolean;
  startedAt?: number;
  endedAt?: number;
}> = ({ text, live = false, startedAt, endedAt }) => {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;

  const lines = text.trim().split('\n').length;
  const words = text.trim().split(/\s+/).length;
  const size = `${lines} ${lines === 1 ? 'line' : 'lines'} · ${words} words`;
  const took =
    startedAt !== undefined && endedAt !== undefined && endedAt - startedAt >= 1
      ? endedAt - startedAt
      : undefined;

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={took !== undefined ? `${size} of reasoning` : size}
        className="w-full flex items-center gap-2 py-1 text-left group hover:bg-[var(--accent)] rounded-md px-1 -mx-1 transition"
      >
        {open ? (
          <ChevronDown size={12} className="flex-shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight size={12} className="flex-shrink-0 text-[var(--muted-foreground)]" />
        )}
        <Brain size={12} className="flex-shrink-0 text-[var(--muted-foreground)]" />
        {live ? (
          <span className="flex items-center gap-1.5 text-[12px] text-[var(--muted-foreground)]">
            <span>Thinking</span>
            <Loader2 size={12} className="animate-spin text-[var(--info)]" />
          </span>
        ) : (
          <span className="text-[12px] text-[var(--muted-foreground)] tabular-nums">
            {took !== undefined ? `Thought for ${formatDuration(took)}` : `Thought · ${size}`}
          </span>
        )}
      </button>
      {open && (
        <div className="ml-[18px] pl-2.5 border-l border-[var(--border)] mt-0.5 mb-1">
          <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed whitespace-pre-wrap font-mono">
            {text}
          </p>
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Outer: single "Worked for Xs" card per run                         */
/*                                                                     */
/* ChatGPT pattern: one collapsed card holds the whole run. Expand it  */
/* to see commentary + mid-level groups, expand those to see individual */
/* tool calls. The final answer stays outside, below the card.         */
/* ------------------------------------------------------------------ */

export const WorkSummary: React.FC<{
  blocks: ChatActivityBlock[];
  live?: boolean;
  thinkingLive?: boolean;
}> = ({ blocks, live = false, thinkingLive = false }) => {
  // Outer starts open while running, collapsed once done — exactly like the
  // reference: "Worked for 28m 7s >" sits collapsed above the answer.
  // Manual toggle wins; otherwise derive from `live` so no effect is needed.
  const [manualCollapsed, setManualCollapsed] = useState<boolean | null>(null);
  const collapsed = manualCollapsed ?? !live;

  const workBlocks = blocks.filter(
    (b) =>
      b.type === 'actions' ||
      b.type === 'console' ||
      (b.type === 'text' && (b.kind === 'thinking' || b.kind === 'commentary')),
  );
  if (workBlocks.length === 0) return null;

  const allSteps = workBlocks.flatMap((b) => (b.type === 'actions' ? b.steps : []));
  const failed = allSteps.filter((s) => s.status === 'failed').length;

  const thinkingMs = workBlocks.reduce((acc, b) => {
    if (b.type === 'text' && b.kind === 'thinking' && b.startedAt !== undefined && b.endedAt !== undefined) {
      const span = b.endedAt - b.startedAt;
      return acc + (span >= 1 ? span : 0);
    }
    return acc;
  }, 0);
  const total = allSteps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0) + thinkingMs;

  const runningStep = allSteps.find((s) => s.status === 'running');
  const headline = thinkingLive ? 'Thinking' : runningStep?.kind === 'running_command' || runningStep?.kind === 'running_python' ? 'Running commands' : runningStep?.title ?? 'Working';
  const selection = [...allSteps].reverse().find((s) => s.kind === 'selecting_model');
  const actionCount = allSteps.length;

  const titles = allSteps.map((s) => s.title).join('\n');
  // Commentary divides meaningful batches. Thinking and internal bookkeeping
  // must not fragment a batch into a dozen single-action dropdowns.
  const timeline: ChatActivityBlock[] = [];
  const diagnostics: ChatActivityBlock[] = [];
  for (const block of workBlocks) {
    if (block.type === 'text' && block.kind === 'commentary') {
      timeline.push(block);
    } else if (block.type === 'actions') {
      const internal = block.steps.filter((s) => ['planning', 'selecting_model', 'loading_model'].includes(s.kind));
      const visible = block.steps.filter((s) => !['planning', 'selecting_model', 'loading_model'].includes(s.kind));
      if (internal.length) diagnostics.push({ ...block, steps: internal });
      if (visible.length) {
        const previous = timeline[timeline.length - 1];
        if (previous?.type === 'actions') previous.steps.push(...visible);
        else timeline.push({ ...block, steps: [...visible] });
      }
    } else diagnostics.push(block);
  }

  return (
    <div className="border-b border-[var(--border)] pb-2 overflow-hidden">
      <button
        onClick={() => setManualCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        title={titles}
        className="w-full flex items-center gap-2 py-2 hover:text-[var(--foreground)] transition"
      >
        <span className="flex items-center space-x-2 text-[14px] text-[var(--muted-foreground)] min-w-0">
          {live ? (
            <>
              <Loader2 size={12} className="animate-spin text-[var(--info)] flex-shrink-0" />
              <span className="truncate text-[var(--foreground)]">{headline}</span>
              {actionCount > 1 && (
                <span className="flex-shrink-0 tabular-nums">
                  · {actionCount - 1} more {actionCount - 1 === 1 ? 'action' : 'actions'}
                </span>
              )}
            </>
          ) : (
            <>
              <span className="truncate text-[var(--foreground)]">
                {total > 0 ? `Worked for ${formatDuration(total)}` : 'Worked'}
              </span>
              {actionCount > 0 && (
                <span className="flex-shrink-0 tabular-nums">
                  · {actionCount} {actionCount === 1 ? 'action' : 'actions'}
                </span>
              )}
              {failed > 0 && (
                <span className="flex-shrink-0 text-[var(--destructive)]">· {failed} failed</span>
              )}
            </>
          )}
        </span>
        {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
      </button>
      {selection && (
        <details className="text-[12px] text-[var(--muted-foreground)] mb-1">
          <summary className="cursor-pointer py-1">{selection.title}</summary>
          <p className="pl-3 py-1 whitespace-pre-wrap">{selection.detail ?? 'Selection reason was not recorded.'}</p>
        </details>
      )}

      {!collapsed && (
        <div className="px-3 pb-2.5 pt-1 space-y-1.5">
          {timeline.map((block) => {
            if (block.type === 'actions') {
              const hasRunning = block.steps.some((s) => s.status === 'running');
              const groups: AgentStep[][] = [];
              for (const step of block.steps) {
                const previous = groups[groups.length - 1];
                if (previous && GROUP_PHRASE[previous[0].kind] === GROUP_PHRASE[step.kind]) previous.push(step);
                else groups.push([step]);
              }
              return <React.Fragment key={block.id}>{groups.map((steps) => <ActionGroup key={steps[0].id} steps={steps} defaultOpen={hasRunning && steps.some((s) => s.status === 'running')} />)}</React.Fragment>;
            }
            if (block.type === 'console') {
              return (
                <pre
                  key={block.id}
                  className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--border)] bg-[var(--sidebar-accent)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]"
                >
                  {block.text}
                </pre>
              );
            }
            // text thinking / commentary — thinkingLive applies to the LAST
            // block only, same rule as before so only one spinner ever shows.
            return (
              <div
                key={block.id}
                className="py-3 text-[14px] leading-relaxed text-[var(--foreground)] whitespace-pre-wrap"
              >
                {block.text}
              </div>
            );
          })}
          {diagnostics.length > 0 && <details className="pt-2 text-[12px] text-[var(--muted-foreground)]">
            <summary className="cursor-pointer">Technical details · planning, model loading and thinking</summary>
            <div className="mt-2 space-y-2">
              {diagnostics.map((block) => block.type === 'actions'
                ? <ActionGroup key={block.id} steps={block.steps} />
                : block.type === 'text' ? <ThinkingRow key={block.id} text={block.text} startedAt={block.startedAt} endedAt={block.endedAt} />
                : <details key={block.id}><summary className="cursor-pointer">Console output</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{block.text}</pre></details>)}
            </div>
          </details>}
        </div>
      )}
    </div>
  );
};
