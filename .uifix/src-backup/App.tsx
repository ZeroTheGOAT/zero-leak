import React, { useEffect } from 'react';
import { FileOutput, PanelRightOpen } from 'lucide-react';
import { useApp } from './context/AppContext';
import { TitleBar } from './components/layout/TitleBar';
import { Sidebar } from './components/layout/Sidebar';
import { StatusBar } from './components/layout/StatusBar';
import { ChatContainer } from './components/chat/ChatContainer';
import { EmptyState } from './components/chat/EmptyState';
import { FloatingInput } from './components/chat/FloatingInput';
import { PermissionPrompt } from './components/chat/PermissionPrompt';
import { RightPanel } from './components/panels/RightPanel';
import { SettingsView } from './components/settings/SettingsView';
import { SearchModal } from './components/modals/SearchModal';

export const AppContent: React.FC = () => {
  const {
    view,
    activeSessionId,
    setIsSearchOpen,
    openTab,
    openSettings,
    isPanelOpen,
    setIsPanelOpen,
    tabs,
    activeTabId,
    artifacts,
    newSession,
  } = useApp();

  const artifactTab = tabs.find((tab) => tab.kind === 'artifacts');
  const artifactsVisible =
    isPanelOpen && artifactTab !== undefined && activeTabId === artifactTab.id;

  const toggleArtifacts = () => {
    if (artifactsVisible) setIsPanelOpen(false);
    else openTab('artifacts', 'Artifacts');
  };

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
        setIsPanelOpen(!isPanelOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setIsSearchOpen, openSettings, openTab, isPanelOpen, setIsPanelOpen, newSession]);

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
              <button
                onClick={toggleArtifacts}
                aria-pressed={artifactsVisible}
                className={`absolute top-1.5 right-3 z-30 h-7 flex items-center gap-1.5 px-2 rounded-md border text-[11px] transition ${
                  artifactsVisible
                    ? 'bg-orange-500/10 border-orange-500/30 text-orange-300'
                    : 'bg-[#14151a] border-[#292c35] text-[#8e8e93] hover:text-white hover:bg-[#1c1e27]'
                }`}
                title={artifactsVisible ? 'Hide artifacts sidebar' : 'Show artifacts sidebar'}
              >
                <FileOutput size={12} />
                <span>Artifacts</span>
                {artifacts.length > 0 && (
                  <span className="min-w-4 h-4 px-1 rounded bg-[#252834] text-[9px] tabular-nums flex items-center justify-center">
                    {artifacts.length}
                  </span>
                )}
                <PanelRightOpen size={12} />
              </button>
              {activeSessionId ? <ChatContainer /> : <EmptyState />}
              <FloatingInput />
            </main>

            <RightPanel />
          </>
        )}
      </div>

      {/* §2/§11 — residency, VRAM and the egress counters, always visible */}
      <StatusBar />

      {/* §9 — blocks the run until answered */}
      <PermissionPrompt />
      <SearchModal />
    </div>
  );
};

export default function App() {
  return <AppContent />;
}
