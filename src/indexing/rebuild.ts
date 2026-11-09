import path from 'node:path';
import { normalizeNotePath } from '../content/text-normalization.js';
import { activeModelName, getEmbeddingDim, primeEmbeddingDim } from '../inference/embedder.js';
import { config } from '../runtime/config.js';
import { getStoredEmbeddingDim, withIndexMutation } from '../storage/db.js';
import { IndexLeaseLostError } from '../storage/index-ownership.js';
import {
  beginRebuild,
  discardRebuilds,
  publishRebuild,
  readRebuildNotes,
  removeRebuildNote,
  setRebuildReferences,
  stageRebuildNote,
} from '../storage/index-rebuild.js';
import { bumpIndexVersion } from '../storage/index-state.js';
import { createIgnorePolicy } from '../vault/ignore.js';
import { createNoteSourceReader } from '../vault/note-source.js';
import { reportIndexProgress } from './index-owner.js';
import { retryIndexWrite } from './index-write.js';
import {
  contentPolicyForRun,
  createIndexProgress,
  createPreparedReferenceResolver,
  prepareIndexFile,
  scanVault,
  type IndexResult,
  type IndexRunContext,
} from './indexer.js';

/** Build away from active rows, then publish the complete compatible snapshot. */
export async function rebuildIndex(
  run: IndexRunContext,
  contextLength: number,
  options: { reason?: 'force' | 'content-policy' } = {},
): Promise<IndexResult> {
  const previousDimension = getStoredEmbeddingDim();
  const source = createNoteSourceReader(config.vaultPath);
  let staged = false;
  let progress: ReturnType<typeof createIndexProgress> | undefined;
  try {
    const policyOnly = options.reason === 'content-policy';
    const dimension =
      policyOnly && previousDimension !== null
        ? previousDimension
        : await getEmbeddingDim({ refresh: true, signal: run.signal });
    primeEmbeddingDim(dimension);
    const preparationRun: IndexRunContext = {
      ...run,
      get contentFilter() {
        return run.contentFilter;
      },
      reuseEmbeddings: policyOnly,
    };
    const id = beginRebuild(run.lease, {
      modelName: activeModelName(),
      embeddingDim: dimension,
      contentPolicySignature: contentPolicyForRun(run),
      chunkPolicy: run.chunkPolicy,
      metadata: {
        vaultPath: config.vaultPath,
        apiBaseUrl: config.apiBaseUrl,
        apiModel: config.apiModel,
      },
    });
    staged = true;
    for (let pass = 0; pass < 3; pass++) {
      run.signal.throwIfAborted();
      const files = scanVault(undefined, run);
      reportIndexProgress(run, files.length, 0);
      progress = createIndexProgress(
        files.length,
        pass === 0 ? 'Reindexing vault...' : 'Checking changed notes...',
      );
      const policy = createIgnorePolicy();
      const prior = new Map(readRebuildNotes(id).map((row) => [row.note.path, row]));
      const present = new Set<string>();
      for (let i = 0; i < files.length; i += config.batchSize) {
        const outcomes = await Promise.allSettled(
          files.slice(i, i + config.batchSize).map(async (file) => {
            run.signal.throwIfAborted();
            const physicalRelative = path
              .relative(config.vaultPath, file)
              .split(path.sep)
              .join('/');
            const relative = normalizeNotePath(physicalRelative);
            present.add(relative);
            const existing = prior.get(relative);
            const current = source.stat(physicalRelative);
            if (!current) return;
            if (existing && existing.mtime === current.mtimeMs && existing.size === current.size)
              return;
            const prepared = await prepareIndexFile(
              preparationRun,
              file,
              contextLength,
              policy,
              true,
            );
            if (prepared.kind === 'prepared')
              stageRebuildNote(
                run.lease,
                id,
                prepared.note,
                prepared.frontmatterRaw,
                prepared.fingerprint,
                prepared.contentPolicySignature,
              );
            else if (prepared.kind === 'missing') removeRebuildNote(run.lease, id, prepared.path);
          }),
        );
        const failure = outcomes.find((outcome) => outcome.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        const processed = Math.min(i + config.batchSize, files.length);
        reportIndexProgress(run, files.length, processed);
        progress.update(processed);
      }
      progress.finish();
      progress = undefined;
      for (const relative of prior.keys())
        if (!present.has(relative)) removeRebuildNote(run.lease, id, relative);
      const rows = readRebuildNotes(id);
      const byPath = new Map(rows.map((row) => [row.note.path, row]));
      const catalog = rows.map(({ note }) => ({
        path: note.path,
        title: note.title,
        aliases: JSON.stringify(note.aliases ?? []),
      }));
      const resolveReferences = createPreparedReferenceResolver(catalog);
      for (const row of rows)
        setRebuildReferences(
          run.lease,
          id,
          row.note.path,
          resolveReferences(row.note, row.frontmatterRaw),
        );
      const published = await retryIndexWrite(run, () =>
        withIndexMutation(run.lease, () => {
          const finalFiles = scanVault(undefined, run);
          const stable =
            finalFiles.length === rows.length &&
            finalFiles.every((file) => {
              const physicalRelative = path
                .relative(config.vaultPath, file)
                .split(path.sep)
                .join('/');
              const relative = normalizeNotePath(physicalRelative);
              const row = byPath.get(relative);
              const stat = source.stat(physicalRelative);
              return row && stat && row.mtime === stat.mtimeMs && row.size === stat.size;
            });
          if (!stable) return false;
          publishRebuild(run.lease, id);
          return true;
        }),
      );
      if (!published) continue;
      staged = false;
      bumpIndexVersion();
      process.stderr.write(`Done. ${rows.length} notes indexed.\n`);
      return { indexed: rows.length, skipped: 0, errors: [] };
    }
    throw new Error(
      'The vault kept changing during reindex; existing index preserved. Retry after the edits settle.',
    );
  } finally {
    progress?.finish();
    if (staged && !run.signal.aborted) {
      // A stale owner's cleanup is fenced just like publication.
      try {
        discardRebuilds(run.lease);
      } catch (error) {
        if (!(error instanceof IndexLeaseLostError))
          console.error('[indexer] could not clean abandoned rebuild:', error);
      }
    }
    if (!run.signal.aborted) {
      const active = getStoredEmbeddingDim() ?? previousDimension;
      if (active !== null) primeEmbeddingDim(active);
    }
  }
}
