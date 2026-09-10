import React, { useRef, useState } from 'react';
import type { ModelCapability, ModelEntry } from '../../types';
import { CAPABILITY_LABELS } from '../../services/registry';
import { pickSettingsPath } from '../../services/core';

const field = 'h-8 w-full rounded-md border border-[var(--input)] bg-[var(--background)] px-2 text-sm';
const button = 'rounded-md border nerve-border px-3 py-1.5 text-xs disabled:opacity-40';
const cleanPath = (raw: string) => raw.trim().replace(/^"(.*)"$/, '$1');

export const ModelEditor: React.FC<{
  initial?: ModelEntry;
  onClose: () => void;
  onAdd: (model: ModelEntry, replace?: boolean) => Promise<void>;
}> = ({ initial, onClose, onAdd }) => {
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState('');
  const [where, setWhere] = useState(initial?.location ?? 'this_device');
  const [form, setForm] = useState({
    id: initial?.id ?? '', displayName: initial?.displayName ?? '', source: initial?.source ?? '',
    projector: initial?.projector ?? '', architecture: initial?.architecture ?? 'llama',
    quantization: initial?.quantization ?? 'Q4_K_M', contextSize: String(initial?.contextSize ?? 8192),
    trainedContext: String(initial?.trainedContext ?? 32768), estimatedVramMb: String(initial?.estimatedVramMb ?? 4096),
    fileSizeBytes: String(initial?.fileSizeBytes ?? 0), priority: initial?.priority ?? 'primary',
    kvCacheType: initial?.kvCacheType ?? 'f16', serverUrl: initial?.serverUrl ?? '',
    serverApiKeyEnv: initial?.serverApiKeyEnv ?? '',
  });
  const [capabilities, setCapabilities] = useState<ModelCapability[]>(initial?.capabilities ?? ['general', 'reasoning', 'tools']);
  const set = (key: keyof typeof form, value: string) => setForm((prev) => ({ ...prev, [key]: value }));
  const browse = async (key: 'source' | 'projector') => {
    try {
      const path = await pickSettingsPath(key === 'source' ? 'model' : 'projector');
      if (path) set(key, path);
    } catch (reason) { setError(String(reason instanceof Error ? reason.message : reason)); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    setError('');
    const numeric = ['contextSize', 'trainedContext', 'estimatedVramMb', 'fileSizeBytes'] as const;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(form.id.trim())) {
      setError('Use letters, numbers, dots, underscores or hyphens for the catalogue id.'); return;
    }
    if (!form.displayName.trim() || !form.source.trim()) { setError('Display name and model source are required.'); return; }
    if (numeric.some((key) => !form[key].trim() || !Number.isSafeInteger(Number(form[key])) || Number(form[key]) < 0)
      || Number(form.contextSize) < 1 || Number(form.trainedContext) < Number(form.contextSize)
      || numeric.slice(0, 3).some((key) => Number(form[key]) > 4294967295)) {
      setError('Enter whole numbers. Context must be positive and no larger than the trained context.'); return;
    }
    if (!capabilities.length) { setError('Select at least one capability.'); return; }
    if (where === 'this_device' && capabilities.some((c) => ['vision', 'ocr', 'handwriting', 'drawings'].includes(c)) && !cleanPath(form.projector)) {
      setError('Choose the matching GGUF vision projector for image, drawing and OCR capabilities.'); return;
    }
    submitting.current = true; setBusy(true);
    try {
      await onAdd({
        ...initial, id: form.id.trim(), displayName: form.displayName.trim(),
        location: where, backend: where === 'this_device' ? 'llama.cpp' : 'private_endpoint',
        source: where === 'this_device' ? cleanPath(form.source) : form.source.trim(),
        projector: where === 'this_device' ? cleanPath(form.projector) || undefined : undefined,
        architecture: form.architecture.trim(), quantization: form.quantization.trim(),
        contextSize: Number(form.contextSize), trainedContext: Number(form.trainedContext),
        estimatedVramMb: where === 'this_device' ? Number(form.estimatedVramMb) : 0,
        fileSizeBytes: where === 'this_device' ? Number(form.fileSizeBytes) : 0,
        kvCacheType: where === 'this_device' ? form.kvCacheType : undefined,
        priority: form.priority, capabilities,
        serverUrl: where === 'private_server' ? form.serverUrl.trim() || undefined : undefined,
        serverApiKeyEnv: where === 'private_server' ? form.serverApiKeyEnv.trim() || undefined : undefined,
      }, Boolean(initial));
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <div className="fixed inset-0 z-[80] grid place-items-center bg-black/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <form role="dialog" aria-modal="true" aria-labelledby="model-editor-title" onSubmit={submit} className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-xl border nerve-border bg-[var(--popover)] p-5 text-[var(--popover-foreground)] shadow-2xl">
      <h2 id="model-editor-title" className="text-base font-semibold">{initial ? 'Edit model' : 'Add model'}</h2>
      <p className="mt-1 text-xs text-[var(--muted-foreground)]">Register GGUF files or a private server. Local context is automatically fitted to device memory at load; set a custom context beside Thinking Effort in the composer. After saving local changes, restart the model runtime from Scoped Models to apply them.</p>
      <fieldset disabled={busy} className="mt-4 grid grid-cols-2 gap-3">
        <label className="col-span-2 text-xs">Location<select className={field} value={where} onChange={(e) => setWhere(e.target.value as typeof where)}><option value="this_device">This device · GGUF / llama.cpp</option><option value="private_server">Private server · OpenAI compatible</option></select></label>
        <label className="text-xs">Catalogue id<input className={field} disabled={Boolean(initial)} value={form.id} onChange={(e) => set('id', e.target.value)} placeholder="my-local-model" /></label>
        <label className="text-xs">Display name<input className={field} value={form.displayName} onChange={(e) => set('displayName', e.target.value)} /></label>
        <div className="col-span-2 flex items-end gap-2"><label className="min-w-0 flex-1 text-xs">{where === 'this_device' ? 'Weights path' : 'Server-side model id'}<input className={field} value={form.source} onChange={(e) => set('source', e.target.value)} /></label>{where === 'this_device' && <button type="button" className={button} onClick={() => void browse('source')}>Browse weights</button>}</div>
        {where === 'this_device' ? <>
          <div className="col-span-2 flex items-end gap-2"><label className="min-w-0 flex-1 text-xs">Vision projector (mmproj)<input className={field} value={form.projector} onChange={(e) => set('projector', e.target.value)} /></label><button type="button" className={button} onClick={() => void browse('projector')}>Browse projector</button></div>
          <label className="text-xs">KV cache<select className={field} value={form.kvCacheType} onChange={(e) => set('kvCacheType', e.target.value)}>{['f16', 'f32', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'iq4_nl'].map((v) => <option key={v}>{v}</option>)}</select></label>
        </> : <>
          <label className="col-span-2 text-xs">Server URL<input className={field} value={form.serverUrl} onChange={(e) => set('serverUrl', e.target.value)} placeholder="Empty uses the approved private endpoint" /></label>
          <label className="col-span-2 text-xs">Credential environment variable name<input className={field} value={form.serverApiKeyEnv} onChange={(e) => set('serverApiKeyEnv', e.target.value)} /></label>
        </>}
        <label className="text-xs">Priority<select className={field} value={form.priority} onChange={(e) => set('priority', e.target.value)}>{['primary', 'fallback', 'specialist', 'disabled'].map((v) => <option key={v}>{v}</option>)}</select></label>
        {([['architecture', 'Architecture'], ['quantization', 'Quantization'], ['contextSize', 'Fallback context'], ['trainedContext', 'Trained context'], ...(where === 'this_device' ? [['estimatedVramMb', 'Estimated peak VRAM (MiB)'], ['fileSizeBytes', 'File bytes (0 to detect)']] : [])] as Array<[keyof typeof form, string]>).map(([key, label]) => <label key={key} className="text-xs">{label}<input className={field} value={form[key]} onChange={(e) => set(key, e.target.value)} /></label>)}
        <fieldset className="col-span-2 rounded-md border nerve-border p-2"><legend className="px-1 text-xs">Capabilities used for routing</legend><div className="flex flex-wrap gap-x-4 gap-y-2">{(Object.keys(CAPABILITY_LABELS) as ModelCapability[]).map((cap) => <label key={cap} className="flex items-center gap-1.5 text-xs"><input type="checkbox" checked={capabilities.includes(cap)} onChange={(e) => setCapabilities((prev) => e.target.checked ? [...prev, cap] : prev.filter((c) => c !== cap))} />{CAPABILITY_LABELS[cap]}</label>)}</div></fieldset>
      </fieldset>
      {error && <p role="alert" className="mt-3 break-words text-xs text-[var(--destructive)]">{error}</p>}
      <div className="mt-5 flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={button}>Cancel</button><button disabled={busy} className={`zeroleak-primary ${button}`}>{busy ? 'Saving…' : initial ? 'Save model' : 'Add model'}</button></div>
    </form>
  </div>;
};
