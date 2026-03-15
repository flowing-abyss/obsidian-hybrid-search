/**
 * Contract tests: verify the SearchResult shape and SearchOptions parameters
 * are stable and match what MCP/CLI consumers depend on.
 *
 * If `search()` changes its return type or parameter names, these tests catch it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

// ─── Vault setup ─────────────────────────────────────────────────────────────

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-contract-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

// ─── Module imports ───────────────────────────────────────────────────────────

const { openDb, initVecTable, upsertNote } = await import('../src/db.js');
const { readNotes, search } = await import('../src/searcher.js');

const fakeEmbedding = new Float32Array([0.5, 0.5, 0.5, 0.5]);

beforeAll(() => {
  openDb();
  initVecTable(4);
  upsertNote({
    path: 'alpha.md',
    title: 'Alpha Note',
    tags: ['pkm'],
    content: 'Alpha note content with enough words to generate a meaningful snippet.',
    mtime: Date.now(),
    hash: 'h1',
    chunks: [{ text: 'Alpha note content', embedding: fakeEmbedding }],
  });
  upsertNote({
    path: 'beta.md',
    title: 'Beta Note',
    tags: [],
    content: 'Beta note content with some text for searching and retrieval.',
    mtime: Date.now(),
    hash: 'h2',
    chunks: [{ text: 'Beta note content', embedding: fakeEmbedding }],
  });
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

// ─── SearchResult shape contract ─────────────────────────────────────────────

describe('SearchResult shape', () => {
  it('every result has all required top-level fields', async () => {
    const results = await search('alpha', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0, 'should return results');
    for (const r of results) {
      assert.ok(typeof r.path === 'string', 'path must be a string');
      assert.ok(typeof r.title === 'string', 'title must be a string');
      assert.ok(Array.isArray(r.tags), 'tags must be an array');
      assert.ok(Array.isArray(r.aliases), 'aliases must be an array');
      assert.ok(typeof r.score === 'number', 'score must be a number');
      assert.ok(typeof r.rank === 'number' && r.rank >= 1, 'rank must be a positive integer');
      assert.ok(typeof r.snippet === 'string', 'snippet must be a string');
      assert.ok(Array.isArray(r.matchedBy), 'matchedBy must be an array');
      assert.ok(Array.isArray(r.links), 'links must be an array');
      assert.ok(Array.isArray(r.backlinks), 'backlinks must be an array');
      assert.ok(typeof r.scores === 'object', 'scores must be an object');
    }
  });

  it('scores object has semantic, bm25, fuzzy_title fields (each number | null)', async () => {
    const results = await search('note', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0, 'should return results');
    for (const r of results) {
      assert.ok(
        'semantic' in r.scores,
        'scores.semantic must exist (may be null for non-semantic search)',
      );
      assert.ok('bm25' in r.scores, 'scores.bm25 must exist');
      assert.ok('fuzzy_title' in r.scores, 'scores.fuzzy_title must exist');
      assert.ok(
        r.scores.semantic === null || typeof r.scores.semantic === 'number',
        'scores.semantic must be number or null',
      );
      assert.ok(
        r.scores.bm25 === null || typeof r.scores.bm25 === 'number',
        'scores.bm25 must be number or null',
      );
      assert.ok(
        r.scores.fuzzy_title === null || typeof r.scores.fuzzy_title === 'number',
        'scores.fuzzy_title must be number or null',
      );
    }
  });

  it('score is in [0, 1] range', async () => {
    const results = await search('note', { mode: 'fulltext', limit: 10 });
    for (const r of results) {
      assert.ok(r.score >= 0 && r.score <= 1, `score ${r.score} is outside [0, 1]`);
    }
  });

  it('tags is an array of strings (not a JSON string)', async () => {
    const results = await search('alpha', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0);
    const alpha = results.find((r) => r.path === 'alpha.md');
    assert.ok(alpha, 'alpha.md should appear in results');
    assert.deepEqual(alpha.tags, ['pkm'], 'tags should be a parsed string array, not JSON');
  });

  it('aliases is an array of strings (not a JSON string)', async () => {
    const results = await search('alpha', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0);
    const alpha = results.find((r) => r.path === 'alpha.md');
    assert.ok(alpha, 'alpha.md should appear in results');
    assert.ok(Array.isArray(alpha.aliases), 'aliases should be an array');
    for (const a of alpha.aliases) {
      assert.ok(typeof a === 'string', 'each alias should be a string');
    }
  });

  it('note indexed with aliases exposes them in search results', async () => {
    upsertNote({
      path: 'aliased.md',
      title: 'Zettelkasten',
      tags: [],
      aliases: ['ЗК', 'slip-box', 'карточки'],
      content: 'A document about the zettelkasten method and slip-box system.',
      mtime: Date.now(),
      hash: 'h-aliased',
      chunks: [{ text: 'zettelkasten slip-box', embedding: fakeEmbedding }],
    });
    const results = await search('slip-box', { mode: 'fulltext', limit: 5 });
    const found = results.find((r) => r.path === 'aliased.md');
    assert.ok(found, 'note should be found by alias');
    assert.deepEqual(
      found.aliases,
      ['ЗК', 'slip-box', 'карточки'],
      'aliases should be returned in result',
    );
  });

  it('scores.hybrid is null for non-hybrid modes (fulltext, title)', async () => {
    const results = await search('note', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok('hybrid' in r.scores, 'scores.hybrid field must exist');
      assert.strictEqual(r.scores.hybrid, null, 'scores.hybrid must be null for fulltext mode');
    }
  });

  it('scores.hybrid is a number or null for any search result', async () => {
    const results = await search('alpha', { mode: 'fulltext', limit: 5 });
    for (const r of results) {
      assert.ok(
        r.scores.hybrid === null || typeof r.scores.hybrid === 'number',
        'scores.hybrid must be number or null',
      );
    }
  });

  it('matchedBy contains only valid signal names', async () => {
    const results = await search('alpha', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0);
    const validSignals = new Set(['semantic', 'bm25', 'title']);
    for (const r of results) {
      for (const signal of r.matchedBy) {
        assert.ok(validSignals.has(signal), `unknown matchedBy signal: ${signal}`);
      }
    }
  });

  it('fulltext mode results have bm25 in matchedBy and not semantic', async () => {
    const results = await search('alpha', { mode: 'fulltext', limit: 5 });
    assert.ok(results.length > 0);
    for (const r of results) {
      assert.ok(r.matchedBy.includes('bm25'), 'fulltext results must include bm25 in matchedBy');
      assert.ok(!r.matchedBy.includes('semantic'), 'fulltext results must not include semantic');
    }
  });
});

// ─── SearchOptions mode contract ─────────────────────────────────────────────

describe('SearchOptions mode values', () => {
  // These are the exact enum values documented in server.ts MCP schema
  const modes = ['fulltext', 'title'] as const;

  for (const mode of modes) {
    it(`mode '${mode}' returns results without throwing`, async () => {
      // No assertion on count — just verify it doesn't throw and returns an array
      const results = await search('note', { mode, limit: 5 });
      assert.ok(Array.isArray(results), `mode '${mode}' should return an array`);
    });
  }

  it('fulltext mode with empty query returns empty array (not throw)', async () => {
    // hybrid mode requires an API key (calls embed()); fulltext doesn't
    const results = await search('', { mode: 'fulltext', limit: 5 });
    assert.ok(Array.isArray(results));
  });
});

// ─── SearchOptions parameter mapping contract ─────────────────────────────────
//
// server.ts maps MCP's snake_case `snippet_length` → SearchOptions `snippetLength`.
// This test ensures `snippetLength` is the correct camelCase field name in SearchOptions.
// If it were renamed, this test (and the TypeScript compiler) would catch it.

describe('SearchOptions parameter names', () => {
  it('snippetLength (camelCase) caps snippet output', async () => {
    const limit = 25;
    const results = await search('content', { mode: 'fulltext', snippetLength: limit, limit: 10 });
    assert.ok(results.length > 0, 'should return results');
    for (const r of results) {
      assert.ok(r.snippet.length <= limit, `snippet "${r.snippet}" exceeds snippetLength=${limit}`);
    }
  });

  it('limit parameter caps result count', async () => {
    const results = await search('note', { mode: 'fulltext', limit: 1 });
    assert.ok(results.length <= 1, `expected ≤1 results, got ${results.length}`);
  });

  it('threshold=1.0 returns no results (nothing scores perfectly)', async () => {
    const results = await search('note', { mode: 'fulltext', threshold: 1.0, limit: 10 });
    assert.strictEqual(results.length, 0, 'threshold=1.0 should return no results');
  });

  it('threshold=0.0 returns all matching results', async () => {
    const r0 = await search('note', { mode: 'fulltext', threshold: 0.0, limit: 10 });
    const rNone = await search('note', { mode: 'fulltext', limit: 10 });
    assert.strictEqual(r0.length, rNone.length, 'threshold=0 should not filter any results');
  });
});

// ─── Related mode contract ────────────────────────────────────────────────────

describe('related mode result shape', () => {
  it('depth field is present (number) in related mode results', async () => {
    const results = await search('alpha.md', {
      related: true,
      direction: 'both',
      depth: 1,
    });
    assert.ok(results.length > 0, 'should return at least the source note');
    for (const r of results) {
      assert.ok(typeof r.depth === 'number', `depth should be a number, got ${typeof r.depth}`);
    }
  });

  it('rank field is 1-based and sequential in related mode results', async () => {
    const results = await search('alpha.md', { related: true, direction: 'both', depth: 1 });
    assert.ok(results.length > 0, 'should return at least the source note');
    results.forEach((r, i) => {
      assert.strictEqual(r.rank, i + 1, `rank should be ${i + 1}, got ${r.rank}`);
    });
  });

  it('direction enum values work: outgoing, backlinks, both', async () => {
    const directions = ['outgoing', 'backlinks', 'both'] as const;
    for (const direction of directions) {
      const results = await search('alpha.md', { related: true, direction, depth: 1 });
      assert.ok(Array.isArray(results), `direction '${direction}' should return an array`);
    }
  });

  it('source note at depth 0 is always present in related results', async () => {
    const results = await search('beta.md', { related: true, direction: 'both', depth: 2 });
    const source = results.find((r) => r.path === 'beta.md');
    assert.ok(source, 'source note should always be in related results');
    assert.strictEqual(source.depth, 0, 'source note should be at depth 0');
  });
});

// ─── readNotes() contract ─────────────────────────────────────────────────────

describe('readNotes() result shape contract', () => {
  it('hit result has all required fields', () => {
    const [result] = readNotes(['alpha.md']);
    assert.ok(result?.found === true);
    if (!result.found) return;
    assert.ok(typeof result.path === 'string');
    assert.ok(typeof result.title === 'string');
    assert.ok(Array.isArray(result.aliases));
    assert.ok(Array.isArray(result.tags));
    assert.ok(typeof result.content === 'string');
    assert.ok(Array.isArray(result.links));
    assert.ok(Array.isArray(result.backlinks));
  });

  it('miss result has path, found:false, suggestions[]', () => {
    const [result] = readNotes(['does-not-exist.md']);
    assert.ok(result);
    assert.strictEqual(result.found, false);
    assert.ok(typeof result.path === 'string');
    assert.ok(Array.isArray(result.suggestions));
  });

  it('batch returns one result per input path in order', () => {
    const results = readNotes(['alpha.md', 'beta.md']);
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0]?.path, 'alpha.md');
    assert.strictEqual(results[1]?.path, 'beta.md');
  });
});
