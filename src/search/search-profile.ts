import { AsyncLocalStorage } from 'node:async_hooks';

export interface SearchStageSummary {
  stage: string;
  count: number;
  totalMs: number;
  medianMs: number;
  p95Ms: number;
}

export class SearchTimingCollector {
  private readonly stages = new Map<string, number[]>();

  record(stage: string, durationMs: number): void {
    const values = this.stages.get(stage) ?? [];
    values.push(roundMs(durationMs));
    this.stages.set(stage, values);
  }

  summary(): SearchStageSummary[] {
    return Array.from(this.stages.entries()).map(([stage, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return {
        stage,
        count: values.length,
        totalMs: roundMs(values.reduce((sum, value) => sum + value, 0)),
        medianMs: percentile(sorted, 0.5),
        p95Ms: percentile(sorted, 0.95),
      };
    });
  }
}

const storage = new AsyncLocalStorage<SearchTimingCollector>();

export function getActiveSearchProfiler(): SearchTimingCollector | undefined {
  return storage.getStore();
}

export async function withSearchProfiling<T>(
  collector: SearchTimingCollector,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(collector, fn);
}

export async function measureSearchStage<T>(stage: string, fn: () => Promise<T>): Promise<T> {
  const profiler = getActiveSearchProfiler();
  if (!profiler) return fn();

  const start = performance.now();
  try {
    return await fn();
  } finally {
    profiler.record(stage, performance.now() - start);
  }
}

export function measureSearchStageSync<T>(stage: string, fn: () => T): T {
  const profiler = getActiveSearchProfiler();
  if (!profiler) return fn();

  const start = performance.now();
  try {
    return fn();
  } finally {
    profiler.record(stage, performance.now() - start);
  }
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * p));
  return sortedValues[index] ?? 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
