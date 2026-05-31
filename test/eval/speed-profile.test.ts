import { describe, expect, it } from 'vitest';
import {
  buildSeededRandom,
  parseSpeedProfileArgs,
  pickProfileQueries,
  pickProfileQuery,
  runProfileIterations,
  summarizeProfileRuns,
  type SpeedProfileGoldenQuery,
  type SpeedProfileRun,
} from '../../eval/speed-profile.js';

describe('parseSpeedProfileArgs()', () => {
  it('uses eval naming conventions and defaults', () => {
    const args = parseSpeedProfileArgs([
      '--vault',
      'fixtures/custom-vault',
      '--golden-set',
      'fixtures/custom-golden-set.json',
      '--runs',
      '7',
      '--warmup',
      '3',
      '--seed',
      '42',
      '--json',
    ]);

    expect(args).toMatchObject({
      runs: 7,
      warmup: 3,
      seed: 42,
      json: true,
      query: undefined,
    });
    expect(args.vault).toMatch(/fixtures\/custom-vault$/);
    expect(args.goldenSet).toMatch(/fixtures\/custom-golden-set\.json$/);
  });
});

describe('pickProfileQuery()', () => {
  const queries: SpeedProfileGoldenQuery[] = [
    { id: 'q1', query: 'first query' },
    { id: 'q2', query: 'second query', scope: 'docs/' },
  ];

  it('uses manual query when provided', () => {
    expect(pickProfileQuery(queries, 'manual query', Math.random)).toEqual({
      id: 'manual',
      query: 'manual query',
    });
  });

  it('picks a seeded golden-set query reproducibly', () => {
    const random = buildSeededRandom(7);

    expect(pickProfileQuery(queries, undefined, random)).toEqual(queries[0]);
  });
});

describe('pickProfileQueries()', () => {
  const queries: SpeedProfileGoldenQuery[] = [
    { id: 'q1', query: 'first query' },
    { id: 'q2', query: 'second query', scope: 'docs/' },
    { id: 'q3', query: 'third query' },
  ];

  it('reuses manual query for each measured run', () => {
    expect(pickProfileQueries(queries, 'manual query', Math.random, 3)).toEqual([
      { id: 'manual', query: 'manual query' },
      { id: 'manual', query: 'manual query' },
      { id: 'manual', query: 'manual query' },
    ]);
  });

  it('samples a golden-set query for each measured run', () => {
    const randomValues = [0.1, 0.7, 0.4];
    const random = () => randomValues.shift() ?? 0;

    expect(pickProfileQueries(queries, undefined, random, 3)).toEqual([
      queries[0],
      queries[2],
      queries[1],
    ]);
  });
});

describe('runProfileIterations()', () => {
  it('warms the model then invalidates result cache before every measured run', async () => {
    const events: string[] = [];

    const runs = await runProfileIterations({
      warmupQuery: { id: 'q1', query: 'first query', scope: 'docs/' },
      measuredQueries: [
        { id: 'q1', query: 'first query', scope: 'docs/' },
        { id: 'q2', query: 'second query' },
        { id: 'q3', query: 'third query', scope: 'api/' },
      ],
      searchOptions: { mode: 'hybrid', limit: 10, rerank: false, scope: 'docs/' },
      warmup: 2,
      searchFn: (query, options) => {
        events.push(`search:${query}:${options.scope ?? ''}`);
        return Promise.resolve([{ path: 'result.md' }]);
      },
      invalidateSearchCache: () => {
        events.push('invalidate');
      },
    });

    expect(runs).toHaveLength(3);
    expect(events).toEqual([
      'search:first query:docs/',
      'search:first query:docs/',
      'invalidate',
      'search:first query:docs/',
      'invalidate',
      'search:second query:',
      'invalidate',
      'search:third query:api/',
    ]);
  });
});

describe('summarizeProfileRuns()', () => {
  it('aggregates total latency and per-stage timings', () => {
    const runs: SpeedProfileRun[] = [
      {
        totalMs: 100,
        resultCount: 3,
        stages: [{ stage: 'embedQuery', count: 1, totalMs: 80, medianMs: 80, p95Ms: 80 }],
      },
      {
        totalMs: 200,
        resultCount: 4,
        stages: [
          { stage: 'embedQuery', count: 1, totalMs: 120, medianMs: 120, p95Ms: 120 },
          { stage: 'vectorSearch', count: 1, totalMs: 20, medianMs: 20, p95Ms: 20 },
        ],
      },
    ];

    expect(summarizeProfileRuns(runs)).toEqual({
      runs: 2,
      resultCountMedian: 4,
      total: { medianMs: 200, p95Ms: 200 },
      stages: [
        { stage: 'embedQuery', countMedian: 1, medianMs: 120, p95Ms: 120 },
        { stage: 'vectorSearch', countMedian: 1, medianMs: 20, p95Ms: 20 },
      ],
    });
  });
});
