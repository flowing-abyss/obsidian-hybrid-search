import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-searcher-similar-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
vi.resetModules();

const dbModule = await import('../src/db.js');
const { closeDb, openDb, initVecTable, upsertNote, upsertLinks, getDb } = dbModule;

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

  it('reads only tag-matching candidates during the scan', async () => {
    // Results alone cannot protect the tag arm of resolveFilteredPaths: the
    // pipeline's trailing applyTagFilter keeps them correct even if the arm is
    // deleted. But the arm feeds BOTH gates — a deleted arm inflates
    // candidateChunks, which on a large vault trips the I/O gate into a 500-deep
    // KNN pool (the original defect) and below the gate subsamples the source note
    // harder. So assert the narrowing directly, at the scan's chunk reader.
    const scanSpy = vi.spyOn(dbModule, 'getChunksWithEmbeddingsForPaths');
    try {
      bumpIndexVersion();
      const results = await search('', { notePath: 'target.md', tag: 'system/meta', limit: 3 });
      assert.ok(
        results.some((r) => r.path === 'meta-note.md'),
        'expected meta-note.md',
      );

      const scanned = [...new Set(scanSpy.mock.calls.flatMap((call) => call[0]))];
      assert.ok(scanned.length > 0, 'expected the exact scan to run');
      const stray = scanned.filter((p) => p !== 'meta-note.md').sort((a, b) => a.localeCompare(b));
      assert.deepEqual(
        stray,
        [],
        'the tag arm of resolveFilteredPaths must narrow the candidate pool to the ' +
          `tagged notes; the scan also read: ${stray.join(', ')}`,
      );
    } finally {
      scanSpy.mockRestore();
    }
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

  it("does not resolve a candidate pool for tag: ''", async () => {
    // The result-equality test above cannot discriminate: both semantics rank the
    // same notes identically. The COST is the observable difference, so assert at
    // the exact scan's chunk reader — it runs only when a candidate pool was
    // resolved. Treating '' as present sends this down the whole-vault scan.
    const scanSpy = vi.spyOn(dbModule, 'getChunksWithEmbeddingsForPaths');
    try {
      bumpIndexVersion();
      await search('', { notePath: 'target.md', tag: '', limit: 5 });
      assert.equal(
        scanSpy.mock.calls.length,
        0,
        "tag: '' must not trigger a candidate-pool scan; the scan read " +
          `${[...new Set(scanSpy.mock.calls.flatMap((c) => c[0]))].length} paths`,
      );
    } finally {
      scanSpy.mockRestore();
    }
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

describe('exact scan scoring parity', () => {
  it('agrees with the KNN path on unnormalized vectors', async () => {
    // Same source note, same candidates; one call goes through sqlite-vec KNN,
    // the other through the exact scan. The exclusion filter "-system/absent-tag"
    // matches every note (no note carries that tag), so the two calls must rank
    // the same set identically.
    //
    // Fixture vectors are NOT unit-normalized (norm of [0.1,0.2,0.3,0.4] is ~0.548),
    // so this test fails if the scan computes plain cosine instead of reproducing
    // Math.max(0, 1 - squaredL2 / 2). That is exactly what it is here to catch.
    const viaKnn = await search('', { notePath: 'target.md', limit: 50 });
    const viaScan = await search('', {
      notePath: 'target.md',
      tag: '-system/absent-tag',
      limit: 50,
    });

    const knnScores = new Map(viaKnn.map((r) => [r.path, r.score]));
    let compared = 0;
    for (const r of viaScan) {
      const expected = knnScores.get(r.path);
      if (expected === undefined) continue;
      compared++;
      assert.ok(
        Math.abs(r.score - expected) < 1e-5,
        `score mismatch for ${r.path}: scan ${r.score} vs knn ${expected}`,
      );
    }
    assert.ok(compared > 0, 'expected overlapping notes between the two paths');
  });
});

describe('scan work budget', () => {
  // Mirror the two budgets in src/searcher.ts. They are module-private by design
  // (knip), so the tests drive them through the one input they can control: the
  // stored embedding dimension. That is a real DB setting and feeds ONLY the work
  // estimates — the fixture vectors themselves stay 4-dimensional.
  const SCAN_CPU_BUDGET = 150_000_000;
  const SCAN_IO_BUDGET_BYTES = 64 * 1024 * 1024;

  // The tag filter resolves to exactly meta-note.md, which has exactly 1 chunk, so
  // candidateChunks === 1 and both estimates reduce to functions of the stored dim:
  //   I/O bytes         = dim * 4
  //   maxSourceChunks   = floor(SCAN_CPU_BUDGET / dim)
  const MAX_DIM_UNDER_IO = SCAN_IO_BUDGET_BYTES / 4;

  /** Largest dim that still passes the I/O gate while capping source chunks at `m`. */
  const dimForMaxSourceChunks = (m: number): number => {
    const dim = Math.min(MAX_DIM_UNDER_IO, Math.floor(SCAN_CPU_BUDGET / m));
    // Self-check: if either budget is retuned this fails loudly instead of
    // silently exercising a different branch than the test name claims.
    assert.equal(
      Math.floor(SCAN_CPU_BUDGET / dim),
      m,
      `dim ${dim} does not cap source chunks at ${m}`,
    );
    assert.ok(dim * 4 <= SCAN_IO_BUDGET_BYTES, `dim ${dim} does not fit the I/O budget`);
    return dim;
  };

  const setStoredDim = (dim: number): void => {
    getDb()
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('embedding_dim', ?)")
      .run(String(dim));
    bumpIndexVersion();
  };

  const clearStoredDim = (): void => {
    getDb().prepare("DELETE FROM settings WHERE key = 'embedding_dim'").run();
    bumpIndexVersion();
  };

  const SOURCE_CHUNKS = 40;
  const EXACT_AT = 13;

  beforeAll(() => {
    // 40 chunks, all far from meta-note.md EXCEPT index 13, which matches it exactly.
    // Index 13 is chosen so the score discriminates EVERY branch under test:
    //   all 40 (no cap)                    -> hits 13   -> 1.0
    //   cap 8,  stride [0,5,10,15,...]     -> misses 13 -> 0.55
    //   cap 9,  stride [0,4,8,13,17,...]   -> hits 13   -> 1.0
    //   cap 9,  slice(0,9) = [0..8]        -> misses 13 -> 0.55  (fails the stride test)
    // Crucially, cap 8 MISSING index 13 is what makes the I/O-gate test meaningful:
    // if that gate were deleted, the over-ceiling case would scan with cap 8 and
    // score 0.55 instead of the KNN path's 1.0.
    const far = new Float32Array([0.1, 0.2, 0.3, 0.4]);
    const exact = new Float32Array([0.9, 0.1, 0.0, 0.0]);
    upsertNote({
      path: 'multi.md',
      title: 'Multi Chunk Note',
      tags: [],
      content: 'Multi chunk source note.',
      mtime: Date.now(),
      hash: 'hash-multi',
      chunks: Array.from({ length: SOURCE_CHUNKS }, (_, i) => ({
        text: `Multi chunk ${i}.`,
        embedding: i === EXACT_AT ? exact : far,
      })),
    });
  });

  afterAll(() => {
    clearStoredDim();
  });

  const findMeta = async (): Promise<{ score: number } | undefined> => {
    const results = await search('', { notePath: 'multi.md', tag: 'system/meta', limit: 5 });
    return results.find((r) => r.path === 'meta-note.md');
  };

  it('scans every source chunk when both budgets are satisfied', async () => {
    clearStoredDim();
    const meta = await findMeta();
    assert.ok(meta, 'expected meta-note.md');
    // Chunk 13 matches meta-note.md exactly, so the best-over-chunks score is 1.0.
    assert.ok(Math.abs(meta.score - 1) < 1e-5, `expected full-scan score 1.0, got ${meta.score}`);
  });

  it('admits the scan exactly at the I/O ceiling and subsamples source chunks there', async () => {
    // Two claims in one, because this dim sits on both boundaries at once:
    //   1. dim * 4 === SCAN_IO_BUDGET_BYTES is ADMITTED (the gate is `>`, not `>=`).
    //      A `>=` gate would take the KNN path and score 1.0.
    //   2. at that dim the CPU gate caps source chunks at 8, whose stride misses
    //      chunk 13 -> 0.55. The candidate is still RETURNED, which is the whole
    //      point: the CPU gate trims sources, never candidates.
    assert.equal(MAX_DIM_UNDER_IO * 4, SCAN_IO_BUDGET_BYTES);
    setStoredDim(dimForMaxSourceChunks(8));
    const meta = await findMeta();
    assert.ok(
      meta,
      'expected meta-note.md — the CPU gate must reduce SOURCE chunks, not candidates',
    );
    assert.ok(
      Math.abs(meta.score - 0.55) < 1e-5,
      `expected subsampled score 0.55 (chunk ${EXACT_AT} sampled away), got ${meta.score}`,
    );
  });

  it('spreads the subsample across the note instead of taking the first N', async () => {
    // Cap 9 over 40 chunks: an even stride selects [0,4,8,13,...] and reaches the
    // exact match at 13; slice(0,9) would select [0..8] and score 0.55.
    setStoredDim(dimForMaxSourceChunks(9));
    const meta = await findMeta();
    assert.ok(meta, 'expected meta-note.md');
    assert.ok(
      Math.abs(meta.score - 1) < 1e-5,
      `expected 1.0 from the strided sample reaching chunk ${EXACT_AT}, got ${meta.score} ` +
        '(0.55 means the subsample truncated to the head of the note)',
    );
  });

  it('falls back to oversampled KNN when the candidate I/O exceeds the ceiling', async () => {
    // One byte over the ceiling. Source subsampling cannot reduce candidate I/O, so
    // the scan is abandoned entirely rather than trimmed — and KNN then uses ALL 40
    // source chunks, reaching chunk 13 for a score of 1.0. Without the I/O gate this
    // would instead scan with cap 8 and score 0.55, so the assertion discriminates.
    setStoredDim(MAX_DIM_UNDER_IO + 1);
    const meta = await findMeta();
    assert.ok(meta, 'expected meta-note.md via the KNN fallback');
    assert.ok(Math.abs(meta.score - 1) < 1e-5, `expected KNN score 1.0, got ${meta.score}`);
  });
});

describe('scope and frontmatter arms of the filter resolver', () => {
  // Both arms had zero coverage: every other test drives the tag arm, so a
  // truncating limit in the frontmatter arm (the exact mistake the code comment
  // warns about) would have passed the whole suite silently.
  const far = new Float32Array([0.9, 0.1, 0.0, 0.0]);
  /** Exactly the notes carrying `status: active` — the frontmatter arm's correct output. */
  const FM_MATCHING = new Set([
    ...Array.from({ length: 24 }, (_, i) => `fm/filler-${i}.md`),
    'fm/zz-target.md',
  ]);

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
    // The trailing applyScope in the pipeline would keep RESULTS correct even if
    // resolveFilteredPaths ignored scope entirely, so asserting on results alone
    // cannot tell whether the candidate POOL was narrowed. Spy on the scan's chunk
    // reader to assert the narrowing directly — that is the behavior under test.
    const scanSpy = vi.spyOn(dbModule, 'getChunksWithEmbeddingsForPaths');
    try {
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

      const scanned = scanSpy.mock.calls.flatMap((call) => call[0]);
      assert.ok(scanned.length > 0, 'expected the exact scan to run');
      assert.ok(
        scanned.every((p) => p.startsWith('projects/')),
        `the scan must only read scoped candidates, got ${scanned.filter((p) => !p.startsWith('projects/')).join(', ')}`,
      );
    } finally {
      scanSpy.mockRestore();
    }
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

  it('reads only frontmatter-matching candidates during the scan', async () => {
    // Same reasoning as the tag and scope arms: the trailing applyFrontmatterFilter
    // keeps results correct even if the frontmatter seed is replaced by
    // getAllNotePaths(), so only the scan's reads reveal whether the pool was
    // narrowed. This is the assertion that catches arm DELETION; the sibling test
    // above catches the separate `-1 -> truncating limit` regression.
    const scanSpy = vi.spyOn(dbModule, 'getChunksWithEmbeddingsForPaths');
    try {
      bumpIndexVersion();
      const results = await search('', {
        notePath: 'target.md',
        frontmatter: 'status:active',
        limit: 3,
      });
      assert.ok(
        results.some((r) => r.path === 'fm/zz-target.md'),
        'expected fm/zz-target.md',
      );

      const scanned = [...new Set(scanSpy.mock.calls.flatMap((call) => call[0]))];
      assert.ok(scanned.length > 0, 'expected the exact scan to run');
      const stray = scanned.filter((p) => !FM_MATCHING.has(p)).sort((a, b) => a.localeCompare(b));
      assert.deepEqual(
        stray,
        [],
        'the frontmatter arm of resolveFilteredPaths must narrow the candidate pool ' +
          `to notes matching status:active; the scan also read: ${stray.join(', ')}`,
      );
    } finally {
      scanSpy.mockRestore();
    }
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
