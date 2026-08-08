import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-searcher-similar-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
vi.resetModules();

const dbModule = await import('../src/db.js');
const { closeDb, openDb, initVecTable, upsertNote, upsertLinks } = dbModule;

// Mock embedder before importing searcher so live bindings pick up the mock
const embedder = await import('../src/embedder.js');
const embedSpy = vi
  .spyOn(embedder, 'embed')
  .mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);

const { search, bumpIndexVersion } = await import('../src/searcher.js');

beforeAll(() => {
  openDb();
  initVecTable(4);

  // Note with embeddings — target for similarity search
  upsertNote({
    path: 'target.md',
    title: 'Target Note',
    tags: [],
    content: 'This is target content about knowledge management.',
    mtime: Date.now(),
    hash: 'hash-target',
    chunks: [
      {
        text: 'This is target content about knowledge management.',
        embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      },
    ],
  });

  // Note without embeddings (empty chunks) — triggers fallback re-embedding path
  upsertNote({
    path: 'no-embed.md',
    title: 'No Embed Note',
    tags: [],
    content: 'This note has no chunk embeddings.',
    mtime: Date.now(),
    hash: 'hash-no-embed',
    chunks: [],
  });

  // Tagged notes for filter-resolution tests. Deliberately LOW similarity to
  // target.md so they never survive an unfiltered top-N cut — this is what
  // reproduces the defect.
  upsertNote({
    path: 'meta-note.md',
    title: 'Meta Note',
    tags: ['system/meta'],
    content: 'An aggregator note.',
    mtime: Date.now(),
    hash: 'hash-meta',
    chunks: [{ text: 'An aggregator note.', embedding: new Float32Array([0.9, 0.1, 0.0, 0.0]) }],
  });
  for (let i = 0; i < 20; i++) {
    upsertNote({
      path: `filler-${i}.md`,
      title: `Filler ${i}`,
      tags: [],
      content: `Filler content ${i}.`,
      mtime: Date.now(),
      hash: `hash-filler-${i}`,
      chunks: [{ text: `Filler content ${i}.`, embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]) }],
    });
  }
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('searchSimilar fallback', () => {
  it('finds similar notes for a note without stored embeddings', async () => {
    const results = await search('no-embed.md', {
      notePath: 'no-embed.md',
      limit: 5,
    });
    // Should return target.md (excludes self)
    assert.ok(results.length > 0, 'expected at least one similar note');
    assert.ok(
      results.some((r) => r.path === 'target.md'),
      'expected target.md in results',
    );
    // Source note itself should be excluded
    assert.ok(!results.some((r) => r.path === 'no-embed.md'), 'source note should be excluded');
  });
});

describe('path lookup combined with filters', () => {
  it('finds a tagged note that would not survive an unfiltered top-N cut', async () => {
    const results = await search('', {
      notePath: 'target.md',
      tag: 'system/meta',
      limit: 3,
    });
    assert.ok(
      results.some((r) => r.path === 'meta-note.md'),
      'expected meta-note.md — it is the only note with the tag, so the filter must ' +
        'be applied to the candidate pool, not to an already-truncated top-3',
    );
    assert.ok(
      results.every((r) => r.path !== 'target.md'),
      'source note must stay excluded',
    );
  });

  it('treats an empty-string filter as absent, not as a filter', async () => {
    // Pins the ONE semantics of hasFilterValue(). `tag: ''` used to be "present"
    // for the candidate-pool decision and "absent" for every filter that actually
    // runs — same answer, needless whole-vault resolution. Now it is absent
    // everywhere, so the two calls must be indistinguishable.
    const withEmptyTag = await search('', { notePath: 'target.md', tag: '', limit: 5 });
    const withNoTag = await search('', { notePath: 'target.md', limit: 5 });
    assert.deepEqual(
      withEmptyTag.map((r) => r.path),
      withNoTag.map((r) => r.path),
      "tag: '' must behave exactly as if no tag filter were given",
    );
    assert.ok(withNoTag.length > 0, 'expected a non-empty baseline for the comparison');
  });

  it('returns nothing when the filter matches no note', async () => {
    const results = await search('', {
      notePath: 'target.md',
      tag: 'system/does-not-exist',
      limit: 5,
    });
    assert.equal(results.length, 0);
  });
});

describe('scope and frontmatter arms of the filter resolver', () => {
  // Both arms had zero coverage: every other test drives the tag arm, so a
  // truncating limit in the frontmatter arm (the exact mistake the code comment
  // warns about) would have passed the whole suite silently.
  const far = new Float32Array([0.9, 0.1, 0.0, 0.0]);
  // Closer to target.md than `far`, but still strictly worse than the 21 notes
  // sitting at distance 0 — so it ranks #1 within the filtered set while being
  // unable to survive an unfiltered top-3.
  const middling = new Float32Array([0.2, 0.3, 0.4, 0.5]);

  beforeAll(() => {
    // Scope arm: one low-similarity note under projects/. The 20 fillers all sit
    // at distance 0 from target.md, so this can only surface if the scope filter
    // narrows the CANDIDATE POOL rather than an already-truncated top-N.
    upsertNote({
      path: 'projects/scoped-note.md',
      title: 'Scoped Note',
      tags: [],
      content: 'A scoped project note.',
      mtime: Date.now(),
      hash: 'hash-scoped',
      chunks: [{ text: 'A scoped project note.', embedding: far }],
    });

    // Frontmatter arm: 24 far notes plus one middling note that sorts LAST by
    // title. Two properties make this test discriminating:
    //   - `middling` scores below the 21 distance-0 notes, so it cannot survive an
    //     unfiltered top-3 -> catches the filter-after-truncation defect.
    //   - it sorts last by title among the 25 frontmatter matches, and
    //     getMatchingNotesByFrontmatter orders by title ASC, so any LIMIT other
    //     than -1 drops it -> catches the `-1` regression the comment warns about.
    for (let i = 0; i < 24; i++) {
      upsertNote({
        path: `fm/filler-${i}.md`,
        title: `FM Filler ${String(i).padStart(2, '0')}`,
        tags: [],
        content: `FM filler ${i}.`,
        frontmatter: { status: 'active' },
        mtime: Date.now(),
        hash: `hash-fm-filler-${i}`,
        chunks: [{ text: `FM filler ${i}.`, embedding: far }],
      });
    }
    upsertNote({
      path: 'fm/zz-target.md',
      title: 'Zz FM Target',
      tags: [],
      content: 'The frontmatter note that must survive.',
      frontmatter: { status: 'active' },
      mtime: Date.now(),
      hash: 'hash-fm-zz',
      chunks: [{ text: 'The frontmatter note that must survive.', embedding: middling }],
    });
  });

  it('finds a scoped note that would not survive an unfiltered top-N cut', async () => {
    // projects/scoped-note.md sits at `far` while the 20 fillers sit at distance 0, so
    // it can only appear if the scope predicate reached the KNN as a pre-filter — a
    // post-filter over a top-3 would have discarded it before the filter ever ran.
    bumpIndexVersion();
    const results = await search('', { notePath: 'target.md', scope: 'projects', limit: 3 });
    assert.ok(
      results.some((r) => r.path === 'projects/scoped-note.md'),
      'expected projects/scoped-note.md — the scope filter must narrow the candidate pool',
    );
    assert.ok(
      results.every((r) => r.path.startsWith('projects/')),
      'scope filter must exclude everything outside projects/',
    );
  });

  it('finds a frontmatter-matched note that sorts past any truncating limit', async () => {
    const results = await search('', {
      notePath: 'target.md',
      frontmatter: 'status:active',
      limit: 3,
    });
    assert.ok(
      results.some((r) => r.path === 'fm/zz-target.md'),
      'expected fm/zz-target.md — it sorts last by title among 25 frontmatter matches, so ' +
        'any LIMIT other than -1 in resolveFilteredPaths drops it',
    );
  });

  it('returns nothing when the scope matches no note', async () => {
    const results = await search('', { notePath: 'target.md', scope: 'no-such-dir', limit: 5 });
    assert.equal(results.length, 0);
  });
});

describe('dimension mismatch on the filtered path', () => {
  // no-embed.md has no stored chunks, so getSimilaritySource re-embeds it. If the
  // configured model's dimension differs from the indexed one, comparing the
  // overlapping prefix would report an INFLATED similarity. The scan must fail
  // closed instead, matching the KNN path (sqlite-vec throws -> searchVector []).
  it('scores nothing rather than comparing a truncated prefix', async () => {
    // Control: matching dimensions produce a result.
    bumpIndexVersion();
    const ok = await search('', { notePath: 'no-embed.md', tag: 'system/meta', limit: 5 });
    assert.ok(
      ok.some((r) => r.path === 'meta-note.md'),
      'control: a same-dimension re-embed must still match',
    );

    // Now the same query with a 5-dimensional query vector against 4-dim chunks.
    embedSpy.mockResolvedValueOnce([new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5])]);
    bumpIndexVersion();
    const mismatched = await search('', { notePath: 'no-embed.md', tag: 'system/meta', limit: 5 });
    assert.equal(
      mismatched.length,
      0,
      'a dimension mismatch must yield no results, not a prefix-derived score',
    );
  });
});

describe('outgoing-link exclusion on the filtered path', () => {
  // A note the source already links to is "already known" and must be excluded.
  // Uses its own tag so the budget tests' candidateChunks === 1 assumption holds.
  beforeAll(() => {
    const near = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    for (const path of ['link-excluded.md', 'link-kept.md']) {
      upsertNote({
        path,
        title: path,
        tags: ['system/linked'],
        content: `Content of ${path}.`,
        mtime: Date.now(),
        hash: `hash-${path}`,
        chunks: [{ text: `Content of ${path}.`, embedding: near }],
      });
    }
    // upsertNote takes no links field — links are written separately.
    upsertLinks('target.md', ['link-excluded.md']);
  });

  it('excludes notes the source already links to', async () => {
    const results = await search('', { notePath: 'target.md', tag: 'system/linked', limit: 5 });
    assert.ok(
      results.some((r) => r.path === 'link-kept.md'),
      'the unlinked tagged note must be returned',
    );
    assert.ok(
      results.every((r) => r.path !== 'link-excluded.md'),
      'a note the source links to must be excluded from the filtered scan',
    );
  });
});

describe('no-embed re-embed fallback combined with a filter', () => {
  // no-embed.md has no stored chunks, so getSimilaritySource re-embeds the whole
  // note via embedQuery into a single source vector — the same fallback covered
  // unfiltered above. This note carries a distant embedding under its own tag so
  // it can only surface through the filtered candidate pool, never through an
  // unfiltered top-N cut (target.md and the 20 fillers all sit at distance 0 from
  // the re-embedded source vector). This is the fallback-plus-filter combination
  // the design doc flags as missing from an earlier draft.
  beforeAll(() => {
    upsertNote({
      path: 'no-embed-far.md',
      title: 'No Embed Far',
      tags: ['system/no-embed-filter'],
      content: 'Only reachable through the filtered candidate pool.',
      mtime: Date.now(),
      hash: 'hash-no-embed-far',
      chunks: [
        {
          text: 'Only reachable through the filtered candidate pool.',
          embedding: new Float32Array([0.9, 0.1, 0.0, 0.0]),
        },
      ],
    });
  });

  it('finds a tagged note through the re-embed fallback that would not survive an unfiltered top-N cut', async () => {
    const results = await search('', {
      notePath: 'no-embed.md',
      tag: 'system/no-embed-filter',
      limit: 5,
    });
    assert.ok(
      results.some((r) => r.path === 'no-embed-far.md'),
      'expected no-embed-far.md — the re-embed fallback source must flow into ' +
        'searchSimilarFiltered and reach the exact scan, not an unfiltered top-5',
    );
    assert.ok(
      results.every((r) => r.path !== 'no-embed.md'),
      'source note must stay excluded',
    );
  });
});
