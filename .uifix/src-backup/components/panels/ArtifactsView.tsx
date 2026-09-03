import React, { useMemo, useState } from 'react';
import { BadgeCheck, ExternalLink, FileOutput, ShieldQuestion } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { formatBytes, modelById } from '../../services/registry';
import type { ArtifactKind } from '../../types';

const KIND_LABEL: Record<ArtifactKind, string> = {
  docx: 'Word document',
  xlsx: 'Workbook',
  pptx: 'Presentation',
  pdf: 'PDF',
  markdown: 'Markdown',
  text: 'Text',
  code: 'Source file',
};

/**
 * §10 — generated files with their provenance intact: the instruction that
 * produced them, the documents they drew on, the model that wrote them and the
 * tools used. "Verified" means the file was reopened and parsed, not that
 * generation returned success.
 */
export const ArtifactsView: React.FC = () => {
  const {
    artifacts,
    openArtifact,
    verifyArtifact,
    documents,
    settings,
    activeWorkspaceId,
    activeSessionId,
  } = useApp();

  const [scope, setScope] = useState<'all' | 'project' | 'chat'>('all');
  const visible = useMemo(
    () =>
      artifacts.filter((artifact) => {
        if (scope === 'chat') return !!activeSessionId && artifact.sessionId === activeSessionId;
        if (scope === 'project') {
          return !!activeWorkspaceId && artifact.workspaceId === activeWorkspaceId;
        }
        return true;
      }),
    [activeSessionId, activeWorkspaceId, artifacts, scope],
  );

  const unverified = visible.filter((a) => !a.verified).length;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="px-3 py-2 border-b border-[#1a1b21] flex-shrink-0 flex items-center justify-between">
        <span className="text-[11px] text-[#8e8e93]">
          {visible.length} {visible.length === 1 ? 'artifact' : 'artifacts'}
        </span>
        <span className="text-[10px] text-[#5f6169] font-mono truncate ml-2" title={settings.artifactRoot}>
          {settings.artifactRoot}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-1 px-3 py-2 border-b border-[#1a1b21] flex-shrink-0">
        {(['all', 'project', 'chat'] as const).map((item) => (
          <button
            key={item}
            onClick={() => setScope(item)}
            disabled={(item === 'project' && !activeWorkspaceId) || (item === 'chat' && !activeSessionId)}
            className={`rounded-md px-2 py-1 text-[10px] capitalize transition disabled:opacity-30 ${
              scope === item
                ? 'bg-orange-500/10 text-orange-300 border border-orange-500/25'
                : 'text-[#71747e] border border-[#252832] hover:text-[#d4d4d8]'
            }`}
          >
            {item}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="p-4 text-center">
            <FileOutput size={22} className="text-[#3a3d47] mx-auto mb-2.5" />
            <p className="text-[12px] text-[#71717a]">No files in this scope.</p>
            <p className="text-[11px] text-[#5f6169] mt-1.5 leading-relaxed">
              Reports, workbooks, decks and PDFs the agent produces appear here, each recorded
              against the task and sources that made it.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-[#16171c]">
            {visible.map((a) => {
              const model = modelById(a.producingModelId);
              const sources = a.sourceDocumentIds
                .map((id) => documents.find((d) => d.id === id)?.fileName)
                .filter(Boolean);

              return (
                <div key={a.id} className="px-3 py-2.5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start space-x-2.5 min-w-0">
                      <FileOutput size={13} className="text-[#8e8e93] flex-shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-[12.5px] text-[#d4d4d8] truncate" title={a.path}>
                          {a.fileName}
                        </p>
                        <p className="text-[10px] text-[#5f6169] tabular-nums mt-0.5">
                          {KIND_LABEL[a.kind]} · {formatBytes(a.sizeBytes)}
                          {model && ` · ${model.displayName}`}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center space-x-0.5 flex-shrink-0 ml-2">
                      <button
                        onClick={() => void verifyArtifact(a.id)}
                        className={`p-1.5 rounded transition ${
                          a.verified
                            ? 'text-emerald-500 hover:bg-[#22242c]'
                            : 'text-amber-500 hover:bg-[#22242c]'
                        }`}
                        title={
                          a.verified
                            ? a.verifyNote ?? 'Reopened and parsed successfully'
                            : 'Not verified — click to reopen and check it parses'
                        }
                      >
                        {a.verified ? <BadgeCheck size={13} /> : <ShieldQuestion size={13} />}
                      </button>
                      <button
                        onClick={() => void openArtifact(a.id)}
                        className="p-1.5 rounded text-[#71717a] hover:bg-[#22242c] hover:text-white transition"
                        title="Open in the default application"
                      >
                        <ExternalLink size={12} />
                      </button>
                    </div>
                  </div>

                  {/* Provenance */}
                  <div className="mt-2 ml-[23px] space-y-1 text-[10.5px]">
                    <p className="text-[#71717a] leading-relaxed">
                      <span className="text-[#5f6169]">Task </span>
                      {a.sourceTask}
                    </p>
                    {sources.length > 0 && (
                      <p className="text-[#71717a] leading-relaxed">
                        <span className="text-[#5f6169]">From </span>
                        {sources.join(', ')}
                      </p>
                    )}
                    {a.toolHistory.length > 0 && (
                      <p className="text-[#5f6169] font-mono leading-relaxed">
                        {a.toolHistory.join(' → ')}
                      </p>
                    )}
                    {a.verifyNote && !a.verified && (
                      <p className="text-amber-500 leading-relaxed">{a.verifyNote}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {unverified > 0 && settings.verifyArtifacts && (
        <div className="px-3 py-2 border-t border-[#1a1b21] flex-shrink-0">
          <p className="text-[10.5px] text-amber-500 leading-relaxed">
            {unverified} {unverified === 1 ? 'file has' : 'files have'} not been reopened and
            checked. Until they are, treat them as written but unconfirmed.
          </p>
        </div>
      )}
    </div>
  );
};
