import { afterEach } from 'vitest';
import type { IndexRunContext } from '../../src/indexing/index-owner.js';
import * as indexer from '../../src/indexing/indexer.js';
import { closeDb, getDb, openDb } from '../../src/storage/db.js';
import { withTestIndexLease, withTestIndexRun } from './owned-storage.js';
export * from '../../src/indexing/indexer.js';
function owned<Args extends unknown[], Result>(
  operation: (run: IndexRunContext, ...args: Args) => Promise<Result>,
) {
  return (...args: Args) => withTestIndexRun((run) => operation(run, ...args));
}
export const indexFile = owned(indexer.indexFile);
export const indexFileWithRecovery = owned(indexer.indexFileWithRecovery);
export const indexVaultSync = owned(indexer.indexVaultSync);
export const startBackgroundIndexing = owned(indexer.startBackgroundIndexing);
export const populateMissingLinks = owned(indexer.populateMissingLinks);
export const populateMissingMarkdownReferences = owned(indexer.populateMissingMarkdownReferences);
export function cleanupStaleNotes(
  paths?: Set<string>,
  policy?: Parameters<typeof indexer.cleanupStaleNotes>[2],
): void {
  withTestIndexLease((lease) =>
    indexer.cleanupStaleNotes({ lease, signal: new AbortController().signal }, paths, policy),
  );
}
let fixtureOpened = false;
const watchers = new Set<indexer.WatcherHandle>();
export function startWatcher(contextLength: number, suiteLifetime = false): indexer.WatcherHandle {
  try {
    getDb();
  } catch {
    openDb();
    fixtureOpened = true;
  }
  let handle!: indexer.WatcherHandle;
  let release!: () => void;
  const lifetime = withTestIndexRun(async (run) => {
    handle = indexer.startWatcher(contextLength, run);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const result = {
    ready: handle.ready,
    async close() {
      try {
        await handle.close();
      } finally {
        watchers.delete(result);
        release();
        await lifetime;
      }
    },
  };
  if (!suiteLifetime) watchers.add(result);
  return result;
}
afterEach(async () => {
  for (const watcher of watchers) await watcher.close();
  if (fixtureOpened) {
    closeDb();
    fixtureOpened = false;
  }
});
