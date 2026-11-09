import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';

const workspace = mkdtempSync(path.join(tmpdir(), 'ohs-index-source-boundary-'));
const vault = path.join(workspace, 'vault');
const outside = path.join(workspace, 'outside');
process.env.OBSIDIAN_VAULT_PATH = vault;
let ignored: ((file: string, stats?: Stats) => boolean) | undefined;
vi.doMock('chokidar', () => ({
  watch: (_root: string, options: { ignored: (file: string, stats?: Stats) => boolean }) => {
    ignored = options.ignored;
    return {
      on() {
        return this;
      },
      add() {},
      close() {
        return Promise.resolve();
      },
    };
  },
}));

const db = await import('./helpers/owned-storage.js');
const embedder = await import('../src/inference/embedder.js');
const indexer = await import('../src/indexing/indexer.js');
const { createIndexService } = await import('../src/indexing/index-service.js');
const { startWatcher } = await import('./helpers/owned-indexer.js');
let service: ReturnType<typeof createIndexService>;

beforeEach(() => {
  mkdirSync(vault, { recursive: true });
  mkdirSync(outside, { recursive: true });
  db.wipeDatabaseFiles();
  db.openDb();
  db.initVecTable(4);
  indexer.resetIndexingState();
  ignored = undefined;
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
  rmSync(workspace, { recursive: true, force: true });
});
afterAll(() => vi.doUnmock('chokidar'));

describe('indexing source confinement', () => {
  it.each(['file', 'directory'])(
    'rejects a %s symlink before embedding external text',
    async (kind) => {
      writeFileSync(path.join(outside, 'secret.md'), '# Outside secret\nPrivate external text.');
      const requested = kind === 'file' ? 'note.md' : 'linked/secret.md';
      if (kind === 'file')
        symlinkSync(path.join(outside, 'secret.md'), path.join(vault, 'note.md'), 'file');
      else symlinkSync(outside, path.join(vault, 'linked'), 'dir');

      const result = await service.reindex({ path: requested });

      assert.equal(result.indexed, 0);
      assert.match(result.errors[0]?.error ?? '', /symbolic links/);
      assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
      assert.equal(db.getNoteByPath(requested), undefined);
    },
  );

  it('preserves the previous note when a source becomes a symlink during embedding', async () => {
    const file = path.join(vault, 'note.md');
    const secret = path.join(outside, 'secret.md');
    writeFileSync(file, '# Original\nOriginal indexed body.');
    writeFileSync(secret, '# Outside\nPrivate external text.');
    await service.reindex({ path: 'note.md' });
    writeFileSync(file, '# Updated\nA safe source awaiting embedding.');
    vi.mocked(embedder.embedDetailed).mockImplementationOnce((texts) => {
      unlinkSync(file);
      symlinkSync(secret, file, 'file');
      return Promise.resolve(
        texts.map(() => ({ ok: true as const, embedding: new Float32Array([1, 0, 0, 0]) })),
      );
    });

    const result = await service.reindex({ path: 'note.md', force: true });

    assert.equal(result.indexed, 0);
    assert.match(result.errors[0]?.error ?? '', /symbolic links/);
    assert.equal(db.getNoteByPath('note.md')?.content, '# Original\nOriginal indexed body.');
    for (const [texts] of vi.mocked(embedder.embedDetailed).mock.calls)
      assert.ok(texts.every((text) => !text.includes('Private external')));
  });

  it('keeps the active index when a full rebuild source is replaced after its directory scan', async () => {
    const file = path.join(vault, 'note.md');
    const secret = path.join(outside, 'secret.md');
    writeFileSync(file, '# Original\nOriginal indexed body.');
    writeFileSync(secret, '# Outside\nPrivate external text.');
    await service.reindex({ path: 'note.md' });
    const originalScan = indexer.scanVault;
    vi.spyOn(indexer, 'scanVault').mockImplementationOnce((...args) => {
      const files = originalScan(...args);
      unlinkSync(file);
      symlinkSync(secret, file, 'file');
      return files;
    });
    vi.mocked(embedder.embedDetailed).mockClear();

    await assert.rejects(() => service.reindex({ force: true }), /symbolic links/);

    assert.equal(db.getNoteByPath('note.md')?.content, '# Original\nOriginal indexed body.');
    assert.equal(vi.mocked(embedder.embedDetailed).mock.calls.length, 0);
    assert.equal(db.getDb().prepare('SELECT COUNT(*) FROM index_rebuild').pluck().get(), 0);
  });

  it('prunes child directory and gitignore symlinks while permitting a symlink vault root', async () => {
    const child = path.join(vault, 'linked');
    symlinkSync(outside, child, 'dir');
    writeFileSync(path.join(outside, 'policy'), '*.md\n');
    symlinkSync(path.join(outside, 'policy'), path.join(vault, '.gitignore'), 'file');
    const rootLink = path.join(workspace, 'root-link');
    symlinkSync(vault, rootLink, 'dir');
    const handle = startWatcher(512);
    try {
      await vi.waitFor(() => assert.ok(ignored));
      assert.equal(ignored!(child, statSync(outside)), true);
      assert.equal(ignored!(path.join(vault, '.gitignore')), true);
      process.env.OBSIDIAN_VAULT_PATH = rootLink;
      assert.equal(ignored!(rootLink), false);
      assert.equal(ignored!(path.join(rootLink, 'linked'), statSync(outside)), true);
    } finally {
      process.env.OBSIDIAN_VAULT_PATH = vault;
      await handle.close();
    }
  });
});
