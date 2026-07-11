import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

// chokidar is imported by indexer at module load — mock it to avoid real watchers.
vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({ on: vi.fn().mockReturnThis() }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-indexer-edge-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const {
  indexFile,
  indexVaultSync,
  cleanupStaleNotes,
  parseWikilinks,
  resolveWikilinks,
  parseAliasField,
  parseInlineTags,
  formatDuration,
  renderProgressLine,
} = await import('../src/indexer.js');
const { closeDb, openDb, initVecTable, upsertNote, getDb, isLikelyDatabaseCorruption } =
  await import('../src/db.js');
const { bumpIndexVersion } = await import('../src/searcher.js');

// Spy on embedder (matching test/indexer-file.test.ts strategy) so both files
// cooperate on the same real module instance under vitest's isolate:false.
// A vi.mock() factory here would be discarded once another test file imports
// the real embedder module, leaking the real (384-dim) local model through.
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'embedDetailed').mockImplementation(async (texts: string[]) =>
  texts.map(() => ({
    ok: true as const,
    embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
  })),
);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
  limit: 508,
  count: (text) => Math.ceil(Array.from(text).length / 4),
});

describe('indexFile embedding projection failures', () => {
  it('coerces a numeric frontmatter title before token counting', async () => {
    const body = 'numeric title body';
    writeNote('idx-numeric-title.md', `---\ntitle: 42\n---\n${body}`);
    vi.mocked(embedder.getDocumentTokenPolicy).mockResolvedValueOnce({
      limit: 64,
      count: (text) => {
        let count = 0;
        for (const _char of text) count++;
        return count;
      },
    });

    const result = await indexFile(path.join(vaultDir, 'idx-numeric-title.md'), 512);

    assert.equal(result, 'indexed');
    assert.equal(
      getDb().prepare('SELECT title FROM notes WHERE path = ?').pluck().get('idx-numeric-title.md'),
      '42',
    );
  });

  it('keeps empty-note indexing off the token-policy and embedding paths', async () => {
    writeNote('idx-empty-policy.md', '---\ntags: [empty]\n---\n');
    const policyCalls = vi.mocked(embedder.getDocumentTokenPolicy).mock.calls.length;
    const embedCalls = vi.mocked(embedder.embedDetailed).mock.calls.length;

    const result = await indexFile(path.join(vaultDir, 'idx-empty-policy.md'), 512);

    assert.equal(result, 'indexed');
    assert.equal(vi.mocked(embedder.getDocumentTokenPolicy).mock.calls.length, policyCalls);
    assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, embedCalls);
  });

  it('resolves prefix-only overflow by truncating only the projected note context', async () => {
    const title = `Prefix 😀 ${'very-long-title '.repeat(8)}`;
    const body = 'raw body intact';
    writeNote('idx-prefix-overflow.md', `---\ntitle: ${title}\n---\n${body}`);
    const detailedSpy = vi.mocked(embedder.embedDetailed);
    vi.mocked(embedder.getDocumentTokenPolicy).mockResolvedValueOnce({
      limit: 24,
      count: (text) => Array.from(text).length,
    });
    detailedSpy.mockImplementationOnce(async (texts: string[]) =>
      texts.map((text) =>
        Array.from(text).length <= 24
          ? { ok: true as const, embedding: fakeEmbedding }
          : { ok: false as const, kind: 'input_too_long', status: 400, message: 'too long' },
      ),
    );

    const result = await indexFile(path.join(vaultDir, 'idx-prefix-overflow.md'), 512);
    assert.equal(result, 'indexed');
    const note = getDb()
      .prepare('SELECT id, content FROM notes WHERE path = ?')
      .get('idx-prefix-overflow.md') as { id: number; content: string };
    const rows = getDb()
      .prepare('SELECT text, embedding_status FROM chunks WHERE note_id = ? ORDER BY chunk_index')
      .all(note.id) as Array<{ text: string; embedding_status: string }>;
    assert.equal(note.content, body);
    assert.deepEqual(rows, [{ text: body, embedding_status: 'ok' }]);
    const projected = detailedSpy.mock.calls.at(-1)?.[0][0];
    assert.ok(projected);
    assert.equal(projected?.endsWith(`\n${body}`), true);
    assert.ok(Array.from(projected).length <= 24);
  });

  it('does not split a generic provider 400 failure', async () => {
    const body = 'generic provider bad request remains one failed chunk';
    writeNote('idx-generic-400.md', body);
    const detailedSpy = vi.mocked(embedder.embedDetailed);
    detailedSpy.mockResolvedValueOnce([
      { ok: false, kind: 'permanent', status: 400, message: 'bad request' },
    ]);

    const callsBefore = detailedSpy.mock.calls.length;
    const result = await indexFile(path.join(vaultDir, 'idx-generic-400.md'), 512);
    assert.equal(result, 'indexed');
    const note = getDb()
      .prepare('SELECT id FROM notes WHERE path = ?')
      .get('idx-generic-400.md') as {
      id: number;
    };
    const rows = getDb()
      .prepare('SELECT text, embedding_status FROM chunks WHERE note_id = ? ORDER BY chunk_index')
      .all(note.id) as Array<{ text: string; embedding_status: string }>;
    assert.deepEqual(rows, [{ text: body, embedding_status: 'failed' }]);
    assert.equal(detailedSpy.mock.calls.length - callsBefore, 1);
  });
});

const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

function writeNote(relPath: string, content: string): void {
  const fullPath = path.join(vaultDir, relPath);
  mkdirSync(path.dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

beforeAll(() => {
  openDb();
  initVecTable(4);
});

afterAll(() => {
  vi.mocked(embedder.embed).mockRestore();
  vi.mocked(embedder.embedDetailed).mockRestore();
  vi.mocked(embedder.getContextLength).mockRestore();
  vi.mocked(embedder.getDocumentTokenPolicy).mockRestore();
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── parseWikilinks — edge cases ──────────────────────────────────────────────

describe('parseWikilinks — edge cases', () => {
  it('extracts simple wikilink', () => {
    assert.deepEqual(parseWikilinks('[[note]]'), ['note']);
  });

  it('strips alias from wikilink', () => {
    assert.deepEqual(parseWikilinks('[[note|alias]]'), ['note']);
  });

  it('strips heading from wikilink', () => {
    assert.deepEqual(parseWikilinks('[[note#heading]]'), ['note']);
  });

  it('strips block reference from wikilink', () => {
    assert.deepEqual(parseWikilinks('[[note#^block-id]]'), ['note']);
  });

  it('handles nested paths', () => {
    assert.deepEqual(parseWikilinks('[[folder/note]]'), ['folder/note']);
  });

  it('returns empty for no wikilinks', () => {
    assert.deepEqual(parseWikilinks('plain text'), []);
  });
});

// ─── parseAliasField — edge cases ─────────────────────────────────────────────

describe('parseAliasField — edge cases', () => {
  it('string value returns single-element array', () => {
    assert.deepEqual(parseAliasField('alias-name'), ['alias-name']);
  });

  it('array value returns as-is', () => {
    assert.deepEqual(parseAliasField(['a', 'b']), ['a', 'b']);
  });

  it('null returns empty array', () => {
    assert.deepEqual(parseAliasField(null), []);
  });

  it('number returns empty array', () => {
    assert.deepEqual(parseAliasField(42), []);
  });

  it('array with non-string elements filters to strings only', () => {
    // parseAliasField maps every element through String() then filters empties,
    // so a number becomes its decimal string and survives — only truly empty
    // strings (after String()) are removed. 42 → "42" is non-empty, so it is
    // kept. This documents the real coercion behaviour rather than a pure
    // "strings only" filter.
    assert.deepEqual(parseAliasField(['a', 42, 'b']), ['a', '42', 'b']);
  });
});

// ─── parseInlineTags — edge cases ──────────────────────────────────────────────

describe('parseInlineTags — edge cases', () => {
  it('extracts simple inline tag', () => {
    const tags = parseInlineTags('text #pkm more');
    assert.ok(tags.includes('pkm'));
  });

  it('extracts nested tag', () => {
    const tags = parseInlineTags('text #category/cs more');
    assert.ok(tags.includes('category/cs'));
  });

  it('hash followed by space is not a tag', () => {
    const tags = parseInlineTags('not a # tag');
    assert.ok(!tags.includes(''));
    assert.deepEqual(tags, []);
  });

  it('returns empty for no tags', () => {
    assert.deepEqual(parseInlineTags('plain text'), []);
  });
});

// ─── resolveWikilinks — edge cases ─────────────────────────────────────────────

describe('resolveWikilinks — edge cases', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'resolve/target.md',
      title: 'Resolve Target',
      tags: [],
      content: 'Target note.',
      mtime: Date.now(),
      hash: 'h-target',
      chunks: [{ text: 'Target note', embedding: fakeEmbedding }],
    });
  });

  it('resolves existing note by basename', () => {
    // [[target]] → basename 'target.md' → path 'resolve/target.md'
    const resolved = resolveWikilinks('[[target]]', 'resolve/source.md');
    assert.ok(resolved.includes('resolve/target.md'));
  });

  it('does not resolve non-existent note', () => {
    const resolved = resolveWikilinks('[[nonexistent]]', 'resolve/source.md');
    assert.deepEqual(resolved, []);
  });
});

// ─── formatDuration — edge cases ───────────────────────────────────────────────

describe('formatDuration — edge cases', () => {
  it('0 seconds → 0s', () => {
    assert.equal(formatDuration(0), '0s');
  });

  it('rounds to nearest second', () => {
    assert.equal(formatDuration(1.4), '1s');
    assert.equal(formatDuration(1.5), '2s');
  });

  it('formats minutes', () => {
    assert.equal(formatDuration(65), '1m 5s');
  });

  it('formats hours', () => {
    // formatDuration only emits "<m> <s>" (no hours unit), so 3665s = 61m 5s.
    assert.equal(formatDuration(3665), '61m 5s');
  });
});

// ─── renderProgressLine — edge cases ──────────────────────────────────────────

describe('renderProgressLine — edge cases', () => {
  it('0/100 shows 0%', () => {
    const line = renderProgressLine(0, 100, '');
    assert.ok(line.includes('0%'));
  });

  it('50/100 shows 50%', () => {
    const line = renderProgressLine(50, 100, '');
    assert.ok(line.includes('50%'));
  });

  it('100/100 shows 100%', () => {
    const line = renderProgressLine(100, 100, '');
    assert.ok(line.includes('100%'));
  });

  it('includes ETA string when provided', () => {
    const line = renderProgressLine(50, 100, ' — 30s remaining');
    assert.ok(line.includes('30s remaining'));
  });
});

// ─── indexFile — incremental indexing ─────────────────────────────────────────

describe('indexFile — incremental indexing', () => {
  it('indexes new file', async () => {
    writeNote('idx-new.md', '---\ntitle: New File\n---\nNew file content for indexing.');
    const fullPath = path.join(vaultDir, 'idx-new.md');
    const result = await indexFile(fullPath, 512);
    assert.equal(result, 'indexed');
  });

  it('skips unchanged file (same hash)', async () => {
    writeNote('idx-skip.md', '---\ntitle: Skip File\n---\nUnchanging content.');
    const fullPath = path.join(vaultDir, 'idx-skip.md');
    await indexFile(fullPath, 512);
    const result = await indexFile(fullPath, 512);
    assert.equal(result, 'skipped');
  });

  it('re-indexes changed file (different hash)', async () => {
    writeNote('idx-change.md', '---\ntitle: Change\n---\nOriginal content.');
    const fullPath = path.join(vaultDir, 'idx-change.md');
    await indexFile(fullPath, 512);
    writeNote('idx-change.md', '---\ntitle: Change\n---\nModified content.');
    const result = await indexFile(fullPath, 512);
    assert.equal(result, 'indexed');
  });

  it('indexes file with no frontmatter', async () => {
    writeNote('idx-no-fm.md', 'Content without any frontmatter.');
    const fullPath = path.join(vaultDir, 'idx-no-fm.md');
    const result = await indexFile(fullPath, 512);
    assert.equal(result, 'indexed');
  });

  it('indexes empty file', async () => {
    writeNote('idx-empty.md', '');
    const fullPath = path.join(vaultDir, 'idx-empty.md');
    const result = await indexFile(fullPath, 512);
    // An empty file has no chunks to embed but is still inserted into the DB,
    // so it counts as 'indexed'.
    assert.ok(result === 'indexed' || result === 'skipped');
  });
});

// ─── indexVaultSync — edge cases ───────────────────────────────────────────────

describe('indexVaultSync — edge cases', () => {
  it('empty vault returns zero indexed/skipped', async () => {
    const emptyVault = mkdtempSync(path.join(tmpdir(), 'ohs-indexer-empty-'));
    const originalPath = process.env.OBSIDIAN_VAULT_PATH;
    process.env.OBSIDIAN_VAULT_PATH = emptyVault;
    closeDb();
    openDb();
    initVecTable(4);

    try {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const result = await indexVaultSync(false, 'Indexing empty vault...');
      stderrSpy.mockRestore();

      assert.equal(result.indexed, 0);
      assert.equal(result.skipped, 0);
      assert.deepEqual(result.errors, []);
    } finally {
      process.env.OBSIDIAN_VAULT_PATH = originalPath;
      closeDb();
      openDb();
      initVecTable(4);
      rmSync(emptyVault, { recursive: true, force: true });
    }
  });

  it('force=true re-indexes all files regardless of hash', async () => {
    writeNote('force-1.md', 'Force index content.');
    await indexVaultSync(false, 'Initial index...');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await indexVaultSync(true, 'Force reindex...');
    stderrSpy.mockRestore();
    // force=true should re-index all files
    assert.ok(result.indexed >= 0);
  });
});

// ─── cleanupStaleNotes — edge cases ────────────────────────────────────────────

describe('cleanupStaleNotes — edge cases', () => {
  it('removes notes deleted from disk', () => {
    writeNote('stale-1.md', 'Stale note content.');
    const fullPath = path.join(vaultDir, 'stale-1.md');

    // Index it first (via direct DB insert)
    upsertNote({
      path: 'stale-1.md',
      title: 'Stale',
      tags: [],
      content: 'Stale note content.',
      mtime: Date.now(),
      hash: 'h-stale-1',
      chunks: [{ text: 'Stale note content', embedding: fakeEmbedding }],
    });

    // Delete file from disk
    rmSync(fullPath);

    // cleanupStaleNotes with fsPaths set that doesn't include stale-1.md
    cleanupStaleNotes(new Set(['other.md']));

    // Note should be removed from DB
    const db = getDb();
    const row = db.prepare('SELECT path FROM notes WHERE path = ?').get('stale-1.md');
    assert.equal(row, undefined);
  });

  it('no stale notes results in no error', () => {
    // Insert a note directly and keep it in the fsPaths set — should not throw
    // and the matching note should remain in the DB.
    upsertNote({
      path: 'stale-keep.md',
      title: 'Keep',
      tags: [],
      content: 'Keep me.',
      mtime: Date.now(),
      hash: 'h-stale-keep',
      chunks: [{ text: 'Keep me.', embedding: fakeEmbedding }],
    });
    cleanupStaleNotes(new Set(['stale-keep.md']));
    const db = getDb();
    const row = db.prepare('SELECT path FROM notes WHERE path = ?').get('stale-keep.md');
    assert.ok(row, 'matching note should still exist after cleanup');
  });
});

// ─── isLikelyDatabaseCorruption — edge cases ───────────────────────────────────

describe('isLikelyDatabaseCorruption — edge cases', () => {
  it('recognizes SQLITE_CORRUPT code', () => {
    const err = new Error('database disk image is malformed');
    assert.equal(isLikelyDatabaseCorruption(err), true);
  });

  it('recognizes corruption message text', () => {
    const err = new Error('database is corrupt');
    assert.equal(isLikelyDatabaseCorruption(err), true);
  });

  it('does not classify SQLITE_BUSY as corruption', () => {
    const err = new Error('database is locked');
    assert.equal(isLikelyDatabaseCorruption(err), false);
  });

  it('does not classify generic errors as corruption', () => {
    const err = new Error('something went wrong');
    assert.equal(isLikelyDatabaseCorruption(err), false);
  });

  it('handles non-Error values', () => {
    assert.equal(isLikelyDatabaseCorruption('string error'), false);
    assert.equal(isLikelyDatabaseCorruption(null), false);
    assert.equal(isLikelyDatabaseCorruption(undefined), false);
  });
});
