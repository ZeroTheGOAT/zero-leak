/*
 * Composer structure source-ported from Nerve for ZeroLeak AI.
 * Nerve Copyright © 2026 ThilinaTLM, Apache-2.0. See THIRD_PARTY_NOTICES.md.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Clock,
  Eye,
  FileUp,
  Library,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Send,
  Shield,
  Square,
  X,
} from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { ApprovalPopover } from './ApprovalPopover';
import { ProjectPicker } from './ProjectPicker';
import { formatBytes, modelById } from '../../services/registry';
import { ImageThumb, isImagePath, stagePastedImages } from './attachments';
import { basename } from '../../services/paths';
import {
  blobToBase64,
  recordingToWav,
  transcription,
  transcriptionPreferences,
} from '../../services/transcription';
import type { AgentMode } from '../../types';

const MODES: Array<{ value: AgentMode; label: string; hint: string; icon: React.ElementType }> = [
  { value: 'plan', label: 'Planning', hint: 'Read, research, and propose without changing files.', icon: Eye },
  { value: 'agent', label: 'Agent', hint: 'Edit files and execute approved local tools.', icon: Bot },
];

/**
 * Whole-line commands handled by the composer itself, before anything is
 * sent. The modes and the review panel exist already; the commands are the
 * keyboard path to them, Codex-style. `/serve` is the one that sends a
 * turn — phrased for the agent rather than executed locally, because
 * serving is the agent's tool call to make.
 */
const SLASH_COMMANDS: Array<{ cmd: string; detail: string }> = [
  { cmd: '/plan', detail: 'Switch to Planning mode' },
  { cmd: '/agent', detail: 'Switch to Agent mode' },
  { cmd: '/review', detail: 'Open the pending changes panel' },
  { cmd: '/serve', detail: 'Ask the agent to host the open folder locally' },
];

export interface ComposerDraft {
  text: string;
  attached: string[];
}

const EMPTY_DRAFT: ComposerDraft = { text: '', attached: [] };
type VoiceState = 'idle' | 'checking' | 'recording' | 'transcribing';

export const FloatingInput: React.FC<{
  drafts: Record<string, ComposerDraft>;
  setDrafts: React.Dispatch<React.SetStateAction<Record<string, ComposerDraft>>>;
  /**
   * `centered` is the fresh-chat screen: the card sits in the middle of the
   * canvas with the project row attached beneath it. `docked` is the running
   * conversation: the same card pinned to the bottom, with no project row —
   * the chat already has its home by then.
   */
  layout?: 'docked' | 'centered';
}> = ({ drafts, setDrafts, layout = 'docked' }) => {
  const {
    send,
    isRunning,
    queuedMessages,
    queueMessage,
    removeQueued,
    cancelRun,
    mode,
    setMode,
    activeSessionId,
    activeWorkspace,
    pickAttachments,
    documents,
    coreStatus,
    openTab,
    openSettings,
    knowledgeStats,
    catalogueModels,
    loadedModelIds,
    routeRules,
  } = useApp();
  const [submitting, setSubmitting] = useState(false);
  const [showPlus, setShowPlus] = useState(false);
  const [showApproval, setShowApproval] = useState(false);
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [voiceError, setVoiceError] = useState('');
  // Pressed Stop but `agent://done` has not arrived yet. The backend now
  // aborts within ~100 ms, and this keeps the button from looking dead in
  // the gap — no second cancel is sent while it is set.
  const [stopping, setStopping] = useState(false);
  // Send was pressed while the mic was still capturing: transcribe first,
  // then send the combined text automatically.
  const [sendAfterVoice, setSendAfterVoice] = useState(false);
  const sendAfterVoiceRef = useRef(false);
  const submittingRef = useRef(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordingTimerRef = useRef<number | null>(null);
  // Latest draft, readable from the transcription callback that outlives its
  // render. The user can keep typing while the mic captures.
  const textRef = useRef('');
  const attachedRef = useRef<string[]>([]);
  const draftKey = activeSessionId ?? `__new_chat__:${activeWorkspace?.id ?? 'none'}`;
  const draft = drafts[draftKey] ?? EMPTY_DRAFT;
  const { text, attached } = draft;

  const setText = (value: string) => {
    setDrafts((current) => ({
      ...current,
      [draftKey]: { ...(current[draftKey] ?? EMPTY_DRAFT), text: value },
    }));
  };

  const setAttached = (update: (current: string[]) => string[]) => {
    setDrafts((current) => {
      const existing = current[draftKey] ?? EMPTY_DRAFT;
      return {
        ...current,
        [draftKey]: { ...existing, attached: update(existing.attached) },
      };
    });
  };

  useEffect(() => {
    const element = areaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 176)}px`;
  }, [text]);

  useEffect(() => {
    if (!showPlus && !showApproval) return;
    const close = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) {
        setShowPlus(false);
        setShowApproval(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [showPlus, showApproval]);

  useEffect(() => () => {
    if (recordingTimerRef.current !== null) window.clearTimeout(recordingTimerRef.current);
    const recorder = recorderRef.current;
    if (recorder?.state === 'recording') {
      recorder.onstop = null;
      recorder.stop();
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  useEffect(() => {
    textRef.current = text;
    attachedRef.current = attached;
  }, [text, attached]);

  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  const clearDraft = () => {
    setDrafts((current) => {
      const next = { ...current };
      // A send can finish after the operator has started typing another draft.
      if (current[draftKey] !== draft) return current;
      delete next[draftKey];
      return next;
    });
  };

  const submitValue = async (value: string, files: string[]) => {
    const trimmed = value.trim();
    if (!trimmed || submittingRef.current) return;
    // The turn is busy: park the instruction behind it instead of dropping
    // it. It is sent on its own when the running turn completes.
    if (isRunning) {
      queueMessage(trimmed, files, mode);
      clearDraft();
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const accepted = await send(trimmed, files);
      if (accepted) clearDraft();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const submit = async () => {
    // Send pressed while the mic is still capturing: finish capturing first
    // and send automatically once transcription lands.
    if (voiceState === 'recording' || voiceState === 'transcribing') {
      sendAfterVoiceRef.current = true;
      setSendAfterVoice(true);
      if (voiceState === 'recording') stopRecording();
      return;
    }
    if (!text.trim() || submittingRef.current) return;

    // Whole-line commands are handled here, not sent: they act on the app.
    const trimmed = text.trim();
    const command = SLASH_COMMANDS.find((c) => c.cmd === trimmed);
    if (command) {
      if (command.cmd === '/plan') {
        setMode('plan');
        clearDraft();
      } else if (command.cmd === '/agent') {
        setMode('agent');
        clearDraft();
      } else if (command.cmd === '/review') {
        openTab('review', 'Review');
        clearDraft();
      } else {
        // `/serve` is a real turn: hosting is the agent's serve_folder call,
        // not a local shortcut. Sent in Agent mode so the tool is offered.
        if (isRunning) {
          queueMessage('Host the open workspace folder with serve_folder and give me the http://127.0.0.1 URL to open.', attached, 'agent');
          clearDraft();
          return;
        }
        submittingRef.current = true;
        setSubmitting(true);
        try {
          const accepted = await send(
            'Host the open workspace folder with serve_folder and give me the http://127.0.0.1 URL to open.',
            attached,
            undefined,
            'agent',
          );
          if (accepted) clearDraft();
        } finally {
          submittingRef.current = false;
          setSubmitting(false);
        }
      }
      return;
    }

    await submitValue(text, attached);
  };

  const attach = async () => {
    setShowPlus(false);
    const added = await pickAttachments();
    if (added.length > 0) {
      setAttached((current) => [...new Set([...current, ...added])]);
    }
  };

  /**
   * Paste into the composer: image files on the clipboard are staged to disk
   * and thumbnailed exactly like one picked from the + menu; a text paste is
   * left to the textarea.
   */
  const onComposerPaste = stagePastedImages((paths) => {
    if (paths.length === 0) return;
    setAttached((current) => [...new Set([...current, ...paths])]);
    window.requestAnimationFrame(() => areaRef.current?.focus());
  });

  const insertTranscription = (transcript: string) => {
    const clean = transcript.trim();
    if (!clean) return;
    setDrafts((current) => {
      const existing = current[draftKey] ?? EMPTY_DRAFT;
      const separator = existing.text.length > 0 && !/\s$/.test(existing.text) ? ' ' : '';
      return {
        ...current,
        [draftKey]: { ...existing, text: `${existing.text}${separator}${clean}` },
      };
    });
    window.requestAnimationFrame(() => areaRef.current?.focus());
  };

  const stopRecording = () => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    if (recordingTimerRef.current !== null) {
      window.clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setVoiceState('transcribing');
    recorder.stop();
  };

  const startRecording = async () => {
    setVoiceError('');
    setVoiceState('checking');
    const preferences = transcriptionPreferences();
    try {
      const status = await transcription.status(preferences.modelId);
      if (!status.ready) throw new Error(status.detail);
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Microphone recording is not available in this window.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
        .find((mime) => MediaRecorder.isTypeSupported(mime));
      const recorder = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      const chunks: Blob[] = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        sendAfterVoiceRef.current = false;
        setSendAfterVoice(false);
        setVoiceState('idle');
        setVoiceError('The microphone recording stopped unexpectedly. Please try again.');
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        void (async () => {
          try {
            if (chunks.length === 0) throw new Error('The microphone did not capture any audio.');
            const captured = new Blob(chunks, { type: recorder.mimeType });
            const wav = await recordingToWav(captured);
            const transcript = await transcription.run(await blobToBase64(wav), preferences);
            const clean = transcript.trim();
            if (!clean) {
              if (sendAfterVoiceRef.current) {
                sendAfterVoiceRef.current = false;
                setSendAfterVoice(false);
                setVoiceError('The microphone did not capture any words, so nothing was sent.');
              }
              return;
            }
            if (sendAfterVoiceRef.current) {
              // Send pressed mid-dictation: the combined text goes out as one
              // turn instead of sitting in the composer.
              sendAfterVoiceRef.current = false;
              setSendAfterVoice(false);
              const existing = textRef.current;
              const separator = existing.length > 0 && !/\s$/.test(existing) ? ' ' : '';
              const combined = `${existing}${separator}${clean}`;
              setDrafts((current) => ({
                ...current,
                [draftKey]: { ...(current[draftKey] ?? EMPTY_DRAFT), text: combined },
              }));
              await submitValue(combined, attachedRef.current);
              window.requestAnimationFrame(() => areaRef.current?.focus());
            } else {
              insertTranscription(transcript);
            }
          } catch (error) {
            sendAfterVoiceRef.current = false;
            setSendAfterVoice(false);
            setVoiceError(error instanceof Error ? error.message : String(error));
          } finally {
            setVoiceState('idle');
          }
        })();
      };
      recorder.start(250);
      setVoiceState('recording');
      recordingTimerRef.current = window.setTimeout(stopRecording, 5 * 60 * 1000);
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setVoiceState('idle');
      setVoiceError(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleRecording = () => {
    if (voiceState === 'recording') stopRecording();
    else if (voiceState === 'idle') void startRecording();
  };

  const disabled = coreStatus.state === 'unavailable';
  const activeMode = MODES.find((item) => item.value === mode) ?? MODES[0];
  const ActiveModeIcon = activeMode.icon;
  const loaded = loadedModelIds
    .map((id) => catalogueModels.find((model) => model.id === id)?.displayName)
    .filter(Boolean);
  // The model actually in play: a resident one when something is loaded,
  // else the route the next turn would take — vision when an image is
  // attached, the plain reasoning route for a normal chat. Every step falls
  // back to something name-like (even the raw route id), so the button only
  // reads "No model" when there genuinely is none.
  const routedModelId = routeRules.find((rule) => rule.kind === (attached.some(isImagePath) ? 'photograph' : 'reasoning'))?.modelId;
  const activeModelName =
    loaded[0] ??
    (routedModelId ? modelById(routedModelId)?.displayName ?? routedModelId : undefined) ??
    catalogueModels[0]?.displayName ??
    'No model';
  // Command hints appear while the first word is being typed — after the
  // first space the message is clearly prose that happens to start with '/'.
  const slashHint =
    text.trimStart().startsWith('/') && !text.trim().includes(' ')
      ? SLASH_COMMANDS.filter((c) => c.cmd.startsWith(text.trim()))
      : [];

  const centered = layout === 'centered';

  return (
    <div className={centered ? 'w-full' : 'bg-transparent px-2 pb-2 pt-1'}>
      <div ref={wrapRef} className={centered ? 'relative w-full' : 'relative mx-auto max-w-4xl'}>
        {attached.length > 0 && (
          <div className="mb-2">
            <div className="flex flex-wrap gap-1.5">
              {attached.map((path) => {
                const document = documents.find((item) => item.path === path);
                // A pasted image thumbnails like ChatGPT; anything else stays
                // a chip with its name.
                if (isImagePath(path)) {
                  return (
                    <span key={path} className="relative flex-shrink-0">
                      <ImageThumb path={path} className="h-16 w-16 rounded-md" />
                      <button
                        type="button"
                        onClick={() => setAttached((current) => current.filter((item) => item !== path))}
                        className="absolute -right-1.5 -top-1.5 grid size-5 place-items-center rounded-full border nerve-border bg-[var(--card)] text-[var(--muted-foreground)] shadow-sm hover:text-[var(--foreground)] transition"
                        title="Remove image"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  );
                }
                return (
                  <span key={path} className="flex items-center gap-1.5 rounded-md border nerve-border bg-[var(--card)] py-1 pl-2 pr-1 text-xs text-[var(--card-foreground)]" title={path}>
                    <Paperclip size={10} className="text-[var(--muted-foreground)]" />
                    <span className="max-w-[220px] truncate">{document?.fileName ?? basename(path)}</span>
                    {document && <span className="text-[10px] text-[var(--muted-foreground)]">{formatBytes(document.sizeBytes)}</span>}
                    <button onClick={() => setAttached((current) => current.filter((item) => item !== path))} aria-label={`Remove ${basename(path)} from draft`} className="grid size-5 place-items-center rounded hover:bg-[var(--accent)]"><X size={10} /></button>
                  </span>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
              {attached.some(isImagePath)
                ? 'Image added · nothing is read until you send an instruction'
                : 'Attached to this draft · nothing is read until you send an instruction'}
            </p>
          </div>
        )}

        {queuedMessages.length > 0 && (
          <div className="mb-2">
            <div className="flex flex-wrap gap-1.5">
              {queuedMessages.map((queued, i) => (
                <span key={queued.id} className="flex items-center gap-1.5 rounded-md border nerve-border bg-[var(--card)] py-1 pl-2 pr-1 text-xs text-[var(--card-foreground)]" title={queued.text}>
                  <Clock size={10} className="text-[var(--muted-foreground)]" />
                  <span className="max-w-[220px] truncate">{queued.text}</span>
                  {queued.attachments.length > 0 && <span>{queued.attachments.length} attached</span>}
                  <button onClick={() => removeQueued(i)} className="grid size-5 place-items-center rounded hover:bg-[var(--accent)]" title="Take it back"><X size={10} /></button>
                </span>
              ))}
            </div>
            <p className="mt-1 text-[10px] text-[var(--muted-foreground)]">
              Queued · sent automatically when the current run finishes
            </p>
          </div>
        )}

        <div className={`composer-shell relative mt-2 overflow-visible border bg-[var(--background)] shadow-sm transition ${
          centered ? 'rounded-xl rounded-b-none' : 'rounded-[calc(var(--radius)*0.8)]'
        } ${
          mode === 'plan' ? 'border-[var(--success)]' : 'border-[var(--input)] focus-within:border-[var(--primary)]'
        }`}>
          {/* Mode, permission and model controls ride the card's top edge —
              each solid pill covers the edge behind itself, so the pills read
              as separate buttons attached to the bar with plain canvas
              everywhere around them. */}
          <div
            className={`pointer-events-none absolute inset-x-2.5 top-0 flex -translate-y-1/2 items-center gap-1 [&>*]:pointer-events-auto ${
              showApproval ? 'z-50' : 'z-20'
            }`}
          >
            <button type="button" onClick={() => setMode(mode === 'plan' ? 'agent' : 'plan')} className="composer-tab" title={`${activeMode.label}: ${activeMode.hint}`}>
              <ActiveModeIcon size={13} strokeWidth={2.2} />
              <span>{activeMode.label}</span>
            </button>
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowPlus(false);
                  setShowApproval((open) => !open);
                }}
                data-state={showApproval ? 'open' : 'closed'}
                aria-expanded={showApproval}
                aria-haspopup="dialog"
                className="composer-tab w-7 p-0"
                title="Permission rule set"
              >
                <Shield size={13} strokeWidth={2.2} />
              </button>
              {showApproval && <ApprovalPopover onClose={() => setShowApproval(false)} />}
            </div>
            {/* The model in play, back on the right where it was — a solid
                pill like the rest, so it covers the edge behind itself.
                Sizes itself to short names, truncates long ones, full name
                on hover. Opens Models. */}
            <div className="ml-auto flex items-center">
              <button
                type="button"
                onClick={() => openSettings('models')}
                className="composer-tab min-w-0 max-w-44 truncate"
                title={`${activeModelName} — open model settings`}
              >
                <Bot size={13} strokeWidth={2.2} />
                <span className="truncate">{activeModelName}</span>
              </button>
            </div>
          </div>

          <textarea
            ref={areaRef}
            data-inset-field
            value={text}
            aria-label="Message the local agent"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === 'Tab' && !event.shiftKey && slashHint.length > 0) {
                // Complete the command instead of moving focus out of the
                // composer — the hint list is the only thing Tab means here.
                event.preventDefault();
                setText(slashHint[0].cmd);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            onPaste={onComposerPaste}
            rows={2}
            disabled={disabled}
            placeholder={disabled ? 'The local core is not attached' : attached.length > 0 ? 'Tell the agent what to do with the attached files' : 'Ask the local ZeroLeak agent'}
            className="min-h-[5.8rem] w-full resize-none bg-transparent px-4 pb-[2.4rem] pt-[1.4rem] text-sm text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none disabled:cursor-not-allowed disabled:opacity-60"
          />

          {slashHint.length > 0 && (
            <div className="absolute bottom-full left-0 z-40 mb-1.5 w-72 max-w-full overflow-hidden rounded-xl border nerve-border bg-[var(--popover)] py-1 text-[var(--popover-foreground)] shadow-[shadow:var(--shadow-lg)] animate-popover">
              {slashHint.map((c) => (
                <button
                  key={c.cmd}
                  type="button"
                  onClick={() => setText(c.cmd)}
                  className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs hover:bg-[var(--accent)]"
                >
                  <span className="font-mono text-[var(--foreground)]">{c.cmd}</span>
                  <span className="text-[10px] text-[var(--muted-foreground)]">{c.detail}</span>
                </button>
              ))}
              <p className="px-3 pt-1 pb-0.5 text-[10px] text-[var(--muted-foreground)] border-t border-[var(--border)] mt-0.5">
                Tab completes · Enter runs
              </p>
            </div>
          )}

          <div
            className={`absolute bottom-2 left-2 flex items-center gap-1 ${
              showPlus ? 'z-50' : 'z-10'
            }`}
          >
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setShowApproval(false);
                  setShowPlus((open) => !open);
                }}
                disabled={disabled}
                data-state={showPlus ? 'open' : 'closed'}
                aria-expanded={showPlus}
                aria-haspopup="menu"
                className="grid size-8 place-items-center rounded-full text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
                title="Add context"
              >
                <Plus size={16} />
              </button>
              {showPlus && (
                <div
                  role="menu"
                  aria-label="Add context"
                  className="absolute bottom-full left-0 z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] origin-bottom-left rounded-xl border nerve-border bg-[var(--popover)] py-1 text-[var(--popover-foreground)] shadow-[shadow:var(--shadow-lg)] animate-popover"
                >
                  <button type="button" role="menuitem" onClick={() => void attach()} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-[var(--accent)]"><FileUp size={13} /><span>Attach document or image<span className="block text-[10px] text-[var(--muted-foreground)]">PDF, Office, scan, photo, drawing</span></span></button>
                  <button type="button" role="menuitem" onClick={() => { setShowPlus(false); openTab('knowledge', 'Knowledge'); }} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-[var(--accent)]"><Library size={13} /><span>Knowledge base<span className="block text-[10px] text-[var(--muted-foreground)]">{knowledgeStats.documents} local documents</span></span></button>
                </div>
              )}
            </div>
          </div>

          <div className="absolute bottom-2 right-2 z-10 flex items-center gap-1.5">
            {coreStatus.state === 'unavailable' && <span className="mr-1 text-[10px] text-[var(--warning)]">core detached</span>}
            <button
              type="button"
              onClick={toggleRecording}
              disabled={disabled || voiceState === 'checking' || voiceState === 'transcribing'}
              aria-pressed={voiceState === 'recording'}
              className={`grid size-8 place-items-center rounded-full border transition disabled:cursor-wait disabled:opacity-60 ${
                voiceState === 'recording'
                  ? 'border-[var(--destructive-solid)] bg-[var(--destructive-solid)] text-[var(--destructive-solid-foreground)] animate-pulse'
                  : 'nerve-border bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--accent)]'
              }`}
              title={voiceState === 'recording' ? 'Stop and transcribe' : 'Record with the local transcription model'}
            >
              {voiceState === 'checking' || voiceState === 'transcribing'
                ? <Loader2 size={15} className="animate-spin" />
                : voiceState === 'recording' ? <Square size={11} fill="currentColor" /> : <Mic size={15} />}
            </button>
            {isRunning ? (
              <>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={(!text.trim() && voiceState === 'idle') || disabled || submitting}
                  className="nerve-border grid size-8 place-items-center rounded-full bg-[var(--card)] text-[var(--foreground)] hover:bg-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-30"
                  title={voiceState === 'idle' ? 'Queue — sent when this run finishes (Enter)' : 'Finish dictation and queue it when this run finishes'}
                >
                  <Clock size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (stopping) return;
                    setStopping(true);
                    void cancelRun();
                  }}
                  disabled={stopping}
                  className="grid size-8 place-items-center rounded-full bg-[var(--destructive-solid)] text-[var(--destructive-solid-foreground)] disabled:opacity-60"
                  title={stopping ? 'Stopping…' : 'Stop generation'}
                >
                  {stopping ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} fill="currentColor" />}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => void submit()}
                disabled={(!text.trim() && voiceState === 'idle') || disabled || submitting}
                className="zeroleak-primary grid size-8 place-items-center rounded-full shadow-sm disabled:cursor-not-allowed disabled:opacity-30"
                title={voiceState === 'idle' ? 'Send (Enter)' : 'Finish dictation and send automatically'}
              >
                {submitting || sendAfterVoice ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} strokeWidth={2.4} />}
              </button>
            )}
          </div>
        </div>

        {/* Fresh-chat project row — the attached bar beneath the card. Name
            only, never a folder path. Running conversations dock without it:
            the chat already has its home by then. */}
        {centered && (
          <div className="composer-attached flex items-center gap-1.5 rounded-xl rounded-t-none border border-t-0 border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5">
            <ProjectPicker />
          </div>
        )}

        {sendAfterVoice && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--muted-foreground)]"><Loader2 size={10} className="animate-spin" />Will send automatically after transcription</p>}
        {voiceState === 'recording' && !sendAfterVoice && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--destructive)]"><span className="size-1.5 rounded-full bg-current animate-pulse" />Listening locally · click stop when finished · or press Send to finish and send</p>}
        {voiceState === 'recording' && sendAfterVoice && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--destructive)]"><span className="size-1.5 rounded-full bg-current animate-pulse" />Finishing dictation · will send automatically</p>}
        {voiceState === 'transcribing' && !sendAfterVoice && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--muted-foreground)]"><Loader2 size={10} className="animate-spin" />Transcribing locally · audio stays on this device</p>}
        {voiceState === 'transcribing' && sendAfterVoice && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--muted-foreground)]"><Loader2 size={10} className="animate-spin" />Transcribing locally · will send automatically</p>}
        {voiceError && <p role="alert" className="mt-1.5 flex items-center justify-center gap-2 text-[10px] text-[var(--destructive)]"><span className="max-w-[42rem] truncate" title={voiceError}>{voiceError}</span><button type="button" onClick={() => openSettings('transcription')} className="underline underline-offset-2">Transcription settings</button><button type="button" onClick={() => setVoiceError('')} aria-label="Dismiss transcription error"><X size={10} /></button></p>}
        {isRunning && stopping && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--muted-foreground)]"><Loader2 size={10} className="animate-spin" />Stopping…</p>}
        {isRunning && !stopping && <p className="mt-1.5 flex items-center justify-center gap-1.5 text-[10px] text-[var(--muted-foreground)]"><Loader2 size={10} className="animate-spin" />Running locally · nothing leaves this device · type to queue a follow-up</p>}
      </div>
    </div>
  );
};
