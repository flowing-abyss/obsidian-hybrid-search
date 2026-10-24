import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it } from 'vitest';
import type { IndexLease } from '../src/storage/index-ownership.js';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-owned-db-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const dbModule = await import('../src/storage/db.js');
const {
  openDb,
  closeDb,
  getDb,
  initVecTable,
  upsertNote,
  upsertLinks,
  upsertMarkdownLinks,
  upsertNoteUrls,
  deleteNote,
} = dbModule;

let lease: IndexLease;

const note = {
  path: 'cafe\u0301.md',
  title: 'Original',
  tags: ['keep'],
  aliases: ['old'],
  frontmatter: { status: 'old' },
  content: 'original searchable content',
  hash: 'original',
  mtime: 1,
  chunks: [{ text: 'original searchable content', embedding: new Float32Array([1, 0, 0, 0]) }],
};

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
    fts: db.prepare("SELECT rowid FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'original'").all(),
  };
}

beforeEach(() => {
  mkdirSync(vault, { recursive: true });
  openDb();
  const request = randomUUID();
  dbModule.requestForegroundIndex(request);
  const acquired = dbModule.claimIndexLease(request, 'foreground');
  assert.ok(acquired);
  lease = acquired;
  dbModule.cancelForegroundIndexRequest(request);
  initVecTable(lease, 4);
  upsertNote(lease, note);
  upsertLinks(lease, note.path, ['target.md']);
  upsertMarkdownLinks(lease, note.path, ['target.md']);
  upsertNoteUrls(lease, note.path, ['https://example.com']);
});

afterEach(() => {
  closeDb();
  rmSync(vault, { recursive: true, force: true });
});

it('rolls back vector and child deletion when deleting the note fails', () => {
  getDb().exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON notes
    BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`);
  const before = snapshot();
  assert.throws(() => deleteNote(lease, note.path), /injected delete failure/);
  assert.deepEqual(snapshot(), before);
});

it('commits a note and all references together or preserves the previous index', () => {
  getDb().exec(`CREATE TRIGGER reject_url BEFORE INSERT ON note_urls
    BEGIN SELECT RAISE(ABORT, 'injected reference failure'); END`);
  const before = snapshot();
  assert.throws(
    () =>
      dbModule.commitIndexedNote(
        lease,
        { ...note, content: 'replacement content', hash: 'replacement', mtime: 2 },
        { modelName: 'model-A' },
        { links: ['new.md'], markdownLinks: ['new.md'], urls: ['https://new.example'] },
      ),
    /injected reference failure/,
  );
  assert.deepEqual(snapshot(), before);
});

it('cannot advance the ignore signature after a failed note cleanup', () => {
  dbModule.cleanupIgnoredNotes(lease, [], 'before', () => false);
  getDb().exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON notes
    BEGIN SELECT RAISE(ABORT, 'injected delete failure'); END`);
  const before = snapshot();
  assert.throws(
    () => dbModule.cleanupIgnoredNotes(lease, ['*.md'], 'after', () => true),
    /injected delete failure/,
  );
  assert.deepEqual(snapshot(), before);
  getDb().exec('DROP TRIGGER reject_delete');
  assert.deepEqual(
    dbModule.cleanupIgnoredNotes(lease, ['*.md'], 'after', () => true),
    [note.path],
  );
  assert.equal(dbModule.getNoteByPath(note.path), undefined);
  assert.deepEqual(getDb().prepare('SELECT * FROM links').all(), [
    { from_path: note.path, to_path: 'target.md' },
  ]);
});

it('repairs only confirmed orphan vectors and persists missing-vector work', () => {
  const valid = getDb().prepare('SELECT chunk_id, hex(embedding) AS bytes FROM vec_chunks').all();
  getDb()
    .prepare('INSERT INTO vec_chunks(chunk_id, embedding) VALUES(?, ?)')
    .run(999n, new Float32Array([0, 1, 0, 0]));
  assert.deepEqual(dbModule.repairIndexIntegrity(lease), { removedVectors: 1, repairPaths: [] });
  assert.deepEqual(
    getDb().prepare('SELECT chunk_id, hex(embedding) AS bytes FROM vec_chunks').all(),
    valid,
  );
  getDb().exec('DELETE FROM vec_chunks');
  assert.deepEqual(dbModule.repairIndexIntegrity(lease), {
    removedVectors: 0,
    repairPaths: [note.path],
  });
  dbModule.reopenDatabaseForRecovery(lease);
  assert.equal(dbModule.getNoteMeta(note.path), undefined);
  dbModule.commitIndexedNote(
    lease,
    note,
    { modelName: 'model-A' },
    { links: [], markdownLinks: [], urls: [] },
  );
  assert.deepEqual(dbModule.getNoteMeta(note.path), { mtime: 1, hash: 'original' });
});

it('every exported index mutation refuses an expired writer', async () => {
  const queries = await import('../src/storage/index-queries.js');
  getDb().exec('UPDATE index_owner SET expires_at=0');
  const before = snapshot();
  const mutations = [
    () => upsertNote(lease, { ...note, hash: 'stale' }),
    () => deleteNote(lease, note.path),
    () => initVecTable(lease, 4),
    () => upsertLinks(lease, note.path, ['stale.md']),
    () => upsertMarkdownLinks(lease, note.path, ['stale.md']),
    () => upsertNoteUrls(lease, note.path, []),
    () =>
      dbModule.saveConfigMeta(lease, {
        vaultPath: vault,
        apiModel: 'stale',
        apiBaseUrl: 'http://example.com',
      }),
    () => dbModule.updateLastIndexed(lease),
    () => dbModule.cleanupIgnoredNotes(lease, ['*'], 'stale', () => true),
    () => dbModule.repairIndexIntegrity(lease),
    () => queries.updateNoteMtime(lease, 2, note.path),
    () => queries.storePopulateMissingLinks(lease, () => []),
    () => queries.storePopulateMissingMarkdownReferences(lease, () => ({ links: [], urls: [] })),
    () => queries.storeResolveAllLinks(lease, () => () => []),
    () => queries.storeResolveAllMarkdownReferences(lease, () => ({ links: [], urls: [] })),
  ];
  for (const mutation of mutations) {
    assert.throws(mutation, /ownership/i);
    assert.deepEqual(snapshot(), before);
  }
});

it.each(['settings', 'note_frontmatter_fields'])(
  'rolls back migration when a write to %s fails',
  (table) => {
    dbModule.releaseIndexLease(lease);
    getDb().prepare("DELETE FROM settings WHERE key='index_ownership_schema'").run();
    getDb().prepare("UPDATE settings SET value='0' WHERE key='frontmatter_lookup_version'").run();
    getDb().exec(`CREATE TRIGGER reject_lookup BEFORE INSERT ON ${table}
    ${table === 'settings' ? "WHEN new.key='frontmatter_lookup_version'" : ''}
    BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    assert.throws(() => openDb(), /injected migration failure/);
  },
);
