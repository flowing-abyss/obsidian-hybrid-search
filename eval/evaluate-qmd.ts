/**
 * eval/evaluate-qmd.ts — run the same golden set against qmd and write JSON results.
 *
 * Requires qmd to be installed and the vault indexed as a collection:
 *   npm install -g @tobilu/qmd
 *   qmd collection add <vault> --name <collection>
 *   qmd embed
 *
 * Usage:
 *   npm run eval:qmd -- --vault fixtures/obsidian-help/en \
 *                       --collection obsidian-help \
 *                       --golden-set eval/golden-sets/obsidian-help.json \
 *                       --output eval/results/qmd-baseline.json \
 *                       --k 10
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ─── Types ────────────────────────────────────────────────────────────────────

interface GoldenQuery {
  id: string;
  query: string;
  relevant_paths: string[];
  partial_paths: string[];
  category: string;
  notes?: string;
}

interface QmdResult {
  file: string;
  score?: number;
  docid?: string;
}

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(): {
  vault: string;
  collection: string | undefined;
  goldenSet: string;
  outputArg: string | undefined;
  k: number;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const vaultArg = get('--vault') ?? 'fixtures/obsidian-help/en';
  const goldenSetArg = get('--golden-set') ?? 'eval/golden-sets/obsidian-help.json';
  const k = parseInt(get('--k') ?? '10', 10);
  const collection = get('--collection');

  const vault = path.isAbsolute(vaultArg) ? vaultArg : path.join(repoRoot, vaultArg);
  const goldenSet = path.isAbsolute(goldenSetArg)
    ? goldenSetArg
    : path.join(repoRoot, goldenSetArg);

  return { vault, collection, goldenSet, outputArg: get('--output'), k };
}

function buildOutputPath(outputArg: string | undefined): string {
  if (outputArg) {
    return path.isAbsolute(outputArg) ? outputArg : path.join(repoRoot, outputArg);
  }
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  return path.join(repoRoot, `eval/results/${dateStr}_qmd.json`);
}

// ─── qmd wrapper ─────────────────────────────────────────────────────────────

/**
 * Build a lookup map from qmd's normalized path key to the original vault-relative path.
 * qmd normalizes paths: lowercases everything and replaces spaces with hyphens.
 * e.g. "Linking notes and files/Internal links.md" → "linking-notes-and-files/internal-links.md"
 */
function buildPathMap(vault: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, base: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith('.md')) {
        const key = rel.toLowerCase().replace(/ /g, '-');
        map.set(key, rel);
      }
    }
  };
  walk(vault, '');
  return map;
}

/**
 * Convert a qmd file URI like "qmd://obsidian-help/linking-notes-and-files/internal-links.md"
 * back to the original vault-relative path using the pre-built path map.
 */
function resolveQmdPath(qmdFile: string, pathMap: Map<string, string>): string {
  // Strip "qmd://<collection>/" prefix
  const withoutScheme = qmdFile.replace(/^qmd:\/\/[^/]+\//, '');
  return pathMap.get(withoutScheme) ?? withoutScheme;
}

function qmdQuery(query: string, k: number, collection: string | undefined): string[] {
  const args = ['query', '--json', '-n', String(k)];
  if (collection) args.push('-c', collection);
  args.push(query);

  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const result = spawnSync('qmd', args, { encoding: 'utf-8' });
  let stdout: string;
  if (result.error ?? result.status !== 0) {
    // qmd may exit non-zero on empty results — try stdout anyway
    stdout = result.stdout ?? '';
    if (!stdout.trim()) {
      if (result.stderr) console.error(`  [qmd error] ${result.stderr.trim()}`);
      return [];
    }
  } else {
    stdout = result.stdout;
  }

  let parsed: QmdResult[];
  try {
    parsed = JSON.parse(stdout) as QmdResult[];
  } catch {
    console.error(`  [qmd parse error] non-JSON output: ${stdout.slice(0, 120)}`);
    return [];
  }

  return parsed.map((r) => r.file);
}

// ─── Metrics (inlined to avoid importing TS with top-level await issues) ─────

function dcgAtK(scores: number[], k: number): number {
  let dcg = 0;
  const limit = Math.min(k, scores.length);
  for (let i = 0; i < limit; i++) dcg += (scores[i] ?? 0) / Math.log2(i + 2);
  return dcg;
}

function ndcg(
  resultPaths: string[],
  relevantPaths: string[],
  partialPaths: string[],
  k: number,
): number {
  const rel = new Set(relevantPaths);
  const part = new Set(partialPaths);
  const actual = resultPaths.slice(0, k).map((p) => (rel.has(p) ? 1.0 : part.has(p) ? 0.5 : 0.0));
  const ideal = [
    ...Array<number>(relevantPaths.length).fill(1.0),
    ...Array<number>(partialPaths.length).fill(0.5),
  ].slice(0, k);
  const idcg = dcgAtK(ideal, k);
  return idcg === 0 ? 0 : dcgAtK(actual, k) / idcg;
}

function mrr(resultPaths: string[], relevantPaths: string[]): number {
  const rel = new Set(relevantPaths);
  for (let i = 0; i < resultPaths.length; i++) {
    if (rel.has(resultPaths[i] ?? '')) return 1 / (i + 1);
  }
  return 0;
}

function hitAtK(resultPaths: string[], relevantPaths: string[], k: number): boolean {
  const rel = new Set(relevantPaths);
  return resultPaths.slice(0, k).some((p) => rel.has(p));
}

function recallAtK(resultPaths: string[], relevantPaths: string[], k: number): number {
  if (relevantPaths.length === 0) return 0;
  const rel = new Set(relevantPaths);
  return resultPaths.slice(0, k).filter((p) => rel.has(p)).length / relevantPaths.length;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

interface PerQueryResult {
  id: string;
  query: string;
  category: string;
  ndcg_5: number;
  ndcg_k: number;
  mrr: number;
  hit_1: boolean;
  hit_3: boolean;
  hit_5: boolean;
  recall_k: number;
  top_paths: string[];
}

interface AggregatedMetrics {
  ndcg_5: number;
  ndcg_k: number;
  mrr: number;
  hit_1: number;
  hit_3: number;
  hit_5: number;
  recall_k: number;
}

function aggregate(rows: PerQueryResult[]): AggregatedMetrics {
  const n = rows.length;
  if (n === 0) return { ndcg_5: 0, ndcg_k: 0, mrr: 0, hit_1: 0, hit_3: 0, hit_5: 0, recall_k: 0 };
  const avg = (vals: number[]) => round(vals.reduce((a, b) => a + b, 0) / vals.length);
  return {
    ndcg_5: avg(rows.map((r) => r.ndcg_5)),
    ndcg_k: avg(rows.map((r) => r.ndcg_k)),
    mrr: avg(rows.map((r) => r.mrr)),
    hit_1: avg(rows.map((r) => (r.hit_1 ? 1 : 0))),
    hit_3: avg(rows.map((r) => (r.hit_3 ? 1 : 0))),
    hit_5: avg(rows.map((r) => (r.hit_5 ? 1 : 0))),
    recall_k: avg(rows.map((r) => r.recall_k)),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  const { vault, collection, goldenSet, outputArg, k } = parseArgs();
  const output = buildOutputPath(outputArg);

  console.log(`[eval:qmd] vault:      ${vault}`);
  console.log(`[eval:qmd] collection: ${collection ?? '(all)'}`);
  console.log(`[eval:qmd] golden set: ${goldenSet}`);
  console.log(`[eval:qmd] k:          ${k}`);
  console.log();

  // Verify qmd is available
  // eslint-disable-next-line sonarjs/no-os-command-from-path
  const versionResult = spawnSync('qmd', ['--version'], { encoding: 'utf-8' });
  if (versionResult.error) {
    console.error('[eval:qmd] ERROR: qmd not found. Install with: npm install -g @tobilu/qmd');
    process.exit(1);
  }
  console.log(`[eval:qmd] qmd version: ${versionResult.stdout.trim()}`);

  // Load golden set
  if (!fs.existsSync(goldenSet)) {
    console.error(`[eval:qmd] ERROR: golden-set not found: ${goldenSet}`);
    process.exit(1);
  }
  const queries: GoldenQuery[] = JSON.parse(fs.readFileSync(goldenSet, 'utf-8')) as GoldenQuery[];
  console.log(`[eval:qmd] loaded ${queries.length} queries\n`);

  // Build path map for resolving qmd URIs → original vault-relative paths
  const pathMap = buildPathMap(vault);
  const noteCount = pathMap.size;

  // Run queries
  const perQuery: PerQueryResult[] = [];

  for (const q of queries) {
    process.stdout.write(`[eval:qmd] ${q.id}: "${q.query}"...`);

    const rawPaths = qmdQuery(q.query, k, collection);
    const resultPaths = rawPaths.map((p) => resolveQmdPath(p, pathMap));

    const qNdcg5 = ndcg(resultPaths, q.relevant_paths, q.partial_paths, 5);
    const qNdcgK = ndcg(resultPaths, q.relevant_paths, q.partial_paths, k);
    const qMrr = mrr(resultPaths, q.relevant_paths);
    const qHit1 = hitAtK(resultPaths, q.relevant_paths, 1);
    const qHit3 = hitAtK(resultPaths, q.relevant_paths, 3);
    const qHit5 = hitAtK(resultPaths, q.relevant_paths, 5);
    const qRecallK = recallAtK(resultPaths, q.relevant_paths, k);

    perQuery.push({
      id: q.id,
      query: q.query,
      category: q.category,
      ndcg_5: round(qNdcg5),
      ndcg_k: round(qNdcgK),
      mrr: round(qMrr),
      hit_1: qHit1,
      hit_3: qHit3,
      hit_5: qHit5,
      recall_k: round(qRecallK),
      top_paths: resultPaths.slice(0, 5),
    });

    process.stdout.write(` ndcg@5=${qNdcg5.toFixed(3)} mrr=${qMrr.toFixed(3)}\n`);
  }

  // Aggregate
  const summary = aggregate(perQuery);
  const categories = [...new Set(queries.map((q) => q.category))];
  const byCategory: Record<string, AggregatedMetrics> = {};
  for (const cat of categories) {
    byCategory[cat] = aggregate(perQuery.filter((r) => r.category === cat));
  }

  // Build output (same shape as evaluate.ts so eval:compare works)
  const result = {
    meta: {
      date: new Date().toISOString(),
      ohs_version: 'qmd',
      model: 'qmd (LLM query expansion + rerank)',
      rerank: true,
      rerank_model: 'qmd built-in LLM reranker',
      vault: path.relative(repoRoot, vault),
      note_count: noteCount,
      golden_set: path.relative(repoRoot, goldenSet),
      golden_set_size: queries.length,
      k,
    },
    summary,
    by_category: byCategory,
    per_query: perQuery,
  };

  const outputDir = path.dirname(output);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2));

  console.log();
  console.log('─────────────────────────────────────────');
  console.log(`nDCG@5:    ${summary.ndcg_5.toFixed(3)}`);
  console.log(`nDCG@${k}:   ${summary.ndcg_k.toFixed(3)}`);
  console.log(`MRR:       ${summary.mrr.toFixed(3)}`);
  console.log(`Hit@1:     ${summary.hit_1.toFixed(3)}`);
  console.log(`Hit@3:     ${summary.hit_3.toFixed(3)}`);
  console.log(`Hit@5:     ${summary.hit_5.toFixed(3)}`);
  console.log(`Recall@${k}: ${summary.recall_k.toFixed(3)}`);
  console.log('─────────────────────────────────────────');
  console.log(`[eval:qmd] results written to ${output}`);
}

main();
