/**
 * eval/benchmark-speed.ts — measure average query latency for ohs and qmd.
 *
 * Usage:
 *   npm run eval:benchmark -- --vault fixtures/obsidian-help/en --collection obsidian-help
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const QUERIES = [
  'how to create internal links between notes',
  'customize keyboard shortcuts',
  'sync vault across devices',
  'embed images in notes',
  'tag notes for organization',
  'create a daily note template',
  'search notes by content',
  'export notes to PDF',
  'use dataview plugin',
  'graph view navigation',
];

const RUNS = 5; // runs per query, take median

function parseArgs(): { vault: string; collection: string | undefined } {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const vaultArg = get('--vault') ?? 'fixtures/obsidian-help/en';
  const vault = path.isAbsolute(vaultArg) ? vaultArg : path.join(repoRoot, vaultArg);
  return { vault, collection: get('--collection') };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function measureOhs(query: string, vault: string): number {
  const start = performance.now();
  /* eslint-disable sonarjs/no-os-command-from-path */
  spawnSync('node', ['dist/src/cli.js', '--mode', 'hybrid', '--limit', '10', query], {
    encoding: 'utf-8',
    env: { ...process.env, OBSIDIAN_VAULT_PATH: vault },
  });
  /* eslint-enable sonarjs/no-os-command-from-path */
  return performance.now() - start;
}

function measureQmd(query: string, collection: string | undefined): number {
  const args = ['query', '--json', '-n', '10'];
  if (collection) args.push('-c', collection);
  args.push(query);
  const start = performance.now();
  spawnSync('qmd', args, { encoding: 'utf-8' }); // eslint-disable-line sonarjs/no-os-command-from-path
  return performance.now() - start;
}

function benchmarkTool(
  name: string,
  measure: (q: string) => number,
): { medians: number[]; overall: number } {
  console.log(`\n[benchmark] ${name}`);
  const medians: number[] = [];

  for (const query of QUERIES) {
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      times.push(measure(query));
    }
    const med = median(times);
    medians.push(med);
    console.log(`  "${query.slice(0, 45).padEnd(45)}"  median=${med.toFixed(0)}ms`);
  }

  const overall = median(medians);
  console.log(`  ${'─'.repeat(60)}`);
  console.log(`  Overall median: ${overall.toFixed(0)} ms`);
  return { medians, overall };
}

function main(): void {
  const { vault, collection } = parseArgs();

  console.log('[benchmark] warming up ohs (first query loads DB + model)...');
  measureOhs(QUERIES[0]!, vault);

  console.log('[benchmark] warming up qmd (first query loads LLM)...');
  measureQmd(QUERIES[0]!, collection);

  console.log('\n[benchmark] warm runs starting...');

  const ohs = benchmarkTool('obsidian-hybrid-search (hybrid, no rerank)', (q) =>
    measureOhs(q, vault),
  );
  const qmd = benchmarkTool('qmd (LLM expansion + rerank)', (q) => measureQmd(q, collection));

  console.log('\n══════════════════════════════════════════════');
  console.log(
    `obsidian-hybrid-search  ${ohs.overall.toFixed(0).padStart(6)} ms  (median over ${QUERIES.length} queries × ${RUNS} runs)`,
  );
  console.log(
    `qmd                     ${qmd.overall.toFixed(0).padStart(6)} ms  (median over ${QUERIES.length} queries × ${RUNS} runs)`,
  );
  console.log(`Speedup: ${(qmd.overall / ohs.overall).toFixed(1)}×`);
  console.log('══════════════════════════════════════════════');
}

main();
