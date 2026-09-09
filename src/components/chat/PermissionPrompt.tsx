import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, FileEdit, ShieldQuestion, Terminal, Trash2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { toolByName } from '../../services/registry';
import type { PermissionRequest, ToolRisk } from '../../types';

const RISK_ICON: Record<ToolRisk, React.ElementType> = {
  read: ShieldQuestion,
  write: FileEdit,
  execute: Terminal,
  destructive: Trash2,
};

const RISK_TONE: Record<ToolRisk, string> = {
  read: 'text-[var(--info)] border-[var(--border)] bg-[var(--muted)]',
  write: 'text-[var(--warning)] border-[var(--border)] bg-[var(--muted)]',
  execute: 'text-[var(--primary)] border-[var(--border)] bg-[var(--muted)]',
  destructive: 'text-[var(--destructive)] border-[var(--border)] bg-[var(--muted)]',
};

const RISK_LABEL: Record<ToolRisk, string> = {
  read: 'Reads data',
  write: 'Writes to disk',
  execute: 'Executes code',
  destructive: 'Destructive',
};

/**
 * §9 — a structured request the user answers before the action happens.
 *
 * The run is genuinely blocked while this is on screen: the core is waiting
 * on the decision, so there is no path where the action runs first and asks
 * afterwards. Destructive requests get the strongest treatment and never
 * default to allow.
 */
export const PermissionPrompt: React.FC = () => {
  const { pendingPermission } = useApp();
  return pendingPermission ? <PermissionForm key={pendingPermission.id} pendingPermission={pendingPermission} /> : null;
};

const PermissionForm: React.FC<{ pendingPermission: PermissionRequest }> = ({ pendingPermission }) => {
  const { respondToPermission, workspaces } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const respond = useCallback(async (decision: Parameters<typeof respondToPermission>[0]) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (!await respondToPermission(decision)) setError('Your decision was not delivered. Check the connection and try again.');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { submitting.current = false; setBusy(false); }
  }, [respondToPermission]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pendingPermission) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Initial focus on the safe action.
    const frame = requestAnimationFrame(() => rejectRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      // Escape rejects. There is no keyboard shortcut for allow.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); void respond('reject'); }
      // Focus trap: keep Tab cycling inside the dialog.
      if (e.key === 'Tab' && dialogRef.current) {
        const controls = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(frame);
      if (previous?.isConnected) previous.focus();
    };
  }, [pendingPermission, respond]);

  if (!pendingPermission) return null;

  const req = pendingPermission;
  const tool = toolByName(req.tool);
  const Icon = RISK_ICON[req.risk];
  const workspace = workspaces.find((w) => w.id === req.workspaceId);
  const destructive = req.risk === 'destructive';

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center px-4 backdrop-blur-sm"
      style={{ background: 'color-mix(in oklab, var(--background) 72%, transparent)' }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        aria-describedby="permission-rationale"
        className="w-full max-w-lg overflow-hidden rounded-xl border nerve-border bg-[var(--popover)] text-[var(--popover-foreground)] shadow-[shadow:var(--shadow-lg)] animate-popover"
      >
        {/* Header */}
        <div className={`px-4 py-3 border-b flex items-start space-x-3 ${RISK_TONE[req.risk]}`}>
          <Icon size={18} className="flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <h2 id="permission-title" className="text-sm font-semibold text-[var(--popover-foreground)]">{req.title}</h2>
            <p className="text-[11px] mt-0.5">
              {RISK_LABEL[req.risk]} · {tool?.label ?? req.tool}
            </p>
          </div>
        </div>

        <div className="px-4 py-3 space-y-3">
          <p id="permission-rationale" className="text-xs leading-relaxed text-[var(--popover-foreground)]">{req.rationale}</p>

          <div className="space-y-1.5 text-[11px]">
            <div className="flex items-start space-x-2">
              <span className="w-16 flex-shrink-0 text-[var(--muted-foreground)]">Target</span>
              <span className="break-all font-mono text-[var(--popover-foreground)]">{req.target}</span>
            </div>
            <div className="flex items-start space-x-2">
              <span className="w-16 flex-shrink-0 text-[var(--muted-foreground)]">Workspace</span>
              <span className="break-all font-mono text-[var(--popover-foreground)]">
                {workspace ? workspace.path : req.workspaceId}
              </span>
            </div>
          </div>

          {req.preview && (
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border nerve-border bg-[var(--muted)] p-2.5 font-mono text-[11px] leading-relaxed text-[var(--muted-foreground)]">
              {req.preview}
            </pre>
          )}

          {destructive && (
            <div className="flex items-start space-x-2 rounded-md border nerve-border bg-[var(--muted)] px-2.5 py-2 text-[11px] text-[var(--destructive)]">
              <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                This cannot be undone from inside the app. Session-wide approval is not offered
                for destructive actions.
              </span>
            </div>
          )}
        </div>

        {error && <p role="alert" className="px-4 pb-3 text-xs text-[var(--destructive)]">{error}</p>}
        {busy && <p role="status" className="px-4 pb-3 text-xs text-[var(--muted-foreground)]">Sending decision…</p>}
        {/* Decisions */}
        <div className="flex items-center justify-end space-x-2 border-t nerve-border bg-[var(--card)] px-4 py-3">
          <button
            disabled={busy}
            ref={rejectRef}
            onClick={() => void respond('reject')}
            aria-label="Reject this action"
            className="rounded-md border nerve-border px-3 py-1.5 text-xs text-[var(--card-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]"
          >
            Reject
          </button>
          {!destructive && (
            <button
              disabled={busy}
              onClick={() => void respond('allow_session')}
              aria-label="Allow this tool for the rest of this session in this workspace"
              className="rounded-md border nerve-border px-3 py-1.5 text-xs text-[var(--card-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]"
              title="Allow this tool for the rest of this session, in this workspace only"
            >
              Allow for session
            </button>
          )}
          <button
            disabled={busy}
            onClick={() => void respond('allow_once')}
            aria-label={destructive ? 'Allow this destructive action once' : 'Allow this action once'}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
              destructive
                ? 'bg-[var(--destructive-solid)] text-[var(--destructive-solid-foreground)] hover:brightness-110'
                : 'zeroleak-primary hover:brightness-105'
            }`}
          >
            Allow once
          </button>
        </div>
      </div>
    </div>
  );
};
