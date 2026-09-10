import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelEditor } from '../src/components/settings/ModelEditor';
import { McpSettings } from '../src/components/settings/McpSettings';
import { importMcpConfig, npmImport, parseArguments, parseEnvironment } from '../src/services/mcpConfig';
import { MODEL_REGISTRY, DEFAULT_SETTINGS } from '../src/services/registry';

const mock = vi.hoisted(() => ({ save: vi.fn(), install: vi.fn(), probe: vi.fn(), pick: vi.fn(), state: {} as any }));
vi.mock('../src/context/AppContext', () => ({ useApp: () => mock.state }));
vi.mock('../src/services/core', () => ({ pickSettingsPath: mock.pick, integrations: { installMcp: mock.install, probeMcp: mock.probe } }));

beforeEach(() => {
  mock.save.mockReset().mockResolvedValue(true); mock.install.mockReset(); mock.pick.mockReset(); mock.probe.mockReset();
  mock.state = { settings: { ...DEFAULT_SETTINGS, mcpServers: [] }, coreStatus: { state: 'connected' }, updateSettings: mock.save };
});

describe('model settings', () => {
  it('keeps the editor and all custom fields after a failed save', async () => {
    const save = vi.fn().mockRejectedValue(new Error('Weights not found'));
    const close = vi.fn();
    const initial = MODEL_REGISTRY.find((m) => m.id === 'gemma-4-e4b')!;
    render(<ModelEditor initial={{ ...initial, presetOptions: { 'image-min-tokens': '1024' } }} onAdd={save} onClose={close} />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Custom vision model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await screen.findByText('Weights not found');
    expect(close).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Custom vision model');
    expect(save.mock.calls[0][0]).toMatchObject({ displayName: 'Custom vision model', projector: initial.projector, capabilities: initial.capabilities, kvCacheType: 'q8_0', presetOptions: { 'image-min-tokens': '1024' } });
    expect(save.mock.calls[0][1]).toBe(true);
  });
  it('requires a projector for a custom vision model before saving', async () => {
    const save = vi.fn();
    render(<ModelEditor initial={{ ...MODEL_REGISTRY[0], capabilities: ['vision'], projector: undefined }} onAdd={save} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect((await screen.findByRole('alert')).textContent).toContain('matching GGUF vision projector');
    expect(save).not.toHaveBeenCalled();
  });
  it('browses weights and prevents invalid numeric settings', async () => {
    mock.pick.mockResolvedValue('C:/models/a b.gguf');
    const save = vi.fn();
    render(<ModelEditor initial={MODEL_REGISTRY[0]} onAdd={save} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse weights' }));
    await waitFor(() => expect((screen.getByLabelText('Weights path') as HTMLInputElement).value).toBe('C:/models/a b.gguf'));
    fireEvent.change(screen.getByLabelText('Fallback context'), { target: { value: '1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    expect((await screen.findByRole('alert')).textContent).toContain('whole numbers');
    expect(save).not.toHaveBeenCalled();
  });
});

describe('MCP settings', () => {
  it('preserves exact argument boundaries, working directory and environment on import', () => {
    const [server] = importMcpConfig(JSON.stringify({ mcpServers: { local: { command: 'node', args: ['C:\\tools\\server.js', 'C:\\Project files', ''], env: { TOKEN: '${LOCAL_TOKEN}' }, cwd: 'C:\\tools' } } }));
    expect(server.args).toEqual(['C:\\tools\\server.js', 'C:\\Project files', '']);
    expect(server.env).toEqual({ TOKEN: '${LOCAL_TOKEN}' });
    expect(server.cwd).toBe('C:\\tools');
    expect(parseArguments('one\n  keep spaces  ')).toEqual(['one', '  keep spaces  ']);
    expect(() => parseArguments('[1]')).toThrow();
    expect(() => parseEnvironment('{"TOKEN": 5}')).toThrow();
    expect(() => importMcpConfig('{"url":"https://example.com/mcp"}')).toThrow('local stdio');
  });
  it('turns a standard npx import into explicit installation, without running it', async () => {
    render(<McpSettings />);
    fireEvent.change(screen.getByLabelText('MCP JSON configuration'), { target: { value: JSON.stringify({ mcpServers: { Files: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:/Project files'] } } }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Import configuration' }));
    await screen.findByText('Imported npm setup. Review the package and arguments, then install and add it.');
    expect((screen.getByLabelText('npm package (optional @version)') as HTMLInputElement).value).toBe('@modelcontextprotocol/server-filesystem');
    expect(mock.install).not.toHaveBeenCalled(); expect(mock.save).not.toHaveBeenCalled();
    const [server] = importMcpConfig('{"command":"C:/node/npx.cmd","args":["--yes","server@1.2.3","arg"]}');
    expect(npmImport(server)).toEqual({ packageSpec: 'server@1.2.3', args: ['arg'] });
  });
  it('keeps the draft when persistence fails and retries without discarding arguments', async () => {
    mock.save.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<McpSettings />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Local docs' } });
    fireEvent.change(screen.getByLabelText('Executable or command'), { target: { value: 'node' } });
    fireEvent.change(screen.getByLabelText('Arguments (one per line or JSON array)'), { target: { value: '["C:/my tools/server.js", ""]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not saved');
    expect((screen.getByLabelText('Display name') as HTMLInputElement).value).toBe('Local docs');
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    await screen.findByText('Saved. Use Check tools to start the server and verify its connection.');
    expect(mock.save.mock.calls[1][0].mcpServers[0].args).toEqual(['C:/my tools/server.js', '']);
  });
  it('respects public egress and does not reinstall after a successful install but failed save', async () => {
    mock.state.settings.blockPublicInternet = true;
    const view = render(<McpSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Install npm package' }));
    expect((screen.getByRole('button', { name: 'Install and add MCP server' }) as HTMLButtonElement).disabled).toBe(true);
    mock.state.settings = { ...mock.state.settings, blockPublicInternet: false };
    view.rerender(<McpSettings />);
    mock.install.mockResolvedValue({ id: 'installed', command: 'C:/node/node.exe', args: ['C:/mcp/server/index.js'], cwd: 'C:/mcp/server', enabled: true });
    mock.save.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Installed tool' } });
    fireEvent.change(screen.getByLabelText('npm package (optional @version)'), { target: { value: 'server@1.0.0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Install and add MCP server' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not saved');
    fireEvent.click(screen.getByRole('button', { name: 'Save MCP server' }));
    await screen.findByText('Saved. Use Check tools to start the server and verify its connection.');
    expect(mock.install).toHaveBeenCalledTimes(1);
    expect(mock.save.mock.calls[1][0].mcpServers[0].command).toBe('C:/node/node.exe');
  });
});
