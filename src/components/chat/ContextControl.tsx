import { useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import * as core from '../../services/core';

export function ContextControl({ modelId }: { modelId: string }) {
  const { catalogueModels, modelRuntime, anyRunning, coreStatus, refreshCore } = useApp();
  const model = catalogueModels.find((item) => item.id === modelId);
  const [mode, setMode] = useState(model?.contextMode ?? 'auto');
  const [tokens, setTokens] = useState(String(model?.contextLimit ?? model?.contextSize ?? 8192));
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  if (!model) return null;
  const local = model.location === 'this_device';
  const limit = model.trainedContext;
  const unavailable = anyRunning || coreStatus.state === 'unavailable' || coreStatus.state === 'checking';
  const valid = tokens.trim() && Number.isSafeInteger(Number(tokens)) && Number(tokens) > 0 && Number(tokens) <= limit;
  const running = modelRuntime[modelId]?.contextTokens;
  const apply = async () => {
    if (working.current) return;
    if (mode === 'manual' && !valid) { setError(`Enter a whole number from 1 to ${limit.toLocaleString()}.`); return; }
    working.current = true; setBusy(true); setError(''); setNotice('');
    let saved = false;
    try {
      await core.models.setContext(modelId, mode === 'auto' ? null : Number(tokens));
      saved = true;
      if (model.location === 'this_device') await core.models.routerRestart();
      await refreshCore();
      setNotice('Context saved. It applies the next time this model loads.');
    } catch (reason) {
      if (saved) await refreshCore();
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(saved ? `Your context choice is saved. Runtime restart failed: ${message}` : message);
    } finally { working.current = false; setBusy(false); }
  };
  return <div role="group" aria-label="Context window" className="mt-3 border-t nerve-border pt-3">
    <div className="flex items-center justify-between text-xs"><span className="font-medium">Context</span><span className="text-[var(--muted-foreground)]">Max {limit.toLocaleString()} tokens</span></div>
    <div className="mt-2 flex gap-2">
      {(['auto', 'manual'] as const).map((value) => <button key={value} type="button" disabled={busy || unavailable} aria-pressed={mode === value} onClick={() => setMode(value)} className={`flex-1 rounded-md border nerve-border px-2 py-1.5 text-xs disabled:opacity-40 ${mode === value ? 'bg-[var(--accent)] text-[var(--primary)]' : ''}`}>{value === 'auto' ? local ? 'Auto · fit hardware' : 'Configured default' : 'Custom'}</button>)}
    </div>
    {mode === 'manual' && <>
      <label className="mt-2 grid gap-1 text-xs">Context tokens<input type="number" min={1} max={limit} step={1} disabled={busy || unavailable} value={tokens} onChange={(e) => setTokens(e.target.value)} className="w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2 py-1.5" /></label>
      <div className="mt-2 flex flex-wrap gap-1">{[...new Set([4096, 8192, 16384, 32768, 65536, 131072, limit].filter((n) => n <= limit))].map((n) => <button type="button" key={n} disabled={busy || unavailable} onClick={() => setTokens(String(n))} className="rounded border nerve-border px-1.5 py-1 text-[10px] disabled:opacity-40">{n === limit ? `Max (${n.toLocaleString()})` : `${n / 1024}K`}</button>)}</div>
    </>}
    <p className="mt-2 text-[10px] leading-relaxed text-[var(--muted-foreground)]">{local ? mode === 'auto' ? 'Uses available memory up to the model’s trained maximum.' : 'Larger contexts can use system RAM and run more slowly. The runtime must still fit the model and cache in available memory.' : 'Sets this app’s conversation budget. The private server must already support the selected context size.'}{running ? ` Current window: ${running.toLocaleString()} tokens.` : ''}</p>
    <button type="button" disabled={busy || unavailable} onClick={() => void apply()} className="mt-2 w-full rounded-md border nerve-border px-2 py-1.5 text-xs disabled:opacity-40">{busy ? 'Applying…' : model.location === 'this_device' ? 'Apply context · restart runtime' : 'Apply context'}</button>
    {anyRunning && <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">Available after active tasks finish.</p>}
    {notice && <p role="status" className="mt-2 text-[10px] text-[var(--muted-foreground)]">{notice}</p>}
    {error && <p role="alert" className="mt-2 break-words text-xs text-[var(--destructive)]">{error}</p>}
  </div>;
}
