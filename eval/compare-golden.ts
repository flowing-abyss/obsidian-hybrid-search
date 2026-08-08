/**
 * Compares two `capture-golden.ts` snapshots and asserts the filter-pushdown
 * invariants. Exits non-zero and prints the offending case ids on violation.
 *
 *   npx tsx eval/compare-golden.ts eval/results/golden-prechange.json /tmp/golden-post.json
 *
 * This is a script rather than a committed vitest test on purpose: it reads a
 * capture taken from `fixtures/<vault>/dataset`, and those fixture vaults are
 * gitignored, so a committed test could never run in CI.
 *
 * Invariants, per the filter-pushdown design:
 *
 *   - every case:                new results are a SUPERSET of the old ones.
 *                                Fixing the defect must add, never remove.
 *   - fulltext / title / semantic:
 *                                relative order of the surviving old paths is
 *                                preserved.
 *   - hybrid:                    superset only, order NOT required. RRF scores
 *                                by rank position within each arm; with the
 *                                predicate pushed down each arm now ranks
 *                                densely inside the filtered set, so positions
 *                                legitimately shift.
 *   - text query, no filter:     scores bit-identical. The predicate builder
 *                                short-circuits when empty, so the SQL is
 *                                unchanged. Drift means the short-circuit
 *                                leaked.
 *   - path lookup, no filter:    superset + order preserved among survivors,
 *                                but the count MAY GROW. Exclusions moved into
 *                                SQL unconditionally, so a hub note now fills
 *                                the whole `limit` instead of returning fewer.
 *                                Do not assert equality here.
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
const [beforePath, afterPath] = args;
if (!beforePath || !afterPath) {
  console.error('usage: tsx eval/compare-golden.ts <before.json> <after.json>');
  process.exit(2);
}

const load = (file: string): Map<string, Case> => {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as Case[];
  return new Map(parsed.map((c) => [c.id, c]));
};

const before = load(beforePath);
const after = load(afterPath);

const violations: string[] = [];
const notes: string[] = [];
const fail = (id: string, message: string): void => {
  violations.push(`${id}: ${message}`);
};

/** A case id encodes `query|mode|filter`; the path cases encode `path|filter`. */
const isUnfiltered = (id: string): boolean => id.endsWith('|no-filter');

for (const [id, oldCase] of before) {
  const newCase = after.get(id);
  if (!newCase) {
    fail(id, 'missing from the new capture');
    continue;
  }

  const oldPaths = oldCase.results.map((r) => r.path);
  const newPaths = newCase.results.map((r) => r.path);
  const newIndex = new Map(newPaths.map((p, i) => [p, i]));

  // 1. Superset — applies to every case.
  const dropped = oldPaths.filter((p) => !newIndex.has(p));
  if (dropped.length > 0) {
    // A drop out of a result set that was already at `limit` may be displacement
    // rather than loss: the wider filtered candidate pool can promote something
    // above the old tail. That is reported, not excused — a drop is a drop.
    const saturated = oldPaths.length === newPaths.length ? ' [old set was already full]' : '';
    fail(id, `dropped ${dropped.length} result(s)${saturated}: ${dropped.join(', ')}`);
    continue;
  }

  const isPathCase = oldCase.mode === 'path';
  const orderRequired = isPathCase || ORDERED_MODES.has(oldCase.mode);

  // 2. Order among survivors — every mode except hybrid.
  if (orderRequired) {
    const positions = oldPaths.map((p) => newIndex.get(p)!);
    for (let i = 1; i < positions.length; i++) {
      if (positions[i]! < positions[i - 1]!) {
        fail(
          id,
          `order broken among survivors: "${oldPaths[i - 1]}" (new #${positions[i - 1]! + 1}) ` +
            `now ranks after "${oldPaths[i]}" (new #${positions[i]! + 1})`,
        );
        break;
      }
    }
  }

  // 3. Unfiltered behaviour.
  if (isUnfiltered(id)) {
    if (isPathCase) {
      // Count may grow; superset + order were already checked above.
      if (newPaths.length > oldPaths.length) {
        notes.push(`${id}: path lookup grew ${oldPaths.length} -> ${newPaths.length} (expected)`);
      }
    } else {
      // Text query, no filter: the SQL is untouched, so scores must be bit-identical.
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
    }
  }
}

for (const id of after.keys()) {
  if (!before.has(id)) notes.push(`${id}: new case, not present in the baseline`);
}

console.log(`compared ${before.size} baseline case(s) against ${after.size} new case(s)`);
for (const note of notes) console.log(`  note   ${note}`);

if (violations.length > 0) {
  console.error(`\n${violations.length} VIOLATION(S):`);
  for (const v of violations) console.error(`  FAIL   ${v}`);
  process.exit(1);
}

console.log('\nOK - all invariants hold');
