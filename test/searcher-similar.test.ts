import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-searcher-similar-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
vi.resetModules();

const { closeDb, openDb, initVecTable, upsertNote } = await import('../src/db.js');

// Mock embedder before importing searcher so live bindings pick up the mock
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);

const { search } = await import('../src/searcher.js');

beforeAll(() => {
  openDb();
  initVecTable(4);

  // Note with embeddings — target for similarity search
  upsertNote({
    path: 'target.md',
    title: 'Target Note',
    tags: [],
    content: 'This is target content about knowledge management.',
    mtime: Date.now(),
    hash: 'hash-target',
    chunks: [
      {
        text: 'This is target content about knowledge management.',
        embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      },
    ],
  });

  // Note without embeddings (empty chunks) — triggers fallback re-embedding path
  upsertNote({
    path: 'no-embed.md',
    title: 'No Embed Note',
    tags: [],
    content: 'This note has no chunk embeddings.',
    mtime: Date.now(),
    hash: 'hash-no-embed',
    chunks: [],
  });

  // Tagged notes for filter-resolution tests. Deliberately LOW similarity to
  // target.md so they never survive an unfiltered top-N cut — this is what
  // reproduces the defect.
  upsertNote({
    path: 'meta-note.md',
    title: 'Meta Note',
    tags: ['system/meta'],
    content: 'An aggregator note.',
    mtime: Date.now(),
    hash: 'hash-meta',
    chunks: [{ text: 'An aggregator note.', embedding: new Float32Array([0.9, 0.1, 0.0, 0.0]) }],
  });
  for (let i = 0; i < 20; i++) {
    upsertNote({
      path: `filler-${i}.md`,
      title: `Filler ${i}`,
      tags: [],
      content: `Filler content ${i}.`,
      mtime: Date.now(),
      hash: `hash-filler-${i}`,
      chunks: [{ text: `Filler content ${i}.`, embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]) }],
    });
  }
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('searchSimilar fallback', () => {
  it('finds similar notes for a note without stored embeddings', async () => {
    const results = await search('no-embed.md', {
      notePath: 'no-embed.md',
      limit: 5,
    });
    // Should return target.md (excludes self)
    assert.ok(results.length > 0, 'expected at least one similar note');
    assert.ok(
      results.some((r) => r.path === 'target.md'),
      'expected target.md in results',
    );
    // Source note itself should be excluded
    assert.ok(!results.some((r) => r.path === 'no-embed.md'), 'source note should be excluded');
  });
});

describe('path lookup combined with filters', () => {
  it('finds a tagged note that would not survive an unfiltered top-N cut', async () => {
    const results = await search('', {
      notePath: 'target.md',
      tag: 'system/meta',
      limit: 3,
    });
    assert.ok(
      results.some((r) => r.path === 'meta-note.md'),
      'expected meta-note.md — it is the only note with the tag, so the filter must ' +
        'be applied to the candidate pool, not to an already-truncated top-3',
    );
    assert.ok(
      results.every((r) => r.path !== 'target.md'),
      'source note must stay excluded',
    );
  });

  it('returns nothing when the filter matches no note', async () => {
    const results = await search('', {
      notePath: 'target.md',
      tag: 'system/does-not-exist',
      limit: 5,
    });
    assert.equal(results.length, 0);
  });
});

describe('exact scan scoring parity', () => {
  it('agrees with the KNN path on unnormalized vectors', async () => {
    // Same source note, same candidates; one call goes through sqlite-vec KNN,
    // the other through the exact scan. The exclusion filter "-system/absent-tag"
    // matches every note (no note carries that tag), so the two calls must rank
    // the same set identically.
    //
    // Fixture vectors are NOT unit-normalized (norm of [0.1,0.2,0.3,0.4] is ~0.548),
    // so this test fails if the scan computes plain cosine instead of reproducing
    // Math.max(0, 1 - squaredL2 / 2). That is exactly what it is here to catch.
    const viaKnn = await search('', { notePath: 'target.md', limit: 50 });
    const viaScan = await search('', {
      notePath: 'target.md',
      tag: '-system/absent-tag',
      limit: 50,
    });

    const knnScores = new Map(viaKnn.map((r) => [r.path, r.score]));
    let compared = 0;
    for (const r of viaScan) {
      const expected = knnScores.get(r.path);
      if (expected === undefined) continue;
      compared++;
      assert.ok(
        Math.abs(r.score - expected) < 1e-5,
        `score mismatch for ${r.path}: scan ${r.score} vs knn ${expected}`,
      );
    }
    assert.ok(compared > 0, 'expected overlapping notes between the two paths');
  });
});
