/**
 * Records search output from the CURRENT implementation so a later refactor can be
 * compared against it. Run before any code change; commit the result.
 *
 *   npx tsx eval/capture-golden.ts --vault fixtures/obsidian-help/dataset \
 *                                  --output eval/results/golden-prechange.json
 *
 * `--limit` (default 10) sets the result window. `eval/compare-golden.ts` needs
 * both a narrow run (matching the committed baseline) and a WIDE one: a hybrid
 * result set that is already full at 10 must shed a tail entry for every newly
 * promoted one, so "nothing became unfindable" can only be checked against a
 * window wider than the one that forced the eviction.
 */
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};

const vault = get('--vault') ?? 'fixtures/obsidian-help/dataset';
const output = get('--output') ?? 'eval/results/golden-prechange.json';
const limitArg = get('--limit');
const limit = limitArg === undefined ? 10 : Number.parseInt(limitArg, 10);
if (!Number.isInteger(limit) || limit < 1) {
  console.error(`--limit must be a positive integer, got "${String(limitArg)}"`);
  process.exit(2);
}
process.env.OBSIDIAN_VAULT_PATH = vault;

const { openDb } = await import('../src/db.js');
const { search } = await import('../src/searcher.js');

openDb();

const MODES = ['hybrid', 'fulltext', 'title', 'semantic'] as const;
const QUERIES = ['sync', 'plugin settings', 'encryption', 'mobile app'];

interface Case {
  id: string;
  mode: string;
  results: Array<{ path: string; rank: number; score: number }>;
}
const captured: Case[] = [];

const record = async (
  id: string,
  mode: string,
  query: string,
  options: Record<string, unknown>,
): Promise<void> => {
  const results = await search(query, { limit, ...options });
  captured.push({
    id,
    mode,
    results: results.map((r, i) => ({ path: r.path, rank: i + 1, score: r.score })),
  });
};

// Pick two folders that actually exist in the vault, so the scope cases are non-trivial.
const SCOPES = ['Obsidian Sync', 'Teams'];

for (const q of QUERIES) {
  for (const mode of MODES) {
    await record(`${q}|${mode}|no-filter`, mode, q, { mode });
    await record(`${q}|${mode}|scope`, mode, q, { mode, scope: SCOPES[0] });
    await record(`${q}|${mode}|scope-exclude`, mode, q, { mode, scope: `-${SCOPES[0]}` });
    await record(`${q}|${mode}|scope-array`, mode, q, { mode, scope: SCOPES });
  }
}

const SRC = 'Obsidian Sync/Introduction to Obsidian Sync.md';
await record('path|no-filter', 'path', '', { notePath: SRC });
await record('path|scope', 'path', '', { notePath: SRC, scope: SCOPES[0] });

writeFileSync(output, JSON.stringify(captured, null, 2));
console.log(`captured ${captured.length} cases at limit=${limit} to ${output}`);
