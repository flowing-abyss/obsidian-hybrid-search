import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, it, vi } from 'vitest';
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-write-busy-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
const db = await import('./helpers/owned-storage.js');
const storage = await import('../src/storage/db.js');
const { config } = await import('../src/runtime/config.js');
const { retryIndexWrite } = await import('../src/indexing/index-write.js');
db.openDb();
db.initVecTable(4);
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

it('also retries lock contention reported by an asynchronous reconciliation callback', async () => {
  await db.withTestIndexRun(async (run) => {
    const other = new Database(config.dbPath);
    other.exec('BEGIN IMMEDIATE');
    const release = setTimeout(() => other.exec('ROLLBACK'), 20);
    let calls = 0;
    try {
      await retryIndexWrite(run, async () => {
        await Promise.resolve();
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

it.each(['deleted', 'replaced', 'ignored'])(
  'rechecks a %s source after SQLite admits a retried commit',
  async (change) => {
    const { indexFile } = await import('../src/indexing/indexer.js');
    const file = path.join(vault, 'note.md');
    const respect = vi.spyOn(config, 'respectGitignore', 'get').mockReturnValue(true);
    await db.withTestIndexRun(async (run) => {
      writeFileSync(file, '---\ntitle: Original\n---\n');
      await indexFile(run, file, 512, true);
      writeFileSync(file, '---\ntitle: Stale prepared version\n---\n');
      const other = new Database(config.dbPath);
      other.exec('BEGIN IMMEDIATE');
      const release = setTimeout(() => {
        other.exec('ROLLBACK');
        if (change === 'deleted') {
          rmSync(file);
          storage.deleteNote(run.lease, 'note.md');
        } else if (change === 'replaced')
          writeFileSync(file, '---\ntitle: Latest source version\n---\n');
        else writeFileSync(path.join(vault, '.gitignore'), 'note.md\n');
      }, 20);
      try {
        const result = await indexFile(run, file, 512, true);
        if (change === 'replaced') {
          assert.equal(result, 'indexed');
          assert.equal(db.getNoteByPath('note.md')?.title, 'Latest source version');
        } else {
          assert.equal(result, 'skipped');
          assert.equal(db.getNoteByPath('note.md'), undefined);
        }
      } finally {
        clearTimeout(release);
        if (other.inTransaction) other.exec('ROLLBACK');
        other.close();
        rmSync(path.join(vault, '.gitignore'), { force: true });
        respect.mockRestore();
      }
    });
  },
);

it('keeps and reindexes a missing source recreated while SQLite synchronously waits for a writer', async () => {
  const { indexFile } = await import('../src/indexing/indexer.js');
  const file = path.join(vault, 'recreated-during-lock.md');
  await db.withTestIndexRun(async (run) => {
    writeFileSync(file, '---\ntitle: Original\n---\n');
    assert.equal(await indexFile(run, file, 512, true), 'indexed');
    rmSync(file);
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const Database = require(process.argv[1]);
         const { writeFileSync } = require('node:fs');
         const db = new Database(process.argv[2]);
         db.exec('BEGIN IMMEDIATE');
         process.once('message', () => setTimeout(() => {
           writeFileSync(process.argv[3], '---\\ntitle: Recreated\\n---\\n');
           db.exec('ROLLBACK');
           db.close();
           process.exit(0);
         }, 100));
         process.send('locked');`,
        createRequire(import.meta.url).resolve('better-sqlite3'),
        config.dbPath,
        file,
      ],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited: Promise<unknown[]> = once(child, 'exit');
    try {
      const message: unknown = (await once(child, 'message'))[0];
      assert.equal(message, 'locked');
      assert.equal(existsSync(file), false);
      child.send('recreate');
      const result = await indexFile(run, file, 512, true);
      const [code] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(existsSync(file), true);
      assert.equal(db.getNoteByPath('recreated-during-lock.md')?.title, 'Recreated');
      assert.equal(result, 'indexed');
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
      rmSync(file, { force: true });
      storage.deleteNote(run.lease, 'recreated-during-lock.md');
    }
  });
});

it('revalidates the staged snapshot after a delayed full publication', async () => {
  const { indexFile } = await import('../src/indexing/indexer.js');
  const { rebuildIndex } = await import('../src/indexing/rebuild.js');
  const stage = await import('../src/storage/index-rebuild.js');
  const embedder = await import('../src/inference/embedder.js');
  const probe = vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(4);
  const file = path.join(vault, 'note.md');
  await db.withTestIndexRun(async (run) => {
    writeFileSync(file, '---\ntitle: Original\n---\n');
    await indexFile(run, file, 512, true);
    const other = new Database(config.dbPath);
    let release: ReturnType<typeof setTimeout> | undefined;
    const original = stage.setRebuildReferences;
    const publish = vi.spyOn(stage, 'setRebuildReferences').mockImplementationOnce((...args) => {
      original(...args);
      other.exec('BEGIN IMMEDIATE');
      release = setTimeout(() => {
        other.exec('ROLLBACK');
        rmSync(file);
      }, 20);
    });
    try {
      await rebuildIndex(run, 512);
      assert.equal(db.getNoteByPath('note.md'), undefined);
    } finally {
      clearTimeout(release);
      if (other.inTransaction) other.exec('ROLLBACK');
      other.close();
      publish.mockRestore();
      probe.mockRestore();
    }
  });
});

it('reconciles a newly created source after startup waits for a SQLite writer', async () => {
  const { startBackgroundIndexing, indexFile } = await import('../src/indexing/indexer.js');
  const file = path.join(vault, 'late.md');
  await db.withTestIndexRun(async (run) => {
    const other = new Database(config.dbPath);
    other.exec('BEGIN IMMEDIATE');
    let recreated: Promise<unknown> | undefined;
    const release = setTimeout(() => {
      other.exec('ROLLBACK');
      writeFileSync(file, '---\ntitle: Latest created source\n---\n');
      recreated = indexFile(run, file, 512, true);
    }, 20);
    try {
      await startBackgroundIndexing(run, 512);
      await recreated;
      assert.equal(db.getNoteByPath('late.md')?.title, 'Latest created source');
    } finally {
      clearTimeout(release);
      if (other.inTransaction) other.exec('ROLLBACK');
      await recreated;
      other.close();
    }
  });
});

it('allows admitted cleanup to finish after the lease expires while its outer writer lock is held', async () => {
  const { cleanupStaleNotes } = await import('../src/indexing/indexer.js');
  let time = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => time);
  db.openDb();
  try {
    await db.withTestIndexRun((run) => {
      storage.withIndexMutation(run.lease, () => {
        time += 31_000;
        cleanupStaleNotes(run);
      });
      assert.ok(storage.readIndexOwner().expiresAt > time);
      return Promise.resolve();
    });
  } finally {
    db.closeDb();
    clock.mockRestore();
    db.openDb();
  }
});
