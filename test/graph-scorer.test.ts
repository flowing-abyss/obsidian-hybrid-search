import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-graph-scorer-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { closeDb, initVecTable, openDb, upsertLinks, upsertNote } = await import('../src/db.js');
const { scoreGraphLinks } = await import('../src/graph-scorer.js');

const fakeEmbedding = new Float32Array([0.5, 0.5, 0.5, 0.5]);

beforeAll(() => {
  openDb();
  initVecTable(4);
});

beforeEach(() => {
  const notes = [
    'seed-a.md',
    'seed-b.md',
    'out-a.md',
    'back-a.md',
    'hub.md',
    'specific.md',
    'extra-1.md',
    'extra-2.md',
    'extra-3.md',
  ];
  for (const notePath of notes) {
    upsertNote({
      path: notePath,
      title: notePath,
      tags: [],
      content: `Content for ${notePath}`,
      mtime: Date.now(),
      hash: `hash-${notePath}-${Date.now()}`,
      chunks: [{ text: `Content for ${notePath}`, embedding: fakeEmbedding }],
    });
    upsertLinks(notePath, []);
  }
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

const options = {
  seedLimit: 5,
  resultLimit: 20,
  direction: 'both' as const,
  maxNeighborsPerSeed: 8,
  outgoingWeight: 1.0,
  backlinkWeight: 0.7,
  degreePenalty: true,
};

describe('scoreGraphLinks', () => {
  it('scores outgoing and backlink neighbors from ranked seeds', () => {
    upsertLinks('seed-a.md', ['out-a.md']);
    upsertLinks('back-a.md', ['seed-a.md']);

    const results = scoreGraphLinks(
      [{ path: 'seed-a.md', rank: 0, score: 1, signals: ['bm25'] }],
      options,
    );

    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('out-a.md'), 'outgoing neighbor should be scored');
    assert.ok(paths.includes('back-a.md'), 'backlink neighbor should be scored');
    assert.ok(!paths.includes('seed-a.md'), 'self seed should not score itself');
    assert.ok(
      results.find((r) => r.path === 'out-a.md')!.score >
        results.find((r) => r.path === 'back-a.md')!.score,
      'outgoing should initially outweigh backlink',
    );
  });

  it('uses seed rank decay and accumulates evidence from multiple seeds', () => {
    upsertLinks('seed-a.md', ['specific.md']);
    upsertLinks('seed-b.md', ['specific.md', 'out-a.md']);

    const results = scoreGraphLinks(
      [
        { path: 'seed-a.md', rank: 0, score: 1, signals: ['bm25'] },
        { path: 'seed-b.md', rank: 1, score: 0.8, signals: ['semantic'] },
      ],
      options,
    );

    assert.equal(results[0]!.path, 'specific.md');
    assert.equal(results[0]!.evidence.length, 2);
  });

  it('caps neighbors per seed deterministically', () => {
    upsertLinks('seed-a.md', ['out-a.md', 'specific.md', 'hub.md', 'extra-1.md']);

    const results = scoreGraphLinks([{ path: 'seed-a.md', rank: 0, score: 1, signals: ['bm25'] }], {
      ...options,
      maxNeighborsPerSeed: 2,
    });

    assert.deepEqual(
      results.map((r) => r.path),
      ['extra-1.md', 'hub.md'],
      'cap should use sorted neighbor paths before slicing',
    );
  });
});
