import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface EvalSummary {
  ndcg_5: number;
  ndcg_k: number;
  mrr: number;
  hit_1: number;
  hit_3: number;
  hit_5: number;
  recall_k: number;
}

export interface EvalResult {
  meta: { rerank: boolean };
  summary: EvalSummary;
}

export const FLOOR_NO_RERANK = {
  ndcg_5: 0.725, // measured: 0.733
  mrr: 0.775, // measured: 0.788
  hit_1: 0.7, // measured: 0.724
  hit_3: 0.82, // measured: 0.828
  hit_5: 0.855, // measured: 0.862
};

export const FLOOR_RERANK = {
  ndcg_5: 0.73, // measured: 0.736
  mrr: 0.77, // measured: 0.780
  hit_1: 0.66, // measured: 0.672
  hit_3: 0.855, // measured: 0.862
  hit_5: 0.905, // measured: 0.914
};

const METRIC_LABELS = {
  ndcg_5: 'nDCG@5',
  mrr: 'MRR',
  hit_1: 'Hit@1',
  hit_3: 'Hit@3',
  hit_5: 'Hit@5',
} as const;

type FloorMetric = keyof typeof FLOOR_NO_RERANK;

export function assertEvalQuality(result: EvalResult): void {
  const floor = result.meta.rerank ? FLOOR_RERANK : FLOOR_NO_RERANK;
  const failures = (Object.keys(floor) as FloorMetric[])
    .map((metric) => ({
      metric,
      actual: result.summary[metric],
      expected: floor[metric],
    }))
    .filter(({ actual, expected }) => !Number.isFinite(actual) || actual < expected);

  if (failures.length === 0) return;

  const details = failures
    .map(
      ({ metric, actual, expected }) =>
        `${METRIC_LABELS[metric]} ${formatMetric(actual)} < ${expected.toFixed(3)}`,
    )
    .join('\n');

  throw new Error(`Eval quality is below the configured floor:\n${details}`);
}

export function loadEvalResult(filePath: string): EvalResult {
  const absPath = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);
  return JSON.parse(readFileSync(absPath, 'utf-8')) as EvalResult;
}

function formatMetric(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : String(value);
}

function main(): void {
  const [filePath] = process.argv.slice(2);
  if (!filePath) {
    console.error('Usage: tsx eval/quality.ts <eval-result.json>');
    process.exit(1);
  }

  try {
    const result = loadEvalResult(filePath);
    assertEvalQuality(result);
    console.log('[eval:quality] quality floors passed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
