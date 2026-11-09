import assert from 'node:assert/strict';
import { inspect } from 'node:util';
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

it('preserves comma-separated frontmatter tags and merges inline tags after trimming', () => {
  const note = extractMarkdownNote(
    '---\ntags: " project/task , заметка, project/task "\n---\n#заметка #new-tag',
    'Fallback',
  );
  assert.deepEqual(note.tags, ['project/task', 'заметка', 'new-tag']);
  assert.equal(note.frontmatter.tags, ' project/task , заметка, project/task ');
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

it('rejects executable frontmatter before evaluating any engine or alias', () => {
  const marker = '__ohs_frontmatter_execution_test__';
  const globals = globalThis as unknown as Record<string, unknown>;
  try {
    for (const language of ['js', 'javascript', 'JavaScript', ' JS ', 'constructor']) {
      for (const bom of ['', '\ufeff']) {
        const raw = `${bom}---${language}\n({ title: (globalThis.${marker} = true, 'Title') })\n---\nBody`;
        assert.throws(() => extractMarkdownNote(raw, 'Fallback'), /frontmatter language/i);
        assert.equal(globals[marker], undefined);
      }
    }
  } finally {
    delete globals[marker];
  }
});

it('preserves inert YAML and JSON language labels, aliases, dates and body offsets', () => {
  for (const language of ['', 'yaml', 'yml']) {
    const raw = `---${language}\ntitle: Example\ncommon: &common [a, b]\naliases: *common\ndate: 2024-01-02\n---\nBody`;
    const note = extractMarkdownNote(raw, 'Fallback');
    assert.equal(note.title, 'Example');
    assert.deepEqual(note.aliases, ['a', 'b']);
    assert.ok(note.frontmatter.date instanceof Date);
    assert.equal(note.content, 'Body');
    assert.equal(note.frontmatterRaw, raw.slice(3 + language.length, raw.indexOf('\n---', 3)));
  }
  const json = extractMarkdownNote(
    '---json\n{"title":"JSON","aliases":["J"]}\n---\nBody',
    'Fallback',
  );
  assert.equal(json.title, 'JSON');
  assert.deepEqual(json.aliases, ['J']);
  assert.equal(json.content, 'Body');
});

it('rejects cyclic aliases and bounded alias amplification without expanding the graph', () => {
  assert.throws(
    () => extractMarkdownNote('---\ncycle: &cycle [*cycle]\n---\nBody', 'Fallback'),
    /cyclic frontmatter/i,
  );
  const aliases = [`a: &a ${'literal '.repeat(30)}`];
  for (const [name, previous] of [
    ['b', 'a'],
    ['c', 'b'],
    ['d', 'c'],
    ['e', 'd'],
    ['f', 'e'],
  ]) {
    const references = Array.from({ length: 10 }, () => '*' + previous).join(', ');
    aliases.push(`${name}: &${name} [${references}]`);
  }
  assert.throws(
    () => extractMarkdownNote(`---\n${aliases.join('\n')}\n---\nBody`, 'Fallback'),
    /frontmatter alias expansion/i,
  );
});

it('counts cached alias subtree height when enforcing the nesting limit', () => {
  const nest = (value: string, depth: number) => '['.repeat(depth) + value + ']'.repeat(depth);
  const source = (depth: number) =>
    `---\nbase: &base ${nest('leaf', depth)}\nwrapped: ${nest('*base', depth)}\n---\nBody`;
  assert.doesNotThrow(() => extractMarkdownNote(source(64), 'Fallback'));
  // Each source branch is only 100 levels deep; the reused anchor expands to 200.
  assert.throws(() => extractMarkdownNote(source(100), 'Fallback'), /nesting exceeds 128 levels/);
});

it('does not expose note text in malformed YAML diagnostics', () => {
  assert.throws(
    () => extractMarkdownNote('---\nkey: [PRIVATE_FRONTMATTER_SENTINEL\n---\nBody', 'Fallback'),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invalid Markdown frontmatter/i);
      assert.ok(!inspect(error).includes('PRIVATE_FRONTMATTER_SENTINEL'));
      return true;
    },
  );
});
