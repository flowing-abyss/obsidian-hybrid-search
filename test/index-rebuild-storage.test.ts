import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, it } from 'vitest';
import type { PreparedIndexNote } from '../src/storage/db.js';
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-stage-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('../src/storage/db.js');
const stage = await import('../src/storage/index-rebuild.js');
let lease: NonNullable<ReturnType<typeof db.claimIndexLease>>;
const note = (name: string, dim = 3): PreparedIndexNote => ({
  path: name,
  title: name,
  tags: ['tag'],
  content: name,
  mtime: 1,
  hash: name,
  chunks: [
    { text: name, embedding: new Float32Array(dim).fill(0.5), charStart: 0, charEnd: name.length },
  ],
});
const references = {
  links: ['target.md'],
  markdownLinks: ['target.md'],
  urls: ['https://example.com'],
};
beforeEach(() => {
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
  mkdirSync(vault, { recursive: true });
  db.openDb();
  const request = randomUUID();
  db.requestForegroundIndex(request);
  lease = db.claimIndexLease(request, 'foreground')!;
  db.cancelForegroundIndexRequest(request);
  db.initVecTable(lease, 3);
  db.commitIndexedNote(lease, note('old.md'), { modelName: 'old' }, references);
});
afterAll(() => {
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
});
it('stages an incompatible rebuild without changing the active index, then publishes atomically', () => {
  const version = db.getDbVersion();
  const rebuild = stage.beginRebuild(lease, {
    modelName: 'new',
    embeddingDim: 5,
    metadata: { vaultPath: vault, apiBaseUrl: '', apiModel: '' },
  });
  stage.stageRebuildNote(lease, rebuild, note('new.md', 5), '', { mtimeMs: 1, size: 6 });
  stage.setRebuildReferences(lease, rebuild, 'new.md', references);
  assert.equal(db.getStoredModel(), 'old');
  assert.ok(db.getNoteByPath('old.md'));
  assert.equal(db.getNoteByPath('new.md'), undefined);
  stage.publishRebuild(lease, rebuild);
  assert.equal(db.getStoredModel(), 'new');
  assert.equal(db.getStoredEmbeddingDim(), 5);
  assert.equal(db.getNoteByPath('old.md'), undefined);
  assert.ok(db.getNoteByPath('new.md'));
  assert.equal(db.getDbVersion(), version + 1);
  assert.equal(
    db
      .getDb()
      .prepare("SELECT count(*) n FROM notes_fts_bm25 WHERE notes_fts_bm25 MATCH 'new'")
      .pluck()
      .get(),
    1,
  );
  assert.equal(db.getDb().prepare('PRAGMA integrity_check').pluck().get(), 'ok');
});
it('rolls back a publication failure and preserves staging for safe cleanup', () => {
  const before = db.getStats();
  const rebuild = stage.beginRebuild(lease, {
    modelName: 'new',
    embeddingDim: 3,
    metadata: { vaultPath: vault, apiBaseUrl: '', apiModel: '' },
  });
  stage.stageRebuildNote(lease, rebuild, note('new.md'), '', { mtimeMs: 1, size: 6 });
  stage.setRebuildReferences(lease, rebuild, 'new.md', references);
  db.getDb().exec(
    "CREATE TRIGGER fail_new BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT, 'publication failed'); END",
  );
  assert.throws(() => stage.publishRebuild(lease, rebuild), /publication failed/);
  assert.ok(db.getNoteByPath('old.md'));
  assert.equal(db.getStoredModel(), 'old');
  assert.deepEqual(db.getStats(), before);
  stage.discardRebuilds(lease);
  assert.equal(db.getDb().prepare('SELECT count(*) n FROM index_rebuild').pluck().get(), 0);
});
it('rejects missing embeddings and publication by a stale owner', () => {
  const rebuild = stage.beginRebuild(lease, {
    modelName: 'new',
    embeddingDim: 3,
    metadata: { vaultPath: vault, apiBaseUrl: '', apiModel: '' },
  });
  const failed = note('bad.md');
  failed.chunks[0]!.embedding = null;
  assert.throws(
    () => stage.stageRebuildNote(lease, rebuild, failed, '', { mtimeMs: 1, size: 6 }),
    /embedding/i,
  );
  db.releaseIndexLease(lease);
  assert.throws(() => stage.publishRebuild(lease, rebuild), /ownership/i);
  assert.ok(db.getNoteByPath('old.md'));
});

it('preserves discontiguous source spans through staging and atomic publication', () => {
  const projected = note('filtered.md');
  projected.content = 'one two';
  projected.chunks = [
    {
      text: 'one two',
      embedding: new Float32Array(3).fill(0.5),
      charStart: 0,
      charEnd: 13,
      sourceSpans: [[0, 3], ' ', [10, 13]],
    },
  ];
  const rebuild = stage.beginRebuild(lease, {
    modelName: 'new',
    embeddingDim: 3,
    metadata: { vaultPath: vault, apiBaseUrl: '', apiModel: '' },
  });
  stage.stageRebuildNote(lease, rebuild, projected, '', { mtimeMs: 1, size: 13 });
  stage.setRebuildReferences(lease, rebuild, projected.path, references);
  stage.publishRebuild(lease, rebuild);
  assert.deepEqual(
    JSON.parse(db.getDb().prepare('SELECT source_spans FROM chunks').pluck().get() as string),
    [[0, 3], ' ', [10, 13]],
  );
  assert.equal(db.getNoteByPath('filtered.md')?.content, 'one two');
});

it('rejects malformed spans before replacing valid active chunks', () => {
  const invalid = note('old.md');
  invalid.chunks[0]!.sourceSpans = [[4, 2]];
  const before = db.getDbVersion();
  assert.throws(
    () => db.commitIndexedNote(lease, invalid, { modelName: 'old' }, references),
    /source spans/i,
  );
  assert.equal(db.getDbVersion(), before);
  assert.equal(db.getNoteByPath('old.md')?.content, 'old.md');
  assert.equal(db.getDb().prepare('SELECT text FROM chunks').pluck().get(), 'old.md');
});
