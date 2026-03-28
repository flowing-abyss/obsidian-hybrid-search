import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

// ─── Vault setup (before any imports that read OBSIDIAN_VAULT_PATH) ──────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

writeFileSync(
  path.join(vaultDir, 'zettelkasten-deep.md'),
  '# Zettelkasten Deep Dive\n\n' +
    'Zettelkasten zettelkasten zettelkasten. The zettelkasten method by Niklas Luhmann ' +
    'uses atomic zettelkasten notes linked together. Zettelkasten enables emergent knowledge ' +
    'through zettelkasten connections. Every zettelkasten note is self-contained.',
);
writeFileSync(
  path.join(vaultDir, 'pkm-overview.md'),
  '# PKM Overview\n\nPersonal knowledge management covers many methods. ' +
    'One popular approach is zettelkasten. Others include mind mapping and outlines.',
);
writeFileSync(
  path.join(vaultDir, 'python-notes.md'),
  '# Python Programming\n\nPython is a versatile language. ' +
    'It supports functional, object-oriented, and procedural paradigms. ' +
    'See [[pkm-overview]] for knowledge management analogies.',
);
writeFileSync(
  path.join(vaultDir, 'linker.md'),
  '# Linker Note\n\nLinks to [[zettelkasten-deep]] and [[pkm-overview]].',
);

// ─── Module imports (after env is set) ───────────────────────────────────────

const {
  openDb,
  initVecTable,
  upsertNote,
  upsertLinks,
  getLinksForPaths,
  getNoteByPath,
  getDb,
  deleteNote,
  checkModelChanged,
  getStats,
  getPathsToRemoveForIgnoreChange,
  saveConfigMeta,
  applyDbConfigDefaults,
  filterNotePathsByTag,
  filterNotePathsByFrontmatter,
} = await import('../src/db.js');
const { searchBm25, searchFuzzyTitle, search } = await import('../src/searcher.js');
const { isIgnored } = await import('../src/ignore.js');

// ─── Shared test fixtures ────────────────────────────────────────────────────

const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

const initialNotes = [
  {
    path: 'zettelkasten-deep.md',
    title: 'Zettelkasten Deep Dive',
    content:
      'Zettelkasten zettelkasten zettelkasten. The zettelkasten method by Niklas Luhmann uses atomic zettelkasten notes.',
  },
  {
    path: 'pkm-overview.md',
    title: 'PKM Overview',
    content:
      'Personal knowledge management covers many methods. One popular approach is zettelkasten.',
  },
  {
    path: 'python-notes.md',
    title: 'Python Programming',
    content:
      'Python is a versatile language. It supports functional, object-oriented, and procedural paradigms.',
  },
  {
    path: 'linker.md',
    title: 'Linker Note',
    content: 'Links to [[zettelkasten-deep]] and [[pkm-overview]].',
  },
];

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
  openDb();
  initVecTable(4);
  for (const note of initialNotes) {
    upsertNote({
      path: note.path,
      title: note.title,
      tags: [],
      content: note.content,
      mtime: Date.now(),
      hash: 'test-' + note.path,
      chunks: [{ text: note.content, embedding: fakeEmbedding }],
    });
  }
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── frontmatter storage ─────────────────────────────────────────────────────

describe('upsertNote frontmatter storage', () => {
  it('stores frontmatter and retrieves it via getNoteByPath', () => {
    upsertNote({
      path: 'fm-test.md',
      title: 'Frontmatter Test',
      tags: [],
      content: 'body content',
      frontmatter: { category: ['pkm-overview'] },
      mtime: Date.now(),
      hash: 'fm-test',
      chunks: [{ text: 'body content', embedding: fakeEmbedding }],
    });
    const note = getNoteByPath('fm-test.md');
    assert.ok(note, 'note should be found');
    assert.ok(note.frontmatter.includes('category'), 'frontmatter should contain category');
  });

  it('returns empty string when frontmatter is not provided', () => {
    const note = getNoteByPath('zettelkasten-deep.md');
    assert.ok(note, 'note should be found');
    assert.equal(note.frontmatter, '');
  });
});

describe('frontmatter filter', () => {
  it('filters by frontmatter field value', () => {
    upsertNote({
      path: 'fm-filter-test.md',
      title: 'FM Filter Test',
      tags: [],
      content: 'content',
      frontmatter: { status: 'todo', priority: 'high' },
      mtime: Date.now(),
      hash: 'fm-filter-test',
      chunks: [{ text: 'content', embedding: fakeEmbedding }],
    });
    const result = filterNotePathsByFrontmatter(['fm-filter-test.md'], 'status:todo');
    assert.ok(result.has('fm-filter-test.md'), 'should include note with matching frontmatter');
  });

  it('frontmatter filter with multiple fields uses AND logic', () => {
    const result = filterNotePathsByFrontmatter(
      ['fm-filter-test.md'],
      ['status:todo', 'priority:high'],
    );
    assert.ok(result.has('fm-filter-test.md'), 'should include note with both fields');
  });

  it('frontmatter exclude filter works', () => {
    upsertNote({
      path: 'fm-filter-test-2.md',
      title: 'FM Filter Test 2',
      tags: [],
      content: 'content',
      frontmatter: { status: 'done' },
      mtime: Date.now(),
      hash: 'fm-filter-test-2',
      chunks: [{ text: 'content', embedding: fakeEmbedding }],
    });
    const result = filterNotePathsByFrontmatter(
      ['fm-filter-test.md', 'fm-filter-test-2.md'],
      '-status:done',
    );
    assert.ok(result.has('fm-filter-test.md'), 'should include note without excluded status');
    assert.ok(!result.has('fm-filter-test-2.md'), 'should exclude note with status:done');
  });

  it('frontmatter filter is case-insensitive', () => {
    const result = filterNotePathsByFrontmatter(['fm-filter-test.md'], 'status:TODO');
    assert.ok(result.has('fm-filter-test.md'), 'should match case-insensitive');
  });

  it('frontmatter filter with no matching field returns empty', () => {
    const result = filterNotePathsByFrontmatter(['fm-filter-test.md'], 'nonexistent:value');
    assert.equal(result.size, 0, 'should return empty for non-matching field');
  });

  it('frontmatter filter handles array values', () => {
    upsertNote({
      path: 'fm-array-test.md',
      title: 'FM Array Test',
      tags: [],
      content: 'content',
      frontmatter: { tags: ['todo', 'work'] },
      mtime: Date.now(),
      hash: 'fm-array-test',
      chunks: [{ text: 'content', embedding: fakeEmbedding }],
    });
    const result = filterNotePathsByFrontmatter(['fm-array-test.md'], 'tags:todo');
    assert.ok(result.has('fm-array-test.md'), 'should match array value');
  });

  it('empty frontmatter filter returns all paths', () => {
    upsertNote({
      path: 'fm-empty-test.md',
      title: 'FM Empty Test',
      tags: [],
      content: 'content',
      frontmatter: {},
      mtime: Date.now(),
      hash: 'fm-empty-test',
      chunks: [{ text: 'content', embedding: fakeEmbedding }],
    });
    const result = filterNotePathsByFrontmatter(['fm-empty-test.md'], 'status:anything');
    assert.equal(result.size, 0, 'should return empty when no matching frontmatter');
  });
});

describe('vec_chunks cleanup', () => {
  it('upsertNote removes stale vectors from previous chunks', () => {
    upsertNote({
      path: 'vec-upsert.md',
      title: 'Vec Upsert',
      tags: [],
      content: 'first version content',
      mtime: Date.now(),
      hash: 'vec-upsert-1',
      chunks: [
        { text: 'first chunk', embedding: fakeEmbedding },
        { text: 'second chunk', embedding: fakeEmbedding },
      ],
    });

    upsertNote({
      path: 'vec-upsert.md',
      title: 'Vec Upsert',
      tags: [],
      content: 'second version content',
      mtime: Date.now(),
      hash: 'vec-upsert-2',
      chunks: [{ text: 'replacement chunk', embedding: fakeEmbedding }],
    });

    const db = getDb();
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM chunks WHERE note_id = n.id) AS chunk_count,
           (SELECT COUNT(*)
            FROM vec_chunks vc
            JOIN chunks c ON c.id = vc.chunk_id
            WHERE c.note_id = n.id) AS vec_count
         FROM notes n
         WHERE n.path = ?`,
      )
      .get('vec-upsert.md') as { chunk_count: number; vec_count: number } | undefined;

    assert.ok(counts, 'note should exist after upsert');
    assert.equal(counts.chunk_count, 1, 'old chunks should be removed on re-upsert');
    assert.equal(counts.vec_count, 1, 'old vectors should be removed on re-upsert');
  });

  it('deleteNote removes vectors for deleted note only', () => {
    upsertNote({
      path: 'vec-delete-a.md',
      title: 'Vec Delete A',
      tags: [],
      content: 'note a',
      mtime: Date.now(),
      hash: 'vec-delete-a',
      chunks: [{ text: 'chunk a', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'vec-delete-b.md',
      title: 'Vec Delete B',
      tags: [],
      content: 'note b',
      mtime: Date.now(),
      hash: 'vec-delete-b',
      chunks: [{ text: 'chunk b', embedding: fakeEmbedding }],
    });

    deleteNote('vec-delete-a.md');

    const db = getDb();
    const deletedCount = db
      .prepare(
        `SELECT COUNT(*)
         FROM vec_chunks vc
         JOIN chunks c ON c.id = vc.chunk_id
         JOIN notes n ON n.id = c.note_id
         WHERE n.path = ?`,
      )
      .get('vec-delete-a.md') as { 'COUNT(*)': number };
    const keptCount = db
      .prepare(
        `SELECT COUNT(*)
         FROM vec_chunks vc
         JOIN chunks c ON c.id = vc.chunk_id
         JOIN notes n ON n.id = c.note_id
         WHERE n.path = ?`,
      )
      .get('vec-delete-b.md') as { 'COUNT(*)': number };

    assert.equal(deletedCount['COUNT(*)'], 0, 'deleted note should have no remaining vectors');
    assert.equal(keptCount['COUNT(*)'], 1, 'other notes should keep their vectors');
  });
});

// ─── title prepended to first chunk ──────────────────────────────────────────

describe('title prepended to first chunk', () => {
  it('BM25 search finds note by title text', () => {
    const results = searchBm25('Zettelkasten Deep Dive', 10);
    assert.ok(
      results.some((r) => r.path === 'zettelkasten-deep.md'),
      'should find by title text',
    );
  });
});

// ─── LRU cache ───────────────────────────────────────────────────────────────

describe('search LRU cache', () => {
  it('repeated query returns cached result', async () => {
    const r1 = await search('zettelkasten', { mode: 'fulltext', limit: 5 });
    const r2 = await search('zettelkasten', { mode: 'fulltext', limit: 5 });
    assert.strictEqual(r1, r2, 'repeated search should return cached result');
  });

  it('different query bypasses cache', async () => {
    const r1 = await search('zettelkasten', { mode: 'fulltext', limit: 5 });
    const r2 = await search('python programming', { mode: 'fulltext', limit: 5 });
    assert.notStrictEqual(r1, r2, 'different query should not return cached result');
  });
});

describe('note tag lookup', () => {
  it('stores normalized tags in note_tags for each upserted note', () => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT nt.tag, nt.tag_norm
         FROM note_tags nt
         JOIN notes n ON n.id = nt.note_id
         WHERE n.path = ?
         ORDER BY nt.tag_norm`,
      )
      .all('pkm-tag-test.md') as Array<{ tag: string; tag_norm: string }>;

    if (rows.length === 0) {
      upsertNote({
        path: 'pkm-tag-test.md',
        title: 'PKM Tag Test',
        tags: ['PKM', 'Method/Subtag'],
        content: 'tag storage test',
        mtime: Date.now(),
        hash: 'pkm-tag-test',
        chunks: [{ text: 'tag storage test', embedding: fakeEmbedding }],
      });
    }

    const storedRows = db
      .prepare(
        `SELECT nt.tag, nt.tag_norm
         FROM note_tags nt
         JOIN notes n ON n.id = nt.note_id
         WHERE n.path = ?
         ORDER BY nt.tag_norm`,
      )
      .all('pkm-tag-test.md') as Array<{ tag: string; tag_norm: string }>;

    assert.deepEqual(
      storedRows,
      [
        { tag: 'Method/Subtag', tag_norm: 'method/subtag' },
        { tag: 'PKM', tag_norm: 'pkm' },
      ],
      'note_tags should store raw and normalized tags',
    );
  });

  it('filters candidate note paths by include and exclude tag rules', () => {
    upsertNote({
      path: 'tag-sql-inc.md',
      title: 'Tag SQL Include',
      tags: ['include-me', 'shared'],
      content: 'include',
      mtime: Date.now(),
      hash: 'tag-sql-inc',
      chunks: [{ text: 'include', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'tag-sql-exc.md',
      title: 'Tag SQL Exclude',
      tags: ['exclude-me', 'shared'],
      content: 'exclude',
      mtime: Date.now(),
      hash: 'tag-sql-exc',
      chunks: [{ text: 'exclude', embedding: fakeEmbedding }],
    });

    const includeOnly = filterNotePathsByTag(['tag-sql-inc.md', 'tag-sql-exc.md'], 'include-me');
    assert.deepEqual(
      [...includeOnly].sort((a, b) => a.localeCompare(b)),
      ['tag-sql-inc.md'],
    );

    const sharedWithoutExclude = filterNotePathsByTag(
      ['tag-sql-inc.md', 'tag-sql-exc.md'],
      ['shared', '-exclude-me'],
    );
    assert.deepEqual(
      [...sharedWithoutExclude].sort((a, b) => a.localeCompare(b)),
      ['tag-sql-inc.md'],
    );
  });

  it('multiple tag filters use AND logic', () => {
    upsertNote({
      path: 'tag-and-1.md',
      title: 'Tag AND 1',
      tags: ['tag1', 'tag2'],
      content: 'content',
      mtime: Date.now(),
      hash: 'tag-and-1',
      chunks: [{ text: 'content', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'tag-and-2.md',
      title: 'Tag AND 2',
      tags: ['tag1'],
      content: 'content',
      mtime: Date.now(),
      hash: 'tag-and-2',
      chunks: [{ text: 'content', embedding: fakeEmbedding }],
    });

    const result = filterNotePathsByTag(['tag-and-1.md', 'tag-and-2.md'], ['tag1', 'tag2']);
    assert.deepEqual(
      [...result].sort((a, b) => a.localeCompare(b)),
      ['tag-and-1.md'],
    );
  });
});

// ─── BM25 score ordering ──────────────────────────────────────────────────────

describe('searchBm25 score ordering', () => {
  it('scores descend (most relevant first)', () => {
    const results = searchBm25('zettelkasten', 10);
    assert.ok(results.length >= 2, `expected ≥2 results, got ${results.length}`);
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1]!.score >= results[i]!.score,
        `score[${i - 1}]=${results[i - 1]!.score.toFixed(4)} should >= score[${i}]=${results[i]!.score.toFixed(4)}`,
      );
    }
  });

  it('scores are between 0 and 1', () => {
    const results = searchBm25('zettelkasten knowledge', 10);
    assert.ok(results.length > 0, 'should find results');
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} out of 0..1`);
    }
  });

  it('most relevant result has highest score', () => {
    const results = searchBm25('zettelkasten', 10);
    assert.ok(results.length >= 2);
    assert.equal(
      results[0]!.path,
      'zettelkasten-deep.md',
      'zettelkasten-deep.md should rank first',
    );
  });
});

// ─── BM25 AND/OR query logic ──────────────────────────────────────────────────

describe('searchBm25 AND/OR behavior', () => {
  it('multi-word query uses AND — notes with all terms rank above notes with only one', () => {
    // pkm-overview.md has both "zettelkasten" and "knowledge"
    // zettelkasten-deep.md has only "zettelkasten"
    const results = searchBm25('zettelkasten knowledge', 10);
    assert.ok(results.length > 0, 'should find results');
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('pkm-overview.md'), 'pkm-overview.md (both words) must appear');
    const pkmIdx = paths.indexOf('pkm-overview.md');
    const deepIdx = paths.indexOf('zettelkasten-deep.md');
    if (deepIdx !== -1) {
      assert.ok(pkmIdx < deepIdx, 'note with both words should rank above note with only one');
    }
  });

  it('falls back to OR when AND yields no results', () => {
    // No single note has both "zettelkasten" and "python"
    const results = searchBm25('zettelkasten python', 10);
    assert.ok(results.length >= 2, 'OR fallback should return notes matching either term');
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('python-notes.md'), 'python-notes.md must appear via OR fallback');
    assert.ok(
      paths.some((p) => p.includes('zettelkasten')),
      'a zettelkasten note must appear via OR fallback',
    );
  });
});

// ─── fuzzy title score ordering ──────────────────────────────────────────────

describe('searchFuzzyTitle score ordering', () => {
  it('scores descend', () => {
    const results = searchFuzzyTitle('zettelkasten', 10);
    assert.ok(results.length > 0, 'should find results');
    for (let i = 1; i < results.length; i++) {
      assert.ok(
        results[i - 1]!.score >= results[i]!.score,
        `fuzzy score[${i - 1}]=${results[i - 1]!.score.toFixed(4)} >= score[${i}]=${results[i]!.score.toFixed(4)}`,
      );
    }
  });

  it('scores are between 0 and 1', () => {
    const results = searchFuzzyTitle('pkm', 10);
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1, `fuzzy score ${r.score} out of 0..1`);
    }
  });

  it('snippet is empty for title search', () => {
    const results = searchFuzzyTitle('python', 10);
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.equal(r.snippet, '', 'title search should have empty snippet');
    }
  });
});

// ─── links & backlinks ────────────────────────────────────────────────────────

describe('links & backlinks', () => {
  beforeAll(() => {
    upsertLinks('linker.md', ['zettelkasten-deep.md', 'pkm-overview.md']);
    upsertLinks('python-notes.md', ['pkm-overview.md']);
  });

  it('creates traversal indexes needed for related search', () => {
    const db = getDb();
    const linkIndexes = db.prepare("PRAGMA index_list('links')").all() as Array<{ name: string }>;
    const chunkIndexes = db.prepare("PRAGMA index_list('chunks')").all() as Array<{ name: string }>;

    assert.ok(linkIndexes.some((idx) => idx.name === 'idx_links_to'));
    assert.ok(chunkIndexes.some((idx) => idx.name === 'idx_chunks_note_chunk_index'));
  });

  it('forward links populated', () => {
    const { links } = getLinksForPaths(['linker.md']);
    const l = links.get('linker.md') ?? [];
    assert.ok(l.includes('zettelkasten-deep.md'), 'should link to zettelkasten-deep.md');
    assert.ok(l.includes('pkm-overview.md'), 'should link to pkm-overview.md');
  });

  it('backlinks populated', () => {
    const { backlinks } = getLinksForPaths(['pkm-overview.md']);
    const bl = backlinks.get('pkm-overview.md') ?? [];
    assert.ok(bl.includes('linker.md'), 'pkm-overview.md should have linker.md as backlink');
    assert.ok(
      bl.includes('python-notes.md'),
      'pkm-overview.md should have python-notes.md as backlink',
    );
  });

  it('no self-links', () => {
    const { links } = getLinksForPaths(['linker.md']);
    const l = links.get('linker.md') ?? [];
    assert.ok(!l.includes('linker.md'), 'should not link to itself');
  });
});

// ─── deleteNote semantics ─────────────────────────────────────────────────────

describe('deleteNote semantics', () => {
  it('keepLinks=true preserves outgoing links after delete', () => {
    deleteNote('python-notes.md', true);
    const { backlinks } = getLinksForPaths(['pkm-overview.md']);
    const bl = backlinks.get('pkm-overview.md') ?? [];
    assert.ok(bl.includes('python-notes.md'), 'backlink from python-notes.md should be preserved');
  });

  it('keepLinks=false removes links on delete', () => {
    deleteNote('linker.md', false);
    const { backlinks } = getLinksForPaths(['zettelkasten-deep.md', 'pkm-overview.md']);
    const bl1 = backlinks.get('zettelkasten-deep.md') ?? [];
    const bl2 = backlinks.get('pkm-overview.md') ?? [];
    assert.ok(
      !bl1.includes('linker.md'),
      'backlink from linker.md to zettelkasten-deep.md removed',
    );
    assert.ok(!bl2.includes('linker.md'), 'backlink from linker.md to pkm-overview.md removed');
  });

  it('deleted note no longer in BM25 results', () => {
    const results = searchBm25('linker', 10);
    const paths = results.map((r) => r.path);
    assert.ok(
      !paths.includes('linker.md'),
      'linker.md should not appear in BM25 results after delete',
    );
  });
});

// ─── ignore patterns ─────────────────────────────────────────────────────────

describe('ignore patterns (isIgnored)', () => {
  it('matches directory wildcard pattern', () => {
    process.env.OBSIDIAN_IGNORE_PATTERNS = 'ignored/**';
    assert.ok(isIgnored('ignored/secret.md'), 'ignored/secret.md should be ignored');
    assert.ok(isIgnored('ignored/subdir/note.md'), 'nested paths should be ignored');
  });

  it('does not ignore non-matching paths', () => {
    process.env.OBSIDIAN_IGNORE_PATTERNS = 'ignored/**';
    assert.ok(!isIgnored('zettelkasten-deep.md'), 'normal note should not be ignored');
    assert.ok(!isIgnored('notes/pkm/note.md'), 'different folder should not be ignored');
  });

  it('matches extension pattern', () => {
    process.env.OBSIDIAN_IGNORE_PATTERNS = '*.canvas';
    assert.ok(isIgnored('diagram.canvas'), '.canvas file should be ignored');
    assert.ok(!isIgnored('note.md'), '.md file should not be ignored');
  });

  it('matches exact path', () => {
    process.env.OBSIDIAN_IGNORE_PATTERNS = 'templates/**,.obsidian/**';
    assert.ok(isIgnored('templates/daily.md'), 'templates path ignored');
    assert.ok(isIgnored('.obsidian/config.json'), '.obsidian path ignored');
    assert.ok(!isIgnored('notes/daily.md'), 'notes path not ignored');
  });
});

// ─── getPathsToRemoveForIgnoreChange ─────────────────────────────────────────

describe('getPathsToRemoveForIgnoreChange', () => {
  const fakeEmb = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const noteBase = {
    tags: [] as string[],
    content: 'test content',
    mtime: Date.now(),
    chunks: [{ text: 'test', embedding: fakeEmb }],
  };

  it('returns only paths matching new ignore patterns', () => {
    process.env.OBSIDIAN_IGNORE_PATTERNS = '';
    getPathsToRemoveForIgnoreChange([]);

    initVecTable(4);
    upsertNote({ ...noteBase, path: 'notes/keep-me.md', title: 'Keep', hash: 'h1' });
    upsertNote({ ...noteBase, path: 'templates/daily.md', title: 'Template', hash: 'h2' });
    upsertNote({ ...noteBase, path: 'drafts/wip.md', title: 'Draft', hash: 'h3' });

    process.env.OBSIDIAN_IGNORE_PATTERNS = 'templates/**,drafts/**';
    const toRemove = getPathsToRemoveForIgnoreChange(['templates/**', 'drafts/**']);

    assert.ok(toRemove.includes('drafts/wip.md'), 'drafts/wip.md should be removed');
    assert.ok(toRemove.includes('templates/daily.md'), 'templates/daily.md should be removed');
    assert.ok(!toRemove.includes('notes/keep-me.md'), 'notes/keep-me.md should not be removed');
  });
});

// ─── checkModelChanged ───────────────────────────────────────────────────────

describe('checkModelChanged', () => {
  it('returns false when model unchanged', () => {
    checkModelChanged('test-model-x');
    assert.equal(checkModelChanged('test-model-x'), false, 'same model should return false');
  });

  it('returns true and wipes notes when model changes', () => {
    // Set to model-A (may wipe DB if previous model differs)
    checkModelChanged('test-model-a');
    // Re-init vec table since checkModelChanged may have wiped it
    initVecTable(4);
    upsertNote({
      path: 'model-test.md',
      title: 'Model Test',
      tags: [],
      content: 'model test content',
      mtime: Date.now(),
      hash: 'mt',
      chunks: [{ text: 'model test content', embedding: fakeEmbedding }],
    });
    const before = searchBm25('model test', 10);
    assert.ok(
      before.some((r) => r.path === 'model-test.md'),
      'note should exist before model change',
    );

    const changed = checkModelChanged('test-model-b');
    assert.equal(changed, true, 'different model should return true');

    const after = searchBm25('model test', 10);
    assert.ok(
      !after.some((r) => r.path === 'model-test.md'),
      'notes should be wiped after model change',
    );
  });
});

// ─── NFD path storage ────────────────────────────────────────────────────────

describe('NFD path storage', () => {
  const nfdPath = 'notes/caf\u00e9-note.md'.normalize('NFD');

  beforeAll(() => {
    // Vec table was wiped by model change above — recreate
    initVecTable(4);
    upsertNote({
      path: nfdPath,
      title: 'Café Note',
      tags: [],
      content: 'A note about café culture',
      mtime: Date.now(),
      hash: 'nfd1',
      chunks: [{ text: 'café culture', embedding: fakeEmbedding }],
    });
    upsertLinks('linker2.md', [nfdPath]);
  });

  it('stores and retrieves NFD paths via links', () => {
    const { links } = getLinksForPaths(['linker2.md']);
    const l = links.get('linker2.md') ?? [];
    assert.ok(l.includes(nfdPath), 'NFD path should be stored and retrievable via links');
  });

  it('BM25 search finds notes with NFD paths', () => {
    const results = searchBm25('café', 10);
    assert.ok(
      results.some((r) => r.path === nfdPath),
      'BM25 should find notes with NFD paths',
    );
  });
});

// ─── tag filter ──────────────────────────────────────────────────────────────

describe('tag filter', () => {
  beforeAll(() => {
    initVecTable(4);
    upsertNote({
      path: 'tagged-pkm.md',
      title: 'PKM Note',
      tags: ['pkm', 'method'],
      content: 'personal knowledge management',
      mtime: Date.now(),
      hash: 'tg1',
      chunks: [{ text: 'personal knowledge management', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'tagged-dev.md',
      title: 'Dev Note',
      tags: ['dev', 'code'],
      content: 'personal knowledge management software development',
      mtime: Date.now(),
      hash: 'tg2',
      chunks: [{ text: 'software development', embedding: fakeEmbedding }],
    });
  });

  it('BM25 finds notes with relevant content', () => {
    const results = searchBm25('knowledge management', 10);
    assert.ok(results.length >= 2, 'should find both tagged notes');
  });
});

// ─── aliases ─────────────────────────────────────────────────────────────────

describe('aliases', () => {
  it('upsertNote stores aliases', () => {
    upsertNote({
      path: 'aliased.md',
      title: 'Main Title',
      tags: [],
      aliases: ['Short Name', 'Alt Title'],
      content: 'note with aliases',
      mtime: Date.now(),
      hash: 'al1',
      chunks: [{ text: 'note with aliases', embedding: fakeEmbedding }],
    });
    const note = getNoteByPath('aliased.md');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument
    const aliases = JSON.parse((note as any).aliases ?? '[]') as string[];
    assert.deepEqual(aliases, ['Short Name', 'Alt Title']);
  });

  it('maintains normalized alias lookup rows for exact search', () => {
    upsertNote({
      path: 'alias-lookup.md',
      title: 'Alias Lookup',
      tags: [],
      aliases: ['ЗК', 'Alt Name'],
      content: 'lookup test',
      mtime: Date.now(),
      hash: 'alias-lookup-v1',
      chunks: [{ text: 'lookup test', embedding: fakeEmbedding }],
    });

    let rows = getDb()
      .prepare(
        'SELECT alias, alias_norm FROM note_aliases WHERE note_id = (SELECT id FROM notes WHERE path = ?)',
      )
      .all('alias-lookup.md') as Array<{ alias: string; alias_norm: string }>;
    rows = rows.sort((a, b) => a.alias.localeCompare(b.alias));

    assert.deepEqual(rows, [
      { alias: 'Alt Name', alias_norm: 'alt name' },
      { alias: 'ЗК', alias_norm: 'зк' },
    ]);

    upsertNote({
      path: 'alias-lookup.md',
      title: 'Alias Lookup',
      tags: [],
      aliases: ['Updated Alias'],
      content: 'lookup test updated',
      mtime: Date.now(),
      hash: 'alias-lookup-v2',
      chunks: [{ text: 'lookup test updated', embedding: fakeEmbedding }],
    });

    const updatedRows = getDb()
      .prepare(
        'SELECT alias, alias_norm FROM note_aliases WHERE note_id = (SELECT id FROM notes WHERE path = ?)',
      )
      .all('alias-lookup.md') as Array<{ alias: string; alias_norm: string }>;

    assert.deepEqual(updatedRows, [{ alias: 'Updated Alias', alias_norm: 'updated alias' }]);
  });
});

// ─── indexFile error handling ─────────────────────────────────────────────────

describe('indexFile error handling', () => {
  it('error result includes actual error message', async () => {
    const { indexFile } = await import('../src/indexer.js');
    const status = await indexFile('/nonexistent/path/note.md', 512);
    assert.ok(typeof status === 'object', 'error should be an object');
    assert.ok('error' in status, 'error object should have error property');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    assert.ok((status as any).error.length > 0, 'error message should not be empty');
  });
});

// ─── frontmatter-only notes ───────────────────────────────────────────────────

describe('frontmatter-only note indexing', () => {
  it('indexes notes with no body content so tag/frontmatter filters can find them', async () => {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { indexFile } = await import('../src/indexer.js');

    // Write a note with only frontmatter and no body
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH!;
    mkdirSync(`${vaultPath}/sources`, { recursive: true });
    const notePath = `${vaultPath}/sources/frontmatter-only.md`;
    writeFileSync(
      notePath,
      `---\ntags:\n  - source\n  - category/test\nstatus: active\ntitle: Frontmatter Only Note\n---\n`,
    );

    const result = await indexFile(notePath, 512);
    assert.equal(result, 'indexed', 'frontmatter-only note should be indexed, not skipped');

    const note = getNoteByPath('sources/frontmatter-only.md'.normalize('NFD'));
    assert.ok(note, 'note should be in DB after indexing');
    assert.equal(note.title, 'Frontmatter Only Note');
  });
});

// ─── event_log ───────────────────────────────────────────────────────────────

describe('event_log', () => {
  const fakeEmb = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const noteBase = {
    tags: [] as string[],
    content: 'test content',
    mtime: Date.now(),
    hash: 'h-evt',
    chunks: [{ text: 'test', embedding: fakeEmb }],
  };

  it('upsertNote new note logs "added"', () => {
    upsertNote({ ...noteBase, path: 'evt-add.md', title: 'Evt Add' });
    const { recentActivity } = getStats();
    assert.strictEqual(recentActivity[0]?.action, 'added');
    assert.strictEqual(recentActivity[0]?.path, 'evt-add.md');
  });

  it('upsertNote existing note logs "updated"', () => {
    upsertNote({ ...noteBase, path: 'evt-update.md', title: 'Evt Update', hash: 'h-upd-1' });
    upsertNote({ ...noteBase, path: 'evt-update.md', title: 'Evt Update 2', hash: 'h-upd-2' });
    const { recentActivity } = getStats();
    assert.strictEqual(recentActivity[0]?.action, 'updated');
    assert.strictEqual(recentActivity[0]?.path, 'evt-update.md');
  });

  it('deleteNote logs "deleted"', () => {
    upsertNote({ ...noteBase, path: 'evt-del.md', title: 'Evt Del' });
    deleteNote('evt-del.md');
    const { recentActivity } = getStats();
    assert.strictEqual(recentActivity[0]?.action, 'deleted');
    assert.strictEqual(recentActivity[0]?.path, 'evt-del.md');
  });

  it('event_log never exceeds 15 entries', () => {
    for (let i = 0; i < 20; i++) {
      upsertNote({
        ...noteBase,
        path: `evt-flood-${i}.md`,
        title: `Flood ${i}`,
        hash: `h-f${i}`,
      });
    }
    const { recentActivity } = getStats();
    assert.ok(recentActivity.length <= 15, `expected ≤15 entries, got ${recentActivity.length}`);
  });

  it('recentActivity entries have action, path, timestamp fields', () => {
    upsertNote({ ...noteBase, path: 'evt-shape.md', title: 'Evt Shape', hash: 'h-shape' });
    const { recentActivity } = getStats();
    const entry = recentActivity[0]!;
    assert.ok(typeof entry.action === 'string', 'action must be string');
    assert.ok(typeof entry.path === 'string', 'path must be string');
    assert.ok(typeof entry.timestamp === 'string', 'timestamp must be string');
    assert.ok(entry.timestamp.includes('T'), 'timestamp should be ISO 8601');
  });
});

// ─── applyDbConfigDefaults ───────────────────────────────────────────────────

describe('applyDbConfigDefaults', () => {
  const OPENAI_DEFAULT = 'https://api.openai.com/v1';
  const OLLAMA_URL = 'http://localhost:11434/v1';

  function withCleanEnv(fn: () => void) {
    const saved = {
      base: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_EMBEDDING_MODEL,
    };
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_EMBEDDING_MODEL;
    try {
      fn();
    } finally {
      if (saved.base !== undefined) process.env.OPENAI_BASE_URL = saved.base;
      else delete process.env.OPENAI_BASE_URL;
      if (saved.model !== undefined) process.env.OPENAI_EMBEDDING_MODEL = saved.model;
      else delete process.env.OPENAI_EMBEDDING_MODEL;
    }
  }

  it('sets OPENAI_BASE_URL from DB when env var is absent and stored URL is non-default', () => {
    withCleanEnv(() => {
      saveConfigMeta({ vaultPath: vaultDir, apiBaseUrl: OLLAMA_URL, apiModel: 'nomic-embed-text' });
      applyDbConfigDefaults();
      assert.equal(process.env.OPENAI_BASE_URL, OLLAMA_URL);
    });
  });

  it('does not override OPENAI_BASE_URL when env var is already set', () => {
    withCleanEnv(() => {
      process.env.OPENAI_BASE_URL = 'http://other:11434/v1'; // eslint-disable-line sonarjs/no-clear-text-protocols
      saveConfigMeta({ vaultPath: vaultDir, apiBaseUrl: OLLAMA_URL, apiModel: 'nomic-embed-text' });
      applyDbConfigDefaults();
      assert.equal(process.env.OPENAI_BASE_URL, 'http://other:11434/v1'); // eslint-disable-line sonarjs/no-clear-text-protocols
    });
  });

  it('does not set OPENAI_BASE_URL when stored URL is the OpenAI default', () => {
    withCleanEnv(() => {
      saveConfigMeta({
        vaultPath: vaultDir,
        apiBaseUrl: OPENAI_DEFAULT,
        apiModel: 'text-embedding-3-small',
      });
      applyDbConfigDefaults();
      assert.equal(process.env.OPENAI_BASE_URL, undefined);
    });
  });

  it('sets OPENAI_EMBEDDING_MODEL from DB when env var is absent', () => {
    withCleanEnv(() => {
      saveConfigMeta({ vaultPath: vaultDir, apiBaseUrl: OLLAMA_URL, apiModel: 'nomic-embed-text' });
      applyDbConfigDefaults();
      assert.equal(process.env.OPENAI_EMBEDDING_MODEL, 'nomic-embed-text');
    });
  });

  it('does not override OPENAI_EMBEDDING_MODEL when env var is already set', () => {
    withCleanEnv(() => {
      process.env.OPENAI_EMBEDDING_MODEL = 'my-custom-model';
      saveConfigMeta({ vaultPath: vaultDir, apiBaseUrl: OLLAMA_URL, apiModel: 'nomic-embed-text' });
      applyDbConfigDefaults();
      assert.equal(process.env.OPENAI_EMBEDDING_MODEL, 'my-custom-model');
    });
  });
});
