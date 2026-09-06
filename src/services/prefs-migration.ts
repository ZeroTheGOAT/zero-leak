/*
 * One-time migration of the pre-rebrand preference keys.
 *
 * The Servergen → ZeroLeak rename changed every localStorage key prefix
 * (`servergen.*` → `zeroleak.*`). Without this pass, an upgrading install
 * silently loses its persisted state: theme and font size, sidebar and dock
 * state, composer mode, the last open chat and project, tool toggles and the
 * transcription preferences. Runs once at boot, before anything reads the
 * new keys: each legacy value is copied across only when the new key holds
 * nothing yet (a newer choice always wins), and the legacy key is removed
 * either way. The retired Ctrl+/- body zoom is not carried over — that
 * feature is gone and a second zoom must never return (see
 * services/appearance.ts) — so its key is simply dropped under both prefixes.
 */
const MIGRATED_KEYS = [
  'sidebar-open.v1',
  'bottom-panel-open.v1',
  'pinned-summary.v1',
  'composer-mode.v1',
  'active-session.v1',
  'active-workspace.v1',
  'appearance.v1',
  'workbench-preferences.v1',
] as const;

const LEGACY_PREFIX = 'servergen.';
const CURRENT_PREFIX = 'zeroleak.';

export function migrateLegacyPreferenceKeys(): void {
  try {
    for (const suffix of MIGRATED_KEYS) {
      const legacy = `${LEGACY_PREFIX}${suffix}`;
      const next = `${CURRENT_PREFIX}${suffix}`;
      const raw = localStorage.getItem(legacy);
      if (raw !== null && localStorage.getItem(next) === null) {
        localStorage.setItem(next, raw);
      }
      localStorage.removeItem(legacy);
    }
    localStorage.removeItem(`${LEGACY_PREFIX}ui-zoom.v1`);
    localStorage.removeItem(`${CURRENT_PREFIX}ui-zoom.v1`);
  } catch {
    /* Storage blocked: the workbench starts from its defaults. */
  }
}
