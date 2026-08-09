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
// Imported from the SAME post-reset module graph searcher.js was, so the rerank guard
// below can spy on the very singleton searcher.js captured. Deliberately NOT a
// `vi.mock('../src/reranker.js', …)`: with `isolate: false` the mocked module stays in
// the shared cache, and test/searcher.test.ts — which spies on the real singleton —
// then silently gets this file's stub instead and fails depending on file order.
const { reranker } = await import('../src/reranker.js');
const {
  seedPushdownVault,
  NEEDLE_PATHS,
  ALIAS_QUERY,
  ALIAS_INCLUDED_PATH,
  ALIAS_EXCLUDED_PATH,
  SRC_PATH,
  HUB_PATH,
  HUB_LINK_TARGETS,
  HUB2_PATH,
  HUB2_TAG,
  HUB2_LINKS,
  HUB2_FAR,
  HUB_RELATED_NEEDLE,
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

  // The test above passes under a POST-filter too: HUB's excluded set is smaller than
  // the k window, so survivors remain either way. This one does not. HUB2's excluded
  // set (itself + 40 links, all at distance 0) fills the whole window, and the only
  // other candidates are far away — so a post-filtering exclusion returns NOTHING.
  //
  // Measured against the NOT IN form this replaced: 0 results here, 5 now. sqlite-vec's
  // key optimization recognizes `chunk_id IN (...)` and NOT `chunk_id NOT IN (...)`,
  // which is why the exclusion has to live inside the positive subquery.
  it('excludes links as a PRE-filter, not after k is taken', async () => {
    const unfiltered = await search('', { notePath: HUB2_PATH, tag: HUB2_TAG, limit: 5 });
    assert.equal(
      unfiltered.length,
      5,
      'a post-filtering exclusion returns 0 here because the links fill the k window',
    );
    assert.ok(unfiltered.every((r) => HUB2_FAR.includes(r.path)));
    assert.ok(unfiltered.every((r) => r.path !== HUB2_PATH));
    assert.ok(unfiltered.every((r) => !HUB2_LINKS.includes(r.path)));
  });

  // ─── Guards for the machinery that survived the post-filter removal ────────
  //
  // The pushdown moved tag/scope/frontmatter into SQL. These pin the things that did
  // NOT move and could therefore have been dropped along with it.

  // `related` bypasses the retrieval pipeline entirely, so it keeps its own JS-side
  // filtering. HUB links to 12 untagged targets plus one needle, so the filtered set
  // is a non-empty PROPER subset — an implementation that dropped the filter returns
  // all 14, one that filtered everything away returns 0, and both fail.
  it('related mode still honours filters after the post-filter removal', async () => {
    const all = await search('', { notePath: HUB_PATH, related: true });
    assert.ok(all.length > 1, 'precondition: the unfiltered related set must be wide');
    assert.ok(all.some((r) => r.path === HUB_RELATED_NEEDLE));

    const tagged = await search('', { notePath: HUB_PATH, related: true, tag: 'needle' });
    assert.deepEqual(
      tagged.map((r) => r.path),
      [HUB_RELATED_NEEDLE],
    );
    assert.ok(all.length > tagged.length);
  });

  // `threshold` is a score cutoff and cannot be expressed as a predicate over `notes`,
  // so it stayed in JS. The cut is taken BETWEEN the surviving scores on purpose: a
  // hard-coded 0.99 would return 0 rows, and "0 < 3" is also what a threshold that
  // rejected everything would produce.
  it('threshold still applies alongside a filter', async () => {
    const loose = await search('alpha', { tag: 'needle', limit: 20, threshold: 0 });
    assert.equal(loose.length, NEEDLE_PATHS.length);
    const scores = loose.map((r) => r.score);
    assert.ok(
      scores[0]! > scores[scores.length - 1]!,
      'precondition: filtered scores must differ, or no cut can separate them',
    );

    const cut = (scores[0]! + scores[scores.length - 1]!) / 2;
    const strict = await search('alpha', { tag: 'needle', limit: 20, threshold: cut });
    assert.ok(strict.length > 0, 'the cut sits between real scores, so some must survive');
    assert.ok(strict.length < loose.length);
    assert.ok(strict.every((r) => r.score >= cut));
  });

  // Reranking runs on the retrieval output, which is now already narrowed. Asserting
  // only that the results are needles would pass even if rerank never ran, so this
  // checks the stub was invoked, that the pool handed to it was the filtered one, and
  // that the returned score is the blended value rather than the raw RRF score.
  it('rerank works on a filtered pool', async () => {
    // Constant logits are enough — what has to be pinned is that reranking RAN and
    // that the pool handed to it was the filtered one. The real cross-encoder would
    // download ~570 MB.
    const scoreAll = vi
      .spyOn(reranker, 'scoreAll')
      .mockImplementation((_query, candidates) => Promise.resolve(candidates.map(() => 0)));
    try {
      const results = await search('alpha', {
        mode: 'hybrid',
        tag: 'needle',
        limit: 5,
        rerank: true,
      });

      assert.equal(scoreAll.mock.calls.length, 1, 'rerank was silently skipped');
      assert.equal(
        scoreAll.mock.calls[0]![1].length,
        NEEDLE_PATHS.length,
        'rerank saw an unfiltered pool',
      );

      assert.ok(results.length > 0);
      assert.ok(results.every((r) => NEEDLE_PATHS.includes(r.path)));
      // 0.75 * normalizedHybrid + 0.25 * sigmoid(0); the top candidate normalizes to 1.
      assert.ok(
        Math.abs(results[0]!.score - (0.75 + 0.25 * 0.5)) < 1e-6,
        `expected the blended rerank score, got ${results[0]!.score}`,
      );
    } finally {
      scoreAll.mockRestore();
    }
  });

  // Unparsable frontmatter must match NOTHING, not silently degrade to "no filter".
  // Degrading would fill the top-5 with the strong notes, so a length of 0 is the
  // only outcome that distinguishes the two.
  it('a frontmatter filter that parses to nothing matches nothing', async () => {
    const unfiltered = await search('alpha', { limit: 5 });
    assert.equal(unfiltered.length, 5, 'precondition: the query must match without the filter');
    const results = await search('alpha', { frontmatter: 'not-a-pair', limit: 5 });
    assert.equal(results.length, 0);
  });

  // limit 0 means "no limit". Retrieval still needs a finite pool, so the pushdown
  // gave it a ceiling — this pins that the ceiling did not become a literal 0.
  it('limit 0 returns every match rather than nothing', async () => {
    const results = await search('alpha', { tag: 'needle', limit: 0 });
    assert.equal(results.length, NEEDLE_PATHS.length);
  });

  // The fan-out builds the predicate once in search() and threads it into each
  // sub-search. A non-empty `input` is required: with '' the filter-only branch
  // short-circuits before the fan-out and the test would never touch it. "strong"
  // matches the 30 strong notes and no needle, so an unforwarded predicate puts a
  // strong note at rank 1.
  it('multi-query fan-out receives the filter', async () => {
    const unfiltered = await search('alpha', { queries: ['alpha', 'strong'], limit: 5 });
    assert.equal(unfiltered.length, 5, 'precondition: the fan-out must return results');
    assert.ok(
      unfiltered.every((r) => !NEEDLE_PATHS.includes(r.path)),
      'a needle reached the unfiltered fan-out top-5 — the assertion below is vacuous',
    );

    const results = await search('alpha', {
      queries: ['alpha', 'strong'],
      tag: 'needle',
      limit: 5,
    });
    assert.equal(results.length, NEEDLE_PATHS.length);
    assert.ok(results.every((r) => NEEDLE_PATHS.includes(r.path)));
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
