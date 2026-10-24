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
vi.doMock('chokidar', () => ({
  watch: () => {
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
