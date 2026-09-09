import { expect, it } from 'vitest';
import { appendSourcePaths, moveSource, workflowPrompt } from '../src/services/workflows';

it('deduplicates Windows attachments without changing the source order or original path', () => {
  expect(appendSourcePaths(['C:/Reports/old.pdf'], ['c:\\reports\\OLD.PDF', 'C:/new.pdf', 'C:/new.pdf', '']))
    .toEqual(['C:/Reports/old.pdf', 'C:/new.pdf']);
});
it('preserves case-sensitive POSIX files and deduplicates UNC paths', () => {
  expect(appendSourcePaths(['/data/A.pdf'], ['/data/a.pdf'])).toHaveLength(2);
  expect(appendSourcePaths(['\\\\server\\reports\\A.pdf'], ['\\\\SERVER\\REPORTS\\a.pdf'])).toHaveLength(1);
});
it('swaps revisions without mutating the draft and ignores invalid moves', () => {
  const files = ['new.pdf', 'old.pdf', 'context.pdf'];
  expect(moveSource(files, 1, -1)).toEqual(['old.pdf', 'new.pdf', 'context.pdf']);
  expect(files[0]).toBe('new.pdf');
  expect(moveSource(files, 0, -1)).toBe(files);
  expect(moveSource(files, 2, 1)).toBe(files);
});
it('carries ordered revision semantics and operator context into the prompt', () => {
  const prompt = workflowPrompt('revision', '  Review CDU4  ');
  expect(prompt).toContain('FIRST attached document (earlier revision)');
  expect(prompt).toContain('SECOND (new revision)');
  expect(prompt).toContain('Operator context:\nReview CDU4');
});
