import { describe, expect, it } from 'vitest';
import {
  SearchTimingCollector,
  getActiveSearchProfiler,
  measureSearchStage,
  withSearchProfiling,
} from '../src/search-profile.js';

describe('SearchTimingCollector', () => {
  it('records repeated stages and reports median and p95 durations', () => {
    const collector = new SearchTimingCollector();

    collector.record('embedQuery', 10);
    collector.record('embedQuery', 30);
    collector.record('embedQuery', 20);

    expect(collector.summary()).toEqual([
      {
        stage: 'embedQuery',
        count: 3,
        totalMs: 60,
        medianMs: 20,
        p95Ms: 30,
      },
    ]);
  });

  it('keeps the active profiler inside async search profiling context', async () => {
    const collector = new SearchTimingCollector();

    await withSearchProfiling(collector, async () => {
      expect(getActiveSearchProfiler()).toBe(collector);
      await measureSearchStage('vectorSearch', () => Promise.resolve('done'));
    });

    expect(getActiveSearchProfiler()).toBeUndefined();
    expect(collector.summary()[0]?.stage).toBe('vectorSearch');
    expect(collector.summary()[0]?.count).toBe(1);
  });
});
