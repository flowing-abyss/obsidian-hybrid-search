import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, it, vi } from 'vitest';

// Mock chokidar so we can capture the `ignored` predicate passed to watch()
// without spawning a real filesystem watcher.
vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    add: vi.fn().mockReturnThis(),
  }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-watcher-root-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

describe('watcher ignored() contract', () => {
  afterAll(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('never ignores the vault watch root (chokidar v5 consults ignored for the root)', async () => {
    writeFileSync(path.join(vaultDir, 'one.md'), '# One');

    vi.resetModules();
    const { startWatcher } = await import('../src/indexer');
    startWatcher(512);
    await new Promise((r) => setTimeout(r, 50));

    const chokidar = await import('chokidar');
    const watchMock = chokidar.watch as ReturnType<typeof vi.fn>;
    const lastCall = watchMock.mock.calls.at(-1);
    assert.ok(lastCall, 'watch() should have been called');

    const options = lastCall[1] as { ignored: (p: string) => boolean };
    const ignored = options.ignored;
    assert.equal(typeof ignored, 'function', 'ignored should be a predicate function');

    // The exact regression: chokidar v5 asks ignored() about the watch root
    // itself. toVaultRelativePath(root) === '' → isIgnored('/') throws → the
    // catch fell through to `return true`, marking the whole tree ignored.
    assert.equal(
      ignored(vaultDir),
      false,
      'vault root must never be reported as ignored, or the entire tree is skipped',
    );

    // A real markdown file inside the vault must remain watched.
    assert.equal(
      ignored(path.join(vaultDir, 'one.md')),
      false,
      'a plain .md note in the vault must not be ignored',
    );

    // Operational directories must still be ignored so the fix is not a blanket
    // "watch everything".
    mkdirSync(path.join(vaultDir, '.obsidian'), { recursive: true });
    assert.equal(
      ignored(path.join(vaultDir, '.obsidian')),
      true,
      '.obsidian must still be ignored',
    );
  });
});
