import React, { useMemo } from 'react';
import { FileImage, FileText, Share2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { collectConversationSources } from '../chat/conversationSources';
import { SubagentSection } from '../chat/SubagentSection';

export const ConversationSourcesView: React.FC = () => {
  const { activeSessionId, messages, openDocumentAt, openTab, subagents } = useApp();
  const sources = useMemo(() => collectConversationSources(messages), [messages]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!activeSessionId || (sources.length === 0 && subagents.length === 0) ? (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center">
            <Share2 size={24} className="mb-3 text-[var(--border)]" />
            <p className="text-[12px] text-[var(--muted-foreground)]">
              No sources are attached to this conversation.
            </p>
          </div>
        ) : (
          <div className="px-4 pb-4">
            <SubagentSection />
            {sources.length > 0 && <h2 className="pt-4 text-[13px] font-medium text-[var(--muted-foreground)]">Sources</h2>}
            {sources.map((source) => {
              const pages = source.pages.slice(0, 6);
              const pageLabel = pages.length > 0
                ? ` · ${pages.length === 1 ? 'page' : 'pages'} ${pages.join(', ')}${source.pages.length > pages.length ? '…' : ''}`
                : '';
              const detail = source.references > 0
                ? `${source.references} ${source.references === 1 ? 'reference' : 'references'}${pageLabel}`
                : 'Attached to the conversation';

              return (
                <button
                  key={source.key}
                  type="button"
                  onClick={() => {
                    if (source.citation) void openDocumentAt(source.path, source.citation);
                    else void openTab('file', source.fileName, undefined, source.path);
                  }}
                  className="flex w-full items-start gap-3 py-5 text-left transition hover:bg-[var(--accent)]"
                  title={source.path}
                >
                  {source.attachmentKind === 'image' ? (
                    <FileImage size={18} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
                  ) : (
                    <FileText size={18} className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-[var(--foreground)]">
                      {source.fileName}
                    </span>
                    <span className="mt-1 block truncate text-[10.5px] text-[var(--muted-foreground)]">
                      {source.path}
                    </span>
                    <span className="mt-2 block text-[11px] text-[var(--muted-foreground)]">
                      {detail}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
