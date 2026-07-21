import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  extractMarkdownReferenceOccurrences,
  resolveMarkdownNoteLinks,
} from '../src/markdown-references.js';

describe('extractMarkdownReferenceOccurrences — edge cases', () => {
  it('returns empty results for empty content', () => {
    const refs = extractMarkdownReferenceOccurrences('');
    assert.deepEqual(refs.localDestinations, []);
    assert.deepEqual(refs.urls, []);
  });

  it('extracts standard inline link with correct offsets', () => {
    const refs = extractMarkdownReferenceOccurrences('See [note](folder/note.md) here.');
    assert.equal(refs.localDestinations.length, 1);
    assert.equal(refs.localDestinations[0]!.destination, 'folder/note.md');
    assert.ok(refs.localDestinations[0]!.startOffset >= 0);
    assert.ok(refs.localDestinations[0]!.endOffset > refs.localDestinations[0]!.startOffset);
  });

  it('classifies http URLs as urls not localDestinations', () => {
    const refs = extractMarkdownReferenceOccurrences('[site](https://example.com)');
    assert.equal(refs.localDestinations.length, 0);
    assert.deepEqual(refs.urls, ['https://example.com']);
  });

  it('resolves reference-style link to local destination', () => {
    const refs = extractMarkdownReferenceOccurrences('[text][ref]\n\n[ref]: note.md');
    assert.equal(refs.localDestinations.length, 1);
    assert.equal(refs.localDestinations[0]!.destination, 'note.md');
  });

  it('resolves reference-style link to URL when definition is a URL', () => {
    const refs = extractMarkdownReferenceOccurrences('[text][ref]\n\n[ref]: https://example.com');
    assert.equal(refs.localDestinations.length, 0);
    assert.ok(refs.urls.includes('https://example.com'));
  });

  it('strips trailing period from bare URL', () => {
    const refs = extractMarkdownReferenceOccurrences('see https://example.com/path.');
    assert.ok(refs.urls.includes('https://example.com/path'));
  });

  it('handles bare URL with trailing closing paren and balanced inner parens', () => {
    const refs = extractMarkdownReferenceOccurrences('see (https://example.com/path(x))');
    // The URL should include path(x) but not the outer paren
    assert.ok(refs.urls.some((u) => u.includes('path(x)')));
  });

  it('strips trailing quotes from bare URL', () => {
    const refs = extractMarkdownReferenceOccurrences('see "https://example.com"');
    assert.ok(refs.urls.includes('https://example.com'));
  });

  it('deduplicates identical local destinations', () => {
    const refs = extractMarkdownReferenceOccurrences('[a](note.md) [b](note.md)');
    assert.equal(refs.localDestinations.length, 1);
  });

  it('deduplicates identical URLs', () => {
    const refs = extractMarkdownReferenceOccurrences(
      '[a](https://example.com) [b](https://example.com)',
    );
    assert.equal(refs.urls.filter((u) => u === 'https://example.com').length, 1);
  });

  // NOTE: extractMarkdownReferenceOccurrences records anchor-only and query-only
  // destinations as local links (they are neither http URLs nor scheme-bearing).
  // Filtering happens later in resolveCandidate via splitLocalDestination,
  // which strips the fragment/query to an empty path and rejects it. The brief
  // asserted the extraction layer skipped them, but the actual behavior records
  // them and defers rejection to resolution — verified against the source.
  it('records anchor-only links as local destinations (rejected later at resolution)', () => {
    const refs = extractMarkdownReferenceOccurrences('[section](#heading)');
    assert.equal(refs.localDestinations.length, 1);
    assert.equal(refs.localDestinations[0]!.destination, '#heading');
    // Resolution strips it to empty and rejects.
    assert.deepEqual(
      resolveMarkdownNoteLinks('folder/source.md', ['#heading'], new Set(['folder/source.md'])),
      [],
    );
  });

  it('records query-only links as local destinations (rejected later at resolution)', () => {
    const refs = extractMarkdownReferenceOccurrences('[q](?param=1)');
    assert.equal(refs.localDestinations.length, 1);
    assert.equal(refs.localDestinations[0]!.destination, '?param=1');
    assert.deepEqual(
      resolveMarkdownNoteLinks('folder/source.md', ['?param=1'], new Set(['folder/source.md'])),
      [],
    );
  });

  it('skips links with non-http schemes like mailto', () => {
    const refs = extractMarkdownReferenceOccurrences('[email](mailto:foo@bar.com)');
    assert.equal(refs.localDestinations.length, 0);
    // mailto: is not http, so not in urls either
    assert.ok(!refs.urls.includes('mailto:foo@bar.com'));
  });
});

describe('resolveMarkdownNoteLinks — edge cases', () => {
  const existing = new Set<string>([
    'folder/note.md'.normalize('NFD'),
    'folder/child.md'.normalize('NFD'),
    'folder/file.md'.normalize('NFD'),
    'folder/file.txt'.normalize('NFD'),
    'root.md'.normalize('NFD'),
    'notes/中文.md'.normalize('NFD'),
    'notes/Target Note.md'.normalize('NFD'),
  ]);

  it('resolves relative ./note.md from folder/source.md', () => {
    const resolved = resolveMarkdownNoteLinks('folder/source.md', ['./note.md'], existing);
    assert.deepEqual(resolved, ['folder/note.md']);
  });

  it('resolves ../note.md from folder/sub/source.md', () => {
    const resolved = resolveMarkdownNoteLinks('folder/sub/source.md', ['../note.md'], existing);
    assert.deepEqual(resolved, ['folder/note.md']);
  });

  it('treats leading slash as vault-root-relative', () => {
    const resolved = resolveMarkdownNoteLinks('folder/source.md', ['/root.md'], existing);
    assert.deepEqual(resolved, ['root.md']);
  });

  it('tries .md extension for extensionless targets', () => {
    const resolved = resolveMarkdownNoteLinks('folder/source.md', ['./child'], existing);
    assert.deepEqual(resolved, ['folder/child.md']);
  });

  it.each([
    { name: 'does not append .md to non-note extensions', link: './file.txt' },
    { name: 'rejects paths escaping vault root', link: '../../outside.md' },
    { name: 'rejects path resolving to .', link: './' },
  ])('$name', ({ link }) => {
    const resolved = resolveMarkdownNoteLinks('folder/source.md', [link], existing);
    assert.deepEqual(resolved, []);
  });

  it('NFD-normalizes link target before lookup', () => {
    const resolved = resolveMarkdownNoteLinks('source.md', ['./notes/中文.md'], existing);
    assert.deepEqual(resolved, ['notes/中文.md'.normalize('NFD')]);
  });

  it('skips self-links (fromPath === resolved)', () => {
    const resolved = resolveMarkdownNoteLinks('folder/note.md', ['./note.md'], existing);
    assert.deepEqual(resolved, []);
  });

  it('decodes percent-encoded paths', () => {
    const resolved = resolveMarkdownNoteLinks(
      'source.md',
      ['./notes/%E4%B8%AD%E6%96%87.md'],
      existing,
    );
    assert.deepEqual(resolved, ['notes/中文.md'.normalize('NFD')]);
  });

  it('falls back to raw string for malformed percent escapes', () => {
    // %E4%28 is not valid UTF-8 — safeDecodePath should return raw
    const resolved = resolveMarkdownNoteLinks('source.md', ['./%E4%28.md'], existing);
    // Raw string won't match any existing note → empty
    assert.deepEqual(resolved, []);
  });

  it('normalizes backslash paths to forward slashes', () => {
    const resolved = resolveMarkdownNoteLinks('source.md', ['folder\\note.md'], existing);
    assert.deepEqual(resolved, ['folder/note.md']);
  });
});
