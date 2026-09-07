import React, { useEffect, useRef, useState } from 'react';
import { clampWidth } from './sidebarWidth';

/**
 * One draggable edge for the app's shared left column — the chat sidebar and
 * the settings nav both sit on the same stored width, so they share the whole
 * drag gesture, not just the value (this was two ~35-line copies before).
 *
 * Behaviour both surfaces rely on:
 * - The width clamps to [SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX].
 * - Dragging the handle below `collapseAt` collapses the column instead of
 *   parking it at a sliver (the docked chat sidebar does this; the settings
 *   nav passes no threshold and never collapses).
 * - Only a real pointerup persists (via onSettled). The width reached at a
 *   pointercancel is an interrupted drag — a touch steal or OS snap — not a
 *   width the operator settled on, so nothing is written out on cancel.
 */
export interface ColumnResizeOptions {
  /** Initial width (e.g. readStoredWidth(), or 0 for a glide-in reopen). */
  initialWidth: () => number;
  /** Widths below this end the drag in onCollapse instead of clamping. */
  collapseAt?: number;
  /** Fired once when a drag crosses below `collapseAt`. */
  onCollapse?: () => void;
  /** Fired with the settled width when a drag ends on pointerup. */
  onSettled?: (width: number) => void;
}

export const useColumnResize = ({
  initialWidth,
  collapseAt,
  onCollapse,
  onSettled,
}: ColumnResizeOptions) => {
  const [width, setWidth] = useState<number>(initialWidth);
  const widthRef = useRef(width);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ x: number; width: number } | null>(null);

  // Live refs so the window handlers below never act on a stale callback (the
  // gesture effect only subscribes once per drag start). Synced after every
  // render, with no dep array — not during render.
  const collapseAtRef = useRef(collapseAt);
  const onCollapseRef = useRef(onCollapse);
  const onSettledRef = useRef(onSettled);
  useEffect(() => {
    collapseAtRef.current = collapseAt;
    onCollapseRef.current = onCollapse;
    onSettledRef.current = onSettled;
  });

  // Keep a live copy of the width for settle and for the Sidebar's close/exit
  // effect — those must not re-run on every pixel of a drag, but need the most
  // recent width when a collapse or release happens.
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStart.current = { x: event.clientX, width: widthRef.current };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      if (!resizeStart.current) return;
      const next = resizeStart.current.width + event.clientX - resizeStart.current.x;
      if (collapseAtRef.current !== undefined && next < collapseAtRef.current) {
        resizeStart.current = null;
        setResizing(false);
        onCollapseRef.current?.();
        return;
      }
      // Names and rows stay fully rendered while resizing — truncation only
      // clips the text, so nothing vanishes before the collapse point.
      setWidth(clampWidth(next));
    };
    const settle = () => {
      resizeStart.current = null;
      setResizing(false);
      // A finished drag is a settled choice — the moment the width is written
      // out (the double-click reset on the handle is the other).
      onSettledRef.current?.(widthRef.current);
    };
    const cancel = () => {
      // Interrupted mid-gesture (pointercancel): nothing is a settled choice.
      resizeStart.current = null;
      setResizing(false);
    };
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', settle);
    window.addEventListener('pointercancel', cancel);
    return () => {
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', settle);
      window.removeEventListener('pointercancel', cancel);
    };
  }, [resizing]);

  return { width, setWidth, widthRef, resizing, beginResize };
};
