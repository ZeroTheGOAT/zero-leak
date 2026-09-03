import React, { useCallback, useEffect, useState } from 'react';
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
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import * as core from '../../services/core';
import { formatBytes } from '../../services/registry';
import type { FileNode } from '../../types';

const CODE = /\.(ts|tsx|js|jsx|py|rs|c|h|cpp|cs|java|go|rb|php|sh|ps1|sql|json|ya?ml|toml|ini)$/i;
const DOC = /\.(pdf|docx?|txt|md|rtf|pptx?)$/i;
const SHEET = /\.(xlsx?|csv|tsv)$/i;
const IMG = /\.(png|jpe?g|webp|bmp|tiff?|gif)$/i;

const iconFor = (node: FileNode, open: boolean) => {
  if (node.isDir)
    return open ? (
      <FolderOpen size={13} className="text-[var(--warning)] flex-shrink-0" />
    ) : (
      <Folder size={13} className="text-[var(--warning)] flex-shrink-0" />
    );
  if (CODE.test(node.name)) return <FileCode size={13} className="text-[var(--info)] flex-shrink-0" />;
  if (SHEET.test(node.name))
    return <FileSpreadsheet size={13} className="text-[var(--success)] flex-shrink-0" />;
  if (IMG.test(node.name)) return <Image size={13} className="text-[var(--accent-2)] flex-shrink-0" />;
  if (DOC.test(node.name)) return <FileText size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />;
  return <FileIcon size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />;
};

/* ------------------------------------------------------------------ */

const Row: React.FC<{
  node: FileNode;
  depth: number;
  workspaceId: string;
  /** Changes when the tree should re-read itself. See `FileExplorerView`. */
  epoch: string;
  onOpenFile: (node: FileNode) => void;
}> = ({ node, depth, workspaceId, epoch, onOpenFile }) => {
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
    void core.files
      .list(workspaceId, node.relPath)
      .then(
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

  return (
    <>
      <button
        onClick={activate}
        className="w-full flex items-center px-2 py-[3px] hover:bg-[var(--muted)] transition group text-left"
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
        <span className="text-[11.5px] text-[var(--foreground)] group-hover:text-[var(--foreground)] truncate flex-1 min-w-0">
          {node.name}
        </span>
        {node.indexed && (
          <span className="flex-shrink-0 ml-1.5" title="Present in the knowledge index">
            <Database size={9} className="text-[var(--info)]" />
          </span>
        )}
        {!node.isDir && (
          <span className="text-[10px] text-[var(--input)] tabular-nums flex-shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition">
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
  const { activeWorkspace, approveWorkspace, ingestFiles, openTab, coreStatus, fileChanges } =
    useApp();

  const [roots, setRoots] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const wsId = activeWorkspace?.id;
  const approved = activeWorkspace?.approved ?? false;

  // Why the tree reloads on its own: a run writes its files as the operator
  // approves them, and a folder that still reads "This folder is empty" after
  // that is the app telling them the work did not happen. The run's change
  // list is the signal — it gains an entry the moment a write lands — reduced
  // to a string so a fresh array holding the same changes does not reload.
  const changeKey = fileChanges
    .map((c) => `${c.path}:${c.status}:${c.additions}:${c.deletions}`)
    .join('|');
  const epoch = `${nonce}:${changeKey}`;

  const load = useCallback(async () => {
    if (!wsId || !approved) return;
    setLoading(true);
    try {
      setRoots(await core.files.list(wsId, ''));
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
      <div className="px-2.5 py-2 border-b border-[var(--muted)] flex items-center justify-between flex-shrink-0">
        <div className="min-w-0">
          <p className="text-[11.5px] text-[var(--foreground)] truncate">{activeWorkspace.name}</p>
          <p
            className="text-[10px] text-[var(--muted-foreground)] font-mono truncate"
            title={activeWorkspace.path}
          >
            {activeWorkspace.path}
          </p>
        </div>
        <div className="flex items-center space-x-1 flex-shrink-0 ml-2">
          <button
            onClick={() => void ingestFiles()}
            className="px-2 py-1 rounded text-[10.5px] text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
            title="Ingest a document for extraction"
          >
            Ingest
          </button>
          <button
            onClick={() => setNonce((n) => n + 1)}
            className="p-1.5 rounded text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {error ? (
          <p className="px-3 py-2 text-[11px] text-[var(--destructive)] leading-relaxed">
            {coreStatus.state === 'unavailable' ? coreStatus.detail : error}
          </p>
        ) : loading && roots === null ? (
          <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">Reading folder…</p>
        ) : roots?.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-[var(--muted-foreground)]">This folder is empty.</p>
        ) : (
          roots?.map((node) => (
            <Row
              key={node.relPath}
              node={node}
              depth={0}
              workspaceId={activeWorkspace.id}
              epoch={epoch}
              onOpenFile={(file) => {
                const root = activeWorkspace.path.replace(/[\\/]+$/, '');
                const relative = file.relPath.replace(/\//g, '\\');
                openTab('file', file.name, undefined, `${root}\\${relative}`);
              }}
            />
          ))
        )}
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
