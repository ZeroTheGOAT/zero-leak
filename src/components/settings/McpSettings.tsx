import React, { useRef, useState } from 'react';
import { useApp } from '../../context/AppContext';
import * as core from '../../services/core';
import { importMcpConfig, npmImport, parseArguments, parseEnvironment } from '../../services/mcpConfig';
import type { McpServerConfig, McpToolSummary } from '../../types';

const field = 'w-full rounded-md border border-[var(--input)] bg-[var(--background)] p-2 text-xs';
const button = 'rounded-md border nerve-border px-3 py-1.5 text-xs disabled:opacity-40';
const empty = { id: '', name: '', command: '', args: '', env: '', cwd: '', enabled: true };

export const McpSettings: React.FC = () => {
  const { settings, updateSettings, coreStatus } = useApp();
  const [draft, setDraft] = useState(empty);
  const [mode, setMode] = useState<'local' | 'npm'>('local');
  const [packageSpec, setPackageSpec] = useState('');
  const [nodePath, setNodePath] = useState('');
  const [importText, setImportText] = useState('');
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [checks, setChecks] = useState<Record<string, { loading?: boolean; tools?: McpToolSummary[]; error?: string }>>({});
  const offline = coreStatus.state === 'unavailable' || coreStatus.state === 'checking';
  const clearChecks = () => setChecks({});
  const set = (key: keyof typeof empty, value: string) => setDraft((prev) => ({ ...prev, [key]: value }));
  const edit = (server: McpServerConfig) => {
    setMode('local'); setError(''); setNotice('');
    setDraft({ ...server, args: JSON.stringify(server.args, null, 2), env: JSON.stringify(server.env ?? {}, null, 2), cwd: server.cwd ?? '' });
  };
  const perform = async (action: () => Promise<void>) => {
    if (working.current) return;
    working.current = true; setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { working.current = false; setBusy(false); }
  };
  const persist = async (servers: McpServerConfig[]) => {
    if (!await updateSettings({ mcpServers: servers })) throw new Error('MCP configuration was not saved. Check the connection and the app error details, then retry.');
    clearChecks();
  };
  const save = () => perform(async () => {
    if (!draft.name.trim()) throw new Error('Enter a display name.');
    const args = parseArguments(draft.args);
    const env = parseEnvironment(draft.env);
    let server: McpServerConfig = { ...draft, id: draft.id || `mcp-${crypto.randomUUID()}`, name: draft.name.trim(),
      command: draft.command.trim().replace(/^"(.*)"$/, '$1'), args, env, cwd: draft.cwd.trim() || undefined };
    if (mode === 'npm') {
      if (settings.blockPublicInternet) throw new Error('Package downloads require public egress. Enable it in System for installation, or connect an existing local executable.');
      const installed = await core.integrations.installMcp(packageSpec.trim(), nodePath.trim() || undefined);
      server = { ...server, id: installed.id, command: installed.command, args: [...installed.args, ...args], cwd: server.cwd || installed.cwd };
      // Keep the installed paths if saving fails; retry never downloads again.
      edit(server);
    }
    if (!server.command) throw new Error('Choose an executable or enter a command such as node or python.');
    const exists = settings.mcpServers.some((item) => item.id === server.id);
    await persist(exists ? settings.mcpServers.map((item) => item.id === server.id ? server : item) : [...settings.mcpServers, server]);
    setDraft(empty); setMode('local'); setPackageSpec('');
    setNotice('Saved. Use Check tools to start the server and verify its connection.');
  });
  const importConfig = () => perform(async () => {
    const servers = importMcpConfig(importText);
    if (servers.length === 1) {
      const npm = npmImport(servers[0]);
      if (npm) {
        edit({ ...servers[0], id: '', command: '', args: npm.args });
        setMode('npm'); setPackageSpec(npm.packageSpec);
        setNotice('Imported npm setup. Review the package and arguments, then install and add it.'); return;
      }
    }
    if (servers.some((server) => npmImport(server))) throw new Error('Import npm servers one at a time so each installation can be reviewed.');
    await persist([...settings.mcpServers, ...servers]);
    setImportText(''); setNotice(`Imported ${servers.length} server configuration(s). Use Check tools to verify them.`);
  });
  const probe = async (server: McpServerConfig) => {
    setChecks((prev) => ({ ...prev, [server.id]: { loading: true } }));
    try {
      const tools = await core.integrations.probeMcp(server.id);
      setChecks((prev) => ({ ...prev, [server.id]: { tools } }));
    } catch (reason) { setChecks((prev) => ({ ...prev, [server.id]: { error: reason instanceof Error ? reason.message : String(reason) } })); }
  };
  const browse = async (key: 'command' | 'cwd') => {
    try { const value = await core.pickSettingsPath(key === 'cwd' ? 'directory' : 'executable'); if (value) set(key, value); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <div className="grid gap-4 p-3.5">
    {settings.mcpServers.length === 0 && <p className="text-xs text-[var(--muted-foreground)]">No MCP servers configured yet.</p>}
    {settings.mcpServers.map((server) => <div key={server.id} className="grid gap-2 border-b nerve-border pb-3">
      <p className="text-sm font-medium">{server.name}</p><p className="break-all font-mono text-xs text-[var(--muted-foreground)]">{server.command} {server.args.join(' ')}</p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1 text-xs"><input type="checkbox" aria-label={`Enable ${server.name}`} checked={server.enabled} disabled={busy || offline || checks[server.id]?.loading} onChange={(e) => { const enabled = e.target.checked; void perform(() => persist(settings.mcpServers.map((item) => item.id === server.id ? { ...item, enabled } : item))); }} />Enabled</label>
        <button className={button} disabled={busy || offline || !server.enabled || checks[server.id]?.loading} onClick={() => void probe(server)}>{checks[server.id]?.loading ? 'Checking…' : 'Check tools'}</button>
        <button className={button} disabled={busy || checks[server.id]?.loading} onClick={() => edit(server)}>Edit</button>
        <button className={button} disabled={busy || offline || checks[server.id]?.loading} onClick={() => void perform(async () => { await persist(settings.mcpServers.filter((item) => item.id !== server.id)); if (draft.id === server.id) setDraft(empty); })}>Remove</button>
      </div>
      {checks[server.id]?.error && <p role="alert" className="break-words text-xs text-[var(--destructive)]">{checks[server.id].error}</p>}
      {checks[server.id]?.tools && <details className="text-xs"><summary>{checks[server.id].tools!.length} tools available</summary>{checks[server.id].tools!.map((tool) => <p key={tool.name} className="mt-1 break-words"><strong>{tool.name}</strong> — {tool.description}</p>)}</details>}
    </div>)}
    <fieldset disabled={busy || offline} className="grid gap-3">
      <legend className="mb-2 text-sm font-medium">{draft.id ? 'Edit MCP server' : 'Add MCP server'}</legend>
      {!draft.id && <div className="flex gap-2"><button type="button" className={button} aria-pressed={mode === 'local'} onClick={() => setMode('local')}>Existing local server</button><button type="button" className={button} aria-pressed={mode === 'npm'} onClick={() => setMode('npm')}>Install npm package</button></div>}
      <label className="text-xs">Display name<input className={field} value={draft.name} onChange={(e) => set('name', e.target.value)} /></label>
      {mode === 'npm' ? <>
        <label className="text-xs">npm package (optional @version)<input className={field} value={packageSpec} onChange={(e) => setPackageSpec(e.target.value)} placeholder="@modelcontextprotocol/server-filesystem" /></label>
        <label className="text-xs">Node executable (optional)<input className={field} value={nodePath} onChange={(e) => setNodePath(e.target.value)} placeholder="Auto-detect node.exe from PATH" /></label>
        <p className="text-xs text-[var(--muted-foreground)]">Downloads the package and dependencies into a separate local folder. Install scripts are disabled. Future launches use the installed files.</p>
        {settings.blockPublicInternet && <p className="text-xs text-[var(--warning)]">Downloads are blocked. Enable public egress in System for installation, or use an existing local server.</p>}
      </> : <div className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs">Executable or command<input className={field} value={draft.command} onChange={(e) => set('command', e.target.value)} placeholder="node, python, or C:/tools/server.exe" /></label><button className={button} onClick={() => void browse('command')}>Browse executable</button></div>}
      <label className="text-xs">Arguments (one per line or JSON array)<textarea rows={3} className={`${field} font-mono`} value={draft.args} onChange={(e) => set('args', e.target.value)} placeholder={'["C:/tools/server.js", "C:/approved-folder"]'} /></label>
      <div className="flex items-end gap-2"><label className="min-w-0 flex-1 text-xs">Working directory (optional)<input className={field} value={draft.cwd} onChange={(e) => set('cwd', e.target.value)} /></label><button className={button} onClick={() => void browse('cwd')}>Browse folder</button></div>
      <label className="text-xs">Environment (JSON object)<textarea rows={2} className={`${field} font-mono`} value={draft.env} onChange={(e) => set('env', e.target.value)} placeholder={'{"TOKEN": "${MY_MCP_TOKEN}"}'} /></label>
      <p className="text-xs text-[var(--muted-foreground)]">Use {'${NAME}'} to read a secret from the app’s launch environment.</p>
      <div className="flex gap-2"><button className={`zeroleak-primary ${button}`} disabled={busy || (mode === 'npm' && settings.blockPublicInternet)} onClick={() => void save()}>{busy ? 'Working…' : mode === 'npm' ? 'Install and add MCP server' : draft.id ? 'Save MCP server' : 'Add MCP server'}</button>{draft.id && <button className={button} onClick={() => { setDraft(empty); setMode('local'); }}>Cancel edit</button>}</div>
    </fieldset>
    <details><summary className="text-xs">Import MCP JSON configuration</summary><textarea aria-label="MCP JSON configuration" rows={5} className={`${field} mt-2 font-mono`} value={importText} onChange={(e) => setImportText(e.target.value)} /><button disabled={busy || offline || !importText.trim()} className={`${button} mt-2`} onClick={() => void importConfig()}>Import configuration</button></details>
    {error && <p role="alert" className="break-words text-xs text-[var(--destructive)]">{error}</p>}
    {notice && <p role="status" className="break-words text-xs text-[var(--muted-foreground)]">{notice}</p>}
  </div>;
};
