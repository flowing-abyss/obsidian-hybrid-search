import assert from 'node:assert/strict';
import { it } from 'vitest';
import { extractMarkdownNote } from '../src/content/note-extractor.js';

it('preserves raw and typed frontmatter when the same source is prepared again', () => {
  const source = '---\nvalue: .inf\ndate: 2024-01-02\n---\nBody with [[Link]].';
  const first = extractMarkdownNote(source, 'Fallback');
  const second = extractMarkdownNote(source, 'Fallback');
  assert.equal(second.frontmatterRaw, '\nvalue: .inf\ndate: 2024-01-02');
  assert.deepEqual(second, first);
  assert.equal(second.frontmatter.value, Infinity);
  assert.ok(second.frontmatter.date instanceof Date);
});

it('returns empty raw frontmatter for empty and unannotated sources on every preparation', () => {
  for (const source of ['', 'Body without frontmatter.']) {
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal(extractMarkdownNote(source, 'Fallback').frontmatterRaw, '');
    }
  }
});
