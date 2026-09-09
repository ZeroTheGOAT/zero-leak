import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowRight, AlertTriangle, CheckCircle2, ClipboardCheck, FileText, Loader2, Paperclip, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { basename } from '../../services/paths';
import { useApp } from '../../context/AppContext';
import { AgentTimeline } from '../chat/AgentTimeline';
import { formatDuration } from '../../services/registry';
import { WORKFLOWS, appendSourcePaths, moveSource, workflowPrompt, workflowCore, type WorkflowKind, type RunReceipt, type ReadinessReport, type NetworkEvent } from '../../services/workflows';

const button = 'inline-flex items-center justify-center gap-1.5 rounded-lg border nerve-border px-3 py-2 text-xs hover:bg-[var(--accent)] disabled:opacity-40 disabled:cursor-not-allowed';
const card = 'rounded-xl border nerve-border bg-[var(--card)] p-4';

export const WorkflowView: React.FC = () => {
  const { activeSessionId, activeWorkspace, isRunning, send, setMode, newSession, pickAttachments, openArtifact, openDocumentAt, openTab, catalogueModels, coreStatus, artifacts } = useApp();
  const [surface, setSurface] = useState<'workflows' | 'receipts' | 'readiness' | 'network'>('workflows');
  const [kind, setKind] = useState<WorkflowKind>('inspection');
  const { workflowDrafts: drafts, setWorkflowDrafts: setDrafts } = useApp();
  const draftKey = activeWorkspace?.id ?? 'none';
  const draft = drafts[draftKey] ?? { notes: '', files: [] };
  const setDraft = (patch: Partial<typeof draft> | ((current: typeof draft) => Partial<typeof draft>)) =>
    setDrafts((all) => {
      const current = all[draftKey] ?? { notes: '', files: [] };
      return { ...all, [draftKey]: { ...current, ...(typeof patch === 'function' ? patch(current) : patch) } };
    });
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<{ session: string; rows: RunReceipt[] } | null>(null);
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null);
  const [network, setNetwork] = useState<NetworkEvent[]>([]);
  const [guardResult, setGuardResult] = useState('');
  const [selected, setSelected] = useState('');
  const [receiptError, setReceiptError] = useState<{ session: string; message: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const workflow = WORKFLOWS.find((w) => w.id === kind)!;
  const rows = receipts?.session === activeSessionId ? receipts.rows : [];
  const receipt = rows.find((r) => r.runId === selected) ?? rows[0];
  const offline = coreStatus.state === 'unavailable';

  useEffect(() => {
    if (surface !== 'receipts' || !activeSessionId || offline) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const session = activeSessionId;
    const refresh = async () => {
      try { const result = await workflowCore.receipts(session); if (!stopped) { setReceipts({ session, rows: result }); setReceiptError(null); } }
      catch (e) { if (!stopped) setReceiptError({ session, message: e instanceof Error ? e.message : String(e) }); }
      finally { if (!stopped) timer = setTimeout(refresh, 2500); }
    };
    void refresh();
    return () => { stopped = true; clearTimeout(timer); };
  }, [surface, activeSessionId, offline]);

  const perform = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  const launch = () => perform(async () => {
    if (offline || !activeWorkspace?.approved || activeWorkspace.archived || isRunning || draft.files.length < workflow.minimum) return;
    const sid = activeSessionId ?? newSession();
    if (!sid) throw new Error('Create a task in this project before starting.');
    setMode('agent');
    const accepted = await send(workflowPrompt(kind, draft.notes), draft.files, sid, 'agent');
    if (accepted) { setSurface('receipts'); setSelected(''); }
    else throw new Error('The run was not accepted. Your inputs are still here.');
  });

  return <div className="flex flex-1 min-h-0 flex-col text-[var(--foreground)]">
    <div className="border-b nerve-border p-3">
      <div className="flex items-center gap-2"><ClipboardCheck size={17} className="text-[var(--primary)]" /><h2 className="font-medium text-sm">Industrial workflows</h2></div>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">Sources → local execution → reviewable deliverables</p>
      <div className="mt-3 flex flex-wrap gap-1" role="tablist" aria-label="Workflow sections">
        {(['workflows', 'receipts', 'readiness', 'network'] as const).map((name) => <button key={name} role="tab" aria-selected={surface === name} onClick={() => { setSurface(name); setError(''); }} className={`${button} ${surface === name ? 'bg-[var(--accent)]' : ''}`}>{name === 'receipts' ? 'Run receipts' : name.charAt(0).toUpperCase() + name.slice(1)}</button>)}
      </div>
    </div>
    <div role="tabpanel" aria-label={`${surface} content`} className="flex-1 overflow-y-auto p-4 space-y-4">
      {error && <p role="alert" className="rounded-lg border border-[var(--destructive-ring)] bg-[var(--destructive-soft)] p-3 text-xs break-words">{error}</p>}
      {offline && <p className="text-xs text-[var(--warning)]">Attach the local core to run workflows or read execution evidence.</p>}
      {surface === 'workflows' && <>
        <div className="grid gap-2">{WORKFLOWS.map((w) => <button key={w.id} onClick={() => setKind(w.id)} aria-pressed={w.id === kind} className={`${card} text-left ${w.id === kind ? 'ring-1 ring-[var(--primary)]' : 'hover:bg-[var(--accent)]'}`}><span className="block text-sm font-medium">{w.title}</span><span className="block mt-1 text-xs text-[var(--muted-foreground)]">{w.description}</span></button>)}</div>
        <div className={card}>
          <p className="text-xs leading-relaxed text-[var(--muted-foreground)]">{workflow.inputs}</p>
          <ol className="mt-3 space-y-2" aria-label="Source order">
            {draft.files.map((path, index) => <li key={path} className="flex gap-2 items-center rounded-lg bg-[var(--background)] p-2 text-xs">
              <span className="tabular-nums text-[var(--muted-foreground)]">{index + 1}.</span>
              <span className="min-w-0 flex-1"><span title={path} className="block truncate">{basename(path)}</span>
                {kind === 'revision' && <span className="block mt-0.5 text-[var(--muted-foreground)]">{index === 0 ? 'Earlier revision' : index === 1 ? 'New revision' : 'Supporting context'}</span>}
              </span>
              <button className="p-1 rounded hover:bg-[var(--accent)] disabled:opacity-30" disabled={index === 0 || busy} title="Move earlier" aria-label={`Move ${basename(path)} earlier`} onClick={() => setDraft((current) => ({ files: moveSource(current.files, index, -1) }))}><ArrowUp size={14} /></button>
              <button className="p-1 rounded hover:bg-[var(--accent)] disabled:opacity-30" disabled={index === draft.files.length - 1 || busy} title="Move later" aria-label={`Move ${basename(path)} later`} onClick={() => setDraft((current) => ({ files: moveSource(current.files, index, 1) }))}><ArrowDown size={14} /></button>
              <button className="p-1 rounded hover:bg-[var(--accent)] disabled:opacity-30" disabled={busy} aria-label={`Remove ${basename(path)}`} onClick={() => setDraft((current) => ({ files: current.files.filter((p) => p !== path) }))}><X size={14} /></button>
            </li>)}
          </ol>
          <div className="mt-3 flex flex-wrap gap-2">
            <button className={button} disabled={busy || offline} onClick={() => void perform(async () => { const picked = await pickAttachments(); setDraft((current) => ({ files: appendSourcePaths(current.files, picked) })); })}><Paperclip size={13} />Attach sources</button>
            <button className={button} onClick={() => openTab('knowledge', 'Knowledge')}>Index SOPs</button>
            {kind === 'dashboard' && artifacts.some((a) => a.kind === 'xlsx' && a.sessionId === activeSessionId) && <button className={button} onClick={() => { const latest = artifacts.filter((a) => a.kind === 'xlsx' && a.sessionId === activeSessionId).sort((a,b) => b.createdAt-a.createdAt)[0]; if (latest) setDraft((current) => ({ files: appendSourcePaths(current.files, [latest.path]) })); }}>Use latest tracker</button>}
          </div>
          <label className="block mt-4 text-xs">Additional instructions<textarea value={draft.notes} onChange={(e) => setDraft({ notes: e.target.value })} rows={3} placeholder="Equipment scope, intended reader, or acceptance criteria" className="mt-2 w-full rounded-lg border nerve-border bg-[var(--background)] p-2 text-sm select-text" /></label>
          <details className="mt-3 text-xs text-[var(--muted-foreground)]"><summary className="cursor-pointer">Review workflow instructions</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed select-text">{workflowPrompt(kind,draft.notes)}</p></details>
          <button className={`${button} zeroleak-primary mt-4 w-full`} disabled={busy || offline || isRunning || !activeWorkspace?.approved || activeWorkspace.archived || draft.files.length < workflow.minimum} onClick={() => void launch()}>{busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}Start in this task</button>
          <p className="mt-2 text-xs text-[var(--muted-foreground)]">{offline ? 'Connect the local core to start.' : !activeWorkspace ? 'Open a project first.' : !activeWorkspace.approved ? 'Approve this project before starting.' : activeWorkspace.archived ? 'Restore this project before starting.' : isRunning ? 'Wait for this task to finish.' : draft.files.length < workflow.minimum ? `Attach ${workflow.minimum - draft.files.length} more source ${workflow.minimum - draft.files.length === 1 ? 'file' : 'files'} to start.` : `Agent mode · your permission rules apply · ${draft.files.length} source files`}</p>
        </div>
      </>}
      {surface === 'receipts' && <>
        {receiptError?.session === activeSessionId && <p role="alert" className="text-xs text-[var(--destructive)]">{receiptError?.message} Retrying…</p>}
        {!activeSessionId ? <p className="text-sm">Open a task to inspect its execution receipts.</p> : receipts?.session !== activeSessionId && !offline && receiptError?.session !== activeSessionId ? <p role="status" className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]"><Loader2 size={14} className="animate-spin" />Loading run receipts…</p> : rows.length === 0 && !receiptError && !offline ? <p className="text-sm text-[var(--muted-foreground)]">No receipts recorded for this task yet. Earlier runs are not reconstructed as evidence.</p> : <>
          <label className="block text-xs">Run<select className="mt-2 w-full rounded-lg border nerve-border bg-[var(--card)] p-2" value={receipt?.runId ?? ''} onChange={(e) => setSelected(e.target.value)}>{rows.map((r) => <option key={r.runId} value={r.runId}>{new Date(r.startedAt).toLocaleString()} · {r.workflow ?? 'Custom task'} · {r.status}</option>)}</select></label>
          {receipt && <>
            <div className={card}><div className="flex justify-between gap-2"><span className="text-sm font-medium capitalize">{receipt.status}</span><span className="text-xs">{receipt.elapsedMs != null ? formatDuration(receipt.elapsedMs) : 'In progress'}</span></div><p className="mt-1 text-xs text-[var(--muted-foreground)] break-all">{receipt.runId} · {receipt.operator}</p><button className={`${button} mt-3`} disabled={busy || receipt.status === 'running'} onClick={() => void perform(async () => { const file = await workflowCore.exportReceipt(receipt.sessionId,receipt.runId); await openArtifact(file.id); })}><FileText size={13} />Export receipt</button></div>
            {receipt.failure && <p role="alert" className="text-xs text-[var(--destructive)]">{receipt.failure}</p>}
            {receipt.checks.length > 0 && <div className={card}><h3 className="text-sm font-medium">Completion evidence</h3><p className="mt-1 text-xs text-[var(--muted-foreground)]">A finished run may still have missing evidence. These checks do not approve engineering conclusions.</p>{receipt.checks.map((check) => <div key={check.name} className="mt-3 text-xs"><span className={check.passed ? 'text-[var(--success)]' : 'text-[var(--warning)]'}>{check.passed ? 'Recorded' : 'Missing'} · {check.name}</span><p className="mt-1 text-[var(--muted-foreground)]">{check.detail}</p></div>)}</div>}
            <div className={card}><h3 className="text-sm font-medium">Model routing</h3>{receipt.steps.filter((s) => s.kind === 'selecting_model' || s.kind === 'loading_model').map((s) => <div key={s.id} className="mt-3 text-xs"><p>{s.modelId ? catalogueModels.find((m) => m.id === s.modelId)?.displayName ?? s.modelId : s.title} · {s.status}</p><p className="mt-1 text-[var(--muted-foreground)]">{s.detail ?? s.title}</p></div>)}{!receipt.steps.some((s) => s.kind === 'selecting_model') && <p className="mt-2 text-xs text-[var(--muted-foreground)]">No routing decision recorded yet.</p>}</div>
            <div className={card}><h3 className="text-sm font-medium">Deliverables</h3>{receipt.artifacts.length === 0 && <p className="mt-2 text-xs text-[var(--muted-foreground)]">No generated artifact recorded.</p>}{receipt.artifacts.map((a) => <button key={a.id} className="mt-3 block w-full text-left text-xs" onClick={() => void openArtifact(a.id)}><span className="underline">{a.fileName}</span><span className="block mt-1 text-[var(--muted-foreground)]">{a.verified ? a.verifyNote : 'Not verified'}</span></button>)}</div>
            <div className={card}><h3 className="text-sm font-medium">Source evidence</h3>{receipt.citations.length === 0 && <p className="mt-2 text-xs text-[var(--muted-foreground)]">No citations recorded. Do not treat uncited conclusions as supported.</p>}{receipt.citations.map((c,i) => <button key={`${c.path}-${i}`} className="mt-3 block w-full text-left text-xs" onClick={() => void openDocumentAt(c.path,c)}><span className="underline">{c.fileName}{c.page ? ` · page ${c.page}` : ''}</span><span className="mt-1 block text-[var(--muted-foreground)]">{c.snippet}</span></button>)}</div>
            <div className={card}><h3 className="mb-3 text-sm font-medium">Executed steps and verification output</h3><AgentTimeline steps={receipt.steps} live={receipt.status === 'running'} /></div>
            {(receipt.sandboxRuns ?? []).map((run) => <details key={run.id} className={card}><summary className="text-xs cursor-pointer break-words">{run.command} · {run.status}{run.exitCode != null ? ` · exit ${run.exitCode}` : ''}</summary><p className="mt-2 text-xs break-all text-[var(--muted-foreground)]">{run.cwd}</p><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs select-text">{run.output.map((line) => `[${line.stream}] ${line.text}`).join('\n')}</pre></details>)}
            <details className={card}><summary className="text-xs cursor-pointer">Submitted inputs ({receipt.inputs.length})</summary>{receipt.inputs.map((p) => <p key={p} className="mt-2 text-xs break-all select-text">{p}</p>)}</details>
            <p className="text-xs text-[var(--muted-foreground)]">{receipt.networkScope} {receipt.networkEvents.length} guard decisions captured in this receipt (latest 500).</p>
          </>}
        </>}
      </>}
      {surface === 'readiness' && <>
        <div className={card}><h3 className="text-sm font-medium">Before the demonstration</h3><p className="mt-2 text-xs leading-relaxed text-[var(--muted-foreground)]">Check local model files, task routes, runtime tools, GPU telemetry, indexed knowledge and real document exporters. This check does not download dependencies or load models.</p><button className={`${button} mt-3`} disabled={busy || offline} onClick={() => void perform(async () => setReadiness(await workflowCore.readiness()))}>{busy ? <Loader2 size={13} className="animate-spin" /> : <ClipboardCheck size={13} />}Check this workstation</button></div>
        {readiness && <><p className="text-xs text-[var(--muted-foreground)]">Checked {new Date(readiness.checkedAt).toLocaleTimeString()}. {readiness.scope}</p>{readiness.checks.map((c) => <div key={c.name} className={card}><p className="text-sm flex items-center gap-2">{c.status === 'pass' ? <CheckCircle2 size={14} className="text-[var(--success)]" /> : <AlertTriangle size={14} className={c.status === 'fail' ? 'text-[var(--destructive)]' : 'text-[var(--warning)]'} />}{c.name}<span className={`ml-auto text-xs ${c.status === 'pass' ? 'text-[var(--success)]' : c.status === 'fail' ? 'text-[var(--destructive)]' : 'text-[var(--warning)]'}`}>{c.status}</span></p><p className="mt-2 text-xs text-[var(--muted-foreground)] break-words">{c.detail}</p></div>)}</>}
      </>}
      {surface === 'network' && <>
        <div className={card}><h3 className="flex items-center gap-2 text-sm font-medium"><ShieldCheck size={16} />Sovereignty evidence</h3><p className="mt-2 text-xs leading-relaxed text-[var(--muted-foreground)]">These are application HTTP guard decisions, not packets or a machine-wide monitor. Allowed destinations do not prove a connection occurred. Pair this log with an independent OS network capture for the hackathon demonstration.</p><div className="mt-3 flex flex-wrap gap-2"><button className={button} disabled={busy || offline} onClick={() => void perform(async () => setNetwork(await workflowCore.network()))}><RefreshCw size={13} />Refresh log</button><button className={button} disabled={busy || offline} onClick={() => void perform(async () => { const result = await workflowCore.checkGuard(); setGuardResult(`${result.denied ? 'Blocked as expected' : 'FAILED: destination allowed'}. ${result.detail}`); setNetwork(await workflowCore.network()); })}>Test the guard without connecting</button></div>{guardResult && <p role="status" className="mt-3 text-xs">{guardResult}</p>}</div>
        {network.map((n,i) => <div key={`${n.at}-${i}`} className="border-b nerve-border pb-3 text-xs"><p className="flex gap-2"><span className={n.outcome === 'denied' ? 'text-[var(--warning)]' : 'text-[var(--success)]'}>{n.outcome}</span><time className="ml-auto text-[var(--muted-foreground)]">{new Date(n.at).toLocaleTimeString()}</time></p><p className="mt-1 break-all select-text">{n.destination}</p><p className="mt-1 text-[var(--muted-foreground)]">{n.detail}</p></div>)}
        <p className="text-xs text-[var(--muted-foreground)]">Showing the latest {network.length} decisions, up to 500. Refresh to read new activity.</p>
      </>}
    </div>
  </div>;
};
