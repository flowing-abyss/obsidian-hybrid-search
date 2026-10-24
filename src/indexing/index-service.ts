import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  activeModelName,
  getContextLength,
  getEmbeddingDim,
  primeEmbeddingDim,
} from '../inference/embedder.js';
import { config } from '../runtime/config.js';
import {
  cleanupLegacyPaths,
  clearIndexFailures,
  getStoredEmbeddingDim,
  getStoredModel,
  IndexInitializationBusyError,
  initVecTable,
  openDb,
  recordIndexFailure,
  repairIndexIntegrity,
  saveConfigMeta,
} from '../storage/db.js';
import { IndexLeaseLostError } from '../storage/index-ownership.js';
import { discardRebuilds } from '../storage/index-rebuild.js';
import { createIndexCoordinator, type IndexRunContext } from './index-owner.js';
import {
  drainIndexingRun,
  indexFileWithRecovery,
  indexVaultSync,
  populateMissingLinks,
  populateMissingMarkdownReferences,
  startBackgroundIndexing,
  startWatcher,
  type IndexResult,
  type WatcherHandle,
} from './indexer.js';
import { rebuildIndex } from './rebuild.js';

export async function openIndexDatabase(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      openDb();
      return;
    } catch (error) {
      const busy =
        error instanceof IndexInitializationBusyError ||
        (!!error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED'));
      if (!busy || attempt >= 3) throw error;
      await delay([50, 150, 450][attempt]);
    }
  }
}

function reportRunFailure(run: IndexRunContext, operation: string, error: unknown): void {
  if (run.signal.aborted || error instanceof IndexLeaseLostError) return;
  try {
    recordIndexFailure(
      run.lease,
      '',
      operation,
      `${activeModelName()}:${config.apiBaseUrl}`,
      error,
    );
  } catch (failure) {
    if (!(failure instanceof IndexLeaseLostError))
      console.error('[indexer] could not record indexing failure:', failure);
  }
}

async function prepareOwner(run: IndexRunContext): Promise<number> {
  try {
    return await initializeOwner(run);
  } catch (error) {
    reportRunFailure(run, 'initialize', error);
    throw error;
  }
}

async function initializeOwner(run: IndexRunContext): Promise<number> {
  run.signal.throwIfAborted();
  const stored = getStoredModel();
  if (stored && stored !== activeModelName())
    throw new Error(
      `Embedding model mismatch. Restore the indexed model or use full reindex --force. Existing index preserved.`,
    );
  const dimension = getStoredEmbeddingDim() ?? (await getEmbeddingDim({ signal: run.signal }));
  run.signal.throwIfAborted();
  primeEmbeddingDim(dimension);
  initVecTable(run.lease, dimension);
  cleanupLegacyPaths(run.lease);
  discardRebuilds(run.lease);
  repairIndexIntegrity(run.lease);
  saveConfigMeta(run.lease, {
    vaultPath: config.vaultPath,
    apiBaseUrl: config.apiBaseUrl,
    apiModel: config.apiModel,
  });
  await populateMissingLinks(run);
  await populateMissingMarkdownReferences(run);
  clearIndexFailures(run.lease, '', 'initialize');
  return getContextLength();
}

export interface IndexService {
  start(): void;
  close(): Promise<void>;
  reindex(options?: { path?: string; force?: boolean }): Promise<IndexResult>;
}

export function createIndexService(): IndexService {
  let watcher: WatcherHandle | undefined;
  const coordinator = createIndexCoordinator({
    async acquireBackground(run) {
      try {
        const contextLength = await prepareOwner(run);
        run.signal.throwIfAborted();
        const current = startWatcher(contextLength, run);
        watcher = current;
        await current.ready;
        await startBackgroundIndexing(run, contextLength);
        if (!run.signal.aborted)
          await new Promise<void>((resolve) =>
            run.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
      } finally {
        await drainIndexingRun(run);
      }
    },
    async releaseBackground() {
      const previous = watcher;
      watcher = undefined;
      await previous?.close();
    },
    onError(error) {
      console.error(
        '[indexer] indexing stopped; search remains available:',
        error instanceof Error ? error.message : String(error),
      );
    },
  });
  return {
    start() {
      coordinator.start();
    },
    close() {
      return coordinator.close();
    },
    reindex(options = {}) {
      return coordinator.foreground(async (run) => {
        if (options.force && !options.path) {
          try {
            return await rebuildIndex(run, await getContextLength());
          } catch (error) {
            reportRunFailure(run, 'rebuild', error);
            throw error;
          }
        }
        const contextLength = await prepareOwner(run);
        if (!options.path)
          return indexVaultSync(run, false, 'Indexing vault...', { requireClean: true });
        const status = await indexFileWithRecovery(
          run,
          path.join(config.vaultPath, options.path),
          contextLength,
          options.force,
        );
        if (status === 'indexed') return { indexed: 1, skipped: 0, errors: [] };
        if (status === 'skipped') return { indexed: 0, skipped: 1, errors: [] };
        return { indexed: 0, skipped: 0, errors: [{ path: options.path, error: status.error }] };
      });
    },
  };
}
