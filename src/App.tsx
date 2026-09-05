import React, { useCallback, useEffect, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useApp } from './context/AppContext';
import { TitleBar } from './components/layout/TitleBar';
import { Sidebar } from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { ChatContainer } from './components/chat/ChatContainer';
import { EmptyState } from './components/chat/EmptyState';
import { FloatingInput, type ComposerDraft } from './components/chat/FloatingInput';
import { TaskDock } from './components/chat/TaskDock';
import { DevServerBar } from './components/chat/DevServerBar';
import { PermissionPrompt } from './components/chat/PermissionPrompt';
import { QuestionPrompt } from './components/chat/QuestionPrompt';
import { RightPanel } from './components/panels/RightPanel';
import { SettingsView } from './components/settings/SettingsView';
import { SearchModal } from './components/modals/SearchModal';
import { CreateProjectModal } from './components/modals/CreateProjectModal';

export const AppContent: React.FC = () => {
  // Keep drafts in memory across Settings navigation; never write them to disk.
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const {
    view,
    activeSessionId,
    activeWorkspaceId,
    setIsSearchOpen,
    openTab,
    openSettings,
    isPanelOpen,
    setIsPanelOpen,
    tabs,
    artifacts,
    newSession,
    isCreateProjectOpen,
  } = useApp();

  // The panel only renders once something has been opened in it, so "visible"
  // is both flags together — the button has to reflect what is on screen.
  const panelVisible = isPanelOpen && tabs.length > 0;

  const togglePanel = useCallback(() => {
    if (panelVisible) {
      setIsPanelOpen(false);
      return;
    }
    if (tabs.length === 0) {
      // First open: the project's own files when a folder is open, since that
      // is what "show me everything" means with a workspace loaded. Artifacts
      // otherwise, which is all there is to show without one.
      if (activeWorkspaceId) openTab('files', 'Files');
      else openTab('artifacts', 'Artifacts');
      return;
    }
    setIsPanelOpen(true);
  }, [panelVisible, tabs.length, activeWorkspaceId, openTab, setIsPanelOpen]);

  const panelHint = panelVisible
    ? 'Hide the side panel'
    : artifacts.length > 0
      ? `Show the side panel — files, changes and ${artifacts.length} artifact${
          artifacts.length === 1 ? '' : 's'
        }`
      : 'Show the side panel — files, changes and artifacts';

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();

      if (key === 'k') {
        e.preventDefault();
        setIsSearchOpen(true);
      } else if (key === 'n') {
        // Advertised beside `New task` in the Task menu, so it has to exist.
        e.preventDefault();
        newSession();
      } else if (key === ',') {
        e.preventDefault();
        openSettings('workbench');
      } else if (e.key === '`') {
        // Sandbox console — the only place commands can run.
        e.preventDefault();
        openTab('terminal', 'Sandbox');
      } else if (e.shiftKey && key === 'g') {
        e.preventDefault();
        openTab('review', 'Review');
      } else if (key === 'p') {
        e.preventDefault();
        openTab('files', 'Files');
      } else if (key === 'b') {
        e.preventDefault();
        togglePanel();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setIsSearchOpen, openSettings, openTab, togglePanel, newSession]);

  return (
    <div className="servergen-shell h-screen w-screen flex flex-col font-sans select-none overflow-hidden">
      <TitleBar />

      <div className="flex-1 flex overflow-hidden min-h-0">
        {view === 'settings' ? (
          <SettingsView />
        ) : (
          <>
            <Sidebar />

            {/* Centre: the task, with the composer pinned beneath it */}
            <main className="flex-1 flex flex-col min-w-0 min-h-0 relative">
              {/* The symbol alone: the panel it opens names its own tabs, so a
                  label and a count out here would only repeat them. */}
              <button
                onClick={togglePanel}
                aria-pressed={panelVisible}
                aria-label={panelHint}
                className={`absolute top-1.5 right-3 z-30 h-7 w-7 flex items-center justify-center rounded-md border transition ${
                  panelVisible
                    ? 'bg-[var(--primary-soft)] border-[var(--primary-ring)] text-[var(--primary)]'
                    : 'bg-[var(--sidebar)] border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--accent)]'
                }`}
                title={panelHint}
              >
                {panelVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
              </button>
              {activeSessionId ? <ChatContainer /> : <EmptyState />}
              {/* Docked run state — the task list and dev server live beside
                  the composer, not in the conversation timeline. */}
              <TaskDock />
              <DevServerBar />
              <FloatingInput drafts={drafts} setDrafts={setDrafts} />
            </main>

            <RightPanel />
          </>
        )}
      </div>

      {/* §2/§11 — residency, VRAM and the egress counters, always visible */}
      <StatusBar />

      {/* §9 — blocks the run until answered */}
      <PermissionPrompt />
      {/* §9 — a mid-run `ask_operator` question; blocks until replied to */}
      <QuestionPrompt />
      <SearchModal />
      {isCreateProjectOpen && <CreateProjectModal />}
    </div>
  );
};

export default function App() {
  return <AppContent />;
}
