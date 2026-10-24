import { createHash } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  parseContentIgnorePatterns,
  type ContentIgnorePattern,
} from '../content/content-ignore.js';
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
  getActiveContentPolicySignature,
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
import {
  ContentFilterError,
  createContentFilter,
  policySignature,
  type ContentFilter,
} from './content-filter.js';
import {
  createIndexCoordinator,
  reportIndexProgress,
  type IndexRunContext as OwnerRunContext,
} from './index-owner.js';
import {
  contentPolicyForRun,
  drainIndexingRun,
  indexFileWithRecovery,
  indexVaultSync,
  populateMissingLinks,
  populateMissingMarkdownReferences,
  startBackgroundIndexing,
  startWatcher,
  type IndexResult,
  type IndexRunContext,
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
      `${activeModelName()}:${config.apiBaseUrl}:${contentPolicyForRun(run)}`,
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
  reindexFiles(
    paths: string[],
    onProgress?: (processed: number, total: number) => void,
  ): Promise<IndexResult>;
}

export function createIndexService(): IndexService {
  let watcher: WatcherHandle | undefined;
  let started = false;
  let closed = false;
  let unreapedFilter: ContentFilter | undefined;
  const raw = config.contentIgnorePatternsRaw;
  let patterns: readonly ContentIgnorePattern[] = [];
  let configurationError: Error | undefined;
  try {
    patterns = parseContentIgnorePatterns(raw);
  } catch (error) {
    configurationError =
      error instanceof Error
        ? error
        : new Error('Invalid content ignore configuration', { cause: error });
  }
  const desired = configurationError
    ? `invalid:${createHash('sha256')
        .update(raw ?? '')
        .digest('hex')}`
    : policySignature(patterns);

  async function withContentRun<T>(
    owner: OwnerRunContext,
    work: (run: IndexRunContext) => Promise<T>,
  ): Promise<T> {
    if (unreapedFilter) {
      await unreapedFilter.close();
      unreapedFilter = undefined;
    }
    let filter: ContentFilter | undefined;
    let clearedWorkerFailure = false;
    const controller = patterns.length ? new AbortController() : undefined;
    const abortFromOwner = () => controller?.abort(owner.signal.reason);
    if (controller) {
      owner.signal.addEventListener('abort', abortFromOwner, { once: true });
      if (owner.signal.aborted) abortFromOwner();
    }
    const run: IndexRunContext = {
      ...owner,
      signal: controller?.signal ?? owner.signal,
      contentPolicySignature: desired,
      get contentFilter() {
        if (!patterns.length) return undefined;
        if (!filter) {
          const child = createContentFilter(patterns);
          const current: ContentFilter = {
            signature: desired,
            async project(body, options) {
              try {
                const projection = await child.project(body, options);
                if (!clearedWorkerFailure) {
                  clearIndexFailures(run.lease, '', 'content-filter');
                  clearedWorkerFailure = true;
                }
                return projection;
              } catch (error) {
                if (error instanceof ContentFilterError && error.scope === 'worker') {
                  reportRunFailure(run, 'content-filter', error);
                  controller?.abort(error);
                }
                throw error;
              }
            },
            async close() {
              await child.close();
              if (filter === current) filter = undefined;
            },
          };
          filter = current;
        }
        return filter;
      },
    };
    async function closeFilter(): Promise<void> {
      try {
        await filter?.close();
      } catch (error) {
        unreapedFilter = filter;
        reportRunFailure(run, 'content-filter', error);
        controller?.abort(error);
        throw error;
      }
    }
    try {
      if (configurationError) {
        reportRunFailure(run, 'content-policy', configurationError);
        throw configurationError;
      }
      return await work(run);
    } finally {
      owner.signal.removeEventListener('abort', abortFromOwner);
      await closeFilter();
    }
  }

  async function prepareContentOwner(
    run: IndexRunContext,
    allowTransition: boolean,
  ): Promise<number> {
    if (getActiveContentPolicySignature() !== desired) {
      try {
        if (!allowTransition)
          throw new Error(
            'Content policy changed in another process. Search remains available; restart with matching settings or reindex to apply this configuration.',
          );
        const stored = getStoredModel();
        if (stored && stored !== activeModelName())
          throw new Error(
            'Embedding model mismatch. Restore the indexed model or use full reindex --force. Existing index preserved.',
          );
        await rebuildIndex(run, await getContextLength(), { reason: 'content-policy' });
      } catch (error) {
        reportRunFailure(run, 'content-policy', error);
        throw error;
      }
    }
    const contextLength = await prepareOwner(run);
    clearIndexFailures(run.lease, '', 'content-policy');
    return contextLength;
  }

  function report(error: unknown): void {
    console.error(
      '[indexer] indexing stopped; search remains available:',
      error instanceof Error ? error.message : String(error),
    );
  }
  const coordinator = createIndexCoordinator({
    async acquireBackground(owner) {
      await withContentRun(owner, async (run) => {
        try {
          const contextLength = await prepareContentOwner(run, false);
          run.signal.throwIfAborted();
          const current = startWatcher(contextLength, run);
          watcher = current;
          await current.ready;
          await startBackgroundIndexing(run, contextLength);
          if (!run.signal.aborted)
            await new Promise<void>((resolve) =>
              run.signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          run.signal.throwIfAborted();
        } finally {
          await drainIndexingRun(run);
        }
      });
    },
    async releaseBackground() {
      const previous = watcher;
      watcher = undefined;
      await previous?.close();
    },
    onError: report,
  });
  async function runExplicitIndex(
    work: (run: IndexRunContext) => Promise<IndexResult>,
  ): Promise<IndexResult> {
    const result = await coordinator.foreground((owner) => withContentRun(owner, work));
    if (started && !closed && result.errors.length === 0) coordinator.start();
    return result;
  }
  return {
    start() {
      if (closed) throw new Error('Indexing service is closed');
      if (started) return;
      started = true;
      if (!configurationError && getActiveContentPolicySignature() !== desired) {
        // Only a newly started service can request an automatic policy change.
        // Followers that later acquire ownership must accept the published policy.
        void coordinator
          .foreground((owner) => withContentRun(owner, (run) => prepareContentOwner(run, true)))
          .then(() => {
            if (!closed) coordinator.start();
          })
          .catch((error: unknown) => {
            if (!closed) report(error);
          });
      } else coordinator.start();
    },
    async close() {
      closed = true;
      try {
        await coordinator.close();
      } finally {
        await unreapedFilter?.close();
        unreapedFilter = undefined;
      }
    },
    reindexFiles(paths, onProgress) {
      return runExplicitIndex(async (run) => {
        const contextLength = await prepareContentOwner(run, true);
        const result: IndexResult = { indexed: 0, skipped: 0, errors: [] };
        reportIndexProgress(run, paths.length, 0);
        for (const [index, notePath] of paths.entries()) {
          const status = await indexFileWithRecovery(
            run,
            path.join(config.vaultPath, notePath),
            contextLength,
            true,
          );
          if (status === 'indexed') result.indexed++;
          else if (status === 'skipped') result.skipped++;
          else {
            result.errors.push({ path: notePath, error: status.error });
            if (status.cause instanceof ContentFilterError) await run.contentFilter?.close();
          }
          reportIndexProgress(run, paths.length, index + 1);
          onProgress?.(index + 1, paths.length);
        }
        return result;
      });
    },
    reindex(options = {}) {
      return runExplicitIndex(async (run) => {
        if (options.force && !options.path) {
          try {
            return await rebuildIndex(run, await getContextLength());
          } catch (error) {
            reportRunFailure(run, 'rebuild', error);
            throw error;
          }
        }
        const contextLength = await prepareContentOwner(run, true);
        if (!options.path)
          return indexVaultSync(run, false, 'Indexing vault...', { requireClean: true });
        reportIndexProgress(run, 1, 0);
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
