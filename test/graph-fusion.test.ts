import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  fuseGraphFeatures,
  type DirectCandidate,
  type GraphCandidateFeatures,
} from '../src/graph-fusion.js';

const options = {
  directBoostCap: 0.08,
  graphOnlyBase: 0.45,
  linkContextGate: 0.15,
  titleOverlapGate: 0.25,
};

function graphCandidate(
  overrides: Partial<GraphCandidateFeatures> & Pick<GraphCandidateFeatures, 'path'>,
): GraphCandidateFeatures {
  return {
    ppr: 1,
    directHybrid: null,
    semantic: null,
    bm25: null,
    fuzzyTitle: null,
    titleQueryOverlap: 0,
    linkContextScore: 0,
    commonNeighbors: 0,
    jaccard: 0,
    adamicAdar: 0,
    resourceAllocation: 0,
    coCitationCount: 0,
    degree: 10,
    lowDegreePrior: 0.3,
    minSeedRank: 1,
    minDepth: 1,
    ...overrides,
  };
}

describe('fuseGraphFeatures', () => {
  it('preserves direct rank 1 when graph evidence is weak', () => {
    const direct: DirectCandidate[] = [
      { path: 'best', score: 1, hybridScore: 1 },
      { path: 'second', score: 0.6, hybridScore: 0.6 },
    ];

    const fused = fuseGraphFeatures(
      direct,
      [graphCandidate({ path: 'second', directHybrid: 0.6 })],
      options,
    );

    assert.equal(fused[0]!.path, 'best');
  });

  it('blocks graph-only candidates without query-conditioned evidence', () => {
    const fused = fuseGraphFeatures(
      [],
      [
        graphCandidate({
          path: 'graph-only',
          commonNeighbors: 5,
          jaccard: 1,
          adamicAdar: 1,
          resourceAllocation: 1,
          coCitationCount: 5,
          lowDegreePrior: 0.8,
        }),
      ],
      options,
    );

    assert.deepEqual(fused, []);
  });

  it('allows graph-only candidates with strong link-context evidence', () => {
    const fused = fuseGraphFeatures(
      [],
      [graphCandidate({ path: 'graph-only', linkContextScore: 0.5, lowDegreePrior: 0.8 })],
      options,
    );

    assert.equal(fused[0]!.path, 'graph-only');
    assert.ok(fused[0]!.graphScore > 0);
  });
});
