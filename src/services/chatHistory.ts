import type { ChatMessage, StoredMessage } from '../types';
import { localTurnInput } from './core';

/** Reuse authoritative row/run identities and saved activity in both chat views. */
export const rehydrate = (message: StoredMessage): ChatMessage => ({
  id: message.id,
  runId: message.runId,
  rowId: message.id,
  sender: message.sender,
  content: message.content,
  createdAt: message.createdAt,
  activity: message.sender === 'agent' && message.activity?.length ? message.activity : undefined,
  citations: message.citations,
  modelId: message.modelId,
  mode: message.mode,
  elapsedMs: message.elapsedMs,
  tokensPerSec: message.tokensPerSec,
  failure: message.failure,
  plan: message.plan?.length ? message.plan : undefined,
  // History stores paths, not sizes. Classify without opening source files.
  attachments: message.attachments?.map((path, index) => ({
    id: `${message.id}-att-${index}`,
    path,
    fileName: path.split(/[\\/]/).pop() ?? path,
    kind: localTurnInput(path).type === 'localImage' ? 'image' : 'text',
    sizeBytes: 0,
  })),
});
