import React, { useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { WorkflowView } from '../src/components/panels/WorkflowView';

const context = vi.hoisted(() => ({ value: {} as any }));
const transport = vi.hoisted(() => ({ call: vi.fn(async () => []) }));
vi.mock('../src/context/AppContext', () => ({ useApp: () => context.value }));
vi.mock('../src/services/transport', () => ({ call: transport.call }));
const initial = { project: { notes: '', files: ['C:/new.pdf', 'C:/old.pdf'] } };
function Harness() {
  const [drafts, setDrafts] = useState(initial);
  context.value.workflowDrafts = drafts;
  context.value.setWorkflowDrafts = setDrafts;
  return <WorkflowView />;
}
beforeEach(() => {
  transport.call.mockReset().mockResolvedValue([]);
  context.value = {
    activeSessionId: 'chat', activeWorkspace: { id: 'project', approved: true, archived: false },
    isRunning: false, send: vi.fn().mockResolvedValue(true), setMode: vi.fn(), newSession: vi.fn(),
    pickAttachments: vi.fn().mockResolvedValue([]), openArtifact: vi.fn(), openDocumentAt: vi.fn(), openTab: vi.fn(),
    catalogueModels: [], coreStatus: { state: 'connected' }, artifacts: [],
  };
});
it('sends the revisions in the operator’s corrected order', async () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /Document revision impact/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Move old.pdf earlier' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Additional instructions' }), { target: { value: 'Check thickness' } });
  fireEvent.click(screen.getByRole('button', { name: 'Start in this task' }));
  await waitFor(() => expect(context.value.send).toHaveBeenCalledWith(expect.stringContaining('Check thickness'), ['C:/old.pdf', 'C:/new.pdf'], 'chat', 'agent'));
});
it('keeps the inputs visible if the core refuses to start', async () => {
  context.value.send.mockResolvedValue(false);
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: 'Start in this task' }));
  expect((await screen.findByRole('alert')).textContent).toContain('inputs are still here');
  expect(screen.getByText('new.pdf')).toBeTruthy();
  expect(screen.getByRole('tabpanel').getAttribute('aria-label')).toBe('workflows content');
});
it('explains the minimum attachment requirement and prevents a premature launch', () => {
  render(<Harness />);
  fireEvent.click(screen.getByRole('button', { name: /Cross-document discrepancy review/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove old.pdf' }));
  expect(screen.getByText('Attach 1 more source file to start.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Start in this task' })).toHaveProperty('disabled', true);
});
it('prevents starts in an unapproved project', () => {
  context.value.activeWorkspace.approved = false;
  render(<Harness />);
  expect(screen.getByText('Approve this project before starting.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Start in this task' })).toHaveProperty('disabled', true);
});
it('shows loading before an empty receipt result arrives', async () => {
  let resolve!: (rows: never[]) => void;
  transport.call.mockImplementation(() => new Promise((done) => { resolve = done; }));
  render(<Harness />);
  fireEvent.click(screen.getByRole('tab', { name: 'Run receipts' }));
  expect(screen.getByRole('status').textContent).toContain('Loading run receipts');
  expect(screen.queryByText(/No receipts recorded/)).toBeNull();
  await act(async () => resolve([]));
  expect(await screen.findByText(/No receipts recorded/)).toBeTruthy();
});
