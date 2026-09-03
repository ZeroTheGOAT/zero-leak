export type ColorTheme = 'nerve' | 'ocean' | 'forest';
export type ColorMode = 'system' | 'light' | 'dark';

export interface AppearancePreferences {
  theme: ColorTheme;
  colorMode: ColorMode;
  headerStyle: 'auto' | 'windows' | 'macos' | 'linux';
  closeToTray: boolean;
}

const STORAGE_KEY = 'servergen.appearance.v1';

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: 'nerve',
  colorMode: 'dark',
  headerStyle: 'auto',
  closeToTray: true,
};

export function readAppearance(): AppearancePreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<AppearancePreferences>;
    return { ...DEFAULT_APPEARANCE, ...stored };
  } catch {
    return DEFAULT_APPEARANCE;
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
