/**
 * eval/speed-profile.ts — detailed search pipeline latency profiler.
 *
 * Usage:
 *   npm run eval:speed-profile -- --vault fixtures/obsidian-help/dataset \
 *                                --golden-set fixtures/obsidian-help/golden-set.json \
 *                                --runs 10 --warmup 2 --seed 42
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SearchTimingCollector,
  withSearchProfiling,
  type SearchStageSummary,
} from '../src/search-profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

export interface SpeedProfileArgs {
  vault: string;
  goldenSet: string;
  query: string | undefined;
  runs: number;
  warmup: number;
  seed: number | undefined;
  mode: 'hybrid' | 'semantic' | 'fulltext' | 'title';
  limit: number;
  rerank: boolean;
  json: boolean;
}

export interface SpeedProfileGoldenQuery {
  id?: string;
  query: string;
  scope?: string;
}

export interface SpeedProfileRun {
  totalMs: number;
  resultCount: number;
  stages: SearchStageSummary[];
}

interface SpeedProfileSearchOptions {
  mode: 'hybrid' | 'semantic' | 'fulltext' | 'title';
  limit: number;
  rerank: boolean;
  scope?: string;
}

interface SpeedProfileSearchResult {
  path: string;
}

interface SpeedProfileSummary {
  runs: number;
  resultCountMedian: number;
  total: { medianMs: number; p95Ms: number };
  stages: Array<{ stage: string; countMedian: number; medianMs: number; p95Ms: number }>;
}

export async function runProfileIterations(input: {
  warmupQuery: SpeedProfileGoldenQuery;
  measuredQueries: readonly SpeedProfileGoldenQuery[];
  searchOptions: SpeedProfileSearchOptions;
  warmup: number;
  searchFn: (
    query: string,
    options: SpeedProfileSearchOptions,
  ) => Promise<SpeedProfileSearchResult[]>;
  invalidateSearchCache: () => void;
}): Promise<SpeedProfileRun[]> {
  for (let i = 0; i < input.warmup; i++) {
    const collector = new SearchTimingCollector();
    await withSearchProfiling(collector, () =>
      input.searchFn(
        input.warmupQuery.query,
        withQueryScope(input.searchOptions, input.warmupQuery),
      ),
    );
  }

  const runs: SpeedProfileRun[] = [];
  for (const query of input.measuredQueries) {
    input.invalidateSearchCache();
    const collector = new SearchTimingCollector();
    const start = performance.now();
    const results = await withSearchProfiling(collector, () =>
      input.searchFn(query.query, withQueryScope(input.searchOptions, query)),
    );
    runs.push({
      totalMs: roundMs(performance.now() - start),
      resultCount: results.length,
      stages: collector.summary(),
    });
  }
  return runs;
}

export function parseSpeedProfileArgs(argv = process.argv.slice(2)): SpeedProfileArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx !== -1 ? argv[idx + 1] : undefined;
  };

  const vaultArg = get('--vault') ?? 'fixtures/obsidian-help/dataset';
  const goldenSetArg = get('--golden-set') ?? 'fixtures/obsidian-help/golden-set.json';
  const mode = parseMode(get('--mode') ?? 'hybrid');

  return {
    vault: resolveFromRoot(vaultArg),
    goldenSet: resolveFromRoot(goldenSetArg),
    query: get('--query'),
    runs: parsePositiveInt(get('--runs') ?? '10', '--runs'),
    warmup: parseNonNegativeInt(get('--warmup') ?? '2', '--warmup'),
    seed: get('--seed') === undefined ? undefined : parseIntOption(get('--seed')!, '--seed'),
    mode,
    limit: parsePositiveInt(get('--limit') ?? '10', '--limit'),
    rerank: argv.includes('--rerank'),
    json: argv.includes('--json'),
  };
}

export function buildSeededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

export function pickProfileQuery(
  queries: readonly SpeedProfileGoldenQuery[],
  manualQuery: string | undefined,
  random: () => number,
): SpeedProfileGoldenQuery {
  if (manualQuery?.trim()) return { id: 'manual', query: manualQuery.trim() };
  if (queries.length === 0) throw new Error('golden-set has no queries');
  return queries[Math.floor(random() * queries.length)]!;
}

export function pickProfileQueries(
  queries: readonly SpeedProfileGoldenQuery[],
  manualQuery: string | undefined,
  random: () => number,
  runs: number,
): SpeedProfileGoldenQuery[] {
  return Array.from({ length: runs }, () => pickProfileQuery(queries, manualQuery, random));
}

export function summarizeProfileRuns(runs: readonly SpeedProfileRun[]): SpeedProfileSummary {
  const totals = runs.map((run) => run.totalMs);
  const resultCounts = runs.map((run) => run.resultCount);
  const stageNames = Array.from(new Set(runs.flatMap((run) => run.stages.map((s) => s.stage))));

  return {
    runs: runs.length,
    resultCountMedian: upperMedian(resultCounts),
    total: {
      medianMs: upperMedian(totals),
      p95Ms: percentile(totals, 0.95),
    },
    stages: stageNames
      .map((stage) => {
        const summaries = runs
          .map((run) => run.stages.find((s) => s.stage === stage))
          .filter((summary): summary is SearchStageSummary => summary !== undefined);
        return {
          stage,
          countMedian: upperMedian(summaries.map((summary) => summary.count)),
          medianMs: upperMedian(summaries.map((summary) => summary.totalMs)),
          p95Ms: percentile(
            summaries.map((summary) => summary.totalMs),
            0.95,
          ),
        };
      })
      .sort((a, b) => b.medianMs - a.medianMs),
  };
}

async function main(): Promise<void> {
  const args = parseSpeedProfileArgs();
  process.env.OBSIDIAN_VAULT_PATH = args.vault;

  const goldenSet = loadGoldenSet(args.goldenSet);
  const random = args.seed === undefined ? Math.random : buildSeededRandom(args.seed);
  const warmupQuery = pickProfileQuery(goldenSet, args.query, random);
  const measuredQueries = pickProfileQueries(goldenSet, args.query, random, args.runs);

  const { openDb } = await import('../src/db.js');
  const { bumpIndexVersion, search } = await import('../src/searcher.js');
  openDb();

  const searchOptions = {
    mode: args.mode,
    limit: args.limit,
    rerank: args.rerank,
  };

  const runs = await runProfileIterations({
    warmupQuery,
    measuredQueries,
    searchOptions,
    warmup: args.warmup,
    searchFn: search,
    invalidateSearchCache: bumpIndexVersion,
  });

  const summary = summarizeProfileRuns(runs);
  if (args.json) {
    console.log(
      JSON.stringify(
        {
          meta: {
            vault: path.relative(repoRoot, args.vault),
            golden_set: path.relative(repoRoot, args.goldenSet),
            warmup_query_id: warmupQuery.id ?? null,
            warmup_query: warmupQuery.query,
            measured_queries: measuredQueries.map((query) => ({
              id: query.id ?? null,
              query: query.query,
              scope: query.scope ?? null,
            })),
            mode: args.mode,
            limit: args.limit,
            rerank: args.rerank,
            warmup: args.warmup,
            runs: args.runs,
            seed: args.seed ?? null,
          },
          summary,
          runs,
        },
        null,
        2,
      ),
    );
    return;
  }

  printTextReport(args, warmupQuery, measuredQueries, summary);
}

function loadGoldenSet(goldenSetPath: string): SpeedProfileGoldenQuery[] {
  if (!fs.existsSync(goldenSetPath)) {
    throw new Error(`golden-set file not found: ${goldenSetPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(goldenSetPath, 'utf-8')) as unknown;
  if (!Array.isArray(raw)) throw new Error('golden-set must be a JSON array');

  return raw
    .map((entry): SpeedProfileGoldenQuery | null => {
      if (typeof entry === 'string') return { query: entry };
      if (!entry || typeof entry !== 'object') return null;
      const obj = entry as Record<string, unknown>;
      if (typeof obj.query !== 'string' || obj.query.trim() === '') return null;
      return {
        id: typeof obj.id === 'string' ? obj.id : undefined,
        query: obj.query,
        scope: typeof obj.scope === 'string' ? obj.scope : undefined,
      };
    })
    .filter((entry): entry is SpeedProfileGoldenQuery => entry !== null);
}

function printTextReport(
  args: SpeedProfileArgs,
  warmupQuery: SpeedProfileGoldenQuery,
  measuredQueries: readonly SpeedProfileGoldenQuery[],
  summary: SpeedProfileSummary,
): void {
  console.log('[speed-profile]');
  console.log(`vault:      ${args.vault}`);
  console.log(`golden set: ${args.goldenSet}`);
  const warmupPrefix = warmupQuery.id ? `${warmupQuery.id} ` : '';
  console.log(`warmup:    ${warmupPrefix}${JSON.stringify(warmupQuery.query)}`);
  console.log(`queries:   ${measuredQueries.length} measured`);
  const sample = measuredQueries
    .slice(0, 3)
    .map((query) => (query.id ? query.id : JSON.stringify(query.query)))
    .join(', ');
  if (sample) console.log(`sample:    ${sample}${measuredQueries.length > 3 ? ', ...' : ''}`);
  console.log(`mode:       ${args.mode}`);
  console.log(`limit:      ${args.limit}`);
  console.log(`rerank:     ${String(args.rerank)}`);
  console.log(`warmup:     ${args.warmup}`);
  console.log(`runs:       ${args.runs}`);
  if (args.seed !== undefined) console.log(`seed:       ${args.seed}`);
  console.log();
  console.log(
    `total median=${summary.total.medianMs.toFixed(1)}ms p95=${summary.total.p95Ms.toFixed(1)}ms`,
  );
  console.log(`results median=${summary.resultCountMedian}`);
  console.log();
  console.log('stage              count  median    p95');
  console.log('--------------------------------------------');
  for (const stage of summary.stages) {
    console.log(
      `${stage.stage.padEnd(18)}${String(stage.countMedian).padStart(5)}  ${stage.medianMs
        .toFixed(1)
        .padStart(7)}ms  ${stage.p95Ms.toFixed(1).padStart(7)}ms`,
    );
  }
}

function parseMode(value: string): SpeedProfileArgs['mode'] {
  if (value === 'hybrid' || value === 'semantic' || value === 'fulltext' || value === 'title') {
    return value;
  }
  throw new Error(`--mode must be one of: hybrid, semantic, fulltext, title`);
}

function withQueryScope(
  options: SpeedProfileSearchOptions,
  query: SpeedProfileGoldenQuery,
): SpeedProfileSearchOptions {
  if (query.scope !== undefined) return { ...options, scope: query.scope };
  const { scope: _scope, ...withoutScope } = options;
  return withoutScope;
}

function resolveFromRoot(value: string): string {
  return path.isAbsolute(value) ? value : path.join(repoRoot, value);
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = parseIntOption(value, flag);
  if (parsed <= 0) throw new Error(`${flag} must be greater than 0`);
  return parsed;
}

function parseNonNegativeInt(value: string, flag: string): number {
  const parsed = parseIntOption(value, flag);
  if (parsed < 0) throw new Error(`${flag} must be 0 or greater`);
  return parsed;
}

function parseIntOption(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value) {
    throw new Error(`${flag} must be an integer`);
  }
  return parsed;
}

function upperMedian(values: readonly number[]): number {
  return percentile(values, 0.5);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (err) {
    console.error(`[speed-profile] ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
