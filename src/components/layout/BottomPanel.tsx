import React, { useEffect, useRef, useState } from 'react';
import { Terminal, X } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { SandboxConsole } from '../panels/SandboxConsole';

/**
 * Bottom dock hosting the sandbox terminal.
 * View → Toggle Bottom Panel shows/hides it. Height is draggable from the
 * top edge; double-click restores the default.
 */
export const BottomPanel: React.FC = () => {
  const { isBottomPanelOpen, setIsBottomPanelOpen } = useApp();
  const [height, setHeight] = useState(220);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef<{ y: number; height: number } | null>(null);

  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    resizeStart.current = { y: event.clientY, height };
    setResizing(true);
  };

  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      if (!resizeStart.current) return;
      const next = resizeStart.current.height + resizeStart.current.y - event.clientY;
      setHeight(Math.min(Math.max(120, next), Math.max(120, window.innerHeight * 0.6)));
    };
    const end = () => {
      resizeStart.current = null;
      setResizing(false);
    };
    const previousCursor = document.body.style.cursor;
    document.body.style.cursor = 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      document.body.style.cursor = previousCursor;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [resizing]);

  if (!isBottomPanelOpen) return null;

  return (
    <section
      aria-label="Bottom panel — sandbox terminal"
      className="relative flex flex-shrink-0 flex-col border-t border-[var(--border)] bg-[var(--background)] min-h-0"
      style={{ height }}
    >
      <div
        role="separator"
        aria-label="Resize bottom panel"
        aria-orientation="horizontal"
        onPointerDown={beginResize}
        onDoubleClick={() => setHeight(220)}
        className="group/split absolute -top-1 left-0 right-0 z-[80] h-2 cursor-row-resize touch-none flex items-center"
        title="Drag up or down to resize"
      >
        {/* Slim 1px line that only brightens a touch on hover — never a band. */}
        <div
          aria-hidden="true"
          className={`mx-auto w-full h-px transition-colors ${
            resizing ? 'bg-[var(--muted-foreground)]' : 'bg-transparent group-hover/split:bg-[var(--muted-foreground)]'
          }`}
        />
      </div>
      {/* Minimal chrome, same background as the console below — the terminal
          reads as one clean surface. The clear-all control lives inside the
          console itself (shared with the side panel's Sandbox tab). */}
      <div className="flex h-8 flex-shrink-0 items-center gap-2 px-2.5">
        <Terminal size={13} className="text-[var(--info)]" />
        <span className="text-xs font-medium text-[var(--foreground)]">Terminal</span>
        <span className="flex-1" />
        <button
          onClick={() => setIsBottomPanelOpen(false)}
          aria-label="Hide bottom panel"
          title="Hide bottom panel"
          className="rounded p-1 text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SandboxConsole />
      </div>
    </section>
  );
};
