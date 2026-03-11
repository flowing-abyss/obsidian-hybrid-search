import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

// ─── Vault setup (must precede any application module imports) ────────────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-indexer-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// Dynamic imports so config reads the env var we just set
const { parseInlineTags, parseWikilinks, resolveWikilinks } = await import('../src/indexer.js');
const { openDb, initVecTable, upsertNote } = await import('../src/db.js');

// ─── Shared helpers ───────────────────────────────────────────────────────────

const EMBED_DIM = 4;
const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

function insertNote(opts: {
  path: string;
  title: string;
  content?: string;
  aliases?: string[];
}): void {
  upsertNote({
    path: opts.path,
    title: opts.title,
    tags: [],
    aliases: opts.aliases ?? [],
    content: opts.content ?? opts.title,
    mtime: Date.now(),
    hash: 'test-' + opts.path,
    chunks: [{ text: opts.content ?? opts.title, embedding: fakeEmbedding }],
  });
}

// ─── parseInlineTags ──────────────────────────────────────────────────────────

describe('parseInlineTags', () => {
  it('extracts simple inline tags', () => {
    const tags = parseInlineTags('Some text #pkm and #zettelkasten here');
    assert.ok(tags.includes('pkm'));
    assert.ok(tags.includes('zettelkasten'));
  });

  it('extracts hierarchical tags', () => {
    const tags = parseInlineTags('This is #note/basic/primary content');
    assert.ok(tags.includes('note/basic/primary'));
  });

  it('does not match tags inside code blocks', () => {
    const tags = parseInlineTags('Normal #real-tag\n```\n#fake-tag in code\n```');
    assert.ok(tags.includes('real-tag'));
    assert.ok(!tags.includes('fake-tag'), 'tags in code blocks should be ignored');
  });

  it('does not match tags starting with digits', () => {
    const tags = parseInlineTags('Number #123 and #42foo are not tags');
    assert.ok(!tags.includes('123'), '#123 should not be a tag (starts with digit)');
    assert.ok(!tags.includes('42foo'), '#42foo should not be a tag (starts with digit)');
  });

  it('deduplicates repeated tags', () => {
    const tags = parseInlineTags('#pkm first mention and #pkm second mention');
    assert.equal(tags.filter((t) => t === 'pkm').length, 1);
  });
});

// ─── parseWikilinks ───────────────────────────────────────────────────────────

describe('parseWikilinks', () => {
  it('extracts a plain wikilink', () => {
    const links = parseWikilinks('See [[my note]] for details.');
    assert.deepEqual(links, ['my note']);
  });

  it('extracts display-text wikilink [[target|display]] — returns target only', () => {
    const links = parseWikilinks('Read [[alpha|Alpha Note]] first.');
    assert.deepEqual(links, ['alpha']);
  });

  it('extracts heading wikilink [[target#heading]] — returns target only', () => {
    const links = parseWikilinks('Jump to [[note#Introduction]].');
    assert.deepEqual(links, ['note']);
  });

  it('extracts heading + display wikilink [[target#heading|display]]', () => {
    const links = parseWikilinks('See [[note#section|label]].');
    assert.deepEqual(links, ['note']);
  });

  it('extracts wikilink with a folder path', () => {
    const links = parseWikilinks('[[notes/sub/deep note]]');
    assert.deepEqual(links, ['notes/sub/deep note']);
  });

  it('extracts multiple wikilinks from one string', () => {
    const links = parseWikilinks('[[alpha]] links to [[beta]] and [[gamma]].');
    assert.ok(links.includes('alpha'));
    assert.ok(links.includes('beta'));
    assert.ok(links.includes('gamma'));
    assert.equal(links.length, 3);
  });

  it('deduplicates repeated wikilinks', () => {
    const links = parseWikilinks('[[alpha]] and then [[alpha]] again.');
    assert.equal(links.filter((l) => l === 'alpha').length, 1);
  });

  it('returns empty array when there are no wikilinks', () => {
    const links = parseWikilinks('Plain text with no wikilinks here.');
    assert.deepEqual(links, []);
  });

  it('does not match standard Markdown links [text](url)', () => {
    const links = parseWikilinks('[click here](https://example.com)');
    assert.deepEqual(links, []);
  });

  it('trims whitespace from the target', () => {
    const links = parseWikilinks('[[ spaced note ]]');
    assert.deepEqual(links, ['spaced note']);
  });
});

// ─── resolveWikilinks ─────────────────────────────────────────────────────────

describe('resolveWikilinks', () => {
  beforeAll(() => {
    openDb();
    initVecTable(EMBED_DIM);

    // Root-level note — resolved by exact path or basename
    insertNote({ path: 'alpha.md', title: 'Alpha Note' });

    // Nested note — basename is 'beta.md', path is 'notes/beta.md'
    insertNote({ path: 'notes/beta.md', title: 'Beta Note' });

    // Deeply nested — for suffix path matching via [[sub/gamma]]
    insertNote({ path: 'notes/sub/gamma.md', title: 'Gamma Note' });

    // Note whose filename uses different case than wikilinks may use
    insertNote({ path: 'mixed-case.md', title: 'Mixed Case Note' });

    // Note with explicit aliases
    insertNote({
      path: 'delta.md',
      title: 'Delta Note',
      aliases: ['alternate name', 'alt'],
    });

    // Note whose title contains NFC characters (as produced by frontmatter on
    // non-macOS systems). U+00E9 = precomposed é (NFC);
    // NFD form = e + U+0301 (combining acute accent).
    const nfcTitle = 'R\u00e9sum\u00e9';
    insertNote({ path: 'resume.md', title: nfcTitle });

    // Note whose alias contains an NFC character
    const nfcAlias = 'caf\u00e9';
    insertNote({ path: 'cafe.md', title: 'Cafe Note', aliases: [nfcAlias] });
  });

  afterAll(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  // ── exact path ──────────────────────────────────────────────────────────────

  it('resolves plain note name (exact basename without extension)', () => {
    const result = resolveWikilinks('[[alpha]]', 'source.md');
    assert.ok(result.includes('alpha.md'), `expected alpha.md in ${JSON.stringify(result)}`);
  });

  it('resolves exact vault-relative path [[notes/beta]]', () => {
    const result = resolveWikilinks('[[notes/beta]]', 'source.md');
    assert.ok(
      result.includes('notes/beta.md'),
      `expected notes/beta.md in ${JSON.stringify(result)}`,
    );
  });

  it('resolves note with .md extension explicit in wikilink', () => {
    const result = resolveWikilinks('[[alpha.md]]', 'source.md');
    assert.ok(result.includes('alpha.md'), `expected alpha.md in ${JSON.stringify(result)}`);
  });

  // ── suffix / partial path ───────────────────────────────────────────────────

  it('resolves partial path [[sub/gamma]] → notes/sub/gamma.md', () => {
    const result = resolveWikilinks('[[sub/gamma]]', 'source.md');
    assert.ok(
      result.includes('notes/sub/gamma.md'),
      `expected notes/sub/gamma.md in ${JSON.stringify(result)}`,
    );
  });

  it('resolves longer partial path [[notes/sub/gamma]] → notes/sub/gamma.md', () => {
    const result = resolveWikilinks('[[notes/sub/gamma]]', 'source.md');
    assert.ok(
      result.includes('notes/sub/gamma.md'),
      `expected notes/sub/gamma.md in ${JSON.stringify(result)}`,
    );
  });

  // ── case-insensitive basename ────────────────────────────────────────────────

  it('resolves [[Alpha]] case-insensitively to alpha.md', () => {
    const result = resolveWikilinks('[[Alpha]]', 'source.md');
    assert.ok(result.includes('alpha.md'), `expected alpha.md in ${JSON.stringify(result)}`);
  });

  it('resolves [[MIXED-CASE]] case-insensitively to mixed-case.md', () => {
    const result = resolveWikilinks('[[MIXED-CASE]]', 'source.md');
    assert.ok(
      result.includes('mixed-case.md'),
      `expected mixed-case.md in ${JSON.stringify(result)}`,
    );
  });

  // ── alias matching ───────────────────────────────────────────────────────────

  it('resolves a wikilink that matches a note alias', () => {
    const result = resolveWikilinks('[[alternate name]]', 'source.md');
    assert.ok(result.includes('delta.md'), `expected delta.md in ${JSON.stringify(result)}`);
  });

  it('resolves a short alias case-insensitively', () => {
    const result = resolveWikilinks('[[Alt]]', 'source.md');
    assert.ok(result.includes('delta.md'), `expected delta.md in ${JSON.stringify(result)}`);
  });

  // ── title matching ───────────────────────────────────────────────────────────

  it('resolves by note title (case-insensitive)', () => {
    const result = resolveWikilinks('[[alpha note]]', 'source.md');
    assert.ok(result.includes('alpha.md'), `expected alpha.md in ${JSON.stringify(result)}`);
  });

  // ── NFC / NFD normalization ──────────────────────────────────────────────────

  it('resolves NFC title via NFD-normalised wikilink target', () => {
    // Wikilink written with NFD form of é (e + combining accent)
    const nfdWikilink = '[[Re\u0301sume\u0301]]';
    const result = resolveWikilinks(nfdWikilink, 'source.md');
    assert.ok(result.includes('resume.md'), `expected resume.md in ${JSON.stringify(result)}`);
  });

  it('resolves NFC title via NFC wikilink target', () => {
    const nfcWikilink = '[[R\u00e9sum\u00e9]]';
    const result = resolveWikilinks(nfcWikilink, 'source.md');
    assert.ok(result.includes('resume.md'), `expected resume.md in ${JSON.stringify(result)}`);
  });

  it('resolves NFC alias via NFD-normalised wikilink', () => {
    // 'café' written with NFD é
    const nfdWikilink = '[[cafe\u0301]]';
    const result = resolveWikilinks(nfdWikilink, 'source.md');
    assert.ok(result.includes('cafe.md'), `expected cafe.md in ${JSON.stringify(result)}`);
  });

  // ── display-text syntax ──────────────────────────────────────────────────────

  it('resolves [[target|display text]] using the target, not the display text', () => {
    const result = resolveWikilinks('[[alpha|some label]]', 'source.md');
    assert.ok(result.includes('alpha.md'), `expected alpha.md in ${JSON.stringify(result)}`);
  });

  it('resolves [[path/to/note|display]] correctly', () => {
    const result = resolveWikilinks('[[notes/beta|show this]]', 'source.md');
    assert.ok(
      result.includes('notes/beta.md'),
      `expected notes/beta.md in ${JSON.stringify(result)}`,
    );
  });

  // ── self-links & integrity ───────────────────────────────────────────────────

  it('does not include the source note itself in resolved links', () => {
    const result = resolveWikilinks('[[alpha]]', 'alpha.md');
    assert.ok(!result.includes('alpha.md'), 'self-links must be excluded');
  });

  it('returns empty array when no wikilinks are present', () => {
    const result = resolveWikilinks('Plain text content.', 'source.md');
    assert.deepEqual(result, []);
  });

  it('skips wikilinks that cannot be resolved to any indexed note', () => {
    const result = resolveWikilinks('[[nonexistent note xyz]]', 'source.md');
    assert.deepEqual(result, []);
  });

  it('deduplicates when the same note is referenced multiple times', () => {
    const result = resolveWikilinks('[[alpha]] and [[alpha]] again.', 'source.md');
    assert.equal(
      result.filter((p) => p === 'alpha.md').length,
      1,
      'same note should appear only once',
    );
  });

  it('resolves multiple distinct links from one note body', () => {
    const result = resolveWikilinks('[[alpha]] plus [[notes/beta]] and [[delta]].', 'source.md');
    assert.ok(result.includes('alpha.md'));
    assert.ok(result.includes('notes/beta.md'));
    assert.ok(result.includes('delta.md'));
    assert.equal(result.length, 3);
  });
});
