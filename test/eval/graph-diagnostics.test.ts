import { describe, expect, it } from 'vitest';
import {
  buildGraphDiagnostics,
  type EvalResultForGraphDiagnostics,
} from '../../eval/graph-diagnostics.js';

const before: EvalResultForGraphDiagnostics = {
  summary: {
    ndcg_5: 0.5,
    ndcg_k: 0.6,
    mrr: 0.7,
    hit_1: 0.4,
    hit_3: 0.5,
    hit_5: 0.6,
    recall_k: 0.8,
  },
  by_category: {
    linked: {
      ndcg_5: 0.4,
      ndcg_k: 0.5,
      mrr: 0.6,
      hit_1: 0.3,
      hit_3: 0.4,
      hit_5: 0.5,
      recall_k: 0.7,
    },
  },
  per_query: [
    {
      id: 'q1',
      query: 'helped',
      category: 'linked',
      ndcg_5: 0.2,
      ndcg_k: 0.3,
      top_paths: ['a.md'],
      missed_paths: ['b.md', 'c.md'],
    },
    {
      id: 'q2',
      query: 'hurt',
      category: 'linked',
      ndcg_5: 0.9,
      ndcg_k: 0.9,
      top_paths: ['x.md', 'y.md'],
      missed_paths: [],
    },
  ],
};

const after: EvalResultForGraphDiagnostics = {
  summary: {
    ndcg_5: 0.55,
    ndcg_k: 0.62,
    mrr: 0.72,
    hit_1: 0.42,
    hit_3: 0.53,
    hit_5: 0.63,
    recall_k: 0.85,
  },
  by_category: {
    linked: {
      ndcg_5: 0.5,
      ndcg_k: 0.56,
      mrr: 0.65,
      hit_1: 0.35,
      hit_3: 0.45,
      hit_5: 0.55,
      recall_k: 0.75,
    },
  },
  per_query: [
    {
      id: 'q1',
      query: 'helped',
      category: 'linked',
      ndcg_5: 0.6,
      ndcg_k: 0.7,
      top_paths: ['b.md', 'a.md'],
      missed_paths: ['c.md'],
    },
    {
      id: 'q2',
      query: 'hurt',
      category: 'linked',
      ndcg_5: 0.7,
      ndcg_k: 0.75,
      top_paths: ['y.md', 'z.md'],
      missed_paths: ['x.md'],
    },
  ],
};

describe('buildGraphDiagnostics', () => {
  it('computes aggregate and category metric deltas', () => {
    const diagnostics = buildGraphDiagnostics(before, after);

    expect(diagnostics.summaryDelta.ndcg_5).toBeCloseTo(0.05);
    expect(diagnostics.categoryDeltas.linked?.ndcg_5).toBeCloseTo(0.1);
  });

  it('lists helped and hurt query ids by nDCG@5 delta', () => {
    const diagnostics = buildGraphDiagnostics(before, after);

    expect(diagnostics.helped.map((query) => query.id)).toEqual(['q1']);
    expect(diagnostics.hurt.map((query) => query.id)).toEqual(['q2']);
    expect(diagnostics.helped[0]?.newPaths).toEqual(['b.md']);
    expect(diagnostics.hurt[0]?.lostPaths).toEqual(['x.md']);
  });

  it('counts missed relevant path deltas', () => {
    const diagnostics = buildGraphDiagnostics(before, after);

    expect(diagnostics.helped[0]?.missedDelta).toBe(-1);
    expect(diagnostics.hurt[0]?.missedDelta).toBe(1);
  });
});
