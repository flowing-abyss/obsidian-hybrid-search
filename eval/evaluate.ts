/**
 * eval/evaluate.ts — index vault + run golden set + write JSON results.
 *
 * Usage:
 *   npm run eval -- --vault fixtures/obsidian-help/en \
 *                   --golden-set eval/golden-sets/obsidian-help.json \
 *                   --output eval/results/baseline-YYYYMMDD.json \
 *                   --k 10
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ─── Parse CLI args ──────────────────────────────────────────────────────────

function parseArgs(): {
  vault: string;
  goldenSet: string;
  outputArg: string | undefined;
  k: number;
  rerank: boolean;
} {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };

  const vaultArg = get('--vault') ?? 'fixtures/obsidian-help/en';
  const goldenSetArg = get('--golden-set') ?? 'eval/golden-sets/obsidian-help.json';
  const k = parseInt(get('--k') ?? '10', 10);
  const rerank = args.includes('--rerank');

  const vaultPath = path.isAbsolute(vaultArg) ? vaultArg : path.join(repoRoot, vaultArg);
  const goldenSetPath = path.isAbsolute(goldenSetArg)
    ? goldenSetArg
    : path.join(repoRoot, goldenSetArg);

  return { vault: vaultPath, goldenSet: goldenSetPath, outputArg: get('--output'), k, rerank };
}

function buildOutputPath(outputArg: string | undefined, vault: string, model: string): string {
  if (outputArg) {
    return path.isAbsolute(outputArg) ? outputArg : path.join(repoRoot, outputArg);
  }
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  // e.g. "obsidian-help-en" from "fixtures/obsidian-help/en"
  const vaultSlug = path.relative(repoRoot, vault).replace(/[\\/]/g, '-');
  // shorten model name: strip vendor prefix (Xenova/, openai/) and replace / with -
  const modelSlug = model.replace(/^[^/]+\//, '').replace(/\//g, '-');
  return path.join(repoRoot, `eval/results/${dateStr}_${vaultSlug}_${modelSlug}.json`);
}

// ─── Golden-set types ─────────────────────────────────────────────────────────

interface GoldenQuery {
  id: string;
  query: string;
  relevant_paths: string[];
  partial_paths: string[];
  category: string;
  notes?: string;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { vault, goldenSet, outputArg, k, rerank } = parseArgs();

  // 1. Set vault path BEFORE importing src modules
  process.env.OBSIDIAN_VAULT_PATH = vault;

  console.log(`[eval] vault:      ${vault}`);
  console.log(`[eval] golden set: ${goldenSet}`);
  console.log(`[eval] k:          ${k}`);
  console.log(`[eval] rerank:     ${String(rerank)}`);
  console.log();

  // 2. Dynamic imports (after env is set)
  const { openDb, initVecTable } = await import('../src/db.js');
  const { getEmbeddingDim, getContextLength } = await import('../src/embedder.js');
  const { indexVaultSync } = await import('../src/indexer.js');
  const { search } = await import('../src/searcher.js');
  const { ndcg, mrr, hitAtK, recallAtK } = await import('./metrics.js');

  // 3. Load golden set
  if (!fs.existsSync(goldenSet)) {
    console.error(`[eval] ERROR: golden-set file not found: ${goldenSet}`);
    process.exit(1);
  }
  const queries: GoldenQuery[] = JSON.parse(fs.readFileSync(goldenSet, 'utf-8')) as GoldenQuery[];
  console.log(`[eval] loaded ${queries.length} queries`);

  // 4. Init DB + index vault
  console.log('[eval] initialising database...');
  openDb();
  const [, embeddingDim] = await Promise.all([getContextLength(), getEmbeddingDim()]);
  initVecTable(embeddingDim);

  console.log('[eval] indexing vault (incremental)...');
  const indexResult = await indexVaultSync();
  console.log(
    `[eval] indexed: ${String(indexResult.indexed)} new, ${String(indexResult.skipped)} skipped, ${String(indexResult.errors.length)} errors`,
  );
  console.log();

  // 5. Load package.json for version
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')) as {
    version: string;
  };
  const model = config.apiKey || process.env.OPENAI_BASE_URL ? config.apiModel : config.localModel;
  const output = buildOutputPath(outputArg, vault, model);
  console.log(`[eval] output:     ${output}`);

  // 6. Run queries
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

  const perQuery: PerQueryResult[] = [];

  for (const q of queries) {
    process.stdout.write(`[eval] running ${q.id}: "${q.query}"...`);
    const results = await search(q.query, { mode: 'hybrid', limit: k, rerank });
    const resultPaths = results.map((r) => r.path);

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

  // 7. Aggregate metrics
  const summary = aggregateMetrics(perQuery);

  // By category
  const categories = [...new Set(queries.map((q) => q.category))];
  const byCategory: Record<string, ReturnType<typeof aggregateMetrics>> = {};
  for (const cat of categories) {
    byCategory[cat] = aggregateMetrics(perQuery.filter((q) => q.category === cat));
  }

  // 8. Count notes
  const { getDb } = await import('../src/db.js');
  const db = getDb();
  const noteCount = (db.prepare('SELECT COUNT(*) as n FROM notes').get() as { n: number }).n;

  // 9. Build output
  const output_ = {
    meta: {
      date: new Date().toISOString(),
      ohs_version: pkg.version,
      model,
      rerank,
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

  // 10. Write results
  const outputDir = path.dirname(output);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(output, JSON.stringify(output_, null, 2));

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
  console.log(`[eval] results written to ${output}`);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
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

function aggregateMetrics(
  rows: {
    ndcg_5: number;
    ndcg_k: number;
    mrr: number;
    hit_1: boolean;
    hit_3: boolean;
    hit_5: boolean;
    recall_k: number;
  }[],
): AggregatedMetrics {
  const n = rows.length;
  if (n === 0)
    return {
      ndcg_5: 0,
      ndcg_k: 0,
      mrr: 0,
      hit_1: 0,
      hit_3: 0,
      hit_5: 0,
      recall_k: 0,
    };
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

await main();
