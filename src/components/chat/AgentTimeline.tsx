import React, { useState } from 'react';
import {
  AlertCircle,
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
  Loader2,
  ListChecks,
  MinusCircle,
  ScanText,
  Server,
  ShieldQuestion,
  SquareTerminal,
  Terminal,
  BadgeCheck,
  GitFork,
} from 'lucide-react';
import type { AgentStep, StepKind } from '../../types';
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

const StepRow: React.FC<{ step: AgentStep }> = ({ step }) => {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICON[step.kind] ?? ListChecks;
  const model = modelById(step.modelId);
  const hasDetail = Boolean(step.detail || step.error || step.citations?.length);

  const tone =
    step.status === 'failed'
      ? 'text-[var(--destructive)]'
      : step.status === 'running'
        ? 'text-[var(--info)]'
        : step.status === 'skipped'
          ? 'text-[var(--muted-foreground)]'
          : 'text-[var(--muted-foreground)]';

  return (
    <div>
      <button
        onClick={() => hasDetail && setOpen(!open)}
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
            {step.title}
          </span>
          {model && (
            <span className="ml-2 text-[10px] text-[var(--muted-foreground)]">{model.displayName}</span>
          )}
          {step.durationMs !== undefined && step.status !== 'running' && (
            <span className="ml-2 text-[10px] text-[var(--muted-foreground)] tabular-nums">
              {formatDuration(step.durationMs)}
            </span>
          )}
        </span>

        {hasDetail && (
          <span className="text-[var(--muted-foreground)] group-hover:text-[var(--muted-foreground)] flex-shrink-0 mt-[2px]">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>

      {open && (
        <div className="ml-[26px] mb-1.5 pl-2.5 border-l border-[var(--border)] space-y-1.5">
          {step.detail && (
            <p className="text-[11px] text-[var(--muted-foreground)] leading-relaxed whitespace-pre-wrap font-mono">
              {step.detail}
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
                <span className="ml-1.5 tabular-nums text-[var(--muted-foreground)]">{c.score.toFixed(3)}</span>
              </span>
              <p className="text-[var(--muted-foreground)] leading-relaxed">{c.snippet}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * §6 — the run rendered as discrete, inspectable actions.
 *
 * This deliberately shows what the agent DID, not what it was thinking.
 * Hidden reasoning is never surfaced here; each row is a tool call, a model
 * selection, or a verification, with its own duration and result.
 */
export const AgentTimeline: React.FC<{ steps: AgentStep[]; live?: boolean }> = ({
  steps,
  live = false,
}) => {
  // Action details are supporting information. Keep them available without
  // making every answer begin with a large, open diagnostics panel.
  const [collapsed, setCollapsed] = useState(true);
  if (steps.length === 0) return null;

  const failed = steps.filter((s) => s.status === 'failed').length;
  const total = steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);

  // What this block is DOING, on the row the operator sees without opening
  // anything. `step.title` is the one-line summary the core writes for every
  // step and is never raw reasoning, so it is safe to surface collapsed —
  // and without it a run reads as "1 action · 17 ms" repeated down the page,
  // which says nothing about what is happening. While live that is whichever
  // step is running; afterwards it is the one the block ended on.
  const headline = steps.find((s) => s.status === 'running') ?? steps[steps.length - 1];
  const HeadIcon = STEP_ICON[headline.kind] ?? ListChecks;
  const rest = steps.length - 1;
  const headTone =
    headline.status === 'failed'
      ? 'text-[var(--destructive)]'
      : headline.status === 'running'
        ? 'text-[var(--info)]'
        : 'text-[var(--muted-foreground)]';

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--sidebar)] overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        aria-expanded={!collapsed}
        title={steps.map((s) => s.title).join('\n')}
        className="w-full flex items-center justify-between gap-2 px-3 py-2 hover:bg-[var(--accent)] transition"
      >
        <span className="flex items-center space-x-2 text-[11px] text-[var(--muted-foreground)] min-w-0">
          {collapsed ? (
            <ChevronRight size={12} className="flex-shrink-0" />
          ) : (
            <ChevronDown size={12} className="flex-shrink-0" />
          )}
          <HeadIcon size={12} className={`flex-shrink-0 ${headTone}`} />
          <span className="truncate text-[var(--foreground)]">{headline.title}</span>
          {rest > 0 && (
            <span className="flex-shrink-0 tabular-nums">
              · {rest} more {rest === 1 ? 'action' : 'actions'}
            </span>
          )}
          {failed > 0 && (
            <span className="flex-shrink-0 text-[var(--destructive)]">· {failed} failed</span>
          )}
          {!live && total > 0 && (
            <span className="flex-shrink-0 tabular-nums">· {formatDuration(total)}</span>
          )}
        </span>
        {live && <Loader2 size={12} className="animate-spin text-[var(--info)] flex-shrink-0" />}
      </button>

      {!collapsed && <div className="px-3 pb-2">{steps.map((s) => <StepRow key={s.id} step={s} />)}</div>}
    </div>
  );
};
