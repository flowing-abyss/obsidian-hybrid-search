import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-watcher-lifecycle-'));
const previousVault = process.env.OBSIDIAN_VAULT_PATH;

class TestWatcher extends EventEmitter {
  add = vi.fn();
  close = vi.fn(() => {
    this.removeAllListeners();
    return Promise.resolve();
  });
}

let watcher: TestWatcher;
let watch: ReturnType<typeof vi.fn>;
let created: Promise<void>;
let indexer: typeof import('../src/indexing/indexer.js');
let handle: ReturnType<typeof indexer.startWatcher> | undefined;

beforeEach(async () => {
  process.env.OBSIDIAN_VAULT_PATH = vaultDir;
  vi.resetModules();
  watcher = new TestWatcher();
  let markCreated!: () => void;
  created = new Promise<void>((resolve) => {
    markCreated = resolve;
  });
  watch = vi.fn(() => {
    markCreated();
    return watcher;
  });
  vi.doMock('chokidar', () => ({ watch }));
  indexer = await import('../src/indexing/indexer.js');
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.doUnmock('chokidar');
  vi.resetModules();
  if (previousVault === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
  else process.env.OBSIDIAN_VAULT_PATH = previousVault;
});

afterAll(() => rmSync(vaultDir, { recursive: true, force: true }));

describe('watcher lifecycle', () => {
  it('can close before import completes without creating a watcher', async () => {
    handle = indexer.startWatcher(512);
    await handle.close();
    await handle.ready;
    assert.equal(watch.mock.calls.length, 0);
  });

  it('cancels pending file work and closes only once', async () => {
    handle = indexer.startWatcher(512);
    await created;
    watcher.emit('ready');
    await handle.ready;
    vi.useFakeTimers();
    watcher.emit('add', path.join(vaultDir, 'pending.md'));
    assert.equal(vi.getTimerCount(), 1);
    await Promise.all([handle.close(), handle.close()]);
    await vi.runAllTimersAsync();
    assert.equal(watcher.close.mock.calls.length, 1);
    assert.equal(indexer.getIndexingStatus().queued, 0);
    assert.equal(vi.getTimerCount(), 0);
  });

  it('does not perform a deferred unlink after closing', async () => {
    handle = indexer.startWatcher(512);
    await created;
    let release!: () => void;
    const blocked = indexer.withIndexingDbLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    watcher.emit('unlink', path.join(vaultDir, 'gone.md'));
    await handle.close();
    release();
    await blocked;
    await indexer.withIndexingDbLock(() => {});
    assert.equal(warn.mock.calls.length, 0, 'closed watcher must not attempt a database write');
  });

  it('reports startup errors without crashing or restarting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = indexer.startWatcher(512);
    await created;
    assert.doesNotThrow(() => watcher.emit('error', new Error('EMFILE')));
    await handle.ready;
    assert.match(warn.mock.calls.flat().join(' '), /watcher.*EMFILE/);
    vi.useFakeTimers();
    await vi.runAllTimersAsync();
    assert.equal(watch.mock.calls.length, 1, 'no watcher restart loop');
  });

  it('reports import failure and can still close', async () => {
    vi.doMock('chokidar', () => {
      throw new Error('cannot load chokidar');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = indexer.startWatcher(512);
    await handle.ready;
    await handle.close();
    assert.match(warn.mock.calls.flat().join(' '), /watcher.*chokidar load error/);
  });

  it('limits an error burst while reporting a persistent failure again later', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = indexer.startWatcher(512);
    await created;
    vi.useFakeTimers();
    for (let i = 0; i < 100; i++) watcher.emit('error', new Error(`EMFILE path ${i}`));
    assert.equal(warn.mock.calls.length, 1, 'an error burst must not flood stderr');
    await vi.advanceTimersByTimeAsync(30_000);
    watcher.emit('error', new Error('EACCES'));
    assert.equal(warn.mock.calls.length, 2, 'persistent failures must remain visible');
    assert.equal(watch.mock.calls.length, 1, 'logging must not restart the watcher');
  });
});
