import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-live-graph-'));
process.env.OBSIDIAN_VAULT_PATH = vault;

class TestWatcher extends EventEmitter {
  add() {}
  close() {
    this.removeAllListeners();
    return Promise.resolve();
  }
}
let watcher: TestWatcher | undefined;
vi.doMock('chokidar', () => ({
  watch: () => {
    watcher = new TestWatcher();
    const current = watcher;
    setTimeout(() => current.emit('ready'), 0);
    return current;
  },
}));

const db = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const { createIndexService } = await import('../src/indexing/index-service.js');
const { config } = await import('../src/runtime/config.js');
const { indexFile, startBackgroundIndexing, resetIndexingState, getIndexingStatus } =
  await import('./helpers/owned-indexer.js');
let service: ReturnType<typeof createIndexService>;

beforeEach(() => {
  mkdirSync(vault, { recursive: true });
  db.wipeDatabaseFiles();
  db.openDb();
  db.initVecTable(4);
  resetIndexingState();
  config.debounce = 1;
  config.batchSize = 10;
  watcher = undefined;
  vi.spyOn(embedder, 'activeModelName').mockReturnValue('model-A');
  vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(4);
  vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
  vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
    limit: 508,
    count: (text) => Math.ceil(Array.from(text).length / 4),
  });
  vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts) =>
    Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
    ),
  );
  service = createIndexService();
});

afterEach(async () => {
  await service.close();
  db.closeDb();
  vi.restoreAllMocks();
  rmSync(vault, { recursive: true, force: true });
});
afterAll(() => vi.doUnmock('chokidar'));

function write(name: string, text: string): string {
  const file = path.join(vault, name);
  writeFileSync(file, text);
  return file;
}

function links(from: string, table = 'links'): string[] {
  return db
    .getDb()
    .prepare(`SELECT to_path FROM ${table} WHERE from_path = ? ORDER BY to_path`)
    .pluck()
    .all(from) as string[];
}

function marker(key = 'references_dirty'): string | undefined {
  return db.getDb().prepare('SELECT value FROM settings WHERE key = ?').pluck().get(key) as
    string | undefined;
}

async function startWatcher(): Promise<TestWatcher> {
  service.start();
  await vi.waitFor(() => {
    assert.ok(watcher);
    assert.equal(marker(), '0');
    assert.equal(getIndexingStatus().isRunning, false);
  });
  return watcher!;
}

describe('incremental graph reconciliation', () => {
  it('repairs forward wiki and Markdown links after background startup without re-embedding', async () => {
    await indexFile(write('source.md', 'See [[target]] and [target](target.md).'), 512);
    await indexFile(write('target.md', '# Target\nThe newly available target.'), 512);
    assert.deepEqual(links('source.md'), []);
    assert.deepEqual(links('source.md', 'markdown_links'), []);
    const embeddings = vi.mocked(embedder.embedDetailed);
    embeddings.mockClear();

    await startBackgroundIndexing(512);

    assert.deepEqual(links('source.md'), ['target.md']);
    assert.deepEqual(links('source.md', 'markdown_links'), ['target.md']);
    assert.equal(embeddings.mock.calls.length, 0);
    assert.equal(marker(), '0');
  });

  it('repairs an old index once even when legacy migration flags are already complete', async () => {
    await indexFile(write('source.md', 'See [[target]].'), 512);
    await indexFile(write('target.md', '# Target'), 512);
    db.getDb().exec(
      "DELETE FROM settings WHERE key='references_dirty'; INSERT OR REPLACE INTO settings VALUES('links_v1','1'),('markdown_links_v1','1');",
    );
    db.closeDb();
    db.openDb();
    resetIndexingState();

    await startBackgroundIndexing(512);

    assert.deepEqual(links('source.md'), ['target.md']);
    assert.equal(marker(), '0');
  });

  it('repairs title and alias references after explicit single-file updates', async () => {
    write('old-title.md', 'See [[Old title]].');
    write('old-alias.md', 'See [[Old alias]].');
    write('new-title.md', 'See [[New title]].');
    write('new-alias.md', 'See [[New alias]].');
    await service.reindex();
    write('target.md', '---\ntitle: Old title\naliases: [Old alias]\n---\nTarget body.');
    await service.reindex({ path: 'target.md' });
    assert.deepEqual(links('old-title.md'), ['target.md']);
    assert.deepEqual(links('old-alias.md'), ['target.md']);
    assert.deepEqual(links('new-title.md'), []);
    assert.deepEqual(links('new-alias.md'), []);

    write('target.md', '---\ntitle: New title\naliases: [New alias]\n---\nUpdated target.');
    await service.reindex({ path: 'target.md', force: true });
    assert.deepEqual(links('old-title.md'), []);
    assert.deepEqual(links('old-alias.md'), []);
    assert.deepEqual(links('new-title.md'), ['target.md']);
    assert.deepEqual(links('new-alias.md'), ['target.md']);
    assert.equal(marker(), '0');
  });

  it('does not scan every note for a body-only update', async () => {
    write('source.md', 'See [[target]].');
    write('target.md', '# Target\nInitial body.');
    await service.reindex();
    const connection = db.getDb();
    const prepare = connection.prepare.bind(connection);
    const globalReads: string[] = [];
    vi.spyOn(connection, 'prepare').mockImplementation((sql: string) => {
      if (
        sql.startsWith('SELECT path, content, frontmatter FROM notes') ||
        sql.startsWith('SELECT path, content FROM notes')
      )
        globalReads.push(sql);
      return prepare(sql);
    });

    write('target.md', '# Target\nA revised body with unchanged identity.');
    await service.reindex({ path: 'target.md', force: true });

    assert.deepEqual(globalReads, []);
    assert.deepEqual(links('source.md'), ['target.md']);
  });

  it('preserves a failed repair for retry after reopening the database', async () => {
    write('source.md', 'See [[old alias]].');
    write('target.md', '---\naliases: [old alias]\n---\nTarget.');
    await service.reindex();
    db.getDb().exec(`CREATE TRIGGER reject_graph_repair BEFORE DELETE ON links
      BEGIN SELECT RAISE(ABORT, 'graph repair unavailable'); END;`);
    write('target.md', '---\naliases: [new alias]\n---\nChanged target.');
    await assert.rejects(
      () => service.reindex({ path: 'target.md', force: true }),
      /graph repair unavailable/,
    );
    assert.equal(marker(), '1');
    assert.deepEqual(links('source.md'), ['target.md']);
    assert.ok(db.getIndexFailures().some((failure) => failure.operation === 'references'));

    db.getDb().exec('DROP TRIGGER reject_graph_repair');
    await service.close();
    db.closeDb();
    db.openDb();
    service = createIndexService();
    assert.equal((await service.reindex({ path: 'target.md' })).skipped, 1);
    assert.deepEqual(links('source.md'), []);
    assert.equal(marker(), '0');
    assert.ok(!db.getIndexFailures().some((failure) => failure.operation === 'references'));
  });

  it('updates graph targets on watcher add, rename and duplicate-alias deletion', async () => {
    write('source.md', 'See [[shared alias]], [first](first.md) and [renamed](renamed.md).');
    await service.reindex();
    const observation = await startWatcher();
    const first = write('first.md', '---\naliases: [shared alias]\n---\nFirst target.');
    observation.emit('add', first);
    await vi.waitFor(() => {
      assert.deepEqual(links('source.md'), ['first.md']);
      assert.deepEqual(links('source.md', 'markdown_links'), ['first.md']);
    });

    const renamed = path.join(vault, 'renamed.md');
    renameSync(first, renamed);
    observation.emit('unlink', first);
    observation.emit('add', renamed);
    await vi.waitFor(() => {
      assert.deepEqual(links('source.md'), ['renamed.md']);
      assert.deepEqual(links('source.md', 'markdown_links'), ['renamed.md']);
    });

    const second = write('second.md', '---\naliases: [shared alias]\n---\nSecond target.');
    observation.emit('add', second);
    await vi.waitFor(() => assert.ok(db.getNoteByPath('second.md')));
    unlinkSync(renamed);
    observation.emit('unlink', renamed);
    await vi.waitFor(() => {
      assert.deepEqual(links('source.md'), ['second.md']);
      assert.deepEqual(links('source.md', 'markdown_links'), []);
      assert.equal(marker(), '0');
    });
  });

  it('admits files added while the final partial queue batch is embedding', async () => {
    write('source.md', 'See [[late target]].');
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let admitted = false;
    vi.mocked(embedder.embedDetailed).mockImplementationOnce(async (texts) => {
      admitted = true;
      await blocked;
      return texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) }));
    });
    service.start();
    try {
      await vi.waitFor(() => assert.ok(admitted && watcher));
      const late = write('late target.md', '# Target\nAdded during indexing.');
      watcher!.emit('add', late);
      await vi.waitFor(() => assert.equal(getIndexingStatus().queued, 1));
    } finally {
      unblock();
    }
    await vi.waitFor(() => {
      assert.deepEqual(links('source.md'), ['late target.md']);
      assert.equal(getIndexingStatus().queued, 0);
      assert.equal(getIndexingStatus().isRunning, false);
    });
  });
});
