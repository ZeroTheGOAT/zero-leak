import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Frame,
  Layers,
  Maximize2,
  Minus,
  Plus,
  ScanText,
  Table2,
  Tag,
  Trash2,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatBytes, modelById } from '../../services/registry';
import type { BlockKind, DocBlock, IngestedDocument } from '../../types';

const BLOCK_TONE: Record<BlockKind, string> = {
  text: 'border-sky-400/70 bg-sky-400/5',
  heading: 'border-violet-400/70 bg-violet-400/5',
  table: 'border-emerald-400/70 bg-emerald-400/5',
  figure: 'border-amber-400/70 bg-amber-400/5',
  tag: 'border-orange-400/80 bg-orange-400/10',
  handwriting: 'border-pink-400/70 bg-pink-400/5',
};

const BLOCK_LABEL: Record<BlockKind, string> = {
  text: 'Text',
  heading: 'Heading',
  table: 'Table',
  figure: 'Figure',
  tag: 'Tag',
  handwriting: 'Handwriting',
};

/* ------------------------------------------------------------------ */
/* Page image with normalised bbox overlays                           */
/* ------------------------------------------------------------------ */

const PageCanvas: React.FC<{
  doc: IngestedDocument;
  page: number;
  zoom: number;
  showBoxes: boolean;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}> = ({ doc, page, zoom, showBoxes, selectedId, onSelect }) => {
  const blocks = doc.blocks.filter((b) => b.bbox.page === page);

  return (
    <div className="flex-1 overflow-auto bg-[#0a0b0d] p-4">
      <div
        className="relative mx-auto bg-white shadow-2xl origin-top transition-transform duration-150"
        style={{
          width: `${Math.round(zoom * 620)}px`,
          transform: 'none',
        }}
      >
        {doc.previewUri ? (
          <img
            src={doc.previewUri}
            alt={`${doc.fileName} page ${page}`}
            className="w-full block select-none"
            draggable={false}
          />
        ) : (
          // No raster preview (native text extraction, or a preview not yet
          // rendered). The overlay still positions correctly on a blank page.
          <div className="w-full" style={{ aspectRatio: '1 / 1.414' }} />
        )}

        {showBoxes &&
          blocks.map((b) => {
            const selected = selectedId === b.id;
            return (
              <button
                key={b.id}
                onClick={() => onSelect(selected ? null : b.id)}
                className={`absolute border transition-all ${BLOCK_TONE[b.kind]} ${
                  selected ? 'ring-2 ring-white/70 z-10' : 'hover:bg-white/10'
                }`}
                style={{
                  left: `${b.bbox.x * 100}%`,
                  top: `${b.bbox.y * 100}%`,
                  width: `${b.bbox.w * 100}%`,
                  height: `${b.bbox.h * 100}%`,
                }}
                title={`${BLOCK_LABEL[b.kind]}${
                  b.confidence !== undefined ? ` · ${(b.confidence * 100).toFixed(0)}%` : ''
                }\n${b.text.slice(0, 160)}`}
              />
            );
          })}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Removing an extraction                                             */
/* ------------------------------------------------------------------ */

/**
 * Arms on the first click and removes on the second.
 *
 * Reading a scanned P&ID costs a model load and a minute of inference, so a
 * stray click on a small icon should not be able to throw that away.
 */
const RemoveButton: React.FC<{ id: string; fileName: string; size?: number }> = ({
  id,
  fileName,
  size = 12,
}) => {
  const { removeDocument } = useApp();
  const [armed, setArmed] = useState(false);

  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        void removeDocument(id);
      }}
      onBlur={() => setArmed(false)}
      title={
        armed
          ? `Click again to forget the text read out of ${fileName}`
          : `Forget this extraction (the file on disk is kept)`
      }
      className={`p-1 rounded transition flex-shrink-0 ${
        armed
          ? 'text-red-400 bg-red-500/15'
          : 'text-[#5f6169] hover:text-red-400 hover:bg-red-500/10'
      }`}
    >
      <Trash2 size={size} />
    </button>
  );
};

/* ------------------------------------------------------------------ */
/* The list shown when no particular document is open                 */
/* ------------------------------------------------------------------ */

/**
 * Everything the core has already read, so an extraction can be reopened or
 * removed without going through the file picker again.
 */
const DocumentList: React.FC = () => {
  const { documents, activeDocumentId, openDocument, ingestFiles } = useApp();

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-2.5 py-2 border-b border-[#1a1b21] flex items-center justify-between flex-shrink-0">
        <span className="text-[11px] text-[#8e8e93]">
          {documents.length} extracted {documents.length === 1 ? 'document' : 'documents'}
        </span>
        <button
          onClick={() => void ingestFiles()}
          className="px-2 py-1 rounded-md bg-[#1f212a] border border-[#2a2c34] text-[10.5px] text-[#d4d4d8] hover:bg-[#252834] hover:text-white transition"
        >
          Open a document
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {documents.map((d) => {
          const m = modelById(d.modelId);
          return (
            <div
              key={d.id}
              className={`group flex items-center rounded-md transition ${
                d.id === activeDocumentId ? 'bg-[#1f212a]' : 'hover:bg-[#1a1b21]'
              }`}
            >
              <button
                onClick={() => void openDocument(d.id)}
                className="flex-1 min-w-0 text-left px-2 py-1.5"
                title={d.path}
              >
                <div className="flex items-center space-x-1.5 min-w-0">
                  {d.extraction === 'native' ? (
                    <FileText size={11} className="text-emerald-500 flex-shrink-0" />
                  ) : (
                    <ScanText size={11} className="text-sky-400 flex-shrink-0" />
                  )}
                  <span className="text-[11.5px] text-[#d4d4d8] truncate">{d.fileName}</span>
                </div>
                <div className="text-[10px] text-[#5f6169] mt-0.5 truncate">
                  {d.pageCount} {d.pageCount === 1 ? 'page' : 'pages'} · {formatBytes(d.sizeBytes)}
                  {d.entities.length > 0 && ` · ${d.entities.length} tags`}
                  {m ? ` · ${m.displayName}` : d.extraction === 'native' ? ' · native text' : ''}
                </div>
              </button>
              <RemoveButton id={d.id} fileName={d.fileName} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */

const BlockRow: React.FC<{
  block: DocBlock;
  selected: boolean;
  onSelect: () => void;
}> = ({ block, selected, onSelect }) => (
  <button
    onClick={onSelect}
    className={`w-full text-left px-2.5 py-1.5 rounded-md transition ${
      selected ? 'bg-[#252834]' : 'hover:bg-[#1a1b21]'
    }`}
  >
    <div className="flex items-center justify-between text-[10px] mb-0.5">
      <span className="text-[#6b6d75]">
        {BLOCK_LABEL[block.kind]} · p.{block.bbox.page}
      </span>
      {block.confidence !== undefined && (
        <span
          className={`tabular-nums ${
            block.confidence < 0.7 ? 'text-amber-500' : 'text-[#5f6169]'
          }`}
          title="OCR confidence"
        >
          {(block.confidence * 100).toFixed(0)}%
        </span>
      )}
    </div>
    <p className="text-[11.5px] text-[#c4c4c8] leading-relaxed line-clamp-3 whitespace-pre-wrap">
      {block.text}
    </p>
  </button>
);

/**
 * §4 — a document with its extraction visible and traceable.
 *
 * Bounding boxes are normalised 0..1, so they stay aligned at any zoom, and
 * every block keeps the page it came from. Where extraction was native, no
 * confidence is shown, because there is no score to report — nothing is
 * invented to fill the column.
 */
export const DocumentViewer: React.FC<{ documentId?: string }> = ({ documentId }) => {
  const { documents, ingestFiles } = useApp();

  // A tab opened without a document is the index, and stays the index. Following
  // whatever was opened last would leave the panel's own `Document` entry showing
  // one arbitrary file with no way back to the others.
  const doc = useMemo(
    () => (documentId ? documents.find((d) => d.id === documentId) : undefined),
    [documents, documentId],
  );

  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [showBoxes, setShowBoxes] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [side, setSide] = useState<'blocks' | 'tables' | 'entities'>('blocks');

  const shape = useMemo(
    () => ({
      blocks: doc?.blocks.length ?? 0,
      tables: doc?.tables.length ?? 0,
      entities: doc?.entities.length ?? 0,
    }),
    [doc],
  );

  /*
   * Open on a pane that has something in it.
   *
   * Not every extraction has text blocks: a photograph read for its condition
   * comes back as a property table and nothing else, and a pane reading "no text
   * blocks on this page" beside a tab holding nine rows looks like an extraction
   * that failed. The key includes whether the blocks have arrived, because a row
   * from `document_list` carries its tags before it carries its text — so the
   * choice is made again once the full record is in. Once per document either
   * way, so a deliberate click is never overridden.
   */
  const settled = useRef<string | null>(null);
  useEffect(() => {
    if (!doc) return;
    const key = `${doc.id}:${shape.blocks > 0 || shape.tables > 0}`;
    if (settled.current === key) return;
    settled.current = key;
    const first = (['blocks', 'tables', 'entities'] as const).find((k) => shape[k] > 0);
    if (first) setSide(first);
  }, [doc, shape]);

  if (!doc) {
    // Nothing to show for this tab. If the core has read files before, that
    // list is more useful than a dead end with a picker button on it.
    if (documents.length > 0) return <DocumentList />;
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <FileText size={22} className="text-[#3a3d47] mb-2.5" />
        <p className="text-[12px] text-[#71717a]">No document open.</p>
        <button
          onClick={() => void ingestFiles()}
          className="mt-3 px-3 py-1.5 rounded-md bg-[#1f212a] border border-[#2a2c34] text-[11px] text-[#d4d4d8] hover:bg-[#252834] hover:text-white transition"
        >
          Open a document
        </button>
      </div>
    );
  }

  const model = modelById(doc.modelId);
  const pageBlocks = doc.blocks.filter((b) => b.bbox.page === page);
  const pageTables = doc.tables.filter((t) => t.page === page);
  const lowConfidence = doc.blocks.filter((b) => (b.confidence ?? 1) < 0.7).length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="px-2.5 py-2 border-b border-[#1a1b21] flex-shrink-0 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[12px] text-[#d4d4d8] truncate min-w-0" title={doc.path}>
            {doc.fileName}
          </span>
          <div className="flex items-center flex-shrink-0 ml-2">
            <span className="text-[10px] text-[#5f6169] tabular-nums">
              {formatBytes(doc.sizeBytes)}
            </span>
            <RemoveButton id={doc.id} fileName={doc.fileName} size={11} />
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-1">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="p-1 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition disabled:opacity-25"
            >
              <ChevronLeft size={13} />
            </button>
            <span className="text-[10.5px] text-[#8e8e93] tabular-nums px-1">
              {page} / {doc.pageCount}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(doc.pageCount, p + 1))}
              disabled={page >= doc.pageCount}
              className="p-1 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition disabled:opacity-25"
            >
              <ChevronRight size={13} />
            </button>
          </div>

          <div className="flex items-center space-x-1">
            <button
              onClick={() => setShowBoxes(!showBoxes)}
              className={`p-1 rounded transition ${
                showBoxes ? 'text-sky-400 bg-sky-500/10' : 'text-[#71717a] hover:bg-[#1f212a]'
              }`}
              title="Toggle extraction overlay"
            >
              <Frame size={12} />
            </button>
            <button
              onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))}
              className="p-1 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition"
            >
              <Minus size={12} />
            </button>
            <span className="text-[10px] text-[#6b6d75] tabular-nums w-8 text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={() => setZoom((z) => Math.min(4, +(z + 0.25).toFixed(2)))}
              className="p-1 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition"
            >
              <Plus size={12} />
            </button>
            <button
              onClick={() => setZoom(1)}
              className="p-1 rounded text-[#71717a] hover:bg-[#1f212a] hover:text-white transition"
              title="Reset zoom"
            >
              <Maximize2 size={11} />
            </button>
          </div>
        </div>

        {/* How this text was obtained */}
        <div className="flex items-center space-x-2 text-[10px]">
          <span
            className={`flex items-center space-x-1 px-1.5 py-0.5 rounded ${
              doc.extraction === 'native'
                ? 'bg-emerald-500/10 text-emerald-500'
                : doc.extraction === 'pending'
                  ? 'bg-[#1f212a] text-[#71717a]'
                  : 'bg-sky-500/10 text-sky-400'
            }`}
            title={
              doc.extraction === 'native'
                ? 'The file carried its own text layer — no OCR was run and no model was loaded.'
                : 'No text layer, so the page was read by a model.'
            }
          >
            {doc.extraction === 'native' ? <FileText size={10} /> : <ScanText size={10} />}
            <span>
              {doc.extraction === 'native' ? 'native text' : doc.extraction}
              {model && ` · ${model.displayName}`}
            </span>
          </span>

          {lowConfidence > 0 && (
            <span className="text-amber-500" title="Blocks below 70% confidence">
              {lowConfidence} low-confidence
            </span>
          )}

          <span className="text-[#3f4147] font-mono truncate" title={`SHA-256 ${doc.sha256}`}>
            {doc.sha256.slice(0, 12)}
          </span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <PageCanvas
          doc={doc}
          page={page}
          zoom={zoom}
          showBoxes={showBoxes}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        {/* Extraction side panel */}
        <div className="w-72 border-l border-[#1a1b21] flex flex-col min-h-0 flex-shrink-0">
          <div className="flex items-center px-1.5 pt-1.5 space-x-0.5 flex-shrink-0">
            {(
              [
                ['blocks', 'Text', Layers, pageBlocks.length],
                ['tables', 'Tables', Table2, pageTables.length],
                ['entities', 'Tags', Tag, doc.entities.length],
              ] as const
            ).map(([key, label, Icon, count]) => (
              <button
                key={key}
                onClick={() => setSide(key)}
                className={`flex items-center space-x-1 px-2 py-1 rounded text-[10.5px] transition ${
                  side === key
                    ? 'bg-[#252834] text-white'
                    : 'text-[#8e8e93] hover:bg-[#1a1b21] hover:text-[#d4d4d8]'
                }`}
              >
                <Icon size={10} />
                <span>{label}</span>
                {count > 0 && <span className="text-[#5f6169] tabular-nums">{count}</span>}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
            {side === 'blocks' &&
              (pageBlocks.length === 0 ? (
                <p className="text-[11px] text-[#5f6169] p-2 leading-relaxed">
                  No text blocks on this page.
                </p>
              ) : (
                pageBlocks.map((b) => (
                  <BlockRow
                    key={b.id}
                    block={b}
                    selected={selectedId === b.id}
                    onSelect={() => setSelectedId(selectedId === b.id ? null : b.id)}
                  />
                ))
              ))}

            {side === 'tables' &&
              (pageTables.length === 0 ? (
                <p className="text-[11px] text-[#5f6169] p-2 leading-relaxed">
                  No tables detected on this page.
                </p>
              ) : (
                pageTables.map((t) => (
                  <div key={t.id} className="rounded-md border border-[#22242c] overflow-hidden">
                    <div className="overflow-x-auto">
                      <table className="w-full text-[10px]">
                        <thead>
                          <tr className="bg-[#1a1b21]">
                            {t.header.map((h, i) => (
                              <th
                                key={i}
                                className="px-1.5 py-1 text-left text-[#a1a1aa] font-medium whitespace-nowrap border-r border-[#22242c] last:border-0"
                              >
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {t.rows.map((row, ri) => (
                            <tr key={ri} className="border-t border-[#16171c]">
                              {row.map((cell, ci) => (
                                <td
                                  key={ci}
                                  className="px-1.5 py-1 text-[#c4c4c8] whitespace-nowrap border-r border-[#16171c] last:border-0 tabular-nums"
                                >
                                  {cell}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))
              ))}

            {side === 'entities' &&
              (doc.entities.length === 0 ? (
                <p className="text-[11px] text-[#5f6169] p-2 leading-relaxed">
                  No equipment tags, line numbers or instruments detected.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1 p-1">
                  {doc.entities.map((e) => (
                    <span
                      key={e}
                      className="px-1.5 py-0.5 rounded bg-orange-500/10 text-orange-300 text-[10.5px] font-mono"
                    >
                      {e}
                    </span>
                  ))}
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
};
