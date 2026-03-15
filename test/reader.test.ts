import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-reader-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { openDb, initVecTable, upsertNote, upsertLinks } = await import('../src/db.js');
const { readNotes } = await import('../src/searcher.js');

const fakeEmb = new Float32Array([0.1, 0.2, 0.3, 0.4]);

beforeAll(() => {
  openDb();
  initVecTable(4);

  upsertNote({
    path: 'notes/alpha.md',
    title: 'Alpha Note',
    tags: ['pkm', 'zettel'],
    aliases: ['α', 'slip-box'],
    content: 'Alpha content with enough text to test truncation if needed.',
    mtime: Date.now(),
    hash: 'h1',
    chunks: [{ text: 'Alpha content', embedding: fakeEmb }],
  });
  upsertNote({
    path: 'notes/beta.md',
    title: 'Beta Note',
    tags: [],
    aliases: [],
    content: 'Beta content.',
    mtime: Date.now(),
    hash: 'h2',
    chunks: [{ text: 'Beta content', embedding: fakeEmb }],
  });
  upsertLinks('notes/alpha.md', ['notes/beta.md']);
});

afterAll(() => {
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('readNotes() — hit', () => {
  it('returns found:true with all enriched fields', () => {
    const [result] = readNotes(['notes/alpha.md']);
    assert.ok(result, 'should return a result');
    assert.strictEqual(result.found, true);
    if (!result.found) return;
    assert.strictEqual(result.path, 'notes/alpha.md');
    assert.strictEqual(result.title, 'Alpha Note');
    assert.deepEqual(result.tags, ['pkm', 'zettel']);
    assert.deepEqual(result.aliases, ['α', 'slip-box']);
    assert.ok(typeof result.content === 'string' && result.content.length > 0);
    assert.ok(Array.isArray(result.links));
    assert.ok(Array.isArray(result.backlinks));
  });

  it('includes outgoing links and backlinks when related:true (default)', () => {
    const [alpha] = readNotes(['notes/alpha.md']);
    assert.ok(alpha?.found);
    if (!alpha.found) return;
    assert.ok(alpha.links.includes('notes/beta.md'), 'alpha should link to beta');

    const [beta] = readNotes(['notes/beta.md']);
    assert.ok(beta?.found);
    if (!beta.found) return;
    assert.ok(beta.backlinks.includes('notes/alpha.md'), 'beta should have alpha as backlink');
  });

  it('omits links/backlinks when related:false', () => {
    const [result] = readNotes(['notes/alpha.md'], { related: false });
    assert.ok(result?.found);
    if (!result.found) return;
    assert.deepEqual(result.links, []);
    assert.deepEqual(result.backlinks, []);
  });

  it('truncates content at snippetLength when provided', () => {
    const limit = 10;
    const [result] = readNotes(['notes/alpha.md'], { snippetLength: limit });
    assert.ok(result?.found);
    if (!result.found) return;
    assert.ok(result.content.length <= limit, `content.length ${result.content.length} > ${limit}`);
  });

  it('returns full content when snippetLength is undefined', () => {
    const [full] = readNotes(['notes/alpha.md']);
    assert.ok(full?.found);
    if (!full.found) return;
    assert.ok(full.content.length > 10, 'full content should not be truncated');
  });
});

describe('readNotes() — miss', () => {
  it('returns found:false for non-existent path', () => {
    const [result] = readNotes(['notes/nonexistent.md']);
    assert.ok(result, 'should return a result even on miss');
    assert.strictEqual(result.found, false);
    assert.strictEqual(result.path, 'notes/nonexistent.md');
  });

  it('provides fuzzy suggestions on miss', () => {
    const [result] = readNotes(['notes/alph.md']); // typo of alpha
    assert.ok(result);
    assert.strictEqual(result.found, false);
    if (result.found) return;
    assert.ok(Array.isArray(result.suggestions));
  });

  it('does not throw when all paths miss', () => {
    assert.doesNotThrow(() => readNotes(['a.md', 'b.md', 'c.md']));
  });
});

describe('readNotes() — batch', () => {
  it('returns results in input order, one per path', () => {
    const results = readNotes(['notes/alpha.md', 'notes/beta.md', 'notes/missing.md']);
    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0]?.path, 'notes/alpha.md');
    assert.strictEqual(results[1]?.path, 'notes/beta.md');
    assert.strictEqual(results[2]?.path, 'notes/missing.md');
  });

  it('empty paths array returns empty array', () => {
    const results = readNotes([]);
    assert.deepEqual(results, []);
  });
});
