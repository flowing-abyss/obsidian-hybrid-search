import { initVecTable, openDb, upsertLinks, upsertNote } from '../../src/db.js';

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
  for (const p of NEEDLE_PATHS) {
    note(
      p,
      ['needle'],
      'alpha mentioned once',
      FAR,
      { status: 'rare' },
      `weak note that mentions alpha once ${p}`,
    );
  }
  note('tagged-meta.md'.normalize('NFD'), ['meta'], 'alpha', FAR);
  note('tagged-metadata.md'.normalize('NFD'), ['metadata'], 'alpha', FAR);
  note('deep/inside.md'.normalize('NFD'), [], 'alpha deep', FAR);

  note(SRC_PATH, [], 'alpha source', NEAR);
  note(HUB_PATH, [], 'alpha hub', NEAR);
  for (const t of HUB_LINK_TARGETS) note(t, [], 'alpha linked', NEAR);
  upsertLinks(HUB_PATH, HUB_LINK_TARGETS);
}
