import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-wikilink-catalog-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const { closeDb, getDb, initVecTable, openDb, upsertNote, wipeDatabaseFiles } =
  await import('../src/db.js');
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts: string[]) =>
  Promise.resolve(
    texts.map(() => ({ ok: true as const, embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]) })),
  ),
);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
  limit: 508,
  count: (text) => Math.ceil(Array.from(text).length / 4),
});

const { indexFile, indexVaultSync, resetIndexingState, resolveWikilinks } =
  await import('../src/indexer.js');

function writeNote(name: string, content: string): string {
  const file = path.join(vaultDir, name);
  writeFileSync(file, content);
  return file;
}

function outgoing(fromPath: string): string[] {
  return (
    getDb()
      .prepare('SELECT to_path FROM links WHERE from_path = ? ORDER BY to_path')
      .all(fromPath) as {
      to_path: string;
    }[]
  ).map((row) => row.to_path);
}

// Count executions, not prepared statements: a prepared catalog can be reused but
// running it once per source note still repeats the expensive full-table scan.
async function countCatalogExecutions(operation: () => Promise<void>): Promise<number> {
  const db = getDb();
  const prepare = db.prepare.bind(db);
  let executions = 0;
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql === 'SELECT path, title, aliases FROM notes') {
      const all = statement.all.bind(statement);
      vi.spyOn(statement, 'all').mockImplementation((...parameters: unknown[]) => {
        executions++;
        return all(...parameters);
      });
    }
    return statement;
  });
  try {
    await operation();
  } finally {
    spy.mockRestore();
  }
  return executions;
}

describe('final wiki-link repair catalog', () => {
  beforeEach(() => {
    closeDb();
    for (const name of readdirSync(vaultDir))
      rmSync(path.join(vaultDir, name), { recursive: true });
    wipeDatabaseFiles();
    openDb();
    initVecTable(4);
    resetIndexingState();
  });

  afterAll(() => {
    closeDb();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('repairs forward references in a no-op reindex using one catalog execution', async () => {
    const sources = ['alpha', 'beta', 'gamma'];
    for (const name of sources) {
      assert.equal(
        await indexFile(writeNote(`${name}.md`, `[[target]] from ${name}`), 512),
        'indexed',
      );
      assert.deepEqual(outgoing(`${name}.md`), []);
    }
    assert.equal(await indexFile(writeNote('target.md', '# Target'), 512), 'indexed');

    const catalogExecutions = await countCatalogExecutions(async () => {
      const result = await indexVaultSync();
      assert.equal(result.indexed, 0);
      assert.equal(result.skipped, 4);
      assert.deepEqual(result.errors, []);
    });

    assert.equal(catalogExecutions, 1);
    for (const name of sources) assert.deepEqual(outgoing(`${name}.md`), ['target.md']);
  });

  it('runs no catalog query when a no-op vault contains no wiki links', async () => {
    for (const name of ['plain-a', 'plain-b']) {
      assert.equal(
        await indexFile(writeNote(`${name}.md`, `Plain content for ${name}`), 512),
        'indexed',
      );
    }

    const catalogExecutions = await countCatalogExecutions(async () => {
      const result = await indexVaultSync();
      assert.equal(result.indexed, 0);
      assert.equal(result.skipped, 2);
      assert.deepEqual(result.errors, []);
    });

    assert.equal(catalogExecutions, 0);
    assert.deepEqual(outgoing('plain-a.md'), []);
    assert.deepEqual(outgoing('plain-b.md'), []);
  });

  it('refreshes one-off resolution after title and alias edits, ignoring malformed aliases', async () => {
    assert.equal(await indexFile(writeNote('target.md', '# Target'), 512), 'indexed');
    assert.deepEqual(resolveWikilinks('[[new title]] [[new alias]]', 'source.md'), []);

    getDb()
      .prepare('UPDATE notes SET title = ?, aliases = ? WHERE path = ?')
      .run('New Title', '{invalid JSON', 'target.md');
    assert.deepEqual(resolveWikilinks('[[new title]]', 'source.md'), ['target.md']);
    assert.deepEqual(resolveWikilinks('[[new alias]]', 'source.md'), []);

    getDb()
      .prepare('UPDATE notes SET title = ?, aliases = ? WHERE path = ?')
      .run('Changed Title', '["new alias"]', 'target.md');
    assert.deepEqual(resolveWikilinks('[[new title]]', 'source.md'), []);
    assert.deepEqual(resolveWikilinks('[[new alias]]', 'source.md'), ['target.md']);
    assert.deepEqual(resolveWikilinks('[[changed title]]', 'source.md'), ['target.md']);
  });

  it('keeps the first duplicate alias winner and last duplicate title winner', () => {
    for (const note of [
      { path: 'first.md', aliases: ['shared alias'] },
      { path: 'second.md', aliases: ['shared alias'] },
    ]) {
      upsertNote({
        ...note,
        title: 'Shared Title',
        tags: [],
        content: '',
        mtime: 1,
        hash: note.path,
        chunks: [],
      });
    }

    assert.deepEqual(resolveWikilinks('[[shared alias]]', 'source.md'), ['first.md']);
    assert.deepEqual(resolveWikilinks('[[shared title]]', 'source.md'), ['second.md']);
  });
});
