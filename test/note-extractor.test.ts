import assert from 'node:assert/strict';
import { it } from 'vitest';
import { extractMarkdownNote, parseInlineTags } from '../src/content/note-extractor.js';

it('extracts Cyrillic, mixed-script and nested inline tags alongside Latin tags', () => {
  assert.deepEqual(
    parseInlineTags('#note #заметка, #проект/йога; (#note/русский) #русский-test #中文 #日本語'),
    ['note', 'заметка', 'проект/йога', 'note/русский', 'русский-test', '中文', '日本語'],
  );
});

it('preserves combining marks and source spelling in decomposed inline tags', () => {
  const tags = ['йога/ещё', 'café', 'заметка_2'];
  for (const form of ['NFC', 'NFD'] as const) {
    const normalized = tags.map((tag) => tag.normalize(form));
    assert.deepEqual(parseInlineTags(normalized.map((tag) => `#${tag}`).join(' ')), normalized);
  }
});

it('retains tag boundaries and code exclusions for Unicode tags', () => {
  assert.deepEqual(
    parseInlineTags(
      '#заметка #заметка `#код`\n```md\n#блок\n```\nword#суффикс #123 #42тег #_личное',
    ),
    ['заметка', '_личное'],
  );
});

it('combines Russian frontmatter and inline tags without duplicating the same spelling', () => {
  const note = extractMarkdownNote(
    '---\ntags: [свойство, заметка]\n---\n#заметка #проект/задача',
    'Fallback',
  );
  assert.deepEqual(note.tags, ['свойство', 'заметка', 'проект/задача']);
});

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
