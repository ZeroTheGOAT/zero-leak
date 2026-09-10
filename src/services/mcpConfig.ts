import type { McpServerConfig } from '../types';

export function parseArguments(raw: string): string[] {
  if (!raw.trim()) return [];
  if (raw.trimStart().startsWith('[')) {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error('Arguments must be a JSON array of strings.');
    return value;
  }
  return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

export function parseEnvironment(raw: string): Record<string, string> {
  const value: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([key, val]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== 'string')) {
    throw new Error('Environment must be a JSON object with variable names and string values.');
  }
  return value as Record<string, string>;
}

/** Standard desktop MCP configs and individual local server definitions. */
export function importMcpConfig(raw: string): McpServerConfig[] {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Paste an MCP configuration object.');
  if (value.mcpServers !== undefined && (!value.mcpServers || typeof value.mcpServers !== 'object' || Array.isArray(value.mcpServers))) throw new Error('mcpServers must be an object keyed by server name.');
  const entries = value.mcpServers ? Object.entries(value.mcpServers) : [[value.name || 'Local server', value]];
  if (!entries.length) throw new Error('The configuration contains no servers.');
  return entries.map(([name, item]) => {
    const config = item as Record<string, unknown>;
    if (!config || typeof config !== 'object' || config.url || (config.type && config.type !== 'stdio')) {
      throw new Error(`${name}: only local stdio servers are supported.`);
    }
    if (typeof config.command !== 'string' || !config.command.trim()) throw new Error(`${name}: a command is required.`);
    if (config.cwd !== undefined && typeof config.cwd !== 'string') throw new Error(`${name}: cwd must be a folder path.`);
    if (config.enabled !== undefined && typeof config.enabled !== 'boolean') throw new Error(`${name}: enabled must be true or false.`);
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== 'string'))) throw new Error(`${name}: args must be an array of strings.`);
    const args = (config.args ?? []) as string[];
    return { id: `mcp-${crypto.randomUUID()}`, name: String(name), command: config.command.trim(), args,
      cwd: config.cwd as string | undefined, env: parseEnvironment(JSON.stringify(config.env ?? {})), enabled: config.enabled !== false };
  });
}

export function npmImport(server: McpServerConfig): { packageSpec: string; args: string[] } | null {
  if (!/(^|[\\/])npx(?:\.cmd|\.exe)?$/i.test(server.command)) return null;
  const args = [...server.args];
  if (args[0] === '-y' || args[0] === '--yes') args.shift();
  const packageSpec = args.shift();
  if (!packageSpec || packageSpec.startsWith('-')) throw new Error('For npx, use [-y, package-name, ...server arguments].');
  return { packageSpec, args };
}
