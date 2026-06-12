import { describe, expect, it } from 'vitest';
import {
  buildPerQueryResult,
  getSearchLimitForQuery,
  runGoldenQuery,
  type GoldenQuery,
} from '../../eval/evaluate.js';

describe('getSearchLimitForQuery()', () => {
  it('overfetches scoped queries so scope filtering does not evaluate global top-k', () => {
    expect(getSearchLimitForQuery({ scope: 'q1/' }, 10, 200)).toBe(200);
  });

  it('uses k for unscoped queries', () => {
    expect(getSearchLimitForQuery({}, 10, 200)).toBe(10);
  });
});

describe('buildPerQueryResult()', () => {
  const query: GoldenQuery = {
    id: 'q1',
    query: 'What degree did I graduate with?',
    scope: 'q1/',
    relevant_paths: ['q1/0002.md', 'q1/0003.md'],
    partial_paths: ['q1/0004.md'],
    category: 'multi-session',
    notes: 'session_count=4',
  };

  it('preserves diagnostic fields and top-k paths', () => {
    const result = buildPerQueryResult(
      query,
      ['q1/0002.md', 'q1/0004.md', 'q1/0005.md', 'q1/0006.md', 'q1/0007.md', 'q1/0008.md'],
      6,
    );

    expect(result).toMatchObject({
      id: 'q1',
      query: 'What degree did I graduate with?',
      category: 'multi-session',
      scope: 'q1/',
      notes: 'session_count=4',
      relevant_paths: ['q1/0002.md', 'q1/0003.md'],
      partial_paths: ['q1/0004.md'],
      top_paths: [
        'q1/0002.md',
        'q1/0004.md',
        'q1/0005.md',
        'q1/0006.md',
        'q1/0007.md',
        'q1/0008.md',
      ],
      missed_paths: ['q1/0003.md'],
      all_relevant_k: false,
      evidence_coverage_k: 0.5,
    });
    expect(result.recall_k).toBe(0.5);
    expect(result.evidence_coverage_k).toBe(result.recall_k);
    expect(result.top_paths).toHaveLength(6);
  });

  it('marks all relevant evidence found when every relevant path is in top-k', () => {
    const result = buildPerQueryResult(query, ['q1/0002.md', 'q1/0003.md'], 10);

    expect(result.all_relevant_k).toBe(true);
    expect(result.missed_paths).toEqual([]);
    expect(result.evidence_coverage_k).toBe(1);
  });
});

describe('runGoldenQuery()', () => {
  it('calls search with overfetch for scoped queries and evaluates only top-k scoped results', async () => {
    const query: GoldenQuery = {
      id: 'q1',
      query: 'target fact',
      scope: 'q1/',
      relevant_paths: ['q1/0002.md'],
      partial_paths: [],
      category: 'single-session-user',
    };
    const calls: Array<{ limit?: number; scope?: string }> = [];

    const result = await runGoldenQuery(query, {
      k: 1,
      searchLimit: 20,
      rerank: false,
      graph: true,
      searchFn: (_input, options) => {
        calls.push({ limit: options.limit, scope: options.scope });
        return Promise.resolve([
          { path: 'q1/0002.md' },
          { path: 'q1/0003.md' },
          { path: 'q1/0004.md' },
        ]);
      },
    });

    expect(calls).toEqual([{ limit: 20, scope: 'q1/' }]);
    expect(result.top_paths).toEqual(['q1/0002.md']);
    expect(result.hit_1).toBe(true);
    expect(result.all_relevant_k).toBe(true);
  });

  it('passes graph option through eval search options', async () => {
    const query: GoldenQuery = {
      id: 'q2',
      query: 'alpha',
      relevant_paths: ['alpha.md'],
      partial_paths: [],
      category: 'unit',
    };
    const calls: unknown[] = [];

    await runGoldenQuery(query, {
      k: 10,
      searchLimit: 10,
      rerank: false,
      graph: false,
      searchFn: (_input, options) => {
        calls.push(options);
        return Promise.resolve([{ path: 'alpha.md' }]);
      },
    });

    expect(calls[0]).toEqual({ mode: 'hybrid', limit: 10, rerank: false, graph: false });
  });
});
