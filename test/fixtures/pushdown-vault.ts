import { initVecTable, openDb, upsertLinks, upsertNote } from '../../src/db.js';

/**
 * Alias-arm fixture. Both notes answer to the SAME alias, and it is two characters long
 * so the trigram index cannot tokenize it — the only arm that can return them is
 * searchByAliasExact. Their titles and content deliberately avoid the token "alpha", so
 * they stay outside every other test's pool and cannot perturb the top-5 invariant.
 *
 * Exact alias hits enter RRF at weight 2.0. Once the post-filter is gone, an alias hit
 * that skipped the predicate is undroppable — it lands at or near rank 1 for a query
 * whose filter should have excluded it.
 */
export const ALIAS_QUERY = 'pm';
export const ALIAS_INCLUDED_PATH = 'work/notes.md'.normalize('NFD');
export const ALIAS_EXCLUDED_PATH = 'personal/notes.md'.normalize('NFD');

/** Notes carrying the `needle` tag. All rank BELOW the top-5 for the query "alpha"
 *  when unfiltered, which is what makes the pushdown tests discriminate. */
export const NEEDLE_PATHS = ['weak/needle-1.md', 'weak/needle-2.md', 'weak/needle-3.md'].map((p) =>
  p.normalize('NFD'),
);

export const SRC_PATH = 'src-note.md'.normalize('NFD');
export const HUB_PATH = 'hub.md'.normalize('NFD');
export const HUB_LINK_TARGETS = Array.from({ length: 12 }, (_, i) =>
  `linked/target-${i}.md`.normalize('NFD'),
);

const NEAR = new Float32Array([0.1, 0.2, 0.3, 0.4]);
const FAR = new Float32Array([0.9, 0.1, 0.0, 0.0]);

/**
 * One vector per needle note, parallel to NEEDLE_PATHS. All three are far from NEAR
 * (so the needles stay outside every unfiltered top-N, which is what the pushdown
 * tests rest on) but at three DISTINCT distances, and their distance order is not
 * their declaration order — needle-2 is nearest, then needle-3, then needle-1.
 *
 * That asymmetry is deliberate: test/knn-prefilter-oracle.test.ts asserts the exact
 * ranking sqlite-vec returns inside the filtered set. With one shared vector every
 * needle would tie, the oracle's sort would be a stable no-op, and the ordering half
 * of the assertion would prove nothing. None of these is unit-length, which is also
 * deliberate — it is what makes plain cosine disagree with the `1 - L2²/2` expression
 * searchVector actually uses.
 */
const NEEDLE_VECS = [
  FAR,
  new Float32Array([0.6, 0.2, 0.1, 0.1]),
  new Float32Array([0.75, 0.15, 0.05, 0.0]),
];

/** A needle note that HUB also links to, so `related` + `tag` yields a non-empty
 *  PROPER subset of the unfiltered related set rather than an empty one. */
export const HUB_RELATED_NEEDLE = NEEDLE_PATHS[1]!;

/**
 * Seeds a vault where, for the query "alpha" and the source vector NEAR:
 *   - 30 "strong" notes match the text strongly and sit at distance 0 — they fill any
 *     unfiltered top-N;
 *   - the needle notes match weakly and sit far away, so they can ONLY appear if the
 *     filter reached the retrieval query rather than the truncated result list.
 *
 * Deviation from the brief, deliberate: the brief seeded `title: path`, but
 * `notes_fts_fuzzy` indexes ONLY (title, aliases) — with paths as titles, no title-mode
 * query for "alpha" matches anything at all and the title arm's pushdown test can never
 * pass, filtered or not. Titles therefore carry the query term, with the same strong /
 * weak term-frequency split as the content so the "outside the unfiltered top-5"
 * invariant holds for the title arm too (asserted in test/filter-pushdown.test.ts).
 */
/** A second hub whose EXCLUDED set (itself + its links) is large enough to fill the
 *  entire KNN k-window at distance 0, while the only other candidates sit far away.
 *  That is what makes the exclusion test discriminate: under a POST-filter the window
 *  is consumed by links and the query returns nothing; only a PRE-filter reaches the
 *  far notes. Everything in this cluster shares one tag so a predicate can isolate it
 *  from the rest of the fixture. */
export const HUB2_PATH = 'hub2.md'.normalize('NFD');
export const HUB2_TAG = 'hubcluster';
export const HUB2_LINKS = Array.from({ length: 40 }, (_, i) =>
  `h2linked/l${i}.md`.normalize('NFD'),
);
export const HUB2_FAR = Array.from({ length: 6 }, (_, i) => `h2far/f${i}.md`.normalize('NFD'));

export function seedPushdownVault(): void {
  openDb();
  initVecTable(4);

  const note = (
    path: string,
    tags: string[],
    content: string,
    embedding: Float32Array,
    frontmatter: Record<string, unknown> = {},
    title: string = path,
  ): void => {
    upsertNote({
      path,
      title,
      tags,
      frontmatter,
      content,
      mtime: Date.now(),
      hash: 'h-' + path,
      chunks: [{ text: content, embedding }],
    });
  };

  for (let i = 0; i < 30; i++) {
    note(
      `strong/doc-${i}.md`.normalize('NFD'),
      [],
      'alpha alpha alpha strong',
      NEAR,
      {},
      `alpha alpha alpha strong doc ${i}`,
    );
  }
  for (const [i, p] of NEEDLE_PATHS.entries()) {
    note(
      p,
      ['needle'],
      'alpha mentioned once',
      NEEDLE_VECS[i]!,
      { status: 'rare' },
      `weak note that mentions alpha once ${p}`,
    );
  }
  note('tagged-meta.md'.normalize('NFD'), ['meta'], 'alpha', FAR);
  note('tagged-metadata.md'.normalize('NFD'), ['metadata'], 'alpha', FAR);
  note('deep/inside.md'.normalize('NFD'), [], 'alpha deep', FAR);

  for (const [p, tag] of [
    [ALIAS_INCLUDED_PATH, 'work'],
    [ALIAS_EXCLUDED_PATH, 'personal'],
  ] as const) {
    upsertNote({
      path: p,
      title: p,
      tags: [tag],
      aliases: [ALIAS_QUERY],
      frontmatter: {},
      content: 'aliased note, deliberately without the shared query token',
      mtime: Date.now(),
      hash: 'h-' + p,
      chunks: [{ text: 'aliased note', embedding: FAR }],
    });
  }

  note(SRC_PATH, [], 'alpha source', NEAR);
  note(HUB_PATH, [], 'alpha hub', NEAR);
  for (const t of HUB_LINK_TARGETS) note(t, [], 'alpha linked', NEAR);
  // HUB_RELATED_NEEDLE is linked too, but deliberately kept OUT of HUB_LINK_TARGETS:
  // the exclusion tests assert only that HUB's links are absent, while the related
  // guard needs one linked note that a tag filter can single out.
  upsertLinks(HUB_PATH, [...HUB_LINK_TARGETS, HUB_RELATED_NEEDLE]);

  // Second hub. Deliberately free of the token "alpha" so it cannot perturb the
  // fixture invariant that the needle notes stay outside the unfiltered top-5.
  note(HUB2_PATH, [HUB2_TAG], 'hub cluster root', NEAR);
  for (const t of HUB2_LINKS) note(t, [HUB2_TAG], 'hub cluster member', NEAR);
  for (const f of HUB2_FAR) note(f, [HUB2_TAG], 'hub cluster distant', FAR);
  upsertLinks(HUB2_PATH, HUB2_LINKS);
}
