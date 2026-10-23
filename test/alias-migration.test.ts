import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-alias-migration-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

const legacyDbPath = path.join(vaultDir, '.obsidian-hybrid-search.db');
const legacyDb = new Database(legacyDbPath);
legacyDb.exec(`
  CREATE TABLE notes (
    id      INTEGER PRIMARY KEY,
    path    TEXT UNIQUE NOT NULL,
    title   TEXT,
    tags    TEXT,
    content TEXT,
    mtime   REAL,
    hash    TEXT,
    aliases TEXT
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);
legacyDb
  .prepare(
    'INSERT INTO notes (path, title, tags, content, mtime, hash, aliases) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  .run(
    'legacy-alias.md',
    'Legacy Alias Note',
    '[]',
    'This note existed before the alias lookup migration.',
    Date.now(),
    'legacy-hash',
    JSON.stringify(['ЗК', 'Legacy Alias']),
  );
legacyDb.close();

const { openDb, getDb, wipeDatabaseFiles } = await import('../src/storage/db.js');
const { search } = await import('../src/search/searcher.js');

beforeAll(() => {
  openDb();
});

afterAll(() => {
  wipeDatabaseFiles();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('alias lookup migration', () => {
  it('backfills note_aliases from existing notes.aliases without reindexing', () => {
    const rows = getDb()
      .prepare('SELECT alias, alias_norm FROM note_aliases ORDER BY alias')
      .all() as Array<{ alias: string; alias_norm: string }>;

    assert.deepEqual(rows, [
      { alias: 'Legacy Alias', alias_norm: 'legacy alias' },
      { alias: 'ЗК', alias_norm: 'зк' },
    ]);
  });

  it('finds legacy aliases via title search after migration', async () => {
    const results = await search('зк', { mode: 'title', limit: 5 });
    assert.equal(results[0]?.path, 'legacy-alias.md');
  });
});
