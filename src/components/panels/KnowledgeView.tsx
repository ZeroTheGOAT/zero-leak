import React, { useState } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Eye,
  EyeOff,
  FilePlus2,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatBytes, modelById } from '../../services/registry';
import type { IndexStatus } from '../../types';

const STATUS_ICON: Record<IndexStatus, React.ElementType> = {
  queued: Clock,
  indexing: Loader2,
  indexed: Check,
  failed: AlertTriangle,
  stale: RefreshCw,
};

const STATUS_TONE: Record<IndexStatus, string> = {
  queued: 'text-[var(--muted-foreground)]',
  indexing: 'text-[var(--info)]',
  indexed: 'text-[var(--success)]',
  failed: 'text-[var(--destructive)]',
  stale: 'text-[var(--warning)]',
};

/**
 * §5 — the local index. Embeddings are produced on this machine by BGE-M3 and
 * stored in SQLite alongside an FTS index; nothing is sent anywhere to be
 * embedded. Every chunk keeps its source path and page so answers can cite.
 */
export const KnowledgeView: React.FC = () => {
  const {
    knowledgeStats,
    knowledgeSources,
    indexFiles,
    reindexSource,
    removeSource,
    toggleWatching,
    openDocumentAt,
    settings,
  } = useApp();

  const embedModel = modelById(knowledgeStats.embeddingModelId);
  const failed = knowledgeSources.filter((s) => s.status === 'failed');

  /**
   * The source whose remove button has been armed by a first click.
   *
   * Dropping a file from the index costs an embedding pass to undo, and until it
   * is back no answer can cite it. Worth a second click on an icon this small.
   */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Stats */}
      <div className="px-3 py-2.5 border-b border-[var(--muted)] flex-shrink-0">
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <p className="text-[15px] text-[var(--foreground)] tabular-nums">{knowledgeStats.documents}</p>
            <p className="text-[10px] text-[var(--muted-foreground)]">documents</p>
          </div>
          <div>
            <p className="text-[15px] text-[var(--foreground)] tabular-nums">
              {knowledgeStats.chunks.toLocaleString()}
            </p>
            <p className="text-[10px] text-[var(--muted-foreground)]">chunks</p>
          </div>
          <div>
            <p className="text-[15px] text-[var(--foreground)] tabular-nums">
              {formatBytes(knowledgeStats.indexBytes)}
            </p>
            <p className="text-[10px] text-[var(--muted-foreground)]">on disk</p>
          </div>
        </div>

        <p className="text-[10px] text-[var(--muted-foreground)] mt-2.5 leading-relaxed">
          {embedModel?.displayName ?? knowledgeStats.embeddingModelId} · {knowledgeStats.embeddingDim}
          -dim vectors · {settings.hybridRetrieval ? 'hybrid dense + BM25' : 'dense only'} · top-
          {settings.retrievalTopK}
        </p>

        <div className="flex items-center space-x-1.5 mt-2.5">
          <button
            onClick={() => void indexFiles()}
            className="flex-1 flex items-center justify-center space-x-1.5 px-2 py-1.5 rounded-md bg-[var(--card)] border border-[var(--border)] text-[11px] text-[var(--foreground)] hover:bg-[var(--popover)] hover:text-[var(--foreground)] transition"
          >
            <FilePlus2 size={11} />
            <span>Add documents</span>
          </button>
          <button
            onClick={() => void toggleWatching()}
            className={`flex items-center space-x-1.5 px-2 py-1.5 rounded-md border text-[11px] transition ${
              knowledgeStats.watching
                ? 'border-[var(--success-ring)] bg-[var(--success-soft)] text-[var(--success)]'
                : 'border-[var(--border)] text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)]'
            }`}
            title={
              knowledgeStats.watching
                ? `Watching for changes in ${knowledgeStats.watchedFolders.length} folder${
                    knowledgeStats.watchedFolders.length === 1 ? '' : 's'
                  }:\n${knowledgeStats.watchedFolders.join('\n')}`
                : 'Not watching — documents are indexed when you add them'
            }
          >
            {knowledgeStats.watching ? <Eye size={11} /> : <EyeOff size={11} />}
            <span>Watch</span>
          </button>
        </div>
      </div>

      {/* Sources */}
      <div className="flex-1 overflow-y-auto">
        {knowledgeSources.length === 0 ? (
          <div className="p-4 text-center">
            <p className="text-[12px] text-[var(--muted-foreground)]">Nothing indexed yet.</p>
            <p className="text-[11px] text-[var(--muted-foreground)] mt-1.5 leading-relaxed">
              Add reports, drawings, procedures or spreadsheets and they become searchable with
              citations back to the exact page.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[var(--accent)]">
            {knowledgeSources.map((s) => {
              const Icon = STATUS_ICON[s.status];
              return (
                <div key={s.id} className="px-3 py-2 group hover:bg-[var(--sidebar)] transition">
                  <div className="flex items-start justify-between">
                    <button
                      onClick={() => void openDocumentAt(s.path)}
                      className="flex items-start space-x-2 min-w-0 text-left flex-1"
                      title={s.path}
                    >
                      <Icon
                        size={11}
                        className={`flex-shrink-0 mt-1 ${STATUS_TONE[s.status]} ${
                          s.status === 'indexing' ? 'animate-spin' : ''
                        }`}
                      />
                      <span className="min-w-0">
                        <span className="block text-[12px] text-[var(--foreground)] truncate">
                          {s.fileName}
                        </span>
                        <span className="block text-[10px] text-[var(--muted-foreground)] tabular-nums mt-0.5">
                          {s.kind.replace('_', ' ')} · {formatBytes(s.sizeBytes)}
                          {s.chunks > 0 && ` · ${s.chunks} chunks`}
                        </span>
                      </span>
                    </button>

                    {/*
                      Armed keeps the group visible: the opacity lives here rather
                      than on the button, so without this the second click would be
                      aimed at something the pointer had just made invisible.
                    */}
                    <div
                      className={`flex items-center space-x-0.5 flex-shrink-0 transition ${
                        confirmRemove === s.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100'
                      }`}
                    >
                      <button
                        onClick={() => void reindexSource(s.id)}
                        aria-label={`Re-index ${s.path}`}
                        className="p-1 rounded text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)]"
                        title="Re-index this file"
                      >
                        <RefreshCw size={11} />
                      </button>
                      <button
                        onClick={() => {
                          if (confirmRemove === s.id) {
                            setConfirmRemove(null);
                            void removeSource(s.id);
                          } else {
                            setConfirmRemove(s.id);
                          }
                        }}
                        onBlur={() =>
                          setConfirmRemove((cur) => (cur === s.id ? null : cur))
                        }
                        className={`p-1 rounded hover:bg-[var(--border)] ${
                          confirmRemove === s.id
                            ? 'text-[var(--destructive)]'
                            : 'text-[var(--muted-foreground)] hover:text-[var(--destructive)]'
                        }`}
                        title={
                          confirmRemove === s.id
                            ? 'Click again to drop this file from the index'
                            : 'Remove from index'
                        }
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>

                  {s.error && (
                    <p className="text-[10.5px] text-[var(--destructive)] mt-1 ml-[19px] leading-relaxed">
                      {s.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {failed.length > 0 && (
        <div className="px-3 py-2 border-t border-[var(--muted)] flex-shrink-0">
          <p className="text-[10.5px] text-[var(--warning)] leading-relaxed">
            {failed.length} {failed.length === 1 ? 'file' : 'files'} failed to index. The rest of
            the index is unaffected and still queryable.
          </p>
        </div>
      )}
    </div>
  );
};
