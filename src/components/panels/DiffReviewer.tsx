import React, { useMemo } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCheck,
  Clock,
  Eye,
  FileDiff,
  FileMinus,
  FilePlus,
  FileText,
  Undo2,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import type { FileChange } from '../../types';

/* ------------------------------------------------------------------ */
/* Line diff                                                          */
/* ------------------------------------------------------------------ */

type DiffLine = { kind: 'add' | 'del' | 'same'; text: string; oldNo?: number; newNo?: number };

/**
 * Longest-common-subsequence diff. Small enough to run in the render path for
 * the file sizes this app proposes, and it produces a real diff rather than a
 * whole-file replace, so a one-line edit reads as a one-line edit.
 */
const diffLines = (oldText: string, newText: string): DiffLine[] => {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];

  // Guard: LCS is O(n·m). Beyond this, fall back to a block replace.
  if (a.length * b.length > 400_000) {
    return [
      ...a.map((text, i) => ({ kind: 'del' as const, text, oldNo: i + 1 })),
      ...b.map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })),
    ];
  }

  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'same', text: a[i], oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i], oldNo: i + 1 });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], newNo: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i], oldNo: ++i });
  while (j < m) out.push({ kind: 'add', text: b[j], newNo: ++j });
  return out;
};

/** Collapse long runs of unchanged lines so the changes stay on screen. */
const withContext = (lines: DiffLine[], ctx = 3): Array<DiffLine | { kind: 'gap'; count: number }> => {
  const keep = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind === 'same') return;
    for (let k = Math.max(0, idx - ctx); k <= Math.min(lines.length - 1, idx + ctx); k++)
      keep.add(k);
  });

  const out: Array<DiffLine | { kind: 'gap'; count: number }> = [];
  let gap = 0;
  lines.forEach((l, idx) => {
    if (keep.has(idx)) {
      if (gap > 0) {
        out.push({ kind: 'gap', count: gap });
        gap = 0;
      }
      out.push(l);
    } else {
      gap++;
    }
  });
  if (gap > 0) out.push({ kind: 'gap', count: gap });
  return out;
};

/* ------------------------------------------------------------------ */

const STATUS_ICON: Record<FileChange['status'], React.ElementType> = {
  created: FilePlus,
  modified: FileText,
  deleted: FileMinus,
};

const STATUS_TONE: Record<FileChange['status'], string> = {
  created: 'text-[var(--success)]',
  modified: 'text-[var(--info)]',
  deleted: 'text-[var(--destructive)]',
};

/**
 * §6/§9 — every file this run changed, with the diff that changed it.
 *
 * A write reaches disk only after the operator has approved it, and the whole
 * diff is in the approval prompt, so what lands here is normally already on
 * disk — marked applied, with a revert beside it. This panel is therefore the
 * record of what a run did to the folder, and the place to undo any of it. An
 * entry not marked applied is one still waiting to be written, and it can be
 * written from here. Plan mode is offered no write tool at all, so a Plan run
 * puts nothing on this screen.
 */
export const DiffReviewer: React.FC = () => {
  const {
    fileChanges,
    selectedChangePath,
    setSelectedChangePath,
    applyChange,
    discardChange,
    applyAllChanges,
    discardAllChanges,
    mode,
  } = useApp();

  const selected = useMemo(
    () => fileChanges.find((c) => c.path === selectedChangePath) ?? fileChanges[0],
    [fileChanges, selectedChangePath],
  );

  const rendered = useMemo(
    () => (selected ? withContext(diffLines(selected.oldContent, selected.newContent)) : []),
    [selected],
  );

  /**
   * What the run read before it wrote this file.
   *
   * Shown because of a real turn: asked for a note about test point TP-04, the
   * agent wrote a fluent paragraph giving its thickness as 12.3 mm against a
   * tolerance of 11.5 to 13.0 mm without opening anything. TP-04 measures 7.1 mm
   * and is below its limit. The diff looked exactly like a diff written off the
   * readings, and nothing on this screen said otherwise. Now it does.
   */
  const grounding = selected?.grounding ?? [];

  if (fileChanges.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <FileDiff size={20} className="text-[var(--border)] mb-2.5" />
        <p className="text-[12px] text-[var(--muted-foreground)] leading-relaxed max-w-xs">
          No file changes in this chat. When the agent writes a file it asks first and shows the
          whole diff — then the file and its diff appear here, so any of it can be undone.
        </p>
        {mode === 'plan' && (
          <p className="text-[11px] text-[var(--muted-foreground)] mt-2 flex items-center space-x-1.5">
            <Eye size={10} />
            <span>Plan mode — the agent cannot write at all right now.</span>
          </p>
        )}
      </div>
    );
  }

  const pending = fileChanges.filter((c) => !c.applied);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* File list */}
      <div className="border-b border-[var(--muted)] flex-shrink-0 max-h-40 overflow-y-auto">
        {fileChanges.map((c) => {
          const Icon = STATUS_ICON[c.status];
          const active = c.path === selected?.path;
          return (
            <button
              key={c.path}
              onClick={() => setSelectedChangePath(c.path)}
              className={`w-full flex items-center px-2.5 py-1.5 transition text-left ${
                active ? 'bg-[var(--card)]' : 'hover:bg-[var(--muted)]'
              }`}
              title={c.path}
            >
              <Icon size={12} className={`${STATUS_TONE[c.status]} flex-shrink-0 mr-2`} />
              <span
                className={`text-[11.5px] truncate flex-1 min-w-0 ${
                  active ? 'text-[var(--foreground)]' : 'text-[var(--foreground)]'
                }`}
              >
                {c.path}
              </span>
              {/* The counts are what makes one row in this list worth reading,
                  so they stay on screen for a written file too; whether it is
                  on disk is a glyph beside them rather than a replacement. */}
              <span className="flex items-center space-x-1.5 text-[10px] tabular-nums flex-shrink-0 ml-2">
                <span className="text-[var(--success)]">+{c.additions}</span>
                <span className="text-[var(--destructive)]">-{c.deletions}</span>
                {c.applied ? (
                  <span className="text-[var(--success)]" title="Written to disk">
                    <Check size={9} />
                  </span>
                ) : (
                  <span className="text-[var(--warning)]" title="Not written yet">
                    <Clock size={9} />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      {/* Where the contents came from */}
      {selected &&
        (grounding.length > 0 ? (
          <div
            className="flex items-start px-2.5 py-1.5 border-b border-[var(--muted)] flex-shrink-0 bg-[var(--sidebar)]"
            title={grounding.join('\n')}
          >
            <BookOpen size={11} className="text-[var(--muted-foreground)] flex-shrink-0 mt-[3px] mr-2" />
            <p className="text-[10.5px] text-[var(--muted-foreground)] leading-relaxed min-w-0">
              Written after consulting{' '}
              <span className="text-[var(--muted-foreground)]">{grounding.join(', ')}</span>
            </p>
          </div>
        ) : (
          <div className="flex items-start px-2.5 py-1.5 border-b border-[var(--warning-ring)] flex-shrink-0 bg-[var(--warning-soft)]">
            <AlertTriangle size={11} className="text-[var(--warning)] flex-shrink-0 mt-[3px] mr-2" />
            <p className="text-[10.5px] text-[var(--warning)] leading-relaxed min-w-0">
              Nothing was read in this turn, so these contents are the model's own. Check any
              measurement, limit, date or tag in them against the source before accepting.
            </p>
          </div>
        ))}

      {/* Diff */}
      <div className="flex-1 overflow-auto bg-[var(--sidebar-accent)]">
        {selected && (
          <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.6]">
            <tbody>
              {rendered.map((row, idx) => {
                if (row.kind === 'gap')
                  return (
                    <tr key={`gap-${idx}`}>
                      <td colSpan={3} className="px-3 py-1 text-[10px] text-[var(--input)] bg-[var(--sidebar)]">
                        ⋯ {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
                      </td>
                    </tr>
                  );

                const tone =
                  row.kind === 'add'
                    ? 'bg-[var(--success-soft)] text-[var(--success)]'
                    : row.kind === 'del'
                      ? 'bg-[var(--destructive-soft)] text-[var(--destructive)]'
                      : 'text-[var(--muted-foreground)]';

                return (
                  <tr key={idx} className={tone}>
                    <td className="w-9 px-1.5 text-right text-[var(--input)] select-none tabular-nums align-top">
                      {row.oldNo ?? ''}
                    </td>
                    <td className="w-9 px-1.5 text-right text-[var(--input)] select-none tabular-nums align-top border-r border-[var(--muted)]">
                      {row.newNo ?? ''}
                    </td>
                    <td className="px-2 whitespace-pre-wrap break-all">
                      <span className="select-none text-[var(--muted-foreground)]">
                        {row.kind === 'add' ? '+ ' : row.kind === 'del' ? '- ' : '  '}
                      </span>
                      {row.text || ' '}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Actions */}
      <div className="border-t border-[var(--muted)] p-2.5 flex-shrink-0 space-y-2">
        {selected && !selected.applied ? (
          <div className="flex items-center space-x-2">
            <button
              onClick={() => void applyChange(selected.path)}
              className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-2 rounded-lg bg-[var(--success-soft)] border border-[var(--success-ring)] text-[12px] text-[var(--success)] hover:bg-[var(--success-soft)] transition"
            >
              <Check size={12} />
              <span>Write this file</span>
            </button>
            <button
              onClick={() => void discardChange(selected.path)}
              className="flex items-center justify-center space-x-1.5 px-3 py-2 rounded-lg border border-[var(--border)] text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
            >
              <X size={12} />
              <span>Discard</span>
            </button>
          </div>
        ) : selected?.applied ? (
          <button
            onClick={() => void discardChange(selected.path)}
            className="w-full flex items-center justify-center space-x-1.5 px-3 py-2 rounded-lg border border-[var(--border)] text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
            title="Restore the file to its previous contents"
          >
            <Undo2 size={12} />
            <span>Revert to previous contents</span>
          </button>
        ) : null}

        {/* Batch actions — a multi-file change that only means something whole
            gets one decision, not one per file. A file that cannot be written
            is skipped and reported by the core; the rest still go through. */}
        {pending.length > 1 && (
          <div className="flex items-center space-x-2">
            <button
              onClick={() => void applyAllChanges()}
              className="flex-1 flex items-center justify-center space-x-1.5 px-3 py-1.5 rounded-lg bg-[var(--success-soft)] border border-[var(--success-ring)] text-[11px] text-[var(--success)] hover:brightness-105 transition"
              title="Write every not-yet-applied file in this run. Files that fail stay in the panel with their reason."
            >
              <CheckCheck size={11} />
              <span>Write all {pending.length}</span>
            </button>
            <button
              onClick={() => void discardAllChanges()}
              className="flex items-center justify-center space-x-1.5 px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--muted-foreground)] hover:bg-[var(--card)] hover:text-[var(--foreground)] transition"
              title="Discard every proposal in this run (applied ones are reverted)"
            >
              <X size={11} />
              <span>Discard all</span>
            </button>
          </div>
        )}

        <p className="text-[10px] text-[var(--input)] leading-relaxed">
          {pending.length > 0
            ? pending.length > 1
              ? `${pending.length} of ${fileChanges.length} are not on disk yet. Review the diff above, then write them one at a time or all at once.`
              : `${pending.length} of ${fileChanges.length} is not on disk yet. Each file is written on its own — writing one does not write the rest.`
            : `${fileChanges.length === 1 ? 'This file is' : `All ${fileChanges.length} files are`} on disk. Their previous contents are kept here, so any of them can be reverted.`}
        </p>
      </div>
    </div>
  );
};
