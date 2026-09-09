import React, { useCallback, useEffect, useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useApp } from './context/AppContext';
import { TitleBar } from './components/layout/TitleBar';
import { Sidebar } from './components/layout/Sidebar';
import { SidebarPeek } from './components/layout/SidebarPeek';
import { BottomPanel } from './components/layout/BottomPanel';
import { StatusBar } from './components/layout/StatusBar';
import { ChatContainer } from './components/chat/ChatContainer';
import { ConversationReferences } from './components/chat/ConversationReferences';
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
    newSession,
    isCreateProjectOpen,
    messages,
    isTranscriptLoaded,
    isRunning,
    queuedMessages,
    isSidebarOpen,
    sidebarLeaving,
    sidebarReopened,
    showPinnedSummary,
    pickAttachments,
  } = useApp();
  // Peek-on-hover when the sidebar is collapsed (hover strip + slide-in
  // overlay) lives in SidebarPeek, which unmounts the moment the docked
  // sidebar opens — so it always remounts from a clean, hidden state.

  // A fresh chat is the centered start screen: title plus the composer in the
  // middle of the canvas with its project row attached. The moment the first
  // text goes out (a message, a live run, or a queued follow-up) the same
  // composer docks to the bottom and the transcript takes the canvas. A
  // stored chat whose history is still arriving (e.g. right after a reload)
  // is not new — it renders the conversation view so the screen never
  // flashes the start screen on the way back to the open chat.
  const isNewChat =
    activeSessionId !== null &&
    isTranscriptLoaded &&
    messages.length === 0 &&
    !isRunning &&
    queuedMessages.length === 0;

  // An open panel can be either a selected tool or the neutral launcher.
  // Both are visible states controlled by the one persistent edge toggle.
  const panelVisible = isPanelOpen;

  const togglePanel = useCallback(() => {
    setIsPanelOpen(!panelVisible);
  }, [panelVisible, setIsPanelOpen]);

  const panelHint = panelVisible ? 'Hide the side panel' : 'Show the side panel';

  const addConversationSources = useCallback(async () => {
    if (!activeSessionId) return;
    const added = await pickAttachments();
    if (added.length === 0) return;
    setDrafts((current) => {
      const existing = current[activeSessionId] ?? { text: '', attached: [] };
      return {
        ...current,
        [activeSessionId]: {
          ...existing,
          attached: [...new Set([...existing.attached, ...added])],
        },
      };
    });
  }, [activeSessionId, pickAttachments]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never hijack typing: inputs, textareas, selects and contenteditable
      // keep their own keys (Ctrl+K in a textarea must not open search).
      const target = e.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target?.isContentEditable ?? false);
      // Composition (IME) must not trigger shortcuts either.
      if (e.isComposing || (e.keyCode === 229 && typing)) return;
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Allow the search modal's own Escape/Tab handling to win.
      if (typing && e.key.toLowerCase() !== 'k') return;
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

  // The peek-on-hover and the close glide both keep a Sidebar mounted; the
  // row behind the chat screen takes the sidebar's colour only while one is
  // actually on screen — the rounded notch must read as the sidebar
  // continuing behind the curve, and must vanish with it.
  const sidebarMounted = isSidebarOpen || sidebarLeaving;

  // A fresh reopen from the collapsed peek state (title-bar toggle) glides
  // the sidebar in — see Sidebar's `opening` prop. The app's first render
  // is not a reopen (sidebarReopened stays false), and a close is excluded
  // here by sidebarLeaving, so only a real toggle-open animates.
  const sidebarOpening = sidebarReopened && !sidebarLeaving;

  return (
    <div className="zeroleak-shell h-full w-full flex flex-col font-sans overflow-hidden">
      <TitleBar />

      <div
        className={`flex-1 flex overflow-hidden min-h-0 select-none relative ${
          // The settings screen always carries its own sidebar-coloured nav,
          // so it always sits on the sidebar-coloured row — the curve at the
          // settings content's top-left needs that ground to read, exactly
          // like the chat screen's.
          sidebarMounted || view === 'settings' ? 'bg-[var(--sidebar)]' : ''
        }`}
      >
        {view === 'settings' ? (
          <SettingsView />
        ) : (
          <>
            {isSidebarOpen || sidebarLeaving ? (
              /* While sidebarLeaving the sidebar is still mounted and gliding
                 to zero width (see Sidebar's closing prop) — only once that
                 motion finishes does the collapsed peek layout take over. */
              <Sidebar closing={sidebarLeaving} opening={sidebarOpening} />
            ) : (
              <SidebarPeek />
            )}

            {/* Centre column: chat + right panel on top, and beneath it the
                bottom terminal dock — which must span only the chat width,
                never run under the left sidebar. */}
            <div className="flex min-w-0 flex-1 flex-col">
            <div className="relative flex min-h-0 flex-1">
            {/* Centre: the task, with the composer pinned beneath it.
                Transcript text stays selectable; only chrome is select-none.
                The top-left curve: the chat screen is a card in the
                background colour sitting on the row's sidebar colour, so the
                corner notch is the sidebar continuing behind the curve — the
                title bar blends to the sidebar colour in the zero theme, and
                the border-l traces the curve. Collapsed, the sidebar colour
                and the border drop away and the screen is flat full-width. */}
            <main
              className={`flex-1 flex min-w-0 min-h-0 relative select-text bg-[var(--background)] rounded-tl-[14px] ${
                sidebarMounted ? 'border-l border-[var(--border)]' : ''
              }`}
            >
              <div className="relative flex min-w-0 flex-1 flex-col">
              {activeSessionId === null || isNewChat ? (
                /* No chat open (e.g. right after deleting one) or a fresh chat:
                   the centered start screen. Title plus the composer in the
                   middle of the canvas, project row attached beneath it — no
                   transcript, no dock, no suggestion cards. */
                <div className="flex-1 flex flex-col items-center justify-center min-h-0 overflow-y-auto px-4">
                  <h1 className="text-2xl font-medium text-[var(--foreground)] text-center">
                    What should we work on?
                  </h1>
                  <div className="w-full max-w-2xl mt-6">
                    <FloatingInput drafts={drafts} setDrafts={setDrafts} layout="centered" />
                  </div>
                </div>
              ) : (
                <>
                  <ChatContainer />
                  <div className="composer-activity-dock shrink-0 px-2">
                    <div className="mx-auto w-full max-w-4xl space-y-1">
                      {showPinnedSummary && <TaskDock />}
                      <DevServerBar key={activeWorkspaceId} />
                    </div>
                  </div>
                  <FloatingInput drafts={drafts} setDrafts={setDrafts} layout="docked" />
                </>
              )}
              </div>
              <ConversationReferences
                buttonClassName={panelVisible ? 'right-3' : 'right-14'}
                sidePanelOpen={panelVisible}
                onAddSources={addConversationSources}
              />
              </main>
              <RightPanel />
              {/* One persistent toggle is anchored to the workspace edge. It
                  remains the same element in the same position while the
                  panel opens underneath it. */}
              <button
                type="button"
                onClick={togglePanel}
                aria-pressed={panelVisible}
                aria-label={panelHint}
                className={`absolute top-1.5 right-3 z-[70] flex h-8 w-8 items-center justify-center rounded-md border shadow-md transition-colors ${
                  panelVisible
                    ? 'bg-[var(--primary-soft)] border-[var(--primary-ring)] text-[var(--primary)] hover:bg-[var(--accent)]'
                    : 'bg-[var(--card)] border-[var(--input)] text-[var(--foreground)] hover:bg-[var(--accent)]'
                }`}
                title={panelHint}
              >
                {panelVisible ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
              </button>
            </div>

            {/* View → Toggle Bottom Panel: the sandbox terminal dock, under
                the chat column only. */}
            <BottomPanel />
            </div>
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
