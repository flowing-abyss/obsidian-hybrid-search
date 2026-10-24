import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, it } from 'vitest';
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-write-busy-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('./helpers/owned-storage.js');
const storage = await import('../src/storage/db.js');
const { config } = await import('../src/runtime/config.js');
const { retryIndexWrite } = await import('../src/indexing/index-write.js');
db.openDb();
afterAll(() => {
  db.closeDb();
  rmSync(vault, { recursive: true, force: true });
});
it('retries a busy fenced write after the other connection releases its writer lock', async () => {
  await db.withTestIndexRun(async (run) => {
    const other = new Database(config.dbPath);
    other.exec('BEGIN IMMEDIATE');
    const release = setTimeout(() => other.exec('ROLLBACK'), 20);
    let calls = 0;
    try {
      await retryIndexWrite(run, () => {
        calls++;
        storage.updateLastIndexed(run.lease);
      });
      assert.equal(calls, 2);
    } finally {
      clearTimeout(release);
      if (other.inTransaction) other.exec('ROLLBACK');
      other.close();
    }
  });
});
it('bounds persistent contention to the initial attempt and three asynchronous retries', async () => {
  await db.withTestIndexRun(async (run) => {
    const other = new Database(config.dbPath);
    other.exec('BEGIN IMMEDIATE');
    let calls = 0;
    try {
      await assert.rejects(
        retryIndexWrite(run, () => {
          calls++;
          storage.updateLastIndexed(run.lease);
        }),
        /locked|busy/,
      );
      assert.equal(calls, 4);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
  });
});
