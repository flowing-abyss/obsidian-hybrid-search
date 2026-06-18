import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, it, vi } from 'vitest';

// Mock chokidar before importing indexer
vi.mock('chokidar', () => ({
  watch: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
  }),
}));

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-watcher-test-'));
process.env.OBSIDIAN_VAULT_PATH = vaultDir;

describe('watcher error resilience', () => {
  afterAll(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('watcher unlink swallows deleteNote errors without crashing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Scoped mock: temporarily replace deleteNote so we can observe the
    // unlink handler's try/catch without leaking the mock to other test
    // files (vitest runs with isolate: false).
    vi.doMock('../src/db.js', async (importOriginal) => {
      const mod = await importOriginal<typeof import('../src/db.js')>();
      return {
        ...mod,
        deleteNote: vi.fn(() => {
          throw new Error('FK constraint');
        }),
      };
    });
    vi.resetModules();

    const { startWatcher } = await import('../src/indexer');

    startWatcher(512);
    await new Promise((r) => setTimeout(r, 50));

    const chokidar = await import('chokidar');
    const watchMock = chokidar.watch as ReturnType<typeof vi.fn>;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const watcherInstance = watchMock.mock.results.at(-1)?.value;
    assert.ok(watcherInstance, 'watcher instance should exist');

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    const eventHandlers = watcherInstance.on.mock.calls as unknown[][];
    const unlinkCall = eventHandlers.find((c: unknown[]) => c[0] === 'unlink');
    assert.ok(unlinkCall, 'unlink handler should be registered');

    const unlinkHandler = unlinkCall[1] as (p: string) => void;

    assert.doesNotThrow(() => {
      unlinkHandler(path.join(vaultDir, 'nonexistent.md'));
    });

    const { deleteNote } = await import('../src/db.js');
    const deleteNoteMock = vi.mocked(deleteNote);
    assert.equal(deleteNoteMock.mock.calls.length, 1, 'deleteNote should have been called');
    assert.ok(
      warnSpy.mock.calls.some((c) => String(c[0]).includes('[watcher] unlink error')),
      'error should be logged to console.warn',
    );

    warnSpy.mockRestore();
    vi.doUnmock('../src/db.js');
    vi.resetModules();
  });
});
