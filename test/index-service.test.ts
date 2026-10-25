import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, it, vi, type MockInstance } from 'vitest';
const vault = mkdtempSync(path.join(tmpdir(), 'ohs-index-service-'));
process.env.OBSIDIAN_VAULT_PATH = vault;
class Watcher extends EventEmitter {
  add() {}
  close() {
    this.removeAllListeners();
    return Promise.resolve();
  }
}
let watcher: Watcher;
let watcherStartupError: Error | undefined;
vi.doMock('chokidar', () => ({
  watch: () => {
    if (watcherStartupError) throw watcherStartupError;
    watcher = new Watcher();
    setTimeout(() => watcher.emit('ready'), 0);
    return watcher;
  },
}));
const db = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const { createIndexService } = await import('../src/indexing/index-service.js');
const { config } = await import('../src/runtime/config.js');
const { getIndexingStatus } = await import('../src/indexing/indexer.js');
let service: ReturnType<typeof createIndexService>;
let embeddings: MockInstance<typeof embedder.embedDetailed>;
beforeEach(() => {
  watcherStartupError = undefined;
  mkdirSync(vault, { recursive: true });
  db.openDb();
  db.initVecTable(4);
  config.debounce = 1;
  vi.spyOn(embedder, 'activeModelName').mockReturnValue('model-A');
  vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(4);
  vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
  vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
    limit: 508,
    count: (text) => text.length / 4,
  });
  embeddings = vi
    .spyOn(embedder, 'embedDetailed')
    .mockImplementation((texts) =>
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
function body(): string | undefined {
  return db.getNoteByPath('note.md')?.content;
}
function write(text: string): void {
  writeFileSync(path.join(vault, 'note.md'), text);
}

it('keeps a complete active index when documents fail after a successful force probe', async () => {
  write('Original searchable body');
  await service.reindex();
  const before = body();
  const version = db.getDbVersion();
  write('Replacement body');
  embeddings.mockResolvedValue([{ ok: false, kind: 'permanent', message: 'rejected' }]);
  await assert.rejects(service.reindex({ force: true }), /embedding.*failed/);
  assert.equal(vi.mocked(embedder.getEmbeddingDim).mock.calls.length, 1);
  assert.equal(body(), before);
  assert.equal(db.getDbVersion(), version);
  assert.equal(db.getDb().prepare('SELECT count(*) FROM index_rebuild').pluck().get(), 0);
});
it('reconciles a source edit during force and publishes only its latest contents', async () => {
  write('Original searchable body');
  await service.reindex();
  write('Changing body');
  embeddings.mockImplementationOnce((texts) => {
    write('Current content after edit');
    return Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
    );
  });
  await service.reindex({ force: true });
  assert.equal(body(), 'Current content after edit');
});
it('reconciles deletion during force and supports an empty vault', async () => {
  write('Deleted during inference');
  embeddings.mockImplementationOnce((texts) => {
    rmSync(path.join(vault, 'note.md'));
    return Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
    );
  });
  const result = await service.reindex({ force: true });
  assert.equal(result.indexed, 0);
  assert.equal(db.getStats().total, 0);
  const empty = await service.reindex({ force: true });
  assert.equal(empty.indexed, 0);
});
it('suppresses twenty unchanged failed watcher events, permits explicit retry, and clears the failure after a source change', async () => {
  write('Rejected commit content');
  db.getDb().exec(
    "CREATE TRIGGER reject_note BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'synthetic SQL rejection');END",
  );
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    service.start();
    await vi.waitFor(() => assert.equal(db.getStats().failedIndexing, 1));
    assert.equal(db.getStats().failedChunks, 0);
    assert.equal(db.getStats().lastIndexed, null);
    const initial = embeddings.mock.calls.length;
    for (let i = 0; i < 20; i++) {
      watcher.emit('change', path.join(vault, 'note.md'));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    await vi.waitFor(() => assert.equal(getIndexingStatus().isRunning, false));
    assert.equal(embeddings.mock.calls.length, initial);
    const retry = await service.reindex({ path: 'note.md' });
    assert.equal(retry.errors.length, 1);
    assert.equal(embeddings.mock.calls.length, initial + 1);
    db.getDb().exec('DROP TRIGGER reject_note');
    write('New successful content');
    await service.reindex({ path: 'note.md' });
    assert.equal(body(), 'New successful content');
    assert.equal(db.getStats().failedIndexing, 0);
  } finally {
    stderr.mockRestore();
  }
});
it('opens a search-only MCP runtime without probing embeddings or initializing vectors', async () => {
  db.wipeDatabaseFiles();
  const { createMcpRuntime, closeMcpRuntime } = await import('../src/transports/mcp-runtime.js');
  const runtime = await createMcpRuntime();
  assert.equal(vi.mocked(embedder.getEmbeddingDim).mock.calls.length, 0);
  assert.equal(embeddings.mock.calls.length, 0);
  assert.equal(db.hasVecTable(), false);
  assert.equal(
    db.getDb().prepare("SELECT value FROM settings WHERE key='api_model'").get(),
    undefined,
  );
  await closeMcpRuntime(runtime);
});

it('reports a rolled-back stale-note cleanup without changing the previous index', async () => {
  write('Keep this indexed body until deletion commits.');
  await service.reindex();
  const before = body();
  db.getDb().exec(
    "CREATE TRIGGER reject_delete BEFORE DELETE ON notes BEGIN SELECT RAISE(ABORT,'synthetic delete failure');END",
  );
  rmSync(path.join(vault, 'note.md'));
  await assert.rejects(service.reindex(), /synthetic delete failure/);
  assert.equal(body(), before);
  assert.equal(db.getStats().failedIndexing, 1);
  assert.equal(db.getIndexFailures()[0]?.operation, 'cleanup');
});

it('indexes the latest queued source after both previous attempts changed during inference', async () => {
  write('Original indexed content.');
  await service.reindex();
  const initialCalls = embeddings.mock.calls.length;
  await service.close();
  service = createIndexService();
  let attempts = 0;
  embeddings.mockImplementation(async (texts) => {
    attempts++;
    if (attempts <= 2) {
      write(attempts === 1 ? 'Second changing source version.' : 'Third stable source version.');
      watcher.emit('change', path.join(vault, 'note.md'));
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    return texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) }));
  });
  write('First changing source version.');
  service.start();
  await vi.waitFor(() => assert.equal(body(), 'Third stable source version.'));
  await vi.waitFor(() => assert.equal(getIndexingStatus().isRunning, false));
  assert.equal(embeddings.mock.calls.length - initialCalls, 3);
  assert.equal(db.getStats().failedIndexing, 0);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(embeddings.mock.calls.length - initialCalls, 3, 'the stable source must not loop');
});

it('preserves typed YAML frontmatter and filter lookups through full force publication', async () => {
  write(
    '---\nvalue: .inf\nnegative: -.inf\ninvalid: .nan\ndate: 2024-01-02\nlist: [1, true, null]\n---\nTyped frontmatter body.',
  );
  await service.reindex();
  const previous = db.getNoteByPath('note.md')!.frontmatter;
  const fields = () =>
    db
      .getDb()
      .prepare('SELECT field,value,value_norm FROM note_frontmatter_fields ORDER BY field,value')
      .all();
  const before = fields();
  await service.reindex({ force: true });
  assert.equal(db.getNoteByPath('note.md')!.frontmatter, previous);
  assert.deepEqual(fields(), before);
});

it.each(['background', 'force'])(
  'drains every admitted %s file even when its sibling observes cancellation first',
  async (mode) => {
    write('First file with a native request.');
    writeFileSync(path.join(vault, 'second.md'), 'Second file with a native request.');
    type Outcomes = Awaited<ReturnType<typeof embedder.embedDetailed>>;
    const releases: Array<(outcomes: Outcomes) => void> = [];
    embeddings.mockImplementation(() => new Promise<Outcomes>((resolve) => releases.push(resolve)));
    const indexing =
      mode === 'force' ? service.reindex({ force: true }).catch(() => undefined) : undefined;
    if (mode === 'background') service.start();
    await vi.waitFor(() => assert.equal(releases.length, 2));
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    const outcomes = [{ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) }];
    try {
      releases[0]!(outcomes);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(closed, false, 'the sibling native call is still pending');
    } finally {
      releases[1]!(outcomes);
      await closing;
      await indexing;
    }
  },
);

it('ignores a stale debounce callback after another process claims ownership', async () => {
  write('---\ntitle: Empty body\n---\n');
  service.start();
  await vi.waitFor(() => assert.ok(db.getNoteByPath('note.md')));
  const storage = await import('../src/storage/db.js');
  storage.requestForegroundIndex('preempt');
  const lease = storage.claimIndexLease('preempt', 'foreground');
  assert.ok(lease);
  storage.cancelForegroundIndexRequest('preempt');
  vi.useFakeTimers();
  try {
    watcher.emit('change', path.join(vault, 'note.md'));
    assert.doesNotThrow(() => vi.advanceTimersByTime(config.debounce));
  } finally {
    vi.useRealTimers();
    storage.releaseIndexLease(lease);
  }
});

it('does not let a deferred unlink delete a recreated and freshly indexed note', async () => {
  write('---\ntitle: Original\n---\n');
  service.start();
  await vi.waitFor(() => assert.ok(db.getNoteByPath('note.md')));
  const storage = await import('../src/storage/db.js');
  const { indexFile } = await import('../src/indexing/indexer.js');
  const owner = storage.readIndexOwner();
  assert.ok(owner.token);
  const run = {
    lease: { token: owner.token, mode: 'background' as const },
    signal: new AbortController().signal,
  };
  const blocker = new Database(config.dbPath);
  blocker.exec('BEGIN IMMEDIATE');
  const file = path.join(vault, 'note.md');
  rmSync(file);
  watcher.emit('unlink', file);
  const recreated = new Promise<void>((resolve, reject) =>
    setTimeout(() => {
      blocker.exec('ROLLBACK');
      write('---\ntitle: Recreated\n---\n');
      indexFile(run, file, 512, true).then(() => resolve(), reject);
    }, 20),
  );
  try {
    await recreated;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(db.getNoteByPath('note.md')?.title, 'Recreated');
  } finally {
    if (blocker.inTransaction) blocker.exec('ROLLBACK');
    blocker.close();
  }
});

it.each(['full', 'force', 'files', 'path'])(
  'reports progress to other readers during %s foreground indexing',
  async (mode) => {
    write('A document held during foreground embedding.');
    let complete!: (value: Awaited<ReturnType<typeof embedder.embedDetailed>>) => void;
    embeddings.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const indexing =
      mode === 'files'
        ? service.reindexFiles(['note.md'])
        : service.reindex(
            mode === 'force' ? { force: true } : mode === 'path' ? { path: 'note.md' } : {},
          );
    try {
      await vi.waitFor(() => assert.equal(embeddings.mock.calls.length, 1));
      assert.deepEqual(getIndexingStatus(), { isRunning: true, queued: 1, processed: 0, total: 1 });
    } finally {
      complete([{ ok: true, embedding: new Float32Array([1, 0, 0, 0]) }]);
      await indexing;
    }
    assert.equal(getIndexingStatus().isRunning, false);
  },
);

it.each(['startup', 'running'] as const)(
  'releases ownership and records a fatal %s watcher failure without retrying',
  async (phase) => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    write('Original searchable body');
    await service.reindex();
    const before = body();
    const version = db.getDbVersion();
    if (phase === 'startup') watcherStartupError = new Error('EACCES watcher unavailable');
    service.start();
    if (phase === 'running') {
      await vi.waitFor(() => assert.equal(db.readIndexOwner().mode, 'background'));
      await vi.waitFor(() => assert.equal(watcher.listenerCount('error'), 1));
      await vi.waitFor(() => assert.equal(getIndexingStatus().isRunning, false));
      watcher.emit('error', new Error('EMFILE watcher unavailable'));
    }
    await vi.waitFor(() => assert.equal(db.getStats().failedIndexing, 1));
    await vi.waitFor(() => assert.equal(db.readIndexOwner().token, null));
    assert.equal(body(), before);
    assert.equal(db.getDbVersion(), version);
    assert.equal(db.getStats().failedIndexing, 1);
    assert.equal(db.getIndexFailures()[0]?.operation, 'watcher');
    assert.match(db.getIndexFailures()[0]!.message, /watcher unavailable/);
    assert.match(report.mock.calls.flat().join(' '), /indexing stopped/);
    const embeddingCalls = embeddings.mock.calls.length;
    write('A change after the watcher failed');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(embeddings.mock.calls.length, embeddingCalls);
    assert.equal(db.readIndexOwner().token, null);
    // An explicit retry is the recovery path for this process.
    watcherStartupError = undefined;
    await service.reindex();
    await vi.waitFor(() => assert.equal(db.readIndexOwner().mode, 'background'));
    await vi.waitFor(() => assert.equal(db.getStats().failedIndexing, 0));
    assert.equal(body(), 'A change after the watcher failed');
  },
);

it('cancels and drains an admitted indexing batch when its watcher fails', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  write('A source being embedded when its watcher fails');
  let complete!: (outcomes: Awaited<ReturnType<typeof embedder.embedDetailed>>) => void;
  embeddings.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  service.start();
  try {
    await vi.waitFor(() => assert.equal(embeddings.mock.calls.length, 1));
    const signal = embeddings.mock.calls[0]?.[2]?.signal;
    assert.ok(signal);
    watcher.emit('error', new Error('EMFILE while embedding'));
    await vi.waitFor(() => assert.equal(signal.aborted, true));
    assert.ok(db.readIndexOwner().token, 'native work still has to drain before handoff');
  } finally {
    complete?.([{ ok: true, embedding: new Float32Array([1, 0, 0, 0]) }]);
  }
  await vi.waitFor(() => assert.equal(db.readIndexOwner().token, null));
  assert.equal(body(), undefined, 'cancelled inference cannot commit after the watcher failed');
  assert.equal(db.getStats().chunks, 0);
  assert.equal(db.getIndexFailures()[0]?.operation, 'watcher');
});

it('preserves an unknown-model legacy snapshot until an explicit force rebuild succeeds', async () => {
  write('Original searchable body');
  await service.reindex();
  db.getDb().prepare("DELETE FROM settings WHERE key='embedding_model'").run();
  const snapshot = () => ({
    note: db.getNoteByPath('note.md'),
    chunks: db.getDb().prepare('SELECT * FROM chunks ORDER BY id').all(),
    vectors: db
      .getDb()
      .prepare('SELECT chunk_id,hex(embedding) bytes FROM vec_chunks ORDER BY chunk_id')
      .all(),
    version: db.getDbVersion(),
    model: db.getStoredModel(),
    metadata: db
      .getDb()
      .prepare(
        "SELECT key,value FROM settings WHERE key IN ('api_model','embedding_dim','last_indexed') ORDER BY key",
      )
      .all(),
  });
  const before = snapshot();
  await assert.rejects(service.reindex(), /unknown.*reindex.*--force/i);
  assert.deepEqual(snapshot(), before);
  write('Replacement searchable body');
  embeddings.mockResolvedValue([{ ok: false, kind: 'permanent', message: 'rejected' }]);
  await assert.rejects(service.reindex({ force: true }), /embedding.*failed/i);
  assert.deepEqual(snapshot(), before);
  embeddings.mockImplementation((texts) =>
    Promise.resolve(
      texts.map(() => ({
        ok: true as const,
        embedding: new Float32Array([0, 1, 0, 0]),
      })),
    ),
  );
  await service.reindex({ force: true });
  assert.equal(db.getStoredModel(), 'model-A');
  assert.equal(body(), 'Replacement searchable body');
  assert.deepEqual([...db.getChunkEmbeddingsByPath('note.md')[0]!], [0, 1, 0, 0]);
});
