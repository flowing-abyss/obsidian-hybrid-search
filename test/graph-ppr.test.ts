import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { runPersonalizedPageRank, type GraphAdjacency } from '../src/graph-ppr.js';

function adjacency(edges: Record<string, string[]>): GraphAdjacency {
  const outgoing = new Map<string, string[]>();
  const backlinks = new Map<string, string[]>();
  for (const [from, targets] of Object.entries(edges)) {
    outgoing.set(from, targets);
    for (const to of targets) {
      const incoming = backlinks.get(to) ?? [];
      incoming.push(from);
      backlinks.set(to, incoming);
    }
  }
  return { outgoing, backlinks };
}

describe('runPersonalizedPageRank', () => {
  it('ranks a node reached by multiple strong seeds above single-edge neighbors', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({ a: ['shared', 'single-a'], b: ['shared', 'single-b'] }),
      seeds: [
        { path: 'a', weight: 0.7 },
        { path: 'b', weight: 0.3 },
      ],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 10,
        outgoingWeight: 1,
        backlinkWeight: 0,
      },
    });

    assert.ok(
      scores.find((score) => score.path === 'shared')!.score >
        scores.find((score) => score.path === 'single-a')!.score,
    );
    assert.ok(
      scores.find((score) => score.path === 'shared')!.score >
        scores.find((score) => score.path === 'single-b')!.score,
    );
  });

  it('normalizes hub fan-out so broad hubs do not swamp specific candidates', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({
        seed: ['specific', 'hub'],
        hub: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
      }),
      seeds: [{ path: 'seed', weight: 1 }],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 20,
        outgoingWeight: 1,
        backlinkWeight: 0,
      },
    });

    assert.ok(
      scores.find((score) => score.path === 'specific')!.score >
        scores.find((score) => score.path === 'h1')!.score,
    );
  });

  it('uses backlink transitions with lower weight than outgoing transitions', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({ seed: ['out'], back: ['seed'] }),
      seeds: [{ path: 'seed', weight: 1 }],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 10,
        outgoingWeight: 1,
        backlinkWeight: 0.5,
      },
    });

    assert.ok(
      scores.find((score) => score.path === 'out')!.score >
        scores.find((score) => score.path === 'back')!.score,
    );
  });

  it('keeps dangling-node mass at restart seeds instead of disappearing', () => {
    const scores = runPersonalizedPageRank({
      adjacency: adjacency({ seed: ['dangling'] }),
      seeds: [{ path: 'seed', weight: 1 }],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 10,
        outgoingWeight: 1,
        backlinkWeight: 0,
      },
    });

    const total = scores.reduce((sum, score) => sum + score.score, 0);
    assert.ok(total > 0.99 && total < 1.01, `total probability should be preserved, got ${total}`);
  });

  it('does not walk outside an explicit bounded frontier', () => {
    const scores = runPersonalizedPageRank({
      adjacency: {
        ...adjacency({
          seed: ['hub', 'specific'],
          hub: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
        }),
        allowedPaths: new Set(['seed', 'hub', 'specific']),
      },
      seeds: [{ path: 'seed', weight: 1 }],
      options: {
        restartProbability: 0.35,
        maxIterations: 12,
        minDelta: 1e-8,
        frontierLimit: 10,
        outgoingWeight: 1,
        backlinkWeight: 0,
      },
    });

    assert.deepEqual(
      scores.map((score) => score.path).sort((a, b) => a.localeCompare(b)),
      ['hub', 'seed', 'specific'],
    );
  });
});
