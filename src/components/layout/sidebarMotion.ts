/**
 * Motion timing shared by every place the sidebar glides in or out — the
 * drag-to-collapse, the peek reveal/hide and the title-bar toggle. One
 * number so all three move at the same speed and can be tuned in one spot.
 */
export const SIDEBAR_ANIM_MS = 400;
/** Gentle ease-out: starts fast, settles softly — a drawer, not a fade. */
export const SIDEBAR_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** For the peek overlay, which moves the whole panel (transform + fade). */
export const sidebarTransition = `transform ${SIDEBAR_ANIM_MS}ms ${SIDEBAR_EASE}, opacity ${SIDEBAR_ANIM_MS}ms ${SIDEBAR_EASE}`;

/** For the docked sidebar, which shrinks in place (width + fade). */
export const sidebarSizeTransition = `width ${SIDEBAR_ANIM_MS}ms ${SIDEBAR_EASE}, opacity ${SIDEBAR_ANIM_MS}ms ${SIDEBAR_EASE}`;
