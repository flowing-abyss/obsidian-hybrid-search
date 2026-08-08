import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

// ─── Vault setup (before any import that reads OBSIDIAN_VAULT_PATH) ──────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-knn-oracle-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// Mirrors test/filter-pushdown.test.ts: every query embeds to the fixture's NEAR
// vector. Not strictly needed by the oracle below (it drives the vector arm through
// a stored source embedding, not a query embedding), but the fixture is 4-dim and
// any accidental call into the real 384-dim embedder must not reach sqlite-vec.
vi.mock('../src/embedder.js', () => ({
  embed: vi.fn((texts: string[]) =>
    Promise.resolve(texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]))),
  ),
}));

// The suite runs with `isolate: false`, so a test file that loaded searcher.js first
// leaves it bound to the REAL embedder and the mock above never takes effect. Reset
// the module graph so db.js, searcher.js and embedder.js are all instantiated fresh
// here — without this the whole file passes vacuously or dies on a dim mismatch.
vi.resetModules();

const { closeDb, getChunkEmbeddingsByPath } = await import('../src/db.js');
const { search } = await import('../src/searcher.js');
const { seedPushdownVault, NEEDLE_PATHS, SRC_PATH } = await import('./fixtures/pushdown-vault.js');

/**
 * The expression searchVector uses — max(0, 1 - L2²/2) — NOT plain cosine.
 * Embeddings are only normalized on the local-model path; the API path stores
 * whatever the endpoint returned and the fixture vectors are deliberately
 * unnormalized, so cosine and this expression disagree on the actual data.
 * Mismatched dimensions are impossible here (single fixture dim).
 */
function squaredL2(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i]! - b[i]!) ** 2;
  }
  return sum;
}

function bruteForceScore(query: Float32Array, target: Float32Array): number {
  return Math.max(0, 1 - squaredL2(query, target) / 2);
}

beforeAll(() => {
  seedPushdownVault();
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('KNN pre-filter oracle', () => {
  // The premise the entire filter-pushdown refactor rests on: `vc.chunk_id IN (…)`
  // makes sqlite-vec take the k nearest WITHIN the restricted set, not the global k
  // nearest and then discard. Every other test verifies that indirectly, by asking
  // whether a needle shows up at all. This one verifies it directly, against a
  // brute-force scan in JS — the logic salvaged from the deleted scanSimilarExact.
  it('pre-filtered KNN returns the true nearest neighbours within the filtered set', async () => {
    const queryVec = getChunkEmbeddingsByPath(SRC_PATH)[0]!;

    // Fixture notes are single-chunk, so one chunk per note is the whole note. If the
    // fixture ever grows a multi-chunk note this must become max-over-chunks, to match
    // searchVector's ROW_NUMBER(PARTITION BY note_id) dedup.
    const expected = NEEDLE_PATHS.map((p) => ({
      path: p,
      score: bruteForceScore(queryVec, getChunkEmbeddingsByPath(p)[0]!),
    })).sort((a, b) => b.score - a.score);

    // Vacuity guards on the fixture itself. Without distinct scores the sort above is
    // a stable no-op and the ordering assertion proves nothing; without the needles
    // being strictly worse than the global best, "pre-filter" and "post-filter" would
    // return the same rows.
    const distinct = new Set(expected.map((e) => e.score));
    assert.equal(distinct.size, expected.length, 'needle scores must be pairwise distinct');
    assert.notEqual(
      expected.map((e) => e.path).join(),
      NEEDLE_PATHS.join(),
      'brute-force order must differ from declaration order, or the sort is untested',
    );

    const unfiltered = await search('', { notePath: SRC_PATH, limit: 3 });
    assert.equal(unfiltered.length, 3, 'precondition: the unfiltered lookup must be full');
    assert.ok(
      unfiltered.every((r) => !NEEDLE_PATHS.includes(r.path)),
      'a needle reached the unfiltered top-3 — the assertion below would be vacuous',
    );
    assert.ok(
      unfiltered.every((r) => r.score > expected[0]!.score),
      'every global neighbour must beat every needle, or a post-filter could pass too',
    );

    const actual = await search('', { notePath: SRC_PATH, tag: 'needle', limit: 3 });

    assert.deepEqual(
      actual.map((r) => r.path),
      expected.map((e) => e.path),
    );
    for (const [i, r] of actual.entries()) {
      assert.ok(
        Math.abs(r.score - expected[i]!.score) < 1e-5,
        `score mismatch at ${r.path}: got ${r.score}, brute force says ${expected[i]!.score}`,
      );
    }
  });

  // Pins the scoring expression itself. If searchVector ever switched to plain cosine
  // (a plausible "cleanup", since the comment there calls the value a cosine
  // similarity) the test above would still pass on normalized data — but not here:
  // the fixture vectors are unnormalized, so the two formulas differ measurably.
  it('the reported score is 1 - L2²/2, not plain cosine', async () => {
    const queryVec = getChunkEmbeddingsByPath(SRC_PATH)[0]!;
    const [top] = await search('', { notePath: SRC_PATH, tag: 'needle', limit: 1 });
    assert.ok(top, 'expected one filtered neighbour');

    const targetVec = getChunkEmbeddingsByPath(top.path)[0]!;
    const dot = queryVec.reduce((acc, v, i) => acc + v * targetVec[i]!, 0);
    const norm = (v: Float32Array): number => Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    const cosine = dot / (norm(queryVec) * norm(targetVec));

    assert.ok(
      Math.abs(cosine - bruteForceScore(queryVec, targetVec)) > 1e-3,
      'fixture no longer distinguishes the two formulas — the assertion below is vacuous',
    );
    assert.ok(Math.abs(top.score - bruteForceScore(queryVec, targetVec)) < 1e-5);
    assert.ok(Math.abs(top.score - cosine) > 1e-3);
  });
});
