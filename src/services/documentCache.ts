import type { IngestedDocument } from '../types';

/** List responses omit blocks/tables. Keep a hydrated extraction only while
 * both the source hash and extraction timestamp still describe that version. */
export function mergeDocumentSummaries(
  current: IngestedDocument[],
  summaries: IngestedDocument[],
): IngestedDocument[] {
  const previous = new Map(current.map((document) => [document.id, document]));
  return summaries.map((summary) => {
    const loaded = previous.get(summary.id);
    return loaded && loaded.sha256 === summary.sha256 && loaded.ingestedAt === summary.ingestedAt
      ? loaded
      : summary;
  });
}

export const documentVersion = (document: IngestedDocument): string =>
  `${document.sha256}:${document.ingestedAt}`;
