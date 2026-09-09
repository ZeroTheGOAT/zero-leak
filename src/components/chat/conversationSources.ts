import type { Attachment, ChatMessage, Citation } from '../../types';

export interface ConversationSource {
  key: string;
  path: string;
  fileName: string;
  citation?: Citation;
  attachmentKind?: Attachment['kind'];
  references: number;
  pages: number[];
}

/** Collect every sent attachment and cited document in the active chat. */
export const collectConversationSources = (messages: ChatMessage[]): ConversationSource[] => {
  const grouped = new Map<string, ConversationSource>();
  const sourceKey = (path: string) => path.replace(/\\/g, '/').toLocaleLowerCase();

  for (const message of messages) {
    if (message.sender === 'user') {
      for (const attachment of message.attachments ?? []) {
        const key = sourceKey(attachment.path);
        const existing = grouped.get(key);
        if (existing) {
          existing.attachmentKind = attachment.kind;
        } else {
          grouped.set(key, {
            key,
            path: attachment.path,
            fileName: attachment.fileName,
            attachmentKind: attachment.kind,
            references: 0,
            pages: [],
          });
        }
      }
      continue;
    }

    if (message.sender !== 'agent') continue;
    for (const citation of message.citations ?? []) {
      const key = sourceKey(citation.path) || citation.docId;
      const existing = grouped.get(key);
      if (existing) {
        existing.references += 1;
        existing.citation = citation;
        if (citation.page !== undefined && !existing.pages.includes(citation.page)) {
          existing.pages.push(citation.page);
        }
        continue;
      }
      grouped.set(key, {
        key,
        path: citation.path,
        fileName: citation.fileName,
        citation,
        references: 1,
        pages: citation.page === undefined ? [] : [citation.page],
      });
    }
  }

  return [...grouped.values()].map((source) => ({
    ...source,
    pages: source.pages.sort((left, right) => left - right),
  }));
};
