import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-request-isolation-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

vi.mock('../src/inference/embedder.js', () => ({
  activeModelName: () => 'fixture-model',
  embed: vi.fn((texts: string[]) => Promise.resolve(texts.map(() => null))),
}));
vi.resetModules();

const {
  closeDb,
  openDb,
  initVecTable,
  initializeChunkPolicy,
  upsertNote,
  upsertLinks,
  withTestIndexLease,
} = await import('./helpers/owned-storage.js');
const { search } = await import('../src/search/searcher.js');
const { embed } = await import('../src/inference/embedder.js');
const { createGraphReader } = await import('../src/storage/search-queries.js');

beforeAll(() => {
  const db = openDb();
  initVecTable(4);
  // The matching note sorts after the old 10,000-row pre-filter ceiling.
  withTestIndexLease((lease) => {
    initializeChunkPolicy(lease, { chunkTokens: 512, contextLength: 512 });
    db.transaction(() => {
      const insert = db.prepare(
        'INSERT INTO notes (path, title, tags, content, mtime, hash) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (let i = 0; i < 10_001; i++) {
        insert.run(`bulk/${i}.md`, `A filler ${i}`, '[]', 'filler', 1, String(i));
      }
      db.prepare(
        "INSERT INTO note_frontmatter_fields (note_id, field, value, value_norm) SELECT id, 'status', 'open', 'open' FROM notes",
      ).run();
    })();
  });
  for (const note of [
    { path: 'left,right/one.md', tags: ['alpha,beta'], frontmatter: { group: 'one,state:open' } },
    { path: 'left/two.md', tags: ['alpha', 'beta'], frontmatter: { group: 'one', state: 'open' } },
    { path: 'right/three.md', tags: [], frontmatter: {} },
    { path: 'z/needle.md', tags: ['target'], frontmatter: { status: 'open' } },
    { path: 'hub.md', tags: [], frontmatter: {} },
  ]) {
    upsertNote({
      ...note,
      title: `Z ${note.path}`,
      content: 'needle',
      mtime: 1,
      hash: note.path,
      chunks: [],
    });
  }
  upsertLinks('hub.md', ['left,right/one.md', 'left/two.md', 'right/three.md']);
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('search request isolation', () => {
  it('separates literal commas from scope array boundaries in the cache', async () => {
    const literal = await search('needle', { mode: 'fulltext', scope: 'left,right' });
    assert.deepEqual(
      literal.map((r) => r.path),
      ['left,right/one.md'],
    );
    const array = await search('needle', { mode: 'fulltext', scope: ['left', 'right'] });
    assert.deepEqual(
      array.map((r) => r.path).sort((a, b) => a.localeCompare(b)),
      ['left/two.md', 'right/three.md'],
    );
  });

  it('separates literal commas from tag array boundaries in the cache', async () => {
    const literal = await search('needle', { mode: 'fulltext', tag: 'alpha,beta' });
    assert.deepEqual(
      literal.map((r) => r.path),
      ['left,right/one.md'],
    );
    const array = await search('needle', { mode: 'fulltext', tag: ['alpha', 'beta'] });
    assert.ok(array.some((r) => r.path === 'left/two.md'));
  });

  it('separates frontmatter values from multiple predicates in the cache', async () => {
    const literal = await search('', { frontmatter: 'group:one,state:open' });
    assert.deepEqual(
      literal.map((r) => r.path),
      ['left,right/one.md'],
    );
    const array = await search('', { frontmatter: ['group:one', 'state:open'] });
    assert.deepEqual(
      array.map((r) => r.path),
      ['left/two.md'],
    );
  });

  it('separates scope arrays in graph searches too', async () => {
    const literal = await search('hub.md', { related: true, scope: 'left,right' });
    assert.deepEqual(
      literal.map((r) => r.path),
      ['left,right/one.md'],
    );
    const array = await search('hub.md', { related: true, scope: ['left', 'right'] });
    assert.deepEqual(
      array.map((r) => r.path).sort((a, b) => a.localeCompare(b)),
      ['left/two.md', 'right/three.md'],
    );
  });

  it('separates pipe characters from multi-query array boundaries', async () => {
    vi.mocked(embed).mockClear();
    await search('primary', { mode: 'semantic', queries: ['alpha|beta', 'gamma'] });
    await search('primary', { mode: 'semantic', queries: ['alpha', 'beta|gamma'] });
    assert.equal(vi.mocked(embed).mock.calls.length, 4);
  });
});

describe('metadata-only search on large vaults', () => {
  it.each([
    { scope: 'z' },
    { tag: 'target' },
    { frontmatter: 'status:open', scope: 'z', tag: 'target' },
  ])('applies filters before the result ceiling: %j', async (filters) => {
    const results = await search('', { ...filters, limit: 1 });
    assert.deepEqual(
      results.map((r) => r.path),
      ['z/needle.md'],
    );
  });
});

describe('related graph work budgets', () => {
  it('bounds edge materialization and accounts across successive adjacency reads', () => {
    assert.throws(
      () => createGraphReader(2)(['hub.md'], 'wiki', 'outgoing'),
      /exceeds 2 edge rows/,
    );
    const read = createGraphReader(3);
    assert.equal(read(['hub.md'], 'wiki', 'outgoing').get('hub.md')?.length, 3);
    assert.throws(() => read(['left/two.md'], 'wiki', 'backlinks'), /exceeds 3 edge rows/);
    assert.deepEqual(createGraphReader(0)([], 'markdown', 'outgoing'), new Map());
  });

  it('fails clearly before a broad frontier can exceed SQLite parameter limits', async () => {
    upsertLinks(
      'hub.md',
      Array.from({ length: 10_001 }, (_, i) => `bulk/${i}.md`),
    );
    await assert.rejects(
      search('hub.md', { related: true, direction: 'outgoing', snippetLength: 0 }),
      /exceeds 10000 notes/,
    );
  });
});
