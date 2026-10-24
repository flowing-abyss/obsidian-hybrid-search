import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, it, vi, type MockInstance } from 'vitest';

const vault = mkdtempSync(path.join(tmpdir(), 'ohs-content-policy-'));
vi.stubEnv('OBSIDIAN_VAULT_PATH', vault);
vi.stubEnv('OBSIDIAN_IGNORE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_INCLUDE_PATTERNS', '');
vi.stubEnv('OBSIDIAN_RESPECT_GITIGNORE', 'false');
vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:1/v1');
vi.stubEnv('OPENAI_API_KEY', 'fixture-authorization');
class Watcher extends EventEmitter {
  add() {}
  close() {
    this.removeAllListeners();
    return Promise.resolve();
  }
}
const watchers: Watcher[] = [];
vi.doMock('chokidar', () => ({
  watch: () => {
    const watcher = new Watcher();
    watchers.push(watcher);
    setTimeout(() => watcher.emit('ready'), 0);
    return watcher;
  },
}));
const db = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const filters = await import('../src/indexing/content-filter.js');
const { getReusableEmbeddings } = await import('../src/storage/index-queries.js');
const { config } = await import('../src/runtime/config.js');
const { createIndexService } = await import('../src/indexing/index-service.js');
const { readNotes } = await import('../src/search/searcher.js');
const services: ReturnType<typeof createIndexService>[] = [];
let embeddings: MockInstance<typeof embedder.embedDetailed>;
const rule = '/%%[\\s\\S]*?%%/g';
const source = 'Public planetary rings.\n%%hiddenneedle%%\nVisible ending.';
function service(patterns = '') {
  vi.stubEnv('OBSIDIAN_CONTENT_IGNORE_PATTERNS', patterns);
  const current = createIndexService();
  services.push(current);
  return current;
}
function write(name: string, content = source) {
  writeFileSync(path.join(vault, name), content);
}
function body(name = 'note.md') {
  return db.getNoteByPath(name)?.content;
}
function signature(): string | undefined {
  return db
    .getDb()
    .prepare("SELECT value FROM settings WHERE key='content_policy'")
    .pluck()
    .get() as string | undefined;
}
function snapshot() {
  return JSON.stringify(
    ['notes', 'chunks', 'vec_chunks', 'links', 'markdown_links', 'note_urls', 'settings'].map(
      (table) => [table, db.getDb().prepare(`SELECT * FROM ${table} ORDER BY 1`).all()],
    ),
  );
}
beforeEach(() => {
  watchers.length = 0;
  config.debounce = 1;
  mkdirSync(vault, { recursive: true });
  db.openDb();
  db.initVecTable(4);
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
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((current) => current.close()));
  db.closeDb();
  vi.restoreAllMocks();
  rmSync(vault, { recursive: true, force: true });
});
afterAll(() => {
  vi.doUnmock('chokidar');
  vi.unstubAllEnvs();
});

it('automatically enables, changes and disables rules without touching source hash or mtime', async () => {
  write('note.md');
  await service().reindex();
  const original = db.getNoteByPath('note.md')!;
  const mtime = statSync(path.join(vault, 'note.md')).mtimeMs;
  const filtered = service(rule);
  filtered.start();
  await vi.waitFor(() => assert.ok(!body()?.includes('hiddenneedle')), { timeout: 3000 });
  const firstPolicy = signature();
  assert.ok(firstPolicy && firstPolicy !== 'none');
  const read = readNotes(['note.md'])[0];
  assert.ok(read?.found);
  assert.equal(read.content, source);
  assert.equal(db.getNoteByPath('note.md')?.hash, original.hash);
  assert.equal(statSync(path.join(vault, 'note.md')).mtimeMs, mtime);
  await filtered.close();
  await service(`${rule},/Visible/g`).reindex();
  assert.ok(!body()?.includes('Visible'));
  assert.notEqual(signature(), firstPolicy);
  await service().reindex();
  assert.equal(body(), source);
  assert.equal(signature(), 'none');
});

it('reuses proven no-match vectors, ignores authorization changes, and still embeds on force', async () => {
  write('note.md', 'Visible planetary rings.');
  await service().reindex();
  const before = embeddings.mock.calls.length;
  vi.stubEnv('OPENAI_API_KEY', 'changed-authorization-only');
  const filtered = service(rule);
  await filtered.reindex();
  assert.equal(embeddings.mock.calls.length, before);
  const version = db.getDbVersion();
  await service(` ${rule},${rule} `).reindex();
  assert.equal(db.getDbVersion(), version);
  assert.equal(embeddings.mock.calls.length, before);
  await filtered.reindex({ force: true });
  assert.ok(embeddings.mock.calls.length > before);
});

it.each(['legacy', 'preparation', 'missing-vector', 'source'] as const)(
  'does not reuse vectors without a matching %s proof',
  async (reason) => {
    write('note.md', 'Visible planetary rings.');
    await service().reindex();
    const before = embeddings.mock.calls.length;
    if (reason === 'legacy') db.getDb().exec('UPDATE notes SET embedding_context=NULL');
    if (reason === 'preparation')
      vi.spyOn(embedder, 'prepareEmbeddingInput').mockImplementation(
        (text) => `new-prefix:${text}`,
      );
    if (reason === 'missing-vector') {
      db.getDb().exec('DELETE FROM vec_chunks');
    }
    if (reason === 'source') write('note.md', 'Visible planetary rings.%% removed addition %%');
    await service(rule).reindex();
    assert.ok(embeddings.mock.calls.length > before);
    assert.equal(body(), 'Visible planetary rings.');
  },
);

it('rejects dimension and heading mismatches in the storage reuse proof', async () => {
  write('note.md', 'Visible planetary rings.');
  await service().reindex();
  const note = db.getNoteByPath('note.md')!;
  const embeddingContext = db
    .getDb()
    .prepare('SELECT embedding_context FROM notes')
    .pluck()
    .get() as string;
  const chunks = db
    .getDb()
    .prepare('SELECT text,heading_path AS headingPath FROM chunks ORDER BY chunk_index')
    .all() as Array<{ text: string; headingPath: string | null }>;
  const request = {
    path: note.path,
    hash: note.hash,
    title: note.title,
    content: note.content,
    modelName: 'model-A',
    dimension: 4,
    embeddingContext,
    chunks,
  };
  assert.equal(getReusableEmbeddings(request)?.length, chunks.length);
  assert.equal(getReusableEmbeddings({ ...request, dimension: 3 }), null);
  assert.equal(
    getReusableEmbeddings({
      ...request,
      chunks: chunks.map((chunk) => ({ ...chunk, headingPath: 'Other heading' })),
    }),
    null,
  );
});

it('refuses a policy transition with a changed model and keeps the complete active snapshot', async () => {
  write('note.md');
  await service().reindex();
  const before = snapshot();
  const calls = embeddings.mock.calls.length;
  vi.mocked(embedder.activeModelName).mockReturnValue('model-B');
  await assert.rejects(service(rule).reindex(), /model mismatch/i);
  assert.equal(snapshot(), before);
  assert.equal(embeddings.mock.calls.length, calls);
});

it('keeps the old snapshot when a late document fails and allows an explicit retry', async () => {
  write('a.md');
  write('b.md', source.replace('rings', 'satellites'));
  await service().reindex();
  const before = snapshot();
  const filtered = service(rule);
  embeddings.mockImplementation((texts) =>
    Promise.resolve(
      texts.map((text) =>
        text.includes('satellites')
          ? { ok: false as const, kind: 'permanent' as const, message: 'fixture rejection' }
          : { ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) },
      ),
    ),
  );
  await assert.rejects(filtered.reindex(), /embedding.*failed/i);
  assert.equal(snapshot(), before);
  assert.equal(db.getStats().failedIndexing, 1);
  assert.ok(db.getIndexFailures()[0]?.operation.includes('policy'));
  const calls = embeddings.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(embeddings.mock.calls.length, calls);
  embeddings.mockImplementation((texts) =>
    Promise.resolve(
      texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
    ),
  );
  await filtered.reindex();
  assert.ok(!body('a.md')?.includes('hiddenneedle'));
  assert.ok(!body('b.md')?.includes('hiddenneedle'));
  assert.equal(db.getStats().failedIndexing, 0);
});

it('rolls back the policy, vectors and graph together on publication failure', async () => {
  write('note.md');
  await service().reindex();
  const before = snapshot();
  db.getDb().exec(
    "CREATE TRIGGER reject_publish BEFORE INSERT ON notes BEGIN SELECT RAISE(ABORT,'policy publication failed');END",
  );
  await assert.rejects(service(rule).reindex(), /policy publication failed/);
  assert.equal(snapshot(), before);
  assert.equal(db.getStats().failedIndexing, 1);
});

it('reports invalid rules only at the indexing boundary and keeps source read available', async () => {
  write('note.md');
  await service().reindex();
  const before = snapshot();
  const calls = embeddings.mock.calls.length;
  const invalid = service('/unterminated');
  const read = readNotes(['note.md'])[0];
  assert.ok(read?.found);
  assert.equal(read.content, source);
  await assert.rejects(invalid.reindex(), /OBSIDIAN_CONTENT_IGNORE_PATTERNS.*rule 1/);
  assert.equal(snapshot(), before);
  assert.equal(embeddings.mock.calls.length, calls);
  assert.equal(db.getStats().failedIndexing, 1);
});

it('bounds a pathological policy without falling back to raw content or retaining staged rows', async () => {
  write('note.md', `${'a'.repeat(32000)}!`);
  // Seed without chunking this artificial pathological line.
  db.upsertNote({
    path: 'note.md',
    title: 'note',
    tags: [],
    content: 'old searchable snapshot',
    hash: 'old',
    mtime: 0,
    chunks: [],
  });
  const before = snapshot();
  const start = Date.now();
  await assert.rejects(service('/(a+)+$/').reindex(), /Content filter.*timed out/i);
  assert.ok(Date.now() - start < 9000);
  assert.equal(snapshot(), before);
  assert.equal(embeddings.mock.calls.length, 0);
  assert.equal(db.getStats().failedIndexing, 1);
  assert.equal(db.getDb().prepare('SELECT count(*) FROM index_rebuild').pluck().get(), 0);
});

it('retries untouched queued siblings after a bad regex job without suppressing them as failed sources', async () => {
  write('a-bad.md', 'Original public body.');
  write('b-good.md', 'Original sibling body.');
  const current = service('/(a+)+$/');
  await current.reindex();
  const create = filters.createContentFilter;
  vi.spyOn(filters, 'createContentFilter').mockImplementation((patterns) => {
    const filter = create(patterns, { jobTimeoutMs: 150 });
    return {
      signature: filter.signature,
      async project(body, options) {
        if (body.includes('Queued valid')) await new Promise((resolve) => setTimeout(resolve, 40));
        return filter.project(body, options);
      },
      close: () => filter.close(),
    };
  });
  write('a-bad.md', `${'a'.repeat(32000)}!`);
  write('b-good.md', 'Queued valid sibling remains searchable.');
  await assert.rejects(current.reindex(), /Full-vault reindex failed/);
  assert.equal(body('a-bad.md'), 'Original public body.');
  assert.equal(body('b-good.md'), 'Queued valid sibling remains searchable.');
  assert.deepEqual(
    db.getIndexFailures().map((failure) => failure.path),
    ['a-bad.md'],
  );
  write('a-bad.md', 'Edited healthy public body.');
  await current.reindex();
  assert.equal(body('a-bad.md'), 'Edited healthy public body.');
  assert.equal(db.getStats().failedIndexing, 0);
});

it('does not create a replacement across foreground runs while a real worker cannot be reaped', async () => {
  write('note.md', 'Visible source body.');
  const current = service('/secret/g');
  const created = vi.spyOn(filters, 'createContentFilter');
  const kill = vi.spyOn(ChildProcess.prototype, 'kill').mockReturnValue(false);
  try {
    await assert.rejects(current.reindex(), /Could not terminate/);
    const count = created.mock.calls.length;
    await assert.rejects(current.reindex(), /Could not terminate/);
    assert.equal(created.mock.calls.length, count);
    kill.mockRestore();
    write('note.md', 'Changed visible source body.');
    await current.reindex();
    assert.equal(body(), 'Changed visible source body.');
    assert.equal(created.mock.calls.length, count + 1);
  } finally {
    kill.mockRestore();
  }
});

it('continues a sequential explicit file list after one worker job fails', async () => {
  write('bad.md', 'Original body.');
  write('good.md', 'Original sibling.');
  const current = service('/(a+)+$/');
  await current.reindex();
  const create = filters.createContentFilter;
  vi.spyOn(filters, 'createContentFilter').mockImplementation((patterns) =>
    create(patterns, { jobTimeoutMs: 150 }),
  );
  write('bad.md', `${'a'.repeat(32000)}!`);
  write('good.md', 'Healthy sibling updated.');
  const result = await current.reindexFiles(['bad.md', 'good.md']);
  assert.equal(result.indexed, 1);
  assert.deepEqual(
    result.errors.map(({ path }) => path),
    ['bad.md'],
  );
  assert.equal(body('good.md'), 'Healthy sibling updated.');
  assert.deepEqual(
    db.getIndexFailures().map(({ path }) => path),
    ['bad.md'],
  );
});

it('releases a watcher owner after failed OS spawn and allows a healthy follower without restart loops', async () => {
  write('note.md', 'Original body.');
  const current = service('/secret/g');
  await current.reindex();
  current.start();
  await vi.waitFor(() => assert.equal(watchers.length, 1));
  const originalWatcher = watchers[0]!;
  const create = filters.createContentFilter;
  const factory = vi
    .spyOn(filters, 'createContentFilter')
    .mockImplementation((patterns) =>
      create(patterns, { execPath: path.join(vault, 'missing-node-executable') }),
    );
  write('new.md', 'New public body.');
  originalWatcher.emit('change', path.join(vault, 'new.md'));
  await vi.waitFor(
    () => {
      assert.equal(db.getStats().failedIndexing, 1);
      assert.equal(db.readIndexOwner().token, null);
    },
    { timeout: 3000 },
  );
  const calls = factory.mock.calls.length;
  for (let index = 0; index < 10; index++)
    originalWatcher.emit('change', path.join(vault, 'new.md'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(factory.mock.calls.length, calls);
  assert.equal(db.getIndexFailures()[0]?.attempts, 1);
  factory.mockRestore();
  const healthy = service('/secret/g');
  healthy.start();
  await vi.waitFor(() => assert.equal(body('new.md'), 'New public body.'), { timeout: 3000 });
  assert.equal(db.getStats().failedIndexing, 0);
});

it('releases an owner after its idle worker dies and lets a healthy follower finish untouched work', async () => {
  write('note.md', 'Original body.');
  const current = service('/secret/g');
  await current.reindex();
  current.start();
  await vi.waitFor(() => assert.equal(watchers.length, 1));
  const originalWatcher = watchers[0]!;
  const pidFile = path.join(vault, 'worker-pids');
  const variables = {
    OHS_CONTENT_FILTER_PID_FILE: pidFile,
    OHS_CONTENT_FILTER_MESSAGE_FILE: path.join(vault, 'worker-messages'),
    OHS_CONTENT_FILTER_MODE: 'healthy',
  };
  const previous = Object.keys(variables).map((key) => [key, process.env[key]] as const);
  for (const [key, value] of Object.entries(variables)) vi.stubEnv(key, value);
  const create = filters.createContentFilter;
  const factory = vi.spyOn(filters, 'createContentFilter').mockImplementation((patterns) =>
    create(patterns, {
      workerUrl: new URL('./fixtures/content-filter-worker.ts', import.meta.url),
    }),
  );
  try {
    write('first.md', 'First healthy public source.');
    originalWatcher.emit('change', path.join(vault, 'first.md'));
    await vi.waitFor(() => assert.equal(body('first.md'), 'First healthy public source.'), {
      timeout: 3000,
    });
    const pid = (JSON.parse(readFileSync(pidFile, 'utf8').trim()) as { pid: number }).pid;
    process.kill(pid, 'SIGKILL');
    await vi.waitFor(() => assert.throws(() => process.kill(pid, 0)), { timeout: 3000 });
    write('second.md', 'Second healthy public source.');
    originalWatcher.emit('change', path.join(vault, 'second.md'));
    await vi.waitFor(
      () => {
        assert.equal(db.getStats().failedIndexing, 1);
        assert.equal(db.readIndexOwner().token, null);
      },
      { timeout: 3000 },
    );
    const failed = db.getIndexFailures();
    assert.equal(failed[0]?.operation, 'content-filter');
    const calls = factory.mock.calls.length;
    for (let index = 0; index < 10; index++)
      originalWatcher.emit('change', path.join(vault, 'second.md'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(factory.mock.calls.length, calls);
    assert.deepEqual(db.getIndexFailures(), failed);
    factory.mockRestore();
    const healthy = service('/secret/g');
    healthy.start();
    await vi.waitFor(() => assert.equal(body('second.md'), 'Second healthy public source.'), {
      timeout: 3000,
    });
    assert.equal(db.getStats().failedIndexing, 0);
  } finally {
    factory.mockRestore();
    for (const [key, value] of previous) vi.stubEnv(key, value);
  }
});

it.each(['vault', 'path', 'force', 'files'] as const)(
  'resumes background indexing after %s recovery of a failed automatic policy change',
  async (mode) => {
    write('note.md');
    await service().reindex();
    const filtered = service(rule);
    embeddings.mockImplementation((texts) =>
      Promise.resolve(
        texts.map(() => ({
          ok: false as const,
          kind: 'permanent' as const,
          message: 'temporary provider outage',
        })),
      ),
    );
    filtered.start();
    await vi.waitFor(() => assert.equal(db.getStats().failedIndexing, 1), { timeout: 3000 });
    const calls = embeddings.mock.calls.length;
    filtered.start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(embeddings.mock.calls.length, calls);
    assert.equal(watchers.length, 0);
    assert.equal(body(), source);
    embeddings.mockImplementation((texts) =>
      Promise.resolve(
        texts.map(() => ({
          ok: true as const,
          embedding: new Float32Array([1, 0, 0, 0]),
        })),
      ),
    );
    if (mode === 'files') await filtered.reindexFiles(['note.md']);
    else
      await filtered.reindex(
        mode === 'path' ? { path: 'note.md' } : mode === 'force' ? { force: true } : {},
      );
    assert.ok(!body()?.includes('hiddenneedle'));
    await vi.waitFor(() => assert.equal(watchers.length, 1), { timeout: 3000 });
    assert.equal(db.getStats().failedIndexing, 0);
    write('later.md', 'Later public source %%hiddenneedle%% remains searchable.');
    watchers[0]!.emit('change', path.join(vault, 'later.md'));
    await vi.waitFor(
      () => assert.equal(body('later.md'), 'Later public source   remains searchable.'),
      { timeout: 3000 },
    );
  },
);
