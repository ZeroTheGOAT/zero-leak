import type { ChatMessage, SubagentInfo } from '../types';

export const isSubagentActive = (agent: SubagentInfo) =>
  agent.status === 'pending' || agent.status === 'running' || agent.status === 'waiting' || agent.status === 'stopping';

/** A list response may arrive after a newer lifecycle event. */
export function mergeSubagents(current: SubagentInfo[], incoming: SubagentInfo[], root: string): SubagentInfo[] {
  const rows = new Map(current.filter((agent) => agent.rootSessionId === root).map((agent) => [agent.id, agent]));
  for (const agent of incoming) {
    if (agent.rootSessionId !== root) continue;
    const previous = rows.get(agent.id);
    if (!previous || agent.updatedAt > previous.updatedAt
      || (agent.updatedAt === previous.updatedAt && (!isSubagentActive(agent) || isSubagentActive(previous)))) {
      rows.set(agent.id, agent);
    }
  }
  return [...rows.values()].sort((a, b) => Number(isSubagentActive(b)) - Number(isSubagentActive(a))
    || a.path.localeCompare(b.path));
}

/** Stored rows supply prompts; live completions supply the just-finished activity. */
export function mergeSubagentMessages(stored: ChatMessage[], completed: ChatMessage[]): ChatMessage[] {
  const rows = new Map<string, ChatMessage>();
  for (const message of [...stored, ...completed]) {
    const key = message.sender === 'agent' && message.runId ? `run:${message.runId}` : message.id;
    const previous = rows.get(key);
    rows.set(key, previous ? { ...previous, ...message, createdAt: previous.createdAt,
      activity: message.activity?.length ? message.activity : previous.activity } : message);
  }
  return [...rows.values()].sort((a, b) => a.createdAt - b.createdAt);
}
