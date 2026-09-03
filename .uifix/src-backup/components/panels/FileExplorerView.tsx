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
      <FolderOpen size={13} className="text-amber-400/90 flex-shrink-0" />
    ) : (
      <Folder size={13} className="text-amber-400/70 flex-shrink-0" />
    );
  if (CODE.test(node.name)) return <FileCode size={13} className="text-sky-400/80 flex-shrink-0" />;
  if (SHEET.test(node.name))
    return <FileSpreadsheet size={13} className="text-emerald-400/80 flex-shrink-0" />;
  if (IMG.test(node.name)) return <Image size={13} className="text-violet-400/80 flex-shrink-0" />;
  if (DOC.test(node.name)) return <FileText size={13} className="text-[#a1a1aa] flex-shrink-0" />;
  return <FileIcon size={13} className="text-[#6b6d75] flex-shrink-0" />;
};

/* ------------------------------------------------------------------ */

const Row: React.FC<{
  node: FileNode;
  depth: number;
  workspaceId: string;
  onOpenFile: (node: FileNode) => void;
}> = ({ node, depth, workspaceId, onOpenFile }) => {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expand = async () => {
    if (!node.isDir) {
      onOpenFile(node);
      return;
    }
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      setLoading(true);
      try {
        setChildren(await core.files.list(workspaceId, node.relPath));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
  };

  return (
    <>
      <button
        onClick={() => void expand()}
        className="w-full flex items-center px-2 py-[3px] hover:bg-[#1a1b21] transition group text-left"
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        title={node.relPath}
      >
        <span className="w-3 flex-shrink-0 text-[#5f6169]">
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
        <span className="text-[11.5px] text-[#c4c4c8] group-hover:text-white truncate flex-1 min-w-0">
          {node.name}
        </span>
        {node.indexed && (
          <span className="flex-shrink-0 ml-1.5" title="Present in the knowledge index">
            <Database size={9} className="text-cyan-500/70" />
          </span>
        )}
        {!node.isDir && (
          <span className="text-[10px] text-[#4a4c53] tabular-nums flex-shrink-0 ml-2 opacity-0 group-hover:opacity-100 transition">
            {formatBytes(node.sizeBytes)}
          </span>
        )}
      </button>

      {error && (
        <p
          className="text-[10.5px] text-red-400/80 py-1"
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
            onOpenFile={onOpenFile}
          />
        ))}

      {open && children?.length === 0 && (
        <p
          className="text-[10.5px] text-[#4a4c53] py-1"
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
  const { activeWorkspace, approveWorkspace, ingestFiles, coreStatus } = useApp();

  const [roots, setRoots] = useState<FileNode[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const wsId = activeWorkspace?.id;
  const approved = activeWorkspace?.approved ?? false;

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
  }, [load, nonce]);

  if (!activeWorkspace) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <Folder size={20} className="text-[#3a3d47] mb-2.5" />
        <p className="text-[12px] text-[#71717a] leading-relaxed">
          No workspace selected. Add a folder in the sidebar — tools operate only inside folders you
          approve.
        </p>
      </div>
    );
  }

  if (!approved) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <ShieldAlert size={20} className="text-amber-500 mb-2.5" />
        <p className="text-[12px] text-[#c4c4c8] leading-relaxed">
          <span className="font-medium">{activeWorkspace.name}</span> is not approved.
        </p>
        <p className="text-[11px] text-[#71717a] mt-1.5 leading-relaxed max-w-xs">
          Nothing is read, written or indexed here until you approve it. Approving grants read access
          to this folder; writes still ask individually.
        </p>
        <button
          onClick={() => void approveWorkspace(activeWorkspace.id)}
          className="mt-3 px-3 py-1.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-400 hover:bg-amber-500/15 transition"
        >
          Approve this folder
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-2.5 py-2 border-b border-[#1a1b21] flex items-center justify-between flex-shrink-0">
        <div className="min-w-0">
          <p className="text-[11.5px] text-[#d4d4d8] truncate">{activeWorkspace.name}</p>
          <p
            className="text-[10px] text-[#5f6169] font-mono truncate"
            title={activeWorkspace.path}
          >
            {activeWorkspace.path}
          </p>
        </div>
        <div className="flex items-center space-x-1 flex-shrink-0 ml-2">
          <button
            onClick={() => void ingestFiles()}
            className="px-2 py-1 rounded text-[10.5px] text-[#8e8e93] hover:bg-[#1f212a] hover:text-white transition"
            title="Ingest a document for extraction"
          >
            Ingest
          </button>
          <button
            onClick={() => setNonce((n) => n + 1)}
            className="p-1.5 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {error ? (
          <p className="px-3 py-2 text-[11px] text-red-400/90 leading-relaxed">
            {coreStatus.state === 'unavailable' ? coreStatus.detail : error}
          </p>
        ) : loading && roots === null ? (
          <p className="px-3 py-2 text-[11px] text-[#5f6169]">Reading folder…</p>
        ) : roots?.length === 0 ? (
          <p className="px-3 py-2 text-[11px] text-[#5f6169]">This folder is empty.</p>
        ) : (
          roots?.map((node) => (
            <Row
              key={node.relPath}
              node={node}
              depth={0}
              workspaceId={activeWorkspace.id}
              onOpenFile={() => {
                // Opening a file is an ingestion decision, not a preview: the core
                // decides whether it needs OCR, native extraction, or nothing.
                void ingestFiles();
              }}
            />
          ))
        )}
      </div>

      <div className="px-2.5 py-1.5 border-t border-[#1a1b21] flex items-center space-x-1.5 flex-shrink-0">
        <Database size={9} className="text-cyan-500/70 flex-shrink-0" />
        <span className="text-[10px] text-[#4a4c53] leading-relaxed">
          marks files already in the local index
        </span>
      </div>
    </div>
  );
};
