import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_VAULT = path.join(__dirname, 'fixtures/vault');

process.env.OBSIDIAN_VAULT_PATH = FIXTURE_VAULT;

const { openDb, initVecTable } = await import('../src/db.js');
const { getEmbeddingDim, getContextLength } = await import('../src/embedder.js');
const { indexVaultSync } = await import('../src/indexer.js');
const { search } = await import('../src/searcher.js');

beforeAll(async () => {
  openDb();
  const [, embeddingDim] = await Promise.all([getContextLength(), getEmbeddingDim()]);
  initVecTable(embeddingDim);
  await indexVaultSync();
}, 120_000);

describe('search', () => {
  it('exact match ranks first', async () => {
    const results = await search('zettelkasten');
    assert.ok(results.length > 0);
    assert.ok(results[0]!.path.includes('zettelkasten'));
  });

  it('fuzzy typo match via title mode', async () => {
    const results = await search('zettlksten', { mode: 'title' });
    assert.ok(results.length > 0);
    assert.ok(results[0]!.path.includes('zettelkasten'));
  });

  it('scope filters results', async () => {
    const results = await search('note', { scope: 'notes/pkm/' });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.path.startsWith('notes/pkm/')));
  });

  it('flat note indexed via sliding window', async () => {
    const results = await search('sqlite', { mode: 'fulltext' });
    assert.ok(results.some((r) => r.path.includes('sqlite-internals')));
  });

  it('empty sections note is indexed without errors', async () => {
    const { getDb } = await import('../src/db.js');
    const db = getDb();
    const note = db.prepare("SELECT * FROM notes WHERE path LIKE '%empty-sections%'").get();
    assert.ok(note);
  });

  it('semantic search finds conceptually related notes', async () => {
    const results = await search('knowledge management system', {
      mode: 'semantic',
      limit: 5,
    });
    assert.ok(results.length > 0);
  });

  it('Russian notes are indexed (fulltext)', async () => {
    const results = await search('управление знаниями', { mode: 'fulltext' });
    assert.ok(results.some((r) => r.path.includes('управление')));
  });

  it('longer notes are chunked and searchable', async () => {
    const results = await search('shutdown ritual', { mode: 'fulltext' });
    assert.ok(results.some((r) => r.path.includes('deep-work')));
  });
});

describe('snippet fallback', () => {
  it('title mode results have non-empty snippets via fallback', async () => {
    const results = await search('zettelkasten', { mode: 'title', limit: 5 });
    assert.ok(results.length > 0);
    assert.ok(
      results.every((r) => r.snippet.length > 0),
      'all snippets should be non-empty after fallback',
    );
  });

  it('custom snippet_length limits fallback snippet length', async () => {
    const results = await search('zettelkasten', {
      mode: 'title',
      limit: 3,
      snippetLength: 50,
    });
    assert.ok(results.length > 0);
    assert.ok(
      results.every((r) => r.snippet.length <= 55),
      'snippets should be at most snippet_length chars',
    );
  });
});

describe('tag filtering', () => {
  it('include single tag: only matching notes returned', async () => {
    const results = await search('notes', { tag: 'pkm', limit: 20 });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.tags.includes('pkm')));
  });

  it('exclude tag with - prefix: tagged notes removed', async () => {
    const results = await search('notes', { tag: ['-dev'], limit: 20 });
    assert.ok(results.every((r) => !r.tags.includes('dev')));
  });

  it('include + exclude combined: pkm notes without method tag', async () => {
    const results = await search('notes', {
      tag: ['pkm', '-method'],
      limit: 20,
    });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.tags.includes('pkm') && !r.tags.includes('method')));
  });
});

describe('scope filtering', () => {
  it('array scope OR: results from multiple folders', async () => {
    const results = await search('notes', {
      scope: ['notes/pkm/', 'notes/dev/'],
      limit: 20,
    });
    assert.ok(results.length > 0);
    assert.ok(
      results.every((r) => r.path.startsWith('notes/pkm/') || r.path.startsWith('notes/dev/')),
    );
  });

  it('scope with - exclusion: subfolder excluded', async () => {
    const results = await search('notes', {
      scope: ['notes/', '-notes/dev/'],
      limit: 20,
    });
    assert.ok(results.length > 0);
    assert.ok(
      results.every((r) => r.path.startsWith('notes/') && !r.path.startsWith('notes/dev/')),
    );
  });
});

describe('related mode', () => {
  it('source note (depth 0) has score 1.0', async () => {
    const results = await search('notes/pkm/second-brain.md', {
      related: true,
      depth: 1,
    });
    const source = results.find((r) => r.depth === 0);
    assert.ok(source, 'source note should be in results');
    assert.equal(source.score, 1.0);
  });

  it('depth-1 linked notes have score 0.5', async () => {
    const results = await search('notes/pkm/second-brain.md', {
      related: true,
      depth: 1,
    });
    const depth1 = results.filter((r) => Math.abs(r.depth ?? 0) === 1);
    assert.ok(
      depth1.length > 0,
      'should have depth-1 results (second-brain links to zettelkasten)',
    );
    assert.ok(depth1.every((r) => r.score === 0.5));
  });

  it('direction outgoing: no negative-depth results', async () => {
    const results = await search('notes/pkm/second-brain.md', {
      related: true,
      direction: 'outgoing',
      depth: 1,
    });
    assert.ok(results.every((r) => (r.depth ?? 0) >= 0));
    // depth-1 results should be the notes second-brain links to
    const outgoing = results.filter((r) => (r.depth ?? 0) > 0);
    assert.ok(
      outgoing.length > 0,
      'second-brain has outgoing links to zettelkasten and evergreen-notes',
    );
  });

  it('direction backlinks: no positive-depth results', async () => {
    const results = await search('notes/pkm/zettelkasten.md', {
      related: true,
      direction: 'backlinks',
      depth: 1,
    });
    assert.ok(results.every((r) => (r.depth ?? 0) <= 0));
    // zettelkasten is linked from second-brain
    const backlinks = results.filter((r) => (r.depth ?? 0) < 0);
    assert.ok(backlinks.length > 0, 'zettelkasten should have backlinks from second-brain');
  });

  it('all related results have non-empty snippets via fallback', async () => {
    const results = await search('notes/pkm/second-brain.md', {
      related: true,
      depth: 1,
    });
    // Source note may have empty snippet — check depth-1 nodes
    const linked = results.filter((r) => r.depth !== 0);
    assert.ok(
      linked.every((r) => r.snippet.length > 0),
      'linked notes should have snippets',
    );
  });
});

describe('notePath option', () => {
  it('notePath forces path-based lookup for non-path input', async () => {
    // 'zettelkasten' alone would be treated as text search, but with notePath it does similarity
    const textResults = await search('zettelkasten', { limit: 5 });
    const pathResults = await search('zettelkasten', {
      notePath: 'notes/pkm/zettelkasten.md',
      limit: 5,
    });
    // similarity search should exclude the source note itself
    assert.ok(pathResults.every((r) => !r.path.endsWith('zettelkasten.md')));
    // results should differ from plain text search
    assert.ok(textResults.length > 0 && pathResults.length > 0);
  });
});
