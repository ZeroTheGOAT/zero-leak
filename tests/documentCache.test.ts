import { describe, expect, it } from 'vitest';
import { documentVersion, mergeDocumentSummaries } from '../src/services/documentCache';
import type { IngestedDocument } from '../src/types';

const document: IngestedDocument = {
  id: 'report', path: 'C:/reports/report.pdf', fileName: 'report.pdf', kind: 'pdf',
  pageCount: 2, extraction: 'native', sha256: 'abc', ingestedAt: 100, sizeBytes: 500,
  blocks: [{ id: 'block', kind: 'text', text: 'Measured 4.2 mm', bbox: { page: 2, x: 0, y: 0, w: 1, h: 1 } }],
  tables: [{ id: 'table', page: 2, bbox: { page: 2, x: 0, y: 0, w: 1, h: 1 }, header: ['Tag'], rows: [['V-01']] }], entities: ['V-01'],
};
const summary = { ...document, blocks: [], tables: [] };

describe('document refresh', () => {
  it('preserves loaded text, tables, and object identity after a background refresh', () => {
    expect(mergeDocumentSummaries([document], [summary])[0]).toBe(document);
  });
  it('invalidates cached text when the file hash changes', () => {
    const changed = { ...summary, sha256: 'different' };
    expect(mergeDocumentSummaries([document], [changed])[0]).toBe(changed);
    expect(documentVersion(changed)).not.toBe(documentVersion(document));
  });
  it('invalidates a new extraction of the same source', () => {
    const reingested = { ...summary, ingestedAt: 200 };
    expect(mergeDocumentSummaries([document], [reingested])[0]).toBe(reingested);
  });
  it('reflects removals and additions in the authoritative list', () => {
    const added = { ...summary, id: 'new' };
    expect(mergeDocumentSummaries([document], [added])).toEqual([added]);
    expect(mergeDocumentSummaries([document], [])).toEqual([]);
  });
});
