import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, it, vi } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-chunk-policy-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('../src/storage/db.js');
const { config } = await import('../src/runtime/config.js');
let lease: NonNullable<ReturnType<typeof db.claimIndexLease>>;
const initial = { chunkTokens: 512, contextLength: 8192 };
const larger = { chunkTokens: 1024, contextLength: 8192 };
const note = {
  path: 'note.md',
  title: 'Note',
  tags: [],
  content: 'Original searchable content',
  mtime: 1,
  hash: 'original',
  chunks: [],
};

beforeEach(() => {
  mkdirSync(vault, { recursive: true });
  db.openDb();
  const request = randomUUID();
  db.requestForegroundIndex(request);
  lease = db.claimIndexLease(request, 'foreground')!;
  db.cancelForegroundIndexRequest(request);
  db.initVecTable(lease, 3);
});
afterEach(() => {
  db.closeDb();
  vi.unstubAllEnvs();
  rmSync(vault, { recursive: true, force: true });
});

it('persists the first chunk policy and retains it after reopening with different preferences', () => {
  assert.equal(db.getStoredChunkPolicy(), null);
  assert.deepEqual(db.initializeChunkPolicy(lease, initial), initial);
  assert.deepEqual(db.initializeChunkPolicy(lease, larger), initial);
  db.closeDb();
  db.openDb();
  assert.deepEqual(db.getStoredChunkPolicy(), initial);
});

it('does not invent a chunk policy for existing notes without provenance', () => {
  db.upsertNote(lease, note, { modelName: 'fixture' });
  const version = db.getDbVersion();
  assert.throws(
    () => db.initializeChunkPolicy(lease, initial),
    /chunk.*unknown.*reindex.*--force/i,
  );
  assert.equal(db.getStoredChunkPolicy(), null);
  assert.equal(db.getNoteByPath(note.path)?.content, note.content);
  assert.equal(db.getDbVersion(), version);
});

it('preserves legacy vectors without rows instead of treating their index as empty', () => {
  db.getDb()
    .prepare('INSERT INTO vec_chunks(chunk_id,embedding) VALUES(?,?)')
    .run(1n, Buffer.from(new Float32Array([1, 0, 0]).buffer));
  assert.throws(
    () => db.initializeChunkPolicy(lease, initial),
    /chunk.*unknown.*reindex.*--force/i,
  );
  assert.equal(db.getStoredChunkPolicy(), null);
  assert.equal(db.getDb().prepare('SELECT count(*) FROM vec_chunks').pluck().get(), 1);
});

for (const values of [
  ['0', '8192'],
  ['512', 'bad'],
  ['1024', '512'],
  ['512', null],
] as const) {
  it(`preserves corrupt stored policy ${values.join('/')} for explicit repair`, () => {
    const set = db.getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?)');
    set.run('chunk_tokens', values[0]);
    if (values[1] !== null) set.run('context_length', values[1]);
    assert.throws(() => db.getStoredChunkPolicy(), /chunk.*invalid.*reindex.*--force/i);
    assert.throws(() => db.initializeChunkPolicy(lease, initial), /chunk.*invalid/i);
    assert.equal(
      db.getDb().prepare("SELECT value FROM settings WHERE key='chunk_tokens'").pluck().get(),
      values[0],
    );
  });
}

it('rejects a prepared write with a different chunk policy without altering the index', () => {
  db.initializeChunkPolicy(lease, initial);
  db.upsertNote(lease, note, { modelName: 'fixture', chunkPolicy: initial });
  const version = db.getDbVersion();
  assert.throws(
    () =>
      db.upsertNote(
        lease,
        { ...note, content: 'Replacement' },
        {
          modelName: 'fixture',
          chunkPolicy: larger,
        },
      ),
    /chunk.*mismatch/i,
  );
  assert.equal(db.getNoteByPath(note.path)?.content, note.content);
  assert.equal(db.getDbVersion(), version);
});

it('publishes a replacement policy with the rows and rolls it back on failed publication', () => {
  db.initializeChunkPolicy(lease, initial);
  db.upsertNote(lease, note, { modelName: 'fixture', chunkPolicy: initial });
  const target = {
    modelName: 'fixture',
    embeddingDim: 3,
    chunkPolicy: larger,
    metadata: { vaultPath: vault, apiBaseUrl: '', apiModel: 'fixture' },
  };
  const rows = [
    {
      note: { ...note, content: 'Replacement' },
      references: { links: [], markdownLinks: [], urls: [] },
    },
  ];
  db.getDb().exec(
    "CREATE TRIGGER reject_replacement BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'fixture failed publication'); END",
  );
  assert.throws(() => db.replaceActiveIndex(lease, target, rows), /fixture failed publication/);
  assert.deepEqual(db.getStoredChunkPolicy(), initial);
  assert.equal(db.getNoteByPath(note.path)?.content, note.content);
  db.getDb().exec('DROP TRIGGER reject_replacement');
  db.replaceActiveIndex(lease, target, rows);
  assert.deepEqual(db.getStoredChunkPolicy(), larger);
  assert.equal(db.getNoteByPath(note.path)?.content, 'Replacement');
});

it('clears outdated chunk provenance if a legacy caller replaces the index without it', () => {
  db.initializeChunkPolicy(lease, initial);
  db.replaceActiveIndex(
    lease,
    {
      modelName: 'fixture',
      embeddingDim: 3,
      metadata: { vaultPath: vault, apiBaseUrl: '', apiModel: 'fixture' },
    },
    [],
  );
  assert.equal(db.getStoredChunkPolicy(), null);
});

for (const value of ['', '  ', '0', '-1', '1.5', '512abc', 'Infinity', '9007199254740992']) {
  it(`rejects invalid explicit chunk token configuration ${value}`, () => {
    vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', value);
    assert.throws(() => config.chunkTokens, /OBSIDIAN_CHUNK_TOKENS.*positive integer/);
  });
}
it('distinguishes missing chunk configuration from a valid explicit value', () => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', undefined);
  assert.equal(config.chunkTokens, undefined);
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', ' 1024 ');
  assert.equal(config.chunkTokens, 1024);
});
