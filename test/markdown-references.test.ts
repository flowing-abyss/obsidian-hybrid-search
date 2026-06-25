import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { extractMarkdownReferences, resolveMarkdownNoteLinks } from '../src/markdown-references.js';

describe('extractMarkdownReferences', () => {
  it('extracts Markdown link destinations and HTTP URLs while ignoring images and code', () => {
    const refs = extractMarkdownReferences(`
[Local](../notes/Target%20Note.md#section)
[Site](https://example.com/path?q=1)
<https://example.org/autolink>
Bare https://example.net/path.
Quoted "https://example.com/quoted".
Paren https://example.com/path).
![Image](https://example.com/image.png)
\`[Code](ignored.md) https://ignored.example\`

\`\`\`md
[Code block](ignored.md)
https://ignored.example/block
\`\`\`
`);

    assert.deepEqual(
      refs.localDestinations.map((link) => link.destination),
      ['../notes/Target%20Note.md#section'],
    );
    assert.deepEqual(refs.urls, [
      'https://example.com/path?q=1',
      'https://example.org/autolink',
      'https://example.net/path',
      'https://example.com/quoted',
      'https://example.com/path',
    ]);
  });

  it('supports reference-style Markdown links without emitting unused definitions', () => {
    const refs = extractMarkdownReferences(`
[Target][target-ref]
[Collapsed][]
[Shortcut]

[target-ref]: ./target.md
[Collapsed]: ./collapsed.md
[Shortcut]: https://example.com/reference
[Unused]: ./unused.md
`);

    assert.deepEqual(
      refs.localDestinations.map((link) => link.destination),
      ['./target.md', './collapsed.md'],
    );
    assert.ok(refs.urls.includes('https://example.com/reference'));
    assert.ok(!refs.localDestinations.some((link) => link.destination === './unused.md'));
  });

  it('preserves first-seen URL order across bare, inline, and reference links', () => {
    const refs = extractMarkdownReferences(`
Quoted "https://first.example/path".
[Second](https://second.example/path)
[Third][third]

[third]: https://third.example/path
`);

    assert.deepEqual(refs.urls, [
      'https://first.example/path',
      'https://second.example/path',
      'https://third.example/path',
    ]);
  });
});

describe('resolveMarkdownNoteLinks', () => {
  const existing = new Set([
    'notes/Target Note.md'.normalize('NFD'),
    'root.md',
    'folder/child.md',
    'folder/file.md',
    'folder/file.txt',
  ]);

  it('resolves relative and percent-encoded local note paths', () => {
    const resolved = resolveMarkdownNoteLinks(
      'folder/source.md',
      ['../notes/Target%20Note.md#section'],
      existing,
    );

    assert.deepEqual(resolved, ['notes/Target Note.md'.normalize('NFD')]);
  });

  it('treats leading slash as vault-root-relative and rejects escaped vault paths', () => {
    assert.deepEqual(resolveMarkdownNoteLinks('folder/source.md', ['/root.md'], existing), [
      'root.md',
    ]);
    assert.deepEqual(
      resolveMarkdownNoteLinks('folder/source.md', ['../../outside.md'], existing),
      [],
    );
  });

  it('tries extensionless targets with .md but does not use basename title or alias fallback', () => {
    assert.deepEqual(resolveMarkdownNoteLinks('folder/source.md', ['./child'], existing), [
      'folder/child.md',
    ]);
    assert.deepEqual(resolveMarkdownNoteLinks('folder/source.md', ['Target Note'], existing), []);
  });

  it('strips query strings, handles malformed percent escapes, and only resolves markdown files', () => {
    assert.deepEqual(
      resolveMarkdownNoteLinks('folder/source.md', ['./child.md?x=1#section'], existing),
      ['folder/child.md'],
    );
    assert.deepEqual(resolveMarkdownNoteLinks('folder/source.md', ['./bad%zz.md'], existing), []);
    assert.deepEqual(resolveMarkdownNoteLinks('folder/source.md', ['./file.txt'], existing), []);
    assert.deepEqual(resolveMarkdownNoteLinks('folder/source.md', ['./file'], existing), [
      'folder/file.md',
    ]);
  });
});
