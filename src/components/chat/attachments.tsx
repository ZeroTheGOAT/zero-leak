/*
 * Thumbnails and classification for files attached to a turn.
 *
 * A pasted or picked image rides into the transcript as an absolute path, so
 * both the composer chip and the message bubble have to turn that path back
 * into pixels to look like ChatGPT's thumbnails. The core answers a read for
 * any sovereign-trusted path (the staged `…/attachments` folder is one), and
 * an image is the one attachment worth fetching eagerly: documents stay a chip
 * with a name, never a raster.
 */
import React, { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import * as core from '../../services/core';

/** Mirrors `IMAGE_EXTS` in src-tauri/src/attachments.rs — what pastes, what
 *  thumbnails. */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tif', 'tiff', 'gif']);

export const isImagePath = (path: string): boolean => {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTS.has(name.slice(dot + 1).toLowerCase());
};

/** The image's file name, for `alt` text when the path has no other name. */
export const imageName = (path: string): string => path.split(/[\\/]/).pop() ?? path;

function readAsDataUrlBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * A textarea `onPaste` that pulls image files off the clipboard, stages each
 * under the sovereign attachments folder (the core turns the pixels into a
 * file a turn can attach), and hands the resulting paths to `onAttached`. A
 * paste without images — ordinary text — is left untouched so the textarea
 * pastes it itself.
 */
export const stagePastedImages =
  (onAttached: (paths: string[]) => void) =>
  (event: React.ClipboardEvent): void => {
    const files = Array.from(event.clipboardData?.files ?? []);
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length === 0) return;
    event.preventDefault();
    void (async () => {
      const added: string[] = [];
      for (const file of images.slice(0, 4)) {
        try {
          const dataBase64 = await readAsDataUrlBase64(file);
          if (!dataBase64) continue;
          // `stage` answers the absolute path as a bare string — the same shape
          // `fs_read` uses — and that string is what the turn attaches.
          const path = await core.attachments.stage(
            file.name || 'pasted-image',
            file.type || 'image/png',
            dataBase64,
          );
          added.push(path);
        } catch {
          // One unreadable paste must not swallow the rest of the clipboard.
        }
      }
      if (added.length > 0) onAttached(added);
    })();
  };

/** Decodes one preview payload into an object URL the <img> can show. */
function toObjectUrl(contentBase64: string, mimeType: string): string {
  const raw = atob(contentBase64);
  const bytes = new Uint8Array(raw.length);
  for (let offset = 0; offset < raw.length; offset += 65_536) {
    const end = Math.min(raw.length, offset + 65_536);
    for (let i = offset; i < end; i += 1) bytes[i] = raw.charCodeAt(i);
  }
  return URL.createObjectURL(
    new Blob([bytes.buffer as ArrayBuffer], { type: mimeType || 'image/png' }),
  );
}

/**
 * One square thumbnail for an attached image, fetched on mount from the file
 * itself (never from an ingestion record — a pasted image has none). The
 * square is a fixed size the caller sets via `className`; unreadable or
 * oversized images fall back to a broken-image glyph rather than a blank.
 */
export const ImageThumb: React.FC<{
  path: string;
  className?: string;
  onClick?: () => void;
}> = ({ path, className = '', onClick }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    setUrl(null);
    setFailed(false);
    void core.files.preview(path).then(
      (data) => {
        if (!alive) return;
        if (data.tooLarge || !data.contentBase64) {
          setFailed(true);
          return;
        }
        made = toObjectUrl(data.contentBase64, data.mimeType);
        setUrl(made);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);

  const base =
    'relative overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--sidebar-accent)] flex items-center justify-center select-none flex-shrink-0';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={imageName(path)}
        className={`${base} ${className}`}
      >
        {url && !failed ? (
          <img src={url} alt={imageName(path)} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <ImageOff size={14} className="text-[var(--muted-foreground)]" />
        )}
      </button>
    );
  }
  return (
    <div className={`${base} ${className}`} title={imageName(path)}>
      {url && !failed ? (
        <img src={url} alt={imageName(path)} className="h-full w-full object-cover" draggable={false} />
      ) : (
        <ImageOff size={14} className="text-[var(--muted-foreground)]" />
      )}
    </div>
  );
};
