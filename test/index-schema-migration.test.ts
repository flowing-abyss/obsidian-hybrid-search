import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, it } from 'vitest';
import type { PreparedIndexNote } from '../src/storage/db.js';
import { createIndexOwnership } from '../src/storage/index-ownership.js';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-schema-migration-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const storage = await import('../src/storage/db.js');
const rebuild = await import('../src/storage/index-rebuild.js');
const dbPath = path.join(vault, '.obsidian-hybrid-search.db');
const originalPath = 'cafe\u0301.md';
const original: PreparedIndexNote = {
  path: originalPath,
  title: 'Original',
  tags: ['retained'],
  aliases: ['old alias'],
  frontmatter: { status: 'published' },
  content: 'original searchable knowledge',
  mtime: 1,
  hash: 'original',
  chunks: [{ text: 'original searchable knowledge', embedding: new Float32Array([1, 0, 0, 0]) }],
};
const references = {
  links: ['target.md'],
  markdownLinks: ['target.md'],
  urls: ['https://example.com/retained'],
};

function claimWriter() {
  const request = randomUUID();
  storage.requestForegroundIndex(request);
  const lease = storage.claimIndexLease(request, 'foreground');
  storage.cancelForegroundIndexRequest(request);
  assert.ok(lease);
  return lease;
}

function rawConnection() {
  const db = new Database(dbPath);
  sqliteVec.load(db);
  return db;
}

function legacySnapshot(db: Database.Database) {
  return {
    notes: db
      .prepare(
        'SELECT id,path,title,tags,aliases,content,frontmatter,mtime,hash FROM notes ORDER BY id',
      )
      .all(),
    chunks: db
      .prepare(
        'SELECT id,note_id,chunk_index,text,heading_path,embedding_status,char_start,char_end FROM chunks ORDER BY id',
      )
      .all(),
    children: Object.fromEntries(
      [
        'note_aliases',
        'note_tags',
        'note_frontmatter_fields',
        'links',
        'markdown_links',
        'note_urls',
        'event_log',
      ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
    ),
    vectors: db
      .prepare('SELECT chunk_id,hex(embedding) AS bytes FROM vec_chunks ORDER BY chunk_id')
      .all(),
    settings: db
      .prepare("SELECT key,value FROM settings WHERE key!='index_schema_version' ORDER BY key")
      .all(),
    fts: db.prepare("SELECT rowid FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'original'").all(),
  };
}

function columns(db: Database.Database, table: string) {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

beforeEach(() => {
  mkdirSync(vault, { recursive: true });
  storage.openDb();
  const lease = claimWriter();
  storage.initVecTable(lease, 4);
  storage.commitIndexedNote(
    lease,
    { ...original, path: 'target.md', title: 'Target' },
    { modelName: 'model-A' },
    { links: [], markdownLinks: [], urls: [] },
  );
  storage.commitIndexedNote(lease, original, { modelName: 'model-A' }, references);
  storage.releaseIndexLease(lease);
  // This is the persisted shape from ownership-enabled builds before content filtering.
  storage.getDb().exec(`
    ALTER TABLE notes DROP COLUMN embedding_context;
    ALTER TABLE chunks DROP COLUMN source_spans;
    DELETE FROM settings WHERE key='index_schema_version';
  `);
  assert.equal(
    storage
      .getDb()
      .prepare("SELECT value FROM settings WHERE key='index_ownership_schema'")
      .pluck()
      .get(),
    '1',
  );
  storage.closeDb();
});

afterEach(() => {
  storage.closeDb();
  rmSync(vault, { recursive: true, force: true });
});

it('upgrades an owned legacy index without losing data and supports ordinary writes and rebuilds', () => {
  const raw = rawConnection();
  const before = legacySnapshot(raw);
  assert.equal(before.vectors.length, 2);
  assert.deepEqual(before.children.links, [{ from_path: originalPath, to_path: 'target.md' }]);
  raw.close();

  storage.openDb();
  const db = storage.getDb();
  assert.ok(columns(db, 'notes').includes('embedding_context'));
  assert.ok(columns(db, 'chunks').includes('source_spans'));
  assert.deepEqual(legacySnapshot(db), before);
  const lease = claimWriter();
  const added: PreparedIndexNote = {
    ...original,
    path: 'added.md',
    content: 'text',
    hash: 'added',
    embeddingContext: 'context',
    chunks: [
      {
        text: 'text',
        embedding: new Float32Array([0, 1, 0, 0]),
        charStart: 0,
        charEnd: 4,
        sourceSpans: [[0, 4]],
      },
    ],
  };
  storage.commitIndexedNote(lease, added, { modelName: 'model-A' }, references);
  assert.equal(
    db.prepare("SELECT embedding_context FROM notes WHERE path='added.md'").pluck().get(),
    'context',
  );
  assert.equal(
    db
      .prepare(
        "SELECT source_spans FROM chunks JOIN notes n ON n.id=note_id WHERE n.path='added.md'",
      )
      .pluck()
      .get(),
    '[[0,4]]',
  );

  const id = rebuild.beginRebuild(lease, {
    modelName: 'model-A',
    embeddingDim: 4,
    metadata: { vaultPath: vault, apiBaseUrl: '', apiModel: '' },
  });
  rebuild.stageRebuildNote(lease, id, added, '', { mtimeMs: 1, size: 4 }, 'none');
  rebuild.setRebuildReferences(lease, id, added.path, references);
  rebuild.publishRebuild(lease, id);
  assert.deepEqual(db.prepare('SELECT path FROM notes').all(), [{ path: 'added.md' }]);
  assert.equal(db.prepare('SELECT count(*) FROM vec_chunks').pluck().get(), 1);
  assert.equal(
    db
      .prepare("SELECT count(*) FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'text'")
      .pluck()
      .get(),
    1,
  );
  assert.equal(db.prepare('PRAGMA integrity_check').pluck().get(), 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  storage.releaseIndexLease(lease);

  db.exec(`CREATE TRIGGER reject_repeat_migration BEFORE INSERT ON settings
    WHEN new.key='index_schema_version'
    BEGIN SELECT RAISE(ABORT, 'migration repeated'); END`);
  storage.openDb();
  assert.equal(storage.getNoteByPath('added.md')?.content, 'text');
});

it('rolls back added columns and preserves the legacy index if migration publication fails', () => {
  const raw = rawConnection();
  const before = legacySnapshot(raw);
  raw.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON settings
    WHEN new.key='index_schema_version'
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
  try {
    assert.throws(() => storage.openDb(), /injected migration failure/);
    assert.equal(columns(raw, 'notes').includes('embedding_context'), false);
    assert.equal(columns(raw, 'chunks').includes('source_spans'), false);
    assert.deepEqual(legacySnapshot(raw), before);
    assert.equal(
      raw.prepare("SELECT value FROM settings WHERE key='index_schema_version'").get(),
      undefined,
    );
    assert.equal(raw.prepare('SELECT token FROM index_owner').pluck().get(), null);
    raw.exec('DROP TRIGGER reject_migration');
    storage.openDb();
    assert.deepEqual(legacySnapshot(storage.getDb()), before);
    assert.ok(columns(storage.getDb(), 'notes').includes('embedding_context'));
  } finally {
    raw.close();
  }
});

it.each(['background', 'foreground'] as const)(
  'waits for an active %s owner before upgrading the old schema',
  (mode) => {
    const raw = rawConnection();
    const owner = createIndexOwnership(raw);
    const request = randomUUID();
    if (mode === 'foreground') owner.requestForeground(request);
    const lease = owner.claim(request, mode);
    owner.cancelForegroundRequest(request);
    assert.ok(lease);
    const before = legacySnapshot(raw);
    try {
      assert.throws(() => storage.openDb(), storage.IndexInitializationBusyError);
      assert.deepEqual(legacySnapshot(raw), before);
      assert.equal(columns(raw, 'notes').includes('embedding_context'), false);
      assert.equal(owner.read().token, lease.token);
      owner.release(lease);
      storage.openDb();
      assert.deepEqual(legacySnapshot(storage.getDb()), before);
      assert.ok(columns(storage.getDb(), 'notes').includes('embedding_context'));
    } finally {
      owner.release(lease);
      raw.close();
    }
  },
);
