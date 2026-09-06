import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Database,
  File as FileIcon,
  FileCode,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  Image,
  Loader2,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import * as core from '../../services/core';
import { formatBytes } from '../../services/registry';
import type { FileNode } from '../../types';
import { FilePreview } from './FilePreview';

const CODE = /\.(ts|tsx|js|jsx|py|rs|c|h|cpp|cs|java|go|rb|php|sh|ps1|sql|json|ya?ml|toml|ini)$/i;
const DOC = /\.(pdf|docx?|txt|md|rtf|pptx?)$/i;
const SHEET = /\.(xlsx?|csv|tsv)$/i;
const IMG = /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;

/** File-type glyph shared with the tab strip, so open file tabs wear it too. */
export const iconFor = (node: FileNode, open: boolean) => {
  if (node.isDir)
    return open ? (
      <FolderOpen size={13} className="text-[var(--warning)] flex-shrink-0" />
    ) : (
      <Folder size={13} className="text-[var(--warning)] flex-shrink-0" />
    );
  // Badged script kinds, like the reference file icons.
  if (/\.(mjs|cjs|jsx?)$/i.test(node.name))
    return (
      <span className="flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-[3px] bg-[#e8c33a] text-[8px] font-bold leading-none text-black">
        JS
      </span>
    );
  if (/\.tsx?$/.test(node.name))
    return (
      <span className="flex h-[15px] w-[15px] flex-shrink-0 items-center justify-center rounded-[3px] bg-[#3178c6] text-[8px] font-bold leading-none text-white">
        TS
      </span>
    );
  if (CODE.test(node.name)) return <FileCode size={13} className="text-[var(--info)] flex-shrink-0" />;
  if (SHEET.test(node.name))
    return <FileSpreadsheet size={13} className="text-[var(--success)] flex-shrink-0" />;
  if (IMG.test(node.name)) return <Image size={13} className="text-[var(--accent-2)] flex-shrink-0" />;
  if (DOC.test(node.name)) return <FileText size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />;
  return <FileIcon size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />;
};

/* ------------------------------------------------------------------ */

/** Directory-listing cache: avoids N+1 IPC storms when expanding a tree. */
const dirCache = new Map<string, { at: number; nodes: FileNode[] }>();
const inflight = new Map<string, Promise<FileNode[]>>();
const DIR_CACHE_MS = 15_000;
const dirKey = (workspaceId: string, relPath: string) => `${workspaceId}\0${relPath}`;
function listCached(workspaceId: string, relPath: string): Promise<FileNode[]> {
  const key = dirKey(workspaceId, relPath);
  const hit = dirCache.get(key);
  if (hit && Date.now() - hit.at < DIR_CACHE_MS) return Promise.resolve(hit.nodes);
  const ongoing = inflight.get(key);
  if (ongoing) return ongoing;
  const p = core.files
    .list(workspaceId, relPath)
    .then((nodes) => {
      dirCache.set(key, { at: Date.now(), nodes });
      return nodes;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}
export const invalidateDirCache = (workspaceId?: string) => {
  if (!workspaceId) dirCache.clear();
  else for (const k of [...dirCache.keys()]) if (k.startsWith(`${workspaceId}\0`)) dirCache.delete(k);
};

/** File-list width limits: the list never collapses past a readable width,
// and the preview always keeps enough room to show code. */
const DEFAULT_TREE_WIDTH = 218;
const MIN_TREE_WIDTH = 150;
const MIN_PREVIEW_WIDTH = 200;

const Row: React.FC<{
  node: FileNode;
  depth: number;
  workspaceId: string;
  /** Changes when the tree should re-read itself. See `FileExplorerView`. */
  epoch: string;
  filter: string;
  selectedPath: string | null;
  absPathOf: (node: FileNode) => string;
  onOpenFile: (node: FileNode) => void;
}> = ({ node, depth, workspaceId, epoch, filter, selectedPath, absPathOf, onOpenFile }) => {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The listing is a function of what is open and how fresh the tree is, which
  // is why it lives in an effect and not in the click handler: a run that
  // writes into a folder the operator already expanded refreshes it, instead
  // of showing the contents from before the run until it is collapsed and
  // opened again.
  useEffect(() => {
    if (!open) return;
    let current = true;
    setLoading(true);
    void listCached(workspaceId, node.relPath).then(
        (next) => {
          if (!current) return;
          setChildren(next);
          setError(null);
        },
        (reason: unknown) => {
          if (current) setError(reason instanceof Error ? reason.message : String(reason));
        },
      )
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [open, epoch, workspaceId, node.relPath]);

  const activate = () => {
    if (!node.isDir) {
      onOpenFile(node);
      return;
    }
    setOpen((current) => !current);
  };

  // Filter hides non-matching files; directories stay visible so a match
  // inside a collapsed folder remains discoverable by expanding it.
  const query = filter.trim().toLowerCase();
  if (!node.isDir && query && !node.name.toLowerCase().includes(query)) {
    return null;
  }
  const selected = !node.isDir && selectedPath !== null && absPathOf(node) === selectedPath;

  return (
    <>
      <button
        onClick={activate}
        aria-expanded={node.isDir ? open : undefined}
        aria-label={`${node.isDir ? 'Folder' : 'File'} ${node.name}`}
        aria-current={selected ? true : undefined}
        className={`w-full flex items-center px-2 py-1 transition group text-left rounded-md ${
          selected ? 'bg-[var(--accent)]' : 'hover:bg-[var(--muted)]'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        title={node.relPath}
      >
        <span className="w-3 flex-shrink-0 text-[var(--muted-foreground)]">
          {node.isDir &&
            (loading ? (
              <Loader2 size={9} className="animate-spin" />
            ) : open ? (
              <ChevronDown size={10} />
            ) : (
              <ChevronRight size={10} />
            ))}
        </span>
        <span className="mr-1.5">{iconFor(node, open)}</span>
        <span className={`text-[11.5px] text-[var(--foreground)] group-hover:text-[var(--foreground)] truncate flex-1 min-w-0 ${selected ? 'font-medium' : ''}`}>
          {node.name}
        </span>
        {node.indexed && (
          <span className="flex-shrink-0 ml-1.5" title="Present in the knowledge index">
            <Database size={9} className="text-[var(--info)]" />
          </span>
        )}
        {!node.isDir && (
          <span className="text-[10px] text-[var(--input)] tabular-nums flex-shrink-0 ml-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 transition">
            {formatBytes(node.sizeBytes)}
          </span>
        )}
      </button>

      {error && (
        <p
          className="text-[10.5px] text-[var(--destructive)] py-1"
          style={{ paddingLeft: `${28 + depth * 12}px` }}
        >
          {error}
        </p>
      )}

      {open &&
        children?.map((child) => (
          <Row
            key={child.relPath}
            node={child}
            depth={depth + 1}
            workspaceId={workspaceId}
            epoch={epoch}
            filter={filter}
            selectedPath={selectedPath}
            absPathOf={absPathOf}
            onOpenFile={onOpenFile}
          />
        ))}

      {open && children?.length === 0 && (
        <p
          className="text-[10.5px] text-[var(--input)] py-1"
          style={{ paddingLeft: `${28 + depth * 12}px` }}
        >
          empty
        </p>
      )}
    </>
  );
};

/* ------------------------------------------------------------------ */

/**
 * Files inside the approved workspace, listed by the core.
 *
 * The tree stops at the workspace boundary because that is where the tool
 * layer stops too — there is no path from here to the rest of the disk.
 */
export const FileExplorerView: React.FC = () => {
  const { activeWorkspace, approveWorkspace, coreStatus, fileChanges } = useApp();

  const [roots, setRoots] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(DEFAULT_TREE_WIDTH);
  const [dragging, setDragging] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ grab: number } | null>(null);

  const wsId = activeWorkspace?.id;
  const approved = activeWorkspace?.approved ?? false;

  // Selecting a file previews it in the right-hand pane of this same tab —
  // it never takes over the whole panel.
  const absPathOf = useCallback(
    (file: FileNode) => {
      const root = (activeWorkspace?.path ?? '').replace(/[\\/]+$/, '');
      const relative = file.relPath.replace(/\//g, '\\');
      return `${root}\\${relative}`;
    },
    [activeWorkspace?.path],
  );

  useEffect(() => {
    setSelectedPath(null);
    setFilter('');
  }, [wsId]);

  const clampTreeWidth = useCallback((width: number) => {
    const containerWidth = splitRef.current?.getBoundingClientRect().width ?? width + MIN_PREVIEW_WIDTH;
    const max = Math.max(MIN_TREE_WIDTH, containerWidth - MIN_PREVIEW_WIDTH);
    return Math.min(Math.max(MIN_TREE_WIDTH, width), max);
  }, []);

  const beginTreeResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    // Grab offset between the pointer and the tree's right edge, so the
    // splitter never jumps on grab — the pointer keeps its exact spot.
    const rect = splitRef.current?.getBoundingClientRect();
    dragStart.current = {
      grab: (rect ? rect.right - event.clientX : treeWidth) - treeWidth,
    };
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      if (!dragStart.current) return;
      const rect = splitRef.current?.getBoundingClientRect();
      if (!rect) return;
      // The tree docks to the container's right edge: its width is measured
      // straight from the live pointer position, so dragging left always
      // widens the tree and dragging right always narrows it — no sign to
      // get backwards, no snapshot to go stale.
      setTreeWidth(clampTreeWidth(rect.right - event.clientX - dragStart.current.grab));
    };
    const end = () => {
      dragStart.current = null;
      setDragging(false);
    };
    const previousCursor = document.body.style.cursor;
    const previousSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    return () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousSelect;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
  }, [dragging, clampTreeWidth]);

  // Why the tree reloads on its own: a run writes its files as the operator
  // approves them, and a folder that still reads "This folder is empty" after
  // that is the app telling them the work did not happen. The run's change
  // list is the signal — it gains an entry the moment a write lands — reduced
  // to a string so a fresh array holding the same changes does not reload.
  const changeKey = fileChanges
    .map((c) => `${c.path}:${c.status}:${c.additions}:${c.deletions}`)
    .join('|');
  const epoch = changeKey;

  const load = useCallback(async () => {
    if (!wsId || !approved) return;
    invalidateDirCache(wsId);
    setLoading(true);
    try {
      setRoots(await listCached(wsId, ''));
      setError(null);
    } catch (e) {
      setRoots(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [wsId, approved]);

  useEffect(() => {
    void load();
  }, [load, epoch]);

  if (!activeWorkspace) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Folder size={20} className="text-[var(--border)] mb-2.5" />
        <p className="text-[12px] text-[var(--muted-foreground)] leading-relaxed">
          No workspace selected. Add a folder in the sidebar — tools operate only inside folders you
          approve.
        </p>
      </div>
    );
  }

  if (!approved) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <ShieldAlert size={20} className="text-[var(--warning)] mb-2.5" />
        <p className="text-[12px] text-[var(--foreground)] leading-relaxed">
          <span className="font-medium">{activeWorkspace.name}</span> is not approved.
        </p>
        <p className="text-[11px] text-[var(--muted-foreground)] mt-1.5 leading-relaxed max-w-xs">
          Nothing is read, written or indexed here until you approve it. Approving grants read access
          to this folder; writes still ask individually.
        </p>
        <button
          onClick={() => void approveWorkspace(activeWorkspace.id)}
          className="mt-3 px-3 py-1.5 rounded-md bg-[var(--warning-soft)] border border-[var(--warning-ring)] text-[11px] text-[var(--warning)] hover:bg-[var(--warning-soft)] transition"
        >
          Approve this folder
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={splitRef} className="flex-1 flex flex-row-reverse min-h-0">
        <div
          className="flex-shrink-0 flex flex-col min-h-0 border-l border-[var(--muted)]"
          style={{ width: treeWidth }}
        >
          <div className="px-2 py-2 flex-shrink-0">
            <label className="file-filter flex items-center gap-1.5 px-2 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--background)] focus-within:border-[var(--primary-ring)] transition">
              <Search size={12} className="text-[var(--muted-foreground)] flex-shrink-0" />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filter files"
                aria-label="Filter files"
                className="flex-1 min-w-0 bg-transparent outline-none border-0 p-0 text-[11.5px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)]"
              />
            </label>
          </div>

          <div className="flex-1 overflow-y-auto py-1 px-1">
            {error ? (
              <p className="px-3 py-2 text-[11px] text-[var(--destructive)] leading-relaxed">
                {coreStatus.state === 'unavailable' ? coreStatus.detail : error}
              </p>
            ) : loading && roots === null ? (
              <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
                Reading folder…
              </p>
            ) : roots?.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">
                This folder is empty.
              </p>
            ) : (
              roots?.map((node) => (
                <Row
                  key={node.relPath}
                  node={node}
                  depth={0}
                  workspaceId={activeWorkspace.id}
                  epoch={epoch}
                  filter={filter}
                  selectedPath={selectedPath}
                  absPathOf={absPathOf}
                  onOpenFile={(file) => setSelectedPath(absPathOf(file))}
                />
              ))
            )}
          </div>
        </div>

        <div
          role="separator"
          aria-label="Resize file list"
          aria-orientation="vertical"
          aria-valuenow={Math.round(treeWidth)}
          aria-valuemin={MIN_TREE_WIDTH}
          onPointerDown={beginTreeResize}
          onDoubleClick={() => setTreeWidth(DEFAULT_TREE_WIDTH)}
          className="group/split w-1.5 flex-shrink-0 cursor-col-resize touch-none flex items-center"
          title="Drag to resize file list (double-click to reset)"
        >
          {/* Slim 1px line that only brightens a touch on hover — never a band. */}
          <div
            aria-hidden="true"
            className={`mx-auto h-full w-px transition-colors ${
              dragging ? 'bg-[var(--muted-foreground)]' : 'bg-transparent group-hover/split:bg-[var(--muted-foreground)]'
            }`}
          />
        </div>

        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          {selectedPath ? (
            <FilePreview key={selectedPath} path={selectedPath} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
              <Folder size={28} className="text-[var(--border)] mb-3" strokeWidth={1.25} />
              <p className="text-[13px] font-medium text-[var(--foreground)]">Open file</p>
              <p className="text-[11.5px] text-[var(--muted-foreground)] mt-1.5">
                Select a file to open
              </p>
            </div>
          )}
        </div>
      </div>

      <div className="px-2.5 py-1.5 border-t border-[var(--muted)] flex items-center space-x-1.5 flex-shrink-0">
        <Database size={9} className="text-[var(--info)] flex-shrink-0" />
        <span className="text-[10px] text-[var(--input)] leading-relaxed">
          marks files already in the local index
        </span>
      </div>
    </div>
  );
};
