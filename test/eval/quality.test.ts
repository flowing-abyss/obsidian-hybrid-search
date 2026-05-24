import { describe, expect, it } from 'vitest';
import { assertEvalQuality, FLOOR_NO_RERANK, FLOOR_RERANK } from '../../eval/quality.js';

const passingSummary = {
  ndcg_5: 1,
  ndcg_k: 1,
  mrr: 1,
  hit_1: 1,
  hit_3: 1,
  hit_5: 1,
  recall_k: 1,
};

describe('assertEvalQuality', () => {
  it('accepts no-rerank results at the configured floor', () => {
    expect(() =>
      assertEvalQuality({
        meta: { rerank: false },
        summary: { ...passingSummary, ...FLOOR_NO_RERANK },
      }),
    ).not.toThrow();
  });

  it('accepts rerank results at the configured floor', () => {
    expect(() =>
      assertEvalQuality({
        meta: { rerank: true },
        summary: { ...passingSummary, ...FLOOR_RERANK },
      }),
    ).not.toThrow();
  });

  it('rejects results below the configured floor', () => {
    expect(() =>
      assertEvalQuality({
        meta: { rerank: false },
        summary: {
          ...passingSummary,
          ndcg_5: FLOOR_NO_RERANK.ndcg_5 - 0.001,
        },
      }),
    ).toThrow(/nDCG@5/);
  });
});
