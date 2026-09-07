/**
 * One width for the app's left column, shared by the chat sidebar and the
 * settings nav: the operator drags either edge and the other comes back at
 * the same size. Kept in localStorage the same way the sidebar-open flag is
 * (AppContext), so the choice survives view switches, collapse/reopen and
 * app restarts.
 */

/** Usable range and default for the docked sidebar / settings nav. */
export const SIDEBAR_WIDTH_MIN = 180;
export const SIDEBAR_WIDTH_MAX = 480;
export const SIDEBAR_WIDTH_DEFAULT = 260;

/** Clamp to the usable range (a drag can overshoot by design). */
export const clampWidth = (width: number): number =>
  Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width));

/** The last settled width, or the default if none is stored yet. */
export const readStoredWidth = (): number => {
  try {
    const stored = Number(localStorage.getItem('zeroleak.sidebar-width.v1'));
    if (Number.isFinite(stored)) return clampWidth(stored);
  } catch {
    /* Storage blocked: the default width. */
  }
  return SIDEBAR_WIDTH_DEFAULT;
};

/** Persist a settled width; the closing glide's zero is not a choice. */
export const storeWidth = (width: number): void => {
  if (width < SIDEBAR_WIDTH_MIN) return;
  try {
    localStorage.setItem('zeroleak.sidebar-width.v1', String(width));
  } catch {
    /* Storage blocked: the width will not survive a reload. */
  }
};
