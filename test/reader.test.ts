import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, it } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-reader-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { closeDb, openDb, initVecTable, upsertNote, upsertLinks } =
  await import('./helpers/owned-storage.js');
const { readNotes } = await import('../src/search/searcher.js');

const fakeEmb = new Float32Array([0.1, 0.2, 0.3, 0.4]);

beforeAll(() => {
  mkdirSync(path.join(vaultDir, 'notes'));
  writeFileSync(
    path.join(vaultDir, 'notes/alpha.md'),
    'Alpha content with enough text to test truncation if needed.',
  );
  writeFileSync(path.join(vaultDir, 'notes/beta.md'), 'Beta content.');
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
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('readNotes() — hit', () => {
  it('returns current original body instead of filtered database content', () => {
    const original = 'Original %%knowledge%% body';
    writeFileSync(path.join(vaultDir, 'source.md'), `---\ntitle: Metadata\n---\n${original}`);
    upsertNote({
      path: 'source.md',
      title: 'Indexed metadata',
      tags: [],
      content: 'Filtered database body',
      mtime: 1,
      hash: 'source',
      chunks: [],
    });
    const [result] = readNotes(['source.md']);
    assert.ok(result?.found);
    assert.equal(result.content, original);
    assert.equal(result.title, 'Indexed metadata');
    assert.deepEqual(readNotes(['source.md'], { snippetLength: 8 })[0], {
      ...result,
      content: 'Original',
    });
    writeFileSync(path.join(vaultDir, 'source.md'), 'New original body');
    const [edited] = readNotes(['source.md']);
    assert.ok(edited?.found);
    assert.equal(edited.content, 'New original body');
    unlinkSync(path.join(vaultDir, 'source.md'));
    const [missing] = readNotes(['source.md']);
    assert.ok(missing && !missing.found);
    assert.ok(!missing.suggestions.includes('source.md'));
  });

  it('returns an empty source body rather than the older indexed content', () => {
    writeFileSync(path.join(vaultDir, 'empty.md'), '');
    upsertNote({
      path: 'empty.md',
      title: 'Empty',
      tags: [],
      content: 'Older indexed content',
      mtime: 1,
      hash: 'empty',
      chunks: [],
    });
    const [result] = readNotes(['empty.md']);
    assert.ok(result?.found);
    assert.equal(result.content, '');
  });

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
  it('reports malformed frontmatter without printing private source excerpts', () => {
    writeFileSync(path.join(vaultDir, 'invalid.md'), '---\nkey: [PRIVATE_SENTINEL\n---\nBody');
    upsertNote({
      path: 'invalid.md',
      title: 'Invalid',
      tags: [],
      content: 'Indexed body',
      mtime: 1,
      hash: 'invalid',
      chunks: [],
    });
    assert.throws(
      () => readNotes(['invalid.md']),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /invalid\.md.*frontmatter/i);
        assert.ok(!inspect(error).includes('PRIVATE_SENTINEL'));
        return true;
      },
    );
  });

  it('returns a miss for an indexed note whose source has disappeared', () => {
    upsertNote({
      path: 'deleted.md',
      title: 'Deleted',
      tags: [],
      content: 'Indexed older body',
      mtime: 1,
      hash: 'deleted',
      chunks: [],
    });
    const [result] = readNotes(['deleted.md']);
    assert.ok(result && !result.found);
    assert.equal(result.path, 'deleted.md');
    assert.ok(!result.suggestions.includes('deleted.md'));
  });

  it('does not silently fall back to indexed text after a source read error', () => {
    mkdirSync(path.join(vaultDir, 'unreadable.md'));
    upsertNote({
      path: 'unreadable.md',
      title: 'Unreadable',
      tags: [],
      content: 'Filtered text',
      mtime: 1,
      hash: 'unreadable',
      chunks: [],
    });
    assert.throws(() => readNotes(['unreadable.md']), /read.*unreadable\.md/i);
  });

  it('keeps unindexed source files as enriched read misses', () => {
    writeFileSync(path.join(vaultDir, 'unindexed.md'), 'Original unindexed body');
    const [result] = readNotes(['unindexed.md']);
    assert.ok(result && !result.found);
  });

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
    assert.ok(
      result.suggestions.includes('notes/alpha.md'),
      'suggestions should include notes/alpha.md',
    );
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
