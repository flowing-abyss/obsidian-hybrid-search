import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
process.env.OBSIDIAN_INCLUDE_PATTERNS = 'keep/**';

const { closeDb, openDb, initVecTable, getDb } = await import('../src/db.js');
const { config } = await import('../src/config.js');
const embedder = await import('../src/embedder.js');
vi.spyOn(embedder, 'embed').mockResolvedValue([new Float32Array([0.1, 0.2, 0.3, 0.4])]);
vi.spyOn(embedder, 'getContextLength').mockResolvedValue(512);
const { indexVaultSync, startWatcher } = await import('../src/indexer.js');

// Shrink the 5s per-file debounce so the live test finishes quickly.
config.debounce = 150;

const abs = (rel: string): string => path.join(vaultDir, rel);
const indexedPaths = (): string[] =>
  (getDb().prepare('SELECT path FROM notes').all() as { path: string }[]).map((r) => r.path);
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

  await indexVaultSync();
  startWatcher(512);
  await wait(600); // let the real watcher settle
}, 30_000);

afterAll(() => {
  closeDb();
  rmSync(vaultDir, { recursive: true, force: true });
});

describe('live watcher e2e (real chokidar + real indexer)', () => {
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
});
