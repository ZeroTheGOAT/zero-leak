import React from 'react';
import {
  Eye,
  FileSpreadsheet,
  FolderOpen,
  Gauge,
  Library,
  PenLine,
  ScanText,
  ShieldCheck,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { MODEL_REGISTRY, formatBytes } from '../../services/registry';

/**
 * The starting screen states what this workstation can actually do, using the
 * models that are present on disk. Each suggestion maps to a route in the
 * §3 routing table — none of them are decorative.
 */
const SUGGESTIONS: Array<{ icon: React.ElementType; title: string; prompt: string; route: string }> = [
  {
    icon: ScanText,
    title: 'Transcribe a scanned inspection report',
    prompt:
      'Read the attached inspection report and extract the thickness table into a spreadsheet, keeping the page and cell references.',
    route: 'PaddleOCR-VL',
  },
  {
    icon: Eye,
    title: 'Read a P&ID and trace a line',
    prompt:
      'From the attached P&ID, list every valve and instrument on the line into vessel V-2103-A, with its tag number.',
    route: 'Qwen3.5 9B vision',
  },
  {
    icon: PenLine,
    title: 'Digitise handwritten field notes',
    prompt:
      'Transcribe the attached handwritten note and flag any reading that falls below the retirement thickness.',
    route: 'olmOCR 2',
  },
  {
    icon: FileSpreadsheet,
    title: 'Build a report from a document set',
    prompt:
      'Summarise the inspection findings across the indexed documents into a DOCX report, citing the source page for every figure.',
    route: 'RAG + artifact',
  },
];

export const EmptyState: React.FC = () => {
  const {
    activeWorkspace,
    addWorkspace,
    send,
    knowledgeStats,
    openTab,
    coreStatus,
    hardware,
  } = useApp();

  const onDevice = MODEL_REGISTRY.filter((m) => m.priority !== 'disabled');
  const totalBytes = onDevice.reduce((acc, m) => acc + m.fileSizeBytes, 0);

  if (!activeWorkspace) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <FolderOpen size={30} className="text-[var(--muted-foreground)] mb-4" />
        <h1 className="text-xl font-medium text-[var(--foreground)]">Open a workspace to begin</h1>
        <p className="text-sm text-[var(--muted-foreground)] mt-2 max-w-md leading-relaxed">
          Every tool in this app is confined to folders you add here. Nothing is read, written or
          indexed outside them.
        </p>
        <button
          onClick={() => void addWorkspace()}
          className="servergen-primary mt-5 px-4 py-2 rounded-lg text-sm font-medium transition"
        >
          Add a folder
        </button>
        <p className="text-[11px] text-[var(--muted-foreground)] mt-6">
          {onDevice.length} models on this device · {formatBytes(totalBytes)}
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col items-center justify-center px-6 overflow-y-auto py-10">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-medium text-[var(--foreground)] text-center">
          What should we work on in {activeWorkspace.name}?
        </h1>
        <p className="text-sm text-[var(--muted-foreground)] text-center mt-2">
          Documents, drawings, spreadsheets and code — processed entirely on this machine.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-7">
          {SUGGESTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.title}
                onClick={() => void send(s.prompt)}
                className="text-left p-3 rounded-xl bg-[var(--card)] border nerve-border hover:border-[var(--primary)] hover:bg-[var(--accent)] transition group"
              >
                <div className="flex items-start space-x-2.5">
                  <Icon size={15} className="text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] mt-0.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[13px] text-[var(--card-foreground)] group-hover:text-[var(--foreground)] leading-snug">
                      {s.title}
                    </p>
                    <p className="text-[10px] text-[var(--muted-foreground)] mt-1">{s.route}</p>
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Real state, not decoration */}
        <div className="mt-8 flex items-center justify-center flex-wrap gap-x-5 gap-y-2 text-[11px] text-[var(--muted-foreground)]">
          <span className="flex items-center space-x-1.5">
            <FolderOpen size={12} />
            <span className="font-mono truncate max-w-[260px]" title={activeWorkspace.path}>
              {activeWorkspace.path}
            </span>
          </span>

          <button
            onClick={() => openTab('knowledge', 'Knowledge')}
            className="flex items-center space-x-1.5 hover:text-[var(--foreground)] transition"
          >
            <Library size={12} />
            <span>
              {knowledgeStats.documents > 0
                ? `${knowledgeStats.documents} documents indexed`
                : 'Knowledge base empty'}
            </span>
          </button>

          <span
            className="flex items-center space-x-1.5"
            title={coreStatus.detail}
          >
            <ShieldCheck size={12} className={coreStatus.state === 'connected' ? 'text-emerald-600' : ''} />
            <span>
              {coreStatus.state === 'connected' ? 'On this device' : 'Core detached'}
            </span>
          </span>

          {hardware.vramTotalMb > 0 && (
            <span className="flex items-center space-x-1.5" title={hardware.gpuName}>
              <Gauge size={12} />
              <span className="tabular-nums">
                {(hardware.vramBudgetMb / 1024).toFixed(1)} GB usable VRAM
              </span>
            </span>
          )}
        </div>
      </div>
    </div>
  );
};
