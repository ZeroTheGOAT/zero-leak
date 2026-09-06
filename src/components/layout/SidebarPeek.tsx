import React, { useEffect, useRef, useState } from 'react';
import { Sidebar } from './Sidebar';
import { SIDEBAR_ANIM_MS, sidebarTransition } from './sidebarMotion';

/**
 * The collapsed-sidebar hover overlay. While the docked sidebar is closed, a
 * thin invisible strip at the left edge arms this: the cursor touching it
 * glides the sidebar in over the content, and leaving glides it back out.
 *
 * It lives in its own component so its show/hide state unmounts with the
 * collapsed layout — opening the docked sidebar simply drops the overlay, and
 * the next collapse starts from a clean, hidden state.
 */
export const SidebarPeek: React.FC = () => {
  const [visible, setVisible] = useState(false);
  // Off-canvas (translateX(-100%)) vs. parked at the left edge. Kept true on
  // the first mount so the very first show glides in rather than popping.
  const [hidden, setHidden] = useState(true);
  const hideTimer = useRef<number | null>(null);
  const showRaf = useRef<number | null>(null);

  const show = () => {
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    if (visible) {
      // Re-entering while it glides out: reverse the exit in place.
      if (showRaf.current !== null) {
        window.cancelAnimationFrame(showRaf.current);
        showRaf.current = null;
      }
      setHidden(false);
      return;
    }
    // First show: mount off-canvas, then glide in. The flip has to wait two
    // frames — if it happens on the same frame as the mount (a single rAF
    // fires before the browser ever paints the hidden position), the first
    // painted state is already fully shown and the entrance snaps instead of
    // gliding. One rAF lets the hidden frame paint, the next triggers the
    // transition from it.
    if (showRaf.current !== null) window.cancelAnimationFrame(showRaf.current);
    setVisible(true);
    setHidden(true);
    showRaf.current = window.requestAnimationFrame(() => {
      showRaf.current = window.requestAnimationFrame(() => {
        showRaf.current = null;
        setHidden(false);
      });
    });
  };

  const hide = () => {
    if (showRaf.current !== null) {
      window.cancelAnimationFrame(showRaf.current);
      showRaf.current = null;
    }
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    setHidden(true);
    // Keep it mounted through the exit motion, then drop it.
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setVisible(false);
    }, SIDEBAR_ANIM_MS);
  };

  useEffect(
    () => () => {
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (showRaf.current !== null) window.cancelAnimationFrame(showRaf.current);
    },
    [],
  );

  return (
    <>
      {/* Invisible hover strip at the left edge — the collapsed sidebar
          reveals itself only here (or via the title-bar toggle), exactly
          like the reference. */}
      <div
        aria-hidden="true"
        onMouseEnter={show}
        className="absolute left-0 top-0 bottom-0 z-40 w-2.5 cursor-default"
      />
      {visible && (
        <div
          onMouseEnter={show}
          onMouseLeave={hide}
          className="absolute left-0 top-0 bottom-0 z-50 shadow-2xl"
          style={{
            transform: hidden ? 'translateX(-100%)' : 'translateX(0%)',
            opacity: hidden ? 0 : 1,
            transition: sidebarTransition,
          }}
        >
          {/* Floating overlay — no resize handle (see Sidebar's floating prop). */}
          <Sidebar floating />
        </div>
      )}
    </>
  );
};
