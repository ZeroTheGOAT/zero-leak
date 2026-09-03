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
  ShieldQuestion,
  SquareTerminal,
  Terminal,
  BadgeCheck,
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
  editing_file: FileEdit,
  writing_file: FilePlus,
  generating_artifact: FileOutput,
  verifying: BadgeCheck,
  awaiting_approval: ShieldQuestion,
  error: AlertCircle,
};

const StepRow: React.FC<{ step: AgentStep }> = ({ step }) => {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICON[step.kind] ?? ListChecks;
  const model = modelById(step.modelId);
  const hasDetail = Boolean(step.detail || step.error || step.citations?.length);

  const tone =
    step.status === 'failed'
      ? 'text-red-400'
      : step.status === 'running'
        ? 'text-sky-400'
        : step.status === 'skipped'
          ? 'text-[#5f6169]'
          : 'text-[#a1a1aa]';

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
            <Loader2 size={12} className="animate-spin text-sky-400" />
          ) : step.status === 'done' ? (
            <Check size={12} className="text-emerald-500" />
          ) : step.status === 'failed' ? (
            <AlertCircle size={12} className="text-red-400" />
          ) : (
            <MinusCircle size={12} className="text-[#5f6169]" />
          )}
        </span>

        <Icon size={12} className={`flex-shrink-0 mt-[3px] ${tone}`} />

        <span className="flex-1 min-w-0">
          <span className={`text-xs ${tone} ${step.status === 'skipped' ? 'line-through' : ''}`}>
            {step.title}
          </span>
          {model && (
            <span className="ml-2 text-[10px] text-[#5f6169]">{model.displayName}</span>
          )}
          {step.durationMs !== undefined && step.status !== 'running' && (
            <span className="ml-2 text-[10px] text-[#5f6169] tabular-nums">
              {formatDuration(step.durationMs)}
            </span>
          )}
        </span>

        {hasDetail && (
          <span className="text-[#5f6169] group-hover:text-[#a1a1aa] flex-shrink-0 mt-[2px]">
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
        )}
      </button>

      {open && (
        <div className="ml-[26px] mb-1.5 pl-2.5 border-l border-[#26282f] space-y-1.5">
          {step.detail && (
            <p className="text-[11px] text-[#8e8e93] leading-relaxed whitespace-pre-wrap font-mono">
              {step.detail}
            </p>
          )}
          {step.error && (
            <p className="text-[11px] text-red-400 leading-relaxed whitespace-pre-wrap font-mono">
              {step.error}
            </p>
          )}
          {step.citations?.map((c, i) => (
            <div key={i} className="text-[11px]">
              <span className="text-[#71717a]">
                {c.fileName}
                {c.page !== undefined ? ` · p.${c.page}` : ''}
                <span className="ml-1.5 tabular-nums text-[#5f6169]">{c.score.toFixed(3)}</span>
              </span>
              <p className="text-[#8e8e93] leading-relaxed">{c.snippet}</p>
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
  const [collapsed, setCollapsed] = useState(false);
  if (steps.length === 0) return null;

  const failed = steps.filter((s) => s.status === 'failed').length;
  const total = steps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);

  return (
    <div className="border border-[#22242c] rounded-lg bg-[#131418] overflow-hidden">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center justify-between px-3 py-2 hover:bg-[#171820] transition"
      >
        <span className="flex items-center space-x-2 text-[11px] text-[#a1a1aa]">
          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          <span>
            {steps.length} {steps.length === 1 ? 'action' : 'actions'}
          </span>
          {failed > 0 && <span className="text-red-400">· {failed} failed</span>}
          {!live && total > 0 && (
            <span className="text-[#5f6169] tabular-nums">· {formatDuration(total)}</span>
          )}
        </span>
        {live && <Loader2 size={12} className="animate-spin text-sky-400" />}
      </button>

      {!collapsed && <div className="px-3 pb-2">{steps.map((s) => <StepRow key={s.id} step={s} />)}</div>}
    </div>
  );
};
