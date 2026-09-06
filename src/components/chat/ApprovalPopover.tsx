import React from 'react';
import { ShieldCheck, ShieldHalf, Zap } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { ApprovalPolicy } from '../../types';

const OPTIONS: Array<{
  value: ApprovalPolicy;
  label: string;
  detail: string;
  icon: React.ElementType;
}> = [
  {
    value: 'ask_always',
    label: 'Ask before every action',
    detail:
      'Every write, generation and execution pauses for approval. Reads inside an approved workspace still run freely.',
    icon: ShieldCheck,
  },
  {
    value: 'ask_risky_only',
    label: 'Ask only for risky actions',
    detail:
      'Writes inside the workspace proceed. Code execution, deletion and anything outside the workspace still ask.',
    icon: ShieldHalf,
  },
  {
    value: 'auto_run_sandbox',
    label: 'Full autonomy in the sandbox',
    detail:
      'Writes and allow-listed commands (python, node, npm, cargo, git…) run without pausing. Destructive actions still ask, and nothing can leave the workspace or the allow-list.',
    icon: Zap,
  },
];

/**
 * §9 — how much the agent may do without stopping to ask.
 *
 * Neither option grants unattended execution, and neither can be widened from
 * here to reach outside an approved workspace. Destructive actions always ask,
 * whichever policy is chosen.
 */
export const ApprovalPopover: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { approvalPolicy, updateSettings } = useApp();

  const choose = (value: ApprovalPolicy) => {
    void updateSettings({ approvalPolicy: value });
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-label="Approval policy"
      className="absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[calc(100vw-2rem)] origin-bottom-left rounded-xl border nerve-border bg-[var(--popover)] p-1.5 text-[var(--popover-foreground)] shadow-[shadow:var(--shadow-lg)] animate-popover"
    >
      <div className="px-2.5 py-2">
        <h3 className="text-xs font-medium text-[var(--popover-foreground)]">Approval policy</h3>
        <p className="mt-0.5 text-[10px] leading-relaxed text-[var(--muted-foreground)]">
          Destructive commands ask every time regardless of this setting.
        </p>
      </div>

      {OPTIONS.map((opt) => {
        const active = approvalPolicy === opt.value;
        const Icon = opt.icon;
          return (
            <button
              type="button"
              key={opt.value}
              onClick={() => choose(opt.value)}
              aria-pressed={active}
              className={`flex w-full items-start space-x-2.5 rounded-lg px-2.5 py-2 text-left policy-row ${
                active ? 'policy-row-active' : ''
              }`}
            >
              <Icon
                size={14}
                className={`mt-0.5 flex-shrink-0 ${
                  active ? 'text-[var(--success)]' : 'text-[var(--muted-foreground)]'
                }`}
              />
              <span className="min-w-0 flex-1">
                <span
                  className={`text-xs text-[var(--popover-foreground)] ${
                    active ? 'font-medium' : ''
                  }`}
                >
                  {opt.label}
                </span>
                <span className="mt-0.5 block text-[10px] leading-relaxed text-[var(--muted-foreground)]">
                  {opt.detail}
                </span>
              </span>
            </button>
        );
      })}
    </div>
  );
};
