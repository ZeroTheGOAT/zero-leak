import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  BadgeCheck,
  Copy,
  ExternalLink,
  FileDiff,
  FileOutput,
  FileText,
  Info,
  Loader2,
  Pencil,
  Quote,
  RotateCcw,
  Send,
  ShieldOff,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { PlanHandoff } from './PlanHandoff';
import { WorkSummary } from './WorkSummary';
import { ImageThumb, isImagePath, stagePastedImages } from './attachments';
import { basename } from '../../services/paths';
import type {
  Artifact,
  Attachment,
  ChatActivityBlock,
  ChatMessage,
  Citation,
  RunPhase,
} from '../../types';
import { formatBytes, formatDuration, modelById } from '../../services/registry';

/* ------------------------------------------------------------------ */
/* Run phase — the core's word on what the run is doing now            */
/* ------------------------------------------------------------------ */

const PHASE_FALLBACK: Record<RunPhase['phase'], string> = {
  reasoning: 'Thinking',
  executing: 'Working',
  answering: 'Writing the answer',
  waiting: 'Waiting',
  done: 'Done',
};

/**
 * The live status row: one line naming the current action, spinner while the
 * run is actually busy. The label comes from the core (`agent://phase`), so
 * what it says is what is happening — no timer on the frontend decides when
 * the spinner appears or disappears.
 */
const RunPhaseRow: React.FC<{ phase: RunPhase }> = ({ phase }) => (
  <div className="flex items-center space-x-2 text-[11px] text-[var(--muted-foreground)]">
    <span className="relative flex h-2 w-2 flex-shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--info)] opacity-60" />
      <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--info)]" />
    </span>
    <span>{phase.label || PHASE_FALLBACK[phase.phase]}</span>
  </div>
);

/* ------------------------------------------------------------------ */
/* Minimal markdown: fenced code, inline code, bold, bullets           */
/* ------------------------------------------------------------------ */

type Segment =
  | { type: 'code'; lang: string; text: string }
  | { type: 'prose'; text: string };

const splitFences = (src: string): Segment[] => {
  const out: Segment[] = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ type: 'prose', text: src.slice(last, m.index) });
    out.push({ type: 'code', lang: m[1] || 'text', text: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ type: 'prose', text: src.slice(last) });
  return out;
};

/*
 * A loopback URL in an answer is a link.
 *
 * An answer that ends "the site is at http://127.0.0.1:49731/" is only true if
 * the operator can act on that sentence, and inert grey text is how the app
 * ends up looking like it never started the server. The shape accepted here is
 * deliberately narrow — plain http, a host that is this machine, an explicit
 * port — and the click still goes to the core, which opens the URL only if it
 * is one of this app's own running servers. So this makes our servers
 * reachable and never turns the chat into a general-purpose URL opener.
 *
 * The path stops before sentence punctuation, so "…at http://127.0.0.1:49731/."
 * links the URL and leaves the full stop in the prose.
 */
const LOOPBACK = String.raw`http://(?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}(?:/(?:[^\s<>()"']*[^\s<>()"'.,;:!?])?)?`;

/** Bold, an inline code span, or a loopback URL. Code spans are matched first,
 *  so a URL written inside backticks stays one code span. */
const SEGMENT = new RegExp(`(\\*\\*[^*]+\\*\\*|\`[^\`]+\`|${LOOPBACK})`, 'g');
const IS_LOOPBACK = new RegExp(`^${LOOPBACK}$`);

const LoopbackLink: React.FC<{ url: string }> = ({ url }) => {
  const { openDevServerUrl } = useApp();
  return (
    <button
      onClick={() => void openDevServerUrl(url)}
      className="inline-flex items-center gap-1 text-[var(--info)] underline decoration-dotted hover:decoration-solid transition break-all text-left"
      title="Open this server in your browser"
    >
      <span>{url}</span>
      <ExternalLink size={10} className="flex-shrink-0" />
    </button>
  );
};

const inline = (text: string, keyBase: string): React.ReactNode[] =>
  text.split(SEGMENT).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith('**') && part.endsWith('**'))
      return (
        <strong key={key} className="font-semibold text-[var(--foreground)]">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith('`') && part.endsWith('`')) {
      // A model that writes its URL as `code` means the same thing by it.
      const body = part.slice(1, -1);
      return (
        <code key={key} className="px-1 py-0.5 rounded bg-[var(--border)] text-[var(--foreground)] text-[12px]">
          {IS_LOOPBACK.test(body) ? <LoopbackLink url={body} /> : body}
        </code>
      );
    }
    if (IS_LOOPBACK.test(part)) return <LoopbackLink key={key} url={part} />;
    return <span key={key}>{part}</span>;
  });

const CodeBlock: React.FC<{ lang: string; text: string }> = memo(({ lang, text }) => {
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      // Clipboard blocked (non-secure context): selection copy still works.
    }
  };
  return (
  <div className="my-2 rounded-lg border border-[var(--border)] overflow-hidden bg-[var(--sidebar-accent)]">
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--border)]">
      <span className="text-[10px] text-[var(--muted-foreground)] font-mono">{lang}</span>
      <button
        onClick={() => void copy()}
        aria-label={`Copy ${lang || 'code'} block to clipboard`}
        className="text-[var(--muted-foreground)] hover:text-[var(--foreground)] transition"
      >
        <Copy size={14} />
      </button>
    </div>
    <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-[var(--foreground)]">
      {text}
    </pre>
  </div>
  );
});

const Prose: React.FC<{ text: string }> = memo(({ text }) => (
  <>
    {text
      .split('\n')
      .map((line, i) => {
        const trimmed = line.trim();
        if (!trimmed) return <div key={i} className="h-2" />;

        const bullet = /^[-*]\s+(.*)$/.exec(trimmed);
        if (bullet)
          return (
            <div key={i} className="flex space-x-2 my-0.5">
              <span className="text-[var(--muted-foreground)] flex-shrink-0">·</span>
              <span>{inline(bullet[1], `b${i}`)}</span>
            </div>
          );

        const numbered = /^(\d+)\.\s+(.*)$/.exec(trimmed);
        if (numbered)
          return (
            <div key={i} className="flex space-x-2 my-0.5">
              <span className="text-[var(--muted-foreground)] tabular-nums flex-shrink-0">{numbered[1]}.</span>
              <span>{inline(numbered[2], `n${i}`)}</span>
            </div>
          );

        const heading = /^#{1,4}\s+(.*)$/.exec(trimmed);
        if (heading)
          return (
            <p key={i} className="font-semibold text-[var(--foreground)] mt-3 mb-1">
              {inline(heading[1], `h${i}`)}
            </p>
          );

        return (
          <p key={i} className="my-0.5">
            {inline(line, `p${i}`)}
          </p>
        );
      })}
  </>
));

const Markdown: React.FC<{ text: string; muted?: boolean }> = memo(({ text, muted = false }) => {
  const segs = useMemo(() => splitFences(text), [text]);
  return (
  <div
    className={`text-[13.5px] leading-relaxed ${
      muted ? 'text-[var(--muted-foreground)]' : 'text-[var(--foreground)]'
    }`}
  >
    {segs.map((seg, i) =>
      seg.type === 'code' ? (
        <CodeBlock key={i} lang={seg.lang} text={seg.text} />
      ) : (
        <Prose key={i} text={seg.text} />
      ),
    )}
  </div>
  );
});

/**
 * The live activity stream. Plans are deliberately NOT rendered here — the
 * run's checklist is docked at the bottom of the chat and updated in place,
 * so interleaved commentary and actions can never push a second copy into
 * the timeline.
 *
 * `thinkingLive` is true only while the core reports the run as reasoning
 * (`agent://phase`), so the Thinking header's spinner stops the moment
 * reasoning actually ends — not when the whole run ends. It applies to the
 * LAST block only: reasoning that has already been followed by an action or a
 * sentence is finished by definition, and applying one run-wide flag to every
 * block is what made a run show "Thinking" over and over down the page instead
 * of a settled "Thought for 4.2 s" per round.
 */
const ActivityFlow: React.FC<{
  blocks: ChatActivityBlock[];
  live?: boolean;
  thinkingLive?: boolean;
}> = ({ blocks, live = false, thinkingLive = false }) => {
  // ChatGPT pattern: ONE outer "Worked for Xs" card holds the whole run's
  // thinking + commentary + tool calls. The final answer renders below it.
  // Without this, every thinking/action alternation becomes its own card
  // and a single run fills the chat with a dozen stacked panels.
  const workBlocks = blocks.filter(
    (b) =>
      b.type === 'actions' ||
      b.type === 'console' ||
      (b.type === 'text' && (b.kind === 'thinking' || b.kind === 'commentary')),
  );
  const answerBlocks = blocks.filter((b) => b.type === 'text' && b.kind === 'answer');
  return (
    <div className="space-y-2.5">
      {workBlocks.length > 0 && (
        <WorkSummary blocks={workBlocks} live={live} thinkingLive={thinkingLive} />
      )}
      {answerBlocks.map((block) =>
        block.type === 'text' ? <Markdown key={block.id} text={block.text} /> : null,
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Citations and artifacts                                            */
/* ------------------------------------------------------------------ */

const Citations: React.FC<{ citations: Citation[] }> = ({ citations }) => {
  const { openDocumentAt } = useApp();
  return (
    <div className="mt-2.5 space-y-1">
      <div className="flex items-center space-x-1.5 text-[10px] text-[var(--muted-foreground)]">
        <Quote size={10} />
        <span>
          {citations.length} {citations.length === 1 ? 'source' : 'sources'}
        </span>
      </div>
      {citations.map((c, i) => (
        <button
          key={i}
          onClick={() => void openDocumentAt(c.path, c)}
          className="w-full text-left px-2.5 py-1.5 rounded-md bg-[var(--sidebar)] border border-[var(--border)] hover:border-[var(--border)] transition group"
          title={c.path}
        >
          <span className="flex items-center justify-between text-[11px]">
            <span className="text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] truncate">
              {c.fileName}
              {c.page !== undefined && <span className="text-[var(--muted-foreground)]"> · p.{c.page}</span>}
            </span>
            <span className="text-[var(--muted-foreground)] tabular-nums flex-shrink-0 ml-2">
              Source
            </span>
          </span>
          <span className="block text-[11px] text-[var(--muted-foreground)] mt-0.5 leading-relaxed line-clamp-2">
            {c.snippet}
          </span>
        </button>
      ))}
    </div>
  );
};

const Artifacts: React.FC<{ artifacts: Artifact[] }> = ({ artifacts }) => {
  const { openArtifact, verifyArtifact } = useApp();
  return (
    <div className="mt-2.5 space-y-1">
      {artifacts.map((a) => (
        <div
          key={a.id}
          className="flex items-center justify-between px-2.5 py-2 rounded-md bg-[var(--sidebar)] border border-[var(--border)]"
        >
          <div className="flex items-center space-x-2.5 min-w-0">
            <FileOutput size={13} className="text-[var(--muted-foreground)] flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-[12px] text-[var(--foreground)] truncate">{a.fileName}</p>
              <p className="text-[10px] text-[var(--muted-foreground)]">
                {a.kind.toUpperCase()} · {formatBytes(a.sizeBytes)}
                {a.verified ? (
                  <span className="text-[var(--success)]"> · verified openable</span>
                ) : (
                  <span className="text-[var(--warning)]"> · not yet verified</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-1 flex-shrink-0">
            {!a.verified && (
              <button
                onClick={() => void verifyArtifact(a.id)}
                className="p-1.5 rounded text-[var(--muted-foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition"
                title="Reopen and check the file parses"
              >
                <BadgeCheck size={13} />
              </button>
            )}
            <button
              onClick={() => void openArtifact(a.id)}
              className="px-2 py-1 rounded text-[11px] text-[var(--foreground)] hover:bg-[var(--border)] hover:text-[var(--foreground)] transition"
            >
              Open
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* One message                                                        */
/* ------------------------------------------------------------------ */

/* ChatGPT-style timestamp: "Aug 14, 7:06 PM". */
const formatChatTime = (ts: number): string => {
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
};

/* Hover actions under one message: copy the text; edit & resend, offered only
 * on a user message whose row the core has confirmed (rowId) while the chat is
 * idle. ChatGPT-style: transparent inline row, timestamp + small muted icons,
 * no card background, no native tooltip box (aria-label only). */
const BubbleActions: React.FC<{
  msg: ChatMessage;
  editable?: boolean;
  onEdit?: () => void;
  align?: 'right' | 'left';
  showTime?: boolean;
}> = memo(({ msg, editable = false, onEdit, align = 'right', showTime = true }) => (
  <div
    className={`flex items-center gap-1.5 bg-transparent opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 focus-within:opacity-100 ${
      align === 'right' ? 'justify-end' : 'justify-start'
    }`}
  >
    {showTime && (
      <span className="text-[12px] leading-4 text-[var(--muted-foreground)] tabular-nums">
        {formatChatTime(msg.createdAt)}
      </span>
    )}
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(msg.content).catch(() => {});
      }}
      aria-label="Copy message text"
      className="flex items-center justify-center rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
    >
      <Copy size={14} />
    </button>
    {editable && onEdit && (
      <button
        type="button"
        onClick={onEdit}
        aria-label="Edit this message"
        className="flex items-center justify-center rounded p-1 text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
      >
        <Pencil size={14} />
      </button>
    )}
  </div>
));

/* Thumbnails for the images a message carried; everything else stays a chip
 * with its name. A click opens the file preview tab. */
const AttachmentGrid: React.FC<{ attachments: Attachment[]; onRemove?: (path: string) => void }> = ({
  attachments,
  onRemove,
}) => {
  const { openTab } = useApp();
  return (
    <div className="flex flex-wrap items-start gap-1.5">
      {attachments.map((a) =>
        isImagePath(a.path) ? (
          <span key={a.id} className="relative flex-shrink-0">
            <ImageThumb
              path={a.path}
              className="h-14 w-14"
              onClick={() => void openTab('file', a.fileName, undefined, a.path)}
            />
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(a.path)}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border nerve-border bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm transition hover:text-[var(--foreground)]"
                title="Remove image from this edit"
              >
                <X size={10} />
              </button>
            )}
          </span>
        ) : (
          <span key={a.id} className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => void openTab('file', a.fileName, undefined, a.path)}
              className="flex items-center gap-1.5 rounded-md border nerve-border bg-[var(--background)] py-1 pl-2 pr-1.5 text-[11px] text-[var(--muted-foreground)] transition hover:text-[var(--foreground)]"
              title={a.path}
            >
              <FileText size={11} className="flex-shrink-0" />
              <span className="max-w-[180px] truncate">{a.fileName}</span>
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(a.path)}
                className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border nerve-border bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm transition hover:text-[var(--foreground)]"
                title="Remove this file from the edit"
              >
                <X size={10} />
              </button>
            )}
          </span>
        ),
      )}
    </div>
  );
};

const Message: React.FC<{ msg: ChatMessage; editable?: boolean; onEdit?: () => void }> = ({
  msg,
  editable = false,
  onEdit,
}) => {
  const { openTab, setSelectedChangePath } = useApp();
  const model = modelById(msg.modelId);

  if (msg.sender === 'user') {
    const workflow = /^\[Workflow: (inspection|dashboard|discrepancy|revision)\]\r?\n([^\n]+)/.exec(msg.content);
    return (
      <div className="group flex flex-col items-end gap-1">
        <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-[var(--card)] text-[13.5px] text-[var(--foreground)] leading-relaxed whitespace-pre-wrap">
          {workflow ? <><p className="font-medium">{workflow[2]}</p><p className="mt-1">{msg.content.split('Operator context:\n')[1] ?? ''}</p><details className="mt-2 text-xs text-[var(--muted-foreground)]"><summary className="cursor-pointer">Workflow instructions</summary><p className="mt-2">{msg.content}</p></details></> : msg.content}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mt-2.5 pt-2.5 border-t border-[var(--border)]">
              <AttachmentGrid attachments={msg.attachments} />
            </div>
          )}
        </div>
        <BubbleActions msg={msg} editable={editable} onEdit={onEdit} align="right" />
      </div>
    );
  }

  if (msg.sender === 'system') {
    return (
      <div className="flex items-start space-x-2.5 px-3 py-2.5 rounded-lg bg-[var(--warning-soft)] border border-[var(--warning-ring)]">
        <ShieldOff size={14} className="text-[var(--warning)] flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-[12.5px] text-[var(--warning)] leading-relaxed">{msg.content}</p>
          {msg.failure && <p className="text-[11px] text-[var(--warning)] mt-1">{msg.failure}</p>}
        </div>
      </div>
    );
  }

  const changes = msg.fileChanges ?? [];
  const additions = changes.reduce((a, c) => a + c.additions, 0);
  const deletions = changes.reduce((a, c) => a + c.deletions, 0);
  // Approved writes are already on disk, so "proposed" would be wrong for
  // them; anything still unapplied is waiting in the review panel.
  const unwritten = changes.filter((c) => !c.applied).length;

  return (
    <div className="group relative space-y-2.5">
      {msg.activity && msg.activity.length > 0 ? (
        <ActivityFlow blocks={msg.activity} />
      ) : (
        <>
          {msg.steps && msg.steps.length > 0 && (
            <WorkSummary
              blocks={[{ id: `${msg.id}-steps`, type: 'actions', steps: msg.steps }]}
            />
          )}
          {msg.content && <Markdown text={msg.content} />}
        </>
      )}

      {msg.citations && msg.citations.length > 0 && <Citations citations={msg.citations} />}
      {msg.artifacts && msg.artifacts.length > 0 && <Artifacts artifacts={msg.artifacts} />}

      {changes.length > 0 && (
        <button
          onClick={() => {
            setSelectedChangePath(changes[0].path);
            openTab('review', 'Review');
          }}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[var(--sidebar)] border border-[var(--border)] hover:border-[var(--border)] transition group"
        >
          <span className="flex items-center space-x-2 text-[12px] text-[var(--muted-foreground)] group-hover:text-[var(--foreground)]">
            <FileDiff size={13} />
            <span>
              {changes.length} {changes.length === 1 ? 'file' : 'files'}{' '}
              {unwritten === 0
                ? 'written'
                : unwritten === changes.length
                  ? 'proposed'
                  : `— ${unwritten} still to write`}
            </span>
          </span>
          <span className="flex items-center space-x-2 text-[11px] tabular-nums">
            <span className="text-[var(--success)]">+{additions}</span>
            <span className="text-[var(--destructive)]">-{deletions}</span>
          </span>
        </button>
      )}

      {msg.failure && (
        <div className="flex items-start space-x-2 px-3 py-2 rounded-lg bg-[var(--destructive-soft)] border border-[var(--destructive-ring)]">
          <AlertTriangle size={13} className="text-[var(--destructive)] flex-shrink-0 mt-0.5" />
          <p className="text-[12px] text-[var(--destructive)] leading-relaxed">{msg.failure}</p>
        </div>
      )}

      {/* Provenance: which model, how fast, how long, when */}
      {(model || msg.elapsedMs !== undefined) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] leading-4 text-[var(--muted-foreground)] tabular-nums">
          {model && <span>{model.displayName}</span>}
          {msg.mode && <span>{msg.mode === 'plan' ? 'plan mode' : 'agent mode'}</span>}
          {msg.elapsedMs !== undefined && <span>{formatDuration(msg.elapsedMs)}</span>}
          {msg.tokensPerSec !== undefined && <span>{msg.tokensPerSec.toFixed(1)} tok/s</span>}
          <span>{formatChatTime(msg.createdAt)}</span>
        </div>
      )}

      <BubbleActions msg={msg} align="left" showTime={!(model || msg.elapsedMs !== undefined)} />
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Container                                                          */
/* ------------------------------------------------------------------ */

/**
 * An open edit of a sent message: the bubble is swapped for this editor while
 * `chatEditing` names it. Saving is truncate-and-resend (commitEdit); until
 * then nothing on disk has changed and Cancel restores the bubble untouched.
 * Enter saves, Escape cancels, and more images can be pasted in like the
 * composer.
 */
const EditingBubble: React.FC<{
  msg: ChatMessage;
  text: string;
  onChangeText: (text: string) => void;
  attached: string[];
  onChangeAttached: (attached: string[]) => void;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}> = ({ msg, text, onChangeText, attached, onChangeAttached, saving, onSave, onCancel }) => {
  const areaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const area = areaRef.current;
    if (area) {
      area.focus();
      area.setSelectionRange(text.length, text.length);
    }
  }, []);
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${Math.min(area.scrollHeight, 260)}px`;
  }, [text]);

  const save = () => {
    if (!text.trim() || saving) return;
    onSave();
  };

  return (
    <div className="flex justify-end">
      <div className="w-full max-w-2xl rounded-2xl rounded-br-md border nerve-border bg-[var(--card)] p-2 shadow-sm">
        <textarea
          ref={areaRef}
          value={text}
          aria-label="Edit your message"
          onChange={(event) => onChangeText(event.target.value)}
          onPaste={stagePastedImages((added) => {
            if (added.length === 0) return;
            onChangeAttached([...new Set([...attached, ...added])]);
          })}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              save();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          data-inset-field
          className="w-full resize-none bg-transparent px-2 py-1.5 text-[13.5px] leading-relaxed text-[var(--foreground)] outline-none"
        />
        {(attached.length > 0 || (msg.attachments?.length ?? 0) > 0) && (
          <div className="px-1 pt-0.5 pb-1">
            <AttachmentGrid
              attachments={attached.map((path) => ({
                id: `edit-att-${path}`,
                path,
                fileName: basename(path),
                kind: 'image',
                sizeBytes: 0,
              }))}
              onRemove={(path) => onChangeAttached(attached.filter((p) => p !== path))}
            />
          </div>
        )}
        <div className="flex items-center justify-between gap-3 px-1 pt-1">
          <p className="min-w-0 truncate text-[10px] text-[var(--muted-foreground)]">
            Editing your message · the replies below it will be replaced
          </p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <button
              type="button"
              onClick={onCancel}
              disabled={saving}
              className="rounded-full px-3 py-1 text-[11px] text-[var(--muted-foreground)] transition hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!text.trim() || saving}
              className="zeroleak-primary flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
              {saving ? 'Resending…' : 'Save & resend'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const ChatContainer: React.FC = () => {
  const {
    messages,
    liveSteps,
    liveActivity,
    livePhase,
    isRunning,
    activeSession,
    activeSessionId,
    mode,
    coreStatus,
    send,
    commitEdit,
  } = useApp();
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [readingSessionId, setReadingSessionId] = useState<string | null>(null);
  const showLatest = readingSessionId !== null && readingSessionId === activeSessionId;
  const [retrying, setRetrying] = useState(false);
  /**
   * The message open in its editor, when one is. Only one edit at a time, and
   * only while this chat is idle — an edit under a running turn would be
   * overwritten by the live stream, and one while a follow-up is queued would
   * truncate a turn that has not been written yet.
   */
  const [chatEditing, setChatEditing] = useState<{
    id: string;
    text: string;
    attachments: string[];
  } | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  // Leave the editor when the chat switches; a half-typed edit belongs to the
  // session it was started in.
  useEffect(() => {
    setChatEditing(null);
    setEditSaving(false);
  }, [activeSessionId]);

  const canEdit = !isRunning && chatEditing === null;
  const beginEdit = (msg: ChatMessage) => {
    if (!canEdit || msg.sender !== 'user' || !msg.rowId) return;
    setChatEditing({
      id: msg.id,
      text: msg.content,
      attachments: (msg.attachments ?? []).map((a) => a.path),
    });
    // The new editor sits above the fold; pull it into view.
    window.requestAnimationFrame(() => {
      const container = scrollRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
  };
  const commitChatEdit = async () => {
    if (!chatEditing) return;
    setEditSaving(true);
    try {
      const accepted = await commitEdit(
        chatEditing.id,
        chatEditing.text,
        chatEditing.attachments,
      );
      if (accepted) setChatEditing(null);
    } finally {
      setEditSaving(false);
    }
  };
  const cancelChatEdit = () => {
    if (!editSaving) setChatEditing(null);
  };

  const jumpToLatest = () => {
    followRef.current = true;
    setReadingSessionId(null);
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  };

  // Whether the bottom of the stream is already naming the current action
  // with its own spinner.
  //
  // The blue status dot exists for the run that has nothing else to say it —
  // with Extended Thinking off the core emits no reasoning deltas at all, so
  // no block carries the state and a reasoning run would look frozen, and an
  // answer streams with no spinner of its own. But when the last block IS
  // carrying it, the dot repeats it one line lower: "Thinking" under
  // Thinking, "Write file: index.html" under the same sentence. That
  // duplicate is what the operator saw, so in those cases the row stands
  // down. The blank-text check matches ThinkingBlock, which renders nothing
  // for whitespace.
  const lastBlock = liveActivity[liveActivity.length - 1];
  const phaseShownInStream =
    lastBlock?.type === 'actions'
      ? lastBlock.steps.some((step) => step.status === 'running')
      : lastBlock?.type === 'text' &&
        lastBlock.kind === 'thinking' &&
        livePhase?.phase === 'reasoning' &&
        lastBlock.text.trim().length > 0;

  useEffect(() => {
    followRef.current = true;
    const container = scrollRef.current;
    if (container) container.scrollTop = container.scrollHeight;
  }, [activeSessionId]);

  useEffect(() => {
    // Streaming should never pull the operator away from older messages.
    const container = scrollRef.current;
    if (container && followRef.current) container.scrollTop = container.scrollHeight;
  }, [messages.length, liveActivity, liveSteps.length, livePhase?.label]);

  const banner = useMemo(() => {
    if (coreStatus.state === 'unavailable') return coreStatus.detail;
    if (coreStatus.state === 'core_only')
      return 'Core attached but the model router is not running. Start it from Models.';
    return null;
  }, [coreStatus]);

  // The handoff card is offered whenever the newest agent turn is a Plan-mode
  // turn that published a checklist with work left in it — including a failed
  // one: the checklist still describes the work, and a Plan-mode run that died
  // trying to execute ("build it" while still in Plan mode) is exactly the
  // dead end this card ends. It also stays up after a later user message such
  // as "go ahead": the newest agent turn is still the plan. An Agent-mode turn
  // since then means the plan was already executed, so the card leaves.
  const lastMsg = messages[messages.length - 1];
  const lastAgentMsg = useMemo(
    () => [...messages].reverse().find((m) => m.sender === 'agent'),
    [messages],
  );
  // The plan lives on the message now, not in its activity: one checklist per
  // agent turn, wherever the timeline happens to have scrolled.
  const handoffPlan = useMemo(() => {
    if (!lastAgentMsg || lastAgentMsg.mode !== 'plan') return null;
    const items = lastAgentMsg.plan ?? [];
    if (items.length === 0) return null;
    return items.some((i) => i.status !== 'completed') ? items : null;
  }, [lastAgentMsg]);

  // A failed turn offers a retry of the instruction that produced it. The
  // failed exchange stays in the history — it is evidence of what was tried —
  // and the retry is a fresh turn with the same text and attachments.
  // Suppressed while the handoff card is up: retrying a Plan-mode refusal
  // replays the same dead end, and the card is the way out of it.
  const failedRetry = useMemo(() => {
    if (!lastMsg || lastMsg.sender !== 'agent' || !lastMsg.failure || handoffPlan)
      return null;
    const prior = [...messages].reverse().find((m) => m.sender === 'user');
    if (!prior) return null;
    return {
      text: prior.content,
      attachments: (prior.attachments ?? []).map((a) => a.path),
    };
  }, [lastMsg, messages, handoffPlan]);

  const retry = async () => {
    if (!failedRetry || retrying) return;
    setRetrying(true);
    try {
      await send(failedRetry.text, failedRetry.attachments, activeSessionId ?? undefined);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="relative flex-1 flex flex-col min-h-0">
      {/* Session header */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-[var(--muted)] flex-shrink-0">
        <div className="min-w-0 flex items-center space-x-2">
          <h2 className="text-[13px] text-[var(--foreground)] truncate">
            {activeSession?.title ?? 'New task'}
          </h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--card)] text-[var(--muted-foreground)] flex-shrink-0">
            {mode === 'plan' ? 'Plan' : 'Agent'}
          </span>
        </div>
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const container = event.currentTarget;
          const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 64;
          followRef.current = atBottom;
          setReadingSessionId(atBottom ? null : activeSessionId);
        }}
        className="flex-1 overflow-y-auto"
      >
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-5">
          {banner && (
            <div className="flex items-start space-x-2.5 px-3 py-2.5 rounded-lg bg-[var(--sidebar)] border border-[var(--border)]">
              <Info size={14} className="text-[var(--muted-foreground)] flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-[var(--muted-foreground)] leading-relaxed">{banner}</p>
            </div>
          )}

          {messages.map((m) => {
            if (chatEditing?.id === m.id) {
              return (
                <EditingBubble
                  key={m.id}
                  msg={m}
                  text={chatEditing.text}
                  onChangeText={(text) =>
                    setChatEditing((cur) => (cur ? { ...cur, text } : cur))
                  }
                  attached={chatEditing.attachments}
                  onChangeAttached={(attachments) =>
                    setChatEditing((cur) => (cur ? { ...cur, attachments } : cur))
                  }
                  saving={editSaving}
                  onSave={() => void commitChatEdit()}
                  onCancel={cancelChatEdit}
                />
              );
            }
            return (
              <Message
                key={m.id}
                msg={m}
                editable={canEdit && m.sender === 'user' && Boolean(m.rowId)}
                onEdit={canEdit && m.sender === 'user' && m.rowId ? () => beginEdit(m) : undefined}
              />
            );
          })}

          {/* Plan-mode handoff: approve the plan above and execution starts */}
          {!isRunning && handoffPlan && lastAgentMsg && (
            <PlanHandoff key={lastAgentMsg.id} items={handoffPlan} />
          )}

          {/* Failed turn: the same instruction, sent again */}
          {!isRunning && failedRetry && (
            <div className="flex justify-center">
              <button
                onClick={() => void retry()}
                disabled={retrying}
                className="flex items-center gap-1.5 rounded-full border nerve-border bg-[var(--card)] px-3 py-1.5 text-[11.5px] text-[var(--foreground)] hover:bg-[var(--accent)] transition disabled:cursor-wait disabled:opacity-60"
              >
                <RotateCcw size={12} />
                {retrying ? 'Retrying…' : 'Retry this turn'}
              </button>
            </div>
          )}

          {/* Live run — this chat's own, never another chat's. The thinking
              spinner runs only while the core reports actual reasoning, and
              only on the block being thought into. */}
          {isRunning && (
            <div className="space-y-2.5">
              {liveActivity.length > 0 ? (
                <ActivityFlow
                  blocks={liveActivity}
                  live
                  thinkingLive={livePhase?.phase === 'reasoning'}
                />
              ) : (
                <p className="text-[12px] text-[var(--muted-foreground)]">Starting…</p>
              )}
              {livePhase && livePhase.phase !== 'done' && !phaseShownInStream && (
                <RunPhaseRow phase={livePhase} />
              )}
            </div>
          )}

        </div>
      </div>
      {showLatest && (
        <button
          type="button"
          onClick={jumpToLatest}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border nerve-border bg-[var(--card)] px-3 py-1.5 text-xs text-[var(--foreground)] shadow-md hover:bg-[var(--accent)]"
        >
          <ArrowDown size={13} />Jump to latest
        </button>
      )}
    </div>
  );
};
