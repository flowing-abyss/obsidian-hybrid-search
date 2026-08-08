/**
 * Compares `capture-golden.ts` snapshots and asserts the filter-pushdown
 * invariants. Exits non-zero and prints the offending case ids on violation.
 *
 *   npx tsx eval/capture-golden.ts --vault fixtures/obsidian-help/dataset \
 *                                  --output /tmp/golden-post.json
 *   npx tsx eval/capture-golden.ts --vault fixtures/obsidian-help/dataset \
 *                                  --limit 50 --output /tmp/golden-post-wide.json
 *   npx tsx eval/compare-golden.ts eval/results/golden-prechange.json \
 *                                  /tmp/golden-post.json /tmp/golden-post-wide.json
 *
 * This is a script rather than a committed vitest test on purpose: it reads
 * captures taken from `fixtures/<vault>/dataset`, and those fixture vaults are
 * gitignored, so a committed test could never run in CI.
 *
 * Invariants, per the filter-pushdown design:
 *
 *   - fulltext / title / semantic / path:
 *                                new@10 is a SUPERSET of old@10, with the
 *                                relative order of the surviving old paths
 *                                preserved. Measured to hold exactly.
 *   - hybrid:                    old@10 is a SUBSET of new@WIDE — nothing that
 *                                was findable became unfindable. Superset at a
 *                                FIXED window is not assertable here and never
 *                                was: RRF scores by rank position within each
 *                                arm, so a wider filtered pool re-shuffles
 *                                positions, and a result set already full at 10
 *                                must shed a tail entry for every newly
 *                                promoted one. Displacement inside the window
 *                                is expected and is reported, not failed;
 *                                disappearance from the ranking is a
 *                                regression.
 *   - text query, no filter:     scores bit-identical, at the SAME window, in
 *                                every mode INCLUDING hybrid. The predicate
 *                                builder short-circuits when empty, so the SQL
 *                                is unchanged. Drift means the short-circuit
 *                                leaked. This subsumes the checks above, so
 *                                unfiltered cases are checked only here.
 *   - path lookup, no filter:    superset + order preserved among survivors,
 *                                but the count MAY GROW. Exclusions moved into
 *                                SQL unconditionally, so a hub note now fills
 *                                the whole `limit`. This is the accepted
 *                                behaviour change — do not assert equality.
 */
import { readFileSync } from 'node:fs';

interface CaseResult {
  path: string;
  rank: number;
  score: number;
}
interface Case {
  id: string;
  mode: string;
  results: CaseResult[];
}

const ORDERED_MODES = new Set(['fulltext', 'title', 'semantic']);

const args = process.argv.slice(2);
const [beforePath, afterPath, afterWidePath] = args;
if (!beforePath || !afterPath || !afterWidePath) {
  console.error('usage: tsx eval/compare-golden.ts <before.json> <after.json> <after-wide.json>');
  process.exit(2);
}

const load = (file: string): Map<string, Case> => {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Case[];
  return new Map(parsed.map((c) => [c.id, c]));
};

const before = load(beforePath);
const after = load(afterPath);
const afterWide = load(afterWidePath);

const violations: string[] = [];
const notes: string[] = [];
/** Hybrid cases where an old result survived but changed position. */
const displacements: Array<{ id: string; path: string; from: number; to: number }> = [];

const fail = (id: string, message: string): void => {
  violations.push(`${id}: ${message}`);
};

/** A case id encodes `query|mode|filter`; the path cases encode `path|filter`. */
const isUnfiltered = (id: string): boolean => id.endsWith('|no-filter');

/** Reports the first place the surviving old paths appear out of their old order. */
const findOrderBreak = (oldPaths: string[], index: Map<string, number>): string | undefined => {
  const positions = oldPaths.map((p) => index.get(p)!);
  for (let i = 1; i < positions.length; i++) {
    if (positions[i]! < positions[i - 1]!) {
      return (
        `order broken among survivors: "${oldPaths[i - 1]}" (new #${positions[i - 1]! + 1}) ` +
        `now ranks after "${oldPaths[i]}" (new #${positions[i]! + 1})`
      );
    }
  }
  return undefined;
};

for (const [id, oldCase] of before) {
  const newCase = after.get(id);
  const wideCase = afterWide.get(id);
  if (!newCase || !wideCase) {
    fail(id, `missing from the ${newCase ? 'wide' : 'narrow'} capture`);
    continue;
  }

  const oldPaths = oldCase.results.map((r) => r.path);
  const newPaths = newCase.results.map((r) => r.path);
  const newIndex = new Map(newPaths.map((p, i) => [p, i]));

  const isPathCase = oldCase.mode === 'path';

  // Text query, no filter: the predicate short-circuits, the SQL is untouched,
  // so the SAME window must reproduce paths, ranks and scores exactly. This runs
  // for hybrid too — it is strictly stronger than the reachability check below,
  // which is why unfiltered hybrid cases skip that one.
  if (isUnfiltered(id) && !isPathCase) {
    if (newPaths.length !== oldPaths.length) {
      fail(id, `unfiltered result count changed ${oldPaths.length} -> ${newPaths.length}`);
      continue;
    }
    for (const [i, oldResult] of oldCase.results.entries()) {
      const newResult = newCase.results[i]!;
      if (newResult.path !== oldResult.path) {
        fail(id, `unfiltered rank ${i + 1} changed "${oldResult.path}" -> "${newResult.path}"`);
        break;
      }
      if (newResult.score !== oldResult.score) {
        fail(
          id,
          `unfiltered score drift at rank ${i + 1} (${oldResult.path}): ` +
            `${oldResult.score} -> ${newResult.score}`,
        );
        break;
      }
    }
    continue;
  }

  if (oldCase.mode === 'hybrid') {
    // Reachability, not window membership: old@10 must still be in new@WIDE.
    const wideIndex = new Map(wideCase.results.map((r, i) => [r.path, i]));
    const lost = oldPaths.filter((p) => !wideIndex.has(p));
    if (lost.length > 0) {
      fail(
        id,
        `${lost.length} old result(s) unreachable even at the widened limit ` +
          `(${wideCase.results.length} returned): ${lost.join(', ')}`,
      );
      continue;
    }
    for (const [i, p] of oldPaths.entries()) {
      const to = wideIndex.get(p)! + 1;
      if (to !== i + 1) displacements.push({ id, path: p, from: i + 1, to });
    }
    continue;
  }

  // Superset at the SAME window — measured to hold for every other mode.
  const dropped = oldPaths.filter((p) => !newIndex.has(p));
  if (dropped.length > 0) {
    fail(id, `dropped ${dropped.length} result(s): ${dropped.join(', ')}`);
    continue;
  }

  // Order among survivors — every non-hybrid mode.
  if (isPathCase || ORDERED_MODES.has(oldCase.mode)) {
    const orderBreak = findOrderBreak(oldPaths, newIndex);
    if (orderBreak) fail(id, orderBreak);
  }

  if (isPathCase && newPaths.length > oldPaths.length) {
    notes.push(`${id}: path lookup grew ${oldPaths.length} -> ${newPaths.length} (expected)`);
  }
}

for (const id of after.keys()) {
  if (!before.has(id)) notes.push(`${id}: new case, not present in the baseline`);
}

console.log(
  `compared ${before.size} baseline case(s) against ${after.size} narrow ` +
    `and ${afterWide.size} wide case(s)`,
);
for (const note of notes) console.log(`  note   ${note}`);

if (displacements.length > 0) {
  console.log(`\nhybrid displacement report (${displacements.length} moved, none lost):`);
  for (const d of displacements) {
    console.log(`  moved  ${d.id}: #${d.from} -> #${d.to}  ${d.path}`);
  }
}

if (violations.length > 0) {
  console.error(`\n${violations.length} VIOLATION(S):`);
  for (const v of violations) console.error(`  FAIL   ${v}`);
  process.exit(1);
}

console.log('\nOK - all invariants hold');
