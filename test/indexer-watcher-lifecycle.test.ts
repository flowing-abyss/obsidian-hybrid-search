import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it, vi } from 'vitest';
import { createGitFixture } from './helpers/git-fixture.js';

const vaultDir = mkdtempSync(path.join(tmpdir(), 'ohs-watcher-lifecycle-'));
const previousVault = process.env.OBSIDIAN_VAULT_PATH;
const previousRespect = process.env.OBSIDIAN_RESPECT_GITIGNORE;
let fixture: ReturnType<typeof createGitFixture> | undefined;

class TestWatcher extends EventEmitter {
  add = vi.fn();
  unwatch = vi.fn();
  close = vi.fn(() => {
    this.removeAllListeners();
    return Promise.resolve();
  });
}

let watcher: TestWatcher;
let controlWatcher: TestWatcher;
let watch: ReturnType<typeof vi.fn>;
let created: Promise<void>;
let indexer: typeof import('../src/indexing/indexer.js');
let handle: ReturnType<typeof indexer.startWatcher> | undefined;

beforeEach(async () => {
  process.env.OBSIDIAN_VAULT_PATH = vaultDir;
  vi.resetModules();
  watcher = new TestWatcher();
  controlWatcher = new TestWatcher();
  process.env.OBSIDIAN_RESPECT_GITIGNORE = 'true';
  let markCreated!: () => void;
  created = new Promise<void>((resolve) => {
    markCreated = resolve;
  });
  watch = vi.fn((files: string | string[]) => {
    markCreated();
    return Array.isArray(files) ? controlWatcher : watcher;
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
  if (previousRespect === undefined) delete process.env.OBSIDIAN_RESPECT_GITIGNORE;
  else process.env.OBSIDIAN_RESPECT_GITIGNORE = previousRespect;
  fixture?.dispose();
  fixture = undefined;
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

describe('repository metadata watcher lifecycle', () => {
  beforeEach(() => {
    fixture = createGitFixture({ linked: true, vaultPrefix: 'projects/notes' });
    process.env.OBSIDIAN_VAULT_PATH = fixture.vault;
  });

  it('waits for both initial scans and cancels a burst of refresh events on close', async () => {
    handle = indexer.startWatcher(512);
    let settled = false;
    void handle.ready.then(() => {
      settled = true;
    });
    await created;
    assert.equal(watch.mock.calls.length, 2);
    watcher.emit('ready');
    await Promise.resolve();
    assert.equal(settled, false);
    controlWatcher.emit('ready');
    await handle.ready;
    vi.useFakeTimers();
    for (let i = 0; i < 25; i++) controlWatcher.emit('change', fixture!.exclude);
    assert.equal(vi.getTimerCount(), 1, 'a metadata burst shares one debounce');
    await Promise.all([handle.close(), handle.close()]);
    await vi.runAllTimersAsync();
    assert.equal(watcher.close.mock.calls.length, 1);
    assert.equal(controlWatcher.close.mock.calls.length, 1);
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(indexer.getIndexingStatus().queued, 0);
  });

  it('does not enter a queued refresh after close releases a blocked database lock', async () => {
    handle = indexer.startWatcher(512);
    await created;
    assert.equal(watch.mock.calls.length, 2);
    let release!: () => void;
    const blocked = indexer.withIndexingDbLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await Promise.resolve();
    const policy = await import('../src/vault/ignore.js');
    const build = vi.spyOn(policy, 'createIgnorePolicy');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    controlWatcher.emit('change', fixture!.exclude);
    await vi.advanceTimersByTimeAsync(5000);
    assert.equal(build.mock.calls.length, 0, 'refresh waits for database ownership');
    await handle.close();
    release();
    await blocked;
    await indexer.withIndexingDbLock(() => {});
    assert.equal(build.mock.calls.length, 0, 'closed deferred refresh must not read or mutate');
    assert.equal(warn.mock.calls.length, 0);
  });

  it('shares one visible error rate limit across both watchers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = indexer.startWatcher(512);
    await created;
    assert.equal(watch.mock.calls.length, 2);
    assert.doesNotThrow(() => controlWatcher.emit('error', new Error('EACCES exclude')));
    await handle.ready;
    watcher.emit('error', new Error('EMFILE vault'));
    assert.equal(warn.mock.calls.length, 1);
    assert.match(warn.mock.calls.flat().join(' '), /watcher.*EACCES exclude/);
    assert.equal(watch.mock.calls.length, 2, 'errors do not restart either watcher');
  });

  it('awaits both closes even when one fails', async () => {
    handle = indexer.startWatcher(512);
    await created;
    assert.equal(watch.mock.calls.length, 2);
    let release!: () => void;
    let markCloseStarted!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      markCloseStarted = resolve;
    });
    watcher.close.mockRejectedValueOnce(new Error('vault close failed'));
    controlWatcher.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          markCloseStarted();
        }),
    );
    const closing = handle.close();
    let settled = false;
    const observed = closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await closeStarted;
    assert.equal(settled, false, 'failed vault close cannot leave metadata observation running');
    release();
    await assert.rejects(closing, /close/);
    await observed;
    handle = undefined;
  });

  it('owns an already-created watcher if supplemental startup fails', async () => {
    watch
      .mockImplementationOnce(() => watcher)
      .mockImplementationOnce(() => {
        throw new Error('control startup failed');
      });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle = indexer.startWatcher(512);
    await handle.ready;
    await handle.close();
    assert.equal(watcher.close.mock.calls.length, 1);
    assert.match(warn.mock.calls.flat().join(' '), /control startup failed/);
  });

  it('watches exact control files and allows only their directory ancestors', async () => {
    handle = indexer.startWatcher(512);
    await created;
    assert.equal(watch.mock.calls.length, 2);
    const [targets, options] = watch.mock.calls[1] as [
      string[],
      {
        ignored: (file: string) => boolean;
        backend: string;
        pollingInterval: number;
        ignoreInitial: boolean;
      },
    ];
    assert.ok(targets.includes(fixture!.exclude));
    assert.ok(targets.includes(path.join(fixture!.repo, '.gitignore')));
    assert.ok(!targets.includes(fixture!.commonDir));
    assert.ok(!targets.includes(fixture!.repo));
    assert.equal(options.backend, 'polling');
    assert.equal(options.pollingInterval, 1000);
    assert.equal((watch.mock.calls[0] as [string, { backend: string }])[1].backend, 'auto');
    assert.equal(options.ignoreInitial, true);
    assert.equal(options.ignored(fixture!.exclude), false);
    assert.equal(options.ignored(path.dirname(fixture!.exclude)), false);
    assert.equal(options.ignored(path.join(fixture!.commonDir, 'objects')), true);
    assert.equal(options.ignored(path.join(fixture!.commonDir, 'refs', 'heads', 'other')), true);
    assert.equal(options.ignored(path.join(fixture!.repo, 'unrelated')), true);
    vi.useFakeTimers();
    controlWatcher.emit('change', path.join(fixture!.commonDir, 'HEAD'));
    assert.equal(vi.getTimerCount(), 0);
  });

  it('does not create a metadata watcher or refresh either Git source when disabled', async () => {
    process.env.OBSIDIAN_RESPECT_GITIGNORE = 'false';
    handle = indexer.startWatcher(512);
    await created;
    assert.equal(watch.mock.calls.length, 1);
    vi.useFakeTimers();
    watcher.emit('change', path.join(fixture!.vault, '.gitignore'));
    watcher.emit('unlink', path.join(fixture!.vault, '.gitignore'));
    assert.equal(vi.getTimerCount(), 0);
    await handle.close();
  });
});
