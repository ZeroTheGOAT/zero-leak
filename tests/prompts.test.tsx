import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { QuestionPrompt } from '../src/components/chat/QuestionPrompt';
import { PermissionPrompt } from '../src/components/chat/PermissionPrompt';

const context = vi.hoisted(() => ({ value: {} as any }));
vi.mock('../src/context/AppContext', () => ({ useApp: () => context.value }));
beforeEach(() => {
  context.value = {
    pendingQuestion: { id: 'q1', question: 'Which revision should I use?', runId: 'r1' },
    answerQuestion: vi.fn().mockResolvedValue(false),
    pendingPermission: { id: 'p1', title: 'Save report', risk: 'write', tool: 'write_file', rationale: 'Save the draft', target: 'report.txt' },
    respondToPermission: vi.fn().mockResolvedValue(false), workspaces: [],
  };
});
it('keeps a failed answer and displays a visible retry message', async () => {
  render(<QuestionPrompt />);
  await userEvent.type(screen.getByRole('textbox'), 'Revision B');
  await userEvent.click(screen.getByRole('button', { name: 'Send your answer to the agent' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('not delivered'));
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'Revision B');
  expect(screen.getByRole('button')).toHaveProperty('disabled', false);
});
it('does not submit an IME composition when Enter confirms a character', async () => {
  render(<QuestionPrompt />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'ಪರಿಷ್ಕರಣೆ' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true, keyCode: 229 });
  expect(context.value.answerQuestion).not.toHaveBeenCalled();
});
it('disables approval decisions until the first response settles and shows failure inline', async () => {
  let resolve!: (accepted: boolean) => void;
  context.value.respondToPermission.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
  render(<PermissionPrompt />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow this action once' }));
  expect(screen.getByRole('button', { name: 'Reject this action' })).toHaveProperty('disabled', true);
  fireEvent.click(screen.getByRole('button', { name: 'Allow this action once' }));
  expect(context.value.respondToPermission).toHaveBeenCalledOnce();
  await act(async () => resolve(false));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not delivered'));
});
