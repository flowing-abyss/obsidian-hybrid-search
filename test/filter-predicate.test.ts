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
const { buildFilterPredicate } = await import('../src/filter-predicate.js');
const { matchesScopeFilter } = await import('../src/searcher.js');

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

function viaPredicate(options: Parameters<typeof buildFilterPredicate>[0]): string[] {
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
  ])('scope %j matches matchesScopeFilter', (scope) => {
    const expected = ALL.filter((p) => matchesScopeFilter(p, scope)).sort(byCodeUnit);
    assert.deepEqual(viaPredicate({ scope }), expected);
  });
});
