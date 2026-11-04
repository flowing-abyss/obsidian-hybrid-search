import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, it, vi } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-chunk-indexing-'));
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
const { estimateTokens } = await import('../src/content/chunker.js');
const { config } = await import('../src/runtime/config.js');
const originalDebounce = config.debounce;
let service: ReturnType<typeof createIndexService>;
let modelContext: number;
let inputs: string[];
const body = Array.from(
  { length: 4 },
  (_, i) =>
    `## Section ${i + 1}\n\n${'这是笔记中的一个具体细节，需要通过段落检索准确定位。'.repeat(18)}`,
).join('\n\n');
function write(name = 'note.md', text = body) {
  writeFileSync(path.join(vault, name), text);
}
function chunks(name = 'note.md') {
  return db
    .getDb()
    .prepare(
      'SELECT c.text,c.heading_path,c.char_start,c.char_end FROM chunks c JOIN notes n ON n.id=c.note_id WHERE n.path=? ORDER BY c.chunk_index',
    )
    .all(name) as Array<{
    text: string;
    heading_path: string;
    char_start: number;
    char_end: number;
  }>;
}
function assertBudget(name: string, size: number) {
  const rows = chunks(name);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => estimateTokens(row.text) <= size));
}

beforeEach(() => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', undefined);
  vi.stubEnv('OBSIDIAN_CONTENT_IGNORE_PATTERNS', undefined);
  mkdirSync(vault, { recursive: true });
  db.openDb();
  modelContext = 8192;
  inputs = [];
  config.debounce = 1;
  vi.spyOn(embedder, 'activeModelName').mockReturnValue('fixture');
  vi.spyOn(embedder, 'getEmbeddingDim').mockResolvedValue(3);
  vi.spyOn(embedder, 'getContextLength').mockImplementation(() => Promise.resolve(modelContext));
  vi.spyOn(embedder, 'getDocumentTokenPolicy').mockImplementation(() =>
    Promise.resolve({ limit: modelContext - 64, count: estimateTokens }),
  );
  vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts) => {
    inputs.push(...texts);
    return Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0]) })),
    );
  });
  service = createIndexService();
});
afterEach(async () => {
  await service.close();
  db.closeDb();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  config.debounce = originalDebounce;
  rmSync(vault, { recursive: true, force: true });
});
afterAll(() => vi.doUnmock('chokidar'));

it('indexes a new vault at 512 without warnings and skips unchanged notes without provider work', async () => {
  const stderr = vi.spyOn(process.stderr, 'write');
  write();
  assert.equal((await service.reindex()).errors.length, 0);
  assert.deepEqual(db.getStoredChunkPolicy(), { chunkTokens: 512, contextLength: 8192 });
  assert.equal(chunks().length, 8);
  assert.ok(chunks().every((row) => row.heading_path));
  assertBudget('note.md', 512);
  const count = inputs.length;
  assert.equal((await service.reindex()).skipped, 1);
  assert.equal(inputs.length, count);
  assert.doesNotMatch(
    stderr.mock.calls.map((call) => String(call[0])).join(''),
    /warn|chunk.*reindex/i,
  );
});

it('keeps the original budget for ordinary, selective and failed-note retry work', async () => {
  write();
  await service.reindex();
  const original = chunks();
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  write('new.md');
  await service.reindex();
  assert.deepEqual(chunks(), original);
  assertBudget('new.md', 512);
  await service.reindex({ path: 'note.md', force: true });
  await service.reindexFiles(['new.md']);
  assertBudget('note.md', 512);
  assertBudget('new.md', 512);
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
});

it('changes all chunks only with full force, retains them without env, and supports an explicit reset', async () => {
  write();
  write('second.md');
  await service.reindex();
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  await service.reindex({ force: true });
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 1024);
  assert.equal(chunks().length, 4);
  assert.equal(chunks('second.md').length, 4);
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', undefined);
  await service.reindex({ force: true });
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 1024);
  write('third.md');
  await service.reindex();
  assert.equal(chunks('third.md').length, 4);
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '512');
  await service.reindex({ force: true });
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
  assert.equal(chunks('third.md').length, 8);
});

it('continues using a valid stored policy with invalid env, but rejects full force before provider work', async () => {
  write();
  await service.reindex();
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', 'broken');
  write('new.md');
  await service.reindex();
  assertBudget('new.md', 512);
  const count = inputs.length;
  const original = chunks();
  await assert.rejects(service.reindex({ force: true }), /OBSIDIAN_CHUNK_TOKENS.*positive integer/);
  assert.equal(inputs.length, count);
  assert.deepEqual(chunks(), original);
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
});

it('rejects invalid env on a fresh index without writing notes or invoking the provider', async () => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '0');
  write();
  await assert.rejects(service.reindex(), /OBSIDIAN_CHUNK_TOKENS/);
  assert.equal(inputs.length, 0);
  assert.equal(db.getNoteByPath('note.md'), undefined);
  assert.equal(db.getStoredChunkPolicy(), null);
  assert.equal(db.getStats().failedIndexing, 1);
  assert.match(db.getIndexFailures()[0]!.message, /OBSIDIAN_CHUNK_TOKENS/);
});

it('caps a requested budget at model capacity', async () => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '10000');
  write();
  await service.reindex();
  assert.deepEqual(db.getStoredChunkPolicy(), { chunkTokens: 8192, contextLength: 8192 });
  assert.equal(chunks().length, 1);
});

it('keeps the old rows and policy if the new full rebuild fails', async () => {
  write();
  await service.reindex();
  const original = chunks();
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  vi.mocked(embedder.embedDetailed).mockResolvedValue([
    { ok: false, kind: 'permanent', message: 'fixture rejected input' },
  ]);
  await assert.rejects(service.reindex({ force: true }), /embedding.*failed/i);
  assert.deepEqual(chunks(), original);
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
});

it('preserves a legacy index until an explicit whole-vault rebuild records its policy', async () => {
  write();
  await service.reindex();
  db.getDb().prepare("DELETE FROM settings WHERE key IN ('chunk_tokens','context_length')").run();
  const original = chunks();
  const count = inputs.length;
  write('new.md');
  vi.mocked(embedder.getContextLength).mockClear();
  await assert.rejects(service.reindex(), /chunk.*unknown.*reindex.*--force/i);
  assert.equal(vi.mocked(embedder.getContextLength).mock.calls.length, 0);
  assert.equal(db.getStats().failedIndexing, 1);
  assert.equal(inputs.length, count);
  assert.deepEqual(chunks(), original);
  assert.equal(db.getNoteByPath('new.md'), undefined);
  await service.reindex({ force: true });
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
  assertBudget('new.md', 512);
});

it('repairs corrupt policy only with an explicit full rebuild', async () => {
  write();
  await service.reindex();
  db.getDb().prepare("UPDATE settings SET value='bad' WHERE key='chunk_tokens'").run();
  const original = chunks();
  await assert.rejects(service.reindex(), /chunk.*invalid.*reindex.*--force/i);
  assert.deepEqual(chunks(), original);
  await service.reindex({ force: true });
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
});

it('rejects a confirmed lower model cap without relabeling or rewriting the current index', async () => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  write();
  await service.reindex();
  modelContext = 512;
  const original = chunks();
  write('new.md');
  await assert.rejects(service.reindex(), /chunk.*1024.*512.*reindex.*--force/i);
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 1024);
  assert.deepEqual(chunks(), original);
  await service.reindex({ force: true });
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
});

it('retains chunk size during automatic content-policy rebuild despite a pending env change', async () => {
  write();
  await service.reindex();
  await service.close();
  vi.stubEnv('OBSIDIAN_CONTENT_IGNORE_PATTERNS', '/absent-marker/g');
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  service = createIndexService();
  await service.reindex();
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 512);
  assert.equal(chunks().length, 8);
});

it('enforces a small body budget even when semantic windows fall below the minimum length', async () => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '8');
  write('note.md', 'long word '.repeat(1000));
  await service.reindex();
  assertBudget('note.md', 8);
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 8);
});

it('rejects a budget too small for a character without embedding or publishing oversized chunks', async () => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1');
  write('note.md', '这是中文。'.repeat(100));
  await assert.rejects(service.reindex(), /Full-vault reindex failed/);
  assert.match(
    db.getIndexFailures().find((failure) => failure.path === 'note.md')!.message,
    /Chunk size 1.*too small.*OBSIDIAN_CHUNK_TOKENS.*reindex --force/,
  );
  assert.equal(inputs.length, 0);
  assert.equal(chunks().length, 0);
  assert.equal(db.getNoteByPath('note.md'), undefined);
});

it('uses a model cap below the default without warnings', async () => {
  modelContext = 256;
  const stderr = vi.spyOn(process.stderr, 'write');
  write();
  await service.reindex();
  assertBudget('note.md', 256);
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 256);
  assert.doesNotMatch(stderr.mock.calls.map((call) => String(call[0])).join(''), /warn/i);
});

it('retains a discovered context if an empty index has no recorded model yet', async () => {
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  await service.reindex();
  assert.equal(db.getStoredModel(), null);
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', undefined);
  vi.mocked(embedder.getContextLength).mockImplementation((fallback) =>
    Promise.resolve(fallback ?? 512),
  );
  write();
  await service.reindex();
  assert.equal(chunks().length, 4);
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 1024);
});

it('reloads the published budget when a watcher resumes after another owner rebuilds', async () => {
  write();
  await service.reindex();
  service.start();
  await vi.waitFor(() => assert.equal(db.readIndexOwner().mode, 'background'), { timeout: 15000 });
  vi.stubEnv('OBSIDIAN_CHUNK_TOKENS', '1024');
  const other = createIndexService();
  try {
    await other.reindex({ force: true });
  } finally {
    await other.close();
  }
  // The coordinator detects the handoff on its 5s heartbeat, then polls after 5s + jitter.
  await vi.waitFor(() => assert.equal(db.readIndexOwner().mode, 'background'), { timeout: 15000 });
  write('new.md');
  watcher.emit('add', path.join(vault, 'new.md'));
  await vi.waitFor(() => assert.equal(chunks('new.md').length, 4));
  assert.equal(db.getStoredChunkPolicy()?.chunkTokens, 1024);
});
