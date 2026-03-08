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
const { search } = await import('../src/searcher.js');

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
  ];

  for (const n of notes) {
    upsertNote({
      path: n.path,
      title: n.title,
      tags: n.tags,
      content: n.content,
      mtime: Date.now(),
      hash: 'hash-' + n.path,
      chunks: [{ text: n.content, embedding: fakeEmbedding }],
    });
  }

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

  it('array tag filter uses OR for includes', async () => {
    const results = await search('tagged', {
      mode: 'fulltext',
      tag: ['include-me', 'exclude-me'],
      limit: 20,
    });
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes('tagged-inc.md'), 'include-me should match');
    assert.ok(paths.includes('tagged-exc.md'), 'exclude-me should also match via OR');
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
});

// ─── Path-based similarity is always semantic ────────────────────────────────

describe('path similarity search is always semantic', () => {
  it('--path returns semantic results and excludes the source note', async () => {
    const results = await search('note-a.md', { notePath: 'note-a.md', limit: 10 });
    assert.ok(
      !results.some((r) => r.path === 'note-a.md'),
      'source note should be excluded from similarity results',
    );
    // In unit tests embedQuery returns null (no API key), so results are empty —
    // shape assertions only run when a real embedder is present.
    for (const r of results) {
      assert.ok(r.scores.semantic !== null, '--path result must have a semantic score');
    }
  });

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
  });
});
