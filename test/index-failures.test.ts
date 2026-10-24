import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, it } from 'vitest';
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-index-failures-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('./helpers/owned-storage.js');
db.openDb();
afterAll(() => {
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
});
it('keeps rolled-back indexing failures separate from rejected chunks and bounds status detail', () => {
  db.withTestIndexLease((lease) => {
    for (let i = 0; i < 25; i++)
      db.recordIndexFailure(
        lease,
        `note-${i}.md`,
        'index',
        'fingerprint',
        new Error('x'.repeat(2000)),
      );
    db.recordIndexFailure(lease, 'note-0.md', 'index', 'fingerprint', new Error('repeat'));
  });
  assert.equal(db.getStats().failedIndexing, 25);
  assert.equal(db.getStats().failedChunks, 0);
  const failures = db.getIndexFailures();
  assert.equal(failures.length, 20);
  assert.ok(failures.every((failure) => failure.message.length <= 1000));
  assert.equal(db.hasIndexFailure('note-0.md', 'index', 'fingerprint'), true);
  assert.equal(db.hasIndexFailure('note-0.md', 'index', 'changed'), false);
  db.withTestIndexLease((lease) => db.clearIndexFailures(lease, 'note-0.md'));
  assert.equal(db.getStats().failedIndexing, 24);
});
