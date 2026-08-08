import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-predicate-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const {
  closeDb,
  openDb,
  initVecTable,
  upsertNote,
  getDb,
  filterNotePathsByTag,
  filterNotePathsByFrontmatter,
} = await import('../src/db.js');
const { buildFilterPredicate, hasFilterValue } = await import('../src/filter-predicate.js');
const { matchesScopeFilter } = await import('../src/searcher.js');

/**
 * 'новый' in precomposed (NFC) form: 'й' is U+0439, which NFD decomposes to
 * 'и' (U+0438) + combining breve (U+0306). Written with an escape so the literal
 * cannot be silently normalized by an editor or a formatter.
 */
const NFC_NOVY = 'новы\u0439';

const NOTES = [
  {
    path: 'base/notes/alpha.md',
    tags: ['mark/aggregator', 'category/r'],
    fm: { status: 'active' },
  },
  { path: 'base/notes/beta.md', tags: ['metadata'], fm: { status: 'done' } },
  { path: 'base/notes/gamma.md', tags: ['meta'], fm: {} },
  { path: 'base/_hierarchy/delta.md', tags: ['mark/aggregator'], fm: { status: 'active' } },
  { path: 'my_notes/one.md', tags: [], fm: {} },
  { path: 'myXnotes/two.md', tags: [], fm: {} },
  { path: "od'd/quote.md", tags: [], fm: {} },
  { path: '100%/percent.md', tags: [], fm: {} },
  { path: 'проекты/новый.md', tags: ['mark/aggregator'], fm: { status: '🟦' } },
  { path: 'top.md', tags: [], fm: {} },
  // Decomposing fixture. Every other value here is NFD-invariant, so without this row
  // all three normalization decisions are untestable: adding NFD to the frontmatter
  // clause, or removing it from the tag or scope clause, would each go unnoticed.
  { path: `${NFC_NOVY}/декомп.md`, tags: [`проект/${NFC_NOVY}`], fm: { status: NFC_NOVY } },
];

/**
 * SQLite compares `notes.path` with BINARY collation, so the expected arrays must be
 * ordered by code unit too — localeCompare would order 'my_notes' before 'myXnotes'
 * while `ORDER BY n.path` does the reverse.
 */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

const ALL = NOTES.map((n) => n.path.normalize('NFD')).sort(byCodeUnit);

beforeAll(() => {
  openDb();
  initVecTable(4);
  for (const n of NOTES) {
    upsertNote({
      path: n.path.normalize('NFD'),
      title: n.path,
      tags: n.tags,
      frontmatter: n.fm,
      content: 'content',
      mtime: Date.now(),
      hash: 'h-' + n.path,
      chunks: [{ text: 'content', embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]) }],
    });
  }
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

type FilterOptions = Parameters<typeof buildFilterPredicate>[0];

/**
 * The JS oracle for multi-kind cases: the same three reference implementations, gated
 * per kind exactly the way searcher.ts gates them (hasFilterValue once per kind, in
 * scope -> tag -> frontmatter order).
 */
function viaJs(options: FilterOptions): string[] {
  let paths = [...ALL];
  if (hasFilterValue(options.scope)) {
    const scope = options.scope!;
    paths = paths.filter((p) => matchesScopeFilter(p, scope));
  }
  if (hasFilterValue(options.tag)) {
    const allowed = filterNotePathsByTag(paths, options.tag!);
    paths = paths.filter((p) => allowed.has(p));
  }
  if (hasFilterValue(options.frontmatter)) {
    const allowed = filterNotePathsByFrontmatter(paths, options.frontmatter!);
    paths = paths.filter((p) => allowed.has(p));
  }
  return paths.sort(byCodeUnit);
}

function viaPredicate(options: FilterOptions): string[] {
  const p = buildFilterPredicate(options);
  const rows = getDb()
    .prepare(`SELECT n.path FROM notes n WHERE ${p.isEmpty ? '1' : p.sql} ORDER BY n.path`)
    .all(...p.params) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

describe('buildFilterPredicate — tag parity', () => {
  it.each([
    ['mark/aggregator'],
    ['meta'],
    [['mark/aggregator', 'category/r']],
    ['-mark/aggregator'],
    [['mark/aggregator', '-category/r']],
    [['']],
    [['', 'meta']],
    // NFD: the tag is stored via normalizeTag (NFD + lowercase), so a precomposed
    // query value only matches because tagClause normalizes it too.
    [`проект/${NFC_NOVY}`],
  ])('tag %j matches filterNotePathsByTag', (tag) => {
    const expected = [...filterNotePathsByTag(ALL, tag)].sort(byCodeUnit);
    assert.deepEqual(viaPredicate({ tag }), expected);
  });
});

describe('buildFilterPredicate — frontmatter parity', () => {
  it.each([
    ['status:active'],
    ['status:🟦'],
    ['-status:active'],
    [['status:active', '-status:done']],
    ['not-a-pair'],
    ['-not-a-pair'],
    [['-not-a-pair', '-also-bad']],
    // NFD: value_norm is written lowercase-only, so the query must NOT normalize.
    [`status:${NFC_NOVY}`],
    [`-status:${NFC_NOVY}`],
  ])('frontmatter %j matches filterNotePathsByFrontmatter', (fm) => {
    const expected = [...filterNotePathsByFrontmatter(ALL, fm)].sort(byCodeUnit);
    assert.deepEqual(viaPredicate({ frontmatter: fm }), expected);
  });
});

describe('buildFilterPredicate — scope parity', () => {
  it.each([
    ['base/notes'],
    ['base/notes/'],
    ['base'],
    ['base/note'],
    ['my_notes'],
    ['100%'],
    ["od'd"],
    ['проекты'],
    ['-base/notes'],
    [['base/notes', 'base/_hierarchy']],
    // NFD: paths are stored NFD-normalized, so a precomposed scope only matches
    // because scopeClause normalizes it.
    [NFC_NOVY],
    // Scoping to a single note, which is the only case that exercises the `n.path = ?`
    // term — every other scope value here is a directory and no stored path is.
    ['top.md'],
  ])('scope %j matches matchesScopeFilter', (scope) => {
    const expected = ALL.filter((p) => matchesScopeFilter(p, scope)).sort(byCodeUnit);
    assert.deepEqual(viaPredicate({ scope }), expected);
  });
});

describe('buildFilterPredicate — cross-kind composition', () => {
  it.each([
    // Composition itself: an untagged note under the second scope must be excluded by
    // the tag filter. Drop the parentheses around the scope OR-group and this binds as
    // `tag AND s1 OR s2`, returning everything under s2 regardless of tag.
    [{ tag: 'mark/aggregator', scope: ['base/notes', 'my_notes'] }],
    [{ tag: 'mark/aggregator', scope: ['base/notes', 'проекты'] }],
    [{ frontmatter: 'status:active', scope: 'base' }],
    [{ tag: 'mark/aggregator', frontmatter: 'status:active', scope: 'base' }],
    // Per-kind presence. An absent kind (empty string) must contribute NO clause even
    // when another kind keeps the predicate alive. Expanding it anyway is not a no-op:
    // `tag: ''` becomes `LIKE '%%'` = "has any tag" and drops my_notes/one.md;
    // `frontmatter: ''` parses as no valid pair and collapses the whole thing to `0`;
    // `scope: ''` becomes an empty prefix range that matches almost nothing.
    [{ tag: '', scope: 'my_notes' }],
    [{ frontmatter: '', scope: 'my_notes' }],
    [{ scope: '', tag: 'meta' }],
    [{ tag: [], frontmatter: 'status:active' }],
  ])('%j matches the per-kind JS pipeline', (options) => {
    assert.deepEqual(viaPredicate(options), viaJs(options));
  });
});

describe('buildFilterPredicate — documented divergence from matchesScopeFilter', () => {
  /**
   * INTENTIONAL, and the only place the builder and matchesScopeFilter disagree.
   *
   * scopeClause strips a trailing '/' before building the range, so `scope: 'top.md/'`
   * is treated as `scope: 'top.md'` and matches the note. matchesScopeFilter does not
   * strip: it tests `path === 'top.md/'` or `path.startsWith('top.md/')`, both false.
   *
   * The builder's reading is the sensible one (a stray trailing slash on a scope should
   * not silently return nothing), and stripping is also required for directory scopes —
   * without it, 'notes/' would build the empty range 'notes//'..'notes/0'. Unreachable
   * for directory scopes since the indexer only stores '.md' paths; reachable only for
   * a file path typed with a trailing slash, as here. Asserted directly rather than by
   * parity, because there is no reference to be at parity with.
   */
  it('treats a trailing slash on a file scope as the file itself', () => {
    assert.deepEqual(viaPredicate({ scope: 'top.md/' }), ['top.md']);
    assert.deepEqual(
      ALL.filter((p) => matchesScopeFilter(p, 'top.md/')),
      [],
    );
  });
});
