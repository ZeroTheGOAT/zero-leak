import React, { useEffect, useMemo, useState } from 'react';
import { File, FileWarning, Loader2, Pencil, Save, ScanText, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import * as core from '../../services/core';
import { formatBytes } from '../../services/registry';
import type { FilePreview as FilePreviewData } from '../../types';

const EXTRACTABLE = /\.(pdf|docx?|rtf|pptx?|xlsx?|csv|tsv|png|jpe?g|webp|bmp|tiff?|gif)$/i;

function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let offset = 0; offset < raw.length; offset += 65_536) {
    const end = Math.min(raw.length, offset + 65_536);
    for (let i = offset; i < end; i += 1) bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function isText(preview: FilePreviewData, bytes: Uint8Array): boolean {
  if (
    preview.mimeType.startsWith('text/') ||
    preview.mimeType === 'application/json' ||
    preview.mimeType === 'application/xml'
  ) {
    return true;
  }
  // Extensionless configuration and source files are common. A NUL byte is a
  // safer binary signal than guessing from an unfamiliar extension.
  return !bytes.subarray(0, 8_192).some((byte) => byte === 0);
}

function hexSample(bytes: Uint8Array): string {
  const sample = bytes.subarray(0, 4_096);
  const lines: string[] = [];
  for (let offset = 0; offset < sample.length; offset += 16) {
    const row = sample.subarray(offset, offset + 16);
    const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
    const ascii = Array.from(row, (byte) =>
      byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.',
    ).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join('\n');
}

/**
 * Unsaved buffers, by path.
 *
 * The panel renders one tab at a time, so switching tabs unmounts this
 * component and would otherwise throw away whatever the operator had typed.
 * Only changed text is held, so a path in here means "there are edits that are
 * not on disk" — which is also what decides whether reopening the tab comes
 * back in the editor. Saving or cancelling clears the entry.
 */
const drafts = new Map<string, string>();

/**
 * A local-only viewer and editor. It never hands a click to Explorer or a
 * default app, and the only write it can make is to the file it has open.
 */
export const FilePreview: React.FC<{ path?: string }> = ({ path }) => {
  const { openDocumentAt } = useApp();
  const [preview, setPreview] = useState<FilePreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    // A held buffer means the operator was editing this file and moved away:
    // come back into the editor rather than discarding their typing.
    const held = path ? drafts.get(path) : undefined;
    setEditing(held !== undefined);
    setDraft(held ?? '');
    setSaveError(null);
    if (!path) {
      setLoading(false);
      setError('This tab does not point to a file.');
      return () => {
        current = false;
      };
    }
    void core.files.preview(path).then(
      (next) => {
        if (current) setPreview(next);
      },
      (reason: unknown) => {
        if (current) setError(reason instanceof Error ? reason.message : String(reason));
      },
    ).finally(() => {
      if (current) setLoading(false);
    });
    return () => {
      current = false;
    };
  }, [path]);

  const bytes = useMemo(
    () => (preview?.contentBase64 ? decodeBase64(preview.contentBase64) : null),
    [preview],
  );
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!preview || !bytes) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: preview.mimeType }),
    );
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes, preview]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--muted-foreground)]">
        <Loader2 size={18} className="animate-spin" />
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <FileWarning size={22} className="text-[var(--destructive)] mb-2.5" />
        <p className="text-[11.5px] text-[var(--destructive)] max-w-md leading-relaxed">{error}</p>
      </div>
    );
  }

  const text = bytes && isText(preview, bytes) ? new TextDecoder().decode(bytes) : null;
  const canExtract = EXTRACTABLE.test(preview.fileName);

  // Only text the viewer is showing in full can be edited. An editor over a
  // truncated or binary file would save whatever it managed to render, which
  // is a corrupted file rather than an edit.
  const editable = text !== null && !preview.tooLarge;
  const editorOpen = editing && editable;
  const dirty = editorOpen && draft !== text;
  // The tab's own path, not `preview.path`: the core answers with the
  // canonicalized name, which need not be the string this tab holds, and the
  // effect above looks a held buffer up by the tab's path. Keying both sides
  // the same way is what makes an edit survive a tab switch. The write
  // canonicalizes this again itself, so it lands on the file being shown.
  const target = path ?? preview.path;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // The core answers with the file as it is on disk afterwards, so what
      // the tab shows next is the file and not the buffer that was sent.
      const saved = await core.files.write(target, draft);
      drafts.delete(target);
      setPreview(saved);
      setEditing(false);
    } catch (reason) {
      setSaveError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    drafts.delete(target);
    setEditing(false);
    setDraft('');
    setSaveError(null);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--background)]">
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between gap-3 flex-shrink-0">
        <div className="min-w-0">
          <p className="text-[12px] text-[var(--foreground)] truncate" title={preview.path}>
            {preview.fileName}
          </p>
          <p className="text-[10px] text-[var(--muted-foreground)] truncate">
            {preview.mimeType} · {formatBytes(preview.sizeBytes)}
            {dirty && <span className="text-[var(--warning)]"> · unsaved edits</span>}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {editable && !editorOpen && (
            <button
              onClick={() => {
                setSaveError(null);
                setDraft(text ?? '');
                setEditing(true);
              }}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border)] text-[10.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition"
              title="Edit this file here and save it back to disk"
            >
              <Pencil size={11} />
              <span>Edit</span>
            </button>
          )}
          {editorOpen && (
            <>
              <button
                onClick={cancel}
                disabled={saving}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border)] text-[10.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition disabled:opacity-50"
                title="Discard these edits and show the file as it is on disk"
              >
                <X size={11} />
                <span>Cancel</span>
              </button>
              <button
                onClick={() => void save()}
                disabled={saving || !dirty}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--success-soft)] border border-[var(--success-ring)] text-[10.5px] text-[var(--success)] transition disabled:opacity-50"
                title={dirty ? 'Write this text to the file (Ctrl+S)' : 'Nothing has changed'}
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                <span>{saving ? 'Saving' : 'Save'}</span>
              </button>
            </>
          )}
          {canExtract && (
            <button
              onClick={() => void openDocumentAt(preview.path)}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[var(--border)] text-[10.5px] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)] transition"
              title="Read text, tables and tags from this file"
            >
              <ScanText size={11} />
              <span>Extract</span>
            </button>
          )}
        </div>
      </div>

      {saveError && (
        <p className="px-3 py-1.5 border-b border-[var(--destructive-ring)] bg-[var(--destructive-soft)] text-[10.5px] text-[var(--destructive)] leading-relaxed flex-shrink-0">
          {saveError} Nothing was written, and your edits are still in this tab.
        </p>
      )}

      {preview.tooLarge || !bytes ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <File size={28} className="text-[var(--border)] mb-3" />
          <p className="text-[12px] text-[var(--foreground)]">The file is open in this tab.</p>
          <p className="text-[11px] text-[var(--muted-foreground)] mt-1.5 max-w-sm leading-relaxed">
            It is larger than the 32 MB inline-preview limit, so its bytes were not copied into the
            viewer.
          </p>
        </div>
      ) : preview.mimeType.startsWith('image/') && blobUrl ? (
        <div className="flex-1 min-h-0 overflow-auto p-4 bg-[var(--sidebar-accent)] flex items-center justify-center">
          <img
            src={blobUrl}
            alt={preview.fileName}
            className="max-w-full max-h-full object-contain shadow-xl select-none"
            draggable={false}
          />
        </div>
      ) : preview.mimeType.startsWith('video/') && blobUrl ? (
        <div className="flex-1 min-h-0 p-4 flex items-center justify-center">
          <video src={blobUrl} controls className="max-w-full max-h-full" />
        </div>
      ) : preview.mimeType.startsWith('audio/') && blobUrl ? (
        <div className="flex-1 p-6 flex items-center justify-center">
          <audio src={blobUrl} controls className="w-full max-w-xl" />
        </div>
      ) : preview.mimeType === 'application/pdf' && blobUrl ? (
        <iframe title={preview.fileName} src={blobUrl} className="flex-1 min-h-0 w-full bg-white" />
      ) : editorOpen ? (
        <textarea
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            // Held only while it differs from the file, so the map answers
            // "are there edits that are not on disk" and nothing else.
            if (event.target.value === text) drafts.delete(target);
            else drafts.set(target, event.target.value);
          }}
          onKeyDown={(event) => {
            // Ctrl+S is what a hand reaches for in something shaped like an
            // editor; without it this is a form that happens to hold code.
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              if (dirty && !saving) void save();
            }
          }}
          spellCheck={false}
          wrap="off"
          autoFocus
          aria-label={`Contents of ${preview.fileName}`}
          className="flex-1 min-h-0 w-full m-0 p-4 resize-none overflow-auto bg-[var(--background)] text-[var(--foreground)] text-[11.5px] leading-relaxed font-mono tab-size-2 border-0 outline-none focus:ring-1 focus:ring-inset focus:ring-[var(--primary-ring)]"
        />
      ) : text !== null ? (
        <div className="flex-1 overflow-auto min-h-0">
          <pre className="m-0 p-4 min-w-full w-max text-[11.5px] leading-relaxed text-[var(--foreground)] whitespace-pre tab-size-2 select-text">
            {text}
          </pre>
        </div>
      ) : (
        <div className="flex-1 overflow-auto min-h-0">
          <div className="px-4 py-2 border-b border-[var(--border)] text-[10.5px] text-[var(--muted-foreground)]">
            This format has no visual renderer. Showing the first {Math.min(bytes.length, 4_096).toLocaleString()} bytes.
          </div>
          <pre className="m-0 p-4 text-[10.5px] leading-relaxed text-[var(--muted-foreground)] whitespace-pre select-text">
            {hexSample(bytes)}
          </pre>
        </div>
      )}
    </div>
  );
};
