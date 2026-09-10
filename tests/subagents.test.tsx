import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, useApp } from '../src/context/AppContext';
import { ConversationReferences } from '../src/components/chat/ConversationReferences';
import { SubagentsView } from '../src/components/panels/SubagentsView';
import { ConversationSourcesView } from '../src/components/panels/ConversationSourcesView';
import { mergeSubagentMessages, mergeSubagents } from '../src/services/subagents';
import type { StoredMessage, SubagentInfo } from '../src/types';

const bridge = vi.hoisted(() => ({ call: vi.fn(), listeners: new Map<string, (payload: any) => void>() }));
vi.mock('../src/services/transport', () => ({
  call: bridge.call,
  on: vi.fn(async (event: string, handler: (payload: any) => void) => {
    bridge.listeners.set(event, handler);
    return () => { bridge.listeners.delete(event); };
  }),
  transport: () => 'http', isDesktopShell: () => false,
  startWindowDragging: vi.fn(), CoreUnavailable: class extends Error {},
}));

let app: ReturnType<typeof useApp>;
let stored: StoredMessage[];
function Harness() {
  app = useApp();
  return <><ConversationReferences />{app.isPanelOpen && (app.tabs.find((tab) => tab.id === app.activeTabId)?.kind === 'sources' ? <ConversationSourcesView /> : <SubagentsView />)}</>;
}
const baseCall = async (command: string) => {
  if (command === 'core_status') return { state: 'connected', ipc: true, router: true, detail: 'Ready' };
  if (command === 'subagent_history') return stored;
  if (command.endsWith('_list') || command === 'devserver_status') return [];
  if (command === 'turn_start') return { runId: 'parent-run' };
  return null;
};
beforeEach(() => { bridge.listeners.clear(); bridge.call.mockReset().mockImplementation(baseCall); stored = []; });
async function start() {
  render(<AppProvider><Harness /></AppProvider>);
  await waitFor(() => expect(app.coreStatus.state).toBe('connected'));
  await act(async () => { await app.send('Parent task'); });
}
function agent(id = 'inspect', patch: Partial<SubagentInfo> = {}): SubagentInfo {
  return { id, taskName: id, path: `/root/${id}`, rootSessionId: app?.activeSessionId ?? 'root',
    sessionId: `child-${id}`, parentRunId: 'parent-run', role: 'explorer', status: 'running',
    depth: 1, runId: `run-${id}`, result: '', createdAt: 1, updatedAt: 2, ...patch };
}
function emit(event: string, payload: unknown) { act(() => { bridge.listeners.get(event)?.(payload); }); }
function publish(row: SubagentInfo) { emit('agent://subagent', { rootSessionId: row.rootSessionId, parentRunId: row.parentRunId, agent: row }); }

describe('sub-agent Sources and chat', () => {
  it('shows Sources for agents alone, previews three and opens every agent without leaving the parent', async () => {
    await start();
    const root = app.activeSessionId;
    for (let index = 1; index <= 5; index++) publish(agent(`worker-${index}`));
    publish(agent('foreign', { rootSessionId: 'another-project-chat' }));
    fireEvent.click(screen.getByRole('button', { name: /Toggle conversation outputs and sources/ }));
    const sources = screen.getByRole('complementary');
    expect(within(sources).getByRole('heading', { name: 'Sub-agents' })).toBeTruthy();
    expect(within(sources).getAllByRole('button', { name: /^View sub-agent / })).toHaveLength(3);
    fireEvent.click(within(sources).getByRole('button', { name: 'View all sub-agents' }));
    expect(screen.getAllByRole('button', { name: /^View sub-agent / })).toHaveLength(5);
    expect(screen.queryByText('foreign')).toBeNull();
    stored = [{ id: 'prompt', sender: 'user', content: 'Inspect the local report', createdAt: 1 }];
    fireEvent.click(screen.getByRole('button', { name: 'View sub-agent worker-5' }));
    await screen.findByText('Inspect the local report');
    expect(app.activeSessionId).toBe(root);
    expect(bridge.call).toHaveBeenCalledWith('subagent_history', { rootSessionId: root, target: 'worker-5' });
    fireEvent.click(screen.getByRole('button', { name: 'View all sub-agents (5)' }));
    expect(screen.getAllByRole('button', { name: /^View sub-agent / })).toHaveLength(5);
  });

  it('captures work before opening the panel and keeps child completion out of the parent chat', async () => {
    await start();
    const row = agent('inspect', { status: 'pending', runId: undefined });
    publish(row);
    emit('agent://text', { sessionId: row.sessionId, runId: 'run-inspect', kind: 'answer', delta: 'Reading the report' });
    publish({ ...row, status: 'running', runId: 'run-inspect', updatedAt: 3 });
    emit('agent://step', { id: 'read', sessionId: row.sessionId, runId: 'run-inspect', kind: 'reading_file', title: 'Opening report.pdf', status: 'running', startedAt: 2 });
    act(() => app.viewSubagents(row.id));
    await screen.findByText('Reading the report');
    expect(screen.getByRole('status').textContent).toBe('Opening report.pdf');
    expect(app.liveActivity).toEqual([]);
    expect(app.runningSessionIds).toEqual([row.rootSessionId]);
    stored = [{ id: 'saved-answer', sender: 'agent', runId: 'run-inspect', content: 'Report checked', createdAt: 4 }];
    publish({ ...row, status: 'completed', runId: 'run-inspect', result: 'Report checked', updatedAt: 4 });
    emit('agent://done', { sessionId: row.sessionId, runId: 'run-inspect', message: 'Report checked', summary: '', citations: [], changes: [] });
    await waitFor(() => expect(screen.getAllByText('Report checked')).toHaveLength(1));
    expect(app.messages.some((message) => message.content === 'Report checked')).toBe(false);
    expect(app.isRunning).toBe(true);
    expect(screen.queryByRole('button', { name: 'Stop sub-agent inspect' })).toBeNull();
    expect(bridge.call.mock.calls.some(([command, args]) => command === 'session_activity_store' && args.sessionId === row.sessionId)).toBe(true);
  });

  it('ignores an older registry response arriving after completion', async () => {
    await start();
    const row = agent();
    let resolve!: (rows: SubagentInfo[]) => void;
    bridge.call.mockImplementation((command) => command === 'subagent_list' ? new Promise((done) => { resolve = done; }) : baseCall(command));
    act(() => window.dispatchEvent(new CustomEvent('sovereign:resync')));
    publish({ ...row, status: 'completed', result: 'Finished', updatedAt: 5 });
    await act(async () => { resolve([row]); });
    expect(app.subagents[0].status).toBe('completed');
  });

  it('releases the child buffer if launching a reserved agent fails', async () => {
    await start();
    const row = agent('cannot-start', { status: 'pending', runId: undefined });
    publish(row);
    publish({ ...row, status: 'failed', error: 'Launch refused', updatedAt: 3 });
    expect(app.subagentChats[row.id].live).toBeUndefined();
  });

  it('keeps a stopping child visible and prevents repeated stop requests until it finishes', async () => {
    await start();
    const row = agent(); publish(row);
    act(() => app.viewSubagents(row.id));
    publish({ ...row, status: 'stopping', updatedAt: 3 });
    const stop = screen.getByRole('button', { name: 'Stop sub-agent inspect' });
    expect(stop).toHaveProperty('disabled', true);
    expect(stop.textContent).toContain('Stopping');
    expect(app.runningSessionIds).toContain(row.rootSessionId);
    fireEvent.click(stop);
    expect(bridge.call.mock.calls.some(([command]) => command === 'subagent_interrupt')).toBe(false);
    publish({ ...row, status: 'interrupted', updatedAt: 4 });
    expect(screen.queryByRole('button', { name: 'Stop sub-agent inspect' })).toBeNull();
  });

  it('discards a slow old chat response when the operator selects another agent or root', async () => {
    await start();
    publish(agent('first')); publish(agent('second'));
    let resolve!: (rows: StoredMessage[]) => void;
    bridge.call.mockImplementation((command, args) => command === 'subagent_history' && args.target === 'first'
      ? new Promise((done) => { resolve = done; }) : baseCall(command));
    act(() => app.viewSubagents('first'));
    act(() => app.viewSubagents('second'));
    await act(async () => { resolve([{ id: 'old', sender: 'user', content: 'First agent private task', createdAt: 1 }]); });
    expect(screen.queryByText('First agent private task')).toBeNull();
    expect(screen.getByRole('heading', { name: 'second' })).toBeTruthy();
    act(() => { app.newSession('personal'); });
    expect(screen.queryByRole('heading', { name: 'second' })).toBeNull();
    expect(app.subagents).toEqual([]);
  });

  it('shows a retryable history error and routes Stop only to the selected agent', async () => {
    await start();
    const row = agent(); publish(row);
    bridge.call.mockImplementation(async (command, args) => {
      if (command === 'subagent_history') throw new Error('Local history unavailable');
      if (command === 'subagent_interrupt') return { ...row, status: 'interrupted', updatedAt: 3 };
      return baseCall(command);
    });
    act(() => app.viewSubagents(row.id));
    await screen.findByText('Local history unavailable');
    expect(screen.getByRole('button', { name: 'Retry loading chat' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stop sub-agent inspect' }));
    await waitFor(() => expect(app.subagents[0].status).toBe('interrupted'));
    expect(bridge.call).toHaveBeenCalledWith('subagent_interrupt', { rootSessionId: row.rootSessionId, target: row.id });
    expect(app.isRunning).toBe(true);
    bridge.call.mockImplementation(baseCall);
    stored = [{ id: 'recovered', sender: 'user', content: 'Recovered task', createdAt: 1 }];
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading chat' }));
    await screen.findByText('Recovered task');
    expect(screen.queryByText('Local history unavailable')).toBeNull();
  });

  it('includes sub-agents in the full Sources panel even without attachments', async () => {
    await start(); publish(agent('review', { role: 'reviewer', status: 'failed', error: 'Model unavailable' }));
    act(() => app.openTab('sources', 'Sources'));
    expect(screen.getByRole('button', { name: 'View sub-agent review' })).toBeTruthy();
    expect(screen.queryByText('No sources are attached to this conversation.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View all sub-agents' }));
    fireEvent.click(screen.getByRole('button', { name: 'View sub-agent review' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Model unavailable'));
  });
});

describe('sub-agent record merging', () => {
  it('retains final status on a tied timestamp and rejects records from another root', () => {
    const current = agent('a', { rootSessionId: 'root', status: 'completed' });
    expect(mergeSubagents([current], [agent('a', { rootSessionId: 'root' }), agent('b', { rootSessionId: 'foreign' })], 'root')).toEqual([current]);
  });
  it('preserves the stored prompt and deduplicates saved and live answers by run', () => {
    expect(mergeSubagentMessages([
      { id: 'user', sender: 'user', content: 'Read this', createdAt: 1 },
      { id: 'saved', sender: 'agent', runId: 'r', content: 'Done', createdAt: 2 },
    ], [{ id: 'msg-r', sender: 'agent', runId: 'r', content: 'Done', createdAt: 3 }])).toHaveLength(2);
  });
});
