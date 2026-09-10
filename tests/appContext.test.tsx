import React, { useState } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FloatingInput, type ComposerDraft } from '../src/components/chat/FloatingInput';
import { AppProvider, useApp } from '../src/context/AppContext';

const bridge = vi.hoisted(() => ({
  call: vi.fn(),
  listeners: new Map<string, (payload: any) => void>(),
}));
vi.mock('../src/services/transport', () => ({
  call: bridge.call,
  on: vi.fn(async (event: string, handler: (payload: any) => void) => {
    bridge.listeners.set(event, handler);
    return () => { bridge.listeners.delete(event); };
  }),
  transport: () => 'http', isDesktopShell: () => false,
  startWindowDragging: vi.fn(), CoreUnavailable: class extends Error {},
}));

const connected = { state: 'connected', ipc: true, router: true, detail: 'Ready' };
const baseCall = async (command: string) => {
  if (command === 'core_status') return connected;
  if (command.endsWith('_list') || command === 'devserver_status') return [];
  if (command === 'turn_start') return { runId: 'run-1' };
  return null;
};
beforeEach(() => {
  bridge.listeners.clear();
  bridge.call.mockReset().mockImplementation(baseCall);
});
async function app() {
  const hook = renderHook(useApp, { wrapper: ({ children }) => <AppProvider>{children}</AppProvider> });
  await waitFor(() => expect(hook.result.current.coreStatus.state).toBe('connected'));
  return hook;
}
function emit(event: string, data: unknown) {
  act(() => { bridge.listeners.get(event)?.(data); });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('submitting tasks', () => {
  it('returns false offline and keeps the transcript untouched', async () => {
    const { result } = await app();
    emit('core://status', { ...connected, state: 'unavailable', detail: 'Disconnected' });
    await act(async () => { expect(await result.current.send('Read my report', ['C:/report.pdf'])).toBe(false); });
    expect(result.current.messages).toEqual([]);
    expect(bridge.call.mock.calls.some(([command]) => command === 'turn_start')).toBe(false);
  });
  it('returns false on start failure, keeps the request visible, and releases the composer', async () => {
    const { result } = await app();
    bridge.call.mockImplementation(async (command) => {
      if (command === 'turn_start') throw new Error('Model unavailable');
      return baseCall(command);
    });
    await act(async () => { expect(await result.current.send('Read this')).toBe(false); });
    expect(result.current.isRunning).toBe(false);
    expect(result.current.messages.some((message) => message.content === 'Read this')).toBe(true);
    expect(result.current.failures.some((failure) => failure.message.includes('Model unavailable'))).toBe(true);
  });
  it('recovers a missed completion from receipts after reconnecting', async () => {
    const { result } = await app();
    await act(async () => { expect(await result.current.send('Inspect report')).toBe(true); });
    const sid = result.current.activeSessionId;
    expect(result.current.isRunning).toBe(true);
    bridge.call.mockImplementation(async (command) => {
      if (command === 'receipt_list') return [{ runId: 'run-1', sessionId: sid, status: 'finished' }];
      if (command === 'session_history') return [{ id: 'answer-1', sender: 'agent', content: 'Inspection complete', createdAt: 1 }];
      return baseCall(command);
    });
    await act(async () => { window.dispatchEvent(new CustomEvent('sovereign:resync')); });
    await waitFor(() => expect(result.current.isRunning).toBe(false));
    expect(result.current.messages[0].content).toBe('Inspection complete');
    emit('agent://done', { runId: 'run-1', sessionId: sid, message: 'Duplicate completion' });
    expect(result.current.messages).toHaveLength(1);
  });
  it('does not declare a slow run finished when its receipt is still running', async () => {
    const { result } = await app();
    await act(async () => { await result.current.send('Inspect report'); });
    bridge.call.mockImplementation(async (command) => command === 'receipt_list'
      ? [{ runId: 'run-1', status: 'running' }] : baseCall(command));
    await act(async () => { await result.current.refreshCore(); });
    expect(result.current.isRunning).toBe(true);
  });
});

describe('operator prompts', () => {
  it('keeps a failed answer, prevents duplicates, and accepts a native null acknowledgement', async () => {
    const { result } = await app();
    const question = { id: 'q1', runId: 'r1', question: 'Which revision?' };
    emit('agent://question', question);
    emit('agent://question', question);
    const response = deferred<null>();
    bridge.call.mockImplementation(async (command) => command === 'question_answer' ? response.promise : baseCall(command));
    let first!: Promise<boolean>;
    act(() => { first = result.current.answerQuestion('Revision B'); });
    await act(async () => { expect(await result.current.answerQuestion('Revision C')).toBe(false); });
    expect(result.current.pendingQuestion?.id).toBe('q1');
    await act(async () => { response.reject(new Error('Connection lost')); expect(await first).toBe(false); });
    expect(result.current.pendingQuestion?.id).toBe('q1');
    bridge.call.mockImplementation(baseCall);
    await act(async () => { expect(await result.current.answerQuestion('Revision B')).toBe(true); });
    expect(result.current.pendingQuestion).toBeNull();
  });
  it('removes only the acknowledged permission when another arrives meanwhile', async () => {
    const { result } = await app();
    emit('agent://permission', { id: 'p1', runId: 'r1' });
    const response = deferred<null>();
    bridge.call.mockImplementation(async (command) => command === 'permission_respond' ? response.promise : baseCall(command));
    let first!: Promise<boolean>;
    act(() => { first = result.current.respondToPermission('allow_once'); });
    emit('agent://permission', { id: 'p2', runId: 'r2' });
    expect(result.current.pendingPermission?.id).toBe('p1');
    await act(async () => { response.resolve(null); expect(await first).toBe(true); });
    expect(result.current.pendingPermission?.id).toBe('p2');
  });
  it('clears questions for the completed run and keeps another run’s question', async () => {
    const { result } = await app();
    emit('agent://question', { id: 'q1', runId: 'r1' });
    emit('agent://question', { id: 'q2', runId: 'r2' });
    await act(async () => { bridge.listeners.get('agent://done')?.({ runId: 'r1', sessionId: 's1', message: '', summary: 'Stopped.', citations: [], changes: [] }); });
    expect(result.current.pendingQuestion?.id).toBe('q2');
  });
});

function ComposerHarness() {
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  return <FloatingInput drafts={drafts} setDrafts={setDrafts} />;
}

it('keeps the first welcome-screen draft after a failed launch creates a chat', async () => {
  bridge.call.mockImplementation(async (command) => {
    if (command === 'turn_start') throw new Error('Model unavailable');
    return baseCall(command);
  });
  render(<AppProvider><ComposerHarness /></AppProvider>);
  const textbox = screen.getByRole('textbox', { name: 'Message the local agent' });
  await waitFor(() => expect(textbox).toHaveProperty('disabled', false));
  fireEvent.change(textbox, { target: { value: 'Please read this report' } });
  fireEvent.keyDown(textbox, { key: 'Enter' });
  await waitFor(() => expect(bridge.call.mock.calls.some(([command]) => command === 'turn_start')).toBe(true));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message the local agent' })).toHaveProperty('value', 'Please read this report'));
});

it('serializes document imports and clears progress after a failed file', async () => {
  const { result } = await app();
  const response = deferred<null>();
  bridge.call.mockImplementation(async (command) => {
    if (command === 'document_pick') return ['C:/report.pdf'];
    if (command === 'document_ingest') return response.promise;
    return baseCall(command);
  });
  let first!: Promise<void>;
  act(() => { first = result.current.ingestFiles(); });
  await waitFor(() => expect(result.current.ingestProgress?.fileName).toBe('report.pdf'));
  await act(async () => { await result.current.ingestFiles(); });
  expect(bridge.call.mock.calls.filter(([command]) => command === 'document_ingest')).toHaveLength(1);
  await act(async () => { response.reject(new Error('Unreadable PDF')); await first; });
  expect(result.current.ingestProgress).toBeNull();
});

it('resumes a queued instruction after reconnecting to a completed run', async () => {
  const { result } = await app();
  await act(async () => { await result.current.send('First task'); });
  act(() => { result.current.queueMessage('Follow-up'); });
  emit('core://status', { ...connected, state: 'unavailable', detail: 'Disconnected' });
  bridge.call.mockImplementation(async (command) => {
    if (command === 'receipt_list') return [{ runId: 'run-1', status: 'finished' }];
    if (command === 'session_history') return [];
    if (command === 'turn_start') return { runId: 'run-2' };
    return baseCall(command);
  });
  await act(async () => { await result.current.refreshCore(); });
  await waitFor(() => expect(result.current.queuedMessages).toHaveLength(0));
  expect(result.current.isRunning).toBe(true);
});


describe('durable settings and model saves', () => {
  it('propagates model registration errors so the editor can preserve its draft', async () => {
    const { result } = await app();
    bridge.call.mockImplementation(async (command) => {
      if (command === 'model_catalogue_add') throw new Error('Duplicate catalogue id');
      return baseCall(command);
    });
    await act(async () => {
      await expect(result.current.addCatalogueModel({ id: 'custom' } as any)).rejects.toThrow('Duplicate catalogue id');
    });
  });
  it('does not pretend disconnected settings were saved', async () => {
    const { result } = await app();
    const original = result.current.settings;
    emit('core://status', { ...connected, state: 'unavailable' });
    await act(async () => { expect(await result.current.updateSettings({ privateServerName: 'New name' })).toBe(false); });
    expect(result.current.settings).toEqual(original);
    expect(bridge.call.mock.calls.some(([command]) => command === 'settings_set')).toBe(false);
  });
  it('serializes independent saves and does not roll a later setting back', async () => {
    const { result } = await app();
    const original = result.current.settings;
    const first = deferred<any>();
    let calls = 0;
    bridge.call.mockImplementation(async (command) => {
      if (command !== 'settings_set') return baseCall(command);
      calls++;
      if (calls === 1) return first.promise;
      return { ...original, privateServerName: 'Saved name', extendedThinking: true };
    });
    let p1!: Promise<boolean>, p2!: Promise<boolean>;
    act(() => {
      p1 = result.current.updateSettings({ privateServerName: 'Saved name' });
      p2 = result.current.updateSettings({ extendedThinking: true });
    });
    await waitFor(() => expect(calls).toBe(1));
    await act(async () => {
      first.resolve({ ...original, privateServerName: 'Saved name' });
      expect(await p1).toBe(true); expect(await p2).toBe(true);
    });
    expect(calls).toBe(2);
    expect(result.current.settings.privateServerName).toBe('Saved name');
    expect(result.current.settings.extendedThinking).toBe(true);
  });
});
