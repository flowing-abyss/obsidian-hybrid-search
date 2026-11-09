/**
 * Metadata retrieval beyond the former 10,000-candidate ceiling.
 * Run this same file against both source checkouts; timings exclude fixture setup.
 *
 * node --import tsx eval/benchmark-filter-only.ts --project /path/to/checkout
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { SearchOptions } from '../src/search/searcher.js';
import type { IndexLease } from '../src/storage/index-ownership.js';

type Storage = typeof import('../src/storage/db.js');
type Search = typeof import('../src/search/searcher.js');
type Generation = typeof import('../src/storage/index-state.js');

const FILLER_NOTES = 10_001;
const TARGET_PATH = 'z-target/needle.md';

function seed(storage: Storage, lease: IndexLease): void {
  // The write API prepares vector statements even for notes without chunks.
  // An empty vector table satisfies that schema contract without embedding work.
  storage.initVecTable(lease, 1);
  for (let start = 0; start < FILLER_NOTES; start += 500) {
    if (!storage.renewIndexLease(lease)) throw new Error('Benchmark lost its indexing lease');
    storage.withIndexMutation(lease, () => {
      for (let index = start; index < Math.min(start + 500, FILLER_NOTES); index++) {
        storage.upsertNote(lease, {
          path: `filler/${index}.md`,
          title: `A filler ${String(index).padStart(5, '0')}`,
          tags: ['filler'],
          frontmatter: { status: 'open' },
          content: 'Metadata benchmark fixture.',
          mtime: 1,
          hash: String(index),
          chunks: [],
        });
      }
    });
  }
  storage.upsertNote(lease, {
    path: TARGET_PATH,
    title: 'Z matching target after all filler titles',
    tags: ['target'],
    frontmatter: { status: 'open' },
    content: 'Metadata benchmark target.',
    mtime: 1,
    hash: 'target',
    chunks: [],
  });
}

async function measure(
  search: Search['search'],
  bump: Generation['bumpIndexVersion'],
  repeats: number,
) {
  const cases: Array<{ name: string; filters: SearchOptions }> = [
    { name: 'scope-only', filters: { scope: 'z-target/' } },
    { name: 'tag-only', filters: { tag: 'target' } },
    {
      name: 'frontmatter+scope+tag',
      filters: { frontmatter: 'status:open', scope: 'z-target/', tag: 'target' },
    },
  ];
  const results = [];
  for (const entry of cases) {
    const samples = [];
    for (let iteration = 0; iteration < repeats; iteration++) {
      // Every repetition executes production SQL, rather than timing a cached answer.
      bump();
      const started = performance.now();
      const found = await search('', { ...entry.filters, mode: 'fulltext', limit: 1 });
      const elapsedMs = performance.now() - started;
      samples.push({
        elapsedMs,
        returnedCount: found.length,
        returnedPaths: found.map((note) => note.path),
        correct: found.length === 1 && found[0]?.path === TARGET_PATH,
      });
    }
    const times = samples.map((sample) => sample.elapsedMs).sort((left, right) => left - right);
    const middle = Math.floor(times.length / 2);
    const medianMs = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
    results.push({
      case: entry.name,
      filters: entry.filters,
      limit: 1,
      expectedCount: 1,
      expectedPath: TARGET_PATH,
      medianMs,
      allCorrect: samples.every((sample) => sample.correct),
      samples,
    });
  }
  return results;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { project: { type: 'string' }, repeats: { type: 'string', default: '3' } },
  });
  const project = path.resolve(values.project ?? fileURLToPath(new URL('..', import.meta.url)));
  const repeats = Number(values.repeats);
  if (!Number.isSafeInteger(repeats) || repeats < 1 || repeats > 20)
    throw new Error('--repeats must be an integer from 1 to 20');

  const vault = mkdtempSync(path.join(tmpdir(), 'ohs-filter-benchmark-'));
  const previousVault = process.env.OBSIDIAN_VAULT_PATH;
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  let storage: Storage | undefined;
  let lease: IndexLease | null = null;
  try {
    process.env.OBSIDIAN_VAULT_PATH = vault;
    globalThis.fetch = () => {
      networkAttempts++;
      return Promise.reject(new Error('Metadata benchmark must not make network requests'));
    };
    storage = (await import(
      pathToFileURL(path.join(project, 'src/storage/db.ts')).href
    )) as Storage;
    const { search } = (await import(
      pathToFileURL(path.join(project, 'src/search/searcher.ts')).href
    )) as Search;
    const { bumpIndexVersion } = (await import(
      pathToFileURL(path.join(project, 'src/storage/index-state.ts')).href
    )) as Generation;
    storage.openDb();
    lease = storage.claimIndexLease(randomUUID(), 'bootstrap');
    if (!lease) throw new Error('Cannot acquire benchmark indexing lease');
    const seedStarted = performance.now();
    seed(storage, lease);
    const fixtureSetupMs = performance.now() - seedStarted;
    storage.releaseIndexLease(lease);
    lease = null;
    const results = await measure(search, bumpIndexVersion, repeats);
    if (networkAttempts !== 0) throw new Error('Metadata retrieval attempted network access');
    console.log(
      JSON.stringify(
        {
          benchmark: 'production metadata-only search; cache bypassed for every repetition',
          project,
          node: process.version,
          platform: process.platform,
          architecture: process.arch,
          fillerNotes: FILLER_NOTES,
          totalNotes: FILLER_NOTES + 1,
          repeats,
          embeddings: 0,
          networkAttempts,
          fixtureSetupMs,
          results,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (storage && lease) storage.releaseIndexLease(lease);
    } finally {
      storage?.closeDb();
      globalThis.fetch = originalFetch;
      if (previousVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
      else process.env.OBSIDIAN_VAULT_PATH = previousVault;
      rmSync(vault, { recursive: true, force: true });
    }
  }
}

await main();
