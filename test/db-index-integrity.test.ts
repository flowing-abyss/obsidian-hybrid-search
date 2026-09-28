import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-integrity-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const {
  closeDb,
  getDb,
  getStoredEmbeddingDim,
  getStoredModel,
  initVecTable,
  openDb,
  upsertLinks,
  upsertMarkdownLinks,
  upsertNote,
  upsertNoteUrls,
  wipeDatabaseFiles,
} = await import('../src/db.js');

const vector = new Float32Array([0.1, 0.2, 0.3, 0.4]);

function note(notePath = 'integrity.md') {
  return {
    path: notePath,
    title: 'Original',
    tags: ['old'],
    aliases: ['old-alias'],
    frontmatter: { status: 'old' },
    content: 'original searchable body',
    hash: 'old-hash',
    mtime: 1,
    chunks: [
      {
        text: 'original searchable body',
        embedding: vector as Float32Array | null,
        headingPath: 'Original',
        charStart: 0,
        charEnd: 24,
      },
    ],
  };
}

function snapshot() {
  const db = getDb();
  const tables = [
    'notes',
    'chunks',
    'note_aliases',
    'note_tags',
    'note_frontmatter_fields',
    'links',
    'markdown_links',
    'note_urls',
    'event_log',
    'settings',
  ];
  return {
    rows: Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    ),
    vectors: db
      .prepare('SELECT chunk_id, hex(embedding) AS bytes FROM vec_chunks ORDER BY chunk_id')
      .all(),
    oldFts: db
      .prepare(
        "SELECT rowid FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'original' ORDER BY rowid",
      )
      .all(),
    newFts: db
      .prepare(
        "SELECT rowid FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'replacement' ORDER BY rowid",
      )
      .all(),
  };
}

function seedLinks() {
  upsertLinks('integrity.md', ['target.md']);
  upsertMarkdownLinks('integrity.md', ['target.md']);
  upsertNoteUrls('integrity.md', ['https://example.com']);
}

beforeEach(() => {
  wipeDatabaseFiles();
  openDb();
  initVecTable(4);
});

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

it('rolls back a late chunk failure and the FTS trigger effects', () => {
  upsertNote(note());
  seedLinks();
  const before = snapshot();
  getDb().exec(`CREATE TRIGGER reject_second_chunk BEFORE INSERT ON chunks
    WHEN NEW.chunk_index = 1 BEGIN SELECT RAISE(ABORT, 'late chunk rejection'); END`);
  assert.throws(
    () =>
      upsertNote({
        ...note(),
        title: 'Replacement',
        content: 'replacement searchable body',
        hash: 'new-hash',
        mtime: 2,
        tags: ['new'],
        aliases: ['new-alias'],
        frontmatter: { status: 'new' },
        chunks: [
          { text: 'replacement one', embedding: vector },
          { text: 'replacement two', embedding: vector },
        ],
      }),
    /late chunk rejection/,
  );
  assert.deepEqual(snapshot(), before);
});

it('rolls back a late chunk failure for a new note', () => {
  const before = snapshot();
  getDb().exec(`CREATE TRIGGER reject_second_chunk BEFORE INSERT ON chunks
    WHEN NEW.chunk_index = 1 BEGIN SELECT RAISE(ABORT, 'late chunk rejection'); END`);
  assert.throws(
    () =>
      upsertNote({
        ...note('new.md'),
        chunks: [
          { text: 'first', embedding: vector },
          { text: 'second', embedding: vector },
        ],
      }),
    /late chunk rejection/,
  );
  assert.deepEqual(snapshot(), before);
});

it('rejects a bad later vector without leaving a new note', () => {
  const before = snapshot();
  assert.throws(() =>
    upsertNote({
      ...note('new.md'),
      chunks: [
        { text: 'valid first', embedding: vector },
        { text: 'invalid second', embedding: new Float32Array(8) },
      ],
    }),
  );
  assert.deepEqual(snapshot(), before);
});

it('rolls back a sqlite-vec rejection with missing dimension metadata', () => {
  getDb().prepare("DELETE FROM settings WHERE key = 'embedding_dim'").run();
  const before = snapshot();
  assert.throws(() =>
    upsertNote({ ...note(), chunks: [{ text: 'invalid', embedding: new Float32Array(8) }] }),
  );
  assert.deepEqual(snapshot(), before);
});

it('rolls back after the first real vector INSERT when the second fails', () => {
  upsertNote(note());
  seedLinks();
  const before = snapshot();
  const db = getDb();
  const prepare = db.prepare.bind(db);
  let vectorInsertions = 0;
  const prepareSpy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql);
    if (sql.startsWith('INSERT INTO vec_chunks')) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, 'run').mockImplementation((...parameters: unknown[]) => {
        vectorInsertions++;
        if (vectorInsertions === 2) throw new Error('injected second vector failure');
        return run(...parameters);
      });
    }
    return statement;
  });
  try {
    assert.throws(
      () =>
        upsertNote({
          ...note(),
          hash: 'changed',
          chunks: [
            { text: 'first accepted vector', embedding: vector },
            { text: 'second rejected vector', embedding: vector },
          ],
        }),
      /injected second vector failure/,
    );
    assert.equal(vectorInsertions, 2);
  } finally {
    prepareSpy.mockRestore();
  }
  assert.deepEqual(snapshot(), before);
});

it.each([vector, null])('known model mismatch preserves even null-only updates', (embedding) => {
  upsertNote(note(), { modelName: 'model-A' });
  const before = snapshot();
  assert.throws(
    () =>
      upsertNote(
        { ...note(), hash: 'changed', chunks: [{ text: 'replacement', embedding }] },
        { modelName: 'model-B' },
      ),
    /model/i,
  );
  assert.deepEqual(snapshot(), before);
});

it('known model mismatch rejects an empty chunk update', () => {
  upsertNote(note(), { modelName: 'model-A' });
  const before = snapshot();
  assert.throws(
    () => upsertNote({ ...note(), hash: 'changed', chunks: [] }, { modelName: 'model-B' }),
    /model/i,
  );
  assert.deepEqual(snapshot(), before);
});

it('leaves legacy provenance unknown after successful vector writes', () => {
  upsertNote(note());
  upsertNote({ ...note(), hash: 'changed' }, { modelName: 'model-A' });
  assert.equal(getStoredModel(), null);
});

it('leaves a legacy note-only index provenance unknown after a vector write', () => {
  upsertNote({ ...note(), chunks: [] });
  upsertNote({ ...note(), hash: 'changed' }, { modelName: 'model-A' });
  assert.equal(getStoredModel(), null);
});

it('records a fresh model only on successful vector commit', () => {
  assert.equal(getStoredModel(), null);
  upsertNote(note(), { modelName: 'model-A' });
  assert.equal(getStoredModel(), 'model-A');
});

it.each([null, 'empty'] as const)('does not record first %s ingestion', (kind) => {
  const chunks = kind === 'empty' ? [] : [{ text: 'no vector', embedding: null }];
  upsertNote({ ...note(), chunks }, { modelName: 'model-A' });
  assert.equal(getStoredModel(), null);
});

it('does not record a model after a failed first vector insertion', () => {
  const before = snapshot();
  assert.throws(() =>
    upsertNote(
      { ...note(), chunks: [{ text: 'invalid', embedding: new Float32Array(8) }] },
      { modelName: 'model-A' },
    ),
  );
  assert.equal(getStoredModel(), null);
  assert.deepEqual(snapshot(), before);
});

it('does not recreate an existing table when requested dimension changes', () => {
  upsertNote(note());
  const before = snapshot();
  initVecTable(8);
  assert.deepEqual(snapshot(), before);
});

it.each([0, -1, 4.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid new vector dimension %s',
  (dimension) => {
    wipeDatabaseFiles();
    openDb();
    const before = getDb().prepare('SELECT * FROM settings ORDER BY rowid').all();
    assert.throws(() => initVecTable(dimension), /dimension/i);
    assert.equal(
      getDb().prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vec_chunks'").get(),
      undefined,
    );
    assert.deepEqual(getDb().prepare('SELECT * FROM settings ORDER BY rowid').all(), before);
  },
);

it.each(['4junk', '0', '-1', '4.5', 'NaN'])('rejects invalid stored dimension %s', (raw) => {
  getDb().prepare("UPDATE settings SET value = ? WHERE key = 'embedding_dim'").run(raw);
  assert.equal(getStoredEmbeddingDim(), null);
});

it('accepts a compatible vector when dimension metadata is invalid', () => {
  upsertNote(note());
  getDb().prepare("UPDATE settings SET value = '4junk' WHERE key = 'embedding_dim'").run();
  upsertNote({ ...note(), hash: 'changed' });
  const storedVector = getDb()
    .prepare('SELECT vec_length(embedding) AS dim FROM vec_chunks LIMIT 1')
    .get() as { dim: number };
  assert.equal(storedVector.dim, 4);
  assert.equal(getStoredEmbeddingDim(), null);
});

it('rejects atomically when stored and actual dimensions disagree', () => {
  upsertNote(note());
  getDb().prepare("UPDATE settings SET value = '8' WHERE key = 'embedding_dim'").run();
  const before = snapshot();
  assert.throws(() => upsertNote({ ...note(), hash: 'changed' }), /dimension/i);
  assert.deepEqual(snapshot(), before);
});
