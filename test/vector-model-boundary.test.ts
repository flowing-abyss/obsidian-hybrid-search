import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { afterAll, afterEach, beforeEach, it, vi } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-vector-model-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const { createVectorReader } = await import('../src/storage/search-queries.js');
const { search } = await import('../src/search/searcher.js');
const { config } = await import('../src/runtime/config.js');

function seed(notePath: string) {
  db.upsertNote(
    {
      path: notePath,
      title: 'Orchard',
      tags: [],
      content: 'Growing an orchard.',
      hash: notePath,
      mtime: 1,
      chunks: [{ text: 'Growing an orchard.', embedding: new Float32Array([1, 0]) }],
    },
    { modelName: 'model-A' },
  );
}

function changeModel(modelName: string | null, vector?: Float32Array) {
  const writer = new Database(config.dbPath);
  try {
    if (vector) sqliteVec.load(writer);
    writer.transaction(() => {
      if (modelName === null)
        writer.prepare("DELETE FROM settings WHERE key='embedding_model'").run();
      else writer.prepare("UPDATE settings SET value=? WHERE key='embedding_model'").run(modelName);
      if (vector) writer.prepare('UPDATE vec_chunks SET embedding=?').run(vector);
      writer
        .prepare("UPDATE settings SET value=CAST(value AS INTEGER)+1 WHERE key='db_version'")
        .run();
    })();
  } finally {
    writer.close();
  }
}

beforeEach(() => {
  db.wipeDatabaseFiles();
  db.openDb();
  db.initVecTable(2);
  vi.spyOn(embedder, 'activeModelName').mockReturnValue('model-A');
  vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([1, 0])]);
  seed('source.md');
  seed('target.md');
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
});

it.each(['model-B', null])('rejects semantic queries against %s provenance', async (model) => {
  changeModel(model);
  await assert.rejects(search('orchard', { mode: 'semantic' }), /embedding model/i);
});

it.each(['semantic', 'hybrid'] as const)(
  'checks a warm %s cache after another writer switches models',
  async (mode) => {
    const before = await search('orchard', { mode });
    assert.equal(before.length, 2);
    assert.ok(before.every((result) => result.scores.semantic === 1));
    changeModel('model-B');
    if (mode === 'semantic') {
      await assert.rejects(search('orchard', { mode }), /embedding model/i);
    } else {
      const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const after = await search('orchard', { mode });
      assert.equal(after.length, 2);
      assert.ok(after.every((result) => result.scores.semantic === null));
      assert.match(
        stderr.mock.calls.map(([message]) => String(message)).join(''),
        /model.*model-B/i,
      );
    }
  },
);

it('retains lexical hybrid matches with a diagnostic for unknown provenance', async () => {
  changeModel(null);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const results = await search('orchard', { mode: 'hybrid' });
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.scores.semantic === null));
  assert.match(
    stderr.mock.calls.map(([message]) => String(message)).join(''),
    /unknown.*reindex.*--force/i,
  );
});

it('uses stored source identity for similarity when the reader provider differs', async () => {
  vi.mocked(embedder.activeModelName).mockReturnValue('reader-model-B');
  const results = await search('', { notePath: 'source.md' });
  assert.deepEqual(
    results.map((result) => [result.path, result.score]),
    [['target.md', 1]],
  );
});

it('rejects similarity from vectors with unknown provenance', async () => {
  changeModel(null);
  await assert.rejects(search('', { notePath: 'source.md' }), /embedding model/i);
});

// Switch the other SQLite connection immediately after this reader's metadata
// SELECT. The writer commits while the reader still owns its WAL snapshot.
function switchAfterModelRead() {
  const connection = db.getDb();
  const prepare = connection.prepare.bind(connection);
  let switched = false;
  vi.spyOn(connection, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes("WHERE key = 'embedding_model'")) {
      const get = statement.get.bind(statement);
      vi.spyOn(statement, 'get').mockImplementation((...parameters: unknown[]) => {
        const value = get(...parameters);
        if (!switched) {
          switched = true;
          changeModel('model-B', new Float32Array([0, 1]));
        }
        return value;
      });
    }
    return statement;
  });
}

it('captures similarity source model and vector bytes in one read snapshot', () => {
  switchAfterModelRead();
  const source = db.getChunkEmbeddingSourceByPath('source.md');
  assert.equal(db.getStoredModel(), 'model-B', 'the other writer must have committed');
  assert.equal(source.modelName, 'model-A');
  assert.deepEqual(
    source.embeddings.map((vector) => [...vector]),
    [[1, 0]],
  );
  assert.throws(
    () => createVectorReader(source.embeddings[0]!, source.modelName, 2)(),
    /embedding model mismatch/i,
  );
});

it('validates model and executes KNN against the same read snapshot', () => {
  switchAfterModelRead();
  const rows = createVectorReader(new Float32Array([1, 0]), 'model-A', 2)();
  assert.equal(db.getStoredModel(), 'model-B', 'the other writer must have committed');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.distance === 0));
});
