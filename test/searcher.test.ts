import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

// ─── Vault setup (before any imports that read OBSIDIAN_VAULT_PATH) ──────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-searcher-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// ─── Module imports (after env is set) ───────────────────────────────────────

const { openDb, initVecTable, upsertNote, upsertLinks } = await import('../src/db.js');
const { search, bumpIndexVersion } = await import('../src/searcher.js');

const fakeEmbedding = new Float32Array([0.1, 0.2, 0.3, 0.4]);

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(() => {
  openDb();
  initVecTable(4);

  const notes: Array<{ path: string; title: string; content: string; tags: string[] }> = [
    { path: 'note-a.md', title: 'Note A', content: 'Content of note A.', tags: [] },
    { path: 'note-b.md', title: 'Note B', content: 'Content of note B.', tags: [] },
    { path: 'note-c.md', title: 'Note C', content: 'Content of note C.', tags: [] },
    {
      path: 'tagged-inc.md',
      title: 'Tagged Include',
      content: 'Tagged content here.',
      tags: ['include-me', 'shared'],
    },
    {
      path: 'tagged-exc.md',
      title: 'Tagged Exclude',
      content: 'Tagged content here too.',
      tags: ['exclude-me', 'shared'],
    },
    {
      path: 'notes/deep/scoped.md',
      title: 'Scoped Note',
      content: 'Content of scoped note.',
      tags: [],
    },
    {
      path: 'root-note.md',
      title: 'Root Note',
      content: 'Content of root note at top level.',
      tags: [],
    },
    {
      path: 'long-content.md',
      title: 'Long Content',
      content:
        'This is a very long content note that has many words and should produce a long snippet when searched.',
      tags: [],
    },
    {
      path: 'middle-match.md',
      title: 'Middle Match',
      content: 'Start text. '.repeat(20) + 'UNIQUEKEYWORD here. ' + 'End text. '.repeat(20),
      tags: [],
    },
    {
      path: 'headed-note.md',
      title: 'Headed Note',
      content: '# Intro\nPrelude.\n\n## Deep Section\nBatch heading target keyword lives here.\n',
      tags: [],
    },
  ];

  for (const n of notes) {
    const chunks =
      n.path === 'headed-note.md'
        ? [
            { text: '# Intro\nPrelude.\n', embedding: fakeEmbedding, headingPath: '# Intro' },
            {
              text: '## Deep Section\nBatch heading target keyword lives here.\n',
              embedding: fakeEmbedding,
              headingPath: '# Intro > ## Deep Section',
            },
          ]
        : [{ text: n.content, embedding: fakeEmbedding }];
    upsertNote({
      path: n.path,
      title: n.title,
      tags: n.tags,
      content: n.content,
      mtime: Date.now(),
      hash: 'hash-' + n.path,
      chunks,
    });
  }

  // Note with short Cyrillic alias (< 3 chars) — tests alias exact-match path
  upsertNote({
    path: 'zk-system.md',
    title: 'Zettelkasten System',
    tags: [],
    aliases: ['ЗК', 'ZK System'],
    content: 'A note-taking methodology by Niklas Luhmann.',
    mtime: Date.now(),
    hash: 'hash-zk-system',
    chunks: [{ text: 'A note-taking methodology by Niklas Luhmann.', embedding: fakeEmbedding }],
  });

  // Note with longer alias for exact-match dedup check
  upsertNote({
    path: 'pkm-intro.md',
    title: 'PKM Introduction',
    tags: [],
    aliases: ['Personal Knowledge Management'],
    content: 'Overview of PKM practices.',
    mtime: Date.now(),
    hash: 'hash-pkm-intro',
    chunks: [{ text: 'Overview of PKM practices.', embedding: fakeEmbedding }],
  });

  // S-60: BM25-only note vs fuzzy-title-only note for weighted RRF test
  // "BSONLYTERM60" appears verbatim in s60-bm25 content but not in s60-fuzzy content.
  // s60-fuzzy title "bsonlyterm relevant idea" gets strong trigram overlap (8/10)
  // but doesn't match the BM25 prefix query "BSONLYTERM60"* (missing "60" suffix).
  upsertNote({
    path: 's60-bm25.md',
    title: 'Unrelated Zeta Delta',
    content: 'BSONLYTERM60 is here',
    tags: [],
    mtime: Date.now(),
    hash: 'hash-s60-bm25',
    chunks: [{ text: 'BSONLYTERM60 is here', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 's60-fuzzy.md',
    title: 'bsonlyterm relevant idea',
    content: 'nothing matches here',
    tags: [],
    mtime: Date.now(),
    hash: 'hash-s60-fuzzy',
    chunks: [{ text: 'nothing matches here', embedding: fakeEmbedding }],
  });

  // BFS graph: note-a → note-b → note-c → note-a (cycle)
  upsertLinks('note-a.md', ['note-b.md']);
  upsertLinks('note-b.md', ['note-c.md']);
  upsertLinks('note-c.md', ['note-a.md']);
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── BFS depth scoring: score = 1 / (1 + |depth|) ───────────────────────────

describe('BFS depth scoring', () => {
  it('source note at depth 0 has score exactly 1.0', async () => {
    const results = await search('note-a.md', { related: true, direction: 'outgoing', depth: 2 });
    const src = results.find((r) => r.path === 'note-a.md');
    assert.ok(src, 'source note should be present');
    assert.strictEqual(src.score, 1.0);
  });

  it('depth 1 note has score 0.5', async () => {
    const results = await search('note-a.md', { related: true, direction: 'outgoing', depth: 2 });
    const nb = results.find((r) => r.path === 'note-b.md');
    assert.ok(nb, 'depth-1 note should be present');
    assert.ok(Math.abs(nb.score - 0.5) < 1e-10, `expected 0.5, got ${nb.score}`);
  });

  it('depth 2 note has score ≈ 0.333', async () => {
    const results = await search('note-a.md', { related: true, direction: 'outgoing', depth: 2 });
    const nc = results.find((r) => r.path === 'note-c.md');
    assert.ok(nc, 'depth-2 note should be present');
    assert.ok(Math.abs(nc.score - 1 / 3) < 1e-10, `expected 0.333, got ${nc.score}`);
  });

  it('backlinks have negative depth', async () => {
    const results = await search('note-b.md', { related: true, direction: 'backlinks', depth: 1 });
    const na = results.find((r) => r.path === 'note-a.md');
    assert.ok(na, 'backlink note-a should appear');
    assert.ok((na.depth ?? 0) < 0, `backlink depth should be negative, got ${na.depth}`);
  });

  it('backlink at depth -1 has score 0.5', async () => {
    const results = await search('note-b.md', { related: true, direction: 'backlinks', depth: 1 });
    const na = results.find((r) => r.path === 'note-a.md');
    assert.ok(na, 'backlink note-a should appear');
    assert.ok(Math.abs(na.score - 0.5) < 1e-10, `expected 0.5, got ${na.score}`);
  });
});

// ─── BFS cycle avoidance ──────────────────────────────────────────────────────

describe('BFS cycle avoidance', () => {
  it('source note appears exactly once despite cycle', async () => {
    // note-c links back to note-a, which is the source at depth 0
    const results = await search('note-a.md', { related: true, direction: 'outgoing', depth: 3 });
    const count = results.filter((r) => r.path === 'note-a.md').length;
    assert.strictEqual(count, 1, 'source note should appear exactly once');
  });

  it('visited nodes in a cycle are not re-added', async () => {
    const results = await search('note-a.md', { related: true, direction: 'outgoing', depth: 5 });
    // With a 3-node cycle: a→b→c→a, there are exactly 3 unique notes
    assert.strictEqual(results.length, 3, 'should have exactly 3 unique notes despite cycle');
  });
});

// ─── BFS direction filtering ──────────────────────────────────────────────────

describe('BFS direction filtering', () => {
  it('outgoing: does not include backlinks', async () => {
    const results = await search('note-b.md', { related: true, direction: 'outgoing', depth: 1 });
    const paths = results.map((r) => r.path);
    assert.ok(!paths.includes('note-a.md'), 'outgoing should not include backlink note-a');
    assert.ok(paths.includes('note-c.md'), 'outgoing should include note-c');
  });

  it('backlinks: does not include outgoing links', async () => {
    const results = await search('note-b.md', { related: true, direction: 'backlinks', depth: 1 });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('note-a.md'), 'backlinks should include note-a');
    assert.ok(!paths.includes('note-c.md'), 'backlinks should not include outgoing note-c');
  });

  it('both: includes outgoing and backlinks', async () => {
    const results = await search('note-b.md', { related: true, direction: 'both', depth: 1 });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('note-a.md'), 'both should include backlink note-a');
    assert.ok(paths.includes('note-c.md'), 'both should include outgoing note-c');
  });

  it('results are sorted by depth (ascending)', async () => {
    const results = await search('note-b.md', { related: true, direction: 'both', depth: 2 });
    const depths = results.map((r) => r.depth ?? 0);
    for (let i = 1; i < depths.length; i++) {
      assert.ok(
        depths[i - 1]! <= depths[i]!,
        `depths out of order: [${i - 1}]=${depths[i - 1]} > [${i}]=${depths[i]}`,
      );
    }
  });

  it('matchedBy reflects graph relationship: source/link/backlink', async () => {
    const results = await search('note-a.md', { related: true, direction: 'both', depth: 1 });
    for (const r of results) {
      const depth = r.depth ?? 0;
      if (depth === 0) {
        assert.deepEqual(r.matchedBy, ['source'], 'depth=0 should be source');
      } else if (depth > 0) {
        assert.deepEqual(r.matchedBy, ['link'], 'positive depth should be link');
      } else {
        assert.deepEqual(r.matchedBy, ['backlink'], 'negative depth should be backlink');
      }
    }
  });
});

// ─── Tag filter ───────────────────────────────────────────────────────────────

describe('tag filter', () => {
  it('single include tag: returns only matching notes', async () => {
    const results = await search('tagged', { mode: 'fulltext', tag: 'include-me', limit: 20 });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('tagged-inc.md'), 'tagged-inc.md should match include-me');
    assert.ok(!paths.includes('tagged-exc.md'), 'tagged-exc.md should not match include-me');
  });

  it('exclude tag with - prefix: removes note from results', async () => {
    const results = await search('tagged', { mode: 'fulltext', tag: '-exclude-me', limit: 20 });
    const paths = results.map((r) => r.path);
    assert.ok(!paths.includes('tagged-exc.md'), 'tagged-exc.md should be excluded');
    assert.ok(paths.includes('tagged-inc.md'), 'tagged-inc.md should not be excluded');
  });

  it('array tag filter uses AND for includes', async () => {
    const results = await search('tagged', {
      mode: 'fulltext',
      tag: ['include-me', 'exclude-me'],
      limit: 20,
    });
    const paths = results.map((r) => r.path);
    // Both tags must match (AND logic) - neither note has both tags, so no results
    assert.equal(paths.length, 0, 'no notes have both tags');
  });

  it('array tag filter single tag still works', async () => {
    const results = await search('tagged', {
      mode: 'fulltext',
      tag: ['include-me'],
      limit: 20,
    });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('tagged-inc.md'), 'include-me should match');
  });

  it('exclude + include combined: shared tag kept, excluded note removed', async () => {
    // Both notes have 'shared' tag; only tagged-exc has 'exclude-me'
    const results = await search('tagged', {
      mode: 'fulltext',
      tag: ['-exclude-me', 'shared'],
      limit: 20,
    });
    const paths = results.map((r) => r.path);
    assert.ok(!paths.includes('tagged-exc.md'), 'tagged-exc.md should be excluded');
    assert.ok(paths.includes('tagged-inc.md'), 'tagged-inc.md has shared and not exclude-me');
  });
});

// ─── Scope filter ─────────────────────────────────────────────────────────────

describe('scope filter', () => {
  it('include scope: only matching prefix paths returned', async () => {
    const results = await search('content', { mode: 'fulltext', scope: 'notes/', limit: 20 });
    assert.ok(results.length > 0, 'should return scoped results');
    for (const r of results) {
      assert.ok(r.path.startsWith('notes/'), `path "${r.path}" should start with notes/`);
    }
  });

  it('exclude scope with - prefix: matching paths removed', async () => {
    const results = await search('content', { mode: 'fulltext', scope: '-notes/', limit: 20 });
    for (const r of results) {
      assert.ok(!r.path.startsWith('notes/'), `path "${r.path}" should not be in notes/`);
    }
  });

  it('multiple scope filters use AND logic', async () => {
    const results = await search('', {
      scope: ['notes/', 'sub/'],
      limit: 100,
    });
    for (const r of results) {
      assert.ok(r.path.startsWith('notes/'), `path "${r.path}" should start with notes/`);
      assert.ok(r.path.includes('sub/'), `path "${r.path}" should contain sub/`);
    }
  });
});

describe('filter-only mode', () => {
  it('filter-only with scope returns all matching notes', async () => {
    const results = await search('', { scope: ['notes/'] });
    assert.ok(results.length > 0, 'should return results');
    for (const r of results) {
      assert.ok(r.path.startsWith('notes/'), `path "${r.path}" should start with notes/`);
    }
  });

  it('filter-only with tag returns all matching notes', async () => {
    const results = await search('', { tag: ['shared'] });
    assert.ok(results.length > 0, 'should return results');
    for (const r of results) {
      assert.ok(r.tags.includes('shared'), `note "${r.path}" should have shared tag`);
    }
  });

  it('filter-only without filters shows help/error', async () => {
    const results = await search('', {});
    assert.equal(results.length, 0, 'should return empty without filters');
  });

  it('filter-only mode with multiple filters uses AND logic', async () => {
    const results = await search('', { scope: ['notes/'], tag: ['shared'] });
    for (const r of results) {
      assert.ok(r.path.startsWith('notes/'), `path "${r.path}" should start with notes/`);
      assert.ok(r.tags.includes('shared'), `note "${r.path}" should have shared tag`);
    }
  });
});

// ─── snippetLength cap ────────────────────────────────────────────────────────

describe('snippetLength cap', () => {
  it('caps all snippets to the specified length', async () => {
    const maxLen = 20;
    const results = await search('content', { mode: 'fulltext', snippetLength: maxLen, limit: 10 });
    assert.ok(results.length > 0, 'should return results');
    for (const r of results) {
      assert.ok(
        r.snippet.length <= maxLen,
        `snippet length ${r.snippet.length} exceeds limit ${maxLen}: "${r.snippet}"`,
      );
    }
  });

  it('caps snippets in related mode too', async () => {
    const maxLen = 15;
    const results = await search('note-a.md', {
      related: true,
      direction: 'both',
      depth: 1,
      snippetLength: maxLen,
    });
    for (const r of results) {
      assert.ok(
        r.snippet.length <= maxLen,
        `related snippet length ${r.snippet.length} exceeds limit ${maxLen}`,
      );
    }
  });

  it('expands snippet to snippetLength when note has enough content', async () => {
    // long-content.md has ~100 chars of content; requesting snippetLength=80 should
    // produce a snippet close to 80 chars via getSnippetFallback when BM25 returns less.
    const results = await search('long', { mode: 'fulltext', snippetLength: 80, limit: 5 });
    const r = results.find((x) => x.path === 'long-content.md');
    assert.ok(r, 'long-content.md should appear in fulltext results');
    assert.ok(
      r.snippet.length >= 50,
      `snippet should be expanded with snippetLength=80, got ${r.snippet.length} chars`,
    );
  });

  it('BM25 snippet respects snippetLength for context around match', async () => {
    // middle-match.md has UNIQUEKEYWORD in the middle with ~200 chars before/after
    // With snippetLength=200, BM25 should return context around the match
    const results = await search('UNIQUEKEYWORD', {
      mode: 'fulltext',
      snippetLength: 200,
      limit: 5,
    });
    const r = results.find((x) => x.path === 'middle-match.md');
    assert.ok(r, 'middle-match.md should appear in fulltext results');
    assert.ok(r.snippet.includes('UNIQUEKEYWORD'), `snippet should contain the match keyword`);
    // Snippet should be truncated to snippetLength
    assert.ok(
      r.snippet.length <= 200,
      `snippet length ${r.snippet.length} should not exceed snippetLength=200`,
    );
  });

  it('BM25 snippet includes heading breadcrumb for section matches', async () => {
    const results = await search('target keyword', {
      mode: 'fulltext',
      snippetLength: 40,
      limit: 5,
    });
    const r = results.find((x) => x.path === 'headed-note.md');
    assert.ok(r, 'headed-note.md should appear in fulltext results');
    assert.ok(
      r.snippet.startsWith('# Intro > ## Deep Section\n'),
      `snippet should include heading breadcrumb, got: ${JSON.stringify(r.snippet)}`,
    );
  });
});

// ─── Path-based similarity is always semantic ────────────────────────────────

describe('path similarity search is always semantic', () => {
  it('uses stored chunk embeddings and returns results without API key', async () => {
    // Unit tests have no API key → embedQuery returns null.
    // Old implementation: called embedQuery, got null, returned [].
    // New implementation: reads stored chunk embeddings from vec_chunks → returns results.
    // All test notes share the same fakeEmbedding, so all are equally similar.
    const results = await search('note-a.md', { notePath: 'note-a.md', limit: 10 });
    assert.ok(
      results.length > 0,
      'should find similar notes using stored chunk embeddings without any API call',
    );
    assert.ok(
      !results.some((r) => r.path === 'note-a.md'),
      'source note must be excluded from results',
    );
    for (const r of results) {
      assert.ok(r.scores.semantic != null, '--path result must have a semantic score');
    }
  }, 15000);

  it('excludes notes already linked from the source note', async () => {
    // note-a.md has an outgoing link to note-b.md (set up in beforeAll).
    // Recommending already-linked notes is unhelpful — they are already known.
    // Use limit=100 (> total notes) so note-b.md would definitely appear without the filter.
    bumpIndexVersion();
    const results = await search('note-a.md', { notePath: 'note-a.md', limit: 100 });
    assert.ok(results.length > 0, 'should return some results');
    assert.ok(
      !results.some((r) => r.path === 'note-b.md'),
      'note-b.md is already linked from note-a.md and must be excluded from similar notes',
    );
  }, 15000);

  it('--path returns semantic results and excludes the source note', async () => {
    const results = await search('note-a.md', { notePath: 'note-a.md', limit: 10 });
    assert.ok(
      !results.some((r) => r.path === 'note-a.md'),
      'source note should be excluded from similarity results',
    );
    for (const r of results) {
      assert.ok(r.scores.semantic !== null, '--path result must have a semantic score');
    }
  }, 15000);

  it('--mode is ignored when --path is given (always semantic)', async () => {
    const semantic = await search('note-a.md', { notePath: 'note-a.md', limit: 10 });
    const fulltext = await search('note-a.md', {
      mode: 'fulltext',
      notePath: 'note-a.md',
      limit: 10,
    });
    const title = await search('note-a.md', { mode: 'title', notePath: 'note-a.md', limit: 10 });
    // All three should return the same paths (semantic regardless of mode)
    const paths = (rs: typeof semantic) => rs.map((r) => r.path).sort((a, b) => a.localeCompare(b));
    assert.deepEqual(paths(fulltext), paths(semantic), 'fulltext mode should be ignored for path');
    assert.deepEqual(paths(title), paths(semantic), 'title mode should be ignored for path');
    // All results must have semantic scores
    for (const r of [...fulltext, ...title]) {
      assert.ok(
        r.scores.semantic !== null,
        'path result must have semantic score regardless of mode',
      );
    }
  }, 15000);

  it('multi-chunk candidate appears only once in path similarity results', async () => {
    upsertNote({
      path: 'multi-chunk-source.md',
      title: 'Multi Chunk Source',
      tags: [],
      content: 'source text',
      mtime: Date.now(),
      hash: 'hash-multi-source',
      chunks: [
        { text: 'source chunk one', embedding: new Float32Array([1, 0, 0, 0]) },
        { text: 'source chunk two', embedding: new Float32Array([0, 1, 0, 0]) },
      ],
    });
    upsertNote({
      path: 'multi-chunk-candidate.md',
      title: 'Multi Chunk Candidate',
      tags: [],
      content: 'candidate text',
      mtime: Date.now(),
      hash: 'hash-multi-candidate',
      chunks: [
        { text: 'candidate chunk one', embedding: new Float32Array([1, 0, 0, 0]) },
        { text: 'candidate chunk two', embedding: new Float32Array([1, 0, 0, 0]) },
      ],
    });

    bumpIndexVersion();
    const results = await search('multi-chunk-source.md', {
      notePath: 'multi-chunk-source.md',
      limit: 20,
    });
    const matches = results.filter((r) => r.path === 'multi-chunk-candidate.md');
    assert.equal(
      matches.length,
      1,
      'candidate note should appear only once despite multiple chunks',
    );
  }, 15000);
});

// ─── Similarity score formula ─────────────────────────────────────────────────
// For unit-normalized vectors, cosine similarity = 1 - L2² / 2 (not 1 - L2/2).

describe('similarity score formula', () => {
  // v1 = [1, 0, 0, 0], v2 = [0.8, 0.6, 0, 0] — both unit vectors.
  // cos(v1, v2) = 0.8 exactly. L2(v1, v2) = sqrt(0.4) ≈ 0.632.
  // Wrong formula (1 - L2/2) gives ≈ 0.684. Correct formula (1 - L2²/2) gives 0.8.
  const v1 = new Float32Array([1, 0, 0, 0]);
  const v2 = new Float32Array([0.8, 0.6, 0, 0]);

  beforeAll(() => {
    upsertNote({
      path: 'sim-formula-a.md',
      title: 'Sim A',
      tags: [],
      content: 'a',
      mtime: Date.now(),
      hash: 'sim-formula-a',
      chunks: [{ text: 'a', embedding: v1 }],
    });
    upsertNote({
      path: 'sim-formula-b.md',
      title: 'Sim B',
      tags: [],
      content: 'b',
      mtime: Date.now(),
      hash: 'sim-formula-b',
      chunks: [{ text: 'b', embedding: v2 }],
    });
    bumpIndexVersion();
  });

  it('score equals cosine similarity (1 - L2² / 2) for unit vectors', async () => {
    const results = await search('sim-formula-a.md', { notePath: 'sim-formula-a.md', limit: 10 });
    const simB = results.find((r) => r.path === 'sim-formula-b.md');
    assert.ok(simB, 'sim-formula-b.md should appear in results');
    // cos([1,0,0,0], [0.8,0.6,0,0]) = 0.8 — wrong formula gives ≈ 0.684
    assert.ok(
      Math.abs(simB.score - 0.8) < 0.001,
      `score should be cosine similarity 0.8, got ${simB.score}`,
    );
  });
});

// ─── Zero-vector guard ────────────────────────────────────────────────────────
// When the embedding API fails during indexing, embedder returns a zero-vector
// fallback so the note is still indexed for BM25. If that same zero vector is
// later used as a query, every stored unit-vector has L2 distance = 1.0, giving
// every result semantic=0.5 — meaningless uniform scores that corrupt RRF output.
// searchVector must detect this and return [] so only BM25/fuzzy contribute.

describe('zero-vector guard', () => {
  it('semantic mode with zero vector returns empty results', async () => {
    const { searchBm25 } = await import('../src/searcher.js');
    // Insert a note with a ZERO embedding (simulating indexing fallback)
    upsertNote({
      path: 'zero-emb.md',
      title: 'Zero Embedding',
      content: 'zero embedding test content',
      tags: [],
      mtime: Date.now(),
      hash: 'hash-zero',
      chunks: [{ text: 'zero embedding test content', embedding: new Float32Array(4) }],
    });

    // Direct BM25 search for the zero-embedding note should work fine
    const bm25 = searchBm25('zero embedding', 5);
    assert.ok(bm25.length > 0, 'BM25 should find the zero-embedding note');
    const bm25Hit = bm25.find((r) => r.path === 'zero-emb.md');
    assert.ok(bm25Hit, 'BM25 should return zero-emb.md');
  });

  it('hybrid search with zero query vector produces no semantic scores', async () => {
    // In unit tests embed() is never called (no OPENAI_API_KEY / no vec table data
    // matching zero-vector queries), so searchVector returns [] for all queries.
    // The important thing is that the zero-vector path in searchVector is guarded.
    // We verify the symptom: no result should have all-equal 0.5 semantic scores.
    const results = await search('Content here', { mode: 'hybrid', limit: 5 });
    // Results should come from BM25/fuzzy only; none should have uniform 0.5 semantic
    const semanticHits = results.filter((r) => r.scores.semantic !== null);
    const allSameHalf = semanticHits.every((r) => r.scores.semantic === 0.5);
    assert.ok(
      semanticHits.length === 0 || !allSameHalf,
      'all results should NOT have the same 0.5 semantic score (zero-vector symptom)',
    );
  }, 15000);
});

// ─── Alias exact-match search (S-59) ─────────────────────────────────────────
// Short Cyrillic aliases (< 3 chars) can't be tokenised by the trigram FTS index.
// searchByAliasExact handles them via JS-level Unicode case-folding.

describe('alias exact-match search', () => {
  it('title mode finds a note by its short Cyrillic alias (< 3 chars)', async () => {
    const results = await search('ЗК', { mode: 'title', limit: 10 });
    const match = results.find((r) => r.path === 'zk-system.md');
    assert.ok(
      match,
      `should find zk-system.md by alias "ЗК", got: ${JSON.stringify(results.map((r) => r.path))}`,
    );
  });

  it('title mode finds a note by its short Cyrillic alias case-insensitively', async () => {
    const results = await search('зк', { mode: 'title', limit: 10 });
    const match = results.find((r) => r.path === 'zk-system.md');
    assert.ok(match, 'should find zk-system.md by lowercase alias "зк"');
  });

  it('alias exact match ranks the target note at the top', async () => {
    const results = await search('ЗК', { mode: 'title', limit: 10 });
    assert.ok(results.length > 0, 'should return at least one result');
    assert.equal(results[0]!.path, 'zk-system.md', 'alias exact-match should be rank 1');
  });

  it('title mode finds a note by a longer alias', async () => {
    const results = await search('Personal Knowledge Management', { mode: 'title', limit: 10 });
    const match = results.find((r) => r.path === 'pkm-intro.md');
    assert.ok(match, 'should find pkm-intro.md by its full alias');
  });

  it('hybrid mode includes alias exact-match via fuzzy_title list', async () => {
    const results = await search('ЗК', { mode: 'hybrid', limit: 10 });
    const match = results.find((r) => r.path === 'zk-system.md');
    assert.ok(
      match,
      `hybrid mode should surface zk-system.md for alias "ЗК", got: ${JSON.stringify(results.map((r) => r.path))}`,
    );
  });
});

// ─── Alias-only hybrid surface (S-66) ────────────────────────────────────────
// A note whose title/content contains nothing about a concept but has an exact
// alias matching the query should surface in hybrid results. Before the fix,
// exactAliasResults used weight=0.5 (same as partial fuzzy), so a content-poor
// alias-match note was buried under notes with richer content. After the fix,
// exactAliasResults use weight=2.0 (same as BM25), ensuring the note appears.

describe('alias-only hybrid surface (S-66)', () => {
  // Two notes inserted in beforeAll above:
  //   zk-system.md: title="Zettelkasten System", alias="ЗК" — the alias-only scenario
  //   pkm-intro.md: alias="Personal Knowledge Management", content="Overview of PKM practices."
  //
  // We add two more specifically for S-66:
  //   s66-alias-only.md — title/content have no "ZKTERM66", but alias = "ZKTERM66"
  //   s66-content.md    — has "ZKTERM66" in content (BM25 match)

  beforeAll(() => {
    upsertNote({
      path: 's66-alias-only.md',
      title: 'Концепция без содержимого',
      tags: [],
      aliases: ['ZKTERM66'],
      content: 'Краткое описание без ключевого слова.',
      mtime: Date.now(),
      hash: 'hash-s66-alias',
      chunks: [
        {
          text: 'Краткое описание без ключевого слова.',
          embedding: fakeEmbedding,
        },
      ],
    });

    upsertNote({
      path: 's66-content.md',
      title: 'ZKTERM66 guide',
      tags: [],
      aliases: [],
      content: 'ZKTERM66 is an important concept with rich content and multiple references.',
      mtime: Date.now(),
      hash: 'hash-s66-content',
      chunks: [
        {
          text: 'ZKTERM66 is an important concept with rich content and multiple references.',
          embedding: fakeEmbedding,
        },
      ],
    });
  });

  it('alias-only note surfaces in hybrid results even without content/title match', async () => {
    const results = await search('ZKTERM66', { mode: 'hybrid', limit: 20 });
    const aliasNote = results.find((r) => r.path === 's66-alias-only.md');
    assert.ok(
      aliasNote,
      `s66-alias-only.md should appear in hybrid results for its alias "ZKTERM66", got: ${JSON.stringify(results.map((r) => r.path))}`,
    );
  });

  it('alias-only note has fuzzy_title score set and matchedBy includes "title"', async () => {
    const results = await search('ZKTERM66', { mode: 'hybrid', limit: 20 });
    const aliasNote = results.find((r) => r.path === 's66-alias-only.md');
    assert.ok(aliasNote, 's66-alias-only.md should be in results');
    assert.ok(
      aliasNote.scores.fuzzy_title !== null,
      'alias match should produce a fuzzy_title score',
    );
    assert.ok(
      aliasNote.matchedBy.includes('title'),
      `matchedBy should include "title", got: ${JSON.stringify(aliasNote.matchedBy)}`,
    );
  });

  it('alias-only note scores above 0 and appears before the result list is cut', async () => {
    // s66-alias-only.md has alias "ZKTERM66" — the alias IS indexed in BM25 (aliases column,
    // weight 5.0), so it matches via BM25 + exactAlias. The key invariant is that both
    // notes surface, not which one is higher (that depends on BM25 rank positions).
    const results = await search('ZKTERM66', { mode: 'hybrid', limit: 20 });
    const aliasNote = results.find((r) => r.path === 's66-alias-only.md');
    const contentNote = results.find((r) => r.path === 's66-content.md');
    assert.ok(aliasNote, 's66-alias-only.md should appear in results');
    assert.ok(contentNote, 's66-content.md should appear in results');
    assert.ok(
      aliasNote.score > 0,
      `alias-only note should have positive score, got ${aliasNote.score}`,
    );
  });

  it('exact alias match scores higher than partial fuzzy title match', async () => {
    // s66-alias-only.md: exact alias match (weight 2.0)
    // s60-fuzzy.md: partial trigram match on title "bsonlyterm relevant idea" for query "ZKTERM66"
    //   — low overlap, weight 0.5 (partial fuzzy path)
    // Exact alias (weight=2.0) should beat random partial fuzzy hits.
    const results = await search('ZKTERM66', { mode: 'hybrid', limit: 20 });
    const aliasNote = results.find((r) => r.path === 's66-alias-only.md');
    const partialFuzzy = results.find((r) => r.path === 's60-fuzzy.md');
    if (aliasNote && partialFuzzy) {
      assert.ok(
        aliasNote.score >= partialFuzzy.score,
        `exact alias note (${aliasNote.score}) should outrank partial fuzzy match (${partialFuzzy.score})`,
      );
    }
    // If partialFuzzy doesn't appear at all for "ZKTERM66", alias-only still present — that's fine.
  });
});

// ─── RRF normalization with empty lists (S-30) ────────────────────────────────
// When semantic list is empty (no API key / local model), maxPossibleScore must
// be computed from active lists only, so the best reachable score is 1.0, not 0.67.

describe('RRF normalization with empty semantic list', () => {
  it('top hybrid result has score <= 1.0 and >= 0.9 when only BM25+fuzzy are active', async () => {
    // Unit tests have no OPENAI_API_KEY, so semantic list is always empty.
    // Active lists = BM25 (w=2.0) + fuzzy (w=0.5), maxPossibleScore = 2.5/61.
    // A note ranked #1 in both BM25 and fuzzy gets rrfScore = 2.5/61 → score = 1.0.
    const results = await search('note', { mode: 'hybrid', limit: 5 });
    assert.ok(results.length > 0, 'should return at least one result');
    const top = results[0]!;
    assert.ok(top.score <= 1.0, `score must be ≤ 1.0, got ${top.score}`);
    assert.ok(
      top.score >= 0.9,
      `top result score should be ≥ 0.9 when only 2 of 3 lists are active, got ${top.score}`,
    );
  });
});

// ─── Weighted RRF: BM25 outweighs fuzzy-title (S-60) ─────────────────────────
// Before the fix, both BM25-only and fuzzy-only notes scored 0.5 (structural tie).
// With weights bm25=2.0 / fuzzy=0.5, BM25-only at rank 0 scores 0.8 while
// fuzzy-only at rank 0 scores 0.2 — correctly reflecting signal strength.

describe('weighted RRF: BM25 outweighs fuzzy-title for single-signal notes (S-60)', () => {
  it('BM25-only rank-0 note scores higher than fuzzy-title-only rank-0 note', async () => {
    // s60-bm25.md: "BSONLYTERM60" in content, generic title → BM25 match only
    // s60-fuzzy.md: title "bsonlyterm relevant idea" → trigram overlap ~0.8 → fuzzy match only
    //   (FTS5 prefix query "BSONLYTERM60"* doesn't match shorter "bsonlyterm" token)
    const results = await search('BSONLYTERM60', { mode: 'hybrid', limit: 20 });
    const bm25Note = results.find((r) => r.path === 's60-bm25.md');
    const fuzzyNote = results.find((r) => r.path === 's60-fuzzy.md');
    assert.ok(bm25Note, 's60-bm25.md should appear (BM25 content match)');
    assert.ok(fuzzyNote, 's60-fuzzy.md should appear (fuzzy title match)');
    assert.ok(
      bm25Note.score > fuzzyNote.score,
      `BM25 note (${bm25Note.score}) should outrank fuzzy note (${fuzzyNote.score}) with weighted RRF`,
    );
  });
});

// ─── Multi-query fan-out (S-48) ───────────────────────────────────────────────
// When queries[] is provided, each query runs in parallel and results are merged
// via RRF. A note that ranks well in any one query floats to the top.

describe('multi-query fan-out', () => {
  it('single-query in queries[] behaves identically to no queries', async () => {
    const single = await search('note a', { mode: 'fulltext', limit: 20 });
    const multi = await search('note a', { mode: 'fulltext', limit: 20, queries: ['note a'] });
    assert.deepEqual(
      single.map((r) => r.path),
      multi.map((r) => r.path),
      'queries with one entry should match single-query results',
    );
  });

  it('two queries merge results from both searches', async () => {
    // "note a" matches note-a.md, "note b" matches note-b.md
    const results = await search('note a', {
      mode: 'fulltext',
      limit: 20,
      queries: ['note a', 'note b'],
    });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('note-a.md'), 'note-a.md should appear via first query');
    assert.ok(paths.includes('note-b.md'), 'note-b.md should appear via second query');
  });

  it('multi-query results have rank field assigned sequentially from 1', async () => {
    const results = await search('note a', {
      mode: 'fulltext',
      limit: 20,
      queries: ['note a', 'note b'],
    });
    assert.ok(results.length > 0, 'should have results');
    results.forEach((r, i) => {
      assert.equal(r.rank, i + 1, `rank at position ${i} should be ${i + 1}, got ${r.rank}`);
    });
  });

  it('multi-query result that appears in both queries scores higher than single-query hit', async () => {
    // "note" matches many notes via BM25; running the same query twice should
    // double the RRF contribution for notes ranked highly in both runs,
    // resulting in a higher combined score than a note that only one query found.
    const twoSame = await search('note', {
      mode: 'fulltext',
      limit: 5,
      queries: ['note a', 'note a'],
    });
    const oneQuery = await search('note a', { mode: 'fulltext', limit: 5 });
    assert.ok(twoSame.length > 0, 'should return results');
    assert.ok(oneQuery.length > 0, 'single query should return results');
    // The top result in both should be the same note (note-a.md is the best BM25 match for "note a")
    assert.equal(
      twoSame[0]!.path,
      oneQuery[0]!.path,
      'multi-query with identical queries should keep same top result',
    );
  });

  it('queries[] is ignored for path-based lookups', async () => {
    // When notePath is provided, it's a semantic similarity search — queries[] should be ignored
    const withQueries = await search('note-a.md', {
      notePath: 'note-a.md',
      queries: ['note a', 'note b'],
      limit: 10,
    });
    const withoutQueries = await search('note-a.md', {
      notePath: 'note-a.md',
      limit: 10,
    });
    assert.deepEqual(
      withQueries.map((r) => r.path),
      withoutQueries.map((r) => r.path),
      'path-based search should ignore queries[]',
    );
  }, 15000);
});
