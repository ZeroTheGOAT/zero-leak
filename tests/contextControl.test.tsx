import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextControl } from '../src/components/chat/ContextControl';
import { MODEL_REGISTRY } from '../src/services/registry';

const mock = vi.hoisted(() => ({ state: {} as any, setContext: vi.fn(), restart: vi.fn(), refresh: vi.fn() }));
vi.mock('../src/context/AppContext', () => ({ useApp: () => mock.state }));
vi.mock('../src/services/core', () => ({ models: { setContext: mock.setContext, routerRestart: mock.restart } }));
const model = { ...MODEL_REGISTRY[0], trainedContext: 262144 };
beforeEach(() => {
  mock.setContext.mockReset().mockResolvedValue([model]); mock.restart.mockReset().mockResolvedValue({}); mock.refresh.mockReset().mockResolvedValue(undefined);
  mock.state = { catalogueModels: [model], modelRuntime: {}, anyRunning: false, coreStatus: { state: 'connected' }, refreshCore: mock.refresh };
});
describe('composer context control', () => {
  it('accepts the model maximum regardless of a small GPU and restarts after saving', async () => {
    mock.state.hardware = { vramTotalMb: 2048 };
    render(<ContextControl modelId={model.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.click(screen.getByRole('button', { name: 'Max (262,144)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply context · restart runtime' }));
    await screen.findByText('Context saved. It applies the next time this model loads.');
    expect(mock.setContext).toHaveBeenCalledWith(model.id, 262144);
    expect(mock.restart).toHaveBeenCalledTimes(1);
  });
  it('refuses fractional or over-training context without saving or restarting', async () => {
    render(<ContextControl modelId={model.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('Context tokens'), { target: { value: '262145' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply context · restart runtime' }));
    expect((await screen.findByRole('alert')).textContent).toContain('1 to 262,144');
    expect(mock.setContext).not.toHaveBeenCalled(); expect(mock.restart).not.toHaveBeenCalled();
  });
  it('returns to Auto and preserves a saved choice if restarting fails', async () => {
    mock.state.catalogueModels = [{ ...model, contextMode: 'manual', contextLimit: 65536 }];
    mock.restart.mockRejectedValue(new Error('Runtime path missing'));
    render(<ContextControl modelId={model.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Auto · fit hardware' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply context · restart runtime' }));
    expect((await screen.findByRole('alert')).textContent).toContain('choice is saved');
    expect(mock.setContext).toHaveBeenCalledWith(model.id, null);
    expect(mock.refresh).toHaveBeenCalled();
  });
  it('prevents runtime changes while another task is active', () => {
    mock.state.anyRunning = true;
    render(<ContextControl modelId={model.id} />);
    expect((screen.getByRole('button', { name: 'Custom' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Apply context · restart runtime' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
