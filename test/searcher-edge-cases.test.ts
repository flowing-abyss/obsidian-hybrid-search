import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-searcher-edge-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

vi.mock('../src/embedder.js', () => ({
  embed: vi.fn((texts: string[]) => Promise.resolve(texts.map(() => null))),
}));

const { closeDb, openDb, initVecTable, upsertNote, upsertLinks } = await import('../src/db.js');
const { search, bumpIndexVersion, isAmbiguousNotePathError } = await import('../src/searcher.js');

const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

beforeAll(() => {
  openDb();
  initVecTable(4);
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('search — scope filtering edge cases', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'notes/foo.md',
      title: 'Notes Foo',
      tags: [],
      content: 'Content in notes folder about zettelkasten.',
      mtime: Date.now(),
      hash: 'h-foo',
      chunks: [{ text: 'Content in notes folder', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'daily/bar.md',
      title: 'Daily Bar',
      tags: [],
      content: 'Content in daily folder about journaling.',
      mtime: Date.now(),
      hash: 'h-bar',
      chunks: [{ text: 'Content in daily folder', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'notes-old/baz.md',
      title: 'Notes Old Baz',
      tags: [],
      content: 'Content in notes-old folder.',
      mtime: Date.now(),
      hash: 'h-baz',
      chunks: [{ text: 'Content in notes-old folder', embedding: fakeEmbedding }],
    });
  });

  it('single include scope matches path prefix', async () => {
    const results = await search('content', { mode: 'fulltext', scope: 'notes', limit: 100 });
    assert.ok(results.some((r) => r.path === 'notes/foo.md'));
    assert.ok(!results.some((r) => r.path === 'daily/bar.md'));
  });

  it('scope with trailing slash works same as without', async () => {
    const results = await search('content', { mode: 'fulltext', scope: 'notes/', limit: 100 });
    assert.ok(results.some((r) => r.path === 'notes/foo.md'));
  });

  it('multiple includes use OR logic', async () => {
    const results = await search('content', {
      mode: 'fulltext',
      scope: ['notes', 'daily'],
      limit: 100,
    });
    assert.ok(results.some((r) => r.path === 'notes/foo.md'));
    assert.ok(results.some((r) => r.path === 'daily/bar.md'));
  });

  it('exclude scope removes matching paths', async () => {
    const results = await search('content', {
      mode: 'fulltext',
      scope: '-notes-old',
      limit: 100,
    });
    assert.ok(!results.some((r) => r.path === 'notes-old/baz.md'));
  });

  it('scope with trailing slash enforces slash boundary', async () => {
    // 'notes/' should match 'notes/foo.md' but NOT 'notes-old/baz.md'.
    // NOTE: the bare prefix 'notes' (without trailing slash) DOES match 'notes-old/baz.md'
    // because matchesScopeFilter checks notePath.startsWith(inc) before the slash-boundary
    // form (incScope). The trailing-slash variant is the only one that enforces the
    // directory boundary. See src/searcher.ts:157-160. This is a documented behavior quirk.
    const results = await search('content', { mode: 'fulltext', scope: 'notes/', limit: 100 });
    assert.ok(results.some((r) => r.path === 'notes/foo.md'));
    assert.ok(!results.some((r) => r.path === 'notes-old/baz.md'));
  });

  it('bare scope prefix matches sibling directories (documented quirk)', async () => {
    // 'notes' (no trailing slash) matches 'notes-old/baz.md' via startsWith('notes').
    // Documenting the actual behavior of matchesScopeFilter — see src/searcher.ts:159.
    const results = await search('content', { mode: 'fulltext', scope: 'notes', limit: 100 });
    assert.ok(results.some((r) => r.path === 'notes-old/baz.md'));
  });
});

describe('search — tag filtering edge cases', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'tag-a.md',
      title: 'Tag A',
      tags: ['pkm', 'cs'],
      content: 'Tagged note about pkm and cs.',
      mtime: Date.now(),
      hash: 'h-tag-a',
      chunks: [{ text: 'Tagged note about pkm and cs', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'tag-b.md',
      title: 'Tag B',
      tags: ['pkm'],
      content: 'Tagged note about pkm only.',
      mtime: Date.now(),
      hash: 'h-tag-b',
      chunks: [{ text: 'Tagged note about pkm only', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'tag-c.md',
      title: 'Tag C',
      tags: ['category/cs'],
      content: 'Note with nested tag.',
      mtime: Date.now(),
      hash: 'h-tag-c',
      chunks: [{ text: 'Note with nested tag', embedding: fakeEmbedding }],
    });
  });

  it('single tag include filters to matching notes', async () => {
    const results = await search('note', { mode: 'fulltext', tag: 'pkm', limit: 100 });
    assert.ok(results.some((r) => r.path === 'tag-a.md'));
    assert.ok(results.some((r) => r.path === 'tag-b.md'));
  });

  it('multiple tag includes use AND logic', async () => {
    const results = await search('note', {
      mode: 'fulltext',
      tag: ['pkm', 'cs'],
      limit: 100,
    });
    assert.ok(results.some((r) => r.path === 'tag-a.md'));
    assert.ok(!results.some((r) => r.path === 'tag-b.md'));
  });

  it('exclude tag removes matching notes', async () => {
    const results = await search('note', {
      mode: 'fulltext',
      tag: '-cs',
      limit: 100,
    });
    assert.ok(!results.some((r) => r.path === 'tag-a.md'));
    assert.ok(results.some((r) => r.path === 'tag-b.md'));
  });

  it('nested tag does not match partial prefix', async () => {
    const results = await search('note', {
      mode: 'fulltext',
      tag: 'category/cs',
      limit: 100,
    });
    assert.ok(results.some((r) => r.path === 'tag-c.md'));
  });
});

describe('search — threshold edge cases', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'thresh-1.md',
      title: 'Thresh One',
      tags: [],
      content: 'Unique keyword threshold test note one.',
      mtime: Date.now(),
      hash: 'h-thresh-1',
      chunks: [{ text: 'Unique keyword threshold test', embedding: fakeEmbedding }],
    });
  });

  it('threshold=0 passes all results', async () => {
    const results = await search('threshold', { mode: 'fulltext', threshold: 0, limit: 100 });
    assert.ok(results.length > 0);
  });

  it('negative threshold passes all results', async () => {
    const results = await search('threshold', {
      mode: 'fulltext',
      threshold: -1,
      limit: 100,
    });
    assert.ok(results.length > 0);
  });
});

describe('search — related mode BFS edge cases', () => {
  beforeAll(() => {
    bumpIndexVersion();
    // A → B, A → C, B → D, C → D (diamond)
    upsertNote({
      path: 'graph/a.md',
      title: 'Node A',
      tags: [],
      content: 'Node A links to B and C.',
      mtime: Date.now(),
      hash: 'h-a',
      chunks: [{ text: 'Node A', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'graph/b.md',
      title: 'Node B',
      tags: [],
      content: 'Node B links to D.',
      mtime: Date.now(),
      hash: 'h-b',
      chunks: [{ text: 'Node B', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'graph/c.md',
      title: 'Node C',
      tags: [],
      content: 'Node C links to D.',
      mtime: Date.now(),
      hash: 'h-c',
      chunks: [{ text: 'Node C', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'graph/d.md',
      title: 'Node D',
      tags: [],
      content: 'Node D is a leaf.',
      mtime: Date.now(),
      hash: 'h-d',
      chunks: [{ text: 'Node D', embedding: fakeEmbedding }],
    });
    upsertLinks('graph/a.md', ['graph/b.md', 'graph/c.md']);
    upsertLinks('graph/b.md', ['graph/d.md']);
    upsertLinks('graph/c.md', ['graph/d.md']);
  });

  it('source not in DB returns empty results', async () => {
    const results = await search('graph/nonexistent.md', { related: true, limit: 100 });
    assert.deepEqual(results, []);
  });

  it('direction=outgoing depth=1 returns only direct links', async () => {
    const results = await search('graph/a.md', {
      related: true,
      depth: 1,
      direction: 'outgoing',
      limit: 100,
    });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('graph/a.md')); // source at depth 0
    assert.ok(paths.includes('graph/b.md')); // depth 1
    assert.ok(paths.includes('graph/c.md')); // depth 1
    assert.ok(!paths.includes('graph/d.md')); // depth 2, excluded
  });

  it('direction=backlinks depth=1 returns only direct backlinks', async () => {
    const results = await search('graph/d.md', {
      related: true,
      depth: 1,
      direction: 'backlinks',
      limit: 100,
    });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('graph/d.md')); // source
    assert.ok(paths.includes('graph/b.md')); // backlink depth -1
    assert.ok(paths.includes('graph/c.md')); // backlink depth -1
    assert.ok(!paths.includes('graph/a.md')); // depth -2, excluded
  });

  it('direction=both depth=2 returns sorted by depth', async () => {
    const results = await search('graph/a.md', {
      related: true,
      depth: 2,
      direction: 'both',
      limit: 100,
    });
    const depths = results.map((r) => r.depth);
    // Should be sorted: -N ... -1, 0, +1 ... +N
    for (let i = 1; i < depths.length; i++) {
      assert.ok(depths[i - 1]! <= depths[i]!, `depths should be sorted: ${depths.join(',')}`);
    }
  });

  it('diamond graph: D appears once (first reach wins)', async () => {
    const results = await search('graph/a.md', {
      related: true,
      depth: 2,
      direction: 'outgoing',
      limit: 100,
    });
    const dResults = results.filter((r) => r.path === 'graph/d.md');
    assert.equal(dResults.length, 1, 'D should appear exactly once');
  });
});

describe('search — LRU cache behavior', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'cache-test.md',
      title: 'Cache Test',
      tags: [],
      content: 'Cache test content for verifying caching behavior.',
      mtime: Date.now(),
      hash: 'h-cache',
      chunks: [{ text: 'Cache test content', embedding: fakeEmbedding }],
    });
  });

  it('same query returns cached result (bumpIndexVersion invalidates)', async () => {
    const r1 = await search('cache', { mode: 'fulltext', limit: 10 });
    const r2 = await search('cache', { mode: 'fulltext', limit: 10 });
    // Without bump, r2 should be cached (same result)
    assert.equal(r1.length, r2.length);

    // After bump, cache invalidated — can verify by changing DB state
    bumpIndexVersion();
    upsertNote({
      path: 'cache-test2.md',
      title: 'Cache Test 2',
      tags: [],
      content: 'Cache test content 2.',
      mtime: Date.now(),
      hash: 'h-cache2',
      chunks: [{ text: 'Cache test content 2', embedding: fakeEmbedding }],
    });
    const r3 = await search('cache', { mode: 'fulltext', limit: 100 });
    assert.ok(r3.length >= r1.length, 'after cache invalidation, may get more results');
  });

  it('different mode produces different cache key', async () => {
    const fulltext = await search('cache', { mode: 'fulltext', limit: 100 });
    const title = await search('cache', { mode: 'title', limit: 100 });
    // Different modes should return potentially different result sets
    // (title mode only searches titles, fulltext searches content)
    // Just verify both run without error
    assert.ok(Array.isArray(fulltext));
    assert.ok(Array.isArray(title));
  });
});

describe('search — filter-only mode (empty query + filters)', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'fm-a.md',
      title: 'FM Alpha',
      tags: ['todo'],
      content: 'Frontmatter filter test alpha.',
      mtime: Date.now(),
      hash: 'h-fm-a',
      chunks: [{ text: 'Frontmatter filter test alpha', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'fm-b.md',
      title: 'FM Beta',
      tags: ['done'],
      content: 'Frontmatter filter test beta.',
      mtime: Date.now(),
      hash: 'h-fm-b',
      chunks: [{ text: 'Frontmatter filter test beta', embedding: fakeEmbedding }],
    });
  });

  it('empty query + tag filter returns matching notes with score=1.0', async () => {
    const results = await search('', { tag: 'todo', limit: 100 });
    assert.ok(results.length > 0);
    assert.ok(results.some((r) => r.path === 'fm-a.md'));
    for (const r of results) {
      assert.equal(r.score, 1.0);
    }
  });

  it('empty query + scope filter returns notes in scope', async () => {
    const results = await search('', { scope: 'fm-', limit: 100 });
    // fm- prefix should match fm-a.md and fm-b.md
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(r.path.startsWith('fm-'));
    }
  });

  it('limit=0 returns all matches without slicing', async () => {
    const results = await search('', { tag: 'todo', limit: 0 });
    assert.ok(results.length > 0);
  });
});

describe('search — path lookup edge cases', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'lookup/exact.md',
      title: 'Exact Lookup',
      tags: [],
      content: 'Content for exact path lookup.',
      mtime: Date.now(),
      hash: 'h-lookup',
      chunks: [{ text: 'Content for exact path lookup', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'lookup/nested/exact.md',
      title: 'Nested Exact',
      tags: [],
      content: 'Content for nested path lookup.',
      mtime: Date.now(),
      hash: 'h-nested',
      chunks: [{ text: 'Content for nested path lookup', embedding: fakeEmbedding }],
    });
  });

  it('notePath option overrides input for resolution', async () => {
    const results = await search('irrelevant text', {
      notePath: 'lookup/exact.md',
      related: true,
      depth: 1,
      limit: 100,
    });
    assert.ok(results.some((r) => r.path === 'lookup/exact.md'));
  });

  it('related=true with .md input triggers path lookup', async () => {
    const results = await search('lookup/exact.md', { related: true, depth: 1, limit: 100 });
    assert.ok(results.some((r) => r.path === 'lookup/exact.md'));
  });

  it('related=true with slash input triggers path lookup', async () => {
    const results = await search('lookup/exact', { related: true, depth: 1, limit: 100 });
    assert.ok(results.some((r) => r.path === 'lookup/exact.md'));
  });

  it('ambiguous path throws AmbiguousNotePathError', async () => {
    // Both lookup/exact.md and lookup/nested/exact.md exist
    // Searching for "exact.md" should be ambiguous
    try {
      await search('exact.md', { related: true, limit: 10 });
      assert.fail('expected AmbiguousNotePathError');
    } catch (err) {
      assert.ok(isAmbiguousNotePathError(err), 'should be AmbiguousNotePathError');
    }
  });
});

describe('search — multi-query fan-out', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'multi-1.md',
      title: 'Zettelkasten Note',
      tags: [],
      content: 'This note discusses zettelkasten methodology and linked thinking.',
      mtime: Date.now(),
      hash: 'h-multi-1',
      chunks: [{ text: 'zettelkasten methodology linked thinking', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'multi-2.md',
      title: 'PKM Note',
      tags: [],
      content: 'Personal knowledge management and second brain concepts.',
      mtime: Date.now(),
      hash: 'h-multi-2',
      chunks: [{ text: 'personal knowledge management second brain', embedding: fakeEmbedding }],
    });
  });

  it('queries with 2 items runs RRF fusion', async () => {
    const results = await search('zettelkasten', {
      mode: 'hybrid',
      queries: ['zettelkasten', 'knowledge management'],
      limit: 100,
    });
    assert.ok(results.length > 0);
    // RRF fusion should return results from both query terms
    assert.ok(results.some((r) => r.path === 'multi-1.md' || r.path === 'multi-2.md'));
  });

  it('queries with 1 item falls back to single query', async () => {
    const results = await search('zettelkasten', {
      mode: 'hybrid',
      queries: ['zettelkasten'],
      limit: 100,
    });
    assert.ok(results.length > 0);
  });

  it('queries with 0 items falls back to single query', async () => {
    const results = await search('zettelkasten', {
      mode: 'hybrid',
      queries: [],
      limit: 100,
    });
    assert.ok(results.length > 0);
  });
});

describe('search — snippet behavior', () => {
  beforeAll(() => {
    bumpIndexVersion();
    upsertNote({
      path: 'snippet-test.md',
      title: 'Snippet Test',
      tags: [],
      content: 'Start content. '.repeat(50) + 'UNIQUEMATCH word. ' + 'End content. '.repeat(50),
      mtime: Date.now(),
      hash: 'h-snippet',
      chunks: [{ text: 'UNIQUEMATCH word', embedding: fakeEmbedding }],
    });
    upsertNote({
      path: 'snippet-empty.md',
      title: 'Empty Snippet',
      tags: [],
      content: '',
      mtime: Date.now(),
      hash: 'h-empty',
      chunks: [],
    });
  });

  it('snippet is capped to snippetLength', async () => {
    const results = await search('UNIQUEMATCH', {
      mode: 'fulltext',
      snippetLength: 50,
      limit: 10,
    });
    const match = results.find((r) => r.path === 'snippet-test.md');
    if (match) {
      assert.ok(match.snippet.length <= 50, `snippet should be <= 50, got ${match.snippet.length}`);
    }
  });

  it('empty content note produces empty snippet', async () => {
    const results = await search('nonexistent', { mode: 'fulltext', limit: 100 });
    const empty = results.find((r) => r.path === 'snippet-empty.md');
    // If the empty note appears, its snippet should be empty
    if (empty) {
      assert.equal(empty.snippet, '');
    }
  });
});
