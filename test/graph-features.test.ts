import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import {
  computeGraphStructuralFeatures,
  scoreLinkContext,
  titleQueryOverlap,
  type FeatureAdjacency,
} from '../src/graph-features.js';

const adjacency: FeatureAdjacency = {
  outgoing: new Map([
    ['seed', ['a', 'b', 'shared']],
    ['candidate', ['shared', 'b']],
    ['generic', ['x']],
  ]),
  backlinks: new Map([
    ['seed', ['source1', 'source2']],
    ['candidate', ['source1', 'source2']],
    ['generic', ['source3']],
  ]),
};

describe('graph feature extraction', () => {
  it('scores link context only when query terms appear in context', () => {
    assert.ok(
      scoreLinkContext('memory prompts', ['This link explains memory prompts in prose']) > 0,
    );
    assert.equal(scoreLinkContext('memory prompts', ['Unrelated visual interface note']), 0);
  });

  it('scores title query overlap with token overlap', () => {
    assert.ok(
      titleQueryOverlap('spaced repetition memory', 'Spaced repetition memory system') > 0.6,
    );
    assert.equal(titleQueryOverlap('spaced repetition memory', 'Creative pressure'), 0);
  });

  it('computes local structure features from seed and candidate neighborhoods', () => {
    const features = computeGraphStructuralFeatures({
      seedPaths: ['seed'],
      candidatePath: 'candidate',
      adjacency,
    });

    assert.ok(features.commonNeighbors >= 2);
    assert.ok(features.jaccard > 0);
    assert.ok(features.adamicAdar > 0);
    assert.ok(features.resourceAllocation > 0);
    assert.ok(features.coCitationCount >= 2);
    assert.ok(features.lowDegreePrior > 0);
  });
});
