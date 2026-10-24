import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';

// LIVE end-to-end: REAL chokidar (NOT mocked) + REAL indexer against a REAL
// temp vault. Only the network embedding boundary is stubbed. This is the
// contract the chokidar v4→v5 upgrade silently broke (issue #31): file
// add/edit/delete must actually reach the SQLite index, and ignored files must
// never enter it.
//
// Intentionally does NOT mock chokidar — so it must run isolated from the
// files that do (vitest runs isolate:false). Run standalone:
//   npx vitest run test/indexer-watcher-live-e2e.test.ts

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-live-e2e-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;
process.env.OBSIDIAN_INCLUDE_PATTERNS = 'keep/**,issue55/n*es/*.md';
const osWatch = vi.spyOn(fs, 'watch');
syncBuiltinESMExports();

const { closeDb, openDb, initVecTable, getDb } = await import('./helpers/owned-storage.js');
const { config } = await import('../src/runtime/config.js');
const embedder = await import('../src/inference/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'embedDetailed').mockImplementation((texts: string[]) =>
  Promise.resolve(
    texts.map(() => ({
      ok: true as const,
      embedding: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    })),
  ),
);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
vi.spyOn(embedder, 'getDocumentTokenPolicy').mockResolvedValue({
  limit: 508,
  count: (text) => Math.ceil(Array.from(text).length / 4),
});
const { indexVaultSync, startWatcher } = await import('./helpers/owned-indexer.js');
let watcher: ReturnType<typeof startWatcher>;

// Shrink the 5s per-file debounce so the live test finishes quickly.
config.debounce = 150;

const abs = (rel: string): string => path.join(vaultDir, rel);
const indexedPaths = (): string[] =>
  (getDb().prepare('SELECT path FROM notes').all() as { path: string }[]).map((r) => r.path);
const indexedContent = (rel: string): string | undefined =>
  (
    getDb().prepare('SELECT content FROM notes WHERE path = ?').get(rel) as
      { content: string } | undefined
  )?.content;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (pred()) return true;
    await wait(75);
  }
  return pred();
};

beforeAll(async () => {
  openDb();
  initVecTable(4);

  writeFileSync(abs('one.md'), '# One');
  writeFileSync(abs('.gitignore'), 'archive/\nkeep/\n');
  mkdirSync(abs('.obsidian'), { recursive: true });
  writeFileSync(path.join(abs('.obsidian'), 'app.md'), '# ignored');
  mkdirSync(abs('archive'), { recursive: true });
  writeFileSync(path.join(abs('archive'), 'old.md'), '# gitignored');
  mkdirSync(abs('keep'), { recursive: true });
  mkdirSync(abs('issue55/notes'), { recursive: true });
  mkdirSync(abs('issue55/nothing'), { recursive: true });
  writeFileSync(abs('issue55/.gitignore'), '*\n');
  writeFileSync(abs('issue55/nothing/.gitignore'), '!x.md\n');
  for (let i = 0; i < 1200; i++) mkdirSync(abs(`wide/d${i}`), { recursive: true });

  const result = await indexVaultSync();
  assert.deepEqual(result.errors, [], 'initial indexing must not reject any notes');
  const vectors = getDb().prepare('SELECT vec_length(embedding) AS dim FROM vec_chunks').all() as {
    dim: number;
  }[];
  assert.ok(vectors.length > 0, 'initial indexing must persist embeddings');
  assert.ok(
    vectors.every((vector) => vector.dim === 4),
    'embeddings must use the test dimension',
  );
  watcher = startWatcher(512, true);
  await watcher.ready;
}, 30_000);

afterAll(async () => {
  await watcher?.close();
  osWatch.mockRestore();
  syncBuiltinESMExports();
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('live watcher e2e (real chokidar + real indexer)', () => {
  it('watches a large tree without a native handle for every directory on macOS and Windows', async () => {
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.ok(
        osWatch.mock.calls.length <= 4,
        `expected bounded OS watchers, got ${osWatch.mock.calls.length}`,
      );
      assert.ok(
        osWatch.mock.calls.some((call) => {
          const options: unknown = call[1];
          return (
            typeof options === 'object' &&
            options !== null &&
            'recursive' in options &&
            options.recursive === true
          );
        }),
        'native recursive observation should be used',
      );
    }
    writeFileSync(abs('wide/d1199/new.md'), '# Native recursive event');
    assert.ok(await waitFor(() => indexedPaths().includes('wide/d1199/new.md')));
  });

  it('initial index contains only non-ignored notes', () => {
    const p = indexedPaths();
    assert.ok(p.includes('one.md'), 'one.md indexed');
    assert.ok(!p.includes('.obsidian/app.md'), '.obsidian excluded');
    assert.ok(!p.includes('archive/old.md'), 'gitignored excluded');
  });

  it('ADD: a new note is indexed within the debounce window', async () => {
    writeFileSync(abs('two.md'), '# Two');
    assert.ok(await waitFor(() => indexedPaths().includes('two.md')), 'two.md should be indexed');
  });

  it('ADD ignored: a new gitignored note is never indexed', async () => {
    writeFileSync(path.join(abs('archive'), 'new-ignored.md'), '# nope');
    await wait(800);
    assert.ok(
      !indexedPaths().includes('archive/new-ignored.md'),
      'gitignored note must not be indexed',
    );
  });

  it('ADD rescued: an include-rescued note under a gitignored dir is indexed', async () => {
    writeFileSync(path.join(abs('keep'), 'rescued.md'), '# rescued');
    assert.ok(
      await waitFor(() => indexedPaths().includes('keep/rescued.md')),
      'include-rescued note should be indexed',
    );
  });

  it('EDIT: an existing note updates in the index', async () => {
    writeFileSync(abs('two.md'), '# Two edited with more body text here');
    const applied = await waitFor(() => {
      const row = getDb().prepare('SELECT content FROM notes WHERE path = ?').get('two.md') as
        { content: string } | undefined;
      return !!row && row.content.includes('edited');
    });
    assert.ok(applied, 'edited content should be reflected in the index');
  });

  it('DELETE: a removed note is dropped from the index', async () => {
    unlinkSync(abs('two.md'));
    assert.ok(await waitFor(() => !indexedPaths().includes('two.md')), 'two.md should be removed');
  });

  it('indexes atomic saves without dropping the note', async () => {
    writeFileSync(abs('atomic.md'), '# Original content');
    assert.ok(await waitFor(() => indexedPaths().includes('atomic.md')));
    writeFileSync(abs('atomic.tmp'), '# Replacement content');
    renameSync(abs('atomic.tmp'), abs('atomic.md'));
    assert.ok(
      await waitFor(() => indexedContent('atomic.md')?.includes('Replacement content') ?? false),
    );
  });

  it('reconciles every note in a moved populated subtree', async () => {
    mkdirSync(abs('moving/deep'), { recursive: true });
    writeFileSync(abs('moving/a.md'), '# First moved note');
    writeFileSync(abs('moving/deep/b.md'), '# Second moved note');
    assert.ok(
      await waitFor(() =>
        ['moving/a.md', 'moving/deep/b.md'].every((p) => indexedPaths().includes(p)),
      ),
    );
    renameSync(abs('moving'), abs('moved'));
    assert.ok(
      await waitFor(() => {
        const paths = indexedPaths();
        return (
          ['moved/a.md', 'moved/deep/b.md'].every((p) => paths.includes(p)) &&
          !paths.some((p) => p.startsWith('moving/'))
        );
      }),
    );
  });

  it.each(['NFC', 'NFD'])(
    'indexes and removes a %s Unicode subtree using NFD index keys',
    async (form) => {
      const directory = 'Caf\u00e9'.normalize(form);
      const note = `${directory}/R\u00e9sum\u00e9.md`.normalize(form);
      mkdirSync(abs(directory));
      writeFileSync(abs(note), '# Unicode path');
      assert.ok(await waitFor(() => indexedPaths().includes(note.normalize('NFD'))));
      rmSync(abs(directory), { recursive: true });
      assert.ok(await waitFor(() => !indexedPaths().includes(note.normalize('NFD'))));
    },
  );

  it('indexes a Unicode filename when Git rules make its directory visible', async () => {
    const note = 'archive/Caf\u00e9/R\u00e9sum\u00e9.md';
    mkdirSync(abs('archive/Caf\u00e9'));
    writeFileSync(abs(note), '# Newly visible Unicode file');
    assert.ok(!indexedPaths().includes(note.normalize('NFD')));
    writeFileSync(abs('.gitignore'), 'keep/\n');
    assert.ok(await waitFor(() => indexedPaths().includes(note.normalize('NFD'))));
    writeFileSync(abs('.gitignore'), 'archive/\nkeep/\n');
    assert.ok(await waitFor(() => !indexedPaths().includes(note.normalize('NFD'))));
  });

  it('refreshes Git rules while preserving the explicitly included note vector', async () => {
    writeFileSync(abs('issue55/nothing/x.md'), '# Should remain excluded');
    writeFileSync(abs('issue55/notes/x.md'), '# Explicit include control');
    assert.ok(await waitFor(() => indexedPaths().includes('issue55/notes/x.md')));
    await wait(800);
    assert.ok(!indexedPaths().includes('issue55/nothing/x.md'));
    const vector = () =>
      getDb()
        .prepare(
          `SELECT c.id, hex(v.embedding) AS embedding
      FROM chunks c JOIN notes n ON n.id = c.note_id
      JOIN vec_chunks v ON v.chunk_id = c.id WHERE n.path = ? ORDER BY c.id`,
        )
        .all('issue55/notes/x.md');
    const before = vector();
    assert.ok(before.length > 0);
    writeFileSync(abs('issue55/.gitignore'), '*\n!nothing/\n');
    assert.ok(await waitFor(() => indexedPaths().includes('issue55/nothing/x.md')));
    assert.deepEqual(vector(), before);
    writeFileSync(abs('issue55/.gitignore'), '*\n');
    assert.ok(await waitFor(() => !indexedPaths().includes('issue55/nothing/x.md')));
    assert.ok(indexedPaths().includes('issue55/notes/x.md'));
    assert.deepEqual(vector(), before);
  }, 30_000);

  it('removes stale notes and vectors when an include-rescued subtree moves or disappears', async () => {
    assert.ok(indexedPaths().includes('issue55/notes/x.md'));
    renameSync(abs('issue55/notes'), abs('issue55/names'));
    assert.ok(
      await waitFor(() => {
        const paths = indexedPaths();
        return paths.includes('issue55/names/x.md') && !paths.includes('issue55/notes/x.md');
      }),
      'move must remove the old included path and index the new one',
    );
    rmSync(abs('issue55/names'), { recursive: true });
    assert.ok(
      await waitFor(() => !indexedPaths().includes('issue55/names/x.md')),
      'deleting the included directory must remove its notes',
    );
    const orphanVectors = getDb()
      .prepare(
        `
      SELECT COUNT(*) AS count FROM vec_chunks v
      LEFT JOIN chunks c ON c.id = v.chunk_id WHERE c.id IS NULL
    `,
      )
      .get() as { count: number };
    assert.equal(orphanVectors.count, 0, 'moved and removed notes must leave no orphan vectors');
  });

  it('stops observing changes after close', async () => {
    await watcher.close();
    writeFileSync(abs('after-close.md'), '# Must not be indexed by the closed watcher');
    await wait(600);
    assert.ok(!indexedPaths().includes('after-close.md'));
  });
});
