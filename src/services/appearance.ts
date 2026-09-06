export type ColorTheme = 'nerve' | 'ocean' | 'forest' | 'zero';
export type ColorMode = 'system' | 'light' | 'dark';

export interface AppearancePreferences {
  theme: ColorTheme;
  colorMode: ColorMode;
  headerStyle: 'auto' | 'windows' | 'macos' | 'linux';
  closeToTray: boolean;
  /**
   * Interface font size in px. Applied as a proportional zoom over the whole
   * workbench (14 = designed size), so every surface — sidebar, transcript,
   * composer, panels, settings — scales together instead of only the text
   * that happens to use relative units.
   */
  fontSize: number;
}

const STORAGE_KEY = 'servergen.appearance.v1';

/** Designed size: the px values throughout the UI read as drawn here. */
export const UI_FONT_BASE = 14;
export const UI_FONT_MIN = 10;
export const UI_FONT_MAX = 18;

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: 'nerve',
  colorMode: 'dark',
  headerStyle: 'auto',
  closeToTray: true,
  fontSize: 12,
};

/** Proportional zoom for a font-size choice — 1 at the designed size. */
export function uiZoomFor(fontSize: number): number {
  const clamped = Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, Math.round(fontSize)));
  return Math.round((clamped / UI_FONT_BASE) * 1000) / 1000;
}

export function readAppearance(): AppearancePreferences {
  try {
    const parsed = safeParseAppearance(localStorage.getItem(STORAGE_KEY));
    return { ...DEFAULT_APPEARANCE, ...parsed };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function safeParseAppearance(raw: string | null): Partial<AppearancePreferences> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    // hasOwnProperty (not `in`) so TS does not narrow Record<string,unknown> to never.
    const has = (k: string) => Object.prototype.hasOwnProperty.call(parsed, k);
    if (has('__proto__') || has('constructor') || has('prototype')) return {};
    const rec = parsed as Record<string, unknown>;
    const out: Partial<AppearancePreferences> = {};
    if (rec.theme === 'chatgpt') out.theme = 'zero';
    else if (rec.theme === 'nerve' || rec.theme === 'ocean' || rec.theme === 'forest' || rec.theme === 'zero') out.theme = rec.theme;
    if (rec.colorMode === 'system' || rec.colorMode === 'light' || rec.colorMode === 'dark')
      out.colorMode = rec.colorMode;
    if (rec.headerStyle === 'auto' || rec.headerStyle === 'windows' || rec.headerStyle === 'macos' || rec.headerStyle === 'linux')
      out.headerStyle = rec.headerStyle;
    if (typeof rec.closeToTray === 'boolean') out.closeToTray = rec.closeToTray;
    if (typeof rec.fontSize === 'number' && Number.isFinite(rec.fontSize)) {
      out.fontSize = Math.min(UI_FONT_MAX, Math.max(UI_FONT_MIN, Math.round(rec.fontSize)));
    }
    return out;
  } catch {
    return {};
  }
}

export function applyAppearance(value: AppearancePreferences): void {
  const root = document.documentElement;
  const dark =
    value.colorMode === 'dark' ||
    (value.colorMode === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  root.dataset.theme = value.theme;
  root.dataset.colorMode = dark ? 'dark' : 'light';
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  // Interface scaling lives on the #root mount, never on <html>: viewport
  // units (100vh/100vw) resolve against the unzoomed window and would then be
  // scaled down a second time, leaving the shell short of the window with a
  // dead band along the bottom and right. Sizing the mount up by the inverse
  // factor cancels that exactly — its rendered box is always the window —
  // while everything inside scales uniformly, like browser zoom. Pointer
  // coordinates, fixed overlays and drag math stay in one consistent space,
  // so no per-component adjustments are needed.
  root.style.removeProperty('zoom');
  const mount = document.getElementById('root');
  if (mount) {
    const zoom = uiZoomFor(value.fontSize ?? DEFAULT_APPEARANCE.fontSize);
    const span = Math.round((100 / zoom) * 1000) / 1000;
    mount.style.setProperty('zoom', String(zoom));
    mount.style.setProperty('width', `${span}vw`);
    mount.style.setProperty('height', `${span}vh`);
  }
}

export function saveAppearance(value: AppearancePreferences): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  applyAppearance(value);
  window.dispatchEvent(new CustomEvent('servergen:appearance', { detail: value }));
}

export function initializeAppearance(): void {
  const current = readAppearance();
  applyAppearance(current);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const next = readAppearance();
    if (next.colorMode === 'system') applyAppearance(next);
  });
}
