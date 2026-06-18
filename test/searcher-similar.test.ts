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
