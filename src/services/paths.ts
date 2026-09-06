/** Shared path/encoding helpers — single source of truth for filename logic. */

/** Mirrors `IMAGE_EXTS` in src-tauri/src/attachments.rs. */
export const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'webp',
  'bmp',
  'tif',
  'tiff',
  'gif',
]);

/** `C:\a\b.txt` / `/a/b.txt` -> `b.txt`. Never throws on empty input. */
export const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path;

export const isImagePath = (path: string): boolean => {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot === -1) return false;
  return IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};

/** Chunked base64 -> bytes without blowing the call stack on large payloads. */
export function decodeBase64(value: string): Uint8Array {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let offset = 0; offset < raw.length; offset += 65_536) {
    const end = Math.min(raw.length, offset + 65_536);
    for (let i = offset; i < end; i += 1) bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

export function base64ToObjectUrl(contentBase64: string, mimeType: string): string {
  const bytes = decodeBase64(contentBase64);
  return URL.createObjectURL(
    new Blob([bytes.slice() as unknown as BlobPart], { type: mimeType || 'application/octet-stream' }),
  );
}

/** Safe JSON parse for persisted UI state — rejects `__proto__` pollution. */
export function safeParseRecord(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(parsed, k);
    if (has('__proto__') || has('constructor') || has('prototype')) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
