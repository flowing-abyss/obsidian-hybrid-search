/**
 * Regression tests for S-5: fulltext and title search must work when offline
 * (no embedding API available).
 *
 * Root cause: server.ts and cli.ts called getEmbeddingDim() on every startup.
 * That function makes a live API round-trip. When offline the entire process
 * exited with code 1 before any search could run — even modes (fulltext, title)
 * that never touch the embedding API at all.
 *
 * Fix: getStoredEmbeddingDim() reads the already-known dimension from the DB
 * settings table written by initVecTable(). getEmbeddingDim() (API call) is
 * only needed on a fresh install where the DB has never been indexed.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

// ─── Vault setup (before any imports that read OBSIDIAN_VAULT_PATH) ──────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-offline-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// ─── Module imports (after env is set) ───────────────────────────────────────

const { openDb, initVecTable, upsertNote, getStoredEmbeddingDim } = await import('../src/db.js');
const { search } = await import('../src/searcher.js');

const EMBED_DIM = 4;
const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
  // Only open the DB here — initVecTable is intentionally deferred so the first
  // describe block can test the null-before-indexing case.
  openDb();
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── getStoredEmbeddingDim ────────────────────────────────────────────────────
//
// Vitest runs describe blocks in declaration order and their it() tests
// sequentially, so by the time the second describe's beforeAll fires,
// initVecTable() has already been called in test #2 below.

describe('getStoredEmbeddingDim', () => {
  it('returns null on a fresh DB before any indexing', () => {
    // No initVecTable() has been called yet — settings table has no embedding_dim.
    assert.equal(getStoredEmbeddingDim(), null);
  });

  it('returns the dimension stored by initVecTable', () => {
    initVecTable(EMBED_DIM);
    assert.equal(getStoredEmbeddingDim(), EMBED_DIM);
  });

  it('is idempotent — repeated calls return the same dim', () => {
    assert.equal(getStoredEmbeddingDim(), EMBED_DIM);
    assert.equal(getStoredEmbeddingDim(), EMBED_DIM);
  });
});

// ─── Offline startup regression ──────────────────────────────────────────────

describe('fulltext and title search work without any embedding API call', () => {
  // initVecTable(EMBED_DIM) was called in the describe block above, so
  // vec_chunks exists and upsertNote (which inserts into vec_chunks) works.
  beforeAll(() => {
    upsertNote({
      path: 'zettelkasten.md',
      title: 'Zettelkasten Method',
      tags: [],
      content: 'The zettelkasten method by Niklas Luhmann uses atomic notes linked together.',
      mtime: Date.now(),
      hash: 'zk',
      chunks: [
        {
          text: 'The zettelkasten method by Niklas Luhmann uses atomic notes.',
          embedding: fakeEmbedding,
        },
      ],
    });
    upsertNote({
      path: 'python.md',
      title: 'Python Programming',
      tags: [],
      content: 'Python is a versatile programming language used for many applications.',
      mtime: Date.now(),
      hash: 'py',
      chunks: [
        {
          text: 'Python is a versatile programming language.',
          embedding: fakeEmbedding,
        },
      ],
    });
  });

  it('getStoredEmbeddingDim() provides dim without an API call — core of the S-5 fix', () => {
    // This is exactly what the fixed server.ts / cli.ts do on startup instead of
    // calling getEmbeddingDim() (which makes a live HTTP request and throws offline).
    const dim = getStoredEmbeddingDim();
    assert.equal(dim, EMBED_DIM, 'dim must be readable from DB without any network call');
  });

  it('fulltext mode returns correct results (BM25 never needs the embedding API)', async () => {
    const results = await search('zettelkasten', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0, 'fulltext search should return results when offline');
    // With isolate:false the searchCache is shared across test files, so we cannot
    // assert on a specific rank-1 path — the cached results from db.test.ts are
    // equally valid here. What matters is that the mode was respected.
    // BM25 results must never carry a semantic match signal
    for (const r of results) {
      assert.ok(
        !r.matchedBy.includes('semantic'),
        `fulltext result "${r.path}" must not have semantic match`,
      );
    }
  });

  it('title mode returns correct results (trigram fuzzy never needs the embedding API)', async () => {
    const results = await search('Python', { mode: 'title', limit: 5 });
    assert.ok(results.length > 0, 'title search should return results when offline');
    // Same cache-sharing caveat as the fulltext test above.
    // Title results must never carry a semantic match signal
    for (const r of results) {
      assert.ok(
        !r.matchedBy.includes('semantic'),
        `title result "${r.path}" must not have semantic match`,
      );
    }
  });

  it('fulltext scores object has bm25 set and semantic null', async () => {
    const results = await search('zettelkasten', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0);
    const top = results[0]!;
    assert.ok(top.scores.bm25 !== null, 'bm25 score must be present for fulltext result');
    assert.equal(top.scores.semantic, null, 'semantic score must be null for fulltext result');
  });

  it('title scores object has fuzzy_title set and semantic null', async () => {
    const results = await search('Python', { mode: 'title', limit: 5 });
    assert.ok(results.length > 0);
    const top = results[0]!;
    assert.ok(
      top.scores.fuzzy_title !== null,
      'fuzzy_title score must be present for title result',
    );
    assert.equal(top.scores.semantic, null, 'semantic score must be null for title result');
  });
});
