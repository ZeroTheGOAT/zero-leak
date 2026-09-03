import React, { useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  Copy,
  FileDiff,
  FileOutput,
  Info,
  Quote,
  ShieldOff,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { AgentTimeline } from './AgentTimeline';
import type { Artifact, ChatMessage, Citation } from '../../types';
import { formatBytes, formatDuration, modelById } from '../../services/registry';

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

const inline = (text: string, keyBase: string): React.ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    const key = `${keyBase}-${i}`;
    if (part.startsWith('**') && part.endsWith('**'))
      return (
        <strong key={key} className="font-semibold text-white">
          {part.slice(2, -2)}
        </strong>
      );
    if (part.startsWith('`') && part.endsWith('`'))
      return (
        <code key={key} className="px-1 py-0.5 rounded bg-[#22242c] text-[#e4e4e7] text-[12px]">
          {part.slice(1, -1)}
        </code>
      );
    return <span key={key}>{part}</span>;
  });

const CodeBlock: React.FC<{ lang: string; text: string }> = ({ lang, text }) => (
  <div className="my-2 rounded-lg border border-[#22242c] overflow-hidden bg-[#0f1014]">
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#22242c]">
      <span className="text-[10px] text-[#6b6d75] font-mono">{lang}</span>
      <button
        onClick={() => void navigator.clipboard?.writeText(text)}
        className="text-[#6b6d75] hover:text-white transition"
        title="Copy"
      >
        <Copy size={11} />
      </button>
    </div>
    <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-[#d4d4d8]">
      {text}
    </pre>
  </div>
);

const Prose: React.FC<{ text: string }> = ({ text }) => (
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
              <span className="text-[#5f6169] flex-shrink-0">·</span>
              <span>{inline(bullet[1], `b${i}`)}</span>
            </div>
          );

        const numbered = /^(\d+)\.\s+(.*)$/.exec(trimmed);
        if (numbered)
          return (
            <div key={i} className="flex space-x-2 my-0.5">
              <span className="text-[#5f6169] tabular-nums flex-shrink-0">{numbered[1]}.</span>
              <span>{inline(numbered[2], `n${i}`)}</span>
            </div>
          );

        const heading = /^#{1,4}\s+(.*)$/.exec(trimmed);
        if (heading)
          return (
            <p key={i} className="font-semibold text-white mt-3 mb-1">
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
);

const Markdown: React.FC<{ text: string }> = ({ text }) => (
  <div className="text-[13.5px] leading-relaxed text-[#d4d4d8]">
    {splitFences(text).map((seg, i) =>
      seg.type === 'code' ? (
        <CodeBlock key={i} lang={seg.lang} text={seg.text} />
      ) : (
        <Prose key={i} text={seg.text} />
      ),
    )}
  </div>
);

/* ------------------------------------------------------------------ */
/* Citations and artifacts                                            */
/* ------------------------------------------------------------------ */

const Citations: React.FC<{ citations: Citation[] }> = ({ citations }) => {
  const { openDocumentAt } = useApp();
  return (
    <div className="mt-2.5 space-y-1">
      <div className="flex items-center space-x-1.5 text-[10px] text-[#6b6d75]">
        <Quote size={10} />
        <span>
          {citations.length} {citations.length === 1 ? 'source' : 'sources'}
        </span>
      </div>
      {citations.map((c, i) => (
        <button
          key={i}
          onClick={() => void openDocumentAt(c.path)}
          className="w-full text-left px-2.5 py-1.5 rounded-md bg-[#131418] border border-[#22242c] hover:border-[#3a3d47] transition group"
          title={c.path}
        >
          <span className="flex items-center justify-between text-[11px]">
            <span className="text-[#a1a1aa] group-hover:text-white truncate">
              {c.fileName}
              {c.page !== undefined && <span className="text-[#5f6169]"> · p.{c.page}</span>}
            </span>
            <span className="text-[#5f6169] tabular-nums flex-shrink-0 ml-2">
              {c.score.toFixed(3)}
            </span>
          </span>
          <span className="block text-[11px] text-[#71717a] mt-0.5 leading-relaxed line-clamp-2">
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
          className="flex items-center justify-between px-2.5 py-2 rounded-md bg-[#131418] border border-[#22242c]"
        >
          <div className="flex items-center space-x-2.5 min-w-0">
            <FileOutput size={13} className="text-[#8e8e93] flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-[12px] text-[#d4d4d8] truncate">{a.fileName}</p>
              <p className="text-[10px] text-[#5f6169]">
                {a.kind.toUpperCase()} · {formatBytes(a.sizeBytes)}
                {a.verified ? (
                  <span className="text-emerald-600"> · verified openable</span>
                ) : (
                  <span className="text-amber-600"> · not yet verified</span>
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center space-x-1 flex-shrink-0">
            {!a.verified && (
              <button
                onClick={() => void verifyArtifact(a.id)}
                className="p-1.5 rounded text-[#8e8e93] hover:bg-[#22242c] hover:text-white transition"
                title="Reopen and check the file parses"
              >
                <BadgeCheck size={13} />
              </button>
            )}
            <button
              onClick={() => void openArtifact(a.id)}
              className="px-2 py-1 rounded text-[11px] text-[#c4c4c8] hover:bg-[#22242c] hover:text-white transition"
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

const Message: React.FC<{ msg: ChatMessage }> = ({ msg }) => {
  const { openTab, setSelectedChangePath } = useApp();
  const model = modelById(msg.modelId);

  if (msg.sender === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-[#1f212a] text-[13.5px] text-[#ededef] leading-relaxed whitespace-pre-wrap">
          {msg.content}
          {msg.attachments && msg.attachments.length > 0 && (
            <div className="mt-2 pt-2 border-t border-[#2a2c34] space-y-0.5">
              {msg.attachments.map((a) => (
                <p key={a.id} className="text-[11px] text-[#8e8e93] font-mono truncate" title={a.path}>
                  {a.fileName}
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  if (msg.sender === 'system') {
    return (
      <div className="flex items-start space-x-2.5 px-3 py-2.5 rounded-lg bg-amber-500/5 border border-amber-500/25">
        <ShieldOff size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-[12.5px] text-amber-200/90 leading-relaxed">{msg.content}</p>
          {msg.failure && <p className="text-[11px] text-amber-500/70 mt-1">{msg.failure}</p>}
        </div>
      </div>
    );
  }

  const changes = msg.fileChanges ?? [];
  const additions = changes.reduce((a, c) => a + c.additions, 0);
  const deletions = changes.reduce((a, c) => a + c.deletions, 0);

  return (
    <div className="space-y-2.5">
      {msg.steps && msg.steps.length > 0 && <AgentTimeline steps={msg.steps} />}

      {msg.content && <Markdown text={msg.content} />}

      {msg.citations && msg.citations.length > 0 && <Citations citations={msg.citations} />}
      {msg.artifacts && msg.artifacts.length > 0 && <Artifacts artifacts={msg.artifacts} />}

      {changes.length > 0 && (
        <button
          onClick={() => {
            setSelectedChangePath(changes[0].path);
            openTab('review', 'Review');
          }}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-[#131418] border border-[#22242c] hover:border-[#3a3d47] transition group"
        >
          <span className="flex items-center space-x-2 text-[12px] text-[#a1a1aa] group-hover:text-white">
            <FileDiff size={13} />
            <span>
              {changes.length} {changes.length === 1 ? 'file' : 'files'} proposed
            </span>
          </span>
          <span className="flex items-center space-x-2 text-[11px] tabular-nums">
            <span className="text-emerald-500">+{additions}</span>
            <span className="text-red-400">-{deletions}</span>
          </span>
        </button>
      )}

      {msg.failure && (
        <div className="flex items-start space-x-2 px-3 py-2 rounded-lg bg-red-500/5 border border-red-500/25">
          <AlertTriangle size={13} className="text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-[12px] text-red-300/90 leading-relaxed">{msg.failure}</p>
        </div>
      )}

      {/* Provenance: which model, how fast, how long */}
      {(model || msg.elapsedMs !== undefined) && (
        <div className="flex items-center space-x-3 text-[10px] text-[#5f6169] tabular-nums">
          {model && <span>{model.displayName}</span>}
          {msg.mode && <span>{msg.mode === 'plan' ? 'plan mode' : 'agent mode'}</span>}
          {msg.elapsedMs !== undefined && <span>{formatDuration(msg.elapsedMs)}</span>}
          {msg.tokensPerSec !== undefined && <span>{msg.tokensPerSec.toFixed(1)} tok/s</span>}
        </div>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* Container                                                          */
/* ------------------------------------------------------------------ */

export const ChatContainer: React.FC = () => {
  const {
    messages,
    liveSteps,
    liveText,
    isRunning,
    runningSessionId,
    activeSession,
    mode,
    coreStatus,
  } = useApp();
  const endRef = useRef<HTMLDivElement>(null);
  const isThisChatRunning = isRunning && runningSessionId === activeSession?.id;

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, liveSteps.length, liveText]);

  const banner = useMemo(() => {
    if (coreStatus.state === 'unavailable') return coreStatus.detail;
    if (coreStatus.state === 'core_only')
      return 'Core attached but the model router is not running. Start it from Models.';
    return null;
  }, [coreStatus]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Session header */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-[#1a1b21] flex-shrink-0">
        <div className="min-w-0 flex items-center space-x-2">
          <h2 className="text-[13px] text-[#d4d4d8] truncate">
            {activeSession?.title ?? 'New task'}
          </h2>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#1f212a] text-[#8e8e93] flex-shrink-0">
            {mode === 'plan' ? 'Plan' : 'Agent'}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-5 space-y-5">
          {banner && (
            <div className="flex items-start space-x-2.5 px-3 py-2.5 rounded-lg bg-[#131418] border border-[#22242c]">
              <Info size={14} className="text-[#8e8e93] flex-shrink-0 mt-0.5" />
              <p className="text-[12px] text-[#a1a1aa] leading-relaxed">{banner}</p>
            </div>
          )}

          {messages.map((m) => (
            <Message key={m.id} msg={m} />
          ))}

          {/* Live run */}
          {isThisChatRunning && (
            <div className="space-y-2.5">
              {liveSteps.length > 0 && <AgentTimeline steps={liveSteps} live />}
              {liveText && <Markdown text={liveText} />}
              {liveSteps.length === 0 && !liveText && (
                <p className="text-[12px] text-[#5f6169]">Starting…</p>
              )}
            </div>
          )}

          {isRunning && !isThisChatRunning && (
            <p className="text-[11px] text-[#5f6169]">
              Another chat is running locally. Its answer will stay with that chat.
            </p>
          )}

          <div ref={endRef} />
        </div>
      </div>
    </div>
  );
};
