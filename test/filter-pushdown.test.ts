import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

// ─── Vault setup (before any import that reads OBSIDIAN_VAULT_PATH) ──────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-pushdown-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// Every query embeds to the fixture's NEAR vector, so the vector arm ranks the 30
// "strong" notes at distance 0 and the needle notes (FAR) far outside any k. That is
// what makes the semantic assertions below discriminate: a needle can only appear if
// the filter reached sqlite-vec as a KNN PRE-filter.
vi.mock('../src/embedder.js', () => ({
  embed: vi.fn((texts: string[]) =>
    Promise.resolve(texts.map(() => new Float32Array([0.1, 0.2, 0.3, 0.4]))),
  ),
}));

// The suite runs with `isolate: false`, so a test file that loads searcher.js first
// leaves it bound to the REAL embedder and the mock above never takes effect — the
// vector arm then fails with a dimension mismatch against the 4-dim fixture. Reset the
// module graph so db.js, searcher.js and embedder.js are all instantiated fresh here.
vi.resetModules();

const { closeDb } = await import('../src/db.js');
const { search, searchFuzzyTitle } = await import('../src/searcher.js');
const { buildFilterPredicate } = await import('../src/filter-predicate.js');
const {
  seedPushdownVault,
  NEEDLE_PATHS,
  ALIAS_QUERY,
  ALIAS_INCLUDED_PATH,
  ALIAS_EXCLUDED_PATH,
  SRC_PATH,
  HUB_PATH,
  HUB_LINK_TARGETS,
} = await import('./fixtures/pushdown-vault.js');

/** Code-unit order, not localeCompare: these are paths, and SQLite orders them BINARY. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

beforeAll(() => {
  seedPushdownVault();
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('filter pushdown', () => {
  // Runs FIRST on purpose. Every pushdown assertion below is only meaningful while the
  // needle notes are unreachable without a filter; if this breaks, they all still pass
  // and prove nothing.
  it('fixture invariant: needle notes are outside the unfiltered top-5', async () => {
    for (const mode of ['fulltext', 'title', 'hybrid'] as const) {
      const top = await search('alpha', { mode, limit: 5 });
      assert.equal(top.length, 5, `${mode}: fixture did not produce a full top-5`);
      assert.ok(
        top.every((r) => !NEEDLE_PATHS.includes(r.path)),
        `${mode}: a needle note reached the unfiltered top-5 — every pushdown test below is now vacuous`,
      );
    }
  });

  it.each([['fulltext'], ['title']] as const)(
    '%s returns a needle note that cannot reach the unfiltered top-5',
    async (mode) => {
      const results = await search('alpha', { mode, tag: 'needle', limit: 5 });
      assert.ok(results.some((r) => NEEDLE_PATHS.includes(r.path)));
    },
  );

  it('frontmatter narrows the pool for a text query', async () => {
    const results = await search('alpha', { frontmatter: 'status:rare', limit: 5 });
    assert.ok(results.some((r) => NEEDLE_PATHS.includes(r.path)));
  });

  it('scope narrows the pool for a text query', async () => {
    const results = await search('alpha', { scope: 'deep', limit: 5 });
    assert.ok(results.length > 0);
    assert.ok(results.every((r) => r.path.startsWith('deep/')));
  });

  // The alias arm is the highest-risk forwarding site: exact alias hits enter RRF at
  // weight 2.0, so once the post-filter is gone an unfiltered one is undroppable. Both
  // notes answer to the same two-character alias, which the trigram index cannot
  // tokenize — searchByAliasExact is the ONLY arm that can return them, so this test
  // fails the moment searchFuzzyTitle stops forwarding its predicate to it.
  it('the alias arm applies the predicate', () => {
    const unfiltered = searchFuzzyTitle(ALIAS_QUERY, 10).map((r) => r.path);
    assert.deepEqual(
      unfiltered.sort(byCodeUnit),
      [ALIAS_EXCLUDED_PATH, ALIAS_INCLUDED_PATH].sort(byCodeUnit),
      'the alias arm did not fire at all — the assertion below would pass vacuously',
    );

    const filtered = searchFuzzyTitle(ALIAS_QUERY, 10, buildFilterPredicate({ tag: 'work' }));
    assert.deepEqual(
      filtered.map((r) => r.path),
      [ALIAS_INCLUDED_PATH],
    );
  });

  // sqlite-vec honours `chunk_id IN (subquery)` as a KNN PRE-filter. The correlated
  // EXISTS form the FTS arms use silently degrades to a POST-filter here and returns
  // zero rows. The needle notes sit far from the source vector, so they can only appear
  // if the restriction was applied before k was taken.
  it('semantic pre-filters: matches outside the global top-k still appear', async () => {
    const unfiltered = await search('', { notePath: SRC_PATH, limit: 3 });
    assert.equal(unfiltered.length, 3, 'precondition: the unfiltered lookup must be full');
    assert.ok(
      unfiltered.every((r) => !NEEDLE_PATHS.includes(r.path)),
      'a needle reached the unfiltered top-3 — the filtered assertion below is vacuous',
    );
    const filtered = await search('', { notePath: SRC_PATH, tag: 'needle', limit: 3 });
    assert.ok(filtered.some((r) => NEEDLE_PATHS.includes(r.path)));
  });

  it('mode:semantic pre-filters too', async () => {
    const unfiltered = await search('alpha', { mode: 'semantic', limit: 3 });
    assert.equal(unfiltered.length, 3, 'precondition: the semantic arm must return results');
    assert.ok(
      unfiltered.every((r) => !NEEDLE_PATHS.includes(r.path)),
      'a needle reached the unfiltered semantic top-3 — the assertion below is vacuous',
    );
    const results = await search('alpha', { mode: 'semantic', tag: 'needle', limit: 3 });
    assert.ok(results.some((r) => NEEDLE_PATHS.includes(r.path)));
  });

  it('hybrid pre-filters too', async () => {
    const results = await search('alpha', { mode: 'hybrid', tag: 'needle', limit: 5 });
    assert.ok(results.some((r) => NEEDLE_PATHS.includes(r.path)));
  });

  // Behaviour change, accepted: exclusions live in SQL now, so they narrow the pool the
  // KNN scans instead of eating into an already-truncated top-N. The user asked for 5
  // and gets 5.
  it('excludes the source and its links without shrinking the result count', async () => {
    const results = await search('', { notePath: HUB_PATH, limit: 5 });
    assert.ok(results.every((r) => r.path !== HUB_PATH));
    assert.ok(results.every((r) => !HUB_LINK_TARGETS.includes(r.path)));
    assert.equal(results.length, 5);
  });

  // Characterization: pre-existing and deliberate. Tag matching is by SUBSTRING, so a
  // filter of "meta" also matches "metadata". Changing this is a separate decision with
  // its own effect on results — see the 2026-08-08 filter-pushdown spec.
  it('tag filter matches by substring: "meta" also matches "metadata"', async () => {
    const paths = (await search('alpha', { tag: 'meta', limit: 20 })).map((r) => r.path);
    assert.ok(paths.includes('tagged-meta.md'.normalize('NFD')));
    assert.ok(paths.includes('tagged-metadata.md'.normalize('NFD')));
  });
});
