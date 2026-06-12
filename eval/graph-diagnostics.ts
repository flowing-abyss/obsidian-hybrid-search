import fs from 'node:fs';
import path from 'node:path';

export interface AggregatedMetricsForGraphDiagnostics {
  ndcg_5: number;
  ndcg_k: number;
  mrr: number;
  hit_1: number;
  hit_3: number;
  hit_5: number;
  recall_k: number;
}

export interface PerQueryForGraphDiagnostics {
  id: string;
  query: string;
  category: string;
  ndcg_5: number;
  ndcg_k?: number;
  top_paths: string[];
  missed_paths?: string[];
}

export interface EvalResultForGraphDiagnostics {
  summary: AggregatedMetricsForGraphDiagnostics;
  by_category: Record<string, AggregatedMetricsForGraphDiagnostics>;
  per_query: PerQueryForGraphDiagnostics[];
}

export interface QueryDelta {
  id: string;
  query: string;
  category: string;
  ndcg5Delta: number;
  ndcgKDelta: number;
  missedDelta: number;
  newPaths: string[];
  lostPaths: string[];
}

export interface GraphDiagnostics {
  summaryDelta: AggregatedMetricsForGraphDiagnostics;
  categoryDeltas: Record<string, AggregatedMetricsForGraphDiagnostics>;
  helped: QueryDelta[];
  hurt: QueryDelta[];
  unchanged: QueryDelta[];
}

const METRIC_KEYS = ['ndcg_5', 'ndcg_k', 'mrr', 'hit_1', 'hit_3', 'hit_5', 'recall_k'] as const;

export function buildGraphDiagnostics(
  before: EvalResultForGraphDiagnostics,
  after: EvalResultForGraphDiagnostics,
): GraphDiagnostics {
  const beforeById = new Map(before.per_query.map((query) => [query.id, query]));
  const deltas = after.per_query.flatMap((afterQuery) => {
    const beforeQuery = beforeById.get(afterQuery.id);
    if (!beforeQuery) return [];
    return [buildQueryDelta(beforeQuery, afterQuery)];
  });

  return {
    summaryDelta: metricDelta(before.summary, after.summary),
    categoryDeltas: buildCategoryDeltas(before.by_category, after.by_category),
    helped: deltas.filter((query) => query.ndcg5Delta > 0).sort(sortQueryDeltasDesc),
    hurt: deltas.filter((query) => query.ndcg5Delta < 0).sort(sortQueryDeltasAsc),
    unchanged: deltas.filter((query) => query.ndcg5Delta === 0),
  };
}

function buildCategoryDeltas(
  before: Record<string, AggregatedMetricsForGraphDiagnostics>,
  after: Record<string, AggregatedMetricsForGraphDiagnostics>,
): Record<string, AggregatedMetricsForGraphDiagnostics> {
  const categories = new Set([...Object.keys(before), ...Object.keys(after)]);
  const result: Record<string, AggregatedMetricsForGraphDiagnostics> = {};
  for (const category of categories) {
    result[category] = metricDelta(
      before[category] ?? zeroMetrics(),
      after[category] ?? zeroMetrics(),
    );
  }
  return result;
}

function buildQueryDelta(
  before: PerQueryForGraphDiagnostics,
  after: PerQueryForGraphDiagnostics,
): QueryDelta {
  return {
    id: after.id,
    query: after.query,
    category: after.category,
    ndcg5Delta: after.ndcg_5 - before.ndcg_5,
    ndcgKDelta: (after.ndcg_k ?? 0) - (before.ndcg_k ?? 0),
    missedDelta: (after.missed_paths ?? []).length - (before.missed_paths ?? []).length,
    newPaths: after.top_paths.filter((candidatePath) => !before.top_paths.includes(candidatePath)),
    lostPaths: before.top_paths.filter((candidatePath) => !after.top_paths.includes(candidatePath)),
  };
}

function metricDelta(
  before: AggregatedMetricsForGraphDiagnostics,
  after: AggregatedMetricsForGraphDiagnostics,
): AggregatedMetricsForGraphDiagnostics {
  return {
    ndcg_5: after.ndcg_5 - before.ndcg_5,
    ndcg_k: after.ndcg_k - before.ndcg_k,
    mrr: after.mrr - before.mrr,
    hit_1: after.hit_1 - before.hit_1,
    hit_3: after.hit_3 - before.hit_3,
    hit_5: after.hit_5 - before.hit_5,
    recall_k: after.recall_k - before.recall_k,
  };
}

function zeroMetrics(): AggregatedMetricsForGraphDiagnostics {
  return { ndcg_5: 0, ndcg_k: 0, mrr: 0, hit_1: 0, hit_3: 0, hit_5: 0, recall_k: 0 };
}

function sortQueryDeltasDesc(a: QueryDelta, b: QueryDelta): number {
  return b.ndcg5Delta - a.ndcg5Delta || a.id.localeCompare(b.id);
}

function sortQueryDeltasAsc(a: QueryDelta, b: QueryDelta): number {
  return a.ndcg5Delta - b.ndcg5Delta || a.id.localeCompare(b.id);
}

function loadResult(filePath: string): EvalResultForGraphDiagnostics {
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
  return JSON.parse(fs.readFileSync(absPath, 'utf-8')) as EvalResultForGraphDiagnostics;
}

function formatDelta(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(3)}`;
}

function printTopQueries(label: string, queries: QueryDelta[]): void {
  console.log(label);
  for (const query of queries.slice(0, 10)) {
    console.log(
      `  ${query.id} ${formatDelta(query.ndcg5Delta)} ${query.category}: ${query.query} (missed ${formatDelta(query.missedDelta)})`,
    );
  }
}

function main(): void {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error('Usage: npm run eval:graph-diagnostics -- <before.json> <after.json>');
    process.exit(1);
  }

  const diagnostics = buildGraphDiagnostics(loadResult(beforePath), loadResult(afterPath));
  console.log('Summary deltas:');
  for (const key of METRIC_KEYS) {
    console.log(`  ${key}: ${formatDelta(diagnostics.summaryDelta[key])}`);
  }
  console.log('Category nDCG@5 deltas:');
  for (const [category, delta] of Object.entries(diagnostics.categoryDeltas)) {
    console.log(`  ${category}: ${formatDelta(delta.ndcg_5)}`);
  }
  printTopQueries('Helped queries:', diagnostics.helped);
  printTopQueries('Hurt queries:', diagnostics.hurt);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
